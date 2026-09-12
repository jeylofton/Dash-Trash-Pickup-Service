import { api, $, $$, esc, money, fmtDate, fmtTime, statusPill, ISSUE_LABELS, mountShell, wireTabs } from '/dashboard/dash.js';
import { lineChart, barChart, statusChip, SERIES } from '/dashboard/charts.js';
import { guardForm, confirmLeave, renderDeleteControl } from '/dashboard/dash.js';

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
const COMM_PILL = {
  active:'ok', scheduled:'pending', driver_needed:'bad', waiting_list:'warn',
  pending_setup:'warn', lead:'', paused:'warn', inactive:'',
};
const commStatus = (st) => `<span class="pill ${COMM_PILL[st] ?? ''}">${esc(String(st).replace(/_/g,' '))}</span>`;

async function loadCommunities() {
  const params = new URLSearchParams();
  if ($('#commStatusFilter').value) params.set('status', $('#commStatusFilter').value);

  const [rows, board] = await Promise.all([
    api('/api/communities?' + params),
    api('/api/communities/board/driver-needed'),
  ]);

  $('#driverTable').innerHTML = table(
    ['Community', 'Status', 'Reason', 'Units', 'Waiting list', 'Tentative start', 'Potential revenue'],
    board.map(c => `<tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td>${commStatus(c.status)}</td>
      <td class="small muted">${esc(c.waitingReason || '')}</td>
      <td class="num">${c.units ?? '—'}</td>
      <td class="num">${c.waitlistCount}</td>
      <td class="small">${c.tentativeStartDate ? fmtDate(c.tentativeStartDate) : '—'}</td>
      <td class="num">${money(c.potentialMonthlyRevenue)}/mo</td>
    </tr>`).join(''));

  $('#commTable').innerHTML = table(
    ['Community', 'Status', 'Address', 'Units', 'Occupied', 'Waiting', 'Pickup days', 'Start', ''],
    rows.map(c => `<tr>
      <td><strong>${esc(c.name)}</strong><br /><span class="small muted">${esc(c.kind)}</span></td>
      <td>${commStatus(c.status)}</td>
      <td class="small muted">${esc(c.street || '')} ${esc(c.zip || '')}</td>
      <td class="num">${c.unit_count || (c.unit_count_estimate ? c.unit_count_estimate + '*' : '—')}</td>
      <td class="num">${c.occupied_count}</td>
      <td class="num">${c.waitlist_count}</td>
      <td class="small">${esc(c.scheduleDays.join(' & ') || '—')}</td>
      <td class="small">${c.actual_start_date ? fmtDate(c.actual_start_date)
          : c.tentative_start_date ? `<em>${fmtDate(c.tentative_start_date)}</em>` : '—'}</td>
      <td><button class="btn small" data-comm="${c.id}">Open</button></td>
    </tr>`).join(''));

  $$('#commTable [data-comm]').forEach(b =>
    b.addEventListener('click', () => showCommunity(b.dataset.comm)));
}

async function showCommunity(id) {
  const [d, readiness] = await Promise.all([
    api(`/api/communities/${id}`),
    api(`/api/communities/${id}/readiness`),
  ]);
  const c = d.community;
  const box = $('#commDetail');
  box.hidden = false;

  box.innerHTML = `
    <h2>${esc(c.name)} ${commStatus(c.status)}</h2>
    <p class="muted small">${esc([c.street, c.city, c.state, c.zip].filter(Boolean).join(', '))}
      ${c.contact_name ? ` · Manager: ${esc(c.contact_name)}` : ''}
      ${c.contact_phone ? ` · ${esc(c.contact_phone)}` : ''}</p>

    ${c.status !== 'active' ? `
      <div class="card" style="background:var(--sand)">
        <h3>Start service</h3>
        <p class="small">${c.tentative_start_date
          ? `Tentative start <strong>${fmtDate(c.tentative_start_date)}</strong> — tentative only; it does not activate anything.`
          : 'No tentative start date set.'}</p>
        <div style="margin:10px 0">
          ${readiness.checks.map(ck =>
            `<div class="small">${ck.ok ? '✅' : '⬜'} ${esc(ck.label)}</div>`).join('')}
        </div>
        <div class="row">
          <div><label for="actualStart">Actual start date</label><input id="actualStart" type="date" /></div>
          <div style="flex:0 0 auto"><button class="btn btn-primary" id="activateBtn"
            ${readiness.ready ? '' : 'title="Some checks are not met"'}>Activate community</button></div>
        </div>
        <p class="msg" id="activateMsg" hidden></p>
      </div>` : `
      <p class="small">Servicing since <strong>${c.actual_start_date ? fmtDate(c.actual_start_date) : '—'}</strong>.</p>`}

    <div class="chart-grid" style="margin-top:14px">
      <div class="card">
        <h3>Waiting list (${d.waitlist.length})</h3>
        ${d.waitlist.length ? `<div class="table-wrap"><table>${table(['Name','Email','Unit','Status'],
          d.waitlist.map(w => `<tr>
            <td>${esc(w.first_name)} ${esc(w.last_name)}</td>
            <td class="small">${esc(w.email)}</td>
            <td class="small">${esc(w.unit_label || '—')}</td>
            <td>${statusPill(w.status)}</td>
          </tr>`).join(''))}</table></div>` : '<p class="muted small">Nobody waiting.</p>'}
      </div>
      <div class="card">
        <h3>Routes</h3>
        ${d.routes.length ? d.routes.map(r => `<div class="small">• ${esc(r.name)} (${esc(r.dayName)})
          — ${r.first_name ? esc(r.first_name) + ' ' + esc(r.last_name) : '<span class="pill bad">no driver</span>'}</div>`).join('')
          : '<p class="muted small">Not on any route.</p>'}
        <h3 style="margin-top:12px">Status history</h3>
        ${d.statusHistory.map(h => `<div class="small muted">${fmtDate(h.created_at)}:
          ${esc(h.from_status || 'new')} → <strong>${esc(h.to_status)}</strong>
          ${h.note ? '· ' + esc(h.note) : ''}</div>`).join('')}
      </div>
    </div>

    <div id="commDeleteZone"></div>

    <div class="card">
      <h3>Units (${d.units.length})</h3>
      <div class="table-wrap"><table>${table(['Unit','Building','Occupant','Status'],
        d.units.map(u => `<tr>
          <td><strong>${esc(u.label)}</strong></td>
          <td class="small">${esc(u.building_name || '—')}</td>
          <td class="small">${u.first_name ? esc(u.first_name) + ' ' + esc(u.last_name)
              : '<span class="muted">Vacant</span>'}</td>
          <td>${statusPill(u.status)}</td>
        </tr>`).join(''))}</table></div>
    </div>`;

  renderDeleteControl('#commDeleteZone', {
    checkUrl: `/api/communities/${id}/deletable`,
    deleteUrl: `/api/communities/${id}`,
    label: 'community',
    onDeleted: () => { $('#commDetail').hidden = true; loadCommunities(); },
  });

  const btn = $('#activateBtn');
  if (btn) btn.addEventListener('click', async () => {
    const msg = $('#activateMsg');
    const date = $('#actualStart').value;
    if (!date) { msg.textContent = 'Choose an actual start date.'; msg.className = 'msg error'; msg.hidden = false; return; }
    if (!confirm(`Start service at ${c.name} on ${date}? This begins real pickups.`)) return;
    try {
      const r = await api(`/api/communities/${id}/activate`, {
        method: 'POST', body: JSON.stringify({ actualStartDate: date }),
      });
      msg.textContent = `Activated. ${r.waitlistNotified} waiting-list contact(s) marked notified.`;
      msg.className = 'msg ok'; msg.hidden = false;
      loadCommunities(); setTimeout(() => showCommunity(id), 800);
    } catch (e) {
      if (e.status === 409) {
        if (!confirm('Some readiness checks are not met. Activate anyway?')) return;
        await api(`/api/communities/${id}/activate`, {
          method: 'POST', body: JSON.stringify({ actualStartDate: date, force: true }),
        });
        loadCommunities(); showCommunity(id);
      } else { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
    }
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#commStatusFilter').addEventListener('change', loadCommunities);
$('#newCommBtn').addEventListener('click', () => {
  const c = $('#newCommCard'); c.hidden = !c.hidden;
});
$('#ncoCancel').addEventListener('click', () => {
  if (!confirmLeave('Discard this unsaved form?')) return;
  $$('#newCommCard input, #newCommCard select, #newCommCard textarea').forEach(f => { if (f.type !== 'date') f.value = ''; });
  $('#newCommCard').hidden = true;
});
$('#ncoSave').addEventListener('click', async () => {
  const msg = $('#ncoMsg');
  try {
    const r = await api('/api/communities', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#ncoName').value, kind: $('#ncoKind').value,
        street: $('#ncoStreet').value || undefined, zip: $('#ncoZip').value || undefined,
        contactName: $('#ncoContact').value || undefined,
        contactPhone: $('#ncoPhone').value || undefined,
        contactEmail: $('#ncoEmail').value || undefined,
        status: $('#ncoStatus').value,
        unitCountEstimate: $('#ncoUnits').value || undefined,
        potentialCustomers: $('#ncoPotential').value || undefined,
        tentativeStartDate: $('#ncoTentative').value || undefined,
        waitingReason: $('#ncoReason').value || undefined,
      }),
    });
    msg.textContent = r.message; msg.className = 'msg ok'; msg.hidden = false;
    ['ncoName','ncoStreet','ncoZip','ncoContact','ncoPhone','ncoEmail','ncoUnits','ncoPotential','ncoReason']
      .forEach(i => { $('#' + i).value = ''; });
    loadCommunities();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

/* ---------- routes ---------- */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const ROUTE_PILL = { active:'ok', scheduled:'pending', draft:'', on_hold:'warn', inactive:'', archived:'bad' };
const routePill = (st) => `<span class="pill ${ROUTE_PILL[st] ?? ''}">${esc(String(st).replace(/_/g,' '))}</span>`;
let employeeCache = [];

async function loadRoutes() {
  const params = new URLSearchParams();
  if ($('#routeStatusFilter').value) params.set('status', $('#routeStatusFilter').value);

  const [rows, emps] = await Promise.all([
    api('/api/roles/routes/all?' + params),
    api('/api/people/employees').catch(() => []),
  ]);
  employeeCache = emps;

  if (!$('#nrDay').options.length) {
    $('#nrDay').innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
    $('#nrDriver').innerHTML = '<option value="">Unassigned</option>' +
      emps.filter(e => e.status === 'active')
        .map(e => `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('');
    $('#nrEffective').value = new Date().toISOString().slice(0, 10);
  }

  $('#routeTable').innerHTML = table(
    ['Route', 'Day', 'Start', 'Driver', 'Stops', 'Versions', 'Status', ''],
    rows.map(r => `<tr>
      <td><strong>${esc(r.name)}</strong>${r.description ? `<br /><span class="small muted">${esc(r.description)}</span>` : ''}</td>
      <td>${esc(r.dayName)}</td>
      <td class="small">${esc(r.start_time || '—')}</td>
      <td class="small">${r.driver ? esc(r.driver.name) : '<span class="pill warn">unassigned</span>'}</td>
      <td class="num">${r.stop_count}</td>
      <td class="num">${r.version_count}</td>
      <td>${routePill(r.status)}</td>
      <td><button class="btn small" data-route="${r.id}">Manage</button></td>
    </tr>`).join(''));

  $$('#routeTable [data-route]').forEach(b =>
    b.addEventListener('click', () => showRoute(b.dataset.route)));
}

async function showRoute(id) {
  const d = await api(`/api/roles/routes/${id}`);
  const r = d.route;
  const box = $('#routeDetail');
  box.hidden = false;

  box.innerHTML = `
    <h2>${esc(r.name)} ${routePill(r.status)}</h2>
    <p class="muted small">${esc(r.dayName)} · start ${esc(r.start_time || '—')}
      ${r.estimated_end_time ? ` → ${esc(r.estimated_end_time)}` : ''}
      · driver ${d.driver ? esc(d.driver.name) : 'unassigned'}
      · ${d.serviceHistory.pickups} pickup record(s)</p>

    <div class="card" style="background:var(--sand)">
      <h3>Edit route</h3>
      <p class="muted small">Changes apply from the effective date forward. Earlier service
        records keep the configuration that was true when they happened.</p>
      <div class="row">
        <div><label>Name</label><input id="erName" value="${esc(r.name)}" /></div>
        <div><label>Service day</label><select id="erDay">${DAYS.map((x, i) =>
          `<option value="${i}" ${i === r.day_of_week ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div><label>Start time</label><input id="erStart" type="time" value="${esc(r.start_time || '')}" /></div>
        <div><label>Est. end</label><input id="erEnd" type="time" value="${esc(r.estimated_end_time || '')}" /></div>
      </div>
      <div class="row">
        <div><label>Driver</label><select id="erDriver">
          <option value="">Unassigned</option>
          ${employeeCache.filter(e => e.status === 'active').map(e =>
            `<option value="${e.id}" ${d.driver && d.driver.id === e.id ? 'selected' : ''}>${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('')}
        </select></div>
        <div><label>Status</label><select id="erStatus">${
          ['draft','scheduled','active','on_hold','inactive'].map(x =>
            `<option value="${x}" ${x === r.status ? 'selected' : ''}>${x.replace(/_/g,' ')}</option>`).join('')}</select></div>
        <div><label>Effective date</label><input id="erEffective" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
        <div><label>Change note</label><input id="erNote" placeholder="Why this changed" /></div>
      </div>
      <p class="msg" id="erMsg" hidden></p>
      <div class="form-actions-bar">
        <button class="btn btn-primary" id="erSave">Save changes</button>
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn" id="erDuplicate">Duplicate route</button>
        <span class="spacer"></span>
        ${r.status === 'archived'
          ? `<button class="btn" id="erRestore">Restore</button>`
          : `<button class="btn btn-danger" id="erArchive">Archive route</button>`}
      </div>
      <div id="routeDeleteZone"></div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <h3>Stops in order</h3>
        <ol class="small">${d.stops.map(s =>
          `<li>${esc(s.community_name || s.unit_label)}
            ${s.community_status && s.community_status !== 'active'
              ? ` <span class="pill warn">${esc(s.community_status.replace(/_/g,' '))}</span>` : ''}</li>`).join('')
          || '<li class="muted">No stops.</li>'}</ol>
        <p class="muted small">Reordering writes to <code>PUT /routes/:id/stops/order</code>.</p>
      </div>

      <div class="card">
        <h3>Driver history</h3>
        ${d.assignments.map(a => `<div class="small">
          <strong>${esc(a.first_name)} ${esc(a.last_name)}</strong> —
          ${fmtDate(a.effective_date)} → ${a.end_date ? fmtDate(a.end_date) : 'present'}
          ${a.reason ? `<br /><span class="muted">${esc(a.reason)}</span>` : ''}
        </div>`).join('') || '<p class="muted small">No assignments.</p>'}
      </div>
    </div>

    <div class="card">
      <h3>Version history</h3>
      <p class="muted small">Each row is the configuration that applied during that period.</p>
      ${d.versions.map(v => `
        <div class="version-row ${v.end_date ? '' : 'current'}">
          <strong>${fmtDate(v.effective_date)} → ${v.end_date ? fmtDate(v.end_date) : 'present'}</strong>
          ${v.end_date ? '' : ' <span class="pill ok">current</span>'}
          <div class="small">Driver: ${v.driver_first ? esc(v.driver_first) + ' ' + esc(v.driver_last) : '—'}
            · Day: ${esc(v.dayName || '—')} · Start: ${esc(v.start_time || '—')}
            · Status: ${esc(v.status || '—')}</div>
          ${v.changes && Object.keys(v.changes).length ? `<div class="small muted">Changed: ${
            Object.entries(v.changes).map(([k, c]) =>
              `${esc(k)}: ${esc(c.from ?? '—')} → ${esc(c.to ?? '—')}`).join(' · ')}</div>` : ''}
          <div class="small muted">${v.first_name ? `by ${esc(v.first_name)} ${esc(v.last_name)}` : ''}
            ${v.change_note ? `· ${esc(v.change_note)}` : ''}</div>
        </div>`).join('')}
    </div>`;

  // Cancel restores the saved values rather than just closing the form.
  const routeGuard = guardForm('#routeDetail');

  renderDeleteControl('#routeDeleteZone', {
    checkUrl: `/api/roles/routes/${id}/deletable`,
    deleteUrl: `/api/roles/routes/${id}`,
    label: 'route',
    onDeleted: () => { $('#routeDetail').hidden = true; loadRoutes(); },
  });

  $('#erSave').addEventListener('click', async () => {
    const msg = $('#erMsg');
    try {
      const res = await api(`/api/roles/routes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#erName').value, dayOfWeek: Number($('#erDay').value),
          startTime: $('#erStart').value || undefined,
          estimatedEndTime: $('#erEnd').value || undefined,
          status: $('#erStatus').value,
          driverEmployeeId: $('#erDriver').value ? Number($('#erDriver').value) : undefined,
          effectiveDate: $('#erEffective').value || undefined,
          changeNote: $('#erNote').value || undefined,
        }),
      });
      msg.textContent = Object.keys(res.changes || {}).length
        ? `Saved, effective ${res.effectiveDate}. Earlier records are unchanged.`
        : 'Nothing changed.';
      msg.className = 'msg ok'; msg.hidden = false;
      routeGuard.snapshot();                       // saved state is the new baseline
      loadRoutes(); setTimeout(() => showRoute(id), 700);
    } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
  });

  $('#erDuplicate').addEventListener('click', async () => {
    const name = prompt('Name for the duplicate:', `${r.name} (copy)`);
    if (!name) return;
    await api(`/api/roles/routes/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) });
    loadRoutes();
  });

  const arch = $('#erArchive');
  if (arch) arch.addEventListener('click', async () => {
    if (!confirm(`Archive "${r.name}"? It stops generating future service. All history is kept.`)) return;
    const res = await api(`/api/roles/routes/${id}/archive`, { method: 'POST', body: JSON.stringify({}) });
    alert(res.message);
    loadRoutes(); showRoute(id);
  });
  const rest = $('#erRestore');
  if (rest) rest.addEventListener('click', async () => {
    await api(`/api/roles/routes/${id}/restore`, { method: 'POST', body: JSON.stringify({}) });
    loadRoutes(); showRoute(id);
  });

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#routeStatusFilter').addEventListener('change', loadRoutes);
$('#newRouteBtn').addEventListener('click', () => { const c = $('#newRouteCard'); c.hidden = !c.hidden; });
$('#nrCancel').addEventListener('click', () => {
  if (!confirmLeave('Discard this unsaved form?')) return;
  $$('#newRouteCard input, #newRouteCard select, #newRouteCard textarea').forEach(f => { if (f.type !== 'date') f.value = ''; });
  $('#newRouteCard').hidden = true;
});
$('#nrSave').addEventListener('click', async () => {
  const msg = $('#nrMsg');
  try {
    await api('/api/roles/routes', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#nrName').value, dayOfWeek: Number($('#nrDay').value),
        startTime: $('#nrStart').value || undefined, estimatedEndTime: $('#nrEnd').value || undefined,
        serviceArea: $('#nrArea').value || undefined, description: $('#nrDesc').value || undefined,
        status: $('#nrStatus').value, effectiveDate: $('#nrEffective').value || undefined,
        driverEmployeeId: $('#nrDriver').value ? Number($('#nrDriver').value) : undefined,
      }),
    });
    msg.textContent = 'Route created.'; msg.className = 'msg ok'; msg.hidden = false;
    ['nrName','nrArea','nrDesc'].forEach(i => { $('#' + i).value = ''; });
    loadRoutes();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

/* ---------- roles & permissions ---------- */
let permCatalog = null;

async function loadRoles() {
  const [roles, catalog] = await Promise.all([
    api('/api/roles'),
    permCatalog ? Promise.resolve(permCatalog) : api('/api/roles/permissions'),
  ]);
  permCatalog = catalog;

  if (!$('#nrlCopy').options.length || $('#nrlCopy').options.length === 1) {
    $('#nrlCopy').innerHTML = '<option value="">Start empty</option>' +
      roles.filter(r => r.key !== 'admin')
        .map(r => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('');
  }

  $('#roleTable').innerHTML = table(
    ['Role', 'Description', 'Permissions', 'Users', 'Type', 'Status', ''],
    roles.map(r => `<tr>
      <td><strong>${esc(r.name)}</strong><br /><span class="small muted">${esc(r.key)}</span></td>
      <td class="small">${esc(r.description || '')}</td>
      <td class="num">${r.grantsEverything ? 'all' : r.permissionCount}</td>
      <td class="num">${r.userCount}</td>
      <td>${r.isSystem ? '<span class="pill">built-in</span>' : '<span class="pill intro">custom</span>'}</td>
      <td>${statusPill(r.status)}</td>
      <td><button class="btn small" data-role-key="${esc(r.key)}">
        ${r.key === 'admin' ? 'View' : 'Permissions'}</button></td>
    </tr>`).join(''));

  $$('#roleTable [data-role-key]').forEach(b =>
    b.addEventListener('click', () => showRole(b.dataset.roleKey)));
}

async function showRole(key) {
  const d = await api(`/api/roles/${encodeURIComponent(key)}`);
  const box = $('#roleDetail');
  box.hidden = false;
  const locked = d.role.grantsEverything;

  box.innerHTML = `
    <h2>${esc(d.role.name)} ${d.role.isSystem ? '<span class="pill">built-in</span>' : '<span class="pill intro">custom</span>'}</h2>
    <p class="muted small">${esc(d.role.description || '')} · ${d.users.length} user(s)</p>
    ${locked ? '<p class="msg">The Admin role always has every permission and cannot be edited.</p>' : ''}

    <div class="perm-grid">
      ${permCatalog.categories.map(cat => `
        <div class="perm-cat">
          <h4>${esc(cat.name)}</h4>
          ${cat.permissions.map(p => `
            <label class="perm-row">
              <input type="checkbox" data-perm="${esc(p.key)}"
                ${locked || d.permissions[p.key] ? 'checked' : ''}
                ${locked ? 'disabled' : ''} />
              <span>${esc(p.label)}</span>
            </label>`).join('')}
          ${locked ? '' : `<div class="perm-cat-actions">
            <button type="button" data-cat-all="${esc(cat.name)}">All</button>
            <button type="button" data-cat-none="${esc(cat.name)}">None</button>
          </div>`}
        </div>`).join('')}
    </div>

    ${locked ? '' : `
      <p class="msg" id="permMsg" hidden></p>
      <div style="margin-top:14px">
        <button class="btn btn-primary" id="savePerms">Save permissions</button>
        ${d.role.isSystem ? '' :
          `<button class="btn" id="dupRole">Duplicate role</button>
           <button class="btn btn-danger" id="archiveRole">Archive role</button>`}
        <button class="btn" data-cancel>Cancel</button>
      </div>`}

    <div class="card" style="margin-top:14px">
      <h3>Users with this role</h3>
      ${d.users.length ? d.users.map(u =>
        `<div class="small">${esc(u.first_name)} ${esc(u.last_name)} — ${esc(u.email)}</div>`).join('')
        : '<p class="muted small">Nobody holds this role.</p>'}
    </div>`;

  if (!d.role.isSystem) {
    renderDeleteControl('#roleDeleteZone', {
      checkUrl: `/api/roles/${encodeURIComponent(key)}/deletable`,
      deleteUrl: `/api/roles/${encodeURIComponent(key)}`,
      label: 'role',
      onDeleted: () => { $('#roleDetail').hidden = true; loadRoles(); },
    });
  }

  if (!locked) {
    guardForm('#roleDetail', { onCancel: () => { $('#roleDetail').hidden = true; } });
    $$('[data-cat-all]').forEach(b => b.addEventListener('click', () => {
      const cat = permCatalog.categories.find(c => c.name === b.dataset.catAll);
      cat.permissions.forEach(p => { const el = $(`[data-perm="${p.key}"]`); if (el) el.checked = true; });
    }));
    $$('[data-cat-none]').forEach(b => b.addEventListener('click', () => {
      const cat = permCatalog.categories.find(c => c.name === b.dataset.catNone);
      cat.permissions.forEach(p => { const el = $(`[data-perm="${p.key}"]`); if (el) el.checked = false; });
    }));

    $('#savePerms').addEventListener('click', async () => {
      const msg = $('#permMsg');
      const permissions = $$('[data-perm]').filter(el => el.checked).map(el => el.dataset.perm);
      if (!confirm(`Save ${permissions.length} permission(s) for ${d.role.name}? This changes what these users can do immediately.`)) return;
      try {
        const r = await api(`/api/roles/${encodeURIComponent(key)}/permissions`, {
          method: 'PUT', body: JSON.stringify({ permissions }),
        });
        msg.textContent = `Saved. ${r.added.length} added, ${r.removed.length} removed. Logged to the audit trail.`;
        msg.className = 'msg ok'; msg.hidden = false;
        loadRoles();
      } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
    });

    const dup = $('#dupRole');
    if (dup) dup.addEventListener('click', async () => {
      const name = prompt('Name for the new role:', `${d.role.name} copy`);
      if (!name) return;
      await api('/api/roles', {
        method: 'POST',
        body: JSON.stringify({ key: name.toLowerCase().replace(/\s+/g, '_'), name, copyFrom: key }),
      });
      loadRoles();
    });

    const arch = $('#archiveRole');
    if (arch) arch.addEventListener('click', async () => {
      if (!confirm(`Archive the ${d.role.name} role?`)) return;
      try {
        await api(`/api/roles/${encodeURIComponent(key)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'archived' }),
        });
        box.hidden = true; loadRoles();
      } catch (e) { alert(e.message); }
    });
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#newRoleBtn').addEventListener('click', () => { const c = $('#newRoleCard'); c.hidden = !c.hidden; });
$('#nrlCancel').addEventListener('click', () => {
  if (!confirmLeave('Discard this unsaved form?')) return;
  $$('#newRoleCard input, #newRoleCard select, #newRoleCard textarea').forEach(f => { if (f.type !== 'date') f.value = ''; });
  $('#newRoleCard').hidden = true;
});
$('#nrlName').addEventListener('input', () => {
  if (!$('#nrlKey').dataset.touched) {
    $('#nrlKey').value = $('#nrlName').value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  }
});
$('#nrlKey').addEventListener('input', () => { $('#nrlKey').dataset.touched = '1'; });
$('#nrlSave').addEventListener('click', async () => {
  const msg = $('#nrlMsg');
  try {
    const r = await api('/api/roles', {
      method: 'POST',
      body: JSON.stringify({
        key: $('#nrlKey').value, name: $('#nrlName').value,
        description: $('#nrlDesc').value || undefined,
        copyFrom: $('#nrlCopy').value || undefined,
      }),
    });
    msg.textContent = 'Role created. Tick its permissions below.';
    msg.className = 'msg ok'; msg.hidden = false;
    ['nrlName','nrlKey','nrlDesc'].forEach(i => { $('#' + i).value = ''; });
    delete $('#nrlKey').dataset.touched;
    await loadRoles(); showRole(r.key);
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

/* ---------- employees ---------- *//* ---------- employees ---------- */
const EMP_STATUS_PILL = { active:'ok', inactive:'', on_leave:'warn', terminated:'bad', archived:'bad' };
const fmtStatus = (st) => `<span class="pill ${EMP_STATUS_PILL[st] ?? ''}">${esc(String(st).replace('_',' '))}</span>`;
const hrs = (mins) => (mins / 60).toFixed(1);

async function loadEmployees() {
  $('#empListView').hidden = false;
  $('#empDetailView').hidden = true;

  const params = new URLSearchParams();
  if ($('#empSearch').value) params.set('q', $('#empSearch').value);
  if ($('#empStatusFilter').value) params.set('status', $('#empStatusFilter').value);

  const rows = await api('/api/people/employees?' + params);
  $('#empTable').innerHTML = table(
    ['Employee', 'Contact', 'Code', 'Title', 'Routes', 'Last login', 'Status', ''],
    rows.map(e => `<tr>
      <td><strong>${esc(e.first_name)} ${esc(e.last_name)}</strong>
        ${e.must_change_password ? '<span class="pill warn">password reset pending</span>' : ''}
        ${e.locked_until && new Date(e.locked_until) > new Date() ? '<span class="pill bad">locked</span>' : ''}</td>
      <td class="small">${esc(e.email)}<br /><span class="muted">${esc(e.phone || '')}</span></td>
      <td class="small">${esc(e.employee_code || '—')}</td>
      <td class="small">${esc(e.job_title || '—')}</td>
      <td class="num">${e.active_routes}</td>
      <td class="small muted">${e.last_login_at ? fmtDate(e.last_login_at) : 'never'}</td>
      <td>${fmtStatus(e.status)}</td>
      <td><button class="btn small" data-emp="${e.id}">Open</button></td>
    </tr>`).join(''));

  $$('#empTable [data-emp]').forEach(b =>
    b.addEventListener('click', () => showEmployee(b.dataset.emp)));
}

async function showEmployee(id) {
  const d = await api(`/api/people/employees/${id}`);
  const e = d.employee, p = d.profile, pay = d.pay;
  $('#empListView').hidden = true;
  const box = $('#empDetailView');
  box.hidden = false;

  box.innerHTML = `
    <button class="btn" id="backToEmps" style="margin-bottom:12px">← All employees</button>
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <div style="flex:2 1 300px">
          <h1 style="margin-bottom:4px">${esc(e.first_name)} ${esc(e.last_name)}</h1>
          <p class="muted small">${esc(p.job_title || 'Employee')} · ${esc(e.employee_code || 'no code')}
            · hired ${fmtDate(e.hire_date)}</p>
          <p>${fmtStatus(e.status)} ${e.locked_until && new Date(e.locked_until) > new Date()
              ? '<span class="pill bad">account locked</span>' : ''}
            ${e.must_change_password ? '<span class="pill warn">must change password</span>' : ''}</p>
        </div>
        <div style="flex:0 0 auto"><button class="btn btn-primary" id="editEmpBtn">Edit employee</button></div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <h2>Profile</h2>
        <table>
          <tr><th>Email</th><td>${esc(e.email)}</td></tr>
          <tr><th>Phone</th><td>${esc(e.phone || '—')}</td></tr>
          <tr><th>Address</th><td>${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—')}</td></tr>
          <tr><th>Emergency</th><td>${esc(p.emergency_contact_name || '—')}${p.emergency_contact_phone ? ' · ' + esc(p.emergency_contact_phone) : ''}</td></tr>
          <tr><th>Vehicle</th><td>${esc(p.vehicle_assignment || '—')}</td></tr>
          <tr><th>Uniform</th><td>${esc(p.uniform_size || '—')}</td></tr>
          <tr><th>Background check</th><td>${esc(p.background_check_status || 'not started')}</td></tr>
        </table>
      </div>

      <div class="card">
        <h2>Pay</h2>
        <p class="stat-value" style="color:var(--orange-dark);font-size:1.6rem">
          ${money(pay.current.rate_cents / 100)}
          <span class="small muted">${pay.current.pay_type === 'daily' ? 'per shift' : 'per hour'}</span></p>
        <p class="small"><strong>This pay period:</strong> ${pay.payPeriod.hours} h ·
          ${pay.payPeriod.shifts} shifts · <strong>${money(pay.payPeriod.estimatedPay)}</strong> estimated</p>
        <h3 style="margin-top:12px">Rate history</h3>
        <table>${pay.history.map(h => `<tr>
          <td>${money(h.rate_cents / 100)} ${esc(h.pay_type)}</td>
          <td class="small muted">${fmtDate(h.effective_date)} → ${h.end_date ? fmtDate(h.end_date) : 'present'}</td>
        </tr>`).join('') || '<tr><td class="muted small">No rate set.</td></tr>'}</table>
        <p class="muted small" style="margin-top:8px">Changing the rate never re-prices shifts already worked.</p>
      </div>

      <div class="card">
        <h2>Time</h2>
        <div class="pay-strip">
          <div><div class="k">Today</div><div class="v">${hrs(d.time.todayMinutes)}h</div></div>
          <div><div class="k">This week</div><div class="v">${hrs(d.time.weekMinutes)}h</div></div>
          <div><div class="k">Pay period</div><div class="v">${pay.payPeriod.hours}h</div></div>
        </div>
        <h3 style="margin-top:12px">Clock history</h3>
        <div class="table-wrap"><table>${table(['Date','In','Out','Hrs','Pay',''],
          d.time.entries.slice(0, 12).map(t => `<tr>
            <td class="small">${fmtDate(t.work_date)}</td>
            <td class="small">${fmtTime(t.clock_in_at)}</td>
            <td class="small">${t.clock_out_at ? fmtTime(t.clock_out_at) : '<em>open</em>'}</td>
            <td class="num">${hrs(t.minutes)}</td>
            <td class="num">${money(t.pay)}</td>
            <td>${t.source === 'admin' ? '<span class="pill warn">edited</span>' : ''}</td>
          </tr>`).join(''))}</table></div>
      </div>

      <div class="card">
        <h2>Routes</h2>
        ${d.routes.assignments.length ? d.routes.assignments.map(a => `
          <div class="small" style="padding:5px 0;border-bottom:1px solid var(--line)">
            <strong>${esc(a.name)}</strong> — ${esc(a.dayName)}
            ${a.current ? '<span class="pill ok">current</span>'
                        : `<span class="muted">ended ${fmtDate(a.end_date)}</span>`}
            ${a.reason ? `<br /><span class="muted">${esc(a.reason)}</span>` : ''}
          </div>`).join('') : '<p class="muted small">No route assignments.</p>'}
        <h3 style="margin-top:12px">Communities served</h3>
        <p class="small">${d.routes.communities.map(c => esc(c.name)).join(', ') || '<span class="muted">None</span>'}</p>
      </div>

      <div class="card">
        <h2>Service</h2>
        <div class="pay-strip">
          <div><div class="k">Completed</div><div class="v">${d.performance.completed}</div></div>
          <div><div class="k">Issues</div><div class="v">${d.performance.issues}</div></div>
          <div><div class="k">Photos</div><div class="v">${d.performance.photos}</div></div>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table>${table(['Date','Unit','Result','Photo'],
          d.recentPickups.slice(0, 10).map(r => `<tr>
            <td class="small">${fmtDate(r.service_date)}</td>
            <td class="small">${esc(r.community_name || '')} ${esc(r.unit_label)}</td>
            <td>${r.status === 'completed' ? '<span class="pill ok">done</span>'
                 : `<span class="pill bad">${esc(ISSUE_LABELS[r.issue_code] || 'issue')}</span>`}</td>
            <td>${r.photo_id ? `<a href="/api/photos/${r.photo_id}" target="_blank" rel="noopener">View</a>` : '—'}</td>
          </tr>`).join(''))}</table></div>
      </div>

      <div class="card">
        <h2>Account</h2>
        <table>
          <tr><th>Login email</th><td>${esc(e.email)}</td></tr>
          <tr><th>Role</th><td>employee</td></tr>
          <tr><th>Account status</th><td>${statusPill(e.account_status)}</td></tr>
          <tr><th>Last login</th><td>${e.last_login_at ? fmtDate(e.last_login_at) + ' ' + fmtTime(e.last_login_at) : 'never'}</td></tr>
          <tr><th>Password changed</th><td>${e.password_changed_at ? fmtDate(e.password_changed_at) : 'unknown'}</td></tr>
        </table>
        <div class="row" style="margin-top:12px">
          <button class="btn" data-pw="temp" data-user="${e.user_id}">Generate temporary password</button>
          <button class="btn" data-pw="force" data-user="${e.user_id}">Require change at next login</button>
          ${e.locked_until && new Date(e.locked_until) > new Date()
            ? `<button class="btn" data-pw="unlock" data-user="${e.user_id}">Unlock account</button>`
            : `<button class="btn btn-danger" data-pw="lock" data-user="${e.user_id}">Lock account</button>`}
        </div>
        <p class="msg" id="pwMsg" hidden></p>
        <p class="muted small">Existing passwords can never be viewed — only replaced.</p>
      </div>

      <div class="card">
        <h2>Admin notes</h2>
        <div class="field"><textarea id="empNote" rows="2" placeholder="Private note about this employee"></textarea></div>
        <button class="btn" id="addEmpNote">Add note</button>
        <div style="margin-top:12px">${d.notes.map(n => `
          <p class="small" style="border-bottom:1px solid var(--line);padding-bottom:7px">
            ${esc(n.body)}<br /><span class="muted">${esc(n.first_name || '')} ${esc(n.last_name || '')} · ${fmtDate(n.created_at)}</span>
          </p>`).join('') || '<p class="muted small">No notes.</p>'}</div>
      </div>
    </div>

    <div class="card" id="editEmpCard" hidden>
      <h2>Edit employee</h2>
      <div class="row">
        <div><label>First name</label><input id="edFirst" value="${esc(e.first_name)}" /></div>
        <div><label>Last name</label><input id="edLast" value="${esc(e.last_name)}" /></div>
        <div><label>Login email</label><input id="edEmail" type="email" value="${esc(e.email)}" /></div>
        <div><label>Phone</label><input id="edPhone" value="${esc(e.phone || '')}" /></div>
      </div>
      <div class="row">
        <div><label>Address</label><input id="edAddress" value="${esc(p.address || '')}" /></div>
        <div><label>City</label><input id="edCity" value="${esc(p.city || '')}" /></div>
        <div><label>State</label><input id="edState" value="${esc(p.state || '')}" /></div>
        <div><label>ZIP</label><input id="edZip" value="${esc(p.zip || '')}" /></div>
      </div>
      <div class="row">
        <div><label>Emergency contact</label><input id="edEcName" value="${esc(p.emergency_contact_name || '')}" /></div>
        <div><label>Emergency phone</label><input id="edEcPhone" value="${esc(p.emergency_contact_phone || '')}" /></div>
        <div><label>Job title</label><input id="edTitle" value="${esc(p.job_title || '')}" /></div>
        <div><label>Employee code</label><input id="edCode" value="${esc(e.employee_code || '')}" /></div>
      </div>
      <div class="row">
        <div><label>Employment status</label>
          <select id="edStatus">${['active','inactive','on_leave','terminated','archived']
            .map(v => `<option value="${v}" ${v === e.status ? 'selected' : ''}>${v.replace('_',' ')}</option>`).join('')}</select></div>
        <div><label>Vehicle</label><input id="edVehicle" value="${esc(p.vehicle_assignment || '')}" /></div>
        <div><label>Uniform size</label><input id="edUniform" value="${esc(p.uniform_size || '')}" /></div>
        <div><label>Background check</label>
          <select id="edBg">${['', 'not_started','pending','cleared','flagged']
            .map(v => `<option value="${v}" ${v === p.background_check_status ? 'selected' : ''}>${v || '—'}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Pay type</label><select id="edPayType">
          <option value="hourly" ${pay.current.pay_type === 'hourly' ? 'selected' : ''}>Hourly</option>
          <option value="daily" ${pay.current.pay_type === 'daily' ? 'selected' : ''}>Daily / shift</option></select></div>
        <div><label>Pay rate</label><input id="edPayRate" type="number" step="0.01" value="${(pay.current.rate_cents / 100).toFixed(2)}" /></div>
        <div><label>Rate effective from</label><input id="edPayDate" type="date" /></div>
      </div>
      <p class="msg" id="edMsg" hidden></p>
      <div class="form-actions-bar">
        <button class="btn btn-primary" id="edSave">Save changes</button>
        <button class="btn" data-cancel id="edCancel">Cancel</button>
      </div>
      <div id="empDeleteZone"></div>
    </div>`;

  $('#backToEmps').addEventListener('click', loadEmployees);
  $('#editEmpBtn').addEventListener('click', () => {
    const c = $('#editEmpCard'); c.hidden = !c.hidden;
    if (!c.hidden) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  const empGuard = guardForm('#editEmpCard', { onCancel: () => { $('#editEmpCard').hidden = true; } });

  renderDeleteControl('#empDeleteZone', {
    checkUrl: `/api/people/employees/${id}/deletable`,
    deleteUrl: `/api/people/employees/${id}`,
    label: 'employee',
    onDeleted: () => loadEmployees(),
  });

  $('#edSave').addEventListener('click', async () => {
    const msg = $('#edMsg');
    try {
      await api(`/api/people/employees/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: $('#edFirst').value, lastName: $('#edLast').value,
          email: $('#edEmail').value, phone: $('#edPhone').value,
          address: $('#edAddress').value, city: $('#edCity').value,
          state: $('#edState').value, zip: $('#edZip').value,
          emergencyContactName: $('#edEcName').value, emergencyContactPhone: $('#edEcPhone').value,
          jobTitle: $('#edTitle').value, employeeCode: $('#edCode').value,
          status: $('#edStatus').value, vehicleAssignment: $('#edVehicle').value,
          uniformSize: $('#edUniform').value,
          backgroundCheckStatus: $('#edBg').value || undefined,
        }),
      });
      // Pay is its own record so history is preserved; only write if it changed.
      const newRate = Number($('#edPayRate').value);
      if (newRate && (Math.round(newRate * 100) !== pay.current.rate_cents
                      || $('#edPayType').value !== pay.current.pay_type)) {
        await api(`/api/finance/employees/${id}/compensation`, {
          method: 'POST',
          body: JSON.stringify({ payType: $('#edPayType').value, rate: newRate,
                                 effectiveDate: $('#edPayDate').value || undefined }),
        });
      }
      msg.textContent = 'Saved. Changes are recorded in the audit trail.';
      msg.className = 'msg ok'; msg.hidden = false;
      empGuard.snapshot();
      setTimeout(() => showEmployee(id), 700);
    } catch (ex) { msg.textContent = ex.message; msg.className = 'msg error'; msg.hidden = false; }
  });

  $$('[data-pw]').forEach(b => b.addEventListener('click', async () => {
    const msg = $('#pwMsg'); const user = b.dataset.user;
    const routes = { temp: 'temporary-password', force: 'force-password-change', lock: 'lock', unlock: 'unlock' };
    const confirms = {
      temp: 'Generate a temporary password? The current one stops working immediately.',
      force: 'Require this employee to choose a new password at next sign-in?',
      lock: 'Lock this account? They will be signed out and unable to sign in.',
      unlock: 'Unlock this account?',
    };
    if (!confirm(confirms[b.dataset.pw])) return;
    try {
      const r = await api(`/api/people/accounts/${user}/${routes[b.dataset.pw]}`,
                          { method: 'POST', body: JSON.stringify({}) });
      msg.innerHTML = r.temporaryPassword
        ? `Temporary password: <code style="font-size:1.05rem">${esc(r.temporaryPassword)}</code><br />
           <span class="small">${esc(r.message)}</span>`
        : 'Done.';
      msg.className = 'msg ok'; msg.hidden = false;
      if (!r.temporaryPassword) setTimeout(() => showEmployee(id), 900);
    } catch (ex) { msg.textContent = ex.message; msg.className = 'msg error'; msg.hidden = false; }
  }));

  $('#addEmpNote').addEventListener('click', async () => {
    const body = $('#empNote').value.trim();
    if (!body) return;
    await api(`/api/people/employees/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
    showEmployee(id);
  });
}

/* new employee form */
$('#newEmpBtn').addEventListener('click', () => {
  const c = $('#newEmpCard'); c.hidden = !c.hidden;
  if (!c.hidden) $('#neHire').value = new Date().toISOString().slice(0, 10);
});
$('#neCancel').addEventListener('click', () => {
  if (!confirmLeave('Discard this unsaved form?')) return;
  $$('#newEmpCard input, #newEmpCard select, #newEmpCard textarea').forEach(f => { if (f.type !== 'date') f.value = ''; });
  $('#newEmpCard').hidden = true;
});
$('#neSave').addEventListener('click', async () => {
  const msg = $('#neMsg');
  try {
    const r = await api('/api/people/employees', {
      method: 'POST',
      body: JSON.stringify({
        firstName: $('#neFirst').value, lastName: $('#neLast').value,
        email: $('#neEmail').value, phone: $('#nePhone').value,
        employeeCode: $('#neCode').value || undefined, hireDate: $('#neHire').value || undefined,
        payType: $('#nePayType').value, payRate: $('#nePayRate').value || undefined,
        address: $('#neAddress').value, zip: $('#neZip').value,
        emergencyContactName: $('#neEcName').value, emergencyContactPhone: $('#neEcPhone').value,
      }),
    });
    msg.innerHTML = r.temporaryPassword
      ? `Employee created. Temporary password: <code style="font-size:1.05rem">${esc(r.temporaryPassword)}</code>
         <br /><span class="small">Shown once. They must change it at first sign-in.</span>`
      : 'Employee created.';
    msg.className = 'msg ok'; msg.hidden = false;
    ['neFirst','neLast','neEmail','nePhone','neCode','nePayRate','neAddress','neZip','neEcName','neEcPhone']
      .forEach(i => { $('#' + i).value = ''; });
    loadEmployees();
  } catch (ex) { msg.textContent = ex.message; msg.className = 'msg error'; msg.hidden = false; }
});

let empSearchTimer;
$('#empSearch').addEventListener('input', () => {
  clearTimeout(empSearchTimer); empSearchTimer = setTimeout(loadEmployees, 250);
});
$('#empStatusFilter').addEventListener('change', loadEmployees);

/* ---------- accounts ---------- */
async function loadAccounts() {
  const params = new URLSearchParams();
  if ($('#acctSearch').value) params.set('q', $('#acctSearch').value);
  if ($('#acctRole').value) params.set('role', $('#acctRole').value);
  if ($('#acctStatus').value) params.set('status', $('#acctStatus').value);

  const rows = await api('/api/people/accounts?' + params);
  $('#acctTable').innerHTML = table(
    ['Name', 'Email', 'Role', 'Status', 'Last login', 'Actions'],
    rows.map(u => `<tr>
      <td><strong>${esc(u.first_name)} ${esc(u.last_name)}</strong></td>
      <td class="small">${esc(u.email)}</td>
      <td>${statusPill(u.role)}</td>
      <td>${statusPill(u.status)}
        ${u.isLocked ? '<span class="pill bad">locked</span>' : ''}
        ${u.must_change_password ? '<span class="pill warn">pw change</span>' : ''}</td>
      <td class="small muted">${u.last_login_at ? fmtDate(u.last_login_at) : 'never'}</td>
      <td>
        <button class="btn small" data-acct-pw="${u.id}">Temp password</button>
        <button class="btn small" data-acct-toggle="${u.id}" data-status="${esc(u.status)}">
          ${u.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn small" data-acct-lock="${u.id}" data-locked="${u.isLocked}">
          ${u.isLocked ? 'Unlock' : 'Lock'}</button>
        <button class="btn small" data-acct-role="${u.id}" data-role="${esc(u.role)}">Role</button>
      </td>
    </tr>`).join(''));

  const msg = $('#acctMsg');
  const act = async (fn) => {
    try { await fn(); loadAccounts(); }
    catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
  };

  $$('#acctTable [data-acct-pw]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Generate a temporary password? The current one stops working immediately.')) return;
    act(async () => {
      const r = await api(`/api/people/accounts/${b.dataset.acctPw}/temporary-password`,
                          { method: 'POST', body: JSON.stringify({}) });
      msg.innerHTML = `Temporary password: <code style="font-size:1.05rem">${esc(r.temporaryPassword)}</code>
                       <br /><span class="small">${esc(r.message)}</span>`;
      msg.className = 'msg ok'; msg.hidden = false;
    });
  }));

  $$('#acctTable [data-acct-toggle]').forEach(b => b.addEventListener('click', () => act(() =>
    api(`/api/people/accounts/${b.dataset.acctToggle}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: b.dataset.status === 'active' ? 'deactivated' : 'active' }),
    }))));

  $$('#acctTable [data-acct-lock]').forEach(b => b.addEventListener('click', () => act(() =>
    api(`/api/people/accounts/${b.dataset.acctLock}/${b.dataset.locked === 'true' ? 'unlock' : 'lock'}`,
        { method: 'POST', body: JSON.stringify({}) }))));

  $$('#acctTable [data-acct-role]').forEach(b => b.addEventListener('click', () => {
    const next = prompt(`Change role from "${b.dataset.role}" to (admin / employee / customer):`, b.dataset.role);
    if (!next || next === b.dataset.role) return;
    if (prompt('This changes what this person can see. Type CHANGE ROLE to confirm:') !== 'CHANGE ROLE') return;
    act(() => api(`/api/people/accounts/${b.dataset.acctRole}`, {
      method: 'PATCH', body: JSON.stringify({ role: next, confirm: 'CHANGE ROLE' }),
    }));
  }));
}

let acctTimer;
$('#acctSearch').addEventListener('input', () => { clearTimeout(acctTimer); acctTimer = setTimeout(loadAccounts, 250); });
$('#acctRole').addEventListener('change', loadAccounts);
$('#acctStatus').addEventListener('change', loadAccounts);

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
  routes: loadRoutes, employees: loadEmployees, accounts: loadAccounts,
  roles: loadRoles, pickups: loadPickups,
  payments: loadPayments, reports: loadReports,
};
/* Switching tabs abandons whatever is open, so ask first. */
$$('[data-tab]').forEach(b => b.addEventListener('click', (e) => {
  if (!confirmLeave('You have unsaved changes. Leave without saving?')) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true));

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

/* ============================================================
   Coupons & promotions (marketing)
   ============================================================ */
let couponRange = '90d';
const COUPON_STATUS_PILL = {
  active: 'ok', scheduled: 'pending', expired: '', limit_reached: 'warn', disabled: 'bad',
};

$$('[data-coupon-range] button').forEach(b => b.addEventListener('click', () => {
  couponRange = b.dataset.range;
  $$('[data-coupon-range] button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  loadCoupons();
}));

function discountLabel(c) {
  switch (c.discount_type) {
    case 'fixed':       return `${money(c.discount_value / 100)} off`;
    case 'percent':     return `${c.discount_value}% off`;
    case 'promo_price': return `${money(c.discount_value / 100)} price`;
    case 'free_period': return `${c.discount_value} free period(s)`;
    default: return '—';
  }
}

async function loadCoupons() {
  const [coupons, analytics] = await Promise.all([
    api('/api/promo/coupons'),
    api(`/api/promo/coupon-analytics?range=${couponRange}`),
  ]);

  $('#couponTable').innerHTML = table(
    ['Code', 'Name', 'Discount', 'Window', 'Used', 'Remaining', 'New', 'Existing', 'Revenue', 'Given', 'Status', ''],
    coupons.map(c => `<tr>
      <td><strong>${esc(c.code)}</strong>${c.is_intro ? ' <span class="pill intro">launch</span>' : ''}</td>
      <td class="small">${esc(c.name)}</td>
      <td class="small">${esc(discountLabel(c))}</td>
      <td class="small muted">${c.starts_at ? fmtDate(c.starts_at) : 'any'} → ${c.ends_at ? fmtDate(c.ends_at) : 'open'}</td>
      <td class="num">${c.used}${c.max_redemptions ? ' / ' + c.max_redemptions : ''}</td>
      <td class="num">${c.remaining == null ? '∞' : c.remaining}</td>
      <td class="num">${c.newCustomers}</td>
      <td class="num">${c.existingCustomers}</td>
      <td class="num">${money(c.revenue)}</td>
      <td class="num">${money(c.discountGiven)}</td>
      <td><span class="pill ${COUPON_STATUS_PILL[c.status] ?? ''}">${esc(c.status.replace('_', ' '))}</span></td>
      <td>
        <button class="btn small" data-coupon-hist="${c.id}" data-code="${esc(c.code)}">History</button>
        <button class="btn small" data-coupon-toggle="${c.id}" data-disabled="${c.disabled}">
          ${c.disabled ? 'Enable' : 'Disable'}</button>
        ${c.used === 0 ? `<button class="btn small btn-danger" data-coupon-del="${c.id}"
          data-code="${esc(c.code)}">Delete</button>` : ''}
      </td>
    </tr>`).join(''));

  $$('#couponTable [data-coupon-hist]').forEach(b => b.addEventListener('click', async () => {
    const rows = await api(`/api/promo/coupons/${b.dataset.couponHist}/redemptions`);
    $('#redemptionCard').hidden = false;
    $('#redemptionTitle').textContent = `Redemption history — ${b.dataset.code}`;
    $('#redemptionTable').innerHTML = table(
      ['Customer', 'Plan', 'Original', 'Discount', 'Final', 'Type', 'Redeemed'],
      rows.map(r => `<tr>
        <td><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><br />
          <span class="small muted">${esc(r.email)}</span></td>
        <td class="small">${esc(r.plan_code || '—')}</td>
        <td class="num">${money(r.originalPrice)}</td>
        <td class="num">${money(r.discount)}</td>
        <td class="num"><strong>${money(r.finalPrice)}</strong></td>
        <td><span class="pill ${r.customer_type === 'new' ? 'ok' : ''}">${esc(r.customer_type)}</span></td>
        <td class="small muted">${fmtDate(r.redeemed_at)}</td>
      </tr>`).join(''));
    $('#redemptionCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));

  $$('#couponTable [data-coupon-toggle]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/promo/coupons/${b.dataset.couponToggle}`, {
      method: 'PATCH', body: JSON.stringify({ disabled: b.dataset.disabled !== '1' }),
    });
    loadCoupons();
  }));

  $$('#couponTable [data-coupon-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`DELETE COUPON?\n\n${b.dataset.code}\n\nThis coupon has never been redeemed and will be permanently removed.\nThis action cannot be undone.`)) return;
    try {
      const r = await api(`/api/promo/coupons/${b.dataset.couponDel}`, { method: 'DELETE' });
      alert(r.message); loadCoupons();
    } catch (e) { alert(e.message + (e.suggestion ? `\n\n${e.suggestion}` : '')); }
  }));

  lineChart($('#chartCouponRedemptions'), {
    title: 'Redemptions over time',
    data: analytics.redemptionsOverTime,
    series: [
      { key: 'new_customers', color: '#2a78d6', label: 'New' },
      { key: 'existing_customers', color: '#f1541f', label: 'Existing' },
    ],
  });
  barChart($('#chartNewVsExisting'), { title: 'New vs existing customers', data: analytics.newVsExisting, unit: 'count' });
  barChart($('#chartRevByCoupon'),   { title: 'Revenue by coupon', data: analytics.revenueByCoupon });
  barChart($('#chartDiscByCoupon'),  { title: 'Discount cost by coupon', data: analytics.discountByCoupon, color: '#f1541f' });
}

$('#newCouponBtn').addEventListener('click', () => {
  const f = $('#newCouponForm'); f.hidden = !f.hidden;
});
$('#ncCancel').addEventListener('click', () => { $('#newCouponForm').hidden = true; });
$('#ncSave').addEventListener('click', async () => {
  const msg = $('#ncMsg');
  try {
    await api('/api/promo/coupons', {
      method: 'POST',
      body: JSON.stringify({
        code: $('#ncCode').value, name: $('#ncName').value,
        description: $('#ncDesc').value || undefined,
        discountType: $('#ncType').value, discountValue: $('#ncValue').value,
        startsAt: $('#ncStart').value || undefined, endsAt: $('#ncEnd').value || undefined,
        maxRedemptions: $('#ncMax').value || undefined,
        perCustomerLimit: $('#ncPerCustomer').value,
        eligibleCustomerType: $('#ncEligible').value,
        allowStacking: $('#ncStack').value === '1',
      }),
    });
    msg.textContent = 'Coupon created.'; msg.className = 'msg ok'; msg.hidden = false;
    ['ncCode','ncName','ncValue','ncDesc','ncMax'].forEach(i => { $('#' + i).value = ''; });
    loadCoupons();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
});

/* ============================================================
   Service credits (service recovery)
   ============================================================ */
async function loadCredits() {
  const [report, pending, activity, all_] = await Promise.all([
    api(`/api/promo/credit-report?range=${couponRange}`),
    api('/api/promo/credits?status=pending'),
    api('/api/promo/credit-activity'),
    api('/api/promo/credits'),
  ]);

  $('#creditStats').innerHTML = [
    ['Granted', money(report.totals.granted), ''],
    ['Credits issued', report.totals.grantedCount, ''],
    ['Pending approval', money(report.totals.pending), report.totals.pendingCount ? 'bad' : ''],
    ['Awaiting decision', report.totals.pendingCount, report.totals.pendingCount ? 'bad' : ''],
  ].map(([l, v, c]) =>
    `<div class="stat ${c}"><div class="stat-label">${l}</div><div class="stat-value">${esc(v)}</div></div>`).join('');

  $('#pendingTable').innerHTML = table(
    ['Requested', 'Customer', 'By', 'Amount', 'Reason', 'Notes', 'Decision'],
    pending.map(c => `<tr>
      <td class="small">${fmtDate(c.requested_at)}</td>
      <td><strong>${esc(c.customer_first)} ${esc(c.customer_last)}</strong></td>
      <td class="small">${esc(c.emp_first || '—')} ${esc(c.emp_last || '')}</td>
      <td class="num"><strong>${money(c.requested)}</strong></td>
      <td class="small">${esc(c.reasonLabel)}</td>
      <td class="small muted">${esc(c.notes || '')}</td>
      <td>
        <button class="btn small btn-primary" data-decide="approve" data-id="${c.id}">Approve</button>
        <button class="btn small" data-decide="modify" data-id="${c.id}" data-max="${c.requested}">Modify</button>
        <button class="btn small btn-danger" data-decide="reject" data-id="${c.id}">Reject</button>
      </td>
    </tr>`).join(''));

  $$('#pendingTable [data-decide]').forEach(b => b.addEventListener('click', async () => {
    const msg = $('#creditMsg');
    const decision = b.dataset.decide;
    let approvedAmount;
    if (decision === 'modify') {
      approvedAmount = prompt(`Approve how much? (requested $${b.dataset.max})`, b.dataset.max);
      if (!approvedAmount) return;
    }
    const notes = prompt('Decision notes (optional):') || undefined;
    try {
      await api(`/api/promo/credits/${b.dataset.id}/decide`, {
        method: 'POST', body: JSON.stringify({ decision, approvedAmount, notes }),
      });
      msg.textContent = 'Decision recorded in the audit trail.';
      msg.className = 'msg ok'; msg.hidden = false;
      loadCredits();
    } catch (e) { msg.textContent = e.message; msg.className = 'msg error'; msg.hidden = false; }
  }));

  barChart($('#chartCreditReason'),    { title: 'Credits by reason', data: report.byReason, color: '#f1541f' });
  barChart($('#chartCreditEmployee'),  { title: 'Credits by employee', data: report.byEmployee, color: '#f1541f' });
  barChart($('#chartCreditCommunity'), { title: 'Credits by community', data: report.byCommunity, color: '#f1541f' });

  $('#creditActivityTable').innerHTML = table(
    ['Employee', 'Issued', 'Total', 'Average', 'Pending'],
    activity.map(a => `<tr>
      <td>${esc(a.name)}</td>
      <td class="num">${a.issuedThisMonth}</td>
      <td class="num">${money(a.totalThisMonth)}</td>
      <td class="num">${money(a.averageCredit)}</td>
      <td class="num">${a.pending}</td>
    </tr>`).join(''));

  $('#allCreditsTable').innerHTML = table(
    ['Date', 'Customer', 'By', 'Requested', 'Approved', 'Reason', 'Status', 'Approved by'],
    all_.slice(0, 60).map(c => `<tr>
      <td class="small">${fmtDate(c.requested_at)}</td>
      <td class="small">${esc(c.customer_first)} ${esc(c.customer_last)}</td>
      <td class="small">${esc(c.emp_first || 'Manager')} ${esc(c.emp_last || '')}</td>
      <td class="num">${money(c.requested)}</td>
      <td class="num">${c.approved != null ? money(c.approved) : '—'}</td>
      <td class="small">${esc(c.reasonLabel)}</td>
      <td>${statusPill(c.status)}</td>
      <td class="small muted">${esc(c.approver_first || '')} ${esc(c.approver_last || '')}</td>
    </tr>`).join(''));
}

Object.assign(loaders, { coupons: loadCoupons, credits: loadCredits });
