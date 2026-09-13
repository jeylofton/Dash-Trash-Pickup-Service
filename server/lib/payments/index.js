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
