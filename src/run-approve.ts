import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openActionsDb } from './actions';
import { exportOutputs } from './export-outputs';
import { loadConfig } from './ingest';
import { pendingApprovals, recordApproval } from './pipeline/approve';

const config = loadConfig();
const actionsPath = join(config.stateDir, 'actions.db');
if (!existsSync(actionsPath)) {
  console.error(`No actions.db at ${actionsPath} - run \`bun run pipeline\` first.`);
  process.exit(1);
}

const actionsDb = openActionsDb(actionsPath);
const pending = pendingApprovals(actionsDb);

if (pending.length === 0) {
  console.log('Nothing pending approval.');
} else {
  for (const message of pending) {
    console.log(`\n--- ${message.ticketId} -> ${message.recipient} ---`);
    console.log(message.body);
    console.log(`Context: ${message.context}`);
    const decision = (prompt('Approve and send? [y/N] ') ?? '').trim().toLowerCase();
    if (decision === 'y') {
      const approvedBy = (prompt('Approved by: ') ?? '').trim() || 'unknown';
      recordApproval(actionsDb, message, approvedBy, config.referenceDate);
      console.log(`Sent (approved by ${approvedBy}).`);
    } else {
      console.log('Skipped - still pending.');
    }
  }
}

exportOutputs(actionsDb, join(config.dataRoot, 'outputs'), join(config.dataRoot, 'audit'));
actionsDb.close();
