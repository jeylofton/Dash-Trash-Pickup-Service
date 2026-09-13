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
