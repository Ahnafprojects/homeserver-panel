// Disaster-recovery snapshot -- backup rutin yang sudah ada (server-backup)
// nyalin /srv/data & /srv/stacks (isi/config aplikasi), tapi TIDAK pernah
// nyentuh /srv/panel-state (users, vault secrets, uptime checks, API
// token, dst) -- kalau laptop mati total, data aplikasi selamat tapi
// PANEL-nya sendiri harus disetup ulang dari nol. Modul ini nutup celah
// itu: bikin tar.gz dari SELURUH /state, disimpan di /data/panel-dr-snapshots
// -- sengaja di /data (bukan /state sendiri, muter balik) supaya ikut
// numpang di jalur backup HDD+Google Drive yang SUDAH ADA tanpa perlu
// infrastruktur baru sama sekali.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const STATE = process.env.STATE_DIR || '/state';
const OUT_DIR = path.join(process.env.DATA_ROOT || '/data', 'panel-dr-snapshots');
const KEEP = 5;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, opts);
    const err = [];
    p.stderr.on('data', (c) => err.push(c));
    p.on('close', (code) => resolve({ code, err: Buffer.concat(err).toString('utf8') }));
    p.on('error', (e) => resolve({ code: 1, err: e.message }));
  });
}

export async function createSnapshot() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `panel-state-${stamp}.tar.gz`);
  // Kompres dari LUAR /state (cwd = dirname-nya) biar isi arsip pathnya
  // relatif ("./users.json" dst), bukan absolut -- gampang di-restore ke
  // instance mana pun tanpa peduli path aslinya.
  const { code, err } = await run('tar', ['-czf', file, '-C', STATE, '.']);
  if (code !== 0) { await fs.unlink(file).catch(() => {}); throw new Error('tar gagal: ' + err.slice(0, 300)); }
  const st = await fs.stat(file);
  await pruneOld();
  return { file: path.basename(file), size: st.size, t: Date.now() };
}

async function pruneOld() {
  let entries = [];
  try { entries = await fs.readdir(OUT_DIR); } catch { return; }
  const snaps = entries.filter((f) => f.startsWith('panel-state-') && f.endsWith('.tar.gz')).sort();
  const excess = snaps.length - KEEP;
  for (let i = 0; i < excess; i++) await fs.unlink(path.join(OUT_DIR, snaps[i])).catch(() => {});
}

export async function listSnapshots() {
  let entries = [];
  try { entries = await fs.readdir(OUT_DIR); } catch { return []; }
  const snaps = entries.filter((f) => f.startsWith('panel-state-') && f.endsWith('.tar.gz'));
  const out = [];
  for (const f of snaps) {
    try { const st = await fs.stat(path.join(OUT_DIR, f)); out.push({ file: f, size: st.size, t: st.mtimeMs }); } catch {}
  }
  return out.sort((a, b) => b.t - a.t);
}

export function latestSnapshotPath() {
  let entries = [];
  try { entries = fsSync.readdirSync(OUT_DIR); } catch { return null; }
  const snaps = entries.filter((f) => f.startsWith('panel-state-') && f.endsWith('.tar.gz')).sort();
  if (!snaps.length) return null;
  return path.join(OUT_DIR, snaps[snaps.length - 1]);
}

export function snapshotPath(name) {
  if (!/^panel-state-[0-9T-]+Z\.tar\.gz$/.test(name)) return null; // cegah path traversal
  const p = path.join(OUT_DIR, name);
  return fsSync.existsSync(p) ? p : null;
}
