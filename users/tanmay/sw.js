/* Powai Lake Survey service worker — the app opens and works with no network.
   • App files: cached on install. Pages network-first (updates arrive when online,
     with a 4 s timeout so a weak signal doesn't hang the field), everything else cache-first.
   • Map tiles: every tile seen while online is kept, up to TILE_MAX, oldest dropped first,
     so a map browsed before going out still shows offline.
   Bump VERSION whenever any cached file changes (keep it equal to app.js APP.version
   and package.json "version"). */
const VERSION = 'powai-lake-survey-1.0.0';
const TILE_CACHE = 'powai-lake-survey-tiles';
const TILE_MAX = 3000;
const SHELL = [
  './', './index.html', './app.js', './style.css', './sensor-core.js', './field-store.js', './manifest.json',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/jszip.min.js',
  './vendor/fonts/fonts.css',
  './vendor/fonts/atkinson-hyperlegible-latin-400-normal.woff2', './vendor/fonts/atkinson-hyperlegible-latin-ext-400-normal.woff2',
  './vendor/fonts/atkinson-hyperlegible-latin-700-normal.woff2', './vendor/fonts/atkinson-hyperlegible-latin-ext-700-normal.woff2'
];
const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|^server\.arcgisonline\.com$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
  }
}
async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
  return res;
}
let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try { const c = await caches.open(TILE_CACHE), keys = await c.keys(); for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]); }
  finally { trimming = false; }
}
async function tile(req) {
  const c = await caches.open(TILE_CACHE), hit = await c.match(req);
  if (hit) return hit;
  try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(trimTiles); return res; }
  catch (e) { return Response.error(); }
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.test(url.hostname)) { e.respondWith(tile(req)); return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) e.respondWith(networkFirst(req));
  else e.respondWith(cacheFirst(req));
});
