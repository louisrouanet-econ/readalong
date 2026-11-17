// Browser storage (IndexedDB). Everything stays on this device.
//   docs:   {id, title, kind, created, status, ...meta, doc (words/blocks/pages/sentences), plan (chunks)}
//   files:  {id, blob}           original upload (PDF pages are drawn from it)
//   audio:  {key: id#chunk, pcm (Int16Array buffer), rate, times (Float32Array: start,end per token), dur, sig}
//   notes:  {id, notes: [...]}
const DB_NAME = "readalong";
const VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "key" });
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage transaction aborted (the disk may be full)"));
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (store, key) => tx(store, "readonly", (s) => reqP(s.get(key))),
  put: (store, value) => tx(store, "readwrite", (s) => { s.put(value); }),
  del: (store, key) => tx(store, "readwrite", (s) => { s.delete(key); }),
  all: (store) => tx(store, "readonly", (s) => reqP(s.getAll())),
  /** delete every audio chunk of a document */
  async delAudio(id) {
    await tx("audio", "readwrite", (s) => { s.delete(IDBKeyRange.bound(id + "#", id + "#￿")); });
  },
  async audioKeys(id) {
    return tx("audio", "readonly", (s) => reqP(s.getAllKeys(IDBKeyRange.bound(id + "#", id + "#￿"))));
  },
  async usage() {
    try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
  },
};
