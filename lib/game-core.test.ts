import { describe, expect, it } from "vitest";
import { initialState, playMove } from "./game-core";
import type { Coord, GameState } from "./game-core";
import type { Board } from "./chess";

function customBoard(): Board {
  const board: Board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[9][4] = { side: "red", t: "K" };
  board[0][3] = { side: "black", t: "K" };
  board[5][8] = { side: "red", t: "R" };
  return board;
}

function play(state: GameState, moves: [Coord, Coord][]) {
  const results: (GameState["result"])[] = [];
  for (const [from, to] of moves) {
    const outcome = playMove(state, from, to);
    if (!outcome.ok) throw new Error(`第 ${results.length + 1} 手被拒绝：${outcome.reason}`);
    state = outcome.state;
    results.push(state.result);
  }
  return results;
}

/** 车来回、将上下，每四手回到起始局面。 */
const CYCLE: [Coord, Coord][] = [
  [[5, 8], [5, 7]], [[0, 3], [1, 3]],
  [[5, 7], [5, 8]], [[1, 3], [0, 3]],
];

describe("自定义开局的重复局面计数", () => {
  it("起始局面本身计一次：三个循环后第 12 手判和", () => {
    const results = play(initialState(customBoard(), "red"), [...CYCLE, ...CYCLE, ...CYCLE]);
    expect(results[10]).toBeNull();
    expect(results[11]?.code).toBe("repetition");
  });

  it("initialKey 会随 state 传递下去", () => {
    const start = initialState(customBoard(), "red");
    const outcome = playMove(start, [5, 8], [5, 7]);
    expect(outcome.ok && outcome.state.initialKey).toBe(start.initialKey);
  });

  it("不带 initialKey 时按标准开局计数，自定义起始局面不算一次", () => {
    const state: GameState = { board: customBoard(), turn: "red", history: [], result: null };
    const results = play(state, [...CYCLE, ...CYCLE, ...CYCLE]);
    expect(results[11]).toBeNull();
  });
});
