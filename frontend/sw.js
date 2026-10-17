/* Service worker : réseau d'abord (jamais de version périmée), cache seulement
   en secours hors connexion. L'admin et les données d'équipe ne sont jamais mis en cache. */
const CACHE = "secteurs-v3";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/admin") || url.pathname.endsWith("admin.html")) return;
  // données des équipes (statuts, dons) et retours SumUp : jamais gardés en cache sur le téléphone
  if (url.pathname.startsWith("/api/equipe") || url.pathname.startsWith("/api/sumup") || url.pathname.startsWith("/sumup-retour")) return;

  event.respondWith((async () => {
    try {
      const resp = await fetch(req);
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return resp;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: false });
      if (cached) return cached;
      if (req.mode === "navigate") {
        const home = await caches.match("/");
        if (home) return home;
      }
      throw err;
    }
  })());
});
