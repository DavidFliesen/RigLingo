/* RigLingo service worker v1.0.0 (ES5)
 * App shell: cache-first. Speech engine and its runtime from jsDelivr:
 * cached on first use so RigLingo keeps working offline afterwards.
 * Model weights are cached separately by Transformers.js itself. */
var VERSION = '1.0.0';
var SHELL_CACHE = 'riglingo-shell-' + VERSION;
var RUNTIME_CACHE = 'riglingo-runtime-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'worker.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      if (k.indexOf('riglingo-shell-') === 0 && k !== SHELL_CACHE) { return caches.delete(k); }
      return null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }
  var url = new URL(req.url);

  // Same-origin app shell: cache first, then network
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    }));
    return;
  }

  // Speech engine scripts and WASM runtime from jsDelivr: network first, cache fallback
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }, function () {
      return caches.match(req);
    }));
  }
  // Everything else (Hugging Face model files) passes through;
  // Transformers.js keeps its own model cache.
});
