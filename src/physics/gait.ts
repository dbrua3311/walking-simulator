import type { Vec } from "../simulation/types";
export class FootCycle {
  steps = 0;
  completedProgress = 0;
  stepActivity = 0;
  cycleCoverage = 0;
  lastCycleTick = -Infinity;
  lastCycleQuality = 0;
  trainingProgress(duration: number) {
    return (
      0.5 * this.completedProgress +
      0.5 * Math.min(1, this.cycleCoverage / duration)
    );
  }
  pendingProgress = 0;
  settledTime = 0;
  // Only a completed landing followed by stable support earns partial credit.
  // Holding a foot up, backward swings and initial drops earn none.
  private progress(height: number, transfer: number, seconds: number) {
    return (
      Math.min(1, Math.max(0, height / 0.035)) *
      Math.min(1, Math.max(0, transfer / 0.018)) *
      Math.min(1, seconds / 0.07)
    );
  }
  lastStep = -Infinity;
  airStart = -1;
  peak = 0;
  startX = 0;
  airSamples = 0;
  hasStance = false;
  rejected = false;
  update(
    tick: number,
    dt: number,
    position: Vec,
    contact: boolean,
    bodyX: number,
    eligible = true,
    stable = eligible,
  ) {
    const height = position.y;
    if (!contact) {
      this.pendingProgress = 0;
      this.settledTime = 0;
      if (this.airStart < 0) {
        this.rejected = !this.hasStance;

        this.airStart = tick;
        this.startX = position.x - bodyX;
        this.peak = height;
        this.airSamples = 0;
      }
      if (!eligible) this.rejected = true;
      this.peak = Math.max(this.peak, height);
      this.airSamples++;
    } else if (this.airStart >= 0) {
      this.pendingProgress =
        eligible && !this.rejected && this.hasStance
          ? this.progress(
              this.peak,
              position.x - bodyX - this.startX,
              this.airSamples * dt,
            )
          : 0;
      if (
        eligible &&
        !this.rejected &&
        this.hasStance &&
        this.peak >= 0.035 &&
        this.airSamples * dt >= 0.07 &&
        position.x - bodyX - this.startX >= 0.018
      ) {
        this.steps++;
        this.completedProgress = 0;
        this.cycleCoverage = 0;
        this.lastCycleQuality = 0;
        this.lastCycleTick = -Infinity;
        this.pendingProgress = 0;
        this.lastStep = tick;
      }
      this.airStart = -1;
      this.airSamples = 0;
      this.peak = 0;
    }
    if (contact && this.pendingProgress > 0) {
      if (stable) {
        this.settledTime += dt;
        if (this.settledTime + 1e-9 >= 0.15) {
          this.completedProgress = Math.max(
            this.completedProgress,
            this.pendingProgress,
          );
          this.lastCycleQuality = this.pendingProgress;
          this.lastCycleTick = tick;
          this.pendingProgress = 0;
        }
      } else {
        this.pendingProgress = 0;
        this.settledTime = 0;
      }
    }
    if (stable) {
      this.stepActivity +=
        Math.max(0, 1 - ((tick - this.lastStep) * dt) / 3) * dt;
      this.cycleCoverage +=
        this.lastCycleQuality *
        Math.max(0, 1 - ((tick - this.lastCycleTick) * dt) / 3) *
        dt;
    }
    if (contact) this.hasStance = eligible;
  }
}
export function walkingGate(input: {
  height: number;
  tilt: number;
  contacts: number;
  slip: number;
  limbContact: boolean;
  lastSteps: number[];
  tick: number;
  dt: number;
  minHeight: number;
  stepMemory: number;
  maxHeight?: number;
  verticalSpeed?: number;
  maxVerticalSpeed?: number;
  jumping?: boolean;
}) {
  return (
    input.height >= input.minHeight &&
    input.height <= (input.maxHeight ?? Infinity) &&
    Math.abs(input.verticalSpeed ?? 0) <=
      (input.maxVerticalSpeed ?? Infinity) &&
    !input.jumping &&
    input.tilt < 0.5 &&
    input.contacts >= 2 &&
    input.slip < 0.3 &&
    !input.limbContact &&
    input.lastSteps.every(
      (t) => input.tick - t < Math.ceil(input.stepMemory / input.dt),
    )
  );
}

// Quasistatic readiness only: mass centre projected inside the three supporting
// feet, with 3 cm edge clearance. No body force or control target is applied.
export function supportReadiness(center: Vec, supports: Vec[]): number {
  if (supports.length !== 3) return 0;
  const [a, b, c] = supports;
  const cross = (p: Vec, q: Vec, t: Vec) =>
    (q.x - p.x) * (t.z - p.z) - (q.z - p.z) * (t.x - p.x);
  const area = cross(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-6) return 0;
  const sign = Math.sign(area);
  const margins = supports.map((p, i) => {
    const q = supports[(i + 1) % 3],
      length = Math.hypot(q.x - p.x, q.z - p.z);
    return length > 1e-6 ? (sign * cross(p, q, center)) / length : -Infinity;
  });
  return Math.max(0, Math.min(1, Math.min(...margins) / 0.03));
}

// A near-floor swing foot can have a manifold while carrying zero weight.
// Requiring 5% of body weight per supporting foot excludes this predictive
// contact; normal impulses weight actual sliding work at the foot surface.
export function footSupport(
  impulses: number[],
  surfaceSpeeds: number[],
  bodyWeightImpulse: number,
) {
  const total = impulses.reduce((sum, j) => sum + j, 0),
    threshold = Math.max(1e-8, bodyWeightImpulse * 0.05);
  return {
    contacts: impulses.map((j) => j > threshold),
    slip:
      total > 1e-8
        ? impulses.reduce((sum, j, i) => sum + j * surfaceSpeeds[i], 0) / total
        : 0,
  };
}
