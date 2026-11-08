import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const generation = (page: Page) =>
  page.locator(".metric").first().locator("strong");
// Measure the browser's actual click event -> paused DOM update. Playwright's
// scrolling/actionability waits and RPC scheduling are outside that interval.
async function stopAndMeasure(page: Page) {
  await page.evaluate(() => {
    delete document.documentElement.dataset.stopLatency;
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "자동 학습 정지",
    );
    if (!button) throw new Error("정지 버튼 없음");
    button.addEventListener(
      "click",
      () => {
        const start = performance.now();
        const status = document.querySelector(".status-pill")!;
        const observer = new MutationObserver(() => {
          if (status.textContent === "일시정지") {
            document.documentElement.dataset.stopLatency = String(
              performance.now() - start,
            );
            observer.disconnect();
          }
        });
        observer.observe(status, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      },
      { once: true, capture: true },
    );
  });
  await page
    .getByRole("button", { name: "자동 학습 정지", exact: true })
    .click();
  await expect(page.locator(".status-pill")).toHaveText("일시정지");
  await expect
    .poll(() => page.locator("html").getAttribute("data-stop-latency"))
    .not.toBeNull();
  return Number(await page.locator("html").getAttribute("data-stop-latency"));
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "자동 학습 시작", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("초기 학습 방식")).toHaveValue("random");
  await page.getByLabel("초기 학습 방식").selectOption("weak-balance");
  await expect(page.getByLabel("초기 균형 편향", { exact: true })).toHaveValue(
    "0.5",
  );
  await page.getByLabel("초기 학습 방식").selectOption("random");
  await expect(page.getByLabel("초기 균형 편향", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("초기 학습 방식").selectOption("weak-balance");
  await page.getByLabel("개체 수", { exact: true }).fill("4");
  await page.getByLabel("평가 시간 (s)", { exact: true }).fill("1");
  await page.getByRole("button", { name: "새 실험 적용" }).click();
  await page.getByRole("button", { name: "×32", exact: true }).click();
}
async function finish(page: Page) {
  await page.getByRole("button", { name: "실행 / 재개", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
}
test("초기 화면·동시 출발·수동 클릭과 드래그·엘리트", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await expect(
    page.getByRole("heading", { name: "한 걸음씩, 더 멀리." }),
  ).toBeVisible();
  await expect(page.locator(".rank-row")).toHaveCount(4);
  await finish(page);
  const canvas = page.locator("canvas"),
    before = await canvas.evaluate((e: HTMLCanvasElement) => e.toDataURL());
  await page.waitForTimeout(250);
  expect(await canvas.evaluate((e: HTMLCanvasElement) => e.toDataURL())).toBe(
    before,
  );
  await page
    .getByRole("button", { name: "로봇 1 부모 선택", exact: true })
    .click();
  await expect(page.getByText("1개체 선택됨", { exact: false })).toBeVisible();
  await expect(generation(page)).toContainText("01");
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await page
    .getByRole("button", { name: "전체 동시 보기", exact: true })
    .click();
  await page.waitForTimeout(250);
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 2,
    bounds.y + bounds.height - 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator(".rank-row.chosen")).toHaveCount(4);
  await page.getByRole("button", { name: "결정완료", exact: true }).click();
  await expect(generation(page)).toContainText("02");
  await expect(
    page.locator(".rank-row").filter({ has: page.locator("svg") }),
  ).toHaveCount(1);
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "개체 상세", exact: true }).click();
  await page.getByLabel("관찰 로봇").selectOption("1");
  await page.waitForTimeout(150);
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/desktop-3d-detail.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("자동 학습 정지 후 같은 화면·같은 상태 유지와 재개", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "×128", exact: true }).click();
  await page
    .getByRole("button", { name: "자동 학습 시작", exact: true })
    .click();
  await expect
    .poll(async () => parseInt(await generation(page).innerText()))
    .toBeGreaterThanOrEqual(3);
  const latency = await stopAndMeasure(page);
  console.log("클릭→일시정지 표시:", latency, "ms");
  expect(latency).toBeLessThan(500);
  const metrics = await page.locator(".metric-grid").innerText(),
    frame = await page
      .locator("canvas")
      .evaluate((e: HTMLCanvasElement) => e.toDataURL());
  await page.waitForTimeout(350);
  expect(await page.locator(".metric-grid").innerText()).toBe(metrics);
  expect(
    await page
      .locator("canvas")
      .evaluate((e: HTMLCanvasElement) => e.toDataURL()),
  ).toBe(frame);
  const old = parseInt(await generation(page).innerText());
  await page
    .getByRole("button", { name: "자동 학습 시작", exact: true })
    .click();
  await expect
    .poll(async () => parseInt(await generation(page).innerText()))
    .toBeGreaterThan(old);
  await page
    .getByRole("button", { name: "자동 학습 정지", exact: true })
    .click();
  await expect(page.locator(".scene-panel")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("JSON·CSV 내보내기·복원과 손상 파일 거절", async ({ page }) => {
  await setup(page);
  await finish(page);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const file = await downloaded;
  const text = await readFile((await file.path())!, "utf8");
  const parsed = JSON.parse(text);
  expect(parsed.config.population).toBe(4);
  expect(parsed.completedResults).toHaveLength(4);
  expect(parsed.formatVersion).toBe(6);
  expect(parsed.controllerVersion).toBe("shared-direction-phase-44-v7");
  expect(parsed.population[0].genes).toHaveLength(44);
  expect(parsed.completedResults[0].frame.bodies).toHaveLength(13);
  expect(parsed.completedResults[0].frame.angles).toHaveLength(12);
  await page.getByRole("button", { name: "자동 선택", exact: true }).click();
  await page.getByRole("button", { name: "결정완료", exact: true }).click();
  await expect(generation(page)).toContainText("02");
  await page.locator("input[type=file]").setInputFiles({
    name: "experiment.json",
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
  await expect(generation(page)).toContainText("01");
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"formatVersion":99}'),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(generation(page)).toContainText("01");
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "세대별 기록 CSV 내보내기" }).click();
  const exported = await csvDownload;
  const csvText = await readFile((await exported.path())!, "utf8");
  expect(csvText.split("\n")[0]).toContain("bestDistanceM");
  expect(csvText.split("\n")[0]).toContain("rewardVersion");
  expect(csvText.split("\n")[1].split(",").at(-1)).toBe("mobile-curriculum-v8");
});
test("좁은 화면에서도 조작할 수 있다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByLabel("개체 수", { exact: true }).fill("20");
  await page.getByRole("button", { name: "새 실험 적용", exact: true }).click();
  await expect(page.locator(".population-tile")).toHaveCount(20);
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-robots",
    "20",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await finish(page);
  const last = page.locator('.population-tile[data-robot-id="20"]');
  await last.scrollIntoViewIfNeeded();
  const tile = (await last.boundingBox())!;
  await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await expect(last).toHaveClass(/chosen/);
  await expect(page.locator(".rank-row.chosen")).toHaveCount(1);
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/mobile.png",
    fullPage: true,
  });
});

test("기본 20대 동시 표시와 선택한 부모의 작은 변이 19대", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/");
  await expect(page.locator(".population-tile")).toHaveCount(20);
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-robots",
    "20",
  );
  await expect(
    page.getByRole("button", { name: "전체 동시 보기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // The new default is the measured compact policy. Explicitly select the
  // legacy 589 model to keep this manual small-mutation regression meaningful.
  await expect(page.getByLabel("신경망 구조")).toHaveValue("shared-direction");
  await page.getByLabel("신경망 구조").selectOption("local-periodic-rnn");
  await page.getByRole("button", { name: "새 실험 적용", exact: true }).click();
  await expect(page.getByLabel("교차율", { exact: true })).toHaveValue("0");
  await expect(
    page.getByText("보행 규칙 없이 시작", { exact: true }),
  ).toBeVisible();
  await page.locator(".gene-inspector summary").click();
  await expect(page.locator(".gene-inspector summary")).toContainText("589개");
  await expect(page.locator(".gene-inspector > div > span")).toHaveCount(24);
  await page.getByRole("button", { name: "다음 값", exact: true }).click();
  await expect(page.locator(".gene-inspector nav > span")).toContainText("2 /");
  await page.locator(".gene-inspector summary").click();
  const tiles = page.locator(".population-tile"),
    canvas = page.locator("canvas"),
    box = (await canvas.boundingBox())!;
  for (let i = 0; i < 20; i++) {
    const tile = (await tiles.nth(i).boundingBox())!;
    expect(tile.x).toBeGreaterThanOrEqual(box.x);
    expect(tile.y).toBeGreaterThanOrEqual(box.y);
    expect(tile.x + tile.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(tile.y + tile.height).toBeLessThanOrEqual(box.y + box.height + 1);
  }
  await page.getByLabel("평가 시간 (s)", { exact: true }).fill("1");
  await page.getByRole("button", { name: "새 실험 적용", exact: true }).click();
  await page.getByRole("button", { name: "×32", exact: true }).click();
  await finish(page);
  await page.waitForTimeout(250);
  const sourceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const source = JSON.parse(
    await readFile((await (await sourceDownload).path())!, "utf8"),
  );
  await page
    .getByRole("checkbox", { name: "자동 탐색 확대", exact: true })
    .uncheck();
  const parentTile = page.locator('.population-tile[data-robot-id="5"]');
  await parentTile.scrollIntoViewIfNeeded();
  const tile = (await parentTile.boundingBox())!;
  await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await expect(page.locator(".population-tile.chosen")).toHaveCount(1);
  await expect(page.locator('.population-tile[data-robot-id="5"]')).toHaveClass(
    /chosen/,
  );
  await expect(generation(page)).toContainText("01");
  await page.getByRole("button", { name: "결정완료", exact: true }).click();
  await expect(generation(page)).toContainText("02");
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await expect(page.locator(".population-tile.elite")).toHaveCount(1);
  await expect(
    page.locator(".population-tile").filter({ hasText: "부모 5 ·" }),
  ).toHaveCount(19);
  const childDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await childDownload).path())!, "utf8"),
  );
  expect(data.population).toHaveLength(20);
  expect(data.evolutionVersion).toBe("adaptive-mutation-v16");
  for (const c of data.population.slice(1)) {
    expect(c.parents).toEqual([5]);
    expect(c.birth.parentGenes).toEqual(source.population[4].genes);
    expect(c.birth.changedGenes.length).toBeGreaterThan(0);
    expect(c.genes).not.toEqual(source.population[4].genes);
  }
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/population-20.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "자동 학습 시작", exact: true })
    .click();
  await expect
    .poll(async () => parseInt(await generation(page).innerText()))
    .toBeGreaterThanOrEqual(3);
  const latency = await stopAndMeasure(page);
  console.log("20대 클릭→일시정지 표시:", latency, "ms");
  expect(latency).toBeLessThan(500);
  const before = await page.locator(".metric-grid").innerText();
  await page.waitForTimeout(350);
  expect(await page.locator(".metric-grid").innerText()).toBe(before);
  expect(errors).toEqual([]);
});

test("평가 종료 회색 표시와 보행 점수 기반 부모 선택", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".population-tile.ended")).toHaveCount(0);
  await page.getByLabel("개체 수", { exact: true }).fill("20");
  await page.getByLabel("평가 시간 (s)", { exact: true }).fill("3");
  await page.getByRole("button", { name: "새 실험 적용" }).click();
  await page.getByLabel("자동 선택 부모 수", { exact: true }).fill("2");
  await page.getByRole("button", { name: "×1", exact: true }).click();
  // Observe before clicking: a short-lived mixed state can finish before
  // Playwright returns from its click/paint synchronization.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const ended = document.querySelectorAll(".population-tile.ended").length;
      if (ended > 0 && ended < 20) {
        document.documentElement.dataset.mixedEnded = "true";
        observer.disconnect();
      }
    });
    observer.observe(document.querySelector(".population-overlay")!, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "실행 / 재개", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-mixed-ended",
    "true",
  );
  await expect(
    page.locator('.population-tile[data-outcome="active"].ended'),
  ).toHaveCount(0);
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await expect(page.locator(".population-tile.ended")).toHaveCount(20);
  const shade = await page
    .locator(".population-tile.ended")
    .first()
    .evaluate((e) => getComputedStyle(e, "::before").backgroundColor);
  expect(shade).toBe("rgba(145, 150, 155, 0.25)");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(data.selectionVersion).toBe("shared-selection-v1");
  expect(data.rewardVersion).toBe("mobile-curriculum-v8");
  const eligible = data.completedResults.filter(
    (r: { outcome: string }) =>
      r.outcome !== "jumped" && r.outcome !== "invalid",
  );
  const expected = [...(eligible.length ? eligible : data.completedResults)]
    .sort(
      (a, b) =>
        b.fitness - a.fitness ||
        Math.floor(b.frame.distance * 1000) -
          Math.floor(a.frame.distance * 1000) ||
        b.frame.gait.groundedForward - a.frame.gait.groundedForward ||
        b.frame.gait.supportTime - a.frame.gait.supportTime ||
        a.id - b.id,
    )
    .slice(0, data.config.searchMethod === "covariance" ? 1 : 2)
    .map((r) => r.id);
  await page.getByRole("button", { name: "자동 선택", exact: true }).click();
  await expect(page.locator(".rank-row.chosen")).toHaveCount(expected.length);
  const selected = await page
    .locator(".rank-row.chosen")
    .evaluateAll((rows) =>
      rows.map((r) =>
        Number(r.getAttribute("aria-label")!.match(/로봇 (\d+)/)![1]),
      ),
    );
  expect(selected).toEqual(expected);
  await expect(generation(page)).toContainText("01");
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/gray-walking.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "개체 상세", exact: true }).click();
  await expect(page.locator(".ended-filter")).toBeVisible();
  await page
    .getByRole("button", { name: "전체 동시 보기", exact: true })
    .click();
  await expect(page.locator(".population-tile.ended")).toHaveCount(20);
});

test("단계 승급 예약·저장 복원·다음 세대 전환과 점수 그래프 분리", async ({
  page,
}) => {
  // This uses real physics with a deliberately short TEST threshold. It does
  // not seed any learned genome or claim to have learned the production goal.
  const { initPhysics } = await import("../src/physics/engine");
  const { Experiment } = await import("../src/simulation/experiment");
  const { cloneConfig } = await import("../src/simulation/config");
  const { validateCheckpoint } = await import("../src/persistence/files");
  await initPhysics();
  const config = cloneConfig();
  config.population = 4;
  config.duration = 1;
  config.seed = 16;
  config.controllerModel = "timed-rnn";
  config.searchMethod = "adaptive";
  config.rewardModel = "rhythmic-curriculum-v7";
  config.initialization = "random";
  config.initialBalanceBias = 0;
  config.curriculum.balanceSeconds = 0.1;
  config.curriculum.promotionGenerations = 1;
  const experiment = new Experiment(config);
  experiment.start(false);
  while (experiment.phase === "running") experiment.step();
  const data = validateCheckpoint(experiment.checkpoint());
  experiment.dispose();
  expect(data.curriculum.pendingStage).toBe("stepping");
  await setup(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "curriculum-test.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect(page.locator(".training-target")).toHaveAttribute(
    "data-stage",
    "balance",
  );
  await expect(page.locator(".promotion-status")).toContainText(
    "다음 세대부터 발 옮기기",
  );
  await page.locator(".score-details summary").click();
  await expect(page.locator(".score-breakdown")).toBeVisible();
  await expect(page.locator(".score-details")).toContainText(
    "후진은 누적 1m당 150점",
  );
  await expect(page.locator(".score-breakdown")).toContainText(
    "안정 연속 보행",
  );
  await page
    .getByRole("button", { name: "로봇 1 부모 선택", exact: true })
    .click();
  await page.getByRole("button", { name: "결정완료", exact: true }).click();
  await expect(page.locator(".training-target")).toHaveAttribute(
    "data-stage",
    "stepping",
  );
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await expect(page.locator(".training-panel")).toContainText(
    "평가 1초 동안 지지를 계속 보상",
  );
  await expect(page.locator(".training-panel")).not.toContainText(
    "초에서 포화",
  );
  await expect(page.locator(".chart-stage-note")).toContainText(
    "발 옮기기 단계 점수만",
  );
  await expect(page.locator(".chart svg circle")).toHaveCount(1);
  await expect(page.locator(".chart svg")).toContainText("2세대");
  await expect(page.locator(".generation-log")).toContainText("균형 유지");
  await expect(page.locator(".generation-log")).toContainText("발 옮기기");
  await page.locator("input[type=file]").setInputFiles({
    name: "old-v4.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...data, formatVersion: 4 })),
  });
  await expect(page.getByRole("alert")).toContainText("단계별 학습 이전");
  await expect(page.locator(".training-target")).toHaveAttribute(
    "data-stage",
    "stepping",
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "old-reward-v5.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...data,
        formatVersion: 5,
        appVersion: "0.5.0",
        rewardVersion: "curriculum-progress-v2",
      }),
    ),
  });
  await expect(page.getByRole("alert")).toContainText("후진 누적 감점 이전");
  await expect(page.locator(".training-target")).toHaveAttribute(
    "data-stage",
    "stepping",
  );
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await page.screenshot({
    path:
      process.env.WALKING_STORAGE_ROOT + "/artifacts/curriculum-transition.png",
    fullPage: true,
  });
});

test("실패 후 변이 확대·실제 구성·토크 표시·확대 끄기", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("checkbox", { name: "자동 탐색 확대", exact: true }),
  ).toBeChecked();
  await page.getByLabel("신경망 구조").selectOption("timed-rnn");
  await page.getByLabel("자동 균형 탐색").selectOption("adaptive");
  await page.getByLabel("평가 시간 (s)", { exact: true }).fill("1");
  await page.getByRole("button", { name: "새 실험 적용", exact: true }).click();
  await page.getByRole("button", { name: "×32", exact: true }).click();
  await finish(page);
  await expect(page.locator(".search-status")).toHaveAttribute(
    "data-mode",
    "recovery",
  );
  await expect(page.locator(".search-status")).toContainText(
    "작은 10 · 중간 5 · 큰 2 · 새 무작위 2",
  );
  await page.getByRole("button", { name: "자동 선택", exact: true }).click();
  await page.getByRole("button", { name: "결정완료", exact: true }).click();
  await expect(generation(page)).toContainText("02");
  await expect(page.locator(".status-pill")).toHaveText("부모 선택");
  await expect(page.locator(".search-status")).toContainText(
    "작은 변이 10대 · 중간 변이 5대 · 큰 변이 2대 · 새 무작위 2대",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(data.formatVersion).toBe(6);
  expect(data.config.adaptiveSearch).toBe(true);
  const large = data.population.filter(
    (r: any) => r.birth?.mutationProfile?.kind === "large",
  );
  expect(large).toHaveLength(2);
  expect(large.every((r: any) => r.birth.changedGenes.length > 50)).toBe(true);
  expect(data.population.filter((r: any) => r.immigrant)).toHaveLength(2);
  await page.locator(".gene-inspector summary").click();
  await expect(page.getByLabel("현재 관절 토크")).toBeVisible();
  await expect(page.locator(".torque-readout > div > span")).toHaveCount(12);
  await page
    .getByRole("checkbox", { name: "자동 탐색 확대", exact: true })
    .uncheck();
  await expect(page.locator(".search-status")).toHaveAttribute(
    "data-mode",
    "normal",
  );
  await expect(page.locator(".search-status")).toContainText(
    "작은 19 · 중간 0 · 큰 0 · 새 무작위 0",
  );
  await page.screenshot({
    path: process.env.WALKING_STORAGE_ROOT + "/artifacts/adaptive-search.png",
    fullPage: true,
  });
});

test("이전 보상은 그대로 복원하고 새 실험만 지속 지지·네 발 기준으로 시작한다", async ({
  page,
}) => {
  const { initPhysics } = await import("../src/physics/engine");
  const { Experiment } = await import("../src/simulation/experiment");
  const { cloneConfig } = await import("../src/simulation/config");
  await initPhysics();
  const config = cloneConfig();
  config.population = 2;
  config.duration = 1;
  config.rewardModel = "temporal-curriculum-v4";
  config.evaluation.contactModel = "proximity";
  config.evaluation.walkingContinuityGrace = 0;
  config.curriculum.forwardContinuousSeconds = 0;
  config.curriculum.requireWalkingAtFinish = false;
  config.curriculum.useDriftLimits = false;
  config.curriculum.mobileSupportRatio = 0;
  config.curriculum.minJointFreedomAtPromotion = 0;
  config.controllerModel = "timed-rnn";
  config.searchMethod = "adaptive";
  config.curriculum.coordinatedPromotion = false;
  config.curriculum.steppingFeet = 3;
  config.curriculum.steppingSteps = 4;
  const e = new Experiment(config);
  e.start(false);
  while (e.phase === "running") e.step();
  const old = e.checkpoint() as any;
  e.dispose();
  old.appVersion = "0.8.0";
  delete old.config.rewardModel;
  delete old.config.curriculum.maxWalkingFlightTime;
  delete old.config.evaluation.contactModel;
  await setup(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "legacy-reward.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(old)),
  });
  await expect(
    page.getByText("이전 학습 기준을 유지한 실험입니다.", { exact: false }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const restored = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(restored.rewardVersion).toBe("temporal-curriculum-v4");
  expect(restored.config.rewardModel).toBe("temporal-curriculum-v4");
  expect(restored.config.curriculum.maxWalkingFlightTime).toBe(0.5);
  expect(restored.config.evaluation.contactModel).toBe("proximity");
  expect(restored.config.curriculum.useDriftLimits).toBe(false);
  expect(restored.config.curriculum.forwardContinuousSeconds).toBe(0);
  expect(restored.population).toEqual(old.population);
  expect(restored.history).toEqual(old.history);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "새 실험 적용", exact: true }).click();
  await expect(
    page.getByText("이전 학습 기준을 유지한 실험입니다.", { exact: false }),
  ).toHaveCount(0);
  await finish(page);
  const freshDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const fresh = JSON.parse(
    await readFile((await (await freshDownload).path())!, "utf8"),
  );
  expect(fresh.rewardVersion).toBe("mobile-curriculum-v8");
  expect(fresh.config.curriculum.coordinatedPromotion).toBe(true);
  expect(fresh.config.curriculum.maxWalkingFlightTime).toBe(0.02);
  expect(fresh.config.evaluation.contactModel).toBe("load-bearing");
  expect(fresh.config.curriculum).toEqual(cloneConfig().curriculum);
  expect(fresh.config.evaluation.walkingContinuityGrace).toBe(0.1);
  expect(fresh.config.duration).toBe(config.duration);
  expect(fresh.config.physics).toEqual(config.physics);
  expect(fresh.config.curriculum.steppingFeet).toBe(4);
  expect(fresh.config.curriculum.steppingSteps).toBe(8);
});

test("명시적 제어기 확장의 이전 세대와 원본 정보를 불러오기·내보내기에 유지한다", async ({
  page,
}) => {
  const { initPhysics } = await import("../src/physics/engine"),
    { Experiment } = await import("../src/simulation/experiment"),
    { cloneConfig } = await import("../src/simulation/config"),
    { upgradeCompletedController } = await import("../src/persistence/upgrade"),
    { createHash } = await import("node:crypto");
  await initPhysics();
  const e = new Experiment({
    ...cloneConfig(),
    controllerModel: "local-feedback-rnn",
    population: 2,
    parentCount: 1,
    duration: 1,
  });
  e.start(false);
  while (["running", "validating"].includes(e.phase)) e.step();
  e.evolve(e.autoParents());
  while (["running", "validating"].includes(e.phase)) e.step();
  const source = e.checkpoint(),
    hash = createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    data = upgradeCompletedController(source, hash);
  e.dispose();
  await setup(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "explicit-controller-upgrade.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect(generation(page)).toContainText("02");
  await expect(
    page.getByText("2세대 완료 상태에서 제어기를 확장했습니다.", {
      exact: false,
    }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const saved = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(saved.history).toEqual(source.history);
  expect(saved.rngState).toBe(source.rngState);
  expect(saved.controllerTransitions[0].sourceSHA256).toBe(hash);
  expect(saved.population).toEqual(data.population);
});

for (const model of [
  "shared-reflex",
  "shared-direction",
  "shared-anatomical",
] as const) {
  test(`${model} 선택과 유전자·분포 상태 저장 복원`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await page.getByLabel("신경망 구조").selectOption(model);
    await page.getByLabel("초기 학습 방식").selectOption("random");
    await page
      .getByRole("button", { name: "새 실험 적용", exact: true })
      .click();
    await expect(page.getByLabel("신경망 구조")).toHaveValue(model);
    await expect(page.getByLabel("공통 보행 탐색")).toContainText(
      "균형 감각 탐색",
    );
    await finish(page);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const raw = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(raw.controllerVersion).toBe(
      model === "shared-anatomical"
        ? "anatomical-shared-phase-44-v8"
        : model === "shared-direction"
          ? "shared-direction-phase-44-v7"
          : "shared-reflex-phase-38-v6",
    );
    expect(raw.config.parentCount).toBe(3);
    expect(
      raw.population.every(
        (p: { genes: number[] }) =>
          p.genes.length === (model === "shared-reflex" ? 38 : 44),
      ),
    ).toBe(true);
    const { initPhysics } = await import("../src/physics/engine");
    await initPhysics();
    const { Experiment } = await import("../src/simulation/experiment");
    const e = Experiment.restore(raw);
    e.evolve(e.autoParents(), undefined, true);
    while (e.phase === "running" || e.phase === "validating") e.step();
    const saved = e.checkpoint();
    e.dispose();
    expect(saved.sharedSearch?.optimizer.mean).toHaveLength(9);
    await page.locator("input[type=file]").setInputFiles({
      name: "shared-completed-generation.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(saved)),
    });
    await expect(generation(page)).toContainText("02");
    await expect(page.getByLabel("공통 보행 탐색")).toContainText(
      "균형 감각 탐색",
    );
    const next = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const reexported = JSON.parse(
      await readFile((await (await next).path())!, "utf8"),
    );
    expect(reexported.sharedSearch).toEqual(saved.sharedSearch);
    expect(reexported.population).toEqual(saved.population);
    expect(errors).toEqual([]);
  });
}
