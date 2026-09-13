import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requireRole, requireCustomer } from '../lib/rbac.js';
import { audit } from '../lib/audit.js';
import { payments as provider, providerName } from '../lib/payments/index.js';
import { DAY_NAMES, today } from '../lib/schedule.js';

export const router = Router();
router.use(requireRole('customer'), requireCustomer);

/* Every query below is scoped by req.customer.id, which comes from the
   SESSION. No customer id is ever read from the URL or body, so there is
   no id to tamper with. */

const money = (cents) => cents / 100;

function myAddress(customerId) {
  return one(`
    SELECT un.id AS unit_id, un.label, un.street, un.zip,
           b.name AS building, com.id AS community_id, com.name AS community,
           com.status AS community_status, com.hold_effective_date, com.cancelled_effective_date
      FROM service_addresses sa
      JOIN units un ON un.id = sa.unit_id
      LEFT JOIN buildings b ON b.id = un.building_id
      LEFT JOIN communities com ON com.id = un.community_id
     WHERE sa.customer_id = ? AND sa.end_date IS NULL`, customerId);
}

function myScheduleDays(address) {
  if (!address) return [];
  const rows = address.community_id
    ? all('SELECT day_of_week FROM pickup_schedules WHERE community_id = ? AND active = 1', address.community_id)
    : all('SELECT day_of_week FROM pickup_schedules WHERE unit_id = ? AND active = 1', address.unit_id);
  return rows.map(r => r.day_of_week).sort();
}

function nextPickupDate(days) {
  if (!days.length) return null;
  const now = new Date();
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    if (days.includes(d.getDay())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/* ---------- Account overview ---------- */

/* When a property's service is paused or ended there are no pickup days,
   and "no pickup days" on its own reads like a bug. Say what is going on. */
function serviceNotice(address) {
  if (!address?.community_status) return null;
  if (address.community_status === 'on_hold' || address.community_status === 'paused') {
    return { state: 'on_hold',
             message: `Pickups at ${address.community} are temporarily paused` +
               (address.hold_effective_date ? ` from ${address.hold_effective_date}` : '') +
               '. We will let you know as soon as service resumes.' };
  }
  if (address.community_status === 'inactive') {
    return { state: 'cancelled',
             message: `We are no longer servicing ${address.community}` +
               (address.cancelled_effective_date ? ` as of ${address.cancelled_effective_date}` : '') + '.' };
  }
  if (address.community_status === 'archived') {
    return { state: 'cancelled', message: `We are no longer servicing ${address.community}.` };
  }
  return null;
}

router.get('/account', (req, res) => {
  const address = myAddress(req.customer.id);
  const days = myScheduleDays(address);
  const notice = serviceNotice(address);

  const subscription = one(`
    SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.interval_months
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.customer_id = ? AND s.status != 'cancelled'
     ORDER BY s.id DESC LIMIT 1`, req.customer.id);

  res.json({
    profile: {
      firstName: req.user.first_name, lastName: req.user.last_name,
      email: req.user.email, phone: req.user.phone,
    },
    account: { status: req.customer.status, isIntro: Boolean(req.customer.is_intro) },
    address,
    schedule: { days, dayNames: days.map(d => DAY_NAMES[d]), nextPickup: nextPickupDate(days),
                notice },
    subscription: subscription && {
      plan: subscription.plan_name,
      planCode: subscription.plan_code,
      intervalMonths: subscription.interval_months,
      price: money(subscription.locked_price_cents),
      status: subscription.status,
      nextBillingDate: subscription.next_billing_date,
      startedAt: subscription.started_at,
    },
  });
});

router.patch('/profile', (req, res) => {
  const { phone, email } = req.body || {};
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'That email address is not valid.' });
  }
  if (email && one('SELECT id FROM users WHERE email = ? AND id != ?', email, req.user.id)) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }
  run(`UPDATE users SET phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?`,
      phone ?? null, email ?? null, req.user.id);
  audit(req, 'customer.profile_updated', { entityType: 'customer', entityId: req.customer.id });
  res.json({ ok: true });
});

/* ---------- Plans and payments ---------- */

router.get('/plans', (req, res) => {
  const current = one(`
    SELECT s.*, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.customer_id = ? AND s.status != 'cancelled' ORDER BY s.id DESC LIMIT 1`, req.customer.id);

  // An introductory customer keeps their locked price. Show it, but do not
  // offer the introductory plan to anyone who is not already on it.
  const available = all(`SELECT id, code, name, interval_months, price_cents, is_intro
                           FROM plans WHERE active = 1`)
    .filter(p => !p.is_intro || current?.code === 'Introductory')
    .map(p => ({
      code: p.code, name: p.name, intervalMonths: p.interval_months,
      price: money(p.price_cents), isIntro: Boolean(p.is_intro),
      isCurrent: current?.plan_id === p.id,
      lockedPrice: current?.plan_id === p.id ? money(current.locked_price_cents) : null,
    }));

  res.json({ plans: available, currentPlanCode: current?.code ?? null });
});

/* Credits a customer can see. Deliberately excludes internal notes,
   who requested it, and any approval discussion. */
router.get('/credits', (req, res) => {
  const rows = all(
    `SELECT id, reason, COALESCE(approved_cents, requested_cents) AS cents, requested_at
       FROM service_credits
      WHERE customer_id = ? AND status IN ('auto_approved','approved','modified','applied')
      ORDER BY requested_at DESC LIMIT 50`, req.customer.id);

  const LABELS = {
    missed_pickup: 'Missed pickup credit', late_pickup: 'Late pickup credit',
    service_error: 'Service credit', damaged_property: 'Property credit',
    customer_complaint: 'Service credit', billing_adjustment: 'Billing adjustment',
    courtesy: 'Courtesy credit', other: 'Service credit',
  };

  res.json({
    balance: money(rows.reduce((a, r) => a + r.cents, 0)),
    credits: rows.map(r => ({
      id: r.id, label: LABELS[r.reason] || 'Service credit',
      amount: money(r.cents), date: r.requested_at,
    })),
  });
});

router.get('/payments', (req, res) => {
  res.json(all(`
    SELECT p.id, p.amount_cents, p.status, p.paid_at, p.failure_reason, p.created_at,
           pl.name AS plan_name
      FROM payments p
      LEFT JOIN subscriptions s ON s.id = p.subscription_id
      LEFT JOIN plans pl ON pl.id = s.plan_id
     WHERE p.customer_id = ?
     ORDER BY p.created_at DESC LIMIT 50`, req.customer.id)
    .map(p => ({ ...p, amount: money(p.amount_cents) })));
});

/** Change plan. The introductory price is never silently lost or granted. */
router.post('/plan/change', (req, res) => {
  const { planCode } = req.body || {};
  const plan = one('SELECT * FROM plans WHERE code = ? AND active = 1', planCode);
  if (!plan) return res.status(400).json({ error: 'That plan is not available.' });

  const current = one(`
    SELECT s.*, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.customer_id = ? AND s.status != 'cancelled' ORDER BY s.id DESC LIMIT 1`, req.customer.id);
  if (!current) return res.status(400).json({ error: 'You do not have an active subscription.' });
  if (current.plan_id === plan.id) return res.status(400).json({ error: 'You are already on that plan.' });

  // Nobody can switch INTO the introductory plan - those 100 spots are
  // earned at signup only.
  if (plan.is_intro && current.code !== 'Introductory') {
    return res.status(403).json({ error: 'The introductory rate is not available on plan changes.' });
  }

  const previous = { plan: current.code, price: money(current.locked_price_cents) };

  tx(() => {
    run(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now'),
                                  cancel_reason = 'plan change' WHERE id = ?`, current.id);
    run(`INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents, status, provider,
                                    started_at, next_billing_date)
         VALUES (?, ?, ?, 'pending', ?, date('now'), date('now','+' || ? || ' days'))`,
        req.customer.id, plan.id, plan.price_cents, providerName, String(30 * plan.interval_months));
    // Leaving the introductory plan gives up the promotional flag.
    if (current.code === 'Introductory' && !plan.is_intro) {
      run('UPDATE customers SET is_intro = 0 WHERE id = ?', req.customer.id);
    }
  });

  audit(req, 'subscription.plan_changed', {
    entityType: 'customer', entityId: req.customer.id,
    detail: { from: previous, to: { plan: plan.code, price: money(plan.price_cents) } },
  });

  res.json({
    ok: true,
    message: `Plan changed to ${plan.name}. It takes effect on your next billing date.`,
    warning: current.code === 'Introductory'
      ? 'You have given up your introductory rate. It cannot be restored.'
      : null,
  });
});

router.post('/cancel', async (req, res) => {
  const { reason } = req.body || {};
  const current = one(`SELECT * FROM subscriptions WHERE customer_id = ? AND status != 'cancelled'
                        ORDER BY id DESC LIMIT 1`, req.customer.id);
  if (!current) return res.status(400).json({ error: 'You do not have an active subscription.' });

  // Tell the payment provider first; a local cancel with a live subscription
  // at the provider would keep charging the customer.
  if (current.provider_subscription_id) {
    try {
      await provider.cancelSubscription(current.provider_subscription_id);
    } catch (err) {
      console.error('[customer] provider cancel failed', err);
      return res.status(502).json({
        error: 'We could not cancel billing automatically. Please contact support so you are not charged again.',
      });
    }
  }

  tx(() => {
    run(`UPDATE subscriptions SET status='cancelled', cancelled_at=datetime('now'), cancel_reason=?
          WHERE id = ?`, reason ?? 'customer request', current.id);
    run(`UPDATE customers SET status='cancelled' WHERE id = ?`, req.customer.id);
  });

  audit(req, 'subscription.cancelled', {
    entityType: 'customer', entityId: req.customer.id, detail: { reason: reason ?? null },
  });
  res.json({ ok: true, message: 'Your service has been cancelled.' });
});

/* ---------- Service history ---------- */

router.get('/history', (req, res) => {
  res.json(all(`
    SELECT pr.id, pr.service_date, pr.status, pr.issue_code, pr.notes, pr.completed_at,
           un.label AS unit_label,
           eu.first_name AS employee_first,
           ph.id AS photo_id
      FROM pickup_records pr
      JOIN units un ON un.id = pr.unit_id
      LEFT JOIN employees e ON e.id = pr.employee_id
      LEFT JOIN users eu ON eu.id = e.user_id
      LEFT JOIN pickup_photos ph ON ph.pickup_record_id = pr.id
     WHERE pr.customer_id = ?
     ORDER BY pr.service_date DESC, pr.completed_at DESC LIMIT 100`, req.customer.id));
});

router.get('/notes', (req, res) => {
  res.json(all(`SELECT id, body, created_at FROM customer_notes
                 WHERE customer_id = ? AND visible_to_customer = 1
                 ORDER BY created_at DESC`, req.customer.id));
});
