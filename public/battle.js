// Real-time Tetris battle: Jev vs Claude Haiku on one seeded piece sequence
// and one clock. Each side runs its own loop (see arena.js): the model is asked
// when a piece spawns, gravity keeps pulling the piece down meanwhile, and a
// piece that lands before the answer arrives locks where it is. Gravity
// strengthens on a shared schedule. In versus mode cleared lines become
// garbage for the opponent and the first to top out loses; with independent
// boards the survivor must outlast the loser's piece count.

import { OPPONENTS, createJevPlayer, checkLayaServer } from "./players.js";
import {
  SPEEDUPS,
  PRESENT,
  STORAGE,
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
  judgeRound,
} from "./arena.js";

const $ = (id) => document.getElementById(id);
const ui = {
  jevKey: $("jevKey"),
  haikuKey: $("haikuKey"),
  geminiKey: $("geminiKey"),
  deepseekKey: $("deepseekKey"),
  haikuKeyField: $("haikuKeyField"),
  geminiKeyField: $("geminiKeyField"),
  deepseekKeyField: $("deepseekKeyField"),
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
  const verdict = judgeRound(sides[0], sides[1], { garbage: battle.garbage, timeUp });
  if (verdict) finish(verdict.winner, verdict.loser, verdict.reason);
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
  const winnerName = winner ? (winner.player.short || winner.player.name) : "平局";
  const loserName = loser ? (loser.player.short || loser.player.name) : "";
  const headerHtml = winner
    ? `<div style="font-size:22px;font-weight:850;color:#10b981;margin-bottom:6px;">🏆 ${winnerName} 赢了！</div>`
    : `<div style="font-size:20px;font-weight:800;color:#f59e0b;">时间到 · 双方打平</div>`;
  const reasonHtml = loser 
    ? `<div style="color:#ef4444;font-size:13px;font-weight:600;margin-bottom:8px;">${loserName} 思考太慢没跟上下落，在 ${formatClock(elapsed)} 顶格出局</div>` 
    : `<div style="color:var(--text-dim);font-size:13px;">${reason}</div>`;

  const gravityNote = (battle.lockstep ? "回合等待模式" : `重力递增至 ${gravityNow()} ms/格`) + (battle.garbage ? " · 垃圾行对抗" : "");
  
  ui.result.innerHTML = `
    ${headerHtml}
    ${reasonHtml}
    <small style="color:var(--muted);font-size:11px;">用时 ${formatClock(elapsed)} · 种子 ${ui.seed.value} · ${gravityNote}</small>
    ${comparisonTable(L, R)}
  `;
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
  if (v === "deepseek") return ui.deepseekKey.value.trim();
  if (v === "gemini") return ui.geminiKey.value.trim();
  if (v === "laya") return ui.layaEndpoint.value.trim();
  return ui.haikuKey.value.trim();
}

function renderOpponent() {
  const opp = opponentChoice();
  ui.badgeR.textContent = opp.name;
  ui.badgeR.className = `badge ${opp.badge}`;
  ui.modelR.textContent = opp.label;
  const v = ui.opponent.value;
  ui.haikuKeyField.classList.toggle("hidden", v !== "haiku");
  ui.geminiKeyField.classList.toggle("hidden", v !== "gemini");
  ui.deepseekKeyField.classList.toggle("hidden", v !== "deepseek");
  ui.layaField.classList.toggle("hidden", v !== "laya");
  ui.layaNote?.classList.toggle("hidden", v !== "laya");
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
  if (ui.opponent.value === "laya") {
    ui.start.disabled = true;
    try {
      const info = await checkLayaServer(oppKey);
      ui.modelR.textContent = `${info.model || "laya"} · ${info.runtime || "local"}`;
    } catch (err) {
      showError(`Laya: ${err.message}`);
      ui.start.disabled = false;
      return;
    }
  }
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
  if (ui.matchInfo) {
    ui.matchInfo.textContent =
      (lockstep ? `seed ${seed} · lockstep, no gravity` : `seed ${seed} · ${gravityMs} ms per row, ${describeSpeedup(ui.speedup.value)}`) +
      (garbage ? " · cleared lines attack" : "");
  }
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
      localStorage.setItem(STORAGE.deepseek, ui.deepseekKey?.value.trim() || "");
      localStorage.setItem(STORAGE.laya, ui.layaEndpoint?.value.trim() || "");
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
  const d = localStorage.getItem(STORAGE.deepseek);
  const l = localStorage.getItem(STORAGE.laya);
  if (j) ui.jevKey.value = j;
  if (h) ui.haikuKey.value = h;
  if (g) ui.geminiKey.value = g;
  if (d && ui.deepseekKey) ui.deepseekKey.value = d;
  if (l && ui.layaEndpoint) ui.layaEndpoint.value = l;
  if (j || h || g || d || l) ui.remember.checked = true;
} catch {
  /* storage unavailable */
}

renderOpponent();
sides = [makeSide("L", { name: "Jev", short: "Jev" }, sideEls("L")), makeSide("R", { name: opponentChoice().name, short: opponentChoice().short }, sideEls("R"))];
for (const s of sides) previewSide(s, Number(ui.seed.value) || 42);
