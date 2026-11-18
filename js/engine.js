// Voice engine (main-thread side): starts the worker, picks GPU or CPU, turns chunks into audio + word timings.
const SR = 24000;
const FRAME = 600 / SR; // one Kokoro duration unit = 600 samples = 25 ms

export function pickBackend(pref) {
  const gpu = typeof navigator !== "undefined" && "gpu" in navigator;
  if (pref === "wasm" || !gpu) return "wasm";
  return "webgpu";
}
// On WebGPU only the full-precision model is safe: the 16-bit export produces NaN (silence) there.
export function modelFor(backend, quality) {
  if (backend === "webgpu") return { dtype: "fp32", mb: 326 };
  return quality === "best" ? { dtype: "fp32", mb: 326 } : { dtype: "q8", mb: 92 };
}
export class SilentError extends Error {}

export class Engine {
  constructor() {
    this.worker = null;
    this.readyP = null;
    this.pending = new Map();
    this.seq = 0;
    this.listeners = new Set();
    this.info = { state: "off" };
    this.speed = null; // measured realtime factor
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(info) { this.info = { ...this.info, ...info }; for (const f of this.listeners) f(this.info); }

  start({ backend, quality }) {
    if (this.readyP && this.cfg && this.cfg.backend === backend && this.cfg.quality === quality) return this.readyP;
    this.stop();
    this.cfg = { backend, quality };
    const { dtype, mb } = modelFor(backend, quality);
    this.emit({ state: "loading", backend, dtype, mb, loaded: 0, total: mb * 1e6, spoken: false });
    this.worker = new Worker(new URL("./tts.worker.js", import.meta.url), { type: "module" });
    this.readyP = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "building") this.emit({ state: "building" });
        else if (m.type === "progress") this.emit({ state: "loading", loaded: m.loaded, total: m.total || mb * 1e6 });
        else if (m.type === "ready") { this.emit({ state: "ready", backend: m.backend, dtype: m.dtype, threads: m.threads }); resolve(); }
        else if (m.type === "audio" || m.type === "voiceReady") {
          if (m.type === "audio" && !this.info.spoken) this.emit({ spoken: true });
          const p = this.pending.get(m.id ?? m.name);
          if (p) { this.pending.delete(m.id ?? m.name); p.resolve(m); }
        } else if (m.type === "error") {
          const p = m.id != null && this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); }
          else { this.emit({ state: "error", message: m.message }); reject(new Error(m.message)); }
        }
      };
      this.worker.onerror = (e) => { this.emit({ state: "error", message: e.message || "The voice engine failed to start" }); reject(e); };
    });
    this.worker.postMessage({ type: "init", backend, dtype });
    return this.readyP;
  }
  stop() {
    if (this.worker) this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("engine stopped"));
    this.pending.clear();
    this.worker = null;
    this.readyP = null;
    this.emit({ state: "off" });
  }

  async synth(ids, voice, speed = 1) {
    await this.readyP;
    const id = ++this.seq;
    const t0 = performance.now();
    const m = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "synth", id, ids, voice, speed });
    });
    const secs = m.audio.length / SR;
    const rt = secs / ((performance.now() - t0) / 1000);
    this.speed = this.speed == null ? rt : this.speed * 0.8 + rt * 0.2;
    return m;
  }

  /** Synthesize one plan chunk; returns stored form: Int16 PCM with a leading pause + per-word times. */
  async renderChunk(chunk, voice, speed) {
    const { audio, durations } = await this.synth(chunk.ids, voice, speed);
    let bad = 0, peak = 0;
    for (let i = 0; i < audio.length; i += 7) { const v = audio[i]; if (!Number.isFinite(v)) bad++; else if (Math.abs(v) > peak) peak = Math.abs(v); }
    if (bad > audio.length / 700 || peak < 0.01) throw new SilentError("The voice engine produced silence on this device.");
    const cum = new Float64Array(durations.length + 1);
    for (let i = 0; i < durations.length; i++) cum[i + 1] = cum[i] + Math.max(1, Math.round(durations[i]));
    // word timing rests on this: rounded durations x 600 samples = the audio produced
    if (Math.abs(cum[durations.length] * 600 - audio.length) > 600) console.warn("ReadAlong: duration/audio mismatch", cum[durations.length] * 600, audio.length);
    // trim silence at both ends, then put the planned pause in front
    let a = 0, b = audio.length;
    const th = 0.012;
    while (a < b && Math.abs(audio[a]) < th) a++;
    while (b > a && Math.abs(audio[b - 1]) < th) b--;
    a = Math.max(0, a - Math.round(0.03 * SR));
    b = Math.min(audio.length, b + Math.round(0.09 * SR));
    const lead = Math.round(chunk.pause * SR);
    const pcm = new Int16Array(lead + (b - a));
    for (let i = a; i < b; i++) pcm[lead + i - a] = Math.max(-32767, Math.min(32767, Math.round(audio[i] * 32767)));
    const shift = chunk.pause - a / SR;
    const seg = kokoroTimestamps(chunk.ids, durations);
    const wids = [], s = [], e = [];
    for (const [w, ia, ib] of chunk.spans) {
      const first = seg.find((g) => g.b > ia), last = [...seg].reverse().find((g) => g.a < ib);
      if (!first || !last) continue;
      const t0 = first.s + shift, t1 = Math.max(first.s, last.e) + shift;
      const lens = w.map(() => 1);
      const tot = lens.length;
      w.forEach((wid, k) => {
        wids.push(wid);
        s.push(t0 + ((t1 - t0) * k) / tot);
        e.push(t0 + ((t1 - t0) * (k + 1)) / tot);
      });
    }
    return { pcm: pcm.buffer, dur: pcm.length / SR, wids: Int32Array.from(wids), s: Float32Array.from(s), e: Float32Array.from(e) };
  }

  async sample(ids, voice, speed) {
    const m = await this.synth(ids, voice, speed);
    return wav(m.audio);
  }
}

/** Word timestamps exactly as Kokoro's own pipeline computes them (kokoro/pipeline.py, join_timestamps):
 *  a word starts in the middle of the space before it, and everything is shifted 3 frames earlier.
 *  Returns segments of the id sequence between spaces: {a, b (id indices), s, e (seconds)}. */
export function kokoroTimestamps(ids, durations, spaceId = 16) {
  const d = Array.from(durations, (x) => Math.max(1, Math.round(x)));
  let left = 2 * Math.max(0, d[0] - 3), right = left;
  const out = [];
  let k = 0;
  while (k < ids.length) {
    if (ids[k] === spaceId) { k++; continue; }
    let m = k;
    while (m < ids.length && ids[m] !== spaceId) m++;
    const ws = m < ids.length;
    const i = k + 1, j = m + 1; // durations are offset by the leading pad token
    if (j >= d.length) break;
    let tok = 0;
    for (let q = i; q < j; q++) tok += d[q];
    const sp = ws ? d[j] : 0;
    const s = left / 80;
    left = right + 2 * tok + sp;
    out.push({ a: k, b: m, s, e: left / 80 });
    right = left + sp;
    k = ws ? m + 1 : m;
  }
  return out;
}

export function wav(samples, rate = SR) {
  const isInt = samples instanceof Int16Array;
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44, n);
  if (isInt) out.set(samples);
  else for (let i = 0; i < n; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767)));
  return new Blob([buf], { type: "audio/wav" });
}

export async function hash(str) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].slice(0, 10).map((x) => x.toString(16).padStart(2, "0")).join("");
}
