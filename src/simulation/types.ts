import type { SharedSearchState, SharedMode } from "../genetics/sharedSearch";
import type { BalanceSearchState } from "../genetics/balanceSearch";
export type ControllerTransition = {
  effectiveGeneration: number;
  sourceGeneration: number;
  from: "timed-rnn-proprio-565-v4";
  to: "timed-rnn-proprio-periodic-589-v5";
  neutralGenes: 24;
  sourceSHA256: string;
};
export type Gene = number[];
export type Vec = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
export type Pose = Vec & { q: Quat; v: Vec; w: Vec };
export type FootState = {
  position: Vec;
  contact: boolean;
  swing: boolean;
  clearance: number;
};
export type Gait = {
  jointFreedom?: number;
  mobileSupportTime?: number;
  longestMobileSupport?: number;
  stopEffortTime?: number;
  rawDistance: number;
  steps: number[];
  footProgress?: number[];
  weightShift?: number[];
  stepActivity?: number[];
  contactCount: number;
  slip: number;
  walking: boolean;
  limbContact: boolean;
  uprightTime: number;
  supportTime: number;
  longestSupport: number;
  walkingTime: number;
  qualityWalkingTime: number;
  longestWalking: number;
  lateralTravel: number;
  lateralDeviation?: number;
  headingDeviation?: number;
  yawTravel: number;
  groundedForward: number;
  airTime: number;
  longestFlight: number;
  verticalMotion: number;
  jumping: boolean;
};
export type Frame = {
  tick: number;
  distance: number;
  bodies: Pose[];
  angles: number[];
  torques?: number[];
  feet: FootState[];
  gait: Gait;
};
export type Outcome =
  | "active"
  | "fallen"
  | "stalled"
  | "timeout"
  | "success"
  | "invalid"
  | "jumped";
export type MutationKind = "small" | "medium" | "large";
export type MutationProfile = {
  kind: MutationKind;
  rate: number;
  scale: number;
};
export type SearchPlan = {
  stage: TrainingStage;
  mode: "normal" | "recovery" | "stagnant";
  failureRate: number;
  preservedParentId?: number;
  anchorParentId?: number;
  anchorCount?: number;
  counts: Record<MutationKind | "immigrant" | "preserved", number>;
  profiles: Record<MutationKind, MutationProfile>;
};
export type Birth = {
  mutationProfile?: MutationProfile;
  mutationScope?:
    | "joint"
    | "leg"
    | "joint-group"
    | "sensor-column"
    | "output-coordinate"
    | "group-coordinate"
    | "network"
    | "output-network"
    | "joint-feedback"
    | "shared-covariance"
    | "balance-covariance"
    | "leg-time";
  generation: number;
  kind:
    | "elite"
    | "mutation"
    | "crossover"
    | "copy"
    | "explorer"
    | "recombination"
    | "stage-anchor";
  recombination?: {
    id: number;
    genes: Gene;
    latent: number[];
    weight: number;
  }[];
  parentGenes: Gene;
  changedGenes: number[];
};
export type EvolutionSettings = Pick<
  Config,
  "population" | "mutation" | "crossover" | "parentCount"
> & { mutationScale?: number; adaptiveSearch?: boolean };
export type Individual = {
  id: number;
  genes: Gene;
  champion: boolean;
  parents: number[];
  birth?: Birth;
  immigrant?: boolean;
};
export type ScoreBreakdown = {
  support: number;
  steps: number;
  forward: number;
  continuity: number;
  penalty: number;
  total: number;
};
export type RobotView = Individual & {
  score: ScoreBreakdown;
  frame: Frame;
  outcome: Outcome;
  reachedTick: number;
  fitness: number;
  energy: number;
  elapsed: number;
};
export type TrainingStage = "balance" | "stepping" | "forward";
export type CurriculumState = {
  stage: TrainingStage;
  startedGeneration: number;
  streak: number;
  pendingStage: TrainingStage | null;
};
export type ParentChoice = {
  id: number;
  reason:
    | "fitness"
    | "diversity"
    | "new-foot"
    | "foot-progress"
    | "balance-anchor"
    | "shared-search";
};
export type VerificationTrial = {
  label: string;
  roll: number;
  pitch: number;
  status: "running" | "passed" | "failed";
  outcome: Outcome;
  elapsed: number;
  distance: number;
  walkingTime: number;
  longestWalking?: number;
  walking?: boolean;
  longestFlight: number;
  lateralTravel: number;
  lateralDeviation?: number;
  headingDeviation?: number;
  yawTravel: number;
  jumping: boolean;
  steps: number[];
  footProgress?: number[];
  weightShift?: number[];
  stepActivity?: number[];
};
export type VerificationReport = {
  status: "running" | "passed" | "failed";
  generation: number;
  robotId: number;
  genes: Gene;
  trials: VerificationTrial[];
};
export type Stat = {
  rewardVersion?: RewardModel;
  stage: TrainingStage;
  maxSupportTime: number;
  maxFootCount: number;
  maxWalkingTime: number;
  qualifiedCount: number;
  generation: number;
  bestDistanceM: number;
  meanDistanceM: number;
  bestFitness: number;
  meanFitness: number;
  fallenCount: number;
  successCount: number;
  bestRobotId: number;
};
export type Ghost = {
  generation: number;
  robotId: number;
  distance: number;
  frames: Frame[];
};
export type RewardModel =
  | "temporal-curriculum-v4"
  | "supported-curriculum-v5"
  | "cycle-curriculum-v6"
  | "rhythmic-curriculum-v7"
  | "mobile-curriculum-v8";
export type Config = {
  controllerModel:
    | "timed-rnn"
    | "local-feedback-rnn"
    | "local-periodic-rnn"
    | "shared-reflex"
    | "shared-direction"
    | "shared-anatomical";
  searchMethod: "adaptive" | "covariance";
  rewardModel: RewardModel;
  name: string;
  seed: number;
  population: number;
  duration: number;
  target: number;
  mutation: number;
  crossover: number;
  mutationScale: number;
  adaptiveSearch: boolean;
  initialization: "random" | "weak-balance";
  initialBalanceBias: number;
  parentCount: number;
  curriculum: {
    balanceSeconds: number;
    steppingFeet: number;
    steppingSteps: number;
    steppingForward: number;
    coordinatedPromotion: boolean;
    promotionGenerations: number;
    forwardSeconds: number;
    forwardContinuousSeconds: number;
    requireWalkingAtFinish: boolean;
    useDriftLimits: boolean;
    mobileSupportRatio: number;
    minJointFreedomAtPromotion: number;
    maxLateralDeviation: number;
    maxHeadingDeviation: number;
    maxWalkingFlightTime: number;
    maxLateralTravel: number;
    maxYawTravel: number;
  };
  physics: {
    dt: number;
    gravity: number;
    friction: number;
    hipTorque: number;
    kneeTorque: number;
    maxSpeed: number;
    jointDamping: number;
    velocityIterations: number;
    positionIterations: number;
  };
  robot: {
    width: number;
    height: number;
    depth: number;
    coxa: number;
    upper: number;
    lower: number;
    footRadius: number;
    torsoMass: number;
    upperMass: number;
    lowerMass: number;
  };
  evaluation: {
    contactModel: "proximity" | "load-bearing";
    minHeight: number;
    stepMemory: number;
    walkingContinuityGrace: number;
    maxAirTime: number;
    maxVerticalSpeed: number;
    maxTilt: number;
    tiltGrace: number;
    warmup: number;
    stallWindow: number;
    stallDistance: number;
    footGrace: number;
    maxHeightMargin: number;
  };
};
export type Phase =
  "ready" | "running" | "validating" | "paused" | "selection" | "error";
export type Snapshot = {
  sharedSearchInfo?: {
    mode: SharedMode;
    dimensions: number;
    target: number;
    parentLimit: number;
  } | null;
  controllerTransitions?: ControllerTransition[];
  searchPlan: SearchPlan | null;
  curriculum: CurriculumState;
  parentSuggestions: ParentChoice[];
  verification: VerificationReport | null;
  verifiedPolicy: VerificationReport | null;
  config: Config;
  generation: number;
  tick: number;
  phase: Phase;
  auto: boolean;
  robots: RobotView[];
  history: Stat[];
  previousBest: Ghost | null;
  allTimeBest: Ghost | null;
  selected: number[];
  actualSpeed: number;
  savePending: boolean;
};
export type Checkpoint = {
  controllerTransitions?: ControllerTransition[];
  sharedSearch?: SharedSearchState | null;
  balanceSearch?: BalanceSearchState | null;
  formatVersion: 6;
  curriculum: CurriculumState;
  verification: VerificationReport | null;
  verifiedPolicy: VerificationReport | null;
  appVersion: string;
  engineVersion: string;
  controllerVersion: string;
  evolutionVersion:
    | "adaptive-mutation-v5"
    | "adaptive-mutation-v6"
    | "adaptive-mutation-v7"
    | "adaptive-mutation-v8"
    | "adaptive-mutation-v9"
    | "adaptive-mutation-v10"
    | "adaptive-mutation-v11"
    | "adaptive-mutation-v12"
    | "adaptive-mutation-v16"
    | "adaptive-mutation-v15"
    | "adaptive-mutation-v14"
    | "adaptive-mutation-v13"
    | "balance-covariance-v1"
    | "balance-covariance-v2"
    | "shared-mutation-v1"
    | "shared-covariance-v1"
    | "shared-covariance-v2"
    | "shared-covariance-v3";
  rewardVersion: RewardModel;
  selectionVersion:
    | "curriculum-diversity-v2"
    | "curriculum-diversity-v3"
    | "curriculum-diversity-v4"
    | "curriculum-diversity-v5"
    | "curriculum-diversity-v6"
    | "curriculum-diversity-v7"
    | "curriculum-diversity-v8"
    | "shared-selection-v1";
  generation: number;
  config: Config;
  population: Individual[];
  completedResults: RobotView[];
  selectedParentIds: number[];
  history: Stat[];
  previousBest: Ghost | null;
  allTimeBest: Ghost | null;
  rngState: number;
  evaluationTick: number;
  phase: "selection";
  autoEnabled: boolean;
  pendingSettings: EvolutionSettings | null;
};
export type Command =
  | { type: "init"; config: Config }
  | { type: "start"; auto: boolean }
  | { type: "pause" }
  | { type: "speed"; value: number }
  | { type: "select"; ids: number[] }
  | { type: "autoSelect" }
  | {
      type: "evolve";
      settings: EvolutionSettings;
    }
  | {
      type: "settings";
      settings: EvolutionSettings;
    }
  | { type: "save" }
  | { type: "load"; data: unknown };
export type Response =
  | { type: "snapshot"; data: Snapshot }
  | { type: "saved"; data: Checkpoint }
  | { type: "error"; message: string };
