// Step 2: join a validated ticket against context.db. Every field that
// doesn't resolve is null/UNKNOWN, never defaulted or invented.

import type { Database } from 'bun:sqlite';
import { resolveClientKey, resolveHubKey } from '../ingestion/shared';
import { classifyNote } from '../utils';
import { writeAuditRecord } from './audit';
import type { ParsedTicket } from './validate';

export interface EnrichedVehicle {
  readonly key: string;
  readonly model: string | null;
  readonly year: number | null;
  readonly bsStage: string | null;
  readonly engineHeater: string;
  readonly homeHub: string | null;
  readonly capacityTonnes: number | null;
  readonly yearSrc: string | null;
  readonly heaterSrc: string | null;
  readonly capacitySrc: string | null;
  readonly hubSrc: string | null;
}

export interface EnrichedVehicleState {
  readonly grounded: string;
  readonly groundedReason: string | null;
  readonly lastServiceOn: string | null;
  readonly lastBrakeWorkOn: string | null;
  readonly tempFixOn: string | null;
  readonly tempFixExpires: string | null;
}

export interface EnrichedDriver {
  readonly driverId: string;
  readonly joiningDate: string | null;
  readonly homeHub: string | null;
}

export interface EnrichedDriverState {
  readonly tenureDays: number | null;
  readonly nightSoloOk: string;
}

export interface RelevantMaintenanceEvent {
  readonly eventHash: string;
  readonly occurredOn: string;
  readonly note: string;
}

export interface EnrichedTicket {
  readonly ticket: ParsedTicket;
  readonly vehicle: EnrichedVehicle | null;
  readonly vehicleState: EnrichedVehicleState | null;
  readonly driver: EnrichedDriver | null;
  readonly driverState: EnrichedDriverState | null;
  readonly clientKey: string;
  readonly originHubKey: string;
  readonly destinationHubKey: string;
  readonly lastTripForClientVehicle: string | null;
  /** Past maintenance events on this vehicle whose lexicon concepts overlap
   * the ticket's own issue text - e.g. a "clutch slipping" breakdown against
   * a note already tagged `clutch`. Empty, never guessed, when nothing
   * matches - see utils.ts's classifyNote for the shared lexicon. */
  readonly relevantMaintenanceHistory: readonly RelevantMaintenanceEvent[];
}

function findVehicle(db: Database, vehicleKey: string): EnrichedVehicle | null {
  return db
    .query(
      `SELECT vehicle_key as key, model, year, bs_stage as bsStage, engine_heater as engineHeater,
              home_hub as homeHub, capacity_tonnes as capacityTonnes,
              year_src as yearSrc, heater_src as heaterSrc, capacity_src as capacitySrc, hub_src as hubSrc
       FROM vehicles WHERE vehicle_key = ?`,
    )
    .get(vehicleKey) as EnrichedVehicle | null;
}

function findVehicleState(db: Database, vehicleKey: string): EnrichedVehicleState | null {
  return db
    .query(
      `SELECT grounded, grounded_reason as groundedReason, last_service_on as lastServiceOn,
              last_brake_work_on as lastBrakeWorkOn, temp_fix_on as tempFixOn, temp_fix_expires as tempFixExpires
       FROM vehicle_state WHERE vehicle_key = ?`,
    )
    .get(vehicleKey) as EnrichedVehicleState | null;
}

function findDriver(db: Database, driverId: string): EnrichedDriver | null {
  return db
    .query('SELECT driver_id as driverId, joining_date as joiningDate, home_hub as homeHub FROM drivers WHERE driver_id = ?')
    .get(driverId) as EnrichedDriver | null;
}

function findDriverState(db: Database, driverId: string): EnrichedDriverState | null {
  return db
    .query('SELECT tenure_days as tenureDays, night_solo_ok as nightSoloOk FROM driver_state WHERE driver_id = ?')
    .get(driverId) as EnrichedDriverState | null;
}

function findRelevantMaintenanceHistory(db: Database, vehicleKey: string, issueConcepts: readonly string[]): RelevantMaintenanceEvent[] {
  if (issueConcepts.length === 0) return [];
  const events = db
    .query(
      `SELECT event_hash as eventHash, occurred_on as occurredOn, note, concepts
       FROM maintenance_events WHERE vehicle_key = ? ORDER BY occurred_on DESC, event_hash ASC`,
    )
    .all(vehicleKey) as { eventHash: string; occurredOn: string; note: string; concepts: string }[];

  return events
    .filter((e) => (JSON.parse(e.concepts) as string[]).some((concept) => issueConcepts.includes(concept)))
    .map((e) => ({ eventHash: e.eventHash, occurredOn: e.occurredOn, note: e.note }));
}

function findLastTrip(db: Database, clientKey: string, vehicleKey: string): string | null {
  const result = db
    .query('SELECT last_trip_on as lastTripOn FROM client_vehicle_history WHERE client_key = ? AND vehicle_key = ?')
    .get(clientKey, vehicleKey) as { lastTripOn: string } | null;
  return result?.lastTripOn ?? null;
}

export function vehicleCitations(vehicle: EnrichedVehicle | null): string[] {
  if (!vehicle) return [];
  return [vehicle.yearSrc, vehicle.heaterSrc, vehicle.capacitySrc, vehicle.hubSrc].filter((hash): hash is string => hash !== null);
}

export function enrichTicket(contextDb: Database, actionsDb: Database, ticket: ParsedTicket): EnrichedTicket {
  const vehicle = findVehicle(contextDb, ticket.vehicleKey);
  const vehicleState = vehicle ? findVehicleState(contextDb, ticket.vehicleKey) : null;
  const driver = findDriver(contextDb, ticket.driverId);
  const driverState = driver ? findDriverState(contextDb, ticket.driverId) : null;
  const clientKey = resolveClientKey(ticket.client) ?? 'UNKNOWN';
  const originHubKey = resolveHubKey(ticket.originHub) ?? 'UNKNOWN';
  const destinationHubKey = resolveHubKey(ticket.destination) ?? 'UNKNOWN';
  const lastTripForClientVehicle = clientKey !== 'UNKNOWN' ? findLastTrip(contextDb, clientKey, ticket.vehicleKey) : null;
  const issueConcepts = classifyNote(ticket.issue);
  const relevantMaintenanceHistory = vehicle ? findRelevantMaintenanceHistory(contextDb, ticket.vehicleKey, issueConcepts) : [];

  writeAuditRecord(actionsDb, {
    ticketId: ticket.ticketId,
    step: 'ENRICH',
    decision: `vehicle:${vehicle?.key ?? 'UNKNOWN'};driver:${driver?.driverId ?? 'UNKNOWN'};client:${clientKey}`,
    ruleId: null,
    citations: [...vehicleCitations(vehicle), ...relevantMaintenanceHistory.map((e) => e.eventHash)],
    decidedBy: 'pipeline',
  });

  return {
    ticket,
    vehicle,
    vehicleState,
    driver,
    driverState,
    clientKey,
    originHubKey,
    destinationHubKey,
    lastTripForClientVehicle,
    relevantMaintenanceHistory,
  };
}
