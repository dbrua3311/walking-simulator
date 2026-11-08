import { describe, it, expect } from "vitest";
import { WalkingAssessment, type MotionSample } from "../physics/assessment";
import { cloneConfig } from "../simulation/config";
import {
  assessCurriculum,
  enterNextGeneration,
  initialCurriculum,
  meetsStage,
} from "../simulation/curriculum";
import { Experiment } from "../simulation/experiment";
import { suggestParents } from "../genetics/evolution";
import { parseCheckpoint, validateCheckpoint } from "../persistence/files";
import { PolicyVerification } from "../simulation/verification";
import type { Config, RobotView, TrainingStage } from "../simulation/types";
const ground: MotionSample = {
  x: 0,
  dx: 0,
  dz: 0,
  height: 0.4,
  verticalSpeed: 0,
  yawSpeed: 0,
  tilt: 0,
  heading: 1,
  contacts: 3,
  slip: 0,
  limbContact: false,
};
function sample(
  seconds: number,
  stage: TrainingStage = "forward",
  moving = false,
  wobble = false,
  rewardModel?: Config["rewardModel"],
) {
  const config = cloneConfig();
  if (rewardModel) config.rewardModel = rewardModel;
  const a = new WalkingAssessment(config, stage);
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    a.observe({
      ...ground,
      x: moving ? (i + 1) * 0.001 : 0,
      dx: moving ? 0.001 : 0,
      tilt: wobble ? 0.4 : 0,
      slip: wobble ? 0.2 : 0,
    });
    a.observeWalking(moving, moving ? 0.12 : 0);
  }
  return a;
}
function finished() {
  const e = new Experiment({ ...cloneConfig(), population: 4, duration: 1 });
  e.start(false);
  while (e.phase === "running" || e.phase === "validating") e.step();
  return e;
}
function forwardView(base: RobotView): RobotView {
  const r = structuredClone(base);
  r.outcome = "success";
  r.elapsed = 12;
  r.frame.tick = 1440;
  r.frame.distance = 1.1;
  Object.assign(r.frame.gait, {
    steps: [3, 3, 3, 3],
    supportTime: 12,
    uprightTime: 12,
    longestSupport: 3,
    walkingTime: 10.5,
    qualityWalkingTime: 10,
    longestWalking: 6,
    walking: true,
    airTime: 0,
    longestFlight: 0,
    lateralTravel: 0.02,
    lateralDeviation: 0.02,
    headingDeviation: 0.05,
    yawTravel: 0.1,
    jumping: false,
  });
  return r;
}
describe("요청한 보행 점수", () => {
  it("발로 버틴 시간의 점수는 시간에 비례하고 체공은 포함하지 않는다", () => {
    const a = sample(1, "balance"),
      b = sample(2, "balance");
    expect(b.breakdown(0, [0, 0, 0, 0], 0, 2).support).toBeCloseTo(
      2 * a.breakdown(0, [0, 0, 0, 0], 0, 1).support,
      10,
    );
    const before = b.supportTime;
    for (let i = 0; i < 5; i++) b.observe({ ...ground, contacts: 0 });
    expect(b.supportTime).toBe(before);
    expect(b.supportRun).toBe(0);
  });
  it("균형 초기에는 접지 자세 품질도 학습하되 공중 시간은 가점하지 않는다", () => {
    const a = new WalkingAssessment(cloneConfig(), "balance"),
      b = new WalkingAssessment(cloneConfig(), "balance");
    for (let i = 0; i < 120; i++) {
      a.observe({ ...ground, slip: 1, tilt: 0.1 });
      b.observe({ ...ground, slip: 1, tilt: 0.4 });
    }
    expect(a.supportTime).toBe(0);
    expect(b.supportTime).toBe(0);
    const before = a.breakdown(0, [0, 0, 0, 0], 0, 1).support;
    expect(before).toBeGreaterThan(b.breakdown(0, [0, 0, 0, 0], 0, 1).support);
    for (let i = 0; i < 5; i++) a.observe({ ...ground, contacts: 0 });
    expect(a.breakdown(0, [0, 0, 0, 0], 0, 1).support).toBe(before);
  });
  it("최종 단계의 안정적인 반복 보행은 오래 서 있기보다 훨씬 크다", () => {
    const stand = sample(15),
      walk = sample(10, "forward", true);
    const s = stand.score(0, [0, 0, 0, 0], 0, 15, "timeout"),
      w = walk.score(1, [2, 2, 2, 2], 0, 10);
    expect(w).toBeGreaterThan(0.9);
    expect(w).toBeGreaterThan(10 * s);
    expect(walk.walkingTime).toBeCloseTo(10, 8);
  });
  it("이전 v4의 짧은 발짓 후 넘어짐이 정체보다 유리했던 보상을 재현한다", () => {
    const stand = sample(7, "stepping", false, false, "temporal-curriculum-v4"),
      step = sample(2, "stepping", false, false, "temporal-curriculum-v4");
    expect(step.score(0, [1, 0, 0, 0], 0, 2, "fallen")).toBeGreaterThan(
      stand.score(0, [0, 0, 0, 0], 0, 7, "stalled"),
    );
  });
  it("승급 후에도 배운 기본 지지를 잃고 빨리 넘어지는 행동이 유리해지지 않는다", () => {
    const balanced = sample(2, "stepping"),
      collapse = sample(0.5, "stepping");
    expect(balanced.score(0, [0, 0, 0, 0], 0, 2, "fallen")).toBeGreaterThan(
      collapse.score(0, [0, 0, 0, 0], 0, 0.5, "fallen"),
    );
  });
  it("넘어짐 감점은 최종 단계에서 350점이며 초기에도 감점한다", () => {
    const a = sample(2),
      b = sample(2, "balance");
    expect(
      a.score(0, [0, 0, 0, 0], 0, 2) - a.score(0, [0, 0, 0, 0], 0, 2, "fallen"),
    ).toBeCloseTo(0.35, 10);
    expect(
      b.score(0, [0, 0, 0, 0], 0, 2) - b.score(0, [0, 0, 0, 0], 0, 2, "fallen"),
    ).toBeCloseTo(0.1, 10);
  });
  it("같은 시간·거리도 흔들리고 미끄러지는 보행은 연속 보너스가 작다", () => {
    const smooth = sample(10, "forward", true),
      wobble = sample(10, "forward", true, true);
    expect(smooth.walkingTime).toBeCloseTo(wobble.walkingTime, 10);
    expect(smooth.qualityWalkingTime).toBeGreaterThan(
      wobble.qualityWalkingTime,
    );
    expect(smooth.score(1, [2, 2, 2, 2], 0, 10)).toBeGreaterThan(
      wobble.score(1, [2, 2, 2, 2], 0, 10),
    );
  });
});
describe("후진 누적 감점", () => {
  it.each<TrainingStage>(["balance", "stepping", "forward"])(
    "%s 단계에서 뒤로 1m 가면 같은 지지 시간보다 150점 낮다",
    (stage) => {
      const stand = sample(2, stage),
        reverse = new WalkingAssessment(cloneConfig(), stage);
      for (let i = 0; i < 240; i++)
        reverse.observe({ ...ground, x: -(i + 1) / 240, dx: -1 / 240 });
      const a = stand.breakdown(0, [0, 0, 0, 0], 0, 2),
        b = reverse.breakdown(0, [0, 0, 0, 0], 0, 2);
      expect(reverse.backwardTravel).toBeCloseTo(1, 10);
      expect(reverse.groundedForward).toBe(0);
      expect(a.total - b.total).toBeCloseTo(0.15, 10);
      expect(b.penalty - a.penalty).toBeCloseTo(0.15, 10);
    },
  );
  it("동일한 발 사용이라도 실제 전진은 후진보다 크게 보상한다", () => {
    const forward = new WalkingAssessment(cloneConfig(), "forward"),
      reverse = new WalkingAssessment(cloneConfig(), "forward");
    for (let i = 0; i < 240; i++) {
      forward.observe({ ...ground, x: (i + 1) / 240, dx: 1 / 240 });
      reverse.observe({ ...ground, x: -(i + 1) / 240, dx: -1 / 240 });
      forward.observeWalking(true, 0.5);
      reverse.observeWalking(true, -0.5);
    }
    expect(forward.backwardTravel).toBe(0);
    expect(reverse.walkingTime).toBe(0);
    const a = forward.breakdown(1, [2, 2, 2, 2], 0, 2),
      b = reverse.breakdown(0, [2, 2, 2, 2], 0, 2);
    expect(a.forward).toBeCloseTo(0.45, 10);
    expect(a.total - b.total).toBeGreaterThan(0.6);
  });
  it("뒤로 갔다 원점에 돌아와도 후진 감점은 남고 전진을 쌓지 못한다", () => {
    const a = new WalkingAssessment(cloneConfig(), "forward");
    for (let i = 0; i < 240; i++)
      a.observe({ ...ground, x: -(i + 1) / 240, dx: -1 / 240 });
    for (let i = 0; i < 240; i++)
      a.observe({ ...ground, x: -1 + (i + 1) / 240, dx: 1 / 240 });
    expect(a.backwardTravel).toBeCloseTo(1, 10);
    expect(a.groundedForward).toBe(0);
    expect(a.breakdown(0, [0, 0, 0, 0], 0, 4).penalty).toBeCloseTo(0.15, 10);
  });
  it.each(["air", "drag", "turned"])(
    "%s 구간도 후진을 숨길 수 없고 전진 보상을 얻지 못한다",
    (kind) => {
      const a = new WalkingAssessment(cloneConfig(), "forward");
      a.observe({
        ...ground,
        x: -0.02,
        dx: -0.02,
        contacts: kind === "air" ? 0 : 3,
        limbContact: kind === "drag",
        heading: kind === "turned" ? -1 : 1,
      });
      expect(a.backwardTravel).toBeCloseTo(0.02, 10);
      expect(a.groundedForward).toBe(0);
      expect(a.breakdown(0, [0, 0, 0, 0], 0, 1 / 120).penalty).toBeCloseTo(
        0.003,
        10,
      );
    },
  );
  it("미세한 후진도 거리 비례로만 감점하며 반복 이동으로 숨기지 못한다", () => {
    const a = new WalkingAssessment(cloneConfig(), "forward");
    for (let i = 0; i < 120; i++)
      a.observe({ ...ground, x: -(i + 1) * 0.000005, dx: -0.000005 });
    expect(a.backwardTravel).toBeCloseTo(0.0006, 12);
    expect(a.breakdown(0, [0, 0, 0, 0], 0, 1).penalty).toBeCloseTo(0.00009, 12);
  });
});
describe("단계 전환", () => {
  it("누적 지지만으로 승급하지 않고 연속 안정 지지와 연속 세대를 요구한다", () => {
    const e = finished(),
      r = e.robots[0].view(),
      config = cloneConfig();
    r.elapsed = 15;
    r.outcome = "timeout";
    r.frame.gait.supportTime = 4;
    r.frame.gait.longestSupport = 0.5;
    expect(meetsStage(r, "balance", config)).toBe(false);
    r.frame.gait.longestSupport = 2;
    r.outcome = "fallen";
    expect(meetsStage(r, "balance", config)).toBe(false);
    r.outcome = "timeout";
    r.elapsed = 2;
    expect(meetsStage(r, "balance", config)).toBe(false);
    r.elapsed = 15;
    r.frame.gait.longestMobileSupport = 2;
    r.frame.gait.mobileSupportTime = 12;
    r.frame.gait.supportTime = 15;
    r.frame.gait.jointFreedom = 1;
    let c = initialCurriculum();
    c = assessCurriculum(c, [r], config);
    expect(c.streak).toBe(1);
    const reset = assessCurriculum(c, [], config);
    expect(reset.streak).toBe(0);
    c = assessCurriculum(c, [r], config);
    c = assessCurriculum(c, [r], config);
    expect(c.stage).toBe("balance");
    expect(c.pendingStage).toBe("stepping");
    expect(enterNextGeneration(c, 4)).toEqual({
      stage: "stepping",
      startedGeneration: 4,
      streak: 0,
      pendingStage: null,
    });
    e.dispose();
  });
  it("한 발 반복·앞으로 안 가는 발짓은 다음 단계 조건이 아니다", () => {
    const e = finished(),
      r = e.robots[0].view(),
      cfg = cloneConfig();
    r.frame.gait.supportTime = 3;
    r.frame.gait.steps = [20, 0, 0, 0];
    r.frame.gait.groundedForward = 0.2;
    expect(meetsStage(r, "stepping", cfg)).toBe(false);
    r.frame.gait.steps = [2, 1, 1, 0];
    expect(meetsStage(r, "stepping", cfg)).toBe(false);
    cfg.curriculum.coordinatedPromotion = false;
    cfg.curriculum.steppingFeet = 3;
    cfg.curriculum.steppingSteps = 4;
    expect(meetsStage(r, "stepping", cfg)).toBe(true);
    r.frame.gait.groundedForward = 0;
    expect(meetsStage(r, "stepping", cfg)).toBe(false);
    e.dispose();
  });
  it("전진 단계 승급은 네 발 반복·실제 연속 보행·평가 종료까지 유지한 경우에만 예약한다", () => {
    const e = finished(),
      cfg = cloneConfig(),
      r = forwardView(e.robots[0].view());
    r.outcome = "timeout";
    r.elapsed = cfg.duration;
    r.frame.gait.groundedForward = 0.2;
    r.frame.gait.walking = true;
    expect(meetsStage(r, "stepping", cfg)).toBe(true);
    for (const failure of [
      "fallen",
      "three-feet",
      "uneven-steps",
      "no-walk",
      "not-recent",
      "early-timeout",
    ]) {
      const bad = structuredClone(r);
      if (failure === "fallen") bad.outcome = "fallen";
      if (failure === "three-feet") bad.frame.gait.steps = [0, 3, 3, 3];
      if (failure === "uneven-steps") bad.frame.gait.steps = [1, 3, 3, 3];
      if (failure === "no-walk") bad.frame.gait.longestWalking = 0.99;
      if (failure === "not-recent") bad.frame.gait.walking = false;
      if (failure === "early-timeout") bad.elapsed = cfg.duration - 0.1;
      expect(meetsStage(bad, "stepping", cfg)).toBe(false);
    }
    let state = {
      stage: "stepping" as const,
      startedGeneration: 30,
      streak: 0,
      pendingStage: null,
    };
    const first = assessCurriculum(state, [r], cfg);
    expect(first.pendingStage).toBe(null);
    const second = assessCurriculum(first, [r], cfg);
    const third = assessCurriculum(second, [r], cfg);
    expect(third.stage).toBe("stepping");
    expect(third.pendingStage).toBe("forward");
    expect(enterNextGeneration(third, 100).stage).toBe("forward");
    e.dispose();
  });
  it("거리만 큰 점프·끌기·중간에 넘어진 개체를 최종 후보로 인정하지 않는다", () => {
    const e = finished(),
      cfg = cloneConfig(),
      r = forwardView(e.robots[0].view());
    expect(meetsStage(r, "forward", cfg)).toBe(true);
    for (const kind of ["jump", "no-steps", "stand", "fallen", "side"]) {
      const bad = structuredClone(r);
      if (kind === "jump") bad.frame.gait.jumping = true;
      if (kind === "no-steps") bad.frame.gait.steps = [0, 0, 0, 0];
      if (kind === "stand") bad.frame.gait.walkingTime = 0;
      if (kind === "fallen") bad.outcome = "fallen";
      if (kind === "side") {
        bad.frame.gait.lateralTravel = 2;
        bad.frame.gait.lateralDeviation = 2;
      }
      expect(meetsStage(bad, "forward", cfg)).toBe(false);
    }
    e.dispose();
  });
  it("실제 물리의 낮춘 테스트 기준을 달성해도 승급은 저장 후 다음 세대에서만 한다", () => {
    const config = cloneConfig();
    config.population = 4;
    config.duration = 1;
    config.seed = 16;
    config.controllerModel = "timed-rnn";
    config.searchMethod = "adaptive";
    config.rewardModel = "rhythmic-curriculum-v7"; // Existing physical boundary fixture.
    config.initialization = "random";
    config.initialBalanceBias = 0;
    config.curriculum.balanceSeconds = 0.1;
    config.curriculum.promotionGenerations = 1;
    const e = new Experiment(config);
    e.start(false);
    while (e.phase === "running") e.step();
    expect(e.curriculum.stage).toBe("balance");
    expect(e.curriculum.pendingStage).toBe("stepping");
    const saved = parseCheckpoint(JSON.stringify(e.checkpoint())),
      restored = Experiment.restore(saved);
    const originals = e.robots.map((r) => r.view());
    const bad = structuredClone(saved);
    bad.curriculum.pendingStage = null;
    expect(() => validateCheckpoint(bad)).toThrow("승급");
    e.evolve(e.autoParents());
    restored.evolve(restored.autoParents());
    expect(e.curriculum.stage).toBe("stepping");
    expect(e.history[0].stage).toBe("balance");
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(originals[0].frame.gait.longestSupport).toBeGreaterThanOrEqual(0.1);
    e.dispose();
    restored.dispose();
  });
});
describe("다양성·보행 재검증", () => {
  it("자동 부모에 다른 발을 사용하는 유효 계보를 남긴다", () => {
    const e = finished(),
      base = e.robots[0].view(),
      p = Array.from({ length: 8 }, (_, i) => {
        const r = structuredClone(base);
        r.id = i + 1;
        r.fitness = 0.8 - i * 0.05;
        r.outcome = "fallen";
        r.frame.gait.steps =
          i < 5 ? [1, 0, 0, 0] : i === 5 ? [0, 1, 0, 0] : [0, 0, 1, 0];
        return r;
      });
    const choices = suggestParents(p, 5);
    expect(choices.slice(0, 3).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(
      choices.filter((c) => c.reason === "diversity").map((c) => c.id),
    ).toEqual([6, 7]);
    p[5].outcome = "jumped";
    expect(suggestParents(p, 5).some((c) => c.id === 6)).toBe(false);
    e.dispose();
  });
  it("발 단계는 낮은 점수라도 새 발의 실제 걸음을 한 계보에 한해 보존한다", () => {
    const e = finished(),
      base = e.robots[0].view();
    const p = Array.from({ length: 9 }, (_, i) => {
      const r = structuredClone(base);
      r.id = i + 1;
      r.fitness = i < 6 ? 0.416 - i * 0.001 : 0.165 - (i - 6) * 0.01;
      r.outcome = "fallen";
      r.frame.gait.supportTime = 0.533;
      r.frame.gait.steps =
        i < 6 ? [0, 1, 0, 5] : i === 6 ? [0, 1, 1, 0] : [1, 0, 0, 0];
      return r;
    });
    expect(suggestParents(p, 5, "balance").some((c) => c.id === 7)).toBe(false);
    const choices = suggestParents(p, 5, "stepping");
    expect(choices.slice(0, 3).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(choices.filter((c) => c.reason === "new-foot")).toEqual([
      { id: 7, reason: "new-foot" },
    ]);
    expect(choices).toHaveLength(5);
    p[6].outcome = "jumped";
    p[7].outcome = "invalid";
    p[8].frame.gait.supportTime = 0.49;
    expect(
      suggestParents(p, 5, "forward").some((c) => c.reason === "new-foot"),
    ).toBe(false);
    p[8].frame.gait.supportTime = 1;
    p[8].fitness = -0.085;
    expect(
      suggestParents(p, 5, "stepping").some((c) => c.reason === "new-foot"),
    ).toBe(false);
    e.dispose();
  });
  it("세 검증은 같은 유전자·서로 다른 초기 기울기의 실제 World를 사용한다", () => {
    const e = finished(),
      v = new PolicyVerification(e.robots[0].individual, 1, cloneConfig());
    expect(
      v.robots.every((r) =>
        r.individual.genes.every((g, i) => g === v.candidate.genes[i]),
      ),
    ).toBe(true);
    expect(v.robots[0].frame().bodies).not.toEqual(v.robots[1].frame().bodies);
    expect(v.robots[1].frame().bodies).not.toEqual(v.robots[2].frame().bodies);
    expect(
      v.robots.every((r) => r.frame().feet.every((f) => f.clearance >= 0)),
    ).toBe(true);
    while (!v.done) v.step();
    expect(v.report().status).toBe("failed");
    expect(v.report().trials).toHaveLength(3);
    v.dispose();
    e.dispose();
  });
  it("재검증 일시정지는 World·기억을 유지하고 올바른 모드로 재개한다", () => {
    const e = finished();
    e.verifier = new PolicyVerification(
      e.robots[0].individual,
      1,
      cloneConfig(),
    );
    e.phase = "validating";
    e.start(true);
    expect(e.phase).toBe("validating");
    for (let i = 0; i < 10; i++) e.step();
    e.pause();
    const before = e.verifier.report(),
      memory = e.verifier.robots.map((r) => [...r.controller.memory]);
    for (let i = 0; i < 100; i++) e.step();
    expect(e.verifier.report()).toEqual(before);
    expect(e.verifier.robots.map((r) => [...r.controller.memory])).toEqual(
      memory,
    );
    e.start(true);
    expect(e.phase).toBe("validating");
    while (e.phase === "validating") e.step();
    expect(e.verification?.status).toBe("failed");
    expect(e.auto).toBe(true);
    e.dispose();
  });
  it.each([2, 3])(
    "합성 %s조건 합격 처리에서 모두 통과해야 자동 정지·우승 보존한다",
    (passCount) => {
      const e = finished();
      const v = new PolicyVerification(
        e.robots[0].individual,
        1,
        cloneConfig(),
      );
      for (const [i, r] of v.robots.entries()) {
        r.outcome = i < passCount ? "success" : "fallen";
        const view = i < passCount ? forwardView(r.view()) : r.view();
        r.view = () => view;
      }
      e.verifier = v;
      e.phase = "validating";
      e.auto = true;
      e.step();
      expect(e.verification?.status).toBe(
        passCount === 3 ? "passed" : "failed",
      );
      if (passCount === 3)
        expect(e.verifiedPolicy?.genes).toEqual(v.candidate.genes);
      else expect(e.verifiedPolicy).toBeNull();
      expect(e.auto).toBe(passCount !== 3);
      expect(e.phase).toBe("selection");
      e.dispose();
    },
  );
});

it("지속 지지 보상은 15초 균형을 짧은 세 발 이동 후 넘어짐보다 보존하고 안정 발 옮김은 더 높인다", () => {
  const stand = sample(15, "stepping"),
    fallen = sample(2.225, "stepping"),
    step = sample(15, "stepping");
  const standing = stand.score(0, [0, 0, 0, 0], 0, 15, "timeout");
  expect(fallen.score(0, [0, 1, 1, 1], 0, 3.3833, "fallen")).toBeLessThan(
    standing,
  );
  expect(step.score(0, [1, 0, 0, 0], 0, 15, "timeout")).toBeGreaterThan(
    standing,
  );
  expect(
    fallen.breakdown(0, [0, 1, 1, 1], 0, 3.3833, "fallen").penalty,
  ).toBeCloseTo(0.35, 10);
});
it("발 단계 지지·발 보상은 정상 지지 시간에 비례하고 공중 대기는 가점을 늘리지 않는다", () => {
  const half = sample(7.5, "stepping"),
    full = sample(15, "stepping");
  const h = half.breakdown(0, [2, 2, 2, 2], 0, 7.5),
    f = full.breakdown(0, [2, 2, 2, 2], 0, 15);
  expect(h.support * 2).toBeCloseTo(f.support, 10);
  expect(h.steps * 2).toBeCloseTo(f.steps, 10);
  const before = half.breakdown(0, [2, 2, 2, 2], 0, 7.5);
  for (let i = 0; i < 120; i++) half.observe({ ...ground, contacts: 0 });
  const after = half.breakdown(0, [2, 2, 2, 2], 0, 8.5);
  expect(after.support).toBe(before.support);
  expect(after.steps).toBe(before.steps);
  expect(after.total).toBeLessThan(before.total);
});

it("관절 끝에 기대어 15초 생존해도 가동 여유가 없으면 새 균형 단계에서 승급하지 않는다", () => {
  const e = finished(),
    r = structuredClone(e.robots[0].view()),
    cfg = cloneConfig();
  Object.assign(r, { outcome: "timeout", elapsed: 15 });
  Object.assign(r.frame.gait, {
    supportTime: 15,
    longestSupport: 15,
    longestMobileSupport: 0.4,
    jumping: false,
  });
  expect(
    meetsStage(r, "balance", { ...cfg, rewardModel: "rhythmic-curriculum-v7" }),
  ).toBe(true);
  expect(meetsStage(r, "balance", cfg)).toBe(false);
  r.frame.gait.longestMobileSupport = 2;
  r.frame.gait.mobileSupportTime = 12;
  r.frame.gait.jointFreedom = 1;
  expect(meetsStage(r, "balance", cfg)).toBe(true);
  r.elapsed = 14.99;
  expect(meetsStage(r, "balance", cfg)).toBe(false);
  e.dispose();
});

it("네 발을 잠깐 옮긴 뒤 멈추거나 짧은 전진만 합산한 정책은 최종 보행으로 통과하지 않는다", () => {
  const e = finished(),
    r = forwardView(e.robots[0].view()),
    config = cloneConfig();
  expect(meetsStage(r, "forward", config)).toBe(true);
  r.frame.gait.walking = false;
  expect(meetsStage(r, "forward", config)).toBe(false);
  r.frame.gait.walking = true;
  r.frame.gait.longestWalking = 4.99;
  expect(meetsStage(r, "forward", config)).toBe(false);
  r.frame.gait.longestWalking = 5;
  r.frame.gait.steps[3] = 0;
  expect(meetsStage(r, "forward", config)).toBe(false);
  e.dispose();
});

it("체중 이동의 작은 왕복과 경로 이탈을 구분하되 큰 옆 이동·방향 이탈은 탈락시킨다", () => {
  const e = finished(),
    r = forwardView(e.robots[0].view()),
    cfg = cloneConfig();
  // Evaluation fixture, not a learned gait: 20 mm sinusoidal body sway can have
  // more than 0.3 m cumulative sideways motion while remaining on the course.
  r.frame.gait.lateralTravel = 0.9;
  r.frame.gait.yawTravel = 2;
  r.frame.gait.lateralDeviation = 0.02;
  r.frame.gait.headingDeviation = 0.05;
  expect(meetsStage(r, "forward", cfg)).toBe(true);
  expect(
    meetsStage(r, "forward", {
      ...cfg,
      curriculum: { ...cfg.curriculum, useDriftLimits: false },
    }),
  ).toBe(false);
  r.frame.gait.lateralDeviation = 0.201;
  expect(meetsStage(r, "forward", cfg)).toBe(false);
  r.frame.gait.lateralDeviation = 0.02;
  r.frame.gait.headingDeviation = 0.351;
  expect(meetsStage(r, "forward", cfg)).toBe(false);
  e.dispose();
});

it("새 균형 승급은 잠깐의 가동 여유 뒤 관절 끝에 굳는 개체를 계속 균형 단계에 둔다", () => {
  const e = finished(),
    r = e.robots[0].view(),
    cfg = cloneConfig();
  r.elapsed = 15;
  r.outcome = "timeout";
  Object.assign(r.frame.gait, {
    jumping: false,
    supportTime: 15,
    longestSupport: 15,
    mobileSupportTime: 2,
    longestMobileSupport: 2,
    jointFreedom: 1,
  });
  expect(meetsStage(r, "balance", cfg)).toBe(false);
  r.frame.gait.mobileSupportTime = 12;
  r.frame.gait.jointFreedom = 0.79;
  expect(meetsStage(r, "balance", cfg)).toBe(false);
  r.frame.gait.jointFreedom = 0.8;
  expect(meetsStage(r, "balance", cfg)).toBe(true);
  e.dispose();
});

it("새 보행 목표는 짧은 네발 동시 체공도 제한하고 이전 파일의 기준은 보존한다", () => {
  const e = finished(),
    c = cloneConfig(),
    r = forwardView(e.robots[0].view());
  r.frame.gait.longestFlight = 0.08;
  r.frame.gait.airTime = 0.08;
  expect(meetsStage(r, "forward", c)).toBe(false);
  expect(
    meetsStage(r, "forward", {
      ...c,
      curriculum: { ...c.curriculum, maxWalkingFlightTime: 0.5 },
    }),
  ).toBe(true);
  r.frame.gait.longestFlight = 0.01;
  r.frame.gait.airTime = 0.01;
  expect(meetsStage(r, "forward", c)).toBe(true);
  const old = e.checkpoint() as any;
  delete old.config.curriculum.maxWalkingFlightTime;
  delete old.config.evaluation.contactModel;
  expect(
    parseCheckpoint(JSON.stringify(old)).config.evaluation.contactModel,
  ).toBe("proximity");
  expect(
    parseCheckpoint(JSON.stringify(e.checkpoint())).config.evaluation
      .contactModel,
  ).toBe("load-bearing");
  expect(
    parseCheckpoint(JSON.stringify(old)).config.curriculum.maxWalkingFlightTime,
  ).toBe(0.5);
  expect(
    parseCheckpoint(JSON.stringify(e.checkpoint())).config.curriculum
      .maxWalkingFlightTime,
  ).toBe(0.02);
  e.dispose();
});
