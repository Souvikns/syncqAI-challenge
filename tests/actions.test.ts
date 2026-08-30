import { describe, test, expect } from 'bun:test';
import { openActionsDb } from '../src/actions';
import { tempDbPath } from './helpers';

describe('openActionsDb', () => {
  test('creates every table the decision pipeline depends on', () => {
    const db = openActionsDb(tempDbPath());
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    for (const expected of [
      'processed_tickets', 'quarantine', 'work_orders', 'vehicle_assignments',
      'apex_flags', 'comms_pending', 'comms_sent', 'audit_log', 'alerts',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  test('is idempotent to open twice', () => {
    const path = tempDbPath();
    openActionsDb(path).close();
    expect(() => openActionsDb(path).close()).not.toThrow();
  });

  test('enables foreign key enforcement', () => {
    const db = openActionsDb(tempDbPath());
    const pragma = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(pragma.foreign_keys).toBe(1);
    db.close();
  });
});
