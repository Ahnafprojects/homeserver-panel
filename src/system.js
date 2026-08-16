// Statistik sistem dibaca langsung dari /proc dan /sys milik HOST
// (di-mount ke /host). Tidak pakai library — isinya file teks biasa.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const H = process.env.HOST_PROC || '/host/proc';
const SYS = process.env.HOST_SYS || '/host/sys';
const ROOT = process.env.HOST_ROOT || '/host/root';

const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return ''; } };

let prevCpu = null;
let prevNet = null;

export async function cpu() {
  const txt = await read(`${H}/stat`);
  const line = txt.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return { percent: 0, cores: 0 };
  const v = line.split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0);
  const total = v.reduce((a, b) => a + b, 0);
  let percent = 0;
  if (prevCpu) {
    const dt = total - prevCpu.total, di = idle - prevCpu.idle;
    if (dt > 0) percent = +(((dt - di) / dt) * 100).toFixed(1);
  }
  prevCpu = { total, idle };
  const cores = txt.split('\n').filter((l) => /^cpu\d/.test(l)).length;
  const load = (await read(`${H}/loadavg`)).split(' ').slice(0, 3).map(Number);
  return { percent, cores, load };
}

export async function memory() {
  const txt = await read(`${H}/meminfo`);
  const g = (k) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? +m[1] * 1024 : 0;
  };
  const total = g('MemTotal'), avail = g('MemAvailable');
  const swapTotal = g('SwapTotal'), swapFree = g('SwapFree');
  return {
    total, available: avail, used: total - avail,
    percent: total ? +(((total - avail) / total) * 100).toFixed(1) : 0,
    swapTotal, swapUsed: swapTotal - swapFree,
  };
}

// Breakdown "apa yang paling makan disk" di level HOST (bukan cuma docker)
// — folder data pengguna, stacks yang di-deploy, docker sendiri, backup,
// log sistem, home user. Tiap folder dikasih timeout sendiri (15 detik)
// biar satu folder gede yang lambat di-scan tidak bikin seluruh permintaan
// menggantung — kalau timeout, baris itu dilewati (bukan gagal semua).
const DISK_PATHS = [
  { label: 'Files (/srv/data)', path: '/srv/data' },
  { label: 'Stacks (/srv/stacks)', path: '/srv/stacks' },
  { label: 'Docker (images, volume, dst)', path: '/var/lib/docker' },
  { label: 'Backup HDD (/mnt/backup)', path: '/mnt/backup' },
  { label: 'Log sistem (/var/log)', path: '/var/log' },
  { label: 'Home user', path: '/home' },
];
export async function diskBreakdown() {
  const out = [];
  await Promise.all(DISK_PATHS.map(async ({ label, path: p }) => {
    try {
      const { stdout } = await exec('du', ['-sxb', `${ROOT}${p}`], { timeout: 15000 });
      const bytesUsed = +stdout.trim().split(/\s+/)[0];
      if (Number.isFinite(bytesUsed)) out.push({ label, path: p, bytes: bytesUsed });
    } catch {} // folder tidak ada, atau timeout — dilewati aja
  }));
  return out.sort((a, b) => b.bytes - a.bytes);
}

export async function disk() {
  // Beberapa kandidat dicoba, lalu diambil yang totalnya paling besar.
  // Alasannya: di dalam container, "/" sering berupa overlay kecil yang
  // menyesatkan, sedangkan yang ingin dilaporkan adalah disk sebenarnya.
  const candidates = ['/host/root', process.env.DATA_ROOT || '/data', '/'];
  let best = { total: 0, used: 0, free: 0, percent: 0 };
  for (const c of candidates) {
    try {
      const { stdout } = await exec('df', ['-PB1', c]);
      const p = stdout.trim().split('\n')[1].split(/\s+/);
      const total = +p[1];
      // Abaikan hasil di bawah 5 GB — hampir pasti overlay container.
      if (total > 5e9 && total > best.total) {
        best = { total, used: +p[2], free: +p[3], percent: +p[4].replace('%', '') };
      }
    } catch {}
  }
  return best;
}

// Suhu penting untuk laptop tua yang menyala 24/7 — ini yang paling
// sering jadi penyebab server mati mendadak.
export async function temperature() {
  try {
    const zones = await fs.readdir(`${SYS}/class/thermal`).catch(() => []);
    let max = 0, found = false;
    for (const z of zones) {
      if (!z.startsWith('thermal_zone')) continue;
      const v = +(await read(`${SYS}/class/thermal/${z}/temp`)).trim();
      if (!isNaN(v) && v > 0) { found = true; max = Math.max(max, v > 1000 ? v / 1000 : v); }
    }
    if (found) return +max.toFixed(1);
    // Cadangan: sebagian mesin melaporkan lewat hwmon, bukan thermal zone.
    const hw = await fs.readdir(`${SYS}/class/hwmon`).catch(() => []);
    for (const h of hw) {
      const v = +(await read(`${SYS}/class/hwmon/${h}/temp1_input`)).trim();
      if (!isNaN(v) && v > 0) return +(v > 1000 ? v / 1000 : v).toFixed(1);
    }
  } catch {}
  return null;
}

export async function network() {
  // Sengaja lewat /1/net/dev (proses PID 1 di host), BUKAN /net/dev
  // langsung. /proc/net/dev itu symlink ke /proc/self/net/dev, dan "self"
  // di-resolve berdasarkan namespace jaringan PROSES YANG BACA — karena
  // container ini cuma share pid namespace host (bukan network namespace),
  // /host/proc/net/dev tetap balik ke jaringan virtual container sendiri
  // (cuma eth0 kecil), bukan wlan/eth host beneran. Baca via PID 1 (init
  // host, pasti di root network namespace) buat dapet angka yang bener.
  const txt = await read(`${H}/1/net/dev`);
  let rx = 0, tx = 0;
  for (const l of txt.split('\n').slice(2)) {
    const m = l.trim().split(/[\s:]+/);
    if (!m[0] || m[0] === 'lo') continue;
    rx += +m[1] || 0; tx += +m[9] || 0;
  }
  const now = Date.now();
  let rxRate = 0, txRate = 0;
  if (prevNet) {
    const dt = (now - prevNet.t) / 1000;
    if (dt > 0) {
      rxRate = Math.max(0, (rx - prevNet.rx) / dt);
      txRate = Math.max(0, (tx - prevNet.tx) / dt);
    }
  }
  prevNet = { rx, tx, t: now };
  return { rx, tx, rxRate, txRate };
}

export async function uptime() {
  const v = +(await read(`${H}/uptime`)).split(' ')[0];
  return isNaN(v) ? 0 : v;
}

// Standar Linux HZ (jumlah tick per detik yang dipakai kernel di
// /proc/[pid]/stat) — hampir selalu 100 di kernel modern x86/arm.
const CLK_TCK = 100;
let prevProc = new Map(); // pid -> { ticks, at }
let userMap = null, userMapAt = 0;

async function usernames() {
  // /etc/passwd host jarang berubah — cache 60 detik biar tidak baca ulang
  // tiap poll.
  if (userMap && Date.now() - userMapAt < 60000) return userMap;
  const txt = await read(`${ROOT}/etc/passwd`);
  const map = new Map();
  for (const line of txt.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid) map.set(uid, name);
  }
  userMap = map; userMapAt = Date.now();
  return map;
}

// Daftar proses ala Task Manager/Activity Monitor — dibaca langsung dari
// /proc/[pid]/* milik HOST (bukan container ini), soalnya panel jalan
// dengan pid:host jadi bisa lihat proses host apa adanya. %CPU dihitung
// manual dari delta utime+stime antar dua kali polling (metode yang sama
// dipakai `top`), karena BusyBox ps di image ini tidak punya opsi --sort
// atau kolom %cpu bawaan.
export async function processes() {
  const uids = await usernames();
  let names;
  try { names = await fs.readdir(H); } catch { return []; }
  const now = Date.now();
  const alive = new Set();
  const out = [];

  await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (pid) => {
    alive.add(pid);
    try {
      const statTxt = (await read(`${H}/${pid}/stat`)).trim();
      const m = statTxt.match(/^(\d+)\s+\((.*)\)\s+(\S)\s+(.*)$/);
      if (!m) return;
      const comm = m[2], state = m[3];
      const rest = m[4].trim().split(/\s+/);
      const ppid = +rest[0];
      const utime = +rest[10], stime = +rest[11];
      const ticks = utime + stime;

      const statusTxt = await read(`${H}/${pid}/status`);
      const uidM = statusTxt.match(/^Uid:\s+(\d+)/m);
      const rssM = statusTxt.match(/^VmRSS:\s+(\d+)\s*kB/m);
      const uid = uidM ? uidM[1] : null;

      let cmd = (await read(`${H}/${pid}/cmdline`)).split('\0').filter(Boolean).join(' ');
      if (!cmd) cmd = `[${comm}]`;

      const prev = prevProc.get(pid);
      let cpuPct = 0;
      if (prev) {
        const dt = (now - prev.at) / 1000;
        if (dt > 0) cpuPct = Math.max(0, ((ticks - prev.ticks) / CLK_TCK) / dt * 100);
      }
      prevProc.set(pid, { ticks, at: now });

      out.push({
        pid: +pid, ppid, user: uid != null ? (uids.get(uid) || uid) : '?',
        name: comm, cmd, state, cpu: +cpuPct.toFixed(1),
        rss: rssM ? +rssM[1] * 1024 : 0,
      });
    } catch {}
  }));

  for (const k of prevProc.keys()) if (!alive.has(k)) prevProc.delete(k);
  return out;
}

export async function killProcess(pid, signal = 'TERM') {
  const p = +pid;
  if (!Number.isInteger(p) || p <= 1) throw new Error('PID tidak valid');
  process.kill(p, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
}

export async function snapshot() {
  const [c, m, d, t, n, u] = await Promise.all([
    cpu(), memory(), disk(), temperature(), network(), uptime(),
  ]);
  return { cpu: c, memory: m, disk: d, temperature: t, network: n, uptime: u, at: Date.now() };
}
