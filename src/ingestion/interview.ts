// dispatcher_interview.txt — the rulebook source, ingested as text only.
// Rule extraction into rules.yaml is a later, human-reviewed step; ingestion
// does not parse rules.

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { classifyNote, redactPii } from '../utils';
import { buildRawRecord, insertTextUnit, storeRawRecord } from './shared';

export function ingestInterview(db: Database, filePath: string, salt: string): void {
  const fileText = readFileSync(filePath, 'utf8');
  const paragraphs = fileText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  paragraphs.forEach((paragraph, index) => {
    const locator = `para:${index + 1}`;
    const redacted = redactPii(salt, paragraph);
    const record = buildRawRecord('interview', filePath, locator, { text: redacted });
    storeRawRecord(db, record);

    insertTextUnit(db, {
      unitHash: record.contentHash,
      sourceId: 'interview',
      locator,
      text: redacted,
      concepts: classifyNote(paragraph),
    });
  });
}
