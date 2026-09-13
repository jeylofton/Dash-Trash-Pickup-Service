/* ============================================================
   Community lifecycle: lead → waiting list → active.

   Core rule: creating a community NEVER starts service. A property
   only produces pickups once an admin explicitly activates it and
   gives it a real start date.
   ============================================================ */

import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requirePermission, setting } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { DAY_NAMES, today } from '../lib/schedule.js';
import { dollars } from '../lib/finance.js';
import { deletability, assertDeletable } from '../lib/deletable.js';
import { branding } from '../lib/branding.js';
import { availableActions, resolveAction } from '../lib/lifecycle.js';
import { COMMUNITY_LIFECYCLE, COMMUNITY_STATUSES, readiness, isServicing }
  from '../lib/community_lifecycle.js';

export const router = Router();

export const COMMUNITY_STATUS = Object.keys(COMMUNITY_STATUSES);

/* Structural fields are locked once a property has operational history:
   renaming it or changing its unit count would make old records lie. */
const LOCKED_ONCE_ESTABLISHED = ['name'];

function hasHistory(communityId) {
  const n = one(`
    SELECT (SELECT COUNT(*) FROM units u
              JOIN pickup_records pr ON pr.unit_id = u.id
             WHERE u.community_id = ?) AS pickups,
           (SELECT COUNT(*) FROM units u
              JOIN service_addresses sa ON sa.unit_id = u.id
             WHERE u.community_id = ?) AS customers`, communityId, communityId);
  return (n.pickups + n.customers) > 0;
}

const money = (c) => dollars(c || 0);

/** Estimated monthly revenue if a waiting-list community went live. */
function potentialMonthly(community) {
  const monthly = one(`SELECT price_cents FROM plans WHERE code='Monthly'`)?.price_cents ?? 2800;
  const customers = community.potential_customers ?? community.unit_count_estimate ?? 0;
  return customers * monthly;
}

/* ---------- list ---------- */

router.get('/', requirePermission('customers.view','communities.view'), (req, res) => {
  const { status, assignable } = req.query;
  /* Archived properties stay out of everyday views but are never gone:
     ask for status=archived to see them. `assignable` is what the route
     and customer screens use — only somewhere we could really service. */
  const rows = all(`
    SELECT c.*,
           (SELECT COUNT(*) FROM units u WHERE u.community_id = c.id AND u.status='active') AS unit_count,
           (SELECT COUNT(*) FROM units u
              JOIN service_addresses sa ON sa.unit_id = u.id AND sa.end_date IS NULL
             WHERE u.community_id = c.id) AS occupied_count,
           (SELECT COUNT(*) FROM community_waitlist w
             WHERE w.community_id = c.id AND w.status = 'waiting') AS waitlist_count,
           (SELECT GROUP_CONCAT(day_of_week) FROM pickup_schedules ps
             WHERE ps.community_id = c.id AND ps.active = 1) AS schedule_days,
           (SELECT COUNT(*) FROM route_stops rs WHERE rs.community_id = c.id) AS route_count
      FROM communities c
     ${status ? 'WHERE c.status = ?'
       : assignable ? `WHERE c.status NOT IN ('archived','inactive')`
       : `WHERE c.status != 'archived'`}
     ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1
                            WHEN 'driver_needed' THEN 2 WHEN 'waiting_list' THEN 3 ELSE 4 END,
              c.name`, ...(status ? [status] : []));

  res.json(rows.map(c => ({
    ...c,
    scheduleDays: (c.schedule_days || '').split(',').filter(Boolean).map(d => DAY_NAMES[Number(d)]),
    statusLabel: COMMUNITY_STATUSES[c.status]?.label ?? c.status,
    potentialMonthlyRevenue: money(potentialMonthly(c)),
    isServicing: isServicing(c.status),
  })));
});

/** Everything an operations screen needs about one property. */
router.get('/:id', requirePermission('customers.view','communities.view'), (req, res) => {
  const community = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });

  const meta = COMMUNITY_STATUSES[community.status] ?? { label: community.status, tone: '' };
  res.json({
    community: {
      ...community,
      statusLabel: meta.label,
      statusDescription: meta.description,
      isServicing: isServicing(community.status),
      heldDays: (() => { try { return JSON.parse(community.held_days || '[]'); } catch { return []; } })()
        .map(d => DAY_NAMES[Number(d)]),
      potentialMonthlyRevenue: money(potentialMonthly(community)),
    },
    schedule: all('SELECT day_of_week FROM pickup_schedules WHERE community_id = ? AND active = 1', community.id)
      .map(r => ({ day: r.day_of_week, name: DAY_NAMES[r.day_of_week] })),
    buildings: all('SELECT * FROM buildings WHERE community_id = ? ORDER BY sort_order, name', community.id),
    units: all(`
      SELECT u.*, b.name AS building_name, sa.customer_id, cu.first_name, cu.last_name
        FROM units u
        LEFT JOIN buildings b ON b.id = u.building_id
        LEFT JOIN service_addresses sa ON sa.unit_id = u.id AND sa.end_date IS NULL
        LEFT JOIN customers c ON c.id = sa.customer_id
        LEFT JOIN users cu ON cu.id = c.user_id
       WHERE u.community_id = ? ORDER BY b.sort_order, u.label`, community.id),
    routes: all(`SELECT r.id, r.name, r.day_of_week,
                        u.first_name, u.last_name
                   FROM route_stops rs
                   JOIN routes r ON r.id = rs.route_id
                   LEFT JOIN route_assignments ra ON ra.route_id = r.id AND ra.end_date IS NULL
                   LEFT JOIN employees e ON e.id = ra.employee_id
                   LEFT JOIN users u ON u.id = e.user_id
                  WHERE rs.community_id = ?`, community.id)
      .map(r => ({ ...r, dayName: DAY_NAMES[r.day_of_week] })),
    waitlist: all(`SELECT * FROM community_waitlist WHERE community_id = ?
                    ORDER BY created_at DESC`, community.id),
    statusHistory: statusHistory(community.id),
  });
});

/* ---------- create (never activates) ---------- */

router.post('/', requirePermission('customers.edit','communities.edit'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Community name is required.' });
  if (b.status && !COMMUNITY_STATUS.includes(b.status)) {
    return res.status(400).json({ error: `Status must be one of: ${COMMUNITY_STATUS.join(', ')}.` });
  }
  // A new property starts as a lead. Activation is a deliberate, separate step.
  const status = b.status && b.status !== 'active' ? b.status : 'lead';

  const id = tx(() => {
    const cid = run(
      `INSERT INTO communities (name, kind, street, city, state, zip,
                                contact_name, contact_phone, contact_email,
                                status, waiting_reason, unit_count_estimate,
                                potential_customers, tentative_start_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.kind ?? 'apartment', b.street ?? null, b.city ?? 'Columbus',
      b.state ?? 'GA', b.zip ?? null, b.contactName ?? null, b.contactPhone ?? null,
      b.contactEmail ?? null, status, b.waitingReason ?? null,
      b.unitCountEstimate ?? null, b.potentialCustomers ?? null,
      b.tentativeStartDate ?? null, b.notes ?? null).lastInsertRowid;

    run(`INSERT INTO community_status_history (community_id, from_status, to_status, changed_by, note)
         VALUES (?, NULL, ?, ?, 'Community created')`, cid, status, req.user.id);

    for (const d of b.days || []) {
      run('INSERT INTO pickup_schedules (community_id, day_of_week) VALUES (?, ?)', cid, Number(d));
    }
    return cid;
  });

  audit(req, 'community.created', {
    entityType: 'community', entityId: id,
    detail: { name: b.name, status, note: 'created without starting service' },
  });
  res.status(201).json({ id, status, message: 'Community created. It is not servicing yet.' });
});

router.patch('/:id', requirePermission('customers.edit','communities.edit'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });
  const b = req.body || {};

  /* Editing details and changing the service lifecycle are different jobs.
     Status only ever moves through the lifecycle engine, where the valid
     actions, the effective date and the reason are all checked and logged. */
  if (b.status && b.status !== c.status) {
    return res.status(400).json({
      error: 'Service status is changed through Manage Community, not by editing details.',
      code: 'USE_LIFECYCLE',
      lifecycleUrl: `/api/communities/${c.id}/lifecycle`,
      actionsUrl: `/api/communities/${c.id}/actions`,
    });
  }
  if (c.status === 'archived') {
    return res.status(409).json({
      error: 'This community is archived. Restore it before editing its details.',
      code: 'ARCHIVED',
    });
  }

  // Structural fields are locked once the property has real history.
  if (hasHistory(c.id)) {
    const attempted = LOCKED_ONCE_ESTABLISHED.filter(f => b[f] !== undefined && b[f] !== c[f]);
    if (attempted.length) {
      return res.status(409).json({
        error: `This community has operational history, so ${attempted.join(', ')} cannot be changed here.`,
        locked: attempted,
        hint: 'Renaming an established property would make older records inaccurate. Use a privileged correction if it is genuinely wrong.',
      });
    }
  }

  run(`UPDATE communities SET
         name = COALESCE(?, name), kind = COALESCE(?, kind),
         street = COALESCE(?, street), city = COALESCE(?, city),
         state = COALESCE(?, state), zip = COALESCE(?, zip),
         contact_name = COALESCE(?, contact_name), contact_phone = COALESCE(?, contact_phone),
         contact_email = COALESCE(?, contact_email),
         waiting_reason = COALESCE(?, waiting_reason),
         unit_count_estimate = COALESCE(?, unit_count_estimate),
         potential_customers = COALESCE(?, potential_customers),
         tentative_start_date = COALESCE(?, tentative_start_date),
         actual_start_date = COALESCE(?, actual_start_date),
         service_start_time = COALESCE(?, service_start_time),
         service_instructions = COALESCE(?, service_instructions),
         access_instructions = COALESCE(?, access_instructions),
         pricing_note = COALESCE(?, pricing_note),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
      b.name ?? null, b.kind ?? null, b.street ?? null, b.city ?? null, b.state ?? null,
      b.zip ?? null, b.contactName ?? null, b.contactPhone ?? null, b.contactEmail ?? null,
      b.waitingReason ?? null, b.unitCountEstimate ?? null,
      b.potentialCustomers ?? null, b.tentativeStartDate ?? null, b.actualStartDate ?? null,
      b.serviceStartTime ?? null, b.serviceInstructions ?? null, b.accessInstructions ?? null,
      b.pricingNote ?? null, b.notes ?? null, c.id);

  /* Pickup days, route and driver are operational settings, so they are
     editable here — each one effective-dated rather than overwritten. */
  const effective = b.daysEffectiveDate || today();
  let scheduleChanged = null;
  if (Array.isArray(b.days)) {
    const before = all(`SELECT day_of_week FROM pickup_schedules
                         WHERE community_id = ? AND active = 1`, c.id).map(r => r.day_of_week);
    const after = b.days.map(Number).filter(d => d >= 0 && d <= 6);
    if (before.slice().sort().join() !== after.slice().sort().join()) {
      tx(() => {
        run(`UPDATE pickup_schedules SET active = 0, end_date = date(?, '-1 day')
              WHERE community_id = ? AND active = 1`, effective, c.id);
        for (const d of after) {
          run(`INSERT INTO pickup_schedules (community_id, day_of_week, active, effective_date)
               VALUES (?, ?, 1, ?)`, c.id, d, effective);
        }
      });
      scheduleChanged = { from: before.map(d => DAY_NAMES[d]), to: after.map(d => DAY_NAMES[d]),
                          effectiveDate: effective };
    }
  }

  if (b.routeId) {
    const exists = one('SELECT id FROM route_stops WHERE route_id = ? AND community_id = ?', b.routeId, c.id);
    if (!exists) {
      run(`INSERT INTO route_stops (route_id, community_id, sort_order)
           VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM route_stops WHERE route_id = ?))`,
          b.routeId, c.id, b.routeId);
    }
    if (b.driverEmployeeId) {
      const current = one(`SELECT employee_id FROM route_assignments
                            WHERE route_id = ? AND end_date IS NULL`, b.routeId);
      if (current?.employee_id !== Number(b.driverEmployeeId)) {
        tx(() => {
          run(`UPDATE route_assignments SET end_date = date(?, '-1 day')
                WHERE route_id = ? AND end_date IS NULL`, effective, b.routeId);
          run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by, reason)
               VALUES (?, ?, ?, ?, 'Assigned from community details')`,
              b.routeId, b.driverEmployeeId, effective, req.user.id);
        });
      }
    }
  }

  audit(req, 'community.updated', {
    entityType: 'community', entityId: c.id,
    detail: { name: c.name, scheduleChanged, routeId: b.routeId ?? undefined },
  });
  res.json({ ok: true, scheduleChanged,
             message: scheduleChanged
               ? `Saved. New pickup days apply from ${effective}; earlier records are unchanged.`
               : 'Saved.' });
});

/* ============================================================
   Lifecycle: one action at a time.

   The UI asks GET /:id/actions what is valid RIGHT NOW, shows
   exactly those choices, and posts exactly one of them back to
   POST /:id/lifecycle. The server re-checks the same rules, so
   the answer does not depend on what the screen happened to draw.
   ============================================================ */

/** Options the reactivate form needs: where can this property be serviced from? */
function lifecycleContext(community, userId) {
  return {
    userId,
    readiness: readiness(community.id),
    routeOptions: all(`SELECT id, name, day_of_week FROM routes
                        WHERE status IN ('active','scheduled','draft') ORDER BY day_of_week, name`)
      .map(r => ({ value: r.id, label: `${r.name} (${DAY_NAMES[r.day_of_week]})` })),
    driverOptions: all(`SELECT e.id, u.first_name, u.last_name FROM employees e
                          JOIN users u ON u.id = e.user_id
                         WHERE e.status = 'active' ORDER BY u.first_name`)
      .map(e => ({ value: e.id, label: `${e.first_name} ${e.last_name}` })),
  };
}

/** Which single lifecycle actions this community's status allows. */
router.get('/:id/actions', requirePermission('communities.view', 'customers.view'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });

  const ctx = lifecycleContext(c, req.user.id);
  const del = deletability('community', c.id, c);
  const meta = COMMUNITY_STATUSES[c.status] ?? { label: c.status, tone: '' };

  res.json({
    community: { id: c.id, name: c.name, status: c.status },
    status: { key: c.status, ...meta, servicing: isServicing(c.status) },
    readiness: ctx.readiness,
    actions: availableActions(COMMUNITY_LIFECYCLE, c, ctx),
    // The Edit Details form needs the same route and driver lists.
    options: { routes: ctx.routeOptions, drivers: ctx.driverOptions },
    assigned: {
      days: all(`SELECT day_of_week FROM pickup_schedules
                  WHERE community_id = ? AND active = 1`, c.id).map(r => r.day_of_week),
      routeId: one('SELECT route_id FROM route_stops WHERE community_id = ?', c.id)?.route_id ?? null,
    },
    /* Permanent deletion is NOT a lifecycle action — it is only ever
       offered for a record that has never been used at all. */
    deletion: { ...del, url: `/api/communities/${c.id}` },
    statusHistory: statusHistory(c.id),
  });
});

const statusHistory = (id) => all(`
  SELECT h.*, u.first_name, u.last_name
    FROM community_status_history h
    LEFT JOIN users u ON u.id = h.changed_by
   WHERE h.community_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 50`, id)
  .map(h => ({
    ...h,
    fromLabel: COMMUNITY_STATUSES[h.from_status]?.label ?? h.from_status ?? 'New',
    toLabel: COMMUNITY_STATUSES[h.to_status]?.label ?? h.to_status,
  }));

/** Perform exactly one lifecycle action. */
export function performLifecycle(req, res, actionKey, input) {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });

  const ctx = { ...lifecycleContext(c, req.user.id), input };
  let resolved;
  try {
    resolved = resolveAction(COMMUNITY_LIFECYCLE, c, actionKey, input, ctx);
  } catch (err) {
    return res.status(err.status ?? 400).json({
      error: err.message, code: err.code,
      currentStatus: err.currentStatus, field: err.field, checks: err.checks,
    });
  }

  const { action, values, from, to } = resolved;
  const result = tx(() => {
    const out = action.run(c, values, ctx) ?? {};
    // Every lifecycle change is written down, including one that leaves
    // the status alone (moving a planned start date, for instance).
    run(`INSERT INTO community_status_history
           (community_id, from_status, to_status, changed_by, action,
            effective_date, reason, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, from, to, req.user.id, actionKey,
        values.effectiveDate ?? null, values.reason ?? null,
        values.notes ?? out.message ?? null);
    return out;
  });

  audit(req, `community.${actionKey}`, {
    entityType: 'community', entityId: c.id,
    detail: { name: c.name, from, to, effectiveDate: values.effectiveDate ?? null,
              reason: values.reason ?? null, forced: input.force === true },
  });

  res.json({
    ok: true, action: actionKey, from, to,
    statusLabel: COMMUNITY_STATUSES[to]?.label ?? to,
    ...result,
  });
}

router.post('/:id/lifecycle', requirePermission('communities.edit', 'customers.edit'), (req, res) => {
  const b = req.body || {};
  const actionKey = b.action;
  if (!actionKey) return res.status(400).json({ error: 'Choose one action to perform.' });
  // One action per request, by construction: there is nowhere to put a second.
  if (Array.isArray(actionKey)) {
    return res.status(400).json({ error: 'Only one lifecycle action can be performed at a time.' });
  }
  if (actionKey === 'archive' && !hasArchivePermission(req)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  return performLifecycle(req, res, actionKey, b);
});

const hasArchivePermission = (req) =>
  req.user?.role === 'admin' ||
  one(`SELECT allowed FROM role_permissions
        WHERE role_key = ? AND permission = 'communities.archive'`, req.user?.role)?.allowed === 1;

/* ---------- the old single-purpose endpoints, kept working ----------
   They now go through the same engine, so an older client cannot take
   a path that skips the checks. */

const delegate = (actionKey, mapBody = (b) => b) => (req, res) =>
  performLifecycle(req, res, actionKey, mapBody(req.body || {}));

router.post('/:id/hold', requirePermission('communities.edit'),
  delegate('hold', (b) => ({ ...b, effectiveDate: b.effectiveDate || today(),
                             reason: b.reason || 'other', notes: b.notes ?? b.reason ?? null })));

router.post('/:id/reactivate', requirePermission('communities.edit'), (req, res) => {
  const c = one('SELECT status FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });
  const b = req.body || {};
  // on hold → resume; cancelled → reactivate (which needs a full setup).
  const action = ['on_hold', 'paused'].includes(c.status) ? 'resume' : 'reactivate';
  return performLifecycle(req, res, action, { ...b, effectiveDate: b.effectiveDate || today() });
});

router.post('/:id/archive', requirePermission('communities.archive'), delegate('archive'));
router.post('/:id/restore', requirePermission('communities.archive'), delegate('restore'));

/**
 * Change service days with an effective date. The old schedule is closed
 * off rather than deleted, so a service record from before the change
 * still reflects the days that actually applied then.
 */
router.put('/:id/schedule', requirePermission('communities.schedule.edit'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });
  const { days, effectiveDate } = req.body || {};
  if (!Array.isArray(days)) return res.status(400).json({ error: 'days must be an array of 0-6.' });
  const effective = effectiveDate || today();

  const before = all(`SELECT day_of_week FROM pickup_schedules
                       WHERE community_id = ? AND active = 1`, c.id).map(r => r.day_of_week);

  tx(() => {
    run(`UPDATE pickup_schedules SET active = 0, end_date = date(?, '-1 day')
          WHERE community_id = ? AND active = 1`, effective, c.id);
    for (const d of days) {
      run(`INSERT INTO pickup_schedules (community_id, day_of_week, active, effective_date)
           VALUES (?, ?, 1, ?)`, c.id, Number(d), effective);
    }
  });

  audit(req, 'community.schedule_changed', {
    entityType: 'community', entityId: c.id,
    detail: { name: c.name,
              from: before.map(d => DAY_NAMES[d]), to: days.map(d => DAY_NAMES[Number(d)]),
              effectiveDate: effective },
  });
  res.json({ ok: true, effectiveDate: effective,
             message: `New schedule applies from ${effective}. Earlier records are unchanged.` });
});

/* ---------- readiness + activation ---------- */

router.get('/:id/readiness', requirePermission('customers.view','communities.view'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });
  res.json({ community: { id: c.id, name: c.name, status: c.status }, ...readiness(c.id) });
});

/** Activation is deliberate and checked — never a side effect of an edit. */
router.post('/:id/activate', requirePermission('customers.edit', 'communities.edit'), (req, res) => {
  const b = req.body || {};
  return performLifecycle(req, res, 'activate', {
    ...b, effectiveDate: b.effectiveDate || b.actualStartDate, notes: b.note ?? b.notes,
  });
});

/* ---------- driver-needed board ---------- */

router.get('/board/driver-needed', requirePermission('customers.view','communities.view'), (req, res) => {
  const rows = all(`
    SELECT c.*,
           (SELECT COUNT(*) FROM community_waitlist w
             WHERE w.community_id = c.id AND w.status='waiting') AS waitlist_count
      FROM communities c
     WHERE c.status IN ('driver_needed','waiting_list','scheduled','pending_setup')
     ORDER BY CASE c.status WHEN 'driver_needed' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
              c.tentative_start_date IS NULL, c.tentative_start_date`);

  res.json(rows.map(c => ({
    id: c.id, name: c.name, status: c.status, waitingReason: c.waiting_reason,
    units: c.unit_count_estimate, potentialCustomers: c.potential_customers,
    waitlistCount: c.waitlist_count,
    tentativeStartDate: c.tentative_start_date,
    potentialMonthlyRevenue: money(potentialMonthly(c)),
  })));
});

/* ---------- waiting list ---------- */

router.get('/:id/waitlist', requirePermission('customers.view','communities.view'), (req, res) => {
  res.json(all(`SELECT w.*, c.code AS coupon_code FROM community_waitlist w
                  LEFT JOIN coupons c ON c.id = w.coupon_id
                 WHERE w.community_id = ? ORDER BY w.created_at DESC`, req.params.id));
});

router.patch('/waitlist/:entryId', requirePermission('customers.edit','communities.edit'), (req, res) => {
  const entry = one('SELECT * FROM community_waitlist WHERE id = ?', req.params.entryId);
  if (!entry) return res.status(404).json({ error: 'Waiting-list entry not found.' });
  const { status, notes } = req.body || {};

  run(`UPDATE community_waitlist SET status = COALESCE(?, status), notes = COALESCE(?, notes),
          converted_at = CASE WHEN ? = 'converted' THEN datetime('now') ELSE converted_at END
        WHERE id = ?`, status ?? null, notes ?? null, status ?? entry.status, entry.id);

  audit(req, 'waitlist.updated', {
    entityType: 'community_waitlist', entityId: entry.id,
    detail: { email: entry.email, from: entry.status, to: status ?? entry.status },
  });
  res.json({ ok: true });
});


/* ---------- permanent deletion ---------- */

router.get('/:id/deletable', requirePermission('communities.view','customers.view'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });
  res.json({ ...deletability('community', c.id, c), name: c.name, status: c.status });
});

router.delete('/:id', requirePermission('communities.archive'), (req, res) => {
  const c = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found.' });

  try {
    assertDeletable('community', c.id, c);
  } catch (err) {
    return res.status(err.status).json({
      error: err.message, code: err.code, blockers: err.blockers, suggestion: err.suggestion,
    });
  }

  tx(() => {
    run('DELETE FROM pickup_schedules WHERE community_id = ?', c.id);
    run('DELETE FROM community_status_history WHERE community_id = ?', c.id);
    run('DELETE FROM units WHERE community_id = ?', c.id);       // none are in use, by the check above
    run('DELETE FROM buildings WHERE community_id = ?', c.id);
    run('DELETE FROM communities WHERE id = ?', c.id);
  });

  audit(req, 'community.deleted', {
    entityType: 'community', entityId: c.id,
    detail: { name: c.name, status: c.status, note: 'permanently deleted — no history existed' },
  });
  res.json({ ok: true, message: `"${c.name}" was permanently deleted.` });
});

/* ============================================================
   Public: is my community serviced, and can I join the list?
   No permission required — a prospect has no account yet.
   ============================================================ */

/** Public list of communities, with just enough detail to pick one. */
export function publicCommunityRoutes(app) {
  app.get('/api/service-check', (req, res) => {
    const zip = String(req.query.zip || '').trim();
    const rows = all(`
      SELECT id, name, status, zip, tentative_start_date
        FROM communities
       WHERE status != 'inactive' ${zip ? 'AND zip = ?' : ''}
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name`,
      ...(zip ? [zip] : []));

    res.json({
      communities: rows.map(c => ({
        id: c.id, name: c.name, zip: c.zip,
        servicing: c.status === 'active',
        tentativeStartDate: c.status === 'active' ? null : c.tentative_start_date,
        message: c.status === 'active'
          ? 'We service this community.'
          : c.tentative_start_date
            ? `${branding().name} is preparing service for this community. Tentative start: ${c.tentative_start_date}.`
            : `${branding().name} is preparing service for this community.`,
      })),
    });
  });

  /**
   * Join the waiting list. Creates NO customer, NO subscription, and
   * charges nothing — service has not started, so billing must not either.
   */
  app.post('/api/waitlist', (req, res) => {
    const b = req.body || {};
    const missing = ['firstName', 'lastName', 'email'].filter(k => !b[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing: ${missing.join(', ')}.` });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
      return res.status(400).json({ error: 'That email address is not valid.' });
    }

    const community = b.communityId ? one('SELECT * FROM communities WHERE id = ?', b.communityId) : null;
    if (b.communityId && !community) return res.status(404).json({ error: 'Community not found.' });
    if (community && community.status === 'active') {
      return res.status(400).json({
        error: 'That community is already being serviced — you can sign up normally.',
        servicing: true,
      });
    }

    if (one(`SELECT id FROM community_waitlist WHERE email = ? AND community_id IS ?`,
            b.email, b.communityId ?? null)) {
      return res.status(409).json({ error: 'You are already on the list for this community.' });
    }

    /* Promotional handling is CONFIGURABLE, not assumed:
         reserve_on_waitlist = 1 → a spot is held now
         reserve_on_waitlist = 0 → the promo only counts at activation
       Either way nothing is charged and no redemption row is written. */
    const reserve = setting('promo.reserve_on_waitlist', 0) === 1;
    const coupon = b.couponCode
      ? one('SELECT * FROM coupons WHERE code = ? AND disabled = 0', b.couponCode) : null;

    const id = run(
      `INSERT INTO community_waitlist
         (community_id, first_name, last_name, email, phone, unit_label, street, zip,
          coupon_id, promo_reserved, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.communityId ?? null, b.firstName, b.lastName, b.email, b.phone ?? null,
      b.unitLabel ?? null, b.street ?? null, b.zip ?? null,
      coupon?.id ?? null, reserve && coupon ? 1 : 0, b.notes ?? null).lastInsertRowid;

    res.status(201).json({
      ok: true, id,
      message: community
        ? `You are on the list for ${community.name}. We will email you when service starts.`
        : 'You are on the waiting list. We will email you when we reach your area.',
      tentativeStartDate: community?.tentative_start_date ?? null,
      promotion: coupon
        ? {
            code: coupon.code,
            reserved: reserve,
            note: reserve
              ? 'A promotional spot is held for you.'
              : 'Your promotional rate is applied when service begins, subject to availability.',
          }
        : null,
      billing: 'Nothing has been charged. Billing starts only when service begins.',
    });
  });
}
