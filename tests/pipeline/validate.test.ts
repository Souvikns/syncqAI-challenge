import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestDriversRoster } from '../../src/ingestion/drivers';
import { openActionsDb } from '../../src/actions';
import { validateTickets } from '../../src/pipeline/validate';
import { row, driverIdsFrom, tempDbPath, TEST_SALT } from '../helpers';

function knownDriverIds(): ReadonlySet<string> {
  const db = openContextDb(tempDbPath());
  ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
  const ids = driverIdsFrom(db);
  db.close();
  return ids;
}

describe('validateTickets', () => {
  test('returns exactly 30 valid, deduplicated tickets from the delivered queue', () => {
    const db = openActionsDb(tempDbPath());
    const tickets = validateTickets(db, 'tickets.json', knownDriverIds());
    expect(tickets).toHaveLength(30);
    expect(new Set(tickets.map((t) => t.ticketId)).size).toBe(30);
    db.close();
  });

  test('quarantines TKT-9101 and TKT-9102 with the same reasons ingestion found', () => {
    const db = openActionsDb(tempDbPath());
    validateTickets(db, 'tickets.json', knownDriverIds());

    const q9101 = row(db, "SELECT reasons FROM quarantine WHERE ticket_id = 'TKT-9101'");
    const reasons9101 = JSON.parse(q9101.reasons) as { field: string; code: string }[];
    expect(reasons9101.map((r) => `${r.field}:${r.code}`).sort()).toEqual(
      ['driver_id:MISSING', 'km_from_origin_hub:MISSING', 'vehicle:MISSING'].sort(),
    );

    const q9102 = row(db, "SELECT reasons FROM quarantine WHERE ticket_id = 'TKT-9102'");
    expect(JSON.parse(q9102.reasons)).toHaveLength(7);
    db.close();
  });

  test('the first occurrence of a duplicate ticket_id wins, later copies are skipped', () => {
    const db = openActionsDb(tempDbPath());
    const tickets = validateTickets(db, 'tickets.json', knownDriverIds());
    const tkt0020Copies = tickets.filter((t) => t.ticketId === 'TKT-0020');
    expect(tkt0020Copies).toHaveLength(1);
    db.close();
  });

  test('records exactly 32 distinct tickets seen (30 valid + 2 quarantined)', () => {
    const db = openActionsDb(tempDbPath());
    validateTickets(db, 'tickets.json', knownDriverIds());
    expect(row(db, 'SELECT COUNT(*) as n FROM processed_tickets').n).toBe(32);
    db.close();
  });

  test('writes an audit row for every ticket seen, including skipped duplicates', () => {
    const db = openActionsDb(tempDbPath());
    validateTickets(db, 'tickets.json', knownDriverIds());
    expect(row(db, "SELECT COUNT(*) as n FROM audit_log WHERE step = 'VALIDATE'").n).toBe(35);
    expect(row(db, "SELECT COUNT(*) as n FROM audit_log WHERE step = 'VALIDATE' AND decision = 'DUPLICATE_SKIPPED'").n).toBe(3);
    db.close();
  });

  test('a second run against the same actions.db finds nothing new to process', () => {
    const db = openActionsDb(tempDbPath());
    const drivers = knownDriverIds();
    const first = validateTickets(db, 'tickets.json', drivers);
    const second = validateTickets(db, 'tickets.json', drivers);
    expect(first).toHaveLength(30);
    expect(second).toHaveLength(0);
    expect(row(db, 'SELECT COUNT(*) as n FROM processed_tickets').n).toBe(32);
    expect(row(db, 'SELECT COUNT(*) as n FROM quarantine').n).toBe(2);
    db.close();
  });

  test('raises an alert for every quarantined ticket - never silently dropped', () => {
    const db = openActionsDb(tempDbPath());
    validateTickets(db, 'tickets.json', knownDriverIds());

    expect(row(db, "SELECT COUNT(*) as n FROM alerts WHERE kind = 'QUARANTINED'").n).toBe(2);
    expect(row(db, "SELECT COUNT(*) as n FROM alerts WHERE kind = 'QUARANTINED' AND subject = 'TKT-9101'").n).toBe(1);
    db.close();
  });

  test('a second run writes no new audit rows - audit.jsonl must stay byte-identical across reruns', () => {
    const db = openActionsDb(tempDbPath());
    const drivers = knownDriverIds();
    validateTickets(db, 'tickets.json', drivers);
    const auditCountAfterFirst = row(db, 'SELECT COUNT(*) as n FROM audit_log').n;

    validateTickets(db, 'tickets.json', drivers);
    expect(row(db, 'SELECT COUNT(*) as n FROM audit_log').n).toBe(auditCountAfterFirst);
    db.close();
  });
});
