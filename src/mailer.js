// Notifikasi email -- jalan bareng Telegram & Web Push buat kejadian
// 'urgent' (lihat events.js). Konfigurasi SMTP disimpan di vault
// terenkripsi yang sudah ada, sama seperti pola Telegram/Google Drive,
// supaya bisa diisi lewat web tanpa nyentuh .env.
import nodemailer from 'nodemailer';
import * as admin from './admin.js';

function cfg() {
  return {
    host: admin.getSecret('SMTP_HOST') || '',
    port: +(admin.getSecret('SMTP_PORT') || 587),
    secure: admin.getSecret('SMTP_SECURE') === '1',
    user: admin.getSecret('SMTP_USER') || '',
    pass: admin.getSecret('SMTP_PASS') || '',
    from: admin.getSecret('SMTP_FROM') || admin.getSecret('SMTP_USER') || '',
    to: admin.getSecret('SMTP_TO') || '',
  };
}

export const configured = () => { const c = cfg(); return !!(c.host && c.user && c.pass && c.to); };
export const settings = () => { const c = cfg(); return { host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from, to: c.to }; };

export function setConfig({ host, port, secure, user, pass, from, to }) {
  if (host !== undefined) admin.setSecret('SMTP_HOST', String(host).trim());
  if (port !== undefined) admin.setSecret('SMTP_PORT', String(port).trim());
  if (secure !== undefined) admin.setSecret('SMTP_SECURE', secure ? '1' : '0');
  if (user !== undefined) admin.setSecret('SMTP_USER', String(user).trim());
  if (pass) admin.setSecret('SMTP_PASS', String(pass)); // kosong = biarin password lama, gak ditimpa
  if (from !== undefined) admin.setSecret('SMTP_FROM', String(from).trim());
  if (to !== undefined) admin.setSecret('SMTP_TO', String(to).trim());
}

function transport() {
  const c = cfg();
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
}

export async function send(subject, html) {
  const c = cfg();
  if (!configured()) return;
  await transport().sendMail({
    from: c.from, to: c.to,
    subject: '[Home Server Panel] ' + subject,
    html: `<div style="font-family:sans-serif">${html}</div>`,
  });
}

export async function sendTest() {
  if (!configured()) throw new Error('Isi konfigurasi SMTP dulu (host, user, password, tujuan)');
  await send('Tes notifikasi email', 'Kalau email ini sampai, SMTP sudah tersambung dengan benar.');
}
