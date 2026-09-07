import { aiBestMove } from "./chess";
import type { AiDifficulty, AiOptions, AiSearchProgress, Board } from "./chess";
import { disposePikafish, pikafishBestMove } from "./pikafish";

export type AiLevel = AiDifficulty | "master" | "grandmaster";
export type EngineMove = [number, number, number, number];

export const AI_LEVEL_LABEL: Record<AiLevel, string> = {
  beginner: "入门",
  standard: "普通",
  hard: "困难",
  master: "大师",
  grandmaster: "宗师",
};

export const AI_LEVEL_NOTE: Record<AiLevel, string> = {
  beginner: "最高约2层 · 200～350ms预算 · 偶尔选择次优着",
  standard: "最高约4层 · 500ms～1秒预算 · 攻守均衡",
  hard: "最高约10层 · 最多3秒思考 · 加强连续战术",
  master: "Pikafish NNUE · 浏览器多核计算 · 最多5秒思考",
  grandmaster: "Pikafish NNUE · 浏览器多核计算 · 最多10秒思考",
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
  pikafishTimeMs: number,
  onPikafishReady?: () => void,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
) {
  if (level !== "master" && level !== "grandmaster") {
    return analyzeMove(board, { ...options, difficulty: level }, onProgress, signal);
  }
  try {
    return await pikafishBestMove(
      board,
      options.side ?? "black",
      pikafishTimeMs,
      onPikafishReady,
      (progress) => onProgress?.({
        depth: progress.depth ?? 0,
        nodes: progress.nodes ?? 0,
        elapsedMs: progress.time ?? 0,
      }),
      signal,
      options.history,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn("Pikafish 引擎不可用，已切换为困难兼容模式。", error);
    return analyzeMove(
      board,
      { ...options, difficulty: "hard", timeMs: Math.min(options.timeMs ?? 800, 800) },
      onProgress,
      signal,
    );
  }
}

export function aiSearchBudget(level: AiLevel, remainingSeconds: number) {
  // 棋时充足时使用上限；不足五分钟时逐渐收紧低难度预算。
  const clockRatio = Math.min(1, Math.max(0, remainingSeconds / 300));
  const target = level === "beginner" ? 200 + 150 * clockRatio
    : level === "standard" ? 500 + 500 * clockRatio
    : level === "hard" ? 3000
    : level === "master" ? 5000
    : 10000;
  // 紧急读秒时允许低于常规预算，给落子留下余量。
  const clockBudget = Math.max(30, remainingSeconds * 1000 * 0.05);
  return Math.round(Math.min(target, clockBudget));
}
