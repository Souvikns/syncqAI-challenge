import { describe, test, expect } from 'bun:test';
import { ingest, openContextDb } from '../../src/ingest';
import { cite } from '../../src/ingestion/shared';
import { enrichTicket } from '../../src/pipeline/enrich';
import { openActionsDb } from '../../src/actions';
import type { ParsedTicket } from '../../src/pipeline/validate';
import { row, tempDbPath, tempStateDir, TEST_SALT } from '../helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

async function realContextDb() {
  return ingest({ dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: REFERENCE_DATE });
}

// TKT-0027 straight from tickets.json: UP-40-IM-3144, DRV-020, Lucknow -> Lucknow, Shakti Cement.
const TKT_0027: ParsedTicket = {
  ticketId: 'TKT-0027',
  createdAt: '2026-08-11T19:00:00+05:30',
  vehicleKey: 'UP40IM3144',
  vehicleReg: 'UP-40-IM-3144',
  driverId: 'DRV-020',
  originHub: 'Lucknow',
  kmFromOriginHub: 20,
  destination: 'Lucknow',
  issue: 'fuel line leak',
  severity: 'HIGH',
  client: 'Shakti Cement',
  locator: 'row:0',
};

const UNKNOWN_VEHICLE_TICKET: ParsedTicket = {
  ...TKT_0027,
  ticketId: 'TKT-SYNTH-1',
  vehicleKey: 'ZZ99ZZ9999',
  vehicleReg: 'ZZ-99-ZZ-9999',
};

const UNKNOWN_CLIENT_TICKET: ParsedTicket = {
  ...TKT_0027,
  ticketId: 'TKT-SYNTH-2',
  client: 'Definitely Not A Real Client Ltd',
};

describe('enrichTicket', () => {
  test('resolves the vehicle, driver, client and hubs for a real ticket', async () => {
    const contextDb = await realContextDb();
    const actionsDb = openActionsDb(tempDbPath());

    const enriched = enrichTicket(contextDb, actionsDb, TKT_0027);

    expect(enriched.vehicle).not.toBeNull();
    expect(enriched.vehicle?.key).toBe('UP40IM3144');
    expect(enriched.vehicleState).not.toBeNull();
    expect(enriched.driver).not.toBeNull();
    expect(enriched.driver?.driverId).toBe('DRV-020');
    expect(enriched.driverState).not.toBeNull();
    expect(enriched.clientKey).toBe('shakti_cement');
    expect(enriched.originHubKey).toBe('lucknow');
    expect(enriched.destinationHubKey).toBe('lucknow');

    contextDb.close();
    actionsDb.close();
  });

  test('a vehicle absent from context.db enriches to null, not a crash', async () => {
    const contextDb = await realContextDb();
    const actionsDb = openActionsDb(tempDbPath());

    const enriched = enrichTicket(contextDb, actionsDb, UNKNOWN_VEHICLE_TICKET);

    expect(enriched.vehicle).toBeNull();
    expect(enriched.vehicleState).toBeNull();

    contextDb.close();
    actionsDb.close();
  });

  test('an unresolvable client name enriches to UNKNOWN, never invented', async () => {
    const contextDb = await realContextDb();
    const actionsDb = openActionsDb(tempDbPath());

    const enriched = enrichTicket(contextDb, actionsDb, UNKNOWN_CLIENT_TICKET);

    expect(enriched.clientKey).toBe('UNKNOWN');

    contextDb.close();
    actionsDb.close();
  });

  test('writes one ENRICH audit row per ticket, citing the vehicle facts it used', async () => {
    const contextDb = await realContextDb();
    const actionsDb = openActionsDb(tempDbPath());

    enrichTicket(contextDb, actionsDb, TKT_0027);

    expect(row(actionsDb, "SELECT COUNT(*) as n FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'ENRICH'").n).toBe(1);
    const auditRow = row(actionsDb, "SELECT citations FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'ENRICH'");
    const citations = JSON.parse(auditRow.citations) as string[];
    expect(citations.length).toBeGreaterThan(0);
    for (const hash of citations) expect(cite(contextDb, hash)).not.toBeNull();

    contextDb.close();
    actionsDb.close();
  });
});

describe('enrichTicket - maintenance history relevant to the failure', () => {
  function fixtureWithMaintenance(events: readonly { hash: string; occurredOn: string; note: string; concepts: readonly string[] }[]) {
    const contextDb = openContextDb(tempDbPath());
    contextDb
      .query(
        `INSERT INTO vehicles (vehicle_key, vehicle_id, model, year, bs_stage, engine_heater, home_hub, capacity_tonnes)
         VALUES ('UP40IM3144', 'UP40IM3144', 'Test Model', 2022, 'BS6', 'TRUE', 'Lucknow', 10)`,
      )
      .run();
    contextDb
      .query(`INSERT INTO vehicle_state (vehicle_key, grounded, evidence) VALUES ('UP40IM3144', 'UNKNOWN', '[]')`)
      .run();
    for (const e of events) {
      contextDb
        .query(
          `INSERT INTO maintenance_events (event_hash, vehicle_key, occurred_on, mechanic_token, note, concepts)
           VALUES (?, 'UP40IM3144', ?, '<PERSON:aaaaaa>', ?, ?)`,
        )
        .run(e.hash, e.occurredOn, e.note, JSON.stringify(e.concepts));
    }
    return contextDb;
  }

  test('surfaces past maintenance events whose concepts match the ticket issue', () => {
    const contextDb = fixtureWithMaintenance([
      { hash: 'clutchevent1', occurredOn: '2026-06-01T00:00:00+05:30', note: 'clutch slipping, replaced', concepts: ['clutch'] },
      { hash: 'brakeevent1', occurredOn: '2026-07-01T00:00:00+05:30', note: 'brake pad replaced', concepts: ['brake_work'] },
    ]);
    const actionsDb = openActionsDb(tempDbPath());

    const ticket = { ...TKT_0027, issue: 'clutch slipping' };
    const enriched = enrichTicket(contextDb, actionsDb, ticket);

    expect(enriched.relevantMaintenanceHistory.map((e) => e.eventHash)).toEqual(['clutchevent1']);

    contextDb.close();
    actionsDb.close();
  });

  test('is empty, not fabricated, when nothing in maintenance history matches the issue', () => {
    const contextDb = fixtureWithMaintenance([{ hash: 'brakeevent1', occurredOn: '2026-07-01T00:00:00+05:30', note: 'brake pad replaced', concepts: ['brake_work'] }]);
    const actionsDb = openActionsDb(tempDbPath());

    const ticket = { ...TKT_0027, issue: 'clutch slipping' };
    const enriched = enrichTicket(contextDb, actionsDb, ticket);

    expect(enriched.relevantMaintenanceHistory).toEqual([]);

    contextDb.close();
    actionsDb.close();
  });

  test('cites every relevant maintenance event through cite()', () => {
    const contextDb = fixtureWithMaintenance([{ hash: 'clutchevent1', occurredOn: '2026-06-01T00:00:00+05:30', note: 'clutch slipping, replaced', concepts: ['clutch'] }]);
    const actionsDb = openActionsDb(tempDbPath());
    contextDb.query(`INSERT INTO source_records (content_hash, source_id, payload) VALUES ('clutchevent1', 'maintenance_log', '{}')`).run();
    contextDb.query(`INSERT INTO record_locations (content_hash, unit, locator) VALUES ('clutchevent1', 'maintenance_log.xlsx', 'sheet1:row:1')`).run();

    const ticket = { ...TKT_0027, issue: 'clutch slipping' };
    const enriched = enrichTicket(contextDb, actionsDb, ticket);

    expect(enriched.relevantMaintenanceHistory).toHaveLength(1);
    expect(cite(contextDb, enriched.relevantMaintenanceHistory[0]!.eventHash)).not.toBeNull();

    const auditRow = row(actionsDb, "SELECT citations FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'ENRICH'");
    expect(JSON.parse(auditRow.citations)).toContain('clutchevent1');

    contextDb.close();
    actionsDb.close();
  });
});
