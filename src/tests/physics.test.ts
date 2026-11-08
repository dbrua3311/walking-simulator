import { describe, it, expect } from "vitest";
import { RAPIER } from "../physics/engine";
import { Robot } from "../physics/robot";
import { cloneConfig } from "../simulation/config";
import { Random, randomGenes, RANGES } from "../genetics/evolution";
import { axisRotation, signedAngle } from "../physics/math";
import { FootCycle, walkingGate, footSupport } from "../physics/gait";
const robot = () =>
  new Robot(
    {
      id: 1,
      genes: randomGenes(new Random(2026)),
      champion: false,
      parents: [],
    },
    cloneConfig(),
  );
describe("3D 강체와 12관절", () => {
  it("자유 낙하가 중력 해석값을 따른다", () => {
    const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    w.timestep = 1 / 120;
    const b = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0),
    );
    w.createCollider(RAPIER.ColliderDesc.ball(0.1), b);
    for (let i = 0; i < 60; i++) w.step();
    expect(Math.abs(b.translation().y - (10 - 0.5 * 9.81 * 0.25))).toBeLessThan(
      0.03,
    );
    w.free();
  });
  it("몸통·어깨 링크·상하 다리 13강체, 12구동 관절을 갖는다", () => {
    const r = robot();
    expect(r.bodies).toHaveLength(13);
    expect(r.joints).toHaveLength(12);
    expect(r.feet).toHaveLength(4);
    expect(new Set(r.feet.map((f) => Math.sign(f.translation().z))).size).toBe(
      2,
    );
    r.dispose();
  });
  it("실제 모터가 관절을 움직이고 바닥 접촉을 계산한다", () => {
    const r = robot(),
      before = r.frame().angles;
    for (let i = 0; i < 120; i++) r.step();
    expect(r.frame().angles).not.toEqual(before);
    expect(
      r.frame().bodies.every((b) => Object.values(b.q).every(Number.isFinite)),
    ).toBe(true);
    expect(r.trajectory.some((f) => f.feet.some((foot) => foot.contact))).toBe(
      true,
    );
    expect(r.joints.every((j) => Math.abs(j.torque) <= 18 + 1e-8)).toBe(true);
    r.dispose();
  });
  it("종료된 개체의 3D 자세와 속도를 유지한다", () => {
    const r = robot();
    while (r.outcome === "active") r.step();
    const before = r.view();
    for (let i = 0; i < 100; i++) r.step();
    expect(r.view()).toEqual(before);
    r.dispose();
  });
  it("좌우로 기울어진 몸통도 넘어짐으로 처리한다", () => {
    const r = robot();
    r.world.step = () => {};
    r.torso.setRotation(axisRotation({ x: 1, y: 0, z: 0 }, 1.2), true);
    for (let i = 0; i < 50; i++) r.step();
    expect(r.outcome).toBe("fallen");
    expect(r.distance).toBe(0);
    r.dispose();
  });
  it("solver 예외에서 마지막 유한 3D 자세를 보존한다", () => {
    const r = robot(),
      before = r.frame();
    r.world.step = () => {
      throw new Error("test");
    };
    r.step();
    expect(r.outcome).toBe("invalid");
    expect(r.frame().bodies).toEqual(before.bodies);
    r.dispose();
  });
});
describe("끌기와 걷기 구분", () => {
  const base = {
    height: 0.34,
    tilt: 0.1,
    contacts: 3,
    slip: 0.02,
    limbContact: false,
    lastSteps: [100, 120, 140, 160],
    tick: 200,
    dt: 1 / 120,
    minHeight: 0.24,
    stepMemory: 3,
  };
  it("정상 발걸음·높이·지지·낮은 미끄러짐만 통과한다", () => {
    expect(walkingGate(base)).toBe(true);
  });
  it.each(["drag", "low", "slip", "limb", "one-foot", "old-step"])(
    "%s 편법을 인정하지 않는다",
    (kind) => {
      const p = structuredClone(base);
      if (kind === "drag")
        p.lastSteps = [-Infinity, -Infinity, -Infinity, -Infinity];
      if (kind === "low") p.height = 0.15;
      if (kind === "slip") p.slip = 1;
      if (kind === "limb") p.limbContact = true;
      if (kind === "one-foot") p.contacts = 1;
      if (kind === "old-step") p.lastSteps[0] = -1000;
      expect(walkingGate(p)).toBe(false);
    },
  );
  it("접지한 채 앞뒤로 끄는 발은 걸음으로 세지 않는다", () => {
    const f = new FootCycle();
    for (let i = 0; i < 100; i++)
      f.update(i, 1 / 120, { x: i * 0.002, y: 0, z: 0 }, true, 0);
    expect(f.steps).toBe(0);
  });
  it("실제로 공중에 들었다가 앞쪽에 착지한 발을 센다", () => {
    const f = new FootCycle();
    f.update(0, 1 / 120, { x: -0.05, y: 0, z: 0 }, true, 0);
    for (let i = 1; i < 31; i++)
      f.update(
        i,
        1 / 120,
        { x: -0.05 + i * 0.003, y: 0.06 * Math.sin((Math.PI * i) / 31), z: 0 },
        false,
        0,
      );
    f.update(32, 1 / 120, { x: 0.05, y: 0, z: 0 }, true, 0);
    expect(f.steps).toBe(1);
  });
});

describe("관절 직접 토크", () => {
  it.each([0, 1, 2])("축 %s에 출력한 토크가 실제 관절을 움직인다", (index) => {
    const r = robot();
    r.world.gravity = { x: 0, y: 0, z: 0 };
    for (const b of r.bodies) {
      const p = b.translation();
      b.setTranslation({ ...p, y: p.y + 2 }, true);
    }
    const a = r.joints[index],
      start = signedAngle(a.parent.rotation(), a.child.rotation(), a.axis);
    r.controller.step = () =>
      Array.from({ length: 12 }, (_, i) => (i === index ? 0.001 : 0));
    for (let i = 0; i < 5; i++) r.step();
    const actual = signedAngle(a.parent.rotation(), a.child.rotation(), a.axis);
    expect(actual - start).toBeGreaterThan(1e-6);
    expect(a.torque).toBeCloseTo(0.018, 10);
    r.dispose();
  });
  it("모든 구동 토크는 부모와 자식에 반대 방향으로 적용된다", () => {
    const r = robot();
    let total = { x: 0, y: 0, z: 0 };
    const step = r.world.step.bind(r.world);
    r.world.step = () => {
      total = r.bodies.reduce(
        (sum, b) => {
          const t = b.userTorque();
          return { x: sum.x + t.x, y: sum.y + t.y, z: sum.z + t.z };
        },
        { x: 0, y: 0, z: 0 },
      );
      step();
    };
    r.step();
    expect(Math.hypot(total.x, total.y, total.z)).toBeLessThan(1e-6);
    r.dispose();
  });
});
it("모든 개체의 조립 자세는 같고 이후 무작위 유전자에 따라 실제 움직임이 갈라진다", () => {
  const a = robot(),
    b = new Robot(
      {
        id: 2,
        genes: randomGenes(new Random(2027)),
        champion: false,
        parents: [],
      },
      cloneConfig(),
    );
  expect(a.frame().bodies).toEqual(b.frame().bodies);
  for (let i = 0; i < 12; i++) {
    a.step();
    b.step();
  }
  expect(a.frame().angles).not.toEqual(b.frame().angles);
  expect(a.controller.memory).not.toEqual(b.controller.memory);
  a.dispose();
  b.dispose();
});
it("0출력 신경망에는 숨겨진 보행·균형 제어가 없고 중력으로 무너진다", () => {
  const genes = RANGES.map(([lo, hi]) => (lo > 0 ? (lo + hi) / 2 : 0)),
    r = new Robot(
      { id: 1, genes, champion: false, parents: [] },
      cloneConfig(),
    ),
    start = r.torso.translation().y;
  while (r.outcome === "active") r.step();
  expect(r.joints.every((a) => a.torque === 0)).toBe(true);
  expect(r.energy).toBe(0);
  expect(r.torso.translation().y).toBeLessThan(start);
  expect(r.distance).toBe(0);
  r.dispose();
});

it("실제 강체가 전부 공중으로 튀면 점프 종료하며 착지를 걸음으로 만들지 않는다", () => {
  const r = robot();
  r.controller.step = () => Array(12).fill(0);
  for (let i = 0; i < 10; i++) r.step();
  expect(r.frame().feet.some((f) => f.contact)).toBe(true);
  for (const body of r.bodies) body.setLinvel({ x: 0.5, y: 3, z: 0 }, true);
  while (r.outcome === "active") r.step();
  expect(r.outcome).toBe("jumped");
  expect(r.frame().gait.jumping).toBe(true);
  expect(r.frame().gait.steps).toEqual([0, 0, 0, 0]);
  expect(r.distance).toBe(0);
  expect(r.fitness).toBeLessThan(0);
  r.dispose();
});

it("낮게 웅크린 상태가 지속되면 몸통 충돌 없이도 넘어짐으로 종료한다", () => {
  const r = robot();
  r.world.step = () => {};
  r.torso.setTranslation({ x: 0, y: 0.2, z: 0 }, true);
  for (let i = 0; i < 60; i++) r.step();
  expect(r.outcome).toBe("fallen");
  expect(r.distance).toBe(0);
  expect(r.fitness).toBeLessThan(0);
  r.dispose();
});
it("짧은 몸통 높이 이탈 후 회복하면 즉시 실패시키지 않는다", () => {
  const r = robot(),
    original = { ...r.torso.translation() };
  r.world.step = () => {};
  r.torso.setTranslation({ ...original, y: 0.2 }, true);
  for (let i = 0; i < 5; i++) r.step();
  r.torso.setTranslation(original, true);
  for (let i = 0; i < 50; i++) r.step();
  expect(r.outcome).toBe("active");
  r.dispose();
});

it("시간 입력에 따라 실제 12관절 구동 토크를 매 tick 다시 계산한다", () => {
  const r = robot();
  r.step();
  const initial = r.frame().torques!;
  for (let i = 0; i < 20; i++) r.step();
  expect(r.frame().torques).toEqual(r.joints.map((j) => j.torque));
  expect(r.frame().torques).not.toEqual(initial);
  expect(r.controller.elapsed).toBeCloseTo(r.tick / 120, 10);
  r.dispose();
});
it("새 균형·발 단계는 15초 평가하고 최종 전진과 구 발 단계의 정체 조건은 보존한다", () => {
  // Frozen solver is a termination-logic fixture, not learned standing evidence.
  const config = cloneConfig(),
    individual = {
      id: 1,
      genes: randomGenes(new Random(2026)),
      champion: false,
      parents: [],
    };
  const balance = new Robot(individual, config, "balance"),
    forward = new Robot(individual, config, "forward"),
    stepping = new Robot(individual, config, "stepping"),
    legacy = new Robot(
      individual,
      { ...config, rewardModel: "temporal-curriculum-v4" },
      "stepping",
    );
  for (const r of [balance, forward, stepping, legacy]) {
    r.world.step = () => {};
    r.controller.step = () => Array(12).fill(0);
    while (r.outcome === "active") r.step();
  }
  expect(balance.outcome).toBe("timeout");
  expect(balance.tick).toBe(1800);
  expect(forward.outcome).toBe("stalled");
  expect(forward.tick / 120).toBeCloseTo(7, 10);
  expect(stepping.outcome).toBe("timeout");
  expect(stepping.tick).toBe(1800);
  expect(legacy.outcome).toBe("stalled");
  expect(legacy.tick).toBe(840);
  balance.dispose();
  forward.dispose();
  stepping.dispose();
  legacy.dispose();
});

it("체중 이동·재착지 평가를 켜도 같은 유전자의 실제 자세·토크·접촉은 바뀌지 않는다", () => {
  const genes = randomGenes(new Random(43)),
    individual = { id: 1, genes, champion: false, parents: [] };
  const old = new Robot(
    individual,
    { ...cloneConfig(), rewardModel: "supported-curriculum-v5" },
    "stepping",
  );
  const next = new Robot(
    structuredClone(individual),
    cloneConfig(),
    "stepping",
  );
  for (let i = 0; i < 240; i++) {
    old.step();
    next.step();
    const a = old.frame(),
      b = next.frame();
    delete b.gait.footProgress;
    delete b.gait.weightShift;
    delete b.gait.stepActivity;
    delete b.gait.jointFreedom;
    delete b.gait.mobileSupportTime;
    delete b.gait.longestMobileSupport;
    delete b.gait.stopEffortTime;
    expect(b).toEqual(a);
  }
  old.dispose();
  next.dispose();
});

it("하중 없는 근접 발은 지지가 아니며 두 발의 실제 지지를 구분한다", () => {
  const weight = (6 * 9.81) / 120;
  const pair = footSupport(
    [weight / 2, weight / 2, 0, 0],
    [0, 0, 2, 2],
    weight,
  );
  expect(pair.contacts).toEqual([true, true, false, false]);
  expect(pair.slip).toBe(0);
  const one = footSupport([weight, 0, 0, 0], [0, 2, 2, 2], weight);
  expect(one.contacts.filter(Boolean)).toHaveLength(1);
  expect(
    footSupport([0, 0, 0, 0], [2, 2, 2, 2], weight).contacts.some(Boolean),
  ).toBe(false);
});
it("구형 발의 순수 굴림은 발 중심 이동과 실제 접촉점 미끄러짐을 구분한다", () => {
  const w = new RAPIER.World({ x: 0, y: 0, z: 0 }),
    radius = 0.025;
  const b = w.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, radius, 0),
  );
  w.createCollider(RAPIER.ColliderDesc.ball(radius).setMass(1), b);
  b.setLinvel({ x: 0.4, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: -0.4 / radius }, true);
  const v = b.velocityAtPoint({ x: 0, y: 0, z: 0 }),
    measured = footSupport(
      [1, 1],
      [Math.hypot(v.x, v.z), Math.hypot(v.x, v.z)],
      2,
    );
  expect(b.linvel().x).toBeGreaterThan(0.3);
  expect(measured.slip).toBeLessThan(1e-6);
  w.free();
});
it("실제 하중을 받은 발이 미끄러지면 여전히 보행을 거절한다", () => {
  const weight = (6 * 9.81) / 120;
  const slip = footSupport(
    [weight / 2, weight / 2, 0, 0],
    [0.7, 0.7, 0, 0],
    weight,
  );
  expect(
    walkingGate({
      height: 0.34,
      tilt: 0.1,
      contacts: slip.contacts.filter(Boolean).length,
      slip: slip.slip,
      limbContact: false,
      lastSteps: [100, 120, 140, 160],
      tick: 200,
      dt: 1 / 120,
      minHeight: 0.24,
      stepMemory: 3,
    }),
  ).toBe(false);
});
