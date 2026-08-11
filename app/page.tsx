"use client";

import {
  aiBestMove,
  cloneBoard,
  findKing,
  hasAnyMove,
  inCheck,
  initialBoard,
  legalMoves,
  NAMES,
} from "@/lib/chess";
import type { Board, Piece, Side } from "@/lib/chess";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

type Coord = [number, number];
type GameMode = "ai" | "local";
type SoundKind = "move" | "capture" | "check" | "win" | "lose";

interface MoveRecord {
  before: Board;
  turnBefore: Side;
  from: Coord;
  to: Coord;
  mover: Piece;
  captured: Piece | null;
  notation: string;
  check: boolean;
  redTime: number;
  blackTime: number;
}

interface GameResult {
  winner: Side;
  message: string;
}

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

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
  const [lastMove, setLastMove] = useState<{ from: Coord; to: Coord } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [mode, setMode] = useState<GameMode>("ai");
  const [soundOn, setSoundOn] = useState(true);
  const [aiThinking, setAiThinking] = useState(false);
  const [result, setResult] = useState<GameResult | null>(null);
  const [resultDismissed, setResultDismissed] = useState(false);
  const [times, setTimes] = useState({ red: 900, black: 900 });
  const audioRef = useRef<AudioContext | null>(null);

  const checked = useMemo(() => !result && inCheck(board, turn), [board, result, turn]);

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
    setMode(nextMode);
    setBoard(initialBoard());
    setTurn("red");
    setSelected(null);
    setTargets([]);
    setHistory([]);
    setLastMove(null);
    setResult(null);
    setResultDismissed(false);
    setAiThinking(false);
    setTimes({ red: 900, black: 900 });
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
    let gameResult: GameResult | null = null;

    if (!kingAlive) {
      gameResult = { winner: turn, message: `${turn === "red" ? "红方" : "黑方"}擒将取胜` };
    } else if (!hasAnyMove(next, nextTurn)) {
      gameResult = {
        winner: turn,
        message: gaveCheck ? "将死，对局结束" : "困毙，对局结束",
      };
    }

    const record: MoveRecord = {
      before,
      turnBefore: turn,
      from,
      to,
      mover: { ...piece },
      captured,
      notation: moveNotation(piece, from, to),
      check: gaveCheck,
      redTime: times.red,
      blackTime: times.black,
    };

    setBoard(next);
    setHistory((current) => [...current, record]);
    setLastMove({ from, to });
    setSelected(null);
    setTargets([]);
    setTurn(nextTurn);
    setResult(gameResult);
    if (gameResult) setResultDismissed(false);

    if (!gameResult) {
      if (gaveCheck) playSound("check");
      else playSound(captured ? "capture" : "move");
    }
    return true;
  }, [board, playSound, times.black, times.red, turn]);

  useEffect(() => {
    if (result) return;
    const timer = window.setInterval(() => {
      setTimes((current) => ({
        ...current,
        [turn]: Math.max(0, current[turn] - 1),
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [result, turn]);

  useEffect(() => {
    if (result || times[turn] > 0) return;
    const winner: Side = turn === "red" ? "black" : "red";
    setResult({ winner, message: `${turn === "red" ? "红方" : "黑方"}用时耗尽` });
    setResultDismissed(false);
  }, [result, times, turn]);

  useEffect(() => {
    if (!result) return;
    const lostToComputer = mode === "ai" && result.winner === "black";
    playSound(lostToComputer ? "lose" : "win");
  }, [mode, playSound, result]);

  useEffect(() => {
    if (mode !== "ai" || turn !== "black" || result) return;
    setAiThinking(true);
    const timer = window.setTimeout(() => {
      try {
        const move = aiBestMove(board);
        if (move) commitMove([move[0], move[1]], [move[2], move[3]]);
        else setResult({ winner: "red", message: "黑方无子可走，红方取胜" });
      } catch {
        setResult({ winner: "red", message: "棋局计算遇到问题，请重新开局" });
      } finally {
        setAiThinking(false);
      }
    }, 520);
    return () => window.clearTimeout(timer);
  }, [board, commitMove, mode, result, turn]);

  const choosePoint = (r: number, c: number) => {
    if (result || aiThinking || (mode === "ai" && turn === "black")) return;
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
    if (!history.length || aiThinking) return;
    const steps = mode === "ai" && turn === "red" && history.length >= 2 ? 2 : 1;
    const restoreIndex = history.length - steps;
    const restore = history[restoreIndex];
    const remaining = history.slice(0, restoreIndex);
    const previous = remaining.at(-1);

    setBoard(cloneBoard(restore.before));
    setTurn(restore.turnBefore);
    setTimes({ red: restore.redTime, black: restore.blackTime });
    setHistory(remaining);
    setLastMove(previous ? { from: previous.from, to: previous.to } : null);
    setSelected(null);
    setTargets([]);
    setResult(null);
    setResultDismissed(false);
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
    const active = turn === side && !result;
    const name = isRed ? "长安访客" : mode === "ai" ? "墨隐棋手" : "北境棋手";
    const note = active
      ? aiThinking && side === "black" ? "正在推演" : "轮到此方"
      : isRed ? "执红" : mode === "ai" ? "电脑执黑" : "执黑";
    return (
      <div className={`player-strip${top ? " player-strip-top" : ""}`}>
        <span className={`player-mark ${isRed ? "red-mark" : "black-mark"}`}>{isRed ? "帥" : "将"}</span>
        <span><b>{name}</b><small>{note}</small></span>
        <time className={active ? "active-clock" : ""}>{formatTime(times[side])}</time>
      </div>
    );
  };

  const statusTitle = result
    ? `${result.winner === "red" ? "红方" : "黑方"}胜`
    : aiThinking
      ? "墨隐思考中"
      : checked
        ? `${turn === "red" ? "红方" : "黑方"}被将军`
        : `${turn === "red" ? "红方" : "黑方"}行棋`;
  const statusNote = result?.message
    ?? (aiThinking ? "请稍候，对手正在推演棋路" : selected ? `可走 ${targets.length} 处` : "请选择一枚棋子");
  const lostToComputer = mode === "ai" && result?.winner === "black";
  const outcomeTitle = lostToComputer
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
              <div className="piece-grid" role="grid" aria-label={`${turn === "red" ? "红方" : "黑方"}回合`}>
                {viewCoordinates.map(([r, c]) => {
                  const piece = board[r][c];
                  const visualRow = flipped ? 9 - r : r;
                  const visualCol = flipped ? 8 - c : c;
                  const isTarget = targets.some(([tr, tc]) => tr === r && tc === c);
                  const isSelected = sameCoord(selected, r, c);
                  const isFrom = sameCoord(lastMove?.from ?? null, r, c);
                  const isTo = sameCoord(lastMove?.to ?? null, r, c);
                  const kingChecked = checked && piece?.side === turn && piece.t === "K";
                  const classes = [
                    "point",
                    piece ? `piece ${piece.side}` : "",
                    isTarget ? "target" : "",
                    isTarget && piece ? "capture-target" : "",
                    isSelected ? "selected" : "",
                    isFrom ? "last-from" : "",
                    isTo ? "last-to" : "",
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

          <div className={`turn-card${result ? " game-over" : ""}`} role="status" aria-live="polite">
            <span className="eyebrow">本局状态</span>
            <div className="turn-title">
              <span className={`mini-piece ${turn === "black" ? "black-mini" : ""}`}>{turn === "red" ? "帥" : "将"}</span>
              <div><b>{statusTitle}</b><small>{statusNote}</small></div>
            </div>
          </div>

          <div className="control-row">
            <button type="button" onClick={undo} disabled={!history.length || aiThinking} aria-label="悔棋">↶ <span>悔棋</span></button>
            <button type="button" onClick={() => setFlipped((current) => !current)} aria-label="翻转棋盘">⇅ <span>翻转</span></button>
            <button type="button" onClick={() => startNewGame()} aria-label="重新开局">↻ <span>重开</span></button>
          </div>

          <div className="record-card">
            <div className="section-heading"><span>着法记录</span><small>{history.length} 手</small></div>
            {history.length ? (
              <div className="record-list" aria-label="本局着法">
                {movePairs.map((pair, index) => (
                  <div className="move-pair" key={index}>
                    <span className="move-number">{index + 1}</span>
                    <span className="move-cell red-move">{pair.red.notation}{pair.red.check ? " 将" : ""}</span>
                    <span className="move-cell">{pair.black ? `${pair.black.notation}${pair.black.check ? " 将" : ""}` : "—"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-record"><span>拾</span><p>棋局尚未开始<br />落下第一子，记录便会出现在这里</p></div>
            )}

            {history.some((item) => item.captured) ? (
              <div className="capture-summary">
                <div><small>红方俘获</small><span>{capturedByRed.map((item, index) => <i key={index}>{NAMES.black[item.captured!.t]}</i>)}</span></div>
                <div><small>黑方俘获</small><span>{capturedByBlack.map((item, index) => <i key={index}>{NAMES.red[item.captured!.t]}</i>)}</span></div>
              </div>
            ) : null}
          </div>
          <p className="rule-note">完整象棋规则 · 自动检测将军、将死与困毙</p>
        </aside>
      </section>
      <footer>落子无悔，静候知音</footer>

      {result && !resultDismissed ? (
        <div className={`result-overlay ${lostToComputer ? "outcome-lose" : "outcome-win"}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title">
          <div className="outcome-particles" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
          </div>
          <div className="outcome-card">
            <div className="outcome-seal" aria-hidden="true"><span>{lostToComputer ? "敗" : "勝"}</span></div>
            <small>{lostToComputer ? "胜败乃兵家常事" : "妙手定乾坤"}</small>
            <h2 id="outcome-title">{outcomeTitle}</h2>
            <p>{result.message}</p>
            <div className="outcome-actions">
              <button type="button" onClick={() => startNewGame()} autoFocus>再来一局</button>
              <button type="button" onClick={() => setResultDismissed(true)}>复盘棋局</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
