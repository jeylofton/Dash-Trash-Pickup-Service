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
