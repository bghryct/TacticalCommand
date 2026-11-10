/* ===========================================================================
 * assets/editfps118.js — round 118: walk the map in the editor at eye height.
 *
 * The owner: "Improve the editor so that we can work better at a human scale
 * like in fps. Perhaps a fps mode for the editor."
 *
 * In Edit mode, V (or the "Walk the map" button at the top of the Edit panel)
 * puts the camera at a standing man's eye on the spot the top-down view was
 * looking at. WASD walks (Shift runs), the mouse looks, and a click does
 * whatever the current tool does, at the point under the crosshair. That
 * includes painting, sculpting, props, hedges, buildings, trees, trenches and
 * the remove tools. V or Esc goes back to the top-down editor, centred where
 * you are standing.
 *
 * NOTHING HERE PLACES ANYTHING ITSELF. A click is handed to the editor's own
 * mouse handlers (Input.onDown / onMove / onUp) with the screen centre as its
 * position. So every tool, including ones added after this file, places
 * exactly what it places from the top-down view, through its own code, with
 * its own undo. The ghost is the editor's own brush ring (updateBrushRing),
 * kept on the crosshair's point.
 *
 * HUMAN SCALE IS THE GAME'S OWN:
 *   - the eye is EYE_H x the rifleman's stature, the height first person uses;
 *   - the walk is 1.4 m/s and the run 5 m/s;
 *   - walls stop you through _fpvStep, the same collision a soldier has in
 *     first person, so a placed hedge or house stands at its true size beside
 *     the eye.
 *
 * THE SWITCH is game.editFps118 (default on).
 *   - Off: no button, no V binding, no listeners, nothing changed.
 *   - On but not walking: costs nothing per frame.
 *   - Walking: the camera rig's update is wrapped on the instance, and the
 *     wrapper is removed again on the way out.
 * ======================================================================== */
(function () {
  'use strict';
  var WALK = 1.4, RUN = 5, SENS = 0.0025, PITCH = 1.4;

  window.editFps118Install = function () {
    var G = window.game, D = document, B = D.body;
    if (!G || !G.editor || !G.input || !G.renderer || !G.cameraRig || G._ef8) return;
    var inp = G.input, cv = G.renderer.domElement, rig = G.cameraRig;
    var F = G._ef8 = { on: false, yaw: 0, pitch: -0.05, av: null, eyeH: 0, locked: false, cell: '', tool: '', moved: true };
    var allowed = G.editFps118 !== false;

    var mpu = (typeof METERS_PER_UNIT === 'number') ? METERS_PER_UNIT : 4;
    var TYPE = (typeof UNIT_DEFS === 'object' && UNIT_DEFS) ? (UNIT_DEFS.usrifle ? 'usrifle'
      : Object.keys(UNIT_DEFS).filter(function (k) { return !UNIT_DEFS[k].vehicle && !UNIT_DEFS[k].gun; })[0]) : null;
    function eyeHeight() {
      var e = (typeof EYE_H === 'number') ? EYE_H : 1.7 / mpu;
      var s = (TYPE && typeof armyStatureOf === 'function') ? armyStatureOf(TYPE) : 1;
      return e * (s || 1);
    }
    function centre(e) {
      return { button: e ? e.button : 0, buttons: e ? e.buttons : 0, clientX: innerWidth / 2, clientY: innerHeight / 2, target: cv,
        altKey: !!(e && e.altKey), shiftKey: !!(e && e.shiftKey), ctrlKey: !!(e && e.ctrlKey), metaKey: !!(e && e.metaKey),
        detail: e ? e.detail : 1, timeStamp: e ? e.timeStamp : 0, preventDefault: function () {}, stopPropagation: function () {} };
    }


    var st = D.createElement('style'); st.id = 'u8EdCss';
    st.textContent = [
      '#u8FpsBtn, #u8Cross, #u8EdHud { display: none; }',
      'body.u8-ef #u8FpsBtn { display: flex; align-items: center; gap: 8px; margin: 6px 8px 2px; padding: 6px 9px; cursor: pointer; user-select: none;',
      '  border: 1px solid var(--u7-line, #3a4a5a); border-radius: 2px; background: var(--u7-raise, #1a2530); color: var(--u7-text, #cbd5e1);',
      '  font: 600 11px/1.2 var(--u7-font, "Segoe UI", sans-serif); }',
      'body.u8-ef #u8FpsBtn:hover { border-color: var(--u7-khaki-dim, #9c8150); color: #fff; }',
      'body.u8-ef #u8FpsBtn.on { background: var(--u7-khaki, #d9b370); border-color: var(--u7-khaki, #d9b370); color: #14150f; }',
      '#u8FpsBtn svg { width: 13px; height: 13px; flex: none; } #u8FpsBtn span { flex: 1; }',
      '#u8FpsBtn kbd { font: 700 10px/1 var(--u7-font, sans-serif); padding: 2px 5px; border: 1px solid currentColor; border-radius: 2px; opacity: 0.8; }',
      'body.u8-edfps #u8Cross { display: block; position: fixed; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; z-index: 130;',
      '  pointer-events: none; border: 1.5px solid rgba(240,227,189,0.95); border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4); }',
      'body.u8-edfps #u8Cross::after { content: ""; position: absolute; left: 50%; top: 50%; width: 3px; height: 3px; margin: -1.5px 0 0 -1.5px; border-radius: 50%;',
      '  background: #f0e3bd; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }',
      'body.u8-edfps #u8EdHud { display: flex; flex-direction: column; align-items: center; gap: 2px; position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);',
      '  z-index: 130; pointer-events: none; box-sizing: border-box; width: max-content; max-width: min(660px, calc(100vw - 600px)); min-width: 300px; padding: 6px 12px;',
      '  background: var(--u7-panel, rgba(15,19,26,0.9)); border: 1px solid var(--u7-line, #2b3745); border-top: 2px solid var(--u7-khaki-dim, #9c8150); border-radius: 3px;',
      '  font: 11px/1.4 var(--u7-font, "Segoe UI", sans-serif); color: var(--u7-dim, #8493a3); text-align: center; }',
      'body.u8-edfps #u8EdHud b { font-size: 9.5px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--u7-khaki, #d9b370); }',
      'body.u8-edfps #u8EdHud span { font-size: 12px; font-weight: 700; color: var(--u7-text, #cbd5e1); }',
      'body.u8-edfps #u8EdHud i { font-style: normal; }',
      'body.u8-edfps #tooltip { display: none !important; }',
    ].join('\n');
    D.head.appendChild(st);

    /* ---- the DOM: a toggle at the top of the Edit panel, a crosshair, one line of help ---- */
    var panel = D.getElementById('editorPanel');
    var btn = D.createElement('div'); btn.id = 'u8FpsBtn'; btn.className = 'u8-fps';
    btn.title = 'Walk the map at eye height (V). WASD walk, Shift run, the mouse looks, a click uses the current tool where the crosshair points. V or Esc: back to the map.';
    btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="2.4" r="1.6" fill="currentColor"/><path d="M6 4.6v3.6M3.4 6h5.2M6 8.2 4.2 11.4M6 8.2l1.8 3.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg><span>Walk the map at eye height</span><kbd>V</kbd>';
    if (panel) {
      var tabs = panel.querySelector('.ed-tabs');
      panel.insertBefore(btn, tabs ? tabs.nextSibling : panel.firstChild);
    }
    var cross = D.createElement('div'); cross.id = 'u8Cross'; B.appendChild(cross);
    var hud = D.createElement('div'); hud.id = 'u8EdHud';
    hud.innerHTML = '<b>Walking the map</b><span id="u8EdWhat"></span><i>WASD walk · Shift run · mouse look · click: the current tool · wheel or R: turn · [ ]: size · V or Esc: back to the map</i>';
    B.appendChild(hud);
    var what = hud.querySelector('#u8EdWhat');
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

    /* ---- input, only while walking ---- */
    function onDownC(e) {
      if (!F.on) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (!F.locked && cv.requestPointerLock) { try { var pl = cv.requestPointerLock(); if (pl && pl.catch) pl.catch(function () {}); } catch (err) { /* refused: the cursor stays free */ } }
      inp.onDown(centre(e));
    }
    function onMoveC(e) {
      if (!F.on) return;
      if (!F.locked && inp._overUI && inp._overUI(e)) return;        // a free cursor over the panel is choosing a tool
      e.stopImmediatePropagation();
      var mx = e.movementX || 0, my = e.movementY || 0;
      if (mx || my) {
        F.yaw -= mx * SENS; F.pitch = Math.max(-PITCH, Math.min(PITCH, F.pitch - my * SENS)); F.moved = true;
      }
    }
    function onUpC(e) {
      if (!F.on) return;
      if (!F.locked && inp._overUI && inp._overUI(e) && !inp.lmbDown) return;
      e.stopImmediatePropagation();
      inp.onUp(centre(e));
    }
    function onWheelC(e) {
      if (!F.on) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (G.editor.nudgeRot) G.editor.nudgeRot(e.deltaY > 0 ? 15 : -15);   // the editor's own turn, as R / Shift+R
    }
    function onCtx(e) { if (F.on) e.preventDefault(); }
    function onLock() {
      var now = D.pointerLockElement === cv;
      if (F.on && F.locked && !now) exit();        // Esc under the lock is eaten by the browser: losing the lock is the way out
      F.locked = now;
    }
    function onKeyAlways(e) {
      if (!allowed || G.mode !== 'edit') return;
      var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.stopImmediatePropagation(); e.preventDefault(); toggle(); return; }
      if (F.on && e.code === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); exit(); }
    }
    D.addEventListener('keydown', onKeyAlways, true);      // one listener on key events; nothing a frame

    /* ---- a frame while walking: after the rig, so the eye wins ---- */
    var rigUpdate = null, rigOwn = false, saved = null;
    function tick(dt) {
      if (!F.on) return;
      if (G.mode !== 'edit' || G.fpv) { exit(); return; }
      dt = Math.min(0.1, Math.max(0, dt || 0));
      var k = inp.keys || {}, av = F.av;
      var fw = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
      var st = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
      if (fw || st) {
        var L = Math.sqrt(fw * fw + st * st), spd = ((k.ShiftLeft || k.ShiftRight) ? RUN : WALK) / mpu * dt / L;
        var sy = Math.sin(F.yaw), cy = Math.cos(F.yaw);
        var dx = (-sy * fw + cy * st) * spd, dz = (-cy * fw - sy * st) * spd;
        try { G._fpvStep(av, dx, dz, dt); } catch (err) { av.pos.x += dx; av.pos.z += dz; F.stepErr = String(err && err.message || err); }
        F.moved = true;
      }
      av.pos.y = G.terrain.heightAt(av.pos.x, av.pos.z);
      var cam = G.camera;
      cam.position.set(av.pos.x, av.pos.y + F.eyeH, av.pos.z);
      cam.rotation.order = 'YXZ'; cam.rotation.set(F.pitch, F.yaw, 0);
      cam.updateMatrixWorld(true);
      if (F.moved || inp.lmbDown) {
        F.moved = false;
        var c = centre(null), p = inp.groundPoint(c);
        if (p) {
          var gx = worldToCell(p.x), gz = worldToCell(p.z), key = gx + ',' + gz;
          if (key !== F.cell) {
            F.cell = key; F.hit = p;
            G.updateBrushRing(gx, gz);                       // the editor's own ghost, on the crosshair
            if (inp.lmbDown) inp.onMove(c);                  // a held click paints along where you look
            label(p);
          }
        }
      }
      if (G.editor.tool !== F.tool) label(F.hit);
    }
    function label(p) {
      F.tool = G.editor.tool;
      var b = panel && panel.querySelector('.tool-btn.selected'), nm = b ? b.textContent.replace(/\s+/g, ' ').trim() : '';
      if (nm.length <= 2) nm = String(F.tool || '').replace(/^[a-z]+:/, '').replace(/([a-z])([A-Z])/g, '$1 $2');   // a glyph-only button (×) says what it is
      var d = p ? Math.sqrt(Math.pow(p.x - F.av.pos.x, 2) + Math.pow(p.z - F.av.pos.z, 2)) * mpu : 0;
      what.textContent = nm + (p ? ' · ' + d.toFixed(d < 10 ? 1 : 0) + ' m ahead' : '');
    }

    function enter() {
      if (!allowed || F.on || G.mode !== 'edit' || G.fpv) return false;
      var t = rig.target, c = G.camera.position;
      var fx = t.x - c.x, fz = t.z - c.z;
      F.yaw = (fx * fx + fz * fz > 1e-6) ? Math.atan2(-fx, -fz) : 0; F.pitch = -0.05;
      F.av = { def: UNIT_DEFS[TYPE], type: TYPE, pos: new THREE.Vector3(t.x, G.terrain.heightAt(t.x, t.z), t.z), lvl: 0, face: 0 };
      F.eyeH = eyeHeight(); F.cell = ''; F.tool = ''; F.moved = true; F.stepErr = null;
      saved = { fov: G.camera.fov, near: G.camera.near };
      G.camera.fov = G._fpvFov116 ? G._fpvFov116() : 70; G.camera.near = 0.06; G.camera.updateProjectionMatrix();
      rigOwn = Object.prototype.hasOwnProperty.call(rig, 'update'); rigUpdate = rig.update;
      rig.update = function () { var r = rigUpdate.apply(this, arguments); tick(arguments[0]); return r; };
      cv.addEventListener('mousedown', onDownC, true);
      window.addEventListener('mousemove', onMoveC, true);
      window.addEventListener('mouseup', onUpC, true);
      cv.addEventListener('wheel', onWheelC, { capture: true, passive: false });
      cv.addEventListener('contextmenu', onCtx, true);
      D.addEventListener('pointerlockchange', onLock);
      F.on = true; B.classList.add('u8-edfps'); btn.classList.add('on');
      if (G.ui && G.ui.el && G.ui.el.tooltip) G.ui.el.tooltip.style.display = 'none';
      if (cv.requestPointerLock) { try { var pl = cv.requestPointerLock(); if (pl && pl.catch) pl.catch(function () {}); } catch (err) { /* needs a gesture: the first click asks again */ } }
      label(null);
      return true;
    }
    function exit() {
      if (!F.on) return false;
      F.on = false;
      if (rigOwn) rig.update = rigUpdate; else delete rig.update;
      cv.removeEventListener('mousedown', onDownC, true);
      window.removeEventListener('mousemove', onMoveC, true);
      window.removeEventListener('mouseup', onUpC, true);
      cv.removeEventListener('wheel', onWheelC, { capture: true, passive: false });
      cv.removeEventListener('contextmenu', onCtx, true);
      D.removeEventListener('pointerlockchange', onLock);
      if (inp.lmbDown) inp.onUp(centre(null));
      if (D.pointerLockElement === cv && D.exitPointerLock) D.exitPointerLock();
      F.locked = false;
      if (saved) { G.camera.fov = saved.fov; G.camera.near = saved.near; G.camera.updateProjectionMatrix(); }
      if (F.av) rig.target.set(F.av.pos.x, 0, F.av.pos.z);        // the top-down view comes back where you stood
      B.classList.remove('u8-edfps'); btn.classList.remove('on');
      return true;
    }
    function toggle() { return F.on ? exit() : enter(); }
    F.enter = enter; F.exit = exit; F.toggle = toggle; F.tick = tick;

    /* ---- the switch ---- */
    function setAllowed(v) {
      allowed = !!v;
      if (!allowed) exit();
      B.classList.toggle('u8-ef', allowed);
    }
    Object.defineProperty(G, 'editFps118', { configurable: true, enumerable: true, get: function () { return allowed; }, set: setAllowed });
    setAllowed(allowed);
  };
})();
