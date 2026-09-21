// The contestants of the battle page. Each player gets identical information
// (the board with the falling piece, and the moves possible right now, each
// described by its outcome) and must return one move id. All go through the
// local proxy in server.mjs except Laya, which runs on the visitor's machine.

import { describeAction, boardWithPiece, describeHeight, describeHoles, describeSurface, describeFall, PIECES } from "./tetris.js";
import { buildRequest, askJev, pickAction, RULES, OBJECTIVE } from "./jev.js";

export const JEV_PRICE = { input: 0.042 / 1e6, output: 0 };
export const HAIKU_MODEL = "claude-haiku-4-5";
export const HAIKU_PRICE = { input: 1 / 1e6, output: 5 / 1e6 }; // $1 / $5 per MTok

// ---- Jev ----------------------------------------------------------------------

export function createJevPlayer(apiKey) {
  return {
    name: "Jev",
    short: "Jev",
    model: "jev-latest",
    async act(stepInfo, actions, signal) {
      const request = buildRequest(stepInfo, actions);
      const { response, latencyMs } = await askJev(request, apiKey, { signal, maxAttempts: 2 });
      const { chosen, confidence } = pickAction(response, actions);
      const usage = response.usage || {};
      return {
        chosen,
        latencyMs,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cost: (usage.input_tokens || 0) * JEV_PRICE.input,
        note: chosen ? `confidence ${confidence.toFixed(2)}` : `invalid reply ${JSON.stringify(response.answers?.move?.choice)}`,
      };
    },
  };
}

// ---- Shared prompt for the chat models ------------------------------------------
// The same facts Jev gets, as one JSON document, plus the same objective.

const CHAT_SYSTEM = [
  "You are playing Tetris in real time, one move at a time, like a player at the keyboard.",
  RULES,
  ...OBJECTIVE,
  "Each turn you get the board with the falling piece marked @ and the moves possible right now, each described by where the piece would be afterwards and what the board would look like if it were dropped from there.",
  "Decide immediately by calling the make_move tool with one of the offered move ids.",
].join(" ");

export function buildChatPrompt(stepInfo, actions) {
  const { board, piece, state, nextPiece, stats, linesCleared, rowsToFall } = stepInfo;
  const options = {};
  for (const a of actions) options[a.id] = describeAction(a);
  return JSON.stringify(
    {
      board_rows_top_to_bottom: boardWithPiece(board, piece, state),
      legend: "# stack, @ falling piece, . empty",
      column_heights_left_to_right: stats.heights,
      stack_height: describeHeight(stats.maxHeight),
      holes_in_stack: describeHoles(stats.holes),
      surface: describeSurface(stats.bumpiness),
      falling_piece: { shape: piece, fall: describeFall(rowsToFall), rotation: `${state.rotation + 1} of ${PIECES[piece].length}` },
      next_piece: nextPiece,
      lines_cleared_so_far: linesCleared,
      moves: options,
    },
    null,
    0,
  );
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Claude Haiku ---------------------------------------------------------------
// Forced tool call with an enum of the move ids: the answer is always one of
// the offered moves, just as Jev's Choice is constrained to them.

export function buildHaikuTool(actions) {
  return {
    name: "make_move",
    description: "Make one move with the falling piece by naming one move id from the moves list.",
    input_schema: {
      type: "object",
      properties: { move: { type: "string", enum: actions.map((a) => a.id) } },
      required: ["move"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export function parseHaikuChoice(message, actions) {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "make_move" && byId.has(b.input?.move)) return byId.get(b.input.move);
  }
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").toLowerCase();
  for (const id of byId.keys()) if (new RegExp(`\\b${id}\\b`).test(text)) return byId.get(id);
  return null;
}

export function createHaikuPlayer(apiKey, { endpoint = "api/anthropic" } = {}) {
  return {
    name: "Claude Haiku 4.5",
    short: "Haiku 4.5",
    model: HAIKU_MODEL,
    async act(stepInfo, actions, signal) {
      const body = {
        model: HAIKU_MODEL,
        max_tokens: 64,
        system: CHAT_SYSTEM,
        tools: [buildHaikuTool(actions)],
        tool_choice: { type: "tool", name: "make_move" },
        messages: [{ role: "user", content: buildChatPrompt(stepInfo, actions) }],
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
      const json = readJson(text);
      if (!res.ok) {
        const err = new Error(json?.error?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const chosen = parseHaikuChoice(json, actions);
      const usage = json.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      return {
        chosen, // null when the reply named no valid move
        latencyMs,
        inputTokens,
        outputTokens,
        cost: inputTokens * HAIKU_PRICE.input + outputTokens * HAIKU_PRICE.output,
        note: chosen ? `picked ${chosen.id}` : `invalid reply ${JSON.stringify(json.content || json).slice(0, 60)}`,
      };
    },
  };
}

// ---- Gemini -------------------------------------------------------------------------
// Same prompt and move list as Haiku; the answer is a forced function call
// whose move is an enum of the offered ids.

export const GEMINI_MODEL = "gemini-3.8-flash";
// ai.google.dev/gemini-api/docs/pricing, paid tier through 2026-12-31: $0.75 in, $3.75 out (incl. thinking) per MTok.
export const GEMINI_PRICE = { input: 0.75 / 1e6, output: 3.75 / 1e6 };

export function buildGeminiTool(actions) {
  return {
    functionDeclarations: [
      {
        name: "make_move",
        description: "Make one move with the falling piece by naming one move id from the moves list.",
        parameters: {
          type: "OBJECT",
          properties: { move: { type: "STRING", enum: actions.map((a) => a.id) } },
          required: ["move"],
        },
      },
    ],
  };
}

export function parseGeminiChoice(response, actions) {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const id = part.functionCall?.name === "make_move" ? part.functionCall.args?.move : null;
    if (id && byId.has(id)) return byId.get(id);
  }
  const text = parts.map((p) => p.text || "").join(" ").toLowerCase();
  for (const id of byId.keys()) if (new RegExp(`\\b${id}\\b`).test(text)) return byId.get(id);
  return null;
}

export function createGeminiPlayer(apiKey, { endpoint = "api/gemini", model = GEMINI_MODEL } = {}) {
  return {
    name: "Gemini 3.8 Flash",
    short: "Gemini 3.8",
    model,
    async act(stepInfo, actions, signal) {
      const body = {
        model,
        systemInstruction: { parts: [{ text: CHAT_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: buildChatPrompt(stepInfo, actions) }] }],
        tools: [buildGeminiTool(actions)],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["make_move"] } },
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
      const json = readJson(text);
      if (!res.ok) {
        const err = new Error(json?.error?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const chosen = parseGeminiChoice(json, actions);
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
// Its context is small (512 tokens, about 190 for the question and its
// options, at most 48 per option), so it gets a one-paragraph description of
// the board and the same five moves described in a dozen words each.

export const LAYA_DEFAULT_ENDPOINT = "http://localhost:8765";

const PIECE_WORDS = { I: "an I bar", O: "an O square", T: "a T", S: "an S", Z: "a Z", J: "a J", L: "an L" };

export function describeBoardForLaya({ piece, nextPiece, stats, rowsToFall, state }) {
  const holes = stats.holes === 0 ? "no holes" : `${describeHoles(stats.holes)}`.replace("three or more holes", "several holes");
  const xs = PIECES[piece][state.rotation].cells.map(([cx]) => state.x + cx + 1);
  const span = Math.min(...xs) === Math.max(...xs) ? `column ${xs[0]}` : `columns ${Math.min(...xs)}-${Math.max(...xs)}`;
  return (
    `Tetris. The stack is ${describeHeight(stats.maxHeight)} and ${describeSurface(stats.bumpiness)} with ${holes}. ` +
    `The falling piece is ${PIECE_WORDS[piece] || piece} in ${span}, ${describeFall(rowsToFall)}. Next piece: ${nextPiece}.`
  );
}

export function describeActionForLaya(a) {
  const d = describeAction(a);
  const l = a.landing;
  const parts = [l.linesCleared ? `clears ${d.landing.lines_cleared.replace(" (a Tetris)", "")}` : "no lines cleared"];
  parts.push(l.holesCreated ? `creates ${d.landing.holes_created}` : "no holes");
  if (l.heightDelta >= 2) parts.push("stack grows by several rows");
  else if (l.heightDelta === 1) parts.push("stack grows by one row");
  else if (l.linesCleared > 0 && l.heightDelta < 0) parts.push("stack gets lower");
  else parts.push(`surface ${d.landing.surface_after}`);
  const verb = a.action === "drop" ? "drop now" : a.action === "rotate" ? "rotate" : `move ${a.action}`;
  return `${verb}, lands ${d.landing.where}: ${parts.join(", ")}`;
}

export function buildLayaRequest(stepInfo, actions) {
  const criteria = {};
  for (const a of actions) criteria[a.id] = describeActionForLaya(a);
  return {
    state: describeBoardForLaya(stepInfo),
    model: "laya",
    questions: {
      move: {
        type: "choice",
        instructions: "Pick the next move for the falling piece. Aim to survive and clear lines.",
        criteria,
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
  const info = readJson(await res.text());
  if (!res.ok || !info || info.ok !== true || !info.runtime) {
    throw new Error(
      `${base} answered, but not like tools/laya_server.py (HTTP ${res.status}). ` +
        "Another program is probably using that port: start the Laya server with --port 8766 and put http://localhost:8766 here.",
    );
  }
  return info;
}

export function createLayaPlayer({ endpoint = LAYA_DEFAULT_ENDPOINT } = {}) {
  const base = endpoint.replace(/\/+$/, "");
  return {
    name: "Laya",
    short: "Laya",
    model: "laya (local)",
    endpoint: base,
    async act(stepInfo, actions, signal) {
      if (actions.length === 1) {
        // Laya's choice head needs at least two options.
        return { chosen: actions[0], latencyMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, note: "only one move" };
      }
      const request = buildLayaRequest(stepInfo, actions);
      const started = performance.now();
      const res = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      const latencyMs = performance.now() - started;
      const text = await res.text();
      const json = readJson(text);
      if (!res.ok) {
        const err = new Error(json?.detail?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const { chosen, confidence } = pickAction(json, actions);
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
