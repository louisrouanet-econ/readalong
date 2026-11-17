// What the narrator says for tricky printed text: letters vs words, Roman numerals, separators, possessives, titles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setDict, phonemizeTokens } from "../js/g2p.js";
import { Normalizer, buildTokens } from "../js/normalize.js";
import { Lexicon } from "../js/lexicon.js";

setDict(JSON.parse(readFileSync(new URL("../data/dict.json", import.meta.url))));
const lex = new Lexicon({});

/** text -> [spoken text, phonemes]; words wrapped in *stars* are set in italics. */
async function say(text, docWords = []) {
  const words = text.split(" ").map((t) => (/^\*.*\*[,.]?$/.test(t) ? { t: t.replace(/\*/g, ""), it: 1 } : { t }));
  const toks = buildTokens(words, words.map((_, i) => i), () => true);
  const norm = new Normalizer(lex, { capWords: Normalizer.capWords([...words.map((w) => w.t), ...docWords]) });
  norm.normalize(toks, "para", false);
  const ph = await phonemizeTokens(toks.map((t) => t.say || ""));
  return [toks.map((t) => t.plain).filter(Boolean).join(" "), ph.filter(Boolean).join(" ")];
}

test("US in running text is spelled out", async () => {
  const [, ph] = await say("The US economy grew, and it surprised us.");
  assert.match(ph, /ðə jˌuˈɛs \S*kˈɑnəmi/);
  assert.match(ph, /[ˈˌ]ʌs\.$/); // the pronoun stays "us"
});

test("a capital A after a word is the letter, but the article starts a sentence or a title", async () => {
  assert.match((await say("Compare bond A, with a price of 102, to bond B."))[1], /bˈɑnd ˈA,/);
  assert.match((await say("Plan A and plan B both failed."))[1], /ˈA ænd/);
  assert.match((await say("A study found this."))[1], /^ɐ stˈʌdi/);
  assert.match((await say("She wrote A Theory of Value in 1950."))[1], /ɹˈOt ɐ θˈ/);
});

test("Roman numeral I after Section, Part, War, Type is one", async () => {
  assert.match((await say("The goals of Section I: to explain."))[0], /Section one:/);
  assert.match((await say("After World War I the economy changed."))[0], /War one the/);
  assert.match((await say("This is a Type I error."))[0], /Type one error/);
  assert.match((await say("In Section II we show that I was wrong."))[0], /Section two we show that I was/);
  assert.match((await say("Class C shares cost more."))[0], /^Class C shares/); // a grade, not 100
});

test("a row of dashes is silent; a single dash is a pause", async () => {
  const [spoken] = await say("- - - - - - The story begins here.");
  assert.equal(spoken, "The story begins here.");
  assert.match((await say("It was a model - a simple one."))[0], /model — a/);
});

test("possessive of a name ending in s is said with -es; plural possessives are not", async () => {
  assert.match((await say("We read Keynes’ essay."))[1], /nzᵻz ˈɛsA/);
  const [plural] = await say("The Vanderbilts’ fortune vanished.", ["Vanderbilt"]);
  assert.match(plural, /Vanderbilts' fortune/);
});

test("an italic title run into the sentence gets a short pause after it", async () => {
  assert.match((await say("He read *Liar’s* *Poker* together with friends."))[0], /Poker, together/);
  // a defined term after "the" is not a title
  assert.doesNotMatch((await say("The *Expected* *Utility* you get is a model."))[0], /Utility,/);
  // already followed by punctuation: nothing added
  assert.match((await say("He read *Inventing* *Money*. It was good."))[0], /Money\. It/);
});
