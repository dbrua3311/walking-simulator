import { describe, it, expect } from "vitest";
import { Experiment } from "../simulation/experiment";
import { cloneConfig } from "../simulation/config";
import { csv, parseCheckpoint, validateCheckpoint } from "../persistence/files";
import { ghostFrame } from "../visualization/Scene";
function finished(
  initialization: "random" | "weak-balance" = "random",
  rewardModel:
    | "temporal-curriculum-v4"
    | "supported-curriculum-v5" = "temporal-curriculum-v4",
) {
  const e = new Experiment({
    ...cloneConfig(),
    evaluation: { ...cloneConfig().evaluation, contactModel: "proximity" },
    initialization,
    controllerModel: "timed-rnn",
    searchMethod: "adaptive",
    rewardModel,
    population: 4,
    duration: 1,
  });
  e.start(false);
  while (e.phase === "running") e.step();
  e.selected = [1, 2];
  return e;
}
describe("실험 파일", () => {
  it("JSON 복원 후 같은 부모의 다음 세대가 연속 실행과 일치한다", () => {
    const e = finished(),
      saved = parseCheckpoint(JSON.stringify(e.checkpoint())),
      loaded = Experiment.restore(saved);
    expect(loaded.robots.map((r) => r.view())).toEqual(
      e.robots.map((r) => r.view()),
    );
    e.evolve();
    loaded.evolve();
    expect(loaded.rng.state).toBe(e.rng.state);
    expect(loaded.robots.map((r) => r.individual)).toEqual(
      e.robots.map((r) => r.individual),
    );
    while (e.phase === "running") e.step();
    while (loaded.phase === "running") loaded.step();
    expect(loaded.history).toEqual(e.history);
  });
  it("32비트 난수 상태 전체 범위를 복원한다", () => {
    const saved = finished().checkpoint();
    saved.rngState = 4294967295;
    expect(validateCheckpoint(saved).rngState).toBe(4294967295);
  });
  it.each([
    "version",
    "duplicate",
    "gene",
    "reference",
    "infinite",
    "history",
    "ghost",
    "stat-mismatch",
    "parent-mismatch",
  ])("손상된 %s를 거절하고 현재 실험을 유지한다", (kind) => {
    const e = finished(),
      before = e.snapshot(),
      data = e.checkpoint();
    if (kind === "stat-mismatch") data.history[0].meanDistanceM += 1;
    if (kind === "parent-mismatch") data.completedResults[0].parents = [1];
    if (kind === "version") (data as any).formatVersion = 99;
    if (kind === "duplicate") data.population[1].id = 1;
    if (kind === "gene") data.population[0].genes[0] = 100;
    if (kind === "reference") data.selectedParentIds = [60];
    if (kind === "infinite") data.completedResults[0].energy = Infinity;
    if (kind === "history") data.history = [];
    if (kind === "ghost") data.previousBest!.frames[1].tick = -1;
    expect(() => validateCheckpoint(data)).toThrow();
    expect(e.snapshot()).toEqual(before);
  });
  it("CSV 열과 최고 적합도가 원본 통계와 일치한다", () => {
    const e = finished(),
      lines = csv(e.history, e.config.rewardModel).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "generation,bestDistanceM,meanDistanceM,bestFitness,meanFitness,fallenCount,successCount,bestRobotId,stage,maxSupportTime,maxFootCount,maxWalkingTime,qualifiedCount,rewardVersion",
    );
    expect(lines[1].split(",").at(-1)).toBe(e.config.rewardModel);
    expect(Number(lines[1].split(",")[3])).toBe(
      Math.max(...e.robots.map((r) => r.fitness)),
    );
  });
  it("주행 중 저장 예약은 세대 경계에서만 호출된다", () => {
    const e = new Experiment({ ...cloneConfig(), population: 2, duration: 1 });
    let called = 0;
    e.onSave = (data) => {
      validateCheckpoint(data);
      called++;
    };
    e.savePending = true;
    e.start(true);
    for (let i = 0; i < 10; i++) e.step();
    expect(called).toBe(0);
    while (e.phase === "running") e.step();
    expect(called).toBe(1);
    expect(e.savePending).toBe(false);
  });
  it("고스트는 실제 궤적을 같은 tick으로 재생하고 종료 후 고정한다", () => {
    const e = finished(),
      ghost = e.previousBest!;
    const frame = ghost.frames[2];
    expect(ghostFrame(ghost, frame.tick).bodies).toEqual(frame.bodies);
    expect(ghostFrame(ghost, 99999).bodies).toEqual(
      ghost.frames.at(-1)!.bodies,
    );
    const before = e.robots.map((r) => r.view());
    ghostFrame(ghost, 10);
    expect(e.robots.map((r) => r.view())).toEqual(before);
  });
});

it("저장 대기 중인 다음 세대 설정도 복원한다", () => {
  const e = finished();
  e.queueSettings({
    population: 6,
    mutation: 0.3,
    crossover: 0.7,
    parentCount: 2,
  });
  const loaded = Experiment.restore(
    parseCheckpoint(JSON.stringify(e.checkpoint())),
  );
  e.evolve(e.autoParents());
  loaded.evolve(loaded.autoParents());
  expect(loaded.config).toEqual(e.config);
  expect(loaded.robots.map((r) => r.individual)).toEqual(
    e.robots.map((r) => r.individual),
  );
  expect(loaded.robots).toHaveLength(6);
});

it("2세대의 실제 부모·변형 기록을 저장·복원하고 위조된 계보를 거절한다", () => {
  const e = finished();
  e.queueSettings({
    population: 20,
    mutation: 0.1,
    crossover: 0,
    mutationScale: 0.03,
    parentCount: 2,
  });
  e.evolve([2]);
  while (e.phase === "running") e.step();
  const saved = parseCheckpoint(JSON.stringify(e.checkpoint())),
    loaded = Experiment.restore(saved);
  expect(saved.population).toHaveLength(20);
  expect(loaded.robots.map((r) => r.individual)).toEqual(
    e.robots.map((r) => r.individual),
  );
  expect(
    saved.population
      .slice(1)
      .filter((r) => !r.immigrant)
      .every((r) => r.parents[0] === 2 && r.birth!.changedGenes.length > 0),
  ).toBe(true);
  saved.population[1].birth!.changedGenes = [];
  saved.completedResults[1].birth!.changedGenes = [];
  expect(() => validateCheckpoint(saved)).toThrow("변형 기록");
  e.dispose();
  loaded.dispose();
});

it.each([1, 2, 3, 4])(
  "이전 제어 방식 v%s는 거절하고 현재 무작위 실험은 보존한다",
  (version) => {
    const e = finished(),
      before = e.snapshot(),
      data = e.checkpoint();
    (data as any).formatVersion = version;
    expect(() => validateCheckpoint(data)).toThrow();
    expect(e.snapshot()).toEqual(before);
    e.dispose();
  },
);

it("넘어짐 반복으로 새 무작위 개체가 생긴 세대도 v6 파일로 보존한다", () => {
  const e = new Experiment({
    ...cloneConfig(),
    controllerModel: "local-periodic-rnn",
    parentCount: 5,
    population: 4,
    duration: 1,
  });
  for (let gen = 1; gen <= 2; gen++) {
    e.start(false);
    while (e.phase === "running") e.step();
    if (gen < 2) e.evolve(e.autoParents());
  }
  const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
  expect(saved.formatVersion).toBe(6);
  expect(saved.rewardVersion).toBe("settled-curriculum-v9");
  expect(saved.population.some((r) => r.immigrant)).toBe(true);
  e.dispose();
});

it.each(["score-sum", "stage-history", "time-range"])(
  "새 단계 저장의 %s 위조를 거절한다",
  (kind) => {
    const e = finished(),
      data = e.checkpoint();
    if (kind === "score-sum") data.completedResults[0].score.penalty += 0.1;
    if (kind === "stage-history") data.history[0].stage = "forward";
    if (kind === "time-range")
      data.completedResults[0].frame.gait.walkingTime = 10000;
    expect(() => validateCheckpoint(data)).toThrow();
    e.dispose();
  },
);

it("후진 감점 이전 v5 보상 파일은 현재 상태를 바꾸지 않고 거절한다", () => {
  const e = finished(),
    before = e.snapshot();
  const old = {
    ...e.checkpoint(),
    formatVersion: 5,
    appVersion: "0.5.0",
    rewardVersion: "curriculum-progress-v2",
  };
  expect(() => parseCheckpoint(JSON.stringify(old))).toThrow(
    "후진 누적 감점 이전",
  );
  expect(e.snapshot()).toEqual(before);
  e.dispose();
});

it("이전 고정 시간 입력 없는 v5 신경망은 원본과 현재 실험을 유지하며 거절한다", () => {
  const e = finished(),
    before = e.snapshot();
  const old = {
    ...e.checkpoint(),
    formatVersion: 5,
    rewardVersion: "temporal-curriculum-v4",
  };
  expect(() => parseCheckpoint(JSON.stringify(old))).toThrow(
    "시간 변화 입력 이전",
  );
  expect(e.snapshot()).toEqual(before);
  e.dispose();
});

it("같은 제어·보상의 v5 변이 체크포인트를 그대로 보존하고 다음 세대부터 v7 변이를 쓴다", () => {
  const original = finished(),
    old = original.checkpoint();
  old.appVersion = "0.6.0";
  old.evolutionVersion = "adaptive-mutation-v5";
  old.selectionVersion = "curriculum-diversity-v2";
  const parsed = parseCheckpoint(JSON.stringify(old)),
    restored = Experiment.restore(parsed);
  expect(restored.robots.map((r) => r.view())).toEqual(
    original.robots.map((r) => r.view()),
  );
  expect(restored.history).toEqual(original.history);
  expect(restored.rng.state).toBe(original.rng.state);
  expect(restored.checkpoint().evolutionVersion).toBe("adaptive-mutation-v5");
  expect(restored.checkpoint().selectionVersion).toBe(
    "curriculum-diversity-v2",
  );
  restored.evolve(restored.autoParents());
  expect(restored.evolutionVersion).toBe("adaptive-mutation-v11");
  expect(restored.selectionVersion).toBe("curriculum-diversity-v4");
  expect(restored.generation).toBe(old.generation + 1);
  original.dispose();
  restored.dispose();
});

it("구형 저장의 승급 기준을 조용히 바꾸지 않고 새 실험만 네 발 조율 기준으로 시작한다", () => {
  const e = finished(),
    original = e.checkpoint(),
    old = structuredClone(original) as any;
  old.appVersion = "0.6.4";
  old.evolutionVersion = "adaptive-mutation-v9";
  delete old.config.curriculum.coordinatedPromotion;
  old.config.curriculum.steppingFeet = 3;
  old.config.curriculum.steppingSteps = 4;
  const parsed = parseCheckpoint(JSON.stringify(old));
  expect(parsed.config.curriculum.coordinatedPromotion).toBe(false);
  expect(parsed.config.curriculum.steppingFeet).toBe(3);
  expect(parsed.population).toEqual(original.population);
  expect(parsed.rngState).toBe(original.rngState);
  expect(parsed.history).toEqual(original.history);
  expect(cloneConfig().curriculum.coordinatedPromotion).toBe(true);
  expect(cloneConfig().curriculum.steppingFeet).toBe(4);
  e.dispose();
});

it("초기 편향 설정을 보존하고 이전 저장의 누락 필드는 완전 무작위로 복원한다", () => {
  const e = finished("weak-balance"),
    saved = e.checkpoint();
  expect(parseCheckpoint(JSON.stringify(saved)).config.initialization).toBe(
    "weak-balance",
  );
  expect(parseCheckpoint(JSON.stringify(saved)).config.initialBalanceBias).toBe(
    0.5,
  );
  const legacy = structuredClone(saved) as any;
  legacy.appVersion = "0.7.0";
  legacy.evolutionVersion = "adaptive-mutation-v10";
  delete legacy.config.initialization;
  delete legacy.config.initialBalanceBias;
  const restored = Experiment.restore(parseCheckpoint(JSON.stringify(legacy)));
  expect(restored.config.initialization).toBe("random");
  expect(restored.config.initialBalanceBias).toBe(0);
  expect(restored.robots.map((r) => r.individual.genes)).toEqual(
    e.robots.map((r) => r.individual.genes),
  );
  expect(restored.rng.state).toBe(e.rng.state);
  e.dispose();
  restored.dispose();
});

it("새 보상과 구 보상은 설정·표시·재개를 구분하고 위조된 버전 조합을 거절한다", () => {
  const e = finished("random", "supported-curriculum-v5"),
    saved = e.checkpoint();
  expect(parseCheckpoint(JSON.stringify(saved)).rewardVersion).toBe(
    "supported-curriculum-v5",
  );
  const mismatch = structuredClone(saved);
  mismatch.config.rewardModel = "temporal-curriculum-v4";
  expect(() => validateCheckpoint(mismatch)).toThrow("보상 버전");
  const legacy = finished(),
    old = legacy.checkpoint() as any;
  old.appVersion = "0.8.0";
  delete old.config.rewardModel;
  const loaded = Experiment.restore(parseCheckpoint(JSON.stringify(old)));
  expect(loaded.config.rewardModel).toBe("temporal-curriculum-v4");
  expect(loaded.snapshot().history).toEqual(legacy.history);
  loaded.evolve(loaded.autoParents());
  expect(loaded.config.rewardModel).toBe("temporal-curriculum-v4");
  const obsolete = structuredClone(saved);
  obsolete.appVersion = "0.8.0";
  expect(() => validateCheckpoint(obsolete)).toThrow("보상 버전");
  e.dispose();
  legacy.dispose();
  loaded.dispose();
});

it("진화 설정 경로로 보상 기준을 바꾸거나 이전 이력에 새 점수를 섞을 수 없다", () => {
  const e = finished(),
    before = e.snapshot();
  const injected = {
    rewardModel: "supported-curriculum-v5",
    mutation: 0.1,
  } as any;
  expect(() => e.queueSettings(injected)).toThrow("평가·초기화 기준");
  expect(() => e.evolve(e.autoParents(), injected)).toThrow("평가·초기화 기준");
  expect(e.snapshot()).toEqual(before);
  e.dispose();
});

it("새 재착지 보상·체중 이동 지표와 진화 버전은 실제 평가 후 저장 복원을 유지한다", () => {
  const e = new Experiment({
    ...cloneConfig(),
    controllerModel: "local-periodic-rnn",
    parentCount: 5,
    population: 4,
    duration: 1,
  });
  e.start(false);
  while (e.phase === "running") e.step();
  const saved = parseCheckpoint(JSON.stringify(e.checkpoint()));
  expect(saved.rewardVersion).toBe("settled-curriculum-v9");
  expect(saved.evolutionVersion).toBe("adaptive-mutation-v16");
  expect(
    saved.completedResults.every(
      (r) =>
        r.frame.gait.footProgress?.length === 4 &&
        r.frame.gait.weightShift?.length === 4,
    ),
  ).toBe(true);
  const restored = Experiment.restore(saved),
    ids = e.autoParents();
  expect(restored.robots.map((r) => r.view())).toEqual(
    e.robots.map((r) => r.view()),
  );
  e.evolve(ids);
  restored.evolve(ids);
  expect(restored.robots.map((r) => r.individual)).toEqual(
    e.robots.map((r) => r.individual),
  );
  expect(restored.rng.state).toBe(e.rng.state);
  for (const value of [-1, 2, NaN]) {
    const invalid = structuredClone(saved);
    invalid.completedResults[0].frame.gait.footProgress![0] = value;
    expect(() => validateCheckpoint(invalid)).toThrow();
  }
  const obsolete = structuredClone(saved);
  obsolete.appVersion = "0.9.0";
  expect(() => validateCheckpoint(obsolete)).toThrow("보상 버전");
  e.dispose();
  restored.dispose();
});

it("반복 보상은 세대별 기준을 명시하며 이전 v6를 새 점수로 조용히 바꾸지 않는다", () => {
  const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
  e.start(false);
  while (e.phase === "running") e.step();
  const saved = e.checkpoint();
  expect(saved.history[0].rewardVersion).toBe("settled-curriculum-v9");
  const missing = structuredClone(saved);
  delete missing.history[0].rewardVersion;
  expect(() => validateCheckpoint(missing)).toThrow("보상 버전");
  const mismatched = structuredClone(saved);
  mismatched.history[0].rewardVersion = "cycle-curriculum-v6";
  expect(() => validateCheckpoint(mismatched)).toThrow("보상 버전");
  const mixed = [
    { ...saved.history[0], rewardVersion: "cycle-curriculum-v6" as const },
    { ...saved.history[0], generation: 2 },
  ];
  const rows = csv(mixed, "mobile-curriculum-v8").split("\n");
  expect(rows[1].endsWith("cycle-curriculum-v6")).toBe(true);
  expect(rows[2].endsWith("settled-curriculum-v9")).toBe(true);
  e.dispose();
  const legacy = new Experiment({
    ...cloneConfig(),
    evaluation: { ...cloneConfig().evaluation, contactModel: "proximity" },
    rewardModel: "cycle-curriculum-v6",
    controllerModel: "timed-rnn",
    searchMethod: "adaptive",
    population: 4,
    duration: 1,
  });
  legacy.start(false);
  while (legacy.phase === "running") legacy.step();
  const old = legacy.checkpoint();
  old.appVersion = "0.10.1";
  expect(parseCheckpoint(JSON.stringify(old)).config.rewardModel).toBe(
    "cycle-curriculum-v6",
  );
  expect(old.history[0].rewardVersion).toBeUndefined();
  expect(old.completedResults[0].frame.gait.stepActivity).toBeUndefined();
  legacy.dispose();
});

it("가동 여유 시간의 모순과 구 앱으로 위장한 새 보상 파일을 거절한다", () => {
  const e = new Experiment({ ...cloneConfig(), population: 2, duration: 1 });
  e.start(false);
  while (e.phase === "running") e.step();
  const saved = e.checkpoint();
  const inconsistent = structuredClone(saved);
  inconsistent.completedResults[0].frame.gait.longestMobileSupport = 16;
  expect(() => validateCheckpoint(inconsistent)).toThrow();
  const forged = structuredClone(saved);
  forged.appVersion = "0.11.0";
  expect(() => validateCheckpoint(forged)).toThrow("보상 버전");
  e.dispose();
});

it("새 연속·경로 기준이 없는 구 파일은 당시 종료 규칙을 기본값으로 복원한다", () => {
  const e = finished(),
    d = e.checkpoint();
  const raw = JSON.parse(JSON.stringify(d));
  for (const k of [
    "forwardContinuousSeconds",
    "requireWalkingAtFinish",
    "useDriftLimits",
    "maxLateralDeviation",
    "maxHeadingDeviation",
    "mobileSupportRatio",
    "minJointFreedomAtPromotion",
  ])
    delete raw.config.curriculum[k];
  delete raw.config.evaluation.walkingContinuityGrace;
  delete raw.config.controllerModel;
  delete raw.config.searchMethod;
  const parsed = parseCheckpoint(JSON.stringify(raw));
  expect(parsed.config.controllerModel).toBe("timed-rnn");
  expect(parsed.config.searchMethod).toBe("adaptive");
  expect(parsed.config.curriculum.forwardContinuousSeconds).toBe(0);
  expect(parsed.config.curriculum.requireWalkingAtFinish).toBe(false);
  expect(parsed.config.curriculum.useDriftLimits).toBe(false);
  expect(parsed.config.evaluation.walkingContinuityGrace).toBe(0);
  expect(parsed.population).toEqual(d.population);
  expect(parsed.rngState).toBe(d.rngState);
  e.dispose();
});

it("하중 접촉 기준은 새 버전으로 저장하고 이전 앱 버전으로 위장하지 않는다", () => {
  const e = new Experiment({ ...cloneConfig(), population: 2, duration: 1 });
  e.start(false);
  while (e.phase === "running") e.step();
  const saved = e.checkpoint();
  expect(
    parseCheckpoint(JSON.stringify(saved)).config.evaluation.contactModel,
  ).toBe("load-bearing");
  saved.rewardVersion = "mobile-curriculum-v8";
  saved.config.rewardModel = "mobile-curriculum-v8";
  saved.appVersion = "0.14.0";
  expect(() => validateCheckpoint(saved)).toThrow("발 지지 기준");
  e.dispose();
});
