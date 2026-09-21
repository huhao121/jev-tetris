// Real-time Tetris battle: Jev vs Claude Haiku on one seeded piece sequence
// and one clock. Each side runs its own loop (see arena.js): the model is asked
// when a piece spawns, gravity keeps pulling the piece down meanwhile, and a
// piece that lands before the answer arrives locks where it is. Gravity
// strengthens on a shared schedule. In versus mode cleared lines become
// garbage for the opponent and the first to top out loses; with independent
// boards the survivor must outlast the loser's piece count.

import { createJevPlayer, createHaikuPlayer, createGeminiPlayer, createLayaPlayer, HAIKU_MODEL, GEMINI_MODEL } from "./players.js";
import {
  SPEEDUPS,
  PRESENT,
  sleep,
  formatClock,
  describeSpeedup,
  createRamp,
  makeSide,
  resetSide,
  previewSide,
  runModelSide,
  markTopOut,
  comparisonTable,
} from "./arena.js";

const $ = (id) => document.getElementById(id);
const STORAGE = { jev: "jev_tetris_api_key", haiku: "jev_tetris_anthropic_key", gemini: "jev_tetris_gemini_key", laya: "jev_tetris_laya_endpoint" };
const OPPONENTS = {
  haiku: { name: "Claude Haiku 4.5", short: "Haiku 4.5", badge: "haiku", label: `${HAIKU_MODEL} · Anthropic`, keyName: "Anthropic", create: (key) => createHaikuPlayer(key) },
  gemini: { name: "Gemini 3.8 Flash", short: "Gemini 3.8", badge: "gemini", label: `${GEMINI_MODEL} · Google`, keyName: "Gemini", create: (key) => createGeminiPlayer(key) },
  laya: { name: "Laya", short: "Laya", badge: "laya", label: "laya · local, open weights", keyName: "server address", create: (endpoint) => createLayaPlayer({ endpoint }) },
};

const ui = {
  jevKey: $("jevKey"),
  haikuKey: $("haikuKey"),
  geminiKey: $("geminiKey"),
  haikuKeyField: $("haikuKeyField"),
  geminiKeyField: $("geminiKeyField"),
  layaField: $("layaField"),
  layaNote: $("layaNote"),
  layaEndpoint: $("layaEndpoint"),
  opponent: $("opponent"),
  badgeR: $("badgeR"),
  modelR: $("modelR"),
  remember: $("remember"),
  gravity: $("gravity"),
  gravityLabel: $("gravityLabel"),
  speedup: $("speedup"),
  level: $("level"),
  seed: $("seed"),
  limit: $("limit"),
  lockstep: $("lockstep"),
  garbage: $("garbage"),
  start: $("start"),
  stop: $("stop"),
  clock: $("clock"),
  result: $("result"),
  error: $("error"),
  matchInfo: $("matchInfo"),
};

function sideEls(id) {
  return {
    canvas: $(`board${id}`),
    overlay: $(`overlay${id}`),
    incomingEl: $(`incoming${id}`),
    statsEl: $(`stats${id}`),
    moveEl: $(`move${id}`),
    section: $(id === "L" ? "left" : "right"),
  };
}

let sides = [];
let battle = null; // { ramp, abort, timer, limitMs, lockstep, garbage }

function gravityNow() {
  return battle ? battle.ramp.gravityNow() : Number(ui.gravity.value);
}

function renderLevel() {
  const level = battle ? battle.ramp.level() : 1;
  ui.level.textContent = `Level ${level} · ${gravityNow()} ms per row`;
  ui.level.classList.toggle("hot", level >= 4);
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.classList.remove("hidden");
}

function hideError() {
  ui.error.classList.add("hidden");
}

function topOut(side) {
  markTopOut(side, battle ? battle.ramp.elapsed() : 0);
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
    const loser = L.over ? L : R;
    const survivor = loser === L ? R : L;
    if (battle.garbage) {
      // Versus: the boards are coupled by garbage, so the first to top out loses.
      finish(survivor, loser, `${survivor.player.name} wins: ${loser.player.name} topped out first`);
      return;
    }
    // Independent boards: a fast player cycles through more pieces per minute, so
    // wall-clock survival would reward slowness; pieces survived is the clock.
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
  const elapsed = battle.ramp.elapsed();
  if (winner) {
    winner.section.classList.add("winner");
    loser?.section.classList.add("loser");
  }
  const gravityNote =
    (battle.lockstep ? "lockstep, no gravity" : `gravity ${battle.ramp.gravityMs} → ${gravityNow()} ms/row, level ${battle.ramp.level()}`) +
    (battle.garbage ? ", versus" : "");
  ui.result.innerHTML = `${reason}<small>${formatClock(elapsed)} elapsed · seed ${ui.seed.value} · ${gravityNote}</small>${comparisonTable(L, R)}`;
  ui.result.classList.remove("hidden");
  ui.start.disabled = false;
  ui.stop.disabled = true;
  document.body.classList.remove("running");
  document.body.classList.add("played");
  battle = null;
}

function opponentChoice() {
  const key = new URLSearchParams(location.search).get("opponent");
  if (key && OPPONENTS[key] && ui.opponent.value !== key) ui.opponent.value = key;
  return OPPONENTS[ui.opponent.value] || OPPONENTS.haiku;
}

function opponentKey() {
  const v = ui.opponent.value;
  return (v === "gemini" ? ui.geminiKey : v === "laya" ? ui.layaEndpoint : ui.haikuKey).value.trim();
}

function renderOpponent() {
  const opp = opponentChoice();
  ui.badgeR.textContent = opp.name;
  ui.badgeR.className = `badge ${opp.badge}`;
  ui.modelR.textContent = opp.label;
  const v = ui.opponent.value;
  ui.haikuKeyField.classList.toggle("hidden", v !== "haiku");
  ui.geminiKeyField.classList.toggle("hidden", v !== "gemini");
  ui.layaField.classList.toggle("hidden", v !== "laya");
  ui.layaNote.classList.toggle("hidden", v !== "laya");
  document.title = `Jev vs ${opp.name}`;
}

async function startBattle() {
  const jevKey = ui.jevKey.value.trim();
  const opp = opponentChoice();
  const oppKey = opponentKey();
  if (!jevKey || !oppKey) {
    showError(`Both keys are needed: a TypeSafe key for Jev and a ${opp.keyName} key for ${opp.name}.`);
    return;
  }
  hideError();
  persistKeys();
  const seed = Number(ui.seed.value) || 42;
  const gravityMs = Number(ui.gravity.value);
  const speedup = SPEEDUPS[ui.speedup.value] || SPEEDUPS.normal;
  const lockstep = ui.lockstep.checked;
  const garbage = ui.garbage.checked;
  const limitMs = Math.max(1, Number(ui.limit.value) || 5) * 60_000;
  sides = [makeSide("L", createJevPlayer(jevKey), sideEls("L")), makeSide("R", opp.create(oppKey), sideEls("R"))];
  sides[0].opponent = sides[1];
  sides[1].opponent = sides[0];
  for (const s of sides) resetSide(s, seed);
  ui.result.classList.add("hidden");
  ui.start.disabled = true;
  ui.stop.disabled = false;
  ui.matchInfo.textContent =
    (lockstep ? `seed ${seed} · lockstep, no gravity` : `seed ${seed} · ${gravityMs} ms per row, ${describeSpeedup(ui.speedup.value)}`) +
    (garbage ? " · cleared lines attack" : "");
  if (PRESENT) {
    document.body.classList.add("running");
    for (const n of [3, 2, 1]) {
      ui.clock.textContent = String(n);
      await sleep(800);
    }
  }
  const abort = new AbortController();
  battle = { ramp: createRamp({ gravityMs, speedup }), abort, timer: null, limitMs, lockstep, garbage };
  renderLevel();
  battle.timer = setInterval(() => {
    if (!battle) return;
    const elapsed = battle.ramp.elapsed();
    ui.clock.textContent = formatClock(elapsed);
    renderLevel();
    if (elapsed >= battle.limitMs) checkEnd(true);
  }, 250);
  const ctx = { signal: abort.signal, lockstep, gravityNow, garbage, onTopOut: topOut, onPiece: () => checkEnd(), showError };
  for (const s of sides) runModelSide(s, ctx);
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
      localStorage.setItem(STORAGE.gemini, ui.geminiKey.value.trim());
      localStorage.setItem(STORAGE.laya, ui.layaEndpoint.value.trim());
    } else {
      for (const k of Object.values(STORAGE)) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

ui.start.addEventListener("click", startBattle);
ui.stop.addEventListener("click", stopBattle);
ui.remember.addEventListener("change", persistKeys);
ui.opponent.addEventListener("change", () => {
  renderOpponent();
  if (!battle) sides[1].player = { name: opponentChoice().name, short: opponentChoice().short };
});
ui.gravity.addEventListener("input", () => {
  ui.gravityLabel.textContent = `${ui.gravity.value} ms per row`;
  if (!battle) renderLevel();
});
ui.gravityLabel.textContent = `${ui.gravity.value} ms per row`;
renderLevel();

try {
  const j = localStorage.getItem(STORAGE.jev);
  const h = localStorage.getItem(STORAGE.haiku);
  const g = localStorage.getItem(STORAGE.gemini);
  const l = localStorage.getItem(STORAGE.laya);
  if (j) ui.jevKey.value = j;
  if (h) ui.haikuKey.value = h;
  if (g) ui.geminiKey.value = g;
  if (l) ui.layaEndpoint.value = l;
  if (j || h || g) ui.remember.checked = true;
} catch {
  /* storage unavailable */
}

renderOpponent();
sides = [makeSide("L", { name: "Jev", short: "Jev" }, sideEls("L")), makeSide("R", { name: opponentChoice().name, short: opponentChoice().short }, sideEls("R"))];
for (const s of sides) previewSide(s, Number(ui.seed.value) || 42);
