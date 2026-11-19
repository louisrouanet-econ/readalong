// PDF -> words with page coordinates, layout cleanup and reading order.
// Port of ReadingApp_1/reader/ingest/pdf.py, with PDF.js text runs grouped into lines and blocks first
// (PyMuPDF gives blocks directly; PDF.js gives positioned text runs).

const CHAR_FIX = { "­": "", "«": "“", "»": "”", "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff",
  "ﬃ": "ffi", "ﬄ": "ffl" };
const FOOTMARK = /^[\d*†‡§¶]+$/;
const JSTOR_LINE = /(this content downloaded from|all use subject to|jstor\.org\/(page|stable)|^\[back to table of contents\]$|^pll v\d|oll\.libertyfund\.org)/i;
const REF_HEAD = /^(references|bibliography|works cited|literature cited|notes|endnotes)\.?$/i;
const PAGENUM = /^[\s\-–—]*([\divxlcdm]{1,6})[\s\-–—.]*$/i;
const NUM_HEAD = /^\(?(\d{1,2}(\.\d{1,2})*[.)]|[IVXLC]{1,6}[.)]?)\s+\S/;
const TERMINAL = /[.!?]["'”’)\]]*$/;
const BULLET = /^[•▪◦●■□‣∙⁃➢►✓✔]/;

// Private-use characters are glyphs of symbol and math fonts with no known meaning (The Missing Billionaires: a MathType
// mark drawn over each "k", U+F024). They cannot be said, and as words of their own, set a little above the line, they
// broke the line apart, and the pieces were then read out of order.
const fixChars = (s) => s.replace(/[­«»ﬀ-ﬄ-]/g, (c) => CHAR_FIX[c] ?? (c >= "" && c <= "" ? "" : c));

import { splitWord, needsSpacingRepair } from "./repair.js";

// ------------------------------------------------------------------ structures (same shape as the Python version)
function mkLine(words) {
  const sizes = new Map();
  for (const w of words) if (!w.sup) { const k = Math.round(w.sz * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + w.t.length); }
  let size = words[0].sz, best = -1;
  for (const [k, v] of sizes) if (v > best) { best = v; size = k; }
  return { words, size, bbox: [Math.min(...words.map((w) => w.b[0])), Math.min(...words.map((w) => w.b[1])),
    Math.max(...words.map((w) => w.b[2])), Math.max(...words.map((w) => w.b[3]))] };
}
function mkBlock(lines) {
  return { lines, bbox: [Math.min(...lines.map((l) => l.bbox[0])), Math.min(...lines.map((l) => l.bbox[1])),
    Math.max(...lines.map((l) => l.bbox[2])), Math.max(...lines.map((l) => l.bbox[3]))] };
}
const blockText = (b) => b.lines.map((l) => l.words.map((w) => w.t).join(" ")).join(" ");
const lineText = (l) => l.words.map((w) => w.t).join(" ");
const lineBold = (l) => l.words.every((w) => w.bold);

// ------------------------------------------------------------------ PDF.js text runs -> words -> lines -> blocks
let measureCtx = null;
function charWidths(str, fontFamily) {
  // proportional widths so word boxes line up with the printed words
  try {
    if (!measureCtx && typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(8, 8).getContext("2d");
  } catch { measureCtx = null; }
  if (!measureCtx) return [...str].map((c) => (c === " " ? 0.3 : /[il.,;:'!|]/.test(c) ? 0.3 : /[mwMW]/.test(c) ? 0.85 : 0.55));
  measureCtx.font = `100px ${/sans/i.test(fontFamily || "") ? "sans-serif" : "serif"}`;
  return [...str].map((c) => measureCtx.measureText(c).width || 30);
}

async function pageGeometry(page, pdfjs) {
  // fonts (for bold) and whether the page is a scan (a full-page image under the text)
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let scan = false;
  const vp = page.getViewport({ scale: 1 });
  const area = vp.width * vp.height;
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
      if (Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) > 0.6 * area) scan = true;
    }
  }
  return { scan, hasImages: ops.fnArray.some((f) => f === OPS.paintImageXObject || f === OPS.paintJpegXObject) };
}

function fontInfo(page, fontName, styles) {
  let name = "";
  try { const f = page.commonObjs.get(fontName); name = (f && (f.name || f.loadedName)) || ""; } catch { /* not loaded */ }
  const fam = (styles[fontName] && styles[fontName].fontFamily) || "";
  // font names (e.g. "ABCDEF+BemboStd-Italic") need fontExtraProperties: true on getDocument
  return { bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique|-it$|boldit$/i.test(name.replace(/^[A-Z]{6}\+/, "")),
    family: fam, name };
}

async function pageBlocks(page, pdfjs, repairSpacing = false) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const frags = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) { if (frags.length && it.str) frags[frags.length - 1].spaceAfter = true; continue; }
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (!(fh > 0.5) || Math.abs(Math.atan2(tx[1], tx[0])) > 0.1) continue; // rotated text: stamps, sidebars
    const fi = fontInfo(page, it.fontName, tc.styles);
    const str = fixChars(it.str);
    const totalW = it.width * Math.hypot(vp.transform[0], vp.transform[1]) || fh * 0.5 * str.length;
    const cw = charWidths(str, fi.family);
    const sum = cw.reduce((a, b) => a + b, 0) || 1;
    let x = tx[4];
    const base = tx[5];
    let cur = null;
    const startsSpace = /^\s/.test(it.str);
    [...str].forEach((c, k) => {
      const w = (cw[k] / sum) * totalW;
      if (/\s/.test(c)) { cur = null; x += w; return; }
      if (!cur) {
        cur = { t: "", b: [x, base - fh * 0.8, x, base + fh * 0.22], sz: Math.round(fh * 2) / 2, base, bold: fi.bold,
          it: fi.italic, spaceBefore: k > 0 || startsSpace, sup: false };
        frags.push(cur);
      }
      cur.t += c;
      cur.b[2] = x + w;
      x += w;
    });
    if (/\s$/.test(it.str) && frags.length) frags[frags.length - 1].spaceAfter = true;
    if (it.hasEOL && frags.length) frags[frags.length - 1].eol = true;
  }
  // lines: consecutive fragments on the same baseline, moving rightwards
  const lines = [];
  let line = null;
  for (const f of frags) {
    const prev = line && line.frags[line.frags.length - 1];
    const ref = line ? line.maxSz : f.sz;
    const sameBase = line && Math.abs(f.base - line.base) < 0.45 * Math.max(ref, f.sz);
    const raised = line && f.sz < 0.8 * ref && line.base - f.base > 0.15 * ref && line.base - f.base < 0.9 * ref;
    if (line && (sameBase || raised) && f.b[0] >= prev.b[2] - 0.35 * ref && f.b[0] - prev.b[2] < 2.2 * ref && !prev.eol) {
      line.frags.push(f);
      if (!raised) line.maxSz = Math.max(line.maxSz, f.sz);
    } else {
      line = { frags: [f], base: f.base, maxSz: f.sz };
      lines.push(line);
    }
  }
  // words: merge fragments split mid-word (kerning), flag superscript footnote marks
  const wordLines = [];
  for (const ln of lines) {
    const words = [];
    for (const f of ln.frags) {
      const raisedSmall = f.sz < 0.8 * ln.maxSz && ln.base - f.base > 0.15 * ln.maxSz;
      // a small number opening a line beside full-size text: an exponent left over from a displayed equation
      const leadSmall = !words.length && ln.frags.length > 1 && f.sz < 0.75 * ln.maxSz;
      const sup = (raisedSmall || leadSmall) && FOOTMARK.test(f.t);
      const prev = words[words.length - 1];
      const gap = prev ? f.b[0] - prev.b[2] : 99;
      if (prev && !sup && !prev.sup && !f.spaceBefore && !prev.spaceAfter && gap < 0.15 * ln.maxSz) {
        prev.t += f.t; prev.b[2] = f.b[2]; prev.b[1] = Math.min(prev.b[1], f.b[1]); prev.b[3] = Math.max(prev.b[3], f.b[3]);
        prev.spaceAfter = f.spaceAfter;
        continue;
      }
      const w = { t: f.t, b: f.b.slice(), sz: f.sz, bold: f.bold, it: f.it, sup, spaceAfter: f.spaceAfter };
      if (sup && prev && gap < 0.3 * ln.maxSz) w.glue = 1;
      words.push(w);
    }
    if (words.length) wordLines.push(words);
  }
  // scans whose text layer lost its spaces ("theftby"): split run-on words with the dictionary
  const repair = repairSpacing && needsSpacingRepair(wordLines.flat().map((w) => w.t));
  const outLines = [];
  let prevHyphen = false;
  for (const words of wordLines) {
    const fixed = repair ? words.flatMap((w, k) => (k === 0 && prevHyphen) || /-$/.test(w.t) ? [w] : splitWord(w)) : words;
    prevHyphen = /-$/.test(words[words.length - 1].t);
    outLines.push(mkLine(fixed));
  }
  return clusterLines(outLines);
}

/** Group lines (in reading order) into blocks: lines that stack closely in one column at a similar size. */
export function clusterLines(outLines) {
  const blocks = [];
  let cur = null;
  for (const ln of outLines) {
    const last = cur && cur[cur.length - 1];
    if (last) {
      const h = Math.max(last.size, ln.size);
      const gap = ln.bbox[1] - last.bbox[3];
      const ov = Math.min(last.bbox[2], ln.bbox[2]) - Math.max(last.bbox[0], ln.bbox[0]);
      const minW = Math.min(last.bbox[2] - last.bbox[0], ln.bbox[2] - ln.bbox[0]);
      if (gap > -0.5 * h && gap < 0.75 * h && ov > 0.25 * minW && Math.abs(last.size - ln.size) < 0.3 * h) { cur.push(ln); continue; }
    }
    cur = [ln];
    blocks.push(cur);
  }
  return blocks.map(mkBlock);
}

// ------------------------------------------------------------------ the rest mirrors pdf.py
function bodySize(pagesBlocks) {
  const c = new Map();
  for (const bl of pagesBlocks) for (const b of bl) for (const l of b.lines) c.set(l.size, (c.get(l.size) || 0) + l.words.reduce((a, w) => a + w.t.length, 0));
  let best = 10, n = -1;
  for (const [k, v] of c) if (v > n) { n = v; best = k; }
  return best;
}
function isCover(blocks) {
  const t = blocks.map(blockText).join(" ").toLowerCase();
  return (t.includes("jstor") && (t.includes("stable url") || t.includes("your use of the jstor archive"))) ||
    (t.includes("this content downloaded from") && t.length < 2500 && t.includes("terms and conditions"));
}

function splitBlocks(blocks, H, boldSignal, scanned) {
  const out = [];
  for (const b of blocks) {
    let cur = [];
    for (const ln of b.lines) {
      const txt = lineText(ln);
      const inBand = ln.bbox[1] < 0.15 * H || ln.bbox[3] > 0.78 * H;
      if (inBand && (PAGENUM.test(txt) || JSTOR_LINE.test(txt)) && b.lines.length > 1) {
        if (cur.length) { out.push(mkBlock(cur)); cur = []; }
        out.push(mkBlock([ln]));
        continue;
      }
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const big = Math.max(prev.size, ln.size);
        const sizeJump = Math.abs(prev.size - ln.size) > (scanned ? 0.25 : 0.12) * big;
        const pb = lineBold(prev), lb = lineBold(ln);
        const boldJump = boldSignal && pb !== lb && Math.min(prev.words.length, ln.words.length) <= 8 &&
          ((pb && prev.words.length <= 8) || (lb && ln.words.length <= 8));
        if (sizeJump || boldJump) { out.push(mkBlock(cur)); cur = []; }
      }
      cur.push(ln);
    }
    if (cur.length) out.push(mkBlock(cur));
  }
  return out;
}

function besideBody(b, blocks) {
  const [x0, y0, x1, y1] = b.bbox;
  return blocks.some((o) => o !== b && o.lines.length >= 2 &&
    Math.min(y1, o.bbox[3]) - Math.max(y0, o.bbox[1]) > 0.5 * (y1 - y0) && (o.bbox[2] - o.bbox[0]) > 2 * (x1 - x0));
}

// ------------------------------------------------------------------ charts and tables
// "Table 3.1 Calculating Expected Payout", "Figure 2: Growth of ...", "Exhibit 2.1 Summary of ..."
const CAPTION_HEAD = /^(Table|Tab\.|Figure|Fig\.|Exhibit|Chart|Graph|Panel|Box|Map|Plate|Illustration)\s+([A-Z]?\d+[A-Za-z]?([.\-–]\d+)*|[IVXLC]+)\b[.:]?/;
const TITLE_SMALL = new Set(["a", "an", "the", "of", "and", "or", "on", "in", "to", "for", "with", "at", "by", "from", "vs", "vs.", "per", "as", "into", "over", "under", "between"]);
function isCaptionTitle(b) {
  const txt = blockText(b).trim();
  const m = txt.match(CAPTION_HEAD);
  if (!m || b.lines.length > 3) return false;
  const rest = txt.slice(m[0].length).match(/[\p{L}][\p{L}'’-]*/gu) || [];
  if (!rest.length) return true;
  // a title is in Title Case; "Table 3.1 shows that the..." is a sentence of the text
  const big = rest.filter((w) => !TITLE_SMALL.has(w.toLowerCase()));
  return big.length > 0 && big.filter((w) => /^\p{Lu}/u.test(w)).length >= 0.75 * big.length;
}
const letterCount = (s) => (s.match(/\p{L}/gu) || []).length;
/** Blocks that are the inside of a chart or table: cells that are only numbers, and short labels next to them.
 *  They are kept on the page but not read (they make no sense read in a row). */
function figureBlocks(blocks, body, W, H) {
  const out = new Set();
  for (const b of blocks) {
    const txt = blockText(b).trim();
    const inBand = b.bbox[1] < 0.15 * H || b.bbox[3] > 0.78 * H;
    // a lone 1–2 character mark is a footnote marker, not a cell ("1998 2000 2002" on an axis is a cell)
    const marker = !/\s/.test(txt) && txt.length <= 2 && FOOTMARK.test(txt);
    if (/\d/.test(txt) && letterCount(txt) < 3 && !(inBand && PAGENUM.test(txt)) && !marker) out.add(b);
  }
  if (out.size < 3) return new Set(); // a lone number is not a table
  const isLabel = (b) => {
    const txt = blockText(b).trim();
    const nwords = b.lines.reduce((a, l) => a + l.words.length, 0);
    const size = Math.max(...b.lines.map((l) => l.size));
    return nwords <= 12 && b.lines.length <= 3 && size < 1.12 * body && !TERMINAL.test(txt) && !/^[—―]/.test(txt) && !CAPTION_HEAD.test(txt);
  };
  const near = (a, c) => {
    const dx = Math.max(0, Math.max(a.bbox[0], c.bbox[0]) - Math.min(a.bbox[2], c.bbox[2]));
    const dy = Math.max(0, Math.max(a.bbox[1], c.bbox[1]) - Math.min(a.bbox[3], c.bbox[3]));
    return dy < 3 * body && dx < 0.5 * W;
  };
  // grow the region from the numeric cells: a label counts when two parts of the chart/table are close by
  for (let pass = 0; pass < 6; pass++) {
    let added = 0;
    for (const b of blocks) {
      if (out.has(b) || !isLabel(b)) continue;
      let n = 0;
      for (const c of out) if (near(b, c) && ++n >= 2) break;
      if (n >= 2) { out.add(b); added++; }
    }
    if (!added) break;
  }
  return out;
}

// Displayed equations: blocks made only of single italic letters, Greek letters, short numbers and signs ("k", "2",
// "x = y + 1"). Math fonts often carry no text for their symbols (μ, σ and γ come out empty), so what is left cannot
// be read meaningfully: like the inside of a table, it stays on the page but is not read.
const MATH_TOKEN = /^[\p{L}\p{N}ˆ˜¯$%=+\-−–×÷·⋅/()[\]{}<>≤≥≈≠±∑∏∫√∞∂∆∇,.;:′'*^_|!]+$/u;
const MATH_SIGN = /[=+−×÷·⋅/<>≤≥≈≠±∑∏∫√∞∂∆∇^_|]|[Ͱ-Ͽ]/u;
const LONE_NUMBER = /^\d{1,3}$/;
const MATH_FN = /^(ln|log|exp|max|min|lim|sin|cos|tan|var|cov|Var|Cov|det|arg|sup|inf)[(),.]*$/;
function equationBlocks(blocks, body, H) {
  const wordsOf = (b) => b.lines.flatMap((l) => l.words);
  const mathish = (b) => {
    const ws = wordsOf(b), txt = blockText(b).trim();
    if (!ws.length || ws.length > 12 || b.lines.length > 4 || letterCount(txt) > 6) return false;
    if (!ws.every((w) => MATH_FN.test(w.t) || (w.t.length <= 4 && MATH_TOKEN.test(w.t) && !/\p{L}{2}/u.test(w.t)))) return false;
    if ((b.bbox[1] < 0.15 * H || b.bbox[3] > 0.78 * H) && PAGENUM.test(txt)) return false;
    return true;
  };
  // a variable (italic or Greek letter) or a sign; a lone number alone could be a page number or a note mark
  const variable = (b) => wordsOf(b).some((w) => (w.it && /\p{L}/u.test(w.t)) || MATH_SIGN.test(w.t) || MATH_FN.test(w.t) || /^[$%]$/.test(w.t));
  const cand = blocks.filter(mathish);
  const near = (a, c) => Math.max(0, Math.max(a.bbox[1], c.bbox[1]) - Math.min(a.bbox[3], c.bbox[3])) < 2.5 * body &&
    Math.max(0, Math.max(a.bbox[0], c.bbox[0]) - Math.min(a.bbox[2], c.bbox[2])) < 8 * body;
  // one stray letter is not an equation: a part counts when it holds a relation of its own ("x = 2"), or when
  // another part of the same equation is close by and one of the two has a variable or a sign
  return new Set(cand.filter((b) => {
    const ws = wordsOf(b);
    if (ws.length >= 3 && ws.some((w) => /^[=<>≤≥≈≠]$/.test(w.t)) && variable(b)) return true;
    return cand.some((c) => c !== b && near(b, c) && (variable(b) || variable(c)));
  }));
}

function classify(pagesBlocks, dims, body, boldSignal, scanned) {
  const nPages = pagesBlocks.length;
  const band = [];
  pagesBlocks.forEach((blocks, p) => {
    const H = dims[p][1];
    for (const b of blocks) if (b.bbox[1] < 0.13 * H || b.bbox[3] > 0.87 * H) {
      const toks = new Set(blockText(b).toLowerCase().match(/[a-z]{2,}/g) || []);
      if (toks.size) band.push([p, toks]);
    }
  });
  const repeats = (p, txt) => {
    const toks = new Set(txt.toLowerCase().match(/[a-z]{2,}/g) || []);
    if (!toks.size) return false;
    return band.some(([q, t2]) => {
      if (q === p) return false;
      let inter = 0;
      for (const t of toks) if (t2.has(t)) inter++;
      return inter / (toks.size + t2.size - inter) >= 0.5;
    });
  };
  const small = scanned ? 0.82 : 0.9;
  pagesBlocks.forEach((blocks, p) => {
    const [W, H] = dims[p];
    const cover = p === 0 && isCover(blocks);
    const fig = figureBlocks(blocks, body, W, H);
    const eqs = equationBlocks(blocks, body, H);
    for (const b of blocks) {
      const txt = blockText(b).trim();
      const words = b.lines.flatMap((l) => l.words);
      const nwords = words.length;
      const counts = new Map();
      for (const l of b.lines) counts.set(l.size, (counts.get(l.size) || 0) + l.words.length);
      let size = b.lines[0].size, bc = -1;
      for (const [k, v] of counts) if (v > bc) { bc = v; size = k; }
      const bmax = Math.max(...words.map((w) => w.sz));
      const [x0, y0, x1, y1] = b.bbox;
      const inBand = y0 < 0.13 * H || y1 > 0.87 * H;
      const letters = [...txt].filter((c) => /\p{L}/u.test(c));
      const upperRatio = letters.length ? letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / letters.length : 0;
      let t;
      if (cover) t = "cover";
      else if (JSTOR_LINE.test(txt)) t = "header";
      else if (nwords === 1 && txt.length <= 2 && /^\p{L}+$/u.test(txt) && bmax >= 1.8 * body) t = "dropcap";
      else if (FOOTMARK.test(txt.replace(/ /g, "")) && size < 0.9 * body && nwords <= 2) t = "marker";
      else if (size >= 1.3 * body && nwords <= 25 && !/^[\d\W]+$/.test(txt)) t = "heading";
      else if ((inBand || y0 < 0.15 * H || y1 > 0.78 * H) && PAGENUM.test(txt)) t = "header";
      else if (inBand && (/^[\divxlcdm.\-– ]+$/i.test(txt) || (nwords <= 20 && nPages > 1 && (repeats(p, txt) || size < 0.95 * body)))) t = "header";
      else if (isCaptionTitle(b)) t = "caption";
      else if (fig.has(b)) t = "figure";
      else if (eqs.has(b)) t = "equation";
      else if (b.lines.length === 1 && nwords <= 12 && NUM_HEAD.test(txt) && !/[-,]$/.test(txt) && size >= 0.8 * body) t = "heading";
      else if (boldSignal && nwords <= 12 && b.lines.length <= 2 && words.every((w) => w.bold) && !TERMINAL.test(txt) && /\p{L}{2}/u.test(txt)) t = "heading";
      else if ((x1 - x0) < 0.26 * W && size < 0.95 * body && (x0 > 0.55 * W || x1 < 0.45 * W) && besideBody(b, blocks)) t = "margin";
      else if (size < small * body && y0 > 0.5 * H && !(scanned && nwords <= 3)) t = "footnote";
      else if (nwords <= 20 && b.lines.length <= 4 && (size >= 1.15 * body || (upperRatio > 0.8 && letters.length >= 3))) t = "heading";
      else if (size < small * body && nwords <= 30 && !scanned) t = "caption";
      else t = "para";
      b.type = t;
      b.size = size;
    }
  });
}

function orderPage(blocks, W) {
  let flow = blocks.filter((b) => b.type !== "header" && b.type !== "margin");
  const rest = blocks.filter((b) => b.type === "header" || b.type === "margin");
  flow.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const minX = flow.length ? Math.min(...flow.map((b) => b.bbox[0])) : 0;
  const maxX = flow.length ? Math.max(...flow.map((b) => b.bbox[2])) : W;
  const mid = (minX + maxX) / 2, tol = 0.03 * W;
  const side = (b) => (b.bbox[2] <= mid + tol ? "L" : b.bbox[0] >= mid - tol ? "R" : "F");
  const big = flow.filter((b) => (b.type === "para" || b.type === "footnote") && b.lines.length >= 3);
  const twoCol = big.some((b) => side(b) === "L") && big.some((b) => side(b) === "R");
  if (twoCol) {
    const out = [];
    let left = [], right = [];
    for (const b of flow) {
      const s = side(b);
      if (s === "F" || b.type === "dropcap") {
        if (s === "F") { out.push(...left, ...right); left = []; right = []; out.push(b); }
        else left.push(b);
      } else if (s === "L") left.push(b);
      else right.push(b);
    }
    out.push(...left, ...right);
    flow = out;
  }
  flow = [...flow.filter((b) => b.type !== "footnote"), ...flow.filter((b) => b.type === "footnote")];
  rest.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return [...flow, ...rest];
}

function markHyphens(b, words) {
  let idx = 0;
  b.lines.forEach((ln, li) => {
    const n = ln.words.length;
    if (n && li + 1 < b.lines.length) {
      const w = words[idx + n - 1];
      if (w.t.length > 1 && /[-‐­]$/.test(w.t) && /\p{L}/u.test(w.t[w.t.length - 2])) w.hy = 1;
    }
    idx += n;
  });
}

function paragraphs(orderedPages) {
  const out = [];
  let cur = null, pendingDropcap = null, refMode = false, refSize = null;
  const deferred = [];
  const close = () => {
    if (cur && cur.words.length) out.push(cur);
    cur = null;
    out.push(...deferred);
    deferred.length = 0;
  };
  orderedPages.forEach((blocks, p) => {
    const paraBlocks = blocks.filter((b) => b.type === "para");
    const pageRight = paraBlocks.length ? Math.max(...paraBlocks.map((b) => b.bbox[2])) : Infinity;
    for (const b of blocks) {
      let t = b.type;
      const words = [];
      b.lines.forEach((ln) => ln.words.forEach((w, wi) => {
        const ww = { t: w.t, p, b: w.b.map((v) => Math.round(v * 10) / 10) };
        if (w.sup) ww.sup = 1;
        if (w.glue) ww.glue = 1;
        if (w.it) ww.it = 1;
        if (wi === 0) ww.nl = 1;
        words.push(ww);
      }));
      markHyphens(b, words);
      const text = blockText(b).trim();
      if (t === "heading" && REF_HEAD.test(text)) { refMode = true; refSize = b.size; }
      else if (t === "heading" && refMode && b.size >= (refSize || 0)) refMode = false;
      if (refMode && (t === "para" || t === "caption" || t === "footnote")) t = "reference";
      if (t === "dropcap") { close(); pendingDropcap = words; continue; }
      if (t === "para") {
        const lines = b.lines;
        const left = Math.min(...lines.map((l) => l.bbox[0]));
        const right = Math.max(...lines.map((l) => l.bbox[2]));
        const em = b.size;
        let startsNew = true;
        if (cur && cur.words.length) {
          const last = cur.words[cur.words.length - 1].t;
          const first = lines[0].words[0].t;
          startsNew = TERMINAL.test(last) && !/^\p{Ll}/u.test(first);
        }
        if (pendingDropcap) startsNew = true;
        if (startsNew) { close(); cur = { type: "para", words: [] }; }
        if (pendingDropcap) { cur.words.push(...pendingDropcap); words[0].glue = 1; pendingDropcap = null; }
        let wi = 0, prevLine = null;
        for (const ln of lines) {
          const n = ln.words.length;
          const lw = words.slice(wi, wi + n);
          wi += n;
          const first = ln.words[0].t;
          const curEnded = !cur || !cur.words.length || TERMINAL.test(cur.words[cur.words.length - 1].t);
          // "— Nassim Nicholas Taleb": the author of an epigraph stands alone, never joined to the next paragraph
          if (/^[—―]/.test(first) && n <= 8 && curEnded && lw.filter((w) => /\p{L}/u.test(w.t)).every((w) => /^[—―]?\p{Lu}/u.test(w.t) || /^(de|von|van|der|of|the|and|la|le|du)$/.test(w.t))) {
            close(); out.push({ type: "para", words: lw }); cur = { type: "para", words: [] };
            prevLine = null;
            continue;
          }
          // bulleted lists: each item is its own passage (read with a short pause), and the list ends at
          // the first line that goes back to the margin
          if (BULLET.test(first)) {
            close();
            cur = { type: "para", words: [], item: (ln.words[1] || ln.words[0]).b[0] };
          } else if (cur && cur.item != null && (ln.bbox[0] < cur.item - 0.4 * em || cur.short) && !/^\p{Ll}/u.test(first)) {
            close(); cur = { type: "para", words: [] };
          } else if (prevLine) {
            const indented = ln.bbox[0] > left + 1.2 * em;
            const prevShort = prevLine.bbox[2] < right - 2.5 * em;
            const prevTerm = TERMINAL.test(prevLine.words[prevLine.words.length - 1].t);
            if (prevTerm && (indented || (prevShort && lines.length > 2))) { close(); cur = { type: "para", words: [] }; }
          }
          cur.words.push(...lw);
          cur.short = ln.bbox[2] < pageRight - 2.5 * em; // the line stops well before the margin
          prevLine = ln;
        }
      } else {
        if (pendingDropcap) { out.push({ type: "para", words: pendingDropcap }); pendingDropcap = null; }
        if (t === "heading") { close(); out.push({ type: t, words }); }
        else if (cur) deferred.push({ type: t, words });
        else out.push({ type: t, words });
      }
    }
  });
  close();
  return out;
}

/** Extract a PDF. data: ArrayBuffer/Uint8Array. opts: {pdfjs, forceOcr, onProgress, ocrPage(page, pdfjs) -> blocks} */
export async function extractPdf(data, opts) {
  const { pdfjs, forceOcr = false, onProgress = () => {}, ocrPage = null, skipOcr = false } = opts;
  // fontExtraProperties: font names are needed to tell bold and italic apart
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, fontExtraProperties: true });
  const doc = await task.promise;
  const pagesBlocks = [], dims = [], scanned = [];
  let ocrPages = 0;
  const needOcr = []; // pages (0-based) that would need OCR but were skipped (skipOcr)
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress(`Reading page ${p} of ${doc.numPages}`, (p - 1) / doc.numPages);
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    dims.push([vp.width, vp.height]);
    const geo = await pageGeometry(page, pdfjs);
    scanned.push(geo.scan);
    let blocks = forceOcr ? [] : await pageBlocks(page, pdfjs, geo.scan);
    const nchar = blocks.reduce((a, b) => a + b.lines.reduce((x, l) => x + l.words.reduce((y, w) => y + w.t.length, 0), 0), 0);
    if ((forceOcr || (nchar < 25 && geo.hasImages)) && ocrPage) {
      if (skipOcr && !forceOcr) needOcr.push(p - 1);
      else {
        onProgress(`Recognising text on page ${p} of ${doc.numPages} (OCR)`, (p - 1) / doc.numPages);
        blocks = await ocrPage(page, pdfjs);
        ocrPages++;
      }
    }
    pagesBlocks.push(blocks);
    page.cleanup();
  }
  const body = bodySize(pagesBlocks);
  let nb = 0, na = 0;
  for (const bl of pagesBlocks) for (const b of bl) for (const l of b.lines) for (const w of l.words) { na += w.t.length; if (w.bold) nb += w.t.length; }
  const boldSignal = nb / (na || 1) < 0.4;
  const split = pagesBlocks.map((bl, p) => splitBlocks(bl, dims[p][1], boldSignal, scanned[p]));
  classify(split, dims, body, boldSignal, scanned.filter(Boolean).length > scanned.length / 2);
  const ordered = split.map((blocks, p) => orderPage(blocks, dims[p][0]));
  const paras = paragraphs(ordered);
  for (const blk of paras) {
    if (blk.type !== "para") continue;
    for (let j = 0; j < blk.words.length - 1; j++) {
      const w = blk.words[j], nxt = blk.words[j + 1];
      if (w.t.endsWith("-") && w.t.length > 1 && /\p{L}/u.test(w.t[w.t.length - 2]) && nxt.nl && /^\p{Ll}/u.test(nxt.t)) w.hy = 1;
    }
  }
  let title = "";
  try { const md = await doc.getMetadata(); title = (md.info && md.info.Title) || ""; } catch { /* none */ }
  await task.destroy();
  return { kind: "pdf", title: String(title).trim(), pages: dims.map(([w, h]) => ({ w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 })), blocks: paras, bodySize: body, ocrPages, needOcr };
}

export { mkLine, mkBlock };
