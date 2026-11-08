import { describe, it, expect } from "vitest";
import {
  Random,
  randomGenes,
  breed,
  rank,
  rankDistance,
  RANGES,
  planSearch,
  suggestParents,
} from "../genetics/evolution";
import {
  OUTPUT_OFFSET,
  OUTPUT_STRIDE,
  FREQUENCY_INDEX,
  INPUT_SIZE,
  HIDDEN_STRIDE,
} from "../controllers/genome";
import { cloneConfig as currentConfig } from "../simulation/config";
const cloneConfig = () => ({
  ...currentConfig(),
  controllerModel: "timed-rnn" as const,
  searchMethod: "adaptive" as const,
});
import { Experiment } from "../simulation/experiment";
import { parseCheckpoint } from "../persistence/files";
import type { RobotView, Stat, TrainingStage } from "../simulation/types";
const finish = (e: Experiment) => {
  e.start(false);
  while (e.phase === "running") e.step();
};
function population() {
  const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
  finish(e);
  const views = e.robots.map((r) => r.view());
  e.dispose();
  return views;
}
describe("유전 알고리즘", () => {
  it("시드·PRNG 저장 상태가 난수열을 재현한다", () => {
    const a = new Random(1);
    randomGenes(a);
    const b = new Random(a.state);
    expect(randomGenes(a)).toEqual(randomGenes(b));
  });
  it("거리 우선이며 넘어져도 1등이 될 수 있다", () => {
    const p = population();
    p[0].frame.distance = 3;
    p[0].outcome = "fallen";
    p[0].fitness = -0.2;
    p[1].frame.distance = 2;
    p[1].fitness = 0.8;
    expect(rankDistance(p)[0].id).toBe(p[0].id);
  });
  it("거리 동률은 도달 tick 다음 ID로 정한다", () => {
    const p = population();
    p.forEach((r) => {
      r.frame.distance = 1;
      r.reachedTick = 20;
      r.fitness = 0.5;
    });
    p[2].reachedTick = 10;
    expect(rankDistance(p)[0].id).toBe(p[2].id);
    p[2].reachedTick = 20;
    expect(rankDistance(p)[0].id).toBe(1);
  });
  it("교차는 두 부모의 실제 유전자를 조합한다", () => {
    const p = population().slice(0, 2);
    p[0].genes = RANGES.map(([a]) => a);
    p[1].genes = RANGES.map(([, b]) => b);
    const cfg = { ...cloneConfig(), population: 20, crossover: 1, mutation: 0 };
    const c = breed(
      p,
      p.map((r) => r.id),
      cfg,
      new Random(123),
    );
    expect(
      c.some(
        (r) =>
          !r.champion &&
          r.genes.some((v, i) => v === p[0].genes[i]) &&
          r.genes.some((v, i) => v === p[1].genes[i]),
      ),
    ).toBe(true);
  });
  it("돌연변이와 교차가 엘리트·부모 원본을 바꾸지 않는다", () => {
    const p = population(),
      original = structuredClone(p),
      winner = rank(p)[0];
    const c = breed(
      p,
      [p[1].id],
      { ...cloneConfig(), population: 10, mutation: 1 },
      new Random(5),
    );
    expect(c[0].genes).toEqual(winner.genes);
    expect(c.filter((r) => r.champion)).toHaveLength(1);
    expect(
      c
        .slice(1)
        .some((r) => JSON.stringify(r.genes) !== JSON.stringify(p[1].genes)),
    ).toBe(true);
    c[1].genes.forEach((v, i) =>
      expect(v).toBeGreaterThanOrEqual(RANGES[i][0]),
    );
    expect(p).toEqual(original);
    c[0].genes[0] = 99;
    expect(winner.genes[0]).not.toBe(99);
  });
  it("선택만으로 진화하지 않고 결정 시 챔피언 하나를 보존한다", () => {
    const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
    expect(e.robots.filter((r) => r.individual.champion)).toHaveLength(0);
    finish(e);
    const winner = rank(e.robots.map((r) => r.view()))[0];
    e.selected = [2];
    expect(e.generation).toBe(1);
    e.evolve();
    expect(e.generation).toBe(2);
    expect(e.robots[0].individual.genes).toEqual(winner.genes);
    expect(e.robots.filter((r) => r.individual.champion)).toHaveLength(1);
  });
  it("빈 부모 풀은 거부한다", () => {
    const e = new Experiment({ ...cloneConfig(), population: 2, duration: 1 });
    finish(e);
    expect(() => e.evolve([])).toThrow();
    expect(e.generation).toBe(1);
  });
});
describe("평가와 상태 재현성", () => {
  it("동일 조건 개체는 독립 World 안에서도 동일 결과다", () => {
    const cfg = { ...cloneConfig(), population: 4, duration: 1 };
    const a = new Experiment(cfg),
      b = new Experiment(cfg);
    b.robots[0].individual.genes = [...a.robots[0].individual.genes];
    finish(a);
    finish(b);
    expect(a.robots[0].view()).toEqual(b.robots[0].view());
    expect(a.robots[0].world).not.toBe(a.robots[1].world);
  });
  it("계산 묶음 크기가 물리 결과를 바꾸지 않는다", () => {
    const cfg = { ...cloneConfig(), population: 4, duration: 1 };
    const a = new Experiment(cfg),
      b = new Experiment(cfg);
    finish(a);
    b.start(false);
    while (b.phase === "running") {
      for (let i = 0; i < 100; i++) b.step();
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  });
  it("일시정지 중 물리·tick·유전자·난수를 보존하고 이어서 실행한다", () => {
    const cfg = { ...cloneConfig(), population: 2, duration: 1 };
    const a = new Experiment(cfg),
      b = new Experiment(cfg);
    a.start(true);
    for (let i = 0; i < 30; i++) a.step();
    a.pause();
    const state = structuredClone(a.snapshot()),
      memory = a.robots.map((r) => [...r.controller.memory]),
      rng = a.rng.state,
      times = a.robots.map((r) => r.controller.elapsed);
    for (let i = 0; i < 100; i++) a.step();
    expect(a.snapshot()).toEqual(state);
    expect(a.rng.state).toBe(rng);
    expect(a.robots.map((r) => r.controller.elapsed)).toEqual(times);
    expect(a.robots.map((r) => [...r.controller.memory])).toEqual(memory);
    a.start(false);
    while (a.phase === "running") a.step();
    finish(b);
    expect(a.robots.map((r) => r.view())).toEqual(
      b.robots.map((r) => r.view()),
    );
  });
  it("모든 개체는 tick 0에 시작하고 세대 종료 시 기록은 하나다", () => {
    const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
    expect(e.robots.every((r) => r.tick === 0)).toBe(true);
    finish(e);
    for (let i = 0; i < 100; i++) e.step();
    expect(e.history).toHaveLength(1);
    expect(e.history[0].bestDistanceM).toBe(
      rankDistance(e.robots.map((r) => r.view()))[0].frame.distance,
    );
  });
});

it("진화 설정은 다음 세대 경계에만 적용한다", () => {
  const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
  e.start(true);
  for (let i = 0; i < 10; i++) e.step();
  e.queueSettings({
    population: 6,
    mutation: 0.2,
    crossover: 0.7,
    parentCount: 2,
  });
  expect(e.robots).toHaveLength(4);
  expect(e.config.mutation).toBe(0.1);
  while (e.phase === "running") e.step();
  e.evolve(e.autoParents());
  expect(e.robots).toHaveLength(6);
  expect(e.config.mutation).toBe(0.2);
  expect(e.robots.filter((r) => r.individual.champion)).toHaveLength(1);
});

it("기본 20대: 선택한 부모만 복사하고 모든 자식에 작은 변이를 보장한다", () => {
  const p = population(),
    original = structuredClone(p),
    cfg = cloneConfig();
  expect(cfg.population).toBe(20);
  expect(cfg.crossover).toBe(0);
  for (let seed = 0; seed < 10; seed++) {
    const children = breed(
      p,
      [2, 4],
      { ...cfg, mutation: 0.00001 },
      new Random(seed),
      7,
    );
    expect(children).toHaveLength(20);
    expect(children[0].genes).toEqual(rank(p)[0].genes);
    expect(children[0].birth?.changedGenes).toEqual([]);
    expect(children.filter((c) => c.champion)).toHaveLength(1);
    expect(children.slice(1).some((c) => c.parents[0] === 2)).toBe(true);
    expect(children.slice(1).some((c) => c.parents[0] === 4)).toBe(true);
    for (const c of children.slice(1)) {
      expect(c.parents).toHaveLength(1);
      expect([2, 4]).toContain(c.parents[0]);
      const parent = p.find((r) => r.id === c.parents[0])!;
      expect(c.birth?.generation).toBe(7);
      expect(c.birth?.parentGenes).toEqual(parent.genes);
      const changes = c.genes.flatMap((v, i) =>
        v !== parent.genes[i] ? [i] : [],
      );
      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(c.birth?.changedGenes).toEqual(changes);
      c.genes.forEach((v, i) => {
        expect(Math.abs(v - parent.genes[i])).toBeLessThanOrEqual(
          (RANGES[i][1] - RANGES[i][0]) * cfg.mutationScale + 1e-12,
        );
        expect(v).toBeGreaterThanOrEqual(RANGES[i][0]);
        expect(v).toBeLessThanOrEqual(RANGES[i][1]);
      });
    }
  }
  expect(p).toEqual(original);
}, 15000);
it("유전자 경계에서도 변이가 사라지지 않고 0% 설정은 정확히 복사한다", () => {
  const p = population();
  p[1].genes = RANGES.map(([lo, hi], i) => (i % 2 ? lo : hi));
  const cfg = { ...cloneConfig(), mutation: 1 };
  const children = breed(p, [2], cfg, new Random(42));
  for (const c of children.slice(1))
    expect(c.birth?.changedGenes).toHaveLength(RANGES.length);
  const copies = breed(p, [2], { ...cfg, mutation: 0 }, new Random(42));
  for (const c of copies.slice(1)) {
    expect(c.genes).toEqual(p[1].genes);
    expect(c.birth?.kind).toBe("copy");
    expect(c.birth?.changedGenes).toEqual([]);
  }
});

it("짧게라도 정상 보행한 개체가 긴 체공·생존 개체보다 먼저 선발된다", () => {
  const p = population();
  p.forEach((r) => {
    r.outcome = "fallen";
    r.fitness = 0;
    r.frame.distance = 0;
  });
  p[0].elapsed = 0.5;
  p[0].frame.tick = 60;
  p[0].fitness = 0.3;
  p[0].frame.distance = 0.1;
  p[1].elapsed = 5;
  p[1].frame.tick = 600;
  p[1].fitness = 0.8;
  p[1].outcome = "jumped";
  p[2].elapsed = 7;
  p[2].frame.tick = 840;
  p[2].fitness = 0.05;
  expect(rank(p)[0].id).toBe(1);
  const children = breed(p, [1, 3], cloneConfig(), new Random(3));
  expect(children[0].parents).toEqual([1]);
});
it("보행 점수 동률은 인정 거리·접지 전진·발 지지·ID 순으로 정한다", () => {
  const p = population();
  p.forEach((r) => {
    r.outcome = "fallen";
    r.fitness = 0.2;
    r.frame.distance = 0;
    r.frame.gait.groundedForward = 0;
    r.frame.gait.supportTime = 0;
  });
  p[2].frame.distance = 0.1;
  expect(rank(p)[0].id).toBe(3);
  p[2].frame.distance = 0;
  p[1].frame.gait.groundedForward = 0.1;
  expect(rank(p)[0].id).toBe(2);
});
it("자동 선택은 점프 개체를 제외한 보행 점수 상위 부모를 고른다", () => {
  const e = new Experiment({
    ...cloneConfig(),
    population: 4,
    duration: 1,
    parentCount: 2,
  });
  finish(e);
  const p = e.robots.map((r) => r.view());
  p.forEach((r, i) => {
    r.outcome = i === 0 ? "jumped" : "fallen";
    r.fitness = [0.9, 0.2, 0.3, 0.1][i];
  });
  e.robots.forEach((r, i) => {
    r.view = () => p[i];
  });
  expect(e.autoParents()).toEqual([3, 2]);
  expect(e.generation).toBe(1);
  e.dispose();
});
it("정체 시 부모 원본과 엘리트를 유지하면서 새 무작위 탐색 개체를 공급한다", () => {
  const p = population(),
    saved = structuredClone(p),
    cfg = cloneConfig();
  const c = breed(p, [1, 2], cfg, new Random(41), 10, true);
  expect(c).toHaveLength(20);
  expect(c.filter((r) => r.immigrant)).toHaveLength(2);
  expect(
    c
      .filter((r) => r.immigrant)
      .every((r) => r.parents.length === 0 && !r.birth && !r.champion),
  ).toBe(true);
  expect(c[0].genes).toEqual(rank(p)[0].genes);
  expect(p).toEqual(saved);
});

function history(stage: TrainingStage = "balance", count = 5): Stat[] {
  return Array.from({ length: count }, (_, i) => ({
    stage,
    maxSupportTime: 0.5,
    maxFootCount: 0,
    maxWalkingTime: 0,
    qualifiedCount: 0,
    generation: i + 1,
    bestDistanceM: 0,
    meanDistanceM: 0,
    bestFitness: -0.08,
    meanFitness: -0.09,
    fallenCount: 20,
    successCount: 0,
    bestRobotId: 1,
  }));
}
describe("실패·정체에 따른 탐색 확대", () => {
  it("대부분 넘어지면 작은 변이를 남기며 중간·큰 변이와 새 개체를 섞는다", () => {
    const p = population();
    p.forEach((r) => (r.outcome = "fallen"));
    const plan = planSearch(p, history("balance", 1), cloneConfig(), "balance");
    expect(plan.mode).toBe("recovery");
    expect(plan.counts).toEqual({
      preserved: 0,
      small: 10,
      medium: 5,
      large: 2,
      immigrant: 2,
    });
    expect(plan.profiles.medium).toEqual({
      kind: "medium",
      rate: 0.2,
      scale: 0.09,
    });
    expect(plan.profiles.large.rate).toBeCloseTo(0.35);
    expect(plan.profiles.large.scale).toBe(0.24);
  });
  it("5세대 성과 정체에는 더 넓게 탐색하되 승급·개선은 보존한다", () => {
    const p = population();
    p.forEach((r) => (r.outcome = "fallen"));
    const h = history(),
      cfg = cloneConfig();
    const plan = planSearch(p, h, cfg, "balance");
    expect(plan.mode).toBe("stagnant");
    expect(plan.counts).toEqual({
      preserved: 0,
      small: 7,
      medium: 4,
      large: 4,
      immigrant: 4,
    });
    h[4].maxSupportTime = 0.8;
    expect(planSearch(p, h, cfg, "balance").mode).toBe("recovery");
    expect(planSearch(p, history(), cfg, "balance", true).mode).toBe("normal");
    expect(planSearch(p, history(), cfg, "stepping").mode).toBe("recovery");
  });
  it("발 단계의 새 발 사용과 전진 단계의 실제 거리 개선은 정체가 아니다", () => {
    const p = population();
    p.forEach((r) => (r.outcome = "timeout"));
    const steps = history("stepping"),
      forward = history("forward");
    steps[4].maxFootCount = 1;
    forward[4].bestDistanceM = 0.03;
    expect(planSearch(p, steps, cloneConfig(), "stepping").mode).toBe("normal");
    expect(planSearch(p, forward, cloneConfig(), "forward").mode).toBe(
      "normal",
    );
    forward[4].bestDistanceM = 0;
    forward[4].maxWalkingTime = 0.3;
    expect(planSearch(p, forward, cloneConfig(), "forward").mode).toBe(
      "normal",
    );
  });
  it("개체 수 2~60에서도 구성 합계가 맞고 유전자 폭·율은 상한을 지킨다", () => {
    const p = population();
    for (let population = 2; population <= 60; population++) {
      const plan = planSearch(
        p,
        history(),
        { ...cloneConfig(), population, mutation: 0.8, mutationScale: 0.2 },
        "balance",
      );
      expect(Object.values(plan.counts).reduce((a, b) => a + b, 0) + 1).toBe(
        population,
      );
      expect(
        Object.values(plan.counts).every((n) => Number.isInteger(n) && n >= 0),
      ).toBe(true);
      expect(plan.profiles.large.scale).toBe(0.5);
      expect(plan.profiles.large.rate).toBe(1);
      if (population >= 4)
        expect(plan.counts.immigrant).toBeGreaterThanOrEqual(1);
    }
  });
  it("실제 큰 변이는 기본 폭보다 크며 엘리트·선택 부모·원본을 보존한다", () => {
    const p = population(),
      original = structuredClone(p),
      cfg = cloneConfig();
    const plan = planSearch(p, history(), cfg, "balance");
    const children = breed(p, [2, 4], cfg, new Random(31), 5, plan);
    expect(children[0].genes).toEqual(rank(p)[0].genes);
    expect(children.filter((c) => c.immigrant)).toHaveLength(4);
    const large = children.filter(
      (c) => c.birth?.mutationProfile?.kind === "large",
    );
    expect(large).toHaveLength(4);
    for (const c of children.slice(1).filter((c) => !c.immigrant)) {
      expect([2, 4]).toContain(c.parents[0]);
      const profile = c.birth!.mutationProfile!;
      c.genes.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(RANGES[i][0]);
        expect(v).toBeLessThanOrEqual(RANGES[i][1]);
        expect(Math.abs(v - c.birth!.parentGenes[i])).toBeLessThanOrEqual(
          (RANGES[i][1] - RANGES[i][0]) * profile.scale + 1e-12,
        );
      });
    }
    expect(large.every((c) => c.birth!.changedGenes.length > 50)).toBe(true);
    expect(
      large.some((c) =>
        c.genes.some(
          (v, i) =>
            Math.abs(v - c.birth!.parentGenes[i]) >
            (RANGES[i][1] - RANGES[i][0]) * cfg.mutationScale,
        ),
      ),
    ).toBe(true);
    expect(p).toEqual(original);
  });
  it("자동 확대 끄기와 0% 변이 설정을 존중한다", () => {
    const p = population();
    for (const cfg of [
      { ...cloneConfig(), adaptiveSearch: false },
      { ...cloneConfig(), mutation: 0 },
    ]) {
      const plan = planSearch(p, history(), cfg, "balance");
      expect(plan.mode).toBe("normal");
      expect(plan.counts).toEqual({
        preserved: 0,
        small: 19,
        medium: 0,
        large: 0,
        immigrant: 0,
      });
      if (cfg.mutation === 0) {
        const children = breed(p, [2], cfg, new Random(5), 5, plan);
        expect(
          children
            .slice(1)
            .every(
              (c) => JSON.stringify(c.genes) === JSON.stringify(p[1].genes),
            ),
        ).toBe(true);
      }
    }
  });
  it("완료 저장 복원 후에도 같은 확대 구성·유전자·난수 상태를 만든다", () => {
    const e = new Experiment({ ...cloneConfig(), population: 20, duration: 1 });
    finish(e);
    const config = structuredClone(e.config);
    const plan = e.snapshot().searchPlan!;
    expect(plan.mode).toBe("recovery");
    const restored = Experiment.restore(
      parseCheckpoint(JSON.stringify(e.checkpoint())),
    );
    e.evolve(e.autoParents());
    restored.evolve(restored.autoParents());
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(restored.rng.state).toBe(e.rng.state);
    expect(e.config).toEqual(config);
    expect(e.robots.filter((r) => r.individual.immigrant)).toHaveLength(
      plan.counts.immigrant,
    );
    e.dispose();
    restored.dispose();
  });
});

it("중간 변이는 같은 종류의 네 관절에 같은 무작위 증분을 주고 비대칭 차이는 보존한다", () => {
  const p = population(),
    cfg = cloneConfig(),
    plan = planSearch(p, history(), cfg, "balance");
  const children = breed(p, [2], cfg, new Random(111), 5, plan).filter(
    (c) => c.birth?.mutationProfile?.kind === "medium",
  );
  expect(children).toHaveLength(4);
  for (const c of children) {
    expect(c.birth!.mutationScope).toBe("joint-group");
    const changed = c.birth!.changedGenes.filter(
      (i) => i >= OUTPUT_OFFSET && i < OUTPUT_OFFSET + 12 * OUTPUT_STRIDE,
    );
    expect(changed.length % 4).toBe(0);
    const types = new Set(
      changed.map((i) => Math.floor((i - OUTPUT_OFFSET) / OUTPUT_STRIDE) % 3),
    );
    expect(types.size).toBeLessThanOrEqual(1);
    for (const i of changed.filter(
      (i) => Math.floor((i - OUTPUT_OFFSET) / OUTPUT_STRIDE) < 3,
    )) {
      const delta = c.genes[i] - c.birth!.parentGenes[i];
      for (let leg = 1; leg < 4; leg++)
        expect(
          c.genes[i + leg * 3 * OUTPUT_STRIDE] -
            c.birth!.parentGenes[i + leg * 3 * OUTPUT_STRIDE],
        ).toBeCloseTo(delta, 12);
    }
  }
});

it("보행 단계의 국소·중간 변이는 한 다리의 관절을 함께 탐색한다", () => {
  const p = population(),
    cfg = { ...cloneConfig(), rewardModel: "supported-curriculum-v5" as const },
    plan = planSearch(p, history("stepping"), cfg, "stepping");
  const children = breed(p, [2], cfg, new Random(98), 10, plan);
  const local = children.filter((c) => c.birth?.mutationScope === "leg");
  expect(local.length).toBeGreaterThan(0);
  for (const c of local) {
    const changes = c.birth!.changedGenes.filter((i) => i !== FREQUENCY_INDEX);
    expect(
      changes.every((i) => i >= OUTPUT_OFFSET && i < FREQUENCY_INDEX),
    ).toBe(true);
    expect(
      new Set(
        changes.map((i) =>
          Math.floor((i - OUTPUT_OFFSET) / (3 * OUTPUT_STRIDE)),
        ),
      ).size,
    ).toBeLessThanOrEqual(1);
  }
  const medium = local.filter(
    (c) => c.birth!.mutationProfile?.kind === "medium",
  );
  expect(
    medium.some(
      (c) =>
        new Set(
          c
            .birth!.changedGenes.filter((i) => i !== FREQUENCY_INDEX)
            .map((i) => Math.floor((i - OUTPUT_OFFSET) / OUTPUT_STRIDE) % 3),
        ).size >= 2,
    ),
  ).toBe(true);
});

it("보행 정체에서는 대응 관절·센서 연결·미세 변이를 함께 탐색한다", () => {
  const p = population(),
    cfg = {
      ...cloneConfig(),
      rewardModel: "supported-curriculum-v5" as const,
      population: 60,
    };
  const plan = planSearch(p, history("stepping"), cfg, "stepping");
  const children = breed(p, [2], cfg, new Random(47), 30, plan);
  const scopes = new Set(children.map((c) => c.birth?.mutationScope));
  expect(scopes.has("leg")).toBe(true);
  expect(scopes.has("joint-group")).toBe(true);
  expect(scopes.has("sensor-column")).toBe(true);
  expect(scopes.has("network")).toBe(true);
  const small = children.filter(
    (c) => c.birth?.mutationProfile?.kind === "small",
  );
  expect(small.some((c) => c.birth!.mutationProfile!.scale === 0.003)).toBe(
    true,
  );
  expect(small.some((c) => c.birth!.mutationProfile!.scale === 0.03)).toBe(
    true,
  );
  for (const c of children.filter(
    (c) => c.birth?.mutationScope === "sensor-column",
  )) {
    expect(
      c.birth!.changedGenes.every(
        (i) => i < OUTPUT_OFFSET && i % HIDDEN_STRIDE < INPUT_SIZE,
      ),
    ).toBe(true);
    expect(
      new Set(c.birth!.changedGenes.map((i) => i % HIDDEN_STRIDE)).size,
    ).toBe(1);
  }
});
it("자동 확대 중에도 변이율100%는 선택 자식의 전체 유전자를 변형한다", () => {
  const p = population(),
    cfg = { ...cloneConfig(), mutation: 1 },
    plan = planSearch(p, history("stepping"), cfg, "stepping");
  const children = breed(p, [2], cfg, new Random(4), 20, plan);
  for (const c of children.filter((c) => !c.champion && !c.immigrant)) {
    expect(c.birth!.changedGenes).toHaveLength(c.genes.length);
    expect(c.birth!.mutationScope).toBe("network");
  }
});

it("보행 단계의 큰 변이는 일부 자식에서 한 출력 좌표 또는 대응 네 좌표만 크게 바꾼다", () => {
  const p = population(),
    cfg = { ...cloneConfig(), population: 60 };
  const plan = planSearch(p, history("stepping"), cfg, "stepping");
  const children = breed(p, [2], cfg, new Random(47), 30, plan);
  const sparse = children.filter((c) =>
    ["output-coordinate", "group-coordinate"].includes(
      c.birth?.mutationScope ?? "",
    ),
  );
  expect(
    sparse.some((c) => c.birth!.mutationScope === "output-coordinate"),
  ).toBe(true);
  expect(
    sparse.some((c) => c.birth!.mutationScope === "group-coordinate"),
  ).toBe(true);
  expect(
    children.some(
      (c) =>
        c.birth?.mutationProfile?.kind === "large" &&
        c.birth?.mutationScope === "network",
    ),
  ).toBe(true);
  for (const c of sparse) {
    const indices = c.birth!.changedGenes;
    expect(c.birth!.mutationProfile!.kind).toBe("large");
    expect(indices).toHaveLength(
      c.birth!.mutationScope === "group-coordinate" ? 4 : 1,
    );
    expect(
      indices.every((i) => i >= OUTPUT_OFFSET && i < FREQUENCY_INDEX),
    ).toBe(true);
    expect(
      new Set(indices.map((i) => (i - OUTPUT_OFFSET) % (3 * OUTPUT_STRIDE)))
        .size,
    ).toBe(1);
    for (const i of indices) {
      expect(
        Math.abs(c.genes[i] - c.birth!.parentGenes[i]),
      ).toBeLessThanOrEqual(4 * 0.24 + 1e-12);
    }
  }
});

it("선택된 새 발 부모 하나를 정확히 보존하고 나머지 탐색 수를 유지하며 수동 제외를 존중한다", () => {
  const base = population()[0],
    p = Array.from({ length: 9 }, (_, i) => ({
      ...structuredClone(base),
      id: i + 1,
    })),
    cfg = { ...cloneConfig(), rewardModel: "supported-curriculum-v5" as const };
  for (const [i, r] of p.entries()) {
    r.fitness = i < 6 ? 0.416 - i * 0.001 : 0.29 - i * 0.001;
    r.outcome = "fallen";
    r.frame.gait.supportTime = 0.675;
    r.frame.gait.steps =
      i < 6 ? [0, 1, 0, 3] : i === 6 ? [0, 1, 1, 1] : [0, 0, 1, 0];
  }
  const choices = suggestParents(p, 5, "stepping"),
    ids = choices.map((c) => c.id),
    plan = planSearch(p, history("stepping"), cfg, "stepping");
  expect(plan.preservedParentId).toBe(p[6].id);
  expect(plan.counts.preserved).toBe(1);
  expect(Object.values(plan.counts).reduce((a, b) => a + b, 0)).toBe(
    cfg.population - 1,
  );
  const children = breed(p, ids, cfg, new Random(47), 30, plan);
  const kept = children.filter((c) => c.birth?.kind === "explorer");
  expect(kept).toHaveLength(1);
  expect(kept[0].genes).toEqual(p[6].genes);
  expect(kept[0].genes).not.toBe(p[6].genes);
  expect(kept[0].birth!.changedGenes).toEqual([]);
  expect(kept[0].champion).toBe(false);
  for (const kind of ["small", "medium", "large"] as const)
    expect(
      children.filter((c) => c.birth?.mutationProfile?.kind === kind),
    ).toHaveLength(plan.counts[kind]);
  // The explorer remains protected after improving into the top three, until
  // its newly used feet are also represented by the official champion.
  p[6].fitness = 0.4155;
  expect(
    suggestParents(p, 5, "stepping").find((c) => c.id === p[6].id)?.reason,
  ).toBe("fitness");
  expect(
    planSearch(p, history("stepping"), cfg, "stepping").preservedParentId,
  ).toBe(p[6].id);
  const manual = breed(p, [p[0].id], cfg, new Random(47), 30, plan);
  expect(manual).toHaveLength(cfg.population);
  expect(manual.some((c) => c.birth?.kind === "explorer")).toBe(false);
  expect(
    manual.filter((c) => c.birth?.mutationProfile?.kind === "small"),
  ).toHaveLength(plan.counts.small + 1);
  expect(
    manual
      .filter((c) => !c.champion && !c.immigrant)
      .every((c) => c.parents[0] === p[0].id),
  ).toBe(true);
});

it("국소 큰 변이는 아직 걸음을 못 만든 다리를 더 자주 탐색하되 다른 다리도 남긴다", () => {
  const p = population(),
    cfg = { ...cloneConfig(), population: 60 };
  p.forEach((r) => {
    r.frame.gait.steps = [0, 2, 2, 2];
  });
  const plan = planSearch(p, history("stepping"), cfg, "stepping");
  let missing = 0,
    other = 0;
  for (let seed = 0; seed < 60; seed++) {
    const children = breed(p, [2], cfg, new Random(seed + 104), 30, plan);
    for (const c of children.filter(
      (c) => c.birth?.mutationScope === "output-coordinate",
    )) {
      const leg = Math.floor(
        (c.birth!.changedGenes[0] - OUTPUT_OFFSET) / (3 * OUTPUT_STRIDE),
      );
      if (leg === 0) missing++;
      else other++;
    }
  }
  expect(missing + other).toBeGreaterThan(60);
  expect(missing / (missing + other)).toBeGreaterThan(0.45);
  expect(other / (missing + other)).toBeGreaterThan(0.1);
});

it("초기 편향은 새 탐색 개체에만 적용하고 부모 변이·엘리트에는 재주입하지 않는다", () => {
  const p = population(),
    config = cloneConfig(),
    raw = structuredClone(config);
  config.initialization = "weak-balance";
  raw.initialization = "random";
  raw.initialBalanceBias = 0;
  const a = new Random(41),
    b = new Random(41);
  const weakChildren = breed(p, [1, 2], config, a, 10, true);
  const rawChildren = breed(p, [1, 2], raw, b, 10, true);
  expect(a.state).toBe(b.state);
  let immigrants = 0;
  weakChildren.forEach((child, i) => {
    if (!child.immigrant) expect(child).toEqual(rawChildren[i]);
    else {
      immigrants++;
      const differences = child.genes.flatMap((v, j) =>
        v !== rawChildren[i].genes[j] ? [j] : [],
      );
      expect(differences).toEqual(
        Array.from(
          { length: 12 },
          (_, j) => OUTPUT_OFFSET + j * OUTPUT_STRIDE + 8,
        ),
      );
    }
  });
  expect(immigrants).toBe(2);
});

it("안정 지지를 지키며 새로운 발 재착지를 개선한 후보 한 개를 보존하고 위험한 후보는 제외한다", () => {
  const p = population();
  p.forEach((r, i) => {
    r.outcome = "timeout";
    r.elapsed = 15;
    r.fitness = 0.2 - i * 0.01;
    r.frame.distance = 0;
    r.frame.gait.steps = [0, 0, 0, 0];
    r.frame.gait.supportTime = 15;
    r.frame.gait.footProgress = [0, 0, 0, 0];
  });
  p[3].frame.gait.footProgress = [0.4, 0, 0, 0];
  const cfg = { ...cloneConfig(), population: 20, parentCount: 3 };
  const choices = suggestParents(p, 3, "stepping", true, true);
  expect(choices.find((c) => c.id === p[3].id)?.reason).toBe("foot-progress");
  const plan = planSearch(p, [], cfg, "stepping");
  expect(plan.preservedParentId).toBe(p[3].id);
  const children = breed(
    p,
    choices.map((c) => c.id),
    cfg,
    new Random(42),
    5,
    plan,
  );
  expect(children.find((c) => c.birth?.kind === "explorer")?.genes).toEqual(
    p[3].genes,
  );
  p[3].outcome = "fallen";
  p[3].fitness = -0.23;
  p[3].frame.gait.supportTime = 10;
  expect(
    suggestParents(p, 3, "stepping", true, true).some(
      (c) => c.id === p[3].id && c.reason === "foot-progress",
    ),
  ).toBe(true);
  p[3].frame.gait.supportTime = 1;
  expect(
    suggestParents(p, 3, "stepping", true, true).some(
      (c) => c.reason === "foot-progress",
    ),
  ).toBe(false);
});
it("새 보행 탐색은 은닉망이 다른 부모를 교차하지 않고 출력 변이와 미세 탐색을 유지한다", () => {
  const p = population();
  p.forEach((r, i) => {
    r.outcome = "timeout";
    r.fitness = 0.2 - i * 0.01;
    r.frame.gait.supportTime = 15;
  });
  const cfg = { ...cloneConfig(), population: 20, crossover: 1 };
  const plan = planSearch(p, [], cfg, "stepping"),
    original = structuredClone(p);
  const children = breed(
    p,
    p.map((r) => r.id),
    cfg,
    new Random(123),
    10,
    plan,
  );
  expect(children[0].genes).toEqual(rank(p)[0].genes);
  expect(children.every((c) => c.parents.length <= 1)).toBe(true);
  const outputs = children.filter(
    (c) => c.birth?.mutationScope === "output-network",
  );
  expect(outputs.length).toBeGreaterThan(0);
  expect(
    outputs.every((c) =>
      c.birth!.changedGenes.every((i) => i >= OUTPUT_OFFSET),
    ),
  ).toBe(true);
  expect(
    children
      .filter((c) => c.birth?.kind === "mutation")
      .every((c) => c.birth!.mutationProfile!.scale <= 0.001),
  ).toBe(true);
  expect(p).toEqual(original);
});

it("첫 실제 걸음을 발견한 탐색 개체는 큰 넘어짐 감점을 유지하면서 한 계보만 보존한다", () => {
  const p = population();
  p.forEach((r, i) => {
    r.outcome = "timeout";
    r.fitness = 0.211 - i * 0.001;
    r.frame.distance = 0;
    r.frame.gait.steps = [0, 0, 0, 0];
    r.frame.gait.supportTime = 15;
    r.frame.gait.footProgress = [0, 0, 0, 0];
  });
  p[3].outcome = "fallen";
  p[3].fitness = -0.303444;
  p[3].frame.gait.supportTime = 2.916;
  p[3].frame.gait.steps = [0, 0, 0, 2];
  const cfg = { ...cloneConfig(), population: 20, parentCount: 3 },
    before = structuredClone(p);
  expect(
    suggestParents(p, 3, "stepping", true, false).some((c) => c.id === p[3].id),
  ).toBe(false);
  const choices = suggestParents(p, 3, "stepping", true, true);
  expect(choices.find((c) => c.id === p[3].id)?.reason).toBe("new-foot");
  const plan = planSearch(p, [], cfg, "stepping");
  expect(plan.preservedParentId).toBe(p[3].id);
  const children = breed(
    p,
    choices.map((c) => c.id),
    cfg,
    new Random(13),
    49,
    plan,
  );
  expect(children.filter((c) => c.birth?.kind === "explorer")).toHaveLength(1);
  expect(children[0].genes).toEqual(rank(p)[0].genes);
  expect(children[1].genes).toEqual(p[3].genes);
  expect(p).toEqual(before);
  p[3].frame.gait.supportTime = 1.99;
  expect(
    suggestParents(p, 3, "stepping", true, true).some(
      (c) => c.reason === "new-foot",
    ),
  ).toBe(false);
});
