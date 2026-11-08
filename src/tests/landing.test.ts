import { describe, it, expect } from "vitest";
import { LandingAssessment } from "../physics/landing";
import { WalkingAssessment } from "../physics/assessment";
import { cloneConfig } from "../simulation/config";
import { Experiment } from "../simulation/experiment";
import { breedSharedSearch, sharedParents } from "../genetics/sharedSearch";
import { Random } from "../genetics/evolution";
import { parseCheckpoint } from "../persistence/files";
const base = {
  dt: 1 / 120,
  steps: [0, 0, 0, 0],
  contacts: [true, true, true, true],
  stable: true,
  eligible: true,
  tilt: 0.05,
  tiltSpeed: 0,
  x: 0.03,
};
function settle(
  a: LandingAssessment,
  input = { ...base, steps: [1, 0, 0, 0] },
) {
  for (let i = 0; i < 24; i++) a.observe(input);
}
describe("실제 안정 착지", () => {
  it("서 있기와 최초 낙하는 보상이 없고 실제 걸음 뒤 0.2초 하중 지지를 요구한다", () => {
    const a = new LandingAssessment();
    settle(a, base);
    expect(a.settledSteps).toEqual([0, 0, 0, 0]);
    for (let i = 0; i < 23; i++) a.observe({ ...base, steps: [1, 0, 0, 0] });
    expect(a.settledSteps[0]).toBe(0);
    a.observe({ ...base, steps: [1, 0, 0, 0] });
    expect(a.settledSteps[0]).toBe(1);
    settle(a);
    expect(a.settledSteps[0]).toBe(1);
  });
  it("착지 직후 넘어짐·접촉 손실·공중 동작은 안정 착지로 세지 않는다", () => {
    for (const failure of [
      { stable: false },
      { contacts: [false, true, true, true] },
    ]) {
      const a = new LandingAssessment();
      a.observe({ ...base, steps: [1, 0, 0, 0] });
      a.observe({ ...base, steps: [1, 0, 0, 0], ...failure });
      settle(a);
      expect(a.settledSteps[0]).toBe(0);
    }
  });
  it("발 옮김 뒤 관측된 기울기 회복만 보상하고 동시 착지와 반복 흔들기는 중복 보상하지 않는다", () => {
    const a = new LandingAssessment();
    a.observe({
      ...base,
      contacts: [false, false, true, true],
      tilt: 0.35,
      tiltSpeed: 0.3,
    });
    settle(a, { ...base, steps: [1, 1, 0, 0] });
    expect(a.recoverySteps).toBe(1);
    expect(a.settledSteps).toEqual([1, 1, 0, 0]);
    a.observe({
      ...base,
      steps: [1, 1, 0, 0],
      contacts: [false, true, true, true],
      tilt: 0.35,
      tiltSpeed: 0.3,
    });
    settle(a, { ...base, steps: [2, 1, 0, 0] });
    expect(a.recoverySteps).toBe(1);
  });
  it("충분히 지지한 실제 착지는 약간 짧은 생존에도 정지 개체보다 높은 점수이며 새 회복 보상은 제한된다", () => {
    const c = cloneConfig(),
      stand = new WalkingAssessment(c),
      walk = new WalkingAssessment(c);
    for (const a of [stand, walk]) {
      a.supportTime = 15;
      a.mobilityTime = 15;
      a.balanceTime = 15;
    }
    walk.supportTime = 14.8;
    walk.mobilityTime = 14.8;
    walk.balanceTime = 14.8;
    const score = (a: WalkingAssessment, feet: number[], recovery = 0) =>
      a.breakdown(
        0,
        [0, 0, 0, 0],
        0,
        15,
        "timeout",
        [],
        [],
        [],
        feet,
        recovery,
      );
    expect(score(walk, [1, 0, 0, 0]).total).toBeGreaterThan(
      score(stand, [0, 0, 0, 0]).total,
    );
    expect(score(walk, [1, 0, 0, 0], 99).total).toBe(
      score(walk, [1, 0, 0, 0], 2).total,
    );
    expect(score(walk, [1, 0, 0, 0]).steps).toBeGreaterThan(0.05);
  });
  it("챔피언 복사 없이 안정 착지 탐색 계보를 실제 유전자 그대로 보존한다", () => {
    const c = { ...cloneConfig(), population: 8 },
      e = new Experiment(c),
      rows = e.robots.map((r) => r.view());
    e.dispose();
    rows.forEach((r, i) => {
      r.outcome = "timeout";
      r.elapsed = 15;
      r.fitness = i === 0 ? 0.7 : 0.5;
      r.frame.gait.supportTime = 14;
      r.frame.gait.settledSteps = [0, 0, 0, 0];
    });
    rows[1].frame.gait.settledSteps = [1, 0, 0, 0];
    expect(sharedParents(rows, c, "balance", 1, null)).toContain(rows[1].id);
    const result = breedSharedSearch(
      rows,
      c,
      new Random(123),
      1,
      "balance",
      null,
    );
    const preserved = result.population.find(
      (r) => r.birth?.kind === "explorer",
    );
    expect(preserved?.genes).toEqual(rows[1].genes);
    expect(
      result.population.some((r) => r.champion || r.birth?.kind === "elite"),
    ).toBe(false);
    rows[1].outcome = "jumped";
    expect(
      breedSharedSearch(
        rows,
        c,
        new Random(123),
        1,
        "balance",
        null,
      ).population.some((r) => r.birth?.kind === "explorer"),
    ).toBe(false);
  });
  it("새 보상 저장은 다시 불러오고 구 보상 파일은 전환하지 않는다", () => {
    for (const rewardModel of [
      "settled-curriculum-v9",
      "mobile-curriculum-v8",
    ] as const) {
      const e = new Experiment({
        ...cloneConfig(),
        population: 2,
        duration: 1,
        rewardModel,
      });
      e.start(false);
      while (e.phase === "running") e.step();
      const saved = e.checkpoint(),
        loaded = parseCheckpoint(JSON.stringify(saved));
      expect(loaded.config.rewardModel).toBe(rewardModel);
      expect(loaded.completedResults).toEqual(saved.completedResults);
      e.dispose();
    }
  });
});

it("선택형 균형 공분산 탐색에서도 안정 착지 복사와 표본 좌표를 함께 검증한다", async () => {
  const { breedBalance, validateBalanceState } =
    await import("../genetics/balanceSearch");
  const c = {
    ...cloneConfig(),
    controllerModel: "local-feedback-rnn" as const,
    population: 8,
    parentCount: 3,
  };
  const e = new Experiment(c),
    rows = e.robots.map((r) => r.view());
  e.dispose();
  rows.forEach((r, i) => {
    r.outcome = "timeout";
    r.elapsed = 15;
    r.fitness = i === 0 ? 0.7 : 0.5;
    r.frame.gait.supportTime = 14;
    r.frame.gait.settledSteps = [0, 0, 0, 0];
  });
  rows[1].frame.gait.settledSteps = [1, 0, 0, 0];
  const result = breedBalance(rows, c, new Random(777), 1, null);
  expect(
    result.population.find((r) => r.birth?.kind === "explorer")?.genes,
  ).toEqual(rows[1].genes);
  expect(() =>
    validateBalanceState(result.state, result.population, 2, c),
  ).not.toThrow();
});

it("수동으로 제외한 안정 착지 개체를 강제로 부모로 넣지 않는다", async () => {
  const { breed } = await import("../genetics/evolution");
  const c = { ...cloneConfig(), population: 8 };
  const e = new Experiment(c),
    rows = e.robots.map((r) => r.view());
  e.dispose();
  rows.forEach((r, i) => {
    r.outcome = "timeout";
    r.fitness = i === 0 ? 0.7 : 0.5;
    r.frame.gait.supportTime = 14;
    r.frame.gait.settledSteps = [0, 0, 0, 0];
  });
  rows[1].frame.gait.settledSteps = [1, 0, 0, 0];
  const children = breed(rows, [rows[0].id], c, new Random(7), 1);
  expect(children.some((r) => r.parents.includes(rows[1].id))).toBe(false);
});
