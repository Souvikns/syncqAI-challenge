// One audit row per step per ticket: what was decided, on what data, under
// which rule, by what. Every other pipeline step writes through this.

import type { Database } from 'bun:sqlite';
import { sha256Hex } from '../utils';

export interface AuditRecord {
  readonly ticketId: string;
  readonly step: string;
  readonly decision: string;
  readonly ruleId: string | null;
  readonly citations: readonly string[];
  readonly decidedBy: string;
}

export function writeAuditRecord(db: Database, record: AuditRecord): void {
  const auditId = sha256Hex(record.ticketId + record.step + (record.ruleId ?? '') + record.decision);
  db.query(
    `INSERT OR IGNORE INTO audit_log (audit_id, ticket_id, step, decision, rule_id, citations, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId,
    record.ticketId,
    record.step,
    record.decision,
    record.ruleId,
    JSON.stringify([...record.citations].sort()),
    record.decidedBy,
  );
}
