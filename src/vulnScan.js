// Pindai kerentanan image pakai Trivy (aquasec/trivy) -- dijalankan sebagai
// container sekali-pakai lewat Docker Engine host, bukan dari dalam
// container panel sendiri. Alasan sama seperti registryCheck.js: jaringan
// bridge docker panel kadang gak bisa nyampe internet buat pull image
// Trivy / database kerentanannya, sementara host bisa. Jadi perintahnya
// dijalankan lewat nsenter ke namespace host (pola yang sama, sudah
// kebukti beres dipakai berkali-kali di codebase ini).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NSENTER = ['-t', '1', '-m', '-u', '-n', '-i', '--'];
const STATE = process.env.STATE_DIR || '/state';
const CACHE_FILE = path.join(STATE, 'vuln-scan-cache.json');

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
const save = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {} };

const TTL = 12 * 3600 * 1000; // hasil scan sama valid 12 jam, gak usah tiap request

// Output Trivy (--format json) itu SATU baris JSON raksasa (ratusan KB).
// stacks.js#run() merekonstruksi output-nya per-baris (split lalu join '\n'
// lagi) buat dukung streaming log baris-per-baris ke UI -- tapi kalau satu
// baris logisnya kepotong di batas chunk stream (pasti kejadian di output
// sebesar ini), rekonstruksinya nyisipin '\n' di TENGAH baris yang aslinya
// nyambung, ngerusak JSON-nya (kebukti: "Bad control character" pas parse).
// Makanya di sini baca stdout mentah sebagai buffer, tanpa split baris.
function execRaw(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    const chunks = []; const errChunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => errChunks.push(c));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(chunks).toString('utf8'),
      err: Buffer.concat(errChunks).toString('utf8') }));
    p.on('error', (e) => resolve({ code: 1, out: '', err: e.message }));
  });
}

export async function scanImage(image, { force = false } = {}) {
  const cached = cache[image];
  if (!force && cached && Date.now() - cached.t < TTL) return cached;

  const args = [...NSENTER, 'docker', 'run', '--rm',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', 'trivy-cache:/root/.cache/',
    'aquasec/trivy', 'image', '--quiet', '--format', 'json',
    '--severity', 'HIGH,CRITICAL', '--timeout', '5m', image];
  const { code, out, err } = await execRaw('nsenter', args);
  if (code !== 0) {
    const rec = { t: Date.now(), error: 'Scan gagal: ' + (err || out).slice(-300) };
    cache[image] = rec; save();
    return rec;
  }
  let parsed;
  try { parsed = JSON.parse(out); } catch {
    const rec = { t: Date.now(), error: 'Output Trivy tidak bisa dibaca' };
    cache[image] = rec; save();
    return rec;
  }
  const vulns = [];
  for (const r of parsed.Results || []) {
    for (const v of r.Vulnerabilities || []) {
      vulns.push({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion,
        fixed: v.FixedVersion || null, severity: v.Severity, title: v.Title || '' });
    }
  }
  vulns.sort((a, b) => (a.severity === 'CRITICAL' ? 0 : 1) - (b.severity === 'CRITICAL' ? 0 : 1));
  const rec = { t: Date.now(), image, total: vulns.length,
    critical: vulns.filter((v) => v.severity === 'CRITICAL').length,
    high: vulns.filter((v) => v.severity === 'HIGH').length,
    vulns: vulns.slice(0, 200) };
  cache[image] = rec; save();
  return rec;
}

export function cachedResult(image) { return cache[image] || null; }
export function allCached() { return cache; }
