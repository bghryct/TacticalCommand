/* ===========================================================================
 * assets/pause119.js — round 119: a pause menu.
 *
 * The game had none (round 117's UI pass noted it). Space stopped the clock
 * and Esc only ever closed the last thing opened, so a player on the public
 * page who wanted to restart, fight somewhere else, read the manual or turn
 * the sound off had to find each control in the top bar. Now, in a battle,
 * Esc with nothing left to close (no first person, overlay, route, order menu
 * or selection) opens this menu and stops the clock. Esc again, Resume, or a
 * click beside the card gives the clock back exactly as it was: a battle that
 * was paused stays paused.
 *
 * EVERY ITEM PRESSES THE REAL CONTROL. Restart clicks the top bar's Battle
 * button; another battlefield sets the top bar's map picker and fires its
 * change event (briefing, then the battle setup); the manual clicks Help;
 * sound clicks the mute button; the editor clicks Edit. So there is still one
 * way to do each, and the menu cannot drift from the bar.
 *
 * While it is open the game sees no keys, so nothing typed can order the
 * troops. Esc or Space (the HUD says "Space to resume") closes it.
 *
 * THE SWITCH is game.pause119 (default on). Off, Esc does what it always did.
 * Nothing here runs per frame.
 * ======================================================================== */
(function () {
  'use strict';

  var CSS = [
    '#p119 { position: fixed; inset: 0; z-index: 960; display: none; align-items: center; justify-content: center;',
    '  background: rgba(5,8,11,0.62); font-family: var(--u7-font, "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif); }',
    '#p119.on { display: flex; }',
    '#p119 .p119-card { width: 320px; max-width: calc(100vw - 32px); background: var(--u7-panel, rgba(16,19,17,0.96));',
    '  border: 1px solid var(--u7-line, #394036); border-top: 2px solid var(--u7-khaki-dim, #8d7f58); border-radius: 3px;',
    '  box-shadow: 0 6px 28px rgba(0,0,0,0.6); padding: 16px; color: var(--u7-text, #dedccd); }',
    '#p119 .p119-eye { font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--u7-khaki, #cfb87c); }',
    '#p119 .p119-title { font-size: 16px; margin: 4px 0 2px; }',
    '#p119 .p119-sub { font-size: 11px; color: var(--u7-dim, #979a8a); margin-bottom: 12px; }',
    '#p119 button.p119-b { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%;',
    '  margin: 0 0 6px; padding: 8px 10px; font: inherit; font-size: 12px; text-align: left; cursor: pointer;',
    '  color: var(--u7-text, #dedccd); background: var(--u7-raise, #1c211d); border: 1px solid var(--u7-line, #394036); border-radius: 2px; }',
    '#p119 button.p119-b:hover, #p119 button.p119-b:focus-visible { background: var(--u7-raise2, #272e27);',
    '  border-color: var(--u7-khaki-dim, #8d7f58); color: #fff; outline: none; }',
    '#p119 button.p119-b.primary { border-color: var(--u7-khaki-dim, #8d7f58); }',
    '#p119 button.p119-b:disabled { opacity: 0.45; cursor: default; }',
    '#p119 .p119-row { display: flex; gap: 6px; margin: 0 0 6px; }',
    '#p119 .p119-row select { flex: 1; min-width: 0; font: inherit; font-size: 12px; color: var(--u7-text, #dedccd);',
    '  background: var(--u7-raise, #1c211d); border: 1px solid var(--u7-line, #394036); border-radius: 2px; padding: 6px; }',
    '#p119 .p119-row button.p119-b { width: auto; margin: 0; flex: none; }',
    '#p119 kbd { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: var(--u7-dim, #979a8a);',
    '  border: 1px solid var(--u7-line, #394036); border-radius: 2px; padding: 0 4px; }',
    '#p119 .p119-sep { height: 1px; background: var(--u7-line, #394036); margin: 10px 0; }',
  ].join('\n');

  var P = window.Pause119 = { open: false, wasPaused: false, el: null };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mmss(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2); }
  function bar(g, id) { return (g.ui && g.ui.el && g.ui.el[id]) || document.getElementById(id); }

  P.install = function (g) {
    if (P.el || !document.body) return;
    var st = document.createElement('style');
    st.id = 'p119css'; st.textContent = CSS;
    document.head.appendChild(st);
    var root = document.createElement('div');
    root.id = 'p119';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Battle paused');
    root.innerHTML = '<div class="p119-card">'
      + '<div class="p119-eye">Battle paused</div><div class="p119-title" id="p119Title"></div><div class="p119-sub" id="p119Sub"></div>'
      + '<button class="p119-b primary" data-a="resume">Resume <kbd>Esc</kbd></button>'
      + '<button class="p119-b" data-a="restart" id="p119Restart">Restart the battle</button>'
      + '<div class="p119-row"><select id="p119Map" aria-label="Another battlefield"></select>'
      + '<button class="p119-b" data-a="map" id="p119Go">Fight here</button></div>'
      + '<div class="p119-sep"></div>'
      + '<button class="p119-b" data-a="manual">Field manual and controls <kbd>?</kbd></button>'
      + '<button class="p119-b" data-a="sound" id="p119Sound">Sound</button>'
      + '<button class="p119-b" data-a="editor">Map editor</button>'
      + '</div>';
    document.body.appendChild(root);
    P.el = root;
    // the same era-grouped list as the top bar's picker (`MAPS` is the page's)
    var eras = [], by = {};
    (typeof MAPS !== 'undefined' ? MAPS : []).forEach(function (m, i) {
      var e = m.era || 'Other';
      if (!by[e]) { by[e] = []; eras.push(e); }
      by[e].push('<option value="' + (i + 1) + '">' + esc(m.name) + '</option>');
    });
    root.querySelector('#p119Map').innerHTML = eras.map(function (e) {
      return '<optgroup label="' + esc(e) + '">' + by[e].join('') + '</optgroup>';
    }).join('');
    root.addEventListener('click', function (ev) {
      if (ev.target === root) { P.hide(g); return; }          // a click beside the card resumes
      var b = ev.target.closest && ev.target.closest('button[data-a]');
      if (b && !b.disabled) P.act(g, b.getAttribute('data-a'));
    });
  };

  /** Refresh what the card says: where, how long, what is allowed. */
  P.sync = function (g) {
    if (!P.el) return;
    var name = g.mapDef && g.mapDef.name ? g.mapDef.name : 'The battle';
    P.el.querySelector('#p119Title').textContent = name;
    P.el.querySelector('#p119Sub').textContent = mmss(g.time) + ' into the battle' + (g.campaign ? ' · campaign' : '');
    // A campaign battle is restarted and moved on by the campaign, not from here.
    var rs = P.el.querySelector('#p119Restart');
    rs.disabled = !g.battleSnapshot || !!g.campaign;
    var ms = P.el.querySelector('#p119Map'), go = P.el.querySelector('#p119Go');
    ms.disabled = go.disabled = !!g.campaign;
    var top = document.getElementById('mapSelect');
    if (top && top.value) ms.value = top.value;
    var muted = !!(g.sfx && g.sfx.muted);
    P.el.querySelector('#p119Sound').innerHTML = 'Sound: ' + (muted ? 'off' : 'on') + ' <kbd>' + (muted ? 'turn on' : 'turn off') + '</kbd>';
  };

  P.show = function (g) {
    if (!P.el || P.open) return;
    P.wasPaused = !!g.paused;
    g.paused = true;
    P.sync(g);
    P.el.classList.add('on');
    P.open = true;
    var r = P.el.querySelector('button[data-a="resume"]');
    if (r && r.focus) r.focus();
  };

  /** Close. `keep`: leave the clock stopped (the item that closed it takes over). */
  P.hide = function (g, keep) {
    if (!P.el || !P.open) return;
    P.open = false;
    P.el.classList.remove('on');
    if (!keep) g.paused = P.wasPaused;
  };

  P.act = function (g, a) {
    if (a === 'resume') { P.hide(g); return; }
    if (a === 'restart') {
      var bb = bar(g, 'btnBattle');
      if (!bb) return;
      P.hide(g, true); bb.click(); return;
    }
    if (a === 'map') {
      var idx = P.el.querySelector('#p119Map').value, top = document.getElementById('mapSelect');
      if (!top || !idx) return;
      P.hide(g, true);
      top.value = idx;
      top.dispatchEvent(new Event('change'));
      return;
    }
    if (a === 'manual') {
      var hb = bar(g, 'btnHelp');
      P.hide(g, true);                   // the battle stays stopped while you read; Space resumes it
      if (hb) hb.click();
      return;
    }
    if (a === 'sound') {
      var mb = bar(g, 'btnMute');
      if (mb) mb.click();
      P.sync(g);
      return;
    }
    if (a === 'editor') {
      if (g.campaign && !window.confirm('Leave this campaign battle for the map editor?')) return;
      var eb = bar(g, 'btnEdit');
      P.hide(g, true);
      if (eb) eb.click(); else g.setMode('edit');
    }
  };

  /** The game's key handler asks this first. True: the menu took the key. */
  P.onKey = function (g, e) {
    if (!P.open) return false;
    // Esc, and Space (the HUD's PAUSED marker says "Space to resume"), give the clock back
    if (e.code === 'Escape' || e.code === 'Space') { e.preventDefault(); P.hide(g); }
    return true;                       // Tab and Enter still work on the focused button
  };

  /** May Esc open it now? Only in a battle with nothing else to close. */
  P.canOpen = function (g) {
    if (!P.el || g.pause119 === false || g.mode !== 'play' || g.fpv || g.hk) return false;
    if (g.selection && g.selection.length) return false;
    var ban = bar(g, 'banner');
    if (ban && ban.classList.contains('visible')) return false;
    var bs = document.getElementById('bsetup');
    if (bs && bs.classList.contains('on')) return false;
    return true;
  };

  window.pause119Install = function () {
    var g = window.game;
    if (g && g.pause119 !== false) P.install(g);
  };
})();
