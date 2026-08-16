'use strict';
/* Basis data sebagai layanan: bikin instance sendiri, kelola tabel,
   ubah baris, dan jalankan SQL — semuanya dari web. */

VIEWS.database = () => {
  let engines = [], list = [], external = [], sel = null, qText = '';

  const wrap = el('div');
  const search = searchBox('Cari basis data…', v => { qText = v; renderList(); });
  // Overview GABUNGAN (semua instance) — beda dari tab "Overview" di
  // dalam satu instance (yang cuma database itu doang). Ini ringkasan
  // level "home server database" secara keseluruhan.
  const fleetArea = el('div', { style: 'margin-bottom:14px' });
  mount(el('div', {}, fleetArea, el('div', { class: 'row', style: 'margin-bottom:10px' }, search), wrap));
  liveBadge(20);

  async function paintFleet() {
    try {
      const f = await api('/db/overview');
      if (!f.total) { fleetArea.replaceChildren(); return; }
      const memPct = f.totalMemLimit ? Math.round((f.totalMem / f.totalMemLimit) * 100) : null;
      const stat = (key, icon, val, meta) => el('div', { class: 'stat' },
        el('div', { class: 'k', html: ic(icon, 12) + `<span>${key}</span>` }),
        el('div', { class: 'v', html: val }), meta ? el('div', { class: 'm' }, meta) : '');
      const engineList = Object.entries(f.perEngine).map(([k, n]) => `${n} ${k}`).join(', ');
      fleetArea.replaceChildren(
        el('div', { class: 'sec' }, 'Overview semua basis data'),
        el('div', { class: 'stats' },
          stat('Instance', 'db', f.total, `${f.running} running · ${engineList}`),
          stat('Total ukuran', 'disk', f.totalSize != null ? bytes(f.totalSize) : '—', 'gabungan semua instance'),
          stat('Total RAM', 'ram', memPct != null ? `${memPct}<small>%</small>` : (f.totalMem ? bytes(f.totalMem) : '—'),
            f.totalMemLimit ? `${bytes(f.totalMem)} / ${bytes(f.totalMemLimit)}` : ''),
          stat('Koneksi aktif', 'net', f.totalConn != null ? f.totalConn : '—', 'gabungan semua instance'),
          stat('Total Requests', 'pulse', f.totalReq, '3 jam terakhir, gabungan')));
    } catch { fleetArea.replaceChildren(); }
  }
  every(paintFleet, 20000);
  addAction('Sambungkan yang ada', 'net', () => formExternal());
  addAction('Basis data baru', 'plus', () => formCreate(), 'btn pri');
  addAction('Refresh', 'refresh', () => load());

  /* ── Buat instance ── */
  function formCreate() {
    const name = el('input', { placeholder: 'toko-online' });
    const eng = el('select', {}, ...engines.map(e => el('option', { value: e.id }, e.label)));
    const ver = el('select');
    const dbname = el('input', { placeholder: 'kosongkan = ikut nama' });
    const expose = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
    const note = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px' });

    const syncVer = () => {
      const e = engines.find(x => x.id === eng.value);
      ver.replaceChildren(...(e?.versions || []).map(v => el('option', { value: v }, v)));
      note.textContent = e?.note || '';
    };
    eng.onchange = syncVer; syncVer();

    const b = el('button', { class: 'btn pri', html: ic('db', 13) + '<span>Buat sekarang</span>' });
    b.onclick = async () => {
      if (!name.value.trim()) return toast('Name is required');
      b.disabled = true; b.textContent = 'Creating…';
      try {
        await api('/db/instances', { method: 'POST', body: JSON.stringify({
          name: name.value.trim(), engine: eng.value, version: ver.value,
          database: dbname.value.trim(), expose: expose.checked }) });
        closeDrawer(); toast('Basis data dibuat'); load();
      } catch (e) { toast(e.message); } finally { b.disabled = false; }
    };

    openDrawer('Basis data baru', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Mesin'), eng),
      note,
      el('div', { class: 'field' }, el('label', {}, 'Versi'), ver),
      el('div', { class: 'field' }, el('label', {}, 'Nama basis data awal'), dbname),
      el('label', { class: 'row', style: 'cursor:pointer;font-weight:400;margin-bottom:10px' },
        expose, el('div', {},
          el('div', { style: 'font-size:12.5px;color:var(--tx)' }, 'Open port ke localhost server'),
          el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
            'Supaya bisa dibuka dari laptop lewat SSH tunnel. Tidak terbuka ke jaringan rumah.'))),
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:12px;line-height:1.6' },
        'Password dibuat otomatis dan disimpan panel. Memory dibatasi 512 MB per '
        + 'instance supaya satu basis data tidak menjatuhkan server.'),
      el('div', { class: 'row' }, b)));
  }

  /* ── Sambungkan basis data yang sudah ada ── */
  function formExternal() {
    const name = el('input', { placeholder: 'DB aplikasi lama' });
    const kind = el('select', {}, el('option', { value: 'postgres' }, 'PostgreSQL'),
      el('option', { value: 'mysql' }, 'MySQL / MariaDB'));
    const host = el('input', { placeholder: 'nama-container atau 192.168.1.10' });
    const port = el('input', { placeholder: '5432', inputmode: 'numeric' });
    const user = el('input', { placeholder: 'postgres' });
    const pass = el('input', { type: 'password' });
    const dbn = el('input', { placeholder: 'nama_basis_data' });
    const msg = el('div', { style: 'font-size:11.5px;min-height:16px;margin-bottom:8px' });

    const b = el('button', { class: 'btn pri', html: ic('net', 13) + '<span>Uji & sambungkan</span>' });
    b.onclick = async () => {
      b.disabled = true; msg.textContent = 'Testing connection…'; msg.style.color = 'var(--tx-3)';
      try {
        await api('/db/external', { method: 'POST', body: JSON.stringify({
          name: name.value.trim(), kind: kind.value, host: host.value.trim(),
          port: port.value, user: user.value, password: pass.value,
          database: dbn.value.trim() }) });
        closeDrawer(); toast('Tersambung'); load();
      } catch (e) {
        msg.style.color = 'var(--bad)'; msg.textContent = e.message;
      } finally { b.disabled = false; }
    };

    openDrawer('Sambungkan basis data yang sudah ada', el('div', {},
      el('div', { style: 'font-size:12px;color:var(--tx-2);margin-bottom:12px;line-height:1.6' },
        'Untuk basis data yang tidak dibuat panel: milik aplikasi lain, container lama, '
        + 'atau yang jalan di laptop kamu. Panel hanya menyimpan kredensialnya — '
        + 'container-nya tetap kamu yang urus.'),
      el('div', { class: 'field' }, el('label', {}, 'Nama tampilan'), name),
      el('div', { class: 'field' }, el('label', {}, 'Type'), kind),
      el('div', { class: 'field' }, el('label', {}, 'Host'), host),
      el('div', { class: 'field' }, el('label', {}, 'Port'), port),
      el('div', { class: 'field' }, el('label', {}, 'Users'), user),
      el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
      el('div', { class: 'field' }, el('label', {}, 'Databases'), dbn),
      msg,
      el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
        'Untuk basis data di laptop kamu, host bukan "localhost" — pakai alamat IP '
        + 'laptop di jaringan, dan pastikan Postgres mengizinkan koneksi dari luar.'),
      el('div', { class: 'row' }, b)));
  }

  /* ── Daftar instance ── */
  function renderList() {
    fleetArea.style.display = '';
    if (!list.length && !external.length) {
      wrap.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty',
        html: ic('db', 30, 1.3) + '<div>No databases yet</div>'
          + '<div style="font-size:11.5px;margin-top:6px">Buat satu, lalu salin string '
          + 'koneksinya ke aplikasi kamu.</div>' })));
      return;
    }
    const shownExternal = external.filter(x => matches(qText, x.name, x.host));
    const shownList = list.filter(i => matches(qText, i.name, i.engine));
    if (!shownExternal.length && !shownList.length) {
      wrap.replaceChildren(el('div', { class: 'card' },
        el('div', { class: 'empty', html: ic('search', 30, 1.3) + '<div>No matching databases</div>' })));
      return;
    }
    const cards = el('div', { class: 'grid2' });

    // Sambungan ke basis data luar: tidak punya container, jadi kartunya lebih ringkas.
    shownExternal.forEach(x => {
      const open = el('button', { class: 'btn pri', html: ic('search', 13) + '<span>Kelola</span>' });
      open.onclick = () => { sel = { ...x, external: true }; renderDetail(); };
      const del = el('button', { class: 'ib', title: 'Lepas sambungan', html: ic('trash', 14) });
      del.onclick = async () => {
        if (!confirm(`Lepas sambungan "${x.name}"? Basis datanya sendiri tidak dihapus.`)) return;
        try { await api('/db/external/' + x.id, { method: 'DELETE' });
          toast('Sambungan dilepas'); load(); } catch (e) { toast(e.message); }
      };
      const card = el('div', { class: 'card' });
      card.append(
        el('div', { class: 'card-h' },
          el('i', { class: 'dot idle' }), el('h3', {}, x.name),
          el('span', { class: 'pill' }, 'sambungan luar'),
          el('span', { class: 'sp' }), del),
        el('div', { class: 'card-b' }, el('table', {}, el('tbody', {},
          el('tr', {}, el('td', { style: 'color:var(--tx-3);width:38%' }, 'Host'),
            el('td', { class: 'mono' }, `${x.host}:${x.port}`)),
          el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Type'),
            el('td', { class: 'mono' }, x.kind)),
          el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Databases'),
            el('td', { class: 'mono' }, x.database || '—'))))),
        el('div', { class: 'card-b', style: 'border-top:1px solid var(--line)' },
          el('div', { class: 'row' }, open)));
      cards.append(card);
    });

    shownList.forEach(i => {
      const on = i.state === 'running';
      const open = el('button', { class: 'btn pri', html: ic('search', 13) + '<span>Kelola</span>' });
      open.onclick = () => { sel = i; renderDetail(); };
      const conn = el('button', { class: 'btn', html: ic('lock', 13) + '<span>Koneksi</span>' });
      conn.onclick = () => showConnection(i);
      const act = (label, a, icon) => {
        const b = el('button', { class: 'ib', title: label, html: ic(icon, 14) });
        b.onclick = async () => {
          try { await api(`/db/instances/${i.id}/${a}`, { method: 'POST' });
            toast('Done'); load(); } catch (e) { toast(e.message); }
        };
        return b;
      };
      const del = el('button', { class: 'ib', title: 'Delete', html: ic('trash', 14) });
      del.onclick = async () => {
        const keep = confirm(`Hapus basis data "${i.name}".\n\n`
          + 'OK = simpan datanya (volume tidak dihapus)\n'
          + 'Batal = lanjut memilih hapus total');
        if (!keep && !confirm('HAPUS TOTAL termasuk semua datanya? Tidak bisa dibatalkan.')) return;
        try { await api(`/db/instances/${i.id}?keep=${keep ? 1 : 0}`, { method: 'DELETE' });
          toast('Deleted'); load(); } catch (e) { toast(e.message); }
      };

      const infoRow = (k, v) => el('tr', {},
        el('td', { style: 'color:var(--tx-3);width:38%' }, k),
        el('td', { class: 'mono' }, v));

      const card = el('div', { class: 'card' });
      card.append(
        el('div', { class: 'card-h' },
          el('i', { class: 'dot ' + (on ? 'up' : 'idle') }),
          el('h3', {}, i.name),
          el('span', { class: 'pill' }, i.engine + ' ' + i.version),
          el('span', { class: 'sp' }),
          on ? act('Stop', 'stop', 'stop') : act('Run', 'start', 'play'),
          act('Restart', 'restart', 'restart'),
          del),
        el('div', { class: 'card-b' },
          el('table', {},
            el('tbody', {},
              infoRow('Host internal', i.container),
              infoRow('Port', String(i.port)),
              infoRow('Databases', i.database),
              el('tr', {},
                el('td', { style: 'color:var(--tx-3)' }, 'Status'),
                el('td', {}, el('span', { class: 'pill ' + (on ? 'ok' : '') }, i.status)))))),
        el('div', { class: 'card-b', style: 'border-top:1px solid var(--line)' },
          el('div', { class: 'row' }, open, conn)));
      cards.append(card);
    });
    wrap.replaceChildren(cards);
    $('#sub').textContent = `${list.filter(i => i.state === 'running').length}/${list.length} berjalan`;
  }

  /* ── String koneksi ── */
  async function showConnection(i) {
    try {
      const c = await api(`/db/instances/${i.id}/connection`);
      const copyBox = (label, val, hint) => {
        const inp = el('input', { value: val, readonly: '' , style: 'font-family:var(--mono);font-size:11.5px' });
        const cp = el('button', { class: 'btn' }, 'Copy');
        cp.onclick = () => { navigator.clipboard?.writeText(val); toast('Copied'); };
        return el('div', { class: 'field' }, el('label', {}, label),
          el('div', { class: 'row' }, el('div', { style: 'flex:1' }, inp), cp),
          hint ? el('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:4px' }, hint) : '');
      };
      const rot = el('button', { class: 'btn danger' }, 'Change password');
      rot.onclick = async () => {
        if (!confirm('Change password? Apps using the old one will disconnect.')) return;
        try { await api(`/db/instances/${i.id}/rotate`, { method: 'POST' });
          toast('Password diganti'); closeDrawer(); } catch (e) { toast(e.message); }
      };
      const bk = el('button', { class: 'btn' }, 'Back up now');
      bk.onclick = async () => {
        toast('Creating backup…');
        try { const r = await api(`/db/instances/${i.id}/backup`, { method: 'POST' });
          toast('Backup created: ' + r.file); } catch (e) { toast(e.message); }
      };

      // ── Akses dari device lain (bukan sesama laptop ini) lewat Cloudflare
      // Tunnel — buat kasus kayak "backend jalan di laptop teman". Ini beda
      // dari SSH tunnel di atas: yang connect nggak perlu akun SSH di
      // laptop ini, cukup domain + cloudflared di sisi mereka.
      const remoteArea = el('div');
      async function paintRemote() {
        if (!c.exposePort) {
          remoteArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
            'Buat diakses dari device lain, basis data ini harus dibuat ulang dengan opsi '
            + '"Open port ke localhost server" dicentang.'));
          return;
        }
        const tData = await api('/tunnel/sites').catch(() => ({ sites: [], baseDomain: 'ahnaf.cloud' }));
        const existing = tData.sites.find(s => s.target === i.container && s.proto === 'tcp');
        if (existing) {
          const cmd = `cloudflared access tcp --hostname ${existing.hostname} --url localhost:${c.exposePort}`;
          const del = el('button', { class: 'btn', style: 'margin-top:8px' }, 'Cabut akses jarak jauh');
          del.onclick = async () => {
            if (!confirm('Cabut akses jarak jauh ke basis data ini?')) return;
            try { await api('/tunnel/sites/' + existing.id, { method: 'DELETE' });
              toast('Dicabut'); paintRemote(); } catch (e) { toast(e.message); }
          };
          remoteArea.replaceChildren(
            el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:6px' },
              `Suruh temanmu install `,
              el('a', { href: 'https://developers.cloudflare.com/cloudflared/', target: '_blank' }, 'cloudflared'),
              ' (gratis) di laptopnya, lalu jalankan perintah ini di terminal dia:'),
            el('div', { class: 'card' }, el('div', { class: 'card-b mono',
              style: 'font-size:11px;word-break:break-all' }, cmd)),
            el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:6px' },
              `Habis itu dia tinggal connect ke `,
              el('code', {}, `127.0.0.1:${c.exposePort}`), ' pakai client database biasa (DBeaver/TablePlus/psql) — koneksinya lewat Cloudflare, terenkripsi, tanpa buka port apa pun ke internet.'),
            del);
        } else {
          const add = el('button', { class: 'btn pri' }, 'Buat akses jarak jauh');
          add.onclick = async () => {
            add.disabled = true;
            try {
              const r = await api('/tunnel/sites', { method: 'POST', body: JSON.stringify({
                label: 'db', project: i.name, target: i.container, port: c.exposePort, proto: 'tcp' }) });
              toast(r.warning || `${r.site.hostname} siap`);
              paintRemote();
            } catch (e) { toast(e.message); add.disabled = false; }
          };
          remoteArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:8px' },
            'Buat basis data ini bisa diakses dari device lain (mis. laptop teman), lewat Cloudflare Tunnel — '
            + 'aman, tanpa buka port ke internet.'), add);
        }
      }
      paintRemote();

      // ── REST API otomatis (setara Supabase) — kayak PostgREST: dapet URL
      // HTTPS + API key, tinggal fetch() dari mana pun tanpa install
      // software tambahan di sisi yang connect. Cuma didukung PostgreSQL
      // yang dibuat lewat panel ini (bukan external, bukan MySQL/Mongo).
      // Dibuat OTOMATIS di background pas basis data ini dibuat (lihat
      // autoDeployRestApi di server.js) — jadi di sini cukup polling sampai
      // siap, TANPA tombol manual, biar nggak dobel sama proses auto-nya.
      const apiArea = el('div');
      let apiPollTimer = null;
      async function paintApi(attempt = 0) {
        if (apiPollTimer) { clearTimeout(apiPollTimer); apiPollTimer = null; }
        if (i.external || i.engine !== 'postgres') {
          apiArea.replaceChildren(
            el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:8px' },
              'REST API otomatis cuma tersedia untuk basis data PostgreSQL yang dibuat lewat panel ini. '
              + 'Pakai koneksi langsung di bawah buat basis data ini.'),
            el('div', { class: 'sec' }, 'For your .env file'),
            el('div', { class: 'card' }, el('div', { class: 'card-b mono',
              style: 'white-space:pre-wrap;font-size:11.5px' }, c.envExample)));
          return;
        }
        const rec = await api(`/db/instances/${i.id}/api`).catch(() => null);
        if (rec) {
          const base = rec.hostname ? `https://${rec.hostname}` : '(subdomain belum siap)';
          const envBlock = `DATABASE_API_URL=${base}\nDATABASE_API_KEY=${rec.apiKey}`;
          const example = `fetch("${base}/nama_tabel", {\n  headers: {\n    apikey: "${rec.apiKey}",\n    Authorization: "Bearer ${rec.apiKey}"\n  }\n}).then(r => r.json())`;
          const del = el('button', { class: 'btn danger', style: 'margin-top:8px' }, 'Hapus REST API');
          del.onclick = async () => {
            if (!confirm('Hapus REST API ini? Aplikasi yang pakai API key ini bakal berhenti nyambung.')) return;
            try { await api(`/db/instances/${i.id}/api`, { method: 'DELETE' });
              toast('Dihapus'); paintApi(999); } catch (e) { toast(e.message); }
          };
          apiArea.replaceChildren(
            copyBox('URL', base, 'Base URL — tambah /nama_tabel di belakang, persis kayak Supabase.'),
            copyBox('API key', rec.apiKey,
              'Taruh di header apikey dan Authorization: Bearer <key>. Jangan disebar kalau tabelnya sensitif.'),
            el('div', { class: 'sec' }, 'For your .env file'),
            el('div', { class: 'card' }, el('div', { class: 'card-b mono',
              style: 'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;font-size:11.5px' }, envBlock)),
            el('div', { class: 'sec' }, 'Contoh pakai'),
            el('div', { class: 'card' }, el('div', { class: 'card-b mono',
              style: 'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;font-size:11px' }, example)),
            del);
          return;
        }
        if (attempt < 15) {
          apiArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3)' },
            'Menyiapkan REST API…'));
          apiPollTimer = setTimeout(() => paintApi(attempt + 1), 2000);
        } else {
          const retry = el('button', { class: 'btn pri' }, 'Coba lagi');
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = 'Membuat…';
            try {
              const r = await api(`/db/instances/${i.id}/api`, { method: 'POST' });
              toast(r.warning || `REST API siap di ${r.hostname}`);
              paintApi();
            } catch (e) { toast(e.message); retry.disabled = false; retry.textContent = 'Coba lagi'; }
          };
          apiArea.replaceChildren(el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:8px' },
            'REST API belum siap juga — mungkin gagal pas dibuat otomatis.'), retry);
        }
      }
      paintApi();

      openDrawer('Koneksi — ' + i.name, el('div', {},
        el('div', { class: 'sec' }, 'REST API (kayak Supabase)'),
        apiArea,
        el('div', { class: 'sec' }, 'Akses langsung dari container lain di server ini'),
        copyBox('Connection string', c.internal,
          'Buat container lain yang join jaringan "apps" — connect langsung ke Postgres tanpa lewat REST API.'),
        c.localhost ? copyBox('From your laptop (via SSH tunnel)', c.localhost) : '',
        c.tunnel ? copyBox('Tunnel command', c.tunnel,
          'Run this on your laptop, then point TablePlus at 127.0.0.1') : '',
        el('div', { class: 'sec' }, 'Akses dari device lain (koneksi database langsung)'),
        remoteArea,
        el('div', { class: 'row', style: 'margin-top:14px' }, bk, rot)));
    } catch (e) { toast(e.message); }
  }

  /* ── Kelola satu instance ── */
  function renderDetail() {
    fleetArea.style.display = 'none';
    const i = sel;
    let tables = [], curDb = i.database, cols = [], curTable = null;

    const back = el('button', { class: 'btn', html: ic('home', 13) + '<span>All basis data</span>' });
    back.onclick = () => { sel = null; renderList(); };

    /* Unduh hasil POST sebagai files — dipakai semua ekspor. */
    async function download(path2, body, fallbackName) {
      const r = await fetch(`/api/db/instances/${i.id}/${path2}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: curDb, ...body }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Gagal (' + r.status + ')');
      }
      const cd = r.headers.get('Content-Disposition') || '';
      const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return name;
    }

    /* Laci ekspor: dipakai untuk satu tabel, seluruh basis data, atau hasil kueri. */
    function exportDrawer({ table, sql } = {}) {
      const fmt = el('select', {},
        el('option', { value: 'csv' }, 'CSV — buka di Excel / Google Sheets'),
        el('option', { value: 'json' }, 'JSON — untuk aplikasi'),
        el('option', { value: 'sql-insert' }, 'SQL — perintah INSERT saja'),
        ...(sql ? [] : [el('option', { value: 'sql-dump' }, 'SQL — dump lengkap (skema + data)')]));
      const scope = el('select', {},
        el('option', { value: 'table' }, table ? `Tabel ${table}` : 'Satu tabel'),
        el('option', { value: 'db' }, `Seluruh basis data (${curDb})`));
      if (sql) scope.style.display = 'none';
      const onlySchema = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
      const onlyData = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
      const opts = el('div', { style: 'display:none' },
        el('label', { class: 'row', style: 'font-weight:400;margin-bottom:4px;cursor:pointer' },
          onlySchema, el('span', { style: 'font-size:12px' }, 'Hanya struktur tabel, tanpa isi')),
        el('label', { class: 'row', style: 'font-weight:400;margin-bottom:10px;cursor:pointer' },
          onlyData, el('span', { style: 'font-size:12px' }, 'Hanya isi, tanpa struktur')));
      const hint = el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' });
      const sync = () => {
        opts.style.display = fmt.value === 'sql-dump' ? '' : 'none';
        hint.textContent = {
          csv: 'Satu baris judul lalu datanya. Value berisi koma otomatis dikutip.',
          json: 'Larik objek, siap dipakai langsung di kode.',
          'sql-insert': 'INSERT statements only. The target table must already exist.',
          'sql-dump': 'Dipakai pg_dump/mariadb-dump — bisa dipulihkan utuh ke server lain.',
        }[fmt.value] || '';
      };
      fmt.onchange = sync; sync();

      const b = el('button', { class: 'btn pri', html: ic('down', 13) + '<span>Unduh</span>' });
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Preparing…';
        try {
          const body = { format: fmt.value };
          if (sql) body.sql = sql;
          else if (scope.value === 'table') { body.schema = 'public'; body.table = table; }
          if (fmt.value === 'sql-dump') {
            body.schemaOnly = onlySchema.checked; body.dataOnly = onlyData.checked;
            if (scope.value === 'table') body.table = table;
          }
          const name = await download('export', body, 'ekspor.txt');
          toast('Terunduh: ' + name); closeDrawer();
        } catch (e) { toast(e.message); }
        finally { b.disabled = false; b.textContent = 'Download'; }
      };
      openDrawer(sql ? 'Ekspor hasil kueri' : 'Ekspor ' + (table || curDb), el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Format'), fmt),
        sql ? '' : el('div', { class: 'field' }, el('label', {}, 'Cakupan'), scope),
        opts, hint,
        el('div', { class: 'row' }, b)));
    }

    /* Laci impor CSV / SQL. */
    function importDrawer(table) {
      const kind = el('select', {},
        el('option', { value: 'csv' }, 'CSV ke dalam tabel'),
        el('option', { value: 'sql' }, 'Run a .sql file'));
      const tbl = el('input', { value: table || '', placeholder: 'nama tabel tujuan' });
      const tblF = el('div', { class: 'field' }, el('label', {}, 'Tabel tujuan'), tbl);
      const file = el('input', { type: 'file', accept: '.csv,.sql,.txt' });
      const area = el('textarea', { rows: 8, spellcheck: 'false',
        placeholder: 'Inject isi files di sini, atau pilih files di atas' });
      const out = el('div', { style: 'margin-top:8px' });
      kind.onchange = () => { tblF.style.display = kind.value === 'csv' ? '' : 'none'; };

      file.onchange = async () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 8 * 1024 * 1024) return toast('Berkas terlalu besar (maks 8 MB)');
        area.value = await f.text();
        if (/\.sql$/i.test(f.name)) { kind.value = 'sql'; kind.onchange(); }
        toast(`${f.name} dimuat`);
      };

      const b = el('button', { class: 'btn pri', html: ic('up', 13) + '<span>Impor</span>' });
      b.onclick = async () => {
        if (!area.value.trim()) return toast('Load a file first');
        if (kind.value === 'csv' && !tbl.value.trim()) return toast('Target table is required');
        if (!confirm('Import will ADD rows to the database. Continue?')) return;
        b.disabled = true; b.textContent = 'Importing…';
        try {
          const r = await call('import', { kind: kind.value, content: area.value,
            schema: 'public', table: tbl.value.trim() });
          if (kind.value === 'sql') {
            out.replaceChildren(el('span', { class: 'pill ok' },
              `Berhasil · ${r.sets} perintah dijalankan`));
          } else {
            out.replaceChildren(el('div', {},
              el('div', { class: 'row', style: 'margin-bottom:6px' },
                el('span', { class: 'pill ok' }, `${r.inserted} dari ${r.total} baris masuk`),
                r.errors.length ? el('span', { class: 'pill bad' }, `${r.errors.length} failed`) : ''),
              ...r.errors.slice(0, 8).map(e2 => el('div', {
                style: 'font-size:11px;color:var(--bad);font-family:var(--mono)' },
                `baris ${e2.baris}: ${e2.pesan}`))));
          }
          toast('Impor selesai');
        } catch (e) { toast(e.message); }
        finally { b.disabled = false; b.textContent = 'Impor'; }
      };

      openDrawer('Impor data', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Type'), kind),
        tblF,
        el('div', { class: 'field' }, el('label', {}, 'Pilih files'), file),
        el('div', { class: 'field' }, el('label', {}, 'Atau tempel isinya'), area),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-bottom:10px;line-height:1.6' },
          'CSV: baris pertama dipakai sebagai nama kolom, dan harus cocok dengan '
          + 'kolom di tabel. Sel kosong dibiarkan NULL agar nilai bawaan tetap berlaku.'),
        el('div', { class: 'row' }, b), out));
    }

    function call(path2, body) {
      return api(`/db/instances/${i.id}/${path2}`,
        { method: 'POST', body: JSON.stringify({ database: curDb, ...body }) });
    }

    /* Overview: kondisi instance sekilas — ukuran, RAM/CPU vs batasnya,
       koneksi aktif, dan ringkasan kueri. Tab pertama pas buka satu basis
       data, biar ga langsung disodorin daftar tabel mentah. */
    async function viewOverview(body) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
      try {
        const [o, h] = await Promise.all([
          api(`/db/instances/${i.id}/overview`),
          api(`/db/instances/${i.id}/history`),
        ]);
        const stat = (key, icon, val, meta, pct) => {
          const bar = pct != null ? el('div', { class: 'bar' },
            el('i', { style: `width:${Math.min(pct, 100)}%`,
              class: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '' })) : null;
          return el('div', { class: 'stat' },
            el('div', { class: 'k', html: ic(icon, 12) + `<span>${key}</span>` }),
            el('div', { class: 'v', html: val }),
            meta ? el('div', { class: 'm' }, meta) : '', bar || '');
        };
        const memPct = o.memLimit ? Math.round((o.memUsed / o.memLimit) * 100) : null;
        const pts = h.history || [];
        // Selisih antar sampel = jumlah request DI JENDELA ITU (mis. 60
        // detik) — persis konsep grafik "Total Requests" Supabase, tapi
        // ditarik dari statistik transaksi asli mesin basis datanya
        // sendiri (pg_stat_database dkk), jadi nangkep traffic dari
        // APLIKASI KAMU, bukan cuma yang dijalankan lewat tab SQL panel.
        const reqPts = pts.filter(p => p.req != null);
        const reqDeltas = reqPts.slice(1).map((p, idx) => Math.max(0, p.req - reqPts[idx].req));

        const c1 = el('canvas'), c2 = el('canvas'), c3 = el('canvas');
        const card = (t, c) => el('div', { class: 'card' },
          el('div', { class: 'card-h' }, el('h3', {}, t)), el('div', { class: 'card-b' }, c));
        const chartsWrap = el('div', { class: 'grid2' },
          card('Requests (per menit, 3 jam terakhir)', c3),
          card('Memory (3 jam terakhir)', c1), card('CPU % (3 jam terakhir)', c2));

        body.replaceChildren(
          el('div', { class: 'stats' },
            stat('Status', 'pulse',
              o.state === 'running' ? 'Running' : (o.state || 'unknown'),
              o.statusText || ''),
            stat('Ukuran', 'db', o.size != null ? bytes(o.size) : '—', `${o.engine} ${o.version}`),
            stat('Memory', 'ram', memPct != null ? `${memPct}<small>%</small>` : '—',
              o.memLimit ? `${bytes(o.memUsed)} / ${bytes(o.memLimit)}` : 'tidak terbaca', memPct),
            stat('CPU', 'cpu', `${o.cpuPercent ?? 0}<small>%</small>`, 'saat ini'),
            stat('Koneksi aktif', 'net', o.connections != null ? o.connections : '—', ''),
            stat('Total Requests', 'pulse', o.reqTotal != null ? o.reqTotal : '—',
              o.successRate != null ? `${o.successRate}% sukses (3 jam)`
                : o.reqTotal != null ? '3 jam terakhir' : 'belum ada data')),
          pts.length >= 2 ? chartsWrap : el('div', {
            style: 'font-size:11.5px;color:var(--tx-3);margin-top:12px' },
            'Grafik baru muncul setelah beberapa menit (disampel tiap 60 detik).'),
          el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:12px;line-height:1.6' },
            'Dibuat ' + new Date(o.created).toLocaleString('id-ID') +
            '. "Total Requests" dihitung dari statistik transaksi mesin basis datanya sendiri '
            + '(bukan cuma tab SQL panel) — mencerminkan traffic dari aplikasi kamu juga.'));

        if (pts.length >= 2) {
          chart(c1, [{ data: pts.map(p => p.mem), color: '#5b8def' }], { fmt: v => bytes(v) });
          chart(c2, [{ data: pts.map(p => p.cpu), color: '#e5484d' }], { max: 100 });
        }
        if (reqDeltas.length >= 2) {
          chart(c3, [{ data: reqDeltas, color: '#3dbb7d' }]);
        }
      } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
    }

    const T = tabs([
      ...(i.external ? [] : [{ id: 'overview', n: 'Overview', i: 'pulse' }]),
      { id: 'tables', n: 'Tabel', i: 'db' },
      { id: 'sql', n: 'SQL', i: 'term' },
      { id: 'qlog', n: 'Riwayat kueri', i: 'clock' },
      { id: 'dbs', n: 'Databases', i: 'layers' },
      ...(i.external ? [] : [{ id: 'logs', n: 'Logs', i: 'logs' }]),
    ], (id, body) => ({ overview: viewOverview, tables: viewTables, sql: viewSql, qlog: viewQueryLog,
      dbs: viewDbs, logs: viewLogs })[id](body));

    wrap.replaceChildren(el('div', { class: 'row', style: 'margin-bottom:12px' },
      back, el('span', { class: 'pill' },
        i.external ? `${i.kind} · ${i.host}` : i.engine + ' ' + i.version),
      el('span', { class: 'pill' }, 'db: ' + curDb)), T.node);


    /* Tabel */
    async function viewTables(body) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
      try {
        const r = await call('tables');
        tables = r.rows;
        const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Tabel baru</span>' });
        add.onclick = () => formTable();
        const expAll = el('button', { class: 'btn', html: ic('down', 13) + '<span>Ekspor</span>' });
        expAll.onclick = () => exportDrawer({});
        const imp = el('button', { class: 'btn', html: ic('up', 13) + '<span>Impor</span>' });
        imp.onclick = () => importDrawer();
        const tb = el('tbody');
        tables.forEach(t => {
          const exp = el('button', { class: 'ib', title: 'Ekspor tabel', html: ic('down', 14) });
          exp.onclick = (e) => { e.stopPropagation(); exportDrawer({ table: t.name }); };
          const drop = el('button', { class: 'ib', title: 'Hapus tabel', html: ic('trash', 14) });
          drop.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm(`Hapus tabel "${t.name}" beserta seluruh isinya?`)) return;
            try { await call('ddl', { op: 'drop_table', schema: t.schema, table: t.name });
              toast('Tabel dihapus'); viewTables(body); } catch (er) { toast(er.message); }
          };
          const tr = el('tr', { style: 'cursor:pointer' },
            el('td', {}, el('div', { class: 'fname', html: ic('db', 13) + `<span>${esc(t.name)}</span>` })),
            el('td', { style: 'color:var(--tx-3)' }, t.schema),
            el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, exp, drop)));
          tr.onclick = () => browse(t.schema, t.name);
          tb.append(tr);
        });
        body.replaceChildren(
          el('div', { class: 'row', style: 'margin-bottom:12px' },
            el('span', { class: 'pill' }, `${tables.length} tabel`),
            el('span', { class: 'sp' }), imp, expAll, add),
          tables.length
            ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
                el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Tabel'),
                  el('th', {}, 'Skema'), el('th', {}, ''))), tb)))
            : el('div', { class: 'card' }, el('div', { class: 'empty' },
                'No tables yet. Buat lewat tombol di atas, atau lewat migrasi aplikasi kamu.')));
      } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
    }

    /* Rolecang tabel */
    function formTable() {
      const name = el('input', { placeholder: 'produk' });
      const rows = el('div');
      const addCol = () => {
        const cn = el('input', { placeholder: 'nama_kolom', style: 'flex:1' });
        const ct = el('select', { style: 'max-width:150px' },
          ...['text', 'varchar(255)', 'integer', 'bigint', 'boolean', 'numeric(12,2)',
              'timestamptz', 'date', 'jsonb', 'uuid', 'serial']
            .map(t => el('option', { value: t }, t)));
        const pk = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
        const nn = el('input', { type: 'checkbox', style: 'width:auto;height:auto' });
        const rm = el('button', { class: 'ib', html: ic('trash', 14) });
        const row = el('div', { class: 'row', style: 'margin-bottom:6px' }, cn, ct,
          el('label', { style: 'display:flex;gap:4px;align-items:center;font-size:11px;margin:0' }, pk, 'PK'),
          el('label', { style: 'display:flex;gap:4px;align-items:center;font-size:11px;margin:0' }, nn, 'NOT NULL'),
          rm);
        rm.onclick = () => row.remove();
        row._get = () => ({ name: cn.value.trim(), type: ct.value,
          primary: pk.checked, notNull: nn.checked });
        rows.append(row);
      };
      addCol();
      const more = el('button', { class: 'btn', html: ic('plus', 13) + '<span>Tambah kolom</span>' });
      more.onclick = addCol;
      const b = el('button', { class: 'btn pri' }, 'Buat tabel');
      b.onclick = async () => {
        const columns = [...rows.children].map(r => r._get()).filter(c => c.name);
        if (!name.value.trim() || !columns.length) return toast('Name and at least one column required');
        try {
          await call('ddl', { op: 'create_table', schema: 'public',
            table: name.value.trim(), columns });
          closeDrawer(); toast('Tabel dibuat'); viewTables(T.body);
        } catch (e) { toast(e.message); }
      };
      openDrawer('Tabel baru', el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Nama tabel'), name),
        el('div', { class: 'sec', style: 'margin-top:6px' }, 'Kolom'),
        rows, el('div', { class: 'row', style: 'margin:8px 0 14px' }, more),
        el('div', { class: 'row' }, b)));
    }

    /* Jelajah & ubah baris */
    const view = { search: '', orderBy: null, dir: 'asc', filters: {}, offset: 0 };

    async function browse(schema, table, reset = true) {
      curTable = { schema, table };
      if (reset) { view.search = ''; view.orderBy = null; view.filters = {}; view.offset = 0; }
      const body = el('div', {}, el('div', { class: 'empty' }, 'Loading…'));
      openDrawer(`${schema}.${table}`, body);
      draw(schema, table, body);
    }

    async function draw(schema, table, body) {
      try {
        const [r, cr] = await Promise.all([
          call('rows', { schema, table, limit: 50, offset: view.offset,
            search: view.search, orderBy: view.orderBy, dir: view.dir, filters: view.filters }),
          call('columns', { schema, table })]);
        cols = cr.rows;
        const pk = cols.find(c => /^id$/i.test(c.name))?.name || cols[0]?.name;
        const colNames = r.columns?.length ? r.columns
          : (r.fields?.length ? r.fields : Object.keys(r.rows[0] || {}));

        /* Formulir tambah/ubah baris */
        const form = (row) => {
          const f = {};
          const fields = cols.map(c => {
            f[c.name] = el('input', { value: row ? (row[c.name] ?? '') : '' });
            return el('div', { class: 'field' },
              el('label', {}, `${c.name}  ·  ${c.type}${c.nullable === 'NO' ? '  · wajib' : ''}`),
              f[c.name]);
          });
          const b2 = el('button', { class: 'btn pri' }, row ? 'Simpan perubahan' : 'Tambah baris');
          b2.onclick = async () => {
            const values = {};
            cols.forEach(c => {
              const v = f[c.name].value;
              if (row) { if (String(row[c.name] ?? '') !== v) values[c.name] = v === '' ? null : v; }
              else if (v !== '') values[c.name] = v;
            });
            if (!Object.keys(values).length) return toast('Nothing changed');
            try {
              if (row) await call('update', { schema, table, values, where: { [pk]: row[pk] } });
              else await call('insert', { schema, table, values });
              toast('Saved'); browse(schema, table, false);
            } catch (e) { toast(e.message); }
          };
          openDrawer(row ? 'Ubah baris' : 'Baris baru',
            el('div', {}, ...fields, el('div', { class: 'row', style: 'margin-top:6px' }, b2)));
        };

        /* Kotak pencarian: cocok ke semua kolom sekaligus */
        const search = el('input', { placeholder: 'Cari di semua kolom…', value: view.search });
        let tmr;
        search.oninput = () => {
          clearTimeout(tmr);
          tmr = setTimeout(() => { view.search = search.value; view.offset = 0;
            draw(schema, table, body); }, 350);
        };
        const clearBtn = el('button', { class: 'ib', title: 'Clean', html: ic('trash', 13) });
        clearBtn.onclick = () => { view.search = ''; view.filters = {}; view.offset = 0;
          draw(schema, table, body); };

        /* Baris penyaring per kolom */
        const filterRow = el('tr');
        colNames.forEach(c => {
          const inp = el('input', { placeholder: 'saring…', value: view.filters[c] || '',
            style: 'height:24px;font-size:11px' });
          let t2;
          inp.oninput = () => {
            clearTimeout(t2);
            t2 = setTimeout(() => {
              if (inp.value) view.filters[c] = inp.value; else delete view.filters[c];
              view.offset = 0; draw(schema, table, body);
            }, 350);
          };
          filterRow.append(el('td', { style: 'padding:4px 8px' }, inp));
        });
        filterRow.append(el('td', {}));

        /* Kepala tabel yang bisa diklik untuk mengurutkan */
        const head = el('tr', {}, ...colNames.map(c => {
          const active = view.orderBy === c;
          const th = el('th', { style: 'cursor:pointer;user-select:none' });
          th.append(el('div', { class: 'row', style: 'gap:4px' },
            el('span', {}, c),
            el('span', { style: `opacity:${active ? 1 : .25};font-size:9px` },
              active ? (view.dir === 'asc' ? '▲' : '▼') : '▲')));
          th.onclick = () => {
            if (view.orderBy === c) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
            else { view.orderBy = c; view.dir = 'asc'; }
            view.offset = 0; draw(schema, table, body);
          };
          return th;
        }), el('th', {}, ''));

        const tb = el('tbody');
        r.rows.forEach(row => {
          const ed = el('button', { class: 'ib', title: 'Edit', html: ic('edit', 13) });
          ed.onclick = () => form(row);
          const dl = el('button', { class: 'ib', title: 'Delete', html: ic('trash', 13) });
          dl.onclick = async () => {
            if (!confirm('Hapus baris ini?')) return;
            try { await call('delete', { schema, table, where: { [pk]: row[pk] } });
              toast('Deleted'); draw(schema, table, body); } catch (e) { toast(e.message); }
          };
          const term = view.search.trim().toLowerCase();
          tb.append(el('tr', {}, ...colNames.map(c => {
            let v = row[c];
            v = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            const short = v.length > 44 ? v.slice(0, 44) + '…' : v;
            const td = el('td', { class: 'mono', title: v });
            // Sorot bagian yang cocok dengan pencarian.
            const idx = term ? short.toLowerCase().indexOf(term) : -1;
            if (idx >= 0) {
              td.append(short.slice(0, idx),
                el('mark', {}, short.slice(idx, idx + term.length)),
                short.slice(idx + term.length));
            } else td.textContent = short;
            return td;
          }), el('td', {}, el('div', { class: 'row' }, ed, dl))));
        });

        const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Baris baru</span>' });
        add.onclick = () => form(null);
        const expT = el('button', { class: 'ib', title: 'Ekspor tabel ini', html: ic('down', 14) });
        expT.onclick = () => exportDrawer({ table });
        const prev = el('button', { class: 'btn' }, '‹');
        prev.disabled = view.offset === 0;
        prev.onclick = () => { view.offset = Math.max(0, view.offset - 50); draw(schema, table, body); };
        const next = el('button', { class: 'btn' }, '›');
        next.disabled = r.total != null && view.offset + 50 >= +r.total;
        next.onclick = () => { view.offset += 50; draw(schema, table, body); };

        const info = view.search || Object.keys(view.filters).length
          ? `${r.total} cocok dari pencarian`
          : (r.total != null ? `${view.offset + 1}–${view.offset + r.rows.length} dari ${r.total}` : `${r.rows.length} baris`);

        body.replaceChildren(
          el('div', { class: 'row', style: 'margin-bottom:9px' },
            el('div', { style: 'flex:1' }, search), clearBtn, expT, add),
          el('div', { class: 'row', style: 'margin-bottom:9px' },
            el('span', { class: 'pill' }, info),
            el('span', { class: 'pill' }, `${r.ms} ms`),
            el('span', { class: 'sp' }), prev, next),
          r.rows.length
            ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:52vh' },
                el('table', {}, el('thead', {}, head, filterRow), tb)))
            : el('div', { class: 'card' }, el('div', { class: 'empty' },
                view.search ? `Tidak ada baris yang cocok dengan "${esc(view.search)}"` : 'Table is empty')));
      } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
    }

    /* SQL bebas */
    function viewSql(body) {
      const ta = el('textarea', { rows: 7, spellcheck: 'false',
        placeholder: 'SELECT * FROM produk ORDER BY id DESC LIMIT 20;' });
      const run = el('button', { class: 'btn pri', html: ic('play', 13) + '<span>Jalankan</span>' });
      const out = el('div', { style: 'margin-top:12px' });
      const expQ = el('button', { class: 'btn', html: ic('down', 13) + '<span>Ekspor hasil</span>' });
      expQ.onclick = () => {
        if (!ta.value.trim()) return toast('Write a query first');
        exportDrawer({ sql: ta.value });
      };
      run.onclick = async () => {
        if (!ta.value.trim()) return;
        out.replaceChildren(el('div', { class: 'empty' }, 'Running…'));
        try {
          const r = await call('query', { sql: ta.value });

          const tableOf = (rows, fields) => {
            const c2 = fields?.length ? fields : Object.keys(rows[0] || {});
            return el('div', { class: 'card' },
              el('div', { class: 'tbl-wrap', style: 'max-height:40vh' },
                el('table', {},
                  el('thead', {}, el('tr', {}, ...c2.map(x => el('th', {}, x)))),
                  el('tbody', {}, ...rows.map(row => el('tr', {}, ...c2.map(x => {
                    let v = row[x];
                    v = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                    return el('td', { class: 'mono', title: v },
                      v.length > 60 ? v.slice(0, 60) + '…' : v);
                  })))))));
          };

          // Skrip berisi banyak perintah: tampilkan hasil TIAP perintah,
          // bukan hanya yang terakhir.
          if (r.sets && r.sets.length > 1) {
            const blocks = r.sets.map(sset => el('div', {},
              el('div', { class: 'sec' },
                `Command ${sset.index}` + (sset.command ? ` · ${sset.command}` : '')
                + ` · ${sset.rows.length} baris`),
              sset.rows.length
                ? tableOf(sset.rows, sset.fields)
                : el('div', { class: 'card' }, el('div', { class: 'card-b' },
                    el('span', { class: 'pill ok' },
                      `Berhasil · ${sset.count ?? 0} baris terpengaruh`)))));
            out.replaceChildren(
              el('div', { class: 'row', style: 'margin-bottom:4px' },
                el('span', { class: 'pill ok' }, `${r.sets.length} perintah dijalankan`),
                el('span', { class: 'pill' }, `${r.ms} ms`)),
              ...blocks);
            return;
          }

          if (!r.rows?.length) {
            out.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-b' },
              el('div', { class: 'row' },
                el('span', { class: 'pill ok' }, `Berhasil · ${r.count ?? 0} baris terpengaruh`),
                el('span', { class: 'pill' }, `${r.ms} ms`)))));
            return;
          }
          out.replaceChildren(
            el('div', { class: 'row', style: 'margin-bottom:8px' },
              el('span', { class: 'pill ok' }, `${r.rows.length} baris`),
              el('span', { class: 'pill' }, `${r.ms} ms`)),
            tableOf(r.rows, r.fields));
        } catch (e) {
          out.replaceChildren(el('div', { class: 'card', style: 'border-color:var(--bad)' },
            el('div', { class: 'card-b mono', style: 'color:var(--bad);white-space:pre-wrap' },
              e.message)));
        }
      };
      ta.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run.click(); };
      body.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'card-b' }, ta,
          el('div', { class: 'row', style: 'margin-top:8px' }, run, expQ,
            el('span', { style: 'font-size:11px;color:var(--tx-3)' }, 'Cmd/Ctrl + Enter')))),
        out);
    }

    /* Daftar basis data di dalam instance */
    async function viewDbs(body) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
      try {
        const r = await call('databases');
        const add = el('button', { class: 'btn pri', html: ic('plus', 13) + '<span>Basis data baru</span>' });
        add.onclick = () => {
          const n = el('input', { placeholder: 'aplikasi_kedua' });
          const b = el('button', { class: 'btn pri' }, 'Create');
          b.onclick = async () => {
            try { await call('ddl', { op: 'create_database', name: n.value.trim() });
              closeDrawer(); toast('Basis data dibuat'); viewDbs(body); } catch (e) { toast(e.message); }
          };
          openDrawer('Basis data baru', el('div', {},
            el('div', { class: 'field' }, el('label', {}, 'Name'), n),
            el('div', { class: 'row' }, b)));
        };
        const tb = el('tbody');
        r.rows.forEach(d => {
          const use = el('button', { class: 'btn', style: 'height:24px;font-size:11px' },
            d.name === curDb ? 'Sedang dipakai' : 'Pakai ini');
          use.disabled = d.name === curDb;
          use.onclick = () => { curDb = d.name; renderDetail(); };
          const drop = el('button', { class: 'ib', html: ic('trash', 14) });
          drop.onclick = async () => {
            if (!confirm(`Hapus basis data "${d.name}" beserta semua tabelnya?`)) return;
            try { await call('ddl', { op: 'drop_database', name: d.name });
              toast('Deleted'); viewDbs(body); } catch (e) { toast(e.message); }
          };
          tb.append(el('tr', {}, el('td', { class: 'mono' }, d.name),
            el('td', { style: 'color:var(--tx-3)' }, d.size || '—'),
            el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end' }, use, drop))));
        });
        body.replaceChildren(
          el('div', { class: 'row', style: 'margin-bottom:12px' },
            el('span', { class: 'pill' }, `${r.rows.length} basis data`),
            el('span', { class: 'sp' }), add),
          el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Name'),
              el('th', {}, 'Size'), el('th', {}, ''))), tb))));
      } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
    }

    async function viewQueryLog(body) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
      let onlyErr = false, onlySlow = false;
      const paint = async () => {
        try {
          const r = await api(`/db/instances/${i.id}/querylog?n=200`
            + (onlyErr ? '&errors=1' : '') + (onlySlow ? '&slow=1' : ''));
          const s2 = r.stats;
          const fErr = el('button', { class: 'tg' + (onlyErr ? ' on' : ''),
            style: 'height:25px;font-size:11px' }, 'Hanya error');
          fErr.onclick = () => { onlyErr = !onlyErr; paint(); };
          const fSlow = el('button', { class: 'tg' + (onlySlow ? ' on' : ''),
            style: 'height:25px;font-size:11px' }, `Hanya lambat (>${r.slowMs} ms)`);
          fSlow.onclick = () => { onlySlow = !onlySlow; paint(); };
          const clr = el('button', { class: 'btn danger', html: ic('trash', 13) + '<span>Clean</span>' });
          clr.onclick = async () => {
            if (!confirm('Hapus seluruh riwayat kueri?')) return;
            await api(`/db/instances/${i.id}/querylog`, { method: 'DELETE' });
            toast('Riwayat dibersihkan'); paint();
          };

          const tb = el('tbody');
          r.log.forEach(q2 => {
            const tr = el('tr', { style: 'cursor:pointer' },
              el('td', { style: 'white-space:nowrap;color:var(--tx-3)' },
                new Date(q2.t).toLocaleTimeString('id-ID')),
              el('td', { class: 'mono', style: 'max-width:340px;overflow:hidden;'
                + 'text-overflow:ellipsis;white-space:nowrap' }, q2.sql),
              el('td', { class: 'num' }, q2.rows == null ? '—' : String(q2.rows)),
              el('td', { class: 'num', style: q2.ms >= r.slowMs ? 'color:var(--warn)' : '' },
                q2.ms + ' ms'),
              el('td', {}, q2.error
                ? el('span', { class: 'pill bad' }, 'error')
                : el('span', { class: 'pill' }, q2.source)));
            tr.onclick = () => openDrawer('Kueri', el('div', {},
              el('div', { class: 'sec', style: 'margin-top:0' }, 'SQL'),
              el('div', { class: 'card' }, el('div', { class: 'card-b mono',
                style: 'white-space:pre-wrap;font-size:11.5px' }, q2.sql)),
              q2.error ? el('div', {}, el('div', { class: 'sec' }, 'Error'),
                el('div', { class: 'card', style: 'border-color:var(--bad)' },
                  el('div', { class: 'card-b mono', style: 'color:var(--bad);white-space:pre-wrap' },
                    q2.error))) : '',
              el('div', { class: 'sec' }, 'Rincian'),
              el('div', { class: 'card' }, el('table', {}, el('tbody', {},
                el('tr', {}, el('td', { style: 'color:var(--tx-3);width:36%' }, 'Time'),
                  el('td', {}, new Date(q2.t).toLocaleString('id-ID'))),
                el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Duration'),
                  el('td', {}, q2.ms + ' ms')),
                el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Baris'),
                  el('td', {}, String(q2.rows ?? '—'))),
                el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Databases'),
                  el('td', { class: 'mono' }, q2.database || '—')),
                el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Run by'),
                  el('td', {}, q2.user || '—')),
                el('tr', {}, el('td', { style: 'color:var(--tx-3)' }, 'Source'),
                  el('td', {}, q2.source === 'sql' ? 'SQL editor' : 'Table browser')))))));
            tb.append(tr);
          });

          body.replaceChildren(
            el('div', { class: 'grid2', style: 'margin-bottom:12px' },
              el('div', { class: 'stat' }, el('div', { class: 'k' }, 'TOTAL KUERI'),
                el('div', { class: 'v' }, String(s2.total)),
                el('div', { class: 'm' }, `rata-rata ${s2.avgMs} ms`)),
              el('div', { class: 'stat' }, el('div', { class: 'k' }, 'KUERI LAMBAT'),
                el('div', { class: 'v', style: s2.slow ? 'color:var(--warn)' : '' },
                  String(s2.slow)),
                el('div', { class: 'm' }, `terlama ${s2.maxMs || 0} ms`)),
              el('div', { class: 'stat' }, el('div', { class: 'k' }, 'GAGAL'),
                el('div', { class: 'v', style: s2.errors ? 'color:var(--bad)' : '' },
                  String(s2.errors)),
                el('div', { class: 'm' }, 'kueri yang error'))),
            el('div', { class: 'row', style: 'margin-bottom:10px' }, fErr, fSlow,
              el('span', { class: 'sp' }), clr),
            r.log.length
              ? el('div', { class: 'card' }, el('div', { class: 'tbl-wrap', style: 'max-height:52vh' },
                  el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'),
                    el('th', {}, 'Kueri'), el('th', { class: 'num' }, 'Baris'),
                    el('th', { class: 'num' }, 'Duration'), el('th', {}, 'Source'))), tb)))
              : el('div', { class: 'card' }, el('div', { class: 'empty' },
                  'No queries logged yet. Jalankan sesuatu di tab SQL atau buka sebuah tabel.')));
        } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
      };
      paint();
    }

    async function viewLogs(body) {
      body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
      try {
        const r = await api(`/db/instances/${i.id}/logs?n=300`);
        body.replaceChildren(el('div', { class: 'logbox', style: 'height:62vh' }, r.log || '(kosong)'));
      } catch (e) { body.replaceChildren(el('div', { class: 'empty' }, e.message)); }
    }
  }

  async function load() {
    try {
      const [e, l] = await Promise.all([
        engines.length ? { engines } : api('/db/engines'), api('/db/instances')]);
      engines = e.engines; list = l.instances; external = l.external || [];
      if (sel) { sel = list.find(x => x.id === sel.id) || null; }
      sel ? null : renderList();
    } catch (er) { wrap.replaceChildren(el('div', { class: 'empty' }, er.message)); }
  }
  every(load, 20000);
};
