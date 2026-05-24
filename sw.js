/* WhenDidI - Service Worker.
 * Versioned cache for app shell. Network bypassed for user JSON files.
 * Bump CACHE_VERSION when shipping new assets.
 */

const CACHE_VERSION = 'whendidi-v2-2026-05-24';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/config.js',
  './js/db.js',
  './js/import-export.js',
  './js/stats.js',
  './js/drive.js',
  './js/app.js',
  './vendor/chart.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // best-effort: don't fail install if a single icon is missing
    await Promise.all(SHELL.map((url) =>
      cache.add(url).catch((e) => console.warn('cache miss', url, e))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache cross-origin (e.g., Google APIs)
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for shell assets
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((resp) => {
      if (resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});
