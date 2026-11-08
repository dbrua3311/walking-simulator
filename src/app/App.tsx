import { isSharedModel } from "../controllers/shared";
import { useEffect, useRef, useState } from "react";
import {
  Footprints,
  Play,
  Pause,
  FastForward,
  Download,
  Upload,
  RotateCcw,
  ChevronRight,
  Check,
  MousePointer2,
  Activity,
  Trophy,
  Ghost as GhostIcon,
  Settings2,
  ArrowUpRight,
  X,
} from "lucide-react";
import { cloneConfig, configSchema } from "../simulation/config";
import { lineage, rank } from "../genetics/evolution";
import { csv, parseCheckpoint, saveFile } from "../persistence/files";
import { Scene } from "../visualization/Scene";
import { TrainingPanel } from "../components/TrainingPanel";
import { STAGE_NAMES } from "../simulation/curriculum";
import { Chart } from "../components/Chart";
import type { Command, Config, Response, Snapshot } from "../simulation/types";
const phaseName = {
  ready: "출발 준비",
  running: "평가 진행 중",
  validating: "보행 재검증 중",
  paused: "일시정지",
  selection: "부모 선택",
  error: "오류",
};
const outcomeName: Record<string, string> = {
  active: "평가 중",
  fallen: "넘어짐",
  stalled: "정체",
  timeout: "시간 종료",
  success: "보행 후보",
  invalid: "계산 오류",
  jumped: "점프 종료",
};
export default function App() {
  const [draft, setDraft] = useState<Config>(cloneConfig),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [speed, setSpeed] = useState(1),
    [ghostMode, setGhostMode] = useState("best"),
    [zoom, setZoom] = useState(1),
    [fitnessChart, setFitnessChart] = useState(true),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [stopping, setStopping] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const worker = useRef<Worker | null>(null),
    upload = useRef<HTMLInputElement>(null),
    lastPhase = useRef(""),
    picker = useRef<((text: string) => Promise<void>) | null>(null);
  const send = (command: Command) => worker.current?.postMessage(command);
  const message = (text: string) => {
    setNotice(text);
    setError("");
  };
  const reportError = (e: unknown) => {
    if (e instanceof DOMException && e.name === "AbortError") return;
    setError(e instanceof Error ? e.message : String(e));
  };
  useEffect(() => {
    const w = new Worker(
      new URL("../workers/simulation.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = w;
    w.onmessage = (event: MessageEvent<Response>) => {
      const m = event.data;
      if (m.type === "snapshot") {
        setSnapshot(m.data);
        if (m.data.phase !== "running" && m.data.phase !== "validating")
          setStopping(false);
        if (
          m.data.phase === "selection" &&
          lastPhase.current !== "selection" &&
          !m.data.auto
        )
          setNotice(
            m.data.verification?.status === "passed" &&
              m.data.verification.generation === m.data.generation
              ? "3조건 보행 검증을 통과해 자동 학습을 멈췄습니다. JSON으로 검증된 유전자를 저장하세요."
              : "평가 완료. 화면의 로봇을 클릭·드래그하거나 순위표에서 부모를 선택하세요.",
          );
        lastPhase.current = m.data.phase;
      }
      if (m.type === "error") {
        setError(m.message);
        setStopping(false);
      }
      if (m.type === "saved") {
        const text = JSON.stringify(m.data, null, 2);
        if (picker.current) {
          const write = picker.current;
          picker.current = null;
          void write(text)
            .then(() => message("실험을 저장했습니다."))
            .catch(reportError);
        } else
          void saveFile(
            `walking-generation-${m.data.generation}.json`,
            text,
            "application/json",
          )
            .then(() =>
              message("저장 파일을 내보냈습니다. USB 저장 위치를 확인하세요."),
            )
            .catch(reportError);
      }
    };
    w.onerror = (event) =>
      setError(event.message || "시뮬레이션 Worker를 시작하지 못했습니다.");
    w.postMessage({ type: "init", config: cloneConfig() } satisfies Command);
    return () => {
      w.terminate();
      worker.current = null;
    };
  }, []);
  useEffect(() => {
    if (configSchema.safeParse(draft).success)
      send({
        type: "settings",
        settings: {
          population: draft.population,
          mutation: draft.mutation,
          mutationScale: draft.mutationScale,
          adaptiveSearch: draft.adaptiveSearch,
          crossover: draft.crossover,
          parentCount: draft.parentCount,
        },
      });
  }, [
    draft.population,
    draft.mutation,
    draft.mutationScale,
    draft.adaptiveSearch,
    draft.crossover,
    draft.parentCount,
  ]);
  function fresh() {
    try {
      const defaults = cloneConfig();
      const config = configSchema.parse({
        ...draft,
        rewardModel: defaults.rewardModel,
        evaluation: {
          ...draft.evaluation,
          contactModel: defaults.evaluation.contactModel,
          walkingContinuityGrace: defaults.evaluation.walkingContinuityGrace,
        },
        curriculum: defaults.curriculum,
      });
      if (
        snapshot &&
        snapshot.tick > 0 &&
        !window.confirm(
          "현재 실험 대신 새 실험을 시작할까요? 저장하지 않은 기록은 사라집니다.",
        )
      )
        return;
      send({ type: "init", config });
      setDraft(config);
      message("새 실험을 준비했습니다. 모든 개체는 같은 조건에서 출발합니다.");
    } catch {
      setError("설정값의 범위와 실험 이름을 확인하세요.");
    }
  }
  async function save() {
    if (!snapshot) return;
    try {
      const browser = window as unknown as {
        showSaveFilePicker?: (o: unknown) => Promise<{
          createWritable: () => Promise<{
            write: (v: Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      };
      if (browser.showSaveFilePicker) {
        const handle = await browser.showSaveFilePicker({
          suggestedName: `walking-generation-${snapshot.generation}.json`,
          types: [
            {
              description: "실험 JSON",
              accept: { "application/json": [".json"] },
            },
          ],
        });
        picker.current = async (text) => {
          const stream = await handle.createWritable();
          await stream.write(new Blob([text], { type: "application/json" }));
          await stream.close();
        };
      }
      send({ type: "save" });
      message(
        snapshot.phase === "selection"
          ? "실험을 저장합니다."
          : "세대 종료 후 저장을 예약했습니다. 일시정지 중이면 실행을 재개하세요.",
      );
    } catch (e) {
      reportError(e);
    }
  }
  async function load(file: File) {
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("저장 파일은 32MB 이하여야 합니다.");
      const data = parseCheckpoint(await file.text());
      send({ type: "load", data });
      setDraft({ ...data.config, ...(data.pendingSettings ?? {}) });
      message(
        "저장한 완료 세대를 복원했습니다. 부모를 확정하거나 자동 학습으로 이어가세요.",
      );
    } catch (e) {
      reportError(e);
    }
  }
  const update = (key: keyof Config, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const ordered = snapshot ? rank(snapshot.robots) : [],
    best = ordered[0],
    selection = snapshot?.phase === "selection",
    running = snapshot?.phase === "running" || snapshot?.phase === "validating";
  const ghost = snapshot
    ? ghostMode === "best"
      ? snapshot.allTimeBest
      : ghostMode === "previous"
        ? snapshot.previousBest
        : null
    : null;
  const selected = snapshot?.selected ?? [];
  const choose = (id: number) =>
    send({
      type: "select",
      ids: selected.includes(id)
        ? selected.filter((n) => n !== id)
        : [...selected, id],
    });
  const field = (
    label: string,
    key: "population" | "duration" | "target" | "seed" | "parentCount",
    min: number,
    max: number,
    step = 1,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        onChange={(e) => update(key, Number(e.target.value))}
      />
    </label>
  );
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">
            <Footprints size={24} />
          </span>
          <span>
            Walking Simulator<small>진화하는 보행 실험실</small>
          </span>
        </a>
        <div className="top-meta">
          <span className="version">사족보행 실험 / 01</span>
          <span className="local-badge">
            <i /> 로컬 시뮬레이션
          </span>
        </div>
        <a
          className="github-link"
          href="https://github.com/dbrua3311/walking-simulator"
          target="_blank"
          rel="noreferrer"
        >
          프로젝트 <ArrowUpRight size={14} />
        </a>
      </header>
      <main className="workspace">
        <aside className="controls panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <h2>실험 설정</h2>
            <span>01</span>
          </div>
          <label className="field name-field">
            <span>실험 이름</span>
            <input
              aria-label="실험 이름"
              value={draft.name}
              maxLength={80}
              onChange={(e) => update("name", e.target.value)}
            />
          </label>
          <div className="field-grid">
            {field("개체 수", "population", 2, 60)}
            {field("평가 시간 (s)", "duration", 1, 60)}
            {field("목표 거리 (m)", "target", 0.1, 100, 0.1)}
            {field("난수 시드", "seed", 0, 4294967295)}
          </div>
          <div className="divider" />
          <div className="controller-note">
            <strong>보행 규칙 없이 시작</strong>
            <span>무작위 시간 신호 + 센서 → 12관절 직접 토크</span>
            <small>
              주파수·연결 가중치를 진화시키며 토크를 계속 계산합니다. 관절 감각
              연결의 부호와 크기도 무작위로 시작해 학습합니다.
            </small>
          </div>
          <label className="field">
            <span>신경망 구조</span>
            <select
              aria-label="신경망 구조"
              value={draft.controllerModel}
              onChange={(e) => {
                const model = e.target.value as Config["controllerModel"];
                setDraft((current) => ({
                  ...current,
                  controllerModel: model,
                  ...(isSharedModel(model) ? { parentCount: 3 } : {}),
                }));
              }}
            >
              <option value="shared-anatomical">
                좌우 균형 + 방향 감각 (44개·실험)
              </option>
              <option value="shared-direction">
                방향 감각 + 공통 다리 규칙 (44개·실험)
              </option>
              <option value="shared-reflex">
                공통 다리 규칙 + 자유 시간차 (38개·실험)
              </option>
              <option value="local-periodic-rnn">
                관절 감각 + 주기 토크 직접 연결 (589개)
              </option>
              <option value="local-feedback-rnn">
                관절 감각 직접 연결 + 순환망 (565개)
              </option>
              <option value="timed-rnn">기존 순환망 (541개)</option>
            </select>
          </label>
          {isSharedModel(draft.controllerModel) && (
            <p className="helper">
              {draft.controllerModel === "shared-anatomical" &&
                "좌우 다리의 안팎 움직임을 같은 기준으로 학습합니다. "}
              다리마다 자신의 관절 감각과 자유 시간차로 12모터를 따로
              구동합니다. 공통 규칙도 무작위에서 학습합니다. 네 발 지속 전진의
              최종 검증은 아직 진행 중입니다.
            </p>
          )}
          <label className="field">
            <span>자동 균형 탐색</span>
            <select
              aria-label="자동 균형 탐색"
              value={draft.searchMethod}
              onChange={(e) =>
                update("searchMethod", e.target.value as Config["searchMethod"])
              }
            >
              <option value="covariance">부모 재조합 + 공분산 변이</option>
              <option value="adaptive">개별 교차·변이</option>
            </select>
          </label>
          <label className="field">
            <span>초기 학습 방식</span>
            <select
              aria-label="초기 학습 방식"
              value={draft.initialization}
              onChange={(e) =>
                update(
                  "initialization",
                  e.target.value as Config["initialization"],
                )
              }
            >
              <option value="weak-balance">
                약한 균형 편향 + 무작위 (실험)
              </option>
              <option value="random">완전 무작위</option>
            </select>
          </label>
          {draft.initialization === "weak-balance" && (
            <label className="slider-field">
              <span>
                초기 균형 편향{" "}
                <b>{Math.round(draft.initialBalanceBias * 100)}%</b>
              </span>
              <input
                aria-label="초기 균형 편향"
                type="range"
                min="0"
                max="1"
                step=".05"
                value={draft.initialBalanceBias}
                onChange={(e) =>
                  update("initialBalanceBias", Number(e.target.value))
                }
              />
            </label>
          )}
          <p className="field-note">
            새 실험과 새 무작위 개체의 초기 토크 가중치에만 적용합니다. 정지
            하중을 버티는 방향으로 조금 기울이며 걷는 순서는 정하지 않습니다.
            50세대 비교에서 보행 속도 개선은 확인되지 않았습니다.
          </p>
          <h3>진화 파라미터</h3>
          <label className="slider-field">
            <span>
              돌연변이율 <b>{Math.round(draft.mutation * 100)}%</b>
            </span>
            <input
              aria-label="돌연변이율"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={draft.mutation}
              onChange={(e) => update("mutation", Number(e.target.value))}
            />
          </label>
          <label className="slider-field">
            <span>
              변형 크기 <b>최대 {Math.round(draft.mutationScale * 100)}%</b>
            </span>
            <input
              aria-label="변형 크기"
              type="range"
              min=".01"
              max=".2"
              step=".01"
              value={draft.mutationScale}
              onChange={(e) => update("mutationScale", Number(e.target.value))}
            />
          </label>
          <p className="field-note">
            유전자 허용 범위 대비 변형 폭입니다. 변이율이 0보다 크면 자식마다
            최소 1개를 변형합니다. 자동 탐색 확대가 켜지면 일부 자식은 더 큰
            변형 폭과 변이율을 사용합니다.
          </p>
          <label className="adaptive-search-toggle">
            <input
              type="checkbox"
              checked={draft.adaptiveSearch}
              onChange={(e) => update("adaptiveSearch", e.target.checked)}
            />
            자동 탐색 확대
          </label>
          <p className="field-note">
            넘어짐 반복·성과 정체 시 일부 자식에 큰 변이와 새 무작위 개체를
            섞습니다. 개체 수는 40·60으로 늘릴 수 있으며 계산량도 늘어납니다.
          </p>
          <label className="slider-field">
            <span>
              교차율 <b>{Math.round(draft.crossover * 100)}%</b>
            </span>
            <input
              aria-label="교차율"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={draft.crossover}
              onChange={(e) => update("crossover", Number(e.target.value))}
            />
          </label>
          {field("자동 선택 부모 수", "parentCount", 1, 60)}
          <button
            className="text-button advanced-toggle"
            onClick={() => setAdvanced(!advanced)}
          >
            <Settings2 size={13} />
            물리 환경 설정{" "}
            <ChevronRight size={13} className={advanced ? "rotate" : ""} />
          </button>
          {advanced && (
            <div className="advanced">
              {(
                [
                  ["gravity", "중력 (m/s²)", -20, -1],
                  ["friction", "마찰계수", 0, 2],
                  ["jointDamping", "관절 점성 감쇠 (N·m·s/rad)", 0, 5],
                  ["hipTorque", "엉덩이 토크 (N·m)", 0, 50],
                  ["kneeTorque", "무릎 토크 (N·m)", 0, 50],
                ] as const
              ).map(([key, label, min, max]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    type="number"
                    min={min}
                    max={max}
                    step="0.1"
                    value={draft.physics[key]}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        physics: {
                          ...d.physics,
                          [key]: Number(e.target.value),
                        },
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <p className="field-note">
            환경·평가 설정은 새 실험에 적용됩니다.
            <br />
            진화 설정은 다음 세대부터 적용됩니다.
          </p>
          <button className="button outline full" onClick={fresh}>
            <RotateCcw size={14} />새 실험 적용
          </button>
          <div className="divider" />
          <div className="control-label">
            <h3>시뮬레이션 제어</h3>
            <span className="mono">×{speed}</span>
          </div>
          <div className="speed-options" aria-label="학습 배속">
            {[1, 8, 32, 128, 256].map((n) => (
              <button
                key={n}
                className={speed === n ? "active" : ""}
                onClick={() => {
                  setSpeed(n);
                  send({ type: "speed", value: n });
                }}
              >
                ×{n}
              </button>
            ))}
          </div>
          <div className="button-row">
            <button
              className="button outline"
              disabled={!snapshot || selection}
              onClick={() =>
                send({
                  type: running ? "pause" : "start",
                  ...(!running ? { auto: false } : {}),
                } as Command)
              }
            >
              {running ? <Pause size={15} /> : <Play size={15} />}{" "}
              {running ? "일시정지" : "실행 / 재개"}
            </button>
          </div>
          <button
            className={"button full " + (snapshot?.auto ? "stop" : "primary")}
            disabled={!snapshot || stopping}
            onClick={() => {
              if (snapshot?.auto) {
                setStopping(true);
                send({ type: "pause" });
              } else {
                send({ type: "start", auto: true });
                message("실제 물리 계산으로 자동 학습을 시작했습니다.");
              }
            }}
          >
            {snapshot?.auto ? <Pause size={15} /> : <FastForward size={16} />}{" "}
            {stopping
              ? "정지 중…"
              : snapshot?.auto
                ? "자동 학습 정지"
                : "자동 학습 시작"}
          </button>
          <p className="field-note">
            정지해도 현재 자세와 학습 기록을 유지합니다.
          </p>
          <div className="divider" />
          <h3>실험 파일</h3>
          <div className="file-actions">
            <button
              className="button small outline"
              disabled={!snapshot || snapshot.savePending}
              onClick={() => void save()}
            >
              <Download size={13} />
              {snapshot?.savePending ? "저장 예약됨" : "JSON 저장"}
            </button>
            <button
              className="button small outline"
              onClick={() => upload.current?.click()}
            >
              <Upload size={13} />
              불러오기
            </button>
          </div>
          <button
            className="text-button csv-button"
            disabled={!snapshot?.history.length}
            onClick={() =>
              void saveFile(
                "walking-statistics.csv",
                csv(snapshot!.history, snapshot!.config.rewardModel),
                "text/csv",
              )
                .then(() =>
                  message("CSV를 내보냈습니다. USB 저장 위치를 확인하세요."),
                )
                .catch(reportError)
            }
          >
            세대별 기록 CSV 내보내기 <ArrowUpRight size={12} />
          </button>
          <input
            ref={upload}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void load(file);
              e.target.value = "";
            }}
          />
          <div className="storage-note">
            파일 저장 위치는 USB를 선택해주세요.
          </div>
        </aside>
        <section className="simulation-column">
          <div className="page-heading">
            <div>
              <div className="eyebrow">움직임으로 배우는 진화</div>
              <h1>한 걸음씩, 더 멀리.</h1>
              <p>
                {snapshot?.robots.length ?? 20}대를 함께 평가하고, 잘 디디며
                전진한 부모를 골라 조금씩 바꿉니다.
              </p>
            </div>
            <span className={"status-pill " + (running ? "live" : "")}>
              <i />
              {snapshot ? phaseName[snapshot.phase] : "물리 엔진 준비 중"}
            </span>
          </div>
          <div className="metric-grid">
            <div className="metric">
              <span>현재 세대</span>
              <strong>
                {String(snapshot?.generation ?? 1).padStart(2, "0")}
                <small>세대</small>
              </strong>
              <div>
                평가 {((snapshot?.tick ?? 0) / 120).toFixed(1)} /{" "}
                {snapshot?.config.duration ?? 15}s
              </div>
            </div>
            <div className="metric">
              <span>최고 보행 점수</span>
              <strong>
                {((best?.fitness ?? 0) * 1000).toFixed(1)}
                <small>점</small>
              </strong>
              <div>
                {best
                  ? "로봇 " + String(best.id).padStart(2, "0")
                  : "동일한 출발 조건"}
              </div>
            </div>
            <div className="metric">
              <span>역대 최고 보행 거리</span>
              <strong>
                {(snapshot?.allTimeBest?.distance ?? 0).toFixed(3)}
                <small>m</small>
              </strong>
              <div>
                {snapshot?.allTimeBest
                  ? snapshot.allTimeBest.generation + "세대의 기록"
                  : "첫 기록을 기다리는 중"}
              </div>
            </div>
          </div>
          {snapshot && <TrainingPanel snapshot={snapshot} />}
          <div className="evolution-flow" aria-label="유전 학습 과정">
            <span className={running || !selection ? "current" : ""}>
              ① {snapshot?.robots.length ?? 20}대 동시 평가
            </span>
            <ChevronRight size={13} />
            <span className={selection ? "current" : ""}>
              ② 잘 디디며 전진한 부모 선택
            </span>
            <ChevronRight size={13} />
            <span>③ 복사 + 변이</span>
          </div>
          <section className="scene-panel">
            <div className="scene-toolbar">
              <div>
                <span className="live-dot" />
                <h2>보행 시뮬레이션</h2>
                <span className="count">
                  {snapshot?.robots.length ?? 0} 개체
                </span>
              </div>
              <div className="scene-options">
                <GhostIcon size={14} />
                <select
                  aria-label="고스트 비교"
                  value={ghostMode}
                  onChange={(e) => setGhostMode(e.target.value)}
                >
                  <option value="best">역대 최고 고스트</option>
                  <option value="previous">최근 완료 세대 고스트</option>
                  <option value="none">고스트 끄기</option>
                </select>
                <select
                  aria-label="화면 확대"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                >
                  <option value=".75">75%</option>
                  <option value="1">100%</option>
                  <option value="1.5">150%</option>
                </select>
              </div>
            </div>
            <div className="scene-caption">
              <span>
                평지 환경 <i /> 중력 {snapshot?.config.physics.gravity ?? -9.81}{" "}
                m/s²
              </span>
              <span>
                실측 배속 <b>×{(snapshot?.actualSpeed ?? 0).toFixed(1)}</b>
              </span>
            </div>
            {snapshot ? (
              <Scene
                snapshot={snapshot}
                ghost={ghost}
                zoom={zoom}
                onSelect={(ids) => send({ type: "select", ids })}
              />
            ) : (
              <div className="loading-scene">
                물리 공간을 준비하고 있습니다…
              </div>
            )}
            <div className="scene-footer">
              <span>
                <i className="legend-dot sage" />
                현재 개체
              </span>
              <span>
                <i className="legend-dot gold" />
                금색 챔피언
              </span>
              <span>
                <i className="legend-dot ghost" />
                기록 고스트
              </span>
              <span className="scene-model">3D · 12관절 · 독립 물리 환경</span>
            </div>
          </section>
          <div className={"selection-bar " + (selection ? "enabled" : "")}>
            <div className="selection-info">
              <MousePointer2 size={18} />
              <div>
                <strong>
                  {selection
                    ? "다음 세대의 부모를 선택하세요"
                    : "같은 출발선, 서로 다른 가능성"}
                </strong>
                <span>
                  {selection
                    ? `${selected.length}개체 선택됨 · 클릭 또는 드래그로 다중 선택`
                    : "평가가 끝나면 로봇을 직접 선택할 수 있습니다."}
                </span>
              </div>
            </div>
            <div className="selection-actions">
              <button
                className="text-button"
                disabled={!selection}
                onClick={() => send({ type: "autoSelect" })}
              >
                자동 선택
              </button>
              <button
                className="text-button muted"
                disabled={!selection || !selected.length}
                onClick={() => send({ type: "select", ids: [] })}
              >
                초기화
              </button>
              <button
                className="button primary"
                disabled={!selection || !selected.length}
                onClick={() =>
                  send({
                    type: "evolve",
                    settings: {
                      population: draft.population,
                      mutation: draft.mutation,
                      mutationScale: draft.mutationScale,
                      adaptiveSearch: draft.adaptiveSearch,
                      crossover: draft.crossover,
                      parentCount: draft.parentCount,
                    },
                  })
                }
              >
                <Check size={14} />
                결정완료
              </button>
            </div>
          </div>
          <div className="generation-recipe" aria-live="polite">
            <strong>
              {snapshot?.generation === 1
                ? "첫 세대: 서로 다른 무작위 신경망"
                : `${snapshot?.generation ?? 1}세대: 우승 1대 보존 · 탐색 ${snapshot?.robots.filter((r) => r.immigrant).length ?? 0}대 · 나머지는 부모 변이`}
            </strong>
            <p>
              {selection && selected.length
                ? `선택한 부모 ${selected.map((id) => String(id).padStart(2, "0")).join(", ")} → 결정완료를 누르면 자식을 만듭니다.`
                : snapshot?.auto
                  ? `보행 점수와 동작 다양성으로 ${Math.min(draft.parentCount, snapshot?.robots.length ?? 20)}대를 자동 선택하며 반복합니다.`
                  : "직접 부모를 고르려면 실행 / 재개, 계속 반복하려면 자동 학습 시작을 누르세요."}
            </p>
            <small>
              기본 방식: 부모 복사 · 선택 영역의 유전자 변이율{" "}
              {Math.round(draft.mutation * 100)}% · 변형 폭 최대{" "}
              {Math.round(draft.mutationScale * 100)}% · 교차{" "}
              {Math.round(draft.crossover * 100)}%
              <br />
              보행 단계에서는 한 다리·대응 관절 묶음·센서 연결을 함께 탐색하고,
              정체 시 더 작은 변이도 섞습니다. 자동 탐색 확대는 실패율과 같은
              단계의 최근 5세대 성과를 보고 중간·큰 변이와 새 무작위 개체를
              섞습니다. 우승 1대는 그대로 보존합니다.
            </small>
          </div>
          {(notice || error) && (
            <div
              role={error ? "alert" : "status"}
              className={"notice " + (error ? "error" : "")}
            >
              <span>{error || notice}</span>
              <button
                aria-label="알림 닫기"
                onClick={() => {
                  setNotice("");
                  setError("");
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <p className="model-note">
            회색은 평가 종료 표시입니다. 부모는 보행 점수로 고릅니다. 체공·수직
            충격은 감점하고, 몸을 지지하며 전진한 구간과 실제 발 옮김을
            평가합니다. 단계가 오르면 발 옮김·연속 전진 비중과 넘어짐 감점이
            커집니다.
            {[
              "cycle-curriculum-v6",
              "rhythmic-curriculum-v7",
              "mobile-curriculum-v8",
            ].includes(snapshot?.config.rewardModel ?? "") &&
              " 체중 이동과 발을 앞으로 옮겨 안정적으로 다시 디디는 중간 동작도 조금씩 평가합니다."}
            장기 체공은 점프 종료로 처리합니다.
          </p>
        </section>
        <aside className="records panel">
          <div className="panel-title">
            <Activity size={16} />
            <h2>학습 기록</h2>
            <span>02</span>
          </div>
          <div className="chart-tabs">
            <button
              className={!fitnessChart ? "active" : ""}
              onClick={() => setFitnessChart(false)}
            >
              전진 거리
            </button>
            <button
              className={fitnessChart ? "active" : ""}
              onClick={() => setFitnessChart(true)}
            >
              보행 점수
            </button>
          </div>
          <Chart
            history={snapshot?.history ?? []}
            rewardModel={snapshot?.config.rewardModel}
            fitness={fitnessChart}
            stage={snapshot?.curriculum.stage ?? "balance"}
          />
          {fitnessChart && (
            <p className="chart-stage-note">
              {STAGE_NAMES[snapshot?.curriculum.stage ?? "balance"]} 단계 점수만
              표시 · 단계 간 점수 분리
            </p>
          )}
          <div className="summary-grid">
            <div>
              <span>평균 거리</span>
              <strong>
                {(snapshot
                  ? snapshot.robots.reduce((s, r) => s + r.frame.distance, 0) /
                    snapshot.robots.length
                  : 0
                ).toFixed(3)}
                <small>m</small>
              </strong>
            </div>
            <div>
              <span>평균 보행 점수</span>
              <strong>
                {(snapshot
                  ? (1000 *
                      snapshot.robots.reduce((s, r) => s + r.fitness, 0)) /
                    snapshot.robots.length
                  : 0
                ).toFixed(3)}
              </strong>
            </div>
          </div>
          <div className="champion-card">
            <Trophy size={23} />
            <div>
              <span>이전 세대 챔피언</span>
              <strong>
                {snapshot?.generation === 1
                  ? "첫 우승을 기다립니다"
                  : snapshot?.robots.some((r) => r.champion)
                    ? "로봇 01"
                    : "기록 없음"}
              </strong>
              <small>
                {snapshot && snapshot.generation > 1
                  ? `${snapshot.generation - 1}세대 보행 점수 1위 유전자`
                  : "다음 세대에 금색으로 등장합니다"}
              </small>
            </div>
          </div>
          <div className="ranking-heading">
            <h3>실시간 순위</h3>
            <span>보행 점수 기준</span>
          </div>
          <div className="rank-list">
            <div className="rank-label">
              <span>순위 / 개체</span>
              <span>점수</span>
            </div>
            {ordered.map((r, i) => (
              <button
                key={r.id}
                className={
                  "rank-row " + (selected.includes(r.id) ? "chosen" : "")
                }
                disabled={!selection}
                title={lineage(r)}
                aria-label={`로봇 ${r.id} 부모 ${selected.includes(r.id) ? "선택 해제" : "선택"}`}
                onClick={() => choose(r.id)}
              >
                <span className="rank-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="robot-name">
                  {r.champion ? (
                    <Trophy size={12} color="#b18a3f" />
                  ) : (
                    <i
                      style={{
                        background: [
                          "#8cbbb1",
                          "#c5b6d9",
                          "#e6ab82",
                          "#9db9dc",
                        ][(r.id - 1) % 4],
                      }}
                    />
                  )}
                  로봇 {String(r.id).padStart(2, "0")}
                  <small>
                    {outcomeName[r.outcome]} · 지지{" "}
                    {r.frame.gait.supportTime.toFixed(2)}s
                  </small>
                  <small className="rank-lineage">{lineage(r)}</small>
                  {snapshot?.parentSuggestions.some(
                    (p) => p.id === r.id && p.reason !== "fitness",
                  ) && (
                    <small className="diversity-label">
                      {snapshot?.parentSuggestions.some(
                        (p) => p.id === r.id && p.reason === "shared-search",
                      )
                        ? "현재 연습 목표로 선발한 부모"
                        : "다른 발 사용·동작을 보존할 후보"}
                    </small>
                  )}
                </span>
                <b>{(r.fitness * 1000).toFixed(1)}</b>
                {selected.includes(r.id) && <Check size={12} />}
              </button>
            ))}
          </div>
          <div className="generation-log">
            <h3>세대별 기록</h3>
            {!snapshot?.history.length ? (
              <p>완료된 세대가 없습니다.</p>
            ) : (
              snapshot.history
                .slice(-8)
                .reverse()
                .map((s) => (
                  <div key={s.generation}>
                    <span>
                      {s.generation}세대 · {STAGE_NAMES[s.stage]}
                    </span>
                    <b>{s.bestDistanceM.toFixed(3)} m</b>
                    <span>조건 달성 {s.qualifiedCount}</span>
                  </div>
                ))
            )}
          </div>
        </aside>
      </main>
      <footer className="app-footer">
        <span>
          WALKING SIMULATOR <i /> 관찰하고, 선택하고, 진화하세요.
        </span>
        <span>실제 물리 계산 · 시드 기반 재현 · 결과 조작 없음</span>
      </footer>
    </div>
  );
}
