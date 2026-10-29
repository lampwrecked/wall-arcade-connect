import type { RcrState } from './core.js';

export interface WorldHooks {
  /** START on the how-to card: `{ action: 'go' }`. */
  go(): void;
  /** Can GO be sent now (the run is open on the server side)? */
  canGo(): boolean;
  /** SEARCH on a package: one input, `{ action: 'search', spot }`. */
  search(spot: number): void;
  place(): void;
  finish(): void;
  /** May the player act now (a run is on, nothing on its way to the server)? */
  canAct(): boolean;
  /** The server tick the player is at (estimated between two states). */
  tick(): number;
}
export interface World {
  show(state: RcrState, practice: boolean): void;
  idle(): void;
}
export function createWorld(host: HTMLElement, hooks: WorldHooks): World;
