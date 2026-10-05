import { describe, expect, it } from "vitest";
import {
  acceptUndo,
  applyMove,
  createRoom,
  declineUndo,
  leaveSeat,
  liveTimes,
  requestRematch,
  requestUndo,
  resign,
  RoomError,
  seatOf,
  snapshot,
  startIfReady,
  takeSeat,
  tickClock,
} from "./room";

function readyRoom(now = 1000) {
  const room = createRoom("1234", now);
  takeSeat(room, "tok-red", "red");
  takeSeat(room, "tok-black");
  startIfReady(room, now);
  return room;
}

describe("入座与开始", () => {
  it("第二人入座后自动开始，并把计时起点记下来", () => {
    const room = createRoom("1234", 0);
    expect(takeSeat(room, "a", "black")).toBe("black");
    expect(room.started).toBe(false);
    expect(takeSeat(room, "b")).toBe("red");
    expect(startIfReady(room, 500)).toBe(true);
    expect(room.turnStartedAt).toBe(500);
  });

  it("同一凭证重连回到原座位；满员时拒绝第三人", () => {
    const room = readyRoom();
    leaveSeat(room, "black");
    expect(snapshot(room, 0).seats.black).toBe(false);
    expect(takeSeat(room, "tok-black")).toBe("black");
    expect(snapshot(room, 0).seats.black).toBe(true);
    expect(() => takeSeat(room, "stranger")).toThrow(RoomError);
    expect(seatOf(room, "tok-red")).toBe("red");
    expect(seatOf(room, "nobody")).toBeNull();
  });
});

describe("落子", () => {
  it("只有当前行棋方能走，走后计时切换到对方", () => {
    const room = readyRoom(1000);
    expect(() => applyMove(room, "black", [3, 0], [4, 0], 2000)).toThrow(RoomError);
    applyMove(room, "red", [7, 1], [7, 4], 6000);
    expect(room.moves).toHaveLength(1);
    expect(room.state.turn).toBe("black");
    expect(room.times.red).toBe(895);
    expect(liveTimes(room, 9000).black).toBe(897);
  });

  it("未开始时不能落子", () => {
    const room = createRoom("1", 0);
    takeSeat(room, "a", "red");
    expect(() => applyMove(room, "red", [7, 1], [7, 4], 0)).toThrow("尚未开始");
  });
});

describe("悔棋", () => {
  it("对方同意后撤回请求方最后一手；若对方已回应则一并撤回", () => {
    const room = readyRoom();
    applyMove(room, "red", [7, 1], [7, 4], 0);
    applyMove(room, "black", [2, 1], [2, 4], 0);
    requestUndo(room, "red");
    expect(room.pendingUndo).toBe("red");
    acceptUndo(room, "black", 0);
    expect(room.moves).toHaveLength(0);
    expect(room.state.turn).toBe("red");
    expect(room.pendingUndo).toBeNull();
  });

  it("请求方自己不能同意；拒绝后请求清空", () => {
    const room = readyRoom();
    applyMove(room, "red", [7, 1], [7, 4], 0);
    requestUndo(room, "red");
    expect(() => acceptUndo(room, "red", 0)).toThrow(RoomError);
    declineUndo(room, "black");
    expect(room.pendingUndo).toBeNull();
    expect(room.moves).toHaveLength(1);
  });

  it("没有自己的着法时不能请求悔棋", () => {
    const room = readyRoom();
    expect(() => requestUndo(room, "black")).toThrow(RoomError);
  });
});

describe("认输、超时与再来一局", () => {
  it("认输判对方胜并停止计时", () => {
    const room = readyRoom();
    resign(room, "red", 0);
    expect(room.state.result?.winner).toBe("black");
    expect(room.turnStartedAt).toBeNull();
    expect(() => applyMove(room, "red", [7, 1], [7, 4], 0)).toThrow(RoomError);
  });

  it("用时耗尽由 tickClock 判负", () => {
    const room = readyRoom(0);
    expect(tickClock(room, 899_000)).toBe(false);
    expect(tickClock(room, 900_000)).toBe(true);
    expect(room.state.result?.winner).toBe("black");
    expect(room.times.red).toBe(0);
  });

  it("双方都同意后重开并交换颜色", () => {
    const room = readyRoom();
    resign(room, "black", 0);
    expect(requestRematch(room, "red", 10)).toBe(false);
    expect(requestRematch(room, "black", 10)).toBe(true);
    expect(seatOf(room, "tok-red")).toBe("black");
    expect(room.moves).toHaveLength(0);
    expect(room.started).toBe(true);
    expect(room.state.result).toBeNull();
  });
});
