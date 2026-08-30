import { describe, test, expect } from 'bun:test';
import { openActionsDb } from '../../src/actions';
import { writeAuditRecord } from '../../src/pipeline/audit';
import { row, tempDbPath } from '../helpers';

describe('writeAuditRecord', () => {
  test('records one row per ticket per step', () => {
    const db = openActionsDb(tempDbPath());
    writeAuditRecord(db, {
      ticketId: 'TKT-0001',
      step: 'VALIDATE',
      decision: 'VALID',
      ruleId: null,
      citations: [],
      decidedBy: 'pipeline',
    });
    expect(row(db, "SELECT COUNT(*) as n FROM audit_log WHERE ticket_id = 'TKT-0001' AND step = 'VALIDATE'").n).toBe(1);
    db.close();
  });

  test('is idempotent for an identical decision written twice', () => {
    const db = openActionsDb(tempDbPath());
    const record = {
      ticketId: 'TKT-0001',
      step: 'VALIDATE' as const,
      decision: 'VALID',
      ruleId: null,
      citations: [],
      decidedBy: 'pipeline',
    };
    writeAuditRecord(db, record);
    writeAuditRecord(db, record);
    expect(row(db, "SELECT COUNT(*) as n FROM audit_log").n).toBe(1);
    db.close();
  });

  test('two different decisions for the same ticket and step both survive', () => {
    const db = openActionsDb(tempDbPath());
    writeAuditRecord(db, {
      ticketId: 'TKT-0002',
      step: 'SELECT',
      decision: 'EXCLUDED: UP40IM3144',
      ruleId: 'R01_BS4_WINTER_NCR_BAN',
      citations: [],
      decidedBy: 'pipeline',
    });
    writeAuditRecord(db, {
      ticketId: 'TKT-0002',
      step: 'SELECT',
      decision: 'EXCLUDED: UP41IM3144',
      ruleId: 'R01_BS4_WINTER_NCR_BAN',
      citations: [],
      decidedBy: 'pipeline',
    });
    expect(row(db, "SELECT COUNT(*) as n FROM audit_log WHERE ticket_id = 'TKT-0002'").n).toBe(2);
    db.close();
  });

  test('stores citations and rule id so they round-trip', () => {
    const db = openActionsDb(tempDbPath());
    writeAuditRecord(db, {
      ticketId: 'TKT-0003',
      step: 'WORK_ORDER',
      decision: 'DISPATCH_FROM_ORIGIN_HUB',
      ruleId: 'R09_HUB_SELECTION',
      citations: ['abc123'],
      decidedBy: 'pipeline',
    });
    const stored = row(db, "SELECT rule_id, citations FROM audit_log WHERE ticket_id = 'TKT-0003'");
    expect(stored.rule_id).toBe('R09_HUB_SELECTION');
    expect(JSON.parse(stored.citations)).toEqual(['abc123']);
    db.close();
  });
});
