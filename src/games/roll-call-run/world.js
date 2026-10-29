// ROLL CALL RUN: the 3D yard, the HUD and the sound, ported from the prototype (roll-call-run-prototype.html) with as
// few changes as possible. Plain JavaScript on purpose (the prototype's code, unchanged where it can be).
//
// What changed from the prototype: the run is the server's. This module never decides what a package holds, never keeps
// the score and never ends a run on its own. Walking and looking stay here; SEARCH, PLACE and FINISH become inputs
// (hooks.search / hooks.place / hooks.finish), and everything a run shows (packages opened, names carried and placed,
// powers and their timers, the end) is read from the state the server sends (world.show). The start, how-to and end
// screens are the arcade shell's.
import * as THREE from 'three';
import { SPOTS as CORE_SPOTS, AT_WALL, NAME, OBJECT } from './core.js';
import { nameOf, wallIsLive } from '../../shell/wall-data.js';
import { PORTRAITS } from '../../generated/portraits.js';
import napkinUrl from '../../assets/rcr/napkin.webp';
import dragonUrl from '../../assets/rcr/dragon.webp';
import jpegUrl from '../../assets/rcr/jpeg-frens.jpg';
import css from './world-css.js';

const TICK_SEC = 0.05;
const HTML = `
<div class="rcr-view" id="view"></div>
<div class="hud" id="hud" hidden>
  <div class="tag"><span class="lab">Returned</span><span class="big" id="found">0/8</span></div>
  <span class="practice" id="practiceTag" hidden>Practice · free · not recorded</span>
  <div class="tag" style="text-align:right"><span class="lab">Time</span><span class="big" id="time">0:00</span></div>
</div>
<button class="finish" id="finish" type="button" hidden>FINISH HERE</button>
<button class="mute" id="mute" type="button" hidden aria-label="Sound on" aria-pressed="false">♪ ON</button>
<div class="carry" id="carry" hidden>
  <svg class="arrow" id="arrow" viewBox="0 0 34 34" aria-hidden="true"><path d="M17 3 L29 29 L17 22 L5 29 Z" fill="#2E7FD6" stroke="#F2F0EB" stroke-width="2"/></svg>
  <span class="name" id="carryName"></span>
  <span class="hint" id="carryHint"></span>
</div>
<div class="toast" id="toast" hidden></div>
<div class="find" id="find" hidden><canvas id="findArt" width="1200" height="760" hidden></canvas><b id="findName"></b><span id="findFx"></span></div>
<div class="fxbar" id="fxbar"></div>
<div class="dim" id="dim" hidden></div>
<div class="stick" id="stick" hidden><i id="knob"></i></div>
<div class="help" id="help" hidden></div>
<button class="act" id="act" type="button" hidden disabled>SEARCH</button>
<canvas class="compass" id="compass" hidden aria-label="Compass"></canvas>
<div class="howdim" id="howdim" hidden></div>
<div class="howto" id="howto" hidden>
  <div id="callouts"></div>
  <div class="howcard" role="dialog" aria-labelledby="howTitle">
    <span class="eyebrow">How to play</span>
    <h2 id="howTitle">FIND 8 NAMES.<br>BRING THEM HOME.</h2>
    <p>Open packages around the Unicorn Factory to find the missing names, then place them back ON THE WALL.</p>
    <p class="howclock">Your time starts when you press START.</p>
    <button class="btn" id="begin" type="button">START</button>
  </div>
</div>`;
/** A touch screen (phone, tablet) gets the drag zones; a mouse and keyboard get WASD and the mouse. */
const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();

/** Builds the yard inside `host`. hooks: { search(spot), place(), finish(), canAct() }. Returns the world API (end of file). */
export function createWorld(host, hooks) {
host.classList.add('rcr');
host.insertAdjacentHTML('beforeend', HTML);
if (!document.getElementById('rcr-style')) { const st = document.createElement('style'); st.id = 'rcr-style'; st.textContent = css; document.head.appendChild(st); }
// slot index 0..499 -> name (live wall data, snapshot first); undefined for a panel nobody has bought (drawn dark)
host.querySelector('#help').textContent = TOUCH ? 'Drag left to walk · drag right to look · tap SEARCH' : 'WASD or arrows to walk · move the mouse to look, rest it at an edge to keep turning · Enter, E or Space to search';
const NAME_AT = { get: (slot) => { const name = nameOf(slot + 1); return name ? name.toUpperCase() : undefined; } };

/* ---------------- display constants (the rules themselves live in core.ts, run by the server) ---------------- */
const RULES = { hidden: 8, searchSec: 0.8, reach: 4, speed: 9 };   // you can search a package from 4 m away

/* ---------------- three.js scene ---------------- */
const view = host.querySelector('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
/* ---------------- the sky: the hue of the dragon's microphone (#CC0A5E, sampled from the art), with generative
   clouds made of triangles that drift, swell and dissolve. One shader on an inverted sphere that follows the camera. ---------------- */
const MIC = new THREE.Color(0xcc0a5e);
const HORIZON = new THREE.Color(0xf2a6c8);
scene.background = HORIZON.clone();
scene.fog = new THREE.Fog(0xe98fb8, 45, 170);
const skyUniforms = { uTime: { value: 0 }, uZenith: { value: MIC.clone() }, uHorizon: { value: HORIZON.clone() } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
  uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform float uTime; uniform vec3 uZenith; uniform vec3 uHorizon; varying vec3 vDir;
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y, -1.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.85, h), 0.7));
      gl_FragColor = vec4(col, 1.0);
    }`
}));
sky.renderOrder = -1; scene.add(sky);
/* The ceiling is a snow globe: a glass dome over the whole yard, and inside it clouds of triangles of many sizes,
   carried by different air patterns. The air is a blend of fields: a slow stir around the globe's axis, chaotic ABC
   flow (divergence-free, so it reads as moving air), a rising-and-falling convection roll, and two wandering eddies.
   Each region of the dome leans on a different field, so the flocks drift, roll, swirl and tumble differently. */
const GLOBE = { x: -6, z: 17, r: 128, floor: 34 };
const globe = (() => {
  // the glass: a fresnel shell, nearly invisible face-on and bright at the rim, plus a band where it meets the ground
  const glass = new THREE.Mesh(new THREE.SphereGeometry(GLOBE.r, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uTint: { value: new THREE.Color(0xffe6f1) } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main() { vec4 w = modelMatrix * vec4(position, 1.0);
      vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uTint; varying vec3 vN; varying vec3 vV; void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
      float glint = pow(max(dot(reflect(-normalize(vV), normalize(vN)), normalize(vec3(-0.4, 0.8, 0.45))), 0.0), 60.0);
      gl_FragColor = vec4(uTint, clamp(0.04 + f * 0.55 + glint * 0.8, 0.0, 0.85)); }`
  }));
  glass.position.set(GLOBE.x, 0, GLOBE.z); glass.renderOrder = 2; scene.add(glass);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(GLOBE.r + 1.5, GLOBE.r + 1.5, 1.2, 96, 1, true), new THREE.MeshLambertMaterial({ color: 0x0b0b0b, side: THREE.DoubleSide }));
  band.position.set(GLOBE.x, 0.6, GLOBE.z); scene.add(band);

  // the triangle flakes: one instanced mesh, sizes on a power law (many small, a few huge)
  const COUNT = 900, rnd = mulberry32(527);
  const triGeo = new THREE.BufferGeometry();
  triGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.62, 0, -0.54, -0.31, 0, 0.54, -0.31, 0], 3));
  triGeo.computeVertexNormals();
  const flakes = new THREE.InstancedMesh(triGeo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, fog: false, emissive: 0x7a0638 }), COUNT);   // undersides glow pink instead of going dark
  flakes.frustumCulled = false; flakes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const F = [];
  const tint = new THREE.Color(), pale = new THREE.Color(0xfff0f6);
  for (let i = 0; i < COUNT; i++) {
    const u = rnd(), size = 0.7 + 11 * Math.pow(u, 4.2);              // 0.7 m flakes up to 12 m sails
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (GLOBE.r - 14);
    const y = GLOBE.floor + rnd() * 70;
    F.push({ x: GLOBE.x + Math.cos(a) * rr, y, z: GLOBE.z + Math.sin(a) * rr, size, spin: new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3), w: [(rnd() - .5) * 1.2, (rnd() - .5) * 1.2, (rnd() - .5) * 1.2], drag: 0.6 + 0.8 * rnd() / (0.5 + size * 0.15) });
    tint.copy(MIC).lerp(pale, 0.15 + 0.75 * rnd() * rnd()); if (rnd() < 0.08) tint.set(0xffffff);
    flakes.setColorAt(i, tint);
  }
  scene.add(flakes);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  function air(x, y, z, t, out) {
    const lx = x - GLOBE.x, lz = z - GLOBE.z, ang = Math.atan2(lz, lx), rad = Math.hypot(lx, lz) + 1e-3;
    // region weights: four sectors around the globe, each with its own dominant pattern, slowly rotating
    const sec = ang + t * 0.03;
    const wStir = 0.5 + 0.5 * Math.cos(sec), wAbc = 0.5 + 0.5 * Math.cos(sec - 1.6), wRoll = 0.5 + 0.5 * Math.cos(sec - 3.2), wEddy = 0.5 + 0.5 * Math.cos(sec - 4.7);
    let vx = 0, vy = 0, vz = 0;
    // 1. the stir: tangential, faster high up
    const sp = (2.2 + 0.05 * (y - GLOBE.floor)) * wStir;
    vx += -lz / rad * sp; vz += lx / rad * sp;
    // 2. ABC flow at 30 m scale
    const k = 0.07, A = 2.4, B = 1.8, C = 1.3;
    vx += wAbc * (A * Math.sin(k * z + t * 0.2) + C * Math.cos(k * y)); vy += wAbc * 0.6 * (B * Math.sin(k * x) + A * Math.cos(k * z + t * 0.2)); vz += wAbc * (C * Math.sin(k * y) + B * Math.cos(k * x - t * 0.15));
    // 3. convection roll: rises at the centre, spills out along the top, sinks at the glass
    const h = (y - GLOBE.floor) / 70 - 0.5, rn = rad / (GLOBE.r - 14) - 0.5;
    vx += wRoll * 3.0 * h * (lx / rad); vz += wRoll * 3.0 * h * (lz / rad); vy += wRoll * -3.0 * rn;
    // 4. two eddies wandering around the dome, spinning opposite ways
    for (let e = 0; e < 2; e++) {
      const ea = t * (e ? -0.05 : 0.04) + e * 3.1, ex = GLOBE.x + Math.cos(ea) * 55, ez = GLOBE.z + Math.sin(ea) * 55;
      const dx = x - ex, dz = z - ez, d2 = dx * dx + dz * dz, s = (e ? -1 : 1) * 260 / (d2 + 300);
      vx += wEddy * -dz * s * 0.12; vz += wEddy * dx * s * 0.12; vy += wEddy * Math.sin(t * 0.3 + e) * 0.8;
    }
    out.set(vx, vy, vz); return out;
  }
  const vel = new THREE.Vector3();
  function step(t, dt) {
    for (let i = 0; i < COUNT; i++) {
      const f = F[i];
      air(f.x, f.y, f.z, t, vel);
      f.x += vel.x * f.drag * dt; f.y += vel.y * f.drag * dt; f.z += vel.z * f.drag * dt;
      // stay inside the glass and above the roofs: soft walls, then wrap the stragglers back in
      const lx = f.x - GLOBE.x, lz = f.z - GLOBE.z, ly = f.y, dist = Math.sqrt(lx * lx + lz * lz + ly * ly), lim = GLOBE.r - 6 - f.size;
      if (dist > lim) { const k = lim / dist; f.x = GLOBE.x + lx * k; f.y = ly * k; f.z = GLOBE.z + lz * k; }
      if (f.y < GLOBE.floor) f.y += (GLOBE.floor - f.y) * Math.min(1, dt * 2);
      f.spin.x += f.w[0] * dt; f.spin.y += f.w[1] * dt; f.spin.z += f.w[2] * dt;
      q.setFromEuler(f.spin); sc.setScalar(f.size); pv.set(f.x, f.y, f.z);
      flakes.setMatrixAt(i, m4.compose(pv, q, sc));
    }
    flakes.instanceMatrix.needsUpdate = true;
  }
  return { step };
})();
/* Confetti: when a hiding spot gives up a name, the object bursts. Paper rectangles and little triangles in the
   microphone magenta, the arcade blue, chalk and a flour-sack gold; they pop up, tumble, flutter and settle. */
const confetti = (() => {
  const MAX = 480, rnd = Math.random;
  const geo = new THREE.PlaneGeometry(0.14, 0.09);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX);
  mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh);
  const P = Array.from({ length: MAX }, () => ({ life: 0 }));
  const colors = [0xcc0a5e, 0x2e7fd6, 0xf2f0eb, 0xe8b60f, 0xff6fae], col = new THREE.Color();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) { mesh.setMatrixAt(i, hide); mesh.setColorAt(i, col.set(colors[i % colors.length])); }
  let next = 0;
  function burst(x, y, z, n = 160) {
    for (let k = 0; k < n; k++) {
      const p = P[next]; next = (next + 1) % MAX;
      const a = rnd() * Math.PI * 2, up = 5 + rnd() * 6, out = 1 + rnd() * 3.2;
      Object.assign(p, { x, y, z, vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, rx: rnd() * 6, ry: rnd() * 6, rz: rnd() * 6,
        wx: (rnd() - .5) * 14, wy: (rnd() - .5) * 14, wz: (rnd() - .5) * 14, life: 4 + rnd() * 2.5, s: 0.7 + rnd() * 0.8, ph: rnd() * 6 });
      mesh.setColorAt((next + MAX - 1) % MAX, col.set(colors[Math.floor(rnd() * colors.length)]));
    }
    mesh.instanceColor.needsUpdate = true;
  }
  function step(dt, t) {
    let any = false;
    for (let i = 0; i < MAX; i++) {
      const p = P[i];
      if (p.life <= 0) continue;
      any = true; p.life -= dt;
      if (p.y > 0.02) {
        // gravity, strong air drag, and a sideways flutter once they start to fall
        p.vy -= 9.8 * dt; p.vx *= 1 - 1.6 * dt; p.vz *= 1 - 1.6 * dt; p.vy *= 1 - 1.2 * dt;
        if (p.vy < -1.6) p.vy = -1.6;
        const flutter = p.vy < 0 ? 1 : 0;
        p.x += (p.vx + flutter * Math.sin(t * 6 + p.ph) * 0.9) * dt; p.z += (p.vz + flutter * Math.cos(t * 5 + p.ph) * 0.9) * dt; p.y += p.vy * dt;
        p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
      } else { p.y = 0.02; p.rx = Math.PI / 2; p.ry = 0; }      // landed flat on the cobbles
      const fade = Math.min(1, p.life / 0.6);
      q.setFromEuler(e.set(p.rx, p.ry, p.rz)); sc.setScalar(p.s * fade);
      mesh.setMatrixAt(i, p.life > 0 ? m4.compose(v.set(p.x, p.y, p.z), q, sc) : hide);
    }
    if (any) mesh.instanceMatrix.needsUpdate = true;
  }
  function clear() { for (let i = 0; i < MAX; i++) { P[i].life = 0; mesh.setMatrixAt(i, hide); } mesh.instanceMatrix.needsUpdate = true; }
  return { burst, step, clear };
})();
/* Bubbles: a found object lets out a cluster of soap bubbles. Thin-film colours that slide with the viewing angle,
   a bright rim and a highlight; they rise, wobble on the air, and pop. */
const bubbles = (() => {
  const MAX = 1600, rnd = Math.random;
  const uni = { uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal); vV = normalize(cameraPosition - w.xyz); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec3 n = normalize(vN), v = normalize(vV);
        float f = 1.0 - abs(dot(n, v));
        // thin film: the colour depends on how much soap the light passes through, so it shifts with the angle and swirls over time
        float film = f * 2.2 + 0.35 * sin(vW.y * 3.0 + uTime * 1.7) + 0.2 * sin((vW.x + vW.z) * 4.0 - uTime);
        vec3 col = 0.55 + 0.45 * cos(6.2832 * (film + vec3(0.0, 0.33, 0.67)));
        col = mix(col, vec3(1.0, 0.75, 0.88), 0.25);
        float spec = pow(max(dot(reflect(-v, n), normalize(vec3(-0.4, 0.9, 0.3))), 0.0), 40.0);
        float a = 0.06 + pow(f, 2.2) * 0.75 + spec;
        gl_FragColor = vec4(col + spec, clamp(a, 0.0, 0.95));
      }`
  });
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 20, 14), mat, MAX);
  mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh);
  const B = Array.from({ length: MAX }, () => ({ life: 0 }));
  const m4 = new THREE.Matrix4(), hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, hide);
  let next = 0;
  function burst(x, y, z, n = 26) {
    for (let k = 0; k < n; k++) {
      const b = B[next]; next = (next + 1) % MAX;
      const a = rnd() * Math.PI * 2, r = rnd() * 0.5;
      Object.assign(b, { x: x + Math.cos(a) * r, y: y + rnd() * 0.4, z: z + Math.sin(a) * r, r: 0.08 + 0.32 * Math.pow(rnd(), 1.8),
        vy: 0.45 + rnd() * 0.9, vx: Math.cos(a) * (0.3 + rnd() * 0.6), vz: Math.sin(a) * (0.3 + rnd() * 0.6),
        ph: rnd() * 6.3, life: 2.5 + rnd() * 4, age: 0 });
    }
  }
  function step(dt, t) {
    uni.uTime.value = t;
    let any = false;
    for (let i = 0; i < MAX; i++) {
      const b = B[i];
      if (b.life <= 0) continue;
      any = true; b.life -= dt; b.age += dt;
      b.vx *= 1 - 0.8 * dt; b.vz *= 1 - 0.8 * dt;
      b.x += (b.vx + Math.sin(t * 1.3 + b.ph) * 0.25) * dt; b.z += (b.vz + Math.cos(t * 1.1 + b.ph) * 0.25) * dt; b.y += b.vy * dt;
      // grow in from nothing, wobble a little, and swell for an instant before popping
      const grow = Math.min(1, b.age / 0.25), pop = b.life < 0.08 ? 1.35 : 1;
      const s = b.r * grow * pop, wob = 1 + 0.06 * Math.sin(t * 9 + b.ph);
      m4.makeScale(s * wob, s / wob, s * wob).setPosition(b.x, b.y, b.z);
      mesh.setMatrixAt(i, b.life > 0 ? m4 : hide);
    }
    if (any) mesh.instanceMatrix.needsUpdate = true;
  }
  function clear() { for (let i = 0; i < MAX; i++) { B[i].life = 0; mesh.setMatrixAt(i, hide); } mesh.instanceMatrix.needsUpdate = true; }
  return { burst, step, clear };
})();
const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xffe0ee, 0x8a7880, 0.85));
const sun = new THREE.DirectionalLight(0xfff3df, 0.55); sun.position.set(-30, 60, 40); scene.add(sun);

const solids = [];   // XZ boxes the player cannot walk through
const M = (c) => new THREE.MeshLambertMaterial({ color: c });
function box(x0, x1, y0, y1, z0, z1, mat, solid = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  scene.add(m);
  if (solid) solids.push({ x0, x1, z0, z1 });
  return m;
}
function cyl(x, z, r, y0, y1, mat, solid = true, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1 - y0, seg), mat);
  m.position.set(x, (y0 + y1) / 2, z); scene.add(m);
  if (solid) solids.push({ x0: x - r, x1: x + r, z0: z - r, z1: z + r });
  return m;
}
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = 4;
  return t;
}
function noise(g, w, h, n, a) { for (let i = 0; i < n; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * a})`; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 3, 1 + Math.random() * 3); } }

/* ---------------- textures: painted on canvas from the site photos (no photo is copied) ---------------- */
// Every façade is a tile of one structural bay, repeated along the wall: bayW metres wide, bayH metres tall.
function tileCanvas(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; }
function texFrom(canvas, rx, ry) { const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 4; return t; }
const matFrom = (canvas, rx, ry) => new THREE.MeshLambertMaterial({ map: texFrom(canvas, rx, ry) });
function grime(g, w, h, n, a, tint = '0,0,0') {
  for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${tint},${Math.random() * a})`; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 3, 1 + Math.random() * 3); }
}
function streaks(g, w, h, n, a) {   // rain streaks running down from sills and cornices
  for (let i = 0; i < n; i++) { const x = Math.random() * w, y = Math.random() * h * 0.6, len = 20 + Math.random() * h * 0.4; const gr = g.createLinearGradient(0, y, 0, y + len); gr.addColorStop(0, `rgba(30,30,25,${a})`); gr.addColorStop(1, 'rgba(30,30,25,0)'); g.fillStyle = gr; g.fillRect(x, y, 1 + Math.random() * 3, len); }
}
// px per metre inside a tile: tiles are 256 px for one bay of 5 m, so 51.2 px/m
const PXM = 51.2;
function windowAt(g, cx, yTopM, wM, hM, H, frame, glass, mullions = [2, 3]) {
  const x = cx - (wM * PXM) / 2, y = H - yTopM * PXM, w = wM * PXM, h = hM * PXM;
  g.fillStyle = frame; g.fillRect(x - 6, y - 6, w + 12, h + 12);
  g.fillStyle = glass; g.fillRect(x, y, w, h);
  g.strokeStyle = frame; g.lineWidth = 3;
  for (let i = 1; i < mullions[0]; i++) { g.beginPath(); g.moveTo(x + (w * i) / mullions[0], y); g.lineTo(x + (w * i) / mullions[0], y + h); g.stroke(); }
  for (let i = 1; i < mullions[1]; i++) { g.beginPath(); g.moveTo(x, y + (h * i) / mullions[1]); g.lineTo(x + w, y + (h * i) / mullions[1]); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 3, y + 3, w * 0.3, h * 0.25);   // a little sky in the glass
}
// Armazém 0108: oxblood render, grey concrete pilaster per bay, white-framed windows on two floors, grey plinth.
const millFacade = tileCanvas(256, 512, (g, w, h) => {
  g.fillStyle = '#8b3a2f'; g.fillRect(0, 0, w, h); grime(g, w, h, 2600, .12); grime(g, w, h, 600, .08, '255,220,200');
  g.fillStyle = '#a7a39a'; g.fillRect(0, 0, 26, h); grime(g, 26, h, 300, .15);                 // pilaster
  g.fillStyle = '#9e9a91'; g.fillRect(0, h - 1.0 * PXM, w, 1.0 * PXM);                          // plinth
  g.fillStyle = '#8f8b83'; g.fillRect(0, 0, w, 10);                                              // cornice
  g.fillStyle = 'rgba(20,20,20,.55)'; g.fillRect(0, h - 5.1 * PXM, w, 2);                        // the cable along the façade
  windowAt(g, 26 + (w - 26) / 2, 3.5, 1.3, 2.1, h, '#efede6', '#2f3a40');
  windowAt(g, 26 + (w - 26) / 2, 8.7, 1.3, 2.1, h, '#efede6', '#2f3a40');
  streaks(g, w, h, 18, .18);
});
// The Art Factory (flour mill): a tall, skinny concrete block. A beige concrete frame holds stained grey-green infill
// panels, eight storeys of 3.5 m; the two lowest rows were whitewashed. The ends have no windows; the long sides have one
// narrow slit window per panel. Tiles are one bay wide and the full 28 m tall.
const FACTORY_H = 28, FACTORY_ROWS = 8;
function factoryTile(slits) {
  return tileCanvas(256, 1536, (g, w, h) => {
    const rowH = h / FACTORY_ROWS, fr = 14;
    g.fillStyle = '#c3b9a0'; g.fillRect(0, 0, w, h); grime(g, w, h, 3000, .08);
    for (let r = 0; r < FACTORY_ROWS; r++) {
      const y = r * rowH + fr / 2, ph = rowH - fr, x = fr / 2, pw = w - fr;
      const low = r >= FACTORY_ROWS - 2;
      g.fillStyle = low ? '#d8d5cb' : '#8d968b'; g.fillRect(x, y, pw, ph);
      for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(${low ? '60,60,55' : '35,48,38'},${Math.random() * (low ? .06 : .14)})`; g.fillRect(x + Math.random() * pw, y + Math.random() * ph * 0.9, 2, 3 + Math.random() * 22); }
      // dark rain stains under the top of each panel
      const gr = g.createLinearGradient(0, y, 0, y + ph * 0.6); gr.addColorStop(0, low ? 'rgba(40,40,35,.12)' : 'rgba(25,35,28,.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x, y, pw, ph * 0.6);
      if (slits && r < FACTORY_ROWS - 1) { g.fillStyle = '#26303a'; g.fillRect(w - fr - 34, y + ph * 0.18, 18, ph * 0.62); g.fillStyle = '#d4ccb6'; g.fillRect(w - fr - 38, y + ph * 0.8, 26, 4); }
    }
    g.fillStyle = '#a8a294'; g.fillRect(0, h - 24, w, 24);                     // plinth
    streaks(g, w, h, 24, .14);
  });
}
const factorySide = factoryTile(true), factoryEnd = factoryTile(false);
const millInterior = tileCanvas(256, 1536, (g, w, h) => {
  const m = h / FACTORY_H;                                                       // px per metre in this tile
  g.fillStyle = '#e5ddcd'; g.fillRect(0, 0, w, h); grime(g, w, h, 3000, .07);
  g.fillStyle = '#7d8a80'; g.fillRect(0, h - 1.3 * m, w, 1.3 * m);              // painted dado
  g.fillStyle = '#d3cab8'; g.fillRect(0, 0, 18, h);
  g.fillStyle = '#cfc9bc'; g.fillRect(w - 42, h - 4.6 * m, 30, 2.6 * m); g.fillStyle = '#c7dbe6'; g.fillRect(w - 38, h - 4.5 * m, 22, 2.4 * m);   // the slit, from inside
});
// Armazém 0108 and the cream buildings: off-white render, grey pilasters and plinth.
const creamFacade = tileCanvas(256, 512, (g, w, h) => {
  g.fillStyle = '#e9e3d4'; g.fillRect(0, 0, w, h); grime(g, w, h, 2200, .07);
  g.fillStyle = '#cfc8b8'; g.fillRect(0, 0, 24, h);
  g.fillStyle = '#9d998f'; g.fillRect(0, h - 0.9 * PXM, w, 0.9 * PXM);
  windowAt(g, 24 + (w - 24) / 2, 3.4, 1.2, 2.0, h, '#f4f1ea', '#34404a');
  streaks(g, w, h, 12, .12);
});
// The gabled warehouse: terracotta frame around tall white panels, a row of small windows top and bottom.
const pinkFacade = tileCanvas(256, 512, (g, w, h) => {
  g.fillStyle = '#c47e6c'; g.fillRect(0, 0, w, h); grime(g, w, h, 1800, .1);
  g.fillStyle = '#f2efe8'; g.fillRect(30, 1.4 * PXM, w - 52, h - 3.0 * PXM); grime(g, w, h, 300, .05);
  windowAt(g, w / 2, 1.0, 1.0, 0.5, h, '#f2efe8', '#3a454c', [2, 1]);
  windowAt(g, w / 2, 9.4, 1.0, 0.5, h, '#f2efe8', '#3a454c', [2, 1]);
  g.fillStyle = '#efece6'; g.fillRect(0, h - 0.25 * PXM, w, 0.25 * PXM);
});
// The tall grain tower: a concrete frame with stained grey-green infill panels.
const towerFacade = tileCanvas(256, 256, (g, w, h) => {
  g.fillStyle = '#bdb5a0'; g.fillRect(0, 0, w, h);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const x = 10 + c * 123, y = 10 + r * 123; g.fillStyle = '#8c958b'; g.fillRect(x, y, 113, 113);
    grime(g, 113, 113, 0, 0); for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(40,50,40,${Math.random() * .12})`; g.fillRect(x + Math.random() * 113, y + Math.random() * 113, 2, 2 + Math.random() * 16); }
  }
  streaks(g, w, h, 30, .2);
});
// Silo tower: white with the red ladder stripes.
const siloTowerFacade = tileCanvas(256, 512, (g, w, h) => {
  g.fillStyle = '#ebe6da'; g.fillRect(0, 0, w, h); grime(g, w, h, 1500, .06);
  g.fillStyle = '#a83c33'; g.fillRect(96, 0, 10, h); g.fillRect(150, 0, 10, h);
  for (let y = 20; y < h; y += 64) { g.fillStyle = '#e9e4d8'; g.fillRect(108, y, 40, 30); g.fillStyle = '#2f3940'; g.fillRect(114, y + 6, 28, 18); }
});
const siloSkin = tileCanvas(256, 256, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#ddd7c9'); gr.addColorStop(.5, '#f0ebe0'); gr.addColorStop(1, '#d6d0c2');
  g.fillStyle = gr; g.fillRect(0, 0, w, h); grime(g, w, h, 1200, .05); streaks(g, w, h, 10, .08);
});
// Lisbon calçada: small granite setts in staggered rows.
const cobbles = tileCanvas(512, 512, (g, w, h) => {
  g.fillStyle = '#4c4d4f'; g.fillRect(0, 0, w, h);
  const s = 16;
  for (let y = 0; y < h; y += s) for (let x = -s; x < w; x += s) {
    const ox = (y / s) % 2 ? s / 2 : 0, v = 120 + Math.floor(Math.random() * 60);
    g.fillStyle = `rgb(${v},${v + 2},${v + 6})`; g.fillRect(x + ox + 1.5, y + 1.5, s - 3 + Math.random() * 1.5, s - 3 + Math.random() * 1.5);
  }
  grime(g, w, h, 3000, .12);
});
const asphalt = tileCanvas(256, 256, (g, w, h) => { g.fillStyle = '#3d3e40'; g.fillRect(0, 0, w, h); grime(g, w, h, 4000, .25); grime(g, w, h, 1500, .08, '255,255,255'); });
const roofTiles = tileCanvas(256, 256, (g, w, h) => {
  g.fillStyle = '#7e3a26'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { const v = Math.random() * 30; g.fillStyle = `rgb(${160 + v},${80 + v / 2},${55})`; g.beginPath(); g.arc(x + 8 + ((y / 16) % 2) * 8, y + 4, 8, 0, Math.PI); g.fill(); }
  grime(g, w, h, 1500, .15);
});
// 40 ft container skin: vertical corrugation.
function containerSkin(base) {
  return tileCanvas(256, 128, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) { g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x, 0, 5, h); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 9, 0, 3, h); }
    grime(g, w, h, 600, .08);
  });
}
const containerWhite = containerSkin('#e8e7e1');

const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), matFrom(cobbles, 80, 80));
ground.rotation.x = -Math.PI / 2; ground.position.set(-5, 0, 15); scene.add(ground);
const alleyRoad = new THREE.Mesh(new THREE.PlaneGeometry(7, 64), matFrom(asphalt, 3, 24));
alleyRoad.rotation.x = -Math.PI / 2; alleyRoad.position.set(-11, 0.01, -11); scene.add(alleyRoad);

const plaster = matFrom(creamFacade, 1, 1);
const factoryEdge = M(0xc3b9a0), roofMat = matFrom(roofTiles, 10, 10), whiteMat = M(0xf2f0eb), inkMat = M(0x1a1a1a);
const machineMat = M(0x5f7066), brassMat = M(0xb08d4a), ironMat = M(0x2d3134), sackMat = M(0xd9cba8), plainMill = M(0x8b3a2f);
const floorTex = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#8f7a62'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(0,0,0,.25)'; for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } noise(g, w, h, 1500, .15); }, [6, 24]);

// A wall box whose two big faces get façade tiles (outside, inside) repeated per bay; BoxGeometry faces are +x,-x,+y,-y,+z,-z.
function facadeBox(x0, x1, y0, y1, z0, z1, outside, inside, outSign, bayM = 5, solid = true, edge = plainMill) {
  const alongZ = (x1 - x0) < (z1 - z0), len = alongZ ? z1 - z0 : x1 - x0, hgt = y1 - y0;
  const rep = Math.max(1, Math.round(len / bayM));
  const outM = outside.tagName ? matFrom(outside, rep, 1) : outside;
  const inM = inside ? (inside.tagName ? matFrom(inside, rep, 1) : inside) : outM;
  const mats = alongZ ? (outSign > 0 ? [outM, inM, edge, edge, edge, edge] : [inM, outM, edge, edge, edge, edge])
                      : (outSign > 0 ? [edge, edge, edge, edge, outM, inM] : [edge, edge, edge, edge, inM, outM]);
  return box(x0, x1, y0, y1, z0, z1, mats, solid);
}
function solidBlock(x0, x1, y0, y1, z0, z1, facade, bayM = 5, roof = null) {   // a closed building, façade on all four sides
  const lx = x1 - x0, lz = z1 - z0;
  const mx = matFrom(facade, Math.max(1, Math.round(lz / bayM)), 1), mz = matFrom(facade, Math.max(1, Math.round(lx / bayM)), 1);
  const top = roof || M(0x8d877c);
  return box(x0, x1, y0, y1, z0, z1, [mx, mx, top, top, mz, mz]);
}
/* A building you can walk into: four façade walls with door openings, a floor, a ceiling and a roof slab.
   doors: { n, s, e, w } -> lists of door centres along that wall (x for n/s, z for e/w). */
// inside walls: whitewash over a painted dado, a pilaster and a window per bay, so a room reads as a room
const innerWall = tileCanvas(256, 256, (g, w, h) => {
  g.fillStyle = '#e4ddd0'; g.fillRect(0, 0, w, h); grime(g, w, h, 1400, .06);
  g.fillStyle = '#6f7d74'; g.fillRect(0, h * 0.86, w, h * 0.14);
  g.fillStyle = '#d2cab9'; g.fillRect(0, 0, 18, h);
  g.fillStyle = '#c9c2b4'; g.fillRect(w * 0.36 - 5, h * 0.3 - 5, w * 0.36 + 10, h * 0.34 + 10);
  g.fillStyle = '#f3c2d8'; g.fillRect(w * 0.36, h * 0.3, w * 0.36, h * 0.34);          // the pink sky through the glass
  g.strokeStyle = '#c9c2b4'; g.lineWidth = 4; g.beginPath(); g.moveTo(w * 0.54, h * 0.3); g.lineTo(w * 0.54, h * 0.64); g.moveTo(w * 0.36, h * 0.47); g.lineTo(w * 0.72, h * 0.47); g.stroke();
});
const innerFloor = new THREE.MeshLambertMaterial({ map: texFrom(tileCanvas(256, 256, (g, w, h) => { g.fillStyle = '#8f8a80'; g.fillRect(0, 0, w, h); grime(g, w, h, 3000, .12); g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 2; g.strokeRect(0, 0, w, h); }), 12, 12) });
const doorDark = M(0x1c1c1c);
/* A building you can walk into. Each wall is cut into whole structural bays, so the façade texture lines up, and a
   door takes out one whole bay as a loading opening: the façade carries on above it at the right place in the
   pattern, a dark steel frame lines the opening and a roller shutter hangs half-raised at the top.
   doors: { n, s, e, w } -> door centres along that wall (x for n/s, z for e/w); each snaps to the bay it falls in. */
const DOOR = { h: 3.6 };
const shutterTex = tileCanvas(128, 64, (g, w, h) => { g.fillStyle = '#8d9196'; g.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 8) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, y, w, 2); g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, y + 3, w, 1); } });
function partTex(canvas, rep, v0, v1) {             // a slice of a façade tile from height fraction v0 to v1
  const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, v1 - v0); t.offset.set(0, v0); t.anisotropy = 4;
  return new THREE.MeshLambertMaterial({ map: t });
}
function hollow({ x0, x1, z0, z1, h, facade, facades = {}, inside = innerWall, bay = 5, doors = {}, roof = roofMat, ceiling = true, floor = true, base = 0x8d877c, t = 0.3 }) {
  const edge = M(base), frame = M(0x1c1c1c), shutter = new THREE.MeshLambertMaterial({ map: texFrom(shutterTex, 2, 3) });
  const wall = (side) => {
    const fac = facades[side] || facade, alongX = side === 'n' || side === 's';
    const a0 = alongX ? x0 : z0 + t, a1 = alongX ? x1 : z1 - t, len = a1 - a0;   // side walls butt inside the end walls: no shared faces to flicker at the corners
    const want = doors[side] || [];
    const nb = Math.max(want.length ? 3 : 1, Math.round(len / bay)), bl = len / nb;
    const doorBays = new Set(want.map((c) => Math.min(nb - 1, Math.max(0, Math.floor((c - a0) / bl)))));
    const out = side === 'n' || side === 'w' ? -1 : 1;
    // put a box on this wall between p0..p1 along it, y0..y1 high; mats = [outside, inside, edge]
    const put = (p0, p1, y0, y1, outM, inM, solid, inset = 0) => {
      const sideMats = (o, i) => alongX ? (out > 0 ? [edge, edge, edge, edge, o, i] : [edge, edge, edge, edge, i, o]) : (out > 0 ? [o, i, edge, edge, edge, edge] : [i, o, edge, edge, edge, edge]);
      const d0 = inset, d1 = t - inset;
      if (side === 'n') return box(p0, p1, y0, y1, z0 + d0, z0 + d1, sideMats(outM, inM), solid);
      if (side === 's') return box(p0, p1, y0, y1, z1 - d1, z1 - d0, sideMats(outM, inM), solid);
      if (side === 'w') return box(x0 + d0, x0 + d1, y0, y1, p0, p1, sideMats(outM, inM), solid);
      return box(x1 - d1, x1 - d0, y0, y1, p0, p1, sideMats(outM, inM), solid);
    };
    // runs of whole bays between the doors
    let k = 0;
    while (k < nb) {
      if (doorBays.has(k)) {
        const p0 = a0 + k * bl, p1 = p0 + bl, v = DOOR.h / h;
        put(p0, p1, DOOR.h, h, partTex(fac, 1, v, 1), partTex(inside.tagName ? inside : innerWall, 1, v, 1), false);   // the wall above, in pattern
        put(p0, p0 + 0.18, 0, DOOR.h, frame, frame, false); put(p1 - 0.18, p1, 0, DOOR.h, frame, frame, false);       // steel frame
        put(p0, p1, DOOR.h - 0.18, DOOR.h, frame, frame, false);
        put(p0 + 0.18, p1 - 0.18, DOOR.h - 0.75, DOOR.h - 0.18, shutter, shutter, false, t * 0.4);                  // the shutter, half up
        k += 1; continue;
      }
      let e = k; while (e < nb && !doorBays.has(e)) e += 1;
      const p0 = a0 + k * bl, p1 = a0 + e * bl;
      put(p0, p1, 0, h, partTex(fac, e - k, 0, 1), inside.tagName ? partTex(inside, e - k, 0, 1) : inside, true);
      k = e;
    }
  };
  ['n', 's', 'e', 'w'].forEach(wall);
  if (floor) { const fl = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 2 * t, z1 - z0 - 2 * t), innerFloor);
    fl.rotation.x = -Math.PI / 2; fl.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2); scene.add(fl); }
  if (ceiling) box(x0 + t, x1 - t, h - 0.2, h - 0.05, z0 + t, z1 - t, M(0xe7e1d6), false);
  if (roof) box(x0 - 0.3, x1 + 0.3, h, h + 0.3, z0 - 0.3, z1 + 0.3, roof, false);
}

/* --- ART FACTORY = Fábrica de Moagem (the flour mill). x -30..-16, z -40..20. Doors east (to the alley) and south. --- */
const MILL = { x0: -30, x1: -16, z0: -40, z1: 20, h: FACTORY_H, t: 0.4 };
{
  const { x0, x1, z0, z1, h, t } = MILL;
  hollow({ x0, x1, z0, z1, h, t, facades: { e: factorySide, w: factorySide, n: factoryEnd, s: factoryEnd }, inside: millInterior, bay: 5, base: 0xc3b9a0, roof: null, ceiling: false, floor: false, doors: { e: [-22, -5, 12], w: [-30, -10, 10], n: [-23], s: [-23] } });   // three onto the alley, three onto the market, one at each end
  box(x1, x1 + 2.6, 3.9, 4.15, -10, 0, M(0xc9c4b8), false);                               // concrete canopy over the alley door
  box(x0 + t, x1 - t, 5.6, 5.9, z0 + t, z1 - t, M(0xd8d0c0), false);                       // ground-floor ceiling
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 2 * t, z1 - z0 - 2 * t), new THREE.MeshLambertMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2); scene.add(floor);
  box(x0 - 0.7, x1 + 0.7, h, h + 0.6, z0 - 0.7, z1 + 0.7, M(0xb3ab95), false);              // flat roof slab, overhanging cornice
  box(x0 - 0.7, x1 + 0.7, h - 0.08, h, z0 - 0.7, z1 + 0.7, M(0x6e6a60), false);             // its shadowed underside
  for (let z = -34; z <= 14; z += 12) cyl(-23, z, 0.18, 0, 5.6, ironMat, true, 10);      // cast-iron columns
}
/* roller mills in two rows, a hopper and a chute to the ceiling on each */
const machines = [];
for (const [x, skip] of [[-26.5, null], [-19.5, -4]]) {
  for (let z = -34; z <= 14; z += 6) {
    if (z === skip) continue;
    box(x - 0.6, x + 0.6, 0, 1.7, z - 0.9, z + 0.9, machineMat);
    box(x - 0.4, x + 0.4, 1.7, 2.3, z - 0.6, z + 0.6, brassMat, false);
    cyl(x, z, 0.12, 2.3, 5.6, ironMat, false, 8);
    machines.push({ x, z });
  }
}
/* --- pipework in the mill: overhead mains along the hall, drops into every roller mill, risers up the walls,
   a cross-over pipe, valve wheels and a pressure gauge. All above head height or tight to the walls. --- */
{
  const copper = new THREE.MeshLambertMaterial({ color: 0xb06f3e }), green = new THREE.MeshLambertMaterial({ color: 0x55705e }),
        steel = new THREE.MeshLambertMaterial({ color: 0x8a8f94 }), red = new THREE.MeshLambertMaterial({ color: 0xc0262d }), dark = M(0x1d1f21);
  const up = new THREE.Vector3(0, 1, 0);
  function seg(a, b, r, mat) {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(up, d.normalize()); scene.add(m);
  }
  function run(pts, r, mat, flanges = true) {
    const V = pts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    for (let i = 0; i < V.length - 1; i++) seg(V[i], V[i + 1], r, mat);
    V.forEach((p, i) => { if (i > 0 && i < V.length - 1) { const j = new THREE.Mesh(new THREE.SphereGeometry(r * 1.25, 10, 8), mat); j.position.copy(p); scene.add(j); } });
    if (flanges) for (let i = 0; i < V.length - 1; i++) { const len = V[i].distanceTo(V[i + 1]); for (let t = 3; t < len - 1; t += 3) { const p = new THREE.Vector3().lerpVectors(V[i], V[i + 1], t / len); seg(p.clone().addScaledVector(new THREE.Vector3().subVectors(V[i + 1], V[i]).normalize(), -0.05), p.clone().addScaledVector(new THREE.Vector3().subVectors(V[i + 1], V[i]).normalize(), 0.05), r * 1.45, mat); } }
  }
  function valve(x, y, z, axis) {
    const w = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 16), red); w.position.set(x, y, z);
    if (axis === 'x') w.rotation.y = Math.PI / 2; scene.add(w);
    for (let k = 0; k < 3; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.025, 0.025), red); sp.position.set(x, y, z); sp.rotation.set(axis === 'x' ? k * 1.047 : 0, axis === 'x' ? Math.PI / 2 : 0, axis === 'x' ? 0 : k * 1.047); scene.add(sp); }
  }
  // two copper mains running the length of the hall, one over each row of mills
  const Y = 4.9;
  [[-26.5, copper], [-19.5, green]].forEach(([x, mat]) => {
    run([[x + 0.9, Y, -38.8], [x + 0.9, Y, 18.8]], 0.14, mat);
    machines.filter((m) => m.x === x).forEach((m) => { run([[x + 0.9, Y, m.z + 0.4], [x + 0.9, 3.6, m.z + 0.4], [x + 0.35, 3.0, m.z + 0.4], [x + 0.35, 2.3, m.z + 0.4]], 0.07, mat, false); valve(x + 0.9, 3.9, m.z + 0.4, 'z'); });
  });
  // a cross-over between the two mains, and a fat steel duct along the ceiling's centre line
  [-25, 5].forEach((z) => run([[-25.6, Y, z], [-25.6, 5.3, z], [-18.6, 5.3, z], [-18.6, Y, z]], 0.1, steel, false));
  run([[-23, 5.3, -39.2], [-23, 5.3, 19.2]], 0.28, steel);
  // risers up the long walls, clear of the doorways, with a valve at hand height on each
  [[-29.45, -37], [-29.45, -20], [-29.45, 0], [-29.45, 17]].forEach(([x, z]) => { run([[x, 0, z], [x, Y, z], [-26.5 + 0.9, Y, z]], 0.09, green, false); valve(x + 0.15, 1.4, z, 'x'); solids.push({ x0: x - 0.15, x1: x + 0.15, z0: z - 0.15, z1: z + 0.15 }); });
  [[-16.55, -33], [-16.55, -15], [-16.55, 4], [-16.55, 17]].forEach(([x, z]) => { run([[x, 0, z], [x, Y, z], [-19.5 + 0.9, Y, z]], 0.09, copper, false); valve(x - 0.15, 1.4, z, 'x'); solids.push({ x0: x - 0.15, x1: x + 0.15, z0: z - 0.15, z1: z + 0.15 }); });
  // a pressure gauge on the north wall
  const gauge = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 20), steel); gauge.rotation.x = Math.PI / 2; gauge.position.set(-27.6, 2.2, -39.5); scene.add(gauge);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.18, 20), M(0xf2f0eb)); face.position.set(-27.6, 2.2, -39.45); scene.add(face);
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.15, 0.01), red); needle.position.set(-27.63, 2.25, -39.44); needle.rotation.z = -0.6; scene.add(needle);
  run([[-27.6, 2.42, -39.5], [-27.6, Y, -39.5], [-23.3, Y, -39.5], [-23.3, 5.3, -39.2]], 0.04, copper, false);   // the gauge sits beside the north door, not over it
  void dark;
}
/* --- ARMAZÉM 0108: the warehouse whose west face carries ON THE WALL. x -6..8, z -40..16 --- */
// Armazém 0108: doors kept clear of ON THE WALL (west face, z -26..-4) and the billboard (north face)
hollow({ x0: -6, x1: 8, z0: -40, z1: 16, h: 9, facade: millFacade, base: 0x8b3a2f, doors: { w: [-33, 8], s: [1], e: [-10] } });
for (let z = -30; z <= 10; z += 10) cyl(1, z, 0.25, 0, 9, M(0x9a948a), true, 12);       // a row of columns down the middle
/* --- art supplied by the organisers: the NFC dragon and the JPEG FRENS container side (embedded, the page loads nothing) --- */
const ART = { dragon: new Image(), jpeg: new Image(), napkin: new Image() };
ART.napkin.src = napkinUrl;
ART.dragon.src = dragonUrl;
ART.jpeg.src = jpegUrl;
function refreshTextures(canvases) {
  scene.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { if (m && m.map && canvases.includes(m.map.image)) m.map.needsUpdate = true; }); });
}
function repaint(canvas, fresh) { const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(fresh, 0, 0); }
/* --- the billboard, moved off the alley onto the north end of Armazém 0108: NON FUNGIBLE CONFERENCE 2027 and the dragon --- */
const BB = { w: 12, h: 7.5, x: 1, y: 4.3, z: -40.13 };
function billboardArt() {
  return tileCanvas(2048, 1280, (g, w, h) => {
    g.fillStyle = '#DEDBD3'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0B0B0B'; g.font = '600 34px "IBM Plex Mono", monospace'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.fillText('N F C   S U M M I T', 70, 92); g.textAlign = 'right'; g.fillText('2 7 · 2 8 · 2 9   M A Y', w - 70, 92);
    g.fillRect(70, 118, w - 140, 4);
    g.textAlign = 'left'; g.font = '262px Anton, Impact, "Arial Narrow", sans-serif';
    ['NON', 'FUNGIBLE', 'CONFERENCE', '2027'].forEach((line, i) => g.fillText(line, 62, 372 + i * 236));
    if (ART.dragon.complete && ART.dragon.naturalWidth) { const dh = 1080, dw = dh * ART.dragon.naturalWidth / ART.dragon.naturalHeight; g.drawImage(ART.dragon, w - dw - 40, h - dh, dw, dh); }
    g.font = '600 38px "IBM Plex Mono", monospace'; g.fillText('UNICORN FACTORY · LISBON', 70, h - 52);
  });
}
const billboardCanvas = billboardArt();
/* NFC signage, in the festival's own look (concrete, ink, tall condensed type, spaced mono): wayfinding totems,
   a long banner down the Art Factory, and an A-frame at the main stage door. */
function arrowAt(g, x, y, ang, s) {                  // ang: 0 = up, clockwise in radians
  g.save(); g.translate(x, y); g.rotate(ang); g.lineWidth = s * 0.16; g.lineCap = 'square';
  g.beginPath(); g.moveTo(0, s * 0.5); g.lineTo(0, -s * 0.35); g.stroke();
  g.beginPath(); g.moveTo(-s * 0.36, -s * 0.05); g.lineTo(0, -s * 0.5); g.lineTo(s * 0.36, -s * 0.05); g.stroke(); g.restore();
}
function totemFront(rows) {
  return tileCanvas(512, 1408, (g, w, h) => {
    g.fillStyle = '#0B0B0B'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#DEDBD3'; g.font = '600 26px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillText('N F C   S U M M I T', 40, 70);
    g.font = '150px Anton, Impact, sans-serif'; g.fillText('NFC', 36, 230); g.fillText('2027', 36, 380);
    g.fillRect(40, 420, w - 80, 4);
    rows.forEach(([ang, title, sub], i) => {
      const y = 500 + i * 190;
      g.strokeStyle = '#DEDBD3'; g.beginPath(); g.arc(80, y + 30, 40, 0, 6.3); g.lineWidth = 3; g.stroke();
      g.strokeStyle = '#DEDBD3'; arrowAt(g, 80, y + 30, ang, 46);
      g.fillStyle = '#DEDBD3'; let fs = 62; g.font = `${fs}px Anton, Impact, sans-serif`; while (g.measureText(title).width > w - 185 && fs > 30) { fs -= 2; g.font = `${fs}px Anton, Impact, sans-serif`; } g.fillText(title, 145, y + 34);
      g.font = '600 22px "IBM Plex Mono", monospace'; g.fillStyle = 'rgba(222,219,211,.7)'; g.fillText(sub, 147, y + 72);
    });
    g.fillStyle = '#DEDBD3'; g.font = '600 22px "IBM Plex Mono", monospace'; g.fillText('27 · 28 · 29 MAY · UNICORN FACTORY', 40, h - 50);
  });
}
function totemBack() {
  return tileCanvas(512, 1408, (g, w, h) => {
    g.fillStyle = '#DEDBD3'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0B0B0B'; g.font = '600 26px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillText('N F C   S U M M I T', 40, 70);
    g.font = '118px Anton, Impact, sans-serif'; ['NON', 'FUNGIBLE', 'CONFER-', 'ENCE', '2027'].forEach((l, i) => g.fillText(l, 34, 210 + i * 118));
    if (ART.dragon.complete && ART.dragon.naturalWidth) { const dh = 560, dw = dh * ART.dragon.naturalWidth / ART.dragon.naturalHeight; g.drawImage(ART.dragon, w - dw + 40, h - dh - 20, dw, dh); }
    g.font = '600 22px "IBM Plex Mono", monospace'; g.fillText('LISBON', 40, h - 50);
  });
}
function bannerArt() {
  return tileCanvas(512, 2048, (g, w, h) => {
    g.fillStyle = '#0B0B0B'; g.fillRect(0, 0, w, h);
    g.save(); g.translate(w / 2 + 70, h - 60); g.rotate(-Math.PI / 2);
    g.fillStyle = '#DEDBD3'; g.font = '300px Anton, Impact, sans-serif'; g.textAlign = 'left'; g.fillText('NFC 2027', 0, 0);
    g.font = '600 46px "IBM Plex Mono", monospace'; g.fillText('N O N   F U N G I B L E   C O N F E R E N C E', 8, 90);
    g.restore();
    g.fillStyle = '#cc0a5e'; g.fillRect(0, 0, w, 26); g.fillRect(0, h - 26, w, 26);
  });
}
function aFrameArt() {
  return tileCanvas(512, 720, (g, w, h) => {
    g.fillStyle = '#DEDBD3'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0B0B0B'; g.font = '600 24px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText('N F C   2 0 2 7', w / 2, 60);
    g.font = '170px Anton, Impact, sans-serif'; g.fillText('MAIN', w / 2, 250); g.fillText('STAGE', w / 2, 420);
    g.strokeStyle = '#0B0B0B'; arrowAt(g, w / 2, 540, Math.PI / 2, 110);
    g.font = '600 24px "IBM Plex Mono", monospace'; g.fillText('TALKS ALL DAY', w / 2, h - 50);
  });
}
const SIGNS = [];        // { canvas, make } so they can be repainted once the fonts and the dragon have loaded
function signCanvas(make) { const c = make(); SIGNS.push({ c, make }); return c; }
function totem(x, z, faceYaw, rows) {
  const front = signCanvas(() => totemFront(rows)), back = signCanvas(totemBack);
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = faceYaw; scene.add(g);
  const W = 0.9, H = 2.5, D = 0.16;
  const m = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [M(0x0b0b0b), M(0x0b0b0b), M(0x0b0b0b), M(0x0b0b0b),
    new THREE.MeshLambertMaterial({ map: texFrom(front, 1, 1) }), new THREE.MeshLambertMaterial({ map: texFrom(back, 1, 1) })]);
  m.position.y = H / 2 + 0.08; g.add(m);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, 0.08, D + 0.3), M(0x2a2a2a)); foot.position.y = 0.04; g.add(foot);
  solids.push({ x0: x - 0.5, x1: x + 0.5, z0: z - 0.5, z1: z + 0.5 });
}
// bearings for the arrows are worked out from where each totem stands and which way it faces
function rowsFrom(x, z, faceYaw, places) {
  return places.map(([px, pz, title, sub]) => {
    const worldAng = Math.atan2(px - x, -(pz - z));            // 0 = north (-z), clockwise
    const facing = Math.atan2(-Math.sin(faceYaw + Math.PI) , -Math.cos(faceYaw + Math.PI));  // unused, kept simple below
    return [worldAng + faceYaw, title, sub];
  });
}
const PLACES = [[-23, -10, 'ART FACTORY', 'FÁBRICA DE MOAGEM'], [-6, -15, 'ON THE WALL', 'ARMAZÉM 0108'], [-26, 52, 'MAIN STAGE', 'TALKS · PERFORMANCE'], [-12, 25.5, 'HOUSES', 'COMMUNITY CONTAINERS']];
// courtyard totem, facing north up the alley; and one at the alley's north end, facing south
[[-9, 36, Math.PI], [-12.5, -36.5, 0]].forEach(([x, z, yaw]) => totem(x, z, yaw, rowsFrom(x, z, yaw, PLACES.filter(([px, pz]) => Math.hypot(px - x, pz - z) > 8))));
{
  // the long banner down the Art Factory's alley face
  const b = signCanvas(bannerArt);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3, 12), new THREE.MeshLambertMaterial({ map: texFrom(b, 1, 1), side: THREE.DoubleSide }));
  m.rotation.y = Math.PI / 2; m.position.set(-15.55, 11, -24); scene.add(m);
  box(-15.6, -15.3, 17, 17.15, -25.6, -22.4, M(0x111111), false);                 // the rail it hangs from
  // A-frame at the main stage's north door
  const a = signCanvas(aFrameArt), am = new THREE.MeshLambertMaterial({ map: texFrom(a, 1, 1) });
  const af = new THREE.Group(); af.position.set(-23.5, 0, 49.5); scene.add(af);
  for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), am); p.position.set(0, 0.5, s * 0.17); p.rotation.set(s * -0.33, s > 0 ? 0 : Math.PI, 0); af.add(p); }
  solids.push({ x0: -24, x1: -23, z0: 49, z1: 50 });
}
function repaintSigns() { SIGNS.forEach(({ c, make }) => repaint(c, make())); refreshTextures(SIGNS.map((s) => s.c)); }

/* ---------------- planters, outdoor seating, and stages inside the buildings ---------------- */
const FUR = {
  concrete: M(0xb9b3a8), black: M(0x161616), steel: M(0x6d7177), wood: M(0x9a7350), soil: M(0x3b2c22),
  agave: M(0x6f8f7c), leaf: M(0x3e6b45), leaf2: M(0x5b8a4a), grass: M(0x8fa05a), flower: M(0xcc0a5e), flower2: M(0xffb3d4), bark: M(0x5a4232),
};
function mesh(geo, mat, x, y, z, parent = scene) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; }
function group(x, z, rotY = 0) { const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; scene.add(g); return g; }
const block = (hw, hd) => ({ x0: -hw, x1: hw, z0: -hd, z1: hd });
function solidAround(x, z, hw, hd, rotY = 0) {                // an axis-aligned blocker that covers a rotated footprint
  const c = Math.abs(Math.cos(rotY)), s2 = Math.abs(Math.sin(rotY)), ax = hw * c + hd * s2, az = hw * s2 + hd * c;
  solids.push({ x0: x - ax, x1: x + ax, z0: z - az, z1: z + az });
}
// 1. square concrete planter with an agave, like the ones by the mural wall
function planterAgave(x, z) {
  const g = group(x, z);
  mesh(new THREE.BoxGeometry(1.1, 0.7, 1.1), FUR.concrete, 0, 0.35, 0, g); mesh(new THREE.BoxGeometry(0.95, 0.04, 0.95), FUR.soil, 0, 0.7, 0, g);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + (k % 2) * 0.2, lean = 0.5 + (k % 3) * 0.25, len = 0.7 + (k % 4) * 0.15;
    const leaf = mesh(new THREE.ConeGeometry(0.07, len, 4), FUR.agave, Math.cos(a) * 0.12, 0.72 + len / 2 * Math.cos(lean), Math.sin(a) * 0.12, g);
    leaf.rotation.set(0, 0, 0); leaf.rotateY(-a); leaf.rotateZ(-lean); leaf.position.x += Math.cos(a) * Math.sin(lean) * len / 2; leaf.position.z += Math.sin(a) * Math.sin(lean) * len / 2;
  }
  solidAround(x, z, 0.6, 0.6);
}
// 2. round black pot with a small tree
function planterTree(x, z) {
  const g = group(x, z);
  mesh(new THREE.CylinderGeometry(0.55, 0.42, 0.8, 18), FUR.black, 0, 0.4, 0, g); mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 18), FUR.soil, 0, 0.8, 0, g);
  mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.6, 8), FUR.bark, 0, 1.6, 0, g);
  const c1 = mesh(new THREE.IcosahedronGeometry(0.85, 0), FUR.leaf, 0, 2.7, 0, g); c1.rotation.set(0.3, 0.5, 0);
  const c2 = mesh(new THREE.IcosahedronGeometry(0.6, 0), FUR.leaf2, 0.35, 3.15, -0.2, g); c2.rotation.set(0.8, 0.1, 0.4);
  solidAround(x, z, 0.55, 0.55);
}
// 3. long steel trough of tall grasses
function planterTrough(x, z, rotY = 0) {
  const g = group(x, z, rotY);
  mesh(new THREE.BoxGeometry(3, 0.6, 0.7), FUR.steel, 0, 0.3, 0, g); mesh(new THREE.BoxGeometry(2.9, 0.04, 0.6), FUR.soil, 0, 0.6, 0, g);
  for (let k = 0; k < 40; k++) {
    const bx = -1.35 + (k / 39) * 2.7, bz = ((k * 7) % 5 - 2) * 0.1, hgt = 0.6 + ((k * 13) % 7) * 0.09;
    const b = mesh(new THREE.ConeGeometry(0.035, hgt, 3), k % 3 ? FUR.grass : FUR.leaf2, bx, 0.6 + hgt / 2, bz, g); b.rotation.set(((k * 5) % 7 - 3) * 0.06, 0, ((k * 3) % 7 - 3) * 0.08);
  }
  solidAround(x, z, 1.55, 0.4, rotY);
}
// 4. half-barrel planter with magenta flowers
function planterBarrel(x, z) {
  const g = group(x, z);
  mesh(new THREE.CylinderGeometry(0.5, 0.45, 0.6, 16), FUR.wood, 0, 0.3, 0, g);
  for (const y of [0.12, 0.48]) mesh(new THREE.TorusGeometry(0.49, 0.025, 6, 20), FUR.steel, 0, y, 0, g).rotation.x = Math.PI / 2;
  mesh(new THREE.SphereGeometry(0.46, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), FUR.leaf, 0, 0.58, 0, g);
  for (let k = 0; k < 18; k++) { const a = k * 2.4, r = 0.12 + (k % 4) * 0.08; mesh(new THREE.SphereGeometry(0.06, 6, 5), k % 3 ? FUR.flower : FUR.flower2, Math.cos(a) * r, 0.66 + 0.25 * Math.sqrt(Math.max(0, 1 - (r / 0.46) ** 2)), Math.sin(a) * r, g); }
  solidAround(x, z, 0.5, 0.5);
}
// seating: picnic table, tall bistro table with stools (like the ones on the Normies wall photo), pallet lounge
function picnic(x, z, rotY = 0) {
  const g = group(x, z, rotY);
  mesh(new THREE.BoxGeometry(2, 0.07, 0.8), FUR.wood, 0, 0.75, 0, g);
  for (const sz of [-0.62, 0.62]) mesh(new THREE.BoxGeometry(2, 0.06, 0.3), FUR.wood, 0, 0.45, sz, g);
  for (const sx of [-0.85, 0.85]) for (const sz of [-1, 1]) { const l = mesh(new THREE.BoxGeometry(0.07, 0.85, 0.07), FUR.wood, sx, 0.4, sz * 0.4, g); l.rotation.x = sz * 0.35; }
  solidAround(x, z, 1.05, 0.8, rotY);
}
function bistro(x, z) {
  const g = group(x, z);
  mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 20), FUR.black, 0, 1.05, 0, g); mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.05, 8), FUR.black, 0, 0.52, 0, g);
  mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.03, 16), FUR.black, 0, 0.02, 0, g);
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + 0.4, sx = Math.cos(a) * 0.75, sz = Math.sin(a) * 0.75;
    mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 14), FUR.black, sx, 0.75, sz, g);
    for (let l = 0; l < 4; l++) { const la = l * Math.PI / 2 + 0.4, leg = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.78, 5), FUR.black, sx + Math.cos(la) * 0.12, 0.37, sz + Math.sin(la) * 0.12, g); leg.rotation.set(Math.sin(la) * 0.12, 0, -Math.cos(la) * 0.12); }
    const ring = mesh(new THREE.TorusGeometry(0.15, 0.012, 5, 14), FUR.black, sx, 0.3, sz, g); ring.rotation.x = Math.PI / 2;
  }
  solidAround(x, z, 0.4, 0.4);
}
function lounge(x, z, rotY = 0) {
  const g = group(x, z, rotY), cushion = M(0xe8b60f), cushion2 = M(0xf2f0eb);
  for (const [px, pw] of [[0, 2.4]]) { mesh(new THREE.BoxGeometry(pw, 0.3, 0.9), FUR.wood, px, 0.15, 0, g); mesh(new THREE.BoxGeometry(pw, 0.12, 0.85), cushion, px, 0.36, 0, g); mesh(new THREE.BoxGeometry(pw, 0.5, 0.18), cushion2, px, 0.6, -0.38, g); }
  mesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), FUR.wood, 1.9, 0.15, 0.8, g); mesh(new THREE.BoxGeometry(0.85, 0.12, 0.85), cushion, 1.9, 0.36, 0.8, g);
  mesh(new THREE.BoxGeometry(1.0, 0.35, 0.6), FUR.wood, 0, 0.18, 1.0, g);                       // a pallet coffee table
  solidAround(x, z, 1.3, 0.5, rotY); solidAround(x + Math.cos(rotY) * 1.9 + Math.sin(rotY) * 0.8, z - Math.sin(rotY) * 1.9 + Math.cos(rotY) * 0.8, 0.45, 0.45, rotY);
}
// a stage: black deck, a backdrop with the NFC mark, speaker stacks, a mic stand and a truss with lights
function stage(x, z, w, d, rotY, backdropColor = 0xcc0a5e, label = 'NFC 2027') {
  const g = group(x, z, rotY);
  mesh(new THREE.BoxGeometry(w, 0.9, d), FUR.black, 0, 0.45, 0, g);
  mesh(new THREE.BoxGeometry(w, 0.06, 0.06), M(0xe8b60f), 0, 0.9, d / 2, g);                       // the stage-edge tape
  const bd = tileCanvas(512, 256, (c, cw, ch) => { c.fillStyle = '#' + backdropColor.toString(16).padStart(6, '0'); c.fillRect(0, 0, cw, ch); c.fillStyle = '#F2F0EB'; let f = 150; c.font = `${f}px Anton, Impact, sans-serif`; while (c.measureText(label).width > cw * 0.86 && f > 40) { f -= 6; c.font = `${f}px Anton, Impact, sans-serif`; } c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, cw / 2, ch / 2 + 6); });
  SIGNS.push({ c: bd, make: () => tileCanvas(512, 256, (c, cw, ch) => { c.fillStyle = '#' + backdropColor.toString(16).padStart(6, '0'); c.fillRect(0, 0, cw, ch); c.fillStyle = '#F2F0EB'; let f = 150; c.font = `${f}px Anton, Impact, sans-serif`; while (c.measureText(label).width > cw * 0.86 && f > 40) { f -= 6; c.font = `${f}px Anton, Impact, sans-serif`; } c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, cw / 2, ch / 2 + 6); }) });
  const back = mesh(new THREE.PlaneGeometry(w - 0.4, (w - 0.4) / 2), new THREE.MeshLambertMaterial({ map: texFrom(bd, 1, 1) }), 0, 0.9 + (w - 0.4) / 4 + 0.2, -d / 2 + 0.05, g);
  for (const sx of [-1, 1]) { mesh(new THREE.BoxGeometry(0.7, 1.4, 0.6), FUR.black, sx * (w / 2 - 0.45), 0.9 + 0.7, d / 2 - 0.45, g); mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 16), FUR.steel, sx * (w / 2 - 0.45), 1.75, d / 2 - 0.14, g).rotation.x = Math.PI / 2; }
  mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.5, 6), FUR.steel, 0, 1.65, d / 2 - 0.8, g); mesh(new THREE.SphereGeometry(0.05, 8, 6), M(0xcc0a5e), 0, 2.42, d / 2 - 0.8, g);
  const th = Math.min(5.5, 0.9 + (w - 0.4) / 2 + 1.2);
  for (const sx of [-1, 1]) mesh(new THREE.BoxGeometry(0.25, th, 0.25), FUR.steel, sx * (w / 2 - 0.1), th / 2, d / 2 - 0.1, g);
  mesh(new THREE.BoxGeometry(w, 0.25, 0.25), FUR.steel, 0, th, d / 2 - 0.1, g);
  for (let k = 0; k < 4; k++) mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.3, 10), M(0xffd23f), -w / 2 + (k + 0.5) * w / 4, th - 0.3, d / 2 - 0.1, g);
  solidAround(x, z, w / 2, d / 2, rotY);
}

/* The ball pit, filling the north half of the long sheds. About 2,400 balls drawn as one instanced mesh (one draw
   call, cheap even on a phone). Wading in slows you down and sinks you to chest height, and the balls near you are
   pushed aside and bob back when you move on. Only the balls within reach are moved each frame. */
/* The ball pit fills the whole of the long sheds, wall to wall, except the stage at the south end. Balls are kept
   in 1 m buckets so each frame only the balls around you are looked at, however many there are. */
const PIT = { x0: 14.3, x1: 29.7, z0: -39.7, z1: 29.7, top: 0.8 };
const STAGE_SHEDS = { x0: 16.6, x1: 27.4, z0: 24.1, z1: 29.7 };
const onShedStage = (x, z) => x > STAGE_SHEDS.x0 && x < STAGE_SHEDS.x1 && z > STAGE_SHEDS.z0 && z < STAGE_SHEDS.z1;
const inPit = (x, z) => x > PIT.x0 && x < PIT.x1 && z > PIT.z0 && z < PIT.z1 && !onShedStage(x, z);
const ballPit = (() => {
  const r = 0.2, gap = 0.4, rnd = mulberry32(4242), balls = [];
  for (let z = PIT.z0 + r; z < PIT.z1 - r; z += gap) for (let x = PIT.x0 + r; x < PIT.x1 - r; x += gap) {
    if (!inPit(x, z)) continue;
    balls.push({ x: x + (rnd() - .5) * 0.14, z: z + (rnd() - .5) * 0.14, y: PIT.top - 0.14 + rnd() * 0.18, dx: 0, dy: 0, dz: 0 });
  }
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), balls.length);
  const cols = [0xcc0a5e, 0x2e7fd6, 0xe8b60f, 0xf2f0eb, 0xff6fae], c = new THREE.Color(), m4 = new THREE.Matrix4();
  balls.forEach((b, i) => { mesh.setColorAt(i, c.set(cols[Math.floor(rnd() * cols.length)])); mesh.setMatrixAt(i, m4.makeTranslation(b.x, b.y, b.z)); });
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(PIT.x1 - PIT.x0, PIT.z1 - PIT.z0), M(0x7a0a3a)); floor.rotation.x = -Math.PI / 2; floor.position.set((PIT.x0 + PIT.x1) / 2, PIT.top - 0.22, (PIT.z0 + PIT.z1) / 2); scene.add(floor);
  const bucket = new Map(), key = (cx, cz) => cx * 1000 + cz;
  balls.forEach((b, i) => { const k = key(Math.floor(b.x), Math.floor(b.z)); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(i); });
  let moving = new Set();
  function step(dt) {
    const inside = inPit(P.x, P.z);
    if (!inside && !moving.size) return;
    const reach = 1.1, next = new Set(), look = new Set(moving);
    if (inside) for (let cx = Math.floor(P.x) - 2; cx <= Math.floor(P.x) + 2; cx++) for (let cz = Math.floor(P.z) - 2; cz <= Math.floor(P.z) + 2; cz++) (bucket.get(key(cx, cz)) || []).forEach((i) => look.add(i));
    const k = 1 - Math.exp(-10 * dt), t = performance.now() / 300;
    look.forEach((i) => {
      const b = balls[i], ox = b.x - P.x, oz = b.z - P.z, d = Math.hypot(ox, oz);
      let tx = 0, ty = 0, tz = 0;
      if (inside && d < reach) { const push = (1 - d / reach) * 0.55; tx = (ox / (d || 1)) * push; tz = (oz / (d || 1)) * push; ty = push * 0.6; }
      b.dx += (tx - b.dx) * k; b.dy += (ty - b.dy) * k; b.dz += (tz - b.dz) * k;
      if (Math.abs(b.dx) + Math.abs(b.dy) + Math.abs(b.dz) < 0.002 && !tx && !tz) { b.dx = b.dy = b.dz = 0; }
      mesh.setMatrixAt(i, m4.makeTranslation(b.x + b.dx, b.y + b.dy + (ty ? 0.04 * Math.sin(i + t) : 0), b.z + b.dz));
      if (b.dx || b.dy || b.dz) next.add(i);
    });
    if (look.size) mesh.instanceMatrix.needsUpdate = true;
    moving = next;
  }
  return { step, count: balls.length };
})();
/* Bubble machines: the silo tower's hall is always full of soap bubbles drifting up from two machines by the stage. */
const bubbleMachines = [[22.6, 66.4], [22.6, 70.2]].map(([x, z]) => {
  const g = group(x, z, -Math.PI / 2);
  mesh(new THREE.BoxGeometry(0.6, 0.45, 0.45), M(0x2e7fd6), 0, 0.22, 0, g);
  const fan = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 16), M(0xf2f0eb), 0, 0.3, 0.24, g); fan.rotation.x = Math.PI / 2;
  solidAround(x, z, 0.35, 0.35);
  return { x: x - 0.4, z };
});
let bubbleClock = 0;
const TOWER = { x0: 3.6, x1: 22.8, z0: 65.2, z1: 71.4 };     // the silo tower's hall, short of its stage
function stepBubbleMachines(dt) {
  if (Math.hypot(P.x - 16, P.z - 68) > 45) return;          // only while you are anywhere near the tower
  bubbleClock += dt;
  // the machines keep blowing, and bubbles hang everywhere in the hall, floor to well above your head
  while (bubbleClock > 0.005) {
    bubbleClock -= 0.005;
    if (Math.random() < 0.25) { const m = bubbleMachines[Math.random() < 0.5 ? 0 : 1]; bubbles.burst(m.x, 0.45, m.z, 1); }
    else bubbles.burst(TOWER.x0 + Math.random() * (TOWER.x1 - TOWER.x0), 0.2 + Math.random() * 9, TOWER.z0 + Math.random() * (TOWER.z1 - TOWER.z0), 1);
  }
}

// planters
[[-38, 31], [12, 31], [-38, 48], [12, 48]].forEach(([x, z]) => planterAgave(x, z));
[[-16, 46], [6, 46], [-15, -30], [-15, 2]].forEach(([x, z]) => planterTree(x, z));
planterTrough(-33, 50.4); planterTrough(-6.8, -2.5, Math.PI / 2); planterTrough(10.5, -20, Math.PI / 2);
[[-34.5, 25], [9, 21.5], [-1.5, 31.5], [-20, 31.5]].forEach(([x, z]) => planterBarrel(x, z));
// outdoor seating in the courtyard
picnic(-30, 38); picnic(-24, 42, 0.3); picnic(2, 40); picnic(8, 36, -0.25);
bistro(-6, 30.5); bistro(-3, 34); bistro(-14, 33);
lounge(-36, 43, Math.PI / 2);
// stages inside the other buildings
// the main stage's backdrop: a big NFC across the whole dark wall behind the stage
{
  const make = () => tileCanvas(1536, 1024, (g, w, h) => {
    g.fillStyle = '#2a0a18'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#F2F0EB'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    let fs = 760; g.font = `${fs}px Anton, Impact, "Arial Narrow", sans-serif`;
    while (g.measureText('NFC').width > w * 0.86) { fs -= 10; g.font = `${fs}px Anton, Impact, "Arial Narrow", sans-serif`; }
    g.fillText('NFC', w / 2, h * 0.76);
    g.fillStyle = '#cc0a5e'; g.fillRect(w * 0.07, h * 0.82, w * 0.86, 10);
    g.fillStyle = '#F2F0EB'; const sub = 'N O N   F U N G I B L E   C O N F E R E N C E   ·   2 0 2 7';
    let ss = 46; g.font = `600 ${ss}px "IBM Plex Mono", monospace`; while (g.measureText(sub).width > w * 0.86) { ss -= 2; g.font = `600 ${ss}px "IBM Plex Mono", monospace`; }
    g.fillText(sub, w / 2, h * 0.92);
  });
  const c = make(); SIGNS.push({ c, make });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(10, 6.67), new THREE.MeshLambertMaterial({ map: texFrom(c, 1, 1) }));
  m.rotation.y = Math.PI / 2; m.position.set(-39.36, 1.1 + 6.67 / 2, 58); scene.add(m);
}
stage(1, -36.5, 9, 4, 0, 0xcc0a5e, 'NFC TALKS');            // Armazém 0108, north end: talks
stage(22, 26.5, 10, 4, Math.PI, 0x2e7fd6, 'NFC');      // the long sheds, south end: DJ nights
stage(26.5, 68.3, 6.5, 6, -Math.PI / 2, 0x151515, 'NFC 2027'); // the silo tower, east end

/* ---------------- the main stage hall as a DJ set: moving-head beams, lasers, a disco ball, a lit dance floor ---------------- */
const rave = (() => {
  const HALL = { x0: -39.7, x1: -12.3, z0: 52.3, z1: 63.7, h: 8 };
  const add = (o) => { scene.add(o); return o; };
  const beamMat = (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const COLS = [0xcc0a5e, 0x2e7fd6, 0xe8b60f, 0x22e0ff, 0xff6fae, 0x9b5cff];
  // black it out like a club: drapes on every inside wall (with the doorways left open), a black ceiling and floor
  const drape = new THREE.MeshLambertMaterial({ color: 0x2a1030, emissive: 0x12051a, side: THREE.DoubleSide });   // deep plum velvet, not a black void
  const DW = 1.5;   // half a doorway
  const hang = (a0, a1, fixed, axis) => { if (a1 - a0 < 0.05) return; const m = new THREE.Mesh(new THREE.PlaneGeometry(a1 - a0, HALL.h - 0.3), drape); if (axis === 'x') m.position.set((a0 + a1) / 2, (HALL.h - 0.3) / 2, fixed); else { m.rotation.y = Math.PI / 2; m.position.set(fixed, (HALL.h - 0.3) / 2, (a0 + a1) / 2); } scene.add(m); };
  // gaps match the doorways exactly as the walls cut them (each door is one whole bay of the wall)
  const run = (a0, a1, fixed, axis, gaps) => { let a = a0; gaps.forEach(([g0, g1]) => { hang(a, g0, fixed, axis); a = g1; }); hang(a, a1, fixed, axis); };
  const bayGaps = (w0, w1, centres) => { const nb = Math.max(3, Math.round((w1 - w0) / 5)), bl = (w1 - w0) / nb; return [...new Set(centres.map((c) => Math.floor((c - w0) / bl)))].sort((p, q) => p - q).map((k) => [w0 + k * bl - 0.05, w0 + (k + 1) * bl + 0.05]); };
  run(HALL.x0, HALL.x1, HALL.z0 + 0.03, 'x', bayGaps(-40, -12, [-26, -17])); run(HALL.x0, HALL.x1, HALL.z1 - 0.03, 'x', []);
  run(HALL.z0, HALL.z1, HALL.x1 - 0.03, 'z', bayGaps(52.3, 63.7, [58]));
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(HALL.x1 - HALL.x0, HALL.z1 - HALL.z0), drape); ceil.rotation.x = Math.PI / 2; ceil.position.set((HALL.x0 + HALL.x1) / 2, HALL.h - 0.3, (HALL.z0 + HALL.z1) / 2); scene.add(ceil);
  const blackFloor = new THREE.Mesh(new THREE.PlaneGeometry(HALL.x1 - HALL.x0, HALL.z1 - HALL.z0), M(0x121014)); blackFloor.rotation.x = -Math.PI / 2; blackFloor.position.set((HALL.x0 + HALL.x1) / 2, 0.025, (HALL.z0 + HALL.z1) / 2); scene.add(blackFloor);
  // a truss across the hall with six moving heads, each throwing a cone of light that sweeps the floor
  box(-34, -14, HALL.h - 0.9, HALL.h - 0.7, 57.8, 58.2, M(0x2a2a2a), false);
  const heads = [-32, -28, -24, -20, -16].flatMap((x, k) => [56, 60].map((z, j) => {
    const pivot = add(new THREE.Group()); pivot.position.set(x, HALL.h - 1.0, z);
    mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), M(0x111111), 0, 0, 0, pivot);
    const cone = new THREE.ConeGeometry(1.0, 7.2, 24, 1, true); cone.translate(0, -3.6, 0);
    const m = new THREE.Mesh(cone, beamMat(COLS[(k + j) % COLS.length])); pivot.add(m);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), beamMat(COLS[(k + j) % COLS.length])); spot.rotation.x = -Math.PI / 2; add(spot);
    return { pivot, m, spot, ph: k * 0.9 + j * 2.1, ci: k + j };
  }));
  // lasers fanning out from the front of the stage
  const lasers = add(new THREE.Group()); lasers.position.set(-31.2, 2.2, 58);
  const laserGeo = new THREE.CylinderGeometry(0.018, 0.018, 24, 4); laserGeo.rotateZ(Math.PI / 2); laserGeo.translate(12, 0, 0);
  const laserBeams = Array.from({ length: 9 }, (_, k) => { const l = new THREE.Mesh(laserGeo, new THREE.MeshBasicMaterial({ color: k % 2 ? 0x22ff88 : 0xff2aa0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })); lasers.add(l); return l; });
  // a disco ball over the dance floor
  const ball = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), new THREE.MeshPhongMaterial({ color: 0xd8d8e0, emissive: 0x555566, specular: 0xffffff, shininess: 80, flatShading: true }))); ball.position.set(-21, HALL.h - 1.6, 58);
  box(-21.02, -20.98, HALL.h - 0.9, HALL.h - 0.2, 57.98, 58.02, M(0x111111), false);
  // the dance floor: tiles that light up to the beat
  const TX = 12, TZ = 7, ts = 1.45, fx0 = -30, fz0 = 52.9;
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(ts - 0.08, 0.04, ts - 0.08), new THREE.MeshBasicMaterial(), TX * TZ);
  const m4 = new THREE.Matrix4(), c = new THREE.Color();
  for (let i = 0; i < TX * TZ; i++) { tiles.setMatrixAt(i, m4.makeTranslation(fx0 + (i % TX) * ts + ts / 2, 0.04, fz0 + Math.floor(i / TX) * ts + ts / 2)); tiles.setColorAt(i, c.set(0x111111)); }
  add(tiles);
  let beat = -1; const laserDir = new THREE.Vector3();
  function step(t) {
    if (Math.hypot(P.x + 26, P.z - 58) > 40) return;     // only animate while you are near the hall
    const bpm = 138, b = Math.floor(t * bpm / 60), phase = (t * bpm / 60) % 1;   // the lights keep their own steady 138 BPM
    heads.forEach((h) => {
      h.pivot.rotation.set(0.42 * Math.sin(t * 0.9 + h.ph), 0, 0.42 * Math.sin(t * 0.7 + h.ph * 1.3));   // tilts small enough that the beams stay inside the hall
      const tip = new THREE.Vector3(0, -7.2, 0).applyEuler(h.pivot.rotation).add(h.pivot.position);
      h.spot.position.set(tip.x, 0.06, tip.z);
      if (b !== beat && b % 8 === 0) { const col = COLS[(h.ci + b / 8) % COLS.length]; h.m.material.color.set(col); h.spot.material.color.set(col); }
      h.m.material.opacity = 0.05 + 0.1 * (1 - phase); h.spot.material.opacity = 0.25 + 0.35 * (1 - phase);
    });
    lasers.visible = Math.floor(b / 16) % 2 === 0;           // lasers come in for 16 beats, out for 16
    laserBeams.forEach((l, k) => {
      l.rotation.set(0, (k - 4) * 0.12 + 0.35 * Math.sin(t * 1.3), 0.12 * Math.sin(t * 2 + k));
      // each beam stops where it meets a wall, the floor or the ceiling, so nothing leaks outside the hall
      const d = laserDir.set(1, 0, 0).applyEuler(l.rotation), o = lasers.position;
      let len = 24;
      const hitAt = (lo, hi, oc, dc) => { if (dc > 1e-6) len = Math.min(len, (hi - oc) / dc); else if (dc < -1e-6) len = Math.min(len, (lo - oc) / dc); };
      hitAt(HALL.x0, HALL.x1, o.x, d.x); hitAt(0.05, HALL.h - 0.35, o.y, d.y); hitAt(HALL.z0, HALL.z1, o.z, d.z);
      l.scale.x = Math.max(0.01, len / 24);
    });
    ball.rotation.y = t * 0.8;
    if (b !== beat) {
      beat = b;
      const pat = Math.floor(b / 8) % 3;
      for (let i = 0; i < TX * TZ; i++) {
        const x = i % TX, z = Math.floor(i / TX);
        const on = pat === 0 ? (x + z + b) % 2 === 0 : pat === 1 ? Math.abs(x - TX / 2 + 0.5) < (b % 6) + 0.5 : ((x * 7 + z * 13 + b * 5) % 5) === 0;
        tiles.setColorAt(i, c.set(on ? COLS[(x + z + Math.floor(b / 4)) % COLS.length] : 0x141414));
      }
      tiles.instanceColor.needsUpdate = true;
    }
  }
  return { step };
})();

/* ---------------- Armazém 0108's hall hung with streamers ---------------- */
const streamers = (() => {
  const H = 8.8, rnd = mulberry32(808), list = [];
  const COLS = [0xcc0a5e, 0x2e7fd6, 0xe8b60f, 0xf2f0eb, 0xff6fae, 0x0b0b0b];
  for (let k = 0; k < 240; k++) {
    const x = -5.4 + rnd() * 12.8, z = -33.5 + rnd() * 49, len = H - 0.03;        // every streamer reaches the floor
    list.push({ x, z, len, ph: rnd() * 6.3, sp: 0.6 + rnd() * 0.9, col: COLS[Math.floor(rnd() * COLS.length)], yaw: rnd() * Math.PI });
  }
  const geo = new THREE.PlaneGeometry(0.09, 1, 1, 6); geo.translate(0, -0.5, 0);   // hangs from its top edge
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), list.length);
  const c = new THREE.Color(); list.forEach((s, i) => inst.setColorAt(i, c.set(s.col)));
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(inst);
  // garlands of streamers swagged between the columns and the walls
  [-30, -20, -10, 0, 10].forEach((z) => [[-5.7, 1], [1, 7.7]].forEach(([a, b2], k) => {
    const pts = []; for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push(new THREE.Vector3(a + (b2 - a) * t, 7.6 - 1.1 * 4 * t * (1 - t), z)); }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.06, 5), M(COLS[(z / 10 + 3 + k * 2) % 5 | 0]));
    scene.add(tube);
  }));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), v = new THREE.Vector3(), sc = new THREE.Vector3();
  function step(t) {
    if (Math.hypot(P.x - 1, P.z + 12) > 45 && t > 1) return;
    list.forEach((s, i) => {
      e.set(0.03 * Math.sin(t * s.sp + s.ph), s.yaw + 0.6 * Math.sin(t * 0.4 + s.ph), 0.025 * Math.cos(t * s.sp * 1.3 + s.ph));   // a gentle sway, so the ends brush the floor
      q.setFromEuler(e); sc.set(1, s.len, 1);
      inst.setMatrixAt(i, m4.compose(v.set(s.x, H, s.z), q, sc));
    });
    inst.instanceMatrix.needsUpdate = true;
  }
  return { step };
})();

/* ---------------- festoon lights (always on) and NFC bunting ---------------- */
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const sagAt = (a, b, sag, t) => new THREE.Vector3().lerpVectors(a, b, t).add(V3(0, -sag * 4 * t * (1 - t), 0));
const wireMat = new THREE.LineBasicMaterial({ color: 0x111111 });
function wire(a, b, sag) { const pts = []; for (let i = 0; i <= 24; i++) pts.push(sagAt(a, b, sag, i / 24)); scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat)); }
function pole(x, z, h) { cyl(x, z, 0.07, 0, h, M(0x161616), true, 8); mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), M(0x161616), x, h - 0.1, z); return V3(x, h - 0.15, z); }
// bulbs: warm spheres that ignore the lighting, each with a soft glow sprite, so they read as lit at any hour
const bulbs = [];
function festoon(a, b, sag) { wire(a, b, sag); const n = Math.max(3, Math.round(a.distanceTo(b) / 1.1)); for (let i = 1; i < n; i++) { const p = sagAt(a, b, sag, i / n); p.y -= 0.12; bulbs.push(p); } }
// the alley: zig-zag between the Art Factory and Armazém 0108, 6.5 m up
for (let z = -38, k = 0; z < 14; z += 5, k++) festoon(V3(-15.95, 6.5, z), V3(-6.05, 6.5, z + 5), 0.7 + (k % 2) * 0.3);
// the courtyard: black poles along its north and south edges, criss-crossed
const north = [-38, -25, -9, 4, 12].map((x) => pole(x, 29, 5)), south = [-38, -25, -9, 4, 12].map((x) => pole(x, 50, 5));   // clear of the A-frame and the stage doors
for (let i = 0; i < north.length; i++) { festoon(north[i], south[i], 1.0); if (i + 1 < north.length) { festoon(north[i], south[i + 1], 1.3); festoon(south[i], north[i + 1], 1.3); } }
{
  const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6), bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd98a });
  const inst = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbs.length), m4 = new THREE.Matrix4();
  bulbs.forEach((p, i) => inst.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z))); scene.add(inst);
  const glowTex = new THREE.CanvasTexture(tileCanvas(64, 64, (g, w, h) => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,225,150,1)'); gr.addColorStop(0.25, 'rgba(255,200,110,.55)'); gr.addColorStop(1, 'rgba(255,180,90,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }));
  const pg = new THREE.BufferGeometry().setFromPoints(bulbs);
  scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 1.1, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd08a })));
}
// bunting: triangular pennants in NFC black, magenta and chalk, fluttering a little
const flagSpots = [];
function bunting(a, b, sag) { wire(a, b, sag); const n = Math.max(3, Math.round(a.distanceTo(b) / 0.55)); const dir = new THREE.Vector3().subVectors(b, a).normalize(); for (let i = 1; i < n; i++) flagSpots.push({ p: sagAt(a, b, sag, i / n), yaw: Math.atan2(-dir.z, dir.x), k: i }); }
/* ---------------- the market strip (west of the Art Factory) and the garden bar (south of the main stage) ---------------- */
function tent(x, z, valance = 0xcc0a5e, label = '', rotY = 0) {
  const g = group(x, z, rotY), S = 3, H = 2.4;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(new THREE.CylinderGeometry(0.04, 0.04, H, 6), FUR.black, sx * S / 2, H / 2, sz * S / 2, g);
  const roof = mesh(new THREE.ConeGeometry(S * 0.72, 1.0, 4, 1, true), new THREE.MeshLambertMaterial({ color: 0xf6f3ec, side: THREE.DoubleSide }), 0, H + 0.5, 0, g); roof.rotation.y = Math.PI / 4;
  for (const [w, d, px, pz] of [[S, 0.04, 0, S / 2], [S, 0.04, 0, -S / 2], [0.04, S, S / 2, 0], [0.04, S, -S / 2, 0]]) mesh(new THREE.BoxGeometry(w, 0.3, d), M(valance), px, H - 0.15, pz, g);
  mesh(new THREE.BoxGeometry(S * 0.8, 0.9, 0.6), M(0xe9e3d4), 0, 0.45, S / 2 - 0.5, g);            // the counter at the front
  if (label) { const c = tileCanvas(256, 64, (q, w, h) => { q.fillStyle = '#0b0b0b'; q.fillRect(0, 0, w, h); q.fillStyle = '#f2f0eb'; q.font = '40px Anton, Impact, sans-serif'; q.textAlign = 'center'; q.textBaseline = 'middle'; q.fillText(label, w / 2, h / 2 + 2); });
    SIGNS.push({ c, make: () => tileCanvas(256, 64, (q, w, h) => { q.fillStyle = '#0b0b0b'; q.fillRect(0, 0, w, h); q.fillStyle = '#f2f0eb'; q.font = '40px Anton, Impact, sans-serif'; q.textAlign = 'center'; q.textBaseline = 'middle'; q.fillText(label, w / 2, h / 2 + 2); }) });
    mesh(new THREE.PlaneGeometry(S * 0.8, 0.2), new THREE.MeshLambertMaterial({ map: texFrom(c, 1, 1) }), 0, 0.75, S / 2 - 0.19, g); }
  solidAround(x + Math.sin(rotY) * (S / 2 - 0.5), z + Math.cos(rotY) * (S / 2 - 0.5), S * 0.42, 0.35, rotY);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) solids.push({ x0: x + sx * S / 2 - 0.08, x1: x + sx * S / 2 + 0.08, z0: z + sz * S / 2 - 0.08, z1: z + sz * S / 2 + 0.08 });
  return g;
}
function foodTruck(x, z, rotY, body, trim, menu) {
  const g = group(x, z, rotY);
  mesh(new THREE.BoxGeometry(4.6, 2.4, 2.3), M(body), -0.4, 1.7, 0, g);                                   // box
  mesh(new THREE.BoxGeometry(1.6, 1.8, 2.2), M(body), 2.7, 1.4, 0, g);                                    // cab
  mesh(new THREE.BoxGeometry(0.05, 0.8, 1.9), M(0x2f3a42), 3.51, 1.75, 0, g);                             // windscreen
  mesh(new THREE.BoxGeometry(3.2, 1.1, 0.05), M(0x1a1a1a), -0.4, 2.0, 1.16, g);                           // the serving hatch, open
  const aw = mesh(new THREE.BoxGeometry(3.4, 0.05, 1.2), M(trim), -0.4, 2.75, 1.65, g); aw.rotation.x = 0.28;
  mesh(new THREE.BoxGeometry(3.3, 0.08, 0.35), M(0xd9d4c8), -0.4, 1.45, 1.3, g);                          // the shelf under the hatch
  for (const wx of [-1.9, 1.0, 2.7]) for (const wz of [-1.15, 1.15]) { const w = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.25, 14), FUR.black, wx, 0.42, wz, g); w.rotation.x = Math.PI / 2; }
  solidAround(x + Math.cos(rotY) * 0.5, z - Math.sin(rotY) * 0.5, 3.4, 1.4, rotY);
}
function bar(x, z, rotY = 0) {
  const g = group(x, z, rotY);
  mesh(new THREE.BoxGeometry(5, 1.1, 0.8), M(0xcc0a5e), 0, 0.55, 0, g); mesh(new THREE.BoxGeometry(5.2, 0.06, 0.95), FUR.black, 0, 1.13, 0, g);
  mesh(new THREE.BoxGeometry(5, 2.2, 0.4), FUR.black, 0, 1.1, -1.6, g);                                  // back shelf
  for (let k = 0; k < 22; k++) { const b = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), M([0x2e7fd6, 0xe8b60f, 0xf2f0eb, 0x6b9a48][k % 4]), -2.2 + k * 0.21, 1.55 + (k % 2) * 0.62, -1.38, g); }
  for (let k = 0; k < 5; k++) { mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 14), FUR.black, -2 + k, 0.78, 0.75, g); mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.76, 6), FUR.black, -2 + k, 0.38, 0.75, g); }
  const make = () => tileCanvas(512, 128, (q, w, h) => { q.fillStyle = '#0b0b0b'; q.fillRect(0, 0, w, h); q.fillStyle = '#f2f0eb'; q.font = '84px Anton, Impact, sans-serif'; q.textAlign = 'center'; q.textBaseline = 'middle'; q.fillText('BAR · NFC', w / 2, h / 2 + 4); });
  const c = make(); SIGNS.push({ c, make });
  mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshLambertMaterial({ map: texFrom(c, 1, 1) }), 0, 2.7, -1.38, g);
  solidAround(x, z, 2.6, 0.5, rotY); solidAround(x - Math.sin(rotY) * 1.6, z - Math.cos(rotY) * 1.6, 2.5, 0.25, rotY);
}
// the market strip: a row of white tents facing the Art Factory, two food trucks, picnic tables and bunting between the tents
const tents = [[-40, -42, 0xcc0a5e, ''], [-40, -34, 0x2e7fd6, ''], [-40, -26, 0x0b0b0b, ''], [-40, -18, 0xcc0a5e, ''], [-40, -10, 0x2e7fd6, '']];   // no signs on the stalls
tents.forEach(([x, z, c, label]) => tent(x, z, c, label, Math.PI / 2));   // counters face east, toward the Art Factory
foodTruck(-40.5, 2, Math.PI / 2, 0xe8b60f, 0xcc0a5e, 'BIFANAS · PREGOS');
foodTruck(-40.5, 13, Math.PI / 2, 0xf2f0eb, 0x2e7fd6, 'PASTÉIS DE NATA');
picnic(-34, -38, Math.PI / 2); picnic(-34, -22, Math.PI / 2); picnic(-34, 7.5, Math.PI / 2);
planterTree(-44, -47); planterAgave(-32.5, -47.5); planterBarrel(-44, 19); planterTree(-32.5, 19);
for (let i = 0; i < tents.length - 1; i++) bunting(V3(-38.5, 2.9, tents[i][1]), V3(-38.5, 2.9, tents[i + 1][1]), 0.5);
bunting(V3(-38.5, 2.9, tents[tents.length - 1][1]), V3(-42.5, 3.4, -2), 0.6);
// the garden bar south of the main stage: a bar, tables, trees, and bunting strung between posts
bar(-26, 72, 0);
picnic(-36, 76); picnic(-30, 79, 0.2); picnic(-17, 77, -0.15); picnic(-12, 70);
bistro(-20, 69.5); bistro(-33, 69.5);
planterTree(-43, 67); planterTree(-43, 81); planterAgave(-8, 82); planterBarrel(-22, 82); planterBarrel(-38, 82);
lounge(-8, 68, -Math.PI / 2);
{ const ps = [[-42, 66], [-42, 82], [-10, 82], [-10, 66]].map(([x, z]) => pole(x, z, 4.2)); for (let i = 0; i < 4; i++) bunting(V3(ps[i].x, 3.9, ps[i].z), V3(ps[(i + 1) % 4].x, 3.9, ps[(i + 1) % 4].z), 0.7); bunting(V3(ps[0].x, 3.9, ps[0].z), V3(ps[2].x, 3.9, ps[2].z), 1.1); bunting(V3(ps[1].x, 3.9, ps[1].z), V3(ps[3].x, 3.9, ps[3].z), 1.1); }
const flags = (() => {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-0.22, 0, 0, 0.22, 0, 0, 0, -0.5, 0], 3)); g.computeVertexNormals();
  const inst = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), flagSpots.length);
  const cols = [0x0b0b0b, 0xcc0a5e, 0xf2f0eb], c = new THREE.Color();
  flagSpots.forEach((f, i) => inst.setColorAt(i, c.set(cols[f.k % 3])));
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(inst);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), one = V3(1, 1, 1);
  return { step(t) { flagSpots.forEach((f, i) => { e.set(0.25 * Math.sin(t * 2.3 + i * 0.7), f.yaw, 0); q.setFromEuler(e); inst.setMatrixAt(i, m4.compose(f.p, q, one)); }); inst.instanceMatrix.needsUpdate = true; } };
})();
{
  const m = new THREE.Mesh(new THREE.PlaneGeometry(BB.w, BB.h), new THREE.MeshLambertMaterial({ map: texFrom(billboardCanvas, 1, 1) }));
  m.rotation.y = Math.PI; m.position.set(BB.x, BB.y, BB.z); scene.add(m);
  box(BB.x - BB.w / 2 - 0.15, BB.x + BB.w / 2 + 0.15, BB.y - BB.h / 2 - 0.15, BB.y + BB.h / 2 + 0.15, -40.1, -40.0, M(0x0b0b0b), false);
}
/* --- community houses: 20 ft containers (6.1 x 2.4 m), open on one long side, doors at the east end --- */
const CONTAINER = { L: 6.06, W: 2.44, H: 2.59 };
// JPEG FRENS house: yellow; the closed long side carries the community's own painted artwork (supplied), the doors its name.
function jpegSide() {
  return tileCanvas(1024, 438, (g, w, h) => {
    if (ART.jpeg.complete && ART.jpeg.naturalWidth) { g.drawImage(ART.jpeg, 0, 0, w, h); return; }
    g.fillStyle = '#e8b60f'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 22) { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x, 0, 7, h); g.fillStyle = 'rgba(255,255,255,.2)'; g.fillRect(x + 12, 0, 4, h); }
    g.fillStyle = '#c99a08'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 16, w, 16);
    g.fillStyle = '#141414'; g.font = '86px Anton, Impact, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('JPEG FRENS', 70, h / 2);
    g.font = '600 22px "IBM Plex Mono", monospace'; g.fillText('HOUSE 01 · NFC 2027', 74, h / 2 + 70);
  });
}
function jpegDoors() {
  return tileCanvas(256, 274, (g, w, h) => {
    g.fillStyle = '#e8b60f'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 18) { g.fillStyle = 'rgba(0,0,0,.1)'; g.fillRect(x, 0, 5, h); }
    g.fillStyle = '#141414'; g.fillRect(w / 2 - 2, 0, 4, h);
    for (const x of [40, 90, 166, 216]) g.fillRect(x, 12, 6, h - 24);
    g.font = '30px Anton, Impact, sans-serif'; g.textAlign = 'center'; g.fillText('JPEG', w / 4, 70); g.fillText('FRENS', w / 4, 104);
  });
}
function container(cx, cz, face, brand = null) {
  const { L, W, H } = CONTAINER, t = 0.08, x0 = cx - L / 2, x1 = cx + L / 2, z0 = cz - W / 2, z1 = cz + W / 2;
  const skin = brand ? brand.skin : containerWhite;
  const side = brand ? matFrom(brand.side, 1, 1) : matFrom(skin, 3, 1), end = matFrom(skin, 1, 1);
  const doors = brand ? matFrom(brand.doors, 1, 1) : end;
  const top = M(brand ? 0xd9a90c : 0xd4d3cc), inside = M(brand ? 0xf2f0eb : 0xbfbdb4);
  const back = face > 0 ? [z0, z0 + t] : [z1 - t, z1];
  box(x0, x1, 0, H, back[0], back[1], [end, end, top, top, face > 0 ? inside : side, face > 0 ? side : inside]);
  box(x0, x0 + t, 0, H, z0, z1, [inside, end, top, top, end, end]); box(x1 - t, x1, 0, H, z0, z1, [doors, inside, top, top, end, end]);
  box(x0, x1, H - t, H, z0, z1, [end, end, top, inside, side, side], false);
  box(x0 - 0.05, x1 + 0.05, 0, 0.12, z0, z1, M(0x6f6e69), false);                     // floor rail
  box(x0 + 0.3, x1 - 0.3, 0.9, 1.0, face > 0 ? z1 - 0.5 : z0, face > 0 ? z1 : z0 + 0.5, M(0x1a1a1a), false);   // counter at the open side
  return { x: cx, z: cz - face * 0.4 };
}
const JPEG = { skin: containerSkin('#e8b60f'), side: jpegSide(), doors: jpegDoors() };
// House 02 sits at the mouth of the alley, the first thing you see walking south from the wall: it is the JPEG FRENS one.
const houses = [container(-27, 27, 1), container(-12, 25.5, 1, JPEG), container(-4, 78, -1), container(4, 23, 1)];
/* --- main stage, silos, fence, sheds --- */
hollow({ x0: -40, x1: -12, z0: 52, z1: 64, h: 8, facade: pinkFacade, base: 0xc47e6c, doors: { n: [-26, -17], e: [58] } });
box(-39.7, -31, 0, 1.1, 52.3, 63.7, M(0x151515));                                         // the stage itself, at the west end
box(-39.7, -39.4, 1.1, 7.8, 53, 63, M(0x2a0a18), false);                                  // a dark backdrop
const siloMat = matFrom(siloSkin, 1, 2);
for (let i = 0; i < 5; i++) cyl(6 + i * 5.2, 62, 2.6, 0, 28, siloMat);
hollow({ x0: 3, x1: 30, z0: 64.6, z1: 72, h: 34, facade: siloTowerFacade, bay: 6, base: 0xebe6da, doors: { w: [68.3] } });   // the north face is behind the silos, so the way in is from the west
/* The perimeter wall: rendered concrete blocks with a coping, and climbing vines in flower over most of it.
   Four vines, each its own canvas with a transparent ground: bougainvillea (magenta bracts), jasmine (white stars),
   morning glory (violet trumpets) and nasturtium (orange). Patches of different lengths and heights, some spilling
   over the top of the wall. */
const blockWall = tileCanvas(256, 128, (g, w, h) => {
  g.fillStyle = '#b3ac9f'; g.fillRect(0, 0, w, h); grime(g, w, h, 1800, .1);
  g.strokeStyle = 'rgba(60,55,48,.28)'; g.lineWidth = 2;
  for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); for (let x = (y / 32) % 2 ? 0 : 32; x < w; x += 64) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 32); g.stroke(); } }
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(40,50,30,.18)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
function fenceBox(x0, x1, z0, z1) {
  const len = Math.max(x1 - x0, z1 - z0), mat = matFrom(blockWall, Math.round(len / 2.6), 1);
  box(x0, x1, 0, 2.6, z0, z1, mat);
  box(x0 - 0.08, x1 + 0.08, 2.6, 2.72, z0 - 0.08, z1 + 0.08, M(0xd6d0c4), false);      // coping
}
fenceBox(-46, 34, -50, -49.6); fenceBox(-46, 34, 84, 84.4); fenceBox(-46, -45.6, -50, 84); fenceBox(33.6, 34, -50, 84);

const VINES = {
  bougainvillea: { leaf: ['#3f6b35', '#4f7d3c', '#2f5a2c'], flower(g, x, y, s, r) { g.fillStyle = r() < .5 ? '#cc0a5e' : '#e0368a'; for (let k = 0; k < 3; k++) { const a = k * 2.1 + r(); g.beginPath(); g.ellipse(x + Math.cos(a) * s * .45, y + Math.sin(a) * s * .45, s * .55, s * .38, a, 0, 6.3); g.fill(); } g.fillStyle = '#f6e6a8'; g.beginPath(); g.arc(x, y, s * .15, 0, 6.3); g.fill(); }, density: 0.55 },
  jasmine:       { leaf: ['#2e5a32', '#3a6a3a', '#264c2a'], flower(g, x, y, s) { g.fillStyle = '#fbf7ee'; for (let k = 0; k < 5; k++) { const a = k * 1.2566; g.beginPath(); g.ellipse(x + Math.cos(a) * s * .35, y + Math.sin(a) * s * .35, s * .32, s * .14, a, 0, 6.3); g.fill(); } g.fillStyle = '#e8d38a'; g.beginPath(); g.arc(x, y, s * .1, 0, 6.3); g.fill(); }, density: 0.7 },
  morningglory:  { leaf: ['#4a7a3e', '#5b8a44', '#3d6a36'], flower(g, x, y, s) { const gr = g.createRadialGradient(x, y, 0, x, y, s * .6); gr.addColorStop(0, '#fff6fb'); gr.addColorStop(.25, '#c7a3ff'); gr.addColorStop(1, '#5a3fd6'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, s * .6, 0, 6.3); g.fill(); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.5; for (let k = 0; k < 5; k++) { const a = k * 1.2566; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * s * .58, y + Math.sin(a) * s * .58); g.stroke(); } }, density: 0.45 },
  nasturtium:    { leaf: ['#6b9a48', '#7aa852', '#5a8a3c'], flower(g, x, y, s, r) { g.fillStyle = r() < .5 ? '#f08a1c' : '#e8b60f'; for (let k = 0; k < 5; k++) { const a = k * 1.2566 + .3; g.beginPath(); g.ellipse(x + Math.cos(a) * s * .32, y + Math.sin(a) * s * .32, s * .34, s * .26, a, 0, 6.3); g.fill(); } g.fillStyle = '#b3260f'; g.beginPath(); g.arc(x, y, s * .12, 0, 6.3); g.fill(); }, density: 0.5 },
};
/* One continuous vine along the whole wall: several stems run horizontally in long overlapping waves, thick with
   leaves, and all four flowers are mixed through it. The texture wraps seamlessly left to right, so it can run the
   full length of every wall; it sits over the top of the wall a little and drops tendrils down the face. */
function vineBand(seed) {
  const rnd = mulberry32(seed), kinds = Object.keys(VINES);
  return tileCanvas(2048, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const wrap = (fn) => { for (const dx of [-w, 0, w]) fn(dx); };          // draw near the seams on both sides
    // stems: smooth waves, period an exact fraction of the tile so they meet themselves at the seam
    const stems = Array.from({ length: 6 }, (_, k) => ({ y0: h * (0.14 + 0.13 * k + rnd() * 0.05), amp: 20 + rnd() * 36, cyc: 1 + Math.floor(rnd() * 3), ph: rnd() * 6.28, cyc2: 3 + Math.floor(rnd() * 3), amp2: 6 + rnd() * 10 }));
    const yAt = (st, x) => st.y0 + st.amp * Math.sin((x / w) * Math.PI * 2 * st.cyc + st.ph) + st.amp2 * Math.sin((x / w) * Math.PI * 2 * st.cyc2);
    g.strokeStyle = '#4b3a28'; g.lineCap = 'round';
    stems.forEach((st) => { g.lineWidth = 3 + rnd() * 2; g.beginPath(); for (let x = 0; x <= w; x += 8) (x ? g.lineTo(x, yAt(st, x)) : g.moveTo(x, yAt(st, x))); g.stroke(); });
    // tendrils hanging down from the stems
    for (let k = 0; k < 40; k++) {
      const st = stems[Math.floor(rnd() * stems.length)], x = rnd() * w, y = yAt(st, x), len = 20 + rnd() * 70;
      wrap((dx) => { g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + dx, y); g.quadraticCurveTo(x + dx + (rnd() - .5) * 30, y + len * .6, x + dx + (rnd() - .5) * 20, y + len); g.stroke(); });
    }
    // leaves, dense along every stem
    const leafCols = ['#2e5a32', '#3f6b35', '#4f7d3c', '#5b8a44', '#3a6a3a', '#6b9a48'];
    stems.forEach((st) => {
      for (let x = 0; x < w; x += 7) {
        const y = yAt(st, x);
        for (let k = 0; k < 2; k++) {
          const a = rnd() * 6.3, d = 6 + rnd() * 16, lx = x + Math.cos(a) * d, ly = y + Math.sin(a) * d * 1.2, col = leafCols[Math.floor(rnd() * leafCols.length)], rx = 8 + rnd() * 7, ry = 4.5 + rnd() * 3.5;
          wrap((dx) => { g.fillStyle = col; g.beginPath(); g.ellipse(lx + dx, ly, rx, ry, a, 0, 6.3); g.fill(); });
        }
      }
    });
    // flowers: every kind, mixed, in loose clusters along the stems
    stems.forEach((st) => {
      for (let x = rnd() * 30; x < w; x += 14 + rnd() * 30) {
        const kind = kinds[Math.floor(rnd() * kinds.length)], V = VINES[kind];
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const fx = x + (rnd() - .5) * 26, fy = yAt(st, fx) + (rnd() - .5) * 26, size = 10 + rnd() * 9, r2 = mulberry32(Math.floor(rnd() * 1e9));
          wrap((dx) => { const r3 = mulberry32(Math.floor(r2() * 1e9)); V.flower(g, fx + dx, fy, size, r3); });
        }
      }
    });
  });
}
const vineBands = [vineBand(11), vineBand(29)];
// run it along the inside face of every wall, from just below the coping's height over the top
{
  const H = 2.35, TILE = 9;     // the band stays below the coping (the wall is 2.6 m); one tile covers 9 m of wall
  const runs = [[-45.6, 33.6, -49.58, 'x', 1], [-45.6, 33.6, 83.98, 'x', -1], [-49.6, 84, -45.58, 'z', 1], [-49.6, 84, 33.58, 'z', -1]];
  runs.forEach(([a0, a1, fixed, axis, sgn], i) => {
    const len = a1 - a0, tex = new THREE.CanvasTexture(vineBands[i % 2]);
    tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(len / TILE, 1); tex.offset.x = i * 0.37; tex.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H), new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }));
    const mid = (a0 + a1) / 2, y = 0.1 + H / 2;
    if (axis === 'x') { m.position.set(mid, y, fixed); if (sgn < 0) m.rotation.y = Math.PI; }
    else { m.position.set(fixed, y, mid); m.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2; }
    scene.add(m);
  });
}
hollow({ x0: 14, x1: 30, z0: -40, z1: 30, h: 7, facade: creamFacade, base: 0xe9e3d4, doors: { w: [-25, 0, 20] } });   // the long sheds east of the warehouse

/* ---------------- ON THE WALL: west face of Armazém 0108, z -26..-4, 8 m tall ---------------- */
const WALL = { x: -6.02, z0: -26, z1: -4, h: 8 };
/* The layout of the real wall, from NFC's photo of Armazém 0108 (onthewall.nfcsummit.com, "The real wall").
   Three black bays between white pilasters. Upper half: the 50 faces, 4 columns a bay, 6 rows, a window in the
   middle of each bay and the ARMAZÉM 0108 plaque under the middle one. Lower half: the 500 names, numbered left to
   right across all three bays: 7 + 7 + 8 = 22 columns. Two full rows run above the lower windows (so ESSJAYNE, 19,
   sits directly above LAMPWRECKED, 41, over the right-hand window); then 22 rows that only have cells beside the
   windows (2 left and 2 right in bays 1 and 2, 2 left and 3 right in bay 3); a short row of 3 under the first window;
   then full rows to the end, where the last row stops at 500 partway through the middle bay. */
const NCOLS = 22, NROWS = 33, BAY_START = [0, 7, 14], BAY_N = [7, 7, 8];
const colBay = (c) => (c < 7 ? 0 : c < 14 ? 1 : 2);
const WINDOWS = [{ c0: 2, c1: 4, r0: 2, r1: 23 }, { c0: 9, c1: 11, r0: 2, r1: 24 }, { c0: 16, c1: 18, r0: 2, r1: 24 }];   // inclusive, in name-grid cells
const POS = (() => {
  const cells = [], all = [...Array(NCOLS).keys()];
  const side = [0, 1, 5, 6, 7, 8, 12, 13, 14, 15, 19, 20, 21];
  for (let r = 0; r < 2; r++) all.forEach((c) => cells.push({ r, c }));
  for (let r = 2; r < 24; r++) side.forEach((c) => cells.push({ r, c }));
  [2, 3, 4].forEach((c) => cells.push({ r: 24, c }));
  for (let r = 25; r < 32; r++) all.forEach((c) => cells.push({ r, c }));
  for (let c = 0; c < 13; c++) cells.push({ r: 32, c });
  return cells;                                           // POS[i] for name slot i (panel i + 1); exactly 500
})();
const CELL_AT = new Map(POS.map((p, i) => [p.r * NCOLS + p.c, i]));
const wallCanvas = document.createElement('canvas'); wallCanvas.width = 2816; wallCanvas.height = 2048;
const wallTex = new THREE.CanvasTexture(wallCanvas); wallTex.anisotropy = 8;
const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(WALL.z1 - WALL.z0, WALL.h), new THREE.MeshLambertMaterial({ map: wallTex }));
wallMesh.rotation.y = -Math.PI / 2; wallMesh.position.set(WALL.x, WALL.h / 2, (WALL.z0 + WALL.z1) / 2); scene.add(wallMesh);
const WL = (() => {
  const W = wallCanvas.width, H = wallCanvas.height, pil = 150;
  const bayW = (W - 4 * pil) / 3;
  const bays = [0, 1, 2].map((i) => ({ x: pil + i * (bayW + pil), w: bayW }));
  const top = 120, faceTop = 150, faceBot = 1120, nameTop = 1150, nameBot = 1990;
  const colX = [];
  BAY_N.forEach((n, b) => { const cw = (bays[b].w - 30) / n; for (let i = 0; i < n; i++) colX.push({ x: bays[b].x + 15 + i * cw, w: cw }); });
  return { W, H, pil, bays, top, faceTop, faceBot, nameTop, nameBot, rowH: (nameBot - nameTop) / NROWS, colX };
})();
function cellRect(r, c) { const x = WL.colX[c]; return { x: x.x + 2, y: WL.nameTop + r * WL.rowH + 2, w: x.w - 4, h: WL.rowH - 4 }; }
function slotRect(i) { const p = POS[i]; return cellRect(p.r, p.c); }
function drawWindow(g, x, y, w, h, fan) {
  g.fillStyle = '#ece8df'; g.fillRect(x - 10, y - 10, w + 20, h + 20);
  g.fillStyle = '#37403f'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#ece8df'; g.lineWidth = 8;
  for (let k = 1; k < 3; k++) { g.beginPath(); g.moveTo(x, y + (h * k) / 3); g.lineTo(x + w, y + (h * k) / 3); g.stroke(); }
  g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x + 6, y + 6, w * 0.4, h * 0.2);
  if (fan) { g.fillStyle = '#c9c4b8'; g.fillRect(x + 6, y + 6, w * 0.42, h / 3 - 10); g.fillStyle = '#2a2a2a'; g.beginPath(); g.arc(x + 6 + w * 0.21, y + h / 6, Math.min(w, h) * 0.11, 0, 6.3); g.fill(); }
}
// the portraits of the wall (src/generated/portraits.ts, copied at build time by scripts/snapshot-portraits.ts): display only
const portraitImages = new Map(Object.entries(PORTRAITS).map(([panel, url]) => { const img = new Image(); img.src = url; return [Number(panel), img]; }));
function drawWall(g, state) {
  const { W, H } = WL;
  g.fillStyle = '#ece8df'; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 4; k++) { g.fillStyle = '#e2ddd2'; g.fillRect(k * (WL.bays[0].w + WL.pil), 0, WL.pil, H); }   // pilasters
  for (const b of WL.bays) { g.fillStyle = '#0d0d0d'; g.fillRect(b.x, 40, b.w, H - 40 - 40); }
  g.fillStyle = '#0d0d0d'; g.fillRect(WL.bays[0].x, 40, WL.bays[2].x + WL.bays[2].w - WL.bays[0].x, 70);           // the black band across the top
  g.fillStyle = '#9c968c'; g.fillRect(0, H - 40, W, 40);
  g.fillStyle = '#d8d4cb'; g.font = '84px Anton, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('ON THE WALL', W / 2, 92);
  g.font = 'italic 600 26px "IBM Plex Mono", monospace'; g.textAlign = 'right'; g.fillText('NFC SUMMIT · MAY 2027', WL.bays[2].x + WL.bays[2].w - 30, 80);
  // the faces: 4 columns x 6 rows a bay, numbered 01-50 like the real wall
  const fRowH = (WL.faceBot - WL.faceTop) / 6;
  let n = 1;
  for (let r = 0; r < 6; r++) for (let b = 0; b < 3; b++) for (let k = 0; k < 4; k++) {
    const inWin = r >= 1 && r <= 3 && (k === 1 || k === 2), sign = b === 1 && r === 4 && (k === 1 || k === 2);
    if (inWin || sign) continue;
    const cw = WL.bays[b].w / 4, sz = Math.min(cw, fRowH) * 0.78, x = WL.bays[b].x + k * cw + (cw - sz) / 2, y = WL.faceTop + r * fRowH + (fRowH - sz) / 2;
    g.fillStyle = '#1b1b1b'; g.fillRect(x, y, sz, sz); g.strokeStyle = '#2c2c2c'; g.lineWidth = 3; g.strokeRect(x, y, sz, sz);
    // a taken portrait (panel 500 + n), cropped square from its centre; an empty frame keeps its number
    const img = n <= 50 ? portraitImages.get(500 + n) : undefined;
    if (img && img.complete && img.naturalWidth) {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x + 4, y + 4, sz - 8, sz - 8);
      n += 1; continue;
    }
    if (n <= 50) { g.fillStyle = '#e8e4da'; g.fillRect(x + 8, y + 8, 40, 24); g.fillStyle = '#0d0d0d'; g.font = '600 18px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText(String(n).padStart(2, '0'), x + 28, y + 21); n += 1; }
  }
  WL.bays.forEach((b, i) => { const cw = b.w / 4; drawWindow(g, b.x + cw + 18, WL.faceTop + fRowH + 14, 2 * cw - 36, 3 * fRowH - 28, i !== 1); });
  { const b = WL.bays[1], cw = b.w / 4, x = b.x + cw + 30, y = WL.faceTop + 4 * fRowH + 40, w = 2 * cw - 60, h = fRowH - 80;
    g.fillStyle = '#e8e4da'; g.fillRect(x, y, w, h); g.fillStyle = '#2c3e5a'; g.font = '44px Anton, Impact, sans-serif'; g.textAlign = 'center'; g.fillText('ARMAZÉM – 0108', x + w / 2, y + h * 0.4);
    g.font = '600 16px "IBM Plex Mono", monospace'; g.fillText('UNICORN FACTORY · LISBOA', x + w / 2, y + h * 0.75); }
  // the lower windows, set into the names grid
  WINDOWS.forEach((wn, i) => { const a = cellRect(wn.r0, wn.c0), z = cellRect(wn.r1, wn.c1); drawWindow(g, a.x + 10, a.y + 6, z.x + z.w - a.x - 20, z.y + z.h - a.y - 12, false); });
  // the names
  g.font = '600 15px "IBM Plex Mono", monospace'; g.textAlign = 'center';
  for (let i = 0; i < 500; i++) {
    const s = slotRect(i), name = NAME_AT.get(i);
    if (state.gaps.has(i)) {
      g.strokeStyle = '#2E7FD6'; g.lineWidth = 3; g.setLineDash([6, 5]); g.strokeRect(s.x, s.y, s.w, s.h); g.setLineDash([]);
    } else if (name) {
      g.fillStyle = state.returned.has(i) ? '#2E7FD6' : '#ece8df'; g.fillRect(s.x, s.y, s.w, s.h);
      g.fillStyle = state.returned.has(i) ? '#ece8df' : '#0d0d0d';
      // fit the whole name on its tile: squeeze it sideways first (it stays tall and readable), then shrink if it must
      g.save(); g.beginPath(); g.rect(s.x, s.y, s.w, s.h); g.clip();
      let fsz = 15; g.font = `600 ${fsz}px "IBM Plex Mono", monospace`;
      const room = s.w - 6; let tw = g.measureText(name).width;
      while (tw * 0.55 > room && fsz > 8) { fsz -= 1; g.font = `600 ${fsz}px "IBM Plex Mono", monospace`; tw = g.measureText(name).width; }
      const sx = Math.min(1, room / tw);
      g.translate(s.x + s.w / 2, s.y + s.h / 2 + 1); g.scale(sx, 1); g.fillText(name, 0, 0); g.restore();
    } else { g.strokeStyle = '#2b2b2b'; g.lineWidth = 2; g.strokeRect(s.x, s.y, s.w, s.h); }
  }
}

/* ---------------- hiding spots: fixed, searchable; a run decides which hold names ---------------- */
// the 67 places a package can be: the server's own list (core.ts, same order: a spot id is its index), in metres
const SPOTS = CORE_SPOTS.map(([x, z, where]) => ({ x: x / 100, z: z / 100, where }));
// a prop at each spot so players know what to check
/* Packages: every hiding spot is a package. Most are gift boxes (wrapped paper, ribbon, a bow) that bob and jiggle when
   you come close; a few are floating mystery cubes with a "?" on every face. Opening one pops it: the gift's lid flies
   off and the box folds flat; the cube cracks into triangle shards. An opened package is gone for good. */
const WRAPS = [['#cc0a5e', '#e8b60f'], ['#2e7fd6', '#f2f0eb'], ['#e8b60f', '#cc0a5e'], ['#f2f0eb', '#2e7fd6'], ['#151515', '#ff6fae']];
function wrapPaper(paper, ribbon, pattern) {
  return tileCanvas(128, 128, (g, w, h) => {
    g.fillStyle = paper; g.fillRect(0, 0, w, h);
    g.fillStyle = ribbon; g.globalAlpha = 0.55;
    if (pattern === 0) for (let y = 8; y < h; y += 22) for (let x = ((y / 22) % 2) * 11 + 8; x < w; x += 22) { g.beginPath(); g.arc(x, y, 4, 0, 6.3); g.fill(); }
    else if (pattern === 1) for (let x = -h; x < w; x += 20) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + h, 0); g.lineTo(x + h + 7, 0); g.lineTo(x + 7, h); g.fill(); }
    else for (let y = 6; y < h; y += 26) for (let x = ((y / 26) % 2) * 13 + 4; x < w; x += 26) { g.beginPath(); g.moveTo(x, y + 12); g.lineTo(x + 7, y); g.lineTo(x + 14, y + 12); g.fill(); }
    g.globalAlpha = 1;
  });
}
const mysteryFace = tileCanvas(256, 256, (g, w, h) => {
  g.fillStyle = '#151515'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffb3d4'; g.lineWidth = 14; g.strokeRect(12, 12, w - 24, h - 24);
  g.fillStyle = '#cc0a5e'; g.font = '200px Anton, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', w / 2, h / 2 + 12);
});
const MYSTERY = new Set(SPOTS.map((sp, i) => (/silos|billboard|sacks|ball pit/.test(sp.where) ? i : -1)).filter((i) => i >= 0));   // floating cubes; the ball-pit one hovers over the balls
const packages = SPOTS.map((sp, i) => {
  const root = new THREE.Group(); root.position.set(sp.x, 0, sp.z); scene.add(root);
  const pk = { root, i, kind: MYSTERY.has(i) ? 'cube' : 'gift', opened: -1, shards: [], seed: i * 1.37 };
  if (pk.kind === 'gift') {
    const [paper, ribbon] = WRAPS[i % WRAPS.length], size = 0.55 + ((i * 37) % 7) * 0.05;
    const pm = new THREE.MeshLambertMaterial({ map: texFrom(wrapPaper(paper, ribbon, i % 3), 1, 1) }), rm = new THREE.MeshLambertMaterial({ color: new THREE.Color(ribbon) });
    const body = new THREE.Group(); root.add(body);
    const add = (parent, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
    const bh = size * 0.78;
    add(body, new THREE.BoxGeometry(size, bh, size), pm, 0, bh / 2, 0);
    add(body, new THREE.BoxGeometry(size * 0.16, bh + 0.004, size + 0.006), rm, 0, bh / 2, 0);
    add(body, new THREE.BoxGeometry(size + 0.006, bh + 0.004, size * 0.16), rm, 0, bh / 2, 0);
    const lid = new THREE.Group(); lid.position.y = bh; root.add(lid);
    add(lid, new THREE.BoxGeometry(size * 1.08, size * 0.18, size * 1.08), pm, 0, size * 0.09, 0);
    add(lid, new THREE.BoxGeometry(size * 0.17, size * 0.185, size * 1.09), rm, 0, size * 0.09, 0);
    add(lid, new THREE.BoxGeometry(size * 1.09, size * 0.185, size * 0.17), rm, 0, size * 0.09, 0);
    for (const sgn of [-1, 1]) { const loop = add(lid, new THREE.TorusGeometry(size * 0.16, size * 0.05, 8, 18), rm, sgn * size * 0.15, size * 0.3, 0); loop.rotation.set(0, Math.PI / 2, sgn * 0.5); loop.scale.set(1, 1.35, 1); }
    add(lid, new THREE.SphereGeometry(size * 0.07, 10, 8), rm, 0, size * 0.2, 0);
    Object.assign(pk, { body, lid, size });
  } else {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial({ map: texFrom(mysteryFace, 1, 1) }));
    cube.position.y = 1.35; root.add(cube);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 24), new THREE.MeshBasicMaterial({ color: 0xcc0a5e, transparent: true, opacity: 0.35, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03; root.add(glow);
    Object.assign(pk, { cube, glow });
  }
  return pk;
});
const shardGeo = new THREE.BufferGeometry(); shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.16, 0, -0.14, -0.08, 0, 0.14, -0.08, 0], 3));
const shardMats = [0xcc0a5e, 0x151515, 0xffb3d4].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true }));
function resetPackages() {
  packages.forEach((pk) => {
    pk.opened = -1; pk.root.visible = !(run && run.inactive.has(pk.i)); pk.root.rotation.set(0, 0, 0);
    if (pk.kind === 'gift') { pk.body.scale.set(1, 1, 1); pk.lid.position.set(0, pk.size * 0.78, 0); pk.lid.rotation.set(0, 0, 0); pk.lid.visible = true; }
    else { pk.cube.visible = true; pk.cube.scale.setScalar(1); pk.glow.visible = true; pk.shards.forEach((m) => pk.root.remove(m)); pk.shards = []; }
  });
}
function openPackage(pk, t) {
  pk.opened = t;
  if (pk.kind === 'cube') {
    pk.cube.visible = false; pk.glow.visible = false;
    for (let k = 0; k < 22; k++) {
      const m = new THREE.Mesh(shardGeo, shardMats[k % 3].clone()); m.position.set(0, 1.35, 0);
      const a = Math.random() * 6.28, e = (Math.random() - 0.3) * 1.6, sp = 2 + Math.random() * 3;
      m.userData = { v: new THREE.Vector3(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 1.5, Math.sin(a) * Math.cos(e) * sp), w: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12) };
      m.scale.setScalar(0.6 + Math.random() * 1.2); pk.root.add(m); pk.shards.push(m);
    }
  }
}
function stepPackages(t, dt) {
  packages.forEach((pk, i) => {
    if (!pk.root.visible) return;
    if (run && pk.opened < 0 && run.searched.has(i)) openPackage(pk, t);
    const near = Math.hypot(pk.root.position.x - P.x, pk.root.position.z - P.z);
    if (pk.opened < 0) {
      const searching = run && run.searching && run.searching.spot === i;
      // shy until you come close, then a jiggle every so often; a hard shake while it is being searched
      const jig = searching ? 0.12 * Math.sin(t * 40) : near < 6 ? 0.07 * Math.sin(t * 18) * Math.max(0, Math.sin(t * 1.9 + pk.seed) - 0.6) * 2.5 : 0;
      if (pk.kind === 'gift') { pk.root.position.y = (inPit(pk.root.position.x, pk.root.position.z) ? PIT.top - 0.05 : 0.03) + 0.03 * Math.sin(t * 2 + pk.seed); pk.root.rotation.set(jig * 0.5, Math.sin(t * 0.4 + pk.seed) * 0.15, jig); }
      else { pk.cube.position.y = 1.35 + 0.12 * Math.sin(t * 1.6 + pk.seed); pk.cube.rotation.set(0.35 + jig, t * 0.7 + pk.seed, 0.25 + jig); pk.glow.material.opacity = 0.25 + 0.15 * Math.sin(t * 3 + pk.seed); }
      return;
    }
    const a = t - pk.opened;
    if (pk.kind === 'gift') {
      // the lid pops up and tumbles away; the box folds flat
      pk.lid.position.y = pk.size * 0.78 + 3.2 * a - 4.9 * a * a + 0.3; pk.lid.position.x = 0.9 * a; pk.lid.rotation.set(a * 7, a * 3, a * 5);
      pk.body.scale.y = Math.max(0.001, 1 - a / 0.35);
      if (pk.lid.position.y < 0) pk.lid.visible = false;
    } else {
      pk.shards.forEach((m) => { const u = m.userData; u.v.y -= 6 * dt; m.position.addScaledVector(u.v, dt); m.rotation.x += u.w.x * dt; m.rotation.y += u.w.y * dt; m.rotation.z += u.w.z * dt; m.material.opacity = Math.max(0, 1 - a / 1.1); });
    }
    if (a > 1.2) pk.root.visible = false;
  });
}
const spotMarks = SPOTS.map((s) => {
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.7, 4.0, 48), new THREE.MeshBasicMaterial({ color: 0x2E7FD6, transparent: true, opacity: 0 }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(s.x, 0.05, s.z); scene.add(ring);
  return ring;
});
// keep spot props from trapping the player where they stand: spots sit beside props, never inside a solid

/* ---------------- run state: a picture of the server's run ----------------
   `run` keeps the prototype's shape (the drawing code reads it), refilled by follow() from every state the page gets.
   Spots are spot ids (0..66), names are wall slots (panel - 1), times are seconds from START on the server clock. */
let run = null;
let sv = null;                 // the state on screen: the server's, with the player's own queued inputs applied
let practiceRun = false;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function blankRun() {
  return { clock: 0, elapsed: 0, fx: {}, known: new Set(), hidden: new Map(), inactive: new Set(), searched: new Set(), gaps: new Set(), returned: new Set(),
    carrying: [], searching: null, vip: false, done: false, waiting: false, startTick: 0, endTick: null };
}
function follow(s) {
  const p = s.play, r = run;
  r.inactive = new Set(SPOTS.map((_, i) => i).filter((i) => !p.spots.includes(i)));
  r.searched = new Set(r.inactive);
  r.hidden = new Map();
  p.spots.forEach((spot, k) => {
    if (p.opened[k]) r.searched.add(spot);
    else if (p.fixed[k] === NAME) r.hidden.set(spot, true);   // a closed package a power has shown to hold a name
  });
  r.known = new Set(p.scan.map((k) => p.spots[k]));
  const slots = p.names.map((n) => n - 1);
  r.returned = new Set(slots.slice(0, p.placed)); r.gaps = new Set(slots.slice(p.placed)); r.carrying = slots.slice(p.placed, p.found);
  r.vip = p.vip; r.done = s.gameOver;
  // the hunt's clock starts at GO (START on the how-to card); until then the run waits on the card
  r.waiting = p.goTick === null && !s.gameOver;
  r.startTick = p.goTick ?? s.tick; r.endTick = p.endTick;
  r.fx = {}; OBJECTS.forEach((o, i) => { if (p.fx[i]) r.fx[o.id] = (p.fx[i] - r.startTick) * TICK_SEC; });
  r.searching = p.searching ? { spot: p.spots[p.searching[0]], until: (p.searching[1] - r.startTick) * TICK_SEC } : null;
}
/** What changed between two states of the same run, played as the prototype played it: the search sound, the find,
 *  the name, the object card, the names flying back to the wall, the end. */
function playEvents(prev, s) {
  const a = prev.play, b = s.play;
  if (b.searching && !a.searching) { sound.fx('search'); actBtn.disabled = true; actBtn.textContent = '…'; }
  // packages opened: the searched one first, then the ones a power opened, in order (the order the server dealt names in)
  const opened = b.spots.map((_, k) => k).filter((k) => !a.opened[k] && b.opened[k]).sort((x, y) => b.opened[x] - b.opened[y] || x - y);
  let nameIdx = a.found, objIdx = a.objectsFound;
  for (const k of opened) {
    const spot = b.spots[k], what = b.fixed[k];
    spotMarks[spot].material.color.set(0x777777);
    if (what === NAME) {
      const slot = b.names[nameIdx++] - 1;
      sound.fx('name'); confetti.burst(SPOTS[spot].x, 1.0, SPOTS[spot].z);
      if (nameIdx === RULES.hidden) toast(`Found ${NAME_AT.get(slot)}. That's the last one: return to the wall!`, 4);
      else toast(`Found ${NAME_AT.get(slot)} ${SPOTS[spot].where}.`);
    } else if (what === OBJECT) {
      const o = OBJECTS[b.objects[objIdx++]];
      sound.fx(o.kind === 'bad' ? 'joke' : 'good'); applyObject(o, spot);
    } else if (b.opened[k] === 1) { sound.fx('empty'); toast(nothingLine(), 3.2); }
  }
  if (b.placed > a.placed) placeAll(b.names.slice(a.placed, b.placed).map((n) => n - 1));
  if (b.placed !== a.placed || b.names.join() !== a.names.join()) redrawWall();
  showCarry();
  $('found').textContent = `${b.placed}/${RULES.hidden}`;
}
function redrawWall() { drawWall(wallCanvas.getContext('2d'), run || { gaps: new Set(), returned: new Set() }); wallTex.needsUpdate = true; }

/* ---------------- player and input ---------------- */
const P = { x: -11, z: 14, yaw: Math.PI, pitch: 0, r: 0.35, eye: 1.6 };   // starts in the alley, facing north toward the wall
// Start at the back of the alley's north end, looking south: the billboard and ON THE WALL on your left, the Art Factory on your right.
const START = { x: -11, z: -46.5, yaw: Math.PI + 0.45, pitch: 0.05 };
function resetPlayer() { P.x = START.x; P.z = START.z; P.yaw = START.yaw; P.pitch = START.pitch; }
const keys = new Set();
const playing = () => Boolean(run && !run.done && !run.waiting);
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'Enter' && run && !run.done && run.waiting && !$('howto').hidden) { e.preventDefault(); goNow(); return; }
  if (!playing()) return;
  keys.add(e.key.toLowerCase());
  if ((e.key === 'Enter' || e.key === 'e' || e.key === ' ') && !actBtn.disabled && !actBtn.hidden && !e.repeat) { e.preventDefault(); actBtn.click(); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
const stick = host.querySelector('#stick'), knob = host.querySelector('#knob');
let moveTouch = null, lookTouch = null, mv = { x: 0, y: 0 };
const el = renderer.domElement;
/* Mouse: the cursor stays free and moving it turns the view, no button held. A cursor resting near the left or right
   edge keeps turning that way (the screen ends, the yard does not). Over a button (SEARCH, FINISH, music) nothing turns,
   so the buttons are easy to click. Touch keeps the prototype's drag zones. */
const EDGE = 0.1, EDGE_SPEED = 1.8;          // the outer 10 % of the width; up to 1.8 rad/s at the very edge
let edgeTurn = 0;                            // -1..1: how far into an edge zone the cursor rests (negative: left)
const overButton = (e) => e.target instanceof Element && Boolean(e.target.closest('button'));
host.addEventListener('mousemove', (e) => {
  edgeTurn = 0;
  if (TOUCH || !playing() || overButton(e)) return;
  const k = 0.0035, flip = fxOn('token') ? -1 : 1;
  P.yaw -= e.movementX * k * flip; P.pitch = Math.max(-1.1, Math.min(1.1, P.pitch - e.movementY * k));
  const box = host.getBoundingClientRect(), u = (e.clientX - box.left) / box.width;
  edgeTurn = u < EDGE ? -(1 - u / EDGE) : u > 1 - EDGE ? (u - (1 - EDGE)) / EDGE : 0;
});
host.addEventListener('mouseleave', () => { edgeTurn = 0; });
addEventListener('blur', () => { edgeTurn = 0; });
el.addEventListener('pointerdown', (e) => {
  if (!playing() || e.pointerType === 'mouse') return;     // the mouse looks without a press
  try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  const box = host.getBoundingClientRect();
  if (e.pointerType !== 'mouse' && e.clientX - box.left < box.width * 0.45 && !moveTouch) {
    moveTouch = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    stick.hidden = false; stick.style.left = (e.clientX - box.left - 60) + 'px'; stick.style.top = (e.clientY - box.top - 60) + 'px'; knob.style.transform = '';
  } else if (!lookTouch) lookTouch = { id: e.pointerId, lx: e.clientX, ly: e.clientY };
});
el.addEventListener('pointermove', (e) => {
  if (moveTouch && e.pointerId === moveTouch.id) {
    let dx = e.clientX - moveTouch.ox, dy = e.clientY - moveTouch.oy; const d = Math.hypot(dx, dy), m = 50;
    if (d > m) { dx *= m / d; dy *= m / d; }
    mv = { x: dx / m, y: dy / m }; knob.style.transform = `translate(${dx}px,${dy}px)`;
  } else if (lookTouch && e.pointerId === lookTouch.id) {
    const k = e.pointerType === 'mouse' ? 0.004 : 0.006;
    P.yaw -= (e.clientX - lookTouch.lx) * k * (fxOn('token') ? -1 : 1); P.pitch = Math.max(-1.1, Math.min(1.1, P.pitch - (e.clientY - lookTouch.ly) * k));
    lookTouch.lx = e.clientX; lookTouch.ly = e.clientY;
  }
});
const endPointer = (e) => {
  if (moveTouch && e.pointerId === moveTouch.id) { moveTouch = null; mv = { x: 0, y: 0 }; stick.hidden = true; }
  if (lookTouch && e.pointerId === lookTouch.id) lookTouch = null;
};
el.addEventListener('pointerup', endPointer); el.addEventListener('pointercancel', endPointer);

function collide() {
  for (const b of solids) {
    const cx = Math.max(b.x0, Math.min(P.x, b.x1)), cz = Math.max(b.z0, Math.min(P.z, b.z1));
    const dx = P.x - cx, dz = P.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < P.r * P.r) {
      if (d2 > 1e-9) { const d = Math.sqrt(d2), push = P.r - d; P.x += dx / d * push; P.z += dz / d * push; }
      else { // centre inside the box: leave by the nearest side
        const opts = [[b.x0 - P.r - P.x, 0], [b.x1 + P.r - P.x, 0], [0, b.z0 - P.r - P.z], [0, b.z1 + P.r - P.z]];
        opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1])); P.x += opts[0][0]; P.z += opts[0][1];
      }
    }
  }
}

/* ---------------- HUD ---------------- */
const $ = (id) => host.querySelector('#' + id);
const actBtn = $('act'), toastEl = $('toast');
let toastTimer = 0;
function toast(msg, sec = 2.2) { toastEl.textContent = msg; toastEl.hidden = false; toastTimer = sec; }
const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMs = (s, digits = 3) => { const ms = Math.max(0, Math.round(s * 1000)), m = Math.floor(ms / 60000), sec = Math.floor(ms / 1000) % 60, frac = String(ms % 1000).padStart(3, '0').slice(0, digits); return `${m}:${String(sec).padStart(2, '0')}.${frac}`; };
const num = (n) => n.toLocaleString('en-US');
function nearestSpot() {
  let best = -1, bd = RULES.reach;
  SPOTS.forEach((s, i) => { if (run && run.searched.has(i)) return; const d = Math.hypot(s.x - P.x, s.z - P.z); if (d < bd) { bd = d; best = i; } });
  return best;
}
/* Walk up to the wall and press PLACE: every name you carry flies back to its own spot (played once the state says so). */
function placeAll(names) {
  confetti.burst(WALL.x - 1.2, 3.5, (WALL.z0 + WALL.z1) / 2, 200); sound.fx('place', names.length);
  toast(names.length === 1 ? `${NAME_AT.get(names[0])} is back on the wall.` : `${names.length} names are back on the wall.`, 2.4);
}
function nearWall() { return P.x > WALL.x - 4.5 && P.x < WALL.x && P.z > WALL.z0 - 1 && P.z < WALL.z1 + 1; }
let context = null;
/* SEARCH and PLACE wait for the server: no new action while a search is open or an input is still on its way, so what a
   package holds is only ever shown from the server's own answer. */
function updateAction() {
  if (!run || run.done) return;
  if (run.searching) return;
  const ready = hooks.canAct() && !fxOn('wallet');
  if (run.carrying.length && nearWall()) { context = { kind: 'place' }; actBtn.textContent = 'PLACE'; actBtn.disabled = !ready; return; }
  const s = nearestSpot();
  if (s >= 0 && !run.searched.has(s)) {
    context = { kind: 'search', spot: s }; actBtn.textContent = 'SEARCH'; actBtn.disabled = !ready; return;
  }
  context = null; actBtn.textContent = 'SEARCH'; actBtn.disabled = true;
}
actBtn.addEventListener('click', () => {
  if (!context || !playing() || run.searching || !hooks.canAct()) return;
  if (context.kind === 'search') hooks.search(context.spot);
  else if (context.kind === 'place') hooks.place();
});
// What an empty spot says. Shuffled and dealt in order, so no line repeats until every one has been seen.
const NOTHING = [
  'Sir, this is a flour mill.',
  'This barrel is a long-term holder of air.',
  'Grinding since 1897. Still no names.',
  'The alpha is: look somewhere else.',
  'You reach in and pull out a slightly bigger hole.',
  'Empty, like a Discord at 4am.',
  'Wen name? Not here, ser.',
  'The dragon was here. Took a selfie, left.',
  'Be the name you wish to find.',
  'Stealth launch. Very stealth. Too stealth.',
  'You found a receipt for a name. The name is not included.',
  'A pigeon is sitting here. It has seen things. No names, though.',
  'Just a note: "GM. — the last guy who checked."',
  'You shake the barrel. It shakes you back.',
  'Empty. Even the mice are bearish on this spot.',
  'A sticker says "WAS HERE" with no name. Classic.',
  'You find a smaller barrel inside. It is also empty.',
];
let nothingDeck = [];

// "Seed phrase": the word PHRASE laid out in real seeds on a paper napkin, torn in half.
// Points are sampled inside the glyphs of the word, then each gets a seed: sunflower (striped), pumpkin (pale, rimmed)
// or sesame (tiny), turned along the letter's flow with a little scatter.
function drawSeedPhrase(cv, seed = 7) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // napkin: off-white, embossed edge, a ragged tear down the right
  g.fillStyle = '#d9cfc0'; g.fillRect(0, 0, W, H);
  g.save();
  g.beginPath(); g.moveTo(W * 0.04, H * 0.08); g.lineTo(W * 0.86, H * 0.06);
  for (let y = H * 0.06; y < H * 0.94; y += 10) g.lineTo(W * 0.86 + (rnd() - 0.5) * 22 + Math.sin(y * 0.05) * 8, y);
  g.lineTo(W * 0.85, H * 0.94); g.lineTo(W * 0.04, H * 0.93); g.closePath();
  g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 18; g.shadowOffsetY = 6; g.fillStyle = '#f6f1e7'; g.fill(); g.restore();
  g.strokeStyle = 'rgba(160,140,120,.35)'; g.lineWidth = 2; g.setLineDash([3, 5]); g.strokeRect(W * 0.07, H * 0.13, W * 0.74, H * 0.75); g.setLineDash([]);
  const CX = W * 0.45;   // the napkin's centre line: both lines of text sit on it
  // the letters as a mask
  const m = document.createElement('canvas'); m.width = W; m.height = H; const mg = m.getContext('2d');
  mg.fillStyle = '#000'; mg.textAlign = 'center'; mg.textBaseline = 'middle';
  let fs = H * 0.5; mg.font = `${fs}px Anton, Impact, sans-serif`;
  while (mg.measureText('PHRASE').width > W * 0.62) { fs -= 4; mg.font = `${fs}px Anton, Impact, sans-serif`; }
  mg.fillText('PHRASE', CX, H * 0.52);
  mg.lineWidth = fs * 0.07; mg.lineJoin = 'round'; mg.strokeStyle = '#000'; mg.strokeText('PHRASE', CX, H * 0.52);   // fatten the strokes so each holds two or three seeds across
  const data = mg.getImageData(0, 0, W, H).data, inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(Math.floor(y) * W + Math.floor(x)) * 4 + 3] > 128;
  const step = Math.max(6, fs / 19);
  const seeds = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step * 0.9) {
    const px = x + (rnd() - 0.5) * step * 0.7, py = y + (rnd() - 0.5) * step * 0.7;
    if (!inside(px, py)) continue;
    // orientation: along the stroke (gradient of the mask, turned 90 degrees), plus scatter
    const gx = (inside(px + 4, py) ? 1 : 0) - (inside(px - 4, py) ? 1 : 0), gy = (inside(px, py + 4) ? 1 : 0) - (inside(px, py - 4) ? 1 : 0);
    const ang = (gx || gy ? Math.atan2(gy, gx) + Math.PI / 2 : Math.PI / 2) + (rnd() - 0.5) * 1.1;
    const r = rnd(), kind = r < 0.62 ? 'sun' : r < 0.86 ? 'pump' : 'ses';
    seeds.push({ x: px, y: py, ang, kind, s: step * (kind === 'sun' ? 1.55 : kind === 'pump' ? 1.65 : 0.75) * (0.85 + rnd() * 0.3) });
  }
  // a few strays that rolled off
  for (let i = 0; i < 14; i++) seeds.push({ x: W * (0.1 + rnd() * 0.7), y: H * (0.2 + rnd() * 0.65), ang: rnd() * 6.3, kind: rnd() < 0.5 ? 'sun' : 'ses', s: step * (0.5 + rnd() * 0.5) });
  for (const s of seeds) {
    g.save(); g.translate(s.x, s.y); g.rotate(s.ang);
    const L = s.s, Wd = s.kind === 'ses' ? L * 0.55 : s.kind === 'pump' ? L * 0.62 : L * 0.46;
    const tear = () => { g.beginPath(); g.moveTo(0, -L / 2); g.bezierCurveTo(Wd * 0.7, -L * 0.3, Wd * 0.55, L * 0.45, 0, L / 2); g.bezierCurveTo(-Wd * 0.55, L * 0.45, -Wd * 0.7, -L * 0.3, 0, -L / 2); g.closePath(); };
    g.shadowColor = 'rgba(60,40,20,.35)'; g.shadowBlur = 3; g.shadowOffsetX = 1.5; g.shadowOffsetY = 2;
    tear();
    if (s.kind === 'sun') { g.fillStyle = '#2b2622'; g.fill(); g.shadowColor = 'transparent'; g.save(); g.clip(); g.strokeStyle = '#d8d0c2'; g.lineWidth = Math.max(1, L * 0.06); for (const k of [-0.22, 0, 0.22]) { g.beginPath(); g.moveTo(k * Wd * 1.6, -L / 2); g.lineTo(k * Wd * 1.1, L / 2); g.stroke(); } g.restore(); }
    else if (s.kind === 'pump') { g.fillStyle = '#e8dcb8'; g.fill(); g.shadowColor = 'transparent'; g.strokeStyle = '#c9b88c'; g.lineWidth = Math.max(1, L * 0.07); g.stroke(); g.fillStyle = '#d6c79c'; g.beginPath(); g.ellipse(0, 0, Wd * 0.3, L * 0.32, 0, 0, Math.PI * 2); g.fill(); }
    else { g.fillStyle = '#f3ead6'; g.fill(); g.shadowColor = 'transparent'; g.strokeStyle = '#d9c9a5'; g.lineWidth = 0.8; g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(-Wd * 0.15, -L * 0.15, Wd * 0.12, L * 0.18, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // caption, as if written in pen on the napkin
  g.fillStyle = '#3c3a6e'; g.font = `italic ${Math.round(H * 0.045)}px Georgia, serif`; g.textAlign = 'center';
  g.fillText('write it down, keep it safe', CX, H * 0.86);
}

/* Found objects: some empty spots hold an object instead of nothing. Each does something.
   kind: good (helps), bad (a joke at your expense). dur in seconds; 0 = instant or lasts the run. */
const OBJECTS = [
  { id: 'tram',    name: 'A tram 28 ticket from 1994',        fx: 'Sprint: 1.8× speed for 20 s.',                              dur: 20, kind: 'good' },
  { id: 'sky',     name: 'A triangle fallen from the sky',     fx: 'Low gravity: you float up over the roofs for 10 s.',        dur: 10, kind: 'good' },
  { id: 'ladder',  name: 'A paint-splattered stepladder rung', fx: 'High ground: your view lifts to 6 m for 15 s.',              dur: 15, kind: 'good' },
  { id: 'coat',    name: 'Coat-check ticket 0108',             fx: 'Claim ticket: teleported to the wall.',                      dur: 0,  kind: 'good' },
  { id: 'glasses', name: "The dragon's glasses",               fx: 'X-ray: names glow through walls for 8 s.',                   dur: 8,  kind: 'good' },
  { id: 'charger', name: 'A phone charger',                    fx: 'Full battery: the compass shows where names are for 15 s.',  dur: 15, kind: 'good' },
  { id: 'foam',    name: 'A magenta microphone foam',          fx: 'Echo: names within 25 m ping.',                              dur: 3,  kind: 'good' },
  { id: 'spray',   name: 'A spray cap from the mural crew',    fx: 'Tag trail: arrows lead to the nearest name for 20 s.',       dur: 20, kind: 'good' },
  { id: 'ens',     name: 'A QR code sticker',                  fx: 'Scan: one hidden name is marked on your compass.',           dur: 0,  kind: 'good' },
  { id: 'nata',    name: 'A pastel de nata box, one crumb left', fx: 'Sugar rush: searches are 4× faster for 60 s.',            dur: 60, kind: 'good' },
  { id: 'clicker', name: 'A slide clicker, battery dead',      fx: 'Next slide: every spot within 10 m is searched.',            dur: 0,  kind: 'good' },
  { id: 'sticker', name: 'A sticker sheet, one sticker left',  fx: 'Magnet: names within 12 m fly to you.',                      dur: 0,  kind: 'good' },
  { id: 'swatch',  name: 'A paint swatch in microphone magenta', fx: 'Paint trail: for 20 s you leave magenta paint where you walk.', dur: 20, kind: 'good' },
  { id: 'lanyard', name: 'A golden lanyard',                   fx: 'VIP pass: the next package you open holds a name.',          dur: 0,  kind: 'good' },
  { id: 'napkin',  name: 'A seed phrase on a napkin',          fx: 'Seeds sprout: flowers bloom around every name within 30 m for 15 s.', dur: 15, kind: 'good', art: true },
  { id: 'token',   name: 'A drink token from the bar',         fx: 'Buzzed: left and right are swapped for 10 s.',               dur: 10, kind: 'bad' },
  { id: 'wallet',  name: 'A hardware wallet. Empty.',          fx: 'Cold storage: frozen for 3 s.',                              dur: 3,  kind: 'bad' },
  { id: 'hat',     name: 'A sunburnt bucket hat',              fx: 'Hat over eyes: it falls over your face for 5 s.',                           dur: 5,  kind: 'bad' },
];
const OBJ = Object.fromEntries(OBJECTS.map((o) => [o.id, o]));
const fxOn = (id) => run && run.fx[id] !== undefined && run.fx[id] > run.clock;
let findTimer = 0;
function showFind(o) {
  const card = $('find'), art = $('findArt');
  card.classList.toggle('bad', o.kind === 'bad');
  $('findName').textContent = o.name; $('findFx').textContent = o.fx;
  art.hidden = !o.art;
  if (o.art) { const g = art.getContext('2d'); g.fillStyle = '#d9cfc0'; g.fillRect(0, 0, art.width, art.height); if (ART.napkin.complete) g.drawImage(ART.napkin, 0, 0, art.width, art.height); }
  card.hidden = false; card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  findTimer = o.art ? 5 : 3.6;
}
$('find').addEventListener('click', () => { $('find').hidden = true; findTimer = 0; });
/* An object turned up. The server has already applied what it does (its timer, the jump to the wall, the names it marks,
   opens or pulls in, the VIP pass); this shows it: the card, the jump, the flowers. */
function applyObject(o, spot) {
  showFind(o);
  switch (o.id) {
    case 'coat': sound.fx('teleport'); P.x = WALL.x - 2.2; P.z = (WALL.z0 + WALL.z1) / 2; P.yaw = -Math.PI / 2; P.pitch = 0.08; break;
    case 'napkin': SPOTS.forEach((p, i) => { if (run.hidden.has(i) && !run.searched.has(i) && Math.hypot(p.x - P.x, p.z - P.z) <= 30) sprouts[i].born = run.clock; }); break;
  }
}
function nothingLine() {
  if (!nothingDeck.length) { nothingDeck = NOTHING.slice(); for (let i = nothingDeck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [nothingDeck[i], nothingDeck[j]] = [nothingDeck[j], nothingDeck[i]]; } }
  return nothingDeck.pop();
}
function showCarry() {
  const n = run.carrying.length;
  $('carry').hidden = n === 0;
  if (!n) return;
  const shown = run.carrying.slice(-3).map((i) => NAME_AT.get(i)).join(' · ');
  $('carryName').textContent = n > 3 ? `${shown} · +${n - 3}` : shown;   // the latest three, so the banner never covers the view
  $('carryHint').textContent = `Carrying ${n} · the wall takes them all`;
}


/* ---------------- start / end: the arcade shell starts and ends runs; the server's state says what is in them ---------------- */
function resetVisuals() {
  sprouts.forEach((sp) => { sp.born = -1; sp.g.visible = false; sp.g.scale.setScalar(1); });
  paint.clear(); confetti.clear(); bubbles.clear();
  $('find').hidden = true; $('dim').hidden = true; $('toast').hidden = true; $('fxbar').textContent = ''; fxShown = '';
  spotMarks.forEach((m) => m.material.color.set(0x2E7FD6));
  $('time').textContent = '0:00'; $('carry').hidden = true;
}
/** Where the player stands when a run is (re)joined: the start, or where the server saw the last action (after a reload). */
function placePlayer(s) {
  resetPlayer();
  const loc = s.play.loc;
  if (loc === AT_WALL) { P.x = WALL.x - 2.2; P.z = (WALL.z0 + WALL.z1) / 2; P.yaw = -Math.PI / 2; }
  else if (loc >= 0) { const sp = SPOTS[s.play.spots[loc]]; P.x = sp.x + 1.5; P.z = sp.z + 1.5; collide(); }
}
function beginRun(s, practice) {
  run = blankRun(); sv = s; practiceRun = practice; follow(s);
  placePlayer(s); resetVisuals(); resetPackages(); redrawWall(); showCarry();
  $('found').textContent = `${s.play.placed}/${RULES.hidden}`;
  $('practiceTag').hidden = !practice;
  ['hud', 'compass', 'finish', 'mute'].forEach((id) => { $(id).hidden = false; }); actBtn.hidden = false; actBtn.disabled = true; actBtn.textContent = 'SEARCH';
  if (run.waiting) showHowto(); else startHunt(s.play.seq === 0);
}
/* The how-to card over the live HUD: short labels next to the real elements, the controls for this device, and START.
   The run is open (the platform's START) but the hunt waits: no walking, no clock, until the player presses START (GO). */
function showHowto() {
  $('howdim').hidden = false; $('howto').hidden = false; $('help').hidden = true;
  placeBadges();
}
let goWanted = false;
/** START on the card (or Enter): GO, as soon as the run can take an input (a paid run may still be opening). */
function goNow() {
  if (!run || run.done || !run.waiting || goWanted) return;
  goWanted = true;
  $('begin').disabled = true;
  const tryGo = () => {
    if (!run || run.done || !run.waiting) { goWanted = false; return; }
    if (hooks.canGo()) { hooks.go(); goWanted = false; return; }
    setTimeout(tryGo, 150);
  };
  tryGo();
}
$('begin').addEventListener('click', goNow);
/** The hunt is on: the card goes, the music starts, the clock runs (from the server's GO tick). */
function startHunt(fresh) {
  $('howto').hidden = true; $('howdim').hidden = true; $('begin').disabled = false;
  $('help').hidden = false;
  sound.start();
  if (fresh) toast('Eight names are hidden. Go!', 2.5);
  setTimeout(() => { $('help').hidden = true; }, 7000);
}
// short labels sit next to the real on-screen elements (positions inside the game area)
function placeBadges() {
  const box = $('callouts'); box.textContent = '';
  const area = host.getBoundingClientRect(), W = area.width, H = area.height;
  const rect = (e) => { const b = e.getBoundingClientRect(); return { left: b.left - area.left, right: b.right - area.left, top: b.top - area.top, bottom: b.bottom - area.top, width: b.width, height: b.height }; };
  const add = (html, css, cls = '') => { const c = document.createElement('div'); c.className = 'callout ' + cls; c.innerHTML = html; Object.assign(c.style, css); box.appendChild(c); return c; };
  const px = (v) => Math.round(v) + 'px';
  const tags = $('hud').querySelectorAll('.tag'), rR = rect(tags[0]), rT = rect(tags[1]);
  const rF = rect($('finish')), rM = rect($('mute')), rC = rect($('compass')), rA = rect(actBtn);
  add('Names back<br>on the wall', { left: px(rR.left), top: px(rR.bottom + 6) });
  add('Your time', { right: px(W - rT.right), top: px(rT.bottom + 6) });
  add(TOUCH ? 'Tap twice to end early' : 'Click twice to end early', { left: px(rF.left + rF.width / 2), top: px(rF.bottom + 6), transform: 'translateX(-50%)' });
  add('Music on / off', { right: px(W - rM.right), top: px(rM.bottom + 6) });
  add('<span class="legendbar"><span><i class="d"></i>Packages</span><span><i class="q"></i>The wall</span><span><i class="g"></i>Names</span></span>', { left: px(rC.left + rC.width / 2), top: px(rC.top - 8), transform: 'translate(-50%, -100%)', maxWidth: 'none', whiteSpace: 'nowrap' });
  const searchTip = add(TOUCH ? 'Search packages<br>&amp;<br>place names<br>at the wall' : 'Search packages<br>&amp; place names<br>at the wall<br><b>Enter · E · Space</b>', { right: px(W - rA.left + 10), top: px(rA.top + rA.height / 2), transform: 'translateY(-50%)', textAlign: 'center' });
  const card = rect(host.querySelector('.howcard')), zoneTop = Math.max(card.bottom + 16, Math.min(rA.top, rC.top) - 130);
  // the right-hand box keeps clear of the SEARCH label on short or narrow screens
  const rightX = Math.min(W * 0.75, rect(searchTip).left - 12 - 75), leftX = Math.min(W * 0.25, rightX - 165);
  if (TOUCH) {
    add('<span class="pad"><span>▲</span><span>◀</span><span>▶</span><span>▼</span></span><span>Left side<br>drag to walk</span>', { left: px(leftX), top: px(zoneTop), transform: 'translateX(-50%)' }, 'big');
    add('<span class="pad"><span>▲</span><span>◀</span><span>▶</span><span>▼</span></span><span>Right side<br>drag to look</span>', { left: px(rightX), top: px(zoneTop), transform: 'translateX(-50%)' }, 'big');
  } else {
    add('<span class="pad keys"><span>W</span><span>A</span><span>D</span><span>S</span></span><span>WASD or arrows<br>to walk</span>', { left: px(leftX), top: px(zoneTop), transform: 'translateX(-50%)' }, 'big');
    add('<span class="mouse" aria-hidden="true"></span><span>Move the mouse<br>to look · rest it<br>at an edge to turn</span>', { left: px(rightX), top: px(zoneTop), transform: 'translateX(-50%)' }, 'big');
  }
}
function endRun() {
  run.done = true; edgeTurn = 0;
  ['hud', 'carry', 'toast', 'help', 'compass', 'finish', 'find', 'dim', 'mute', 'howto', 'howdim'].forEach((id) => { $(id).hidden = true; }); actBtn.hidden = true;
  stick.hidden = true; moveTouch = null; lookTouch = null; mv = { x: 0, y: 0 }; keys.clear();
  $('fxbar').textContent = ''; fxShown = ''; P.eye = 1.6;
  sound.stop(0.6); if (run.returned.size === RULES.hidden) setTimeout(() => sound.fx('fanfare'), 250);
}
// finishing early banks the names already on the wall; names still in your hands do not count (allowed on the card too)
$('finish').addEventListener('click', () => {
  if (!run || run.done) return;
  if ($('finish').dataset.armed === '1') { $('finish').dataset.armed = ''; $('finish').textContent = 'FINISH HERE'; hooks.finish(); return; }
  $('finish').dataset.armed = '1'; $('finish').textContent = TOUCH ? 'TAP AGAIN TO END' : 'CLICK AGAIN TO END';
  setTimeout(() => { $('finish').dataset.armed = ''; $('finish').textContent = 'FINISH HERE'; }, 2500);
});

/* ---------------- loop ---------------- */
function resize() { const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); if (run && run.waiting && !$('howto').hidden) placeBadges(); }
new ResizeObserver(resize).observe(host); resize();
const WALL_CENTER = { x: WALL.x - 2, z: (WALL.z0 + WALL.z1) / 2 };
/* Compass, Fallout-style: 180 degrees across the bar. It shows the wall and the hiding spots you have not searched yet
   (never which spot holds a name: in the real game only the server knows that). */
const compass = $('compass'), cg = compass.getContext('2d');
function drawCompass() {
  const dpr = Math.min(devicePixelRatio || 1, 2), cw = compass.clientWidth, ch = compass.clientHeight;
  if (compass.width !== Math.round(cw * dpr)) { compass.width = Math.round(cw * dpr); compass.height = Math.round(ch * dpr); }
  cg.setTransform(dpr, 0, 0, dpr, 0, 0); cg.clearRect(0, 0, cw, ch);
  const heading = ((-P.yaw * 180 / Math.PI) % 360 + 360) % 360;      // 0 = north (toward the flagship mural), 90 = east
  const xOf = (bearing) => { let rel = ((bearing - heading + 540) % 360) - 180; return Math.abs(rel) > 90 ? null : cw / 2 + (rel / 90) * (cw / 2); };
  const bearingTo = (x, z) => ((Math.atan2(x - P.x, -(z - P.z)) * 180 / Math.PI) + 360) % 360;
  const fade = cg.createLinearGradient(0, 0, cw, 0);
  fade.addColorStop(0, 'rgba(11,11,11,0)'); fade.addColorStop(.15, 'rgba(11,11,11,.62)'); fade.addColorStop(.85, 'rgba(11,11,11,.62)'); fade.addColorStop(1, 'rgba(11,11,11,0)');
  cg.fillStyle = fade; cg.fillRect(0, 8, cw, ch - 8);
  cg.strokeStyle = 'rgba(242,240,235,.55)'; cg.fillStyle = '#F2F0EB'; cg.textAlign = 'center'; cg.textBaseline = 'middle';
  const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  for (let b = 0; b < 360; b += 15) {
    const x = xOf(b); if (x === null) continue;
    if (labels[b]) { cg.font = (b % 90 ? '600 11px' : '600 14px') + ' "IBM Plex Mono", monospace'; cg.fillText(labels[b], x, ch / 2 + 4); }
    else { cg.beginPath(); cg.moveTo(x, ch - 12); cg.lineTo(x, ch - 4); cg.stroke(); }
  }
  // unsearched hiding spots within 45 m: diamonds, bigger when closer; the nearest one is outlined with its distance
  let nearest = null;
  SPOTS.forEach((sp, i) => {
    if (run.searched.has(i)) return;
    const d = Math.hypot(sp.x - P.x, sp.z - P.z); if (d > 45) return;
    if (!nearest || d < nearest.d) nearest = { i, d };
  });
  SPOTS.forEach((sp, i) => {
    if (run.searched.has(i)) return;
    const d = Math.hypot(sp.x - P.x, sp.z - P.z); if (d > 45) return;
    const x = xOf(bearingTo(sp.x, sp.z)); if (x === null) return;
    const r = 3 + 4 * (1 - d / 45), y = 10;
    cg.fillStyle = `rgba(242,240,235,${0.35 + 0.65 * (1 - d / 45)})`;
    cg.beginPath(); cg.moveTo(x, y - r); cg.lineTo(x + r, y); cg.lineTo(x, y + r); cg.lineTo(x - r, y); cg.closePath(); cg.fill();
    if (nearest && nearest.i === i) { cg.strokeStyle = '#2E7FD6'; cg.lineWidth = 2; cg.stroke(); cg.lineWidth = 1; cg.strokeStyle = 'rgba(242,240,235,.55)'; }
  });
  // names you have been shown (phone charger, ENS card): gold, whatever the distance
  SPOTS.forEach((sp, i) => {
    if (run.searched.has(i) || !run.hidden.has(i) || !(run.known.has(i) || fxOn('charger') || (fxOn('foam') && Math.hypot(sp.x - P.x, sp.z - P.z) <= 25))) return;
    const x = xOf(bearingTo(sp.x, sp.z)); if (x === null) return;
    cg.fillStyle = '#e8b60f'; cg.beginPath(); cg.arc(x, 10, 7, 0, Math.PI * 2); cg.fill();
    cg.font = '600 10px "IBM Plex Mono", monospace'; cg.fillStyle = '#F2F0EB'; cg.fillText(`${Math.round(Math.hypot(sp.x - P.x, sp.z - P.z))} m`, x, ch - 7);
  });
  // the wall: always on the bar, blue, louder while you carry a name
  const wx = xOf(bearingTo(WALL_CENTER.x, WALL_CENTER.z));
  if (wx !== null) {
    const carrying = run.carrying.length > 0, sz = carrying ? 9 : 6;
    cg.fillStyle = '#2E7FD6'; cg.fillRect(wx - sz, 10 - sz, sz * 2, sz * 2);
    if (carrying) { cg.font = '600 10px "IBM Plex Mono", monospace'; cg.fillStyle = '#F2F0EB'; cg.fillText(`WALL ${Math.round(Math.hypot(WALL_CENTER.x - P.x, WALL_CENTER.z - P.z))} m`, wx, ch - 7); }
  }
  if (nearest) {
    const nx = xOf(bearingTo(SPOTS[nearest.i].x, SPOTS[nearest.i].z));
    if (nx !== null) { cg.font = '600 10px "IBM Plex Mono", monospace'; cg.fillStyle = '#F2F0EB'; cg.fillText(`${Math.round(nearest.d)} m`, nx, ch - 7); }
  }
  // centre notch
  cg.fillStyle = '#2E7FD6'; cg.beginPath(); cg.moveTo(cw / 2 - 5, ch); cg.lineTo(cw / 2 + 5, ch); cg.lineTo(cw / 2, ch - 6); cg.closePath(); cg.fill();
}
/* Effects that need things drawn in the world: x-ray / echo beams over name spots, the spray-tag arrow trail. */
const beams = SPOTS.map((sp) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 60, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  m.position.set(sp.x, 30, sp.z); m.renderOrder = 5; m.visible = false; scene.add(m); return m;
});
const trail = Array.from({ length: 14 }, () => {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.55, -0.32, 0, 0.3, 0.32, 0, 0.3], 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xcc0a5e, side: THREE.DoubleSide })); m.visible = false; scene.add(m); return m;
});
let fxShown = '';
const sprouts = SPOTS.map((sp, i) => {
  const g = new THREE.Group(); g.position.set(sp.x, inPit(sp.x, sp.z) ? PIT.top - 0.1 : 0, sp.z); g.visible = false; scene.add(g);
  const rnd = mulberry32(900 + i), petal = [0xcc0a5e, 0xff6fae, 0xe8b60f, 0xf2f0eb, 0x9b5cff, 0xf08a1c];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + rnd() * 0.3, r = 1.0 + rnd() * 0.9, h = 0.35 + rnd() * 0.55, x = Math.cos(a) * r, z = Math.sin(a) * r;
    mesh(new THREE.CylinderGeometry(0.02, 0.025, h, 4), FUR.leaf2, x, h / 2, z, g);
    const lf = mesh(new THREE.SphereGeometry(0.09, 6, 4), FUR.leaf, x + 0.06, h * 0.45, z, g); lf.scale.set(1, 0.4, 0.6);
    const col = M(petal[Math.floor(rnd() * petal.length)]);
    for (let p = 0; p < 5; p++) { const pa = p * 1.2566, pm = mesh(new THREE.SphereGeometry(0.075, 6, 4), col, x + Math.cos(pa) * 0.08, h, z + Math.sin(pa) * 0.08, g); pm.scale.set(1, 0.45, 1); }
    mesh(new THREE.SphereGeometry(0.045, 6, 4), M(0xf6d34a), x, h + 0.02, z, g);
  }
  return { g, born: -1 };
});
const paint = (() => {
  const MAX = 900, geo = new THREE.CircleGeometry(0.42, 12); geo.rotateX(-Math.PI / 2);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xcc0a5e, transparent: true, opacity: 0.85, depthWrite: false }), MAX);
  inst.count = 0; inst.renderOrder = 1; scene.add(inst);
  const m4 = new THREE.Matrix4(); let n = 0, lx = 1e9, lz = 1e9;
  return {
    step() {
      if (!fxOn('swatch') || Math.hypot(P.x - lx, P.z - lz) < 0.45 || n >= MAX) return;
      lx = P.x; lz = P.z; const s = 0.7 + Math.random() * 0.6;
      m4.makeScale(s, 1, s).setPosition(P.x + (Math.random() - .5) * 0.2, inPit(P.x, P.z) ? PIT.top + 0.02 : 0.035 + (n % 7) * 0.0005, P.z + (Math.random() - .5) * 0.2);
      inst.setMatrixAt(n, m4); n += 1; inst.count = n; inst.instanceMatrix.needsUpdate = true;
    },
    clear() { n = 0; inst.count = 0; lx = lz = 1e9; },
  };
})();
function tickEffects(dt) {
  paint.step();
  // seeds sprouting: grow in, sway, and wilt away after 15 s or once that package is opened
  sprouts.forEach((sp, i) => {
    if (sp.born < 0) return;
    const age = run.clock - sp.born, done = age > 15 || run.searched.has(i);
    if (done) { const s2 = sp.g.scale.y - dt * 2.5; if (s2 <= 0) { sp.g.visible = false; sp.born = -1; sp.g.scale.setScalar(1); } else sp.g.scale.set(1, s2, 1); return; }
    sp.g.visible = true; const grow = Math.min(1, age / 0.7), ease = 1 - Math.pow(1 - grow, 3);
    sp.g.scale.set(ease, ease * (1 + 0.04 * Math.sin(pulse * 3 + i)), ease); sp.g.rotation.y = 0.05 * Math.sin(pulse * 1.5 + i);
  });
  // eye height: floating, high ground, or back on the ground
  const wantEye = fxOn('sky') ? 15 : fxOn('ladder') ? 6 : inPit(P.x, P.z) ? 1.15 : 1.6;   // the ball pit comes up to your chest
  P.eye += (wantEye - P.eye) * (1 - Math.exp(-(wantEye > P.eye ? 2.2 : 1.4) * dt));
  $('dim').hidden = !fxOn('hat');
  // beams: x-ray shows every name; echo shows names within 25 m
  SPOTS.forEach((sp, i) => {
    const on = run.hidden.has(i) && !run.searched.has(i) && (fxOn('glasses') || (fxOn('foam') && Math.hypot(sp.x - P.x, sp.z - P.z) <= 25));
    beams[i].visible = on; if (on) beams[i].material.opacity = 0.35 + 0.2 * Math.sin(pulse * 5);
  });
  // spray-tag trail to the nearest unfound name
  let target = null;
  if (fxOn('spray')) SPOTS.forEach((sp, i) => { if (run.hidden.has(i) && !run.searched.has(i)) { const d = Math.hypot(sp.x - P.x, sp.z - P.z); if (!target || d < target.d) target = { sp, d }; } });
  trail.forEach((m, k) => {
    if (!target) { m.visible = false; return; }
    const t = (k + 1 + (pulse * 2) % 1) * 1.6; if (t > target.d - 0.8) { m.visible = false; return; }
    const ux = (target.sp.x - P.x) / target.d, uz = (target.sp.z - P.z) / target.d;
    m.visible = true; m.position.set(P.x + ux * t, 0.04, P.z + uz * t); m.rotation.set(0, Math.atan2(-ux, -uz), 0);
  });
  // what's running, with seconds left
  const parts = OBJECTS.filter((o) => o.dur && fxOn(o.id)).map((o) => `${o.kind}|${o.fx.split(':')[0].toUpperCase()} ${Math.ceil(run.fx[o.id] - run.clock)}`);
  if (run.known.size) parts.push(`good|NAME MARKED`);
  if (run.vip) parts.push('good|VIP PASS');

  const key = parts.join(',');
  if (key !== fxShown) { fxShown = key; $('fxbar').innerHTML = ''; parts.forEach((p) => { const [k, t] = p.split('|'); const e = document.createElement('span'); e.textContent = t; if (k === 'bad') e.className = 'bad'; $('fxbar').appendChild(e); }); }
}
/* ---------------- music and sound: PIXEL PARTY, chiptune in D major at 138 BPM, written live ----------------
   The music builds with every name you find (bass and hats, then the tune, drums, arpeggios, harmony) and, once
   you hold the last name, goes up a key and 8% faster for the run home. Where you stand changes it: the DJ hall
   pumps four-on-the-floor, the ball pit muffles it, the bubble tower adds chimes and echoes. */
const sound = (() => {
  const V = { bpm: 138, root: 62, scale: [0, 2, 4, 5, 7, 9, 11], leadDuty: 0.125, echo: 0.1,
    progs: [[5, 3, 0, 4], [0, 4, 5, 3], [3, 0, 4, 5], [5, 4, 3, 4]],
    rhythms: [[[0, 1], [1, 1], [2, 2], [4, 2], [6, 2], [8, 1], [9, 1], [10, 2], [12, 4]], [[0, 2], [3, 2], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2]], [[0, 4], [4, 1], [5, 1], [6, 2], [8, 4], [12, 1], [13, 1], [14, 2]]],
    bass: [[0, 2, 0], [2, 2, 7], [4, 2, 0], [6, 2, 7], [8, 2, 0], [10, 2, 7], [12, 2, 0], [14, 2, 7]],
    drums: { k: [0, 4, 8, 12], s: [4, 12], h: [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15], o: [2, 6, 10, 14] } };
  let ctx = null, A = null, timer = null, playing = false, muted = false;
  try { muted = localStorage.getItem('rcr-muted') === '1'; } catch (e) {}
  let prog = 0, zone = 'yard', rnd = Math.random, step = 0, nextT = 0, bar = 0, phrase = null, barNotes = [], barChord = [0, 2, 4];
  function boot() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC();
    const master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; master.connect(comp).connect(ctx.destination);
    const music = ctx.createGain(); music.connect(master);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 18000; filt.Q.value = 0.7; filt.connect(music);
    const duck = ctx.createGain(); duck.connect(filt);
    const drums = ctx.createGain(); drums.gain.value = 0.85; drums.connect(filt);
    const delay = ctx.createDelay(1.5), fb = ctx.createGain(), wet = ctx.createGain(); delay.delayTime.value = 60 / V.bpm * 0.75;
    fb.gain.value = 0.38; wet.gain.value = V.echo; delay.connect(fb).connect(delay); delay.connect(wet).connect(filt);
    const send = ctx.createGain(); send.connect(delay);
    const chimes = ctx.createGain(); chimes.gain.value = 0; chimes.connect(delay); chimes.connect(music);
    const sfx = ctx.createGain(); sfx.gain.value = 0.9; sfx.connect(master);
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain(); lfo.frequency.value = 0.35; lfoGain.gain.value = 0; lfo.connect(lfoGain).connect(filt.frequency); lfo.start();
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const waves = {};
    [0.125, 0.25, 0.5].forEach((d) => { const n = 48, re = new Float32Array(n), im = new Float32Array(n); for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * d); waves[d] = ctx.createPeriodicWave(re, im); });
    A = { master, music, filt, duck, drums, delay, send, wet, chimes, sfx, lfoGain, noise, waves };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function tone({ wave = 'pulse', duty = 0.5, midi, t, dur, vol = 0.2, slideTo = null, vib = 0, dest }) {
    const o = ctx.createOscillator();
    if (wave === 'pulse') o.setPeriodicWave(A.waves[duty]); else o.type = wave === 'tri' ? 'triangle' : wave;
    o.frequency.setValueAtTime(mtof(midi), t);
    if (slideTo !== null) o.frequency.exponentialRampToValueAtTime(mtof(slideTo), t + dur);
    if (vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 6; lg.gain.value = mtof(midi) * vib; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + dur + 0.1); }
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.006); g.gain.setTargetAtTime(vol * 0.7, t + 0.02, 0.06); g.gain.setTargetAtTime(0, t + dur, 0.03);
    o.connect(g); (Array.isArray(dest) ? dest : [dest]).forEach((d) => g.connect(d));
    o.start(t); o.stop(t + dur + 0.25);
  }
  function hit(kind, t, vol = 1, dest = A.drums) {
    if (kind === 'k') { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13); g.gain.setValueAtTime(0.9 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22); o.connect(g).connect(dest); o.start(t); o.stop(t + 0.25); return; }
    const src = ctx.createBufferSource(); src.buffer = A.noise; const f = ctx.createBiquadFilter(), g = ctx.createGain();
    const p = { s: ['bandpass', 1900, 0.16, 0.35], h: ['highpass', 7500, 0.035, 0.12], o: ['highpass', 6500, 0.2, 0.1], c: ['highpass', 4500, 1.0, 0.16], r: ['bandpass', 3000, 0.05, 0.12] }[kind];
    f.type = p[0]; f.frequency.value = p[1]; g.gain.setValueAtTime(p[3] * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + p[2]);
    src.connect(f).connect(g).connect(dest); src.start(t, Math.random() * 0.5); src.stop(t + p[2] + 0.05);
    if (kind === 's') tone({ wave: 'tri', midi: 52, t, dur: 0.05, vol: 0.12 * vol, dest });
  }
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const degToMidi = (deg, base) => { const o = Math.floor(deg / 7), m = ((deg % 7) + 7) % 7; return base + V.scale[m] + 12 * o; };
  const nearest = (d, chord) => { let best = d, bd = 99; for (let o = -14; o <= 21; o += 7) for (const c of chord) { const x = c + o; if (Math.abs(x - d) < bd) { bd = Math.abs(x - d); best = x; } } return best; };
  function newPhrase() {
    const prev = phrase ? phrase.section : null;
    const section = !phrase ? 'A' : pick(prev === 'BRK' ? ['A'] : prev === 'B' ? ['A', 'BRK', 'A'] : ['A', 'B', 'A2', 'B', 'BRK']);
    phrase = { section, prog: section === 'A2' && phrase ? phrase.prog : pick(V.progs), rA: pick(V.rhythms), rB: pick(V.rhythms), contour: null, last: phrase ? phrase.last : 9 };
  }
  function melodyBar(b, chord) {
    const rhythm = b % 2 === 0 ? phrase.rA : phrase.rB, lift = phrase.section === 'B' ? 7 : 0;
    let prev = phrase.last; const notes = [];
    if (b === 2 && phrase.contour) { const a = nearest(prev, chord); return phrase.contour.map((n) => ({ step: n.step, len: n.len, deg: a + n.rel + lift })); }
    rhythm.forEach(([st, len], i) => {
      let d = st % 4 === 0 || i === 0 ? nearest(prev + Math.round((rnd() - 0.5) * 4), chord) : prev + pick([-2, -1, -1, 1, 1, 2, 0]);
      if (b === 3 && i === rhythm.length - 1) d = nearest(prev, [chord[0], chord[0] + 7]);
      d = Math.max(5, Math.min(15, d)); notes.push({ step: st, len, deg: d }); prev = d;
    });
    if (b === 0) phrase.contour = notes.map((n) => ({ step: n.step, len: n.len, rel: n.deg - notes[0].deg }));
    phrase.last = prev;
    return notes.map((n) => ({ ...n, deg: n.deg + lift }));
  }
  // every 30 s of the run the tempo creeps up 3 BPM, never past 180 (run-home lift included)
  let startT = 0;
  const bpmNow = () => Math.min(180, (V.bpm + 3 * Math.floor(Math.max(0, ctx.currentTime - startT) / 30)) * (prog >= 8 ? 1.08 : 1)), keyNow = () => V.root + (prog >= 8 ? 2 : 0);
  function playStep(s, t) {
    const sd = 60 / bpmNow() / 4, key = keyNow();
    if (s === 0) { if (!phrase || bar % 4 === 0) newPhrase(); const b = bar % 4; barChord = [phrase.prog[b], phrase.prog[b] + 2, phrase.prog[b] + 4]; barNotes = phrase.section === 'BRK' ? [] : melodyBar(b, barChord); }
    const brk = phrase.section === 'BRK', dj = zone === 'dj', D = V.drums;
    if (D.h.includes(s)) hit('h', t, brk ? 0.6 : 0.8);
    if (prog >= 2 || dj) {
      if (dj ? s % 4 === 0 : (brk ? s === 0 : D.k.includes(s))) { hit('k', t, dj ? 1.15 : 1); if (dj) { A.duck.gain.cancelScheduledValues(t); A.duck.gain.setValueAtTime(0.4, t); A.duck.gain.linearRampToValueAtTime(1, t + 0.2); } }
      if (!brk && D.s.includes(s)) hit('s', t);
      if (!brk && D.o.includes(s)) hit('o', t, 0.7);
      if (bar % 4 === 3 && s >= 12 && !brk && rnd() < 0.7) hit('s', t, 0.55);
      if (prog >= 8 && s === 0 && bar % 2 === 0) hit('c', t, 0.8);
    }
    V.bass.forEach(([bs, len, off]) => { if (bs === s) tone({ wave: 'tri', midi: degToMidi(barChord[0] + off, key - 24), t, dur: len * sd * 0.92, vol: dj ? 0.42 : 0.32, dest: A.duck }); });
    barNotes.forEach((n) => {
      if (n.step !== s) return;
      const vol = prog >= 1 ? 0.15 : 0.08, dur = n.len * sd * 0.9;
      tone({ wave: 'pulse', duty: V.leadDuty, midi: degToMidi(n.deg, key), t, dur, vol, vib: n.len >= 4 ? 0.006 : 0, dest: [A.duck, A.send] });
      if (prog >= 6) tone({ wave: 'pulse', duty: 0.5, midi: degToMidi(n.deg - 2, key), t, dur, vol: vol * 0.45, dest: A.duck });
    });
    if (prog >= 4 || brk) { const pat = [0, 1, 2, 3, 2, 1, 0, 1], i = s % 8, d = i === 3 ? barChord[0] + 7 : barChord[pat[i] % 3]; tone({ wave: 'pulse', duty: 0.125, midi: degToMidi(d + 7, key), t, dur: sd * 0.6, vol: 0.06, dest: [A.duck, A.send] }); }
    if (prog >= 6 && !brk && s % 4 === 2) barChord.forEach((d) => tone({ wave: 'pulse', duty: 0.5, midi: degToMidi(d, key - 12), t, dur: sd * 0.7, vol: 0.035, dest: A.duck }));
    if (zone === 'bubbles' && s % 2 === 0 && rnd() < 0.35) tone({ wave: 'sine', midi: degToMidi(pick(barChord) + 14, key), t, dur: 0.6, vol: 0.09, dest: A.chimes });
  }
  function tick() { if (nextT < ctx.currentTime - 0.05) nextT = ctx.currentTime + 0.02; while (nextT < ctx.currentTime + 0.12) { playStep(step, nextT); nextT += 60 / bpmNow() / 4; step = (step + 1) % 16; if (step === 0) bar += 1; } }
  function setZone(z) {
    if (z === zone || !ctx) { zone = z; return; }
    zone = z; const t = ctx.currentTime, f = A.filt.frequency; f.cancelScheduledValues(t);
    if (z === 'pit') { f.setTargetAtTime(520, t, 0.15); A.filt.Q.setTargetAtTime(3, t, 0.2); A.lfoGain.gain.setTargetAtTime(160, t, 0.3); }
    else { f.setTargetAtTime(18000, t, 0.15); A.filt.Q.setTargetAtTime(0.7, t, 0.2); A.lfoGain.gain.setTargetAtTime(0, t, 0.1); }
    A.chimes.gain.setTargetAtTime(z === 'bubbles' ? 1 : 0, t, 0.3);
    A.wet.gain.setTargetAtTime(V.echo + (z === 'bubbles' ? 0.35 : 0), t, 0.3);
    if (z !== 'dj') { A.duck.gain.cancelScheduledValues(t); A.duck.gain.setTargetAtTime(1, t, 0.05); }
  }
  function start() {
    boot(); if (!ctx) return;
    const s0 = (Math.random() * 2 ** 32) >>> 0; rnd = mulberry32(s0);
    phrase = null; step = 0; bar = 0; prog = 0; nextT = ctx.currentTime + 0.08; startT = ctx.currentTime;
    A.music.gain.cancelScheduledValues(ctx.currentTime); A.music.gain.setValueAtTime(1, ctx.currentTime);
    if (!playing) { playing = true; timer = setInterval(tick, 25); }
  }
  function stop(fade = 1.2) {
    if (!ctx || !playing) return;
    const t = ctx.currentTime; A.music.gain.cancelScheduledValues(t); A.music.gain.setValueAtTime(A.music.gain.value, t); A.music.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { playing = false; clearInterval(timer); timer = null; }, fade * 1000 + 50);
  }
  function setMuted(m) { muted = m; try { localStorage.setItem('rcr-muted', m ? '1' : '0'); } catch (e) {} if (ctx) A.master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.05); }
  function fx(kind, n = 8) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + 0.01, d = A.sfx, k = keyNow();
    if (kind === 'name') { [0, 4, 7, 12, 16, 19, 24].forEach((m, i) => tone({ wave: 'pulse', duty: 0.125, midi: k + 12 + m, t: t + i * 0.055, dur: i === 6 ? 0.35 : 0.06, vol: 0.18, dest: d })); tone({ wave: 'pulse', duty: 0.5, midi: k + 24, t: t + 0.38, dur: 0.3, vol: 0.08, vib: 0.01, dest: d }); for (let i = 0; i < 6; i++) hit('r', t + 0.4 + i * 0.05, 0.6, d); }
    if (kind === 'good') { tone({ wave: 'pulse', duty: 0.25, midi: k + 7, slideTo: k + 31, t, dur: 0.28, vol: 0.13, dest: d }); tone({ wave: 'pulse', duty: 0.125, midi: k + 31, t: t + 0.3, dur: 0.12, vol: 0.12, dest: d }); }
    if (kind === 'joke') { tone({ wave: 'tri', midi: k + 3, slideTo: k + 1, t, dur: 0.3, vol: 0.28, vib: 0.012, dest: d }); tone({ wave: 'tri', midi: k, slideTo: k - 6, t: t + 0.35, dur: 0.6, vol: 0.28, vib: 0.02, dest: d }); }
    if (kind === 'empty') { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); o.connect(g).connect(d); o.start(t); o.stop(t + 0.2); hit('r', t, 0.5, d); }
    if (kind === 'search') for (let i = 0; i < 8; i++) hit('r', t + i * 0.09 + Math.random() * 0.03, 0.5 + Math.random() * 0.5, d);
    if (kind === 'place') [0, 2, 4, 5, 7, 9, 11, 12].slice(0, Math.max(1, Math.min(8, n))).forEach((m, i) => { tone({ wave: 'pulse', duty: 0.25, midi: k + 12 + m, t: t + i * 0.11, dur: 0.1, vol: 0.15, dest: d }); hit('r', t + i * 0.11, 0.3, d); });
    if (kind === 'teleport') { tone({ wave: 'pulse', duty: 0.5, midi: k + 24, slideTo: k - 12, t, dur: 0.35, vol: 0.1, dest: d }); tone({ wave: 'pulse', duty: 0.125, midi: k - 12, slideTo: k + 36, t: t + 0.36, dur: 0.25, vol: 0.08, dest: d }); }
    if (kind === 'fanfare') {
      [[0, 0, 0.12], [4, 0.13, 0.12], [7, 0.26, 0.12], [12, 0.39, 0.3], [9, 0.72, 0.12], [12, 0.85, 0.12], [16, 0.98, 0.7]].forEach(([m, at, dur]) => { tone({ wave: 'pulse', duty: 0.25, midi: k + 12 + m, t: t + at, dur, vol: 0.16, vib: dur > 0.3 ? 0.008 : 0, dest: d }); tone({ wave: 'pulse', duty: 0.5, midi: k + 8 + m - (m % 12 === 0 ? 0 : 3), t: t + at, dur, vol: 0.06, dest: d }); });
      [0, 0.39, 0.98].forEach((at) => { hit('k', t + at, 0.8, d); hit('c', t + at, 0.6, d); });
      tone({ wave: 'tri', midi: k - 12, t, dur: 0.35, vol: 0.3, dest: d }); tone({ wave: 'tri', midi: k - 7, t: t + 0.39, dur: 0.3, vol: 0.3, dest: d }); tone({ wave: 'tri', midi: k - 12, t: t + 0.98, dur: 0.8, vol: 0.3, dest: d });
    }
  }
  return { start, stop, fx, setZone, bpm: () => (ctx && playing ? bpmNow() : V.bpm), setProg: (p) => { prog = p; }, setMuted, get muted() { return muted; } };
})();
function soundZone() {
  if (P.x > -39.7 && P.x < -12.3 && P.z > 52.3 && P.z < 63.7) return 'dj';
  if (inPit(P.x, P.z)) return 'pit';
  if (P.x > 3 && P.x < 30 && P.z > 64.6 && P.z < 72) return 'bubbles';
  return 'yard';
}
function soundProg() { if (!run) return 0; const found = run.returned.size + run.carrying.length; return found >= RULES.hidden && run.carrying.length ? 8 : Math.min(7, found); }
const muteBtn = $('mute');
function showMute() { muteBtn.textContent = sound.muted ? '♪ OFF' : '♪ ON'; muteBtn.setAttribute('aria-pressed', String(sound.muted)); muteBtn.setAttribute('aria-label', sound.muted ? 'Sound off' : 'Sound on'); }
muteBtn.addEventListener('click', () => { sound.setMuted(!sound.muted); showMute(); });
showMute();
let last = performance.now(), pulse = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; pulse += dt;
  skyUniforms.uTime.value = now / 1000; globe.step(now / 1000, dt); confetti.step(dt, now / 1000); bubbles.step(dt, now / 1000); ballPit.step(dt); if (run && !run.done && !run.waiting) { sound.setZone(soundZone()); sound.setProg(soundProg()); }
  stepBubbleMachines(dt); rave.step(now / 1000); streamers.step(now / 1000); stepPackages(now / 1000, dt); flags.step(now / 1000);
  if (run && !run.done && !run.waiting) {
    if (edgeTurn) P.yaw -= edgeTurn * EDGE_SPEED * dt * (fxOn('token') ? -1 : 1);   // the cursor resting at an edge keeps turning
    let fx = mv.x, fz = mv.y;
    if (keys.has('w') || keys.has('arrowup')) fz -= 1; if (keys.has('s') || keys.has('arrowdown')) fz += 1;
    if (keys.has('a') || keys.has('arrowleft')) fx -= 1; if (keys.has('d') || keys.has('arrowright')) fx += 1;
    const len = Math.hypot(fx, fz); if (len > 1) { fx /= len; fz /= len; }
    if (fxOn('token')) fx = -fx;                                    // buzzed
    if (fxOn('wallet')) { fx = 0; fz = 0; }                         // frozen
    const boost = (fxOn('tram') ? 1.8 : 1) * (inPit(P.x, P.z) ? 0.45 : 1); fx *= boost; fz *= boost;   // wading is slow
    const sn = Math.sin(P.yaw), cs = Math.cos(P.yaw);
    // walk in small sub-steps so a fast walker never slips through a thin container wall
    const mx = (fx * cs + fz * sn) * RULES.speed * dt, mz = (-fx * sn + fz * cs) * RULES.speed * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(mx, mz) / 0.12));
    for (let k = 0; k < steps; k++) { P.x += mx / steps; P.z += mz / steps; collide(); }
  }
  if (run && !run.done && !run.waiting) {
    // the clock is the server's: ticks since START (estimated between two states), whole seconds on screen
    run.clock = Math.max(0, (hooks.tick() - run.startTick) * TICK_SEC); run.elapsed = run.clock; $('time').textContent = fmt(run.elapsed);
    tickEffects(dt);
    if (run.searching) {
      // swing the camera round onto the object being searched, eased so it reads as a turn of the head; the server says
      // what was inside when the search is over
      const sp = SPOTS[run.searching.spot], dx = sp.x - P.x, dz = sp.z - P.z;
      const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(0.5 - P.eye, Math.max(0.6, Math.hypot(dx, dz)));
      const k = 1 - Math.exp(-9 * dt);
      P.yaw += (((wantYaw - P.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * k;
      P.pitch += (wantPitch - P.pitch) * k;
    }
    updateAction();
    if (run.carrying.length) {
      const ang = Math.atan2(WALL_CENTER.x - P.x, WALL_CENTER.z - P.z);   // world bearing to the wall
      const rel = ang - (P.yaw + Math.PI);
      $('arrow').style.transform = `rotate(${-rel}rad)`;
    }
    SPOTS.forEach((s, i) => { const d = Math.hypot(s.x - P.x, s.z - P.z); spotMarks[i].material.opacity = run.searched.has(i) ? 0 : (d < 8 ? 0.35 + 0.35 * Math.sin(pulse * 4) ** 2 : 0); });
  }
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) toastEl.hidden = true; }
  if (findTimer > 0) { findTimer -= dt; if (findTimer <= 0) $('find').hidden = true; }
  if (run && !run.done) drawCompass();
  idleView(now);
  camera.position.set(P.x, P.eye, P.z); sky.position.copy(camera.position); camera.rotation.set(P.pitch, P.yaw, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
// title screen backdrop: a slow look along the alley at the wall
resetPlayer();
const idleView = (t) => { if (run && !run.done) return; P.yaw = START.yaw + 0.32 * Math.sin(t * 0.00012); P.pitch = START.pitch + 0.06 + 0.03 * Math.sin(t * 0.0002); };
(document.fonts && document.fonts.load ? Promise.all([document.fonts.load('64px Anton'), document.fonts.load('600 17px "IBM Plex Mono"')]).catch(() => {}) : Promise.resolve())
  .then(() => {
    redrawWall();
    // repaint the lettered container skins now that Anton has loaded, then refresh every texture that uses them
    repaint(JPEG.side, jpegSide()); repaint(JPEG.doors, jpegDoors()); repaint(billboardCanvas, billboardArt());
    repaint(mysteryFace, tileCanvas(256, 256, (g, w, h) => { g.fillStyle = '#151515'; g.fillRect(0, 0, w, h); g.strokeStyle = '#ffb3d4'; g.lineWidth = 14; g.strokeRect(12, 12, w - 24, h - 24); g.fillStyle = '#cc0a5e'; g.font = '200px Anton, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', w / 2, h / 2 + 12); }));
    refreshTextures([JPEG.side, JPEG.doors, billboardCanvas, mysteryFace]); repaintSigns();
  });
// the embedded images decode asynchronously: repaint what uses them once they are ready
ART.dragon.onload = () => { repaint(billboardCanvas, billboardArt()); refreshTextures([billboardCanvas]); repaintSigns(); };
ART.jpeg.onload = () => { repaint(JPEG.side, jpegSide()); refreshTextures([JPEG.side]); };
if (ART.dragon.complete) ART.dragon.onload(); if (ART.jpeg.complete) ART.jpeg.onload();
// the portraits above the names, and the live names once the wall's data arrives: repaint the wall
for (const img of portraitImages.values()) if (!img.complete) img.addEventListener('load', redrawWall, { once: true });
let liveSeen = wallIsLive();
setInterval(() => { if (wallIsLive() !== liveSeen) { liveSeen = wallIsLive(); redrawWall(); } }, 1000);
redrawWall();
requestAnimationFrame(frame);

// DEV builds only (scripts/dev-flow.ts defines __DEV_ANY_ORIGIN__; a real build drops this): a handle for checking a run
// from the browser console. It moves the player and reads the picture; it cannot change what the state says.
if (typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__) {
  window.__rcr = { P, SPOTS, run: () => run, state: () => sv, goTo: (x, z) => { P.x = x; P.z = z; collide(); }, nearWall, act: () => actBtn };
}

/* ---------------- the world, as the stage sees it ---------------- */
return {
  /** A state of a run to show (the server's, with the player's queued inputs applied). A new run, or the first state
   *  seen of one (a reload mid-run), starts the HUD; after that each state plays what changed. */
  show(s, practice) {
    if (!run || !sv || sv.seed !== s.seed || practiceRun !== practice || (run.done && !s.gameOver)) {
      beginRun(s, practice);
      if (s.gameOver) endRun();
      return;
    }
    if (s === sv) return;
    const prev = sv; sv = s;
    const wasWaiting = run.waiting;
    follow(s);
    if (wasWaiting && !run.waiting && !s.gameOver) startHunt(true);
    playEvents(prev, s);
    if (s.gameOver && !prev.gameOver) endRun();
  },
  /** No run on screen: back to the slow look along the alley. */
  idle() {
    if (run && !run.done) endRun();
    run = null; sv = null; resetPlayer(); redrawWall();
  },
};
}
