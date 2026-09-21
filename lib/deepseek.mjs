// Passthrough proxy for the DeepSeek API (chat/completions), used by the battle
// page for the DeepSeek player. The page sends the visitor's key in an
// `Authorization` or `x-api-key` header; nothing is stored server-side.

import { jsonResult } from "./typesafe.mjs";

export const DEEPSEEK_BASE = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function forwardToDeepSeek({ key, body }) {
  if (!key) {
    return jsonResult(401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Enter your DeepSeek API key in the page first." } });
  }
  let parsed;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return jsonResult(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Body must be JSON." } });
  }

  const endpoint = DEEPSEEK_BASE.endsWith("/chat/completions")
    ? DEEPSEEK_BASE
    : `${DEEPSEEK_BASE}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(parsed),
      signal: controller.signal,
    });
    const text = await upstream.text();
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    return { status: upstream.status, headers, body: text };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return jsonResult(timedOut ? 504 : 502, {
      error: {
        code: timedOut ? 504 : 502,
        status: timedOut ? "DEADLINE_EXCEEDED" : "UNAVAILABLE",
        message: timedOut ? "DeepSeek API did not answer in time." : `Could not reach DeepSeek API: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
