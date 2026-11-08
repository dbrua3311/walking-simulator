import { SHARED_SEARCH_VERSION } from "../src/genetics/sharedSearch";
import { isSharedModel } from "../src/controllers/shared";
import { isPracticeReward } from "../src/physics/assessment";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  statSync,
  realpathSync,
} from "node:fs";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { initPhysics } from "../src/physics/engine";
await initPhysics();
import { Experiment } from "../src/simulation/experiment";
import { meetsStage } from "../src/simulation/curriculum";
import { controllerVersion, geneCount } from "../src/controllers/genome";
import { rank, rankDistance } from "../src/genetics/evolution";
import { cloneConfig, configSchema } from "../src/simulation/config";
import { csv, parseCheckpoint } from "../src/persistence/files";
const resumePath = process.env.RESUME;
const resumeBytes = resumePath ? readFileSync(resumePath, "utf8") : null;
const resumed = resumeBytes ? parseCheckpoint(resumeBytes) : null;
const generations = Number(process.env.GENERATIONS ?? 10),
  seeds = (
    process.env.SEEDS ??
    (resumed ? String(resumed.config.seed) : "2026,2027,2028")
  )
    .split(",")
    .map(Number);
const loadedConfig =
  resumed?.config ??
  configSchema.parse({
    ...cloneConfig(),
    controllerModel:
      process.env.CONTROLLER_MODEL ?? cloneConfig().controllerModel,
    searchMethod: process.env.SEARCH_METHOD ?? cloneConfig().searchMethod,
    rewardModel: process.env.REWARD_MODEL ?? cloneConfig().rewardModel,
    population: Number(process.env.POPULATION ?? 20),
    parentCount: Number(
      process.env.PARENT_COUNT ??
        (isSharedModel(
          process.env.CONTROLLER_MODEL ?? cloneConfig().controllerModel,
        )
          ? 3
          : 5),
    ),
    initialization: process.env.INITIAL_MODE ?? cloneConfig().initialization,
    initialBalanceBias: Number(
      process.env.INITIAL_BALANCE_BIAS ?? cloneConfig().initialBalanceBias,
    ),
    adaptiveSearch: process.env.ADAPTIVE_SEARCH !== "0",
    mutationScale: Number(process.env.MUTATION_SCALE ?? 0.03),
    mutation: Number(process.env.MUTATION_RATE ?? 0.1),
  });
const refinePromotion = process.env.REFINE_PROMOTION === "1";
if (
  refinePromotion &&
  resumed &&
  (resumed.curriculum.stage === "forward" ||
    (resumed.curriculum.stage === "stepping" &&
      (resumed.curriculum.streak > 0 || resumed.curriculum.pendingStage)))
)
  throw new Error(
    "승급 조건 변경은 균형 단계 또는 승급 대기/연속 달성0인 발 단계의 완료 체크포인트에서만 가능합니다. 이전 이력을 되돌리지 않습니다.",
  );
const baseConfig = refinePromotion
  ? configSchema.parse({
      ...loadedConfig,
      curriculum: {
        ...loadedConfig.curriculum,
        steppingFeet: 4,
        steppingSteps: 8,
        coordinatedPromotion: true,
      },
    })
  : loadedConfig;
const preparedResume =
  resumed && refinePromotion
    ? parseCheckpoint(JSON.stringify({ ...resumed, config: baseConfig }))
    : resumed;
if (
  resumed &&
  (seeds.length !== 1 ||
    seeds[0] !== resumed.config.seed ||
    generations <= resumed.generation)
)
  throw new Error(
    "재개 시 시드는 저장 파일과 같아야 하며 목표 세대는 현재보다 커야 합니다.",
  );
if (
  !Number.isInteger(generations) ||
  generations < 1 ||
  seeds.some((n) => !Number.isInteger(n) || n < 0 || n > 4294967295)
)
  throw new Error("세대 수/시드 오류");
const root = process.env.WALKING_STORAGE_ROOT;
if (!root) throw new Error("scripts/run.sh로 실행하세요.");
const storageDevice = statSync(root).dev;
const usbDevice = statSync("/mnt/piper-usb").dev;
const dedicatedRoot = realpathSync("/mnt/piper-usb/walking-simulator");
const actualRoot = realpathSync(root);
if (
  (actualRoot !== dedicatedRoot &&
    !actualRoot.startsWith(dedicatedRoot + "/")) ||
  storageDevice !== usbDevice ||
  usbDevice === statSync("/").dev
)
  throw new Error("Walking Simulator 전용 USB 저장소를 확인하세요.");
function requireStorage() {
  if (
    statSync("/mnt/piper-usb").dev !== usbDevice ||
    statSync(root!).dev !== storageDevice
  )
    throw new Error(
      "USB 저장 장치가 변경되거나 연결 해제되었습니다. 메인 저장소로 대체하지 않습니다.",
    );
}
requireStorage();
const folder =
  root +
  "/experiments/validation-curriculum-" +
  new Date().toISOString().replace(/[:.]/g, "-") +
  `-p${baseConfig.population}-${baseConfig.adaptiveSearch ? "adaptive" : "fixed"}-${process.pid}`;
mkdirSync(folder, { recursive: true });
const sourceFiles = [
  "src/physics/assessment.ts",
  "src/physics/robot.ts",
  "src/physics/gait.ts",
  "src/physics/math.ts",
  "src/physics/engine.ts",
  "src/simulation/curriculum.ts",
  "src/simulation/experiment.ts",
  "src/genetics/evolution.ts",
  "src/genetics/covariance.ts",
  "src/genetics/balanceSearch.ts",
  "src/genetics/sharedSearch.ts",
  "src/genetics/sharedMutation.ts",
  "src/controllers/shared.ts",
  "src/simulation/config.ts",
  "src/simulation/verification.ts",
  "src/simulation/types.ts",
  "src/persistence/files.ts",
  "src/controllers/genome.ts",
  "src/controllers/neural.ts",
  "scripts/experiment.ts",
  "scripts/upgrade-controller.ts",
  "src/persistence/upgrade.ts",
  "scripts/run.sh",
  "package.json",
  "package-lock.json",
];
for (const file of sourceFiles) {
  const target = folder + "/source/" + file;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(file));
}
if (resumeBytes) writeFileSync(folder + "/resume-checkpoint.json", resumeBytes);
writeFileSync(
  folder + "/manifest.json",
  JSON.stringify(
    {
      appVersion: "0.15.0",
      sharedSearchOperator: isSharedModel(baseConfig.controllerModel)
        ? SHARED_SEARCH_VERSION
        : null,
      controllerVersion: controllerVersion(baseConfig),
      rewardVersion: baseConfig.rewardModel,
      evolutionVersion: isSharedModel(baseConfig.controllerModel)
        ? "shared-mutation-v1"
        : baseConfig.controllerModel === "local-periodic-rnn"
          ? "adaptive-mutation-v16"
          : baseConfig.rewardModel === "mobile-curriculum-v8"
            ? "adaptive-mutation-v14"
            : baseConfig.controllerModel === "local-feedback-rnn"
              ? "adaptive-mutation-v13"
              : isPracticeReward(baseConfig.rewardModel)
                ? "adaptive-mutation-v12"
                : "adaptive-mutation-v11",
      selectionVersion: isSharedModel(baseConfig.controllerModel)
        ? "shared-selection-v1"
        : baseConfig.controllerModel === "local-periodic-rnn"
          ? "curriculum-diversity-v8"
          : baseConfig.rewardModel === "mobile-curriculum-v8"
            ? "curriculum-diversity-v7"
            : isPracticeReward(baseConfig.rewardModel)
              ? "curriculum-diversity-v6"
              : "curriculum-diversity-v4",
      geneCount: geneCount(baseConfig),
      processId: process.pid,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      promotionRefinement: refinePromotion
        ? {
            effectiveGeneration: (resumed?.generation ?? 0) + 1,
            before: loadedConfig.curriculum,
            after: baseConfig.curriculum,
          }
        : null,
      resumedFrom: resumed
        ? {
            path: resumePath,
            generation: resumed.generation,
            appVersion: resumed.appVersion,
            evolutionVersion: resumed.evolutionVersion,
            checkpointSha256: createHash("sha256")
              .update(resumeBytes!)
              .digest("hex"),
          }
        : null,
      sourceSha256: createHash("sha256")
        .update(
          sourceFiles.map((f) => f + "\n" + readFileSync(f, "utf8")).join("\n"),
        )
        .digest("hex"),
      sourceFiles,
      config: baseConfig,
      seeds,
      generations,
    },
    null,
    2,
  ),
);
function writeAtomic(file: string, data: string) {
  requireStorage();
  const temporary = file + ".tmp";
  writeFileSync(temporary, data);
  renameSync(temporary, file);
}
let stopRequested = false;
const requestStop = () => {
  stopRequested = true;
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
const summaries = [];
for (const seed of seeds) {
  const start = performance.now(),
    e = resumed
      ? Experiment.restore(preparedResume!)
      : new Experiment({ ...baseConfig, seed });
  const observations: {
    stage: string;
    pendingStage: string | null;
    qualified: number;
    maxLongestSupport: number;
    maxWalkingTime: number;
    diversityParents: number;
    newFootParents: number;
    validFootMasks: number[];
    maxValidFootCount: number;
    fourFootCandidates: number;
    repeatedFourFootCandidates: number;
    winnerSteps: number[];
    footFrontier: {
      id: number;
      steps: number[];
      supportTime: number;
      groundedForward: number;
      fitness: number;
      outcome: string;
    };
    generation: number;
    bestFitness: number;
    bestDistance: number;
    maxUprightTime: number;
    maxSupportTime: number;
    meanSupportTime: number;
    maxSteps: number;
    maxValidSteps: number;
    fallen: number;
    stalled: number;
    winnerOutcome: string;
    invalid: number;
    jumped: number;
    winnerFitness: number;
    winnerAirTime: number;
    winnerForward: number;
    winnerDuration: number;
    forwardCandidates: number;
    aliveAtTimeout: number;
    fullBalance: number;
    maxMobileSupport: number;
    covarianceChildren: number;
    nextSearchMode: string;
    mutationCounts: {
      preserved: number;
      small: number;
      medium: number;
      large: number;
      immigrant: number;
    };
  }[] = [];
  const footMask = (steps: number[]) =>
    steps.reduce((m, n, i) => (n > 0 ? m | (1 << i) : m), 0);
  const frontierArchive = new Map<string, { feet: number; fitness: number }>();
  const seenMasks = new Set<number>(
    resumed?.completedResults
      .filter(
        (r) =>
          r.outcome !== "jumped" &&
          r.outcome !== "invalid" &&
          r.frame.gait.supportTime >= 0.5,
      )
      .map((r) => footMask(r.frame.gait.steps))
      .filter(Boolean) ?? [],
  );
  if (resumed) e.evolve(e.autoParents(), undefined, true);
  e.start(false);
  while (e.generation <= generations) {
    while (e.phase === "running" || e.phase === "validating") e.step();
    await yieldLoop();
    const views = e.robots.map((r) => r.view());
    const validFootMasks = [
      ...new Set(
        views
          .filter(
            (r) =>
              r.outcome !== "jumped" &&
              r.outcome !== "invalid" &&
              r.frame.gait.supportTime >= 0.5,
          )
          .map((r) => footMask(r.frame.gait.steps))
          .filter(Boolean),
      ),
    ].sort((a, b) => a - b);
    const newMasks = validFootMasks.filter((m) => !seenMasks.has(m));
    if (newMasks.length) {
      writeAtomic(
        folder + `/seed-${seed}-new-feet-g${e.generation}.json`,
        JSON.stringify(e.checkpoint()),
      );
      newMasks.forEach((m) => seenMasks.add(m));
      console.log(
        JSON.stringify({
          seed,
          generation: e.generation,
          newFootMasks: newMasks,
        }),
      );
    }
    const frontier =
      [...views]
        .filter((r) => r.outcome !== "jumped" && r.outcome !== "invalid")
        .sort(
          (a, b) =>
            b.frame.gait.steps.filter((n) => n > 0).length -
              a.frame.gait.steps.filter((n) => n > 0).length ||
            b.fitness - a.fitness,
        )[0] ?? rank(views)[0];
    const frontierFeet = frontier.frame.gait.steps.filter((n) => n > 0).length;
    const previousFrontier = frontierArchive.get(e.curriculum.stage);
    if (
      !previousFrontier ||
      frontierFeet > previousFrontier.feet ||
      (frontierFeet === previousFrontier.feet &&
        frontier.fitness > previousFrontier.fitness + 0.025)
    ) {
      writeAtomic(
        folder + `/seed-${seed}-frontier-${e.curriculum.stage}.json`,
        JSON.stringify(e.checkpoint()),
      );
      frontierArchive.set(e.curriculum.stage, {
        feet: frontierFeet,
        fitness: frontier.fitness,
      });
    }
    if (e.curriculum.pendingStage)
      writeAtomic(
        folder +
          `/seed-${seed}-promotion-${e.curriculum.stage}-g${e.generation}.json`,
        JSON.stringify(e.checkpoint()),
      );
    if (e.curriculum.stage !== observations.at(-1)?.stage)
      writeAtomic(
        folder +
          `/seed-${seed}-stage-${e.curriculum.stage}-g${e.generation}.json`,
        JSON.stringify(e.checkpoint()),
      );
    observations.push({
      stage: e.curriculum.stage,
      pendingStage: e.curriculum.pendingStage,
      qualified: e.history.at(-1)!.qualifiedCount,
      maxLongestSupport: Math.max(
        ...views.map((r) => r.frame.gait.longestSupport),
      ),
      maxWalkingTime: Math.max(...views.map((r) => r.frame.gait.walkingTime)),
      diversityParents: e
        .parentSuggestions()
        .filter((c) => c.reason === "diversity").length,
      newFootParents: e
        .parentSuggestions()
        .filter((c) => c.reason === "new-foot").length,
      validFootMasks,
      maxValidFootCount: Math.max(
        0,
        ...validFootMasks.map((m) => m.toString(2).replaceAll("0", "").length),
      ),
      fourFootCandidates: views.filter(
        (r) =>
          r.outcome !== "jumped" &&
          r.outcome !== "invalid" &&
          r.frame.gait.steps.every((n) => n >= 1),
      ).length,
      repeatedFourFootCandidates: views.filter(
        (r) =>
          r.outcome !== "jumped" &&
          r.outcome !== "invalid" &&
          r.frame.gait.steps.every((n) => n >= 2),
      ).length,
      winnerSteps: rank(views)[0].frame.gait.steps,
      footFrontier: {
        id: frontier.id,
        steps: frontier.frame.gait.steps,
        supportTime: frontier.frame.gait.supportTime,
        groundedForward: frontier.frame.gait.groundedForward,
        fitness: frontier.fitness,
        outcome: frontier.outcome,
      },
      generation: e.generation,
      bestFitness: Math.max(...views.map((r) => r.fitness)),
      bestDistance: rankDistance(views)[0].frame.distance,
      maxUprightTime: Math.max(...views.map((r) => r.frame.gait.uprightTime)),
      maxSupportTime: Math.max(...views.map((r) => r.frame.gait.supportTime)),
      meanSupportTime:
        views.reduce((sum, r) => sum + r.frame.gait.supportTime, 0) /
        views.length,
      maxMobileSupport: Math.max(
        ...views.map((r) => r.frame.gait.longestMobileSupport ?? 0),
      ),
      covarianceChildren: views.filter(
        (r) =>
          r.birth?.mutationScope === "balance-covariance" ||
          r.birth?.mutationScope === "shared-covariance",
      ).length,
      maxSteps: Math.max(
        ...views.map((r) => r.frame.gait.steps.reduce((s, n) => s + n, 0)),
      ),
      fallen: views.filter((r) => r.outcome === "fallen").length,
      maxValidSteps: Math.max(
        0,
        ...views
          .filter((r) => r.outcome !== "jumped" && r.outcome !== "invalid")
          .map((r) => r.frame.gait.steps.reduce((a, b) => a + b, 0)),
      ),
      stalled: views.filter((r) => r.outcome === "stalled").length,
      winnerOutcome: rank(views)[0].outcome,
      invalid: views.filter((r) => r.outcome === "invalid").length,
      jumped: views.filter((r) => r.outcome === "jumped").length,
      winnerFitness: rank(views)[0].fitness,
      winnerAirTime: rank(views)[0].frame.gait.airTime,
      winnerForward: rank(views)[0].frame.gait.groundedForward,
      winnerDuration: rank(views)[0].elapsed,
      forwardCandidates: views.filter((r) => meetsStage(r, "forward", e.config))
        .length,
      aliveAtTimeout: views.filter(
        (r) =>
          r.outcome === "timeout" && r.elapsed + 1e-8 >= baseConfig.duration,
      ).length,
      fullBalance: views.filter((r) => meetsStage(r, "balance", e.config))
        .length,
      nextSearchMode: e.nextSearchPlan().mode,
      mutationCounts: {
        preserved: views.filter((r) => r.birth?.kind === "explorer").length,
        small: views.filter((r) => r.birth?.mutationProfile?.kind === "small")
          .length,
        medium: views.filter((r) => r.birth?.mutationProfile?.kind === "medium")
          .length,
        large: views.filter((r) => r.birth?.mutationProfile?.kind === "large")
          .length,
        immigrant: views.filter((r) => r.immigrant).length,
      },
    });
    if (
      e.generation === 1 ||
      e.generation % 10 === 0 ||
      e.curriculum.stage !== observations.at(-2)?.stage
    ) {
      console.log(JSON.stringify({ seed, ...observations.at(-1) }));
      writeAtomic(
        folder + `/seed-${seed}.json`,
        JSON.stringify(e.checkpoint()),
      );
      writeAtomic(
        folder + `/seed-${seed}.csv`,
        csv(e.history, e.config.rewardModel),
      );
      writeAtomic(
        folder + `/seed-${seed}-progress.json`,
        JSON.stringify(observations, null, 2),
      );
    }
    if (
      stopRequested ||
      e.generation === generations ||
      e.verifiedPolicy?.generation === e.generation
    )
      break;
    e.evolve(e.autoParents(), undefined, true);
  }
  writeAtomic(
    folder + `/seed-${seed}.csv`,
    csv(e.history, e.config.rewardModel),
  );
  writeAtomic(folder + `/seed-${seed}.json`, JSON.stringify(e.checkpoint()));
  writeAtomic(
    folder + `/seed-${seed}-progress.json`,
    JSON.stringify(observations, null, 2),
  );
  // Fitness values from different objectives must not be interpreted as one trend.
  const summary = {
    initialization: e.config.initialization,
    initialBalanceBias: e.config.initialBalanceBias,
    firstFourFeet:
      observations.find((o) => o.fourFootCandidates > 0)?.generation ?? null,
    firstRepeatedFourFeet:
      observations.find((o) => o.repeatedFourFootCandidates > 0)?.generation ??
      null,
    maxWalkingTime: Math.max(...observations.map((o) => o.maxWalkingTime)),
    stopped: stopRequested,
    resumedFromGeneration: resumed?.generation ?? null,
    firstForwardCandidate:
      observations.find((o) => o.forwardCandidates > 0)?.generation ?? null,
    firstFullSurvival:
      observations.find((o) => o.aliveAtTimeout > 0)?.generation ?? null,
    firstFullBalance:
      observations.find((o) => o.fullBalance > 0)?.generation ?? null,
    firstStep:
      observations.find((o) => o.maxValidSteps > 0)?.generation ?? null,
    maxSupport: Math.max(...observations.map((o) => o.maxLongestSupport)),
    controllerVersion: controllerVersion(baseConfig),
    selectionVersion: e.checkpoint().selectionVersion,
    rewardVersion: e.checkpoint().rewardVersion,
    firstJumped: observations[0].jumped,
    lastJumped: observations.at(-1)!.jumped,
    winnerAirTime: rank(e.robots.map((r) => r.view()))[0].frame.gait.airTime,
    winnerForward: rank(e.robots.map((r) => r.view()))[0].frame.gait
      .groundedForward,
    seed,
    generations: e.generation,
    requestedGenerations: generations,
    finalStage: e.curriculum.stage,
    firstPromotion:
      e.history.find((h) => h.stage === "stepping")?.generation ?? null,
    forwardPromotion:
      e.history.find((h) => h.stage === "forward")?.generation ?? null,
    verified: e.verifiedPolicy !== null,
    initialFitness: observations[0].bestFitness,
    finalFitness: observations.at(-1)!.bestFitness,
    initialSupportTime: observations[0].maxSupportTime,
    finalSupportTime: observations.at(-1)!.maxSupportTime,
    invalidEvaluations: observations.reduce((sum, g) => sum + g.invalid, 0),
    initial: e.history[0].bestDistanceM,
    final: e.history.at(-1)!.bestDistanceM,
    best: e.allTimeBest!.distance,
    seconds: (performance.now() - start) / 1000,
    heapMB: process.memoryUsage().heapUsed / 1048576,
    winnerSteps: rank(e.robots.map((r) => r.view()))[0].frame.gait.steps,
    winnerRawDistance: rank(e.robots.map((r) => r.view()))[0].frame.gait
      .rawDistance,
    winnerSlip: rank(e.robots.map((r) => r.view()))[0].frame.gait.slip,
  };
  summaries.push(summary);
  e.dispose();
  console.log(JSON.stringify(summary));
  if (stopRequested) break;
}
writeAtomic(folder + "/summary.json", JSON.stringify(summaries, null, 2));
console.log("결과 저장:", folder);
