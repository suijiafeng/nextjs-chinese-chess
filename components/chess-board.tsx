import { memo, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { NAMES } from "@/lib/chess";
import type { Board, Side } from "@/lib/chess";

export type Coord = [number, number];

type MoveMarker = { from: Coord; to: Coord } | null;

interface ChessBoardProps {
  board: Board;
  turn: Side;
  flipped: boolean;
  reviewing: boolean;
  visiblePly: number;
  checked: boolean;
  selected: Coord | null;
  targets: Coord[];
  lastMove: MoveMarker;
  hint: MoveMarker;
  onChoose: (row: number, col: number) => void;
}

function sameCoord(coord: Coord | null | undefined, row: number, col: number) {
  return coord?.[0] === row && coord[1] === col;
}

function ChessBoardView({
  board,
  turn,
  flipped,
  reviewing,
  visiblePly,
  checked,
  selected,
  targets,
  lastMove,
  hint,
  onChoose,
}: ChessBoardProps) {
  const coordinates = useMemo(() => {
    const points: Coord[] = [];
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 9; col++) points.push([row, col]);
    }
    return flipped ? points.reverse() : points;
  }, [flipped]);

  const targetKeys = useMemo(
    () => new Set(targets.map(([row, col]) => row * 9 + col)),
    [targets],
  );

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, row: number, col: number) => {
    const directions: Record<string, Coord> = {
      ArrowUp: [flipped ? 1 : -1, 0],
      ArrowDown: [flipped ? -1 : 1, 0],
      ArrowLeft: [0, flipped ? 1 : -1],
      ArrowRight: [0, flipped ? -1 : 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const nextRow = Math.max(0, Math.min(9, row + direction[0]));
    const nextCol = Math.max(0, Math.min(8, col + direction[1]));
    document.querySelector<HTMLButtonElement>(`[data-point="${nextRow}-${nextCol}"]`)?.focus();
  };

  return (
    <div className="board-frame" aria-label="中国象棋棋盘">
      <div className="board-surface">
        <div className="board-lines" aria-hidden="true">
          <span className="palace palace-top" />
          <span className="palace palace-bottom" />
          <span className="river"><b>楚 河</b><b>漢 界</b></span>
        </div>
        <div
          className="piece-grid"
          role="grid"
          aria-label={reviewing ? `复盘第${visiblePly}手` : `${turn === "red" ? "红方" : "黑方"}回合`}
        >
          {coordinates.map(([row, col]) => {
            const piece = board[row][col];
            const visualRow = flipped ? 9 - row : row;
            const visualCol = flipped ? 8 - col : col;
            const target = !reviewing && targetKeys.has(row * 9 + col);
            const selectedPoint = !reviewing && sameCoord(selected, row, col);
            const hintFrom = !reviewing && sameCoord(hint?.from, row, col);
            const hintTo = !reviewing && sameCoord(hint?.to, row, col);
            const kingChecked = checked && piece?.side === turn && piece.t === "K";
            const classes = [
              "point",
              piece ? `piece ${piece.side}` : "",
              target ? "target" : "",
              target && piece ? "capture-target" : "",
              selectedPoint ? "selected" : "",
              sameCoord(lastMove?.from, row, col) ? "last-from" : "",
              sameCoord(lastMove?.to, row, col) ? "last-to" : "",
              hintFrom ? "hint-from" : "",
              hintTo ? "hint-to" : "",
              kingChecked ? "king-check" : "",
            ].filter(Boolean).join(" ");
            const label = piece
              ? `${piece.side === "red" ? "红方" : "黑方"}${NAMES[piece.side][piece.t]}，第${row + 1}行第${col + 1}列`
              : `第${row + 1}行第${col + 1}列${target ? "，可落子" : ""}`;

            return (
              <button
                key={`${row}-${col}`}
                className={classes}
                type="button"
                role="gridcell"
                data-point={`${row}-${col}`}
                style={{ left: `${visualCol * 12.5}%`, top: `${visualRow * (100 / 9)}%` }}
                aria-label={label}
                aria-selected={selectedPoint}
                onClick={() => onChoose(row, col)}
                onKeyDown={(event) => handleKey(event, row, col)}
              >
                {piece ? <span>{NAMES[piece.side][piece.t]}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const ChessBoard = memo(ChessBoardView);
