// Step 6: draft the client notification and queue it behind the human
// approval gate. Every applicable client/season rule shapes the wording;
// nothing here claims an outcome (like a specific ETA) this system can't
// actually compute.

import type { Database } from 'bun:sqlite';
import { CLIENT_ALIASES } from '../ingestion/shared';
import { assertNoPii, sha256Hex } from '../utils';
import { writeAuditRecord } from './audit';
import type { EnrichedTicket } from './enrich';
import { findRule, type RuleContext } from './rules';
import { monthInSet, routeTouchesHubs } from './seasons';
import type { Selection } from './selectVehicle';

function recipientFor(clientKey: string): string {
  const aliases = CLIENT_ALIASES[clientKey];
  const email = aliases?.find((alias) => alias.includes('@'));
  // 'internal' has no email alias at all (only a domain string) - Meridian's
  // own dispatches have no external client to notify. UNKNOWN is the
  // correct, honest answer here, not a bug: never invent a contact address.
  return email ?? 'UNKNOWN';
}

function buildBody(enriched: EnrichedTicket, selection: Selection, ctx: RuleContext): string {
  const { ticket } = enriched;
  const lines: string[] = [
    `Ticket ${ticket.ticketId}: ${ticket.vehicleReg} reported "${ticket.issue}" near ${ticket.originHub}.`,
  ];

  if (selection.replacementVehicleKey) {
    lines.push(`A replacement vehicle has been dispatched from the ${enriched.originHubKey} hub.`);
  } else {
    lines.push('No eligible replacement vehicle could be automatically confirmed; this ticket is under manual review by dispatch.');
  }

  const slaRule = findRule(ctx.rules, 'R04_SHAKTI_SLA_36H');
  if (enriched.clientKey === slaRule.client) {
    lines.push(`Per agreed operating SLA, resolution is targeted within ${slaRule.sla_hours} hours.`);
  }

  const vertexRule = findRule(ctx.rules, 'R05_VERTEX_LUDHIANA_CUTOFF');
  if (enriched.clientKey === vertexRule.client && enriched.destinationHubKey === vertexRule.destination_hub) {
    lines.push(
      `Per the Ludhiana warehouse's ${vertexRule.cutoff_hour}:00 gate policy, an arrival projected after ` +
        `${vertexRule.cutoff_hour}:00 IST is recorded as a scheduled morning delivery at ${vertexRule.resume_hour}:00 ` +
        'the next day.',
    );
  }

  const orionRule = findRule(ctx.rules, 'R07_ORION_VEHICLE_AGE');
  if (enriched.clientKey === orionRule.client) {
    lines.push('No unrefrigerated overnight hold at a hub will be used for this load.');
  }

  const monsoonRule = findRule(ctx.rules, 'R08_MONSOON_ETA_PADDING');
  if (monthInSet(ticket.createdAt, monsoonRule.months ?? []) && routeTouchesHubs([enriched.destinationHubKey], monsoonRule.hubs ?? [])) {
    lines.push(`Monsoon-season eastern route: the ETA quoted has been padded by at least ${monsoonRule.padding_percent}% against seasonal delays.`);
  }

  return lines.join(' ');
}

export function draftComms(actionsDb: Database, enriched: EnrichedTicket, selection: Selection, ctx: RuleContext): void {
  const recipient = recipientFor(enriched.clientKey);
  const body = buildBody(enriched, selection, ctx);
  assertNoPii(body);

  const context = {
    ticketId: enriched.ticket.ticketId,
    issue: enriched.ticket.issue,
    severity: enriched.ticket.severity,
    actionCode: selection.actionCode,
    replacementVehicleKey: selection.replacementVehicleKey,
    clientKey: enriched.clientKey,
  };

  const messageId = sha256Hex('comms' + enriched.ticket.ticketId);
  actionsDb
    .query('INSERT OR IGNORE INTO comms_pending (message_id, ticket_id, recipient, body, context, drafted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, enriched.ticket.ticketId, recipient, body, JSON.stringify(context), enriched.ticket.createdAt);

  writeAuditRecord(actionsDb, {
    ticketId: enriched.ticket.ticketId,
    step: 'DRAFT_COMMS',
    // The recipient address itself lives only in comms_pending's dedicated,
    // exempted `recipient` column (export-outputs.ts) - audit is free text,
    // swept in full, so it names the client by its resolved key instead.
    decision: `drafted for ${enriched.clientKey}`,
    ruleId: null,
    citations: [],
    decidedBy: 'pipeline',
  });
}
