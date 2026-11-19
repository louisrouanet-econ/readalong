// ReadAlong (browser edition): library, extraction, voicing queue, read-along player, notes, pronunciation fixes.
import { ensureIsolation } from "./coi.js";
import { loadDict } from "./g2p.js";
import { Lexicon } from "./lexicon.js";
import { extract, loadPdfjs, decodeText } from "./ingest/index.js";
import { webSource, docxSource, alignWords, rangeBoxes, wordKey } from "./webpage.js";
import { fitTimes } from "./fittimes.js";
import { fetchLink, LinkError } from "./ingest/link.js";
import { layout, buildPlan } from "./speech.js";
import { Engine, pickBackend, modelFor, wav, hash, SilentError, BUSY_MARK } from "./engine.js";
import { Normalizer, Token } from "./normalize.js";
import { phonemizeTokens } from "./g2p.js";
import { Player, unlockOnTap } from "./player.js";
import { DeviceVoicePlayer, deviceVoiceAvailable } from "./devicevoice.js";
import { db } from "./db.js";
import { VOCAB } from "./vocab.js";

await ensureIsolation();

// ======================================================================= helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("readalong:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("readalong:" + k, JSON.stringify(v)); } catch { /* blocked */ } },
};
function fmt(t) {
  if (t == null || !isFinite(t)) return "–:––";
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
const mins = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
let toastTimer;
function toast(html, ms = 2800) {
  const t = $("#toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); };
function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ======================================================================= settings
const DEFAULTS = { voice: "af_heart", pace: 1, readFootnotes: false, readCitations: false, readReferences: false,
  readCaptions: true, readHeaders: false, readFigures: false, engine: "auto", quality: "standard" };
const settings = { ...DEFAULTS, ...store.get("settings", {}) };
const saveSettings = () => store.set("settings", settings);
const VOICES = [
  ["af_heart", "Heart", "warm, the most natural", "A"], ["af_bella", "Bella", "bright, expressive", "A−"],
  ["af_nicole", "Nicole", "soft, close", "B−"], ["af_aoede", "Aoede", "", "C+"], ["af_kore", "Kore", "", "C+"],
  ["af_sarah", "Sarah", "", "C+"], ["am_michael", "Michael", "calm, male", "C+"], ["am_fenrir", "Fenrir", "male", "C+"],
  ["am_puck", "Puck", "male", "C+"], ["af_nova", "Nova", "", "C"], ["af_alloy", "Alloy", "", "C"],
];
const planSig = (lex) => JSON.stringify([settings.readFootnotes, settings.readCitations, settings.readReferences,
  settings.readCaptions, settings.readHeaders, !!settings.readFigures, lex.version(), passageSize(), 4]);
// bump when text extraction improves: readings added earlier are re-read from their file when next opened
const EXTRACT_VERSION = 3;
const typeName = (t) => ({ para: "part", figure: "chart or table text", equation: "equation" }[t] || t);
const voiceSig = () => HEART ? `heart|${(+settings.pace).toFixed(2)}|mesm-v2f|1` : `${settings.voice}|${(+settings.pace).toFixed(2)}|kokoro-v1.0-ts|3`;

// ======================================================================= shared resources
const dictP = loadDict(new URL("../data/dict.json", import.meta.url));
const lexP = Lexicon.load(new URL("../data/names.json", import.meta.url));
const engine = new Engine();
let lexicon = null;
lexP.then((l) => (lexicon = l));

engine.on((info) => {
  let line = "Voice: not started";
  if (info.state === "loading") {
    const pct = info.total ? Math.round((100 * info.loaded) / info.total) : 0;
    line = `Voice: downloading the voice model, ${pct}% of ${info.mb} MB (only the first time)`;
  } else if (info.state === "building") line = "Voice: preparing the voice model";
  else if (info.state === "ready") {
    line = `Voice: ready (${info.backend === "webgpu" ? "graphics card" : "processor"}, ${info.dtype})` +
      (engine.speed ? `, ${engine.speed.toFixed(1)}× real time` : "");
  } else if (info.state === "error") line = `Voice: could not start (${info.message})`;
  $("#engine-line").textContent = line;
  if (R.id) updateStatus();
});

// A phone kills the whole tab when the voice runs out of memory, so nothing can be caught. The engine keeps a mark
// saying what it is doing while the model loads and while a passage is voiced (engine.js); it is cleared when that
// ends or the page is left normally. A mark found on the next visit means the tab died there. Then:
// - the step is shown on the page (so a screenshot tells what failed) and the voice waits for the Play button
//   instead of starting by itself, which would crash the tab again and again;
// - on the graphics chip: the processor is used from then on;
// - while voicing on the processor: passages get shorter (the memory needed grows with the passage's length).
// Phones only: on a computer, a mark left by a browser shut down mid-passage would wrongly slow it down.
const PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ||
  (() => { try { return localStorage.getItem("readalong:phone") === "1"; } catch { return false; } })(); // to test phone behaviour on a computer
const GPU_BAD = "readalong:gpu-crashed", SHORT = "readalong:short-passages", HEART_BAD = "readalong:heart-crashed";
// Phones: the ReadAlong voice (Kokoro on onnxruntime-web) needs more memory than Safari gives a tab on an iPhone, even for
// one short sentence (iPhone, November 2026). "Automatic" on a phone is Heart, a small copy of the same voice on its own
// engine (heart.worker.js); if Heart ever crashes the tab, the device's own voice (devicevoice.js). Both, and Kokoro, can
// be chosen in Settings. Computers are not affected.
const heartCrashed = () => { try { return !!localStorage.getItem(HEART_BAD); } catch { return false; } };
const DEVICE_VOICE = PHONE && deviceVoiceAvailable() && (settings.engine === "device" || (settings.engine === "auto" && heartCrashed()));
const HEART = PHONE && settings.engine === "auto" && !DEVICE_VOICE;
let gpuFailed = false, voiceHeld = false;
try {
  const raw = localStorage.getItem(BUSY_MARK);
  engine.unmark();
  localStorage.removeItem("readalong:gpu-starting"); // mark used by an earlier version
  if (PHONE && raw) {
    let crash; try { crash = JSON.parse(raw); } catch { crash = { backend: raw, step: "voicing a passage" }; }
    const voicing = /^voicing/.test(crash.step || "");
    if (crash.backend === "webgpu") localStorage.setItem(GPU_BAD, "1");
    else if (crash.backend === "heart") localStorage.setItem(HEART_BAD, "1");
    else if (voicing) localStorage.setItem(SHORT, String(Math.min(2, +(localStorage.getItem(SHORT) || 0) + 1)));
    voiceHeld = true;
    const where = crash.backend === "webgpu" ? "graphics chip" : "processor";
    setTimeout(() => window.readalongReport && window.readalongReport(
      `The page crashed last time (out of memory) while ${crash.step || "voicing"} (${where}). ` +
      (crash.backend === "webgpu" ? "The voice now uses the processor. " : crash.backend === "heart" ? "The phone's own voice is used from now on (Settings can change it). " : voicing ? "Passages are now shorter. " : "") +
      "The voice will start when you press Play."), 800);
  }
  gpuFailed = !!localStorage.getItem(GPU_BAD);
} catch { /* storage blocked */ }
const clearMark = () => engine.unmark();
addEventListener("pagehide", clearMark);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearMark(); });

// Phones and tablets voice short passages from the start (about one sentence): 110 phonemes need about 310 MB, where
// the 330 used on computers need about 640 MB, more than Safari allows a tab on an iPhone.
function passageSize() {
  if (DEVICE_VOICE) return { deviceText: 1 };
  if (HEART) return null; // Heart needs about 4.5 MB per second of audio: computer-length passages are fine
  let level = PHONE ? 1 : 0;
  try { level += +(localStorage.getItem(SHORT) || 0); } catch { /* storage blocked */ }
  return [null, { chunkTarget: 110, chunkMax: 150 }, { chunkTarget: 60, chunkMax: 90 }][Math.min(2, level)];
}
let gpuChecked = null, gpuToldCrash = false;
async function gpuUsable() {
  if (gpuChecked === null) {
    try { gpuChecked = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { gpuChecked = false; }
  }
  return gpuChecked;
}
async function startEngine() {
  let backend = pickBackend(settings.engine);
  // a phone's graphics chip ran out of memory with the full-precision model (iPhone, 2026): phones use the processor
  // unless the graphics card is chosen in Settings
  if (PHONE && settings.engine === "auto") backend = "heart";
  if (backend === "webgpu" && gpuFailed && !gpuToldCrash) {
    gpuToldCrash = true;
    try { if (localStorage.getItem(GPU_BAD)) toast("Last time, this device's graphics chip ran out of memory with the voice, so the processor is used instead (slower).", 7000); } catch { /* storage blocked */ }
  }
  if (backend === "webgpu" && (gpuFailed || !(await gpuUsable()))) backend = "wasm";
  try {
    await engine.start({ backend, quality: settings.quality });
  } catch (e) {
    if (backend !== "webgpu") throw e;
    gpuFailed = true;
    toast("The graphics card could not run the voice; using the processor instead (slower).", 5000);
    await engine.start({ backend: "wasm", quality: settings.quality });
  }
}

// ======================================================================= documents
// docs store: light metadata. files store: {id, bytes, name, view, pages, plan, sentences, names, sig, overrides}
async function heavy(id) { return db.get("files", id); }
async function setMeta(id, patch) {
  const m = (await db.get("docs", id)) || { id };
  Object.assign(m, patch);
  await db.put("docs", m);
  if (!$("#library").hidden) scheduleLibrary();
  return m;
}

async function addFiles(files) {
  for (const f of files) await addReading(f.name, new Uint8Array(await f.arrayBuffer()));
}
/** Keep a reading (a dropped file, or what a link led to) in this browser and start preparing it. */
async function addReading(name, bytes, url = null, title = "") {
  // ask the browser not to evict this site's storage (notes live only here)
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* not supported */ }
  const id = (name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40) || "reading") + "_" + Math.random().toString(36).slice(2, 7);
  await db.put("files", url ? { id, name, bytes, url } : { id, name, bytes });
  await setMeta(id, { id, title: title || name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), ...(title ? { titleLocked: true } : {}), created: Date.now(), status: "reading", message: "Reading the file", n: 0, done: 0, durs: {}, ...(url ? { url } : {}) });
  prepare(id).catch((e) => { console.error(e); setMeta(id, { status: "error", message: e.message || String(e) }); });
}

/** Extract text and build the speech plan (re-used for re-extraction and pronunciation changes). */
async function prepare(id, { reextract = false, forceOcr = false, upgrade = false } = {}) {
  await dictP; const lex = await lexP;
  const h = await heavy(id);
  if (!h.view || reextract || forceOcr || upgrade) {
    await setMeta(id, { status: "reading", message: "Reading the file" });
    // an automatic upgrade never runs OCR again (slow) and never replaces text that came from OCR
    const ex = await extract(h.bytes, { forceOcr, skipOcr: upgrade, onProgress: (msg) => setMeta(id, { message: msg }) });
    h.exv = EXTRACT_VERSION;
    if (upgrade && h.forcedOcr) return finishPlan(id, h, lex);
    if (upgrade && ex.needOcr && ex.needOcr.length) keepOcrPages(ex, h.view, new Set(ex.needOcr));
    if (!ex.blocks.some((b) => b.words.length)) throw new Error("No text found in this file.");
    if (forceOcr) h.forcedOcr = true; else if (reextract) delete h.forcedOcr;
    h.overrides = {}; // per-passage choices refer to the old passages
    store.set("webfail:" + id, false); // the new words may now be found on the web page
    h.view = layout(ex);
    h.pages = ex.pages;
    h.kind = ex.kind;
    const m = await db.get("docs", id);
    // a PDF's own title is often a leftover file name ("Microsoft Word - draft3.docx"): keep the file name then
    const junk = /^(microsoft (word|powerpoint)|untitled|document\d*$|slide \d)|\.(docx?|pdf|rtf|tex|indd|pptx?)$|^[\w-]+$/i.test(ex.title || "");
    const title = ex.title && ex.title.length > 3 && !junk && !m.titleLocked ? ex.title : m.title;
    await setMeta(id, { kind: ex.kind, title, pages: ex.pages.length });
  }
  return finishPlan(id, h, lex);
}
/** On an automatic upgrade, pages that needed OCR keep the text OCR found the first time (OCR is slow). */
function keepOcrPages(ex, oldView, pages) {
  const old = oldView.blocks.map((b) => ({ type: b.type, words: oldView.words.slice(b.w0, b.w1) }))
    .filter((b) => b.words.length && b.words.every((w) => pages.has(w.p)))
    .map((b) => ({ type: b.type, words: b.words.map(({ k, g, ...w }) => (g ? { ...w, glue: 1 } : w)) }));
  for (const b of old) {
    const p = b.words[0].p;
    const at = ex.blocks.findIndex((x) => x.words.length && x.words[0].p > p);
    ex.blocks.splice(at < 0 ? ex.blocks.length : at, 0, b);
  }
}
async function finishPlan(id, h, lex) {
  await setMeta(id, { status: "reading", message: "Working out what to say" });
  const plan = await buildPlan(h.view, { ...settings, ...passageSize() }, lex, h.overrides || {}, () => {});
  Object.assign(h, { plan: plan.chunks, sentences: plan.sentences, names: plan.names, archaic: plan.archaic, sig: planSig(lex) });
  await db.put("files", h);
  voicer.state.delete(id); // the queue must pick up the new plan (audio for unchanged passages is reused)
  const est = plan.chunks.reduce((a, c) => a + estDur(c), 0);
  await setMeta(id, { status: "voicing", message: "", n: plan.chunks.length, est });
  voicer.enqueue(id);
  if (R.id === id) await openReader(id, { keepWord: R.curWord });
}
const estDur = (c) => c.ids.length * 0.072 + c.pause;

async function deleteDoc(id) {
  voicer.forget(id);
  await Promise.all([db.del("docs", id), db.del("files", id), db.del("notes", id), db.delAudio(id)]);
}

// ======================================================================= voicing queue
// One reading is voiced at a time; the open reading goes first, starting where the listener is.
const voicer = {
  queue: [],
  state: new Map(), // id -> {keys[], have:Set, chunks}
  running: false,
  focus: { id: null, ci: 0 },
  listeners: new Set(),
  enqueue(id) { if (!this.queue.includes(id)) this.queue.push(id); this.run(); },
  forget(id) { this.queue = this.queue.filter((x) => x !== id); this.state.delete(id); },
  async load(id) {
    const h = await heavy(id);
    if (!h || !h.plan) return null;
    const vs = voiceSig();
    const keys = await Promise.all(h.plan.map(async (c) => `${id}#${await hash(vs + "|" + c.sig)}`));
    const stored = new Set(await db.audioKeys(id));
    const st = { keys, have: new Set(keys.map((k, i) => (stored.has(k) ? i : -1)).filter((i) => i >= 0)), chunks: h.plan, vs };
    this.state.set(id, st);
    return st;
  },
  async get(id) {
    const st = this.state.get(id);
    if (st && st.vs === voiceSig()) return st;
    return this.load(id);
  },
  next(st, from) {
    const n = st.chunks.length;
    for (let k = 0; k < n; k++) { const i = (from + k) % n; if (!st.have.has(i)) return i; }
    return -1;
  },
  async run() {
    if (this.running || voiceHeld || DEVICE_VOICE) return; // after a crash, wait for Play (see voiceHeld); the device voice needs no voicing ahead
    this.running = true;
    try {
      for (;;) {
        // the open reading first, then the others in order
        const ids = [...new Set([this.focus.id, ...this.queue].filter(Boolean))];
        let job = null;
        for (const id of ids) {
          const meta = await db.get("docs", id);
          if (!meta || meta.status === "reading" || meta.status === "error") continue;
          const st = await this.get(id);
          if (!st) continue;
          const ci = this.next(st, id === this.focus.id ? this.focus.ci : 0);
          if (ci >= 0) { job = { id, st, ci }; break; }
          await this.finish(id, st);
          this.queue = this.queue.filter((x) => x !== id);
        }
        if (!job) break;
        await startEngine();
        const { id, st, ci } = job;
        let rec;
        try {
          rec = await engine.renderChunk(st.chunks[ci], settings.voice, +settings.pace);
        } catch (e) {
          if (!(e instanceof SilentError) || engine.cfg.backend !== "webgpu") throw e;
          gpuFailed = true; // the graphics card gave silence: switch to the processor and try again
          engine.stop();
          toast("The graphics card produced silence; switching to the processor (slower).", 6000);
          continue;
        }
        if (this.state.get(id) !== st) continue; // plan changed meanwhile
        await db.put("audio", { key: st.keys[ci], ...rec });
        st.have.add(ci);
        const meta = await db.get("docs", id);
        if (meta) {
          meta.durs = meta.durs || {};
          meta.durs[st.keys[ci]] = rec.dur;
          meta.done = st.have.size;
          meta.n = st.chunks.length;
          meta.status = "voicing"; // finish() marks it ready once every passage is voiced
          await db.put("docs", meta);
        }
        for (const f of this.listeners) f(id, ci, rec);
        if (!$("#library").hidden) scheduleLibrary();
      }
    } catch (e) {
      console.error(e);
      toast("The voice stopped: " + esc(e.message), 6000);
    } finally {
      this.running = false;
    }
  },
  async finish(id, st) {
    const meta = await db.get("docs", id);
    if (!meta || meta.status === "ready") return;
    const total = st.keys.reduce((a, k) => a + ((meta.durs || {})[k] || 0), 0);
    // drop audio left over from earlier versions of the plan
    const keep = new Set(st.keys);
    for (const k of await db.audioKeys(id)) if (!keep.has(k)) await db.del("audio", k);
    if (meta.durs) for (const k of Object.keys(meta.durs)) if (!keep.has(k)) delete meta.durs[k];
    Object.assign(meta, { status: "ready", duration: total, done: st.keys.length, n: st.keys.length });
    await db.put("docs", meta);
    if (!$("#library").hidden) scheduleLibrary();
  },
};

// ======================================================================= library view
let libTimer = null;
function scheduleLibrary() { clearTimeout(libTimer); libTimer = setTimeout(renderLibrary, 150); }
const KIND = { pdf: "PDF", docx: "Word", html: "Web page", text: "Text" };

async function renderLibrary() {
  const docs = (await db.all("docs")).sort((a, b) => b.created - a.created);
  const notes = await db.all("notes");
  const nNotes = Object.fromEntries(notes.map((n) => [n.id, n.notes.length]));
  $("#empty").hidden = docs.length > 0;
  $("#index").innerHTML = docs.map((d) => {
    if (DEVICE_VOICE && d.status === "voicing") d = { ...d, status: "ready", duration: d.est };
    const meta = [];
    if (d.kind) meta.push(KIND[d.kind] || d.kind);
    if (d.pages) meta.push(`${d.pages} pp.`);
    if (d.status === "ready") meta.push(fmt(d.duration));
    else if (d.status === "voicing") {
      const pct = d.n ? Math.round((100 * d.done) / d.n) : 0;
      meta.push(`voiced ${pct}%` + (engine.info.state === "loading" ? " · downloading the voice" : engine.info.state === "ready" ? "" : " · open to continue"));
    } else if (d.status === "reading") meta.push(esc(d.message || "Reading"));
    if (nNotes[d.id]) meta.push(`${nNotes[d.id]} note${nNotes[d.id] > 1 ? "s" : ""}`);
    const pos = store.get("pos:" + d.id, null);
    if (pos && pos.t > 10) meta.push(`left off at ${fmt(pos.t)}`);
    const busy = d.status === "voicing" || d.status === "reading";
    return `<li data-id="${esc(d.id)}">
      <div><div class="t" data-open>${esc(d.title)}</div>
        <div class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}${d.status === "error" ? `<span class="err">${esc(d.message)}</span>` : ""}</div></div>
      <div class="acts">${d.status !== "error" && d.status !== "reading" ? `<button class="link" data-open>Read</button>` : ""}
        ${d.status === "error" ? `<button class="link" data-retry>Try again</button>` : ""}
        <button class="link" data-del>Delete</button></div>
      ${busy ? `<div class="progress"><i style="width:${d.status === "voicing" && d.n ? Math.round((100 * d.done) / d.n) : 4}%"></i></div>` : ""}
    </li>`;
  }).join("");
  const est = await db.usage();
  $("#storage-line").textContent = est && est.usage ? `Stored on this device: ${(est.usage / 1e6).toFixed(0)} MB` : "";
}
$("#index").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest("[data-open]")) location.hash = `#/read/${id}`;
  else if (e.target.closest("[data-retry]")) prepare(id, { reextract: true }).catch((er) => setMeta(id, { status: "error", message: er.message }));
  else if (e.target.closest("[data-del]")) {
    const b = e.target.closest("[data-del]");
    if (b.dataset.armed) { await deleteDoc(id); renderLibrary(); }
    else { b.dataset.armed = 1; b.textContent = "Delete? Click again"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete"; }, 3500); }
  }
});

async function renderSamples() {
  let list = [];
  try { list = await (await fetch(new URL("../samples/index.json", import.meta.url))).json(); } catch { /* none */ }
  $("#samples").innerHTML = list.map((s, i) => `<li data-i="${i}"><div><div class="t" data-add>${esc(s.title)}</div>
    <div class="meta"><span>${esc(s.author)}</span><span>${esc(s.note || "")}</span></div></div>
    <div class="acts"><button class="link" data-add>Add to my readings</button></div></li>`).join("");
  $("#samples").onclick = async (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li || !e.target.closest("[data-add]")) return;
    const s = list[+li.dataset.i];
    const text = await (await fetch(new URL("../samples/" + s.file, import.meta.url))).text();
    await addFiles([new File([text], s.title.replace(/[^A-Za-z0-9 ]/g, "") + ".txt", { type: "text/plain" })]);
    toast("Added. The voice is being prepared.");
  };
}

$("#pick").onclick = () => $("#file").click();
$("#file").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
// links: the reading is downloaded once, then kept in this browser like a dropped file
let linkBusy = false;
// right after an update a browser can still hold the previous page with the new scripts: reload once instead of failing
if (!$("#linkform")) {
  try { if (!sessionStorage.getItem("readalong:stale-reload")) { sessionStorage.setItem("readalong:stale-reload", "1"); location.reload(); } } catch { /* storage blocked */ }
} else $("#linkform").onsubmit = async (e) => {
  e.preventDefault();
  if (linkBusy) return;
  const input = $("#link"), status = $("#linkstatus"), go = $("#linkgo");
  const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle("err", err); };
  linkBusy = true; go.disabled = true;
  try {
    const got = await fetchLink(input.value, { onProgress: (m) => say(m + "…") });
    await addReading(got.name, got.bytes, got.url, got.title);
    input.value = ""; say("");
  } catch (er) {
    console.warn("ReadAlong link:", er);
    say(er instanceof LinkError ? er.message : "That link could not be opened. Download the file in your browser, then drop it on this page.", true);
  } finally { linkBusy = false; go.disabled = false; }
};
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { if ($("#library").hidden || !["Files", "text/uri-list"].some((t) => e.dataTransfer.types.includes(t))) return; e.preventDefault(); dragDepth++; $("#veil").hidden = false; });
document.addEventListener("dragover", (e) => { if (!$("#library").hidden) e.preventDefault(); });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#veil").hidden = true; } });
document.addEventListener("drop", (e) => {
  if ($("#library").hidden) return;
  e.preventDefault(); dragDepth = 0; $("#veil").hidden = true;
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  else {
    // a link dragged from another tab
    const u = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "").split("\n").find((l) => /^https?:\/\//i.test(l.trim()));
    if (u && $("#linkform")) { $("#link").value = u.trim(); $("#linkform").requestSubmit(); }
  }
});

// ======================================================================= routing
window.addEventListener("hashchange", route);
async function route() {
  const m = location.hash.match(/^#\/read\/([\w-]+)/);
  if (m) openReader(m[1]);
  else { closeReader(); $("#reader").hidden = true; $("#library").hidden = false; document.title = "ReadAlong"; renderLibrary(); }
}

// ======================================================================= reader state
const player = DEVICE_VOICE ? new DeviceVoicePlayer() : new Player();
const R = {
  id: null, meta: null, h: null, view: null, mode: "page", curWord: -1, curSent: -1, wordChunk: null, wordSent: null,
  times: new Map(), urls: new Map(), notes: [], follow: store.get("follow", true), followPauseUntil: 0, raf: 0,
  sheets: [], wordEls: [], hlWord: null, sentEls: [], pdf: null, lastSave: 0, rendering: new Set(),
};

function closeReader() {
  savePos();
  player.stop();
  cancelAnimationFrame(R.raf);
  for (const u of R.urls.values()) URL.revokeObjectURL(u);
  R.urls.clear(); R.times.clear();
  if (R.pdfTask) { R.pdfTask.destroy(); R.pdfTask = null; R.pdf = null; }
  if (R.io) R.io.disconnect();
  closeWeb();
  R.id = null;
  voicer.focus = { id: null, ci: 0 };
  closeDialog();
}

async function openReader(id, { keepWord } = {}) {
  const same = R.id === id;
  if (!same) closeReader();
  else { // re-opened after a re-plan: chunk numbering may have changed
    player.stop();
    for (const u of R.urls.values()) URL.revokeObjectURL(u);
    R.urls.clear(); R.times.clear();
  }
  $("#library").hidden = true;
  $("#reader").hidden = false;
  const meta = await db.get("docs", id);
  if (!meta) { toast("That reading is no longer here."); location.hash = ""; return; }
  R.id = id; R.meta = meta;
  document.title = meta.title + " · ReadAlong";
  $("#r-title").textContent = meta.title;
  $("#margin").hidden = !store.get("notesOpen", window.innerWidth > 980);
  $("#notes-tog").classList.toggle("on", !$("#margin").hidden);
  $("#follow").classList.toggle("on", R.follow);
  setSpeedLabel();
  if (meta.status === "reading" || meta.status === "error") {
    $("#docview").innerHTML = `<div class="textcol"><p class="label">${meta.status === "error" ? "Problem" : "Preparing"}</p><p>${esc(meta.message || "")}</p></div>`;
    if (meta.status === "reading") setTimeout(() => R.id === id && openReader(id), 1200);
    return;
  }
  await dictP; const lex = await lexP;
  let h = await heavy(id);
  if (h.kind === "pdf" && (h.exv || 1) < EXTRACT_VERSION) { await prepare(id, { upgrade: true }); return; } // better extraction available
  if (h.sig !== planSig(lex)) { await prepare(id); return; } // settings or pronunciations changed: re-plan
  R.h = h;
  R.view = h.view;
  R.wordChunk = new Int32Array(h.view.words.length).fill(-1);
  h.plan.forEach((c, ci) => { for (const [w] of c.spans) for (const wid of w) R.wordChunk[wid] = ci; });
  R.wordSent = new Int32Array(h.view.words.length).fill(-1);
  h.sentences.forEach((s, si) => { for (let i = s.w0; i < s.w1; i++) R.wordSent[i] = si; });
  R.pageWords = [];
  h.view.words.forEach((w, i) => { if (w.b) (R.pageWords[w.p] ||= []).push(i); });
  const st = await voicer.get(id);
  // the player: known durations for voiced chunks, estimates for the rest
  player.setup(h.plan.length, h.plan.map(estDur), (ci) => chunkUrl(ci));
  st.keys.forEach((k, ci) => { const d = (meta.durs || {})[k]; if (d && st.have.has(ci)) player.setDuration(ci, d); });
  player.setRate(store.get("speed", 1));
  if (DEVICE_VOICE) { // estimated word times for every passage, used for the highlight as voiced times are
    const est = h.plan.map(estDur);
    player.usePlan(h.plan, est);
    player.recs.forEach((rec, ci) => R.times.set(ci, rec));
  }
  const notesRec = await db.get("notes", id);
  R.notes = reanchor(notesRec ? notesRec.notes : [], h.view.words);
  // PDFs: the printed pages; web pages and Word documents: the page as it looks (unless its words could not be found on it before)
  const hasPages = (h.kind === "pdf" && h.pages && h.pages.length > 0) || ((h.kind === "html" || h.kind === "docx") && !store.get("webfail:" + id, false));
  $("#viewmode").hidden = !hasPages;
  R.mode = hasPages ? store.get("mode:" + id, store.get("mode", "page")) : "text";
  await renderView();
  renderNotes();
  voicer.focus = { id, ci: 0 };
  voicer.enqueue(id);
  const pos = store.get("pos:" + id, null);
  const startWord = keepWord != null && keepWord >= 0 ? keepWord : pos ? pos.w : null;
  if (startWord != null) { await seekToWord(startWord, false); centerOn(R.curWord, true); }
  loop();
  updateStatus();
}

async function storedTimes(st, ci) {
  const rec = await db.get("audio", st.keys[ci]);
  const fit = rec && fitTimes(st.chunks[ci], rec);
  if (!fit) { // missing, or recorded for other words: voice it again
    st.have.delete(ci);
    if (rec) await db.del("audio", st.keys[ci]);
    voicer.focus = { id: R.id, ci }; voicer.run();
    return null;
  }
  R.times.set(ci, fit);
  return fit;
}

async function chunkUrl(ci) {
  if (R.urls.has(ci)) return R.urls.get(ci);
  const st = await voicer.get(R.id);
  if (!st || !st.have.has(ci)) { voicer.focus = { id: R.id, ci }; voicer.run(); return null; }
  const rec = await storedTimes(st, ci);
  if (!rec) return null;
  const url = URL.createObjectURL(wav(new Int16Array(rec.pcm)));
  R.urls.set(ci, url);
  player.setDuration(ci, rec.dur);
  if (R.urls.size > 10) { // keep memory bounded
    for (const [k, u] of R.urls) if (Math.abs(k - ci) > 3) { URL.revokeObjectURL(u); R.urls.delete(k); R.times.delete(k); if (R.urls.size <= 8) break; }
  }
  return url;
}
async function chunkTimes(ci) {
  if (R.times.has(ci)) return R.times.get(ci);
  const st = await voicer.get(R.id);
  if (!st || !st.have.has(ci)) return null;
  return storedTimes(st, ci);
}

voicer.listeners.add((id, ci, rec) => {
  if (id !== R.id) return;
  player.setDuration(ci, rec.dur);
  player.chunkReady(ci);
  updateStatus();
});

function updateStatus() {
  if (!R.id) return;
  const st = voicer.state.get(R.id);
  const el = $("#r-status");
  if (DEVICE_VOICE) { el.textContent = ""; $("#voiced").style.width = "100%"; $("#t-dur").textContent = "~" + fmt(player.duration); return; }
  if (!st) { el.textContent = ""; return; }
  const n = st.chunks.length, done = st.have.size;
  if (engine.info.state === "loading") {
    const pct = engine.info.total ? Math.round((100 * engine.info.loaded) / engine.info.total) : 0;
    el.innerHTML = `Downloading the voice <b>${pct}%</b> of ${engine.info.mb} MB, only the first time`;
  } else if (done < n) {
    const left = st.chunks.reduce((a, c, i) => a + (st.have.has(i) ? 0 : estDur(c)), 0);
    const eta = engine.speed ? left / engine.speed : null;
    el.innerHTML = `Voicing <b>${Math.round((100 * done) / n)}%</b>` + (eta ? `, about ${mins(eta)} left` : "") +
      (engine.speed && engine.speed < 1.05 ? " · slower than real time on this device" : "");
  } else el.textContent = "";
  // the voiced part of the timeline
  let firstMissing = 0;
  while (firstMissing < n && st.have.has(firstMissing)) firstMissing++;
  $("#voiced").style.width = (player.duration ? (100 * player.offsets[firstMissing]) / player.duration : 0) + "%";
  $("#t-dur").textContent = (done < n ? "~" : "") + fmt(player.duration);
}

// ======================================================================= rendering the document
async function renderView() {
  const view = $("#docview");
  R.renderSeq = (R.renderSeq || 0) + 1;
  $$("#viewmode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === R.mode));
  R.hlWord = null; R.sentEls = []; R.wordEls = []; R.sheets = []; R.curWord = -1; R.curSent = -1;
  if (R.io) R.io.disconnect();
  closeWeb();
  if (R.mode === "page" && (R.h.kind === "html" || R.h.kind === "docx")) {
    if (!(await renderWebPage(view))) { // the page could not be matched with its words: the text view instead
      R.mode = "text";
      $("#viewmode").hidden = true;
      $$("#viewmode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === R.mode));
      toast("This page's layout could not be matched with its words, so it is shown as text.", 5000);
      renderText(view);
    }
  } else if (R.mode === "page") await renderPages(view);
  else renderText(view);
  applyZoom();
  renderPins();
}

// ----------------------------------------------------------------------- web pages as they look
// The page is drawn in a frame without scripts (sandbox without allow-scripts; webpage.js also removes them). The frame
// is as tall as the page and does not take clicks: the reader scrolls, and a layer above it (.ov) takes clicks and holds
// the highlight, as on a PDF page. Each word read aloud is a Range on the page (webpage.js), measured when needed, so
// zooming, resizing and late images are followed.
const WEB_MIN_MATCH = 0.85; // share of the words read aloud that must be found on the page
function closeWeb() {
  if (!R.web) return;
  R.web.ro.disconnect();
  clearTimeout(R.web.t);
  R.web = null;
}
async function renderWebPage(view) {
  const id = R.id;
  if (store.get("webfail:" + id, false)) return false;
  const docx = R.h.kind === "docx";
  view.innerHTML = `<div class="pages"><div class="sheet web"><div class="webscale"><iframe class="webframe" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="The original page" tabindex="-1"></iframe><div class="ov"></div></div></div></div>`;
  const frame = $("iframe", view), sheet = $(".sheet", view), scaleEl = $(".webscale", view);
  $("#scroll").scrollTop = 0;
  const seq = R.renderSeq;
  let src;
  try { // a Word document is first drawn as Word lays it out (pages, fonts, images), by docx-preview
    src = docx ? webSource(await docxSource(new Uint8Array(R.h.bytes)), null) : webSource(decodeText(new Uint8Array(R.h.bytes)), R.h.url);
  } catch (e) { console.warn("ReadAlong: the document could not be drawn", e); return false; }
  if (R.renderSeq !== seq || !frame.isConnected) return true;
  const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
  frame.srcdoc = src;
  // "load" waits for every image and style sheet of the page; the text is enough (late images are followed below)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([loaded, sleep(4000)]);
  for (let k = 0; k < 100 && frame.isConnected && !(frame.contentDocument && frame.contentDocument.URL === "about:srcdoc" && frame.contentDocument.readyState !== "loading"); k++) await sleep(100);
  if (R.id !== id || R.renderSeq !== seq || !frame.isConnected) return true; // another view was asked for meanwhile
  const doc = frame.contentDocument;
  if (!doc || !doc.body) return false;
  const v = R.view;
  const ranges = alignWords(doc, v.words);
  // enough of what is read aloud must be on the page, and visible there
  let want = 0, got = 0;
  v.blocks.forEach((b) => { if (b.spoken) for (let i = b.w0; i < b.w1; i++) if (wordKey(v.words[i].t)) { want++; if (rangeBoxes(ranges[i]).length) got++; } });
  console.info(`ReadAlong: ${got} of ${want} words read aloud were found on the page`);
  if (!want || got / want < WEB_MIN_MATCH) {
    store.set("webfail:" + id, true);
    return false;
  }
  R.web = { frame, doc, sheet, ov: $(".ov", sheet), ranges, heights: [], t: 0, ro: null, scale: 1, fitWidth: docx };
  const fit = () => {
    const w = R.web;
    if (!w) return;
    if (w.fitWidth) {
      // a Word document keeps its printed page width and is scaled to the reader's width, like a PDF page
      const wrap = doc.querySelector(".docx-wrapper") || doc.body, ws = doc.defaultView.getComputedStyle(wrap);
      const pageW = Math.max(300, ...[...doc.querySelectorAll("section.docx")].map((p) => p.offsetWidth));
      const natural = Math.ceil(pageW + (parseFloat(ws.paddingLeft) || 0) + (parseFloat(ws.paddingRight) || 0));
      if (frame.style.width !== natural + "px") { frame.style.width = natural + "px"; scaleEl.style.width = natural + "px"; }
      w.scale = sheet.clientWidth / natural;
      scaleEl.style.transform = `scale(${w.scale})`;
    }
    // the page's own height (the document's scroll height never falls below the frame's, so it could only grow)
    const body = doc.body, cs = doc.defaultView.getComputedStyle(body);
    const wide = doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1; // room for the sideways scrollbar
    const h = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().bottom) + (parseFloat(cs.marginBottom) || 0) + (wide ? 18 : 0));
    const last = w.heights[w.heights.length - 1] || 0;
    if (Math.abs(h - last) > 1) {
      // a part as tall as the window grows with the frame; stop following after a few equal steps
      w.heights.push(h);
      const d = w.heights.slice(-4).map((x, k, a) => (k ? x - a[k - 1] : 0)).slice(1);
      if (!(d.length === 3 && d.every((x) => x > 0 && Math.abs(x - d[0]) < 2))) frame.style.height = h + "px";
    }
    if (w.fitWidth) sheet.style.height = Math.ceil(parseFloat(frame.style.height) * w.scale) + "px";
    clearTimeout(w.t);
    w.t = setTimeout(webOverlays, 120);
  };
  R.web.ro = new ResizeObserver(fit);
  R.web.ro.observe(doc.body);
  R.web.ro.observe(frame);
  R.web.ro.observe(sheet); // zoom and window size
  // The page takes the mouse, so wide tables and side-scrolling boxes scroll as on the original. Its own scripts
  // never run (sandbox); these listeners are the reader's: a click reads from the word under it (links are not
  // followed), keys and the wheel do what they do in the reader, and sideways scrolling moves the highlight along.
  doc.addEventListener("click", (e) => {
    e.preventDefault();
    if (String(doc.getSelection() || "")) return; // selecting text
    webClick(e.clientX, e.clientY);
  }, true);
  doc.addEventListener("keydown", onKey);
  ["wheel", "touchmove"].forEach((ev) => doc.addEventListener(ev, pauseFollow, { passive: true }));
  doc.addEventListener("scroll", () => { clearTimeout(R.web && R.web.t); if (R.web) R.web.t = setTimeout(webOverlays, 60); }, true);
  fit();
  webOverlays();
  return true;
}
/** A click on the page (in the page's own pixels): read from the nearest word, as on a PDF page. */
function webClick(x, y) {
  let best = -1, bd = 1e9;
  R.web.ranges.forEach((rg, i) => {
    if (!rg) return;
    for (const b of rangeBoxes(rg)) {
      if (Math.abs(b.top - y) > 300) continue;
      const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0, dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < bd) { bd = d; best = i; }
    }
  });
  if (best < 0 || bd > 600) return;
  readFromClick(best);
}
/** Boxes of word wi relative to the page layer (.ov), or []. */
function webBoxes(wi) {
  return R.web ? rangeBoxes(R.web.ranges[wi]) : [];
}
function putBox(el, b) {
  Object.assign(el.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
}
/** Parts not read aloud are hatched; drawn again whenever the page's layout changes. */
function webOverlays() {
  const w = R.web;
  if (!w) return;
  $$(".skipzone", w.ov).forEach((d) => d.remove());
  const v = R.view;
  for (const b of v.blocks) {
    if (b.spoken) continue;
    let box = null;
    for (let i = b.w0; i < b.w1; i++) for (const r of webBoxes(i)) {
      box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
    }
    if (!box) continue;
    const d = document.createElement("div");
    d.className = "skipzone";
    putBox(d, { left: box.l - 2, top: box.t - 1, width: box.r - box.l + 4, height: box.b - box.t + 2 });
    w.ov.appendChild(d);
  }
  // the highlight follows the new layout
  const si = R.curSent;
  if (R.curWord >= 0) setWord(R.curWord);
  if (si >= 0) setSentence(si);
  renderPins();
}

async function renderPages(view) {
  const { pages, view: v } = R.h;
  view.innerHTML = `<div class="pages">${pages.map((pg, p) => `<div class="sheet" data-p="${p}" style="aspect-ratio:${pg.w}/${pg.h}"><span class="folio">${p + 1}</span><div class="ov"></div></div>`).join("")}</div>`;
  R.sheets = $$(".sheet", view);
  if (!R.pdf) {
    const pdfjs = await loadPdfjs();
    R.pdfTask = pdfjs.getDocument({ data: new Uint8Array(R.h.bytes), isEvalSupported: false });
    R.pdf = await R.pdfTask.promise;
  }
  R.io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) drawPage(+en.target.dataset.p);
  }, { root: $("#scroll"), rootMargin: "800px 0px" });
  R.sheets.forEach((s) => R.io.observe(s));
  // hatch parts that are not read aloud
  const zones = new Map();
  v.blocks.forEach((b) => {
    if (b.spoken) return;
    for (let i = b.w0; i < b.w1; i++) {
      const w = v.words[i];
      if (!w.b) continue;
      const k = b.w0 + ":" + w.p;
      const z = zones.get(k) || { p: w.p, b: [1e9, 1e9, -1, -1] };
      z.b = [Math.min(z.b[0], w.b[0]), Math.min(z.b[1], w.b[1]), Math.max(z.b[2], w.b[2]), Math.max(z.b[3], w.b[3])];
      zones.set(k, z);
    }
  });
  for (const z of zones.values()) {
    const d = document.createElement("div");
    d.className = "skipzone";
    place(d, pages[z.p], [z.b[0] - 2, z.b[1] - 1, z.b[2] + 2, z.b[3] + 1]);
    $(".ov", R.sheets[z.p]).appendChild(d);
  }
}

async function drawPage(p) {
  const sheet = R.sheets[p];
  if (!sheet || sheet.dataset.drawn || R.rendering.has(p) || !R.pdf) return;
  R.rendering.add(p);
  try {
    const page = await R.pdf.getPage(p + 1);
    const cssW = sheet.clientWidth || 800;
    const vp1 = page.getViewport({ scale: 1 });
    const scale = (cssW / vp1.width) * Math.min(2.5, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
    if (!R.sheets[p] || R.sheets[p] !== sheet) return;
    sheet.prepend(canvas);
    sheet.dataset.drawn = "1";
  } catch (e) { console.warn("page render", e); }
  finally { R.rendering.delete(p); }
}

function place(el, pg, b) {
  el.style.left = (b[0] / pg.w) * 100 + "%";
  el.style.top = (b[1] / pg.h) * 100 + "%";
  el.style.width = ((b[2] - b[0]) / pg.w) * 100 + "%";
  el.style.height = ((b[3] - b[1]) / pg.h) * 100 + "%";
}

function renderText(view) {
  const { words, blocks } = R.view;
  const parts = blocks.map((b, bi) => {
    const tag = b.type === "heading" ? "h2" : "p";
    let inner = "";
    let joined = false; // a word broken by a line-end hyphen in the source: show it whole
    for (let i = b.w0; i < b.w1; i++) {
      const w = words[i];
      if (i > b.w0 && !w.g && !joined) inner += " ";
      const nxt = words[i + 1];
      joined = !!(w.hy && nxt && i + 1 < b.w1 && /^\p{Ll}/u.test(nxt.t));
      const t = joined ? w.t.replace(/[-‐­]$/, "") : w.t;
      inner += `<span class="w${w.sup ? " sup" : ""}" data-i="${i}">${esc(t)}</span>`;
    }
    const label = b.spoken ? "Don't read this" : `Read this ${typeName(b.type)}`;
    return `<${tag} class="blk${b.spoken ? "" : " skip"}" data-b="${bi}">${inner}<button class="link blk-tog" data-tog="${bi}">${label}</button></${tag}>`;
  });
  view.innerHTML = `<div class="textcol">${parts.join("")}</div>`;
  R.wordEls = new Array(words.length);
  $$("span.w", view).forEach((el) => (R.wordEls[+el.dataset.i] = el));
}

function applyZoom() {
  if (R.mode === "page") $("#docview").style.setProperty("--page-w", store.get("pageW", 820) + "px");
  else { const col = $(".textcol"); if (col) col.style.fontSize = store.get("textSize", 21) + "px"; }
}
function zoom(dir) {
  if (R.mode === "page") {
    store.set("pageW", Math.min(1800, Math.max(460, store.get("pageW", 820) + dir * 120)));
    applyZoom();
    R.sheets.forEach((s) => { const c = $("canvas", s); if (c) c.remove(); delete s.dataset.drawn; });
    R.sheets.forEach((s, p) => { const r = s.getBoundingClientRect(); if (r.bottom > -800 && r.top < innerHeight + 800) drawPage(p); });
  } else { store.set("textSize", Math.min(34, Math.max(14, store.get("textSize", 21) + dir * 2))); applyZoom(); }
  if (R.curWord >= 0) centerOn(R.curWord, true);
}

// ======================================================================= highlighting
function upper(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m + 1; else hi = m; } return lo; }
function loop() {
  cancelAnimationFrame(R.raf);
  const step = () => { tick(); R.raf = requestAnimationFrame(step); };
  R.raf = requestAnimationFrame(step);
}
function tick() {
  if (!R.id || !R.h) return;
  const ci = player.ci;
  const rec = R.times.get(ci);
  if (rec && (player.playing || !player.want)) {
    const k = upper(rec.s, player.chunkTime + 0.02) - 1;
    const wi = k >= 0 ? rec.wids[k] : rec.wids[0];
    if (wi !== R.curWord) setWord(wi);
  }
  const now = performance.now();
  if (now - (R.lastUi || 0) > 180) {
    R.lastUi = now;
    const t = player.currentTime, d = player.duration || 1;
    $("#t-cur").textContent = fmt(t);
    if (!R.dragging) {
      $("#played").style.width = (100 * t) / d + "%";
      $("#knob").style.left = (100 * t) / d + "%";
    }
    const pb = $("#play");
    pb.classList.toggle("on", player.want && !player.waiting);
    pb.classList.toggle("wait", player.want && player.waiting);
    if (player.want && now - R.lastSave > 4000) { R.lastSave = now; savePos(); }
  }
}
function savePos() { if (R.id && R.curWord >= 0) store.set("pos:" + R.id, { w: R.curWord, t: player.currentTime }); }

function setWord(wi) {
  const prev = R.curWord;
  R.curWord = wi;
  const v = R.view;
  if (R.mode === "text") {
    if (prev >= 0 && R.wordEls[prev]) R.wordEls[prev].classList.remove("c");
    if (wi >= 0 && R.wordEls[wi]) R.wordEls[wi].classList.add("c");
  } else if (R.web) {
    const b = wi >= 0 ? webBoxes(wi)[0] : null;
    if (b) {
      if (!R.hlWord) { R.hlWord = document.createElement("div"); R.hlWord.className = "hl-word"; }
      if (R.hlWord.parentNode !== R.web.ov) R.web.ov.appendChild(R.hlWord);
      putBox(R.hlWord, { left: b.left - 2, top: b.top - 1, width: b.width + 4, height: b.height + 2 });
    } else if (R.hlWord) R.hlWord.remove();
  } else if (wi >= 0 && v.words[wi].b) {
    const w = v.words[wi];
    if (!R.hlWord) { R.hlWord = document.createElement("div"); R.hlWord.className = "hl-word"; }
    const ov = $(".ov", R.sheets[w.p]);
    if (R.hlWord.parentNode !== ov) ov.appendChild(R.hlWord);
    place(R.hlWord, R.h.pages[w.p], [w.b[0] - 1.5, w.b[1] - 0.5, w.b[2] + 1.5, w.b[3] + 0.5]);
  }
  const si = wi >= 0 ? R.wordSent[wi] : -1;
  if (si !== R.curSent) setSentence(si);
  if (wi >= 0 && player.want) centerOn(wi, false);
}

function setSentence(si) {
  const v = R.view;
  const prevS = R.curSent >= 0 ? R.h.sentences[R.curSent] : null;
  R.curSent = si;
  const s = si >= 0 ? R.h.sentences[si] : null;
  if (R.mode === "text") {
    if (prevS) for (let i = prevS.w0; i < prevS.w1; i++) R.wordEls[i] && R.wordEls[i].classList.remove("s");
    if (s) for (let i = s.w0; i < s.w1; i++) R.wordEls[i] && R.wordEls[i].classList.add("s");
    return;
  }
  R.sentEls.forEach((d) => d.remove());
  R.sentEls = [];
  if (!s) return;
  if (R.web) { // one underline per line of the page: boxes on the same line are joined
    const lines = [];
    for (let i = s.w0; i < s.w1; i++) {
      if (v.words[i].sup) continue;
      for (const b of webBoxes(i)) {
        const ln = lines.find((l) => Math.abs(l.bottom - b.bottom) < 0.5 * b.height && b.left >= l.left - 4);
        if (ln) { ln.left = Math.min(ln.left, b.left); ln.right = Math.max(ln.right, b.right); ln.top = Math.min(ln.top, b.top); ln.bottom = Math.max(ln.bottom, b.bottom); }
        else lines.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
      }
    }
    for (const ln of lines) {
      const d = document.createElement("div");
      d.className = "hl-line";
      putBox(d, { left: ln.left, top: ln.top, width: ln.right - ln.left, height: ln.bottom - ln.top + 1.5 });
      R.web.ov.appendChild(d);
      R.sentEls.push(d);
    }
    return;
  }
  const lines = [];
  let line = null;
  for (let i = s.w0; i < s.w1; i++) {
    const w = v.words[i];
    if (!w.b || w.sup) continue;
    const h = w.b[3] - w.b[1];
    if (line && line.p === w.p && Math.abs(w.b[1] - line.b[1]) < h * 0.6 && w.b[0] >= line.b[0] - 2) {
      line.b = [Math.min(line.b[0], w.b[0]), Math.min(line.b[1], w.b[1]), Math.max(line.b[2], w.b[2]), Math.max(line.b[3], w.b[3])];
    } else { line = { p: w.p, b: w.b.slice() }; lines.push(line); }
  }
  for (const ln of lines) {
    const d = document.createElement("div");
    d.className = "hl-line";
    place(d, R.h.pages[ln.p], [ln.b[0], ln.b[1], ln.b[2], ln.b[3] + 1.5]);
    $(".ov", R.sheets[ln.p]).appendChild(d);
    R.sentEls.push(d);
  }
}

const scroller = $("#scroll");
function wordRect(wi) {
  if (R.mode === "text") return R.wordEls[wi] ? R.wordEls[wi].getBoundingClientRect() : null;
  if (R.web) {
    const b = webBoxes(wi)[0];
    if (!b) return null;
    const fr = R.web.frame.getBoundingClientRect();
    return { top: fr.top + b.top * R.web.scale, bottom: fr.top + b.bottom * R.web.scale };
  }
  const w = R.view.words[wi];
  if (!w || !w.b) return null;
  const pr = R.sheets[w.p].getBoundingClientRect(), pg = R.h.pages[w.p];
  return { top: pr.top + (w.b[1] / pg.h) * pr.height, bottom: pr.top + (w.b[3] / pg.h) * pr.height };
}
function centerOn(wi, now) {
  if (wi < 0 || (!now && (!R.follow || Date.now() < R.followPauseUntil))) return;
  const r = wordRect(wi);
  if (!r) return;
  const sr = scroller.getBoundingClientRect();
  if (now || r.top < sr.top + sr.height * 0.15 || r.bottom > sr.top + sr.height * 0.72) {
    scroller.scrollTo({ top: scroller.scrollTop + (r.top - sr.top) - sr.height * 0.32, behavior: now ? "auto" : "smooth" });
  }
}
/** Scrolling by hand while the voice plays: the page stops following it for a while. */
function pauseFollow() {
  if (!player.want || !R.follow) return;
  R.followPauseUntil = Date.now() + 9000;
  $("#back-to-voice").hidden = false;
  clearTimeout(R.btv);
  R.btv = setTimeout(() => ($("#back-to-voice").hidden = true), 9000);
}
["wheel", "touchmove"].forEach((ev) => scroller.addEventListener(ev, pauseFollow, { passive: true }));
$("#back-to-voice").onclick = () => { R.followPauseUntil = 0; $("#back-to-voice").hidden = true; centerOn(R.curWord, true); };

// ======================================================================= seeking
function nextSpoken(i) {
  for (let j = Math.max(0, i); j < R.wordChunk.length; j++) if (R.wordChunk[j] >= 0) return j;
  for (let j = i; j >= 0; j--) if (R.wordChunk[j] >= 0) return j;
  return -1;
}
async function seekToWord(i, play) {
  const j = nextSpoken(i);
  if (j < 0) return;
  const ci = R.wordChunk[j];
  const rec = await chunkTimes(ci);
  let t = 0;
  if (rec) { const k = rec.wids.indexOf(j); t = Math.max(0, (k >= 0 ? rec.s[k] : 0) - 0.03); }
  else { voicer.focus = { id: R.id, ci }; voicer.run(); }
  R.followPauseUntil = 0;
  $("#back-to-voice").hidden = true;
  setWord(j);
  if (play) player.want = true;
  await player.seekChunk(ci, t);
  if (play) player.play();
  if (!rec) toast("Voicing this part now…", 2000);
}
function seekSentence(delta) {
  const S = R.h.sentences;
  if (!S.length) return;
  let si = R.curSent >= 0 ? R.curSent : 0;
  if (delta < 0) {
    const first = nextSpoken(S[si].w0);
    const rec = R.times.get(player.ci);
    const k = rec ? rec.wids.indexOf(first) : -1;
    if (k >= 0 && R.wordChunk[first] === player.ci && player.chunkTime - rec.s[k] > 1.5) delta = 0;
  }
  si = Math.min(S.length - 1, Math.max(0, si + delta));
  seekToWord(S[si].w0, player.want).then(() => centerOn(R.curWord, true));
}
function jump(sec) { player.seek(Math.max(0, Math.min(player.duration - 0.1, player.currentTime + sec))); }

// timeline dragging
const track = $("#track");
function trackTime(e) { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * player.duration; }
track.addEventListener("pointerdown", (e) => {
  R.dragging = true; track.setPointerCapture(e.pointerId);
  const move = (ev) => { const t = trackTime(ev); $("#played").style.width = $("#knob").style.left = (100 * t) / player.duration + "%"; $("#t-cur").textContent = fmt(t); };
  move(e);
  track.onpointermove = move;
  track.onpointerup = (ev) => { R.dragging = false; track.onpointermove = null; player.seek(trackTime(ev)); R.followPauseUntil = 0; };
});
track.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") jump(-10); if (e.key === "ArrowRight") jump(10); });

// clicking a word
$("#docview").addEventListener("click", (e) => {
  if (!R.h) return;
  const pin = e.target.closest(".pin");
  if (pin) { e.stopPropagation(); focusNote(pin.dataset.note); return; }
  const tog = e.target.closest("[data-tog]");
  if (tog) { toggleBlock(+tog.dataset.tog); return; }
  if (R.mode === "text") { const sp = e.target.closest("span.w"); if (sp) seekToWord(+sp.dataset.i, true); return; }
  const ov = e.target.closest(".ov");
  if (!ov || R.web) return; // a web page takes its own clicks (webClick)
  const p = +ov.parentNode.dataset.p, pg = R.h.pages[p];
  const r = ov.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * pg.w, y = ((e.clientY - r.top) / r.height) * pg.h;
  let best = -1, bd = 1e9;
  for (const i of R.pageWords[p] || []) {
    const b = R.view.words[i].b;
    const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0, dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
    const d = dx * dx + dy * dy * 4;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || bd > 400) return;
  readFromClick(best);
});
function readFromClick(wi) {
  if (R.wordChunk[wi] < 0) {
    const b = R.view.blocks[R.view.words[wi].k];
    toast(`This ${typeName(b.type)} is not read aloud. In the Text view you can switch it on.`, 3500);
    return;
  }
  seekToWord(wi, true);
}

// player controls
$("#play").onclick = () => { if (R.curWord < 0 && !player.want) seekToWord(0, true); else player.toggle(); };
player.addEventListener("ended", () => toast("End of the reading."));
player.addEventListener("state", () => { if (player.want && voiceHeld) { voiceHeld = false; voicer.run(); } });
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
function setSpeedLabel() { $("#speed").textContent = (+store.get("speed", 1)).toFixed(2).replace(/0$/, "") + "×"; }
function stepSpeed(d) {
  let i = SPEEDS.indexOf(+store.get("speed", 1));
  if (i < 0) i = 2;
  i = Math.min(SPEEDS.length - 1, Math.max(0, i + d));
  store.set("speed", SPEEDS[i]); player.setRate(SPEEDS[i]); setSpeedLabel();
}
$("#speed").onclick = () => { const i = SPEEDS.indexOf(+store.get("speed", 1)); store.set("speed", SPEEDS[(i + 1) % SPEEDS.length]); player.setRate(+store.get("speed", 1)); setSpeedLabel(); };
$("#follow").onclick = () => {
  R.follow = !R.follow; store.set("follow", R.follow);
  $("#follow").classList.toggle("on", R.follow);
  toast(R.follow ? "The page follows the voice." : "The page stays where you leave it.");
};
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => player.play());
  ms.setActionHandler("pause", () => player.pause());
  ms.setActionHandler("seekbackward", () => jump(-10));
  ms.setActionHandler("seekforward", () => jump(10));
  ms.setActionHandler("previoustrack", () => seekSentence(-1));
  ms.setActionHandler("nexttrack", () => seekSentence(1));
}

// ======================================================================= notes (marginalia)
const ctxOf = (words, w) => words.slice(w, w + 8).filter((x) => !x.sup).map((x) => x.t).join(" ");
const key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function reanchor(notes, words) {
  const keys = words.map((w) => key(w.t));
  for (const n of notes) {
    if (!n.ctx) continue;
    const want = n.ctx.split(" ").map(key).filter(Boolean).slice(0, 6);
    const here = keys.slice(n.w, n.w + 12).filter(Boolean).slice(0, want.length);
    if (want.join(" ") === here.join(" ")) { delete n.lost; continue; }
    let best = -1, bd = Infinity;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== want[0]) continue;
      if (keys.slice(i, i + 12).filter(Boolean).slice(0, want.length).join(" ") === want.join(" ") && Math.abs(i - n.w) < bd) { best = i; bd = Math.abs(i - n.w); }
    }
    if (best >= 0) { n.w = best; delete n.lost; } else n.lost = true;
  }
  return notes.sort((a, b) => a.w - b.w);
}
function sentenceText(wi, max = 280) {
  const v = R.view, si = R.wordSent[wi];
  const [a, b] = si >= 0 ? [R.h.sentences[si].w0, R.h.sentences[si].w1] : [Math.max(0, wi - 12), Math.min(v.words.length, wi + 12)];
  let s = "";
  for (let i = a; i < b; i++) { const w = v.words[i]; if (w.sup) continue; s += (s && !w.g ? " " : "") + w.t; }
  s = s.replace(/(\p{L})- (\p{Ll})/gu, "$1$2");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function noteTime(n) {
  const j = nextSpoken(n.w);
  const ci = j >= 0 ? R.wordChunk[j] : -1;
  const rec = ci >= 0 ? R.times.get(ci) : null;
  if (!rec) return ci >= 0 ? player.offsets[ci] : null;
  const k = rec.wids.indexOf(j);
  return player.offsets[ci] + (k >= 0 ? rec.s[k] : 0);
}
async function saveNotes() {
  for (const n of R.notes) n.ctx = ctxOf(R.view.words, n.w);
  R.notes.sort((a, b) => a.w - b.w);
  await db.put("notes", { id: R.id, notes: R.notes });
  renderNotes();
}
function renderNotes() {
  $("#note-count").textContent = R.notes.length ? `(${R.notes.length})` : "";
  const list = $("#notes");
  if (!R.notes.length) {
    list.innerHTML = `<li class="m-empty">Press <kbd>N</kbd> while listening. The voice pauses; write what comes to mind. The note stays pinned to that spot.</li>`;
  } else {
    list.innerHTML = R.notes.map((n, k) => {
      const w = R.view.words[n.w];
      return `<li class="note" data-note="${esc(n.id)}" tabindex="0"><span class="n">${k + 1}</span><div>
        <div class="meta"><span>${fmt(noteTime(n))}</span>${w && w.p != null ? `<span>p. ${w.p + 1}</span>` : ""}${n.lost ? `<span class="lost">place uncertain after re-reading the file</span>` : ""}</div>
        <p class="q">${esc(sentenceText(n.w))}</p><div class="txt">${esc(n.text)}</div>
        <div class="acts"><button class="link" data-edit>Edit</button><button class="link" data-delnote>Delete</button></div></div></li>`;
    }).join("");
  }
  renderPins();
}
function renderPins() {
  $$("#docview .pin").forEach((p) => p.remove());
  if (!R.view) return;
  R.notes.forEach((n, k) => {
    const w = R.view.words[n.w];
    if (!w) return;
    const pin = document.createElement("button");
    pin.className = "pin"; pin.dataset.note = n.id; pin.title = n.text.slice(0, 140); pin.textContent = k + 1;
    if (R.mode === "page" && R.web) {
      const b = webBoxes(n.w)[0];
      if (!b) return;
      pin.style.left = "calc(100% - 14px)";
      pin.style.top = b.top + "px";
      R.web.ov.appendChild(pin);
    } else if (R.mode === "page" && w.b && R.sheets[w.p]) {
      const pg = R.h.pages[w.p];
      pin.style.left = "calc(100% - 14px)";
      pin.style.top = (w.b[1] / pg.h) * 100 + "%";
      $(".ov", R.sheets[w.p]).appendChild(pin);
    } else if (R.mode === "text" && R.wordEls[n.w]) R.wordEls[n.w].after(pin);
  });
}
function focusNote(id) {
  if ($("#margin").hidden) toggleMargin(true);
  const el = $(`.note[data-note="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
function firstVisibleWord() {
  const sr = scroller.getBoundingClientRect();
  for (let i = 0; i < R.wordChunk.length; i++) {
    if (R.wordChunk[i] < 0) continue;
    const r = wordRect(i);
    if (r && r.top >= sr.top) return i;
  }
  return 0;
}
function openComposer(note) {
  if (!R.h) return;
  const wasPlaying = player.want;
  player.pause();
  if ($("#margin").hidden) toggleMargin(true);
  const anchor = note ? note.w : R.curWord >= 0 ? R.curWord : firstVisibleWord();
  const resume = store.get("resumeAfterNote", true);
  const w = R.view.words[anchor];
  const slot = $("#composer-slot");
  slot.innerHTML = `<div class="composer">
    <div class="label">${note ? "Edit note" : "New note"} · ${fmt(noteTime({ w: anchor }))}${w && w.p != null ? ` · p. ${w.p + 1}` : ""}</div>
    <p class="q">${esc(sentenceText(anchor))}</p>
    <textarea placeholder="What is going through your mind?">${note ? esc(note.text) : ""}</textarea>
    <div class="acts"><label class="fine"><input type="checkbox" class="resume" ${resume ? "checked" : ""}> keep reading after saving</label>
      <button class="link" data-cancel>Cancel</button><button class="btn solid small" data-save title="Ctrl+Enter">Save</button></div></div>`;
  const ta = $("textarea", slot);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const close = () => (slot.innerHTML = "");
  const save = async () => {
    const text = ta.value.trim(), res = $(".resume", slot).checked;
    store.set("resumeAfterNote", res);
    close();
    if (text) {
      if (note) note.text = text;
      else R.notes.push({ id: String(Date.now()), w: anchor, text, created: Date.now() });
      await saveNotes();
      toast("Note saved.");
    }
    if (wasPlaying && res) player.play();
  };
  $("[data-save]", slot).onclick = save;
  $("[data-cancel]", slot).onclick = () => { close(); if (wasPlaying && resume) player.play(); };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
}
$("#notes").addEventListener("click", async (e) => {
  const li = e.target.closest(".note");
  if (!li) return;
  const n = R.notes.find((x) => x.id === li.dataset.note);
  if (!n) return;
  if (e.target.closest("[data-edit]")) return openComposer(n);
  const del = e.target.closest("[data-delnote]");
  if (del) {
    if (del.dataset.armed) { R.notes = R.notes.filter((x) => x !== n); await saveNotes(); }
    else { del.dataset.armed = 1; del.textContent = "Delete? Click again"; setTimeout(() => { delete del.dataset.armed; del.textContent = "Delete"; }, 3500); }
    return;
  }
  await seekToWord(n.w, false);
  centerOn(R.curWord, true);
});
$("#export").onclick = () => {
  const lines = [`# Notes on ${R.meta.title}`, ""];
  for (const n of R.notes) {
    const w = R.view.words[n.w];
    lines.push(`**[${fmt(noteTime(n))}${w && w.p != null ? `, page ${w.p + 1}` : ""}]**`, "", `> ${sentenceText(n.w, 2000)}`, "", n.text, "", "---", "");
  }
  download(new Blob([lines.join("\n")], { type: "text/markdown" }), R.meta.title.replace(/[^\w]+/g, "_").slice(0, 60) + "_notes.md");
};
function toggleMargin(force) {
  const m = $("#margin");
  m.hidden = force != null ? !force : !m.hidden;
  store.set("notesOpen", !m.hidden);
  $("#notes-tog").classList.toggle("on", !m.hidden);
}

// ======================================================================= read / skip a block
async function toggleBlock(bi) {
  const h = await heavy(R.id);
  h.overrides = h.overrides || {};
  const b = R.view.blocks[bi];
  h.overrides[bi] = !b.spoken;
  await db.put("files", h);
  toast("Updating what is read…", 1500);
  await prepare(R.id);
}

// ======================================================================= dialogs
function dialog(title, body, foot = "") {
  const root = $("#modal-root");
  root.innerHTML = `<div class="veil"><div class="dialog" role="dialog" aria-label="${esc(title)}">
    <header><h3>${esc(title)}</h3><button class="link" data-close>Close</button></header>
    <div class="body">${body}</div>${foot ? `<footer>${foot}</footer>` : ""}</div></div>`;
  $(".veil", root).addEventListener("click", (e) => { if (e.target.classList.contains("veil") || e.target.closest("[data-close]")) closeDialog(); });
  return $(".dialog", root);
}
function closeDialog() { $("#modal-root").innerHTML = ""; }

const previewEl = new Audio();
unlockOnTap([previewEl]);
async function speakPreview(text, word, value, voice) {
  if (DEVICE_VOICE) { // the device voice cannot take phonemes: it says the text as written
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.voice = player.voice; u.lang = player.voice ? player.voice.lang : "en-US"; speechSynthesis.speak(u); } catch { /* no speech */ }
    return;
  }
  await dictP; const lex = await lexP;
  await startEngine();
  const lx = {
    lookup: (w) => (word && value && w === word ? ["preview", value] : lex.lookup(w)),
    known: (w) => lex.known(w), archaicVerb: (w) => lex.archaicVerb(w),
  };
  const toks = text.split(/\s+/).map((t) => new Token(t));
  new Normalizer(lx).normalize(toks);
  const phs = await phonemizeTokens(toks.map((t) => t.say || ""));
  const ids = [...phs.join(" ")].map((c) => VOCAB[c]).filter((x) => x !== undefined).slice(0, 500);
  const blob = await engine.sample(ids, voice || settings.voice, +settings.pace);
  previewEl.pause();
  if (previewEl.src.startsWith("blob:") && previewEl.dataset.own) URL.revokeObjectURL(previewEl.src);
  previewEl.src = URL.createObjectURL(blob); previewEl.dataset.own = "1";
  previewEl.play().catch(() => {});
}

async function openSettings() {
  const inReader = !$("#reader").hidden && R.id;
  const gpu = "gpu" in navigator;
  const d = dialog("Settings", `
    <div class="field"><span class="label">Voice</span>
      <div class="row"><select id="s-voice">${VOICES.map(([id, name, desc, g]) => `<option value="${id}" ${id === settings.voice ? "selected" : ""}>${name}${desc ? ", " + desc : ""} (grade ${g})</option>`).join("")}</select>
      <button class="btn small" id="s-try">Listen</button></div>
      <p class="fine">Grades come from the voice model's authors. Changing the voice re-voices your readings the next time you open them.</p></div>
    <div class="field"><span class="label">Narration pace <span id="s-pace-v">${(+settings.pace).toFixed(2)}</span></span>
      <input type="range" id="s-pace" min="0.8" max="1.2" step="0.05" value="${settings.pace}" style="width:100%;accent-color:var(--accent)">
      <p class="fine">How fast the voice is produced. You can also change the playback speed while listening.</p></div>
    <div class="field"><span class="label">What is read aloud</span>
      ${[["readCitations", "In-text citations such as (Olson 1982, 23)"], ["readFootnotes", "Footnotes"], ["readReferences", "Reference lists and endnotes"],
        ["readCaptions", "Figure and table captions"], ["readFigures", "Text inside charts, tables and equations (numbers, labels, symbols)"],
        ["readHeaders", "Running headers and page numbers"]]
        .map(([k, l]) => `<label class="check"><input type="checkbox" data-k="${k}" ${settings[k] ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
    <div class="field"><span class="label">Voice engine</span>
      <div class="row"><select id="s-engine"><option value="auto" ${settings.engine === "auto" ? "selected" : ""}>Automatic${PHONE ? (heartCrashed() && deviceVoiceAvailable() ? " (this phone's own voice)" : " (ReadAlong's phone voice)") : gpu && !gpuFailed ? " (graphics card)" : " (processor)"}</option>
        ${PHONE && deviceVoiceAvailable() ? `<option value="device" ${settings.engine === "device" ? "selected" : ""}>This phone's own voice</option>` : ""}
        <option value="webgpu" ${settings.engine === "webgpu" ? "selected" : ""} ${gpu ? "" : "disabled"}>Graphics card (WebGPU)</option>
        <option value="wasm" ${settings.engine === "wasm" ? "selected" : ""}>Processor only (slower)${PHONE ? ", may crash on phones" : ""}</option></select>
      <select id="s-quality"><option value="standard" ${settings.quality === "standard" ? "selected" : ""}>Processor: compact model (92 MB)</option>
        <option value="best" ${settings.quality === "best" ? "selected" : ""}>Processor: full-precision model (326 MB)</option></select></div>
      <p class="fine">The graphics card always uses the full-precision model (326 MB). ${gpu ? "This browser can use the graphics card, which is faster than real time on most recent computers." : "This browser cannot use the graphics card, so the voice runs on the processor and may be slower than real time. Recent Chrome or Edge can use the graphics card."}</p></div>
    ${inReader ? `<div class="field"><span class="label">This reading</span><div class="row" style="flex-wrap:wrap">
      <button class="btn small quiet" id="s-ocr">Text looks garbled? Re-read with OCR</button>
      <button class="btn small quiet" id="s-reext">Re-read the file</button>
      <button class="btn small quiet" id="s-wav">Download the audio (WAV)</button></div></div>` : ""}
    <div class="field"><span class="label">Storage</span><p class="fine" id="s-store">…</p>
      <button class="btn small quiet" id="s-clear">Delete all saved audio (keeps readings and notes)</button></div>`,
    `<span class="fine">Saved in this browser only.</span><button class="link" data-close>Cancel</button><button class="btn solid" id="s-save">Save</button>`);
  db.usage().then((e) => { $("#s-store", d).textContent = e ? `${(e.usage / 1e6).toFixed(0)} MB used of about ${(e.quota / 1e9).toFixed(0)} GB this browser allows.` : "Unknown."; });
  $("#s-pace", d).oninput = (e) => ($("#s-pace-v", d).textContent = (+e.target.value).toFixed(2));
  $("#s-try", d).onclick = (e) => { e.target.disabled = true; speakPreview("In 1850, Frédéric Bastiat wrote that the broken window cost the shopkeeper six francs, about 12% of his savings.", null, null, $("#s-voice", d).value).catch((er) => toast(esc(er.message))).finally(() => (e.target.disabled = false)); };
  $("#s-clear", d).onclick = async () => {
    for (const m of await db.all("docs")) { await db.delAudio(m.id); m.durs = {}; m.done = 0; if (m.status === "ready") m.status = "voicing"; await db.put("docs", m); }
    voicer.state.clear(); toast("Saved audio deleted. Readings will be voiced again when opened."); closeDialog();
  };
  if (inReader) {
    $("#s-ocr", d).onclick = () => { closeDialog(); prepare(R.id, { forceOcr: true }).catch((e) => toast(esc(e.message))); toast("Recognising the text from the page images. This can take a while for long scans.", 5000); };
    $("#s-reext", d).onclick = () => { closeDialog(); prepare(R.id, { reextract: true }).catch((e) => toast(esc(e.message))); };
    $("#s-wav", d).onclick = exportWav;
  }
  $("#s-save", d).onclick = async () => {
    const before = JSON.stringify(settings);
    settings.voice = $("#s-voice", d).value;
    settings.pace = +$("#s-pace", d).value;
    $$("[data-k]", d).forEach((c) => (settings[c.dataset.k] = c.checked));
    const eng = $("#s-engine", d).value, q = $("#s-quality", d).value;
    const engineChanged = eng !== settings.engine || q !== settings.quality;
    settings.engine = eng; settings.quality = q;
    if (eng === "webgpu") { gpuFailed = false; try { localStorage.removeItem(GPU_BAD); } catch { /* storage blocked */ } }
    saveSettings();
    closeDialog();
    if (engineChanged) engine.stop();
    if (engineChanged && PHONE) { location.reload(); return; } // switching between the phone's voice and ReadAlong's
    if (JSON.stringify(settings) !== before) {
      voicer.state.clear();
      for (const m of await db.all("docs")) if (m.status === "ready" || m.status === "voicing") { m.status = "voicing"; await db.put("docs", m); }
      toast("Saved.");
      if (R.id) openReader(R.id, { keepWord: R.curWord });
    }
  };
}

async function exportWav() {
  const st = await voicer.get(R.id);
  if (st.have.size < st.chunks.length) { toast("The whole reading must be voiced first."); return; }
  const parts = [];
  let n = 0;
  for (const k of st.keys) { const rec = await db.get("audio", k); const a = new Int16Array(rec.pcm); parts.push(a); n += a.length; }
  const all = new Int16Array(n);
  let o = 0;
  for (const a of parts) { all.set(a, o); o += a.length; }
  download(wav(all), R.meta.title.replace(/[^\w]+/g, "_").slice(0, 60) + ".wav");
}

function openNames() {
  if (!R.h) return;
  const names = R.h.names || [];
  const SRC = { guess: ["guessed", "hot"], dictionary: ["dictionary", ""], builtin: ["built-in", "ok"], user: ["your fix", "ok"] };
  const d = dialog("Names and unusual words", `
    <div class="prose"><p>Press <b>Hear</b> to listen to a word. If it is wrong, type how it should sound with the stressed part in CAPITALS, such as <i>bah-stee-AH</i>, <i>TOKE-vil</i> or <i>HIGH-ek</i>, press <b>Try</b>, then <b>Save</b>. Sentences with that word are voiced again. <b>Guessed</b> words were new to the voice: check those first. Phonemes between slashes also work, for example <i>/bˌɑstiˈɑ/</i>.</p></div>
    <input type="search" id="n-filter" placeholder="Filter…" style="margin:4px 0 10px">
    <table class="names"><tbody>${names.map((n, k) => `<tr data-k="${k}">
      <td class="w">${esc(n.word)}<small>${n.count}× · <a href="#" data-jump>show</a></small></td>
      <td><span class="tag ${SRC[n.source][1]}">${SRC[n.source][0]}</span></td>
      <td><button class="link" data-hear>Hear</button></td>
      <td><div class="fix"><input type="text" placeholder="sounds like…" data-val><button class="link" data-try>Try</button><button class="btn small solid" data-save>Save</button>${n.source === "user" ? `<button class="link" data-reset>Reset</button>` : ""}</div></td>
    </tr>`).join("") || `<tr><td class="fine">No unusual words found.</td></tr>`}</tbody></table>`);
  $("#n-filter", d).oninput = (e) => { const q = e.target.value.toLowerCase(); $$("tr[data-k]", d).forEach((tr) => (tr.hidden = !names[+tr.dataset.k].word.toLowerCase().includes(q))); };
  d.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-k]");
    if (!tr) return;
    const n = names[+tr.dataset.k];
    const val = $("[data-val]", tr).value.trim();
    const lex = await lexP;
    try {
      if (e.target.closest("[data-hear]")) await speakPreview(n.word);
      else if (e.target.closest("[data-try]")) { if (!val) return toast("Type how it sounds first."); const { toPhonemes } = await import("./lexicon.js"); await speakPreview(n.word, n.word, await toPhonemes(val)); }
      else if (e.target.closest("[data-save]")) {
        if (!val) return toast("Type how it sounds first.");
        await lex.setUser(n.word, val);
        $(".tag", tr).className = "tag ok"; $(".tag", tr).textContent = "your fix";
        toast("Saved. Re-voicing the sentences with this word…", 3500);
        prepare(R.id);
      } else if (e.target.closest("[data-reset]")) { await lex.setUser(n.word, null); toast("Reset."); prepare(R.id); }
      else if (e.target.closest("[data-jump]")) { e.preventDefault(); closeDialog(); await seekToWord(n.first, false); centerOn(R.curWord, true); }
    } catch (er) { toast(esc(er.message)); }
  });
}

function openHelp() {
  dialog("Keys", `<div class="help">
    <kbd>Space</kbd><span>Play or pause</span><kbd>N</kbd><span>Pause and write a note here</span>
    <kbd>←</kbd> <kbd>→</kbd><span>Previous or next sentence</span><kbd>Shift ←</kbd> <kbd>Shift →</kbd><span>Back or forward 10 seconds</span>
    <kbd>[</kbd> <kbd>]</kbd><span>Slower or faster</span><kbd>T</kbd><span>Page or text view</span>
    <kbd>F</kbd><span>Follow the voice on or off</span><kbd>Ctrl Enter</kbd><span>Save the note you are writing</span></div>
    <p class="fine" style="margin-top:16px">Click any word to read from there. In the text view, hover over a paragraph to choose whether it is read.</p>`);
}
function openAbout() {
  dialog("About ReadAlong", `<div class="prose">
    <p>ReadAlong turns a reading into an audiobook you can follow word by word. It was made for course readings: it skips running headers, page numbers, footnote markers and citations, says numbers the way a person would, and lets you fix how names are pronounced.</p>
    <p>Everything happens in your browser. Your files, notes and the voice never leave this device. When you open a link, the reading is downloaded directly if the site allows it; otherwise a small relay run for ReadAlong fetches that one address and passes the file on without keeping it. The first time, the browser downloads the voice model (${modelFor(pickBackend(settings.engine), settings.quality).mb} MB) from Hugging Face and keeps it.</p>
    <p>The voice is <a href="https://huggingface.co/hexgrad/Kokoro-82M" target="_blank" rel="noopener">Kokoro-82M</a> (Apache 2.0). Pronunciation uses the misaki dictionaries (Apache 2.0) and espeak-ng (GPL 3.0) for unfamiliar words. PDFs are read with PDF.js, scans with Tesseract. See <a href="NOTICE.md" target="_blank">NOTICE.md</a> for licences, and the <a href="https://github.com/louisrouanet-econ/readalong" target="_blank" rel="noopener">source code</a>.</p></div>`);
}

// ======================================================================= global actions & keys
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  if (!a) return;
  ({
    home: () => (location.hash = ""), settings: openSettings, names: openNames, help: openHelp, about: openAbout,
    notes: () => toggleMargin(), addnote: () => openComposer(null), prev: () => seekSentence(-1), next: () => seekSentence(1),
    back10: () => jump(-10), fwd10: () => jump(10), zoomin: () => zoom(1), zoomout: () => zoom(-1),
  }[a.dataset.act] || (() => {}))();
});
$("#viewmode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b && R.h && b.dataset.mode !== R.mode) setMode(b.dataset.mode); });
async function setMode(m) { R.mode = m; store.set("mode", m); store.set("mode:" + R.id, m); const w = R.curWord; await renderView(); if (w >= 0) { setWord(w); centerOn(w, true); } }
$("#r-title").addEventListener("click", function () { if (this.isContentEditable) return; this.contentEditable = "true"; this.focus(); document.getSelection().selectAllChildren(this); });
$("#r-title").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); this.blur(); } });
$("#r-title").addEventListener("blur", async function () {
  this.contentEditable = "false";
  const t = this.textContent.trim();
  if (t && R.id && t !== R.meta.title) { R.meta = await setMeta(R.id, { title: t, titleLocked: true }); toast("Renamed."); }
});
/** Reader keys; also listened to on a web page shown as it looks (the page has the focus after a click). */
function onKey(e) {
  if (e.key === "Escape" && $("#modal-root").innerHTML) { closeDialog(); return; }
  if (typing(e) || $("#reader").hidden || !R.h || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); $("#play").click(); }
  else if (k === "n" || k === "N") { e.preventDefault(); openComposer(null); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? jump(-10) : seekSentence(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? jump(10) : seekSentence(1); }
  else if (k === "f" || k === "F") $("#follow").click();
  else if ((k === "t" || k === "T") && !$("#viewmode").hidden) setMode(R.mode === "page" ? "text" : "page");
  else if (k === "[" || k === "]") { stepSpeed(k === "]" ? 1 : -1); toast(`Speed ${$("#speed").textContent}`, 1000); }
}
document.addEventListener("keydown", onKey);
window.addEventListener("beforeunload", savePos);
window.addEventListener("resize", () => { if (R.mode === "page" && R.curWord >= 0) setWord(R.curWord); });

// ======================================================================= start
renderSamples();
route();
// resume voicing of unfinished readings if the voice model is already on this device
(async () => {
  const docs = await db.all("docs");
  const unfinished = docs.filter((d) => d.status === "voicing").map((d) => d.id);
  for (const d of docs.filter((x) => x.status === "reading")) prepare(d.id).catch((e) => setMeta(d.id, { status: "error", message: e.message }));
  if (!unfinished.length) return;
  let cached = false;
  try { const c = await caches.open("readalong-model-v1"); cached = (await c.keys()).length > 0; } catch { /* no cache api */ }
  if (cached) unfinished.forEach((id) => voicer.enqueue(id));
})();
