import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionsDb } from '../src/actions';
import { exportOutputs } from '../src/export-outputs';
import { tempDbPath } from './helpers';

function readJsonl(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function seededActionsDb() {
  const db = openActionsDb(tempDbPath());
  db.query(
    `INSERT INTO work_orders (work_order_id, ticket_id, vehicle_reg, replacement_vehicle_key, action_code, created_at, citations)
     VALUES ('wo1', 'TKT-0001', 'UP-40-IM-3144', 'UP99ZZ9999', 'DISPATCH_FROM_ORIGIN_HUB', '2026-08-11T19:00:00+05:30', '["abc123"]')`,
  ).run();
  db.query(
    `INSERT INTO comms_pending (message_id, ticket_id, recipient, body, context, drafted_at)
     VALUES ('m1', 'TKT-0001', 'dispatch@shakticement.example.in', 'body text', '{"ticketId":"TKT-0001"}', '2026-08-11T19:00:00+05:30')`,
  ).run();
  db.query(
    `INSERT INTO comms_pending (message_id, ticket_id, recipient, body, context, drafted_at)
     VALUES ('m2', 'TKT-0002', 'dispatch@shakticement.example.in', 'already sent', '{"ticketId":"TKT-0002"}', '2026-08-11T19:00:00+05:30')`,
  ).run();
  db.query(
    `INSERT INTO comms_sent (message_id, ticket_id, recipient, body, approved_by, sent_at)
     VALUES ('m2', 'TKT-0002', 'dispatch@shakticement.example.in', 'already sent', 'Alex', '2026-08-30T00:00:00+05:30')`,
  ).run();
  db.query(
    `INSERT INTO quarantine (quarantine_id, ticket_id, locator, payload_hash, reasons)
     VALUES ('q1', 'TKT-9101', 'row:35', 'hash1', '[{"field":"vehicle","code":"MISSING","detail":""}]')`,
  ).run();
  db.query(
    `INSERT INTO audit_log (audit_id, ticket_id, step, decision, rule_id, citations, decided_by)
     VALUES ('a1', 'TKT-0001', 'VALIDATE', 'VALID', NULL, '[]', 'pipeline')`,
  ).run();
  return db;
}

describe('exportOutputs', () => {
  test('work_orders.jsonl contains exactly the README-shaped 5 fields', () => {
    const db = seededActionsDb();
    const dir = mkdtempSync(join(tmpdir(), 'meridian-out-'));
    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));

    const rows = readJsonl(join(dir, 'outputs', 'work_orders.jsonl'));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ['citations', 'created_at', 'ticket_id', 'vehicle_reg', 'work_order_id'].sort(),
    );
    expect((rows[0] as any).citations).toEqual(['abc123']);

    db.close();
  });

  test('comms_pending.jsonl excludes tickets already in comms_sent', () => {
    const db = seededActionsDb();
    const dir = mkdtempSync(join(tmpdir(), 'meridian-out-'));
    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));

    const rows = readJsonl(join(dir, 'outputs', 'comms_pending.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ticket_id).toBe('TKT-0001');

    db.close();
  });

  test('comms_sent.jsonl has the approved message', () => {
    const db = seededActionsDb();
    const dir = mkdtempSync(join(tmpdir(), 'meridian-out-'));
    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));

    const rows = readJsonl(join(dir, 'outputs', 'comms_sent.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.approved_by).toBe('Alex');

    db.close();
  });

  test('quarantine.jsonl and audit.jsonl are written', () => {
    const db = seededActionsDb();
    const dir = mkdtempSync(join(tmpdir(), 'meridian-out-'));
    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));

    expect(readJsonl(join(dir, 'outputs', 'quarantine.jsonl'))).toHaveLength(1);
    expect(existsSync(join(dir, 'audit', 'audit.jsonl'))).toBe(true);
    expect(readJsonl(join(dir, 'audit', 'audit.jsonl'))).toHaveLength(1);

    db.close();
  });

  test('regenerating twice with no new data produces byte-identical files', () => {
    const db = seededActionsDb();
    const dir = mkdtempSync(join(tmpdir(), 'meridian-out-'));
    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));
    const first = readFileSync(join(dir, 'outputs', 'work_orders.jsonl'), 'utf8');

    exportOutputs(db, join(dir, 'outputs'), join(dir, 'audit'));
    const second = readFileSync(join(dir, 'outputs', 'work_orders.jsonl'), 'utf8');

    expect(second).toBe(first);

    db.close();
  });
});
