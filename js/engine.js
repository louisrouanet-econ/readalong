// Voice engine (main-thread side): starts the worker, picks GPU or CPU, turns chunks into audio + word timings.
const SR = 24000;
const FRAME = 600 / SR; // one Kokoro duration unit = 600 samples = 25 ms

export function pickBackend(pref) {
  const gpu = typeof navigator !== "undefined" && "gpu" in navigator;
  if (pref === "wasm" || !gpu) return "wasm";
  return "webgpu";
}
export function modelFor(backend, quality) {
  if (backend === "webgpu") return quality === "best" ? { dtype: "fp32", mb: 326 } : { dtype: "fp16", mb: 163 };
  return quality === "best" ? { dtype: "fp32", mb: 326 } : { dtype: "q8", mb: 92 };
}

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
    this.emit({ state: "loading", backend, dtype, mb, loaded: 0, total: mb * 1e6 });
    this.worker = new Worker(new URL("./tts.worker.js", import.meta.url), { type: "module" });
    this.readyP = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") this.emit({ state: "loading", loaded: m.loaded, total: m.total || mb * 1e6 });
        else if (m.type === "ready") { this.emit({ state: "ready", backend: m.backend, dtype: m.dtype, threads: m.threads }); resolve(); }
        else if (m.type === "audio" || m.type === "voiceReady") {
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
    const cum = new Float64Array(durations.length + 1);
    for (let i = 0; i < durations.length; i++) cum[i + 1] = cum[i] + Math.max(1, Math.round(durations[i]));
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
    const wids = [], s = [], e = [];
    for (const [w, ia, ib] of chunk.spans) {
      // +1: the model's input starts with a padding token
      const t0 = cum[ia + 1] * FRAME + shift, t1 = cum[ib + 1] * FRAME + shift;
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
