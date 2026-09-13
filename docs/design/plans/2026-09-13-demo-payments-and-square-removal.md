# Demo Payments and Square Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every trace of Square, replace it with a provider-neutral payment layer whose only implementation is a DEMO provider that simulates outcomes, and make a simulated successful payment create real local records — customer, subscription, payment, coupon redemption.

**Architecture:** `lib/payments/index.js` exposes one provider-neutral interface; `demo.js` is the only implementation and never touches a network or a card number. `/api/checkout` becomes the single path that creates `users`, `customers`, `service_addresses`, `subscriptions` and `payments` in one transaction, then calls the provider, then records the outcome and redeems the coupon. The database is the source of truth; a provider only ever returns an opaque id and a status.

**Tech Stack:** Node 26, Express 4, `node:sqlite` (built in), `node:test` (built in — no new dependency), vanilla JS frontend.

## Global Constraints

- **No real card data, ever.** The demo checkout must not render a card-number input or accept a PAN. Copy: `Demo Mode – No Real Payment Will Be Processed.`
- **No Square.** No Square SDK, API call, token, id, webhook, route, env var, or credential. The app must boot with no payment credentials set.
- **`PAYMENT_PROVIDER=demo`** is the default and the only working value.
- Demo transactions are identified by `payments.provider = 'demo'`. No separate boolean — one fact, one place.
- Do not remove or redesign existing dashboard features, roles, routes, community/employee management, reporting, coupons, or service credits.
- **Introductory rate is $18/month for 12 months, then $28/month.** Confirmed by the user on 2026-09-13, overriding the un-termed wording in feature-update items 11 and 14. The disclosure copy already in `index.html` and `scripts.js` is correct and must be kept.
- Item 18 still holds: once a customer has the promotional rate, nothing later — promotion expiry, the 100th signup, an admin price change, or the coupon being disabled — may alter their price or their remaining promotional periods.
- Preserve `subscriptions.locked_price_cents` semantics: an existing customer's price never changes because a coupon or plan was edited later.
- Existing code style: ESM, 2-space indent, comments explain *why*. Follow it.

---

### Task 1: Test harness and the payment provider interface

**Files:**
- Create: `server/test/demo-provider.test.js`
- Create: `server/lib/payments/demo.js`
- Modify: `server/lib/payments/index.js`
- Modify: `server/package.json`
- Delete: `server/lib/payments/square.js`, `server/lib/payments/stripe.js`, `server/bin/square-setup.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `payments.createCustomer({firstName,lastName,email,phone}) -> {providerCustomerId}`; `payments.savePaymentMethod({providerCustomerId,cardholderName,billingZip}) -> {providerMethodId,brand,last4,expMonth,expYear}`; `payments.charge({amountCents,providerCustomerId,providerMethodId,idempotencyKey,reference,outcome}) -> {providerPaymentId,status,failureReason}`; `payments.refund({providerPaymentId,amountCents,idempotencyKey}) -> {providerRefundId,status}`; `payments.describeError(err) -> string`; `providerName` string; `OUTCOMES` array.
- `charge` status is one of `'paid'|'failed'|'pending'` — these are exactly the values `payments.status` accepts, so no translation layer is needed.

- [ ] **Step 1: Write the failing test**

```js
// server/test/demo-provider.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as demo from '../lib/payments/demo.js';

test('success outcome returns a paid charge with a demo id', async () => {
  const r = await demo.charge({
    amountCents: 1800, providerCustomerId: 'demo_cus_1',
    providerMethodId: 'demo_pm_1', idempotencyKey: 'k1',
    reference: 'pay:1', outcome: 'success',
  });
  assert.equal(r.status, 'paid');
  assert.match(r.providerPaymentId, /^demo_pay_/);
  assert.equal(r.failureReason, null);
});

test('declined and failed outcomes never return paid', async () => {
  for (const outcome of ['declined', 'failed']) {
    const r = await demo.charge({
      amountCents: 1800, providerCustomerId: 'demo_cus_1',
      providerMethodId: 'demo_pm_1', idempotencyKey: 'k-' + outcome,
      reference: 'pay:1', outcome,
    });
    assert.equal(r.status, 'failed', outcome);
    assert.ok(r.failureReason, 'failure reason is required');
  }
});

test('pending outcome returns pending', async () => {
  const r = await demo.charge({
    amountCents: 1800, providerCustomerId: 'demo_cus_1',
    providerMethodId: 'demo_pm_1', idempotencyKey: 'k2',
    reference: 'pay:1', outcome: 'pending',
  });
  assert.equal(r.status, 'pending');
});

test('same idempotency key returns the identical charge', async () => {
  const args = {
    amountCents: 1800, providerCustomerId: 'demo_cus_1',
    providerMethodId: 'demo_pm_1', idempotencyKey: 'repeat-me',
    reference: 'pay:1', outcome: 'success',
  };
  const a = await demo.charge(args);
  const b = await demo.charge(args);
  assert.deepEqual(a, b, 'a replay must not produce a second charge');
});

test('an unknown outcome is rejected rather than silently succeeding', async () => {
  await assert.rejects(() => demo.charge({
    amountCents: 1800, providerCustomerId: 'demo_cus_1',
    providerMethodId: 'demo_pm_1', idempotencyKey: 'k3',
    reference: 'pay:1', outcome: 'whatever',
  }), /unknown outcome/i);
});

test('savePaymentMethod invents card metadata and never accepts a PAN', async () => {
  const m = await demo.savePaymentMethod({
    providerCustomerId: 'demo_cus_1', cardholderName: 'Test Customer', billingZip: '31901',
  });
  assert.match(m.providerMethodId, /^demo_pm_/);
  assert.equal(m.brand, 'DEMO');
  assert.equal(m.last4, '0000');
  assert.equal(typeof m.expMonth, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/demo-provider.test.js`
Expected: FAIL — `Cannot find module '../lib/payments/demo.js'`

- [ ] **Step 3: Write the demo provider**

```js
// server/lib/payments/demo.js
/* ============================================================
   DEMO payment provider.

   Simulates a processor. It never opens a network connection and
   never sees a card number - the demo checkout does not collect
   one. `outcome` is chosen by whoever is testing.

   Every id it mints is prefixed `demo_` so a demo record can
   never be mistaken for a real one, in the database or in a log.
   ============================================================ */

import { randomUUID } from 'node:crypto';

export const providerLabel = 'Demo';
export const collectsCard = false;   // the UI asks for no card details
export const simulates = true;       // the UI shows outcome buttons

// Outcomes `charge()` accepts. A refund is not a charge outcome - it is a
// separate operation on an existing payment, so it lives in refund().
export const OUTCOMES = ['success', 'failed', 'declined', 'pending'];

const FAILURE_REASON = {
  failed: 'Simulated processor failure.',
  declined: 'Simulated card decline.',
};

/** Replaying a key must return the original result rather than charging
 *  again. A real provider persists this; in demo an in-process map is
 *  enough, and it keeps the behaviour honest while testing. */
const charges = new Map();

const id = (prefix) => `demo_${prefix}_${randomUUID()}`;

export async function createCustomer({ firstName, lastName, email, phone }) {
  return { providerCustomerId: id('cus') };
}

export async function savePaymentMethod({ providerCustomerId, cardholderName, billingZip }) {
  const now = new Date();
  return {
    providerMethodId: id('pm'),
    brand: 'DEMO',
    last4: '0000',
    expMonth: now.getMonth() + 1,
    expYear: now.getFullYear() + 3,
  };
}

export async function charge({ amountCents, providerCustomerId, providerMethodId,
                               idempotencyKey, reference, outcome }) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown outcome "${outcome}". Expected one of: ${OUTCOMES.join(', ')}`);
  }
  if (charges.has(idempotencyKey)) return charges.get(idempotencyKey);

  const status = outcome === 'success' ? 'paid'
               : outcome === 'pending' ? 'pending'
               : 'failed';

  const result = {
    providerPaymentId: id('pay'),
    status,
    failureReason: FAILURE_REASON[outcome] || null,
  };
  charges.set(idempotencyKey, result);
  return result;
}

export async function refund({ providerPaymentId, amountCents, idempotencyKey }) {
  return { providerRefundId: id('ref'), status: 'refunded' };
}

/** Demo failures are already plain English, so nothing to translate. */
export function describeError(err) {
  return err?.message || 'The simulated payment could not be completed.';
}
```

- [ ] **Step 4: Rewrite the provider registry**

```js
// server/lib/payments/index.js
/* ============================================================
   Payment provider interface.

   Nothing outside this folder knows which provider is in use.
   Today the only implementation is `demo`, which simulates
   outcomes and moves no money.

   To add a real provider later, create a sibling module that
   exports every function below, then set PAYMENT_PROVIDER to
   its name. No route or dashboard code changes.

     createCustomer({ firstName, lastName, email, phone })
       -> { providerCustomerId }

     savePaymentMethod({ providerCustomerId, cardholderName, billingZip })
       -> { providerMethodId, brand, last4, expMonth, expYear }

     charge({ amountCents, providerCustomerId, providerMethodId,
              idempotencyKey, reference, outcome })
       -> { providerPaymentId, status, failureReason }
          status is 'paid' | 'pending' | 'failed', which are exactly
          the values payments.status accepts.

     refund({ providerPaymentId, amountCents, idempotencyKey })
       -> { providerRefundId, status }

     describeError(err) -> customer-safe string

   Flags a provider must export:
     collectsCard  true when the UI must render real card fields
     simulates     true when the UI should offer outcome buttons
   ============================================================ */

import * as demo from './demo.js';

const providers = { demo };
const requested = process.env.PAYMENT_PROVIDER || 'demo';

export const providerName = providers[requested] ? requested : 'demo';
export const payments = providers[providerName];

if (!providers[requested]) {
  console.warn(`[payments] Unknown PAYMENT_PROVIDER "${requested}" - using demo.`);
}
```

- [ ] **Step 5: Delete the Square modules and add the test script**

```bash
cd server
rm lib/payments/square.js lib/payments/stripe.js bin/square-setup.js
rmdir bin 2>/dev/null || true
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
delete p.scripts['square:setup'];delete p.scripts['square:setup:prod'];delete p.scripts['square:check'];
p.scripts.test='node --test test/';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — 6 tests, 0 failures

- [ ] **Step 7: Commit**

```bash
git add server/lib/payments server/test server/package.json
git commit -m "feat(payments): replace Square with a provider-neutral demo provider"
```

---

### Task 2: `payment_methods` table

**Files:**
- Create: `server/db/schema_payments.sql`
- Modify: `server/db/index.js:20-26` (add the file to `migrate()`)
- Create: `server/test/schema-payments.test.js`

**Why the promo columns live on `subscriptions`:** the same reason
`locked_price_cents` does. A coupon edited or disabled later must never reach
back and re-price a customer who already enrolled, so the promotion's terms are
copied onto the subscription at signup and frozen there.

**Interfaces:**
- Consumes: `migrate()` from Task 1's unchanged `db/index.js`.
- Produces: table `payment_methods(id, customer_id, provider, provider_customer_id, provider_method_id, brand, last_4, exp_month, exp_year, is_default, status, created_at)`; columns `subscriptions.promo_price_cents`, `subscriptions.promo_periods_remaining`, `coupons.duration_periods`.

- [ ] **Step 1: Write the failing test**

```js
// server/test/schema-payments.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate } = await import('../db/index.js');
migrate();

test('payment_methods exists with the columns the billing layer needs', () => {
  const cols = db.prepare(`PRAGMA table_info(payment_methods)`).all().map(c => c.name);
  for (const c of ['customer_id','provider','provider_customer_id','provider_method_id',
                   'brand','last_4','exp_month','exp_year','is_default','status']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

test('subscriptions and coupons can express a promotional term', () => {
  const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all().map(c => c.name);
  assert.ok(subCols.includes('promo_price_cents'));
  assert.ok(subCols.includes('promo_periods_remaining'));
  const couponCols = db.prepare(`PRAGMA table_info(coupons)`).all().map(c => c.name);
  assert.ok(couponCols.includes('duration_periods'),
            'a discount must be able to say "for N periods"');
});

test('status is constrained so a typo cannot silently store garbage', () => {
  db.exec(`INSERT INTO users (email,password_hash,role,first_name,last_name)
           VALUES ('pm@test.local','x','customer','P','M')`);
  db.exec(`INSERT INTO customers (user_id) VALUES (last_insert_rowid())`);
  assert.throws(() => db.exec(`
    INSERT INTO payment_methods (customer_id, provider, provider_method_id, status)
    VALUES (1,'demo','demo_pm_1','banana')`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/schema-payments.test.js`
Expected: FAIL — `no such table: payment_methods`

- [ ] **Step 3: Write the schema**

```sql
-- server/db/schema_payments.sql
-- Cards on file, provider-neutral.
--
-- A separate table rather than columns on `customers`, because replacing an
-- expired card must not erase the payment history that points at the old one.

CREATE TABLE IF NOT EXISTS payment_methods (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id          INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  provider             TEXT    NOT NULL,          -- 'demo' today
  provider_customer_id TEXT,
  provider_method_id   TEXT    NOT NULL,

  -- Display only. Never a full card number - no provider hands one back,
  -- and the demo provider is never given one.
  brand                TEXT,
  last_4               TEXT,
  exp_month            INTEGER,
  exp_year             INTEGER,

  is_default           INTEGER NOT NULL DEFAULT 1,
  status               TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','expired','removed')),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
  ON payment_methods(customer_id, status);
```

Then, in the same file, add the promotional-term columns. `ALTER TABLE ... ADD
COLUMN` is not idempotent in SQLite, so guard each one:

```js
// append to migrate() in server/db/index.js, after the schema_payments.sql exec
const addColumn = (table, column, decl) => {
  const has = db.prepare(`PRAGMA table_info(${table})`).all()
                .some(c => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
};

// The promotional price and how many billing periods it still covers.
// Copied from the coupon at signup and frozen, exactly like
// locked_price_cents - so editing the coupon later cannot re-price
// a customer who already enrolled.
addColumn('subscriptions', 'promo_price_cents', 'INTEGER');
addColumn('subscriptions', 'promo_periods_remaining', 'INTEGER');

// Lets a discount say "for N billing periods". NULL means forever.
addColumn('coupons', 'duration_periods', 'INTEGER');
```

- [ ] **Step 4: Register the migration**

In `server/db/index.js`, inside `migrate()`, add after the `schema.sql` line:

```js
  db.exec(readFileSync(join(HERE, 'schema_payments.sql'), 'utf8'));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add server/db/schema_payments.sql server/db/index.js server/test/schema-payments.test.js
git commit -m "feat(db): add provider-neutral payment_methods table"
```

---

### Task 3: Checkout creates real local records

**Files:**
- Create: `server/lib/signup.js`
- Create: `server/test/signup.test.js`
- Modify: `server/server.js:173-265` (replace the `/api/checkout` handler)

**Interfaces:**
- Consumes: `payments`, `providerName` (Task 1); `payment_methods` (Task 2); `hashPassword` from `lib/auth.js`; `tx`, `one`, `run` from `db/index.js`.
- Produces: `enrol({ plan, firstName, lastName, email, phone, password, street, unit, community, zip, startDate, couponCode, outcome }) -> { ok, customerId, subscriptionId, paymentId, status, error }`.

- [ ] **Step 1: Write the failing test**

```js
// server/test/signup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one } = await import('../db/index.js');
migrate();
db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro)
         VALUES ('Monthly','Monthly',1,2800,0)`);
const { enrol } = await import('../lib/signup.js');

const base = {
  plan: 'Monthly', firstName: 'Ada', lastName: 'Byron',
  email: 'ada@test.local', phone: '7065550100', password: 'CorrectHorse9',
  street: '1 Example St', unit: 'Unit 1', community: 'Riverstone',
  zip: '31901', startDate: '2026-10-01',
};

test('a successful demo payment creates every local record', async () => {
  const r = await enrol({ ...base, outcome: 'success' });
  assert.equal(r.ok, true);

  const user = one(`SELECT * FROM users WHERE email = ?`, base.email);
  assert.equal(user.role, 'customer');
  assert.notEqual(user.password_hash, base.password, 'password must be hashed');

  const cust = one(`SELECT * FROM customers WHERE id = ?`, r.customerId);
  assert.equal(cust.user_id, user.id);

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.status, 'active');
  assert.equal(sub.locked_price_cents, 2800);

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.status, 'paid');
  assert.equal(pay.provider, 'demo', 'demo transactions must be identifiable');
  assert.match(pay.provider_payment_id, /^demo_pay_/);

  assert.ok(one(`SELECT id FROM payment_methods WHERE customer_id = ?`, r.customerId));
  assert.ok(one(`SELECT id FROM service_addresses WHERE customer_id = ?`, r.customerId));
});

test('a failed demo payment leaves no active subscription and no collected revenue', async () => {
  const r = await enrol({ ...base, email: 'fail@test.local', outcome: 'failed' });
  assert.equal(r.ok, false);

  const sub = one(`SELECT s.* FROM subscriptions s JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'fail@test.local'`);
  assert.equal(sub.status, 'pending', 'a failed payment must not activate service');

  const pay = one(`SELECT p.* FROM payments p WHERE p.id = ?`, r.paymentId);
  assert.equal(pay.status, 'failed');
  assert.ok(pay.failure_reason);
});

test('a duplicate email is rejected before anything is charged', async () => {
  const r = await enrol({ ...base, outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already/i);
});

test('a weak password is rejected', async () => {
  const r = await enrol({ ...base, email: 'weak@test.local', password: 'abc', outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /password/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/signup.test.js`
Expected: FAIL — `Cannot find module '../lib/signup.js'`

- [ ] **Step 3: Write `lib/signup.js`**

```js
// server/lib/signup.js
/* ============================================================
   Turn a completed signup form into real local records.

   Order matters: everything is written to the database BEFORE the
   provider is called, so a charge can never exist without a row
   that explains it. The provider only ever hands back an opaque id
   and a status.
   ============================================================ */

import { payments, providerName } from './payments/index.js';
import { hashPassword, passwordProblem } from './auth.js';
import { tx, one, run } from '../db/index.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Reuse a unit when one already matches, so two neighbours in the same
 *  building do not create two units for the same address. */
function resolveUnit({ community, street, unit, zip }) {
  let com = one(`SELECT id FROM communities WHERE name = ? COLLATE NOCASE`, community);
  if (!com) {
    com = { id: run(`INSERT INTO communities (name, zip) VALUES (?, ?)`,
                    community, zip).lastInsertRowid };
  }
  const existing = one(
    `SELECT id FROM units WHERE community_id = ? AND label = ? COLLATE NOCASE`,
    com.id, unit);
  if (existing) return existing.id;

  return run(`INSERT INTO units (community_id, label, street, zip)
              VALUES (?, ?, ?, ?)`, com.id, unit, street, zip).lastInsertRowid;
}

export async function enrol(input) {
  const {
    plan, firstName, lastName, email, phone, password,
    street, unit, community, zip, startDate, outcome = 'success',
  } = input;

  /* ---- validate before anything is created or charged ---- */
  const missing = Object.entries({
    plan, firstName, lastName, email, phone, password,
    street, unit, community, zip,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { ok: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'That email address is not valid.' };
  if (!/^\d{5}$/.test(zip))  return { ok: false, error: 'ZIP code must be 5 digits.' };

  const pwProblem = passwordProblem(password);
  if (pwProblem) return { ok: false, error: pwProblem };

  if (one(`SELECT id FROM users WHERE email = ?`, email)) {
    return { ok: false, error: 'An account already exists for that email address.' };
  }

  const planRow = one(`SELECT * FROM plans WHERE code = ? AND active = 1`, plan);
  if (!planRow) return { ok: false, error: `No active plan named "${plan}".` };

  const priceCents = planRow.price_cents;
  const passwordHash = await hashPassword(password);

  /* ---- transaction A: every record, nothing charged yet ---- */
  const ids = tx(() => {
    const unitId = resolveUnit({ community, street, unit, zip });

    const userId = run(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
       VALUES (?, ?, 'customer', ?, ?, ?)`,
      email, passwordHash, firstName, lastName, phone).lastInsertRowid;

    const customerId = run(
      `INSERT INTO customers (user_id, provider) VALUES (?, ?)`,
      userId, providerName).lastInsertRowid;

    run(`INSERT INTO service_addresses (customer_id, unit_id, start_date)
         VALUES (?, ?, ?)`, customerId, unitId, startDate || null);

    const subscriptionId = run(
      `INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents,
                                  status, provider, started_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      customerId, planRow.id, priceCents, providerName,
      startDate || new Date().toISOString().slice(0, 10)).lastInsertRowid;

    const paymentId = run(
      `INSERT INTO payments (customer_id, subscription_id, amount_cents, status, provider)
       VALUES (?, ?, ?, 'pending', ?)`,
      customerId, subscriptionId, priceCents, providerName).lastInsertRowid;

    return { userId, customerId, subscriptionId, paymentId };
  });

  /* ---- provider: vault, then charge ---- */
  let charge;
  try {
    const cust = await payments.createCustomer({ firstName, lastName, email, phone });
    run(`UPDATE customers SET provider_customer_id = ? WHERE id = ?`,
        cust.providerCustomerId, ids.customerId);

    const method = await payments.savePaymentMethod({
      providerCustomerId: cust.providerCustomerId,
      cardholderName: `${firstName} ${lastName}`,
      billingZip: zip,
    });
    run(`INSERT INTO payment_methods (customer_id, provider, provider_customer_id,
                                      provider_method_id, brand, last_4, exp_month, exp_year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ids.customerId, providerName, cust.providerCustomerId, method.providerMethodId,
        method.brand, method.last4, method.expMonth, method.expYear);

    charge = await payments.charge({
      amountCents: priceCents,
      providerCustomerId: cust.providerCustomerId,
      providerMethodId: method.providerMethodId,
      // Derived from the payment row, never random: a replayed request
      // returns the original charge instead of charging twice.
      idempotencyKey: `pay:${ids.paymentId}`,
      reference: `pay:${ids.paymentId}`,
      outcome,
    });
  } catch (err) {
    run(`UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?`,
        payments.describeError(err), ids.paymentId);
    return { ok: false, ...ids, status: 'failed', error: payments.describeError(err) };
  }

  /* ---- transaction B: record the outcome ---- */
  tx(() => {
    run(`UPDATE payments SET status = ?, provider_payment_id = ?,
                             failure_reason = ?, paid_at = ?
          WHERE id = ?`,
        charge.status, charge.providerPaymentId, charge.failureReason,
        charge.status === 'paid' ? new Date().toISOString() : null,
        ids.paymentId);

    if (charge.status === 'paid') {
      const next = new Date(startDate || Date.now());
      next.setMonth(next.getMonth() + planRow.interval_months);
      run(`UPDATE subscriptions SET status = 'active', next_billing_date = ?
            WHERE id = ?`, next.toISOString().slice(0, 10), ids.subscriptionId);
    }
  });

  return {
    ok: charge.status === 'paid',
    ...ids,
    status: charge.status,
    error: charge.status === 'paid' ? undefined
      : charge.failureReason || 'The payment did not complete.',
  };
}
```

Coupon redemption is deliberately **not** here - Task 4 adds it, so this task
stays independently reviewable.

- [ ] **Step 4: Replace the checkout route**

In `server/server.js`, delete the entire Square `/api/checkout` handler
(currently lines 173–265, from `app.post('/api/checkout'` to its closing
`});`) and the now-unused `createCustomer`, `saveCard`, `createSubscription`,
`SquareError` imports, and replace with:

```js
app.post('/api/checkout', rateLimit, async (req, res) => {
  const result = await enrol({ ...req.body, outcome: req.body.outcome || 'success' });
  if (!result.ok) {
    return res.status(result.status === 'failed' ? 402 : 400)
              .json({ ok: false, error: result.error, status: result.status });
  }
  res.json({
    ok: true,
    demo: providerName === 'demo',
    confirmationId: result.paymentId,
    subscriptionId: result.subscriptionId,
    status: result.status,
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add server/lib/signup.js server/test/signup.test.js server/server.js
git commit -m "feat(signup): checkout creates customer, subscription and payment locally"
```

---

### Task 4: Coupon redemption and the first-100 rule

**Files:**
- Modify: `server/lib/signup.js` (transaction B)
- Modify: `server/lib/coupons.js` (export `introCoupon` unchanged; no signature change)
- Create: `server/test/intro-redemption.test.js`

**Interfaces:**
- Consumes: `enrol()` (Task 3); `redeem({couponId,customerId,subscriptionId,paymentId,priceCents,type})` and `introCoupon()` from `lib/coupons.js`.
- Produces: `enrol()` gains `couponCode`; its result gains `{ introApplied: boolean, remainingSpots: number }`.

- [ ] **Step 1: Write the failing test**

```js
// server/test/intro-redemption.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one } = await import('../db/index.js');
migrate();
db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro)
         VALUES ('Monthly','Monthly',1,2800,0)`);
db.exec(`INSERT INTO coupons (code,name,discount_type,discount_value,max_redemptions,
                              eligible_customer_type,is_intro,duration_periods)
         VALUES ('DASHLAUNCH','Dash Launch Special','promo_price',1800,100,'new',1,12)`);
const { enrol } = await import('../lib/signup.js');
const { introCoupon } = await import('../lib/coupons.js');

const base = {
  plan: 'Monthly', firstName: 'A', lastName: 'B', phone: '7065550100',
  password: 'CorrectHorse9', street: '1 Example St', unit: 'Unit 1',
  community: 'Riverstone', zip: '31901', startDate: '2026-10-01',
  couponCode: 'DASHLAUNCH',
};

test('a successful intro signup locks the 12-month term and consumes one spot', async () => {
  assert.equal(introCoupon().remaining, 100);

  const r = await enrol({ ...base, email: 'a@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, true);

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  // The promotional price and its term are frozen on the subscription;
  // locked_price_cents holds the standard rate this customer reverts to.
  assert.equal(sub.promo_price_cents, 1800);
  assert.equal(sub.promo_periods_remaining, 12);
  assert.equal(sub.locked_price_cents, 2800,
               'the post-promotion rate is locked at signup too');

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.amount_cents, 1800, 'the first charge is the promotional price');

  assert.equal(introCoupon().remaining, 99);
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions`).n, 1);
});

test('a failed payment consumes no spot', async () => {
  const before = introCoupon().remaining;
  const r = await enrol({ ...base, email: 'b@test.local', outcome: 'failed' });
  assert.equal(r.ok, false);
  assert.equal(introCoupon().remaining, before, 'a failure must not use a spot');
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions`).n, 1);
});

test('a declined payment consumes no spot', async () => {
  const before = introCoupon().remaining;
  await enrol({ ...base, email: 'c@test.local', outcome: 'declined' });
  assert.equal(introCoupon().remaining, before);
});

test('the promotion closes at its limit and the next customer pays full price', async () => {
  db.exec(`UPDATE coupons SET max_redemptions = 1 WHERE code = 'DASHLAUNCH'`);
  assert.equal(introCoupon().status, 'limit_reached');

  const r = await enrol({ ...base, email: 'd@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, false, 'the offer is closed');
  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800, 'full price once the promo is exhausted');
  assert.equal(sub.promo_price_cents, null, 'no promotion was applied');
});

test('an earlier intro customer keeps the promotion after it closes', () => {
  const sub = one(`SELECT s.* FROM subscriptions s
                   JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'a@test.local'`);
  assert.equal(sub.promo_price_cents, 1800,
               'existing promotional pricing must never be revoked');
  assert.equal(sub.promo_periods_remaining, 12,
               'their remaining promotional months must not be shortened');
});

test('disabling the coupon does not touch an existing promotional subscription', () => {
  db.exec(`UPDATE coupons SET disabled = 1 WHERE code = 'DASHLAUNCH'`);
  const sub = one(`SELECT s.* FROM subscriptions s
                   JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'a@test.local'`);
  assert.equal(sub.promo_price_cents, 1800);
  assert.equal(sub.promo_periods_remaining, 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/intro-redemption.test.js`
Expected: FAIL — `introApplied` is `undefined`

- [ ] **Step 3: Wire redemption into `enrol()`**

- Before transaction A: if `couponCode` is given, call `validate({code, planId, customerId: null, priceCents: plan.price_cents})`. When it returns `ok`:
  - charge `quote.finalCents` (1800),
  - set `subscriptions.promo_price_cents = quote.finalCents`,
  - set `subscriptions.promo_periods_remaining = coupon.duration_periods` (NULL means the promotion never ends),
  - leave `locked_price_cents = plan.price_cents` (2800) — the rate they revert to, locked now so a later price rise cannot reach them.

  Otherwise charge `plan.price_cents`, leave both promo columns NULL, and set `introApplied = false`.
- In **transaction B**, and only when the charge status is `paid`, call
  `redeem({ couponId, customerId, subscriptionId, paymentId, priceCents: plan.price_cents, type: 'new' })`.
  `redeem()` re-checks the limit inside its own transaction, so two simultaneous
  signups cannot both take the last spot.
- If `redeem()` throws `COUPON_LIMIT_REACHED`, the spot was taken between
  validation and completion. Keep the payment and subscription, clear
  `promo_price_cents` and `promo_periods_remaining` back to NULL, and return
  `introApplied:false`. Note the customer was charged the promotional amount for
  this first period; that is the correct outcome — they were quoted it — and only
  future periods revert.

- **Never** write to `promo_price_cents` or `promo_periods_remaining` of an
  existing subscription from coupon-management code. Those columns are written
  once, at enrolment.

**Reminder — this plan does not build a biller.** Nothing decrements
`promo_periods_remaining` yet, because no recurring charge exists to consume a
period. The column records what the customer was promised so a real provider,
connected later, can honour it.
- Set `customers.is_intro = 1` when redemption succeeds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add server/lib/signup.js server/test/intro-redemption.test.js
git commit -m "feat(coupons): redeem the launch promotion only on a successful payment"
```

---

### Task 5: Demo checkout UI

**Files:**
- Modify: `index.html` (payment step, lines ~445–470; intro copy at ~198, ~208, ~298, ~521)
- Modify: `scripts.js` (remove the Square SDK block ~209–270; rewrite `renderPaymentStep` ~499–530)
- Modify: `styles.css` (add `.demo-banner`, `.outcome-grid`)

**Interfaces:**
- Consumes: `POST /api/checkout` accepting `outcome` and `password` (Tasks 3–4); `GET /api/config` returning `{ provider, collectsCard, simulates, outcomes }`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the card field with demo controls in `index.html`**

Delete the `<script id="squareSdk">` tag entirely. Replace the `.card-field`
block with:

```html
<div class="demo-banner" role="status">
  <strong>Demo Mode – No Real Payment Will Be Processed.</strong>
  <span>No card details are collected. Choose a result to simulate.</span>
</div>

<fieldset class="outcome-grid">
  <legend>Simulate a payment result</legend>
  <label><input type="radio" name="outcome" value="success" checked> Successful payment</label>
  <label><input type="radio" name="outcome" value="failed"> Failed payment</label>
  <label><input type="radio" name="outcome" value="declined"> Declined payment</label>
  <label><input type="radio" name="outcome" value="pending"> Pending payment</label>
</fieldset>
```

Add a password field to step 2, after the email input:

```html
<label class="field">
  <span>Choose a password</span>
  <input type="password" name="password" required minlength="10"
         autocomplete="new-password" placeholder="At least 10 characters" />
</label>
```

- [ ] **Step 2: Keep the 12-month term copy, and verify it survives the rewrite**

The introductory rate is $18/month for 12 months, then $28/month. That
disclosure is already in place and **must not be removed** while gutting the
Square code from `scripts.js`. Leave all of this exactly as it is:

- `CONFIG.intro.termMonths = 12`
- `PRICING.intro.termMonths` and `PRICING.intro.after`
- the `[data-intro-term]` and `[data-intro-after]` render loops in `renderPricing()`
- the intro branch of the plan-picker label
- the intro branch of the renewal line in `renderPaymentStep()`
- the six `data-intro-term` / `data-intro-after` spans in `index.html`

Confirm afterwards in the browser console:

```js
[...document.querySelectorAll('[data-intro-term]')].map(e => e.textContent)
// expected: ["12","12","12","12","12"]
[...document.querySelectorAll('[data-intro-after]')].map(e => e.textContent)
// expected: ["$28","$28","$28","$28"]
document.querySelector('[data-review="renewal"]').textContent
// expected: "Renews automatically every month at $18 for 12 months,
//            then $28 per month until you cancel. Cancel anytime."
```

The renewal line is rendered by `renderPaymentStep()`, which Step 3 rewrites —
so check this **after** Step 3, not before.

- [ ] **Step 3: Rewrite the payment step in `scripts.js`**

Delete `loadSquareSdk`, `mountSquareCard`, `tokenizeCard`, `squareCard`,
`squareCardReady`, `squareConfig` and the `DEMO_MODE` fallback branch. The app
is always in demo mode now, so the fallback has nothing to fall back from.
`submitCheckout` sends the selected `outcome` and the password instead of a
`sourceId`:

```js
const outcome = document.querySelector('input[name="outcome"]:checked')?.value || 'success';
const res = await api('/api/checkout', {
  method: 'POST',
  body: JSON.stringify({ ...values, outcome }),
});
```

On a non-`ok` response show `res.error` in the existing payment-error element.
On success show the confirmation step with a `DEMO` badge and the returned
`confirmationId`.

**Keep the whole `[data-review="renewal"]` block intact.** It is the only place
the customer is told the $18 rate lasts 12 months on the screen where they
commit, and it is unrelated to Square.

- [ ] **Step 4: Verify in the browser**

Run: `cd server && npm run dev`, open `http://localhost:3000/index.html`.
Expected: the payment step shows the demo banner and four radio buttons, and
**no card-number field anywhere**. A successful simulated signup reaches the
confirmation step; a failed one shows an error and does not advance.

- [ ] **Step 5: Commit**

```bash
git add index.html scripts.js styles.css
git commit -m "feat(checkout): demo payment screen with simulated outcomes"
```

---

### Task 6: Purge the remaining Square references

**Files:**
- Modify: `server/server.js` (webhook route, `/api/config`, boot banner, plan-variation map)
- Modify: `server/.env.example`; Delete: `server/.env.production.example`
- Modify: `server/db/schema.sql:60,130` comments; `server/db/seed.js`, `server/db/seed_finance.js`
- Modify: `dashboard/customer/customer.js`, `styles.css`, `README.md`
- Delete: `server/store.js` and `server/data/signups.json`
- Create: `server/test/no-square.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `GET /api/config -> { provider, collectsCard, simulates, outcomes }`.

- [ ] **Step 1: Write the failing test**

```js
// server/test/no-square.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'docs', 'images', 'test']);

function* files(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|html|css|sql|json|example)$/.test(e)) yield p;
  }
}

test('no source file mentions Square', () => {
  const hits = [];
  for (const f of files(ROOT)) {
    if (/square/i.test(readFileSync(f, 'utf8'))) hits.push(f.replace(ROOT, ''));
  }
  assert.deepEqual(hits, [], `Square references remain in:\n${hits.join('\n')}`);
});

test('the app boots with no payment credentials set', async () => {
  for (const k of Object.keys(process.env)) if (/^SQUARE_/.test(k)) delete process.env[k];
  process.env.DB_PATH = ':memory:';
  const { payments, providerName } = await import('../lib/payments/index.js');
  assert.equal(providerName, 'demo');
  assert.equal(typeof payments.charge, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/no-square.test.js`
Expected: FAIL — lists every remaining file

- [ ] **Step 3: Remove each reference**

- `server.js`: delete the `/api/webhooks/square` route, `handleWebhook`, the
  `createHmac`/`timingSafeEqual` import, `PLAN_VARIATIONS`, `normalizeStartDate`
  if now unused, and every `SQUARE_*` read. Replace the boot banner's credential
  check with `console.log('  Payments: DEMO - no real money moves')`.
- `/api/config` returns `{ provider: providerName, collectsCard, simulates, outcomes }`.
- `.env.example`: delete every `SQUARE_*` and `WEBHOOK_*` line; add
  `PAYMENT_PROVIDER=demo`. Delete `.env.production.example`.
- `schema.sql`: change the `'square' | 'stripe'` comments to
  `-- 'demo' until a real provider is connected`.
- `seed.js` / `seed_finance.js`: change any `'square'` provider literal to `'demo'`.
- `customer.js`, `styles.css`: rename Square-specific identifiers.
- `README.md`: delete the whole "Square setup" section; document
  `PAYMENT_PROVIDER=demo` and the simulated outcomes instead.
- Delete `server/store.js` and `server/data/signups.json`; the database now
  holds signups.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all tests, 0 failures

- [ ] **Step 5: Verify the app runs with no credentials**

Run: `cd server && env -u SQUARE_ACCESS_TOKEN npm run dev`
Expected: boots, banner reads `Payments: DEMO - no real money moves`, and
`curl -s localhost:3000/api/config` returns `"provider":"demo"`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove every remaining Square reference"
```

---

### Task 7: Mark demo transactions in the dashboards

**Files:**
- Modify: `server/routes/customer.js:139-155` (payments list)
- Modify: `server/routes/admin.js` (payments tab query)
- Modify: `dashboard/customer/customer.js`, `dashboard/admin/admin.js`
- Modify: `dashboard/dash.css`

**Interfaces:**
- Consumes: `payments.provider = 'demo'` written by Task 3.
- Produces: payment rows in both APIs gain `demo: boolean`.

- [ ] **Step 1: Add the flag to both APIs**

In each payments query result, map `demo: row.provider === 'demo'`. Do not add
a database column — `provider` already carries this fact.

- [ ] **Step 2: Render a badge**

Wherever a payment row renders, append when `demo` is true:

```js
`<span class="badge badge-demo">DEMO</span>`
```

```css
.badge-demo {
  background: var(--orange, #E2571F); color: #fff;
  font-size: .72rem; font-weight: 700; letter-spacing: .04em;
  padding: .1rem .4rem; border-radius: 3px; margin-left: .4rem;
}
```

- [ ] **Step 3: Verify in the browser**

Run: `cd server && npm run dev`, complete a simulated successful signup, then
log in as admin and open the Payments tab.
Expected: the new payment appears with an orange `DEMO` badge, and the customer
portal shows the same badge in payment history.

- [ ] **Step 4: Commit**

```bash
git add server/routes dashboard
git commit -m "feat(dashboard): mark demo transactions with a DEMO badge"
```

---

## Notes for the next plans

This plan deliberately stops short of:

- **Plan 2 — Introductory offer surface:** admin promotion editing, the public
  popup reading live coupon data, `limit_reached` behaviour in the UI, and
  promotion reporting (items 11, 13–17, 19).
- **Plan 3 — Data reset and empty states:** the admin-only reset utility, clearing
  sample data while preserving the admin account, roles, permissions and the
  Dash Launch Special, and making every dashboard render correctly at zero
  (items 6–10, 21, 36).
- **Plan 4 — Filtering and CSV export:** filters across all fifteen admin tabs,
  filtered reports and charts recalculating, and CSV export respecting active
  filters (items 22–35).
