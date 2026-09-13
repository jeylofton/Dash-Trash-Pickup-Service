# Security Audit — First Pass Findings

**Date:** 2026-09-13
**Scope:** the 50-section security update, audited against the code as it
stands on branch `remove-square-demo-payments`.

## Headline

The application is in considerably better security shape than the update
assumes. Most of what the spec asks for is already built and enforced
server-side. The gaps are real but bounded, and none of them is an active
data breach.

## Verified already correct — no work needed

| Spec section | Finding |
|---|---|
| 2 Authentication | Passwords hashed with scrypt. Never returned, logged, or shown. |
| 4 RBAC server-side | `requireRole` / `requirePermission` enforced in routers, not the UI. |
| 8 Session security | Random token, **only the SHA-256 hash stored**, `httpOnly`, `sameSite=lax`, `secure` in production, 14-day expiry, revocation and purge exist. |
| 14 GitHub hygiene | `.gitignore` covers `.env`, `.env.production`, `*.db`, uploads. No database or photo is tracked. |
| 15/16 Exposed secrets | **Scanned every commit in history.** No access token, private key, or live secret was ever committed. `server/.env` was never tracked. Only the Square *application ID* appears, which is publishable by design. **Nothing needs rotating.** |
| 18 SQL injection | Every query uses prepared statements via `db.prepare(...)`. No string-concatenated SQL found. |
| 19 XSS | Disciplined `esc()` helper; 190 uses in `admin.js` against 47 `innerHTML`. Unescaped interpolations sampled were numeric ids and counts. |
| 21/22 Login brute force | Login is rate-limited: 15-minute window, 429 response. |
| 35 CORS | Origin allowlist, no wildcard, and no `Access-Control-Allow-Credentials`. |
| 37 Mass assignment | **No route spreads `req.body`.** Every field is picked explicitly. |
| 38 Privilege escalation | Self-targeting guards exist: cannot lock your own account, change your own role, or delete your own account. |
| 29 Audit log | `audit()` records actor, action, entity, and detail. |

## Real gaps, by severity

### Important

1. **No HTTP security headers at all** (spec 34). No CSP,
   `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, or
   HSTS. Nothing sets them.
2. **The demo password is in the repository and pre-filled in the login
   page** (spec 41, 42). `DashDemo2026` appears in `dashboard/login.html`
   twice — including a script that types it into the password field — and in
   `server/db/seed.js`. This must not reach production.
3. **No security acceptance tests** (spec 49). The spec names twelve; none
   exist. Given the authorization posture is good, these would mostly *prove*
   existing behaviour — which is exactly what makes them worth having, since
   nothing currently stops a future change from silently removing a guard.
4. **No HTTPS redirect** (spec 7). Nothing forces TLS.
5. **Uniform 14-day sessions** (spec 9). An admin session lasts as long as a
   customer's, with no shorter idle timeout and no reauthentication for
   sensitive actions.
6. **Two moderate dependency vulnerabilities** (spec 45), reported by
   `npm audit`.

### Worth doing, larger

7. **No MFA and no scaffolding for it** (spec 3).
8. **No self-service password reset** (spec 23). There is a
   `password_reset_events` audit table and an admin-initiated path, but no
   tokenised, expiring, single-use self-service flow. Note this needs email,
   which the project does not have.

### To verify rather than assume

9. **Object-level authorization** (spec 5). `customerOwnsRecord`,
   `employeeMayServiceUnit` and `mayViewPhoto` all exist, which is the right
   shape — but they need adversarial testing, not code reading, to confirm
   every record-fetching endpoint actually calls them.
10. **Photo access** (spec 24). `GET /api/photos/:id` requires auth and there
    is a `mayViewPhoto` helper. Whether photos are served as short-lived
    signed URLs or straight from disk needs checking.
11. **Public coupon validation** (`POST /api/promo/coupons/validate`) is
    deliberately unauthenticated. It should be rate-limited and must not leak
    coupon internals.

## Recommended sequencing

Three pieces, in this order:

1. **Hardening pass** — items 1-6 above. Mostly small, mostly config, high
   value per line changed.
2. **Adversarial verification** — write the twelve acceptance tests from spec
   49 and actually attack the running app: cross-customer record access, an
   employee calling finance endpoints, URL id tampering, stored XSS in notes,
   SQL injection in search, unauthorized photo fetch. Fix whatever they find.
3. **New capability** — MFA and self-service password reset. These are
   features, not hardening, and password reset depends on email.

## Note on scope

Sections 7, 10, 12, 31, 34 and 43 depend on production hosting, which does
not exist yet. They should be settled when a host is chosen; they cannot be
finished in the codebase alone.
