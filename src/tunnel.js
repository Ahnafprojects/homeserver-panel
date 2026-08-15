// Subdomain lewat Cloudflare Tunnel — dipakai kalau server tidak punya port
// 80/443 yang bisa dijangkau dari internet (mis. pakai Cloudflare Tunnel,
// bukan port-forwarding). Beda mekanisme dari proxy.js (yang mengandalkan
// Caddy + Let's Encrypt di port 80/443 langsung).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { runP } from './stacks.js';

const STATE = process.env.STATE_DIR || '/state';
const SITES_FILE = path.join(STATE, 'tunnel-sites.json');
// /host/root adalah bind mount rw ke '/' host (dipakai juga oleh fitur Terminal
// & Files) — jadi ini path config.yml cloudflared yang sesungguhnya di host.
const CONFIG_PATH = process.env.CLOUDFLARED_CONFIG || '/host/root/etc/cloudflared/config.yml';
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'homeserver';
const BASE_DOMAIN = process.env.TUNNEL_DOMAIN || 'ahnaf.cloud';
const PANEL_PORT = process.env.PANEL_LOCAL_PORT || '8090';
const NSENTER = ['-t', '1', '-m', '-u', '-n', '-i', '--'];

let sites = [];
try { sites = JSON.parse(fsSync.readFileSync(SITES_FILE, 'utf8')); } catch {}
const persist = () => { try { fsSync.mkdirSync(STATE, { recursive: true });
  fsSync.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2)); } catch {} };

export const listSites = () => sites;
export const baseDomain = () => BASE_DOMAIN;

const validLabel = (s) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(String(s || ''));

// project (opsional) menyisipkan nama project ke depan label, misal
// "toko-backend" bukan cuma "backend" — biar tiap project yang di-deploy
// punya "namespace" sendiri dan tidak numpang rata di bawah domain utama.
//
// Sengaja dipisah pakai STRIP (toko-backend.domain), BUKAN titik
// (backend.toko.domain) — subdomain dua tingkat kayak itu butuh sertifikat
// wildcard tambahan yang tidak dicakup paket gratis Cloudflare (Universal
// SSL cuma nyakup *.domain, satu tingkat), jadi TLS-nya bakal gagal total
// kalau dipaksa pakai titik.
export function addSite({ label, target, port, project, proto }) {
  label = String(label || '').trim().toLowerCase();
  if (!validLabel(label)) {
    throw new Error('Nama subdomain cuma boleh huruf, angka, dan strip');
  }
  proto = proto === 'tcp' ? 'tcp' : 'http';
  let hostname;
  if (project) {
    const p2 = String(project).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!p2) throw new Error('Nama project tidak valid');
    hostname = `${p2}-${label}.${BASE_DOMAIN}`;
  } else {
    hostname = `${label}.${BASE_DOMAIN}`;
  }
  if (sites.some(s => s.hostname === hostname)) throw new Error('Subdomain itu sudah dipakai');
  if (!target) throw new Error('Target wajib diisi');
  const p = +port;
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port tidak valid');
  const site = { id: Date.now().toString(36), hostname, target, port: p, proto, created: Date.now() };
  sites.push(site);
  persist();
  return site;
}
export function removeSite(id) { sites = sites.filter(s => s.id !== id); persist(); }

function readHeader() {
  let raw = '';
  try { raw = fsSync.readFileSync(CONFIG_PATH, 'utf8'); } catch {}
  const tunnelLine = raw.match(/^tunnel:.*$/m)?.[0];
  const credLine = raw.match(/^credentials-file:.*$/m)?.[0];
  if (!tunnelLine || !credLine) {
    throw new Error('cloudflared config.yml tidak ditemukan atau formatnya tidak dikenali');
  }
  return `${tunnelLine}\n${credLine}\n`;
}

const rule = (hostname, port, proto = 'http') => proto === 'tcp'
  // TCP mentah (mis. database) — tidak ada konsep Host header di TCP, jadi
  // tidak ada originRequest di sini. Yang bisa nyambung cuma client yang
  // lewat 'cloudflared access tcp', bukan browser biasa.
  ? `  - hostname: ${hostname}\n    service: tcp://localhost:${port}\n`
  : `  - hostname: ${hostname}\n    service: http://localhost:${port}\n`
    + `    originRequest:\n      httpHostHeader: ${hostname}\n`;

export function buildConfig() {
  const head = readHeader();
  const fixed = [BASE_DOMAIN, `www.${BASE_DOMAIN}`].map(h => rule(h, PANEL_PORT));
  const dynamic = sites.map(s => rule(s.hostname, s.port, s.proto));
  return [head, 'ingress:', ...fixed,
    '  # --- dikelola panel (Domain publik) — jangan diedit manual di bawah sini ---',
    ...dynamic, '  - service: http_status:404', ''].join('\n');
}

export async function applyConfig() {
  const conf = buildConfig();
  await fs.writeFile(CONFIG_PATH, conf);
  const r = await runP('nsenter', [...NSENTER, 'systemctl', 'restart', 'cloudflared']);
  return { ok: r.code === 0, message: r.out, config: conf };
}

export async function routeDns(hostname) {
  const r = await runP('nsenter', [...NSENTER,
    'cloudflared', 'tunnel', 'route', 'dns', TUNNEL_NAME, hostname]);
  const already = /already (configured|exists)/i.test(r.out);
  return { ok: r.code === 0 || already, message: r.out };
}
