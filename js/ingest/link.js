// Open a reading from a link: a PDF, a Word file, a web page, or a share link (Google Docs/Drive, Dropbox, GitHub).
// The browser first tries to download it directly; most sites forbid that (CORS), so it then asks the ReadAlong
// relay (relay/worker.js), which fetches that one address and passes the file back unchanged.
import { detect, looksBinary } from "./index.js";

// The relay's address. On a local copy (http://127.0.0.1:8800) the development relay is used: node tools/relay-dev.mjs
const PUBLIC_RELAY = "https://readalong-relay.louisrouanet-econ.workers.dev/";
export function relayUrl() {
  try { const o = localStorage.getItem("readalong:relay"); if (o) return o; } catch { /* storage blocked */ }
  return /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? "http://127.0.0.1:8787/" : PUBLIC_RELAY;
}

export class LinkError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const DROP = "Download the file in your browser, then drop it on this page.";

/** Share and viewer links -> the address of the file itself. Each rule was checked against a real link. */
export function directUrl(input) {
  let s = String(input).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw new LinkError("That doesn't look like a web address.", "bad-url"); }
  if (!/^https?:$/.test(u.protocol)) throw new LinkError("Only web addresses (http or https) can be opened.", "bad-url");
  const h = u.hostname.toLowerCase(), p = u.pathname;
  let m;
  // Google Docs: the document itself, as a Word file (works when it is shared with "anyone with the link")
  if (h === "docs.google.com" && (m = p.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/))) return `https://docs.google.com/document/d/${m[1]}/export?format=docx`;
  // Google Drive file: the download address instead of the viewer page
  if (h === "drive.google.com" && ((m = p.match(/^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/)) || (p === "/open" || p === "/uc") && (m = [0, u.searchParams.get("id")]) && m[1])) {
    return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  }
  // GitHub: the raw file instead of the page that shows it
  if (h === "github.com" && (m = p.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/))) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  // Dropbox: the file instead of the preview page
  if (/(^|\.)dropbox\.com$/.test(h) && /^\/(s|scl)\//.test(p)) { u.searchParams.delete("dl"); u.searchParams.set("raw", "1"); return u.toString(); }
  return u.toString();
}

/** Download one address: directly when the site allows it, else through the relay. */
async function get(url, signal) {
  let res = null;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit", redirect: "follow", signal });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    res = null; // the site does not allow direct downloads (or http:// from an https page): use the relay
  }
  if (res) {
    if (!res.ok) throw upstreamError(res.status);
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("Content-Type") || "", finalUrl: res.url || url, cd: res.headers.get("Content-Disposition") || "" };
  }
  let r;
  try {
    r = await fetch(relayUrl() + "?url=" + encodeURIComponent(url), { mode: "cors", credentials: "omit", signal });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new LinkError("The link service could not be reached. " + DROP, "relay");
  }
  if (!r.ok) {
    let info = {};
    try { info = await r.json(); } catch { /* not JSON: the relay itself failed or is over its daily limit */ }
    if (info.code === "upstream") throw upstreamError(info.status);
    if (info.code === "type") throw new LinkError(`This link leads to a ${info.type || "file"} that is not a reading. Links to a PDF, a Word file or a web page work.`, "type");
    if (info.code === "too-big") throw new LinkError("This file is larger than 60 MB. " + DROP, "too-big");
    if (info.code === "unreachable") throw new LinkError("That site could not be reached. Check the address.", "unreachable");
    if (info.code === "bad-url") throw new LinkError(info.message || "That address cannot be opened.", "bad-url");
    throw new LinkError("The link service is not available right now. " + DROP, "relay");
  }
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("Content-Type") || "", finalUrl: r.headers.get("X-Final-Url") || url, cd: r.headers.get("Content-Disposition") || "" };
}
function upstreamError(status) {
  if (status === 401 || status === 403) return new LinkError("That site does not let ReadAlong download the reading (it may need a login, as JSTOR, Canvas and library links do). " + DROP, "login");
  if (status === 404 || status === 410) return new LinkError("Nothing was found at that address. Check the link.", "missing");
  if (status === 429) return new LinkError("That site is refusing downloads for the moment. Try again later, or: " + DROP.toLowerCase(), "busy");
  return new LinkError(`That site answered with an error (${status}). ` + DROP, "upstream");
}

const LOGIN_URL = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com)$|^(login|signin|sso|idp|auth|shibboleth|cas)\./i;
const LOGIN_PATH = /\/(login|signin|sign-in|sso|shibboleth|saml2?|authenticate|cas\/login)\b/i;
const BLOCK_TITLE = /\b(sign in|log ?in|access denied|client challenge|just a moment|attention required|are you a robot|verify you are human|captcha|forbidden|subscribe to read)\b/i;

function htmlInfo(bytes, baseUrl) {
  const html = new TextDecoder("utf-8").decode(bytes);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (n) => { const el = doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`); return el && el.getAttribute("content"); };
  let pdf = meta("citation_pdf_url");
  try { if (pdf) pdf = new URL(pdf, baseUrl).toString(); } catch { pdf = null; }
  doc.querySelectorAll("script,style,noscript,nav,header,footer,aside,form").forEach((e) => e.remove());
  const words = (doc.body ? doc.body.textContent : "").split(/\s+/).filter((w) => /\p{L}{2}/u.test(w)).length;
  const cite = (meta("citation_title") || meta("og:title") || "").trim();
  return { title: (doc.title || "").trim(), cite, pdf, words };
}

function fileName(got, fallbackTitle) {
  const cd = got.cd;
  let m = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i) || cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  let name = m ? decodeURIComponent(m[1]).trim() : "";
  if (!name) {
    try { name = decodeURIComponent(new URL(got.finalUrl).pathname.split("/").filter(Boolean).pop() || ""); } catch { name = ""; }
    if (!/\.(pdf|docx|html?|txt|md)$/i.test(name)) name = "";
  }
  if (!name && fallbackTitle) name = fallbackTitle.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 90).trim();
  if (!name) { try { name = new URL(got.finalUrl).hostname; } catch { name = "reading"; } }
  const kind = detect(got.bytes);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += kind === "pdf" ? ".pdf" : kind === "docx" ? ".docx" : kind === "html" ? ".html" : ".txt";
  return name;
}

/**
 * Fetch the reading behind a link. Returns {name, bytes, url}. Throws LinkError with a message for the reader.
 * Article pages that announce their PDF (citation_pdf_url, used by journals, SSRN, NBER, arXiv, repositories)
 * are replaced by that PDF when it can be downloaded.
 */
export async function fetchLink(input, { onProgress = () => {}, signal } = {}) {
  const url = directUrl(input);
  onProgress("Downloading");
  let got = await get(url, signal);
  let kind = detect(got.bytes);
  if (kind === "html") {
    const info = htmlInfo(got.bytes, got.finalUrl);
    let host = "", path = "";
    try { const f = new URL(got.finalUrl); host = f.hostname; path = f.pathname; } catch { /* keep empty */ }
    if (LOGIN_URL.test(host) || LOGIN_PATH.test(path)) {
      throw new LinkError("That link needs a login (it is not shared publicly). " + DROP, "login");
    }
    if (info.pdf && info.pdf !== got.finalUrl) {
      onProgress("Downloading the PDF of this article");
      try {
        const pdf = await get(info.pdf, signal);
        // the article page knows the real title; the PDF often has a file name like "w20578.pdf"
        if (detect(pdf.bytes) === "pdf") return { name: info.cite ? info.cite.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 90).trim() + ".pdf" : fileName(pdf, info.title), title: info.cite || "", bytes: pdf.bytes, url: pdf.finalUrl };
      } catch (e) { if (signal && signal.aborted) throw e; /* fall back to the page itself */ }
      if (info.words < 1500) throw new LinkError("This page shows the abstract, and its PDF needs a login. " + DROP, "login");
    }
    if (info.words < 150 || (BLOCK_TITLE.test(info.title) && info.words < 600)) {
      throw new LinkError("That page has almost no readable text: it may need a login, or the site may block downloads. " + DROP, "login");
    }
    return { name: fileName(got, info.title), bytes: got.bytes, url: got.finalUrl };
  }
  if (kind === "text" && looksBinary(got.bytes)) throw new LinkError("This link leads to a file that is not a reading. Links to a PDF, a Word file or a web page work.", "type");
  return { name: fileName(got, ""), bytes: got.bytes, url: got.finalUrl };
}
