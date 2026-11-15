/* ===========================================================================
 * assets/loading119.js — round 119: say when the scale models are arriving.
 *
 * Since round 119 a battle downloads the scale models it fields, when it fields
 * them (assets/extmodels.js, `packUrl`): 24 MB for the opening battle instead
 * of 184 MB of every model at boot. The price is a few seconds in which the
 * tanks are their plain procedural stand-ins, which on the public page reads as
 * broken unless something says otherwise. This pill says so — "Scale models
 * arriving · 12" — while `ExtModels` has models downloading or decoding, and
 * goes away when they have landed.
 *
 * Shown only after 0.3 s of loading (an instant decode never flickers it) and
 * hidden 0.6 s after the last model lands. Never in first person. Polls the
 * loader's counters 2.5 times a second; nothing runs per frame.
 *
 * THE SWITCH is game.loading119 (default on).
 * ======================================================================== */
(function () {
  'use strict';

  var CSS = [
    '#ld119 { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 120; display: none;',
    '  padding: 5px 12px; border-radius: 3px; pointer-events: none; white-space: nowrap;',
    '  font: 11px/1.3 var(--u7-font, "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif);',
    '  color: var(--u7-text, #dedccd); background: var(--u7-panel, rgba(16,19,17,0.94));',
    '  border: 1px solid var(--u7-line, #394036); border-top: 2px solid var(--u7-khaki-dim, #8d7f58); }',
    '#ld119.on { display: block; }',
    'body.fpv #ld119 { display: none !important; }',
  ].join('\n');

  var L = window.Loading119 = { el: null, since: 0, idle: 0, timer: null };

  /** One look at the loader. Exposed so a test can drive it with a clock. */
  L.tick = function (now) {
    var g = window.game, E = window.ExtModels;
    if (!L.el || !E || !E.stats) return;
    if (g && g.loading119 === false) { L.el.classList.remove('on'); return; }
    var n = E.stats().loading || 0;
    if (n > 0) {
      L.idle = 0;
      if (!L.since) L.since = now;
      if (now - L.since >= 300) {
        L.el.textContent = 'Scale models arriving · ' + n;
        L.el.classList.add('on');
      }
    } else {
      L.since = 0;
      if (!L.idle) L.idle = now;
      if (now - L.idle >= 600) L.el.classList.remove('on');
    }
  };

  window.loading119Install = function () {
    if (L.el || !document.body) return;
    var st = document.createElement('style');
    st.id = 'ld119css'; st.textContent = CSS;
    document.head.appendChild(st);
    var el = document.createElement('div');
    el.id = 'ld119'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    L.el = el;
    L.timer = setInterval(function () { L.tick(Date.now()); }, 400);
  };
})();
