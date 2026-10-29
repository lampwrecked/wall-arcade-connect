// ROLL CALL RUN's HUD styles: the prototype's, scoped to the game area (.rcr) instead of the whole page, and positioned
// in it (absolute) instead of on the screen (fixed), so the arcade's own screens sit over the yard.
export default `
.rcr {
  --display: "Anton", "Impact", "Arial Narrow", sans-serif;
  --rmono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  position: absolute; inset: 0; overflow: hidden; font-family: var(--rmono); color: var(--ink);
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.rcr [hidden] { display: none !important; }
.rcr > .practice-tag { display: none; }   /* the HUD carries its own practice label */
.rcr .rcr-view { position: absolute; inset: 0; }
.rcr .rcr-view canvas { display: block; width: 100%; height: 100%; }

.rcr .hud {
  position: absolute; left: 0; right: 0; top: 0; z-index: 5; pointer-events: none;
  display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
  padding: 10px max(16px, env(safe-area-inset-right, 0px)) 0 max(56px, env(safe-area-inset-left, 0px));
}
.rcr .hud .tag { background: var(--ink); color: var(--chalk); padding: 6px 10px; display: flex; flex-direction: column; gap: 2px; }
.rcr .hud .lab { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; opacity: .7; }
.rcr .hud .big { font-family: var(--display); font-size: 26px; line-height: 1; font-variant-numeric: tabular-nums; }
.rcr .mute { position: absolute; z-index: 6; right: max(16px, env(safe-area-inset-right, 0px)); top: 96px;
  border: 1px solid var(--chalk); background: rgba(11,11,11,.6); color: var(--chalk); font-family: var(--rmono); font-size: 11px; letter-spacing: .12em; padding: 5px 10px; cursor: pointer; min-height: 0; }
.rcr .mute[aria-pressed="true"] { opacity: .6; }
.rcr .finish {
  position: absolute; z-index: 6; left: 50%; transform: translateX(-50%); top: 54px; min-height: 0;
  border: 1px solid var(--chalk); background: rgba(11,11,11,.6); color: var(--chalk); font-family: var(--rmono); font-size: 11px; letter-spacing: .12em; padding: 5px 10px; cursor: pointer;
}
.rcr .finish:focus-visible { outline: 3px solid var(--chalk); outline-offset: 2px; }
.rcr .practice { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; background: var(--chalk); color: var(--ink); padding: 4px 8px; align-self: center; }
.rcr .carry {
  position: absolute; left: 50%; transform: translateX(-50%); z-index: 5; pointer-events: none;
  top: 90px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 80%;
}
.rcr .carry .name { background: var(--blue); color: var(--chalk); font-family: var(--display); font-size: 22px; padding: 4px 12px; letter-spacing: .02em; overflow-wrap: anywhere; }
.rcr .carry .hint { background: var(--chalk); font-size: 11px; padding: 3px 8px; letter-spacing: .06em; }
.rcr .arrow { width: 34px; height: 34px; transition: transform .1s linear; }
.rcr .toast {
  position: absolute; left: 50%; transform: translateX(-50%); z-index: 6; pointer-events: none; bottom: 190px;
  background: var(--ink); color: var(--chalk); padding: 8px 14px; font-size: 13px; letter-spacing: .04em; max-width: 86%; text-align: center;
}
.rcr .act {
  position: absolute; z-index: 6; right: max(18px, env(safe-area-inset-right, 0px)); bottom: calc(66px + env(safe-area-inset-bottom, 0px));
  width: 104px; height: 104px; min-height: 0; padding: 0; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--blue); color: var(--chalk); font-family: var(--display); font-size: 20px; letter-spacing: .04em;
  box-shadow: 0 0 0 4px var(--chalk);
}
.rcr .act:disabled { background: var(--ink); color: var(--chalk); opacity: .55; }
.rcr .act:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
.rcr .stick { position: absolute; z-index: 6; width: 120px; height: 120px; border-radius: 50%; border: 2px solid var(--chalk); background: rgba(11,11,11,.18); pointer-events: none; }
.rcr .stick i { position: absolute; left: 50%; top: 50%; width: 48px; height: 48px; margin: -24px 0 0 -24px; border-radius: 50%; background: var(--chalk); }
.rcr .find {
  position: absolute; z-index: 7; left: 50%; transform: translateX(-50%); bottom: 196px;
  width: min(340px, calc(100% - 32px)); background: var(--chalk); color: var(--ink); padding: 12px 14px; display: flex; flex-direction: column; gap: 4px;
  box-shadow: 0 0 0 3px var(--ink); animation: rcrFindIn .35s cubic-bezier(.2, 1.4, .4, 1); box-sizing: border-box;
}
.rcr .find canvas { width: 100%; height: auto; margin-bottom: 6px; }
.rcr .find b { font-family: var(--display); font-weight: 400; font-size: 24px; line-height: 1.05; }
.rcr .find span { font-size: 12px; line-height: 1.45; }
.rcr .find.bad { background: var(--ink); color: var(--chalk); box-shadow: 0 0 0 3px #cc0a5e; }
@keyframes rcrFindIn { from { transform: translate(-50%, 30px) scale(.9); opacity: 0; } }
.rcr .fxbar { position: absolute; z-index: 5; pointer-events: none; left: max(16px, env(safe-area-inset-left, 0px)); top: 96px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.rcr .fxbar span { background: #cc0a5e; color: var(--chalk); font-size: 11px; letter-spacing: .08em; padding: 3px 8px; font-variant-numeric: tabular-nums; }
.rcr .fxbar span.bad { background: var(--ink); }
.rcr .dim { position: absolute; inset: 0; z-index: 4; pointer-events: none; background: radial-gradient(ellipse at 50% 120%, rgba(11,11,11,.55), rgba(11,11,11,.92) 70%); }
.rcr .compass {
  position: absolute; z-index: 6; pointer-events: none; left: 50%; transform: translateX(-50%);
  bottom: calc(14px + env(safe-area-inset-bottom, 0px)); width: min(560px, calc(100% - 32px)); height: 38px;
}
.rcr .help {
  position: absolute; z-index: 5; pointer-events: none; left: max(16px, env(safe-area-inset-left, 0px)); bottom: calc(62px + env(safe-area-inset-bottom, 0px));
  font-size: 11px; color: var(--chalk); background: rgba(11,11,11,.55); padding: 4px 8px; letter-spacing: .04em; max-width: calc(100% - 170px);
}
/* the how-to card over the live HUD */
.rcr .howdim { position: absolute; inset: 0; z-index: 4; background: rgba(11,11,11,.55); pointer-events: none; }
.rcr .howto { position: absolute; inset: 0; z-index: 8; pointer-events: none; }
.rcr .callout { position: absolute; background: var(--chalk); color: var(--ink); font-family: var(--rmono); font-size: 10.5px; line-height: 1.3; letter-spacing: .06em;
  text-transform: uppercase; padding: 4px 7px; max-width: 46%; box-shadow: 0 0 0 1px var(--ink); white-space: normal; }
.rcr .callout.big { font-size: 11px; padding: 8px; background: rgba(11,11,11,.35); color: var(--chalk); box-shadow: 0 0 0 1px var(--chalk); text-align: center;
  width: 150px; max-width: none; min-height: 112px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; }
.rcr .callout b { font-weight: 600; }
.rcr .pad { display: grid; grid-template-columns: repeat(3, 18px); grid-template-rows: repeat(3, 18px); place-items: center; font-size: 15px; line-height: 1; }
.rcr .pad span:nth-child(1) { grid-area: 1 / 2; } .rcr .pad span:nth-child(2) { grid-area: 2 / 1; } .rcr .pad span:nth-child(3) { grid-area: 2 / 3; } .rcr .pad span:nth-child(4) { grid-area: 3 / 2; }
.rcr .pad::after { content: ""; grid-area: 2 / 2; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.rcr .pad.keys { grid-template-columns: repeat(3, 20px); grid-template-rows: repeat(2, 20px); gap: 2px; }
.rcr .pad.keys::after { display: none; }
.rcr .pad.keys span { width: 18px; height: 18px; border: 1px solid currentColor; display: grid; place-items: center; font-size: 11px; font-weight: 600; }
.rcr .pad.keys span:nth-child(1) { grid-area: 1 / 2; } .rcr .pad.keys span:nth-child(2) { grid-area: 2 / 1; } .rcr .pad.keys span:nth-child(3) { grid-area: 2 / 3; } .rcr .pad.keys span:nth-child(4) { grid-area: 2 / 2; }
.rcr .mouse { position: relative; width: 22px; height: 32px; border: 2px solid currentColor; border-radius: 11px; box-sizing: border-box; }
.rcr .mouse::before { content: ""; position: absolute; left: 50%; top: 5px; width: 2px; height: 7px; margin-left: -1px; background: currentColor; }
.rcr .legendbar { display: flex; gap: 10px; align-items: center; }
.rcr .legendbar i { display: inline-block; vertical-align: middle; margin-right: 4px; }
.rcr .legendbar .d { width: 7px; height: 7px; background: var(--ink); transform: rotate(45deg); }
.rcr .legendbar .q { width: 9px; height: 9px; background: var(--blue); }
.rcr .legendbar .g { width: 9px; height: 9px; border-radius: 50%; background: #e8b60f; }
.rcr .howcard { pointer-events: auto; position: absolute; left: 50%; top: 140px; transform: translateX(-50%); width: min(310px, calc(100% - 32px)); box-sizing: border-box;
  background: var(--chalk); color: var(--ink); padding: 18px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; box-shadow: 0 0 0 3px var(--ink); }
.rcr .howcard .eyebrow { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; }
.rcr .howcard h2 { font-family: var(--display); font-weight: 400; font-size: 28px; line-height: .95; margin: 0; }
.rcr .howcard p { margin: 0; font-size: 13px; line-height: 1.45; max-width: 30ch; }
.rcr .howcard .howclock { font-size: 11px; letter-spacing: .04em; opacity: .75; }
.rcr .howcard .btn { min-width: 180px; margin-top: 4px; border: 0; cursor: pointer; font-family: var(--display); font-size: 22px; letter-spacing: .04em; padding: 14px 28px; background: var(--blue); color: var(--chalk); }
.rcr .howcard .btn:disabled { opacity: .6; cursor: default; }
.rcr .howcard .btn:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
@media (max-height: 560px) { .rcr .howcard { top: 74px; padding: 12px; gap: 6px; } .rcr .howcard h2 { font-size: 22px; } }
@media (prefers-reduced-motion: reduce) { .rcr .find { animation: none; } .rcr .arrow { transition: none; } }
`;
