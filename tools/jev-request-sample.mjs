#!/usr/bin/env node
// Prints the exact request Jev receives for one move, so the state and the
// options can be reviewed. The model plays one move at a time; this shows the
// request for a T piece that has fallen part of the way on a sample board.
//
//   node tools/jev-request-sample.mjs            # T piece, 8 rows down, next I
//   node tools/jev-request-sample.mjs L I 0      # L piece at its spawn, next I

import { HEIGHT, WIDTH, PIECES, emptyBoard, enumerateActions, boardStats, dropY, SPAWN_X } from "../public/tetris.js";
import { buildRequest } from "../public/jev.js";

// A mid-game board with an overhang at columns 7-8 and open space beneath it
// (rows from the top; # filled, . empty).
const ROWS = [
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "......##..",
  "#####.....",
  "######....",
  "#######.#.",
  "########.#",
];

const board = emptyBoard();
ROWS.forEach((row, y) => {
  for (let x = 0; x < WIDTH; x++) board[y][x] = row[x] === "#" ? "X" : null;
});
if (ROWS.length !== HEIGHT) throw new Error("sample board must have 20 rows");

const piece = process.argv[2] || "T";
const nextPiece = process.argv[3] || "I";
const state = { rotation: 0, x: SPAWN_X, y: Number(process.argv[4] ?? 8) };
const stats = boardStats(board);
const actions = enumerateActions(board, piece, state, stats);
const rowsToFall = dropY(board, PIECES[piece][state.rotation].cells, state.x, state.y) - state.y;
const request = buildRequest({ board, piece, nextPiece, state, stats, linesCleared: 12, versus: true, rowsToFall }, actions);
console.error(`${actions.length} moves offered for ${piece} at row ${state.y}: ${actions.map((a) => a.id).join(", ")}`);
console.log(JSON.stringify(request, null, 2));
