import { isSharedModel } from "../controllers/shared";
import { meetsStage } from "../simulation/curriculum";
import { CovarianceSearch, type CovarianceState } from "./covariance";
import { landingExplorer, rank, type Random, RANGES } from "./evolution";
import {
  assemblyAngle,
  OUTPUT_OFFSET,
  OUTPUT_STRIDE,
  HIDDEN_SIZE,
  PROPRIO_OFFSET,
  geneCount,
} from "../controllers/genome";
import type {
  Config,
  Individual,
  RobotView,
  TrainingStage,
} from "../simulation/types";
export type BalanceSearchState = {
  version: "balance-covariance-v1" | "balance-covariance-v2";
  base: number[];
  optimizer: CovarianceState;
  draws: [number, number[]][];
  askedGeneration: number;
  strength?: number;
};
const indices = [
  ...Array.from(
    { length: 12 },
    (_, j) => OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE,
  ),
  ...Array.from({ length: 24 }, (_, j) => PROPRIO_OFFSET + j),
];
export const useCovariance = (c: Config, stage: TrainingStage) =>
  c.searchMethod === "covariance" &&
  c.controllerModel !== "timed-rnn" &&
  !isSharedModel(c.controllerModel) &&
  stage === "balance" &&
  c.adaptiveSearch &&
  c.mutation > 0 &&
  c.mutation < 1 &&
  c.crossover === 0;
export function encodeBalance(g: number[]) {
  return indices.map((i, k) =>
    k < 12
      ? (g[i] + g[PROPRIO_OFFSET + k * 2] * assemblyAngle(k)) / 4
      : g[i] / 4,
  );
}
export function decodeBalance(base: number[], x: number[]) {
  const g = [...base];
  indices.forEach((i, k) => (g[i] = 4 * x[k]));
  for (let j = 0; j < 12; j++)
    g[indices[j]] -= g[PROPRIO_OFFSET + j * 2] * assemblyAngle(j);
  return g;
}
const reflect = (v: number) => {
  const t = (((v + 0.5) % 2) + 2) % 2;
  return t <= 1 ? t - 0.5 : 1.5 - t;
};
function qualifyingAnchor(robots: RobotView[], config: Config) {
  if (config.population < 4) return;
  const ordered = rank(robots),
    qualified = ordered.find((r) => meetsStage(r, "balance", config));
  return qualified?.id !== ordered[0].id ? qualified : undefined;
}
function landingAnchor(robots: RobotView[], config: Config) {
  if (config.population < 4) return;
  const candidate = landingExplorer(robots, config);
  return candidate?.id !== qualifyingAnchor(robots, config)?.id
    ? candidate
    : undefined;
}
const parentMu = (robots: RobotView[], config: Config) =>
  Math.min(
    config.parentCount,
    config.population -
      (config.preserveChampion ? 1 : 0) -
      (qualifyingAnchor(robots, config) ? 1 : 0) -
      (landingAnchor(robots, config) ? 1 : 0),
  );
export function covarianceParents(
  robots: RobotView[],
  config: Config,
  state: BalanceSearchState | null,
) {
  const ordered = rank(robots),
    mu = parentMu(robots, config);
  const candidates = state
    ? ordered.filter(
        (r) =>
          state.draws.some(([id]) => id === r.id) &&
          r.outcome !== "jumped" &&
          r.outcome !== "invalid",
      )
    : [];
  return state && state.optimizer.mu === mu && candidates.length >= mu
    ? candidates.slice(0, mu).map((r) => r.id)
    : [ordered[0].id];
}
// Evolve neural weights, never body poses or target angles. The first twelve
// coordinates separate initial holding torque from random feedback slope.
export function breedBalance(
  robots: RobotView[],
  config: Config,
  rng: Random,
  generation: number,
  state: BalanceSearchState | null,
): { population: Individual[]; state: BalanceSearchState } {
  const ordered = rank(robots),
    best = ordered[0],
    mu = parentMu(robots, config);
  const reusable =
    state?.askedGeneration === generation &&
    state.optimizer.mu === mu &&
    robots.filter(
      (r) =>
        state!.draws.some(([id]) => id === r.id) &&
        r.outcome !== "jumped" &&
        r.outcome !== "invalid",
    ).length >= mu;
  const base = reusable ? [...state!.base] : [...best.genes],
    width = (config.mutationScale / 0.03) * Math.sqrt(config.mutation / 0.1);
  const widths = indices.map(
    (_, k) => (k < 12 ? 0.0025 : (k - 12) % 2 === 0 ? 0.05 : 0.01) * width,
  );
  const optimizer = reusable
    ? CovarianceSearch.restore(state!.optimizer)
    : new CovarianceSearch(
        encodeBalance(base),
        1,
        mu,
        indices.map((_, i) =>
          indices.map((_, j) => (i === j ? widths[i] ** 2 : 0)),
        ),
      );
  const ids = covarianceParents(robots, config, reusable ? state : null),
    draws = new Map(state?.draws ?? []),
    parents = ids.map((id) => robots.find((r) => r.id === id)!);
  if (reusable) {
    optimizer.update(parents.map((p) => draws.get(p.id)!));
    optimizer.sigma = Math.max(
      1e-8,
      Math.min(100, (optimizer.sigma * width) / (state!.strength ?? 1)),
    );
  }
  const records = parents.map((p, i) => ({
    id: p.id,
    genes: [...p.genes],
    latent: reusable ? draws.get(p.id)! : encodeBalance(p.genes),
    weight: reusable ? optimizer.weights[i] : 1,
  }));
  const center = decodeBalance(base, optimizer.mean);
  const children: Individual[] = config.preserveChampion
      ? [
          {
            id: 1,
            genes: [...best.genes],
            champion: true,
            parents: [best.id],
            birth: {
              generation,
              kind: "elite",
              parentGenes: [...best.genes],
              changedGenes: [],
            },
          },
        ]
      : [],
    next: [number, number[]][] = [];
  const anchor = qualifyingAnchor(robots, config);
  if (anchor)
    children.push({
      id: children.length + 1,
      genes: [...anchor.genes],
      champion: false,
      parents: [anchor.id],
      birth: {
        generation,
        kind: "stage-anchor",
        parentGenes: [...anchor.genes],
        changedGenes: [],
      },
    });
  const explorer = landingAnchor(robots, config);
  if (explorer)
    children.push({
      id: children.length + 1,
      genes: [...explorer.genes],
      champion: false,
      parents: [explorer.id],
      birth: {
        generation,
        kind: "explorer",
        parentGenes: [...explorer.genes],
        changedGenes: [],
      },
    });
  let mirror: number[] | null = null;
  while (children.length < config.population) {
    const x: number[] = mirror ?? optimizer.sample(rng);
    if (mirror) mirror = null;
    else mirror = x.map((v, i) => 2 * optimizer.mean[i] - v);
    let candidate = x.map(reflect),
      genes = decodeBalance(base, candidate),
      fraction = 1;
    for (const i of indices) {
      const delta = genes[i] - center[i],
        [lo, hi] = RANGES[i];
      if (delta > 0) fraction = Math.min(fraction, (hi - center[i]) / delta);
      else if (delta < 0)
        fraction = Math.min(fraction, (lo - center[i]) / delta);
    }
    if (fraction < 1) {
      candidate = candidate.map(
        (v, i) =>
          optimizer.mean[i] +
          Math.max(0, fraction * 0.999999) * (v - optimizer.mean[i]),
      );
      genes = decodeBalance(base, candidate);
    }
    if (
      genes.length !== geneCount(config) ||
      genes.some(
        (v, i) =>
          !Number.isFinite(v) ||
          v < RANGES[i][0] - 1e-10 ||
          v > RANGES[i][1] + 1e-10,
      )
    )
      throw new Error("분포 탐색 유전자 범위 오류");
    const id = children.length + 1;
    next.push([id, candidate]);
    children.push({
      id,
      genes,
      champion: false,
      parents: ids,
      birth: {
        generation,
        kind: reusable ? "recombination" : "mutation",
        mutationScope: "balance-covariance",
        parentGenes: reusable ? [...center] : [...best.genes],
        recombination: reusable ? structuredClone(records) : undefined,
        changedGenes: genes.flatMap((v, i) =>
          v !== (reusable ? center : best.genes)[i] ? [i] : [],
        ),
      },
    });
  }
  return {
    population: children,
    state: {
      version: "balance-covariance-v2",
      base,
      optimizer: optimizer.state(),
      draws: next,
      askedGeneration: generation + 1,
      strength: width,
    },
  };
}
export function validateBalanceState(
  s: BalanceSearchState,
  population: Individual[],
  generation: number,
  config: Config,
) {
  if (
    !["balance-covariance-v1", "balance-covariance-v2"].includes(s.version) ||
    s.askedGeneration !== generation ||
    s.base.length !== geneCount(config) ||
    s.base.some(
      (v, i) => !Number.isFinite(v) || v < RANGES[i][0] || v > RANGES[i][1],
    ) ||
    s.optimizer.mean.length !== 36 ||
    s.optimizer.mu !==
      Math.min(
        config.parentCount,
        config.population -
          (config.preserveChampion ? 1 : 0) -
          (s.version === "balance-covariance-v2"
            ? population.filter(
                (p) =>
                  p.birth?.kind === "stage-anchor" ||
                  (config.rewardModel === "settled-curriculum-v9" &&
                    p.birth?.kind === "explorer"),
              ).length
            : 0),
      ) ||
    s.draws.length !==
      config.population -
        (config.preserveChampion ? 1 : 0) -
        (s.version === "balance-covariance-v2"
          ? population.filter(
              (p) =>
                p.birth?.kind === "stage-anchor" ||
                (config.rewardModel === "settled-curriculum-v9" &&
                  p.birth?.kind === "explorer"),
            ).length
          : 0) ||
    new Set(s.draws.map(([id]) => id)).size !== s.draws.length
  )
    throw new Error("분포 탐색 상태가 올바르지 않습니다.");
  const o = CovarianceSearch.restore(s.optimizer);
  const center = decodeBalance(s.base, o.mean);
  if (
    center.some((v, i) => v < RANGES[i][0] - 1e-10 || v > RANGES[i][1] + 1e-10)
  )
    throw new Error("분포 중심 범위 오류");
  for (const [id, x] of s.draws) {
    const p = population.find((p) => p.id === id);
    if (
      !p ||
      p.champion ||
      x.length !== 36 ||
      x.some((v) => !Number.isFinite(v)) ||
      decodeBalance(s.base, x).some((v, i) => Math.abs(v - p.genes[i]) > 1e-10)
    )
      throw new Error("분포 표본과 개체 유전자가 다릅니다.");
  }
}
