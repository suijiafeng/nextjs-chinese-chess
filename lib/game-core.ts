import {
  chaseCandidates,
  cloneBoard,
  findKing,
  hasAnyMove,
  inCheck,
  initialBoard,
  isPerpetualChaseMove,
  isPerpetualCheckMove,
  legalMoves,
  materialDrawAdjudication,
  naturalMoveAdjudication,
  NAMES,
  positionKey,
  repetitionAdjudication,
} from "./chess";
import type { AdjudicationMove, AdjudicationResult, Board, Piece, Side } from "./chess";

/**
 * 与界面无关的对局推进逻辑：落子校验、记录生成、终局裁定。
 * 浏览器与局域网服务端共用，保证两端对同一串着法得到完全一致的结果。
 */

export type Coord = [number, number];

export interface GameState {
  board: Board;
  turn: Side;
  history: AdjudicationMove[];
  result: AdjudicationResult | null;
}

export type MoveRejection =
  | "finished"
  | "no-piece"
  | "wrong-side"
  | "illegal"
  | "perpetual-check"
  | "perpetual-chase";

export const REJECTION_MESSAGE: Record<MoveRejection, string> = {
  finished: "对局已经结束",
  "no-piece": "该位置没有棋子",
  "wrong-side": "现在不是这一方行棋",
  illegal: "该着法不符合走子规则",
  "perpetual-check": "禁止长将：不能连续将军超过三次",
  "perpetual-chase": "禁止长捉：不能连续捉同一子超过三次",
};

export type MoveOutcome =
  | {
      ok: true;
      state: GameState;
      record: AdjudicationMove;
      notation: string;
      gaveCheck: boolean;
      captured: Piece | null;
    }
  | { ok: false; reason: MoveRejection };

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const INITIAL_KEY = positionKey(initialBoard(), "red");

function fileName(side: Side, col: number) {
  return CN_NUM[side === "red" ? 8 - col : col];
}

/** 中文着法记谱，如「炮二平五」。 */
export function moveNotation(piece: Piece, from: Coord, to: Coord) {
  const [fr, fc] = from;
  const [tr, tc] = to;
  const name = NAMES[piece.side][piece.t];
  const origin = fileName(piece.side, fc);

  if (fr === tr) return `${name}${origin}平${fileName(piece.side, tc)}`;

  const forward = piece.side === "red" ? tr < fr : tr > fr;
  const action = forward ? "进" : "退";
  const destination = ["N", "B", "A"].includes(piece.t)
    ? fileName(piece.side, tc)
    : CN_NUM[Math.abs(tr - fr) - 1];
  return `${name}${origin}${action}${destination}`;
}

export function initialState(): GameState {
  return { board: initialBoard(), turn: "red", history: [], result: null };
}

export function sideLabel(side: Side) {
  return side === "red" ? "红方" : "黑方";
}

/** 推进一步。不修改传入的 state。 */
export function playMove(state: GameState, from: Coord, to: Coord): MoveOutcome {
  if (state.result) return { ok: false, reason: "finished" };
  const [fr, fc] = from;
  const [tr, tc] = to;
  const piece = state.board[fr]?.[fc];
  if (!piece) return { ok: false, reason: "no-piece" };
  if (piece.side !== state.turn) return { ok: false, reason: "wrong-side" };
  if (!legalMoves(state.board, fr, fc).some(([r, c]) => r === tr && c === tc)) {
    return { ok: false, reason: "illegal" };
  }

  const captured = state.board[tr][tc] ? { ...state.board[tr][tc]! } : null;
  const next = cloneBoard(state.board);
  next[tr][tc] = { ...piece };
  next[fr][fc] = null;

  const nextTurn: Side = state.turn === "red" ? "black" : "red";
  const kingAlive = !!findKing(next, nextTurn);
  const gaveCheck = kingAlive && inCheck(next, nextTurn);
  const record: AdjudicationMove = {
    mover: { ...piece },
    from,
    to,
    captured,
    check: gaveCheck,
    positionKey: positionKey(next, nextTurn),
    chaseCandidates: chaseCandidates(next, to, gaveCheck),
  };

  if (gaveCheck && isPerpetualCheckMove(INITIAL_KEY, state.history, record)) {
    return { ok: false, reason: "perpetual-check" };
  }
  if (!gaveCheck && isPerpetualChaseMove(INITIAL_KEY, state.history, record)) {
    return { ok: false, reason: "perpetual-chase" };
  }

  const history = [...state.history, record];
  let result: AdjudicationResult | null;
  if (!kingAlive) {
    result = { winner: state.turn, message: `${sideLabel(state.turn)}擒将取胜` };
  } else if (!hasAnyMove(next, nextTurn)) {
    result = { winner: state.turn, message: gaveCheck ? "将死，对局结束" : "困毙，对局结束" };
  } else {
    result = materialDrawAdjudication(next)
      ?? repetitionAdjudication(INITIAL_KEY, history)
      ?? naturalMoveAdjudication(history);
  }

  return {
    ok: true,
    state: { board: next, turn: nextTurn, history, result },
    record,
    notation: moveNotation(piece, from, to),
    gaveCheck,
    captured,
  };
}

/** 这手棋是否触犯长将/长捉禁着（供外部引擎的候选着法复核）。 */
export function isBannedMove(state: GameState, from: Coord, to: Coord) {
  const outcome = playMove(state, from, to);
  return !outcome.ok && (outcome.reason === "perpetual-check" || outcome.reason === "perpetual-chase");
}

/** 从头重放一串着法；遇到非法着法即停止并返回已成功的部分。 */
export function replayMoves(moves: { from: Coord; to: Coord }[]) {
  let state = initialState();
  const outcomes: Extract<MoveOutcome, { ok: true }>[] = [];
  for (const { from, to } of moves) {
    const outcome = playMove(state, from, to);
    if (!outcome.ok) break;
    outcomes.push(outcome);
    state = outcome.state;
  }
  return { state, outcomes };
}
