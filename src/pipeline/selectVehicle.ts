// Step 4: pick a genuinely eligible replacement vehicle from the hub Step 3
// chose. Filters are declared as data (rules.yaml) wherever a rule drives
// them; "not already assigned" and Apex rotation are this codebase's own
// bookkeeping, not a dispatcher rule, and are labelled as such in the audit.

import type { Database } from 'bun:sqlite';
import { raiseAlert } from '../ingestion/shared';
import { daysBetween } from '../utils';
import { writeAuditRecord } from './audit';
import type { ActionCode, Classification } from './classify';
import type { EnrichedTicket } from './enrich';
import { findRule, ruleCitationHashes, type RuleContext } from './rules';
import { monthInSet, routeTouchesHubs } from './seasons';

export interface Selection {
  readonly actionCode: ActionCode;
  readonly replacementVehicleKey: string | null;
  readonly relevantRuleIds: readonly string[];
}

interface Candidate {
  readonly vehicleKey: string;
  readonly bsStage: string | null;
  readonly engineHeater: string;
  readonly year: number | null;
  readonly homeHub: string | null;
  readonly grounded: string | null;
  readonly lastBrakeWorkOn: string | null;
  readonly tempFixExpires: string | null;
}

interface Exclusion {
  readonly vehicleKey: string;
  readonly ruleId: string;
  readonly reason: string;
}

function candidatePool(contextDb: Database, hubKey: string, ownVehicleKey: string): Candidate[] {
  return contextDb
    .query(
      `SELECT v.vehicle_key as vehicleKey, v.bs_stage as bsStage, v.engine_heater as engineHeater,
              v.year, v.home_hub as homeHub, vs.grounded, vs.last_brake_work_on as lastBrakeWorkOn,
              vs.temp_fix_expires as tempFixExpires
       FROM vehicles v LEFT JOIN vehicle_state vs ON vs.vehicle_key = v.vehicle_key
       WHERE LOWER(v.home_hub) = ? AND v.vehicle_key != ?
       ORDER BY v.vehicle_key`,
    )
    .all(hubKey, ownVehicleKey) as Candidate[];
}

function alreadyAssignedKeys(actionsDb: Database): Set<string> {
  const rows = actionsDb.query('SELECT vehicle_key as vehicleKey FROM vehicle_assignments').all() as { vehicleKey: string }[];
  return new Set(rows.map((r) => r.vehicleKey));
}

function flaggedApexKeys(actionsDb: Database): Set<string> {
  const rows = actionsDb.query("SELECT vehicle_key as vehicleKey FROM apex_flags WHERE cleared_at IS NULL").all() as { vehicleKey: string }[];
  return new Set(rows.map((r) => r.vehicleKey));
}

function filterCandidates(
  candidates: readonly Candidate[],
  enriched: EnrichedTicket,
  hubKey: string,
  ctx: RuleContext,
  assigned: ReadonlySet<string>,
  apexFlagged: ReadonlySet<string>,
): { survivors: Candidate[]; exclusions: Exclusion[]; relevantRuleIds: string[] } {
  const r01 = findRule(ctx.rules, 'R01_BS4_WINTER_NCR_BAN');
  const r02 = findRule(ctx.rules, 'R02_HILL_HEATER');
  const r03 = findRule(ctx.rules, 'R03_HILL_BRAKE_COOLDOWN');
  const r07 = findRule(ctx.rules, 'R07_ORION_VEHICLE_AGE');
  const r11 = findRule(ctx.rules, 'R11_JUGAAD_7DAY_HOME_REGION');

  const ticketDate = enriched.ticket.createdAt;
  const routeHubs = [enriched.originHubKey, enriched.destinationHubKey];
  const r01Applies = monthInSet(ticketDate, r01.months ?? []) && routeTouchesHubs(routeHubs, r01.hubs ?? []);
  const r02Applies = monthInSet(ticketDate, r02.months ?? []) && routeTouchesHubs(routeHubs, r02.hubs ?? []);
  const r03Applies = monthInSet(ticketDate, r03.months ?? []) && routeTouchesHubs(routeHubs, r03.hubs ?? []);
  const r07Applies = enriched.clientKey === r07.client;

  const exclusions: Exclusion[] = [];
  const exclude = (vehicleKey: string, ruleId: string, reason: string) => exclusions.push({ vehicleKey, ruleId, reason });

  const survivors = candidates.filter((c) => {
    if (assigned.has(c.vehicleKey)) return exclude(c.vehicleKey, 'NOT_ALREADY_ASSIGNED', 'already assigned to another ticket'), false;
    if (r01Applies && c.bsStage !== r01.requires_bs_stage) return exclude(c.vehicleKey, r01.id, `bs_stage ${c.bsStage ?? 'UNKNOWN'}`), false;
    if (r02Applies && c.engineHeater !== 'TRUE') return exclude(c.vehicleKey, r02.id, `engine_heater ${c.engineHeater}`), false;
    if (r03Applies && c.lastBrakeWorkOn !== null && daysBetween(c.lastBrakeWorkOn, ticketDate) < (r03.brake_cooldown_days as number)) {
      return exclude(c.vehicleKey, r03.id, `brake work ${daysBetween(c.lastBrakeWorkOn, ticketDate)} days ago`), false;
    }
    if (r07Applies && (c.year === null || c.year < (r07.min_year as number))) return exclude(c.vehicleKey, r07.id, `year ${c.year ?? 'UNKNOWN'}`), false;
    // Currently a structural no-op: the candidate pool is already filtered to
    // this hub's own fleet, so home_hub === hubKey always holds. Kept so a
    // future nearest-hub selection (once hub-distance data exists) inherits
    // this filter for free.
    if (c.tempFixExpires !== null && ticketDate <= c.tempFixExpires && c.homeHub !== hubKey) {
      return exclude(c.vehicleKey, r11.id, 'under the 7-day jugaad restriction, outside its home region'), false;
    }
    if (apexFlagged.has(c.vehicleKey)) return exclude(c.vehicleKey, 'R06_APEX_ROTATION', 'flagged for Apex rotation'), false;
    return true;
  });

  const relevantRuleIds = [
    'R09_HUB_SELECTION',
    ...(r01Applies ? [r01.id] : []),
    ...(r02Applies ? [r02.id] : []),
    ...(r03Applies ? [r03.id] : []),
    ...(r07Applies ? [r07.id] : []),
    ...(apexFlagged.size > 0 || enriched.clientKey === 'apex_chemicals' ? ['R06_APEX_ROTATION'] : []),
  ];

  return { survivors, exclusions, relevantRuleIds };
}

function recordAssignment(actionsDb: Database, vehicleKey: string, ticketId: string, clientKey: string, assignedAt: string): void {
  actionsDb
    .query('INSERT OR IGNORE INTO vehicle_assignments (vehicle_key, ticket_id, client_key, assigned_at) VALUES (?, ?, ?, ?)')
    .run(vehicleKey, ticketId, clientKey, assignedAt);
}

/** R06: this ticket's own broken vehicle just had "an issue on an Apex run" - flag it,
 * then clear the oldest still-flagged vehicle now that one Apex dispatch has passed it over. */
function applyApexRotation(actionsDb: Database, brokenVehicleKey: string, chosenVehicleKey: string, ticketDate: string): void {
  actionsDb.query('INSERT OR IGNORE INTO apex_flags (vehicle_key, flagged_at, cleared_at) VALUES (?, ?, NULL)').run(brokenVehicleKey, ticketDate);

  const oldestFlagged = actionsDb
    .query(
      'SELECT vehicle_key as vehicleKey FROM apex_flags WHERE cleared_at IS NULL AND vehicle_key NOT IN (?, ?) ORDER BY flagged_at, vehicle_key LIMIT 1',
    )
    .get(chosenVehicleKey, brokenVehicleKey) as { vehicleKey: string } | null;
  if (oldestFlagged) {
    actionsDb.query('UPDATE apex_flags SET cleared_at = ? WHERE vehicle_key = ?').run(ticketDate, oldestFlagged.vehicleKey);
  }
}

export function selectVehicle(
  contextDb: Database,
  actionsDb: Database,
  enriched: EnrichedTicket,
  classification: Classification,
  ctx: RuleContext,
): Selection {
  if (classification.hubKey === null) {
    return { actionCode: classification.actionCode, replacementVehicleKey: null, relevantRuleIds: ['R09_HUB_SELECTION'] };
  }
  const hubKey = classification.hubKey;

  const candidates = candidatePool(contextDb, hubKey, enriched.ticket.vehicleKey);
  if (candidates.some((c) => c.grounded === 'UNKNOWN')) {
    raiseAlert(
      actionsDb,
      'SCHEMA',
      'R10_GROUNDED_OVERDUE_SERVICE',
      'grounded is UNKNOWN for every vehicle - no service-due date exists anywhere in the bundle; R10 cannot exclude on this data',
    );
  }

  const assigned = alreadyAssignedKeys(actionsDb);
  const apexFlagged = enriched.clientKey === 'apex_chemicals' ? flaggedApexKeys(actionsDb) : new Set<string>();
  const { survivors, exclusions, relevantRuleIds } = filterCandidates(candidates, enriched, hubKey, ctx, assigned, apexFlagged);
  const chosen = survivors[0] ?? null;

  if (chosen) {
    recordAssignment(actionsDb, chosen.vehicleKey, enriched.ticket.ticketId, enriched.clientKey, enriched.ticket.createdAt);
    if (enriched.clientKey === 'apex_chemicals') {
      applyApexRotation(actionsDb, enriched.ticket.vehicleKey, chosen.vehicleKey, enriched.ticket.createdAt);
    }
    writeAuditRecord(actionsDb, {
      ticketId: enriched.ticket.ticketId,
      step: 'SELECT',
      decision: `SELECTED ${chosen.vehicleKey}`,
      ruleId: null,
      citations: [],
      decidedBy: 'pipeline',
    });
    return { actionCode: classification.actionCode, replacementVehicleKey: chosen.vehicleKey, relevantRuleIds };
  }

  for (const exclusion of exclusions) {
    writeAuditRecord(actionsDb, {
      ticketId: enriched.ticket.ticketId,
      step: 'SELECT',
      decision: `EXCLUDED ${exclusion.vehicleKey}: ${exclusion.reason}`,
      ruleId: exclusion.ruleId,
      citations: ruleCitationHashes(ctx, [exclusion.ruleId]),
      decidedBy: 'pipeline',
    });
  }
  writeAuditRecord(actionsDb, {
    ticketId: enriched.ticket.ticketId,
    step: 'SELECT',
    decision: 'ESCALATE_NO_ELIGIBLE_VEHICLE',
    ruleId: null,
    citations: [],
    decidedBy: 'pipeline',
  });
  return { actionCode: 'ESCALATE_NO_ELIGIBLE_VEHICLE', replacementVehicleKey: null, relevantRuleIds };
}
