// Run the link relay locally for development (no Cloudflare account needed): node tools/relay-dev.mjs
// Then set localStorage "readalong:relay" to "http://127.0.0.1:8787/" in the page, or rely on the default.
import http from "node:http";
import { Readable } from "node:stream";
import worker from "../relay/worker.js";

const PORT = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  try {
    const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers: req.headers });
    const r = await worker.fetch(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`relay on http://127.0.0.1:${PORT}/`));
