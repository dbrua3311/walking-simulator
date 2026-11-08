import { CovarianceSearch, type CovarianceState } from "./covariance";
import { assemblyAngle } from "../controllers/genome";
import {
  sharedRanges,
  sharedGeneCount,
  isSharedModel,
  wrapPhase,
} from "../controllers/shared";
import { meetsStage } from "../simulation/curriculum";
import type { Random } from "./evolution";
import type {
  Config,
  Individual,
  RobotView,
  TrainingStage,
} from "../simulation/types";
export type SharedMode = "balance" | "cycles" | "reflex" | "direction";
export type SharedSearchVersion =
  "shared-covariance-v1" | "shared-covariance-v2" | "shared-covariance-v3";
export const SHARED_SEARCH_VERSION: SharedSearchVersion =
  "shared-covariance-v3";
export type SharedSearchState = {
  version: SharedSearchVersion;
  mode: SharedMode;
  base: number[];
  optimizer: CovarianceState;
  draws: [number, number[]][];
  askedGeneration: number;
  target: number;
  strength: number;
  peak: number;
  stagnation: number;
};
export const SHARED_MODE_NAMES: Record<SharedMode, string> = {
  balance: "균형 감각 탐색",
  cycles: "네 발 주기 탐색",
  reflex: "네 발 반복 유지",
  direction: "직진 다듬기",
};
// V1 coordinates remain readable so a completed run can resume honestly.
// V2 keeps leg timing mutable after discovering four feet; discovery is not a
// finished gait. No phase value, leg order or torque target is supplied.
export const sharedIndices = (
  mode: SharedMode,
  count = 38,
  version: SharedSearchVersion = SHARED_SEARCH_VERSION,
) => {
  if (mode === "balance") return [0, 1, 2, 9, 10, 11, 18, 19, 20];
  if (mode === "cycles")
    return Array.from({ length: 32 }, (_, i) => i).filter(
      (i) => i >= 27 || ![1, 2].includes(i % 9),
    );
  const feedback = Array.from({ length: count - 32 }, (_, i) => 32 + i);
  if (version === "shared-covariance-v1")
    return mode === "reflex"
      ? feedback
      : [0, 9, 18, 7, 8, 27, 28, 29, 30, ...feedback];
  return mode === "reflex"
    ? version === "shared-covariance-v2"
      ? [0, 7, 8, 27, 28, 29, 30, ...feedback]
      : [0, 7, 8, 16, 17, 25, 26, 27, 28, 29, 30, 31, ...feedback]
    : [0, 9, 18, 7, 8, 16, 17, 25, 26, 27, 28, 29, 30, 31, ...feedback];
};
export const useSharedSearch = (c: Config) =>
  isSharedModel(c.controllerModel) &&
  c.searchMethod === "covariance" &&
  c.population >= 4 &&
  c.adaptiveSearch &&
  c.mutation > 0 &&
  c.mutation < 1 &&
  c.crossover === 0;
export const encodeShared = (
  g: number[],
  mode: SharedMode,
  version: SharedSearchVersion = SHARED_SEARCH_VERSION,
) =>
  sharedIndices(mode, g.length, version).map((i) =>
    mode === "balance" && i % 9 === 0
      ? g[i] + g[i + 1] * assemblyAngle(i / 9)
      : g[i],
  );
export function decodeShared(
  base: number[],
  x: number[],
  mode: SharedMode,
  version: SharedSearchVersion = SHARED_SEARCH_VERSION,
) {
  const g = [...base];
  sharedIndices(mode, base.length, version).forEach(
    (i, k) => (g[i] = i >= 27 && i < 31 ? wrapPhase(x[k]) : x[k]),
  );
  if (mode === "balance")
    for (let j = 0; j < 3; j++) g[9 * j] -= g[9 * j + 1] * assemblyAngle(j);
  return g;
}
const reflect = (v: number, lo: number, hi: number) => {
  const width = hi - lo,
    t = (((v - lo) % (2 * width)) + 2 * width) % (2 * width);
  return lo + (t <= width ? t : 2 * width - t);
};
function repair(base: number[], x: number[], mode: SharedMode) {
  if (mode === "balance") {
    const genes = decodeShared(base, x, mode);
    for (let j = 0; j < 3; j++) {
      const bias = x[3 * j],
        k = 9 * j;
      genes[k + 1] = reflect(genes[k + 1], -2, 2);
      genes[k + 2] = reflect(genes[k + 2], -2, 2);
      genes[k] = reflect(bias - genes[k + 1] * assemblyAngle(j), -2, 2);
    }
    return encodeShared(genes, mode);
  }
  return x.map((v, k) => {
    const i = sharedIndices(mode, base.length)[k];
    return i >= 27 && i < 31 ? v : reflect(v, ...sharedRanges(base.length)[i]);
  });
}
const good = (r: RobotView) =>
  r.outcome !== "jumped" && r.outcome !== "invalid";
const repeated = (r: RobotView) =>
  r.frame.gait.steps.filter((n) => n >= 2).length;
const four = (r: RobotView) => r.frame.gait.steps.every((n) => n > 0);
const directionEligible = (r: RobotView) =>
  good(r) &&
  r.frame.gait.steps.every((n) => n >= 2) &&
  r.frame.gait.walkingTime >= 8 &&
  r.frame.gait.longestWalking >= 3 &&
  r.frame.gait.supportTime >= 8;
export function sharedFitness(
  r: RobotView,
  mode: SharedMode,
  target: number,
  config: Config,
) {
  if (mode === "balance") return r.fitness;
  const g = r.frame.gait,
    activities = g.stepActivity ?? [0, 0, 0, 0],
    support = Math.min(1, g.supportTime / 8);
  if (mode === "cycles") {
    const own =
      Math.min(3, g.steps[target]) +
      1.5 * (g.footProgress?.[target] ?? 0) +
      Math.min(1, activities[target] / 0.7);
    const others =
      g.steps.reduce(
        (sum, n, l) => sum + (l === target ? 0 : Math.min(2, n)),
        0,
      ) +
      activities.reduce(
        (sum, n, l) => sum + (l === target ? 0 : Math.min(1, n)),
        0,
      );
    return (
      support * (own + 0.15 * others) +
      (0.15 * g.supportTime) / config.duration +
      0.3 * Math.min(1, g.groundedForward) +
      0.2 * (g.weightShift?.[target] ?? 0) -
      (r.outcome === "fallen" ? 0.15 : 0) -
      0.2 * g.airTime
    );
  }
  if (mode === "direction")
    return (
      g.walkingTime +
      g.longestWalking +
      4 * r.frame.distance +
      2 * Math.min(2, g.groundedForward) +
      Math.min(1, Math.min(...activities) / 0.4) -
      3 * (g.lateralDeviation ?? g.lateralTravel) -
      2 * (g.headingDeviation ?? g.yawTravel) -
      (r.outcome === "fallen" ? 1 : 0) -
      0.1 * r.score.penalty
    );
  const course = Math.log1p(
    (g.lateralDeviation ?? g.lateralTravel) /
      config.curriculum.maxLateralDeviation +
      (g.headingDeviation ?? g.yawTravel) /
        config.curriculum.maxHeadingDeviation,
  );
  return (
    2 * g.steps.filter((n) => n > 0).length +
    repeated(r) +
    0.5 * g.walkingTime +
    0.3 * Math.min(2, g.groundedForward) +
    (0.2 * g.supportTime) / config.duration +
    0.1 * activities.reduce((sum, n) => sum + n, 0) -
    0.4 * course -
    (r.outcome === "fallen" ? 0.8 : 0) -
    0.1 * r.score.penalty
  );
}
const widths = (mode: SharedMode, count: number) =>
  sharedIndices(mode, count).map((i) =>
    mode === "balance"
      ? [0.015, 0.25, 0.04][i % 9]
      : mode === "reflex"
        ? i >= 41
          ? 0.003
          : i >= 38
            ? 0.015
            : i >= 32
              ? 0.15
              : i === 31
                ? 0.02
                : i >= 27
                  ? 0.2
                  : i === 0
                    ? 0.005
                    : 0.02
        : mode === "direction"
          ? i >= 41
            ? 0.003
            : i >= 38
              ? 0.015
              : i >= 32
                ? 0.1
                : i === 31
                  ? 0.02
                  : i >= 27
                    ? 0.15
                    : [0, 9, 18].includes(i)
                      ? 0.005
                      : 0.02
          : i === 31
            ? 0.08
            : i >= 27
              ? 0.3
              : i % 9 === 0
                ? 0.01
                : i % 9 >= 7
                  ? 0.07
                  : 0.15,
  );
const sortedFitness = (robots: RobotView[]) =>
  [...robots].sort((a, b) => b.fitness - a.fitness || a.id - b.id);
export function sharedPlan(
  robots: RobotView[],
  config: Config,
  stage: TrainingStage,
  generation: number,
  state: SharedSearchState | null,
) {
  const ordered = sortedFitness(robots),
    valid = ordered.filter(good),
    fallback = valid.length ? valid : ordered;
  let mode: SharedMode =
    stage === "balance"
      ? "balance"
      : state?.mode && state.mode !== "balance"
        ? state.mode
        : "cycles";
  if (stage !== "balance") {
    if (fallback.some(directionEligible)) mode = "direction";
    else if (
      fallback.some(
        (r) => four(r) && repeated(r) >= 3 && r.frame.gait.supportTime >= 2,
      ) ||
      mode === "reflex" ||
      mode === "direction"
    )
      mode = "reflex";
  }
  let pool =
    mode === "balance"
      ? fallback
      : mode === "direction"
        ? fallback.filter(directionEligible)
        : mode === "reflex"
          ? fallback.filter(
              (r) =>
                four(r) && repeated(r) >= 3 && r.frame.gait.supportTime >= 2,
            )
          : fallback.filter((r) => r.frame.gait.supportTime >= 2);
  if (!pool.length) pool = fallback;
  let target =
    mode === "cycles" && state?.mode === "cycles" ? state.target : -1;
  const reference = [...pool].sort(
    (a, b) =>
      repeated(b) - repeated(a) ||
      b.frame.gait.supportTime - a.frame.gait.supportTime ||
      b.fitness - a.fitness,
  )[0];
  if (
    mode === "cycles" &&
    (target < 0 ||
      (reference.frame.gait.steps[target] >= 2 &&
        (reference.frame.gait.stepActivity?.[target] ?? 0) >= 0.2) ||
      (state?.stagnation ?? 0) >= 15)
  ) {
    const steps = reference.frame.gait.steps,
      min = Math.min(...steps.map((n) => Math.min(2, n))),
      legs = [0, 1, 2, 3].filter((l) => Math.min(2, steps[l]) === min);
    target = legs[(config.seed + generation) % legs.length];
  }
  const score = (r: RobotView) => sharedFitness(r, mode, target, config),
    ranked = [...pool].sort(
      (a, b) => score(b) - score(a) || b.fitness - a.fitness || a.id - b.id,
    );
  let founder = ranked[0];
  if (mode === "balance")
    founder = fallback.find((r) => meetsStage(r, "balance", config)) ?? founder;
  const copies: RobotView[] = [ordered[0]];
  for (const r of [
    founder,
    fallback.find((r) => meetsStage(r, "balance", config)),
  ])
    if (
      r &&
      !copies.some((p) => p.id === r.id) &&
      copies.length < config.population - 1
    )
      copies.push(r);
  const mu = Math.min(config.parentCount, config.population - copies.length),
    ids = new Set(state?.draws.map(([id]) => id) ?? []),
    parents = ranked.filter((r) => ids.has(r.id)).slice(0, mu);
  const same = Boolean(
    state &&
    sharedIndices(mode, state.base.length, state.version).join(",") ===
      sharedIndices(mode, state.base.length).join(",") &&
    state.mode === mode &&
    state.target === target &&
    state.askedGeneration === generation &&
    state.optimizer.mu === mu,
  );
  const reusable =
    same &&
    parents.length === mu &&
    (mode === "balance" ||
      score(parents[0]) + (mode === "cycles" ? 0.5 : 0.25) >= score(founder)) &&
    (state!.stagnation < 20 || mode === "balance");
  return { mode, target, score, founder, copies, mu, parents, reusable, same };
}
export function sharedParents(
  robots: RobotView[],
  config: Config,
  stage: TrainingStage,
  generation: number,
  state: SharedSearchState | null,
) {
  const plan = sharedPlan(robots, config, stage, generation, state);
  return plan.reusable ? plan.parents.map((r) => r.id) : [plan.founder.id];
}
export function breedSharedSearch(
  robots: RobotView[],
  config: Config,
  rng: Random,
  generation: number,
  stage: TrainingStage,
  state: SharedSearchState | null,
): { population: Individual[]; state: SharedSearchState } {
  const plan = sharedPlan(robots, config, stage, generation, state),
    { mode, target, founder, mu } = plan,
    strength = (config.mutationScale / 0.03) * Math.sqrt(config.mutation / 0.1),
    base = [...(plan.reusable ? state!.base : founder.genes)],
    std = widths(mode, base.length).map((w) => w * strength);
  const optimizer = plan.reusable
    ? CovarianceSearch.restore(state!.optimizer)
    : new CovarianceSearch(
        encodeShared(base, mode),
        plan.same && state!.stagnation < 20
          ? Math.max(0.15, state!.optimizer.sigma * 0.8)
          : 1,
        mu,
        plan.same && state!.stagnation < 20
          ? state!.optimizer.C.map((row) =>
              row.map((v) => v * (strength / state!.strength) ** 2),
            )
          : std.map((w, i) => std.map((_, j) => (i === j ? w * w : 0))),
      );
  const draws = new Map(state?.draws ?? []);
  if (plan.reusable) {
    optimizer.update(plan.parents.map((r) => draws.get(r.id)!));
    optimizer.sigma = Math.max(1e-8, Math.min(100, optimizer.sigma));
    // Strength belongs to the covariance scale. Scaling only sigma loses a
    // user change when the next rejected batch reaches the sigma floor.
    const ratio = strength / state!.strength;
    optimizer.C = optimizer.C.map((row) => row.map((v) => v * ratio * ratio));
    optimizer.pc = optimizer.pc.map((v) => v * ratio);
    optimizer.D = optimizer.D.map((v) => v * ratio);
  }
  const records = plan.reusable
    ? plan.parents.map((p, i) => ({
        id: p.id,
        genes: [...p.genes],
        latent: [...draws.get(p.id)!],
        weight: optimizer.weights[i],
      }))
    : [
        {
          id: founder.id,
          genes: [...founder.genes],
          latent: encodeShared(founder.genes, mode),
          weight: 1,
        },
      ];
  const center = decodeShared(base, optimizer.mean, mode),
    population: Individual[] = plan.copies.map((p, i) => ({
      id: i + 1,
      genes: [...p.genes],
      parents: [p.id],
      champion: i === 0,
      birth: {
        generation,
        kind:
          i === 0
            ? "elite"
            : p.id === founder.id && mode !== "balance"
              ? "explorer"
              : "stage-anchor",
        parentGenes: [...p.genes],
        changedGenes: [],
      },
    })),
    next: [number, number[]][] = [];
  let mirror: number[] | null = null;
  while (population.length < config.population) {
    const raw: number[] = mirror ?? optimizer.sample(rng);
    if (mirror) mirror = null;
    else mirror = raw.map((v, i) => 2 * optimizer.mean[i] - v);
    const latent = repair(base, raw, mode),
      genes = decodeShared(base, latent, mode),
      parentGenes = plan.reusable ? center : founder.genes,
      changed = genes.flatMap((v, i) => (v !== parentGenes[i] ? [i] : [])),
      id = population.length + 1;
    next.push([id, latent]);
    population.push({
      id,
      genes,
      champion: false,
      parents: records.map((p) => p.id),
      birth: {
        generation,
        kind: plan.reusable
          ? "recombination"
          : changed.length
            ? "mutation"
            : "copy",
        mutationScope: "shared-covariance",
        parentGenes: [...parentGenes],
        recombination: plan.reusable ? structuredClone(records) : undefined,
        changedGenes: changed,
      },
    });
  }
  const peak = plan.same
      ? Math.max(state!.peak, plan.score(founder))
      : plan.score(founder),
    stagnation =
      plan.same && plan.score(founder) <= state!.peak + 1e-5
        ? state!.stagnation + 1
        : 0;
  return {
    population,
    state: {
      version: SHARED_SEARCH_VERSION,
      mode,
      base,
      optimizer: optimizer.state(),
      draws: next,
      askedGeneration: generation + 1,
      target,
      strength,
      peak,
      stagnation,
    },
  };
}
export function validateSharedState(
  s: SharedSearchState,
  population: Individual[],
  generation: number,
  config: Config,
  stage: TrainingStage,
) {
  const dimensions = sharedIndices(s.mode, s.base.length, s.version).length,
    optimizer = CovarianceSearch.restore(s.optimizer),
    samples = population.filter(
      (p) => p.birth?.mutationScope === "shared-covariance",
    ),
    ids = new Set(s.draws.map(([id]) => id));
  if (
    !useSharedSearch(config) ||
    ![
      "shared-covariance-v1",
      "shared-covariance-v2",
      "shared-covariance-v3",
    ].includes(s.version) ||
    s.base.length !== sharedGeneCount(config.controllerModel) ||
    optimizer.n !== dimensions ||
    s.askedGeneration !== generation ||
    ids.size !== s.draws.length ||
    samples.length !== s.draws.length ||
    s.optimizer.mu > config.parentCount ||
    s.optimizer.mu > config.population - 1 ||
    s.strength <= 0 ||
    !Number.isFinite(s.peak) ||
    (s.mode === "balance") !== (stage === "balance") ||
    (s.mode === "cycles" ? s.target < 0 || s.target > 3 : s.target !== -1)
  )
    throw new Error("공통 제어 탐색 상태 오류");
  for (const [id, x] of s.draws) {
    const p = samples.find((p) => p.id === id);
    if (
      !p ||
      x.length !== dimensions ||
      x.some((v) => !Number.isFinite(v)) ||
      decodeShared(s.base, x, s.mode, s.version).some(
        (v, i) => Math.abs(v - p.genes[i]) > 1e-9,
      )
    )
      throw new Error("공통 제어 표본과 유전자 불일치");
  }
  for (const p of samples) {
    const b = p.birth!;
    if (b.kind !== "recombination") continue;
    const records = b.recombination!;
    if (
      records.length !== optimizer.mu ||
      records.some(
        (r, k) =>
          r.latent.length !== dimensions ||
          Math.abs(r.weight - optimizer.weights[k]) > 1e-10 ||
          decodeShared(s.base, r.latent, s.mode, s.version).some(
            (v, i) => Math.abs(v - r.genes[i]) > 1e-9,
          ),
      )
    )
      throw new Error("공통 제어 재조합 부모 오류");
    const latent = optimizer.mean.map((_, k) =>
        records.reduce((sum, r) => sum + r.weight * r.latent[k], 0),
      ),
      center = decodeShared(s.base, latent, s.mode, s.version);
    if (
      center.some((v, i) => Math.abs(v - b.parentGenes[i]) > 1e-9) ||
      latent.some((v, k) => Math.abs(v - optimizer.mean[k]) > 1e-9)
    )
      throw new Error("공통 제어 재조합 중심 오류");
  }
}
