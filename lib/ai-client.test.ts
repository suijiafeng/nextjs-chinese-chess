import { describe, expect, it } from "vitest";
import { LEVEL_PLAN, pickCandidate } from "./ai-client";
import type { PikafishCandidate } from "./pikafish";

const move = (n: number): [number, number, number, number] => [n, 0, n, 1];

function candidates(scores: number[], mates: (number | undefined)[] = []): PikafishCandidate[] {
  return scores.map((score, index) => ({ move: move(index), score, mate: mates[index], depth: 6 }));
}

describe("降智选着", () => {
  it("全力档位总是取最佳着", () => {
    const list = candidates([50, 48, 10]);
    expect(pickCandidate(list, LEVEL_PLAN.grandmaster, () => 0.99)).toEqual(move(0));
    expect(pickCandidate(list, LEVEL_PLAN.master, () => 0.99)).toEqual(move(0));
  });

  it("入门档会在分数窗口内选到次优着，窗口外的差着不会被选中", () => {
    const list = candidates([50, 20, -40, -900]);
    const picks = new Set<number>();
    for (let roll = 0.01; roll < 1; roll += 0.05) picks.add(pickCandidate(list, LEVEL_PLAN.beginner, () => roll)![0]);
    expect(picks.has(1)).toBe(true);
    expect(picks.has(3)).toBe(false);
  });

  it("困难档窗口很窄：差 70 分的着法不会被选", () => {
    const list = candidates([50, -20]);
    for (let roll = 0.01; roll < 1; roll += 0.1) expect(pickCandidate(list, LEVEL_PLAN.hard, () => roll)).toEqual(move(0));
  });

  it("有杀着时不随机；会被将死的着法永远不选", () => {
    const mating = candidates([99_990, 40], [10, undefined]);
    expect(pickCandidate(mating, LEVEL_PLAN.beginner, () => 0.99)).toEqual(move(0));
    const losing = candidates([30, 25, -99_995], [undefined, undefined, -5]);
    for (let roll = 0.01; roll < 1; roll += 0.1) expect(pickCandidate(losing, LEVEL_PLAN.beginner, () => roll)![0]).not.toBe(2);
  });

  it("空列表返回 null", () => {
    expect(pickCandidate([], LEVEL_PLAN.beginner)).toBeNull();
  });
});
