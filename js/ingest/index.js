// Detect a reading's format from its bytes (not its name) and extract words + structure.
import { extractPdf } from "./pdf.js";
import { extractDocx, extractHtml, extractText } from "./flow.js";

let pdfjsP = null;
export function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(new URL("../../vendor/pdfjs/pdf.min.mjs", import.meta.url).href).then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL("../../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      return m;
    });
  }
  return pdfjsP;
}

export function detect(bytes) {
  const head = bytes.subarray(0, 4096);
  const ascii = new TextDecoder("latin1").decode(head);
  if (ascii.startsWith("%PDF") || ascii.slice(0, 1024).includes("%PDF-")) return "pdf";
  if (ascii.startsWith("PK")) return ascii.includes("word/") ? "docx" : "zip";
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "doc";
  const low = ascii.replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
  if (low.startsWith("<!doctype html") || low.startsWith("<html") || low.startsWith("<?xml") || low.includes("<body") || low.includes("<p>")) return "html";
  return "text";
}

function decodeText(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

export async function extract(bytes, { forceOcr = false, skipOcr = false, onProgress = () => {} } = {}) {
  const kind = detect(bytes);
  if (kind === "pdf") {
    const pdfjs = await loadPdfjs();
    const { ocrPage } = await import("./ocr.js");
    return extractPdf(bytes, { pdfjs, forceOcr, skipOcr, onProgress, ocrPage });
  }
  if (kind === "docx" || kind === "zip") {
    try { return await extractDocx(bytes); } catch (e) { if (kind === "zip") throw new Error("This zip file is not a Word document."); throw e; }
  }
  if (kind === "doc") throw new Error("Old .doc files (Word 97-2003) are not supported. In Word, use File > Save As > .docx.");
  if (kind === "html") return extractHtml(decodeText(bytes));
  return extractText(decodeText(bytes));
}
