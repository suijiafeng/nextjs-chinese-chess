"use client";

import {
  aiBestMove,
  chaseCandidates,
  cloneBoard,
  findKing,
  hasAnyMove,
  inCheck,
  initialBoard,
  legalMoves,
  materialDrawAdjudication,
  naturalMoveAdjudication,
  NAMES,
  positionKey,
  repetitionAdjudication,
} from "@/lib/chess";
import type { AdjudicationMove, AiDifficulty, AiOptions, AiSearchProgress, Board, ChaseCandidate, Piece, Side } from "@/lib/chess";
import { pikafishBestMove } from "@/lib/pikafish";
import ChessAiWorker from "../workers/chess-ai.worker?worker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

type Coord = [number, number];
type GameMode = "ai" | "local";
type AiLevel = AiDifficulty | "grandmaster";
type SoundKind = "move" | "capture" | "check" | "win" | "lose" | "draw";

interface MoveRecord extends AdjudicationMove {
  before: Board;
  turnBefore: Side;
  notation: string;
  redTime: number;
  blackTime: number;
  chaseCandidates: ChaseCandidate[];
}

interface GameResult {
  winner: Side | null;
  message: string;
}

interface HintMove {
  from: Coord;
  to: Coord;
  notation: string;
}

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const AI_LEVEL_LABEL: Record<AiLevel, string> = { beginner: "入门", standard: "普通", hard: "困难", master: "大师", grandmaster: "宗师" };
const AI_LEVEL_NOTE: Record<AiLevel, string> = {
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

let workerRequestId = 0;

type AiWorkerMessage = {
  id: number;
  move: [number, number, number, number] | null;
  error?: string;
  progress?: AiSearchProgress;
};

type ActiveAnalysis = {
  id: number;
  resolve: (move: [number, number, number, number] | null) => void;
  reject: (error: Error) => void;
  timeout: number;
  onProgress?: (progress: AiSearchProgress) => void;
  signal?: AbortSignal;
  handleAbort: () => void;
};

let sharedAiWorker: Worker | null = null;
let activeAnalysis: ActiveAnalysis | null = null;

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

function ensureSharedAiWorker() {
  if (sharedAiWorker) return sharedAiWorker;
  const worker = new ChessAiWorker();
  sharedAiWorker = worker;
  worker.onmessage = (event: MessageEvent<AiWorkerMessage>) => {
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
): Promise<[number, number, number, number] | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("棋局分析已取消", "AbortError"));
      return;
    }
    if (activeAnalysis) {
      reject(new Error("后台棋局分析正在处理另一局面"));
      return;
    }
    const worker = ensureSharedAiWorker();
    const id = ++workerRequestId;
    const handleAbort = () => {
      if (activeAnalysis?.id !== id) return;
      stopSharedAiWorker(new DOMException("棋局分析已取消", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      if (activeAnalysis?.id !== id) return;
      stopSharedAiWorker(new Error("后台棋局分析超时"));
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
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.warn("AI Worker 不可用，已切换为兼容计算模式。", error);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException("棋局分析已取消", "AbortError");
    return aiBestMove(board, {
      ...options,
      timeMs: Math.min(options.timeMs ?? 220, 220),
      onProgress,
    });
  }
}

async function analyzeAtLevel(
  board: Board,
  level: AiLevel,
  options: Omit<AiOptions, "difficulty">,
  grandmasterTimeMs: number,
  onGrandmasterReady?: () => void,
  onProgress?: (progress: AiSearchProgress) => void,
  signal?: AbortSignal,
) {
  if (level !== "grandmaster") return analyzeMove(board, { ...options, difficulty: level }, onProgress, signal);
  try {
    return await pikafishBestMove(
      board,
      options.side ?? "black",
      grandmasterTimeMs,
      onGrandmasterReady,
      (progress) => onProgress?.({ depth: progress.depth ?? 0, nodes: progress.nodes ?? 0, elapsedMs: progress.time ?? 0 }),
    );
  } catch (error) {
    console.warn("宗师引擎不可用，已切换为大师兼容模式。", error);
    return analyzeMove(board, { ...options, difficulty: "master", timeMs: Math.min(options.timeMs ?? 800, 800) }, onProgress, signal);
  }
}

function aiSearchBudget(level: AiLevel, blackTime: number) {
  if (level === "master") return Math.min(1500, Math.max(800, blackTime * 2));
  if (level === "grandmaster") return Math.min(2200, Math.max(1200, blackTime * 3));
  return AI_SEARCH_MS[level];
}

function sameCoord(a: Coord | null, r: number, c: number) {
  return !!a && a[0] === r && a[1] === c;
}

function formatTime(total: number) {
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function fileName(side: Side, col: number) {
  return CN_NUM[side === "red" ? 8 - col : col];
}

function moveNotation(piece: Piece, from: Coord, to: Coord) {
  const [fr, fc] = from;
  const [tr, tc] = to;
  const name = NAMES[piece.side][piece.t];
  const origin = fileName(piece.side, fc);

  if (fr === tr) return `${name}${origin}平${fileName(piece.side, tc)}`;

  const forward = piece.side === "red" ? tr < fr : tr > fr;
  const action = forward ? "进" : "退";
  const destination = ["N", "B", "A"].includes(piece.t)
    ? fileName(piece.side, tc)
    : CN_NUM[Math.abs(tr - fr) - 1];
  return `${name}${origin}${action}${destination}`;
}

export default function Home() {
  const [board, setBoard] = useState<Board>(() => initialBoard());
  const [turn, setTurn] = useState<Side>("red");
  const [selected, setSelected] = useState<Coord | null>(null);
  const [targets, setTargets] = useState<Coord[]>([]);
  const [history, setHistory] = useState<MoveRecord[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [mode, setMode] = useState<GameMode>("ai");
  const [aiDifficulty, setAiDifficulty] = useState<AiLevel>("standard");
  const [grandmasterReady, setGrandmasterReady] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [aiThinking, setAiThinking] = useState(false);
  const [hintThinking, setHintThinking] = useState(false);
  const [hint, setHint] = useState<HintMove | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [resultDismissed, setResultDismissed] = useState(false);
  const [times, setTimes] = useState({ red: 900, black: 900 });
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const hintRequestRef = useRef(0);
  const timesRef = useRef(times);

  useEffect(() => {
    timesRef.current = times;
  }, [times]);

  const reviewing = reviewPly !== null;
  const visiblePly = reviewPly ?? history.length;
  const visibleBoard = useMemo(() => {
    if (!reviewing || visiblePly === history.length) return board;
    return cloneBoard(history[visiblePly]?.before ?? history[0]?.before ?? initialBoard());
  }, [board, history, reviewing, visiblePly]);
  const visibleTurn = reviewing && visiblePly < history.length
    ? history[visiblePly].turnBefore
    : turn;
  const visibleLastMove = visiblePly > 0
    ? { from: history[visiblePly - 1].from, to: history[visiblePly - 1].to }
    : null;
  const checked = useMemo(() => !!findKing(visibleBoard, visibleTurn) && inCheck(visibleBoard, visibleTurn), [visibleBoard, visibleTurn]);

  useEffect(() => {
    if (window.crossOriginIsolated || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/coi-serviceworker.js")
      .then(async () => {
        if (!navigator.serviceWorker.controller) {
          await navigator.serviceWorker.ready;
          window.location.reload();
        }
      })
      .catch((error) => console.warn("浏览器多核计算环境初始化失败，将使用兼容模式。", error));
  }, []);

  const playSound = useCallback((kind: SoundKind) => {
    if (!soundOn || typeof window === "undefined") return;
    try {
      const context = audioRef.current ?? new AudioContext();
      audioRef.current = context;
      if (context.state === "suspended") void context.resume();

      const strike = (
        offset: number,
        frequency: number,
        duration: number,
        volume: number,
        type: OscillatorType = "triangle",
      ) => {
        const start = context.currentTime + offset;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(55, frequency * 0.72), start + duration);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
      };

      const woodTap = (volume = 0.13) => {
        const length = Math.floor(context.sampleRate * 0.055);
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < length; index++) {
          const decay = Math.pow(1 - index / length, 4);
          data[index] = (Math.random() * 2 - 1) * decay;
        }
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const gain = context.createGain();
        filter.type = "bandpass";
        filter.frequency.value = 520;
        filter.Q.value = 0.8;
        gain.gain.value = volume;
        source.buffer = buffer;
        source.connect(filter).connect(gain).connect(context.destination);
        source.start();
      };

      if (kind === "move") {
        woodTap();
        strike(0, 155, 0.09, 0.08);
      } else if (kind === "capture") {
        woodTap(0.17);
        strike(0, 135, 0.12, 0.12, "square");
        strike(0.075, 92, 0.16, 0.08);
      } else if (kind === "check") {
        woodTap(0.12);
        strike(0, 260, 0.13, 0.09);
        strike(0.14, 390, 0.22, 0.12, "sine");
      } else if (kind === "draw") {
        [294, 392, 294].forEach((frequency, index) => strike(index * 0.16, frequency, 0.3, 0.075, "sine"));
      } else {
        const notes = kind === "win"
          ? [330, 440, 550, 660]
          : [330, 247, 185, 123];
        notes.forEach((frequency, index) => {
          strike(index * 0.15, frequency, index === notes.length - 1 ? 0.48 : 0.24, 0.09, "sine");
        });
      }
    } catch {
      // 声音不可用不影响对局本身。
    }
  }, [soundOn]);

  const startNewGame = useCallback((nextMode: GameMode = mode) => {
    hintRequestRef.current++;
    setMode(nextMode);
    setBoard(initialBoard());
    setTurn("red");
    setSelected(null);
    setTargets([]);
    setHistory([]);
    setResult(null);
    setEngineError(null);
    setResultDismissed(false);
    setAiThinking(false);
    setHintThinking(false);
    setHint(null);
    setTimes({ red: 900, black: 900 });
    setReviewPly(null);
  }, [mode]);

  const commitMove = useCallback((from: Coord, to: Coord) => {
    const [fr, fc] = from;
    const [tr, tc] = to;
    const piece = board[fr]?.[fc];
    if (!piece || piece.side !== turn) return false;

    const allowed = legalMoves(board, fr, fc).some(([r, c]) => r === tr && c === tc);
    if (!allowed) return false;

    const before = cloneBoard(board);
    const captured = board[tr][tc] ? { ...board[tr][tc]! } : null;
    const next = cloneBoard(board);
    next[tr][tc] = { ...piece };
    next[fr][fc] = null;

    const nextTurn: Side = turn === "red" ? "black" : "red";
    const kingAlive = !!findKing(next, nextTurn);
    const gaveCheck = kingAlive && inCheck(next, nextTurn);
    const record: MoveRecord = {
      before,
      turnBefore: turn,
      from,
      to,
      mover: { ...piece },
      captured,
      notation: moveNotation(piece, from, to),
      check: gaveCheck,
      positionKey: positionKey(next, nextTurn),
      chaseCandidates: chaseCandidates(next, to, gaveCheck),
      redTime: timesRef.current.red,
      blackTime: timesRef.current.black,
    };
    const nextHistory = [...history, record];
    let gameResult: GameResult | null = null;

    if (!kingAlive) {
      gameResult = { winner: turn, message: `${turn === "red" ? "红方" : "黑方"}擒将取胜` };
    } else if (!hasAnyMove(next, nextTurn)) {
      gameResult = {
        winner: turn,
        message: gaveCheck ? "将死，对局结束" : "困毙，对局结束",
      };
    } else {
      gameResult = materialDrawAdjudication(next)
        ?? repetitionAdjudication(positionKey(initialBoard(), "red"), nextHistory)
        ?? naturalMoveAdjudication(nextHistory);
    }

    setBoard(next);
    setHistory(nextHistory);
    setSelected(null);
    setTargets([]);
    setHint(null);
    setTurn(nextTurn);
    setReviewPly(null);
    setResult(gameResult);
    if (gameResult) setResultDismissed(false);

    if (!gameResult) {
      if (gaveCheck) playSound("check");
      else playSound(captured ? "capture" : "move");
    }
    return true;
  }, [board, history, playSound, turn]);

  useEffect(() => {
    if (result || engineError || reviewing || hintThinking) return;
    const timer = window.setInterval(() => {
      setTimes((current) => ({
        ...current,
        [turn]: Math.max(0, current[turn] - 1),
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [engineError, hintThinking, result, reviewing, turn]);

  useEffect(() => {
    if (result || engineError || reviewing || times[turn] > 0) return;
    const winner: Side = turn === "red" ? "black" : "red";
    setResult({ winner, message: `${turn === "red" ? "红方" : "黑方"}用时耗尽` });
    setResultDismissed(false);
  }, [engineError, result, reviewing, times, turn]);

  useEffect(() => {
    if (!result) return;
    if (!result.winner) {
      playSound("draw");
      return;
    }
    const lostToComputer = mode === "ai" && result.winner === "black";
    playSound(lostToComputer ? "lose" : "win");
  }, [mode, playSound, result]);

  useEffect(() => {
    if (mode !== "ai" || turn !== "black" || result || engineError || reviewing) return;
    const searchBudget = aiSearchBudget(aiDifficulty, timesRef.current.black);
    const controller = new AbortController();
    setAiThinking(true);
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const move = await analyzeAtLevel(board, aiDifficulty, {
          history,
          side: "black",
          timeMs: aiDifficulty === "master" ? searchBudget : undefined,
        }, searchBudget, () => setGrandmasterReady(true), undefined, controller.signal);
        if (cancelled) return;
        if (move) commitMove([move[0], move[1]], [move[2], move[3]]);
        else setResult({ winner: "red", message: "黑方无子可走，红方取胜" });
      } catch (error) {
        if (cancelled) return;
        console.error("棋局计算失败", error);
        setEngineError("棋局计算遇到问题，请重新开局");
      } finally {
        if (!cancelled) setAiThinking(false);
      }
    }, 20);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [aiDifficulty, board, commitMove, engineError, history, mode, result, reviewing, turn]);

  const choosePoint = (r: number, c: number) => {
    if (result || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === "black")) return;
    const piece = board[r][c];

    if (selected && targets.some(([tr, tc]) => tr === r && tc === c)) {
      commitMove(selected, [r, c]);
      return;
    }

    if (piece?.side === turn) {
      setSelected([r, c]);
      setTargets(legalMoves(board, r, c));
    } else {
      setSelected(null);
      setTargets([]);
    }
  };

  const handleBoardKey = (event: KeyboardEvent<HTMLButtonElement>, r: number, c: number) => {
    const directions: Record<string, Coord> = {
      ArrowUp: [flipped ? 1 : -1, 0],
      ArrowDown: [flipped ? -1 : 1, 0],
      ArrowLeft: [0, flipped ? 1 : -1],
      ArrowRight: [0, flipped ? -1 : 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const nr = Math.max(0, Math.min(9, r + direction[0]));
    const nc = Math.max(0, Math.min(8, c + direction[1]));
    document.querySelector<HTMLButtonElement>(`[data-point="${nr}-${nc}"]`)?.focus();
  };

  const undo = () => {
    if (!history.length || aiThinking || hintThinking || reviewing) return;
    const steps = mode === "ai" && turn === "red" && history.length >= 2 ? 2 : 1;
    const restoreIndex = history.length - steps;
    const restore = history[restoreIndex];
    const remaining = history.slice(0, restoreIndex);
    hintRequestRef.current++;

    setBoard(cloneBoard(restore.before));
    setTurn(restore.turnBefore);
    setTimes({ red: restore.redTime, black: restore.blackTime });
    setHistory(remaining);
    setSelected(null);
    setTargets([]);
    setResult(null);
    setEngineError(null);
    setResultDismissed(false);
    setReviewPly(null);
    setHint(null);
  };

  const reviewTo = (ply: number) => {
    hintRequestRef.current++;
    setReviewPly(Math.max(0, Math.min(history.length, ply)));
    setSelected(null);
    setTargets([]);
    setResultDismissed(true);
    setHint(null);
  };

  const requestHint = () => {
    if (result || engineError || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === "black")) return;
    setHintThinking(true);
    const requestId = ++hintRequestRef.current;
    setHint(null);
    setSelected(null);
    setTargets([]);
    window.setTimeout(async () => {
      try {
        const move = await analyzeAtLevel(board, aiDifficulty, {
          history,
          side: turn,
          timeMs: aiDifficulty === "master" ? 900 : undefined,
        }, 1400, () => setGrandmasterReady(true));
        if (hintRequestRef.current !== requestId) return;
        if (!move) return;
        const from: Coord = [move[0], move[1]];
        const to: Coord = [move[2], move[3]];
        const piece = board[from[0]][from[1]];
        if (piece) setHint({ from, to, notation: moveNotation(piece, from, to) });
      } catch {
        if (hintRequestRef.current === requestId) setHint(null);
      } finally {
        if (hintRequestRef.current === requestId) setHintThinking(false);
      }
    }, 30);
  };

  const viewCoordinates = useMemo(() => {
    const coords: Coord[] = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) coords.push([r, c]);
    return flipped ? coords.reverse() : coords;
  }, [flipped]);

  const movePairs = useMemo(() => {
    return Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => ({
      red: history[index * 2],
      black: history[index * 2 + 1],
    }));
  }, [history]);

  const capturedByRed = history.filter((item) => item.mover.side === "red" && item.captured);
  const capturedByBlack = history.filter((item) => item.mover.side === "black" && item.captured);
  const topSide: Side = flipped ? "red" : "black";
  const bottomSide: Side = flipped ? "black" : "red";

  const renderPlayer = (side: Side, top = false) => {
    const isRed = side === "red";
    const active = turn === side && !result && !engineError && !reviewing;
    const thinking = active && aiThinking && side === "black";
    const name = isRed ? "长安访客" : mode === "ai" ? "墨隐棋手" : "北境棋手";
    const note = reviewing
      ? `复盘第 ${visiblePly} 手`
      : active
      ? thinking ? `${AI_LEVEL_LABEL[aiDifficulty]}难度推演中` : "轮到此方"
      : isRed ? "执红" : mode === "ai" ? "电脑执黑" : "执黑";
    return (
      <div className={`player-strip${top ? " player-strip-top" : ""}`}>
        <span className={`player-mark ${isRed ? "red-mark" : "black-mark"}${thinking ? " thinking-mark" : ""}`}>{isRed ? "帥" : "将"}</span>
        <span className="player-copy">
          <b>{name}</b>
          <small className={thinking ? "thinking-note" : undefined}>{note}</small>
        </span>
        <time className={active ? "active-clock" : ""}>{formatTime(times[side])}</time>
      </div>
    );
  };

  const statusTitle = engineError
    ? "计算暂停"
    : reviewing
    ? visiblePly === 0 ? "复盘 · 开局" : `复盘 · 第 ${visiblePly} 手`
    : result
    ? result.winner ? `${result.winner === "red" ? "红方" : "黑方"}胜` : "本局和棋"
    : aiThinking
      ? "墨隐思考中"
      : hintThinking
        ? "棋力分析中"
      : checked
        ? `${turn === "red" ? "红方" : "黑方"}被将军`
        : `${turn === "red" ? "红方" : "黑方"}行棋`;
  const statusLoading = !engineError && !reviewing && !result && (aiThinking || hintThinking);
  const statusNote = engineError ?? (reviewing
    ? visiblePly === history.length ? "已到达当前局面" : "可用下方按钮或着法记录逐步查看"
    : result?.message
    ?? (aiThinking
      ? aiDifficulty === "grandmaster" && !grandmasterReady
        ? "首次加载约 51MB 神经网络，完成后会由浏览器缓存"
        : "请稍候，对手正在推演棋路"
      : hintThinking
        ? `${AI_LEVEL_LABEL[aiDifficulty]}棋力正在寻找推荐着法`
        : hint
          ? `建议 ${hint.notation}，棋盘已标出起点与落点`
          : selected ? `可走 ${targets.length} 处` : "请选择一枚棋子"));
  const lostToComputer = mode === "ai" && result?.winner === "black";
  const isDraw = !!result && !result.winner;
  const outcomeTitle = isDraw
    ? "此局言和"
    : lostToComputer
    ? "此局惜败"
    : mode === "ai"
      ? "你赢了"
      : `${result?.winner === "red" ? "红方" : "黑方"}胜`;

  return (
    <main className="game-shell">
      <header className="topbar">
        <a className="brand" href="#game" aria-label="长安棋社首页">
          <span className="brand-seal">棋</span>
          <span><strong>长安棋社</strong><small>CHANG&apos;AN XIANGQI</small></span>
        </a>
        <div className="top-actions">
          <span className="room-tag"><i /> 经典对局</span>
          <button
            className={`icon-button${soundOn ? "" : " sound-off"}`}
            type="button"
            aria-label={soundOn ? "关闭声音" : "开启声音"}
            aria-pressed={soundOn}
            onClick={() => setSoundOn((current) => !current)}
          >
            {soundOn ? "♪" : "♩"}
          </button>
        </div>
      </header>

      <section className="game-layout" id="game">
        <div className="board-column">
          {renderPlayer(topSide, true)}

          <div className="board-frame" aria-label="中国象棋棋盘">
            <div className="board-surface">
              <div className="board-lines" aria-hidden="true">
                <span className="palace palace-top" />
                <span className="palace palace-bottom" />
                <span className="river"><b>楚 河</b><b>漢 界</b></span>
              </div>
              <div className="piece-grid" role="grid" aria-label={reviewing ? `复盘第${visiblePly}手` : `${turn === "red" ? "红方" : "黑方"}回合`}>
                {viewCoordinates.map(([r, c]) => {
                  const piece = visibleBoard[r][c];
                  const visualRow = flipped ? 9 - r : r;
                  const visualCol = flipped ? 8 - c : c;
                  const isTarget = !reviewing && targets.some(([tr, tc]) => tr === r && tc === c);
                  const isSelected = !reviewing && sameCoord(selected, r, c);
                  const isFrom = sameCoord(visibleLastMove?.from ?? null, r, c);
                  const isTo = sameCoord(visibleLastMove?.to ?? null, r, c);
                  const isHintFrom = !reviewing && sameCoord(hint?.from ?? null, r, c);
                  const isHintTo = !reviewing && sameCoord(hint?.to ?? null, r, c);
                  const kingChecked = checked && piece?.side === visibleTurn && piece.t === "K";
                  const classes = [
                    "point",
                    piece ? `piece ${piece.side}` : "",
                    isTarget ? "target" : "",
                    isTarget && piece ? "capture-target" : "",
                    isSelected ? "selected" : "",
                    isFrom ? "last-from" : "",
                    isTo ? "last-to" : "",
                    isHintFrom ? "hint-from" : "",
                    isHintTo ? "hint-to" : "",
                    kingChecked ? "king-check" : "",
                  ].filter(Boolean).join(" ");
                  const label = piece
                    ? `${piece.side === "red" ? "红方" : "黑方"}${NAMES[piece.side][piece.t]}，第${r + 1}行第${c + 1}列`
                    : `第${r + 1}行第${c + 1}列${isTarget ? "，可落子" : ""}`;

                  return (
                    <button
                      key={`${r}-${c}`}
                      className={classes}
                      type="button"
                      role="gridcell"
                      data-point={`${r}-${c}`}
                      style={{
                        left: `${visualCol * 12.5}%`,
                        top: `${visualRow * (100 / 9)}%`,
                      }}
                      aria-label={label}
                      aria-pressed={isSelected}
                      onClick={() => choosePoint(r, c)}
                      onKeyDown={(event) => handleBoardKey(event, r, c)}
                    >
                      {piece ? <span>{NAMES[piece.side][piece.t]}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {renderPlayer(bottomSide)}
        </div>

        <aside className="side-panel">
          <div className="mode-switch" role="group" aria-label="选择对局模式">
            <button className={mode === "ai" ? "active" : ""} type="button" onClick={() => startNewGame("ai")}>人机对弈</button>
            <button className={mode === "local" ? "active" : ""} type="button" onClick={() => startNewGame("local")}>双人对弈</button>
          </div>

          {mode === "ai" ? (
            <>
              <div className="ai-level" role="group" aria-label="选择电脑难度">
                <span>电脑棋力</span>
                {(Object.keys(AI_LEVEL_LABEL) as AiLevel[]).map((level) => (
                  <button
                    className={aiDifficulty === level ? "active" : ""}
                    type="button"
                    key={level}
                    aria-pressed={aiDifficulty === level}
                    onClick={() => {
                      setAiDifficulty(level);
                      setHint(null);
                    }}
                  >
                    {AI_LEVEL_LABEL[level]}
                  </button>
                ))}
              </div>
              <p className="ai-level-note"><b>{AI_LEVEL_LABEL[aiDifficulty]}棋力</b>{AI_LEVEL_NOTE[aiDifficulty]}</p>
            </>
          ) : null}

          <div className={`turn-card${result ? " game-over" : ""}`} role="status" aria-live="polite">
            <span className="eyebrow">本局状态</span>
            <div className="turn-title">
              <span className={`mini-piece ${turn === "black" ? "black-mini" : ""}`}>{turn === "red" ? "帥" : "将"}</span>
              <div>
                <b>{statusTitle}{statusLoading ? <span className="status-loading" aria-hidden="true"><i /><i /><i /></span> : null}</b>
                <small>{statusNote}</small>
              </div>
            </div>
          </div>

          <div className="control-row">
            <button type="button" onClick={requestHint} disabled={!!result || !!engineError || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === "black")} aria-label="推荐着法">◇ <span>{hintThinking ? "分析" : "提示"}</span></button>
            <button type="button" onClick={undo} disabled={!history.length || aiThinking || hintThinking || reviewing} aria-label="悔棋">↶ <span>悔棋</span></button>
            <button type="button" onClick={() => setFlipped((current) => !current)} aria-label="翻转棋盘">⇅ <span>翻转</span></button>
            <button type="button" onClick={() => startNewGame()} aria-label="重新开局">↻ <span>重开</span></button>
          </div>

          <div className="record-card">
            <div className="section-heading"><span>着法记录</span><small>{reviewing ? `${visiblePly} / ${history.length} 手` : `${history.length} 手`}</small></div>
            {history.length ? (
              <>
                <div className="review-controls" aria-label="棋局复盘控制">
                  <button type="button" onClick={() => reviewTo(0)} disabled={reviewing && visiblePly === 0} aria-label="回到开局">|‹</button>
                  <button type="button" onClick={() => reviewTo(visiblePly - 1)} disabled={reviewing && visiblePly === 0} aria-label="上一手">‹</button>
                  <span>{reviewing ? `第 ${visiblePly} 手` : "当前局面"}</span>
                  <button type="button" onClick={() => reviewTo(visiblePly + 1)} disabled={!reviewing || visiblePly === history.length} aria-label="下一手">›</button>
                  <button type="button" onClick={() => setReviewPly(null)} disabled={!reviewing} aria-label="返回当前局面">›|</button>
                </div>
                <div className="record-list" aria-label="本局着法">
                  {movePairs.map((pair, index) => {
                    const redPly = index * 2 + 1;
                    const blackPly = index * 2 + 2;
                    return (
                      <div className="move-pair" key={index}>
                        <span className="move-number">{index + 1}</span>
                        <button className={`move-cell red-move${reviewing && visiblePly === redPly ? " active" : ""}`} type="button" onClick={() => reviewTo(redPly)}>{pair.red.notation}{pair.red.check ? " 将" : ""}</button>
                        {pair.black
                          ? <button className={`move-cell${reviewing && visiblePly === blackPly ? " active" : ""}`} type="button" onClick={() => reviewTo(blackPly)}>{pair.black.notation}{pair.black.check ? " 将" : ""}</button>
                          : <span className="move-cell">—</span>}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="empty-record"><span>拾</span><p>棋局尚未开始<br />落下第一子，记录便会出现在这里</p></div>
            )}

            {history.some((item) => item.captured) ? (
              <div className="capture-summary">
                <div className="red-captures"><small>红方俘获</small><span>{capturedByRed.map((item, index) => <i className="captured-black" key={index}>{NAMES.black[item.captured!.t]}</i>)}</span></div>
                <div className="black-captures"><small>黑方俘获</small><span>{capturedByBlack.map((item, index) => <i className="captured-red" key={index}>{NAMES.red[item.captured!.t]}</i>)}</span></div>
              </div>
            ) : null}
          </div>
          <p className="rule-note">竞赛级规则 · 将死、困毙、长将长捉、重复局面与残局和棋</p>
        </aside>
      </section>
      <footer><span>落子无悔，静候知音</span><b>代码工匠 · 用代码打磨每一步</b></footer>

      {result && !resultDismissed ? (
        <div className={`result-overlay ${isDraw ? "outcome-draw" : lostToComputer ? "outcome-lose" : "outcome-win"}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title">
          <div className="outcome-particles" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
          </div>
          <div className="outcome-card">
            <div className="outcome-seal" aria-hidden="true"><span>{isDraw ? "和" : lostToComputer ? "敗" : "勝"}</span></div>
            <small>{isDraw ? "纹枰论道 · 握手言和" : lostToComputer ? "胜败乃兵家常事" : "妙手定乾坤"}</small>
            <h2 id="outcome-title">{outcomeTitle}</h2>
            <p>{result.message}</p>
            <div className="outcome-actions">
              <button type="button" onClick={() => startNewGame()} autoFocus>再来一局</button>
              <button type="button" onClick={() => reviewTo(history.length)}>复盘棋局</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
