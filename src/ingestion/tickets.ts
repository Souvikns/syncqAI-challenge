// tickets.json — the breakdown queue. Field names are aliased because the
// client's IT team is known to change them without notice.

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { classifyNote, redactPii } from '../utils';
import { aliasTicketFields, buildTicketSchema, quarantineReasonsFrom } from '../pipeline/ticket';
import { buildRawRecord, insertTextUnit, quarantineRecord, storeRawRecord } from './shared';

export function ingestTickets(db: Database, filePath: string, knownDriverIds: ReadonlySet<string>, salt: string): void {
  const schema = buildTicketSchema(knownDriverIds);
  const rawRecords = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>[];

  rawRecords.forEach((raw, index) => {
    const locator = `row:${index}`;
    const fields = aliasTicketFields(raw);
    const redactedNote = fields.resolution_note ? redactPii(salt, fields.resolution_note) : null;

    const record = buildRawRecord('tickets', filePath, locator, { ...fields, resolution_note: redactedNote });
    storeRawRecord(db, record);

    const result = schema.safeParse(fields);
    if (!result.success) {
      quarantineRecord(db, {
        sourceId: 'tickets',
        unit: filePath,
        locator,
        recordId: fields.ticket_id ?? null,
        payloadHash: record.contentHash,
        reasons: quarantineReasonsFrom(result.error.issues),
      });
      return;
    }

    if (redactedNote) {
      insertTextUnit(db, {
        unitHash: record.contentHash,
        sourceId: 'tickets',
        locator,
        text: redactedNote,
        concepts: classifyNote(redactedNote),
      });
    }
  });
}
