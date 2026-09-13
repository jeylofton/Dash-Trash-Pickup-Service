# Self-Billing Architecture — Design

**Date:** 2026-09-13
**Status:** Approved, pending spec review
**Supersedes:** the Square Subscriptions approach in
`2026-09-13-square-payment-setup-design.md`

## Problem

Square currently owns the customer, the plan, the price and the billing
schedule. The database already models every one of those things, so the two
systems duplicate and contradict each other:

- `coupons` / `coupon_redemptions` cannot apply, because Square owns the price.
  `redeem()` has no callers.
- `subscriptions.locked_price_cents` is meaningless when Square decides what to
  charge.
- `subscriptions.next_billing_date` is never used — only a self-run biller
  needs it.
- Public signups reach Square but never SQLite, so a paying customer is absent
  from the dashboard and cannot log in.

**Decision: Square becomes a payment rail only.** It vaults cards and processes
charges. The database owns customers, plans, prices, schedules and discounts.

The schema was already designed for this. `next_billing_date`, `past_due`,
`payments.failure_reason` and `locked_price_cents` only make sense in a
self-billing system. Square Subscriptions was the piece that did not fit.

## Square's reduced surface

| API | Kept | Why |
|---|---|---|
| Customers | Yes | A card cannot be vaulted without one |
| Cards | Yes | The vault |
| Payments | Yes | Charging |
| Subscriptions | **No** | The database owns the schedule |
| Catalog | **No** | The database owns plans and prices |

**Data sent to Square:** given name, family name, email, phone, and
`reference_id` pointing at the local customer row. Name and email make
chargeback disputes defensible and Square's own receipts usable; `reference_id`
lets a charge be traced from either side. Billing ZIP goes on the card for AVS
fraud checks.

**Deliberately not sent:** street address and unit. That is a service address,
not billing data, and Square has no use for it.

## Phasing

Three phases. Each is independently valuable and testable. Phase 1 blocks
phase 2, because a new customer cannot get portal access without it.

---

# Phase 1 — Email foundation and set-password flow

## Why first

Signup must create a `users` row, and `users.password_hash` is NOT NULL. The
customer sets their password through an emailed link, so email has to exist
before checkout can create accounts.

## `lib/mail/` — same provider pattern as `lib/payments/`

```
lib/mail/index.js    provider selection, one interface
lib/mail/smtp.js     nodemailer over SMTP — works with any provider
lib/mail/console.js  development transport, prints to stdout
```

Interface: `send({ to, subject, text, html })`.

`MAIL_PROVIDER=console` is the default, so **every later phase can be built and
tested before an email account exists**. Switching to real delivery is an env
change, exactly like `PAYMENT_PROVIDER`.

SMTP over a provider-specific API because it works with any host — the domain's
own mail, Gmail, or a transactional service — without locking the project in.

## Token flow

```
password_tokens — id, user_id, token_hash, purpose, expires_at, used_at
```

`purpose` covers `set_password` and `reset_password` from one table. Tokens are
stored hashed, so a database leak does not hand over account access. Single
use, 72-hour expiry for a new account.

Routes: `GET /set-password?token=` (page) and `POST /api/auth/set-password`.

## Templates

Set password, payment receipt, payment failed, service paused. Plain text and
HTML, rendered from one small helper. Receipts and failure notices are used in
phase 3.

## Verification

Console transport prints a usable link; token expiry, reuse and tampering each
rejected; a set password logs into the customer portal.

---

# Phase 2 — Signup persists, Square reduced to vault and charge

## Schema

```sql
-- A customer replacing an expired card must not lose payment history.
CREATE TABLE payment_methods (
  id, customer_id, provider, provider_card_id,
  brand, last_4, exp_month, exp_year,
  is_default, status, created_at
);

-- Freeze the promotion the way locked_price_cents freezes the plan price,
-- so editing a coupon later never re-prices an existing customer.
ALTER TABLE subscriptions ADD COLUMN promo_price_cents INTEGER;
ALTER TABLE subscriptions ADD COLUMN promo_periods_remaining INTEGER;

-- Lets a discount say "for N months". The engine cannot express that today.
ALTER TABLE coupons ADD COLUMN duration_periods INTEGER;  -- NULL = forever
```

## The introductory rate stops being a plan

Intro becomes **the Monthly plan plus the DASHLAUNCH coupon** — which is what
`discount_type='promo_price'`, `discount_value=1800`, `max_redemptions=100`,
`is_intro=1` already describes.

Consequences: `redeem()` is finally called, `coupon_redemptions` becomes the
real counter, the 100-spot cap enforces itself inside `redeem()`'s transaction,
and the introductory offer appears in the existing discount reports.

The separate `Introductory` plan row is deactivated.

## Checkout rewrite

Ordered so money is never taken for a record that does not exist:

1. **Transaction:** `users` (customer role, no password yet) + `customers` +
   service address/unit link + `subscriptions` (`pending`) + `payments`
   (`pending`).
2. Vault the card in Square.
3. Charge, using a **derived** idempotency key: `sub:<id>:<billing_date>`.
4. **Transaction:** mark `payments` paid and `subscriptions` active, set
   `next_billing_date`, call `redeem()`.
5. Send the set-password email.

If step 4 fails after a successful charge, the pending rows already exist and
reconcile by `reference_id`. There is never a silent charge with no record.

The introductory spot is reserved inside `redeem()`'s transaction rather than
in `signups.json`, which retires along with `store.js`.

## Cleanup

Delete the four subscription plan variations from the Square sandbox catalog,
drop `SQUARE_PLAN_*` from `.env` and `.env.production.example`, delete
`bin/square-setup.js` and its npm scripts, remove `createSubscription` and
`cancelSubscription` from the Square client, and update the README.

## Verification

A signup creates every local row; the charge appears in Square with a matching
`reference_id`; the new customer appears in the admin dashboard and can log in
after setting their password; the public spot counter decrements; a declined
card leaves no orphan rows and no reserved spot; a replayed request does not
double-charge.

---

# Phase 3 — Recurring billing and dunning

## `lib/billing.js`

```
chargeSubscription(sub)   one period, one charge
runDueBilling()           everything where next_billing_date <= today
```

**Idempotency is the safety property of this phase.** The key is derived from
subscription id and billing date, never random. A double run, a crash mid-charge
or two overlapping timers all return Square's original payment instead of
charging twice.

Price for a period: `promo_price_cents` when `promo_periods_remaining > 0`,
otherwise `locked_price_cents`. On success, decrement the promo counter and
advance `next_billing_date` by `plans.interval_months`.

## Dunning

Failure marks the payment `failed` with `failure_reason` and the subscription
`past_due`. Retries at **days 1, 3 and 7**. Still failing after day 7, the
subscription becomes `paused` and the customer drops off the pickup route. The
state is visible in the admin dashboard throughout.

Emails: receipt on success, failure notice with a card-update link on each
failed attempt, service-paused notice at the end.

## Scheduler

`setInterval` following the existing `purgeExpiredSessions` idiom at
`server.js:409`, plus an admin-triggered run and a CLI so a month does not have
to pass to test it.

## Verification

A subscription due today charges exactly once; running the biller twice in a
row produces one payment; the promo counter decrements and the price rises to
$28 on period 13; three failures pause the subscription on the right days; the
finance dashboard totals match the payments written.

## Out of scope, all phases

Proration on mid-cycle plan changes. Refunds through the dashboard. Stripe.
Tax calculation. Paper invoices.
