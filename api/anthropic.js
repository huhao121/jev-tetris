// Vercel serverless function: POST /api/anthropic -> Anthropic /v1/messages
import { readJsonBody, validateJson, writeResult, jsonResult } from "../lib/typesafe.mjs";
import { forwardToAnthropic } from "../lib/anthropic.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    writeResult(res, jsonResult(405, { type: "error", error: { type: "method_not_allowed", message: "Use POST." } }));
    return;
  }
  const body = await readJsonBody(req);
  const invalid = validateJson(body);
  if (invalid) {
    writeResult(res, invalid);
    return;
  }
  writeResult(res, await forwardToAnthropic({ key: req.headers["x-api-key"] || "", body }));
}
