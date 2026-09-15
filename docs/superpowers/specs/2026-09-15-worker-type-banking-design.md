# Worker Type & Banking Information — Design Spec

**Date**: 2026-09-15
**Scope**: Two features only — worker classification (W-2 / 1099) and banking/payroll information storage with encryption at rest.

---

## 1. Data Model

### 1.1 `employees` table — new column

```sql
ALTER TABLE employees ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'W2'
  CHECK(worker_type IN ('W2','1099'));
```

Existing employees default to `W2`. The column lives directly on `employees` because classification is a simple attribute that rarely changes (like `status`).

### 1.2 New `employee_banking` table

```sql
CREATE TABLE IF NOT EXISTS employee_banking (
  employee_id          INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  account_holder_name  TEXT NOT NULL,
  bank_name            TEXT NOT NULL,
  account_type         TEXT NOT NULL CHECK(account_type IN ('checking','savings')),
  routing_number_enc   TEXT NOT NULL,
  account_number_enc   TEXT NOT NULL,
  account_last4        TEXT NOT NULL,
  routing_last4        TEXT NOT NULL,
  direct_deposit       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now'))
);
```

- One row per employee (1:1 relationship).
- `_enc` fields store AES-256-GCM encrypted values (format: `iv:ciphertext:authTag`).
- `_last4` fields store last 4 digits in plaintext for masked display without decryption.

### 1.3 Encryption module (`lib/encryption.js`)

- AES-256-GCM via Node built-in `crypto`.
- Requires `ENCRYPTION_KEY` env var: 64-character hex string (32 bytes).
- Each call generates a random 12-byte IV.
- Stored format: `iv:ciphertext:authTag` as a colon-separated string.
- If `ENCRYPTION_KEY` is missing, banking endpoints return HTTP 503.
- Key rotation out of scope; format supports it later.

---

## 2. API Design

### 2.1 Worker Type — existing endpoints extended

| Endpoint | Change |
|----------|--------|
| `POST /api/people/employees` | Accept `workerType` field (`W2` or `1099`) |
| `PATCH /api/people/employees/:id` | Accept `workerType` in edit payload |
| `GET /api/people/employees` | Accept `?workerType=W2` or `?workerType=1099` filter |
| `GET /api/people/employees/:id` | `worker_type` included automatically |

### 2.2 Banking — new admin/manager endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/people/employees/:id/banking` | `employees.banking.view` | Masked banking info; `?full=true` returns decrypted (admin/manager only) |
| PUT | `/api/people/employees/:id/banking` | `employees.banking.edit` | Create or update banking record |
| PATCH | `/api/people/employees/:id/banking` | `employees.banking.edit` | Partial update (e.g., toggle direct deposit) |

### 2.3 Banking — employee self-service endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/employee/banking` | `requireEmployee` (own record) | Own masked banking info |
| PUT | `/api/employee/banking` | `requireEmployee` (own record) | Create/update own banking info |
| PATCH | `/api/employee/banking` | `requireEmployee` (own record) | Toggle own direct deposit |

### 2.4 Payroll view extension

`GET /api/finance/payroll` adds two fields per employee:
- `workerType` — `W2` or `1099`
- `directDepositConfigured` — boolean

No full banking details in payroll responses.

### 2.5 Validation rules

- `PUT` banking requires: `accountHolderName`, `bankName`, `accountType`, `routingNumber`, `accountNumber`, `confirmAccountNumber`.
- `accountNumber` must equal `confirmAccountNumber` or the request is rejected with 400.
- `routingNumber` must be 9 digits.
- `accountNumber` must be 4–17 digits.

---

## 3. Frontend UI

### 3.1 Admin — Employee List

- New "Worker Type" column in `#empTable` showing "W-2" or "1099" badge.
- New filter dropdown next to existing Status filter: "All Workers" / "W-2 Employees" / "1099 Contractors".

### 3.2 Admin — Add Employee Form

- New "Worker Type" select after name fields: "W-2 Employee" / "1099 Contractor", default W-2.
- No banking fields in create form.

### 3.3 Admin — Employee Detail View

- Worker type in header card (e.g., "Pickup Technician · 1099 Contractor").
- New **Payroll & Banking card** after Pay card:
  - Configured: masked display (bank name, account type, ····XXXX, direct deposit status).
  - Not configured: "No banking information on file" + "Add Banking Info" button.
  - "Edit Banking" / "Toggle Direct Deposit" controls.

### 3.4 Admin — Edit Employee Form

- "Worker Type" select added to employment section (alongside status, hire date).
- Banking edited via its own card, not the general edit form.

### 3.5 Admin — Banking Edit Form (`#bankingEditCard`)

- Fields: Account Holder Name, Bank Name, Account Type, Routing Number, Account Number, Confirm Account Number, Direct Deposit toggle.
- Account number mismatch shows inline error, blocks save.
- Save encrypts and persists, returns to masked view.
- Cancel discards, returns to masked view.
- Integrated with `guardForm` for dirty-tracking.

### 3.6 Employee Dashboard — Profile tab

- Worker type as read-only label.
- New **"My Banking Info"** section:
  - Configured: masked display + "Edit" button.
  - Not configured: "Set up direct deposit" prompt + "Add Banking Info" button.
  - Same form as admin side, scoped to own record.

### 3.7 Admin — Payroll tab

- Two new columns: "Worker Type" badge and "Direct Deposit" status.
- No full banking details in table.

---

## 4. Security & Permissions

### 4.1 New permissions

| Permission | Category |
|------------|----------|
| `employees.banking.view` | Employees |
| `employees.banking.edit` | Employees |

### 4.2 Default role grants

| Role | `employees.banking.view` | `employees.banking.edit` |
|------|--------------------------|--------------------------|
| Admin | implicit (all) | implicit (all) |
| Manager | allowed | allowed |
| Employee/Contractor | own record only (route-level) | own record only (route-level) |
| Customer | no | no |

### 4.3 Enforcement

- Admin routes: `requirePermission('employees.banking.view')` / `requirePermission('employees.banking.edit')`.
- Employee routes: `requireEmployee` resolves own `employee_id` only.
- `?full=true` requires `employees.banking.view` — employees never see full numbers after entry.

### 4.4 What never happens

- Full account/routing numbers never in URL parameters.
- Full numbers never logged.
- Full numbers never in list/table endpoints.
- Full numbers never sent to frontend unless admin/manager requests `?full=true`.
- No banking data in `/api/finance/payroll` — only `directDepositConfigured` boolean.

### 4.5 Historical pay protection

- Changing `worker_type` updates `employees` row only.
- `time_entries` snapshot pay data at clock-in — no retroactive recalculation.

---

## 5. Migration Strategy

All schema changes run via the existing `migrate_admin.js` pattern:
1. `ALTER TABLE employees ADD COLUMN worker_type` (with default so existing rows are valid).
2. `CREATE TABLE IF NOT EXISTS employee_banking`.
3. Insert new permissions into `permissions` table.
4. Insert default `role_permissions` for manager role.

Idempotent — safe to run multiple times.

---

## 6. Out of Scope

- QuickBooks or any payroll provider integration.
- Tax withholding or W-4 fields.
- Encryption key rotation.
- Salary pay type.
- Separate contractor management system.
- Changes to unrelated features.
