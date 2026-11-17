// Printed text -> what a narrator says. Port of ReadingApp_1/reader/normalize.py (keep the two in step).
// A token is one spoken word and remembers the display words (ids) it came from.
// tok.say: text sent to pronunciation (may hold [word](/phonemes/) markup); "" = silent.
import { cardinal, ordinal, yearWords } from "./numbers.js";

export class Token {
  constructor(text, w = []) { this.text = text; this.w = w; this.say = ""; this.plain = ""; this.skip = false; this.lex = null; }
}

const PUNCT_LEAD = "\"'“‘([{«¿¡*";
const PUNCT_TRAIL = "\"'”’)]}».,;:!?*…";

export const ABBR = {
  "pp.": ["pages", false], "p.": ["page", true], "Vol.": ["volume", false], "vol.": ["volume", false],
  "Vols.": ["volumes", false], "vols.": ["volumes", false], "No.": ["number", true], "no.": ["number", true],
  "Nos.": ["numbers", true], "Ch.": ["chapter", false], "ch.": ["chapter", false], "Chap.": ["chapter", false],
  "chap.": ["chapter", false], "CHAP.": ["chapter", false], "Chs.": ["chapters", false],
  "Sec.": ["section", false], "sec.": ["section", false], "Fig.": ["figure", false], "fig.": ["figure", false],
  "Figs.": ["figures", false], "Eq.": ["equation", false], "eq.": ["equation", false], "e.g.": ["for example", false],
  "e.g.,": ["for example,", false], "i.e.": ["that is", false], "i.e.,": ["that is,", false],
  "etc.": ["et cetera", false], "cf.": ["compare", false], "Cf.": ["compare", false], "viz.": ["namely", false],
  "vs.": ["versus", false], "v.": ["versus", false], "eds.": ["editors", false], "Eds.": ["editors", false],
  "trans.": ["translated by", false], "Trans.": ["translated by", false], "repr.": ["reprinted", false],
  "n.d.": ["no date", false], "ibid.": ["ibid", false], "Ibid.": ["ibid", false], "op.": ["op", false],
  "cit.": ["cit", false], "para.": ["paragraph", false], "approx.": ["approximately", false],
  "Dr.": ["Doctor", false], "Mr.": ["Mister", false], "Mrs.": ["Missus", false], "Ms.": ["Miz", false],
  "Prof.": ["Professor", false], "Jr.": ["Junior", false], "Sr.": ["Senior", false], "c.": ["circa", true],
  "ca.": ["circa", true], "n.": ["note", true], "nn.": ["notes", true], "Art.": ["article", false],
  "art.": ["article", false], "Bk.": ["book", false], "bk.": ["book", false], "Pt.": ["part", false],
  "pt.": ["part", false], "et al.": ["et al", false], "al.": ["al", false], "Ed.": ["edited by", false],
  "ed.": ["edited by", false], "esp.": ["especially", false], "Gov.": ["Governor", false], "Sen.": ["Senator", false],
  "Rep.": ["Representative", false], "Gen.": ["General", false], "Capt.": ["Captain", false],
  "Rev.": ["Reverend", false], "St.": ["Saint", false], "Mt.": ["Mount", false], "Ft.": ["Fort", false],
};
const END_OK = new Set(["etc.", "ibid.", "Ibid.", "al.", "et al.", "n.d.", "cit.", "Jr.", "Sr.", "approx."]);
const NEVER_END = new Set([...Object.keys(ABBR).filter((k) => !END_OK.has(k)),
  "Mr.", "Mrs.", "Ms.", "Dr.", "St.", "Prof.", "vs.", "v.", "e.g.", "i.e.", "cf.", "Cf.", "viz."]);
const REGNAL = new Set(["edward", "henry", "louis", "george", "charles", "william", "james", "richard", "john", "philip",
  "frederick", "pius", "leo", "gregory", "innocent", "clement", "elizabeth", "napoleon", "alexander", "peter",
  "catherine", "ferdinand", "isabella", "otto", "rudolf", "benedict", "paul", "boniface", "urban", "alfonso", "carlos",
  "felipe", "ludwig", "victor", "umberto", "mary", "anne"]);
const ROMAN_CTX = new Set(["war", "chapter", "chap", "chap.", "ch.", "ch", "book", "bk.", "part", "pt.", "vol.", "volume",
  "section", "sec.", "article", "art.", "act", "scene", "letter", "no.", "number", "appendix", "lecture", "essay", "canto",
  "psalm", "title", "amendment", ...REGNAL]);
const ROMAN_RE = /^(M{0,3})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VAL = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const SYMBOLS = { "&": "and", "§": "section", "§§": "sections", "¶": "paragraph", "%": "percent", "°": "degrees",
  "×": "times", "=": "equals", "+": "plus", "±": "plus or minus", "≈": "approximately", "~": "about", "#": "number",
  "@": "at", "→": "leads to", "/": "or", "<": "less than", ">": "greater than", "≤": "at most", "≥": "at least",
  "-": "—", "–": "—", "•": "", "·": "", "†": "", "‡": "", "*": "" };
const CURRENCY = { "$": ["dollar", "dollars", "cent", "cents"], "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"], "¥": ["yen", "yen", "", ""] };
const SCALE = new Set(["thousand", "million", "billion", "trillion"]);
const ARCHAIC = { onely: "only", warre: "war", warres: "wars", bee: "be", meer: "mere", meerly: "merely", chuse: "choose",
  shew: "show", shewed: "showed", shewn: "shown", encrease: "increase", untill: "until", beleeve: "believe",
  beleef: "belief", doe: "do", goe: "go", sonne: "son", owne: "own", neere: "near", farre: "far", lesse: "less",
  selfe: "self", himselfe: "himself", itselfe: "itself", herselfe: "herself", yeare: "year", yeares: "years",
  alwayes: "always", dayes: "days", wayes: "ways", kinde: "kind", minde: "mind", gaine: "gain", againe: "again",
  deale: "deal", griefe: "grief", lawes: "laws", hee: "he", wee: "we", shee: "she", mee: "me" };
const ARCHAIC_MARKERS = new Set(["hath", "doth", "onely", "warre", "selfe", "himselfe", "shew", "equall", "generall",
  "naturall", "civill", "lawes", "alwayes", "untill", "beleeve", "chuse", "thee", "thou", "thy", "hee", "bee", "feare",
  "againe", "deale", "kinde", "minde"]);
const ACRONYM_OK = /^[A-Z]{2,6}s?$/;
const YEAR_STOP_PREV = new Set(["page", "pages", "p.", "pp.", "no.", "number", "$", "vol.", "volume", "figure", "fig.", "table"]);
const YEAR_STOP_NEXT = new Set(["%", "percent", "people", "persons", "men", "women", "dollars", "pounds", "francs", "units",
  "workers", "soldiers", "votes", "voters", "members", "acres", "miles", "km", "kilometers", "tons", "times"]);
const CITE_YEAR = /\b(1[5-9]\d\d|20\d\d)[a-z]?\b|\bn\.d\.|\bforthcoming\b/;
const URL_RE = /^(https?:\/\/|www\.)\S+$|^\S+@\S+\.\w+$|^\S+\.(com|org|edu|gov|net|htm|html)(\/\S*)?$/i;
const CITE_LOWER_OK = new Set(["see", "and", "et", "al", "also", "e.g", "cf", "p", "pp", "eds", "ed", "for", "in", "chap",
  "ch", "n", "esp", "vol", "no", "i.e", "the", "of", "von", "de", "van", "der", "forthcoming", "emphasis", "added",
  "quoted", "cited"]);

const isUpper = (s) => s === s.toUpperCase() && s !== s.toLowerCase();
const isLower = (s) => s === s.toLowerCase() && s !== s.toUpperCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function splitPunct(t) {
  let i = 0, j = t.length;
  while (i < j && PUNCT_LEAD.includes(t[i])) i++;
  while (j > i && PUNCT_TRAIL.includes(t[j - 1])) j--;
  let lead = t.slice(0, i), core = t.slice(i, j), trail = t.slice(j);
  if (/['’]$/.test(lead) && /^\d/.test(core)) { lead = lead.slice(0, -1); core = "'" + core; }
  if (trail.startsWith(".") && core && (ABBR[core + "."] || /^([A-Za-z]\.)*[A-Za-z]$/.test(core))) {
    core += "."; trail = trail.slice(1);
  }
  return [lead, core, trail];
}

export function romanValue(s) {
  s = s.toUpperCase().replace(/\.$/, "");
  if (!s || !ROMAN_RE.test(s)) return null;
  let total = 0, prev = 0;
  for (const ch of [...s].reverse()) {
    const v = ROMAN_VAL[ch];
    total = v < prev ? total - v : total + v;
    prev = Math.max(prev, v);
  }
  return total || null;
}
const isYear = (s) => /^(1[0-9]\d\d|20\d\d)$/.test(s);

function pluralDecade(base) { return base.endsWith("y") ? base.slice(0, -1) + "ies" : base + "s"; }

export function numberWords(core, prev = "", nxt = "", allowYear = true) {
  const c = core.replace("−", "-");
  const pl = prev.toLowerCase(), nl = nxt.toLowerCase();
  let m = c.match(/^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/);
  if (m) {
    const whole = m[1].replace(/,/g, "");
    if (m[2]) {
      return m[2].length <= 5 ? cardinal(Number(whole + m[2]))
        : cardinal(Number(whole)) + " point " + [...m[2].slice(1)].map((d) => cardinal(+d)).join(" ");
    }
    const n = Number(whole);
    if (allowYear && !m[1].includes(",") && isYear(whole) && !YEAR_STOP_PREV.has(pl) && !YEAR_STOP_NEXT.has(nl)) return yearWords(n);
    if (whole.length > 1 && whole.startsWith("0")) return [...whole].map((d) => cardinal(+d)).join(" ");
    return cardinal(n);
  }
  if ((m = c.match(/^(1[0-9]|20)(\d)0['’]?s$/))) return pluralDecade(yearWords(Number(m[1] + m[2] + "0")));
  if ((m = c.match(/^['’]?(\d)0s$/))) return pluralDecade(cardinal(Number(m[1]) * 10));
  if ((m = c.match(/^(1[5-9]\d\d|20\d\d)([a-z])$/))) return yearWords(Number(m[1])) + " " + m[2].toUpperCase();
  if ((m = c.match(/^(\d+)(st|nd|rd|th|d)$/i))) return ordinal(Number(m[1]));
  if ((m = c.match(/^(\d+)[-–—](\d+)$/))) {
    const [a, b] = [m[1], m[2]];
    const pages = ["pp.", "pages", "p.", "page", "pages,"].includes(pl);
    if (!pages && isYear(a) && (isYear(b) || b.length === 2)) {
      if (b.length === 2) {
        const bb = Number(a.slice(0, 2) + b);
        let bw = yearWords(bb);
        if (bw.includes(" ") && Number(b) >= 10) bw = bw.split(" ").slice(1).join(" ");
        return `${yearWords(Number(a))} to ${bw}`;
      }
      return `${yearWords(Number(a))} to ${yearWords(Number(b))}`;
    }
    return `${cardinal(Number(a))} to ${cardinal(Number(b))}`;
  }
  if ((m = c.match(/^(\d+)\/(\d+)$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (b === 2) return a === 1 ? `${cardinal(a)} half` : `${cardinal(a)} halves`;
    if (b === 4) return `${cardinal(a)} quarter` + (a > 1 ? "s" : "");
    if (b > 2 && b < 100) return `${cardinal(a)} ${ordinal(b)}` + (a > 1 ? "s" : "");
    return `${cardinal(a)} over ${cardinal(b)}`;
  }
  return null;
}

export class Normalizer {
  constructor(lexicon, options = {}) {
    this.lex = lexicon;
    this.opts = { readCitations: false, readUrls: false, ...options };
  }

  detectArchaic(words) {
    let n = 0;
    for (const w of words) if (ARCHAIC_MARKERS.has(w.toLowerCase().replace(/^[.,;:!?()]+|[.,;:!?()]+$/g, ""))) n++;
    return n >= 5;
  }

  normalize(toks, blockType = "para", archaic = false) {
    const n = toks.length;
    if (!this.opts.readCitations) this.markCitations(toks);
    const cores = toks.map((t) => splitPunct(t.text.replace(/’/g, "'").replace(/‘/g, "'")));
    const allCapsBlock = cores.filter(([, c]) => isUpper(c) && c.length > 1).length > 0.6 * Math.max(1, n);
    let pendingSuffix = null;
    toks.forEach((tok, i) => {
      if (tok.skip) { tok.say = tok.plain = ""; return; }
      let [lead, core, trail] = cores[i];
      const prev = i > 0 ? cores[i - 1][1] : "", nxt = i + 1 < n ? cores[i + 1][1] : "";
      let [say, ipa] = this.core(core, prev, nxt, i, blockType, archaic, allCapsBlock, tok);
      if (say == null) say = core;
      if (Array.isArray(say)) { const [s, suf] = say; say = s; if (pendingSuffix) say += " " + pendingSuffix; pendingSuffix = suf; }
      else if (pendingSuffix) { say = say + " " + pendingSuffix; pendingSuffix = null; }
      if (say === "" && core) { tok.say = tok.plain = ""; return; }
      if (END_OK.has(core) && /^[A-Z]/.test(nxt) && !trail.startsWith(".")) trail = "." + trail;
      if (ipa) { tok.say = `${lead}[${ipa[0]}](${ipa[1]})${trail}`; tok.plain = `${lead}${ipa[0]}${trail}`; }
      else tok.say = tok.plain = `${lead}${say}${trail}`;
    });
    return toks;
  }

  markCitations(toks) {
    let i = 0;
    const n = toks.length;
    while (i < n) {
      const t = toks[i].text;
      if (t.startsWith("(") || t.startsWith("[")) {
        const close = t.startsWith("(") ? ")" : "]";
        let j = i;
        while (j < n && j - i < 25 && !toks[j].text.includes(close)) j++;
        if (j < n && toks[j].text.includes(close)) {
          const inner = toks.slice(i, j + 1).map((x) => x.text).join(" ");
          const body = inner.replace(/^[()[\].,;:]+|[()[\].,;:]+$/g, "");
          const words = body.match(/[A-Za-z][A-Za-z'’-]*\.?/g) || [];
          const lower = words.filter((w) => /^[a-z]/.test(w) && !CITE_LOWER_OK.has(w.toLowerCase().replace(/\.$/, "")));
          const caps = words.filter((w) => /^[A-Z]/.test(w));
          const numericRef = close === "]" && /^[\d,\s\-–]+$/.test(body);
          if (numericRef || (CITE_YEAR.test(body) && caps.length && lower.length <= 1)) {
            for (let k = i; k <= j; k++) toks[k].skip = true;
            const tail = toks[j].text.split(close).pop();
            if (tail.trim()) { toks[j].skip = false; toks[j].text = tail; }
            i = j + 1;
            continue;
          }
        }
      }
      i++;
    }
  }

  core(core, prev, nxt, i, blockType, archaic, allCapsBlock, tok) {
    if (!core) return [core, null];
    if (URL_RE.test(core)) return [this.opts.readUrls ? "link" : "", null];
    let hit = this.lex.lookup(core);
    if (hit) {
      const [src, value] = hit;
      tok.lex = src;
      if (value.startsWith("/") && value.endsWith("/") && value.length > 2) return [core, [core, value]];
      return [value, null];
    }
    let m = core.match(/^(.+?)(['’]s)$/);
    if (m) {
      hit = this.lex.lookup(m[1]);
      if (hit && hit[1].startsWith("/")) {
        tok.lex = hit[0];
        const last = hit[1][hit[1].length - 2];
        const suf = "szʃʒʧʤ".includes(last) ? "ᵻz" : "ptkfθ".includes(last) ? "s" : "z";
        return [core, [core.replace("’", "'"), hit[1].slice(0, -1) + suf + "/"]];
      }
    }
    if (core in SYMBOLS) return [SYMBOLS[core], null];
    if (ABBR[core]) {
      let [spoken, needsNum] = ABBR[core];
      if ((core === "Ed." || core === "ed.") && !/^[A-Z]/.test(nxt)) spoken = "edition";
      if (core === "St." && !/^[A-Z]/.test(nxt)) spoken = "Street";
      if (core === "v." && !(/^[A-Z]/.test(prev) && /^[A-Z]/.test(nxt))) return [null, null];
      if (!needsNum || /^\d/.test(nxt) || romanValue(nxt)) return [spoken, null];
    }
    m = core.match(/^([$£€¥])(\d[\d,]*)(\.\d\d)?$/);
    if (m) {
      const [one, many, sub1, subn] = CURRENCY[m[1]];
      const whole = Number(m[2].replace(/,/g, ""));
      if (SCALE.has(nxt.toLowerCase()) || ["m", "bn", "k"].includes(nxt.toLowerCase())) return [[cardinal(whole), many], null];
      let s = `${cardinal(whole)} ${whole === 1 ? one : many}`;
      if (m[3] && Number(m[3].slice(1))) {
        const c = Number(m[3].slice(1));
        s += sub1 ? ` and ${cardinal(c)} ${c === 1 ? sub1 : subn}` : ` point ${m[3].slice(1)}`;
      }
      return [s, null];
    }
    m = core.match(/^(\d[\d,]*(?:\.\d+)?)\s?%$/);
    if (m) return [`${numberWords(m[1], "", "", false)} percent`, null];
    const nw = numberWords(core, prev, nxt);
    if (nw != null) return [nw, null];
    if (core.includes("-") && /\d/.test(core)) {
      const parts = core.split("-");
      return [parts.map((p, k) => (/\d/.test(p) ? numberWords(p, k === 0 ? prev : parts[k - 1], nxt) ?? p : p)).join(" "), null];
    }
    const rv = romanValue(core);
    const bare = core.toUpperCase().replace(/\.$/, "");
    if ((rv && bare !== "I") || (rv && ["chapter", "chap", "book", "part", "vol", "volume"].includes(prev.toLowerCase().replace(/\.$/, "")))) {
      const pl = prev.toLowerCase();
      if (REGNAL.has(pl.replace(/,$/, "")) && /^[A-Z]/.test(prev) && isUpper(core)) return ["the " + ordinal(rv), null];
      if (ROMAN_CTX.has(pl) || ROMAN_CTX.has(pl.replace(/\.$/, "")) || (i === 0 && blockType === "heading")) return [cardinal(rv), null];
    }
    if (core.toUpperCase() === "I." && i === 0 && blockType === "heading") return ["one", null];
    if (archaic) {
      const low = core.toLowerCase();
      if (ARCHAIC[low]) { const r = ARCHAIC[low]; return [/^[A-Z]/.test(core) ? cap(r) : r, null]; }
      const ph = this.lex.archaicVerb(low);
      if (ph) return [core, [core, ph]];
    }
    if (isUpper(core) && core.length > 1 && !allCapsBlock && !ACRONYM_OK.test(core)) return [cap(core), null];
    return [null, null];
  }
}

export function buildTokens(words, ids, known) {
  const toks = [];
  for (const wid of ids) {
    const w = words[wid];
    if (w.sup) continue;
    const t = w.t;
    const last = toks[toks.length - 1];
    if (last && w.glue && !words[last.w[last.w.length - 1]].sup) { last.text += t; last.w.push(wid); continue; }
    if (last && words[last.w[last.w.length - 1]].hy && /[-‐]$/.test(last.text)) {
      const left = last.text.slice(0, -1);
      const lcore = splitPunct(left)[1], rcore = splitPunct(t)[1];
      last.text = known(lcore + rcore) || !(known(lcore) && known(rcore)) ? left + t : left + "-" + t;
      last.w.push(wid);
      continue;
    }
    toks.push(new Token(t, [wid]));
  }
  return toks;
}

const SENT_END = /[.!?…]["'”’)\]]*$/;
export function splitSentences(toks) {
  const out = [];
  let start = 0;
  const n = toks.length;
  for (let i = 0; i < n - 1; i++) {
    const txt = toks[i].text;
    if (!SENT_END.test(txt)) continue;
    const [, core, trail] = splitPunct(txt);
    const nxtCore = splitPunct(toks[i + 1].text)[1];
    if (ABBR[core] && ABBR[core][1] && !(/^\d/.test(nxtCore) || romanValue(nxtCore))) { /* "No." as a word */ }
    else if (NEVER_END.has(core) || (ABBR[core] && !END_OK.has(core))) continue;
    if (/^[A-Z]\.$/.test(core) || (/^([A-Za-z]\.){2,}$/.test(core) && !trail)) continue;
    const nxt = toks[i + 1].text.replace(/^["'“‘([]+/, "");
    if (!nxt || !(/^[A-Z0-9]/.test(nxt[0]) || (isUpper(nxt[0])))) continue;
    out.push([start, i + 1]);
    start = i + 1;
  }
  if (start < n) out.push([start, n]);
  return out;
}
