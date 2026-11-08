import { sharedRanges, wrapPhase } from "../controllers/shared";
import { assemblyAngle } from "../controllers/genome";
import type { Random } from "./evolution";
import type { Config, Individual, RobotView } from "../simulation/types";
const reflect = (x: number, lo: number, hi: number) => {
  const width = hi - lo,
    t = (((x - lo) % (2 * width)) + 2 * width) % (2 * width);
  return lo + (t <= width ? t : 2 * width - t);
};
// Manual selection, crossover and explicit 0/100% retain their ordinary meaning.
export function breedShared(
  ordered: RobotView[],
  selected: number[],
  config: Config,
  rng: Random,
  generation: number,
): Individual[] {
  const pool = ordered.filter((r) => selected.includes(r.id));
  if (!pool.length) throw new Error("부모를 한 개체 이상 선택하세요.");
  const best = ordered[0],
    children: Individual[] = config.preserveChampion
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
      : [];
  const eliteCount = children.length;
  while (children.length < config.population) {
    const parent = pool[(children.length - eliteCount) % pool.length],
      genes = [...parent.genes],
      ranges = sharedRanges(parent.genes.length);
    let other: RobotView | undefined;
    if (pool.length > 1 && rng.next() < config.crossover) {
      other = rng.pick(pool.filter((p) => p.id !== parent.id));
      for (let j = 0; j < 3; j++)
        if (rng.next() < 0.5) {
          for (let k = 0; k < 9; k++) genes[j * 9 + k] = other.genes[j * 9 + k];
          genes[32 + j] = other.genes[32 + j];
          genes[35 + j] = other.genes[35 + j];
          if (genes.length === 44) {
            genes[38 + j] = other.genes[38 + j];
            genes[41 + j] = other.genes[41 + j];
          }
        }
      for (let i = 27; i <= 31; i++)
        if (rng.next() < 0.5) genes[i] = other.genes[i];
    }
    const before = [...genes],
      change = (i: number) => {
        const [lo, hi] = ranges[i],
          delta = (2 * rng.next() - 1) * (hi - lo) * config.mutationScale;
        genes[i] =
          i >= 27 && i < 31
            ? wrapPhase(genes[i] + delta)
            : reflect(genes[i] + delta, lo, hi);
      };
    if (config.mutation > 0) {
      for (let i = 0; i < genes.length; i++)
        if (config.mutation === 1 || rng.next() < config.mutation) change(i);
      if (genes.every((v, i) => v === before[i]))
        change(Math.floor(rng.next() * genes.length));
      if (config.adaptiveSearch && config.mutation < 1)
        for (let j = 0; j < 3; j++)
          genes[j * 9] = reflect(
            genes[j * 9] -
              (genes[j * 9 + 1] - before[j * 9 + 1]) * assemblyAngle(j),
            -2,
            2,
          );
    }
    const changed = genes.flatMap((v, i) => (v !== parent.genes[i] ? [i] : []));
    children.push({
      id: children.length + 1,
      genes,
      champion: false,
      parents: other ? [parent.id, other.id] : [parent.id],
      birth: {
        generation,
        kind: other ? "crossover" : changed.length ? "mutation" : "copy",
        parentGenes: [...parent.genes],
        changedGenes: changed,
        mutationScope: "network",
      },
    });
  }
  return children;
}
