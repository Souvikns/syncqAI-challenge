import { describe, test, expect } from 'bun:test';
import { openActionsDb } from '../../src/actions';
import { pendingApprovals, recordApproval } from '../../src/pipeline/approve';
import { row, tempDbPath } from '../helpers';

function seeded() {
  const db = openActionsDb(tempDbPath());
  db.query(
    `INSERT INTO comms_pending (message_id, ticket_id, recipient, body, context, drafted_at)
     VALUES ('m1', 'TKT-0001', 'a@example.in', 'body1', '{}', '2026-08-11T19:00:00+05:30')`,
  ).run();
  db.query(
    `INSERT INTO comms_pending (message_id, ticket_id, recipient, body, context, drafted_at)
     VALUES ('m2', 'TKT-0002', 'b@example.in', 'body2', '{}', '2026-08-12T19:00:00+05:30')`,
  ).run();
  return db;
}

describe('pendingApprovals', () => {
  test('lists every drafted message not yet sent, in ticket order', () => {
    const db = seeded();
    const pending = pendingApprovals(db);
    expect(pending.map((p) => p.ticketId)).toEqual(['TKT-0001', 'TKT-0002']);
    db.close();
  });

  test('excludes messages already recorded as sent', () => {
    const db = seeded();
    recordApproval(db, pendingApprovals(db)[0]!, 'Alex', '2026-08-30T00:00:00+05:30');
    const pending = pendingApprovals(db);
    expect(pending.map((p) => p.ticketId)).toEqual(['TKT-0002']);
    db.close();
  });
});

describe('recordApproval', () => {
  test('records the sent message and an APPROVE audit row', () => {
    const db = seeded();
    const message = pendingApprovals(db)[0]!;
    recordApproval(db, message, 'Alex', '2026-08-30T00:00:00+05:30');

    const sent = row(db, "SELECT * FROM comms_sent WHERE ticket_id = 'TKT-0001'");
    expect(sent.approved_by).toBe('Alex');
    expect(sent.sent_at).toBe('2026-08-30T00:00:00+05:30');

    const audit = row(db, "SELECT decision, decided_by FROM audit_log WHERE ticket_id = 'TKT-0001' AND step = 'APPROVE'");
    expect(audit.decision).toBe('SENT');
    expect(audit.decided_by).toBe('Alex');

    db.close();
  });

  test('is idempotent - approving the same message twice does not duplicate', () => {
    const db = seeded();
    const message = pendingApprovals(db)[0]!;
    recordApproval(db, message, 'Alex', '2026-08-30T00:00:00+05:30');
    recordApproval(db, message, 'Alex', '2026-08-30T00:00:00+05:30');

    expect(row(db, "SELECT COUNT(*) as n FROM comms_sent WHERE ticket_id = 'TKT-0001'").n).toBe(1);
    db.close();
  });
});
