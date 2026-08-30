// Regenerates outputs/*.jsonl and audit/audit.jsonl from actions.db, in
// full, every time - never appended to. This is what makes "run the
// pipeline twice back to back" produce identical files: actions.db's
// unique constraints make the second run a no-op, so the re-export matches.

import type { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoPii } from './utils';

function toJsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

// `recipient` is a declared business contact address from CLIENT_ALIASES
// (ingestion/shared.ts) - a legitimate destination this system is meant to
// send to, not raw personal data pulled from a source record. Everything
// else, especially `body`, is swept in full: that's where a real leak from
// ticket/vehicle/driver data would actually show up.
function writeSwept(path: string, rows: readonly Record<string, unknown>[], exemptFields: readonly string[] = []): void {
  for (const row of rows) {
    const checked = Object.fromEntries(Object.entries(row).filter(([key]) => !exemptFields.includes(key)));
    assertNoPii(JSON.stringify(checked));
  }
  writeFileSync(path, toJsonl(rows));
}

export function exportOutputs(actionsDb: Database, outputsDir: string, auditDir: string): void {
  mkdirSync(outputsDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  const workOrders = actionsDb
    .query('SELECT work_order_id, ticket_id, vehicle_reg, created_at, citations FROM work_orders ORDER BY ticket_id')
    .all() as Record<string, unknown>[];
  writeSwept(
    join(outputsDir, 'work_orders.jsonl'),
    workOrders.map((r) => ({ ...r, citations: JSON.parse(r.citations as string) })),
  );

  const commsPending = actionsDb
    .query(
      `SELECT message_id, ticket_id, recipient, body, context, drafted_at FROM comms_pending
       WHERE ticket_id NOT IN (SELECT ticket_id FROM comms_sent) ORDER BY ticket_id`,
    )
    .all() as Record<string, unknown>[];
  writeSwept(
    join(outputsDir, 'comms_pending.jsonl'),
    commsPending.map((r) => ({ ...r, context: JSON.parse(r.context as string) })),
    ['recipient'],
  );

  const commsSent = actionsDb
    .query('SELECT message_id, ticket_id, recipient, body, approved_by, sent_at FROM comms_sent ORDER BY ticket_id')
    .all() as Record<string, unknown>[];
  writeSwept(join(outputsDir, 'comms_sent.jsonl'), commsSent, ['recipient']);

  const quarantine = actionsDb
    .query('SELECT quarantine_id, ticket_id, locator, payload_hash, reasons FROM quarantine ORDER BY quarantine_id')
    .all() as Record<string, unknown>[];
  writeSwept(
    join(outputsDir, 'quarantine.jsonl'),
    quarantine.map((r) => ({ ...r, reasons: JSON.parse(r.reasons as string) })),
  );

  const auditLog = actionsDb
    .query('SELECT ticket_id, step, decision, rule_id, citations, decided_by FROM audit_log ORDER BY ticket_id, rowid')
    .all() as Record<string, unknown>[];
  writeSwept(
    join(auditDir, 'audit.jsonl'),
    auditLog.map((r) => ({ ...r, citations: JSON.parse(r.citations as string) })),
  );
}
