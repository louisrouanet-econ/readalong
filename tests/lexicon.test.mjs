// Respellings typed in the Names panel become phonemes with the stress on the CAPITALISED part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setDict } from "../js/g2p.js";
import { respellToPhonemes } from "../js/lexicon.js";

setDict(JSON.parse(readFileSync(new URL("../data/dict.json", import.meta.url))));

const stressedVowel = (ph) => ph.slice(ph.indexOf("ˈ") + 1, ph.indexOf("ˈ") + 2);

test("stress lands on the capitalised syllable", async () => {
  const cases = [["bah-stee-AH", "ɑ", 2], ["TOKE-vil", "O", 0], ["HIGH-ek", "I", 0], ["rwah-NAY", "A", 1], ["BAT-tle", "æ", 0]];
  for (const [input, vowel] of cases) {
    const ph = await respellToPhonemes(input);
    assert.ok(ph.includes("ˈ"), `${input} -> ${ph}`);
    assert.equal(stressedVowel(ph), vowel, `${input} -> ${ph}`);
  }
});

test("fragments are not spelled letter by letter", async () => {
  const ph = await respellToPhonemes("BAT-tle");
  assert.ok(!/ɛl/.test(ph) && ph.length < 10, ph); // not "bat-tee-el-ee"
});
