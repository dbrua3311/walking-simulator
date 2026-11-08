import { isSharedModel } from "../controllers/shared";
import {
  breedSharedSearch,
  sharedParents,
  sharedPlan,
  sharedIndices,
  useSharedSearch,
  type SharedSearchState,
} from "../genetics/sharedSearch";
import {
  breedBalance,
  covarianceParents,
  useCovariance,
  type BalanceSearchState,
} from "../genetics/balanceSearch";
import { isPracticeReward, isRhythmicReward } from "../physics/assessment";
import { controllerVersion } from "../controllers/genome";
import { configSchema } from "./config";
import {
  Random,
  randomGenes,
  breed,
  rank,
  rankDistance,
  suggestParents,
  planSearch,
  landingExplorer,
} from "../genetics/evolution";
import {
  initialCurriculum,
  assessCurriculum,
  enterNextGeneration,
  meetsStage,
  distinctFeet,
} from "./curriculum";
import { PolicyVerification } from "./verification";
import { Robot } from "../physics/robot";
import type {
  Checkpoint,
  ControllerTransition,
  Config,
  EvolutionSettings,
  Ghost,
  Individual,
  Phase,
  Snapshot,
  Stat,
  VerificationReport,
} from "./types";
const evolutionKeys = new Set([
  "population",
  "mutation",
  "mutationScale",
  "adaptiveSearch",
  "crossover",
  "parentCount",
]);
function validateEvolutionSettings(settings?: EvolutionSettings) {
  if (settings && Object.keys(settings).some((key) => !evolutionKeys.has(key)))
    throw new Error("진화 설정으로 평가·초기화 기준을 변경할 수 없습니다.");
}
export class Experiment {
  controllerTransitions: ControllerTransition[] = [];
  sharedSearch: SharedSearchState | null = null;
  balanceSearch: BalanceSearchState | null = null;
  curriculum = initialCurriculum();
  verification: VerificationReport | null = null;
  verifiedPolicy: VerificationReport | null = null;
  verifier?: PolicyVerification;
  private pausedPhase: "running" | "validating" = "running";
  config: Config;
  rng: Random;
  generation = 1;
  evolutionVersion: Checkpoint["evolutionVersion"] = "adaptive-mutation-v11";
  selectionVersion: Checkpoint["selectionVersion"] = "curriculum-diversity-v4";
  tick = 0;
  phase: Phase = "ready";
  auto = false;
  selected: number[] = [];
  robots: Robot[] = [];
  history: Stat[] = [];
  previousBest: Ghost | null = null;
  allTimeBest: Ghost | null = null;
  savePending = false;
  onSave?: (data: Checkpoint) => void;
  constructor(config: Config) {
    this.config = configSchema.parse(config);
    if (isPracticeReward(this.config.rewardModel)) {
      this.evolutionVersion =
        this.config.controllerModel === "local-periodic-rnn"
          ? "adaptive-mutation-v16"
          : ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
                this.config.rewardModel,
              )
            ? "adaptive-mutation-v14"
            : this.config.controllerModel === "local-feedback-rnn"
              ? "adaptive-mutation-v13"
              : "adaptive-mutation-v12";
      this.selectionVersion =
        this.config.controllerModel === "local-periodic-rnn"
          ? "curriculum-diversity-v8"
          : ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
                this.config.rewardModel,
              )
            ? "curriculum-diversity-v7"
            : "curriculum-diversity-v6";
    }
    if (isSharedModel(this.config.controllerModel)) {
      this.evolutionVersion = "shared-mutation-v1";
      this.selectionVersion = "shared-selection-v1";
    }
    this.rng = new Random(this.config.seed);
    this.create(
      Array.from({ length: this.config.population }, (_, i) => ({
        id: i + 1,
        genes: randomGenes(this.rng, this.config),
        champion: false,
        parents: [],
      })),
    );
  }
  create(population: Individual[]) {
    for (const robot of this.robots) robot.dispose();
    this.robots = population.map(
      (i) => new Robot(i, this.config, this.curriculum.stage),
    );
    this.tick = 0;
    this.selected = [];
  }
  start(auto: boolean) {
    this.auto = auto;
    if (this.phase === "selection") {
      if (auto) this.evolve(this.autoParents(), undefined, true);
      return;
    }
    this.phase =
      this.phase === "paused"
        ? this.pausedPhase
        : this.phase === "validating"
          ? "validating"
          : "running";
  }
  pause() {
    this.auto = false;
    if (
      this.phase === "running" ||
      this.phase === "validating" ||
      this.phase === "ready"
    ) {
      this.pausedPhase = this.phase === "validating" ? "validating" : "running";
      this.phase = "paused";
    }
  }
  pendingSettings?: EvolutionSettings;
  queueSettings(settings: NonNullable<Experiment["pendingSettings"]>) {
    validateEvolutionSettings(settings);
    configSchema.parse({ ...this.config, ...settings });
    this.pendingSettings = { ...settings };
  }
  private balanceAnchor(config = this.config) {
    if (
      !["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
        config.rewardModel,
      ) ||
      (this.curriculum.stage === "balance" && !this.curriculum.pendingStage)
    )
      return;
    const views = this.robots.map((r) => r.view()),
      best = rank(views)[0];
    const anchor = views
      .filter((r) => meetsStage(r, "balance", config))
      .sort(
        (a, b) =>
          (b.frame.gait.mobileSupportTime ?? 0) -
            (a.frame.gait.mobileSupportTime ?? 0) ||
          b.fitness - a.fitness ||
          a.id - b.id,
      )[0];
    return anchor?.id !== best.id ? anchor : undefined;
  }
  parentSuggestions() {
    const config = { ...this.config, ...this.pendingSettings };
    if (useSharedSearch(config))
      return sharedParents(
        this.robots.map((r) => r.view()),
        config,
        this.curriculum.pendingStage ?? this.curriculum.stage,
        this.generation,
        this.sharedSearch,
      ).map((id) => ({ id, reason: "shared-search" as const }));
    if (
      useCovariance(config, this.curriculum.stage) &&
      !this.curriculum.pendingStage
    )
      return covarianceParents(
        this.robots.map((r) => r.view()),
        config,
        this.balanceSearch,
      ).map((id) => ({ id, reason: "fitness" as const }));
    let choices = suggestParents(
      this.robots.map((r) => r.view()),
      config.parentCount,
      this.selectionVersion !== "curriculum-diversity-v2"
        ? this.curriculum.stage
        : "balance",
      this.selectionVersion !== "curriculum-diversity-v2" &&
        this.selectionVersion !== "curriculum-diversity-v3",
      isPracticeReward(config.rewardModel),
      config.controllerModel === "local-periodic-rnn" ? 0.9 : undefined,
    );
    const explorer = landingExplorer(
      this.robots.map((r) => r.view()),
      config,
    );
    if (
      explorer &&
      config.parentCount > 1 &&
      !choices.some((c) => c.id === explorer.id)
    )
      choices = [
        ...choices.slice(0, config.parentCount - 1),
        { id: explorer.id, reason: "foot-progress" },
      ];
    const anchor = this.balanceAnchor(config);
    if (anchor && !choices.some((c) => c.id === anchor.id))
      return [
        ...choices.slice(0, Math.max(0, config.parentCount - 1)),
        { id: anchor.id, reason: "balance-anchor" as const },
      ];
    return choices;
  }
  nextSearchPlan(config = { ...this.config, ...this.pendingSettings }) {
    const plan = planSearch(
      this.robots.map((r) => r.view()),
      this.history,
      { ...config, preserveChampion: false },
      ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
        config.rewardModel,
      )
        ? (this.curriculum.pendingStage ?? this.curriculum.stage)
        : this.curriculum.stage,
      Boolean(this.curriculum.pendingStage),
    );
    const anchor = this.balanceAnchor(config);
    if (anchor && anchor.id !== plan.preservedParentId) {
      // A two-robot population has one spare seat: keep actual balance first.
      if (plan.counts.small === 0 && plan.counts.preserved) {
        plan.preservedParentId = undefined;
        plan.counts.preserved = 0;
        plan.counts.small++;
      }
      if (plan.counts.small > 0) {
        plan.counts.small--;
        plan.anchorParentId = anchor.id;
        plan.anchorCount = 1;
      }
    }
    return plan;
  }
  autoParents() {
    return this.parentSuggestions().map((c) => c.id);
  }
  evolve(
    ids: number[] = this.selected,
    settings?: EvolutionSettings,
    automatic = false,
  ) {
    if (this.phase !== "selection")
      throw new Error("모든 개체의 평가가 끝난 뒤 세대를 생성하세요.");
    validateEvolutionSettings(settings ?? this.pendingSettings);
    const nextConfig = configSchema.parse({
      ...this.config,
      ...(settings ?? this.pendingSettings),
      preserveChampion: false,
    });
    const shared =
      automatic && useSharedSearch(nextConfig)
        ? breedSharedSearch(
            this.robots.map((r) => r.view()),
            nextConfig,
            this.rng,
            this.generation,
            this.curriculum.pendingStage ?? this.curriculum.stage,
            this.sharedSearch,
          )
        : null;
    const distribution =
      automatic &&
      useCovariance(nextConfig, this.curriculum.stage) &&
      !this.curriculum.pendingStage
        ? breedBalance(
            this.robots.map((r) => r.view()),
            nextConfig,
            this.rng,
            this.generation,
            this.balanceSearch,
          )
        : null;
    const population =
      shared?.population ??
      distribution?.population ??
      breed(
        this.robots.map((r) => r.view()),
        ids,
        nextConfig,
        this.rng,
        this.generation,
        this.nextSearchPlan(nextConfig),
      );
    this.evolutionVersion =
      nextConfig.controllerModel === "local-periodic-rnn"
        ? "adaptive-mutation-v16"
        : ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
              nextConfig.rewardModel,
            )
          ? "adaptive-mutation-v14"
          : nextConfig.controllerModel === "local-feedback-rnn"
            ? "adaptive-mutation-v13"
            : isPracticeReward(nextConfig.rewardModel)
              ? "adaptive-mutation-v12"
              : "adaptive-mutation-v11";
    this.selectionVersion =
      nextConfig.controllerModel === "local-periodic-rnn"
        ? "curriculum-diversity-v8"
        : ["mobile-curriculum-v8", "settled-curriculum-v9"].includes(
              nextConfig.rewardModel,
            )
          ? "curriculum-diversity-v7"
          : isPracticeReward(nextConfig.rewardModel)
            ? "curriculum-diversity-v6"
            : "curriculum-diversity-v4";
    if (isSharedModel(nextConfig.controllerModel)) {
      this.evolutionVersion = "shared-mutation-v1";
      this.selectionVersion = "shared-selection-v1";
    }
    this.sharedSearch = shared?.state ?? null;
    if (shared) this.evolutionVersion = shared.state.version;
    this.balanceSearch = distribution?.state ?? null;
    if (distribution) this.evolutionVersion = distribution.state.version;
    this.config = nextConfig;
    this.pendingSettings = undefined;
    this.generation++;
    this.curriculum = enterNextGeneration(this.curriculum, this.generation);
    this.create(population);
    this.phase = "running";
  }
  step() {
    if (this.phase === "validating") {
      this.verifier!.step();
      if (this.verifier!.done) {
        this.verification = this.verifier!.report();
        this.verifier!.dispose();
        this.verifier = undefined;
        if (this.verification.status === "passed") {
          this.verifiedPolicy = structuredClone(this.verification);
          this.auto = false;
        }
        this.finishGeneration();
      }
      return;
    }
    if (this.phase !== "running") return;
    this.tick++;
    for (const robot of this.robots) robot.step();
    if (this.robots.every((r) => r.outcome !== "active")) this.complete();
  }
  complete() {
    this.phase = "selection";
    const views = this.robots.map((r) => r.view()),
      ordered = rankDistance(views),
      best = ordered[0];
    const mean = (numbers: number[]) =>
      numbers.reduce((a, b) => a + b, 0) / numbers.length;
    this.history.push({
      ...(isRhythmicReward(this.config.rewardModel)
        ? { rewardVersion: this.config.rewardModel }
        : {}),
      stage: this.curriculum.stage,
      maxSupportTime: Math.max(
        ...views.map((r) => r.frame.gait.longestSupport),
      ),
      maxFootCount: Math.max(...views.map(distinctFeet)),
      maxWalkingTime: Math.max(...views.map((r) => r.frame.gait.walkingTime)),
      qualifiedCount: views.filter((r) =>
        meetsStage(r, this.curriculum.stage, this.config),
      ).length,
      generation: this.generation,
      bestDistanceM: best.frame.distance,
      meanDistanceM: mean(views.map((r) => r.frame.distance)),
      bestFitness: Math.max(...views.map((r) => r.fitness)),
      meanFitness: mean(views.map((r) => r.fitness)),
      fallenCount: views.filter((r) => r.outcome === "fallen").length,
      successCount: views.filter((r) => r.outcome === "success").length,
      bestRobotId: best.id,
    });
    const winner = this.robots.find((r) => r.individual.id === best.id)!;
    this.previousBest = {
      generation: this.generation,
      robotId: best.id,
      distance: best.frame.distance,
      frames: structuredClone(winner.trajectory),
    };
    if (!this.allTimeBest || best.frame.distance > this.allTimeBest.distance)
      this.allTimeBest = structuredClone(this.previousBest);
    this.curriculum = assessCurriculum(this.curriculum, views, this.config);
    const candidate = rank(views).find((r) =>
      meetsStage(r, "forward", this.config),
    );
    if (
      this.curriculum.stage === "forward" &&
      candidate &&
      JSON.stringify(candidate.genes) !==
        JSON.stringify(this.verification?.genes)
    ) {
      this.verifier = new PolicyVerification(
        candidate,
        this.generation,
        this.config,
      );
      this.phase = "validating";
    } else this.finishGeneration();
  }
  private finishGeneration() {
    this.phase = "selection";
    if (this.savePending) {
      this.savePending = false;
      this.onSave?.(this.checkpoint());
    }
  }
  snapshot(actualSpeed = 0): Snapshot {
    return {
      controllerTransitions: this.controllerTransitions,
      sharedSearchInfo: useSharedSearch(this.config)
        ? (() => {
            const plan = sharedPlan(
              this.robots.map((r) => r.view()),
              this.config,
              this.curriculum.pendingStage ?? this.curriculum.stage,
              this.generation,
              this.sharedSearch,
            );
            return {
              mode: plan.mode,
              dimensions: sharedIndices(
                plan.mode,
                this.robots[0].individual.genes.length,
              ).length,
              target: plan.target,
              parentLimit: plan.mu,
            };
          })()
        : null,
      searchPlan:
        this.phase === "selection" && !useSharedSearch(this.config)
          ? this.nextSearchPlan()
          : null,
      curriculum: { ...this.curriculum },
      verification: this.verifier?.report() ?? this.verification,
      verifiedPolicy: this.verifiedPolicy,
      parentSuggestions: this.parentSuggestions(),
      config: this.config,
      generation: this.generation,
      tick: this.tick,
      phase: this.phase,
      auto: this.auto,
      robots: this.robots.map((r) => r.view()),
      history: this.history,
      previousBest: this.previousBest,
      allTimeBest: this.allTimeBest,
      selected: this.selected,
      actualSpeed,
      savePending: this.savePending,
    };
  }
  checkpoint(): Checkpoint {
    if (this.phase !== "selection")
      throw new Error("세대 종료 후 저장할 수 있습니다.");
    return structuredClone({
      controllerTransitions: this.controllerTransitions,
      sharedSearch: this.sharedSearch,
      balanceSearch: this.balanceSearch,
      formatVersion: 6,
      appVersion: "0.17.0",
      engineVersion: "rapier3d-0.21.0",
      controllerVersion: controllerVersion(this.config),
      evolutionVersion: this.evolutionVersion,
      rewardVersion: this.config.rewardModel,
      selectionVersion: this.selectionVersion,
      generation: this.generation,
      curriculum: this.curriculum,
      verification: this.verification,
      verifiedPolicy: this.verifiedPolicy,
      config: this.config,
      population: this.robots.map((r) => r.individual),
      completedResults: this.robots.map((r) => r.view()),
      selectedParentIds: this.selected,
      history: this.history,
      previousBest: this.previousBest,
      allTimeBest: this.allTimeBest,
      rngState: this.rng.state,
      evaluationTick: this.tick,
      phase: "selection",
      autoEnabled: this.auto,
      pendingSettings: this.pendingSettings ?? null,
    });
  }
  dispose() {
    this.verifier?.dispose();
    this.verifier = undefined;
    for (const robot of this.robots) robot.dispose();
    this.robots = [];
  }
  static restore(checkpoint: Checkpoint): Experiment {
    // Each resumed run owns its history, DNA and selections. Evaluating a run
    // must not modify the parsed source or another run restored from it.
    const data = structuredClone(checkpoint);
    const experiment = new Experiment(data.config);
    experiment.controllerTransitions = structuredClone(
      data.controllerTransitions ?? [],
    );
    experiment.sharedSearch = structuredClone(data.sharedSearch ?? null);
    experiment.balanceSearch = structuredClone(data.balanceSearch ?? null);
    experiment.generation = data.generation;
    experiment.evolutionVersion = data.evolutionVersion;
    experiment.selectionVersion = data.selectionVersion;
    experiment.curriculum = structuredClone(data.curriculum);
    experiment.verification = structuredClone(data.verification);
    experiment.verifiedPolicy = structuredClone(data.verifiedPolicy);
    experiment.create(data.population);
    experiment.robots.forEach((r, i) => r.restore(data.completedResults[i]));
    experiment.rng.state = data.rngState;
    experiment.history = data.history;
    experiment.previousBest = data.previousBest;
    experiment.allTimeBest = data.allTimeBest;
    experiment.tick = data.evaluationTick;
    experiment.selected = data.selectedParentIds;
    experiment.phase = "selection";
    experiment.auto = false;
    experiment.pendingSettings = data.pendingSettings ?? undefined;
    return experiment;
  }
}
