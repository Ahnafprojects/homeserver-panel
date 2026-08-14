'use strict';
/* Page gelombang 2: Stack, Terminal, Sumber daya Docker, Pengrules.
   Memakai helper yang sudah ada di app.js (el, api, ic, toast, dst). */

/* ═══════════ Stack: compose editor + git ═══════════ */
VIEWS.stacks = () => {
  const wrap = el('div');
  mount(wrap);

  addAction('From Git', 'down', () => formGit(), 'btn');
  addAction('New stack', 'plus', () => formCompose(), 'btn pri');
  addAction('Refresh', 'refresh', () => load());

  function logDrawer(title) {
    const box = el('div', { class: 'logbox', style: 'height:70vh' });
    openDrawer(title, box);
    return {
      line: (t) => { box.append(el('span', { class: 'l' }, t)); box.scrollTop = box.scrollHeight; },
      done: (c) => box.append(el('span', { class: 'l',
        style: `color:${c === 0 ? 'var(--ok)' : 'var(--bad)'}` },
        c === 0 ? '\n✓ selesai' : `\n✗ failed (kode ${c})`)),
    };
  }

  function stream(url, title, after) {
    const d = logDrawer(title);
    const es = new EventSource(url);
    es.onmessage = e => { try { d.line(JSON.parse(e.data)); } catch { d.line(e.data); } };
    es.addEventListener('done', e => { d.done(+e.data); es.close(); after?.(+e.data); load(); });
    es.onerror = () => { es.close(); };
  }

  function formCompose(existing) {
    const name = el('input', { placeholder: 'nama-stack', value: existing?.name || '' });
    if (existing) name.disabled = true;
    const compose = el('textarea', { rows: 18, spellcheck: 'false',
      placeholder: 'services:\n  app:\n    image: nginx:alpine\n    ports: ["8080:80"]' });
    compose.value = existing?.compose || '';
    const env = el('textarea', { rows: 5, spellcheck: 'false', placeholder: 'DB_PASSWORD=rahasia' });
    env.value = existing?.env || '';
    const msg = el('div', { style: 'font-size:11.5px;margin-top:8px' });

    const save = async () => {
      const n = (name.value || '').trim();
      if (!n) { toast('Name is required'); return null; }
      const r = await api('/stacks/' + encodeURIComponent(n), { method: 'PUT',
        body: JSON.stringify({ compose: compose.value, env: env.value }) });
      msg.textContent = r.ok ? '✓ YAML valid' : r.message || 'YAML bermasalah';
      msg.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      return { n, ok: r.ok };
    };

    const bSave = el('button', { class: 'btn' }, 'Simpan & periksa');
    bSave.onclick = () => save().then(() => load()).catch(e => toast(e.message));
    const bDeploy = el('button', { class: 'btn pri', html: ic('play', 13) + '<span>Simpan & deploy</span>' });
    bDeploy.onclick = async () => {
      try {
        const r = await save(); if (!r) return;
        if (!r.ok) { toast('Perbaiki YAML dulu'); return; }
        stream(`/api/stacks/${encodeURIComponent(r.n)}/deploy`, 'Deploy — ' + r.n);
      } catch (e) { toast(e.message); }
    };

    openDrawer(existing ? 'Ubah stack — ' + existing.name : 'New stack', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'docker-compose.yml'), compose),
      el('div', { class: 'field' }, el('label', {}, 'Variabel (.env)'), env),
      msg,
      el('div', { class: 'row', style: 'margin-top:10px' }, bSave, bDeploy)));
  }

  function formGit() {
    const name = el('input', { placeholder: 'nama-stack' });
    const repo = el('input', { placeholder: 'https://github.com/pengguna/repo.git' });
    const branch = el('input', { placeholder: 'main (opsional)' });
    const go = el('button', { class: 'btn pri', html: ic('down', 13) + '<span>Clone</span>' });
    go.onclick = () => {
      const n = (name.value || '').trim(), r = (repo.value || '').trim();
      if (!n || !r) return toast('Name and URL are required');
      stream(`/api/stacks/${encodeURIComponent(n)}/clone?repo=${encodeURIComponent(r)}`
        + `&branch=${encodeURIComponent(branch.value || '')}`, 'Clone — ' + n);
    };
    openDrawer('Clone from Git', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Nama stack'), name),
      el('div', { class: 'field' }, el('label', {}, 'URL repositori'), repo),
      el('div', { class: 'field' }, el('label', {}, 'Branch'), branch),
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
        'Repo privat: pakai URL bertoken, contoh https://TOKEN@github.com/user/repo.git'),
      el('div', { class: 'row' }, go)));
  }

  async function detail(s) {
    try {
      const st = await api('/stacks/' + encodeURIComponent(s.name));
      const body = el('div');
      const acts = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:12px' });
      const mk = (label, icon, fn, cls = 'btn') => {
        const b = el('button', { class: cls, html: ic(icon, 13) + `<span>${label}</span>` });
        b.onclick = fn; return b;
      };
      acts.append(
        mk('Deploy', 'play', () => stream(`/api/stacks/${s.name}/deploy`, 'Deploy — ' + s.name), 'btn pri'),
        mk('Stop', 'stop', () => stream(`/api/stacks/${s.name}/stop`, 'Stop — ' + s.name)),
        mk('Edit', 'edit', () => formCompose(st)),
        mk('Delete', 'trash', async () => {
          if (!confirm(`Hapus stack "${s.name}" beserta volume-nya?`)) return;
          await api('/stacks/' + s.name, { method: 'DELETE' });
          closeDrawer(); toast('Stack dihapus'); load();
        }, 'btn danger'));
      body.append(acts);

      if (s.source === 'git') {
        const g = await api(`/stacks/${s.name}/git`).catch(() => null);
        if (g) {
          const sel = el('select', {}, ...g.branches.map(b => el('option', { value: b }, b)));
          sel.value = g.current;
          const sw = el('button', { class: 'btn' }, 'Pindah');
          sw.onclick = () => stream(`/api/stacks/${s.name}/checkout?ref=${encodeURIComponent(sel.value)}`,
            'Checkout — ' + sel.value);
          const pull = el('button', { class: 'btn', html: ic('down', 13) + '<span>Tarik update</span>' });
          pull.onclick = () => stream(`/api/stacks/${s.name}/pull`, 'Pull — ' + s.name);
          const tb = el('tbody');
          g.log.forEach(c => {
            const rb = el('button', { class: 'ib', title: 'Kembali ke commit ini', html: ic('restart', 13) });
            rb.onclick = () => confirm(`Kembali ke commit ${c.hash}?`) &&
              stream(`/api/stacks/${s.name}/checkout?ref=${c.hash}`, 'Rollback — ' + c.hash);
            tb.append(el('tr', {}, el('td', { class: 'mono' }, c.hash),
              el('td', {}, c.subject), el('td', { style: 'color:var(--tx-3)' }, c.when),
              el('td', {}, rb)));
          });
          body.append(el('div', { class: 'sec' }, 'Git'),
            el('div', { class: 'card' }, el('div', { class: 'card-b' },
              el('div', { class: 'row' }, el('div', { style: 'flex:1' }, sel), sw, pull),
              el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:8px' }, st.repo || ''))),
            el('div', { class: 'sec' }, 'Riwayat commit'),
            el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:36vh' },
              el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Commit'),
                el('th', {}, 'Pesan'), el('th', {}, 'Kapan'), el('th', {}, ''))), tb))));
        }
      }

      const hookUrl = `${location.origin}/hook/${s.name}`;
      body.append(el('div', { class: 'sec' }, 'compose'),
        el('div', { class: 'card' }, el('div', { class: 'card-b mono',
          style: 'white-space:pre-wrap;font-size:11.5px;max-height:34vh;overflow:auto' },
          st.compose || '(kosong)')));
      openDrawer(s.name, body);
    } catch (e) { toast(e.message); }
  }

  async function load() {
    try {
      const { stacks: list } = await api('/stacks');
      if (!list.length) {
        wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty',
          html: ic('box', 30, 1.3) + '<div>No stacks yet</div>' +
            '<div style="font-size:11.5px;margin-top:6px">Buat dari compose, atau clone dari Git.</div>' })));
        return;
      }
      const tb = el('tbody');
      list.forEach(s => {
        const tr = el('tr', { style: 'cursor:pointer' },
          el('td', {}, el('div', { class: 'row' },
            el('i', { class: 'dot ' + (s.running ? 'up' : 'idle') }),
            el('div', {}, el('div', { style: 'font-weight:500' }, s.name),
              el('div', { style: 'font-size:10.5px;color:var(--tx-3)' },
                s.source === 'git' ? (s.repo || 'git') : 'compose')))),
          el('td', {}, el('span', { class: 'pill ' + (s.running ? 'ok' : '') },
            `${s.running}/${s.total} jalan`)),
          el('td', { style: 'color:var(--tx-3)' }, s.branch || '—'),
          el('td', { style: 'color:var(--tx-3)' }, s.lastDeploy ? ago(s.lastDeploy) : 'never'));
        tr.onclick = () => detail(s);
        tb.append(tr);
      });
      wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Stack'),
          el('th', {}, 'Status'), el('th', {}, 'Branch'), el('th', {}, 'Deploy terakhir'))), tb))));
    } catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 10000);
};

/* ═══════════ Terminal ═══════════ */
VIEWS.terminal = () => {
  const host = el('div', { style: 'flex:1;min-height:0;background:#0b0c0f;padding:6px' });
  const sel = el('select', { style: 'max-width:260px' },
    el('option', { value: '' }, 'Shell host (mesin server)'));
  mount(el('div', { style: 'display:flex;flex-direction:column;height:100%' },
    el('div', { class: 'row', style: 'padding:10px 14px;border-bottom:1px solid var(--line);'
      + 'background:var(--surface)' },
      el('div', { style: 'max-width:280px;flex:1' }, sel)), host), { full: true });

  let term, fit, ws;
  function connect() {
    ws?.close();
    host.replaceChildren();
    term = new Terminal({ fontSize: 12.5, fontFamily: 'ui-monospace,Menlo,monospace',
      cursorBlink: true, scrollback: 4000,
      theme: { background: '#0b0c0f', foreground: '#d6dae1', cursor: '#5b8def' } });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit); term.open(host); fit.fit();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const c = sel.value ? `?container=${encodeURIComponent(sel.value)}` : '';
    ws = new WebSocket(`${proto}://${location.host}/ws/term${c}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => term.write('\r\n\x1b[90m— sesi berakhir —\x1b[0m\r\n');
    term.onData(d => ws.readyState === 1 && ws.send(d));
    term.onResize(({ rows, cols }) => ws.readyState === 1 && ws.send(`\x00resize:${rows},${cols}`));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host);
    timers.push({ close: () => { ro.disconnect(); ws?.close(); } });
  }
  sel.onchange = connect;

  api('/containers').then(({ containers }) => {
    containers.filter(c => c.state === 'running').forEach(c =>
      sel.append(el('option', { value: c.id }, 'Container: ' + c.name)));
  }).catch(() => {});

  if (window.Terminal) connect();
  else {
    host.append(el('div', { style: 'color:#8b91a0;padding:14px;font-size:12.5px' }, 'Memuat terminal…'));
    const t = setInterval(() => { if (window.Terminal) { clearInterval(t); connect(); } }, 120);
    timers.push({ close: () => clearInterval(t) });
  }
};

/* ═══════════ Sumber daya Docker (sub-tab) ═══════════ */
VIEWS.resources = () => {
  let data = { images: [], volumes: [], networks: [], containers: [] };

  const T = tabs([
    { id: 'images', n: 'Image', i: 'layers' },
    { id: 'volumes', n: 'Volume', i: 'disk' },
    { id: 'networks', n: 'Network', i: 'net' },
    { id: 'cleanup', n: 'Cleanup', i: 'trash' },
  ], (id, body) => render(id, body));
  mount(T.node);
  liveBadge(20);
  addAction('Refresh', 'refresh', () => load());

  const delBtn = (fn, title = 'Delete') => {
    const b = el('button', { class: 'ib', title, html: ic('trash', 14) });
    b.onclick = fn; return b;
  };

  function render(id, body) {
    if (id === 'images') return renderImages(body);
    if (id === 'volumes') return renderVolumes(body);
    if (id === 'networks') return renderNetworks(body);
    return renderCleanup(body);
  }

  /* ── Image ── */
  function renderImages(body) {
    const used = new Set(data.containers.map(c => c.image));
    const pull = el('button', { class: 'btn pri', html: ic('down', 13) + '<span>Tarik image</span>' });
    pull.onclick = () => {
      const n = el('input', { placeholder: 'nginx:alpine' });
      const b = el('button', { class: 'btn pri' }, 'Tarik');
      b.onclick = async () => {
        if (!n.value.trim()) return;
        b.disabled = true; b.textContent = 'Pulling…';
        try { await api('/images/pull', { method: 'POST', body: JSON.stringify({ name: n.value.trim() }) });
          toast('Image ditarik'); closeDrawer(); load(); }
        catch (e) { toast(e.message); } finally { b.disabled = false; }
      };
      openDrawer('Tarik image', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Nama image'), n),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Contoh: postgres:16-alpine, node:20-alpine, ghcr.io/pengguna/app:latest'),
        el('div', { class: 'row' }, b)));
    };

    const total = data.images.reduce((a, i) => a + i.size, 0);
    const dangling = data.images.filter(i => !i.tags.length).length;
    const tb = el('tbody');
    data.images.forEach(i => {
      const tag = i.tags[0] || '<tanpa tag>';
      const dipakai = i.tags.some(t => used.has(t));
      tb.append(el('tr', {},
        el('td', {}, el('div', { class: 'row' },
          el('i', { class: 'dot ' + (dipakai ? 'up' : 'idle'),
            title: dipakai ? 'Sedang dipakai container' : 'Tidak dipakai' }),
          el('span', { class: 'mono' }, tag))),
        el('td', { class: 'mono', style: 'color:var(--tx-3)' }, i.id),
        el('td', { class: 'num' }, bytes(i.size)),
        el('td', { style: 'color:var(--tx-3)' }, ago(i.created)),
        el('td', {}, delBtn(async () => {
          if (dipakai) return toast('This image is in use by a container');
          if (!confirm(`Hapus image ${tag}?`)) return;
          try { await api('/images/' + encodeURIComponent(i.tags[0] || i.id), { method: 'DELETE' });
            toast('Image dihapus'); load(); } catch (e) { toast(e.message); }
        }))));
    });
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'pill' }, `${data.images.length} image`),
        el('span', { class: 'pill' }, bytes(total)),
        dangling ? el('span', { class: 'pill warn' }, `${dangling} tanpa tag`) : '',
        el('span', { class: 'sp' }), pull),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Image'),
          el('th', {}, 'ID'), el('th', { class: 'num' }, 'Size'),
          el('th', {}, 'Dibuat'), el('th', {}, ''))), tb))));
  }

  /* ── Volume ── */
  function renderVolumes(body) {
    const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Volume baru</span>' });
    add.onclick = () => {
      const n = el('input', { placeholder: 'data-aplikasi' });
      const b = el('button', { class: 'btn pri' }, 'Create');
      b.onclick = async () => {
        try { await api('/volumes', { method: 'POST', body: JSON.stringify({ name: n.value.trim() }) });
          closeDrawer(); toast('Volume dibuat'); load(); } catch (e) { toast(e.message); }
      };
      openDrawer('Volume baru', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Name'), n),
        el('div', { class: 'row' }, b)));
    };
    const tb = el('tbody');
    data.volumes.forEach(v => {
      tb.append(el('tr', {},
        el('td', { class: 'mono' }, v.name),
        el('td', { style: 'color:var(--tx-3)' }, v.driver),
        el('td', { class: 'mono', style: 'color:var(--tx-3);font-size:10.5px' }, v.mount || '—'),
        el('td', {}, delBtn(async () => {
          if (!confirm(`Hapus volume "${v.name}"?\n\nAll data di dalamnya hilang permanen.`)) return;
          try { await api('/volumes/' + encodeURIComponent(v.name), { method: 'DELETE' });
            toast('Volume dihapus'); load(); } catch (e) { toast(e.message); }
        }))));
    });
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'pill' }, `${data.volumes.length} volume`),
        el('span', { class: 'sp' }), add),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Volume'),
          el('th', {}, 'Driver'), el('th', {}, 'Lokasi'), el('th', {}, ''))), tb))));
  }

  /* ── Network ── */
  function renderNetworks(body) {
    const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Network baru</span>' });
    add.onclick = () => {
      const n = el('input', { placeholder: 'apps' });
      const b = el('button', { class: 'btn pri' }, 'Create');
      b.onclick = async () => {
        try { await api('/networks', { method: 'POST', body: JSON.stringify({ name: n.value.trim() }) });
          closeDrawer(); toast('Network dibuat'); load(); } catch (e) { toast(e.message); }
      };
      openDrawer('Network baru', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Name'), n),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Containers on one network reach each other by service name, '
          + 'with no ports opened to your home network.'),
        el('div', { class: 'row' }, b)));
    };
    const bawaan = ['bridge', 'host', 'none'];
    const tb = el('tbody');
    data.networks.forEach(n => {
      const isDefault = bawaan.includes(n.name);
      const conn = el('button', { class: 'ib', title: 'Sambungkan container', html: ic('plus', 14) });
      conn.onclick = () => {
        const sel = el('select', {}, ...data.containers.map(c =>
          el('option', { value: c.name }, c.name)));
        const b = el('button', { class: 'btn pri' }, 'Sambungkan');
        b.onclick = async () => {
          try { await api(`/networks/${n.id}/connect`, { method: 'POST',
            body: JSON.stringify({ container: sel.value }) });
            closeDrawer(); toast('Tersambung'); load(); } catch (e) { toast(e.message); }
        };
        openDrawer('Sambungkan ke ' + n.name, el('div', {},
          el('div', { class: 'field' }, el('label', {}, 'Containers'), sel),
          el('div', { class: 'row' }, b)));
      };
      tb.append(el('tr', {},
        el('td', {}, el('div', { class: 'row' },
          el('span', { class: 'mono' }, n.name),
          isDefault ? el('span', { class: 'pill' }, 'bawaan') : '')),
        el('td', { style: 'color:var(--tx-3)' }, n.driver),
        el('td', { style: 'color:var(--tx-3)' },
          n.containers.length ? n.containers.join(', ') : '—'),
        el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' },
          conn, isDefault ? '' : delBtn(async () => {
            if (!confirm(`Hapus jaringan "${n.name}"?`)) return;
            try { await api('/networks/' + n.id, { method: 'DELETE' });
              toast('Network dihapus'); load(); } catch (e) { toast(e.message); }
          })))));
    });
    body.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'pill' }, `${data.networks.length} jaringan`),
        el('span', { class: 'sp' }), add),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Network'),
          el('th', {}, 'Driver'), el('th', {}, 'Containers'), el('th', {}, ''))), tb))));
  }

  /* ── Cleanup ── */
  function renderCleanup(body) {
    const used = new Set(data.containers.map(c => c.image));
    const imgIdle = data.images.filter(i => !i.tags.length || !i.tags.some(t => used.has(t)));
    const idleSize = imgIdle.reduce((a, i) => a + i.size, 0);
    const netIdle = data.networks.filter(n =>
      !['bridge', 'host', 'none'].includes(n.name) && !n.containers.length);

    const opts = {};
    const optRow = (key, label, detail, checked = true) => {
      opts[key] = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
      opts[key].checked = checked;
      return el('label', { class: 'row', style: 'padding:9px 0;cursor:pointer;font-weight:400' },
        opts[key], el('div', {}, el('div', { style: 'font-size:12.5px;color:var(--tx)' }, label),
          el('div', { style: 'font-size:11.5px;color:var(--tx-3)' }, detail)));
    };

    const go = el('button', { class: 'btn danger', html: ic('trash', 13) + '<span>Clean now</span>' });
    go.onclick = async () => {
      const b = { images: opts.images.checked, volumes: opts.volumes.checked,
        networks: opts.networks.checked, containers: opts.containers.checked };
      if (!Object.values(b).some(Boolean)) return toast('Pilih minimal satu');
      if (!confirm('Continue cleanup?\n\nOnly unused items are removed, '
        + 'but this cannot be undone.')) return;
      go.disabled = true;
      try {
        const r = await api('/prune', { method: 'POST', body: JSON.stringify(b) });
        const freed = (r.images?.SpaceReclaimed || 0) + (r.volumes?.SpaceReclaimed || 0)
          + (r.containers?.SpaceReclaimed || 0);
        toast('Selesai — freed ' + bytes(freed)); load();
      } catch (e) { toast(e.message); } finally { go.disabled = false; }
    };

    body.replaceChildren(
      el('div', { class: 'grid2' },
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'IMAGE MENGANGGUR'),
          el('div', { class: 'v' }, String(imgIdle.length)),
          el('div', { class: 'm' }, bytes(idleSize) + ' can be freed')),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'JARINGAN KOSONG'),
          el('div', { class: 'v' }, String(netIdle.length)),
          el('div', { class: 'm' }, 'no containers attached'))),
      el('div', { class: 'sec' }, 'Choose what to clean'),
      el('div', { class: 'card' }, el('div', { class: 'card-b' },
        optRow('images', 'Unused images', 'Images not used by any container'),
        optRow('containers', 'Container berhenti', 'Stopped containers no longer in use'),
        optRow('networks', 'Empty networks', 'Network no containers attached tersambung'),
        optRow('volumes', 'Idle volumes',
          'CAREFUL: volumes hold app data. Make sure you have a backup.', false),
        el('div', { class: 'row', style: 'margin-top:12px' }, go))));
  }

  async function load() {
    try {
      const [im, vo, ne, co] = await Promise.all([
        api('/images'), api('/volumes'), api('/networks'), api('/containers')]);
      data = { images: im.images, volumes: vo.volumes,
        networks: ne.networks, containers: co.containers };
      T.setCount('images', data.images.length);
      T.setCount('volumes', data.volumes.length);
      T.setCount('networks', data.networks.length);
      render(T.current, T.body);
      $('#sub').textContent = bytes(data.images.reduce((a, i) => a + i.size, 0)) + ' terpakai image';
    } catch (e) { T.body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }
  every(load, 20000);
};

/* ═══════════ Pengrules ═══════════ */
VIEWS.settings = () => {
  const wrap = el('div');
  mount(wrap);

  async function load() {
    const [me, users, sess, aud] = await Promise.all([
      api('/auth/state'), api('/auth/users').catch(() => ({ users: [] })),
      api('/auth/sessions').catch(() => ({ sessions: [], bans: [] })),
      api('/auth/audit?n=120').catch(() => ({ entries: [] })),
    ]);
    const mine = users.users.find(u => u.username === me.user?.username);

    /* 2FA */
    const twoFA = el('div', { class: 'card' }, el('div', { class: 'card-b' }));
    const bodyFA = twoFA.firstChild;
    if (mine?.totp) {
      const off = el('button', { class: 'btn danger' }, 'Disable 2FA');
      off.onclick = async () => {
        if (!confirm('Disable 2FA?')) return;
        await api('/auth/2fa/disable', { method: 'POST' }); toast('2FA disabled'); load();
      };
      bodyFA.append(el('div', { class: 'row' },
        el('span', { class: 'pill ok' }, 'Active'),
        el('span', { style: 'color:var(--tx-2)' }, 'Your account is protected by a 6-digit code.'),
        el('span', { class: 'sp' }), off));
    } else {
      const start = el('button', { class: 'btn pri' }, 'Enable 2FA');
      start.onclick = async () => {
        const { secret, uri } = await api('/auth/2fa/init', { method: 'POST' });
        const code = el('input', { placeholder: '000000', inputmode: 'numeric', maxlength: '6' });
        const ok2 = el('button', { class: 'btn pri' }, 'Verify & enable');
        ok2.onclick = async () => {
          try { await api('/auth/2fa/enable', { method: 'POST',
            body: JSON.stringify({ secret, code: code.value }) });
            toast('2FA enabled'); closeDrawer(); load();
          } catch (e) { toast(e.message); }
        };
        openDrawer('Enable 2FA', el('div', {},
          el('div', { style: 'font-size:12.5px;color:var(--tx-2);margin-bottom:10px' },
            'Buka aplikasi autentikator (Google Authenticator, Aegis, 1Password), '
            + 'pilih tambah manual, lalu masukkan kunci ini:'),
          el('div', { class: 'card' }, el('div', { class: 'card-b mono',
            style: 'font-size:14px;letter-spacing:.12em;word-break:break-all' }, secret)),
          el('div', { style: 'font-size:11px;color:var(--tx-3);margin:10px 0' }, uri),
          el('div', { class: 'field' }, el('label', {}, 'Code from your app'), code),
          el('div', { class: 'row' }, ok2)));
      };
      bodyFA.append(el('div', { class: 'row' },
        el('span', { class: 'pill' }, 'Inactive'),
        el('span', { style: 'color:var(--tx-2)' }, 'Recommended if the panel is reachable from outside your home.'),
        el('span', { class: 'sp' }), start));
    }

    /* Users */
    const utb = el('tbody');
    users.users.forEach(u => {
      const del = el('button', { class: 'ib', html: ic('trash', 14) });
      del.onclick = async () => {
        if (!confirm(`Hapus pengguna "${u.username}"?`)) return;
        try { await api('/auth/users/' + u.id, { method: 'DELETE' }); load(); }
        catch (e) { toast(e.message); }
      };
      const perm = el('button', { class: 'ib', title: 'Manage access', html: ic('lock', 14) });
      perm.onclick = async () => {
        if (u.role === 'admin') return toast('Admin otomatis punya akses full');
        const [dbs, stacksList] = await Promise.all([
          api('/db/instances').catch(() => ({ instances: [], external: [] })),
          api('/stacks').catch(() => ({ stacks: [] }))]);
        const cur = u.perms || { pages: [], dbs: [], stacks: [] };
        const boxes = {};
        const group = (title, entries, key, cursel) => {
          const list = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px' });
          entries.forEach(([val, label]) => {
            const cb = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
            cb.checked = (cursel || []).includes(val);
            (boxes[key] ||= {})[val] = cb;
            list.append(el('label', { class: 'row', style: 'font-weight:400;margin:0;'
              + 'padding:5px 6px;border-radius:5px;cursor:pointer;font-size:12px' }, cb, label));
          });
          return el('div', {}, el('div', { class: 'sec' }, title),
            el('div', { class: 'card' }, el('div', { class: 'card-b' }, list)));
        };
        const save2 = el('button', { class: 'btn pri' }, 'Save access');
        save2.onclick = async () => {
          const pick = (k) => Object.entries(boxes[k] || {})
            .filter(([, cb]) => cb.checked).map(([v]) => v);
          try {
            await api('/auth/users/' + u.id, { method: 'PATCH', body: JSON.stringify({
              perms: { pages: pick('pages'), dbs: pick('dbs'), stacks: pick('stacks') } }) });
            closeDrawer(); toast('Access disimpan'); load();
          } catch (e) { toast(e.message); }
        };
        const allDb = [...(dbs.instances || []), ...(dbs.external || [])];
        openDrawer('Access — ' + u.username, el('div', {},
          el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:6px;line-height:1.6' },
            'Tick only what may be opened. Unticked items are hidden from the menu '
            + 'and still rejected if the URL is typed directly.'),
          group('Page', Object.entries(window.ALL_PAGES || {}), 'pages', cur.pages),
          allDb.length ? group('Databases', allDb.map(d => [d.id, d.name]), 'dbs', cur.dbs) : '',
          (stacksList.stacks || []).length
            ? group('Stack', stacksList.stacks.map(s2 => [s2.name, s2.name]), 'stacks', cur.stacks) : '',
          el('div', { class: 'row', style: 'margin-top:12px' }, save2)));
      };
      const roleSel = el('select', { style: 'height:24px;font-size:11px;max-width:120px' },
        ...Object.entries(window.ALL_ROLES || { superadmin: 'Super Admin' })
          .map(([v, l]) => el('option', { value: v }, l)));
      roleSel.value = u.role;
      roleSel.title = window.ROLE_HELP?.[u.role] || '';
      roleSel.onchange = async () => {
        const to = roleSel.value;
        if (!confirm(`Change ${u.username}'s role to ${to}?`)) { roleSel.value = u.role; return; }
        try {
          await api('/auth/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ role: to }) });
          toast('Role updated — ' + (window.ROLE_HELP?.[to] || '')); load();
        } catch (e) { toast(e.message); roleSel.value = u.role; }
      };
      const pw = el('button', { class: 'ib', title: 'Change password', html: ic('edit', 14) });
      pw.onclick = async () => {
        const p = prompt(`Password baru untuk ${u.username} (min 8 characters):`);
        if (!p) return;
        try { await api('/auth/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ password: p }) });
          toast('Password diperbarui'); } catch (e) { toast(e.message); }
      };
      utb.append(el('tr', {}, el('td', {}, u.username),
        el('td', {}, roleSel),
        el('td', {}, u.totp ? el('span', { class: 'pill ok' }, '2FA') : el('span', { style: 'color:var(--tx-3)' }, '—')),
        el('td', {}, u.role === 'superadmin'
          ? el('span', { class: 'pill ok' }, 'full')
          : el('div', { class: 'row', style: 'gap:5px' },
              el('span', { class: 'pill' }, `${(u.perms?.pages || []).length} pages`),
              u.role === 'viewer' ? el('span', { class: 'pill' }, 'read-only') : '')),
        el('td', { style: 'color:var(--tx-3)' }, u.lastLogin ? ago(u.lastLogin) : 'never'),
        el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, perm, pw, del))));
    });
    const addU = el('button', { class: 'btn', html: ic('plus', 13) + '<span>Add user</span>' });
    addU.onclick = () => {
      const n = el('input'), p = el('input', { type: 'password' });
      const r = el('select', {}, ...Object.entries(window.ALL_ROLES
        || { viewer: 'Viewer' }).map(([v, l]) => el('option', { value: v }, l)));
      r.value = 'viewer';
      const b = el('button', { class: 'btn pri' }, 'Create');
      b.onclick = async () => {
        try { await api('/auth/users', { method: 'POST',
          body: JSON.stringify({ username: n.value, password: p.value, role: r.value }) });
          closeDrawer(); toast('Users dibuat'); load(); } catch (e) { toast(e.message); }
      };
      const help = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' });
      const syncHelp = () => { help.textContent = window.ROLE_HELP?.[r.value] || ''; };
      r.onchange = syncHelp; syncHelp();
      openDrawer('Add user', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Username'), n),
        el('div', { class: 'field' }, el('label', {}, 'Password'), p),
        el('div', { class: 'field' }, el('label', {}, 'Role'), r),
        help,
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
          'A new account starts with only the Overview page. Grant the rest with '
          + 'the lock icon after creating it.'),
        el('div', { class: 'row' }, b)));
    };

    /* Sesi & blokir */
    const stb = el('tbody', {}, ...sess.sessions.map(s => el('tr', {},
      el('td', {}, s.username), el('td', { class: 'mono' }, s.ip),
      el('td', { style: 'color:var(--tx-3)' }, ago(s.at)),
      el('td', { style: 'color:var(--tx-3)' }, ago(s.seen)))));
    const bans = sess.bans.length
      ? el('div', { class: 'card-b' }, ...sess.bans.map(b =>
          el('div', { class: 'row' }, el('i', { class: 'dot down' }),
            el('span', { class: 'mono' }, b.ip),
            el('span', { style: 'color:var(--tx-3)' },
              'blocked until ' + new Date(b.until).toLocaleTimeString('id-ID')))))
      : el('div', { class: 'empty', style: 'padding:22px' }, 'No blocked IPs');

    /* Audit */
    const atb = el('tbody', {}, ...aud.entries.map(a => el('tr', {},
      el('td', { style: 'color:var(--tx-3);white-space:nowrap' },
        new Date(a.t).toLocaleString('id-ID')),
      el('td', {}, a.user), el('td', {}, el('span', { class: 'pill' }, a.action)),
      el('td', { class: 'mono', style: 'color:var(--tx-3)' }, a.detail || ''))));

    /* Power */
    const power = (act, label) => {
      const b = el('button', { class: 'btn danger' }, label);
      b.onclick = async () => {
        if (!confirm(`${label} server sekarang? Panel akan terputus.`)) return;
        try { await api('/system/power', { method: 'POST', body: JSON.stringify({ action: act }) });
          toast('Command sent'); } catch (e) { toast(e.message); }
      };
      return b;
    };

    wrap.replaceChildren(
      el('div', { class: 'sec' }, 'Two-factor authentication'), twoFA,
      el('div', { class: 'sec' }, `Users (${users.users.length})`),
      el('div', { class: 'card' },
        el('div', { class: 'tbl-wrap', style: 'max-height:30vh' },
          el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Users'),
            el('th', {}, 'Role'), el('th', {}, '2FA'), el('th', {}, 'Access'),
            el('th', {}, 'Last login'), el('th', {}, ''))), utb)),
        el('div', { class: 'card-b' }, addU)),
      el('div', { class: 'sec' }, 'Active sessions'),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:26vh' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Users'),
          el('th', {}, 'IP'), el('th', {}, 'Started'), el('th', {}, 'Last seen'))), stb))),
      el('div', { class: 'sec' }, 'Blocked IPs'), el('div', { class: 'card' }, bans),
      el('div', { class: 'sec' }, 'Activity log'),
      el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:38vh' },
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'),
          el('th', {}, 'Users'), el('th', {}, 'Action'), el('th', {}, 'Details'))), atb))),
      await (typeof thresholdCard === 'function' ? thresholdCard() : Promise.resolve('')),
      el('div', { class: 'sec' }, 'Power'),
      el('div', { class: 'card' }, el('div', { class: 'card-b' },
        el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:10px' },
          'This shuts down or reboots the whole server laptop. '
          + 'Everything running will stop.'),
        el('div', { class: 'row' }, power('reboot', 'Reboot'), power('poweroff', 'Disable')))),
    );
  }
  load().catch(e => wrap.replaceChildren(el('div', { class: 'empty' }, e.message)));
};
