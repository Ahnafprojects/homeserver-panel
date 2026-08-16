// Deploy otomatis untuk aplikasi web biasa (Next.js, Vite, Create React App,
// Node generik, atau situs statis polos) — tanpa pengguna perlu menulis
// Dockerfile atau docker-compose.yml sendiri. Panel yang mendeteksi jenis
// project-nya dari package.json/next.config, lalu men-generate berkas itu.
//
// Ini BUKAN pengganti fitur Stack manual (compose yang ditempel/di-edit
// sendiri) — itu tetap ada buat yang butuh kontrol penuh (banyak service,
// network custom, dst). Ini jalur pintas buat kasus paling umum: satu
// repo, satu website.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { runP } from './stacks.js';

/* Deteksi jenis project dari isi foldernya. */
export async function detect(dir) {
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); } catch {}

  if (!pkg) {
    if (fsSync.existsSync(path.join(dir, 'index.html'))) {
      return { type: 'static-plain', label: 'Situs statis (HTML polos)' };
    }
    throw new Error('Tidak ada package.json atau index.html — tidak bisa dideteksi otomatis. '
      + 'Pakai fitur "New stack" manual kalau project-nya bukan aplikasi web biasa.');
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  // Prisma butuh "prisma generate" dijalankan sebelum build — kalau tidak,
  // @prisma/client cuma stub kosong dan build gagal dengan error yang
  // membingungkan ("no exported member 'PrismaClient'"). Ini biasanya
  // dijalankan manual pas dev, jadi gampang lupa dimasukkan ke Dockerfile.
  const usesPrisma = !!deps.prisma && fsSync.existsSync(path.join(dir, 'prisma', 'schema.prisma'));

  if (deps.next) {
    let isExport = false;
    for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      try {
        const txt = await fs.readFile(path.join(dir, f), 'utf8');
        if (/output\s*:\s*['"]export['"]/.test(txt)) { isExport = true; break; }
      } catch {}
    }
    return isExport
      ? { type: 'next-static', label: 'Next.js (static export)', buildCmd: 'npm run build', buildDir: 'out', usesPrisma }
      : { type: 'next-server', label: 'Next.js (server)', buildCmd: 'npm run build', port: 3000, usesPrisma };
  }
  if (deps.vite) return { type: 'static-build', label: 'Vite', buildCmd: 'npm run build', buildDir: 'dist', usesPrisma };
  if (deps['react-scripts']) return { type: 'static-build', label: 'Create React App', buildCmd: 'npm run build', buildDir: 'build', usesPrisma };
  if (scripts.start) {
    return { type: 'node', label: 'Node.js (' + (scripts.build ? 'ada build step' : 'tanpa build') + ')',
      buildCmd: scripts.build ? 'npm run build' : null, port: 3000, usesPrisma };
  }
  throw new Error('Jenis project tidak dikenali (bukan Next.js/Vite/CRA, dan tidak ada script "start"). '
    + 'Pakai fitur "New stack" manual dan tulis Dockerfile-nya sendiri.');
}

/* Bangun isi Dockerfile sesuai jenis project. buildArgs = {KEY: value} yang
   dibutuhkan SAAT BUILD (mis. DATABASE_URL buat Prisma generate). */
function dockerfileFor(det, buildArgs = {}) {
  const argLines = Object.keys(buildArgs).flatMap(k => [`ARG ${k}`, `ENV ${k}=$${k}`]);

  if (det.type === 'static-plain') {
    return 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n';
  }
  if (det.type === 'next-static' || det.type === 'static-build') {
    return [
      'FROM node:22-alpine AS build',
      'WORKDIR /app',
      'COPY package.json package-lock.json* ./',
      'RUN npm ci',
      'COPY . .',
      ...argLines,
      det.usesPrisma ? 'RUN npx prisma generate' : '',
      `RUN ${det.buildCmd}`,
      '',
      'FROM nginx:alpine',
      `COPY --from=build /app/${det.buildDir} /usr/share/nginx/html`,
      'COPY nginx.conf /etc/nginx/conf.d/default.conf',
      'EXPOSE 80',
      '',
    ].filter(Boolean).join('\n');
  }
  // next-server / node
  return [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json package-lock.json* ./',
    'RUN npm ci',
    'COPY . .',
    ...argLines,
    det.usesPrisma ? 'RUN npx prisma generate' : '',
    det.buildCmd ? `RUN ${det.buildCmd}` : '',
    `EXPOSE ${det.port || 3000}`,
    'CMD ["npm", "start"]',
    '',
  ].filter(Boolean).join('\n');
}

const NGINX_CONF = 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n'
  + '  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n';

// Config nginx buat service "-lb" di depan app Node/Next.js — satu-satunya
// yang publish port ke host, app-nya sendiri cuma bisa diakses lewat jaringan
// docker internal. "resolver 127.0.0.11" (DNS bawaan docker) + $upstream
// pakai variabel bikin nginx nge-lookup ulang nama service TIAP REQUEST
// (bukan sekali pas start) — jadi begitu autoscale.js nambah/kurangi replika
// app-nya (docker compose up --scale), nginx otomatis ikut kebagi traffic-nya
// tanpa perlu di-restart atau di-reconfigure manual sama sekali.
const lbConfFor = (name, svcPort) => 'resolver 127.0.0.11 valid=5s;\nserver {\n  listen 80;\n'
  + '  location / {\n    set $upstream "http://' + name + ':' + svcPort + '";\n    proxy_pass $upstream;\n'
  + '    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n'
  + '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
  + '    proxy_set_header X-Forwarded-Proto $scheme;\n'
  + '    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n  }\n}\n';

function composeFor(name, det, { port, envVars = {} }) {
  const svcPort = (det.type === 'next-server' || det.type === 'node') ? (det.port || 3000) : 80;
  const keys = Object.keys(envVars);
  const isRuntime = det.type === 'next-server' || det.type === 'node';
  const buildBlock = keys.length && !isRuntime
    ? `      args:\n${keys.map(k => `        ${k}: "${String(envVars[k]).replace(/"/g, '\\"')}"`).join('\n')}\n`
    : '';
  const envBlock = keys.length && isRuntime
    ? `    environment:\n${keys.map(k => `      - ${k}=${envVars[k]}`).join('\n')}\n`
    : '';
  // Batas RAM container — tanpa ini satu proses Node yang kebocor
  // memori (atau situs yang lagi rame diakses) bisa gerus semua RAM
  // laptop ini (cuma 7,6 GB, dipakai bareng panel & stack lain). Kalau
  // kepentok batasnya, container itu SENDIRI yang di-OOM-kill oleh
  // kernel (lalu otomatis nyala lagi karena restart: unless-stopped),
  // bukan laptopnya yang macet total kehabisan RAM.
  const memLimit = isRuntime ? '768m' : '256m';
  // Batas CPU, simetris sama batas RAM di atas — laptop ini cuma 4 core
  // dipakai bareng panel & stack lain. Tanpa ini satu app yang lagi sibuk
  // (loop tak sengaja, traffic tinggi) bisa nyekek CPU semua container lain
  // termasuk panel-nya sendiri. Bukan hard-kill kayak RAM — kernel cuma
  // membagi jatah CPU-nya, app tetap jalan tapi dipelankan kalau kepentok.
  const cpuLimit = isRuntime ? '2' : '0.5';

  // "${name}" dikutip — nama stack yang bisa dipilih user (nama folder,
  // dsb) kadang berupa angka murni (mis. "333"). Tanpa tanda kutip, YAML
  // membaca "333:" sebagai KEY ANGKA, bukan teks, dan docker compose
  // menolaknya: "non-string key in services: 333".
  const appService = `  "${name}":\n    build:\n      context: .\n      dockerfile: Dockerfile\n${buildBlock}`
    + (isRuntime ? '' : `    ports:\n      - "${port}:${svcPort}"\n`)
    + `${envBlock}    mem_limit: ${memLimit}\n    cpus: "${cpuLimit}"\n    restart: unless-stopped\n`;

  if (!isRuntime) return `services:\n${appService}`;

  // App Node/Next.js: bukan app-nya sendiri yang publish port ke host, tapi
  // nginx "-lb" di depannya — supaya app-nya bisa diperbanyak jadi beberapa
  // replika (autoscale.js) tanpa tabrakan port, dan traffic tetap kebagi
  // rata ke replika mana pun yang masih hidup kalau salah satunya lagi
  // restart (habis kena OOM-kill, atau lagi update).
  const lbService = `  "${name}-lb":\n    image: nginx:alpine\n    ports:\n      - "${port}:80"\n`
    + `    volumes:\n      - ./nginx-lb.conf:/etc/nginx/conf.d/default.conf:ro\n`
    + `    depends_on:\n      - "${name}"\n    mem_limit: 64m\n    cpus: "0.5"\n    restart: unless-stopped\n`;
  return `services:\n${appService}${lbService}`;
}

/* Cari port host yang bebas, mulai dari 'from'.
   Dulu ini coba net.createServer().listen() DI DALAM container panel
   sendiri — kelihatan masuk akal, tapi salah total: container ini punya
   network namespace sendiri (beda dari host, sekalipun pid:host berbagi
   PID namespace), jadi port 4000 bisa "kosong" menurut panel padahal di
   laptop aslinya sudah dipakai stack lain lewat docker-proxy. Makanya
   auto-deploy bisa nyaranin port yang ternyata sudah kepakai, gagal pas
   "docker compose up" beneran jalan ("port is already allocated") —
   bukan pas dites di sini. Sekarang benar-benar ngecek port yang lagi
   LISTEN di host lewat nsenter (masuk namespace jaringan host beneran). */
export async function findFreePort(from = 4000) {
  const used = new Set();
  try {
    // -m -u -i sekalian (bukan cuma -n): "ss" tidak ada di dalam container
    // panel sendiri (cuma util-linux, bukan iproute2) — masuk juga ke mount
    // namespace host biar binary ss dari LAPTOP yang kepakai.
    const { out } = await runP('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', '--', 'ss', '-tln']);
    // Kolom ke-4 (0-based index 3) dari "ss -tln" itu alamat:port lokal,
    // mis. "0.0.0.0:4000", "[::]:4000", atau "*:4000".
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      const local = cols[3];
      const m = local && local.match(/:(\d+)$/);
      if (m) used.add(+m[1]);
    }
  } catch { /* nsenter/ss tidak ada — jatuh ke "anggap semua kosong" di bawah */ }
  for (let p = from; p < from + 2000; p++) {
    if (!used.has(p)) return p;
  }
  return from;
}

/* Tulis Dockerfile + docker-compose.yml + nginx.conf (kalau perlu) ke folder
   stack. TIDAK men-deploy — pemanggil yang jalankan stacks.deploy() sesudah
   ini, supaya log build-nya tetap mengalir lewat jalur streaming yang sama
   seperti deploy manual. */
export async function scaffold(dir, name, opts) {
  const det = await detect(dir);
  const dockerfile = dockerfileFor(det, det.type === 'next-server' || det.type === 'node' ? {} : opts.envVars);
  await fs.writeFile(path.join(dir, 'Dockerfile'), dockerfile);
  if (det.type === 'next-static' || det.type === 'static-build') {
    await fs.writeFile(path.join(dir, 'nginx.conf'), NGINX_CONF);
  }
  if (det.type === 'next-server' || det.type === 'node') {
    await fs.writeFile(path.join(dir, 'nginx-lb.conf'), lbConfFor(name, det.port || 3000));
  }
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), composeFor(name, det, opts));
  return det;
}
