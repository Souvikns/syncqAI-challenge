// Loads and validates the dispatcher's rules from rules/rules.yaml into
// typed, citable objects. Never re-derives rules from free text at runtime.

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const RuleSchema = z.object({
  id: z.string(),
  category: z.enum(['eligibility', 'sla', 'comms', 'rotation', 'dispatch', 'classification']),
  citation: z.object({ source_id: z.string(), locator: z.string() }),
  statement: z.string(),
  months: z.array(z.number().int().min(1).max(12)).optional(),
  hubs: z.array(z.string()).optional(),
  client: z.string().optional(),
  requires_bs_stage: z.string().optional(),
  requires_heater: z.boolean().optional(),
  brake_cooldown_days: z.number().optional(),
  sla_hours: z.number().optional(),
  destination_hub: z.string().optional(),
  cutoff_hour: z.number().optional(),
  resume_hour: z.number().optional(),
  min_year: z.number().optional(),
  padding_percent: z.number().optional(),
  km_threshold: z.number().optional(),
  overdue_days: z.number().optional(),
  home_region_days: z.number().optional(),
  tenure_threshold_days: z.number().optional(),
  night_window: z.object({ start_hour: z.number(), end_hour: z.number() }).optional(),
});

const RulesFileSchema = z.object({ rules: z.array(RuleSchema) });

export type Rule = z.infer<typeof RuleSchema>;

export function loadRules(path: string): Rule[] {
  const parsed = parseYaml(readFileSync(path, 'utf8'));
  return RulesFileSchema.parse(parsed).rules;
}

export function findRule(rules: readonly Rule[], id: string): Rule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown rule id: ${id}`);
  return rule;
}

export function resolveRuleCitation(contextDb: Database, rule: Rule): string | null {
  const row = contextDb
    .query('SELECT unit_hash as unitHash FROM text_units WHERE source_id = ? AND locator = ?')
    .get(rule.citation.source_id, rule.citation.locator) as { unitHash: string } | null;
  return row?.unitHash ?? null;
}

// Every rule's citation hash, resolved once per run rather than once per
// ticket - classify/select/draftComms all share this.
export interface RuleContext {
  readonly rules: readonly Rule[];
  readonly citations: ReadonlyMap<string, string | null>;
}

export function buildRuleContext(contextDb: Database, rulesPath: string): RuleContext {
  const rules = loadRules(rulesPath);
  const citations = new Map(rules.map((rule) => [rule.id, resolveRuleCitation(contextDb, rule)]));
  return { rules, citations };
}

export function ruleCitationHashes(ctx: RuleContext, ruleIds: readonly string[]): string[] {
  return ruleIds.map((id) => ctx.citations.get(id)).filter((hash): hash is string => hash != null);
}
