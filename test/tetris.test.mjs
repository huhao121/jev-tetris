import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEIGHT,
  WIDTH,
  PIECES,
  PIECE_NAMES,
  emptyBoard,
  enumeratePlacements,
  clearLines,
  countHoles,
  columnHeights,
  describePlacement,
  enumerateActions,
  boardStats,
  SPAWN_X,
  makeBag,
} from "../public/tetris.js";
import * as engine from "../public/tetris.js";
import { buildRequest, pickAction } from "../public/jev.js";

function boardFrom(rows) {
  // rows: bottom-most last, strings of '#' and '.', padded to HEIGHT at the top
  const board = emptyBoard();
  const offset = HEIGHT - rows.length;
  rows.forEach((row, i) => {
    for (let x = 0; x < WIDTH; x++) board[offset + i][x] = row[x] === "#" ? "X" : null;
  });
  return board;
}

test("every piece has 4 cells in every rotation", () => {
  for (const name of PIECE_NAMES) {
    for (const state of PIECES[name]) assert.equal(state.cells.length, 4, name);
  }
});

test("enumeratePlacements on an empty board covers every column", () => {
  const board = emptyBoard();
  const o = enumeratePlacements(board, "O");
  assert.equal(o.length, WIDTH - 1); // 9 distinct positions for a 2-wide block
  const i = enumeratePlacements(board, "I");
  assert.equal(i.length, 7 + 10); // 7 horizontal + 10 vertical
  const t = enumeratePlacements(board, "T");
  assert.equal(t.length, 2 * 8 + 2 * 9); // two 3-wide and two 2-wide rotations
  for (const p of [...o, ...i]) assert.equal(p.holesCreated, 0);
  // A T pointing down rests on its stem and covers two cells: real holes.
  const stemDown = t.find((p) => p.rotation === 2 && p.x === 0);
  assert.equal(stemDown.holesCreated, 2);
  for (const p of [...o, ...i, ...t]) {
    assert.equal(p.linesCleared, 0);
    for (const [x, y] of p.cells) {
      assert.ok(x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT);
    }
  }
});

test("an I piece dropped into a well clears four lines", () => {
  const rows = ["#########.", "#########.", "#########.", "#########."];
  const board = boardFrom(rows);
  const placements = enumeratePlacements(board, "I");
  const tetris = placements.find((p) => p.linesCleared === 4);
  assert.ok(tetris, "expected a four-line clear");
  assert.equal(tetris.x, 9);
  assert.equal(tetris.after.maxHeight, 0);
  assert.equal(describePlacement(tetris).lines_cleared, "four lines (a Tetris)");
  assert.equal(describePlacement(tetris).holes_created, "none");
});

test("holes are counted and reported when a placement covers a gap", () => {
  const board = boardFrom(["##..######"]);
  const placements = enumeratePlacements(board, "O");
  const covering = placements.find((p) => p.x === 1);
  assert.ok(covering);
  assert.equal(covering.holesCreated, 1); // O at x=1 rests on column 1, column 2 stays empty underneath
  assert.equal(describePlacement(covering).holes_created, "one hole");
  const clean = placements.find((p) => p.x === 2);
  assert.equal(clean.holesCreated, 0);
  assert.equal(clean.linesCleared, 1);
});

test("clearLines removes full rows and keeps the board height", () => {
  const board = boardFrom(["##########", "#....#####", "##########"]);
  const { board: after, cleared, rows } = clearLines(board);
  assert.equal(cleared, 2);
  assert.deepEqual(rows, [17, 19]);
  assert.equal(after.length, HEIGHT);
  assert.equal(countHoles(after), 0);
  assert.deepEqual(columnHeights(after), [1, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
});

test("no placements when the piece cannot spawn", () => {
  const rows = Array.from({ length: HEIGHT }, () => "#########.");
  const board = boardFrom(rows);
  // The spawn point is buried, so nothing is reachable, not even the open column.
  assert.equal(enumeratePlacements(board, "O").length, 0);
  assert.equal(enumeratePlacements(board, "I").length, 0);
  // With the top rows clear the I can travel along them and drop into the well.
  const open = boardFrom(Array.from({ length: HEIGHT - 4 }, () => "#########."));
  const well = enumeratePlacements(open, "I").find((p) => p.rotation === 1 && p.x === 9);
  assert.ok(well);
  assert.equal(well.linesCleared, 4);
  assert.equal(well.how, "drop");
});

test("placements include tucks under an overhang, with the path that gets there", () => {
  // Cols 1-2 of the bottom row sit under a two-cell overhang; a straight drop
  // at x=1 lands on the overhang, but a horizontal I can drop to the right of
  // it and slide left underneath.
  const board = boardFrom(["###.......", "#........."]);
  const placements = enumeratePlacements(board, "I");
  const tuck = placements.find((p) => p.rotation === 0 && p.x === 1 && p.y === HEIGHT - 1);
  assert.ok(tuck, "tuck placement is enumerated");
  assert.equal(tuck.how, "tuck");
  assert.deepEqual(tuck.path.slice(-2), ["left", "left"]);
  assert.equal(tuck.holesCreated, 0);
  const onTop = placements.find((p) => p.rotation === 0 && p.x === 1 && p.y === HEIGHT - 3);
  assert.equal(onTop.how, "drop");
  // Every placement is reachable: replaying its path from the spawn ends at it.
  const { stepPiece, SPAWN_X } = engine;
  for (const p of placements) {
    let st = { rotation: 0, x: SPAWN_X, y: 0 };
    for (const m of p.path) st = stepPiece(board, "I", st, m);
    assert.deepEqual(st, { rotation: p.rotation, x: p.x, y: p.y });
  }
  // The description tells the model how the piece gets there.
  assert.match(describePlacement(tuck).how, /tuck/);
  assert.match(describePlacement(onTop).how, /straight drop/);
  // findPath also works from mid-fall, which is what the real-time loop needs.
  const path = engine.findPath(board, "I", { rotation: 0, x: 3, y: 10 }, { rotation: 0, x: 1, y: HEIGHT - 1 });
  assert.ok(path && path.length > 0);
});

test("makeBag returns every piece once", () => {
  const bag = makeBag(() => 0.42);
  assert.deepEqual([...bag].sort(), [...PIECE_NAMES].sort());
});

test("describeSituation reports where the piece is and where the low and high areas are", () => {
  const board = boardFrom(["....##....", "....##....", "....##....", "....##...."]);
  const seen = engine.describeSituation(board, "T", { rotation: 0, x: 3, y: 2 });
  assert.equal(seen.falling_piece.columns, "columns 4-6");
  assert.equal(seen.falling_piece.stack_under_it, "0, 4, 4 rows high, uneven");
  assert.equal(seen.stack.highest_area, "columns 5-6 (4 rows high), directly under the piece");
  assert.equal(seen.stack.lowest_area, "columns 1-4 (empty), partly under the piece");
  const right = engine.describeSituation(board, "O", { rotation: 0, x: 0, y: 0 });
  assert.equal(right.stack.highest_area, "columns 5-6 (4 rows high), to the right of the piece, 3 columns away");
});

test("enumerateActions offers only the moves possible right now, each with its landing", () => {
  const board = emptyBoard();
  const spawn = { rotation: 0, x: SPAWN_X, y: 0 };
  const ids = enumerateActions(board, "T", spawn).map((a) => a.id);
  assert.deepEqual(ids, ["left", "right", "rotate", "drop"]);
  // Against the left wall there is no left move; there is never a soft drop.
  assert.ok(!enumerateActions(board, "T", { rotation: 0, x: 0, y: 0 }).some((a) => a.id === "left"));
  assert.ok(!ids.includes("down"));
  const drop = enumerateActions(board, "T", spawn).find((a) => a.id === "drop");
  assert.equal(drop.state.y, HEIGHT - 2);
  assert.equal(drop.rowsToFall, 0);
  assert.equal(drop.landing.linesCleared, 0);
  // The O piece cannot rotate.
  assert.ok(!enumerateActions(board, "O", spawn).some((a) => a.id === "rotate"));
});

test("buildRequest describes the situation in words, with the controls that work right now", () => {
  const board = emptyBoard();
  const state = { rotation: 0, x: SPAWN_X, y: 0 };
  const actions = enumerateActions(board, "L", state);
  const request = buildRequest(
    { board, piece: "L", nextPiece: "I", state, stats: boardStats(board), linesCleared: 0, versus: true, rowsToFall: HEIGHT - 2 },
    actions,
  );
  assert.equal(request.model, "jev-latest");
  const g = request.state.game;
  assert.match(g.rules, /versus/);
  assert.equal(g.falling_piece.orientation, "flat with the hook up on the right");
  assert.equal(g.falling_piece.columns, "columns 4-6");
  assert.equal(g.falling_piece.stack_under_it, "empty, level");
  assert.equal(g.stack.column_heights_left_to_right.length, WIDTH);
  const criteria = request.questions.move.criteria;
  assert.deepEqual(Object.keys(criteria), actions.map((a) => a.id));
  for (const text of Object.values(criteria)) assert.equal(typeof text, "string");
  assert.match(criteria.drop, /bottom/i);
  // Perception only: no landing summaries, nothing about what a move leads to.
  assert.deepEqual(Object.keys(g), ["rules", "columns", "falling_piece", "stack", "next_piece", "lines_cleared_so_far"]);
  assert.doesNotMatch(JSON.stringify(request.questions.move.criteria), /lines|holes|land/i);
  // No strategy is prescribed: the objective is the game's own.
  for (const line of request.questions.move.instructions.objective) assert.doesNotMatch(line, /hole|flat/i);
  assert.equal(request.questions.strategy, undefined);
  assert.ok(JSON.stringify(request).length < 2_500);
});

test("pickAction maps the answer back and ranks alternatives", () => {
  const actions = enumerateActions(emptyBoard(), "T", { rotation: 0, x: SPAWN_X, y: 0 });
  const response = {
    answers: {
      move: { type: "choice", choice: "rotate", probabilities: { left: 0.1, right: 0.1, rotate: 0.6, down: 0.1, drop: 0.1 }, confidence: 0.6 },
    },
  };
  const { chosen, ranked, confidence } = pickAction(response, actions);
  assert.equal(chosen.id, "rotate");
  assert.equal(ranked[0].action.id, "rotate");
  assert.equal(confidence, 0.6);
  assert.equal(pickAction({ answers: { move: { type: "choice", choice: "jump", probabilities: {} } } }, actions).chosen, null);
});

test("seeded bags give two players the same piece sequence", async () => {
  const { seededRandom } = await import("../public/tetris.js");
  const a = seededRandom(42);
  const b = seededRandom(42);
  const seqA = [...makeBag(a), ...makeBag(a), ...makeBag(a)];
  const seqB = [...makeBag(b), ...makeBag(b), ...makeBag(b)];
  assert.deepEqual(seqA, seqB);
  const c = seededRandom(43);
  assert.notDeepEqual([...makeBag(c)], seqA.slice(0, 7));
});

test("Haiku prompt lists every move and the reply parser only accepts offered ids", async () => {
  const { buildChatPrompt, buildHaikuTool, parseHaikuChoice } = await import("../public/players.js");
  const board = emptyBoard();
  const state = { rotation: 0, x: SPAWN_X, y: 0 };
  const actions = enumerateActions(board, "S", state);
  const prompt = JSON.parse(buildChatPrompt({ board, piece: "S", nextPiece: "Z", state, stats: boardStats(board), linesCleared: 0, rowsToFall: 18 }, actions));
  assert.deepEqual(Object.keys(prompt.moves), actions.map((a) => a.id));
  assert.equal(prompt.falling_piece.orientation, "flat, top pair to the right");
  assert.equal(prompt.stack.column_heights_left_to_right.length, WIDTH);
  assert.deepEqual(buildHaikuTool(actions).input_schema.properties.move.enum, actions.map((a) => a.id));
  assert.equal(parseHaikuChoice({ content: [{ type: "tool_use", name: "make_move", input: { move: "left" } }] }, actions).id, "left");
  assert.equal(parseHaikuChoice({ content: [{ type: "tool_use", name: "make_move", input: { move: "jump" } }] }, actions), null);
  assert.equal(parseHaikuChoice({ content: [{ type: "text", text: "I would rotate here." }] }, actions).id, "rotate");
});

test("garbage rows push the stack up and report overflow at the top", async () => {
  const { addGarbage, GARBAGE } = await import("../public/tetris.js");
  const board = emptyBoard();
  board[HEIGHT - 1][0] = "X";
  const { board: after, overflow } = addGarbage(board, 2, 4);
  assert.equal(overflow, false);
  assert.equal(after.length, HEIGHT);
  assert.equal(after[HEIGHT - 3][0], "X"); // old bottom row moved up two
  assert.deepEqual(after[HEIGHT - 1].map((c) => (c ? 1 : 0)), [1, 1, 1, 1, 0, 1, 1, 1, 1, 1]);
  assert.equal(after[HEIGHT - 1][0], GARBAGE);
  const tall = emptyBoard();
  tall[1][3] = "X";
  assert.equal(addGarbage(tall, 2, 0).overflow, true);
  assert.equal(addGarbage(tall, 1, 0).overflow, false);
});

test("Gemini tool schema enumerates the moves and the parser reads the function call", async () => {
  const { buildGeminiTool, parseGeminiChoice } = await import("../public/players.js");
  const actions = enumerateActions(emptyBoard(), "J", { rotation: 0, x: SPAWN_X, y: 0 });
  const decl = buildGeminiTool(actions).functionDeclarations[0];
  assert.equal(decl.name, "make_move");
  assert.deepEqual(decl.parameters.properties.move.enum, actions.map((a) => a.id));
  const reply = { candidates: [{ content: { parts: [{ functionCall: { name: "make_move", args: { move: "drop" } } }] } }] };
  assert.equal(parseGeminiChoice(reply, actions).id, "drop");
  assert.equal(parseGeminiChoice({ candidates: [{ content: { parts: [{ text: "hmm" }] } }] }, actions), null);
});

test("Laya gets the board as text and the same controls", async () => {
  const { buildLayaRequest } = await import("../public/players.js");
  const board = boardFrom(["#########.", "#########.", "#########.", "#########."]);
  const state = { rotation: 1, x: 8, y: 0 };
  const actions = enumerateActions(board, "I", state);
  const request = buildLayaRequest({ board, piece: "I", nextPiece: "T", state, stats: boardStats(board), linesCleared: 0, rowsToFall: 12 }, actions);
  assert.equal(typeof request.state, "string");
  assert.match(request.state, /upright, one wide and four tall, in column 9/);
  assert.match(request.state, /Lowest area: column 10 \(empty\), to the right of the piece, 1 column away/);
  assert.deepEqual(Object.keys(request.questions.move.criteria), actions.map((a) => a.id));
  for (const text of Object.values(request.questions.move.criteria)) assert.ok(text.split(/\s+/).length <= 20, text);
});

