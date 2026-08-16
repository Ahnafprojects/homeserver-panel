// Database sebagai layanan: bikin instance basis data dari web.
//
// Konsepnya seperti Supabase/Railway versi sendiri — pilih mesin, klik buat,
// dan panel yang mengurus container, volume, kata sandi, serta string koneksi.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { docker } from './docker.js';
import { runP } from './stacks.js';
import { makeSeriesStore } from './historyStore.js';

const STATE = process.env.STATE_DIR || '/state';
const FILE = path.join(STATE, 'databases.json');
const NET = process.env.APPS_NETWORK || 'apps';

let instances = [];
try { instances = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const persist = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(instances, null, 2)); } catch {} };

/* Katalog mesin yang didukung, lengkap dengan varian versinya. */
export const ENGINES = {
  postgres: {
    label: 'PostgreSQL', kind: 'postgres', port: 5432, user: 'postgres',
    versions: ['17-alpine', '16-alpine', '15-alpine'],
    image: (v) => `postgres:${v}`,
    env: (c) => ({ POSTGRES_PASSWORD: c.password, POSTGRES_USER: c.user,
      POSTGRES_DB: c.database }),
    volume: '/var/lib/postgresql/data',
    health: ['CMD-SHELL', 'pg_isready -U postgres'],
    uri: (c, host) => `postgresql://${c.user}:${c.password}@${host}:${c.port}/${c.database}`,
    note: 'Paling umum untuk aplikasi web. Pilihan aman kalau ragu.',
  },
  mariadb: {
    label: 'MariaDB / MySQL', kind: 'mysql', port: 3306, user: 'root',
    versions: ['11', '10.11'],
    image: (v) => `mariadb:${v}`,
    env: (c) => ({ MARIADB_ROOT_PASSWORD: c.password, MARIADB_DATABASE: c.database }),
    volume: '/var/lib/mysql',
    health: ['CMD', 'healthcheck.sh', '--connect'],
    uri: (c, host) => `mysql://${c.user}:${c.password}@${host}:${c.port}/${c.database}`,
    note: 'Cocok untuk aplikasi PHP/Laravel dan WordPress.',
  },
  mongo: {
    label: 'MongoDB', kind: 'mongo', port: 27017, user: 'root',
    versions: ['7', '6'],
    image: (v) => `mongo:${v}`,
    env: (c) => ({ MONGO_INITDB_ROOT_USERNAME: c.user,
      MONGO_INITDB_ROOT_PASSWORD: c.password, MONGO_INITDB_DATABASE: c.database }),
    volume: '/data/db',
    health: null,
    uri: (c, host) => `mongodb://${c.user}:${c.password}@${host}:${c.port}/${c.database}?authSource=admin`,
    note: 'Untuk data tanpa skema tetap. Boros memori di RAM terbatas.',
  },
  redis: {
    label: 'Redis', kind: 'redis', port: 6379, user: 'default',
    versions: ['7-alpine', '6-alpine'],
    image: (v) => `redis:${v}`,
    env: () => ({}),
    cmd: (c) => ['redis-server', '--requirepass', c.password, '--save', '60', '1',
      '--maxmemory', '256mb', '--maxmemory-policy', 'allkeys-lru'],
    volume: '/data',
    health: ['CMD', 'redis-cli', 'ping'],
    uri: (c, host) => `redis://default:${c.password}@${host}:${c.port}`,
    note: 'Untuk cache dan antrean, bukan penyimpanan utama.',
  },
};

const safe = (n) => {
  const s = String(n || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!s || s.length < 2) throw new Error('Name needs 2+ characters: letters, digits, dashes');
  return s;
};
const genPassword = () => crypto.randomBytes(18).toString('base64url');

export const listInstances = () => instances;

/* Gabungkan data tersimpan dengan keadaan container sebenarnya. */
export async function withStatus() {
  let running = [];
  try { running = await docker.listContainers(); } catch {}
  return instances.map(i => {
    const c = running.find(x => (x.Names || []).some(n => n === '/' + i.container));
    return { ...i, password: undefined,
      state: c?.State || 'missing', status: c?.Status || 'container tidak ada',
      exposed: (c?.Ports || []).filter(p => p.PublicPort).map(p => p.PublicPort) };
  });
}

export function getInstance(id) {
  const i = instances.find(x => x.id === id);
  if (!i) throw new Error('Instance not found');
  return i;
}

/* Kredensial lengkap dipakai oleh panel sendiri untuk menyambung. */
export function credentials(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  return { kind: e.kind, host: i.container, port: e.port,
    user: i.user, password: i.password, database: i.database };
}

export async function ensureNetwork() {
  try {
    const nets = await docker.listNetworks();
    if (!nets.some(n => n.Name === NET)) {
      await runP('docker', ['network', 'create', NET]);
    }
    // Panel harus ikut di jaringan yang sama, kalau tidak nama container
    // basis data tidak bisa diterjemahkan dan semua kueri gagal.
    // Nama host di dalam container sama dengan ID container-nya sendiri.
    const me = (await import('node:os')).hostname();
    const inspect = await runP('docker', ['inspect', me, '--format',
      '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}']);
    if (!inspect.out.split(/\s+/).includes(NET)) {
      await runP('docker', ['network', 'connect', NET, me]);
    }
  } catch {}
}

export async function create({ name, engine, version, database, expose }) {
  name = safe(name);
  const e = ENGINES[engine];
  if (!e) throw new Error('Unknown database engine');
  if (!e.versions.includes(version)) version = e.versions[0];
  if (instances.some(i => i.name === name)) throw new Error('Name already used');

  await ensureNetwork();

  const inst = {
    id: crypto.randomUUID().slice(0, 8),
    name, engine, version,
    container: `db-${name}`,
    volume: `db-${name}-data`,
    user: e.user,
    password: genPassword(),
    database: (database || name).replace(/[^a-zA-Z0-9_]/g, '') || 'app',
    port: e.port,
    exposePort: expose ? await freePort() : null,
    created: Date.now(),
  };

  const args = ['run', '-d', '--name', inst.container, '--restart', 'unless-stopped',
    '--network', NET, '-v', `${inst.volume}:${e.volume}`,
    // Batas memori penting di RAM 8 GB: satu basis data yang bocor
    // tidak boleh menjatuhkan seluruh server.
    '--memory', engine === 'mongo' ? '768m' : '512m', '--memory-swap', '1g'];

  for (const [k, v] of Object.entries(e.env(inst))) args.push('-e', `${k}=${v}`);
  // Port hanya diikat ke localhost. Akses dari luar lewat SSH tunnel,
  // bukan dibuka ke jaringan rumah.
  if (inst.exposePort) args.push('-p', `127.0.0.1:${inst.exposePort}:${e.port}`);
  args.push(e.image(version));
  if (e.cmd) args.push(...e.cmd(inst));

  const r = await runP('docker', args);
  if (r.code !== 0) throw new Error(r.out || 'Failed to create container');

  instances.push(inst); persist();
  return { ...inst, password: undefined };
}

async function freePort(from = 55000) {
  let used = new Set(instances.map(i => i.exposePort).filter(Boolean));
  try {
    const list = await docker.listContainers();
    list.forEach(c => (c.Ports || []).forEach(p => p.PublicPort && used.add(p.PublicPort)));
  } catch {}
  for (let p = from; p < from + 500; p++) if (!used.has(p)) return p;
  throw new Error('No free port available');
}

export async function action(id, act) {
  const i = getInstance(id);
  if (!['start', 'stop', 'restart'].includes(act)) throw new Error('Unknown action');
  const r = await runP('docker', [act, i.container]);
  if (r.code !== 0) throw new Error(r.out);
  return true;
}

export async function destroy(id, keepData) {
  const i = getInstance(id);
  await runP('docker', ['rm', '-f', i.container]);
  if (!keepData) await runP('docker', ['volume', 'rm', '-f', i.volume]);
  instances = instances.filter(x => x.id !== id); persist();
}

export async function rotatePassword(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  const pw = genPassword();
  if (e.kind === 'postgres') {
    const r = await runP('docker', ['exec', i.container, 'psql', '-U', i.user, '-c',
      `ALTER USER ${i.user} WITH PASSWORD '${pw}'`]);
    if (r.code !== 0) throw new Error(r.out);
  } else if (e.kind === 'mysql') {
    const r = await runP('docker', ['exec', i.container, 'mariadb', '-uroot',
      `-p${i.password}`, '-e',
      `ALTER USER 'root'@'%' IDENTIFIED BY '${pw}'; FLUSH PRIVILEGES;`]);
    if (r.code !== 0) throw new Error(r.out);
  } else {
    throw new Error('Password rotation is not supported for this engine');
  }
  i.password = pw; persist();
  return true;
}

/* String koneksi untuk aplikasi (internal) dan untuk alat di laptop (tunnel). */
export function connectionInfo(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  return {
    internal: e.uri(i, i.container),
    localhost: i.exposePort ? e.uri({ ...i, port: i.exposePort }, '127.0.0.1') : null,
    host: i.container, port: e.port, user: i.user, password: i.password,
    database: i.database, exposePort: i.exposePort,
    envExample: [
      `DATABASE_URL=${e.uri(i, i.container)}`,
      `DB_HOST=${i.container}`, `DB_PORT=${e.port}`,
      `DB_USER=${i.user}`, `DB_PASSWORD=${i.password}`, `DB_NAME=${i.database}`,
    ].join('\n'),
    tunnel: i.exposePort
      ? `ssh -L ${i.exposePort}:127.0.0.1:${i.exposePort} <user>@<ip-server>`
      : null,
  };
}

export async function logs(id, tail = 200) {
  const i = getInstance(id);
  const r = await runP('docker', ['logs', '--tail', String(tail), i.container]);
  return r.out;
}

/* Ukuran mentah dalam byte (bukan string terformat) — biar bisa dijumlah
   buat overview gabungan (semua instance), bukan cuma ditampilin sendiri-
   sendiri. Pemanggil yang format ke KB/MB/GB (fungsi bytes() di frontend). */
export async function sizeOf(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  try {
    if (e.kind === 'postgres') {
      const r = await runP('docker', ['exec', i.container, 'psql', '-U', i.user,
        '-d', i.database, '-tAc', 'SELECT pg_database_size(current_database())']);
      const n = parseInt(r.out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (e.kind === 'mysql') {
      const r = await runP('docker', ['exec', '-e', `MYSQL_PWD=${i.password}`, i.container, 'mysql',
        '-u', i.user, '-N', '-e',
        `SELECT ROUND(SUM(data_length+index_length)) FROM information_schema.tables WHERE table_schema='${i.database}'`]);
      const n = parseInt(r.out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (i.engine === 'mongo') {
      const r = await runP('docker', ['exec', i.container, 'mongosh', '--quiet', i.database,
        '--eval', 'db.stats().dataSize']);
      const n = parseFloat(r.out.trim());
      return Number.isFinite(n) ? n : null;
    }
    if (i.engine === 'redis') {
      const r = await runP('docker', ['exec', i.container, 'redis-cli', '-a', i.password,
        '--no-auth-warning', 'INFO', 'memory']);
      const m = r.out.match(/used_memory:(\d+)/);
      return m ? +m[1] : null;
    }
    return null;
  } catch { return null; }
}

/* Counter transaksi/query KUMULATIF langsung dari mesin basis datanya
   sendiri — beda dari queryStats() di bawah (yang cuma nyatet kueri lewat
   tab SQL panel). Ini nangkep SEMUA yang nyentuh database, termasuk dari
   aplikasi kamu sendiri, persis kayak "Total Requests" di dashboard
   Supabase. Nilainya kumulatif sejak database nyala — pemanggil yang
   ngitung selisih antar sampling buat dapet laju per menit. */
export async function requestCounterOf(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  try {
    if (e.kind === 'postgres') {
      const r = await runP('docker', ['exec', i.container, 'psql', '-U', i.user, '-d', i.database,
        '-tAc', "SELECT xact_commit, xact_rollback FROM pg_stat_database WHERE datname = current_database()"]);
      const [commit, rollback] = r.out.trim().split('|').map(Number);
      if (!Number.isFinite(commit)) return null;
      return { total: commit + (rollback || 0), errors: rollback || 0 };
    }
    if (e.kind === 'mysql') {
      const r = await runP('docker', ['exec', '-e', `MYSQL_PWD=${i.password}`, i.container, 'mysql',
        '-u', i.user, '-N', '-e', "SHOW GLOBAL STATUS LIKE 'Questions'"]);
      const n = parseInt(r.out.trim().split(/\s+/)[1], 10);
      return Number.isFinite(n) ? { total: n, errors: null } : null;
    }
    if (i.engine === 'mongo') {
      const r = await runP('docker', ['exec', i.container, 'mongosh', '--quiet', i.database, '--eval',
        'const o=db.serverStatus().opcounters; print(o.insert+o.query+o.update+o.delete+o.command+o.getmore)']);
      const n = parseInt(r.out.trim(), 10);
      return Number.isFinite(n) ? { total: n, errors: null } : null;
    }
    if (i.engine === 'redis') {
      const r = await runP('docker', ['exec', i.container, 'redis-cli', '-a', i.password,
        '--no-auth-warning', 'INFO', 'stats']);
      const m = r.out.match(/total_commands_processed:(\d+)/);
      return m ? { total: +m[1], errors: null } : null;
    }
    return null;
  } catch { return null; }
}

/* Jumlah koneksi aktif ke instance — beda query per mesin. */
export async function connectionCount(id) {
  const i = getInstance(id);
  const e = ENGINES[i.engine];
  try {
    if (e.kind === 'postgres') {
      const r = await runP('docker', ['exec', i.container, 'psql', '-U', i.user, '-d', i.database,
        '-tAc', 'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()']);
      const n = parseInt(r.out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (e.kind === 'mysql') {
      const r = await runP('docker', ['exec', '-e', `MYSQL_PWD=${i.password}`, i.container, 'mysql',
        '-u', i.user, '-N', '-e', 'SHOW STATUS LIKE "Threads_connected"']);
      const n = parseInt(r.out.trim().split(/\s+/)[1], 10);
      return Number.isFinite(n) ? n : null;
    }
    if (i.engine === 'redis') {
      const r = await runP('docker', ['exec', i.container, 'redis-cli', '-a', i.password,
        '--no-auth-warning', 'INFO', 'clients']);
      const m = r.out.match(/connected_clients:(\d+)/);
      return m ? +m[1] : null;
    }
    return null; // mongo: butuh perintah admin terpisah, dilewati biar simpel
  } catch { return null; }
}

/* Batas memori container basis data — ditentukan pas create() (lihat di
   atas), disamakan lagi di sini biar Overview bisa nunjukin "X / limit". */
export function memLimitOf(id) {
  const i = getInstance(id);
  return i.engine === 'mongo' ? '768m' : '512m';
}

/* ══ Riwayat RAM/CPU/Requests/Koneksi ════════════════════════════════════════
   Dua tingkat (detail 3 jam + ringkasan per-jam ~90 hari) lewat
   historyStore.js — dipakai bareng sama container (lihat containerHistory
   di server.js), bukan cuma database. req/reqErr kumulatif (diambil
   sample TERAKHIR pas rollup, bukan dirata-rata) karena pemanggil ngitung
   SELISIH antar titik buat dapet "berapa banyak per menit". */
const dbSeries = makeSeriesStore('db-history', ['req', 'reqErr']);
const fleetSeries = makeSeriesStore('db-fleet-history', ['req', 'reqErr']);

export function recordSample(id, sample) { dbSeries.record(id, sample); }
export function getHistory(id, opts) { return dbSeries.get(id, opts); }
/* Riwayat GABUNGAN (semua instance dijumlah per-tick) — dipakai grafik di
   overview gabungan (puncak halaman Databases), beda dari getHistory()
   yang per-instance. Direkam sekali per siklus sampling di server.js
   (bukan dihitung ulang dari riwayat per-instance) supaya sudah pasti dari
   tick yang SAMA, bukan nyampur timestamp yang beda-beda antar instance. */
export function recordFleetSample(sample) { fleetSeries.record('_fleet', sample); }
export function getFleetHistory(opts) { return fleetSeries.get('_fleet', opts); }


/* ══ Riwayat kueri ══════════════════════════════════════════════════════════
   Setiap kueri yang dijalankan lewat panel dicatat: teksnya, lama jalan,
   jumlah baris, dan hasilnya. Berguna untuk melacak kueri lambat dan
   mengingat kembali perintah yang pernah dipakai.                          */
const QLOG = path.join(STATE, 'query-log.json');
const QMAX = 500;
let qlog = [];
try { qlog = JSON.parse(fs.readFileSync(QLOG, 'utf8')); } catch {}
let qdirty = false;
setInterval(() => {
  if (!qdirty) return;
  qdirty = false;
  try { fs.writeFileSync(QLOG, JSON.stringify(qlog.slice(-QMAX))); } catch {}
}, 5000);

export function logQuery({ instance, database, sql, ms, rows, error, user, source }) {
  qlog.push({ id: crypto.randomBytes(4).toString('hex'), t: Date.now(),
    instance, database, sql: String(sql).slice(0, 4000), ms,
    rows: rows ?? null, error: error ? String(error).slice(0, 500) : null,
    user, source: source || 'sql' });
  if (qlog.length > QMAX) qlog.splice(0, qlog.length - QMAX);
  qdirty = true;
}
export function queryLog({ instance, onlyErrors, onlySlow, slowMs = 500, limit = 200 } = {}) {
  let out = qlog;
  if (instance) out = out.filter(q => q.instance === instance);
  if (onlyErrors) out = out.filter(q => q.error);
  if (onlySlow) out = out.filter(q => q.ms >= slowMs);
  return out.slice(-limit).reverse();
}
export function queryStats(instance) {
  const q = instance ? qlog.filter(x => x.instance === instance) : qlog;
  if (!q.length) return { total: 0, avgMs: 0, slow: 0, errors: 0 };
  return {
    total: q.length,
    avgMs: Math.round(q.reduce((a, x) => a + (x.ms || 0), 0) / q.length),
    maxMs: Math.max(...q.map(x => x.ms || 0)),
    slow: q.filter(x => (x.ms || 0) >= 500).length,
    errors: q.filter(x => x.error).length,
  };
}
export function clearQueryLog(instance) {
  qlog = instance ? qlog.filter(q => q.instance !== instance) : [];
  qdirty = true;
}


/* ══ Sambungan ke basis data yang sudah ada ═════════════════════════════════
   Untuk basis data yang TIDAK dibuat panel: milik aplikasi lain, container
   lama, atau yang jalan di laptop. Panel hanya menyimpan kredensialnya
   (kata sandi dienkripsi terpisah lewat brankas).                          */
const EXT = path.join(STATE, 'db-external.json');
let externals = [];
try { externals = JSON.parse(fs.readFileSync(EXT, 'utf8')); } catch {}
const persistExt = () => { try { fs.writeFileSync(EXT, JSON.stringify(externals, null, 2)); } catch {} };

export const listExternal = () => externals.map(e => ({ ...e, password: undefined }));

export function addExternal({ name, kind, host, port, user, password, database }) {
  if (!name || !host) throw new Error('Name and host are required');
  if (!['postgres', 'mysql'].includes(kind)) throw new Error('Type must be postgres or mysql');
  const id = 'ext-' + crypto.randomBytes(4).toString('hex');
  externals.push({ id, name, kind, host, port: +port || (kind === 'postgres' ? 5432 : 3306),
    user, password, database, external: true, created: Date.now() });
  persistExt();
  return id;
}
export function removeExternal(id) { externals = externals.filter(e => e.id !== id); persistExt(); }
export function updateExternal(id, patch) {
  const e = externals.find(x => x.id === id);
  if (!e) throw new Error('Connection not found');
  Object.assign(e, patch); persistExt();
}
export function externalCredentials(id) {
  const e = externals.find(x => x.id === id);
  if (!e) throw new Error('Connection not found');
  return { kind: e.kind, host: e.host, port: e.port, user: e.user,
    password: e.password, database: e.database };
}
/* Kredensial untuk id apa pun: instance milik panel atau sambungan luar. */
export function anyCredentials(id) {
  return String(id).startsWith('ext-') ? externalCredentials(id) : credentials(id);
}
export const isExternal = (id) => String(id).startsWith('ext-');


/* ══ Ekspor & impor ═════════════════════════════════════════════════════════
   pg_dump/mysqldump dijalankan lewat container basis datanya sendiri kalau
   instance dikelola panel; untuk sambungan luar dipakai klien yang terpasang
   di dalam panel. Dengan begitu versi dump selalu cocok dengan servernya.  */

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  const s2 = String(v);
  return /[",\n\r]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
}
export function toCsv(rows, fields) {
  const cols = fields?.length ? fields : Object.keys(rows[0] || {});
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
  return lines.join('\r\n');
}

/* Ubah baris jadi perintah INSERT — berguna untuk memindahkan sebagian data. */
export function toSqlInserts(rows, fields, table, kind) {
  const cols = fields?.length ? fields : Object.keys(rows[0] || {});
  const q = (n) => kind === 'postgres' ? `"${n}"` : `\`${n}\``;
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const head = `-- ${rows.length} baris dari ${table}\n` +
    `-- dibuat ${new Date().toISOString()}\n\n`;
  const body = rows.map(r =>
    `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map(c => lit(r[c])).join(', ')});`
  ).join('\n');
  return head + body + '\n';
}

/* Dump penuh: skema + data. */
export async function dumpDatabase(id, { schemaOnly, dataOnly, table } = {}) {
  const c = anyCredentials(id);
  const managed = !isExternal(id);
  if (c.kind === 'postgres') {
    const args = ['-U', c.user, '-d', c.database, '--no-owner', '--no-privileges'];
    if (schemaOnly) args.push('--schema-only');
    if (dataOnly) args.push('--data-only');
    if (table) args.push('-t', String(table).replace(/[^A-Za-z0-9_.]/g, ''));
    const r = managed
      ? await runP('docker', ['exec', '-e', `PGPASSWORD=${c.password}`, c.host, 'pg_dump', ...args])
      : await runP('pg_dump', ['-h', c.host, '-p', String(c.port), ...args],
          { env: { PGPASSWORD: c.password } });
    if (r.code !== 0) throw new Error(r.out || 'pg_dump gagal');
    return r.out;
  }
  const args = [`-u${c.user}`, `-p${c.password}`, '--skip-comments'];
  if (schemaOnly) args.push('--no-data');
  if (dataOnly) args.push('--no-create-info');
  args.push(c.database);
  if (table) args.push(String(table).replace(/[^A-Za-z0-9_]/g, ''));
  const r = managed
    ? await runP('docker', ['exec', c.host, 'mariadb-dump', ...args])
    : await runP('mariadb-dump', ['-h', c.host, '-P', String(c.port), ...args]);
  if (r.code !== 0) throw new Error(r.out || 'mariadb-dump gagal');
  return r.out;
}

/* Instance baru siap nerima koneksi? (create() cuma "docker run -d", ga
   nunggu database-nya beneran hidup — postgres/mariadb butuh beberapa
   detik pas pertama nyala). Dicoba tiap detik sampai maxMs. */
async function waitReady(inst, maxMs = 30000) {
  const e = ENGINES[inst.engine];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      if (e.kind === 'postgres') {
        const r = await runP('docker', ['exec', inst.container, 'pg_isready', '-U', inst.user]);
        if (r.code === 0) return true;
      } else if (e.kind === 'mysql') {
        const r = await runP('docker', ['exec', '-e', `MYSQL_PWD=${inst.password}`, inst.container,
          'mariadb-admin', 'ping', '-u', inst.user]);
        if (r.code === 0) return true;
      } else {
        return true; // mongo/redis: dianggap cukup begitu container jalan
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/* Clone instance basis data (buat staging sebelum ubah skema production,
   dst) — dump SUMBER (dumpDatabase, sudah ada di atas), bikin instance
   BARU KOSONG (create(), sudah ada juga), restore dump ke situ. Dump
   ditulis ke FILE dulu (docker cp), bukan lewat exec -i / stdin --
   menghindari konflik stdin sama sudo -S kalau dipanggil dari konteks
   yang juga butuh stdin buat hal lain (lihat catatan sesi soal ini). */
export async function cloneInstance(sourceId, newName) {
  const src = getInstance(sourceId);
  const dump = await dumpDatabase(sourceId, {});
  const dest = await create({ name: newName, engine: src.engine, version: src.version,
    database: src.database, expose: false });
  const ready = await waitReady(dest);
  if (!ready) throw new Error('Instance baru tidak siap menerima koneksi dalam 30 detik');

  const tmpFile = path.join('/tmp', `clone-${dest.id}.sql`);
  fs.writeFileSync(tmpFile, dump);
  try {
    const cp = await runP('docker', ['cp', tmpFile, `${dest.container}:/tmp/restore.sql`]);
    if (cp.code !== 0) throw new Error('Gagal salin dump ke container baru: ' + cp.out);
    const e = ENGINES[src.engine];
    const r = e.kind === 'postgres'
      ? await runP('docker', ['exec', dest.container, 'psql', '-U', dest.user, '-d', dest.database, '-f', '/tmp/restore.sql'])
      : await runP('docker', ['exec', '-e', `MYSQL_PWD=${dest.password}`, dest.container,
          'sh', '-c', `mariadb -u${dest.user} ${dest.database} < /tmp/restore.sql`]);
    if (r.code !== 0) { await destroy(dest.id, false); throw new Error('Restore ke instance baru gagal: ' + (r.out || '').slice(0, 400)); }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return { ...dest, password: undefined };
}

/* Pembaca CSV sederhana yang menghormati tanda kutip dan koma di dalam nilai. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* diabaikan */ }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}
