import type { Stat, TrainingStage, RewardModel } from "../simulation/types";
export function Chart({
  history,
  rewardModel,
  fitness = false,
  stage = "balance",
}: {
  history: Stat[];
  rewardModel?: RewardModel;
  fitness?: boolean;
  stage?: TrainingStage;
}) {
  const rows = fitness
    ? history.filter(
        (r) =>
          r.stage === stage &&
          (!rewardModel || !r.rewardVersion || r.rewardVersion === rewardModel),
      )
    : history;
  const best = rows.map((r) =>
      fitness ? r.bestFitness * 1000 : r.bestDistanceM,
    ),
    mean = rows.map((r) => (fitness ? r.meanFitness * 1000 : r.meanDistanceM));
  const hi = Math.max(fitness ? 10 : 0.01, ...best, ...mean),
    lo = Math.min(0, ...best, ...mean),
    range = hi - lo || 1;
  const points = (items: number[]) =>
    items
      .map(
        (v, i) =>
          `${32 + (i / Math.max(1, items.length - 1)) * 216},${112 - ((v - lo) / range) * 88}`,
      )
      .join(" ");
  return (
    <div className="chart">
      <svg
        viewBox="0 0 264 142"
        role="img"
        aria-label={
          fitness
            ? "세대별 보행 점수 그래프"
            : "세대별 최고·평균 유효 거리 그래프"
        }
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1="32"
              x2="248"
              y1={112 - f * 88}
              y2={112 - f * 88}
              stroke="var(--line)"
              strokeDasharray="3 4"
            />
            <text x="0" y={116 - f * 88} fill="var(--muted)" fontSize="9">
              {(lo + range * f).toFixed(range < 0.1 ? 3 : 2)}
            </text>
          </g>
        ))}
        {rows.length > 0 && (
          <>
            <polyline
              points={points(mean)}
              fill="none"
              stroke="var(--muted)"
              strokeWidth="2"
            />
            <polyline
              points={points(best)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.5"
            />
            {best.map((v, i) => (
              <circle
                key={i}
                cx={32 + (i / Math.max(1, best.length - 1)) * 216}
                cy={112 - ((v - lo) / range) * 88}
                r={best.length > 100 ? 0 : 2.3}
                fill="var(--accent)"
              />
            ))}
          </>
        )}
        <text x="32" y="133" fontSize="9" fill="var(--muted)">
          {rows[0]?.generation ?? 1}세대
        </text>
        <text x="248" y="133" textAnchor="end" fontSize="9" fill="var(--muted)">
          {rows.at(-1)?.generation ?? 1}세대
        </text>
      </svg>
      {!rows.length && (
        <span className="chart-empty">이 단계의 세대가 끝나면 기록됩니다</span>
      )}
      <div className="chart-legend">
        <span>
          <i />
          최고 {fitness ? "보행 점수" : "거리 (m)"}
        </span>
        <span>
          <i />
          평균
        </span>
      </div>
    </div>
  );
}
