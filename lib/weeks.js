// Game weeks run Monday 00:00 UTC to the next Monday 00:00 UTC.
// A week's id is the date of its Monday, e.g. "2026-10-12".

const DAY = 86400;
const WEEK = 7 * DAY;

/** Unix seconds of the Monday 00:00 UTC on or before `ts`. */
export function weekStart(ts) {
  const d = new Date(ts * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000;
}

export const weekId = (startTs) => new Date(startTs * 1000).toISOString().slice(0, 10);
export const weekStartFromId = (id) => Date.parse(id + "T00:00:00Z") / 1000;
export const shiftWeek = (id, n) => weekId(weekStartFromId(id) + n * WEEK);

/** The live week (being scored now), the upcoming week (open for picks) and the last finished week. */
export function calendar(nowTs = Math.floor(Date.now() / 1000)) {
  const start = weekStart(nowTs);
  const current = { id: weekId(start), start, end: start + WEEK };
  const upcoming = { id: weekId(start + WEEK), start: start + WEEK, end: start + 2 * WEEK, lockAt: start + WEEK };
  const last = { id: weekId(start - WEEK), start: start - WEEK, end: start };
  return { now: nowTs, current, upcoming, last };
}

export { DAY, WEEK };
