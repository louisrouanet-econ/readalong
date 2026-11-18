// Words -> Kokoro phonemes. Port of the parts of misaki (hexgrad/misaki, Apache-2.0) that matter for
// English reading: gold/silver dictionaries, -s/-ed/-ing inflection rules, special function words,
// letter-by-letter acronyms, and espeak-ng as a fallback for words no dictionary knows (names).
import { VOCAB } from "./vocab.js";
import { cardinal } from "./numbers.js";

let DICT = null;
let GOLD_LOWER = null;
let espeakMod = null;

export async function loadDict(url) {
  if (DICT) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load the pronunciation dictionary");
  DICT = await res.json();
  GOLD_LOWER = new Set(Object.keys(DICT.gold).map((k) => k.toLowerCase()));
}
export function setDict(d) { DICT = d; GOLD_LOWER = new Set(Object.keys(d.gold).map((k) => k.toLowerCase())); }
export const dictReady = () => !!DICT;

const PRIMARY = "ˈ", SECONDARY = "ˌ";
const VOWELS = new Set("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ");
const US_TAUS = new Set("AIOWYiuæɑəɛɪɹʊʌ");
const isAlpha = (s) => /^[A-Za-z]+$/.test(s);
const isUpper = (s) => s === s.toUpperCase() && s !== s.toLowerCase();
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// misaki "grows" the dictionary so lowercase entries also match Capitalised words and vice versa
function raw(table, w) {
  let v = table[w];
  if (v === undefined && w.length > 1) {
    if (w === w.toLowerCase()) v = table[capitalize(w)];
    else if (w === capitalize(w)) v = table[w.toLowerCase()];
  }
  return v;
}
const inGold = (w) => raw(DICT.gold, w) !== undefined;
const inSilver = (w) => raw(DICT.silver, w) !== undefined;

function isKnown(w) {
  if (inGold(w) || inSilver(w)) return true;
  if (!isAlpha(w.replace(/'/g, ""))) return false;
  if (w.length === 1) return true;
  if (w === w.toUpperCase() && inGold(w.toLowerCase())) return true;
  return w.slice(1) === w.slice(1).toUpperCase();
}

function nnp(word) {
  const ps = [];
  for (const c of word) {
    if (!/[A-Za-z]/.test(c)) continue;
    const p = raw(DICT.gold, c.toUpperCase());
    if (p == null) return null;
    ps.push(p);
  }
  let s = ps.join("").replaceAll(PRIMARY, SECONDARY);
  const k = s.lastIndexOf(SECONDARY);
  if (k >= 0) s = s.slice(0, k) + PRIMARY + s.slice(k + 1);
  return s;
}

function lookup(word) {
  let isNNP = false;
  if (word === word.toUpperCase() && !inGold(word)) { word = word.toLowerCase(); isNNP = true; }
  let ps = raw(DICT.gold, word);
  if (ps == null && !isNNP) ps = raw(DICT.silver, word);
  if (ps == null || (isNNP && !ps.includes(PRIMARY))) {
    const n = nnp(word);
    if (n) return n;
  }
  return ps ?? null;
}

function _s(stem) {
  if (!stem) return null;
  const l = stem[stem.length - 1];
  if ("ptkfθ".includes(l)) return stem + "s";
  if ("szʃʒʧʤ".includes(l)) return stem + "ᵻz";
  return stem + "z";
}
function stemS(w) {
  if (w.length < 3 || !w.endsWith("s")) return null;
  let stem;
  if (!w.endsWith("ss") && isKnown(w.slice(0, -1))) stem = w.slice(0, -1);
  else if ((w.endsWith("'s") || (w.length > 4 && w.endsWith("es") && !w.endsWith("ies"))) && isKnown(w.slice(0, -2))) stem = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies") && isKnown(w.slice(0, -3) + "y")) stem = w.slice(0, -3) + "y";
  else return null;
  return _s(lookup(stem));
}
function _ed(stem) {
  if (!stem) return null;
  const l = stem[stem.length - 1];
  if ("pkfθʃsʧ".includes(l)) return stem + "t";
  if (l === "d") return stem + "ᵻd";
  if (l !== "t") return stem + "d";
  if (stem.length < 2) return stem + "ɪd";
  if (US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + "ɾᵻd";
  return stem + "ᵻd";
}
function stemEd(w) {
  if (w.length < 4 || !w.endsWith("d")) return null;
  let stem;
  if (!w.endsWith("dd") && isKnown(w.slice(0, -1))) stem = w.slice(0, -1);
  else if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed") && isKnown(w.slice(0, -2))) stem = w.slice(0, -2);
  else return null;
  return _ed(lookup(stem));
}
function _ing(stem) {
  if (!stem) return null;
  if (stem.length > 1 && stem.endsWith("t") && US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + "ɾɪŋ";
  return stem + "ɪŋ";
}
function stemIng(w) {
  if (w.length < 5 || !w.endsWith("ing")) return null;
  let stem;
  if (w.length > 5 && isKnown(w.slice(0, -3))) stem = w.slice(0, -3);
  else if (isKnown(w.slice(0, -3) + "e")) stem = w.slice(0, -3) + "e";
  else if (w.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(w) && isKnown(w.slice(0, -4))) stem = w.slice(0, -4);
  else return null;
  return _ing(lookup(stem));
}

/** Dictionary pronunciation of one word, or null if only a guess (espeak) is possible. */
export function dictWord(word) {
  if (!DICT) throw new Error("dictionary not loaded");
  word = word.replace(/’/g, "'");
  const wl = word.toLowerCase();
  if (word.length > 1 && isAlpha(word.replace(/'/g, "")) && word !== wl && !inGold(word) && !inSilver(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (inGold(wl) || inSilver(wl) || stemS(wl) || stemEd(wl) || stemIng(wl))) word = wl;
  if (isKnown(word)) return lookup(word);
  if (word.endsWith("s'") && isKnown(word.slice(0, -2) + "'s")) return lookup(word.slice(0, -2) + "'s");
  if (word.endsWith("'") && isKnown(word.slice(0, -1))) return lookup(word.slice(0, -1));
  return stemS(word) || stemEd(word) || stemIng(word) || null;
}

/** In the dictionary, directly or as a regular inflection (used for hyphen joins, OCR repair, name lists). */
export function known(word) {
  if (!word || !DICT) return false;
  if (inGold(word) || inSilver(word) || inGold(word.toLowerCase()) || inSilver(word.toLowerCase())) return true;
  const w = word.toLowerCase().replace(/’/g, "'");
  if (w.includes("-")) return w.split("-").filter(Boolean).every(known);
  const c = [];
  if (w.endsWith("'s")) c.push(w.slice(0, -2));
  if (w.endsWith("ies")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("es")) c.push(w.slice(0, -2));
  if (w.endsWith("s")) c.push(w.slice(0, -1));
  if (w.endsWith("ied")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) c.push(w.slice(0, -2), w.slice(0, -1), w.length > 4 && w[w.length - 3] === w[w.length - 4] ? w.slice(0, -3) : null);
  if (w.endsWith("ing")) c.push(w.slice(0, -3), w.slice(0, -3) + "e", w.length > 5 && w[w.length - 4] === w[w.length - 5] ? w.slice(0, -4) : null);
  if (w.endsWith("ly")) c.push(w.slice(0, -2), w.endsWith("ily") ? w.slice(0, -3) + "y" : null);
  if (w.endsWith("er") || w.endsWith("est")) c.push(w.slice(0, -2), w.slice(0, -3), w.slice(0, -1));
  return c.some((x) => x && (x in DICT.gold || x in DICT.silver));
}
export const common = (word) => !!GOLD_LOWER && GOLD_LOWER.has(word.toLowerCase());
export const dictPhonemes = (word) => (DICT ? raw(DICT.gold, word) ?? raw(DICT.silver, word) ?? raw(DICT.gold, word.toLowerCase()) ?? raw(DICT.silver, word.toLowerCase()) ?? null : null);

// ------------------------------------------------------------------ espeak fallback
const E2M = [["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"], ["aɪ", "I"], ["aʊ", "W"], ["dʒ", "ʤ"], ["eɪ", "A"], ["tʃ", "ʧ"], ["ɔɪ", "Y"],
  ["oʊ", "O"], ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""], ["ɚ", "əɹ"], ["r", "ɹ"], ["x", "k"], ["ç", "k"], ["ɐ", "ə"],
  ["ɬ", "l"], ["̃", ""], ["ɜːɹ", "ɜɹ"], ["ɜː", "ɜɹ"], ["ɪə", "iə"], ["ː", ""], ["e", "A"], ["o", "ɔ"], ["ɾ", "T"],
  ["ʔ", "t"]];

export function mapEspeak(ps) {
  ps = ps.trim();
  for (const [a, b] of E2M) ps = ps.split(a).join(b);
  ps = ps.replace(/(\S)̩/g, "ᵊ$1").replace(/̩/g, "");
  return [...ps].filter((c) => c in VOCAB || c === " ").join("");
}

let espeakQueue = Promise.resolve();
export async function espeak(word) {
  if (!espeakMod) {
    // the espeak bundle reads its data with `for await (chunk of stream)`, which Safari does not support
    if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
      ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
        const reader = this.getReader();
        try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } } finally { reader.releaseLock(); }
      };
    }
    espeakMod = await import(new URL("../vendor/phonemizer.js", import.meta.url).href);
  }
  // espeak keeps global state; serialise calls
  const run = espeakQueue.then(() => espeakMod.phonemize(word, "en-us"));
  espeakQueue = run.catch(() => {});
  const out = await run;
  return mapEspeak(out.join(" "));
}

// ------------------------------------------------------------------ text -> phonemes
const PUNCT_OPEN = new Set(["“", "(", "\""]);
const PUNCT_CLOSE = new Set(["”", ")", ",", ".", ";", ":", "!", "?", "—", "…"]);
const MARKUP = /\[([^\]]+)\]\((\/[^)]*\/)\)/g;

/** Split a token's spoken text into pieces: {w: word} | {p: punctuation} | {ph: phonemes, w}. */
export function pieces(say) {
  const out = [];
  let last = 0;
  const push = (txt) => {
    const re = /([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’]*(?:-[A-Za-zÀ-ÖØ-öø-ÿ'’]+)*)|(\d+)|([“”"(),.;:!?—…])|(['‘’])/g;
    let m;
    while ((m = re.exec(txt))) {
      if (m[1]) out.push({ w: m[1] });
      else if (m[2]) out.push({ w: cardinal(+m[2]), num: true });
      else if (m[3]) out.push({ p: m[3] === "\"" ? "“" : m[3] });
    }
  };
  for (const m of say.matchAll(MARKUP)) {
    push(say.slice(last, m.index));
    out.push({ w: m[1], ph: m[2].slice(1, -1) });
    last = m.index + m[0].length;
  }
  push(say.slice(last));
  // numbers that came back as words ("twenty-three") are split later like any hyphenated word
  return out;
}

const FUNCTION_WORDS = new Set(["a", "an", "the", "to", "in", "I", "used", "vs", "vs.", "am"]);
// Kokoro v1.0 was trained with flaps written T and glottal stops written t (misaki does this for version 1.0)
const v1 = (ps) => (ps == null ? ps : ps.replace(/ɾ/g, "T").replace(/ʔ/g, "t"));

function restress(ps) {
  const chars = [...ps];
  const pos = chars.map((c, i) => i);
  chars.forEach((c, i) => {
    if (c === PRIMARY || c === SECONDARY) {
      const j = chars.findIndex((v, k) => k > i && VOWELS.has(v));
      if (j >= 0) pos[i] = j - 0.5;
    }
  });
  return pos.map((p, i) => [p, chars[i]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join("");
}
/** misaki apply_stress: stress null = leave; 0.5 = add light stress if none; 2 = make it primary; -1 = demote. */
export function applyStress(ps, stress) {
  if (stress == null || !ps) return ps;
  const hasP = ps.includes(PRIMARY), hasS = ps.includes(SECONDARY);
  const hasV = [...ps].some((c) => VOWELS.has(c));
  if (stress < -1) return ps.replaceAll(PRIMARY, "").replaceAll(SECONDARY, "");
  if (stress === -1 || ((stress === 0 || stress === -0.5) && hasP)) return ps.replaceAll(SECONDARY, "").replaceAll(PRIMARY, SECONDARY);
  if ([0, 0.5, 1].includes(stress) && !hasP && !hasS) return hasV ? restress(SECONDARY + ps) : ps;
  if (stress >= 1 && !hasP && hasS) return ps.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !hasP && !hasS) return hasV ? restress(PRIMARY + ps) : ps;
  return ps;
}
const capStress = (w) => (w === w.toLowerCase() ? null : w.length > 1 && w === w.toUpperCase() ? 2 : 0.5);

/** Phonemes for a list of word strings in running text; resolves 'the/a/to/in' from the next word. */
export async function phonemizeWords(words, fixed = []) {
  const ps = new Array(words.length).fill(null);
  const guessed = new Array(words.length).fill(false);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (fixed[i] != null) { ps[i] = fixed[i]; continue; } // pronunciation given (name fixes, letters): still context for "the"
    if (FUNCTION_WORDS.has(w) || FUNCTION_WORDS.has(w.toLowerCase())) continue;
    let p = dictWord(w);
    if (p == null && w.includes("-")) {
      // compounds: parts joined, earlier parts carry only secondary stress (misaki style)
      const parts = w.split("-").filter(Boolean);
      const sub = parts.map((x) => dictWord(x));
      if (sub.every((x) => x != null)) p = sub.map((x, k) => (k < sub.length - 1 ? applyStress(x, -1) : x)).join("");
    }
    if (p != null) p = applyStress(p, capStress(w));
    if (p == null) {
      p = (await espeak(w)) || "";
      guessed[i] = true;
    }
    ps[i] = p;
  }
  for (let i = words.length - 1; i >= 0; i--) { // right to left, so "to the end" sees "the" resolved
    if (ps[i] != null) continue;
    const w = words[i], wl = w.toLowerCase();
    const next = ps.slice(i + 1).find((x) => x);
    const fv = next == null ? null : VOWELS.has([...next].find((c) => VOWELS.has(c) || /[a-zɹʃʒʤʧθðŋɡ]/.test(c)));
    if (wl === "the") ps[i] = fv ? "ði" : "ðə";
    else if (wl === "a") ps[i] = w === "A" && fv == null ? "ˈA" : "ɐ";
    else if (wl === "an") ps[i] = "ɐn";
    else if (wl === "to") ps[i] = fv == null ? raw(DICT.gold, "to") : fv ? "tʊ" : "tə";
    else if (wl === "in") ps[i] = fv == null ? "ˈɪn" : "ɪn";
    else if (w === "I") ps[i] = "ˌI";
    else if (wl === "used") ps[i] = "jˈuzd";
    else if (wl === "am") ps[i] = fv == null ? dictWord("am") : "ɐm";
    else if (wl === "vs" || wl === "vs.") ps[i] = dictWord("versus");
    else ps[i] = dictWord(w) || "";
  }
  return { ps: ps.map(v1), guessed };
}

/** Phonemes for each token's spoken text, with context across tokens (so "the" sees the next word).
 *  Returns an array of phoneme strings (words space-separated, punctuation attached). */
export async function phonemizeTokens(says, guessedSink) {
  const all = says.map(pieces);
  const words = [], fixed = [];
  for (const pcs of all) for (const p of pcs) if (p.w) { words.push(p.w); fixed.push(p.ph ?? null); }
  const { ps, guessed } = await phonemizeWords(words, fixed);
  let k = 0;
  return all.map((pcs) => {
    let out = "";
    for (const p of pcs) {
      if (p.p) {
        if (PUNCT_OPEN.has(p.p)) out += (out && !out.endsWith(" ") ? " " : "") + p.p;
        else out += p.p;
        continue;
      }
      let ph = p.ph;
      if (ph == null) { ph = ps[k]; if (guessed[k] && guessedSink) guessedSink.add(p.w); }
      k++;
      if (!ph) continue;
      if (out && !out.endsWith(" ") && !/[“(]$/.test(out)) out += " ";
      out += ph;
    }
    return [...out].filter((c) => c in VOCAB).join("");
  });
}
