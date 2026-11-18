// Phones: the "Heart" voice of mesm-tts (vendor/pdn), a 3.5 MB copy of Kokoro's af_heart voice that runs on its own small
// WebAssembly engine instead of onnxruntime-web. It peaks under 100 MB where Kokoro with onnxruntime-web needs most of a
// gigabyte, more than Safari gives a tab on an iPhone. Same messages as tts.worker.js, so the Engine class drives both.
// Heart takes the same phoneme ids as Kokoro but does not report phoneme durations: they are estimated from the audio
// (heartTiming.js), in Kokoro's form, so word timing works the same way.
import { createEngine, relaxedSimdSupported } from "../vendor/pdn/pdn.mjs";
import { estimateDurations } from "./heartTiming.js";

const PDN = new URL("../vendor/pdn/", import.meta.url);
let engine = null;

async function init() {
  const t0 = performance.now();
  const res = await fetch(new URL("v2f.pdn", PDN));
  if (!res.ok) throw new Error(`Could not load the voice (${res.status})`);
  const total = +res.headers.get("content-length") || 3526456;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    self.postMessage({ type: "progress", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  self.postMessage({ type: "building" });
  const relaxed = relaxedSimdSupported();
  engine = await createEngine(bytes, { wasm: new URL(relaxed ? "pdn_r.wasm" : "pdn.wasm", PDN).href, relaxed, int8: true, warmup: true });
  self.postMessage({ type: "ready", backend: "heart", dtype: "heart", ms: performance.now() - t0, threads: 1 });
}

function synth({ id, ids, speed }) {
  const t0 = performance.now();
  const input = new Int32Array(Math.min(ids.length, 510) + 2);
  for (let i = 0; i < input.length - 2; i++) input[i + 1] = ids[i];
  const audio = engine.synth(input, speed || 1);
  const durations = estimateDurations(input.subarray(1, input.length - 1), audio);
  self.postMessage({ type: "audio", id, audio, durations, ms: performance.now() - t0 }, [audio.buffer, durations.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init();
    else if (m.type === "voice") self.postMessage({ type: "voiceReady", name: m.name }); // one voice
    else if (m.type === "synth") synth(m);
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
