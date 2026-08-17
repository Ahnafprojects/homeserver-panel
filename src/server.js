import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { docker, dockerExtra, demuxDockerStream, cpuPercent, memUsage, netStats } from './docker.js';
import { makeSeriesStore } from './historyStore.js';
import * as registryCheck from './registryCheck.js';
import * as apiTokens from './apiTokens.js';
import * as webpush from './webpush.js';
import * as vulnScan from './vulnScan.js';
import * as mailer from './mailer.js';
import * as logRetention from './logRetention.js';
import * as drSnapshot from './drSnapshot.js';
import * as auth from './auth.js';
import * as stacks from './stacks.js';
import * as autodeploy from './autodeploy.js';
import * as autoscale from './autoscale.js';
import * as admin from './admin.js';
import * as ev from './events.js';
import * as ai from './ai.js';
import * as proxy from './proxy.js';
import * as tunnel from './tunnel.js';
import * as dbaas from './dbaas.js';
import * as gdrive from './gdrive.js';
import * as dbapi from './dbapi.js';
import { WebSocketServer } from 'ws';
import * as sys from './system.js';
import * as pty from 'node-pty';

// Dipakai khusus untuk terminal web (/ws/term). Implementasi WS tulisan sendiri
// (ws.js) di-drop untuk endpoint ini karena ada bug framing yang tidak
// terlacak — beberapa client (Firefox, python `websockets`) menolak
// handshake-nya walau byte-nya sudah diverifikasi identik dengan implementasi
// yang benar. Endpoint lain di panel ini tidak pakai WebSocket sama sekali.
const wss = new WebSocketServer({ noServer: true });

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dir, '..', 'public');
const DATA_ROOT = process.env.DATA_ROOT || '/data';
const STATE_DIR = process.env.STATE_DIR || '/state';
const PORT = +(process.env.PORT || 8080);
// Port kedua, khusus buat cloudflared (lihat penjelasan di dekat definisi
// tunnelServer) — dipublish ke host cuma lewat 127.0.0.1, tidak pernah
// kena LAN atau internet.
const TUNNEL_PORT = +(process.env.TUNNEL_PORT || 8081);

// Bisa diisi lewat .env ATAU lewat wizard setup di web (vault) -- vault
// diprioritaskan supaya template ini bisa dipakai orang lain tanpa
// nyentuh .env, sama seperti pola GDRIVE_CLIENT_ID/SECRET.
const tgToken = () => admin.getSecret('TG_TOKEN') || process.env.TG_TOKEN || '';
const tgChat = () => admin.getSecret('TG_CHAT') || process.env.TG_CHAT || '';

// ── Utilitas ────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' });
  res.end(b);
};
const ok = (res, o = { ok: true }) => json(res, 200, o);
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fail = (res, e, code = 500) =>
  json(res, code, { error: String(e?.message || e) });

const readBody = (req, limit = 64 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => {
    n += c.length;
    if (n > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req) => {
  // Badan permintaan hanya bisa dibaca sekali; kalau penjaga izin sudah
  // membacanya lebih dulu, pakai hasil itu.
  if (req._parsedBody) return req._parsedBody;
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
};

async function notify(title, body) {
  const token = tgToken(), chat = tgChat();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat, parse_mode: 'HTML',
        text: `<b>${title}</b>\n\n${body}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

ev.setTelegramSender((t, m) => notify(t, m));
ev.setPushSender((t, m) => webpush.sendToAll(t, m).catch(() => {}));
ev.setEmailSender((t, m) => mailer.send(t, m).catch(() => {}));

// ── Riwayat metrik ──────────────────────────────────────────────────────────
// Disimpan di memori (cincin) lalu ditulis ke disk berkala, supaya grafik
// tidak hilang saat panel di-restart.
const HISTORY_MAX = 2880; // 4 jam pada interval 5 detik
const history = [];
const HIST_FILE = path.join(STATE_DIR, 'history.json');

// Data 5 detik-an cuma masuk akal buat beberapa jam terakhir — nyimpen itu
// terus-terusan buat setahun berarti jutaan baris. Jadi tiap jam, sample-nya
// dirata-ratakan jadi SATU titik dan disimpan di sini secara terpisah, tahan
// lama (~2 tahun), buat filter grafik "hari/bulan/tahun".
const HOURLY_MAX = 24 * 730; // ~2 tahun
const hourlyHistory = [];
const HOURLY_FILE = path.join(STATE_DIR, 'history-hourly.json');
let hourBucket = null; // { hourStart, samples: [...] }

try {
  fsSync.mkdirSync(STATE_DIR, { recursive: true });
  if (fsSync.existsSync(HIST_FILE)) {
    const old = JSON.parse(fsSync.readFileSync(HIST_FILE, 'utf8'));
    if (Array.isArray(old)) history.push(...old.slice(-HISTORY_MAX));
  }
  if (fsSync.existsSync(HOURLY_FILE)) {
    const old = JSON.parse(fsSync.readFileSync(HOURLY_FILE, 'utf8'));
    if (Array.isArray(old)) hourlyHistory.push(...old.slice(-HOURLY_MAX));
  }
} catch {}

function rollupHour() {
  if (!hourBucket || !hourBucket.samples.length) return;
  const s = hourBucket.samples;
  const avg = (k) => +(s.reduce((a, p) => a + (p[k] ?? 0), 0) / s.length).toFixed(1);
  const temps = s.map(p => p.tp).filter(v => v != null);
  hourlyHistory.push({
    t: hourBucket.hourStart, c: avg('c'), m: avg('m'), d: avg('d'),
    tp: temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null,
    rx: Math.round(avg('rx')), tx: Math.round(avg('tx')),
  });
  if (hourlyHistory.length > HOURLY_MAX) hourlyHistory.splice(0, hourlyHistory.length - HOURLY_MAX);
}

let lastStats = null;
const ALERT_STATE = {};

async function collect() {
  try {
    const s = await sys.snapshot();
    lastStats = s;
    const point = {
      t: s.at,
      c: s.cpu.percent,
      m: s.memory.percent,
      d: s.disk.percent,
      tp: s.temperature,
      rx: Math.round(s.network.rxRate),
      tx: Math.round(s.network.txRate),
    };
    history.push(point);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);

    const hourStart = Math.floor(point.t / 3600000) * 3600000;
    if (!hourBucket || hourBucket.hourStart !== hourStart) {
      rollupHour();
      hourBucket = { hourStart, samples: [] };
    }
    hourBucket.samples.push(point);

    // Peringatan hanya saat kondisi BERUBAH, bukan tiap siklus —
    // supaya tidak membanjiri notifikasi lalu diabaikan.
    const check = (key, bad, title, msg) => {
      if (bad && !ALERT_STATE[key]) { ALERT_STATE[key] = true; notify(title, msg); }
      else if (!bad && ALERT_STATE[key]) { ALERT_STATE[key] = false; notify('Pulih', `${key} kembali normal.`); }
    };
    const gate = (key, bad, type, msg) => {
      if (bad && !ALERT_STATE[key]) { ALERT_STATE[key] = true; ev.emit(type, msg, { key }); }
      else if (!bad && ALERT_STATE[key]) { ALERT_STATE[key] = false;
        ev.emit('system.recovered', `${key} kembali normal.`, { key }); }
    };
    gate('disk', s.disk.percent >= THRESHOLDS.disk, 'system.disk_full', `Terpakai ${s.disk.percent}%, sisa ${(s.disk.free / 1073741824).toFixed(1)} GB.`);
    gate('memori', s.memory.percent >= THRESHOLDS.memory, 'system.ram_high', `Terpakai ${s.memory.percent}%.`);
    gate('suhu', s.temperature != null && s.temperature >= THRESHOLDS.temp, 'system.temp_high', `Suhu CPU ${s.temperature}°C. Periksa kipas dan thermal paste.`);
    gate('cpu', s.cpu.percent >= THRESHOLDS.cpu, 'system.cpu_high', `CPU ${s.cpu.percent}% selama beberapa siklus.`);
    gate('beban', (s.cpu.load?.[1] || 0) > (s.cpu.cores || 2) * 2, 'system.load_high', `Beban 5 menit ${s.cpu.load?.[1]}.`);
    gate('swap', s.memory.swapTotal > 0 && s.memory.swapUsed / s.memory.swapTotal > THRESHOLDS.swap / 100, 'system.swap_high', 'Swap terpakai lebih dari 60%.');
  } catch {}
}
setInterval(collect, 5000);
collect();
// Cek RAM tiap app hasil "Deploy otomatis" tiap 20 detik — nambah/kurangi
// replika kalau perlu (lihat autoscale.js buat alasannya). Log dialirkan ke
// console.log biasa, bukan SSE — ini jalan di belakang layar tanpa ada
// koneksi drawer yang lagi dibuka user.
setInterval(() => autoscale.tick((l) => console.log(l)).catch(() => {}), 20000);

// Sampling RAM/CPU tiap instance basis data tiap 60 detik — dipakai grafik
// di tab Overview (dbaas.recordSample/getHistory). Interval lebih jarang
// dari autoscale di atas karena ini cuma buat grafik, bukan aksi otomatis
// yang butuh reaksi cepat.
setInterval(async () => {
  let fleetMem = 0, fleetCpu = 0, fleetReq = 0, fleetConn = 0, gotReq = false, gotConn = false;
  for (const inst of dbaas.listInstances()) {
    try {
      const [s, req, conn] = await Promise.all([
        docker.statsOnce(inst.container),
        dbaas.requestCounterOf(inst.id).catch(() => null),
        dbaas.connectionCount(inst.id).catch(() => null),
      ]);
      const mem = memUsage(s).used, cpu = cpuPercent(s);
      dbaas.recordSample(inst.id, { mem, cpu, conn,
        req: req?.total ?? null, reqErr: req?.errors ?? null });
      fleetMem += mem; fleetCpu += cpu;
      if (req?.total != null) { fleetReq += req.total; gotReq = true; }
      if (conn != null) { fleetConn += conn; gotConn = true; }
    } catch {}
  }
  if (dbaas.listInstances().length) {
    dbaas.recordFleetSample({ mem: fleetMem, cpu: fleetCpu, conn: gotConn ? fleetConn : null,
      req: gotReq ? fleetReq : null });
  }
}, 60000);

// Sampling RAM/CPU/network tiap CONTAINER (bukan cuma basis data) tiap 60
// detik — dipakai grafik custom di halaman Containers, mekanisme sama
// persis kayak database (historyStore.js). rx/tx kumulatif sejak container
// nyala, jadi pemanggil yang ngitung selisih (sama kayak "requests").
const containerSeries = makeSeriesStore('container-history', ['rx', 'tx']);

// Deteksi anomali sederhana: bandingin sample TERBARU tiap container ke
// baseline (rata-rata + stddev) dari ~1 jam sample sebelumnya. Bukan machine
// learning apapun -- cuma "z-score" biasa, tapi cukup buat nangkep "RAM/CPU
// container ini mendadak jauh di luar kebiasaannya sendiri" tanpa perlu
// nyetel threshold tetap per container (threshold tetap gampang salah:
// container database yang emang berat CPU-nya bakal selalu "over limit").
const ANOMALY_COOLDOWN_MS = 30 * 60 * 1000;
const lastAnomalyAt = {}; // `${id}:${metric}` -> timestamp
function checkAnomaly(id, name, hist, metric, floorAbs) {
  if (hist.length < 12) return; // belum cukup data buat baseline yang masuk akal
  const vals = hist.slice(0, -1).map((p) => p[metric]).filter((v) => v != null);
  const cur = hist[hist.length - 1][metric];
  if (cur == null || vals.length < 10) return;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const stddev = Math.sqrt(variance);
  // stddev kecil (baseline stabil) bikin z-score gampang meledak walau
  // selisihnya absolut kecil -- makanya WAJIB juga lewatin floorAbs.
  if (cur < mean + Math.max(3 * stddev, floorAbs) || cur - mean < floorAbs) return;
  const key = `${id}:${metric}`;
  if (Date.now() - (lastAnomalyAt[key] || 0) < ANOMALY_COOLDOWN_MS) return;
  lastAnomalyAt[key] = Date.now();
  const label = metric === 'cpu' ? 'CPU' : 'RAM';
  const curFmt = metric === 'cpu' ? cur.toFixed(1) + '%' : (cur / 1e6).toFixed(0) + ' MB';
  const meanFmt = metric === 'cpu' ? mean.toFixed(1) + '%' : (mean / 1e6).toFixed(0) + ' MB';
  ev.emit('container.anomaly',
    `<b>${name}</b> ${label} melonjak ke ${curFmt} — jauh di atas kebiasaannya (rata-rata ~${meanFmt} sejam terakhir).`,
    { key });
}

setInterval(async () => {
  let list = [];
  try { list = await docker.listContainers(); } catch { return; }
  for (const c of list) {
    if (c.State !== 'running') continue;
    try {
      const s = await docker.statsOnce(c.Id);
      const { used } = memUsage(s);
      const { rx, tx } = netStats(s);
      containerSeries.record(c.Id, { mem: used, cpu: cpuPercent(s), rx, tx });
      const hist = containerSeries.get(c.Id);
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      checkAnomaly(c.Id, name, hist, 'cpu', 20);       // minimal +20 poin persentase CPU dari baseline
      checkAnomaly(c.Id, name, hist, 'mem', 200 * 1e6); // minimal +200MB RAM dari baseline
    } catch {}
  }
}, 60000);

setInterval(() => {
  fs.writeFile(HIST_FILE, JSON.stringify(history.slice(-HISTORY_MAX))).catch(() => {});
  fs.writeFile(HOURLY_FILE, JSON.stringify(hourlyHistory.slice(-HOURLY_MAX))).catch(() => {});
}, 60000);

// Bersihin build cache docker otomatis tiap minggu — layer "RUN npm ci"
// dkk numpuk tiap kali stack di-rebuild, gampang jadi puluhan GB di server
// yang sering deploy ulang, dan gak kelihatan sama sekali di halaman
// Image biasa (bukan image jadi, cuma layer perantara). Timestamp
// terakhir disimpan ke file (bukan cuma di memori) supaya restart panel
// nggak bikin nunggu 7 hari lagi dari nol tiap kali.
const BUILD_CACHE_PRUNE_FILE = path.join(STATE_DIR, 'last-buildcache-prune.txt');
const WEEK_MS = 7 * 24 * 3600 * 1000;
async function autoPruneBuildCache() {
  let last = 0;
  try { last = +(await fs.readFile(BUILD_CACHE_PRUNE_FILE, 'utf8')); } catch {}
  if (Date.now() - last < WEEK_MS) return;
  try {
    const r = await dockerExtra.pruneBuildCache();
    await fs.writeFile(BUILD_CACHE_PRUNE_FILE, String(Date.now()));
    const freed = r.SpaceReclaimed || 0;
    if (freed > 0) {
      ev.emit('container.buildcache_cleaned',
        `Build cache docker dibersihkan otomatis — ${(freed / 1e9).toFixed(2)} GB dibebaskan.`);
    }
  } catch {}
}
autoPruneBuildCache();
setInterval(autoPruneBuildCache, 24 * 3600 * 1000); // dicek tiap hari, jalan tiap 7 hari sekali

// Log container dibiarin numpuk selamanya bisa habisin disk pelan-pelan --
// potong otomatis tiap hari, cuma nyisain N hari terakhir (default 3).
async function autoCleanLogs() {
  try {
    const r = await logRetention.runCleanup(logRetention.retentionDays());
    if (r.bytesFreed > 0) {
      ev.emit('container.buildcache_cleaned',
        `Log container lebih dari ${r.days} hari dibersihkan otomatis — `
        + `${(r.bytesFreed / 1e6).toFixed(1)} MB dibebaskan dari ${r.filesTouched} container.`);
    }
  } catch {}
}
autoCleanLogs();
setInterval(autoCleanLogs, 24 * 3600 * 1000);

// Snapshot DR (seluruh /state panel) otomatis tiap hari -- disimpan di
// /data biar ikut numpang di jalur backup HDD+GDrive yang sudah ada
// (lihat drSnapshot.js). Cukup sekali sehari, sudah nyimpen 5 versi
// terakhir sendiri (drSnapshot.js), jadi status "terakhir jalan"
// dicek dulu biar restart panel gak nge-trigger snapshot baru tiap kali.
async function autoDrSnapshot() {
  try {
    const snaps = await drSnapshot.listSnapshots();
    const last = snaps[0]?.t || 0;
    if (Date.now() - last < 20 * 3600 * 1000) return; // sudah ada yg <20 jam, skip
    await drSnapshot.createSnapshot();
  } catch {}
}
autoDrSnapshot();
setInterval(autoDrSnapshot, 6 * 3600 * 1000); // dicek tiap 6 jam, jalan ~1x/hari

// Tes restore bulanan -- backup basis data ada, tapi "ada file dump" beda
// jauh sama "dump-nya beneran bisa di-restore dan datanya utuh". Tiap
// instance basis data lokal di-clone SUNGGUHAN ke instance sekali-pakai
// (pakai dbaas.cloneInstance yang sudah ada: dump -> instance baru kosong
// -> restore), jumlah baris tiap tabel dibandingin SUMBER vs HASIL RESTORE,
// instance sekali-pakainya langsung dihapus lagi sesudahnya.
const RESTORE_TEST_FILE = path.join(STATE_DIR, 'restore-test-status.json');
const MONTH_MS = 30 * 24 * 3600 * 1000;
async function runRestoreTest(manual = false) {
  const results = [];
  // Snapshot SEKARANG, bukan iterasi langsung atas dbaas.listInstances() --
  // itu balikin referensi array LIVE yang dipakai internal dbaas.js.
  // cloneInstance() di bawah nge-push instance sementara ke array itu
  // (mutasi in-place), lalu destroy() di finally REASSIGN array-nya (bukan
  // mutasi) -- akibatnya for-loop yang megang referensi array LAMA tetap
  // "lihat" entry clone yang baru aja dihapus, terus getInstance() buat
  // clone itu gagal ("Instance not found"). Snapshot .slice() di awal
  // motong ketergantungan itu sepenuhnya.
  const targets = dbaas.listInstances().filter((i) => !i.name.startsWith('restoretest-')).slice();
  for (const inst of targets) {
    const kind = dbaas.credentials(inst.id).kind;
    if (!LIST_TABLES[kind]) continue; // engine tanpa information_schema (mis. redis) dilewati
    let clone = null;
    try {
      clone = await dbaas.cloneInstance(inst.id, `restoretest-${Date.now().toString(36)}`);
      const srcCfg = dbaas.credentials(inst.id);
      const dstCfg = dbaas.credentials(clone.id);
      const srcTables = (await dbQuery(srcCfg, LIST_TABLES[kind])).rows;
      const mismatches = [];
      for (const t of srcTables) {
        const tbl = qualify({ kind, schema: t.schema, table: t.name });
        const [a, b] = await Promise.all([
          dbQuery(srcCfg, `SELECT COUNT(*) AS n FROM ${tbl}`),
          dbQuery(dstCfg, `SELECT COUNT(*) AS n FROM ${tbl}`),
        ]);
        const na = +a.rows[0].n, nb = +b.rows[0].n;
        if (na !== nb) mismatches.push(`${t.schema}.${t.name}: sumber ${na} baris, hasil restore ${nb} baris`);
      }
      results.push({ instance: inst.name, ok: mismatches.length === 0, tables: srcTables.length, mismatches });
    } catch (e) {
      results.push({ instance: inst.name, ok: false, error: e.message });
    } finally {
      if (clone) {
        try {
          const pkey = JSON.stringify(dbaas.credentials(clone.id));
          const p2 = pools.get(pkey);
          if (p2) { pools.delete(pkey); p2.end?.().catch?.(() => {}); }
        } catch {}
        await dbaas.destroy(clone.id, false).catch(() => {});
      }
    }
  }
  const status = { t: Date.now(), manual, results };
  await fs.writeFile(RESTORE_TEST_FILE, JSON.stringify(status, null, 2)).catch(() => {});
  if (results.length) {
    const failed = results.filter((r) => !r.ok);
    ev.emit(failed.length ? 'db.backup_failed' : 'db.restored',
      failed.length
        ? `Tes restore bulanan GAGAL untuk ${failed.length}/${results.length} basis data: ${failed.map((f) => f.instance).join(', ')}. Cek halaman Databases.`
        : `Tes restore bulanan: ${results.length} basis data semua berhasil di-restore ke instance sementara & datanya utuh (jumlah baris cocok persis).`);
  }
  return status;
}
async function autoRestoreTest() {
  let last = 0;
  try { last = JSON.parse(await fs.readFile(RESTORE_TEST_FILE, 'utf8')).t || 0; } catch {}
  if (Date.now() - last < MONTH_MS) return;
  await runRestoreTest(false).catch(() => {});
}
setInterval(autoRestoreTest, 24 * 3600 * 1000); // dicek tiap hari, jalan ~1x/bulan
// (Tidak dipanggil langsung saat startup, beda dari job lain -- clone
// basis data itu operasi berat/lambat, jangan sampai nunggu di jalur boot.)

// Preview environment (lihat action 'preview' di rute stacks) numpuk kalau
// dibiarkan -- tiap branch/PR baru bikin stack+container baru yang makan
// RAM/disk. Otomatis dibuang 7 hari sejak terakhir dibuat/deploy ulang.
const PREVIEW_TTL_MS = 7 * 24 * 3600 * 1000;
async function autoCleanPreviews() {
  let list = [];
  try { list = await stacks.listStacks(); } catch { return; }
  for (const s of list) {
    if (!s.isPreview) continue;
    const age = Date.now() - (s.updated || 0);
    if (age < PREVIEW_TTL_MS) continue;
    try {
      await stacks.removeStack(s.name);
      ev.emit('deploy.preview_cleaned',
        `Preview <code>${s.name}</code> dihapus otomatis (sudah lebih dari 7 hari tidak dipakai).`, { key: s.name });
      auth.audit('system', 'preview-auto-cleanup', s.name);
    } catch {}
  }
}
setInterval(autoCleanPreviews, 24 * 3600 * 1000);

// Backup harian (HDD + Google Drive) gagal SEKALI itu bisa cuma internet
// putus semalam — tapi gagal 3x BERTURUT-TURUT itu tanda ada yang beneran
// rusak (drive lepas, kredensial kadaluarsa, dst) dan layak jadi urgent
// khusus, bukan cuma numpuk di antara notifikasi run harian biasa yang
// gampang kelewat. Baca log yang sama yang dipakai overview backup di
// Vault & Backups (ditulis /usr/local/bin/server-backup).
const BACKUP_ALERT_FILE = path.join(STATE_DIR, 'last-backup-failure-alert.txt');
async function checkRepeatedBackupFailure() {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, 'backup-history.json'), 'utf8');
    const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const last3 = lines.slice(-3);
    if (last3.length !== 3 || !last3.every((l) => l.ok === false)) return;
    // Jangan alert ulang tiap 6 jam SELAMA streak-nya masih sama persis —
    // cuma alert lagi kalau ada kegagalan BARU yang nambah (mis. run
    // ke-4 juga gagal), bukan tiap kali dicek selama belum ada run baru
    // sama sekali.
    const newestFailT = String(last3[2].t);
    let already = '';
    try { already = await fs.readFile(BACKUP_ALERT_FILE, 'utf8'); } catch {}
    if (already.trim() === newestFailT) return;
    ev.emit('backup.repeated_failure',
      'Backup gagal 3 kali berturut-turut — cek drive HDD ter-mount atau kredensial Google Drive.',
      { key: 'repeated' });
    await fs.writeFile(BACKUP_ALERT_FILE, newestFailT);
  } catch {}
}
setInterval(checkRepeatedBackupFailure, 6 * 3600 * 1000);
checkRepeatedBackupFailure();

// ── Pemantauan layanan ──────────────────────────────────────────────────────
const CHECKS_FILE = path.join(STATE_DIR, 'checks.json');
let checks = [];
try { checks = JSON.parse(fsSync.readFileSync(CHECKS_FILE, 'utf8')); } catch {}
const saveChecks = () => fs.writeFile(CHECKS_FILE, JSON.stringify(checks, null, 2)).catch(() => {});

async function probe(c) {
  const t0 = Date.now();
  try {
    if (c.type === 'tcp') {
      await new Promise((resolve, reject) => {
        const s = net.connect({ host: c.host, port: +c.port });
        s.setTimeout(5000);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
        s.on('error', reject);
      });
    } else if (c.type === 'exec') {
      // Health check kustom: jalanin command DI DALAM container (docker exec),
      // beda dari cek "running/tidak" bawaan Docker -- container bisa
      // "running" tapi aplikasinya di dalam macet total, exec ini nangkep itu.
      const r = await dockerExtra.execRun(c.container, ['sh', '-c', c.cmd], 10000);
      if (r.code !== 0) throw new Error(`exit ${r.code}${r.output ? ': ' + r.output.slice(0, 150) : ''}`);
    } else {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      if (r.status >= 500) throw new Error('HTTP ' + r.status);
    }
    return { up: true, ms: Date.now() - t0 };
  } catch (e) {
    return { up: false, ms: Date.now() - t0, err: String(e.message || e) };
  }
}

function uptimeWindow(hist, ms) {
  const since = Date.now() - ms;
  const h = (hist || []).filter(x => x.t >= since);
  if (!h.length) return null;
  const up = h.filter(x => x.up).length;
  return { pct: +(up / h.length * 100).toFixed(2), checks: h.length,
    avgMs: Math.round(h.reduce((a, b) => a + b.ms, 0) / h.length),
    maxMs: Math.max(...h.map(x => x.ms)),
    incidents: h.reduce((n, x, i) => n + (!x.up && (i === 0 || h[i - 1].up) ? 1 : 0), 0) };
}

// Tebakan penyebab dari pesan error mentah, buat notifikasi yang langsung
// kasih arah "harus ngapain" — bukan cuma bilang "down" doang.
function diagnoseCheckError(err) {
  const e = String(err || '').toLowerCase();
  if (e.includes('enotfound') || e.includes('getaddrinfo'))
    return 'DNS gagal — domain/hostname-nya tidak bisa ditemukan. Cek nama domain sudah benar dan DNS-nya aktif.';
  if (e.includes('econnrefused'))
    return 'Koneksi ditolak — kemungkinan service/container-nya mati atau port-nya salah. Cek statusnya di menu Containers.';
  if (e.includes('timeout'))
    return 'Tidak ada balasan sampai waktu habis — service mungkin macet, overload, atau ada firewall yang memblokir.';
  if (e.includes('econnreset'))
    return 'Koneksi terputus di tengah jalan — service kemungkinan crash saat sedang merespons. Cek log container-nya.';
  if (/^http 5\d\d/.test(e))
    return 'Server merespons tapi error di sisi aplikasi (' + err + '). Cek log container-nya.';
  if (e.includes('cert') || e.includes('ssl') || e.includes('tls'))
    return 'Masalah sertifikat HTTPS — mungkin kedaluwarsa atau salah domain.';
  return 'Cek log container/service terkait buat lihat penyebab persisnya.';
}
const fmtOutage = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'kurang dari 1 menit';
  if (m < 60) return `${m} menit`;
  return `${(m / 60).toFixed(1)} jam`;
};

async function runChecks() {
  for (const c of checks) {
    const r = await probe(c);
    c.last = r; c.at = Date.now();
    // Riwayat 7 hari pada interval 1 menit = 10080 titik.
    c.hist = (c.hist || []).concat([{ t: c.at, up: r.up, ms: r.ms }]).slice(-10080);
    if (!r.up) { c.downSince = c.downSince || c.at; }
    else if (c.downSince) { c.lastOutage = { from: c.downSince, to: c.at }; c.downSince = null; }
    const wasUp = c.up !== false;
    if (r.up !== wasUp) {
      const target = c.type === 'tcp' ? `${c.host}:${c.port}`
        : c.type === 'exec' ? `${c.container}: ${c.cmd}` : c.url;
      const msg = r.up
        ? `<b>${c.name}</b> sudah normal lagi.\n`
          + `Target: <code>${target}</code>\n`
          + `Sempat down: ${fmtOutage(c.at - (c.downSince || c.at))}\n`
          + `Waktu respons sekarang: ${r.ms} ms`
        : `<b>${c.name}</b> tidak merespons.\n`
          + `Target: <code>${target}</code>\n`
          + `Error: <code>${esc(r.err || 'tidak diketahui')}</code>\n\n`
          + `Diagnosis: ${diagnoseCheckError(r.err)}`;
      ev.emit(r.up ? 'uptime.up' : 'uptime.down', msg, { key: c.name });
    }
    if (r.up && r.ms > THRESHOLDS.slowMs) {
      ev.emit('uptime.slow', `<code>${c.name}</code> merespons dalam ${r.ms} ms.`, { key: c.name });
    }
    c.up = r.up;
  }
  saveChecks();
}

// Pantau container: berhenti mendadak dan restart berulang.
const contState = {};
async function watchContainers() {
  try {
    const list = await docker.listContainers();
    for (const c of list) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const prev = contState[name];
      if (prev && prev.state === 'running' && c.State === 'exited') {
        ev.emit('container.crash', `<code>${name}</code> berhenti: ${c.Status}`, { key: name });
      }
      if (c.State === 'restarting') {
        contState[name] = { ...(prev || {}), restarts: (prev?.restarts || 0) + 1 };
        if (contState[name].restarts >= 3) {
          ev.emit('container.restart_loop', `<code>${name}</code> restart berulang kali.`, { key: name });
          contState[name].restarts = 0;
        }
      }
      contState[name] = { ...(contState[name] || {}), state: c.State };
    }
  } catch {}
}
setInterval(watchContainers, 20000);

// Pantau koneksi internet.
let netUp = true;
setInterval(async () => {
  let up = true;
  try { await fetch('https://1.1.1.1', { signal: AbortSignal.timeout(8000) }); }
  catch { up = false; }
  if (up !== netUp) {
    netUp = up;
    ev.emit(up ? 'system.internet_up' : 'system.internet_down',
      up ? 'Koneksi internet kembali normal.' : 'Server tidak bisa menjangkau internet.');
  }
}, 120000);

setInterval(runChecks, 60000);
setTimeout(runChecks, 4000);

// ── Berkas ──────────────────────────────────────────────────────────────────
// Semua path dibatasi di dalam DATA_ROOT. Ini penjaga utama terhadap
// percobaan keluar folder lewat "../".
const ROOTS = {
  data: DATA_ROOT,
  stacks: process.env.STACKS_DIR || '/stacks',
  // Seluruh filesystem laptop, lewat bind mount di docker-compose.yml.
  // Bukan privilege baru — Terminal (host) sudah kasih akses penuh yang sama,
  // ini cuma jalur GUI ke akses yang sudah ada.
  host: '/host/root',
};
function safePath(rel, root = 'data') {
  const base = ROOTS[root] || DATA_ROOT;
  const p = path.resolve(base, '.' + path.posix.normalize('/' + (rel || '')));
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new Error('Path outside the allowed folder');
  }
  return p;
}

// Panel jalan sebagai root (butuh buat Docker socket, nsenter, dll), jadi
// file/folder baru lewat Files/Code Editor selalu jadi milik root secara
// default — bikin repot diedit lagi lewat desktop biasa tanpa sudo. Samakan
// kepemilikannya dengan folder induk, kayak kalau user biasa yang bikin.
async function chownLikeParent(target) {
  try {
    const pst = await fs.stat(path.dirname(target));
    await fs.chown(target, pst.uid, pst.gid);
  } catch {}
}

// Berkas yang tidak pernah ditampilkan di editor: berat, biner, atau
// hanya membuat pohon berkas penuh sampah.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next',
  'vendor', '__pycache__', '.cache', 'target', 'bin', 'obj']);
const TEXTY = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|conf|cfg|env|sh|bash|zsh|fish|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html|htm|xml|svg|sql|py|rb|go|rs|java|kt|php|c|h|cpp|hpp|cs|swift|lua|pl|r|dockerfile|gitignore|editorconfig|properties|gradle|makefile|log|csv)$/i;
const isTexty = (f) => TEXTY.test(f) ||
  /^(dockerfile|makefile|caddyfile|procfile|readme|license|\.env.*|\.gitignore)$/i
    .test(path.basename(f));

const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon',
  '.bmp':'image/bmp','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif',
  '.txt':'text/plain','.md':'text/plain','.log':'text/plain','.yml':'text/plain',
  '.yaml':'text/plain','.pdf':'application/pdf',
  '.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.ogv':'video/ogg',
  '.mov':'video/quicktime','.mkv':'video/x-matroska',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4',
  '.flac':'audio/flac','.aac':'audio/aac' };
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

// Thumbnail Files: ImageMagick (+ imagemagick-heic/-jpeg di Dockerfile) bisa
// decode HEIC/HEIF (foto default iPhone) yang TIDAK bisa dibuka browser
// mana pun di Linux (Chrome/Firefox tidak punya codec-nya sama sekali,
// beda dari Safari/iOS) — jadi ini satu-satunya cara nampilin isi foto
// aslinya, bukan cuma ikon generik atau kotak putih kosong.
const execFileP = promisify(execFile);
const THUMB_IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif)$/i;
// ffmpeg ambil satu frame video jadi thumbnail — sebelumnya video (231 dari
// 448 file di folder testing) sama sekali tidak kena regex thumbnail lama,
// jadi selalu ikon generik walau file gambarnya (heic) sendiri sudah beres.
const THUMB_VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const THUMB_CACHE = path.join(STATE_DIR, 'thumb-cache');

// Buka folder isi ratusan foto HEIC dulu bikin CPU 100% (load average
// sampai belasan di laptop 4 thread ini) — browser nembak banyak thumbnail
// sekaligus dan tiap satu decode HEIC (libheif) itu berat. Antrean ini
// membatasi cuma N magick yang jalan BERSAMAAN (sisanya nunggu giliran,
// bukan dibuang), dan tiap proses dijalankan low-priority (nice + ionice
// idle, sama seperti server-backup) biar panel & container lain tidak
// ikut lemot walau lagi ada banyak thumbnail yang diproses.
const THUMB_MAX_CONCURRENT = Math.max(1, Math.min(2, os.cpus().length - 1));
// -limit thread di ImageMagick ternyata TIDAK cukup: decoder HEIC (libheif
// -> libde265/HEVC) punya thread pool sendiri di luar kendali ImageMagick,
// jadi satu proses magick masih kepantau makan 140-250% CPU walau limit
// itu sudah dipasang. taskset -c mengunci proses (dan SEMUA thread di
// dalamnya, dari library mana pun) cuma boleh jalan di satu core fisik ini
// — ini yang benar-benar membatasi, bukan cuma menyarankan.
const THUMB_CPU = String(Math.max(0, os.cpus().length - 1));
let thumbRunning = 0;
const thumbQueue = [];
function thumbSlot() {
  return new Promise((resolve) => {
    const take = () => { thumbRunning++; resolve(() => {
      thumbRunning--;
      const next = thumbQueue.shift();
      if (next) next();
    }); };
    if (thumbRunning < THUMB_MAX_CONCURRENT) take(); else thumbQueue.push(take);
  });
}

// ── Basis data ──────────────────────────────────────────────────────────────
const pools = new Map();
async function dbQuery(cfg, sql, params = []) {
  const key = JSON.stringify(cfg);
  if (cfg.kind === 'postgres') {
    const { default: pg } = await import('pg');
    let pool = pools.get(key);
    if (!pool) {
      pool = new pg.Pool({ host: cfg.host, port: +cfg.port || 5432, user: cfg.user,
        password: cfg.password, database: cfg.database, max: 3,
        connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
      // WAJIB ada listener 'error' -- pg Pool nembak event 'error' di background
      // (mis. koneksi idle putus karena container-nya kehapus/restart) yang
      // TIDAK terkait langsung ke query manapun yang lagi jalan. Tanpa listener
      // ini, Node menganggapnya "unhandled 'error' event" dan CRASH SELURUH
      // PROSES PANEL -- kebukti nyata pas nge-tes restore-test (clone instance
      // dihapus tapi pool-nya masih coba reconnect di background, panel down).
      pool.on('error', () => {});
      pools.set(key, pool);
    }
    const r = await pool.query(sql, params);
    // Beberapa perintah sekaligus (dipisah titik koma) menghasilkan array.
    if (Array.isArray(r)) {
      const sets = r.map((x, idx) => ({ index: idx + 1, command: x.command,
        rows: x.rows || [], fields: (x.fields || []).map((f) => f.name),
        count: x.rowCount }));
      const withRows = sets.filter((x) => x.rows.length);
      const main = withRows[withRows.length - 1] || sets[sets.length - 1] || {};
      return { rows: main.rows || [], fields: main.fields || [],
        count: main.count, sets, multi: true };
    }
    return { rows: r.rows, fields: (r.fields || []).map((f) => f.name), count: r.rowCount };
  }
  const mysql = await import('mysql2/promise');
  let pool = pools.get(key);
  if (!pool) {
    pool = mysql.createPool({ host: cfg.host, port: +cfg.port || 3306, user: cfg.user,
      password: cfg.password, database: cfg.database, connectionLimit: 3,
      connectTimeout: 8000, multipleStatements: true });
    pool.on('error', () => {}); // sama alasannya kayak pool Postgres di atas
    pools.set(key, pool);
  }
  const [rows, fields] = await pool.query(sql, params);
  // MySQL: banyak perintah menghasilkan array berisi array.
  if (Array.isArray(rows) && rows.length && Array.isArray(rows[0])) {
    const sets = rows.map((r2, idx) => ({ index: idx + 1, rows: r2,
      fields: (fields?.[idx] || []).map((f) => f.name), count: r2.length }));
    const withRows = sets.filter((x) => x.rows.length);
    const main = withRows[withRows.length - 1] || sets[sets.length - 1] || {};
    return { rows: main.rows || [], fields: main.fields || [],
      count: main.count, sets, multi: true };
  }
  return { rows: Array.isArray(rows) ? rows : [rows],
    fields: (fields || []).map((f) => f.name), count: Array.isArray(rows) ? rows.length : 0 };
}

// Dipanggil di background pas basis data Postgres baru dibuat — biar user
// langsung dapet REST API tanpa perlu klik "Buat REST API" manual (persis
// alur Supabase: bikin project, langsung dapet URL + key). Jalan async,
// TIDAK di-await di endpoint create supaya response-nya tetap cepat; kalau
// gagal (mis. Postgres belum sempat siap), tombol manual di drawer Koneksi
// masih bisa dipakai sebagai fallback.
async function autoDeployRestApi(inst) {
  try {
    const cfg = dbaas.credentials(inst.id);
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try { await dbQuery(cfg, 'SELECT 1'); ready = true; break; }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!ready) return;
    const rec = await dbapi.deploy(inst.id, dbQuery);
    const site = tunnel.addSite({ label: 'api', project: inst.name,
      target: rec.container, port: rec.port, proto: 'http' });
    const dns = await tunnel.routeDns(site.hostname);
    const apply = await tunnel.applyConfig();
    if (dns.ok && apply.ok) {
      ev.emit('domain.added',
        `REST API <code>${site.hostname}</code> otomatis dibuat untuk basis data <code>${inst.name}</code>.`);
    }
  } catch {}
}

const idq = (kind) => (s2) => {
  const c = String(s2).replace(/[^A-Za-z0-9_]/g, '');
  if (!c) throw new Error('Invalid column or table name');
  return kind === 'postgres' ? `"${c}"` : `\`${c}\``;
};
const qualify = (b) => `${idq(b.kind)(b.schema)}.${idq(b.kind)(b.table)}`;

// Ambang peringatan bisa diubah pengguna lewat Pengaturan.
const THRESHOLDS = { disk: 85, memory: 90, cpu: 92, temp: 80, swap: 60, slowMs: 3000 };
try { Object.assign(THRESHOLDS,
  JSON.parse(fsSync.readFileSync(path.join(STATE_DIR, 'thresholds.json'), 'utf8'))); } catch {}

// Link publik per-container (mis. domain lewat Cloudflare Tunnel) — diisi
// manual karena panel tidak tahu rute macam ini secara otomatis (beda dari
// domain Caddy yang tercatat di sites.json).
let CONTAINER_LINKS = {};
try { CONTAINER_LINKS = JSON.parse(
  fsSync.readFileSync(path.join(STATE_DIR, 'container-links.json'), 'utf8')); } catch {}
const saveContainerLinks = () => fs.writeFile(path.join(STATE_DIR, 'container-links.json'),
  JSON.stringify(CONTAINER_LINKS)).catch(() => {});

const LIST_TABLES = {
  postgres: `SELECT table_schema AS schema, table_name AS name
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog','information_schema')
             ORDER BY 1,2`,
  mysql: `SELECT table_schema AS \`schema\`, table_name AS name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema')
          ORDER BY 1,2`,
};

// ── Autentikasi permintaan ─────────────────────────────────────────────────
const cookieOf = (req, name) => {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
/* Alamat asli koneksi. X-Forwarded-For hanya dipercaya bila panel memang
   berada di belakang proxy dan TRUST_PROXY diaktifkan — kalau tidak, siapa
   pun bisa mengganti header itu tiap permintaan dan pembatasan percobaan
   masuk menjadi tidak berguna. Hasilnya juga dibersihkan agar tidak bisa
   menyisipkan markup ke catatan kejadian. */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const cleanIp = (s2) => String(s2 || '').replace(/[^0-9a-fA-F:.\[\]]/g, '').slice(0, 45);
const ipOf = (req) => {
  const direct = cleanIp(req.socket.remoteAddress) || '?';
  // CF-Connecting-IP (IP asli pengunjung dari Cloudflare) cuma dipercaya
  // kalau request-nya beneran nyampe lewat "tunnelServer" (port khusus
  // cloudflared, lihat definisi di dekat http.createServer) — port itu
  // publish-nya cuma ke 127.0.0.1 di level Docker, jadi mustahil dijangkau
  // perangkat lain di LAN walau tahu nomor portnya. Tanpa syarat ini,
  // perangkat lain yang sama-sama bisa akses port panel biasa (8090) bisa
  // nitip CF-Connecting-IP palsu sendiri buat mengelabui pencatatan IP
  // (mis. "sign-in dari device baru" jadi salah lapor).
  const cf = req.socket.localPort === TUNNEL_PORT ? cleanIp(req.headers['cf-connecting-ip']) : '';
  if (cf) return cf;
  if (!TRUST_PROXY) return direct;
  const fwd = cleanIp((req.headers['x-forwarded-for'] || '').split(',')[0]);
  return fwd || direct;
};

// Rute yang boleh diakses tanpa sesi.
const OPEN = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/setup', '/api/status/public']);

function sessionOf(req) {
  const t = cookieOf(req, 'sid');
  if (t) return auth.getSession(t);
  // Fallback: token API (Authorization: Bearer hsp_...) buat script/CI
  // eksternal yang gak punya cookie sesi browser sama sekali. Dapet
  // permission YANG SAMA kayak user pembuatnya (role-nya, bukan sesi
  // terpisah) -- token cuma "cara masuk" alternatif, bukan identitas baru.
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ')) {
    const rec = apiTokens.verify(authz.slice(7).trim());
    if (!rec) return null;
    const u = auth.findUser(rec.username);
    if (!u) return null;
    return { uid: u.id, username: u.username, role: u.role, viaToken: true };
  }
  return null;
}

// ── Router ──────────────────────────────────────────────────────────────────
const requestHandler = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;

  try {
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      const ses = sessionOf(req);
      let m;

      // ---- Autentikasi ----
      if (p === '/api/auth/state') {
        return ok(res, { setup: auth.userCount() === 0,
          user: ses ? { username: ses.username, role: ses.role,
            perms: auth.permsOf(ses.username) } : null,
          pages: auth.PAGES, roles: auth.ROLES, roleHelp: auth.ROLE_HELP,
          canWrite: auth.canWrite(ses) });
      }
      if (p === '/api/auth/setup' && req.method === 'POST') {
        if (auth.userCount() > 0) return fail(res, 'Already set up', 409);
        const b = await readJson(req);
        const u = auth.createUser({ username: b.username, password: b.password, role: 'superadmin' });
        auth.audit(u.username, 'setup', 'akun pertama dibuat');
        const tok = auth.newSession(auth.findUser(u.username), ipOf(req));
        res.setHeader('Set-Cookie',
          `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
        return ok(res, { user: u });
      }
      if (p === '/api/auth/login' && req.method === 'POST') {
        const ip = ipOf(req);
        const rate = auth.checkRate(ip);
        if (!rate.allowed) {
          return fail(res, `Too many attempts. Try again in ${rate.retryIn} seconds.`, 429);
        }
        const b = await readJson(req);
        const u = auth.findUser(b.username);
        if (!u || !auth.verifyPassword(b.password || '', u.pass)) {
          const left = auth.noteFail(ip);
          auth.audit(b.username || '?', 'login-gagal', ip);
          if (left === Math.ceil(15 * 60)) ev.emit('sec.ip_blocked', `IP <code>${ip}</code> diblokir 15 menit.`, { key: ip });
          else if (left <= 2) ev.emit('sec.bruteforce', `Percobaan masuk berulang dari <code>${ip}</code>, sisa ${left} kesempatan.`, { key: ip });
          return fail(res, 'Wrong username or password', 401);
        }
        if (u.totpSecret) {
          if (!b.code) return json(res, 200, { need2fa: true });
          if (!auth.totpVerify(u.totpSecret, b.code)) {
            auth.noteFail(ip);
            auth.audit(u.username, 'login-gagal-2fa', ip);
            return fail(res, 'Wrong 2FA code', 401);
          }
        }
        auth.noteOk(ip);
        const known = auth.listSessions().some(x => x.ip === ip);
        const tok = auth.newSession(u, ip);
        auth.audit(u.username, 'login', ip);
        ev.emit(known ? 'sec.login_ok' : 'sec.new_device',
          `<b>${u.username}</b> masuk dari <code>${ip}</code>.`, { key: ip });
        res.setHeader('Set-Cookie',
          `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
        return ok(res, { user: { username: u.username, role: u.role } });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const t = cookieOf(req, 'sid');
        if (t) auth.dropSession(t);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
        return ok(res);
      }

      // Semua rute lain wajib punya sesi.
      if (!OPEN.has(p) && !ses) return fail(res, 'Not signed in', 401);

      // Verifikasi ulang kata sandi akun yang sedang login — dipakai buat
      // "kunci" ringan di UI (mis. menampilkan container sistem yang
      // disembunyikan), bukan pengganti login penuh.
      if (p === '/api/auth/verify' && req.method === 'POST') {
        const ip = ipOf(req);
        const rate = auth.checkRate(ip);
        if (!rate.allowed) return fail(res, `Too many attempts. Try again in ${rate.retryIn} seconds.`, 429);
        const b = await readJson(req);
        const u = auth.findUser(ses.username);
        const good = !!u && auth.verifyPassword(b.password || '', u.pass);
        if (!good) { auth.noteFail(ip); return fail(res, 'Wrong password', 401); }
        auth.noteOk(ip);
        return ok(res);
      }

      // Token API — buat script/CI eksternal manggil API panel tanpa cookie
      // sesi browser. Tiap user kelola token-nya SENDIRI (bukan lintas
      // user), dan token itu punya permission YANG SAMA kayak user
      // pembuatnya (bukan sistem scope terpisah).
      if (p === '/api/tokens' && req.method === 'GET') {
        return ok(res, { tokens: apiTokens.list(ses.username) });
      }
      if (p === '/api/tokens' && req.method === 'POST') {
        const b = await readJson(req);
        const rec = apiTokens.create(ses.username, b.label);
        auth.audit(ses.username, 'token-buat', rec.label);
        return ok(res, rec); // satu-satunya kesempatan token mentahnya kekirim
      }
      if ((m = p.match(/^\/api\/tokens\/([^/]+)$/)) && req.method === 'DELETE') {
        const removed = apiTokens.revoke(ses.username, m[1]);
        if (!removed) return fail(res, 'Token not found', 404);
        auth.audit(ses.username, 'token-cabut', m[1]);
        return ok(res);
      }

      // Web Push — dipicu bareng event 'urgent' (lihat events.js setPushSender).
      if (p === '/api/push/vapid-key' && req.method === 'GET') {
        return ok(res, { key: webpush.publicKey() });
      }
      if (p === '/api/push/subscribe' && req.method === 'POST') {
        const b = await readJson(req);
        webpush.subscribe(ses.username, b.subscription);
        return ok(res);
      }
      if (p === '/api/push/unsubscribe' && req.method === 'POST') {
        const b = await readJson(req);
        webpush.unsubscribe(ses.username, b.endpoint);
        return ok(res);
      }
      if (p === '/api/push/subs' && req.method === 'GET') {
        return ok(res, { subs: webpush.listFor(ses.username) });
      }

      // Konfigurasi Telegram lewat web (buat wizard setup) -- token disimpan
      // di vault terenkripsi yang sudah ada, chat_id tidak dianggap rahasia
      // tapi disimpan di tempat sama biar konsisten.
      if (p === '/api/telegram/config' && req.method === 'GET') {
        return ok(res, { configured: !!(tgToken() && tgChat()), chat: tgChat() });
      }
      if (p === '/api/telegram/config' && req.method === 'POST') {
        const b = await readJson(req);
        if (b.token) admin.setSecret('TG_TOKEN', String(b.token).trim());
        if (b.chat) admin.setSecret('TG_CHAT', String(b.chat).trim());
        auth.audit(ses.username, 'telegram-config', 'diperbarui');
        return ok(res);
      }
      if (p === '/api/telegram/test' && req.method === 'POST') {
        if (!tgToken() || !tgChat()) return fail(res, 'Isi token & chat ID dulu', 400);
        await notify('Tes notifikasi', 'Kalau pesan ini sampai, Telegram sudah tersambung dengan benar.');
        return ok(res);
      }

      // Konfigurasi email (SMTP) -- alternatif/pelengkap Telegram buat
      // kejadian 'urgent'. Password SMTP tidak pernah dikirim balik ke
      // browser (cuma ditulis, gak dibaca), sama seperti pola secret lain.
      if (p === '/api/email/config' && req.method === 'GET') {
        return ok(res, { configured: mailer.configured(), ...mailer.settings() });
      }
      if (p === '/api/email/config' && req.method === 'POST') {
        const b = await readJson(req);
        mailer.setConfig(b);
        auth.audit(ses.username, 'email-config', 'diperbarui');
        return ok(res);
      }
      if (p === '/api/email/test' && req.method === 'POST') {
        try { await mailer.sendTest(); return ok(res); }
        catch (e) { return fail(res, e.message, 400); }
      }

      // Wizard setup pertama kali -- status tiap langkah opsional, biar
      // wizard di web tahu langkah mana yang sudah/belum dikerjakan
      // pengguna template ini. Bukan syarat wajib, cuma penanda.
      if (p === '/api/setup/status' && req.method === 'GET') {
        let dismissed = false;
        try { dismissed = (await fs.readFile(path.join(STATE_DIR, 'wizard-dismissed.txt'), 'utf8')).trim() === '1'; } catch {}
        return ok(res, {
          telegram: !!(tgToken() && tgChat()),
          email: mailer.configured(),
          gdrive: gdrive.configured(),
          stacks: (await stacks.listStacks().catch(() => [])).length > 0,
          dismissed,
        });
      }
      if (p === '/api/setup/dismiss' && req.method === 'POST') {
        await fs.writeFile(path.join(STATE_DIR, 'wizard-dismissed.txt'), '1');
        return ok(res);
      }

      // Penjaga izin: tiap kelompok rute dipetakan ke satu halaman.
      // Anggota tim hanya bisa menyentuh yang diizinkan admin.
      const AREA = [
        // "processes" ketinggalan sebelumnya — /api/system/processes/:pid/kill
        // (matikan proses dari Task Manager di Overview) sempat bisa dipanggil
        // siapa saja yang login, terlepas dari izin halamannya.
        [/^\/api\/(system\/stats|system\/history|system\/info|system\/processes)/, ['overview']],
        [/^\/api\/events/, ['events']],
        [/^\/api\/monitor/, ['monitor']],
        [/^\/api\/ai\//, ['assistant']],
        [/^\/api\/stacks/, ['stacks']],
        // Aksi yang benar-benar mengubah container (nyala/mati/hapus/link)
        // cuma buat yang punya izin "Containers" — TAPI daftar & log
        // container-nya sendiri juga dipakai halaman Logs & Terminal buat
        // dropdown pilih container, jadi baris di bawahnya sengaja lebih
        // longgar (baca-baca saja, bukan kontrol).
        [/^\/api\/containers\/[^/]+\/(start|stop|restart|remove|link)$/, ['containers']],
        [/^\/api\/containers/, ['containers', 'logs', 'terminal', 'overview']],
        // Editor dan Files sama-sama sah membutuhkan baca/tulis berkas,
        // jadi rute ini menerima salah satu dari keduanya.
        [/^\/api\/files\/(workspaces|tree|search)/, ['editor']],
        [/^\/api\/files\/(read|write|create|mkdir|rename|delete|raw)/, ['editor', 'files']],
        [/^\/api\/files/, ['files']],
        [/^\/api\/db\//, ['database']],
        [/^\/api\/(sites|tunnel)/, ['domains']],
        [/^\/api\/jobs/, ['jobs']],
        [/^\/api\/(secrets|backups|gdrive|dr)/, ['vault']],
        [/^\/api\/(images|volumes|networks|prune|disk-analysis|logs\/retention)/, ['resources']],
        [/^\/api\/admin\//, ['system']],
        [/^\/api\/(thresholds|system\/power|system\/journal)/, ['system']],
      ];
      if (ses && !OPEN.has(p) && !p.startsWith('/api/auth/')) {
        const hit = AREA.find(([re]) => re.test(p));
        if (hit && !hit[1].some(pg => auth.canPage(ses, pg))) {
          return fail(res, 'You do not have access to this area', 403);
        }
      }
      // Viewer hanya boleh membaca. Semua metode yang mengubah keadaan ditolak
      // di server, bukan sekadar disembunyikan di antarmuka.
      const READ_POST = [
        /^\/api\/db\/instances\/[^/]+\/(tables|rows|columns|databases)$/,
        /^\/api\/db\/instances\/[^/]+\/export$/,
      ];
      const isQuery = /^\/api\/db\/instances\/[^/]+\/query$/.test(p);
      if (ses && !auth.canWrite(ses) && req.method !== 'GET'
          && !['/api/auth/logout', '/api/auth/state', '/api/auth/verify'].includes(p)) {
        let allow = req.method === 'POST' && READ_POST.some(re => re.test(p));
        // Viewer boleh menjalankan kueri, tetapi hanya yang membaca.
        // Penyaringnya sengaja ketat: satu kata kunci pengubah saja langsung ditolak.
        if (!allow && isQuery && req.method === 'POST') {
          const b0 = await readJson(req).catch(() => ({}));
          const sql = String(b0.sql || '');
          const readOnly = /^\s*(select|with|explain|show|table)\b/i.test(sql)
            && !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(sql);
          if (!readOnly) return fail(res, 'Your role may only run SELECT queries', 403);
          req._parsedBody = b0;
          allow = true;
        }
        if (!allow) return fail(res, 'Your role is read-only', 403);
      }
      // Beberapa rute memakai POST hanya untuk membaca; itu tetap diizinkan.
      // Hanya admin yang boleh mengelola pengguna & izin.
      if (p.startsWith('/api/auth/users') && ses?.role !== 'superadmin') {
        return fail(res, 'Only a Super Admin can manage users', 403);
      }


      if (p === '/api/system/stats') {
        return ok(res, lastStats || (await sys.snapshot()));
      }
      // Dashboard kuota resource keseluruhan — "kalau semua container
      // kepentok batasnya BARENGAN, cukup gak RAM/CPU laptop ini?" Beda
      // dari statistik pemakaian SEKARANG (yang sudah ada di Overview) --
      // ini soal ALOKASI (mem_limit/cpus tiap container dijumlah), yang
      // ga kelihatan dari statistik real-time biasa.
      if (p === '/api/resource-quota') {
        const [mem, cpuInfo, disk, containers] = await Promise.all([
          sys.memory(), sys.cpu(), sys.disk(), docker.listContainers(),
        ]);
        const running = containers.filter((c) => c.State === 'running');
        let allocMem = 0, allocCpu = 0, unlimitedMem = 0, unlimitedCpu = 0, usedMemNow = 0, usedCpuNow = 0;
        const perContainer = [];
        await Promise.all(running.map(async (c) => {
          const name = (c.Names?.[0] || '').replace(/^\//, '');
          try {
            const [insp, s] = await Promise.all([docker.inspect(c.Id), docker.statsOnce(c.Id)]);
            const memLimit = insp.HostConfig?.Memory || 0;
            const nanoCpus = insp.HostConfig?.NanoCpus || 0;
            if (memLimit > 0) allocMem += memLimit; else unlimitedMem++;
            if (nanoCpus > 0) allocCpu += nanoCpus / 1e9; else unlimitedCpu++;
            const used = memUsage(s).used, cpuPct = cpuPercent(s);
            usedMemNow += used; usedCpuNow += cpuPct;
            perContainer.push({ name, memLimit: memLimit || null, cpuLimit: nanoCpus ? nanoCpus / 1e9 : null,
              memUsed: used, cpuUsed: cpuPct });
          } catch {}
        }));
        return ok(res, {
          host: { memTotal: mem.total, cpuCores: cpuInfo.cores, diskTotal: disk.total, diskFree: disk.free },
          allocated: { mem: allocMem, cpu: allocCpu, unlimitedMemCount: unlimitedMem, unlimitedCpuCount: unlimitedCpu },
          usedNow: { mem: usedMemNow, cpu: usedCpuNow },
          containers: perContainer.sort((a, b) => (b.memLimit || 0) - (a.memLimit || 0)),
        });
      }

      // Global search (Cmd/Ctrl+K) — cari lintas stacks/containers/database/
      // halaman sekaligus. Tiap kategori difilter permission-nya sendiri
      // (canPage/canDb), bukan digerbang di level AREA di atas -- Viewer
      // yang gak punya izin "stacks" misalnya, ga bakal ketemu hasil stack
      // sama sekali, bukan cuma disembunyiin di UI doang.
      if (p === '/api/search') {
        const term = (q.get('q') || '').toLowerCase().trim();
        if (!term) return ok(res, { results: [] });
        const results = [];
        if (auth.canPage(ses, 'stacks')) {
          for (const s of await stacks.listStacks()) {
            if (s.name.toLowerCase().includes(term)) {
              results.push({ type: 'stack', label: s.name, sub: s.source, page: 'stacks' });
            }
          }
        }
        if (auth.canPage(ses, 'containers')) {
          for (const c of await docker.listContainers()) {
            const name = (c.Names?.[0] || '').replace(/^\//, '');
            if (name.toLowerCase().includes(term) || (c.Image || '').toLowerCase().includes(term)) {
              results.push({ type: 'container', label: name, sub: c.Image, page: 'containers' });
            }
          }
        }
        if (auth.canPage(ses, 'database')) {
          for (const inst of dbaas.listInstances().filter((x) => auth.canDb(ses, x.id))) {
            if (inst.name.toLowerCase().includes(term)) {
              results.push({ type: 'database', label: inst.name, sub: inst.engine, page: 'database' });
            }
          }
        }
        for (const [id, label] of Object.entries(auth.PAGES)) {
          if (auth.canPage(ses, id) && label.toLowerCase().includes(term)) {
            results.push({ type: 'page', label, sub: 'Halaman', page: id });
          }
        }
        return ok(res, { results: results.slice(0, 40) });
      }
      if (p === '/api/system/history') {
        const RANGE_MS = { '30m': 1.8e6, '1h': 3.6e6, '4h': 1.44e7, '1d': 8.64e7,
          '7d': 6.048e8, '30d': 2.592e9, '90d': 7.776e9, '1y': 3.1536e10 };
        const range = q.get('range');
        const from = +q.get('from') || null;
        const to = +q.get('to') || Date.now();
        if (range || from) {
          const spanMs = from ? (to - from) : RANGE_MS[range];
          if (!spanMs) return fail(res, 'Invalid range', 400);
          const since = from || (Date.now() - spanMs);
          // Data 5-detikan cuma ada buat beberapa jam terakhir; rentang lebih
          // panjang dari itu otomatis pakai ringkasan per-jam yang tahan lama.
          const src = spanMs <= 4 * 3600000 ? history : hourlyHistory;
          return ok(res, { points: src.filter(p2 => p2.t >= since && p2.t <= to), resolution: src === history ? '5s' : '1h' });
        }
        const n = Math.min(+q.get('n') || 360, HISTORY_MAX);
        return ok(res, { points: history.slice(-n), resolution: '5s' });
      }
      if (p === '/api/system/info') {
        const [info, ver] = await Promise.all([
          docker.info().catch(() => null), docker.version().catch(() => null)]);
        return ok(res, {
          docker: info ? { containers: info.Containers, running: info.ContainersRunning,
            images: info.Images, version: ver?.Version, os: info.OperatingSystem,
            kernel: info.KernelVersion, arch: info.Architecture,
            cpus: info.NCPU, mem: info.MemTotal } : null,
        });
      }
      // ---- Task Manager: proses host asli (pid:host), bukan proses container ----
      if (p === '/api/system/processes' && req.method === 'GET') {
        return ok(res, { processes: await sys.processes() });
      }
      if ((m = p.match(/^\/api\/system\/processes\/(\d+)\/kill$/)) && req.method === 'POST') {
        const b = await readJson(req).catch(() => ({}));
        await sys.killProcess(m[1], b.signal === 'KILL' ? 'KILL' : 'TERM');
        auth.audit(ses.username, 'proses-matikan', `pid ${m[1]} (${b.signal || 'TERM'})`);
        return ok(res);
      }


      // ---- Pengguna, 2FA, audit ----
      if (p === '/api/auth/users' && req.method === 'GET') return ok(res, { users: auth.listUsers() });
      if (p === '/api/auth/users' && req.method === 'POST') {
        const b = await readJson(req);
        const u = auth.createUser(b);
        auth.audit(ses.username, 'user-tambah', b.username);
        return ok(res, { user: u });
      }
      if ((m = p.match(/^\/api\/auth\/users\/([^/]+)$/))) {
        if (req.method === 'DELETE') {
          auth.deleteUser(m[1]); auth.audit(ses.username, 'user-hapus', m[1]); return ok(res);
        }
        if (req.method === 'PATCH') {
          const b = await readJson(req);
          auth.updateUser(m[1], b);
          auth.audit(ses.username, 'user-edit', `${m[1]} ${JSON.stringify(Object.keys(b))}`);
          if (b.role) ev.emit('sec.credential_changed',
            `Role changed for user <code>${m[1]}</code> to <b>${b.role}</b>.`);
          return ok(res);
        }
      }
      if (p === '/api/auth/2fa/init' && req.method === 'POST') {
        const secret = auth.totpSecret();
        return ok(res, { secret, uri: auth.totpUri(secret, ses.username) });
      }
      if (p === '/api/auth/2fa/enable' && req.method === 'POST') {
        const b = await readJson(req);
        if (!auth.totpVerify(b.secret, b.code)) return fail(res, 'Kode salah', 400);
        const u = auth.findUser(ses.username);
        auth.updateUser(u.id, { totpSecret: b.secret });
        auth.audit(ses.username, '2fa-aktif');
        ev.emit('sec.credential_changed', `2FA diaktifkan untuk <b>${ses.username}</b>.`);
        return ok(res);
      }
      if (p === '/api/auth/2fa/disable' && req.method === 'POST') {
        const u = auth.findUser(ses.username);
        auth.updateUser(u.id, { totpSecret: null });
        auth.audit(ses.username, '2fa-nonaktif');
        return ok(res);
      }
      if (p === '/api/auth/sessions') return ok(res, { sessions: auth.listSessions(), bans: auth.listBans() });
      if (p === '/api/auth/audit') return ok(res, { entries: auth.readAudit(+q.get('n') || 300) });





      // ---- Instance basis data (bikin sendiri dari web) ----
      if (p === '/api/db/engines') return ok(res, { engines:
        Object.entries(dbaas.ENGINES).map(([k, v]) => ({ id: k, label: v.label,
          versions: v.versions, port: v.port, note: v.note, kind: v.kind })) });

      if (p === '/api/db/fleet-history' && req.method === 'GET') {
        return ok(res, { history: dbaas.getFleetHistory({ range: q.get('range'),
          from: +q.get('from') || null, to: +q.get('to') || null }) });
      }
      // Overview GABUNGAN — semua instance sekaligus (beda dari
      // /api/db/instances/:id/overview yang cuma satu). Dipakai kartu
      // ringkasan di puncak halaman Databases.
      if (p === '/api/db/overview' && req.method === 'GET') {
        const all = (await dbaas.withStatus()).filter(x => auth.canDb(ses, x.id));
        const perEngine = {};
        for (const inst of all) perEngine[inst.engine] = (perEngine[inst.engine] || 0) + 1;
        let totalSize = 0, totalMem = 0, totalMemLimit = 0, totalConn = 0, totalReq = 0;
        let sizeKnown = 0, connKnown = 0;
        await Promise.all(all.map(async (inst) => {
          const [size, conn] = await Promise.all([
            dbaas.sizeOf(inst.id).catch(() => null),
            dbaas.connectionCount(inst.id).catch(() => null),
          ]);
          if (size != null) { totalSize += size; sizeKnown++; }
          if (conn != null) { totalConn += conn; connKnown++; }
          if (inst.state === 'running') {
            try {
              const s = await docker.statsOnce(inst.container);
              totalMem += memUsage(s).used; totalMemLimit += memUsage(s).limit || 0;
            } catch {}
          }
          const hist = dbaas.getHistory(inst.id).filter(p2 => p2.req != null);
          if (hist.length >= 2) totalReq += Math.max(0, hist[hist.length - 1].req - hist[0].req);
        }));
        return ok(res, {
          total: all.length, running: all.filter(x => x.state === 'running').length,
          perEngine, totalSize: sizeKnown ? totalSize : null,
          totalMem, totalMemLimit: totalMemLimit || null,
          totalConn: connKnown ? totalConn : null, totalReq,
        });
      }
      if (p === '/api/db/instances') {
        if (req.method === 'GET') {
          const all = await dbaas.withStatus();
          const ext = dbaas.listExternal();
          return ok(res, {
            instances: all.filter(x => auth.canDb(ses, x.id)),
            external: ext.filter(x => auth.canDb(ses, x.id)),
          });
        }
        if (req.method === 'POST') {
          const b = await readJson(req);
          const inst = await dbaas.create(b);
          auth.audit(ses.username, 'db-instance-buat', `${b.engine} ${b.name}`);
          ev.emit('db.backup_ok', `Basis data <code>${inst.name}</code> (${b.engine}) dibuat.`);
          if (b.engine === 'postgres') autoDeployRestApi(inst);
          return ok(res, inst);
        }
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)$/)) && req.method === 'DELETE') {
        await dbaas.destroy(m[1], q.get('keep') === '1');
        auth.audit(ses.username, 'db-instance-hapus', m[1]);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/(start|stop|restart)$/)) && req.method === 'POST') {
        await dbaas.action(m[1], m[2]);
        auth.audit(ses.username, 'db-instance-' + m[2], m[1]);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/connection$/))) {
        auth.audit(ses.username, 'db-lihat-kredensial', m[1]);
        return ok(res, dbaas.connectionInfo(m[1]));
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/logs$/))) {
        return ok(res, { log: await dbaas.logs(m[1], +q.get('n') || 200) });
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/history$/))) {
        return ok(res, { history: dbaas.getHistory(m[1], { range: q.get('range'),
          from: +q.get('from') || null, to: +q.get('to') || null }) });
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/overview$/))) {
        const inst = dbaas.getInstance(m[1]);
        const [size, connections, all] = await Promise.all([
          dbaas.sizeOf(m[1]).catch(() => null),
          dbaas.connectionCount(m[1]).catch(() => null),
          dbaas.withStatus().catch(() => []),
        ]);
        const status = all.find(x => x.id === m[1]) || {};
        let cpu = 0, mem = { used: 0, limit: 0 };
        try {
          const s = await docker.statsOnce(inst.container);
          cpu = cpuPercent(s); mem = memUsage(s);
        } catch {}
        // "Total Requests" beneran (transaksi Postgres, dst) — bukan
        // kumulatif sejak database nyala, tapi SELISIH dari jendela riwayat
        // yang ada (~3 jam terakhir), biar anginnya kebaca kalau lagi rame.
        const hist = dbaas.getHistory(m[1]).filter(p => p.req != null);
        let reqTotal = null, reqErrors = null, successRate = null;
        if (hist.length >= 2) {
          const first = hist[0], last = hist[hist.length - 1];
          reqTotal = Math.max(0, last.req - first.req);
          if (first.reqErr != null && last.reqErr != null) {
            reqErrors = Math.max(0, last.reqErr - first.reqErr);
            successRate = reqTotal > 0 ? Math.round(((reqTotal - reqErrors) / reqTotal) * 100) : 100;
          }
        }
        return ok(res, {
          engine: inst.engine, version: inst.version, created: inst.created,
          state: status.state, statusText: status.status, size,
          connections, memUsed: mem.used, memLimit: mem.limit || null,
          cpuPercent: cpu, queryStats: dbaas.queryStats(m[1]),
          reqTotal, reqErrors, successRate,
        });
      }
      // Clone: instance BARU berisi salinan schema+data instance ini --
      // buat staging sebelum ubah skema production, dst.
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/clone$/)) && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.name || !/^[a-z0-9-]{2,}$/.test(b.name)) {
          return fail(res, 'Nama instance baru: huruf kecil/angka/strip, minimal 2 karakter', 400);
        }
        try {
          const dest = await dbaas.cloneInstance(m[1], b.name);
          auth.audit(ses.username, 'db-clone', `${m[1]} -> ${dest.name}`);
          ev.emit('db.backup_ok', `Basis data <code>${dest.name}</code> dibuat sebagai clone dari instance lain.`);
          return ok(res, dest);
        } catch (e) { return fail(res, e.message, 400); }
      }
      if (p === '/api/db/restore-test/status' && req.method === 'GET') {
        let last = null;
        try { last = JSON.parse(await fs.readFile(RESTORE_TEST_FILE, 'utf8')); } catch {}
        return ok(res, { last });
      }
      if (p === '/api/db/restore-test/run' && req.method === 'POST') {
        const r = await runRestoreTest(true);
        auth.audit(ses.username, 'restore-test-manual', JSON.stringify(r.results.map((x) => x.instance)));
        return ok(res, r);
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/rotate$/)) && req.method === 'POST') {
        await dbaas.rotatePassword(m[1]);
        auth.audit(ses.username, 'db-ganti-sandi', m[1]);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/backup$/)) && req.method === 'POST') {
        const c = dbaas.credentials(m[1]);
        const r = await admin.doBackup(`db:${c.host}:${c.user}`);
        auth.audit(ses.username, 'db-cadangkan', m[1]);
        if (r.code !== 0) { ev.emit('db.backup_failed', r.out?.slice(0, 200) || '');
          return fail(res, r.out || 'Gagal'); }
        ev.emit('db.backup_ok', `Cadangan <code>${path.basename(r.file)}</code> dibuat.`);
        return ok(res, { file: path.basename(r.file) });
      }

      // ---- REST API otomatis di depan basis data (setara Supabase) ----
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/api$/))) {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access to this database', 403);
        const existing = dbapi.forInstance(m[1]);
        if (req.method === 'GET') {
          if (!existing) return ok(res, null);
          const site = tunnel.listSites().find(s => s.target === existing.container);
          return ok(res, { name: existing.name, port: existing.port,
            apiKey: existing.apiKey, hostname: site?.hostname || null });
        }
        if (req.method === 'POST') {
          if (existing) return fail(res, 'API sudah dibuat untuk basis data ini', 400);
          let rec;
          try { rec = await dbapi.deploy(m[1], dbQuery); }
          catch (e) { return fail(res, e.message, 400); }
          const inst = dbaas.getInstance(m[1]);
          let hostname = null, warning;
          try {
            const site = tunnel.addSite({ label: 'api', project: inst.name,
              target: rec.container, port: rec.port, proto: 'http' });
            const dns = await tunnel.routeDns(site.hostname);
            const apply = await tunnel.applyConfig();
            hostname = site.hostname;
            if (!dns.ok) warning = 'Gagal daftar DNS: ' + dns.message;
            else if (!apply.ok) warning = 'Gagal muat ulang cloudflared: ' + apply.message;
          } catch (e) { warning = e.message; }
          auth.audit(ses.username, 'db-api-buat', inst.name);
          ev.emit('domain.added', hostname
            ? `REST API <code>${hostname}</code> dibuat untuk basis data <code>${inst.name}</code>.`
            : `REST API dibuat untuk <code>${inst.name}</code> (subdomain gagal: ${warning || ''}).`);
          return ok(res, { name: rec.name, port: rec.port, apiKey: rec.apiKey, hostname, warning });
        }
        if (req.method === 'DELETE') {
          if (existing) {
            const site = tunnel.listSites().find(s => s.target === existing.container);
            if (site) { tunnel.removeSite(site.id); await tunnel.applyConfig(); }
          }
          await dbapi.remove(m[1], dbQuery);
          auth.audit(ses.username, 'db-api-hapus', m[1]);
          return ok(res);
        }
      }

      // Jalankan kueri memakai kredensial instance (frontend tidak pegang sandi).
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/(tables|query|rows|columns|databases|ddl)$/))
          && req.method === 'POST') {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access to this database', 403);
        const c = dbaas.anyCredentials(m[1]);
        if (c.kind !== 'postgres' && c.kind !== 'mysql') {
          return fail(res, 'Table browser supports PostgreSQL and MySQL only', 400);
        }
        const b = await readJson(req);
        const cfg = { ...c, database: b.database || c.database };
        if (m[2] === 'tables') return ok(res, await dbQuery(cfg, LIST_TABLES[c.kind]));
        if (m[2] === 'databases') {
          const sql = c.kind === 'postgres'
            ? `SELECT datname AS name, pg_size_pretty(pg_database_size(datname)) AS size
               FROM pg_database WHERE NOT datistemplate ORDER BY 1`
            : `SELECT schema_name AS name, '' AS size FROM information_schema.schemata
               WHERE schema_name NOT IN ('mysql','sys','performance_schema','information_schema')`;
          return ok(res, await dbQuery(cfg, sql));
        }
        if (m[2] === 'query') {
          auth.audit(ses.username, 'db-kueri', String(b.sql || '').slice(0, 160));
          const t0 = Date.now();
          try {
            const r = await dbQuery(cfg, b.sql, b.params || []);
            const ms = Date.now() - t0;
            dbaas.logQuery({ instance: m[1], database: cfg.database, sql: b.sql,
              ms, rows: r.rows?.length ?? r.count, user: ses.username, source: 'sql' });
            if (ms >= THRESHOLDS.slowMs) {
              ev.emit('db.slow_query',
                `Kueri ${ms} ms di <code>${cfg.database}</code>: <code>${esc(String(b.sql).slice(0, 90))}</code>`,
                { key: String(b.sql).slice(0, 40) });
            }
            return ok(res, { ...r, ms });
          } catch (e) {
            dbaas.logQuery({ instance: m[1], database: cfg.database, sql: b.sql,
              ms: Date.now() - t0, error: e.message, user: ses.username, source: 'sql' });
            throw e;
          }
        }
        if (m[2] === 'columns') {
          const sql = c.kind === 'postgres'
            ? `SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
                      column_default AS def
               FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2
               ORDER BY ordinal_position`
            : `SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
                      column_default AS def
               FROM information_schema.columns WHERE table_schema=? AND table_name=?
               ORDER BY ordinal_position`;
          return ok(res, await dbQuery(cfg, sql, [b.schema, b.table]));
        }
        if (m[2] === 'rows') {
          const kind = c.kind, Q = idq(kind);
          const t = qualify({ ...b, kind });
          const lim = Math.min(+b.limit || 50, 200), off = Math.max(+b.offset || 0, 0);

          // Daftar kolom dipakai untuk membangun pencarian lintas kolom.
          const colSql = kind === 'postgres'
            ? `SELECT column_name AS name FROM information_schema.columns
               WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`
            : `SELECT column_name AS name FROM information_schema.columns
               WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`;
          const colr = await dbQuery(cfg, colSql, [b.schema, b.table]);
          const names = colr.rows.map(r => r.name);

          const where = [], params = [];
          let i = 1;
          const ph = () => kind === 'postgres' ? `$${i++}` : '?';

          // Pencarian bebas: cocokkan ke SEMUA kolom setelah diubah jadi teks,
          // supaya angka dan tanggal ikut ketemu tanpa perlu tahu tipenya.
          if (b.search && String(b.search).trim() && names.length) {
            const term = `%${String(b.search).trim()}%`;
            const cast = kind === 'postgres' ? 'TEXT' : 'CHAR';
            const op = kind === 'postgres' ? 'ILIKE' : 'LIKE';
            const parts = names.map(n => {
              params.push(term);
              return `CAST(${Q(n)} AS ${cast}) ${op} ${ph()}`;
            });
            where.push('(' + parts.join(' OR ') + ')');
          }
          // Penyaring per kolom: { kolom: nilai }
          for (const [k, v] of Object.entries(b.filters || {})) {
            if (!names.includes(k) || v === '' || v == null) continue;
            const cast = kind === 'postgres' ? 'TEXT' : 'CHAR';
            const op = kind === 'postgres' ? 'ILIKE' : 'LIKE';
            params.push(`%${v}%`);
            where.push(`CAST(${Q(k)} AS ${cast}) ${op} ${ph()}`);
          }
          const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

          let orderSql = '';
          if (b.orderBy && names.includes(b.orderBy)) {
            orderSql = ` ORDER BY ${Q(b.orderBy)} ${b.dir === 'desc' ? 'DESC' : 'ASC'}`;
          }

          const t0 = Date.now();
          const [rows, cnt] = await Promise.all([
            dbQuery(cfg, `SELECT * FROM ${t}${whereSql}${orderSql} LIMIT ${lim} OFFSET ${off}`, params),
            dbQuery(cfg, `SELECT COUNT(*) AS n FROM ${t}${whereSql}`, params)
              .catch(() => ({ rows: [{ n: null }] })),
          ]);
          const ms = Date.now() - t0;
          dbaas.logQuery({ instance: m[1], database: cfg.database,
            sql: `SELECT * FROM ${t}${whereSql}${orderSql} LIMIT ${lim} OFFSET ${off}`,
            ms, rows: rows.rows.length, user: ses.username, source: 'jelajah' });
          return ok(res, { ...rows, columns: names, total: cnt.rows[0]?.n ?? null,
            limit: lim, offset: off, ms });
        }
        if (m[2] === 'ddl') {
          // Perintah struktur tabel dirakit dari bagian yang sudah disaring,
          // bukan string mentah dari pengguna.
          const q2 = idq(c.kind);
          let sql;
          if (b.op === 'create_table') {
            const cols = (b.columns || []).map(col => {
              const type = String(col.type).replace(/[^A-Za-z0-9 (),]/g, '');
              return `${q2(col.name)} ${type}` +
                (col.notNull ? ' NOT NULL' : '') +
                (col.primary ? ' PRIMARY KEY' : '');
            });
            if (!cols.length) return fail(res, 'At least one column required', 400);
            sql = `CREATE TABLE ${qualify({ ...b, kind: c.kind })} (${cols.join(', ')})`;
          } else if (b.op === 'drop_table') {
            sql = `DROP TABLE ${qualify({ ...b, kind: c.kind })}`;
          } else if (b.op === 'add_column') {
            const type = String(b.column.type).replace(/[^A-Za-z0-9 (),]/g, '');
            sql = `ALTER TABLE ${qualify({ ...b, kind: c.kind })} ADD COLUMN ${q2(b.column.name)} ${type}`;
          } else if (b.op === 'drop_column') {
            sql = `ALTER TABLE ${qualify({ ...b, kind: c.kind })} DROP COLUMN ${q2(b.column)}`;
          } else if (b.op === 'create_database') {
            sql = `CREATE DATABASE ${q2(b.name)}`;
          } else if (b.op === 'drop_database') {
            sql = `DROP DATABASE ${q2(b.name)}`;
          } else return fail(res, 'Unknown operation', 400);
          auth.audit(ses.username, 'db-ddl', sql.slice(0, 160));
          return ok(res, await dbQuery(cfg, sql));
        }
      }
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/(insert|update|delete)$/))
          && req.method === 'POST') {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access to this database', 403);
        const c = dbaas.anyCredentials(m[1]);
        const b = await readJson(req);
        const cfg = { ...c, database: b.database || c.database };
        const kind = c.kind, t = qualify({ ...b, kind }), Q = idq(kind);
        let sql, params;
        if (m[2] === 'insert') {
          const cols = Object.keys(b.values);
          const ph = cols.map((_, i) => kind === 'postgres' ? `$${i + 1}` : '?');
          sql = `INSERT INTO ${t} (${cols.map(Q).join(',')}) VALUES (${ph.join(',')})`;
          params = Object.values(b.values);
        } else if (m[2] === 'update') {
          let i = 1;
          const set = Object.keys(b.values).map(k => `${Q(k)}=${kind === 'postgres' ? '$' + i++ : '?'}`);
          const wh = Object.keys(b.where).map(k => `${Q(k)}=${kind === 'postgres' ? '$' + i++ : '?'}`);
          sql = `UPDATE ${t} SET ${set.join(',')} WHERE ${wh.join(' AND ')}`;
          params = [...Object.values(b.values), ...Object.values(b.where)];
        } else {
          const wh = Object.keys(b.where).map((k, i) => `${Q(k)}=${kind === 'postgres' ? '$' + (i + 1) : '?'}`);
          sql = `DELETE FROM ${t} WHERE ${wh.join(' AND ')}`;
          params = Object.values(b.where);
        }
        auth.audit(ses.username, 'db-' + m[2], `${b.schema}.${b.table}`);
        return ok(res, await dbQuery(cfg, sql, params));
      }

      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/querylog$/))) {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access', 403);
        if (req.method === 'GET') {
          return ok(res, { log: dbaas.queryLog({ instance: m[1],
            onlyErrors: q.get('errors') === '1', onlySlow: q.get('slow') === '1',
            slowMs: THRESHOLDS.slowMs, limit: Math.min(+q.get('n') || 200, 500) }),
            stats: dbaas.queryStats(m[1]), slowMs: THRESHOLDS.slowMs });
        }
        if (req.method === 'DELETE') { dbaas.clearQueryLog(m[1]); return ok(res); }
      }

      if (p === '/api/db/external') {
        if (req.method === 'GET') return ok(res, { external: dbaas.listExternal() });
        if (req.method === 'POST') {
          const b = await readJson(req);
          // Uji sambungan dulu supaya kredensial salah tidak tersimpan diam-diam.
          await dbQuery({ kind: b.kind, host: b.host, port: b.port, user: b.user,
            password: b.password, database: b.database }, 'SELECT 1');
          const id = dbaas.addExternal(b);
          auth.audit(ses.username, 'db-external-tambah', `${b.name} ${b.host}`);
          return ok(res, { id });
        }
      }
      if ((m = p.match(/^\/api\/db\/external\/([^/]+)$/)) && req.method === 'DELETE') {
        dbaas.removeExternal(m[1]);
        auth.audit(ses.username, 'db-external-hapus', m[1]);
        return ok(res);
      }


      // ---- Ekspor & impor basis data ----
      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/export$/)) && req.method === 'POST') {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access', 403);
        const b = await readJson(req);
        const c = dbaas.anyCredentials(m[1]);
        const cfg = { ...c, database: b.database || c.database };
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        auth.audit(ses.username, 'db-ekspor', `${b.format} ${b.table || b.database || ''}`);

        const send = (text, filename, mime) => {
          const buf = Buffer.from(text, 'utf8');
          res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8',
            'Content-Length': buf.length,
            'Content-Disposition': `attachment; filename="${filename}"` });
          res.end(buf);
        };

        // Dump penuh memakai pg_dump / mariadb-dump.
        if (b.format === 'sql-dump') {
          const text = await dbaas.dumpDatabase(m[1], { schemaOnly: b.schemaOnly,
            dataOnly: b.dataOnly, table: b.table });
          const who = b.table ? b.table : cfg.database;
          return send(text, `${who}-${stamp}.sql`, 'application/sql');
        }

        // Sisanya berangkat dari hasil sebuah kueri atau isi satu tabel.
        let rows, fields, label;
        if (b.sql) {
          const r = await dbQuery(cfg, b.sql);
          rows = r.rows; fields = r.fields; label = 'kueri';
        } else if (b.table) {
          const t = qualify({ ...b, kind: c.kind });
          const lim = Math.min(+b.limit || 100000, 500000);
          const r = await dbQuery(cfg, `SELECT * FROM ${t} LIMIT ${lim}`);
          rows = r.rows; fields = r.fields; label = b.table;
        } else return fail(res, 'Need a table or a query', 400);

        if (b.format === 'csv') return send(dbaas.toCsv(rows, fields), `${label}-${stamp}.csv`, 'text/csv');
        if (b.format === 'json') {
          return send(JSON.stringify(rows, null, 2), `${label}-${stamp}.json`, 'application/json');
        }
        if (b.format === 'sql-insert') {
          const t = b.table ? qualify({ ...b, kind: c.kind }) : 'tabel_tujuan';
          return send(dbaas.toSqlInserts(rows, fields, t, c.kind),
            `${label}-${stamp}.sql`, 'application/sql');
        }
        return fail(res, 'Unknown format', 400);
      }

      if ((m = p.match(/^\/api\/db\/instances\/([^/]+)\/import$/)) && req.method === 'POST') {
        if (!auth.canDb(ses, m[1])) return fail(res, 'No access', 403);
        const b = await readJson(req);
        const c = dbaas.anyCredentials(m[1]);
        const cfg = { ...c, database: b.database || c.database };
        auth.audit(ses.username, 'db-impor', `${b.kind} ${b.table || ''}`);

        // Berkas .sql dijalankan apa adanya.
        if (b.kind === 'sql') {
          const r = await dbQuery(cfg, b.content);
          return ok(res, { ok: true, sets: r.sets?.length || 1 });
        }

        // CSV: baris pertama dianggap nama kolom.
        const rows = dbaas.parseCsv(b.content);
        if (rows.length < 2) return fail(res, 'CSV is empty or has only a header', 400);
        const header = rows[0].map(h => h.trim());
        const t = qualify({ ...b, kind: c.kind });
        const Q = idq(c.kind);
        let inserted = 0; const errors = [];

        for (let i = 1; i < rows.length; i++) {
          const vals = rows[i];
          const cols = [], params = [];
          header.forEach((h, idx) => {
            if (!h) return;
            const v = vals[idx];
            // Sel kosong dibiarkan NULL supaya nilai bawaan kolom tetap berlaku.
            if (v === undefined || v === '') return;
            cols.push(h); params.push(v);
          });
          if (!cols.length) continue;
          const ph = cols.map((_, k) => c.kind === 'postgres' ? `$${k + 1}` : '?');
          try {
            await dbQuery(cfg,
              `INSERT INTO ${t} (${cols.map(Q).join(',')}) VALUES (${ph.join(',')})`, params);
            inserted++;
          } catch (e) {
            errors.push({ baris: i + 1, pesan: String(e.message).slice(0, 160) });
            if (errors.length > 20) break;
          }
        }
        return ok(res, { inserted, total: rows.length - 1, errors });
      }

      // ---- Domain & reverse proxy ----
      if (p === '/api/sites') {
        if (req.method === 'GET') {
          const [certs, st] = await Promise.all([
            proxy.certInfo().catch(() => []), proxy.caddyStatus().catch(() => null)]);
          return ok(res, { sites: proxy.listSites(), certs, caddy: st,
            config: proxy.buildCaddyfile() });
        }
        if (req.method === 'POST') {
          const b = await readJson(req);
          proxy.addSite(b);
          const r = await proxy.applyConfig();
          auth.audit(ses.username, 'domain-tambah', b.domain);
          ev.emit('domain.added', `<code>${b.domain}</code> diarahkan ke ${b.target}:${b.port}.`);
          return ok(res, r);
        }
      }
      if ((m = p.match(/^\/api\/sites\/([^/]+)$/)) && req.method === 'DELETE') {
        proxy.removeSite(m[1]);
        const r = await proxy.applyConfig();
        auth.audit(ses.username, 'domain-hapus', m[1]);
        return ok(res, r);
      }
      if (p === '/api/sites/apply' && req.method === 'POST') {
        return ok(res, await proxy.applyConfig());
      }
      if (p === '/api/sites/dns') {
        const r = await proxy.dnsCheck(q.get('domain'));
        if (r.match === false) ev.emit('domain.dns_failed',
          `<code>${q.get('domain')}</code> belum mengarah ke IP server.`);
        return ok(res, r);
      }

      // ---- Subdomain lewat Cloudflare Tunnel (tanpa port 80/443 terbuka) ----
      if (p === '/api/tunnel/sites') {
        if (req.method === 'GET') {
          return ok(res, { sites: tunnel.listSites(), baseDomain: tunnel.baseDomain() });
        }
        if (req.method === 'POST') {
          const b = await readJson(req);
          let site;
          try { site = tunnel.addSite(b); } catch (e) { return fail(res, e.message, 400); }
          const dns = await tunnel.routeDns(site.hostname);
          const apply = await tunnel.applyConfig();
          if (!dns.ok) auth.audit(ses.username, 'tunnel-tambah-gagal', site.hostname);
          else auth.audit(ses.username, 'tunnel-tambah', site.hostname);
          if (dns.ok) ev.emit('domain.added', `<code>${site.hostname}</code> diarahkan lewat Cloudflare Tunnel ke ${site.target}:${site.port}.`);
          return ok(res, { site, dns, apply,
            warning: !dns.ok ? 'Gagal daftar DNS: ' + dns.message
              : !apply.ok ? 'Gagal muat ulang cloudflared: ' + apply.message : undefined });
        }
      }
      if ((m = p.match(/^\/api\/tunnel\/sites\/([^/]+)$/)) && req.method === 'DELETE') {
        tunnel.removeSite(m[1]);
        const apply = await tunnel.applyConfig();
        auth.audit(ses.username, 'tunnel-hapus', m[1]);
        return ok(res, apply);
      }

      // ---- Basis data: ubah data & ekspor ----
      if (p === '/api/db/columns' && req.method === 'POST') {
        const b = await readJson(req);
        const sql = b.kind === 'postgres'
          ? `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
             FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2
             ORDER BY ordinal_position`
          : `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
             FROM information_schema.columns WHERE table_schema=? AND table_name=?
             ORDER BY ordinal_position`;
        return ok(res, await dbQuery(b, sql, [b.schema, b.table]));
      }
      if (p === '/api/db/insert' && req.method === 'POST') {
        const b = await readJson(req);
        const t = qualify(b);
        const cols = Object.keys(b.values);
        const ph = cols.map((_, i) => b.kind === 'postgres' ? `$${i + 1}` : '?');
        const sql = `INSERT INTO ${t} (${cols.map(idq(b.kind)).join(',')}) VALUES (${ph.join(',')})`;
        auth.audit(ses.username, 'db-insert', `${b.schema}.${b.table}`);
        return ok(res, await dbQuery(b, sql, Object.values(b.values)));
      }
      if (p === '/api/db/update' && req.method === 'POST') {
        const b = await readJson(req);
        const t = qualify(b);
        const cols = Object.keys(b.values), keys = Object.keys(b.where);
        let i = 1;
        const set = cols.map(c => `${idq(b.kind)(c)}=${b.kind === 'postgres' ? '$' + i++ : '?'}`);
        const wh = keys.map(c => `${idq(b.kind)(c)}=${b.kind === 'postgres' ? '$' + i++ : '?'}`);
        const sql = `UPDATE ${t} SET ${set.join(',')} WHERE ${wh.join(' AND ')}`;
        auth.audit(ses.username, 'db-update', `${b.schema}.${b.table}`);
        return ok(res, await dbQuery(b, sql, [...Object.values(b.values), ...Object.values(b.where)]));
      }
      if (p === '/api/db/delete' && req.method === 'POST') {
        const b = await readJson(req);
        const t = qualify(b);
        const keys = Object.keys(b.where);
        const wh = keys.map((c, i) => `${idq(b.kind)(c)}=${b.kind === 'postgres' ? '$' + (i + 1) : '?'}`);
        const sql = `DELETE FROM ${t} WHERE ${wh.join(' AND ')}`;
        auth.audit(ses.username, 'db-delete', `${b.schema}.${b.table}`);
        return ok(res, await dbQuery(b, sql, Object.values(b.where)));
      }
      if (p === '/api/db/databases' && req.method === 'POST') {
        const b = await readJson(req);
        const sql = b.kind === 'postgres'
          ? `SELECT datname AS name, pg_size_pretty(pg_database_size(datname)) AS size
             FROM pg_database WHERE NOT datistemplate ORDER BY 1`
          : `SELECT schema_name AS name, '' AS size FROM information_schema.schemata`;
        return ok(res, await dbQuery(b, sql));
      }
      if (p === '/api/db/create' && req.method === 'POST') {
        const b = await readJson(req);
        const name = String(b.name).replace(/[^A-Za-z0-9_]/g, '');
        if (!name) return fail(res, 'Invalid name', 400);
        auth.audit(ses.username, 'db-buat', name);
        return ok(res, await dbQuery(b, `CREATE DATABASE ${idq(b.kind)(name)}`));
      }

      // ---- Ambang peringatan ----
      if (p === '/api/thresholds') {
        if (req.method === 'GET') return ok(res, THRESHOLDS);
        if (req.method === 'POST') {
          const b = await readJson(req);
          for (const k of Object.keys(THRESHOLDS)) {
            if (typeof b[k] === 'number' && b[k] > 0) THRESHOLDS[k] = b[k];
          }
          fs.writeFile(path.join(STATE_DIR, 'thresholds.json'),
            JSON.stringify(THRESHOLDS)).catch(() => {});
          auth.audit(ses.username, 'ambang-ubah', JSON.stringify(THRESHOLDS));
          return ok(res, THRESHOLDS);
        }
      }

      // ---- Pemulihan cadangan ----
      if (p === '/api/backups/restore' && req.method === 'POST') {
        const b = await readJson(req);
        const f = admin.backupPath(b.name);
        auth.audit(ses.username, 'restore', b.name);
        let r;
        if (b.name.startsWith('db-')) {
          if (!b.container) return fail(res, 'Database container is required', 400);
          admin.assertName(b.container, 'container');
          admin.assertName(b.user || 'postgres', 'database user');
          r = await stacks.runP('sh', ['-c',
            'gunzip -c "$1" | docker exec -i "$2" psql -U "$3"',
            'sh', f, b.container, b.user || 'postgres']);
        } else if (b.name.startsWith('volume-')) {
          if (!b.volume) return fail(res, 'Volume name is required', 400);
          admin.assertName(b.volume, 'volume');
          r = await stacks.runP('docker', ['run', '--rm', '-v', `${b.volume}:/dst`,
            '-v', `${path.dirname(f)}:/src:ro`, 'alpine',
            'sh', '-c', `tar xzf /src/${path.basename(f)} -C /dst`]);
        } else {
          r = await stacks.runP('tar', ['xzf', f, '-C', DATA_ROOT]);
        }
        ev.emit('db.restored', `Dipulihkan dari <code>${b.name}</code>.`);
        if (r.code !== 0) return fail(res, r.out || 'Restore failed');
        return ok(res, { message: 'Restore complete' });
      }

      // ---- Pusat kejadian ----
      if (p === '/api/events') {
        return ok(res, { events: ev.list({ cat: q.get('cat') || undefined,
          sev: q.get('sev') || undefined, unread: q.get('unread') === '1',
          limit: Math.min(+q.get('n') || 200, 500) }),
          stats: ev.stats(), categories: ev.CATEGORIES });
      }
      if (p === '/api/events/read' && req.method === 'POST') {
        const b = await readJson(req); ev.markRead(b.ids); return ok(res, { unread: ev.unreadCount() });
      }
      if (p === '/api/events/clear' && req.method === 'POST') { ev.clearAll(); return ok(res); }
      if (p === '/api/events/config') {
        if (req.method === 'GET') {
          return ok(res, { catalog: Object.entries(ev.CATALOG).map(([k, v]) => ({
            type: k, cat: v.c, title: v.t, def: v.s, cur: ev.severityOf(k) })),
            categories: ev.CATEGORIES });
        }
        if (req.method === 'POST') {
          const b = await readJson(req); ev.setOverride(b.type, b.severity);
          auth.audit(ses.username, 'notif-atur', `${b.type}=${b.severity}`);
          return ok(res);
        }
      }

      // ---- Asisten AI ----
      if (p === '/api/ai/chat' && req.method === 'POST') {
        const b = await readJson(req);
        const key = admin.getSecret('GROQ_API_KEY');
        if (!key) return fail(res, 'Groq API key missing. Store it in the Vault as GROQ_API_KEY.', 400);
        auth.audit(ses.username, 'ai-tanya', String(b.messages?.slice(-1)[0]?.content || '').slice(0, 120));
        const r = await ai.chat({ apiKey: key, messages: b.messages || [], history });
        return ok(res, r);
      }
      if (p === '/api/ai/apply' && req.method === 'POST') {
        const b = await readJson(req);
        auth.audit(ses.username, 'ai-apply', `${b.action} ${b.target || ''}`);
        const msg = await ai.applyFix(b.action, b.target);
        ev.emit('container.auto_restart', `Assistant applied: ${b.action} ${b.target || ''}`);
        return ok(res, { message: msg });
      }
      if (p === '/api/ai/status') {
        return ok(res, { ready: !!admin.getSecret('GROQ_API_KEY') });
      }

      // ---- Layanan systemd ----
      if (p === '/api/admin/services') return ok(res, { services: await admin.services() });
      if ((m = p.match(/^\/api\/admin\/services\/([^/]+)\/([a-z]+)$/)) && req.method === 'POST') {
        await admin.serviceAction(decodeURIComponent(m[1]), m[2]);
        auth.audit(ses.username, 'service-' + m[2], m[1]);
        return ok(res);
      }

      // ---- Paket & pembaruan ----
      if (p === '/api/admin/updates') return ok(res, await admin.updatesAvailable());
      if ((m = p.match(/^\/api\/admin\/apt\/(update|upgrade|install)$/)) && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (l) => res.write(`data: ${JSON.stringify(l)}\n\n`);
        const pkg = q.get('pkg');
        const e = m[1] === 'update' ? admin.aptUpdate()
          : m[1] === 'upgrade' ? admin.aptUpgrade() : admin.aptInstall(pkg);
        auth.audit(ses.username, 'apt-' + m[1], pkg || '');
        e.onLine = send;
        e.onDone = (c) => { res.write(`event: done\ndata: ${c}\n\n`); res.end(); };
        return;
      }

      // ---- Firewall & jaringan ----
      if (p === '/api/admin/firewall') return ok(res, await admin.firewall());
      if (p === '/api/admin/firewall' && req.method === 'POST') {
        const b = await readJson(req);
        await admin.firewallAllow(b.port, b.proto);
        auth.audit(ses.username, 'firewall-allow', `${b.port}/${b.proto}`);
        ev.emit('sec.port_opened', `Port <code>${b.port}/${b.proto}</code> dibuka.`);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/admin\/firewall\/(\d+)$/)) && req.method === 'DELETE') {
        await admin.firewallDelete(m[1]);
        auth.audit(ses.username, 'firewall-hapus', m[1]);
        return ok(res);
      }
      if (p === '/api/admin/firewall/toggle' && req.method === 'POST') {
        const b = await readJson(req);
        await admin.firewallToggle(!!b.on);
        auth.audit(ses.username, 'firewall-toggle', String(!!b.on));
        return ok(res);
      }
      if (p === '/api/admin/network') return ok(res, await admin.netInfo());

      // ---- Pengguna Linux ----
      if (p === '/api/admin/linux-users') {
        if (req.method === 'GET') return ok(res, { users: await admin.linuxUsers() });
        if (req.method === 'POST') {
          const b = await readJson(req);
          await admin.linuxUserAdd(b.name, b.password);
          auth.audit(ses.username, 'linux-user-tambah', b.name);
          return ok(res);
        }
      }
      if ((m = p.match(/^\/api\/admin\/linux-users\/([^/]+)$/)) && req.method === 'DELETE') {
        await admin.linuxUserDel(decodeURIComponent(m[1]));
        auth.audit(ses.username, 'linux-user-hapus', m[1]);
        return ok(res);
      }

      // ---- Penjadwal ----
      if (p === '/api/jobs') {
        if (req.method === 'GET') return ok(res, { jobs: admin.listJobs() });
        if (req.method === 'POST') {
          const b = await readJson(req);
          admin.addJob(b); auth.audit(ses.username, 'job-tambah', b.name);
          return ok(res);
        }
      }
      if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
        if (req.method === 'DELETE') { admin.deleteJob(m[1]);
          auth.audit(ses.username, 'job-hapus', m[1]); return ok(res); }
        if (req.method === 'PATCH') { admin.updateJob(m[1], await readJson(req)); return ok(res); }
      }
      if ((m = p.match(/^\/api\/jobs\/([^/]+)\/run$/)) && req.method === 'POST') {
        const jb = admin.listJobs().find(x => x.id === m[1]);
        if (!jb) return fail(res, 'Job not found', 404);
        auth.audit(ses.username, 'job-jalankan', jb.name);
        return ok(res, await admin.runJob(jb, notify));
      }

      // ---- Brankas rahasia ----
      if (p === '/api/secrets') {
        if (req.method === 'GET') return ok(res, { secrets: admin.listSecrets() });
        if (req.method === 'POST') {
          const b = await readJson(req);
          admin.setSecret(b.name, b.value);
          auth.audit(ses.username, 'secret-simpan', b.name);
          return ok(res);
        }
      }
      if ((m = p.match(/^\/api\/secrets\/([^/]+)$/))) {
        if (req.method === 'DELETE') { admin.deleteSecret(decodeURIComponent(m[1]));
          auth.audit(ses.username, 'secret-hapus', m[1]); return ok(res); }
        if (req.method === 'GET') {
          auth.audit(ses.username, 'secret-lihat', m[1]);
          ev.emit('sec.secret_viewed', `<b>${ses.username}</b> membuka nilai <code>${m[1]}</code>.`);
          return ok(res, { value: admin.getSecret(decodeURIComponent(m[1])) });
        }
      }
      if (p === '/api/secrets/inject' && req.method === 'POST') {
        const b = await readJson(req);
        const n = await admin.injectSecrets(b.stack);
        auth.audit(ses.username, 'secret-inject', b.stack);
        return ok(res, { added: n });
      }

      // ---- Cadangan ----
      if (p === '/api/backups') {
        if (req.method === 'GET') return ok(res, { backups: await admin.listBackups() });
        if (req.method === 'POST') {
          const b = await readJson(req);
          ev.emit('backup.started', `Cadangan ${b.what || 'data'} dimulai.`);
          const r = await admin.doBackup(b.what || 'data');
          auth.audit(ses.username, 'backup', b.what || 'data');
          if (r.code !== 0) { ev.emit('backup.failed', r.out?.slice(0, 300) || 'Gagal');
            return fail(res, r.out || 'Backup failed'); }
          ev.emit('backup.ok', `Cadangan selesai: <code>${path.basename(r.file)}</code>`);
          return ok(res, { file: r.file });
        }
      }
      if ((m = p.match(/^\/api\/backups\/([^/]+)$/)) && req.method === 'DELETE') {
        await admin.deleteBackup(decodeURIComponent(m[1]));
        auth.audit(ses.username, 'backup-hapus', m[1]);
        return ok(res);
      }
      if (p === '/api/backups/download') {
        const f = admin.backupPath(q.get('name'));
        const st = await fs.stat(f);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size,
          'Content-Disposition': `attachment; filename="${path.basename(f)}"` });
        return fsSync.createReadStream(f).pipe(res);
      }

      // ---- Status backup HDD otomatis (setup-backup.sh / server-backup.timer) ----
      // Ini SISTEM TERPISAH dari /api/backups di atas (yang cuma tau soal
      // backup manual "Back up now"): backup ini jalan lewat systemd timer di
      // host, di luar kendali panel — jadi statusnya harus dibaca langsung
      // dari host, bukan disimpan panel sendiri.
      if (p === '/api/backups/hdd' && req.method === 'GET') {
        const HR = '/host/root';
        const mountsTxt = await fs.readFile('/host/proc/1/mounts', 'utf8').catch(() => '');
        const mounted = mountsTxt.split('\n').some((l) => l.split(' ')[1] === '/mnt/backup');
        let usage = null;
        if (mounted) {
          try {
            const st = fsSync.statfsSync(`${HR}/mnt/backup`);
            const total = st.blocks * st.bsize, free = st.bfree * st.bsize;
            usage = { total, free, used: total - free };
          } catch {}
        }
        let snapshots = [];
        if (mounted) {
          try {
            const names = await fs.readdir(`${HR}/mnt/backup/auto`);
            for (const n of names) {
              if (!/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n)) continue;
              const st = await fs.stat(`${HR}/mnt/backup/auto/${n}`).catch(() => null);
              if (st) snapshots.push({ name: n, at: st.mtimeMs });
            }
          } catch {}
        }
        snapshots.sort((a, b) => b.at - a.at);
        const timerR = await stacks.runP('nsenter',
          ['-t', '1', '-m', '-u', '-n', '-i', 'systemctl', 'is-active', 'server-backup.timer']);
        const dbNames = await fs.readdir(`${HR}/srv/db-dumps`).catch(() => []);
        return ok(res, {
          mounted, usage,
          timerActive: timerR.out.trim() === 'active',
          lastBackup: snapshots[0]?.at || null,
          snapshotCount: snapshots.length,
          snapshots: snapshots.slice(0, 10),
          dbDumpCount: dbNames.filter((n) => /\.(sql\.gz|archive\.gz|rdb)$/.test(n)).length,
        });
      }

      // ---- Riwayat backup (dipakai grafik/overview di Vault & Backups) ----
      // File JSON-lines ditulis /usr/local/bin/server-backup (host, tiap
      // run tengah malam) -- bukan disampling panel kayak grafik database,
      // karena backup cuma jalan sekali sehari, bukan tiap menit.
      if (p === '/api/backups/history' && req.method === 'GET') {
        let lines = [];
        try {
          const raw = await fs.readFile(path.join(STATE_DIR, 'backup-history.json'), 'utf8');
          lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        } catch {}
        const ok2 = lines.filter((l) => l.ok);
        const avgSize = ok2.length ? Math.round(ok2.reduce((a, l) => a + (l.sizeBytes || 0), 0) / ok2.length) : null;
        const avgXfer = ok2.length ? Math.round(ok2.reduce((a, l) => a + (l.xferBytes || 0), 0) / ok2.length) : null;
        return ok(res, {
          runs: lines.slice(-90), // ~3 bulan kalau backup harian
          total: lines.length, successCount: ok2.length,
          successRate: lines.length ? Math.round((ok2.length / lines.length) * 100) : null,
          avgSizeBytes: avgSize, avgXferBytes: avgXfer,
        });
      }

      // ---- Disaster-recovery snapshot: seluruh /state panel, bukan cuma
      // data aplikasi (yang sudah dicover backup HDD/GDrive biasa) ----
      if (p === '/api/dr/snapshots' && req.method === 'GET') {
        return ok(res, { snapshots: await drSnapshot.listSnapshots() });
      }
      if (p === '/api/dr/snapshots' && req.method === 'POST') {
        const r = await drSnapshot.createSnapshot();
        auth.audit(ses.username, 'dr-snapshot', r.file);
        return ok(res, r);
      }
      if ((m = p.match(/^\/api\/dr\/snapshots\/(panel-state-[0-9T-]+Z\.tar\.gz)\/download$/))) {
        const full = drSnapshot.snapshotPath(m[1]);
        if (!full) return fail(res, 'Snapshot not found', 404);
        const st = await fs.stat(full);
        res.writeHead(200, { 'Content-Type': 'application/gzip',
          'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${m[1]}"` });
        fsSync.createReadStream(full).pipe(res);
        return;
      }

      // ---- Google Drive (off-site backup, multi-akun) ----
      // Client ID/Secret OAuth-nya sendiri disimpan lewat brankas Secrets
      // (bukan cuma .env) — biar panel ini bisa dipakai siapa saja tanpa
      // perlu akses shell/edit docker-compose, cukup isi lewat halaman ini.
      if (p === '/api/gdrive/config' && req.method === 'GET') {
        return ok(res, { configured: gdrive.configured(), redirectUri: gdrive.redirectUri() });
      }
      if (p === '/api/gdrive/config' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.clientId || !b.clientSecret) return fail(res, 'Client ID dan Client Secret wajib diisi', 400);
        gdrive.setCredentials(b.clientId, b.clientSecret);
        auth.audit(ses.username, 'gdrive-config', 'Client ID/Secret diperbarui');
        return ok(res, { configured: gdrive.configured(), redirectUri: gdrive.redirectUri() });
      }
      if (p === '/api/gdrive/accounts' && req.method === 'GET') {
        const list = gdrive.listAccounts();
        const withQuota = await Promise.all(list.map(async (a) => {
          try { return { ...a, quota: await gdrive.quotaOf(a.id) }; }
          catch (e) { return { ...a, quota: null, error: e.message }; }
        }));
        return ok(res, { configured: gdrive.configured(), accounts: withQuota });
      }
      if (p === '/api/gdrive/connect' && req.method === 'GET') {
        if (!gdrive.configured()) return fail(res, 'GDRIVE_CLIENT_ID/SECRET belum diset di server', 400);
        return ok(res, { url: gdrive.authUrl(ses.username) });
      }
      if ((m = p.match(/^\/api\/gdrive\/accounts\/([^/]+)$/)) && req.method === 'DELETE') {
        gdrive.removeAccount(m[1]);
        auth.audit(ses.username, 'gdrive-disconnect', m[1]);
        return ok(res);
      }
      // Redirect dari Google — BUKAN dipanggil lewat fetch() dari app.js,
      // tapi navigasi browser biasa (makanya balikin HTML, bukan JSON).
      if (p === '/api/gdrive/oauth/callback' && req.method === 'GET') {
        const code = q.get('code'), err = q.get('error');
        const closeTab = (msg, ok2) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(`<!doctype html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <p>${esc(msg)}</p><script>
              if (window.opener) { window.opener.postMessage({ gdrive: ${ok2 ? 'true' : 'false'} }, '*'); window.close(); }
              else { setTimeout(() => location.href = '/', 2000); }
            </script></body>`);
        };
        if (err) return closeTab('Otorisasi dibatalkan: ' + err, false);
        try {
          const acc = await gdrive.handleCallback(code);
          auth.audit(ses?.username || '?', 'gdrive-connect', acc.email);
          return closeTab(`Akun ${acc.email} berhasil disambungkan. Tab ini bisa ditutup.`, true);
        } catch (e) { return closeTab('Gagal: ' + e.message, false); }
      }

      // ---- Stack: compose & git ----
      if (p === '/api/stacks' && req.method === 'GET') return ok(res, { stacks: await stacks.listStacks() });
      if ((m = p.match(/^\/api\/stacks\/([^/]+)$/))) {
        if (req.method === 'GET') return ok(res, await stacks.readStack(m[1]));
        if (req.method === 'PUT') {
          const b = await readJson(req);
          await stacks.writeStack(m[1], b.compose, b.env);
          auth.audit(ses.username, 'stack-simpan', m[1]);
          return ok(res, await stacks.validateStack(m[1]));
        }
        if (req.method === 'DELETE') {
          await stacks.removeStack(m[1]);
          autoscale.unregister(m[1]);
          auth.audit(ses.username, 'stack-hapus', m[1]);
          return ok(res);
        }
      }
      if ((m = p.match(/^\/api\/stacks\/([^/]+)\/validate$/)) && req.method === 'POST') {
        return ok(res, await stacks.validateStack(m[1]));
      }
      if ((m = p.match(/^\/api\/stacks\/([^/]+)\/hook$/))) {
        return ok(res, { token: stacks.webhookToken(m[1]) });
      }
      if ((m = p.match(/^\/api\/stacks\/([^/]+)\/git$/))) {
        const name = m[1];
        if (req.method === 'GET') {
          return ok(res, { branches: await stacks.gitBranches(name),
            current: await stacks.gitCurrent(name), log: await stacks.gitLog(name) });
        }
      }
      // Deteksi jenis project (Next.js/Vite/CRA/Node/statis) buat "Deploy
      // otomatis" — dipanggil SETELAH repo di-clone, SEBELUM benar-benar
      // deploy, supaya pengguna bisa lihat & konfirmasi dulu (port, env var)
      // daripada langsung jalan buta.
      if ((m = p.match(/^\/api\/stacks\/([^/]+)\/detect$/)) && req.method === 'GET') {
        const det = await autodeploy.detect(stacks.dirOf(m[1]));
        const port = await autodeploy.findFreePort();
        return ok(res, { ...det, suggestedPort: port });
      }

      // Aksi panjang memakai SSE supaya log build terlihat saat berjalan.
      if ((m = p.match(/^\/api\/stacks\/([^/]+)\/(deploy|stop|clone|pull|checkout|autodeploy|preview|canary-deploy)$/))) {
        const [, name, action] = m;
        res.writeHead(200, { 'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (l) => res.write(`data: ${JSON.stringify(l)}\n\n`);
        const done = (code) => { res.write(`event: done\ndata: ${code}\n\n`); res.end(); };
        try {
          if (action === 'deploy') {
            send('$ docker compose up -d --build');
            const c = await stacks.deploy(name, send);
            auth.audit(ses.username, 'deploy', name + ' code=' + c);
            ev.emit(c === 0 ? 'deploy.success' : 'deploy.failed',
              `Stack <code>${name}</code>${c === 0 ? ' berhasil di-deploy.' : ` gagal (kode ${c}).`}`, { key: name });
            // Auto-rollback: deploy "berhasil" (exit 0) TAPI container-nya
            // langsung crash/exit setelah nyala -- ini kejadian umum kalau
            // env var/config baru salah, code-nya sendiri gak error pas
            // build. Cuma buat stack dari git (rollback butuh commit
            // sebelumnya buat balik ke situ).
            if (c === 0) {
              const meta = await stacks.readStack(name).catch(() => null);
              if (meta?.source === 'git') {
                await new Promise((r) => setTimeout(r, 5000));
                // --all WAJIB di sini -- tanpa itu, "docker compose ps"
                // cuma nunjukin container yang MASIH jalan; container yang
                // udah crash & exit (justru kasus utama yang mau ditangkap)
                // malah HILANG dari daftar sama sekali, bukan kelihatan
                // "stopped" -- health check jadi ga pernah nangkep apa-apa.
                const { out } = await stacks.runP('docker', ['compose', 'ps', '--all', '--format', 'json'],
                  { cwd: stacks.dirOf(name) });
                const rows = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                const unhealthy = rows.length === 0 || rows.some((o) => !/running|up/i.test(o.State || o.Status || ''));
                if (unhealthy) {
                  const log = await stacks.gitLog(name, 2);
                  // Hash commit git itu selalu hex 40 karakter (atau versi
                  // pendeknya) -- validasi ini sebelum dipakai, karena
                  // gitLog() bisa balikin baris pesan ERROR git (bukan
                  // commit beneran) kalau git-nya sendiri gagal jalan
                  // (masalah permission/ownership, dst), dan itu JANGAN
                  // sampai kepakai jadi "ref" buat checkout.
                  if (log[1] && /^[0-9a-f]{7,40}$/i.test(log[1].hash)) {
                    send(`$ container tidak sehat 5 detik setelah deploy — rollback otomatis ke ${log[1].hash}`);
                    const co = await stacks.gitCheckout(name, log[1].hash, send);
                    if (co !== 0) {
                      send('$ rollback GAGAL — git checkout error, deploy TIDAK diulang biar tidak makin kacau');
                      ev.emit('deploy.failed', `Auto-rollback <code>${name}</code> gagal — git checkout error.`, { key: name });
                    } else {
                      const c2 = await stacks.deploy(name, send);
                      ev.emit(c2 === 0 ? 'deploy.rollback' : 'deploy.failed',
                        `Stack <code>${name}</code> di-rollback OTOMATIS ke <code>${log[1].hash}</code> — `
                        + `deploy sebelumnya bikin container-nya crash.`, { key: name });
                      auth.audit('system', 'auto-rollback', `${name} -> ${log[1].hash}`);
                    }
                  }
                }
              }
            }
            return done(c);
          }
          // Canary deploy: image baru di-build & DICOBA di container terpisah
          // dulu (docker compose run, gak publish port host, gak ganggu
          // traffic live) SEBELUM stack lama disentuh -- beda dari 'deploy'
          // biasa (yang auto-rollback REAKTIF, sesudah live) ini PROAKTIF,
          // dicegah sebelum sempat live sama sekali. Lihat stacks.canaryDeploy().
          if (action === 'canary-deploy') {
            const r = await stacks.canaryDeploy(name, send);
            auth.audit(ses.username, 'canary-deploy', `${name} code=${r.code} stage=${r.stage}`);
            if (r.stage === 'canary' || r.stage === 'build') {
              ev.emit('deploy.failed',
                `Canary deploy <code>${name}</code> dibatalkan di tahap <code>${r.stage}</code> -- stack lama tidak disentuh sama sekali, traffic tidak terganggu.`,
                { key: name });
              return done(r.code);
            }
            ev.emit(r.code === 0 ? 'deploy.success' : 'deploy.failed',
              `Stack <code>${name}</code>${r.code === 0 ? ' berhasil di-deploy (lolos canary).' : ` gagal (kode ${r.code}).`}`, { key: name });
            return done(r.code);
          }
          if (action === 'autodeploy') {
            let port = +q.get('port');
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              send('ERROR: Port tidak valid'); return done(1);
            }
            let envVars = {};
            try { envVars = JSON.parse(q.get('env') || '{}'); } catch {}
            send('$ mendeteksi jenis project…');
            let det = await autodeploy.scaffold(stacks.dirOf(name), name, { port, envVars });
            send(`$ terdeteksi: ${det.label} — Dockerfile & docker-compose.yml dibuat otomatis`);
            // Port yang disarankan sudah dicek ke host (bukan cuma di dalam
            // container panel), tapi tetap ada celah balapan kecil antara
            // saran itu ditampilkan dan tombol "Deploy" beneran diklik —
            // stack lain bisa saja baru saja pakai port itu di antaranya.
            // Kalau itu kejadian, jangan langsung nyerah: cari port lain
            // otomatis, tulis ulang compose-nya, coba lagi — user tidak
            // perlu tahu-menahu soal nomor port sama sekali.
            let c;
            for (let attempt = 1; attempt <= 5; attempt++) {
              let portConflict = false;
              send('$ docker compose up -d --build');
              c = await stacks.deploy(name, (line) => {
                if (/port is already allocated|address already in use|bind.*failed/i.test(line)) portConflict = true;
                send(line);
              });
              if (c === 0 || !portConflict) break;
              port = await autodeploy.findFreePort(port + 1);
              send(`$ port sebelumnya sudah dipakai stack lain — coba lagi pakai port ${port}…`);
              det = await autodeploy.scaffold(stacks.dirOf(name), name, { port, envVars });
            }
            auth.audit(ses.username, 'autodeploy', `${name} (${det.type}) code=${c}`);
            ev.emit(c === 0 ? 'deploy.success' : 'deploy.failed',
              `Stack <code>${name}</code> (deploy otomatis, ${det.label})${c === 0 ? ' berhasil.' : ` gagal (kode ${c}).`}`, { key: name });

            // Sekalian bikinkan subdomain publik lewat Cloudflare Tunnel —
            // ini tujuan utama "deploy otomatis": nggak ada langkah manual
            // tambahan buat bikin situsnya bisa diakses dari luar.
            // App Node/Next.js sekarang berada di belakang service "-lb"
            // (nginx) supaya bisa diperbanyak jadi beberapa replika tanpa
            // tabrakan port (lihat autoscale.js) — daftarkan biar dipantau,
            // TIDAK berlaku buat situs statis (nginx.conf sendiri, tidak
            // pernah kebocor memori bikin autoscale relevan).
            const isRuntime = det.type === 'next-server' || det.type === 'node';
            if (c === 0 && isRuntime) autoscale.register(name, { service: name, dir: stacks.dirOf(name) });

            if (c === 0) {
              try {
                const { out } = await stacks.runP('docker', ['compose', 'ps', '--format', 'json'],
                  { cwd: stacks.dirOf(name) });
                const names = out.split('\n').filter(Boolean)
                  .map(l => { try { return JSON.parse(l).Name; } catch { return null; } }).filter(Boolean);
                // Kalau ada service "-lb" (app runtime), itu yang publish
                // port ke host — link/target harus nunjuk ke situ, bukan ke
                // container app-nya (yang sekarang cuma bisa diakses lewat
                // jaringan docker internal, tanpa port ke host sama sekali).
                const containerName = names.find(n => n.includes(`${name}-lb`)) || names[0];
                // Selalu disarangkan di bawah nama project (app.<nama-stack>.domain),
                // bukan langsung di bawah domain utama — biar tidak semua
                // service yang di-deploy kelihatan rata di satu tingkat.
                const project = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
                send(`$ mendaftarkan subdomain ${project}-app.${tunnel.baseDomain()}…`);
                const site = tunnel.addSite({ label: 'app', target: containerName || name, port, project });
                const dns = await tunnel.routeDns(site.hostname);
                const apply = await tunnel.applyConfig();
                if (dns.ok && apply.ok) {
                  send(`$ situs bisa diakses di https://${site.hostname}`);
                  if (containerName) { CONTAINER_LINKS[containerName] = `https://${site.hostname}`; saveContainerLinks(); }
                  ev.emit('domain.added', `<code>${site.hostname}</code> diarahkan ke stack <code>${name}</code>.`);
                } else {
                  send(`$ (subdomain gagal didaftarkan otomatis: ${dns.message || apply.message} — `
                    + 'bisa dibikin manual lewat halaman Stacks)');
                }
              } catch (e) { send('$ (gagal setup subdomain otomatis: ' + e.message + ')'); }
            }
            return done(c);
          }
          if (action === 'stop') { send('$ docker compose down');
            return done(await stacks.stopStack(name, send)); }
          if (action === 'clone') {
            const repo = q.get('repo'), branch = q.get('branch');
            send(`$ git clone ${repo}`);
            const c = await stacks.gitClone(name, repo, branch, send);
            auth.audit(ses.username, 'git-clone', `${name} ${repo}`);
            return done(c);
          }
          // Preview environment: clone stack GIT yang sudah ada, tapi di
          // BRANCH lain, ke stack BARU yang terpisah total (folder, container,
          // network beda) -- biar bisa lihat/tes branch tanpa ganggu stack
          // utama yang lagi jalan. Dibersihkan otomatis 7 hari kalau tidak
          // di-deploy ulang (lihat autoCleanPreviews di bawah).
          if (action === 'preview') {
            const branch = q.get('branch');
            if (!branch) { send('ERROR: branch wajib diisi'); return done(1); }
            const src = await stacks.readStack(name).catch(() => null);
            if (!src || src.source !== 'git' || !src.repo) {
              send('ERROR: stack sumber harus bertipe git (punya repo)'); return done(1);
            }
            const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);
            const previewName = `${name}-pr-${slug}`.slice(0, 63);
            send(`$ git clone ${src.repo} (branch ${branch}) -> stack baru "${previewName}"`);
            const c1 = await stacks.gitClone(previewName, src.repo, branch, send);
            if (c1 !== 0) return done(c1);
            stacks.markPreview(previewName, name, branch);
            // Stack yang di-deploy lewat "Deploy website" (autodeploy.js) itu
            // Dockerfile/docker-compose.yml-nya di-GENERATE lokal, TIDAK ikut
            // ke-commit ke repo git -- clone barusan jadi tidak punya file
            // itu sama sekali. Salin dari stack sumber, tapi port host-nya
            // WAJIB diganti (port asli stack utama sudah dipakai).
            const previewDir = stacks.dirOf(previewName);
            const srcDir = stacks.dirOf(name);
            if (!fsSync.existsSync(path.join(previewDir, 'docker-compose.yml'))
                && fsSync.existsSync(path.join(srcDir, 'docker-compose.yml'))) {
              send('$ (repo ini tidak menyimpan docker-compose.yml sendiri -- disalin dari konfigurasi stack sumber, port host diganti otomatis)');
              for (const f of ['Dockerfile', 'docker-compose.yml', 'nginx.conf', 'nginx-lb.conf']) {
                try { await fs.copyFile(path.join(srcDir, f), path.join(previewDir, f)); } catch {}
              }
              const freePort = await autodeploy.findFreePort();
              let compose = await fs.readFile(path.join(previewDir, 'docker-compose.yml'), 'utf8');
              compose = compose.replace(/"(\d+):(\d+)"/, `"${freePort}:$2"`);
              await fs.writeFile(path.join(previewDir, 'docker-compose.yml'), compose);
              send(`$ preview akan diakses di port ${freePort}`);
            } else {
              send('$ (catatan: kalau docker-compose.yml stack ini punya port host TETAP, deploy preview bisa gagal karena port itu sudah dipakai stack utama -- ubah dulu port di compose.yml preview kalau perlu)');
            }
            send('$ docker compose up -d --build');
            const c2 = await stacks.deploy(previewName, send);
            auth.audit(ses.username, 'stack-preview', `${name} (${branch}) -> ${previewName}`);
            ev.emit(c2 === 0 ? 'deploy.success' : 'deploy.failed',
              `Preview <code>${previewName}</code> (branch <code>${branch}</code> dari <code>${name}</code>) `
              + (c2 === 0 ? 'berhasil di-deploy. Otomatis dihapus dalam 7 hari kalau tidak dipakai lagi.' : `gagal (kode ${c2}).`),
              { key: previewName });
            return done(c2);
          }
          if (action === 'pull') { send('$ git pull');
            return done(await stacks.gitPull(name, send)); }
          if (action === 'checkout') { send(`$ git checkout ${q.get('ref')}`);
            return done(await stacks.gitCheckout(name, q.get('ref'), send)); }
        } catch (e) { send('ERROR: ' + e.message); return done(1); }
      }

      // ---- Image / volume / jaringan ----
      if (p === '/api/images') {
        const imgs = await docker.listImages();
        return ok(res, { images: imgs.map(i => ({ id: i.Id.replace('sha256:', '').slice(0, 12),
          tags: i.RepoTags || [], size: i.Size, created: i.Created * 1000 })) });
      }
      // Cek update tersedia (Docker Hub doang) buat semua image lokal yang
      // punya nama/tag -- BUKAN auto-update, cuma kasih tau, tarik manual
      // lewat tombol Pull yang sudah ada kalau mau.
      if (p === '/api/images/updates' && req.method === 'GET') {
        const imgs = await docker.listImages();
        const updates = await registryCheck.checkImages(imgs);
        return ok(res, { updates, checked: imgs.filter((i) => i.RepoTags?.length).length });
      }
      // Pindai kerentanan (Trivy) -- hasil dicache 12 jam per image supaya
      // gak nge-scan ulang tiap buka halaman (sekali scan bisa >30 detik).
      if (p === '/api/images/vuln-scan' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.image) return fail(res, 'image wajib diisi', 400);
        const r = await vulnScan.scanImage(b.image, { force: !!b.force });
        auth.audit(ses.username, 'vuln-scan', b.image);
        return ok(res, r);
      }
      if (p === '/api/images/vuln-cache' && req.method === 'GET') {
        return ok(res, { cache: vulnScan.allCached() });
      }
      if (p === '/api/images/pull' && req.method === 'POST') {
        const b = await readJson(req);
        const st = await dockerExtra.pullImage(b.name);
        await new Promise(r => { st.on('data', () => {}); st.on('end', r); st.on('error', r); });
        auth.audit(ses.username, 'image-pull', b.name);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/images\/(.+)$/)) && req.method === 'DELETE') {
        await dockerExtra.removeImage(decodeURIComponent(m[1]));
        auth.audit(ses.username, 'image-hapus', m[1]);
        return ok(res);
      }
      if (p === '/api/prune' && req.method === 'POST') {
        const b = await readJson(req);
        const r = {};
        if (b.images) r.images = await dockerExtra.pruneImages();
        if (b.volumes) r.volumes = await dockerExtra.pruneVolumes();
        if (b.networks) r.networks = await dockerExtra.pruneNetworks();
        if (b.containers) r.containers = await dockerExtra.pruneContainers();
        if (b.buildCache) r.buildCache = await dockerExtra.pruneBuildCache();
        auth.audit(ses.username, 'prune', JSON.stringify(b));
        return ok(res, r);
      }

      // Status pembersihan log otomatis (retensi N hari) -- bisa dipicu
      // manual juga lewat tombol "Bersihkan sekarang" di halaman Cleanup.
      if (p === '/api/logs/retention' && req.method === 'GET') {
        return ok(res, { last: logRetention.lastRun(), days: logRetention.retentionDays() });
      }
      if (p === '/api/logs/retention/run' && req.method === 'POST') {
        const r = await logRetention.runCleanup(logRetention.retentionDays());
        auth.audit(ses.username, 'log-retention-manual', JSON.stringify(r));
        return ok(res, r);
      }

      // ---- Disk analyzer: apa yang paling makan disk, host + docker ----
      if (p === '/api/disk-analysis' && req.method === 'GET') {
        const [hostBreakdown, df] = await Promise.all([
          sys.diskBreakdown(),
          docker.systemDf().catch(() => null),
        ]);
        const dockerBreakdown = df ? [
          { label: 'Docker: Images', bytes: (df.Images || []).reduce((a, i) => a + (i.Size || 0), 0) },
          { label: 'Docker: Volumes', bytes: (df.Volumes || []).reduce((a, v) => a + (v.UsageData?.Size || 0), 0) },
          { label: 'Docker: Build cache', bytes: (df.BuildCache || []).reduce((a, c) => a + (c.Size || 0), 0) },
        ] : [];
        return ok(res, { host: hostBreakdown, docker: dockerBreakdown });
      }

      if (p === '/api/volumes') {
        const v = await docker.listVolumes();
        return ok(res, { volumes: (v.Volumes || []).map(x => ({ name: x.Name,
          driver: x.Driver, mount: x.Mountpoint, created: x.CreatedAt })) });
      }
      if (p === '/api/volumes' && req.method === 'POST') {
        const b = await readJson(req); await dockerExtra.createVolume(b.name); return ok(res);
      }
      if ((m = p.match(/^\/api\/volumes\/([^/]+)$/)) && req.method === 'DELETE') {
        await dockerExtra.removeVolume(m[1]);
        auth.audit(ses.username, 'volume-hapus', m[1]);
        return ok(res);
      }

      // Topologi jaringan -- container mana nyambung ke network mana, buat
      // digambar sebagai graf di frontend. listNetworks() (list biasa) TIDAK
      // ngasih anggota tiap network, jadi ambil dari sisi container
      // (NetworkSettings.Networks tiap container sudah lengkap datanya).
      if (p === '/api/networks/topology') {
        const [nets, cs] = await Promise.all([docker.listNetworks(), docker.listContainers()]);
        const nodes = cs.map((c) => ({ id: c.Id.slice(0, 12), name: (c.Names?.[0] || '').replace(/^\//, ''),
          state: c.State, image: c.Image }));
        const edges = [];
        for (const c of cs) {
          const nw = c.NetworkSettings?.Networks || {};
          for (const [name, info] of Object.entries(nw)) {
            edges.push({ container: c.Id.slice(0, 12), network: name, ip: info.IPAddress || null });
          }
        }
        const networks = nets.map((n) => ({ name: n.Name, driver: n.Driver, scope: n.Scope,
          internal: !!n.Internal, subnet: n.IPAM?.Config?.[0]?.Subnet || null }))
          .filter((n) => edges.some((e) => e.network === n.name)); // buang network kosong biar graf gak berantakan
        return ok(res, { nodes, networks, edges });
      }
      if (p === '/api/networks') {
        const n = await docker.listNetworks();
        return ok(res, { networks: n.map(x => ({ id: x.Id.slice(0, 12), name: x.Name,
          driver: x.Driver, scope: x.Scope,
          containers: Object.values(x.Containers || {}).map(c => c.Name) })) });
      }
      if (p === '/api/networks' && req.method === 'POST') {
        const b = await readJson(req); await dockerExtra.createNetwork(b.name); return ok(res);
      }
      if ((m = p.match(/^\/api\/networks\/([^/]+)\/(connect|disconnect)$/)) && req.method === 'POST') {
        const b = await readJson(req);
        await dockerExtra[m[2] === 'connect' ? 'connectNetwork' : 'disconnectNetwork'](m[1], b.container);
        auth.audit(ses.username, 'network-' + m[2], `${m[1]} ${b.container}`);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/networks\/([^/]+)$/)) && req.method === 'DELETE') {
        await dockerExtra.removeNetwork(m[1]);
        auth.audit(ses.username, 'network-hapus', m[1]);
        return ok(res);
      }

      // ---- Sistem (perintah berisiko: dicatat di audit) ----
      if (p === '/api/system/journal') {
        const { out } = await stacks.runP('sh', ['-c',
          `chroot /host/root journalctl -n ${Math.min(+q.get('n') || 300, 2000)} --no-pager 2>/dev/null || dmesg | tail -n ${+q.get('n') || 300}`]);
        return ok(res, { lines: out.split('\n') });
      }
      if (p === '/api/system/power' && req.method === 'POST') {
        const b = await readJson(req);
        if (!['reboot', 'poweroff'].includes(b.action)) return fail(res, 'Unknown action', 400);
        auth.audit(ses.username, 'power', b.action);
        notify('Perintah daya', `<b>${b.action}</b> dijalankan oleh ${ses.username}.`);
        stacks.run('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', 'systemctl', b.action]);
        return ok(res, { scheduled: b.action });
      }

      // ---- Container ----
      if (p === '/api/containers') {
        const list = await docker.listContainers();
        const out = await Promise.all(list.map(async (c) => {
          let cpu = 0, mem = { used: 0, limit: 0 };
          if (c.State === 'running') {
            try { const s = await docker.statsOnce(c.Id);
              cpu = cpuPercent(s); mem = memUsage(s); } catch {}
          }
          const name = (c.Names?.[0] || '').replace(/^\//, '');
          return {
            id: c.Id, name, image: c.Image, state: c.State, status: c.Status,
            created: c.Created * 1000, cpu, mem,
            ports: (c.Ports || []).filter((x) => x.PublicPort)
              .map((x) => `${x.PublicPort}:${x.PrivatePort}`),
            compose: c.Labels?.['com.docker.compose.project'] || null,
            // Container infrastruktur (panel itu sendiri, Caddy, Portainer) —
            // disembunyikan bawaan di UI supaya tidak gampang ke-klik hapus/stop
            // tanpa sadar.
            system: name === 'panel' || name === 'caddy' || name === 'portainer',
          };
        }));
        out.sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name)
          : a.state === 'running' ? -1 : 1));
        return ok(res, { containers: out });
      }

      if ((m = p.match(/^\/api\/containers\/([^/]+)\/history$/))) {
        return ok(res, { history: containerSeries.get(m[1], { range: q.get('range'),
          from: +q.get('from') || null, to: +q.get('to') || null }) });
      }

      if ((m = p.match(/^\/api\/containers\/([^/]+)\/(start|stop|restart|remove)$/))) {
        if (req.method !== 'POST') return fail(res, 'POST required', 405);
        // Nilai ini masuk ke path Docker API; batasi ke bentuk id/nama yang sah
        // supaya tidak bisa dipakai menjangkau endpoint lain.
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(m[1])) {
          return fail(res, 'Invalid container id', 400);
        }
        await docker[m[2] === 'remove' ? 'remove' : m[2]](m[1]);
        return ok(res);
      }
      if ((m = p.match(/^\/api\/containers\/([^/]+)\/inspect$/))) {
        return ok(res, await docker.inspect(m[1]));
      }
      // Link publik manual per-container (nama container sebagai kunci, stabil
      // lintas restart/recreate — beda dari ID yang berubah tiap recreate).
      if ((m = p.match(/^\/api\/containers\/([^/]+)\/link$/))) {
        const name = m[1];
        if (req.method === 'GET') return ok(res, { url: CONTAINER_LINKS[name] || null });
        if (req.method === 'POST') {
          const b = await readJson(req);
          const url = String(b.url || '').trim();
          if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
            return fail(res, 'URL must start with http:// or https://', 400);
          }
          if (url) CONTAINER_LINKS[name] = url; else delete CONTAINER_LINKS[name];
          saveContainerLinks();
          return ok(res, { url: CONTAINER_LINKS[name] || null });
        }
      }
      // Search lintas SEMUA container sekaligus (bukan satu-satu) — dipakai
      // toggle "Cari di semua container" di halaman Logs.
      if (p === '/api/containers/logs-search' && req.method === 'GET') {
        const term = (q.get('q') || '').toLowerCase();
        if (!term) return fail(res, 'Query kosong', 400);
        const tail = Math.min(+q.get('tail') || 300, 1000);
        const list = await docker.listContainers();
        const running = list.filter((c) => c.State === 'running');
        const results = [];
        await Promise.all(running.map(async (c) => {
          try {
            const stream = await docker.logsOnce(c.Id, tail);
            const chunks = [];
            await new Promise((resolve, reject) => {
              stream.on('data', (d) => chunks.push(d));
              stream.on('end', resolve);
              stream.on('error', reject);
            });
            const text = demuxDockerStream(Buffer.concat(chunks));
            const name = (c.Names?.[0] || '').replace(/^\//, '');
            for (const line of text.split('\n')) {
              if (!line || !line.toLowerCase().includes(term)) continue;
              // Format docker dengan timestamps=1: "2026-08-17T05:49:00.123Z sisa baris"
              const m2 = line.match(/^(\S+)\s(.*)$/s);
              const t = m2 ? Date.parse(m2[1]) : null;
              results.push({ container: name, containerId: c.Id, t, line: m2 ? m2[2] : line });
            }
          } catch {}
        }));
        results.sort((a, b) => (b.t || 0) - (a.t || 0));
        return ok(res, { results: results.slice(0, 500), containersSearched: running.length });
      }

      if ((m = p.match(/^\/api\/containers\/([^/]+)\/logs$/))) {
        // Server-Sent Events: log mengalir langsung ke UI tanpa polling.
        res.writeHead(200, { 'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive',
          'X-Accel-Buffering': 'no' });
        const stream = await docker.logStream(m[1], +q.get('tail') || 200);
        const send = (t) => t.split('\n').forEach((line) => {
          if (line !== '') res.write(`data: ${JSON.stringify(line)}\n\n`);
        });
        stream.on('data', (c) => { try { send(demuxDockerStream(c)); } catch {} });
        stream.on('end', () => res.end());
        const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => { clearInterval(ka); stream.destroy?.(); });
        return;
      }


      // ---- Editor kode ----
      // Daftar folder project yang bisa dibuka, bukan seluruh isi disk.
      if (p === '/api/files/workspaces') {
        const out = [];
        // 'host' sengaja dilewati di sini — top-level-nya cuma folder sistem
        // (bin, etc, usr, ...), bukan "project". Tetap bisa dibuka manual
        // lewat pilihan root langsung di Files / Code Editor.
        for (const [rootId, base] of Object.entries(ROOTS)) {
          if (rootId === 'host') continue;
          let ents = [];
          try { ents = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
          for (const e of ents) {
            if (!e.isDirectory() || e.name.startsWith('.')) continue;
            const dir = path.join(base, e.name);
            let files = 0, hint = null, mtime = 0;
            try {
              const inner = await fs.readdir(dir);
              files = inner.length;
              // Tebak jenis project dari berkas penandanya.
              const has = (n) => inner.some(x => x.toLowerCase() === n);
              hint = has('package.json') ? 'Node.js'
                : has('requirements.txt') || has('pyproject.toml') ? 'Python'
                : has('go.mod') ? 'Go'
                : has('composer.json') ? 'PHP'
                : has('cargo.toml') ? 'Rust'
                : inner.some(x => /\.csproj$/i.test(x)) ? '.NET'
                : inner.some(x => /^docker-compose\.ya?ml$|^compose\.ya?ml$/i.test(x)) ? 'Compose'
                : null;
              mtime = (await fs.stat(dir)).mtimeMs;
            } catch {}
            out.push({ root: rootId, path: e.name, name: e.name, files, hint, mtime });
          }
        }
        out.sort((a, b2) => b2.mtime - a.mtime);
        return ok(res, { workspaces: out, roots: Object.keys(ROOTS) });
      }

      // Satu tingkat saja. Folder besar tidak lagi memuat seluruh isinya
      // di muka; anak folder diambil ketika benar-benar dibuka.
      if (p === '/api/files/tree') {
        const root = q.get('root') || 'data';
        const rel = q.get('path') || '';
        const dir = safePath(rel, root);
        let ents = [];
        try { ents = await fs.readdir(dir, { withFileTypes: true }); }
        catch (e) { return fail(res, 'Folder not found', 404); }
        const items = [];
        for (const e of ents) {
          if (e.name.startsWith('.') && !/^\.env/.test(e.name) && e.name !== '.gitignore') continue;
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
          const childRel = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            let n = 0;
            try { n = (await fs.readdir(path.join(dir, e.name))).length; } catch {}
            items.push({ name: e.name, path: childRel, dir: true, count: n });
          } else {
            let size = 0;
            try { size = (await fs.stat(path.join(dir, e.name))).size; } catch {}
            items.push({ name: e.name, path: childRel, dir: false, size,
              text: isTexty(e.name) });
          }
        }
        items.sort((a, b2) => a.dir === b2.dir ? a.name.localeCompare(b2.name) : a.dir ? -1 : 1);
        return ok(res, { root, path: rel, items });
      }

      if (p === '/api/files/search') {
        const root = q.get('root') || 'data';
        const term = (q.get('q') || '').trim();
        if (term.length < 2) return ok(res, { matches: [] });
        // Dibatasi pada folder yang sedang dibuka, bukan seluruh disk.
        const scope = q.get('base') || '';
        const base = safePath(scope, root);
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = [];
        async function scan(dir, rel, depth) {
          if (depth > 8 || matches.length >= 200) return;
          let ents = [];
          try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (matches.length >= 200) return;
            if (e.name.startsWith('.') && e.name !== '.env') continue;
            if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
            const childRel = rel ? rel + '/' + e.name : e.name;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await scan(full, childRel, depth + 1); continue; }
            if (!isTexty(e.name)) continue;
            try {
              const st = await fs.stat(full);
              if (st.size > 1024 * 1024) continue;
              const text = await fs.readFile(full, 'utf8');
              if (!rx.test(text)) { rx.lastIndex = 0; continue; }
              rx.lastIndex = 0;
              text.split('\n').forEach((line, i) => {
                if (matches.length >= 200) return;
                if (line.toLowerCase().includes(term.toLowerCase())) {
                  matches.push({ path: childRel, line: i + 1, text: line.trim().slice(0, 200) });
                }
              });
            } catch {}
          }
        }
        await scan(base, scope, 0);
        return ok(res, { matches, scope });
      }

      if (p === '/api/files/create' && req.method === 'POST') {
        const b = await readJson(req);
        const f = safePath(path.posix.join(b.path || '', b.name), b.root);
        await fs.mkdir(path.dirname(f), { recursive: true });
        try { await fs.access(f); return fail(res, 'File already exists', 409); } catch {}
        await fs.writeFile(f, b.content ?? '');
        await chownLikeParent(f);
        return ok(res);
      }

      // ---- Berkas ----
      if (p === '/api/files/list') {
        const dir = safePath(q.get('path') || '', q.get('root'));
        const ent = await fs.readdir(dir, { withFileTypes: true });
        const items = await Promise.all(ent.map(async (e) => {
          let st = null;
          try { st = await fs.stat(path.join(dir, e.name)); } catch {}
          return { name: e.name, dir: e.isDirectory(),
            size: st?.size || 0, mtime: st?.mtimeMs || 0 };
        }));
        items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        return ok(res, { path: q.get('path') || '', items });
      }
      if (p === '/api/files/read') {
        const f = safePath(q.get('path'), q.get('root'));
        const st = await fs.stat(f);
        if (st.size > 4 * 1024 * 1024) return fail(res, 'File too large to open', 413);
        return ok(res, { content: await fs.readFile(f, 'utf8') });
      }
      if (p === '/api/files/write' && req.method === 'POST') {
        const b = await readJson(req);
        const f = safePath(b.path, b.root);
        const isNew = await fs.access(f).then(() => false).catch(() => true);
        await fs.writeFile(f, b.content ?? '', 'utf8');
        if (isNew) await chownLikeParent(f);
        return ok(res);
      }
      if (p === '/api/files/download') {
        const f = safePath(q.get('path'), q.get('root'));
        const st = await fs.stat(f);
        res.writeHead(200, { 'Content-Type': mimeOf(f), 'Content-Length': st.size,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(f))}"` });
        return fsSync.createReadStream(f).pipe(res);
      }
      if (p === '/api/files/raw') {
        const f = safePath(q.get('path'), q.get('root'));
        const st = await fs.stat(f);
        // Range wajib buat pemutar <video>/<audio> — tanpa ini browser cuma
        // bisa mulai dari awal berkas dan tidak bisa loncat (seek).
        const range = req.headers.range;
        const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          const start = m[1] ? +m[1] : 0;
          const end = m[2] ? +m[2] : st.size - 1;
          if (isNaN(start) || isNaN(end) || start > end || end >= st.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
            return res.end();
          }
          res.writeHead(206, { 'Content-Type': mimeOf(f), 'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
          return fsSync.createReadStream(f, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': mimeOf(f), 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
        return fsSync.createReadStream(f).pipe(res);
      }
      if (p === '/api/files/thumb') {
        const f = safePath(q.get('path'), q.get('root'));
        const isVideo = THUMB_VIDEO_EXT.test(f);
        if (!isVideo && !THUMB_IMG_EXT.test(f)) return fail(res, 'Format tidak didukung buat thumbnail', 415);
        const st = await fs.stat(f);
        const size = Math.min(Math.max(+q.get('size') || 200, 40), 1600);
        const key = crypto.createHash('sha1')
          .update(`${f}|${st.mtimeMs}|${st.size}|${size}`).digest('hex');
        const cacheFile = path.join(THUMB_CACHE, `${key}.jpg`);
        const serve = async () => {
          const cst = await fs.stat(cacheFile);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': cst.size,
            'Cache-Control': 'public, max-age=604800' });
          return fsSync.createReadStream(cacheFile).pipe(res);
        };
        try { return await serve(); } catch {}
        const release = await thumbSlot();
        try {
          // Cek lagi setelah antre — job lain yang antre di depan kita
          // buat FILE & SIZE yang sama bisa saja sudah selesai duluan.
          try { return await serve(); } catch {}
          await fs.mkdir(THUMB_CACHE, { recursive: true });
          // nice+ionice idle: proses berat ini tidak boleh rebutan CPU/disk
          // sama panel sendiri atau container lain. taskset -c: kunci ke SATU
          // core fisik (lihat THUMB_CPU) — buat gambar, -limit thread 1 saja
          // di ImageMagick tidak cukup karena decoder HEIC punya thread pool
          // sendiri di luar kendali ImageMagick. taskset jadi jaring pengaman
          // keras (total CPU thumbnail tidak pernah lebih dari 1 core, apa
          // pun library yang dipakai/berapa pun thread yang dia buka sendiri).
          const prefix = ['-n', '15', 'ionice', '-c3', 'taskset', '-c', THUMB_CPU];
          if (isVideo) {
            // -ss SEBELUM -i: seek cepat ke keyframe terdekat tanpa decode
            // dari awal video — jauh lebih ringan buat file besar. 0.5 detik
            // buat lewatin kemungkinan frame hitam paling awal; kalau video
            // lebih pendek dari itu (percobaan pertama gagal), ulang dari
            // frame paling awal tanpa seek sama sekali.
            const args = (ss) => [...prefix, 'ffmpeg', '-v', 'error', ...(ss ? ['-ss', ss] : []),
              '-i', f, '-frames:v', '1', '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
              '-q:v', '4', '-y', cacheFile];
            try { await execFileP('nice', args('00:00:00.5'), { timeout: 30000 }); }
            catch { await execFileP('nice', args(null), { timeout: 30000 }); }
          } else {
            // [0]: ambil frame/halaman pertama saja (HEIC burst, GIF animasi,
            // PDF-alike). -thumbnail ...> : cuma perkecil, jangan pernah
            // perbesar file yang sudah lebih kecil dari ukuran diminta.
            await execFileP('nice', [...prefix, 'magick', '-limit', 'thread', '1', `${f}[0]`,
              '-auto-orient', '-thumbnail', `${size}x${size}>`, '-quality', '82', cacheFile],
              { timeout: 30000 });
          }
          return await serve();
        } catch (e) {
          console.error('[thumb]', f, e.message);
          return fail(res, 'Gagal membuat thumbnail', 500);
        } finally {
          release();
        }
      }
      if (p === '/api/files/upload' && req.method === 'POST') {
        const dest = safePath(path.posix.join(q.get('path') || '', q.get('name') || 'file'), q.get('root'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await readBody(req));
        await chownLikeParent(dest);
        return ok(res);
      }
      if (p === '/api/files/mkdir' && req.method === 'POST') {
        const b = await readJson(req);
        const dir = safePath(path.posix.join(b.path || '', b.name), b.root);
        await fs.mkdir(dir, { recursive: true });
        await chownLikeParent(dir);
        return ok(res);
      }
      if (p === '/api/files/rename' && req.method === 'POST') {
        const b = await readJson(req);
        await fs.rename(safePath(b.from, b.root), safePath(b.to, b.root));
        return ok(res);
      }
      if (p === '/api/files/delete' && req.method === 'POST') {
        const b = await readJson(req);
        await fs.rm(safePath(b.path, b.root), { recursive: true, force: true });
        return ok(res);
      }

      // ---- Basis data ----
      if (p === '/api/db/tables' && req.method === 'POST') {
        const b = await readJson(req);
        return ok(res, await dbQuery(b, LIST_TABLES[b.kind]));
      }
      if (p === '/api/db/query' && req.method === 'POST') {
        const b = await readJson(req);
        return ok(res, await dbQuery(b, b.sql, b.params || []));
      }
      if (p === '/api/db/rows' && req.method === 'POST') {
        const b = await readJson(req);
        const ident = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '');
        const t = b.kind === 'postgres'
          ? `"${ident(b.schema)}"."${ident(b.table)}"`
          : `\`${ident(b.schema)}\`.\`${ident(b.table)}\``;
        return ok(res, await dbQuery(b, `SELECT * FROM ${t} LIMIT ${Math.min(+b.limit || 100, 500)}`));
      }

      // ---- Pemantauan ----
      // Ringkasan status buat halaman publik (/status) — TANPA sesi. Cuma
      // nama, status up/down, dan uptime % (24 jam & 7 hari) buat check
      // yang ditandai public=true; URL/host internalnya TIDAK ikut
      // dikirim, biar ga bocor ke siapa pun yang buka halaman ini.
      if (p === '/api/status/public') {
        const pub = checks.filter((c) => c.public);
        return ok(res, {
          services: pub.map((c) => ({
            name: c.name, up: c.up !== false,
            w24: uptimeWindow(c.hist, 86400000),
            w7d: uptimeWindow(c.hist, 7 * 86400000),
          })),
          allUp: pub.every((c) => c.up !== false),
          updatedAt: Date.now(),
        });
      }
      if (p === '/api/monitor/checks') {
        if (req.method === 'GET') {
          return ok(res, { checks: checks.map(c => ({
            ...c,
            hist: (c.hist || []).slice(-120),
            w24: uptimeWindow(c.hist, 86400000),
            w7d: uptimeWindow(c.hist, 7 * 86400000),
            downSince: c.downSince || null,
            lastOutage: c.lastOutage || null,
          })) });
        }
        if (req.method === 'POST') {
          const b = await readJson(req);
          checks.push({ id: Date.now().toString(36), name: b.name, type: b.type || 'http',
            url: b.url, host: b.host, port: b.port, container: b.container, cmd: b.cmd,
            hist: [], public: false });
          saveChecks(); runChecks();
          return ok(res);
        }
      }
      if ((m = p.match(/^\/api\/monitor\/checks\/([^/]+)$/)) && req.method === 'DELETE') {
        checks = checks.filter((c) => c.id !== m[1]); saveChecks();
        return ok(res);
      }
      // Tampil/tidak di halaman status publik (/status) — opt-in per check,
      // biar URL/host internal ga kebuka ke publik kecuali sengaja dipilih.
      if ((m = p.match(/^\/api\/monitor\/checks\/([^/]+)\/public$/)) && req.method === 'POST') {
        const b = await readJson(req);
        const c = checks.find((x) => x.id === m[1]);
        if (!c) return fail(res, 'Check not found', 404);
        c.public = !!b.public;
        saveChecks();
        return ok(res);
      }

      return fail(res, 'Route not found', 404);
    }

    // ---------- Webhook auto-deploy ----------
    // Tidak butuh sesi: keamanannya dari token acak di dalam URL.
    if (p.startsWith('/hook/')) {
      // Hanya POST: dengan GET, sebuah <img> di situs lain bisa memicu deploy.
      if (req.method !== 'POST') return fail(res, 'POST required', 405);
      const token = p.slice(6);
      const name = stacks.stackByHook(token);
      if (!name) return fail(res, 'Unknown token', 404);
      ev.emit('deploy.webhook', `Push terdeteksi untuk stack <code>${name}</code>.`, { key: name });
      json(res, 202, { accepted: true, stack: name });
      (async () => {
        const lines = [];
        await stacks.gitPull(name, (l) => lines.push(l));
        const code = await stacks.deploy(name, (l) => lines.push(l));
        ev.emit(code === 0 ? 'deploy.success' : 'deploy.failed',
          `Auto-deploy <code>${name}</code>${code === 0 ? ' berhasil.' : ` gagal (kode ${code}).`}`,
          { key: name });
      })().catch(() => {});
      return;
    }

    // ---------- Halaman status publik ----------
    // Sengaja HTML statis + fetch client-side (bukan di-render server-side
    // dari sini) -- lebih gampang dijaga tampilannya tetap sinkron kalau
    // suatu saat mau diubah, dan otomatis kebaca ulang tiap 30 detik tanpa
    // reload manual.
    if (p === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:640px;margin:0 auto;padding:32px 20px;
    background:#0b0d10;color:#e6e8eb}
  h1{font-size:20px;margin:0 0 6px}
  .sub{color:#9aa0ac;font-size:13px;margin-bottom:24px}
  .banner{padding:14px 16px;border-radius:10px;margin-bottom:20px;font-weight:600;font-size:14px}
  .banner.ok{background:#0f2e1c;color:#4ade80}
  .banner.bad{background:#3a1414;color:#f87171}
  .row{display:flex;align-items:center;gap:10px;padding:14px 16px;border:1px solid #22262c;
    border-radius:10px;margin-bottom:8px}
  .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
  .dot.up{background:#4ade80}.dot.down{background:#f87171}
  .name{flex:1;font-size:14px}
  .pct{font-size:12.5px;color:#9aa0ac}
  .empty{color:#9aa0ac;font-size:13px;padding:20px 0;text-align:center}
  .footer{margin-top:24px;font-size:11.5px;color:#6b7280;text-align:center}
</style></head>
<body>
  <h1>Status Layanan</h1>
  <div class="sub" id="updated">Memuat…</div>
  <div id="banner"></div>
  <div id="list"></div>
  <div class="footer">Diperbarui otomatis tiap 30 detik</div>
<script>
async function load() {
  try {
    const d = await fetch('/api/status/public').then(x => x.json());
    document.getElementById('updated').textContent = 'Terakhir dicek: ' + new Date(d.updatedAt).toLocaleString('id-ID');
    const banner = document.getElementById('banner');
    const list = document.getElementById('list');
    if (!d.services.length) {
      banner.innerHTML = '';
      list.innerHTML = '<div class="empty">Belum ada layanan yang ditampilkan publik.</div>';
      return;
    }
    banner.innerHTML = '<div class="banner ' + (d.allUp ? 'ok' : 'bad') + '">'
      + (d.allUp ? '✓ Semua layanan normal' : '⚠ Ada layanan yang sedang bermasalah') + '</div>';
    list.innerHTML = d.services.map(function(s) {
      var pct = s.w7d ? s.w7d.pct + '% (7 hari)' : 'belum ada data';
      return '<div class="row"><div class="dot ' + (s.up ? 'up' : 'down') + '"></div>'
        + '<div class="name">' + s.name + '</div><div class="pct">' + pct + '</div></div>';
    }).join('');
  } catch (e) {
    document.getElementById('updated').textContent = 'Gagal memuat status.';
  }
}
load(); setInterval(load, 30000);
</script></body></html>`);
    }

    // ---------- Berkas statis ----------
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) return fail(res, 'Forbidden', 403);
    try {
      const st = await fs.stat(full);
      // Tanpa header cache sama sekali, browser sering nyimpen app.js/pages*.js
      // lama sendiri (heuristik) dan tetap jalanin kode LAMA walau server
      // sudah di-deploy ulang — fitur baru kelihatan "gak ada efeknya" padahal
      // kodenya sudah benar, cuma belum ke-fetch ulang. vendor/ (Monaco,
      // xterm — berat & jarang berubah) sengaja dikecualikan biar tetap
      // boleh di-cache seperti biasa.
      const isVendor = full.startsWith(path.join(PUBLIC, 'vendor') + path.sep);
      res.writeHead(200, { 'Content-Type': mimeOf(full) + (mimeOf(full).startsWith('text') ? '; charset=utf-8' : ''),
        'Content-Length': st.size, ...(isVendor ? {} : { 'Cache-Control': 'no-store' }) });
      return fsSync.createReadStream(full).pipe(res);
    } catch {
      const idx = path.join(PUBLIC, 'index.html');
      const b = await fs.readFile(idx);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(b);
    }
  } catch (e) {
    return fail(res, e, e.status || 500);
  }
};

// Server kedua, port TERPISAH, cuma dibuka ke localhost (lihat deploy
// docker-compose.yml: "127.0.0.1:8091:8081") — SATU-SATUNYA yang boleh
// menjangkau port ini adalah cloudflared di laptop yang sama (config.yml
// tunnel.js mengarah ke sini, bukan ke port LAN 8090). Karena itu, koneksi
// yang datang lewat port ini (dicek dari req.socket.localPort) dijamin
// beneran lewat Cloudflare Tunnel — headernya (CF-Connecting-IP) baru
// dipercaya kalau lewat sini. Perangkat lain di LAN sama sekali tidak bisa
// menjangkau port ini walau tahu nomornya, karena publish-nya cuma ke
// 127.0.0.1 di level Docker/host, bukan cuma soal firewall.
const server = http.createServer(requestHandler);
const tunnelServer = http.createServer(requestHandler);

// ── Terminal web (WebSocket) ────────────────────────────────────────────────
// Dua mode: shell di host (lewat nsenter ke PID 1) dan shell di dalam
// container (lewat Docker exec). Keduanya butuh sesi yang sah.
const upgradeHandler = async (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/ws/term')) { socket.destroy(); return; }

  // Tolak upgrade dari halaman lain: tanpa ini sebuah situs berbahaya bisa
  // membuka WebSocket ke panel memakai cookie sesi yang sudah ada dan
  // mendapatkan terminal host.
  const origin = req.headers.origin;
  if (origin) {
    let okOrigin = false;
    try {
      const o = new URL(origin);
      okOrigin = o.host === req.headers.host;
    } catch {}
    if (!okOrigin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  }

  const cookie = req.headers.cookie || '';
  const mm = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  const ses = mm ? auth.getSession(decodeURIComponent(mm[1])) : null;
  if (!ses) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  // Ini satu-satunya jalur WebSocket di panel, jadi TIDAK lewat pemeriksaan
  // AREA yang menjaga endpoint /api/* biasa — sebelumnya cuma dicek "sudah
  // login", tanpa cek izin halaman sama sekali. Shell akar laptop bukan
  // sesuatu yang boleh didapat siapa pun yang login (apalagi viewer, yang
  // seharusnya baca-saja) — dicek eksplisit di sini.
  // Tiga halaman ini masing-masing punya terminal tertanam sendiri
  // (Terminal, Code Editor, dan log Deploy di Stacks buat betulin
  // docker-compose.yml yang gagal) — editor & stacks memang sudah
  // menyiratkan kendali level host lewat baca/tulis berkas & deploy
  // compose apa pun, jadi wajar juga dapat shell dari situ.
  const canTerm = auth.canPage(ses, 'terminal') || auth.canPage(ses, 'editor')
    || auth.canPage(ses, 'stacks');
  if (!canTerm || !auth.canWrite(ses)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
  const target = u.searchParams.get('container');
  auth.audit(ses.username, 'terminal', target || 'host');
  ev.emit('sec.terminal_opened',
    `<b>${ses.username}</b> membuka terminal ${target ? 'container ' + target : 'host'}.`);

  if (target) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(target)) {
      ws.send('\r\n\x1b[31mInvalid container id\x1b[0m\r\n'); ws.close(); return;
    }
    (async () => {
      try {
        // Hanya dua shell yang diizinkan; nilai ini menjadi argv perintah exec.
        const want = u.searchParams.get('shell') || 'sh';
        const shell = ['sh', 'bash'].includes(want) ? want : 'sh';
        const ex = await dockerExtra.execCreate(target, [shell]);
        const sock = await dockerExtra.execStart(ex.Id);
        sock.on('data', (d) => ws.send(d));
        sock.on('close', () => ws.close());
        ws.on('message', (b) => {
          const t = b.toString();
          if (t.startsWith('\x00resize:')) {
            const [h, w] = t.slice(8).split(',').map(Number);
            dockerExtra.execResize(ex.Id, h, w).catch(() => {});
            return;
          }
          try { sock.write(b); } catch {}
        });
        ws.on('close', () => { try { sock.destroy(); } catch {} });
        ws.send(`\r\n\x1b[90m— terhubung ke ${target} —\x1b[0m\r\n`);
      } catch (e) {
        ws.send(`\r\n\x1b[31mGagal membuka terminal: ${e.message}\x1b[0m\r\n`);
        ws.close();
      }
    })();
    return;
  }

  // Shell host: masuk ke namespace PID 1 supaya benar-benar di mesin, bukan container.
  // Pakai node-pty (bukan spawn+'script' seperti sebelumnya) supaya shell dapat
  // PTY sungguhan yang BISA di-resize (ioctl TIOCSWINSZ) — sebelumnya pesan
  // resize dari browser cuma dibuang (lihat git blame), jadi program yang
  // gambar UI-nya sendiri berdasar ukuran layar (less, vim, htop, CLI kayak
  // claude/codex) selalu mengira terminalnya 80x24 default, kepotong di
  // pojok kiri-atas walau kotak terminal di browser sudah besar.
  try {
    // Kalau dibuka dari Code Editor dengan folder project aktif, masuk
    // langsung ke folder itu — kayak terminal terpadu VS Code. Path lewat
    // env var (PANEL_CWD), bukan ditempel langsung ke command, supaya tidak
    // ada celah shell-injection dari nama folder yang aneh-aneh.
    const cwdReq = u.searchParams.get('cwd') || '';
    // Terminal ini jalan sebagai root (lewat nsenter), jadi PATH bawaannya
    // cuma binari sistem — tool yang di-install per-user (npm/pip/pipx
    // --user, misalnya CLI seperti claude/codex) taruh di ~/.local/bin milik
    // user itu, bukan kebaca root. Tambahkan semua folder itu ke PATH dulu.
    const shCmd = 'for d in /home/*/.local/bin /root/.local/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done; export PATH; '
      + '[ -n "$PANEL_CWD" ] && cd "$PANEL_CWD" 2>/dev/null; '
      // Prompt polos "# " tanpa nama folder bikin susah tahu 'cd' beneran
      // pindah atau tidak. Pakai bash biar prompt-nya bisa nunjukin folder
      // sekarang (\\w) dan ter-update tiap kali pindah folder.
      + 'export PS1="\\w # "; '
      + 'exec bash --norc --noprofile -i';
    const term = pty.spawn('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', '--', 'sh', '-c', shCmd], {
      name: 'xterm-256color', cols: 80, rows: 24,
      // TERM wajib diset — tanpa ini perintah yang baca terminfo (clear,
      // less, vim, dst) gagal dengan "TERM environment variable not set".
      env: { ...process.env, TERM: 'xterm-256color', PANEL_CWD: cwdReq },
    });
    term.onData((d) => { try { ws.send(d); } catch {} });
    term.onExit(() => { try { ws.close(); } catch {} });
    ws.on('message', (b) => {
      const t = b.toString();
      if (t.startsWith('\x00resize:')) {
        const [rows, cols] = t.slice(8).split(',').map(Number);
        if (rows > 0 && cols > 0) { try { term.resize(cols, rows); } catch {} }
        return;
      }
      try { term.write(t); } catch {}
    });
    ws.on('close', () => { try { term.kill(); } catch {} });
    ws.send('\r\n\x1b[90m— shell host —\x1b[0m\r\n');
  } catch (e) {
    ws.send(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); ws.close();
  }
  });
};
server.on('upgrade', upgradeHandler);
tunnelServer.on('upgrade', upgradeHandler);

dbaas.ensureNetwork().catch(() => {});

admin.startScheduler((t, m) => ev.emit('cron.failed', m));

// Deteksi server baru menyala (uptime kecil saat panel start).
setTimeout(async () => {
  try { const u = await sys.uptime();
    if (u < 600) ev.emit('system.back_online', `Server menyala. Uptime ${Math.round(u)} seconds.`);
  } catch {}
}, 8000);

server.listen(PORT, () => {
  console.log(`[panel] siap di :${PORT}  data=${DATA_ROOT}  state=${STATE_DIR}`);
  if (tgToken() && tgChat()) notify('Panel menyala', 'Panel home server sudah aktif.');
});
tunnelServer.listen(TUNNEL_PORT, () => {
  console.log(`[panel] jalur tunnel siap di :${TUNNEL_PORT} (cuma buat cloudflared)`);
});
