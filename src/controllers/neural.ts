import {
  SHARED_GENE_COUNT,
  DIRECTION_SHARED_GENE_COUNT,
  sharedTorques,
} from "./shared";
import {
  HIDDEN_SIZE,
  HIDDEN_STRIDE,
  INPUT_SIZE,
  SENSOR_SIZE,
  FREQUENCY_INDEX,
  OUTPUT_OFFSET,
  OUTPUT_SIZE,
  OUTPUT_STRIDE,
  GENE_COUNT,
  PROPRIO_GENE_COUNT,
  PROPRIO_OFFSET,
  PERIODIC_OFFSET,
  PERIODIC_GENE_COUNT,
} from "./genome";
// A deterministic, evolvable recurrent policy: sensor state -> joint torque.
// A random, evolvable temporal basis allows continuing output changes even at
// constant sensor readings. It defines no leg order, foot path or posture target.
export class NeuralController {
  elapsed = 0;
  readonly memory = new Float64Array(HIDDEN_SIZE);
  readonly activation = new Float64Array(HIDDEN_SIZE);
  constructor(
    readonly genes: number[],
    readonly anatomical = false,
  ) {
    if (
      ![
        GENE_COUNT,
        PROPRIO_GENE_COUNT,
        PERIODIC_GENE_COUNT,
        SHARED_GENE_COUNT,
        DIRECTION_SHARED_GENE_COUNT,
      ].includes(genes.length) ||
      !genes.every(Number.isFinite)
    )
      throw new Error("신경망 유전자 크기 또는 값 오류");
  }
  step(inputs: number[], dt: number): number[] {
    if (
      inputs.length !==
        (this.genes.length === DIRECTION_SHARED_GENE_COUNT
          ? SENSOR_SIZE + 2
          : SENSOR_SIZE) ||
      !inputs.every(Number.isFinite) ||
      !(dt > 0) ||
      !Number.isFinite(dt)
    )
      throw new Error("신경망 센서 입력 오류");
    if (
      this.genes.length === SHARED_GENE_COUNT ||
      this.genes.length === DIRECTION_SHARED_GENE_COUNT
    ) {
      const output = sharedTorques(
        this.genes,
        inputs,
        this.elapsed,
        this.anatomical,
      );
      this.elapsed += dt;
      return output;
    }
    const phase =
      2 * Math.PI * ((this.elapsed * this.genes[FREQUENCY_INDEX]) % 1);
    const features = [...inputs, Math.sin(phase), Math.cos(phase)];
    const previous = this.memory.slice();
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      const base = h * HIDDEN_STRIDE;
      let sum = this.genes[base + INPUT_SIZE + HIDDEN_SIZE];
      for (let i = 0; i < INPUT_SIZE; i++)
        sum +=
          (this.genes[base + i] * features[i]) /
          (i < SENSOR_SIZE ? Math.sqrt(SENSOR_SIZE) : 1);
      for (let j = 0; j < HIDDEN_SIZE; j++)
        sum +=
          (this.genes[base + INPUT_SIZE + j] * previous[j]) /
          Math.sqrt(HIDDEN_SIZE);
      const tau = this.genes[base + INPUT_SIZE + HIDDEN_SIZE + 1];
      const alpha = 1 - Math.exp(-dt / Math.max(0.02, tau));
      this.activation[h] = Math.tanh(sum);
      this.memory[h] = previous[h] + alpha * (this.activation[h] - previous[h]);
    }
    this.elapsed += dt;
    return Array.from({ length: OUTPUT_SIZE }, (_, j) => {
      const base = OUTPUT_OFFSET + j * OUTPUT_STRIDE;
      let sum = this.genes[base + HIDDEN_SIZE];
      for (let h = 0; h < HIDDEN_SIZE; h++)
        sum +=
          (this.genes[base + h] * this.activation[h]) / Math.sqrt(HIDDEN_SIZE);
      if (this.genes.length >= PROPRIO_GENE_COUNT)
        sum +=
          this.genes[PROPRIO_OFFSET + j * 2] * inputs[j] +
          this.genes[PROPRIO_OFFSET + j * 2 + 1] * inputs[12 + j];
      if (this.genes.length === PERIODIC_GENE_COUNT)
        sum +=
          this.genes[PERIODIC_OFFSET + j * 2] * Math.sin(phase) +
          this.genes[PERIODIC_OFFSET + j * 2 + 1] * Math.cos(phase);
      return Math.tanh(sum);
    });
  }
}
