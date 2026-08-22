import { aiBestMove } from "./chess";
import type { AiDifficulty, AiOptions, AiSearchProgress, Board } from "./chess";
import { disposePikafish, pikafishBestMove } from "./pikafish";

export type AiLevel = AiDifficulty | "grandmaster";
export type EngineMove = [number, number, number, number];

export const AI_LEVEL_LABEL: Record<AiLevel, string> = {
  beginner: "入门",
  standard: "普通",
  hard: "困难",
  master: "大师",
  grandmaster: "宗师",
};

export const AI_LEVEL_NOTE: Record<AiLevel, string> = {
  beginner: "约2层 · 快速思考 · 偶尔选择次优着",
  standard: "约4层 · 攻守均衡 · 适合日常对弈",
  hard: "最高约6层 · 深入计算 · 更重视连续战术",
  master: "最高约8层 · 动态用时 · 强化攻防与残局判断",
  grandmaster: "Pikafish NNUE · 浏览器多核计算 · 普通玩家极难战胜",
};

const AI_SEARCH_MS: Record<Exclude<AiLevel, "master" | "grandmaster">, number> = {
  beginner: 60,
  standard: 200,
  hard: 500,
};

type AiWorkerMessage = {
  id: number;
  move: EngineMove | null;
  error?: string;
  progress?: AiSearchProgress;
};

type ActiveAnalysis = {
  id: number;
  resolve: (move: EngineMove | null) => void;
  reject: (error: Error) => void;
  timeout: number;
  onProgress?: (progress: AiSearchProgress) => void;
  signal?: AbortSignal;
  handleAbort: () => void;
};

class AiAnalysisBusyError extends Error {
  constructor() {
    super("后台棋局分析正在处理另一局面");
    this.name = "AiAnalysisBusyError";
  }
}

let workerRequestId = 0;
let sharedAiWorker: Worker | null = null;
let activeAnalysis: ActiveAnalysis | null = null;

function abortError() {
  return new DOMException("棋局分析已取消", "AbortError");
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

function takeActiveAnalysis() {
  const active = activeAnalysis;
  if (!active) return null;
  activeAnalysis = null;
  window.clearTimeout(active.timeout);
  active.signal?.removeEventListener("abort", active.handleAbort);
  return active;
}

function stopSharedAiWorker(error: Error) {
  const active = takeActiveAnalysis();
  sharedAiWorker?.terminate();
  sharedAiWorker = null;
  active?.reject(error);
}

export function disposeAiClient() {
  stopSharedAiWorker(abortError());
  disposePikafish();
}

function isWorkerMessage(value: unknown): value is AiWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<AiWorkerMessage>;
  return typeof message.id === "number" && (message.move === null || Array.isArray(message.move));
}

function ensureSharedAiWorker() {
  if (sharedAiWorker) return sharedAiWorker;
  const worker = new Worker(new URL("../workers/chess-ai.worker.ts", import.meta.url), {
    type: "module",
    name: "chess-ai",
  });
  sharedAiWorker = worker;
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (!isWorkerMessage(event.data)) {
      stopSharedAiWorker(new Error("后台棋局分析返回了无效数据"));
      return;
    }
    const active = activeAnalysis;
    if (!active || event.data.id !== active.id) return;
    if (event.data.progress) {
      active.onProgress?.(event.data.progress);
      return;
    }
    const finished = takeActiveAnalysis();
    if (!finished) return;
    if (event.data.error) finished.reject(new Error(event.data.error));
    else finished.resolve(event.data.move);
  };
  worker.onerror = (event) => {
    if (sharedAiWorker !== worker) return;
    stopSharedAiWorker(new Error(event.message || "后台棋局分析失败"));
  };
  return worker;
}

function analyzeInWorker(
  board: Board,
  options: AiOptions,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
): Promise<EngineMove | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (activeAnalysis) {
      reject(new AiAnalysisBusyError());
      return;
    }
    const worker = ensureSharedAiWorker();
    const id = ++workerRequestId;
    const handleAbort = () => {
      if (activeAnalysis?.id === id) stopSharedAiWorker(abortError());
    };
    const timeout = window.setTimeout(() => {
      if (activeAnalysis?.id === id) stopSharedAiWorker(new Error("后台棋局分析超时"));
    }, Math.max(8000, (options.timeMs ?? 0) + 2000));
    activeAnalysis = { id, resolve, reject, timeout, onProgress, signal, handleAbort };
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      worker.postMessage({ id, board, options, reportProgress: !!onProgress });
    } catch (error) {
      stopSharedAiWorker(error instanceof Error ? error : new Error("后台棋局分析启动失败"));
    }
  });
}

async function analyzeMove(
  board: Board,
  options: AiOptions,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
) {
  try {
    return await analyzeInWorker(board, options, onProgress, signal);
  } catch (error) {
    if (isAbortError(error) || error instanceof AiAnalysisBusyError) throw error;
    console.warn("AI Worker 不可用，已切换为兼容计算模式。", error);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal?.aborted) throw abortError();
    return aiBestMove(board, {
      ...options,
      timeMs: Math.min(options.timeMs ?? 220, 220),
      onProgress,
    });
  }
}

export async function analyzeAtLevel(
  board: Board,
  level: AiLevel,
  options: Omit<AiOptions, "difficulty">,
  grandmasterTimeMs: number,
  onGrandmasterReady?: () => void,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
) {
  if (level !== "grandmaster") {
    return analyzeMove(board, { ...options, difficulty: level }, onProgress, signal);
  }
  try {
    return await pikafishBestMove(
      board,
      options.side ?? "black",
      grandmasterTimeMs,
      onGrandmasterReady,
      (progress) => onProgress?.({
        depth: progress.depth ?? 0,
        nodes: progress.nodes ?? 0,
        elapsedMs: progress.time ?? 0,
      }),
      signal,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn("宗师引擎不可用，已切换为大师兼容模式。", error);
    return analyzeMove(
      board,
      { ...options, difficulty: "master", timeMs: Math.min(options.timeMs ?? 800, 800) },
      onProgress,
      signal,
    );
  }
}

export function aiSearchBudget(level: AiLevel, blackTime: number) {
  if (level === "master") return Math.min(1500, Math.max(800, blackTime * 2));
  if (level === "grandmaster") return Math.min(2200, Math.max(1200, blackTime * 3));
  return AI_SEARCH_MS[level];
}
