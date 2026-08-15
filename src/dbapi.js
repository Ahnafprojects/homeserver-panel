// REST API otomatis di depan basis data PostgreSQL — mekanisme yang sama
// dipakai Supabase (PostgREST): baca skema tabel, langsung jadi endpoint
// HTTP. Client cukup panggil lewat fetch() + API key, tidak perlu install
// software tunnel apa pun — beda dari akses TCP mentah yang butuh
// 'cloudflared access tcp' di sisi yang connect.
//
// API key di sini SECARA HARFIAH token JWT (persis seperti "anon key" /
// "service_role key" Supabase) — ditandatangani pakai JWT_SECRET yang
// cuma diketahui PostgREST, berisi klaim role Postgres yang dipakai buat
// menjalankan tiap query.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { runP } from './stacks.js';
import { docker } from './docker.js';
import * as dbaas from './dbaas.js';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'db-api.json');
const NET = process.env.APPS_NETWORK || 'apps';

let apis = [];
try { apis = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const persist = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(apis, null, 2)); } catch {} };

export const forInstance = (instanceId) => apis.find(a => a.instanceId === instanceId) || null;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signJwt(payload, secret) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

async function freePort(from = 56000) {
  const used = new Set(apis.map(a => a.port));
  try {
    const list = await docker.listContainers();
    list.forEach(c => (c.Ports || []).forEach(p => p.PublicPort && used.add(p.PublicPort)));
  } catch {}
  for (let p = from; p < from + 500; p++) if (!used.has(p)) return p;
  throw new Error('No free port available');
}

const randPass = () => crypto.randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
const ensureRole = (role, opts) => `DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} ${opts};
    END IF;
  END $$;`;

/* dbQuery disuntik dari server.js (bukan diduplikasi di sini) — modul ini
   cuma butuh "cara menjalankan SQL", bukan detail koneksi pool-nya. */
export async function deploy(instanceId, dbQuery) {
  const inst = dbaas.getInstance(instanceId);
  if (inst.engine !== 'postgres') {
    throw new Error('REST API otomatis cuma didukung untuk PostgreSQL saat ini');
  }
  if (forInstance(instanceId)) throw new Error('API sudah pernah dibuat untuk basis data ini');

  const cfg = dbaas.credentials(instanceId);
  const base = inst.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  // Tiga role terpisah, persis pola Supabase:
  //  - authRole  (LOGIN): role yang dipakai PostgREST buat konek, sendirian
  //    tidak bisa apa-apa (NOINHERIT) — cuma jembatan buat SET ROLE.
  //  - anonRole  (NOLOGIN, TANPA grant apa pun): dipakai kalau request TIDAK
  //    bawa API key sama sekali. Ini yang bikin akses tanpa key otomatis
  //    ditolak, bukan malah kebuka lebar.
  //  - apiRole   (NOLOGIN, full akses schema public): baru dipakai kalau
  //    request bawa JWT valid dengan klaim role ini — itulah "API key"-nya.
  const authRole = 'auth_' + base;
  const anonRole = 'anon_' + base;
  const apiRole = 'api_' + base;
  const authPass = randPass();
  const jwtSecret = crypto.randomBytes(32).toString('base64url');

  await dbQuery(cfg, ensureRole(anonRole, 'NOLOGIN'));
  await dbQuery(cfg, ensureRole(apiRole, 'NOLOGIN'));
  await dbQuery(cfg, ensureRole(authRole, 'LOGIN NOINHERIT'));
  await dbQuery(cfg, `ALTER ROLE ${authRole} PASSWORD '${authPass}'`);
  await dbQuery(cfg, `GRANT ${anonRole} TO ${authRole}`);
  await dbQuery(cfg, `GRANT ${apiRole} TO ${authRole}`);

  await dbQuery(cfg, `GRANT ALL PRIVILEGES ON SCHEMA public TO ${apiRole}`);
  await dbQuery(cfg, `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${apiRole}`);
  await dbQuery(cfg, `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${apiRole}`);
  await dbQuery(cfg, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${apiRole}`);
  await dbQuery(cfg, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${apiRole}`);

  const port = await freePort();
  const containerName = `restapi-${inst.name}`;
  const dbUri = `postgres://${authRole}:${authPass}@${inst.container}:5432/${inst.database}`;

  const args = ['run', '-d', '--name', containerName, '--restart', 'unless-stopped',
    '--network', NET, '--memory', '128m',
    '-e', `PGRST_DB_URI=${dbUri}`,
    '-e', 'PGRST_DB_SCHEMA=public',
    '-e', `PGRST_DB_ANON_ROLE=${anonRole}`,
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`,
    '-p', `127.0.0.1:${port}:3000`,
    'postgrest/postgrest:latest'];
  const r = await runP('docker', args);
  if (r.code !== 0) throw new Error(r.out || 'Gagal menjalankan PostgREST');

  const apiKey = signJwt({ role: apiRole }, jwtSecret);
  const rec = { instanceId, name: inst.name, container: containerName, port,
    authRole, anonRole, apiRole, apiKey, created: Date.now() };
  apis.push(rec); persist();
  return rec;
}

export async function remove(instanceId, dbQuery) {
  const a = forInstance(instanceId);
  if (!a) return;
  await runP('docker', ['rm', '-f', a.container]);
  if (dbQuery) {
    const cfg = dbaas.credentials(instanceId);
    // Setiap statement dicoba sendiri-sendiri (bukan satu try besar) — kalau
    // satu urutan gagal, urutan lain tetap harus jalan supaya role tidak
    // nyangkut cuma gara-gara satu langkah revoke gagal. ALTER DEFAULT
    // PRIVILEGES wajib direvoke duluan, soalnya entrinya di pg_default_acl
    // bikin DROP ROLE ditolak Postgres walau tabelnya sendiri sudah lepas.
    const steps = [
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${a.apiRole}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${a.apiRole}`,
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${a.apiRole}`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${a.apiRole}`,
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${a.apiRole}`,
      `DROP ROLE IF EXISTS ${a.authRole}`,
      `DROP ROLE IF EXISTS ${a.apiRole}`,
      `DROP ROLE IF EXISTS ${a.anonRole}`,
    ];
    for (const sql of steps) { try { await dbQuery(cfg, sql); } catch {} }
  }
  apis = apis.filter(x => x.instanceId !== instanceId);
  persist();
}
