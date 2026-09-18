// Zero-dependency static server + passthrough proxy for the TypeSafe API.
//
// Browsers cannot call api.typesafe.ai directly (its CORS policy rejects
// every browser origin), so the page posts to /api/systemone here and this
// server forwards the request unchanged, using the Authorization header the
// visitor supplied in the page. The key is never stored on the server.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const TYPESAFE_BASE = process.env.TYPESAFE_API_BASE || "https://api.typesafe.ai";
// Optional: if the host sets TYPESAFE_API_KEY, visitors who leave the key
// field blank use it. Leave it unset for a public deployment.
const SERVER_KEY = process.env.TYPESAFE_API_KEY || "";
const MAX_BODY = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveKey(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const key = match ? match[1].trim() : "";
  return key || SERVER_KEY;
}

async function proxy(req, res, path, { method, body }) {
  const key = resolveKey(req);
  if (!key) {
    sendJson(res, 401, {
      detail: { error_type: "authentication_error", message: "Enter your TypeSafe API key in the page first." },
    });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${TYPESAFE_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
    });
    const text = await upstream.text();
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    const requestId = upstream.headers.get("x-typesafe-request-id");
    if (requestId) headers["X-Typesafe-Request-Id"] = requestId;
    res.writeHead(upstream.status, headers);
    res.end(text);
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    sendJson(res, timedOut ? 504 : 502, {
      detail: {
        error_type: timedOut ? "timeout" : "upstream_error",
        message: timedOut ? "TypeSafe API did not answer in time." : `Could not reach TypeSafe API: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res, urlPath) {
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
      const body = await readBody(req);
      try {
        JSON.parse(body);
      } catch {
        sendJson(res, 400, { detail: { error_type: "bad_request", message: "Body must be JSON." } });
        return;
      }
      await proxy(req, res, "/v1/systemone", { method: "POST", body });
      return;
    }
    if (url.pathname === "/api/models" && req.method === "GET") {
      await proxy(req, res, "/v1/models", { method: "GET" });
      return;
    }
    if (url.pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, { serverKeyConfigured: Boolean(SERVER_KEY), model: "jev-latest" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { detail: { error_type: "not_found", message: "Unknown API route." } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { detail: { error_type: "server_error", message: err.message } });
  }
});

server.listen(PORT, () => {
  console.log(`jev-tetris listening on http://localhost:${PORT}`);
  if (SERVER_KEY) console.log("Using TYPESAFE_API_KEY from the environment as the fallback key.");
});
