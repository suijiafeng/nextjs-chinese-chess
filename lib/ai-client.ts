import { aiBestMove } from "./chess";
import type { AiDifficulty, AiOptions, AiSearchProgress, Board } from "./chess";
import { disposePikafish, pikafishAnalyze } from "./pikafish";
import type { PikafishCandidate } from "./pikafish";

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
  beginner: "2 层搜索 · 常走随手棋 · 刚学规则也能赢",
  standard: "4 层搜索 · 偶有失误 · 业余爱好者",
  hard: "7 层搜索 · 很少失误 · 需要认真应对",
  master: "12 层搜索 · 不犯错 · 地方高手",
  grandmaster: "全力 10 秒 · 远超人类",
};

/**
 * 各档位的搜索计划。Pikafish 没有 Skill Level 选项，这里用「固定深度 + 多候选 + 按分差随机」限制棋力：
 * window 是允许偏离最佳着的分数窗口（厘兵），temperature 越大越容易选到差着。
 */
export interface LevelPlan {
  depth?: number;
  multipv: number;
  window: number;
  temperature: number;
  /** Pikafish 不可用时退回内置引擎的档位 */
  fallback: AiDifficulty;
}

export const LEVEL_PLAN: Record<AiLevel, LevelPlan> = {
  beginner: { depth: 2, multipv: 8, window: 300, temperature: 160, fallback: "beginner" },
  standard: { depth: 4, multipv: 5, window: 150, temperature: 70, fallback: "standard" },
  hard: { depth: 7, multipv: 3, window: 60, temperature: 28, fallback: "hard" },
  master: { depth: 12, multipv: 1, window: 0, temperature: 1, fallback: "hard" },
  grandmaster: { multipv: 1, window: 0, temperature: 1, fallback: "hard" },
};

/** 在最佳着附近按分差加权随机：分差越小权重越大；必胜/必败的局面不随机。 */
export function pickCandidate(candidates: PikafishCandidate[], plan: LevelPlan, random = Math.random): EngineMove | null {
  if (!candidates.length) return null;
  const best = candidates[0];
  if (plan.window <= 0 || (best.mate !== undefined && best.mate > 0)) return best.move;
  const pool = candidates.filter((item) =>
    best.score - item.score <= plan.window && (item.mate === undefined || item.mate > 0));
  if (pool.length <= 1) return best.move;
  const weights = pool.map((item) => Math.exp(-(best.score - item.score) / plan.temperature));
  let roll = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return pool[index].move;
  }
  return pool[pool.length - 1].move;
}

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

export interface LevelAnalysisOptions extends Omit<AiOptions, "difficulty"> {
  /** 不做随机降智，直接取引擎最佳着（用于「提示」）。 */
  deterministic?: boolean;
  /** 强制使用内置引擎（它会自行排除长将/长捉禁着）。 */
  forceBuiltin?: boolean;
}

export async function analyzeAtLevel(
  board: Board,
  level: AiLevel,
  options: LevelAnalysisOptions,
  pikafishTimeMs: number,
  onPikafishReady?: () => void,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
) {
  const plan = LEVEL_PLAN[level];
  const { deterministic, forceBuiltin, ...searchOptions } = options;
  const builtin = () => analyzeMove(
    board,
    { ...searchOptions, difficulty: plan.fallback, timeMs: Math.min(searchOptions.timeMs ?? 800, plan.fallback === "hard" ? 800 : 400) },
    onProgress,
    signal,
  );
  if (forceBuiltin) return builtin();
  try {
    const result = await pikafishAnalyze(
      board,
      searchOptions.side ?? "black",
      plan.depth
        ? { depth: plan.depth, multipv: deterministic ? 1 : plan.multipv }
        : { movetime: pikafishTimeMs, multipv: 1 },
      onPikafishReady,
      (progress) => onProgress?.({
        depth: progress.depth ?? 0,
        nodes: progress.nodes ?? 0,
        elapsedMs: progress.time ?? 0,
      }),
      signal,
      searchOptions.history,
    );
    if (deterministic || !plan.depth) return result.best;
    return pickCandidate(result.candidates, plan) ?? result.best;
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn("Pikafish 引擎不可用，已切换为内置引擎。", error);
    return builtin();
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
