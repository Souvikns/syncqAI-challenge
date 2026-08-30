import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestEmails } from '../../src/ingestion/emails';
import { searchText } from '../../src/ingestion/shared';
import { detectPii } from '../../src/utils';
import { row, tempDbPath, TEST_SALT } from '../helpers';

describe('ingestEmails', () => {
  test('creates more text units than threads, since replies are separate messages', async () => {
    const db = openContextDb(tempDbPath());
    await ingestEmails(db, 'emails', TEST_SALT);
    expect(row(db, "SELECT COUNT(*) as n FROM text_units WHERE source_id = 'emails'").n).toBeGreaterThan(40);
    db.close();
  });

  test('keeps thread_01 and thread_02 as distinct text units - corroboration, not duplicates', async () => {
    const db = openContextDb(tempDbPath());
    await ingestEmails(db, 'emails', TEST_SALT);
    const thread01 = row(db, "SELECT COUNT(*) as n FROM text_units WHERE locator LIKE 'thread_01%'").n;
    const thread02 = row(db, "SELECT COUNT(*) as n FROM text_units WHERE locator LIKE 'thread_02%'").n;
    expect(thread01).toBeGreaterThan(0);
    expect(thread02).toBeGreaterThan(0);
    expect(thread01).toBe(thread02);
    db.close();
  });

  test('leaves no raw sender or recipient address in source_records.payload', async () => {
    const db = openContextDb(tempDbPath());
    await ingestEmails(db, 'emails', TEST_SALT);
    const payloads = db.query("SELECT payload FROM source_records WHERE source_id = 'emails'").all() as { payload: string }[];
    for (const { payload } of payloads) expect(detectPii(payload)).toEqual([]);
    db.close();
  });

  test('bodies are searchable through the full-text index', async () => {
    const db = openContextDb(tempDbPath());
    await ingestEmails(db, 'emails', TEST_SALT);
    expect(searchText(db, 'odometer').length).toBeGreaterThan(0);
    db.close();
  });
});
