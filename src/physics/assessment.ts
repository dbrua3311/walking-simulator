import type {
  Config,
  TrainingStage,
  Outcome,
  ScoreBreakdown,
} from "../simulation/types";
const clip = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
export const REWARD_VERSION = "mobile-curriculum-v8";
export const isRhythmicReward = (model: Config["rewardModel"]) =>
  model === "rhythmic-curriculum-v7" || model === REWARD_VERSION;
export const isPracticeReward = (model: Config["rewardModel"]) =>
  model === "cycle-curriculum-v6" || isRhythmicReward(model);
export const BACKWARD_PENALTY_PER_M = 0.15;
export type MotionSample = {
  x: number;
  dx: number;
  dz: number;
  height: number;
  verticalSpeed: number;
  yawSpeed: number;
  tilt: number;
  heading: number;
  contacts: number;
  slip: number;
  limbContact: boolean;
  lateralPosition?: number;
  headingAngle?: number;
  jointFreedom?: number;
  freeJoints?: number;
  stopEffort?: number;
};
// Evaluation only. None of these measurements changes a torque or body pose.
export class WalkingAssessment {
  hasTouchedGround = false;
  flight = 0;
  airTime = 0;
  longestFlight = 0;
  verticalMotion = 0;
  backwardTravel = 0;
  lateralTravel = 0;
  lateralDeviation = 0;
  headingDeviation = 0;
  walkingGap = 0;
  yawTravel = 0;
  balanceTime = 0;
  mobilityTime = 0;
  mobileSupportTime = 0;
  mobileRun = 0;
  longestMobileSupport = 0;
  stopEffortTime = 0;
  supportTime = 0;
  supportRun = 0;
  longestSupport = 0;
  walkingTime = 0;
  qualityWalkingTime = 0;
  motionQuality = 0;
  walkingRun = 0;
  longestWalking = 0;
  uprightTime = 0;
  groundedNet = 0;
  groundedForward = 0;
  jump = false;
  constructor(
    readonly config: Config,
    readonly stage: TrainingStage = "balance",
  ) {}
  observe(s: MotionSample) {
    const { dt } = this.config.physics,
      e = this.config.evaluation,
      c = this.config.robot;
    const maxHeight =
      0.025 + c.footRadius + c.upper + c.lower + e.maxHeightMargin;
    if (s.contacts > 0 || s.limbContact) this.hasTouchedGround = true;
    if (this.hasTouchedGround && s.contacts === 0 && !s.limbContact) {
      this.flight += dt;
      this.airTime += dt;
      this.longestFlight = Math.max(this.longestFlight, this.flight);
    } else this.flight = 0;
    this.jump =
      this.jump ||
      (this.hasTouchedGround &&
        (this.flight > e.maxAirTime || s.height > maxHeight));
    this.verticalMotion += Math.min(9, s.verticalSpeed * s.verticalSpeed) * dt;
    // World +x is forward. Count every reverse segment, including flight or
    // dragging; returning forward never cancels the accumulated penalty.
    this.backwardTravel += Math.max(0, -s.dx);
    this.lateralTravel += Math.min(3, Math.abs(s.dz) / dt) * dt;
    this.yawTravel += Math.min(10, Math.abs(s.yawSpeed)) * dt;
    if (this.config.curriculum.useDriftLimits) {
      this.lateralDeviation = Math.max(
        this.lateralDeviation,
        Math.abs(s.lateralPosition ?? 0),
      );
      this.headingDeviation = Math.max(
        this.headingDeviation,
        Math.abs(s.headingAngle ?? 0),
      );
    }
    const posture =
      s.height >= e.minHeight &&
      s.height <= maxHeight &&
      s.tilt < 0.5 &&
      !s.limbContact &&
      s.heading > 0.7;
    const grounded =
      posture &&
      s.contacts >= 2 &&
      s.slip < 0.3 &&
      Math.abs(s.verticalSpeed) <= e.maxVerticalSpeed &&
      !this.jump;
    if (posture && s.contacts > 0) this.uprightTime += dt;
    if (this.config.rewardModel === REWARD_VERSION) {
      const freedom = clip(s.jointFreedom ?? 1, 0, 1);
      if (grounded)
        this.mobilityTime +=
          dt * clip((s.height - e.minHeight) / 0.15, 0, 1) * freedom;
      const mobile =
        grounded &&
        (s.freeJoints ?? 12) >= 9 &&
        s.height >= e.minHeight + (c.upper + c.lower) * 0.15;
      this.mobileRun = mobile ? this.mobileRun + dt : 0;
      if (mobile) this.mobileSupportTime += dt;
      this.longestMobileSupport = Math.max(
        this.longestMobileSupport,
        this.mobileRun,
      );
      this.stopEffortTime += dt * Math.max(0, s.stopEffort ?? 0);
    }
    if (grounded) this.supportTime += dt;
    this.supportRun = grounded ? this.supportRun + dt : 0;
    this.longestSupport = Math.max(this.longestSupport, this.supportRun);
    if (!this.jump && !s.limbContact && s.contacts > 0 && s.height <= maxHeight)
      this.balanceTime +=
        clip((s.height - e.minHeight) / 0.15, 0, 1) *
        clip(1 - s.tilt / 0.7, 0, 1) *
        Math.min(1, s.contacts / 2) *
        dt;
    // Smooth shaping supplies a gradient before the strict walking gate is met.
    // Flight/collision phases still contribute exactly zero forward reward.
    const quality =
      !this.jump && !s.limbContact && s.contacts > 0 && s.height <= maxHeight
        ? clip((s.height - e.minHeight) / 0.15, 0, 1) *
          clip(1 - s.tilt / 0.7, 0, 1) *
          clip((s.heading - 0.2) / 0.8, 0, 1) *
          Math.min(1, s.contacts / 2) *
          Math.exp(
            -Math.pow(s.slip / 0.6, 2) - Math.pow(s.verticalSpeed / 0.6, 2),
          )
        : 0;
    this.motionQuality = quality;
    this.groundedNet += clip(s.dx, -0.75 * dt, 0.75 * dt) * quality;
    // Rocking backwards in an unqualified phase cannot bank forward rewards.
    this.groundedForward = Math.min(
      Math.max(0, s.x),
      Math.max(0, this.groundedNet),
    );
    return {
      grounded,
      stepEligible:
        posture &&
        s.contacts >= 1 &&
        Math.abs(s.verticalSpeed) <= e.maxVerticalSpeed &&
        !this.jump,
    };
  }
  observeWalking(walking: boolean, forwardSpeed: number) {
    const moving = walking && !this.jump && forwardSpeed > 0.03;
    if (moving) {
      this.walkingGap = 0;
      this.walkingRun += this.config.physics.dt;
    } else {
      this.walkingGap += this.config.physics.dt;
      if (
        this.jump ||
        this.walkingGap > this.config.evaluation.walkingContinuityGrace + 1e-9
      )
        this.walkingRun = 0;
    }
    if (moving) {
      this.walkingTime += this.config.physics.dt;
      this.qualityWalkingTime += this.config.physics.dt * this.motionQuality;
    }
    this.longestWalking = Math.max(this.longestWalking, this.walkingRun);
  }
  breakdown(
    distance: number,
    steps: number[],
    energy: number,
    elapsed: number,
    outcome: Outcome = "active",
    footProgress: number[] = [],
    weightShift: number[] = [],
    stepActivity: number[] = [],
  ): ScoreBreakdown {
    const duration = this.config.duration,
      distinct = steps.filter((n) => n > 0).length / 4,
      stepQuality = steps.reduce((sum, n) => sum + Math.min(2, n), 0) / 8,
      progress = Math.tanh(this.groundedForward / 0.5),
      weights =
        this.stage === "balance"
          ? [0.98, 0.01, 0.01, 0]
          : this.stage === "stepping"
            ? [0.2, 0.6, 0.1, 0.1]
            : [0.03, 0.12, 0.45, 0.4];
    // Time reward is linear in actual grounded support, never airborne survival.
    const sustained = this.config.rewardModel !== "temporal-curriculum-v4";
    const supportWindow =
      this.stage === "stepping" && !sustained
        ? this.config.curriculum.balanceSeconds
        : duration;
    // A brief foot movement before collapse cannot replace sustained support.
    // Airborne survival never increases this multiplier.
    const sustainedSteps =
      this.stage === "stepping" && sustained
        ? clip(this.supportTime / duration, 0, 1)
        : 1;
    // Dense posture shaping is still grounded time; flight supplies none. The
    // hard 15-second balance goal remains separate from these partial rewards.
    const supportSignal =
      this.stage === "balance"
        ? (0.8 *
            (this.config.rewardModel === REWARD_VERSION
              ? this.mobilityTime
              : this.supportTime) +
            0.2 * this.balanceTime) /
          supportWindow
        : this.supportTime / supportWindow;
    const support = weights[0] * clip(supportSignal, 0, 1),
      footPoints =
        (this.stage === "stepping" && isRhythmicReward(this.config.rewardModel)
          ? steps.reduce(
              (sum, n, leg) =>
                sum +
                ((n > 0 ? 0.15 : 0) + 0.05 * Math.min(2, n)) *
                  (0.5 + 0.5 * clip(stepActivity[leg] ?? 0, 0, 1)),
              0,
            )
          : 0.6 * distinct + 0.4 * stepQuality) +
        (this.stage === "stepping" &&
        [
          "cycle-curriculum-v6",
          "rhythmic-curriculum-v7",
          REWARD_VERSION,
        ].includes(this.config.rewardModel)
          ? (0.3 *
              footProgress.reduce(
                (sum, value, leg) =>
                  sum +
                  clip(value, 0, 1) *
                    (steps[leg] === 0 ? 1 : steps[leg] === 1 ? 0.25 : 0),
                0,
              )) /
            4
          : 0),
      shiftPoints =
        this.stage === "stepping" &&
        [
          "cycle-curriculum-v6",
          "rhythmic-curriculum-v7",
          REWARD_VERSION,
        ].includes(this.config.rewardModel)
          ? (0.04 *
              weightShift.reduce(
                (sum, value, leg) =>
                  sum +
                  clip(value, 0, 1) *
                    (steps[leg] === 0 ? 1 : steps[leg] === 1 ? 0.25 : 0),
                0,
              )) /
            4
          : 0,
      stepping = weights[1] * (footPoints + shiftPoints) * sustainedSteps,
      forward =
        weights[2] *
        sustainedSteps *
        (this.stage === "forward"
          ? clip(distance / this.config.target, 0, 1)
          : progress * (0.1 + 0.9 * distinct)),
      continuity =
        weights[3] *
        clip(
          this.qualityWalkingTime / this.config.curriculum.forwardSeconds,
          0,
          1,
        ),
      fall =
        outcome === "fallen"
          ? this.stage === "balance"
            ? 0.1
            : this.stage === "stepping"
              ? sustained
                ? 0.35
                : 0.12
              : 0.35
          : 0,
      stalled =
        outcome === "stalled"
          ? this.stage === "balance"
            ? 0.02
            : this.stage === "stepping"
              ? 0.04
              : 0.1
          : 0,
      penalty =
        (this.config.rewardModel === REWARD_VERSION
          ? 0.8 * clip(this.stopEffortTime / (duration * 0.1), 0, 1)
          : 0) +
        (0.1 * this.airTime) / duration +
        (0.1 * this.verticalMotion) / duration +
        BACKWARD_PENALTY_PER_M * this.backwardTravel +
        0.03 * this.lateralTravel +
        0.01 * this.yawTravel +
        (((0.02 * elapsed) / duration) * energy) / (energy + 200) +
        (this.jump ? 0.5 : 0) +
        fall +
        stalled +
        (outcome === "invalid" ? 1 : 0);
    return {
      support,
      steps: stepping,
      forward,
      continuity,
      penalty,
      total: clip(support + stepping + forward + continuity - penalty, -1, 1),
    };
  }
  score(
    distance: number,
    steps: number[],
    energy: number,
    elapsed: number,
    outcome: Outcome = "active",
  ) {
    return this.breakdown(distance, steps, energy, elapsed, outcome).total;
  }
}
