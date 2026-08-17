// Service worker seperlunya: hanya menyimpan kerangka aplikasi supaya
// panel tetap terbuka saat jaringan putus. Data API TIDAK pernah di-cache,
// karena menampilkan status server yang basi lebih berbahaya daripada error.
const CACHE = 'panel-v2';
const SHELL = ['/', '/app.css', '/app.js', '/pages.js', '/pages2.js',
  '/pages3.js', '/pages4.js', '/pages5.js', '/pages6.js',
  '/icon.svg', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('push', (e) => {
  let data = { title: 'Home Server Panel', body: '' };
  try { data = e.data.json(); } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || 'Home Server Panel', {
    body: data.body || '', icon: '/icon.svg', badge: '/icon.svg',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    if (cs.length > 0) return cs[0].focus();
    return self.clients.openWindow('/');
  }));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
