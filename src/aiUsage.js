// Ringkasan usage 9Router (ai.ahnaf.cloud) per akun & per model — 9Router
// sendiri cuma nampilin "Monthly"/"Bonus Pack" di quota tracker-nya tanpa
// rincian model, jadi kita tarik langsung dari API internalnya (localhost,
// tidak pernah keluar host ini) dan susun ulang di sini.
import * as admin from './admin.js';

const BASE = 'http://127.0.0.1:20128';
let cookie = null;

async function login() {
  const password = admin.getSecret('NINEROUTER_DASHBOARD_PASSWORD') || process.env.NINEROUTER_PASSWORD || '';
  if (!password) throw new Error('Password 9Router belum diset (vault: NINEROUTER_DASHBOARD_PASSWORD)');
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const setCookie = r.headers.get('set-cookie');
  if (!r.ok || !setCookie) throw new Error('Login 9Router gagal');
  cookie = setCookie.split(';')[0];
}

async function call(path, { method = 'GET', body, retry = true } = {}) {
  if (!cookie) await login();
  const opts = { method, headers: { Cookie: cookie } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r = await fetch(`${BASE}${path}`, opts);
  if (r.status === 401 && retry) {
    cookie = null;
    await login();
    return call(path, { method, body, retry: false });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`9Router ${path} -> HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// Model default buat provider yang endpoint /models per-koneksinya nggak
// didukung (mis. codebuddy-intl) — dipakai cuma buat tes real inference.
const FALLBACK_MODEL = {
  'codebuddy-intl': 'kimi-k2.5',
  antigravity: 'gemini-3-flash',
  'gemini-cli': 'gemini-3-flash-preview',
  'grok-cli': 'grok-4.6',
  xai: 'grok-4',
  github: 'gpt-4o-mini',
  codex: 'gpt-5.6-terra',
};
const GATEWAY_KEY = () => admin.getSecret('NINEROUTER_API_KEY') || process.env.NINEROUTER_API_KEY || '';

async function pickTestModel(connId, provider) {
  try {
    const r = await call(`/api/providers/${connId}/models`);
    const first = (r.models || [])[0];
    const id = first?.id || first?.model || first?.version;
    if (id) return id;
  } catch {}
  return FALLBACK_MODEL[provider] || null;
}

async function rawConnections() {
  const providers = await call('/api/providers');
  return providers.connections || providers || [];
}

export async function listProviders() {
  const items = await rawConnections();
  const groups = {};
  for (const c of items) {
    (groups[c.provider] ||= []).push({
      id: c.id, provider: c.provider, name: c.name || c.email || c.id,
      email: c.email || null, isActive: c.isActive,
    });
  }
  return { providers: groups };
}

export async function setActive(connId, isActive) {
  return call(`/api/providers/${connId}`, { method: 'PUT', body: { isActive } });
}

export async function deleteConnection(connId) {
  return call(`/api/providers/${connId}`, { method: 'DELETE' });
}

// Tes real inference SATU koneksi tertentu — bukan cuma cek token OAuth
// (banyak provider "valid" tokennya tapi tetap 403 pas dipakai beneran,
// kejadian nyata di kasus Antigravity/Gemini CLI kemarin). Sementara tes
// jalan, koneksi lain di provider yang sama dimatikan dulu biar request
// beneran kena akun ini, lalu dikembalikan seperti semula.
export async function testConnection(connId) {
  const key = GATEWAY_KEY();
  if (!key) throw new Error('NINEROUTER_API_KEY belum diset di vault');
  const items = await rawConnections();
  const conn = items.find((c) => c.id === connId);
  if (!conn) throw new Error('Koneksi tidak ditemukan');
  const siblings = items.filter((c) => c.provider === conn.provider && c.id !== connId && c.isActive);

  const model = await pickTestModel(connId, conn.provider);
  if (!model) return { ok: false, error: 'Tidak ada model yang bisa dipakai buat tes provider ini' };

  await Promise.all(siblings.map((s) => setActive(s.id, false)));
  if (!conn.isActive) await setActive(connId, true);
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `${conn.provider}/${model}`,
        messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
      }),
    });
    const text = await r.text();
    if (r.ok) return { ok: true, model };
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch {}
    return { ok: false, model, error: msg.slice(0, 300) };
  } finally {
    await Promise.all(siblings.map((s) => setActive(s.id, true)));
    if (!conn.isActive) await setActive(connId, false);
  }
}

// Cek kesehatan SEMUA koneksi (satu per satu, terisolasi) — dipakai job
// alert berkala. Ini beneran manggil inference (bukan cuma test token),
// jadi jangan dipanggil terlalu sering (default tiap 30 menit dari server.js).
//
// PENTING: status isActive ASLI tiap koneksi di-snapshot SEKALI di awal dan
// dikembalikan SEKALI di akhir (bukan toggle-restore berulang per koneksi) —
// supaya nggak ada race waktu banyak koneksi provider yang sama dites
// beruntun (percobaan pertama sempat bikin 8 koneksi ketinggalan nonaktif
// karena restore-per-langkah saling tabrakan).
export async function healthCheckAll() {
  const key = GATEWAY_KEY();
  if (!key) throw new Error('NINEROUTER_API_KEY belum diset di vault');
  const items = await rawConnections();
  const original = new Map(items.map((c) => [c.id, c.isActive]));
  const results = [];

  try {
    for (const c of items) {
      const siblings = items.filter((s) => s.provider === c.provider && s.id !== c.id);
      try {
        const model = await pickTestModel(c.id, c.provider);
        if (!model) {
          results.push({ id: c.id, provider: c.provider, name: c.name || c.email,
            ok: false, error: 'Tidak ada model yang bisa dipakai buat tes provider ini' });
          continue;
        }
        await Promise.all(siblings.map((s) => setActive(s.id, false)));
        await setActive(c.id, true);
        const r = await fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `${c.provider}/${model}`,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
        });
        const text = await r.text();
        if (r.ok) {
          results.push({ id: c.id, provider: c.provider, name: c.name || c.email, ok: true, model });
        } else {
          let msg = text;
          try { msg = JSON.parse(text)?.error?.message || text; } catch {}
          results.push({ id: c.id, provider: c.provider, name: c.name || c.email, ok: false, model, error: msg.slice(0, 300) });
        }
        // Kembalikan sibling provider ini segera (bukan tunggu akhir semua)
        // supaya provider lain yang jaraknya jauh di daftar nggak lama-lama nonaktif.
        await Promise.all(siblings.map((s) => setActive(s.id, original.get(s.id))));
      } catch (e) {
        results.push({ id: c.id, provider: c.provider, name: c.name || c.email, ok: false, error: e.message });
      }
    }
  } finally {
    // Jaring pengaman terakhir: paksa semua koneksi balik ke status asli,
    // apa pun yang terjadi di tengah jalan (error, timeout, dst).
    await Promise.all(items.map((c) => setActive(c.id, original.get(c.id)).catch(() => {})));
  }
  return { results, checkedAt: new Date().toISOString() };
}

export async function summary() {
  const [stats, providers] = await Promise.all([
    call('/api/usage/stats'),
    call('/api/providers'),
  ]);

  const byModel = Object.entries(stats.byModel || {}).map(([label, v]) => ({
    label, ...v,
  })).sort((a, b) => b.requests - a.requests);

  // Kelompokin per akun (connection) juga, biar kelihatan akun antigravity
  // mana yang beneran kepake vs nganggur — bukan cuma per-model global.
  const accounts = (providers.connections || providers || []).map((c) => ({
    id: c.id, provider: c.provider, name: c.name || c.email || c.id,
    isActive: c.isActive,
  }));

  return {
    totals: {
      requests: stats.totalRequests, promptTokens: stats.totalPromptTokens,
      completionTokens: stats.totalCompletionTokens, cachedTokens: stats.totalCachedTokens,
      cost: stats.totalCost,
    },
    byProvider: stats.byProvider || {},
    byModel,
    accounts,
  };
}
