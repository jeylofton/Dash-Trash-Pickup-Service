/* ============================================================
   Coupons (marketing) and service credits (service recovery).
   Kept apart throughout: separate tables, routes, and reports.
   ============================================================ */

import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requireAuth, requireEmployee, currentEmployee } from '../lib/rbac.js';
import { requirePermission, hasPermission, setting, setSetting, permissionsFor } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import {
  DISCOUNT_TYPES, withStatus, usedCount, validate, computeDiscount, customerType, introCoupon,
} from '../lib/coupons.js';
import { REASONS, REASON_LABELS, GRANTED, createCredit, decide, customerBalanceCents } from '../lib/credits.js';
import { resolveRange, dollars, pct } from '../lib/finance.js';
import { deletability, assertDeletable } from '../lib/deletable.js';

export const router = Router();

const money = (c) => dollars(c || 0);

/* ============================================================
   COUPONS — manage (admin or a manager with coupons.manage)
   ============================================================ */

router.get('/coupons', requirePermission('coupons.view','coupons.create','coupons.edit'), (req, res) => {
  res.json(all('SELECT * FROM coupons ORDER BY is_intro DESC, created_at DESC').map(c => {
    const w = withStatus(c);
    const stats = one(`
      SELECT COUNT(*) AS uses,
             SUM(CASE WHEN customer_type='new' THEN 1 ELSE 0 END) AS new_customers,
             SUM(CASE WHEN customer_type='existing' THEN 1 ELSE 0 END) AS existing_customers,
             COALESCE(SUM(final_price_cents),0) AS revenue_cents,
             COALESCE(SUM(discount_cents),0) AS discount_cents
        FROM coupon_redemptions WHERE coupon_id = ? AND status='completed'`, c.id);
    return {
      ...w,
      discountValue: c.discount_type === 'percent' ? c.discount_value : money(c.discount_value),
      newCustomers: stats.new_customers || 0,
      existingCustomers: stats.existing_customers || 0,
      revenue: money(stats.revenue_cents),
      discountGiven: money(stats.discount_cents),
      avgRevenuePerRedemption: stats.uses ? money(Math.round(stats.revenue_cents / stats.uses)) : 0,
      eligiblePlans: all(`SELECT p.code FROM coupon_plans cp JOIN plans p ON p.id = cp.plan_id
                           WHERE cp.coupon_id = ?`, c.id).map(r => r.code),
    };
  }));
});

router.post('/coupons', requirePermission('coupons.create'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'Code and name are required.' });
  if (!DISCOUNT_TYPES.includes(b.discountType)) {
    return res.status(400).json({ error: `Discount type must be one of: ${DISCOUNT_TYPES.join(', ')}.` });
  }
  if (one('SELECT id FROM coupons WHERE code = ?', b.code)) {
    return res.status(409).json({ error: 'That coupon code already exists.' });
  }

  // percent is a whole number; everything else is cents
  const value = b.discountType === 'percent'
    ? Math.round(Number(b.discountValue))
    : Math.round(Number(b.discountValue) * 100);
  if (!Number.isFinite(value) || value < 0) {
    return res.status(400).json({ error: 'Enter a valid discount amount.' });
  }
  if (b.discountType === 'percent' && value > 100) {
    return res.status(400).json({ error: 'A percentage discount cannot exceed 100.' });
  }

  const id = run(
    `INSERT INTO coupons (code, name, description, discount_type, discount_value,
                          starts_at, ends_at, max_redemptions, per_customer_limit,
                          eligible_customer_type, allow_stacking, is_intro, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.code.trim(), b.name, b.description ?? null, b.discountType, value,
    b.startsAt ?? null, b.endsAt ?? null,
    b.maxRedemptions != null && b.maxRedemptions !== '' ? Number(b.maxRedemptions) : null,
    b.perCustomerLimit ?? 'once', b.eligibleCustomerType ?? 'all',
    b.allowStacking ? 1 : 0, b.isIntro ? 1 : 0, req.user.id).lastInsertRowid;

  for (const planCode of b.eligiblePlans || []) {
    const plan = one('SELECT id FROM plans WHERE code = ?', planCode);
    if (plan) run('INSERT OR IGNORE INTO coupon_plans (coupon_id, plan_id) VALUES (?, ?)', id, plan.id);
  }

  audit(req, 'coupon.created', {
    entityType: 'coupon', entityId: id,
    detail: { code: b.code, type: b.discountType, value: b.discountValue, maxRedemptions: b.maxRedemptions ?? null },
  });
  res.status(201).json({ id });
});

router.patch('/coupons/:id', requirePermission('coupons.edit','coupons.disable'), (req, res) => {
  const c = one('SELECT * FROM coupons WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Coupon not found.' });
  const b = req.body || {};

  const before = { name: c.name, ends_at: c.ends_at, max_redemptions: c.max_redemptions, disabled: c.disabled };
  run(`UPDATE coupons SET name = COALESCE(?, name), description = COALESCE(?, description),
                          starts_at = COALESCE(?, starts_at), ends_at = COALESCE(?, ends_at),
                          max_redemptions = COALESCE(?, max_redemptions),
                          per_customer_limit = COALESCE(?, per_customer_limit),
                          eligible_customer_type = COALESCE(?, eligible_customer_type),
                          allow_stacking = COALESCE(?, allow_stacking),
                          disabled = COALESCE(?, disabled)
        WHERE id = ?`,
      b.name ?? null, b.description ?? null, b.startsAt ?? null, b.endsAt ?? null,
      b.maxRedemptions ?? null, b.perCustomerLimit ?? null, b.eligibleCustomerType ?? null,
      b.allowStacking == null ? null : (b.allowStacking ? 1 : 0),
      b.disabled == null ? null : (b.disabled ? 1 : 0), c.id);

  const after = one('SELECT * FROM coupons WHERE id = ?', c.id);
  audit(req, 'coupon.updated', {
    entityType: 'coupon', entityId: c.id,
    detail: { code: c.code, before, after: { name: after.name, ends_at: after.ends_at,
              max_redemptions: after.max_redemptions, disabled: after.disabled } },
  });
  res.json({ ok: true });
});

router.get('/coupons/:id/deletable', requirePermission('coupons.view'), (req, res) => {
  const c = one('SELECT * FROM coupons WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Coupon not found.' });
  res.json({ ...deletability('coupon', c.id, c), name: c.name, code: c.code });
});

router.delete('/coupons/:id', requirePermission('coupons.edit'), (req, res) => {
  const c = one('SELECT * FROM coupons WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Coupon not found.' });

  try {
    assertDeletable('coupon', c.id, c);
  } catch (err) {
    return res.status(err.status).json({
      error: err.message, code: err.code, blockers: err.blockers,
      suggestion: 'Disable this coupon instead — its redemption history stays intact.',
    });
  }

  tx(() => {
    run('DELETE FROM coupon_plans WHERE coupon_id = ?', c.id);
    run('DELETE FROM coupons WHERE id = ?', c.id);
  });
  audit(req, 'coupon.deleted', { entityType: 'coupon', entityId: c.id,
                                 detail: { code: c.code, name: c.name, note: 'never redeemed' } });
  res.json({ ok: true, message: `Coupon ${c.code} was permanently deleted.` });
});

/** Redemption history — never deleted, searchable. */
router.get('/coupons/:id/redemptions', requirePermission('coupons.view','coupons.create','coupons.edit'), (req, res) => {
  res.json(all(`
    SELECT r.*, u.first_name, u.last_name, u.email, p.code AS plan_code
      FROM coupon_redemptions r
      JOIN customers c ON c.id = r.customer_id
      JOIN users u ON u.id = c.user_id
      LEFT JOIN subscriptions s ON s.id = r.subscription_id
      LEFT JOIN plans p ON p.id = s.plan_id
     WHERE r.coupon_id = ? ORDER BY r.redeemed_at DESC LIMIT 500`, req.params.id)
    .map(r => ({ ...r,
      originalPrice: money(r.original_price_cents),
      discount: money(r.discount_cents),
      finalPrice: money(r.final_price_cents) })));
});

/** Coupon analytics + chart series. */
router.get('/coupon-analytics', requirePermission('coupons.analytics.view'), (req, res) => {
  const { start, end } = resolveRange(req.query.range, req.query.from, req.query.to);

  const byCoupon = all(`
    SELECT c.id, c.code, c.name, c.max_redemptions,
           COUNT(r.id) AS uses,
           SUM(CASE WHEN r.customer_type='new' THEN 1 ELSE 0 END) AS new_customers,
           SUM(CASE WHEN r.customer_type='existing' THEN 1 ELSE 0 END) AS existing_customers,
           COALESCE(SUM(r.final_price_cents),0) AS revenue_cents,
           COALESCE(SUM(r.discount_cents),0) AS discount_cents
      FROM coupons c
      LEFT JOIN coupon_redemptions r
        ON r.coupon_id = c.id AND r.status='completed'
       AND date(r.redeemed_at) BETWEEN ? AND ?
     GROUP BY c.id ORDER BY uses DESC`, start, end);

  res.json({
    range: { start, end },
    coupons: byCoupon.map(c => ({
      id: c.id, code: c.code, name: c.name,
      uses: c.uses, maxRedemptions: c.max_redemptions,
      remaining: c.max_redemptions == null ? null : Math.max(0, c.max_redemptions - usedCount(c.id)),
      newCustomers: c.new_customers || 0, existingCustomers: c.existing_customers || 0,
      revenue: money(c.revenue_cents), discountGiven: money(c.discount_cents),
      avgRevenuePerRedemption: c.uses ? money(Math.round(c.revenue_cents / c.uses)) : 0,
    })),
    redemptionsOverTime: all(`
      SELECT date(redeemed_at) AS bucket,
             COUNT(*) AS total,
             SUM(CASE WHEN customer_type='new' THEN 1 ELSE 0 END) AS new_customers,
             SUM(CASE WHEN customer_type='existing' THEN 1 ELSE 0 END) AS existing_customers
        FROM coupon_redemptions
       WHERE status='completed' AND date(redeemed_at) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`, start, end),
    revenueByCoupon: byCoupon.filter(c => c.uses)
      .map(c => ({ label: c.code, amount: money(c.revenue_cents) })),
    discountByCoupon: byCoupon.filter(c => c.uses)
      .map(c => ({ label: c.code, amount: money(c.discount_cents) })),
    newVsExisting: [
      { label: 'New customers', amount: byCoupon.reduce((a, c) => a + (c.new_customers || 0), 0) },
      { label: 'Existing customers', amount: byCoupon.reduce((a, c) => a + (c.existing_customers || 0), 0) },
    ],
  });
});

/* ---------- public: check a code without redeeming it ---------- */
router.post('/coupons/validate', (req, res) => {
  const { code, planCode, priceDollars } = req.body || {};
  const plan = planCode ? one('SELECT * FROM plans WHERE code = ?', planCode) : null;
  const priceCents = priceDollars != null
    ? Math.round(Number(priceDollars) * 100)
    : (plan?.price_cents ?? 0);

  const customer = req.user?.role === 'customer'
    ? one('SELECT id FROM customers WHERE user_id = ?', req.user.id) : null;

  const result = validate({
    code, planId: plan?.id, customerId: customer?.id, priceCents,
  });

  if (!result.ok) return res.status(200).json({ ok: false, reason: result.reason });
  res.json({
    ok: true,
    code: result.coupon.code,
    name: result.coupon.name,
    description: result.coupon.description,
    originalPrice: money(result.quote.originalCents),
    discount: money(result.quote.discountCents),
    finalPrice: money(result.quote.finalCents),
    note: 'Checking a code does not reserve it. The discount applies when payment completes.',
  });
});

/* ============================================================
   SERVICE CREDITS
   ============================================================ */

router.get('/credits/reasons', requireAuth, (req, res) => {
  res.json({
    reasons: REASONS.map(r => ({ value: r, label: REASON_LABELS[r] })),
    employeeMaxDollars: money(setting('credit.employee_max_cents', 500)),
  });
});

/** Employees issue credits here; managers/admins may also use it. */
router.post('/credits', requireAuth, (req, res) => {
  const b = req.body || {};
  const isPrivileged = hasPermission(req.user, 'credits.approve');
  const employee = currentEmployee(req);

  if (!employee && !isPrivileged) {
    return res.status(404).json({ error: 'Not found.' });
  }
  if (!b.customerId) return res.status(400).json({ error: 'A customer is required.' });

  const amountCents = Math.round(Number(b.amount) * 100);

  try {
    const credit = createCredit({
      customerId: Number(b.customerId),
      userId: req.user.id,
      employeeId: employee?.id ?? null,
      amountCents,
      reason: b.reason,
      notes: b.notes,
      pickupRecordId: b.pickupRecordId ?? null,
      communityId: b.communityId ?? null,
      routeId: b.routeId ?? null,
      isPrivileged,
    });

    audit(req, 'credit.requested', {
      entityType: 'service_credit', entityId: credit.id,
      detail: { customerId: Number(b.customerId), requested: money(amountCents),
                reason: b.reason, status: credit.status },
    });

    const autoLimit = money(setting('credit.employee_max_cents', 500));
    res.status(201).json({
      ok: true,
      id: credit.id,
      status: credit.status,
      approvedAmount: credit.approved_cents != null ? money(credit.approved_cents) : null,
      message: credit.status === 'auto_approved'
        ? `$${money(amountCents).toFixed(2)} credit applied to the customer's account.`
        : credit.status === 'approved'
          ? `$${money(amountCents).toFixed(2)} credit approved and applied.`
          : `Credit above $${autoLimit.toFixed(2)} — sent to a manager for approval.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** An employee sees only the credits they requested. */
router.get('/credits/mine', requireAuth, requireEmployee, (req, res) => {
  res.json(all(`
    SELECT sc.*, u.first_name, u.last_name
      FROM service_credits sc
      JOIN customers c ON c.id = sc.customer_id
      JOIN users u ON u.id = c.user_id
     WHERE sc.requested_by_employee_id = ?
     ORDER BY sc.requested_at DESC LIMIT 100`, req.employee.id)
    .map(c => ({ ...c, reasonLabel: REASON_LABELS[c.reason],
                 requested: money(c.requested_cents),
                 approved: c.approved_cents != null ? money(c.approved_cents) : null })));
});

/* ---------- approval queue ---------- */

router.get('/credits', requirePermission('credits.approve'), (req, res) => {
  const { status, limit = 200 } = req.query;
  res.json(all(`
    SELECT sc.*, cu.first_name AS customer_first, cu.last_name AS customer_last,
           eu.first_name AS emp_first, eu.last_name AS emp_last,
           au.first_name AS approver_first, au.last_name AS approver_last,
           com.name AS community_name, r.name AS route_name
      FROM service_credits sc
      JOIN customers c ON c.id = sc.customer_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN employees e ON e.id = sc.requested_by_employee_id
      LEFT JOIN users eu ON eu.id = e.user_id
      LEFT JOIN users au ON au.id = sc.approved_by_user_id
      LEFT JOIN communities com ON com.id = sc.community_id
      LEFT JOIN routes r ON r.id = sc.route_id
     ${status ? 'WHERE sc.status = ?' : ''}
     ORDER BY CASE sc.status WHEN 'pending' THEN 0 ELSE 1 END, sc.requested_at DESC
     LIMIT ?`, ...(status ? [status] : []), Number(limit))
    .map(c => ({ ...c, reasonLabel: REASON_LABELS[c.reason],
                 requested: money(c.requested_cents),
                 approved: c.approved_cents != null ? money(c.approved_cents) : null })));
});

router.post('/credits/:id/decide', requirePermission('credits.approve'), (req, res) => {
  const { decision, approvedAmount, notes } = req.body || {};
  try {
    const { before, after } = decide({
      creditId: Number(req.params.id),
      decision,
      approvedCents: approvedAmount != null ? Math.round(Number(approvedAmount) * 100) : undefined,
      userId: req.user.id,
      decisionNotes: notes,
    });
    audit(req, `credit.${decision}`, {
      entityType: 'service_credit', entityId: after.id,
      detail: {
        customerId: after.customer_id,
        requested: money(before.requested_cents),
        approved: after.approved_cents != null ? money(after.approved_cents) : null,
        from: before.status, to: after.status, notes: notes ?? null,
      },
    });
    res.json({ ok: true, status: after.status });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------- credit reporting ---------- */

router.get('/credit-report', requirePermission('credits.reports.view','reports.view'), (req, res) => {
  const { start, end } = resolveRange(req.query.range, req.query.from, req.query.to);
  const inRange = `date(requested_at) BETWEEN '${start}' AND '${end}'`;

  const totals = one(`
    SELECT COALESCE(SUM(CASE WHEN ${GRANTED} THEN COALESCE(approved_cents, requested_cents) END),0) AS granted,
           COALESCE(SUM(CASE WHEN status='pending' THEN requested_cents END),0) AS pending,
           COUNT(CASE WHEN ${GRANTED} THEN 1 END) AS granted_count,
           COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_count
      FROM service_credits WHERE ${inRange}`);

  const group = (col, join = '') => all(`
    SELECT ${col} AS label,
           COUNT(*) AS count,
           COALESCE(SUM(COALESCE(sc.approved_cents, sc.requested_cents)),0) AS cents
      FROM service_credits sc ${join}
     WHERE ${GRANTED.replace(/status/g, 'sc.status')} AND date(sc.requested_at) BETWEEN ? AND ?
     GROUP BY label ORDER BY cents DESC`, start, end);

  res.json({
    range: { start, end },
    totals: {
      granted: money(totals.granted), grantedCount: totals.granted_count,
      pending: money(totals.pending), pendingCount: totals.pending_count,
    },
    byReason: group('sc.reason').map(r => ({ ...r, label: REASON_LABELS[r.label] || r.label, amount: money(r.cents) })),
    byEmployee: group("COALESCE(u.first_name || ' ' || u.last_name, 'Manager/Admin')",
      'LEFT JOIN employees e ON e.id = sc.requested_by_employee_id LEFT JOIN users u ON u.id = e.user_id')
      .map(r => ({ ...r, amount: money(r.cents) })),
    byCommunity: group("COALESCE(com.name, 'Unassigned')",
      'LEFT JOIN communities com ON com.id = sc.community_id').map(r => ({ ...r, amount: money(r.cents) })),
    byRoute: group("COALESCE(r.name, 'Unassigned')",
      'LEFT JOIN routes r ON r.id = sc.route_id').map(r => ({ ...r, amount: money(r.cents) })),
  });
});

/** Per-employee credit activity — oversight, not a ranking. */
router.get('/credit-activity', requirePermission('reports.view'), (req, res) => {
  res.json(all(`
    SELECT e.id AS employee_id, u.first_name, u.last_name,
           COUNT(CASE WHEN ${GRANTED.replace(/status/g, 'sc.status')}
                       AND strftime('%Y-%m', sc.requested_at) = strftime('%Y-%m','now')
                      THEN 1 END) AS issued_this_month,
           COALESCE(SUM(CASE WHEN ${GRANTED.replace(/status/g, 'sc.status')}
                              AND strftime('%Y-%m', sc.requested_at) = strftime('%Y-%m','now')
                             THEN COALESCE(sc.approved_cents, sc.requested_cents) END),0) AS cents_this_month,
           COUNT(CASE WHEN sc.status='pending' THEN 1 END) AS pending
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN service_credits sc ON sc.requested_by_employee_id = e.id
     WHERE e.status = 'active'
     GROUP BY e.id ORDER BY cents_this_month DESC`)
    .map(r => ({
      employeeId: r.employee_id, name: `${r.first_name} ${r.last_name}`,
      issuedThisMonth: r.issued_this_month, totalThisMonth: money(r.cents_this_month),
      averageCredit: r.issued_this_month ? money(Math.round(r.cents_this_month / r.issued_this_month)) : 0,
      pending: r.pending,
    })));
});

/* ---------- settings + permissions ---------- */

router.get('/settings', requirePermission('reports.view'), (req, res) => {
  res.json({
    settings: all('SELECT * FROM app_settings ORDER BY key'),
    myPermissions: permissionsFor(req.user.role),
  });
});

router.patch('/settings/:key', requirePermission('system.settings.manage'), (req, res) => {
  const s = one('SELECT * FROM app_settings WHERE key = ?', req.params.key);
  if (!s) return res.status(404).json({ error: 'Unknown setting.' });
  const value = Number(req.body?.value);
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Enter a valid number.' });

  setSetting(s.key, Math.round(value), req.user.id);
  audit(req, 'setting.changed', {
    entityType: 'app_setting', detail: { key: s.key, from: s.value, to: String(Math.round(value)) },
  });
  res.json({ ok: true });
});

router.get('/role-permissions', requirePermission('system.roles.manage'), (req, res) => {
  res.json(all('SELECT * FROM role_permissions ORDER BY role, permission'));
});

router.patch('/role-permissions', requirePermission('system.permissions.manage'), (req, res) => {
  const { role, permission, allowed } = req.body || {};
  if (role === 'admin') return res.status(400).json({ error: 'Admin permissions cannot be restricted.' });
  const existing = one('SELECT * FROM role_permissions WHERE role = ? AND permission = ?', role, permission);
  if (!existing) return res.status(404).json({ error: 'Unknown role permission.' });

  run('UPDATE role_permissions SET allowed = ? WHERE role = ? AND permission = ?',
      allowed ? 1 : 0, role, permission);
  audit(req, 'role_permission.changed', {
    detail: { role, permission, from: Boolean(existing.allowed), to: Boolean(allowed) },
  });
  res.json({ ok: true });
});
