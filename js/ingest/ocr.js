// OCR for scanned pages with no text layer, using Tesseract (tesseract.js, Apache-2.0), loaded only when needed.
// The engine and English model (~15 MB) come from the jsDelivr CDN the first time and are then cached by the browser.
import { mkLine, clusterLines } from "./pdf.js";

const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";
let workerP = null;

async function getWorker() {
  if (!workerP) {
    workerP = (async () => {
      const mod = await import(TESS);
      const Tesseract = mod.default || mod;
      return Tesseract.createWorker("eng");
    })();
  }
  return workerP;
}

/** Recognise one PDF.js page; returns blocks shaped like the text-layer extractor's. */
export async function ocrPage(page) {
  const scale = 3; // ~216 dpi
  const vp = page.getViewport({ scale });
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(vp.width, vp.height) : Object.assign(document.createElement("canvas"), { width: vp.width, height: vp.height });
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
  const input = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/png" }) : canvas;
  const worker = await getWorker();
  const { data } = await worker.recognize(input, {}, { blocks: true });
  // Tesseract lines can run across a margin note; split them where the gap between words is large
  const lines = [];
  for (const blk of data.blocks || []) for (const para of blk.paragraphs || []) for (const ln of para.lines || []) {
    const h = (ln.bbox.y1 - ln.bbox.y0) / scale;
    const words = (ln.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 30).map((w) => ({
      t: w.text.trim(), b: [w.bbox.x0 / scale, w.bbox.y0 / scale, w.bbox.x1 / scale, w.bbox.y1 / scale],
      sz: Math.max(4, Math.round(h * 0.75)), sup: false, bold: false,
    }));
    // a gap far wider than this line's usual word spacing means a different column (e.g. a margin note)
    const med = (xs) => { const v = xs.slice().sort((x, y) => x - y); return v.length ? v[v.length >> 1] : 0; };
    const gaps = words.slice(1).map((w, k) => w.b[0] - words[k].b[2]);
    const mg = Math.max(1, med(gaps)), mh = med(words.map((w) => w.b[3] - w.b[1])) || h;
    let cur = [];
    words.forEach((w, k) => {
      const prev = cur[cur.length - 1];
      const gap = k ? gaps[k - 1] : 0;
      if (prev && ((gap > 3 * mg && gap > 1.2 * mh) || gap > 3 * mh)) { lines.push(mkLine(cur)); cur = []; }
      cur.push(w);
    });
    if (cur.length) lines.push(mkLine(cur));
  }
  // margin fragments come after their line in Tesseract's order; regroup by column before clustering
  lines.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const cols = [];
  for (const ln of lines) {
    const c = cols.find((col) => { const l = col[col.length - 1]; return Math.min(l.bbox[2], ln.bbox[2]) - Math.max(l.bbox[0], ln.bbox[0]) > 0.3 * Math.min(l.bbox[2] - l.bbox[0], ln.bbox[2] - ln.bbox[0]); });
    if (c) c.push(ln); else cols.push([ln]);
  }
  return cols.flatMap((col) => clusterLines(col));
}
