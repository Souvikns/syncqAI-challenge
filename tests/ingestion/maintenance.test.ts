import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestMaintenanceLog } from '../../src/ingestion/maintenance';
import { detectPii } from '../../src/utils';
import { row, tempDbPath, TEST_SALT } from '../helpers';

describe('ingestMaintenanceLog', () => {
  test('reads 250 events across 93 distinct vehicles', async () => {
    const db = openContextDb(tempDbPath());
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    expect(row(db, 'SELECT COUNT(*) as n FROM maintenance_events').n).toBe(250);
    expect(row(db, 'SELECT COUNT(DISTINCT vehicle_key) as n FROM maintenance_events').n).toBe(93);
    db.close();
  });

  test('tags temp_fix and brake_work concepts at the documented counts', async () => {
    const db = openContextDb(tempDbPath());
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    const countWithConcept = (concept: string) =>
      row(db, `SELECT COUNT(*) as n FROM maintenance_events WHERE concepts LIKE '%"${concept}"%'`).n;
    expect(countWithConcept('temp_fix')).toBe(45);
    expect(countWithConcept('brake_work')).toBe(23);
    db.close();
  });

  test('tokenises the mechanic name, never storing it raw', async () => {
    const db = openContextDb(tempDbPath());
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    const mechanics = db.query('SELECT DISTINCT mechanic_token FROM maintenance_events').all() as { mechanic_token: string }[];
    expect(mechanics.length).toBe(6);
    for (const m of mechanics) expect(m.mechanic_token).toMatch(/^<PERSON:[0-9a-f]{6}>$/);
    db.close();
  });

  test('leaves no raw PII in source_records.payload', async () => {
    const db = openContextDb(tempDbPath());
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    const payloads = db.query("SELECT payload FROM source_records WHERE source_id = 'maintenance_log'").all() as { payload: string }[];
    for (const { payload } of payloads) expect(detectPii(payload)).toEqual([]);
    db.close();
  });

  test('is idempotent', async () => {
    const db = openContextDb(tempDbPath());
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    expect(row(db, 'SELECT COUNT(*) as n FROM maintenance_events').n).toBe(250);
    db.close();
  });
});
