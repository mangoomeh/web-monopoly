// Offline support: precache the app shell, then serve from cache and refresh in the background.
const CACHE = "web-monopoly-v15";
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/data.js",
  "js/game.js",
  "js/solo.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: sameOrigin });
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") cache.put(req, res.clone());
          return res;
        })
        .catch(() => (req.mode === "navigate" ? cache.match("index.html") : undefined));
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return (await network) || Response.error();
    })
  );
});
