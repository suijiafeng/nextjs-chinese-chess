import { initialState, playMove, REJECTION_MESSAGE, sideLabel } from "../lib/game-core";
import type { Coord, GameState } from "../lib/game-core";
import type { AdjudicationResult, Side } from "../lib/chess";

/**
 * 房间的纯逻辑，不涉及网络。局域网服务端调用，单元测试也直接跑这里。
 * 所有时间都由调用方传入，便于测试。
 */

export const INITIAL_SECONDS = 900;

export interface WireMove {
  from: Coord;
  to: Coord;
}

export interface Seat {
  token: string;
  connected: boolean;
}

export interface Room {
  code: string;
  createdAt: number;
  seats: Record<Side, Seat | null>;
  state: GameState;
  moves: WireMove[];
  /** 上次换手时各方剩余秒数。 */
  times: Record<Side, number>;
  /** 当前行棋方开始计时的时刻；未开始或已结束时为 null。 */
  turnStartedAt: number | null;
  started: boolean;
  pendingUndo: Side | null;
  rematch: Set<Side>;
}

/** 发给客户端的快照。 */
export interface RoomSnapshot {
  code: string;
  started: boolean;
  seats: Record<Side, boolean>;
  moves: WireMove[];
  turn: Side;
  times: Record<Side, number>;
  result: AdjudicationResult | null;
  pendingUndo: Side | null;
  rematch: Side[];
}

export class RoomError extends Error {}

export function otherSide(side: Side): Side {
  return side === "red" ? "black" : "red";
}

export function createRoom(code: string, now: number): Room {
  return {
    code,
    createdAt: now,
    seats: { red: null, black: null },
    state: initialState(),
    moves: [],
    times: { red: INITIAL_SECONDS, black: INITIAL_SECONDS },
    turnStartedAt: null,
    started: false,
    pendingUndo: null,
    rematch: new Set(),
  };
}

export function liveTimes(room: Room, now: number): Record<Side, number> {
  if (room.turnStartedAt === null) return { ...room.times };
  const elapsed = Math.floor((now - room.turnStartedAt) / 1000);
  const turn = room.state.turn;
  return { ...room.times, [turn]: Math.max(0, room.times[turn] - elapsed) };
}

export function snapshot(room: Room, now: number): RoomSnapshot {
  return {
    code: room.code,
    started: room.started,
    seats: { red: !!room.seats.red?.connected, black: !!room.seats.black?.connected },
    moves: room.moves,
    turn: room.state.turn,
    times: liveTimes(room, now),
    result: room.state.result,
    pendingUndo: room.pendingUndo,
    rematch: [...room.rematch],
  };
}

/** 入座：有凭证则恢复原座位，否则坐到指定或空着的一方。 */
export function takeSeat(room: Room, token: string, preferred?: Side): Side {
  for (const side of ["red", "black"] as Side[]) {
    if (room.seats[side]?.token === token) {
      room.seats[side]!.connected = true;
      return side;
    }
  }
  const candidates: Side[] = preferred ? [preferred, otherSide(preferred)] : ["red", "black"];
  for (const side of candidates) {
    if (!room.seats[side]) {
      room.seats[side] = { token, connected: true };
      return side;
    }
  }
  throw new RoomError("房间已满");
}

export function leaveSeat(room: Room, side: Side) {
  if (room.seats[side]) room.seats[side]!.connected = false;
}

export function bothSeated(room: Room) {
  return !!room.seats.red && !!room.seats.black;
}

/** 双方到齐即开始计时。 */
export function startIfReady(room: Room, now: number) {
  if (room.started || !bothSeated(room)) return false;
  room.started = true;
  room.turnStartedAt = now;
  return true;
}

/** 结算当前行棋方用掉的时间；必须在换手之前调用。 */
function settleClock(room: Room, now: number) {
  room.times = liveTimes(room, now);
}

function restartClock(room: Room, now: number) {
  room.turnStartedAt = room.state.result ? null : now;
}

export function applyMove(room: Room, side: Side, from: Coord, to: Coord, now: number) {
  if (!room.started) throw new RoomError("对局尚未开始");
  if (room.state.turn !== side) throw new RoomError(REJECTION_MESSAGE["wrong-side"]);
  const outcome = playMove(room.state, from, to);
  if (!outcome.ok) throw new RoomError(REJECTION_MESSAGE[outcome.reason]);
  settleClock(room, now);
  room.pendingUndo = null;
  room.state = outcome.state;
  room.moves = [...room.moves, { from, to }];
  restartClock(room, now);
  return outcome;
}

export function requestUndo(room: Room, side: Side) {
  if (!room.started || room.state.result) throw new RoomError("当前不能悔棋");
  if (!room.moves.some((_, index) => sideOfPly(index) === side)) throw new RoomError("还没有可悔的着法");
  room.pendingUndo = side;
}

function sideOfPly(index: number): Side {
  return index % 2 === 0 ? "red" : "black";
}

/** 对方同意后，撤回请求方最后一手（若对方已回应则连同回应一起撤回）。 */
export function acceptUndo(room: Room, by: Side, now: number) {
  const requester = room.pendingUndo;
  if (!requester || requester === by) throw new RoomError("没有待处理的悔棋请求");
  const steps = room.state.turn === requester ? 2 : 1;
  const moves = room.moves.slice(0, Math.max(0, room.moves.length - steps));
  settleClock(room, now);
  rebuild(room, moves);
  room.pendingUndo = null;
  restartClock(room, now);
}

export function declineUndo(room: Room, by: Side) {
  if (room.pendingUndo && room.pendingUndo !== by) room.pendingUndo = null;
}

function rebuild(room: Room, moves: WireMove[]) {
  let state = initialState();
  for (const { from, to } of moves) {
    const outcome = playMove(state, from, to);
    if (!outcome.ok) break;
    state = outcome.state;
  }
  room.state = state;
  room.moves = moves;
}

export function resign(room: Room, side: Side, now: number) {
  if (!room.started || room.state.result) throw new RoomError("当前不能认输");
  room.state = {
    ...room.state,
    result: { winner: otherSide(side), message: `${sideLabel(side)}认输，${sideLabel(otherSide(side))}取胜` },
  };
  room.pendingUndo = null;
  settleClock(room, now);
  restartClock(room, now);
}

/** 服务端定时调用；超时则判负并返回 true。 */
export function tickClock(room: Room, now: number) {
  if (!room.started || room.state.result || room.turnStartedAt === null) return false;
  const times = liveTimes(room, now);
  const turn = room.state.turn;
  if (times[turn] > 0) return false;
  room.state = {
    ...room.state,
    result: { winner: otherSide(turn), message: `${sideLabel(turn)}用时耗尽` },
  };
  room.times = times;
  room.turnStartedAt = null;
  room.pendingUndo = null;
  return true;
}

/** 双方都点了「再来一局」时重置并交换颜色。 */
export function requestRematch(room: Room, side: Side, now: number) {
  if (!room.state.result) throw new RoomError("对局还没结束");
  room.rematch.add(side);
  if (room.rematch.size < 2) return false;
  const { red, black } = room.seats;
  room.seats = { red: black, black: red };
  room.state = initialState();
  room.moves = [];
  room.times = { red: INITIAL_SECONDS, black: INITIAL_SECONDS };
  room.pendingUndo = null;
  room.rematch.clear();
  room.started = false;
  room.turnStartedAt = null;
  startIfReady(room, now);
  return true;
}

/** 当前凭证坐在哪一方。 */
export function seatOf(room: Room, token: string): Side | null {
  if (room.seats.red?.token === token) return "red";
  if (room.seats.black?.token === token) return "black";
  return null;
}
