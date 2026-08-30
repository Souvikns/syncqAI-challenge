import { describe, test, expect } from 'bun:test';
import { ingest } from '../../src/ingest';
import { cite } from '../../src/ingestion/shared';
import { openActionsDb } from '../../src/actions';
import { buildRuleContext } from '../../src/pipeline/rules';
import { classifyTicket } from '../../src/pipeline/classify';
import { selectVehicle } from '../../src/pipeline/selectVehicle';
import { enrichTicket } from '../../src/pipeline/enrich';
import { recordWorkOrder } from '../../src/pipeline/workOrder';
import type { ParsedTicket } from '../../src/pipeline/validate';
import { row, tempDbPath, tempStateDir, TEST_SALT } from '../helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

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

async function processTicket(ticket: ParsedTicket) {
  const contextDb = await ingest({ dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: REFERENCE_DATE });
  const actionsDb = openActionsDb(tempDbPath());
  const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

  const enriched = enrichTicket(contextDb, actionsDb, ticket);
  const classification = classifyTicket(actionsDb, enriched, ctx);
  const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);
  recordWorkOrder(actionsDb, enriched, selection, ctx);

  return { contextDb, actionsDb };
}

describe('recordWorkOrder', () => {
  test('records exactly one work order with the README-shaped fields', async () => {
    const { contextDb, actionsDb } = await processTicket(TKT_0027);

    const wo = row(actionsDb, "SELECT * FROM work_orders WHERE ticket_id = 'TKT-0027'");
    expect(wo.ticket_id).toBe('TKT-0027');
    expect(wo.vehicle_reg).toBe('UP-40-IM-3144');
    expect(wo.created_at).toBe('2026-08-11T19:00:00+05:30');
    expect(wo.action_code).toBe('DISPATCH_FROM_ORIGIN_HUB');
    expect(wo.replacement_vehicle_key).not.toBeNull();

    const citations = JSON.parse(wo.citations) as string[];
    expect(citations.length).toBeGreaterThan(0);
    for (const hash of citations) expect(cite(contextDb, hash)).not.toBeNull();

    contextDb.close();
    actionsDb.close();
  });

  test('is idempotent - recording the same ticket twice does not duplicate the work order', async () => {
    const { contextDb, actionsDb } = await processTicket(TKT_0027);
    const enriched = enrichTicket(contextDb, actionsDb, TKT_0027);
    const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);
    recordWorkOrder(actionsDb, enriched, selection, ctx);

    expect(row(actionsDb, "SELECT COUNT(*) as n FROM work_orders WHERE ticket_id = 'TKT-0027'").n).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('writes a WORK_ORDER audit row restating the action code', async () => {
    const { contextDb, actionsDb } = await processTicket(TKT_0027);

    const auditRow = row(actionsDb, "SELECT decision FROM audit_log WHERE ticket_id = 'TKT-0027' AND step = 'WORK_ORDER'");
    expect(auditRow.decision).toBe('DISPATCH_FROM_ORIGIN_HUB');

    contextDb.close();
    actionsDb.close();
  });
});
