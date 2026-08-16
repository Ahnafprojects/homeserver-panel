// Auto-scale replika buat app hasil "Deploy otomatis" (Next.js/Node) — bukan
// nambah RAM dari udara (RAM laptop tetap segitu-segitu), tapi supaya
// container yang kena OOM-kill / restart karena mem_limit-nya kepentok TIDAK
// bikin website-nya down: selama ada replika lain yang masih hidup di
// belakang load balancer (lihat autodeploy.js -> "-lb" service), traffic
// tetap dilayani pas satu replika lagi restart. Replika ekstra ditambah
// otomatis pas mendekati batas RAM, dihapus lagi otomatis pas sudah sepi —
// jadi baseline-nya tetap 1 container kayak biasa (hemat RAM), cuma nambah
// pas beneran perlu.
import fsSync from 'node:fs';
import path from 'node:path';
import { runP } from './stacks.js';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'autoscale.json');

const UP_THRESHOLD = 80;   // %mem_limit — kepentok segini, siap-siap nambah replika
const DOWN_THRESHOLD = 30; // %mem_limit — semua replika di bawah ini, siap turunin lagi
const UP_STREAK = 2;       // cek berturut-turut sebelum nambah (hindari nambah gara-gara lonjakan sesaat)
const DOWN_STREAK = 5;     // lebih lama sebelum turun — hindari nambah-turun bolak-balik ("flapping")

const targets = new Map(); // name -> { service, dir, min, max }
const streak = new Map();  // name -> { up: n, down: n }

function load() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(FILE, 'utf8'));
    for (const [name, t] of Object.entries(saved)) targets.set(name, t);
  } catch {}
}
function save() {
  try {
    fsSync.mkdirSync(STATE, { recursive: true });
    fsSync.writeFileSync(FILE, JSON.stringify(Object.fromEntries(targets), null, 2));
  } catch {}
}
load();

export function register(name, { service, dir, min = 1, max = 3 }) {
  targets.set(name, { service, dir, min, max });
  save();
}
export function unregister(name) {
  targets.delete(name);
  streak.delete(name);
  save();
}
export function status() {
  return Object.fromEntries([...targets.entries()].map(([name, t]) => [name, { ...t, streak: streak.get(name) }]));
}

/* Satu panggilan "docker stats" global per tick (bukan per-container) —
   jauh lebih murah daripada nge-loop docker stats satu-satu per replika. */
async function readMemPercents() {
  const { code, out } = await runP('docker',
    ['stats', '--no-stream', '--format', '{{.ID}} {{.MemPerc}}']);
  const map = new Map();
  if (code !== 0) return map;
  for (const line of out.split('\n')) {
    const [id, pct] = line.trim().split(/\s+/);
    if (id && pct) map.set(id, parseFloat(pct));
  }
  return map;
}

async function tickOne(name, t, memPercents, onLine) {
  const { code, out } = await runP('docker', ['compose', 'ps', '-q', t.service], { cwd: t.dir });
  if (code !== 0) return;
  const ids = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return; // stack lagi stop — jangan diapa-apain

  const pcts = ids.map(id => memPercents.get(id.slice(0, 12)) ?? memPercents.get(id)).filter(v => Number.isFinite(v));
  if (pcts.length === 0) return;
  const worst = Math.max(...pcts);

  const s = streak.get(name) || { up: 0, down: 0 };
  s.up = worst >= UP_THRESHOLD ? s.up + 1 : 0;
  s.down = worst <= DOWN_THRESHOLD ? s.down + 1 : 0;
  streak.set(name, s);

  const current = ids.length;
  let nextN = null;
  if (s.up >= UP_STREAK && current < t.max) nextN = current + 1;
  else if (s.down >= DOWN_STREAK && current > t.min) nextN = current - 1;
  if (nextN == null) return;

  s.up = 0; s.down = 0;
  onLine?.(`[autoscale] ${name}: replika ${current} -> ${nextN} (RAM tertinggi ${worst.toFixed(0)}%)`);
  await runP('docker', ['compose', 'up', '-d', '--no-build', '--scale', `${t.service}=${nextN}`], { cwd: t.dir });
}

export async function tick(onLine) {
  if (targets.size === 0) return;
  const memPercents = await readMemPercents();
  for (const [name, t] of targets) {
    try { await tickOne(name, t, memPercents, onLine); } catch {} // satu stack error jangan hentikan yang lain
  }
}
