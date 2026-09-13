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

async function call(path, { retry = true } = {}) {
  if (!cookie) await login();
  let r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  if (r.status === 401 && retry) {
    cookie = null;
    await login();
    return call(path, { retry: false });
  }
  if (!r.ok) throw new Error(`9Router ${path} -> HTTP ${r.status}`);
  return r.json();
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
