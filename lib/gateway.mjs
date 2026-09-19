// Hosted Jev through Vercel AI Gateway. The server holds the gateway
// credential (AI_GATEWAY_API_KEY, or the deployment's VERCEL_OIDC_TOKEN),
// so visitors can play against Jev without a TypeSafe key of their own.
//
// The gateway speaks the AI SDK's evaluation-model protocol
// (POST {base}/v4/ai/evaluation-model, model in a header) and calls the
// yes/no question type "boolean" where TypeSafe calls it "noul". This
// module translates a TypeSafe-shaped request in and a TypeSafe-shaped
// response out, so the page code is identical for both paths.

import { jsonResult } from "./typesafe.mjs";

export const GATEWAY_BASE = process.env.AI_GATEWAY_BASE || "https://ai-gateway.vercel.sh/v4/ai";
export const GATEWAY_MODEL = "typesafe-ai/jev";
const PROTOCOL_VERSION = "0.0.1";
const UPSTREAM_TIMEOUT_MS = 30_000;

export function gatewayCredential() {
  if (process.env.AI_GATEWAY_API_KEY) return { token: process.env.AI_GATEWAY_API_KEY, method: "api-key" };
  if (process.env.VERCEL_OIDC_TOKEN) return { token: process.env.VERCEL_OIDC_TOKEN, method: "oidc" };
  return null;
}

export function hostedJevAvailable() {
  return gatewayCredential() !== null;
}

// TypeSafe request -> gateway request body.
export function toGatewayRequest(request) {
  const questions = {};
  for (const [id, q] of Object.entries(request.questions || {})) {
    if (q.type === "noul") {
      const { type, ...rest } = q;
      questions[id] = { ...rest, type: "boolean" };
    } else {
      questions[id] = q;
    }
  }
  return { state: request.state, questions };
}

// Peakedness of a distribution: top probability minus the runner-up. The
// gateway response carries no confidence field, so this stands in for it.
function derivedConfidence(probabilities) {
  const sorted = Object.values(probabilities || {}).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  return Math.max(0, Math.min(1, sorted[0] - (sorted[1] ?? 0)));
}

// Gateway response -> TypeSafe response shape.
export function fromGatewayResponse(body, questions) {
  const answers = {};
  for (const [id, a] of Object.entries(body.answers || {})) {
    if (a.type === "boolean") {
      answers[id] = { type: "noul", noul: a.probability };
    } else if (a.type === "choice") {
      answers[id] = { type: "choice", choice: a.choice, probabilities: a.probabilities || {}, confidence: derivedConfidence(a.probabilities) };
    } else if (a.type === "score") {
      const levels = Array.isArray(questions?.[id]?.criteria) ? questions[id].criteria : [];
      answers[id] = {
        type: "score",
        score: a.score,
        probabilities: a.probabilities || {},
        legend: Object.fromEntries(levels.map((l, i) => [String(i), typeof l === "string" ? l : JSON.stringify(l)])),
        confidence: derivedConfidence(a.probabilities),
      };
    }
  }
  return {
    model: `${GATEWAY_MODEL} (via Vercel AI Gateway)`,
    answers,
    usage: { input_tokens: body.usage?.inputTokens || 0, output_tokens: body.usage?.outputTokens || 0 },
    warnings: body.warnings,
  };
}

export async function forwardToGateway({ body }) {
  const cred = gatewayCredential();
  if (!cred) {
    return jsonResult(503, {
      detail: { error_type: "not_configured", message: "Hosted Jev is not configured on this server (no AI_GATEWAY_API_KEY). Enter a TypeSafe key instead." },
    });
  }
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return jsonResult(400, { detail: { error_type: "bad_request", message: "Body must be JSON." } });
  }
  if (!request || typeof request !== "object" || !request.questions) {
    return jsonResult(400, { detail: { error_type: "bad_request", message: "Body needs `state` and `questions`." } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${GATEWAY_BASE}/evaluation-model`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "ai-gateway-protocol-version": PROTOCOL_VERSION,
        "ai-gateway-auth-method": cred.method,
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": GATEWAY_MODEL,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(toGatewayRequest(request)),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      let detail;
      try {
        detail = JSON.parse(text);
      } catch {
        detail = { message: text };
      }
      const message = detail?.error?.message || detail?.message || `Gateway HTTP ${upstream.status}`;
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) headers["Retry-After"] = retryAfter;
      return { status: upstream.status, headers, body: JSON.stringify({ detail: { error_type: "gateway_error", message } }) };
    }
    return jsonResult(200, fromGatewayResponse(JSON.parse(text), request.questions));
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return jsonResult(timedOut ? 504 : 502, {
      detail: {
        error_type: timedOut ? "timeout" : "upstream_error",
        message: timedOut ? "Vercel AI Gateway did not answer in time." : `Could not reach Vercel AI Gateway: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
