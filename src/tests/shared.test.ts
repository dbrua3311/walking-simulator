import { it, expect } from "vitest";
import { Robot } from "../physics/robot";
import { NeuralController } from "../controllers/neural";
import {
  sharedTorques,
  DIRECTION_SHARED_GENE_COUNT,
  DIRECTION_SHARED_GENE_NAMES,
  DIRECTION_SHARED_RANGES,
  SHARED_GENE_COUNT,
  SHARED_RANGES,
  SHARED_GENE_NAMES,
  wrapPhase,
} from "../controllers/shared";
import { geneCount, SENSOR_SIZE } from "../controllers/genome";
import { Random, randomGenes, breed, rank } from "../genetics/evolution";
import {
  breedSharedSearch,
  sharedPlan,
  sharedIndices,
  validateSharedState,
  decodeShared,
  encodeShared,
} from "../genetics/sharedSearch";
import { Experiment } from "../simulation/experiment";
import { cloneConfig } from "../simulation/config";
import { parseCheckpoint } from "../persistence/files";
import type { Config, RobotView } from "../simulation/types";
const config = (population = 8): Config => ({
  ...cloneConfig(),
  controllerModel: "shared-reflex",
  parentCount: 3,
  population,
});
function finish(e: Experiment) {
  if (e.phase === "ready") e.start(false);
  while (e.phase === "running" || e.phase === "validating") e.step();
}
// Synthetic planning fixtures test selection/encoding, never learning performance.
function planningViews(): RobotView[] {
  const e = new Experiment(config()),
    rows = e.robots.map((r) => r.view());
  e.dispose();
  return rows.map((r, i) => ({
    ...r,
    outcome: "timeout" as const,
    elapsed: 15,
    fitness: i === 0 ? 0.9 : 0.2,
    frame: {
      ...r.frame,
      tick: 1800,
      gait: {
        ...r.frame.gait,
        steps: [0, 0, 0, 0],
        stepActivity: [0, 0, 0, 0],
        supportTime: 15,
        longestSupport: 15,
        mobileSupportTime: 15,
        longestMobileSupport: 15,
        jointFreedom: 1,
      },
    },
  }));
}
const gaitFixture = (
  r: RobotView,
  steps: number[],
  walkingTime = 0,
): RobotView => ({
  ...r,
  frame: {
    ...r.frame,
    gait: {
      ...r.frame.gait,
      steps,
      walkingTime,
      stepActivity: steps.map((n) => (n >= 2 ? 0.4 : 0)),
      longestWalking: walkingTime,
      walking: walkingTime > 0,
      lateralDeviation: 0.1,
      headingDeviation: 0.1,
    },
  },
});
it("공통 제어기의38유전자는 모두 난수이며 네 다리의 시점도 독립적으로 변한다", () => {
  expect(cloneConfig().controllerModel).toBe("shared-direction");
  expect(cloneConfig().parentCount).toBe(3);
  const c = config(),
    rng = new Random(2026),
    a = randomGenes(rng, c),
    b = randomGenes(rng, c);
  expect(geneCount(c)).toBe(SHARED_GENE_COUNT);
  expect(SHARED_GENE_NAMES).toHaveLength(38);
  expect(a).not.toEqual(b);
  expect(
    a.every((v, i) => v >= SHARED_RANGES[i][0] && v <= SHARED_RANGES[i][1]),
  ).toBe(true);
  expect(new Set(a.slice(27, 31)).size).toBe(4);
  const population = Array.from({ length: 20 }, () => randomGenes(rng, c));
  for (let i = 32; i < 38; i++) {
    expect(population.some((g) => g[i] > 0)).toBe(true);
    expect(population.some((g) => g[i] < 0)).toBe(true);
  }
});
it("공유 가중치에도각모터는자신의센서로반응하고0연결은토크0이다", () => {
  const zero = Array(38).fill(0),
    inputs = Array(SENSOR_SIZE).fill(0);
  expect(new NeuralController(zero).step(inputs, 1 / 120)).toEqual(
    Array(12).fill(0),
  );
  const g = [...zero];
  g[1] = 0.7;
  g[31] = 1;
  const sensed = [...inputs];
  sensed[6] = 0.5;
  const output = new NeuralController(g).step(sensed, 1 / 120);
  expect(output.filter((v) => v !== 0)).toHaveLength(1);
  expect(output[6]).toBeGreaterThan(0);
});
it("한 다리의 자유 위상 변이는 그 다리의 시간 신호만 바꾼다", () => {
  const g = Array(38).fill(0);
  g[7] = 0.4;
  g[31] = 1;
  const a = new NeuralController(g),
    other = [...g];
  other[29] = Math.PI / 2;
  const b = new NeuralController(other),
    input = Array(SENSOR_SIZE).fill(0);
  a.step(input, 0.2);
  b.step(input, 0.2);
  const x = a.step(input, 1 / 120),
    y = b.step(input, 1 / 120);
  expect(
    x
      .map((v, i) => (Math.abs(v - y[i]) > 1e-10 ? i : -1))
      .filter((i) => i >= 0),
  ).toEqual([6]);
});
it("공통 규칙의 0%·100% 변이와 선택한 부모 및 교차를 존중한다", () => {
  const c = config(),
    views = planningViews(),
    parent = views[3];
  const copies = breed(
    views,
    [parent.id],
    { ...c, mutation: 0, crossover: 0 },
    new Random(3),
  );
  expect(
    copies
      .slice(1)
      .every(
        (p) =>
          p.birth?.kind === "copy" &&
          JSON.stringify(p.genes) === JSON.stringify(parent.genes),
      ),
  ).toBe(true);
  const changed = breed(
    views,
    [parent.id],
    { ...c, mutation: 1, crossover: 0 },
    new Random(3),
  );
  expect(
    changed
      .slice(1)
      .every(
        (p) =>
          p.birth?.changedGenes.length === 38 && p.parents[0] === parent.id,
      ),
  ).toBe(true);
  const crossed = breed(
    views,
    [3, 4],
    { ...c, mutation: 0, crossover: 1 },
    new Random(3),
  );
  expect(
    crossed
      .slice(1)
      .every(
        (p) =>
          p.birth?.kind === "crossover" &&
          p.parents.length === 2 &&
          p.parents.every((id) => [3, 4].includes(id)),
      ),
  ).toBe(true);
  for (const p of changed)
    expect(
      p.genes.every(
        (v, i) => v >= SHARED_RANGES[i][0] && v <= SHARED_RANGES[i][1],
      ),
    ).toBe(true);
});
it("균형 좌표는 감각 기여를 보존하고 범위 끝의 표본도 다른 변이를 지우지 않는다", () => {
  const c = config(),
    views = planningViews();
  for (const r of views) {
    r.genes[1] = -2;
    r.genes[10] = -2;
    r.genes[19] = -2;
  }
  const g = views[0].genes;
  expect(decodeShared(g, encodeShared(g, "balance"), "balance")).toEqual(
    g.map((v) => expect.closeTo(v, 13)),
  );
  const result = breedSharedSearch(views, c, new Random(7), 1, "balance", null);
  expect(result.state.optimizer.mean).toHaveLength(9);
  validateSharedState(result.state, result.population, 2, c, "balance");
  const samples = result.population.filter(
    (p) => p.birth?.mutationScope === "shared-covariance",
  );
  expect(samples.every((p) => p.birth!.changedGenes.length > 0)).toBe(true);
  expect(
    samples.every((p) =>
      p.genes.every(
        (v, i) =>
          v >= SHARED_RANGES[i][0] - 1e-12 && v <= SHARED_RANGES[i][1] + 1e-12,
      ),
    ),
  ).toBe(true);
});
it("네 발 발견과 반복 보행에 따라 실제 후보를 보존하며 탐색 좌표를 바꾼다", () => {
  const c = config(),
    source = planningViews();
  expect(sharedPlan(source, c, "stepping", 1, null).mode).toBe("cycles");
  source[1] = gaitFixture(source[1], [3, 3, 3, 1]);
  const reflex = breedSharedSearch(
    source,
    c,
    new Random(10),
    1,
    "stepping",
    null,
  );
  expect(reflex.state.mode).toBe("reflex");
  expect(reflex.state.optimizer.mean).toHaveLength(18);
  expect(
    reflex.population.some(
      (p) =>
        p.parents[0] === source[1].id &&
        p.birth?.kind === "explorer" &&
        p.birth.changedGenes.length === 0,
    ),
  ).toBe(true);
  expect(reflex.population[0].genes).toEqual(rank(source)[0].genes);
  source[1] = gaitFixture(source[1], [3, 3, 3, 3], 9);
  const direction = breedSharedSearch(
    source,
    c,
    new Random(10),
    1,
    "stepping",
    null,
  );
  expect(direction.state.mode).toBe("direction");
  expect(direction.state.optimizer.mean).toHaveLength(20);
  validateSharedState(direction.state, direction.population, 2, c, "stepping");
});
it("주기 경계에서도 실제 부모의 위상 좌표로 재조합하고 변조된 표본을 거절한다", () => {
  const c = config(),
    source = planningViews().map((r) => gaitFixture(r, [3, 3, 3, 3], 9));
  for (const r of source) r.genes[27] = Math.PI - 0.005;
  const first = breedSharedSearch(
    source,
    c,
    new Random(17),
    1,
    "stepping",
    null,
  );
  expect(first.population.some((p) => p.genes[27] < 0)).toBe(true);
  const rows = first.population.map((p, i) =>
    gaitFixture({ ...source[i], ...p }, [3, 3, 3, 3], 9),
  );
  const second = breedSharedSearch(
    rows,
    c,
    new Random(18),
    2,
    "stepping",
    first.state,
  );
  expect(second.population.some((p) => p.birth?.kind === "recombination")).toBe(
    true,
  );
  validateSharedState(second.state, second.population, 3, c, "stepping");
  const bad = structuredClone(second.state);
  bad.draws[0][1][0] += 0.1;
  expect(() =>
    validateSharedState(bad, second.population, 3, c, "stepping"),
  ).toThrow();
  expect(Math.abs(wrapPhase(Math.PI + 0.01) + Math.PI - 0.01)).toBeLessThan(
    1e-12,
  );
  expect(sharedIndices("cycles")).toHaveLength(26);
});
it.each(["shared-reflex", "shared-direction", "shared-anatomical"] as const)(
  "%s 완료 저장을 복원하면 다음 물리 세대와 난수가 정확히 일치한다",
  (controllerModel) => {
    const c = { ...config(4), controllerModel, duration: 1 },
      e = new Experiment(c);
    finish(e);
    e.evolve(e.autoParents(), undefined, true);
    finish(e);
    const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
    expect(saved.sharedSearch?.mode).toBe("balance");
    expect(saved.population.every((p) => p.genes.length === geneCount(c))).toBe(
      true,
    );
    const inputBytes = JSON.stringify(saved);
    const restored = Experiment.restore(saved);
    e.evolve(e.autoParents(), undefined, true);
    restored.evolve(restored.autoParents(), undefined, true);
    expect(restored.rng.state).toBe(e.rng.state);
    expect(restored.robots.map((r) => r.individual)).toEqual(
      e.robots.map((r) => r.individual),
    );
    finish(e);
    finish(restored);
    expect(restored.robots.map((r) => r.view())).toEqual(
      e.robots.map((r) => r.view()),
    );
    expect(restored.history).toEqual(e.history);
    expect(JSON.stringify(saved)).toBe(inputBytes);
    const bad = structuredClone(saved);
    bad.sharedSearch!.optimizer.C[0][1] += 0.5;
    expect(() => parseCheckpoint(JSON.stringify(bad))).toThrow();
    const wrongFrame = structuredClone(saved);
    if (controllerModel !== "shared-reflex") {
      wrongFrame.config.controllerModel =
        controllerModel === "shared-direction"
          ? "shared-anatomical"
          : "shared-direction";
      expect(() => parseCheckpoint(JSON.stringify(wrongFrame))).toThrow();
    }
    const wrong = structuredClone(saved);
    wrong.config.controllerModel = "local-periodic-rnn";
    expect(() => parseCheckpoint(JSON.stringify(wrong))).toThrow();
    const noState = structuredClone(saved);
    noState.sharedSearch = null;
    expect(() => parseCheckpoint(JSON.stringify(noState))).toThrow();
    e.dispose();
    restored.dispose();
  },
  15000,
);
it("수동 선택과 0% 변이는 공통 분포 탐색 상태를 만들지 않는다", () => {
  const e = new Experiment({ ...config(4), duration: 1, mutation: 0 });
  finish(e);
  e.evolve([2]);
  finish(e);
  const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
  expect(saved.sharedSearch).toBeNull();
  expect(saved.evolutionVersion).toBe("shared-mutation-v1");
  expect(
    saved.population
      .slice(1)
      .every((p) => p.parents[0] === 2 && p.birth?.kind === "copy"),
  ).toBe(true);
  e.dispose();
});

it("방향 감각의6연결도 무작위 부호로 시작하고100%변이가44개를 바꾼다", () => {
  const c: Config = { ...config(), controllerModel: "shared-direction" },
    rng = new Random(2026);
  const genomes = Array.from({ length: 20 }, () => randomGenes(rng, c));
  expect(geneCount(c)).toBe(DIRECTION_SHARED_GENE_COUNT);
  expect(DIRECTION_SHARED_GENE_NAMES).toHaveLength(44);
  for (let i = 38; i < 44; i++) {
    expect(genomes.some((g) => g[i] > 0)).toBe(true);
    expect(genomes.some((g) => g[i] < 0)).toBe(true);
  }
  const rows = planningViews().map((r, i) => ({ ...r, genes: genomes[i] }));
  const children = breed(
    rows,
    [rows[2].id],
    { ...c, mutation: 1, crossover: 0 },
    new Random(31),
  );
  expect(
    children.slice(1).every((p) => p.birth?.changedGenes.length === 44),
  ).toBe(true);
  expect(
    children.every((p) =>
      p.genes.every(
        (v, i) =>
          v >= DIRECTION_SHARED_RANGES[i][0] &&
          v <= DIRECTION_SHARED_RANGES[i][1],
      ),
    ),
  ).toBe(true);
});
it("방향과 위치는 실제 몸통 관측값이며0가중치는 보정 토크를 만들지 않는다", () => {
  const c: Config = { ...config(4), controllerModel: "shared-direction" };
  const dna = randomGenes(new Random(1), c),
    robot = new Robot({ id: 1, genes: dna, champion: false, parents: [] }, c);
  try {
    const initial = robot.sensorInputs();
    expect(initial).toHaveLength(44);
    expect(initial.slice(42)).toEqual([0, 0]);
    const p = robot.torso.translation();
    robot.torso.setTranslation({ ...p, z: 0.25 }, true);
    robot.torso.setRotation(
      { x: 0, y: Math.sin(0.15), z: 0, w: Math.cos(0.15) },
      true,
    );
    const observed = robot.sensorInputs();
    expect(observed[42]).toBeCloseTo(-0.3 / Math.PI, 6);
    expect(observed[43]).toBe(0.5);
    const zero = Array(44).fill(0);
    expect(new NeuralController(zero).step(observed, 1 / 120)).toEqual(
      Array(12).fill(0),
    );
    zero[38] = 1;
    const forward = new NeuralController(zero).step(observed, 1 / 120);
    expect(forward[0]).toBeLessThan(0);
    expect(forward[6]).toBeGreaterThan(0);
    zero[38] = -1;
    expect(new NeuralController(zero).step(observed, 1 / 120)).toEqual(
      forward.map((v) => (v === 0 ? 0 : -v)),
    );
    expect(() =>
      new NeuralController(zero).step(observed.slice(0, 42), 1 / 120),
    ).toThrow();
  } finally {
    robot.dispose();
  }
});
it("44개 방향 관측 모형은24차원·26차원 탐색과 실제 부모 재조합을 검증한다", () => {
  const c: Config = { ...config(), controllerModel: "shared-direction" },
    rng = new Random(41);
  const source = planningViews().map((r) => ({
    ...r,
    genes: randomGenes(rng, c),
  }));
  source[1] = gaitFixture(source[1], [3, 3, 3, 1]);
  const reflex = breedSharedSearch(source, c, rng, 1, "stepping", null);
  expect(reflex.state.optimizer.mean).toHaveLength(24);
  validateSharedState(reflex.state, reflex.population, 2, c, "stepping");
  source[1] = gaitFixture(source[1], [3, 3, 3, 3], 9);
  const a = breedSharedSearch(source, c, rng, 1, "stepping", null);
  expect(a.state.optimizer.mean).toHaveLength(26);
  const evaluated = a.population.map((p, i) =>
    gaitFixture({ ...source[i], ...p }, [3, 3, 3, 3], 9),
  );
  const b = breedSharedSearch(evaluated, c, rng, 2, "stepping", a.state);
  expect(b.population.some((p) => p.birth?.kind === "recombination")).toBe(
    true,
  );
  validateSharedState(b.state, b.population, 3, c, "stepping");
  const forged = structuredClone(b.state);
  forged.base.pop();
  expect(() =>
    validateSharedState(forged, b.population, 3, c, "stepping"),
  ).toThrow();
});

it("기존 탐색 좌표를 읽으면서 새 탐색은 모든 다리 시점과 보행 시간 연결을 유지한다", () => {
  expect(sharedIndices("reflex", 44, "shared-covariance-v1")).toHaveLength(12);
  expect(sharedIndices("direction", 44, "shared-covariance-v1")).toHaveLength(
    21,
  );
  for (const mode of ["reflex", "direction"] as const)
    for (const i of [27, 28, 29, 30])
      expect(sharedIndices(mode, 44)).toContain(i);
  for (const i of [7, 8, 16, 17, 25, 26, 31]) {
    expect(sharedIndices("direction", 44)).toContain(i);
    expect(sharedIndices("reflex", 44)).toContain(i);
  }
  expect(sharedIndices("reflex", 44, "shared-covariance-v2")).toHaveLength(19);
  const c = config(),
    rows = planningViews();
  const first = breedSharedSearch(rows, c, new Random(55), 1, "balance", null);
  const old = structuredClone(first.state);
  old.version = "shared-covariance-v1";
  validateSharedState(old, first.population, 2, c, "balance");
  const evaluated = first.population.map((p, i) => ({ ...rows[i], ...p }));
  const next = breedSharedSearch(
    evaluated,
    c,
    new Random(56),
    2,
    "balance",
    old,
  );
  expect(next.state.version).toBe("shared-covariance-v3");
  validateSharedState(next.state, next.population, 3, c, "balance");
});

it("보행 분포의변이폭을 줄이면 재조합·실패후재시도 모두 공분산 폭도 줄인다", () => {
  const c = config(),
    rng = new Random(77),
    source = planningViews().map((r) => gaitFixture(r, [3, 3, 3, 3], 9));
  const first = breedSharedSearch(source, c, rng, 1, "stepping", null);
  const evaluated = first.population.map((p, i) =>
    gaitFixture({ ...source[i], ...p }, [3, 3, 3, 3], 9),
  );
  for (const reusable of [true, false]) {
    const rows = reusable
      ? evaluated
      : evaluated.map((r, i) =>
          gaitFixture(
            r,
            i === 0 ? [3, 3, 3, 3] : [1, 1, 1, 1],
            i === 0 ? 9 : 0,
          ),
        );
    const normal = breedSharedSearch(
      rows,
      c,
      new Random(78),
      2,
      "stepping",
      first.state,
    );
    const fine = breedSharedSearch(
      rows,
      { ...c, mutationScale: 0.003 },
      new Random(78),
      2,
      "stepping",
      first.state,
    );
    expect(fine.state.optimizer.sigma).toBeCloseTo(
      normal.state.optimizer.sigma,
      12,
    );
    fine.state.optimizer.C.forEach((row, i) =>
      row.forEach((v, j) =>
        expect(v).toBeCloseTo(normal.state.optimizer.C[i][j] * 0.01, 12),
      ),
    );
    validateSharedState(
      fine.state,
      fine.population,
      3,
      { ...c, mutationScale: 0.003 },
      "stepping",
    );
  }
});

it("짧은 네 발 동작은 반복을 더 배우고 새 위치 감각 변이는 토크 영향에 맞춰 작게 탐색한다", () => {
  const c: Config = { ...config(), controllerModel: "shared-direction" },
    rng = new Random(88);
  const rows = planningViews().map((r) => ({
    ...r,
    genes: randomGenes(rng, c),
  }));
  rows[1] = gaitFixture(rows[1], [3, 3, 3, 3], 3);
  const first = breedSharedSearch(rows, c, rng, 1, "stepping", null);
  expect(first.state.mode).toBe("reflex");
  expect(
    first.state.optimizer.C[sharedIndices("reflex", 44).indexOf(41)][
      sharedIndices("reflex", 44).indexOf(41)
    ],
  ).toBeCloseTo(0.003 ** 2, 14);
  rows[1] = gaitFixture(rows[1], [3, 3, 3, 3], 9);
  const advanced = breedSharedSearch(rows, c, rng, 1, "stepping", null);
  expect(advanced.state.mode).toBe("direction");
  const weak = advanced.population.map((p, i) =>
    gaitFixture({ ...rows[i], ...p }, [3, 3, 3, 3], 3),
  );
  expect(
    breedSharedSearch(weak, c, rng, 2, "stepping", advanced.state).state.mode,
  ).toBe("reflex");
});

it("다리 좌표를 맞추면 대칭 상태의 어깨 토크는 반대 축, 엉덩이·무릎은 같은 축으로 나온다", () => {
  const c: Config = { ...config(), controllerModel: "shared-anatomical" },
    rng = new Random(2026);
  for (let n = 0; n < 50; n++) {
    const g = randomGenes(rng, c),
      input = Array(44).fill(0);
    g.fill(0, 27, 31);
    input[25] = 1;
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ])
      for (let k = 0; k < 3; k++) {
        const a = 2 * rng.next() - 1,
          v = 2 * rng.next() - 1;
        input[l * 3 + k] = a;
        input[r * 3 + k] = k === 0 ? -a : a;
        input[12 + l * 3 + k] = v;
        input[12 + r * 3 + k] = k === 0 ? -v : v;
      }
    const out = sharedTorques(g, input, 0.7, true);
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ])
      for (let k = 0; k < 3; k++)
        expect(out[l * 3 + k]).toBeCloseTo(
          k === 0 ? -out[r * 3 + k] : out[r * 3 + k],
          12,
        );
  }
});
it("새 좌표는 보정 게인을 정하지 않고 기존44개는 같은 축 해석을 보존한다", () => {
  const g = Array(44).fill(0),
    input = Array(44).fill(0);
  input[26] = 0.2;
  expect(sharedTorques(g, input, 0.7, true)).toEqual(Array(12).fill(0));
  g[0] = 0.3;
  const old = new NeuralController(g).step(input, 1 / 120),
    local = new NeuralController(g, true).step(input, 1 / 120);
  expect(old[0]).toBe(old[3]);
  expect(local[0]).toBe(-local[3]);
  g[0] = 0;
  g[13] = 0.5;
  const positive = sharedTorques(g, input, 0.7, true);
  g[13] = -0.5;
  const negative = sharedTorques(g, input, 0.7, true);
  expect(positive[1]).toBe(-positive[4]);
  positive.forEach((v, i) => expect(v + negative[i]).toBeCloseTo(0, 12));
});
