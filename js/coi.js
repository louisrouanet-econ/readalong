// Register the isolation service worker and reload once so it takes effect (needed for multi-threaded WASM).
export async function ensureIsolation() {
  if (self.crossOriginIsolated || !("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL("../coi-sw.js", import.meta.url), { scope: new URL("../", import.meta.url).pathname });
    if (sessionStorage.getItem("coi-reloaded")) return; // avoid reload loops (e.g. browsers without credentialless)
    sessionStorage.setItem("coi-reloaded", "1");
    if (reg.active || reg.installing || reg.waiting) {
      await navigator.serviceWorker.ready;
      location.reload();
    }
  } catch { /* isolation is an optimisation; the app still works single-threaded */ }
}
