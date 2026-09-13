/* ============================================================
   Turns routes + pickup schedules into the day's work list.

   service_stops is generated, not hand-maintained: for a given
   date we find every route running that weekday, expand each stop
   into the units that are actually scheduled and occupied, and
   insert one row per unit. Re-running is safe (INSERT OR IGNORE
   against the UNIQUE(service_date, unit_id) constraint).
   ============================================================ */

import { all, run, one, tx } from '../db/index.js';

export const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const dayOfWeek = (isoDate) => new Date(`${isoDate}T12:00:00`).getDay();
export const today = () => new Date().toISOString().slice(0, 10);

/* A schedule row applies on a date when that date falls inside the row's
   effective window. Rows are end-dated rather than deleted when service is
   put on hold or cancelled, so asking about a past date still gives the
   days that genuinely applied back then. Two `?` placeholders: the date. */
const SCHEDULE_APPLIES = `
  (ps.active = 1 OR ps.end_date IS NOT NULL)
  AND COALESCE(ps.effective_date, '2000-01-01') <= ?
  AND (ps.end_date IS NULL OR ps.end_date >= ?)`;

/** Units that should be serviced on `date` for a given route. */
function unitsForRoute(routeId, date) {
  const dow = dayOfWeek(date);
  const stops = all('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sort_order', routeId);
  const units = [];

  for (const stop of stops) {
    if (stop.community_id) {
      units.push(...all(
        `SELECT u.id AS unit_id, sa.customer_id
           FROM units u
           JOIN communities com ON com.id = u.community_id
           JOIN pickup_schedules ps
             ON ps.community_id = u.community_id AND ps.day_of_week = ?
            AND ${SCHEDULE_APPLIES}
           LEFT JOIN service_addresses sa
             ON sa.unit_id = u.id AND sa.end_date IS NULL
           JOIN customers c ON c.id = sa.customer_id AND c.status = 'active'
          WHERE u.community_id = ? AND u.status = 'active'
            AND com.status != 'archived'`,
        dow, date, date, stop.community_id
      ));
    } else if (stop.unit_id) {
      units.push(...all(
        `SELECT u.id AS unit_id, sa.customer_id
           FROM units u
           JOIN pickup_schedules ps
             ON ps.unit_id = u.id AND ps.day_of_week = ?
            AND ${SCHEDULE_APPLIES}
           LEFT JOIN service_addresses sa
             ON sa.unit_id = u.id AND sa.end_date IS NULL
           JOIN customers c ON c.id = sa.customer_id AND c.status = 'active'
          WHERE u.id = ? AND u.status = 'active'`,
        dow, date, date, stop.unit_id
      ));
    }
  }
  return units;
}

/** Build (or top up) the stop list for a date. Returns how many were created. */
export function generateServiceDay(date = today()) {
  const dow = dayOfWeek(date);
  const routes = all(
    `SELECT * FROM routes WHERE day_of_week = ? AND status = 'active'`, dow
  );

  return tx(() => {
    let created = 0;
    for (const route of routes) {
      for (const { unit_id, customer_id } of unitsForRoute(route.id, date)) {
        const res = run(
          `INSERT OR IGNORE INTO service_stops (service_date, route_id, unit_id, customer_id, is_demo)
           VALUES (?, ?, ?, ?, ?)`,
          date, route.id, unit_id, customer_id ?? null, route.is_demo ?? 0
        );
        created += res.changes;
      }
    }
    return created;
  });
}

/** Counts for the admin overview. */
export function serviceDayStats(date = today()) {
  const row = one(
    `SELECT
        COUNT(*)                                           AS scheduled,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'issue'     THEN 1 ELSE 0 END) AS issues,
        SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS remaining
       FROM service_stops WHERE service_date = ? AND is_demo = 0`, date
  );
  return {
    date,
    dayName: DAY_NAMES[dayOfWeek(date)],
    scheduled: row?.scheduled ?? 0,
    completed: row?.completed ?? 0,
    issues: row?.issues ?? 0,
    remaining: row?.remaining ?? 0,
  };
}
