// Word (.docx), web pages (HTML) and plain text. Port of ReadingApp_1/reader/ingest/flow.py.
const FOOTMARK = /^[\d*†‡§¶[\]]+$/;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

class WordSink {
  constructor() { this.words = []; this.spaceBefore = true; }
  add(text, sup = false, it = false) {
    if (!text) return;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { this.spaceBefore = true; continue; }
      const w = { t: part };
      if (sup && FOOTMARK.test(part)) w.sup = 1;
      if (it) w.it = 1;
      const last = this.words[this.words.length - 1];
      if (!this.spaceBefore && last) {
        if (sup || last.sup) w.glue = 1;
        else { last.t += part; this.spaceBefore = false; continue; }
      }
      this.words.push(w);
      this.spaceBefore = false;
    }
  }
  space() { this.spaceBefore = true; }
}

// a table cell is not read when it is a number or a short label ("Betting Fraction", "$55,427"); long cells
// (pages that use tables for layout) are ordinary text
function isCellText(words) {
  const txt = words.map((w) => w.t).join(" ");
  return (txt.match(/\p{L}/gu) || []).length < 3 || (words.length <= 12 && !/[.!?]["'”’)\]]*$/.test(txt));
}
const kids = (el, local) => [...el.children].filter((c) => c.localName === local);
const firstKid = (el, local) => [...el.children].find((c) => c.localName === local) || null;
const attr = (el, name) => (el ? el.getAttributeNS(W, name) || el.getAttribute("w:" + name) : null);

function docxRuns(p, sink) {
  for (const r of p.getElementsByTagNameNS(W, "r")) {
    const rpr = firstKid(r, "rPr");
    const va = rpr && firstKid(rpr, "vertAlign");
    const sup = !!va && attr(va, "val") === "superscript";
    const iEl = rpr && firstKid(rpr, "i");
    const it = !!iEl && !["0", "false"].includes(attr(iEl, "val"));
    for (const c of r.children) {
      if (c.localName === "t") sink.add(c.textContent, sup, it);
      else if (["tab", "br", "cr"].includes(c.localName)) sink.space();
      else if (c.localName === "footnoteReference") sink.add(attr(c, "id") || "", true);
    }
  }
}

export async function extractDocx(bytes) {
  const { unzipSync, strFromU8 } = await import(new URL("../../vendor/fflate.mjs", import.meta.url).href);
  const z = unzipSync(new Uint8Array(bytes));
  const parse = (name) => (z[name] ? new DOMParser().parseFromString(strFromU8(z[name]), "application/xml") : null);
  const doc = parse("word/document.xml");
  if (!doc) throw new Error("This Word file has no document body.");
  const styles = {};
  const st = parse("word/styles.xml");
  if (st) for (const s of st.getElementsByTagNameNS(W, "style")) {
    const name = firstKid(s, "name");
    styles[attr(s, "styleId")] = (name && attr(name, "val")) || attr(s, "styleId") || "";
  }
  const blocks = [];
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  for (const p of body.getElementsByTagNameNS(W, "p")) {
    const sink = new WordSink();
    docxRuns(p, sink);
    if (!sink.words.length) continue;
    const ppr = firstKid(p, "pPr");
    const ps = ppr && firstKid(ppr, "pStyle");
    const style = ((ps && (styles[attr(ps, "val")] || attr(ps, "val"))) || "").toLowerCase();
    let t = "para";
    if (style.startsWith("heading") || style === "title" || style === "subtitle") t = "heading";
    else if (style.includes("caption")) t = "caption";
    else if (style.includes("footnote") || style.includes("endnote")) t = "footnote";
    let inTable = false;
    for (let a = p.parentNode; a && a !== body; a = a.parentNode) if (a.localName === "tc") { inTable = true; break; }
    if (t === "para" && inTable && isCellText(sink.words)) t = "figure";
    blocks.push({ type: t, words: sink.words });
  }
  const notes = parse("word/footnotes.xml");
  if (notes) for (const fn of notes.getElementsByTagNameNS(W, "footnote")) {
    if (["separator", "continuationSeparator"].includes(attr(fn, "type"))) continue;
    const sink = new WordSink();
    sink.add(`[${attr(fn, "id")}]`);
    sink.space();
    for (const p of fn.getElementsByTagNameNS(W, "p")) { docxRuns(p, sink); sink.space(); }
    if (sink.words.length > 1) blocks.push({ type: "footnote", words: sink.words });
  }
  let title = "";
  const core = parse("docProps/core.xml");
  if (core) { const t = core.getElementsByTagName("dc:title")[0]; title = t ? t.textContent.trim() : ""; }
  if (!title) { const h = blocks.find((b) => b.type === "heading"); title = h ? h.words.map((w) => w.t).join(" ") : ""; }
  return { kind: "docx", title, pages: [], blocks };
}

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt", "figcaption", "td",
  "th", "caption", "div", "section", "article", "main", "ul", "ol", "table", "tr", "tbody", "thead", "header", "footer",
  "aside", "nav", "figure", "body"]);
const DROP = "script,style,noscript,nav,header,footer,aside,form,svg,button,iframe,template,select,input,img,video,audio,canvas";

export function extractHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let title = (doc.title || "").trim();
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  let root = doc.querySelector("article") || doc.querySelector("main") || doc.body || doc.documentElement;
  if (root.textContent.trim().length < 500 && doc.body) {
    let best = doc.body, score = 0;
    for (const el of doc.body.querySelectorAll("div,section,article,main")) {
      const sc = [...el.children].filter((c) => c.localName === "p").reduce((a, p) => a + p.textContent.trim().length, 0);
      if (sc > score) { best = el; score = sc; }
    }
    root = best;
  }
  const blocks = [];
  const hasBlockChild = (el) => [...el.children].some((c) => BLOCK_TAGS.has(c.localName));
  const emit = (el) => {
    const sink = new WordSink();
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      let sup = false, it = false;
      for (let p = n.parentNode; p && p !== el; p = p.parentNode) {
        if (p.localName === "sup") sup = true;
        if (["i", "em", "cite"].includes(p.localName)) it = true;
      }
      sink.add(n.nodeValue, sup, it);
    }
    if (!sink.words.length) return;
    let t = /^h[1-6]$/.test(el.localName) ? "heading" : ["figcaption", "caption"].includes(el.localName) ? "caption" : "para";
    if (t === "para" && el.closest && el.closest("td,th") && isCellText(sink.words)) t = "figure";
    blocks.push({ type: t, words: sink.words });
  };
  const walk = (el) => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) {
        const txt = c.nodeValue.trim();
        if (txt) { const s = new WordSink(); s.add(txt); blocks.push({ type: "para", words: s.words }); }
        continue;
      }
      if (c.nodeType !== 1) continue;
      if (BLOCK_TAGS.has(c.localName) && hasBlockChild(c)) walk(c);
      else if (BLOCK_TAGS.has(c.localName)) emit(c);
      else {
        const txt = c.textContent.trim();
        if (txt) { const s = new WordSink(); s.add(txt); blocks.push({ type: "para", words: s.words }); }
      }
    }
  };
  if (BLOCK_TAGS.has(root.localName) && hasBlockChild(root)) walk(root); else emit(root);
  if (!title) { const h = blocks.find((b) => b.type === "heading"); title = h ? h.words.map((w) => w.t).join(" ") : ""; }
  return { kind: "html", title, pages: [], blocks };
}

export function extractText(text) {
  const blocks = [];
  for (let chunk of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    chunk = chunk.trim();
    if (!chunk) continue;
    let t = "para";
    const m = chunk.match(/^#{1,6}\s+(.*)$/);
    if (m && !chunk.includes("\n")) { t = "heading"; chunk = m[1]; }
    const s = new WordSink();
    s.add(chunk);
    blocks.push({ type: t, words: s.words });
  }
  const h = blocks.find((b) => b.type === "heading");
  return { kind: "text", title: h ? h.words.map((w) => w.t).join(" ") : "", pages: [], blocks };
}
