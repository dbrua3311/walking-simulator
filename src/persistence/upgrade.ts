import { validateCheckpoint } from "./files";
import {
  PROPRIO_GENE_COUNT,
  PERIODIC_CONTROLLER_VERSION,
  PROPRIO_CONTROLLER_VERSION,
} from "../controllers/genome";
import type { Checkpoint, Individual } from "../simulation/types";
// Explicit, neutral representation change at a completed generation boundary.
// No history, fitness, physics frame, parent identity or RNG state is replaced.
export function upgradeCompletedController(
  data: Checkpoint,
  sourceSHA256: string,
): Checkpoint {
  const d = structuredClone(validateCheckpoint(data));
  if (
    d.config.controllerModel !== "local-feedback-rnn" ||
    d.generation < 2 ||
    d.verifiedPolicy !== null ||
    d.controllerTransitions?.length ||
    !/^[a-f0-9]{64}$/.test(sourceSHA256)
  )
    throw new Error("완료된565개 제어기만 명시적으로 확장할 수 있습니다.");
  const extend = (g: number[]) => {
    if (g.length !== PROPRIO_GENE_COUNT)
      throw new Error("확장할 유전자 구조 오류");
    return [...g, ...Array(24).fill(0)];
  };
  const individual = (p: Individual) => {
    p.genes = extend(p.genes);
    if (p.birth) {
      p.birth.parentGenes = extend(p.birth.parentGenes);
      p.birth.recombination?.forEach((r) => (r.genes = extend(r.genes)));
    }
  };
  d.population.forEach(individual);
  d.completedResults.forEach(individual);
  if (d.balanceSearch) d.balanceSearch.base = extend(d.balanceSearch.base);
  for (const report of [d.verification, d.verifiedPolicy])
    if (report) report.genes = extend(report.genes);
  d.appVersion = "0.17.0";
  d.controllerVersion = PERIODIC_CONTROLLER_VERSION;
  d.config.controllerModel = "local-periodic-rnn";
  d.controllerTransitions = [
    {
      effectiveGeneration: d.generation + 1,
      sourceGeneration: d.generation,
      from: PROPRIO_CONTROLLER_VERSION,
      to: PERIODIC_CONTROLLER_VERSION,
      neutralGenes: 24,
      sourceSHA256,
    },
  ];
  return validateCheckpoint(d);
}
