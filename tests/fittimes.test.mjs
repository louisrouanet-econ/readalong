// Stored audio is found by its spoken text, so its word numbers may belong to another passage with the same text
// (before a re-extraction, or the same sentence twice): word times are fitted to the passage that plays it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitTimes } from "../js/fittimes.js";

const chunk = (spans) => ({ spans: spans.map((w, k) => [w, k * 3, k * 3 + 2]) });
const rec = (wids, s, extra = {}) => ({ wids: Int32Array.from(wids), s: Float32Array.from(s), e: Float32Array.from(s.map((x) => x + 0.2)), ...extra });

test("a recording made for these very words is used as it is", () => {
  const r = rec([10, 11, 12], [0.1, 0.4, 0.8]);
  assert.equal(fitTimes(chunk([[10], [11], [12]]), r), r);
});

test("old recording, same number of words elsewhere in the reading: this passage's words get its times", () => {
  // The Missing Billionaires, p. 62: the paragraph's audio carried word numbers 77 too low after the table moved
  const f = fitTimes(chunk([[14979], [14980], [14981, 14982]]), rec([14902, 14903, 14904, 14905], [0.1, 0.4, 0.8, 0.9]));
  assert.deepEqual([...f.wids], [14979, 14980, 14981, 14982]);
  assert.deepEqual([...f.s].map((x) => +x.toFixed(2)), [0.1, 0.4, 0.8, 0.9]);
});

test("old recording that cannot be matched is refused (the passage is voiced again)", () => {
  assert.equal(fitTimes(chunk([[5], [6], [7]]), rec([1, 2], [0.1, 0.5])), null);
});

test("new recordings keep times per span, rebuilt for whatever words the passage has now", () => {
  const spanT = Float32Array.from([0.1, 0.3, NaN, NaN, 0.5, 0.9]); // the middle span made no sound
  const f = fitTimes(chunk([[40], [41], [42, 43]]), rec([1, 3, 4], [0, 0, 0], { spanT }));
  assert.deepEqual([...f.wids], [40, 42, 43]);
  assert.deepEqual([...f.s].map((x) => +x.toFixed(2)), [0.1, 0.5, 0.7]);
  assert.deepEqual([...f.e].map((x) => +x.toFixed(2)), [0.3, 0.7, 0.9]);
});
