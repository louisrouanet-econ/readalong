// Same expectations as ReadingApp_1/tests/test_normalize.py. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setDict } from "../js/g2p.js";
import { Lexicon } from "../js/lexicon.js";
import { Normalizer, Token, buildTokens, splitSentences } from "../js/normalize.js";

setDict(JSON.parse(readFileSync(new URL("../data/dict.json", import.meta.url))));
const LEX = new Lexicon(JSON.parse(readFileSync(new URL("../data/names.json", import.meta.url))));
const CASES = JSON.parse(readFileSync(new URL("./normalize_cases.json", import.meta.url)));

function say(text, blockType = "para", archaic = false, opts = {}) {
  const toks = text.split(" ").map((t, i) => new Token(t, [i]));
  new Normalizer(LEX, opts).normalize(toks, blockType, archaic);
  return toks.filter((t) => t.say).map((t) => t.say).join(" ");
}

for (const [src, expected] of CASES) test(`spoken: ${src}`, () => assert.equal(say(src), expected));

test("names use phonemes", () => {
  const out = say("Bastiat and Hayek and Tocqueville's");
  assert.ok(out.includes("[Bastiat](/") && out.includes("[Hayek](/") && out.includes("[Tocqueville's](/"), out);
});
test("citations skipped by default", () => {
  assert.equal(say("theft (Olson 1982, 23) is bad"), "theft is bad");
  assert.equal(say("as shown (see Buchanan and Tullock 1962). Next"), "as shown . Next");
  assert.ok(say("Banfield's (1958) account", "para", false, { readCitations: true }).includes("nineteen fifty-eight"));
});
test("non-citation parentheses kept", () => assert.equal(say("the state (which is bad) taxes"), "the state (which is bad) taxes"));
test("archaic spellings", () => {
  assert.equal(say("onely the warre", "para", true), "only the war");
  assert.ok(say("ariseth", "para", true).includes("[ariseth](/"));
});
test("curly apostrophe", () => assert.equal(say("the glazier’s trade"), "the glazier's trade"));
test("hyphen join and drop cap", () => {
  const words = [{ t: "Igno-", hy: 1 }, { t: "rance", nl: 1 }, { t: "self-", hy: 1 }, { t: "interest", nl: 1 },
    { t: "I" }, { t: "n", glue: 1 }, { t: "costs." }, { t: "12", sup: 1, glue: 1 }];
  const toks = buildTokens(words, words.map((_, i) => i), (w) => LEX.known(w));
  assert.deepEqual(toks.map((t) => t.text), ["Ignorance", "self-interest", "In", "costs."]);
  assert.deepEqual(toks[0].w, [0, 1]);
});
test("sentences", () => {
  const toks = "John Q. Citizen saw M.F. Chamans. He left, e.g. Dr. Smith did. Then pp. 5 ended.".split(" ").map((t) => new Token(t));
  const s = splitSentences(toks).map(([a, b]) => toks.slice(a, b).map((t) => t.text).join(" "));
  assert.deepEqual(s, ["John Q. Citizen saw M.F. Chamans.", "He left, e.g. Dr. Smith did.", "Then pp. 5 ended."]);
});
