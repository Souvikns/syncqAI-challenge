// Pure helpers for the season/time conditions the dispatcher's rules use.
// Dates here are always the already-normalised +05:30 ISO strings ingestion
// and validate.ts produce - never parsed with `new Date(string)`.

export function monthOf(isoDateTime: string): number {
  const match = isoDateTime.match(/^\d{4}-(\d{2})-/);
  if (!match) throw new Error(`unexpected date shape: ${isoDateTime}`);
  return Number(match[1]);
}

export function hourOf(isoDateTime: string): number {
  const match = isoDateTime.match(/T(\d{2}):/);
  if (!match) throw new Error(`unexpected date shape: ${isoDateTime}`);
  return Number(match[1]);
}

export function monthInSet(isoDateTime: string, months: readonly number[]): boolean {
  return months.includes(monthOf(isoDateTime));
}

export function routeTouchesHubs(routeHubKeys: readonly string[], targetHubs: readonly string[]): boolean {
  return routeHubKeys.some((key) => targetHubs.includes(key));
}

export interface NightWindow {
  readonly start_hour: number;
  readonly end_hour: number;
}

// SPEC-GAP: the night-run window (20:00-06:00 IST by default, see
// rules.yaml) is an interpretation - the interview gives examples ("four in
// the morning", "2 am") but never states an exact clock boundary.
export function isNightRun(isoDateTime: string, window: NightWindow): boolean {
  const hour = hourOf(isoDateTime);
  if (window.start_hour > window.end_hour) return hour >= window.start_hour || hour < window.end_hour;
  return hour >= window.start_hour && hour < window.end_hour;
}
