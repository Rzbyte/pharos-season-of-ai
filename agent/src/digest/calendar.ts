// Task 28: the calendar a digest is cut by. Periods are UTC hours, days, or weeks from Monday 00:00 UTC;
// a period holds the blocks from its start (inclusive) to the next period's start (exclusive), so
// consecutive periods share no block.

export type Every = "hour" | "day" | "week";

export const EVERY: readonly Every[] = ["hour", "day", "week"];
const SECONDS: Record<Every, bigint> = { hour: 3600n, day: 86_400n, week: 604_800n };
/** The periods one digest is split into, to find its busiest: a week's days, a day's hours. */
export const PARTS: Record<Every, Every | null> = { hour: null, day: "hour", week: "day" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** The start (Unix seconds) of the period that holds `t`. 1 January 1970 was a Thursday. */
export function periodStart(t: bigint, every: Every): bigint {
  if (every !== "week") return t - (t % SECONDS[every]);
  const day = t / 86_400n;
  return (day - ((day + 3n) % 7n)) * 86_400n;
}

export const periodEnd = (start: bigint, every: Every): bigint => start + SECONDS[every];

const date = (t: bigint) => {
  const d = new Date(Number(t) * 1000);
  return { weekday: DAYS[d.getUTCDay()]!, day: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, hour: `${two(d.getUTCHours())}:00` };
};

/** "the week of Monday 12 Oct 2026", "Saturday 17 Oct 2026", "17 Oct 2026, 13:00 to 14:00 UTC". */
export function periodLabel(start: bigint, every: Every): string {
  const d = date(start);
  if (every === "week") return `the week of Monday ${d.day}`;
  if (every === "day") return `${d.weekday} ${d.day}`;
  return `${d.day}, ${d.hour} to ${date(start + 3600n).hour} UTC`;
}

/** A part of a period, short: "Tuesday" for a day of a week, "13:00" for an hour of a day. */
export function partLabel(start: bigint, every: Every): string {
  const d = date(start);
  return every === "day" ? d.weekday : `${d.hour} UTC`;
}
