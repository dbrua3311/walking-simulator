import { validateSharedState, useSharedSearch } from "../genetics/sharedSearch";
import {
  SHARED_GENE_COUNT,
  SHARED_CONTROLLER_VERSION,
  sharedRanges,
  isSharedModel,
  ANATOMICAL_SHARED_CONTROLLER_VERSION,
  DIRECTION_SHARED_GENE_COUNT,
  DIRECTION_SHARED_CONTROLLER_VERSION,
  wrapPhase,
} from "../controllers/shared";
import { validateBalanceState, useCovariance } from "../genetics/balanceSearch";
import {
  assemblyAngle,
  OUTPUT_OFFSET,
  OUTPUT_STRIDE,
  HIDDEN_SIZE,
} from "../controllers/genome";
import { z } from "zod";
import {
  GENE_COUNT,
  CONTROLLER_VERSION,
  PROPRIO_GENE_COUNT,
  PERIODIC_GENE_COUNT,
  PERIODIC_CONTROLLER_VERSION,
  PROPRIO_CONTROLLER_VERSION,
  geneCount,
  controllerVersion,
} from "../controllers/genome";
import { configSchema } from "../simulation/config";
import {
  initialCurriculum,
  enterNextGeneration,
  STAGES,
  distinctFeet,
  meetsStage,
  withinCourseLimits,
  VERIFICATION_SCENARIOS,
} from "../simulation/curriculum";
import { RANGES, rankDistance } from "../genetics/evolution";
import type { Checkpoint, Stat, RewardModel } from "../simulation/types";
const finite = z.number().finite();
const positive = finite.nonnegative();
const tick = positive.int().max(1000000000);
const vec = z.object({ x: finite, y: finite, z: finite });
const quat = z
  .object({ x: finite, y: finite, z: finite, w: finite })
  .refine(
    (q) => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.01,
    "회전 자세 오류",
  );
const pose = vec.extend({ q: quat, v: vec, w: vec });
const frame = z
  .object({
    tick,
    distance: positive,
    bodies: z.array(pose).length(13),
    angles: z.array(finite).length(12),
    torques: z.array(finite.min(-50).max(50)).length(12).optional(),
    feet: z
      .array(
        z.object({
          position: vec,
          contact: z.boolean(),
          swing: z.boolean(),
          clearance: positive,
        }),
      )
      .length(4),
    gait: z.object({
      settledSteps: z.array(tick).length(4).optional(),
      recoverySteps: tick.max(2).optional(),
      jointFreedom: finite.min(0).max(1).optional(),
      mobileSupportTime: positive.optional(),
      longestMobileSupport: positive.optional(),
      stopEffortTime: positive.optional(),
      rawDistance: positive,
      steps: z.array(tick).length(4),
      footProgress: z.array(finite.min(0).max(1)).length(4).optional(),
      weightShift: z.array(finite.min(0).max(1)).length(4).optional(),
      stepActivity: z.array(finite.min(0).max(1)).length(4).optional(),
      contactCount: tick.max(4),
      slip: positive,
      walking: z.boolean(),
      limbContact: z.boolean(),
      uprightTime: positive,
      supportTime: positive,
      longestSupport: positive,
      walkingTime: positive,
      qualityWalkingTime: positive,
      longestWalking: positive,
      lateralTravel: positive,
      lateralDeviation: positive.optional(),
      headingDeviation: positive.max(Math.PI).optional(),
      yawTravel: positive,
      groundedForward: positive,
      airTime: positive,
      longestFlight: positive,
      verticalMotion: positive,
      jumping: z.boolean(),
    }),
  })
  .refine(
    (f) =>
      (f.gait.settledSteps?.every((n, leg) => n <= f.gait.steps[leg]) ??
        true) &&
      (f.gait.recoverySteps ?? 0) <=
        (f.gait.settledSteps?.reduce((a, b) => a + b, 0) ?? 0) &&
      (f.gait.longestMobileSupport ?? 0) <=
        (f.gait.mobileSupportTime ?? 0) + 1e-8 &&
      (f.gait.mobileSupportTime ?? 0) <= f.gait.supportTime + 1e-8 &&
      f.gait.longestSupport <= f.gait.supportTime + 1e-8 &&
      f.gait.supportTime <= f.gait.uprightTime + 1e-8 &&
      f.gait.qualityWalkingTime <= f.gait.walkingTime + 1e-8 &&
      f.gait.longestWalking <= f.gait.walkingTime + 1e-8 &&
      f.gait.walkingTime <= f.tick / 120 + 1e-8 &&
      f.gait.longestFlight <= f.gait.airTime + 1e-8 &&
      f.gait.airTime <= f.tick / 120 + 1e-8 &&
      f.gait.uprightTime <= f.tick / 120 + 1e-8,
    "지지 시간 기록 오류",
  );
const genes = z
  .array(finite)
  .refine(
    (g) =>
      g.length === GENE_COUNT ||
      g.length === PROPRIO_GENE_COUNT ||
      g.length === PERIODIC_GENE_COUNT ||
      g.length === SHARED_GENE_COUNT ||
      g.length === DIRECTION_SHARED_GENE_COUNT,
    "유전자 개수 오류",
  )
  .refine(
    (g) =>
      g.every((v, i) => {
        const range = (
          [SHARED_GENE_COUNT, DIRECTION_SHARED_GENE_COUNT].includes(g.length)
            ? sharedRanges(g.length)
            : RANGES
        )[i];
        return Boolean(range) && v >= range[0] - 1e-10 && v <= range[1] + 1e-10;
      }),
    "유전자 범위 오류",
  );
const individual = z.object({
  id: positive.int().min(1).max(60),
  genes,
  champion: z.boolean(),
  parents: z.array(positive.int().min(1).max(60)).max(60),
  immigrant: z.boolean().optional(),
  birth: z
    .object({
      generation: tick.min(1),
      kind: z.enum([
        "elite",
        "mutation",
        "crossover",
        "copy",
        "explorer",
        "recombination",
        "stage-anchor",
      ]),
      recombination: z
        .array(
          z.object({
            id: tick.min(1).max(60),
            genes,
            latent: z.array(finite).min(1).max(64),
            weight: finite.min(0).max(1),
          }),
        )
        .min(1)
        .max(60)
        .optional(),
      parentGenes: genes,
      changedGenes: z
        .array(tick.max(PERIODIC_GENE_COUNT - 1))
        .max(PERIODIC_GENE_COUNT),
      mutationScope: z
        .enum([
          "joint",
          "leg",
          "joint-group",
          "sensor-column",
          "output-coordinate",
          "group-coordinate",
          "network",
          "output-network",
          "joint-feedback",
          "shared-covariance",
          "balance-covariance",
          "leg-time",
        ])
        .optional(),
      mutationProfile: z
        .object({
          kind: z.enum(["small", "medium", "large"]),
          rate: finite.min(0).max(1),
          scale: finite.min(0.0001).max(0.5),
        })
        .optional(),
    })
    .optional(),
});
const result = individual.extend({
  score: z.object({
    support: positive,
    steps: positive,
    forward: positive,
    continuity: positive,
    penalty: positive,
    total: finite.min(-1).max(1),
  }),
  frame,
  outcome: z.enum([
    "fallen",
    "stalled",
    "timeout",
    "success",
    "invalid",
    "jumped",
  ]),
  reachedTick: tick,
  fitness: finite.min(-1).max(1),
  energy: positive,
  elapsed: positive,
});
const stage = z.enum(["balance", "stepping", "forward"]);
const curriculum = z.object({
  stage,
  startedGeneration: tick.min(1),
  streak: tick.max(10),
  pendingStage: stage.nullable(),
});
const verification = z.object({
  status: z.enum(["passed", "failed"]),
  generation: tick.min(1),
  robotId: tick.min(1).max(60),
  genes,
  trials: z
    .array(
      z.object({
        label: z.string().max(40),
        roll: finite.min(-0.1).max(0.1),
        pitch: finite.min(-0.1).max(0.1),
        status: z.enum(["passed", "failed"]),
        outcome: z.enum([
          "fallen",
          "stalled",
          "timeout",
          "success",
          "invalid",
          "jumped",
        ]),
        elapsed: positive,
        distance: positive,
        walkingTime: positive,
        longestWalking: positive.optional(),
        walking: z.boolean().optional(),
        longestFlight: positive,
        lateralTravel: positive,
        lateralDeviation: positive.optional(),
        headingDeviation: positive.max(Math.PI).optional(),
        yawTravel: positive,
        jumping: z.boolean(),
        steps: z.array(tick).length(4),
        footProgress: z.array(finite.min(0).max(1)).length(4).optional(),
        weightShift: z.array(finite.min(0).max(1)).length(4).optional(),
        stepActivity: z.array(finite.min(0).max(1)).length(4).optional(),
      }),
    )
    .length(3),
});
const stat = z.object({
  rewardVersion: z
    .enum([
      "temporal-curriculum-v4",
      "supported-curriculum-v5",
      "cycle-curriculum-v6",
      "rhythmic-curriculum-v7",
      "mobile-curriculum-v8",
      "settled-curriculum-v9",
    ])
    .optional(),
  stage,
  maxSupportTime: positive,
  maxFootCount: tick.max(4),
  maxWalkingTime: positive,
  qualifiedCount: tick.max(60),
  generation: tick.min(1),
  bestDistanceM: positive,
  meanDistanceM: positive,
  bestFitness: finite,
  meanFitness: finite,
  fallenCount: tick.max(60),
  successCount: tick.max(60),
  bestRobotId: tick.min(1).max(60),
});
const ghost = z.object({
  generation: tick.min(1),
  robotId: tick.min(1).max(60),
  distance: positive,
  frames: z.array(frame).min(1).max(1202),
});
const vector36 = z.array(finite).length(36),
  matrix36 = z.array(vector36).length(36);
const searchState = z.object({
  version: z.enum(["balance-covariance-v1", "balance-covariance-v2"]),
  strength: finite.gt(0).max(100).optional(),
  base: genes,
  askedGeneration: tick.min(2),
  draws: z
    .array(z.tuple([tick.min(1).max(60), vector36]))
    .min(1)
    .max(60),
  optimizer: z.object({
    mean: vector36,
    sigma: finite.gt(0).max(100),
    C: matrix36,
    ps: vector36,
    pc: vector36,
    generation: tick,
    mu: tick.min(1).max(60),
    Q: matrix36,
    D: z.array(finite.gt(0)).length(36),
  }),
});
const sharedVector = z.array(finite).min(1).max(38);
const sharedState = z.object({
  version: z.enum([
    "shared-covariance-v1",
    "shared-covariance-v2",
    "shared-covariance-v3",
  ]),
  mode: z.enum(["balance", "cycles", "reflex", "direction"]),
  base: genes,
  target: z.number().int().min(-1).max(3),
  strength: finite.gt(0).max(100),
  peak: finite,
  stagnation: tick,
  askedGeneration: tick.min(2),
  draws: z
    .array(z.tuple([tick.min(1).max(60), sharedVector]))
    .min(1)
    .max(60),
  optimizer: z.object({
    mean: sharedVector,
    sigma: finite.gt(0).max(100),
    C: z.array(sharedVector).min(1).max(38),
    ps: sharedVector,
    pc: sharedVector,
    generation: tick,
    mu: tick.min(1).max(60),
    Q: z.array(sharedVector).min(1).max(38),
    D: z.array(finite.gt(0)).min(1).max(38),
  }),
});
const schema = z.object({
  sharedSearch: sharedState.nullable().optional(),
  controllerTransitions: z
    .array(
      z.object({
        effectiveGeneration: tick.min(3),
        sourceGeneration: tick.min(2),
        from: z.literal(PROPRIO_CONTROLLER_VERSION),
        to: z.literal(PERIODIC_CONTROLLER_VERSION),
        neutralGenes: z.literal(24),
        sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(1)
    .optional(),
  balanceSearch: searchState.nullable().optional(),
  formatVersion: z.literal(6),
  appVersion: z.enum([
    "0.6.0",
    "0.6.1",
    "0.6.2",
    "0.6.3",
    "0.6.4",
    "0.7.0",
    "0.8.0",
    "0.9.0",
    "0.10.0",
    "0.10.1",
    "0.11.0",
    "0.12.0",
    "0.13.0",
    "0.14.0",
    "0.15.0",
    "0.16.0",
    "0.17.0",
  ]),
  engineVersion: z.literal("rapier3d-0.21.0"),
  controllerVersion: z.enum([
    CONTROLLER_VERSION,
    PROPRIO_CONTROLLER_VERSION,
    PERIODIC_CONTROLLER_VERSION,
    SHARED_CONTROLLER_VERSION,
    DIRECTION_SHARED_CONTROLLER_VERSION,
    ANATOMICAL_SHARED_CONTROLLER_VERSION,
  ]),
  evolutionVersion: z.enum([
    "adaptive-mutation-v5",
    "adaptive-mutation-v6",
    "adaptive-mutation-v7",
    "adaptive-mutation-v8",
    "adaptive-mutation-v9",
    "adaptive-mutation-v10",
    "adaptive-mutation-v11",
    "adaptive-mutation-v12",
    "adaptive-mutation-v13",
    "adaptive-mutation-v14",
    "adaptive-mutation-v15",
    "adaptive-mutation-v16",
    "balance-covariance-v1",
    "balance-covariance-v2",
    "shared-mutation-v1",
    "shared-covariance-v1",
    "shared-covariance-v2",
    "shared-covariance-v3",
  ]),
  rewardVersion: z.enum([
    "temporal-curriculum-v4",
    "supported-curriculum-v5",
    "cycle-curriculum-v6",
    "rhythmic-curriculum-v7",
    "mobile-curriculum-v8",
    "settled-curriculum-v9",
  ]),
  selectionVersion: z.enum([
    "curriculum-diversity-v2",
    "curriculum-diversity-v3",
    "curriculum-diversity-v4",
    "curriculum-diversity-v5",
    "curriculum-diversity-v6",
    "curriculum-diversity-v7",
    "curriculum-diversity-v8",
    "shared-selection-v1",
  ]),
  generation: tick.min(1),
  curriculum,
  verification: verification.nullable(),
  verifiedPolicy: verification.nullable(),
  config: configSchema,
  population: z.array(individual).min(2).max(60),
  completedResults: z.array(result).min(2).max(60),
  selectedParentIds: z.array(tick.min(1).max(60)).max(60),
  history: z.array(stat).min(1).max(100000),
  previousBest: ghost.nullable(),
  allTimeBest: ghost.nullable(),
  rngState: positive.int().max(4294967295),
  evaluationTick: tick,
  phase: z.literal("selection"),
  autoEnabled: z.boolean(),
  pendingSettings: configSchema
    .pick({
      population: true,
      mutation: true,
      crossover: true,
      parentCount: true,
    })
    .extend({
      mutationScale: configSchema.shape.mutationScale.optional(),
      adaptiveSearch: configSchema.shape.adaptiveSearch.optional(),
    })
    .nullable()
    .default(null),
});
export function validateCheckpoint(data: unknown): Checkpoint {
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 1
  )
    throw new Error(
      "이 파일은 이전 2D 실험입니다. 3D 12관절 모델과 호환되지 않으므로 새 실험을 시작하세요.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 2
  )
    throw new Error(
      "이 파일은 발 경로가 미리 설계된 이전 16유전자 보행 실험입니다. 무작위 신경망과 호환되지 않으므로 새 실험을 시작하세요.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 3
  )
    throw new Error(
      "이 파일은 점프·생존 위주의 이전 보상 기준입니다. 새 보행 점수와 섞지 않도록 새 실험을 시작하세요. 원본 파일은 보존됩니다.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 4
  )
    throw new Error(
      "이 파일은 단계별 학습 이전 v4 평가입니다. 점수를 섞지 않도록 새 실험을 시작하세요. 원본 파일은 보존됩니다.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 5 &&
    "rewardVersion" in data &&
    data.rewardVersion === "curriculum-progress-v2"
  )
    throw new Error(
      "이 파일은 후진 누적 감점 이전 보상 기준입니다. 점수를 섞지 않도록 새 실험을 시작하세요. 원본 파일은 보존됩니다.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 5
  )
    throw new Error(
      "이 파일은 시간 변화 입력 이전 신경망입니다. 유전자 구조가 달라 새 실험을 시작하세요. 원본 파일은 보존됩니다.",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "formatVersion" in data &&
    data.formatVersion === 6 &&
    "rewardVersion" in data &&
    data.rewardVersion === "curriculum-progress-v3"
  )
    throw new Error(
      "이 파일은 15초 균형 중심 보상 조정 이전 실험입니다. 새 실험을 시작하세요. 원본 파일은 보존됩니다.",
    );
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      "저장 파일의 무작위 신경망·3D 구조·설정·유전자 값이 올바르지 않습니다.",
    );
  const d = parsed.data;
  if (
    d.rewardVersion !== d.config.rewardModel ||
    (d.rewardVersion === "settled-curriculum-v9" &&
      !["0.16.0", "0.17.0"].includes(d.appVersion)) ||
    (d.rewardVersion === "supported-curriculum-v5" &&
      ![
        "0.9.0",
        "0.10.0",
        "0.10.1",
        "0.11.0",
        "0.12.0",
        "0.13.0",
        "0.14.0",
        "0.15.0",
        "0.16.0",
        "0.17.0",
      ].includes(d.appVersion)) ||
    (d.rewardVersion === "cycle-curriculum-v6" &&
      ![
        "0.10.0",
        "0.10.1",
        "0.11.0",
        "0.12.0",
        "0.13.0",
        "0.14.0",
        "0.15.0",
        "0.16.0",
        "0.17.0",
      ].includes(d.appVersion)) ||
    (d.rewardVersion === "rhythmic-curriculum-v7" &&
      ![
        "0.11.0",
        "0.12.0",
        "0.13.0",
        "0.14.0",
        "0.15.0",
        "0.16.0",
        "0.17.0",
      ].includes(d.appVersion)) ||
    (d.rewardVersion === "mobile-curriculum-v8" &&
      !["0.12.0", "0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(
        d.appVersion,
      ))
  )
    throw new Error("보상 버전과 실험 설정이 일치하지 않습니다.");
  if (
    d.config.evaluation.contactModel === "load-bearing" &&
    !["0.15.0", "0.16.0", "0.17.0"].includes(d.appVersion)
  )
    throw new Error(
      "실제 하중으로 평가한 발 지지 기준은 앱0.15.0 저장이 필요합니다.",
    );
  const lastReward = d.history.at(-1)?.rewardVersion;
  if (
    (lastReward && lastReward !== d.rewardVersion) ||
    ([
      "rhythmic-curriculum-v7",
      "mobile-curriculum-v8",
      "settled-curriculum-v9",
    ].includes(d.rewardVersion) &&
      d.history.some((h) => !h.rewardVersion))
  )
    throw new Error("세대별 보상 버전 기록이 일치하지 않습니다.");
  if (
    d.controllerTransitions?.some(
      (t) =>
        t.effectiveGeneration !== t.sourceGeneration + 1 ||
        t.effectiveGeneration > d.generation + 1 ||
        d.controllerVersion !== t.to,
    )
  )
    throw new Error("제어기 확장 이력이 올바르지 않습니다.");
  const expectedCount = geneCount(d.config),
    geneRecords = [...d.population, ...d.completedResults];
  if (
    d.controllerVersion !== controllerVersion(d.config) ||
    (d.config.controllerModel === "local-periodic-rnn" &&
      !["0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(
        d.appVersion,
      )) ||
    geneRecords.some(
      (r) =>
        r.genes.length !== expectedCount ||
        (r.birth && r.birth.parentGenes.length !== expectedCount),
    ) ||
    (d.verification && d.verification.genes.length !== expectedCount) ||
    (d.verifiedPolicy && d.verifiedPolicy.genes.length !== expectedCount) ||
    (d.config.controllerModel !== "timed-rnn" &&
      !["0.12.0", "0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(
        d.appVersion,
      ))
  )
    throw new Error("제어기 버전과 유전자 구조가 일치하지 않습니다.");
  if (isSharedModel(d.config.controllerModel)) {
    if (
      !["0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(d.appVersion) ||
      d.selectionVersion !== "shared-selection-v1" ||
      ![
        "shared-mutation-v1",
        "shared-covariance-v1",
        "shared-covariance-v2",
        "shared-covariance-v3",
      ].includes(d.evolutionVersion)
    )
      throw new Error("공통 제어기 버전 오류");
  } else if (
    d.sharedSearch ||
    d.evolutionVersion.startsWith("shared-") ||
    d.selectionVersion === "shared-selection-v1"
  )
    throw new Error("공통 제어기 상태와 모형 불일치");
  if (d.sharedSearch) {
    if (
      d.evolutionVersion !== d.sharedSearch.version ||
      !useSharedSearch(d.config)
    )
      throw new Error("공통 분포 탐색 버전 오류");
    validateSharedState(
      d.sharedSearch,
      d.population,
      d.generation,
      d.config,
      d.curriculum.stage,
    );
  } else if (
    [
      "shared-covariance-v1",
      "shared-covariance-v2",
      "shared-covariance-v3",
    ].includes(d.evolutionVersion)
  )
    throw new Error("공통 분포 탐색 상태가 없습니다.");
  if (d.balanceSearch) {
    if (
      !["0.12.0", "0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(
        d.appVersion,
      ) ||
      d.evolutionVersion !== d.balanceSearch.version ||
      (d.balanceSearch.version === "balance-covariance-v2" &&
        !["0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"].includes(
          d.appVersion,
        )) ||
      !useCovariance(d.config, d.curriculum.stage)
    )
      throw new Error("분포 탐색 버전이 일치하지 않습니다.");
    validateBalanceState(d.balanceSearch, d.population, d.generation, d.config);
  } else if (
    ["balance-covariance-v1", "balance-covariance-v2"].includes(
      d.evolutionVersion,
    )
  )
    throw new Error("분포 탐색 상태가 없습니다.");
  const genomeRanges = [
    SHARED_GENE_COUNT,
    DIRECTION_SHARED_GENE_COUNT,
  ].includes(expectedCount)
    ? sharedRanges(expectedCount)
    : RANGES;
  const ids = d.population.map((r) => r.id);
  const unique = new Set(ids);
  if (
    unique.size !== ids.length ||
    ids.length !== d.config.population ||
    d.completedResults.length !== ids.length ||
    new Set(d.selectedParentIds).size !== d.selectedParentIds.length ||
    d.selectedParentIds.some((id) => !unique.has(id))
  )
    throw new Error("개체 수 또는 ID 참조가 올바르지 않습니다.");
  if (
    d.population.filter((r) => r.champion).length !==
    (d.generation === 1 || !d.config.preserveChampion ? 0 : 1)
  )
    throw new Error("챔피언 정보가 올바르지 않습니다.");
  if (
    d.history.length !== d.generation ||
    d.history.some((s, i) => s.generation !== i + 1) ||
    d.history.at(-1)?.generation !== d.generation
  )
    throw new Error("세대 기록이 일치하지 않습니다.");
  if (d.evaluationTick > Math.ceil(d.config.duration / d.config.physics.dt))
    throw new Error("평가 시간이 범위를 벗어났습니다.");
  d.completedResults.forEach((r, i) => {
    if (
      r.id !== ids[i] ||
      JSON.stringify(r.genes) !== JSON.stringify(d.population[i].genes) ||
      JSON.stringify(r.parents) !== JSON.stringify(d.population[i].parents) ||
      r.champion !== d.population[i].champion ||
      r.immigrant !== d.population[i].immigrant ||
      JSON.stringify(r.birth) !== JSON.stringify(d.population[i].birth) ||
      Math.abs(r.fitness - r.score.total) > 1e-8 ||
      Math.abs(
        r.score.total -
          Math.max(
            -1,
            Math.min(
              1,
              r.score.support +
                r.score.steps +
                r.score.forward +
                r.score.continuity -
                r.score.penalty,
            ),
          ),
      ) > 1e-8 ||
      r.frame.tick > d.evaluationTick ||
      r.reachedTick > r.frame.tick ||
      Math.abs(r.elapsed - r.frame.tick * d.config.physics.dt) > 1e-8
    )
      throw new Error("완료 개체 상태가 일치하지 않습니다.");
  });
  for (const g of [d.previousBest, d.allTimeBest])
    if (g) {
      if (
        g.generation > d.generation ||
        g.frames.some(
          (f, i) =>
            f.tick > 7200 ||
            f.distance > g.distance + 1e-8 ||
            (i > 0 &&
              (f.tick <= g.frames[i - 1].tick ||
                f.distance < g.frames[i - 1].distance)),
        ) ||
        Math.abs(g.frames.at(-1)!.distance - g.distance) > 1e-8
      )
        throw new Error("고스트 기록이 올바르지 않습니다.");
    }
  for (const r of d.population) {
    const b = r.birth;
    if (r.immigrant) {
      if (r.champion || r.parents.length || b || d.generation === 1)
        throw new Error("무작위 탐색 개체 기록 오류");
      continue;
    }
    if (!b) {
      if (d.generation > 1)
        throw new Error("부모와 유전자 변형 기록이 없습니다.");
      continue;
    }
    const changed = r.genes.flatMap((v, i) =>
      v !== b.parentGenes[i] ? [i] : [],
    );
    if (
      b.generation !== d.generation - 1 ||
      !r.parents.length ||
      JSON.stringify(changed) !== JSON.stringify(b.changedGenes) ||
      r.champion !== (b.kind === "elite") ||
      (["elite", "copy", "explorer", "stage-anchor"].includes(b.kind) &&
        changed.length > 0) ||
      (b.kind === "mutation" && changed.length === 0) ||
      (b.mutationProfile &&
        b.kind === "mutation" &&
        changed.some(
          (i) =>
            Math.abs(r.genes[i] - b.parentGenes[i]) >
            (genomeRanges[i][1] - genomeRanges[i][0]) *
              b.mutationProfile!.scale *
              (d.config.controllerModel !== "timed-rnn" &&
              i >= OUTPUT_OFFSET &&
              i < 540 &&
              (i - OUTPUT_OFFSET) % OUTPUT_STRIDE === HIDDEN_SIZE
                ? 1 +
                  (d.config.controllerModel === "local-periodic-rnn" ? 1 : 0) +
                  Math.abs(
                    assemblyAngle(
                      Math.floor((i - OUTPUT_OFFSET) / OUTPUT_STRIDE),
                    ),
                  )
                : 1) +
              1e-10,
        )) ||
      r.parents.length !==
        (b.kind === "recombination"
          ? b.recombination?.length
          : b.kind === "crossover"
            ? 2
            : 1)
    )
      throw new Error("부모와 유전자 변형 기록이 일치하지 않습니다.");
  }
  for (const r of d.population) {
    const b = r.birth;
    if (b?.kind !== "recombination") continue;
    const records = b.recombination!;
    if (isSharedModel(d.config.controllerModel)) {
      if (
        !d.sharedSearch ||
        b.mutationScope !== "shared-covariance" ||
        records.some(
          (p, i) => p.id !== r.parents[i] || p.genes.length !== expectedCount,
        ) ||
        Math.abs(records.reduce((sum, p) => sum + p.weight, 0) - 1) > 1e-10
      )
        throw new Error("공통 가중 재조합 부모 오류");
      continue;
    }
    if (records.some((p) => p.latent.length !== 36))
      throw new Error("이전 재조합 좌표 차원 오류");
    if (
      records.some(
        (p, i) => p.id !== r.parents[i] || p.genes.length !== expectedCount,
      ) ||
      Math.abs(records.reduce((s, p) => s + p.weight, 0) - 1) > 1e-10 ||
      b.parentGenes.some(
        (v, i) =>
          Math.abs(v - records.reduce((s, p) => s + p.weight * p.genes[i], 0)) >
          1e-10,
      )
    )
      throw new Error("가중 재조합 부모 기록 오류");
  }
  const views = d.completedResults;
  const best = rankDistance(views)[0];
  const last = d.history.at(-1)!;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8;
  if (
    d.evaluationTick !== Math.max(...views.map((r) => r.frame.tick)) ||
    last.bestRobotId !== best.id ||
    !close(last.bestDistanceM, best.frame.distance) ||
    !close(
      last.meanDistanceM,
      views.reduce((s, r) => s + r.frame.distance, 0) / views.length,
    ) ||
    !close(last.bestFitness, Math.max(...views.map((r) => r.fitness))) ||
    !close(
      last.meanFitness,
      views.reduce((s, r) => s + r.fitness, 0) / views.length,
    ) ||
    last.fallenCount !== views.filter((r) => r.outcome === "fallen").length ||
    last.successCount !== views.filter((r) => r.outcome === "success").length
  )
    throw new Error("완료 결과와 세대 통계가 일치하지 않습니다.");
  if (
    !d.previousBest ||
    !d.allTimeBest ||
    d.previousBest.generation !== d.generation ||
    d.previousBest.robotId !== best.id ||
    !close(d.previousBest.distance, best.frame.distance) ||
    !close(
      d.allTimeBest.distance,
      Math.max(...d.history.map((h) => h.bestDistanceM)),
    )
  )
    throw new Error("최고 기록과 고스트가 일치하지 않습니다.");
  if (
    last.stage !== d.curriculum.stage ||
    !close(
      last.maxSupportTime,
      Math.max(...views.map((r) => r.frame.gait.longestSupport)),
    ) ||
    last.maxFootCount !== Math.max(...views.map(distinctFeet)) ||
    !close(
      last.maxWalkingTime,
      Math.max(...views.map((r) => r.frame.gait.walkingTime)),
    ) ||
    last.qualifiedCount !==
      views.filter((r) => meetsStage(r, last.stage, d.config)).length
  )
    throw new Error("학습 단계 통계가 일치하지 않습니다.");
  let expected = initialCurriculum();
  for (const h of d.history) {
    expected = enterNextGeneration(expected, h.generation);
    if (
      h.stage !== expected.stage ||
      h.maxSupportTime > d.config.duration + d.config.physics.dt + 1e-8 ||
      h.maxWalkingTime > d.config.duration + d.config.physics.dt + 1e-8
    )
      throw new Error("학습 단계 이력이 올바르지 않습니다.");
    if (expected.stage !== "forward") {
      expected.streak = h.qualifiedCount > 0 ? expected.streak + 1 : 0;
      expected.pendingStage =
        expected.streak >= d.config.curriculum.promotionGenerations
          ? STAGES[STAGES.indexOf(expected.stage) + 1]
          : null;
    }
  }
  if (JSON.stringify(expected) !== JSON.stringify(d.curriculum))
    throw new Error("승급 대기 상태가 일치하지 않습니다.");
  for (const report of [d.verification, d.verifiedPolicy])
    if (report) {
      if (
        report.generation > d.generation ||
        d.history[report.generation - 1].stage !== "forward"
      )
        throw new Error("보행 재검증 세대 오류");
      for (let i = 0; i < 3; i++) {
        const t = report.trials[i],
          scenario = VERIFICATION_SCENARIOS[i],
          c = d.config.curriculum;
        const passed =
          t.distance + 1e-8 >= d.config.target &&
          t.walkingTime + 1e-8 >= c.forwardSeconds &&
          (t.longestWalking ?? 0) + 1e-8 >=
            Math.min(c.forwardContinuousSeconds, c.forwardSeconds) &&
          (t.longestWalking ?? 0) <= t.walkingTime + 1e-8 &&
          (!c.requireWalkingAtFinish || t.walking === true) &&
          t.walkingTime <= t.elapsed + 1e-8 &&
          t.steps.every((n) => n >= 2) &&
          !t.jumping &&
          t.longestFlight <= d.config.evaluation.maxAirTime + 1e-8 &&
          t.longestFlight <= c.maxWalkingFlightTime + 1e-8 &&
          withinCourseLimits(t, d.config) &&
          (t.outcome === "success" || t.outcome === "timeout");
        if (
          t.label !== scenario.label ||
          t.roll !== scenario.roll ||
          t.pitch !== scenario.pitch ||
          t.elapsed > d.config.duration + d.config.physics.dt + 1e-8 ||
          (t.status === "passed") !== passed
        )
          throw new Error("보행 재검증 조건·결과 오류");
      }
      if (
        (report.status === "passed") !==
        report.trials.every((t) => t.status === "passed")
      )
        throw new Error("보행 재검증 판정 오류");
      if (
        report.generation === d.generation &&
        !d.population.some(
          (r) =>
            r.id === report.robotId &&
            JSON.stringify(r.genes) === JSON.stringify(report.genes),
        )
      )
        throw new Error("보행 재검증 유전자 오류");
    }
  if (d.verifiedPolicy && d.verifiedPolicy.status !== "passed")
    throw new Error("검증 우승 기록 오류");
  return d as Checkpoint;
}
export function parseCheckpoint(text: string) {
  if (new Blob([text]).size > 32 * 1024 * 1024)
    throw new Error("저장 파일은 32MB 이하여야 합니다.");
  return validateCheckpoint(JSON.parse(text));
}
export function csv(history: Stat[], rewardModel: RewardModel): string {
  const keys: (keyof Stat)[] = [
    "generation",
    "bestDistanceM",
    "meanDistanceM",
    "bestFitness",
    "meanFitness",
    "fallenCount",
    "successCount",
    "bestRobotId",
    "stage",
    "maxSupportTime",
    "maxFootCount",
    "maxWalkingTime",
    "qualifiedCount",
  ];
  return (
    [...keys, "rewardVersion"].join(",") +
    "\n" +
    history
      .map((row) =>
        [...keys.map((k) => row[k]), row.rewardVersion ?? rewardModel].join(
          ",",
        ),
      )
      .join("\n") +
    "\n"
  );
}
export async function saveFile(name: string, text: string, mime: string) {
  const browser = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{
      createWritable: () => Promise<{
        write: (v: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };
  if (browser.showSaveFilePicker) {
    const handle = await browser.showSaveFilePicker({
      suggestedName: name,
      types: [
        {
          description: "실험 파일",
          accept: { [mime]: [name.endsWith(".csv") ? ".csv" : ".json"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([text], { type: mime }));
    await writable.close();
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
