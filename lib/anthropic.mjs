// Passthrough proxy for the Anthropic Messages API, used by the battle page
// for the Claude Haiku player. The page sends the visitor's key in an
// `x-api-key` header; nothing is stored server-side.

import { jsonResult } from "./typesafe.mjs";

export const ANTHROPIC_BASE = process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function forwardToAnthropic({ key, body }) {
  if (!key) {
    return jsonResult(401, {
      type: "error",
      error: { type: "authentication_error", message: "Enter your Anthropic API key in the page first." },
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
    const text = await upstream.text();
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    const requestId = upstream.headers.get("request-id");
    if (requestId) headers["X-Request-Id"] = requestId;
    return { status: upstream.status, headers, body: text };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return jsonResult(timedOut ? 504 : 502, {
      type: "error",
      error: {
        type: timedOut ? "timeout" : "upstream_error",
        message: timedOut ? "Anthropic API did not answer in time." : `Could not reach Anthropic API: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
