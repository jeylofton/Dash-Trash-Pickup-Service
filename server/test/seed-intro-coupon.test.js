import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

// Exercise the real seed file's seeding logic (not a hand-written copy of
// its INSERT) so this test catches the same class of drift that let
// duration_periods go missing in the first place: a duplicate INSERT would
// only ever agree with itself.
const { seedDiscounts } = await import('../db/seed_discounts.js');
const { one } = await import('../db/index.js');

seedDiscounts();

test('the seeded DASHLAUNCH coupon carries the 12-month promotional term', () => {
  const coupon = one(`SELECT * FROM coupons WHERE code = 'DASHLAUNCH'`);
  assert.ok(coupon, 'DASHLAUNCH coupon should exist after seeding');

  // duration_periods must be 12 (billing periods), not NULL — NULL means
  // "this rate never ends", which would silently turn the 12-month intro
  // offer into $18/month forever.
  assert.equal(coupon.duration_periods, 12);
  assert.equal(coupon.discount_value, 1800);
  assert.equal(coupon.max_redemptions, 100);
  assert.equal(coupon.eligible_customer_type, 'new');
  assert.equal(coupon.is_intro, 1);
});
