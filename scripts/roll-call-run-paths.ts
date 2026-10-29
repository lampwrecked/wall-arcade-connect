// ROLL CALL RUN's walking table: the shortest walk (cm) between every two places a player acts from (the 67 package
// spots, the start, the wall), around the buildings, for the verifier's walking check.
//
// 1. Loads the prototype page in headless Chrome and reads its collision boxes (`solids`, the only thing the player
//    collides with: axis-aligned boxes in metres, a 0.35 m player).
// 2. Lays a 25 cm grid over the yard, blocks every cell a player cannot stand in, and runs a 16-direction Dijkstra from
//    each place. A package counts as reached anywhere within 4 m of it (searching works through a wall, as in the
//    prototype), the wall anywhere in its PLACE zone, the start at its point.
// 3. Keeps every distance a LOWER bound of the real walk (a slimmer player, 3 % off for the grid's angles, 50 cm off for
//    its cells), so an honest player is never refused, and writes src/games/roll-call-run/paths.json.
//
// Usage: node --import tsx scripts/roll-call-run-paths.ts <roll-call-run-prototype.html>   (Chrome: CHROME_PATH or the usual paths)
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { RULES, SPOTS, START, WALL_ZONE } from '../src/games/roll-call-run/core.js';

type Box = { x0: number; x1: number; z0: number; z1: number };
const source = process.argv[2];
if (!source) throw new Error('Usage: roll-call-run-paths.ts <roll-call-run-prototype.html>');
const html = await readFile(resolve(source), 'utf8');
if (!html.includes('const solids = [];')) throw new Error('The prototype has no `const solids = [];` to read.');

/* ---------------------------- 1. the collision boxes ---------------------------- */
const CHROMES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter((p): p is string => Boolean(p));
const executablePath = CHROMES.find((path) => existsSync(path));
if (!executablePath) throw new Error('No Chrome found: set CHROME_PATH');
const browser = await chromium.launch({ executablePath });
let solids: Box[];
try {
  const page = await browser.newPage();
  await page.setContent(html.replace('const solids = [];', 'const solids = (window.__solids = []);'), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray((window as unknown as { __solids?: unknown[] }).__solids) && (window as unknown as { __solids: unknown[] }).__solids.length > 0);
  solids = await page.evaluate(() => (window as unknown as { __solids: Box[] }).__solids.map((b) => ({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 })));
} finally { await browser.close(); }
console.log(`${solids.length} collision boxes`);

/* ---------------------------- 2. the grid ---------------------------- */
const CELL = 0.25, RADIUS = 0.25;            // the prototype's player is 0.35 m: a slimmer one only makes walks shorter
const places: { x: number; z: number }[] = [...SPOTS.map(([x, z]) => ({ x: x / 100, z: z / 100 })), { x: START.x / 100, z: START.z / 100 }];
const X0 = Math.min(...places.map((p) => p.x)) - 25, X1 = Math.max(...places.map((p) => p.x)) + 25;
const Z0 = Math.min(...places.map((p) => p.z)) - 25, Z1 = Math.max(...places.map((p) => p.z)) + 25;
const W = Math.ceil((X1 - X0) / CELL), H = Math.ceil((Z1 - Z0) / CELL);
const cx = (i: number): number => X0 + (i + 0.5) * CELL, cz = (j: number): number => Z0 + (j + 0.5) * CELL;
const blocked = new Uint8Array(W * H);
for (const b of solids) {
  const i0 = Math.max(0, Math.floor((b.x0 - RADIUS - X0) / CELL)), i1 = Math.min(W - 1, Math.floor((b.x1 + RADIUS - X0) / CELL));
  const j0 = Math.max(0, Math.floor((b.z0 - RADIUS - Z0) / CELL)), j1 = Math.min(H - 1, Math.floor((b.z1 + RADIUS - Z0) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const px = cx(i), pz = cz(j), dx = px - Math.max(b.x0, Math.min(px, b.x1)), dz = pz - Math.max(b.z0, Math.min(pz, b.z1));
    if (dx * dx + dz * dz < RADIUS * RADIUS) blocked[j * W + i] = 1;
  }
}
console.log(`grid ${W} × ${H} cells of ${CELL} m, ${blocked.reduce((a, b) => a + b, 0)} blocked`);

// 16 directions: the 8 neighbours plus the knight moves (each checks the two cells it passes between)
const MOVES: [number, number, number][] = [];
for (const [a, b] of [[1, 0], [1, 1], [2, 1]] as const) for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
  for (const [dx, dz] of [[a * sa, b * sb], [b * sb, a * sa]] as const) if (!MOVES.some(([x, z]) => x === dx && z === dz)) MOVES.push([dx, dz, Math.hypot(dx, dz) * CELL]);
}
function dijkstra(sources: number[]): Float64Array {
  const dist = new Float64Array(W * H).fill(Infinity);
  // binary heap of [distance, cell]
  const heapD: number[] = [], heapC: number[] = [];
  const push = (d: number, c: number): void => {
    let k = heapD.length; heapD.push(d); heapC.push(c);
    while (k > 0) { const p = (k - 1) >> 1; if ((heapD[p] as number) <= d) break; heapD[k] = heapD[p] as number; heapC[k] = heapC[p] as number; k = p; }
    heapD[k] = d; heapC[k] = c;
  };
  const pop = (): [number, number] => {
    const d = heapD[0] as number, c = heapC[0] as number, lastD = heapD.pop() as number, lastC = heapC.pop() as number;
    if (heapD.length) {
      let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k, md = lastD;
        if (l < heapD.length && (heapD[l] as number) < md) { m = l; md = heapD[l] as number; }
        if (r < heapD.length && (heapD[r] as number) < md) m = r;
        if (m === k) break; heapD[k] = heapD[m] as number; heapC[k] = heapC[m] as number; k = m; }
      heapD[k] = lastD; heapC[k] = lastC;
    }
    return [d, c];
  };
  for (const c of sources) { dist[c] = 0; push(0, c); }
  while (heapD.length) {
    const [d, c] = pop();
    if (d > (dist[c] as number)) continue;
    const i = c % W, j = (c - i) / W;
    for (const [dx, dz, cost] of MOVES) {
      const ni = i + dx, nj = j + dz;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H || blocked[nj * W + ni]) continue;
      if (Math.abs(dx) + Math.abs(dz) === 3) {           // a knight move passes two cells
        const si = Math.sign(dx), sj = Math.sign(dz);
        const a = Math.abs(dx) === 2 ? [i + si, j] : [i, j + sj], b = Math.abs(dx) === 2 ? [i + si, j + sj] : [i + si, j + sj];
        if (blocked[(a[1] as number) * W + (a[0] as number)] || blocked[(b[1] as number) * W + (b[0] as number)]) continue;
      } else if (dx && dz && (blocked[j * W + ni] || blocked[nj * W + i])) continue;   // no corner cutting
      const nd = d + cost;
      if (nd < (dist[nj * W + ni] as number)) { dist[nj * W + ni] = nd; push(nd, nj * W + ni); }
    }
  }
  return dist;
}
/** The free cells a player can act from: within 4 m of a package, inside the wall zone, or the start's cell. */
function region(p: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (blocked[j * W + i]) continue;
    const x = cx(i), z = cz(j);
    if (p < RULES.spots) { const [sx, sz] = SPOTS[p] as readonly [number, number, string]; if (Math.hypot(x - sx / 100, z - sz / 100) <= RULES.reach / 100) out.push(j * W + i); }
    else if (p === RULES.spots + 1) { if (x >= WALL_ZONE.x0 / 100 && x <= WALL_ZONE.x1 / 100 && z >= WALL_ZONE.z0 / 100 && z <= WALL_ZONE.z1 / 100) out.push(j * W + i); }
  }
  if (p === RULES.spots) {                               // the start: the nearest free cell to its point
    let best = -1, bd = Infinity;
    for (let c = 0; c < W * H; c++) if (!blocked[c]) { const d = Math.hypot(cx(c % W) - START.x / 100, cz(Math.floor(c / W)) - START.z / 100); if (d < bd) { bd = d; best = c; } }
    out.push(best);
  }
  if (!out.length) throw new Error(`place ${p} has no free cell`);
  return out;
}

/* ---------------------------- 3. the table ---------------------------- */
const N = RULES.spots + 2;                                // 67 spots, the start, the wall
const regions = Array.from({ length: N }, (_, p) => region(p));
const table: number[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => 0));
const t0 = Date.now();
for (let a = 0; a < N; a++) {
  const dist = dijkstra(regions[a] as number[]);
  for (let b = 0; b < N; b++) {
    if (a === b) continue;
    let m = Infinity;
    for (const c of regions[b] as number[]) if ((dist[c] as number) < m) m = dist[c] as number;
    if (!Number.isFinite(m)) throw new Error(`no walk from place ${a} to place ${b}`);
    table[a]![b] = Math.max(0, Math.floor((m * 0.97 - 0.5) * 100));   // cm, a lower bound of the real walk
  }
}
for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) { const m = Math.min(table[a]![b]!, table[b]![a]!); table[a]![b] = m; table[b]![a] = m; }
console.log(`table ${N} × ${N} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const out = {
  note: 'Generated by scripts/roll-call-run-paths.ts from the prototype: the shortest walk (cm, a lower bound) between places 0..66 (package spots), 67 (start), 68 (the wall). Do not edit.',
  prototypeSha256: createHash('sha256').update(html).digest('hex'),
  boxes: solids.length, cell: CELL, radius: RADIUS,
  table,
};
await writeFile(new URL('../src/games/roll-call-run/paths.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log('wrote src/games/roll-call-run/paths.json');
