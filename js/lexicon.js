// Name pronunciations: built-in list (data/names.json) + the reader's own fixes (saved in this browser).
import { VOCAB } from "./vocab.js";
import { known, common, dictPhonemes, dictWord, espeak } from "./g2p.js";

const KEY = "readalong:lexicon";
const IPA_FIX = [["eɪ", "A"], ["aɪ", "I"], ["oʊ", "O"], ["aʊ", "W"], ["ɔɪ", "Y"], ["dʒ", "ʤ"], ["tʃ", "ʧ"], ["ɚ", "əɹ"],
  ["ɝ", "ɜɹ"], ["'", "ˈ"], ["ɫ", "l"], ["r", "ɹ"], ["g", "ɡ"], ["e", "A"], ["o", "O"], ["ɐ", "ə"], ["ː", ""]];

export function cleanPhonemes(p) {
  p = p.trim().replace(/^[/[\]]+|[/[\]]+$/g, "").trim();
  for (const [a, b] of IPA_FIX) p = p.split(a).join(b);
  return "/" + [...p].filter((c) => c in VOCAB).join("") + "/";
}

/** 'bah-stee-AH' -> '/bɑstiˈɑ/': each chunk is sounded out; the CAPITALISED chunk carries the stress. */
export async function respellToPhonemes(text) {
  const chunks = text.trim().split(/[-\s·]+/).filter(Boolean);
  const hasCaps = chunks.some((c) => c === c.toUpperCase() && c !== c.toLowerCase());
  const out = [];
  for (const c of chunks) {
    let ph = dictWord(c.toLowerCase()) || (await espeak(c.toLowerCase())) || "";
    ph = ph.replace(/ /g, "");
    if (hasCaps) {
      ph = ph.replace(/[ˈˌ]/g, "");
      if (c === c.toUpperCase() && c !== c.toLowerCase()) {
        const m = ph.search(/[AIOQWYaeiouæɑɒɔəɛɜɪʊʌᵻ]/);
        ph = m >= 0 ? ph.slice(0, m) + "ˈ" + ph.slice(m) : "ˈ" + ph;
      }
    }
    out.push(ph);
  }
  return "/" + out.join("") + "/";
}

export async function toPhonemes(value) {
  const v = value.trim();
  return v.startsWith("/") || v.startsWith("[") ? cleanPhonemes(v) : respellToPhonemes(v);
}

export class Lexicon {
  constructor(builtin = {}) {
    this.builtin = Object.fromEntries(Object.entries(builtin).filter(([k]) => !k.startsWith("_")));
    try { this.user = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { this.user = {}; }
  }
  static async load(url) {
    let b = {};
    try { b = await (await fetch(url)).json(); } catch { /* offline */ }
    return new Lexicon(b);
  }
  version() { return JSON.stringify(this.user).length + ":" + Object.keys(this.user).sort().join(","); }
  lookup(word) {
    for (const [src, table] of [["user", this.user], ["builtin", this.builtin]]) {
      for (const key of [word, /^[A-Z]/.test(word) ? word.charAt(0) + word.slice(1).toLowerCase() : null]) {
        if (key && key in table) {
          const v = table[key];
          return [src, typeof v === "object" ? v.ph || v.hint || "" : v];
        }
      }
    }
    return null;
  }
  async setUser(word, value) {
    if (value == null || !String(value).trim()) delete this.user[word];
    else this.user[word] = { ph: await toPhonemes(String(value)), hint: String(value).trim() };
    try { localStorage.setItem(KEY, JSON.stringify(this.user)); } catch { /* storage full or blocked */ }
  }
  known(word) { return known(word); }
  common(word) { return common(word); }
  archaicVerb(low) {
    if (known(low)) return null;
    for (const [suf, add] of [["eth", "ᵻθ"], ["est", "ᵻst"], ["th", "θ"]]) {
      if (low.endsWith(suf) && low.length > suf.length + 2) {
        const stem = low.slice(0, -suf.length);
        for (const cand of [stem, stem + "e", stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : null]) {
          if (cand && known(cand)) {
            const ph = dictPhonemes(cand);
            if (ph) return "/" + ph + add + "/";
          }
        }
      }
    }
    return null;
  }
}
