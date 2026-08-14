'use strict';
/* Code editor: pohon berkas, tab, Monaco, dan terminal terpadu.
   Monaco adalah inti editor yang dipakai VS Code, jadi penyorotan sintaks,
   minimap, multi-kursor, dan pintasan papan ketiknya sama persis. */

VIEWS.editor = () => {
  // Workspace = satu folder project yang sedang dibuka, bukan seluruh disk.
  let ws = null;
  try { ws = JSON.parse(localStorage.getItem('ed.ws') || 'null'); } catch {}
  let root = ws?.root || 'stacks';
  const children = new Map();   // path -> daftar isi folder (dimuat saat dibuka)
  const expanded = new Set(JSON.parse(localStorage.getItem('ed.expanded') || '[]'));
  let open = [];            // { root, path, model, dirty }
  let active = null;
  let editor = null;
  let termOpen = false, term = null, sock = null, fitAddon = null;
  /* Autosave: 'off' | 'delay' | 'blur'
     'delay' menunggu berhenti mengetik dulu; menulis tiap ketikan itu boros
     untuk SSD dan memberatkan CPU lama. */
  let autoMode = localStorage.getItem('ed.autosave') || 'delay';
  const AUTO_DELAY = 1500;
  let lastSavedAt = 0;
  let saveError = null;

  /* ── Kerangka tata letak ── */
  const fileTree = el('div', { style: 'flex:1;overflow:auto;padding:4px 0' });
  const searchBox = el('input', { placeholder: 'Search in files…',
    style: 'height:26px;font-size:11.5px' });
  const searchOut = el('div', { style: 'display:none;flex:1;overflow:auto;padding:4px 0' });

  const wsTitle = el('div', { style: 'font-size:11.5px;font-weight:600;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap;flex:1' });
  const wsSwitch = el('button', { class: 'ib', title: 'Open another folder',
    style: 'width:24px;height:24px', html: ic('folder', 13) });
  wsSwitch.onclick = () => pickWorkspace();

  const side = el('div', { style: 'width:236px;flex:0 0 236px;border-right:1px solid var(--line);'
    + 'display:flex;flex-direction:column;background:var(--surface);min-height:0' },
    el('div', { style: 'padding:7px 8px;border-bottom:1px solid var(--line);display:flex;'
      + 'flex-direction:column;gap:6px' },
      el('div', { class: 'row', style: 'gap:5px' }, wsTitle, wsSwitch),
      searchBox),
    fileTree, searchOut);

  const tabBar = el('div', { style: 'height:33px;flex:0 0 33px;display:flex;overflow-x:auto;'
    + 'background:var(--surface);border-bottom:1px solid var(--line)' });
  const host = el('div', { style: 'flex:1;min-height:0' });
  let termHeight = +localStorage.getItem('ed.termHeight') || 230;
  const termPane = el('div', { style: `display:none;height:${termHeight}px;flex:0 0 ${termHeight}px;`
    + 'background:#0b0c0f;padding:5px' });
  const termResize = el('div', { style: 'display:none;height:5px;flex:0 0 5px;cursor:ns-resize;'
    + 'background:var(--line)' });
  termResize.onmouseenter = () => termResize.style.background = 'var(--accent, #5b8def)';
  termResize.onmouseleave = () => termResize.style.background = 'var(--line)';
  termResize.onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = termHeight;
    const onMove = (ev) => {
      termHeight = Math.max(100, Math.min(window.innerHeight * 0.75, startH + (startY - ev.clientY)));
      termPane.style.height = termHeight + 'px';
      termPane.style.flexBasis = termHeight + 'px';
      try { fitAddon?.fit(); editor?.layout(); } catch {}
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('ed.termHeight', String(Math.round(termHeight)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const status = el('div', { style: 'height:23px;flex:0 0 23px;background:var(--surface);'
    + 'border-top:1px solid var(--line);display:flex;align-items:center;gap:12px;'
    + 'padding:0 10px;font-size:10.5px;color:var(--tx-3)' });

  const main = el('div', { style: 'flex:1;display:flex;flex-direction:column;min-width:0;min-height:0' },
    tabBar, host, termResize, termPane, status);

  const wrap = el('div', { style: 'display:flex;height:100%;min-height:0' }, side, main);
  mount(wrap, { full: true });

  /* ── Tombol di bilah atas ── */
  const bSave = addAction('Save', 'edit', () => saveActive(), 'btn pri');
  addAction('New file', 'plus', () => newFile());
  const bTerm = addAction('Terminal', 'term', () => toggleTerm());

  const AUTO_LABEL = { off: 'Autosave off', delay: 'Autosave on', blur: 'Autosave on blur' };
  const bAuto = el('button', { class: 'tg' });
  const paintAuto = () => {
    bAuto.className = 'tg' + (autoMode === 'off' ? '' : ' on');
    bAuto.innerHTML = ic('refresh', 13) + `<span>${AUTO_LABEL[autoMode]}</span>`;
    bAuto.title = {
      off: 'Autosave is off — press Cmd/Ctrl+S to save',
      delay: `Saves automatically ${AUTO_DELAY / 1000}s after you stop typing`,
      blur: 'Saves when you switch tab, file, or leave the window',
    }[autoMode];
  };
  bAuto.onclick = () => {
    autoMode = autoMode === 'delay' ? 'blur' : autoMode === 'blur' ? 'off' : 'delay';
    localStorage.setItem('ed.autosave', autoMode);
    paintAuto(); updateStatus();
    if (autoMode !== 'off') saveAllDirty();
  };
  paintAuto();
  $('#actions').append(bAuto);
  addAction('Reload tree', 'refresh', () => loadTree());

  /* ── Pemilih folder project ── */
  async function pickWorkspace() {
    const list = el('div', { style: 'max-height:52vh;overflow:auto;padding:5px' });
    const box = el('div', { class: 'card', style: 'width:min(560px,92vw);overflow:hidden' },
      el('div', { style: 'padding:12px 14px;border-bottom:1px solid var(--line)' },
        el('div', { style: 'font-size:13px;font-weight:600' }, 'Open folder'),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin-top:3px' },
          'Pick one project to work on. Only that folder is loaded.')),
      list);
    const ov = el('div', { style: 'position:fixed;inset:0;z-index:95;background:#0008;'
      + 'display:flex;align-items:flex-start;justify-content:center;padding-top:10vh' }, box);
    const close = () => ov.remove();
    ov.onclick = (e) => e.target === ov && close();
    document.body.append(ov);
    list.replaceChildren(el('div', { class: 'empty', style: 'padding:26px' }, 'Loading…'));

    try {
      const r = await api('/files/workspaces');
      if (!r.workspaces.length) {
        list.replaceChildren(el('div', { class: 'empty', style: 'padding:26px;font-size:12px' },
          'No project folders yet. Deploy a stack or create a folder in Files first.'));
        return;
      }
      const rows = r.workspaces.map(w => {
        const d = el('div', { class: 'item', style: 'height:38px;font-size:12.5px' });
        d.append(
          el('span', { html: ic('folder', 14) }),
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, w.name),
            el('div', { style: 'font-size:10.5px;color:var(--tx-3)' },
              `${w.root === 'stacks' ? 'Apps' : w.root === 'host' ? 'Laptop' : 'Data'} · ${w.files} items`)),
          w.hint ? el('span', { class: 'pill', style: 'font-size:10px' }, w.hint) : '');
        d.onclick = () => { close(); setWorkspace({ root: w.root, path: w.path, name: w.name }); };
        return d;
      });
      // Pilihan tambahan: buka akar folder, bukan salah satu project.
      const rootRows = [
        { root: 'stacks', path: '', name: 'All apps  (/srv/stacks)' },
        { root: 'data', path: '', name: 'All data  (/srv/data)' },
        { root: 'host', path: '', name: 'Semua file laptop  (/)' },
      ].map(w => {
        const d = el('div', { class: 'item', style: 'height:32px;font-size:12px;color:var(--tx-3)' });
        d.append(el('span', { html: ic('layers', 13) }), el('span', {}, w.name));
        d.onclick = () => { close(); setWorkspace(w); };
        return d;
      });
      const browseRow = el('div', { class: 'item', style: 'height:32px;font-size:12px;color:var(--tx-2)' });
      browseRow.append(el('span', { html: ic('folder', 13) }),
        el('span', {}, 'Jelajahi & pilih folder tertentu di laptop…'));
      browseRow.onclick = () => { close(); browseHostFolder(); };
      list.replaceChildren(
        el('div', { class: 'grp' }, 'Projects'), ...rows,
        el('div', { class: 'grp' }, 'Whole folder'), ...rootRows, browseRow);
    } catch (e) {
      list.replaceChildren(el('div', { class: 'empty', style: 'padding:26px' }, e.message));
    }
  }

  /* ── Jelajahi filesystem laptop, pilih satu folder spesifik ── */
  async function browseHostFolder() {
    let cur = '';
    const crumb = el('div', { class: 'crumb', style: 'font-size:12px' });
    const list = el('div', { style: 'max-height:44vh;overflow:auto;padding:5px' });
    const btnUse = el('button', { class: 'btn pri' }, 'Buka folder ini →');
    const box = el('div', { class: 'card', style: 'width:min(560px,92vw);overflow:hidden' },
      el('div', { style: 'padding:12px 14px;border-bottom:1px solid var(--line)' },
        el('div', { style: 'font-size:13px;font-weight:600' }, 'Jelajahi laptop'),
        el('div', { style: 'font-size:11.5px;color:var(--tx-3);margin:3px 0 8px' },
          'Klik folder untuk masuk, lalu klik "Buka folder ini" di folder yang mau dijadikan project.'),
        el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, crumb, el('span', { class: 'sp' }), btnUse)),
      list);
    const ov = el('div', { style: 'position:fixed;inset:0;z-index:95;background:#0008;'
      + 'display:flex;align-items:flex-start;justify-content:center;padding-top:10vh' }, box);
    const close = () => ov.remove();
    ov.onclick = (e) => e.target === ov && close();
    document.body.append(ov);

    function setCrumb() {
      const parts = cur ? cur.split('/').filter(Boolean) : [];
      crumb.replaceChildren();
      const home = el('a', {}, '/'); home.onclick = () => { cur = ''; load(); };
      crumb.append(home);
      parts.forEach((p, i) => {
        crumb.append(el('span', {}, '/'));
        const a = el('a', {}, p);
        a.onclick = () => { cur = parts.slice(0, i + 1).join('/'); load(); };
        crumb.append(a);
      });
    }
    btnUse.onclick = () => {
      close();
      const name = cur ? cur.split('/').filter(Boolean).pop() : 'laptop';
      setWorkspace({ root: 'host', path: cur, name: `${name}  (/${cur})` });
    };

    async function load() {
      setCrumb();
      list.replaceChildren(el('div', { class: 'empty', style: 'padding:20px' }, 'Loading…'));
      try {
        const { items } = await api(`/files/list?root=host&path=${encodeURIComponent(cur)}`);
        const dirs = items.filter(it => it.dir);
        if (!dirs.length) {
          list.replaceChildren(el('div', { class: 'empty', style: 'padding:20px;font-size:12px' }, 'Tidak ada subfolder di sini.'));
          return;
        }
        list.replaceChildren(...dirs.map(it => {
          const d = el('div', { class: 'item', style: 'height:32px;font-size:12.5px' });
          d.append(el('span', { html: ic('folder', 14) }), el('span', {}, it.name));
          d.onclick = () => { cur = (cur ? cur + '/' : '') + it.name; load(); };
          return d;
        }));
      } catch (e) {
        list.replaceChildren(el('div', { class: 'empty', style: 'padding:20px' }, e.message));
      }
    }
    load();
  }

  function setWorkspace(w) {
    ws = w; root = w.root;
    localStorage.setItem('ed.ws', JSON.stringify(w));
    children.clear(); expanded.clear();
    wsTitle.textContent = w.name;
    wsTitle.title = `${w.root}/${w.path}`;
    loadTree();
  }

  /* ── Pohon berkas ── */
  const ICON_BY_EXT = (n) => {
    if (/\.(js|mjs|cjs|jsx)$/i.test(n)) return '#f0db4f';
    if (/\.(ts|tsx)$/i.test(n)) return '#3178c6';
    if (/\.(json|jsonc)$/i.test(n)) return '#cbcb41';
    if (/\.(ya?ml)$/i.test(n)) return '#cb171e';
    if (/\.(css|scss|less)$/i.test(n)) return '#42a5f5';
    if (/\.(html?|svg)$/i.test(n)) return '#e44d26';
    if (/\.(py)$/i.test(n)) return '#3572A5';
    if (/\.(go)$/i.test(n)) return '#00ADD8';
    if (/\.(sql)$/i.test(n)) return '#e38c00';
    if (/\.(sh|bash)$/i.test(n)) return '#89e051';
    if (/^dockerfile|\.env/i.test(n)) return '#8b91a0';
    if (/\.(md|markdown|txt)$/i.test(n)) return '#8b91a0';
    return 'var(--tx-3)';
  };

  function rowFor(n, depth) {
    const isActive = active && active.path === n.path && active.root === root;
    const row = el('div', {
      style: `display:flex;align-items:center;gap:6px;height:24px;cursor:pointer;`
        + `padding:0 8px 0 ${8 + depth * 12}px;font-size:12px;user-select:none;`
        + (isActive ? 'background:var(--sunken);color:var(--tx)' : 'color:var(--tx-2)') });
    row.onmouseenter = () => { if (!isActive) row.style.background = 'var(--sunken)'; };
    row.onmouseleave = () => { if (!isActive) row.style.background = ''; };
    row.oncontextmenu = (e) => { e.preventDefault(); ctxMenu(e, n); };
    return row;
  }

  async function toggleDir(n) {
    if (expanded.has(n.path)) expanded.delete(n.path);
    else {
      expanded.add(n.path);
      if (!children.has(n.path)) await loadDir(n.path);
    }
    localStorage.setItem('ed.expanded', JSON.stringify([...expanded]));
    renderTree();
  }

  async function loadDir(rel) {
    try {
      const r = await api(`/files/tree?root=${root}&path=${encodeURIComponent(rel)}`);
      children.set(rel, r.items);
    } catch (e) { children.set(rel, []); toast(e.message); }
  }

  function renderTree() {
    fileTree.replaceChildren();
    const base = ws?.path || '';
    const draw = (rel, depth) => {
      const items = children.get(rel);
      if (!items) return;
      items.forEach(n => {
        const row = rowFor(n, depth);
        if (n.dir) {
          const isOpen = expanded.has(n.path);
          row.innerHTML = `<span style="width:10px;font-size:8px;opacity:.6">`
            + `${isOpen ? '▼' : '▶'}</span>`
            + `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.6"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2.5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`
            + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name)}</span>`
            + (n.count ? `<span style="margin-left:auto;font-size:10px;opacity:.45">${n.count}</span>` : '');
          row.onclick = () => toggleDir(n);
          fileTree.append(row);
          if (isOpen) draw(n.path, depth + 1);
        } else {
          row.innerHTML = `<span style="width:10px"></span>`
            + `<span style="width:13px;height:13px;border-radius:3px;flex:0 0 auto;`
            + `background:${ICON_BY_EXT(n.name)};opacity:.85"></span>`
            + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name)}</span>`;
          if (!n.text) row.style.opacity = '.45';
          row.onclick = () => n.text ? openFile(n.path)
            : toast('Binary file — open it from the Files page instead');
          fileTree.append(row);
        }
      });
    };
    if (!children.get(base)?.length) {
      fileTree.replaceChildren(el('div', { class: 'empty', style: 'padding:26px 12px;font-size:11.5px' },
        'This folder is empty'));
      return;
    }
    draw(base, 0);
  }

  /* Menu klik kanan pada pohon berkas. */
  function ctxMenu(e, node) {
    document.querySelector('#ctxmenu')?.remove();
    const menu = el('div', { id: 'ctxmenu', class: 'card',
      style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:95;`
        + 'min-width:160px;padding:4px;box-shadow:0 8px 24px #0004' });
    const item = (label, fn) => {
      const d = el('div', { class: 'item', style: 'height:28px;font-size:12px' }, label);
      d.onclick = () => { menu.remove(); fn(); };
      return d;
    };
    const dir = node.dir ? node.path : node.path.split('/').slice(0, -1).join('/');
    menu.append(
      item('New file here', () => newFile(dir)),
      item('New folder', async () => {
        const name = prompt('Folder name:');
        if (!name) return;
        await api('/files/mkdir', { method: 'POST',
          body: JSON.stringify({ root, path: dir, name }) });
        await loadDir(dir); renderTree();
      }),
      item('Rename', async () => {
        const to = prompt('New name:', node.name);
        if (!to || to === node.name) return;
        const parent = node.path.split('/').slice(0, -1).join('/');
        await api('/files/rename', { method: 'POST', body: JSON.stringify({
          root, from: node.path, to: parent ? parent + '/' + to : to }) });
        await loadDir(parent || ws?.path || ''); renderTree();
      }),
      item('Delete', async () => {
        if (!confirm(`Delete "${node.name}"?`)) return;
        await api('/files/delete', { method: 'POST',
          body: JSON.stringify({ root, path: node.path }) });
        open = open.filter(t => !(t.root === root && t.path === node.path));
        if (active && active.path === node.path) { active = null; showActive(); }
        const parent = node.path.split('/').slice(0, -1).join('/');
        await loadDir(parent || ws?.path || ''); renderTree(); renderTabs();
      }));
    document.body.append(menu);
    const close = () => { menu.remove(); removeEventListener('click', close); };
    setTimeout(() => addEventListener('click', close), 0);
  }

  async function loadTree() {
    if (!ws) return;
    const base = ws.path || '';
    fileTree.replaceChildren(el('div', { class: 'empty', style: 'padding:24px;font-size:11.5px' },
      'Loading…'));
    await loadDir(base);
    // Muat ulang folder yang sebelumnya terbuka supaya posisinya kembali.
    for (const pth of [...expanded]) if (!children.has(pth)) await loadDir(pth);
    renderTree();
  }

  /* ── Tab ── */
  function renderTabs() {
    tabBar.replaceChildren();
    open.forEach(t => {
      const on = active && active.path === t.path && active.root === t.root;
      const tab = el('div', {
        style: 'display:flex;align-items:center;gap:7px;padding:0 9px;height:100%;'
          + 'cursor:pointer;font-size:12px;white-space:nowrap;border-right:1px solid var(--line);'
          + (on ? 'background:var(--bg);color:var(--tx);box-shadow:inset 0 -2px 0 var(--acc)'
                : 'color:var(--tx-3)') });
      tab.append(el('span', {}, t.path.split('/').pop()));
      if (t.dirty) tab.append(el('span', { style: 'width:6px;height:6px;border-radius:50%;'
        + 'background:var(--acc);flex:0 0 auto' }));
      const x = el('span', { style: 'opacity:.5;font-size:13px;padding:0 2px' }, '×');
      x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
      tab.append(x);
      tab.onclick = () => {
        if (autoMode !== 'off' && active && active !== t) saveTab(active, { quiet: true });
        active = t; showActive(); renderTabs(); renderTree();
      };
      tabBar.append(tab);
    });
  }

  async function closeTab(t) {
    clearTimeout(t.timer);
    if (t.dirty && autoMode !== 'off') await saveTab(t, { quiet: true });
    if (t.dirty && !confirm(`"${t.path.split('/').pop()}" has unsaved changes. Close anyway?`)) return;
    const i = open.indexOf(t);
    open.splice(i, 1);
    t.model?.dispose();
    if (active === t) { active = open[Math.max(0, i - 1)] || null; showActive(); }
    renderTabs(); renderTree();
  }

  /* ── Editor ── */
  const langOf = (f) => {
    const ext = (f.split('.').pop() || '').toLowerCase();
    const base = f.split('/').pop().toLowerCase();
    if (/^dockerfile/.test(base)) return 'dockerfile';
    if (/^(makefile)$/.test(base)) return 'plaintext';
    if (/^\.env/.test(base) || base === 'caddyfile') return 'ini';
    return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
      yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown',
      css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
      xml: 'xml', svg: 'xml', sql: 'sql', py: 'python', rb: 'ruby', go: 'go',
      rs: 'rust', java: 'java', kt: 'kotlin', php: 'php', c: 'c', h: 'c',
      cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', lua: 'lua',
      sh: 'shell', bash: 'shell', zsh: 'shell', toml: 'ini', ini: 'ini',
      conf: 'ini', cfg: 'ini' }[ext]) || 'plaintext';
  };

  async function openFile(p2) {
    if (autoMode !== 'off' && active) await saveTab(active, { quiet: true });
    const found = open.find(t => t.path === p2 && t.root === root);
    if (found) { active = found; showActive(); renderTabs(); renderTree(); return; }
    try {
      const r = await api(`/files/read?root=${root}&path=${encodeURIComponent(p2)}`);
      const model = monaco.editor.createModel(r.content, langOf(p2));
      const tab = { root, path: p2, model, dirty: false };
      model.onDidChangeContent(() => {
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        updateStatus();
        scheduleAutosave(tab);
      });
      open.push(tab); active = tab;
      showActive(); renderTabs(); renderTree();
    } catch (e) { toast(e.message); }
  }

  function showActive() {
    if (!editor) return;
    if (!active) {
      editor.setModel(monaco.editor.createModel(
        '// Pick a file from the tree, or press Cmd/Ctrl + P\n', 'javascript'));
      status.replaceChildren(el('span', {}, 'No file open'));
      return;
    }
    editor.setModel(active.model);
    editor.focus();
    updateStatus();
  }

  function saveLabel() {
    if (saveError) return el('span', { style: 'color:var(--bad)' }, 'save failed');
    if (active?.saving) return el('span', { style: 'color:var(--acc)' }, 'saving…');
    if (active?.dirty) {
      return el('span', { style: 'color:var(--acc)' },
        autoMode === 'delay' ? 'unsaved · autosaving'
        : autoMode === 'blur' ? 'unsaved · saves on blur' : 'unsaved');
    }
    if (lastSavedAt && Date.now() - lastSavedAt < 60000) {
      const s2 = Math.round((Date.now() - lastSavedAt) / 1000);
      return el('span', { style: 'color:var(--ok)' }, s2 < 3 ? 'saved' : `saved ${s2}s ago`);
    }
    return el('span', {}, 'saved');
  }

  function updateStatus() {
    if (!active || !editor) return;
    const pos = editor.getPosition() || { lineNumber: 1, column: 1 };
    const m = active.model;
    status.replaceChildren(
      el('span', {}, `${root}/${active.path}`),
      el('span', { class: 'sp', style: 'flex:1' }),
      el('span', {}, langOf(active.path)),
      el('span', {}, `${m.getLineCount()} lines`),
      el('span', {}, `Ln ${pos.lineNumber}, Col ${pos.column}`),
      el('span', {}, AUTO_LABEL[autoMode]),
      saveLabel());
  }
  // Penyegar ringan agar teks "saved 12s ago" ikut berjalan.
  timers.push(setInterval(() => { if (active && !active.dirty) updateStatus(); }, 5000));

  /* Menyimpan satu tab. `quiet` dipakai autosave agar tidak memunculkan
     notifikasi tiap kali. Penjaga `saving` mencegah dua penulisan bertumpuk
     pada berkas yang sama. */
  async function saveTab(tab, { quiet = false } = {}) {
    if (!tab || !tab.dirty || tab.saving) return false;
    tab.saving = true;
    const snapshot = tab.model.getValue();
    updateStatus();
    try {
      await api('/files/write', { method: 'POST', body: JSON.stringify({
        root: tab.root, path: tab.path, content: snapshot }) });
      // Kalau isinya berubah lagi selama penyimpanan, biarkan tetap kotor
      // supaya perubahan terbaru ikut tersimpan pada putaran berikutnya.
      if (tab.model.getValue() === snapshot) tab.dirty = false;
      lastSavedAt = Date.now();
      saveError = null;
      renderTabs(); updateStatus();
      if (!quiet) toast('Saved  ' + tab.path.split('/').pop());
      return true;
    } catch (e) {
      saveError = e.message;
      updateStatus();
      // Kegagalan tidak boleh sunyi, bahkan saat autosave.
      toast('Save failed: ' + e.message);
      return false;
    } finally {
      tab.saving = false;
    }
  }

  const saveActive = () => active ? saveTab(active) : toast('No file open');
  const saveAllDirty = () => Promise.all(
    open.filter(t => t.dirty).map(t => saveTab(t, { quiet: true })));

  /* Penjadwal autosave per tab. */
  function scheduleAutosave(tab) {
    if (autoMode !== 'delay') return;
    clearTimeout(tab.timer);
    tab.timer = setTimeout(() => saveTab(tab, { quiet: true }), AUTO_DELAY);
    timers.push({ close: () => clearTimeout(tab.timer) });
  }

  async function newFile(dir = '') {
    const rel = dir && ws?.path ? dir.slice((ws.path + '/').length) : dir;
    const name = prompt('New file name (you may include a folder):',
      rel ? rel + '/untitled.txt' : 'untitled.txt');
    if (!name) return;
    try {
      const full = (ws?.path ? ws.path + '/' : '') + name;
      await api('/files/create', { method: 'POST',
        body: JSON.stringify({ root, path: '', name: full, content: '' }) });
      const parent = full.split('/').slice(0, -1).join('/');
      await loadDir(parent || ws?.path || ''); renderTree();
      openFile(full);
    } catch (e) { toast(e.message); }
  }

  /* ── Pencarian isi berkas ── */
  let searchTimer;
  searchBox.oninput = () => {
    clearTimeout(searchTimer);
    const term = searchBox.value.trim();
    if (term.length < 2) {
      searchOut.style.display = 'none'; fileTree.style.display = ''; return;
    }
    searchTimer = setTimeout(async () => {
      searchOut.style.display = ''; fileTree.style.display = 'none';
      searchOut.replaceChildren(el('div', { class: 'empty', style: 'padding:20px;font-size:11.5px' },
        'Searching…'));
      try {
        const r = await api(`/files/search?root=${root}&base=`
          + `${encodeURIComponent(ws?.path || '')}&q=${encodeURIComponent(term)}`);
        if (!r.matches.length) {
          searchOut.replaceChildren(el('div', { class: 'empty', style: 'padding:20px;font-size:11.5px' },
            'No matches'));
          return;
        }
        const byFile = {};
        r.matches.forEach(m => (byFile[m.path] ||= []).push(m));
        searchOut.replaceChildren(
          el('div', { style: 'padding:5px 9px;font-size:10.5px;color:var(--tx-3)' },
            `${r.matches.length} matches in ${Object.keys(byFile).length} files`),
          ...Object.entries(byFile).map(([f, ms]) => el('div', {},
            el('div', { style: 'padding:4px 9px;font-size:11px;font-weight:600;color:var(--tx-2)' },
              f),
            ...ms.slice(0, 8).map(m => {
              const d = el('div', { style: 'padding:2px 9px 2px 18px;font-size:11px;'
                + 'color:var(--tx-3);cursor:pointer;font-family:var(--mono);'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
                `${m.line}: ${m.text}`);
              d.onclick = async () => {
                await openFile(f);
                setTimeout(() => {
                  editor.revealLineInCenter(m.line);
                  editor.setPosition({ lineNumber: m.line, column: 1 });
                  editor.focus();
                }, 120);
              };
              return d;
            }))));
      } catch (e) {
        searchOut.replaceChildren(el('div', { class: 'empty', style: 'padding:20px' }, e.message));
      }
    }, 400);
  };

  /* ── Terminal terpadu ── */
  function toggleTerm() {
    termOpen = !termOpen;
    termPane.style.display = termOpen ? 'block' : 'none';
    termResize.style.display = termOpen ? 'block' : 'none';
    bTerm.classList.toggle('pri', termOpen);
    if (termOpen && !term) startTerm();
    setTimeout(() => { editor?.layout(); try { fitAddon?.fit(); } catch {} }, 60);
  }

  function startTerm() {
    if (!window.Terminal) { toast('Terminal component is still loading'); return; }
    term = new Terminal({ fontSize: 12, fontFamily: 'ui-monospace,Menlo,monospace',
      cursorBlink: true, scrollback: 3000,
      theme: { background: '#0b0c0f', foreground: '#d6dae1', cursor: '#5b8def' } });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termPane);
    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 60);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Samain posisi terminal sama folder project yang lagi dibuka — kayak
    // VS Code, buka folder "backend" -> terminal langsung di situ.
    const HOST_PREFIX = { data: '/srv/data', stacks: '/srv/stacks', host: '' };
    const cwdParam = ws ? `?cwd=${encodeURIComponent((HOST_PREFIX[ws.root] ?? '') + '/' + (ws.path || ''))}` : '';
    sock = new WebSocket(`${proto}://${location.host}/ws/term${cwdParam}`);
    sock.binaryType = 'arraybuffer';
    sock.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    sock.onclose = () => term.write('\r\n\x1b[90m— session ended —\x1b[0m\r\n');
    term.onData(d => sock.readyState === 1 && sock.send(d));
    term.onResize(({ rows, cols }) => sock.readyState === 1 && sock.send(`\x00resize:${rows},${cols}`));
    timers.push({ close: () => { sock?.close(); term?.dispose(); } });
  }

  /* ── Muat Monaco lalu bangun editor ── */
  function boot() {
    require.config({ paths: { vs: '/vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], () => {
      // Wadah dikosongkan dulu: pesan "Loading editor…" ada di sini, dan
      // Monaco hanya menambah DOM-nya tanpa menghapus isi sebelumnya.
      host.replaceChildren();
      const dark = getComputedStyle(document.body)
        .getPropertyValue('--bg').trim().startsWith('#0');
      editor = monaco.editor.create(host, {
        value: '', language: 'javascript',
        theme: dark ? 'vs-dark' : 'vs',
        automaticLayout: true,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        minimap: { enabled: true, maxColumn: 70 },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        wordWrap: 'off',
        bracketPairColorization: { enabled: true },
        // CPU lama: matikan hal-hal yang boros menggambar.
        cursorSmoothCaretAnimation: 'off',
        smoothScrolling: false,
        occurrencesHighlight: 'off',
      });
      editor.onDidChangeCursorPosition(updateStatus);

      // Pintasan ala VS Code.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, toggleTerm);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, quickOpen);

      showActive();
      if (ws) { wsTitle.textContent = ws.name; loadTree(); }
      else { wsTitle.textContent = 'No folder open'; pickWorkspace(); }
    });
  }

  /* Buka cepat berkas — Cmd/Ctrl + P */
  function quickOpen() {
    const flat = [];
    for (const items of children.values()) {
      items.forEach(n => { if (!n.dir && n.text) flat.push(n.path); });
    }
    const inp = el('input', { placeholder: 'Type a file name…',
      style: 'height:34px;font-size:13px;border:0;border-bottom:1px solid var(--line);border-radius:0' });
    const list = el('div', { style: 'max-height:44vh;overflow:auto;padding:5px' });
    const box = el('div', { class: 'card', style: 'width:min(520px,92vw);overflow:hidden' },
      el('div', { style: 'padding:0 12px' }, inp), list);
    const ov = el('div', { style: 'position:fixed;inset:0;z-index:95;background:#0008;'
      + 'display:flex;align-items:flex-start;justify-content:center;padding-top:14vh' }, box);
    const close = () => ov.remove();
    ov.onclick = (e) => e.target === ov && close();
    const paint = () => {
      const q2 = inp.value.toLowerCase();
      const hits = (q2 ? flat.filter(f => f.toLowerCase().includes(q2)) : flat).slice(0, 20);
      list.replaceChildren(...(hits.length ? hits.map((f, i) => {
        const d = el('div', { class: 'item' + (i === 0 ? ' on' : ''), style: 'height:28px;font-size:12px' },
          f);
        d.onclick = () => { close(); openFile(f); };
        return d;
      }) : [el('div', { class: 'empty', style: 'padding:22px' }, 'No files')]));
    };
    inp.oninput = paint;
    inp.onkeydown = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') list.querySelector('.item')?.click();
    };
    document.body.append(ov); inp.focus(); paint();
  }

  // Mode 'blur' dan pengaman umum: simpan saat jendela ditinggalkan atau
  // tab peramban disembunyikan.
  const onBlur = () => { if (autoMode !== 'off') saveAllDirty(); };
  addEventListener('blur', onBlur);
  const onHide = () => { if (document.hidden && autoMode !== 'off') saveAllDirty(); };
  document.addEventListener('visibilitychange', onHide);
  timers.push({ close: () => {
    removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onHide);
    // Tinggalkan halaman dengan bersih: simpan apa pun yang tersisa.
    if (autoMode !== 'off') saveAllDirty();
  } });

  // Simpan lewat Cmd+S walau fokus sedang di luar editor.
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
  };
  addEventListener('keydown', onKey);
  timers.push({ close: () => removeEventListener('keydown', onKey) });

  // Peringatan bila menutup halaman dengan perubahan belum disimpan.
  const onLeave = (e) => {
    if (autoMode !== 'off') return;   // sudah tersimpan sendiri
    if (open.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
  };
  addEventListener('beforeunload', onLeave);
  timers.push({ close: () => removeEventListener('beforeunload', onLeave) });

  const showLoading = (text) => host.replaceChildren(
    el('div', { class: 'empty', style: 'padding:40px;font-size:12.5px' }, text));

  if (window.monaco || window.require) { showLoading('Starting editor…'); boot(); }
  else {
    showLoading('Loading editor…');
    const tag = document.createElement('script');
    tag.src = '/vendor/monaco/vs/loader.js';
    tag.onload = boot;
    tag.onerror = () => showLoading('Failed to load the editor component');
    document.head.append(tag);
    // Kalau berkas loader-nya tidak sampai, jangan diam selamanya.
    setTimeout(() => {
      if (!editor) showLoading('Editor is taking unusually long — check the browser console');
    }, 15000);
  }
};
