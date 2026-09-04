/* Sprint Timer Pro Service Worker
   2026-09-04 update
   - index.html / manifest.json / navigation: Network First
   - Service Worker update cache bypass is handled by index.html (updateViaCache:'none')
   - new worker activates immediately (skipWaiting + clients.claim)
   - only Sprint Timer Pro legacy caches are removed; other GitHub Pages apps are untouched
*/

const CACHE_NAME = 'sprint-timer-pro-v3-20260904';
const LEGACY_CACHE_NAMES = new Set([
  'sprint-timer-v2'
]);

const scopeUrl = new URL(self.registration.scope);
const CORE_ASSETS = [
  new URL('./', scopeUrl).toString(),
  new URL('./index.html', scopeUrl).toString(),
  new URL('./manifest.json', scopeUrl).toString()
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of CORE_ASSETS) {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response && response.ok) {
          await cache.put(url, response.clone());
        }
      } catch (_) {
        // One unavailable asset must not prevent the new Service Worker from installing.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      const isThisAppsOldCache =
        LEGACY_CACHE_NAMES.has(key) ||
        (key.startsWith('sprint-timer-pro-') && key !== CACHE_NAME);
      return isThisAppsOldCache ? caches.delete(key) : Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function networkFirst(request, fallbackToIndex = false) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (fallbackToIndex) {
      const indexUrl = new URL('./index.html', scopeUrl).toString();
      const rootUrl = new URL('./', scopeUrl).toString();
      const fallback = await cache.match(indexUrl) || await cache.match(rootUrl);
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);

  // MediaPipe/CDN and other cross-origin resources are left to the browser.
  if (requestUrl.origin !== self.location.origin) return;

  const isNavigation = request.mode === 'navigate';
  const isIndex = requestUrl.pathname.endsWith('/') || requestUrl.pathname.endsWith('/index.html');
  const isManifest = requestUrl.pathname.endsWith('/manifest.json');

  if (isNavigation || isIndex || isManifest) {
    event.respondWith(networkFirst(request, isNavigation || isIndex));
    return;
  }

  // Same-origin static files: network first, cached copy only as an offline fallback.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      return (await cache.match(request)) || Response.error();
    }
  })());
});
