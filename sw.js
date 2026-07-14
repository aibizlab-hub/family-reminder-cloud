// Service Worker for Push Notifications + fresh-content caching
// family-reminder-cloud v4 (network-first so mobile never shows stale HTML)

const CACHE_NAME = 'frc-push-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ includeUncontrolled: true }))
      .then((clients) => clients.forEach((c) => {
        // 新 SW 激活時，強制重新整理所有開住嘅舊頁面（自動脫離舊快取）
        try {
          if (c.url && c.url.indexOf(self.location.origin + '/family-reminder-cloud') === 0) c.navigate(c.url);
        } catch (e) {}
      }))
  );
});

// Network-first for same-origin GET (always serve fresh index.html / assets)
// Cross-origin (api.github.com) and non-GET requests pass through untouched.
// CRITICAL: bypass HTTP cache entirely (cache:'no-store' + _sw query) so mobile
// (especially iOS web clips) NEVER serves a stale cached HTML/CSS/JS.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let GitHub API calls go straight to network

  // Build a cache-busting request that ignores HTTP disk cache
  const busted = new URL(req.url);
  busted.searchParams.set('_sw', String(Date.now()));
  const noStoreReq = new Request(busted.toString(), {
    method: 'GET',
    headers: req.headers,
    mode: req.mode,
    credentials: req.credentials,
    redirect: req.redirect,
    cache: 'no-store'
  });

  event.respondWith(
    fetch(noStoreReq)
      .then((res) => {
        // Only cache successful 200 responses (don't pollute cache with errors)
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ===== Push notifications =====
self.addEventListener('push', (event) => {
  let data = { title: 'HomeMemo', body: '你有新的提醒！', icon: '/family-reminder-cloud/icon-192.png', badge: '/family-reminder-cloud/icon-72.png', tag: 'reminder', url: '/family-reminder-cloud/' };

  try {
    if (event.data) {
      const payload = event.data.json();
      if (payload.title) data.title = payload.title;
      if (payload.body) data.body = payload.body;
      if (payload.url) data.url = payload.url;
      if (payload.tag) data.tag = payload.tag;
    }
  } catch (e) {
    data.body = event.data ? event.data.text() : data.body;
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    tag: data.tag,
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: { url: data.url },
    actions: [
      { action: 'open', title: '打開' },
      { action: 'close', title: '關閉' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'close') return;

  const url = event.notification.data.url || '/family-reminder-cloud/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
