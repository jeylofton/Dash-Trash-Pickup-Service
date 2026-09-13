/* Clock-in / clock-out. Shared by the employee routes and admin corrections. */
import { one, all, run } from '../db/index.js';

export const MINUTES_SQL = `
  MAX(0, CAST((julianday(COALESCE(clock_out_at, datetime('now')))
             - julianday(clock_in_at)) * 1440 AS INTEGER) - break_minutes)`;

/** The pay rate in force for an employee on a date. */
export function rateOn(employeeId, date) {
  return one(
    `SELECT pay_type, rate_cents FROM employee_compensation
      WHERE employee_id = ? AND effective_date <= ?
        AND (end_date IS NULL OR end_date >= ?)
      ORDER BY effective_date DESC LIMIT 1`,
    employeeId, date, date) || { pay_type: 'hourly', rate_cents: 0 };
}

export function openShift(employeeId) {
  return one(
    `SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries
      WHERE employee_id = ? AND clock_out_at IS NULL`, employeeId);
}

export function clockIn(employeeId, { routeId, lat, lng, device } = {}) {
  if (openShift(employeeId)) {
    const err = new Error('You are already clocked in.');
    err.status = 409;
    throw err;
  }
  const date = new Date().toISOString().slice(0, 10);
  const rate = rateOn(employeeId, date);
  // A training employee's shifts must stay out of the owner's payroll.
  const demo = one('SELECT is_demo FROM employees WHERE id = ?', employeeId)?.is_demo ?? 0;

  const id = run(
    `INSERT INTO time_entries
       (employee_id, route_id, work_date, clock_in_at, clock_in_lat, clock_in_lng,
        device, pay_type_snapshot, rate_cents_snapshot, is_demo)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
    employeeId, routeId ?? null, date, lat ?? null, lng ?? null,
    device ?? null, rate.pay_type, rate.rate_cents, demo
  ).lastInsertRowid;

  return one(`SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries WHERE id = ?`, id);
}

export function clockOut(employeeId, { breakMinutes = 0, lat, lng, note } = {}) {
  const shift = openShift(employeeId);
  if (!shift) {
    const err = new Error('You are not clocked in.');
    err.status = 409;
    throw err;
  }
  run(
    `UPDATE time_entries
        SET clock_out_at = datetime('now'), break_minutes = ?,
            clock_out_lat = ?, clock_out_lng = ?, note = COALESCE(?, note)
      WHERE id = ?`,
    Math.max(0, Number(breakMinutes) || 0), lat ?? null, lng ?? null, note ?? null, shift.id);

  return one(`SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries WHERE id = ?`, shift.id);
}

/** Pay for one entry, using the snapshot taken at clock-in. */
export function entryPayCents(entry) {
  if (!entry.clock_out_at) return 0;
  const rate = entry.rate_cents_snapshot || 0;
  return (entry.pay_type_snapshot === 'daily')
    ? rate
    : Math.round(rate * ((entry.minutes ?? 0) / 60));
}

export function shiftsFor(employeeId, limit = 30) {
  return all(
    `SELECT te.*, ${MINUTES_SQL} AS minutes, r.name AS route_name
       FROM time_entries te LEFT JOIN routes r ON r.id = te.route_id
      WHERE te.employee_id = ?
      ORDER BY te.clock_in_at DESC LIMIT ?`, employeeId, limit)
    .map(e => ({ ...e, payCents: entryPayCents(e) }));
}

/** Current pay period: 1st-15th and 16th-end of month. */
export function currentPayPeriod(today = new Date().toISOString().slice(0, 10)) {
  const [y, m, d] = today.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return Number(d) <= 15
    ? { start: `${y}-${String(m).padStart(2,'0')}-01`, end: `${y}-${String(m).padStart(2,'0')}-15` }
    : { start: `${y}-${String(m).padStart(2,'0')}-16`, end: `${y}-${String(m).padStart(2,'0')}-${lastDay}` };
}
