// Reverse proxy & domain: menulis Caddyfile lalu memuat ulang Caddy.
//
// Caddy dipilih karena HTTPS-nya otomatis: begitu domain diarahkan ke server
// ini, sertifikat Let's Encrypt diterbitkan dan diperbarui sendiri tanpa
// konfigurasi tambahan.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runP } from './stacks.js';

const STATE = process.env.STATE_DIR || '/state';
const CADDY_DIR = process.env.CADDY_DIR || '/caddy';
const CADDYFILE = path.join(CADDY_DIR, 'Caddyfile');
const SITES = path.join(STATE, 'sites.json');
const CADDY_CONTAINER = process.env.CADDY_CONTAINER || 'caddy';
const NET = process.env.APPS_NETWORK || 'apps';

let sites = [];
try { sites = JSON.parse(fs.readFileSync(SITES, 'utf8')); } catch {}
const persist = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(SITES, JSON.stringify(sites, null, 2)); } catch {} };

export const listSites = () => sites;

const validDomain = (d) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d) ||
  /^[a-z0-9-]+\.(localhost|local|test)$/i.test(d);

export function addSite({ domain, target, port, email, auth, wsSupport }) {
  domain = String(domain || '').trim().toLowerCase();
  if (!validDomain(domain)) throw new Error('Invalid domain');
  if (sites.some(s => s.domain === domain)) throw new Error('Domain already registered');
  if (!target) throw new Error('Target is required');
  sites.push({ id: Date.now().toString(36), domain, target, port: +port || 80,
    email: email || '', auth: !!auth, wsSupport: wsSupport !== false, created: Date.now() });
  persist();
  return true;
}
export function removeSite(id) { sites = sites.filter(s => s.id !== id); persist(); }
export function updateSite(id, patch) {
  const s = sites.find(x => x.id === id);
  if (!s) throw new Error('Domain not found');
  Object.assign(s, patch); persist();
}

/* Bangun Caddyfile dari daftar situs. */
export function buildCaddyfile() {
  const email = sites.find(s => s.email)?.email;
  const head = [
    '# Berkas ini dihasilkan otomatis oleh panel. Jangan diubah manual —',
    '# perubahan akan tertimpa saat domain berikutnya ditambahkan.',
    '',
    '{',
    email ? `\temail ${email}` : '\t# email admin belum diisi (untuk pemberitahuan Let\'s Encrypt)',
    '}',
    '',
  ];
  const blocks = sites.map(s => {
    const isLocal = /\.(localhost|local|test)$/i.test(s.domain);
    const lines = [`${s.domain} {`];
    if (isLocal) lines.push('\ttls internal');
    lines.push(`\treverse_proxy ${s.target}:${s.port} {`);
    if (s.wsSupport) {
      lines.push('\t\t# Header ini membuat WebSocket dan alamat asli pengunjung');
      lines.push('\t\t# tetap terbaca oleh aplikasi di belakang.');
      lines.push('\t\theader_up Host {host}');
      lines.push('\t\theader_up X-Real-IP {remote_host}');
      lines.push('\t\theader_up X-Forwarded-Proto {scheme}');
    }
    lines.push('\t}');
    lines.push('\tencode gzip');
    lines.push(`\tlog {`, `\t\toutput file /var/log/caddy/${s.domain}.log`, `\t}`);
    lines.push('}');
    return lines.join('\n');
  });
  return head.concat(blocks).join('\n') + '\n';
}

// Caddy hanya bisa mem-proxy container yang satu jaringan Docker dengannya.
// Stack yang dibuat lewat panel jalan di jaringan compose masing-masing,
// jadi tanpa ini Caddy tidak akan pernah bisa menerjemahkan nama container
// targetnya — domain akan selalu 502 walau konfigurasinya benar.
async function ensureReachable(target) {
  try {
    const inspect = await runP('docker', ['inspect', target, '--format',
      '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}']);
    if (inspect.code !== 0) return { ok: false, reason: 'container tidak ditemukan' };
    if (!inspect.out.split(/\s+/).includes(NET)) {
      await runP('docker', ['network', 'connect', NET, target]);
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function applyConfig() {
  await fsp.mkdir(CADDY_DIR, { recursive: true });
  const unreachable = [];
  for (const s of sites) {
    const r = await ensureReachable(s.target);
    if (!r.ok) unreachable.push(`${s.domain} → ${s.target} (${r.reason})`);
  }
  const conf = buildCaddyfile();
  await fsp.writeFile(CADDYFILE, conf);
  // Muat ulang tanpa memutus koneksi yang sedang berjalan.
  const r = await runP('docker', ['exec', CADDY_CONTAINER,
    'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  return { ok: r.code === 0 && !unreachable.length, message: r.out, config: conf,
    warning: unreachable.length
      ? `Container belum bisa dijangkau Caddy: ${unreachable.join(', ')}` : undefined };
}

export async function caddyStatus() {
  const r = await runP('docker', ['ps', '--filter', `name=${CADDY_CONTAINER}`,
    '--format', '{{.Names}}|{{.Status}}']);
  const line = r.out.split('\n').find(Boolean);
  return { running: !!line, status: line?.split('|')[1] || 'tidak berjalan',
    container: CADDY_CONTAINER };
}

/* Periksa masa berlaku sertifikat tiap domain. */
export async function certInfo() {
  const out = [];
  for (const s of sites) {
    if (/\.(localhost|local|test)$/i.test(s.domain)) {
      out.push({ domain: s.domain, kind: 'internal', daysLeft: null });
      continue;
    }
    try {
      // Dijalankan tanpa shell; nama domain sudah tervalidasi saat ditambahkan,
      // tetapi tetap tidak diinterpolasi ke perintah shell.
      if (!validDomain(s.domain)) { out.push({ domain: s.domain, kind: 'unknown', daysLeft: null }); continue; }
      const r = await runP('sh', ['-c',
        'echo | openssl s_client -servername "$1" -connect "$1:443" 2>/dev/null '
        + '| openssl x509 -noout -enddate 2>/dev/null', 'sh', s.domain]);
      const m = r.out.match(/notAfter=(.+)/);
      if (m) {
        const exp = new Date(m[1]);
        out.push({ domain: s.domain, kind: 'letsencrypt', expires: exp.getTime(),
          daysLeft: Math.round((exp - Date.now()) / 86400000) });
      } else out.push({ domain: s.domain, kind: 'unknown', daysLeft: null });
    } catch { out.push({ domain: s.domain, kind: 'unknown', daysLeft: null }); }
  }
  return out;
}

/* Cek apakah DNS domain sudah mengarah ke server ini.
   Nama domain TIDAK boleh masuk ke shell: sebelumnya nilai ini dipakai
   langsung di `sh -c`, sehingga `x; perintah` ikut dieksekusi. Sekarang
   divalidasi dulu lalu dijalankan sebagai argumen, tanpa shell. */
export async function dnsCheck(domain) {
  domain = String(domain || '').trim().toLowerCase();
  if (!validDomain(domain)) throw new Error('Invalid domain');
  const [res, mine] = await Promise.all([
    runP('getent', ['hosts', domain]),
    runP('curl', ['-s', '--max-time', '6', 'https://api.ipify.org']),
  ]);
  const resolved = res.out.split('\n').map(l => l.trim().split(/\s+/)[0])
    .filter(Boolean).slice(0, 3);
  const publicIp = mine.out.trim();
  return { resolved, publicIp,
    match: publicIp ? resolved.includes(publicIp) : null };
}
