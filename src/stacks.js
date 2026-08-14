// Stack: deploy dari Docker Compose yang ditempel di web, atau dari repo Git.
// Semua perintah panjang mengalirkan keluarannya sebagai event, supaya
// log build bisa dilihat langsung di UI, bukan menunggu selesai.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const STACKS = process.env.STACKS_DIR || '/stacks';
const STATE = process.env.STATE_DIR || '/state';
const META = path.join(STATE, 'stacks.json');

const loadMeta = () => { try { return JSON.parse(fsSync.readFileSync(META, 'utf8')); } catch { return {}; } };
const saveMeta = (m) => { try { fsSync.mkdirSync(STATE, { recursive: true });
  fsSync.writeFileSync(META, JSON.stringify(m, null, 2)); } catch {} };

const safeName = (n) => {
  const s = String(n || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!s) throw new Error('Invalid stack name');
  return s;
};
const dirOf = (n) => path.join(STACKS, safeName(n));

/* Jalankan perintah dan alirkan keluarannya baris demi baris. */
export function run(cmd, args, opts = {}) {
  const emitter = { onLine: null, onDone: null };
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
  const push = (buf) => String(buf).split('\n').forEach(l => l !== '' && emitter.onLine?.(l));
  p.stdout.on('data', push);
  p.stderr.on('data', push);
  p.on('close', (code) => emitter.onDone?.(code));
  p.on('error', (e) => { emitter.onLine?.('ERROR: ' + e.message); emitter.onDone?.(1); });
  emitter.kill = () => p.kill('SIGTERM');
  return emitter;
}
export const runP = (cmd, args, opts = {}) => new Promise((resolve) => {
  const out = [];
  const e = run(cmd, args, opts);
  e.onLine = (l) => out.push(l);
  e.onDone = (code) => resolve({ code, out: out.join('\n') });
});

/* ── Daftar & baca ──────────────────────────────────────────────────────── */
export async function listStacks() {
  await fs.mkdir(STACKS, { recursive: true });
  const meta = loadMeta();
  const dirs = await fs.readdir(STACKS, { withFileTypes: true });
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const m = meta[d.name] || {};
    let running = 0, total = 0;
    try {
      const { out: ps } = await runP('docker', ['compose', 'ps', '--format', 'json'],
        { cwd: path.join(STACKS, d.name) });
      ps.split('\n').filter(Boolean).forEach(l => {
        try { const o = JSON.parse(l); total++; if (/running|Up/i.test(o.State || o.Status)) running++; } catch {}
      });
    } catch {}
    out.push({ name: d.name, running, total, source: m.source || 'compose',
      repo: m.repo || null, branch: m.branch || null,
      updated: m.updated || null, lastDeploy: m.lastDeploy || null });
  }
  return out;
}

export async function readStack(name) {
  const dir = dirOf(name);
  const meta = loadMeta()[safeName(name)] || {};
  let compose = '';
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml']) {
    try { compose = await fs.readFile(path.join(dir, f), 'utf8'); break; } catch {}
  }
  let env = '';
  try { env = await fs.readFile(path.join(dir, '.env'), 'utf8'); } catch {}
  return { name: safeName(name), compose, env, ...meta };
}

export async function writeStack(name, compose, env) {
  const dir = dirOf(name);
  await fs.mkdir(dir, { recursive: true });
  if (compose != null) await fs.writeFile(path.join(dir, 'docker-compose.yml'), compose);
  if (env != null) await fs.writeFile(path.join(dir, '.env'), env);
  const meta = loadMeta();
  meta[safeName(name)] = { ...(meta[safeName(name)] || {}), source: 'compose', updated: Date.now() };
  saveMeta(meta);
  return dir;
}

/* Validasi tanpa menjalankan — menangkap YAML salah sebelum deploy. */
export async function validateStack(name) {
  const { code, out } = await runP('docker', ['compose', 'config', '-q'], { cwd: dirOf(name) });
  return { ok: code === 0, message: out };
}

export async function removeStack(name) {
  const dir = dirOf(name);
  await runP('docker', ['compose', 'down', '-v'], { cwd: dir });
  await fs.rm(dir, { recursive: true, force: true });
  const meta = loadMeta(); delete meta[safeName(name)]; saveMeta(meta);
}

export function markDeploy(name, ok) {
  const meta = loadMeta();
  meta[safeName(name)] = { ...(meta[safeName(name)] || {}), lastDeploy: Date.now(), lastOk: ok };
  saveMeta(meta);
}

/* ── Git ───────────────────────────────────────────────────────────────── */
export async function gitClone(name, repo, branch, onLine) {
  const dir = dirOf(name);
  await fs.mkdir(STACKS, { recursive: true });
  await fs.rm(dir, { recursive: true, force: true });
  // URL repositori hanya boleh http/https/ssh. Tanpa pemeriksaan ini sebuah
  // nilai yang diawali '-' akan dibaca git sebagai opsi (mis. --upload-pack),
  // yang berujung menjalankan perintah pilihan penyerang.
  if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/i.test(String(repo || ''))) {
    throw new Error('Repository URL must start with https://, http://, ssh:// or git@');
  }
  if (branch && !/^[A-Za-z0-9._\/-]{1,120}$/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  const args = ['clone', '--depth', '30'];
  if (branch) args.push('-b', branch);
  args.push('--', repo, dir);
  return new Promise((resolve) => {
    const e = run('git', args);
    e.onLine = onLine;
    e.onDone = (code) => {
      if (code === 0) {
        const meta = loadMeta();
        meta[safeName(name)] = { source: 'git', repo, branch: branch || 'default', updated: Date.now() };
        saveMeta(meta);
      }
      resolve(code);
    };
  });
}
export const gitPull = (name, onLine) => new Promise((resolve) => {
  const e = run('git', ['pull', '--ff-only'], { cwd: dirOf(name) });
  e.onLine = onLine; e.onDone = resolve;
});
export const gitCheckout = (name, ref, onLine) => new Promise((resolve) => {
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(String(ref || ''))) {
    onLine?.('ERROR: invalid ref'); resolve(1); return;
  }
  const e = run('git', ['checkout', '--', ref], { cwd: dirOf(name) });
  e.onLine = onLine; e.onDone = resolve;
});
export async function gitLog(name, n = 20) {
  const { out } = await runP('git',
    ['log', `-${n}`, '--pretty=format:%h|%an|%ar|%s'], { cwd: dirOf(name) });
  return out.split('\n').filter(Boolean).map(l => {
    const [hash, author, when, ...rest] = l.split('|');
    return { hash, author, when, subject: rest.join('|') };
  });
}
export async function gitBranches(name) {
  const { out } = await runP('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: dirOf(name) });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}
export async function gitCurrent(name) {
  const { out } = await runP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dirOf(name) });
  return out.trim();
}

/* ── Deploy ────────────────────────────────────────────────────────────── */
export function deploy(name, onLine, { build = true } = {}) {
  const dir = dirOf(name);
  const args = ['compose', 'up', '-d', '--remove-orphans'];
  if (build) args.push('--build');
  return new Promise((resolve) => {
    const e = run('docker', args, { cwd: dir });
    e.onLine = onLine;
    e.onDone = (code) => { markDeploy(name, code === 0); resolve(code); };
  });
}
export const stopStack = (name, onLine) => new Promise((resolve) => {
  const e = run('docker', ['compose', 'down'], { cwd: dirOf(name) });
  e.onLine = onLine; e.onDone = resolve;
});
export const stackPs = (name) => runP('docker', ['compose', 'ps'], { cwd: dirOf(name) });

/* ── Webhook ───────────────────────────────────────────────────────────── */
export function webhookToken(name) {
  const meta = loadMeta(); const k = safeName(name);
  if (!meta[k]) meta[k] = {};
  if (!meta[k].hook) {
    meta[k].hook = crypto.randomBytes(18).toString('base64url');
    saveMeta(meta);
  }
  return meta[k].hook;
}
export function stackByHook(token) {
  const meta = loadMeta();
  return Object.entries(meta).find(([, m]) => m.hook === token)?.[0] || null;
}
