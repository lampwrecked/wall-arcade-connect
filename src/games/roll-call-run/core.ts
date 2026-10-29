// ROLL CALL RUN: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// A hunt around the Unicorn Factory yard. Each run puts 26 packages out, picked from 67 fixed spots; 8 names of the wall
// and 6 objects are among them, the rest are empty. The player walks in the browser (the server never sees a position),
// SEARCHes packages, and carries the names back to the wall, where PLACE returns every carried name at once.
//
// What a package holds is decided by the server when its search completes, never at the start: the run state travels to
// the browser and the verifier is public, so contents dealt from the seed could be read before the hunt. A search draws
// from what is left (names, objects, empty) with the same odds as a shuffle dealt at the start, keyed on the server tick
// of the search, which the player does not choose. A power that shows names (X-ray, Echo, Scan, ...) fixes the packages
// it shows at that moment, so what it shows is true; a fixed package is then readable in the state (documented limit).
// Walking is checked against the clock: a search or a place is refused unless there was time to walk there from the
// last action, around the buildings at full speed (paths.json), with slack for the network. Integer arithmetic only, no clock, no
// network; a state that round-trips through JSON exactly.
//
// Two starts: the platform's START opens the run as soon as it is paid (or practice begins); the player's GO is the START
// button on the how-to card. Nothing can be searched before GO, and the time bonus and the walking check count from it,
// so reading the card costs nothing (the run's cap still counts from START).
import { fnv1a, mulberry32 } from '../../common/det.js';
import paths from './paths.json' with { type: 'json' };

/* ================================ RULES ====================================
   Score = perName × names placed + floor(placed × max(0, bonusMax − bonusPerTick × ticks) / hidden), ticks counted from
   GO to the end of the run (all placed, FINISH, or the cap). 50 ms ticks: the bonus loses 100 a tick (2 a ms, as in
   the prototype) and is gone after 10 minutes. Distances in centimetres. */
export const RULES = {
  spots: 67,
  packages: 26,
  hidden: 8,
  objectsPerRun: 6,
  perName: 100_000,
  bonusMax: 1_200_000,
  bonusPerTick: 100,
  searchTicks: 16,          // 0.8 s
  rushSearchTicks: 4,       // Sugar rush: 4× faster
  reach: 400,               // a package can be searched from 4 m away
  walk: 45,                 // 9 m/s = 45 cm a tick
  sprint: 81,               // Sprint: 1.8×
  slackPct: 115,            // walking check: 15 % faster than full speed, plus slackTicks of network jitter
  slackTicks: 10,
};

/** The 67 places a package can be: [x cm, z cm, where]. Copied from the prototype's SPOTS (same order: a spot id is its index). */
export const SPOTS: readonly (readonly [number, number, string])[] = [
  [-2775, -3400, 'behind a roller mill'], [-2520, -1540, 'under a chute'], [-2775, 200, 'behind a roller mill'],
  [-2080, -3340, 'under a chute'], [-1825, -1600, 'behind a roller mill'], [-2080, 860, 'under a chute'],
  [-2860, -3840, 'in the flour sacks'], [-1780, 1840, 'in the flour sacks'], [-1460, 1000, 'by the barrels'],
  [400, -2200, 'inside Armazém 0108'], [-300, 200, 'inside Armazém 0108'], [500, 1100, 'inside Armazém 0108'],
  [2200, -800, 'in the long sheds'], [1800, 1200, 'in the long sheds'], [2200, -2700, 'in the ball pit'],
  [-2900, 5800, 'at the front of the main stage'], [-2000, 5400, 'in the main stage hall'], [-1500, 6200, 'in the main stage hall'],
  [800, 6830, 'inside the silo tower'], [1400, 6600, 'inside the silo tower'], [1800, 7080, 'inside the silo tower'],
  [100, -4130, 'under the NFC billboard'], [-2700, 2660, 'in community house 1'], [-1200, 2510, 'in community house 2'],
  [-400, 7840, 'in community house 3'], [400, 2260, 'in community house 4'], [1000, 5860, 'at the foot of the silos'],
  [-3740, -4140, 'at a market stall'], [-3740, -3340, 'at a market stall'], [-3740, -2540, 'at a market stall'],
  [-3740, -1740, 'at a market stall'], [-3740, -940, 'at a market stall'], [-3760, 50, 'by the bifana truck'],
  [-4050, 580, 'by the bifana truck'], [-3760, 1150, 'by the nata truck'], [-4050, 1680, 'by the nata truck'],
  [-3240, -3800, 'under a market table'], [-3240, -2200, 'under a market table'], [-3240, 750, 'under a market table'],
  [-2600, 7380, 'at the garden bar'], [-2150, 7550, 'at the garden bar'], [-3600, 7440, 'under a garden table'],
  [-3000, 7740, 'under a garden table'], [-1700, 7540, 'under a garden table'], [-1200, 6840, 'under a garden table'],
  [-1050, 7220, 'by the garden lounge'], [-3000, 3960, 'under a picnic table'], [-2400, 4360, 'under a picnic table'],
  [200, 4160, 'under a picnic table'], [800, 3760, 'under a picnic table'], [-470, 3180, 'by a bar stool'],
  [-1270, 3430, 'by a bar stool'], [-3600, 4580, 'by the courtyard lounge'], [-3660, 3100, 'behind a planter'],
  [1060, 3100, 'behind a planter'], [-3660, 4800, 'behind a planter'], [1060, 4800, 'behind a planter'],
  [-900, 3800, 'at the NFC totem'], [-1250, -3460, 'at the NFC totem'], [-2180, 4950, 'by the main stage sign'],
  [-1320, 2150, 'beside the JPEG FRENS house'], [2200, 2240, 'in front of the sheds stage'], [1800, -3600, 'in the ball pit'],
  [-1600, 5800, 'on the dance floor'], [2140, 6830, 'by the bubble machines'], [100, -3360, 'in front of the talks stage'],
  [-2860, -2000, 'under the pipes'],
];
/** Where a run starts: the north end of the alley. */
export const START = { x: -1100, z: -4650 };
/** Where PLACE works: in front of ON THE WALL (the prototype's nearWall()). */
export const WALL_ZONE = { x0: -1052, x1: -602, z0: -2700, z1: -300 };

/** The objects, in the prototype's order (an object id is its index). `ticks`: how long the effect lasts (0: instant). */
export const OBJECTS: readonly { id: string; ticks: number; bad?: true }[] = [
  { id: 'tram', ticks: 400 },     // Sprint: 1.8× speed (also widens the walking check)
  { id: 'sky', ticks: 200 },      // Low gravity (display only)
  { id: 'ladder', ticks: 300 },   // High ground (display only)
  { id: 'coat', ticks: 0 },       // Claim ticket: teleported to the wall
  { id: 'glasses', ticks: 160 },  // X-ray: fixes every closed package, shows the names
  { id: 'charger', ticks: 300 },  // Full battery: same, on the compass
  { id: 'foam', ticks: 60 },      // Echo: fixes the packages within 25 m
  { id: 'spray', ticks: 400 },    // Tag trail: fixes every closed package, arrows to the nearest name
  { id: 'ens', ticks: 0 },        // Scan: marks one hidden name
  { id: 'nata', ticks: 1200 },    // Sugar rush: searches 4× faster
  { id: 'clicker', ticks: 0 },    // Next slide: every package within 10 m is searched (objects stay in place)
  { id: 'sticker', ticks: 0 },    // Magnet: names within 12 m fly to you
  { id: 'swatch', ticks: 400 },   // Paint trail (display only)
  { id: 'lanyard', ticks: 0 },    // VIP pass: the next package opened holds a name
  { id: 'napkin', ticks: 300 },   // Seeds sprout: fixes the packages within 30 m
  { id: 'token', ticks: 200, bad: true },   // Buzzed (display only)
  { id: 'wallet', ticks: 60, bad: true },   // Cold storage: frozen, no search or place for 3 s
  { id: 'hat', ticks: 100, bad: true },     // Hat over eyes (display only)
];
/** Object ids by name (tests check they match OBJECTS). */
export const OBJ = { tram: 0, sky: 1, ladder: 2, coat: 3, glasses: 4, charger: 5, foam: 6, spray: 7, ens: 8, nata: 9, clicker: 10,
  sticker: 11, swatch: 12, lanyard: 13, napkin: 14, token: 15, wallet: 16, hat: 17 } as const;
export const OBJECT_COUNT = OBJECTS.length;
const RANGE = { foam: 2500, napkin: 3000, clicker: 1000, sticker: 1200 };

/** Package contents. */
export const UNDECIDED = -1, EMPTY = 0, NAME = 1, OBJECT = 2;
/** What `last` reports: the contents above, or a PLACE. */
export const PLACED = 3;
/** Where the player last acted: a package index, or one of these. */
export const AT_START = -1, AT_WALL = -2;

/* ============================ TYPES & VALIDATION ============================= */
export type RcrConfig = { game: 'roll-call-run'; maxTicks: number; roundTicks: number };
export type Play = {
  /** The run's packages: spot ids, ascending. A package index is a position in this list. */
  spots: number[];
  /** The wall panels to bring back, in the order they turn up. */
  names: number[];
  /** The objects of the run, in the order they turn up (object ids). */
  objects: number[];
  /** Per package: UNDECIDED until a search or a power fixes it, then EMPTY, NAME or OBJECT. */
  fixed: number[];
  /** Per package: 0 closed, 1 opened by a search, 2 opened by a power (Next slide, Magnet). */
  opened: number[];
  /** Names found (the first `found` of `names`), placed on the wall (the first `placed`), objects found, searches done. */
  found: number; placed: number; objectsFound: number; opens: number;
  /** A search in progress: [package, tick it completes]. */
  searching: [number, number] | null;
  /** Where the player last acted (a package index, AT_START or AT_WALL) and when: the walking check's origin. */
  loc: number; locTick: number;
  /** Per object id: the tick its effect ends (0: never had it). */
  fx: number[];
  /** VIP pass held: the next search finds a name. */
  vip: boolean;
  /** Packages marked by Scan. */
  scan: number[];
  /** Count of events, and the latest: [what (EMPTY/NAME/OBJECT/PLACED), package (-1 for a place), detail, tick].
   *  detail: the name's index in `names`, the object id, or the number of names placed. */
  seq: number;
  last: [number, number, number, number] | null;
  /** The tick the player pressed START on the how-to card (GO): the hunt's clock. Null until then. */
  goTick: number | null;
  /** The tick the run ended, and why. */
  endTick: number | null;
  endedBy: 'all' | 'finish' | 'cap' | null;
};
export type RcrState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: RcrConfig; play: Play };
export type RcrInput = { action: 'start' } | { action: 'go' } | { action: 'search'; spot: number } | { action: 'place' } | { action: 'finish' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isIntArray = (v: unknown, length: number, min: number, max: number): v is number[] => Array.isArray(v) && v.length === length && v.every((x) => isInt(x, min, max));
const MAX_INT = Number.MAX_SAFE_INTEGER;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const distinct = (a: readonly number[]): boolean => new Set(a).size === a.length;
const fail = (what: string): never => { throw new Error(`Invalid ROLL CALL RUN ${what}`); };

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): RcrConfig {
  if (!isObject(value) || value.game !== 'roll-call-run' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'roll-call-run', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, out-of-range number). */
export function parseInput(value: unknown): RcrInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'search') return exactKeys(value, ['action', 'spot']) && isInt(value.spot, 0, RULES.spots - 1) ? { action: 'search', spot: value.spot } : null;
  if (value.action === 'start' || value.action === 'go' || value.action === 'place' || value.action === 'finish') return exactKeys(value, ['action']) ? { action: value.action } : null;
  return null;
}

const PLAY_KEYS = ['spots', 'names', 'objects', 'fixed', 'opened', 'found', 'placed', 'objectsFound', 'opens', 'searching', 'loc', 'locTick',
  'fx', 'vip', 'scan', 'seq', 'last', 'goTick', 'endTick', 'endedBy'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
const count = (a: readonly number[], f: (v: number, i: number) => boolean): number => { let n = 0; a.forEach((v, i) => { if (f(v, i)) n++; }); return n; };

/** A run state as the coordinator hands it back: strict shape, bounded numbers, coherent counts. Throws otherwise. */
export function checkState(value: unknown): RcrState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  const K = RULES.packages;
  const { spots, names, objects, fixed, opened, fx, scan, searching, last } = p;
  if (!isIntArray(spots, K, 0, RULES.spots - 1) || spots.some((s, i) => i > 0 && s <= (spots[i - 1] as number))) return fail('state');
  if (!isIntArray(names, RULES.hidden, 1, 500) || !distinct(names)) return fail('state');
  if (!isIntArray(objects, RULES.objectsPerRun, 0, OBJECT_COUNT - 1) || !distinct(objects)) return fail('state');
  if (!isIntArray(fixed, K, UNDECIDED, OBJECT) || !isIntArray(opened, K, 0, 2)) return fail('state');
  if (!isIntArray(fx, OBJECT_COUNT, 0, MAX_INT)) return fail('state');
  if (!Array.isArray(scan) || scan.length > RULES.hidden || !scan.every((k) => isInt(k, 0, K - 1)) || !distinct(scan)) return fail('state');
  if (!isInt(p.found, 0, RULES.hidden) || !isInt(p.placed, 0, RULES.hidden) || !isInt(p.objectsFound, 0, RULES.objectsPerRun)
    || !isInt(p.opens, 0, K) || !isInt(p.loc, AT_WALL, K - 1) || !isInt(p.locTick, 0, MAX_INT) || typeof p.vip !== 'boolean'
    || !isInt(p.seq, 0, 1_000_000)) return fail('state');
  if (searching !== null && !(Array.isArray(searching) && searching.length === 2 && isInt(searching[0], 0, K - 1) && isInt(searching[1], 0, MAX_INT))) return fail('state');
  if (last !== null && !(Array.isArray(last) && last.length === 4 && isInt(last[0], EMPTY, PLACED) && isInt(last[1], -1, K - 1)
    && isInt(last[2], 0, OBJECT_COUNT) && isInt(last[3], 0, MAX_INT))) return fail('state');
  if (p.endTick !== null && !isInt(p.endTick, 0, MAX_INT)) return fail('state');
  if (p.goTick !== null && !isInt(p.goTick, 0, MAX_INT)) return fail('state');
  if (!(p.endedBy === null || p.endedBy === 'all' || p.endedBy === 'finish' || p.endedBy === 'cap')) return fail('state');
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  // the contents must add up: every opened package is fixed, the counts match, and what is left fits the closed packages
  const names1 = count(fixed, (v) => v === NAME), objs1 = count(fixed, (v) => v === OBJECT), undecided = count(fixed, (v) => v === UNDECIDED);
  if (fixed.some((v, i) => (opened[i] as number) > 0 && v === UNDECIDED)) return fail('contents');
  if (opened.some((v, i) => v === 2 && fixed[i] === OBJECT)) return fail('contents');
  if (count(fixed, (v, i) => v === NAME && (opened[i] as number) > 0) !== p.found || p.placed > p.found) return fail('contents');
  if (count(fixed, (v, i) => v === OBJECT && opened[i] === 1) !== p.objectsFound) return fail('contents');
  if (names1 > RULES.hidden || objs1 > RULES.objectsPerRun || undecided < (RULES.hidden - names1) + (RULES.objectsPerRun - objs1)) return fail('contents');
  if (scan.some((k) => fixed[k] !== NAME || opened[k] !== 0)) return fail('contents');
  if (p.opens !== count(opened, (v) => v === 1) ||(searching !== null && opened[searching[0]] !== 0)) return fail('contents');
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || gameOver !== (p.endTick !== null) || gameOver !== (p.endedBy !== null) || (p.endTick !== null && p.endTick > tick)
    || (p.goTick !== null && (startTick === null || p.goTick < startTick || p.goTick > tick))
    || (p.goTick === null && (p.opens > 0 || p.placed > 0 || searching !== null))) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      spots: spots.slice(), names: names.slice(), objects: objects.slice(), fixed: fixed.slice(), opened: opened.slice(),
      found: p.found, placed: p.placed, objectsFound: p.objectsFound, opens: p.opens,
      searching: searching === null ? null : [searching[0], searching[1]], loc: p.loc, locTick: p.locTick,
      fx: fx.slice(), vip: p.vip, scan: scan.slice(), seq: p.seq,
      last: last === null ? null : [last[0], last[1], last[2], last[3]], goTick: p.goTick, endTick: p.endTick, endedBy: p.endedBy,
    },
  };
}

/* ================================ GEOMETRY ================================== */
const spotOf = (play: Play, pkg: number): readonly [number, number, string] => SPOTS[play.spots[pkg] as number] as readonly [number, number, string];
const dist = (ax: number, az: number, bx: number, bz: number): number => Math.floor(Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz)));
/** Row of a place in the walking table: a package's spot id, then the start (67) and the wall (68). */
const placeOf = (play: Play, loc: number): number => (loc === AT_START ? RULES.spots : loc === AT_WALL ? RULES.spots + 1 : play.spots[loc] as number);
/** The shortest walk (cm) between two places the player can act from, around the buildings: a package is searchable
 *  from `reach` away (through a wall too), the wall from anywhere in its PLACE zone, the start is a point. Read from
 *  paths.json (scripts/roll-call-run-paths.ts), which keeps every entry a lower bound of the real walk. */
export function walkNeeded(play: Play, from: number, to: number): number {
  if (from === to) return 0;
  return (paths.table[placeOf(play, from)] as number[])[placeOf(play, to)] as number;
}

/* ================================ DEALING =================================== */
/** A uniform integer in [0, n) from the run's seed and a label: the same for every engine given the same values. */
export function drawInt(seed: number, label: string, n: number): number {
  return Math.floor(mulberry32(fnv1a(`roll-call-run:${seed}:${label}`))() * n);
}
function pick(rnd: () => number, from: readonly number[], n: number): number[] {
  const a = from.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i] as number; a[i] = a[j] as number; a[j] = t; }
  return a.slice(0, n);
}

/* ================================ ENGINE ==================================== */
/** `pool`: the wall panels a run may hide (the named panels 1..500 of the build-time snapshot). */
export function createEngine(pool: readonly number[]) {
  const namePool = pool.filter((p) => isInt(p, 1, 500));
  if (namePool.length < RULES.hidden) throw new Error('ROLL CALL RUN needs at least 8 names');

  function newPlay(seed: number): Play {
    const rnd = mulberry32(fnv1a(`roll-call-run:${seed}:deal`));
    const spots = pick(rnd, Array.from({ length: RULES.spots }, (_, i) => i), RULES.packages).sort((a, b) => a - b);
    const names = pick(rnd, namePool, RULES.hidden);
    const objects = pick(rnd, Array.from({ length: OBJECT_COUNT }, (_, i) => i), RULES.objectsPerRun);
    return {
      spots, names, objects, fixed: spots.map(() => UNDECIDED), opened: spots.map(() => 0),
      found: 0, placed: 0, objectsFound: 0, opens: 0, searching: null, loc: AT_START, locTick: 0,
      fx: OBJECTS.map(() => 0), vip: false, scan: [], seq: 0, last: null, goTick: null, endTick: null, endedBy: null,
    };
  }

  /* ---------------------------- contents ---------------------------- */
  const closed = (play: Play, k: number): boolean => play.opened[k] === 0;
  /** Names and objects not yet fixed to a package, and the closed packages still undecided. */
  function pools(play: Play): { names: number; objects: number; undecided: number[] } {
    const undecided: number[] = [];
    play.fixed.forEach((v, k) => { if (v === UNDECIDED) undecided.push(k); });
    return { names: RULES.hidden - count(play.fixed, (v) => v === NAME), objects: RULES.objectsPerRun - count(play.fixed, (v) => v === OBJECT), undecided };
  }
  /** Fixes an undecided package: one draw from what is left, the odds of a shuffle dealt at the start. */
  function decide(state: RcrState, k: number, tick: number, why: string): void {
    const play = state.play;
    if (play.fixed[k] !== UNDECIDED) return;
    const { names, objects, undecided } = pools(play);
    const r = drawInt(state.seed, `${why}:${tick}:${k}`, undecided.length);
    play.fixed[k] = r < names ? NAME : r < names + objects ? OBJECT : EMPTY;
  }
  /** VIP pass: make package k hold a name, keeping the totals. */
  function forceName(state: RcrState, k: number, tick: number): void {
    const play = state.play;
    if (play.fixed[k] === NAME) return;
    if (pools(play).names > 0) { play.fixed[k] = NAME; return; }       // the counts are derived, so the rest rebalances
    // every name left is already fixed somewhere: swap with one of those packages
    const holders: number[] = [];
    play.fixed.forEach((v, j) => { if (v === NAME && closed(play, j) && j !== k) holders.push(j); });
    if (!holders.length) return;                                          // all names found already
    const j = holders[drawInt(state.seed, `vip:${tick}:${k}`, holders.length)] as number;
    play.fixed[j] = play.fixed[k] as number; play.fixed[k] = NAME;
    play.scan = play.scan.filter((s) => s !== j);
  }
  /** Scan: mark one closed name, chosen uniformly among the names still out (fixed or not). */
  function scanOne(state: RcrState, tick: number): void {
    const play = state.play;
    const known: number[] = [];
    play.fixed.forEach((v, k) => { if (v === NAME && closed(play, k) && !play.scan.includes(k)) known.push(k); });
    const { names, undecided } = pools(play);
    const total = known.length + names;
    if (!total) return;
    const r = drawInt(state.seed, `scan:${tick}`, total);
    let k: number;
    if (r < known.length) k = known[r] as number;
    else { k = undecided[drawInt(state.seed, `scan-at:${tick}`, undecided.length)] as number; play.fixed[k] = NAME; }
    play.scan.push(k);
  }
  function event(play: Play, what: number, k: number, detail: number, tick: number): void { play.seq++; play.last = [what, k, detail, tick]; }
  /** Opens a fixed package: a name joins the carried names, an object takes effect (only when opened by a search). */
  function open(state: RcrState, k: number, by: 1 | 2, tick: number): void {
    const play = state.play;
    play.opened[k] = by;
    play.scan = play.scan.filter((s) => s !== k);
    const what = play.fixed[k] as number;
    if (what === NAME) { event(play, NAME, k, play.found, tick); play.found++; }
    else if (what === OBJECT) { const id = play.objects[play.objectsFound] as number; play.objectsFound++; event(play, OBJECT, k, id, tick); applyObject(state, id, k, tick); }
    else event(play, EMPTY, k, 0, tick);
  }
  const within = (play: Play, from: number, k: number, range: number): boolean => {
    const [ax, az] = spotOf(play, from), [bx, bz] = spotOf(play, k);
    return dist(ax, az, bx, bz) <= range + RULES.reach;
  };
  function applyObject(state: RcrState, id: number, k: number, tick: number): void {
    const play = state.play, o = OBJECTS[id] as (typeof OBJECTS)[number];
    if (o.ticks) play.fx[id] = tick + o.ticks;
    const each = (range: number | null, f: (j: number) => void): void => {
      for (let j = 0; j < play.spots.length; j++) if (j !== k && closed(play, j) && (range === null || within(play, k, j, range))) f(j);
    };
    switch (id) {
      case OBJ.coat: play.loc = AT_WALL; play.locTick = tick; break;
      case OBJ.glasses: case OBJ.charger: case OBJ.spray: each(null, (j) => decide(state, j, tick, 'show')); break;
      case OBJ.foam: each(RANGE.foam, (j) => decide(state, j, tick, 'show')); break;
      case OBJ.napkin: each(RANGE.napkin, (j) => decide(state, j, tick, 'show')); break;
      case OBJ.ens: scanOne(state, tick); break;
      case OBJ.lanyard: play.vip = true; break;
      case OBJ.clicker: each(RANGE.clicker, (j) => { decide(state, j, tick, 'slide'); if (play.fixed[j] !== OBJECT) open(state, j, 2, tick); }); break;
      case OBJ.sticker: each(RANGE.sticker, (j) => { decide(state, j, tick, 'magnet'); if (play.fixed[j] === NAME) open(state, j, 2, tick); }); break;
    }
  }
  /** A search completes at `tick`: the package is fixed (VIP pass first), then opened. */
  function completeSearch(state: RcrState, k: number, tick: number): void {
    const play = state.play;
    play.searching = null;
    if (play.vip) { play.vip = false; forceName(state, k, tick); }
    decide(state, k, tick, 'search');
    play.opens++;
    open(state, k, 1, tick);
  }

  /* ---------------------------- actions ---------------------------- */
  const active = (play: Play, id: number, tick: number): boolean => (play.fx[id] as number) > tick;
  /** Could the player have walked from the last action to `to` by `tick`? Sprint counts if it ran at any time since. */
  function walkedInTime(play: Play, to: number, tick: number): boolean {
    const speed = (play.fx[OBJ.tram] as number) > play.locTick ? RULES.sprint : RULES.walk;
    return RULES.slackPct * speed * (tick - play.locTick + RULES.slackTicks) >= 100 * walkNeeded(play, play.loc, to);
  }
  function search(state: RcrState, spot: number): void {
    const play = state.play, t = state.tick;
    const k = play.spots.indexOf(spot);
    if (k < 0 || !closed(play, k) || play.searching || active(play, OBJ.wallet, t) || !walkedInTime(play, k, t)) return;
    play.searching = [k, t + (active(play, OBJ.nata, t) ? RULES.rushSearchTicks : RULES.searchTicks)];
    play.loc = k; play.locTick = t;
  }
  function place(state: RcrState): void {
    const play = state.play, t = state.tick;
    if (play.found === play.placed || play.searching || active(play, OBJ.wallet, t) || !walkedInTime(play, AT_WALL, t)) return;
    event(play, PLACED, -1, play.found - play.placed, t);
    play.placed = play.found; play.loc = AT_WALL; play.locTick = t;
    if (play.placed === RULES.hidden) end(state, t, 'all');
  }
  function end(state: RcrState, tick: number, why: 'all' | 'finish' | 'cap'): void {
    state.gameOver = true; state.play.endTick = tick; state.play.endedBy = why; state.play.searching = null;
  }

  /* ----------------------- run lifecycle (coordinator contract) ----------------------- */
  function endTickOf(state: RcrState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  /** Mutating advance: completes a search whose time has come (at its own tick, whenever the call arrives) and ends the
   *  run at the cap. */
  function advanceInPlace(state: RcrState, serverTick: number): RcrState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const endTick = endTickOf(state), to = Math.min(serverTick, endTick);
    const s = state.play.searching;
    if (s && s[1] <= to) completeSearch(state, s[0], s[1]);
    state.tick = to;
    if (state.tick >= endTick) end(state, endTick, 'cap');
    return state;
  }
  const clone = (state: RcrState): RcrState => structuredClone(state);

  function createRun(seed: unknown, config: unknown): RcrState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return { tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules, play: newPlay(validSeed) };
  }
  function advance(state: RcrState, serverTick: number): RcrState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: RcrState, input: unknown, serverTick: number): RcrState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; state.play.locTick = state.tick; }
      return state;
    }
    if (!state.started) return state;
    if (action.action === 'go') {
      // the hunt begins at the start point: the walking check and the bonus count from here
      if (state.play.goTick === null) { state.play.goTick = state.tick; state.play.loc = AT_START; state.play.locTick = state.tick; }
      return state;
    }
    if (action.action === 'finish') { end(state, state.tick, 'finish'); return state; }
    if (state.play.goTick === null) return state;          // nothing to search or place before GO
    if (action.action === 'search') search(state, action.spot);
    else place(state);
    return state;
  }
  function applyInput(state: RcrState, input: unknown, serverTick: number): RcrState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: RcrState): RcrState => state;
  const isFinished = (state: RcrState): boolean => state.gameOver;
  const score = (state: RcrState): number => scoreParts(state).total;

  return { createRun, advance, applyInput, view, isFinished, score, advanceInPlace, applyInputInPlace, clone, endTickOf, newPlay };
}
export type RollCallRunEngine = ReturnType<typeof createEngine>;

/** Ticks from GO to the end of the run (or to now, while it runs); 0 before GO. */
export function elapsedTicks(state: RcrState): number {
  if (state.play.goTick === null) return 0;
  return (state.play.endTick ?? state.tick) - state.play.goTick;
}
/** The score and its two parts: names placed only (names still carried do not count). */
export function scoreParts(state: RcrState): { names: number; bonus: number; total: number } {
  const placed = state.play.placed;
  const names = placed * RULES.perName;
  const bonus = Math.floor((placed * Math.max(0, RULES.bonusMax - RULES.bonusPerTick * elapsedTicks(state))) / RULES.hidden);
  return { names, bonus, total: names + bonus };
}
