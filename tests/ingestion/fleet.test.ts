import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestFleetMaster } from '../../src/ingestion/fleet';
import { row, tempDbPath } from '../helpers';

describe('ingestFleetMaster', () => {
  test('resolves 118 fleet rows into 100 vehicles with 14 conflicts', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    expect(row(db, 'SELECT COUNT(*) as n FROM vehicles').n).toBe(100);
    expect(row(db, 'SELECT COUNT(*) as n FROM conflicts').n).toBe(14);
    db.close();
  });

  test('splits conflicts 6 heater, 5 capacity, 3 year', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    const countFor = (field: string) => row(db, `SELECT COUNT(*) as n FROM conflicts WHERE field = '${field}'`).n;
    expect(countFor('vehicle.engine_heater')).toBe(6);
    expect(countFor('vehicle.capacity_tonnes')).toBe(5);
    expect(countFor('vehicle.year')).toBe(3);
    db.close();
  });

  test('resolves RJ43DD3546 to the fleet master year, the authoritative source', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    const vehicle = row(db, "SELECT year, bs_stage FROM vehicles WHERE vehicle_key = 'RJ43DD3546'");
    expect(vehicle.year).toBe(2017);
    expect(vehicle.bs_stage).toBe('BS4');
    db.close();
  });

  test('is idempotent: ingesting the same file twice does not change the counts', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    ingestFleetMaster(db, 'fleet_master.csv');
    expect(row(db, 'SELECT COUNT(*) as n FROM vehicles').n).toBe(100);
    expect(row(db, 'SELECT COUNT(*) as n FROM conflicts').n).toBe(14);
    db.close();
  });
});
