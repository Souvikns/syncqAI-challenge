// maintenance_log.xlsx — the event stream. 250 events over 93 distinct
// vehicles, written with 172 distinct registration spellings.

import type { Database } from 'bun:sqlite';
import ExcelJS from 'exceljs';
import { classifyNote, emptyToNull, hmacToken, normalizePlate, parseDate, redactPii, toInt } from '../utils';
import { buildRawRecord, quarantineRecord, raiseAlert, storeRawRecord } from './shared';

interface MaintenanceRow {
  readonly locator: string;
  readonly date: string;
  readonly vehicle: string;
  readonly odometerKm: string;
  readonly mechanic: string;
  readonly notes: string;
}

function cellAt(values: ExcelJS.CellValue[] | { [key: string]: ExcelJS.CellValue }, column: number): string {
  const value = Array.isArray(values) ? values[column] : undefined;
  return String(value ?? '');
}

async function readMaintenanceRows(filePath: string): Promise<MaintenanceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('maintenance_log.xlsx has no worksheet');

  const rows: MaintenanceRow[] = [];
  sheet.eachRow((sheetRow, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = (column: number) => cellAt(sheetRow.values, column);
    rows.push({
      locator: `sheet1:row:${rowNumber}`,
      date: cell(1),
      vehicle: cell(2),
      odometerKm: cell(3),
      mechanic: cell(4),
      notes: cell(5),
    });
  });
  return rows;
}

export async function ingestMaintenanceLog(db: Database, filePath: string, salt: string): Promise<void> {
  for (const r of await readMaintenanceRows(filePath)) {
    // Tokenise before this row is hashed or written anywhere - the raw
    // mechanic name and any PII hiding in free-text notes must never reach
    // source_records, not even inside the content-addressed payload.
    const mechanicToken = hmacToken(salt, 'PERSON', r.mechanic.trim());
    const redactedNotes = redactPii(salt, r.notes);

    const payload: Record<string, string | null> = {
      date: emptyToNull(r.date),
      vehicle: emptyToNull(r.vehicle),
      odometer_km: emptyToNull(r.odometerKm),
      mechanic: mechanicToken,
      notes: emptyToNull(redactedNotes),
    };
    const record = buildRawRecord('maintenance_log', filePath, r.locator, payload);
    storeRawRecord(db, record);

    const date = parseDate(r.date);
    const plate = normalizePlate(r.vehicle);
    if (!date.valid || !plate.valid) {
      quarantineRecord(db, {
        sourceId: 'maintenance_log',
        unit: filePath,
        locator: r.locator,
        recordId: null,
        payloadHash: record.contentHash,
        reasons: [
          ...(date.valid ? [] : [{ field: 'date', code: 'UNPARSEABLE_DATE', detail: r.date }]),
          ...(plate.valid ? [] : [{ field: 'vehicle', code: 'BAD_PLATE', detail: r.vehicle }]),
        ],
      });
      continue;
    }

    const concepts = classifyNote(r.notes);
    if (concepts.length === 0) raiseAlert(db, 'LEXICON_MISS', plate.key, redactedNotes);

    db.query(
      `INSERT OR IGNORE INTO maintenance_events
         (event_hash, vehicle_key, occurred_on, odometer_km, mechanic_token, note, concepts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(record.contentHash, plate.key, date.value, toInt(r.odometerKm), mechanicToken, redactedNotes, JSON.stringify(concepts));
  }
}
