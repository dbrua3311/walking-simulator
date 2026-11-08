import { SHARED_MODE_NAMES } from "../genetics/sharedSearch";
import { useCovariance } from "../genetics/balanceSearch";
import { isPracticeReward } from "../physics/assessment";
import type { Snapshot } from "../simulation/types";
import {
  STAGES,
  STAGE_NAMES,
  stageTarget,
  distinctFeet,
} from "../simulation/curriculum";
import { BACKWARD_PENALTY_PER_M } from "../physics/assessment";
import { rank } from "../genetics/evolution";
export function TrainingPanel({ snapshot: s }: { snapshot: Snapshot }) {
  const c = s.curriculum,
    config = s.config,
    current = STAGES.indexOf(c.stage),
    best = rank(s.robots)[0],
    report = s.verification,
    distribution = useCovariance(config, c.stage),
    plan = distribution ? null : s.searchPlan,
    mutationCounts = {
      small: 0,
      medium: 0,
      large: 0,
      immigrant: 0,
      preserved: 0,
      anchor: 0,
      distribution: 0,
    };
  for (const r of s.robots) {
    if (
      r.birth?.mutationScope === "balance-covariance" ||
      r.birth?.mutationScope === "shared-covariance"
    )
      mutationCounts.distribution++;
    else if (r.birth?.kind === "stage-anchor") mutationCounts.anchor++;
    else if (r.immigrant) mutationCounts.immigrant++;
    else if (r.birth?.kind === "explorer") mutationCounts.preserved++;
    else if (r.birth && !r.champion)
      mutationCounts[r.birth.mutationProfile?.kind ?? "small"]++;
  }
  const labels = {
    support: "지지 시간",
    steps: "발 옮김",
    forward: "전진",
    continuity: "안정 연속 보행",
    penalty: "감점",
  } as const;
  return (
    <section className="training-panel" aria-label="단계별 보행 학습">
      {config.rewardModel !== "mobile-curriculum-v8" && (
        <p className="training-hint">
          이전 학습 기준을 유지한 실험입니다. 새 실험 적용 시 관절 가동 여유와
          반복 발 재착지를 평가합니다.
        </p>
      )}
      {config.curriculum.maxWalkingFlightTime >=
        config.evaluation.maxAirTime && (
        <p className="training-hint">
          이전 체공 기준을 유지합니다. 새 실험 적용 시 네 발 동시 체공을 0.02초
          이하로 제한해 발 지지가 이어지는 보행을 평가합니다.
        </p>
      )}
      <p className="training-progress">
        {config.evaluation.contactModel === "load-bearing"
          ? "몸을 받치는 발의 하중으로 지지와 미끄러짐을 평가합니다."
          : "이전 발 근접 접촉 기준을 유지합니다. 새 실험 적용 시 실제 하중으로 평가합니다."}
      </p>
      {s.controllerTransitions?.map((t) => (
        <p className="training-hint" key={t.effectiveGeneration}>
          {t.sourceGeneration}세대 완료 상태에서 제어기를 확장했습니다.{" "}
          {t.effectiveGeneration}세대부터 새 연결을 탐색하며 이전 이력을
          유지합니다.
        </p>
      ))}
      <ol className="training-stages">
        {STAGES.map((stage, i) => (
          <li
            key={stage}
            className={
              i === current ? "current" : i < current ? "complete" : ""
            }
            aria-current={i === current ? "step" : undefined}
          >
            <span>{i < current ? "✓" : i + 1}</span>
            <strong>{STAGE_NAMES[stage]}</strong>
          </li>
        ))}
      </ol>
      <div className="training-target" data-stage={c.stage}>
        <strong>{STAGE_NAMES[c.stage]} 목표</strong>
        <span>{stageTarget(c.stage, config)}</span>
      </div>
      {config.rewardModel === "mobile-curriculum-v8" && (
        <p className="training-progress" aria-label="관절 가동 여유">
          가동 여유를 유지한 지지 최고{" "}
          {Math.max(
            ...s.robots.map((r) => r.frame.gait.longestMobileSupport ?? 0),
          ).toFixed(2)}
          초 · 관절 끝을 계속 미는 토크 감점
        </p>
      )}
      {c.stage === "stepping" && config.curriculum.coordinatedPromotion && (
        <p className="training-hint">
          네 발을 반복해 옮기고 평가가 끝날 때까지 유지한 뒤 전진 단계로
          넘어갑니다. 짧은 세 발 동작으로 승급하지 않습니다.
        </p>
      )}
      {c.stage === "stepping" && (
        <p className="training-progress">
          필수 지지 시간: 합계 {config.curriculum.balanceSeconds}초 이상 ·
          {config.rewardModel !== "temporal-curriculum-v4"
            ? `평가 ${config.duration}초 동안 지지를 계속 보상 · 발 보상은 지지 지속 비율로 반영`
            : `지지 보상은 ${config.curriculum.balanceSeconds}초에서 포화 (이전 기준)`}
        </p>
      )}
      {c.stage === "stepping" &&
        ["rhythmic-curriculum-v7", "mobile-curriculum-v8"].includes(
          config.rewardModel,
        ) && (
          <p className="training-progress">
            각 발의 최근 걸음이 이어질수록 가점합니다. 처음 두 걸음 뒤 멈추면
            반복 보상이 줄어듭니다.
          </p>
        )}
      {config.curriculum.useDriftLimits && (
        <p className="training-progress">
          최종 경로 이탈 {config.curriculum.maxLateralDeviation}m·방향 이탈{" "}
          {config.curriculum.maxHeadingDeviation}rad 이내 · 체중 이동의 왕복
          누적과 구분
        </p>
      )}
      <p className="training-progress">
        안정 지지 최고{" "}
        {Math.max(...s.robots.map((r) => r.frame.gait.longestSupport)).toFixed(
          2,
        )}
        초 · 발 사용 {Math.max(...s.robots.map(distinctFeet))}/4 · 유효 보행
        최고{" "}
        {Math.max(...s.robots.map((r) => r.frame.gait.walkingTime)).toFixed(2)}
        초
      </p>
      {c.stage === "stepping" && isPracticeReward(config.rewardModel) && (
        <p className="training-progress" aria-label="발 재착지 연습">
          작은 발 이동을 마친 발{" "}
          {Math.max(
            ...s.robots.map(
              (r) =>
                (r.frame.gait.footProgress ?? []).filter((p) => p > 0).length,
            ),
          )}
          /4 · 체중 이동과 앞으로 옮겨 디딘 뒤 0.15초 안정 지지 시 보조 점수 ·
          실제 걸음과 별도
        </p>
      )}
      {c.stage !== "forward" && (
        <p className="promotion-status">
          {c.pendingStage
            ? `다음 세대부터 ${STAGE_NAMES[c.pendingStage]} 단계로 전환합니다.`
            : `승급 조건 연속 달성 ${c.streak}/${config.curriculum.promotionGenerations}세대 · 완료 세대에서 판정`}
        </p>
      )}
      {config.duration < config.curriculum.forwardSeconds && (
        <p className="training-hint">
          최종 보행 검증에는 평가 시간을 {config.curriculum.forwardSeconds}초
          이상으로 설정하세요.
        </p>
      )}
      <div
        className="search-status"
        aria-label="변이 탐색 현황"
        data-mode={plan?.mode ?? "evaluating"}
      >
        <strong>현재 세대 탐색 구성</strong>
        {s.generation === 1 && <p>초기 무작위 {s.robots.length}대</p>}
        {s.generation > 1 && (
          <p>우승 그대로 보존 {s.robots.filter((r) => r.champion).length}대</p>
        )}
        {s.sharedSearchInfo && (
          <p aria-label="공통 보행 탐색">
            탐색 초점: {SHARED_MODE_NAMES[s.sharedSearchInfo.mode]}. 우승은 보행
            점수로 보존하고, 부모는 현재 연습 목표로 선발합니다. 학습한 네 발
            움직임을 유지하며 직진을 다듬습니다. 수동 결정은 선택한 부모의
            교차·변이를 사용합니다.
          </p>
        )}
        {distribution && (
          <p>
            자동 균형 학습: 우승 1대 보존 · 36개 연결의 분포에서{" "}
            {config.population - 1}대 탐색 · 새 평가 부모를 가중 재조합합니다.
            변이율·폭은 탐색 강도에 반영합니다. 수동 결정은 선택한 부모의 개별
            변이를 사용합니다.
          </p>
        )}
        {mutationCounts.distribution > 0 && (
          <p>분포 변이·재조합 {mutationCounts.distribution}대</p>
        )}
        {mutationCounts.distribution === 0 && (
          <p>
            작은 변이 {mutationCounts.small}대 · 중간 변이{" "}
            {mutationCounts.medium}대 · 큰 변이 {mutationCounts.large}대 · 새
            무작위 {mutationCounts.immigrant}대
          </p>
        )}
        {mutationCounts.anchor > 0 && (
          <p>균형 계보 그대로 보존 {mutationCounts.anchor}대</p>
        )}
        {mutationCounts.preserved > 0 && (
          <p>새 발 탐색 계보 그대로 보존 {mutationCounts.preserved}대</p>
        )}
        {plan && (
          <>
            <strong>
              다음 세대:{" "}
              {plan.mode === "stagnant"
                ? "정체로 탐색 확대"
                : plan.mode === "recovery"
                  ? "넘어짐 반복으로 탐색 확대"
                  : "기본 탐색"}
            </strong>
            <p>
              우승 1대 보존 · 작은 {plan.counts.small} · 중간{" "}
              {plan.counts.medium} · 큰 {plan.counts.large} · 새 무작위{" "}
              {plan.counts.immigrant}
              {(plan.anchorCount ?? 0) > 0 &&
                ` · 균형 계보 보존 ${plan.anchorCount}`}
              {plan.counts.preserved > 0 &&
                ` · 새 발 계보 보존 ${plan.counts.preserved}`}
            </p>
            <small>
              변형 폭 최대: 작은 {(plan.profiles.small.scale * 100).toFixed(2)}%
              · 중간 {(plan.profiles.medium.scale * 100).toFixed(2)}% · 큰{" "}
              {(plan.profiles.large.scale * 100).toFixed(2)}% (유전자 허용 범위
              대비)
            </small>
          </>
        )}
        {config.searchMethod === "covariance" && !distribution && (
          <small>
            공분산 탐색은 관절 감각 연결·균형 단계·자동 탐색
            켜짐·교차율0%·변이율0~100% 사이에서 적용합니다. 현재는 개별
            교차·변이를 사용합니다.
          </small>
        )}
        {!config.adaptiveSearch && <small>자동 탐색 확대 꺼짐</small>}
        {config.mutation === 0 && (
          <small>변이율 0%: 자동 확대와 새 무작위 투입도 하지 않습니다.</small>
        )}
      </div>
      <details className="score-details">
        <summary>
          현재 선두 로봇 {best.id} 점수 내역 ·{" "}
          {(best.fitness * 1000).toFixed(1)}점
        </summary>
        <div className="score-breakdown">
          {Object.entries(labels).map(([key, label]) => (
            <div key={key}>
              <span>{label}</span>
              <b>
                {key === "penalty" ? "−" : "+"}
                {(best.score[key as keyof typeof labels] * 1000).toFixed(1)}
              </b>
            </div>
          ))}
        </div>
        <small>
          균형 단계는 접지 지지 시간과 자세 품질에 비례해 가점합니다. 공중
          시간은 포함하지 않습니다. 다음 단계에서는 발 옮김·안정적인 전진 비중이
          커집니다. 후진은 누적 1m당 {BACKWARD_PENALTY_PER_M * 1000}
          점을 감점하며 다시 전진해도 취소되지 않습니다. 넘어짐·체공·수직 충격도
          감점합니다. 표시 점수는 내부 점수의 1,000배입니다.
        </small>
      </details>
      {report && (
        <div
          className={"verification-card " + report.status}
          aria-label="보행 재검증"
        >
          <strong>
            {report.status === "running"
              ? "초기 자세 3조건 재검증 중"
              : report.status === "passed"
                ? "3조건 보행 검증 통과"
                : "보행 재검증 실패 · 다음 후보 탐색"}
          </strong>
          <small>
            {report.generation}세대 로봇 {report.robotId} · 초기 기울기를 바꾸고
            같은 신경망을 다시 평가합니다.
          </small>
          <ul>
            {report.trials.map((t) => (
              <li key={t.label}>
                <span>{t.label}</span>
                <b>
                  {t.status === "passed"
                    ? "통과"
                    : t.status === "failed"
                      ? "미달"
                      : "평가 중"}
                </b>
                <small>
                  {t.walkingTime.toFixed(1)}초 보행 · {t.distance.toFixed(2)}m
                  {t.longestWalking !== undefined &&
                    ` · 연속 ${t.longestWalking.toFixed(1)}초`}
                  {t.lateralDeviation !== undefined &&
                    ` · 경로 이탈 ${t.lateralDeviation.toFixed(2)}m`}
                </small>
              </li>
            ))}
          </ul>
          {report.status === "passed" && (
            <p>
              검증된 유전자를 보존했습니다. 자동 학습을 멈췄으며 JSON으로 저장할
              수 있습니다.
            </p>
          )}
        </div>
      )}
      {s.verifiedPolicy && report?.status !== "passed" && (
        <p className="verified-memory">
          검증 우승: {s.verifiedPolicy.generation}세대 로봇{" "}
          {s.verifiedPolicy.robotId} · 유전자와 3조건 결과를 저장에 보존합니다.
        </p>
      )}
    </section>
  );
}
