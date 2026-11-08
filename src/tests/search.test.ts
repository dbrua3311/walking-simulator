import { it, expect } from "vitest";
import { CovarianceSearch, norm } from "../genetics/covariance";
import {
  Random,
  randomGenes,
  rank,
  planSearch,
  breed,
  suggestParents,
} from "../genetics/evolution";
import {
  useCovariance,
  encodeBalance,
  decodeBalance,
  breedBalance,
  covarianceParents,
} from "../genetics/balanceSearch";
import { cloneConfig as currentConfig } from "../simulation/config";
// These regressions exercise the legacy 589-gene operators, independent of
// the current UI default. Shared-controller search has its own test file.
const cloneConfig = () => ({
  ...currentConfig(),
  controllerModel: "local-periodic-rnn" as const,
  parentCount: 5,
});
import { Experiment } from "../simulation/experiment";
import { parseCheckpoint, validateCheckpoint } from "../persistence/files";
import { NeuralController } from "../controllers/neural";
import {
  assemblyAngle,
  PROPRIO_OFFSET,
  GENE_COUNT,
  PROPRIO_GENE_COUNT,
  SENSOR_SIZE,
} from "../controllers/genome";
function finish(e: Experiment) {
  if (e.phase === "ready") e.start(false);
  while (e.phase === "running" || e.phase === "validating") e.step();
}
it("새 감각 연결도 양·음 부호를 난수로 생성하고 기존 541개 배열은 그대로 지원한다", () => {
  const cfg = {
      ...cloneConfig(),
      controllerModel: "local-feedback-rnn" as const,
    },
    a = randomGenes(new Random(2028), cfg),
    legacy = randomGenes(new Random(2028));
  expect(a).toHaveLength(PROPRIO_GENE_COUNT);
  expect(legacy).toHaveLength(GENE_COUNT);
  expect(a.slice(0, GENE_COUNT)).toEqual(legacy);
  expect(a.slice(PROPRIO_OFFSET).some((v) => v > 0)).toBe(true);
  expect(a.slice(PROPRIO_OFFSET).some((v) => v < 0)).toBe(true);
  const g = a.map((v, i) => (i < 432 && i % 54 === 53 ? v : 0));
  g[PROPRIO_OFFSET] = 0.7;
  g[PROPRIO_OFFSET + 1] = -0.2;
  const input = Array(SENSOR_SIZE).fill(0);
  input[0] = 0.3;
  input[12] = 0.5;
  expect(new NeuralController(g).step(input, 1 / 120)[0]).toBeCloseTo(
    Math.tanh(0.7 * 0.3 - 0.2 * 0.5),
    14,
  );
});
it("초기 토크와 감각 기울기를 분리한 좌표는 임의 신경망을 손실 없이 왕복한다", () => {
  const g = randomGenes(new Random(91), cloneConfig());
  expect(decodeBalance(g, encodeBalance(g))).toEqual(
    g.map((v, i) => expect.closeTo(v, 13)),
  );
  const x = encodeBalance(g),
    changed = [...x];
  changed[12 + 2] = -0.2;
  const next = decodeBalance(g, changed);
  const j = 1,
    bias = 432 + j * 9 + 8;
  expect(
    next[bias] + next[PROPRIO_OFFSET + j * 2] * assemblyAngle(j),
  ).toBeCloseTo(g[bias] + g[PROPRIO_OFFSET + j * 2] * assemblyAngle(j), 13);
});
it("약한 초기 편향의 조건화는 학습된 자세를 넣지 않고 첫 토크 분포만 보존한다", () => {
  const common = {
    ...cloneConfig(),
    controllerModel: "local-feedback-rnn" as const,
    initialization: "weak-balance" as const,
    initialBalanceBias: 1,
  };
  const a = randomGenes(new Random(9), common),
    b = randomGenes(new Random(9), { ...common, controllerModel: "timed-rnn" });
  const input = Array(SENSOR_SIZE).fill(0);
  for (let j = 0; j < 12; j++) input[j] = assemblyAngle(j);
  const out = new NeuralController(a).step(input, 1 / 120),
    old = new NeuralController(b).step(input, 1 / 120);
  out.forEach((v, i) => expect(v).toBeCloseTo(old[i], 13));
});
it("공분산 탐색은 실제 가중 재조합으로 목적함수를 개선하며 RNG·분포 복원 후 같은 표본을 낸다", () => {
  const rng = new Random(7),
    o = new CovarianceSearch([1, -1, 0.8, -0.4], 0.3, 3);
  const start = norm(o.mean);
  for (let t = 0; t < 70; t++) {
    const samples = Array.from({ length: 12 }, () => o.sample(rng));
    samples.sort((a, b) => norm(a) - norm(b));
    o.update(samples.slice(0, 3));
  }
  expect(norm(o.mean)).toBeLessThan(start / 100);
  const copy = CovarianceSearch.restore(o.state()),
    copyRng = new Random(rng.state);
  expect(copy.sample(copyRng)).toEqual(o.sample(rng));
  const forged = o.state();
  forged.Q[0][0] += 0.1;
  expect(() => CovarianceSearch.restore(forged)).toThrow();
});
it("자동 균형 탐색의 세대·부모·실제 집단 평가와 분포를 JSON으로 복원해 정확히 이어간다", () => {
  const cfg = { ...cloneConfig(), population: 6, parentCount: 3, duration: 1 },
    e = new Experiment(cfg);
  finish(e);
  const elite = [...rank(e.robots.map((r) => r.view()))[0].genes];
  e.evolve(e.autoParents(), undefined, true);
  finish(e);
  const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
  expect(saved.balanceSearch?.draws).toHaveLength(
    5 - saved.population.filter((p) => p.birth?.kind === "stage-anchor").length,
  );
  expect(saved.population[0].genes).toEqual(elite);
  const restored = Experiment.restore(saved);
  e.evolve(e.autoParents(), undefined, true);
  restored.evolve(restored.autoParents(), undefined, true);
  expect(restored.robots.map((r) => r.individual)).toEqual(
    e.robots.map((r) => r.individual),
  );
  expect(restored.rng.state).toBe(e.rng.state);
  finish(e);
  finish(restored);
  const checkpoint = e.checkpoint();
  expect(parseCheckpoint(JSON.stringify(checkpoint)).population).toEqual(
    checkpoint.population,
  );
  const recombined = checkpoint.population.find(
    (p) => p.birth?.kind === "recombination",
  )!;
  expect(recombined.parents).toHaveLength(3);
  recombined.birth!.parentGenes.forEach((v, i) =>
    expect(v).toBeCloseTo(
      recombined.birth!.recombination!.reduce(
        (s, p) => s + p.weight * p.genes[i],
        0,
      ),
      12,
    ),
  );
  const bad = structuredClone(checkpoint);
  bad.balanceSearch!.draws[0][1][0] += 0.1;
  expect(() => validateCheckpoint(bad)).toThrow("표본");
  expect(restored.checkpoint()).toEqual(checkpoint);
  e.dispose();
  restored.dispose();
}, 15000);
it("수동 부모·0%·100%·교차 설정·확대 끄기는 공분산으로 우회하지 않는다", () => {
  const cfg = { ...cloneConfig(), population: 3, parentCount: 2, duration: 1 };
  for (const extra of [
    { mutation: 0 },
    { mutation: 1 },
    { adaptiveSearch: false },
    { crossover: 0.1 },
    { controllerModel: "timed-rnn" as const },
  ])
    expect(useCovariance({ ...cfg, ...extra }, "balance")).toBe(false);
  expect(useCovariance(cfg, "stepping")).toBe(false);
  const e = new Experiment(cfg);
  finish(e);
  const selected = [e.robots[2].individual.id];
  e.evolve(selected);
  expect(e.balanceSearch).toBeNull();
  expect(
    e.robots
      .slice(1)
      .every((r) => r.individual.parents.every((id) => selected.includes(id))),
  ).toBe(true);
  e.dispose();
});

it("설정한 분포 변이 폭 변경이 다음 자식에 반영되고 점프 부모로 수를 채우지 않는다", () => {
  const config = {
      ...cloneConfig(),
      population: 6,
      parentCount: 3,
      duration: 1,
    },
    e = new Experiment(config);
  finish(e);
  e.evolve(e.autoParents(), undefined, true);
  finish(e);
  const robots = e.robots.map((r) => r.view()),
    state = e.balanceSearch!,
    a = breedBalance(robots, config, new Random(8), 2, state),
    b = breedBalance(
      robots,
      { ...config, mutationScale: config.mutationScale * 2 },
      new Random(8),
      2,
      state,
    );
  expect(b.state.optimizer.sigma).toBeCloseTo(2 * a.state.optimizer.sigma, 12);
  expect(b.population[0]).toEqual(a.population[0]);
  expect(b.population.slice(1).map((p) => p.genes)).not.toEqual(
    a.population.slice(1).map((p) => p.genes),
  );
  robots.slice(1).forEach((r) => (r.outcome = "jumped"));
  robots[0].outcome = "timeout";
  expect(covarianceParents(robots, config, state)).toEqual([robots[0].id]);
  expect(() =>
    breedBalance(robots, { ...config, parentCount: 1 }, new Random(2), 2, {
      ...state,
      optimizer: { ...state.optimizer, mu: 1 },
    }),
  ).not.toThrow();
  e.dispose();
});

it("승급 때 실제 균형 통과 계보와 점수 우승을 함께 보존하고 첫 발 단계는 작은 변이로 시작한다", () => {
  const cfg = { ...cloneConfig(), population: 4, parentCount: 2, duration: 1 },
    e = new Experiment(cfg);
  finish(e);
  const views = e.robots.map((r) => r.view());
  views.forEach((r, i) => {
    r.fitness = 0.8 - i * 0.1;
    r.outcome = "timeout";
    r.elapsed = 1;
    Object.assign(r.frame.gait, {
      supportTime: 1,
      longestSupport: 1,
      longestMobileSupport: i === 2 ? 1 : 0,
      mobileSupportTime: i === 2 ? 1 : 0,
      jointFreedom: i === 2 ? 1 : 0.5,
      jumping: false,
      steps: [0, 0, 0, 0],
    });
    e.robots[i].view = () => r;
  });
  e.curriculum.pendingStage = "stepping";
  expect(e.autoParents()).toContain(3);
  const plan = e.nextSearchPlan();
  expect(plan.stage).toBe("stepping");
  expect(plan.anchorParentId).toBe(3);
  expect(plan.profiles.small.scale).toBeCloseTo(0.001, 12);
  e.evolve(e.autoParents(), undefined, true);
  expect(e.robots).toHaveLength(4);
  expect(e.robots[0].individual.genes).toEqual(views[0].genes);
  const anchor = e.robots.find(
    (r) => r.individual.birth?.kind === "stage-anchor",
  )!;
  expect(anchor.individual.genes).toEqual(views[2].genes);
  expect(anchor.individual.birth?.changedGenes).toEqual([]);
  expect(e.curriculum.stage).toBe("stepping");
  e.dispose();
});

it("균형 보존용 계보도 수동 선택에서 제외하면 강제로 다음 세대에 넣지 않는다", () => {
  const cfg = { ...cloneConfig(), population: 4, parentCount: 2, duration: 1 },
    e = new Experiment(cfg);
  finish(e);
  const views = e.robots.map((r) => r.view());
  views.forEach((r, i) => {
    r.fitness = 0.8 - i * 0.1;
    r.outcome = "timeout";
    r.elapsed = 1;
    Object.assign(r.frame.gait, {
      supportTime: 1,
      longestSupport: 1,
      longestMobileSupport: i === 2 ? 1 : 0,
      mobileSupportTime: i === 2 ? 1 : 0,
      jointFreedom: i === 2 ? 1 : 0.5,
      jumping: false,
      steps: [0, 0, 0, 0],
    });
    e.robots[i].view = () => r;
  });
  e.curriculum.pendingStage = "stepping";
  e.evolve([1]);
  expect(e.robots).toHaveLength(4);
  expect(
    e.robots.every((r) => r.individual.parents.every((id) => id === 1)),
  ).toBe(true);
  expect(
    e.robots.some((r) => r.individual.birth?.kind === "stage-anchor"),
  ).toBe(false);
  e.dispose();
});

it("589개 주기 연결은 임의 관절의 진폭·위상을 유전자로 정하고 미리 정한 다리 동작을 만들지 않는다", () => {
  const config = cloneConfig(),
    g = randomGenes(new Random(18), config);
  expect(g).toHaveLength(589);
  expect(g.slice(565).every((v) => v !== 0 && Math.abs(v) <= 0.01)).toBe(true);
  const zero = g.map((v, i) => (i < 432 && i % 54 === 53 ? v : 0));
  zero[540] = 1;
  zero[565] = 0.6;
  zero[566] = -0.3;
  const c = new NeuralController(zero),
    input = Array(SENSOR_SIZE).fill(0);
  let output = c.step(input, 1 / 120);
  expect(output[0]).toBeCloseTo(Math.tanh(-0.3), 13);
  expect(output.slice(1)).toEqual(Array(11).fill(0));
  for (let i = 1; i < 30; i++) c.step(input, 1 / 120);
  output = c.step(input, 1 / 120);
  expect(output[0]).toBeCloseTo(Math.tanh(0.6), 12);
});

it("새 보행 탐색은 작은 조정과 큰 주기 토크 변이를 매 세대 함께 탐색한다", () => {
  const cfg = { ...cloneConfig(), population: 20, duration: 1 },
    e = new Experiment(cfg),
    views = e.robots.map((r) => r.view());
  const plan = e.nextSearchPlan(); // Balance plan is distinct; walking uses the explicit stage below.
  expect(plan.stage).toBe("balance");
  const walking = planSearch(views, [], cfg, "stepping");
  expect(walking.counts.large).toBeGreaterThan(0);
  expect(walking.counts.medium).toBeGreaterThan(0);
  expect(walking.profiles.large.scale).toBeCloseTo(0.08, 12);
  const children = breed(views, [1, 2, 3], cfg, new Random(22), 1, walking),
    timed = children.filter((p) => p.birth?.mutationScope === "leg-time");
  expect(timed.length).toBeGreaterThan(0);
  for (const p of timed) {
    expect(
      p.birth!.changedGenes.every(
        (i) =>
          (i >= 565 && i < 589) || (i >= 432 && i < 540 && (i - 432) % 9 === 8),
      ),
    ).toBe(true);
    expect(p.birth!.mutationProfile!.scale).toBeCloseTo(0.08, 12);
    const a = new NeuralController(p.birth!.parentGenes),
      b = new NeuralController(p.genes),
      sensors = Array(SENSOR_SIZE).fill(0),
      first = a.step(sensors, 1 / 120),
      second = b.step(sensors, 1 / 120);
    first.forEach((v, j) => expect(v).toBeCloseTo(second[j], 12));
    for (let t = 0; t < 60; t++) {
      a.step(sensors, 1 / 120);
      b.step(sensors, 1 / 120);
    }
    const laterA = a.step(sensors, 1 / 120),
      laterB = b.step(sensors, 1 / 120);
    expect(laterA.some((v, j) => Math.abs(v - laterB[j]) > 0.001)).toBe(true);
  }
  const full = breed(
    views,
    [1],
    { ...cfg, mutation: 1 },
    new Random(2),
    1,
    false,
  );
  expect(full.slice(1).every((p) => p.birth!.changedGenes.length === 589)).toBe(
    true,
  );
  e.dispose();
});

it("새 네 발 동작의 실패 감점을 유지하면서도 제한된 탐색 계보를 잃지 않는다", () => {
  const cfg = { ...cloneConfig(), population: 8, parentCount: 5 },
    e = new Experiment(cfg),
    views = e.robots.map((r) => r.view());
  views.forEach((r, i) => {
    r.fitness = 0.4 - i * 0.005;
    r.outcome = "timeout";
    r.frame.gait.supportTime = 15;
    r.frame.gait.steps = [1, 1, 11, 0];
  });
  const novel = views[7];
  novel.fitness = -0.4;
  novel.outcome = "fallen";
  novel.frame.gait.supportTime = 2.5;
  novel.frame.gait.steps = [1, 1, 1, 1];
  expect(
    suggestParents(views, 5, "stepping", true, true, 0.65).some(
      (p) => p.id === 8,
    ),
  ).toBe(false);
  const selected = suggestParents(views, 5, "stepping", true, true, 0.9);
  expect(selected.some((p) => p.id === 8 && p.reason === "new-foot")).toBe(
    true,
  );
  const plan = planSearch(views, [], cfg, "stepping"),
    children = breed(
      views,
      selected.map((p) => p.id),
      cfg,
      new Random(9),
      8,
      plan,
    );
  expect(children[0].genes).toEqual(views[0].genes);
  expect(
    children.some((p) => p.birth?.kind === "explorer" && p.parents[0] === 8),
  ).toBe(true);
  expect(novel.fitness).toBe(-0.4);
  e.dispose();
});

it("완료된565개 실험을 명시적으로 확장해도 원본·이력·난수와 실제 물리는 바뀌지 않는다", async () => {
  const { upgradeCompletedController } = await import("../persistence/upgrade"),
    { Robot } = await import("../physics/robot"),
    { createHash } = await import("node:crypto");
  const e = new Experiment({
    ...cloneConfig(),
    controllerModel: "local-feedback-rnn",
    population: 2,
    parentCount: 1,
    duration: 1,
  });
  finish(e);
  const first = e.checkpoint();
  expect(() => upgradeCompletedController(first, "a".repeat(64))).toThrow();
  e.evolve(e.autoParents());
  finish(e);
  const source = e.checkpoint(),
    original = JSON.stringify(source),
    hash = createHash("sha256").update(original).digest("hex"),
    upgraded = upgradeCompletedController(source, hash);
  expect(JSON.stringify(source)).toBe(original);
  expect(upgraded.history).toEqual(source.history);
  expect(upgraded.rngState).toBe(source.rngState);
  expect(upgraded.generation).toBe(2);
  expect(upgraded.controllerTransitions![0].effectiveGeneration).toBe(3);
  upgraded.population.forEach((p, i) => {
    expect(p.genes.slice(0, 565)).toEqual(source.population[i].genes);
    expect(p.genes.slice(565)).toEqual(Array(24).fill(0));
  });
  expect(upgraded.completedResults.map((r) => r.frame)).toEqual(
    source.completedResults.map((r) => r.frame),
  );
  const a = new Robot(structuredClone(source.population[0]), source.config),
    b = new Robot(structuredClone(upgraded.population[0]), upgraded.config);
  while (a.outcome === "active" || b.outcome === "active") {
    a.step();
    b.step();
    expect(b.view().frame).toEqual(a.view().frame);
    expect(b.outcome).toBe(a.outcome);
  }
  const restored = Experiment.restore(upgraded);
  expect(restored.checkpoint().controllerTransitions).toEqual(
    upgraded.controllerTransitions,
  );
  expect(() => upgradeCompletedController(upgraded, hash)).toThrow();
  a.dispose();
  b.dispose();
  restored.dispose();
  e.dispose();
}, 15000);

it("관절 감각과 편향의 연동 변이는 실제 출력 변화 폭을 기록해 정상 체크포인트를 거절하지 않는다", () => {
  const e = new Experiment({
    ...cloneConfig(),
    population: 8,
    duration: 1,
    parentCount: 2,
    seed: 2028,
  });
  finish(e);
  e.evolve([1], {
    mutation: 0.8,
    mutationScale: 0.03,
    adaptiveSearch: true,
    population: 8,
    parentCount: 2,
    crossover: 0,
  });
  const expanded = e.robots.some((r) => {
    const p = r.individual,
      b = p.birth;
    if (!b?.mutationProfile) return false;
    return Array.from({ length: 12 }, (_, j) => 432 + j * 9 + 8).some(
      (i) =>
        Math.abs(p.genes[i] - b.parentGenes[i]) >
        4 * b.mutationProfile!.scale + 1e-10,
    );
  });
  expect(expanded).toBe(true);
  finish(e);
  expect(() => parseCheckpoint(JSON.stringify(e.checkpoint()))).not.toThrow();
  e.dispose();
}, 15000);

it("균형 점수 우승이 아직 넘어져도 이미15초 통과한 실제 계보를 분포 변이에서 잃지 않는다", () => {
  const config = {
      ...cloneConfig(),
      population: 6,
      parentCount: 3,
      duration: 1,
    },
    e = new Experiment(config),
    views = e.robots.map((r) => r.view());
  // Selection fixture only; it is not a learned policy or performance result.
  views.forEach((r, i) => {
    r.fitness = 0.4 - i * 0.01;
    r.outcome = "fallen";
    r.elapsed = 1;
    r.frame.gait.jumping = false;
  });
  const stable = views[2];
  stable.outcome = "timeout";
  Object.assign(stable.frame.gait, {
    supportTime: 1,
    longestSupport: 1,
    mobileSupportTime: 1,
    longestMobileSupport: 1,
    jointFreedom: 1,
  });
  const result = breedBalance(views, config, new Random(9), 1, null),
    anchor = result.population.find((p) => p.birth?.kind === "stage-anchor")!;
  expect(result.population).toHaveLength(6);
  expect(result.population[0].genes).toEqual(views[0].genes);
  expect(anchor.genes).toEqual(stable.genes);
  expect(anchor.birth!.changedGenes).toEqual([]);
  expect(result.state.version).toBe("balance-covariance-v2");
  expect(result.state.draws).toHaveLength(4);
  e.dispose();
});
