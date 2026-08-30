import { describe, test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cite } from '../../src/ingestion/shared';
import { ingest } from '../../src/ingest';
import { findRule, loadRules, resolveRuleCitation } from '../../src/pipeline/rules';
import { tempStateDir, TEST_SALT } from '../helpers';

const REFERENCE_DATE = '2026-08-30T00:00:00+05:30';

describe('loadRules', () => {
  test('loads all 12 rules from rules/rules.yaml', () => {
    const rules = loadRules('rules/rules.yaml');
    expect(rules).toHaveLength(12);
    expect(rules.map((r) => r.id)).toContain('R09_HUB_SELECTION');
  });

  test('every rule citation resolves through cite() against an ingested context.db', async () => {
    const rules = loadRules('rules/rules.yaml');
    const contextDb = await ingest({ dataRoot: '.', stateDir: tempStateDir(), piiSalt: TEST_SALT, referenceDate: REFERENCE_DATE });

    for (const rule of rules) {
      const hash = resolveRuleCitation(contextDb, rule);
      expect(hash).not.toBeNull();
      expect(cite(contextDb, hash as string)).not.toBeNull();
    }

    contextDb.close();
  });

  test('throws on a malformed rules file rather than loading it partially', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-rules-'));
    const badPath = join(dir, 'bad.yaml');
    writeFileSync(badPath, 'rules:\n  - id: BROKEN\n');
    expect(() => loadRules(badPath)).toThrow();
  });
});

describe('findRule', () => {
  test('returns the rule with a matching id', () => {
    const rules = loadRules('rules/rules.yaml');
    const rule = findRule(rules, 'R04_SHAKTI_SLA_36H');
    expect(rule.client).toBe('shakti_cement');
    expect(rule.sla_hours).toBe(36);
  });

  test('throws for an unknown id', () => {
    const rules = loadRules('rules/rules.yaml');
    expect(() => findRule(rules, 'NOT_A_REAL_RULE')).toThrow();
  });
});
