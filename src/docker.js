// Klien Docker minimal lewat unix socket. Tanpa dependency luar —
// Docker Engine API itu HTTP biasa, cuma transportnya socket file.
import http from 'node:http';

const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

function request(method, path, body, raw = false) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: SOCK,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        if (raw) return resolve(res);
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let msg = data;
            try { msg = JSON.parse(data).message || data; } catch {}
            return reject(Object.assign(new Error(msg), { status: res.statusCode }));
          }
          if (!data) return resolve(null);
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const docker = {
  ping: () => request('GET', '/_ping'),
  info: () => request('GET', '/info'),
  version: () => request('GET', '/version'),
  // Ringkasan cepat image/container/volume/build-cache — dipakai disk
  // analyzer, jauh lebih cepat dari 'du' manual (docker sudah tau ukuran
  // tiap layer dari metadatanya sendiri, tidak perlu jalan-jalan disk).
  systemDf: () => request('GET', '/system/df'),

  listContainers: () => request('GET', '/containers/json?all=true'),
  inspect: (id) => request('GET', `/containers/${id}/json`),
  start: (id) => request('POST', `/containers/${id}/start`),
  stop: (id) => request('POST', `/containers/${id}/stop?t=10`),
  restart: (id) => request('POST', `/containers/${id}/restart?t=10`),
  remove: (id) => request('DELETE', `/containers/${id}?force=true`),

  // Statistik sekali ambil (stream=false), supaya tidak menahan koneksi.
  statsOnce: (id) => request('GET', `/containers/${id}/stats?stream=false`),

  // Log sebagai stream mentah — dipakai untuk tampilan log langsung.
  logStream: (id, tail = 200) =>
    request('GET',
      `/containers/${id}/logs?stdout=1&stderr=1&follow=1&tail=${tail}&timestamps=0`,
      null, true),

  logsOnce: (id, tail = 500) =>
    request('GET',
      `/containers/${id}/logs?stdout=1&stderr=1&follow=0&tail=${tail}`,
      null, true),

  listImages: () => request('GET', '/images/json'),
  listVolumes: () => request('GET', '/volumes'),
  listNetworks: () => request('GET', '/networks'),
  df: () => request('GET', '/system/df'),
};

// Docker membungkus log dengan header 8 byte per baris ketika container
// tidak pakai TTY. Tanpa dibersihkan, akan muncul karakter sampah di UI.
export function demuxDockerStream(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 8) break;
    const type = buf[i];
    // Header valid kalau byte pertama 0/1/2 dan tiga byte berikutnya nol.
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      out.push(buf.slice(i).toString('utf8'));
      break;
    }
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return out.join('');
}

// Hitung persentase CPU dari dua cuplikan statistik, seperti `docker stats`.
export function cpuPercent(s) {
  try {
    const cpu = s.cpu_stats, pre = s.precpu_stats;
    const d = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
    const sys = cpu.system_cpu_usage - pre.system_cpu_usage;
    const n = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
    if (sys > 0 && d > 0) return +((d / sys) * n * 100).toFixed(1);
  } catch {}
  return 0;
}

export function memUsage(s) {
  try {
    const used = s.memory_stats.usage - (s.memory_stats.stats?.cache || 0);
    return { used, limit: s.memory_stats.limit };
  } catch { return { used: 0, limit: 0 }; }
}

// Jumlah byte rx/tx KUMULATIF (sejak container nyala) dijumlah semua
// interface jaringannya — dipakai grafik "network per menit" (pemanggil
// yang ngitung selisih antar sampel, sama kayak requests database).
export function netStats(s) {
  try {
    const nets = Object.values(s.networks || {});
    return { rx: nets.reduce((a, n) => a + (n.rx_bytes || 0), 0),
      tx: nets.reduce((a, n) => a + (n.tx_bytes || 0), 0) };
  } catch { return { rx: 0, tx: 0 }; }
}

/* ── Image, volume, jaringan, exec ───────────────────────────────────────── */
export const dockerExtra = {
  pullImage: (name) => request('POST', `/images/create?fromImage=${encodeURIComponent(name)}`, null, true),
  removeImage: (id) => request('DELETE', `/images/${encodeURIComponent(id)}?force=true`),
  pruneImages: () => request('POST', '/images/prune?filters={"dangling":{"false":true}}'),

  createVolume: (name) => request('POST', '/volumes/create', { Name: name }),
  removeVolume: (name) => request('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`),
  inspectVolume: (name) => request('GET', `/volumes/${encodeURIComponent(name)}`),
  pruneVolumes: () => request('POST', '/volumes/prune'),

  createNetwork: (name) => request('POST', '/networks/create', { Name: name, Driver: 'bridge' }),
  removeNetwork: (id) => request('DELETE', `/networks/${id}`),
  connectNetwork: (id, container) => request('POST', `/networks/${id}/connect`, { Container: container }),
  disconnectNetwork: (id, container) => request('POST', `/networks/${id}/disconnect`, { Container: container, Force: true }),
  pruneNetworks: () => request('POST', '/networks/prune'),

  pruneContainers: () => request('POST', '/containers/prune'),
  // Sisa layer build docker (RUN npm ci, dst) yang numpuk tiap kali stack
  // di-rebuild -- gampang jadi puluhan GB di server yang sering deploy
  // ulang, dan gak kelihatan di /images biasa (bukan image jadi, cuma
  // layer perantara). all=true = hapus semua, bukan cuma yang dangling.
  pruneBuildCache: () => request('POST', '/build/prune?all=true'),

  // Terminal ke dalam container: buat sesi exec lalu ambil soket mentahnya.
  execCreate: (id, cmd) => request('POST', `/containers/${id}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd }),
  execStart: (execId) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: true });
    const req = http.request({
      socketPath: SOCK, path: `/exec/${execId}/start`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    req.on('upgrade', (res, sock) => resolve(sock));
    req.on('response', (res) => resolve(res));
    req.on('error', reject);
    req.write(payload); req.end();
  }),
  execResize: (execId, h, w) => request('POST', `/exec/${execId}/resize?h=${h}&w=${w}`),
};
