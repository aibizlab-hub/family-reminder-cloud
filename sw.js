// Service Worker for Push Notifications
// family-reminder-cloud v3

const CACHE_NAME = 'frc-push-v1';

self.addEventListener('push', (event) => {
  let data = { title: '家庭提醒', body: '你有新的提醒！', icon: '/family-reminder-cloud/icon-192.png', badge: '/family-reminder-cloud/icon-72.png', tag: 'reminder', url: '/family-reminder-cloud/' };

  try {
    if (event.data) {
      const payload = event.data.json();
      if (payload.title) data.title = payload.title;
      if (payload.body) data.body = payload.body;
      if (payload.url) data.url = payload.url;
      if (payload.tag) data.tag = payload.tag;
    }
  } catch (e) {
    // plain text
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

// Install: claim clients immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
