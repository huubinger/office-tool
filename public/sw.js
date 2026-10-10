// Service Worker nur fuer Push-Mitteilungen (kein Offline-Cache, damit immer die aktuelle Version laedt)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Neckarsulmer Konzerte', {
    body: data.body || '',
    icon: '/icons/nk-icon-192.png',
    badge: '/icons/nk-icon-192.png',
    data: { url: data.url || '/nk' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/nk', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find(c => c.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      return existing.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
