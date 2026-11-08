import type {
  Config,
  Gait,
  CurriculumState,
  RobotView,
  TrainingStage,
} from "./types";
export const STAGES: TrainingStage[] = ["balance", "stepping", "forward"];
export const STAGE_NAMES: Record<TrainingStage, string> = {
  balance: "균형 유지",
  stepping: "발 옮기기",
  forward: "연속 전진",
};
export const initialCurriculum = (): CurriculumState => ({
  stage: "balance",
  startedGeneration: 1,
  streak: 0,
  pendingStage: null,
});
export const eligible = (r: RobotView) =>
  r.outcome !== "jumped" && r.outcome !== "invalid";
export const distinctFeet = (r: RobotView) =>
  r.frame.gait.steps.filter((n) => n > 0).length;
// Net course departure and heading excursion distinguish normal periodic
// weight transfer from sideways travel; legacy files retain path-length limits.
export function withinCourseLimits(
  g: Pick<
    Gait,
    "lateralTravel" | "yawTravel" | "lateralDeviation" | "headingDeviation"
  >,
  config: Config,
) {
  const c = config.curriculum;
  return c.useDriftLimits
    ? (g.lateralDeviation ?? Infinity) <= c.maxLateralDeviation &&
        (g.headingDeviation ?? Infinity) <= c.maxHeadingDeviation
    : g.lateralTravel <= c.maxLateralTravel && g.yawTravel <= c.maxYawTravel;
}
export function meetsStage(
  r: RobotView,
  stage: TrainingStage,
  config: Config,
): boolean {
  const g = r.frame.gait,
    c = config.curriculum;
  if (!eligible(r) || g.jumping) return false;
  if (stage === "balance")
    return (
      r.elapsed + 1e-8 >= config.duration &&
      r.outcome === "timeout" &&
      (!["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
        config.rewardModel,
      ) ||
        ((g.longestMobileSupport ?? 0) + 1e-8 >= Math.min(2, config.duration) &&
          (g.mobileSupportTime ?? 0) + 1e-8 >=
            config.duration * c.mobileSupportRatio &&
          (g.jointFreedom ?? 0) + 1e-8 >= c.minJointFreedomAtPromotion)) &&
      g.longestSupport + 1e-8 >= Math.min(c.balanceSeconds, config.duration)
    );
  if (stage === "stepping")
    return (
      g.supportTime + 1e-8 >= c.balanceSeconds &&
      distinctFeet(r) >= c.steppingFeet &&
      g.steps.reduce((a, b) => a + b, 0) >= c.steppingSteps &&
      g.groundedForward + 1e-8 >= c.steppingForward &&
      (!c.coordinatedPromotion ||
        (r.outcome === "timeout" &&
          r.elapsed + 1e-8 >= config.duration &&
          g.steps.every((n) => n >= 2) &&
          g.longestWalking + 1e-8 >= 1 &&
          g.walking))
    );
  return (
    r.frame.distance + 1e-8 >= config.target &&
    g.walkingTime + 1e-8 >= c.forwardSeconds &&
    g.longestWalking + 1e-8 >=
      Math.min(c.forwardContinuousSeconds, c.forwardSeconds) &&
    (!c.requireWalkingAtFinish || g.walking) &&
    g.steps.every((n) => n >= 2) &&
    g.longestFlight <= config.evaluation.maxAirTime + 1e-8 &&
    g.longestFlight <= (c.maxWalkingFlightTime ?? 0.5) + 1e-8 &&
    withinCourseLimits(g, config) &&
    (r.outcome === "active" ||
      r.outcome === "success" ||
      r.outcome === "timeout")
  );
}
// Run once at completion. Scores/Worlds keep their original objective until evolve.
export function assessCurriculum(
  state: CurriculumState,
  robots: RobotView[],
  config: Config,
): CurriculumState {
  if (state.stage === "forward" || state.pendingStage) return { ...state };
  const streak = robots.some((r) => meetsStage(r, state.stage, config))
    ? state.streak + 1
    : 0;
  return {
    ...state,
    streak,
    pendingStage:
      streak >= config.curriculum.promotionGenerations
        ? STAGES[STAGES.indexOf(state.stage) + 1]
        : null,
  };
}
export function enterNextGeneration(
  state: CurriculumState,
  generation: number,
): CurriculumState {
  return state.pendingStage
    ? {
        stage: state.pendingStage,
        startedGeneration: generation,
        streak: 0,
        pendingStage: null,
      }
    : { ...state };
}
export function stageTarget(stage: TrainingStage, config: Config): string {
  const c = config.curriculum;
  if (stage === "balance")
    return `${config.duration}초 끝까지 넘어지지 않기 · 연속 안정 지지 ${Math.min(c.balanceSeconds, config.duration)}초${["mobile-curriculum-v8", "settled-curriculum-v9"].includes(config.rewardModel) ? ` · 가동 여유 연속 ${Math.min(2, config.duration)}초 · 합계 ${Number((config.duration * c.mobileSupportRatio).toFixed(2))}초` : ""}`;
  if (stage === "stepping")
    return `${c.steppingFeet}발 · ${c.steppingSteps}걸음 · 접지 전진 ${c.steppingForward}m${c.coordinatedPromotion ? ` · ${config.duration}초 끝까지 유지 · 발마다 2걸음 · 연속 보행 1초 · 종료 때 네 발 최근 걸음` : ""}`;
  return `유효 보행 ${c.forwardSeconds}초 · ${config.target}m · 네 발 각각 2걸음${c.forwardContinuousSeconds > 0 ? ` · 연속 전진 ${Math.min(c.forwardContinuousSeconds, c.forwardSeconds)}초` : ""}${c.requireWalkingAtFinish ? " · 판정 순간도 네 발 반복 보행 중" : ""}${c.maxWalkingFlightTime < config.evaluation.maxAirTime ? " · 발 지지 유지" : ""}`;
}

export const VERIFICATION_SCENARIOS = [
  { label: "기준 자세", roll: 0, pitch: 0 },
  { label: "왼쪽 기울기", roll: 0.035, pitch: 0.02 },
  { label: "오른쪽 기울기", roll: -0.035, pitch: -0.02 },
] as const;
