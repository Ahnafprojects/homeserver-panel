// Penyimpan riwayat dua-tingkat yang bisa dipakai siapa saja (database,
// container, dst) — detail (disampling rutin, disimpan beberapa jam) +
// ringkasan per-jam (rata-rata, tahan lama) buat rentang waktu yang lebih
// panjang tanpa nyimpen jutaan titik detail selamanya. Awalnya cuma ada di
// dbaas.js, dipindah ke sini biar container (bukan cuma database) bisa
// pakai mekanisme yang sama tanpa duplikat kode.
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.STATE_DIR || '/state';
const DETAIL_MAX = 180; // 3 jam @ 60 detik
const HOURLY_MAX = 24 * 90; // ~90 hari
const RANGE_MS = { '30m': 1.8e6, '1h': 3.6e6, '4h': 1.44e7, '1d': 8.64e7, '7d': 6.048e8, '30d': 2.592e9 };

/* cumulativeFields: field yang nilainya SELALU NAIK (mis. counter request)
   — pas rollup per-jam, diambil sample TERAKHIR di jam itu (bukan
   dirata-rata), karena pemanggil biasanya ngitung SELISIH antar titik. */
export function makeSeriesStore(fileBase, cumulativeFields = []) {
  const detailFile = path.join(STATE, fileBase + '.json');
  const hourlyFile = path.join(STATE, fileBase + '-hourly.json');
  let detail = {}, hourly = {}, buckets = {};
  // Versi lama beberapa file nyimpen ARRAY telanjang (satu seri doang,
  // sebelum dipindah ke store yang key-based ini). Array vs object beda
  // total buat JSON.stringify (array diam-diam BUANG properti bernama
  // non-indeks) — migrasi di sini biar data lama gak diam-diam kebuang.
  try {
    const raw = JSON.parse(fs.readFileSync(detailFile, 'utf8'));
    detail = Array.isArray(raw) ? { _default: raw } : raw;
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(hourlyFile, 'utf8'));
    hourly = Array.isArray(raw) ? { _default: raw } : raw;
  } catch {}
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(STATE, { recursive: true });
      fs.writeFileSync(detailFile, JSON.stringify(detail));
      fs.writeFileSync(hourlyFile, JSON.stringify(hourly));
    } catch {}
  }, 30000);

  function rollup(key) {
    const b = buckets[key];
    if (!b || !b.samples.length) return;
    const s = b.samples;
    const fields = new Set(s.flatMap((p) => Object.keys(p)).filter((k) => k !== 't'));
    const point = { t: b.hourStart };
    for (const f of fields) {
      if (cumulativeFields.includes(f)) {
        point[f] = s[s.length - 1][f] ?? null;
      } else {
        const vals = s.map((p) => p[f]).filter((v) => v != null);
        point[f] = vals.length ? +(vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(2) : null;
      }
    }
    if (!hourly[key]) hourly[key] = [];
    hourly[key].push(point);
    if (hourly[key].length > HOURLY_MAX) hourly[key].splice(0, hourly[key].length - HOURLY_MAX);
  }

  return {
    record(key, sample) {
      if (!detail[key]) detail[key] = [];
      const point = { t: Date.now(), ...sample };
      detail[key].push(point);
      if (detail[key].length > DETAIL_MAX) detail[key].splice(0, detail[key].length - DETAIL_MAX);
      const hourStart = Math.floor(point.t / 3600000) * 3600000;
      if (!buckets[key] || buckets[key].hourStart !== hourStart) {
        rollup(key);
        buckets[key] = { hourStart, samples: [] };
      }
      buckets[key].samples.push(point);
      dirty = true;
    },
    get(key, { range, from, to } = {}) {
      const d = detail[key] || [], h = hourly[key] || [];
      if (!range && !from) return d; // tanpa param: 3 jam detail (perilaku lama)
      const toT = to || Date.now();
      const spanMs = from ? (toT - from) : RANGE_MS[range];
      if (!spanMs) return d;
      const since = from || (toT - spanMs);
      const src = spanMs <= 3 * 3600000 ? d : h;
      let out = src.filter((p) => p.t >= since && p.t <= toT);
      // Ringkasan per-jam baru ADA kalau minimal 1 jam sudah kelewat sejak
      // mulai disampling — kalau belum, "h" kosong dan grafik rentang
      // panjang keliatan kosong padahal ada data detail (cuma belum
      // selebar yang diminta). Mending tunjukin yang ada.
      if (out.length < 2 && src === h) out = d.filter((p) => p.t >= since && p.t <= toT);
      return out;
    },
    listKeys() { return Object.keys(detail); },
    dropKey(key) { delete detail[key]; delete hourly[key]; delete buckets[key]; dirty = true; },
  };
}
