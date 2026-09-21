import {
  WIDTH,
  HEIGHT,
  PIECES,
  PIECE_COLORS,
  emptyBoard,
  enumeratePlacements,
  enumerateActions,
  findPath,
  stepPiece,
  dropY,
  SPAWN_X,
  lockPiece,
  clearLines,
  boardStats,
  collides,
  makeBag,
  scoreForLines,
  describeAction,
} from "./tetris.js";
import { buildRequest, askJev, pickAction, JevError, STRATEGY_OPTIONS, HEALTH_LEVELS } from "./jev.js";

const $ = (id) => document.getElementById(id);
const PRICE_PER_TOKEN = 0.042 / 1_000_000; // $0.042 per million input tokens (docs.typesafe.ai/models)
const KEY_STORAGE = "jev_tetris_api_key";

// ---- DOM ------------------------------------------------------------------
const canvas = $("board");
const ctx = canvas.getContext("2d");
const nextCanvas = $("next");
const nextCtx = nextCanvas.getContext("2d");
const CELL = canvas.width / WIDTH;

const ui = {
  status: $("status"),
  overlay: $("overlay"),
  start: $("start"),
  pause: $("pause"),
  reset: $("reset"),
  speed: $("speed"),
  apiKey: $("apiKey"),
  toggleKey: $("toggleKey"),
  testKey: $("testKey"),
  remember: $("remember"),
  keyStatus: $("keyStatus"),
  score: $("score"),
  lines: $("lines"),
  level: $("level"),
  pieces: $("pieces"),
  calls: $("calls"),
  latency: $("latency"),
  tokens: $("tokens"),
  cost: $("cost"),
  agree: $("agree"),
  chosen: $("chosen"),
  decisionTitle: $("decisionTitle"),
  readsNote: $("readsNote"),
  alternatives: $("alternatives"),
  strategy: $("strategy"),
  healthFill: $("healthFill"),
  healthValue: $("healthValue"),
  healthLegend: $("healthLegend"),
  nextFitFill: $("nextFitFill"),
  nextFitValue: $("nextFitValue"),
  reqJson: $("reqJson"),
  resJson: $("resJson"),
  error: $("error"),
};

// ---- Game state -------------------------------------------------------------
const game = {
  board: emptyBoard(),
  bag: [],
  current: null,
  next: null,
  score: 0,
  lines: 0,
  pieces: 0,
  over: false,
  running: false,
  active: null, // { piece, rotation, x, y } while animating a drop
  ghosts: [], // [{ cells, probability, chosen }]
  flash: [], // row indexes being cleared
};

const stats = { calls: 0, latency: 0, tokens: 0, agreements: 0, decisions: 0 };

let abort = null;
let serverKeyConfigured = false;
// False when the page is served without its proxy (static hosting, file://).
// Jev mode needs the proxy because api.typesafe.ai rejects browser origins.
let backendAvailable = true;
const NO_BACKEND_MESSAGE =
  "This copy of the page has no proxy server, so it cannot reach api.typesafe.ai (the API blocks browser origins). " +
  "Run `npm start` locally or deploy the repo to get Jev mode. The built-in heuristic works here.";

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function nextPiece() {
  if (game.bag.length === 0) game.bag = makeBag();
  return game.bag.pop();
}

function resetGame() {
  game.board = emptyBoard();
  game.bag = [];
  game.current = nextPiece();
  game.next = nextPiece();
  game.score = 0;
  game.lines = 0;
  game.pieces = 0;
  game.over = false;
  game.active = null;
  game.ghosts = [];
  game.flash = [];
  Object.assign(stats, { calls: 0, latency: 0, tokens: 0, agreements: 0, decisions: 0 });
  ui.overlay.classList.add("hidden");
  ui.chosen.innerHTML = '<span class="muted">No move yet.</span>';
  ui.alternatives.innerHTML = "";
  ui.decisionTitle.textContent = "Jev's move";
  ui.readsNote.classList.add("hidden");
  renderReads(null);
  ui.reqJson.textContent = "–";
  ui.resJson.textContent = "–";
  hideError();
  renderStats();
  draw();
  drawNext();
}

// ---- Rendering ----------------------------------------------------------------
function drawCell(x, y, color, alpha = 1, outline = false) {
  const px = x * CELL;
  const py = y * CELL;
  ctx.globalAlpha = alpha;
  if (outline) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 2, py + 2, CELL - 4, CELL - 4);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(px + 1, py + 1, CELL - 2, 4);
  }
  ctx.globalAlpha = 1;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 1; x < WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, canvas.height);
    ctx.stroke();
  }
  for (let y = 1; y < HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(canvas.width, y * CELL);
    ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = game.board[y][x];
      if (c) drawCell(x, y, game.flash.includes(y) ? "#ffffff" : PIECE_COLORS[c]);
    }
  }
  for (const g of game.ghosts) {
    const color = g.chosen ? PIECE_COLORS[game.current] : "#ffffff";
    const alpha = g.chosen ? 0.9 : Math.max(0.15, Math.min(0.6, g.probability * 1.5));
    for (const [x, y] of g.cells) drawCell(x, y, color, alpha, true);
    if (!g.chosen && g.probability >= 0.05) {
      const [lx, ly] = g.cells.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a));
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#fff";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(`${Math.round(g.probability * 100)}%`, lx * CELL + 4, ly * CELL + 12);
      ctx.globalAlpha = 1;
    }
  }
  if (game.active) {
    const { piece, rotation, x, y } = game.active;
    for (const [cx, cy] of PIECES[piece][rotation].cells) {
      if (y + cy >= 0) drawCell(x + cx, y + cy, PIECE_COLORS[piece]);
    }
  }
}

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (!game.next) return;
  const state = PIECES[game.next][0];
  const size = 12;
  const ox = (nextCanvas.width - state.width * size) / 2;
  const oy = (nextCanvas.height - state.height * size) / 2;
  nextCtx.fillStyle = PIECE_COLORS[game.next];
  for (const [cx, cy] of state.cells) nextCtx.fillRect(ox + cx * size + 1, oy + cy * size + 1, size - 2, size - 2);
}

function renderStats() {
  ui.score.textContent = game.score;
  ui.lines.textContent = game.lines;
  ui.level.textContent = level();
  ui.pieces.textContent = game.pieces;
  ui.calls.textContent = stats.calls;
  ui.latency.textContent = stats.calls ? `${Math.round(stats.latency / stats.calls)} ms` : "–";
  ui.tokens.textContent = stats.tokens.toLocaleString();
  ui.cost.textContent = `$${(stats.tokens * PRICE_PER_TOKEN).toFixed(4)}`;
  ui.agree.textContent = stats.decisions ? `${Math.round((100 * stats.agreements) / stats.decisions)}%` : "–";
}

function level() {
  return Math.floor(game.lines / 10) + 1;
}

function setStatus(text, cls = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${cls}`;
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.classList.remove("hidden");
}

function hideError() {
  ui.error.classList.add("hidden");
}

function barRow(name, probability, chosen = false, fillClass = "") {
  const pct = Math.round(probability * 100);
  return `<div class="bar-row${chosen ? " chosen" : ""}">
    <span class="name" title="${name}">${name}</span>
    <div class="bar"><div class="bar-fill ${fillClass}" style="width:${Math.max(1, pct)}%"></div></div>
    <span class="bar-value">${probability.toFixed(2)}</span>
  </div>`;
}

const MOVE_LABELS = { left: "← left", right: "→ right", rotate: "↻ rotate", drop: "⤓ drop" };

function renderDecision(decision, source) {
  const { chosen, ranked, confidence } = decision;
  const d = describeAction(chosen);
  const conf = source === "jev" ? `confidence ${confidence.toFixed(2)}` : "code heuristic, no model call";
  ui.decisionTitle.textContent = source === "jev" ? "Jev's move" : "Heuristic's move";
  ui.readsNote.classList.toggle("hidden", source === "jev");
  ui.chosen.innerHTML = `<strong>${MOVE_LABELS[chosen.action]}</strong> · ${d.piece_after}
    <span class="muted">(${conf})</span>
    <div class="desc">
      <span>if dropped: <b>${d.landing.where}</b></span>
      <span>lines <b>${d.landing.lines_cleared}</b></span>
      <span>holes <b>${d.landing.holes_created}</b></span>
      <span>height <b>${d.landing.stack_height_after}</b></span>
      <span>surface <b>${d.landing.surface_after}</b></span>
    </div>`;
  ui.alternatives.innerHTML = ranked
    .map((r) => barRow(`${MOVE_LABELS[r.action.action]} · lands ${describeAction(r.action).landing.where}`, r.probability, r.action === chosen))
    .join("");
}

function renderReads(answers) {
  if (!answers) {
    ui.strategy.innerHTML = Object.keys(STRATEGY_OPTIONS).map((k) => barRow(k.replaceAll("_", " "), 0)).join("");
    ui.healthFill.style.left = "0%";
    ui.healthValue.textContent = "";
    ui.healthLegend.innerHTML = HEALTH_LEVELS.map((l) => `<span>${l.split(":")[0]}</span>`).join("");
    ui.nextFitFill.style.width = "0%";
    ui.nextFitValue.textContent = "";
    return;
  }
  const strategy = answers.strategy;
  if (strategy?.probabilities) {
    ui.strategy.innerHTML = Object.entries(strategy.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => barRow(k.replaceAll("_", " "), p, k === strategy.choice))
      .join("");
  }
  const health = answers.board_health;
  if (typeof health?.score === "number") {
    const max = HEALTH_LEVELS.length - 1;
    ui.healthFill.style.left = `calc(${(100 * health.score) / max}% - 2px)`;
    const nearest = HEALTH_LEVELS[Math.round(health.score)] || "";
    ui.healthValue.textContent = `${health.score.toFixed(2)} · ${nearest.split(":")[0]}`;
  }
  const fit = answers.next_piece_fits;
  if (typeof fit?.noul === "number") {
    ui.nextFitFill.style.width = `${Math.round(fit.noul * 100)}%`;
    ui.nextFitValue.textContent = fit.noul.toFixed(2);
  }
}

// ---- Deciding -------------------------------------------------------------------
// The code player picks the best resting spot by the classic heuristic when a
// piece spawns and then plays the moves that get there, one per step, so it
// goes through the same left/right/rotate/down/drop interface as Jev.
let heuristicPlan = null; // { piece, target, path }

function heuristicNextMove(actions) {
  const a = game.active;
  if (!heuristicPlan || heuristicPlan.piece !== game.pieces) {
    // Without a soft drop only straight drops are playable, so plan among those.
    const placements = enumeratePlacements(game.board, game.current).filter((p) => p.how === "drop");
    const target = placements.slice().sort((x, y) => y.heuristic - x.heuristic)[0];
    heuristicPlan = { piece: game.pieces, target };
  }
  const t = heuristicPlan.target;
  const path = t ? findPath(game.board, game.current, a, { rotation: t.rotation, x: t.x, y: t.y }) : null;
  // Play the sideways and rotation moves first, then drop.
  let move = path ? path.find((m) => m !== "down") || "drop" : "drop";
  if (move === "rotateCw" || move === "rotateCcw") move = "rotate"; // the player interface only rotates one way; three turns follow if needed
  const byId = new Map(actions.map((x) => [x.id, x]));
  const chosen = byId.get(move) || byId.get("drop") || actions[0];
  const ranked = actions.map((x) => ({ action: x, probability: x === chosen ? 1 : 0 }));
  return { chosen, ranked, confidence: 1 };
}

function stepInfo(actions) {
  const a = game.active;
  return {
    board: game.board,
    piece: game.current,
    state: { rotation: a.rotation, x: a.x, y: a.y },
    nextPiece: game.next,
    stats: boardStats(game.board),
    linesCleared: game.lines,
    rowsToFall: dropY(game.board, PIECES[game.current][a.rotation].cells, a.x, a.y) - a.y,
    actionsCount: actions.length,
  };
}

async function jevDecision(actions, signal) {
  const request = buildRequest(stepInfo(actions), actions, { extras: true });
  ui.reqJson.textContent = JSON.stringify(request, null, 2);
  setStatus(`Asking Jev for the next move with the ${game.current} (${actions.length} options)…`, "thinking");
  const { response, latencyMs } = await askJev(request, currentKey(), { signal });
  ui.resJson.textContent = JSON.stringify(response, null, 2);
  stats.calls += 1;
  stats.latency += latencyMs;
  stats.tokens += response?.usage?.input_tokens || 0;
  renderReads(response.answers);
  return pickAction(response, actions);
}

// ---- Animating --------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stepDelay() {
  // slider 1..10 → 220ms..10ms per animation step
  const v = Number(ui.speed.value);
  return Math.round(240 - v * 23);
}

const MAX_MOVES_PER_PIECE = 60;

async function playLoop(signal) {
  while (game.running && !game.over && !signal.aborted) {
    if (collides(game.board, PIECES[game.current][0].cells, SPAWN_X, 0)) {
      endGame();
      return;
    }
    game.active = { piece: game.current, rotation: 0, x: SPAWN_X, y: 0 };
    game.ghosts = [];
    draw();
    let moves = 0;
    let locked = false;
    while (!locked && game.running && !signal.aborted) {
      const a = game.active;
      const actions = enumerateActions(game.board, game.current, a);
      const heuristic = heuristicNextMove(actions);
      let decision;
      const source = mode();
      if (source === "jev") {
        try {
          decision = await jevDecision(actions, signal);
        } catch (err) {
          if (signal.aborted) return;
          handleJevError(err);
          pause();
          return;
        }
        if (!decision.chosen) {
          setStatus("Jev named no valid move; dropping the piece.", "error");
          decision = { ...decision, chosen: actions.find((x) => x.id === "drop") || actions[0] };
        }
      } else {
        decision = heuristic;
        await sleep(stepDelay());
        setStatus(`Heuristic plays the ${game.current}: ${decision.chosen.action}`);
      }
      if (signal.aborted) return;
      stats.decisions += 1;
      if (decision.chosen === heuristic.chosen) stats.agreements += 1;
      renderDecision(decision, source);
      renderStats();
      hideError();
      moves += 1;
      const move = decision.chosen.action;
      if (move === "drop" || moves >= MAX_MOVES_PER_PIECE) {
        a.y = dropY(game.board, PIECES[game.current][a.rotation].cells, a.x, a.y);
        locked = true;
      } else {
        const next = stepPiece(game.board, game.current, a, move === "rotate" ? "rotateCw" : move);
        if (next) {
          a.rotation = next.rotation;
          a.x = next.x;
          a.y = next.y;
        }
      }
      // Ghost: where the piece lands if dropped from here.
      const gy = dropY(game.board, PIECES[game.current][a.rotation].cells, a.x, a.y);
      game.ghosts = [{ cells: PIECES[game.current][a.rotation].cells.map(([cx, cy]) => [a.x + cx, gy + cy]), probability: 1, chosen: true }];
      draw();
      if (source === "jev") await sleep(Math.min(stepDelay(), 120));
    }
    if (signal.aborted || !game.running) return;

    const a = game.active;
    game.active = null;
    game.ghosts = [];
    const locked2 = lockPiece(game.board, game.current, a.rotation, a.x, a.y);
    const { board, cleared, rows } = clearLines(locked2);
    if (cleared > 0) {
      game.board = locked2;
      game.flash = rows;
      draw();
      await sleep(Math.max(80, stepDelay() * 1.5));
      game.flash = [];
    }
    game.board = board;
    game.score += scoreForLines(cleared, level());
    game.lines += cleared;
    game.pieces += 1;
    game.current = game.next;
    game.next = nextPiece();
    renderStats();
    draw();
    drawNext();
  }
}

function endGame() {
  game.over = true;
  game.running = false;
  ui.overlay.textContent = `Game over · ${game.lines} lines · ${game.score} points`;
  ui.overlay.classList.remove("hidden");
  setStatus("Game over. Press Reset to play again.");
  ui.start.disabled = true;
  ui.pause.disabled = true;
}

function handleJevError(err) {
  if (err instanceof JevError) {
    if (err.status === 401 || err.status === 403) {
      showError(`TypeSafe rejected the key: ${err.message}`);
      setKeyStatus("Key rejected.", false);
    } else if (err.status === 429) {
      showError("Rate limited by TypeSafe even after retries. Wait a moment, then press Start.");
    } else if (err.status === 422) {
      showError(`TypeSafe rejected the request (422): ${JSON.stringify(err.detail)}`);
    } else {
      showError(`Jev call failed (${err.status}): ${err.message}`);
    }
  } else {
    showError(`Jev call failed: ${err.message}`);
  }
  setStatus("Paused after an error.", "error");
}

// ---- Controls -----------------------------------------------------------------------
function start() {
  if (game.over) return;
  if (mode() === "jev" && !backendAvailable) {
    showError(NO_BACKEND_MESSAGE);
    return;
  }
  if (mode() === "jev" && !currentKey() && !serverKeyConfigured) {
    showError("Enter your TypeSafe API key first, or switch to the built-in heuristic.");
    ui.apiKey.focus();
    return;
  }
  hideError();
  game.running = true;
  ui.start.disabled = true;
  ui.pause.disabled = false;
  abort = new AbortController();
  playLoop(abort.signal).finally(() => {
    if (!game.over) {
      ui.start.disabled = false;
      ui.pause.disabled = true;
    }
  });
}

function pause() {
  game.running = false;
  abort?.abort();
  abort = null;
  ui.start.disabled = game.over;
  ui.pause.disabled = true;
  if (!game.over) setStatus(ui.status.classList.contains("error") ? ui.status.textContent : "Paused.");
}

function reset() {
  pause();
  resetGame();
  ui.start.disabled = false;
  ui.start.textContent = "Start";
  setStatus(mode() === "jev" ? "Ready. Press Start and Jev takes over." : "Ready. Press Start for the built-in heuristic.");
}

// ---- API key ------------------------------------------------------------------------
function currentKey() {
  return ui.apiKey.value.trim();
}

function setKeyStatus(text, ok) {
  ui.keyStatus.textContent = text;
  ui.keyStatus.className = `key-status ${ok ? "ok" : "bad"}`;
}

function persistKey() {
  try {
    if (ui.remember.checked && currentKey()) localStorage.setItem(KEY_STORAGE, currentKey());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

async function testKey() {
  if (!backendAvailable) {
    setKeyStatus("No proxy server here; see the message under Start.", false);
    showError(NO_BACKEND_MESSAGE);
    return;
  }
  if (!currentKey() && !serverKeyConfigured) {
    setKeyStatus("Enter a key first.", false);
    return;
  }
  ui.testKey.disabled = true;
  setKeyStatus("Checking…", true);
  try {
    const res = await fetch("api/models", { headers: { Authorization: `Bearer ${currentKey()}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.detail?.message || `HTTP ${res.status}`);
    const names = (body.models || []).map((m) => m.name).join(", ");
    setKeyStatus(`Key works. Models: ${names || "listed"}`, true);
    persistKey();
  } catch (err) {
    setKeyStatus(`Key check failed: ${err.message}`, false);
  } finally {
    ui.testKey.disabled = false;
  }
}

// ---- Wiring ---------------------------------------------------------------------------
ui.start.addEventListener("click", start);
ui.pause.addEventListener("click", pause);
ui.reset.addEventListener("click", reset);
ui.testKey.addEventListener("click", testKey);
ui.toggleKey.addEventListener("click", () => {
  ui.apiKey.type = ui.apiKey.type === "password" ? "text" : "password";
});
ui.apiKey.addEventListener("change", persistKey);
ui.remember.addEventListener("change", persistKey);
document.querySelectorAll('input[name="mode"]').forEach((el) =>
  el.addEventListener("change", () => {
    if (!game.running && !game.over) {
      setStatus(mode() === "jev" ? "Ready. Press Start and Jev takes over." : "Ready. Press Start for the built-in heuristic.");
    }
  }),
);
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === " ") {
    e.preventDefault();
    if (game.running) pause();
    else start();
  }
});

try {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (saved) {
    ui.apiKey.value = saved;
    ui.remember.checked = true;
  }
} catch {
  /* storage unavailable */
}
function markNoBackend() {
  backendAvailable = false;
  document.querySelector('input[name="mode"][value="heuristic"]').checked = true;
  setStatus("Preview without a proxy server: the heuristic plays. Press Start.");
  ui.apiKey.placeholder = "Jev mode needs the proxy server (npm start)";
}

fetch("api/config", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((cfg) => {
    serverKeyConfigured = Boolean(cfg.serverKeyConfigured);
    if (serverKeyConfigured) ui.apiKey.placeholder = "host key configured; leave blank to use it";
  })
  .catch(markNoBackend);

resetGame();
setStatus("Enter your TypeSafe API key and press Start.");
