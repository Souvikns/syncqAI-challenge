import { describe, test, expect } from 'bun:test';
import {
  canonicalJson,
  sha256Hex,
  hmacToken,
  detectPii,
  assertNoPii,
  redactPii,
  normalizePlate,
  parseDate,
  classifyNote,
} from '../src/utils';
import { TEST_SALT } from './helpers';

describe('canonicalJson', () => {
  test('key order does not affect output', () => {
    const a = canonicalJson({ b: '2', a: '1' });
    const b = canonicalJson({ a: '1', b: '2' });
    expect(a).toBe(b);
  });

  test('array order is preserved', () => {
    const a = canonicalJson({ list: ['x', 'y'] });
    const b = canonicalJson({ list: ['y', 'x'] });
    expect(a).not.toBe(b);
  });

  test('produces compact JSON with no extra spacing', () => {
    expect(canonicalJson({ a: '1' })).toBe('{"a":"1"}');
  });
});

describe('sha256Hex', () => {
  test('is deterministic', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  test('is lowercase hex', () => {
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different input gives different hash', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
  });
});

describe('hmacToken', () => {
  test('same input twice gives the same token', () => {
    const a = hmacToken('salt-1', 'PHONE', '+91 8361473242');
    const b = hmacToken('salt-1', 'PHONE', '+91 8361473242');
    expect(a).toBe(b);
  });

  test('different salt gives a different token', () => {
    const a = hmacToken('salt-1', 'PHONE', '+91 8361473242');
    const b = hmacToken('salt-2', 'PHONE', '+91 8361473242');
    expect(a).not.toBe(b);
  });

  test('formats as <KIND:hex6>', () => {
    const token = hmacToken('salt-1', 'PHONE', '+91 8361473242');
    expect(token).toMatch(/^<PHONE:[0-9a-f]{6}>$/);
  });
});

describe('detectPii', () => {
  test('catches an Aadhaar number', () => {
    expect(detectPii('Aadhaar: 1234 5678 9012').map((h) => h.kind)).toContain('AADHAAR');
  });

  test('catches an Indian mobile number', () => {
    expect(detectPii('call me on 8361473242').map((h) => h.kind)).toContain('PHONE');
  });

  test('catches a driving licence number', () => {
    expect(detectPii('DL13 20110012345').map((h) => h.kind)).toContain('DL');
  });

  test('catches an email address', () => {
    expect(detectPii('dispatch@shakticement.example.in').map((h) => h.kind)).toContain('EMAIL');
  });

  test('does not flag an 18-digit trip id as a phone number', () => {
    expect(detectPii('trip-153712955898890756')).toEqual([]);
  });

  test('finds nothing in already-tokenised text', () => {
    expect(detectPii('driver <PHONE:a3f9c1> called in')).toEqual([]);
  });
});

describe('assertNoPii', () => {
  test('passes silently on clean text', () => {
    expect(() => assertNoPii('vehicle UP40IM3144 grounded')).not.toThrow();
  });

  test('throws on a raw phone number', () => {
    expect(() => assertNoPii('call 8361473242')).toThrow();
  });
});

describe('redactPii', () => {
  test('masks a phone number embedded in prose', () => {
    const redacted = redactPii(TEST_SALT, "Ravi's number is +91 93118 40522 if you need him");
    expect(redacted).not.toContain('93118');
    expect(redacted).toMatch(/<PHONE:[0-9a-f]{6}>/);
  });

  test('leaves clean text untouched', () => {
    expect(redactPii(TEST_SALT, 'vehicle grounded for service')).toBe('vehicle grounded for service');
  });
});

describe('normalizePlate', () => {
  test('strips punctuation and uppercases a hyphenated plate', () => {
    expect(normalizePlate('UP-40-IM-3144')).toEqual({ key: 'UP40IM3144', valid: true });
  });

  test('uppercases a lowercase plate with no separators', () => {
    expect(normalizePlate('up86cm7252')).toEqual({ key: 'UP86CM7252', valid: true });
  });

  test('strips spaces from a space-separated plate', () => {
    expect(normalizePlate('CH 40 BH 2290')).toEqual({ key: 'CH40BH2290', valid: true });
  });

  test('rejects text that is not plate-shaped', () => {
    const result = normalizePlate('hr??unknown');
    expect(result.valid).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(normalizePlate('')).toEqual({ key: '', valid: false });
  });
});

describe('parseDate', () => {
  test('parses a ticket-style timestamp with no offset as IST', () => {
    expect(parseDate('2026-08-11T19:00:00')).toEqual({ value: '2026-08-11T19:00:00+05:30', valid: true });
  });

  test('parses a trip-style timestamp with microseconds as IST', () => {
    expect(parseDate('2018-09-15 08:23:11.123456')).toEqual({ value: '2018-09-15T08:23:11+05:30', valid: true });
  });

  test('parses a bare date as midnight IST', () => {
    expect(parseDate('2025-03-02')).toEqual({ value: '2025-03-02T00:00:00+05:30', valid: true });
  });

  test('parses an email Date header with its own offset', () => {
    expect(parseDate('Thu, 02 Jul 2026 13:46 +0530')).toEqual({ value: '2026-07-02T13:46:00+05:30', valid: true });
  });

  test('rejects an unparseable date rather than falling through to Date()', () => {
    expect(parseDate('not-a-date')).toEqual({ value: null, valid: false });
  });
});

describe('classifyNote', () => {
  test('tags a Hindi jugaad note as temp_fix', () => {
    expect(classifyNote('Guddu jugaad se chalu kiya')).toContain('temp_fix');
  });

  test('tags an English temporary-fix note as temp_fix', () => {
    expect(classifyNote('temporary fix applied, needs permanent repair')).toContain('temp_fix');
  });

  test('tags a brake note as brake_work', () => {
    expect(classifyNote('brake pads replaced')).toContain('brake_work');
  });

  test('returns sorted, deduplicated concepts', () => {
    expect(classifyNote('brake replaced, weld kiya')).toEqual(['brake_work', 'service_done', 'welded']);
  });

  test('returns no concepts for text matching nothing in the lexicon', () => {
    expect(classifyNote('driver reported everything fine, no issues found')).toEqual([]);
  });
});
