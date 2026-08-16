import { legalMoves } from "./chess";
import type { Board, PieceType, Side } from "./chess";

type EngineMove = [number, number, number, number];

export interface PikafishProgress {
  depth?: number;
  nodes?: number;
  time?: number;
}

type EngineMessage =
  | { type: "READY"; threads?: number }
  | { type: "INFO"; info?: PikafishProgress }
  | { type: "BEST_MOVE"; move?: string }
  | { type: "ERROR"; message?: string };

const PIECE_FEN: Record<PieceType, string> = {
  K: "k",
  A: "a",
  B: "b",
  N: "n",
  R: "r",
  C: "c",
  P: "p",
};

let engineWorker: Worker | null = null;
let engineReady: Promise<void> | null = null;
let resolveReady: (() => void) | null = null;
let rejectReady: ((error: Error) => void) | null = null;
let activeSearch: {
  resolve: (move: string | null) => void;
  reject: (error: Error) => void;
  timeout: number;
  onProgress?: (progress: PikafishProgress) => void;
} | null = null;

function boardToFen(board: Board, side: Side) {
  const rows = board.map((row) => {
    let empty = 0;
    let text = "";
    for (const piece of row) {
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) {
        text += empty;
        empty = 0;
      }
      const symbol = PIECE_FEN[piece.t];
      text += piece.side === "red" ? symbol.toUpperCase() : symbol;
    }
    return text + (empty || "");
  });
  return `${rows.join("/")} ${side === "red" ? "w" : "b"} - - 0 1`;
}

function parseMove(move: string): EngineMove | null {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(move)) return null;
  return [
    9 - Number(move[1]),
    move.charCodeAt(0) - 97,
    9 - Number(move[3]),
    move.charCodeAt(2) - 97,
  ];
}

function disposeEngine(error: Error) {
  engineWorker?.terminate();
  engineWorker = null;
  engineReady = null;
  rejectReady?.(error);
  rejectReady = null;
  resolveReady = null;
  if (activeSearch) {
    window.clearTimeout(activeSearch.timeout);
    activeSearch.reject(error);
    activeSearch = null;
  }
}

function ensureEngine() {
  if (engineReady) return engineReady;

  engineReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  try {
    engineWorker = new Worker("/js/worker/pikafish-engine.js");
    const loadingTimeout = window.setTimeout(() => {
      disposeEngine(new Error("宗师引擎加载超时"));
    }, 120_000);

    engineWorker.onmessage = (event: MessageEvent<EngineMessage>) => {
      const data = event.data;
      if (data.type === "READY") {
        window.clearTimeout(loadingTimeout);
        resolveReady?.();
        resolveReady = null;
        rejectReady = null;
        return;
      }
      if (data.type === "BEST_MOVE" && activeSearch) {
        const search = activeSearch;
        activeSearch = null;
        window.clearTimeout(search.timeout);
        search.resolve(data.move && data.move !== "(none)" ? data.move : null);
        return;
      }
      if (data.type === "INFO" && data.info && activeSearch) {
        activeSearch.onProgress?.(data.info);
        return;
      }
      if (data.type === "ERROR") {
        disposeEngine(new Error(data.message || "宗师引擎运行失败"));
      }
    };
    engineWorker.onerror = (event) => {
      window.clearTimeout(loadingTimeout);
      disposeEngine(new Error(event.message || "宗师引擎启动失败"));
    };
    engineWorker.postMessage({ type: "INIT" });
  } catch (error) {
    disposeEngine(error instanceof Error ? error : new Error("宗师引擎启动失败"));
  }

  return engineReady;
}

export async function pikafishBestMove(
  board: Board,
  side: Side,
  moveTimeMs: number,
  onReady?: () => void,
  onProgress?: (progress: PikafishProgress) => void,
): Promise<EngineMove | null> {
  await ensureEngine();
  onReady?.();
  if (!engineWorker) throw new Error("宗师引擎尚未就绪");
  if (activeSearch) throw new Error("宗师引擎正在分析另一局面");

  const moveText = await new Promise<string | null>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      engineWorker?.postMessage({ type: "STOP" });
      if (!activeSearch) return;
      activeSearch = null;
      reject(new Error("宗师引擎计算超时"));
    }, moveTimeMs + 5000);
    activeSearch = { resolve, reject, timeout, onProgress };
    engineWorker!.postMessage({
      type: "SEARCH",
      fen: boardToFen(board, side),
      movetime: moveTimeMs,
    });
  });

  if (!moveText) return null;
  const move = parseMove(moveText);
  if (!move) throw new Error("宗师引擎返回了无效着法");
  const [fr, fc, tr, tc] = move;
  const piece = board[fr]?.[fc];
  const legal = piece?.side === side && legalMoves(board, fr, fc).some(([r, c]) => r === tr && c === tc);
  if (!legal) throw new Error("宗师引擎着法未通过规则校验");
  return move;
}
