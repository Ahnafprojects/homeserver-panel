// Auto-hapus log container yang lebih tua dari N hari (default 3), tapi
// tetap nyimpen N hari terakhir -- beda dari rotasi ukuran (max-size/
// max-file) yang sudah ada di daemon, ini rotasi berdasarkan WAKTU.
//
// Container panel bisa lihat filesystem host lewat mount /:/host/root
// (lihat docker-compose.yml), jadi file log json-file Docker
// (<id>-json.log, satu baris JSON per entri log dengan field "time")
// bisa dibaca & ditulis ulang langsung dari sini.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { docker } from './docker.js';

const HOST_ROOT = process.env.HOST_ROOT || '/host/root';
const STATE = process.env.STATE_DIR || '/state';
const STATUS_FILE = path.join(STATE, 'log-retention-status.json');
const DEFAULT_DAYS = 3;

function hostPath(containerLogPath) {
  // LogPath dari docker inspect itu path di HOST ("/var/lib/docker/..."),
  // container ini lihatnya lewat /host/root/var/lib/docker/...
  return path.join(HOST_ROOT, containerLogPath);
}

export async function cleanOneFile(file, cutoffMs) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { kept: 0, dropped: 0, freed: 0 }; }
  if (!raw) return { kept: 0, dropped: 0, freed: 0 };
  const lines = raw.split('\n').filter(Boolean);
  const keep = [];
  let dropped = 0;
  for (const l of lines) {
    let t = null;
    try { t = Date.parse(JSON.parse(l).time); } catch {}
    if (t && t < cutoffMs) dropped++; else keep.push(l);
  }
  if (dropped === 0) return { kept: keep.length, dropped: 0, freed: 0 };
  const before = Buffer.byteLength(raw);
  const newContent = keep.length ? keep.join('\n') + '\n' : '';
  const tmp = file + '.tmp-retention';
  await fsp.writeFile(tmp, newContent);
  await fsp.rename(tmp, file); // atomic -- Docker tetap bisa nulis ke fd lama sampai proses append berikutnya buka lagi
  const freed = before - Buffer.byteLength(newContent);
  return { kept: keep.length, dropped, freed };
}

/* Rotated log file (mis. <id>-json.log.1, .2) tidak nambah entri baru lagi
   -- kalau SELURUH isinya lebih tua dari cutoff, hapus filenya langsung
   daripada baca+filter (lebih murah dan hasilnya sama). */
async function cleanRotated(dir, activeBase, cutoffMs) {
  let freed = 0, removed = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return { freed, removed }; }
  for (const name of entries) {
    if (!name.startsWith(activeBase + '.')) continue; // hanya file rotasi milik container ini
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs < cutoffMs) { freed += st.size; await fsp.unlink(full); removed++; }
    } catch {}
  }
  return { freed, removed };
}

export async function runCleanup(days = DEFAULT_DAYS) {
  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
  let containers = [];
  try { containers = await docker.listContainers(); } catch {}
  let totalFreed = 0, totalDropped = 0, filesTouched = 0;
  for (const c of containers) {
    let info;
    try { info = await docker.inspect(c.Id); } catch { continue; }
    const logPath = info.LogPath;
    if (!logPath || info.HostConfig?.LogConfig?.Type !== 'json-file') continue; // driver lain (mis. journald) tidak berlaku
    const file = hostPath(logPath);
    if (!fs.existsSync(file)) continue;
    const r = await cleanOneFile(file, cutoffMs);
    if (r.dropped > 0) { totalFreed += r.freed; totalDropped += r.dropped; filesTouched++; }
    const rot = await cleanRotated(path.dirname(file), path.basename(logPath), cutoffMs);
    totalFreed += rot.freed;
  }
  const status = { t: Date.now(), days, filesTouched, linesDropped: totalDropped, bytesFreed: totalFreed };
  try { await fsp.writeFile(STATUS_FILE, JSON.stringify(status, null, 2)); } catch {}
  return status;
}

export function lastRun() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return null; }
}

export function retentionDays() {
  const v = +(process.env.LOG_RETENTION_DAYS || DEFAULT_DAYS);
  return v > 0 ? v : DEFAULT_DAYS;
}
