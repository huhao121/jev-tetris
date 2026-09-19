// Vercel serverless function: POST /api/gemini -> Gemini models/{model}:generateContent
import { readJsonBody, writeResult, jsonResult } from "../lib/typesafe.mjs";
import { forwardToGemini } from "../lib/gemini.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    writeResult(res, jsonResult(405, { error: { code: 405, status: "METHOD_NOT_ALLOWED", message: "Use POST." } }));
    return;
  }
  const body = await readJsonBody(req);
  writeResult(res, await forwardToGemini({ key: req.headers["x-goog-api-key"] || "", body }));
}
