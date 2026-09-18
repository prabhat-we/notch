// Single source of truth for "today" — always derived live from the device's
// local clock, never cached. Normalized to UTC midnight so it compares
// cleanly against due-date strings (e.g. "2026-09-17"), which JS parses as
// UTC midnight. Not for display — formatting this can print the previous
// calendar day in timezones behind UTC; format a plain `new Date()` instead.
export function getToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
