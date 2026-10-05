import { describe, expect, it } from "vitest";
import { initialBoard } from "./chess";
import type { Board, Piece } from "./chess";
import { emptySetup, isStandardSetup, placementError, setupError, squareAllowed } from "./setup";

const red = (t: Piece["t"]): Piece => ({ side: "red", t });
const black = (t: Piece["t"]): Piece => ({ side: "black", t });

function boardWith(pieces: [number, number, Piece][]): Board {
  const board: Board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [r, c, piece] of pieces) board[r][c] = piece;
  return board;
}

describe("棋子可放置的位置", () => {
  it("帅将只能在九宫内", () => {
    expect(squareAllowed(red("K"), [8, 4])).toBe(true);
    expect(squareAllowed(red("K"), [6, 4])).toBe(false);
    expect(squareAllowed(black("K"), [2, 5])).toBe(true);
    expect(squareAllowed(black("K"), [0, 2])).toBe(false);
  });

  it("仕士只能在九宫的四角与中心", () => {
    for (const point of [[9, 3], [9, 5], [8, 4], [7, 3], [7, 5]] as const) expect(squareAllowed(red("A"), [point[0], point[1]])).toBe(true);
    expect(squareAllowed(red("A"), [9, 4])).toBe(false);
    expect(squareAllowed(red("A"), [8, 3])).toBe(false);
    for (const point of [[0, 3], [0, 5], [1, 4], [2, 3], [2, 5]] as const) expect(squareAllowed(black("A"), [point[0], point[1]])).toBe(true);
    expect(squareAllowed(black("A"), [0, 4])).toBe(false);
  });

  it("相象不能过河，只能在象位上", () => {
    expect(squareAllowed(red("B"), [7, 4])).toBe(true);
    expect(squareAllowed(red("B"), [5, 2])).toBe(true);
    expect(squareAllowed(red("B"), [4, 2])).toBe(false);
    expect(squareAllowed(red("B"), [9, 4])).toBe(false);
    expect(squareAllowed(black("B"), [4, 6])).toBe(true);
    expect(squareAllowed(black("B"), [5, 6])).toBe(false);
  });

  it("兵卒不能退到起始行之后，未过河只能在起始纵线", () => {
    expect(squareAllowed(red("P"), [6, 0])).toBe(true);
    expect(squareAllowed(red("P"), [5, 1])).toBe(false);
    expect(squareAllowed(red("P"), [4, 1])).toBe(true);
    expect(squareAllowed(red("P"), [7, 0])).toBe(false);
    expect(squareAllowed(black("P"), [3, 8])).toBe(true);
    expect(squareAllowed(black("P"), [2, 8])).toBe(false);
    expect(squareAllowed(black("P"), [6, 3])).toBe(true);
  });

  it("车马炮不受位置限制", () => {
    expect(squareAllowed(red("R"), [0, 0])).toBe(true);
    expect(squareAllowed(black("N"), [9, 8])).toBe(true);
    expect(squareAllowed(red("C"), [4, 4])).toBe(true);
  });
});

describe("放置校验", () => {
  it("超过数量上限时拒绝，移动已有棋子不计入", () => {
    const board = boardWith([[5, 0, red("R")], [5, 8, red("R")]]);
    expect(placementError(board, red("R"), [4, 4])).toMatch(/最多 2 个/);
    expect(placementError(board, red("R"), [4, 4], [5, 0])).toBeNull();
    expect(placementError(board, red("R"), [5, 8])).toBeNull();
  });

  it("位置不合规时给出原因", () => {
    expect(placementError(emptySetup(), red("A"), [8, 3])).toMatch(/九宫/);
  });
});

describe("开局校验", () => {
  it("标准开局可用", () => {
    expect(setupError(initialBoard(), "red")).toBeNull();
    expect(setupError(initialBoard(), "black")).toBeNull();
  });

  it("缺少将帅不能开局", () => {
    const board = emptySetup();
    board[0][4] = null;
    expect(setupError(board, "red")).toMatch(/缺少將/);
  });

  it("将帅对脸不能开局", () => {
    expect(setupError(emptySetup(), "red")).toMatch(/对脸|被将军/);
  });

  it("非行棋方正被将军时不能开局", () => {
    const board = boardWith([[0, 4, black("K")], [9, 3, red("K")], [5, 4, red("R")]]);
    expect(setupError(board, "red")).toMatch(/被将军/);
    expect(setupError(board, "black")).toBeNull();
  });

  it("行棋方无子可走不能开局", () => {
    // 黑将被困死但未被将军：红车封住九宫出口。
    const board = boardWith([[0, 3, black("K")], [9, 5, red("K")], [1, 5, red("R")], [3, 4, red("R")]]);
    expect(setupError(board, "black")).toMatch(/无子可走/);
  });

  it("识别标准开局", () => {
    expect(isStandardSetup(initialBoard(), "red")).toBe(true);
    expect(isStandardSetup(initialBoard(), "black")).toBe(false);
    expect(isStandardSetup(emptySetup(), "red")).toBe(false);
  });
});
