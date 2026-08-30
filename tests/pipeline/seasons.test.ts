import { describe, test, expect } from 'bun:test';
import { hourOf, isNightRun, monthInSet, monthOf, routeTouchesHubs } from '../../src/pipeline/seasons';

describe('monthOf', () => {
  test('extracts the calendar month from an ISO timestamp', () => {
    expect(monthOf('2026-02-21T04:00:00+05:30')).toBe(2);
    expect(monthOf('2026-11-01T00:00:00+05:30')).toBe(11);
  });
});

describe('hourOf', () => {
  test('extracts the hour from an ISO timestamp', () => {
    expect(hourOf('2026-02-21T04:00:00+05:30')).toBe(4);
    expect(hourOf('2026-07-13T21:00:00+05:30')).toBe(21);
  });
});

describe('monthInSet', () => {
  test('true when the timestamp falls in the given months', () => {
    expect(monthInSet('2026-02-21T04:00:00+05:30', [10, 11, 12, 1, 2])).toBe(true);
    expect(monthInSet('2026-06-01T00:00:00+05:30', [10, 11, 12, 1, 2])).toBe(false);
  });
});

describe('routeTouchesHubs', () => {
  test('true when any of the route hub keys is in the target set', () => {
    expect(routeTouchesHubs(['gurgaon', 'kanpur'], ['delhi', 'gurgaon', 'faridabad', 'noida'])).toBe(true);
    expect(routeTouchesHubs(['kanpur', 'lucknow'], ['delhi', 'gurgaon', 'faridabad', 'noida'])).toBe(false);
  });
});

describe('isNightRun', () => {
  const window = { start_hour: 20, end_hour: 6 };

  test('true late at night and in the small hours (window wraps midnight)', () => {
    expect(isNightRun('2026-01-01T21:00:00+05:30', window)).toBe(true);
    expect(isNightRun('2026-01-01T04:00:00+05:30', window)).toBe(true);
  });

  test('false during the day', () => {
    expect(isNightRun('2026-01-01T12:00:00+05:30', window)).toBe(false);
    expect(isNightRun('2026-01-01T06:00:00+05:30', window)).toBe(false);
    expect(isNightRun('2026-01-01T19:59:00+05:30', window)).toBe(false);
  });
});
