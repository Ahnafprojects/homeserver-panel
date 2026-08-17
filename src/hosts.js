// Multi-server: kelola Docker host LAIN (bukan cuma laptop ini) dari web.
// Transportnya SSH ("docker -H ssh://user@host ..."), bukan expose Docker
// API lewat TCP tanpa autentikasi -- SSH lebih aman (pakai kunci yang
// sudah ada) dan lebih realistis buat home-lab (server kedua biasanya
// sudah bisa di-SSH, belum tentu Docker API-nya sengaja dibuka ke jaringan).
// Perintah dijalankan lewat host (nsenter, pola sama seperti stacks.js
// buat git) supaya ikut SSH config & known_hosts milik user laptop ini,
// bukan dari dalam container yang belum tentu ada apa-apa.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './stacks.js';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'docker-hosts.json');
const NSENTER = ['-t', '1', '-m', '-u', '-n', '-i', '--'];

let hosts = [];
try { hosts = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(hosts, null, 2)); } catch {} };

export const listHosts = () => hosts.map((h) => ({ ...h }));

export function addHost({ name, url }) {
  name = String(name || '').trim().slice(0, 60);
  url = String(url || '').trim();
  if (!name) throw new Error('Nama wajib diisi');
  if (!/^(ssh|tcp|unix):\/\/[^\s]+$/i.test(url)) {
    throw new Error('URL harus diawali ssh:// atau tcp:// (mis. ssh://user@192.168.1.20)');
  }
  const rec = { id: Date.now().toString(36), name, url, added: Date.now() };
  hosts.push(rec); save();
  return rec;
}

export function removeHost(id) {
  const before = hosts.length;
  hosts = hosts.filter((h) => h.id !== id);
  save();
  return hosts.length < before;
}

function getHost(id) {
  const h = hosts.find((x) => x.id === id);
  if (!h) throw new Error('Host tidak ditemukan');
  return h;
}

/* Jalankan 'docker <args>' di host TARGET lewat CLI (nsenter ke host laptop
   ini, lalu docker -H <url> ...) -- CLI dipilih daripada bikin klien HTTP
   raw ke tiap host (kayak docker.js buat host lokal) karena SSH transport
   butuh proses `docker` beneran buat nge-multiplex koneksi SSH-nya,
   bukan sesuatu yang gampang direplikasi lewat http.request() manual. */
function dockerCli(hostUrl, args, timeoutMs = 15000) {
  const full = ['docker', '-H', hostUrl, ...args];
  return new Promise((resolve) => {
    const out = [];
    const e = run('nsenter', [...NSENTER, ...full]);
    const t = setTimeout(() => { e.kill?.(); }, timeoutMs); // SSH ke host mati/gak respons -- jangan gantung selamanya
    e.onLine = (l) => out.push(l);
    e.onDone = (code) => { clearTimeout(t); resolve({ code, out: out.join('\n') }); };
  });
}

export async function testHost(id) {
  const h = getHost(id);
  const r = await dockerCli(h.url, ['version', '--format', 'json']);
  if (r.code !== 0) return { ok: false, error: r.out.slice(0, 300) };
  try {
    const v = JSON.parse(r.out);
    return { ok: true, version: v.Server?.Version || v.Client?.Version, os: v.Server?.Os };
  } catch { return { ok: false, error: 'Respons tidak bisa dibaca: ' + r.out.slice(0, 200) }; }
}

export async function hostContainers(id) {
  const h = getHost(id);
  const r = await dockerCli(h.url, ['ps', '-a', '--format', '{{json .}}']);
  if (r.code !== 0) throw new Error(r.out.slice(0, 300));
  return r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export async function hostStats(id) {
  const h = getHost(id);
  const [info, df] = await Promise.all([
    dockerCli(h.url, ['info', '--format', 'json']),
    dockerCli(h.url, ['system', 'df', '--format', 'json']),
  ]);
  let infoObj = null, dfArr = null;
  try { infoObj = JSON.parse(info.out); } catch {}
  try { dfArr = JSON.parse('[' + df.out.trim().split('\n').join(',') + ']'); } catch {}
  return {
    containers: infoObj?.Containers ?? null, containersRunning: infoObj?.ContainersRunning ?? null,
    images: infoObj?.Images ?? null, ncpu: infoObj?.NCPU ?? null,
    memTotal: infoObj?.MemTotal ?? null, serverVersion: infoObj?.ServerVersion ?? null,
    df: dfArr,
  };
}
