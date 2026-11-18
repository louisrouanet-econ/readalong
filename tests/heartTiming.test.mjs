// Estimated phoneme durations for the phones' Heart voice: Kokoro's form, the audio's frames, pauses where the audio is silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateDurations } from "../js/heartTiming.js";
import { kokoroTimestamps } from "../js/engine.js";
import { VOCAB } from "../js/vocab.js";

const ids = (s) => [...s].map((c) => VOCAB[c]);
// fake speech: loud where `on`, silent elsewhere, in 40-per-second frames of 600 samples
function audio(frames) {
  const a = new Float32Array(frames.length * 600);
  frames.forEach((on, f) => { if (on) for (let i = 0; i < 600; i++) a[f * 600 + i] = 0.3 * Math.sin(i / 3); });
  return a;
}

test("durations cover the audio, one per id plus the two paddings, silence at both ends", () => {
  const p = ids("hˈɛlO wˈɜɹld");
  const fr = [...Array(8).fill(0), ...Array(30).fill(1), ...Array(6).fill(0)];
  const d = estimateDurations(p, audio(fr));
  assert.equal(d.length, p.length + 2);
  assert.equal(d.reduce((a, b) => a + b, 0), fr.length);
  assert.equal(d[0], 8);
  assert.equal(d[d.length - 1], 6);
});

test("a pause in the audio is given to the comma, so the next word starts after it", () => {
  const p = ids("wˈʌn, tˈu");
  const fr = [...Array(4).fill(0), ...Array(12).fill(1), ...Array(14).fill(0), ...Array(12).fill(1), ...Array(4).fill(0)];
  const words = kokoroTimestamps(p, estimateDurations(p, audio(fr)));
  assert.equal(words.length, 2);
  // the second word starts when the sound comes back: frame 30 = 0.75 s (timing rule: within a frame or two)
  assert.ok(Math.abs(words[1].s - 0.75) < 0.1, `second word at ${words[1].s}`);
});
