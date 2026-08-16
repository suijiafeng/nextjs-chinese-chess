import { aiBestMove } from "../lib/chess";
import type { AiOptions, AiSearchProgress, Board } from "../lib/chess";

interface WorkerRequest {
  id: number;
  board: Board;
  options: AiOptions;
  reportProgress?: boolean;
}

interface WorkerResponse {
  id: number;
  move: [number, number, number, number] | null;
  error?: string;
  progress?: AiSearchProgress;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, board, options, reportProgress } = event.data;
  try {
    const move = aiBestMove(board, {
      ...options,
      onProgress: reportProgress ? (progress) => {
        const response: WorkerResponse = { id, move: null, progress };
        self.postMessage(response);
      } : undefined,
    });
    const response: WorkerResponse = { id, move };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      move: null,
      error: error instanceof Error ? error.message : "棋局分析失败",
    };
    self.postMessage(response);
  }
};
