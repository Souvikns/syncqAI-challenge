import type { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_SALT = 'test-salt';

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-test-'));
  return join(dir, 'context.db');
}

export function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'meridian-state-'));
}

export function row(db: Database, sql: string): any {
  return db.query(sql).get();
}

export function driverIdsFrom(db: Database): Set<string> {
  const rows = db.query('SELECT driver_id FROM drivers').all() as { driver_id: string }[];
  return new Set(rows.map((r) => r.driver_id));
}

export const TABLES_TO_SWEEP = [
  'source_records', 'observations', 'vehicles', 'drivers', 'clients', 'hubs',
  'maintenance_events', 'trip_history', 'conflicts', 'vehicle_state',
  'driver_state', 'client_vehicle_history', 'text_units', 'quarantine', 'alerts',
];

export function dumpDatabase(db: Database): string {
  return TABLES_TO_SWEEP.map((table) => {
    const rows = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return `${table}:${JSON.stringify(rows)}`;
  }).join('\n');
}
