// fleet_master.csv — vehicles. 118 rows resolve to 100 vehicles; 18
// registrations appear twice under different spellings.

import type { Database } from 'bun:sqlite';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { groupBy, normalizePlate, payloadFromRow, toInt, toTri } from '../utils';
import {
  buildRawRecord,
  insertConflict,
  insertObservation,
  quarantineRecord,
  raiseAlert,
  resolveEntity,
  storeRawRecord,
  type Observation,
  type ResolvedField,
} from './shared';

const FLEET_FIELDS = ['vehicle_id', 'model', 'year', 'bs_stage', 'engine_heater', 'home_hub', 'capacity_tonnes'] as const;

function readFleetRows(filePath: string): Record<string, string>[] {
  return parse(readFileSync(filePath), { columns: true, bom: true }) as Record<string, string>[];
}

function fleetObservations(vehicleKey: string, row: Record<string, string>, sourceHash: string): Observation[] {
  return FLEET_FIELDS.map((field) => ({
    entityKind: 'vehicle',
    entityKey: vehicleKey,
    field: `vehicle.${field}`,
    value: (row[field] ?? '').trim(),
    validAt: null,
    sourceId: 'fleet_master',
    sourceHash,
  }));
}

function upsertVehicle(db: Database, vehicleKey: string, fields: Map<string, ResolvedField>): void {
  const get = (field: string) => fields.get(field);
  db.query(
    `INSERT INTO vehicles
       (vehicle_key, vehicle_id, model, year, bs_stage, engine_heater, home_hub, capacity_tonnes,
        year_src, heater_src, capacity_src, hub_src)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vehicle_key) DO UPDATE SET
       vehicle_id = excluded.vehicle_id, model = excluded.model, year = excluded.year,
       bs_stage = excluded.bs_stage, engine_heater = excluded.engine_heater,
       home_hub = excluded.home_hub, capacity_tonnes = excluded.capacity_tonnes,
       year_src = excluded.year_src, heater_src = excluded.heater_src,
       capacity_src = excluded.capacity_src, hub_src = excluded.hub_src`,
  ).run(
    vehicleKey,
    get('vehicle.vehicle_id')?.value || null,
    get('vehicle.model')?.value || null,
    toInt(get('vehicle.year')?.value),
    get('vehicle.bs_stage')?.value || null,
    toTri(get('vehicle.engine_heater')?.value),
    get('vehicle.home_hub')?.value || null,
    toInt(get('vehicle.capacity_tonnes')?.value),
    get('vehicle.year')?.sourceHash ?? null,
    get('vehicle.engine_heater')?.sourceHash ?? null,
    get('vehicle.capacity_tonnes')?.sourceHash ?? null,
    get('vehicle.home_hub')?.sourceHash ?? null,
  );
}

function resolveVehicles(db: Database, observations: readonly Observation[]): void {
  const byVehicle = groupBy(
    observations.filter((o) => o.entityKind === 'vehicle'),
    (o) => o.entityKey,
  );

  for (const vehicleKey of [...byVehicle.keys()].sort()) {
    const obsForVehicle = byVehicle.get(vehicleKey) ?? [];
    const { fields, conflicts } = resolveEntity(obsForVehicle);
    upsertVehicle(db, vehicleKey, fields);
    conflicts.forEach((c) => insertConflict(db, c));
  }
}

export function ingestFleetMaster(db: Database, filePath: string): void {
  const observations: Observation[] = [];

  readFleetRows(filePath).forEach((row, index) => {
    const locator = `row:${index + 1}`;
    const record = buildRawRecord('fleet_master', filePath, locator, payloadFromRow(row));
    storeRawRecord(db, record);

    const plate = normalizePlate(row.registration_number ?? '');
    if (!plate.valid) {
      quarantineRecord(db, {
        sourceId: 'fleet_master',
        unit: filePath,
        locator,
        recordId: row.vehicle_id || null,
        payloadHash: record.contentHash,
        reasons: [{ field: 'registration_number', code: 'BAD_PLATE', detail: row.registration_number ?? '' }],
      });
      raiseAlert(db, 'UNRESOLVED_ENTITY', row.registration_number ?? '', 'fleet_master row could not be resolved to a vehicle');
      return;
    }

    observations.push(...fleetObservations(plate.key, row, record.contentHash));
  });

  observations.forEach((obs) => insertObservation(db, obs));
  resolveVehicles(db, observations);
}
