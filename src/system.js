// Statistik sistem dibaca langsung dari /proc dan /sys milik HOST
// (di-mount ke /host). Tidak pakai library — isinya file teks biasa.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const H = process.env.HOST_PROC || '/host/proc';
const SYS = process.env.HOST_SYS || '/host/sys';

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
  const txt = await read(`${H}/net/dev`);
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

export async function snapshot() {
  const [c, m, d, t, n, u] = await Promise.all([
    cpu(), memory(), disk(), temperature(), network(), uptime(),
  ]);
  return { cpu: c, memory: m, disk: d, temperature: t, network: n, uptime: u, at: Date.now() };
}
