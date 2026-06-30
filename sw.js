// sw.js — offline cache. Same recipe as the metronome/fretboard siblings.
// IMPORTANT: bump CACHE on any file change, and keep ASSETS listing EVERY shipped
// file (cache-first means anything not listed is unavailable offline).
const CACHE = "sn-v3";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/main.js",
  "./js/ui.js",
  "./js/persistence.js",
  "./js/session.js",
  "./js/derive.js",
  "./js/theory/pitch.js",
  "./js/theory/spell.js",
  "./js/theory/scale.js",
  "./js/theory/chord.js",
  "./js/data/modes.js",
  "./js/data/feels.js",
  "./js/generators/section.js",
  "./js/generators/mainProgression.js",
  "./js/generators/alternatives.js",
  "./js/generators/index.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === "basic") {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => {
          if (req.mode === "navigate") {
            return caches.match("./index.html", { ignoreSearch: true })
              .then((c) => c || caches.match("./", { ignoreSearch: true }));
          }
        });
    })
  );
});
