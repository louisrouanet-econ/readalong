// Speech plan: what is read, tokens, sentences, phonemes and synthesis chunks with pauses.
// Port of ReadingApp_1/reader/speech.py, plus the chunking Kokoro needs (at most 510 phonemes per call).
import { Normalizer, buildTokens, splitSentences, splitPunct } from "./normalize.js";
import { phonemizeTokens, known } from "./g2p.js";
import { VOCAB } from "./vocab.js";

const TARGET = 330; // phonemes per chunk: about 2 sentences, which keeps intonation flowing
const HARD_MAX = 500;
const PAUSE = { sentence: 0.32, para: 0.7, before_heading: 1.0, after_heading: 0.75, other: 0.55 };

export function blockIsSpoken(block, settings, override) {
  if (override !== undefined && override !== null) return !!override;
  const t = block.type;
  if (t === "para" || t === "heading") return true;
  if (t === "footnote") return !!settings.readFootnotes;
  if (t === "reference") return !!settings.readReferences;
  if (t === "caption") return settings.readCaptions !== false;
  if (t === "header") return !!settings.readHeaders;
  return false;
}

/** Flatten an extracted document into words/blocks (the reader's view of it). */
export function layout(ex) {
  const words = [], blocks = [];
  ex.blocks.forEach((b, bi) => {
    const w0 = words.length;
    for (const w of b.words) {
      const o = { t: w.t, k: bi };
      if (w.p !== undefined) { o.p = w.p; o.b = w.b; }
      if (w.glue) o.g = 1;
      if (w.nl) o.nl = 1;
      if (w.sup) o.sup = 1;
      if (w.hy) o.hy = 1;
      words.push(o);
    }
    blocks.push({ type: b.type, w0, w1: words.length });
  });
  return { words, blocks };
}

/**
 * Build the speech plan. Returns {sentences, chunks, names, archaic}; marks blocks[i].spoken.
 * chunks: [{blk, pause, ids:number[], spans:[[wordIds[], idStart, idEnd]], sig}]
 */
export async function buildPlan(view, settings, lexicon, overrides = {}, onProgress = () => {}) {
  const { words, blocks } = view;
  const glueWords = words.map((w) => ({ t: w.t, glue: w.g, sup: w.sup, hy: w.hy }));
  const norm = new Normalizer(lexicon, { readCitations: !!settings.readCitations });
  const archaic = norm.detectArchaic(words.map((w) => w.t));
  const sentences = [], chunks = [];
  const guessed = new Set();
  const nameCount = new Map();
  let prevType = null;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    b.spoken = blockIsSpoken(b, settings, overrides[bi]);
    if (!b.spoken) continue;
    if (bi % 20 === 0) onProgress(bi / blocks.length);
    const ids = [];
    for (let i = b.w0; i < b.w1; i++) ids.push(i);
    const toks = buildTokens(glueWords, ids, (w) => known(w));
    norm.normalize(toks, b.type, archaic);
    const phs = await phonemizeTokens(toks.map((t) => t.say || ""), guessed);
    collectNames(toks, nameCount, lexicon);
    const sents = splitSentences(toks).filter(([a, z]) => toks.slice(a, z).some((t) => t.say));
    let first = true;
    let cur = []; // [{toks:[...], phs:[...]}] pieces of sentences
    let curLen = 0;
    const flush = () => {
      if (!cur.length) return;
      chunks.push(makeChunk(cur, bi, first ? pauseFor(b.type, prevType) : PAUSE.sentence));
      first = false;
      cur = []; curLen = 0;
    };
    for (const [a, z] of sents) {
      const sToks = toks.slice(a, z), sPhs = phs.slice(a, z);
      const wids = sToks.flatMap((t) => t.w);
      if (wids.length) sentences.push({ w0: Math.min(...wids), w1: Math.max(...wids) + 1 });
      for (const piece of splitLong(sToks, sPhs)) {
        const len = piece.phs.reduce((x, p) => x + p.length + 1, 0);
        if (cur.length && curLen + len > TARGET) flush();
        cur.push(piece);
        curLen += len;
      }
    }
    flush();
    prevType = b.type;
  }
  const names = [...nameCount.values()].map((e) => ({ ...e, source: e.source === "dictionary" && guessed.has(e.word) ? "guess" : e.source }))
    .map((e) => (guessed.has(e.word) && !e.lexsrc ? { ...e, source: "guess" } : e));
  const order = { guess: 0, dictionary: 1, builtin: 2, user: 3 };
  names.sort((a, b) => order[a.source] - order[b.source] || b.count - a.count || a.word.localeCompare(b.word));
  return { sentences, chunks, names, archaic };
}

function pauseFor(type, prevType) {
  if (type === "heading") return PAUSE.before_heading;
  if (prevType === "heading") return PAUSE.after_heading;
  return type === "para" ? PAUSE.para : PAUSE.other;
}

/** Split one sentence into pieces of at most HARD_MAX phonemes, preferring punctuation boundaries. */
function splitLong(toks, phs) {
  const total = phs.reduce((x, p) => x + p.length + 1, 0);
  if (total <= HARD_MAX) return [{ toks, phs }];
  const out = [];
  let start = 0, len = 0, lastBreak = -1;
  for (let i = 0; i < toks.length; i++) {
    len += phs[i].length + 1;
    if (/[,;:—)]$/.test(toks[i].say || "")) lastBreak = i;
    if (len > HARD_MAX * 0.8) {
      const cut = lastBreak > start ? lastBreak : i;
      out.push({ toks: toks.slice(start, cut + 1), phs: phs.slice(start, cut + 1) });
      start = cut + 1;
      len = phs.slice(start, i + 1).reduce((x, p) => x + p.length + 1, 0);
      lastBreak = -1;
    }
  }
  if (start < toks.length) out.push({ toks: toks.slice(start), phs: phs.slice(start) });
  return out;
}

function makeChunk(pieces, blk, pause) {
  const ids = [], spans = [];
  let text = "";
  for (const { toks, phs } of pieces) {
    toks.forEach((t, k) => {
      const p = phs[k];
      if (!p) return;
      if (ids.length) { ids.push(VOCAB[" "]); text += " "; }
      const a = ids.length;
      for (const c of p) { const id = VOCAB[c]; if (id !== undefined) ids.push(id); }
      text += p;
      if (t.w.length) spans.push([t.w, a, ids.length]);
    });
  }
  if (ids.length > 510) ids.length = 510; // never exceed the model's context
  return { blk, pause, ids, spans, sig: text };
}

function collectNames(toks, map, lexicon) {
  for (const t of toks) {
    if (!t.say) continue;
    let core = splitPunct(t.text)[1].replace(/’/g, "'").replace(/'s$/, "");
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+$/.test(core) || (core === core.toUpperCase() && core.length <= 4)) continue;
    const rewritten = t.plain && t.plain.replace(/[^\p{L}]/gu, "").toLowerCase() !== t.text.replace(/’/g, "'").replace(/[^\p{L}]/gu, "").toLowerCase();
    if ((rewritten || t.say.includes("[")) && !t.lex) continue;
    const hit = lexicon.lookup(core);
    const isCap = /^[A-Z]/.test(core);
    let src;
    if (hit) src = hit[0];
    else if (known(core) && !(isCap && !known(core.toLowerCase()))) continue;
    else if (known(core)) src = "dictionary";
    else src = "guess";
    if (!isCap && src === "guess" && core.length < 4) continue;
    const key = isCap && src !== "guess" ? core : core.toLowerCase();
    const e = map.get(key) || { word: core, count: 0, first: t.w[0], source: src, lexsrc: !!hit };
    if (/^[A-Z]/.test(core) && !/^[A-Z]/.test(e.word)) e.word = core;
    e.count++;
    map.set(key, e);
  }
}
