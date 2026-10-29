// ROLL CALL RUN's verifier: the rules (core.ts) behind the protocol envelope, without a schema library, so a cold isolate
// starts fast. The names it may hide come from the build-time wall snapshot (the verifier has no network).
import { checkState, createEngine } from '../games/roll-call-run/core.js';
import { ELIG } from '../generated/wall.js';
import { makePlainVerifier } from './protocol-plain.js';

const engine = createEngine(ELIG);
export default makePlainVerifier({
  checkState,
  createRun: engine.createRun, advance: engine.advance, applyInput: engine.applyInput,
  view: engine.view, isFinished: engine.isFinished, score: engine.score,
});
