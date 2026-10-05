import { initialBoard, legalMoves } from "./chess";
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
  | { type: "PV"; depth?: number; multipv?: number; score?: number; mate?: number; pv?: string[] }
  | { type: "BEST_MOVE"; move?: string }
  | { type: "ERROR"; message?: string };

/** 一条候选着法：分数以行棋方视角计，正数对行棋方有利；mate 为正表示行棋方将在 N 步内将死对方。 */
export interface PikafishCandidate {
  move: EngineMove;
  score: number;
  mate?: number;
  depth: number;
}

export interface PikafishSearchOptions {
  /** 按时间搜索（毫秒）。与 depth 二选一；都没给时默认 5 秒。 */
  movetime?: number;
  /** 按固定深度搜索，用于限制棋力。 */
  depth?: number;
  /** 同时给出前 N 名着法。 */
  multipv?: number;
}

export interface PikafishResult {
  best: EngineMove | null;
  candidates: PikafishCandidate[];
}

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
  /** multipv 序号 → 该序号最新一层的候选 */
  lines: Map<number, { move: string; score: number; mate?: number; depth: number }>;
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
  disposeEngine(new DOMException("Pikafish 引擎分析已取消", "AbortError"));
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
      disposeEngine(new Error("Pikafish 引擎加载超时"));
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
      if (data.type === "PV" && activeSearch && data.pv?.[0] && typeof data.score === "number") {
        activeSearch.lines.set(data.multipv ?? 1, {
          move: data.pv[0],
          score: data.score,
          mate: data.mate,
          depth: data.depth ?? 0,
        });
        return;
      }
      if (data.type === "ERROR") {
        disposeEngine(new Error(data.message || "Pikafish 引擎运行失败"));
      }
    };
    engineWorker.onerror = (event) => {
      disposeEngine(new Error(event.message || "Pikafish 引擎启动失败"));
    };
    engineWorker.postMessage({ type: "INIT" });
  } catch (error) {
    disposeEngine(error instanceof Error ? error : new Error("Pikafish 引擎启动失败"));
  }

  return engineReady;
}

export async function pikafishAnalyze(
  board: Board,
  side: Side,
  options: PikafishSearchOptions,
  onReady?: () => void,
  onProgress?: (progress: PikafishProgress) => void,
  signal?: AbortSignal,
  history?: AdjudicationMove[],
  start?: { board: Board; turn: Side },
): Promise<PikafishResult> {
  if (signal?.aborted) throw new DOMException("Pikafish 引擎分析已取消", "AbortError");
  const handleLoadingAbort = () => disposeEngine(new DOMException("Pikafish 引擎分析已取消", "AbortError"));
  signal?.addEventListener("abort", handleLoadingAbort, { once: true });
  try {
    await ensureEngine();
  } finally {
    signal?.removeEventListener("abort", handleLoadingAbort);
  }
  onReady?.();
  if (!engineWorker) throw new Error("Pikafish 引擎尚未就绪");
  if (activeSearch) throw new Error("Pikafish 引擎正在分析另一局面");

  const movetime = options.depth ? undefined : (options.movetime ?? 5000);
  // 固定深度搜索没有时间上限，给一个宽松的保护值。
  const guardMs = movetime !== undefined ? movetime + 5000 : 30_000;
  const lines = new Map<number, { move: string; score: number; mate?: number; depth: number }>();

  const moveText = await new Promise<string | null>((resolve, reject) => {
    const handleAbort = () => disposeEngine(new DOMException("Pikafish 引擎分析已取消", "AbortError"));
    const timeout = window.setTimeout(() => {
      disposeEngine(new Error("Pikafish 引擎计算超时"));
    }, guardMs);
    activeSearch = { resolve, reject, timeout, onProgress, signal, handleAbort, lines };
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      engineWorker!.postMessage({
        type: "SEARCH",
        // UCI applies moves after the supplied FEN; the full game history
        // must start from the starting position (standard or custom), not the already-played board.
        fen: history?.length ? boardToFen(start?.board ?? initialBoard(), start?.turn ?? "red") : boardToFen(board, side),
        movetime,
        depth: options.depth,
        multipv: options.multipv ?? 1,
        moves: history ? historyToUci(history) : [],
      });
    } catch (error) {
      disposeEngine(error instanceof Error ? error : new Error("Pikafish 引擎搜索启动失败"));
    }
  });

  const isLegal = (move: EngineMove) => {
    const [fr, fc, tr, tc] = move;
    const piece = board[fr]?.[fc];
    return piece?.side === side && legalMoves(board, fr, fc).some(([r, c]) => r === tr && c === tc);
  };

  let best: EngineMove | null = null;
  if (moveText) {
    best = parseMove(moveText);
    if (!best) throw new Error("Pikafish 引擎返回了无效着法");
    if (!isLegal(best)) throw new Error("Pikafish 引擎着法未通过规则校验");
  }

  // 只保留最深一层的候选：各条线深度可能不一致（搜索被打断时），统一到最大深度避免分数不可比。
  const maxDepth = Math.max(0, ...[...lines.values()].map((line) => line.depth));
  const candidates: PikafishCandidate[] = [];
  const seen = new Set<string>();
  for (const line of lines.values()) {
    if (line.depth < maxDepth - 1 || seen.has(line.move)) continue;
    const move = parseMove(line.move);
    if (!move || !isLegal(move)) continue;
    seen.add(line.move);
    candidates.push({ move, score: line.score, mate: line.mate, depth: line.depth });
  }
  candidates.sort((x, y) => y.score - x.score);
  if (best && !candidates.some((item) => item.move.join() === best!.join())) {
    candidates.unshift({ move: best, score: candidates[0]?.score ?? 0, depth: maxDepth });
  }
  return { best, candidates };
}

export async function pikafishBestMove(
  board: Board,
  side: Side,
  moveTimeMs: number,
  onReady?: () => void,
  onProgress?: (progress: PikafishProgress) => void,
  signal?: AbortSignal,
  history?: AdjudicationMove[],
  start?: { board: Board; turn: Side },
): Promise<EngineMove | null> {
  const result = await pikafishAnalyze(board, side, { movetime: moveTimeMs }, onReady, onProgress, signal, history, start);
  return result.best;
}
