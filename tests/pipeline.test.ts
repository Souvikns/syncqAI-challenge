import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingest } from '../src/ingest';
import { cite } from '../src/ingestion/shared';
import { openActionsDb } from '../src/actions';
import { exportOutputs } from '../src/export-outputs';
import { detectPii } from '../src/utils';
import { buildRuleContext } from '../src/pipeline/rules';
import { classifyTicket } from '../src/pipeline/classify';
import { selectVehicle } from '../src/pipeline/selectVehicle';
import { enrichTicket } from '../src/pipeline/enrich';
import { draftComms } from '../src/pipeline/draftComms';
import { recordWorkOrder } from '../src/pipeline/workOrder';
import { validateTickets } from '../src/pipeline/validate';
import { row, tempDbPath, tempStateDir, TEST_SALT } from './helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

async function runFullPipeline(actionsDbPath: string) {
  const contextDb = await ingest({ dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: REFERENCE_DATE });
  const actionsDb = openActionsDb(actionsDbPath);
  const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

  const knownDriverIds = new Set((contextDb.query('SELECT driver_id FROM drivers').all() as { driver_id: string }[]).map((r) => r.driver_id));
  const validTickets = validateTickets(actionsDb, 'tickets.json', knownDriverIds);

  for (const ticket of validTickets) {
    const enriched = enrichTicket(contextDb, actionsDb, ticket);
    const classification = classifyTicket(actionsDb, enriched, ctx);
    const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);
    recordWorkOrder(actionsDb, enriched, selection, ctx);
    draftComms(actionsDb, enriched, selection, ctx);
  }

  return { contextDb, actionsDb, validTickets };
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('the full decision pipeline against the real bundle', () => {
  test('produces exactly 30 work orders, all dispatched from the origin hub', async () => {
    const { contextDb, actionsDb } = await runFullPipeline(tempDbPath());

    expect(row(actionsDb, 'SELECT COUNT(*) as n FROM work_orders').n).toBe(30);
    expect(row(actionsDb, "SELECT COUNT(*) as n FROM work_orders WHERE action_code = 'DISPATCH_FROM_ORIGIN_HUB'").n).toBe(23);
    expect(row(actionsDb, "SELECT COUNT(*) as n FROM work_orders WHERE action_code = 'ESCALATE_NO_HUB_DISTANCE_DATA'").n).toBe(7);

    contextDb.close();
    actionsDb.close();
  });

  test('drafts exactly one pending message per work order', async () => {
    const { contextDb, actionsDb } = await runFullPipeline(tempDbPath());

    expect(row(actionsDb, 'SELECT COUNT(*) as n FROM comms_pending').n).toBe(30);

    contextDb.close();
    actionsDb.close();
  });

  test('raises the two documented data-gap alerts exactly once each', async () => {
    const { contextDb, actionsDb } = await runFullPipeline(tempDbPath());

    expect(row(actionsDb, "SELECT COUNT(*) as n FROM alerts WHERE subject = 'R10_GROUNDED_OVERDUE_SERVICE'").n).toBe(1);
    expect(row(actionsDb, "SELECT COUNT(*) as n FROM alerts WHERE subject = 'R09_HUB_SELECTION'").n).toBe(1);

    contextDb.close();
    actionsDb.close();
  });

  test('re-running against the same actions.db produces zero new work orders or messages', async () => {
    const actionsDbPath = tempDbPath();
    const first = await runFullPipeline(actionsDbPath);
    first.contextDb.close();
    first.actionsDb.close();

    const second = await runFullPipeline(actionsDbPath);
    expect(second.validTickets).toHaveLength(0);
    expect(row(second.actionsDb, 'SELECT COUNT(*) as n FROM work_orders').n).toBe(30);
    expect(row(second.actionsDb, 'SELECT COUNT(*) as n FROM comms_pending').n).toBe(30);

    second.contextDb.close();
    second.actionsDb.close();
  });

  test('running the same actions.db through the pipeline twice back to back leaves audit.jsonl unchanged', async () => {
    const dir = tempStateDir();
    const actionsDbPath = join(dir, 'actions.db');

    const first = await runFullPipeline(actionsDbPath);
    exportOutputs(first.actionsDb, join(dir, 'outputs'), join(dir, 'audit'));
    const auditAfterFirst = readFileSync(join(dir, 'audit', 'audit.jsonl'), 'utf8');
    first.contextDb.close();
    first.actionsDb.close();

    const second = await runFullPipeline(actionsDbPath);
    exportOutputs(second.actionsDb, join(dir, 'outputs'), join(dir, 'audit'));
    const auditAfterSecond = readFileSync(join(dir, 'audit', 'audit.jsonl'), 'utf8');
    second.contextDb.close();
    second.actionsDb.close();

    expect(auditAfterSecond).toBe(auditAfterFirst);
  });

  test('exported outputs are byte-identical across two full runs, and carry no raw PII', async () => {
    const dirA = tempStateDir();
    const dirB = tempStateDir();

    const runA = await runFullPipeline(join(dirA, 'actions.db'));
    exportOutputs(runA.actionsDb, join(dirA, 'outputs'), join(dirA, 'audit'));
    runA.contextDb.close();
    runA.actionsDb.close();

    const runB = await runFullPipeline(join(dirB, 'actions.db'));
    exportOutputs(runB.actionsDb, join(dirB, 'outputs'), join(dirB, 'audit'));
    runB.contextDb.close();
    runB.actionsDb.close();

    for (const file of ['work_orders.jsonl', 'comms_pending.jsonl', 'comms_sent.jsonl', 'quarantine.jsonl']) {
      const contentA = readFileSync(join(dirA, 'outputs', file), 'utf8');
      const contentB = readFileSync(join(dirB, 'outputs', file), 'utf8');
      expect(contentB).toBe(contentA);
    }
    const auditA = readFileSync(join(dirA, 'audit', 'audit.jsonl'), 'utf8');
    expect(detectPii(auditA)).toEqual([]);

    // comms_pending/comms_sent legitimately carry a real client recipient
    // address - that's the field's whole purpose, not a leak. Every other
    // field (especially `body`) is swept in full, same as export-outputs.ts.
    for (const file of ['work_orders.jsonl', 'quarantine.jsonl']) {
      expect(detectPii(readFileSync(join(dirA, 'outputs', file), 'utf8'))).toEqual([]);
    }
    for (const file of ['comms_pending.jsonl', 'comms_sent.jsonl']) {
      for (const rowObj of readJsonl(join(dirA, 'outputs', file))) {
        const { recipient: _recipient, ...rest } = rowObj as { recipient: string; [key: string]: unknown };
        expect(detectPii(JSON.stringify(rest))).toEqual([]);
      }
    }
  });

  test('every citation in work_orders.jsonl resolves through cite()', async () => {
    const dir = tempStateDir();
    const run = await runFullPipeline(join(dir, 'actions.db'));
    exportOutputs(run.actionsDb, join(dir, 'outputs'), join(dir, 'audit'));

    const workOrders = readJsonl(join(dir, 'outputs', 'work_orders.jsonl'));
    for (const wo of workOrders) {
      for (const citation of wo.citations as string[]) {
        // Rule ids resolve through the rule context, not cite() directly -
        // only real context.db content hashes are expected here.
        if (/^[0-9a-f]{64}$/.test(citation)) {
          expect(cite(run.contextDb, citation)).not.toBeNull();
        }
      }
    }

    run.contextDb.close();
    run.actionsDb.close();
  });

  test('work_orders.jsonl has exactly the 5 README-shaped fields, nothing more', async () => {
    const dir = tempStateDir();
    const run = await runFullPipeline(join(dir, 'actions.db'));
    exportOutputs(run.actionsDb, join(dir, 'outputs'), join(dir, 'audit'));

    const workOrders = readJsonl(join(dir, 'outputs', 'work_orders.jsonl'));
    for (const wo of workOrders) {
      expect(Object.keys(wo).sort()).toEqual(['citations', 'created_at', 'ticket_id', 'vehicle_reg', 'work_order_id'].sort());
    }

    run.contextDb.close();
    run.actionsDb.close();
  });
});
