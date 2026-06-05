// Zero-dependency static server for previewing the site locally.
//   npm run serve   →   http://localhost:4173
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(process.cwd(), "site");
const PORT = Number(process.env.PORT) || 4173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    let path = normalize(join(ROOT, url === "/" ? "/index.html" : url));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`▸ serving site/ at http://localhost:${PORT}`));
