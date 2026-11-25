/* Service worker: shows signal alerts pushed from the server, even when the app is closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'XAUUSD signal', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'XAUUSD signal';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || 'xau',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    vibrate: [300, 120, 300, 120, 500],
    requireInteraction: d.tag !== 'test',
    renotify: true,
    data: { url: d.url || self.registration.scope }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
