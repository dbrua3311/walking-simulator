import { Robot } from "../physics/robot";
import { meetsStage, VERIFICATION_SCENARIOS } from "./curriculum";
import type { Config, Individual, VerificationReport } from "./types";
// Only initial placement differs. Every trial then uses the same learned torques.
// Incremental stepping lets the Worker process pause commands between batches.
export class PolicyVerification {
  readonly robots: Robot[];
  constructor(
    readonly candidate: Individual,
    readonly generation: number,
    readonly config: Config,
  ) {
    this.robots = VERIFICATION_SCENARIOS.map(
      (s) => new Robot(structuredClone(candidate), config, "forward", s),
    );
  }
  step() {
    this.robots.forEach((r) => r.step());
  }
  get done() {
    return this.robots.every((r) => r.outcome !== "active");
  }
  report(): VerificationReport {
    const trials = this.robots.map((r, i) => {
      const view = r.view(),
        g = view.frame.gait;
      return {
        ...VERIFICATION_SCENARIOS[i],
        status: (r.outcome === "active"
          ? "running"
          : meetsStage(view, "forward", this.config)
            ? "passed"
            : "failed") as "running" | "passed" | "failed",
        outcome: view.outcome,
        elapsed: view.elapsed,
        distance: view.frame.distance,
        walkingTime: g.walkingTime,
        ...(this.config.curriculum.forwardContinuousSeconds > 0
          ? { longestWalking: g.longestWalking }
          : {}),
        ...(this.config.curriculum.requireWalkingAtFinish
          ? { walking: g.walking }
          : {}),
        ...(this.config.curriculum.useDriftLimits
          ? {
              lateralDeviation: g.lateralDeviation,
              headingDeviation: g.headingDeviation,
            }
          : {}),
        longestFlight: g.longestFlight,
        lateralTravel: g.lateralTravel,
        yawTravel: g.yawTravel,
        jumping: g.jumping,
        steps: [...g.steps],
      };
    });
    return {
      status: this.done
        ? trials.every((t) => t.status === "passed")
          ? "passed"
          : "failed"
        : "running",
      generation: this.generation,
      robotId: this.candidate.id,
      genes: [...this.candidate.genes],
      trials,
    };
  }
  dispose() {
    this.robots.forEach((r) => r.dispose());
  }
}
