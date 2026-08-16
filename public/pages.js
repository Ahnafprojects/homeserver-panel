'use strict';
/* Page gelombang 2: Stack, Terminal, Sumber daya Docker, Pengrules.
   Memakai helper yang sudah ada di app.js (el, api, ic, toast, dst). */

/* ═══════════ Stack: compose editor + git ═══════════ */
VIEWS.stacks = () => {
  let all = [], q = '';
  const wrap = el('div');
  const search = searchBox('Cari stack…', v => { q = v; render(); });
  mount(el('div', {}, el('div', { class: 'row', style: 'margin-bottom:10px' }, search), wrap));

  addAction('Deploy website', 'rocket', () => formAuto(), 'btn pri');
  addAction('From Git', 'down', () => formGit(), 'btn');
  addAction('New stack', 'plus', () => formCompose());
  addAction('Refresh', 'refresh', () => load());

  // Sama persis kayak aturan safeName() di stacks.js (server) — biar folder
  // yang dibuka terminal cocok sama folder stack yang beneran dipakai
  // server, sekalipun nama yang diketik user ada huruf besar/karakter aneh.
  const safeStackName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '');

  // Terminal langsung di jendela log deploy — kalau gagal (mis. bug di
  // docker-compose.yml hasil generate otomatis), tidak perlu pindah ke
  // menu Terminal terus cari-cari direktorinya sendiri; direktori kerjanya
  // sudah otomatis di folder stack ini.
  function embedTerminal(container, stackName) {
    if (!window.Terminal || !window.FitAddon) {
      container.replaceChildren(el('div', { style: 'padding:10px;font-size:11.5px;color:#8b91a0' },
        'Komponen terminal belum siap, tunggu sebentar lalu buka lagi.'));
      return;
    }
    container.style.position = 'relative';
    const box = el('div', { style: 'position:absolute;inset:0;padding:6px' });
    container.append(box);
    // Sama kayak fontSizeFor di fitur Terminal utama — 12px tetap kekecilan
    // di drawer yang sekarang sudah lebih lebar (lihat .drawer.wide), dan
    // TUI kayak Claude Code butuh cukup kolom biar ketikan/layar-nya
    // kegambar bener, bukan cuma nyempil di kotak kecil.
    const fontSizeFor = () => innerWidth < 560 ? 11 : innerWidth < 820 ? 12 : 13;
    let curFontSize = fontSizeFor();
    const term = new Terminal({ fontSize: curFontSize, fontFamily: 'ui-monospace,Menlo,monospace',
      cursorBlink: true, scrollback: 3000,
      theme: { background: '#0b0c0f', foreground: '#d6dae1', cursor: '#5b8def' } });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(box);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const cwd = `/srv/stacks/${safeStackName(stackName)}`;
    const sock = new WebSocket(`${proto}://${location.host}/ws/term?cwd=${encodeURIComponent(cwd)}`);
    sock.binaryType = 'arraybuffer';
    sock.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    sock.onclose = () => term.write('\r\n\x1b[90m— sesi berakhir —\x1b[0m\r\n');
    term.onData(d => sock.readyState === 1 && sock.send(d));
    term.onResize(({ rows, cols }) => sock.readyState === 1 && sock.send(`\x00resize:${rows},${cols}`));
    // Balapan yang bikin ketikan tidak kegambar: fit() pertama (dipicu box
    // yang baru kelihatan) hampir selalu terjadi SEBELUM WebSocket-nya
    // selesai connect, jadi pesan resize itu diam-diam kebuang (cek di atas
    // gagal) dan PTY di server nyangkut di ukuran default — TUI kayak
    // Claude Code lalu gambar berdasar ukuran yang salah itu. Begitu socket
    // resmi kebuka, kirim ukuran yang BENERAN aktual sekarang juga —
    // tidak nunggu onResize nge-fire lagi (itu cuma jalan kalau ukurannya
    // BERUBAH dari sebelumnya, yang belum tentu kejadian kalau box-nya
    // sudah kepas dari fit() pertama tadi).
    sock.onopen = () => {
      try { fitAddon.fit(); sock.send(`\x00resize:${term.rows},${term.cols}`); } catch {}
    };
    const ro = new ResizeObserver(() => {
      const fs = fontSizeFor();
      if (fs !== curFontSize) { curFontSize = fs; term.options.fontSize = fs; }
      try { fitAddon.fit(); } catch {}
    });
    ro.observe(box);
    box.onclick = () => term.focus();
    timers.push({ close: () => { ro.disconnect(); sock?.close(); term?.dispose(); } });
    setTimeout(() => { try { fitAddon.fit(); term.focus(); } catch {} }, 30);
  }

  function logDrawer(title, stackName) {
    // Drawer normal (660px) kekecilan buat jalanin CLI TUI kayak Claude Code
    // di terminalnya — lebarin drawer-nya juga, bukan cuma tinggi kotaknya.
    $('#drawer').classList.toggle('wide', !!stackName);
    const box = el('div', { class: 'logbox', style: `height:${stackName ? '40vh' : '70vh'}` });
    const children = [box];
    if (stackName) {
      const termWrap = el('div', { style: 'display:none;height:38vh;margin-top:8px;'
        + 'border-radius:8px;overflow:hidden;background:#0b0c0f' });
      let started = false;
      const btnTerm = el('button', { class: 'btn', style: 'margin-top:8px',
        html: ic('term', 13) + '<span>Buka Terminal di folder stack ini</span>' });
      btnTerm.onclick = () => {
        const open2 = termWrap.style.display === 'none';
        termWrap.style.display = open2 ? 'block' : 'none';
        btnTerm.querySelector('span').textContent = open2
          ? 'Tutup Terminal' : 'Buka Terminal di folder stack ini';
        // Muncul lagi dari display:none -> block sudah cukup buat memicu
        // ResizeObserver di dalam embedTerminal sendiri (ukurannya berubah
        // dari 0x0 ke ukuran sebenarnya) — tidak perlu dipicu manual di sini.
        if (open2 && !started) { started = true; embedTerminal(termWrap, stackName); }
      };
      children.push(btnTerm, termWrap);
    }
    openDrawer(title, el('div', {}, ...children));
    return {
      line: (t) => { box.append(el('span', { class: 'l' }, t)); box.scrollTop = box.scrollHeight; },
      done: (c) => box.append(el('span', { class: 'l',
        style: `color:${c === 0 ? 'var(--ok)' : 'var(--bad)'}` },
        c === 0 ? '\n✓ selesai' : `\n✗ failed (kode ${c})`)),
    };
  }

  function stream(url, title, after, stackName) {
    const d = logDrawer(title, stackName);
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
        stream(`/api/stacks/${encodeURIComponent(r.n)}/deploy`, 'Deploy — ' + r.n, null, r.n);
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
    const isPrivate = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
    const token = el('input', { type: 'password', placeholder: 'ghp_xxxxxxxxxxxx (personal access token)' });
    const tokenField = el('div', { class: 'field', style: 'display:none' },
      el('label', {}, 'Token akses'), token,
      el('div', { style: 'font-size:11px;color:var(--tx-3)' },
        'GitHub: Settings → Developer settings → Personal access tokens (scope "repo"). '
        + 'GitLab: User Settings → Access Tokens (scope "read_repository"). '
        + 'Token tidak disimpan — cuma dipakai sekali saat clone, ditempel ke URL repo secara otomatis.'),
      el('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:4px' },
        'Kalau URL repo pakai ssh:// atau git@ (bukan https://), token ini tidak berlaku — '
        + 'server harus punya SSH key yang sudah didaftarkan ke akun Git kamu.'));
    isPrivate.onchange = () => { tokenField.style.display = isPrivate.checked ? '' : 'none'; };

    const go = el('button', { class: 'btn pri', html: ic('down', 13) + '<span>Clone</span>' });
    go.onclick = () => {
      const n = (name.value || '').trim();
      let r = (repo.value || '').trim();
      if (!n || !r) return toast('Name and URL are required');
      if (isPrivate.checked && token.value.trim() && /^https:\/\//i.test(r)) {
        r = r.replace(/^https:\/\//i, `https://${encodeURIComponent(token.value.trim())}@`);
      }
      stream(`/api/stacks/${encodeURIComponent(n)}/clone?repo=${encodeURIComponent(r)}`
        + `&branch=${encodeURIComponent(branch.value || '')}`, 'Clone — ' + n, null, n);
    };
    openDrawer('Clone from Git', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Nama stack'), name),
      el('div', { class: 'field' }, el('label', {}, 'URL repositori'), repo),
      el('div', { class: 'field' }, el('label', {}, 'Branch'), branch),
      el('label', { class: 'row', style: 'cursor:pointer;font-weight:400;margin-bottom:10px' },
        isPrivate, 'Ini repo privat'),
      tokenField,
      el('div', { class: 'row' }, go)));
  }

  // Deploy otomatis: clone, deteksi jenis project-nya, lalu bikinkan
  // Dockerfile + docker-compose.yml sendiri — pengguna tidak perlu menulis
  // YAML apa pun buat kasus paling umum (satu repo, satu website).
  function formAuto() {
    const name = el('input', { placeholder: 'nama-stack' });
    const repo = el('input', { placeholder: 'https://github.com/pengguna/repo.git' });
    const branch = el('input', { placeholder: 'main (opsional)' });
    const isPrivate = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
    const token = el('input', { type: 'password', placeholder: 'ghp_xxxxxxxxxxxx (personal access token)' });
    const tokenField = el('div', { class: 'field', style: 'display:none' },
      el('label', {}, 'Token akses'), token);
    isPrivate.onchange = () => { tokenField.style.display = isPrivate.checked ? '' : 'none'; };

    const go = el('button', { class: 'btn pri', html: ic('rocket', 13) + '<span>Clone & deteksi</span>' });
    const msg = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:8px;min-height:16px' });
    go.onclick = () => {
      const n = (name.value || '').trim();
      let r = (repo.value || '').trim();
      if (!n || !r) return toast('Nama dan URL wajib diisi');
      if (isPrivate.checked && token.value.trim() && /^https:\/\//i.test(r)) {
        r = r.replace(/^https:\/\//i, `https://${encodeURIComponent(token.value.trim())}@`);
      }
      go.disabled = true; msg.textContent = 'Cloning…'; msg.style.color = 'var(--tx-3)';
      const es = new EventSource(`/api/stacks/${encodeURIComponent(n)}/clone?repo=${encodeURIComponent(r)}`
        + `&branch=${encodeURIComponent(branch.value || '')}`);
      es.addEventListener('done', async (e) => {
        es.close();
        if (+e.data !== 0) { msg.style.color = 'var(--bad)'; msg.textContent = 'Clone gagal (kode ' + e.data + ')';
          go.disabled = false; return; }
        msg.textContent = 'Mendeteksi jenis project…';
        try {
          const det = await api(`/stacks/${encodeURIComponent(n)}/detect`);
          closeDrawer(); showAutoConfirm(n, det);
        } catch (err) { msg.style.color = 'var(--bad)'; msg.textContent = err.message; go.disabled = false; }
      });
      es.onerror = () => { es.close(); msg.style.color = 'var(--bad)'; msg.textContent = 'Clone gagal'; go.disabled = false; };
    };
    openDrawer('Deploy website (otomatis)', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Nama stack'), name),
      el('div', { class: 'field' }, el('label', {}, 'URL repositori'), repo),
      el('div', { class: 'field' }, el('label', {}, 'Branch'), branch),
      el('label', { class: 'row', style: 'cursor:pointer;font-weight:400;margin-bottom:10px' },
        isPrivate, 'Ini repo privat'),
      tokenField,
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
        'Panel akan clone repo-nya, lalu mendeteksi otomatis jenis project-nya (Next.js, Vite, '
        + 'Create React App, Node, atau situs statis) dan bikinkan Dockerfile + docker-compose.yml '
        + 'sendiri — kamu tinggal konfirmasi port (dan environment variable kalau perlu) di langkah berikutnya.'),
      el('div', { class: 'row' }, go), msg));
  }

  function showAutoConfirm(name, det) {
    // Port dicari otomatis (dan sekarang beneran dicek ke laptopnya, bukan
    // cuma di dalam container panel — lihat findFreePort di autodeploy.js),
    // dan kalaupun ternyata masih bentrok pas deploy jalan (jarang, tapi
    // ada celah balapan kecil), server otomatis coba port lain sendiri
    // tanpa perlu bolak-balik ke sini. Jadi field-nya disembunyikan secara
    // default — kebanyakan orang tidak perlu mikirin nomor port sama
    // sekali — tapi tetap bisa diubah manual lewat "Ubah port" kalau
    // memang mau nge-pin ke port tertentu (mis. buat reverse proxy lain).
    const port = el('input', { value: det.suggestedPort, inputmode: 'numeric', style: 'display:none' });
    const portField = el('div', { class: 'field', style: 'display:none' },
      el('label', {}, 'Port di laptop (host)'), port);
    const portNote = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
      `Port dicari otomatis (sekarang: ${det.suggestedPort}) — kalau ternyata bentrok pas deploy, `
        + 'server coba port lain sendiri. ',
      (() => {
        const a = el('a', { style: 'cursor:pointer;color:var(--acc)' }, 'Ubah port manual');
        a.onclick = () => { portNote.style.display = 'none'; portField.style.display = ''; port.style.display = ''; };
        return a;
      })());
    const envBox = el('textarea', { rows: 4, spellcheck: 'false',
      placeholder: 'DATABASE_URL=postgres://user:pass@host:5432/db\nNEXT_PUBLIC_API_URL=https://...' });
    const isBuildTime = det.type === 'next-static' || det.type === 'static-build';
    const deployBtn = el('button', { class: 'btn pri', html: ic('play', 13) + '<span>Deploy sekarang</span>' });
    deployBtn.onclick = () => {
      const p = +port.value;
      if (!Number.isInteger(p) || p < 1 || p > 65535) return toast('Port tidak valid');
      const envVars = {};
      envBox.value.split('\n').forEach(line => {
        const i = line.indexOf('=');
        if (i > 0) envVars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      closeDrawer();
      stream(`/api/stacks/${encodeURIComponent(name)}/autodeploy?port=${p}`
        + `&env=${encodeURIComponent(JSON.stringify(envVars))}`, 'Deploy otomatis — ' + name, null, name);
    };
    openDrawer('Terdeteksi: ' + det.label, el('div', {},
      el('div', { class: 'pill ok', style: 'margin-bottom:14px' }, det.label),
      portNote, portField,
      el('div', { class: 'field' }, el('label', {}, 'Environment variable (opsional — satu per baris, KEY=nilai)'), envBox),
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
        isBuildTime
          ? 'Environment variable ini dipakai SAAT BUILD (mis. koneksi database buat generate halaman statis) — '
            + 'tidak tersimpan di dalam image jadinya, cuma dipakai sesaat pas build.'
          : 'Environment variable ini dipakai SAAT APLIKASI JALAN (bisa diubah lagi lewat Edit stack nanti).'),
      el('div', { class: 'row' }, deployBtn)));
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
        mk('Deploy', 'play', () => stream(`/api/stacks/${s.name}/deploy`, 'Deploy — ' + s.name, null, s.name), 'btn pri'),
        mk('Stop', 'stop', () => stream(`/api/stacks/${s.name}/stop`, 'Stop — ' + s.name, null, s.name)),
        mk('Edit', 'edit', () => formCompose(st)),
        mk('Delete', 'trash', async () => {
          if (!confirm(`Hapus stack "${s.name}" beserta volume-nya?`)) return;
          await api('/stacks/' + s.name, { method: 'DELETE' });
          closeDrawer(); toast('Stack dihapus'); load();
        }, 'btn danger'));
      body.append(acts);

      // ── Subdomain lewat Cloudflare Tunnel ──
      try {
        const [tData, cData] = await Promise.all([api('/tunnel/sites'), api('/containers')]);
        const stackContainers = cData.containers.filter(c => c.compose === s.name);
        const mySites = tData.sites.filter(x => stackContainers.some(c => c.name === x.target));

        const listArea = el('div');
        function paintList() {
          listArea.replaceChildren(mySites.length
            ? el('div', { class: 'card' }, el('table', {}, el('tbody', {},
                ...mySites.map(site => {
                  const open = el('a', { class: 'ib', title: 'Buka', html: ic('search', 14),
                    href: 'https://' + site.hostname, target: '_blank' });
                  const del = el('button', { class: 'ib', html: ic('trash', 14) });
                  del.onclick = async () => {
                    if (!confirm(`Hapus subdomain ${site.hostname}?`)) return;
                    try { await api('/tunnel/sites/' + site.id, { method: 'DELETE' });
                      mySites.splice(mySites.indexOf(site), 1); paintList();
                      toast('Subdomain dihapus'); } catch (e) { toast(e.message); }
                  };
                  return el('tr', {}, el('td', { class: 'mono' }, site.hostname),
                    el('td', { class: 'mono', style: 'color:var(--tx-3)' }, `${site.target}:${site.port}`),
                    el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, open, del)));
                }))))
            : el('div', { class: 'card' }, el('div', { class: 'empty', style: 'padding:14px' },
                'Belum ada subdomain untuk stack ini.')));
        }
        paintList();

        const portOptions = stackContainers.flatMap(c => (c.ports || []).map(p2 => {
          const [hostPort] = p2.split(':');
          return { value: `${c.name}|${hostPort}`, label: `${c.name} (port ${hostPort})` };
        }));

        // Nama stack ditempel di depan label (toko-backend.domain), bukan
        // langsung "backend.domain" — biar tiap project punya "namespace"
        // sendiri, tanpa semua service numpang rata di satu tingkat
        // subdomain. Dipisah pakai STRIP, bukan titik — subdomain 2 tingkat
        // (backend.toko.domain) butuh sertifikat wildcard tambahan yang
        // tidak dicakup paket gratis Cloudflare, jadi TLS-nya gagal total.
        const deriveLabel = (cName) => {
          let l = cName === s.name ? 'app'
            : cName.startsWith(s.name + '-') ? cName.slice(s.name.length + 1) : cName;
          l = l.replace(/[^a-z0-9-]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
          return l || 'app';
        };
        let addForm = '';
        if (portOptions.length) {
          const prefix = el('span', { style: 'color:var(--tx-3);white-space:nowrap' }, s.name + '-');
          const labelInp = el('input', { value: deriveLabel(portOptions[0].value.split('|')[0]),
            placeholder: 'backend', style: 'max-width:130px' });
          const suffix = el('span', { style: 'color:var(--tx-3);white-space:nowrap' }, '.' + tData.baseDomain);
          const portSel = el('select', {}, ...portOptions.map(o => el('option', { value: o.value }, o.label)));
          portSel.onchange = () => { labelInp.value = deriveLabel(portSel.value.split('|')[0]); };
          const addBtn = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Buat subdomain</span>' });
          addBtn.onclick = async () => {
            const [target, port] = portSel.value.split('|');
            addBtn.disabled = true;
            try {
              const r = await api('/tunnel/sites', { method: 'POST', body: JSON.stringify({
                label: labelInp.value.trim(), target, port, project: s.name }) });
              toast(r.warning || `${r.site.hostname} dibuat`);
              mySites.push(r.site); paintList();
              // Otomatis isi juga "Domain publik" di detail container itu, biar konsisten.
              if (r.dns?.ok) await api(`/containers/${encodeURIComponent(target)}/link`,
                { method: 'POST', body: JSON.stringify({ url: `https://${r.site.hostname}` }) }).catch(() => {});
            } catch (e) { toast(e.message); } finally { addBtn.disabled = false; }
          };
          addForm = el('div', { class: 'card', style: 'padding:12px' },
            el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;align-items:center' },
              prefix, labelInp, suffix, portSel, addBtn));
        } else {
          addForm = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:6px' },
            'Deploy stack ini dulu (dengan port dipublikasikan) sebelum bisa dibikinkan subdomain.');
        }

        body.append(el('div', { class: 'sec' }, 'Subdomain (Cloudflare Tunnel)'), listArea, addForm);
      } catch { /* kalau gagal ambil data tunnel, cukup lewati bagian ini */ }

      if (s.source === 'git') {
        const g = await api(`/stacks/${s.name}/git`).catch(() => null);
        if (g) {
          const sel = el('select', {}, ...g.branches.map(b => el('option', { value: b }, b)));
          sel.value = g.current;
          const sw = el('button', { class: 'btn' }, 'Pindah');
          sw.onclick = () => stream(`/api/stacks/${s.name}/checkout?ref=${encodeURIComponent(sel.value)}`,
            'Checkout — ' + sel.value, null, s.name);
          const pull = el('button', { class: 'btn', html: ic('down', 13) + '<span>Tarik update</span>' });
          pull.onclick = () => stream(`/api/stacks/${s.name}/pull`, 'Pull — ' + s.name, null, s.name);
          const tb = el('tbody');
          g.log.forEach(c => {
            const rb = el('button', { class: 'ib', title: 'Kembali ke commit ini', html: ic('restart', 13) });
            rb.onclick = () => confirm(`Kembali ke commit ${c.hash}?`) &&
              stream(`/api/stacks/${s.name}/checkout?ref=${c.hash}`, 'Rollback — ' + c.hash, null, s.name);
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
    try { all = (await api('/stacks')).stacks; render(); }
    catch (e) { wrap.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  function render() {
    try {
      if (!all.length) {
        wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty',
          html: ic('box', 30, 1.3) + '<div>No stacks yet</div>' +
            '<div style="font-size:11.5px;margin-top:6px">Buat dari compose, atau clone dari Git.</div>' })));
        return;
      }
      const list = all.filter(s => matches(q, s.name, s.repo, s.branch));
      if (!list.length) {
        wrap.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'empty', html: ic('search', 30, 1.3) + '<div>No matching stacks</div>' })));
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
  let sessions = [], activeId = null, seq = 0;
  const activeSession = () => sessions.find(s => s.id === activeId) || null;

  const tabBar = el('div', { style: 'height:30px;flex:0 0 30px;display:flex;align-items:center;'
    + 'gap:2px;padding:0 6px;background:var(--surface);border-bottom:1px solid var(--line);'
    + 'overflow-x:auto' });
  const addBtn = el('button', { class: 'ib', title: 'Terminal baru', html: ic('plus', 13) });
  addBtn.onclick = () => addSession();

  const sel = el('select', { style: 'max-width:260px' },
    el('option', { value: '' }, 'Shell host (mesin server)'));

  // Layar HP jauh lebih pendek dari laptop — kotak tempel/salin di bawah
  // bisa habiskan separuh layar. Sembunyikan di belakang tombol toggle
  // secara default di layar sempit supaya terminal dapat ruang paling besar,
  // tapi tetap kebuka di desktop seperti biasa.
  const isNarrow = () => innerWidth < 820;
  let ioOpen = !isNarrow();
  // Font tetap 12.5px berapa pun besar layarnya bikin terlihat "kecil" di
  // laptop lebar (banyak ruang kosong terbuang) dan kepadatan/kolom
  // berantakan di HP. Skalakan ke lebar layar, dan sesuaikan lagi tiap
  // resize/putar HP (lewat handleResize di bawah).
  const fontSizeFor = () => innerWidth < 560 ? 12.5 : innerWidth < 820 ? 13.5 : 15.5;
  let curFontSize = fontSizeFor();
  const btnIO = el('button', { class: 'tg', title: 'Tampilkan/sembunyikan kotak tempel & salin teks' },
    'Tempel/Salin');

  // Form copy/paste manual — Clipboard API browser butuh HTTPS + izin dan
  // sering gagal diam-diam (terutama akses LAN via http://). Textarea biasa
  // selalu bisa di-paste/copy pakai klik-kanan atau Ctrl+C/V bawaan OS,
  // tidak tergantung izin apa pun.
  const pasteBox = el('textarea', { rows: '2', placeholder: 'Tempel teks di sini (klik kanan atau Ctrl+V), lalu klik Kirim →',
    style: 'flex:1;resize:vertical;font-family:var(--mono);font-size:11.5px;padding:6px 8px;min-width:160px' });
  const btnSend = el('button', { class: 'btn pri' }, 'Kirim →');
  const copyBox = el('textarea', { rows: '2', readonly: '', placeholder: '(pilih teks di terminal, hasilnya muncul di sini)',
    style: 'flex:1;resize:vertical;font-family:var(--mono);font-size:11.5px;padding:6px 8px;min-width:160px' });
  const btnCopy = el('button', { class: 'btn' }, 'Salin');
  btnSend.onclick = () => {
    const s = activeSession();
    if (pasteBox.value && s?.ws?.readyState === 1) { s.ws.send(pasteBox.value); pasteBox.value = ''; }
  };
  btnCopy.onclick = () => {
    copyBox.focus(); copyBox.select();
    try { document.execCommand('copy'); toast('Tersalin'); } catch {}
  };
  const ioRow = el('div', { class: 'row', style: 'padding:8px 14px;border-bottom:1px solid var(--line);'
    + 'background:var(--surface);gap:8px;flex-wrap:wrap' },
    pasteBox, btnSend,
    el('div', { style: 'width:1px;align-self:stretch;background:var(--line)' }),
    copyBox, btnCopy);
  function paintIO() {
    ioRow.style.display = ioOpen ? '' : 'none';
    btnIO.classList.toggle('on', ioOpen);
    // Ukuran host berubah begitu baris ini disembunyikan/dimunculkan —
    // xterm perlu di-fit ulang biar tidak nyisa area kosong/terpotong.
    setTimeout(() => { try { activeSession()?.fit.fit(); } catch {} }, 30);
  }
  btnIO.onclick = () => { ioOpen = !ioOpen; paintIO(); };

  const host = el('div', { style: 'flex:1;min-height:0;position:relative;background:#0b0c0f' });

  // Baris tombol tombol khusus — HP sering tidak kirim Enter/Tab/Esc dengan
  // benar lewat keyboard virtualnya (event-nya beda dari keyboard fisik),
  // jadi kirim langsung byte-nya ke terminal, tidak lewat event keyboard.
  const keyBtn = (label, bytes, title) => {
    const b = el('button', { class: 'btn', title: title || label,
      style: 'height:30px;padding:0 10px;font-size:12px;flex:0 0 auto' }, label);
    b.onclick = () => { const s = activeSession(); if (s?.ws?.readyState === 1) s.ws.send(bytes); };
    return b;
  };
  const keyBar = el('div', { class: 'row', style: 'padding:6px 14px;border-bottom:1px solid var(--line);'
    + 'background:var(--surface);gap:6px;overflow-x:auto;flex-wrap:nowrap' },
    keyBtn('Esc', '\x1b'), keyBtn('Tab', '\t'), keyBtn('Ctrl+C', '\x03', 'Hentikan proses'),
    keyBtn('↑', '\x1b[A', 'Riwayat sebelumnya'), keyBtn('↓', '\x1b[B'),
    keyBtn('←', '\x1b[D'), keyBtn('→', '\x1b[C'),
    keyBtn('Enter ↵', '\r', 'Kirim Enter — pakai ini kalau keyboard HP tidak mengirim Enter'));

  mount(el('div', { style: 'display:flex;flex-direction:column;height:100%' },
    tabBar,
    el('div', { class: 'row', style: 'padding:10px 14px;border-bottom:1px solid var(--line);'
      + 'background:var(--surface)' },
      el('div', { style: 'max-width:280px;flex:1' }, sel), el('span', { class: 'sp' }), btnIO),
    keyBar,
    ioRow,
    host), { full: true });
  paintIO();

  function renderTabs() {
    const tabs = sessions.map((s, i) => {
      const on = s.id === activeId;
      const tab = el('div', { style: 'display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;'
        + `height:24px;border-radius:4px;cursor:pointer;font-size:11.5px;white-space:nowrap;`
        + `color:${on ? 'var(--tx)' : 'var(--tx-3)'};background:${on ? 'var(--sunken)' : 'transparent'}` },
        `Terminal ${i + 1}`);
      tab.onclick = () => selectTab(s.id);
      const close = el('span', { title: 'Tutup', style: 'opacity:.65;padding:2px 4px;line-height:1;'
        + 'border-radius:3px' }, '×');
      close.onmouseenter = () => close.style.background = 'var(--line)';
      close.onmouseleave = () => close.style.background = '';
      close.onclick = (e) => { e.stopPropagation(); closeSession(s.id); };
      tab.append(close);
      return tab;
    });
    tabBar.replaceChildren(...tabs, addBtn);
  }

  function selectTab(id) {
    activeId = id;
    sessions.forEach(s => { s.box.style.display = s.id === id ? 'block' : 'none'; });
    const s = activeSession();
    sel.value = s?.target || '';
    renderTabs();
    if (s) setTimeout(() => { try { s.fit.fit(); s.term.focus(); } catch {} }, 30);
  }

  function connectSession(s) {
    s.ws?.close();
    s.term.reset();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const c = s.target ? `?container=${encodeURIComponent(s.target)}` : '';
    s.ws = new WebSocket(`${proto}://${location.host}/ws/term${c}`);
    s.ws.binaryType = 'arraybuffer';
    s.ws.onmessage = e => s.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    s.ws.onclose = () => s.term.write('\r\n\x1b[90m— sesi berakhir —\x1b[0m\r\n');
    // fit() yang jalan sebelum WS ini kebuka (biasa terjadi pas tab baru
    // dibikin/dipilih) ngirim resize duluan lalu kebuang diam-diam (socket
    // belum readyState 1). Kirim ukuran yang aktual sekarang begitu socket
    // resmi kebuka, jangan cuma andalkan onResize (yang cuma jalan kalau
    // ukurannya berubah lagi setelah itu).
    s.ws.onopen = () => {
      try { s.fit.fit(); s.ws.send(`\x00resize:${s.term.rows},${s.term.cols}`); } catch {}
    };
  }

  function addSession(target = '') {
    const id = ++seq;
    const box = el('div', { style: 'position:absolute;inset:0;padding:6px;display:none' });
    host.append(box);
    const term = new Terminal({ fontSize: curFontSize, fontFamily: 'ui-monospace,Menlo,monospace',
      cursorBlink: true, scrollback: 4000,
      theme: { background: '#0b0c0f', foreground: '#d6dae1', cursor: '#5b8def' } });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit); term.open(box);
    const s = { id, term, fit, ws: null, box, target };
    term.onData(d => s.ws?.readyState === 1 && s.ws.send(d));
    term.onResize(({ rows, cols }) => s.ws?.readyState === 1 && s.ws.send(`\x00resize:${rows},${cols}`));
    // Isi kotak "Salin" tiap kali seleksi berubah — andalan utama untuk copy,
    // tidak butuh izin Clipboard API (yang sering gagal diam-diam di http://).
    // Clipboard API tetap dicoba sebagai bonus kalau browser mengizinkan.
    term.onSelectionChange(() => {
      if (activeId !== s.id) return;
      const t = term.getSelection();
      copyBox.value = t || '';
      if (t) navigator.clipboard?.writeText(t).catch(() => {});
    });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(box);
    s.ro = ro;
    timers.push({ close: () => { ro.disconnect(); s.ws?.close(); s.term?.dispose(); } });
    sessions.push(s);
    connectSession(s);
    selectTab(id);
  }

  function closeSession(id) {
    const idx = sessions.findIndex(x => x.id === id);
    if (idx < 0) return;
    const s = sessions[idx];
    s.ro?.disconnect(); s.ws?.close(); s.term?.dispose(); s.box.remove();
    sessions.splice(idx, 1);
    if (activeId === id) {
      const next = sessions[idx] || sessions[idx - 1];
      if (next) selectTab(next.id);
      else { activeId = null; renderTabs(); }
    } else renderTabs();
  }

  // Ganti ukuran font tiap kali layar melewati salah satu breakpoint di
  // fontSizeFor (mis. HP diputar landscape, atau jendela browser laptop
  // di-resize) — bukan tiap event resize, biar tidak fit() berkali-kali
  // sia-sia saat ukurannya belum lintas ambang batas.
  function handleResize() {
    const fs = fontSizeFor();
    if (fs === curFontSize) return;
    curFontSize = fs;
    sessions.forEach(s => { s.term.options.fontSize = fs; try { s.fit.fit(); } catch {} });
  }
  addEventListener('resize', handleResize);
  timers.push({ close: () => removeEventListener('resize', handleResize) });

  // TIDAK mencegat Ctrl+V — biarkan xterm.js pakai event 'paste' native
  // browser (klik kanan / Ctrl+V ke textarea tersembunyinya). Itu tidak
  // butuh izin Clipboard API sama sekali dan lebih bisa diandalkan.
  host.onclick = () => activeSession()?.term.focus();
  sel.onchange = () => {
    const s = activeSession();
    if (!s) return;
    s.target = sel.value;
    connectSession(s);
    renderTabs();
  };

  api('/containers').then(({ containers }) => {
    containers.filter(c => c.state === 'running').forEach(c =>
      sel.append(el('option', { value: c.id }, 'Container: ' + c.name)));
  }).catch(() => {});

  if (window.Terminal) addSession();
  else {
    host.append(el('div', { style: 'color:#8b91a0;padding:14px;font-size:12.5px' }, 'Memuat terminal…'));
    const t = setInterval(() => { if (window.Terminal) { clearInterval(t); addSession(); } }, 120);
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
    { id: 'diskuse', n: 'Disk Analyzer', i: 'disk' },
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
    if (id === 'diskuse') return renderDiskAnalyzer(body);
    return renderCleanup(body);
  }

  /* ── Disk Analyzer: apa yang paling makan disk (host + docker) ── */
  async function renderDiskAnalyzer(body) {
    body.replaceChildren(el('div', { class: 'empty' }, 'Loading… (bisa beberapa detik, nge-scan folder)'));
    try {
      const r = await api('/disk-analysis');
      const rows = [...r.host, ...r.docker].filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes);
      if (!rows.length) {
        body.replaceChildren(el('div', { class: 'empty' }, 'Tidak ada data (semua folder kosong/gagal di-scan).'));
        return;
      }
      const maxBytes = Math.max(...rows.map((x) => x.bytes));
      const bar = (label, path2, bytesVal) => el('div', { style: 'padding:9px 0;border-top:1px solid var(--line)' },
        el('div', { class: 'row', style: 'margin-bottom:5px' },
          el('div', {}, el('div', { style: 'font-size:12.5px' }, label),
            path2 ? el('div', { style: 'font-size:11px;color:var(--tx-3);font-family:var(--mono)' }, path2) : ''),
          el('span', { class: 'sp' }), el('span', { style: 'font-size:12.5px;font-weight:600' }, bytes(bytesVal))),
        el('div', { class: 'bar' }, el('i', { style: `width:${Math.round((bytesVal / maxBytes) * 100)}%` })));
      body.replaceChildren(
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' },
          'Folder besar di host (files/stacks/docker/backup/log) + breakdown docker (image/volume/build cache), diurut dari yang paling makan disk.'),
        el('div', { class: 'card' }, el('div', { class: 'card-b' },
          ...rows.map((x) => bar(x.label, x.path, x.bytes)))));
    } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
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
        networks: opts.networks.checked, containers: opts.containers.checked,
        buildCache: opts.buildCache.checked };
      if (!Object.values(b).some(Boolean)) return toast('Pilih minimal satu');
      if (!confirm('Continue cleanup?\n\nOnly unused items are removed, '
        + 'but this cannot be undone.')) return;
      go.disabled = true;
      try {
        const r = await api('/prune', { method: 'POST', body: JSON.stringify(b) });
        const freed = (r.images?.SpaceReclaimed || 0) + (r.volumes?.SpaceReclaimed || 0)
          + (r.containers?.SpaceReclaimed || 0) + (r.buildCache?.SpaceReclaimed || 0);
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
        optRow('buildCache', 'Build cache',
          'Layer sisa "docker build" (RUN npm ci, dst) — numpuk tiap rebuild, dibersihkan otomatis tiap minggu juga.'),
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
    const [me, users, sess, aud, tun] = await Promise.all([
      api('/auth/state'), api('/auth/users').catch(() => ({ users: [] })),
      api('/auth/sessions').catch(() => ({ sessions: [], bans: [] })),
      api('/auth/audit?n=120').catch(() => ({ entries: [] })),
      api('/tunnel/sites').catch(() => ({ sites: [] })),
    ]);

    /* Akses SSH dari luar — kartu referensi doang (caranya suka lupa),
       cari entri tunnel proto tcp port 22 yang dibikinkan lewat Cloudflare
       Tunnel (lihat tunnel.js) daripada nge-hardcode hostname-nya di sini.
       Langkahnya beda dikit per OS (path cloudflared, cara buka terminal,
       cara edit file), jadi dipisah per OS — bukan 3 baris generik yang
       ternyata masih bikin bingung harus mulai dari mana. */
    const sshSite = (tun.sites || []).find(s => s.proto === 'tcp' && s.port === 22);
    const sshCard = sshSite ? (() => {
      const dlUrl = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
      const cfgFor = (proxyCmd) => `Host ahnaf-server\n    HostName ${sshSite.hostname}\n`
        + `    User ahnaf\n    ProxyCommand ${proxyCmd}`;
      const osSection = (icon, label, open, installSteps, proxyCmd, editSteps) => {
        const snippet = cfgFor(proxyCmd);
        const box = el('textarea', { readonly: '', rows: '4',
          style: 'font-family:var(--mono);font-size:11px;white-space:pre;margin:8px 0' });
        box.value = snippet;
        const cp = el('button', { class: 'btn' }, 'Copy config');
        cp.onclick = () => { navigator.clipboard?.writeText(snippet); toast('Copied'); };
        const step = (n, ...content) => el('div',
          { style: 'font-size:11.5px;color:var(--tx-2);margin-bottom:6px;line-height:1.6' },
          el('b', {}, `${n}. `), ...content);
        let n = 1;
        return el('details', open ? { open: '' } : {},
          el('summary', { style: 'font-size:12.5px;font-weight:500;cursor:pointer;padding:8px 0' },
            `${icon} ${label}`),
          el('div', { style: 'padding:4px 0 10px' },
            step(n++, 'Buka ', el('a', { href: dlUrl, target: '_blank', rel: 'noopener',
              style: 'color:var(--acc)' }, 'link download cloudflared'), ' — ', ...installSteps),
            ...editSteps.map(s => step(n++, ...s)),
            step(n++, 'Isi persis ini (', el('span', { class: 'mono' }, '%h'),
              ' jangan diubah, itu diisi otomatis):'),
            box,
            el('div', { class: 'row', style: 'margin:2px 0 8px' }, cp),
            step(n++, 'Buka terminal/cmd lagi, ketik: ', el('span', { class: 'mono' }, 'ssh ahnaf-server')),
            step(n, 'Kalau ditanya "continue connecting?" ketik ', el('span', { class: 'mono' }, 'yes'),
              ', lalu masukin password akun ', el('span', { class: 'mono' }, 'ahnaf'), ' di server ini.')));
      };
      return el('div', { class: 'card' }, el('div', { class: 'card-b' },
        el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:10px;line-height:1.6' },
          `Hostname: `, el('span', { class: 'mono' }, sshSite.hostname),
          el('br'), 'Lewat Cloudflare Tunnel, bukan port biasa — device yang mau ',
          'connect wajib install ', el('span', { class: 'mono' }, 'cloudflared'), ' dulu (sekali, gratis). ',
          'Pilih OS device kamu di bawah:'),
        osSection('🪟', 'Windows', true,
          ['download yang "Windows (64-bit)". Taruh file-nya di folder baru, mis. ',
            el('span', { class: 'mono' }, 'C:\\cloudflared'),
            ', ganti nama file jadi ', el('span', { class: 'mono' }, 'cloudflared.exe'), '.'],
          'C:\\cloudflared\\cloudflared.exe access ssh --hostname %h',
          [['Buka ', el('b', {}, 'Command Prompt'), ' (Start Menu, ketik "cmd"), lalu ketik:',
            el('div', { class: 'mono', style: 'margin:4px 0;font-size:11px' },
              'mkdir %USERPROFILE%\\.ssh', el('br'), 'notepad %USERPROFILE%\\.ssh\\config')]]),
        osSection('🍎', 'Mac', false,
          ['atau kalau punya Homebrew, lebih gampang: buka Terminal, ketik ',
            el('span', { class: 'mono' }, 'brew install cloudflared'), '.'],
          'cloudflared access ssh --hostname %h',
          [['Buka ', el('b', {}, 'Terminal'), ' (Cmd+Space, ketik "Terminal"), lalu ketik:',
            el('div', { class: 'mono', style: 'margin:4px 0;font-size:11px' },
              'mkdir -p ~/.ssh && nano ~/.ssh/config')]]),
        osSection('🐧', 'Linux', false,
          ['download file .deb (Ubuntu/Mint/Debian) atau sesuai distro-mu, lalu install lewat terminal, mis. ',
            el('span', { class: 'mono' }, 'sudo dpkg -i cloudflared-linux-amd64.deb'), '.'],
          'cloudflared access ssh --hostname %h',
          [['Buka ', el('b', {}, 'Terminal'), ', lalu ketik:',
            el('div', { class: 'mono', style: 'margin:4px 0;font-size:11px' },
              'mkdir -p ~/.ssh && nano ~/.ssh/config')]]),
        el('div', { style: 'font-size:10.5px;color:var(--tx-3);margin-top:6px' },
          'Nano: setelah diisi, tekan Ctrl+O lalu Enter buat simpan, Ctrl+X buat keluar.')));
    })() : null;
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
        const qrCanvas = el('canvas', { style: 'display:block;margin:0 auto;max-width:100%;height:auto' });
        openDrawer('Enable 2FA', el('div', {},
          el('div', { style: 'font-size:12.5px;color:var(--tx-2);margin-bottom:10px' },
            'Buka aplikasi autentikator (Google Authenticator, Aegis, 1Password) dan scan kode ini:'),
          el('div', { class: 'card' }, el('div', { class: 'card-b' }, qrCanvas)),
          el('details', { style: 'margin:10px 0' },
            el('summary', { style: 'font-size:11.5px;color:var(--tx-3);cursor:pointer' },
              'Tidak bisa scan? Masukkan kunci manual'),
            el('div', { class: 'mono', style: 'font-size:14px;letter-spacing:.12em;word-break:break-all;margin-top:8px' },
              secret)),
          el('div', { class: 'field' }, el('label', {}, 'Code from your app'), code),
          el('div', { class: 'row' }, ok2)));
        try { QR.draw(qrCanvas, uri, { scale: 6 }); }
        catch (e) { qrCanvas.replaceWith(el('div', { style: 'color:var(--tx-3);font-size:11.5px' },
          'QR gagal dibuat (' + e.message + '), pakai kunci manual di bawah.')); }
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
        // Super Admin selalu akses penuh (permsOf() di server mengabaikan
        // .perms buat role ini), jadi tidak ada yang perlu dicentang.
        // 'admin' BUKAN itu — cuma boleh ke halaman yang dicentang, sama
        // seperti viewer, bedanya admin boleh mengubah di sana (viewer
        // baca-saja). Dulu di sini ada blokir "admin otomatis akses full"
        // yang salah — sisa dari skema role lama sebelum ada Super Admin.
        if (u.role === 'superadmin') return toast('Super Admin selalu akses penuh');
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
      ...(sshCard ? [el('div', { class: 'sec' }, 'Akses SSH dari luar'), sshCard] : []),
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
