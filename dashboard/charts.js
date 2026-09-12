/* ============================================================
   Charts — inline SVG, no library.

   Palette is the validated instance (see comment below). Colors are
   assigned by ENTITY, never by rank, so filtering never repaints a
   surviving series.

     slot 1  #2a78d6  blue    Revenue
     slot 2  #f1541f  orange  Expenses   (the brand hue)
     slot 3  #1baf7a  aqua    Profit

   Validated all-pairs on the #ffffff card surface:
     lightness band PASS · chroma floor PASS
     CVD separation PASS (worst ΔE 10.1 deutan)
     normal-vision  PASS (worst ΔE 24.0)
     contrast       WARN on aqua (2.82) → relief shipped as direct
                    labels + a table view on every chart.
   ============================================================ */

import { esc } from '/dashboard/dash.js';

export const SERIES = {
  revenue:  { color: '#2a78d6', label: 'Revenue' },
  expenses: { color: '#f1541f', label: 'Expenses' },
  profit:   { color: '#1baf7a', label: 'Profit' },
  labor:    { color: '#2a78d6', label: 'Labor' },
};

/* Status palette — reserved, never reused as a series color.
   Always paired with a label, never color alone. */
export const STATUS = {
  profitable:   { color: '#0ca30c', icon: '●', label: 'PROFITABLE' },
  low_margin:   { color: '#fab219', icon: '▲', label: 'LOW MARGIN' },
  break_even:   { color: '#ec835a', icon: '■', label: 'BREAK EVEN' },
  losing_money: { color: '#d03b3b', icon: '▼', label: 'LOSING MONEY' },
  no_revenue:   { color: '#6d737b', icon: '–', label: 'NO REVENUE' },
};

const INK = '#171a1f', MUTED = '#6d737b', GRID = '#e2ddd6';
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const uid = () => 'c' + Math.random().toString(36).slice(2, 8);

/** Nice round axis maximum so gridlines land on readable numbers. */
function niceMax(v) {
  if (v <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

function legend(series) {
  // Always present for >= 2 series; identity is never color-alone.
  return `<div class="chart-legend">${series.map(s =>
    `<span class="chart-legend-item"><span class="chart-swatch" style="background:${s.color}"></span>${esc(s.label)}</span>`
  ).join('')}</div>`;
}

function tableView(id, headers, rows) {
  return `<details class="chart-table" id="${id}-table">
    <summary>View as table</summary>
    <div class="table-wrap"><table>
      <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></details>`;
}

/* ============================================================
   Time series — revenue / expenses / profit.
   One y-axis only. Never a second scale.
   ============================================================ */
export function lineChart(el, { data, series, xKey = 'bucket', title, height = 230 }) {
  if (!data?.length) { el.innerHTML = `<div class="empty">No data for this range.</div>`; return; }

  const id = uid();
  const W = 760, H = height, PAD = { t: 14, r: 74, b: 30, l: 58 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

  const values = data.flatMap(d => series.map(s => d[s.key] ?? 0));
  const rawMax = Math.max(...values, 0), rawMin = Math.min(...values, 0);
  const max = niceMax(rawMax), min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const span = (max - min) || 1;

  const x = (i) => PAD.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => PAD.t + ih - ((v - min) / span) * ih;

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = min + (span * i) / ticks;
    return `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}"
                  stroke="${GRID}" stroke-width="1" />
            <text x="${PAD.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end"
                  fill="${MUTED}" font-size="11">${money(v)}</text>`;
  }).join('');

  const zero = min < 0
    ? `<line x1="${PAD.l}" y1="${y(0)}" x2="${W - PAD.r}" y2="${y(0)}" stroke="${MUTED}" stroke-width="1.5" />`
    : '';

  /* Direct labels sit at each series' final point. When two series end at
     similar values the labels overlap into unreadable mush, so nudge them
     apart vertically before drawing (greedy, in value order). */
  const LABEL_GAP = 13;
  const endLabels = series
    .map(s => ({ s, value: data[data.length - 1][s.key] ?? 0, y: y(data[data.length - 1][s.key] ?? 0) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < LABEL_GAP) {
      endLabels[i].y = endLabels[i - 1].y + LABEL_GAP;
    }
  }
  // keep them inside the plot
  const overflow = endLabels.length ? Math.max(0, endLabels[endLabels.length - 1].y - (PAD.t + ih)) : 0;
  for (const l of endLabels) l.y -= overflow;
  const labelY = new Map(endLabels.map(l => [l.s.key, l.y]));

  const paths = series.map(s => {
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d[s.key] ?? 0).toFixed(1)}`).join(' ');
    return `
      <polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round" />
      ${data.length <= 40 ? data.map((d, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(d[s.key] ?? 0).toFixed(1)}" r="3.5"
                 fill="${s.color}" stroke="#fff" stroke-width="2" />`).join('') : ''}
      <text x="${(W - PAD.r + 4).toFixed(1)}" y="${(labelY.get(s.key) + 4).toFixed(1)}"
            fill="${s.color}" font-size="11" font-weight="800"
            text-anchor="start">${esc(s.label)}</text>`;
  }).join('');

  // Hover: one full-height hit target per bucket, wider than the marks.
  const hover = data.map((d, i) => {
    const w = iw / Math.max(1, data.length);
    const rows = series.map(s => `${s.label}: ${money(d[s.key] ?? 0)}`).join(' · ');
    return `<rect x="${(x(i) - w / 2).toFixed(1)}" y="${PAD.t}" width="${w.toFixed(1)}" height="${ih}"
                  fill="transparent" class="chart-hit" data-label="${esc(d[xKey])} — ${esc(rows)}"
                  data-x="${x(i).toFixed(1)}" />`;
  }).join('');

  const xLabels = data.filter((_, i) => i % Math.ceil(data.length / 6) === 0)
    .map((d, n) => {
      const i = n * Math.ceil(data.length / 6);
      return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="${MUTED}"
                    font-size="10">${esc(String(d[xKey]).slice(5))}</text>`;
    }).join('');

  el.innerHTML = `
    ${title ? `<h3 class="chart-title">${esc(title)}</h3>` : ''}
    ${legend(series)}
    <div class="chart-shell">
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img"
           aria-label="${esc(title || 'Time series')}">
        ${grid}${zero}${paths}${xLabels}
        <line class="chart-crosshair" y1="${PAD.t}" y2="${PAD.t + ih}" stroke="${INK}"
              stroke-width="1" stroke-dasharray="3 3" opacity="0" />
        ${hover}
      </svg>
      <div class="chart-tip" hidden></div>
    </div>
    ${tableView(id, [xKey, ...series.map(s => s.label)],
      data.map(d => [d[xKey], ...series.map(s => money(d[s.key] ?? 0))]))}`;

  wireHover(el);
}

/* ============================================================
   Horizontal bars — by community, by route, by category.
   ============================================================ */
export function barChart(el, { data, title, valueKey = 'amount', labelKey = 'label',
                               color = SERIES.revenue.color, statusKey = null, max = 8 }) {
  if (!data?.length) { el.innerHTML = `<div class="empty">No data for this range.</div>`; return; }

  const id = uid();
  // Past `max` entries, fold the tail into "Other" rather than inventing hues.
  let rows = [...data].sort((a, b) => (b[valueKey] ?? 0) - (a[valueKey] ?? 0));
  if (rows.length > max) {
    const tail = rows.slice(max - 1);
    rows = rows.slice(0, max - 1).concat([{
      [labelKey]: `Other (${tail.length})`,
      [valueKey]: tail.reduce((a, r) => a + (r[valueKey] ?? 0), 0),
    }]);
  }

  const peak = Math.max(...rows.map(r => Math.abs(r[valueKey] ?? 0)), 1);

  el.innerHTML = `
    ${title ? `<h3 class="chart-title">${esc(title)}</h3>` : ''}
    <div class="bar-list">
      ${rows.map(r => {
        const v = r[valueKey] ?? 0;
        const pctW = Math.max(1, (Math.abs(v) / peak) * 100);
        const st = statusKey && r[statusKey] ? STATUS[r[statusKey]] : null;
        const fill = st ? st.color : (v < 0 ? STATUS.losing_money.color : color);
        return `
          <div class="bar-row" title="${esc(r[labelKey])}: ${money(v)}">
            <div class="bar-label">${esc(r[labelKey])}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${pctW}%;background:${fill}"></div>
            </div>
            <div class="bar-value">${money(v)}${
              st ? ` <span class="status-chip" style="color:${st.color}">${st.icon} ${st.label}</span>` : ''}</div>
          </div>`;
      }).join('')}
    </div>
    ${tableView(id, [labelKey, 'value'], rows.map(r => [r[labelKey], money(r[valueKey] ?? 0)]))}`;
}

/* ---------- shared hover behaviour ---------- */
function wireHover(el) {
  const svg = el.querySelector('.chart-svg');
  const tip = el.querySelector('.chart-tip');
  const cross = el.querySelector('.chart-crosshair');
  if (!svg || !tip) return;

  svg.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.chart-hit');
    if (!hit) return;
    tip.textContent = hit.dataset.label;
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    tip.style.left = Math.min(box.width - 180, Math.max(4, e.clientX - box.left + 10)) + 'px';
    tip.style.top = (e.clientY - box.top - 38) + 'px';
    if (cross) { cross.setAttribute('x1', hit.dataset.x); cross.setAttribute('x2', hit.dataset.x); cross.setAttribute('opacity', '.35'); }
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
    if (cross) cross.setAttribute('opacity', '0');
  });
}

export function statusChip(status) {
  const s = STATUS[status] || STATUS.no_revenue;
  return `<span class="status-chip" style="color:${s.color}">${s.icon} ${s.label}</span>`;
}
