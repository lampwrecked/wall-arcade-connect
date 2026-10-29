// ROLL CALL RUN: the browser side. The 3D yard (world.js, the prototype's) walks and looks locally and turns a press of
// START (on the how-to card), SEARCH, PLACE or FINISH into ONE ordered input: { action: 'go' } / { action: 'search', spot } /
// { action: 'place' } / { action: 'finish' }.
// It never sends a position, a score, a time or a state, and it never decides what a package holds: everything a run
// shows is read from the platform's authoritative state (with the player's own queued inputs applied by core.ts).
import type { GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { scoringConfiguration } from '../../shell/config.js';
import { ELIG } from '../../generated/wall.js';
import { RULES, createEngine, elapsedTicks, inputSchema, scoreParts, snapshotSchema, stateSchema, type RcrState } from './engine.js';
import { createWorld } from './world.js';

const engine = createEngine(ELIG);
const fmtTime = (ticks: number): string => { const s = Math.floor(ticks / 20); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.replaceChildren();
  const world = createWorld(host, {
    go: () => io.sendInput({ action: 'go' }),
    canGo: () => io.canInput(),
    search: (spot) => io.sendInput({ action: 'search', spot }),
    place: () => io.sendInput({ action: 'place' }),
    finish: () => io.sendInput({ action: 'finish' }),
    // one action at a time: nothing new while an input is still on its way, so a search is only ever shown as the
    // server answered it
    canAct: () => io.canInput() && io.pendingCount() === 0,
    tick: () => io.estimatedTick(),
  });
  return {
    setMessage(_text, extra) {
      if (extra?.idle) { world.idle(); return; }
      if (extra?.view && typeof extra.view === 'object') world.show(extra.view as RcrState, Boolean(extra.practice));
    },
    hideRun(): void { /* the yard stays on screen behind the page's own screens */ },
    showRun(view: RcrState, info) { world.show(view, Boolean(info.practice)); },
  };
}

export const rollCallRunAdapter: GameAdapter = {
  id: 'roll-call-run',
  title: 'ROLL CALL RUN',
  heading: 'Find the names, bring them home',
  tagline: 'Eight names are missing from the wall. Open packages around the Unicorn Factory, find them, and place them back ON THE WALL.',
  lede: 'Eight names have gone missing from the wall. Walk the Unicorn Factory yard, open packages to find them (some hold objects that help, some don\'t), and carry them back: PLACE at the wall returns every name you carry. 100,000 points a name, plus a time bonus that runs out after 10 minutes. Phone: drag left to walk, right to look. Desktop: WASD and the mouse, Enter to search. One credit per run, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: RcrState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: RcrState) => scoreParts(state).total,
  statusLine(state: RcrState): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    if (state.play.goTick === null) return 'Read the card, then press START: your time starts then.';
    return `${state.play.placed} of ${RULES.hidden} names back on the wall · ${fmtTime(elapsedTicks(state))}`;
  },
  createStage,
  diagSummary: (state: RcrState) => ({
    tick: state.tick, started: state.started, gameOver: state.gameOver, found: state.play.found, placed: state.play.placed,
    opens: state.play.opens, searching: state.play.searching, seq: state.play.seq, endedBy: state.play.endedBy,
  }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('roll-call-run')),
    advance: (state: RcrState, tick: number) => engine.advance(state, tick),
  },
};
