// Minimal Node service. Replace it with your application — the pipeline around
// it (Dockerfile, compose.yaml, .github/workflows/deploy.yml) is what
// PromptZone seeded, and it does not care what this file grows into.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 8080;
// Passed in by compose from the deploy workflow. Naming the PromptZone web
// origin as a frame ancestor is what lets the project's Preview tab embed this
// app instead of falling back to a link card.
const WEB_ORIGIN = process.env.PZ_WEB_ORIGIN || "";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = path.join(process.cwd(), "public", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
      if (WEB_ORIGIN) headers["content-security-policy"] = `frame-ancestors ${WEB_ORIGIN}`;
      res.writeHead(200, headers);
      res.end(body);
    });
  })
  .listen(PORT, "0.0.0.0");
