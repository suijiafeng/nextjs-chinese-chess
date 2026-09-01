import { memo, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { NAMES } from "@/lib/chess";
import type { Board, Piece, Side } from "@/lib/chess";

export type Coord = [number, number];

type MoveMarker = { from: Coord; to: Coord } | null;

export interface MovingPiece {
  piece: Piece;
  from: Coord;
  to: Coord;
  captured: Piece | null;
}

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
  moving: MovingPiece | null;
  onMoveDone: () => void;
  onChoose: (row: number, col: number) => void;
}

function sameCoord(coord: Coord | null | undefined, row: number, col: number) {
  return coord?.[0] === row && coord[1] === col;
}

function pointStyle(coord: Coord, flipped: boolean) {
  const visualRow = flipped ? 9 - coord[0] : coord[0];
  const visualCol = flipped ? 8 - coord[1] : coord[1];
  return { left: `${visualCol * 12.5}%`, top: `${visualRow * (100 / 9)}%` };
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
  moving,
  onMoveDone,
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

  const gridRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!moving || !ghostRef.current || !gridRef.current) return;
    const grid = gridRef.current.getBoundingClientRect();
    const fromStyle = pointStyle(moving.from, flipped);
    const toStyle = pointStyle(moving.to, flipped);
    const fromX = (parseFloat(fromStyle.left) / 100) * grid.width;
    const fromY = (parseFloat(fromStyle.top) / 100) * grid.height;
    const toX = (parseFloat(toStyle.left) / 100) * grid.width;
    const toY = (parseFloat(toStyle.top) / 100) * grid.height;
    const ghost = ghostRef.current;
    ghost.style.left = toStyle.left;
    ghost.style.top = toStyle.top;
    const anim = ghost.animate(
      [
        { translate: `${fromX - toX}px ${fromY - toY}px` },
        { translate: "0 0" },
      ],
      { duration: 240, easing: "cubic-bezier(.3, .72, .3, 1)", fill: "forwards" },
    );
    anim.onfinish = onMoveDone;
    return () => anim.cancel();
  }, [moving, flipped, onMoveDone]);

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
          ref={gridRef}
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
            const arrivingHere = !!moving && sameCoord(moving.to, row, col);
            const classes = [
              "point",
              piece ? `piece ${piece.side}` : "",
              target ? "target" : "",
              target && piece ? "capture-target" : "",
              selectedPoint ? "selected" : "",
              sameCoord(lastMove?.from, row, col) ? "last-from" : "",
              sameCoord(lastMove?.to, row, col) && !arrivingHere ? "last-to" : "",
              hintFrom ? "hint-from" : "",
              hintTo ? "hint-to" : "",
              kingChecked ? "king-check" : "",
              arrivingHere && piece ? "moving-hidden" : "",
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
          {moving ? (
            <>
              {moving.captured ? (
                <span
                  className={`move-ghost captured-ghost ${moving.captured.side}`}
                  style={pointStyle(moving.to, flipped)}
                  aria-hidden="true"
                >
                  <span>{NAMES[moving.captured.side][moving.captured.t]}</span>
                </span>
              ) : null}
              <span
                ref={ghostRef}
                className={`move-ghost ${moving.piece.side}`}
                style={pointStyle(moving.to, flipped)}
                aria-hidden="true"
              >
                <span>{NAMES[moving.piece.side][moving.piece.t]}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const ChessBoard = memo(ChessBoardView);
