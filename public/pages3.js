'use strict';
/* Gelombang 3: Pusat notifikasi + Asisten AI. */

/* ═══════════ Pusat notifikasi ═══════════ */
VIEWS.events = () => {
  let data = { events: [], stats: {}, categories: {} };
  let fCat = '', fSev = '', qText = '';

  const T = tabs([
    { id: 'all', n: 'All', i: 'logs' },
    { id: 'urgent', n: 'Needs action', i: 'pulse' },
    { id: 'settings', n: 'Settings', i: 'cog' },
  ], (id, body) => render(id, body));
  mount(T.node);
  liveBadge(15);

  // Kotak cari ditaruh di #actions (bukan di dalam body tab) supaya tidak
  // ikut dibongkar-pasang tiap render ulang — kalau ikut, fokusnya lepas
  // setiap kali ngetik satu huruf.
  const search = searchBox('Cari event…', v => { qText = v; render(T.current, T.body); });
  $('#actions').append(search);
  addAction('Mark read', 'search', async () => {
    await api('/events/read', { method: 'POST', body: JSON.stringify({}) });
    toast('All ditandai dibaca'); load();
  });
  addAction('Refresh', 'refresh', () => load());

  function render(id, body) {
    if (id === 'settings') return renderSettings(body);
    fSev = id === 'urgent' ? 'urgent' : '';
    renderList(body);
  }

  const SEV = { urgent: ['bad', 'Telegram + web'], info: ['', 'web only'] };

  function renderList(body) {
    const list = data.events.filter(e =>
      (!fCat || e.cat === fCat) && (!fSev || e.sev === fSev) && matches(qText, e.title, e.message));

    const chips = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:12px' });
    const mkChip = (label, val, n) => {
      const c = el('button', { class: 'tg' + (fCat === val ? ' on' : ''),
        style: 'height:25px;font-size:11px' },
        label + (n != null ? ` (${n})` : ''));
      c.onclick = () => { fCat = val; renderList(body); };
      return c;
    };
    chips.append(mkChip('All', '', data.events.length));
    Object.entries(data.categories).forEach(([k, v]) => {
      const n = data.stats.byCat?.[k];
      if (n) chips.append(mkChip(v, k, n));
    });

    if (!list.length) {
      body.replaceChildren(chips, el('div', { class: 'card' },
        el('div', { class: 'empty', html: ic('logs', 30, 1.3) +
          '<div>No events</div>' })));
      return;
    }

    const rows = list.map(e => {
      const tr = el('tr', { style: e.read ? '' : 'background:var(--acc-soft)' },
        el('td', { style: 'white-space:nowrap;color:var(--tx-3)' },
          new Date(e.t).toLocaleString('id-ID', { day: '2-digit', month: 'short',
            hour: '2-digit', minute: '2-digit' })),
        el('td', {}, el('span', { class: 'pill' }, data.categories[e.cat] || e.cat)),
        el('td', {}, el('div', { class: 'row' },
          el('i', { class: 'dot ' + (e.sev === 'urgent' ? 'down' : 'idle') }),
          el('div', {}, el('div', { style: 'font-weight:500' }, e.title),
            el('div', { style: 'font-size:11.5px;color:var(--tx-3)',
              html: e.message || '' })))),
        el('td', {}, el('span', { class: 'pill ' + SEV[e.sev][0] }, SEV[e.sev][1])));
      return tr;
    });

    body.replaceChildren(chips,
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:68vh' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'),
          el('th', {}, 'Category'), el('th', {}, 'Event'), el('th', {}, 'Sent to'))),
          el('tbody', {}, ...rows)))));
  }

  async function renderSettings(body) {
    body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
    const cfg = await api('/events/config');
    const byCat = {};
    cfg.catalog.forEach(c => { (byCat[c.cat] ||= []).push(c); });

    const blocks = Object.entries(byCat).map(([cat, items]) => {
      const tb = el('tbody');
      items.forEach(it => {
        const sel = el('select', { style: 'max-width:150px' },
          el('option', { value: 'urgent' }, 'Telegram + web'),
          el('option', { value: 'info' }, 'Web only'),
          el('option', { value: 'off' }, 'Disable'));
        sel.value = it.cur;
        sel.onchange = async () => {
          try { await api('/events/config', { method: 'POST',
            body: JSON.stringify({ type: it.type, severity: sel.value }) });
            toast('Settings disimpan'); } catch (e) { toast(e.message); }
        };
        tb.append(el('tr', {}, el('td', {}, it.title),
          el('td', { class: 'mono', style: 'color:var(--tx-3);font-size:10.5px' }, it.type),
          el('td', { style: 'width:160px' }, sel)));
      });
      return el('div', {}, el('div', { class: 'sec' }, cfg.categories[cat] || cat),
        el('div', { class: 'card' }, el('table', {}, tb)));
    });

    body.replaceChildren(
      el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:4px;line-height:1.6' },
        'Telegram is only for things needing quick action while you are away. '
        + 'Everything else is recorded here for history without interrupting you.'),
      ...blocks);
  }

  async function load() {
    try {
      data = await api('/events?n=300');
      const unread = data.stats.unread || 0;
      $('#sub').textContent = unread ? `${unread} unread` : 'all read';
      T.setCount('all', data.events.length);
      T.setCount('urgent', data.events.filter(e => e.sev === 'urgent').length);
      if (T.current !== 'settings') render(T.current, T.body);
      const nav = document.querySelector('.item[data-id="events"] .badge');
      if (nav) nav.textContent = unread || '';
    } catch (e) { T.body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 15000);
};

/* ═══════════ Asisten AI ═══════════ */
VIEWS.assistant = () => {
  const log = el('div', { style: 'flex:1;overflow-y:auto;padding:4px 2px 12px' });
  const input = el('textarea', { rows: 2, placeholder: 'Ask about this server…',
    style: 'font-family:inherit;font-size:12.5px' });
  const send = el('button', { class: 'btn pri', html: ic('play', 13) + '<span>Kirim</span>' });
  const wrap = el('div', { style: 'display:flex;flex-direction:column;height:calc(100vh - 118px)' },
    log, el('div', { class: 'row', style: 'align-items:flex-end;gap:8px;padding-top:8px;'
      + 'border-top:1px solid var(--line)' },
      el('div', { style: 'flex:1' }, input), send));
  mount(wrap);

  const messages = [];
  let busy = false;

  const SARAN = [
    'Why does the server feel slow?',
    'Any containers having trouble?',
    'Check server health now',
    'Why is my disk filling up?',
    'Check logs of failing containers',
  ];

  function bubble(role, node) {
    const me = role === 'user';
    return el('div', { style: `display:flex;gap:9px;margin-bottom:14px;`
      + (me ? 'flex-direction:row-reverse' : '') },
      el('div', { style: 'width:24px;height:24px;border-radius:6px;flex:0 0 auto;'
        + `display:grid;place-items:center;font-size:10px;font-weight:600;`
        + (me ? 'background:var(--acc);color:#fff' : 'background:var(--sunken);'
          + 'border:1px solid var(--line);color:var(--tx-2)') },
        me ? 'AH' : el('span', { html: ic('pulse', 13) })),
      el('div', { class: me ? '' : 'card', style: 'max-width:78%;'
        + (me ? 'background:var(--acc);color:#fff;border-radius:9px;padding:9px 12px;font-size:12.5px'
             : 'padding:0') },
        me ? node : el('div', { class: 'card-b', style: 'font-size:12.5px;line-height:1.65' }, node)));
  }

  // Markdown ringan: tebal, kode, dan daftar. Sengaja minimal.
  function fmt(text) {
    const box = el('div');
    String(text).split('\n').forEach(line => {
      if (!line.trim()) { box.append(el('div', { style: 'height:7px' })); return; }
      const d = el('div', { style: /^\s*[-*•]\s/.test(line) ? 'padding-left:13px;text-indent:-9px' : '' });
      let html = esc(line)
        .replace(/`([^`]+)`/g, '<code style="background:var(--sunken);padding:1px 5px;'
          + 'border-radius:4px;font-family:var(--mono);font-size:11.5px">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/^\s*[-*•]\s/, '• ');
      d.innerHTML = html;
      box.append(d);
    });
    return box;
  }

  function proposalCard(p) {
    const b = el('button', { class: 'btn pri', style: 'margin-top:9px' },
      'Approve & run');
    b.onclick = async () => {
      if (!confirm(`Jalankan: ${p.action} ${p.target || ''}?`)) return;
      b.disabled = true; b.textContent = 'Running…';
      try {
        const r = await api('/ai/apply', { method: 'POST',
          body: JSON.stringify({ action: p.action, target: p.target }) });
        b.replaceWith(el('span', { class: 'pill ok' }, r.message));
        toast(r.message);
      } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Try again'; }
    };
    return el('div', { class: 'card', style: 'margin-top:10px;border-color:var(--warn)' },
      el('div', { class: 'card-b' },
        el('div', { class: 'row', style: 'margin-bottom:7px' },
          el('span', { class: 'pill warn' }, 'Proposed action'),
          el('span', { class: 'mono' }, `${p.action} ${p.target || ''}`)),
        el('div', { style: 'font-size:12px;color:var(--tx-2)' }, p.reason),
        p.risk ? el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:5px' },
          'Risk: ' + p.risk) : '', b));
  }

  async function ask(text) {
    if (!text.trim() || busy) return;
    busy = true; send.disabled = true;
    log.append(bubble('user', text));
    messages.push({ role: 'user', content: text });
    input.value = '';
    const thinking = bubble('ai', el('span', { style: 'color:var(--tx-3)' }, 'Checking the server…'));
    log.append(thinking); log.scrollTop = log.scrollHeight;
    try {
      const r = await api('/ai/chat', { method: 'POST', body: JSON.stringify({ messages }) });
      messages.push({ role: 'assistant', content: r.reply });
      const body = el('div', {}, fmt(r.reply));
      if (r.used?.length) {
        body.append(el('div', { style: 'margin-top:9px;display:flex;gap:5px;flex-wrap:wrap' },
          ...[...new Set(r.used)].map(u => el('span', { class: 'pill',
            style: 'font-size:10px' }, u))));
      }
      (r.proposals || []).forEach(p => body.append(proposalCard(p)));
      thinking.replaceWith(bubble('ai', body));
    } catch (e) {
      thinking.replaceWith(bubble('ai', el('div', { style: 'color:var(--bad)' }, e.message)));
    } finally {
      busy = false; send.disabled = false; log.scrollTop = log.scrollHeight; input.focus();
    }
  }

  send.onclick = () => ask(input.value);
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  };

  api('/ai/status').then(st => {
    if (!st.ready) {
      log.append(el('div', { class: 'card' }, el('div', { class: 'card-b' },
        el('div', { style: 'font-weight:600;margin-bottom:6px' }, 'Assistant is not set up'),
        el('div', { style: 'font-size:12.5px;color:var(--tx-2);line-height:1.65' },
          'Open the Vault page and add a secret named '),
        el('div', { class: 'card', style: 'margin:8px 0' },
          el('div', { class: 'card-b mono' }, 'GROQ_API_KEY')),
        el('div', { style: 'font-size:12.5px;color:var(--tx-2)' },
          'with a key from console.groq.com, then reopen this page.'))));
      input.disabled = true; send.disabled = true;
      return;
    }
    log.append(el('div', { style: 'margin-bottom:16px' },
      el('div', { style: 'font-size:12.5px;color:var(--tx-2);line-height:1.65;margin-bottom:10px' },
        'This assistant only covers this server. It can read status, containers, '
        + 'logs and metric history, then propose fixes that you approve '
        + 'before they run.'),
      el('div', { class: 'row', style: 'flex-wrap:wrap' },
        ...SARAN.map(s => {
          const c = el('button', { class: 'btn', style: 'height:26px;font-size:11.5px' }, s);
          c.onclick = () => ask(s);
          return c;
        }))));
  }).catch(() => {});
};
