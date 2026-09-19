// Vercel serverless function: POST /api/jev-hosted -> Jev via Vercel AI Gateway (server credential)
import { readJsonBody, writeResult, jsonResult } from "../lib/typesafe.mjs";
import { forwardToGateway } from "../lib/gateway.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    writeResult(res, jsonResult(405, { detail: { error_type: "method_not_allowed", message: "Use POST." } }));
    return;
  }
  const body = await readJsonBody(req);
  writeResult(res, await forwardToGateway({ body, req }));
}
