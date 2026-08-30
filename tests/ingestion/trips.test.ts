import { describe, test, expect } from 'bun:test';
import { openContextDb } from '../../src/ingest';
import { ingestFleetMaster } from '../../src/ingestion/fleet';
import { ingestDriversRoster } from '../../src/ingestion/drivers';
import { ingestTrips } from '../../src/ingestion/trips';
import { row, tempDbPath, TEST_SALT } from '../helpers';

describe('ingestTrips', () => {
  test('loads all 10000 trips with zero vehicle or driver orphans', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    ingestDriversRoster(db, 'drivers_roster.csv', TEST_SALT);
    ingestTrips(db, 'meridian_trips.csv');
    expect(row(db, 'SELECT COUNT(*) as n FROM trip_history').n).toBe(10000);
    const orphanVehicles = row(
      db,
      'SELECT COUNT(*) as n FROM trip_history t LEFT JOIN vehicles v ON v.vehicle_key = t.vehicle_key WHERE v.vehicle_key IS NULL',
    ).n;
    const orphanDrivers = row(
      db,
      'SELECT COUNT(*) as n FROM trip_history t LEFT JOIN drivers d ON d.driver_id = t.driver_id WHERE d.driver_id IS NULL',
    ).n;
    expect(orphanVehicles).toBe(0);
    expect(orphanDrivers).toBe(0);
    db.close();
  });
});
