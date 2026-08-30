// The queryable/writable half of the human approval gate. The interactive
// prompt loop lives in run-approve.ts; everything decidable without a
// terminal lives here, so it can be tested directly.

import type { Database } from 'bun:sqlite';
import { writeAuditRecord } from './audit';

export interface PendingMessage {
  readonly messageId: string;
  readonly ticketId: string;
  readonly recipient: string;
  readonly body: string;
  readonly context: string;
  readonly draftedAt: string;
}

export function pendingApprovals(actionsDb: Database): PendingMessage[] {
  return actionsDb
    .query(
      `SELECT message_id as messageId, ticket_id as ticketId, recipient, body, context, drafted_at as draftedAt
       FROM comms_pending
       WHERE ticket_id NOT IN (SELECT ticket_id FROM comms_sent)
       ORDER BY ticket_id`,
    )
    .all() as PendingMessage[];
}

export function recordApproval(actionsDb: Database, message: PendingMessage, approvedBy: string, sentAt: string): void {
  actionsDb
    .query('INSERT OR IGNORE INTO comms_sent (message_id, ticket_id, recipient, body, approved_by, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(message.messageId, message.ticketId, message.recipient, message.body, approvedBy, sentAt);

  writeAuditRecord(actionsDb, {
    ticketId: message.ticketId,
    step: 'APPROVE',
    decision: 'SENT',
    ruleId: null,
    citations: [],
    decidedBy: approvedBy,
  });
}
