// Web pages shown as they look (the "Page" view of an HTML reading): the original page is drawn in a frame, and the
// words that are read aloud are found on it so the highlight, clicks and notes work as on a PDF page.
// The words come from the reader-mode text (ingest/flow.js) and are not changed here: they are matched onto the page
// when it is shown, so readings, voiced audio and notes made before this view existed keep working.

/** The page's HTML made safe to show: no scripts, no automatic redirects, no embedded frames. The frame is also
 *  sandboxed without scripts (app.js), so this is a second lock. Relative images and styles of a page opened from a
 *  link load from its site; a saved file keeps what is inside it (images embedded as data, its own styles). */
export function webSource(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, noscript, template, iframe, frame, frameset, object, embed, base, meta[http-equiv], link[rel=preload], link[rel=prefetch], link[rel=modulepreload], link[rel=manifest]")
    .forEach((e) => e.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
  // images that wait for a script to swap them in ("data-src") are shown directly
  doc.querySelectorAll("img[data-src]:not([src]), img[data-src][src^='data:image/gif'], img[data-src][src$='.gif']").forEach((img) => img.setAttribute("src", img.getAttribute("data-src")));
  doc.querySelectorAll("img[loading=lazy]").forEach((img) => img.removeAttribute("loading"));
  // folded sections ("details") are read aloud, so they are shown unfolded
  doc.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  const first = head.firstChild;
  const add = (html) => { const t = doc.createElement("template"); t.innerHTML = html; head.insertBefore(t.content, first); };
  add(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer">`);
  if (url && /^https?:/i.test(url)) { const b = doc.createElement("base"); b.href = url; head.insertBefore(b, head.firstChild); }
  // the frame grows with the page (the reader scrolls it, not the frame); full-screen heights would grow with it.
  // Wider than the reader (big tables), the page scrolls sideways inside the frame, as it would in a browser.
  const st = doc.createElement("style");
  st.textContent = "html{overflow-x:auto!important;overflow-y:hidden!important;height:auto!important;min-height:0!important}body{height:auto!important;min-height:0!important}";
  head.appendChild(st);
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

/** A Word document drawn as Word lays it out (docx-preview: pages, fonts, images, headers, footnotes), as an HTML
 *  page for the same frame as web pages. Images are kept inside the page (data URLs). */
export async function docxSource(bytes) {
  const { renderAsync } = await import(new URL("../vendor/docx-preview/docx-preview.min.mjs", import.meta.url).href);
  const body = document.createElement("div"), style = document.createElement("div");
  await renderAsync(bytes, body, style, { className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true });
  return `<!doctype html><html><head><meta charset="utf-8">${style.innerHTML}</head><body style="margin:0">${body.innerHTML}</body></html>`;
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "TITLE"]);
export const wordKey = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The page's text as pieces between spaces, each with where it sits: {node, a, b, k (key)}. */
function pageTokens(doc) {
  const toks = [];
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => { for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (SKIP.has(p.nodeName.toUpperCase()) || p.localName === "svg") return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; },
  });
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(s))) toks.push({ node: n, a: m.index, b: m.index + m[0].length, k: wordKey(m[0]) });
  }
  return toks;
}

/**
 * Find each word of the reading on the page. Returns an array (one per word) of Range or null.
 * Words are matched in order. A place on the page is accepted when the next few words follow there too, so a title
 * repeated in a menu or a common word does not pull the match away. A word written across two pieces of the page
 * ("hel<b>lo</b>") matches the pieces joined.
 */
export function alignWords(doc, words, run = 4) {
  const toks = pageTokens(doc);
  const keyed = toks.map((t, i) => i).filter((i) => toks[i].k); // positions of pieces that have letters or digits
  const posOf = new Map(); // key -> positions in `keyed`
  keyed.forEach((ti, q) => { const k = toks[ti].k; if (!posOf.has(k)) posOf.set(k, []); posOf.get(k).push(q); });
  const firstKeyIdx = (k) => { // pieces whose key starts a word with this key
    const out = [];
    for (const [pk, list] of posOf) if (k.startsWith(pk)) out.push(...list);
    return out.sort((x, y) => x - y);
  };
  const wk = words.map((w) => wordKey(w.t));
  /** Does word i start at keyed piece q? Returns the number of pieces it takes, or 0. */
  const at = (i, q) => {
    let acc = "";
    for (let n = 0; n < 8 && q + n < keyed.length; n++) {
      acc += toks[keyed[q + n]].k;
      if (acc === wk[i]) return n + 1;
      if (!wk[i].startsWith(acc)) return 0;
    }
    return 0;
  };
  const ranges = new Array(words.length).fill(null);
  let q0 = 0; // matching goes forward from here
  const nextKeyed = (i) => { let j = i + 1; while (j < words.length && !wk[j]) j++; return j; };
  const cache = new Map();
  for (let i = 0; i < words.length; i++) {
    if (!wk[i]) continue;
    let cands = cache.get(wk[i]);
    if (!cands) { cands = posOf.get(wk[i]) || firstKeyIdx(wk[i]); cache.set(wk[i], cands); }
    // the first place at or after q0 where this word and the next few follow on
    let lo = 0, hi = cands.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cands[m] < q0) lo = m + 1; else hi = m; }
    let found = -1, len = 0;
    for (let c = lo; c < cands.length; c++) {
      const q = cands[c];
      const n = at(i, q);
      if (!n) continue;
      let ok = true, qq = q + n, ii = i;
      const need = q - q0 > 1500 ? 2 * run : run; // a jump far ahead needs more proof
      for (let r = 1; r < need; r++) {
        ii = nextKeyed(ii);
        if (ii >= words.length || qq >= keyed.length) break; // the end of the reading or the page
        const m = at(ii, qq);
        if (!m) { ok = false; break; }
        qq += m;
      }
      if (ok) { found = q; len = n; break; }
    }
    if (found < 0) continue;
    const a = toks[keyed[found]], b = toks[keyed[found + len - 1]];
    const r = doc.createRange();
    r.setStart(a.node, a.a);
    r.setEnd(b.node, b.b);
    ranges[i] = r;
    q0 = found + len;
  }
  return ranges;
}

// the nearest box that scrolls or clips its content (a wide table in a side-scrolling box), per element
const clipOf = new WeakMap();
function clipBox(el) {
  if (!el) return null;
  if (clipOf.has(el)) return clipOf.get(el);
  let c = null;
  for (let p = el; p && p.nodeType === 1 && p !== p.ownerDocument.body && p !== p.ownerDocument.documentElement; p = p.parentElement) {
    const o = p.ownerDocument.defaultView.getComputedStyle(p);
    if (o.overflowX !== "visible" || o.overflowY !== "visible") { c = p; break; }
  }
  clipOf.set(el, c);
  return c;
}

/** The visible boxes of a word on the page, relative to the frame's top-left corner (the frame never scrolls up or
 *  down; sideways it may). A word scrolled out of a side-scrolling box has none. */
export function rangeBoxes(r) {
  if (!r) return [];
  const boxes = [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
  const c = boxes.length && clipBox(r.startContainer.parentElement);
  if (!c) return boxes;
  const k = c.getBoundingClientRect();
  return boxes.filter((b) => b.right > k.left + 1 && b.left < k.right - 1 && b.bottom > k.top + 1 && b.top < k.bottom - 1)
    .map((b) => { const l = Math.max(b.left, k.left), rt = Math.min(b.right, k.right); return { left: l, right: rt, top: b.top, bottom: b.bottom, width: rt - l, height: b.height }; });
}
