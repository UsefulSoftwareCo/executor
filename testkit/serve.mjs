import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs");
const TYPES = { ".html": "text/html", ".json": "application/json", ".mp4": "video/mp4", ".png": "image/png" };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const fp = path.normalize(path.join(root, p));
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end(); }
  let st; try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end("not found"); }
  const type = TYPES[path.extname(fp)] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {  // range support so <video> seeks/streams
    const m = /bytes=(\d+)-(\d*)/.exec(range); const start = +m[1]; const end = m[2] ? +m[2] : st.size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": st.size });
    fs.createReadStream(fp).pipe(res);
  }
}).listen(8901, "127.0.0.1", () => console.log("testkit runs on :8901"));
