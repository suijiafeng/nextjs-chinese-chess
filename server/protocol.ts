import type { Side } from "../lib/chess";
import type { Coord } from "../lib/game-core";
import type { RoomSnapshot } from "./room";

/** 浏览器与局域网服务端之间的消息。两端共用这份定义。 */

export type ClientMessage =
  | { type: "create"; token: string; side: Side }
  | { type: "join"; token: string; code: string }
  | { type: "move"; from: Coord; to: Coord }
  | { type: "undo-request" }
  | { type: "undo-accept" }
  | { type: "undo-decline" }
  | { type: "resign" }
  | { type: "rematch" }
  | { type: "leave" };

export type ServerMessage =
  | { type: "seated"; code: string; side: Side; snapshot: RoomSnapshot }
  | { type: "state"; snapshot: RoomSnapshot; side: Side }
  | { type: "error"; message: string };

export const DEFAULT_LAN_PORT = 3456;
