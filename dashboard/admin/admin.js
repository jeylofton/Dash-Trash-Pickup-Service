import { api, $, $$, esc, money, fmtDate, fmtTime, statusPill, ISSUE_LABELS, mountShell, wireTabs } from '/dashboard/dash.js';
import { lineChart, barChart, statusChip, SERIES } from '/dashboard/charts.js';

await mountShell('admin');

const table = (headers, rows) =>
  `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows : `<tr><td colspan="${headers.length}" class="empty">Nothing to show.</td></tr>`}</tbody>`;

/* ---------- dashboard ---------- */
async function loadOverview() {
  const o = await api('/api/admin/overview');
  $('#dashTitle').textContent = `${o.day.dayName}, ${fmtDate(o.day.date)}`;
  $('#statGrid').innerHTML = [
    ['Active customers', o.customers.active, ''],
    ['Scheduled today', o.day.scheduled, ''],
    ['Completed today', o.day.completed, 'good'],
    ['Remaining', o.day.remaining, ''],
    ['Issues today', o.day.issues, o.day.issues ? 'bad' : ''],
    ['Employees assigned', o.employeesAssigned, ''],
    ['Intro customers', o.customers.introActive, 'accent'],
    ['Intro spots left', o.intro.remaining, 'accent'],
    ['Collected', money(o.payments.collectedDollars), 'good'],
    ['Past due', o.payments.pastDue, o.payments.pastDue ? 'bad' : ''],
    ['Failed payments', o.payments.failed, o.payments.failed ? 'bad' : ''],
    ['Est. monthly revenue', money(o.mrrDollars), 'accent'],
  ].map(([label, value, cls]) =>
    `<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${esc(value)}</div></div>`
  ).join('');

  const audit = await api('/api/admin/audit?limit=15');
  $('#auditTable').innerHTML = table(['When', 'Who', 'Action', 'Entity'],
    audit.map(a => `<tr>
      <td class="small">${fmtDate(a.created_at)} ${fmtTime(a.created_at)}</td>
      <td>${esc(a.first_name || 'system')} ${esc(a.last_name || '')}</td>
      <td><code class="small">${esc(a.action)}</code></td>
      <td class="small muted">${esc(a.entity_type || '')} ${a.entity_id ?? ''}</td>
    </tr>`).join(''));
}

/* ---------- customers ---------- */
async function loadCustomers() {
  const params = new URLSearchParams();
  if ($('#custSearch').value) params.set('q', $('#custSearch').value);
  if ($('#custStatus').value) params.set('status', $('#custStatus').value);
  if ($('#custPlan').value) params.set('plan', $('#custPlan').value);

  const rows = await api('/api/admin/customers?' + params);
  $('#custTable').innerHTML = table(
    ['Customer', 'Contact', 'Address', 'Plan', 'Price', 'Billing', 'Status'],
    rows.map(c => `<tr>
      <td><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong>
          ${c.is_intro ? '<span class="pill intro">Intro</span>' : ''}</td>
      <td class="small">${esc(c.email)}<br /><span class="muted">${esc(c.phone || '')}</span></td>
      <td class="small">${esc(c.community_name || 'Standalone')}<br />
          <span class="muted">${esc(c.unit_label || '—')}</span></td>
      <td>${esc(c.plan_code || '—')}</td>
      <td class="num">${money(c.price)}</td>
      <td>${c.subscription_status ? statusPill(c.subscription_status) : '—'}</td>
      <td>${statusPill(c.status)}</td>
    </tr>`).join(''));
}

/* ---------- communities ---------- */
async function loadCommunities() {
  const rows = await api('/api/admin/communities');
  $('#commTable').innerHTML = table(['Community', 'Type', 'Address', 'Units', 'Occupied', 'Pickup days'],
    rows.map(c => `<tr style="cursor:pointer" data-comm="${c.id}">
      <td><strong>${esc(c.name)}</strong></td>
      <td class="small">${esc(c.kind)}</td>
      <td class="small muted">${esc(c.street || '')} ${esc(c.zip || '')}</td>
      <td class="num">${c.unit_count}</td>
      <td class="num">${c.occupied_count}</td>
      <td class="small">${esc(c.scheduleDays.join(' & ') || '—')}</td>
    </tr>`).join(''));

  $$('#commTable [data-comm]').forEach(tr =>
    tr.addEventListener('click', () => showCommunity(tr.dataset.comm)));
}

async function showCommunity(id) {
  const d = await api(`/api/admin/communities/${id}`);
  const box = $('#commDetail');
  box.hidden = false;
  box.innerHTML = `
    <h2>${esc(d.community.name)}</h2>
    <p class="muted small">${esc(d.community.street || '')} · Pickup: ${
      d.schedule.map(s => esc(s.name)).join(' & ') || 'not set'}</p>
    <h3 style="margin-top:14px">Units (${d.units.length})</h3>
    <div class="table-wrap"><table>${table(['Unit', 'Building', 'Occupant', 'Status'],
      d.units.map(u => `<tr>
        <td><strong>${esc(u.label)}</strong></td>
        <td class="small">${esc(u.building_name || '—')}</td>
        <td class="small">${u.first_name ? esc(u.first_name) + ' ' + esc(u.last_name) : '<span class="muted">Vacant</span>'}</td>
        <td>${statusPill(u.status)}</td>
      </tr>`).join(''))}</table></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- routes ---------- */
let employeeCache = [];
async function loadRoutes() {
  const [rows, emps] = await Promise.all([api('/api/admin/routes'), api('/api/admin/employees')]);
  employeeCache = emps;
  $('#routeTable').innerHTML = table(['Route', 'Day', 'Stops', 'Assigned to', ''],
    rows.map(r => `<tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.dayName)}</td>
      <td class="num">${r.stop_count}</td>
      <td>${r.first_name ? esc(r.first_name) + ' ' + esc(r.last_name) : '<span class="pill warn">Unassigned</span>'}</td>
      <td><button class="btn small" data-route="${r.id}">Manage</button></td>
    </tr>`).join(''));

  $$('#routeTable [data-route]').forEach(b =>
    b.addEventListener('click', () => showRoute(b.dataset.route)));
}

async function showRoute(id) {
  const d = await api(`/api/admin/routes/${id}`);
  const box = $('#routeDetail');
  box.hidden = false;
  box.innerHTML = `
    <h2>${esc(d.route.name)} — ${esc(d.route.dayName)}</h2>
    <p class="muted small">Currently: ${d.assignment
      ? esc(d.assignment.first_name) + ' ' + esc(d.assignment.last_name) : 'unassigned'}</p>

    <h3 style="margin-top:14px">Stops in order</h3>
    <ol class="small">${d.stops.map(s =>
      `<li>${esc(s.community_name || s.unit_label)}</li>`).join('')}</ol>
    <p class="muted small">Drag-to-reorder is not built yet; the API
       (<code>PUT /routes/:id/stops/order</code>) is ready for it.</p>

    <h3 style="margin-top:16px">Reassign</h3>
    <div class="row">
      <div><label for="reassignEmp">Employee</label>
        <select id="reassignEmp">${employeeCache.filter(e => e.status === 'active').map(e =>
          `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('')}</select></div>
      <div><label for="reassignReason">Reason</label>
        <input id="reassignReason" placeholder="e.g. called out sick" /></div>
      <div style="flex:0 0 auto"><button class="btn btn-primary" id="doReassign">Reassign</button></div>
    </div>
    <p class="msg ok" id="reassignMsg" hidden></p>`;

  $('#doReassign').addEventListener('click', async () => {
    await api(`/api/admin/routes/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ employeeId: Number($('#reassignEmp').value), reason: $('#reassignReason').value }),
    });
    $('#reassignMsg').textContent = 'Route reassigned and logged to the audit trail.';
    $('#reassignMsg').hidden = false;
    loadRoutes();
  });
}

/* ---------- employees ---------- */
async function loadEmployees() {
  const rows = await api('/api/admin/employees');
  $('#empTable').innerHTML = table(['Employee', 'Contact', 'Code', 'Routes', 'Last login', 'Status'],
    rows.map(e => `<tr>
      <td><strong>${esc(e.first_name)} ${esc(e.last_name)}</strong></td>
      <td class="small">${esc(e.email)}<br /><span class="muted">${esc(e.phone || '')}</span></td>
      <td class="small">${esc(e.employee_code || '—')}</td>
      <td class="num">${e.active_routes}</td>
      <td class="small muted">${e.last_login_at ? fmtDate(e.last_login_at) : 'never'}</td>
      <td>${statusPill(e.status)}</td>
    </tr>`).join(''));
}

/* ---------- pickups ---------- */
async function loadPickups() {
  const date = $('#pickupDate').value;
  const d = await api('/api/admin/pickups' + (date ? `?date=${date}` : ''));
  if (!date) $('#pickupDate').value = d.stats.date;

  $('#pickupStats').innerHTML = [
    ['Scheduled', d.stats.scheduled, ''], ['Completed', d.stats.completed, 'good'],
    ['Remaining', d.stats.remaining, ''], ['Issues', d.stats.issues, d.stats.issues ? 'bad' : ''],
  ].map(([l, v, c]) => `<div class="stat ${c}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('');

  $('#pickupTable').innerHTML = table(['Community', 'Unit', 'Customer', 'Route', 'Status', 'Time', 'By', 'Photo'],
    d.stops.map(s => `<tr>
      <td class="small">${esc(s.community_name || 'Standalone')}</td>
      <td><strong>${esc(s.unit_label)}</strong></td>
      <td class="small">${s.first_name ? esc(s.first_name) + ' ' + esc(s.last_name) : '<span class="muted">Vacant</span>'}</td>
      <td class="small muted">${esc(s.route_name || '')}</td>
      <td>${statusPill(s.status)}${s.issue_code ? ` <span class="small">${esc(ISSUE_LABELS[s.issue_code])}</span>` : ''}</td>
      <td class="small">${fmtTime(s.completed_at)}</td>
      <td class="small">${s.emp_first ? esc(s.emp_first) + ' ' + esc(s.emp_last) : ''}</td>
      <td>${s.photo_count ? '📷' : ''}</td>
    </tr>`).join(''));
}

/* ---------- payments ---------- */
async function loadPayments() {
  const status = $('#payStatus').value;
  const rows = await api('/api/admin/payments' + (status ? `?status=${status}` : ''));
  $('#payTable').innerHTML = table(['Customer', 'Plan', 'Amount', 'Status', 'Paid', 'Created'],
    rows.map(p => `<tr>
      <td><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong>
        ${p.is_intro ? '<span class="pill intro">Intro</span>' : ''}
        <br /><span class="small muted">${esc(p.email)}</span></td>
      <td>${esc(p.plan_code || '—')}</td>
      <td class="num">${money(p.amount_cents / 100)}</td>
      <td>${statusPill(p.status)}</td>
      <td class="small">${p.paid_at ? fmtDate(p.paid_at) : '—'}</td>
      <td class="small muted">${fmtDate(p.created_at)}</td>
    </tr>`).join(''));
}

/* ---------- reports ---------- */
async function loadReports() {
  const rows = await api('/api/admin/pickups/issues');
  $('#issueTable').innerHTML = table(['Date', 'Community', 'Unit', 'Customer', 'Issue', 'Employee', 'Notes'],
    rows.map(r => `<tr>
      <td class="small">${fmtDate(r.service_date)}</td>
      <td class="small">${esc(r.community_name || '—')}</td>
      <td>${esc(r.unit_label)}</td>
      <td class="small">${r.first_name ? esc(r.first_name) + ' ' + esc(r.last_name) : '—'}</td>
      <td><span class="pill bad">${esc(ISSUE_LABELS[r.issue_code] || r.issue_code)}</span></td>
      <td class="small">${esc(r.emp_first || '')} ${esc(r.emp_last || '')}</td>
      <td class="small muted">${esc(r.notes || '')}</td>
    </tr>`).join(''));
}

/* ---------- wiring ---------- */
const loaders = {
  dashboard: loadOverview, customers: loadCustomers, communities: loadCommunities,
  routes: loadRoutes, employees: loadEmployees, pickups: loadPickups,
  payments: loadPayments, reports: loadReports,
};
wireTabs((name) => loaders[name]?.());

let searchTimer;
$('#custSearch').addEventListener('input', () => {
  clearTimeout(searchTimer); searchTimer = setTimeout(loadCustomers, 250);
});
$('#custStatus').addEventListener('change', loadCustomers);
$('#custPlan').addEventListener('change', loadCustomers);
$('#pickupDate').addEventListener('change', loadPickups);
$('#payStatus').addEventListener('change', loadPayments);


/* ============================================================
   Financials
   ============================================================ */
let finRange = '90d';

$$('[data-range-bar] button').forEach(b => b.addEventListener('click', () => {
  finRange = b.dataset.range;
  $$('[data-range-bar] button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  loadFinancials();
}));

async function loadFinancials() {
  const [summary, charts, prof, pricing] = await Promise.all([
    api(`/api/finance/summary?range=${finRange}`),
    api(`/api/finance/charts?range=${finRange}`),
    api(`/api/finance/profitability?range=${finRange}`),
    api(`/api/finance/pricing-simulator?range=${finRange}`),
  ]);

  $('#finAlerts').innerHTML = summary.alerts.length
    ? summary.alerts.slice(0, 6).map(a =>
        `<div class="alert ${esc(a.level)}"><span>${a.level === 'critical' ? '▼' : '▲'}</span>
         <span>${esc(a.message)}</span></div>`).join('')
    : '<div class="alert" style="background:rgba(12,163,12,.1);color:#0a7a0a">● Nothing is flagged for this period.</div>';

  const u = summary.unitEconomics;
  $('#finStats').innerHTML = [
    ['Revenue', money(summary.revenue), ''],
    ['Expenses', money(summary.expenses), ''],
    ['Labor', money(summary.labor), ''],
    ['Operating', money(summary.operating), ''],
    ['Profit', money(summary.profit), summary.profit >= 0 ? 'good' : 'bad'],
    ['Margin', summary.marginPct + '%', summary.profit >= 0 ? 'good' : 'bad'],
    ['Labor hours', summary.laborHours, ''],
    ['Revenue / customer', money((u.revenuePerCustomerCents || 0) / 100), 'accent'],
    ['Cost / customer', money((u.costPerCustomerCents || 0) / 100), ''],
    ['Profit / customer', money((u.profitPerCustomerCents || 0) / 100), (u.profitPerCustomerCents || 0) >= 0 ? 'good' : 'bad'],
  ].map(([l, v, c]) =>
    `<div class="stat ${c}"><div class="stat-label">${l}</div><div class="stat-value">${esc(v)}</div></div>`).join('')
    + `<div class="stat"><div class="stat-label">Status</div>
         <div class="stat-value" style="font-size:1.05rem">${statusChip(summary.status)}</div></div>`;

  lineChart($('#chartOverTime'), {
    title: 'Revenue, expenses and profit over time',
    data: charts.overTime,
    series: [
      { key: 'revenue',  ...SERIES.revenue },
      { key: 'expenses', ...SERIES.expenses },
      { key: 'profit',   ...SERIES.profit },
    ],
  });

  barChart($('#chartRevCommunity'),   { title: 'Revenue by community', data: charts.revenueByCommunity });
  barChart($('#chartProfitCommunity'),{ title: 'Profit by community',  data: charts.profitByCommunity, statusKey: 'status' });
  barChart($('#chartRevRoute'),       { title: 'Revenue by route',     data: charts.revenueByRoute });
  barChart($('#chartProfitRoute'),    { title: 'Profit by route',      data: charts.profitByRoute, statusKey: 'status' });
  barChart($('#chartExpenseCat'),     { title: 'Expenses by category', data: charts.expensesByCategory, color: SERIES.expenses.color });
  barChart($('#chartLabor'),          { title: 'Labor cost by employee', data: charts.laborByEmployee, color: SERIES.labor.color });

  $('#breakEvenTable').innerHTML = table(
    ['Route', 'Customers now', 'Break-even', 'More needed', 'Revenue / customer', 'Status'],
    prof.breakEven.map(b => `<tr>
      <td><strong>${esc(b.label)}</strong></td>
      <td class="num">${b.currentCustomers}</td>
      <td class="num">${b.breakEvenCustomers ?? '—'}</td>
      <td class="num"><strong>${b.additionalNeeded ?? '—'}</strong></td>
      <td class="num">${money((b.revenuePerCustomerCents || 0) / 100)}</td>
      <td>${statusChip(b.status)}</td>
    </tr>`).join(''));

  $('#pricingTable').innerHTML = table(
    ['Monthly price', 'Profit / customer', 'Margin', 'Monthly profit', 'Status'],
    pricing.rows.map(r => `<tr>
      <td><strong>${money(r.priceCents / 100)}</strong></td>
      <td class="num">${money(r.profitPerCustomerCents / 100)}</td>
      <td class="num">${r.marginPct}%</td>
      <td class="num">${money(r.monthlyProfitCents / 100)}</td>
      <td>${statusChip(r.status)}</td>
    </tr>`).join(''))
    + `<caption class="muted small" style="caption-side:bottom;text-align:left;padding-top:8px">
        Current effective price ${money((pricing.currentPriceCents || 0) / 100)}/mo ·
        cost to serve ${money((pricing.costPerCustomerCents || 0) / 100)}/mo ·
        ${pricing.customers} customers</caption>`;
}

/* ============================================================
   Expenses
   ============================================================ */
async function loadExpenses() {
  const [cats, rows, routes, comms] = await Promise.all([
    api('/api/finance/expense-categories'),
    api(`/api/finance/expenses?range=${finRange}`),
    api('/api/admin/routes'),
    api('/api/admin/communities'),
  ]);

  if (!$('#expCat').options.length) {
    $('#expCat').innerHTML = cats.filter(c => !c.is_labor)
      .map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('');
    $('#expRoute').innerHTML = '<option value="">Overhead</option>' +
      routes.map(r => `<option value="${r.id}">${esc(r.name)} (${esc(r.dayName)})</option>`).join('');
    $('#expCommunity').innerHTML = '<option value="">Overhead</option>' +
      comms.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#expDate').value = new Date().toISOString().slice(0, 10);
  }

  $('#expTable').innerHTML = table(
    ['Date', 'Category', 'Description', 'Vendor', 'Attributed to', 'Amount', ''],
    rows.map(e => `<tr>
      <td class="small">${fmtDate(e.incurred_on)}</td>
      <td class="small">${esc(e.category_name)}</td>
      <td>${esc(e.description)}${e.is_recurring ? ` <span class="pill">${esc(e.recurrence)}</span>` : ''}</td>
      <td class="small muted">${esc(e.vendor || '')}</td>
      <td class="small">${esc(e.route_name || e.community_name || 'Overhead')}</td>
      <td class="num"><strong>${money(e.amount)}</strong></td>
      <td><button class="btn small" data-del-exp="${e.id}">Delete</button></td>
    </tr>`).join(''));

  $$('#expTable [data-del-exp]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this expense?')) return;
    await api(`/api/finance/expenses/${b.dataset.delExp}`, { method: 'DELETE' });
    loadExpenses();
  }));
}

$('#addExpense').addEventListener('click', async () => {
  const msg = $('#expMsg');
  try {
    await api('/api/finance/expenses', {
      method: 'POST',
      body: JSON.stringify({
        categoryCode: $('#expCat').value,
        description: $('#expDesc').value,
        amount: $('#expAmount').value,
        incurredOn: $('#expDate').value,
        vendor: $('#expVendor').value || undefined,
        routeId: $('#expRoute').value ? Number($('#expRoute').value) : undefined,
        communityId: $('#expCommunity').value ? Number($('#expCommunity').value) : undefined,
        isRecurring: Boolean($('#expRecurring').value),
        recurrence: $('#expRecurring').value || undefined,
      }),
    });
    msg.textContent = 'Expense recorded.'; msg.className = 'msg ok'; msg.hidden = false;
    $('#expDesc').value = ''; $('#expAmount').value = ''; $('#expVendor').value = '';
    loadExpenses();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false;
  }
});

/* ============================================================
   Payroll
   ============================================================ */
async function loadPayroll() {
  const qs = ($('#prFrom').value && $('#prTo').value)
    ? `?from=${$('#prFrom').value}&to=${$('#prTo').value}` : '';
  const [pr, emps, sheets, perf] = await Promise.all([
    api('/api/finance/payroll' + qs),
    api('/api/admin/employees'),
    api(`/api/finance/timesheets?range=${finRange}`),
    api(`/api/finance/employee-performance?range=${finRange}`),
  ]);

  if (!$('#prFrom').value) { $('#prFrom').value = pr.period.start; $('#prTo').value = pr.period.end; }
  $('#prCsv').href = `/api/finance/payroll.csv?from=${pr.period.start}&to=${pr.period.end}`;

  $('#payrollTable').innerHTML = table(
    ['Employee', 'Pay type', 'Rate', 'Shifts', 'Hours', 'Estimated pay'],
    pr.rows.map(r => `<tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.payType)}</td>
      <td class="num">${money(r.rate)}${r.payType === 'hourly' ? '/hr' : '/shift'}</td>
      <td class="num">${r.shifts}</td>
      <td class="num">${r.hours}</td>
      <td class="num"><strong>${money(r.estimatedPay)}</strong></td>
    </tr>`).join('')
    + `<tr><td colspan="5"><strong>Total estimated payroll</strong></td>
         <td class="num"><strong>${money(pr.totalEstimatedPay)}</strong></td></tr>`);

  if (!$('#compEmp').options.length) {
    $('#compEmp').innerHTML = emps.map(e =>
      `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('');
  }

  $('#timesheetTable').innerHTML = table(
    ['Date', 'Employee', 'Route', 'In', 'Out', 'Break', 'Hours', 'Pay', ''],
    sheets.slice(0, 40).map(t => `<tr>
      <td class="small">${fmtDate(t.work_date)}</td>
      <td class="small">${esc(t.first_name)} ${esc(t.last_name)}</td>
      <td class="small muted">${esc(t.route_name || '')}</td>
      <td class="small">${fmtTime(t.clock_in_at)}</td>
      <td class="small">${t.clock_out_at ? fmtTime(t.clock_out_at) : '<em>open</em>'}</td>
      <td class="num small">${t.break_minutes || 0}m</td>
      <td class="num">${(t.minutes / 60).toFixed(2)}</td>
      <td class="num">${money(t.pay)}</td>
      <td>${t.source === 'admin' ? '<span class="pill warn">edited</span>' : `<button class="btn small" data-fix="${t.id}">Correct</button>`}</td>
    </tr>`).join(''));

  $$('#timesheetTable [data-fix]').forEach(b => b.addEventListener('click', async () => {
    const reason = prompt('Reason for this correction (recorded in the audit trail):');
    if (!reason) return;
    const breakMinutes = prompt('Break minutes (leave blank to keep):');
    try {
      await api(`/api/finance/timesheets/${b.dataset.fix}`, {
        method: 'PATCH',
        body: JSON.stringify({ reason, breakMinutes: breakMinutes === '' ? undefined : Number(breakMinutes) }),
      });
      loadPayroll();
    } catch (e) { alert(e.message); }
  }));

  $('#perfTable').innerHTML = table(
    ['Employee', 'Hours', 'Estimated pay', 'Stops assigned', 'Completed', 'Completion', 'Issues'],
    perf.map(p => `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td class="num">${p.hours}</td>
      <td class="num">${money(p.estimatedPay)}</td>
      <td class="num">${p.stops_assigned}</td>
      <td class="num">${p.stops_completed}</td>
      <td class="num">${p.completionRate == null ? '—' : p.completionRate + '%'}</td>
      <td class="num">${p.issues}</td>
    </tr>`).join(''));
}

$('#prLoad').addEventListener('click', loadPayroll);

$('#compSave').addEventListener('click', async () => {
  const msg = $('#compMsg');
  try {
    await api(`/api/finance/employees/${$('#compEmp').value}/compensation`, {
      method: 'POST',
      body: JSON.stringify({ payType: $('#compType').value, rate: $('#compRate').value }),
    });
    msg.textContent = 'Rate saved and logged to the audit trail.';
    msg.className = 'msg ok'; msg.hidden = false;
    loadPayroll();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

Object.assign(loaders, {
  financials: loadFinancials, expenses: loadExpenses, payroll: loadPayroll,
});
