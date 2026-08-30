// Step 5: record exactly one work order, no matter how many times the
// ticket appears in the queue or how many times the pipeline reruns.

import type { Database } from 'bun:sqlite';
import { sha256Hex } from '../utils';
import { writeAuditRecord } from './audit';
import { vehicleCitations, type EnrichedTicket } from './enrich';
import { ruleCitationHashes, type RuleContext } from './rules';
import type { Selection } from './selectVehicle';

/** Every context.db fact and rule citation behind a decision - shared by
 * the work order itself and the client message drafted alongside it, so an
 * approver sees the exact same evidence the automation acted on. */
export function decisionCitations(enriched: EnrichedTicket, selection: Selection, ctx: RuleContext): string[] {
  return [
    ...new Set([
      ...vehicleCitations(enriched.vehicle),
      ...enriched.relevantMaintenanceHistory.map((e) => e.eventHash),
      ...ruleCitationHashes(ctx, selection.relevantRuleIds),
    ]),
  ].sort();
}

export function recordWorkOrder(actionsDb: Database, enriched: EnrichedTicket, selection: Selection, ctx: RuleContext): void {
  const workOrderId = sha256Hex('work_order' + enriched.ticket.ticketId);
  const citations = decisionCitations(enriched, selection, ctx);

  actionsDb
    .query(
      `INSERT OR IGNORE INTO work_orders
         (work_order_id, ticket_id, vehicle_reg, replacement_vehicle_key, action_code, created_at, citations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workOrderId,
      enriched.ticket.ticketId,
      enriched.ticket.vehicleReg,
      selection.replacementVehicleKey,
      selection.actionCode,
      enriched.ticket.createdAt,
      JSON.stringify(citations),
    );

  writeAuditRecord(actionsDb, {
    ticketId: enriched.ticket.ticketId,
    step: 'WORK_ORDER',
    decision: selection.actionCode,
    ruleId: null,
    citations: [],
    decidedBy: 'pipeline',
  });
}
