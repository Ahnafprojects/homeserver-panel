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
  $('#drawer').classList.remove('on', 'wide'); $('#scrim').classList.remove('on');
}
$('#scrim').onclick = closeDrawer;
addEventListener('keydown', e => e.key === 'Escape' && closeDrawer());

// Menu klik-kanan (Files, Code Editor) dulu diposisikan persis di
// e.clientX/clientY tanpa batas — di HP, long-press dekat pinggir layar
// sempit (yang sudah pasti terjadi karena layarnya kecil) bikin menunya
// separuh atau seluruhnya kepotong di luar layar. Geser balik ke dalam
// batas viewport setelah elemennya ke-append (baru ketahuan ukuran aslinya).
function clampMenu(menu) {
  const r = menu.getBoundingClientRect();
  const pad = 8;
  let dx = 0, dy = 0;
  if (r.right > innerWidth - pad) dx = innerWidth - pad - r.right;
  if (r.bottom > innerHeight - pad) dy = innerHeight - pad - r.bottom;
  if (r.left + dx < pad) dx = pad - r.left;
  if (r.top + dy < pad) dy = pad - r.top;
  if (dx) menu.style.left = (r.left + dx) + 'px';
  if (dy) menu.style.top = (r.top + dy) + 'px';
}

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
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  listv: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
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
// Beberapa view push objek { close() } (buat lepas WebSocket/ResizeObserver/
// event listener), bukan cuma ID dari setInterval/setTimeout — tanpa cabang
// ini, clearInterval/clearTimeout diam-diam no-op pada objek biasa dan
// cleanup-nya tidak pernah kepanggil (numpuk tiap pindah-pindah halaman).
const clearTimers = () => { timers.forEach(t => t && typeof t === 'object' ? t.close?.() : (clearInterval(t), clearTimeout(t))); timers = []; };
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

/* ═══════════ Global search (Ctrl/Cmd+K) ═══════════
   Cari lintas stack/container/database/halaman sekaligus, tanpa perlu tau
   dulu di halaman mana sesuatu itu ada. Dibangun sekali (lazy, pas dipakai
   pertama kali), bukan bagian dari VIEWS[] biasa -- ini overlay GLOBAL yang
   harus tetap kepencet dari halaman mana pun, bukan konten satu halaman. */
let searchOverlay = null, searchInput = null, searchResults = null, searchSelIdx = -1, searchDebounce = null;
const SEARCH_ICON = { stack: 'rocket', container: 'box', database: 'db', page: 'chevron' };

function paintSearchSel(items) {
  items.forEach((it, i) => { it.style.background = i === searchSelIdx ? 'var(--surface-2, rgba(255,255,255,.06))' : ''; });
}
function buildSearchPalette() {
  if (searchOverlay) return;
  searchInput = el('input', { placeholder: 'Cari stack, container, database, halaman…',
    style: 'width:100%;font-size:14px;padding:14px 16px;border:none;border-bottom:1px solid var(--line);'
      + 'background:transparent;color:var(--tx);outline:none;box-sizing:border-box' });
  searchResults = el('div', { style: 'max-height:360px;overflow-y:auto' });
  const box = el('div', { style: 'background:var(--surface);border:1px solid var(--line);border-radius:12px;'
    + 'width:min(560px,92vw);margin:12vh auto 0;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden' },
    searchInput, searchResults);
  searchOverlay = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:none' }, box);
  searchOverlay.onclick = (e) => { if (e.target === searchOverlay) closeSearch(); };
  document.body.append(searchOverlay);

  searchInput.oninput = () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(runSearch, 200); };
  searchInput.onkeydown = (e) => {
    const items = [...searchResults.children];
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { searchSelIdx = (searchSelIdx + 1) % items.length; paintSearchSel(items); items[searchSelIdx].scrollIntoView({ block: 'nearest' }); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { searchSelIdx = (searchSelIdx - 1 + items.length) % items.length; paintSearchSel(items); items[searchSelIdx].scrollIntoView({ block: 'nearest' }); } }
    else if (e.key === 'Enter') { e.preventDefault(); items[searchSelIdx]?.click(); }
    else if (e.key === 'Escape') { closeSearch(); }
  };
}
async function runSearch() {
  const term = searchInput.value.trim();
  searchSelIdx = -1;
  if (!term) { searchResults.replaceChildren(); return; }
  try {
    const { results } = await api('/search?q=' + encodeURIComponent(term));
    if (!results.length) {
      searchResults.replaceChildren(el('div', { style: 'padding:16px;color:var(--tx-3);font-size:12.5px' }, 'Tidak ada hasil.'));
      return;
    }
    searchResults.replaceChildren(...results.map((r) => {
      const row = el('div', { class: 'row', style: 'padding:10px 16px;cursor:pointer;gap:10px;border-top:1px solid var(--line)' },
        el('span', { html: ic(SEARCH_ICON[r.type] || 'search', 15) }),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { style: 'font-size:13px' }, r.label),
          r.sub ? el('div', { style: 'font-size:11px;color:var(--tx-3)' }, r.sub) : ''),
        el('span', { class: 'pill' }, r.type));
      row.onclick = () => { closeSearch(); go(r.page); };
      row.onmouseenter = () => { searchSelIdx = [...searchResults.children].indexOf(row); paintSearchSel([...searchResults.children]); };
      return row;
    }));
  } catch { searchResults.replaceChildren(el('div', { style: 'padding:16px;color:var(--bad)' }, 'Gagal mencari.')); }
}
function openSearch() {
  buildSearchPalette();
  searchOverlay.style.display = 'block';
  searchInput.value = ''; searchResults.replaceChildren(); searchSelIdx = -1;
  setTimeout(() => searchInput.focus(), 20);
}
function closeSearch() { if (searchOverlay) searchOverlay.style.display = 'none'; }
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (searchOverlay && searchOverlay.style.display === 'block') closeSearch(); else openSearch();
  }
});
$('#searchBtn')?.addEventListener('click', openSearch);

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
// Kotak cari yang dipakai berulang di tiap pages berisi daftar (container,
// stack, job, dst) — filter jalan di data yang sudah dimuat, tanpa panggil API lagi.
const matches = (q, ...vals) => !q || vals.some(v => String(v ?? '').toLowerCase().includes(q));
function searchBox(ph, onInput) {
  const wrap2 = el('div', { style: 'position:relative;max-width:220px;flex:1;min-width:140px' });
  const inp = el('input', { type: 'search', placeholder: ph,
    style: 'padding-left:30px;width:100%' });
  const icn = el('span', { style: 'position:absolute;left:9px;top:50%;transform:translateY(-50%);'
    + 'color:var(--tx-3);pointer-events:none;display:flex', html: ic('search', 14) });
  wrap2.append(icn, inp);
  inp.oninput = () => onInput(inp.value.trim().toLowerCase());
  return wrap2;
}

/* ═══════════ 1. Ringkasan ═══════════ */
VIEWS.overview = () => {
  const stats = el('div', { class: 'stats' });
  const chartsWrap = el('div', { class: 'grid2' });
  const infoCard = el('div', { class: 'card' });
  // Server nyimpen data detail (5 detik) 4 jam terakhir, plus ringkasan
  // per-jam yang tahan sampai ~2 tahun — biar filter grafik bisa sampai
  // bulan/tahun, bukan cuma jam-jaman.
  const RANGE_LABELS = { '30m': '30 menit', '1h': '1 jam', '4h': '4 jam',
    '1d': '1 hari', '7d': '7 hari', '30d': '1 bulan', '90d': '3 bulan',
    '1y': '1 tahun', custom: 'Custom…' };
  let range = localStorage.getItem('ov.range') || '4h';
  const rangeSel = el('select', { style: 'max-width:120px' },
    ...Object.entries(RANGE_LABELS).map(([k, l]) => el('option', { value: k }, l)));
  rangeSel.value = range;

  const fromInp = el('input', { type: 'datetime-local', style: 'max-width:172px' });
  const toInp = el('input', { type: 'datetime-local', style: 'max-width:172px' });
  const applyCustom = el('button', { class: 'btn', style: 'height:28px;font-size:11.5px' }, 'Terapkan');
  const customBar = el('div', { class: 'row',
    style: `gap:6px;flex-wrap:wrap;display:${range === 'custom' ? 'flex' : 'none'}` },
    fromInp, el('span', { style: 'color:var(--tx-3)' }, '–'), toInp, applyCustom);

  rangeSel.onchange = () => {
    range = rangeSel.value; localStorage.setItem('ov.range', range);
    customBar.style.display = range === 'custom' ? 'flex' : 'none';
    if (range !== 'custom') loadHist();
  };
  applyCustom.onclick = () => {
    if (!fromInp.value || !toInp.value) return toast('Isi tanggal mulai & akhir dulu');
    if (new Date(fromInp.value).getTime() >= new Date(toInp.value).getTime())
      return toast('Rentang tanggal tidak valid');
    loadHist();
  };
  const secTitle = el('div', { class: 'sec', style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
    el('span', {}, 'Riwayat'), el('span', { class: 'sp' }), rangeSel, customBar);

  // ── Proses (Task Manager) — daftar proses HOST asli (bukan proses di
  // dalam container panel), dibaca langsung dari /proc lewat pid:host.
  // Sortable per kolom, bisa dicari, bisa dimatikan.
  let procQ = '', procSort = { key: 'cpu', dir: -1 }, procData = [];
  const procWrap = el('div', { class: 'card' });
  const procSearch = searchBox('Cari proses (nama, perintah, user, PID)…', v => { procQ = v; paintProc(); });
  const procCount = el('span', { class: 'pill' });
  const procSecTitle = el('div', { class: 'sec', style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
    el('span', {}, 'Proses'), procCount, el('span', { class: 'sp' }), procSearch);

  const COLS = [
    { key: 'name', label: 'Proses' }, { key: 'user', label: 'User' },
    { key: 'pid', label: 'PID' }, { key: 'cpu', label: 'CPU%' }, { key: 'rss', label: 'RAM' },
  ];
  function sortHeader(col) {
    const active = procSort.key === col.key;
    const th = el('th', { style: 'cursor:pointer;user-select:none;white-space:nowrap' },
      col.label + (active ? (procSort.dir === 1 ? ' ▲' : ' ▼') : ''));
    th.onclick = () => {
      procSort = { key: col.key, dir: active ? -procSort.dir : (col.key === 'name' || col.key === 'user' ? 1 : -1) };
      paintProc();
    };
    return th;
  }

  async function killProc(pid, name) {
    if (!confirm(`Matikan proses "${name}" (PID ${pid})? Data yang belum tersimpan di proses itu bisa hilang.`)) return;
    try { await api(`/system/processes/${pid}/kill`, { method: 'POST', body: JSON.stringify({ signal: 'TERM' }) });
      toast('Sinyal berhenti terkirim'); loadProc(); } catch (e) { toast(e.message); }
  }

  function paintProc() {
    let shown = procData.filter(p2 => matches(procQ, p2.name, p2.cmd, p2.user, p2.pid));
    const { key, dir } = procSort;
    shown = shown.slice().sort((a, b) => {
      const av = a[key], bv = b[key];
      return typeof av === 'string' ? av.localeCompare(bv) * dir : (av - bv) * dir;
    });
    procCount.textContent = `${shown.length} / ${procData.length} proses`;
    const tb = el('tbody', {}, ...shown.map(p2 => {
      const kill = el('button', { class: 'ib', title: 'Matikan proses', html: ic('trash', 14) });
      kill.onclick = () => killProc(p2.pid, p2.name);
      return el('tr', {},
        el('td', {}, el('div', { title: p2.cmd,
          style: 'max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          p2.name, p2.cmd && p2.cmd !== `[${p2.name}]` && !p2.cmd.startsWith(p2.name)
            ? el('span', { style: 'color:var(--tx-3);margin-left:6px;font-size:11px' }, p2.cmd) : '')),
        el('td', { style: 'color:var(--tx-3)' }, p2.user),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, p2.pid),
        el('td', {}, p2.cpu >= 50 ? el('span', { class: 'pill bad' }, p2.cpu + '%')
          : p2.cpu >= 15 ? el('span', { class: 'pill warn' }, p2.cpu + '%') : p2.cpu + '%'),
        el('td', {}, bytes(p2.rss)),
        el('td', { style: 'text-align:right' }, kill));
    }));
    procWrap.replaceChildren(el('div', { class: 'tbl-wrap' },
      el('table', {}, el('thead', {}, el('tr', {}, ...COLS.map(sortHeader), el('th', {}, ''))), tb)));
  }

  async function loadProc() {
    try { procData = (await api('/system/processes')).processes; paintProc(); }
    catch (e) { procWrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  // Kuota: "kalau SEMUA container kepentok batasnya barengan, laptop ini
  // masih cukup gak?" -- beda dari statistik pemakaian SEKARANG (stats di
  // atas), ini soal ALOKASI (mem_limit/cpus tiap container dijumlah).
  const quotaArea = el('div');
  async function paintQuota() {
    try {
      const r = await api('/resource-quota');
      const memPct = Math.round((r.allocated.mem / r.host.memTotal) * 100);
      const cpuPct = Math.round((r.allocated.cpu / r.host.cpuCores) * 100);
      const bar = (pct) => el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(pct, 100)}%`,
        class: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '' }));
      const row = (label, pct, detail) => el('div', { style: 'padding:9px 0;border-top:1px solid var(--line)' },
        el('div', { class: 'row', style: 'margin-bottom:5px' },
          el('span', { style: 'font-size:12.5px' }, label), el('span', { class: 'sp' }),
          el('span', { style: 'font-size:12.5px;font-weight:600' }, pct + '%')),
        bar(pct), el('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:4px' }, detail));
      quotaArea.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'card-b' },
          row('RAM teralokasi (kalau semua kepentok limit bareng)', memPct,
            `${bytes(r.allocated.mem)} / ${bytes(r.host.memTotal)}`
            + (r.allocated.unlimitedMemCount ? ` — ${r.allocated.unlimitedMemCount} container tanpa limit RAM` : '')),
          row('CPU teralokasi', cpuPct,
            `${r.allocated.cpu.toFixed(1)} / ${r.host.cpuCores} core`
            + (r.allocated.unlimitedCpuCount ? ` — ${r.allocated.unlimitedCpuCount} container tanpa limit CPU` : '')),
          el('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:10px' },
            `Kepake beneran sekarang: ${bytes(r.usedNow.mem)} RAM, ${r.usedNow.cpu.toFixed(1)}% CPU`))));
    } catch (e) { quotaArea.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  const root = el('div', {},
    el('div', { class: 'sec' }, 'Resources'), stats,
    el('div', { class: 'sec' }, 'Kapasitas & alokasi'), quotaArea,
    secTitle, chartsWrap,
    el('div', { class: 'sec' }, 'System'), infoCard,
    procSecTitle, procWrap);
  mount(root);
  every(loadProc, 4000);
  every(paintQuota, 20000);

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

  async function loadHist() {
    try {
      let url;
      if (range === 'custom') {
        if (!fromInp.value || !toInp.value) return;
        const from = new Date(fromInp.value).getTime();
        const to = new Date(toInp.value).getTime();
        if (!(from < to)) return;
        url = `/system/history?from=${from}&to=${to}`;
      } else {
        url = `/system/history?range=${range}`;
      }
      const { points } = await api(url);
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
  }
  every(loadHist, 10000);

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
  let all = [], q = '', showSystem = false;
  const wrap = el('div', { class: 'card' });
  const search = searchBox('Cari container…', v => { q = v; render(); });
  mount(el('div', {}, el('div', { class: 'row', style: 'margin-bottom:10px' }, search), wrap));
  addAction('Refresh', 'refresh', () => load());

  function unlockSystem() {
    const pw = prompt('Container sistem (panel & caddy) disembunyikan supaya tidak gampang ke-klik hapus. '
      + 'Masukkan kata sandi akunmu buat menampilkannya:');
    if (pw === null) return;
    api('/auth/verify', { method: 'POST', body: JSON.stringify({ password: pw }) })
      .then(() => { showSystem = true; render(); })
      .catch(e => toast(e.message));
  }

  async function act(id, what, name) {
    if (what === 'remove' && !confirm(`Hapus container "${name}"? Tindakan ini permanen.`)) return;
    try {
      await api(`/containers/${id}/${what}`, { method: 'POST' });
      toast({ start: 'Dijalankan', stop: 'Dihentikan', restart: 'Di-restart', remove: 'Deleted' }[what]);
      load();
    } catch (e) { toast(e.message); }
  }

  async function load() {
    try { all = (await api('/containers')).containers; render(); }
    catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  function render() {
    try {
      const visible = showSystem ? all : all.filter(c => !c.system);
      const hiddenCount = all.length - visible.length;
      const barStyle = 'padding:9px 14px;font-size:11.5px;color:var(--tx-3);'
        + 'border-bottom:1px solid var(--line)';
      const unlockBar = hiddenCount > 0
        ? (() => {
            const link = el('a', { class: 'row', style: 'cursor:pointer;gap:5px;display:inline-flex;align-items:center',
              html: ic('lock', 12) + `<span>${hiddenCount} container sistem disembunyikan — klik untuk lihat</span>` });
            link.onclick = unlockSystem;
            return el('div', { style: barStyle }, link);
          })()
        : showSystem
        ? (() => {
            const link = el('a', { class: 'row', style: 'cursor:pointer;gap:5px;display:inline-flex;align-items:center',
              html: ic('unlock', 12) + '<span>Sembunyikan lagi container sistem</span>' });
            link.onclick = () => { showSystem = false; render(); };
            return el('div', { style: barStyle }, link);
          })()
        : null;

      const containers = visible.filter(c => matches(q, c.name, c.image));
      if (!containers.length) {
        wrap.replaceChildren(...(unlockBar ? [unlockBar] : []),
          el('div', { class: 'empty', html: ic('box', 30, 1.3)
            + `<div>${visible.length ? 'No matching containers' : 'No containers'}</div>` }));
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
      wrap.replaceChildren(...(unlockBar ? [unlockBar] : []), el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {},
          el('th', {}, 'Containers'), el('th', {}, 'Status'),
          el('th', { class: 'num' }, 'CPU'), el('th', { class: 'num' }, 'Memory'),
          el('th', {}, 'Port'), el('th', {}, ''))), tb)));
      $('#sub').textContent = `${all.filter(c => c.state === 'running').length} dari ${all.length} jalan`;
    } catch (e) {
      wrap.replaceChildren(el('div', { class: 'empty' }, e.message));
    }
  }

  async function detail(c) {
    const body = el('div', {}, el('div', { class: 'empty' }, 'Loading…'));
    openDrawer(c.name, body);
    try {
      const [d, linkRes] = await Promise.all([
        api(`/containers/${c.id}/inspect`),
        api(`/containers/${encodeURIComponent(c.name)}/link`).catch(() => ({ url: null })),
      ]);
      const row = (k, v) => el('tr', {}, el('td', { style: 'color:var(--tx-3);width:36%' }, k),
        el('td', { class: 'mono', style: 'word-break:break-all' }, v ?? '—'));
      const env = (d.Config?.Env || []).map(e => {
        const i = e.indexOf('=');
        const k = e.slice(0, i);
        // Value rahasia disamarkan supaya tidak bocor lewat layar.
        const secret = /pass|secret|token|key|pwd/i.test(k);
        return k + '=' + (secret ? '••••••••' : e.slice(i + 1));
      });

      // ── Port: link lokal langsung ke tiap port yang dipublikasikan ──
      const portRows = (c.ports || []).map(p2 => {
        const [hostPort, contPort] = p2.split(':');
        const url = `http://${location.hostname}:${hostPort}`;
        return el('tr', {}, el('td', { class: 'mono' }, `${hostPort} → ${contPort}`),
          el('td', {}, el('a', { class: 'ib', title: 'Buka ' + url, html: ic('search', 14),
            href: url, target: '_blank' })));
      });
      const portsCard = c.ports?.length
        ? el('div', { class: 'card' }, el('table', {}, el('tbody', {}, ...portRows)))
        : el('div', { class: 'card' }, el('div', { class: 'empty', style: 'padding:16px' },
            'Container ini tidak mempublikasikan port apa pun.'));

      // ── Domain publik: link manual (mis. lewat Cloudflare Tunnel) ──
      const linkArea = el('div');
      function paintLink(url) {
        if (url) {
          const open = el('a', { class: 'btn', title: url,
            html: ic('net', 13) + `<span>${esc(url)}</span>` });
          open.href = url; open.target = '_blank';
          const edit = el('button', { class: 'ib', title: 'Ubah', html: ic('edit', 14) });
          edit.onclick = () => promptLink(url);
          const del = el('button', { class: 'ib', title: 'Hapus', html: ic('trash', 14) });
          del.onclick = async () => {
            await api(`/containers/${encodeURIComponent(c.name)}/link`, { method: 'POST',
              body: JSON.stringify({ url: '' }) });
            paintLink(null);
          };
          linkArea.replaceChildren(el('div', { class: 'row' }, open, edit, del));
        } else {
          const add = el('button', { class: 'btn', html: ic('plus', 13) + '<span>Tambah link publik</span>' });
          add.onclick = () => promptLink('');
          linkArea.replaceChildren(add);
        }
      }
      function promptLink(cur) {
        const url = prompt('URL publik untuk container ini (mis. https://sub.domainmu.com):', cur || 'https://');
        if (url === null) return;
        api(`/containers/${encodeURIComponent(c.name)}/link`, { method: 'POST',
          body: JSON.stringify({ url: url.trim() }) })
          .then(r => paintLink(r.url)).catch(e => toast(e.message));
      }
      paintLink(linkRes.url);

      body.replaceChildren(
        el('div', { class: 'sec' }, 'Umum'),
        el('div', { class: 'card' }, el('table', {}, el('tbody', {},
          row('Name', c.name), row('Image', c.image), row('Status', c.status),
          row('Dibuat', new Date(c.created).toLocaleString('id-ID')),
          row('Restart', d.HostConfig?.RestartPolicy?.Name || '—'),
          row('ID', c.id.slice(0, 12))))),
        ...(c.state === 'running' ? [
          el('div', { class: 'sec' }, 'Grafik custom'),
          customChartBlock((range) => api(`/containers/${c.id}/history?range=${range}`), 'container.chart.' + c.id, {
            metrics: [
              { id: 'mem', label: 'Memory', color: '#5b8def', fmt: (v) => bytes(v) },
              { id: 'cpu', label: 'CPU %', color: '#e5484d', max: 100 },
              { id: 'rx', label: 'Network masuk (per titik)', color: '#3dbb7d', delta: true },
              { id: 'tx', label: 'Network keluar (per titik)', color: '#d99b1c', delta: true },
            ],
            defaultMetrics: ['mem', 'cpu'],
          }),
        ] : []),
        el('div', { class: 'sec' }, 'Port'),
        portsCard,
        el('div', { class: 'sec' }, 'Domain publik'),
        linkArea,
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
  const ALL = '__all__'; // pilihan khusus: search lintas SEMUA container sekaligus

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

  /* Mode "cari di semua container" — beda total dari mode stream biasa:
     bukan nunggu log baru masuk, tapi nge-scan log yang SUDAH ADA di
     semua container sekaligus, ngga ada hasil sampai user beneran ngetik
     query (nyari string kosong di semua container itu berat & ga guna). */
  let searchDebounce = null;
  async function runAllSearch() {
    const term = filter.value.trim();
    if (!term) { box.replaceChildren(el('div', { class: 'empty' },
      'Ketik kata kunci buat nyari di SEMUA container sekaligus (mis. "error", "ECONNREFUSED").')); return; }
    box.replaceChildren(el('div', { class: 'empty' }, 'Nyari…'));
    try {
      const r = await api(`/containers/logs-search?q=${encodeURIComponent(term)}`);
      if (!r.results.length) {
        box.replaceChildren(el('div', { class: 'empty' },
          `Tidak ada hasil di ${r.containersSearched} container yang lagi jalan.`));
        return;
      }
      box.replaceChildren(...r.results.map((res) => {
        const d = el('div', { class: 'l', style: 'display:flex;gap:8px' },
          el('span', { style: 'color:var(--tx-3);white-space:nowrap;font-size:10.5px' },
            (res.t ? new Date(res.t).toLocaleTimeString('id-ID') : '—')),
          el('span', { class: 'pill', style: 'flex-shrink:0' }, res.container));
        const lineSpan = el('span', {});
        const i = res.line.toLowerCase().indexOf(term.toLowerCase());
        if (i >= 0) lineSpan.append(res.line.slice(0, i), el('mark', {}, res.line.slice(i, i + term.length)), res.line.slice(i + term.length));
        else lineSpan.textContent = res.line;
        d.append(lineSpan);
        return d;
      }));
    } catch (e) { box.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  function render() {
    if (sel.value === ALL) return; // ditangani runAllSearch(), bukan di sini
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
  filter.oninput = () => {
    if (sel.value === ALL) {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(runAllSearch, 400);
      return;
    }
    render();
  };

  function connect(id) {
    es?.close(); lines = []; render();
    if (!id || id === ALL) return;
    es = new EventSource(`/api/containers/${id}/logs?tail=300`);
    es.onmessage = e => {
      try { lines.push(JSON.parse(e.data)); } catch {}
      if (lines.length > 5000) lines = lines.slice(-4000);
      render();
    };
    es.onerror = () => { lines.push('— koneksi log terputus —'); render(); };
  }
  sel.onchange = () => {
    if (sel.value === ALL) {
      es?.close(); es = null; lines = [];
      filter.placeholder = 'Cari di semua container… (mis. error)';
      runAllSearch();
      return;
    }
    filter.placeholder = 'Saring baris…';
    connect(sel.value);
  };
  window.__pickLog = id => { sel.value = id; connect(id); };

  api('/containers').then(({ containers }) => {
    sel.replaceChildren(el('option', { value: '' }, 'Pilih container…'),
      el('option', { value: ALL }, '🔍 Cari di semua container'),
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
  let curRoot = 'data';
  let view = localStorage.getItem('files.view') === 'list' ? 'list' : 'grid';
  // Thumbnail (foto/video asli, bukan ikon generik) MATI secara default —
  // server yang generate-nya (ImageMagick/ffmpeg) lumayan berat kalau
  // sekaligus banyak, jadi biar laptop tidak keberatan tiap buka folder,
  // user yang nyalain manual pas memang mau lihat isinya.
  let showThumbs = localStorage.getItem('files.thumbs') === '1';
  // Multi-select: selNames = item yang dicentang, selAnchor = klik terakhir
  // (titik awal buat Shift+klik pilih rentang), lastItems = daftar item yang
  // lagi ditampilkan urut tampilan (dipakai buat hitung rentang & buat Ctrl+A).
  let selNames = new Set();
  let selAnchor = null;
  let lastItems = [];
  let qFilter = '';
  const ROOT_LABELS = { data: 'data', stacks: 'stacks', host: 'laptop (semua file)' };
  const crumb = el('div', { class: 'crumb' });
  const rootSel = el('select', { style: 'max-width:220px' },
    el('option', { value: 'data' }, 'Data (/srv/data)'),
    el('option', { value: 'stacks' }, 'Stacks (/srv/stacks)'),
    el('option', { value: 'host' }, 'Laptop (semua file)'));
  const hostWarn = el('div', { class: 'pill warn', style: 'display:none' },
    '⚠ Ini seluruh filesystem laptop — hati-hati edit/hapus file sistem');
  const btnGrid = el('button', { class: 'ib', title: 'Tampilan ikon', html: ic('grid', 15) });
  const btnList = el('button', { class: 'ib', title: 'Tampilan daftar', html: ic('listv', 15) });
  const viewToggle = el('div', { class: 'row', style: 'gap:2px' }, btnGrid, btnList);
  const btnThumbs = el('button', { class: 'tg',
    title: 'Nyalakan buat lihat foto/video asli sebagai ikon — mati = ikon polos, lebih ringan' },
    'Thumbnail');
  btnThumbs.onclick = () => {
    showThumbs = !showThumbs;
    localStorage.setItem('files.thumbs', showThumbs ? '1' : '0');
    paintThumbsBtn(); renderList(lastItems);
  };
  function paintThumbsBtn() { btnThumbs.classList.toggle('on', showThumbs); }
  paintThumbsBtn();
  const search = searchBox('Cari nama file…', v => { qFilter = v; load(); });
  const tree = el('div', { style: 'width:200px;flex:0 0 200px;overflow:auto;'
    + 'border-right:1px solid var(--line);padding:6px 4px' });
  const wrap = el('div', { class: 'card', style: 'flex:1;min-width:0;overflow:auto;'
    + 'border-radius:0;border:none' });
  // Bar aksi massal — muncul begitu ada item terpilih (klik+Ctrl/Cmd,
  // Shift+klik buat rentang, atau Ctrl/Cmd+A buat pilih semua). Sebelumnya
  // cuma bisa pilih 1 item jadi hapus banyak file harus satu-satu.
  const selCount = el('span', { style: 'font-weight:500' }, '');
  const btnDelSel = el('button', { class: 'btn danger',
    html: ic('trash', 13) + '<span>Hapus</span>' });
  const btnClearSel = el('button', { class: 'btn' }, 'Batal');
  const selBar = el('div', { class: 'row', style: 'padding:8px 14px;border-bottom:1px solid var(--line);'
    + 'background:var(--acc-soft);display:none' },
    selCount, el('span', { class: 'sp' }), btnDelSel, btnClearSel);
  function clearSel() { selNames.clear(); selAnchor = null; paintSel(); renderList(lastItems); }
  function paintSel() {
    selBar.style.display = selNames.size ? 'flex' : 'none';
    selCount.textContent = `${selNames.size} dipilih`;
  }
  btnClearSel.onclick = clearSel;
  btnDelSel.onclick = () => deleteSelected();

  mount(el('div', { style: 'display:flex;flex-direction:column;height:100%;padding:14px 16px' },
    el('div', { class: 'row', style: 'margin-bottom:10px;gap:10px;flex-wrap:wrap;flex:0 0 auto' },
      rootSel, crumb, el('span', { class: 'sp' }), search, hostWarn, btnThumbs, viewToggle),
    selBar,
    el('div', { class: 'card', style: 'display:flex;align-items:stretch;flex:1;min-height:0;overflow:hidden' },
      tree, wrap)), { full: true });
  rootSel.value = curRoot;
  rootSel.onchange = () => { curRoot = rootSel.value; cwd = '';
    hostWarn.style.display = curRoot === 'host' ? '' : 'none'; clearSel(); resetTree(); load(); };

  function setView(v) { view = v; localStorage.setItem('files.view', v);
    const on = (b, is) => { b.style.background = is ? 'var(--acc)' : ''; b.style.color = is ? '#fff' : ''; };
    on(btnGrid, v === 'grid'); on(btnList, v === 'list'); load(); }
  btnGrid.onclick = () => setView('grid');
  btnList.onclick = () => setView('list');
  setView(view);

  const q = (extra = '') => `root=${encodeURIComponent(curRoot)}${extra}`;

  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  // webkitdirectory bikin dialog pilih file jadi "pilih folder" — begitu
  // dipilih, tiap File dapat f.webkitRelativePath ("folder/sub/nama.ext")
  // yang dipakai sebagai nama tujuan supaya struktur foldernya ikut kebawa.
  const folderInput = el('input', { type: 'file', multiple: '',
    webkitdirectory: '', directory: '', style: 'display:none' });
  document.body.append(fileInput, folderInput);

  // Panel progres unggah — tanpa ini layar cuma diam total selama upload
  // (fetch() polos tidak kasih progress apa pun), jadi upload file besar atau
  // folder isi banyak kelihatan kayak macet/hang padahal jalan.
  const upx = el('div', { class: 'upx', style: 'display:none' });
  document.body.append(upx);
  // doneBytes/totalBytes = progres keseluruhan batch dalam byte (dipakai
  // upload, di mana ukuran tiap file diketahui dari awal). doneCount/
  // totalCount dipakai buat label "N/total" dan sebagai fallback persen
  // kalau totalBytes 0 (dipakai hapus massal, yang tidak punya konsep byte).
  let upxN = { doneBytes: 0, totalBytes: 0, doneCount: 0, totalCount: 0, verb: 'Mengunggah' };
  function upxPaint(name, curBytes = 0) {
    const frac = upxN.totalBytes > 0
      ? (upxN.doneBytes + curBytes) / upxN.totalBytes
      : (upxN.totalCount ? upxN.doneCount / upxN.totalCount : 0);
    upx.replaceChildren(
      el('div', { class: 'upx-top' },
        el('span', { class: 'upx-label' },
          `${upxN.verb} ${Math.min(upxN.doneCount + 1, upxN.totalCount)}/${upxN.totalCount}`),
        el('span', { class: 'upx-pct' }, Math.round(frac * 100) + '%')),
      el('div', { class: 'upx-bar' }, el('i', { style: `width:${Math.round(frac * 100)}%` })),
      el('div', { class: 'upx-sub' }, el('b', {}, name),
        el('span', {}, upxN.totalBytes > 0
          ? `${bytes(upxN.doneBytes + curBytes)} / ${bytes(upxN.totalBytes)}` : '')));
  }
  function upxStart(totalCount, totalBytes, verb = 'Mengunggah') {
    upxN = { doneBytes: 0, totalBytes, doneCount: 0, totalCount, verb };
    upx.style.display = ''; upxPaint('Menyiapkan…', 0);
  }
  function upxStop(label) {
    upx.replaceChildren(el('div', { class: 'upx-top' },
      el('span', { class: 'upx-label' }, label || `Selesai · ${upxN.totalCount} berkas`)));
    setTimeout(() => { upx.style.display = 'none'; }, 1200);
  }

  // XHR, bukan fetch() — cuma XHR yang punya event progress upload
  // (xhr.upload.onprogress), yang dipakai buat isi panel di atas.
  function uploadXHR(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
        ? resolve() : reject(new Error('Upload gagal (' + xhr.status + ')'));
      xhr.onerror = () => reject(new Error('Upload gagal — koneksi terputus'));
      xhr.send(file);
    });
  }
  async function uploadInto(destPath, f, relName = f.name) {
    try {
      await uploadXHR(`/api/files/upload?${q()}&path=${encodeURIComponent(destPath)}&name=${encodeURIComponent(relName)}`,
        f, (loaded) => upxPaint(relName, loaded));
    } catch { toast('Gagal mengunggah ' + relName); }
    upxN.doneBytes += f.size; upxN.doneCount++;
  }
  async function uploadAll(destPath, files) {
    upxStart(files.length, files.reduce((s, [f]) => s + f.size, 0));
    for (const [f, rel] of files) await uploadInto(destPath, f, rel);
    upxStop(`Selesai · ${files.length} berkas · ${bytes(upxN.doneBytes)}`); refreshTree(); load();
  }

  async function deleteSelected() {
    const names = [...selNames];
    if (!names.length) return;
    if (!confirm(`Hapus ${names.length} item terpilih? Isi folder ikut terhapus. `
      + 'Tindakan ini tidak bisa dibatalkan.')) return;
    upxStart(names.length, 0, 'Menghapus');
    let failed = 0;
    for (const name of names) {
      upxPaint(name);
      try {
        await api('/files/delete', { method: 'POST',
          body: JSON.stringify({ path: (cwd ? cwd + '/' : '') + name, root: curRoot }) });
      } catch { failed++; }
      upxN.doneCount++;
    }
    upxStop(failed ? `Selesai, ${failed} gagal dihapus` : `Selesai · ${names.length} item dihapus`);
    selNames.clear(); selAnchor = null; paintSel();
    refreshTree(); load();
  }

  fileInput.onchange = async () => {
    await uploadAll(cwd, [...fileInput.files].map((f) => [f, f.name]));
    fileInput.value = '';
  };
  folderInput.onchange = async () => {
    await uploadAll(cwd, [...folderInput.files].map((f) => [f, f.webkitRelativePath || f.name]));
    folderInput.value = '';
  };

  addAction('Unggah', 'up', () => fileInput.click(), 'btn pri');
  addAction('Unggah folder', 'up', () => folderInput.click());
  addAction('Folder baru', 'plus', async () => {
    const name = prompt('Nama folder baru:');
    if (!name) return;
    try { await api('/files/mkdir', { method: 'POST',
      body: JSON.stringify({ path: cwd, name, root: curRoot }) });
      refreshTree(); load(); } catch (e) { toast(e.message); }
  });
  addAction('Refresh', 'refresh', () => { refreshTree(); load(); });

  function setCrumb() {
    const parts = cwd ? cwd.split('/').filter(Boolean) : [];
    crumb.replaceChildren();
    const home = el('a', {}, ROOT_LABELS[curRoot] || curRoot); home.onclick = () => { cwd = ''; load(); };
    crumb.append(home);
    parts.forEach((p, i) => {
      crumb.append(el('span', {}, '/'));
      const a = el('a', {}, p);
      a.onclick = () => { cwd = parts.slice(0, i + 1).join('/'); load(); };
      crumb.append(a);
    });
  }

  // Sebelumnya file apa pun yang bukan gambar dikenal (png/jpg/gif/webp/svg)
  // langsung dibaca sebagai teks UTF-8, berapa pun formatnya — jadi file
  // biner (video .mov, foto HEIC iPhone, dst) muncul sebagai teks acak-acakan
  // (isi header binernya, bukan errornya) di kotak edit. Sekarang dipilah:
  // gambar yang didukung browser → <img>, video/audio → pemutar bawaan
  // browser, format yang browser TIDAK bisa dekode sama sekali (HEIC dst —
  // Firefox/Chrome di Linux tidak punya decoder-nya, beda dari iPhone/Safari)
  // → tawarkan unduh saja daripada nampilin sampah biner.
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
  // HEIC/HEIF (default kamera iPhone) tidak bisa didekode browser mana pun
  // di Linux — bukan cuma kotak file putih kosong lagi, sekarang di-convert
  // ke JPEG di server (ImageMagick + libheif, lihat /api/files/thumb) baik
  // buat thumbnail grid maupun pratinjau penuh di sini.
  const SERVER_IMG_EXT = /\.(heic|heif)$/i;
  const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v|mkv)$/i;
  const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;
  const PDF_EXT = /\.pdf$/i;
  // docx/xlsx/dst juga biner (format ZIP di baliknya) — tanpa ini kena
  // fallback "baca sebagai teks" yang sama seperti bug PDF sebelumnya
  // (sampah/gagal, bukan pesan yang jelas). Browser tidak punya viewer
  // Office bawaan seperti PDF, jadi cukup ditawarkan unduh yang rapi.
  const NO_PREVIEW_EXT = /\.(psd|ai|eps|raw|cr2|nef|dng|arw|zip|rar|7z|tar|gz|bz2|xz|exe|dll|so|bin|iso|apk|dmg|docx?|xlsx?|pptx?|odt|ods|odp)$/i;
  // Buat thumbnail grid/list (server.js /api/files/thumb) — svg/ico sengaja
  // tidak dimasukkan (vektor, sudah kecil & tajam apa adanya). Video ikut
  // (server ambil 1 frame via ffmpeg) — sebelumnya video selalu ikon
  // generik, gak ada bedanya sama file lain yang memang gak bisa di-preview.
  const THUMB_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|mp4|webm|ogv|mov|m4v|mkv)$/i;
  async function open(it) {
    const full = (cwd ? cwd + '/' : '') + it.name;
    if (it.dir) { cwd = full; return load(); }
    const rawUrl = `/api/files/raw?${q()}&path=${encodeURIComponent(full)}`;
    const dlUrl = `/api/files/download?${q()}&path=${encodeURIComponent(full)}`;
    if (IMG_EXT.test(it.name)) {
      return openDrawer(it.name, el('img', { src: rawUrl, style: 'max-width:100%;border-radius:8px' }));
    }
    if (SERVER_IMG_EXT.test(it.name)) {
      return openDrawer(it.name, el('img', {
        src: `/api/files/thumb?${q()}&path=${encodeURIComponent(full)}&size=1600`,
        style: 'max-width:100%;border-radius:8px' }));
    }
    if (VIDEO_EXT.test(it.name)) {
      return openDrawer(it.name, el('video', { src: rawUrl, controls: '', autoplay: 'false',
        style: 'max-width:100%;max-height:70vh;border-radius:8px;display:block' }));
    }
    if (AUDIO_EXT.test(it.name)) {
      return openDrawer(it.name, el('audio', { src: rawUrl, controls: '', style: 'width:100%' }));
    }
    if (PDF_EXT.test(it.name)) {
      // Browser modern punya pembaca PDF bawaan — tinggal arahkan iframe ke
      // berkas mentahnya (raw sudah dukung Range, jadi loncat halaman juga
      // tetap enak buat PDF besar), tidak perlu convert apa pun di server.
      return openDrawer(it.name, el('iframe', { src: rawUrl,
        style: 'width:100%;height:75vh;border:0;border-radius:8px;background:#fff' }));
    }
    if (NO_PREVIEW_EXT.test(it.name)) {
      return openDrawer(it.name, el('div', { class: 'empty' },
        'Browser ini tidak bisa menampilkan pratinjau untuk format ini.',
        el('div', { style: 'margin-top:12px' },
          el('a', { class: 'btn pri', href: dlUrl, download: it.name }, 'Unduh berkas'))));
    }
    if (it.size > 4 * 1024 * 1024) {
      return openDrawer(it.name, el('div', { class: 'empty' },
        'Berkas lebih dari 4 MB — kebesaran untuk dibuka sebagai teks.',
        el('div', { style: 'margin-top:12px' },
          el('a', { class: 'btn pri', href: dlUrl, download: it.name }, 'Unduh berkas'))));
    }
    try {
      const { content } = await api(`/files/read?${q()}&path=${encodeURIComponent(full)}`);
      const ta = el('textarea', { style: 'height:64vh' }); ta.value = content;
      const save = el('button', { class: 'btn pri', html: ic('edit', 14) + '<span>Simpan</span>' });
      save.onclick = async () => {
        try { await api('/files/write', { method: 'POST',
          body: JSON.stringify({ path: full, content: ta.value, root: curRoot }) });
          toast('Saved'); } catch (e) { toast(e.message); }
      };
      // Kotak teks polos di sini gak ada penyorotan sintaks/autocomplete —
      // buat file kode, Code Editor (Monaco, mesin yang sama kayak VS Code)
      // jauh lebih enak dipakai. Titipkan lokasinya lewat sessionStorage lalu
      // pindah halaman; VIEWS.editor baca titipan itu begitu Monaco siap.
      const openInEditor = el('button', { class: 'btn', html: ic('code', 14) + '<span>Buka di Code Editor</span>' });
      openInEditor.onclick = () => {
        sessionStorage.setItem('files.openInEditor', JSON.stringify({ root: curRoot, path: full }));
        go('editor');
      };
      openDrawer(it.name, el('div', {}, ta,
        el('div', { class: 'row', style: 'margin-top:10px' }, save, openInEditor)));
    } catch (e) { toast(e.message); }
  }

  // Telusuri satu entry drag & drop (FileSystemEntry) sampai ke file-file di
  // dalamnya, karena drop folder dari file explorer OS cuma dikasih ke JS
  // lewat DataTransferItem.webkitGetAsEntry() — dataTransfer.files biasa
  // tidak bisa masuk ke isi foldernya sama sekali.
  async function readEntryFiles(entry, prefix = '') {
    if (entry.isFile) {
      return new Promise((res) => entry.file((f) => res([[f, prefix + f.name]]), () => res([])));
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const kids = await new Promise((res) => {
        const all = [];
        const readBatch = () => reader.readEntries((batch) => {
          if (!batch.length) return res(all);
          all.push(...batch); readBatch();
        }, () => res(all));
        readBatch();
      });
      const out = [];
      for (const k of kids) out.push(...await readEntryFiles(k, prefix + entry.name + '/'));
      return out;
    }
    return [];
  }

  // Pindahkan item lewat drag & drop, atau unggah kalau yang di-drop berasal
  // dari luar jendela (file explorer OS). destPath = folder tujuan.
  async function handleDrop(e, destPath) {
    e.preventDefault(); e.stopPropagation();
    const text = e.dataTransfer.getData('text/plain');
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data.from) {
          const to = (destPath ? destPath + '/' : '') + data.from.split('/').pop();
          if (to === data.from || data.from === destPath) return;
          try { await api('/files/rename', { method: 'POST',
            body: JSON.stringify({ from: data.from, to, root: curRoot }) });
            refreshTree(); load(); } catch (err) { toast(err.message); }
          return;
        }
      } catch {}
    }
    const items = e.dataTransfer.items;
    const entries = items?.length ? [...items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean) : [];
    if (entries.length) {
      const files = [];
      for (const en of entries) files.push(...await readEntryFiles(en));
      return uploadAll(destPath, files);
    }
    if (e.dataTransfer.files?.length) {
      return uploadAll(destPath, [...e.dataTransfer.files].map((f) => [f, f.name]));
    }
  }

  // Menu klik-kanan per item — aksi (ganti nama/hapus/unduh) dipindah ke
  // sini karena grid ikon tidak punya ruang buat tombol di tiap baris.
  function itemMenu(e, it, full) {
    document.querySelector('#filemenu')?.remove();
    const menu = el('div', { id: 'filemenu', class: 'card',
      style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:95;`
        + 'min-width:170px;padding:4px;box-shadow:0 8px 24px #0004' });
    const row = (label, fn) => {
      const d = el('div', { class: 'item', style: 'height:30px;font-size:12.5px' }, label);
      d.onclick = () => { menu.remove(); fn(); };
      return d;
    };
    menu.append(row('Buka', () => open(it)));
    if (!it.dir) menu.append(row('Unduh', () =>
      window.open(`/api/files/download?${q()}&path=${encodeURIComponent(full)}`, '_blank')));
    menu.append(row('Ganti nama', async () => {
      const to = prompt('Nama baru:', it.name); if (!to || to === it.name) return;
      try { await api('/files/rename', { method: 'POST', body: JSON.stringify({
        from: full, to: (cwd ? cwd + '/' : '') + to, root: curRoot }) }); refreshTree(); load(); }
      catch (err) { toast(err.message); }
    }));
    menu.append(row('Hapus', async () => {
      if (!confirm(`Hapus "${it.name}"?`)) return;
      try { await api('/files/delete', { method: 'POST',
        body: JSON.stringify({ path: full, root: curRoot }) });
        refreshTree(); load(); } catch (err) { toast(err.message); }
    }));
    document.body.append(menu);
    clampMenu(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  }

  // ── Panel folder (sidebar), kayak Explorer/Finder ──
  const treeState = new Map(); // path -> { expanded, children }
  function getTreeState(path) {
    if (!treeState.has(path)) treeState.set(path, { expanded: false, children: null });
    return treeState.get(path);
  }
  function resetTree() {
    treeState.clear();
    getTreeState('').expanded = true;
    renderTree();
    loadDirs('').then(children => { getTreeState('').children = children; renderTree(); });
  }
  // Refresh isi folder yang lagi kebuka di sidebar tanpa nutup yang lain
  // (dipakai setelah buat/hapus/ganti-nama/pindah, biar state expand tetap).
  async function refreshTree() {
    const open = [...treeState.entries()].filter(([, st]) => st.expanded).map(([p]) => p);
    await Promise.all(open.map(async p => { getTreeState(p).children = await loadDirs(p); }));
    renderTree();
  }
  async function loadDirs(path) {
    try {
      const { items } = await api(`/files/list?${q()}&path=${encodeURIComponent(path)}`);
      return items.filter(it => it.dir);
    } catch { return []; }
  }
  function renderTree() { tree.replaceChildren(treeNode('', ROOT_LABELS[curRoot] || curRoot, 0)); }
  function treeNode(path, name, depth) {
    const st = getTreeState(path);
    const wrapN = el('div', {});
    const row = el('div', { class: 'item' + (cwd === path ? ' on' : ''),
      style: `padding-left:${6 + depth * 14}px;cursor:pointer;position:relative` });
    const chev = el('span', { style: 'width:14px;height:14px;flex:0 0 14px;display:inline-flex;'
      + `transition:transform .12s;transform:rotate(${st.expanded ? 90 : 0}deg)`, html: ic('chevron', 12) });
    row.append(chev, el('span', { style: 'flex:0 0 auto;display:inline-flex;color:var(--acc)', html: ic('fold', 14) }),
      el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name));
    row.onclick = () => { cwd = path; load(); renderTree(); };
    chev.onclick = async (e) => {
      e.stopPropagation();
      st.expanded = !st.expanded;
      if (st.expanded && st.children === null) { st.children = await loadDirs(path); }
      renderTree();
    };
    row.ondragover = (e) => { e.preventDefault(); row.style.background = 'var(--acc-soft)'; };
    row.ondragleave = () => { row.style.background = ''; };
    row.ondrop = (e) => { row.style.background = ''; handleDrop(e, path); };
    wrapN.append(row);
    if (st.expanded && st.children) {
      st.children.forEach(c => wrapN.append(treeNode((path ? path + '/' : '') + c.name, c.name, depth + 1)));
    }
    return wrapN;
  }

  wrap.ondragover = (e) => { e.preventDefault(); wrap.style.background = 'var(--acc-soft)'; };
  wrap.ondragleave = () => { wrap.style.background = ''; };
  wrap.ondrop = (e) => { wrap.style.background = ''; handleDrop(e, cwd); };

  // Thumbnail beneran (lewat /api/files/thumb, lihat server.js) buat file
  // gambar, bukan cuma ikon generik "file" yang sama buat semua jenis
  // berkas — itu yang bikin foto kelihatan kayak kotak putih kosong
  // sebelumnya. Turun ke ikon generik kalau thumbnail-nya gagal dimuat
  // (mis. format aneh yang lolos regex tapi gagal di-convert).
  function iconBox(it, px, iconPx) {
    return el('div', { style: `width:${px}px;height:${px}px;flex:0 0 ${px}px;display:flex;`
      + `align-items:center;justify-content:center;color:${it.dir ? 'var(--acc)' : 'var(--tx-3)'}`,
      html: ic(it.dir ? 'fold' : 'file', iconPx, 1.2) });
  }
  function iconOrThumb(it, full, px, iconPx) {
    if (!showThumbs || it.dir || !THUMB_EXT.test(it.name)) return iconBox(it, px, iconPx);
    const img = el('img', {
      src: `/api/files/thumb?${q()}&path=${encodeURIComponent(full)}&size=${px * 2}`,
      loading: 'lazy', alt: '',
      style: `width:${px}px;height:${px}px;flex:0 0 ${px}px;object-fit:cover;`
        + 'border-radius:6px;display:block' });
    img.onerror = () => img.replaceWith(iconBox(it, px, iconPx));
    return img;
  }

  function itemCell(it, full) {
    const cell = el('div', { title: it.name, draggable: 'true',
      style: view === 'grid'
        ? 'width:104px;display:flex;flex-direction:column;align-items:center;'
          + 'padding:10px 6px;border-radius:8px;cursor:default;text-align:center'
        : 'display:flex;align-items:center;gap:10px;padding:6px 10px;'
          + 'border-radius:6px;cursor:default' });
    if (selNames.has(it.name)) cell.style.background = 'var(--acc-soft)';
    cell.onmouseenter = () => { if (!selNames.has(it.name)) cell.style.background = 'var(--sunken)'; };
    cell.onmouseleave = () => { if (!selNames.has(it.name)) cell.style.background = ''; };
    if (view === 'grid') {
      cell.append(
        iconOrThumb(it, full, 44, 40),
        el('div', { style: 'font-size:11px;margin-top:6px;line-height:1.3;word-break:break-word;'
          + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;'
          + 'max-height:29px;width:100%' }, it.name),
        el('div', { style: 'font-size:9.5px;color:var(--tx-3);margin-top:2px' },
          it.dir ? '' : bytes(it.size)));
    } else {
      cell.append(
        iconOrThumb(it, full, 20, 17),
        el('div', { style: 'flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;'
          + 'white-space:nowrap' }, it.name),
        el('div', { style: 'flex:0 0 70px;font-size:11px;color:var(--tx-3);text-align:right' },
          it.dir ? '' : bytes(it.size)),
        el('div', { style: 'flex:0 0 130px;font-size:11px;color:var(--tx-3);text-align:right' },
          it.mtime ? new Date(it.mtime).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—'));
    }
    // Klik biasa = pilih cuma ini. Ctrl/Cmd+klik = tambah/lepas dari
    // pilihan tanpa buang yang lain. Shift+klik = pilih rentang dari klik
    // terakhir (selAnchor) sampai item ini, kayak Explorer/Finder.
    cell.onclick = (e) => {
      const idx = lastItems.findIndex((x) => x.name === it.name);
      if (e.shiftKey && selAnchor != null) {
        const aIdx = lastItems.findIndex((x) => x.name === selAnchor);
        if (aIdx >= 0 && idx >= 0) {
          const [lo, hi] = aIdx < idx ? [aIdx, idx] : [idx, aIdx];
          selNames = new Set(lastItems.slice(lo, hi + 1).map((x) => x.name));
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (selNames.has(it.name)) selNames.delete(it.name); else selNames.add(it.name);
        selAnchor = it.name;
      } else {
        selNames = new Set([it.name]);
        selAnchor = it.name;
      }
      paintSel(); renderList(lastItems);
    };
    cell.ondblclick = () => open(it);
    cell.oncontextmenu = (e) => {
      e.preventDefault();
      if (!selNames.has(it.name)) {
        selNames = new Set([it.name]); selAnchor = it.name; paintSel(); renderList(lastItems);
      }
      itemMenu(e, it, full);
    };
    cell.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ from: full }));
    };
    if (it.dir) {
      cell.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); cell.style.background = 'var(--acc-soft)'; };
      cell.ondragleave = () => { cell.style.background = selNames.has(it.name) ? 'var(--acc-soft)' : ''; };
      cell.ondrop = (e) => handleDrop(e, full);
    }
    return cell;
  }

  // renderList cuma menggambar ulang dari lastItems (tanpa panggil API lagi)
  // — dipisah dari load() supaya klik pilih/Ctrl+A/Shift+klik terasa
  // instan, bukan nunggu round-trip network tiap kali ganti seleksi.
  function renderList(items, allLen = items.length) {
    if (!items.length) {
      wrap.replaceChildren(el('div', { class: 'empty', html: ic('folder', 30, 1.3)
        + `<div>${allLen ? 'No matching files' : 'Empty folder'}</div>` }));
      $('#sub').textContent = '0 item';
      return;
    }
    const list = el('div', { style: view === 'grid'
      ? 'display:flex;flex-wrap:wrap;gap:2px;padding:14px;align-content:flex-start'
      : 'display:flex;flex-direction:column;padding:8px' });
    if (view === 'list') {
      list.append(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:4px 10px 8px;'
        + 'font-size:10.5px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.03em' },
        el('div', { style: 'flex:0 0 20px' }), el('div', { style: 'flex:1' }, 'Nama'),
        el('div', { style: 'flex:0 0 70px;text-align:right' }, 'Ukuran'),
        el('div', { style: 'flex:0 0 130px;text-align:right' }, 'Diubah')));
    }
    items.forEach(it => list.append(itemCell(it, (cwd ? cwd + '/' : '') + it.name)));
    wrap.replaceChildren(list);
    $('#sub').textContent = `${items.length} item`;
  }

  async function load() {
    setCrumb();
    try {
      const all = (await api(`/files/list?${q()}&path=${encodeURIComponent(cwd)}`)).items;
      const items = qFilter ? all.filter(it => matches(qFilter, it.name)) : all;
      lastItems = items;
      // Item yang dulu terpilih tapi sekarang hilang (dihapus/rename dari
      // tempat lain, atau habis auto-refresh 15 detik) jangan nyangkut di
      // hitungan "N dipilih".
      const names = new Set(items.map(it => it.name));
      let changed = false;
      for (const n of selNames) if (!names.has(n)) { selNames.delete(n); changed = true; }
      if (changed) paintSel();
      renderList(items, all.length);
    } catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  // Ctrl/Cmd+A pilih semua item di folder ini (biar tidak nabrak select-all
  // teks bawaan browser saat fokus lagi di kotak cari/input lain). Esc
  // membatalkan seleksi.
  function onKeydown(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selNames = new Set(lastItems.map(x => x.name));
      selAnchor = lastItems.length ? lastItems[lastItems.length - 1].name : null;
      paintSel(); renderList(lastItems);
    } else if (e.key === 'Escape' && selNames.size) {
      clearSel();
    }
  }
  document.addEventListener('keydown', onKeydown);
  timers.push({ close: () => document.removeEventListener('keydown', onKeydown) });

  resetTree();
  liveBadge(15);
  every(load, 15000);
};

/* ═══════════ Uptime monitoring ═══════════ */
VIEWS.monitor = () => {
  let all = [], q = '';
  const wrap = el('div');
  const search = searchBox('Cari layanan…', v => { q = v; render(); });
  mount(el('div', {}, el('div', { class: 'row', style: 'margin-bottom:10px' }, search), wrap));
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
    const pubToggle = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
    pubToggle.checked = !!c.public;
    pubToggle.onchange = async () => {
      try { await api(`/monitor/checks/${c.id}/public`, { method: 'POST',
        body: JSON.stringify({ public: pubToggle.checked }) });
        toast(pubToggle.checked ? 'Ditampilkan di /status' : 'Disembunyikan dari /status'); load(); }
      catch (e) { toast(e.message); pubToggle.checked = !pubToggle.checked; }
    };
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
        c.type === 'tcp' ? `${c.host}:${c.port}` : c.url)),
      el('div', { class: 'sec' }, 'Halaman status publik'),
      el('div', { class: 'card' }, el('div', { class: 'card-b' },
        el('label', { class: 'row', style: 'cursor:pointer;font-weight:400' },
          pubToggle, el('div', {},
            el('div', { style: 'font-size:12.5px;color:var(--tx)' }, 'Tampilkan di /status'),
            el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
              'Halaman publik cuma nunjukin nama & status up/down — URL/host internal tidak ikut ditampilkan.')))))
    ));
    setTimeout(() => chart(canvas, [{ data: hist.map(x => x.ms), color: '#5b8def' }],
      { height: 120, fmt: (v) => Math.round(v) + 'ms' }), 60);
  }

  async function load() {
    try { all = (await api('/monitor/checks')).checks; render(); }
    catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  function render() {
    try {
      if (!all.length) {
        wrap.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'empty', html: ic('pulse', 30, 1.3) +
            '<div>No services monitored</div>' +
            '<div style="font-size:11.5px;margin-top:6px">Add a check to be told the '
            + 'moment something stops answering.</div>' })));
        return;
      }
      const checks = all.filter(c => matches(q, c.name, c.url, c.host));
      const upNow = all.filter(c => c.up).length;
      const avg24 = (() => {
        const v = all.map(c => c.w24?.pct).filter(x => x != null);
        return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) + '%' : '—';
      })();
      const summary = el('div', { class: 'grid2', style: 'margin-bottom:14px' },
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'SERVICES UP'),
          el('div', { class: 'v', style: upNow < all.length ? 'color:var(--bad)' : '' },
            `${upNow}/${all.length}`),
          el('div', { class: 'm' }, upNow === all.length ? 'all responding' : 'something is down')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'AVG UPTIME 24H'),
          el('div', { class: 'v' }, avg24), el('div', { class: 'm' }, 'across all checks')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'INCIDENTS 24H'),
          el('div', { class: 'v' }, String(all.reduce((n, c) => n + (c.w24?.incidents || 0), 0))),
          el('div', { class: 'm' }, 'times a service went down')));

      if (!checks.length) {
        wrap.replaceChildren(summary, el('div', { class: 'card' },
          el('div', { class: 'empty', html: ic('search', 30, 1.3) + '<div>No matching services</div>' })));
        $('#sub').textContent = `${upNow}/${all.length} up`;
        return;
      }
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
      $('#sub').textContent = `${upNow}/${all.length} up`;
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
// Sebelumnya update JS/CSS panel sering "tidak kelihatan" walau server sudah
// dideploy ulang — Service Worker punya cache sendiri (Cache Storage) yang
// TIDAK dipengaruhi header Cache-Control biasa. clientsClaim di sw.js sudah
// bikin worker baru langsung ambil alih, tapi TAB yang sudah kebuka duluan
// baru kepakai worker baru itu begitu ada fetch berikutnya — auto-reload di
// bawah ini yang benar-benar menutup celahnya (sekali saja, bukan reload
// berulang) begitu worker baru itu resmi aktif jadi controller tab ini.
if ('serviceWorker' in navigator) {
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Cek versi baru tiap kali tab ini kelihatan lagi (pindah tab balik,
      // buka dari background) — bukan cuma sekali pas load pertama.
      addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

// Tombol manual buat kasus service worker/cache-nya kepentok aneh dan
// auto-reload di atas tidak cukup — bersihkan semuanya sampai bersih
// (unregister worker + hapus semua Cache Storage), lalu muat ulang penuh.
const clearCacheBtn = $('#clearCacheBtn');
if (clearCacheBtn) {
  clearCacheBtn.innerHTML = ic('refresh', 15);
  clearCacheBtn.onclick = async () => {
    clearCacheBtn.disabled = true;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {}
    location.reload();
  };
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

/* Wizard onboarding -- muncul sekali abis akun pertama dibuat, nuntun
   admin ngisi hal-hal opsional (Telegram, Google Drive backup, deploy
   stack pertama) supaya template ini kepake beneran tanpa baca dokumen. */
function showSetupWizard(status) {
  const step = (title, doneNow, body) => el('div', { style: 'margin-bottom:22px' },
    el('div', { style: 'font-size:13px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:8px' },
      el('span', { style: `width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:none;background:${doneNow ? 'var(--good)' : 'var(--bg-3)'};color:${doneNow ? '#fff' : 'var(--tx-3)'}` },
        doneNow ? '✓' : ''),
      title),
    body);

  const tgToken = el('input', { placeholder: 'Bot token dari @BotFather' });
  const tgChat = el('input', { placeholder: 'Chat ID (bisa dari @userinfobot)' });
  const tgSave = el('button', { class: 'btn pri' }, 'Simpan & tes');
  tgSave.onclick = async () => {
    if (!tgToken.value.trim() || !tgChat.value.trim()) return toast('Isi token & chat ID dulu');
    tgSave.disabled = true;
    try {
      await api('/telegram/config', { method: 'POST', body: JSON.stringify({ token: tgToken.value.trim(), chat: tgChat.value.trim() }) });
      await api('/telegram/test', { method: 'POST' });
      toast('Tersambung — cek pesan tes di Telegram');
    } catch (e) { toast(e.message); } finally { tgSave.disabled = false; }
  };

  const wizBody = el('div', {},
    el('div', { style: 'font-size:12.5px;color:var(--tx-3);margin-bottom:18px;line-height:1.6' },
      'Panel ini sudah bisa dipakai sekarang. Bagian di bawah opsional — lewati kapan saja, bisa diisi belakangan lewat Settings / Vault & Backups.'),
    step('Notifikasi Telegram', status.telegram,
      status.telegram
        ? el('div', { style: 'font-size:12px;color:var(--good)' }, 'Sudah tersambung.')
        : el('div', { class: 'row' }, tgToken, tgChat, tgSave)),
    step('Cadangan ke Google Drive', status.gdrive,
      status.gdrive
        ? el('div', { style: 'font-size:12px;color:var(--good)' }, 'Sudah tersambung.')
        : el('div', {}, el('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:8px' },
            'Setup lengkap (Client ID/Secret + hubungkan akun) ada di halaman Vault & Backups.'),
          (() => { const b = el('button', { class: 'btn' }, 'Buka Vault & Backups'); b.onclick = () => { closeDrawer(); go('vault'); }; return b; })())),
    step('Deploy stack pertama', status.stacks,
      status.stacks
        ? el('div', { style: 'font-size:12px;color:var(--good)' }, `${status.stacks ? 'Sudah ada stack berjalan.' : ''}`)
        : el('div', {}, el('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:8px' },
            'Deploy container pertama dari docker-compose.yml atau clone dari repo Git di halaman Stacks.'),
          (() => { const b = el('button', { class: 'btn' }, 'Buka Stacks'); b.onclick = () => { closeDrawer(); go('stacks'); }; return b; })())),
    el('div', { class: 'row', style: 'margin-top:8px' },
      (() => {
        const b = el('button', { class: 'btn' }, 'Jangan tampilkan lagi');
        b.onclick = async () => { await api('/setup/dismiss', { method: 'POST' }).catch(() => {}); closeDrawer(); };
        return b;
      })()));
  openDrawer('Selamat datang — setup awal', wizBody);
  $('#drawer').classList.add('wide');
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

  // Wizard setup pertama kali -- cuma buat admin, cuma kalau belum ditutup
  // dan masih ada langkah opsional yang belum dikerjakan.
  if (st.user.role === 'superadmin' || st.user.role === 'admin') {
    api('/setup/status').then((s) => {
      if (s.dismissed) return;
      if (s.telegram && s.gdrive && s.stacks) return;
      showSetupWizard(s);
    }).catch(() => {});
  }

  // Lencana notifikasi diperbarui terus, tidak peduli pages mana yang dibuka.
  const badge = () => api('/events?n=1').then(r => {
    const b = document.querySelector('.item[data-id="events"] .badge');
    if (b) b.textContent = r.stats.unread || '';
  }).catch(() => {});
  badge(); setInterval(badge, 20000);
}).catch(() => authScreen('login'));
