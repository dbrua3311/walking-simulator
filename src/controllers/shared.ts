// A small evolvable policy shared across anatomically equivalent joints.
// Own joint observations and four independent phase alleles distinguish legs.
// No gain sign, leg sequence, foot trajectory, target angle or learned DNA is set.
export const SHARED_GENE_COUNT = 38;
export const SHARED_CONTROLLER_VERSION = "shared-reflex-phase-38-v6";
const jointNames = ["어깨", "엉덩이", "무릎"];
const featureNames = [
  "편향",
  "자신의 각도",
  "자신의 속도",
  "몸통 위 방향 x",
  "몸통 위 방향 z",
  "몸통 회전속도 x",
  "몸통 회전속도 z",
  "시간 sin",
  "시간 cos",
];
export const SHARED_GENE_NAMES = [
  ...jointNames.flatMap((j) =>
    featureNames.map((f) => `${j} 공통 규칙 ← ${f}`),
  ),
  ...Array.from({ length: 4 }, (_, l) => `다리 ${l + 1}의 자유 위상 (rad)`),
  "시간 변화 주파수 (Hz)",
  ...jointNames.map((j) => `${j} ← 몸통 회전속도 y · 다리 위치`),
  ...jointNames.map((j) => `${j} ← 몸통 좌우 속도`),
];
export const SHARED_RANGES: [number, number][] = Array.from(
  { length: SHARED_GENE_COUNT },
  (_, i) =>
    i >= 27 && i < 31 ? [-Math.PI, Math.PI] : i === 31 ? [0.15, 3] : [-2, 2],
);
const widths = [0.1, 1, 0.15, 0.2, 0.2, 0.1, 0.1, 0.01, 0.01];
export const SHARED_INITIAL_RANGES: [number, number][] = SHARED_RANGES.map(
  ([lo, hi], i) =>
    i >= 27 && i < 31
      ? [lo, hi]
      : i === 31
        ? [0.3, 1.5]
        : i >= 32
          ? [-0.01, 0.01]
          : [-widths[i % 9], widths[i % 9]],
);
export const DIRECTION_SHARED_GENE_COUNT = 44;
export const ANATOMICAL_SHARED_CONTROLLER_VERSION =
  "anatomical-shared-phase-44-v8";
export const DIRECTION_SHARED_CONTROLLER_VERSION =
  "shared-direction-phase-44-v7";
export const DIRECTION_SHARED_GENE_NAMES = [
  ...SHARED_GENE_NAMES,
  ...jointNames.map((j) => `${j} ← 기준 전진 방향과의 차이 · 다리 위치`),
  ...jointNames.map((j) => `${j} ← 기준선에서 좌우 위치`),
];
export const DIRECTION_SHARED_RANGES: [number, number][] = [
  ...SHARED_RANGES,
  ...Array.from({ length: 6 }, () => [-2, 2] as [number, number]),
];
export const DIRECTION_SHARED_INITIAL_RANGES: [number, number][] = [
  ...SHARED_INITIAL_RANGES,
  ...Array.from({ length: 6 }, () => [-0.01, 0.01] as [number, number]),
];
export const isSharedModel = (model: string | undefined) =>
  model === "shared-reflex" ||
  model === "shared-direction" ||
  model === "shared-anatomical";
export const sharedGeneCount = (model: string) =>
  model === "shared-direction" || model === "shared-anatomical"
    ? DIRECTION_SHARED_GENE_COUNT
    : SHARED_GENE_COUNT;
export const sharedRanges = (count: number) =>
  count === DIRECTION_SHARED_GENE_COUNT
    ? DIRECTION_SHARED_RANGES
    : SHARED_RANGES;
export const sharedInitialRanges = (count: number) =>
  count === DIRECTION_SHARED_GENE_COUNT
    ? DIRECTION_SHARED_INITIAL_RANGES
    : SHARED_INITIAL_RANGES;
export const sharedGeneNames = (count: number) =>
  count === DIRECTION_SHARED_GENE_COUNT
    ? DIRECTION_SHARED_GENE_NAMES
    : SHARED_GENE_NAMES;
export const wrapPhase = (value: number) =>
  Math.atan2(Math.sin(value), Math.cos(value));
export function sharedTorques(
  genes: number[],
  inputs: number[],
  elapsed: number,
  anatomical = false,
) {
  const ramp = 1 - Math.exp(-elapsed / 0.35);
  return Array.from({ length: 12 }, (_, j) => {
    const k = (j % 3) * 9,
      leg = Math.floor(j / 3),
      phase = 2 * Math.PI * ((elapsed * genes[31]) % 1) + genes[27 + leg];
    const side = leg % 2 === 0 ? 1 : -1,
      anatomic = anatomical && genes.length === DIRECTION_SHARED_GENE_COUNT,
      shoulderSign = anatomic && j % 3 === 0 ? side : 1,
      rollSign = anatomic ? side : 1;
    // Local leg coordinates: the same abduction means opposite world-axis
    // rotation on mirrored sides. This specifies anatomy, not a gait or gain.
    const features = [
      1,
      inputs[j] * shoulderSign,
      inputs[12 + j] * shoulderSign,
      inputs[24],
      inputs[26] * rollSign,
      inputs[27] * rollSign,
      inputs[29],
      ramp * Math.sin(phase),
      ramp * Math.cos(phase),
    ];
    const front = leg < 2 ? 1 : -1;
    const sum = features.reduce((total, v, i) => total + genes[k + i] * v, 0);
    const parity = j % 3 === 0 ? front : side,
      lateralParity = anatomic && j % 3 !== 0 ? side : 1;
    let command =
      sum * shoulderSign +
      genes[32 + (j % 3)] * inputs[28] * parity +
      genes[35 + (j % 3)] * inputs[32] * lateralParity;
    if (genes.length === DIRECTION_SHARED_GENE_COUNT)
      command +=
        genes[38 + (j % 3)] * inputs[42] * parity +
        genes[41 + (j % 3)] * inputs[43] * lateralParity;
    return Math.tanh(command);
  });
}
