// Autentikasi: kata sandi, TOTP, sesi, pembatasan percobaan, jejak audit.
// Tanpa dependency luar — semua pakai modul crypto bawaan Node.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.STATE_DIR || '/state';
const F_USERS = path.join(STATE, 'users.json');
const F_AUDIT = path.join(STATE, 'audit.log');

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch {} };

let users = load(F_USERS, []);
// Migrasi peran lama: 'member' dihapus dan menjadi 'admin'.
if (users.some(u => u.role === 'member')) {
  users.forEach(u => { if (u.role === 'member') u.role = 'admin'; });
  save(F_USERS, users);
}
// Migrasi dari skema lama: 'admin' penuh menjadi 'superadmin'.
if (users.length && !users.some(u => u.role === 'superadmin')) {
  const first = users.find(u => u.role === 'admin') || users[0];
  if (first) { first.role = 'superadmin'; first.perms = null; save(F_USERS, users); }
}

/* ── Kata sandi ────────────────────────────────────────────────────────────
   scrypt dipakai, bukan bcrypt/argon2, karena sudah ada di dalam Node —
   tidak perlu paket tambahan yang harus dikompilasi di CPU lambat.
   Kekuatannya setara: sama-sama lambat secara sengaja dan tahan GPU.      */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length,
      { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}

/* ── TOTP (2FA) ─────────────────────────────────────────────────────────── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() {
  const b = crypto.randomBytes(20);
  let out = '';
  for (const x of b) out += B32[x % 32];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpCode(secret, t = Date.now()) {
  const counter = Math.floor(t / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
export function totpVerify(secret, code) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return false;
  // Toleransi ±1 langkah (30 detik) untuk jam yang sedikit meleset.
  for (const d of [-1, 0, 1]) {
    if (totpCode(secret, Date.now() + d * 30000) === String(code).trim()) return true;
  }
  return false;
}
export const totpUri = (secret, user, issuer = 'Home Server') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;

/* ── Pengguna ──────────────────────────────────────────────────────────── */
/* Halaman yang bisa diatur per pengguna. 'admin' selalu dapat semuanya. */
/* Tiga peran saja, sengaja:
     superadmin — akses penuh ke semuanya, termasuk mengelola pengguna
     admin      — hanya halaman yang dicentang, boleh mengubah di sana
     viewer     — hanya halaman yang dicentang, dan hanya bisa melihat  */
export const ROLES = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  viewer: 'Viewer',
};
export const ROLE_HELP = {
  superadmin: 'Full access to everything, including user management.',
  admin: 'Only the ticked pages, and may make changes there.',
  viewer: 'Only the ticked pages, read-only — cannot change anything.',
};
export const isSuper = (u) => (u?.role || u) === 'superadmin';
/* Viewer tidak boleh mengubah apa pun. */
export function canWrite(ses) {
  return !!ses && ses.role !== 'viewer';
}

export const PAGES = {
  // Urutannya sengaja sama dengan menu, supaya daftar centang mudah dibaca.
  overview: 'Overview',
  events: 'Notifications',
  monitor: 'Uptime',
  assistant: 'AI Assistant',
  stacks: 'Stacks & Deploy',
  containers: 'Containers',
  logs: 'Logs',
  editor: 'Code Editor',
  files: 'Files',
  database: 'Databases',
  domains: 'Domains & SSL',
  jobs: 'Scheduler',
  vault: 'Vault & Backups',
  terminal: 'Terminal',
  resources: 'Resources',
  system: 'System',
  settings: 'Settings',
};

export const listUsers = () => users.map(u => ({
  id: u.id, username: u.username, role: u.role,
  totp: !!u.totpSecret, created: u.created, lastLogin: u.lastLogin || null,
  perms: u.perms || null,
}));

/* Izin: admin bebas, selain itu dibatasi daftar halaman & sumber daya. */
export function permsOf(username) {
  const u = users.find(x => x.username === username);
  if (!u) return { pages: [], dbs: [], stacks: [] };
  if (u.role === 'superadmin') return { all: true, pages: Object.keys(PAGES), dbs: '*', stacks: '*' };
  return { all: false, pages: u.perms?.pages || [], dbs: u.perms?.dbs || [],
    stacks: u.perms?.stacks || [] };
}
export function canPage(ses, page) {
  if (!ses) return false;
  const p = permsOf(ses.username);
  return p.all || p.pages.includes(page);
}
export function canDb(ses, id) {
  const p = permsOf(ses.username);
  return p.all || p.dbs === '*' || (Array.isArray(p.dbs) && p.dbs.includes(id));
}
export function canStack(ses, name) {
  const p = permsOf(ses.username);
  return p.all || p.stacks === '*' || (Array.isArray(p.stacks) && p.stacks.includes(name));
}
export const userCount = () => users.length;
export const findUser = (n) => users.find(u => u.username === n);

export function createUser({ username, password, role = 'viewer' }) {
  if (!ROLES[role]) throw new Error('Unknown role');
  // Pengguna pertama selalu super admin, kalau tidak panel jadi tidak bisa diurus.
  if (users.length === 0) role = 'superadmin';
  if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw new Error('Invalid username');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (findUser(username)) throw new Error('Username already taken');
  const u = { id: crypto.randomUUID(), username, role,
    pass: hashPassword(password), created: Date.now(),
    // Anggota tim baru tidak dapat apa-apa sampai diberi izin eksplisit.
    perms: role === 'superadmin' ? null : { pages: ['overview'], dbs: [], stacks: [] } };
  users.push(u); save(F_USERS, users);
  return { id: u.id, username, role };
}
export function updateUser(id, patch) {
  const u = users.find(x => x.id === id);
  if (!u) throw new Error('User not found');
  if (patch.password) {
    if (patch.password.length < 8) throw new Error('Password must be at least 8 characters');
    u.pass = hashPassword(patch.password);
  }
  if (patch.role && patch.role !== u.role) {
    if (!ROLES[patch.role]) throw new Error('Unknown role');
    if (u.role === 'superadmin' && patch.role !== 'superadmin') {
      const supers = users.filter(x => x.role === 'superadmin').length;
      if (supers <= 1) throw new Error('At least one Super Admin is required');
    }
    u.role = patch.role;
    // Naik ke super admin berarti izin per-halaman tidak dipakai lagi.
    if (patch.role === 'superadmin') u.perms = null;
    else if (!u.perms) u.perms = { pages: ['overview'], dbs: [], stacks: [] };
  }
  if (patch.totpSecret !== undefined) u.totpSecret = patch.totpSecret;
  if (patch.perms !== undefined) u.perms = patch.perms;
  save(F_USERS, users);
  return true;
}
export function deleteUser(id) {
  if (users.length <= 1) throw new Error('Cannot delete the last user');
  const u = users.find(x => x.id === id);
  if (u?.role === 'superadmin' && users.filter(x => x.role === 'superadmin').length <= 1) {
    throw new Error('At least one Super Admin is required');
  }
  users = users.filter(u => u.id !== id); save(F_USERS, users);
}

/* ── Sesi ──────────────────────────────────────────────────────────────── */
const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;

export function newSession(user, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { uid: user.id, username: user.username, role: user.role,
    ip, at: Date.now(), seen: Date.now() });
  user.lastLogin = Date.now(); save(F_USERS, users);
  return token;
}
export function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.seen > SESSION_TTL) { sessions.delete(token); return null; }
  s.seen = Date.now();
  return s;
}
export const dropSession = (t) => sessions.delete(t);
export const listSessions = () => [...sessions.entries()].map(([t, s]) => ({
  id: t.slice(0, 8), username: s.username, ip: s.ip, at: s.at, seen: s.seen }));
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.seen > SESSION_TTL) sessions.delete(t);
}, 600000);

/* ── Pembatasan percobaan masuk ────────────────────────────────────────── */
const attempts = new Map();
const MAX_TRY = 5, WINDOW = 10 * 60 * 1000, BAN = 15 * 60 * 1000;

export function checkRate(ip) {
  const a = attempts.get(ip);
  if (!a) return { allowed: true };
  if (a.bannedUntil && Date.now() < a.bannedUntil) {
    return { allowed: false, retryIn: Math.ceil((a.bannedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}
export function noteFail(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > WINDOW) a = { first: now, n: 0 };
  a.n++;
  if (a.n >= MAX_TRY) { a.bannedUntil = now + BAN; a.n = 0; }
  attempts.set(ip, a);
  return a.bannedUntil ? Math.ceil(BAN / 1000) : MAX_TRY - a.n;
}
export const noteOk = (ip) => attempts.delete(ip);
export const listBans = () => [...attempts.entries()]
  .filter(([, a]) => a.bannedUntil && a.bannedUntil > Date.now())
  .map(([ip, a]) => ({ ip, until: a.bannedUntil }));

/* ── Jejak audit ───────────────────────────────────────────────────────── */
export function audit(user, action, detail = '') {
  const line = JSON.stringify({ t: Date.now(), user, action, detail });
  try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(F_AUDIT, line + '\n'); } catch {}
}
export function readAudit(limit = 300) {
  try {
    const lines = fs.readFileSync(F_AUDIT, 'utf8').trim().split('\n');
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
/* Audit log ditulis TERUS-MENERUS (append), gak pernah dibersihin sendiri --
   dibiarkan bisa numpuk selamanya. Potong entri lebih tua dari N hari. */
export function pruneAudit(days = 90) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let lines = [];
  try { lines = fs.readFileSync(F_AUDIT, 'utf8').trim().split('\n').filter(Boolean); } catch { return { kept: 0, dropped: 0 }; }
  const kept = lines.filter((l) => { try { return JSON.parse(l).t >= cutoff; } catch { return false; } });
  if (kept.length === lines.length) return { kept: kept.length, dropped: 0 };
  try { fs.writeFileSync(F_AUDIT, kept.length ? kept.join('\n') + '\n' : ''); } catch {}
  return { kept: kept.length, dropped: lines.length - kept.length };
}
