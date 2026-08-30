import { Database } from 'bun:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_tickets (
  ticket_id    TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  outcome      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY,
  ticket_id     TEXT,
  locator       TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  reasons       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id           TEXT PRIMARY KEY,
  ticket_id               TEXT NOT NULL UNIQUE,
  vehicle_reg             TEXT NOT NULL,
  replacement_vehicle_key TEXT,
  action_code             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  citations               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  vehicle_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_key, ticket_id)
);

CREATE TABLE IF NOT EXISTS apex_flags (
  vehicle_key TEXT PRIMARY KEY,
  flagged_at  TEXT NOT NULL,
  cleared_at  TEXT
);

CREATE TABLE IF NOT EXISTS comms_pending (
  message_id TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL UNIQUE,
  recipient  TEXT NOT NULL,
  body       TEXT NOT NULL,
  context    TEXT NOT NULL,
  drafted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comms_sent (
  message_id  TEXT PRIMARY KEY REFERENCES comms_pending(message_id),
  ticket_id   TEXT NOT NULL UNIQUE,
  recipient   TEXT NOT NULL,
  body        TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  sent_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  subject  TEXT NOT NULL,
  detail   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id   TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  step       TEXT NOT NULL,
  decision   TEXT NOT NULL,
  rule_id    TEXT,
  citations  TEXT NOT NULL,
  decided_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_ticket ON audit_log(ticket_id, step);
`;

export function openActionsDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}
