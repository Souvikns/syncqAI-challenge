// meridian_trips.csv — historical client<->vehicle association only. Every
// row is dated 2018; it cannot supply live position for a 2026 ticket.

import type { Database } from 'bun:sqlite';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { normalizePlate, parseDate, payloadFromRow } from '../utils';
import { buildRawRecord, resolveClientKey, storeRawRecord } from './shared';

export function ingestTrips(db: Database, filePath: string): void {
  const rows = parse(readFileSync(filePath), { columns: true, bom: true }) as Record<string, string>[];

  rows.forEach((r, index) => {
    const locator = `row:${index + 1}`;
    const record = buildRawRecord('trips', filePath, locator, payloadFromRow(r));
    storeRawRecord(db, record);

    const plate = normalizePlate(r.vehicle_reg ?? '');
    const occurredOn = parseDate(r.created_at ?? '');
    const clientKey = resolveClientKey(r.client ?? '');

    db.query(
      `INSERT OR IGNORE INTO trip_history (trip_id, occurred_on, vehicle_key, driver_id, client_key, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.trip_id ?? '', occurredOn.value ?? 'UNKNOWN', plate.key, r.driver_id ?? '', clientKey ?? 'UNKNOWN', r.status ?? 'UNKNOWN');
  });
}
