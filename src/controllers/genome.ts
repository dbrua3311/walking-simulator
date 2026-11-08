import {
  SHARED_GENE_COUNT,
  SHARED_CONTROLLER_VERSION,
  ANATOMICAL_SHARED_CONTROLLER_VERSION,
  DIRECTION_SHARED_GENE_COUNT,
  DIRECTION_SHARED_CONTROLLER_VERSION,
} from "./shared";
import type { Config } from "../simulation/types";
// Genome layout only. No gait phases, foot trajectories, leg coordination or
// pretrained weights are encoded here. Every descriptor is sampled by the GA.
export const INPUT_NAMES = [
  ...Array.from({ length: 12 }, (_, i) => `관절 ${i + 1} 각도`),
  ...Array.from({ length: 12 }, (_, i) => `관절 ${i + 1} 속도`),
  "몸통 위 방향 x",
  "몸통 위 방향 y",
  "몸통 위 방향 z",
  "몸통 회전속도 x",
  "몸통 회전속도 y",
  "몸통 회전속도 z",
  "몸통 전후 속도",
  "몸통 수직 속도",
  "몸통 좌우 속도",
  ...Array.from({ length: 4 }, (_, i) => `발 ${i + 1} 접촉`),
  ...Array.from({ length: 4 }, (_, i) => `발 ${i + 1} 바닥 이격`),
  "몸통 높이",
];
export const SENSOR_SIZE = INPUT_NAMES.length;
INPUT_NAMES.push("시간 변화 sin", "시간 변화 cos");
export const INPUT_SIZE = INPUT_NAMES.length;
export const HIDDEN_SIZE = 8;
export const OUTPUT_SIZE = 12;
export const HIDDEN_STRIDE = INPUT_SIZE + HIDDEN_SIZE + 2;
export const OUTPUT_OFFSET = HIDDEN_SIZE * HIDDEN_STRIDE;
export const OUTPUT_STRIDE = HIDDEN_SIZE + 1;
export const JOINT_LIMITS: [number, number][] = Array.from(
  { length: 12 },
  (_, i) =>
    i % 3 === 0 ? [-0.7, 0.7] : i % 3 === 1 ? [-1.6, 1.1] : [0.12, 2.7],
);
const descriptors: { name: string; range: [number, number] }[] = [];
for (let h = 0; h < HIDDEN_SIZE; h++) {
  for (const name of INPUT_NAMES)
    descriptors.push({ name: `뉴런 ${h + 1} ← ${name}`, range: [-2, 2] });
  for (let j = 0; j < HIDDEN_SIZE; j++)
    descriptors.push({ name: `뉴런 ${h + 1} ← 기억 ${j + 1}`, range: [-2, 2] });
  descriptors.push({ name: `뉴런 ${h + 1} 편향`, range: [-2, 2] });
  descriptors.push({ name: `뉴런 ${h + 1} 시간상수 (s)`, range: [0.02, 1.5] });
}
for (let j = 0; j < OUTPUT_SIZE; j++) {
  for (let h = 0; h < HIDDEN_SIZE; h++)
    descriptors.push({
      name: `관절 ${j + 1} 토크 ← 뉴런 ${h + 1}`,
      range: [-2, 2],
    });
  descriptors.push({ name: `관절 ${j + 1} 토크 편향`, range: [-2, 2] });
}
export const FREQUENCY_INDEX = descriptors.length;
descriptors.push({ name: "시간 변화 주파수 (Hz)", range: [0.15, 3] });
// The original layout is kept byte-for-byte for old checkpoints.
export const GENE_COUNT = descriptors.length;
export const PROPRIO_OFFSET = GENE_COUNT;
for (let j = 0; j < OUTPUT_SIZE; j++) {
  descriptors.push({ name: `관절 ${j + 1} 자신의 각도 연결`, range: [-2, 2] });
  descriptors.push({ name: `관절 ${j + 1} 자신의 속도 연결`, range: [-2, 2] });
}
export const PROPRIO_GENE_COUNT = descriptors.length;
export const PERIODIC_OFFSET = descriptors.length;
for (let j = 0; j < OUTPUT_SIZE; j++)
  for (const component of ["sin", "cos"])
    descriptors.push({
      name: `관절 ${j + 1} 토크 ← 시간 ${component}`,
      range: [-2, 2],
    });
export const PERIODIC_GENE_COUNT = descriptors.length;
export const PERIODIC_CONTROLLER_VERSION = "timed-rnn-proprio-periodic-589-v5";
export const PROPRIO_CONTROLLER_VERSION = "timed-rnn-proprio-565-v4";
export const geneCount = (config?: Pick<Config, "controllerModel">) =>
  config?.controllerModel === "shared-direction" ||
  config?.controllerModel === "shared-anatomical"
    ? DIRECTION_SHARED_GENE_COUNT
    : config?.controllerModel === "shared-reflex"
      ? SHARED_GENE_COUNT
      : config?.controllerModel === "local-periodic-rnn"
        ? PERIODIC_GENE_COUNT
        : config?.controllerModel === "local-feedback-rnn"
          ? PROPRIO_GENE_COUNT
          : GENE_COUNT;
export const controllerVersion = (config: Pick<Config, "controllerModel">) =>
  config.controllerModel === "shared-anatomical"
    ? ANATOMICAL_SHARED_CONTROLLER_VERSION
    : config.controllerModel === "shared-direction"
      ? DIRECTION_SHARED_CONTROLLER_VERSION
      : config.controllerModel === "shared-reflex"
        ? SHARED_CONTROLLER_VERSION
        : config.controllerModel === "local-periodic-rnn"
          ? PERIODIC_CONTROLLER_VERSION
          : config.controllerModel === "local-feedback-rnn"
            ? PROPRIO_CONTROLLER_VERSION
            : CONTROLLER_VERSION;
export const assemblyAngle = (j: number) => {
  const [lo, hi] = JOINT_LIMITS[j];
  return (2 * ([0, -0.6, 1.2][j % 3] - lo)) / (hi - lo) - 1;
};
export const GENE_NAMES = descriptors.map((d) => d.name);
export const GENE_RANGES = descriptors.map((d) => d.range);
export const CONTROLLER_VERSION = "timed-rnn-42+2x8x12-v3";

// Small symmetric initial signals avoid saturating all motors before the first
// sensory response. All values remain random; no joint, side or gait is favoured.
export const INITIAL_RANGES: [number, number][] = descriptors.map((_, i) => {
  if (i >= PERIODIC_OFFSET) return [-0.01, 0.01];
  if (i >= PROPRIO_OFFSET)
    return (i - PROPRIO_OFFSET) % 2 === 0 ? [-1, 1] : [-0.15, 0.15];
  if (i === FREQUENCY_INDEX) return [0.3, 1.5];
  if (i < OUTPUT_OFFSET) {
    const local = i % HIDDEN_STRIDE;
    return local === INPUT_SIZE + HIDDEN_SIZE + 1
      ? [0.02, 0.2]
      : local === INPUT_SIZE + HIDDEN_SIZE
        ? [-0.2, 0.2]
        : [-0.5, 0.5];
  }
  return (i - OUTPUT_OFFSET) % OUTPUT_STRIDE === HIDDEN_SIZE
    ? [-0.1, 0.1]
    : [-0.25, 0.25];
});

// Initial distribution only: approximate static joint loads for the common
// assembly [0,-.6,1.2]. No angles, contacts or time are tracked by this prior.
// Every neural connection remains random and evolves without this constraint.
export function initialBalanceOffsets(config: Config): number[] {
  if (
    config.initialization !== "weak-balance" ||
    config.initialBalanceBias === 0
  )
    return Array(OUTPUT_SIZE).fill(0);
  const c = config.robot,
    p = config.physics,
    g = Math.abs(p.gravity);
  const load = ((c.torsoMass + 4 * (0.15 + c.upperMass + c.lowerMass)) * g) / 4;
  const bend = Math.sin(0.6),
    kneeX = -c.upper * bend;
  const footX = kneeX + c.lower * bend;
  const hip = -(
    footX * load -
    g *
      ((c.upperMass * kneeX) / 2 +
        c.lowerMass * 0.8 * (kneeX + (c.lower * bend) / 2) +
        c.lowerMass * 0.2 * footX)
  );
  const knee = -(
    c.lower * bend * load -
    g * c.lowerMass * 0.6 * c.lower * bend
  );
  const shoulder = c.coxa * (load - g * (0.15 / 2 + c.upperMass + c.lowerMass));
  return Array.from({ length: OUTPUT_SIZE }, (_, j) => {
    const torque =
      j % 3 === 0
        ? (Math.floor(j / 3) % 2 === 0 ? 1 : -1) * shoulder
        : j % 3 === 1
          ? hip
          : knee;
    const limit = j % 3 === 2 ? p.kneeTorque : p.hipTorque;
    return limit === 0
      ? 0
      : Math.atanh(
          Math.max(
            -0.15,
            Math.min(0.15, (config.initialBalanceBias * torque) / limit),
          ),
        );
  });
}
