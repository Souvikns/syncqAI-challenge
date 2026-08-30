// drivers_roster.csv — pure PII. 60 drivers, no blank cells anywhere.

import type { Database } from 'bun:sqlite';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { emptyToNull, hmacToken, parseDate } from '../utils';
import { buildRawRecord, storeRawRecord } from './shared';

export function ingestDriversRoster(db: Database, filePath: string, salt: string): void {
  const rows = parse(readFileSync(filePath), { columns: true, bom: true }) as Record<string, string>[];

  rows.forEach((r, index) => {
    const locator = `row:${index + 1}`;

    // Tokenise before this row is hashed or written anywhere - the driver's
    // raw name, phone, licence and Aadhaar numbers must never reach
    // source_records, not even inside the content-addressed payload.
    const nameToken = hmacToken(salt, 'PERSON', (r.name ?? '').trim());
    const phoneToken = hmacToken(salt, 'PHONE', (r.phone ?? '').trim());
    const dlToken = hmacToken(salt, 'DL', (r.dl_number ?? '').trim());
    const aadhaarToken = hmacToken(salt, 'AADHAAR', (r.aadhaar ?? '').trim());

    const payload: Record<string, string | null> = {
      driver_id: emptyToNull(r.driver_id ?? ''),
      name: nameToken,
      phone: phoneToken,
      dl_number: dlToken,
      aadhaar: aadhaarToken,
      joining_date: emptyToNull(r.joining_date ?? ''),
      home_hub: emptyToNull(r.home_hub ?? ''),
    };
    const record = buildRawRecord('drivers_roster', filePath, locator, payload);
    storeRawRecord(db, record);

    const joiningDate = parseDate(r.joining_date ?? '');
    db.query(
      `INSERT INTO drivers (driver_id, name_token, phone_token, dl_token, aadhaar_token, joining_date, home_hub)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(driver_id) DO UPDATE SET
         name_token = excluded.name_token, phone_token = excluded.phone_token,
         dl_token = excluded.dl_token, aadhaar_token = excluded.aadhaar_token,
         joining_date = excluded.joining_date, home_hub = excluded.home_hub`,
    ).run(r.driver_id ?? '', nameToken, phoneToken, dlToken, aadhaarToken, joiningDate.value, (r.home_hub ?? '').trim());
  });
}
