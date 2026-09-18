// The two contestants of the battle page. Each player gets identical
// information (the board plus the same described placement options) and
// must return one option id. Both go through the local proxy in server.mjs.

import { describePlacement, boardToText, describeHeight, describeHoles, describeSurface } from "./tetris.js";
import { buildRequest, askJev, pickPlacement } from "./jev.js";

export const JEV_PRICE = { input: 0.042 / 1e6, output: 0 };
export const HAIKU_MODEL = "claude-haiku-4-5";
export const HAIKU_PRICE = { input: 1 / 1e6, output: 5 / 1e6 }; // $1 / $5 per MTok

// ---- Jev ----------------------------------------------------------------------

export function createJevPlayer(apiKey) {
  return {
    name: "Jev",
    short: "Jev",
    model: "jev-latest",
    async decide(gameInfo, placements, signal) {
      const request = buildRequest(gameInfo, placements);
      // The battle only needs the placement Choice; drop the extra questions.
      request.questions = { placement: request.questions.placement };
      const { response, latencyMs } = await askJev(request, apiKey, { signal, maxAttempts: 2 });
      const { chosen, confidence } = pickPlacement(response, placements);
      const usage = response.usage || {};
      return {
        chosen,
        latencyMs,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cost: (usage.input_tokens || 0) * JEV_PRICE.input,
        note: `confidence ${confidence.toFixed(2)}`,
      };
    },
  };
}

// ---- Claude Haiku ---------------------------------------------------------------

const HAIKU_SYSTEM = [
  "You are playing Tetris in real time. Each turn you get the board and a list of every legal placement for the current piece, each described by its outcome.",
  "Pick the best placement. Good play: clear lines (more at once is better), never create holes unless every option does, keep the stack low and the surface flat, avoid several deep wells.",
  "The piece is falling while you think, so decide immediately by calling the place_piece tool.",
].join(" ");

export function buildHaikuPrompt(gameInfo, placements) {
  const { board, piece, nextPiece, stats, linesCleared } = gameInfo;
  const options = {};
  for (const p of placements) options[p.id] = describePlacement(p);
  return JSON.stringify(
    {
      board_rows_top_to_bottom: boardToText(board),
      legend: "# filled, . empty",
      column_heights_left_to_right: stats.heights,
      stack_height: describeHeight(stats.maxHeight),
      holes_in_stack: describeHoles(stats.holes),
      surface: describeSurface(stats.bumpiness),
      current_piece: piece,
      next_piece: nextPiece,
      lines_cleared_so_far: linesCleared,
      options,
    },
    null,
    0,
  );
}

// Forced tool call with an enum of the option ids: the answer is always one
// of the offered placements, just as Jev's Choice is constrained to them.
export function buildHaikuTool(placements) {
  return {
    name: "place_piece",
    description: "Choose where to drop the current piece by naming one option id from the options list.",
    input_schema: {
      type: "object",
      properties: { option_id: { type: "string", enum: placements.map((p) => p.id) } },
      required: ["option_id"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export function parseHaikuChoice(message, placements) {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "place_piece" && byId.has(b.input?.option_id)) return byId.get(b.input.option_id);
  }
  // Fallback for a plain-text reply naming an id.
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  for (const m of text.match(/\bp\d+\b/g) || []) if (byId.has(m)) return byId.get(m);
  return null;
}

export function createHaikuPlayer(apiKey, { endpoint = "api/anthropic" } = {}) {
  return {
    name: "Claude Haiku 4.5",
    short: "Haiku 4.5",
    model: HAIKU_MODEL,
    async decide(gameInfo, placements, signal) {
      const body = {
        model: HAIKU_MODEL,
        max_tokens: 64,
        system: HAIKU_SYSTEM,
        tools: [buildHaikuTool(placements)],
        tool_choice: { type: "tool", name: "place_piece" },
        messages: [{ role: "user", content: buildHaikuPrompt(gameInfo, placements) }],
      };
      const started = performance.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      });
      const latencyMs = performance.now() - started;
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!res.ok) {
        const message = json?.error?.message || text || `HTTP ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        throw err;
      }
      const chosen = parseHaikuChoice(json, placements);
      const answer = chosen ? chosen.id : JSON.stringify(json.content || json).slice(0, 60);
      const usage = json.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      return {
        chosen, // null when the reply named no valid option
        latencyMs,
        inputTokens,
        outputTokens,
        cost: inputTokens * HAIKU_PRICE.input + outputTokens * HAIKU_PRICE.output,
        note: chosen ? `picked ${answer}` : `invalid reply ${answer}`,
      };
    },
  };
}
