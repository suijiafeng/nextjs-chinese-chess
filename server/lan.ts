import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import {
  acceptUndo,
  applyMove,
  createRoom,
  declineUndo,
  leaveSeat,
  requestRematch,
  requestUndo,
  resign,
  RoomError,
  snapshot,
  startIfReady,
  takeSeat,
  tickClock,
} from "./room";
import type { Room } from "./room";
import { DEFAULT_LAN_PORT } from "./protocol";
import type { ClientMessage, ServerMessage } from "./protocol";
import type { Side } from "../lib/chess";

/**
 * 局域网对弈中转服务。启动：`npm run lan`，默认端口 3456，可用 LAN_PORT 覆盖。
 * 房间只存在内存里，服务重启即清空；空房间两小时后回收。
 */

const PORT = Number(process.env.LAN_PORT) || DEFAULT_LAN_PORT;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const rooms = new Map<string, Room>();
/** 每条连接当前坐在哪个房间的哪一方。 */
const sessions = new WeakMap<WebSocket, { room: Room; side: Side }>();
/** 房间内各方的连接，用于广播。 */
const links = new Map<Room, Partial<Record<Side, WebSocket>>>();

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room: Room) {
  const snap = snapshot(room, Date.now());
  for (const [side, socket] of Object.entries(links.get(room) ?? {}) as [Side, WebSocket | undefined][]) {
    if (socket) send(socket, { type: "state", snapshot: snap, side });
  }
}

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new RoomError("房间太多，请稍后再试");
}

function seat(socket: WebSocket, room: Room, token: string, preferred?: Side) {
  const side = takeSeat(room, token, preferred);
  const existing = links.get(room)?.[side];
  if (existing && existing !== socket) existing.close(4000, "座位已在别处恢复");
  links.set(room, { ...links.get(room), [side]: socket });
  sessions.set(socket, { room, side });
  startIfReady(room, Date.now());
  send(socket, { type: "seated", code: room.code, side, snapshot: snapshot(room, Date.now()) });
  broadcast(room);
}

function handle(socket: WebSocket, message: ClientMessage) {
  const now = Date.now();
  if (message.type === "create") {
    const room = createRoom(newCode(), now);
    rooms.set(room.code, room);
    seat(socket, room, message.token, message.side);
    return;
  }
  if (message.type === "join") {
    const room = rooms.get(message.code.trim());
    if (!room) throw new RoomError("找不到这个房间，请核对房间码");
    seat(socket, room, message.token);
    return;
  }

  const session = sessions.get(socket);
  if (!session) throw new RoomError("尚未加入房间");
  const { room, side } = session;
  switch (message.type) {
    case "move":
      applyMove(room, side, message.from, message.to, now);
      break;
    case "undo-request":
      requestUndo(room, side);
      break;
    case "undo-accept":
      acceptUndo(room, side, now);
      break;
    case "undo-decline":
      declineUndo(room, side);
      break;
    case "resign":
      resign(room, side, now);
      break;
    case "rematch":
      if (requestRematch(room, side, now)) {
        // 交换颜色后，连接要跟着座位走。
        const current = links.get(room) ?? {};
        links.set(room, { red: current.black, black: current.red });
        for (const [seatSide, socket] of Object.entries(links.get(room) ?? {}) as [Side, WebSocket | undefined][]) {
          const existing = socket && sessions.get(socket);
          if (socket && existing) sessions.set(socket, { room, side: seatSide });
        }
      }
      break;
    case "leave":
      detach(socket);
      return;
  }
  broadcast(room);
}

function detach(socket: WebSocket) {
  const session = sessions.get(socket);
  if (!session) return;
  const { room, side } = session;
  sessions.delete(socket);
  const current = links.get(room);
  if (current?.[side] === socket) {
    delete current[side];
    leaveSeat(room, side);
    broadcast(room);
  }
}

const server = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      send(socket, { type: "error", message: "消息格式不正确" });
      return;
    }
    try {
      handle(socket, message);
    } catch (error) {
      send(socket, { type: "error", message: error instanceof RoomError ? error.message : "服务端处理失败" });
      if (!(error instanceof RoomError)) console.error(error);
    }
  });
  socket.on("close", () => detach(socket));
});

// 每秒检查超时；顺手回收长期无人的房间。
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (tickClock(room, now)) broadcast(room);
    const anyone = Object.values(links.get(room) ?? {}).some(Boolean);
    if (!anyone && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      links.delete(room);
    }
  }
}, 1000);

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item && item.family === "IPv4" && !item.internal)
  .map((item) => item!.address);
console.log(`局域网对弈服务已启动，端口 ${PORT}`);
if (addresses.length) console.log(`对方打开页面时填写本机地址：${addresses.join(" 或 ")}`);
