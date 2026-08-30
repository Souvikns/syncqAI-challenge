import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestInterview } from '../../src/ingestion/interview';
import { detectPii } from '../../src/utils';
import { row, tempDbPath, TEST_SALT } from '../helpers';

describe('ingestInterview', () => {
  test('splits the transcript into more than one citable paragraph', () => {
    const db = openContextDb(tempDbPath());
    ingestInterview(db, 'dispatcher_interview.txt', TEST_SALT);
    expect(row(db, "SELECT COUNT(*) as n FROM text_units WHERE source_id = 'interview'").n).toBeGreaterThan(1);
    db.close();
  });

  test('redacts the mobile number spoken aloud mid-transcript', () => {
    const db = openContextDb(tempDbPath());
    ingestInterview(db, 'dispatcher_interview.txt', TEST_SALT);
    const texts = db.query("SELECT text FROM text_units WHERE source_id = 'interview'").all() as { text: string }[];
    for (const { text } of texts) expect(detectPii(text)).toEqual([]);
    expect(texts.map((t) => t.text).join(' ')).toMatch(/<PHONE:[0-9a-f]{6}>/);
    db.close();
  });
});
