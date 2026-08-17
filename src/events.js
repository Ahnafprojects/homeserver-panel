// Pusat kejadian: satu pintu untuk semua notifikasi.
//
// Aturannya sederhana dan disengaja:
//   urgent -> Telegram DAN pusat notifikasi web
//   info   -> pusat notifikasi web saja
//
// Alasannya: notifikasi yang terlalu sering akhirnya diabaikan. Telegram
// hanya untuk hal yang perlu tindakan walau sedang tidak buka dashboard.
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'events.json');
const MAX = 2000;

let events = [];
try { events = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(events.slice(-MAX))); } catch {}
}, 5000);

/* Katalog kejadian: kategori, tingkat bawaan, dan label Indonesia.
   'urgent' = ikut ke Telegram. 'info' = hanya di web.               */
export const CATALOG = {
  // ── Sistem ──
  'system.disk_full':        { c: 'system', s: 'urgent', t: 'Disk almost full' },
  'system.temp_high':        { c: 'system', s: 'urgent', t: 'High CPU temperature' },
  'system.reboot_detected':  { c: 'system', s: 'urgent', t: 'Server rebooted' },
  'system.back_online':      { c: 'system', s: 'urgent', t: 'Server back online' },
  'system.internet_down':    { c: 'system', s: 'urgent', t: 'Internet connection lost' },
  'system.internet_up':      { c: 'system', s: 'urgent', t: 'Internet connection restored' },
  'system.cpu_high':         { c: 'system', s: 'info',   t: 'High CPU usage' },
  'system.ram_high':         { c: 'system', s: 'info',   t: 'High memory usage' },
  'system.load_high':        { c: 'system', s: 'info',   t: 'Abnormal system load' },
  'system.swap_high':        { c: 'system', s: 'info',   t: 'High swap usage' },
  'system.recovered':        { c: 'system', s: 'info',   t: 'Back to normal' },

  // ── Container ──
  'container.crash':         { c: 'container', s: 'urgent', t: 'Container crashed' },
  'container.restart_loop':  { c: 'container', s: 'urgent', t: 'Container restart loop' },
  'container.auto_restart':  { c: 'container', s: 'info',   t: 'Container auto-restarted' },
  'container.over_limit':    { c: 'container', s: 'info',   t: 'Container over resource limit' },
  'container.image_ready':   { c: 'container', s: 'info',   t: 'Image pulled' },
  'container.disk_growing':  { c: 'container', s: 'info',   t: 'Docker disk usage growing' },
  'container.buildcache_cleaned': { c: 'container', s: 'info', t: 'Build cache cleaned automatically' },
  'container.autoscale_up':  { c: 'container', s: 'urgent', t: 'Replica scaled up (RAM near limit)' },
  'container.autoscale_down':{ c: 'container', s: 'info',   t: 'Replica scaled down (idle)' },
  'container.anomaly':       { c: 'container', s: 'info',   t: 'Unusual resource spike detected' },

  // ── Deploy ──
  'deploy.failed':           { c: 'deploy', s: 'urgent', t: 'Deploy failed' },
  'deploy.build_failed':     { c: 'deploy', s: 'urgent', t: 'Build failed' },
  'deploy.started':          { c: 'deploy', s: 'info',   t: 'Deploy started' },
  'deploy.success':          { c: 'deploy', s: 'info',   t: 'Deploy succeeded' },
  'deploy.webhook':          { c: 'deploy', s: 'info',   t: 'New push detected' },
  'deploy.rollback':         { c: 'deploy', s: 'info',   t: 'Rollback performed' },
  'deploy.preview_cleaned':  { c: 'deploy', s: 'info',   t: 'Preview environment removed automatically' },

  // ── Ketersediaan ──
  'uptime.down':             { c: 'uptime', s: 'urgent', t: 'Service is down' },
  'uptime.up':               { c: 'uptime', s: 'urgent', t: 'Service recovered' },
  'uptime.ssl_expiring':     { c: 'uptime', s: 'urgent', t: 'SSL certificate expiring soon' },
  'uptime.slow':             { c: 'uptime', s: 'info',   t: 'Response time degraded' },
  'uptime.ssl_renewed':      { c: 'uptime', s: 'info',   t: 'SSL certificate renewed' },

  // ── Basis data ──
  'db.connect_failed':       { c: 'database', s: 'urgent', t: 'Database connection failed' },
  'db.backup_failed':        { c: 'database', s: 'urgent', t: 'Database backup failed' },
  'db.slow_query':           { c: 'database', s: 'info',   t: 'Slow query' },
  'db.backup_started':       { c: 'database', s: 'info',   t: 'Database backup started' },
  'db.backup_ok':            { c: 'database', s: 'info',   t: 'Database backup finished' },
  'db.restored':             { c: 'database', s: 'info',   t: 'Database restored' },
  'db.storage_high':         { c: 'database', s: 'info',   t: 'Database storage running low' },

  // ── Keamanan ──
  'sec.bruteforce':          { c: 'security', s: 'urgent', t: 'Repeated failed logins' },
  'sec.ip_blocked':          { c: 'security', s: 'urgent', t: 'IP blocked automatically' },
  'sec.new_device':          { c: 'security', s: 'urgent', t: 'Sign-in from a new device' },
  'sec.terminal_opened':     { c: 'security', s: 'urgent', t: 'Web terminal opened' },
  'sec.credential_changed':  { c: 'security', s: 'urgent', t: 'Password or 2FA changed' },
  'sec.login_ok':            { c: 'security', s: 'info',   t: 'Successful sign-in' },
  'sec.firewall_changed':    { c: 'security', s: 'info',   t: 'Firewall rule changed' },
  'sec.port_opened':         { c: 'security', s: 'info',   t: 'Port opened publicly' },
  'sec.secret_viewed':       { c: 'security', s: 'info',   t: 'Secret value revealed' },

  // ── Cadangan ──
  'backup.failed':           { c: 'backup', s: 'urgent', t: 'Scheduled backup failed' },
  'backup.repeated_failure': { c: 'backup', s: 'urgent', t: 'Backup failed 3 times in a row' },
  'backup.storage_error':    { c: 'backup', s: 'urgent', t: 'Backup storage problem' },
  'backup.started':          { c: 'backup', s: 'info',   t: 'Backup started' },
  'backup.ok':               { c: 'backup', s: 'info',   t: 'Backup finished' },
  'backup.config_export':    { c: 'backup', s: 'info',   t: 'Config exported' },

  // ── Penjadwal ──
  'cron.failed':             { c: 'cron', s: 'urgent', t: 'Scheduled job failed' },
  'cron.ok':                 { c: 'cron', s: 'info',   t: 'Scheduled job finished' },

  // ── Jaringan & domain ──
  'net.abnormal_traffic':    { c: 'network', s: 'urgent', t: 'Abnormal request spike' },
  'domain.added':            { c: 'domain', s: 'info',   t: 'Domain added' },
  'domain.dns_failed':       { c: 'domain', s: 'info',   t: 'DNS propagation failed' },
};

export const CATEGORIES = {
  system: 'System', container: 'Container', deploy: 'Deploy', uptime: 'Uptime',
  database: 'Database', security: 'Security', backup: 'Backup', cron: 'Scheduler',
  network: 'Network', domain: 'Domain',
};

/* Setelan per-jenis: pengguna bisa menaikkan/menurunkan tingkat. */
const CFG = path.join(STATE, 'events-config.json');
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {}
export const getOverrides = () => overrides;
export function setOverride(type, severity) {
  if (!CATALOG[type]) throw new Error('Unknown event type');
  if (!['urgent', 'info', 'off'].includes(severity)) throw new Error('Invalid severity');
  overrides[type] = severity;
  try { fs.writeFileSync(CFG, JSON.stringify(overrides, null, 2)); } catch {}
}
export const severityOf = (type) => overrides[type] || CATALOG[type]?.s || 'info';

/* Peredam: kejadian sama tidak dikirim ulang dalam jendela waktu. */
const lastSent = new Map();
const DEDUPE_MS = 10 * 60 * 1000;

let sendTelegram = null;
export const setTelegramSender = (fn) => { sendTelegram = fn; };
let sendPush = null;
export const setPushSender = (fn) => { sendPush = fn; };
let sendEmail = null;
export const setEmailSender = (fn) => { sendEmail = fn; };

/* Pesan kejadian ditampilkan sebagai HTML agar <b> dan <code> terbaca rapi.
   Karena sebagian isinya berasal dari luar (nama container, header IP),
   semua tag selain daftar aman di bawah ini dilucuti. Tanpa ini, penyerang
   bisa menitipkan <img onerror=...> lewat header X-Forwarded-For dan
   skripnya berjalan di peramban admin. */
const ALLOWED_TAGS = /^<\/?(b|i|code|em|strong)>$/i;
function sanitize(html) {
  return String(html).replace(/<[^>]*>?/g, (tag) => ALLOWED_TAGS.test(tag) ? tag : '');
}

export function emit(type, message = '', meta = {}) {
  message = sanitize(message);
  const def = CATALOG[type];
  if (!def) return null;
  const sev = severityOf(type);
  if (sev === 'off') return null;

  const ev = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    t: Date.now(), type, cat: def.c, sev, title: def.t, message, meta, read: false };
  events.push(ev);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  dirty = true;

  if (sev === 'urgent' && sendTelegram) {
    const key = type + '|' + (meta.key || message).slice(0, 60);
    const last = lastSent.get(key) || 0;
    if (Date.now() - last > DEDUPE_MS) {
      lastSent.set(key, Date.now());
      sendTelegram(def.t, message);
      sendPush?.(def.t, message.replace(/<[^>]*>/g, ''));
      sendEmail?.(def.t, message);
    }
  }
  return ev;
}

export function list({ cat, sev, unread, limit = 200 } = {}) {
  let out = events;
  if (cat) out = out.filter(e => e.cat === cat);
  if (sev) out = out.filter(e => e.sev === sev);
  if (unread) out = out.filter(e => !e.read);
  return out.slice(-limit).reverse();
}
export const unreadCount = () => events.filter(e => !e.read).length;
export function markRead(ids) {
  const set = ids ? new Set(ids) : null;
  events.forEach(e => { if (!set || set.has(e.id)) e.read = true; });
  dirty = true;
}
export function clearAll() { events = []; dirty = true; }
/* Selain batas JUMLAH (MAX=2000 di atas), potong juga yang lebih tua dari
   N hari -- kejadian ramai (mis. banyak deploy sehari) bisa nutupin batas
   jumlah dalam hitungan hari, sementara kejadian sepi bisa nyimpen entri
   berbulan-bulan yang udah gak relevan lagi. */
export function pruneOld(days = 30) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const before = events.length;
  events = events.filter((e) => e.t >= cutoff);
  if (events.length !== before) dirty = true;
  return { kept: events.length, dropped: before - events.length };
}
export function stats() {
  const byCat = {};
  for (const e of events) byCat[e.cat] = (byCat[e.cat] || 0) + 1;
  return { total: events.length, unread: unreadCount(), byCat,
    urgent: events.filter(e => e.sev === 'urgent').length };
}
