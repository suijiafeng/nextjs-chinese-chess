"use client";

import { AI_LEVEL_LABEL, analyzeAtLevel, disposeAiClient, isAbortError } from "@/lib/ai-client";
import type { AiLevel } from "@/lib/ai-client";
import { initialState, playMove } from "@/lib/game-core";
import type { GameState } from "@/lib/game-core";
import type { Side } from "@/lib/chess";
import { useEffect, useRef, useState } from "react";

/**
 * 棋力标定页（不在导航里，直接访问 /arena）：让相邻档位互相对弈，统计胜率，判断档位是否平缓。
 * 相邻档位的高档胜率在 65%～75% 左右算平缓；接近 95% 说明中间断崖。
 */

const LEVELS = Object.keys(AI_LEVEL_LABEL) as AiLevel[];
const MAX_PLIES = 240;
const MOVETIME: Record<AiLevel, number> = { beginner: 400, standard: 800, hard: 1500, master: 3000, grandmaster: 4000 };

interface Tally {
  wins: number;
  losses: number;
  draws: number;
  plies: number[];
}

interface Pair {
  high: AiLevel;
  low: AiLevel;
  tally: Tally;
}

function emptyTally(): Tally {
  return { wins: 0, losses: 0, draws: 0, plies: [] };
}

export default function ArenaPage() {
  const [games, setGames] = useState(10);
  const [pairs, setPairs] = useState<Pair[]>(() => LEVELS.slice(1).map((high, index) => ({ high, low: LEVELS[index], tally: emptyTally() })));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    disposeAiClient();
  }, []);

  const append = (line: string) => setLog((prev) => [...prev.slice(-60), line]);

  async function playGame(red: AiLevel, black: AiLevel, signal: AbortSignal): Promise<{ winner: Side | null; plies: number }> {
    let state: GameState = initialState();
    for (let ply = 0; ply < MAX_PLIES; ply++) {
      const level = state.turn === "red" ? red : black;
      const move = await analyzeAtLevel(state.board, level, {
        history: state.history,
        side: state.turn,
        timeMs: MOVETIME[level],
      }, MOVETIME[level], undefined, undefined, signal);
      if (!move) return { winner: state.turn === "red" ? "black" : "red", plies: ply };
      let outcome = playMove(state, [move[0], move[1]], [move[2], move[3]]);
      if (!outcome.ok) {
        // 引擎选了禁着（长将/长捉）或非法着法：改用内置引擎重选一次。
        const safe = await analyzeAtLevel(state.board, level, {
          history: state.history,
          side: state.turn,
          timeMs: 600,
          forceBuiltin: true,
        }, 600, undefined, undefined, signal);
        if (!safe) return { winner: state.turn === "red" ? "black" : "red", plies: ply };
        outcome = playMove(state, [safe[0], safe[1]], [safe[2], safe[3]]);
        if (!outcome.ok) return { winner: null, plies: ply };
      }
      state = outcome.state;
      setCurrent(`${AI_LEVEL_LABEL[red]}(红) vs ${AI_LEVEL_LABEL[black]}(黑) · 第 ${ply + 1} 手 ${outcome.notation}`);
      if (state.result) return { winner: state.result.winner, plies: ply + 1 };
    }
    return { winner: null, plies: MAX_PLIES };
  }

  async function run() {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPairs((prev) => prev.map((pair) => ({ ...pair, tally: emptyTally() })));
    try {
      for (const pair of pairs) {
        for (let index = 0; index < games; index++) {
          // 轮流执红，抵消先手优势。
          const highIsRed = index % 2 === 0;
          const red = highIsRed ? pair.high : pair.low;
          const black = highIsRed ? pair.low : pair.high;
          const started = Date.now();
          const result = await playGame(red, black, controller.signal);
          const highWon = result.winner && ((result.winner === "red") === highIsRed);
          const highLost = result.winner && !highWon;
          setPairs((prev) => prev.map((item) => item.high !== pair.high ? item : {
            ...item,
            tally: {
              wins: item.tally.wins + (highWon ? 1 : 0),
              losses: item.tally.losses + (highLost ? 1 : 0),
              draws: item.tally.draws + (result.winner ? 0 : 1),
              plies: [...item.tally.plies, result.plies],
            },
          }));
          append(`${AI_LEVEL_LABEL[pair.high]} vs ${AI_LEVEL_LABEL[pair.low]} 第 ${index + 1} 局：${result.winner ? (highWon ? "高档胜" : "低档胜") : "和"} · ${result.plies} 手 · ${Math.round((Date.now() - started) / 1000)} 秒`);
        }
      }
      setCurrent("全部完成");
    } catch (error) {
      if (!isAbortError(error)) {
        console.error(error);
        append(`出错：${error instanceof Error ? error.message : String(error)}`);
      }
      setCurrent("已停止");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px", fontFamily: "ui-sans-serif, system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>棋力标定</h1>
      <p style={{ color: "#777", marginTop: 0 }}>相邻档位互相对弈，轮流执红。高档胜率 65%～75% 为平缓，接近 95% 说明中间有断崖。需要 Pikafish 能在当前浏览器运行。</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <label>每对局数
          <input type="number" min={2} max={50} step={2} value={games} disabled={running} onChange={(event) => setGames(Math.max(2, Number(event.target.value) || 2))} style={{ width: 64, marginLeft: 8 }} />
        </label>
        <button type="button" onClick={run} disabled={running}>{running ? "进行中…" : "开始"}</button>
        <button type="button" onClick={stop} disabled={!running}>停止</button>
        <span style={{ color: "#777", fontSize: 13 }}>{current}</span>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th style={{ padding: "6px 8px" }}>高档</th><th>低档</th><th>高档胜</th><th>和</th><th>低档胜</th><th>高档胜率</th><th>平均手数</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(({ high, low, tally }) => {
            const total = tally.wins + tally.losses + tally.draws;
            const rate = total ? ((tally.wins + tally.draws / 2) / total * 100).toFixed(0) : "—";
            const avg = tally.plies.length ? Math.round(tally.plies.reduce((sum, n) => sum + n, 0) / tally.plies.length) : "—";
            return (
              <tr key={high} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "6px 8px" }}>{AI_LEVEL_LABEL[high]}</td><td>{AI_LEVEL_LABEL[low]}</td>
                <td>{tally.wins}</td><td>{tally.draws}</td><td>{tally.losses}</td>
                <td><b>{rate}{total ? "%" : ""}</b></td><td>{avg}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <pre style={{ marginTop: 20, padding: 12, background: "#f5f5f5", fontSize: 12, maxHeight: 320, overflow: "auto" }}>{log.join("\n")}</pre>
    </main>
  );
}
