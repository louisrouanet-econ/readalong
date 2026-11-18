// Passage length: phones voice shorter passages, because the voice model's memory grows with the passage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setDict } from "../js/g2p.js";
import { Lexicon } from "../js/lexicon.js";
import { buildPlan } from "../js/speech.js";

setDict(JSON.parse(readFileSync(new URL("../data/dict.json", import.meta.url))));
const lex = new Lexicon({});

function view() {
  const text = readFileSync(new URL("../samples/hobbes-leviathan-ch13.txt", import.meta.url), "utf8");
  const words = [], blocks = [];
  for (const para of text.split(/\n\s*\n/)) {
    const w0 = words.length;
    for (const t of para.split(/\s+/).filter(Boolean)) words.push({ t });
    if (words.length > w0) blocks.push({ type: "para", w0, w1: words.length });
  }
  return { words, blocks };
}
const settings = { readCitations: false, readFootnotes: false, readReferences: false, readCaptions: true, readHeaders: false, readFigures: false };

test("computer and phone passages stay within their limits and say the same words", async () => {
  const big = await buildPlan(view(), settings, lex);
  const small = await buildPlan(view(), { ...settings, chunkTarget: 110, chunkMax: 150 }, lex);
  const longest = (p) => Math.max(...p.chunks.map((c) => c.ids.length));
  assert.ok(longest(big) <= 510);
  assert.ok(longest(small) <= 160, `longest phone passage: ${longest(small)} phonemes`);
  assert.ok(small.chunks.length > 2 * big.chunks.length);
  const said = (p) => p.chunks.flatMap((c) => c.ids).filter((x) => x !== 16).length; // all phonemes but spaces
  assert.equal(said(small), said(big));
});
