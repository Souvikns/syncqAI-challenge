import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openActionsDb } from './actions';
import { exportOutputs } from './export-outputs';
import { loadConfig, openContextDb } from './ingest';
import { classifyTicket } from './pipeline/classify';
import { draftComms } from './pipeline/draftComms';
import { enrichTicket } from './pipeline/enrich';
import { buildRuleContext } from './pipeline/rules';
import { selectVehicle } from './pipeline/selectVehicle';
import { validateTickets } from './pipeline/validate';
import { recordWorkOrder } from './pipeline/workOrder';

function queuePathFrom(argv: readonly string[], defaultPath: string): string {
  const flagIndex = argv.indexOf('--queue');
  if (flagIndex === -1) return defaultPath;
  const value = argv[flagIndex + 1];
  if (!value) throw new Error('--queue requires a file path');
  return value;
}

const config = loadConfig();
const contextDbPath = join(config.stateDir, 'context.db');
if (!existsSync(contextDbPath)) {
  console.error(`No context.db at ${contextDbPath} - run \`bun run ingest\` first.`);
  process.exit(1);
}

const queuePath = queuePathFrom(process.argv, join(config.dataRoot, 'tickets.json'));

const contextDb = openContextDb(contextDbPath);
const actionsDb = openActionsDb(join(config.stateDir, 'actions.db'));
const ctx = buildRuleContext(contextDb, 'rules/rules.yaml');

const knownDriverIds = new Set(
  (contextDb.query('SELECT driver_id FROM drivers').all() as { driver_id: string }[]).map((r) => r.driver_id),
);

const validTickets = validateTickets(actionsDb, queuePath, knownDriverIds);

for (const ticket of validTickets) {
  const enriched = enrichTicket(contextDb, actionsDb, ticket);
  const classification = classifyTicket(actionsDb, enriched, ctx);
  const selection = selectVehicle(contextDb, actionsDb, enriched, classification, ctx);
  recordWorkOrder(actionsDb, enriched, selection, ctx);
  draftComms(actionsDb, enriched, selection, ctx);
}

exportOutputs(actionsDb, join(config.dataRoot, 'outputs'), join(config.dataRoot, 'audit'));

const countOf = (table: string) => (actionsDb.query(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
const countWhere = (sql: string) => (actionsDb.query(sql).get() as { n: number }).n;

console.log(`Processed ${queuePath}`);
console.log(`  tickets seen:          ${countOf('processed_tickets')}`);
console.log(`  quarantined:           ${countOf('quarantine')}`);
console.log(`  processed this run:    ${validTickets.length}`);
console.log(`  work orders:           ${countOf('work_orders')}`);
console.log(`    dispatched:          ${countWhere("SELECT COUNT(*) as n FROM work_orders WHERE action_code = 'DISPATCH_FROM_ORIGIN_HUB'")}`);
console.log(`    escalated:           ${countWhere("SELECT COUNT(*) as n FROM work_orders WHERE action_code != 'DISPATCH_FROM_ORIGIN_HUB'")}`);
console.log(`  comms drafted:         ${countOf('comms_pending')}`);
console.log(`  alerts:                ${countOf('alerts')}`);
console.log(`Wrote outputs/*.jsonl and audit/audit.jsonl under ${config.dataRoot}`);

contextDb.close();
actionsDb.close();
