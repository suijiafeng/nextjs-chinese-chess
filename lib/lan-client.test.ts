import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_RETRY_LIMIT, LanClient, loadLanSession, UNREACHABLE_MESSAGE } from "./lan-client";
import type { LanHandlers } from "./lan-client";

/** 最小化的假 WebSocket：由测试手动触发打开、失败、收消息。 */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const seatedMessage = {
  type: "seated",
  code: "1234",
  side: "red",
  snapshot: { code: "1234", started: false, seats: { red: true, black: false }, moves: [], turn: "red", times: { red: 900, black: 900 }, result: null, pendingUndo: null, rematch: [] },
};

function makeHandlers(): LanHandlers {
  return { onSeated: vi.fn(), onState: vi.fn(), onError: vi.fn(), onConnection: vi.fn() };
}

function latest() {
  return FakeSocket.instances[FakeSocket.instances.length - 1];
}

/** 让一次连接失败并走完退避等待，下一次连接随即发起。 */
function failAndWait() {
  latest().fail();
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  const storage = new Map<string, string>();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    location: { protocol: "http:", hostname: "localhost" },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("首次连接失败", () => {
  it("重试到上限后放弃并提示，不再在后台重连", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.create("localhost", "red");
    expect(FakeSocket.instances).toHaveLength(1);

    for (let attempt = 0; attempt < INITIAL_RETRY_LIMIT; attempt++) failAndWait();
    expect(FakeSocket.instances).toHaveLength(1 + INITIAL_RETRY_LIMIT);
    expect(handlers.onError).not.toHaveBeenCalled();

    latest().fail();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith(UNREACHABLE_MESSAGE);
    vi.runAllTimers();
    expect(FakeSocket.instances).toHaveLength(1 + INITIAL_RETRY_LIMIT);
  });

  it("放弃后服务再启动也不会凭空建房", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.create("localhost", "red");
    for (let attempt = 0; attempt <= INITIAL_RETRY_LIMIT; attempt++) failAndWait();
    expect(client.current).toBeNull();
    // 放弃后用户重新点创建：这是一次新的连接，带新的意图。
    client.create("localhost", "black");
    const socket = latest();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "create", side: "black" });
  });

  it("等待连接时取消不会误报「连接已断开」", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.create("localhost", "red");
    client.leave();
    vi.runAllTimers();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("服务端拒绝", () => {
  it("创建或加入被拒后停止重连并清掉意图", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.join("localhost", "9999");
    const socket = latest();
    socket.open();
    socket.receive({ type: "error", message: "找不到这个房间，请核对房间码" });
    expect(handlers.onError).toHaveBeenCalledWith("找不到这个房间，请核对房间码");
    socket.drop();
    vi.runAllTimers();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("恢复座位失败时清掉本地会话，刷新后不再反复尝试", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.resume({ host: "localhost", code: "1234", token: "old", side: "red" });
    const socket = latest();
    socket.open();
    socket.receive({ type: "error", message: "找不到这个房间，请核对房间码" });
    expect(client.current).toBeNull();
    expect(loadLanSession()).toBeNull();
  });
});

describe("入座后断线", () => {
  it("一直按退避重连，不会放弃", () => {
    const handlers = makeHandlers();
    const client = new LanClient(handlers);
    client.create("localhost", "red");
    latest().open();
    latest().receive(seatedMessage);
    expect(handlers.onSeated).toHaveBeenCalledTimes(1);
    expect(loadLanSession()).toMatchObject({ code: "1234", side: "red" });

    const rounds = INITIAL_RETRY_LIMIT + 3;
    for (let attempt = 0; attempt < rounds; attempt++) failAndWait();
    expect(FakeSocket.instances).toHaveLength(1 + rounds);
    expect(handlers.onError).not.toHaveBeenCalled();

    // 重连成功后按恢复座位发送 join。
    const socket = latest();
    socket.open();
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "join", code: "1234" });
  });
});
