// Step 1: read tickets.json, dedupe by ticket_id exactly once, and
// quarantine anything broken. Never throws on a bad record.

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { raiseAlert } from '../ingestion/shared';
import { canonicalJson, normalizePlate, parseDate, sha256Hex, toInt } from '../utils';
import { aliasTicketFields, buildTicketSchema, quarantineReasonsFrom, type QuarantineReason } from './ticket';
import { writeAuditRecord } from './audit';

export interface ParsedTicket {
  readonly ticketId: string;
  readonly createdAt: string;
  readonly vehicleKey: string;
  readonly vehicleReg: string;
  readonly driverId: string;
  readonly originHub: string;
  readonly kmFromOriginHub: number;
  readonly destination: string;
  readonly issue: string;
  readonly severity: string;
  readonly client: string;
  readonly locator: string;
}

function alreadyProcessed(db: Database, ticketId: string): boolean {
  return db.query('SELECT 1 FROM processed_tickets WHERE ticket_id = ?').get(ticketId) !== null;
}

function markProcessed(db: Database, ticketId: string, payloadHash: string, outcome: 'VALID' | 'QUARANTINED'): void {
  db.query('INSERT OR IGNORE INTO processed_tickets (ticket_id, payload_hash, outcome) VALUES (?, ?, ?)').run(
    ticketId,
    payloadHash,
    outcome,
  );
}

function quarantineTicket(
  db: Database,
  params: { ticketId: string | null; locator: string; payloadHash: string; reasons: readonly QuarantineReason[] },
): void {
  const sortedReasons = [...params.reasons].sort((a, b) => a.field.localeCompare(b.field));
  const quarantineId = sha256Hex('pipeline' + params.locator + params.payloadHash);
  db.query(
    `INSERT OR IGNORE INTO quarantine (quarantine_id, ticket_id, locator, payload_hash, reasons)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(quarantineId, params.ticketId, params.locator, params.payloadHash, JSON.stringify(sortedReasons));
}

export function validateTickets(db: Database, ticketsPath: string, knownDriverIds: ReadonlySet<string>): ParsedTicket[] {
  const schema = buildTicketSchema(knownDriverIds);
  const rawRecords = JSON.parse(readFileSync(ticketsPath, 'utf8')) as Record<string, unknown>[];
  const validTickets: ParsedTicket[] = [];
  const seenThisRun = new Set<string>();

  rawRecords.forEach((raw, index) => {
    const locator = `row:${index}`;
    const fields = aliasTicketFields(raw);
    const payloadHash = sha256Hex(canonicalJson(fields));
    const ticketId = fields.ticket_id ?? null;

    if (ticketId !== null && seenThisRun.has(ticketId)) {
      // A genuine duplicate within this queue file - worth its own audit
      // row, since it demonstrates the sync-fault dedup this ticket exists
      // to prove.
      writeAuditRecord(db, { ticketId, step: 'VALIDATE', decision: 'DUPLICATE_SKIPPED', ruleId: null, citations: [], decidedBy: 'pipeline' });
      return;
    }

    if (ticketId !== null && alreadyProcessed(db, ticketId)) {
      // Already fully processed by an earlier run of the pipeline - nothing
      // new happened, so nothing new is written. This is what keeps
      // audit.jsonl byte-identical across reruns of an unchanged queue.
      return;
    }
    if (ticketId !== null) seenThisRun.add(ticketId);

    const result = schema.safeParse(fields);
    if (!result.success) {
      const reasons = quarantineReasonsFrom(result.error.issues);
      quarantineTicket(db, { ticketId, locator, payloadHash, reasons });
      raiseAlert(
        db,
        'QUARANTINED',
        ticketId ?? locator,
        reasons.map((r) => `${r.field}:${r.code}`).sort().join(', '),
      );
      writeAuditRecord(db, {
        ticketId: ticketId ?? locator,
        step: 'VALIDATE',
        decision: 'QUARANTINED',
        ruleId: null,
        citations: [],
        decidedBy: 'pipeline',
      });
      if (ticketId !== null) markProcessed(db, ticketId, payloadHash, 'QUARANTINED');
      return;
    }

    const ticket: ParsedTicket = {
      ticketId: fields.ticket_id as string,
      createdAt: parseDate(fields.created_at as string).value as string,
      vehicleKey: normalizePlate(fields.vehicle as string).key,
      vehicleReg: fields.vehicle as string,
      driverId: fields.driver_id as string,
      originHub: fields.origin_hub as string,
      kmFromOriginHub: toInt(fields.km_from_origin_hub ?? undefined) as number,
      destination: fields.destination as string,
      issue: fields.issue as string,
      severity: fields.severity as string,
      client: fields.client as string,
      locator,
    };

    markProcessed(db, ticket.ticketId, payloadHash, 'VALID');
    writeAuditRecord(db, { ticketId: ticket.ticketId, step: 'VALIDATE', decision: 'VALID', ruleId: null, citations: [], decidedBy: 'pipeline' });
    validTickets.push(ticket);
  });

  return validTickets;
}
