/* ============================================================
   What can happen to a community, and what each thing does.

   Read this file as the answer to "an admin is looking at a
   property in status X — what may they do about it?". Nothing
   here deletes history. Hold, cancel and archive all work the
   same way: stop FUTURE service from an effective date, write
   down who decided it and why, and leave every completed
   pickup, route, photo, invoice and payment exactly as it was.
   ============================================================ */

import { one, all, run } from '../db/index.js';
import { field } from './lifecycle.js';
import { DAY_NAMES } from './schedule.js';
import { deletability } from './deletable.js';

/* ---------- the statuses a community can be in ---------- */

export const COMMUNITY_STATUSES = {
  lead:          { label: 'Lead',                tone: 'muted',  servicing: false,
                   description: 'A property we know about. Nothing is set up yet.' },
  waiting_list:  { label: 'Waiting List',        tone: 'warn',   servicing: false,
                   description: 'Residents are signing up, but service has not been committed.' },
  driver_needed: { label: 'Driver Needed',       tone: 'bad',    servicing: false,
                   description: 'Ready except that nobody is assigned to run it.' },
  pending_setup: { label: 'Pending Setup',       tone: 'warn',   servicing: false,
                   description: 'Setup is incomplete — days, route, units or driver are missing.' },
  scheduled:     { label: 'Scheduled To Start',  tone: 'pending', servicing: false,
                   description: 'A start date is planned. A tentative date does not start service.' },
  active:        { label: 'Active',              tone: 'ok',     servicing: true,
                   description: 'We are servicing this property.' },
  on_hold:       { label: 'On Hold',             tone: 'warn',   servicing: false,
                   description: 'Service is temporarily paused. Everything stays in place.' },
  inactive:      { label: 'Service Cancelled',   tone: 'bad',    servicing: false,
                   description: 'We no longer service this property. All history is kept.' },
  archived:      { label: 'Archived',            tone: 'muted',  servicing: false,
                   description: 'Out of day-to-day views. Still fully available for reporting.' },
  // Legacy spelling of on_hold. Migrated away, kept so an old row still renders.
  paused:        { label: 'On Hold',             tone: 'warn',   servicing: false,
                   description: 'Service is temporarily paused.' },
};

export const SERVICING_STATUS = 'active';
export const isServicing = (status) => status === SERVICING_STATUS;

const HOLD_REASONS = [
  { value: 'property_request', label: 'Property management requested a pause' },
  { value: 'resident_volume',  label: 'Not enough residents signed up right now' },
  { value: 'staffing',         label: 'Staffing / no driver available' },
  { value: 'seasonal',         label: 'Seasonal or construction pause' },
  { value: 'billing',          label: 'Billing or contract issue' },
  { value: 'other',            label: 'Other (explain in notes)' },
];

const CANCEL_REASONS = [
  { value: 'contract_ended',   label: 'Property contract ended' },
  { value: 'property_request', label: 'Property management cancelled' },
  { value: 'non_payment',      label: 'Non-payment' },
  { value: 'not_profitable',   label: 'Not profitable to service' },
  { value: 'no_driver',        label: 'No driver available long term' },
  { value: 'out_of_area',      label: 'Outside our service area' },
  { value: 'other',            label: 'Other (explain in notes)' },
];

/* What every stop-service action leaves untouched. The UI shows this
   on the confirmation screen so nobody thinks they are deleting data. */
const PRESERVED = [
  'Customers and their accounts',
  'Completed pickups and photos',
  'Route and employee history',
  'Invoices, payments, credits and expenses',
  'The audit trail',
];

const dateField = (name, label, hint) => field(name, label, 'date', { hint });

/* ---------- readiness: what must be true before service starts ---------- */

export function readiness(communityId) {
  const schedule = all(`SELECT day_of_week FROM pickup_schedules
                         WHERE community_id = ? AND active = 1`, communityId);
  const stops = all('SELECT route_id FROM route_stops WHERE community_id = ?', communityId);
  const drivers = stops.length ? all(`
    SELECT ra.employee_id FROM route_assignments ra
     WHERE ra.route_id IN (${stops.map(() => '?').join(',')}) AND ra.end_date IS NULL`,
    ...stops.map(s => s.route_id)) : [];
  const units = one(`SELECT COUNT(*) AS n FROM units
                      WHERE community_id = ? AND status = 'active'`, communityId).n;

  const checks = [
    { key: 'schedule', ok: schedule.length > 0, label: 'Pickup days configured',
      fix: 'Set the pickup days under Edit Details.' },
    { key: 'route',    ok: stops.length > 0,    label: 'On at least one route',
      fix: 'Add this community as a stop on a route.' },
    { key: 'driver',   ok: drivers.length > 0,  label: 'A driver is assigned to that route',
      fix: 'Assign a driver to the route in Route Management.' },
    { key: 'units',    ok: units > 0,           label: 'Units exist for the property',
      fix: 'Add the units for this property.' },
  ];
  return { checks, ready: checks.every(c => c.ok), missing: checks.filter(c => !c.ok) };
}

const notReady = (record, ctx) => {
  const r = ctx.readiness ?? readiness(record.id);
  return r.ready ? null
    : `Not ready to start service: ${r.missing.map(c => c.label.toLowerCase()).join(', ')}.`;
};

/* Reactivation asks for the days, route and driver on its own form, so
   only the things the form CANNOT supply may block it. Units belong to
   the property itself — there is nothing to service without them. */
const noUnits = (record) =>
  one(`SELECT COUNT(*) AS n FROM units WHERE community_id = ? AND status = 'active'`, record.id).n > 0
    ? null
    : 'This property has no units yet. Add its units before reactivating service.';

/* ---------- schedule effects (future only, never retroactive) ---------- */

/** Active pickup days right now. */
const currentDays = (id) =>
  all(`SELECT day_of_week FROM pickup_schedules WHERE community_id = ? AND active = 1`, id)
    .map(r => r.day_of_week);

/**
 * Stop generating pickups from `effective` onward. The schedule rows are
 * closed off with an end date rather than deleted, so a pickup that
 * happened last month still points at the days that applied then.
 */
function stopSchedule(id, effective) {
  const days = currentDays(id);
  run(`UPDATE pickup_schedules SET active = 0, end_date = date(?, '-1 day')
        WHERE community_id = ? AND active = 1`, effective, id);
  return days;
}

/** Clear work that has not happened yet. Completed and issue stops stay. */
function clearFutureStops(id, effective) {
  return run(`DELETE FROM service_stops
               WHERE status = 'pending' AND service_date >= ?
                 AND unit_id IN (SELECT id FROM units WHERE community_id = ?)`,
             effective, id).changes;
}

/** Put the paused days back, starting on the resume date. */
function startSchedule(id, days, effective) {
  for (const d of days) {
    run(`INSERT INTO pickup_schedules (community_id, day_of_week, active, effective_date, end_date)
         VALUES (?, ?, 1, ?, NULL)`, id, Number(d), effective);
  }
  return days.map(d => DAY_NAMES[Number(d)]);
}

const parseDays = (json) => { try { return JSON.parse(json || '[]'); } catch { return []; } };

/* ---------- the actions ---------- */

export const COMMUNITY_LIFECYCLE = {
  entity: 'community',
  statusField: 'status',
  statuses: COMMUNITY_STATUSES,

  actions: {
    /* --- starting service --- */

    activate: {
      label: 'Activate Service',
      description: 'Begin real pickups at this property on a specific date.',
      tone: 'primary',
      from: ['scheduled', 'pending_setup', 'driver_needed', 'waiting_list', 'lead'],
      to: 'active',
      overridable: true,          // an admin may force past the checks, and it is audited
      blockedBy: notReady,
      fields: () => [
        dateField('effectiveDate', 'Actual start date', 'The first day we really service this property.'),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Start service at ${c.name}?`,
      effects: ['Pickups begin generating from the start date.',
                'Everyone on the waiting list is marked notified.'],
      preserves: PRESERVED,
      run(c, v, ctx) {
        run(`UPDATE communities SET status='active', actual_start_date = ?,
               waiting_reason = NULL, hold_effective_date = NULL, hold_reason = NULL,
               held_days = NULL, cancelled_effective_date = NULL, cancellation_reason = NULL
             WHERE id = ?`, v.effectiveDate, c.id);
        run(`UPDATE community_waitlist SET status='notified', notified_at = datetime('now')
              WHERE community_id = ? AND status = 'waiting'`, c.id);
        const notified = one(`SELECT COUNT(*) n FROM community_waitlist
                               WHERE community_id = ? AND status='notified'`, c.id).n;
        return { message: `Service starts ${v.effectiveDate}.`, waitlistNotified: notified,
                 forced: Boolean(ctx.input?.force) };
      },
    },

    change_start_date: {
      label: 'Change Start Date',
      description: 'Move the planned start. This does NOT activate service.',
      from: ['scheduled', 'pending_setup', 'driver_needed', 'waiting_list'],
      // Status is unchanged: a planned date is still only a plan.
      fields: () => [
        dateField('effectiveDate', 'New tentative start date'),
        field('reason', 'Why is it moving?', 'text', { required: false }),
      ],
      confirmTitle: (c) => `Move the planned start for ${c.name}?`,
      effects: ['Only the tentative date changes. Nothing is activated.'],
      run(c, v) {
        run('UPDATE communities SET tentative_start_date = ? WHERE id = ?', v.effectiveDate, c.id);
        return { message: `Planned start moved to ${v.effectiveDate}. Service is still not active.` };
      },
    },

    /* --- pausing --- */

    hold: {
      label: 'Put Service On Hold',
      description: 'Temporarily pause pickups. Everything stays in place and can be resumed.',
      tone: 'warn',
      from: ['active'],
      to: 'on_hold',
      fields: () => [
        dateField('effectiveDate', 'Effective date', 'The first day WITHOUT service.'),
        field('reason', 'Reason', 'select', { options: HOLD_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Put service on hold for ${c.name}?`,
      effects: ['No pickups are generated on or after the effective date.',
                'Scheduled work still in the future is cleared.',
                'The pickup days are remembered so Resume puts them back.'],
      preserves: PRESERVED,
      run(c, v) {
        const days = stopSchedule(c.id, v.effectiveDate);
        const cleared = clearFutureStops(c.id, v.effectiveDate);
        run(`UPDATE communities SET status='on_hold', hold_effective_date = ?, hold_reason = ?,
                held_days = ?, waiting_reason = ? WHERE id = ?`,
            v.effectiveDate, v.reason, JSON.stringify(days),
            labelFor(HOLD_REASONS, v.reason), c.id);
        return { message: `Service is on hold from ${v.effectiveDate}.`,
                 heldDays: days.map(d => DAY_NAMES[d]), futureStopsCleared: cleared };
      },
    },

    hold_setup: {
      label: 'Put Setup On Hold',
      description: 'Pause getting this property ready. Nothing is lost.',
      tone: 'warn',
      from: ['waiting_list', 'driver_needed', 'pending_setup', 'scheduled', 'lead'],
      to: 'on_hold',
      fields: () => [
        dateField('effectiveDate', 'Effective date'),
        field('reason', 'Reason', 'select', { options: HOLD_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Put setup on hold for ${c.name}?`,
      effects: ['Setup stops. The waiting list and everything else stays.'],
      preserves: PRESERVED,
      run(c, v) {
        const days = stopSchedule(c.id, v.effectiveDate);
        run(`UPDATE communities SET status='on_hold', hold_effective_date = ?, hold_reason = ?,
                held_days = ?, waiting_reason = ? WHERE id = ?`,
            v.effectiveDate, v.reason, JSON.stringify(days),
            labelFor(HOLD_REASONS, v.reason), c.id);
        return { message: `Setup is on hold from ${v.effectiveDate}.` };
      },
    },

    resume: {
      label: 'Resume Service',
      description: 'Start servicing again from a chosen date.',
      tone: 'primary',
      from: ['on_hold', 'paused'],
      to: 'active',
      fields: () => [
        dateField('effectiveDate', 'Resume date', 'The first day service runs again.'),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Resume service at ${c.name}?`,
      effects: (c) => {
        const days = parseDays(c.held_days).map(d => DAY_NAMES[Number(d)]);
        return [days.length
          ? `Pickups resume on ${days.join(' & ')} from the resume date.`
          : 'Pickup days need to be set under Edit Details before work is generated.',
          'Nothing that happened before the hold is changed.'];
      },
      run(c, v) {
        const days = parseDays(c.held_days);
        const restored = days.length ? startSchedule(c.id, days, v.effectiveDate) : [];
        run(`UPDATE communities SET status='active', hold_effective_date = NULL,
                hold_reason = NULL, held_days = NULL, waiting_reason = NULL,
                actual_start_date = COALESCE(actual_start_date, ?) WHERE id = ?`,
            v.effectiveDate, c.id);
        return { message: `Service resumes ${v.effectiveDate}.`, restoredDays: restored,
                 warning: restored.length ? null
                   : 'No pickup days were on file — set them before the resume date.' };
      },
    },

    /* --- ending service (never deletion) --- */

    cancel: {
      label: 'Cancel Service',
      description: 'We stop servicing this property. Nothing is deleted and it can be reactivated later.',
      tone: 'danger',
      from: ['active', 'on_hold', 'paused'],
      to: 'inactive',
      fields: () => [
        dateField('effectiveDate', 'Cancellation effective date', 'The first day WITHOUT service.'),
        field('reason', 'Cancellation reason', 'select', { options: CANCEL_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Cancel service for ${c.name}?`,
      effects: ['No pickups are generated on or after the effective date.',
                'The community drops off active route work from that date.',
                'It can be reactivated later with a new start date.'],
      preserves: PRESERVED,
      run(c, v) {
        stopSchedule(c.id, v.effectiveDate);
        const cleared = clearFutureStops(c.id, v.effectiveDate);
        run(`UPDATE communities SET status='inactive', cancelled_effective_date = ?,
                cancellation_reason = ?, cancellation_note = ?, held_days = NULL,
                hold_effective_date = NULL, waiting_reason = ? WHERE id = ?`,
            v.effectiveDate, v.reason, v.notes ?? null,
            labelFor(CANCEL_REASONS, v.reason), c.id);
        return { message: `Service cancelled effective ${v.effectiveDate}. History is intact.`,
                 futureStopsCleared: cleared };
      },
    },

    cancel_planned: {
      label: 'Cancel Planned Service',
      description: 'Call off a start that never happened. The record and its waiting list stay.',
      tone: 'danger',
      from: ['scheduled', 'pending_setup', 'driver_needed'],
      to: 'inactive',
      fields: () => [
        dateField('effectiveDate', 'Effective date', 'The first day the planned start is off the books.'),
        field('reason', 'Reason', 'select', { options: CANCEL_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Cancel the planned service for ${c.name}?`,
      effects: ['The planned start is called off. Nothing that exists is removed.'],
      preserves: PRESERVED,
      run(c, v) {
        stopSchedule(c.id, v.effectiveDate);
        run(`UPDATE communities SET status='inactive', cancelled_effective_date = ?,
                cancellation_reason = ?, cancellation_note = ?, waiting_reason = ? WHERE id = ?`,
            v.effectiveDate, v.reason, v.notes ?? null, labelFor(CANCEL_REASONS, v.reason), c.id);
        return { message: 'The planned start was cancelled.' };
      },
    },

    cancel_setup: {
      label: 'Cancel Setup',
      description: 'Stop pursuing this property. The record and any waiting list stay.',
      tone: 'danger',
      from: ['waiting_list', 'lead'],
      to: 'inactive',
      fields: () => [
        field('reason', 'Reason', 'select', { options: CANCEL_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Cancel setup for ${c.name}?`,
      effects: ['The property stops being worked. Waiting-list entries are kept.'],
      preserves: PRESERVED,
      run(c, v) {
        run(`UPDATE communities SET status='inactive', cancellation_reason = ?,
                cancellation_note = ?, waiting_reason = ? WHERE id = ?`,
            v.reason, v.notes ?? null, labelFor(CANCEL_REASONS, v.reason), c.id);
        return { message: 'Setup cancelled. Nothing was deleted.' };
      },
    },

    reactivate: {
      label: 'Reactivate Community',
      description: 'Start servicing this property again. Needs a real start date and a working setup.',
      tone: 'primary',
      from: ['inactive'],
      to: 'active',
      overridable: true,
      blockedBy: noUnits,
      fields: (c, ctx) => [
        dateField('effectiveDate', 'New start date', 'The first day service runs again.'),
        field('days', 'Pickup days', 'days', { hint: 'These replace the old schedule from the start date.' }),
        field('routeId', 'Assigned route', 'select',
              { options: (ctx.routeOptions ?? []), hint: 'The route that will service this property.' }),
        field('driverEmployeeId', 'Assigned driver', 'select',
              { required: false, options: (ctx.driverOptions ?? []),
                hint: 'Leave blank to keep whoever already runs that route.' }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Reactivate ${c.name}?`,
      effects: ['Pickups generate again from the new start date.',
                'The old cancelled period stays in the record exactly as it was.'],
      preserves: PRESERVED,
      run(c, v, ctx) {
        // Close the old schedule, then open a new one from the start date.
        run(`UPDATE pickup_schedules SET active = 0, end_date = COALESCE(end_date, date(?, '-1 day'))
              WHERE community_id = ? AND active = 1`, v.effectiveDate, c.id);
        const days = (Array.isArray(v.days) ? v.days : [v.days]).map(Number).filter(d => d >= 0 && d <= 6);
        startSchedule(c.id, days, v.effectiveDate);

        if (v.routeId) {
          const exists = one('SELECT id FROM route_stops WHERE route_id = ? AND community_id = ?',
                             v.routeId, c.id);
          if (!exists) {
            run(`INSERT INTO route_stops (route_id, community_id, sort_order)
                 VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1
                                  FROM route_stops WHERE route_id = ?))`,
                v.routeId, c.id, v.routeId);
          }
          if (v.driverEmployeeId) {
            run(`UPDATE route_assignments SET end_date = date(?, '-1 day')
                  WHERE route_id = ? AND end_date IS NULL`, v.effectiveDate, v.routeId);
            run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by, reason)
                 VALUES (?, ?, ?, ?, 'Community reactivated')`,
                v.routeId, v.driverEmployeeId, v.effectiveDate, ctx.userId ?? null);
          }
        }

        run(`UPDATE communities SET status='active', actual_start_date = ?,
                cancelled_effective_date = NULL, cancellation_reason = NULL,
                cancellation_note = NULL, waiting_reason = NULL, archived_at = NULL
             WHERE id = ?`, v.effectiveDate, c.id);
        return { message: `Reactivated. Service resumes ${v.effectiveDate}.`,
                 days: days.map(d => DAY_NAMES[d]) };
      },
    },

    /* --- filing away --- */

    archive: {
      label: 'Archive Community',
      description: 'Move it out of day-to-day views. Every record stays and stays reportable.',
      tone: 'warn',
      from: ['lead', 'waiting_list', 'driver_needed', 'pending_setup',
             'scheduled', 'active', 'on_hold', 'paused', 'inactive'],
      to: 'archived',
      fields: () => [
        field('notes', 'Why is it being archived?', 'textarea', { required: false }),
      ],
      confirmTitle: (c) => `Archive ${c.name}?`,
      effects: ['No pickups are generated.',
                'It disappears from active route and customer screens.',
                'It stays visible under the Archived filter and in every report.'],
      preserves: PRESERVED,
      run(c) {
        const today = new Date().toISOString().slice(0, 10);
        stopSchedule(c.id, today);
        const cleared = clearFutureStops(c.id, today);
        run(`UPDATE communities SET status='archived', archived_at = datetime('now') WHERE id = ?`, c.id);
        const counts = one(`
          SELECT (SELECT COUNT(*) FROM units WHERE community_id = ?) AS units,
                 (SELECT COUNT(*) FROM units u JOIN pickup_records pr ON pr.unit_id = u.id
                   WHERE u.community_id = ?) AS pickups,
                 (SELECT COUNT(*) FROM units u JOIN service_addresses sa ON sa.unit_id = u.id
                   WHERE u.community_id = ?) AS customers`, c.id, c.id, c.id);
        return { message: `Archived. ${counts.pickups} pickup record(s) and ` +
                          `${counts.customers} customer link(s) remain in history.`,
                 preserved: counts, futureStopsCleared: cleared };
      },
    },

    restore: {
      label: 'Restore From Archive',
      description: 'Bring it back into normal views as a cancelled (inactive) property.',
      from: ['archived'],
      to: 'inactive',
      fields: () => [field('notes', 'Notes', 'textarea', { required: false })],
      confirmTitle: (c) => `Restore ${c.name} from the archive?`,
      effects: ['It returns as Service Cancelled — restoring does not start service.',
                'Reactivate it afterwards to begin pickups again.'],
      run(c) {
        run(`UPDATE communities SET status='inactive', archived_at = NULL WHERE id = ?`, c.id);
        return { message: 'Restored. It is not servicing — reactivate it to start pickups.' };
      },
    },
  },
};

const labelFor = (options, value) => options.find(o => o.value === value)?.label ?? value ?? null;

/**
 * Everything the Manage Community screen needs: where this property
 * stands, what may be done about it, and whether permanent deletion
 * is honestly available.
 */
export function communityLifecycleView(community, ctx = {}) {
  const check = ctx.readiness ?? readiness(community.id);
  const del = deletability('community', community.id, community);
  return { readiness: check, deletion: del };
}
