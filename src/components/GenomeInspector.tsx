import {
  sharedGeneNames,
  SHARED_GENE_COUNT,
  DIRECTION_SHARED_GENE_COUNT,
} from "../controllers/shared";
import { useState } from "react";
import { GENE_NAMES, lineage } from "../genetics/evolution";
import type { RobotView } from "../simulation/types";
export function GenomeInspector({ robot }: { robot: RobotView }) {
  const [page, setPage] = useState(0),
    [onlyChanged, setOnlyChanged] = useState(false);
  const indices = robot.genes.flatMap((_, i) =>
      !onlyChanged || robot.birth?.changedGenes.includes(i) ? [i] : [],
    ),
    pages = Math.max(1, Math.ceil(indices.length / 24)),
    current = Math.min(page, pages - 1);
  return (
    <details className="gene-inspector">
      <summary>
        로봇 {String(robot.id).padStart(2, "0")} · 신경망 유전자{" "}
        {robot.genes.length}개 · {lineage(robot)}
      </summary>
      <section className="torque-readout" aria-label="현재 관절 토크">
        <strong>현재 구동 토크 (N·m)</strong>
        <p>매 물리 tick 다시 계산합니다. 종료·일시정지 중에는 값도 멈춥니다.</p>
        {robot.frame.torques ? (
          <div>
            {robot.frame.torques.map((value, i) => (
              <span key={i}>
                관절 {i + 1}: <b>{value.toFixed(3)}</b>
              </span>
            ))}
          </div>
        ) : (
          <p>이 프레임에는 토크 기록이 없습니다.</p>
        )}
      </section>
      <nav>
        <label>
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => {
              setOnlyChanged(e.target.checked);
              setPage(0);
            }}
          />{" "}
          변형된 값만
        </label>
        <button disabled={current === 0} onClick={() => setPage(current - 1)}>
          이전 값
        </button>
        <span>
          {current + 1} / {pages}
        </span>
        <button
          disabled={current === pages - 1}
          onClick={() => setPage(current + 1)}
        >
          다음 값
        </button>
      </nav>
      <div>
        {indices.slice(current * 24, (current + 1) * 24).map((i) => (
          <span
            key={i}
            className={robot.birth?.changedGenes.includes(i) ? "changed" : ""}
          >
            <label>
              {
                ([SHARED_GENE_COUNT, DIRECTION_SHARED_GENE_COUNT].includes(
                  robot.genes.length,
                )
                  ? sharedGeneNames(robot.genes.length)
                  : GENE_NAMES)[i]
              }
            </label>
            <b>{robot.genes[i].toFixed(5)}</b>
            <small>
              {robot.birth
                ? `Δ ${(robot.genes[i] - robot.birth.parentGenes[i]).toFixed(5)}`
                : "무작위 초기값"}
            </small>
          </span>
        ))}
      </div>
      {!indices.length && <p>변형된 유전자가 없습니다.</p>}
    </details>
  );
}
