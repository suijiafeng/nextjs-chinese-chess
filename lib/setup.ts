import { COLS, findKing, hasAnyMove, inCheck, initialBoard, inPalace, NAMES, ROWS } from "./chess";
import type { Board, Piece, PieceType, Side } from "./chess";
import { sideLabel } from "./game-core";

/**
 * 自定义开局（摆棋）的规则：每种棋子能放在哪些点、数量上限，以及整盘能否开局。
 * 与界面无关，页面编辑器与单元测试共用。
 */

export type Coord = [number, number];

/** 每方各类棋子的数量上限。 */
export const PIECE_LIMIT: Record<PieceType, number> = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 };
/** 棋子盘里的排列顺序。 */
export const SETUP_ORDER: PieceType[] = ["K", "A", "B", "N", "R", "C", "P"];

const ELEPHANT_POINTS: Record<Side, ReadonlySet<string>> = {
  red: new Set(["9,2", "9,6", "7,0", "7,4", "7,8", "5,2", "5,6"]),
  black: new Set(["0,2", "0,6", "2,0", "2,4", "2,8", "4,2", "4,6"]),
};

/** 该棋子能否出现在这个点上（不看数量）。 */
export function squareAllowed(piece: Piece, [r, c]: Coord): boolean {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
  switch (piece.t) {
    case "K":
      return inPalace(r, c, piece.side);
    case "A":
      // 仕/士只能在九宫的四角与中心：红方这五点行列之和为偶数，黑方为奇数。
      return inPalace(r, c, piece.side) && (r + c) % 2 === (piece.side === "red" ? 0 : 1);
    case "B":
      return ELEPHANT_POINTS[piece.side].has(`${r},${c}`);
    case "P":
      // 兵卒不能退到起始行之后；未过河时只能在起始纵线上。
      if (piece.side === "red") return r <= 6 && (r < 5 || c % 2 === 0);
      return r >= 3 && (r > 4 || c % 2 === 0);
    default:
      return true;
  }
}

function squareMessage(piece: Piece): string {
  const name = NAMES[piece.side][piece.t];
  switch (piece.t) {
    case "K": return `${name}只能放在九宫内`;
    case "A": return `${name}只能放在九宫的四角或中心`;
    case "B": return `${name}不能过河，只能放在七个象位上`;
    case "P": return `${name}不能放在起始行之后，未过河时只能放在起始纵线上`;
    default: return `${name}不能放在这里`;
  }
}

/** 统计某方某类棋子的数量，可忽略若干格（放置或移动时排除来源与目标）。 */
export function countPieces(board: Board, side: Side, t: PieceType, ignore: Coord[] = []): number {
  let total = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (ignore.some(([ir, ic]) => ir === r && ic === c)) continue;
      const piece = board[r][c];
      if (piece && piece.side === side && piece.t === t) total++;
    }
  }
  return total;
}

/**
 * 把 piece 放到 to 是否合规；from 为拾起移动时的来源格（计数时排除）。
 * 返回 null 表示可以放，否则是给用户看的原因。
 */
export function placementError(board: Board, piece: Piece, to: Coord, from?: Coord): string | null {
  if (!squareAllowed(piece, to)) return squareMessage(piece);
  const ignore = from ? [from, to] : [to];
  if (countPieces(board, piece.side, piece.t, ignore) >= PIECE_LIMIT[piece.t]) {
    return `${sideLabel(piece.side)}的${NAMES[piece.side][piece.t]}最多 ${PIECE_LIMIT[piece.t]} 个`;
  }
  return null;
}

/** 整盘能否作为开局；返回 null 表示可以，否则是原因。 */
export function setupError(board: Board, turn: Side): string | null {
  for (const side of ["red", "black"] as Side[]) {
    if (!findKing(board, side)) return `${sideLabel(side)}缺少${NAMES[side].K}`;
  }
  const tally = new Map<string, number>();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      if (!squareAllowed(piece, [r, c])) return squareMessage(piece);
      const key = `${piece.side}${piece.t}`;
      const count = (tally.get(key) ?? 0) + 1;
      tally.set(key, count);
      if (count > PIECE_LIMIT[piece.t]) return `${sideLabel(piece.side)}的${NAMES[piece.side][piece.t]}最多 ${PIECE_LIMIT[piece.t]} 个`;
    }
  }
  const other: Side = turn === "red" ? "black" : "red";
  if (inCheck(board, other)) return `${sideLabel(turn)}先行时，${sideLabel(other)}不能正处于被将军（含将帅对脸）`;
  if (!hasAnyMove(board, turn)) return `${sideLabel(turn)}无子可走，无法从这个局面开始`;
  return null;
}

/** 只留双方将帅的空盘，便于从零摆残局。 */
export function emptySetup(): Board {
  const board: Board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  board[9][4] = { side: "red", t: "K" };
  board[0][4] = { side: "black", t: "K" };
  return board;
}

/** 是否就是标准开局。 */
export function isStandardSetup(board: Board, turn: Side): boolean {
  if (turn !== "red") return false;
  const standard = initialBoard();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const a = board[r][c];
      const b = standard[r][c];
      if (!!a !== !!b || (a && b && (a.side !== b.side || a.t !== b.t))) return false;
    }
  }
  return true;
}
