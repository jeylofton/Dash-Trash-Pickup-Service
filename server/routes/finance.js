/* ============================================================
   Financial, payroll, and expense routes.

   ADMIN ONLY — the router mounts requireRole('admin') first, so
   nothing below is reachable by an employee or customer.
   ============================================================ */

import { Router } from 'express';
import { one, all, run } from '../db/index.js';
import { requirePermission } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { storage, uploadProblem } from '../lib/storage.js';
import {
  resolveRange, companyProfit, revenueByPlan, revenueByCommunity, revenueByRoute,
  revenueSeries, laborTotal, laborByEmployee, laborByRoute, laborSeries,
  expenseTotal, expensesByCategory, expenseSeries,
  routeProfitability, communityProfitability, unitEconomics, breakEven,
  pricingSimulation, lossAlerts, dollars, pct, STATUS_LABEL,
} from '../lib/finance.js';
import { currentPayPeriod, entryPayCents, MINUTES_SQL, rateOn } from '../lib/timeclock.js';
import { serviceDayStats, today } from '../lib/schedule.js';

export const router = Router();
/* Financial data is permission-gated, not merely admin-gated, so a custom
   role such as Bookkeeper can be given exactly what it needs. */
router.use(requirePermission(
  'financials.revenue.view', 'financials.profit.view', 'financials.expenses.view',
  'financials.reports.view', 'payroll.labor.view', 'payroll.pay.view',
));

const range = (req) => resolveRange(req.query.range, req.query.from, req.query.to);
const toMoney = (rows, key = 'cents') => rows.map(r => ({ ...r, amount: dollars(r[key] || 0) }));

/* ---------- Executive summary ---------- */

router.get('/summary', (req, res) => {
  const { start, end } = range(req);
  const c = companyProfit(start, end);
  const day = serviceDayStats(today());

  const clockedIn = one(
    `SELECT COUNT(*) AS n FROM time_entries WHERE clock_out_at IS NULL AND is_demo = 0`).n;
  const activeCustomers = one(
    `SELECT COUNT(*) AS n FROM customers WHERE status='active' AND is_demo = 0`).n;

  res.json({
    range: { start, end, label: req.query.range || 'month' },
    activeCustomers,
    revenue: dollars(c.revenueCents),
    expenses: dollars(c.expensesCents),
    labor: dollars(c.laborCents),
    laborHours: c.laborHours,
    operating: dollars(c.operatingCents),
    profit: dollars(c.profitCents),
    marginPct: c.marginPct,
    status: c.status,
    statusLabel: STATUS_LABEL[c.status],
    today: { scheduled: day.scheduled, completed: day.completed, remaining: day.remaining, issues: day.issues },
    employeesClockedIn: clockedIn,
    unitEconomics: unitEconomics(start, end),
    alerts: lossAlerts(start, end),
  });
});

/* ---------- Chart data ---------- */

router.get('/charts', (req, res) => {
  const { start, end } = range(req);
  const days = (new Date(end) - new Date(start)) / 86400000;
  const bucket = days > 120 ? 'month' : 'day';

  // Merge the three series onto one set of buckets so the chart has no gaps.
  const rev = new Map(revenueSeries(start, end, bucket).map(r => [r.bucket, r.cents]));
  const lab = new Map(laborSeries(start, end, bucket).map(r => [r.bucket, r.cents]));
  const exp = new Map(expenseSeries(start, end, bucket).map(r => [r.bucket, r.cents]));
  const buckets = [...new Set([...rev.keys(), ...lab.keys(), ...exp.keys()])].sort();

  const overTime = buckets.map(b => {
    const revenue = rev.get(b) || 0;
    const labor = lab.get(b) || 0;
    const operating = exp.get(b) || 0;
    return {
      bucket: b,
      revenue: dollars(revenue),
      expenses: dollars(labor + operating),
      labor: dollars(labor),
      profit: dollars(revenue - labor - operating),
    };
  });

  res.json({
    range: { start, end, bucket },
    overTime,
    revenueByCommunity: toMoney(revenueByCommunity(start, end)),
    revenueByRoute: toMoney(revenueByRoute(start, end)),
    revenueByPlan: toMoney(revenueByPlan(start, end)),
    expensesByCategory: toMoney(expensesByCategory(start, end)),
    profitByCommunity: communityProfitability(start, end)
      .map(c => ({ label: c.label, amount: dollars(c.profitCents), marginPct: c.marginPct, status: c.status })),
    profitByRoute: routeProfitability(start, end)
      .map(r => ({ label: r.label, amount: dollars(r.profitCents), marginPct: r.marginPct, status: r.status })),
    laborByEmployee: laborByEmployee(start, end)
      .map(e => ({ label: `${e.first_name} ${e.last_name}`, amount: dollars(e.cents), hours: Math.round(e.minutes / 6) / 10 })),
    customersOverTime: all(
      `SELECT strftime('${bucket === 'month' ? '%Y-%m' : '%Y-%m-%d'}', created_at) AS bucket,
              COUNT(*) AS added FROM customers
        WHERE is_demo = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`, start, end),
  });
});

/* ---------- Profitability ---------- */

router.get('/profitability', (req, res) => {
  const { start, end } = range(req);
  const money = (o, keys) => Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, keys.includes(k) ? dollars(v) : v]));
  const MONEY_KEYS = ['revenueCents','laborCents','directExpenseCents','allocatedExpenseCents','expensesCents','profitCents'];
  const clean = (r) => ({
    ...money(r, MONEY_KEYS),
    revenue: dollars(r.revenueCents), labor: dollars(r.laborCents),
    expenses: dollars(r.expensesCents), profit: dollars(r.profitCents),
    statusLabel: STATUS_LABEL[r.status],
  });

  res.json({
    range: { start, end },
    company: { ...companyProfit(start, end), statusLabel: STATUS_LABEL[companyProfit(start, end).status] },
    routes: routeProfitability(start, end).map(clean),
    communities: communityProfitability(start, end).map(clean),
    unitEconomics: unitEconomics(start, end),
    breakEven: breakEven(start, end),
    alerts: lossAlerts(start, end),
  });
});

router.get('/pricing-simulator', (req, res) => {
  const { start, end } = range(req);
  const prices = req.query.prices
    ? String(req.query.prices).split(',').map(Number).filter(n => n > 0)
    : undefined;
  const sim = pricingSimulation(start, end, prices);
  res.json({ ...sim, rows: sim.rows.map(r => ({ ...r, statusLabel: STATUS_LABEL[r.status] })) });
});

/* ---------- Expenses ---------- */

router.get('/expense-categories', (req, res) => {
  res.json(all('SELECT * FROM expense_categories WHERE active = 1 ORDER BY sort_order'));
});

router.get('/expenses', (req, res) => {
  const { start, end } = range(req);
  res.json(all(`
    SELECT e.*, ec.name AS category_name, ec.code AS category_code,
           r.name AS route_name, com.name AS community_name
      FROM expenses e
      JOIN expense_categories ec ON ec.id = e.category_id
      LEFT JOIN routes r ON r.id = e.route_id
      LEFT JOIN communities com ON com.id = e.community_id
     WHERE e.incurred_on BETWEEN ? AND ?
     ORDER BY e.incurred_on DESC, e.id DESC`, start, end)
    .map(e => ({ ...e, amount: dollars(e.amount_cents) })));
});

router.post('/expenses', requirePermission('financials.expenses.create'), async (req, res) => {
  const {
    categoryCode, description, amount, incurredOn, vendor,
    routeId, communityId, isRecurring, recurrence, notes, receipt,
  } = req.body || {};

  const category = one('SELECT * FROM expense_categories WHERE code = ?', categoryCode);
  if (!category) return res.status(400).json({ error: 'Unknown expense category.' });

  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    return res.status(400).json({ error: 'Amount must be a positive number.' });
  }
  if (!description) return res.status(400).json({ error: 'Description is required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incurredOn || '')) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  }

  let receiptKey = null;
  if (receipt?.dataUrl) {
    const buffer = Buffer.from(String(receipt.dataUrl).split(',').pop(), 'base64');
    const mimeType = receipt.mimeType || 'image/jpeg';
    const problem = uploadProblem({ mimeType, bytes: buffer.length });
    if (problem) return res.status(400).json({ error: problem });
    receiptKey = await storage.put(buffer, { mimeType });
  }

  const id = run(`
    INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor,
                          route_id, community_id, is_recurring, recurrence, receipt_key,
                          notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    category.id, description, cents, incurredOn, vendor ?? null,
    routeId ?? null, communityId ?? null, isRecurring ? 1 : 0,
    isRecurring ? (recurrence ?? 'monthly') : null, receiptKey, notes ?? null, req.user.id
  ).lastInsertRowid;

  audit(req, 'expense.created', {
    entityType: 'expense', entityId: id,
    detail: { category: categoryCode, amount: dollars(cents), vendor: vendor ?? null },
  });
  res.status(201).json({ id });
});

router.delete('/expenses/:id', requirePermission('financials.expenses.edit'), (req, res) => {
  const e = one('SELECT * FROM expenses WHERE id = ?', req.params.id);
  if (!e) return res.status(404).json({ error: 'Expense not found.' });
  run('DELETE FROM expenses WHERE id = ?', e.id);
  audit(req, 'expense.deleted', {
    entityType: 'expense', entityId: e.id,
    detail: { description: e.description, amount: dollars(e.amount_cents) },
  });
  res.json({ ok: true });
});

/* ---------- Payroll ---------- */

router.get('/payroll', requirePermission('payroll.pay.view'), (req, res) => {
  const period = req.query.from && req.query.to
    ? { start: req.query.from, end: req.query.to }
    : currentPayPeriod();

  const rows = laborByEmployee(period.start, period.end).map(e => {
    const emp = one(`SELECT worker_type FROM employees WHERE id = ?`, e.employee_id);
    const banking = one(`SELECT direct_deposit FROM employee_banking WHERE employee_id = ?`, e.employee_id);
    return {
      employeeId: e.employee_id,
      name: `${e.first_name} ${e.last_name}`,
      payType: e.pay_type,
      rate: dollars(e.rate_cents),
      shifts: e.shifts,
      hours: Math.round(e.minutes / 6) / 10,
      estimatedPay: dollars(e.cents),
      workerType: emp?.worker_type || 'W2',
      directDepositConfigured: Boolean(banking),
    };
  });

  res.json({
    period,
    rows,
    totalEstimatedPay: dollars(rows.reduce((a, r) => a + Math.round(r.estimatedPay * 100), 0)),
  });
});

/** CSV export for the pay period. */
router.get('/payroll.csv', requirePermission('payroll.pay.view','reports.export'), (req, res) => {
  const period = req.query.from && req.query.to
    ? { start: req.query.from, end: req.query.to }
    : currentPayPeriod();
  const rows = laborByEmployee(period.start, period.end);

  // Prefix cells that could be read as a formula - CSV injection protection.
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [['Employee','Pay type','Rate','Shifts','Hours','Estimated pay'].map(cell).join(',')];
  for (const e of rows) {
    lines.push([
      `${e.first_name} ${e.last_name}`, e.pay_type, dollars(e.rate_cents).toFixed(2),
      e.shifts, (Math.round(e.minutes / 6) / 10).toFixed(1), dollars(e.cents).toFixed(2),
    ].map(cell).join(','));
  }
  const total = rows.reduce((a, e) => a + e.cents, 0);
  lines.push(['TOTAL','','','','', dollars(total).toFixed(2)].map(cell).join(','));

  audit(req, 'payroll.exported', { detail: { ...period, employees: rows.length } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="payroll-${period.start}-to-${period.end}.csv"`);
  res.send(lines.join('\n'));
});

/* ---------- Employee compensation + timesheets ---------- */

router.get('/employees/:id/compensation', (req, res) => {
  res.json({
    current: rateOn(req.params.id, today()),
    history: all(`SELECT * FROM employee_compensation WHERE employee_id = ?
                   ORDER BY effective_date DESC`, req.params.id),
  });
});

router.post('/employees/:id/compensation', requirePermission('payroll.compensation.edit','employees.pay.rate'), (req, res) => {
  const { payType, rate, effectiveDate, note } = req.body || {};
  if (!['hourly', 'daily'].includes(payType)) {
    return res.status(400).json({ error: 'Pay type must be hourly or daily.' });
  }
  const cents = Math.round(Number(rate) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    return res.status(400).json({ error: 'Rate must be a positive number.' });
  }
  const date = effectiveDate || today();

  // End the previous rate the day before the new one starts, so the two
  // never overlap and rateOn() always has exactly one answer.
  run(`UPDATE employee_compensation SET end_date = date(?, '-1 day')
        WHERE employee_id = ? AND end_date IS NULL`, date, req.params.id);
  const id = run(
    `INSERT INTO employee_compensation (employee_id, pay_type, rate_cents, effective_date, created_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    req.params.id, payType, cents, date, req.user.id, note ?? null).lastInsertRowid;

  audit(req, 'employee.compensation_set', {
    entityType: 'employee', entityId: Number(req.params.id),
    detail: { payType, rate: dollars(cents), effectiveDate: date },
  });
  res.status(201).json({ id });
});

router.get('/timesheets', (req, res) => {
  const { start, end } = range(req);
  res.json(all(`
    SELECT te.*, ${MINUTES_SQL} AS minutes,
           u.first_name, u.last_name, r.name AS route_name
      FROM time_entries te
      JOIN employees e ON e.id = te.employee_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN routes r ON r.id = te.route_id
     WHERE te.work_date BETWEEN ? AND ?
     ORDER BY te.clock_in_at DESC LIMIT 300`, start, end)
    .map(t => ({ ...t, payCents: entryPayCents(t), pay: dollars(entryPayCents(t)) })));
});

/** Correct a clock-in or clock-out. Always audited, reason required. */
router.patch('/timesheets/:id', requirePermission('time.edit'), (req, res) => {
  const entry = one('SELECT * FROM time_entries WHERE id = ?', req.params.id);
  if (!entry) return res.status(404).json({ error: 'Time entry not found.' });

  const { clockInAt, clockOutAt, breakMinutes, reason } = req.body || {};
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'A reason is required for a timesheet correction.' });
  }

  const before = {
    clockInAt: entry.clock_in_at, clockOutAt: entry.clock_out_at,
    breakMinutes: entry.break_minutes,
  };

  run(`UPDATE time_entries
          SET clock_in_at = COALESCE(?, clock_in_at),
              clock_out_at = COALESCE(?, clock_out_at),
              break_minutes = COALESCE(?, break_minutes),
              source = 'admin', edited_by = ?, edit_reason = ?
        WHERE id = ?`,
      clockInAt ?? null, clockOutAt ?? null,
      breakMinutes == null ? null : Math.max(0, Number(breakMinutes)),
      req.user.id, String(reason).trim(), entry.id);

  const after = one('SELECT * FROM time_entries WHERE id = ?', entry.id);
  audit(req, 'timeclock.corrected', {
    entityType: 'time_entry', entityId: entry.id,
    detail: { before, after: { clockInAt: after.clock_in_at, clockOutAt: after.clock_out_at,
                               breakMinutes: after.break_minutes }, reason },
  });
  res.json({ ok: true });
});

/* ---------- Employee operational performance ---------- */

router.get('/employee-performance', (req, res) => {
  const { start, end } = range(req);
  res.json(all(`
    SELECT e.id AS employee_id, u.first_name, u.last_name,
           (SELECT COUNT(*) FROM service_stops ss
              JOIN route_assignments ra ON ra.route_id = ss.route_id
             WHERE ra.employee_id = e.id AND ss.service_date BETWEEN ? AND ?
               AND ra.effective_date <= ss.service_date
               AND (ra.end_date IS NULL OR ra.end_date >= ss.service_date)) AS stops_assigned,
           (SELECT COUNT(*) FROM pickup_records pr
             WHERE pr.employee_id = e.id AND pr.service_date BETWEEN ? AND ?) AS stops_completed,
           (SELECT COUNT(*) FROM pickup_records pr
             WHERE pr.employee_id = e.id AND pr.status = 'issue'
               AND pr.service_date BETWEEN ? AND ?) AS issues
      FROM employees e JOIN users u ON u.id = e.user_id
     WHERE e.status = 'active' AND e.is_demo = 0`, start, end, start, end, start, end)
    .map(r => {
      const labor = laborByEmployee(start, end).find(l => l.employee_id === r.employee_id);
      return {
        ...r,
        name: `${r.first_name} ${r.last_name}`,
        hours: labor ? Math.round(labor.minutes / 6) / 10 : 0,
        estimatedPay: labor ? dollars(labor.cents) : 0,
        completionRate: r.stops_assigned ? pct(r.stops_completed, r.stops_assigned) : null,
      };
    }));
});
