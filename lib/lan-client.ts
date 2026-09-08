import type { Side } from "./chess";
import type { Coord } from "./game-core";
import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { RoomSnapshot } from "../server/room";
import { DEFAULT_LAN_PORT } from "../server/protocol";

/**
 * 浏览器端的局域网连接：自动重连、座位凭证持久化、把服务端快照交给页面。
 */

export interface LanSession {
  host: string;
  code: string;
  token: string;
  side: Side;
}

export interface LanHandlers {
  onSeated(session: LanSession, snapshot: RoomSnapshot): void;
  onState(snapshot: RoomSnapshot, side: Side): void;
  onError(message: string): void;
  onConnection(connected: boolean): void;
}

/** 用 sessionStorage：刷新能恢复座位，而同一浏览器的多个标签页互不干扰。 */
const SESSION_KEY = "changan-xiangqi-lan-v1";

export function loadLanSession(): LanSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<LanSession>;
    if (data.host && data.code && data.token && (data.side === "red" || data.side === "black")) {
      return data as LanSession;
    }
  } catch {
    // 存储不可用或损坏时视为没有会话。
  }
  return null;
}

export function clearLanSession() {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function saveLanSession(session: LanSession) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

function newToken() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 线上部署时通过 NEXT_PUBLIC_WS_URL 指定中转服务地址（如 wss://ws.example.com）。
 * 未设置时按局域网方式：连页面所在主机的 3456 端口。
 */
export const FIXED_WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? "").trim().replace(/\/+$/, "");

export function hasFixedServer() {
  return FIXED_WS_URL.length > 0;
}

/** 页面地址里的主机名即服务所在机器；对方通过同一个地址打开页面即可。 */
export function defaultLanHost() {
  if (typeof window === "undefined") return "localhost";
  return window.location.hostname || "localhost";
}

export function lanUrl(host: string) {
  if (hasFixedServer()) return FIXED_WS_URL;
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${host}:${DEFAULT_LAN_PORT}`;
}

export class LanClient {
  private socket: WebSocket | null = null;
  private session: LanSession | null = null;
  private intent: ClientMessage | null = null;
  private retry = 0;
  private closed = false;
  private timer: number | undefined;

  constructor(private readonly handlers: LanHandlers) {}

  /** 创建房间并执某一方。 */
  create(host: string, side: Side) {
    this.open(host, { type: "create", token: newToken(), side });
  }

  /** 用房间码加入；token 为空时生成新凭证。 */
  join(host: string, code: string, token = newToken()) {
    this.open(host, { type: "join", token, code });
  }

  /** 用保存的会话恢复座位。 */
  resume(session: LanSession) {
    this.session = session;
    this.open(session.host, { type: "join", token: session.token, code: session.code });
  }

  move(from: Coord, to: Coord) {
    this.send({ type: "move", from, to });
  }

  requestUndo() {
    this.send({ type: "undo-request" });
  }

  replyUndo(accept: boolean) {
    this.send({ type: accept ? "undo-accept" : "undo-decline" });
  }

  resign() {
    this.send({ type: "resign" });
  }

  rematch() {
    this.send({ type: "rematch" });
  }

  get current() {
    return this.session;
  }

  /** 主动退出房间并停止重连。 */
  leave() {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.send({ type: "leave" });
    this.socket?.close();
    this.socket = null;
    this.session = null;
    clearLanSession();
  }

  dispose() {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private open(host: string, intent: ClientMessage) {
    this.closed = false;
    this.intent = intent;
    this.retry = 0;
    this.connect(host);
  }

  private connect(host: string) {
    this.socket?.close();
    let socket: WebSocket;
    try {
      socket = new WebSocket(lanUrl(host));
    } catch {
      this.handlers.onError("无法连接局域网服务，请确认地址是否正确");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.handlers.onConnection(true);
      if (this.intent) socket.send(JSON.stringify(this.intent));
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "seated") {
        const token = this.intent && "token" in this.intent ? this.intent.token : this.session?.token ?? "";
        this.session = { host, code: message.code, token, side: message.side };
        // 之后重连一律按恢复座位处理。
        this.intent = { type: "join", token, code: message.code };
        saveLanSession(this.session);
        this.handlers.onSeated(this.session, message.snapshot);
      } else if (message.type === "state") {
        if (this.session && this.session.side !== message.side) {
          this.session = { ...this.session, side: message.side };
          saveLanSession(this.session);
        }
        this.handlers.onState(message.snapshot, message.side);
      } else {
        this.handlers.onError(message.message);
        // 创建/加入失败不再重试，避免反复弹错。
        if (!this.session) this.closed = true;
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handlers.onConnection(false);
      if (this.closed || event.code === 4000) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(host), delay);
    };
    socket.onerror = () => {
      if (!this.session && this.retry === 0) {
        this.handlers.onError("连不上局域网服务，请确认服务已启动、地址正确");
      }
    };
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    else this.handlers.onError("连接已断开，正在重连…");
  }
}
