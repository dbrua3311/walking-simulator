import { describe, it, expect } from "vitest";
import { NeuralController } from "../controllers/neural";
import {
  initialBalanceOffsets,
  GENE_COUNT,
  HIDDEN_SIZE,
  INPUT_SIZE,
  SENSOR_SIZE,
  FREQUENCY_INDEX,
  OUTPUT_SIZE,
  GENE_RANGES,
  OUTPUT_OFFSET,
  OUTPUT_STRIDE,
} from "../controllers/genome";
import { Random, randomGenes } from "../genetics/evolution";
import { cloneConfig } from "../simulation/config";
const neutral = () =>
  GENE_RANGES.map(([lo, hi]) => (lo > 0 ? (lo + hi) / 2 : 0));
describe("무작위 순환 신경망", () => {
  it("42센서+2시간 입력·8순환 뉴런·12토크의 541개 유전자를 모두 무작위 생성한다", () => {
    expect([INPUT_SIZE, HIDDEN_SIZE, OUTPUT_SIZE, GENE_COUNT]).toEqual([
      44, 8, 12, 541,
    ]);
    const a = randomGenes(new Random(2026)),
      b = randomGenes(new Random(2027));
    expect(a).toHaveLength(GENE_COUNT);
    expect(a).not.toEqual(b);
    expect(a).toEqual(randomGenes(new Random(2026)));
    a.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(GENE_RANGES[i][0]);
      expect(v).toBeLessThanOrEqual(GENE_RANGES[i][1]);
    });
  });
  it("0연결 가중치에는 시간 신호가 있어도 자동 보행·자세 보정 출력이 없다", () => {
    const policy = new NeuralController(neutral()),
      rng = new Random(1);
    for (let t = 0; t < 120; t++)
      expect(
        policy.step(
          Array.from({ length: SENSOR_SIZE }, () => rng.next() * 2 - 1),
          1 / 120,
        ),
      ).toEqual(Array(12).fill(0));
  });
  it("관절별 출력은 연결된 실제 유전자에 따라 독립적으로 바뀐다", () => {
    const genes = neutral();
    genes[OUTPUT_OFFSET + 4 * OUTPUT_STRIDE + HIDDEN_SIZE] = 1;
    const output = new NeuralController(genes).step(
      Array(SENSOR_SIZE).fill(0),
      1 / 120,
    );
    output.forEach((v, i) => expect(v).toBe(i === 4 ? Math.tanh(1) : 0));
  });
  it("같은 센서 입력과 유전자는 같은 기억·출력을 만들고 유전자 원본을 바꾸지 않는다", () => {
    const genes = randomGenes(new Random(9)),
      original = [...genes],
      a = new NeuralController(genes),
      b = new NeuralController([...genes]),
      rng = new Random(3);
    for (let t = 0; t < 120; t++) {
      const x = Array.from({ length: SENSOR_SIZE }, () => rng.next() * 2 - 1);
      const output = a.step(x, 1 / 120);
      expect(output).toEqual(b.step(x, 1 / 120));
      expect(output.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(
        true,
      );
    }
    expect(a.memory).toEqual(b.memory);
    expect(genes).toEqual(original);
  });
  it("실제 센서와 이전 기억이 출력을 바꾸며 잘못된 신경망을 거절한다", () => {
    const genes = randomGenes(new Random(17)),
      a = new NeuralController(genes),
      b = new NeuralController(genes);
    const first = a.step(Array(SENSOR_SIZE).fill(0), 1 / 120);
    expect(first).not.toEqual(b.step(Array(SENSOR_SIZE).fill(1), 1 / 120));
    expect(a.step(Array(SENSOR_SIZE).fill(0), 1 / 120)).not.toEqual(first);
    expect(() => new NeuralController([0])).toThrow();
    expect(() => a.step([0], 1 / 120)).toThrow();
  });
});

it("센서의 즉시 반응을 느린 순환 기억이 가로막지 않는다", () => {
  const genes = randomGenes(new Random(9)),
    a = new NeuralController(genes),
    b = new NeuralController([...genes]);
  expect(a.step(Array(SENSOR_SIZE).fill(0.5), 1 / 120)).toEqual(
    b.step(Array(SENSOR_SIZE).fill(0.5), 1 / 1000),
  );
  expect(a.memory).not.toEqual(b.memory);
});

it("정지 센서에서도 무작위 정책 토크가 계속 변하고 같은 조건은 재현된다", () => {
  const genes = randomGenes(new Random(2026)),
    a = new NeuralController(genes),
    b = new NeuralController([...genes]);
  const samples: number[][] = [];
  for (let i = 0; i < 1800; i++) {
    const out = a.step(Array(SENSOR_SIZE).fill(0), 1 / 120);
    expect(out).toEqual(b.step(Array(SENSOR_SIZE).fill(0), 1 / 120));
    if (i >= 1200) samples.push(out);
  }
  for (let j = 0; j < 12; j++)
    expect(
      Math.max(...samples.map((x) => x[j])) -
        Math.min(...samples.map((x) => x[j])),
    ).toBeGreaterThan(0.005);
});
it("시간 주파수도 유전자로 바뀌며 토크를 외부에서 덮어쓰지 않는다", () => {
  const genes = neutral();
  genes[SENSOR_SIZE] = 1;
  genes[OUTPUT_OFFSET] = 1;
  genes[FREQUENCY_INDEX] = 1;
  const a = new NeuralController(genes),
    b = new NeuralController([...genes]);
  b.genes[FREQUENCY_INDEX] = 2;
  for (let i = 0; i < 30; i++) {
    a.step(Array(SENSOR_SIZE).fill(0), 1 / 120);
    b.step(Array(SENSOR_SIZE).fill(0), 1 / 120);
  }
  expect(a.step(Array(SENSOR_SIZE).fill(0), 1 / 120)[0]).not.toBeCloseTo(
    b.step(Array(SENSOR_SIZE).fill(0), 1 / 120)[0],
    3,
  );
  expect(() => a.step(Array(SENSOR_SIZE).fill(0), Infinity)).toThrow();
});

describe("초기 균형 편향", () => {
  it("같은 난수 표본에서 출력 편향 12개만 이동하고 난수 소비와 나머지 529개를 보존한다", () => {
    const config = cloneConfig();
    config.controllerModel = "timed-rnn";
    config.initialization = "weak-balance";
    const a = new Random(2026),
      b = new Random(2026);
    const raw = randomGenes(a),
      weak = randomGenes(b, config);
    const offsets = initialBalanceOffsets(config);
    expect(a.state).toBe(b.state);
    const changed = weak.flatMap((v, i) => (v !== raw[i] ? [i] : []));
    expect(changed).toEqual(
      Array.from(
        { length: 12 },
        (_, j) => OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE,
      ),
    );
    weak.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(GENE_RANGES[i][0]);
      expect(v).toBeLessThanOrEqual(GENE_RANGES[i][1]);
    });
    offsets.forEach((v, j) =>
      expect(
        weak[OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE] -
          raw[OUTPUT_OFFSET + j * OUTPUT_STRIDE + HIDDEN_SIZE],
      ).toBeCloseTo(v, 14),
    );
    expect(offsets[0]).toBe(-offsets[3]);
    expect(offsets[1]).toBe(offsets[4]);
    expect(offsets[2]).toBeLessThan(0);
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(0.06);
  });
  it("무작위 모드와 0강도는 원래 유전자·난수 상태와 정확히 같다", () => {
    const config = { ...cloneConfig(), controllerModel: "timed-rnn" as const },
      original = randomGenes(new Random(17));
    config.initialization = "random";
    expect(randomGenes(new Random(17), config)).toEqual(original);
    config.initialization = "weak-balance";
    config.initialBalanceBias = 0;
    expect(randomGenes(new Random(17), config)).toEqual(original);
  });
  it("모터 한계0과 극단 체형에서도 유한하며 초기 출력 이동은 모터 한계15% 이하다", () => {
    const config = cloneConfig();
    config.controllerModel = "timed-rnn";
    config.initialization = "weak-balance";
    config.initialBalanceBias = 1;
    config.robot.torsoMass = 10;
    config.robot.lower = 0.4;
    config.robot.upper = 0.1;
    config.physics.hipTorque = 0;
    config.physics.kneeTorque = 0.01;
    const offsets = initialBalanceOffsets(config);
    expect(offsets.every(Number.isFinite)).toBe(true);
    offsets.forEach((v, j) => {
      if (j % 3 !== 2) expect(v).toBe(0);
      expect(Math.abs(Math.tanh(v))).toBeLessThanOrEqual(0.15);
    });
  });
});
