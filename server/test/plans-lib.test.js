import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate, one, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();

const plans = await import('../lib/plans.js');

function seedCustomerOnPlan(planId, priceCents) {
  run(`INSERT INTO users (email,password_hash,role,first_name,last_name)
       VALUES ('c'||abs(random())||'@t.local','x','customer','C','C')`);
  const userId = one(`SELECT last_insert_rowid() AS id`).id;
  run(`INSERT INTO customers (user_id, status) VALUES (?, 'active')`, userId);
  const custId = one(`SELECT last_insert_rowid() AS id`).id;
  run(`INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents, status)
       VALUES (?, ?, ?, 'active')`, custId, planId, priceCents);
  return custId;
}

test('createPlan generates a unique code and defaults', () => {
  const a = plans.createPlan({ name: 'Standard Monthly', priceCents: 3000,
    intervalUnit: 'month', intervalCount: 1, status: 'active', customerAvailable: 1 }, 1);
  const b = plans.createPlan({ name: 'Standard Monthly', priceCents: 3000,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' }, 1);
  const rowA = one(`SELECT * FROM plans WHERE id = ?`, a.id);
  const rowB = one(`SELECT * FROM plans WHERE id = ?`, b.id);
  assert.equal(rowA.code, 'StandardMonthly');
  assert.notEqual(rowB.code, rowA.code); // uniqueness suffix
  assert.equal(rowA.currency, 'USD');
});

test('updatePlan changes details but not status', () => {
  const { id } = plans.createPlan({ name: 'Edit Me', priceCents: 1000,
    intervalUnit: 'week', intervalCount: 1, status: 'active' }, 1);
  plans.updatePlan(id, { name: 'Edited', priceCents: 1200, intervalUnit: 'week',
    intervalCount: 2, label: 'Best Value' }, 1);
  const row = one(`SELECT * FROM plans WHERE id = ?`, id);
  assert.equal(row.name, 'Edited');
  assert.equal(row.price_cents, 1200);
  assert.equal(row.interval_count, 2);
  assert.equal(row.status, 'active'); // unchanged
  assert.ok(row.updated_at);
});

test('duplicatePlan clones as a fresh draft, unavailable, new code', () => {
  const { id } = plans.createPlan({ name: 'Popular', priceCents: 5000,
    intervalUnit: 'month', intervalCount: 6, status: 'active', customerAvailable: 1 }, 1);
  const dup = plans.duplicatePlan(id, 1);
  const row = one(`SELECT * FROM plans WHERE id = ?`, dup.id);
  assert.equal(row.status, 'draft');
  assert.equal(row.customer_available, 0);
  assert.match(row.name, /Copy/);
  assert.notEqual(row.code, one(`SELECT code FROM plans WHERE id = ?`, id).code);
});

test('a plan with subscription history cannot be hard-deleted', () => {
  const { id } = plans.createPlan({ name: 'Has Subs', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  seedCustomerOnPlan(id, 2000);
  const del = plans.planDeletability(id);
  assert.equal(del.deletable, false);
  assert.throws(() => plans.deletePlan(id));
});

test('an unused draft plan can be hard-deleted', () => {
  const { id } = plans.createPlan({ name: 'Throwaway', priceCents: 100,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' }, 1);
  assert.equal(plans.planDeletability(id).deletable, true);
  plans.deletePlan(id);
  assert.equal(one(`SELECT id FROM plans WHERE id = ?`, id), undefined);
});

test('new-scope price change touches no existing subscriber', () => {
  const { id } = plans.createPlan({ name: 'NewScope', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  plans.schedulePriceChange(id, { newPriceCents: 2500, appliesTo: 'new',
    effectiveDate: '2020-01-01' }, 1); // past date, but 'new' scope
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 2500);
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);
});

test('existing_and_new applies to live subscriptions once due, not before', () => {
  const { id } = plans.createPlan({ name: 'ExistingScope', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  // Future effective date: not yet due.
  plans.schedulePriceChange(id, { newPriceCents: 3000, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);
  // A due (past) effective date applies.
  run(`UPDATE plan_price_changes SET effective_date = '2020-01-01' WHERE plan_id = ?`, id);
  const applied = plans.applyDuePriceChanges();
  assert.ok(applied >= 1);
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 3000);
  // Idempotent: a second run does nothing new.
  assert.equal(plans.applyDuePriceChanges(), 0);
});

test('schedulePriceChange with no effectiveDate defaults to today + grace days', () => {
  const { id } = plans.createPlan({ name: 'GraceDefault', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const expected = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const out = plans.schedulePriceChange(id, { newPriceCents: 2200, appliesTo: 'existing_and_new' }, 1);
  assert.equal(out.effectiveDate, expected);
  const row = one(`SELECT effective_date FROM plan_price_changes WHERE id = ?`, out.id);
  assert.equal(row.effective_date, expected);
});

test('layered price changes do not strand a subscriber at an intermediate price', () => {
  const { id } = plans.createPlan({ name: 'Layered', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  // A 'new'-scope change bumps the advertised price but leaves the subscriber alone.
  plans.schedulePriceChange(id, { newPriceCents: 2500, appliesTo: 'new' }, 1);
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);
  // Now an existing_and_new change to 3000, due immediately.
  const pc2 = plans.schedulePriceChange(id, { newPriceCents: 3000, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  run(`UPDATE plan_price_changes SET effective_date = '2020-01-01' WHERE id = ?`, pc2.id);
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 3000);
});

test('cancelPriceChange stops a scheduled change from ever applying', () => {
  const { id } = plans.createPlan({ name: 'Cancellable', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  const pc = plans.schedulePriceChange(id, { newPriceCents: 2800, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  plans.cancelPriceChange(id, pc.id);
  assert.equal(one(`SELECT status FROM plan_price_changes WHERE id = ?`, pc.id).status, 'cancelled');

  // Even once "due," a cancelled row must not apply.
  run(`UPDATE plan_price_changes SET effective_date = '2020-01-01' WHERE id = ?`, pc.id);
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);

  // Cancelling a non-scheduled (already cancelled) row throws 409.
  assert.throws(() => plans.cancelPriceChange(id, pc.id), (err) => err.status === 409);
});

test('planDeletability: applied price-change history blocks delete; scheduled/cancelled do not', () => {
  const { id: appliedId } = plans.createPlan({ name: 'AppliedHistory', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const pc = plans.schedulePriceChange(appliedId, { newPriceCents: 2500, appliesTo: 'existing_and_new',
    effectiveDate: '2020-01-01' }, 1);
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT status FROM plan_price_changes WHERE id = ?`, pc.id).status, 'applied');
  const del = plans.planDeletability(appliedId);
  assert.equal(del.deletable, false);
  assert.throws(() => plans.deletePlan(appliedId));

  const { id: scheduledId } = plans.createPlan({ name: 'ScheduledOnly', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  plans.schedulePriceChange(scheduledId, { newPriceCents: 2500, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  assert.equal(plans.planDeletability(scheduledId).deletable, true);
  plans.deletePlan(scheduledId);

  const { id: cancelledId } = plans.createPlan({ name: 'CancelledOnly', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const pc2 = plans.schedulePriceChange(cancelledId, { newPriceCents: 2500, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  plans.cancelPriceChange(cancelledId, pc2.id);
  assert.equal(plans.planDeletability(cancelledId).deletable, true);
  plans.deletePlan(cancelledId);
});
