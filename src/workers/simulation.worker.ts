/// <reference lib="webworker" />
import { initPhysics } from "../physics/engine";
const physicsReady = initPhysics();
import { Experiment } from "../simulation/experiment";
import { validateCheckpoint } from "../persistence/files";
import type { Command, Response } from "../simulation/types";
const scope = self as unknown as DedicatedWorkerGlobalScope;
let experiment: Experiment | undefined,
  speed = 1,
  actual = 0,
  lastPublish = 0,
  lastLoop = performance.now(),
  budget = 0,
  simulatedSeconds = 0,
  measuredTicks = 0,
  lastMeasure = performance.now();
const send = (message: Response) => scope.postMessage(message);
const snapshot = () => {
  if (experiment) {
    send({
      type: "snapshot",
      data: {
        ...experiment.snapshot(actual),
        requestedSpeed: speed,
        simulatedSeconds,
      },
    });
    lastPublish = performance.now();
  }
};
const bindSave = () => {
  if (experiment) experiment.onSave = (data) => send({ type: "saved", data });
};
const handleCommand = (event: MessageEvent<Command>) => {
  try {
    const command = event.data;
    if (command.type === "init") {
      const next = new Experiment(command.config);
      experiment?.dispose();
      experiment = next;
      bindSave();
      simulatedSeconds = 0;
      measuredTicks = 0;
      lastMeasure = performance.now();
      actual = 0;
      budget = 0;
    } else if (command.type === "load") {
      const next = Experiment.restore(validateCheckpoint(command.data));
      experiment?.dispose();
      experiment = next;
      bindSave();
      simulatedSeconds = 0;
      measuredTicks = 0;
      lastMeasure = performance.now();
      actual = 0;
      budget = 0;
    } else if (command.type === "speed") {
      if (!Number.isFinite(command.value))
        throw new Error("올바른 배속을 선택하세요.");
      speed = Math.max(0.1, Math.min(256, command.value));
      budget = 0;
      measuredTicks = 0;
      lastMeasure = performance.now();
      actual = 0;
    } else if (experiment) {
      if (command.type === "settings")
        experiment.queueSettings(command.settings);
      if (command.type === "start") {
        experiment.start(command.auto);
        budget = 0;
      }
      if (command.type === "pause") {
        experiment.pause();
        actual = 0;
        budget = 0;
      }
      if (command.type === "select" && experiment.phase === "selection")
        experiment.selected = [
          ...new Set(
            command.ids.filter((id) =>
              experiment!.robots.some((r) => r.individual.id === id),
            ),
          ),
        ];
      if (command.type === "autoSelect" && experiment.phase === "selection")
        experiment.selected = experiment.autoParents();
      if (command.type === "evolve")
        experiment.evolve(experiment.selected, command.settings);
      if (command.type === "save") {
        if (experiment.phase === "selection")
          send({ type: "saved", data: experiment.checkpoint() });
        else experiment.savePending = true;
      }
    }
    lastLoop = performance.now();
    snapshot();
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : "계산 오류",
    });
  }
};
scope.onmessage = (event: MessageEvent<Command>) => {
  void physicsReady
    .then(() => handleCommand(event))
    .catch((error) => send({ type: "error", message: String(error) }));
};
function loop() {
  const now = performance.now(),
    elapsed = Math.min(100, now - lastLoop);
  lastLoop = now;
  try {
    if (experiment) {
      // Generation transitions occur in a later event-loop turn so pause commands can be handled.
      if (experiment.phase === "selection" && experiment.auto)
        experiment.evolve(experiment.autoParents(), undefined, true);
      if (experiment.phase === "running" || experiment.phase === "validating") {
        budget = Math.min(budget + (elapsed / 1000) * speed, 0.5 * speed);
        const until = performance.now() + 6;
        while (
          budget >= experiment.config.physics.dt &&
          performance.now() < until &&
          (experiment.phase === "running" || experiment.phase === "validating")
        ) {
          experiment.step();
          budget -= experiment.config.physics.dt;
          measuredTicks++;
          simulatedSeconds += experiment.config.physics.dt;
          if ((experiment.phase as string) === "selection") {
            // Fast compact policies can finish many generations per second.
            // Automatic boundaries follow the same UI rate limit as ticks;
            // manual completion and user commands still publish immediately.
            if (!experiment.auto) snapshot();
            break;
          }
        }
      } else budget = 0;
      if (now - lastMeasure >= 500) {
        actual =
          (measuredTicks * experiment.config.physics.dt) /
          ((now - lastMeasure) / 1000);
        measuredTicks = 0;
        lastMeasure = now;
      }
      if (
        now - lastPublish >= (experiment.auto && speed > 1 ? 250 : 100) &&
        (experiment.phase === "running" ||
          experiment.phase === "validating" ||
          (experiment.phase === "selection" && experiment.auto))
      ) {
        snapshot();
      }
    }
  } catch (error) {
    if (experiment) {
      experiment.auto = false;
      experiment.phase = "error";
    }
    send({ type: "error", message: String(error) });
    snapshot();
  }
  setTimeout(loop, 0);
}
loop();
