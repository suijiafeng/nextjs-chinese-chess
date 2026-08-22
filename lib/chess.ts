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
  code?: "perpetual-check" | "mutual-perpetual-check" | "perpetual-chase" | "repetition" | "natural-limit" | "material-draw";
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

  if (redChecks && blackChecks) return { winner: null, message: "双方重复将军达到三次，和棋", code: "mutual-perpetual-check" };
  if (redChecks) return { winner: "black", message: "红方不能重复将军超过三次，判负", code: "perpetual-check" };
  if (blackChecks) return { winner: "red", message: "黑方不能重复将军超过三次，判负", code: "perpetual-check" };

  const redChases = isPerpetualChase(cycle, "red");
  const blackChases = isPerpetualChase(cycle, "black");
  if (redChases && blackChases) return { winner: null, message: "双方同类循环长捉，和棋", code: "perpetual-chase" };
  if (redChases) return { winner: "black", message: "红方连续长捉未变着，判负", code: "perpetual-chase" };
  if (blackChases) return { winner: "red", message: "黑方连续长捉未变着，判负", code: "perpetual-chase" };
  return { winner: null, message: "同一局面出现四次，和棋", code: "repetition" };
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
  return countedPlies >= 200 ? { winner: null, message: "双方连续100回合未吃子，和棋", code: "natural-limit" } : null;
}

/** 双方均无车、马、炮、兵卒时，防守子力无法进入对方九宫取胜。 */
export function materialDrawAdjudication(board: Board): AdjudicationResult | null {
  const hasOffensivePiece = board.flat().some((piece) =>
    piece && (piece.t === "R" || piece.t === "N" || piece.t === "C" || piece.t === "P"));
  return hasOffensivePiece ? null : { winner: null, message: "双方均无进攻子力，和棋", code: "material-draw" };
}

// ---------- AI：迭代加深 + Alpha-Beta + 静态搜索 ----------
export type AiDifficulty = "beginner" | "standard" | "hard" | "master";

export interface AiSearchProgress {
  depth: number;
  nodes: number;
  elapsedMs: number;
}

export interface AiOptions {
  difficulty?: AiDifficulty;
  history?: AdjudicationMove[];
  side?: Side;
  timeMs?: number;
  onProgress?: (progress: AiSearchProgress) => void;
}

type AiMove = {
  from: [number, number];
  to: [number, number];
  mover: Piece;
  captured: Piece | null;
  next: Board;
  check: boolean;
  order: number;
};

type TableEntry = {
  depth: number;
  value: number;
  flag: "exact" | "lower" | "upper";
  best?: string;
};

type SearchContext = {
  deadline: number;
  nodes: number;
  table: Map<string, TableEntry>;
  evaluations: Map<string, number>;
  killers: Map<number, string[]>;
  history: Map<string, number>;
};

const PIECE_VALUE: Record<PieceType, number> = {
  K: 100000,
  R: 900,
  C: 460,
  N: 430,
  B: 210,
  A: 210,
  P: 100,
};
const MOBILITY_VALUE: Record<PieceType, number> = { K: 1, R: 2, C: 3, N: 4, B: 1, A: 1, P: 2 };
const MATE_SCORE = 1_000_000;
const SEARCH_TIMEOUT = Symbol("search-timeout");
const AI_LIMITS: Record<AiDifficulty, { maxDepth: number; timeMs: number; randomWindow: number }> = {
  beginner: { maxDepth: 2, timeMs: 60, randomWindow: 130 },
  standard: { maxDepth: 4, timeMs: 200, randomWindow: 0 },
  hard: { maxDepth: 6, timeMs: 500, randomWindow: 0 },
  master: { maxDepth: 8, timeMs: 1500, randomWindow: 0 },
};

// Worker 长驻时保留安全的着法排序经验；局面分值仍按每次搜索重新计算。
const PERSISTENT_HISTORY = new Map<string, number>();
const ROOT_MOVE_HINTS = new Map<string, string>();

const PIECE_INDEX: Record<PieceType, number> = { K: 0, A: 1, B: 2, N: 3, R: 4, C: 5, P: 6 };
const ZOBRIST = (() => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  return Array.from({ length: ROWS * COLS }, () =>
    Array.from({ length: 14 }, () => [random(), random()] as const));
})();

function zobristKey(board: Board, side: Side): string {
  let first = side === "black" ? 0xa5a5a5a5 : 0;
  let second = side === "black" ? 0x5a5a5a5a : 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const index = PIECE_INDEX[piece.t] + (piece.side === "black" ? 7 : 0);
      const keys = ZOBRIST[r * COLS + c][index];
      first = (first ^ keys[0]) >>> 0;
      second = (second ^ keys[1]) >>> 0;
    }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function moveId(move: AiMove): string {
  return `${move.from[0]}${move.from[1]}${move.to[0]}${move.to[1]}`;
}

function ensureSearchTime(context: SearchContext) {
  context.nodes++;
  if ((context.nodes & 127) === 0 && Date.now() >= context.deadline) throw SEARCH_TIMEOUT;
}

function countBetween(board: Board, fr: number, fc: number, tr: number, tc: number): number {
  const dr = Math.sign(tr - fr), dc = Math.sign(tc - fc);
  let count = 0;
  for (let r = fr + dr, c = fc + dc; r !== tr || c !== tc; r += dr, c += dc) {
    if (board[r][c]) count++;
  }
  return count;
}

/** 用于局面估值的几何控制，不替代合法着法验证。 */
function pieceControls(board: Board, fr: number, fc: number, tr: number, tc: number): boolean {
  const piece = board[fr][fc];
  if (!piece || (fr === tr && fc === tc)) return false;
  const dr = tr - fr, dc = tc - fc;
  switch (piece.t) {
    case "R":
      return (fr === tr || fc === tc) && countBetween(board, fr, fc, tr, tc) === 0;
    case "C":
      return (fr === tr || fc === tc) && countBetween(board, fr, fc, tr, tc) === 1;
    case "N": {
      if (!((Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2))) return false;
      const leg = Math.abs(dr) === 2 ? [fr + Math.sign(dr), fc] : [fr, fc + Math.sign(dc)];
      return !board[leg[0]][leg[1]];
    }
    case "B":
      return Math.abs(dr) === 2 && Math.abs(dc) === 2
        && !board[fr + dr / 2][fc + dc / 2]
        && (piece.side === "red" ? tr >= 5 : tr <= 4);
    case "A":
      return Math.abs(dr) === 1 && Math.abs(dc) === 1 && inPalace(tr, tc, piece.side);
    case "K":
      return Math.abs(dr) + Math.abs(dc) === 1 && inPalace(tr, tc, piece.side);
    case "P": {
      const forward = piece.side === "red" ? -1 : 1;
      if (dr === forward && dc === 0) return true;
      const crossed = piece.side === "red" ? fr <= 4 : fr >= 5;
      return crossed && dr === 0 && Math.abs(dc) === 1;
    }
  }
}

function blockedHorseLegs(board: Board, r: number, c: number): number {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .filter(([dr, dc]) => inBoard(r + dr, c + dc) && !!board[r + dr][c + dc]).length;
}

/** 黑方为正、红方为负。 */
function evaluateBoard(board: Board): number {
  if (!findKing(board, "black")) return -MATE_SCORE;
  if (!findKing(board, "red")) return MATE_SCORE;
  if (materialDrawAdjudication(board)) return 0;
  let score = 0;
  const pieces: { r: number; c: number; piece: Piece; moves: [number, number][] }[] = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const piece = board[r][c];
      if (piece) pieces.push({ r, c, piece, moves: pseudoMoves(board, r, c) });
    }
  const protectedPieces = new Set<number>();
  const attackedPieces = new Set<number>();
  const threatBonus = new Map<number, number>();

  for (let attackerIndex = 0; attackerIndex < pieces.length; attackerIndex++) {
    const attacker = pieces[attackerIndex];
    let targets = 0;
    for (let targetIndex = 0; targetIndex < pieces.length; targetIndex++) {
      if (attackerIndex === targetIndex) continue;
      const target = pieces[targetIndex];
      if (!pieceControls(board, attacker.r, attacker.c, target.r, target.c)) continue;
      if (attacker.piece.side === target.piece.side) {
        protectedPieces.add(target.r * COLS + target.c);
      } else {
        attackedPieces.add(target.r * COLS + target.c);
        targets++;
        const pressure = Math.min(70, PIECE_VALUE[target.piece.t] * 0.055)
          + (attacker.piece.t === "C" && PIECE_VALUE[target.piece.t] >= PIECE_VALUE.N ? 18 : 0);
        threatBonus.set(attackerIndex, (threatBonus.get(attackerIndex) ?? 0) + pressure);
      }
    }
    if (targets >= 2) threatBonus.set(attackerIndex, (threatBonus.get(attackerIndex) ?? 0) + 34);
  }

  for (let index = 0; index < pieces.length; index++) {
      const { r, c, piece, moves } = pieces[index];
      const direction = piece.side === "black" ? 1 : -1;
      const center = 4 - Math.abs(c - 4);
      let positional = moves.length * MOBILITY_VALUE[piece.t] + (threatBonus.get(index) ?? 0);
      const square = r * COLS + c;

      if (piece.t === "P") {
        const advance = piece.side === "black" ? Math.max(0, r - 3) : Math.max(0, 6 - r);
        const crossed = piece.side === "black" ? r >= 5 : r <= 4;
        const nearPalace = piece.side === "black" ? r >= 7 : r <= 2;
        positional += advance * 18 + (crossed ? 34 + center * 5 : 0) + (nearPalace ? 42 : 0);
      } else if (piece.t === "N") {
        positional += center * 9 + (4 - Math.min(4, Math.abs(r - 4.5))) * 4 - blockedHorseLegs(board, r, c) * 16;
      } else if (piece.t === "C") {
        positional += center * 5;
      } else if (piece.t === "R") {
        const openLines = moves.filter(([tr, tc]) => !board[tr][tc] && (tr === r || tc === c)).length;
        positional += center * 3 + openLines * 2;
      } else if (piece.t === "K") {
        const home = piece.side === "black" ? r === 0 : r === 9;
        positional += home ? 34 : 0;
      }

      if (piece.t !== "K" && protectedPieces.has(square)) positional += 15;
      if (piece.t !== "K" && attackedPieces.has(square) && !protectedPieces.has(square)) {
        positional -= Math.min(115, PIECE_VALUE[piece.t] * 0.16);
      }
      score += direction * (PIECE_VALUE[piece.t] + positional);
  }

  for (const side of ["black", "red"] as const) {
    const direction = side === "black" ? 1 : -1;
    const own = pieces.filter(({ piece }) => piece.side === side);
    const defenders = own.filter(({ piece }) => piece.t === "A" || piece.t === "B").length;
    const rooks = own.filter(({ piece }) => piece.t === "R").length;
    const horses = own.filter(({ piece }) => piece.t === "N").length;
    const cannons = own.filter(({ piece }) => piece.t === "C").length;
    score += direction * (defenders * 13 + (rooks >= 2 ? 28 : 0) + (rooks && (horses || cannons) ? 24 : 0));
  }

  if (pieces.length <= 16) {
    const blackKing = findKing(board, "black")!;
    const redKing = findKing(board, "red")!;
    score += (pseudoMoves(board, blackKing[0], blackKing[1]).length
      - pseudoMoves(board, redKing[0], redKing[1]).length) * 15;
  }

  if (inCheck(board, "red")) score += 120;
  if (inCheck(board, "black")) score -= 120;
  return score;
}

function cachedEvaluation(board: Board, context: SearchContext): number {
  const key = zobristKey(board, "red");
  const cached = context.evaluations.get(key);
  if (cached !== undefined) return cached;
  const value = evaluateBoard(board);
  context.evaluations.set(key, value);
  return value;
}

function generateAiMoves(
  board: Board,
  side: Side,
  preferred?: string,
  context?: SearchContext,
  ply = 0,
): AiMove[] {
  const moves: AiMove[] = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const mover = board[r][c];
      if (!mover || mover.side !== side) continue;
      for (const [tr, tc] of legalMoves(board, r, c)) {
        const captured = board[tr][tc] ? { ...board[tr][tc]! } : null;
        const next = cloneBoard(board);
        next[tr][tc] = { ...mover };
        next[r][c] = null;
        const enemy: Side = side === "red" ? "black" : "red";
        const check = captured?.t === "K" || (!!findKing(next, enemy) && inCheck(next, enemy));
        const candidate: AiMove = {
          from: [r, c],
          to: [tr, tc],
          mover: { ...mover },
          captured,
          next,
          check,
          order: (captured ? PIECE_VALUE[captured.t] * 12 - PIECE_VALUE[mover.t] : 0) + (check ? 3000 : 0),
        };
        const id = moveId(candidate);
        if (preferred && id === preferred) candidate.order += 100000;
        if (context?.killers.get(ply)?.includes(id)) candidate.order += 1800;
        candidate.order += context?.history.get(id) ?? 0;
        moves.push(candidate);
      }
    }
  return moves.sort((a, b) => b.order - a.order);
}

function rememberCutoff(context: SearchContext, move: AiMove, ply: number, depth: number) {
  if (move.captured) return;
  const id = moveId(move);
  const killers = context.killers.get(ply) ?? [];
  if (!killers.includes(id)) context.killers.set(ply, [id, ...killers].slice(0, 2));
  context.history.set(id, Math.min(1200, (context.history.get(id) ?? 0) + depth * depth * 8));
}

/** 精选常见开局谱线：中炮、屏风马、仙人指路与飞相局。 */
const OPENING_LINES: readonly (readonly string[])[] = [
  ["7774", "0122", "9776", "0001", "9897", "0726", "6252", "3242"],
  ["7174", "0726", "9172", "0807", "9091", "0122", "6656", "3646"],
  ["6252", "3646", "7776", "2122", "9172", "0726", "9674", "0224"],
  ["9674", "0224", "9172", "0726", "6252", "3242", "7776", "2122"],
];

function parseMoveId(id: string): [number, number, number, number] | null {
  if (!/^\d{4}$/.test(id)) return null;
  const move = [...id].map(Number) as [number, number, number, number];
  const [fromRow, fromCol, toRow, toCol] = move;
  return inBoard(fromRow, fromCol) && inBoard(toRow, toCol) ? move : null;
}

function buildOpeningBook(): Map<string, Map<string, number>> {
  const book = new Map<string, Map<string, number>>();
  for (const line of OPENING_LINES) {
    let board = initialBoard();
    let side: Side = "red";
    for (const id of line) {
      const move = parseMoveId(id);
      if (!move) break;
      const [fr, fc, tr, tc] = move;
      const piece = board[fr]?.[fc];
      if (!piece || piece.side !== side
        || !legalMoves(board, fr, fc).some(([r, c]) => r === tr && c === tc)) break;
      const key = positionKey(board, side);
      const choices = book.get(key) ?? new Map<string, number>();
      choices.set(id, (choices.get(id) ?? 0) + 1);
      book.set(key, choices);
      const next = cloneBoard(board);
      next[tr][tc] = { ...piece };
      next[fr][fc] = null;
      board = next;
      side = side === "red" ? "black" : "red";
    }
  }
  return book;
}

const OPENING_BOOK = buildOpeningBook();

function openingBookMove(
  board: Board,
  side: Side,
  moves: AiMove[],
  history: AdjudicationMove[],
  difficulty: AiDifficulty,
): AiMove | null {
  if (history.length > 16) return null;
  const choices = OPENING_BOOK.get(positionKey(board, side));
  if (!choices?.size) return null;
  const candidates = [...choices]
    .flatMap(([id, weight]) => moves.filter((move) => moveId(move) === id).map((move) => ({ move, weight })))
    .sort((a, b) => b.weight - a.weight);
  if (!candidates.length) return null;
  if (difficulty === "beginner") return candidates[Math.floor(Math.random() * Math.min(3, candidates.length))].move;
  const bestWeight = candidates[0].weight;
  const preferred = candidates.filter(({ weight }) => weight >= bestWeight * 0.72);
  return preferred[history.length % preferred.length].move;
}

function quiescence(
  board: Board,
  side: Side,
  alpha: number,
  beta: number,
  context: SearchContext,
  depth: number,
): number {
  ensureSearchTime(context);
  const stand = cachedEvaluation(board, context);
  const checked = inCheck(board, side);
  const allMoves = checked ? generateAiMoves(board, side) : [];
  if (checked && !allMoves.length) return side === "black" ? -MATE_SCORE : MATE_SCORE;
  if (depth <= 0 && !checked) return stand;
  const tacticalMoves = checked
    ? allMoves
    : generateAiMoves(board, side).filter(({ captured, check }) => captured || check);

  if (side === "black") {
    let best = checked ? -Infinity : stand;
    if (!checked && best >= beta) return best;
    alpha = Math.max(alpha, best);
    for (const move of tacticalMoves) {
      best = Math.max(best, quiescence(move.next, "red", alpha, beta, context, depth - 1));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    return best;
  }

  let best = checked ? Infinity : stand;
  if (!checked && best <= alpha) return best;
  beta = Math.min(beta, best);
  for (const move of tacticalMoves) {
    best = Math.min(best, quiescence(move.next, "black", alpha, beta, context, depth - 1));
    beta = Math.min(beta, best);
    if (alpha >= beta) break;
  }
  return best;
}

function alphaBeta(
  board: Board,
  side: Side,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  context: SearchContext,
  path: Map<string, number>,
): number {
  ensureSearchTime(context);
  const key = positionKey(board, side);
  const previousOccurrences = path.get(key) ?? 0;
  if (previousOccurrences >= 4) return 0;
  if (!findKing(board, "black")) return -MATE_SCORE + ply;
  if (!findKing(board, "red")) return MATE_SCORE - ply;
  if (materialDrawAdjudication(board)) return 0;
  if (depth <= 0) return quiescence(board, side, alpha, beta, context, 1);

  const tableKey = zobristKey(board, side);
  const cached = context.table.get(tableKey);
  const originalAlpha = alpha;
  const originalBeta = beta;
  if (cached && cached.depth >= depth) {
    if (cached.flag === "exact") return cached.value;
    if (cached.flag === "lower") alpha = Math.max(alpha, cached.value);
    if (cached.flag === "upper") beta = Math.min(beta, cached.value);
    if (alpha >= beta) return cached.value;
  }

  const moves = generateAiMoves(board, side, cached?.best, context, ply);
  if (!moves.length) return side === "black" ? -MATE_SCORE + ply : MATE_SCORE - ply;
  let bestMove: AiMove | undefined;
  let value = side === "black" ? -Infinity : Infinity;

  path.set(key, previousOccurrences + 1);
  try {
    for (const move of moves) {
      const nextSide: Side = side === "black" ? "red" : "black";
      const result = alphaBeta(move.next, nextSide, depth - 1, alpha, beta, ply + 1, context, path);
      if ((side === "black" && result > value) || (side === "red" && result < value)) {
        value = result;
        bestMove = move;
      }
      if (side === "black") alpha = Math.max(alpha, value);
      else beta = Math.min(beta, value);
      if (alpha >= beta) {
        rememberCutoff(context, move, ply, depth);
        break;
      }
    }
  } finally {
    if (previousOccurrences) path.set(key, previousOccurrences);
    else path.delete(key);
  }

  const flag: TableEntry["flag"] = value <= originalAlpha ? "upper" : value >= originalBeta ? "lower" : "exact";
  if (!cached || depth >= cached.depth) {
    context.table.set(tableKey, { depth, value, flag, best: bestMove ? moveId(bestMove) : undefined });
  }
  return value;
}

export function aiBestMove(board: Board, options: AiOptions = {}): [number, number, number, number] | null {
  const difficulty = options.difficulty ?? "standard";
  const side = options.side ?? "black";
  const limits = AI_LIMITS[difficulty];
  const startedAt = Date.now();
  const context: SearchContext = {
    deadline: startedAt + (options.timeMs ?? limits.timeMs),
    nodes: 0,
    table: new Map(),
    evaluations: new Map(),
    killers: new Map(),
    history: new Map(PERSISTENT_HISTORY),
  };
  const rootKey = zobristKey(board, side);
  const rootMoves = generateAiMoves(board, side, ROOT_MOVE_HINTS.get(rootKey), context);
  if (!rootMoves.length) return null;
  const kingCapture = rootMoves.find(({ captured }) => captured?.t === "K");
  if (kingCapture) return [kingCapture.from[0], kingCapture.from[1], kingCapture.to[0], kingCapture.to[1]];
  const history = options.history ?? [];
  const bookMove = openingBookMove(board, side, rootMoves, history, difficulty);
  if (bookMove) return [bookMove.from[0], bookMove.from[1], bookMove.to[0], bookMove.to[1]];
  let completed: { move: AiMove; score: number }[] = [{
    move: rootMoves[0],
    score: side === "black" ? -Infinity : Infinity,
  }];
  const historyPath = new Map<string, number>();
  for (const key of [positionKey(initialBoard(), "red"), ...history.map(({ positionKey: itemKey }) => itemKey)]) {
    historyPath.set(key, (historyPath.get(key) ?? 0) + 1);
  }

  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    try {
      const iteration: { move: AiMove; score: number }[] = [];
      let rootAlpha = -Infinity;
      let rootBeta = Infinity;
      for (const move of rootMoves) {
        const synthetic: AdjudicationMove = {
          mover: move.mover,
          from: move.from,
          to: move.to,
          captured: move.captured,
          check: move.check,
          positionKey: positionKey(move.next, side === "black" ? "red" : "black"),
          chaseCandidates: chaseCandidates(move.next, move.to, move.check),
        };
        const adjudication = repetitionAdjudication(positionKey(initialBoard(), "red"), [...history, synthetic])
          ?? naturalMoveAdjudication([...history, synthetic]);
        const score = adjudication
          ? adjudication.winner === "black" ? MATE_SCORE : adjudication.winner === "red" ? -MATE_SCORE : 0
          : alphaBeta(
            move.next,
            side === "black" ? "red" : "black",
            depth - 1,
            rootAlpha,
            rootBeta,
            1,
            context,
            historyPath,
          );
        iteration.push({ move, score });
        if (side === "black") rootAlpha = Math.max(rootAlpha, score);
        else rootBeta = Math.min(rootBeta, score);
      }
      iteration.sort((a, b) => side === "black" ? b.score - a.score : a.score - b.score);
      completed = iteration;
      rootMoves.sort((a, b) => {
        const fallback = side === "black" ? -Infinity : Infinity;
        const aScore = iteration.find(({ move }) => moveId(move) === moveId(a))?.score ?? fallback;
        const bScore = iteration.find(({ move }) => moveId(move) === moveId(b))?.score ?? fallback;
        return side === "black" ? bScore - aScore : aScore - bScore;
      });
      options.onProgress?.({ depth, nodes: context.nodes, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      if (error !== SEARCH_TIMEOUT) throw error;
      break;
    }
  }

  const bestScore = completed[0].score;
  const candidates = difficulty === "beginner"
    ? completed.filter(({ score }) => side === "black"
      ? score >= bestScore - limits.randomWindow
      : score <= bestScore + limits.randomWindow).slice(0, 3)
    : completed.slice(0, 1);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]?.move ?? completed[0].move;
  ROOT_MOVE_HINTS.set(rootKey, moveId(chosen));
  if (ROOT_MOVE_HINTS.size > 512) ROOT_MOVE_HINTS.delete(ROOT_MOVE_HINTS.keys().next().value!);
  for (const [id, value] of context.history) {
    PERSISTENT_HISTORY.set(id, Math.max(PERSISTENT_HISTORY.get(id) ?? 0, Math.floor(value * 0.94)));
  }
  return [chosen.from[0], chosen.from[1], chosen.to[0], chosen.to[1]];
}
