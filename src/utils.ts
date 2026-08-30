// Generic, self-contained helpers with no database or source-file knowledge.
// Anything here should be understandable and testable in isolation.

export type Tri = 'TRUE' | 'FALSE' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Hashing and canonical JSON
// ---------------------------------------------------------------------------

export function canonicalJson(value: Record<string, string | null> | { list: readonly string[] }): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

export function hmacToken(salt: string, kind: string, value: string): string {
  const digest = new Bun.CryptoHasher('sha256', salt).update(value).digest('hex');
  return `<${kind}:${digest.slice(0, 6)}>`;
}

// ---------------------------------------------------------------------------
// PII detection, redaction and the tripwire
// ---------------------------------------------------------------------------

const PII_PATTERNS: Record<string, RegExp> = {
  AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  PHONE: /(?:\+91[\s-]?)?\b[6-9]\d{9}\b|\+91[\s-]\d{5}[\s-]\d{5}/g,
  DL: /\b[A-Z]{2}\d{2}\s?\d{11}\b/g,
  EMAIL: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,
};

export interface PiiHit {
  readonly kind: string;
  readonly match: string;
}

export function detectPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const [kind, pattern] of Object.entries(PII_PATTERNS)) {
    for (const match of text.matchAll(pattern)) {
      if (!isInsideExistingToken(text, match.index ?? 0)) {
        hits.push({ kind, match: match[0] });
      }
    }
  }
  return hits;
}

const TOKEN_SHAPE = /<[A-Z]+:[0-9a-f]{6}>/g;

function isInsideExistingToken(text: string, offset: number): boolean {
  for (const token of text.matchAll(TOKEN_SHAPE)) {
    const start = token.index ?? 0;
    if (offset >= start && offset < start + token[0].length) return true;
  }
  return false;
}

export function redactPii(salt: string, text: string): string {
  let redacted = text;
  for (const [kind, pattern] of Object.entries(PII_PATTERNS)) {
    redacted = redacted.replace(pattern, (match) => hmacToken(salt, kind, match));
  }
  return redacted;
}

export function assertNoPii(text: string): void {
  const hits = detectPii(text);
  if (hits.length > 0) {
    throw new Error(`PII tripwire: found ${hits.map((h) => h.kind).join(', ')} in output text`);
  }
}

// ---------------------------------------------------------------------------
// Plate normalisation
// ---------------------------------------------------------------------------

const PLATE_SHAPE = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/;

export function normalizePlate(raw: string): { key: string; valid: boolean } {
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return { key, valid: PLATE_SHAPE.test(key) };
}

// ---------------------------------------------------------------------------
// Date parsing — explicit patterns only, never a fallthrough to new Date(s)
// ---------------------------------------------------------------------------

export interface ParsedDate {
  readonly value: string | null;
  readonly valid: boolean;
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

const DATE_PATTERNS: readonly { pattern: RegExp; toIso: (m: RegExpMatchArray) => string }[] = [
  {
    // 2026-08-11T19:00:00
    pattern: /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/,
    toIso: (m) => `${m[1]}T${m[2]}+05:30`,
  },
  {
    // 2018-09-15 08:23:11.123456
    pattern: /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.\d+$/,
    toIso: (m) => `${m[1]}T${m[2]}+05:30`,
  },
  {
    // 2025-03-02
    pattern: /^(\d{4}-\d{2}-\d{2})$/,
    toIso: (m) => `${m[1]}T00:00:00+05:30`,
  },
  {
    // Thu, 02 Jul 2026 13:46 +0530
    pattern: /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/,
    toIso: (m) => {
      const month = MONTHS[m[2] as string];
      if (!month) throw new Error(`unknown month: ${m[2]}`);
      return `${m[3]}-${month}-${m[1]}T${m[4]}:00${m[5]}:${m[6]}`;
    },
  },
];

export function parseDate(raw: string): ParsedDate {
  for (const { pattern, toIso } of DATE_PATTERNS) {
    const match = raw.match(pattern);
    if (match) return { value: toIso(match), valid: true };
  }
  return { value: null, valid: false };
}

export function addDays(isoDateTime: string, days: number): string {
  const match = isoDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`unexpected date shape: ${isoDateTime}`);
  const [, y, m, d, time, offset] = match as unknown as [string, string, string, string, string, string];

  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  date.setUTCDate(date.getUTCDate() + days);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${time}${offset}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return Math.floor((to - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Mechanic-note lexicon — bilingual concept tagging for free text
// ---------------------------------------------------------------------------

const NOTE_CONCEPTS: Record<string, RegExp[]> = {
  temp_fix: [/jugaad/, /permanent fix baaki/, /temporary fix applied/, /needs permanent repair/, /permanent repair pending/],
  brake_work: [/brake/],
  service_done: [/road test ok/, /replaced/, /naya lagwaya/, /repaired and tested/],
  welded: [/weld/, /weld kiya/],
  battery: [/battery/],
  turbo: [/turbo/],
  clutch: [/clutch/],
  radiator: [/radiator/],
  suspension: [/suspension/],
  gearbox: [/gearbox/],
  tyre: [/tyre|tire/],
  electrical: [/electrical/],
  engine: [/engine/],
};

export function classifyNote(note: string): string[] {
  const lower = note.toLowerCase();
  const concepts = Object.entries(NOTE_CONCEPTS)
    .filter(([, patterns]) => patterns.some((p) => p.test(lower)))
    .map(([concept]) => concept);
  return concepts.sort();
}

// ---------------------------------------------------------------------------
// Small collection and value helpers
// ---------------------------------------------------------------------------

export function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Blank-to-null across every column of a CSV row, so hashing never depends on JS string quirks. */
export function payloadFromRow(row: Record<string, string>): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) payload[key] = emptyToNull(value);
  return payload;
}

export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function toInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toTri(value: string | undefined): Tri {
  if (value === 'Yes') return 'TRUE';
  if (value === 'No') return 'FALSE';
  return 'UNKNOWN';
}
