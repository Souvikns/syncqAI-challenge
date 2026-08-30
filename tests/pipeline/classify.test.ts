import { describe, test, expect } from 'bun:test';
import { ingest } from '../../src/ingest';
import { openActionsDb } from '../../src/actions';
import { buildRuleContext } from '../../src/pipeline/rules';
import { classifyTicket } from '../../src/pipeline/classify';
import type { EnrichedTicket } from '../../src/pipeline/enrich';
import type { ParsedTicket } from '../../src/pipeline/validate';
import { row, tempDbPath, tempStateDir, TEST_SALT } from '../helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

const BASE_TICKET: ParsedTicket = {
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

async function ruleContext() {
  const contextDb = await ingest({ dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: REFERENCE_DATE });
  return { contextDb, ctx: buildRuleContext(contextDb, 'rules/rules.yaml') };
}

describe('classifyTicket', () => {
  test('a ticket within 50km dispatches from the origin hub', async () => {
    const { contextDb, ctx } = await ruleContext();
    const actionsDb = openActionsDb(tempDbPath());

    const classification = classifyTicket(actionsDb, enrichedFor(BASE_TICKET), ctx);

    expect(classification.actionCode).toBe('DISPATCH_FROM_ORIGIN_HUB');
    expect(classification.hubKey).toBe('lucknow');

    contextDb.close();
    actionsDb.close();
  });

  test('a ticket beyond 50km cannot be classified to a hub - no distance data', async () => {
    const { contextDb, ctx } = await ruleContext();
    const actionsDb = openActionsDb(tempDbPath());

    const farTicket = { ...BASE_TICKET, ticketId: 'TKT-0029', kmFromOriginHub: 586 };
    const classification = classifyTicket(actionsDb, enrichedFor(farTicket), ctx);

    expect(classification.actionCode).toBe('ESCALATE_NO_HUB_DISTANCE_DATA');
    expect(classification.hubKey).toBeNull();

    contextDb.close();
    actionsDb.close();
  });

  test('writes an audit row citing R09_HUB_SELECTION', async () => {
    const { contextDb, ctx } = await ruleContext();
    const actionsDb = openActionsDb(tempDbPath());

    classifyTicket(actionsDb, enrichedFor(BASE_TICKET), ctx);

    const auditRow = row(actionsDb, "SELECT rule_id, citations FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'CLASSIFY' AND rule_id = 'R09_HUB_SELECTION'");
    expect(auditRow.rule_id).toBe('R09_HUB_SELECTION');
    expect(JSON.parse(auditRow.citations).length).toBeGreaterThan(0);

    contextDb.close();
    actionsDb.close();
  });

  test('flags the new-driver night-solo policy exception without blocking dispatch', async () => {
    const { contextDb, ctx } = await ruleContext();
    const actionsDb = openActionsDb(tempDbPath());

    const nightTicket = { ...BASE_TICKET, createdAt: '2026-08-11T22:00:00+05:30' };
    const enriched = enrichedFor(nightTicket, { driverState: { tenureDays: 30, nightSoloOk: 'UNKNOWN' } });
    const classification = classifyTicket(actionsDb, enriched, ctx);

    expect(classification.policyExceptionFlagged).toBe(true);
    expect(classification.actionCode).toBe('DISPATCH_FROM_ORIGIN_HUB');
    expect(
      row(actionsDb, "SELECT COUNT(*) as n FROM audit_log WHERE ticket_id = 'TKT-0027' AND rule_id = 'R12_NEW_DRIVER_NIGHT_SOLO'").n,
    ).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('does not flag a tenured driver, or a new driver on a day run', async () => {
    const { contextDb, ctx } = await ruleContext();
    const actionsDb = openActionsDb(tempDbPath());

    const tenured = enrichedFor(BASE_TICKET, { driverState: { tenureDays: 400, nightSoloOk: 'TRUE' } });
    expect(classifyTicket(actionsDb, tenured, ctx).policyExceptionFlagged).toBe(false);

    const dayRunNewDriver = enrichedFor(BASE_TICKET, { driverState: { tenureDays: 30, nightSoloOk: 'UNKNOWN' } });
    expect(classifyTicket(actionsDb, dayRunNewDriver, ctx).policyExceptionFlagged).toBe(false);

    contextDb.close();
    actionsDb.close();
  });
});
