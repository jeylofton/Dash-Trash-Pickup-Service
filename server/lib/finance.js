/* ============================================================
   Revenue, labor, expenses, profitability.

   Everything here is DERIVED from transactions. Nothing stores a
   total, so a figure can never drift away from the rows that
   produced it.

   Money is integer cents everywhere. Floats are introduced only at
   the very end, for display.
   ============================================================ */

import { one, all } from '../db/index.js';

/* ---------- shared helpers ---------- */

export const dollars = (cents) => Math.round(cents) / 100;
export const pct = (part, whole) => whole ? Math.round((part / whole) * 1000) / 10 : 0;

/** Resolve a named range to [start, end] ISO dates. */
export function resolveRange(range = 'month', from, to) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const start = new Date(now);

  switch (range) {
    case 'today':   break;
    case 'week':    start.setDate(now.getDate() - now.getDay()); break;
    case '7d':      start.setDate(now.getDate() - 6); break;
    case '30d':     start.setDate(now.getDate() - 29); break;
    case '90d':     start.setDate(now.getDate() - 89); break;
    case 'month':   start.setDate(1); break;
    case 'quarter': start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); break;
    case 'ytd':
    case 'year':    start.setMonth(0, 1); break;
    case '12m':     start.setMonth(now.getMonth() - 11, 1); break;
    case 'custom':
      if (from && to) return { start: from, end: to, range };
      break;
  }
  return { start: iso(start), end: iso(now), range };
}

/* ============================================================
   REVENUE - only money actually collected.
   Failed, pending, refunded, and cancelled are excluded by design.
   ============================================================ */

const COLLECTED = `status = 'paid'`;

export function revenueTotal(start, end) {
  return one(
    `SELECT COALESCE(SUM(amount_cents),0) AS c FROM payments
      WHERE ${COLLECTED} AND date(COALESCE(paid_at, created_at)) BETWEEN ? AND ?`,
    start, end).c;
}

export function revenueByPlan(start, end) {
  return all(
    `SELECT COALESCE(pl.code,'Unknown') AS label,
            COUNT(*) AS count, SUM(p.amount_cents) AS cents
       FROM payments p
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN plans pl ON pl.id = s.plan_id
      WHERE p.${COLLECTED} AND date(COALESCE(p.paid_at, p.created_at)) BETWEEN ? AND ?
      GROUP BY pl.id ORDER BY cents DESC`, start, end);
}

export function revenueByCommunity(start, end) {
  return all(
    `SELECT COALESCE(com.name,'Standalone addresses') AS label,
            com.id AS community_id,
            COUNT(DISTINCT p.customer_id) AS customers,
            SUM(p.amount_cents) AS cents
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN service_addresses sa ON sa.customer_id = c.id AND sa.end_date IS NULL
       LEFT JOIN units u ON u.id = sa.unit_id
       LEFT JOIN communities com ON com.id = u.community_id
      WHERE p.${COLLECTED} AND date(COALESCE(p.paid_at, p.created_at)) BETWEEN ? AND ?
      -- GROUP BY com.id ONLY. Grouping by the output alias "label" would bind
      -- to units.label instead (a real column shadows an alias), producing one
      -- row per unit rather than per community.
      GROUP BY com.id ORDER BY cents DESC`, start, end);
}

export function revenueByRoute(start, end) {
  /* A customer served twice a week appears on TWO routes (Tue and Thu).
     Joining payments straight to routes would count the same dollar on
     each, so revenue is SPLIT evenly across the routes that serve the
     unit — each route is credited with the share of service it delivers. */
  return all(
    `WITH unit_routes AS (
       SELECT u.id AS unit_id, rs.route_id
         FROM units u
         JOIN route_stops rs ON (rs.community_id = u.community_id OR rs.unit_id = u.id)
        GROUP BY u.id, rs.route_id
     ),
     unit_route_count AS (
       SELECT unit_id, COUNT(*) AS n FROM unit_routes GROUP BY unit_id
     )
     SELECT r.id AS route_id,
            r.name || ' (' || CASE r.day_of_week
              WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
              WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END || ')' AS label,
            COUNT(DISTINCT p.customer_id) AS customers,
            CAST(SUM(CAST(p.amount_cents AS REAL) / urc.n) AS INTEGER) AS cents
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN service_addresses sa ON sa.customer_id = c.id AND sa.end_date IS NULL
       JOIN unit_routes ur ON ur.unit_id = sa.unit_id
       JOIN unit_route_count urc ON urc.unit_id = sa.unit_id
       JOIN routes r ON r.id = ur.route_id
      WHERE p.${COLLECTED} AND date(COALESCE(p.paid_at, p.created_at)) BETWEEN ? AND ?
      GROUP BY r.id ORDER BY cents DESC`, start, end);
}

export function revenueSeries(start, end, bucket = 'day') {
  const fmt = bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return all(
    `SELECT strftime('${fmt}', COALESCE(paid_at, created_at)) AS bucket,
            SUM(amount_cents) AS cents
       FROM payments
      WHERE ${COLLECTED} AND date(COALESCE(paid_at, created_at)) BETWEEN ? AND ?
      GROUP BY bucket ORDER BY bucket`, start, end);
}

/* ============================================================
   LABOR - computed from time entries and the rate snapshot taken
   at clock-in, so editing an employee's rate never rewrites the
   cost of shifts already worked.
   ============================================================ */

/** Payable minutes for one entry: elapsed minus breaks. */
const MINUTES_SQL = `
  MAX(0, CAST((julianday(COALESCE(te.clock_out_at, datetime('now')))
             - julianday(te.clock_in_at)) * 1440 AS INTEGER) - te.break_minutes)`;

/** Cost of one entry, honouring hourly vs daily pay. */
const COST_SQL = `
  CASE
    WHEN te.clock_out_at IS NULL THEN 0          -- open shift: not yet payable
    WHEN COALESCE(te.pay_type_snapshot,'hourly') = 'daily'
      THEN COALESCE(te.rate_cents_snapshot,0)
    ELSE CAST(COALESCE(te.rate_cents_snapshot,0) * (${MINUTES_SQL} / 60.0) AS INTEGER)
  END`;

export function laborTotal(start, end) {
  const row = one(
    `SELECT COALESCE(SUM(${COST_SQL}),0) AS cents,
            COALESCE(SUM(CASE WHEN te.clock_out_at IS NOT NULL THEN ${MINUTES_SQL} ELSE 0 END),0) AS minutes
       FROM time_entries te
      WHERE te.work_date BETWEEN ? AND ?`, start, end);
  return { cents: row.cents, minutes: row.minutes, hours: Math.round(row.minutes / 6) / 10 };
}

export function laborByEmployee(start, end) {
  return all(
    `SELECT e.id AS employee_id, u.first_name, u.last_name,
            COUNT(*) AS shifts,
            COALESCE(SUM(CASE WHEN te.clock_out_at IS NOT NULL THEN ${MINUTES_SQL} ELSE 0 END),0) AS minutes,
            COALESCE(SUM(${COST_SQL}),0) AS cents,
            MAX(COALESCE(te.pay_type_snapshot,'hourly')) AS pay_type,
            MAX(COALESCE(te.rate_cents_snapshot,0)) AS rate_cents
       FROM time_entries te
       JOIN employees e ON e.id = te.employee_id
       JOIN users u ON u.id = e.user_id
      WHERE te.work_date BETWEEN ? AND ?
      GROUP BY e.id ORDER BY cents DESC`, start, end);
}

export function laborByRoute(start, end) {
  return all(
    `SELECT r.id AS route_id,
            r.name || ' (' || CASE r.day_of_week
              WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
              WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END || ')' AS label,
            COALESCE(SUM(${COST_SQL}),0) AS cents,
            COALESCE(SUM(CASE WHEN te.clock_out_at IS NOT NULL THEN ${MINUTES_SQL} ELSE 0 END),0) AS minutes
       FROM time_entries te
       JOIN routes r ON r.id = te.route_id
      WHERE te.work_date BETWEEN ? AND ?
      GROUP BY r.id ORDER BY cents DESC`, start, end);
}

export function laborSeries(start, end, bucket = 'day') {
  const fmt = bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return all(
    `SELECT strftime('${fmt}', te.work_date) AS bucket,
            COALESCE(SUM(${COST_SQL}),0) AS cents
       FROM time_entries te
      WHERE te.work_date BETWEEN ? AND ?
      GROUP BY bucket ORDER BY bucket`, start, end);
}

/* ============================================================
   EXPENSES
   ============================================================ */

/** Non-labor expenses. Labor comes from time entries, so including
 *  the labor CATEGORY here too would double-count it. */
export function expenseTotal(start, end) {
  return one(
    `SELECT COALESCE(SUM(e.amount_cents),0) AS c
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ec.is_labor = 0 AND e.incurred_on BETWEEN ? AND ?`, start, end).c;
}

export function expensesByCategory(start, end) {
  return all(
    `SELECT ec.name AS label, ec.code, ec.is_labor,
            COUNT(*) AS count, SUM(e.amount_cents) AS cents
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.incurred_on BETWEEN ? AND ?
      GROUP BY ec.id ORDER BY cents DESC`, start, end);
}

export function expenseSeries(start, end, bucket = 'day') {
  const fmt = bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return all(
    `SELECT strftime('${fmt}', e.incurred_on) AS bucket, SUM(e.amount_cents) AS cents
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ec.is_labor = 0 AND e.incurred_on BETWEEN ? AND ?
      GROUP BY bucket ORDER BY bucket`, start, end);
}

/** Direct (attributed) expenses vs. overhead that must be allocated. */
function expenseSplit(start, end) {
  const rows = all(
    `SELECT e.route_id, e.community_id, SUM(e.amount_cents) AS cents
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ec.is_labor = 0 AND e.incurred_on BETWEEN ? AND ?
      GROUP BY e.route_id, e.community_id`, start, end);

  const byRoute = new Map(), byCommunity = new Map();
  let overhead = 0;
  for (const r of rows) {
    if (r.community_id) byCommunity.set(r.community_id, (byCommunity.get(r.community_id) || 0) + r.cents);
    else if (r.route_id) byRoute.set(r.route_id, (byRoute.get(r.route_id) || 0) + r.cents);
    else overhead += r.cents;
  }
  return { byRoute, byCommunity, overhead };
}

/* ============================================================
   DISCOUNTS — coupons and service credits are counted SEPARATELY
   because they mean different things: one buys growth, the other
   pays for a mistake.
   ============================================================ */

export function couponDiscountTotal(start, end) {
  return one(
    `SELECT COALESCE(SUM(discount_cents),0) AS c FROM coupon_redemptions
      WHERE status = 'completed' AND date(redeemed_at) BETWEEN ? AND ?`, start, end).c;
}

export function serviceCreditTotal(start, end) {
  return one(
    `SELECT COALESCE(SUM(COALESCE(approved_cents, requested_cents)),0) AS c
       FROM service_credits
      WHERE status IN ('auto_approved','approved','modified','applied')
        AND date(requested_at) BETWEEN ? AND ?`, start, end).c;
}

export function refundTotal(start, end) {
  return one(
    `SELECT COALESCE(SUM(amount_cents),0) AS c FROM payments
      WHERE status = 'refunded' AND date(COALESCE(paid_at, created_at)) BETWEEN ? AND ?`,
    start, end).c;
}

/** The full top-line picture an owner needs to judge promotions. */
export function revenueBreakdown(start, end) {
  const net = revenueTotal(start, end);          // what was actually collected
  const coupons = couponDiscountTotal(start, end);
  const credits = serviceCreditTotal(start, end);
  const refunds = refundTotal(start, end);
  // Gross is what would have been billed at list price.
  const gross = net + coupons;

  return {
    grossRevenueCents: gross,
    couponDiscountCents: coupons,
    serviceCreditCents: credits,
    refundCents: refunds,
    netCollectedCents: net - credits,
    discountRatePct: pct(coupons + credits, gross || 1),
  };
}

/* ============================================================
   PROFITABILITY
   ============================================================ */

export function companyProfit(start, end) {
  const revenue = revenueTotal(start, end);
  const labor = laborTotal(start, end);
  const operating = expenseTotal(start, end);
  // Service credits are money handed back, so they reduce profit.
  // Coupon discounts are already absent from `revenue` (the customer was
  // charged the discounted price), so counting them here would double-count.
  const credits = serviceCreditTotal(start, end);
  const expenses = labor.cents + operating + credits;
  const profit = revenue - expenses;

  return {
    range: { start, end },
    revenueCents: revenue,
    laborCents: labor.cents,
    laborHours: labor.hours,
    operatingCents: operating,
    serviceCreditCents: credits,
    expensesCents: expenses,
    grossProfitCents: revenue - labor.cents,   // revenue less direct service labor
    profitCents: profit,
    marginPct: pct(profit, revenue),
    status: profitStatus(profit, revenue),
    breakdown: revenueBreakdown(start, end),
  };
}

/** The four states the dashboard reports. Thresholds in one place. */
export function profitStatus(profitCents, revenueCents) {
  if (revenueCents <= 0) return 'no_revenue';
  const margin = (profitCents / revenueCents) * 100;
  if (profitCents < 0) return 'losing_money';
  if (margin < 2) return 'break_even';
  if (margin < 15) return 'low_margin';
  return 'profitable';
}

export const STATUS_LABEL = {
  profitable: 'PROFITABLE', low_margin: 'LOW MARGIN',
  break_even: 'BREAK EVEN', losing_money: 'LOSING MONEY', no_revenue: 'NO REVENUE',
};

/**
 * Per-route profitability.
 *
 * Allocation method (stated plainly because every allocation is a
 * judgement call): direct labor comes from time entries tagged with the
 * route; expenses tagged to the route are direct; untagged overhead is
 * spread across routes in proportion to revenue.
 */
export function routeProfitability(start, end) {
  const revenue = revenueByRoute(start, end);
  const labor = new Map(laborByRoute(start, end).map(r => [r.route_id, r.cents]));
  const { byRoute, overhead } = expenseSplit(start, end);
  const totalRevenue = revenue.reduce((a, r) => a + r.cents, 0);

  return revenue.map(r => {
    const laborCents = labor.get(r.route_id) || 0;
    const direct = byRoute.get(r.route_id) || 0;
    const allocated = totalRevenue ? Math.round(overhead * (r.cents / totalRevenue)) : 0;
    const expenses = laborCents + direct + allocated;
    const profit = r.cents - expenses;
    return {
      id: r.route_id, label: r.label, customers: r.customers,
      revenueCents: r.cents, laborCents, directExpenseCents: direct,
      allocatedExpenseCents: allocated, expensesCents: expenses,
      profitCents: profit, marginPct: pct(profit, r.cents),
      status: profitStatus(profit, r.cents),
    };
  });
}

/**
 * Per-community profitability. Labor is attributed by the community's
 * share of its route's stops, since an employee clocks into a route
 * rather than into one community.
 */
export function communityProfitability(start, end) {
  const revenue = revenueByCommunity(start, end);
  const routeLabor = new Map(laborByRoute(start, end).map(r => [r.route_id, r.cents]));
  const { byCommunity, overhead } = expenseSplit(start, end);
  const totalRevenue = revenue.reduce((a, r) => a + r.cents, 0);

  // How many serviced units each route covers, and how many are in each community.
  const stopMix = all(`
    SELECT rs.route_id, u.community_id, COUNT(DISTINCT u.id) AS units
      FROM route_stops rs
      JOIN units u ON (u.community_id = rs.community_id OR u.id = rs.unit_id)
      JOIN service_addresses sa ON sa.unit_id = u.id AND sa.end_date IS NULL
     GROUP BY rs.route_id, u.community_id`);

  const routeUnitTotal = new Map();
  for (const s of stopMix) routeUnitTotal.set(s.route_id, (routeUnitTotal.get(s.route_id) || 0) + s.units);

  const communityLabor = new Map();
  for (const s of stopMix) {
    const total = routeUnitTotal.get(s.route_id) || 0;
    if (!total) continue;
    const share = (routeLabor.get(s.route_id) || 0) * (s.units / total);
    const key = s.community_id ?? null;
    communityLabor.set(key, (communityLabor.get(key) || 0) + share);
  }

  return revenue.map(r => {
    const laborCents = Math.round(communityLabor.get(r.community_id ?? null) || 0);
    const direct = byCommunity.get(r.community_id) || 0;
    const allocated = totalRevenue ? Math.round(overhead * (r.cents / totalRevenue)) : 0;
    const expenses = laborCents + direct + allocated;
    const profit = r.cents - expenses;
    return {
      id: r.community_id, label: r.label, customers: r.customers,
      revenueCents: r.cents, laborCents, directExpenseCents: direct,
      allocatedExpenseCents: allocated, expensesCents: expenses,
      profitCents: profit, marginPct: pct(profit, r.cents),
      status: profitStatus(profit, r.cents),
    };
  });
}

/* ============================================================
   UNIT ECONOMICS + BREAK-EVEN
   ============================================================ */

export function unitEconomics(start, end) {
  const activeCustomers = one(
    `SELECT COUNT(*) AS n FROM customers WHERE status = 'active'`).n;
  const c = companyProfit(start, end);
  if (!activeCustomers) {
    return { customers: 0, revenuePerCustomer: 0, costPerCustomer: 0, profitPerCustomer: 0, marginPct: 0 };
  }
  return {
    customers: activeCustomers,
    revenuePerCustomerCents: Math.round(c.revenueCents / activeCustomers),
    costPerCustomerCents: Math.round(c.expensesCents / activeCustomers),
    profitPerCustomerCents: Math.round(c.profitCents / activeCustomers),
    marginPct: c.marginPct,
  };
}

/**
 * How many customers a route needs to stop losing money.
 *
 * Treats the route's current expenses as fixed and its current revenue
 * per customer as the contribution each additional customer brings.
 * That is a simplification - a real extra customer adds a little cost
 * too - so this is a floor, not a promise.
 */
export function breakEven(start, end) {
  return routeProfitability(start, end).map(r => {
    const perCustomer = r.customers ? r.revenueCents / r.customers : 0;
    const needed = perCustomer > 0 ? Math.ceil(r.expensesCents / perCustomer) : null;
    return {
      id: r.id, label: r.label,
      currentCustomers: r.customers,
      breakEvenCustomers: needed,
      additionalNeeded: needed == null ? null : Math.max(0, needed - r.customers),
      revenuePerCustomerCents: Math.round(perCustomer),
      status: r.status,
    };
  });
}

/**
 * Pricing simulator: at each candidate monthly price, what margin would
 * the business have run at over this period?
 *
 * Holds cost structure and customer count constant and re-prices revenue.
 * It answers "what if we had charged X", not "what will happen if we
 * change to X" - customers may leave at a higher price.
 */
export function pricingSimulation(start, end, prices = [22, 25, 27, 30, 33]) {
  const c = companyProfit(start, end);
  const customers = one(`SELECT COUNT(*) AS n FROM customers WHERE status='active'`).n;
  if (!customers) return { customers: 0, rows: [] };

  // Current average monthly revenue per customer over the window.
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const months = days / 30.44;
  const currentPerCustomerMonthly = c.revenueCents / customers / months;
  const costPerCustomerMonthly = c.expensesCents / customers / months;

  return {
    customers,
    currentPriceCents: Math.round(currentPerCustomerMonthly),
    costPerCustomerCents: Math.round(costPerCustomerMonthly),
    rows: prices.map(p => {
      const priceCents = p * 100;
      const profit = priceCents - costPerCustomerMonthly;
      return {
        priceCents,
        profitPerCustomerCents: Math.round(profit),
        marginPct: pct(profit, priceCents),
        monthlyProfitCents: Math.round(profit * customers),
        status: profitStatus(profit, priceCents),
      };
    }),
  };
}

/* ============================================================
   ALERTS
   ============================================================ */

export function lossAlerts(start, end) {
  const alerts = [];
  const company = companyProfit(start, end);

  if (company.profitCents < 0) {
    alerts.push({ level: 'critical', scope: 'company',
      message: `The business is operating at a loss of ${fmtMoney(-company.profitCents)} for this period.` });
  }
  if (company.revenueCents > 0 && company.laborCents / company.revenueCents > 0.5) {
    alerts.push({ level: 'warning', scope: 'labor',
      message: `Labor is ${pct(company.laborCents, company.revenueCents)}% of revenue — above the 50% guideline.` });
  }

  for (const r of routeProfitability(start, end)) {
    if (r.status === 'losing_money') {
      alerts.push({ level: 'critical', scope: 'route', id: r.id,
        message: `${r.label} is losing ${fmtMoney(-r.profitCents)}.` });
    } else if (r.status === 'break_even' || r.status === 'low_margin') {
      alerts.push({ level: 'warning', scope: 'route', id: r.id,
        message: `${r.label} is at a ${r.marginPct}% margin.` });
    }
  }
  for (const c of communityProfitability(start, end)) {
    if (c.status === 'losing_money') {
      alerts.push({ level: 'critical', scope: 'community', id: c.id,
        message: `${c.label} is losing ${fmtMoney(-c.profitCents)}.` });
    }
  }

  const econ = unitEconomics(start, end);
  if (econ.customers && econ.profitPerCustomerCents < 0) {
    alerts.push({ level: 'critical', scope: 'pricing',
      message: `Average customer costs ${fmtMoney(econ.costPerCustomerCents)} to serve but brings ${fmtMoney(econ.revenuePerCustomerCents)}.` });
  }
  return alerts;
}

const fmtMoney = (cents) => '$' + (Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '');
