// Web Push — notifikasi ke browser/HP walau tab panel tertutup.
// Pakai paket web-push (implementasi RFC 8291 sudah teruji luas) daripada
// nulis ulang enkripsi ECDH+HKDF+AES-GCM sendiri — resikonya salah kecil
// tapi bikin push gagal diam-diam, dan sulit dites end-to-end di sini.
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import * as admin from './admin.js';
import * as tunnel from './tunnel.js';

const STATE = process.env.STATE_DIR || '/state';
const SUBS_FILE = path.join(STATE, 'push-subs.json');

let subs = [];
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch {}
const save = () => { try { fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch {} };

function vapidKeys() {
  let pub = admin.getSecret('VAPID_PUBLIC');
  let priv = admin.getSecret('VAPID_PRIVATE');
  if (!pub || !priv) {
    const kp = webpush.generateVAPIDKeys();
    pub = kp.publicKey; priv = kp.privateKey;
    admin.setSecret('VAPID_PUBLIC', pub);
    admin.setSecret('VAPID_PRIVATE', priv);
  }
  return { pub, priv };
}

let configured = false;
function ensureConfigured() {
  // "mailto:admin@localhost" (subjek VAPID sebelumnya) ditolak Apple Web
  // Push (web.push.apple.com, dipakai Safari/iOS/macOS) dengan error
  // "BadJwtToken" -- Apple validasi klaim JWT-nya lebih ketat daripada
  // FCM (Android/Chrome), yang lolos-lolos aja walau subjeknya jelas
  // palsu. Pakai domain beneran punya panel ini kalau ada (lewat tunnel),
  // baru fallback ke localhost kalau belum ada domain sama sekali.
  const domain = tunnel.baseDomain?.();
  const subject = domain ? `mailto:admin@${domain}` : 'mailto:admin@localhost';
  const { pub, priv } = vapidKeys();
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
}

export const publicKey = () => vapidKeys().pub;

export function subscribe(username, subscription) {
  if (!subscription?.endpoint) throw new Error('subscription invalid');
  subs = subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
  subs.push({ username, subscription, created: Date.now() });
  save();
}

export function unsubscribe(username, endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => !(s.username === username && s.subscription.endpoint === endpoint));
  save();
  return subs.length < before;
}

export const listFor = (username) => subs.filter((s) => s.username === username)
  .map((s) => ({ endpoint: s.subscription.endpoint, created: s.created }));

export async function sendToAll(title, body) {
  if (subs.length === 0) return;
  ensureConfigured();
  const payload = JSON.stringify({ title, body });
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.subscription.endpoint);
      // Selain "subscription mati" (404/410, dibersihkan di bawah), error lain
      // (kredensial VAPID salah, JWT ditolak, dst) sebelumnya kebuang diam-diam
      // -- kebukti nyata bikin bug BadJwtToken ke Apple gak kelihatan sama
      // sekali sampai dicek manual. Sekarang dicatat ke log container.
      else console.error(`[webpush] gagal kirim ke ${s.subscription.endpoint.slice(0, 60)}...: ${e.statusCode || ''} ${e.body || e.message}`);
    }
  }));
  if (dead.length) {
    subs = subs.filter((s) => !dead.includes(s.subscription.endpoint));
    save();
  }
}
