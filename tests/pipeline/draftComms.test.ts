import { describe, test, expect } from 'bun:test';
import { openActionsDb } from '../../src/actions';
import { openContextDb } from '../../src/ingest';
import { detectPii } from '../../src/utils';
import { buildRuleContext } from '../../src/pipeline/rules';
import { draftComms } from '../../src/pipeline/draftComms';
import type { EnrichedTicket } from '../../src/pipeline/enrich';
import type { Selection } from '../../src/pipeline/selectVehicle';
import type { ParsedTicket } from '../../src/pipeline/validate';
import { row, tempDbPath } from '../helpers';

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

const DISPATCHED: Selection = { actionCode: 'DISPATCH_FROM_ORIGIN_HUB', replacementVehicleKey: 'UP99ZZ9999', relevantRuleIds: ['R09_HUB_SELECTION'] };
const ESCALATED: Selection = { actionCode: 'ESCALATE_NO_ELIGIBLE_VEHICLE', replacementVehicleKey: null, relevantRuleIds: ['R09_HUB_SELECTION'] };

function ctxAndDb() {
  const contextDb = openContextDb(tempDbPath());
  return { contextDb, ctx: buildRuleContext(contextDb, 'rules/rules.yaml') };
}

describe('draftComms', () => {
  test('drafts a message to the client with full context for the approver', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    draftComms(actionsDb, enrichedFor(TKT_0027), DISPATCHED, ctx);

    const pending = row(actionsDb, "SELECT * FROM comms_pending WHERE ticket_id = 'TKT-0027'");
    expect(pending.recipient).toBe('dispatch@shakticement.example.in');
    expect(pending.body.length).toBeGreaterThan(0);
    const context = JSON.parse(pending.context);
    expect(context.ticketId).toBe('TKT-0027');
    expect(Array.isArray(context.citations)).toBe(true);
    expect(detectPii(pending.body)).toEqual([]);

    contextDb.close();
    actionsDb.close();
  });

  test('an escalated ticket is disclosed honestly, not described as dispatched', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    draftComms(actionsDb, enrichedFor(TKT_0027), ESCALATED, ctx);

    const pending = row(actionsDb, "SELECT body FROM comms_pending WHERE ticket_id = 'TKT-0027'");
    expect(pending.body.toLowerCase()).not.toContain('dispatched');
    expect(pending.body.toLowerCase()).toContain('review');

    contextDb.close();
    actionsDb.close();
  });

  test('R04: a Shakti message states the 36-hour SLA, not the 48-hour contract figure', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    draftComms(actionsDb, enrichedFor(TKT_0027), DISPATCHED, ctx);

    const pending = row(actionsDb, "SELECT body FROM comms_pending WHERE ticket_id = 'TKT-0027'");
    expect(pending.body).toContain('36');
    expect(pending.body).not.toContain('48 hour');

    contextDb.close();
    actionsDb.close();
  });

  test('R05: a Vertex/Ludhiana message discloses the 6pm policy without claiming failure', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    const vertexTicket = { ...TKT_0027, ticketId: 'TKT-0022', client: 'Vertex Retail', destination: 'Ludhiana' };
    const enriched = enrichedFor(vertexTicket, { clientKey: 'vertex_retail', destinationHubKey: 'ludhiana' });
    draftComms(actionsDb, enriched, DISPATCHED, ctx);

    const pending = row(actionsDb, "SELECT body FROM comms_pending WHERE ticket_id = 'TKT-0022'");
    expect(pending.body.toLowerCase()).not.toContain('failed');
    expect(pending.body.toLowerCase()).toContain('morning');

    contextDb.close();
    actionsDb.close();
  });

  test('R05 does not apply to a Vertex ticket not headed to Ludhiana', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    const vertexTicket = { ...TKT_0027, ticketId: 'TKT-VERTEX-DELHI', client: 'Vertex Retail', destination: 'Delhi' };
    const enriched = enrichedFor(vertexTicket, { clientKey: 'vertex_retail', destinationHubKey: 'delhi' });
    draftComms(actionsDb, enriched, DISPATCHED, ctx);

    const pending = row(actionsDb, "SELECT body FROM comms_pending WHERE ticket_id = 'TKT-VERTEX-DELHI'");
    expect(pending.body.toLowerCase()).not.toContain('morning');

    contextDb.close();
    actionsDb.close();
  });

  test('R08: monsoon eastern-route padding is wired but correctly never fires on this hub vocabulary', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    // Every real destination is west/north of Lucknow (03-decision-pipeline.md §2) -
    // R08's hub list is intentionally empty, so even a monsoon-month ticket never pads.
    const monsoonTicket = { ...TKT_0027, ticketId: 'TKT-MONSOON', createdAt: '2026-08-05T10:00:00+05:30' };
    draftComms(actionsDb, enrichedFor(monsoonTicket), DISPATCHED, ctx);

    const pending = row(actionsDb, "SELECT body FROM comms_pending WHERE ticket_id = 'TKT-MONSOON'");
    expect(pending.body.toLowerCase()).not.toContain('padded');

    contextDb.close();
    actionsDb.close();
  });

  test('is idempotent - one draft per ticket', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    draftComms(actionsDb, enrichedFor(TKT_0027), DISPATCHED, ctx);
    draftComms(actionsDb, enrichedFor(TKT_0027), DISPATCHED, ctx);

    expect(row(actionsDb, "SELECT COUNT(*) as n FROM comms_pending WHERE ticket_id = 'TKT-0027'").n).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('writes a DRAFT_COMMS audit row', () => {
    const { contextDb, ctx } = ctxAndDb();
    const actionsDb = openActionsDb(tempDbPath());

    draftComms(actionsDb, enrichedFor(TKT_0027), DISPATCHED, ctx);

    expect(row(actionsDb, "SELECT COUNT(*) as n FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'DRAFT_COMMS'").n).toBe(1);

    contextDb.close();
    actionsDb.close();
  });
});
