/**
 * Service worker — offline classroom boot (#224 §5, docs/CLASSROOM.md).
 *
 * This is a template: scripts/vite-plugin-precache.mjs replaces the two
 * placeholders below at build time and writes the result to `dist/sw.js`. It is
 * never imported by the app and never registered in dev.
 *
 * - Precached URLs are cache-first; everything else goes to the network as if
 *   there were no worker (nothing is cached at runtime).
 * - A navigation inside the scope, with any `?query`, gets the cached
 *   `index.html` — `?renderer=webgl2` and friends boot offline too.
 * - A new version installs and then **waits**. The page shows "Update
 *   available — reload"; only that click posts `skip-waiting`. No lesson is
 *   ever swapped out from under the class.
 * - Activation deletes this deployment's older caches (other apps on the same
 *   origin, and other deploy paths of this one, are left alone).
 */
const PRECACHE_VERSION = '__PRECACHE_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;

// sw.js sits at the deploy root (Pages /power_gen/, Contabo /powergen/, …).
const ROOT = new URL('./', self.location.href).href;
const CACHE_PREFIX = `seg-lab:${new URL(ROOT).pathname}:`;
const CACHE = CACHE_PREFIX + PRECACHE_VERSION;
const SHELL = new URL('index.html', ROOT).href;
const PRECACHED = new Set(PRECACHE_URLS.map((u) => new URL(u, ROOT).href));

self.addEventListener('install', (event) => {
  // `reload` skips the HTTP cache: Pages serves max-age=600, and a stale copy
  // stored here would outlive that by a whole cache version.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(
    PRECACHE_URLS.map((u) => new Request(new URL(u, ROOT).href, { cache: 'reload' }))
  )));
  // Deliberately no skipWaiting() here — an update waits for the page's click.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    // First install: adopt the open page, so the chunks it lazy-loads later
    // (recorder, workers) come from the same cached version. After an update
    // the page that asked is about to reload anyway.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

/** Cache key for a request, or null to leave it to the network. */
function precacheKey(request) {
  const url = new URL(request.url);
  url.hash = '';
  if (request.mode === 'navigate') {
    url.search = '';
    return url.href === ROOT || url.href === SHELL ? SHELL : null;
  }
  return PRECACHED.has(url.href) ? url.href : null;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const key = precacheKey(request);
  if (!key) return;
  event.respondWith((async () => {
    const hit = await (await caches.open(CACHE)).match(key);
    if (!hit) return fetch(request);
    // HEAD probes (src/wasm/index.ts checks sim_core.wasm this way) get the
    // cached status and headers, without the body.
    return request.method === 'HEAD'
      ? new Response(null, { status: hit.status, statusText: hit.statusText, headers: hit.headers })
      : hit;
  })());
});
