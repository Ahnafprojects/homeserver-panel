'use strict';
/* Gelombang 2: Sistem (layanan, pembaruan, firewall, jaringan, pengguna),
   Penjadwal, Brankas, dan Backup. */

/* Aliran log SSE dalam laci — dipakai apt & tugas panjang. */
function sseDrawer(url, title, opts = {}) {
  const box = el('div', { class: 'logbox', style: 'height:70vh' });
  openDrawer(title, box);
  const add = (t, color) => {
    box.append(el('span', { class: 'l', style: color ? `color:${color}` : '' }, t));
    box.scrollTop = box.scrollHeight;
  };
  const es = new EventSource(url);
  es.onmessage = e => { try { add(JSON.parse(e.data)); } catch { add(e.data); } };
  es.addEventListener('done', e => {
    const c = +e.data;
    add(c === 0 ? '\n✓ selesai' : `\n✗ failed (kode ${c})`,
      c === 0 ? 'var(--ok)' : 'var(--bad)');
    es.close(); opts.after?.(c);
  });
  es.onerror = () => es.close();
}

/* ═══════════ Sistem ═══════════ */
VIEWS.system = () => {
  let data = { services: [], updates: null, fw: null, net: null, users: [] };
  let filter = '';

  function render(id, body) {
    const f = { services: renderServices, updates: renderUpdates, firewall: renderFirewall,
      network: renderNetwork, users: renderUsers }[id];
    try { f(body); }
    catch (e) { body.replaceChildren(el('div', { class: 'empty' }, 'Render failed: ' + e.message)); }
  }

  const T = tabs([
    { id: 'services', n: 'Services', i: 'cog' },
    { id: 'updates', n: 'Updates', i: 'down' },
    { id: 'firewall', n: 'Firewall', i: 'lock' },
    { id: 'network', n: 'Network', i: 'net' },
    { id: 'users', n: 'Users', i: 'term' },
  ], (id, body) => render(id, body));
  mount(T.node);
  liveBadge(30);
  addAction('Refresh', 'refresh', () => load());

  /* ── Services ── */
  function renderServices(body) {
    if (!data.ready) return body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
    if (!data.services.length) return body.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        'systemd is not available on this machine. On the Linux Mint server the service list appears here.')));
    const search = el('input', { placeholder: 'Search services…', value: filter, style: 'max-width:240px' });
    search.oninput = () => { filter = search.value; renderServices(body); search.focus(); };
    const list = data.services.filter(s =>
      !filter || s.name.toLowerCase().includes(filter.toLowerCase()) ||
      (s.desc || '').toLowerCase().includes(filter.toLowerCase()));
    const jalan = data.services.filter(s => s.active === 'active').length;

    const tb = el('tbody');
    list.slice(0, 400).forEach(s => {
      const act = (label, a, icon) => {
        const b = el('button', { class: 'ib', title: label, html: ic(icon, 14) });
        b.onclick = async () => {
          if (!confirm(`${label} layanan ${s.name}?`)) return;
          try { await api(`/admin/services/${encodeURIComponent(s.name)}/${a}`, { method: 'POST' });
            toast('Done'); load(); } catch (e) { toast(e.message); }
        };
        return b;
      };
      const on = s.active === 'active';
      tb.append(el('tr', {},
        el('td', {}, el('div', { class: 'row' },
          el('i', { class: 'dot ' + (on ? 'up' : s.active === 'failed' ? 'down' : 'idle') }),
          el('div', {}, el('div', { class: 'mono' }, s.name.replace(/\.service$/, '')),
            el('div', { style: 'font-size:10.5px;color:var(--tx-3);max-width:44ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.desc || '')))),
        el('td', {}, el('span', { class: 'pill ' + (on ? 'ok' : s.active === 'failed' ? 'bad' : '') }, s.active)),
        el('td', { style: 'color:var(--tx-3)' }, s.sub),
        el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' },
          on ? act('Stop', 'stop', 'stop') : act('Run', 'start', 'play'),
          act('Restart', 'restart', 'restart')))));
    });
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('div', { style: 'max-width:260px;flex:1' }, search),
        el('span', { class: 'pill ok' }, `${jalan} active`),
        el('span', { class: 'pill' }, `${data.services.length} total`)),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Services'),
          el('th', {}, 'Status'), el('th', {}, 'Sub'), el('th', {}, ''))), tb))));
  }

  /* ── Updates ── */
  function renderUpdates(body) {
    const u = data.updates;
    const cek = el('button', { class: 'btn', html: ic('refresh', 13) + '<span>Check</span>' });
    cek.onclick = () => sseDrawer('/api/admin/apt/update', 'Checking for updates',
      { after: () => load() });
    const up = el('button', { class: 'btn pri', html: ic('down', 13) + '<span>Update all</span>' });
    up.onclick = () => {
      if (!confirm('Install semua pembaruan sekarang?')) return;
      sseDrawer('/api/admin/apt/upgrade', 'Installing updates', { after: () => load() });
    };
    const inst = el('button', { class: 'btn', html: ic('plus', 13) + '<span>Install package</span>' });
    inst.onclick = () => {
      const n = el('input', { placeholder: 'htop' });
      const b = el('button', { class: 'btn pri' }, 'Install');
      b.onclick = () => { if (!n.value.trim()) return;
        sseDrawer('/api/admin/apt/install?pkg=' + encodeURIComponent(n.value.trim()),
          'Installing ' + n.value.trim(), { after: () => load() }); };
      openDrawer('Install package', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Package name'), n),
        el('div', { class: 'row' }, b)));
    };

    const tb = el('tbody', {}, ...(u?.packages || []).map(pk => el('tr', {},
      el('td', { class: 'mono' }, pk.name),
      el('td', { style: 'color:var(--tx-3)' }, pk.from || '—'),
      el('td', { class: 'mono' }, pk.to))));

    body.replaceChildren(
      el('div', { class: 'grid2', style: 'margin-bottom:14px' },
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'UPDATES AVAILABLE'),
          el('div', { class: 'v' }, String(u?.count ?? '—')),
          el('div', { class: 'm' }, u?.count ? 'install these soon' : 'system is current')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'SECURITY UPDATES'),
          el('div', { class: 'v', style: u?.security ? 'color:var(--warn)' : '' },
            String(u?.security ?? '—')),
          el('div', { class: 'm' }, 'highest priority'))),
      el('div', { class: 'row', style: 'margin-bottom:12px' }, cek, up, inst),
      u?.packages?.length
        ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Paket'),
              el('th', {}, 'Current'), el('th', {}, 'New'))), tb)))
        : el('div', { class: 'card' }, el('div', { class: 'empty' }, 'System is up to date')));
  }

  /* ── Firewall ── */
  function renderFirewall(body) {
    const f = data.fw;
    if (!f) return body.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'empty' }, 'UFW is not installed on this server')));

    const tg = el('button', { class: 'tg' + (f.active ? ' on' : ''),
      html: ic('lock', 13) + `<span>${f.active ? 'Active' : 'Inactive'}</span>` });
    tg.onclick = async () => {
      if (!confirm(f.active ? 'Disable firewall? All port jadi terbuka.'
        : 'Enable the firewall?')) return;
      try { await api('/admin/firewall/toggle', { method: 'POST',
        body: JSON.stringify({ on: !f.active }) }); load(); } catch (e) { toast(e.message); }
    };
    const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Open port</span>' });
    add.onclick = () => {
      const port = el('input', { placeholder: '8080', inputmode: 'numeric' });
      const proto = el('select', {}, el('option', { value: 'tcp' }, 'TCP'),
        el('option', { value: 'udp' }, 'UDP'));
      const b = el('button', { class: 'btn pri' }, 'Buka');
      b.onclick = async () => {
        try { await api('/admin/firewall', { method: 'POST',
          body: JSON.stringify({ port: port.value, proto: proto.value }) });
          closeDrawer(); toast('Port opened'); load(); } catch (e) { toast(e.message); }
      };
      openDrawer('Open port', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Port'), port),
        el('div', { class: 'field' }, el('label', {}, 'Protocol'), proto),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Note: Docker bypasses UFW. Ports published by a container stay '
          + 'terbuka meskipun tidak ada rules di sini.'),
        el('div', { class: 'row' }, b)));
    };

    const tb = el('tbody', {}, ...f.rules.map(r => {
      const d = el('button', { class: 'ib', html: ic('trash', 14) });
      d.onclick = async () => {
        if (!confirm(`Hapus rules #${r.n} (${r.to})?`)) return;
        try { await api('/admin/firewall/' + r.n, { method: 'DELETE' });
          toast('Rule removed'); load(); } catch (e) { toast(e.message); }
      };
      return el('tr', {}, el('td', { class: 'num', style: 'color:var(--tx-3)' }, String(r.n)),
        el('td', { class: 'mono' }, r.to),
        el('td', {}, el('span', { class: 'pill ' + (r.action === 'ALLOW' ? 'ok' : 'bad') }, r.action)),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, r.from),
        el('td', {}, d));
    }));

    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' }, tg,
        el('span', { class: 'pill' }, `${f.rules.length} rules`),
        el('span', { class: 'sp' }), add),
      f.rules.length
        ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '#'),
              el('th', {}, 'To'), el('th', {}, 'Action'), el('th', {}, 'From'),
              el('th', {}, ''))), tb)))
        : el('div', { class: 'card' }, el('div', { class: 'empty' }, 'No rules yet')));
  }

  /* ── Network ── */
  function renderNetwork(body) {
    const n = data.net;
    if (!n) return body.replaceChildren(el('div', { class: 'empty' }, 'Tidak terbaca'));
    body.replaceChildren(
      el('div', { class: 'sec' }, 'Interfaces'),
      el('div', { class: 'card' }, el('table', {}, el('tbody', {},
        ...n.interfaces.map(i => el('tr', {},
          el('td', { style: 'width:34%' }, i.name),
          el('td', { class: 'mono' }, i.cidr)))))),
      el('div', { class: 'sec' }, 'Gateway & DNS'),
      el('div', { class: 'card' }, el('table', {}, el('tbody', {},
        el('tr', {}, el('td', { style: 'width:34%;color:var(--tx-3)' }, 'Gateway'),
          el('td', { class: 'mono' }, n.gateway || '—')),
        ...n.dns.map((d, i) => el('tr', {},
          el('td', { style: 'color:var(--tx-3)' }, 'DNS ' + (i + 1)),
          el('td', { class: 'mono' }, d)))))));
  }

  /* ── Users Linux ── */
  function renderUsers(body) {
    const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Tambah</span>' });
    add.onclick = () => {
      const n = el('input'), pw = el('input', { type: 'password' });
      const b = el('button', { class: 'btn pri' }, 'Create');
      b.onclick = async () => {
        try { await api('/admin/linux-users', { method: 'POST',
          body: JSON.stringify({ name: n.value.trim(), password: pw.value }) });
          closeDrawer(); toast('Users dibuat'); load(); } catch (e) { toast(e.message); }
      };
      openDrawer('Users Linux baru', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Name'), n),
        el('div', { class: 'field' }, el('label', {}, 'Password'), pw),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'This is an operating-system user, separate from panel users.'),
        el('div', { class: 'row' }, b)));
    };
    const tb = el('tbody', {}, ...data.users.map(u => {
      const d = el('button', { class: 'ib', html: ic('trash', 14) });
      d.onclick = async () => {
        if (!confirm(`Hapus pengguna Linux "${u.name}" beserta folder home-nya?`)) return;
        try { await api('/admin/linux-users/' + encodeURIComponent(u.name), { method: 'DELETE' });
          toast('Deleted'); load(); } catch (e) { toast(e.message); }
      };
      return el('tr', {}, el('td', {}, u.name), el('td', { class: 'num' }, String(u.uid)),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, u.home),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, u.shell), el('td', {}, d));
    }));
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'pill' }, `${data.users.length} pengguna`),
        el('span', { class: 'sp' }), add),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Name'),
          el('th', { class: 'num' }, 'UID'), el('th', {}, 'Home'),
          el('th', {}, 'Shell'), el('th', {}, ''))), tb))));
  }

  async function load() {
    const g = (p2) => api(p2).catch(() => null);
    const [sv, up, fw, nt, us] = await Promise.all([
      g('/admin/services'), g('/admin/updates'), g('/admin/firewall'),
      g('/admin/network'), g('/admin/linux-users')]);
    data = { ready: true, services: sv?.services || [], updates: up, fw,
      net: nt, users: us?.users || [] };
    T.setCount('services', data.services.filter(s => s.active === 'active').length);
    if (data.updates?.count) T.setCount('updates', data.updates.count);
    T.setCount('users', data.users.length);
    render(T.current, T.body);
  }
  every(load, 30000);
};

/* ═══════════ Penjadwal ═══════════ */
VIEWS.jobs = () => {
  let all = [], q = '';
  const wrap = el('div');
  const search = searchBox('Cari job…', v => { q = v; render(); });
  mount(el('div', {}, el('div', { class: 'row', style: 'margin-bottom:10px' }, search), wrap));
  liveBadge(15);

  addAction('Job baru', 'plus', () => form(), 'btn pri');
  addAction('Refresh', 'refresh', () => load());

  const PRESET = [
    ['0 2 * * *', 'Daily at 02:00'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['0 3 * * 0', 'Sundays at 03:00'],
  ];

  function form() {
    const name = el('input', { placeholder: 'Backup harian' });
    const type = el('select', {},
      el('option', { value: 'shell' }, 'Command shell'),
      el('option', { value: 'backup' }, 'Backup'),
      el('option', { value: 'restart' }, 'Restart container'),
      el('option', { value: 'deploy' }, 'Redeploy stack'));
    const sched = el('input', { placeholder: '0 2 * * *' });
    const target = el('input', { placeholder: 'nama container / stack / data' });
    const cmd = el('textarea', { rows: 3, placeholder: 'docker system prune -f' });
    const tf = el('div', { class: 'field' }, el('label', {}, 'Target'), target);
    const cf = el('div', { class: 'field' }, el('label', {}, 'Command'), cmd);
    const sync = () => {
      cf.style.display = type.value === 'shell' ? '' : 'none';
      tf.style.display = type.value === 'shell' ? 'none' : '';
    };
    type.onchange = sync; sync();

    const chips = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:10px' },
      ...PRESET.map(([v, l]) => {
        const c = el('button', { class: 'btn', style: 'height:25px;font-size:11px' }, l);
        c.onclick = () => sched.value = v;
        return c;
      }));

    const b = el('button', { class: 'btn pri' }, 'Save');
    b.onclick = async () => {
      try {
        await api('/jobs', { method: 'POST', body: JSON.stringify({
          name: name.value, schedule: sched.value, type: type.value,
          target: target.value, command: cmd.value }) });
        closeDrawer(); toast('Job created'); load();
      } catch (e) { toast(e.message); }
    };
    openDrawer('New scheduled job', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Type'), type),
      tf, cf,
      el('div', { class: 'field' }, el('label', {}, 'Schedule (format cron)'), sched),
      chips,
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
        'Fields: minute hour day month weekday. Example 0 2 * * * = daily at 02:00.'),
      el('div', { class: 'row' }, b)));
  }

  function history(jb) {
    const tb = el('tbody', {}, ...(jb.runs || []).slice().reverse().map(r => el('tr', {},
      el('td', { style: 'white-space:nowrap' }, new Date(r.t).toLocaleString('id-ID')),
      el('td', {}, el('span', { class: 'pill ' + (r.code === 0 ? 'ok' : 'bad') },
        r.code === 0 ? 'success' : 'failed')),
      el('td', { class: 'num' }, r.ms + ' ms'))));
    const last = (jb.runs || []).slice(-1)[0];
    openDrawer('Riwayat — ' + jb.name, el('div', {},
      el('div', { class: 'sec', style: 'margin-top:0' }, 'Run history'),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:34vh' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'),
          el('th', {}, 'Result'), el('th', { class: 'num' }, 'Duration'))), tb))),
      el('div', { class: 'sec' }, 'Last output'),
      el('div', { class: 'logbox', style: 'height:32vh' }, last?.out || '(kosong)')));
  }

  async function load() {
    try { all = (await api('/jobs')).jobs; render(); }
    catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  function render() {
    try {
      if (!all.length) {
        wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty',
          html: ic('clock', 30, 1.3) + '<div>No scheduled jobs</div>' +
            '<div style="font-size:11.5px;margin-top:6px">Misalnya: backup harian, '
            + 'bersihkan image tiap minggu, restart container tiap pagi.</div>' })));
        return;
      }
      const jobs = all.filter(jb => matches(q, jb.name, jb.type, jb.target));
      if (!jobs.length) {
        wrap.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'empty', html: ic('search', 30, 1.3) + '<div>No matching jobs</div>' })));
        return;
      }
      const tb = el('tbody');
      jobs.forEach(jb => {
        const tg = el('button', { class: 'tg' + (jb.enabled ? ' on' : ''),
          style: 'height:24px;font-size:11px' }, jb.enabled ? 'Active' : 'Paused');
        tg.onclick = async (e) => { e.stopPropagation();
          await api('/jobs/' + jb.id, { method: 'PATCH',
            body: JSON.stringify({ enabled: !jb.enabled }) }); load(); };
        const runNow = el('button', { class: 'ib', title: 'Run now', html: ic('play', 14) });
        runNow.onclick = async (e) => { e.stopPropagation(); toast('Running…');
          try { const r = await api('/jobs/' + jb.id + '/run', { method: 'POST' });
            toast(r.code === 0 ? 'Sukses' : 'Gagal (kode ' + r.code + ')'); load(); }
          catch (er) { toast(er.message); } };
        const del = el('button', { class: 'ib', html: ic('trash', 14) });
        del.onclick = async (e) => { e.stopPropagation();
          if (!confirm(`Hapus tugas "${jb.name}"?`)) return;
          await api('/jobs/' + jb.id, { method: 'DELETE' }); load(); };

        const tr = el('tr', { style: 'cursor:pointer' },
          el('td', {}, el('div', { class: 'row' },
            el('i', { class: 'dot ' + (jb.lastCode === 0 ? 'up' : jb.lastCode == null ? 'idle' : 'down') }),
            el('div', {}, el('div', { style: 'font-weight:500' }, jb.name),
              el('div', { style: 'font-size:10.5px;color:var(--tx-3)' },
                jb.type + (jb.target ? ' · ' + jb.target : ''))))),
          el('td', { class: 'mono' }, jb.schedule),
          el('td', { style: 'color:var(--tx-3)' }, jb.lastRun ? ago(jb.lastRun) : 'never'),
          el('td', {}, tg),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' },
            runNow, del)));
        tr.onclick = () => history(jb);
        tb.append(tr);
      });
      wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Job'),
          el('th', {}, 'Schedule'), el('th', {}, 'Last run'), el('th', {}, 'Status'),
          el('th', {}, ''))), tb))));
      $('#sub').textContent = `${all.filter(j2 => j2.enabled).length} active`;
    } catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 15000);
};

/* ═══════════ Brankas & Backup ═══════════ */
VIEWS.vault = () => {
  let secrets = [], backups = [], stacks = [], qSecrets = '', qBackups = '';
  const T = tabs([
    { id: 'secrets', n: 'Secrets', i: 'lock' },
    { id: 'backups', n: 'Backup', i: 'disk' },
  ], (id, body) => id === 'secrets' ? renderSecrets(body) : renderBackups(body));
  mount(T.node);
  liveBadge(20);
  addAction('Refresh', 'refresh', () => load());

  /* ── Secrets ── */
  function renderSecrets(body) {
    const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Add secret</span>' });
    add.onclick = () => {
      const n = el('input', { placeholder: 'DB_PASSWORD' });
      const v = el('input', { type: 'password' });
      const b = el('button', { class: 'btn pri' }, 'Save');
      b.onclick = async () => {
        try { await api('/secrets', { method: 'POST',
          body: JSON.stringify({ name: n.value.trim(), value: v.value }) });
          closeDrawer(); toast('Saved'); load(); } catch (e) { toast(e.message); }
      };
      openDrawer('Secrets baru', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Variable name'), n),
        el('div', { class: 'field' }, el('label', {}, 'Value'), v),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Values are encrypted with AES-256-GCM. The key lives in a separate file '
          + 'readable only by root.'),
        el('div', { class: 'row' }, b)));
    };

    const inject = el('button', { class: 'btn', html: ic('down', 13) + '<span>Inject into stack</span>' });
    inject.onclick = () => {
      const sel = el('select', {}, ...stacks.map(s => el('option', { value: s.name }, s.name)));
      const b = el('button', { class: 'btn pri' }, 'Inject');
      b.onclick = async () => {
        try { const r = await api('/secrets/inject', { method: 'POST',
          body: JSON.stringify({ stack: sel.value }) });
          closeDrawer(); toast(`${r.added} variables added to .env`); }
        catch (e) { toast(e.message); }
      };
      openDrawer('Inject rahasia ke stack', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Target stack'), sel),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          "Every secret not already present is appended to that stack's .env file. "
          + 'Existing entries are not overwritten.'),
        el('div', { class: 'row' }, b)));
    };

    const countPill = el('span', { class: 'pill' }, `${secrets.length} rahasia`);
    const listArea = el('div');
    // Kotak cari & tombol dibangun sekali di sini; hanya listArea yang
    // dibangun ulang tiap ketikan, supaya fokus di kotak cari tidak lepas.
    const search = searchBox('Cari rahasia…', v => { qSecrets = v; paint(); });
    search.querySelector('input').value = qSecrets;

    function paint() {
      const shown = secrets.filter(s => matches(qSecrets, s.name));
      const tb = el('tbody', {}, ...shown.map(s => {
        const show = el('button', { class: 'ib', title: 'Reveal value', html: ic('search', 14) });
        show.onclick = async () => {
          try { const r = await api('/secrets/' + encodeURIComponent(s.name));
            openDrawer(s.name, el('div', {},
              el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:8px' },
                'Revealing this value is recorded in the activity log.'),
              el('div', { class: 'card' }, el('div', { class: 'card-b mono',
                style: 'word-break:break-all;font-size:13px' }, r.value))));
          } catch (e) { toast(e.message); }
        };
        const del = el('button', { class: 'ib', html: ic('trash', 14) });
        del.onclick = async () => {
          if (!confirm(`Hapus rahasia "${s.name}"?`)) return;
          await api('/secrets/' + encodeURIComponent(s.name), { method: 'DELETE' });
          toast('Deleted'); load();
        };
        return el('tr', {}, el('td', { class: 'mono' }, s.name),
          el('td', { class: 'mono', style: 'color:var(--tx-3)' }, '••••••••••••'),
          el('td', { style: 'color:var(--tx-3)' }, ago(s.updated)),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, show, del)));
      }));
      listArea.replaceChildren(shown.length
        ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Name'),
              el('th', {}, 'Value'), el('th', {}, 'Updated'), el('th', {}, ''))), tb)))
        : el('div', { class: 'card' }, el('div', { class: 'empty',
            html: ic(secrets.length ? 'search' : 'lock', 30, 1.3)
              + `<div>${secrets.length ? 'No matching secrets' : 'Vault is empty'}</div>` +
              (secrets.length ? '' : '<div style="font-size:11.5px;margin-top:6px">Simpan kata sandi database, '
              + 'API key, dan token di sini — bukan di dalam files compose.</div>') })));
    }
    paint();

    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px;flex-wrap:wrap' },
        countPill, search, el('span', { class: 'sp' }), inject, add),
      listArea);
  }

  /* ── Backup ── */
  function renderBackups(body) {
    const mk = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Create backup</span>' });
    mk.onclick = () => {
      const type = el('select', {},
        el('option', { value: 'data' }, 'Folder data'),
        el('option', { value: 'db' }, 'Database Postgres'),
        el('option', { value: 'volume' }, 'Volume Docker'));
      const cont = el('input', { placeholder: 'nama container / volume' });
      const user = el('input', { placeholder: 'postgres', value: 'postgres' });
      const cf = el('div', { style: 'display:none' },
        el('div', { class: 'field' }, el('label', {}, 'Container / Volume'), cont),
        el('div', { class: 'field' }, el('label', {}, 'Users DB'), user));
      type.onchange = () => {
        cf.style.display = type.value === 'data' ? 'none' : '';
        user.parentElement.style.display = type.value === 'db' ? '' : 'none';
      };
      const b = el('button', { class: 'btn pri' }, 'Run');
      b.onclick = async () => {
        const what = type.value === 'data' ? 'data'
          : type.value === 'db' ? `db:${cont.value}:${user.value}`
          : `volume:${cont.value}`;
        b.disabled = true; b.textContent = 'Creating…';
        try { const r = await api('/backups', { method: 'POST', body: JSON.stringify({ what }) });
          toast('Backup created'); closeDrawer(); load(); }
        catch (e) { toast(e.message); } finally { b.disabled = false; }
      };
      openDrawer('Create backup', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Type'), type), cf,
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Databases must be dumped, not copied raw — copying a live database file '
          + 'can produce a corrupt backup.'),
        el('div', { class: 'row' }, b)));
    };

    // ── Backup otomatis ke HDD (server-backup.timer, di luar panel) ── beda
    // sistem dari daftar di bawah (yang cuma tau soal backup manual). Status
    // ini dibaca langsung dari host, jadi selalu mencerminkan kondisi asli.
    const hddArea = el('div', { style: 'margin-bottom:16px' });
    async function paintHdd() {
      try {
        const h = await api('/backups/hdd');
        if (!h.mounted) {
          hddArea.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-b' },
            el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' },
              el('span', { class: 'pill bad' }, 'HDD tidak terpasang'),
              el('span', { style: 'font-size:11.5px;color:var(--tx-3)' },
                'Backup otomatis harian (02:00) tidak akan jalan sampai drive-nya dicolok & ter-mount di /mnt/backup.')))));
          return;
        }
        const pct = h.usage ? Math.round((h.usage.used / h.usage.total) * 100) : 0;
        hddArea.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-b' },
          el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' },
            el('span', { class: 'pill ok' }, 'HDD backup terpasang'),
            el('span', { class: 'pill' + (h.timerActive ? '' : ' bad') },
              h.timerActive ? 'Jadwal aktif (tiap hari 02:00)' : 'Jadwal MATI'),
            el('span', { class: 'pill' }, `${h.snapshotCount} snapshot`),
            h.dbDumpCount ? el('span', { class: 'pill' }, `${h.dbDumpCount} dump basis data`) : '',
            el('span', { class: 'sp' }),
            el('span', { style: 'font-size:11.5px;color:var(--tx-3)' },
              h.lastBackup ? `Terakhir: ${ago(h.lastBackup)}` : 'Belum pernah backup')),
          h.usage ? el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:8px' },
            `${bytes(h.usage.used)} terpakai dari ${bytes(h.usage.total)} di drive backup (${pct}%)`) : '')));
      } catch {
        hddArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
          'Gagal cek status HDD backup.'));
      }
    }
    paintHdd();

    // ── Off-site: Google Drive (multi-akun) ── connect langsung dari sini
    // (OAuth), bukan setup CLI manual. Bisa lebih dari satu akun — kuota
    // gratis cuma 15 GB tiap akun, jadi backup otomatis pindah ke akun yang
    // masih longgar (lihat pickAccount() di gdrive.js / server-backup).
    const gdriveArea = el('div', { style: 'margin-bottom:16px' });
    async function paintGdrive() {
      try {
        const g = await api('/gdrive/accounts');
        if (!g.configured) {
          const cfg = await api('/gdrive/config').catch(() => ({ redirectUri: '' }));
          const idInp = el('input', { placeholder: 'xxxxx.apps.googleusercontent.com' });
          const secInp = el('input', { type: 'password', placeholder: 'GOCSPX-…' });
          const uriBox = el('input', { readonly: true, value: cfg.redirectUri, style: 'font-family:var(--mono);font-size:11px' });
          const copyBtn = el('button', { class: 'btn', html: ic('code', 13) + '<span>Copy</span>' });
          copyBtn.onclick = () => { navigator.clipboard?.writeText(cfg.redirectUri); toast('Disalin'); };
          const saveBtn = el('button', { class: 'btn pri', html: ic('lock', 13) + '<span>Simpan</span>' });
          const msg = el('div', { style: 'font-size:11.5px;min-height:16px;margin-top:6px' });
          saveBtn.onclick = async () => {
            if (!idInp.value.trim() || !secInp.value.trim()) { msg.style.color = 'var(--bad)';
              msg.textContent = 'Client ID dan Secret wajib diisi'; return; }
            saveBtn.disabled = true;
            try {
              await api('/gdrive/config', { method: 'POST',
                body: JSON.stringify({ clientId: idInp.value.trim(), clientSecret: secInp.value.trim() }) });
              toast('Tersimpan'); paintGdrive();
            } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; }
            finally { saveBtn.disabled = false; }
          };
          gdriveArea.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-b' },
            el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:12px;line-height:1.6' },
              'Belum diset. Bikin OAuth Client di ',
              el('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank' }, 'Google Cloud Console'),
              ' (Application type: Web application), tempel redirect URI di bawah ini persis, '
              + 'lalu simpan Client ID & Secret-nya di sini.'),
            el('div', { class: 'field' }, el('label', {}, 'Authorized redirect URI'),
              el('div', { class: 'row' }, uriBox, copyBtn)),
            el('div', { class: 'field' }, el('label', {}, 'Client ID'), idInp),
            el('div', { class: 'field' }, el('label', {}, 'Client Secret'), secInp),
            msg, el('div', { class: 'row' }, saveBtn))));
          return;
        }
        const connect = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Connect Google Drive</span>' });
        connect.onclick = async () => {
          connect.disabled = true;
          try {
            const { url } = await api('/gdrive/connect');
            const win = window.open(url, 'gdrive-connect', 'width=520,height=680');
            const onMsg = (e) => {
              if (!e.data || typeof e.data.gdrive === 'undefined') return;
              window.removeEventListener('message', onMsg);
              toast(e.data.gdrive ? 'Akun tersambung' : 'Gagal menyambungkan');
              paintGdrive();
            };
            window.addEventListener('message', onMsg);
          } catch (e) { toast(e.message); } finally { connect.disabled = false; }
        };
        const rows = g.accounts.map((a) => {
          const del = el('button', { class: 'ib', title: 'Disconnect', html: ic('trash', 14) });
          del.onclick = async () => {
            if (!confirm(`Putuskan akun "${a.email}"? Backup tidak akan sync ke akun ini lagi.`)) return;
            await api('/gdrive/accounts/' + a.id, { method: 'DELETE' });
            toast('Disconnected'); paintGdrive();
          };
          const pct = a.quota?.percent ?? 0;
          return el('div', { class: 'row', style: 'padding:9px 0;border-top:1px solid var(--line);gap:10px' },
            el('div', { style: 'flex:1;min-width:0' },
              el('div', { style: 'font-size:12.5px' }, a.email),
              a.quota
                ? el('div', { style: 'font-size:11px;color:var(--tx-3)' },
                    `${bytes(a.quota.used)} / ${a.quota.total ? bytes(a.quota.total) : 'unlimited'} (${pct}%)`)
                : el('div', { style: 'font-size:11px;color:var(--bad)' }, a.error || 'Gagal cek kuota'),
              a.quota?.total ? el('div', { class: 'bar', style: 'margin-top:4px' },
                el('i', { style: `width:${Math.min(pct, 100)}%`,
                  class: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '' })) : ''),
            del);
        });
        gdriveArea.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-b' },
          el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;margin-bottom:2px' },
            el('span', { class: 'pill' + (g.accounts.length ? ' ok' : '') },
              g.accounts.length ? `${g.accounts.length} akun tersambung` : 'Belum ada akun'),
            el('span', { class: 'sp' }), connect),
          ...rows,
          el('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:10px' },
            'Snapshot backup harian di-sync (bukan ditumpuk) ke akun yang masih paling longgar.'))));
      } catch {
        gdriveArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
          'Gagal cek status Google Drive.'));
      }
    }
    paintGdrive();

    // ── Disaster recovery: snapshot SELURUH state panel (users, vault
    // secrets, uptime checks, API token, dst) -- backup HDD/GDrive di atas
    // cuma nyalin data APLIKASI, bukan panel-nya sendiri. Kalau laptop mati
    // total, tanpa ini panel harus disetup ulang dari nol biar pun data
    // aplikasinya selamat.
    const drArea = el('div', { style: 'margin-bottom:16px' });
    async function paintDr() {
      let r;
      try { r = await api('/dr/snapshots'); } catch { r = { snapshots: [] }; }
      const makeBtn = el('button', { class: 'btn pri' }, 'Buat snapshot sekarang');
      makeBtn.onclick = async () => {
        makeBtn.disabled = true; makeBtn.textContent = 'Membuat…';
        try { await api('/dr/snapshots', { method: 'POST' }); toast('Snapshot dibuat'); paintDr(); }
        catch (e) { toast(e.message); }
        finally { makeBtn.disabled = false; makeBtn.textContent = 'Buat snapshot sekarang'; }
      };
      const rows = r.snapshots.map((s) => {
        const dl = el('a', { class: 'ib', title: 'Unduh', html: ic('down', 14),
          href: '/api/dr/snapshots/' + encodeURIComponent(s.file) + '/download' });
        return el('tr', {}, el('td', { class: 'mono', style: 'font-size:11px' }, s.file),
          el('td', { class: 'num' }, bytes(s.size)),
          el('td', { style: 'color:var(--tx-3)' }, ago(s.t)),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, dl)));
      });
      drArea.replaceChildren(
        el('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
          'Snapshot otomatis tiap hari (nyimpen 5 terakhir), disimpan di /data biar ikut kebawa lewat backup HDD & Google Drive di atas -- tanpa perlu setup terpisah. '
          + 'Isinya: akun user, secrets vault (terenkripsi), daftar uptime check, API token, dan setelan lain -- BUKAN data aplikasi (itu sudah dicover backup biasa).'),
        el('div', { class: 'row', style: 'margin-bottom:10px' }, makeBtn),
        rows.length ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
          el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Snapshot'),
            el('th', { class: 'num' }, 'Size'), el('th', {}, 'Dibuat'), el('th', {}, ''))),
            el('tbody', {}, ...rows)))) : '');
    }
    paintDr();

    // ── Overview & grafik riwayat backup (HDD + Drive) ── data-nya dari
    // log yang ditulis /usr/local/bin/server-backup tiap run (bukan
    // disampling panel — backup cuma jalan sekali sehari, beda dari
    // grafik database yang disampling tiap menit).
    const backupHistArea = el('div', { style: 'margin-bottom:16px' });
    const BACKUP_METRICS = [
      { id: 'size', label: 'Ukuran snapshot', color: '#5b8def', fmt: (v) => bytes(v) },
      { id: 'xfer', label: 'Data baru ditulis', color: '#3dbb7d', fmt: (v) => bytes(v) },
    ];
    async function fetchBackupHistory(range) {
      const r = await api('/backups/history');
      const days = range === '90d' ? 90 : 30;
      const since = Date.now() - days * 86400000;
      const pts = r.runs.filter((x) => x.ok && x.t >= since)
        .map((x) => ({ t: x.t, size: x.sizeBytes, xfer: x.xferBytes }));
      return { history: pts };
    }
    async function paintBackupHist() {
      try {
        const r = await api('/backups/history');
        if (!r.total) { backupHistArea.replaceChildren(); return; }
        const stat = (key, icon, val, meta) => el('div', { class: 'stat' },
          el('div', { class: 'k', html: ic(icon, 12) + `<span>${key}</span>` }),
          el('div', { class: 'v', html: val }), meta ? el('div', { class: 'm' }, meta) : '');
        backupHistArea.replaceChildren(
          el('div', { class: 'sec' }, 'Overview & riwayat backup'),
          el('div', { class: 'stats' },
            stat('Total run', 'clock', r.total, `${r.successCount} berhasil`),
            stat('Success rate', 'pulse', r.successRate != null ? `${r.successRate}<small>%</small>` : '—', ''),
            stat('Rata-rata ukuran', 'disk', r.avgSizeBytes != null ? bytes(r.avgSizeBytes) : '—', 'per snapshot'),
            stat('Rata-rata data baru', 'db', r.avgXferBytes != null ? bytes(r.avgXferBytes) : '—', 'per hari')),
          el('div', { class: 'sec', style: 'margin-top:14px' }, 'Grafik custom'),
          customChartBlock(fetchBackupHistory, 'db.backup.chart',
            { metrics: BACKUP_METRICS, defaultMetrics: ['size', 'xfer'],
              rangeLabels: { '30d': '30 hari terakhir', '90d': '90 hari terakhir' }, defaultRange: '30d' }));
      } catch { backupHistArea.replaceChildren(); }
    }
    paintBackupHist();

    const total = backups.reduce((a, b2) => a + b2.size, 0);
    const countPill = el('span', { class: 'pill' }, `${backups.length} files`);
    const listArea = el('div');
    const search = searchBox('Cari cadangan…', v => { qBackups = v; paint(); });
    search.querySelector('input').value = qBackups;

    function paint() {
      const shown = backups.filter(b2 => matches(qBackups, b2.name));
      const tb = el('tbody', {}, ...shown.map(b2 => {
        const dl = el('a', { class: 'ib', title: 'Download', html: ic('down', 14),
          href: '/api/backups/download?name=' + encodeURIComponent(b2.name) });
        const del = el('button', { class: 'ib', html: ic('trash', 14) });
        del.onclick = async () => {
          if (!confirm(`Hapus cadangan "${b2.name}"?`)) return;
          await api('/backups/' + encodeURIComponent(b2.name), { method: 'DELETE' });
          toast('Deleted'); load();
        };
        const rs = typeof restoreButton === 'function' ? restoreButton(b2, load) : '';
        return el('tr', {}, el('td', { class: 'mono' }, b2.name),
          el('td', { class: 'num' }, bytes(b2.size)),
          el('td', { style: 'color:var(--tx-3)' }, ago(b2.at)),
          el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, rs, dl, del)));
      }));
      listArea.replaceChildren(shown.length
        ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Files'),
              el('th', { class: 'num' }, 'Size'), el('th', {}, 'Dibuat'),
              el('th', {}, ''))), tb)))
        : el('div', { class: 'card' }, el('div', { class: 'empty',
            html: ic('disk', 30, 1.3) + `<div>${backups.length ? 'No matching backups' : 'No backups yet'}</div>` +
              (backups.length ? '' : '<div style="font-size:11.5px;margin-top:6px">Schedulekan otomatis lewat '
              + 'menu Penjadwal agar tidak perlu diingat manual.</div>') })));
    }
    paint();

    body.replaceChildren(
      el('div', { class: 'sec' }, 'Backup otomatis ke HDD'),
      hddArea,
      el('div', { class: 'sec' }, 'Off-site: Google Drive'),
      gdriveArea,
      el('div', { class: 'sec' }, 'Disaster recovery: state panel'),
      drArea,
      backupHistArea,
      el('div', { class: 'sec' }, 'Backup manual'),
      el('div', { class: 'row', style: 'margin-bottom:12px;flex-wrap:wrap' },
        countPill, el('span', { class: 'pill' }, bytes(total)),
        search, el('span', { class: 'sp' }), mk),
      listArea,
      el('div', { class: 'note' + '', style: 'margin-top:16px;font-size:11.5px;color:var(--tx-2);'
        + 'background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px' },
        'Backup manual di atas & HDD otomatis di atasnya cuma disk terpisah, TAPI masih di laptop '
        + 'yang sama — aman dari SSD rusak, tapi tidak dari kebakaran/kecurian/laptop hilang. '
        + 'Google Drive di atas itu satu-satunya yang beneran di lokasi lain (off-site).'));
  }

  async function load() {
    const [s, b, st] = await Promise.all([
      api('/secrets').catch(() => ({ secrets: [] })),
      api('/backups').catch(() => ({ backups: [] })),
      api('/stacks').catch(() => ({ stacks: [] }))]);
    secrets = s.secrets; backups = b.backups; stacks = st.stacks;
    T.setCount('secrets', secrets.length);
    T.setCount('backups', backups.length);
    T.current === 'secrets' ? renderSecrets(T.body) : renderBackups(T.body);
  }
  every(load, 20000);
};
