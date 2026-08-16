// Koneksi Google Drive lewat OAuth, dikelola dari panel sendiri (Vault &
// Backups) — bukan setup CLI manual kayak sebelumnya. Bisa nyambungin
// BEBERAPA akun sekaligus (kuota gratis cuma 15 GB per akun, jadi kalau satu
// mepet bisa nambah akun lain, atau backup otomatis pindah ke yang masih
// longgar — lihat pickAccount()).
//
// Sengaja tanpa library googleapis — cuma fetch biasa ke endpoint OAuth
// Google, sama seperti pola "hand-roll" yang sudah dipakai di modul lain
// (auth.js, dbapi.js). Scope dibatasi "drive.file" (bukan "drive" penuh):
// app ini cuma bisa lihat/kelola file yang DIA SENDIRI buat, bukan seluruh
// Drive pengguna — prinsip least-privilege buat token yang bakal disimpan
// jangka panjang di server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as admin from './admin.js';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'gdrive-accounts.json');
const CLIENT_ID = process.env.GDRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GDRIVE_REDIRECT_URI
  || `https://www.${process.env.TUNNEL_DOMAIN || 'ahnaf.cloud'}/api/gdrive/oauth/callback`;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';

export const configured = () => !!(CLIENT_ID && CLIENT_SECRET);

let accounts = [];
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    accounts = raw.map(a => ({ ...a, token: JSON.parse(admin.decrypt(a.token)) }));
  } catch { accounts = []; }
}
function persist() {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    const raw = accounts.map(a => ({ ...a, token: admin.encrypt(JSON.stringify(a.token)) }));
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 2));
  } catch {}
}
load();

export function authUrl(state) {
  if (!configured()) throw new Error('GDRIVE_CLIENT_ID/GDRIVE_CLIENT_SECRET belum diset');
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPES, access_type: 'offline',
    // "consent" dipaksa terus supaya refresh_token SELALU ikut dikirim —
    // tanpa ini, Google cuma ngasih refresh_token pas otorisasi PERTAMA
    // kali; kalau user connect ulang akun yang sama, field itu bisa kosong.
    prompt: 'consent', state: state || '',
  });
  return `${AUTH_URL}?${params}`;
}

export async function handleCallback(code) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
  });
  const tok = await r.json();
  if (!r.ok) throw new Error(tok.error_description || tok.error || 'Tukar kode OAuth gagal');
  if (!tok.refresh_token) {
    throw new Error('Google tidak mengirim refresh_token — coba disconnect akses app ini di '
      + 'myaccount.google.com/permissions lalu connect ulang.');
  }
  const token = { access_token: tok.access_token, refresh_token: tok.refresh_token,
    expiry: Date.now() + (tok.expires_in * 1000) };
  let email = 'unknown';
  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${token.access_token}` } }).then(x => x.json());
    email = info.email || email;
  } catch {}
  // Akun yang sama di-connect ulang (mis. refresh_token kadaluarsa) —
  // timpa entry lama berdasarkan email, jangan dobel di daftar.
  accounts = accounts.filter(a => a.email !== email);
  const acc = { id: crypto.randomBytes(4).toString('hex'), email, token, added: Date.now() };
  accounts.push(acc);
  persist();
  return acc;
}

async function ensureFreshToken(acc) {
  if (acc.token.expiry > Date.now() + 60000) return acc.token.access_token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: acc.token.refresh_token, grant_type: 'refresh_token' }),
  });
  const tok = await r.json();
  if (!r.ok) throw new Error(tok.error_description || tok.error || 'Refresh token gagal — mungkin akses dicabut dari sisi Google');
  acc.token.access_token = tok.access_token;
  acc.token.expiry = Date.now() + (tok.expires_in * 1000);
  persist();
  return acc.token.access_token;
}

export async function quotaOf(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) throw new Error('Account not found');
  const tok = await ensureFreshToken(acc);
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota',
    { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Gagal ambil kuota');
  const total = j.storageQuota?.limit ? +j.storageQuota.limit : null; // null = unlimited (Workspace)
  const used = +(j.storageQuota?.usage || 0);
  return { total, used, percent: total ? Math.round((used / total) * 100) : 0 };
}

export function listAccounts() {
  return accounts.map(a => ({ id: a.id, email: a.email, added: a.added }));
}
export function removeAccount(id) {
  accounts = accounts.filter(a => a.id !== id);
  persist();
}

/* Tulis SEMUA akun tersambung jadi remote rclone terpisah ("panel-<id>"),
   dipakai backup script buat sync — lihat pickAccount() di bawah buat
   milih yang mana yang dipakai (masih longgar). client_id/secret ikut
   ditulis (bukan cuma token) supaya rclone bisa refresh token sendiri
   kalau kadaluarsa di tengah proses sync yang lama. */
export async function writeRcloneConfig(destFile) {
  const lines = [];
  for (const acc of accounts) {
    await ensureFreshToken(acc).catch(() => {}); // biar token yang ditulis fresh, bukan wajib
    const tokenObj = { access_token: acc.token.access_token, token_type: 'Bearer',
      refresh_token: acc.token.refresh_token, expiry: new Date(acc.token.expiry).toISOString() };
    lines.push(`[panel-${acc.id}]`, 'type = drive', 'scope = drive.file',
      `client_id = ${CLIENT_ID}`, `client_secret = ${CLIENT_SECRET}`,
      `token = ${JSON.stringify(tokenObj)}`, '');
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, lines.join('\n'));
}

/* Pilih akun dengan sisa kuota paling longgar (dalam %) — dipanggil backup
   script sebelum sync, biar otomatis "pindah" begitu akun yang biasa
   dipakai mulai penuh, tanpa perlu diatur manual. */
export async function pickAccount(minFreePercent = 10) {
  const withQuota = [];
  for (const a of accounts) {
    try { withQuota.push({ id: a.id, email: a.email, ...(await quotaOf(a.id)) }); } catch {}
  }
  const ok = withQuota.filter(a => a.total == null || (100 - a.percent) >= minFreePercent);
  ok.sort((a, b) => a.percent - b.percent); // paling longgar duluan
  return ok[0] || null;
}
