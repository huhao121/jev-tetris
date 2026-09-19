// Zero-dependency static server + passthrough proxy for the TypeSafe API.
//
// Browsers cannot call api.typesafe.ai directly (its CORS policy rejects
// every browser origin), so the page posts to /api/systemone here and this
// server forwards the request unchanged, using the Authorization header the
// visitor supplied in the page. The key is never stored on the server.
//
// The same proxy logic runs as Vercel functions in api/ for hosted deploys.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_KEY,
  configResult,
  forwardToTypeSafe,
  jsonResult,
  keyFromAuthorization,
  readJsonBody,
  validateJson,
  writeResult,
} from "./lib/typesafe.mjs";
import { forwardToAnthropic } from "./lib/anthropic.mjs";
import { forwardToGemini } from "./lib/gemini.mjs";
import { forwardToGateway, hostedJevAvailable } from "./lib/gateway.mjs";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  let filePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  if (filePath === "/" || filePath === "") filePath = "/index.html";
  const full = join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/systemone" && req.method === "POST") {
      const body = await readJsonBody(req);
      const invalid = validateJson(body);
      if (invalid) {
        writeResult(res, invalid);
        return;
      }
      const result = await forwardToTypeSafe({
        path: "/v1/systemone",
        method: "POST",
        key: keyFromAuthorization(req.headers.authorization),
        body,
      });
      writeResult(res, result);
      return;
    }
    if (url.pathname === "/api/anthropic" && req.method === "POST") {
      const body = await readJsonBody(req);
      const invalid = validateJson(body);
      if (invalid) {
        writeResult(res, invalid);
        return;
      }
      writeResult(res, await forwardToAnthropic({ key: req.headers["x-api-key"] || "", body }));
      return;
    }
    if (url.pathname === "/api/jev-hosted" && req.method === "POST") {
      const body = await readJsonBody(req);
      writeResult(res, await forwardToGateway({ body, req }));
      return;
    }
    if (url.pathname === "/api/gemini" && req.method === "POST") {
      const body = await readJsonBody(req);
      writeResult(res, await forwardToGemini({ key: req.headers["x-goog-api-key"] || "", body }));
      return;
    }
    if (url.pathname === "/api/models" && req.method === "GET") {
      const result = await forwardToTypeSafe({
        path: "/v1/models",
        method: "GET",
        key: keyFromAuthorization(req.headers.authorization),
      });
      writeResult(res, result);
      return;
    }
    if (url.pathname === "/api/config" && req.method === "GET") {
      writeResult(res, configResult({ hostedJev: hostedJevAvailable(req) }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      writeResult(res, jsonResult(404, { detail: { error_type: "not_found", message: "Unknown API route." } }));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    writeResult(res, jsonResult(500, { detail: { error_type: "server_error", message: err.message } }));
  }
});

server.listen(PORT, () => {
  console.log(`jev-tetris listening on http://localhost:${PORT}`);
  if (SERVER_KEY) console.log("Using TYPESAFE_API_KEY from the environment as the fallback key.");
});
