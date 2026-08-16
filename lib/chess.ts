export const COLS = 9;
export const ROWS = 10;

export const NAMES = {
  red: { K: '帥', A: '仕', B: '相', N: '馬', R: '車', C: '炮', P: '兵' },
  black: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' },
};

export type Side = 'red' | 'black';
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';
export interface Piece { side: Side; t: PieceType }
export type Board = (Piece | null)[][];

export interface ChaseCandidate {
  target: [number, number];
  targetType: PieceType;
  prohibited: boolean;
}

export interface AdjudicationMove {
  mover: Piece;
  from: [number, number];
  to: [number, number];
  captured: Piece | null;
  check: boolean;
  positionKey: string;
  chaseCandidates: ChaseCandidate[];
}

export interface AdjudicationResult {
  winner: Side | null;
  message: string;
}

export function initialBoard(): Board {
  const b: Board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const back: PieceType[] = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
  back.forEach((t, c) => {
    b[9][c] = { side: 'red', t };
    b[0][c] = { side: 'black', t };
  });
  b[7][1] = b[7][7] = { side: 'red', t: 'C' };
  b[2][1] = b[2][7] = { side: 'black', t: 'C' };
  [0, 2, 4, 6, 8].forEach((c) => {
    b[6][c] = { side: 'red', t: 'P' };
    b[3][c] = { side: 'black', t: 'P' };
  });
  return b;
}

export const cloneBoard = (b: Board): Board => b.map((row) => row.map((p) => (p ? { ...p } : null)));

/** 相同棋子分布与行棋方构成同一局面。 */
export function positionKey(board: Board, turn: Side): string {
  return `${turn[0]}:${board.flat().map((piece) => piece ? `${piece.side[0]}${piece.t}` : "--").join("")}`;
}

const inBoard = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const inPalace = (r: number, c: number, side: Side) =>
  c >= 3 && c <= 5 && (side === 'red' ? r >= 7 : r <= 2);
const sameSide = (p: Piece | null, q: Piece | null) => !!p && !!q && p.side === q.side;

/** 伪合法走法（不检查送将） */
export function pseudoMoves(board: Board, r: number, c: number): [number, number][] {
  const p = board[r][c]!;
  const mv: [number, number][] = [];
  const push = (rr: number, cc: number) => {
    if (inBoard(rr, cc) && !sameSide(p, board[rr][cc])) mv.push([rr, cc]);
  };
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  switch (p.t) {
    case 'R':
      for (const [dr, dc] of ORTH) {
        let rr = r + dr, cc = c + dc;
        while (inBoard(rr, cc)) {
          if (!board[rr][cc]) mv.push([rr, cc]);
          else {
            if (!sameSide(p, board[rr][cc])) mv.push([rr, cc]);
            break;
          }
          rr += dr; cc += dc;
        }
      }
      break;
    case 'C':
      for (const [dr, dc] of ORTH) {
        let rr = r + dr, cc = c + dc, jumped = false;
        while (inBoard(rr, cc)) {
          if (!jumped) {
            if (!board[rr][cc]) mv.push([rr, cc]);
            else jumped = true;
          } else if (board[rr][cc]) {
            if (!sameSide(p, board[rr][cc])) mv.push([rr, cc]);
            break;
          }
          rr += dr; cc += dc;
        }
      }
      break;
    case 'N':
      for (const [dr, dc, lr, lc] of [
        [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
        [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
      ]) {
        if (inBoard(r + lr, c + lc) && !board[r + lr][c + lc]) push(r + dr, c + dc);
      }
      break;
    case 'B':
      for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const) {
        if (inBoard(r + dr, c + dc) && !board[r + dr / 2][c + dc / 2]) {
          const targetHalf = p.side === 'red' ? r + dr >= 5 : r + dr <= 4;
          if (targetHalf) push(r + dr, c + dc);
        }
      }
      break;
    case 'A':
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
        if (inPalace(r + dr, c + dc, p.side)) push(r + dr, c + dc);
      }
      break;
    case 'K':
      for (const [dr, dc] of ORTH) {
        if (inPalace(r + dr, c + dc, p.side)) push(r + dr, c + dc);
      }
      break;
    case 'P': {
      const fwd = p.side === 'red' ? -1 : 1;
      push(r + fwd, c);
      const crossed = p.side === 'red' ? r <= 4 : r >= 5;
      if (crossed) { push(r, c - 1); push(r, c + 1); }
      break;
    }
  }
  return mv;
}

export function findKing(board: Board, side: Side): [number, number] | null {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p.side === side && p.t === 'K') return [r, c];
    }
  return null;
}

function isAttacked(board: Board, r: number, c: number, bySide: Side): boolean {
  for (let rr = 0; rr < ROWS; rr++)
    for (let cc = 0; cc < COLS; cc++) {
      const p = board[rr][cc];
      if (p && p.side === bySide && pseudoMoves(board, rr, cc).some(([mr, mc]) => mr === r && mc === c))
        return true;
    }
  return false;
}

/** 将帅对脸 */
function generalsFacing(board: Board): boolean {
  const rk = findKing(board, 'red'), bk = findKing(board, 'black');
  if (!rk || !bk || rk[1] !== bk[1]) return false;
  for (let r = bk[0] + 1; r < rk[0]; r++) if (board[r][rk[1]]) return false;
  return true;
}

export function inCheck(board: Board, side: Side): boolean {
  const k = findKing(board, side);
  if (!k) return true;
  return isAttacked(board, k[0], k[1], side === 'red' ? 'black' : 'red') || generalsFacing(board);
}

export function legalMoves(board: Board, r: number, c: number): [number, number][] {
  const p = board[r][c]!;
  return pseudoMoves(board, r, c).filter(([tr, tc]) => {
    const nb = cloneBoard(board);
    nb[tr][tc] = nb[r][c];
    nb[r][c] = null;
    return !inCheck(nb, p.side);
  });
}

export function hasAnyMove(board: Board, side: Side): boolean {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p.side === side && legalMoves(board, r, c).length) return true;
    }
  return false;
}

function hasRealRoot(board: Board, attacker: Piece, from: [number, number], target: [number, number]): boolean {
  const [fr, fc] = from;
  const [tr, tc] = target;
  const afterCapture = cloneBoard(board);
  afterCapture[tr][tc] = { ...attacker };
  afterCapture[fr][fc] = null;
  const defender = attacker.side === "red" ? "black" : "red";

  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const piece = afterCapture[r][c];
      if (piece?.side === defender && legalMoves(afterCapture, r, c).some(([mr, mc]) => mr === tr && mc === tc)) {
        return true;
      }
    }
  return false;
}

/**
 * 只标记能够明确裁定的“捉”：行棋子下一着可合法吃到的非将帅棋子。
 * 有真根、同类相捉、将帅/兵卒参与及未过河兵卒均按规则排除自动判负。
 */
export function chaseCandidates(board: Board, moverAt: [number, number], gaveCheck: boolean): ChaseCandidate[] {
  if (gaveCheck) return [];
  const [r, c] = moverAt;
  const mover = board[r][c];
  if (!mover) return [];

  return legalMoves(board, r, c).flatMap(([tr, tc]) => {
    const target = board[tr][tc];
    if (!target || target.side === mover.side || target.t === "K") return [];
    const pawnNotCrossed = target.t === "P" && (target.side === "red" ? tr >= 5 : tr <= 4);
    const rooted = hasRealRoot(board, mover, [r, c], [tr, tc]);
    const protectedRookException = rooted && target.t === "R" && (mover.t === "N" || mover.t === "C");
    const prohibited = !pawnNotCrossed
      && mover.t !== "K"
      && mover.t !== "P"
      && mover.t !== target.t
      && (!rooted || protectedRookException);
    return [{ target: [tr, tc] as [number, number], targetType: target.t, prohibited }];
  });
}

function isPerpetualChase(records: AdjudicationMove[], side: Side): boolean {
  const responses: AdjudicationMove[] = [];
  for (let index = 0; index < records.length - 1; index++) {
    const move = records[index];
    if (move.mover.side !== side) continue;
    const response = records[index + 1];
    const chased = move.chaseCandidates.find(({ target, prohibited }) =>
      prohibited && target[0] === response.from[0] && target[1] === response.from[1]);
    if (!chased || chased.targetType !== response.mover.t) return false;
    responses.push(response);
  }
  if (responses.length < 3) return false;
  return responses.every((response, index) => index === 0
    || (responses[index - 1].to[0] === response.from[0] && responses[index - 1].to[1] === response.from[1]));
}

/** 世界象棋规则：长将优先判负；明确长捉判负；其余四次同局面判和。 */
export function repetitionAdjudication(
  initialPosition: string,
  records: AdjudicationMove[],
): AdjudicationResult | null {
  if (!records.length) return null;
  const current = records.at(-1)!.positionKey;
  const positions = [initialPosition, ...records.map(({ positionKey: key }) => key)];
  const occurrences = positions.flatMap((key, index) => key === current ? [index] : []);
  if (occurrences.length < 4) return null;

  const start = occurrences.at(-4)!;
  const end = occurrences.at(-1)!;
  const cycle = records.slice(start, end);
  const redMoves = cycle.filter(({ mover }) => mover.side === "red");
  const blackMoves = cycle.filter(({ mover }) => mover.side === "black");
  const redChecks = redMoves.length >= 3 && redMoves.every(({ check }) => check);
  const blackChecks = blackMoves.length >= 3 && blackMoves.every(({ check }) => check);

  if (redChecks && blackChecks) return { winner: null, message: "双方连续长将，和棋" };
  if (redChecks) return { winner: "black", message: "红方连续长将未变着，判负" };
  if (blackChecks) return { winner: "red", message: "黑方连续长将未变着，判负" };

  const redChases = isPerpetualChase(cycle, "red");
  const blackChases = isPerpetualChase(cycle, "black");
  if (redChases && blackChases) return { winner: null, message: "双方同类循环长捉，和棋" };
  if (redChases) return { winner: "black", message: "红方连续长捉未变着，判负" };
  if (blackChases) return { winner: "red", message: "黑方连续长捉未变着，判负" };
  return { winner: null, message: "同一局面出现四次，和棋" };
}

/** 自最后一次吃子起，双方合计100回合；其中最多计入10次将军。 */
export function naturalMoveAdjudication(records: AdjudicationMove[]): AdjudicationResult | null {
  const lastCapture = records.findLastIndex(({ captured }) => !!captured);
  let countedPlies = 0;
  let countedChecks = 0;
  for (const record of records.slice(lastCapture + 1)) {
    if (record.check) {
      if (countedChecks >= 10) continue;
      countedChecks++;
    }
    countedPlies++;
  }
  return countedPlies >= 200 ? { winner: null, message: "双方连续100回合未吃子，和棋" } : null;
}

// ---------- 简单 AI：贪心 + 一层防守回应 ----------
const VAL: Record<PieceType, number> = { K: 10000, R: 90, C: 45, N: 40, B: 20, A: 20, P: 10 };

function evalBoard(board: Board): number {
  let s = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p) continue;
      let v = VAL[p.t];
      if (p.t === 'P') v += (p.side === 'red' ? 6 - r : r - 3) * 2;
      s += p.side === 'red' ? v : -v;
    }
  return s;
}

export function aiBestMove(board: Board): [number, number, number, number] | null {
  let best: [number, number, number, number] | null = null;
  let bestScore = -Infinity;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p || p.side !== 'black') continue;
      for (const [tr, tc] of legalMoves(board, r, c)) {
        const nb = cloneBoard(board);
        const cap = nb[tr][tc];
        nb[tr][tc] = nb[r][c];
        nb[r][c] = null;
        let score = -evalBoard(nb) * 0.01;
        if (cap) score += VAL[cap.t] * 10;
        if (cap && cap.t === 'K') score = 99999;
        let worst = Infinity;
        outer: for (let rr2 = 0; rr2 < ROWS; rr2++)
          for (let cc2 = 0; cc2 < COLS; cc2++) {
            const q = nb[rr2][cc2];
            if (!q || q.side !== 'red') continue;
            for (const [mr, mc] of legalMoves(nb, rr2, cc2)) {
              const t = nb[mr][mc];
              worst = Math.min(worst, t ? -VAL[t.t] : 0);
              if (t && t.t === 'K') { worst = -99999; break outer; }
            }
          }
        if (worst > -Infinity) score += worst * 9;
        if (score > bestScore) { bestScore = score; best = [r, c, tr, tc]; }
      }
    }
  return best;
}
