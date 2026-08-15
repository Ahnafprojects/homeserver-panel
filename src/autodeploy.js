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
import net from 'node:net';

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
  return `services:\n  ${name}:\n    build:\n      context: .\n      dockerfile: Dockerfile\n${buildBlock}`
    + `    ports:\n      - "${port}:${svcPort}"\n${envBlock}    restart: unless-stopped\n`;
}

/* Cari port host yang bebas, mulai dari 'from'. */
export function findFreePort(from = 4000) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once('error', () => { s.close(); tryPort(p + 1); });
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(from);
  });
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
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), composeFor(name, det, opts));
  return det;
}
