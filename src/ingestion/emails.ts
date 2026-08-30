// emails/ — 40 threads, claims not facts. No two threads are byte-identical;
// threads that restate the same rule weeks apart are corroboration, never
// deduplicated.

import type { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyNote, emptyToNull, hmacToken, redactPii } from '../utils';
import { buildRawRecord, insertTextUnit, storeRawRecord } from './shared';

interface EmailMessage {
  readonly locator: string;
  readonly from: string;
  readonly to: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
}

const EMAIL_HEADER_LINE = /^(From|To|Date|Subject):\s*(.*)$/;

function parseEmailMessage(text: string, locator: string): EmailMessage {
  const lines = text.split('\n');
  const headers: Record<string, string> = {};
  let bodyStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      bodyStart = i + 1;
      break;
    }
    const match = line.match(EMAIL_HEADER_LINE);
    if (match) headers[match[1] as string] = (match[2] ?? '').trim();
  }

  return {
    locator,
    from: headers.From ?? '',
    to: headers.To ?? '',
    date: headers.Date ?? '',
    subject: headers.Subject ?? '',
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}

function splitEmailThread(fileText: string, fileName: string): EmailMessage[] {
  return fileText.split(/\n-{60,}\n/).map((chunk, index) => parseEmailMessage(chunk.trim(), `${fileName}:msg:${index + 1}`));
}

export async function ingestEmails(db: Database, dir: string, salt: string): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();

  for (const file of files) {
    const fileText = readFileSync(join(dir, file), 'utf8');

    for (const msg of splitEmailThread(fileText, file)) {
      const payload: Record<string, string | null> = {
        from: emptyToNull(hmacToken(salt, 'EMAIL', msg.from)),
        to: emptyToNull(hmacToken(salt, 'EMAIL', msg.to)),
        date: emptyToNull(msg.date),
        subject: emptyToNull(redactPii(salt, msg.subject)),
        body: emptyToNull(redactPii(salt, msg.body)),
      };
      const record = buildRawRecord('emails', file, msg.locator, payload);
      storeRawRecord(db, record);

      insertTextUnit(db, {
        unitHash: record.contentHash,
        sourceId: 'emails',
        locator: msg.locator,
        text: redactPii(salt, msg.body),
        concepts: classifyNote(msg.body),
      });
    }
  }
}
