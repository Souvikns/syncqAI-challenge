import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestDriversRoster } from '../../src/ingestion/drivers';
import { detectPii } from '../../src/utils';
import { row, tempDbPath, TEST_SALT } from '../helpers';

describe('ingestDriversRoster', () => {
  test('reads 60 drivers with every personal field tokenised', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    expect(row(db, 'SELECT COUNT(*) as n FROM drivers').n).toBe(60);
    const sample = row(db, "SELECT * FROM drivers WHERE driver_id = 'DRV-001'");
    expect(sample.name_token).toMatch(/^<PERSON:[0-9a-f]{6}>$/);
    expect(sample.phone_token).toMatch(/^<PHONE:[0-9a-f]{6}>$/);
    expect(sample.dl_token).toMatch(/^<DL:[0-9a-f]{6}>$/);
    expect(sample.aadhaar_token).toMatch(/^<AADHAAR:[0-9a-f]{6}>$/);
    db.close();
  });

  test('keeps driver_id, joining_date and home_hub in cleartext', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    const sample = row(db, "SELECT * FROM drivers WHERE driver_id = 'DRV-001'");
    expect(sample.joining_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof sample.home_hub).toBe('string');
    expect(sample.home_hub.length).toBeGreaterThan(0);
    db.close();
  });

  test('leaves no raw PII in source_records.payload', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    const payloads = db.query("SELECT payload FROM source_records WHERE source_id = 'drivers_roster'").all() as { payload: string }[];
    for (const { payload } of payloads) expect(detectPii(payload)).toEqual([]);
    db.close();
  });

  test('is idempotent', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    expect(row(db, 'SELECT COUNT(*) as n FROM drivers').n).toBe(60);
    db.close();
  });
});
