import { describe, test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  openContextDb,
  deriveVehicleState,
  deriveDriverState,
  deriveClientVehicleHistory,
  ingest,
  loadConfig,
} from '../src/ingest';
import { ingestFleetMaster } from '../src/ingestion/fleet';
import { ingestMaintenanceLog } from '../src/ingestion/maintenance';
import { ingestDriversRoster } from '../src/ingestion/drivers';
import { ingestTrips } from '../src/ingestion/trips';
import { cite } from '../src/ingestion/shared';
import { detectPii } from '../src/utils';
import { row, tempDbPath, tempStateDir, dumpDatabase, TABLES_TO_SWEEP, TEST_SALT } from './helpers';

describe('openContextDb', () => {
  test('creates every table the pipeline depends on', () => {
    const db = openContextDb(tempDbPath());
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    for (const expected of [
      'source_records', 'record_locations', 'observations', 'vehicles', 'drivers',
      'clients', 'hubs', 'maintenance_events', 'trip_history', 'conflicts',
      'vehicle_state', 'driver_state', 'client_vehicle_history', 'text_units',
      'quarantine', 'alerts', 'ingest_manifest',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  test('is idempotent to open twice', () => {
    const path = tempDbPath();
    openContextDb(path).close();
    expect(() => openContextDb(path).close()).not.toThrow();
  });

  test('enables foreign key enforcement', () => {
    const db = openContextDb(tempDbPath());
    const pragma = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(pragma.foreign_keys).toBe(1);
    db.close();
  });
});

describe('deriveVehicleState', () => {
  test('grounded is UNKNOWN for every vehicle, because no service-due data exists', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    deriveVehicleState(db);
    expect(row(db, "SELECT COUNT(*) as n FROM vehicle_state WHERE grounded = 'UNKNOWN'").n).toBe(100);
    db.close();
  });

  test('computes last_service_on and last_brake_work_on from maintenance history', async () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    deriveVehicleState(db);
    expect(row(db, 'SELECT COUNT(*) as n FROM vehicle_state WHERE last_service_on IS NOT NULL').n).toBeGreaterThan(0);
    expect(row(db, 'SELECT COUNT(*) as n FROM vehicle_state WHERE last_brake_work_on IS NOT NULL').n).toBeGreaterThan(0);
    db.close();
  });

  test('sets a 7-day temp_fix_expires window after the latest jugaad note', async () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    deriveVehicleState(db);
    const withTempFix = row(db, 'SELECT temp_fix_on, temp_fix_expires FROM vehicle_state WHERE temp_fix_on IS NOT NULL LIMIT 1');
    const days = (Date.parse(withTempFix.temp_fix_expires) - Date.parse(withTempFix.temp_fix_on)) / 86_400_000;
    expect(days).toBe(7);
    db.close();
  });

  test('every evidence hash resolves through cite()', async () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    await ingestMaintenanceLog(db, 'maintenance_log.xlsx', TEST_SALT);
    deriveVehicleState(db);
    const rows = db.query('SELECT evidence FROM vehicle_state').all() as { evidence: string }[];
    for (const { evidence } of rows) {
      for (const hash of JSON.parse(evidence) as string[]) expect(cite(db, hash)).not.toBeNull();
    }
    db.close();
  });
});

describe('deriveDriverState', () => {
  test('computes tenure_days against a supplied reference date, never the wall clock', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    deriveDriverState(db, '2026-08-30T00:00:00+05:30');
    expect(typeof row(db, "SELECT tenure_days FROM driver_state WHERE driver_id = 'DRV-001'").tenure_days).toBe('number');
    db.close();
  });

  test('leaves night_solo_ok as UNKNOWN - the six-month threshold is dispatcher policy, not ingestion logic', () => {
    const db = openContextDb(tempDbPath());
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    deriveDriverState(db, '2026-08-30T00:00:00+05:30');
    expect(row(db, "SELECT COUNT(*) as n FROM driver_state WHERE night_solo_ok != 'UNKNOWN'").n).toBe(0);
    db.close();
  });
});

describe('deriveClientVehicleHistory', () => {
  test('records the latest trip date per client-vehicle pair', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    ingestTrips(db, 'meridian_trips.csv');
    deriveClientVehicleHistory(db);
    expect(row(db, 'SELECT COUNT(*) as n FROM client_vehicle_history').n).toBeGreaterThan(0);
    db.close();
  });
});

describe('loadConfig', () => {
  test('throws when the PII salt is not set', () => {
    expect(() => loadConfig({})).toThrow(/MERIDIAN_PII_SALT/);
  });

  test('throws when the reference date is not set - ingestion never reads the wall clock', () => {
    expect(() => loadConfig({ MERIDIAN_PII_SALT: 'x' })).toThrow(/MERIDIAN_REFERENCE_DATE/);
  });

  test('reads dataRoot and stateDir from the environment, defaulting sensibly', () => {
    const config = loadConfig({ MERIDIAN_PII_SALT: 'x', MERIDIAN_REFERENCE_DATE: '2026-08-30T00:00:00+05:30' });
    expect(config.piiSalt).toBe('x');
    expect(config.referenceDate).toBe('2026-08-30T00:00:00+05:30');
    expect(config.dataRoot).toBe('.');
    expect(config.stateDir).toBe('./state');
  });
});

describe('ingest', () => {
  const config = { dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: '2026-08-30T00:00:00+05:30' };

  test('produces every documented acceptance number from a single run', async () => {
    const db = await ingest({ ...config, stateDir: tempStateDir() });
    expect(row(db, 'SELECT COUNT(*) as n FROM vehicles').n).toBe(100);
    expect(row(db, 'SELECT COUNT(*) as n FROM conflicts').n).toBe(14);
    expect(row(db, 'SELECT COUNT(*) as n FROM maintenance_events').n).toBe(250);
    expect(row(db, 'SELECT COUNT(*) as n FROM drivers').n).toBe(60);
    expect(row(db, 'SELECT COUNT(*) as n FROM trip_history').n).toBe(10000);
    expect(row(db, "SELECT COUNT(*) as n FROM quarantine WHERE source_id = 'tickets'").n).toBe(2);
    expect(row(db, "SELECT COUNT(*) as n FROM text_units WHERE source_id = 'emails'").n).toBeGreaterThan(40);
    expect(row(db, "SELECT COUNT(*) as n FROM vehicle_state WHERE grounded = 'UNKNOWN'").n).toBe(100);
    db.close();
  });

  test('running the pipeline twice produces a byte-identical dump', async () => {
    const stateDir = tempStateDir();
    const first = await ingest({ ...config, stateDir });
    const firstDump = dumpDatabase(first);
    first.close();

    const second = await ingest({ ...config, stateDir });
    const secondDump = dumpDatabase(second);
    second.close();

    expect(secondDump).toBe(firstDump);
  });

  test('deleting context.db and re-ingesting restores the same content', async () => {
    const stateDir = tempStateDir();
    const first = await ingest({ ...config, stateDir });
    const firstDump = dumpDatabase(first);
    first.close();
    rmSync(join(stateDir, 'context.db'));

    const rebuilt = await ingest({ ...config, stateDir });
    expect(dumpDatabase(rebuilt)).toBe(firstDump);
    rebuilt.close();
  });

  test('no raw PII survives anywhere in context.db', async () => {
    const db = await ingest({ ...config, stateDir: tempStateDir() });
    for (const table of TABLES_TO_SWEEP) {
      const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      const text = rows.map((r) => JSON.stringify(r)).join(' ');
      expect(detectPii(text)).toEqual([]);
    }
    db.close();
  });

  test('every *_src citation and every evidence hash resolves through cite()', async () => {
    const db = await ingest({ ...config, stateDir: tempStateDir() });

    const vehicles = db.query('SELECT year_src, heater_src, capacity_src, hub_src FROM vehicles').all() as Record<string, string | null>[];
    for (const v of vehicles) {
      for (const hash of Object.values(v)) if (hash) expect(cite(db, hash)).not.toBeNull();
    }

    const states = db.query('SELECT evidence FROM vehicle_state').all() as { evidence: string }[];
    for (const { evidence } of states) {
      for (const hash of JSON.parse(evidence) as string[]) expect(cite(db, hash)).not.toBeNull();
    }
    db.close();
  });
});
