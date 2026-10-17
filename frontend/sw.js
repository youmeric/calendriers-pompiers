/* Service worker : réseau d'abord (jamais de version périmée), cache seulement
   en secours hors connexion. L'admin et les données d'équipe ne sont jamais mis en cache. */
const CACHE = "secteurs-v5";
// fond de carte préparé par l'espace équipe pour travailler sans réseau (gardé d'une version à l'autre)
const TILES = "tuiles";
const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|^data\.geopf\.fr$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== TILES) await caches.delete(key);
    await self.clients.claim();
  })());
});

// l'espace équipe demande à garder la page et ses fichiers (ouverture sans réseau)
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of data.urls.slice(0, 80)) {
      const url = new URL(u, self.location.origin);
      if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) continue;
      try {
        const resp = await fetch(url, { credentials: "same-origin" });
        if (resp.ok) await cache.put(url, resp);
      } catch { /* hors réseau : on garde l'ancienne copie */ }
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "GET" && TILE_HOSTS.test(url.hostname) && req.destination === "image") {
    // tuile préparée : servie depuis le téléphone ; sinon le réseau, comme d'habitude
    event.respondWith((async () => (await (await caches.open(TILES)).match(req.url)) || fetch(req))());
    return;
  }
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
