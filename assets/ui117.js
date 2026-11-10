/* ===========================================================================
 * assets/ui117.js — round 117: the battle HUD in one visual language.
 *
 * The HUD had grown in five stylesheets (the main file, squads.js, ccmenu.js,
 * battlesetup.js, campaign.js): three type families, a dozen sizes between
 * 8.5 and 14 px, pills beside boxes beside gradients, a top bar 2,154 px wide
 * in a 1,024 px window, a selection panel underneath the reinforcement list
 * and a toast that shared one element with PAUSED.
 *
 * This file is the one place the battle HUD's look is decided:
 *
 *   tokens     one family, five sizes, a 4 px grid, one panel, one button,
 *              own / enemy / neutral
 *   top bar    what a battle needs stays; the map, size, clock, weather, timer,
 *              speed, Forge, export and import go behind "Options" (the same
 *              elements, moved, so every id and every listener is the old one)
 *   objectives the clock, seven lettered chips in their owner's colour, the
 *              score; rebuilt when something changed instead of every 0.15 s
 *   selection  bottom left, clear of the reinforcement list: name, side, the
 *              strength bar, and the state as chips instead of one run-on line
 *   minimap    a frame
 *   orders     the right-click menu sits above the hover tooltip; the support
 *              bar is rebuilt when it changes, not twice a second under the
 *              pointer
 *   messages   a feed that keeps the last four (a refusal stays nine seconds,
 *              not 2.6), and PAUSED is its own marker, never hidden by a toast
 *
 * THE SWITCH is game.ui117 (default on). It is an accessor that puts the class
 * `ui117` on <body>: every rule below is scoped to it, and the moved top-bar
 * controls go back to exactly where they were when it is switched off, so OFF
 * is the old HUD and not an approximation of it.
 *
 * COST: nothing here writes to the DOM every frame. The one per-frame hook
 * compares a boolean (paused) and writes only when it flips.
 * ======================================================================== */
(function () {
  'use strict';

  var CSS = `
/* what this file adds does not exist for the old HUD */
#u7MoreBtn, #u7More, #u7Feed, #u7SelHead, #u7Chips { display: none; }

body.ui117 {
  --u7-font: "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --u7-ink: #0b0d0b; --u7-panel: rgba(16,19,17,0.94); --u7-raise: #1c211d; --u7-raise2: #272e27;
  --u7-line: #394036; --u7-line2: #566049;
  --u7-khaki: #cfb87c; --u7-khaki-dim: #8d7f58;
  --u7-text: #dedccd; --u7-dim: #979a8a; --u7-faint: #70745f;
  --u7-own: #7db2e8; --u7-foe: #e3806f; --u7-neutral: #a9ad9c;
  --u7-good: #86b96f; --u7-warn: #dba955; --u7-bad: #dc6f5c;
  --u7-t-cap: 9.5px; --u7-t-sm: 11px; --u7-t-md: 12px; --u7-t-lg: 14px; --u7-t-xl: 16px; --u7-t-title: 22px;
  --u7-1: 4px; --u7-2: 8px; --u7-3: 12px; --u7-4: 16px;
  --u7-r: 3px; --u7-shadow: 0 2px 10px rgba(0,0,0,0.5);
}

/* ---- one panel ---- */
body.ui117 #sqPanel, body.ui117 #supportBar, body.ui117 #reinforceBar, body.ui117 #unitInfo,
body.ui117 #objPill, body.ui117 #formationBar, body.ui117 #ccMenu, body.ui117 #ccMenuMore,
body.ui117 #controlsHint, body.ui117 #u7More {
  background: var(--u7-panel); border: 1px solid var(--u7-line); border-top: 2px solid var(--u7-khaki-dim);
  border-radius: var(--u7-r); box-shadow: var(--u7-shadow); color: var(--u7-text);
  font-family: var(--u7-font); -webkit-backdrop-filter: none; backdrop-filter: none;
}
body.ui117 #sqPanel *, body.ui117 #ccMenu *, body.ui117 #ccMenuMore *, body.ui117 #ccBar, body.ui117 #ccBar *,
body.ui117 #formationBar *, body.ui117 #supportBar *, body.ui117 #reinforceBar *, body.ui117 #commandBar *,
body.ui117 #topBar, body.ui117 #topBar *, body.ui117 #tooltip, body.ui117 #controlsHint * {
  font-family: var(--u7-font) !important;
}
body.ui117 #sqPanel, body.ui117 #supportBar, body.ui117 #reinforceBar, body.ui117 #objPill, body.ui117 #topBar { font-variant-numeric: tabular-nums; }

/* ---- one button ---- */
body.ui117 #topBar .btn, body.ui117 .cmd-btn, body.ui117 .rb-btn, body.ui117 #supportBar .sb-btn,
body.ui117 .formation-btn, body.ui117 .cc-b {
  background: var(--u7-raise); background-image: none; border: 1px solid var(--u7-line); border-radius: 2px;
  color: var(--u7-text); box-shadow: none;
}
body.ui117 #topBar .btn:hover, body.ui117 .cmd-btn:hover, body.ui117 .rb-btn:hover, body.ui117 #supportBar .sb-btn:hover,
body.ui117 .formation-btn:hover, body.ui117 .cc-b:hover {
  background: var(--u7-raise2); background-image: none; border-color: var(--u7-khaki-dim); color: #fff; box-shadow: none;
}
body.ui117 #topBar .btn.active, body.ui117 .cmd-btn.on, body.ui117 .formation-btn.selected {
  background: var(--u7-khaki); background-image: none; border-color: var(--u7-khaki); color: #14150f;
}
body.ui117 #topBar .btn.danger { border-color: #6b3a32; color: #e0a094; }
body.ui117 #topBar .btn.danger:hover { background: #3a211d; }
body.ui117 .cc-b.on { background: #2e2917; background-image: none; border-color: var(--u7-khaki); color: #f0e3bd; }
body.ui117 .cc-b i { color: var(--u7-text); }
body.ui117 .cc-b.on i { color: var(--u7-khaki); }
body.ui117 .cc-b u { color: var(--u7-faint); }
body.ui117 .cmd-btn.armed, body.ui117 .rb-btn.armed, body.ui117 #supportBar .sb-btn.armed, body.ui117 .cc-b.armed {
  border-color: var(--u7-warn); color: #ffe6b0; box-shadow: inset 0 0 0 1px var(--u7-warn);
}

/* ---- top bar ---- */
body.ui117 #topBar { background: var(--u7-panel); border-bottom: 1px solid var(--u7-line); padding: 4px 10px; gap: 6px;
  -webkit-backdrop-filter: none; backdrop-filter: none; }
body.ui117 #topBar h1 { font-size: 12px; font-weight: 800; letter-spacing: 1.6px; color: var(--u7-khaki);
  white-space: nowrap; flex: 0 0 auto; margin-right: 6px; }
body.ui117 #topBar > .btn { white-space: nowrap; flex: 0 0 auto; font-size: var(--u7-t-sm); padding: 4px 9px; }
body.ui117 #u7MoreBtn { display: inline-flex; align-items: center; gap: 6px; }
body.ui117 #u7MoreBtn svg { width: 12px; height: 12px; flex: 0 0 auto; }
body.ui117.u7-more #u7MoreBtn { border-color: var(--u7-khaki); color: var(--u7-khaki); }
body.ui117 #u7More { position: fixed; top: 44px; left: 8px; z-index: 140; flex-wrap: wrap; align-items: center;
  gap: var(--u7-2); padding: var(--u7-3); width: min(540px, calc(100vw - 16px)); box-sizing: border-box; }
body.ui117.u7-more #u7More { display: flex; }
body.ui117 #u7More::before { content: 'Battle options'; flex: 0 0 100%; font-size: var(--u7-t-cap); font-weight: 700;
  letter-spacing: 1.4px; text-transform: uppercase; color: var(--u7-khaki); }
body.ui117 #u7More > * { flex: 0 0 auto; white-space: nowrap; }
body.ui117.u7-more #topBar { z-index: 140; }
body.ui117 #countPill { background: var(--u7-ink); border: 1px solid var(--u7-line); border-radius: 2px; font-size: var(--u7-t-sm); flex: 0 0 auto; }
@media (max-width: 1279px) { body.ui117 #modeIndicator { display: none; } }
body.ui117 #modeIndicator { border-radius: 2px; font-size: var(--u7-t-cap); letter-spacing: 1.4px; white-space: nowrap; flex: 0 0 auto; }
body.ui117 #modeIndicator.play { background: rgba(134,185,111,0.12); color: var(--u7-good); border-color: #4b6a3f; }
body.ui117 #modeIndicator.edit { background: rgba(207,184,124,0.12); color: var(--u7-khaki); border-color: var(--u7-khaki-dim); }
body.ui117 #clockPill { background: var(--u7-ink); border: 1px solid var(--u7-line); border-radius: 2px; }
body.ui117 #clockTime { color: var(--u7-khaki); }
body.ui117 #clockPhase { color: var(--u7-dim); }
body.ui117 #clockSlider { accent-color: var(--u7-khaki); }
body.ui117 #clockPill select { background: var(--u7-raise); border: 1px solid var(--u7-line); border-radius: 2px; color: var(--u7-text); }

/* ---- objectives, score, clock ---- */
body.ui117 #objPill { gap: 6px; padding: 4px 10px; font-size: var(--u7-t-md); }
@media (max-width: 1439px) { body.ui117 #objPill { left: calc(50% + 82px); } }   /* the clear ground between the roster (380) and the rail */
body.ui117.fpv #objPill { left: 50%; }
body.ui117 #objPill .tmr, body.ui117 #objPill .sd { font-size: var(--u7-t-lg); font-weight: 700; letter-spacing: 0.4px;
  padding-right: 8px; margin-right: 2px; border-right: 1px solid var(--u7-line); }
body.ui117 #objPill .tmr { color: var(--u7-text); }
body.ui117 #objPill .tmr.low, body.ui117 #objPill .sd { color: var(--u7-bad); }
body.ui117 #objPill .vp { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  min-width: 20px; height: 20px; padding: 0 3px; border: 1px solid currentColor; border-radius: 2px;
  background: rgba(0,0,0,0.42); font-size: 11.5px; font-weight: 800; }
body.ui117 #objPill .sc { border-left: 1px solid var(--u7-line); padding-left: 8px; margin-left: 2px; font-size: var(--u7-t-lg); }
body.ui117 #objPill .sc i { color: var(--u7-faint); }
body.ui117 #objPill .sc.wait { top: 100%; left: 50%; transform: translateX(-50%); margin: 5px 0 0; padding: 2px 9px;
  background: var(--u7-panel); border: 1px solid var(--u7-line); border-radius: var(--u7-r); color: var(--u7-dim);
  font-size: var(--u7-t-cap); font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; }
body.ui117.fpv #objPill .sc.wait { top: 50%; left: 100%; transform: translateY(-50%); margin: 0 0 0 6px; }   /* the compass is under the strip in first person */

/* ---- selection ---- */
body.ui117 #unitInfo { left: 8px; right: auto; bottom: 12px; width: 300px; min-width: 0; max-width: none;
  box-sizing: border-box; padding: 8px 10px 10px; text-align: left; }
@media (max-width: 1279px) { body.ui117 #unitInfo { width: 224px; } }
body.ui117 #unitInfo h4, body.ui117 #unitInfo .stats { display: none; }
body.ui117 #u7SelHead { display: block; }
body.ui117 #u7SelHead .u7-ti { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
body.ui117 #u7SelHead b { font-size: var(--u7-t-lg); font-weight: 700; line-height: 1.2; color: var(--u7-text); }
body.ui117 #u7SelHead i { font-style: normal; font-size: var(--u7-t-cap); font-weight: 700; letter-spacing: 0.8px;
  text-transform: uppercase; white-space: nowrap; flex: 0 0 auto; }
body.ui117 #u7SelHead i.own { color: var(--u7-own); }
body.ui117 #u7SelHead i.foe { color: var(--u7-foe); }
body.ui117 #u7SelHead p { margin: 3px 0 0; font-size: var(--u7-t-sm); line-height: 1.35; color: var(--u7-dim); }
body.ui117 #unitInfo .hp-bar { height: 4px; margin: 7px 0; background: var(--u7-ink); border-radius: 0; outline: 1px solid var(--u7-line); }
body.ui117 #unitInfo .hp-fill { background: var(--u7-good); border-radius: 0; }
body.ui117 #u7Chips { display: flex; flex-wrap: wrap; gap: var(--u7-1); }
body.ui117 #u7Chips span { font-size: var(--u7-t-cap); font-weight: 600; letter-spacing: 0.5px; line-height: 1.3; padding: 2px 5px;
  border: 1px solid var(--u7-line); border-radius: 2px; background: var(--u7-raise); color: var(--u7-text); white-space: nowrap; }
body.ui117 #u7Chips span.k { color: var(--u7-khaki); border-color: var(--u7-khaki-dim); }
body.ui117 #u7Chips span.w { color: var(--u7-bad); border-color: var(--u7-bad); }

/* ---- minimap frame ---- */
body.ui117 #minimap { top: 47px; right: 12px; border: 1px solid var(--u7-line2); border-radius: 2px; background: var(--u7-ink);
  box-shadow: 0 0 0 3px var(--u7-ink), 0 0 0 4px var(--u7-line), var(--u7-shadow); }

/* ---- order of battle ---- */
body.ui117 #sqPanel .sq-h { color: var(--u7-khaki); font-size: var(--u7-t-cap); letter-spacing: 1.4px; border-bottom: 1px solid var(--u7-line); background: none; }
body.ui117 #sqPanel .sq-h i { color: var(--u7-faint); }
body.ui117 .sq-row:hover { background: var(--u7-raise); }
body.ui117 .sq-row.on { background: var(--u7-raise2); border-left-color: var(--u7-khaki); }
body.ui117 #sqPanel::-webkit-scrollbar, body.ui117 #hudRail ::-webkit-scrollbar, body.ui117 #ccMenuMore::-webkit-scrollbar { width: 6px; height: 6px; }
body.ui117 #sqPanel::-webkit-scrollbar-thumb, body.ui117 #hudRail ::-webkit-scrollbar-thumb, body.ui117 #ccMenuMore::-webkit-scrollbar-thumb { background: var(--u7-line2); border-radius: 3px; }
body.ui117 #sqPanel::-webkit-scrollbar-track, body.ui117 #hudRail ::-webkit-scrollbar-track, body.ui117 #ccMenuMore::-webkit-scrollbar-track { background: transparent; }

/* ---- fire support and reinforcements ---- */
body.ui117 #supportBar .sb-label, body.ui117 #reinforceBar .rb-label { color: var(--u7-khaki); font-size: var(--u7-t-cap); font-weight: 700; letter-spacing: 1.4px; }
body.ui117 #supportBar .sb-btn i, body.ui117 #supportBar .sb-btn s, body.ui117 .rb-btn .rb-cost { color: var(--u7-khaki); }
body.ui117 .rb-btn .rb-men { color: var(--u7-own); }
body.ui117 #reinforceBar .rb-group { color: var(--u7-faint); }
body.ui117 #reinforceBar .rb-find { background: var(--u7-ink); border: 1px solid var(--u7-line); border-radius: 2px; color: var(--u7-text); }
body.ui117 #reinforceBar .rb-find:focus { border-color: var(--u7-khaki-dim); }
body.ui117 #reinforceBar { max-height: min(46vh, 430px); }
body.ui117 #supportBar { width: 208px; box-sizing: border-box; }
body.ui117 #supportBar .sb-btn b { white-space: normal; overflow: visible; text-overflow: clip; }

/* ---- orders ---- */
body.ui117 #ccMenu, body.ui117 #ccMenuMore { z-index: 210; }          /* above the hover tooltip, which used to cover the menu's header */
body.ui117 .ccm-h { color: var(--u7-khaki); border-bottom-color: var(--u7-line); }
body.ui117 .ccm-i:hover { background: var(--u7-raise2); }
body.ui117 #tooltip { background: var(--u7-ink); border: 1px solid var(--u7-line2); border-radius: 2px; color: var(--u7-text); font-size: var(--u7-t-sm); }
body.ui117.fpv #tooltip { display: none !important; }                 /* a top-down hover left a stale label mid-screen in first person */
@media (max-width: 1499px) { body.ui117 #controlsHint { display: none; } }

/* ---- first person: the same panel, and the key hints no longer run across it on a narrow window ---- */
body.ui117 #gsPanel { background: rgba(16,19,17,0.74); border: 1px solid var(--u7-line); border-top: 2px solid var(--u7-khaki-dim);
  border-radius: var(--u7-r); box-shadow: var(--u7-shadow); font-family: var(--u7-font); -webkit-backdrop-filter: none; backdrop-filter: none; }
body.ui117 #gsPanel .nm { color: var(--u7-khaki); font-size: var(--u7-t-md); font-weight: 700; letter-spacing: 1.4px; }
body.ui117 #gsPanel .row { color: var(--u7-dim); font-size: var(--u7-t-sm); }
body.ui117 #gsPanel .row span:last-child { color: var(--u7-text); }
body.ui117 #gsRight, body.ui117 #gsStance { font-family: var(--u7-font); }
@media (max-width: 1365px) { body.ui117 #gsPanel { bottom: 108px; } }   /* the hints are three or four rows from 24 px up */

/* ---- messages ---- */
body.ui117 #pausePill { display: none !important; }                   /* still written, for whoever reads it; shown by the feed */
body.ui117 #u7Feed { display: flex; position: fixed; top: 108px; left: 50%; transform: translateX(-50%); z-index: 120;
  flex-direction: column; align-items: center; gap: var(--u7-1); pointer-events: none;
  max-width: min(560px, calc(100vw - 440px)); font-family: var(--u7-font); }
@media (max-width: 1439px) { body.ui117 #u7Feed { left: calc(50% + 82px); max-width: min(560px, calc(100vw - 632px)); } }
body.ui117.fpv #u7Feed { left: 50%; max-width: min(560px, calc(100vw - 440px)); }
body.ui117 #u7Paused { display: none; align-items: center; gap: var(--u7-2); padding: 5px 12px; border: 1px solid var(--u7-khaki);
  border-radius: var(--u7-r); background: rgba(22,19,10,0.93); color: var(--u7-khaki); font-size: var(--u7-t-sm); font-weight: 700;
  letter-spacing: 2px; text-transform: uppercase; white-space: nowrap; box-shadow: var(--u7-shadow); }
body.ui117 #u7Paused svg { width: 10px; height: 10px; }
body.ui117 #u7Paused em { font-style: normal; font-weight: 600; letter-spacing: 0.6px; color: var(--u7-dim); text-transform: none; }
body.ui117.u7-paused #u7Paused { display: inline-flex; }
body.ui117 #u7Log { display: flex; flex-direction: column; align-items: center; gap: 3px; }
body.ui117 #u7Log div { padding: 4px 12px; background: var(--u7-panel); border: 1px solid var(--u7-line); border-left: 3px solid var(--u7-khaki-dim);
  border-radius: 2px; box-shadow: var(--u7-shadow); color: var(--u7-text); font-size: var(--u7-t-md); line-height: 1.35; animation: u7In 0.18s ease-out; }
body.ui117 #u7Log div.bad { border-left-color: var(--u7-bad); color: #f4d9d2; }
body.ui117 #u7Log div.good { border-left-color: var(--u7-good); }
body.ui117 #u7Log div.old { color: var(--u7-dim); border-left-color: var(--u7-line2); }
@keyframes u7In { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

/* ==== the battle setup screen (game.uiMenus117, inside game.ui117): the HUD's panel, button and type ==== */
body.ui117.u7m #bsetup { background: rgba(6,8,7,0.8); font: 13px/1.45 var(--u7-font); color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-card { background: rgba(16,19,17,0.97); border: 1px solid var(--u7-line); border-top: 2px solid var(--u7-khaki-dim);
  border-radius: var(--u7-r); box-shadow: 0 18px 50px rgba(0,0,0,0.6); }
body.ui117.u7m #bsetup .bs-head, body.ui117.u7m #bsetup .bs-sum, body.ui117.u7m #bsetup .bs-fs, body.ui117.u7m #bsetup .bs-foot { border-color: var(--u7-line); }
body.ui117.u7m #bsetup .bs-side + .bs-side { border-left-color: var(--u7-line); }
body.ui117.u7m #bsetup .bs-op { font: 700 var(--u7-t-cap)/1 var(--u7-font); letter-spacing: 1.6px; color: var(--u7-khaki); }
body.ui117.u7m #bsetup .bs-title { font: 700 var(--u7-t-title)/1.15 var(--u7-font); letter-spacing: 0.3px; color: var(--u7-text); margin: 6px 0 2px; }
body.ui117.u7m #bsetup .bs-sub { font-style: normal; font-size: var(--u7-t-md); color: var(--u7-dim); }
body.ui117.u7m #bsetup .bs-keys { font: var(--u7-t-sm)/1.7 var(--u7-font); color: var(--u7-faint); }
body.ui117.u7m #bsetup .bs-sw { border-radius: 2px; }
body.ui117.u7m #bsetup .bs-sh b { font-size: var(--u7-t-lg); font-weight: 700; color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-sh select { background: var(--u7-raise); color: var(--u7-text); border: 1px solid var(--u7-line); border-radius: 2px;
  font: 600 var(--u7-t-md) var(--u7-font); padding: 4px 6px; }
body.ui117.u7m #bsetup .bs-pre i, body.ui117.u7m #bsetup .bs-arm i { font: 600 var(--u7-t-sm)/1 var(--u7-font); letter-spacing: 0.2px; padding: 5px 9px;
  border: 1px solid var(--u7-line); border-radius: 2px; background: var(--u7-raise); color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-pre i:hover, body.ui117.u7m #bsetup .bs-arm i:hover { border-color: var(--u7-khaki-dim); background: var(--u7-raise2); color: #fff; }
body.ui117.u7m #bsetup .bs-pre i.on, body.ui117.u7m #bsetup .bs-arm i.on { border-color: var(--u7-khaki); background: var(--u7-khaki); color: #14150f; }
body.ui117.u7m #bsetup .bs-arm span, body.ui117.u7m #bsetup .bs-cat, body.ui117.u7m #bsetup .bs-fs h4 { font: 700 var(--u7-t-cap)/1.2 var(--u7-font); letter-spacing: 1.4px; color: var(--u7-faint); }
body.ui117.u7m #bsetup .bs-fs h4 { color: var(--u7-khaki); }
body.ui117.u7m #bsetup .bs-cat { border-top-color: var(--u7-line); }
body.ui117.u7m #bsetup .bs-cat u, body.ui117.u7m #bsetup .bs-fs h4 u { color: var(--u7-dim); letter-spacing: 0.4px; }
body.ui117.u7m #bsetup .bs-cat u:hover, body.ui117.u7m #bsetup .bs-fs h4 u:hover { color: var(--u7-khaki); }
body.ui117.u7m #bsetup .bs-sum { font: 600 var(--u7-t-sm)/1.4 var(--u7-font); color: var(--u7-khaki); }
body.ui117.u7m #bsetup .bs-own, body.ui117.u7m #bsetup .bs-note3 { font-style: normal; color: var(--u7-dim); }
body.ui117.u7m #bsetup .bs-list, body.ui117.u7m #bsetup .bs-fs { font: var(--u7-t-sm)/1.35 var(--u7-font); }
body.ui117.u7m #bsetup .bs-list::-webkit-scrollbar-thumb { background: var(--u7-line2); border-radius: 3px; }
body.ui117.u7m #bsetup .bs-row { border-bottom-color: rgba(57,64,54,0.55); }
body.ui117.u7m #bsetup .bs-row b { color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-row.has b { color: var(--u7-khaki); }
body.ui117.u7m #bsetup .bs-row em { font-size: var(--u7-t-cap); color: var(--u7-faint); }
body.ui117.u7m #bsetup .bs-men { font-size: var(--u7-t-sm); color: var(--u7-dim); }
body.ui117.u7m #bsetup .bs-ctl i { border: 1px solid var(--u7-line); border-radius: 2px; background: var(--u7-raise); color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-ctl i:hover { border-color: var(--u7-khaki-dim); background: var(--u7-raise2); color: #fff; }
body.ui117.u7m #bsetup .bs-ctl u { color: var(--u7-text); font-weight: 700; }
body.ui117.u7m #bsetup .bs-ctl u.z { color: var(--u7-faint); font-weight: 400; }
body.ui117.u7m #bsetup .bs-warn { color: var(--u7-warn); }
body.ui117.u7m #bsetup .bs-foot button { font: 600 var(--u7-t-md) var(--u7-font); padding: 7px 16px; border-radius: 2px; border: 1px solid var(--u7-line);
  background: var(--u7-raise); color: var(--u7-text); }
body.ui117.u7m #bsetup .bs-foot button:hover { border-color: var(--u7-khaki-dim); background: var(--u7-raise2); color: #fff; }
body.ui117.u7m #bsetup .bs-foot button.go { border-color: var(--u7-khaki); background: var(--u7-khaki); color: #14150f; font-weight: 700; }
body.ui117.u7m #bsetup .bs-foot button.go:hover { background: #dfca93; color: #14150f; }

/* ==== the Edit panel (game.uiEditor118, inside game.ui117): the HUD's panel, buttons and type ==== */
body.ui117.u7e #editorPanel { width: 276px; background: var(--u7-panel); border: 1px solid var(--u7-line); border-top: 2px solid var(--u7-khaki-dim);
  border-radius: var(--u7-r); box-shadow: var(--u7-shadow); font-family: var(--u7-font); color: var(--u7-text);
  overflow-x: hidden; scroll-padding-top: 76px; scroll-padding-bottom: 210px; -webkit-backdrop-filter: none; backdrop-filter: none; }
body.ui117.u7e #editorPanel * { font-family: var(--u7-font); }
body.ui117.u7e #editorPanel::-webkit-scrollbar { width: 6px; height: 0; }
body.ui117.u7e #editorPanel::-webkit-scrollbar-thumb { background: var(--u7-line2); border-radius: 3px; }
body.ui117.u7e #editorPanel::-webkit-scrollbar-track { background: transparent; }
body.ui117.u7e #editorPanel .ed-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; padding: 8px 8px 7px; background: var(--u7-panel); border-bottom: 1px solid var(--u7-line); }
body.ui117.u7e #editorPanel .ed-tab { font-size: var(--u7-t-sm); font-weight: 600; letter-spacing: 0.3px; padding: 5px 2px; border: 1px solid var(--u7-line); border-radius: 2px;
  background: var(--u7-raise); color: var(--u7-dim); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
body.ui117.u7e #editorPanel .ed-tab:hover { color: #fff; border-color: var(--u7-khaki-dim); background: var(--u7-raise2); }
body.ui117.u7e #editorPanel .ed-tab.on { background: var(--u7-khaki); border-color: var(--u7-khaki); color: #14150f; font-weight: 700; }
body.ui117.u7e #editorPanel .ed-body { padding: 8px 10px 10px; }
body.ui117.u7e #editorPanel .ed-row { gap: 8px; margin: 6px 0; min-width: 0; }
body.ui117.u7e #editorPanel .ed-row > label { flex: none; min-width: 52px; font-size: var(--u7-t-sm); font-weight: 600; letter-spacing: 0.2px; color: var(--u7-dim); }
body.ui117.u7e #editorPanel .ed-row input[type=range] { min-width: 0; accent-color: var(--u7-khaki); }
body.ui117.u7e #editorPanel .ed-row .val { flex: none; min-width: 36px; font-size: var(--u7-t-md); font-weight: 700; color: var(--u7-khaki); text-align: right;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
body.ui117.u7e #editorPanel .ed-seg { min-width: 0; gap: 2px; }
body.ui117.u7e #editorPanel .ed-seg > div { min-width: 0; font-size: 10.5px; font-weight: 600; letter-spacing: 0; padding: 4px 1px; border: 1px solid var(--u7-line); border-radius: 2px;
  background: var(--u7-raise); color: var(--u7-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.ui117.u7e #editorPanel .ed-seg > div:hover { border-color: var(--u7-khaki-dim); background: var(--u7-raise2); }
body.ui117.u7e #editorPanel .ed-seg > div.on { background: var(--u7-khaki); border-color: var(--u7-khaki); color: #14150f; font-weight: 700; }
body.ui117.u7e #editorPanel .ed-search { background: var(--u7-ink); border: 1px solid var(--u7-line); border-radius: 2px; color: var(--u7-text); font-size: var(--u7-t-md); padding: 5px 7px; }
body.ui117.u7e #editorPanel .ed-search:focus { border-color: var(--u7-khaki-dim); }
body.ui117.u7e #editorPanel .ed-note { font-size: var(--u7-t-sm); line-height: 1.45; color: var(--u7-dim); }
body.ui117.u7e #editorPanel .ed-note b { color: var(--u7-text); }
body.ui117.u7e #editorPanel .tool-grid { gap: 4px; }
body.ui117.u7e #editorPanel .tool-btn { min-width: 0; padding: 6px 3px 5px; font-size: 10.5px; line-height: 1.2; border: 1px solid var(--u7-line); border-radius: 2px;
  background: var(--u7-raise); color: var(--u7-text); overflow: hidden; overflow-wrap: normal; word-break: normal; hyphens: manual; }
body.ui117.u7e #editorPanel #obstacleTools, body.ui117.u7e #editorPanel #foliageTools, body.ui117.u7e #editorPanel #unitTools, body.ui117.u7e #editorPanel #squadTools { grid-template-columns: repeat(3, 1fr); }
body.ui117.u7e #editorPanel .tool-btn:hover { background: var(--u7-raise2); border-color: var(--u7-khaki-dim); color: #fff; }
body.ui117.u7e #editorPanel .tool-btn.selected { background: #2e2917; border-color: var(--u7-khaki); color: #f0e3bd; font-weight: 700; box-shadow: inset 0 0 0 1px var(--u7-khaki); }
body.ui117.u7e #editorPanel .tool-btn .swatch { width: 18px; height: 10px; border-radius: 1px; border-color: rgba(0,0,0,0.55); margin-bottom: 4px; }
body.ui117.u7e #editorPanel .team-btn { font-size: var(--u7-t-sm); font-weight: 600; border-radius: 2px; }
body.ui117.u7e #editorPanel h2, body.ui117.u7e #editorPanel h3 { font-size: var(--u7-t-cap); font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--u7-khaki); margin: 10px 0 6px; }
body.ui117.u7e #editorPanel .panel-section { border-bottom-color: var(--u7-line); }
body.ui117.u7e #editorPanel .btn, body.ui117.u7e #editorPanel select, body.ui117.u7e #editorPanel .ed-mini { background: var(--u7-raise); border: 1px solid var(--u7-line); border-radius: 2px;
  color: var(--u7-text); font-size: var(--u7-t-md); font-weight: 600; }
body.ui117.u7e #editorPanel .btn:hover, body.ui117.u7e #editorPanel .ed-mini:hover { background: var(--u7-raise2); border-color: var(--u7-khaki-dim); color: #fff; }
body.ui117.u7e #editorPanel .ed-foot { background: rgba(12,14,12,0.98); border-top: 1px solid var(--u7-line); padding: 6px 10px 8px; }
`;

  var SVG_OPT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 3h10M1 6h10M1 9h10" stroke="currentColor" stroke-width="1.2" fill="none"/>'
    + '<circle cx="4" cy="3" r="1.4" fill="currentColor"/><circle cx="8" cy="6" r="1.4" fill="currentColor"/><circle cx="5" cy="9" r="1.4" fill="currentColor"/></svg>';
  var SVG_PAUSE = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1" width="2.5" height="8" fill="currentColor"/><rect x="6" y="1" width="2.5" height="8" fill="currentColor"/></svg>';

  /* the top-bar controls a battle does not need under the hand, in the order they are moved */
  var MOVE = ['btnForge', 'btnBoxArt', 'btnReset', 'mapSelect', 'battleScaleSel', 'clockPill', 'weatherSelect',
    'timerSelect', 'simRateSel', 'btnExport', 'btnImport'];
  /* a state the player has to act on reads as a warning chip */
  var WARN = /LOW AMMO|OUT OF|DOWNED|WOUND|ABANDONED|IMMOBILISED|JAMMED|INCOMING|FLANKED|REFUSING|PINNED|COWER|BROKEN|PANIC|ROUT|SUPPRESSED|EXHAUST|SHAKEN|SURRENDER/;
  var KEEP_MS = 4000, KEEP_BAD_MS = 9000, KEEP_N = 4;

  window.ui117Install = function () {
    var game = window.game, D = document, B = D.body;
    if (!game || !game.ui || game._u7) return;
    var ui = game.ui;
    var U = game._u7 = { on: false, moved: [], log: [] };

    var st = D.createElement('style'); st.id = 'u7Css'; st.textContent = CSS; D.head.appendChild(st);

    /* ---- top bar: the same elements, behind one button, and back again ---- */
    var bar = D.getElementById('topBar');
    var moreBtn = D.createElement('button');
    moreBtn.id = 'u7MoreBtn'; moreBtn.type = 'button'; moreBtn.className = 'btn';
    moreBtn.title = 'Battle options: map, battle size, time of day, weather, timer, speed, the Forge, export and import';
    moreBtn.innerHTML = SVG_OPT + '<span>Options</span>';
    var more = D.createElement('div'); more.id = 'u7More';
    function setMore(open) {
      B.classList.toggle('u7-more', !!open);
      if (open) {
        var r = moreBtn.getBoundingClientRect(), w = more.offsetWidth;
        more.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
      }
    }
    U.setMore = setMore;
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation(); setMore(!B.classList.contains('u7-more'));
      moreBtn.blur();                                              // Space is Pause, not this button again
    });
    more.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('button')) setMore(false); });
    D.addEventListener('mousedown', function (e) {
      if (!B.classList.contains('u7-more')) return;
      if (more.contains(e.target) || moreBtn.contains(e.target)) return;
      setMore(false);
    }, true);
    function dock() {
      if (!bar || U.moved.length) return;
      var kids = Array.prototype.slice.call(bar.childNodes), list = [];
      for (var i = 0; i < kids.length; i++) if (kids[i].id && MOVE.indexOf(kids[i].id) >= 0) list.push(kids[i]);
      if (!list.length) return;
      for (i = 0; i < list.length; i++) U.moved.push({ e: list[i], next: list[i].nextSibling });   // before anything moves
      var at = D.getElementById('btnMute');
      if (!at || at.parentNode !== bar) at = list[0];
      bar.insertBefore(moreBtn, at); bar.insertBefore(more, at);
      list.sort(function (a, b) { return MOVE.indexOf(a.id) - MOVE.indexOf(b.id); });
      for (i = 0; i < list.length; i++) more.appendChild(list[i]);
    }
    function undock() {
      if (!bar || !U.moved.length) return;
      if (moreBtn.parentNode) moreBtn.parentNode.removeChild(moreBtn);
      if (more.parentNode === bar) bar.removeChild(more);
      for (var i = U.moved.length - 1; i >= 0; i--) {              // last in document order first, so each `next` is back in place
        var m = U.moved[i];
        bar.insertBefore(m.e, m.next && m.next.parentNode === bar ? m.next : null);
      }
      U.moved.length = 0;
    }

    /* ---- orders: a hover label left where the menu opens goes when it does ---- */
    D.addEventListener('mouseup', function (e) {
      if (!U.on || e.button !== 2) return;
      setTimeout(function () {
        var m = D.getElementById('ccMenu'), t = D.getElementById('tooltip');
        if (m && t && m.style.display === 'block') t.style.display = 'none';
      }, 0);
    });

    /* ---- selection: the panel's own text, set out; redrawn when it changes ---- */
    var info = D.getElementById('unitInfo'), head = null, chips = null, selSig = '';
    if (info) {
      head = D.createElement('div'); head.id = 'u7SelHead'; info.insertBefore(head, info.firstChild);
      chips = D.createElement('div'); chips.id = 'u7Chips'; info.appendChild(chips);
    }
    function drawSel() {
      var sel = game.selection;
      if (!head || !sel || !sel.length || game.mode !== 'play' || !ui.el.unitName || !ui.el.unitStats) return;
      var nm = ui.el.unitName.textContent, stx = ui.el.unitStats.textContent;
      var own = sel[0].team === game.playerTeam, sig = nm + '\n' + stx + '\n' + own;
      if (sig === selSig) return;
      selSig = sig;
      var cut = nm.indexOf(' — '), title = cut < 0 ? nm : nm.slice(0, cut), rest = cut < 0 ? '' : nm.slice(cut + 3);
      var one = sel.length === 1;
      head.textContent = '';
      var ti = D.createElement('div'); ti.className = 'u7-ti';
      var b = D.createElement('b'); b.textContent = title; ti.appendChild(b);
      var tag = D.createElement('i'); tag.className = own ? 'own' : 'foe';
      tag.textContent = one ? rest : (own ? 'Your men' : 'Enemy'); ti.appendChild(tag);
      head.appendChild(ti);
      if (!one && rest) { var p = D.createElement('p'); p.textContent = rest; head.appendChild(p); }
      chips.textContent = '';
      var parts = stx.split(' · ');
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var s = D.createElement('span'); s.textContent = parts[i];
        if (WARN.test(parts[i])) s.className = 'w'; else if (one && i === 3) s.className = 'k';
        chips.appendChild(s);
      }
    }
    var oInfo = ui._updateInfo;
    ui._updateInfo = function () {
      var r = oInfo.apply(this, arguments);
      if (U.on) drawSel();
      return r;
    };

    /* ---- objectives: the strip is rebuilt when what it shows has changed ---- */
    var oObj = ui._updateObjPill, objSig = '';
    ui._updateObjPill = function () {
      var el = this.el.objPill, g = this.game;
      if (!U.on || !el || !g._vp116Sides) return oObj.apply(this, arguments);   // (sides read off the living: not worth a signature)
      var vps = g.victoryPoints, sig;
      if (g.mode !== 'play' || !vps.length) sig = 'off|' + el.style.display;
      else {
        var r = g.battleDuration > 0 ? Math.max(0, g.battleDuration - g.battleClock) : -1;
        sig = el.style.display + '|' + el.childElementCount + '|' + (g._vpSuddenTeam || 0) + '|'
          + (g._vpSuddenTeam ? Math.max(0, Math.ceil(g._vpSuddenT)) + g.teamColorCss(g._vpSuddenTeam) : Math.floor(r) + (r <= 60 ? 'L' : ''));
        for (var i = 0; i < vps.length; i++) {
          var v = vps[i];
          sig += '|' + v.name + (v.label || '') + (v.owner ? g.teamColorCss(v.owner) : '-') + ((v._contested || (v.capTeam && v.cap > 0.03)) ? 'c' : '');
        }
        sig += '|' + (g.vp116 !== false) + !!g.vpScore + (g.contact116 !== false) + !!g._contact116 + g._vp116Sides.join(',');
        if (g.vpScore) for (i = 0; i < g._vp116Sides.length; i++) {
          var t = g._vp116Sides[i];
          sig += '|' + Math.floor(g.vpScore[t] || 0) + g.teamColorCss(t);
        }
      }
      if (sig === objSig) return;
      var out = oObj.apply(this, arguments);
      objSig = sig;        // (a change of display or of the chip count costs one more rebuild, then it settles)
      return out;
    };

    /* ---- fire support: the buttons are rebuilt when they change, not twice a second under the pointer ---- */
    var oSup = ui.refreshSupportBar, supSig = '';
    ui.refreshSupportBar = function () {
      var bar2 = this.el.supportBar, g = this.game;
      if (!U.on || !bar2) return oSup.apply(this, arguments);
      var opts = g.supportOptions ? g.supportOptions() : [];
      var sig = g.mode + '|' + bar2.childElementCount + '|' + bar2.classList.contains('visible');
      for (var i = 0; i < opts.length; i++) {
        var o = opts[i];
        sig += '|' + o.key + ',' + o.n + ',' + (o.cd > 0 ? Math.ceil(o.cd) : 0) + ',' + (g.pendingFire === o.key ? 1 : 0);
      }
      if (sig === supSig) return;
      var out = oSup.apply(this, arguments);
      supSig = sig;
      return out;
    };

    /* ---- messages: a feed that keeps what was said, and PAUSED on its own ---- */
    var feed = D.createElement('div'); feed.id = 'u7Feed';
    var pausedEl = D.createElement('div'); pausedEl.id = 'u7Paused';
    pausedEl.innerHTML = SVG_PAUSE + '<span>Paused</span><em>Space to resume</em>';
    var logEl = D.createElement('div'); logEl.id = 'u7Log';
    feed.appendChild(pausedEl); feed.appendChild(logEl); B.appendChild(feed);
    var sweepT = 0;
    function sweep() {
      sweepT = 0;
      var now = Date.now(), next = Infinity;
      for (var i = U.log.length - 1; i >= 0; i--) {
        var m = U.log[i];
        if (m.until <= now) { if (m.el.parentNode) m.el.parentNode.removeChild(m.el); U.log.splice(i, 1); }
        else if (m.until < next) next = m.until;
      }
      if (U.log.length) sweepT = setTimeout(sweep, Math.max(60, next - now + 20));
    }
    function say(msg, kind) {
      msg = String(msg == null ? '' : msg);
      if (!msg) return;
      var now = Date.now(), keep = kind === 'bad' ? KEEP_BAD_MS : KEEP_MS;
      var last = U.log[U.log.length - 1];
      if (last && last.msg === msg && last.kind === (kind || '')) { last.until = now + keep; return; }   // said again: no new line
      for (var i = 0; i < U.log.length; i++) if (!U.log[i].old) { U.log[i].old = true; U.log[i].el.classList.add('old'); }
      var el = D.createElement('div'); el.className = kind || ''; el.textContent = msg;
      logEl.appendChild(el);
      U.log.push({ msg: msg, kind: kind || '', el: el, until: now + keep, old: false });
      while (U.log.length > KEEP_N) { var d = U.log.shift(); if (d.el.parentNode) d.el.parentNode.removeChild(d.el); }
      if (!sweepT) sweepT = setTimeout(sweep, keep + 20);
    }
    U.say = say;
    var oToast = ui.toast;
    ui.toast = function (msg, kind) {
      var r = oToast.apply(this, arguments);
      if (U.on) { try { say(msg, kind); } catch (e) { /* the old pill has it */ } }
      return r;
    };

    /* ---- the one per-frame hook: a boolean compared, a class written when it flips ---- */
    var oUpd = ui.update, wasPaused = false;
    ui.update = function (dt) {
      var r = oUpd.apply(this, arguments);
      if (U.on) {
        var p = !!(game.paused && game.mode === 'play');
        if (p !== wasPaused) { wasPaused = p; B.classList.toggle('u7-paused', p); }
      }
      return r;
    };

    /* ---- the switch ---- */
    function apply(on) {
      on = !!on;
      if (on === U.on) return;
      U.on = on;
      B.classList.toggle('ui117', on);
      B.classList.toggle('u7m', on && U.menus);   // the setup screen goes with the HUD
      B.classList.toggle('u7e', on && U.edUi);    // (round 118) and the Edit panel
      selSig = ''; objSig = ''; supSig = '';
      if (on) { dock(); drawSel(); }
      else {
        undock();
        B.classList.remove('u7-more'); B.classList.remove('u7-paused'); wasPaused = false;
        for (var i = 0; i < U.log.length; i++) if (U.log[i].el.parentNode) U.log[i].el.parentNode.removeChild(U.log[i].el);
        U.log.length = 0;
      }
    }
    /* the battle setup screen in the same language: its own switch, inside this one (class u7m with ui117) */
    U.menus = game.uiMenus117 !== false;
    Object.defineProperty(game, 'uiMenus117', {
      configurable: true, enumerable: true,
      get: function () { return U.menus; },
      set: function (v) { U.menus = !!v; B.classList.toggle('u7m', U.on && U.menus); }
    });
    /* (round 118) the Edit panel in the same language: its own switch, inside this one (class u7e with ui117) */
    U.edUi = game.uiEditor118 !== false;
    Object.defineProperty(game, 'uiEditor118', {
      configurable: true, enumerable: true,
      get: function () { return U.edUi; },
      set: function (v) { U.edUi = !!v; B.classList.toggle('u7e', U.on && U.edUi); }
    });
    var want = game.ui117 !== false;   // default ON (measured 10 Nov 13:13-13:21: no overlap at 1024 or 1920, no control lost, no cost); false before the install keeps the old HUD
    Object.defineProperty(game, 'ui117', {
      configurable: true, enumerable: true,
      get: function () { return U.on; },
      set: function (v) { apply(v); }
    });
    apply(want);
  };
})();
