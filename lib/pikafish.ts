import { legalMoves } from "./chess";
import type { AdjudicationMove, Board, PieceType, Side } from "./chess";

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
let engineLoadingTimeout: number | null = null;
let activeSearch: {
  resolve: (move: string | null) => void;
  reject: (error: Error) => void;
  timeout: number;
  onProgress?: (progress: PikafishProgress) => void;
  signal?: AbortSignal;
  handleAbort: () => void;
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

function moveToUci(move: AdjudicationMove): string {
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;
  const fromFile = String.fromCharCode(97 + fc);
  const toFile = String.fromCharCode(97 + tc);
  return `${fromFile}${9 - fr}${toFile}${9 - tr}`;
}

function historyToUci(history: AdjudicationMove[]): string[] {
  return history.map(moveToUci);
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

function takeActiveSearch() {
  const search = activeSearch;
  if (!search) return null;
  activeSearch = null;
  window.clearTimeout(search.timeout);
  search.signal?.removeEventListener("abort", search.handleAbort);
  return search;
}

function disposeEngine(error: Error) {
  engineWorker?.terminate();
  engineWorker = null;
  engineReady = null;
  if (engineLoadingTimeout !== null) window.clearTimeout(engineLoadingTimeout);
  engineLoadingTimeout = null;
  rejectReady?.(error);
  rejectReady = null;
  resolveReady = null;
  takeActiveSearch()?.reject(error);
}

export function disposePikafish() {
  disposeEngine(new DOMException("宗师引擎分析已取消", "AbortError"));
}

function ensureEngine() {
  if (engineReady) return engineReady;

  engineReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  try {
    engineWorker = new Worker("/js/worker/pikafish-engine.js");
    engineLoadingTimeout = window.setTimeout(() => {
      disposeEngine(new Error("宗师引擎加载超时"));
    }, 120_000);

    engineWorker.onmessage = (event: MessageEvent<EngineMessage>) => {
      const data = event.data;
      if (data.type === "READY") {
        if (engineLoadingTimeout !== null) window.clearTimeout(engineLoadingTimeout);
        engineLoadingTimeout = null;
        resolveReady?.();
        resolveReady = null;
        rejectReady = null;
        return;
      }
      if (data.type === "BEST_MOVE" && activeSearch) {
        const search = takeActiveSearch();
        if (!search) return;
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
  signal?: AbortSignal,
  history?: AdjudicationMove[],
): Promise<EngineMove | null> {
  if (signal?.aborted) throw new DOMException("宗师引擎分析已取消", "AbortError");
  const handleLoadingAbort = () => disposeEngine(new DOMException("宗师引擎分析已取消", "AbortError"));
  signal?.addEventListener("abort", handleLoadingAbort, { once: true });
  try {
    await ensureEngine();
  } finally {
    signal?.removeEventListener("abort", handleLoadingAbort);
  }
  onReady?.();
  if (!engineWorker) throw new Error("宗师引擎尚未就绪");
  if (activeSearch) throw new Error("宗师引擎正在分析另一局面");

  const moveText = await new Promise<string | null>((resolve, reject) => {
    const handleAbort = () => disposeEngine(new DOMException("宗师引擎分析已取消", "AbortError"));
    const timeout = window.setTimeout(() => {
      disposeEngine(new Error("宗师引擎计算超时"));
    }, moveTimeMs + 5000);
    activeSearch = { resolve, reject, timeout, onProgress, signal, handleAbort };
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      engineWorker!.postMessage({
        type: "SEARCH",
        fen: boardToFen(board, side),
        movetime: moveTimeMs,
        moves: history ? historyToUci(history) : [],
      });
    } catch (error) {
      disposeEngine(error instanceof Error ? error : new Error("宗师引擎搜索启动失败"));
    }
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
