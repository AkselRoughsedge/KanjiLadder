// Kanji Ladder service worker: makes the app open and run reviews offline.
// Bump VERSION when shipping app changes that must reach installed copies right away.
const VERSION = "kl-app-v2";
const AUDIO = "kl-audio-v1";
const FONTS = "kl-fonts-v1";
const SHELL = ["/", "/index.html", "/app.js", "/manifest.webmanifest", "/vendor/wanakana.min.js", "/vendor/supabase.js", "/data.json", "/audio/on.json", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  const keep = [VERSION, AUDIO, FONTS];
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => !keep.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req)) || (await cache.match("/index.html")) || Response.error();
  }
}
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(cacheFirst(req, FONTS));
    return; // Supabase and other APIs always go to the network
  }
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/audio/")) { e.respondWith(cacheFirst(req, AUDIO)); return; }
  if (url.pathname === "/data.json" || url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/icons/")) { e.respondWith(staleWhileRevalidate(req)); return; }
  e.respondWith(networkFirst(req)); // index.html, app.js: newest when online, cached when offline
});
