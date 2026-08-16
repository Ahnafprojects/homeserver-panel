// Token API — buat script/CI eksternal manggil API panel tanpa perlu login
// browser (cookie sesi). Beda dari password: token ini high-entropy acak
// (bukan sesuatu yang manusia ngetik & inget), jadi cukup di-hash pakai
// SHA-256 biasa (cepat) — bukan scrypt yang sengaja lambat buat nahan
// brute-force password manusia (token 256-bit gak akan pernah kena
// brute-force apapun algoritma hash-nya).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'api-tokens.json');
const PREFIX = 'hsp_'; // "home server panel" -- biar gampang dikenali di log/history shell

let tokens = [];
try { tokens = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(tokens, null, 2)); } catch {} };

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

/* Balikin token MENTAHnya cuma sekali di sini — sesudah ini cuma hash-nya
   yang disimpan, gak bisa diambil ulang lewat list(). */
export function create(username, label) {
  const raw = PREFIX + crypto.randomBytes(32).toString('base64url');
  const rec = { id: crypto.randomBytes(6).toString('hex'), label: String(label || 'Token').slice(0, 80),
    username, hash: hash(raw), created: Date.now(), lastUsed: null };
  tokens.push(rec);
  save();
  return { ...rec, hash: undefined, token: raw };
}

export function verify(raw) {
  if (!raw || !raw.startsWith(PREFIX)) return null;
  const rec = tokens.find((t) => t.hash === hash(raw));
  if (!rec) return null;
  rec.lastUsed = Date.now();
  save(); // lastUsed ke-update tiap dipakai -- ok buat token (jarang dipanggil dibanding session), bukan tiap request UI biasa
  return rec;
}

export const list = (username) => tokens
  .filter((t) => t.username === username)
  .map((t) => ({ id: t.id, label: t.label, created: t.created, lastUsed: t.lastUsed }));

export function revoke(username, id) {
  const before = tokens.length;
  tokens = tokens.filter((t) => !(t.id === id && t.username === username));
  save();
  return tokens.length < before;
}
