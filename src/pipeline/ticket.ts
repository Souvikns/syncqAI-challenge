// Ticket parsing shared by ingestion (which files a copy into context.db for
// the record) and the decision pipeline (which drives the automation off
// it). One parser, so a quarantine reason never differs between the two.

import { z } from 'zod';
import { emptyToNull, normalizePlate, parseDate } from '../utils';

export const TICKET_ALIASES: Record<string, readonly string[]> = {
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
export function aliasTicketFields(raw: Record<string, unknown>): Record<string, string | null> {
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

export function buildTicketSchema(knownDriverIds: ReadonlySet<string>) {
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
      const required = (field: 'ticket_id' | 'origin_hub' | 'destination' | 'issue' | 'severity') => {
        if (!fields[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], params: { code: 'MISSING' } });
      };

      required('ticket_id');
      required('origin_hub');
      required('destination');
      required('issue');
      required('severity');

      if (!fields.km_from_origin_hub) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['km_from_origin_hub'], params: { code: 'MISSING' } });
      } else if (!Number.isFinite(Number(fields.km_from_origin_hub))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['km_from_origin_hub'],
          params: { code: 'NOT_NUMERIC', detail: fields.km_from_origin_hub },
        });
      }

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

export interface QuarantineReason {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export function quarantineReasonsFrom(issues: readonly z.ZodIssue[]): QuarantineReason[] {
  return issues.map((issue) => {
    const params = (issue as { params?: { code?: string; detail?: unknown } }).params;
    return {
      field: String(issue.path[0] ?? ''),
      code: params?.code ?? issue.code,
      detail: params?.detail === undefined ? '' : String(params.detail),
    };
  });
}
