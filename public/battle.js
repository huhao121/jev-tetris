// Real-time Tetris battle: two players, one seeded piece sequence, one clock.
//
// Each side runs its own game loop. When a piece spawns, the player's model is
// asked at once; meanwhile gravity pulls the piece down one row every
// `gravityMs`. When the answer arrives, the piece slides to the chosen column
// and rotation (if it still fits at its current height) and hard-drops. If
// the piece lands before the answer arrives, it locks where it is: a missed
// deadline. Gravity strengthens on a shared schedule as the battle goes on,
// so the deadline tightens for both sides equally. When one side tops out,
// the other must survive past the same piece count to win (a faster player
// cycles pieces faster, so wall-clock survival would reward slowness); at
// the time limit, more lines wins.

import {
  WIDTH,
  HEIGHT,
  PIECES,
  PIECE_COLORS,
  emptyBoard,
  enumeratePlacements,
  lockPiece,
  clearLines,
  boardStats,
  collides,
  dropY,
  makeBag,
  seededRandom,
  scoreForLines,
  describePlacement,
} from "./tetris.js";
import { createJevPlayer, createHaikuPlayer } from "./players.js";

const $ = (id) => document.getElementById(id);
const SPEEDUPS = {
  none: { everyMs: Infinity, factor: 1 },
  gentle: { everyMs: 30_000, factor: 0.9 },
  normal: { everyMs: 20_000, factor: 0.85 },
  brutal: { everyMs: 10_000, factor: 0.8 },
};
const MIN_GRAVITY_MS = 40;
const STORAGE = { jev: "jev_tetris_api_key", haiku: "jev_tetris_anthropic_key" };
const SPAWN_X = 3;

const ui = {
  jevKey: $("jevKey"),
  haikuKey: $("haikuKey"),
  remember: $("remember"),
  gravity: $("gravity"),
  gravityLabel: $("gravityLabel"),
  speedup: $("speedup"),
  level: $("level"),
  seed: $("seed"),
  limit: $("limit"),
  lockstep: $("lockstep"),
  start: $("start"),
  stop: $("stop"),
  clock: $("clock"),
  result: $("result"),
  error: $("error"),
};

// ---- Per-player state ---------------------------------------------------------------

function makeSide(id, player) {
  const canvas = $(`board${id}`);
  return {
    id,
    player,
    canvas,
    ctx: canvas.getContext("2d"),
    cell: canvas.width / WIDTH,
    overlay: $(`overlay${id}`),
    statsEl: $(`stats${id}`),
    moveEl: $(`move${id}`),
    section: $(id === "L" ? "left" : "right"),
    board: emptyBoard(),
    random: null,
    bag: [],
    current: null,
    next: null,
    active: null, // { piece, rotation, x, y }
    target: null, // placement cells to outline once decided
    flash: [],
    lines: 0,
    pieces: 0,
    score: 0,
    over: false,
    lostAt: null,
    stats: { calls: 0, latency: 0, missed: 0, invalid: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0, clears: [0, 0, 0, 0, 0] },
  };
}

let sides = [];
let battle = null; // { startedAt, abort, timer, limitMs, gravityMs, speedup, lockstep }

// Level 1 at the start; one level up every `everyMs` of the shared clock.
function currentLevel() {
  if (!battle) return 1;
  const elapsed = performance.now() - battle.startedAt;
  return Number.isFinite(battle.speedup.everyMs) ? Math.floor(elapsed / battle.speedup.everyMs) + 1 : 1;
}

function gravityNow() {
  if (!battle) return Number(ui.gravity.value);
  const ms = battle.gravityMs * Math.pow(battle.speedup.factor, currentLevel() - 1);
  return Math.max(MIN_GRAVITY_MS, Math.round(ms));
}

function renderLevel() {
  const level = currentLevel();
  ui.level.textContent = `Level ${level} · ${gravityNow()} ms per row`;
  ui.level.classList.toggle("hot", level >= 4);
}

function nextPiece(side) {
  if (side.bag.length === 0) side.bag = makeBag(side.random);
  return side.bag.pop();
}

function resetSide(side, seed) {
  side.board = emptyBoard();
  side.random = seededRandom(seed);
  side.bag = [];
  side.current = nextPiece(side);
  side.next = nextPiece(side);
  side.active = null;
  side.target = null;
  side.flash = [];
  side.lines = 0;
  side.pieces = 0;
  side.score = 0;
  side.over = false;
  side.lostAt = null;
  side.stats = { calls: 0, latency: 0, missed: 0, invalid: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0, clears: [0, 0, 0, 0, 0] };
  side.overlay.classList.add("hidden");
  side.section.classList.remove("winner", "loser");
  side.moveEl.textContent = "Ready.";
  drawSide(side);
  renderSideStats(side);
}

// ---- Rendering ------------------------------------------------------------------------

function drawSide(side) {
  const { ctx, cell, canvas } = side;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 1; x < WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell, 0);
    ctx.lineTo(x * cell, canvas.height);
    ctx.stroke();
  }
  for (let y = 1; y < HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell);
    ctx.lineTo(canvas.width, y * cell);
    ctx.stroke();
  }
  const paint = (x, y, color, alpha = 1, outline = false) => {
    ctx.globalAlpha = alpha;
    if (outline) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, 3);
    }
    ctx.globalAlpha = 1;
  };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = side.board[y][x];
      if (c) paint(x, y, side.flash.includes(y) ? "#ffffff" : PIECE_COLORS[c]);
    }
  }
  if (side.target) for (const [x, y] of side.target) paint(x, y, "#ffffff", 0.7, true);
  if (side.active) {
    const { piece, rotation, x, y } = side.active;
    for (const [cx, cy] of PIECES[piece][rotation].cells) if (y + cy >= 0) paint(x + cx, y + cy, PIECE_COLORS[piece]);
  }
  // next piece preview in the top-right corner
  if (side.next) {
    const state = PIECES[side.next][0];
    const s = cell * 0.5;
    const ox = canvas.width - state.width * s - 6;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = PIECE_COLORS[side.next];
    for (const [cx, cy] of state.cells) ctx.fillRect(ox + cx * s, 6 + cy * s, s - 1, s - 1);
    ctx.globalAlpha = 1;
  }
}

function renderSideStats(side) {
  const s = side.stats;
  const avg = s.calls ? `${Math.round(s.latency / s.calls)} ms` : "–";
  const rows = [
    ["Lines", side.lines],
    ["Pieces", side.pieces],
    ["Score", side.score],
    ["Avg latency", avg],
    ["Missed", s.missed],
    ["Invalid", s.invalid + s.errors],
    ["Tokens in", s.inputTokens.toLocaleString()],
    ["Tokens out", s.outputTokens.toLocaleString()],
    ["Cost", `$${s.cost.toFixed(4)}`],
  ];
  side.statsEl.innerHTML = rows
    .map(([label, value]) => `<div class="stat"><span class="label">${label}</span><span>${value}</span></div>`)
    .join("");
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.classList.remove("hidden");
}

function hideError() {
  ui.error.classList.add("hidden");
}

function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- One player's real-time loop ------------------------------------------------------

async function runSide(side, { signal, lockstep }) {
  while (!side.over && !signal.aborted) {
    const piece = side.current;
    const spawn = PIECES[piece][0];
    if (collides(side.board, spawn.cells, SPAWN_X, 0)) {
      topOut(side);
      return;
    }
    const placements = enumeratePlacements(side.board, piece);
    if (placements.length === 0) {
      topOut(side);
      return;
    }
    side.active = { piece, rotation: 0, x: SPAWN_X, y: 0 };
    side.target = null;
    drawSide(side);

    // Ask the model right away; the piece falls while we wait.
    const gameInfo = { board: side.board, piece, nextPiece: side.next, stats: boardStats(side.board), linesCleared: side.lines };
    const askedAt = performance.now();
    let decision = null;
    let settled = false;
    const pending = side.player
      .decide(gameInfo, placements, signal)
      .then((d) => {
        decision = d;
      })
      .catch((err) => {
        if (!signal.aborted) {
          side.stats.errors += 1;
          side.moveEl.textContent = `Error: ${err.message}`;
          if (err.status === 401 || err.status === 403) showError(`${side.player.name}: ${err.message}`);
        }
      })
      .finally(() => {
        settled = true;
      });

    let outcome = null; // "decided" | "missed"
    if (lockstep) {
      await pending;
      outcome = decision ? "decided" : "missed";
    } else {
      // Gravity loop: one row per gravityNow() until the answer arrives or the piece lands.
      while (!signal.aborted) {
        if (settled) {
          outcome = decision ? "decided" : "missed";
          break;
        }
        await sleep(gravityNow());
        if (signal.aborted) return;
        if (settled) {
          outcome = decision ? "decided" : "missed";
          break;
        }
        const a = side.active;
        if (!collides(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y + 1)) {
          a.y += 1;
          drawSide(side);
        } else {
          outcome = "missed";
          break;
        }
      }
    }
    if (signal.aborted) return;

    const a = side.active;
    let landed;
    if (outcome === "decided" && decision.chosen) {
      side.stats.calls += 1;
      side.stats.latency += decision.latencyMs;
      side.stats.inputTokens += decision.inputTokens;
      side.stats.outputTokens += decision.outputTokens;
      side.stats.cost += decision.cost;
      const t = decision.chosen;
      const cells = PIECES[piece][t.rotation].cells;
      if (!collides(side.board, cells, t.x, a.y)) {
        // Slide into place quickly, then drop.
        side.target = t.cells;
        a.rotation = t.rotation;
        while (a.x !== t.x && !signal.aborted) {
          a.x += Math.sign(t.x - a.x);
          drawSide(side);
          await sleep(18);
        }
        const restY = dropY(side.board, cells, t.x, a.y);
        while (a.y < restY && !signal.aborted) {
          a.y += 1;
          drawSide(side);
          await sleep(10);
        }
        landed = { rotation: t.rotation, x: t.x, y: restY };
        const d = describePlacement(t);
        side.moveEl.textContent = `${piece} → ${d.where} in ${Math.round(decision.latencyMs)} ms (${decision.note})`;
      } else {
        // Answer came too late for the rotation to fit at this height: lock as is.
        side.stats.missed += 1;
        landed = { rotation: a.rotation, x: a.x, y: dropY(side.board, PIECES[piece][a.rotation].cells, a.x, a.y) };
        side.moveEl.textContent = `${piece}: answer arrived too late to fit (${Math.round(decision.latencyMs)} ms)`;
      }
    } else {
      if (outcome === "decided") {
        // Model replied but named no valid option.
        side.stats.calls += 1;
        side.stats.latency += decision.latencyMs;
        side.stats.inputTokens += decision.inputTokens;
        side.stats.outputTokens += decision.outputTokens;
        side.stats.cost += decision.cost;
        side.stats.invalid += 1;
        side.moveEl.textContent = `${piece}: ${decision.note}; piece dropped where it was`;
      } else if (!side.moveEl.textContent.startsWith("Error")) {
        side.stats.missed += 1;
        side.moveEl.textContent = `${piece}: no answer before landing (${Math.round(performance.now() - askedAt)} ms); locked in place`;
      } else {
        side.stats.missed += 1;
      }
      landed = { rotation: a.rotation, x: a.x, y: dropY(side.board, PIECES[piece][a.rotation].cells, a.x, a.y) };
    }
    if (signal.aborted) return;

    side.active = null;
    side.target = null;
    const locked = lockPiece(side.board, piece, landed.rotation, landed.x, landed.y);
    const { board, cleared, rows } = clearLines(locked);
    if (cleared > 0) {
      side.board = locked;
      side.flash = rows;
      drawSide(side);
      await sleep(90);
      side.flash = [];
    }
    side.board = board;
    side.lines += cleared;
    side.stats.clears[cleared] += 1;
    side.score += scoreForLines(cleared, Math.floor(side.lines / 10) + 1);
    side.pieces += 1;
    side.current = side.next;
    side.next = nextPiece(side);
    drawSide(side);
    renderSideStats(side);
    if (battle) checkEnd();
  }
}

function topOut(side) {
  side.over = true;
  side.lostAt = performance.now() - battle.startedAt;
  side.active = null;
  side.target = null;
  drawSide(side);
  side.overlay.textContent = `Topped out at ${formatClock(side.lostAt)}`;
  side.overlay.classList.remove("hidden");
  side.section.classList.add("loser");
  renderSideStats(side);
  checkEnd();
}

// ---- Battle control -----------------------------------------------------------------------

function checkEnd(timeUp = false) {
  if (!battle) return;
  const [L, R] = sides;
  const bothOver = L.over && R.over;
  const oneOver = L.over || R.over;
  if (!oneOver && !timeUp) return;
  if (oneOver && !bothOver && !timeUp) {
    // One side is out. A fast player cycles through more pieces per minute, so
    // wall-clock survival would reward slowness; pieces survived is the fair
    // clock in both modes. The survivor wins once it passes the loser's count.
    const loser = L.over ? L : R;
    const survivor = loser === L ? R : L;
    if (survivor.pieces > loser.pieces) {
      finish(survivor, loser, `${survivor.player.name} wins: survived past ${loser.pieces} pieces`);
    } else {
      loser.overlay.textContent = `Topped out at ${formatClock(loser.lostAt)} after ${loser.pieces} pieces · ${survivor.player.name} must pass ${loser.pieces}`;
    }
    return;
  }
  let winner = null;
  let loser = null;
  let reason;
  if (bothOver && L.pieces !== R.pieces) {
    winner = L.pieces > R.pieces ? L : R;
    loser = winner === L ? R : L;
    reason = `${winner.player.name} wins: lasted more pieces`;
  } else if (L.lines !== R.lines) {
    winner = L.lines > R.lines ? L : R;
    loser = winner === L ? R : L;
    reason = `${winner.player.name} wins on lines${timeUp ? " at the time limit" : ""}`;
  } else if (L.stats.missed !== R.stats.missed) {
    winner = L.stats.missed < R.stats.missed ? L : R;
    loser = winner === L ? R : L;
    reason = `${winner.player.name} wins on fewer missed deadlines`;
  } else {
    reason = timeUp ? "Draw at the time limit" : "Draw";
  }
  finish(winner, loser, reason);
}

function finish(winner, loser, reason) {
  const [L, R] = sides;
  battle.abort.abort();
  clearInterval(battle.timer);
  const elapsed = performance.now() - battle.startedAt;
  if (winner) {
    winner.section.classList.add("winner");
    loser?.section.classList.add("loser");
  }
  const line = (s) =>
    `${s.player.name}: ${s.lines} lines, ${s.pieces} pieces, avg ${s.stats.calls ? Math.round(s.stats.latency / s.stats.calls) : 0} ms, ${s.stats.missed} missed, $${s.stats.cost.toFixed(4)}`;
  const gravityNote = battle.lockstep
    ? "lockstep, no gravity"
    : `gravity ${battle.gravityMs} → ${gravityNow()} ms/row, reached level ${currentLevel()}`;
  ui.result.innerHTML = `${reason}<small>${formatClock(elapsed)} elapsed · seed ${ui.seed.value} · ${gravityNote}</small><small>${line(L)}</small><small>${line(R)}</small>`;
  ui.result.classList.remove("hidden");
  ui.start.disabled = false;
  ui.stop.disabled = true;
  battle = null;
}

function startBattle() {
  const jevKey = ui.jevKey.value.trim();
  const haikuKey = ui.haikuKey.value.trim();
  if (!jevKey || !haikuKey) {
    showError("Both keys are needed: a TypeSafe key for Jev and an Anthropic key for Claude Haiku.");
    return;
  }
  hideError();
  persistKeys();
  const seed = Number(ui.seed.value) || 42;
  const gravityMs = Number(ui.gravity.value);
  const speedup = SPEEDUPS[ui.speedup.value] || SPEEDUPS.normal;
  const lockstep = ui.lockstep.checked;
  const limitMs = Math.max(1, Number(ui.limit.value) || 5) * 60_000;
  sides = [makeSide("L", createJevPlayer(jevKey)), makeSide("R", createHaikuPlayer(haikuKey))];
  for (const s of sides) resetSide(s, seed);
  ui.result.classList.add("hidden");
  ui.start.disabled = true;
  ui.stop.disabled = false;
  const abort = new AbortController();
  battle = { startedAt: performance.now(), abort, timer: null, limitMs, gravityMs, speedup, lockstep };
  renderLevel();
  battle.timer = setInterval(() => {
    if (!battle) return;
    const elapsed = performance.now() - battle.startedAt;
    ui.clock.textContent = formatClock(elapsed);
    renderLevel();
    if (elapsed >= battle.limitMs) checkEnd(true);
  }, 250);
  for (const s of sides) runSide(s, { signal: abort.signal, lockstep });
}

function stopBattle() {
  if (!battle) return;
  checkEnd(true);
}

// ---- Keys and wiring -----------------------------------------------------------------------

function persistKeys() {
  try {
    if (ui.remember.checked) {
      localStorage.setItem(STORAGE.jev, ui.jevKey.value.trim());
      localStorage.setItem(STORAGE.haiku, ui.haikuKey.value.trim());
    } else {
      localStorage.removeItem(STORAGE.jev);
      localStorage.removeItem(STORAGE.haiku);
    }
  } catch {
    /* storage unavailable */
  }
}

ui.start.addEventListener("click", startBattle);
ui.stop.addEventListener("click", stopBattle);
ui.remember.addEventListener("change", persistKeys);
ui.gravity.addEventListener("input", () => {
  ui.gravityLabel.textContent = `${ui.gravity.value} ms per row`;
  if (!battle) renderLevel();
});
ui.gravityLabel.textContent = `${ui.gravity.value} ms per row`;
renderLevel();

try {
  const j = localStorage.getItem(STORAGE.jev);
  const h = localStorage.getItem(STORAGE.haiku);
  if (j) ui.jevKey.value = j;
  if (h) ui.haikuKey.value = h;
  if (j || h) ui.remember.checked = true;
} catch {
  /* storage unavailable */
}

sides = [makeSide("L", null), makeSide("R", null)];
for (const s of sides) {
  s.random = seededRandom(Number(ui.seed.value) || 42);
  s.current = nextPiece(s);
  s.next = nextPiece(s);
  drawSide(s);
  renderSideStats(s);
}
