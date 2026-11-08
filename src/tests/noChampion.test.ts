import { it, expect } from "vitest";
import { cloneConfig } from "../simulation/config";
import { Experiment } from "../simulation/experiment";
import { rank, breed, Random } from "../genetics/evolution";
import { parseCheckpoint } from "../persistence/files";
const finish = (e: Experiment) => {
  if (e.phase === "ready") e.start(false);
  while (e.phase === "running" || e.phase === "validating") e.step();
};
it.each([
  "shared-direction",
  "shared-reflex",
  "shared-anatomical",
  "timed-rnn",
  "local-feedback-rnn",
  "local-periodic-rnn",
] as const)(
  "%s의 새 세대는 챔피언을 지정·원본 복사하지 않고 저장 복원한다",
  (controllerModel) => {
    const e = new Experiment({
      ...cloneConfig(),
      controllerModel,
      population: 4,
      parentCount: 2,
      duration: 1,
    });
    finish(e);
    const source = rank(e.robots.map((r) => r.view()))[0].genes;
    e.evolve(e.autoParents(), undefined, true);
    expect(e.config.preserveChampion).toBe(false);
    expect(
      e.robots.every(
        (r) => !r.individual.champion && r.individual.birth?.kind !== "elite",
      ),
    ).toBe(true);
    expect(
      e.robots.some(
        (r) => JSON.stringify(r.individual.genes) === JSON.stringify(source),
      ),
    ).toBe(false);
    finish(e);
    const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
    expect(saved.config.preserveChampion).toBe(false);
    const restored = Experiment.restore(saved);
    e.evolve(e.autoParents(), undefined, true);
    restored.evolve(restored.autoParents(), undefined, true);
    expect(restored.robots.map((r) => r.individual)).toEqual(
      e.robots.map((r) => r.individual),
    );
    e.dispose();
    restored.dispose();
  },
);
it.each(["timed-rnn", "shared-direction"] as const)(
  "%s 수동 선택에서 제외한 최고점 개체를 몰래 복사하지 않는다",
  (controllerModel) => {
    const config = {
      ...cloneConfig(),
      controllerModel,
      population: 4,
      duration: 1,
    };
    const e = new Experiment(config);
    finish(e);
    const rows = rank(e.robots.map((r) => r.view())),
      chosen = rows[1];
    const children = breed(rows, [chosen.id], config, new Random(77));
    expect(children).toHaveLength(4);
    expect(
      children.every(
        (c) =>
          !c.champion && c.parents.length === 1 && c.parents[0] === chosen.id,
      ),
    ).toBe(true);
    expect(children.every((c) => c.birth?.changedGenes.length! > 0)).toBe(true);
    e.dispose();
  },
);
it("이전 파일은 그대로 읽되 다음 세대부터 챔피언 복사를 해제한다", () => {
  const e = new Experiment({
    ...cloneConfig(),
    preserveChampion: true,
    population: 4,
    duration: 1,
  });
  finish(e);
  const legacy = e.checkpoint();
  legacy.appVersion = "0.16.0";
  delete (legacy.config as Partial<typeof legacy.config>).preserveChampion;
  const restored = Experiment.restore(parseCheckpoint(JSON.stringify(legacy)));
  expect(restored.config.preserveChampion).toBe(true);
  restored.start(true);
  expect(restored.config.preserveChampion).toBe(false);
  expect(
    restored.robots.some(
      (r) => r.individual.champion || r.individual.birth?.kind === "elite",
    ),
  ).toBe(false);
  e.dispose();
  restored.dispose();
});

it.each([4, 60])(
  "보존 자리 없는 %i대 공통 분포의 첫 표본 ID와 최대 부모 수를 검증한다",
  async (population) => {
    const { breedSharedSearch, validateSharedState } =
      await import("../genetics/sharedSearch");
    const config = { ...cloneConfig(), population, parentCount: population };
    const e = new Experiment({ ...config, population: 2 });
    const template = e.robots[0].view();
    e.dispose();
    // Synthetic distribution-boundary fixtures, not a learning-performance claim.
    const rows = Array.from({ length: population }, (_, i) => ({
      ...structuredClone(template),
      id: i + 1,
      fitness: 1 - i / population,
    }));
    const result = breedSharedSearch(
      rows,
      config,
      new Random(23),
      1,
      "balance",
      null,
    );
    expect(result.population).toHaveLength(population);
    expect(result.state.draws[0][0]).toBe(1);
    expect(result.state.optimizer.mu).toBe(population);
    expect(() =>
      validateSharedState(
        result.state,
        result.population,
        2,
        config,
        "balance",
      ),
    ).not.toThrow();
  },
);

it("최고점 개체를 다른 보존 이름으로도 자동 복사하지 않는다", async () => {
  const { breedSharedSearch } = await import("../genetics/sharedSearch");
  const c = { ...cloneConfig(), population: 4 };
  const e = new Experiment(c),
    rows = e.robots.map((r) => r.view());
  e.dispose();
  const best = rows[0];
  best.outcome = "timeout";
  best.elapsed = 15;
  best.fitness = 1;
  Object.assign(best.frame.gait, {
    supportTime: 15,
    longestSupport: 15,
    mobileSupportTime: 15,
    longestMobileSupport: 15,
    jointFreedom: 1,
    steps: [2, 2, 2, 2],
    walkingTime: 1,
  });
  const result = breedSharedSearch(
    rows,
    c,
    new Random(44),
    1,
    "stepping",
    null,
  );
  expect(
    result.population.some(
      (r) => JSON.stringify(r.genes) === JSON.stringify(best.genes),
    ),
  ).toBe(false);
});
