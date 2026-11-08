import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseCheckpoint } from "../src/persistence/files";
import { upgradeCompletedController } from "../src/persistence/upgrade";
const source = process.env.SOURCE_CHECKPOINT,
  output = process.env.OUTPUT_CHECKPOINT,
  root = process.env.WALKING_STORAGE_ROOT;
if (!source || !output || !root)
  throw new Error(
    "SOURCE_CHECKPOINT와OUTPUT_CHECKPOINT를 지정하고scripts/run.sh로 실행하세요.",
  );
const dedicated = realpathSync("/mnt/piper-usb/walking-simulator"),
  usb = statSync("/mnt/piper-usb").dev,
  target = resolve(output);
if (
  statSync(root).dev !== usb ||
  usb === statSync("/").dev ||
  (!realpathSync(root).startsWith(dedicated + "/") &&
    realpathSync(root) !== dedicated) ||
  !target.startsWith(dedicated + "/") ||
  [
    target,
    target + ".source.json",
    target + ".manifest.json",
    target + ".upgrade-cli.ts",
    target + ".upgrade-implementation.ts",
  ].some(existsSync)
)
  throw new Error(
    "새 USB 전용 출력 파일만 허용합니다. 원본은 덮어쓰지 않습니다.",
  );
if (statSync(source).size > 128 * 1024 * 1024)
  throw new Error("입력 파일이 너무 큽니다.");
const bytes = readFileSync(source, "utf8"),
  hash = createHash("sha256").update(bytes).digest("hex"),
  data = upgradeCompletedController(parseCheckpoint(bytes), hash);
let ancestor = dirname(target);
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
const ancestorReal = realpathSync(ancestor);
if (
  statSync(ancestor).dev !== usb ||
  (ancestorReal !== dedicated && !ancestorReal.startsWith(dedicated + "/"))
)
  throw new Error("USB 외부의 출력 경로는 만들지 않습니다.");
mkdirSync(dirname(target), { recursive: true });
if (
  statSync(dirname(target)).dev !== usb ||
  (!realpathSync(dirname(target)).startsWith(dedicated + "/") &&
    realpathSync(dirname(target)) !== dedicated)
)
  throw new Error("출력 장치/경로가 변경됐습니다.");
const cliSource = readFileSync(new URL(import.meta.url)),
  implementation = readFileSync(
    new URL("../src/persistence/upgrade.ts", import.meta.url),
  );
writeFileSync(target + ".upgrade-cli.ts", cliSource, { flag: "wx" });
writeFileSync(target + ".upgrade-implementation.ts", implementation, {
  flag: "wx",
});
writeFileSync(target + ".source.json", bytes, { flag: "wx" });
writeFileSync(
  target + ".manifest.json",
  JSON.stringify(
    {
      sourcePath: resolve(source),
      upgradeCliSHA256: createHash("sha256").update(cliSource).digest("hex"),
      upgradeImplementationSHA256: createHash("sha256")
        .update(implementation)
        .digest("hex"),
      sourceSHA256: hash,
      sourceGeneration: data.generation,
      effectiveGeneration: data.generation + 1,
      fromGenes: 565,
      toGenes: 589,
      neutralAddedWeights: 24,
      historyPreserved: true,
      physicalPolicyUnchanged: true,
      randomInitialPopulationInjected: false,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
writeFileSync(target, JSON.stringify(data), { flag: "wx" });
console.log(
  `중립 연결24개를 추가했습니다. ${data.generation}세대까지의 이력과 원본을 보존했습니다: ${target}`,
);
