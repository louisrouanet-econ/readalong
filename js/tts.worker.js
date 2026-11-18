// Voice engine worker: runs Kokoro-82M (ONNX, timestamped export) with onnxruntime-web.
// Messages in:  {type:"init", backend:"webgpu"|"wasm", dtype}  {type:"voice", name}  {type:"synth", id, ids, voice, speed}
// Messages out: {type:"progress", loaded, total}  {type:"ready", backend, dtype, ms}  {type:"audio", id, audio, durations, ms}
//               {type:"error", id?, message}
import * as ort from "../vendor/ort/ort.webgpu.min.mjs";

const REPO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main/";
const FILES = { fp32: "onnx/model.onnx", fp16: "onnx/model_fp16.onnx", q8: "onnx/model_quantized.onnx" };
const CACHE = "readalong-model-v1";

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let session = null;
const voices = new Map();

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache API (private mode) */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) {
    try { await cache.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })); } catch { /* quota */ }
  }
  return buf;
}

async function init({ backend, dtype }) {
  const t0 = performance.now();
  const url = REPO + FILES[dtype];
  const bytes = await cachedFetch(url, (loaded, total) => self.postMessage({ type: "progress", loaded, total }));
  self.postMessage({ type: "building" }); // downloaded: now the model is loaded onto the graphics chip or processor
  const opts = { executionProviders: backend === "webgpu" ? ["webgpu"] : ["wasm"], graphOptimizationLevel: "all" };
  session = await ort.InferenceSession.create(bytes, opts);
  self.postMessage({ type: "ready", backend, dtype, ms: performance.now() - t0, threads: ort.env.wasm.numThreads });
}

async function loadVoice(name) {
  if (!voices.has(name)) {
    const bytes = await cachedFetch(REPO + `voices/${name}.bin`);
    voices.set(name, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }
  return voices.get(name);
}

async function synth({ id, ids, voice, speed }) {
  const t0 = performance.now();
  const v = await loadVoice(voice);
  const n = Math.min(Math.max(ids.length, 0), 509);
  const style = v.slice(n * 256, n * 256 + 256);
  const input = new BigInt64Array(ids.length + 2);
  for (let i = 0; i < ids.length; i++) input[i + 1] = BigInt(ids[i]);
  const out = await session.run({
    input_ids: new ort.Tensor("int64", input, [1, input.length]),
    style: new ort.Tensor("float32", style, [1, 256]),
    speed: new ort.Tensor("float32", new Float32Array([speed || 1]), [1]),
  });
  const audio = out.waveform.data instanceof Float32Array ? out.waveform.data : Float32Array.from(out.waveform.data);
  const durations = Float32Array.from(out.durations.data);
  self.postMessage({ type: "audio", id, audio, durations, ms: performance.now() - t0 }, [audio.buffer, durations.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init(m);
    else if (m.type === "voice") { await loadVoice(m.name); self.postMessage({ type: "voiceReady", name: m.name }); }
    else if (m.type === "synth") await synth(m);
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
