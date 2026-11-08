import { describe, it, expect } from "vitest";
import { WalkingAssessment, type MotionSample } from "../physics/assessment";
import { FootCycle, walkingGate, supportReadiness } from "../physics/gait";
import { cloneConfig } from "../simulation/config";
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
function track(samples: MotionSample[]) {
  const a = new WalkingAssessment(cloneConfig());
  samples.forEach((s) => a.observe(s));
  return a;
}
describe("점프 악용 방지", () => {
  it("공중 수평 이동과 긴 체공은 접지 전진·생존 보상을 얻지 않는다", () => {
    const a = track([
      ground,
      ...Array.from({ length: 30 }, (_, i) => ({
        ...ground,
        contacts: 0,
        x: (i + 1) * 0.02,
        dx: 0.02,
        verticalSpeed: 1,
        height: 0.6,
      })),
    ]);
    expect(a.jump).toBe(true);
    expect(a.groundedForward).toBe(0);
    expect(a.airTime).toBeCloseTo(0.25, 8);
    expect(a.score(0, [0, 0, 0, 0], 0, 0.26)).toBeLessThan(0);
  });
  it("네 발 동시 점프 후 착지는 네 걸음으로 세지 않는다", () => {
    const feet = Array.from({ length: 4 }, () => new FootCycle());
    feet.forEach((f) =>
      f.update(0, 1 / 120, { x: 0, y: 0, z: 0 }, true, 0, true),
    );
    for (let tick = 1; tick <= 30; tick++)
      feet.forEach((f) =>
        f.update(
          tick,
          1 / 120,
          { x: tick * 0.003, y: 0.08 * Math.sin((Math.PI * tick) / 31), z: 0 },
          false,
          0,
          false,
        ),
      );
    feet.forEach((f) =>
      f.update(31, 1 / 120, { x: 0.1, y: 0, z: 0 }, true, 0, true),
    );
    expect(feet.map((f) => f.steps)).toEqual([0, 0, 0, 0]);
  });
  it("초기 공중 배치에서 처음 떨어져 착지한 발도 걸음으로 세지 않는다", () => {
    const f = new FootCycle();
    for (let i = 0; i < 20; i++)
      f.update(i, 1 / 120, { x: i * 0.003, y: 0.06, z: 0 }, false, 0, true);
    f.update(20, 1 / 120, { x: 0.1, y: 0, z: 0 }, true, 0, true);
    expect(f.steps).toBe(0);
  });
  it("짧은 접촉 손실은 점프 종료가 아니지만 높은 몸통·수직 충격은 보행 판정을 막는다", () => {
    const a = track([
      ground,
      ...Array.from({ length: 5 }, () => ({ ...ground, contacts: 0 })),
      ground,
    ]);
    expect(a.jump).toBe(false);
    const base = {
      height: 0.4,
      tilt: 0,
      contacts: 3,
      slip: 0,
      limbContact: false,
      lastSteps: [100, 100, 100, 100],
      tick: 120,
      dt: 1 / 120,
      minHeight: 0.24,
      stepMemory: 3,
      maxHeight: 0.64,
      maxVerticalSpeed: 0.5,
    };
    expect(walkingGate({ ...base, verticalSpeed: 1 })).toBe(false);
    expect(walkingGate({ ...base, height: 0.8 })).toBe(false);
    expect(walkingGate({ ...base, jumping: true })).toBe(false);
    expect(walkingGate({ ...base, verticalSpeed: 0.1 })).toBe(true);
  });
  it("실제 접지 전진과 발 옮김은 가만히 서기·점프·옆걸음보다 높은 점수를 받는다", () => {
    const stand = track(Array.from({ length: 240 }, () => ground));
    const walk = track(
      Array.from({ length: 240 }, (_, i) => ({
        ...ground,
        x: (i + 1) * 0.002,
        dx: 0.002,
        contacts: i % 2 ? 2 : 3,
      })),
    );
    const jump = track([
      ground,
      ...Array.from({ length: 240 }, (_, i) => ({
        ...ground,
        contacts: 0,
        verticalSpeed: 1,
        x: (i + 1) * 0.003,
        dx: 0.003,
      })),
    ]);
    const side = track(
      Array.from({ length: 240 }, () => ({ ...ground, dz: 0.002 })),
    );
    expect(walk.score(0.3, [2, 2, 2, 2], 20, 2)).toBeGreaterThan(
      stand.score(0, [0, 0, 0, 0], 0, 2),
    );
    expect(walk.score(0.3, [2, 2, 2, 2], 20, 2)).toBeGreaterThan(
      jump.score(0, [0, 0, 0, 0], 0, 2),
    );
    expect(side.score(0, [0, 0, 0, 0], 0, 2)).toBeLessThan(
      stand.score(0, [0, 0, 0, 0], 0, 2),
    );
  });
  it("뒤로 흔들어 제자리로 돌아오는 동작은 전진 보상을 저축하지 못한다", () => {
    const a = track([
      ...Array.from({ length: 60 }, (_, i) => ({
        ...ground,
        x: (i + 1) * 0.002,
        dx: 0.002,
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        ...ground,
        contacts: 0,
        x: 0.12 - (i + 1) * 0.002,
        dx: -0.002,
      })),
    ]);
    expect(a.groundedForward).toBeLessThan(1e-10);
  });
});

describe("안정적으로 마친 발 이동의 중간 보상", () => {
  function swing(
    options: {
      height?: number;
      dx?: number;
      eligible?: boolean;
      initial?: boolean;
    } = {},
  ) {
    const f = new FootCycle(),
      dt = 1 / 120;
    if (!options.initial) f.update(0, dt, { x: 0, y: 0, z: 0 }, true, 0);
    for (let t = 1; t <= 12; t++)
      f.update(
        t,
        dt,
        {
          x: ((options.dx ?? 0.01) * (t - 1)) / 11,
          y: options.height ?? 0.02,
          z: 0,
        },
        false,
        0,
        options.eligible ?? true,
      );
    return f;
  }
  function land(f: FootCycle, dx = 0.01, stable = true, ticks = 18) {
    for (let t = 13; t < 13 + ticks; t++)
      f.update(t, 1 / 120, { x: dx, y: 0, z: 0 }, true, 0, true, stable);
  }
  it("발을 든 채 정지하면 0, 재착지와 안정 지지 후에만 진행 점수가 생긴다", () => {
    const f = swing();
    expect(f.completedProgress).toBe(0);
    land(f, 0.01, true, 17);
    expect(f.completedProgress).toBe(0);
    f.update(30, 1 / 120, { x: 0.01, y: 0, z: 0 }, true, 0, true, true);
    expect(f.completedProgress).toBeCloseTo((0.02 / 0.035) * (0.01 / 0.018));
    expect(f.steps).toBe(0);
  });
  it.each([
    { height: 0 },
    { dx: -0.01 },
    { eligible: false },
    { initial: true },
  ])("바닥 끌기·후진·점프·초기 낙하 %j는 진행 0", (options) => {
    const f = swing(options);
    land(f, options.dx ?? 0.01);
    expect(f.completedProgress).toBe(0);
    expect(f.steps).toBe(0);
  });
  it("착지 직후 불안정해지면 중간 점수가 생기지 않는다", () => {
    const f = swing();
    land(f, 0.01, false);
    land(f);
    expect(f.completedProgress).toBe(0);
  });
  it("기존 높이·앞 이동·시간 기준을 충족하면 실제 걸음은 그대로 인정한다", () => {
    const f = swing({ height: 0.04, dx: 0.025 });
    land(f, 0.025);
    expect(f.steps).toBe(1);
    expect(f.completedProgress).toBe(0);
  });
  it("중간 보상은 실제 첫걸음보다 작고 구 보상·균형 단계·최종 기준에는 섞이지 않는다", () => {
    const make = (
      model: ReturnType<typeof cloneConfig>["rewardModel"],
      stage: "balance" | "stepping" | "forward",
    ) => {
      const a = new WalkingAssessment(
        { ...cloneConfig(), rewardModel: model },
        stage,
      );
      for (let i = 0; i < 1800; i++) a.observe(ground);
      return a;
    };
    const a = make("cycle-curriculum-v6", "stepping");
    const partial = a.breakdown(
      0,
      [0, 0, 0, 0],
      0,
      15,
      "timeout",
      [1, 0, 0, 0],
    );
    const full = a.breakdown(0, [1, 0, 0, 0], 0, 15, "timeout", [0, 0, 0, 0]);
    expect(partial.steps).toBeCloseTo(0.045);
    expect(full.steps).toBeCloseTo(0.12);
    for (const model of [
      "temporal-curriculum-v4",
      "supported-curriculum-v5",
    ] as const) {
      const old = make(model, "stepping");
      expect(
        old.breakdown(0, [0, 0, 0, 0], 0, 15, "timeout", [1, 1, 1, 1]).steps,
      ).toBe(0);
    }
    for (const stage of ["balance", "forward"] as const)
      expect(
        make("cycle-curriculum-v6", stage).breakdown(
          0,
          [0, 0, 0, 0],
          0,
          15,
          "timeout",
          [1, 1, 1, 1],
        ).steps,
      ).toBe(0);
    expect(
      a.breakdown(0, [0, 0, 0, 0], 0, 15, "fallen", [1, 1, 1, 1]).total,
    ).toBeLessThan(a.breakdown(0, [0, 0, 0, 0], 0, 15, "timeout").total);
  });
});

it("세 발 지지 영역의 실제 무게중심 여유를 평가하며 경계·바깥·퇴화한 영역은 0이다", () => {
  const feet = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
  expect(supportReadiness({ x: 0.2, y: 0.4, z: 0.2 }, feet)).toBe(1);
  expect(
    supportReadiness({ x: 0.2, y: 0.4, z: 0.2 }, [...feet].reverse()),
  ).toBe(1);
  expect(supportReadiness({ x: 0.5, y: 0.4, z: 0.5 }, feet)).toBe(0);
  expect(supportReadiness({ x: 0.7, y: 0.4, z: 0.7 }, feet)).toBe(0);
  expect(supportReadiness({ x: 0.2, y: 0.4, z: 0.2 }, feet.slice(0, 2))).toBe(
    0,
  );
  expect(
    supportReadiness({ x: 0.2, y: 0.4, z: 0.2 }, [feet[0], feet[0], feet[2]]),
  ).toBe(0);
  const a = new WalkingAssessment(cloneConfig(), "stepping");
  for (let i = 0; i < 1800; i++) a.observe(ground);
  const shift = a.breakdown(
    0,
    [0, 0, 0, 0],
    0,
    15,
    "timeout",
    [],
    [1, 1, 1, 1],
  );
  expect(shift.steps).toBeCloseTo(0.024);
  expect(shift.steps).toBeLessThan(
    a.breakdown(0, [1, 0, 0, 0], 0, 15, "timeout").steps,
  );
});

// Synthetic event streams validate the reward function; these are not learned robots.
function footExercise(cycles: number, height = 0.04, dx = 0.03) {
  const f = new FootCycle();
  let landedX = 0;
  for (let tick = 0; tick < 1800; tick++) {
    const period = Math.floor(tick / 60),
      phase = tick % 60,
      air = period < cycles && phase >= 48;
    if (!air && phase === 0 && period > 0 && period <= cycles) landedX += dx;
    const x = air ? landedX + (dx * (phase - 48)) / 11 : landedX;
    f.update(
      tick,
      1 / 120,
      { x, y: air ? height : 0, z: 0 },
      !air,
      0,
      true,
      true,
    );
  }
  return f;
}
it("처음 두 걸음 후 정지와 계속 반복하는 걸음을 새 보상이 구별한다", () => {
  const short = footExercise(2),
    repeat = footExercise(29);
  const points = (
    model: ReturnType<typeof cloneConfig>["rewardModel"],
    f: FootCycle,
  ) => {
    const a = new WalkingAssessment(
      { ...cloneConfig(), rewardModel: model },
      "stepping",
    );
    for (let i = 0; i < 1800; i++) a.observe(ground);
    expect(a.walkingTime).toBe(0);
    return a.breakdown(
      0,
      [f.steps, 0, 0, 0],
      0,
      15,
      "timeout",
      [],
      [],
      [f.stepActivity / 15, 0, 0, 0],
    ).steps;
  };
  expect(short.steps).toBe(2);
  expect(repeat.steps).toBeGreaterThan(20);
  expect(points("cycle-curriculum-v6", short)).toBeCloseTo(
    points("cycle-curriculum-v6", repeat),
  );
  expect(points("rhythmic-curriculum-v7", repeat)).toBeGreaterThan(
    points("rhythmic-curriculum-v7", short) + 0.04,
  );
});
it("미완성된 작은 발 이동도 한 번 후 정지보다 안정적으로 반복할 때 더 유리하다", () => {
  const once = footExercise(1, 0.02, 0.01),
    repeat = footExercise(29, 0.02, 0.01);
  expect(once.steps).toBe(0);
  expect(repeat.steps).toBe(0);
  expect(once.completedProgress).toBeCloseTo(repeat.completedProgress);
  expect(repeat.trainingProgress(15)).toBeGreaterThan(
    once.trainingProgress(15),
  );
  const hover = new FootCycle();
  hover.update(0, 1 / 120, { x: 0, y: 0, z: 0 }, true, 0);
  for (let t = 1; t < 1800; t++)
    hover.update(t, 1 / 120, { x: 0.1, y: 0.04, z: 0 }, false, 0);
  expect(hover.trainingProgress(15)).toBe(0);
  expect(hover.stepActivity).toBe(0);
});

it("관절 가동 여유가 있는 접지 자세가 끝단 고정 자세보다 높은 균형 점수를 받는다", () => {
  const cfg = cloneConfig(),
    mobile = new WalkingAssessment(cfg),
    braced = new WalkingAssessment(cfg),
    old = new WalkingAssessment({
      ...cfg,
      rewardModel: "rhythmic-curriculum-v7",
    });
  for (let i = 0; i < 1800; i++) {
    mobile.observe({
      ...ground,
      jointFreedom: 1,
      freeJoints: 12,
      stopEffort: 0,
    });
    const low = {
      ...ground,
      height: 0.266,
      jointFreedom: 0.42,
      freeJoints: 5,
      stopEffort: 0.05,
    };
    braced.observe(low);
    old.observe(low);
  }
  expect(mobile.longestMobileSupport).toBeCloseTo(15, 8);
  expect(braced.longestMobileSupport).toBe(0);
  expect(old.score(0, [0, 0, 0, 0], 0, 15, "timeout")).toBeGreaterThan(0.7);
  expect(mobile.score(0, [0, 0, 0, 0], 0, 15, "timeout")).toBeGreaterThan(
    braced.score(0, [0, 0, 0, 0], 0, 15, "timeout") + 0.8,
  );
  expect(braced.stopEffortTime).toBeCloseTo(0.75, 8);
});

it("관절 가동 여유 보상에도 공중·끌림·점프 자세는 시간을 적립하지 않는다", () => {
  for (const invalid of [
    { contacts: 0 },
    { limbContact: true },
    { height: 0.8 },
  ]) {
    const a = new WalkingAssessment(cloneConfig());
    a.observe(ground);
    for (let i = 0; i < 120; i++)
      a.observe({ ...ground, jointFreedom: 1, freeJoints: 12, ...invalid });
    expect(a.mobileSupportTime).toBeCloseTo(1 / 120, 10);
  }
});

it("연속 보행의 짧은 접촉 전환은 구간을 유지하되 빈 시간을 보행량으로 더하지 않는다", () => {
  const config = cloneConfig(),
    a = new WalkingAssessment(config);
  for (let i = 0; i < 120; i++) a.observeWalking(true, 0.1);
  for (let i = 0; i < 6; i++) a.observeWalking(false, 0);
  expect(a.walkingTime).toBeCloseTo(1, 10);
  expect(a.walkingRun).toBeCloseTo(1, 10);
  for (let i = 0; i < 120; i++) a.observeWalking(true, 0.1);
  expect(a.walkingTime).toBeCloseTo(2, 10);
  expect(a.longestWalking).toBeCloseTo(2, 10);
  for (let i = 0; i < 13; i++) a.observeWalking(false, 0);
  expect(a.walkingRun).toBe(0);
  expect(a.walkingTime).toBeCloseTo(2, 10);
  a.observeWalking(true, 0.1);
  a.jump = true;
  a.observeWalking(true, 0.1);
  expect(a.walkingRun).toBe(0);
  const legacy = new WalkingAssessment({
    ...config,
    evaluation: { ...config.evaluation, walkingContinuityGrace: 0 },
  });
  legacy.observeWalking(true, 0.1);
  legacy.observeWalking(false, 0);
  expect(legacy.walkingRun).toBe(0);
});
