// tickets.json — the breakdown queue. Field names are aliased because the
// client's IT team is known to change them without notice.

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { classifyNote, emptyToNull, normalizePlate, parseDate, redactPii } from '../utils';
import { buildRawRecord, insertTextUnit, quarantineRecord, storeRawRecord, type QuarantineReason } from './shared';

const TICKET_ALIASES: Record<string, readonly string[]> = {
  ticket_id: ['ticket_id', 'id', 'ticketId', 'ticket', 'ref'],
  created_at: ['created_at', 'createdAt', 'ts', 'timestamp', 'reported_at', 'time', 'date'],
  vehicle: ['vehicle', 'vehicle_reg', 'reg', 'reg_no', 'registration', 'truck', 'plate'],
  driver_id: ['driver_id', 'driver', 'driverId'],
  origin_hub: ['origin_hub', 'origin', 'from_hub', 'source_hub'],
  km_from_origin_hub: ['km_from_origin_hub', 'km', 'distance_km', 'km_from_hub'],
  destination: ['destination', 'dest', 'to', 'drop'],
  issue: ['issue', 'problem', 'fault', 'description'],
  severity: ['severity', 'priority', 'sev'],
  client: ['client', 'customer', 'account'],
  status: ['status', 'state'],
  resolution_note: ['resolution_note', 'note', 'notes', 'resolution', 'remarks'],
};

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, '');
}

function jsonValueToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return emptyToNull(String(value));
}

/** Maps a record's field names onto the canonical ticket shape, keeping anything unrecognised. */
function aliasTicketFields(raw: Record<string, unknown>): Record<string, string | null> {
  const byNormalizedName = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) byNormalizedName.set(normalizeFieldName(key), value);

  const aliased: Record<string, string | null> = {};
  const claimed = new Set<string>();

  for (const [canonical, aliases] of Object.entries(TICKET_ALIASES)) {
    const matchedKey = aliases.map(normalizeFieldName).find((a) => byNormalizedName.has(a));
    aliased[canonical] = matchedKey === undefined ? null : jsonValueToString(byNormalizedName.get(matchedKey));
    if (matchedKey !== undefined) claimed.add(matchedKey);
  }

  for (const [key, value] of byNormalizedName) {
    if (!claimed.has(key)) aliased[`_unmapped_${key}`] = jsonValueToString(value);
  }

  return aliased;
}

function buildTicketSchema(knownDriverIds: ReadonlySet<string>) {
  return z
    .object({
      ticket_id: z.string().nullable(),
      created_at: z.string().nullable(),
      vehicle: z.string().nullable(),
      driver_id: z.string().nullable(),
      origin_hub: z.string().nullable(),
      km_from_origin_hub: z.string().nullable(),
      destination: z.string().nullable(),
      issue: z.string().nullable(),
      severity: z.string().nullable(),
    })
    .passthrough()
    .superRefine((fields, ctx) => {
      const required = (field: 'ticket_id' | 'origin_hub' | 'km_from_origin_hub' | 'destination' | 'issue' | 'severity') => {
        if (!fields[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], params: { code: 'MISSING' } });
      };

      required('ticket_id');
      required('origin_hub');
      required('km_from_origin_hub');
      required('destination');
      required('issue');
      required('severity');

      if (!fields.created_at) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['created_at'], params: { code: 'MISSING' } });
      } else if (!parseDate(fields.created_at).valid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['created_at'], params: { code: 'UNPARSEABLE_DATE', detail: fields.created_at } });
      }

      if (!fields.vehicle) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vehicle'], params: { code: 'MISSING' } });
      } else if (!normalizePlate(fields.vehicle).valid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vehicle'], params: { code: 'BAD_PLATE', detail: fields.vehicle } });
      }

      if (!fields.driver_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['driver_id'], params: { code: 'MISSING' } });
      } else if (!knownDriverIds.has(fields.driver_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['driver_id'], params: { code: 'UNKNOWN_DRIVER', detail: fields.driver_id } });
      }
    });
}

function quarantineReasonsFrom(issues: readonly z.ZodIssue[]): QuarantineReason[] {
  return issues.map((issue) => {
    const params = (issue as { params?: { code?: string; detail?: unknown } }).params;
    return {
      field: String(issue.path[0] ?? ''),
      code: params?.code ?? issue.code,
      detail: params?.detail === undefined ? '' : String(params.detail),
    };
  });
}

export function ingestTickets(db: Database, filePath: string, knownDriverIds: ReadonlySet<string>, salt: string): void {
  const schema = buildTicketSchema(knownDriverIds);
  const rawRecords = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>[];

  rawRecords.forEach((raw, index) => {
    const locator = `row:${index}`;
    const fields = aliasTicketFields(raw);
    const redactedNote = fields.resolution_note ? redactPii(salt, fields.resolution_note) : null;

    const record = buildRawRecord('tickets', filePath, locator, { ...fields, resolution_note: redactedNote });
    storeRawRecord(db, record);

    const result = schema.safeParse(fields);
    if (!result.success) {
      quarantineRecord(db, {
        sourceId: 'tickets',
        unit: filePath,
        locator,
        recordId: fields.ticket_id ?? null,
        payloadHash: record.contentHash,
        reasons: quarantineReasonsFrom(result.error.issues),
      });
      return;
    }

    if (redactedNote) {
      insertTextUnit(db, {
        unitHash: record.contentHash,
        sourceId: 'tickets',
        locator,
        text: redactedNote,
        concepts: classifyNote(redactedNote),
      });
    }
  });
}
