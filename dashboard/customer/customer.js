import { api, $, $$, esc, money, fmtDate, fmtTime, statusPill, ISSUE_LABELS, mountShell, wireTabs } from '/dashboard/dash.js';

await mountShell('customer');
let account = null;

const table = (headers, rows) =>
  `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows : `<tr><td colspan="${headers.length}" class="empty">Nothing yet.</td></tr>`}</tbody>`;

async function loadAccount() {
  account = await api('/api/customer/account');
  const { subscription: sub, schedule, address, account: acct, profile } = account;

  $('#acctStats').innerHTML = [
    ['Plan', sub ? sub.plan : '—', acct.isIntro ? 'accent' : ''],
    ['You pay', sub ? money(sub.price) : '—', 'accent'],
    ['Status', sub ? sub.status.replace('_', ' ') : '—', sub?.status === 'active' ? 'good' : 'bad'],
    ['Next pickup', schedule.nextPickup ? fmtDate(schedule.nextPickup) : '—', ''],
  ].map(([l, v, c]) =>
    `<div class="stat ${c}"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:1.3rem">${esc(v)}</div></div>`).join('');

  $('#acctEmail').value = profile.email || '';
  $('#acctPhone').value = profile.phone || '';

  $('#addressBox').innerHTML = address ? `
    <p><strong>${esc(address.community || 'Service address')}</strong><br />
    ${esc(address.building ? address.building + ' · ' : '')}${esc(address.label)}<br />
    <span class="muted small">${esc(address.street || '')} ${esc(address.zip || '')}</span></p>
    <p class="muted small">To change your service address, contact support.</p>`
    : '<p class="muted">No service address on file.</p>';
}

$('#saveProfile').addEventListener('click', async () => {
  const msg = $('#profileMsg');
  try {
    await api('/api/customer/profile', {
      method: 'PATCH',
      body: JSON.stringify({ email: $('#acctEmail').value, phone: $('#acctPhone').value }),
    });
    msg.textContent = 'Saved.'; msg.className = 'msg ok'; msg.hidden = false;
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

async function loadPlan() {
  const { plans, currentPlanCode } = await api('/api/customer/plans');
  const current = plans.find(p => p.isCurrent);

  $('#currentPlan').innerHTML = current ? `
    <h2>${esc(current.name)} ${account.account.isIntro ? '<span class="pill intro">Introductory rate</span>' : ''}</h2>
    <p class="stat-value" style="color:var(--orange-dark)">${money(current.lockedPrice ?? current.price)}
      <span class="small muted">/ ${current.intervalMonths === 1 ? 'month' : current.intervalMonths + ' months'}</span></p>
    ${account.account.isIntro ? `<p class="small">Your promotional price is locked in and will not change
      when standard pricing changes.</p>` : ''}`
    : '<p class="muted">No active plan.</p>';

  $('#planOptions').innerHTML = plans.filter(p => !p.isCurrent).map(p => `
    <div class="row" style="align-items:center;border-bottom:1px solid var(--line);padding:10px 0">
      <div><strong>${esc(p.name)}</strong><div class="muted small">${money(p.price)} every ${
        p.intervalMonths === 1 ? 'month' : p.intervalMonths + ' months'}</div></div>
      <div style="flex:0 0 auto"><button class="btn" data-plan="${esc(p.code)}">Switch</button></div>
    </div>`).join('') || '<p class="muted small">No other plans available.</p>';

  $$('#planOptions [data-plan]').forEach(b => b.addEventListener('click', async () => {
    const msg = $('#planMsg');
    const warn = currentPlanCode === 'Introductory'
      ? '\n\nThis gives up your introductory rate permanently.' : '';
    if (!confirm(`Switch to the ${b.dataset.plan} plan?${warn}`)) return;
    try {
      const r = await api('/api/customer/plan/change', {
        method: 'POST', body: JSON.stringify({ planCode: b.dataset.plan }),
      });
      msg.textContent = [r.message, r.warning].filter(Boolean).join(' ');
      msg.className = 'msg ok'; msg.hidden = false;
      loadPlan(); loadAccount();
    } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
  }));
}

async function loadPayments() {
  const [rows, credits] = await Promise.all([
    api('/api/customer/payments'),
    api('/api/customer/credits').catch(() => ({ balance: 0, credits: [] })),
  ]);

  if (credits.credits.length) {
    $('#creditCard').hidden = false;
    $('#creditTable').innerHTML = table(['Date', 'Credit', 'Amount'],
      credits.credits.map(c => `<tr>
        <td class="small">${fmtDate(c.date)}</td>
        <td>${esc(c.label)}</td>
        <td class="num" style="color:var(--ok)"><strong>-${money(c.amount)}</strong></td>
      </tr>`).join('')
      + `<tr><td colspan="2"><strong>Credit balance</strong></td>
           <td class="num"><strong style="color:var(--ok)">-${money(credits.balance)}</strong></td></tr>`);
  }
  $('#payTable').innerHTML = table(['Date', 'Plan', 'Amount', 'Status'],
    rows.map(p => `<tr>
      <td class="small">${fmtDate(p.paid_at || p.created_at)}</td>
      <td class="small">${esc(p.plan_name || '—')}</td>
      <td class="num">${money(p.amount)}</td>
      <td>${statusPill(p.status)}${p.failure_reason ? `<br /><span class="small muted">${esc(p.failure_reason)}</span>` : ''}</td>
    </tr>`).join(''));
}

$('#updateCard').addEventListener('click', () => {
  const msg = $('#cardMsg');
  msg.className = 'msg';
  msg.textContent = 'Card updates need the payment processor’s secure form. Connect Square’s '
    + 'card-on-file flow to this button — the API route is not built yet.';
  msg.hidden = false;
});

function loadSchedule() {
  const { schedule, address } = account;
  $('#scheduleBox').innerHTML = `
    <h2>${esc(schedule.dayNames.join(' & ')
      || (schedule.notice ? 'Service paused' : 'Not scheduled'))}</h2>
    ${schedule.notice ? `<p class="msg ${
      schedule.notice.state === 'on_hold' ? 'warn' : 'error'}">${esc(schedule.notice.message)}</p>` : ''}
    <p class="small">Place securely tied household trash outside your door on your scheduled days.
      Pickup days may vary by community or service area.</p>
    <p><strong>Next pickup:</strong> ${schedule.nextPickup ? fmtDate(schedule.nextPickup) : '—'}</p>
    <p class="muted small">${esc(address?.community || '')} ${esc(address?.label || '')}</p>`;
}

async function loadHistory() {
  const rows = await api('/api/customer/history');
  $('#histTable').innerHTML = table(['Date', 'Result', 'Time', 'Collected by', 'Photo'],
    rows.map(h => `<tr>
      <td class="small">${fmtDate(h.service_date)}</td>
      <td>${h.status === 'completed'
            ? '<span class="pill ok">Completed</span>'
            : `<span class="pill bad">${esc(ISSUE_LABELS[h.issue_code] || 'Issue')}</span>`}
          ${h.notes ? `<br /><span class="small muted">${esc(h.notes)}</span>` : ''}</td>
      <td class="small">${fmtTime(h.completed_at)}</td>
      <td class="small">${esc(h.employee_first || '—')}</td>
      <td>${h.photo_id ? `<a href="/api/photos/${h.photo_id}" target="_blank" rel="noopener">View</a>` : '—'}</td>
    </tr>`).join(''));
}

async function loadSupport() {
  const notes = await api('/api/customer/notes');
  $('#notesBox').innerHTML = notes.length
    ? notes.map(n => `<p class="small">${esc(n.body)}<br /><span class="muted">${fmtDate(n.created_at)}</span></p>`).join('')
    : '<p class="muted small">No notes.</p>';
}

$('#cancelBtn').addEventListener('click', async () => {
  if (!confirm('Cancel your Dash Trash Pickup service?')) return;
  const msg = $('#cancelMsg');
  try {
    const r = await api('/api/customer/cancel', {
      method: 'POST', body: JSON.stringify({ reason: $('#cancelReason').value }),
    });
    msg.textContent = r.message; msg.className = 'msg ok'; msg.hidden = false;
    loadAccount();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

await loadAccount();
wireTabs((name) => ({
  account: loadAccount, plan: loadPlan, payments: loadPayments,
  schedule: loadSchedule, history: loadHistory, support: loadSupport,
}[name]?.()));
