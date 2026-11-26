// First-person walkthrough of a plan. Loaded only when it is opened, so the 2D editor does not carry three.js.
// Scene axes: plan x -> x, plan y -> z, height -> y. One unit is one centimetre.
import * as THREE from "../../vendor/three-0.180.0/three.module.min.js";
import { planBox, roomBox } from "../plan.js";
import { FURNITURE_HEIGHT, HEIGHT, startPoint, walk, wallSolids } from "../plan3d.js";

const SPEED = 220; // cm per second
const TURN = 1.8; // radians per second
const LOOK = 0.004; // radians per dragged pixel
const MAX_PITCH = 1.2;
// Physical key codes, so walking also works with a Hebrew (or any other) keyboard layout.
const KEYS = {
  KeyW: "forward", ArrowUp: "forward", KeyS: "back", ArrowDown: "back",
  KeyA: "left", KeyD: "right", ArrowLeft: "turnLeft", ArrowRight: "turnRight",
};

function buildScene(plan, solids) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe7ec);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb5b0a6, 2.8));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(cube);
  const paint = (color, extra) => new THREE.MeshLambertMaterial({ color, ...extra });
  const materials = {
    wall: paint(0xf1ede4),
    glass: paint(0x8fb8cc, { transparent: true, opacity: 0.35, depthWrite: false }),
    furniture: paint(0xb9a58e),
    ground: paint(0xa9a79f),
    floor: paint(0xd8c7ab),
    edge: new THREE.LineBasicMaterial({ color: 0x55534e }),
  };

  // A box standing on the plan: centre (x, y), turned by `angle` clockwise as seen on the 2D plan.
  const addBox = (material, { x, y, angle, length, thickness, z0, z1 }, outline) => {
    const mesh = new THREE.Mesh(cube, material);
    mesh.scale.set(length, z1 - z0, thickness);
    mesh.position.set(x, (z0 + z1) / 2, y);
    mesh.rotation.y = -angle;
    if (outline) mesh.add(new THREE.LineSegments(edges, materials.edge));
    scene.add(mesh);
  };

  const floor = (material, box, top) =>
    addBox(material, { x: box.x + box.w / 2, y: box.y + box.h / 2, angle: 0, length: box.w, thickness: box.h, z0: top - 1, z1: top });
  const all = planBox(plan);
  floor(materials.ground, { x: all.x - 2000, y: all.y - 2000, w: all.w + 4000, h: all.h + 4000 }, -1);
  // Rooms can overlap, so each floor sits a hair higher than the last to avoid flickering.
  plan.rooms.forEach((room, i) => {
    const box = roomBox(plan, room.id);
    if (box) floor(materials.floor, box, i * 0.01);
  });

  for (const solid of solids) addBox(materials[solid.kind], solid, solid.kind === "wall");
  for (const item of plan.furniture) {
    addBox(materials.furniture, {
      x: item.x, y: item.y, angle: (item.rotation * Math.PI) / 180,
      length: item.w, thickness: item.d, z0: 0, z1: FURNITURE_HEIGHT[item.type] ?? 75,
    }, true);
  }

  const dispose = () => [cube, edges, ...Object.values(materials)].forEach((resource) => resource.dispose());
  return { scene, dispose };
}

// Shows the walkthrough inside `root` and returns the function that closes it. Throws when WebGL is unavailable.
export function startWalk(root, plan, onExit) {
  const solids = wallSolids(plan); // first, so a plan that is refused leaves no renderer behind
  // A fresh canvas every time: a released WebGL context cannot be reused.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", "3D view. W and S or up and down arrows walk, A and D step sideways, left and right arrows turn, Escape returns to the 2D plan.");

  const { scene, dispose } = buildScene(plan, solids);
  const camera = new THREE.PerspectiveCamera(70, 1, 2, 100_000);
  camera.rotation.order = "YXZ";
  let position = startPoint(plan);
  let yaw = 0; // 0 looks towards the top of the 2D plan
  let pitch = 0;
  const held = new Map(); // key code or pointer id -> action

  function advance(actions, seconds) {
    const axis = (plus, minus) => Number(actions.has(plus)) - Number(actions.has(minus));
    yaw += axis("turnLeft", "turnRight") * TURN * seconds;
    const forward = axis("forward", "back");
    const side = axis("right", "left");
    const scale = (SPEED * seconds) / (Math.hypot(forward, side) || 1);
    const dx = (side * Math.cos(yaw) - forward * Math.sin(yaw)) * scale;
    const dy = (-side * Math.sin(yaw) - forward * Math.cos(yaw)) * scale;
    if (dx || dy) position = walk(position, { dx, dy }, solids);
  }

  let frame;
  let last = performance.now();
  let size = "";
  let drawn = "";
  function tick(now) {
    // A hidden tab delivers one huge gap; capping it avoids a sudden leap.
    advance(new Set(held.values()), Math.min(Math.max(now - last, 0) / 1000, 0.1));
    last = now;
    const { clientWidth: width, clientHeight: height } = canvas;
    if (width && height && size !== `${width}x${height}`) {
      size = `${width}x${height}`;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    // Redraw only when something changed, so standing still costs no battery.
    const view = `${position.x},${position.y},${yaw},${pitch},${size}`;
    if (view !== drawn) {
      drawn = view;
      camera.position.set(position.x, HEIGHT.eye, position.y);
      camera.rotation.set(pitch, yaw, 0);
      renderer.render(scene, camera);
      // Where the walker stands, for the browser tests.
      canvas.dataset.position = `${Math.round(position.x)},${Math.round(position.y)}`;
    }
    frame = requestAnimationFrame(tick);
  }

  const listeners = new AbortController();
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });

  on(document, "keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest("input, select, textarea, dialog")) return;
    if (event.key === "Escape") onExit();
    else if (KEYS[event.code]) held.set(event.code, KEYS[event.code]);
    else return;
    event.preventDefault();
  });
  on(document, "keyup", (event) => held.delete(event.code));
  on(window, "blur", () => held.clear());

  let drag = null;
  on(canvas, "pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  on(canvas, "pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    yaw += (event.clientX - drag.x) * LOOK;
    pitch = Math.min(Math.max(pitch + (event.clientY - drag.y) * LOOK, -MAX_PITCH), MAX_PITCH);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  for (const type of ["pointerup", "pointercancel"]) on(canvas, type, () => (drag = null));

  for (const button of root.querySelectorAll("[data-move]")) {
    on(button, "pointerdown", (event) => held.set(event.pointerId, button.dataset.move));
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) on(button, type, (event) => held.delete(event.pointerId));
    // Enter or Space on a focused button (detail 0) takes one short step.
    on(button, "click", (event) => event.detail === 0 && advance(new Set([button.dataset.move]), 0.25));
    on(button, "contextmenu", (event) => event.preventDefault()); // long press on touch screens
  }

  root.prepend(canvas);
  frame = requestAnimationFrame(tick);
  canvas.focus({ preventScroll: true });

  return () => {
    cancelAnimationFrame(frame);
    listeners.abort();
    dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
