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

// ---- Gemini -------------------------------------------------------------------------
// Same prompt and option list as Haiku; the answer is a forced function call
// whose option_id is an enum of the offered placements.

export const GEMINI_MODEL = "gemini-3.8-flash";
// ai.google.dev/gemini-api/docs/pricing, paid tier through 2026-12-31: $0.75 in, $3.75 out (incl. thinking) per MTok.
export const GEMINI_PRICE = { input: 0.75 / 1e6, output: 3.75 / 1e6 };

const GEMINI_SYSTEM = [
  "You are playing Tetris in real time. Each turn you get the board and a list of every legal placement for the current piece, each described by its outcome.",
  "Pick the best placement. Good play: clear lines (more at once is better), never create holes unless every option does, keep the stack low and the surface flat, avoid several deep wells.",
  "The piece is falling while you think, so decide immediately by calling place_piece.",
].join(" ");

export function buildGeminiTool(placements) {
  return {
    functionDeclarations: [
      {
        name: "place_piece",
        description: "Choose where to drop the current piece by naming one option id from the options list.",
        parameters: {
          type: "OBJECT",
          properties: { option_id: { type: "STRING", enum: placements.map((p) => p.id) } },
          required: ["option_id"],
        },
      },
    ],
  };
}

export function parseGeminiChoice(response, placements) {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const id = part.functionCall?.name === "place_piece" ? part.functionCall.args?.option_id : null;
    if (id && byId.has(id)) return byId.get(id);
  }
  const text = parts.map((p) => p.text || "").join(" ");
  for (const m of text.match(/\bp\d+\b/g) || []) if (byId.has(m)) return byId.get(m);
  return null;
}

export function createGeminiPlayer(apiKey, { endpoint = "api/gemini", model = GEMINI_MODEL } = {}) {
  return {
    name: "Gemini 3.8 Flash",
    short: "Gemini 3.8",
    model,
    async decide(gameInfo, placements, signal) {
      const body = {
        model,
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: buildHaikuPrompt(gameInfo, placements) }] }],
        tools: [buildGeminiTool(placements)],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["place_piece"] } },
        generationConfig: { maxOutputTokens: 256, thinkingConfig: { thinkingLevel: "low" } },
      };
      const started = performance.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
        const err = new Error(json?.error?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const chosen = parseGeminiChoice(json, placements);
      const u = json.usageMetadata || {};
      const inputTokens = u.promptTokenCount || 0;
      const outputTokens = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
      return {
        chosen,
        latencyMs,
        inputTokens,
        outputTokens,
        cost: inputTokens * GEMINI_PRICE.input + outputTokens * GEMINI_PRICE.output,
        note: chosen ? `picked ${chosen.id}` : `invalid reply ${JSON.stringify(json.candidates?.[0]?.content || json).slice(0, 60)}`,
      };
    },
  };
}

// ---- Laya (local) ---------------------------------------------------------------------
// Laya is an open-weight typed-decision model (Convai Innovations; MLX port by
// mizorewww as laya-mlx). It runs on the visitor's machine behind
// tools/laya_server.py and answers the same TypeSafe-shaped request as Jev.
// Its context is small (512 tokens, with about 190 for the question and its
// options, at most 48 per option), so instead of Jev's Choice over every
// placement it gets a one-paragraph description of the board plus the top
// candidates pre-ranked by the classic heuristic in code, each described in a
// dozen words with the location first.

export const LAYA_DEFAULT_ENDPOINT = "http://localhost:8765";
export const LAYA_CANDIDATES = 6;

const PIECE_WORDS = { I: "an I bar", O: "an O square", T: "a T", S: "an S", Z: "a Z", J: "a J", L: "an L" };

export function describeBoardForLaya({ piece, nextPiece, stats }) {
  const holes = stats.holes === 0 ? "no holes" : `${describeHoles(stats.holes)}`.replace("three or more holes", "several holes");
  const wells = stats.wells.length === 1
    ? ` Column ${stats.wells[0].column + 1} is a deep well.`
    : stats.wells.length > 1
      ? ` There are ${stats.wells.length} deep wells.`
      : "";
  return (
    `Tetris. The stack is ${describeHeight(stats.maxHeight)} and ${describeSurface(stats.bumpiness)} with ${holes}.` +
    `${wells} The falling piece is ${PIECE_WORDS[piece] || piece}. Next piece: ${nextPiece}.`
  );
}

export function describePlacementForLaya(p) {
  const d = describePlacement(p);
  const xs = p.cells.map((c) => c[0]);
  const width = Math.max(...xs) - Math.min(...xs) + 1;
  const where = width === 1 ? `${d.where} vertical` : width === 4 ? `${d.where} flat` : d.where;
  const parts = [p.linesCleared ? `clears ${d.lines_cleared.replace(" (a Tetris)", "")}` : "no lines cleared"];
  parts.push(p.holesCreated ? `creates ${d.holes_created}` : "no holes");
  if (p.heightDelta >= 2) parts.push("stack grows by several rows");
  else if (p.heightDelta === 1) parts.push("stack grows by one row");
  else if (p.linesCleared > 0 && p.heightDelta < 0) parts.push("stack gets lower");
  else parts.push(`surface ${d.surface_after}`);
  return `${where}: ${parts.join(", ")}`;
}

export function buildLayaRequest(gameInfo, placements, limit = LAYA_CANDIDATES) {
  const candidates = placements.slice().sort((a, b) => b.heuristic - a.heuristic).slice(0, limit);
  const criteria = {};
  for (const p of candidates) criteria[p.id] = describePlacementForLaya(p);
  return {
    candidates,
    request: {
      state: describeBoardForLaya(gameInfo),
      model: "laya",
      questions: {
        placement: {
          type: "choice",
          instructions: "Pick the best placement: clear lines, avoid holes, keep the stack low and flat.",
          criteria,
        },
      },
    },
  };
}

// Checks that tools/laya_server.py (and not some other program) answers at
// the endpoint. Resolves to its /health payload, or throws a message that
// says what to do.
export async function checkLayaServer(endpoint) {
  const base = endpoint.replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
  } catch (err) {
    throw new Error(
      `Nothing answered at ${base} (${err.message}). Start the Laya server first: python tools/laya_server.py. ` +
        "If it is running, another program may own that port or the browser blocked the request; " +
        "the terminal running the server shows what it received.",
    );
  }
  let info = null;
  try {
    info = await res.json();
  } catch {
    info = null;
  }
  if (!res.ok || !info || info.ok !== true || !info.runtime) {
    throw new Error(
      `${base} answered, but not like tools/laya_server.py (HTTP ${res.status}). ` +
        "Another program is probably using that port: start the Laya server with --port 8766 and put http://localhost:8766 here.",
    );
  }
  return info;
}

export function createLayaPlayer({ endpoint = LAYA_DEFAULT_ENDPOINT, candidates = LAYA_CANDIDATES } = {}) {
  const base = endpoint.replace(/\/+$/, "");
  return {
    name: "Laya",
    short: "Laya",
    model: "laya (local)",
    endpoint: base,
    async decide(gameInfo, placements, signal) {
      const { candidates: shortlist, request } = buildLayaRequest(gameInfo, placements, candidates);
      if (shortlist.length === 1) {
        // Laya's choice head needs at least two options.
        return { chosen: shortlist[0], latencyMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, note: "only one option" };
      }
      const started = performance.now();
      const res = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
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
        const err = new Error(json?.detail?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const { chosen, confidence } = pickPlacement(json, shortlist);
      const usage = json.usage || {};
      return {
        chosen,
        latencyMs,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cost: 0, // local inference
        note: `confidence ${confidence.toFixed(2)}${json.inference_ms ? `, ${Math.round(json.inference_ms)} ms on the model` : ""}`,
      };
    },
  };
}

// ---- Opponent table for the battle and presentation pages -------------------------------
// `create(key)` takes the API key, or the server address for Laya.
export const OPPONENTS = {
  haiku: { name: "Claude Haiku 4.5", short: "Haiku 4.5", badge: "haiku", label: `${HAIKU_MODEL} · Anthropic`, keyName: "Anthropic", create: (key) => createHaikuPlayer(key) },
  gemini: { name: "Gemini 3.8 Flash", short: "Gemini 3.8", badge: "gemini", label: `${GEMINI_MODEL} · Google`, keyName: "Gemini", create: (key) => createGeminiPlayer(key) },
  laya: { name: "Laya", short: "Laya", badge: "laya", label: "laya · local, open weights", keyName: "server address", create: (endpoint) => createLayaPlayer({ endpoint }) },
};
