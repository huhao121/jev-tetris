// Passthrough proxy for the Gemini API (generateContent), used by the battle
// page for the Gemini player. The page sends the visitor's key in an
// `x-goog-api-key` header and the model name in the JSON body's `model`
// field; nothing is stored server-side.

import { jsonResult } from "./typesafe.mjs";

export const GEMINI_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
const UPSTREAM_TIMEOUT_MS = 30_000;
const MODEL_RE = /^[a-z0-9.-]+$/;

export async function forwardToGemini({ key, body }) {
  if (!key) {
    return jsonResult(401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Enter your Gemini API key in the page first." } });
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResult(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Body must be JSON." } });
  }
  const { model, ...request } = parsed;
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    return jsonResult(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Body needs a `model` name such as gemini-3.8-flash." } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await upstream.text();
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return { status: upstream.status, headers, body: text };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return jsonResult(timedOut ? 504 : 502, {
      error: {
        code: timedOut ? 504 : 502,
        status: timedOut ? "DEADLINE_EXCEEDED" : "UNAVAILABLE",
        message: timedOut ? "Gemini API did not answer in time." : `Could not reach Gemini API: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
