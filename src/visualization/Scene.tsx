import { GenomeInspector } from "../components/GenomeInspector";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { lineage, rank } from "../genetics/evolution";
import type { Config, Frame, Ghost, Snapshot } from "../simulation/types";
export function ghostFrame(ghost: Ghost, tick: number): Frame {
  const list = ghost.frames;
  let low = 0,
    high = list.length - 1;
  while (low < high) {
    const m = Math.ceil((low + high) / 2);
    if (list[m].tick <= tick) low = m;
    else high = m - 1;
  }
  const a = list[low],
    b = list[Math.min(low + 1, list.length - 1)],
    t =
      a === b
        ? 0
        : Math.max(0, Math.min(1, (tick - a.tick) / (b.tick - a.tick)));
  if (t === 0) return a;
  return {
    ...a,
    bodies: a.bodies.map((p, i) => {
      const q = b.bodies[i],
        rotation = new THREE.Quaternion(p.q.x, p.q.y, p.q.z, p.q.w).slerp(
          new THREE.Quaternion(q.q.x, q.q.y, q.q.z, q.q.w),
          t,
        );
      return {
        ...p,
        x: THREE.MathUtils.lerp(p.x, q.x, t),
        y: THREE.MathUtils.lerp(p.y, q.y, t),
        z: THREE.MathUtils.lerp(p.z, q.z, t),
        q: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      };
    }),
  };
}
const palette = [
  "#8cbbb1",
  "#b1a1cb",
  "#d6a07c",
  "#8aacc9",
  "#b9ba88",
  "#be8f9f",
];
function createRobot(config: Config, color: string, ghost = false) {
  const model = new THREE.Group(),
    parts: THREE.Group[] = [],
    c = config.robot;
  const material = (hex: string, metalness = 0.4) =>
    new THREE.MeshStandardMaterial({
      color: hex,
      metalness,
      roughness: 0.45,
      transparent: ghost,
      opacity: ghost ? 0.22 : 1,
      depthWrite: !ghost,
    });
  const shell = material(color),
    dark = material("#263137"),
    metal = material("#91a0a3", 0.75),
    rubber = material("#141e22", 0.05),
    light = material("#a5e9d9");
  const box = (w: number, h: number, d: number, mat: THREE.Material) =>
    new THREE.Mesh(
      new RoundedBoxGeometry(w, h, d, 2, Math.min(0.018, w / 5, h / 5, d / 5)),
      mat,
    );
  const mesh = (part: THREE.Group, m: THREE.Mesh, x = 0, y = 0, z = 0) => {
    m.position.set(x, y, z);
    m.castShadow = !ghost;
    m.receiveShadow = true;
    part.add(m);
    return m;
  };
  const cylinder = (
    radius: number,
    length: number,
    mat: THREE.Material,
    axis: "x" | "z",
  ) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 14),
      mat,
    );
    m.rotation[axis === "x" ? "z" : "x"] = Math.PI / 2;
    return m;
  };
  const torso = new THREE.Group();
  model.add(torso);
  parts.push(torso);
  mesh(torso, box(c.width, c.height, c.depth, dark));
  mesh(
    torso,
    box(c.width * 0.88, 0.035, c.depth * 0.96, shell),
    0,
    c.height / 2 + 0.012,
  );
  for (const side of [-1, 1]) {
    mesh(
      torso,
      box(c.width * 0.56, 0.026, 0.012, metal),
      -0.01,
      -0.005,
      side * (c.depth / 2 + 0.004),
    );
    for (let j = 0; j < 5; j++)
      mesh(
        torso,
        box(0.026, 0.004, 0.012, dark),
        -0.12 + j * 0.045,
        c.height / 2 + 0.032,
        side * 0.065,
      );
  }
  const sensor = mesh(
    torso,
    box(0.046, 0.085, 0.19, dark),
    c.width / 2 + 0.02,
    0.015,
  );
  mesh(torso, box(0.008, 0.022, 0.1, light), c.width / 2 + 0.045, 0.028);
  const lidar = mesh(
    torso,
    new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.035, 16), rubber),
    c.width * 0.24,
    c.height / 2 + 0.045,
  );
  for (let leg = 0; leg < 4; leg++) {
    const side = leg % 2 === 0 ? 1 : -1,
      carrier = new THREE.Group(),
      upper = new THREE.Group(),
      lower = new THREE.Group();
    parts.push(carrier, upper, lower);
    model.add(carrier, upper, lower);
    mesh(carrier, cylinder(0.045, c.coxa, metal, "z"));
    mesh(
      carrier,
      cylinder(0.047, 0.018, shell, "z"),
      0,
      0,
      (side * c.coxa) / 2,
    );
    mesh(upper, box(0.055, c.upper * 0.8, 0.05, shell), 0, 0.006);
    mesh(upper, cylinder(0.047, 0.07, dark, "z"), 0, c.upper / 2);
    mesh(upper, cylinder(0.028, 0.074, metal, "z"), 0, -c.upper / 2);
    mesh(lower, box(0.025, c.lower, 0.025, dark));
    mesh(lower, box(0.035, c.lower * 0.45, 0.035, metal), 0, c.lower * 0.2);
    mesh(lower, cylinder(0.029, 0.05, shell, "z"), 0, c.lower / 2);
    mesh(
      lower,
      new THREE.Mesh(new THREE.SphereGeometry(c.footRadius, 14, 10), rubber),
      0,
      -c.lower / 2,
    );
  }
  // Bake fixed decorations into one colored mesh per physical rigid body.
  // The detailed shape stays intact, while 20 robots need 13 body draw calls
  // each rather than a draw call for every screw, cover and motor decoration.
  const mergedMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.35,
    roughness: 0.48,
    transparent: ghost,
    opacity: ghost ? 0.18 : 1,
    depthWrite: !ghost,
  });
  const shellVertices: {
    attribute: THREE.BufferAttribute;
    indices: number[];
  }[] = [];
  for (const part of parts) {
    const geometries: THREE.BufferGeometry[] = [],
      indices: number[] = [];
    let offset = 0;
    for (const object of [...part.children]) {
      if (!(object instanceof THREE.Mesh)) continue;
      object.updateMatrix();
      const geometry = object.geometry.index
        ? object.geometry.toNonIndexed()
        : object.geometry.clone();
      geometry.applyMatrix4(object.matrix);
      geometry.deleteAttribute("uv");
      const count = geometry.getAttribute("position").count,
        color = (object.material as THREE.MeshStandardMaterial).color,
        colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors.set([color.r, color.g, color.b], i * 3);
        if (object.material === shell) indices.push(offset + i);
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometries.push(geometry);
      offset += count;
      part.remove(object);
      object.geometry.dispose();
    }
    const geometry = mergeGeometries(geometries)!;
    geometries.forEach((g) => g.dispose());
    const combined = new THREE.Mesh(geometry, mergedMaterial);
    combined.castShadow = !ghost;
    combined.receiveShadow = true;
    part.add(combined);
    shellVertices.push({
      attribute: geometry.getAttribute("color") as THREE.BufferAttribute,
      indices,
    });
  }
  const lastShellColor = shell.color.clone();
  const markers = Array.from({ length: 4 }, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.032, 0.043, 24),
      new THREE.MeshBasicMaterial({
        color: "#a8d9a8",
        transparent: true,
        opacity: ghost ? 0 : 0.65,
        side: THREE.DoubleSide,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    model.add(m);
    return m;
  });
  const update = (frame: Frame) => {
    if (!lastShellColor.equals(shell.color)) {
      for (const { attribute, indices } of shellVertices) {
        for (const i of indices)
          attribute.setXYZ(i, shell.color.r, shell.color.g, shell.color.b);
        attribute.needsUpdate = true;
      }
      lastShellColor.copy(shell.color);
    }
    parts.forEach((part, i) => {
      const p = frame.bodies[i];
      part.position.set(p.x, p.y, p.z);
      part.quaternion.set(p.q.x, p.q.y, p.q.z, p.q.w);
    });
    markers.forEach((m, i) => {
      const f = frame.feet[i];
      m.position.set(f.position.x, 0.003, f.position.z);
      (m.material as THREE.MeshBasicMaterial).color.set(
        f.contact ? "#b5e9a3" : "#e8ad73",
      );
      m.visible = !ghost;
    });
  };
  return { model, update, shell };
}
export function Scene({
  snapshot,
  ghost,
  zoom,
  onSelect,
}: {
  snapshot: Snapshot;
  ghost: Ghost | null;
  zoom: number;
  onSelect: (ids: number[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    current = useRef({ snapshot, ghost, zoom, onSelect }),
    modeRef = useRef("all"),
    focusRef = useRef(1);
  current.current = { snapshot, ghost, zoom, onSelect };
  const [mode, setMode] = useState("all"),
    [focus, setFocus] = useState(0),
    [failure, setFailure] = useState("");
  modeRef.current = mode;
  focusRef.current = focus || rank(snapshot.robots)[0].id;
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const key =
    JSON.stringify(snapshot.config.robot) + ":" + snapshot.robots.length;
  useEffect(() => {
    if (focus > snapshot.robots.length) setFocus(0);
  }, [snapshot.robots.length, focus]);
  useEffect(() => {
    const element = host.current!;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: true,
      });
    } catch {
      setFailure(
        "이 브라우저에서 WebGL 3D를 시작하지 못했습니다. 하드웨어 가속을 확인하세요.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    const gl = renderer.getContext(),
      info = gl.getExtension("WEBGL_debug_renderer_info");
    const software = info
      ? /swiftshader|llvmpipe|software/i.test(
          gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
        )
      : false;
    renderer.shadowMap.enabled = !software;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor("#19251f");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.setAttribute(
      "aria-label",
      "3D 사족보행 로봇 시뮬레이션",
    );
    renderer.domElement.style.touchAction = "none";
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#19251f", 14, 55);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 180),
      controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.minDistance = 0.7;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI * 0.48;
    scene.add(new THREE.HemisphereLight("#e2eee6", "#47513c", 2.2));
    const sun = new THREE.DirectionalLight("#fff3d3", 3.3);
    sun.position.set(3, 7, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    sun.shadow.camera.left = -4;
    sun.shadow.camera.right = 4;
    sun.shadow.camera.top = 4;
    sun.shadow.camera.bottom = -4;
    sun.shadow.normalBias = 0.015;
    scene.add(sun);
    const groundCanvas = document.createElement("canvas");
    groundCanvas.width = 128;
    groundCanvas.height = 128;
    const groundContext = groundCanvas.getContext("2d")!;
    groundContext.fillStyle = "#263b2c";
    groundContext.fillRect(0, 0, 128, 128);
    groundContext.fillStyle = "#2b4130";
    groundContext.fillRect(0, 0, 64, 64);
    groundContext.fillRect(64, 64, 64, 64);
    groundContext.strokeStyle = "#435b3d";
    groundContext.lineWidth = 2;
    groundContext.strokeRect(0, 0, 128, 128);
    const groundMap = new THREE.CanvasTexture(groundCanvas);
    groundMap.wrapS = groundMap.wrapT = THREE.RepeatWrapping;
    groundMap.repeat.set(1000, 1000);
    groundMap.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: groundMap,
        roughness: 0.95,
        metalness: 0.02,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.position.y = -0.001;
    scene.add(floor);
    const grid = new THREE.GridHelper(100, 100, "#536749", "#384d35");
    grid.position.y = 0.005;
    scene.add(grid);
    const models = snapshot.robots.map((robot, i) => {
      const m = createRobot(
        snapshot.config,
        robot.champion ? "#ddb96f" : palette[i % palette.length],
      );
      m.model.userData.robotId = robot.id;
      scene.add(m.model);
      return m;
    });
    const ghostModel = createRobot(snapshot.config, "#d1eee3", true);
    scene.add(ghostModel.model);
    const selectionOutlines = models.map(() => {
      const helper = new THREE.Box3Helper(
        new THREE.Box3(),
        new THREE.Color("#dbf6a3"),
      );
      scene.add(helper);
      return helper;
    });
    // One WebGL context, with a viewport for each simultaneously simulated robot.
    // Cameras follow the actual body; no body positions or scores are normalized.
    const layout = () => {
      const count = current.current.snapshot.robots.length;
      const columns = Math.min(
        count,
        element.clientWidth < 500 ? 4 : Math.ceil(Math.sqrt(count * 1.25)),
      );
      return { columns, rows: Math.ceil(count / columns) };
    };
    const cell = (i: number) => {
      const { columns, rows } = layout();
      const left = Math.round(((i % columns) * element.clientWidth) / columns),
        right = Math.round(
          (((i % columns) + 1) * element.clientWidth) / columns,
        ),
        top = Math.round(
          (Math.floor(i / columns) * element.clientHeight) / rows,
        ),
        bottom = Math.round(
          ((Math.floor(i / columns) + 1) * element.clientHeight) / rows,
        );
      return { x: left, y: top, w: right - left, h: bottom - top };
    };
    let previousSelection = "";
    let dirty = true,
      previousMode = "",
      previousFocus = -1,
      previousTick = -1,
      previousGeneration = -1,
      lastZoom = 0,
      frameId = 0,
      lastRender = 0,
      drag: null | { x: number; y: number } = null;
    const resize = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const change = () => {
      dirty = true;
    };
    controls.addEventListener("change", change);
    const point = (event: PointerEvent) => {
      const b = renderer.domElement.getBoundingClientRect();
      return { x: event.clientX - b.left, y: event.clientY - b.top };
    };
    const down = (event: PointerEvent) => {
      if (current.current.snapshot.phase !== "selection" || event.button !== 0)
        return;
      drag = point(event);
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const p = point(event);
      setRect({
        x: Math.min(p.x, drag.x),
        y: Math.min(p.y, drag.y),
        w: Math.abs(p.x - drag.x),
        h: Math.abs(p.y - drag.y),
      });
    };
    const up = (event: PointerEvent) => {
      if (!drag) return;
      const p = point(event),
        start = drag;
      drag = null;
      controls.enabled = modeRef.current !== "all";
      setRect(null);
      const { snapshot: s, onSelect: select } = current.current;
      if (modeRef.current === "all") {
        const click = Math.hypot(p.x - start.x, p.y - start.y) < 5;
        const ids = s.robots
          .filter((_, i) => {
            const c = cell(i);
            return click
              ? p.x >= c.x && p.x < c.x + c.w && p.y >= c.y && p.y < c.y + c.h
              : c.x < Math.max(p.x, start.x) &&
                  c.x + c.w > Math.min(p.x, start.x) &&
                  c.y < Math.max(p.y, start.y) &&
                  c.y + c.h > Math.min(p.y, start.y);
          })
          .map((r) => r.id);
        select(
          click && ids[0] && s.selected.includes(ids[0])
            ? s.selected.filter((id) => id !== ids[0])
            : [...new Set([...s.selected, ...ids])],
        );
        return;
      }
      if (Math.hypot(p.x - start.x, p.y - start.y) < 5) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            (p.x / element.clientWidth) * 2 - 1,
            (-p.y / element.clientHeight) * 2 + 1,
          ),
          camera,
        );
        const hits = ray.intersectObjects(
          models.filter((m) => m.model.visible).map((m) => m.model),
          true,
        );
        if (hits[0]) {
          let object: THREE.Object3D | null = hits[0].object;
          while (object && !object.userData.robotId) object = object.parent;
          const id = object?.userData.robotId;
          if (id)
            select(
              s.selected.includes(id)
                ? s.selected.filter((n) => n !== id)
                : [...s.selected, id],
            );
        }
      } else {
        const left = Math.min(p.x, start.x),
          right = Math.max(p.x, start.x),
          top = Math.min(p.y, start.y),
          bottom = Math.max(p.y, start.y),
          ids: number[] = [];
        models.forEach((m, i) => {
          if (!m.model.visible) return;
          const box = new THREE.Box3().setFromObject(m.model),
            points = [];
          for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
              for (const z of [box.min.z, box.max.z]) {
                const v = new THREE.Vector3(x, y, z).project(camera);
                points.push({
                  x: ((v.x + 1) / 2) * element.clientWidth,
                  y: ((1 - v.y) / 2) * element.clientHeight,
                });
              }
          if (
            Math.min(...points.map((p) => p.x)) <= right &&
            Math.max(...points.map((p) => p.x)) >= left &&
            Math.min(...points.map((p) => p.y)) <= bottom &&
            Math.max(...points.map((p) => p.y)) >= top
          )
            ids.push(s.robots[i].id);
        });
        select([...new Set([...s.selected, ...ids])]);
      }
    };
    renderer.domElement.addEventListener("pointerdown", down, true);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("contextmenu", (e) =>
      e.preventDefault(),
    );
    function animate(now: number) {
      frameId = requestAnimationFrame(animate);
      if (now - lastRender < 66) return;
      lastRender = now;
      const { snapshot: s, ghost: g, zoom: z } = current.current,
        overview = modeRef.current === "all",
        index = Math.max(
          0,
          s.robots.findIndex((r) => r.id === focusRef.current),
        ),
        body = s.robots[index].frame.bodies[0];
      const reset =
        previousMode !== modeRef.current ||
        (!overview && previousFocus !== index) ||
        previousGeneration !== s.generation ||
        lastZoom !== z;
      if (reset) {
        controls.enabled = !overview;
        if (!overview) {
          camera.aspect = element.clientWidth / element.clientHeight;
          controls.target.set(body.x, 0.22, body.z);
          camera.position.set(body.x + 1.1, 0.95, body.z + 1.35);
        }
        camera.zoom = z;
        camera.updateProjectionMatrix();
        controls.update();
        dirty = true;
      } else if (!overview && s.phase === "running") {
        const delta = new THREE.Vector3(body.x, 0.22, body.z).sub(
          controls.target,
        );
        camera.position.add(delta);
        controls.target.add(delta);
        controls.update();
      }
      const selectionKey =
        s.selected.join(",") +
        ":" +
        (g?.generation ?? 0) +
        ":" +
        (g?.robotId ?? 0);
      if (previousSelection !== selectionKey) {
        dirty = true;
        previousSelection = selectionKey;
      }
      models.forEach((m, i) => {
        if (!s.robots[i]) {
          m.model.visible = false;
          return;
        }
        m.model.visible = overview || i === index;
        m.model.position.z = 0;
        m.shell.color.set(
          s.robots[i].champion ? "#ddb96f" : palette[i % palette.length],
        );
        m.update(s.robots[i].frame);
        selectionOutlines[i].visible =
          !overview && m.model.visible && s.selected.includes(s.robots[i].id);
        if (selectionOutlines[i].visible)
          selectionOutlines[i].box.setFromObject(m.model);
      });
      ghostModel.model.visible = !!g && !overview;
      if (g) ghostModel.update(ghostFrame(g, s.robots[index].frame.tick));
      sun.target.position.set(body.x, 0, body.z);
      scene.add(sun.target);
      sun.position.set(body.x + 3, 7, body.z + 4);
      if (dirty || s.tick !== previousTick || reset) {
        renderer.shadowMap.enabled = !overview && !software;
        if (overview) {
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, element.clientWidth, element.clientHeight);
          renderer.clear();
          renderer.setScissorTest(true);
          models.forEach((m) => {
            m.model.visible = false;
          });
          models.forEach((m, i) => {
            const c = cell(i),
              torso = s.robots[i].frame.bodies[0];
            renderer.setViewport(
              c.x,
              element.clientHeight - c.y - c.h,
              c.w,
              c.h,
            );
            renderer.setScissor(
              c.x,
              element.clientHeight - c.y - c.h,
              c.w,
              c.h,
            );
            camera.aspect = c.w / c.h;
            camera.position.set(torso.x + 1.15, 0.95, torso.z + 1.35);
            camera.lookAt(torso.x, 0.22, torso.z);
            camera.updateProjectionMatrix();
            m.model.visible = true;
            renderer.render(scene, camera);
            m.model.visible = false;
          });
          renderer.domElement.dataset.renderedRobots = String(models.length);
        } else {
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, element.clientWidth, element.clientHeight);
          renderer.render(scene, camera);
          renderer.domElement.dataset.renderedRobots = "1";
        }
        dirty = false;
      }
      previousTick = s.tick;
      previousGeneration = s.generation;
      previousMode = modeRef.current;
      previousFocus = index;
      lastZoom = z;
    }
    frameId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          const materials = Array.isArray(o.material)
            ? o.material
            : [o.material];
          materials.forEach((m) => m.dispose());
        }
      });
      groundMap.dispose();
      renderer.dispose();
      element.replaceChildren();
    };
  }, [key]);
  const robot =
      snapshot.robots.find((r) => r.id === focusRef.current) ??
      snapshot.robots[0],
    feet = robot.frame.feet;
  return (
    <div
      className={
        "scene3d " + (mode === "all" ? "population-mode" : "detail-mode")
      }
    >
      <div className="view-controls">
        <div>
          <button
            aria-pressed={mode === "detail"}
            className={mode === "detail" ? "active" : ""}
            onClick={() => setMode("detail")}
          >
            개체 상세
          </button>
          <button
            aria-pressed={mode === "all"}
            className={mode === "all" ? "active" : ""}
            onClick={() => setMode("all")}
          >
            전체 동시 보기
          </button>
        </div>
        <label>
          관찰 로봇{" "}
          <select
            aria-label="관찰 로봇"
            value={focus}
            onChange={(e) => setFocus(Number(e.target.value))}
          >
            <option value={0}>현재 선두</option>
            {snapshot.robots.map((r) => (
              <option key={r.id} value={r.id}>
                {String(r.id).padStart(2, "0")}
                {r.champion ? " ★" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="viewport3d">
        <div className="gl-surface" ref={host} />
        {mode === "all" && (
          <div
            className="population-overlay"
            style={
              {
                "--population-columns": Math.min(
                  snapshot.robots.length,
                  Math.ceil(Math.sqrt(snapshot.robots.length * 1.25)),
                ),
                "--population-mobile-columns": Math.min(
                  snapshot.robots.length,
                  4,
                ),
              } as CSSProperties
            }
          >
            {snapshot.robots.map((r) => (
              <div
                key={r.id}
                data-robot-id={r.id}
                data-outcome={r.outcome}
                className={
                  "population-tile " +
                  (snapshot.selected.includes(r.id) ? "chosen " : "") +
                  (r.champion ? "elite " : "") +
                  (r.outcome !== "active" ? "ended" : "")
                }
                title={`${lineage(r)} · ${r.outcome === "active" ? "생존" : "종료"} ${r.elapsed.toFixed(3)}s`}
              >
                <div className="tile-heading">
                  <strong>
                    {r.champion ? "★ " : ""}
                    {String(r.id).padStart(2, "0")}
                  </strong>
                  <span>
                    {r.outcome === "active" ? "" : "종료 "}
                    {r.elapsed.toFixed(3)}s
                  </span>
                </div>
                <footer className="tile-footer">
                  <small>
                    {!r.parents.length
                      ? r.immigrant
                        ? "새 무작위 탐색"
                        : "무작위 신경망"
                      : r.champion
                        ? "우승 유전자 보존"
                        : `부모 ${r.parents.join("+")} · ${r.birth ? r.birth.changedGenes.length + "개 변형" : "이전 기록"}`}
                  </small>
                  <small className="tile-performance">
                    {r.outcome === "jumped"
                      ? "점프 종료"
                      : r.outcome === "fallen"
                        ? "넘어짐"
                        : r.outcome === "active"
                          ? "평가 중"
                          : "평가 종료"}{" "}
                    · 지지 {r.frame.gait.supportTime.toFixed(2)}s
                  </small>
                </footer>
              </div>
            ))}
          </div>
        )}
        {mode === "detail" && robot.outcome !== "active" && (
          <div className="ended-filter" aria-hidden="true" />
        )}
        {failure && (
          <div role="alert" className="webgl-error">
            {failure}
          </div>
        )}
        {rect && (
          <div
            className="selection-box"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        )}
        {mode === "detail" && (
          <div className="view-hint">
            {snapshot.phase === "selection"
              ? "클릭 선택 · 드래그 다중 선택 · 우클릭 이동"
              : "드래그 회전 · 휠 확대 · 우클릭 이동"}
          </div>
        )}
        {mode === "detail" && (
          <span
            className={
              "walking-badge " + (robot.frame.gait.walking ? "verified" : "")
            }
          >
            {robot.outcome === "jumped"
              ? "장기 체공 · 점프 종료"
              : robot.outcome === "fallen"
                ? "넘어짐 · 다음 세대에서 변형"
                : robot.frame.gait.walking
                  ? "보행 확인"
                  : robot.frame.gait.steps.every((n) => n > 0)
                    ? "접지·지지 확인 중"
                    : "발 들기·착지 학습 중"}
          </span>
        )}
      </div>
      <div className="population-caption">
        {mode === "all"
          ? `${snapshot.robots.length}대 동시 평가 · 회색은 평가 종료 · 접지·발 옮김·전진 점수로 부모 선택`
          : `로봇 ${robot.id} · ${lineage(robot)} · 고스트는 상세 화면에서 비교`}
      </div>
      <GenomeInspector robot={robot} />
      <div className="foot-phases">
        {feet.map((f, i) => (
          <div key={i} className={f.contact ? "stance" : "swing"}>
            <span>{["앞 왼발", "앞 오른발", "뒤 왼발", "뒤 오른발"][i]}</span>
            <b>
              {f.contact
                ? "지면 지지"
                : f.clearance > 0.02
                  ? "발 들어 이동"
                  : "접지 대기"}
            </b>
            <small>
              {(f.clearance * 100).toFixed(1)}cm · {robot.frame.gait.steps[i]}
              걸음
            </small>
          </div>
        ))}
      </div>
      <div className="gait-readout reward-readout">
        <span>
          접지 전진 <b>{robot.frame.gait.groundedForward.toFixed(3)}m</b>
        </span>
        <span>
          체공 <b>{robot.frame.gait.airTime.toFixed(3)}s</b>
        </span>
        <span>
          보행 점수 <b>{(robot.fitness * 1000).toFixed(1)}</b>
        </span>
      </div>
      <div className="gait-readout">
        <span>
          발로 지지한 시간 <b>{robot.frame.gait.supportTime.toFixed(2)}s</b>
        </span>
        <span>
          인정 거리 <b>{robot.frame.distance.toFixed(3)}m</b>
        </span>
        <span>
          전체 이동 <b>{robot.frame.gait.rawDistance.toFixed(3)}m</b>
        </span>
        <span>
          접지 미끄러짐 <b>{robot.frame.gait.slip.toFixed(2)}m/s</b>
        </span>
      </div>
    </div>
  );
}
