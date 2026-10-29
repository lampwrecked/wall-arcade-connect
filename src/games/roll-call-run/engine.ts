// ROLL CALL RUN for the page: the rules (core.ts, the very module the verifier runs) plus the zod schemas the shared shell
// uses to parse the coordinator's snapshots and the saved paid round. tests/roll-call-run.test.ts checks that these
// schemas accept and refuse what core.ts's hand-written checks do.
import * as z from 'zod/mini';
import { AT_WALL, EMPTY, OBJECT, OBJECT_COUNT, PLACED, RULES, UNDECIDED } from './core.js';

export * from './core.js';

/* ================================ SCHEMAS =================================== */
const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const pkg = z.int().check(z.gte(0), z.lte(RULES.packages - 1));
const ints = (length: number, min: number, max: number) => z.array(z.int().check(z.gte(min), z.lte(max))).check(z.length(length));

export const configSchema = z.object({
  game: z.literal('roll-call-run'),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));

const playSchema = z.strictObject({
  spots: ints(RULES.packages, 0, RULES.spots - 1),
  names: ints(RULES.hidden, 1, 500),
  objects: ints(RULES.objectsPerRun, 0, OBJECT_COUNT - 1),
  fixed: ints(RULES.packages, UNDECIDED, OBJECT),
  opened: ints(RULES.packages, 0, 2),
  found: nonNegInt.check(z.lte(RULES.hidden)),
  placed: nonNegInt.check(z.lte(RULES.hidden)),
  objectsFound: nonNegInt.check(z.lte(RULES.objectsPerRun)),
  opens: nonNegInt.check(z.lte(RULES.packages)),
  searching: z.nullable(z.tuple([pkg, nonNegInt])),
  loc: z.int().check(z.gte(AT_WALL), z.lte(RULES.packages - 1)),
  locTick: nonNegInt,
  fx: z.array(nonNegInt).check(z.length(OBJECT_COUNT)),
  vip: z.boolean(),
  scan: z.array(pkg).check(z.maxLength(RULES.hidden)),
  seq: nonNegInt.check(z.lte(1_000_000)),
  last: z.nullable(z.tuple([z.int().check(z.gte(EMPTY), z.lte(PLACED)), z.int().check(z.gte(-1), z.lte(RULES.packages - 1)),
    z.int().check(z.gte(0), z.lte(OBJECT_COUNT)), nonNegInt])),
  goTick: z.nullable(nonNegInt),
  endTick: z.nullable(nonNegInt),
  endedBy: z.nullable(z.enum(['all', 'finish', 'cap'])),
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  seed: z.uint32(), rules: configSchema, play: playSchema,
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks
  && s.gameOver === (s.play.endTick !== null) && s.play.placed <= s.play.found, 'Invalid ROLL CALL RUN timeline'));

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('go') }),
  z.strictObject({ action: z.literal('search'), spot: z.int().check(z.gte(0), z.lte(RULES.spots - 1)) }),
  z.strictObject({ action: z.literal('place') }),
  z.strictObject({ action: z.literal('finish') }),
]);

/* The coordinator's snapshot envelope (same shape as the other games'; only `state` differs). */
const finalScoreSchema = z.union([nonNegInt, z.pipe(z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)), nonNegInt)]);
const finalResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: finalScoreSchema, status: z.optional(z.string()) });
const expiredResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: z.optional(z.never()), status: z.literal('expired') });
export const snapshotSchema = z.union([
  z.object({
    runId: z.uuid(), configDigest: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
    serverTick: nonNegInt, inputSeq: nonNegInt, inputTick: z.int().check(z.gte(-1)),
    expiresAt: z.string().check(z.refine((v) => Number.isFinite(Date.parse(v)), 'Invalid expiry')),
    state: stateSchema,
    result: z.nullable(z.union([finalResultSchema, expiredResultSchema])),
    status: z.optional(z.string()),
  }),
  z.object({ error: z.string(), serverTick: z.optional(nonNegInt) }),
]);
