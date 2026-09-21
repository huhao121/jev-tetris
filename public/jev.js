// Builds the TypeSafe request for one Tetris move and reads the answer.
//
// The model plays like a person at the keyboard: every request shows the
// board with the falling piece in it and asks for one move (left, right,
// rotate or drop). The state is only what a player sees, the board and
// the next piece; the options are only the controls (left, right, rotate,
// drop), each with a one-line hint of what it does. Code just leaves out moves
// that are blocked right now. Nothing about strategy is prescribed: the
// objective is the game's own.

import { boardWithPiece } from "./tetris.js";

export const MODEL = "jev-latest";

export const RULES =
  "Standard Tetris. The board is 10 columns wide and 20 rows tall. You control the falling piece one move at a time, like a player at the keyboard. " +
  "Gravity pulls the piece down one row at a time while you decide, and it locks shortly after it rests on the stack. " +
  "A full row disappears. The game is lost when the stack reaches the top.";

// The controls, as offered to the model. Blocked ones are left out per request.
export const CONTROLS = {
  left: "Move the piece one column to the left.",
  right: "Move the piece one column to the right.",
  rotate: "Rotate the piece clockwise.",
  drop: "Send the piece straight to the bottom right now and lock it there. Gravity is the only other way down.",
};

export const OBJECTIVE = [
  "Survive as long as possible and clear as many lines as possible.",
  "In versus mode every line you clear is pushed onto the opponent's board as a garbage row, and the first player whose stack reaches the top loses.",
  "The piece keeps falling while you think, so a move that is not made soon may stop being possible.",
];

export const STRATEGY_OPTIONS = {
  build_clean: "The stack is low and tidy. Keep building a flat surface and wait for a chance to clear several lines at once.",
  clear_lines: "Lines can be cleared soon. Take clears as they come and keep the stack from growing.",
  repair_surface: "The surface is jagged or has holes. Prefer placements that smooth it out or uncover holes, even without clearing lines.",
  survive: "The stack is close to the top. Take any placement that lowers or does not raise the stack, even if it is ugly.",
};

export const HEALTH_LEVELS = [
  "Clean: low, flat stack with no holes",
  "Fine: some unevenness or a hole or two, plenty of room",
  "Rough: several holes or a jagged surface, room is shrinking",
  "Critical: stack near the top, the game may be lost within a few pieces",
];

// stepInfo: { board, piece, state: { rotation, x, y }, nextPiece, linesCleared, versus }
export function buildState(stepInfo) {
  const { board, piece, state, nextPiece, linesCleared, versus } = stepInfo;
  return {
    game: {
      rules: RULES + (versus ? " This is a versus match: cleared lines attack the opponent." : ""),
      board_rows_top_to_bottom: boardWithPiece(board, piece, state),
      legend: "# is the stack, @ is the falling piece you control, . is empty. The first row is the top of the board.",
      falling_piece: piece,
      next_piece: nextPiece,
      lines_cleared_so_far: linesCleared,
    },
  };
}

export function buildQuestions(actions, { extras = false } = {}) {
  const criteria = {};
  for (const a of actions) criteria[a.id] = CONTROLS[a.id];
  const questions = {
    move: {
      type: "choice",
      instructions: {
        question: "Which move should the player make now with the falling piece (@) in `game.board_rows_top_to_bottom`? The options are the controls that work right now.",
        objective: OBJECTIVE,
      },
      criteria,
    },
  };
  if (extras) {
    questions.strategy = {
      type: "choice",
      instructions: "Looking at `game`, which strategy fits the current situation best for the next few pieces?",
      criteria: STRATEGY_OPTIONS,
    };
    questions.board_health = {
      type: "score",
      instructions: "How healthy is the stack in `game` for a Tetris player who wants to keep playing for a long time?",
      criteria: HEALTH_LEVELS,
    };
    questions.next_piece_fits = {
      type: "noul",
      instructions: "Looking at `game.board_rows_top_to_bottom`, is there an obvious clean spot for `game.next_piece`, without creating holes?",
      criteria: {
        true: "A clean spot is easy to see.",
        false: "The next piece will be awkward to place.",
      },
    };
  }
  return questions;
}

export function buildRequest(stepInfo, actions, options = {}) {
  return {
    state: buildState(stepInfo),
    model: MODEL,
    questions: buildQuestions(actions, options),
  };
}

const RETRY_STATUSES = new Set([429, 529]);

export class JevError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// Calls the local proxy (server.mjs), which forwards to api.typesafe.ai with
// the key in the Authorization header. Retries 429/529 with backoff.
export async function askJev(request, apiKey, { signal, maxAttempts = 4 } = {}) {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch("api/systemone", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });
    const latencyMs = performance.now() - started;
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (res.ok) return { response: body, latencyMs };
    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay;
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
      continue;
    }
    const message = body?.detail?.message || body?.error || body?.message || body?.raw || `HTTP ${res.status}`;
    throw new JevError(message, res.status, body);
  }
}

// Reads the Choice answer and maps it back onto the offered actions. `chosen`
// is null when the answer names nothing that was offered.
export function pickAction(response, actions) {
  const answer = response?.answers?.move;
  if (!answer || answer.type !== "choice") throw new JevError("Response has no move choice", 500, response);
  const byId = new Map(actions.map((a) => [a.id, a]));
  const ranked = Object.entries(answer.probabilities || {})
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, probability]) => ({ action: byId.get(id), probability }));
  const chosen = byId.get(answer.choice) || null;
  return { chosen, ranked, confidence: answer.confidence ?? 0 };
}
