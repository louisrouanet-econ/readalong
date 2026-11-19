// Word times of a stored recording, fitted to the passage that plays it (used by app.js).
/**
 * Word times for one passage of the current plan (chunk), from its stored recording (rec). Stored audio is found by its spoken text, so one recording serves
 * every passage with that text: the same passage before a re-extraction (when its words may have other numbers), or
 * the same sentence twice in a reading. Its word numbers are therefore never trusted: they are rebuilt from this
 * passage's own words. Returns null when the stored times cannot be matched; the passage is then voiced again.
 */
export function fitTimes(chunk, rec) {
  const spans = chunk.spans;
  if (rec.spanT && rec.spanT.length === 2 * spans.length) {
    const wids = [], s = [], e = [];
    spans.forEach(([w], si) => {
      const t0 = rec.spanT[2 * si], t1 = rec.spanT[2 * si + 1];
      if (!Number.isFinite(t0)) return;
      w.forEach((wid, k) => { wids.push(wid); s.push(t0 + ((t1 - t0) * k) / w.length); e.push(t0 + ((t1 - t0) * (k + 1)) / w.length); });
    });
    return { ...rec, wids: Int32Array.from(wids), s: Float32Array.from(s), e: Float32Array.from(e) };
  }
  // audio voiced before span times were kept (November 2026): usable when the words are this passage's, or when there
  // are as many, in the same order (the passage moved in the reading)
  const mine = spans.flatMap(([w]) => w);
  const own = new Set(mine);
  if (Array.prototype.every.call(rec.wids, (x) => own.has(x))) return rec;
  if (mine.length === rec.wids.length) return { ...rec, wids: Int32Array.from(mine) };
  return null;
}
