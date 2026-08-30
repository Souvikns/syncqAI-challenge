import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ingest, openContextDb } from '../../src/ingest';
import { openActionsDb } from '../../src/actions';
import { buildRuleContext } from '../../src/pipeline/rules';
import { classifyTicket } from '../../src/pipeline/classify';
import { selectVehicle } from '../../src/pipeline/selectVehicle';
import type { EnrichedTicket } from '../../src/pipeline/enrich';
import type { ParsedTicket } from '../../src/pipeline/validate';
import { row, tempDbPath, tempStateDir, TEST_SALT } from '../helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

const BASE_TICKET: ParsedTicket = {
  ticketId: 'TKT-TEST',
  createdAt: '2026-08-11T19:00:00+05:30',
  vehicleKey: 'BROKEN0001',
  vehicleReg: 'BROKEN-0001',
  driverId: 'DRV-020',
  originHub: 'Lucknow',
  kmFromOriginHub: 20,
  destination: 'Lucknow',
  issue: 'fuel line leak',
  severity: 'HIGH',
  client: 'Shakti Cement',
  locator: 'row:0',
};

function enrichedFor(ticket: ParsedTicket, overrides: Partial<EnrichedTicket> = {}): EnrichedTicket {
  return {
    ticket,
    vehicle: null,
    vehicleState: null,
    driver: null,
    driverState: null,
    clientKey: 'shakti_cement',
    originHubKey: 'lucknow',
    destinationHubKey: 'lucknow',
    lastTripForClientVehicle: null,
    relevantMaintenanceHistory: [],
    ...overrides,
  };
}

interface FixtureVehicle {
  key: string;
  homeHub: string;
  bsStage?: string;
  engineHeater?: string;
  year?: number | null;
  lastBrakeWorkOn?: string | null;
  tempFixOn?: string | null;
  tempFixExpires?: string | null;
  grounded?: string;
}

function fixtureContextDb(vehicles: readonly FixtureVehicle[]): Database {
  const db = openContextDb(tempDbPath());
  for (const v of vehicles) {
    db.query(
      `INSERT INTO vehicles (vehicle_key, vehicle_id, model, year, bs_stage, engine_heater, home_hub, capacity_tonnes)
       VALUES (?, ?, 'Test Model', ?, ?, ?, ?, 10)`,
    ).run(v.key, v.key, v.year ?? 2022, v.bsStage ?? 'BS6', v.engineHeater ?? 'TRUE', v.homeHub);
    db.query(
      `INSERT INTO vehicle_state (vehicle_key, grounded, last_brake_work_on, temp_fix_on, temp_fix_expires, evidence)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run(v.key, v.grounded ?? 'UNKNOWN', v.lastBrakeWorkOn ?? null, v.tempFixOn ?? null, v.tempFixExpires ?? null);
  }
  return db;
}

async function ruleContextFor(contextDb: Database) {
  return buildRuleContext(contextDb, 'rules/rules.yaml');
}

describe('selectVehicle', () => {
  test('picks an eligible vehicle from the classified hub, never the broken one', () => {
    const contextDb = fixtureContextDb([
      { key: 'BROKEN0001', homeHub: 'lucknow' },
      { key: 'GOOD0001', homeHub: 'lucknow' },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const enriched = enrichedFor(BASE_TICKET);
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);

    expect(selection.actionCode).toBe('DISPATCH_FROM_ORIGIN_HUB');
    expect(selection.replacementVehicleKey).toBe('GOOD0001');
    expect(row(actionsDb, "SELECT COUNT(*) as n FROM vehicle_assignments WHERE vehicle_key = 'GOOD0001'").n).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('R01: excludes BS4 vehicles from Delhi/Gurgaon routes in winter', () => {
    const contextDb = fixtureContextDb([
      { key: 'BS4TRUCK01', homeHub: 'gurgaon', bsStage: 'BS4' },
      { key: 'BS6TRUCK01', homeHub: 'gurgaon', bsStage: 'BS6' },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const winterTicket = { ...BASE_TICKET, createdAt: '2026-02-21T04:00:00+05:30', originHub: 'Gurgaon' };
    const enriched = enrichedFor(winterTicket, { originHubKey: 'gurgaon', destinationHubKey: 'gurgaon' });
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);

    expect(selection.replacementVehicleKey).toBe('BS6TRUCK01');
    expect(
      row(actionsDb, "SELECT COUNT(*) as n FROM audit_log WHERE decision LIKE 'EXCLUDED BS4TRUCK01%' AND rule_id = 'R01_BS4_WINTER_NCR_BAN'").n,
    ).toBe(0); // not excluded when a BS6 vehicle already satisfies the pool - only logged on total escalation

    contextDb.close();
    actionsDb.close();
  });

  test('R01: escalates when every candidate is BS4 in winter on a Delhi/Gurgaon route', () => {
    const contextDb = fixtureContextDb([{ key: 'BS4ONLY001', homeHub: 'gurgaon', bsStage: 'BS4' }]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const winterTicket = { ...BASE_TICKET, createdAt: '2026-02-21T04:00:00+05:30', originHub: 'Gurgaon' };
    const enriched = enrichedFor(winterTicket, { originHubKey: 'gurgaon', destinationHubKey: 'gurgaon' });
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);

    expect(selection.actionCode).toBe('ESCALATE_NO_ELIGIBLE_VEHICLE');
    expect(selection.replacementVehicleKey).toBeNull();
    expect(
      row(actionsDb, "SELECT COUNT(*) as n FROM audit_log WHERE decision LIKE 'EXCLUDED BS4ONLY001%' AND rule_id = 'R01_BS4_WINTER_NCR_BAN'").n,
    ).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('R02/R03: hill routes in winter need a heater and no brake work in 30 days', () => {
    const contextDb = fixtureContextDb([
      { key: 'NOHEATER01', homeHub: 'rudrapur', engineHeater: 'FALSE' },
      { key: 'RECENTBRAKE01', homeHub: 'rudrapur', lastBrakeWorkOn: '2026-01-05T00:00:00+05:30' },
      { key: 'GOODHILL001', homeHub: 'rudrapur', lastBrakeWorkOn: '2025-11-01T00:00:00+05:30' },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const hillWinterTicket = { ...BASE_TICKET, createdAt: '2026-01-20T04:00:00+05:30', originHub: 'Rudrapur' };
    const enriched = enrichedFor(hillWinterTicket, { originHubKey: 'rudrapur', destinationHubKey: 'rudrapur' });
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);

    expect(selection.replacementVehicleKey).toBe('GOODHILL001');

    contextDb.close();
    actionsDb.close();
  });

  test('R07: Orion Pharma requires a 2020-or-later vehicle', () => {
    const contextDb = fixtureContextDb([
      { key: 'OLDTRUCK01', homeHub: 'lucknow', year: 2016 },
      { key: 'NEWTRUCK01', homeHub: 'lucknow', year: 2021 },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const orionTicket = { ...BASE_TICKET, client: 'Orion Pharma' };
    const enriched = enrichedFor(orionTicket, { clientKey: 'orion_pharma' });
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);

    expect(selection.replacementVehicleKey).toBe('NEWTRUCK01');

    contextDb.close();
    actionsDb.close();
  });

  test('not already assigned: a vehicle used for one ticket is unavailable for the next', () => {
    const contextDb = fixtureContextDb([
      { key: 'ONLYONE001', homeHub: 'lucknow' },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    const first = enrichedFor({ ...BASE_TICKET, ticketId: 'TKT-A', vehicleKey: 'BROKENA' });
    selectVehicle(contextDb, actionsDb, first, classifyTicket(actionsDb, first, ctx), ctx);

    const second = enrichedFor({ ...BASE_TICKET, ticketId: 'TKT-B', vehicleKey: 'BROKENB' });
    const secondSelection = selectVehicle(contextDb, actionsDb, second, classifyTicket(actionsDb, second, ctx), ctx);

    expect(secondSelection.actionCode).toBe('ESCALATE_NO_ELIGIBLE_VEHICLE');

    contextDb.close();
    actionsDb.close();
  });

  test('R06: Apex rotation - the flagged vehicle is skipped once, then eligible again', () => {
    const contextDb = fixtureContextDb([
      { key: 'APEXBROKEN01', homeHub: 'lucknow' },
      { key: 'APEXSPARE01', homeHub: 'lucknow' },
      { key: 'APEXSPARE02', homeHub: 'lucknow' },
    ]);
    const actionsDb = openActionsDb(tempDbPath());
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

    // Ticket 1: APEXBROKEN01 breaks down on an Apex run -> flagged, APEXSPARE01 dispatched.
    const t1 = enrichedFor({ ...BASE_TICKET, ticketId: 'TKT-APEX-1', vehicleKey: 'APEXBROKEN01', client: 'Apex Chemicals' }, {
      clientKey: 'apex_chemicals',
    });
    const s1 = selectVehicle(contextDb, actionsDb, t1, classifyTicket(actionsDb, t1, ctx), ctx);
    expect(s1.replacementVehicleKey).toBe('APEXSPARE01');
    expect(row(actionsDb, "SELECT COUNT(*) as n FROM apex_flags WHERE vehicle_key = 'APEXBROKEN01' AND cleared_at IS NULL").n).toBe(1);

    // Ticket 2: another Apex run breaks down elsewhere - APEXBROKEN01 must not be reselected
    // even though it's technically "not already assigned" (it wasn't dispatched, it broke down).
    contextDb.query(`INSERT INTO vehicles (vehicle_key, vehicle_id, model, year, bs_stage, engine_heater, home_hub, capacity_tonnes)
       VALUES ('APEXBROKEN01B', 'APEXBROKEN01B', 'Test Model', 2022, 'BS6', 'TRUE', 'lucknow', 10)`).run();
    contextDb.query(`INSERT INTO vehicle_state (vehicle_key, grounded, evidence) VALUES ('APEXBROKEN01B', 'UNKNOWN', '[]')`).run();

    const t2 = enrichedFor({ ...BASE_TICKET, ticketId: 'TKT-APEX-2', vehicleKey: 'APEXBROKEN01B', client: 'Apex Chemicals' }, {
      clientKey: 'apex_chemicals',
    });
    const s2 = selectVehicle(contextDb, actionsDb, t2, classifyTicket(actionsDb, t2, ctx), ctx);

    expect(s2.replacementVehicleKey).toBe('APEXSPARE02');
    expect(row(actionsDb, "SELECT cleared_at FROM apex_flags WHERE vehicle_key = 'APEXBROKEN01'").cleared_at).not.toBeNull();

    contextDb.close();
    actionsDb.close();
  });
});
