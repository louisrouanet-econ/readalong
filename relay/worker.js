// ReadAlong link relay (Cloudflare Worker).
// Browsers may only download files from other sites when those sites allow it (CORS); most don't. This relay
// fetches one public reading (PDF, Word, web page, text) for the ReadAlong page and passes it back unchanged.
// It is not a general proxy: GET only, http(s) only, only from the ReadAlong site, reading formats only,
// size-capped, no cookies or credentials either way, nothing stored.

const ALLOWED_ORIGINS = [
  "https://louisrouanet-econ.github.io",
  "http://127.0.0.1:8800",
  "http://localhost:8800",
];
const MAX_BYTES = 60 * 1024 * 1024; // 60 MB: larger than almost any assigned reading
const TYPES = /^(application\/pdf|application\/x-pdf|text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/msword|application\/octet-stream|binary\/octet-stream|application\/download|application\/force-download|application\/x-download)\b/i;
const UA = "ReadAlong/1.0 (fetches one reading on a reader's request; https://github.com/louisrouanet-econ/readalong)";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "X-Final-Url, X-Upstream-Status, Content-Disposition, Content-Type",
    "Vary": "Origin",
  };
}
function fail(origin, status, code, message, extra = {}) {
  return new Response(JSON.stringify({ code, message, ...extra }), {
    status, headers: { "Content-Type": "application/json", ...(origin ? cors(origin) : {}) },
  });
}
function privateHost(host) {
  return /^(localhost|.*\.local|.*\.internal)$/i.test(host) || /^\[?(::1|fc|fd|fe80)/i.test(host) ||
    /^(10|127|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) return fail(null, 403, "origin", "This relay only serves the ReadAlong site.");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "GET") return fail(origin, 405, "method", "Only GET is supported.");

    const target = new URL(request.url).searchParams.get("url") || "";
    let url;
    try { url = new URL(target); } catch { return fail(origin, 400, "bad-url", "That is not a web address."); }
    if (!/^https?:$/.test(url.protocol) || privateHost(url.hostname) || url.username || url.password) {
      return fail(origin, 400, "bad-url", "Only public http(s) addresses can be fetched.");
    }

    let up;
    try {
      // no cookies, no credentials, no headers from the reader: just the address
      up = await fetch(url.toString(), {
        method: "GET", redirect: "follow",
        headers: { "User-Agent": UA, "Accept": "application/pdf,text/html,application/xhtml+xml,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (e) {
      return fail(origin, 502, "unreachable", "The site could not be reached.");
    }
    const finalUrl = up.url || url.toString();
    const type = (up.headers.get("Content-Type") || "").split(";")[0].trim();
    if (!up.ok) {
      return fail(origin, 502, "upstream", `The site answered ${up.status}.`, { status: up.status, finalUrl });
    }
    if (type && !TYPES.test(type)) {
      return fail(origin, 415, "type", `This link is a ${type} file, not a reading.`, { type, finalUrl });
    }
    const len = Number(up.headers.get("Content-Length") || 0);
    if (len > MAX_BYTES) return fail(origin, 413, "too-big", "This file is larger than 60 MB.", { finalUrl });

    // enforce the size cap while streaming (Content-Length can be missing or wrong)
    let seen = 0;
    const cap = new TransformStream({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES) ctl.error(new Error("too big"));
        else ctl.enqueue(chunk);
      },
    });
    const headers = {
      ...cors(origin),
      "Content-Type": type || "application/octet-stream",
      "X-Final-Url": finalUrl,
      "X-Upstream-Status": String(up.status),
      "Cache-Control": "no-store",
    };
    const cd = up.headers.get("Content-Disposition");
    if (cd) headers["Content-Disposition"] = cd;
    return new Response(up.body.pipeThrough(cap), { status: 200, headers });
  },
};
