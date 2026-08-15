'use strict';
/* Gelombang 4: Domain & SSL, pencarian global, ambang peringatan,
   pemulihan cadangan, dan pengubahan data basis data. */

/* ═══════════ Domain & reverse proxy ═══════════ */
VIEWS.domains = () => {
  let data = { sites: [], certs: [], caddy: null, config: '' };
  let qText = '';

  const T = tabs([
    { id: 'list', n: 'Domain', i: 'net' },
    { id: 'config', n: 'Configuration', i: 'logs' },
  ], (id, body) => id === 'list' ? renderList(body) : renderConfig(body));
  mount(T.node);
  liveBadge(30);
  // Persisten di #actions supaya fokus kotak cari tidak lepas tiap render ulang.
  const search = searchBox('Search domains…', v => { qText = v; if (T.current === 'list') renderList(T.body); });
  $('#actions').append(search);
  addAction('Add domain', 'plus', () => form(), 'btn pri');
  addAction('Refresh', 'refresh', () => load());

  function form() {
    const domain = el('input', { placeholder: 'api.domainku.com' });
    const target = el('input', { placeholder: 'nama-container' });
    const port = el('input', { placeholder: '3000', inputmode: 'numeric' });
    const email = el('input', { placeholder: 'kamu@email.com' });
    const dnsMsg = el('div', { style: 'font-size:11.5px;margin-bottom:10px;min-height:16px' });

    const cek = el('button', { class: 'btn' }, 'Check DNS');
    cek.onclick = async () => {
      if (!domain.value.trim()) return;
      dnsMsg.textContent = 'Checking…'; dnsMsg.style.color = 'var(--tx-3)';
      try {
        const r = await api('/sites/dns?domain=' + encodeURIComponent(domain.value.trim()));
        if (!r.resolved.length) {
          dnsMsg.style.color = 'var(--bad)';
          dnsMsg.textContent = 'Domain does not resolve yet. Add an A record first.';
        } else if (r.match) {
          dnsMsg.style.color = 'var(--ok)';
          dnsMsg.textContent = `Correct — points to ${r.publicIp}.`;
        } else {
          dnsMsg.style.color = 'var(--warn)';
          dnsMsg.textContent = `Points to ${r.resolved.join(', ')}, `
            + `while the server public IP is ${r.publicIp || 'unknown'}.`;
        }
      } catch (e) { dnsMsg.style.color = 'var(--bad)'; dnsMsg.textContent = e.message; }
    };

    const b = el('button', { class: 'btn pri' }, 'Add & apply');
    b.onclick = async () => {
      try {
        b.disabled = true;
        const r = await api('/sites', { method: 'POST', body: JSON.stringify({
          domain: domain.value.trim(), target: target.value.trim(),
          port: port.value || 80, email: email.value.trim() }) });
        closeDrawer();
        toast(r.warning ? r.warning : 'Domain added');
        load();
      } catch (e) { toast(e.message); } finally { b.disabled = false; }
    };

    openDrawer('Add domain', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Domain'), domain),
      el('div', { class: 'row', style: 'margin-bottom:8px' }, cek),
      dnsMsg,
      el('div', { class: 'field' }, el('label', {}, 'Target container'), target),
      el('div', { class: 'field' }, el('label', {}, 'Port inside container'), port),
      el('div', { class: 'field' }, el('label', {}, "Admin email (for Let's Encrypt)"), email),
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
        'HTTPS certificate is issued automatically once the domain points to this server. '
        + "Ports 80 and 443 must be reachable from the internet — if you're using Cloudflare "
        + 'Tunnel like this panel does, new domains must also be added to the tunnel config, '
        + 'not just here. '
        + 'Domains ending in .local or .test use an internal certificate (no internet needed).'),
      el('div', { class: 'row' }, b)));
  }

  function renderList(body) {
    const c = data.caddy;
    const head = el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('span', { class: 'pill ' + (c?.running ? 'ok' : 'bad') },
        c?.running ? 'Caddy running' : 'Caddy not running'),
      el('span', { class: 'pill' }, `${data.sites.length} domain`));

    if (!c?.running) {
      head.append(el('span', { style: 'font-size:11.5px;color:var(--tx-3)' },
        `container "${c?.container || 'caddy'}" missing`));
    }

    if (!data.sites.length) {
      body.replaceChildren(head, el('div', { class: 'card' }, el('div', { class: 'empty',
        html: ic('net', 30, 1.3) + '<div>No domains yet</div>'
          + '<div style="font-size:11.5px;margin-top:6px">Tambahkan domain untuk mengakses '
          + 'aplikasi lewat alamat sendiri, bukan nomor port.</div>' })));
      return;
    }

    const sites = data.sites.filter(s => matches(qText, s.domain, s.target));
    if (!sites.length) {
      body.replaceChildren(head, el('div', { class: 'card' },
        el('div', { class: 'empty', html: ic('search', 30, 1.3) + '<div>No matching domains</div>' })));
      return;
    }

    const tb = el('tbody');
    sites.forEach(s => {
      const cert = data.certs.find(x => x.domain === s.domain);
      const days = cert?.daysLeft;
      const certPill = cert?.kind === 'internal'
        ? el('span', { class: 'pill' }, 'internal')
        : days == null ? el('span', { class: 'pill' }, 'not issued')
        : el('span', { class: 'pill ' + (days <= 3 ? 'bad' : days <= 14 ? 'warn' : 'ok') },
            `${days} days left`);
      const del = el('button', { class: 'ib', html: ic('trash', 14) });
      del.onclick = async () => {
        if (!confirm(`Hapus domain ${s.domain}?`)) return;
        try { await api('/sites/' + s.id, { method: 'DELETE' });
          toast('Deleted'); load(); } catch (e) { toast(e.message); }
      };
      const open = el('a', { class: 'ib', title: 'Buka', html: ic('search', 14),
        href: 'https://' + s.domain, target: '_blank' });
      tb.append(el('tr', {},
        el('td', { class: 'mono' }, s.domain),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, `${s.target}:${s.port}`),
        el('td', {}, certPill),
        el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, open, del))));
    });
    body.replaceChildren(head,
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Domain'),
          el('th', {}, 'Forwards to'), el('th', {}, 'Certificate'), el('th', {}, ''))), tb))));
  }

  function renderConfig(body) {
    const apply = el('button', { class: 'btn pri', html: ic('refresh', 13) + '<span>Apply again</span>' });
    apply.onclick = async () => {
      try { const r = await api('/sites/apply', { method: 'POST' });
        toast(r.ok ? 'Configuration reloaded' : (r.warning || 'Failed: ' + (r.message || ''))); }
      catch (e) { toast(e.message); }
    };
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { style: 'font-size:11.5px;color:var(--tx-3)' },
          'This file is generated from the domain list.'),
        el('span', { class: 'sp' }), apply),
      el('div', { class: 'card' }, el('div', { class: 'card-b mono',
        style: 'white-space:pre-wrap;font-size:11.5px;max-height:64vh;overflow:auto' },
        data.config || '(kosong)')));
  }

  async function load() {
    try {
      data = await api('/sites');
      T.setCount('list', data.sites.length);
      const soon = data.certs.filter(c => c.daysLeft != null && c.daysLeft <= 14).length;
      $('#sub').textContent = soon ? `${soon} certificates expiring soon` : '';
      T.current === 'list' ? renderList(T.body) : renderConfig(T.body);
    } catch (e) { T.body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 30000);
};

/* ═══════════ Pencarian global (Ctrl/Cmd + K) ═══════════ */
(function globalSearch() {
  const overlay = el('div', { style: 'position:fixed;inset:0;z-index:90;background:#0008;'
    + 'display:none;align-items:flex-start;justify-content:center;padding-top:14vh' });
  const input = el('input', { placeholder: 'Search containers, stacks, domains, pages…',
    style: 'height:38px;font-size:13.5px;border:0;border-bottom:1px solid var(--line);'
      + 'border-radius:0;background:transparent' });
  const results = el('div', { style: 'max-height:52vh;overflow-y:auto;padding:6px' });
  const box = el('div', { class: 'card', style: 'width:min(560px,92vw);overflow:hidden' },
    el('div', { style: 'padding:0 12px' }, input), results);
  overlay.append(box);
  document.body.append(overlay);

  let items = [];
  const close = () => { overlay.style.display = 'none'; input.value = ''; };
  overlay.onclick = (e) => e.target === overlay && close();

  async function build() {
    const out = PAGES.flatMap(g => g.items).map(p => ({
      label: p.n, sub: 'Page', icon: p.i, go: () => go(p.id) }));
    const [c, s, d] = await Promise.all([
      api('/containers').catch(() => null),
      api('/stacks').catch(() => null),
      api('/sites').catch(() => null)]);
    c?.containers.forEach(x => out.push({ label: x.name,
      sub: `Container · ${x.state}`, icon: 'box',
      go: () => { go('containers'); } }));
    s?.stacks.forEach(x => out.push({ label: x.name, sub: 'Stack', icon: 'rocket',
      go: () => go('stacks') }));
    d?.sites.forEach(x => out.push({ label: x.domain, sub: 'Domain', icon: 'net',
      go: () => go('domains') }));
    items = out;
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const list = (q ? items.filter(i => i.label.toLowerCase().includes(q)
      || i.sub.toLowerCase().includes(q)) : items).slice(0, 14);
    results.replaceChildren(...(list.length ? list.map((i, idx) => {
      const r = el('div', { class: 'item' + (idx === 0 ? ' on' : ''),
        style: 'height:34px', html: ic(i.icon || 'search', 14)
          + `<span>${esc(i.label)}</span>` });
      r.append(el('span', { class: 'badge', style: 'margin-left:auto' }, i.sub));
      r.onclick = () => { close(); i.go(); };
      return r;
    }) : [el('div', { class: 'empty', style: 'padding:26px' }, 'No results')]));
  }
  input.oninput = render;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { const f = results.querySelector('.item'); f?.click(); }
  };

  addEventListener('keydown', async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!document.querySelector('aside')) return;
      overlay.style.display = 'flex';
      input.focus();
      if (!items.length) await build();
      render();
    }
  });
})();

/* ═══════════ Tambahan pada pages lain ═══════════ */

/* Alert thresholds — disisipkan ke Pengrules. */
async function thresholdCard() {
  const t = await api('/thresholds');
  const f = {};
  const row = (k, label, unit, hint) => {
    f[k] = el('input', { type: 'number', value: t[k], style: 'max-width:110px' });
    return el('tr', {}, el('td', {}, el('div', {}, label,
      el('div', { style: 'font-size:11px;color:var(--tx-3)' }, hint))),
      el('td', { style: 'width:150px' }, el('div', { class: 'row' }, f[k],
        el('span', { style: 'color:var(--tx-3);font-size:11.5px' }, unit))));
  };
  const save = el('button', { class: 'btn pri' }, 'Save thresholds');
  save.onclick = async () => {
    const body = {};
    Object.entries(f).forEach(([k, i]) => body[k] = +i.value);
    try { await api('/thresholds', { method: 'POST', body: JSON.stringify(body) });
      toast('Thresholds saved'); } catch (e) { toast(e.message); }
  };
  return el('div', {}, el('div', { class: 'sec' }, 'Alert thresholds'),
    el('div', { class: 'card' },
      el('table', {}, el('tbody', {},
        row('disk', 'Disk full', '%', 'warn when usage goes above this'),
        row('memory', 'Memory', '%', ''),
        row('cpu', 'CPU', '%', ''),
        row('temp', 'CPU temperature', '°C', 'important for an old laptop'),
        row('swap', 'Swap', '%', ''),
        row('slowMs', 'Slow response', 'ms', 'a service counts as slow above this'))),
      el('div', { class: 'card-b' }, save)));
}

/* Pemulihan cadangan — disisipkan ke pages Brankas. */
function restoreButton(b2, reload) {
  const btn = el('button', { class: 'ib', title: 'Restore', html: ic('restart', 14) });
  btn.onclick = () => {
    const isDb = b2.name.startsWith('db-');
    const isVol = b2.name.startsWith('volume-');
    const cont = el('input', { placeholder: isDb ? 'nama container basis data' : 'nama volume' });
    const user = el('input', { value: 'postgres' });
    const go2 = el('button', { class: 'btn pri danger' }, 'Restore sekarang');
    go2.onclick = async () => {
      if (!confirm('Restoring will OVERWRITE current data. Continue?')) return;
      go2.disabled = true; go2.textContent = 'Restoring…';
      try {
        const r = await api('/backups/restore', { method: 'POST', body: JSON.stringify({
          name: b2.name, container: cont.value, volume: cont.value, user: user.value }) });
        toast(r.message); closeDrawer(); reload?.();
      } catch (e) { toast(e.message); go2.disabled = false; go2.textContent = 'Try again'; }
    };
    openDrawer('Restore — ' + b2.name, el('div', {},
      el('div', { style: 'font-size:12.5px;color:var(--tx-2);margin-bottom:12px;line-height:1.6' },
        'Current data will be overwritten by this backup. '
        + 'This cannot be undone.'),
      (isDb || isVol) ? el('div', { class: 'field' },
        el('label', {}, isDb ? 'Database container' : 'Target volume'), cont) : '',
      isDb ? el('div', { class: 'field' }, el('label', {}, 'Database user'), user) : '',
      el('div', { class: 'row' }, go2)));
  };
  return btn;
}
