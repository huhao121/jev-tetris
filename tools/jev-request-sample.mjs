#!/usr/bin/env node
// Prints the exact request Jev receives for one Tetris move, so the state and
// the placement options can be reviewed. Optional args: piece and next piece.
//
//   node tools/jev-request-sample.mjs        # L piece on the sample board
//   node tools/jev-request-sample.mjs T O

import { HEIGHT, WIDTH, emptyBoard, enumeratePlacements, boardStats } from "../public/tetris.js";
import { buildRequest } from "../public/jev.js";

// A mid-game board with an overhang at columns 7-8 and open space beneath it
// (rows from the top; # filled, . empty). Straight drops cannot reach the
// cells under the overhang; a piece has to drop to the right and slide in.
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

const piece = process.argv[2] || "L";
const nextPiece = process.argv[3] || "I";
const placements = enumeratePlacements(board, piece);
const request = buildRequest({ board, piece, nextPiece, stats: boardStats(board), linesCleared: 12 }, placements);
const howCounts = {};
for (const p of placements) howCounts[p.how] = (howCounts[p.how] || 0) + 1;
console.error(`${placements.length} placements for ${piece}: ${JSON.stringify(howCounts)}`);
console.log(JSON.stringify(request, null, 2));
