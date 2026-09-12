/* ============================================================
   Payment provider interface.

   Nothing outside this folder knows which provider is in use.
   Swap providers with PAYMENT_PROVIDER=stripe once stripe.js is
   implemented - no route code changes.

   Every provider must implement:
     createCustomer({ firstName, lastName, email, phone, address })
     saveCard({ sourceId, customerId, cardholderName, billingZip })
     createSubscription({ planProviderId, customerId, cardId, startDate })
     cancelSubscription(providerSubscriptionId)
     describeError(err) -> customer-safe string
   ============================================================ */

import * as square from './square.js';
import * as stripe from './stripe.js';

const providers = { square, stripe };
const name = process.env.PAYMENT_PROVIDER || 'square';

export const payments = providers[name] || square;
export const providerName = providers[name] ? name : 'square';
