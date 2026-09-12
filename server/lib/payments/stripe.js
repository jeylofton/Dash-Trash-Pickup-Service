/* Stripe provider - not implemented.

   To switch:
     1. npm install stripe
     2. Implement the five functions below against Stripe Billing:
          customers.create, paymentMethods.attach,
          subscriptions.create, subscriptions.cancel
     3. Set PAYMENT_PROVIDER=stripe and STRIPE_SECRET_KEY in .env
     4. Replace the Square Web Payments SDK in the public site with
        Stripe Elements (lib/payments is server-side only; the card
        form is separate).
*/
const notImplemented = () => {
  throw new Error('Stripe provider is not implemented. Set PAYMENT_PROVIDER=square.');
};

export const createCustomer = notImplemented;
export const saveCard = notImplemented;
export const createSubscription = notImplemented;
export const cancelSubscription = notImplemented;
export const describeError = () => 'Payment could not be completed.';
