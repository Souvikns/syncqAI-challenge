import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, daysBetween } from './utils';
import { raiseAlert } from './ingestion/shared';
import { ingestFleetMaster } from './ingestion/fleet';
import { ingestMaintenanceLog } from './ingestion/maintenance';
import { ingestDriversRoster } from './ingestion/drivers';
import { ingestTrips } from './ingestion/trips';
import { ingestEmails } from './ingestion/emails';
import { ingestInterview } from './ingestion/interview';
import { ingestTickets } from './ingestion/tickets';

export {
  ingestFleetMaster,
  ingestMaintenanceLog,
  ingestDriversRoster,
  ingestTrips,
  ingestEmails,
  ingestInterview,
  ingestTickets,
};
export { cite, searchText, resolveClientKey, resolveHubKey, CLIENT_ALIASES, HUBS } from './ingestion/shared';
export type { Citation, TextHit } from './ingestion/shared';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_manifest (
  source_id    TEXT NOT NULL,
  unit         TEXT NOT NULL,
  unit_hash    TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  PRIMARY KEY (source_id, unit)
);

CREATE TABLE IF NOT EXISTS source_records (
  content_hash TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  payload      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS record_locations (
  content_hash TEXT NOT NULL REFERENCES source_records(content_hash),
  unit         TEXT NOT NULL,
  locator      TEXT NOT NULL,
  PRIMARY KEY (content_hash, unit, locator)
);

CREATE TABLE IF NOT EXISTS observations (
  entity_kind TEXT NOT NULL,
  entity_key  TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  valid_at    TEXT,
  source_hash TEXT NOT NULL REFERENCES source_records(content_hash),
  PRIMARY KEY (entity_kind, entity_key, field, source_hash)
);
CREATE INDEX IF NOT EXISTS obs_lookup ON observations(entity_kind, entity_key, field);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_key      TEXT PRIMARY KEY,
  vehicle_id       TEXT,
  model            TEXT,
  year             INTEGER,
  bs_stage         TEXT,
  engine_heater    TEXT NOT NULL DEFAULT 'UNKNOWN',
  home_hub         TEXT,
  capacity_tonnes  INTEGER,
  year_src         TEXT, heater_src TEXT, capacity_src TEXT, hub_src TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  driver_id     TEXT PRIMARY KEY,
  name_token    TEXT NOT NULL,
  phone_token   TEXT,
  dl_token      TEXT,
  aadhaar_token TEXT,
  joining_date  TEXT,
  home_hub      TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  client_key   TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hubs (
  hub_key      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_events (
  event_hash    TEXT PRIMARY KEY,
  vehicle_key   TEXT NOT NULL,
  occurred_on   TEXT NOT NULL,
  odometer_km   INTEGER,
  mechanic_token TEXT,
  note          TEXT NOT NULL,
  concepts      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS maint_by_vehicle ON maintenance_events(vehicle_key, occurred_on);

CREATE TABLE IF NOT EXISTS trip_history (
  trip_id     TEXT PRIMARY KEY,
  occurred_on TEXT NOT NULL,
  vehicle_key TEXT NOT NULL,
  driver_id   TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  status      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_by_client ON trip_history(client_key, occurred_on);

CREATE TABLE IF NOT EXISTS conflicts (
  entity_kind    TEXT NOT NULL,
  entity_key     TEXT NOT NULL,
  field          TEXT NOT NULL,
  winning_value  TEXT NOT NULL,
  winning_source TEXT NOT NULL,
  losing_value   TEXT NOT NULL,
  losing_source  TEXT NOT NULL,
  reason         TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_key, field, losing_source)
);

CREATE TABLE IF NOT EXISTS vehicle_state (
  vehicle_key        TEXT PRIMARY KEY REFERENCES vehicles(vehicle_key),
  grounded           TEXT NOT NULL,
  grounded_reason    TEXT,
  last_service_on    TEXT,
  last_brake_work_on TEXT,
  temp_fix_on        TEXT,
  temp_fix_expires   TEXT,
  last_odometer_km   INTEGER,
  evidence           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_state (
  driver_id      TEXT PRIMARY KEY REFERENCES drivers(driver_id),
  tenure_days    INTEGER,
  night_solo_ok  TEXT NOT NULL,
  evidence       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_vehicle_history (
  client_key   TEXT NOT NULL,
  vehicle_key  TEXT NOT NULL,
  last_trip_on TEXT NOT NULL,
  PRIMARY KEY (client_key, vehicle_key)
);

CREATE TABLE IF NOT EXISTS text_units (
  unit_hash TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  locator   TEXT NOT NULL,
  text      TEXT NOT NULL,
  concepts  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS text_fts
  USING fts5(text, content='text_units', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL,
  unit          TEXT NOT NULL,
  locator       TEXT NOT NULL,
  record_id     TEXT,
  payload_hash  TEXT NOT NULL,
  reasons       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  subject  TEXT NOT NULL,
  detail   TEXT NOT NULL
);
`;

export function openContextDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Derive: what the rules engine will need, computed from resolved facts.
// Every output is tri-state or nullable - never default a missing value to a
// passing one.
// ---------------------------------------------------------------------------

interface LatestEvent {
  readonly eventHash: string;
  readonly occurredOn: string;
}

function latestEventWithConcept(db: Database, vehicleKey: string, concept: string | null): LatestEvent | null {
  const conceptFilter = concept ? `AND concepts LIKE '%"${concept}"%'` : '';
  return db
    .query(
      `SELECT event_hash as eventHash, occurred_on as occurredOn FROM maintenance_events
       WHERE vehicle_key = ? ${conceptFilter}
       ORDER BY occurred_on DESC, event_hash ASC LIMIT 1`,
    )
    .get(vehicleKey) as LatestEvent | null;
}

function latestOdometerReading(db: Database, vehicleKey: string): { eventHash: string; odometerKm: number } | null {
  return db
    .query(
      `SELECT event_hash as eventHash, odometer_km as odometerKm FROM maintenance_events
       WHERE vehicle_key = ? AND odometer_km IS NOT NULL
       ORDER BY occurred_on DESC, event_hash ASC LIMIT 1`,
    )
    .get(vehicleKey) as { eventHash: string; odometerKm: number } | null;
}

export function deriveVehicleState(db: Database): void {
  const vehicleKeys = (db.query('SELECT vehicle_key FROM vehicles').all() as { vehicle_key: string }[])
    .map((r) => r.vehicle_key)
    .sort();

  for (const vehicleKey of vehicleKeys) {
    const lastService = latestEventWithConcept(db, vehicleKey, null);
    const lastBrakeWork = latestEventWithConcept(db, vehicleKey, 'brake_work');
    const lastTempFix = latestEventWithConcept(db, vehicleKey, 'temp_fix');
    const lastOdometer = latestOdometerReading(db, vehicleKey);

    const evidence = [...new Set([lastService, lastBrakeWork, lastTempFix, lastOdometer].filter((e) => e !== null).map((e) => e.eventHash))].sort();

    db.query(
      `INSERT INTO vehicle_state
         (vehicle_key, grounded, grounded_reason, last_service_on, last_brake_work_on, temp_fix_on, temp_fix_expires, last_odometer_km, evidence)
       VALUES (?, 'UNKNOWN', 'NO_SERVICE_DUE_DATA', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vehicle_key) DO UPDATE SET
         last_service_on = excluded.last_service_on, last_brake_work_on = excluded.last_brake_work_on,
         temp_fix_on = excluded.temp_fix_on, temp_fix_expires = excluded.temp_fix_expires,
         last_odometer_km = excluded.last_odometer_km, evidence = excluded.evidence`,
    ).run(
      vehicleKey,
      lastService?.occurredOn ?? null,
      lastBrakeWork?.occurredOn ?? null,
      lastTempFix?.occurredOn ?? null,
      lastTempFix ? addDays(lastTempFix.occurredOn, 7) : null,
      lastOdometer?.odometerKm ?? null,
      JSON.stringify(evidence),
    );
  }

  raiseAlert(
    db,
    'SCHEMA',
    'vehicle_state.grounded',
    'no service-due date exists anywhere in the delivered bundle; grounded is UNKNOWN for every vehicle',
  );
}

export function deriveDriverState(db: Database, referenceDate: string): void {
  const drivers = db.query('SELECT driver_id, joining_date FROM drivers').all() as { driver_id: string; joining_date: string | null }[];

  for (const driver of [...drivers].sort((a, b) => a.driver_id.localeCompare(b.driver_id))) {
    const tenureDays = driver.joining_date ? daysBetween(driver.joining_date, referenceDate) : null;

    db.query(
      `INSERT INTO driver_state (driver_id, tenure_days, night_solo_ok, evidence)
       VALUES (?, ?, 'UNKNOWN', '[]')
       ON CONFLICT(driver_id) DO UPDATE SET tenure_days = excluded.tenure_days`,
    ).run(driver.driver_id, tenureDays);
    // SPEC-GAP: the "six months before night solo" threshold is dispatcher
    // policy from the interview, not a fact ingestion can derive on its own.
    // night_solo_ok stays UNKNOWN here; the rules engine combines this
    // tenure_days with the rule (once transcribed into rules.yaml) to decide it.
  }
}

export function deriveClientVehicleHistory(db: Database): void {
  const rows = db.query(
    `SELECT client_key as clientKey, vehicle_key as vehicleKey, MAX(occurred_on) as lastTripOn
     FROM trip_history
     WHERE client_key != 'UNKNOWN'
     GROUP BY client_key, vehicle_key`,
  ).all() as { clientKey: string; vehicleKey: string; lastTripOn: string }[];

  for (const r of [...rows].sort((a, b) => (a.clientKey + a.vehicleKey).localeCompare(b.clientKey + b.vehicleKey))) {
    db.query(
      `INSERT INTO client_vehicle_history (client_key, vehicle_key, last_trip_on)
       VALUES (?, ?, ?)
       ON CONFLICT(client_key, vehicle_key) DO UPDATE SET last_trip_on = excluded.last_trip_on`,
    ).run(r.clientKey, r.vehicleKey, r.lastTripOn);
  }
}

// ---------------------------------------------------------------------------
// The whole pipeline: source bytes in, a queryable context.db out. Reruns
// are safe - every table this touches is keyed so repeats are a no-op.
// ---------------------------------------------------------------------------

export interface IngestConfig {
  readonly dataRoot: string;
  readonly stateDir: string;
  readonly piiSalt: string;
  /** The pipeline's frozen logical clock. Ingestion never reads the wall clock. */
  readonly referenceDate: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): IngestConfig {
  const piiSalt = env.MERIDIAN_PII_SALT;
  if (!piiSalt) throw new Error('MERIDIAN_PII_SALT must be set');

  const referenceDate = env.MERIDIAN_REFERENCE_DATE;
  if (!referenceDate) throw new Error('MERIDIAN_REFERENCE_DATE must be set - ingestion never reads the wall clock');

  return {
    dataRoot: env.DATA_ROOT ?? '.',
    stateDir: env.STATE_DIR ?? './state',
    piiSalt,
    referenceDate,
  };
}

export async function ingest(config: IngestConfig): Promise<Database> {
  mkdirSync(config.stateDir, { recursive: true });
  const db = openContextDb(join(config.stateDir, 'context.db'));
  const path = (file: string) => join(config.dataRoot, file);

  ingestFleetMaster(db, path('fleet_master.csv'));
  await ingestMaintenanceLog(db, path('maintenance_log.xlsx'), config.piiSalt);
  ingestDriversRoster(db, path('drivers_roster.csv'), config.piiSalt);
  ingestTrips(db, path('meridian_trips.csv'));
  await ingestEmails(db, path('emails'), config.piiSalt);
  ingestInterview(db, path('dispatcher_interview.txt'), config.piiSalt);

  const knownDriverIds = new Set((db.query('SELECT driver_id FROM drivers').all() as { driver_id: string }[]).map((r) => r.driver_id));
  ingestTickets(db, path('tickets.json'), knownDriverIds, config.piiSalt);

  deriveVehicleState(db);
  deriveDriverState(db, config.referenceDate);
  deriveClientVehicleHistory(db);

  return db;
}
