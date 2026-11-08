import { LandingAssessment } from "./landing";
import { DIRECTION_SHARED_GENE_COUNT } from "../controllers/shared";
import { RAPIER } from "./engine";
import { NeuralController } from "../controllers/neural";
import { JOINT_LIMITS } from "../controllers/genome";
import { clamp } from "../genetics/evolution";
import {
  inverse,
  add,
  sub,
  mul,
  rotate,
  axisRotation,
  signedAngle,
  dot,
} from "./math";
import { meetsStage } from "../simulation/curriculum";
import { WalkingAssessment } from "./assessment";
import { FootCycle, walkingGate, supportReadiness, footSupport } from "./gait";
import type {
  Config,
  Frame,
  Individual,
  Outcome,
  RobotView,
  Vec,
  Quat,
  TrainingStage,
  ScoreBreakdown,
} from "../simulation/types";
import type {
  RigidBody,
  Collider,
  RevoluteImpulseJoint,
} from "@dimforge/rapier3d-compat";
const X = { x: 1, y: 0, z: 0 },
  Z = { x: 0, y: 0, z: 1 },
  IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
type Actuator = {
  joint: RevoluteImpulseJoint;
  parent: RigidBody;
  child: RigidBody;
  axis: Vec;
  torque: number;
  speed: number;
  angle: number;
};
export class Robot {
  readonly world: InstanceType<typeof RAPIER.World>;
  readonly bodies: RigidBody[] = [];
  readonly joints: Actuator[] = [];
  readonly feet: Collider[] = [];
  readonly limbColliders: Collider[] = [];
  readonly ground: Collider;
  readonly torso: RigidBody;
  tick = 0;
  distance = 0;
  reachedTick = 0;
  energy = 0;
  outcome: Outcome = "active";
  trajectory: Frame[] = [];
  tiltedTicks = 0;
  lowTicks = 0;
  lastProgressTick = 0;
  progressDistance = 0;
  maxForwardX = 0;
  validTicks = 0;
  limbTicks = 0;
  readonly landings = new LandingAssessment();
  private previousTilt = 0;
  cycles = Array.from({ length: 4 }, () => new FootCycle());
  private readonly weightShift = [0, 0, 0, 0];
  private readonly shiftRun = [0, 0, 0, 0];
  private readonly shiftTime = [0, 0, 0, 0];
  private readonly stopRuns = new Float64Array(12);
  readonly controller: NeuralController;
  readonly assessment: WalkingAssessment;
  private frozen: Frame | null = null;
  private savedFitness: number | undefined;
  private savedScore: ScoreBreakdown | undefined;
  private footImpulses: number[] = [];
  private footStates = Array.from({ length: 4 }, () => ({
    position: { x: 0, y: 0, z: 0 },
    contact: false,
    swing: false,
    clearance: 0,
  }));
  private gait = {
    rawDistance: 0,
    steps: [0, 0, 0, 0],
    contactCount: 0,
    slip: 0,
    walking: false,
    limbContact: false,
    uprightTime: 0,
    supportTime: 0,
    longestSupport: 0,
    walkingTime: 0,
    qualityWalkingTime: 0,
    longestWalking: 0,
    lateralTravel: 0,
    yawTravel: 0,
    groundedForward: 0,
    airTime: 0,
    longestFlight: 0,
    verticalMotion: 0,
    jumping: false,
  };
  constructor(
    readonly individual: Individual,
    readonly config: Config,
    readonly stage: TrainingStage = "balance",
    initialTilt?: { roll: number; pitch: number },
  ) {
    const c = config.robot,
      p = config.physics;
    this.controller = new NeuralController(
      individual.genes,
      config.controllerModel === "shared-anatomical",
    );
    this.assessment = new WalkingAssessment(config, stage);
    // Same neutral assembly pose for every genome. This is only the physical
    // starting placement; no controller holds or tracks these joint angles.
    const assembly = [0, -0.6, 1.2] as const;
    const spawnHeight =
      0.025 + c.footRadius + (c.upper + c.lower) * Math.cos(0.6) + 0.003;
    this.world = new RAPIER.World({ x: 0, y: p.gravity, z: 0 });
    this.world.timestep = p.dt;
    this.world.numSolverIterations = p.velocityIterations;
    this.world.numInternalPgsIterations = p.positionIterations;
    this.ground = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(500, 0.1, 500)
        .setTranslation(0, -0.1, 0)
        .setFriction(p.friction)
        .setRestitution(0)
        .setCollisionGroups(0x00010002),
    );
    const body = (
      position: Vec,
      q: Quat,
      shape: InstanceType<typeof RAPIER.ColliderDesc>,
      mass: number,
    ) => {
      const b = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(position.x, position.y, position.z)
          .setRotation(q)
          .setCanSleep(false)
          .setCcdEnabled(false),
      );
      const col = this.world.createCollider(
        shape
          .setMass(mass)
          .setFriction(p.friction)
          .setRestitution(0)
          .setCollisionGroups(0x00020001),
        b,
      );
      this.bodies.push(b);
      return { b, col };
    };
    const torso = body(
      { x: 0, y: spawnHeight, z: 0 },
      IDENTITY,
      RAPIER.ColliderDesc.cuboid(c.width / 2, c.height / 2, c.depth / 2),
      c.torsoMass,
    );
    this.torso = torso.b;
    this.limbColliders.push(torso.col);
    const joint = (
      a: RigidBody,
      b: RigidBody,
      anchorA: Vec,
      anchorB: Vec,
      axis: Vec,
      limits: [number, number],
    ) => {
      const j = this.world.createImpulseJoint(
        RAPIER.JointData.revolute(anchorA, anchorB, axis),
        a,
        b,
        true,
      ) as RevoluteImpulseJoint;
      j.setLimits(...limits);
      j.setContactsEnabled(false);
      // Passive viscous joint damping, with no angle target or posture spring.
      // The neural network still supplies every active motor torque.
      j.configureMotorModel(RAPIER.MotorModel.ForceBased);
      j.setMotorMaxForce(
        this.joints.length % 3 === 2 ? p.kneeTorque : p.hipTorque,
      );
      j.configureMotorVelocity(0, p.jointDamping);
      this.joints.push({
        joint: j,
        parent: a,
        child: b,
        axis,
        torque: 0,
        speed: 0,
        angle: 0,
      });
    };
    for (let leg = 0; leg < 4; leg++) {
      const side = leg % 2 === 0 ? 1 : -1,
        hipLocal = {
          x: (leg < 2 ? 1 : -1) * c.width * 0.4,
          y: -0.025,
          z: (side * c.depth) / 2,
        };
      const desired = assembly,
        qa = axisRotation(X, desired[0]),
        qh = mul(qa, axisRotation(Z, desired[1])),
        qk = mul(qh, axisRotation(Z, desired[2]));
      const hip = add(this.torso.translation(), hipLocal),
        end = add(hip, rotate(qa, { x: 0, y: 0, z: side * c.coxa }));
      const carrier = body(
        add(hip, rotate(qa, { x: 0, y: 0, z: (side * c.coxa) / 2 })),
        qa,
        RAPIER.ColliderDesc.cuboid(0.035, 0.035, c.coxa / 2),
        0.15,
      );
      const knee = add(end, rotate(qh, { x: 0, y: -c.upper, z: 0 }));
      const upper = body(
        add(end, rotate(qh, { x: 0, y: -c.upper / 2, z: 0 })),
        qh,
        RAPIER.ColliderDesc.cuboid(0.023, c.upper / 2, 0.022),
        c.upperMass,
      );
      const lower = body(
        add(knee, rotate(qk, { x: 0, y: -c.lower / 2, z: 0 })),
        qk,
        RAPIER.ColliderDesc.cuboid(0.014, c.lower / 2, 0.014),
        c.lowerMass * 0.8,
      );
      this.limbColliders.push(carrier.col, upper.col, lower.col);
      const foot = this.world.createCollider(
        RAPIER.ColliderDesc.ball(c.footRadius)
          .setTranslation(0, -c.lower / 2, 0)
          .setMass(c.lowerMass * 0.2)
          .setFriction(p.friction)
          .setCollisionGroups(0x00020001),
        lower.b,
      );
      this.feet.push(foot);
      joint(
        this.torso,
        carrier.b,
        hipLocal,
        { x: 0, y: 0, z: (-side * c.coxa) / 2 },
        X,
        JOINT_LIMITS[3 * leg],
      );
      joint(
        carrier.b,
        upper.b,
        { x: 0, y: 0, z: (side * c.coxa) / 2 },
        { x: 0, y: c.upper / 2, z: 0 },
        Z,
        JOINT_LIMITS[3 * leg + 1],
      );
      joint(
        upper.b,
        lower.b,
        { x: 0, y: -c.upper / 2, z: 0 },
        { x: 0, y: c.lower / 2, z: 0 },
        Z,
        JOINT_LIMITS[3 * leg + 2],
      );
    }
    if (initialTilt && (initialTilt.roll || initialTilt.pitch)) {
      const q = mul(
        axisRotation(X, initialTilt.roll),
        axisRotation(Z, initialTilt.pitch),
      );
      const origin = { ...this.torso.translation() };
      this.bodies.forEach((b) => {
        b.setTranslation(
          add(origin, rotate(q, sub(b.translation(), origin))),
          true,
        );
        b.setRotation(mul(q, b.rotation()), true);
      });
      // Collider positions are propagated by the world before reading foot heights.
      this.world.propagateModifiedBodyPositionsToColliders();
      const lift = Math.max(
        0,
        c.footRadius +
          0.003 -
          Math.min(...this.feet.map((f) => f.translation().y)),
      );
      this.bodies.forEach((b) =>
        b.setTranslation(add(b.translation(), { x: 0, y: lift, z: 0 }), true),
      );
      this.world.propagateModifiedBodyPositionsToColliders();
    }
    this.refreshActuators();
    this.refreshFeet();
    this.trajectory.push(this.frame());
  }
  dispose() {
    this.world.free();
  }
  private refreshActuators() {
    for (const a of this.joints) {
      a.angle = signedAngle(a.parent.rotation(), a.child.rotation(), a.axis);
      a.speed = dot(
        sub(a.child.angvel(), a.parent.angvel()),
        rotate(a.parent.rotation(), a.axis),
      );
    }
  }
  private contact(c: Collider) {
    let touching = false;
    this.world.contactPair(c, this.ground, (m) => {
      for (let i = 0; i < m.numContacts(); i++)
        if (m.contactDist(i) < 0.003) touching = true;
    });
    return touching;
  }
  private refreshFeet() {
    const loaded = this.config.evaluation.contactModel === "load-bearing";
    let supports: boolean[] = [];
    if (loaded) {
      this.footImpulses = this.feet.map((f) => {
        let impulse = 0;
        this.world.contactPair(f, this.ground, (m) => {
          for (let i = 0; i < m.numContacts(); i++)
            if (m.contactDist(i) < 0.003)
              impulse += Math.max(0, m.contactImpulse(i));
        });
        return impulse;
      });
      supports = footSupport(
        this.footImpulses,
        this.feet.map(() => 0),
        this.bodies.reduce((sum, b) => sum + b.mass(), 0) *
          Math.abs(this.config.physics.gravity) *
          this.config.physics.dt,
      ).contacts;
    }
    this.footStates = this.feet.map((f, leg) => {
      const position = { ...f.translation() },
        contact = loaded ? supports[leg] : this.contact(f);
      return {
        position,
        contact,
        swing: !contact && position.y - this.config.robot.footRadius > 0.02,
        clearance: Math.max(0, position.y - this.config.robot.footRadius),
      };
    });
  }
  frame(): Frame {
    if (this.frozen) return structuredClone(this.frozen);
    return {
      tick: this.tick,
      distance: this.distance,
      bodies: this.bodies.map((b) => ({
        ...b.translation(),
        q: { ...b.rotation() },
        v: { ...b.linvel() },
        w: { ...b.angvel() },
      })),
      angles: this.joints.map((a) => a.angle),
      torques: this.joints.map((a) => a.torque),
      feet: structuredClone(this.footStates),
      gait: structuredClone(this.gait),
    };
  }
  get fitness() {
    if (this.savedFitness !== undefined) return this.savedFitness;
    return this.score.total;
  }
  get score(): ScoreBreakdown {
    return (
      this.savedScore ??
      this.assessment.breakdown(
        this.distance,
        this.cycles.map((c) => c.steps),
        this.energy,
        this.tick * this.config.physics.dt,
        this.outcome,
        this.cycles.map((c) =>
          [
            "rhythmic-curriculum-v7",
            "mobile-curriculum-v8",
            "settled-curriculum-v9",
          ].includes(this.config.rewardModel)
            ? c.trainingProgress(this.config.duration)
            : c.completedProgress,
        ),
        this.weightShift,
        this.cycles.map((c) => c.stepActivity / this.config.duration),
        this.landings.settledSteps,
        this.landings.recoverySteps,
      )
    );
  }
  sensorInputs(): number[] {
    const q = this.torso.rotation(),
      local = inverse(q),
      up = rotate(local, { x: 0, y: 1, z: 0 }),
      angular = rotate(local, this.torso.angvel()),
      velocity = rotate(local, this.torso.linvel()),
      c = this.config.robot,
      p = this.config.physics;
    const inputs = [
      ...this.joints.map((a, i) => {
        const [lo, hi] = JOINT_LIMITS[i];
        return clamp((2 * (a.angle - lo)) / (hi - lo) - 1, -1, 1);
      }),
      ...this.joints.map((a) => clamp(a.speed / p.maxSpeed, -1, 1)),
      up.x,
      up.y,
      up.z,
      ...[angular.x, angular.y, angular.z].map((v) => clamp(v / 10, -1, 1)),
      ...[velocity.x, velocity.y, velocity.z].map((v) => clamp(v / 3, -1, 1)),
      ...this.footStates.map((f) => (f.contact ? 1 : -1)),
      ...this.footStates.map((f) =>
        clamp(f.clearance / (c.upper + c.lower), 0, 1),
      ),
      clamp(this.torso.translation().y / (c.upper + c.lower), 0, 2),
    ];
    if (this.individual.genes.length === DIRECTION_SHARED_GENE_COUNT) {
      const forward = rotate(q, { x: 1, y: 0, z: 0 });
      // Observations only. No steering force, target joint angle or fixed gain.
      inputs.push(
        Math.atan2(forward.z, forward.x) / Math.PI,
        clamp(this.torso.translation().z / 0.5, -1, 1),
      );
    }
    return inputs;
  }

  view(): RobotView {
    return {
      ...this.individual,
      genes: [...this.individual.genes],
      parents: [...this.individual.parents],
      frame: this.frame(),
      outcome: this.outcome,
      reachedTick: this.reachedTick,
      fitness: this.fitness,
      score: this.score,
      energy: this.energy,
      elapsed: this.tick * this.config.physics.dt,
    };
  }
  restore(view: RobotView) {
    this.frozen = structuredClone(view.frame);
    this.tick = view.frame.tick;
    this.distance = view.frame.distance;
    this.reachedTick = view.reachedTick;
    this.energy = view.energy;
    this.outcome = view.outcome;
    this.savedFitness = view.fitness;
    this.savedScore = structuredClone(view.score);
    view.frame.bodies.forEach((b, i) => {
      this.bodies[i].setTranslation(b, true);
      this.bodies[i].setRotation(b.q, true);
      this.bodies[i].setLinvel(b.v, true);
      this.bodies[i].setAngvel(b.w, true);
    });
  }
  step() {
    if (this.outcome !== "active") return;
    const before = this.frame(),
      p = this.config.physics,
      e = this.config.evaluation,
      c = this.config.robot;
    for (const b of this.bodies) b.resetTorques(false);
    try {
      this.refreshActuators();
      const commands = this.controller.step(this.sensorInputs(), p.dt);
      this.joints.forEach((a, i) => {
        const limit = i % 3 === 2 ? p.kneeTorque : p.hipTorque;
        let torque = commands[i] * limit;
        // An actuator limit, not a learned pose or balancing correction. External
        // forces can still exceed this speed; the motor stops adding acceleration.
        if (Math.abs(a.speed) >= p.maxSpeed && torque * a.speed > 0) torque = 0;
        a.torque = torque;
        const axis = rotate(a.parent.rotation(), a.axis),
          applied = {
            x: axis.x * torque,
            y: axis.y * torque,
            z: axis.z * torque,
          };
        a.child.addTorque(applied, true);
        a.parent.addTorque(
          { x: -applied.x, y: -applied.y, z: -applied.z },
          true,
        );
      });
      this.world.step();
    } catch {
      this.tick++;
      this.outcome = "invalid";
      this.frozen = { ...before, tick: this.tick };
      this.trajectory.push(this.frame());
      return;
    }
    this.tick++;
    this.refreshActuators();
    this.refreshFeet();
    const position = this.torso.translation();
    if (
      this.bodies.some((b) => {
        const t = b.translation(),
          q = b.rotation(),
          v = b.linvel(),
          w = b.angvel();
        return (
          ![
            t.x,
            t.y,
            t.z,
            q.x,
            q.y,
            q.z,
            q.w,
            v.x,
            v.y,
            v.z,
            w.x,
            w.y,
            w.z,
          ].every(Number.isFinite) ||
          Math.abs(t.x) > 450 ||
          Math.abs(t.z) > 450 ||
          Math.abs(t.y) > 100
        );
      })
    ) {
      this.outcome = "invalid";
      this.frozen = { ...before, tick: this.tick };
      this.trajectory.push(this.frame());
      return;
    }
    const bodyUp = rotate(this.torso.rotation(), { x: 0, y: 1, z: 0 }),
      tilt = Math.acos(clamp(bodyUp.y, -1, 1));
    this.tiltedTicks = tilt > e.maxTilt ? this.tiltedTicks + 1 : 0;
    this.lowTicks = position.y < e.minHeight ? this.lowTicks + 1 : 0;
    const limbContact = this.limbColliders.some((col) => this.contact(col));
    this.limbTicks = limbContact ? this.limbTicks + 1 : 0;
    let slip = 0,
      contacts = 0;
    this.footStates.forEach((foot, leg) => {
      const lower = this.bodies[3 + leg * 3];
      const velocity = lower.velocityAtPoint(foot.position);
      if (foot.contact) {
        contacts++;
        slip += Math.hypot(velocity.x, velocity.z);
      }
    });
    slip = contacts ? slip / contacts : 0;
    if (this.config.evaluation.contactModel === "load-bearing") {
      const surfaceSpeeds = this.footStates.map((foot, leg) => {
        const v = this.bodies[3 + leg * 3].velocityAtPoint({
          ...foot.position,
          y: foot.position.y - c.footRadius,
        });
        return Math.hypot(v.x, v.z);
      });
      slip = footSupport(this.footImpulses, surfaceSpeeds, 0).slip;
    }
    const velocity = this.torso.linvel(),
      forward = rotate(this.torso.rotation(), X),
      maxHeight = 0.025 + c.footRadius + c.upper + c.lower + e.maxHeightMargin;
    let jointFreedom = 0,
      freeJoints = 0,
      stopEffort = 0;
    if (
      ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
        this.config.rewardModel,
      )
    )
      this.joints.forEach((joint, i) => {
        const [lo, hi] = JOINT_LIMITS[i],
          range = hi - lo,
          margin = Math.max(0, Math.min(joint.angle - lo, hi - joint.angle));
        jointFreedom += Math.min(1, margin / (range * 0.15)) / 12;
        if (margin > range * 0.02) freeJoints++;
        const outward =
          (joint.angle <= lo + range * 0.02 && joint.torque < 0) ||
          (joint.angle >= hi - range * 0.02 && joint.torque > 0);
        this.stopRuns[i] =
          outward && Math.abs(joint.speed) < 0.15 ? this.stopRuns[i] + p.dt : 0;
        const limit = i % 3 === 2 ? p.kneeTorque : p.hipTorque;
        if (this.stopRuns[i] >= 0.15 && limit > 0)
          stopEffort += Math.abs(joint.torque) / limit / 12;
      });
    const quality = this.assessment.observe({
      x: position.x,
      lateralPosition: position.z,
      headingAngle: Math.atan2(forward.z, forward.x),
      dx: position.x - before.bodies[0].x,
      dz: position.z - before.bodies[0].z,
      height: position.y,
      verticalSpeed: velocity.y,
      yawSpeed: this.torso.angvel().y,
      tilt,
      heading: forward.x,
      contacts,
      slip,
      limbContact,
      jointFreedom,
      freeJoints,
      stopEffort,
    });
    if (
      this.stage === "stepping" &&
      [
        "cycle-curriculum-v6",
        "rhythmic-curriculum-v7",
        "mobile-curriculum-v8",
        "settled-curriculum-v9",
      ].includes(this.config.rewardModel)
    ) {
      const center = { x: 0, y: 0, z: 0 };
      let mass = 0;
      for (const body of this.bodies) {
        const m = body.mass(),
          point = body.worldCom();
        mass += m;
        center.x += m * point.x;
        center.y += m * point.y;
        center.z += m * point.z;
      }
      center.x /= mass;
      center.y /= mass;
      center.z /= mass;
      for (let leg = 0; leg < 4; leg++) {
        const supports = this.footStates
          .filter((f, i) => i !== leg && f.contact)
          .map((f) => f.position);
        const readiness = quality.grounded
          ? supportReadiness(center, supports)
          : 0;
        this.shiftRun[leg] = readiness > 0 ? this.shiftRun[leg] + p.dt : 0;
        if (this.shiftRun[leg] + 1e-9 >= 0.15) {
          if (
            [
              "rhythmic-curriculum-v7",
              "mobile-curriculum-v8",
              "settled-curriculum-v9",
            ].includes(this.config.rewardModel)
          ) {
            this.shiftTime[leg] += readiness * p.dt;
            this.weightShift[leg] = Math.min(1, this.shiftTime[leg] / 2);
          } else
            this.weightShift[leg] = Math.max(this.weightShift[leg], readiness);
        }
      }
    }
    this.footStates.forEach((foot, leg) =>
      this.cycles[leg].update(
        this.tick,
        p.dt,
        { ...foot.position, y: foot.clearance },
        foot.contact,
        0,
        quality.stepEligible,
        quality.grounded,
      ),
    );
    if (this.config.rewardModel === "settled-curriculum-v9")
      this.landings.observe({
        dt: p.dt,
        steps: this.cycles.map((c) => c.steps),
        contacts: this.footStates.map((f) => f.contact),
        stable: quality.grounded,
        eligible: quality.stepEligible,
        tilt,
        tiltSpeed: (tilt - this.previousTilt) / p.dt,
        x: position.x,
      });
    this.previousTilt = tilt;
    const walking =
      quality.grounded &&
      walkingGate({
        height: position.y,
        tilt,
        contacts,
        slip,
        limbContact,
        lastSteps: this.cycles.map((c) => c.lastStep),
        tick: this.tick,
        dt: p.dt,
        minHeight: e.minHeight,
        stepMemory: e.stepMemory,
        maxHeight,
        verticalSpeed: velocity.y,
        maxVerticalSpeed: e.maxVerticalSpeed,
        jumping: this.assessment.jump,
      });
    const advance = Math.max(0, position.x - this.maxForwardX);
    this.maxForwardX = Math.max(this.maxForwardX, position.x);
    if (walking) {
      this.validTicks++;
      const old = Math.floor(this.distance * 1000);
      this.distance += advance;
      if (Math.floor(this.distance * 1000) > old) this.reachedTick = this.tick;
    }
    this.assessment.observeWalking(walking, velocity.x);
    this.gait = {
      ...(this.config.rewardModel === "settled-curriculum-v9"
        ? {
            settledSteps: [...this.landings.settledSteps],
            recoverySteps: this.landings.recoverySteps,
          }
        : {}),
      ...([
        "cycle-curriculum-v6",
        "rhythmic-curriculum-v7",
        "mobile-curriculum-v8",
        "settled-curriculum-v9",
      ].includes(this.config.rewardModel)
        ? {
            footProgress: this.cycles.map((c) =>
              [
                "rhythmic-curriculum-v7",
                "mobile-curriculum-v8",
                "settled-curriculum-v9",
              ].includes(this.config.rewardModel)
                ? c.trainingProgress(this.config.duration)
                : c.completedProgress,
            ),
            weightShift: [...this.weightShift],
            ...([
              "rhythmic-curriculum-v7",
              "mobile-curriculum-v8",
              "settled-curriculum-v9",
            ].includes(this.config.rewardModel)
              ? {
                  stepActivity: this.cycles.map(
                    (c) => c.stepActivity / this.config.duration,
                  ),
                }
              : {}),
          }
        : {}),
      ...(["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
        this.config.rewardModel,
      )
        ? {
            jointFreedom,
            mobileSupportTime: this.assessment.mobileSupportTime,
            longestMobileSupport: this.assessment.longestMobileSupport,
            stopEffortTime: this.assessment.stopEffortTime,
          }
        : {}),
      rawDistance: Math.max(0, this.maxForwardX),
      steps: this.cycles.map((c) => c.steps),
      contactCount: contacts,
      slip,
      walking,
      limbContact,
      uprightTime: this.assessment.uprightTime,
      supportTime: this.assessment.supportTime,
      longestSupport: this.assessment.longestSupport,
      walkingTime: this.assessment.walkingTime,
      qualityWalkingTime: this.assessment.qualityWalkingTime,
      longestWalking: this.assessment.longestWalking,
      ...(this.config.curriculum.useDriftLimits
        ? {
            lateralDeviation: this.assessment.lateralDeviation,
            headingDeviation: this.assessment.headingDeviation,
          }
        : {}),
      lateralTravel: this.assessment.lateralTravel,
      yawTravel: this.assessment.yawTravel,
      groundedForward: this.assessment.groundedForward,
      airTime: this.assessment.airTime,
      longestFlight: this.assessment.longestFlight,
      verticalMotion: this.assessment.verticalMotion,
      jumping: this.assessment.jump,
    };
    for (const a of this.joints)
      this.energy += Math.abs(a.torque * a.speed) * p.dt;
    const progress = Math.max(this.distance, this.assessment.groundedForward);
    if (progress - this.progressDistance >= e.stallDistance) {
      this.progressDistance = progress;
      this.lastProgressTick = this.tick;
    }
    if (this.assessment.jump) this.outcome = "jumped";
    else if (
      position.y < c.height / 2 + 0.04 ||
      this.tiltedTicks * p.dt >= e.tiltGrace ||
      this.lowTicks * p.dt >= e.tiltGrace ||
      this.limbTicks * p.dt > 0.35
    )
      this.outcome = "fallen";
    else if (
      this.stage === "forward" &&
      this.distance >= this.config.target &&
      this.assessment.walkingTime + 1e-8 >=
        this.config.curriculum.forwardSeconds &&
      meetsStage(this.view(), "forward", this.config)
    )
      this.outcome = "success";
    else if (this.tick >= Math.ceil(this.config.duration / p.dt))
      this.outcome = "timeout";
    else if (
      (this.stage === "forward" ||
        (this.stage === "stepping" &&
          this.config.rewardModel === "temporal-curriculum-v4")) &&
      this.tick * p.dt >= e.warmup + e.stallWindow &&
      (this.tick - this.lastProgressTick) * p.dt >= e.stallWindow
    )
      this.outcome = "stalled";
    if (this.tick % 6 === 0 || this.outcome !== "active")
      this.trajectory.push(this.frame());
  }
}
