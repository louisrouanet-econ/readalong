/* Cross-origin isolation for static hosting (GitHub Pages cannot send COOP/COEP headers).
   This service worker re-serves the site's own responses with those headers, which lets the
   voice engine use several CPU threads. Same idea as gzuidhof/coi-serviceworker (MIT). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  if (new URL(r.url).origin !== self.location.origin) return; // cross-origin requests pass through untouched
  // always revalidate the site's own files so an update is picked up at once (unchanged files return 304)
  const go = r.mode === "navigate" ? fetch(r) : fetch(r, { cache: "no-cache" });
  e.respondWith(
    go.then((res) => {
      if (res.status === 0) return res;
      const h = new Headers(res.headers);
      h.set("Cross-Origin-Embedder-Policy", "credentialless");
      h.set("Cross-Origin-Opener-Policy", "same-origin");
      h.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }).catch(() => fetch(r))
  );
});
