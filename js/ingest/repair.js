// Repair run-together words in scanned text ("competitivetheft" -> "competitive theft") using the dictionary.
// Port of ReadingApp_1/reader/ingest/ocr.py (_segment, _fix_spacing).
import { known, common } from "../g2p.js";

export function segment(word) {
  const n = word.length;
  const best = new Array(n + 1).fill(null); // [score[3], pieces]
  best[0] = [[0, 0, 0], []];
  const less = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 24); j < i; j++) {
      if (!best[j]) continue;
      const piece = word.slice(j, i);
      if ((piece.length >= 2 || piece.toLowerCase() === "a" || piece.toLowerCase() === "i") && known(piece)) {
        const [[c, u, sq], pieces] = best[j];
        const score = [c + 1, u + (common(piece) ? 0 : 1), sq - piece.length ** 2];
        if (!best[i] || less(score, best[i][0]) < 0) best[i] = [score, [...pieces, piece]];
      }
    }
  }
  return best[n] ? best[n][1] : null;
}

/** Return the token split into one or more words (strings), keeping punctuation attached. */
export function fixSpacing(tok) {
  let text = tok
    .replace(/(?<=[a-z])([.,;:!?])(?=[A-Za-z“‘(])/g, "$1 ")
    .replace(/(?<=[a-z])([”’'"])(?=(?!(?:s|t|d|ll|re|ve|m)\b)[a-z])/g, "$1 ")
    .replace(/(?<=[a-z])([“‘])(?=[a-zA-Z])/g, " $1");
  const out = [];
  for (const t of text.split(/\s+/).filter(Boolean)) {
    const parts = t.split(/([—–-])/);
    const fixed = parts.map((part) => {
      const m = part.match(/^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/);
      if (!m) return part;
      const core = m[2];
      if (known(core)) return part;
      const low = core === core.toLowerCase() && core.length >= 6;
      const title = /^[A-Z][a-z]+$/.test(core) && core.length >= 12;
      const caps = core === core.toUpperCase() && core.length >= 10;
      if (!(low || title || caps)) return part;
      let seg = segment(core.toLowerCase());
      if (!seg || seg.length <= (low ? 1 : 2)) return part;
      if (caps) seg = seg.map((x) => x.toUpperCase());
      else if (title) seg[0] = seg[0][0].toUpperCase() + seg[0].slice(1);
      return m[1] + seg.join(" ") + m[3];
    });
    out.push(...fixed.join("").split(" ").filter(Boolean));
  }
  return out.length ? out : [tok];
}

/** True when many long lowercase tokens are not words: the text layer lost its spaces. */
export function needsSpacingRepair(tokens) {
  let long = 0, bad = 0;
  for (const t of tokens) {
    const core = t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (core.length < 6 || core !== core.toLowerCase() || /-$/.test(t)) continue;
    long++;
    if (!known(core)) bad++;
  }
  return long > 20 && bad / long > 0.06;
}

/** Split a positioned word into several words, dividing its box by character count. */
export function splitWord(w) {
  const parts = fixSpacing(w.t);
  if (parts.length === 1 && parts[0] === w.t) return [w];
  const total = parts.reduce((a, p) => a + p.length, 0) + parts.length - 1;
  const cw = (w.b[2] - w.b[0]) / Math.max(1, total);
  let x = w.b[0];
  return parts.map((t, k) => {
    const nw = { ...w, t, b: [x, w.b[1], x + cw * t.length, w.b[3]] };
    if (k > 0) delete nw.glue;
    x += cw * (t.length + 1);
    return nw;
  });
}
