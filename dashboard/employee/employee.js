import { api, $, $$, esc, money, fmtDate, fmtTime, ISSUE_LABELS, mountShell } from '/dashboard/dash.js';

let today = null;
let currentGroup = null;

await mountShell('employee');

/* ---------- navigation ---------- */
const panels = (name) => $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
$$('[data-tab]').forEach(b => b.addEventListener('click', () => {
  $$('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  panels(b.dataset.tab);
  if (b.dataset.tab === 'completed') loadCompleted();
  if (b.dataset.tab === 'hours') loadHours();
  if (b.dataset.tab === 'issues') loadIssues();
  if (b.dataset.tab === 'profile') loadProfile();
}));
$('#backToRoute').addEventListener('click', () => { panels('today'); loadToday(); });

/* ---------- today's route ---------- */
/* ?date=YYYY-MM-DD lets an employee (or you, demoing) look at another
   service day. Defaults to today. */
const viewDate = new URLSearchParams(location.search).get('date');
const dateQS = viewDate ? `?date=${encodeURIComponent(viewDate)}` : '';

async function loadToday() {
  today = await api('/api/employee/today' + dateQS);
  const { progress, communities, dayName, date, routes } = today;

  $('#progressText').textContent = progress.total
    ? `${progress.done} of ${progress.total} Pickups Completed`
    : 'No pickups scheduled today';
  $('#routeMeta').textContent = routes.length
    ? `${dayName} · ${routes.map(r => r.name).join(', ')}`
    : `${dayName} · ${fmtDate(date)} · no route assigned`;
  $('#progressFill').style.width =
    progress.total ? `${Math.round(progress.done / progress.total * 100)}%` : '0%';

  $('#stopList').innerHTML = communities.length ? communities.map(c => `
    <button class="stop-card ${c.remaining === 0 ? 'done' : ''}" data-group="${c.group_id}"
            data-name="${esc(c.group_name)}">
      <span>
        <span class="stop-name">${esc(c.group_name)}</span>
        <span class="stop-meta">${esc(c.street || '')}</span>
      </span>
      <span class="stop-count">${c.remaining === 0 ? '✓ Done' : `${c.remaining} left`}</span>
    </button>`).join('')
    : `<div class="empty">Nothing scheduled for you today.</div>`;

  $$('#stopList [data-group]').forEach(b =>
    b.addEventListener('click', () => openGroup(b.dataset.group, b.dataset.name)));
}

/* ---------- unit checklist ---------- */
async function openGroup(groupId, name) {
  currentGroup = { groupId, name };
  const data = await api(`/api/employee/stops?groupId=${encodeURIComponent(groupId)}`
    + (viewDate ? `&date=${encodeURIComponent(viewDate)}` : ''));
  $('#unitsTitle').textContent = name;
  const done = data.units.filter(u => u.status !== 'pending').length;
  $('#unitsMeta').textContent = `${done} of ${data.units.length} complete · ${today.dayName} route`;

  $('#unitList').innerHTML = data.units.map(u => {
    const cls = u.status === 'completed' ? 'done' : u.status === 'issue' ? 'issue' : '';
    const mark = u.status === 'completed' ? '✓' : u.status === 'issue' ? '!' : '';
    const sub = u.status === 'issue'
      ? ISSUE_LABELS[u.issue_code] || 'Issue'
      : u.first_name ? `${esc(u.first_name)} ${esc(u.last_name || '')}` : 'Vacant';
    return `
      <button class="unit-row ${cls}" data-unit="${u.unit_id}" data-label="${esc(u.label)}">
        <span class="unit-check">${mark}</span>
        <span>
          <span class="unit-label">${esc(u.label)}</span>
          <span class="stop-meta" style="display:block">${sub}${u.completed_at ? ' · ' + fmtTime(u.completed_at) : ''}</span>
        </span>
      </button>`;
  }).join('') || `<div class="empty">No units scheduled here today.</div>`;

  $$('#unitList [data-unit]').forEach(b =>
    b.addEventListener('click', () => openSheet(Number(b.dataset.unit), b.dataset.label)));

  panels('units');
}

/* ---------- record a pickup ---------- */
function openSheet(unitId, label) {
  let mode = 'completed', issueCode = null, photoDataUrl = null, photoMime = null;

  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Record pickup for ${esc(label)}">
      <h2>${esc(label)}</h2>
      <p class="muted small" id="sheetSub">Mark this pickup complete, or report a problem.</p>

      <button class="btn btn-primary big-btn" data-mode="completed" aria-pressed="true">✓ Pickup Completed</button>
      <button class="btn big-btn" data-mode="issue" aria-pressed="false">⚠ Report a problem</button>

      <div id="issueBox" hidden>
        <div class="issue-grid">
          ${Object.entries(ISSUE_LABELS).map(([code, text]) =>
            `<button class="btn" data-issue="${code}" aria-pressed="false">${text}</button>`).join('')}
        </div>
      </div>

      <div class="photo-drop">
        <strong class="small">Photo${''}</strong>
        <p class="muted small" style="margin:4px 0 9px">Show the trash was collected.</p>
        <input type="file" accept="image/*" capture="environment" id="photoInput" />
        <div id="photoPreview"></div>
      </div>

      <div class="field">
        <label for="pickupNotes">Notes (optional)</label>
        <textarea id="pickupNotes" rows="2" placeholder="Anything worth recording"></textarea>
      </div>

      <p class="msg error" id="sheetError" hidden></p>
      <button class="btn btn-primary big-btn" id="submitPickup">Submit</button>
      <button class="btn big-btn" id="cancelSheet">Cancel</button>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';

  const close = () => { el.remove(); document.body.style.overflow = ''; };
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  $('#cancelSheet', el).addEventListener('click', close);

  $$('[data-mode]', el).forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    $$('[data-mode]', el).forEach(x => {
      x.setAttribute('aria-pressed', String(x === b));
      x.classList.toggle('btn-primary', x === b);
    });
    $('#issueBox', el).hidden = mode !== 'issue';
  }));

  $$('[data-issue]', el).forEach(b => b.addEventListener('click', () => {
    issueCode = b.dataset.issue;
    $$('[data-issue]', el).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));

  $('#photoInput', el).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    photoMime = file.type;
    const reader = new FileReader();
    reader.onload = () => {
      photoDataUrl = reader.result;
      $('#photoPreview', el).innerHTML = `<img src="${photoDataUrl}" alt="Pickup photo preview" />`;
    };
    reader.readAsDataURL(file);
  });

  $('#submitPickup', el).addEventListener('click', async () => {
    const btn = $('#submitPickup', el), err = $('#sheetError', el);
    err.hidden = true;
    if (mode === 'issue' && !issueCode) {
      err.textContent = 'Choose a reason for the problem.'; err.hidden = false; return;
    }
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await api('/api/employee/pickups', {
        method: 'POST',
        body: JSON.stringify({
          unitId, status: mode, issueCode: mode === 'issue' ? issueCode : undefined,
          serviceDate: viewDate || undefined,
          notes: $('#pickupNotes', el).value || undefined,
          photo: photoDataUrl ? { dataUrl: photoDataUrl, mimeType: photoMime } : undefined,
        }),
      });
      close();
      await openGroup(currentGroup.groupId, currentGroup.name);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Submit';
    }
  });
}

/* ---------- other tabs ---------- */
async function loadCompleted() {
  const rows = await api('/api/employee/completed');
  $('#completedList').innerHTML = rows.length ? rows.map(r => `
    <div class="card" style="margin-bottom:10px">
      <strong>${esc(r.community_name || '')} ${esc(r.label)}</strong>
      <div class="muted small">${fmtDate(r.service_date)} · ${fmtTime(r.completed_at)}
        ${r.status === 'issue' ? ' · ' + esc(ISSUE_LABELS[r.issue_code] || 'Issue') : ''}
        ${r.photo_count ? ' · 📷' : ''}</div>
    </div>`).join('') : `<div class="empty">No pickups recorded yet.</div>`;
}

async function loadIssues() {
  const rows = await api('/api/employee/issues');
  $('#issuesList').innerHTML = rows.length ? rows.map(r => `
    <div class="card" style="margin-bottom:10px">
      <strong>${esc(r.community_name || '')} ${esc(r.label)}</strong>
      <div class="muted small">${fmtDate(r.service_date)} · ${esc(ISSUE_LABELS[r.issue_code] || 'Issue')}</div>
      ${r.notes ? `<p class="small" style="margin:7px 0 0">${esc(r.notes)}</p>` : ''}
    </div>`).join('') : `<div class="empty">No issues reported.</div>`;
}

async function loadProfile() {
  const p = await api('/api/employee/profile');
  $('#profileCard').innerHTML = `
    <h2>${esc(p.user.firstName)} ${esc(p.user.lastName)}</h2>
    <p class="muted small">${esc(p.user.email)}${p.user.phone ? ' · ' + esc(p.user.phone) : ''}</p>
    <p class="small"><strong>Employee code:</strong> ${esc(p.employee.employee_code || '—')}</p>
    <h3 style="margin-top:16px">My routes</h3>
    ${p.routes.length ? p.routes.map(r =>
      `<div class="small">• ${esc(r.dayName)} — ${esc(r.name)}</div>`).join('')
      : '<p class="muted small">No routes assigned.</p>'}
    <p class="muted small" style="margin-top:16px">
      You cannot see or change customer billing information.
    </p>`;
}

loadToday();


/* ============================================================
   Time clock
   ============================================================ */
let shiftState = null;
let tick = null;

const hhmm = (mins) => `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`;

async function loadShift() {
  shiftState = await api('/api/employee/shift');
  const { openShift, payPeriod, compensation } = shiftState;

  $('#periodHours').textContent = payPeriod.hours;
  $('#periodShifts').textContent = payPeriod.shifts;
  $('#periodPay').textContent = money(payPeriod.estimatedPayCents / 100);
  $('#periodRange').textContent =
    `Pay period ${fmtDate(payPeriod.start)} – ${fmtDate(payPeriod.end)} · ` +
    (compensation.payType === 'daily'
      ? `${money(compensation.rateCents / 100)} per shift`
      : `${money(compensation.rateCents / 100)}/hour`);

  const btn = $('#clockBtn');
  clearInterval(tick);

  if (openShift) {
    $('#clockState').textContent = 'On the clock';
    $('#clockSince').textContent = `Since ${fmtTime(openShift.clockInAt)}`;
    btn.textContent = 'Clock Out';
    btn.className = 'btn clock-btn clock-out-btn';

    const started = new Date(openShift.clockInAt.replace(' ', 'T') + 'Z');
    const render = () => {
      const mins = Math.max(0, (Date.now() - started.getTime()) / 60000);
      $('#clockTimer').textContent = hhmm(mins);
    };
    render();
    tick = setInterval(render, 30000);
  } else {
    $('#clockState').textContent = 'Not clocked in';
    $('#clockTimer').textContent = '--:--';
    $('#clockSince').textContent = 'Start your shift when you begin your route.';
    btn.textContent = 'Clock In';
    btn.className = 'btn clock-btn clock-in-btn';
  }
}

$('#clockBtn').addEventListener('click', async () => {
  const btn = $('#clockBtn'), err = $('#clockError');
  err.hidden = true;
  btn.disabled = true;
  const clockingIn = !shiftState?.openShift;
  btn.textContent = clockingIn ? 'Clocking in…' : 'Clocking out…';

  try {
    if (clockingIn) {
      const routeId = today?.routes?.[0]?.id;
      await api('/api/employee/clock-in', {
        method: 'POST', body: JSON.stringify({ routeId }),
      });
    } else {
      const breakMinutes = Number(prompt('Break time taken, in minutes (0 if none):', '0') || 0);
      const res = await api('/api/employee/clock-out', {
        method: 'POST', body: JSON.stringify({ breakMinutes }),
      });
      alert(`Shift recorded: ${hhmm(res.minutes)} · estimated ${money(res.payCents / 100)}`);
    }
    await loadShift();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function loadHours() {
  const shifts = await api('/api/employee/shifts');
  const p = shiftState?.payPeriod;
  $('#hoursSummary').innerHTML = p ? `
    <h2>${p.hours} hours this pay period</h2>
    <p class="muted small">${fmtDate(p.start)} – ${fmtDate(p.end)} · ${p.shifts} shifts</p>
    <p class="stat-value" style="color:var(--orange-dark)">${money(p.estimatedPayCents / 100)}
      <span class="small muted">estimated</span></p>
    <p class="muted small">Estimated from your recorded hours. Final pay is confirmed by your manager.</p>`
    : '';

  $('#shiftList').innerHTML = shifts.length ? shifts.map(s => `
    <div class="card" style="margin-bottom:9px">
      <strong>${fmtDate(s.work_date)}</strong>
      ${s.route_name ? `<span class="muted small"> · ${esc(s.route_name)}</span>` : ''}
      <div class="muted small">
        ${fmtTime(s.clock_in_at)} → ${s.clock_out_at ? fmtTime(s.clock_out_at) : '<em>still open</em>'}
        ${s.break_minutes ? ` · ${s.break_minutes}m break` : ''}
      </div>
      <div class="small"><strong>${hhmm(s.minutes || 0)}</strong>
        ${s.clock_out_at ? ` · ${money(s.payCents / 100)}` : ''}
        ${s.source === 'admin' ? ' · <span class="pill warn">edited by admin</span>' : ''}</div>
    </div>`).join('') : '<div class="empty">No shifts recorded yet.</div>';
}

loadShift();
