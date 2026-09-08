"use client";

import { cloneBoard, findKing, inCheck, initialBoard, legalMoves, NAMES } from "@/lib/chess";
import type { AdjudicationMove, Board, ChaseCandidate, Side } from "@/lib/chess";
import { isBannedMove, moveNotation, playMove, REJECTION_MESSAGE, replayMoves } from "@/lib/game-core";
import { defaultLanHost, LanClient, loadLanSession } from "@/lib/lan-client";
import type { LanSession } from "@/lib/lan-client";
import type { RoomSnapshot } from "@/server/room";
import {
  AI_LEVEL_LABEL,
  AI_LEVEL_NOTE,
  aiSearchBudget,
  analyzeAtLevel,
  disposeAiClient,
  isAbortError,
} from "@/lib/ai-client";
import type { AiLevel } from "@/lib/ai-client";
import { ChessBoard } from "@/components/chess-board";
import type { Coord, MovingPiece } from "@/components/chess-board";
import { disposeGameSounds, playGameSound, setSoundVolume } from "@/lib/game-sounds";
import { disposeMusic, setMusicVolume, startMusic, stopMusic } from "@/lib/game-music";
import { SettingsPanel } from "@/components/settings-panel";
import type { AudioSettings } from "@/components/settings-panel";
import type { GameSoundDetail, GameSoundKind } from "@/lib/game-sounds";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GameMode = "ai" | "local" | "online";

interface LanState {
  /** idle：未进房；joining：连接中；waiting：等对手；playing：双方到齐 */
  status: "idle" | "joining" | "waiting" | "playing";
  code: string | null;
  side: Side;
  connected: boolean;
  seats: { red: boolean; black: boolean };
  pendingUndo: Side | null;
  rematch: Side[];
}

const LAN_IDLE: LanState = { status: "idle", code: null, side: "red", connected: false, seats: { red: false, black: false }, pendingUndo: null, rematch: [] };

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

const SAVE_KEY = "changan-xiangqi-save-v1";
const SETTINGS_KEY = "changan-xiangqi-settings-v1";
const AI_FIRST_MOVE_DELAY = 3000;
const AI_MIN_MOVE_DELAY = 1000;

interface SaveData {
  version: 1;
  board: Board;
  turn: Side;
  history: MoveRecord[];
  times: { red: number; black: number };
  mode: GameMode;
  aiDifficulty: AiLevel;
  playerSide?: Side;
  flipped: boolean;
  soundOn: boolean;
  result: GameResult | null;
}

function formatTime(total: number) {
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
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
  const [playerSide, setPlayerSide] = useState<Side>("red");
  const [pikafishReady, setPikafishReady] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [musicOn, setMusicOn] = useState(false);
  const [soundVolume, setSoundVolumeState] = useState(0.8);
  const [musicVolume, setMusicVolumeState] = useState(0.6);
  const [aiThinking, setAiThinking] = useState(false);
  const [hintThinking, setHintThinking] = useState(false);
  const [hint, setHint] = useState<HintMove | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const [resultDismissed, setResultDismissed] = useState(false);
  const [times, setTimes] = useState({ red: 900, black: 900 });
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [moving, setMoving] = useState<MovingPiece | null>(null);
  const [landing, setLanding] = useState<Coord | null>(null);
  const [shaking, setShaking] = useState<Coord | null>(null);
  const [resignConfirm, setResignConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  /** 点击棋盘上的「开始」后才计时、才让电脑走子。 */
  const [started, setStarted] = useState(false);
  const [boardFullscreen, setBoardFullscreen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lan, setLan] = useState<LanState>(LAN_IDLE);
  const [lanHost, setLanHost] = useState("localhost");
  const [joinCode, setJoinCode] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const lanRef = useRef<LanClient | null>(null);
  const commitMoveRef = useRef<(from: Coord, to: Coord, actor: "human" | "ai" | "remote") => boolean>(() => false);
  const historyRef = useRef<MoveRecord[]>([]);
  const playSoundRef = useRef<(kind: GameSoundKind, detail?: GameSoundDetail) => void>(() => undefined);
  const landingByAiRef = useRef(false);
  /** 悔棋时需要依次倒放多步，排队等上一段动画结束再播下一段。 */
  const movingQueueRef = useRef<MovingPiece[]>([]);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const fullscreenRef = useRef<HTMLElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const exitFullscreenRef = useRef<HTMLButtonElement>(null);
  const boardStageRef = useRef<HTMLDivElement>(null);
  const gameLayoutRef = useRef<HTMLElement>(null);
  const hintRequestRef = useRef(0);
  const hintAbortRef = useRef<AbortController | null>(null);
  const timesRef = useRef(times);

  useEffect(() => {
    const stage = boardStageRef.current;
    const layout = gameLayoutRef.current;
    if (!stage || !layout) return;
    const observer = new ResizeObserver(([entry]) => {
      layout.style.setProperty("--board-height", `${entry.contentRect.height}px`);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const exitBoardFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === fullscreenRef.current) {
        await document.exitFullscreen();
      }
      setBoardFullscreen(false);
      setFullscreenError(null);
      fullscreenButtonRef.current?.focus();
    } catch {
      setFullscreenError("退出全屏失败，请按 Esc 重试。");
    }
  }, []);

  const enterBoardFullscreen = async () => {
    const element = fullscreenRef.current;
    if (!element) return;
    setFullscreenError(null);
    try {
      if (document.fullscreenEnabled && element.requestFullscreen) {
        await element.requestFullscreen();
      }
      setBoardFullscreen(true);
    } catch {
      setFullscreenError("无法进入全屏，请重试或检查浏览器权限。");
    }
  };

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === fullscreenRef.current;
      setBoardFullscreen(active);
      if (!active) fullscreenButtonRef.current?.focus();
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    if (!boardFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    exitFullscreenRef.current?.focus();
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") void exitBoardFullscreen();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [boardFullscreen, exitBoardFullscreen]);

  useEffect(() => {
    timesRef.current = times;
  }, [times]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(SAVE_KEY);
        if (raw) {
          const data = JSON.parse(raw) as SaveData;
          if (data?.version === 1 && Array.isArray(data.board) && data.board.length === 10) {
            setBoard(data.board);
            setTurn(data.turn === "black" ? "black" : "red");
            const savedHistory = Array.isArray(data.history) ? data.history : [];
            setHistory(savedHistory);
            setStarted(savedHistory.length > 0 || !!data.result);
            const savedTimes = data.times ?? { red: 900, black: 900 };
            setTimes(savedTimes);
            timesRef.current = savedTimes;
            setMode(data.mode === "local" ? "local" : data.mode === "online" ? "online" : "ai");
            setAiDifficulty(data.aiDifficulty ?? "standard");
            setPlayerSide(data.playerSide === "black" ? "black" : "red");
            setFlipped(!!data.flipped);
            setSoundOn(data.soundOn !== false);
            if (data.result) {
              setResult(data.result);
              setResultDismissed(true);
            }
          }
        }
      } catch {
        // 存档损坏时直接以新局开始。
      }
      setRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  /** 把服务端快照同步到本地棋局；对手新落的一手走动画，其余情况（悔棋、重连、重开）静默重建。 */
  const applySnapshot = useCallback((snap: RoomSnapshot, side: Side) => {
    const local = historyRef.current;
    const samePrefix = local.every((record, index) => {
      const wire = snap.moves[index];
      return wire && wire.from[0] === record.from[0] && wire.from[1] === record.from[1]
        && wire.to[0] === record.to[0] && wire.to[1] === record.to[1];
    });
    if (samePrefix && snap.moves.length === local.length + 1) {
      const next = snap.moves[local.length];
      const mine = local.length % 2 === 0 ? "red" : "black";
      if (mine !== side) commitMoveRef.current(next.from, next.to, "remote");
    } else if (!samePrefix || snap.moves.length !== local.length) {
      const { state, outcomes } = replayMoves(snap.moves);
      let board = initialBoard();
      let turn: Side = "red";
      const records: MoveRecord[] = outcomes.map((outcome) => {
        const record: MoveRecord = {
          ...outcome.record,
          before: cloneBoard(board),
          turnBefore: turn,
          notation: outcome.notation,
          redTime: snap.times.red,
          blackTime: snap.times.black,
        };
        board = outcome.state.board;
        turn = outcome.state.turn;
        return record;
      });
      if (snap.moves.length < local.length) playSoundRef.current("undo", { side: null });
      setBoard(state.board);
      setTurn(state.turn);
      setHistory(records);
      setSelected(null);
      setTargets([]);
      setHint(null);
      setReviewPly(null);
      movingQueueRef.current = [];
      setMoving(null);
      setLanding(null);
    }
    timesRef.current = snap.times;
    setTimes(snap.times);
    setStarted(snap.started);
    setResult((current) => {
      if (snap.result && !current) setResultDismissed(false);
      return snap.result ? { winner: snap.result.winner, message: snap.result.message } : null;
    });
    setFlipped(side === "black");
    setLan((current) => ({
      ...current,
      status: snap.seats.red && snap.seats.black ? "playing" : "waiting",
      code: snap.code,
      side,
      seats: snap.seats,
      pendingUndo: snap.pendingUndo,
      rematch: snap.rematch,
    }));
  }, []);

  const ensureLan = useCallback(() => {
    if (lanRef.current) return lanRef.current;
    const client = new LanClient({
      onSeated: (session, snapshot) => {
        setLan((current) => ({ ...current, status: "waiting", code: session.code, side: session.side, connected: true }));
        applySnapshot(snapshot, session.side);
      },
      onState: (snapshot, side) => applySnapshot(snapshot, side),
      onError: (message) => {
        setRuleNotice(message);
        setLan((current) => current.status === "joining" ? { ...current, status: "idle" } : current);
      },
      onConnection: (connected) => setLan((current) => ({ ...current, connected })),
    });
    lanRef.current = client;
    return client;
  }, [applySnapshot]);

  useEffect(() => () => lanRef.current?.dispose(), []);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => {
      setLanHost(defaultLanHost());
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room");
      const hostParam = params.get("host");
      if (roomParam) {
        // 通过链接进来：直接加入房间。
        window.history.replaceState(null, "", window.location.pathname);
        setMode("online");
        setLan({ ...LAN_IDLE, status: "joining" });
        ensureLan().join(hostParam ?? defaultLanHost(), roomParam);
        return;
      }
      if (mode !== "online") return;
      const session = loadLanSession();
      if (session) {
        setLan({ ...LAN_IDLE, status: "joining", side: session.side });
        ensureLan().resume(session);
      }
      // 没有可恢复的会话则停在联机大厅。
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) as Partial<Pick<AudioSettings, "soundVolume" | "musicVolume">>;
        const clamp = (value: unknown, fallback: number) =>
          typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
        setSoundVolumeState((current) => clamp(saved.soundVolume, current));
        setMusicVolumeState((current) => clamp(saved.musicVolume, current));
      } catch {
        // 设置损坏时使用默认值。
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    setSoundVolume(soundVolume);
    setMusicVolume(musicVolume);
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ soundVolume, musicVolume }));
    } catch {
      // 存储不可用时忽略。
    }
  }, [musicVolume, soundVolume]);

  useEffect(() => {
    if (!restored) return;
    const data: SaveData = {
      version: 1,
      board,
      turn,
      history,
      times,
      mode,
      aiDifficulty,
      playerSide,
      flipped,
      soundOn,
      result,
    };
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // 存储不可用时忽略。
    }
  }, [aiDifficulty, board, flipped, history, mode, playerSide, restored, result, soundOn, times, turn]);

  const aiSide: Side = playerSide === "red" ? "black" : "red";
  const reviewing = reviewPly !== null;
  const visiblePly = reviewPly ?? history.length;
  const visibleBoard = useMemo(() => {
    if (!reviewing || visiblePly === history.length) return board;
    return cloneBoard(history[visiblePly]?.before ?? history[0]?.before ?? initialBoard());
  }, [board, history, reviewing, visiblePly]);
  const visibleTurn = reviewing && visiblePly < history.length
    ? history[visiblePly].turnBefore
    : turn;
  const visibleLastMove = useMemo(() => visiblePly > 0
    ? { from: history[visiblePly - 1].from, to: history[visiblePly - 1].to }
    : null, [history, visiblePly]);
  const checked = useMemo(() => !!findKing(visibleBoard, visibleTurn) && inCheck(visibleBoard, visibleTurn), [visibleBoard, visibleTurn]);

  useEffect(() => () => {
    hintAbortRef.current?.abort();
    disposeAiClient();
    disposeGameSounds();
    disposeMusic();
  }, []);

  const updateAudioSettings = (patch: Partial<AudioSettings>) => {
    if (patch.soundOn !== undefined) setSoundOn(patch.soundOn);
    if (patch.soundVolume !== undefined) setSoundVolumeState(patch.soundVolume);
    if (patch.musicVolume !== undefined) setMusicVolumeState(patch.musicVolume);
    if (patch.musicOn !== undefined) {
      if (patch.musicOn) void startMusic();
      else stopMusic();
      setMusicOn(patch.musicOn);
    }
  };

  const playSound = useCallback((kind: GameSoundKind, detail?: GameSoundDetail) => {
    if (!soundOn) return;
    try {
      playGameSound(kind, detail);
    } catch {
      // 声音不可用不影响对局本身。
    }
  }, [soundOn]);
  useEffect(() => {
    playSoundRef.current = playSound;
  }, [playSound]);

  const startNewGame = useCallback((nextMode: GameMode = mode, nextSide: Side = playerSide) => {
    hintRequestRef.current++;
    hintAbortRef.current?.abort();
    hintAbortRef.current = null;
    setMode(nextMode);
    setPlayerSide(nextSide);
    setFlipped(nextMode === "ai" && nextSide === "black");
    setBoard(initialBoard());
    setTurn("red");
    setSelected(null);
    setTargets([]);
    setHistory([]);
    setResult(null);
    setEngineError(null);
    setRuleNotice(null);
    setResultDismissed(false);
    setAiThinking(false);
    setHintThinking(false);
    setHint(null);
    setTimes({ red: 900, black: 900 });
    setReviewPly(null);
    movingQueueRef.current = [];
    setMoving(null);
    setStarted(false);
    if (nextMode !== "online" && lanRef.current?.current) lanRef.current.leave();
    if (nextMode !== "online") setLan(LAN_IDLE);
  }, [mode, playerSide]);

  const lanCreate = (side: Side) => {
    setLan({ ...LAN_IDLE, status: "joining", side });
    ensureLan().create(lanHost.trim() || defaultLanHost(), side);
  };

  const lanJoin = () => {
    const code = joinCode.trim();
    if (code.length !== 4) {
      setRuleNotice("房间码是 4 位数字");
      return;
    }
    setLan({ ...LAN_IDLE, status: "joining" });
    ensureLan().join(lanHost.trim() || defaultLanHost(), code);
  };

  /** 邀请链接：主机名用服务地址，这样对方在别的设备上打开也能连上。 */
  const inviteLink = (() => {
    if (!lan.code || typeof window === "undefined") return "";
    const host = lanHost.trim() || window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${host}${port}/?room=${lan.code}&host=${host}`;
  })();

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      // 非安全上下文（如 http://192.168.x.x）没有 clipboard API，退回到选中文本的方式。
      const input = document.createElement("textarea");
      input.value = inviteLink;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand("copy");
      } finally {
        input.remove();
      }
    }
    setLinkCopied(true);
  };

  useEffect(() => {
    if (!linkCopied) return;
    const timer = window.setTimeout(() => setLinkCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [linkCopied]);

  const lanLeave = () => {
    lanRef.current?.leave();
    startNewGame("online");
    setLan(LAN_IDLE);
  };

  const beginGame = () => {
    if (started) return;
    setStarted(true);
    playSound("start", { side: null });
  };

  const handleMoveDone = useCallback(() => {
    const next = movingQueueRef.current.shift() ?? null;
    setMoving((current) => {
      if (current && landingByAiRef.current && !next) setLanding(current.to);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!landing) return;
    const timer = window.setTimeout(() => setLanding(null), 700);
    return () => window.clearTimeout(timer);
  }, [landing]);

  useEffect(() => {
    if (!shaking) return;
    const timer = window.setTimeout(() => setShaking(null), 360);
    return () => window.clearTimeout(timer);
  }, [shaking]);

  const shake = useCallback((coord: Coord) => setShaking([coord[0], coord[1]]), []);

  const commitMove = useCallback((from: Coord, to: Coord, actor: "human" | "ai" | "remote" = "human") => {
    const outcome = playMove({ board, turn, history, result: null }, from, to);
    if (!outcome.ok) {
      if (outcome.reason === "perpetual-check" || outcome.reason === "perpetual-chase") {
        playSound("illegal", { side: turn });
        shake(from);
        setRuleNotice(REJECTION_MESSAGE[outcome.reason]);
        setSelected(null);
        setTargets([]);
        setHint(null);
      }
      return false;
    }
    const { record: core, notation, gaveCheck, captured, state } = outcome;
    const piece = core.mover;
    const record: MoveRecord = {
      ...core,
      before: cloneBoard(board),
      turnBefore: turn,
      notation,
      redTime: timesRef.current.red,
      blackTime: timesRef.current.black,
    };
    const gameResult: GameResult | null = state.result;

    setRuleNotice(null);
    setBoard(state.board);
    setHistory([...history, record]);
    setSelected(null);
    setTargets([]);
    setHint(null);
    setTurn(state.turn);
    setReviewPly(null);
    setResult(gameResult);
    landingByAiRef.current = actor !== "human";
    setLanding(null);
    movingQueueRef.current = [];
    setMoving({ piece: { ...piece }, from, to, captured });
    if (gameResult) setResultDismissed(false);

    if (!gameResult) {
      const detail = { side: turn, actor: actor === "remote" ? "human" as const : actor, notation, piece: piece.t };
      if (gaveCheck) playSound("check", detail);
      else playSound(captured ? "capture" : "move", detail);
    }
    return true;
  }, [board, history, playSound, shake, turn]);

  useEffect(() => {
    commitMoveRef.current = commitMove;
  }, [commitMove]);

  useEffect(() => {
    if (!ruleNotice) return;
    const timer = window.setTimeout(() => setRuleNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [ruleNotice]);

  useEffect(() => {
    if (!started || result || engineError || reviewing || hintThinking) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, timesRef.current[turn] - 1);
      const nextTimes = { ...timesRef.current, [turn]: remaining };
      timesRef.current = nextTimes;
      setTimes(nextTimes);
      const humanClock = mode === "local" || (mode === "online" ? turn === lan.side : turn === playerSide);
      if (humanClock && (remaining === 60 || remaining === 30)) playSound("lowtime", { side: turn });
      else if (humanClock && remaining > 0 && remaining <= 10) playSound("tick", { side: turn });
      if (remaining === 0 && mode !== "online") {
        const winner: Side = turn === "red" ? "black" : "red";
        setResult({ winner, message: `${turn === "red" ? "红方" : "黑方"}用时耗尽` });
        setResultDismissed(false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [engineError, hintThinking, lan.side, mode, playSound, playerSide, result, reviewing, started, turn]);

  useEffect(() => {
    if (!result) return;
    if (!result.winner) {
      playSound("draw", { side: null });
      return;
    }
    const lostToComputer = mode === "ai" && result.winner === aiSide;
    const timedOut = result.message.includes("用时耗尽");
    if (timedOut && (mode === "local" || lostToComputer)) playSound("timeout", { side: result.winner });
    else playSound(lostToComputer ? "lose" : "win", { side: result.winner });
  }, [aiSide, mode, playSound, result]);

  useEffect(() => {
    if (!started || mode !== "ai" || turn !== aiSide || result || engineError || reviewing) return;
    const searchBudget = aiSearchBudget(aiDifficulty, timesRef.current[aiSide]);
    const controller = new AbortController();
    let cancelled = false;
    // 电脑落子的最短间隔：开局第一手约 2 秒，之后每手不少于 1 秒，避免低难度瞬间落子显得仓促。
    const minDelay = history.length <= 1 ? AI_FIRST_MOVE_DELAY : AI_MIN_MOVE_DELAY;
    const thinkStart = Date.now();
    const holdUntilMinDelay = () => new Promise<void>((resolve) => {
      const remaining = minDelay - (Date.now() - thinkStart);
      if (remaining <= 0) {
        resolve();
        return;
      }
      const hold = window.setTimeout(resolve, remaining);
      controller.signal.addEventListener("abort", () => window.clearTimeout(hold), { once: true });
    });
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      setAiThinking(true);
      try {
        const move = await analyzeAtLevel(board, aiDifficulty, {
          history,
          side: aiSide,
          timeMs: searchBudget,
        }, searchBudget, () => setPikafishReady(true), undefined, controller.signal);
        if (cancelled) return;
        let chosen = move;
        if (chosen && isBannedMove({ board, turn: aiSide, history, result: null }, [chosen[0], chosen[1]], [chosen[2], chosen[3]])) {
          // Pikafish 选了长将/长捉着法：改用内置引擎，它会自行排除禁着。
          chosen = await analyzeAtLevel(board, "hard", {
            history,
            side: aiSide,
            timeMs: 800,
          }, 800, undefined, undefined, controller.signal);
          if (cancelled) return;
        }
        await holdUntilMinDelay();
        if (cancelled) return;
        if (chosen) commitMove([chosen[0], chosen[1]], [chosen[2], chosen[3]], "ai");
        else setResult({ winner: playerSide, message: `${aiSide === "red" ? "红方" : "黑方"}无子可走，${playerSide === "red" ? "红方" : "黑方"}取胜` });
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
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
  }, [aiDifficulty, aiSide, board, commitMove, engineError, history, mode, playerSide, result, reviewing, started, turn]);

  const choosePoint = useCallback((r: number, c: number) => {
    if (!started || result || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === aiSide)) return;
    if (mode === "online" && (turn !== lan.side || !lan.connected || lan.pendingUndo)) return;
    const piece = board[r][c];

    if (selected && targets.some(([tr, tc]) => tr === r && tc === c)) {
      const from = selected;
      if (commitMove(from, [r, c]) && mode === "online") lanRef.current?.move(from, [r, c]);
      return;
    }

    if (piece?.side === turn) {
      playSound("select", { side: turn, piece: piece.t });
      setSelected([r, c]);
      setTargets(legalMoves(board, r, c));
    } else if (selected) {
      // 点了不能走的位置：棋子抖一下，保持选中，避免玩家以为没反应。
      shake(selected);
    }
  }, [aiSide, aiThinking, board, commitMove, lan.connected, lan.pendingUndo, lan.side, playSound, hintThinking, mode, result, reviewing, selected, shake, started, targets, turn]);

  const canUndo = mode === "online"
    ? started && !result && !lan.pendingUndo && history.some((record) => record.mover.side === lan.side)
    : history.length > (mode === "ai" && playerSide === "black" ? 1 : 0);

  const undo = () => {
    if (!history.length || aiThinking || hintThinking || reviewing || !canUndo) return;
    if (mode === "online") {
      lanRef.current?.requestUndo();
      return;
    }
    const steps = mode === "ai" && turn === playerSide && history.length >= 2 ? 2 : 1;
    const restoreIndex = history.length - steps;
    const restore = history[restoreIndex];
    const remaining = history.slice(0, restoreIndex);
    hintRequestRef.current++;
    hintAbortRef.current?.abort();
    hintAbortRef.current = null;

    setBoard(cloneBoard(restore.before));
    setTurn(restore.turnBefore);
    setTimes({ red: restore.redTime, black: restore.blackTime });
    setHistory(remaining);
    setRuleNotice(null);
    setSelected(null);
    setTargets([]);
    setResult(null);
    setEngineError(null);
    setResultDismissed(false);
    setReviewPly(null);
    setHint(null);
    // 倒放被撤销的着法：从最后一手开始，棋子沿原路退回。
    const reversed = history.slice(restoreIndex).reverse().map((record): MovingPiece => ({
      piece: { ...record.mover },
      from: record.to,
      to: record.from,
      captured: null,
    }));
    landingByAiRef.current = false;
    setLanding(null);
    movingQueueRef.current = reversed.slice(1);
    setMoving(reversed[0] ?? null);
    playSound("undo", { side: restore.turnBefore });
  };

  const resign = () => {
    if (result || reviewing || engineError) return;
    setResignConfirm(true);
  };

  const confirmResign = () => {
    setResignConfirm(false);
    hintRequestRef.current++;
    hintAbortRef.current?.abort();
    hintAbortRef.current = null;
    if (mode === "online") {
      lanRef.current?.resign();
      return;
    }
    const winner: Side = turn === "red" ? "black" : "red";
    setSelected(null);
    setTargets([]);
    setHint(null);
    setMoving(null);
    setResult({
      winner,
      message: `${turn === "red" ? "红方" : "黑方"}认输，${winner === "red" ? "红方" : "黑方"}取胜`,
    });
    setResultDismissed(false);
  };

  const reviewTo = (ply: number) => {    hintRequestRef.current++;
    hintAbortRef.current?.abort();
    hintAbortRef.current = null;
    setRuleNotice(null);
    setReviewPly(Math.max(0, Math.min(history.length, ply)));
    setSelected(null);
    setTargets([]);
    setResultDismissed(true);
    setHint(null);
    movingQueueRef.current = [];
    setMoving(null);
  };

  const requestHint = () => {
    if (!started || result || engineError || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === aiSide)) return;
    hintAbortRef.current?.abort();
    const controller = new AbortController();
    hintAbortRef.current = controller;
    setHintThinking(true);
    const requestId = ++hintRequestRef.current;
    const searchBudget = aiSearchBudget(aiDifficulty, timesRef.current[turn]);
    setHint(null);
    setSelected(null);
    setTargets([]);
    window.setTimeout(async () => {
      try {
        let move = await analyzeAtLevel(board, aiDifficulty, {
          history,
          side: turn,
          timeMs: searchBudget,
        }, searchBudget, () => setPikafishReady(true), undefined, controller.signal);
        if (hintRequestRef.current !== requestId) return;
        if (!move) return;
        if (isBannedMove({ board, turn, history, result: null }, [move[0], move[1]], [move[2], move[3]])) {
          const safe = await analyzeAtLevel(board, "hard", {
            history,
            side: turn,
            timeMs: 800,
          }, 800, undefined, undefined, controller.signal);
          if (hintRequestRef.current !== requestId || !safe) return;
          move = safe;
        }
        const from: Coord = [move[0], move[1]];
        const to: Coord = [move[2], move[3]];
        const piece = board[from[0]][from[1]];
        if (piece) setHint({ from, to, notation: moveNotation(piece, from, to) });
      } catch (error) {
        if (hintRequestRef.current !== requestId || isAbortError(error)) return;
        console.warn("推荐着法分析失败", error);
        setHint(null);
        setRuleNotice("提示分析暂时不可用，请稍后再试");
      } finally {
        if (hintRequestRef.current === requestId) {
          hintAbortRef.current = null;
          setHintThinking(false);
        }
      }
    }, 30);
  };

  const movePairs = useMemo(() => {
    return Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => ({
      red: history[index * 2],
      black: history[index * 2 + 1],
    }));
  }, [history]);

  const { capturedByRed, capturedByBlack } = useMemo(() => ({
    capturedByRed: history.filter((item) => item.mover.side === "red" && item.captured),
    capturedByBlack: history.filter((item) => item.mover.side === "black" && item.captured),
  }), [history]);

  const materialDiff = useMemo(() => {
    const weight: Record<string, number> = { R: 9, N: 4, C: 4, B: 2, A: 2, P: 1, K: 0 };
    let red = 0;
    let black = 0;
    for (const row of board) {
      for (const piece of row) {
        if (!piece) continue;
        if (piece.side === "red") red += weight[piece.t];
        else black += weight[piece.t];
      }
    }
    return red - black;
  }, [board]);

  const topSide: Side = flipped ? "red" : "black";
  const bottomSide: Side = flipped ? "black" : "red";

  /** 已进入对局（双方到齐过），即使对方暂时掉线也按对局中处理。 */
  const lanInGame = mode === "online" && !!lan.code && (lan.status === "playing" || started);

  const renderPlayer = (side: Side, top = false) => {
    const isRed = side === "red";
    const active = turn === side && !result && !engineError && !reviewing;
    const isAi = mode === "ai" && side === aiSide;
    const thinking = active && aiThinking && isAi;
    const isMe = mode === "online" && side === lan.side;
    const isRemote = mode === "online" && !isMe;
    const name = mode === "online"
      ? isMe ? "你" : "对手"
      : isAi ? "墨隐棋手" : mode === "ai" ? "长安访客" : isRed ? "长安访客" : "北境棋手";
    const seatNote = isRemote
      ? lan.seats[side] ? "已连接" : lanInGame ? "对手掉线，等待重连" : "等待加入"
      : isMe && !lan.connected ? "连接断开，重连中" : null;
    const note = reviewing
      ? `复盘第 ${visiblePly} 手`
      : seatNote && (!active || !lan.seats[side] || !lan.connected)
      ? seatNote
      : active
      ? thinking ? `${AI_LEVEL_LABEL[aiDifficulty]}难度` : "轮到此方"
      : isAi ? `电脑执${isRed ? "红" : "黑"}` : isRed ? "执红" : "执黑";
    return (
      <div className={`player-strip${top ? " player-strip-top" : ""}`}>
        <span className={`player-mark ${isRed ? "red-mark" : "black-mark"}${thinking ? " thinking-mark" : ""}`}>{isRed ? "帥" : "将"}</span>
        <span className="player-copy">
          <b>{name}{thinking ? <span className="thinking-inline">思考中<span className="status-loading" aria-hidden="true"><i /><i /><i /></span></span> : null}</b>
          <small className={thinking ? "thinking-note" : undefined}>{note}</small>
        </span>
        <time className={active ? "active-clock" : ""}>{formatTime(times[side])}</time>
      </div>
    );
  };

  const renderControls = (extraClass = "") => (
    <div className={`control-row${extraClass ? ` ${extraClass}` : ""}`}>
            <button type="button" onClick={requestHint} disabled={mode === "online" || !started || !!result || !!engineError || reviewing || aiThinking || hintThinking || (mode === "ai" && turn === aiSide)} aria-label="推荐着法">◇ <span>{hintThinking ? "分析" : "提示"}</span></button>
            <button type="button" onClick={undo} disabled={!canUndo || aiThinking || hintThinking || reviewing} aria-label="悔棋">↶ <span>悔棋</span></button>
            <button type="button" onClick={() => setFlipped((current) => !current)} aria-label="翻转棋盘">⇅ <span>翻转</span></button>
            <button
              type="button"
              onClick={resign}
              disabled={!started || !!result || !!engineError || reviewing}
              aria-label="认输"
            >⚑ <span>认输</span></button>
            {mode === "online"
              ? <button type="button" onClick={lanLeave} disabled={lan.status === "idle"} aria-label="离开房间">⇠ <span>离开</span></button>
              : <button type="button" onClick={() => startNewGame()} aria-label="重新开局">↻ <span>重开</span></button>}
          </div>
  );

  const lanWaiting = mode === "online" && lan.status !== "playing" && !(started && lan.code);
  const statusTitle = mode === "online" && lan.pendingUndo
    ? lan.pendingUndo === lan.side ? "等待对方同意悔棋" : "对方请求悔棋"
    : lanWaiting
    ? lan.status === "idle" ? "局域网对弈" : lan.status === "joining" ? "正在连接" : "等待对手"
    : !started && !result
    ? "准备就绪"
    : engineError
    ? "计算暂停"
    : ruleNotice
    ? "行棋受限"
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
  const statusNote = mode === "online" && lan.pendingUndo && !ruleNotice
    ? lan.pendingUndo === lan.side ? "对方同意后将撤回你的最后一手" : "同意后将撤回对方的最后一手"
    : lanWaiting && !ruleNotice
    ? lan.status === "idle" ? "创建房间或输入房间码加入" : lan.status === "joining" ? "正在连接局域网服务…" : `房间码 ${lan.code}，等待对方加入`
    : !started && !result ? "点击棋盘上的「开始」进入对局" : engineError ?? ruleNotice ?? (reviewing
    ? visiblePly === history.length ? "已到达当前局面" : "可用下方按钮或着法记录逐步查看"
    : result?.message
    ?? (aiThinking
      ? (aiDifficulty === "master" || aiDifficulty === "grandmaster") && !pikafishReady
        ? "首次加载约 51MB 神经网络，完成后会由浏览器缓存"
        : "请稍候，对手正在推演棋路"
      : hintThinking
        ? `${AI_LEVEL_LABEL[aiDifficulty]}棋力正在寻找推荐着法`
        : hint
          ? `建议 ${hint.notation}，棋盘已标出起点与落点`
          : selected ? `可走 ${targets.length} 处` : "请选择一枚棋子"));
  const lostToComputer = (mode === "ai" && result?.winner === aiSide) || (mode === "online" && !!result?.winner && result.winner !== lan.side);
  const isDraw = !!result && !result.winner;
  const outcomeTitle = isDraw
    ? "此局言和"
    : lostToComputer
    ? "此局惜败"
    : mode === "ai" || mode === "online"
      ? "你赢了"
      : `${result?.winner === "red" ? "红方" : "黑方"}胜`;

  return (
    <main ref={fullscreenRef} className={`game-shell${boardFullscreen ? " is-fullscreen" : ""}`}>
          {boardFullscreen ? (
            <>
              <button ref={exitFullscreenRef} className="icon-button fullscreen-button fullscreen-exit" type="button" aria-label="退出全屏" title="退出全屏（Esc）" onClick={exitBoardFullscreen}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3" /></svg>
              </button>
              {fullscreenError ? <span className="fullscreen-error" role="alert">{fullscreenError}</span> : null}
            </>
          ) : null}

      <header className="topbar">
        <a className="brand" href="#game" aria-label="长安棋社首页">
          <span className="brand-seal">棋</span>
          <span><strong>长安棋社</strong><small>CHANG&apos;AN XIANGQI</small></span>
        </a>
        <div className="top-actions">
          <button ref={fullscreenButtonRef} className="icon-button fullscreen-button" type="button" aria-label="对局全屏" title="对局全屏" disabled={!restored} onClick={enterBoardFullscreen}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" /></svg>
          </button>
          {!boardFullscreen && fullscreenError ? <span className="fullscreen-error" role="alert">{fullscreenError}</span> : null}
          <SettingsPanel
            settings={{ soundOn, soundVolume, musicOn, musicVolume }}
            onChange={updateAudioSettings}
            onPreviewSound={() => playSound("move")}
          />
        </div>
      </header>

      <section ref={gameLayoutRef} className="game-layout" id="game">
        <div className="board-column" style={restored ? undefined : { visibility: "hidden" }} aria-busy={!restored}>
          {renderPlayer(topSide, true)}

          <div ref={boardStageRef} className="board-stage">
          <ChessBoard
            board={visibleBoard}
            turn={visibleTurn}
            flipped={flipped}
            reviewing={reviewing}
            visiblePly={visiblePly}
            checked={checked}
            selected={selected}
            targets={targets}
            lastMove={visibleLastMove}
            hint={hint}
            moving={moving}
            landing={landing}
            shaking={shaking}
            onMoveDone={handleMoveDone}
            onChoose={choosePoint}
          />
          {mode === "online" && lan.status !== "playing" && !(started && lan.code) ? (
            <div className="ready-overlay">
              <div className="ready-card lan-card">
                <span className="ready-seal" aria-hidden="true">棋</span>
                {lan.status === "idle" ? (
                  <>
                    <b>局域网对弈</b>
                    <label className="lan-field">
                      <span>服务地址</span>
                      <input value={lanHost} onChange={(event) => setLanHost(event.target.value)} spellCheck={false} placeholder="运行 npm run lan 的电脑地址" />
                    </label>
                    <div className="lan-actions">
                      <button type="button" className="ready-button" onClick={() => lanCreate("red")}>创建房间 · 执红</button>
                      <button type="button" className="ready-button ready-button-dark" onClick={() => lanCreate("black")}>创建房间 · 执黑</button>
                    </div>
                    <div className="lan-join">
                      <input
                        value={joinCode}
                        onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                        onKeyDown={(event) => { if (event.key === "Enter") lanJoin(); }}
                        inputMode="numeric"
                        placeholder="房间码"
                        aria-label="房间码"
                      />
                      <button type="button" onClick={lanJoin} disabled={joinCode.length !== 4}>加入</button>
                    </div>
                  </>
                ) : lan.status === "joining" ? (
                  <>
                    <b>正在连接</b>
                    <small>连接局域网服务…</small>
                    <button type="button" className="lan-cancel" onClick={lanLeave}>取消</button>
                  </>
                ) : (
                  <>
                    <small>房间码</small>
                    <b className="lan-code">{lan.code}</b>
                    <small>你执{lan.side === "red" ? "红" : "黑"} · 等待对方加入{lan.connected ? "" : " · 连接断开"}</small>
                    <div className="lan-invite">
                      <input value={inviteLink} readOnly aria-label="邀请链接" onFocus={(event) => event.target.select()} />
                      <button type="button" className={linkCopied ? "copied" : ""} onClick={copyInviteLink}>{linkCopied ? "已复制" : "复制链接"}</button>
                    </div>
                    <small>对方在同一网络打开此链接即可加入</small>
                    <button type="button" className="lan-cancel" onClick={lanLeave}>离开房间</button>
                  </>
                )}
              </div>
            </div>
          ) : !started && !result && !reviewing && mode !== "online" ? (
            <div className="ready-overlay">
              <div className="ready-card">
                <span className="ready-seal" aria-hidden="true">棋</span>
                <small>
                  {mode === "ai"
                    ? `人机对弈 · 你执${playerSide === "red" ? "红先行" : "黑后行"} · ${AI_LEVEL_LABEL[aiDifficulty]}`
                    : "同屏对弈 · 红方先行"}
                </small>
                <button type="button" className="ready-button" onClick={beginGame} autoFocus>
                  开始对局
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                </button>
              </div>
            </div>
          ) : null}
          </div>

          {renderPlayer(bottomSide)}
          {renderControls("controls-mobile")}
          <button
            type="button"
            className="drawer-toggle"
            aria-expanded={drawerOpen}
            aria-controls="side-panel"
            onClick={() => setDrawerOpen(true)}
          >
            <span>☰</span> 设置与着法记录<small>{history.length ? `${history.length} 手` : ""}</small>
          </button>
        </div>

        {drawerOpen ? <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" /> : null}
        <aside className={`side-panel${drawerOpen ? " is-open" : ""}`} id="side-panel">
          <div className="drawer-head">
            <span>设置与着法记录</span>
            <button type="button" className="dialog-close" onClick={() => setDrawerOpen(false)} aria-label="收起">✕</button>
          </div>
          <div className="mode-switch" role="group" aria-label="选择对局模式">
            <button className={mode === "ai" ? "active" : ""} type="button" onClick={() => startNewGame("ai")}>人机对弈</button>
            <button className={mode !== "ai" ? "active" : ""} type="button" onClick={() => { if (mode === "ai") startNewGame("local"); }}>双人对弈</button>
          </div>

          {mode !== "ai" ? (
            <div className="ai-setup">
              <div className="setup-row">
                <span className="setup-label">方式</span>
                <div className="seg seg-2" role="group" aria-label="选择双人对弈方式">
                  <button className={mode === "local" ? "active" : ""} type="button" aria-pressed={mode === "local"} title="两人共用这台设备轮流落子" onClick={() => { if (mode !== "local") startNewGame("local"); }}>同屏对弈</button>
                  <button className={mode === "online" ? "active" : ""} type="button" aria-pressed={mode === "online"} title="两台设备通过局域网对弈" onClick={() => { if (mode !== "online") startNewGame("online"); }}>局域网对弈</button>
                </div>
              </div>
            </div>
          ) : null}

          {lanInGame ? (
            <div className="lan-bar">
              <span>房间 <b>{lan.code}</b></span>
              <span>你执{lan.side === "red" ? "红" : "黑"}</span>
              <span className={lan.connected && lan.seats[lan.side === "red" ? "black" : "red"] ? "lan-ok" : "lan-bad"}>
                {!lan.connected ? "重连中" : lan.seats[lan.side === "red" ? "black" : "red"] ? "对手在线" : "对手离线"}
              </span>
            </div>
          ) : null}

          {mode === "ai" ? (
            <div className="ai-setup">
              <div className="setup-row">
                <span className="setup-label">执子</span>
                <div className="seg seg-2" role="group" aria-label="选择执子颜色（切换后重新开局）" title="切换后将重新开局">
                  {(["red", "black"] as Side[]).map((side) => (
                    <button
                      className={`${side}-seg${playerSide === side ? " active" : ""}`}
                      type="button"
                      key={side}
                      aria-pressed={playerSide === side}
                      onClick={() => { if (side !== playerSide) startNewGame("ai", side); }}
                    >
                      <i aria-hidden="true">{side === "red" ? "帥" : "将"}</i>
                      {side === "red" ? "红先" : "黑后"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setup-row">
                <span className="setup-label">棋力</span>
                <div className="seg seg-5" role="group" aria-label="选择电脑难度" title={AI_LEVEL_NOTE[aiDifficulty]}>
                  {(Object.keys(AI_LEVEL_LABEL) as AiLevel[]).map((level) => (
                    <button
                      className={aiDifficulty === level ? "active" : ""}
                      type="button"
                      key={level}
                      aria-pressed={aiDifficulty === level}
                      title={AI_LEVEL_NOTE[level]}
                      onClick={() => {
                        setAiDifficulty(level);
                        setHint(null);
                      }}
                    >
                      {AI_LEVEL_LABEL[level]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <div className={`board-status${result ? " game-over" : ""}${ruleNotice ? " rule-limited" : ""}`} role="status" aria-live="polite">
            <span className={`mini-piece ${turn === "black" ? "black-mini" : ""}`}>{turn === "red" ? "帥" : "将"}</span>
            <b>{statusTitle}{statusLoading ? <span className="status-loading" aria-hidden="true"><i /><i /><i /></span> : null}</b>
            <small>{statusNote}</small>
          </div>

          {renderControls("controls-desktop")}

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

            {(
              <div className="capture-summary">
                <div className="material-balance">
                  <small>子力对比</small>
                  <span className={materialDiff > 0 ? "balance-red" : materialDiff < 0 ? "balance-black" : ""}>
                    {materialDiff === 0 ? "势均力敌" : materialDiff > 0 ? `红方 +${materialDiff}` : `黑方 +${-materialDiff}`}
                  </span>
                </div>
                <div className="red-captures"><small>红方俘获</small><span>{capturedByRed.length ? capturedByRed.map((item, index) => <i className="captured-black" key={index}>{NAMES.black[item.captured!.t]}</i>) : <em>—</em>}</span></div>
                <div className="black-captures"><small>黑方俘获</small><span>{capturedByBlack.length ? capturedByBlack.map((item, index) => <i className="captured-red" key={index}>{NAMES.red[item.captured!.t]}</i>) : <em>—</em>}</span></div>
              </div>
            )}
          </div>
        </aside>
      </section>
      <footer><span>落子无悔，静候知音</span><b>代码工匠 · 用代码打磨每一步</b></footer>

      {result && !resultDismissed ? (
        <div className={`result-overlay ${isDraw ? "outcome-draw" : lostToComputer ? "outcome-lose" : "outcome-win"}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title">
          <div className="outcome-particles" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
          </div>
          <div className="outcome-card">
            <button type="button" className="dialog-close" onClick={() => setResultDismissed(true)} aria-label="关闭">✕</button>
            <div className="outcome-seal" aria-hidden="true"><span>{isDraw ? "和" : lostToComputer ? "敗" : "勝"}</span></div>
            <small>{isDraw ? "纹枰论道 · 握手言和" : lostToComputer ? "胜败乃兵家常事" : "妙手定乾坤"}</small>
            <h2 id="outcome-title">{outcomeTitle}</h2>
            <p>{result.message}</p>
            <div className="outcome-actions">
              {mode === "online"
                ? <button type="button" onClick={() => lanRef.current?.rematch()} disabled={lan.rematch.includes(lan.side)} autoFocus>{lan.rematch.includes(lan.side) ? "等待对方同意…" : lan.rematch.length ? "对方想再来一局 · 同意" : "再来一局"}</button>
                : <button type="button" onClick={() => startNewGame()} autoFocus>再来一局</button>}
              <button type="button" onClick={() => reviewTo(history.length)}>复盘棋局</button>
            </div>
          </div>
        </div>
      ) : null}

      {mode === "online" && lan.pendingUndo && lan.pendingUndo !== lan.side ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="undo-title">
          <div className="confirm-card">
            <div className="confirm-seal" aria-hidden="true"><span>悔</span></div>
            <h2 id="undo-title">对方请求悔棋</h2>
            <p>同意后将撤回对方的最后一手{turn !== lan.pendingUndo ? "" : "，以及你的回应"}。</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => lanRef.current?.replyUndo(true)} autoFocus>同意</button>
              <button type="button" onClick={() => lanRef.current?.replyUndo(false)}>拒绝</button>
            </div>
          </div>
        </div>
      ) : null}

      {resignConfirm ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="resign-title">
          <div className="confirm-card">
            <button type="button" className="dialog-close" onClick={() => setResignConfirm(false)} aria-label="关闭">✕</button>
            <div className="confirm-seal" aria-hidden="true"><span>認</span></div>
            <h2 id="resign-title">确定认输？</h2>
            <p>{mode === "online"
              ? `认输将判对方取胜，且不可撤销。`
              : `当前轮到${turn === "red" ? "红方" : "黑方"}行棋，认输将判${turn === "red" ? "黑方" : "红方"}取胜，且不可撤销。`}</p>
            <div className="confirm-actions">
              <button type="button" onClick={confirmResign} autoFocus>确定认输</button>
              <button type="button" onClick={() => setResignConfirm(false)}>继续对局</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
