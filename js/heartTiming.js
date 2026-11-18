// Phoneme durations for a voice that does not report them (the phones' Heart voice): estimated from the audio, in the
// form Kokoro reports them (one value per input id, the two padding ids included, in 40-per-second frames of 600 samples),
// so the word timing that follows (kokoroTimestamps) is the same as for the computer voice.
// 1. Leading and trailing silence go to the two padding ids.
// 2. The speech in between is shared among the phonemes by their usual length: the average Kokoro gives each phoneme with
//    the af_heart voice (measured on Leviathan ch. XIII, passages 16-55), which Heart was trained to imitate.
// 3. Pauses the audio really has (silent stretches of 100 ms or more) are matched to the punctuation over the whole
//    passage at once (the best order-keeping match), and the phonemes between two matched pauses share the frames between.
// Checked against Kokoro's own durations on its own audio (passages 1-15, not used for the averages): see heartTiming.test.
import { VOCAB } from "./vocab.js";

const FRAME = 600;
const CHAR = [];
for (const [c, id] of Object.entries(VOCAB)) CHAR[id] = c;
const MEAN = {"ə":2.16,"ɡ":1.87,"ˈ":2.79,"ɛ":2.03,"n":2.38,",":2.48," ":2.07,"m":2.9,"h":1.42,"æ":1.89,"v":1.69,"O":2.84,"p":1.99,
  "l":2.7,"ɹ":2.93,"b":2.02,"ˌ":1.81,"ʌ":1.65,"t":2.54,"ɔ":2.82,"ð":1.49,"k":2.03,"ɑ":1.99,"i":3.9,"ɐ":1.62,"A":2.96,"d":2.16,
  "f":2,"ɪ":2.13,"ŋ":4.72,"ᵊ":2.59,"w":1.24,"z":3.6,"W":3.6,"ʊ":1.97,".":5.53,"ᵻ":3.51,"θ":4.84,"j":1.78,"ʃ":2.72,"u":3.6,
  "s":3.36,":":3.76,"I":3.08,"ʧ":2.27,"Y":2.23,"T":2.83,"ʤ":2.97,";":3.42,"ɜ":2.5};
const PUNCT = new Set([",", ";", ":", ".", "!", "?", "—", "…"]);
const weight = (id) => MEAN[CHAR[id]] ?? (PUNCT.has(CHAR[id]) ? 4 : 2.2);

/** Durations of ids from..to-1 (indices into d) filling `frames`: by weight, at least one frame each. */
function share(d, ws, from, to, frames) {
  const n = to - from;
  if (n <= 0) return;
  const extra = Math.max(0, frames - n);
  let wsum = 0;
  for (let i = from; i < to; i++) wsum += ws[i];
  let acc = 0, placed = 0;
  for (let i = from; i < to; i++) {
    acc += wsum > 0 ? (extra * ws[i]) / wsum : extra / n;
    const upto = Math.round(acc);
    d[i] = 1 + (upto - placed);
    placed = upto;
  }
}

/** ids: the passage's phoneme ids (no padding); audio: Float32Array at 24 kHz. Returns durations for [pad, ...ids, pad]. */
export function estimateDurations(ids, audio, opts = {}) {
  const { quietRatio = 0.1, minRun = 4, skipP = 40, maxDist = 40 } = opts;
  const n = ids.length + 2;
  const N = Math.max(n, Math.round(audio.length / FRAME));
  const rms = new Float32Array(N);
  for (let f = 0; f < N; f++) {
    let s = 0, c = 0;
    for (let i = f * FRAME; i < Math.min(audio.length, (f + 1) * FRAME); i++) { s += audio[i] * audio[i]; c++; }
    rms[f] = c ? Math.sqrt(s / c) : 0;
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.floor(0.9 * (N - 1))] || 0;
  const quiet = Math.max(0.003, quietRatio * loud);
  const silent = (f) => rms[f] < quiet;
  let L = 0; while (L < N - 1 && silent(L)) L++;
  let T = 0; while (T < N - 1 - L && silent(N - 1 - T)) T++;
  const ws = [0, ...Array.from(ids, (id) => Math.max(0.1, weight(id) - 1)), 0]; // share() gives one frame each, then the rest
  const d = new Array(n).fill(1);
  d[0] = Math.max(1, L); d[n - 1] = Math.max(1, T);
  const a0 = 1, b0 = n - 1, F0 = d[0], F1 = N - d[n - 1];
  // where each id falls without pauses to go by
  const pos = new Float64Array(n + 1);
  { const tmp = d.slice(); share(tmp, ws, a0, b0, F1 - F0); pos[a0] = F0; for (let i = a0; i < b0; i++) pos[i + 1] = pos[i] + tmp[i]; }
  // silent stretches inside the speech
  const runs = [];
  for (let f = F0; f < F1;) {
    if (!silent(f)) { f++; continue; }
    let g = f; while (g < F1 && silent(g)) g++;
    if (g - f >= minRun) runs.push([f, g]);
    f = g;
  }
  // best order-keeping match of punctuation to silent stretches: a pair costs the distance between the expected and the
  // real pause; punctuation without a pause costs a little (commas are often read through), a pause without punctuation more
  const P = [];
  for (let i = a0; i < b0; i++) if (PUNCT.has(CHAR[ids[i - 1]])) P.push(i);
  const SKIP_P = skipP, SKIP_R = (r) => 6 + (runs[r][1] - runs[r][0]);
  const np = P.length, nr = runs.length;
  const cost = Array.from({ length: np + 1 }, () => new Float64Array(nr + 1));
  const move = Array.from({ length: np + 1 }, () => new Uint8Array(nr + 1));
  for (let p = 0; p <= np; p++) for (let r = 0; r <= nr; r++) {
    if (!p && !r) continue;
    let best = Infinity, m = 0;
    if (p && cost[p - 1][r] + SKIP_P < best) { best = cost[p - 1][r] + SKIP_P; m = 1; }
    if (r && cost[p][r - 1] + SKIP_R(r - 1) < best) { best = cost[p][r - 1] + SKIP_R(r - 1); m = 2; }
    if (p && r) {
      const i = P[p - 1], expect = (pos[i] + pos[i + 1]) / 2, c = (runs[r - 1][0] + runs[r - 1][1]) / 2;
      const dist = Math.abs(c - expect);
      if (dist <= maxDist && cost[p - 1][r - 1] + dist < best) { best = cost[p - 1][r - 1] + dist; m = 3; }
    }
    cost[p][r] = best; move[p][r] = m;
  }
  const anchors = [];
  for (let p = np, r = nr; p || r;) {
    const m = move[p][r];
    if (m === 3) { anchors.push([P[p - 1], runs[r - 1][0], runs[r - 1][1]]); p--; r--; } else if (m === 1) p--; else r--;
  }
  anchors.reverse();
  let from = a0, at = F0;
  for (const [i, s, e] of anchors) {
    share(d, ws, from, i, Math.max(i - from, s - at));
    d[i] = Math.max(1, e - s);
    from = i + 1; at = e;
  }
  share(d, ws, from, b0, Math.max(b0 - from, F1 - at));
  return Float32Array.from(d);
}
