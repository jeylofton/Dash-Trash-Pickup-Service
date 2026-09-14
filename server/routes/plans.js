/* ============================================================
   Admin subscription-plan management. CRUD, the lifecycle engine,
   and effective-dated price changes — every mutation permission-gated
   and audited. Customer-facing plan selection lives in routes/customer.js.
   ============================================================ */

import { Router } from 'express';
import { one, all } from '../db/index.js';
import { requirePermission } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { availableActions, resolveAction } from '../lib/lifecycle.js';
import { PLAN_LIFECYCLE, PLAN_STATUSES } from '../lib/plan_lifecycle.js';
import { frequencyLabel, perLabel, INTERVAL_UNITS } from '../lib/billing.js';
import {
  createPlan, updatePlan, duplicatePlan, deletePlan,
  planDeletability, planCustomerCount, schedulePriceChange, applyDuePriceChanges,
  cancelPriceChange,
} from '../lib/plans.js';

export const router = Router();
const money = (cents) => cents / 100;
const centsFrom = (body, dollarsKey, centsKey) =>
  body[centsKey] != null ? Math.round(Number(body[centsKey]))
  : body[dollarsKey] != null ? Math.round(Number(body[dollarsKey]) * 100) : null;

function shape(p) {
  return {
    id: p.id, code: p.code, name: p.name, description: p.description,
    internalNotes: p.internal_notes,
    priceCents: p.price_cents, price: money(p.price_cents), currency: p.currency,
    intervalUnit: p.interval_unit, intervalCount: p.interval_count,
    frequency: frequencyLabel(p.interval_unit, p.interval_count),
    perLabel: perLabel(p.interval_unit, p.interval_count),
    customerAvailable: Boolean(p.customer_available),
    status: p.status, statusLabel: PLAN_STATUSES[p.status]?.label ?? p.status,
    displayOrder: p.display_order, label: p.label,
    customers: planCustomerCount(p.id),
  };
}

function validIntervals(body) {
  if (body.intervalUnit && !INTERVAL_UNITS.includes(body.intervalUnit)) {
    return 'Billing unit must be week, month, or year.';
  }
  if (body.intervalCount != null && !(Number(body.intervalCount) >= 1)) {
    return 'Billing count must be a whole number of 1 or more.';
  }
  return null;
}

/* ---- list ---- */
router.get('/', requirePermission('plans.view'), (req, res) => {
  applyDuePriceChanges();
  // Plain anonymous `?` bound positionally — portable across every node:sqlite
  // version. A numbered `?1` threw "column index out of range" on the host's
  // (older) Node build, 500-ing this route in production while localhost (newer
  // Node) tolerated it.
  const rows = all(`SELECT * FROM plans WHERE status != 'archived' OR ? = 1
                     ORDER BY display_order, id`,
                   req.query.includeArchived ? 1 : 0);
  res.json({ plans: rows.map(shape) });
});

/* ---- one, with actions + deletability + price-change history ---- */
router.get('/:id', requirePermission('plans.view'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  res.json({
    plan: shape(p),
    actions: availableActions(PLAN_LIFECYCLE, p),
    deletion: planDeletability(p.id),
    priceChanges: all(`SELECT * FROM plan_price_changes WHERE plan_id = ? ORDER BY id DESC`, p.id)
      .map(pc => ({ id: pc.id, from: money(pc.old_price_cents), to: money(pc.new_price_cents),
                    appliesTo: pc.applies_to, effectiveDate: pc.effective_date,
                    status: pc.status, reason: pc.reason })),
  });
});

/* ---- create ---- */
router.post('/', requirePermission('plans.create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'A plan name is required.' });
  const priceCents = centsFrom(b, 'priceDollars', 'priceCents');
  if (priceCents == null || priceCents < 0) return res.status(400).json({ error: 'A price is required.' });
  const bad = validIntervals(b);
  if (bad) return res.status(400).json({ error: bad });
  if (b.status && !['draft', 'active', 'inactive'].includes(b.status)) {
    return res.status(400).json({ error: 'Status must be draft, active, or inactive.' });
  }
  const { id } = createPlan({
    name: b.name, description: b.description, internalNotes: b.internalNotes,
    priceCents, intervalUnit: b.intervalUnit || 'month', intervalCount: Number(b.intervalCount) || 1,
    customerAvailable: b.customerAvailable, status: b.status || 'draft',
    displayOrder: b.displayOrder, label: b.label, currency: b.currency,
  }, req.user.id);
  audit(req, 'plan.created', { entityType: 'plan', entityId: id, detail: { name: b.name } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, id)) });
});

/* ---- edit (details only; status is lifecycle) ---- */
router.patch('/:id', requirePermission('plans.edit'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const bad = validIntervals(b);
  if (bad) return res.status(400).json({ error: bad });
  const priceCents = centsFrom(b, 'priceDollars', 'priceCents');
  updatePlan(p.id, {
    name: b.name, description: b.description, internalNotes: b.internalNotes,
    priceCents: priceCents ?? undefined,
    intervalUnit: b.intervalUnit, intervalCount: b.intervalCount != null ? Number(b.intervalCount) : undefined,
    customerAvailable: b.customerAvailable, displayOrder: b.displayOrder, label: b.label, currency: b.currency,
  }, req.user.id);
  audit(req, 'plan.updated', { entityType: 'plan', entityId: p.id, detail: { fields: Object.keys(b) } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});

/* ---- duplicate ---- */
router.post('/:id/duplicate', requirePermission('plans.create'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { id } = duplicatePlan(p.id, req.user.id);
  audit(req, 'plan.duplicated', { entityType: 'plan', entityId: id, detail: { from: p.id } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, id)) });
});

/* ---- delete (only when nothing references it) ---- */
router.delete('/:id', requirePermission('plans.archive'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  try {
    deletePlan(p.id);
  } catch (err) {
    return res.status(err.status || 409).json({ error: err.message });
  }
  audit(req, 'plan.deleted', { entityType: 'plan', entityId: p.id, detail: { name: p.name } });
  res.json({ ok: true });
});

/* ---- lifecycle ---- */
router.get('/:id/actions', requirePermission('plans.view'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  // Shape matches what the shared lifecycleControl UI expects: a status
  // OBJECT (label/tone/description), a name for delete confirmation, and a
  // deletion URL for the DELETE request.
  const meta = PLAN_STATUSES[p.status] ?? { label: p.status, tone: '' };
  res.json({
    name: p.name,
    status: { key: p.status, ...meta },
    actions: availableActions(PLAN_LIFECYCLE, p),
    deletion: { ...planDeletability(p.id), url: `/api/admin/plans/${p.id}` },
  });
});

router.post('/:id/action', requirePermission('plans.status', 'plans.archive'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { action, ...input } = req.body || {};
  let resolved;
  try {
    resolved = resolveAction(PLAN_LIFECYCLE, p, action, input, {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  const result = resolved.action.run(p, resolved.values, { userId: req.user.id, input });
  audit(req, `plan.${action}`, { entityType: 'plan', entityId: p.id,
    detail: { from: resolved.from, to: resolved.to } });
  res.json({ ok: true, ...result, plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});

/* ---- price change ---- */
router.post('/:id/price-change', requirePermission('plans.edit'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const newPriceCents = centsFrom(b, 'newPriceDollars', 'newPriceCents');
  if (newPriceCents == null || newPriceCents < 0) return res.status(400).json({ error: 'A new price is required.' });
  if (!['new', 'existing_and_new'].includes(b.appliesTo)) {
    return res.status(400).json({ error: 'appliesTo must be "new" or "existing_and_new".' });
  }
  if (b.appliesTo === 'existing_and_new' && b.effectiveDate &&
      b.effectiveDate < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'The effective date cannot be in the past.' });
  }
  const out = schedulePriceChange(p.id, {
    newPriceCents, appliesTo: b.appliesTo, effectiveDate: b.effectiveDate || null, reason: b.reason,
  }, req.user.id);
  audit(req, 'plan.price_change', { entityType: 'plan', entityId: p.id,
    detail: { to: money(newPriceCents), appliesTo: b.appliesTo, effectiveDate: out.effectiveDate } });
  res.json({ ok: true, effectiveDate: out.effectiveDate,
             plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});

router.post('/:id/price-change/:pcid/cancel', requirePermission('plans.edit'), (req, res) => {
  const p = one(`SELECT id FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  try {
    cancelPriceChange(p.id, Number(req.params.pcid));
  } catch (err) {
    return res.status(err.status || 409).json({ error: err.message });
  }
  audit(req, 'plan.price_change_cancelled', { entityType: 'plan', entityId: p.id,
    detail: { priceChangeId: Number(req.params.pcid) } });
  res.json({ ok: true });
});
