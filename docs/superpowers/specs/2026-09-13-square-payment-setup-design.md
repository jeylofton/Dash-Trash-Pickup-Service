# Square Payment Processor — Activation Design

**Date:** 2026-09-13
**Status:** Approved

## Problem

The Square integration is already implemented end to end. It is inert because
`server/.env` still holds the values from `.env.example`: no access token, a
placeholder application ID, a placeholder location ID, and four empty plan
variation IDs. The site therefore runs in demo mode — signup completes and
nothing is charged.

The work is activation and configuration, not feature construction.

## Already built (not modified)

| Layer | File |
|---|---|
| Square REST client, error mapping, credential check | `server/lib/payments/square.js` |
| Provider abstraction | `server/lib/payments/index.js` |
| `/api/checkout`, `/api/config`, webhook HMAC verify | `server/server.js` |
| Web Payments SDK card iframe + tokenize | `scripts.js` |
| Cancel subscription | `server/routes/customer.js` |
| `plans`, `subscriptions`, `payments` tables | `server/db/schema.sql` |

## Decisions

1. **Both environments.** Sandbox is wired and verified first; production
   catalog plans are created at the same time so go-live is a credential swap.
2. **Plans created via the Catalog API**, not hand-entered in the dashboard.
3. **Introductory rate bills $18/month for 12 months, then $28/month.**
4. **Variation IDs are written to both `.env` and `plans.provider_plan_id`.**

### Consequence of decision 3

The live site advertises "$18/month" with no stated end date. A 12-month term
must be disclosed on the page. Copy changes are part of this work, not
optional follow-up.

## Components

### 1. `server/bin/square-setup.js` (new)

One-time, idempotent CLI.

```
node bin/square-setup.js --env=sandbox
node bin/square-setup.js --env=production
```

Steps:

1. Load `.env` (sandbox) or `.env.production` (production) before importing
   `square.js`, which captures credentials at module load.
2. `GET /v2/locations` to verify the token. Fail loudly with the exact fix.
3. Resolve the location ID; default to the account's first location if unset.
4. Search the catalog for `SUBSCRIPTION_PLAN` objects by name. Reuse what
   exists so re-running never creates duplicates.
5. Create only the missing plans.
6. Write `SQUARE_PLAN_*` and `SQUARE_LOCATION_ID` back into the env file,
   preserving comments and key order.
7. Write `plans.provider_plan_id` in SQLite — only when the target environment
   matches the active `SQUARE_ENVIRONMENT`, because that column holds one
   environment's IDs at a time.

Reuses `squareFetch` and `SquareError` from `square.js`; no second HTTP client.
`squareFetch` is exported for this purpose.

### 2. Catalog plan definitions

Prices derive from `CONFIG.pricing` in `scripts.js` (monthly 28, quarterly
discount 10, annual discount 60) so Square and the site cannot drift.

| Plan | Phases | `.env` key |
|---|---|---|
| Introductory | MONTHLY $18.00 × 12 periods, then MONTHLY $28.00 ongoing | `SQUARE_PLAN_INTRODUCTORY` |
| Monthly | MONTHLY $28.00 ongoing | `SQUARE_PLAN_MONTHLY` |
| Quarterly | EVERY_THREE_MONTHS $74.00 ongoing | `SQUARE_PLAN_QUARTERLY` |
| Annual | ANNUAL $276.00 ongoing | `SQUARE_PLAN_ANNUAL` |

### 3. Disclosure copy

`CONFIG.intro` gains `termMonths: 12`. The follow-on price derives from
`CONFIG.pricing.monthly` — it is never typed as a literal. New
`[data-intro-term]` and `[data-intro-after]` hooks render like the existing
`[data-intro-price]`.

Updated in `index.html`: the offer headline, the offer fine print, the promo
modal fine print, and the introductory-rate FAQ answer.

### 4. `server/.env.production.example` (new)

Production counterpart of `.env.example`. The browser SDK swap already works —
`index.html` carries both `data-sandbox-src` and `data-production-src`.

## Verification

Sandbox, end to end, with Square test cards:

- `4111 1111 1111 1111` — success
- `4000 0000 0000 0002` — decline
- CVV failure card — error mapping

Confirm: a customer, a card on file, and a subscription on the correct
variation appear in the sandbox dashboard; the intro counter decrements on
success; a declined card **releases** the reserved intro spot; `npm start`
reports credentials OK with no unset-plan warnings.

## Out of scope

Stripe implementation. Proration on plan change. Dunning for failed renewals.

---

## Outcome (2026-09-13)

Sandbox activated and verified end to end.

Location `L2KVMSDQSWVWM` (Default Test Account). Plan variations created:

| Plan | Square billing | Variation ID |
|---|---|---|
| Introductory | MONTHLY $18 x12, then MONTHLY $28 ongoing | `4P4LWHPXHFSAW3Z5KVFLV2ZV` |
| Monthly | MONTHLY $28 | `KWJE6KPBI7SCBI4CVTXWUKBS` |
| Quarterly | QUARTERLY $74 | `TY6SPMOPOG4DQ2W22LJXTKYY` |
| Annual | ANNUAL $276 | `TYJLQOQCPN5HVEJ6X47WHSAV` |

Verified: customer, card on file with billing ZIP, subscription on the correct
variation with the requested start date, address and community note. Declined
cards fail cleanly and release the reserved introductory spot. Test data was
cancelled and removed afterwards.

### Corrections made during activation

1. `EVERY_THREE_MONTHS` is not a valid Square cadence. It is `QUARTERLY`.
2. `publicMessage()` mapped only Payments API error codes, but saving a card
   uses the Cards API. Added `VERIFY_CVV_FAILURE`, `VERIFY_AVS_FAILURE`,
   `CARD_EXPIRED`, `INVALID_CARD_DATA`, `CARD_DECLINED_VERIFICATION_REQUIRED`.
3. The payment step said "at $18 until you cancel" on the screen where the card
   is entered, contradicting the 12-month term. Now states both phases.

## Known defect - deferred to its own design

**Public signups never reach SQLite.** `/api/checkout` writes to Square and to
`server/data/signups.json`, and creates no `users`, `customers`,
`subscriptions`, or `payments` row. Every customer and subscription currently
in the database is seeded demo data.

Consequences for a real paying customer:

- absent from the admin dashboard
- cannot log into the customer portal (no `users` row, so no password)
- no local subscription, so the cancel path in `routes/customer.js` cannot
  find them
- cannot be assigned to a route or pickup schedule
- no payment history

The frozen introductory counter is a symptom of the same gap. The public count
comes from `coupon_redemptions` while the checkout cap comes from
`signups.json`, and `redeem()` in `lib/coupons.js` has no callers because it
requires a local `customers` row that checkout never creates. The advertised
"spots remaining" therefore never decreases and the coupon's
`max_redemptions` is never enforced.

Fixing it means `/api/checkout`, after Square succeeds, creating the user,
customer, address/unit link and subscription in one transaction, then calling
`redeem()`, with the introductory reservation moved onto `coupon_redemptions`.
That carries its own design questions - password setup, what happens when the
database write fails after Square has already charged, and community/unit
matching - so it gets its own spec rather than being folded in here.

**Deferred by decision, not oversight.**
