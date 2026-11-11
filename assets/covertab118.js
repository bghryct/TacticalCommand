/* assets/covertab118.js — round 118, `game.coverTab118` (default ON since the evidence below; false = the editor exactly as it was).
 *
 * EVIDENCE for the default (tools/probe_covertab118.js, Village + Hedgerow Hell, 00:30 UTC 11 Nov): all 33 tools placed through
 * the editor's own beginStroke/apply/endStroke, each found in the sim afterwards (obstacles.at type, occupancy 7 under every
 * trench/foxhole cell, foliage density, a new undo snapshot); the overlay's texel equal to `_coverValueCalc` on every placed
 * cell (0 mismatches); a full recompute 9.7 ms for 50,176 cells (0.19 us each), a one-stamp edit under 0.1 ms; the overlay's
 * draw in the editor +0.0..0.4 ms against a null of 0.1..0.2; switched off, no tab, page, style, wrapper or mesh is left.
 *
 * THE COVER TAB AND THE SHOW-COVER OVERLAY. The owner: "I can't figure out how to add [trenches] in the
 * editor ... we need really good cover and cover editability things like trenches and plants and walls".
 * The trench was one button among ~51 in Props; hedges, walls, sandbags, wire, foxholes, gun pits and
 * plants were scattered across Props, Build and Grow, and nothing showed an author what protection a
 * position gave. This adds, in the editor only:
 *   1. a COVER tab beside Props gathering every tool that makes cover or concealment, each with its
 *      thumbnail, a one-line how-to and what it gives — the numbers read from the sim's own tables
 *      (COVER_DOODAD, TRENCH118 + the dug-in figure, the foliage defs' cover/conceal, COMBAT.coverMax);
 *   2. SHOW COVER: the ground tinted cell by cell by what a man standing there gets, computed by the
 *      sim's OWN functions (`Unit.prototype._coverValueCalc`, `_stealthMulCalc`, `_trenchCell118`) on a
 *      plain stand-in man — one DataTexture (GRID x GRID) drawn on the terrain's own geometry, rewritten
 *      only for the cells an edit touched;
 *   3. a way to find it: the tab is marked, and the first time the editor shows a hint says the trenches
 *      live there (once per browser, localStorage, wrapped).
 * The old buttons stay where they were. Nothing here runs in a battle or touches the sim's state: the
 * overlay is hidden outside the editor and the stand-in man is a plain object no list holds.
 */
(function () {
  'use strict';
  var CT = window.CoverTab118 = {
    on: false, built: false, mode: 'off', hintKey: 'ct118.hintSeen', DEFAULT: true,   // Show cover comes on when the tab is first opened
    stats: { full: 0, part: 0, cells: 0, lastMs: 0, fullMs: 0 },
  };

  /* ---- what each tool is, how it is used, and which table its numbers come from ---- */
  var HOW = {
    trench: 'Drag a line to dig a fire trench; it steps round a traverse every 18 m. Men who stop in it are dug in.',
    trenchseg: 'Drag a line of trench with a parapet; men who stop in it are dug in.',
    foxhole: 'Click to dig a two-man hole; a man who stops in it is dug in.',
    gunpit: 'Click beside where a gun will stand; a towed gun at rest next to it takes it, its crew dug in.',
    emplacement: 'Click for an earthwork berm round a weapon; a gun at rest beside it digs in.',
    sandbags: 'Drag a line of sandbags; men crouch behind it and fire over it.',
    sandbagwall: 'Drag a chest-high sandbag wall.',
    lowwall: 'Drag a knee-high wall; men climb it and fire over it.',
    stonewall: 'Drag a stone farm wall.',
    brickwall: 'Drag a brick wall.',
    wall: 'Drag a line of yard wall, head high.',
    logwall: 'Drag a log revetment.',
    concrete: 'Drag concrete barriers; they stop a tank round.',
    gabion: 'Drag a line of earth-filled gabions.',
    barricade: 'Drag a street barricade.',
    hedge: 'Drag a line of bocage hedgerow: an earth bank under a hedge.',
    bush: 'Brush bushes on; they hide a man more than they shield him.',
    scrub: 'Brush scrub on: concealment, not cover.',
    wire: 'Drag a belt of wire: it stops men, not bullets. Wire your fields of fire.',
    hedgehog: 'Click Czech hedgehogs to stop tanks; men walk between them.',
    dragonteeth: "Drag a line of dragon's teeth to stop tanks.",
    bunker: 'Click a concrete bunker; men inside hold it.',
    pillbox: 'Click a small concrete pillbox.',
    _fol: 'Paint with the brush; it thickens while you hold. Shift thins it.',
    _bunk: 'Click to build; its embrasure faces the Angle (R turns it).',
  };
  var SECTIONS = [
    ['Dig in', ['trench', 'trenchseg', 'foxhole', 'gunpit', 'emplacement']],
    ['Walls', ['sandbags', 'sandbagwall', 'lowwall', 'stonewall', 'brickwall', 'wall', 'logwall', 'concrete', 'gabion', 'barricade']],
    ['Hedges & plants', ['hedge', 'bush', 'scrub', '_fol']],
    ['Obstacles', ['wire', 'hedgehog', 'dragonteeth']],
    ['Bunkers', ['bunker', 'pillbox', '_bunk']],
  ];
  // the line props are laid with a Line drag; the rest a click or a brush
  var LINE = { trench: 1, trenchseg: 1, sandbags: 1, sandbagwall: 1, lowwall: 1, stonewall: 1, brickwall: 1, wall: 1, logwall: 1,
    concrete: 1, gabion: 1, barricade: 1, hedge: 1, wire: 1, dragonteeth: 1 };
  var DUG_IN = 0.85;   // what `_trenchTick118` / `_pitTick118` / a dug foxhole set `dugin` to
  var DUG_SEEN = 0.6;  // `_stealthMulCalc`: `if (this.dugin) m *= 0.6`

  /** The page's own tables and helpers (top-level const/let/class of the main script: global, but not on window). */
  function T(name) {
    switch (name) {
      case 'OBS_DEF': return typeof OBS_DEF !== 'undefined' ? OBS_DEF : undefined;
      case 'COVER_DOODAD': return typeof COVER_DOODAD !== 'undefined' ? COVER_DOODAD : undefined;
      case 'TRENCH118': return typeof TRENCH118 !== 'undefined' ? TRENCH118 : undefined;
      case 'COMBAT': return typeof COMBAT !== 'undefined' ? COMBAT : undefined;
      case 'trench118On': return typeof trench118On !== 'undefined' ? trench118On : undefined;
      case 'Unit': return typeof Unit !== 'undefined' ? Unit : undefined;
      case 'cellCenter': return typeof cellCenter !== 'undefined' ? cellCenter : undefined;
      case 'inGrid': return typeof inGrid !== 'undefined' ? inGrid : undefined;
      case 'GRID': return typeof GRID !== 'undefined' ? GRID : undefined;
      case 'HALF': return typeof HALF !== 'undefined' ? HALF : undefined;
      case 'TILE': return typeof TILE !== 'undefined' ? TILE : undefined;
    }
    return undefined;
  }
  function pct(v) { return Math.round(v * 100); }
  function coverMax() { var C = T('COMBAT'); return C && C.coverMax ? C.coverMax : 0.8; }
  function bunkerOn(G) { var B = window.Bunker118; return !!(B && (G.bunker118 != null ? G.bunker118 === true : B.ON === true)); }
  function trenchOn() { var f = T('trench118On'); return typeof f === 'function' ? !!f() : true; }

  /** The tools this build has, by section: { tool, key, label, how, gives, badge, kind }. */
  function tools(G) {
    var OBS = T('OBS_DEF') || {}, COV = T('COVER_DOODAD') || {}, TR = T('TRENCH118') || {}, cmax = coverMax();
    var out = [];
    SECTIONS.forEach(function (s) {
      var list = [];
      s[1].forEach(function (k) {
        if (k === '_fol') {
          var F = window.Foliage;
          if (!F || !F.DEFS || !G.foliage) return;
          F.DEFS.filter(function (d) { return d.conceal >= 0.25; })
            .sort(function (a, b) { return b.conceal - a.conceal; }).slice(0, 10)
            .forEach(function (d) {
              list.push({ tool: 'fol:' + d.id, key: d.id, label: d.name, how: HOW._fol, kind: 'fol', swatch: d.swatch,
                gives: 'Cover ' + pct(d.cover) + ' · hides: seen at ' + pct(1 - d.conceal) + '% of range (full growth)',
                badge: '◐' + pct(d.conceal), cover: d.cover, conceal: d.conceal });
            });
          return;
        }
        if (k === '_bunk') {
          var B = window.Bunker118;
          if (!B || !B.KINDS || !bunkerOn(G)) return;
          Object.keys(B.KINDS).forEach(function (bk) {
            list.push({ tool: 'bunker118:' + bk, key: bk, label: B.KINDS[bk].name, how: HOW._bunk, kind: 'bunk',
              gives: 'A one-cell bunker: men behind its embrasure show a slit of themselves', badge: '', swatch: bk === 'dugout' ? '#5a4530' : '#8e8b83' });
          });
          return;
        }
        if (!OBS[k]) return;
        var c = COV[k] || 0, dug = !!TR[k], gun = k === 'gunpit' || k === 'emplacement', g = [];
        if (dug) g.push('In it: dug in, cover ' + pct(Math.min(cmax, DUG_IN)) + ' (the most there is), seen at ' + pct(DUG_SEEN) + '% of range');
        if (gun) g.push('A gun at rest in it: crew dug in, cover ' + pct(Math.min(cmax, DUG_IN)));
        g.push(c > 0 ? 'Cover ' + pct(c) + ' beside it' : 'No cover');
        if (OBS[k].seethrough) g.push('sight passes it');
        list.push({ tool: k === 'trench' && trenchOn() ? 'prop:trench' : k, key: k, label: k === 'trenchseg' ? 'Parapet trench' : cap(k), how: HOW[k] || '',
          kind: 'prop', gives: g.join(' · '), badge: dug || gun ? pct(Math.min(cmax, DUG_IN)) : (c > 0 ? String(pct(c)) : '—'),
          dug: dug || gun, cover: c, line: !!LINE[k], color: OBS[k].color });
      });
      if (list.length) out.push({ name: s[0], list: list });
    });
    return out;
  }
  function cap(s) { var n = { dragonteeth: "Dragon's teeth", sandbagwall: 'Sandbag wall', lowwall: 'Low wall', stonewall: 'Stone wall', brickwall: 'Brick wall',
    logwall: 'Log wall', gunpit: 'Gun pit', hedgehog: 'Hedgehogs' }; return n[s] || (s[0].toUpperCase() + s.slice(1)); }

  /* ---- the stand-in man: a plain object the sim's own cover functions are called on ---- */
  var DEF = { name: 'cover probe' };
  function ghost(G) {
    return { game: G, def: DEF, pos: { x: 0, y: 0, z: 0 }, lvl: 0, posture: 'stand', hold: false, moveMode: 'normal', path: [], dugin: 0,
      garrison: null, garrisonSlot: null, _coverFrom: undefined, _flankedT: -1e9, _fireArcs: [], lightsOn: false, _stealthUntil: 0 };
  }
  /** [cover 0..coverMax, concealment 0..1, dug-in?] for a man standing still in cell (gx, gz). */
  function cellValues(G, gh, gx, gz) {
    var U = T('Unit'), cc = T('cellCenter');
    gh.pos.x = cc(gx); gh.pos.z = cc(gz); gh.dugin = 0;
    var dug = false;
    if (trenchOn() && U.prototype._trenchCell118 && U.prototype._trenchCell118.call(gh)) dug = true;
    if (dug) gh.dugin = DUG_IN;
    var cov = U.prototype._coverValueCalc.call(gh);
    var m = U.prototype._stealthMulCalc.call(gh, true);
    return [cov, Math.max(0, Math.min(1, 1 - m)), dug];
  }
  CT._tools = tools;   // the test reads the list and its numbers
  CT.cellValues = function (gx, gz, G) { G = G || window.game; return cellValues(G, ghost(G), gx, gz); };

  /* ---- the overlay: one RGBA texel per cell, on the terrain's own geometry ---- */
  var O = { tex: null, data: null, cov: null, con: null, dug: null, n: 0, mat: null, mesh: null, dirty: null, job: null };
  var VS = 'varying vec2 vW;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }';
  var FS = [
    'uniform sampler2D uMap; uniform float uHalf, uTile, uGrid, uWhich;',
    'varying vec2 vW;',
    'vec3 rampCover(float v) {',             // v = cover / coverMax. Light pale gold, middling orange, heavy red, DUG IN (the max) magenta:
    '  vec3 a = vec3(1.00, 0.93, 0.45), b = vec3(1.00, 0.55, 0.12), c = vec3(0.90, 0.12, 0.12), d = vec3(0.95, 0.20, 0.95);',   // none of them the field's greens and browns
    '  return v < 0.3 ? a : v < 0.55 ? mix(a, b, (v - 0.3) / 0.25) : v < 0.85 ? mix(b, c, (v - 0.55) / 0.3) : v < 0.95 ? c : d; }',
    'vec3 rampConceal(float v) {',
    '  vec3 a = vec3(0.55, 0.95, 1.00), b = vec3(0.20, 0.55, 1.00), c = vec3(0.45, 0.20, 0.95);',
    '  return v < 0.4 ? mix(a, b, v / 0.4) : mix(b, c, clamp((v - 0.4) / 0.4, 0.0, 1.0)); }',
    'void main() {',
    '  vec2 g = (vW + uHalf) / uTile, c = floor(g), f = g - c;',
    '  vec4 t = texture2D(uMap, (c + 0.5) / uGrid);',
    '  float v = uWhich < 0.5 ? t.r : t.g;',
    '  float lo = uWhich < 0.5 ? 0.10 : 0.15;',   // a meadow's 0.05-0.08 and its slight hiding are not drawn: only what an author built or chose
    '  if (v < lo) discard;',
    '  vec3 col = uWhich < 0.5 ? rampCover(v / 0.8) : rampConceal(v);',
    '  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));',
    '  float rim = 1.0 - smoothstep(0.02, 0.09, e);',                      // each cell edged, so a value reads as a cell
    '  float dug = uWhich < 0.5 ? t.b : 0.0;',
    '  float hatch = dug * step(0.5, fract((f.x + f.y) * 3.0));',          // dug-in cells hatched
    '  col = mix(col, col * 0.35, max(rim * 0.7, hatch * 0.55));',
    '  gl_FragColor = vec4(col, (uWhich < 0.5 ? 0.20 : 0.26) + 0.46 * clamp(uWhich < 0.5 ? v / 0.8 : v, 0.0, 1.0));',
    '}'].join('\n');

  function ensureOverlay(G) {
    var Tm = G.terrain && G.terrain.mesh; if (!Tm) return false;
    var N = T('GRID');
    if (!O.tex || O.n !== N) {
      if (O.tex) O.tex.dispose();
      O.n = N; O.data = new Uint8Array(N * N * 4); O.cov = new Float32Array(N * N); O.con = new Float32Array(N * N); O.dug = new Uint8Array(N * N);
      O.tex = new THREE.DataTexture(O.data, N, N, THREE.RGBAFormat);
      O.tex.magFilter = O.tex.minFilter = THREE.NearestFilter; O.tex.generateMipmaps = false; O.tex.needsUpdate = true;
      if (O.mat) O.mat.uniforms.uMap.value = O.tex;
      O.dirty = [0, 0, N - 1, N - 1];
    }
    if (!O.mat) {
      O.mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: O.tex }, uHalf: { value: T('HALF') }, uTile: { value: T('TILE') }, uGrid: { value: N }, uWhich: { value: 0 } },
        vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
      O.mat.name = 'coverOverlay118';
    }
    O.mat.uniforms.uHalf.value = T('HALF'); O.mat.uniforms.uTile.value = T('TILE'); O.mat.uniforms.uGrid.value = N;
    if (!O.mesh) { O.mesh = new THREE.Mesh(Tm.geometry, O.mat); O.mesh.name = 'coverOverlay118'; O.mesh.renderOrder = 4; O.mesh.frustumCulled = false; O.mesh.matrixAutoUpdate = false; }
    if (O.mesh.geometry !== Tm.geometry) O.mesh.geometry = Tm.geometry;   // a new map is a new terrain
    if (O.mesh.parent !== Tm) Tm.add(O.mesh);
    return true;
  }
  function markDirty(x0, z0, x1, z1) {
    var N = O.n || T('GRID');
    var a = Math.max(0, Math.min(x0, x1)), b = Math.max(0, Math.min(z0, z1)), c = Math.min(N - 1, Math.max(x0, x1)), d = Math.min(N - 1, Math.max(z0, z1));
    if (a > c || b > d) return;
    O.dirty = O.dirty ? [Math.min(O.dirty[0], a), Math.min(O.dirty[1], b), Math.max(O.dirty[2], c), Math.max(O.dirty[3], d)] : [a, b, c, d];
    schedule();
  }
  function markAll() { var N = O.n || T('GRID'); O.dirty = [0, 0, N - 1, N - 1]; schedule(); }
  CT.markDirty = markDirty; CT.markAll = markAll;
  function want() { var G = window.game; return CT.on && CT.mode !== 'off' && G && G.mode === 'edit'; }
  function schedule() { if (O.job || !want()) return; O.job = setTimeout(work, 60); }
  /** Rewrite the dirty rectangle, a slice of rows at a time (a whole map is ~50,000 cells). */
  function work() {
    O.job = null;
    var G = window.game; if (!want() || !ensureOverlay(G) || !O.dirty) return;
    var N = O.n, r = O.dirty, gh = ghost(G), t0 = performance.now(), z = r[1];
    for (; z <= r[3]; z++) {
      for (var x = r[0]; x <= r[2]; x++) {
        var v = cellValues(G, gh, x, z), i = z * N + x, j = i * 4;
        O.cov[i] = v[0]; O.con[i] = v[1]; O.dug[i] = v[2] ? 1 : 0;
        O.data[j] = Math.round(Math.min(1, v[0]) * 255); O.data[j + 1] = Math.round(v[1] * 255); O.data[j + 2] = v[2] ? 255 : 0; O.data[j + 3] = 255;
      }
      if (performance.now() - t0 > 8) { z++; break; }
    }
    CT.stats.cells += (z - r[1]) * (r[2] - r[0] + 1);
    O.tex.needsUpdate = true;
    if (z > r[3]) { O.dirty = null; CT.stats.lastMs = performance.now() - t0; }
    else { O.dirty = [r[0], z, r[2], r[3]]; O.job = setTimeout(work, 0); }
  }
  /** Finish every pending row now (probes; never a frame). */
  CT.flush = function () { var n = 0; while (O.dirty && n++ < 10000) { if (O.job) { clearTimeout(O.job); O.job = null; } if (!want()) break; work(); } if (O.job) { clearTimeout(O.job); O.job = null; } return !O.dirty; };
  CT.O = O;
  function showOverlay() {
    var G = window.game, vis = want();
    if (vis && ensureOverlay(G)) {
      O.mat.uniforms.uWhich.value = CT.mode === 'conceal' ? 1 : 0;
      O.mesh.visible = true;
      if (O.dirty) schedule();
    } else if (O.mesh) O.mesh.visible = false;
    var lg = document.getElementById('ct118Legend');
    if (lg) lg.className = 'ct-legend ' + (CT.mode === 'off' ? 'off' : CT.mode);
  }
  CT.setMode = function (m) {
    CT.mode = m === 'conceal' || m === 'off' ? m : 'cover';
    var s = document.getElementById('ct118Show');
    if (s) [].forEach.call(s.children, function (d) { d.classList.toggle('on', d.dataset.v === CT.mode); });
    showOverlay();
  };

  /* ---- the editor's own edit paths, watched (only while the switch is on; put back when it goes off) ---- */
  var WR = [];
  function wrap(obj, name, after) {
    var orig = obj[name]; if (typeof orig !== 'function') return;
    var own = Object.prototype.hasOwnProperty.call(obj, name);
    var w = function () { var pre = after.pre ? after.pre.apply(this, arguments) : null; var r = orig.apply(this, arguments); try { after.post.call(this, arguments, pre, r); } catch (e) { CT.err = String(e && e.message || e); } return r; };
    obj[name] = w; WR.push({ obj: obj, name: name, orig: orig, own: own, w: w });
  }
  function unwrapAll() { for (var i = WR.length - 1; i >= 0; i--) { var r = WR[i]; if (r.obj[r.name] === r.w) { if (r.own) r.obj[r.name] = r.orig; else delete r.obj[r.name]; } } WR.length = 0; }
  function mirroredRect(ed, x0, z0, x1, z1, pad) {
    var pts = (ed._mirrored ? ed._mirrored(x0, z0) : [[x0, z0]]), pts2 = (ed._mirrored ? ed._mirrored(x1, z1) : [[x1, z1]]);
    for (var k = 0; k < pts.length; k++) { var a = pts[k], b = pts2[k] || a; markDirty(Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad); }
  }
  function hookEdits(G) {
    var ed = G.editor;
    wrap(ed, 'apply', { post: function (args) { if (args[0] != null) mirroredRect(ed, args[0], args[1], args[0], args[1], (ed.brush | 0) + 3); } });
    wrap(ed, 'endStroke', {
      pre: function () { var s = ed.stroke; return s ? [s.gx0, s.gz0] : null; },
      post: function (args, pre) { if (pre) mirroredRect(ed, pre[0], pre[1], args[0] != null ? args[0] : pre[0], args[1] != null ? args[1] : pre[1], (ed.brush | 0) + 3); } });
    wrap(ed, 'undo', { post: function () { markAll(); } });
    wrap(ed, 'redo', { post: function () { markAll(); } });
    wrap(G, 'load', { post: function () { markAll(); } });
    wrap(G, 'loadMap', { post: function () { markAll(); showOverlay(); } });
    wrap(G, 'setMode', { post: function () { showOverlay(); if (G.mode === 'edit') { maybeHint(); markAll(); } } });
    wrap(G, 'updateBrushRing', { post: function (args) { readout(args[0], args[1]); } });
  }

  /* ---- the page ---- */
  var CSS = [
    'body.ct118 #editorPanel .ed-tab[data-page="cover"] { position: relative; }',
    'body.ui117.u7e.ct118 #editorPanel .ed-tabs { grid-template-columns: repeat(5, 1fr); }',
    '#editorPanel .ed-tab[data-page="cover"]:not(.on) { box-shadow: inset 0 -2px 0 #d9b370; color: #f0e3bd; }',
    '#editorPanel .ed-tab[data-page="cover"].ct-pulse:not(.on) { animation: ct118pulse 1.3s ease-in-out infinite; }',
    '@keyframes ct118pulse { 0%,100% { background: rgba(217,179,112,0.10); } 50% { background: rgba(217,179,112,0.45); } }',
    '#ct118Hint { position: absolute; z-index: 40; left: 8px; right: 8px; padding: 8px 26px 8px 10px; border-radius: 3px; background: #d9b370; color: #14150f;',
    '  font: 600 11.5px/1.35 var(--u7-font, "Segoe UI", sans-serif); box-shadow: 0 4px 14px rgba(0,0,0,0.45); }',
    '#ct118Hint::before { content: ""; position: absolute; top: -6px; left: var(--ct-arrow, 50%); width: 10px; height: 10px; background: #d9b370; transform: rotate(45deg); }',
    '#ct118Hint b { font-weight: 800; } #ct118Hint i { position: absolute; right: 7px; top: 5px; font-style: normal; cursor: pointer; font-size: 13px; opacity: 0.7; }',
    '.ct-sec { margin: 9px 0 4px; font: 700 9.5px/1 var(--u7-font, "Segoe UI", sans-serif); letter-spacing: 1.3px; text-transform: uppercase; color: var(--u7-khaki, #d9b370); }',
    '.ct-card { display: grid; grid-template-columns: 64px 1fr; gap: 3px 8px; padding: 7px; margin: 2px 0 6px; border: 1px solid var(--u7-line, #2b3745); border-radius: 3px;',
    '  background: var(--u7-raise, rgba(255,255,255,0.04)); font: 11px/1.35 var(--u7-font, "Segoe UI", sans-serif); color: var(--u7-text, #cbd5e1); }',
    '.ct-card .ct-th { grid-row: 1 / span 3; width: 64px; height: 48px; border-radius: 2px; background-color: #222a33; background-repeat: no-repeat; }',
    '.ct-card .ct-nm { font-weight: 700; font-size: 12px; color: #fff; } .ct-card .ct-how { color: var(--u7-text, #cbd5e1); } .ct-card .ct-gv { color: var(--u7-khaki, #d9b370); }',
    '#coverTools .tool-btn { position: relative; } #coverTools .ct-badge { position: absolute; right: 2px; top: 2px; padding: 0 3px; border-radius: 2px; font: 700 9px/12px var(--u7-font, sans-serif);',
    '  background: rgba(0,0,0,0.6); color: #f0e3bd; pointer-events: none; } #coverTools .ct-badge.dug { background: #8e1f8e; color: #fff; }',
    '.ct-legend { display: flex; align-items: center; gap: 6px; margin: 4px 0 2px; font: 10px/1.2 var(--u7-font, sans-serif); color: var(--u7-dim, #8493a3); }',
    '.ct-legend .bar { flex: 1; height: 8px; border-radius: 2px; }',
    '.ct-legend.cover .bar { background: linear-gradient(90deg, #fff07a 0%, #fff07a 30%, #ff8c1f 55%, #e61f1f 85%, #e61f1f 94%, #f233f2 95%, #f233f2 100%); }',
    '.ct-legend > span { white-space: nowrap; } .ct-legend.conceal .lo::after { content: \'seen at full range\'; } .ct-legend.cover .lo::after { content: \'light\'; }',
    '.ct-legend.cover .hi::after { content: \'heavy · dug in\'; } .ct-legend.conceal .hi::after { content: \'hidden\'; } .ct-legend.off .lo::after { content: \'off\'; }',
    'body #editorPanel #ct118Rev > div { flex: 1 1 auto; font-size: 10px; letter-spacing: 0; padding-left: 2px; padding-right: 2px; }',
    '.ct-legend.conceal .bar { background: linear-gradient(90deg, #8cf2ff 0%, #338cff 50%, #7333f2 100%); }',
    '.ct-legend.off .bar { background: #333; }',
    '#ct118Here { min-height: 15px; margin: 2px 0 4px; font: 11px/1.35 var(--u7-font, sans-serif); color: var(--u7-text, #cbd5e1); }',
  ].join('\n');

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function build(G) {
    if (CT.built) return;
    var D = document, panel = D.getElementById('editorPanel'), tabs = panel && panel.querySelector('.ed-tabs'), body = panel && panel.querySelector('.ed-body');
    var propsTab = tabs && tabs.querySelector('.ed-tab[data-page="props"]');
    if (!propsTab || !body) return;
    var st = el('style'); st.id = 'ct118Css'; st.textContent = CSS; D.head.appendChild(st);
    var tab = el('div', 'ed-tab', 'Cover'); tab.dataset.page = 'cover'; tab.title = 'Trenches, foxholes, walls, hedges, plants and wire — everything that protects or hides a man';
    propsTab.insertAdjacentElement('afterend', tab);
    var pg = el('div', 'ed-page'); pg.dataset.page = 'cover';
    pg.innerHTML =
      '<div class="ct-card" id="ct118Card"><div class="ct-th"></div><div class="ct-nm">Pick a tool</div><div class="ct-how">Everything here protects or hides a man. Choose a tool, then click or drag on the map.</div><div class="ct-gv"></div></div>' +
      '<div class="ed-row"><label>Show</label><div class="ed-seg" id="ct118Show"><div data-v="off">Off</div><div data-v="cover" class="on">Cover</div><div data-v="conceal">Hiding</div></div></div>' +
      '<div class="ct-legend cover" id="ct118Legend"><span class="lo"></span><div class="bar"></div><span class="hi"></span></div>' +
      '<div id="ct118Here"></div>' +
      '<div class="ed-row"><label>Mode</label><div class="ed-seg" id="ct118Mode"><div data-mode="brush">Brush</div><div data-mode="line" class="on">Line</div><div data-mode="rect">Rect</div></div></div>' +
      '<div class="ed-row"><label>Trench</label><div class="ed-seg" id="ct118Rev"><div class="on" data-mode="auto">Auto</div><div data-mode="concrete">Concrete</div><div data-mode="wood">Wood</div><div data-mode="dirt">Dirt</div></div></div>' +
      '<div id="coverTools"></div>' +
      '<div class="ed-note">The numbers are the game\'s own: <b>cover</b> is the share of a hit it takes off (the most is ' + pct(coverMax()) + '); <b>hiding</b> is how much closer an enemy must come to see a man. Hatched cells are dug in. The old buttons are still in Props, Build and Grow.</div>';
    body.appendChild(pg);
    // tab switching, as the panel's own tabs do (theirs are bound per tab at start and look the pages up when clicked)
    tab.addEventListener('click', function () {
      [].forEach.call(D.querySelectorAll('.ed-tab'), function (t) { t.classList.toggle('on', t === tab); });
      [].forEach.call(D.querySelectorAll('.ed-page'), function (p) { p.classList.toggle('on', p.dataset.page === 'cover'); });
      opened(G);
    });
    // a pointer from Props to here
    var pp = body.querySelector('.ed-page[data-page="props"]');
    if (pp) { var nt = el('div', 'ed-note', '⛨ Trenches, walls, hedges and wire, with what each gives: <a href="#" id="ct118Go" style="color:var(--u7-khaki,#d9b370);font-weight:700">Cover tab</a>'); nt.id = 'ct118PropsNote'; pp.insertBefore(nt, pp.firstChild);
      nt.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); tab.click(); }); }
    // segs
    seg(pg.querySelector('#ct118Show'), function (d) { CT.setMode(d.v); });
    seg(pg.querySelector('#ct118Mode'), function (d) { setPropMode(G, d.mode); });
    seg(pg.querySelector('#ct118Rev'), function (d) { G.editor.trenchRev118 = d.mode; syncSeg('edTrenchRev118', 'mode', d.mode); });
    fillTools(G);
    CT.tab = tab; CT.page = pg; CT.built = true;
  }
  function unbuild() {
    ['ct118Css', 'ct118Hint', 'ct118PropsNote'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); });
    if (CT.page) { if (CT.page.classList.contains('on')) { var p = document.querySelector('.ed-tab[data-page="props"]'); if (p) p.click(); } CT.page.remove(); }
    if (CT.tab) CT.tab.remove();
    CT.tab = CT.page = null; CT.built = false; TH.done = false;
  }
  function seg(root, fn) {
    if (!root) return;
    [].forEach.call(root.children, function (b) { b.addEventListener('click', function () { [].forEach.call(root.children, function (x) { x.classList.toggle('on', x === b); }); fn(b.dataset); }); });
  }
  function syncSeg(id, key, v) { var r = document.getElementById(id); if (r) [].forEach.call(r.children, function (x) { x.classList.toggle('on', x.dataset[key] === v); }); }
  function setPropMode(G, m) { G.editor.propMode = m; syncSeg('edPropMode', 'mode', m); syncSeg('ct118Mode', 'mode', m); }

  var BY = {};
  function fillTools(G) {
    var root = document.getElementById('coverTools'); if (!root) return;
    root.innerHTML = ''; BY = {};
    tools(G).forEach(function (s) {
      root.appendChild(el('div', 'ct-sec', s.name));
      var grid = el('div', 'tool-grid');
      s.list.forEach(function (t) {
        var b = el('div', 'tool-btn');
        b.dataset.tool = t.tool; b.dataset.ct = t.key;
        var col = t.swatch || ('#' + (t.color || 0x555555).toString(16).padStart(6, '0'));
        b.innerHTML = '<div class="swatch" style="background:' + col + '"></div>' + t.label + (t.badge ? '<span class="ct-badge' + (t.dug ? ' dug' : '') + '">' + t.badge + '</span>' : '');
        b.title = t.label + '\n' + t.how + '\n' + t.gives;
        b.addEventListener('click', function () { pick(G, t, b); });
        b.addEventListener('mouseenter', function () { card(t); });
        b.addEventListener('mouseleave', function () { card(CT.sel || null); });
        grid.appendChild(b);
        BY[t.tool] = t;
      });
      root.appendChild(grid);
    });
  }
  function pick(G, t, b) {
    [].forEach.call(document.querySelectorAll('.tool-btn.selected'), function (x) { x.classList.remove('selected'); });
    b.classList.add('selected');
    G.editor.setTool(t.tool);
    if (t.kind === 'prop') setPropMode(G, t.line ? 'line' : 'brush');
    CT.sel = t; card(t);
    var nm = document.getElementById('edToolName');
    if (nm) nm.textContent = (t.kind === 'fol' ? '🌾 Sow ' : '⛨ ') + t.label + (t.line ? ' — drag a line' : t.kind === 'fol' ? ' — brush' : ' — click');
  }
  CT.pick = function (tool) { var G = window.game, t = BY[tool], b = CT.page && CT.page.querySelector('.tool-btn[data-tool="' + tool + '"]'); if (!t || !b) return false; pick(G, t, b); return true; };
  function card(t) {
    var c = document.getElementById('ct118Card'); if (!c) return;
    var th = c.querySelector('.ct-th');
    if (!t) { c.querySelector('.ct-nm').textContent = 'Pick a tool'; c.querySelector('.ct-how').textContent = 'Everything here protects or hides a man. Choose a tool, then click or drag on the map.'; c.querySelector('.ct-gv').textContent = ''; th.style.backgroundImage = ''; th.style.backgroundColor = '#222a33'; return; }
    c.querySelector('.ct-nm').textContent = t.label; c.querySelector('.ct-how').textContent = t.how; c.querySelector('.ct-gv').textContent = t.gives;
    var b = CT.page && CT.page.querySelector('.tool-btn[data-tool="' + t.tool + '"] .swatch');
    if (b) { th.style.backgroundImage = b.style.backgroundImage; th.style.backgroundSize = b.style.backgroundSize; th.style.backgroundPosition = b.style.backgroundPosition; th.style.backgroundColor = b.style.backgroundImage ? 'transparent' : b.style.backgroundColor; }
  }

  /* ---- thumbnails: the real prop, built on the FPS module's shadow layer (assets/editfps118.js), rendered once ---- */
  var TH = { done: false, url: '', idx: {}, cols: 6, rows: 1 };
  function thumbs(G) {
    if (TH.done) return applyThumbs();
    var F = G._ef8, R = G.renderer; if (!F || !F.buildProp || !R || G.editIcons118 === false) return;
    var ts = Object.keys(BY).filter(function (k) { return BY[k].kind === 'prop'; });
    if (!ts.length) return;
    TH.done = true;
    var t0 = performance.now(), W = 96, H = 72, cols = TH.cols, rows = TH.rows = Math.ceil(ts.length / cols);
    var cvs = document.createElement('canvas'); cvs.width = cols * W; cvs.height = rows * H; var c2 = cvs.getContext('2d');
    var rt = new THREE.WebGLRenderTarget(W * 2, H * 2); rt.texture.encoding = R.outputEncoding;
    var cam = new THREE.PerspectiveCamera(28, W / H, 0.01, 2000), sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xeef2f6, 0x4a4234, 1.0)); var sun = new THREE.DirectionalLight(0xfff1dc, 1.2); sun.position.set(3, 5, 2.5); sc.add(sun);
    var prevRT = R.getRenderTarget(), prevC = R.getClearColor(new THREE.Color()).clone(), prevA = R.getClearAlpha();
    var buf = new Uint8Array(W * H * 16), img = c2.createImageData(W, H), box = new THREE.Box3(), ctr = new THREE.Vector3(), size = new THREE.Vector3(), dir = new THREE.Vector3(1, 0.72, 1.35).normalize();
    try {
      ts.forEach(function (tool, i) {
        var key = BY[tool].key, grp = F.buildProp(key, 0); if (!grp) return;
        grp.position.set(0, 0, 0); sc.add(grp); grp.updateMatrixWorld(true);
        var parts = [];
        grp.traverse(function (m) { if (m.isMesh && m.visible !== false && m.geometry) { var bb = new THREE.Box3().setFromObject(m); if (!bb.isEmpty()) parts.push(bb); } });
        var sz = parts.map(function (bb) { return bb.getSize(new THREE.Vector3()).length(); }).sort(function (a, b) { return a - b; }), med = sz.length ? sz[sz.length >> 1] : 0;
        box.makeEmpty(); parts.forEach(function (bb) { if (!med || bb.getSize(new THREE.Vector3()).length() <= med * 5) box.union(bb); });
        if (box.isEmpty()) box.setFromObject(grp);
        box.getCenter(ctr); box.getSize(size);
        var r = Math.max(size.x, size.y * 1.15, size.z) * 0.6 || 1, d = r / Math.tan(cam.fov * Math.PI / 360) * 1.05;
        cam.position.copy(ctr).addScaledVector(dir, d); cam.near = d / 60; cam.far = d * 4; cam.lookAt(ctr); cam.updateProjectionMatrix();
        R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear(true, true, true); R.render(sc, cam);
        R.readRenderTargetPixels(rt, 0, 0, W * 2, H * 2, buf);
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var o = ((H - 1 - y) * W + x) * 4, s0 = ((y * 2) * W * 2 + x * 2) * 4, s1 = s0 + W * 8;
          for (var k = 0; k < 4; k++) img.data[o + k] = (buf[s0 + k] + buf[s0 + 4 + k] + buf[s1 + k] + buf[s1 + 4 + k]) >> 2;
        }
        c2.putImageData(img, (i % cols) * W, Math.floor(i / cols) * H);
        sc.remove(grp);
        TH.idx[tool] = i;
      });
    } catch (e) { CT.thumbErr = String(e && e.message || e); }
    R.setRenderTarget(prevRT); R.setClearColor(prevC, prevA); rt.dispose();
    TH.url = cvs.toDataURL('image/png'); TH.ms = performance.now() - t0; TH.n = Object.keys(TH.idx).length;
    applyThumbs();
  }
  function applyThumbs() {
    if (!TH.url || !CT.page) return;
    [].forEach.call(CT.page.querySelectorAll('#coverTools .tool-btn[data-tool]'), function (b) {
      var i = TH.idx[b.dataset.tool], sw = b.querySelector('.swatch');
      if (i == null || !sw || sw.classList.contains('u8-th')) return;
      sw.classList.add('u8-th');
      sw.style.backgroundColor = 'transparent'; sw.style.backgroundImage = 'url(' + TH.url + ')';
      sw.style.backgroundSize = (TH.cols * 100) + '% ' + (TH.rows * 100) + '%';
      sw.style.backgroundPosition = (TH.cols > 1 ? (i % TH.cols) / (TH.cols - 1) * 100 : 0) + '% ' + (TH.rows > 1 ? Math.floor(i / TH.cols) / (TH.rows - 1) * 100 : 0) + '%';
    });
  }
  CT.TH = TH; CT.thumbs = function () { thumbs(window.game); };

  /* ---- opening the tab, the readout under the cursor, and the first-open hint ---- */
  function opened(G) {
    seenHint();
    if (!CT._opened) { CT._opened = true; if (CT.mode === 'off') CT.setMode('cover'); }
    setTimeout(function () {
      try { thumbs(G); } catch (e) { CT.thumbErr = String(e && e.message || e); }
      if (G._ef8 && G._ef8.fitLabels) G._ef8.fitLabels();
      if (!CT.sel) { var first = CT.page && CT.page.querySelector('#coverTools .tool-btn'); if (first && G.editor.tool !== first.dataset.tool) CT.pick(first.dataset.tool); }
      if (CT.mode !== 'off') showOverlay();
      markAllOnce();
    }, 0);
  }
  var everFull = false;
  function markAllOnce() { if (!everFull) { everFull = true; markAll(); } }
  function readout(gx, gz) {
    var e = document.getElementById('ct118Here'); if (!e || !CT.page || !CT.page.classList.contains('on')) return;
    var G = window.game, inG = T('inGrid');
    if (!G || G.mode !== 'edit') return;   // the editor only
    if (gx == null || (inG && !inG(gx, gz))) { e.textContent = ''; return; }
    var v = cellValues(G, ghost(G), gx, gz);
    e.innerHTML = 'Here: <b>cover ' + pct(v[0]) + '</b>' + (v[2] ? ' (dug in)' : '') + ' · <b>seen at ' + pct(1 - v[1]) + '%</b> of range';
  }
  function maybeHint() {
    var G = window.game; if (!CT.on || !CT.tab || G.mode !== 'edit' || document.getElementById('ct118Hint')) return;
    var seen = false; try { seen = localStorage.getItem(CT.hintKey) === '1'; } catch (e) { seen = false; }
    if (seen || CT._hintDone) return;
    var panel = document.getElementById('editorPanel'); if (!panel) return;
    var h = el('div', '', '<b>Trenches are in the new Cover tab</b> (top row, beside Props): every trench, foxhole, wall, hedge, plant and wire, with what each gives, and Show cover to tint the ground with it. <u>Open it</u><i title="Close">✕</i>');
    h.id = 'ct118Hint';
    var tabs = panel.querySelector('.ed-tabs'), pr = panel.getBoundingClientRect(), tr = CT.tab.getBoundingClientRect(), br = tabs.getBoundingClientRect();
    h.style.top = (br.bottom - pr.top + 7) + 'px';
    h.style.setProperty('--ct-arrow', Math.max(8, tr.left - pr.left + tr.width / 2 - 13) + 'px');
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    panel.appendChild(h);
    CT.tab.classList.add('ct-pulse');
    h.querySelector('i').addEventListener('click', function (ev) { ev.stopPropagation(); seenHint(); });
    h.addEventListener('click', function () { CT.tab.click(); });
  }
  function seenHint() {
    CT._hintDone = true;
    try { localStorage.setItem(CT.hintKey, '1'); } catch (e) { /* private window: shown again next time */ }
    var h = document.getElementById('ct118Hint'); if (h) h.remove();
    if (CT.tab) CT.tab.classList.remove('ct-pulse');
  }
  CT.maybeHint = maybeHint;

  /* ---- the switch ---- */
  function set(v) {
    var G = window.game; v = !!v;
    if (v === CT.on && (!v || CT.built)) return;
    CT.on = v;
    if (v) {
      build(G); if (!CT.built) { CT.on = false; return; }
      document.body.classList.add('ct118');
      hookEdits(G);
      everFull = false;
      showOverlay();
      maybeHint();
    } else {
      unwrapAll(); unbuild(); document.body.classList.remove('ct118');
      if (O.job) { clearTimeout(O.job); O.job = null; }
      if (O.mesh) { if (O.mesh.parent) O.mesh.parent.remove(O.mesh); O.mesh.visible = false; }
    }
  }
  window.coverTab118Install = function () {
    var G = window.game; if (!G || !G.editor || G._ct118) return;
    G._ct118 = CT;
    var init = G.coverTab118 != null ? G.coverTab118 === true : CT.DEFAULT;
    Object.defineProperty(G, 'coverTab118', { configurable: true, enumerable: true, get: function () { return CT.on; }, set: set });
    if (init) set(true);
  };
})();
