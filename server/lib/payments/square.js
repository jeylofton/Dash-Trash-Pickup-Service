/* ============================================================
   Thin Square REST client.

   Uses Square's HTTP API directly rather than the SDK, so this
   code doesn't break when the SDK's package name or method
   signatures change. Endpoints and the Square-Version header are
   the stable contract.

   Docs: https://developer.squareup.com/reference/square
   ============================================================ */

import { randomUUID } from 'node:crypto';

const ENV = process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';

const BASE_URL = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2025-01-23';

export const squareEnvironment = ENV;

/** Square rejects a request that reuses an idempotency key with different data,
 *  and returns the ORIGINAL result if the data matches. That is what stops a
 *  double-clicked button from charging a customer twice. */
export const idempotencyKey = () => randomUUID();

export class SquareError extends Error {
  constructor(message, { status, errors, endpoint }) {
    super(message);
    this.name = 'SquareError';
    this.status = status;
    this.errors = errors || [];
    this.endpoint = endpoint;
  }
  /** The customer-safe version. Square's raw errors can leak internals. */
  publicMessage() {
    const first = this.errors[0];
    if (!first) return 'Payment could not be completed. Please try again.';
    switch (first.code) {
      case 'CARD_DECLINED':
      case 'GENERIC_DECLINE':
        return 'That card was declined. Please try a different card.';
      case 'CVV_FAILURE':
        return 'The security code did not match. Please check and try again.';
      case 'ADDRESS_VERIFICATION_FAILURE':
        return 'The billing ZIP code did not match your card. Please check and try again.';
      case 'EXPIRATION_FAILURE':
      case 'INVALID_EXPIRATION':
        return 'That expiration date is not valid.';
      case 'INSUFFICIENT_FUNDS':
        return 'The card has insufficient funds.';
      case 'CARD_TOKEN_EXPIRED':
      case 'CARD_TOKEN_USED':
        return 'That payment session expired. Please re-enter your card.';
      default:
        return 'Payment could not be completed. Please try again.';
    }
  }
}

async function squareFetch(endpoint, { method = 'POST', body } = {}) {
  if (!ACCESS_TOKEN) {
    throw new SquareError('SQUARE_ACCESS_TOKEN is not set', { status: 500, endpoint });
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok || data.errors) {
    const detail = data.errors?.[0]?.detail || res.statusText;
    throw new SquareError(`Square ${endpoint} failed: ${detail}`, {
      status: res.status,
      errors: data.errors,
      endpoint,
    });
  }
  return data;
}

/* ---------- Customers ---------- */
// https://developer.squareup.com/reference/square/customers-api/create-customer
export async function createCustomer({ firstName, lastName, email, phone, address }) {
  const { customer } = await squareFetch('/v2/customers', {
    body: {
      idempotency_key: idempotencyKey(),
      given_name: firstName,
      family_name: lastName,
      email_address: email,
      phone_number: phone,
      address: address ? {
        address_line_1: address.street,
        address_line_2: address.unit,
        locality: address.city,
        administrative_district_level_1: address.state,
        postal_code: address.zip,
        country: 'US',
      } : undefined,
      note: address?.community ? `Community: ${address.community}` : undefined,
    },
  });
  return customer;
}

/* ---------- Cards on file ---------- */
// https://developer.squareup.com/reference/square/cards-api/create-card
// `sourceId` is the single-use token produced by the Web Payments SDK in the
// browser. Raw card numbers never reach this server.
export async function saveCard({ sourceId, customerId, cardholderName, billingZip }) {
  const { card } = await squareFetch('/v2/cards', {
    body: {
      idempotency_key: idempotencyKey(),
      source_id: sourceId,
      card: {
        customer_id: customerId,
        cardholder_name: cardholderName,
        billing_address: billingZip
          ? { postal_code: billingZip, country: 'US' }
          : undefined,
      },
    },
  });
  return card;
}

/* ---------- Subscriptions ---------- */
// https://developer.squareup.com/reference/square/subscriptions-api/create-subscription
export async function createSubscription({ planProviderId, planVariationId, customerId, cardId, startDate, locationId }) {
  const variation = planProviderId || planVariationId;
  const { subscription } = await squareFetch('/v2/subscriptions', {
    body: {
      idempotency_key: idempotencyKey(),
      location_id: locationId,
      plan_variation_id: variation,
      customer_id: customerId,
      card_id: cardId,
      // YYYY-MM-DD in the location's timezone. Omitting it starts today.
      start_date: startDate || undefined,
    },
  });
  return subscription;
}

// https://developer.squareup.com/reference/square/subscriptions-api/cancel-subscription
export async function cancelSubscription(subscriptionId) {
  const { subscription } = await squareFetch(`/v2/subscriptions/${subscriptionId}/cancel`, {});
  return subscription;
}

/** Interface method: turn a provider error into something safe to show. */
export function describeError(err) {
  return err instanceof SquareError
    ? err.publicMessage()
    : 'Payment could not be completed. Please try again.';
}

/** Used by `npm start` to fail loudly at boot instead of at first checkout. */
export async function verifyCredentials() {
  const data = await squareFetch('/v2/locations', { method: 'GET' });
  return data.locations || [];
}
