import {
  sharedInitialRanges,
  sharedGeneCount,
  isSharedModel,
} from "../controllers/shared";
import { breedShared } from "./sharedMutation";
import { isPracticeReward } from "../physics/assessment";
import type {
  Config,
  Individual,
  RobotView,
  ParentChoice,
  MutationKind,
  MutationProfile,
  SearchPlan,
  Stat,
  TrainingStage,
} from "../simulation/types";
export class Random {
  constructor(public state: number) {
    this.state >>>= 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal() {
    return (
      Math.sqrt(-2 * Math.log(Math.max(this.next(), 1e-12))) *
      Math.cos(2 * Math.PI * this.next())
    );
  }
  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
export { GENE_NAMES } from "../controllers/genome";
import {
  initialBalanceOffsets,
  PROPRIO_OFFSET,
  PERIODIC_OFFSET,
  JOINT_LIMITS,
  geneCount,
  assemblyAngle,
  GENE_RANGES,
  INITIAL_RANGES,
  OUTPUT_OFFSET,
  OUTPUT_STRIDE,
  OUTPUT_SIZE,
  FREQUENCY_INDEX,
  INPUT_SIZE,
  HIDDEN_SIZE,
  HIDDEN_STRIDE,
} from "../controllers/genome";
export const RANGES = GENE_RANGES;
export const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));
export function randomGenes(rng: Random, config?: Config): number[] {
  if (config && isSharedModel(config.controllerModel)) {
    const g = sharedInitialRanges(sharedGeneCount(config.controllerModel)).map(
      ([lo, hi]) => lo + (hi - lo) * rng.next(),
    );
    const prior = initialBalanceOffsets(config);
    if (
      config.initialization === "weak-balance" &&
      config.initialBalanceBias > 0
    )
      for (let j = 0; j < 3; j++)
        g[j * 9] +=
          prior[j] -
          config.initialBalanceBias * g[j * 9 + 1] * assemblyAngle(j);
    return g;
  }
  const genes = INITIAL_RANGES.slice(0, geneCount(config)).map(
    ([a, b]) => a + (b - a) * rng.next(),
  );
  if (config)
    initialBalanceOffsets(config).forEach((offset, j) => {
      genes[OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE] += offset;
    });
  if (
    config?.controllerModel !== undefined &&
    config.controllerModel !== "timed-rnn" &&
    config.initialization === "weak-balance" &&
    config.initialBalanceBias > 0
  )
    for (let j = 0; j < 12; j++)
      genes[OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE] -=
        config.initialBalanceBias *
        genes[PROPRIO_OFFSET + j * 2] *
        assemblyAngle(j);
  return genes;
}
// Walking progress and supported locomotion decide selection. Flight time is
// never a primary objective; invalid and jumping trials lose to valid trials.
export function rank(robots: RobotView[]): RobotView[] {
  const rejected = (r: RobotView) =>
    r.outcome === "invalid" || r.outcome === "jumped";
  return [...robots].sort(
    (a, b) =>
      Number(rejected(a)) - Number(rejected(b)) ||
      b.fitness - a.fitness ||
      Math.floor(b.frame.distance * 1000) -
        Math.floor(a.frame.distance * 1000) ||
      b.frame.gait.groundedForward - a.frame.gait.groundedForward ||
      b.frame.gait.supportTime - a.frame.gait.supportTime ||
      a.id - b.id,
  );
}
// Parent diversity changes selection, never the motor outputs or manual choices.
export function behaviorKey(r: RobotView): string {
  const g = r.frame.gait;
  const feet = g.steps.reduce(
    (mask, n, i) => (n > 0 ? mask | (1 << i) : mask),
    0,
  );
  return `${feet}:${Math.min(3, Math.floor(g.groundedForward / 0.1))}:${Math.min(4, Math.floor(g.longestSupport / 0.5))}`;
}
// A single safe exploration seat retains real, settled foot-cycle improvements.
// Progress is not a step and never changes the final walking criteria.
function progressExplorer(
  pool: RobotView[],
  champion: RobotView,
): RobotView | undefined {
  const skill = (r: RobotView, leg: number) =>
    Math.min(2, r.frame.gait.steps[leg]) +
    (r.frame.gait.steps[leg] < 2
      ? 0.9 * (r.frame.gait.footProgress?.[leg] ?? 0) +
        0.1 * (r.frame.gait.weightShift?.[leg] ?? 0)
      : 0);
  const improvement = (r: RobotView) =>
    Math.max(
      0,
      ...[0, 1, 2, 3].map((leg) => skill(r, leg) - skill(champion, leg)),
    );

  return pool
    .filter(
      (r) =>
        r.id !== champion.id &&
        r.outcome !== "jumped" &&
        r.outcome !== "invalid" &&
        r.frame.gait.supportTime >=
          Math.max(2, champion.frame.gait.supportTime * 0.6) &&
        r.fitness >= champion.fitness - 0.5 &&
        improvement(r) > 0.05,
    )
    .sort(
      (a, b) =>
        improvement(b) - improvement(a) || b.fitness - a.fitness || a.id - b.id,
    )[0];
}
export function suggestParents(
  robots: RobotView[],
  count: number,
  stage: TrainingStage = "balance",
  preferMoreFeet = true,
  preferProgress = false,
  newFootGap = preferProgress ? 0.65 : 0.5,
): ParentChoice[] {
  const ordered = rank(robots),
    valid = ordered.filter(
      (r) => r.outcome !== "jumped" && r.outcome !== "invalid",
    ),
    pool = valid.length ? valid : ordered,
    seats = Math.min(count, pool.length);
  if (!seats) return [];
  const reserved = Math.min(2, Math.floor(seats * 0.4)),
    choices: ParentChoice[] = pool
      .slice(0, seats - reserved)
      .map((r) => ({ id: r.id, reason: "fitness" })),
    seen = new Set(pool.slice(0, seats - reserved).map(behaviorKey)),
    floor = pool[0].fitness - Math.max(0.2, Math.abs(pool[0].fitness) * 0.5);
  const remaining = pool.filter((r) => !choices.some((c) => c.id === r.id));
  // Prefer genuinely different foot use before different progress/support bins.
  const masks = new Set(
    pool.slice(0, seats - reserved).map((r) => behaviorKey(r).split(":")[0]),
  );
  // One exploratory seat can preserve an actually stepped, previously unused
  // foot even when the episode falls early. The fitness elite stays untouched.
  if (stage !== "balance" && reserved > 0 && valid.length) {
    const used = pool
      .slice(0, seats - reserved)
      .reduce((mask, r) => mask | Number(behaviorKey(r).split(":")[0]), 0);
    const noveltyPool = preferMoreFeet
      ? [...remaining].sort(
          (a, b) =>
            b.frame.gait.steps.filter((n) => n > 0).length -
              a.frame.gait.steps.filter((n) => n > 0).length ||
            b.fitness - a.fitness ||
            a.id - b.id,
        )
      : remaining;
    const novel = noveltyPool.find(
      (r) =>
        r.frame.gait.supportTime >= (preferProgress ? 2 : 0.5) &&
        r.fitness >= pool[0].fitness - newFootGap &&
        (Number(behaviorKey(r).split(":")[0]) & ~used) !== 0,
    );
    if (novel) {
      choices.push({ id: novel.id, reason: "new-foot" });
      seen.add(behaviorKey(novel));
      masks.add(behaviorKey(novel).split(":")[0]);
    }
  }
  if (preferProgress && stage !== "balance" && choices.length < seats) {
    const progress = progressExplorer(pool, pool[0]);
    if (progress && !choices.some((c) => c.id === progress.id))
      choices.push({ id: progress.id, reason: "foot-progress" });
  }
  for (const footOnly of [true, false])
    for (const r of remaining) {
      const key = behaviorKey(r),
        mask = key.split(":")[0];
      if (choices.length >= seats) break;
      if (
        choices.some((c) => c.id === r.id) ||
        r.fitness < floor ||
        seen.has(key) ||
        (footOnly && (mask === "0" || masks.has(mask)))
      )
        continue;
      choices.push({ id: r.id, reason: "diversity" });
      seen.add(key);
      masks.add(mask);
    }
  for (const r of remaining) {
    if (choices.length >= seats) break;
    if (!choices.some((c) => c.id === r.id))
      choices.push({ id: r.id, reason: "fitness" });
  }
  return choices;
}
// Distance charts and recorded walking ghosts retain their distance meaning.
export function rankDistance(robots: RobotView[]): RobotView[] {
  return [...robots].sort(
    (a, b) =>
      Math.floor(b.frame.distance * 1000) -
        Math.floor(a.frame.distance * 1000) ||
      b.fitness - a.fitness ||
      a.reachedTick - b.reachedTick ||
      a.id - b.id,
  );
}
// Derive the next search from completed observations; no hidden adaptation state.
// A fall cannot tell us which weight caused it, so preserve fine search while
// sampling larger changes rather than applying a supposed corrective torque.
export function planSearch(
  robots: RobotView[],
  history: Stat[],
  config: Config,
  stage: TrainingStage,
  promotionPending = false,
): SearchPlan {
  const failureRate = robots.length
    ? robots.filter((r) => ["fallen", "jumped", "invalid"].includes(r.outcome))
        .length / robots.length
    : 0;
  const recent = history.filter((h) => h.stage === stage).slice(-5);
  const improved =
    recent.length > 1 &&
    recent
      .slice(1)
      .some(
        (h) =>
          h.bestFitness > recent[0].bestFitness + 0.01 ||
          (stage === "balance" &&
            h.maxSupportTime > recent[0].maxSupportTime + 0.15) ||
          (stage !== "balance" &&
            (h.maxFootCount > recent[0].maxFootCount ||
              h.maxWalkingTime > recent[0].maxWalkingTime + 0.25 ||
              h.bestDistanceM > recent[0].bestDistanceM + 0.02)),
      );
  const mode: SearchPlan["mode"] =
    !config.adaptiveSearch || config.mutation === 0 || promotionPending
      ? "normal"
      : recent.length === 5 && !improved
        ? "stagnant"
        : failureRate >= 0.7
          ? "recovery"
          : "normal";
  const cyclicSearch =
    config.controllerModel === "local-periodic-rnn" &&
    stage !== "balance" &&
    config.adaptiveSearch &&
    config.mutation > 0 &&
    config.mutation < 1 &&
    !promotionPending;
  const fractions =
    cyclicSearch && mode === "normal"
      ? [0.55, 0.25, 0.15, 0.05]
      : mode === "stagnant"
        ? [0.4, 0.2, 0.2, 0.2]
        : mode === "recovery"
          ? [0.55, 0.25, 0.1, 0.1]
          : [1, 0, 0, 0];
  const slots = config.population - 1;
  const shares = fractions.map((f) => f * slots),
    counts = shares.map(Math.floor);
  const order = shares
    .map((n, i) => ({ i, remainder: n - counts[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remainder = slots - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) counts[order[i].i]++;
  if (mode !== "normal" && slots >= 3 && counts[3] === 0) {
    const donor = [0, 1, 2].sort((a, b) => counts[b] - counts[a] || a - b)[0];
    counts[donor]--;
    counts[3]++;
  }
  const autoIds =
    config.adaptiveSearch && config.mutation > 0 && stage !== "balance"
      ? new Set(
          suggestParents(
            robots,
            config.parentCount,
            stage,
            true,
            isPracticeReward(config.rewardModel),
            config.controllerModel === "local-periodic-rnn" ? 0.9 : undefined,
          ).map((c) => c.id),
        )
      : new Set<number>();
  const ordered = rank(robots),
    champion = ordered[0];
  const championMask = champion
    ? Number(behaviorKey(champion).split(":")[0])
    : 0;
  let preservedParentId: number | undefined = ordered
    .filter(
      (r) =>
        autoIds.has(r.id) &&
        r.id !== champion?.id &&
        r.outcome !== "jumped" &&
        r.outcome !== "invalid" &&
        r.frame.gait.supportTime >= 0.5 &&
        r.fitness >=
          champion.fitness -
            (config.controllerModel === "local-periodic-rnn"
              ? 0.9
              : isPracticeReward(config.rewardModel)
                ? 0.65
                : 0.5) &&
        r.frame.gait.supportTime >=
          (isPracticeReward(config.rewardModel) ? 2 : 0.5) &&
        (Number(behaviorKey(r).split(":")[0]) & ~championMask) !== 0,
    )
    .sort(
      (a, b) =>
        b.frame.gait.steps.filter((n) => n > 0).length -
          a.frame.gait.steps.filter((n) => n > 0).length ||
        b.fitness - a.fitness ||
        a.id - b.id,
    )[0]?.id;
  if (
    preservedParentId === undefined &&
    champion &&
    isPracticeReward(config.rewardModel) &&
    stage !== "balance" &&
    config.adaptiveSearch &&
    config.mutation > 0
  ) {
    preservedParentId = progressExplorer(
      ordered.filter((r) => autoIds.has(r.id)),
      champion,
    )?.id;
  }
  const preserved = preservedParentId !== undefined && counts[0] > 0 ? 1 : 0;
  counts[0] -= preserved;
  const preserveBalance =
    stage !== "balance" &&
    isPracticeReward(config.rewardModel) &&
    config.adaptiveSearch &&
    config.mutation > 0 &&
    config.mutation < 1;
  const scale = (value: number, divisor: number) =>
    preserveBalance ? Math.max(0.0001, value / divisor) : value;
  return {
    preservedParentId: preserved ? preservedParentId : undefined,
    stage,
    mode,
    failureRate,
    counts: {
      preserved,
      small: counts[0],
      medium: counts[1],
      large: counts[2],
      immigrant: counts[3],
    },
    profiles: {
      small: {
        kind: "small",
        rate: config.mutation,
        scale: scale(config.mutationScale, 30),
      },
      medium: {
        kind: "medium",
        rate: Math.min(1, config.mutation * 2),
        scale: cyclicSearch
          ? Math.max(0.015, scale(Math.min(0.5, config.mutationScale * 3), 12))
          : scale(Math.min(0.5, config.mutationScale * 3), 12),
      },
      large: {
        kind: "large",
        rate: Math.min(1, config.mutation * 3.5),
        scale: cyclicSearch
          ? Math.max(0.08, scale(Math.min(0.5, config.mutationScale * 8), 8))
          : scale(Math.min(0.5, config.mutationScale * 8), 8),
      },
    },
  };
}
export function breed(
  robots: RobotView[],
  selected: number[],
  config: Config,
  rng: Random,
  sourceGeneration = 1,
  search: boolean | SearchPlan = false,
): Individual[] {
  if (isSharedModel(config.controllerModel))
    return breedShared(rank(robots), selected, config, rng, sourceGeneration);
  const ordered = rank(robots),
    pool = ordered.filter((r) => selected.includes(r.id));
  if (!pool.length) throw new Error("부모를 한 개체 이상 선택하세요.");
  const champion = ordered[0];
  const children: Individual[] = [
    {
      id: 1,
      genes: [...champion.genes],
      champion: true,
      parents: [champion.id],
      birth: {
        generation: sourceGeneration,
        kind: "elite",
        parentGenes: [...champion.genes],
        changedGenes: [],
      },
    },
  ];
  // Each selected parent contributes in turn. A manual selection never silently
  // loses its offspring to another tournament; only the official elite is exempt.
  const plan = typeof search === "object" ? search : null;
  const explorer =
    plan?.preservedParentId !== undefined
      ? pool.find(
          (r) => r.id === plan.preservedParentId && r.id !== champion.id,
        )
      : undefined;
  if (explorer)
    children.push({
      id: 2,
      genes: [...explorer.genes],
      champion: false,
      parents: [explorer.id],
      birth: {
        generation: sourceGeneration,
        kind: "explorer",
        parentGenes: [...explorer.genes],
        changedGenes: [],
      },
    });
  const anchor =
    plan?.anchorParentId !== undefined
      ? pool.find(
          (r) =>
            r.id === plan.anchorParentId &&
            r.id !== champion.id &&
            r.id !== explorer?.id,
        )
      : undefined;
  if (anchor)
    children.push({
      id: children.length + 1,
      genes: [...anchor.genes],
      champion: false,
      parents: [anchor.id],
      birth: {
        generation: sourceGeneration,
        kind: "stage-anchor",
        parentGenes: [...anchor.genes],
        changedGenes: [],
      },
    });
  const explorerCount = explorer ? 1 : 0,
    anchorCount = anchor ? 1 : 0;
  const preservedCount = explorerCount + anchorCount;
  const immigrants = plan
    ? plan.counts.immigrant
    : search
      ? Math.max(1, Math.floor(config.population * 0.1))
      : 0;
  const kinds: MutationKind[] = plan
    ? (["small", "medium", "large"] as const).flatMap((kind) =>
        Array<MutationKind>(
          plan.counts[kind] +
            (kind === "small"
              ? plan.counts.preserved -
                explorerCount +
                (plan.anchorCount ?? 0) -
                anchorCount
              : 0),
        ).fill(kind),
      )
    : Array<MutationKind>(config.population - 1 - immigrants).fill("small");
  // Spread mutation sizes across selected parents rather than assigning an
  // entire parent lineage to one search size. Normal breeding keeps its RNG path.
  if (kinds.some((kind) => kind !== "small"))
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
  while (children.length < config.population - immigrants) {
    const kind = kinds[children.length - 1 - preservedCount];
    const walkingStage =
      plan?.stage === "stepping" || plan?.stage === "forward";
    const baseProfile: MutationProfile = plan?.profiles[kind] ?? {
      kind: "small",
      rate: config.mutation,
      scale: config.mutationScale,
    };
    const profile = { ...baseProfile };
    const proprio = config.controllerModel !== "timed-rnn",
      periodic = config.controllerModel === "local-periodic-rnn";
    const focusedReflex =
      proprio &&
      plan?.stage === "balance" &&
      kind === "large" &&
      config.adaptiveSearch &&
      config.mutation > 0 &&
      config.mutation < 1 &&
      rng.next() < 0.5;
    if (focusedReflex) profile.scale = Math.max(profile.scale, 0.4);
    const preserveBalance =
      walkingStage &&
      isPracticeReward(config.rewardModel) &&
      config.adaptiveSearch &&
      config.mutation > 0 &&
      config.mutation < 1;

    if (
      walkingStage &&
      !preserveBalance &&
      kind === "small" &&
      plan?.mode === "stagnant" &&
      config.mutation > 0 &&
      config.mutation < 1 &&
      rng.next() < 0.5
    )
      profile.scale = Math.max(0.001, profile.scale / 10);
    const a = pool[(children.length - 1 - preservedCount) % pool.length],
      alternatives = pool.filter(
        (r) =>
          r.id !== a.id &&
          (proprio ||
            !preserveBalance ||
            r.genes.slice(0, OUTPUT_OFFSET).every((v, i) => v === a.genes[i])),
      ),
      cross = alternatives.length > 0 && rng.next() < config.crossover,
      b = cross ? rng.pick(alternatives) : a;
    const genes = proprio
      ? [...a.genes]
      : a.genes.map((value, i) =>
          cross && rng.next() < 0.5 ? b.genes[i] : value,
        );
    // These connections share physical meaning across parents; unrelated RNN
    // hidden bases are never mixed into an inherited balance policy.
    if (proprio && cross)
      for (let j = 0; j < 12; j++)
        if (rng.next() < 0.5) {
          const index = PROPRIO_OFFSET + j * 2,
            bias = OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE;
          const candidate =
            a.genes[bias] -
            (b.genes[index] - a.genes[index]) * assemblyAngle(j) -
            (periodic
              ? b.genes[PERIODIC_OFFSET + j * 2 + 1] -
                a.genes[PERIODIC_OFFSET + j * 2 + 1]
              : 0);
          if (candidate >= RANGES[bias][0] && candidate <= RANGES[bias][1]) {
            genes[index] = b.genes[index];
            genes[bias] = candidate;
            if (periodic) {
              genes[PERIODIC_OFFSET + j * 2] = b.genes[PERIODIC_OFFSET + j * 2];
              genes[PERIODIC_OFFSET + j * 2 + 1] =
                b.genes[PERIODIC_OFFSET + j * 2 + 1];
            }
          }
          genes[index + 1] = b.genes[index + 1];
        }
    const inherited = proprio ? [...genes] : [];
    const mutate = (indices: number[]) => {
      const relativeDelta = (rng.next() * 2 - 1 || 0.5) * profile.scale;
      for (const i of indices) {
        const [lo, hi] = RANGES[i],
          value = genes[i],
          delta = (hi - lo) * relativeDelta;
        const next = value + delta;
        genes[i] = clamp(next < lo || next > hi ? value - delta : next, lo, hi);
      }
    };
    const local = kind === "small" && profile.rate < 1 && rng.next() < 0.5,
      selectedJoint = Math.floor(rng.next() * OUTPUT_SIZE),
      leg = Math.floor(selectedJoint / 3),
      legStart = OUTPUT_OFFSET + leg * 3 * OUTPUT_STRIDE,
      jointType = kind === "medium" ? Math.floor(rng.next() * 3) : 0,
      grouped = kind === "medium" && (!walkingStage || rng.next() < 0.5),
      column =
        kind === "small" &&
        !local &&
        walkingStage &&
        config.mutation < 1 &&
        rng.next() < 0.5;
    // Search a missing movement more often, without prescribing its torque,
    // phase, pose or trajectory. Every joint retains a chance of being explored.
    const inactiveLegs = a.frame.gait.steps.flatMap((n, l) =>
      (
        periodic
          ? n < 2 || (a.frame.gait.stepActivity?.[l] ?? 0) < 0.35
          : n === 0
      )
        ? [l]
        : [],
    );
    const focusedJoint =
      kind === "large" &&
      walkingStage &&
      config.mutation < 1 &&
      inactiveLegs.length > 0 &&
      rng.next() < 0.5
        ? rng.pick(inactiveLegs) * 3 + Math.floor(rng.next() * 3)
        : selectedJoint;
    let mutable: number[][],
      scope: NonNullable<NonNullable<Individual["birth"]>["mutationScope"]>;
    const sparseLarge =
      kind === "large" &&
      walkingStage &&
      config.mutation > 0 &&
      config.mutation < 1 &&
      rng.next() < 0.5;
    const focusedTime =
      periodic &&
      walkingStage &&
      kind === "large" &&
      config.mutation > 0 &&
      config.mutation < 1 &&
      rng.next() < 0.7;
    if (focusedTime) {
      scope = "leg-time";
      const leg = Math.floor(focusedJoint / 3);
      mutable = Array.from({ length: 6 }, (_, i) => [
        PERIODIC_OFFSET + leg * 6 + i,
      ]);
    } else if (focusedReflex) {
      const stopped = a.frame.angles.flatMap((angle, j) => {
        const [lo, hi] = JOINT_LIMITS[j];
        return Math.min(angle - lo, hi - angle) / (hi - lo) < 0.03 ? [j] : [];
      });
      const joint =
        stopped.length && rng.next() < 0.5 ? rng.pick(stopped) : selectedJoint;
      scope = "joint-feedback";
      mutable = [[PROPRIO_OFFSET + joint * 2 + (rng.next() < 0.75 ? 0 : 1)]];
    } else if (sparseLarge) {
      const connection = Math.floor(rng.next() * OUTPUT_STRIDE);
      const tied = rng.next() < 0.5;
      scope = tied ? "group-coordinate" : "output-coordinate";
      mutable = [
        tied
          ? Array.from(
              { length: 4 },
              (_, l) =>
                OUTPUT_OFFSET +
                (l * 3 + (focusedJoint % 3)) * OUTPUT_STRIDE +
                connection,
            )
          : [OUTPUT_OFFSET + focusedJoint * OUTPUT_STRIDE + connection],
      ];
    } else if (
      preserveBalance &&
      (kind === "large" || (!local && !column)) &&
      rng.next() < 0.8
    ) {
      scope = "output-network";
      mutable = Array.from({ length: genes.length - OUTPUT_OFFSET }, (_, i) => [
        OUTPUT_OFFSET + i,
      ]);
    } else if (config.mutation === 1 || kind === "large") {
      scope = "network";
      mutable = genes.map((_, i) => [i]);
    } else if (kind === "medium" && grouped) {
      scope = "joint-group";
      mutable = [
        ...Array.from({ length: OUTPUT_STRIDE }, (_, connection) =>
          Array.from(
            { length: 4 },
            (_, leg) =>
              OUTPUT_OFFSET +
              (leg * 3 + jointType) * OUTPUT_STRIDE +
              connection,
          ),
        ),
        [FREQUENCY_INDEX],
        ...(periodic
          ? Array.from({ length: 2 }, (_, d) =>
              Array.from(
                { length: 4 },
                (_, l) => PERIODIC_OFFSET + (l * 3 + jointType) * 2 + d,
              ),
            )
          : []),
        ...(proprio
          ? Array.from({ length: 2 }, (_, d) =>
              Array.from(
                { length: 4 },
                (_, l) => PROPRIO_OFFSET + (l * 3 + jointType) * 2 + d,
              ),
            )
          : []),
      ];
    } else if (kind === "medium") {
      scope = "leg";
      mutable = [
        ...(periodic
          ? Array.from({ length: 6 }, (_, i) => [PERIODIC_OFFSET + leg * 6 + i])
          : []),
        ...Array.from({ length: 3 * OUTPUT_STRIDE }, (_, i) => [legStart + i]),
        [FREQUENCY_INDEX],
        ...(proprio
          ? Array.from({ length: 6 }, (_, d) => [PROPRIO_OFFSET + leg * 6 + d])
          : []),
      ];
    } else if (local) {
      scope = walkingStage ? "leg" : "joint";
      const block = walkingStage
        ? legStart
        : OUTPUT_OFFSET + selectedJoint * OUTPUT_STRIDE;
      mutable = Array.from(
        { length: walkingStage ? 3 * OUTPUT_STRIDE : OUTPUT_STRIDE },
        (_, i) => [block + i],
      );
      if (periodic)
        mutable.push(
          ...Array.from({ length: walkingStage ? 6 : 2 }, (_, i) => [
            PERIODIC_OFFSET + (walkingStage ? leg * 6 : selectedJoint * 2) + i,
          ]),
        );
      if (proprio)
        mutable.push(
          ...Array.from({ length: walkingStage ? 6 : 2 }, (_, d) => [
            PROPRIO_OFFSET + (walkingStage ? leg * 6 : selectedJoint * 2) + d,
          ]),
        );
    } else if (column) {
      scope = "sensor-column";
      const input = Math.floor(rng.next() * INPUT_SIZE);
      mutable = Array.from({ length: HIDDEN_SIZE }, (_, h) => [
        h * HIDDEN_STRIDE + input,
      ]);
      if (periodic && input >= 42)
        mutable.push(
          ...Array.from({ length: 12 }, (_, j) => [
            PERIODIC_OFFSET + j * 2 + input - 42,
          ]),
        );
      if (proprio && input < 24)
        mutable.push([
          PROPRIO_OFFSET + (input % 12) * 2 + (input >= 12 ? 1 : 0),
        ]);
    } else {
      scope = "network";
      mutable = genes.map((_, i) => [i]);
    }
    // Physical groups define search regions, never a pose, leg sequence or force.
    // Body feedback and corresponding-joint changes complement isolated-leg search.
    let mutationCount = 0;
    mutable.forEach((i) => {
      if (rng.next() < profile.rate) {
        mutate(i);
        mutationCount++;
      }
    });
    // A nonzero mutation setting always produces at least one actual mutation.
    if (profile.rate > 0 && mutationCount === 0)
      mutate(mutable[Math.floor(rng.next() * mutable.length)]);
    // Coordinate conditioning changes inherited genes only. It neither adds a
    // runtime angle target nor cancels an intentionally mutated bias.
    if (
      proprio &&
      config.adaptiveSearch &&
      config.mutation > 0 &&
      config.mutation < 1 &&
      scope !== "sensor-column"
    )
      for (let j = 0; j < 12; j++) {
        const gain = PROPRIO_OFFSET + j * 2,
          delta = genes[gain] - inherited[gain],
          cosineDelta = periodic
            ? genes[PERIODIC_OFFSET + j * 2 + 1] -
              inherited[PERIODIC_OFFSET + j * 2 + 1]
            : 0;
        if (!delta && !cosineDelta) continue;
        const bias = OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE,
          candidate = genes[bias] - delta * assemblyAngle(j) - cosineDelta;
        if (candidate >= RANGES[bias][0] && candidate <= RANGES[bias][1])
          genes[bias] = candidate;
      }
    const changedGenes = genes.flatMap((v, i) => (v !== a.genes[i] ? [i] : []));
    children.push({
      id: children.length + 1,
      genes,
      champion: false,
      parents: cross ? [a.id, b.id] : [a.id],
      birth: {
        generation: sourceGeneration,
        kind: cross ? "crossover" : changedGenes.length ? "mutation" : "copy",
        mutationProfile: { ...profile },
        mutationScope: scope,
        parentGenes: [...a.genes],
        changedGenes,
      },
    });
  }
  while (children.length < config.population)
    children.push({
      id: children.length + 1,
      genes: randomGenes(rng, config),
      champion: false,
      parents: [],
      immigrant: true,
    });
  return children;
}

export function lineage(robot: Individual): string {
  if (!robot.parents.length)
    return robot.immigrant ? "새 무작위 탐색" : "초기 무작위 유전자";
  const source = robot.birth ? `${robot.birth.generation}세대 ` : "";
  const parents = robot.parents
    .map((id) => String(id).padStart(2, "0"))
    .join(" + ");
  if (robot.champion) return `${source}부모 ${parents} · 그대로 보존`;
  if (!robot.birth) return `${source}부모 ${parents}`;
  if (robot.birth.kind === "recombination")
    return `${source}부모 ${parents} · 가중 재조합 · ${robot.birth.changedGenes.length}개 변형`;
  if (robot.birth.kind === "stage-anchor")
    return `${source}부모 ${parents} · 균형 계보 그대로 보존`;
  if (robot.birth.kind === "explorer")
    return `${source}부모 ${parents} · 새 발 탐색 계보 그대로 보존`;
  const profileLabel =
    robot.birth.mutationProfile?.kind === "large"
      ? "큰 변이 · "
      : robot.birth.mutationProfile?.kind === "medium"
        ? "중간 변이 · "
        : "";
  return `${source}부모 ${parents} · ${profileLabel}${robot.birth.kind === "crossover" ? "교차 · " : ""}${robot.birth.changedGenes.length}개 변형`;
}
