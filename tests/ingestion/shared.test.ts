import { describe, test, expect } from 'bun:test';
import { openContextDb, ingestFleetMaster } from '../../src/ingest';
import { resolveClientKey, resolveHubKey, cite } from '../../src/ingestion/shared';
import { row, tempDbPath } from '../helpers';

describe('resolveClientKey', () => {
  test('matches the exact display name', () => {
    expect(resolveClientKey('Shakti Cement')).toBe('shakti_cement');
  });

  test('matches a bare prose token case-insensitively', () => {
    expect(resolveClientKey('vertex')).toBe('vertex_retail');
  });

  test('matches an email domain label', () => {
    expect(resolveClientKey('dispatch@shakticement.example.in')).toBe('shakti_cement');
  });

  test('returns null for an unknown client rather than inventing one', () => {
    expect(resolveClientKey('Some Random Company Pvt Ltd')).toBeNull();
  });
});

describe('resolveHubKey', () => {
  test('matches a known hub case-insensitively', () => {
    expect(resolveHubKey('lucknow')).toBe('lucknow');
  });

  test('returns null for an unknown hub rather than inventing one', () => {
    expect(resolveHubKey('Mumbai')).toBeNull();
  });
});

describe('cite', () => {
  test('resolves a content hash back to its source file and position', () => {
    const db = openContextDb(tempDbPath());
    ingestFleetMaster(db, 'fleet_master.csv');
    const vehicle = row(db, "SELECT year_src FROM vehicles WHERE vehicle_key = 'RJ43DD3546'");
    const citation = cite(db, vehicle.year_src);
    expect(citation?.sourceId).toBe('fleet_master');
    expect(citation?.locator).toBe('row:2');
    db.close();
  });

  test('returns null for an unknown hash instead of throwing', () => {
    const db = openContextDb(tempDbPath());
    expect(cite(db, 'not-a-real-hash')).toBeNull();
    db.close();
  });
});
