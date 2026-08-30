import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openContextDb } from '../../src/ingest';
import { ingestDriversRoster } from '../../src/ingestion/drivers';
import { ingestTickets } from '../../src/ingestion/tickets';
import { detectPii } from '../../src/utils';
import { row, tempDbPath, driverIdsFrom, TEST_SALT } from '../helpers';

function ingestWithDrivers(): Database {
  const db = openContextDb(tempDbPath());
  ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
  ingestTickets(db, 'tickets.json', driverIdsFrom(db), TEST_SALT);
  return db;
}

describe('ingestTickets', () => {
  test('reads all 35 rows and quarantines exactly 2 broken tickets', () => {
    const db = ingestWithDrivers();
    expect(row(db, "SELECT COUNT(*) as n FROM record_locations WHERE unit = 'tickets.json'").n).toBe(35);
    expect(row(db, "SELECT COUNT(*) as n FROM quarantine WHERE source_id = 'tickets'").n).toBe(2);
    db.close();
  });

  test('TKT-9101 is quarantined for its three missing fields', () => {
    const db = ingestWithDrivers();
    const q = row(db, "SELECT reasons FROM quarantine WHERE record_id = 'TKT-9101'");
    const reasons = JSON.parse(q.reasons) as { field: string; code: string }[];
    expect(reasons.map((r) => `${r.field}:${r.code}`).sort()).toEqual(
      ['driver_id:MISSING', 'km_from_origin_hub:MISSING', 'vehicle:MISSING'].sort(),
    );
    db.close();
  });

  test('TKT-9102 is quarantined for all seven of its broken fields', () => {
    const db = ingestWithDrivers();
    const q = row(db, "SELECT reasons FROM quarantine WHERE record_id = 'TKT-9102'");
    const reasons = JSON.parse(q.reasons) as { field: string; code: string }[];
    expect(reasons).toHaveLength(7);
    expect(reasons.find((r) => r.field === 'created_at')?.code).toBe('UNPARSEABLE_DATE');
    expect(reasons.find((r) => r.field === 'vehicle')?.code).toBe('BAD_PLATE');
    expect(reasons.find((r) => r.field === 'driver_id')?.code).toBe('UNKNOWN_DRIVER');
    for (const field of ['origin_hub', 'destination', 'issue', 'severity']) {
      expect(reasons.find((r) => r.field === field)?.code).toBe('MISSING');
    }
    db.close();
  });

  test('the sync-copy duplicate of TKT-0020 is not dropped, just kept as a separate record', () => {
    const db = ingestWithDrivers();
    const count = row(db, "SELECT COUNT(*) as n FROM record_locations WHERE unit = 'tickets.json'").n;
    expect(count).toBe(35);
    db.close();
  });

  test('leaves no raw PII in the tickets payload', () => {
    const db = ingestWithDrivers();
    const payloads = db.query("SELECT payload FROM source_records WHERE source_id = 'tickets'").all() as { payload: string }[];
    for (const { payload } of payloads) expect(detectPii(payload)).toEqual([]);
    db.close();
  });

  test('is idempotent', () => {
    const db = ingestWithDrivers();
    ingestTickets(db, 'tickets.json', driverIdsFrom(db), TEST_SALT);
    expect(row(db, "SELECT COUNT(*) as n FROM quarantine WHERE source_id = 'tickets'").n).toBe(2);
    db.close();
  });
});
