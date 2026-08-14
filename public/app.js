'use strict';

/* ═══════════ Utilitas ═══════════ */
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach(c => n.append(c?.nodeType ? c : document.createTextNode(c ?? '')));
  return n;
};
const bytes = b => {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const rate = b => bytes(b) + '/s';
const dur = s => {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`;
};
const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hours ago';
  return Math.floor(s / 86400) + ' days ago';
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(p, o = {}) {
  const r = await fetch('/api' + p, {
    ...o,
    headers: o.body && !(o.body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Gagal (' + r.status + ')');
  return j;
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}
function openDrawer(title, body) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').replaceChildren(body);
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
}
function closeDrawer() {
  $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on');
}
$('#scrim').onclick = closeDrawer;
addEventListener('keydown', e => e.key === 'Escape' && closeDrawer());

/* ═══════════ Ikon ═══════════ */
const I = {
  gauge: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M13.4 10.6 19 5"/><path d="M20.5 16.5a9.5 9.5 0 1 0-17 0"/>',
  box: '<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  logs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2.5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/>',
  db: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  ram: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 17v3M10 17v3M14 17v3M18 17v3"/>',
  disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  temp: '<path d="M14 14.76V4.5a2.5 2.5 0 0 0-5 0v10.26a4.5 4.5 0 1 0 5 0Z"/>',
  net: '<path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/><circle cx="12" cy="12" r="10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restart: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/>',
  fold: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2.5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  refresh: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"/><path d="M9 12H4s.55-3.03 2-4h3"/><path d="M12 15v5s3.03-.55 4-2v-3"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  term: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6.5 9 9.5 12 6.5 15"/><line x1="12.5" y1="15" x2="17" y2="15"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
};
const ic = (k, sz = 15, sw = 1.6) =>
  `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
   stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${I[k] || ''}</svg>`;

/* ═══════════ Grafik (canvas, tanpa library) ═══════════ */
function chart(canvas, series, opts = {}) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = opts.height || 108;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + 'px';
  const x = canvas.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.body);
  const line = cs.getPropertyValue('--line').trim();
  const dim = cs.getPropertyValue('--tx-3').trim();

  const all = series.flatMap(s => s.data);
  const max = opts.max ?? Math.max(1, ...all) * 1.15;
  const pad = { t: 6, r: 4, b: 14, l: 34 };
  const gw = w - pad.l - pad.r, gh = h - pad.t - pad.b;

  x.strokeStyle = line; x.lineWidth = 1; x.font = '9.5px ui-sans-serif'; x.fillStyle = dim;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + gh * i / 3;
    x.beginPath(); x.moveTo(pad.l, y + .5); x.lineTo(w - pad.r, y + .5); x.stroke();
    x.textAlign = 'right'; x.textBaseline = 'middle';
    x.fillText(opts.fmt ? opts.fmt(max * (1 - i / 3)) : Math.round(max * (1 - i / 3)), pad.l - 6, y);
  }

  series.forEach(s => {
    if (s.data.length < 2) return;
    const px = i => pad.l + gw * i / (s.data.length - 1);
    const py = v => pad.t + gh * (1 - Math.min(v, max) / max);
    if (s.fill !== false) {
      const g = x.createLinearGradient(0, pad.t, 0, pad.t + gh);
      g.addColorStop(0, s.color + '38'); g.addColorStop(1, s.color + '00');
      x.beginPath(); x.moveTo(px(0), pad.t + gh);
      s.data.forEach((v, i) => x.lineTo(px(i), py(v)));
      x.lineTo(px(s.data.length - 1), pad.t + gh); x.closePath();
      x.fillStyle = g; x.fill();
    }
    x.beginPath();
    s.data.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
    x.strokeStyle = s.color; x.lineWidth = 1.6; x.lineJoin = 'round'; x.stroke();
  });
}

/* ═══════════ Kerangka aplikasi ═══════════ */
const PAGES = [
  { g: 'Monitor', items: [
    { id: 'overview', n: 'Overview', i: 'gauge' },
    { id: 'events', n: 'Notifications', i: 'bell' },
    { id: 'monitor', n: 'Uptime', i: 'pulse' },
    { id: 'assistant', n: 'Assistant', i: 'spark' },
  ]},
  { g: 'Apps', items: [
    { id: 'stacks', n: 'Stacks & Deploy', i: 'rocket' },
    { id: 'containers', n: 'Containers', i: 'box' },
    { id: 'logs', n: 'Logs', i: 'logs' },
  ]},
  { g: 'Data', items: [
    { id: 'editor', n: 'Code Editor', i: 'code' },
    { id: 'files', n: 'Files', i: 'folder' },
    { id: 'database', n: 'Databases', i: 'db' },
  ]},
  { g: 'Publish', items: [
    { id: 'domains', n: 'Domains & SSL', i: 'net' },
  ]},
  { g: 'Automation', items: [
    { id: 'jobs', n: 'Scheduler', i: 'clock' },
    { id: 'vault', n: 'Vault & Backups', i: 'lock' },
  ]},
  { g: 'System', items: [
    { id: 'terminal', n: 'Terminal', i: 'term' },
    { id: 'resources', n: 'Resources', i: 'layers' },
    { id: 'system', n: 'System', i: 'cog' },
    { id: 'settings', n: 'Settings', i: 'cog' },
  ]},
];

let page = 'overview';
let timers = [];
const clearTimers = () => { timers.forEach(t => clearInterval(t) || clearTimeout(t)); timers = []; };
const every = (fn, ms) => { fn(); timers.push(setInterval(fn, ms)); };

let MY_PERMS = { all: true, pages: [] };
const allowed = (id) => MY_PERMS.all || MY_PERMS.pages.includes(id);

function buildNav() {
  const nav = $('#nav'); nav.replaceChildren();
  PAGES.forEach(g => {
    const items = g.items.filter(p => allowed(p.id));
    if (!items.length) return;
    nav.append(el('div', { class: 'grp' }, g.g));
    items.forEach(p => {
      const n = el('div', { class: 'item' + (p.id === page ? ' on' : ''), 'data-id': p.id,
        html: ic(p.i) + `<span>${p.n}</span>`
          + (p.id === 'events' ? '<span class="badge"></span>' : '') });
      n.onclick = () => go(p.id);
      nav.append(n);
    });
  });
}
function go(id) {
  if (!allowed(id)) {
    const first = PAGES.flatMap(g => g.items).find(p => allowed(p.id));
    if (!first) {
      $('#view').replaceChildren(el('div', { class: 'pad' },
        el('div', { class: 'empty' }, 'Your account has no page access yet. '
          + 'Hubungi admin.')));
      return;
    }
    id = first.id;
  }
  page = id; location.hash = id;
  clearTimers(); closeDrawer();
  $('#side').classList.remove('open');
  const p = PAGES.flatMap(g => g.items).find(x => x.id === id) || PAGES[0].items[0];
  $('#title').textContent = p.n; $('#sub').textContent = '';
  $('#actions').replaceChildren();
  buildNav();
  $('#view').replaceChildren(el('div', { class: 'pad' }, el('div', { class: 'empty' }, 'Loading…')));
  VIEWS[id]?.();
}

const VIEWS = {};

/* Sub-tab dalam satu pages. */
function tabs(defs, onPick) {
  const bar = el('div', { class: 'tabs' });
  const body = el('div');
  let cur = defs[0].id;
  const paint = () => {
    bar.replaceChildren(...defs.map(d => {
      const t = el('div', { class: 'tab' + (d.id === cur ? ' on' : ''),
        html: (d.i ? ic(d.i, 14) : '') + `<span>${d.n}</span>` +
          (d.count != null ? `<span class="n">${d.count}</span>` : '') });
      t.onclick = () => { cur = d.id; paint(); onPick(cur, body); };
      return t;
    }));
  };
  paint(); onPick(cur, body);
  return { node: el('div', {}, bar, body), body, get current() { return cur; },
    setCount(id, n) { const d = defs.find(x => x.id === id); if (d) { d.count = n; paint(); } } };
}

/* Penanda "diperbarui otomatis" di kanan atas tiap pages. */
function liveBadge(sec) {
  const b = el('span', { class: 'live', html: `<i></i><span>tiap ${sec}s</span>` });
  $('#actions').append(b);
  return b;
}
const mount = (node, opts = {}) => $('#view').replaceChildren(
  el('div', { class: opts.full ? 'pad full' : 'pad' }, node));
const addAction = (label, icon, fn, cls = 'btn') => {
  const b = el('button', { class: cls, html: (icon ? ic(icon, 14) : '') + `<span>${label}</span>` });
  b.onclick = fn; $('#actions').append(b); return b;
};

/* ═══════════ 1. Ringkasan ═══════════ */
VIEWS.overview = () => {
  const stats = el('div', { class: 'stats' });
  const chartsWrap = el('div', { class: 'grid2' });
  const infoCard = el('div', { class: 'card' });
  const root = el('div', {},
    el('div', { class: 'sec' }, 'Resources'), stats,
    el('div', { class: 'sec' }, 'Riwayat 30 menit'), chartsWrap,
    el('div', { class: 'sec' }, 'System'), infoCard);
  mount(root);

  const mk = (key, icon, val, meta, pct) => {
    const bar = pct != null ? el('div', { class: 'bar' },
      el('i', { style: `width:${Math.min(pct, 100)}%`,
        class: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '' })) : null;
    return el('div', { class: 'stat' },
      el('div', { class: 'k', html: ic(icon, 12) + `<span>${key}</span>` }),
      el('div', { class: 'v', html: val }),
      meta ? el('div', { class: 'm' }, meta) : '', bar || '');
  };

  const c1 = el('canvas'), c2 = el('canvas'), c3 = el('canvas'), c4 = el('canvas');
  const card = (t, c) => el('div', { class: 'card' },
    el('div', { class: 'card-h' }, el('h3', {}, t)), el('div', { class: 'card-b' }, c));
  chartsWrap.append(card('CPU & Memory (%)', c1), card('Suhu (°C)', c2),
    card('Network', c3), card('Disk (%)', c4));

  every(async () => {
    try {
      const s = await api('/system/stats');
      stats.replaceChildren(
        mk('CPU', 'cpu', `${s.cpu.percent}<small>%</small>`,
          `${s.cpu.cores} thread · beban ${s.cpu.load?.[0]?.toFixed(2) ?? '—'}`, s.cpu.percent),
        mk('Memory', 'ram', `${s.memory.percent}<small>%</small>`,
          `${bytes(s.memory.used)} / ${bytes(s.memory.total)}`, s.memory.percent),
        mk('Disk', 'disk', `${s.disk.percent}<small>%</small>`,
          `sisa ${bytes(s.disk.free)}`, s.disk.percent),
        mk('Suhu', 'temp', s.temperature != null ? `${s.temperature}<small>°C</small>` : '—',
          s.temperature != null ? (s.temperature >= 80 ? 'panas — periksa kipas'
            : s.temperature >= 65 ? 'hangat' : 'normal') : 'tidak terbaca',
          s.temperature != null ? Math.min(s.temperature / 100 * 100, 100) : null),
        mk('Network', 'net', `${rate(s.network.rxRate)}`,
          `kirim ${rate(s.network.txRate)}`),
        mk('Nyala', 'clock', dur(s.uptime), 'tanpa restart'),
      );
    } catch (e) { stats.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }, 5000);

  every(async () => {
    try {
      const { points } = await api('/system/history?n=360');
      if (!points.length) return;
      chart(c1, [{ data: points.map(p => p.c), color: '#5b8def' },
                 { data: points.map(p => p.m), color: '#3dbb7d', fill: false }], { max: 100 });
      const temps = points.map(p => p.tp).filter(v => v != null);
      chart(c2, temps.length ? [{ data: points.map(p => p.tp ?? 0), color: '#d99b1c' }] : [],
        { max: 100 });
      chart(c3, [{ data: points.map(p => p.rx), color: '#5b8def' },
                 { data: points.map(p => p.tx), color: '#e5484d', fill: false }],
        { fmt: v => bytes(v) });
      chart(c4, [{ data: points.map(p => p.d), color: '#9aa0ac' }], { max: 100 });
    } catch {}
  }, 10000);

  api('/system/info').then(({ docker: d }) => {
    if (!d) return;
    const row = (k, v) => el('tr', {}, el('td', { style: 'color:var(--tx-3);width:38%' }, k),
      el('td', { class: 'mono' }, v ?? '—'));
    infoCard.replaceChildren(el('div', { class: 'card-b', style: 'padding:0' },
      el('table', {}, el('tbody', {},
        row('Sistem operasi', d.os), row('Kernel', d.kernel), row('Arsitektur', d.arch),
        row('CPU', d.cpus + ' thread'), row('Memory total', bytes(d.mem)),
        row('Docker', d.version),
        row('Containers', `${d.running} jalan / ${d.containers} total`),
        row('Image', String(d.images))))));
    $('#hostLabel').textContent = d.os || 'server';
    $('#verLabel').textContent = 'Docker ' + (d.version || '');
  }).catch(() => {});
};

/* ═══════════ 2. Container ═══════════ */
VIEWS.containers = () => {
  const wrap = el('div', { class: 'card' });
  mount(wrap);
  addAction('Refresh', 'refresh', () => load());

  async function act(id, what, name) {
    if (what === 'remove' && !confirm(`Hapus container "${name}"? Tindakan ini permanen.`)) return;
    try {
      await api(`/containers/${id}/${what}`, { method: 'POST' });
      toast({ start: 'Dijalankan', stop: 'Dihentikan', restart: 'Di-restart', remove: 'Deleted' }[what]);
      load();
    } catch (e) { toast(e.message); }
  }

  async function load() {
    try {
      const { containers } = await api('/containers');
      if (!containers.length) {
        wrap.replaceChildren(el('div', { class: 'empty', html: ic('box', 30, 1.3) + '<div>No containers</div>' }));
        return;
      }
      const tb = el('tbody');
      containers.forEach(c => {
        const run = c.state === 'running';
        const btn = (t, i, w) => {
          const b = el('button', { class: 'ib', title: t, html: ic(i, 14) });
          b.onclick = e => { e.stopPropagation(); act(c.id, w, c.name); };
          return b;
        };
        const tr = el('tr', { style: 'cursor:pointer' },
          el('td', {}, el('div', { class: 'row' },
            el('i', { class: 'dot ' + (run ? 'up' : c.state === 'restarting' ? 'warn' : 'idle') }),
            el('div', {}, el('div', { style: 'font-weight:500' }, c.name),
              el('div', { style: 'font-size:10.5px;color:var(--tx-3)' }, c.image)))),
          el('td', { class: 'mono', style: 'color:var(--tx-3)' }, c.status),
          el('td', { class: 'num' }, run ? c.cpu + '%' : '—'),
          el('td', { class: 'num' }, run ? bytes(c.mem.used) : '—'),
          el('td', { class: 'mono', style: 'color:var(--tx-3)' }, c.ports.join(', ') || '—'),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' },
            run ? btn('Stop', 'stop', 'stop') : btn('Run', 'play', 'start'),
            btn('Restart', 'restart', 'restart'),
            btn('Delete', 'trash', 'remove'))));
        tr.onclick = () => detail(c);
        tb.append(tr);
      });
      wrap.replaceChildren(el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {},
          el('th', {}, 'Containers'), el('th', {}, 'Status'),
          el('th', { class: 'num' }, 'CPU'), el('th', { class: 'num' }, 'Memory'),
          el('th', {}, 'Port'), el('th', {}, ''))), tb)));
      $('#sub').textContent = `${containers.filter(c => c.state === 'running').length} dari ${containers.length} jalan`;
    } catch (e) {
      wrap.replaceChildren(el('div', { class: 'empty' }, e.message));
    }
  }

  async function detail(c) {
    const body = el('div', {}, el('div', { class: 'empty' }, 'Loading…'));
    openDrawer(c.name, body);
    try {
      const d = await api(`/containers/${c.id}/inspect`);
      const row = (k, v) => el('tr', {}, el('td', { style: 'color:var(--tx-3);width:36%' }, k),
        el('td', { class: 'mono', style: 'word-break:break-all' }, v ?? '—'));
      const env = (d.Config?.Env || []).map(e => {
        const i = e.indexOf('=');
        const k = e.slice(0, i);
        // Value rahasia disamarkan supaya tidak bocor lewat layar.
        const secret = /pass|secret|token|key|pwd/i.test(k);
        return k + '=' + (secret ? '••••••••' : e.slice(i + 1));
      });
      body.replaceChildren(
        el('div', { class: 'sec' }, 'Umum'),
        el('div', { class: 'card' }, el('table', {}, el('tbody', {},
          row('Name', c.name), row('Image', c.image), row('Status', c.status),
          row('Dibuat', new Date(c.created).toLocaleString('id-ID')),
          row('Restart', d.HostConfig?.RestartPolicy?.Name || '—'),
          row('ID', c.id.slice(0, 12))))),
        el('div', { class: 'sec' }, 'Variabel lingkungan'),
        el('div', { class: 'card' }, el('div', { class: 'card-b mono',
          style: 'white-space:pre-wrap;word-break:break-all;font-size:11.5px' },
          env.join('\n') || '—')),
        el('div', { class: 'sec' }, 'Log terakhir'),
        el('div', {}, (() => {
          const b = el('button', { class: 'btn', html: ic('logs', 14) + '<span>Buka log langsung</span>' });
          b.onclick = () => { closeDrawer(); go('logs'); setTimeout(() => window.__pickLog?.(c.id), 120); };
          return b;
        })()));
    } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  every(load, 5000);
};

/* ═══════════ 3. Log ═══════════ */
VIEWS.logs = () => {
  const sel = el('select');
  const filter = el('input', { placeholder: 'Saring baris…', style: 'max-width:200px' });
  const box = el('div', { class: 'logbox' });
  let es = null, lines = [], auto = true;

  const bar = el('div', { class: 'row', style: 'margin-bottom:10px' },
    el('div', { style: 'max-width:260px;flex:1' }, sel),
    el('div', { style: 'flex:1' }, filter));
  mount(el('div', {}, bar, box));

  const autoBtn = el('button', { class: 'tg on', title:
    'Kalau active, layar otomatis turun ke baris terbaru. Disable kalau mau membaca log lama tanpa terganggu.',
    html: ic('down', 13) + '<span>Gulir otomatis</span>' });
  autoBtn.onclick = () => {
    auto = !auto; autoBtn.classList.toggle('on', auto);
    if (auto) box.scrollTop = box.scrollHeight;
  };
  $('#actions').append(autoBtn);
  addAction('Clean', 'trash', () => { lines = []; render(); });

  function render() {
    const f = filter.value.trim().toLowerCase();
    const show = f ? lines.filter(l => l.toLowerCase().includes(f)) : lines;
    box.replaceChildren(...show.slice(-3000).map(l => {
      const d = el('span', { class: 'l' });
      if (f) {
        const i = l.toLowerCase().indexOf(f);
        d.append(l.slice(0, i), el('mark', {}, l.slice(i, i + f.length)), l.slice(i + f.length));
      } else d.textContent = l;
      return d;
    }));
    if (auto) box.scrollTop = box.scrollHeight;
  }
  filter.oninput = render;

  function connect(id) {
    es?.close(); lines = []; render();
    if (!id) return;
    es = new EventSource(`/api/containers/${id}/logs?tail=300`);
    es.onmessage = e => {
      try { lines.push(JSON.parse(e.data)); } catch {}
      if (lines.length > 5000) lines = lines.slice(-4000);
      render();
    };
    es.onerror = () => { lines.push('— koneksi log terputus —'); render(); };
  }
  sel.onchange = () => connect(sel.value);
  window.__pickLog = id => { sel.value = id; connect(id); };

  api('/containers').then(({ containers }) => {
    sel.replaceChildren(el('option', { value: '' }, 'Pilih container…'),
      ...containers.map(c => el('option', { value: c.id },
        `${c.name}${c.state === 'running' ? '' : '  (mati)'}`)));
    const first = containers.find(c => c.state === 'running');
    if (first) { sel.value = first.id; connect(first.id); }
  }).catch(e => box.textContent = e.message);

  timers.push(setTimeout(() => {}, 0));
  const old = clearTimers;
  timers.push({ close: () => es?.close() });
  addEventListener('hashchange', () => es?.close(), { once: true });
};

/* ═══════════ 4. Berkas ═══════════ */
VIEWS.files = () => {
  let cwd = '';
  const crumb = el('div', { class: 'crumb' });
  const wrap = el('div', { class: 'card' });
  mount(el('div', {}, el('div', { class: 'row', style: 'margin-bottom:10px' }, crumb), wrap));

  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  document.body.append(fileInput);
  fileInput.onchange = async () => {
    for (const f of fileInput.files) {
      try {
        await fetch(`/api/files/upload?path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', body: f });
        toast(`${f.name} diunggah`);
      } catch { toast('Gagal mengunggah ' + f.name); }
    }
    fileInput.value = ''; load();
  };

  addAction('Unggah', 'up', () => fileInput.click(), 'btn pri');
  addAction('Folder baru', 'plus', async () => {
    const name = prompt('Nama folder baru:');
    if (!name) return;
    try { await api('/files/mkdir', { method: 'POST', body: JSON.stringify({ path: cwd, name }) });
      load(); } catch (e) { toast(e.message); }
  });
  addAction('Refresh', 'refresh', () => load());

  function setCrumb() {
    const parts = cwd ? cwd.split('/').filter(Boolean) : [];
    crumb.replaceChildren();
    const home = el('a', {}, 'data'); home.onclick = () => { cwd = ''; load(); };
    crumb.append(home);
    parts.forEach((p, i) => {
      crumb.append(el('span', {}, '/'));
      const a = el('a', {}, p);
      a.onclick = () => { cwd = parts.slice(0, i + 1).join('/'); load(); };
      crumb.append(a);
    });
  }

  async function open(it) {
    const full = (cwd ? cwd + '/' : '') + it.name;
    if (it.dir) { cwd = full; return load(); }
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(it.name)) {
      return openDrawer(it.name, el('img', { src: `/api/files/raw?path=${encodeURIComponent(full)}`,
        style: 'max-width:100%;border-radius:8px' }));
    }
    if (it.size > 2 * 1024 * 1024) { toast('File is too large to open'); return; }
    try {
      const { content } = await api('/files/read?path=' + encodeURIComponent(full));
      const ta = el('textarea', { style: 'height:64vh' }); ta.value = content;
      const save = el('button', { class: 'btn pri', html: ic('edit', 14) + '<span>Simpan</span>' });
      save.onclick = async () => {
        try { await api('/files/write', { method: 'POST',
          body: JSON.stringify({ path: full, content: ta.value }) });
          toast('Saved'); } catch (e) { toast(e.message); }
      };
      openDrawer(it.name, el('div', {}, ta,
        el('div', { class: 'row', style: 'margin-top:10px' }, save)));
    } catch (e) { toast(e.message); }
  }

  async function load() {
    setCrumb();
    try {
      const { items } = await api('/files/list?path=' + encodeURIComponent(cwd));
      if (!items.length) {
        wrap.replaceChildren(el('div', { class: 'empty', html: ic('folder', 30, 1.3) + '<div>Empty folder</div>' }));
        return;
      }
      const tb = el('tbody');
      items.forEach(it => {
        const full = (cwd ? cwd + '/' : '') + it.name;
        const nameCell = el('div', { class: 'fname',
          html: ic(it.dir ? 'fold' : 'file', 14) + `<span>${esc(it.name)}</span>` });
        nameCell.onclick = () => open(it);
        const dl = el('a', { class: 'ib', title: 'Download', html: ic('down', 14),
          href: `/api/files/download?path=${encodeURIComponent(full)}` });
        const rn = el('button', { class: 'ib', title: 'Ganti nama', html: ic('edit', 14) });
        rn.onclick = async () => {
          const to = prompt('Nama baru:', it.name); if (!to || to === it.name) return;
          try { await api('/files/rename', { method: 'POST', body: JSON.stringify({
            from: full, to: (cwd ? cwd + '/' : '') + to }) }); load(); }
          catch (e) { toast(e.message); }
        };
        const del = el('button', { class: 'ib', title: 'Delete', html: ic('trash', 14) });
        del.onclick = async () => {
          if (!confirm(`Hapus "${it.name}"?`)) return;
          try { await api('/files/delete', { method: 'POST', body: JSON.stringify({ path: full }) });
            load(); } catch (e) { toast(e.message); }
        };
        tb.append(el('tr', {}, el('td', {}, nameCell),
          el('td', { class: 'num', style: 'color:var(--tx-3)' }, it.dir ? '—' : bytes(it.size)),
          el('td', { style: 'color:var(--tx-3)' }, it.mtime ? ago(it.mtime) : '—'),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' },
            it.dir ? '' : dl, rn, del))));
      });
      wrap.replaceChildren(el('div', { class: 'tbl-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Name'),
          el('th', { class: 'num' }, 'Size'), el('th', {}, 'Updated'), el('th', {}, ''))), tb)));
      $('#sub').textContent = `${items.length} item`;
    } catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  liveBadge(15);
  every(load, 15000);
};

/* ═══════════ Uptime monitoring ═══════════ */
VIEWS.monitor = () => {
  const wrap = el('div');
  mount(wrap);
  liveBadge(20);
  addAction('Add check', 'plus', () => form(), 'btn pri');
  addAction('Refresh', 'refresh', () => load());

  function form() {
    const name = el('input', { placeholder: 'My API' });
    const type = el('select', {}, el('option', { value: 'http' }, 'HTTP / HTTPS'),
      el('option', { value: 'tcp' }, 'TCP port'));
    const url = el('input', { placeholder: 'https://example.com/health' });
    const host = el('input', { placeholder: 'db-toko' });
    const port = el('input', { placeholder: '5432', inputmode: 'numeric' });
    const httpF = el('div', { class: 'field' }, el('label', {}, 'URL'), url);
    const tcpF = el('div', { style: 'display:none' },
      el('div', { class: 'field' }, el('label', {}, 'Host'), host),
      el('div', { class: 'field' }, el('label', {}, 'Port'), port));
    type.onchange = () => {
      httpF.style.display = type.value === 'http' ? '' : 'none';
      tcpF.style.display = type.value === 'tcp' ? '' : 'none';
    };
    const save = el('button', { class: 'btn pri' }, 'Save');
    save.onclick = async () => {
      if (!name.value.trim()) return toast('Name is required');
      try {
        await api('/monitor/checks', { method: 'POST', body: JSON.stringify({
          name: name.value, type: type.value, url: url.value,
          host: host.value, port: port.value }) });
        closeDrawer(); toast('Check added'); load();
      } catch (e) { toast(e.message); }
    };
    openDrawer('New uptime check', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Type'), type),
      httpF, tcpF,
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
        'Checked every 60 seconds. HTTP counts any reply below 500 as up; '
        + 'TCP only checks that the port accepts a connection.'),
      el('div', { class: 'row' }, save)));
  }

  const fmtDur = (ms) => {
    const s2 = Math.round(ms / 1000);
    if (s2 < 60) return s2 + 's';
    if (s2 < 3600) return Math.round(s2 / 60) + 'm';
    if (s2 < 86400) return (s2 / 3600).toFixed(1) + 'h';
    return (s2 / 86400).toFixed(1) + 'd';
  };

  function detail(c) {
    const hist = c.hist || [];
    const canvas = el('canvas');
    const outages = [];
    hist.forEach((x, i2) => {
      if (!x.up && (i2 === 0 || hist[i2 - 1].up)) outages.push({ from: x.t, to: x.t });
      else if (!x.up && outages.length) outages[outages.length - 1].to = x.t;
    });
    const rows = outages.slice(-12).reverse().map(o => el('tr', {},
      el('td', { style: 'white-space:nowrap' }, new Date(o.from).toLocaleString('en-GB')),
      el('td', {}, fmtDur(Math.max(o.to - o.from, 60000)))));
    openDrawer(c.name, el('div', {},
      el('div', { class: 'sec', style: 'margin-top:0' }, 'Response time'),
      el('div', { class: 'card' }, el('div', { class: 'card-b' }, canvas)),
      el('div', { class: 'sec' }, 'Recent outages'),
      el('div', { class: 'card' }, rows.length
        ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Started'),
            el('th', {}, 'Duration'))), el('tbody', {}, ...rows))
        : el('div', { class: 'empty', style: 'padding:22px' }, 'No outages recorded')),
      el('div', { class: 'sec' }, 'Target'),
      el('div', { class: 'card' }, el('div', { class: 'card-b mono', style: 'font-size:11.5px' },
        c.type === 'tcp' ? `${c.host}:${c.port}` : c.url))));
    setTimeout(() => chart(canvas, [{ data: hist.map(x => x.ms), color: '#5b8def' }],
      { height: 120, fmt: (v) => Math.round(v) + 'ms' }), 60);
  }

  async function load() {
    try {
      const { checks } = await api('/monitor/checks');
      if (!checks.length) {
        wrap.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'empty', html: ic('pulse', 30, 1.3) +
            '<div>No services monitored</div>' +
            '<div style="font-size:11.5px;margin-top:6px">Add a check to be told the '
            + 'moment something stops answering.</div>' })));
        return;
      }
      const upNow = checks.filter(c => c.up).length;
      const avg24 = (() => {
        const v = checks.map(c => c.w24?.pct).filter(x => x != null);
        return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) + '%' : '—';
      })();
      const summary = el('div', { class: 'grid2', style: 'margin-bottom:14px' },
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'SERVICES UP'),
          el('div', { class: 'v', style: upNow < checks.length ? 'color:var(--bad)' : '' },
            `${upNow}/${checks.length}`),
          el('div', { class: 'm' }, upNow === checks.length ? 'all responding' : 'something is down')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'AVG UPTIME 24H'),
          el('div', { class: 'v' }, avg24), el('div', { class: 'm' }, 'across all checks')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'INCIDENTS 24H'),
          el('div', { class: 'v' }, String(checks.reduce((n, c) => n + (c.w24?.incidents || 0), 0))),
          el('div', { class: 'm' }, 'times a service went down')));

      const cards = el('div', { class: 'grid2' });
      checks.forEach(c => {
        const h = c.hist || [];
        const bars = el('div', { class: 'row',
          style: 'gap:2px;margin-top:12px;height:26px;align-items:flex-end' });
        h.slice(-60).forEach(x => bars.append(el('i', {
          title: new Date(x.t).toLocaleTimeString('en-GB') + ` · ${x.ms} ms`,
          style: `flex:1;height:${x.up ? 100 : 35}%;border-radius:2px;`
            + `background:${x.up ? 'var(--ok)' : 'var(--bad)'};opacity:.9` })));
        const del = el('button', { class: 'ib', title: 'Delete', html: ic('trash', 14) });
        del.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete check "${c.name}"?`)) return;
          await api('/monitor/checks/' + c.id, { method: 'DELETE' }); load();
        };
        const stat = (k, v, sub) => el('div', {},
          el('div', { style: 'font-size:10px;color:var(--tx-3);letter-spacing:.06em;font-weight:600' }, k),
          el('div', { style: 'font-size:16px;font-weight:600;margin-top:2px' }, v),
          sub ? el('div', { style: 'font-size:10.5px;color:var(--tx-3)' }, sub) : '');

        const card = el('div', { class: 'card', style: 'cursor:pointer' });
        card.onclick = () => detail(c);
        card.append(
          el('div', { class: 'card-h' },
            el('i', { class: 'dot ' + (c.up ? 'up' : 'down') }),
            el('h3', {}, c.name), el('span', { class: 'sp' }),
            c.downSince
              ? el('span', { class: 'pill bad' }, 'down for ' + fmtDur(Date.now() - c.downSince))
              : el('span', { class: 'pill ok' }, 'Up'),
            del),
          el('div', { class: 'card-b' },
            el('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap' },
              stat('24 HOURS', (c.w24?.pct ?? '—') + '%', `${c.w24?.incidents ?? 0} incidents`),
              stat('7 DAYS', (c.w7d?.pct ?? '—') + '%', `${c.w7d?.checks ?? 0} checks`),
              stat('RESPONSE', (c.last?.ms ?? '—') + ' ms', `avg ${c.w24?.avgMs ?? '—'} ms`),
              stat('SLOWEST', (c.w24?.maxMs ?? '—') + ' ms', 'last 24h')),
            bars,
            el('div', { class: 'row', style: 'margin-top:8px' },
              el('span', { style: 'font-size:10.5px;color:var(--tx-3)' },
                c.type === 'tcp' ? `${c.host}:${c.port}` : (c.url || '')),
              el('span', { class: 'sp' }),
              el('span', { style: 'font-size:10.5px;color:var(--tx-3)' },
                c.at ? 'checked ' + ago(c.at) : '')),
            c.last?.err ? el('div', { style: 'margin-top:7px;font-size:11px;color:var(--bad);'
              + 'font-family:var(--mono)' }, c.last.err) : ''));
        cards.append(card);
      });
      wrap.replaceChildren(summary, cards);
      $('#sub').textContent = `${upNow}/${checks.length} up`;
    } catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 20000);
};

/* ═══════════ Tema & mulai ═══════════ */
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme:dark)').matches);
  $('#themeBtn').innerHTML = ic(dark ? 'moon' : 'sun', 15);
}
$('#themeBtn').onclick = () => {
  const cur = localStorage.getItem('theme') || 'auto';
  applyTheme(cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto');
};
applyTheme(localStorage.getItem('theme') || 'auto');

// PWA: panel bisa dipasang di layar utama HP dan tetap terbuka saat sinyal hilang.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

$('#burger').onclick = () => $('#side').classList.toggle('open');
addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== page) go(id);
});

/* ═══════════ Gerbang masuk ═══════════ */
function authScreen(mode) {
  document.body.style.display = 'block';
  document.body.style.overflow = 'auto';
  const setup = mode === 'setup';
  const user = el('input', { autocomplete: 'username', autofocus: '' });
  const pass = el('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password' });
  const code = el('input', { placeholder: '000000', inputmode: 'numeric', maxlength: '6' });
  const codeF = el('div', { class: 'field', style: 'display:none' },
    el('label', {}, 'Kode 2FA'), code);
  const err = el('div', { style: 'font-size:12px;color:var(--bad);min-height:17px;margin-bottom:4px' });
  const btn = el('button', { class: 'btn pri', style: 'width:100%;height:33px;justify-content:center' },
    setup ? 'Buat akun & masuk' : 'Masuk');

  const submit = async () => {
    err.textContent = ''; btn.disabled = true;
    try {
      const r = await api(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: user.value, password: pass.value, code: code.value }),
      });
      if (r.need2fa) {
        codeF.style.display = ''; code.focus();
        err.textContent = 'Enter the code from your authenticator app.';
        err.style.color = 'var(--tx-2)';
        return;
      }
      location.reload();
    } catch (e) { err.style.color = 'var(--bad)'; err.textContent = e.message; }
    finally { btn.disabled = false; }
  };
  btn.onclick = submit;
  [user, pass, code].forEach(i => i.addEventListener('keydown', e => e.key === 'Enter' && submit()));

  document.body.replaceChildren(el('div', {
    style: 'min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg)' },
    el('div', { style: 'width:100%;max-width:330px' },
      el('div', { class: 'row', style: 'gap:9px;margin-bottom:18px;justify-content:center' },
        el('div', { class: 'mark', html: ic('lock', 12, 2) }),
        el('div', {}, el('b', { style: 'font-size:13px;display:block' }, 'Home Server'),
          el('span', { style: 'font-size:11px;color:var(--tx-3)' },
            setup ? 'penyiapan pertama' : 'masuk untuk melanjutkan'))),
      el('div', { class: 'card' }, el('div', { class: 'card-b' },
        setup ? el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:12px;line-height:1.6' },
          'Belum ada akun. Buat akun admin sekarang — ini satu-satunya kesempatan tanpa login.') : '',
        el('div', { class: 'field' }, el('label', {}, 'Username'), user),
        el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
        codeF, err, btn)),
      el('div', { style: 'text-align:center;font-size:10.5px;color:var(--tx-3);margin-top:14px' },
        'Repeated failures temporarily block the IP.'))));
  user.focus();
}

api('/auth/state').then(st => {
  if (st.setup) return authScreen('setup');
  if (!st.user) return authScreen('login');
  MY_PERMS = st.user.perms || { all: true, pages: [] };
  window.ALL_PAGES = st.pages || {};
  window.ALL_ROLES = st.roles || {};
  window.ROLE_HELP = st.roleHelp || {};
  window.CAN_WRITE = st.canWrite !== false;
  if (!window.CAN_WRITE) document.body.classList.add('readonly');
  $('#hostLabel').textContent = st.user.username
    + (st.user.role === 'admin' ? '' : ' · ' + st.user.role);
  const out = el('button', { class: 'ib', title: 'Sign out', html: ic('logout', 15) });
  out.onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); };
  $('.side-foot').append(out);
  go(location.hash.slice(1) || 'overview');

  // Lencana notifikasi diperbarui terus, tidak peduli pages mana yang dibuka.
  const badge = () => api('/events?n=1').then(r => {
    const b = document.querySelector('.item[data-id="events"] .badge');
    if (b) b.textContent = r.stats.unread || '';
  }).catch(() => {});
  badge(); setInterval(badge, 20000);
}).catch(() => authScreen('login'));
