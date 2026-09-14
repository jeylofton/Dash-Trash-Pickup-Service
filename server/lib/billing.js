/* ============================================================
   Billing interval math, in one place.

   A plan's billing frequency is (interval_unit, interval_count):
   "every N weeks/months/years". This module is the ONLY thing
   that knows how to turn that into a next-billing date, a monthly
   figure for MRR, or a human label. `interval_months` is retired.
   ============================================================ */

export const INTERVAL_UNITS = ['week', 'month', 'year'];

const DAYS_PER_MONTH = 30.436875; // average Gregorian month

/** Fractional months represented by one billing cycle — for MRR only. */
export function monthsEquivalent(unit, count) {
  const n = Number(count) || 0;
  switch (unit) {
    case 'week':  return (n * 7) / DAYS_PER_MONTH;
    case 'month': return n;
    case 'year':  return n * 12;
    default: throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/** The next billing date after `dateISO`, `YYYY-MM-DD`. UTC, so no TZ drift. */
export function addInterval(dateISO, unit, count) {
  const d = new Date(`${String(dateISO).slice(0, 10)}T00:00:00Z`);
  const n = Number(count) || 0;
  switch (unit) {
    case 'week':  d.setUTCDate(d.getUTCDate() + n * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + n); break;
    default: throw new Error(`Unknown interval unit: ${unit}`);
  }
  return d.toISOString().slice(0, 10);
}

const SINGULAR = { week: 'week', month: 'month', year: 'year' };
const PLURAL   = { week: 'weeks', month: 'months', year: 'years' };
const EVERY_ONE = { week: 'weekly', month: 'monthly', year: 'yearly' };

/** "weekly" / "every 2 weeks" / "every 6 months". */
export function frequencyLabel(unit, count) {
  const n = Number(count) || 1;
  if (n === 1) return EVERY_ONE[unit] ?? `every ${unit}`;
  return `every ${n} ${PLURAL[unit] ?? `${unit}s`}`;
}

/** Price suffix: "/ week" / "/ 6 months". */
export function perLabel(unit, count) {
  const n = Number(count) || 1;
  return n === 1 ? `/ ${SINGULAR[unit] ?? unit}` : `/ ${n} ${PLURAL[unit] ?? `${unit}s`}`;
}

/** A safe, mostly-unique plan code derived from a name. */
export function slugCode(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9]+/g, '');
  if (!s) return 'Plan';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
