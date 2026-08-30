// Machinery shared by every source adapter: turning a row into a
// content-addressed record, exploding it into observations, resolving
// conflicting observations by precedence, and indexing free text for search.
// Nothing here knows about any specific source file.

import type { Database } from 'bun:sqlite';
import { canonicalJson, groupBy, sha256Hex } from '../utils';

// ---------------------------------------------------------------------------
// Raw records: every source row, content-addressed, before it is interpreted.
// ---------------------------------------------------------------------------

export interface RawRecord {
  readonly sourceId: string;
  readonly unit: string;
  readonly locator: string;
  readonly payload: Readonly<Record<string, string | null>>;
  readonly contentHash: string;
}

export function buildRawRecord(sourceId: string, unit: string, locator: string, payload: Record<string, string | null>): RawRecord {
  const contentHash = sha256Hex(sourceId + canonicalJson(payload));
  return { sourceId, unit, locator, payload, contentHash };
}

export function storeRawRecord(db: Database, record: RawRecord): void {
  db.query('INSERT OR IGNORE INTO source_records (content_hash, source_id, payload) VALUES (?, ?, ?)').run(
    record.contentHash,
    record.sourceId,
    canonicalJson(record.payload),
  );
  db.query('INSERT OR IGNORE INTO record_locations (content_hash, unit, locator) VALUES (?, ?, ?)').run(
    record.contentHash,
    record.unit,
    record.locator,
  );
}

export interface QuarantineReason {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export function quarantineRecord(
  db: Database,
  params: {
    sourceId: string;
    unit: string;
    locator: string;
    recordId: string | null;
    payloadHash: string;
    reasons: readonly QuarantineReason[];
  },
): void {
  const sortedReasons = [...params.reasons].sort((a, b) => a.field.localeCompare(b.field));
  const quarantineId = sha256Hex(params.sourceId + params.locator + params.payloadHash);
  db.query(
    `INSERT OR IGNORE INTO quarantine (quarantine_id, source_id, unit, locator, record_id, payload_hash, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(quarantineId, params.sourceId, params.unit, params.locator, params.recordId, params.payloadHash, JSON.stringify(sortedReasons));
}

export function raiseAlert(db: Database, kind: string, subject: string, detail: string): void {
  const alertId = sha256Hex(kind + subject + detail);
  db.query('INSERT OR IGNORE INTO alerts (alert_id, kind, subject, detail) VALUES (?, ?, ?, ?)').run(alertId, kind, subject, detail);
}

// ---------------------------------------------------------------------------
// Observations: one atomic claim about one field of one entity, from one
// source. Entity resolution collapses these into the entity tables.
// ---------------------------------------------------------------------------

export interface Observation {
  readonly entityKind: string;
  readonly entityKey: string;
  readonly field: string;
  readonly value: string;
  readonly validAt: string | null;
  readonly sourceId: string;
  readonly sourceHash: string;
}

export function insertObservation(db: Database, obs: Observation): void {
  db.query(
    `INSERT OR IGNORE INTO observations (entity_kind, entity_key, field, value, valid_at, source_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(obs.entityKind, obs.entityKey, obs.field, obs.value, obs.validAt, obs.sourceHash);
}

// ---------------------------------------------------------------------------
// Precedence: which source wins when two claims about the same field
// disagree. Declared as data, cited to the source that states the rule.
// ---------------------------------------------------------------------------

interface PrecedenceRule {
  readonly field: string;
  readonly sourceId: string;
  readonly rank: number;
}

const PRECEDENCE_RULES: readonly PrecedenceRule[] = [
  { field: 'vehicle.year', sourceId: 'fleet_master', rank: 1 },
  { field: 'vehicle.year', sourceId: 'emails', rank: 2 },
  { field: 'vehicle.bs_stage', sourceId: 'fleet_master', rank: 1 },
  { field: 'vehicle.engine_heater', sourceId: 'fleet_master', rank: 1 },
  { field: 'vehicle.capacity_tonnes', sourceId: 'fleet_master', rank: 1 },
  { field: 'vehicle.home_hub', sourceId: 'fleet_master', rank: 1 },
  { field: 'vehicle.odometer_km', sourceId: 'maintenance_log', rank: 1 },
  { field: 'vehicle.odometer_km', sourceId: 'emails', rank: 2 },
  { field: 'driver.joining_date', sourceId: 'drivers_roster', rank: 1 },
];

// Fields whose true value changes over time, so recency breaks ties within a
// rank tier. Everything else is a fact that does not change, so authority
// alone decides.
const FIELDS_WHERE_RECENCY_WINS = new Set(['vehicle.odometer_km']);

// Differing spellings of the same identifier are representation, not
// disagreement about a fact - normalisation resolves them silently, and they
// are never written to the conflict ledger.
const FIELDS_WHERE_DIFFERENCE_IS_JUST_SPELLING = new Set(['vehicle.vehicle_id']);

function precedenceRank(field: string, sourceId: string): number {
  const rule = PRECEDENCE_RULES.find((r) => r.field === field && r.sourceId === sourceId);
  return rule ? rule.rank : 1;
}

function compareByPrecedence(field: string, a: Observation, b: Observation): number {
  const rankDiff = precedenceRank(field, a.sourceId) - precedenceRank(field, b.sourceId);
  if (rankDiff !== 0) return rankDiff;

  if (FIELDS_WHERE_RECENCY_WINS.has(field)) {
    const recencyDiff = (b.validAt ?? '0000').localeCompare(a.validAt ?? '0000');
    if (recencyDiff !== 0) return recencyDiff;
  }

  const aIsEmpty = a.value === '' ? 1 : 0;
  const bIsEmpty = b.value === '' ? 1 : 0;
  if (aIsEmpty !== bIsEmpty) return aIsEmpty - bIsEmpty;

  return a.sourceHash.localeCompare(b.sourceHash);
}

export interface ConflictRow {
  readonly entityKind: string;
  readonly entityKey: string;
  readonly field: string;
  readonly winningValue: string;
  readonly winningSource: string;
  readonly losingValue: string;
  readonly losingSource: string;
  readonly reason: string;
}

function describeWhyItWon(field: string, winner: Observation, loser: Observation): string {
  if (winner.sourceId !== loser.sourceId) {
    return `${field} — ${winner.sourceId} outranks ${loser.sourceId}`;
  }
  return `${field} — non-empty value beats empty within ${winner.sourceId}`;
}

export interface ResolvedField {
  readonly value: string;
  readonly sourceHash: string;
}

/** Picks the winning observation for one field and reports every loser that disagreed. */
function resolveField(field: string, observations: readonly Observation[]): { winner: Observation; conflicts: ConflictRow[] } {
  const ranked = [...observations].sort((a, b) => compareByPrecedence(field, a, b));
  const winner = ranked[0];
  if (!winner) throw new Error(`resolveField called with no observations for ${field}`);

  const conflicts = ranked
    .slice(1)
    .filter((loser) => loser.value !== winner.value)
    .map((loser) => ({
      entityKind: winner.entityKind,
      entityKey: winner.entityKey,
      field,
      winningValue: winner.value,
      winningSource: winner.sourceHash,
      losingValue: loser.value,
      losingSource: loser.sourceHash,
      reason: describeWhyItWon(field, winner, loser),
    }));

  return { winner, conflicts };
}

/** Resolves every field of one entity from its observations. */
export function resolveEntity(observations: readonly Observation[]): { fields: Map<string, ResolvedField>; conflicts: ConflictRow[] } {
  const fields = new Map<string, ResolvedField>();
  const conflicts: ConflictRow[] = [];
  const byField = groupBy(observations, (o) => o.field);

  for (const field of [...byField.keys()].sort()) {
    const obsForField = byField.get(field) ?? [];
    const { winner, conflicts: fieldConflicts } = resolveField(field, obsForField);
    fields.set(field, { value: winner.value, sourceHash: winner.sourceHash });
    if (!FIELDS_WHERE_DIFFERENCE_IS_JUST_SPELLING.has(field)) conflicts.push(...fieldConflicts);
  }

  return { fields, conflicts };
}

export function insertConflict(db: Database, c: ConflictRow): void {
  db.query(
    `INSERT OR IGNORE INTO conflicts
       (entity_kind, entity_key, field, winning_value, winning_source, losing_value, losing_source, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.entityKind, c.entityKey, c.field, c.winningValue, c.winningSource, c.losingValue, c.losingSource, c.reason);
}

// ---------------------------------------------------------------------------
// Text units: citable spans of free text, indexed for full-text search.
// ---------------------------------------------------------------------------

export function insertTextUnit(
  db: Database,
  unit: { unitHash: string; sourceId: string; locator: string; text: string; concepts: readonly string[] },
): void {
  const already = db.query('SELECT 1 FROM text_units WHERE unit_hash = ?').get(unit.unitHash);
  if (already) return;

  db.query('INSERT INTO text_units (unit_hash, source_id, locator, text, concepts) VALUES (?, ?, ?, ?, ?)').run(
    unit.unitHash,
    unit.sourceId,
    unit.locator,
    unit.text,
    JSON.stringify(unit.concepts),
  );
  const inserted = db.query('SELECT rowid FROM text_units WHERE unit_hash = ?').get(unit.unitHash) as { rowid: number };
  db.query('INSERT INTO text_fts (rowid, text) VALUES (?, ?)').run(inserted.rowid, unit.text);
}

export interface TextHit {
  readonly sourceId: string;
  readonly locator: string;
  readonly text: string;
}

export function searchText(db: Database, query: string): TextHit[] {
  return db
    .query(
      `SELECT tu.source_id as sourceId, tu.locator as locator, tu.text as text
       FROM text_fts f JOIN text_units tu ON tu.rowid = f.rowid
       WHERE f.text MATCH ? ORDER BY tu.locator`,
    )
    .all(query) as TextHit[];
}

// ---------------------------------------------------------------------------
// Citations: every fact must trace back to a source record and a position.
// ---------------------------------------------------------------------------

export interface Citation {
  readonly sourceId: string;
  readonly unit: string;
  readonly locator: string;
  readonly payload: string;
}

export function cite(db: Database, contentHash: string): Citation | null {
  const source = db.query('SELECT source_id as sourceId, payload FROM source_records WHERE content_hash = ?').get(contentHash) as
    | { sourceId: string; payload: string }
    | null;
  if (!source) return null;

  const location = db.query('SELECT unit, locator FROM record_locations WHERE content_hash = ? ORDER BY unit, locator LIMIT 1').get(
    contentHash,
  ) as { unit: string; locator: string } | null;
  if (!location) return null;

  return { sourceId: source.sourceId, unit: location.unit, locator: location.locator, payload: source.payload };
}

// ---------------------------------------------------------------------------
// Name canonicalisation — the same client or hub under multiple spellings.
// This is Meridian's actual reference data, not a generic utility.
// ---------------------------------------------------------------------------

export const HUBS = ['Ambala', 'Chandigarh', 'Delhi', 'Gurgaon', 'Jaipur', 'Kanpur', 'Lucknow', 'Ludhiana', 'Rudrapur'] as const;

export function resolveHubKey(raw: string): string | null {
  const match = HUBS.find((hub) => hub.toLowerCase() === raw.trim().toLowerCase());
  return match ? match.toLowerCase() : null;
}

export const CLIENT_ALIASES: Record<string, readonly string[]> = {
  shakti_cement: ['Shakti Cement', 'Shakti', 'shakticement', 'dispatch@shakticement.example.in'],
  vertex_retail: ['Vertex Retail', 'Vertex', 'vertexretail', 'logistics@vertexretail.example.in'],
  apex_chemicals: ['Apex Chemicals', 'Apex', 'apexchem', 'stores@apexchem.example.in'],
  orion_pharma: ['Orion Pharma', 'Orion', 'orionpharma', 'scm@orionpharma.example.in'],
  internal: ['Internal', 'Meridian Freight', 'meridianfreight.example.in'],
};

function normalizeClientToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(ltd|pvt|limited|private)\b/g, '')
    .replace(/[^a-z0-9@.]/g, '');
}

export function resolveClientKey(raw: string): string | null {
  const target = normalizeClientToken(raw);
  for (const [key, aliases] of Object.entries(CLIENT_ALIASES)) {
    if (aliases.some((alias) => normalizeClientToken(alias) === target)) return key;
  }
  return null;
}
