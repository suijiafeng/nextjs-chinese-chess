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
