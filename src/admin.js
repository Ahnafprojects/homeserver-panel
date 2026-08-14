// Gelombang 2: kontrol sistem, penjadwal, brankas rahasia, cadangan.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runP, run } from './stacks.js';

const STATE = process.env.STATE_DIR || '/state';
const DATA = process.env.DATA_ROOT || '/data';
const j = (f) => path.join(STATE, f);
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(j(f), 'utf8')); } catch { return d; } };
const save = (f, v) => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(j(f), JSON.stringify(v, null, 2)); } catch {} };

// Perintah dijalankan di namespace host lewat nsenter, supaya benar-benar
// mengenai mesin dan bukan container panel.
// Batas waktu wajib: kalau host tidak punya systemd/ufw, perintahnya bisa
// menggantung dan halaman ikut membeku selamanya.
const withTimeout = (pr, ms = 12000) => Promise.race([
  pr, new Promise((r) => setTimeout(() => r({ code: 124, out: '' }), ms)),
]);
const host = (cmd, args = []) =>
  withTimeout(runP('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', '--', cmd, ...args]));
const hostStream = (cmd, args = []) => run('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', '--', cmd, ...args]);

/* ══ Layanan systemd ══ */
export async function services() {
  const { out } = await host('systemctl',
    ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']);
  return out.split('\n').filter(Boolean).map(l => {
    const p = l.trim().split(/\s+/);
    return { name: p[0], load: p[1], active: p[2], sub: p[3],
      desc: p.slice(4).join(' ') };
  }).filter(s => s.name?.endsWith('.service'));
}
export async function serviceAction(name, action) {
  if (!/^[a-zA-Z0-9@._-]+\.service$/.test(name)) throw new Error('Invalid service name');
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
    throw new Error('Unknown action');
  }
  const { code, out } = await host('systemctl', [action, name]);
  if (code !== 0) throw new Error(out || 'Gagal');
  return true;
}

/* ══ Paket & pembaruan OS ══ */
export async function updatesAvailable() {
  const { out } = await host('sh', ['-c', 'apt-get -s upgrade 2>/dev/null | grep ^Inst || true']);
  const list = out.split('\n').filter(Boolean).map(l => {
    const m = l.match(/^Inst (\S+) \[([^\]]*)\] \(([^\s]+)/);
    return m ? { name: m[1], from: m[2], to: m[3] } : null;
  }).filter(Boolean);
  const sec = list.filter(p => /security/i.test(p.to)).length;
  return { count: list.length, security: sec, packages: list };
}
export const aptUpdate = () => hostStream('sh', ['-c', 'apt-get update']);
export const aptUpgrade = () => hostStream('sh',
  ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get -y upgrade']);
export function aptInstall(pkg) {
  if (!/^[a-z0-9][a-z0-9+._-]*$/i.test(pkg)) throw new Error('Invalid package name');
  return hostStream('sh', ['-c', `DEBIAN_FRONTEND=noninteractive apt-get -y install ${pkg}`]);
}

/* ══ Firewall (UFW) ══ */
export async function firewall() {
  const { out } = await host('ufw', ['status', 'numbered']);
  const active = /Status:\s*active/i.test(out);
  const rules = out.split('\n')
    .map(l => l.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.*)$/i))
    .filter(Boolean)
    .map(m => ({ n: +m[1], to: m[2].trim(), action: m[3].toUpperCase(), from: m[4].trim() }));
  return { active, rules, raw: out };
}
export async function firewallAllow(port, proto = 'tcp') {
  if (!/^\d{1,5}$/.test(String(port))) throw new Error('Invalid port');
  if (!['tcp', 'udp'].includes(proto)) throw new Error('Invalid protocol');
  const { code, out } = await host('ufw', ['allow', `${port}/${proto}`]);
  if (code !== 0) throw new Error(out);
  return true;
}
export async function firewallDelete(n) {
  if (!/^\d+$/.test(String(n))) throw new Error('Invalid rule number');
  const { code, out } = await host('sh', ['-c', `yes | ufw delete ${n}`]);
  if (code !== 0) throw new Error(out);
  return true;
}
export const firewallToggle = (on) => host('sh', ['-c', on ? 'yes | ufw enable' : 'ufw disable']);

/* ══ Jaringan ══ */
export async function netInfo() {
  const [addr, route, dns] = await Promise.all([
    host('sh', ['-c', "ip -o -4 addr show | awk '{print $2, $4}'"]),
    host('sh', ['-c', "ip route | grep default || true"]),
    host('sh', ['-c', "cat /etc/resolv.conf 2>/dev/null | grep ^nameserver || true"]),
  ]);
  return {
    interfaces: addr.out.split('\n').filter(Boolean).map(l => {
      const [name, cidr] = l.split(/\s+/);
      return { name, cidr };
    }).filter(i => i.name !== 'lo'),
    gateway: (route.out.match(/default via (\S+)/) || [])[1] || null,
    dns: dns.out.split('\n').map(l => l.replace('nameserver', '').trim()).filter(Boolean),
  };
}

/* ══ Pengguna Linux ══ */
export async function linuxUsers() {
  const { out } = await host('sh', ['-c', "getent passwd | awk -F: '$3>=1000 && $3<65534'"]);
  return out.split('\n').filter(Boolean).map(l => {
    const p = l.split(':');
    return { name: p[0], uid: +p[2], gid: +p[3], home: p[5], shell: p[6] };
  });
}
export async function linuxUserAdd(name, password) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Invalid username');
  const { code, out } = await host('useradd', ['-m', '-s', '/bin/bash', name]);
  if (code !== 0) throw new Error(out);
  if (password) {
    // chpasswd dipakai lewat stdin agar kata sandi tidak muncul di daftar proses.
    await new Promise((resolve) => {
      const e = run('sh', ['-c',
        `printf '%s' "$PW" | nsenter -t 1 -m -u -n -i -- chpasswd`],
        { env: { PW: `${name}:${password}` } });
      e.onDone = resolve;
    });
  }
  return true;
}
export async function linuxUserDel(name) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Invalid name');
  const { code, out } = await host('userdel', ['-r', name]);
  if (code !== 0) throw new Error(out);
  return true;
}

/* ══ Penjadwal (cron internal) ══════════════════════════════════════════════
   Dijalankan panel sendiri, bukan crontab sistem. Alasannya: riwayat dan
   status tiap jalan bisa dicatat dan ditampilkan, yang tidak mungkin
   dilakukan kalau menumpang crontab.                                        */
let jobs = load('jobs.json', []);
const saveJobs = () => save('jobs.json', jobs);

export const listJobs = () => jobs.map(j2 => ({ ...j2, runs: (j2.runs || []).slice(-20) }));
export function addJob({ name, schedule, type, target, command }) {
  if (!name) throw new Error('Name is required');
  if (!parseCron(schedule)) throw new Error('Invalid schedule format (example: 0 2 * * *)');
  jobs.push({ id: crypto.randomUUID().slice(0, 8), name, schedule, type: type || 'shell',
    target: target || '', command: command || '', enabled: true, runs: [] });
  saveJobs(); return true;
}
export function updateJob(id, patch) {
  const jb = jobs.find(x => x.id === id); if (!jb) throw new Error('Not found');
  Object.assign(jb, patch); saveJobs(); return true;
}
export function deleteJob(id) { jobs = jobs.filter(x => x.id !== id); saveJobs(); }

// Parser cron 5 kolom: menit jam tanggal bulan hari.
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const sets = parts.map((p, i) => {
    const [lo, hi] = ranges[i];
    const out = new Set();
    for (const chunk of p.split(',')) {
      const m = chunk.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!m) return null;
      const step = m[3] ? +m[3] : 1;
      let a = m[1] === '*' ? lo : +m[1];
      let b = m[2] ? +m[2] : (m[1] === '*' ? hi : (m[3] ? hi : a));
      if (a < lo || b > hi || a > b || step < 1) return null;
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  });
  return sets.some(s => s === null) ? null : sets;
}
const matches = (sets, d) =>
  sets[0].has(d.getMinutes()) && sets[1].has(d.getHours()) &&
  sets[2].has(d.getDate()) && sets[3].has(d.getMonth() + 1) && sets[4].has(d.getDay());

export async function runJob(jb, notify) {
  const t0 = Date.now();
  let code = 0, out = '';
  try {
    if (jb.type === 'shell') ({ code, out } = await host('sh', ['-c', jb.command]));
    else if (jb.type === 'backup') ({ code, out } = await doBackup(jb.target));
    else if (jb.type === 'restart') ({ code, out } = await runP('docker', ['restart', jb.target]));
    else if (jb.type === 'deploy') ({ code, out } = await runP('docker',
      ['compose', 'up', '-d', '--build'], { cwd: path.join('/stacks', jb.target) }));
  } catch (e) { code = 1; out = String(e.message); }
  jb.runs = (jb.runs || []).concat([{ t: t0, ms: Date.now() - t0, code,
    out: out.slice(-1500) }]).slice(-50);
  jb.lastRun = t0; jb.lastCode = code;
  saveJobs();
  if (code !== 0) notify?.('Tugas gagal', `<code>${jb.name}</code> keluar dengan kode ${code}.`);
  return { code, out };
}

export function startScheduler(notify) {
  let lastMin = -1;
  setInterval(async () => {
    const now = new Date();
    if (now.getMinutes() === lastMin) return;
    lastMin = now.getMinutes();
    for (const jb of jobs) {
      if (!jb.enabled) continue;
      const sets = parseCron(jb.schedule);
      if (sets && matches(sets, now)) runJob(jb, notify);
    }
  }, 20000);
}

/* ══ Brankas rahasia ════════════════════════════════════════════════════════
   Nilai dienkripsi AES-256-GCM dengan kunci yang disimpan terpisah dan
   hanya bisa dibaca root. Nilai asli tidak pernah dikirim ke UI kecuali
   diminta eksplisit.                                                        */
const KEY_FILE = j('vault.key');
function vaultKey() {
  try { return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); }
  catch {
    const k = crypto.randomBytes(32);
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });
    return k;
  }
}
let secrets = load('secrets.json', []);
const saveSecrets = () => save('secrets.json', secrets);

export function setSecret(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('Name must look like a variable, e.g. DB_PASSWORD');
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  const rec = { name, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'),
    data: enc.toString('base64'), updated: Date.now() };
  const i = secrets.findIndex(s => s.name === name);
  if (i >= 0) secrets[i] = rec; else secrets.push(rec);
  saveSecrets(); return true;
}
export function getSecret(name) {
  const s = secrets.find(x => x.name === name);
  if (!s) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8');
}
export const listSecrets = () => secrets.map(s => ({ name: s.name, updated: s.updated }));
export function deleteSecret(name) { secrets = secrets.filter(s => s.name !== name); saveSecrets(); }
// Tempelkan semua rahasia ke file .env sebuah stack.
export async function injectSecrets(stackName) {
  const f = path.join('/stacks', stackName, '.env');
  let cur = '';
  try { cur = await fsp.readFile(f, 'utf8'); } catch {}
  const have = new Set(cur.split('\n').map(l => l.split('=')[0].trim()));
  const add = secrets.filter(s => !have.has(s.name))
    .map(s => `${s.name}=${getSecret(s.name)}`).join('\n');
  if (add) await fsp.writeFile(f, (cur.trimEnd() + '\n' + add + '\n').trimStart());
  return add.split('\n').filter(Boolean).length;
}

/* ══ Cadangan ══ */
const BACKUP_DIR = process.env.BACKUP_DIR || '/backup';

export async function listBackups() {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const f = await fsp.readdir(BACKUP_DIR);
    const out = [];
    for (const name of f) {
      try {
        const st = await fsp.stat(path.join(BACKUP_DIR, name));
        if (st.isFile()) out.push({ name, size: st.size, at: st.mtimeMs });
      } catch {}
    }
    return out.sort((a, b) => b.at - a.at);
  } catch { return []; }
}

export async function doBackup(what = 'data') {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (what.startsWith('db:')) {
    // Format: db:<container>:<user>
    const [, cont, user] = what.split(':');
    const file = path.join(BACKUP_DIR, `db-${cont}-${stamp}.sql.gz`);
    const { code, out } = await runP('sh', ['-c',
      `docker exec ${cont} pg_dumpall -U ${user || 'postgres'} | gzip > '${file}'`]);
    return { code, out, file };
  }
  if (what.startsWith('volume:')) {
    const vol = what.split(':')[1];
    const file = `volume-${vol}-${stamp}.tar.gz`;
    const { code, out } = await runP('docker', ['run', '--rm',
      '-v', `${vol}:/src:ro`, '-v', `${BACKUP_DIR}:/dst`,
      'alpine', 'sh', '-c', `tar czf /dst/${file} -C /src .`]);
    return { code, out, file };
  }
  const file = path.join(BACKUP_DIR, `data-${stamp}.tar.gz`);
  const { code, out } = await runP('tar', ['czf', file, '-C', DATA, '.']);
  return { code, out, file };
}

export async function deleteBackup(name) {
  if (name.includes('/') || name.includes('..')) throw new Error('Invalid name');
  await fsp.rm(path.join(BACKUP_DIR, name), { force: true });
}
export const backupPath = (name) => {
  if (name.includes('/') || name.includes('..')) throw new Error('Invalid name');
  return path.join(BACKUP_DIR, name);
};
