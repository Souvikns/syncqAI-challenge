// Step 3: decide which hub the replacement comes from (R09), and flag - but
// never block on - the new-driver night-solo policy exception (R12).

import type { Database } from 'bun:sqlite';
import { raiseAlert } from '../ingestion/shared';
import { writeAuditRecord } from './audit';
import type { EnrichedTicket } from './enrich';
import { findRule, ruleCitationHashes, type RuleContext } from './rules';
import { isNightRun } from './seasons';

export type ActionCode = 'DISPATCH_FROM_ORIGIN_HUB' | 'ESCALATE_NO_HUB_DISTANCE_DATA' | 'ESCALATE_NO_ELIGIBLE_VEHICLE';

export interface Classification {
  readonly actionCode: ActionCode;
  readonly hubKey: string | null;
  readonly policyExceptionFlagged: boolean;
}

function decideHub(actionsDb: Database, enriched: EnrichedTicket, kmThreshold: number): { actionCode: ActionCode; hubKey: string | null } {
  if (enriched.originHubKey === 'UNKNOWN') {
    raiseAlert(
      actionsDb,
      'UNRESOLVED_ENTITY',
      'origin_hub',
      `ticket ${enriched.ticket.ticketId}: origin hub "${enriched.ticket.originHub}" does not resolve to a known hub`,
    );
    return { actionCode: 'ESCALATE_NO_HUB_DISTANCE_DATA', hubKey: null };
  }
  if (enriched.ticket.kmFromOriginHub <= kmThreshold) {
    return { actionCode: 'DISPATCH_FROM_ORIGIN_HUB', hubKey: enriched.originHubKey };
  }
  // R09's "nearest hub" branch is not computable: no hub-to-hub distance
  // data exists anywhere in the bundle (03-decision-pipeline.md §6).
  raiseAlert(
    actionsDb,
    'SCHEMA',
    'R09_HUB_SELECTION',
    'no hub-to-hub distance data exists anywhere in the bundle; the >50km "nearest hub" branch cannot be computed',
  );
  return { actionCode: 'ESCALATE_NO_HUB_DISTANCE_DATA', hubKey: null };
}

function isPolicyException(enriched: EnrichedTicket, tenureThresholdDays: number, nightWindow: { start_hour: number; end_hour: number }): boolean {
  const tenureDays = enriched.driverState?.tenureDays ?? null;
  if (tenureDays === null || tenureDays >= tenureThresholdDays) return false;
  return isNightRun(enriched.ticket.createdAt, nightWindow);
}

export function classifyTicket(actionsDb: Database, enriched: EnrichedTicket, ctx: RuleContext): Classification {
  const hubRule = findRule(ctx.rules, 'R09_HUB_SELECTION');
  const { actionCode, hubKey } = decideHub(actionsDb, enriched, hubRule.km_threshold as number);

  writeAuditRecord(actionsDb, {
    ticketId: enriched.ticket.ticketId,
    step: 'CLASSIFY',
    decision: actionCode,
    ruleId: hubRule.id,
    citations: ruleCitationHashes(ctx, [hubRule.id]),
    decidedBy: 'pipeline',
  });

  const nightSoloRule = findRule(ctx.rules, 'R12_NEW_DRIVER_NIGHT_SOLO');
  const policyExceptionFlagged = isPolicyException(
    enriched,
    nightSoloRule.tenure_threshold_days as number,
    nightSoloRule.night_window as { start_hour: number; end_hour: number },
  );

  if (policyExceptionFlagged) {
    writeAuditRecord(actionsDb, {
      ticketId: enriched.ticket.ticketId,
      step: 'CLASSIFY',
      decision: 'POLICY_EXCEPTION_FLAGGED: new driver, night solo dispatch',
      ruleId: nightSoloRule.id,
      citations: ruleCitationHashes(ctx, [nightSoloRule.id]),
      decidedBy: 'pipeline',
    });
  }

  return { actionCode, hubKey, policyExceptionFlagged };
}
