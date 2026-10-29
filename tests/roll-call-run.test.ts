import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { scoringConfiguration } from '../src/shell/config.js';
import {
  AT_START, AT_WALL, EMPTY, NAME, OBJ, OBJECT, OBJECTS, PLACED, RULES, SPOTS, UNDECIDED,
  checkState, createEngine, inputSchema, parseInput, scoreParts, stateSchema, walkNeeded, type RcrState,
} from '../src/games/roll-call-run/engine.js';
import paths from '../src/games/roll-call-run/paths.json' with { type: 'json' };
import { ELIG } from '../src/generated/wall.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('roll-call-run');
const engine = createEngine(ELIG);
/** A run the platform started (tick 1) and the player sent off with GO (tick 2). */
const started = (seed: number): RcrState => engine.applyInput(engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 1), { action: 'go' }, 2);

/** The tick a player walking at full speed (no slack) reaches `to` from the last action. */
function honestTick(s: RcrState, to: number): number {
  const p = s.play, speed = (p.fx[OBJ.tram] as number) > p.locTick ? RULES.sprint : RULES.walk;
  return Math.max(s.tick + 1, p.locTick + Math.ceil(walkNeeded(p, p.loc, to) / speed));
}
/** The earliest tick the walking check accepts (full speed plus the slack). */
function earliestTick(s: RcrState, to: number): number {
  const p = s.play, speed = (p.fx[OBJ.tram] as number) > p.locTick ? RULES.sprint : RULES.walk, need = walkNeeded(p, p.loc, to);
  let e = 0;
  while (RULES.slackPct * speed * (e + RULES.slackTicks) < 100 * need) e++;
  return p.locTick + e;
}
const closedPackages = (s: RcrState): number[] => s.play.spots.map((_, k) => k).filter((k) => s.play.opened[k] === 0);
const nearest = (s: RcrState): number => closedPackages(s).sort((a, b) => walkNeeded(s.play, s.play.loc, a) - walkNeeded(s.play, s.play.loc, b))[0] as number;
const spotOf = (s: RcrState, k: number): number => s.play.spots[k] as number;

/** A tidy player: nearest package first, walks at full speed, goes to the wall once every name is found. */
function playRun(seed: number, onStep?: (s: RcrState) => void): { state: RcrState; inputs: { input: unknown; tick: number }[] } {
  let s = started(seed);
  const inputs: { input: unknown; tick: number }[] = [{ input: { action: 'start' }, tick: 1 }, { input: { action: 'go' }, tick: 2 }];
  const send = (input: unknown, tick: number): void => { s = engine.applyInput(s, input, tick); inputs.push({ input, tick }); onStep?.(s); };
  for (let guard = 0; !s.gameOver && guard < 2000; guard++) {
    const p = s.play;
    if (p.searching) { s = engine.advance(s, p.searching[1]); onStep?.(s); continue; }
    if (p.found > p.placed && (p.found === RULES.hidden || !closedPackages(s).length)) send({ action: 'place' }, honestTick(s, AT_WALL));
    else { const k = nearest(s); send({ action: 'search', spot: spotOf(s, k) }, honestTick(s, k)); }
  }
  return { state: s, inputs };
}

test('roll-call-run: a run deals 26 of the 67 spots, 8 names and 6 objects, and fixes no contents at the start', () => {
  assert.equal(SPOTS.length, RULES.spots);
  for (const [id, i] of Object.entries(OBJ)) assert.equal(OBJECTS[i]?.id, id);
  for (const seed of [0, 1, 123456, 0xffffffff]) {
    const s = engine.createRun(seed, CONFIG);
    assert.equal(s.play.spots.length, 26); assert.equal(new Set(s.play.spots).size, 26);
    assert.equal(new Set(s.play.names).size, 8); assert.ok(s.play.names.every((p) => ELIG.includes(p) && p <= 500));
    assert.equal(new Set(s.play.objects).size, 6);
    assert.ok(s.play.fixed.every((v) => v === UNDECIDED), 'nothing in the state says where the names are');
    assert.deepEqual(engine.createRun(seed, CONFIG), s, 'same seed, same deal');
  }
});

test('roll-call-run: inputs are validated strictly (wrong action, extra field, out-of-range spot are no-ops)', () => {
  assert.equal(parseInput({ action: 'search', spot: 3, x: 1 }), null);
  assert.equal(parseInput({ action: 'search', spot: 67 }), null);
  assert.equal(parseInput({ action: 'search', spot: -1 }), null);
  assert.equal(parseInput({ action: 'search', spot: 1.5 }), null);
  assert.equal(parseInput({ action: 'search', spot: '3' }), null);
  assert.equal(parseInput({ action: 'place', count: 8 }), null);
  assert.equal(parseInput({ action: 'score', score: 9_999_999 }), null);
  assert.equal(parseInput([{ action: 'start' }]), null);
  for (const bad of [{ action: 'search', spot: 3, x: 1 }, { action: 'place', count: 8 }, { action: 'finish', score: 1 }, { action: 'teleport' }]) {
    assert.equal(inputSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const s = started(7);
  const inactive = Array.from({ length: RULES.spots }, (_, i) => i).find((i) => !s.play.spots.includes(i)) as number;
  for (const forged of [{ action: 'search', spot: inactive }, { action: 'search', spot: 3, extra: true }, { action: 'place' }, { action: 'nope' }, null, 42]) {
    const after = engine.applyInput(s, forged, 500);
    assert.deepEqual(after.play, s.play, `no-op: ${JSON.stringify(forged)}`);
    assert.equal(scoreParts(after).total, 0);
  }
});

test('roll-call-run: the first input is START; anything before it is a no-op, and START twice changes nothing', () => {
  const fresh = engine.createRun(9, CONFIG);
  const early = engine.applyInput(fresh, { action: 'search', spot: fresh.play.spots[0] }, 1);
  assert.equal(early.started, false); assert.equal(early.play.searching, null);
  const s = engine.applyInput(early, { action: 'start' }, 2);
  assert.equal(s.started, true); assert.equal(s.startTick, 2);
  const again = engine.applyInput(s, { action: 'start' }, 40);
  assert.equal(again.startTick, 2, 'a resent START (lost first input) does not restart the clock');
});

test('roll-call-run: GO (START on the how-to card) opens the hunt; time reading the card costs nothing', () => {
  const open = engine.applyInput(engine.createRun(5, CONFIG), { action: 'start' }, 1);
  assert.equal(open.play.goTick, null);
  const spot = open.play.spots[0] as number;
  // before GO: no search, no place; the clock of the bonus has not started
  const early = engine.applyInput(open, { action: 'search', spot }, 4000);
  assert.equal(early.play.searching, null); assert.equal(engine.score(early), 0);
  assert.equal(engine.applyInput(open, { action: 'go', x: 1 }, 5).play.goTick, null, 'strict: no extra field');
  // GO after a minute on the card: the walking check and the bonus count from GO, not from START
  const go = engine.applyInput(open, { action: 'go' }, 1201);
  assert.equal(go.play.goTick, 1201); assert.equal(go.play.locTick, 1201); assert.equal(go.play.loc, AT_START);
  assert.equal(engine.applyInput(go, { action: 'go' }, 1300).play.goTick, 1201, 'a second GO changes nothing');
  const { state } = playRun(77);
  const late = engine.applyInput(go, { action: 'search', spot: spotOf(go, 0) }, 1202);
  assert.equal(late.play.searching, null, 'the minute on the card does not count as walking time');
  assert.ok(state.play.goTick === 2);
  // FINISH is allowed before GO (it ends with nothing placed)
  const quit = engine.applyInput(open, { action: 'finish' }, 50);
  assert.equal(quit.gameOver, true); assert.equal(engine.score(quit), 0);
});

test('roll-call-run: walking is checked against the clock (search or place too soon is refused, in time is accepted)', () => {
  const s = started(11);
  const far = closedPackages(s).sort((a, b) => walkNeeded(s.play, AT_START, b) - walkNeeded(s.play, AT_START, a))[0] as number;
  assert.ok(walkNeeded(s.play, AT_START, far) > 50_00, 'the farthest package is more than 50 m away');
  const ok = earliestTick(s, far);
  const tooSoon = engine.applyInput(s, { action: 'search', spot: spotOf(s, far) }, ok - 1);
  assert.equal(tooSoon.play.searching, null, 'refused one tick before the slack allows it');
  const inTime = engine.applyInput(s, { action: 'search', spot: spotOf(s, far) }, honestTick(s, far));
  assert.deepEqual(inTime.play.searching?.[0], far, 'a player walking at full speed is accepted');
  // place: nothing carried, then too soon from far away
  const done = engine.advance(inTime, (inTime.play.searching as [number, number])[1]);
  const forced = structuredClone(done);
  if (forced.play.fixed[far] !== NAME) return;   // only meaningful when it held a name; covered by the scripted runs too
  assert.equal(engine.applyInput(forced, { action: 'place' }, done.tick + 1).play.placed, 0, 'the wall is far from here');
});

test('roll-call-run: walks are measured around the buildings (paths.json), never shorter than a straight line', () => {
  const table = paths.table;
  assert.equal(table.length, RULES.spots + 2);
  table.forEach((row, a) => { assert.equal(row.length, RULES.spots + 2); assert.equal(row[a], 0);
    row.forEach((v, b) => { assert.ok(Number.isSafeInteger(v) && v >= 0); assert.equal(v, table[b]?.[a], 'symmetric'); }); });
  // spot to spot: at least the straight line between the two 4 m reach circles (less the grid's 3 % and 50 cm)
  for (let a = 0; a < RULES.spots; a++) for (let b = a + 1; b < RULES.spots; b++) {
    const [ax, az] = SPOTS[a] as readonly [number, number, string], [bx, bz] = SPOTS[b] as readonly [number, number, string];
    const straight = Math.max(0, Math.hypot(ax - bx, az - bz) - 2 * RULES.reach);
    assert.ok((table[a]?.[b] as number) >= straight * 0.97 - 50, `${a} -> ${b}`);
  }
  // the ball pit (62) and the talks stage (65) are 9 m apart through the sheds' wall, 36 m on foot
  assert.ok((table[62]?.[65] as number) > 3_000);
  // a search there at straight-line speed is refused; at walking speed around the building it is accepted
  const s = structuredClone(started(1));
  s.play.spots = [...s.play.spots.filter((x) => x !== 62 && x !== 65).slice(0, RULES.packages - 2), 62, 65].sort((x, y) => x - y);
  s.play.loc = s.play.spots.indexOf(62); s.play.locTick = 100; s.tick = 100;
  const at = checkState(JSON.parse(JSON.stringify(s)));
  const straightTicks = 100 + Math.ceil(920 / RULES.walk);
  assert.equal(engine.applyInput(at, { action: 'search', spot: 65 }, straightTicks).play.searching, null, 'through the wall: too soon');
  assert.notEqual(engine.applyInput(at, { action: 'search', spot: 65 }, honestTick(at, at.play.spots.indexOf(65))).play.searching, null);
});

test('roll-call-run: one search at a time; a search takes 0.8 s and only then is the package decided', () => {
  const s = started(21);
  const k = nearest(s);
  const a = engine.applyInput(s, { action: 'search', spot: spotOf(s, k) }, honestTick(s, k));
  const until = (a.play.searching as [number, number])[1];
  assert.equal(until - a.tick, RULES.searchTicks);
  assert.equal(a.play.fixed[k], UNDECIDED, 'still undecided while searching');
  const other = closedPackages(a).find((j) => j !== k) as number;
  const b = engine.applyInput(a, { action: 'search', spot: spotOf(a, other) }, until - 1);
  assert.deepEqual(b.play.searching, a.play.searching, 'a second search during a search is refused');
  const c = engine.advance(a, until);
  assert.equal(c.play.searching, null); assert.notEqual(c.play.fixed[k], UNDECIDED); assert.equal(c.play.opened[k], 1);
  assert.equal(c.play.opens, 1); assert.equal(c.play.seq, 1); assert.equal(c.play.last?.[3], until, 'decided at its own tick');
  // advancing past the completion in one call gives the same result as stopping at it
  assert.deepEqual(engine.advance(a, until + 500).play, engine.advance(c, until + 500).play);
});

test('roll-call-run: what a package holds depends on the tick of the search, not on the seed alone', () => {
  let differs = 0;
  for (let seed = 0; seed < 40; seed++) {
    const s = started(seed), k = nearest(s), t0 = honestTick(s, k);
    const outcomes = new Set<number>();
    for (let t = t0; t < t0 + 12; t++) {
      const a = engine.applyInput(s, { action: 'search', spot: spotOf(s, k) }, t);
      outcomes.add(engine.advance(a, (a.play.searching as [number, number])[1]).play.fixed[k] as number);
    }
    if (outcomes.size > 1) differs++;
  }
  assert.ok(differs > 20, `the same package, searched a tick apart, gives different contents (${differs}/40 seeds)`);
});

test('roll-call-run: the odds equal a shuffle dealt at the start (8 names and 6 objects among 26)', () => {
  const N = 4000;
  let names = 0, objects = 0, lastNames = 0;
  for (let seed = 0; seed < N; seed++) {
    const s = started(seed), k = nearest(s);
    const a = engine.applyInput(s, { action: 'search', spot: spotOf(s, k) }, honestTick(s, k));
    const v = engine.advance(a, (a.play.searching as [number, number])[1]).play.fixed[k];
    if (v === NAME) names++; else if (v === OBJECT) objects++;
  }
  assert.ok(Math.abs(names / N - 8 / 26) < 0.03, `first search holds a name ${(names / N).toFixed(3)} of the time (8/26 = 0.308)`);
  assert.ok(Math.abs(objects / N - 6 / 26) < 0.03, `first search holds an object ${(objects / N).toFixed(3)} of the time (6/26 = 0.231)`);
  // every package of every run gets opened in the end: exactly 8 names, 6 objects
  for (let seed = 0; seed < 60; seed++) {
    const { state } = playRun(seed);
    assert.equal(state.play.found, 8); assert.equal(state.play.endedBy, 'all');
    assert.ok(state.play.fixed.filter((v) => v === NAME).length === 8 && state.play.fixed.filter((v) => v === OBJECT).length <= 6);
    lastNames += state.play.placed;
  }
  assert.equal(lastNames, 60 * 8);
});

test('roll-call-run: every state of a run passes the hand-written check and the zod schema, and round-trips through JSON', () => {
  for (const seed of [3, 4, 5, 6]) {
    playRun(seed, (s) => {
      const copy = JSON.parse(JSON.stringify(s)) as unknown;
      assert.deepEqual(checkState(copy), s);
      assert.equal(stateSchema.safeParse(copy).success, true);
    });
  }
  const s = started(3);
  for (const broken of [
    { ...s, extra: 1 },
    { ...s, play: { ...s.play, found: 1 } },                                  // a name found with no opened package
    { ...s, play: { ...s.play, fixed: s.play.fixed.map(() => NAME) } },      // 26 names
    { ...s, play: { ...s.play, opened: s.play.opened.map((v, i) => (i === 0 ? 1 : v)) } },   // opened but undecided
    { ...s, play: { ...s.play, placed: 3 } },
  ]) assert.throws(() => checkState(JSON.parse(JSON.stringify(broken))), /Invalid ROLL CALL RUN/);
});

test('roll-call-run: score = 100,000 a placed name + the time bonus; carried names do not count; FINISH and the cap end the run', () => {
  const { state } = playRun(77);
  const ticks = (state.play.endTick as number) - (state.play.goTick as number);
  assert.equal(engine.score(state), 8 * 100_000 + Math.max(0, 1_200_000 - 100 * ticks));
  // finish while carrying: only placed names count
  let s = started(78);
  for (let guard = 0; s.play.found === 0 && guard < 30; guard++) {
    if (s.play.searching) { s = engine.advance(s, s.play.searching[1]); continue; }
    const k = nearest(s); s = engine.applyInput(s, { action: 'search', spot: spotOf(s, k) }, honestTick(s, k));
  }
  assert.ok(s.play.found > 0);
  const finished = engine.applyInput(s, { action: 'finish' }, s.tick + 1);
  assert.equal(finished.gameOver, true); assert.equal(finished.play.endedBy, 'finish'); assert.equal(engine.score(finished), 0);
  assert.deepEqual(engine.applyInput(finished, { action: 'place' }, finished.tick + 100).play, finished.play, 'nothing after the end');
  // the cap
  const capped = engine.advance(started(79), 1 + CONFIG.roundTicks + 5);
  assert.equal(capped.gameOver, true); assert.equal(capped.play.endedBy, 'cap'); assert.equal(capped.tick, 1 + CONFIG.roundTicks);
});

/** A started run whose first object (and the package nearest the start) is set up for one power. */
function withObject(id: keyof typeof OBJ, seed = 101): { s: RcrState; k: number } {
  const s = structuredClone(started(seed));
  const k = nearest(s);
  s.play.objects = [OBJ[id], ...s.play.objects.filter((o) => o !== OBJ[id]).slice(0, 5)];
  s.play.fixed[k] = OBJECT;
  return { s: checkState(JSON.parse(JSON.stringify(s))), k };
}
function openIt(s: RcrState, k: number): RcrState {
  const a = engine.applyInput(s, { action: 'search', spot: spotOf(s, k) }, honestTick(s, k));
  return engine.advance(a, (a.play.searching as [number, number])[1]);
}

test('roll-call-run: powers are resolved by the server (Claim ticket, Cold storage, Sugar rush, VIP pass, Scan, X-ray, Magnet, Next slide)', () => {
  // Claim ticket: the player is at the wall at once
  { const { s, k } = withObject('coat'); const a = openIt(s, k); assert.equal(a.play.loc, AT_WALL); assert.equal(a.play.last?.[0], OBJECT); }
  // Cold storage: no search for 3 s
  { const { s, k } = withObject('wallet'); const a = openIt(s, k); const j = nearest(a), thaw = a.play.fx[OBJ.wallet] as number;
    assert.equal(thaw, a.tick + 60);
    const t = Math.max(a.tick + 1, earliestTick(a, j));
    if (t < thaw) assert.equal(engine.applyInput(a, { action: 'search', spot: spotOf(a, j) }, t).play.searching, null, 'frozen');
    assert.notEqual(engine.applyInput(a, { action: 'search', spot: spotOf(a, j) }, Math.max(t, thaw)).play.searching, null, 'thawed'); }
  // Sugar rush: the next search takes 4 ticks
  { const { s, k } = withObject('nata'); const a = openIt(s, k); const j = nearest(a);
    const b = engine.applyInput(a, { action: 'search', spot: spotOf(a, j) }, honestTick(a, j));
    assert.equal((b.play.searching as [number, number])[1] - b.tick, RULES.rushSearchTicks); }
  // VIP pass: the next package opened holds a name
  for (let seed = 200; seed < 230; seed++) { const { s, k } = withObject('lanyard', seed); const a = openIt(s, k); assert.equal(a.play.vip, true);
    const j = nearest(a); const b = openIt(a, j); assert.equal(b.play.fixed[j], NAME); assert.equal(b.play.vip, false); }
  // Scan: one closed package is marked and really holds a name
  for (let seed = 300; seed < 330; seed++) { const { s, k } = withObject('ens', seed); const a = openIt(s, k);
    assert.equal(a.play.scan.length, 1); assert.equal(a.play.fixed[a.play.scan[0] as number], NAME); assert.equal(a.play.opened[a.play.scan[0] as number], 0); }
  // X-ray: every closed package is fixed, 7 or 8 names among them (the counts always add up)
  { const { s, k } = withObject('glasses'); const a = openIt(s, k);
    assert.ok(a.play.fixed.every((v) => v !== UNDECIDED)); assert.equal(a.play.fixed.filter((v) => v === NAME).length, 8);
    assert.equal(a.play.fixed.filter((v) => v === OBJECT).length, 6); assert.ok(a.play.fx[OBJ.glasses] as number > a.tick); }
  // Magnet and Next slide: names nearby are carried, objects stay where they are
  for (const id of ['sticker', 'clicker'] as const) for (let seed = 400; seed < 440; seed++) {
    const { s, k } = withObject(id, seed); const a = openIt(s, k);
    a.play.opened.forEach((v, j) => { if (v === 2) assert.notEqual(a.play.fixed[j], OBJECT); });
    assert.equal(a.play.found, a.play.fixed.filter((v, j) => v === NAME && (a.play.opened[j] as number) > 0).length);
    assert.equal(a.play.opens, 1, 'a power opening packages is not a search');
  }
});

test('roll-call-run: a tidy player finishes in a few minutes; the PLACE event reports how many names went back', () => {
  const times: number[] = [];
  for (let seed = 500; seed < 540; seed++) {
    let places = 0;
    const { state } = playRun(seed, (s) => { if (s.play.last?.[0] === PLACED && s.play.last[3] === s.tick) places++; });
    assert.ok(places >= 1);
    times.push(((state.play.endTick as number) - (state.startTick as number)) * 50 / 1000);
  }
  times.sort((a, b) => a - b);
  console.log(`  roll-call-run tidy player: median ${times[20]?.toFixed(1)} s, fastest ${times[0]?.toFixed(1)} s, slowest ${times[39]?.toFixed(1)} s`);
  assert.ok((times[20] as number) < 600, 'the median tidy run beats the 10-minute bonus');
  assert.equal(EMPTY, 0);
});

test('roll-call-run: the BUILT verifier equals the engine (whole runs and a replay), is small, fast and zod-free, and refuses forged requests', async () => {
  const bundle = await build({ entryPoints: ['src/verifiers/roll-call-run.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false });
  const code = bundle.outputFiles[0]?.contents as Uint8Array;
  assert.ok(code.byteLength < 256_000, `verifier ${code.byteLength} B`);
  assert.ok(!/zod|ZodError|\$ZodType/.test(new TextDecoder().decode(code)), 'zod-free verifier');
  const verifier = await loadBuiltVerifier(code);
  // the first Request/Response of a Node process costs ~17 ms whatever the game (FULL ROW's too): not part of a call's CPU
  await new Coordinator<RcrState>(verifier, CONFIG, 1).create();
  for (const seed of [123456, 0, 0xfeedface]) {
    const { state, inputs } = playRun(seed);
    const run = new Coordinator<RcrState>(verifier, CONFIG, seed);
    await run.create();
    for (const { input, tick } of inputs) await run.input(input, tick);
    await run.advanceTo(state.tick);
    assert.deepEqual(run.state, state, 'the built verifier gives the in-process engine state');
    assert.equal(await run.score(), engine.score(state)); assert.equal(await run.isFinished(), true);
    const again = new Coordinator<RcrState>(verifier, CONFIG, seed);
    await again.create();
    for (const { input, tick } of inputs) await again.input(input, tick);
    await again.advanceTo(state.tick);
    assert.deepEqual(again.state, run.state, 'replay: same seed and inputs at the same ticks, same run');
    console.log(`  roll-call-run built verifier (seed ${seed}): ${run.calls} calls, score ${await run.score()}, largest state ${run.largestState} B, worst call ${run.worstMs.toFixed(2)} ms`);
    assert.ok(run.largestState < 4096); assert.ok(run.worstMs < 10, `worst call ${run.worstMs} ms`);
  }
  const probe = new Coordinator<RcrState>(verifier, CONFIG, 0);
  const s = await probe.create();
  const post = (payload: unknown) => verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  assert.equal((await post({ version: 1, op: 'submitScore', score: 999999 })).status, 400);
  assert.equal((await post({ version: 1, op: 'score', state: { ...s, play: { ...s.play, placed: 8 } } })).status, 400, 'a forged score state is refused');
  assert.equal((await post({ version: 1, op: 'score', state: { ...s, play: { ...s.play, fixed: s.play.fixed.map(() => NAME) } } })).status, 400);
  assert.equal((await post({ version: 1, op: 'createRun', seed: 1, config: { ...CONFIG, game: 'full-row' } })).status, 400);
});
