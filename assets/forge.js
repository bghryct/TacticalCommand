/* ===========================================================================
 * THE FORGE — the content editor  (FORGE_PLAN.md Phase 1–3 + 7)
 * ---------------------------------------------------------------------------
 * A third mode inside the game (`Play · Edit · Forge`) where the player builds
 * units, props and terrain surfaces. It lives in the game page rather than in
 * `editor.html` for one reason above all others: a rig editor is worthless
 * without live animation preview, and the only place the real skeletons, the
 * real pose engine, the real lights and the real materials exist is here.
 *
 * Two rules shape the whole file:
 *
 *   1. EVERY EDITOR ACTION IS A CALLABLE METHOD. `Forge.addPart({…})`,
 *      `Forge.setMat('p3','iron')`, `Forge.mirror('p3', true)`. The DOM is a
 *      thin shell over that API. `handoff.md` warns that the browser pane
 *      synthesises phantom clicks and drags, so driving the API from a script
 *      is the only reliable way to verify this tool — and it keeps the UI
 *      honest, because anything the UI can do, a test can do.
 *
 *   2. NOTHING HERE MAY BREAK A BATTLE. Registration goes through
 *      `TCM.validate`, a bad document renders a magenta placeholder, and the
 *      game boots normally if this file is missing entirely.
 *
 * The model runtime it drives is `assets/tcm.js` (`window.TCM`) — schema,
 * validation, and the build into the `MODEL_BUILDERS` contract. This file owns
 * the authoring: documents, library, viewport, tools, panels, publishing.
 * ======================================================================== */
(function () {
  'use strict';

  var VERSION = 1;
  var LS_KEY = 'tc_forge';

  var THREE = null;
  var G = null;            // injected game internals (see install)
  var TCM = null;

  // ---- editor state -------------------------------------------------------
  var S = {
    lib: { v: VERSION, assets: {} },   // the whole library, mirrored to localStorage
    id: null,                // id of the asset being edited
    kind: 'unit',            // unit | prop | terrain | part
    doc: null,               // the TCM model document (null for terrain)
    meta: null,              // the unit / prop / terrain document
    sel: [],                 // selected part ids
    selBone: null,           // selected bone (rig tab)
    tab: 'build',
    pose: 'stand',
    playing: true,
    gait: 0,
    team: 1,
    dummy: false,            // a target dummy, so aim tracking is visible
    showGrid: true,
    showBones: false,
    showGhost: false,
    ghostKey: 'usrifle',
    snap: 0.01,              // position grid snap (world units)
    angSnap: 15,             // rotation snap (degrees)
    dirty: false,
    hist: [], histAt: -1,
    clock: 0,
    turntable: 0,
    spin: false,
    msg: '',
  };

  var el = {};             // DOM handles
  var view = null;         // { scene, camera, root, grid, mirror, ghost, bones, gizmo }
  var built = null;        // last TCM.buildModel result
  var fake = null;         // the stand-in unit the pose engine drives
  // The pose engine's whole world: it reads `game.time` for breathing and the
  // head scan, `game.fpv` to know whether a player is looking through this
  // unit's eyes, and `game.vmMount` to know whether the weapon has been handed
  // to a first-person viewmodel. Nothing else. Built up front, because a fake
  // unit with a null game throws on the first frame.
  var stubGame = { time: 0, fpv: null, vmMount: null };

  function install(api) {
    G = api;
    THREE = api.THREE || window.THREE;
    TCM = window.TCM;
    loadLib();
    seedLibrary();
    buildDom();
    buildView();
    bindKeys();
    return true;
  }

  // =======================================================================
  // Library — one asset per entry, mirrored to localStorage
  // =======================================================================
  //
  // An asset is self-contained so export/import is a copy:
  //   { kind:'unit',    id, name, model:<TCM>, unit:<TCU>, pub:bool }
  //   { kind:'prop',    id, name, model:<TCM>, prop:<TCP>, pub:bool }
  //   { kind:'terrain', id, name, terrain:<TCT>,           pub:bool }
  //   { kind:'part',    id, name, model:<TCM> }             — the parts library
  //
  // `pub` is what the game reads at boot. Editing an asset never changes the
  // live battle until it is published, so a half-finished unit can't wander
  // into a scenario.

  function loadLib() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.assets) S.lib = d;
      }
    } catch (e) { warn('library load failed: ' + e.message); }
    if (!S.lib.assets) S.lib.assets = {};
    S.lib.v = VERSION;
  }

  function saveLib() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S.lib));
      S.dirty = false;
      return true;
    } catch (e) {
      // localStorage is ~5 MB and a 150-part model is 15–25 KB, so this only
      // fires on a genuinely huge library — say so plainly and offer the exit.
      toast('Storage full — export a pack and delete some assets. (' + e.name + ')', true);
      return false;
    }
  }

  function usage() {
    var bytes = 0;
    try { bytes = (localStorage.getItem(LS_KEY) || '').length; } catch (e) {}
    return { bytes: bytes, kb: Math.round(bytes / 102.4) / 10, assets: Object.keys(S.lib.assets).length };
  }

  /** The stock parts library and the forkable templates ship in the box. With
   *  no mesh import, an empty viewport with no way in is where this tool would
   *  die (FORGE_PLAN §4.9) — so real, fully editable content is a deliverable,
   *  not a nicety. Only ever ADDS: a player edit to a stock asset survives. */
  function seedLibrary() {
    var A = S.lib.assets;
    for (var i = 0; i < GREEBLES.length; i++) {
      var g = GREEBLES[i];
      if (!A[g.id]) A[g.id] = { kind: 'part', id: g.id, name: g.name, stock: true, model: g.model };
    }
    for (var t = 0; t < TEMPLATES.length; t++) {
      var a = TEMPLATES[t];
      // Refresh a shipped template unless the player has actually edited it —
      // so a later fix to the stock content lands, and a player's own changes
      // to it never do get clobbered. Fork to keep a copy that can't move.
      if (!A[a.id] || (A[a.id].stock && !A[a.id].edited)) {
        var wasPub = A[a.id] && A[a.id].pub;
        A[a.id] = clone(a);
        if (wasPub) A[a.id].pub = true;
      }
    }
    // Parts must be registered before anything can `ref` them.
    for (var k in A) if (A[k].model) TCM.registerModel(A[k].model);
    saveLib();
  }

  // =======================================================================
  // Document helpers
  // =======================================================================

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function warn(m) { if (window.console) console.warn('[Forge] ' + m); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function slug(s) {
    return String(s || 'thing').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 40) || 'thing';
  }
  function freeId(base) {
    var id = slug(base), n = 2;
    while (S.lib.assets[id]) id = slug(base) + '-' + (n++);
    return id;
  }
  function freePartId(doc) {
    var used = {}, i = 1;
    (doc.parts || []).forEach(function (p) { used[p.id] = 1; });
    while (used['p' + i]) i++;
    return 'p' + i;
  }
  function part(id) {
    var ps = (S.doc && S.doc.parts) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }
  function partIndex(id) {
    var ps = (S.doc && S.doc.parts) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return i;
    return -1;
  }
  function bone(id) {
    var bs = (S.doc && S.doc.bones) || [];
    for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return bs[i];
    return null;
  }
  function mat(id) {
    var ms = (S.doc && S.doc.palette) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
    return null;
  }
  /** Every joint the current document can hang a part on: the skeleton's own
   *  plus any custom bones. */
  function joints() {
    var out = (TCM.JOINTS[(S.doc && S.doc.skeleton) || 'static'] || ['body']).slice();
    ((S.doc && S.doc.bones) || []).forEach(function (b) { if (b.id) out.push(b.id); });
    return out;
  }

  /** Sensible starting dimensions per shape, so "add a cylinder" gives you a
   *  cylinder you can see rather than a zero-size nothing. */
  var SHAPE_DIMS = {
    box: { w: 0.2, h: 0.2, l: 0.2 },
    cyl: { r: 0.08, h: 0.24, seg: 10 },
    cone: { r: 0.1, h: 0.24, seg: 10 },
    sph: { r: 0.12, ws: 10, hs: 8 },
    torus: { r: 0.12, r2: 0.03, rs: 6, ts: 12 },
    wedge: { w: 0.2, h: 0.16, l: 0.28 },
    prism: { w: 0.3, h: 0.2, l: 0.5, seg: 4 },
    trapezoid: { w: 0.24, h: 0.2, l: 0.24, tw: 0.14, tl: 0.16 },
    plate: { w: 0.2, h: 0.2 },
    extrude: { outline: [[-0.12, -0.1], [0.12, -0.1], [0.16, 0.06], [0, 0.16], [-0.16, 0.06]], depth: 0.08, bevel: 0.008, taper: 1 },
    lathe: { profile: [[0.02, -0.14], [0.12, -0.09], [0.14, 0.03], [0.08, 0.12], [0, 0.15]], seg: 12 },
    tube: { path: [[0, 0, -0.18], [0, 0.06, 0], [0, 0, 0.18]], r: 0.025, seg: 10, rseg: 6 },
    decal: { w: 0.14, h: 0.14, sym: 'star', c: '#ffffff' },
    node: {},
    ref: {},
  };
  /** Which numeric fields the inspector shows for a shape. */
  var SHAPE_FIELDS = {
    box: ['w', 'h', 'l'], plate: ['w', 'h'],
    cyl: ['r', 'r1', 'r2', 'h', 'seg'], cone: ['r', 'h', 'seg'],
    sph: ['r', 'ws', 'hs'], torus: ['r', 'r2', 'rs', 'ts', 'arc'],
    wedge: ['w', 'h', 'l'], prism: ['w', 'h', 'l', 'seg'],
    trapezoid: ['w', 'h', 'l', 'tw', 'tl'],
    extrude: ['depth', 'bevel', 'bevelSeg', 'taper', 'curveSeg'],
    lathe: ['seg', 'arc'], tube: ['r', 'seg', 'rseg'],
    decal: ['w', 'h'], node: [], ref: [],
  };

  var POSES = ['stand', 'aim', 'walk', 'run', 'sneak', 'crouch', 'kneel',
               'prone', 'crawl', 'dig', 'throw', 'down'];
  var DRIVER_KINDS = ['spin', 'sway', 'bob', 'recoil', 'jet', 'open'];
  var DRIVER_WHEN = ['', 'moving', 'firing', 'airborne', 'dead'];
  var ROLES = ['lineInfantry', 'assault', 'skirmisher', 'marksman', 'weaponsTeam',
               'atTeam', 'armour', 'tankDestroyer', 'artillery', 'transport',
               'walker', 'flyer', 'commander', 'engineer', 'medic'];
  var UNIT_FLAGS = ['vehicle', 'hover', 'walker', 'jetpack', 'lightArmor', 'openTop',
                    'noTurret', 'mgOnly', 'mg', 'heavyMg', 'melee', 'grenade', 'smoke',
                    'lowProfile', 'floats', 'auto', 'burstAuto', 'fpvClear', 'aoe'];

  // =======================================================================
  // History — whole-document snapshots
  // =======================================================================
  //
  // A model is 10–25 KB, so a 60-deep stack of full snapshots costs about a
  // megabyte of RAM and buys an undo that is byte-identical by construction.
  // Diffing would be cleverer and would have edge cases; this has none.

  function pushHist(label) {
    var snap = JSON.stringify({ doc: S.doc, meta: S.meta, sel: S.sel });
    if (S.hist[S.histAt] === snap) return;
    S.hist.length = S.histAt + 1;
    S.hist.push(snap);
    if (S.hist.length > 60) S.hist.shift();
    S.histAt = S.hist.length - 1;
    S.dirty = true;
    S.msg = label || '';
  }

  function applyHist(i) {
    if (i < 0 || i >= S.hist.length) return false;
    var st = JSON.parse(S.hist[i]);
    S.histAt = i;
    S.doc = st.doc; S.meta = st.meta; S.sel = st.sel || [];
    stash();
    rebuild();
    renderAll();
    return true;
  }

  function undo() { return applyHist(S.histAt - 1); }
  function redo() { return applyHist(S.histAt + 1); }

  /** Write the working documents back into the library entry. Called after
   *  every mutation, so closing the tab never loses more than the last edit. */
  function stash() {
    if (!S.id) return;
    var a = S.lib.assets[S.id];
    if (!a) return;
    if (S.histAt > 0) a.edited = true;      // stops seedLibrary refreshing over it
    if (S.doc) a.model = S.doc;
    if (S.meta) a[S.kind] = S.meta;   // 'unit' | 'prop' | 'terrain' | 'roster' | 'faction'
    a.name = (S.meta && S.meta.name) || (S.doc && S.doc.name) || a.name;
    saveLib();
  }

  /** One mutation: snapshot, change, rebuild, redraw. Every public mutator
   *  funnels through here so undo, autosave and the live preview can never
   *  disagree about what the document is. */
  function edit(label, fn) {
    // Some asset kinds have no model at all — a surface, an army list, a
    // faction. An edit needs *something* to edit, not specifically a model.
    if (!S.doc && !S.meta) return false;
    var r = fn();
    if (r === false) return false;
    pushHist(label);
    stash();
    rebuild();
    renderAll();
    return true;
  }

  // =======================================================================
  // CONTENT THAT SHIPS IN THE BOX
  // =======================================================================
  //
  // With no mesh import, reuse is the player's whole economy of effort
  // (FORGE_PLAN §4.4). These two tables are the leverage: a greeble library to
  // `ref` into any model, and complete forkable units so nothing is a black box.
  //
  // Coordinates are in the stock rigs' local joint space, which is worth
  // writing down because everything here depends on it:
  //   humanoid — hips y0.52, spine y+0.03, chest y+0.33, yoke y+0.5,
  //              neck y+0.55, head y+0.16 (skull r0.135), aim (0.02,0.36,0.1),
  //              armL/R x±0.245 y0.5.  A soldier is ~1.4 units tall.
  //   suit     — hips y1.3, torso y+0.3, head y+0.5 z+0.05, pack y+0.05 z−0.48,
  //              legL/R x±0.34, knee y−0.58, foot y−0.6, shL/R x±0.58 y+0.16.
  //   hull     — deck y0.7, turret y1.0, gun y+0.2 (in turret space).

  var GREEBLES = [
    { id: 'gr-vent', name: 'Vent Grille', model: {
      v: 1, kind: 'model', id: 'gr-vent', name: 'Vent Grille', skeleton: 'static',
      palette: [{ id: 'iron', c: '#3a3a34', rough: 0.6, metal: 0.4 }, { id: 'shade', c: '#1a1a16', rough: 0.9 }],
      parts: [
        { id: 'p1', n: 'frame', j: 'body', sh: 'box', m: 'iron', p: [0, 0, 0], d: { w: 0.26, h: 0.2, l: 0.03 } },
        { id: 'p2', n: 'slats', j: 'body', sh: 'box', m: 'shade', p: [0, -0.07, 0.022],
          d: { w: 0.22, h: 0.018, l: 0.02 }, mod: { array: { n: 5, step: [0, 0.035, 0] } } },
      ] } },
    { id: 'gr-coil', name: 'Coil Ring', model: {
      v: 1, kind: 'model', id: 'gr-coil', name: 'Coil Ring', skeleton: 'static',
      palette: [{ id: 'iron', c: '#41413a', rough: 0.5, metal: 0.6 }, { id: 'cu', c: '#8a5a2a', rough: 0.4, metal: 0.7 }],
      parts: [
        { id: 'p1', n: 'ring', j: 'body', sh: 'torus', m: 'cu', p: [0, 0, 0], r: [1.5708, 0, 0], d: { r: 0.13, r2: 0.022, rs: 6, ts: 14 } },
        { id: 'p2', n: 'clamps', j: 'body', sh: 'box', m: 'iron', d: { w: 0.03, h: 0.05, l: 0.06 },
          mod: { radial: { n: 6, r: 0.13, axis: 'z' } } },
      ] } },
    { id: 'gr-exhaust', name: 'Exhaust Stack', model: {
      v: 1, kind: 'model', id: 'gr-exhaust', name: 'Exhaust Stack', skeleton: 'static',
      palette: [{ id: 'soot', c: '#2b2823', rough: 0.95 }, { id: 'iron', c: '#4a453c', rough: 0.6, metal: 0.4 }],
      parts: [
        { id: 'p1', n: 'pipe', j: 'body', sh: 'cyl', m: 'iron', p: [0, 0.1, 0], d: { r: 0.05, h: 0.22, seg: 8 } },
        { id: 'p2', n: 'mouth', j: 'body', sh: 'cyl', m: 'soot', p: [0, 0.23, 0], d: { r1: 0.07, r2: 0.055, h: 0.05, seg: 8 } },
        { id: 'p3', n: 'collar', j: 'body', sh: 'cyl', m: 'iron', p: [0, 0.02, 0], d: { r: 0.065, h: 0.03, seg: 8 } },
      ] } },
    { id: 'gr-spikes', name: 'Spike Row', model: {
      v: 1, kind: 'model', id: 'gr-spikes', name: 'Spike Row', skeleton: 'static',
      palette: [{ id: 'iron', c: '#4e4a42', rough: 0.55, metal: 0.5 }],
      parts: [
        { id: 'p1', n: 'spikes', j: 'body', sh: 'cone', m: 'iron', p: [-0.14, 0, 0], d: { r: 0.026, h: 0.14, seg: 5 },
          mod: { array: { n: 5, step: [0.07, 0, 0], rstep: [0, 0, 0.06] } } },
      ] } },
    { id: 'gr-rivets', name: 'Rivet Strip', model: {
      v: 1, kind: 'model', id: 'gr-rivets', name: 'Rivet Strip', skeleton: 'static',
      palette: [{ id: 'iron', c: '#55504a', rough: 0.45, metal: 0.65 }],
      parts: [
        { id: 'p1', n: 'rivets', j: 'body', sh: 'sph', m: 'iron', p: [-0.12, 0, 0], d: { r: 0.016, ws: 6, hs: 5 },
          mod: { array: { n: 7, step: [0.04, 0, 0] } } },
      ] } },
    { id: 'gr-antenna', name: 'Antenna', model: {
      v: 1, kind: 'model', id: 'gr-antenna', name: 'Antenna', skeleton: 'static',
      palette: [{ id: 'iron', c: '#3d3a33', rough: 0.6, metal: 0.4 }, { id: 'tip', c: '#c04a2a', rough: 0.8 }],
      parts: [
        { id: 'p1', n: 'mast', j: 'body', sh: 'cyl', m: 'iron', p: [0, 0.2, 0], d: { r: 0.008, h: 0.4, seg: 5 } },
        { id: 'p2', n: 'base', j: 'body', sh: 'cyl', m: 'iron', p: [0, 0.02, 0], d: { r: 0.026, h: 0.04, seg: 7 } },
        { id: 'p3', n: 'tip', j: 'body', sh: 'sph', m: 'tip', p: [0, 0.41, 0], d: { r: 0.017, ws: 6, hs: 5 } },
      ] } },
    { id: 'gr-ammo', name: 'Ammo Box', model: {
      v: 1, kind: 'model', id: 'gr-ammo', name: 'Ammo Box', skeleton: 'static',
      palette: [{ id: 'olive', c: '#5a6136', rough: 0.9 }, { id: 'brass', c: '#8a6a30', rough: 0.4, metal: 0.7 }],
      parts: [
        { id: 'p1', n: 'box', j: 'body', sh: 'box', m: 'olive', p: [0, 0.06, 0], d: { w: 0.22, h: 0.12, l: 0.14 } },
        { id: 'p2', n: 'lid', j: 'body', sh: 'box', m: 'olive', p: [0, 0.13, 0], d: { w: 0.23, h: 0.02, l: 0.15 } },
        { id: 'p3', n: 'belt', j: 'body', sh: 'box', m: 'brass', p: [0.11, 0.05, 0.05], r: [0, 0, 0.3],
          d: { w: 0.03, h: 0.02, l: 0.05 }, mod: { array: { n: 5, step: [0.028, -0.012, 0] } } },
      ] } },
    { id: 'gr-sandbag', name: 'Sandbag Stack', model: {
      v: 1, kind: 'model', id: 'gr-sandbag', name: 'Sandbag Stack', skeleton: 'static',
      palette: [{ id: 'hess', c: '#9a8a5e', rough: 1 }, { id: 'hess2', c: '#8a7a50', rough: 1 }],
      parts: [
        { id: 'p1', n: 'lower', j: 'body', sh: 'sph', m: 'hess', p: [-0.16, 0.08, 0], s: [1.4, 0.5, 1],
          d: { r: 0.12, ws: 7, hs: 5 }, mod: { array: { n: 3, step: [0.16, 0, 0] } } },
        { id: 'p2', n: 'upper', j: 'body', sh: 'sph', m: 'hess2', p: [-0.08, 0.19, 0], s: [1.4, 0.5, 1],
          d: { r: 0.12, ws: 7, hs: 5 }, mod: { array: { n: 2, step: [0.16, 0, 0] } } },
      ] } },
  ];

  // ---- forkable templates -------------------------------------------------

  var TEMPLATES = [
    // ---------------------------------------------------------------- trooper
    // The gentle way in: keep the stock infantry body (uniform, boots, hands,
    // webbing) and armour it. Nine parts and it reads as a real unit.
    { kind: 'unit', id: 'tmpl-trooper', name: 'Forge Trooper', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-trooper', name: 'Forge Trooper',
        skeleton: 'humanoid', scale: 1, weather: 0.12,
        proportions: { uniformC: '#4d5238', skinC: '#bfa07e', helmet: 'none', webbing: 'us', pack: false, gearC: '#3a3a30' },
        palette: [
          { id: 'armour', c: '#4a5136', rough: 0.78 },
          { id: 'dark', c: '#2b3122', rough: 0.9 },
          { id: 'steel', c: '#3b3b34', rough: 0.5, metal: 0.55 },
          { id: 'visor', c: '#8fd8ff', glow: true },
          { id: 'flash', c: '#ffffff', team: true },
        ],
        parts: [
          { id: 'p1', n: 'helmet', j: 'head', sh: 'sph', m: 'armour', p: [0, 0.05, 0], s: [1.06, 0.82, 1.12], d: { r: 0.17, ws: 12, hs: 9 }, edge: true },
          { id: 'p2', n: 'brim', j: 'head', sh: 'cyl', m: 'armour', p: [0, -0.02, 0], d: { r1: 0.19, r2: 0.175, h: 0.03, seg: 14 } },
          { id: 'p3', n: 'visor', j: 'head', sh: 'box', m: 'visor', p: [0, 0.015, 0.115], d: { w: 0.2, h: 0.05, l: 0.04 } },
          { id: 'p4', n: 'rebreather', j: 'head', sh: 'trapezoid', m: 'steel', p: [0, -0.075, 0.095], d: { w: 0.12, h: 0.07, l: 0.07, tw: 0.09, tl: 0.05 } },
          { id: 'p5', n: 'cuirass', j: 'spine', sh: 'box', m: 'armour', p: [0, 0.33, 0.01], d: { w: 0.47, h: 0.3, l: 0.32 }, edge: true },
          { id: 'p6', n: 'gorget', j: 'spine', sh: 'trapezoid', m: 'steel', p: [0, 0.53, 0.02], d: { w: 0.3, h: 0.09, l: 0.26, tw: 0.22, tl: 0.2 } },
          { id: 'p7', n: 'pauldron', j: 'armL', sh: 'trapezoid', m: 'armour', p: [-0.055, 0.03, 0], mirror: true, edge: true,
            d: { w: 0.19, h: 0.14, l: 0.25, tw: 0.15, tl: 0.19 } },
          { id: 'p8', n: 'pack', j: 'spine', sh: 'box', m: 'dark', p: [0, 0.32, -0.24], d: { w: 0.3, h: 0.26, l: 0.16 } },
          { id: 'p9', n: 'thigh plate', j: 'legL', sh: 'box', m: 'armour', p: [0, -0.17, 0.03], mirror: true, d: { w: 0.17, h: 0.24, l: 0.19 } },
          { id: 'p10', n: 'rifle body', j: 'aim', sh: 'box', m: 'dark', p: [0, 0, 0.26], d: { w: 0.055, h: 0.075, l: 0.48 } },
          { id: 'p11', n: 'receiver', j: 'aim', sh: 'trapezoid', m: 'steel', p: [0, 0.035, 0.07], d: { w: 0.07, h: 0.07, l: 0.2, tw: 0.05, tl: 0.15 } },
          { id: 'p12', n: 'barrel', j: 'aim', sh: 'cyl', m: 'steel', p: [0, 0, 0.54], r: [1.5708, 0, 0], d: { r: 0.02, h: 0.14, seg: 7 } },
          { id: 'p13', n: 'sight', j: 'aim', sh: 'box', m: 'steel', p: [0, 0.062, 0.2], d: { w: 0.02, h: 0.045, l: 0.07 } },
          { id: 'p14', n: 'muzzle', j: 'aim', sh: 'node', p: [0, 0, 0.62], tags: ['muzzle'] },
          { id: 'p15', n: 'side flash', j: 'spine', sh: 'decal', m: 'flash', p: [0.15, 0.36, 0.172], d: { w: 0.12, h: 0.12, sym: 'lozenge', c: '#e8e8e8' } },
        ],
        attach: { muzzle: 'p14', barrelTip: 'p14' },
        flags: {},
        fpv: { hip: [-0.21, -0.2, 0.4], ads: [0.012, -0.052, 0.26], scale: 0.82 },
      },
      unit: {
        v: 1, kind: 'unit', id: 'tmpl-trooper', name: 'Forge Trooper', model: 'tcm:tmpl-trooper',
        faction: 'custom', role: 'lineInfantry', unitKind: 'rifle',
        hp: 105, spd: 4.4, dmg: 21, rng: 46, atkTime: 1.1, armor: 0.12, shield: 0,
        size: 1, vis: 42, color: '#4a5136',
      } },

    // ---------------------------------------------------------------- warhost
    // The other extreme on the same skeleton: strip the stock body entirely and
    // rebuild it. Proves that a hunched, slab-shouldered, ape-armed thing can
    // ride the human animator and still walk, aim, flinch and die correctly.
    { kind: 'unit', id: 'tmpl-warhost', name: 'Warhost Brute', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-warhost', name: 'Warhost Brute',
        skeleton: 'humanoid', scale: 1.12, weather: 0.24,
        proportions: { hunch: 0.4, bulk: 1.2, tall: 0.96, armLen: 1.16, legLen: 0.86,
          uniformC: '#3f4a2c', skinC: '#6d8a4a', helmet: 'none', webbing: 'none', pack: false, stripBody: true },
        palette: [
          { id: 'hide', c: '#6d8a4a', rough: 0.95 },
          { id: 'plate', c: '#3a3f2e', rough: 0.85 },
          { id: 'iron', c: '#4a453c', rough: 0.5, metal: 0.55 },
          { id: 'eye', c: '#ffd24a', glow: true },
          { id: 'clan', c: '#ffffff', team: true },
        ],
        parts: [
          { id: 'p1', n: 'chest', j: 'spine', sh: 'trapezoid', m: 'hide', p: [0, 0.32, 0], d: { w: 0.56, h: 0.4, l: 0.36, tw: 0.46, tl: 0.3 } },
          { id: 'p2', n: 'gut', j: 'spine', sh: 'box', m: 'hide', p: [0, 0.06, 0.02], d: { w: 0.44, h: 0.24, l: 0.32 } },
          { id: 'p3', n: 'seat', j: 'hips', sh: 'box', m: 'hide', p: [0, -0.04, -0.02], d: { w: 0.38, h: 0.18, l: 0.28 } },
          { id: 'p4', n: 'back slab', j: 'spine', sh: 'extrude', m: 'plate', p: [0, 0.34, -0.2], r: [0, 3.1416, 0], edge: true,
            d: { outline: [[-0.18, -0.16], [0.18, -0.16], [0.22, 0.08], [0.1, 0.2], [-0.1, 0.2], [-0.22, 0.08]], depth: 0.06, bevel: 0.008 } },
          { id: 'p5', n: 'pauldron', j: 'armL', sh: 'extrude', m: 'plate', p: [-0.05, 0.07, 0], r: [0, 1.5708, 0], mirror: true, edge: true,
            d: { outline: [[-0.11, -0.1], [0.11, -0.11], [0.14, 0.04], [0, 0.14], [-0.14, 0.04]], depth: 0.16, bevel: 0.01, taper: 0.85 } },
          { id: 'p6', n: 'upper arm', j: 'armL', sh: 'cyl', m: 'hide', p: [-0.02, -0.11, 0], mirror: true, d: { r: 0.095, h: 0.3, seg: 8 } },
          { id: 'p7', n: 'forearm', j: 'elbowL', sh: 'cyl', m: 'hide', p: [0, -0.11, 0], mirror: true, d: { r: 0.085, h: 0.28, seg: 8 } },
          { id: 'p8', n: 'fist', j: 'handL', sh: 'sph', m: 'hide', p: [0, -0.02, 0], mirror: true, d: { r: 0.085, ws: 8, hs: 6 } },
          { id: 'p9', n: 'vambrace', j: 'elbowL', sh: 'cyl', m: 'iron', p: [0, -0.19, 0], mirror: true, d: { r: 0.1, h: 0.1, seg: 8 } },
          { id: 'p10', n: 'thigh', j: 'legL', sh: 'cyl', m: 'hide', p: [0, -0.15, 0], mirror: true, d: { r: 0.105, h: 0.32, seg: 8 } },
          { id: 'p11', n: 'shin', j: 'kneeL', sh: 'cyl', m: 'hide', p: [0, -0.14, 0], mirror: true, d: { r: 0.09, h: 0.28, seg: 8 } },
          { id: 'p12', n: 'boot', j: 'bootL', sh: 'box', m: 'plate', p: [0, -0.02, 0.05], mirror: true, d: { w: 0.17, h: 0.11, l: 0.28 } },
          { id: 'p13', n: 'skull', j: 'head', sh: 'sph', m: 'hide', p: [0, 0.01, 0], s: [1, 0.95, 1.05], d: { r: 0.15, ws: 10, hs: 8 } },
          { id: 'p14', n: 'jaw', j: 'head', sh: 'trapezoid', m: 'hide', p: [0, -0.08, 0.06], d: { w: 0.18, h: 0.11, l: 0.15, tw: 0.14, tl: 0.11 } },
          { id: 'p15', n: 'tusk', j: 'head', sh: 'cone', m: 'iron', p: [0.055, -0.05, 0.105], r: [-0.6, 0, 0.1], mirror: true, d: { r: 0.022, h: 0.11, seg: 5 } },
          { id: 'p16', n: 'eye', j: 'head', sh: 'sph', m: 'eye', p: [0.055, 0.025, 0.115], mirror: true, d: { r: 0.022, ws: 6, hs: 5 } },
          { id: 'p17', n: 'helm plate', j: 'head', sh: 'extrude', m: 'iron', p: [0, 0.1, 0.02], r: [1.4, 0, 0], edge: true,
            d: { outline: [[-0.14, -0.13], [0.14, -0.13], [0.16, 0.06], [0, 0.16], [-0.16, 0.06]], depth: 0.04, bevel: 0.006 } },
          { id: 'p18', n: 'glyph', j: 'spine', sh: 'decal', m: 'clan', p: [0.16, 0.34, 0.185], d: { w: 0.16, h: 0.16, sym: 'glyph', c: '#dcd4b4' } },
          { id: 'p19', n: 'slug gun', j: 'aim', sh: 'box', m: 'iron', p: [0, 0, 0.24], d: { w: 0.1, h: 0.13, l: 0.46 } },
          { id: 'p20', n: 'drum', j: 'aim', sh: 'cyl', m: 'iron', p: [0, -0.11, 0.16], r: [1.5708, 0, 0], d: { r: 0.095, h: 0.07, seg: 10 } },
          { id: 'p21', n: 'spikes', j: 'aim', sh: 'ref', p: [0, 0.09, 0.2], r: [0, 0, 0], d: { ref: 'gr-spikes' }, s: [0.7, 0.7, 0.7] },
          { id: 'p22', n: 'muzzle', j: 'aim', sh: 'node', p: [0, 0, 0.52], tags: ['muzzle'] },
        ],
        attach: { muzzle: 'p22' },
        flags: { brute: true },
      },
      unit: {
        v: 1, kind: 'unit', id: 'tmpl-warhost', name: 'Warhost Brute', model: 'tcm:tmpl-warhost',
        faction: 'custom', role: 'assault', unitKind: 'rifle',
        hp: 180, spd: 4.9, dmg: 26, rng: 30, atkTime: 1.0, armor: 0.2, shield: 0,
        size: 1.15, vis: 34, color: '#6d8a4a', melee: true,
      } },

    // -------------------------------------------------------------- battlesuit
    // The suit rig ships as bare groups — no geometry at all — so this template
    // is a worked example of building a whole machine, jets and drivers included.
    { kind: 'unit', id: 'tmpl-suit', name: 'Forge Battlesuit', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-suit', name: 'Forge Battlesuit',
        skeleton: 'suit', scale: 1, weather: 0.1,
        proportions: { scale: 1, hipY: 1.3, torsoY: 0.3, headY: 0.5, hipW: 0.34, thighL: 0.58, shinL: 0.6, shW: 0.58 },
        bones: [{ id: 'dish', parent: 'pack', p: [0.26, 0.34, 0], tag: 'rotor' }],
        drivers: [{ bone: 'dish', kind: 'sway', axis: 'y', amp: 0.9, rate: 0.6 }],
        palette: [
          { id: 'shell', c: '#b47a34', rough: 0.62 },
          { id: 'dark', c: '#2e3339', rough: 0.8 },
          { id: 'steel', c: '#4a4d52', rough: 0.42, metal: 0.6 },
          { id: 'glow', c: '#86e0ff', glow: true },
          { id: 'flash', c: '#ffffff', team: true },
        ],
        parts: [
          { id: 'p1', n: 'torso', j: 'torso', sh: 'trapezoid', m: 'shell', p: [0, 0.05, 0], edge: true, d: { w: 0.8, h: 0.64, l: 0.6, tw: 0.62, tl: 0.46 } },
          { id: 'p2', n: 'chest vent', j: 'torso', sh: 'box', m: 'dark', p: [0, -0.14, 0.28], d: { w: 0.4, h: 0.14, l: 0.08 } },
          { id: 'p3', n: 'hips', j: 'hips', sh: 'box', m: 'shell', p: [0, 0, 0], d: { w: 0.62, h: 0.28, l: 0.42 } },
          { id: 'p4', n: 'head', j: 'head', sh: 'sph', m: 'shell', p: [0, 0, 0], s: [1, 0.9, 1.05], d: { r: 0.19, ws: 10, hs: 8 }, edge: true },
          { id: 'p5', n: 'visor', j: 'head', sh: 'box', m: 'glow', p: [0, 0.01, 0.16], d: { w: 0.22, h: 0.07, l: 0.05 } },
          { id: 'p6', n: 'sensor', j: 'head', sh: 'cyl', m: 'steel', p: [0.14, 0.12, 0.06], r: [0.4, 0, 0.3], d: { r: 0.03, h: 0.14, seg: 7 } },
          { id: 'p7', n: 'pack', j: 'pack', sh: 'trapezoid', m: 'dark', p: [0, 0.12, 0], d: { w: 0.64, h: 0.52, l: 0.28, tw: 0.5, tl: 0.2 } },
          { id: 'p8', n: 'jet', j: 'pack', sh: 'cone', m: 'glow', p: [0.22, -0.14, -0.05], r: [3.1416, 0, 0], mirror: true, tags: ['jet'], d: { r: 0.09, h: 0.24, seg: 8 } },
          { id: 'p9', n: 'nozzle', j: 'pack', sh: 'cyl', m: 'steel', p: [0.22, -0.02, -0.05], mirror: true, d: { r1: 0.1, r2: 0.12, h: 0.16, seg: 9 } },
          { id: 'p10', n: 'dish', j: 'dish', sh: 'lathe', m: 'steel', p: [0, 0, 0], r: [1.1, 0, 0], d: { profile: [[0.02, 0], [0.09, 0.02], [0.14, 0.07], [0.16, 0.12]], seg: 12 } },
          { id: 'p11', n: 'shoulder', j: 'shL', sh: 'trapezoid', m: 'shell', p: [0, 0.06, 0], mirror: true, edge: true, d: { w: 0.32, h: 0.28, l: 0.36, tw: 0.24, tl: 0.28 } },
          { id: 'p12', n: 'gun pod', j: 'armL', sh: 'box', m: 'dark', p: [0, -0.26, 0.1], mirror: true, d: { w: 0.2, h: 0.52, l: 0.5 } },
          { id: 'p13', n: 'gun barrel', j: 'armL', sh: 'cyl', m: 'steel', p: [0, -0.3, 0.42], r: [1.5708, 0, 0], mirror: true, d: { r: 0.05, h: 0.26, seg: 9 } },
          { id: 'p14', n: 'coil', j: 'armL', sh: 'ref', p: [0, -0.3, 0.3], r: [1.5708, 0, 0], mirror: true, d: { ref: 'gr-coil' } },
          { id: 'p15', n: 'thigh', j: 'legL', sh: 'cyl', m: 'shell', p: [0, -0.3, 0], mirror: true, d: { r: 0.14, h: 0.58, seg: 9 } },
          { id: 'p16', n: 'knee guard', j: 'kneeL', sh: 'sph', m: 'steel', p: [0, 0, 0.03], mirror: true, d: { r: 0.13, ws: 9, hs: 7 } },
          { id: 'p17', n: 'shin', j: 'kneeL', sh: 'cyl', m: 'dark', p: [0, -0.3, 0], mirror: true, d: { r: 0.115, h: 0.6, seg: 9 } },
          { id: 'p18', n: 'foot', j: 'footL', sh: 'wedge', m: 'steel', p: [0, -0.06, 0.06], r: [0, 3.1416, 0], mirror: true, d: { w: 0.3, h: 0.14, l: 0.46 } },
          { id: 'p19', n: 'flash panel', j: 'torso', sh: 'decal', m: 'flash', p: [0.24, 0.1, 0.31], d: { w: 0.22, h: 0.22, sym: 'lozenge', c: '#f0f0f0' } },
          { id: 'p20', n: 'muzzle', j: 'armR', sh: 'node', p: [0, -0.3, 0.58], tags: ['muzzle'] },
          { id: 'p21', n: 'heat vent', j: 'torso', sh: 'box', m: 'glow', p: [0, 0.26, -0.28], tags: ['heatVent'], d: { w: 0.34, h: 0.06, l: 0.08 } },
        ],
        attach: { muzzle: 'p20' },
        flags: {},
      },
      unit: {
        v: 1, kind: 'unit', id: 'tmpl-suit', name: 'Forge Battlesuit', model: 'tcm:tmpl-suit',
        faction: 'custom', role: 'assault', unitKind: 'rifle',
        hp: 420, spd: 5.2, dmg: 44, rng: 52, atkTime: 1.4, armor: 0.3, shield: 40,
        size: 1.8, vis: 50, color: '#b47a34', walker: true, jetpack: true, burstAuto: true,
      } },

    // ---------------------------------------------------------------- grav hull
    { kind: 'unit', id: 'tmpl-hull', name: 'Forge Grav Hull', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-hull', name: 'Forge Grav Hull',
        skeleton: 'hull', scale: 1, weather: 0.08,
        proportions: { deckY: 0.62, turretY: 1.02, gunY: 0.14 },
        palette: [
          { id: 'hull', c: '#6f8090', rough: 0.55 },
          { id: 'dark', c: '#33383d', rough: 0.75 },
          { id: 'steel', c: '#4d5257', rough: 0.4, metal: 0.6 },
          { id: 'glow', c: '#7fd8ff', glow: true },
          { id: 'flash', c: '#ffffff', team: true },
        ],
        parts: [
          { id: 'p1', n: 'belly', j: 'body', sh: 'prism', m: 'dark', p: [0, 0.42, 0], d: { w: 2.9, h: 0.42, l: 5.0, seg: 4 } },
          { id: 'p2', n: 'hull', j: 'body', sh: 'prism', m: 'hull', p: [0, 0.74, 0], d: { w: 3.1, h: 0.34, l: 5.4, seg: 4 } },
          { id: 'p3', n: 'prow', j: 'body', sh: 'wedge', m: 'hull', p: [0, 0.62, 2.5], r: [0, 0, 0], d: { w: 2.0, h: 0.38, l: 1.5 } },
          { id: 'p4', n: 'grav strip', j: 'body', sh: 'box', m: 'glow', p: [0, 0.26, 0], d: { w: 2.6, h: 0.06, l: 4.4 } },
          { id: 'p5', n: 'engine bell', j: 'body', sh: 'lathe', m: 'steel', p: [0, 0.66, -2.5], r: [1.5708, 0, 0],
            d: { profile: [[0.1, 0], [0.34, 0.1], [0.44, 0.34], [0.4, 0.5]], seg: 14 } },
          { id: 'p6', n: 'engine glow', j: 'body', sh: 'cyl', m: 'glow', p: [0, 0.66, -2.86], r: [1.5708, 0, 0], d: { r: 0.3, h: 0.06, seg: 12 } },
          { id: 'p7', n: 'vent', j: 'body', sh: 'ref', p: [1.15, 0.7, -1.5], r: [0, 1.5708, 0], mirror: true, d: { ref: 'gr-vent' }, s: [2, 2, 2] },
          { id: 'p8', n: 'deck rail', j: 'deck', sh: 'box', m: 'steel', p: [1.2, 0.16, 0.4], mirror: true, d: { w: 0.08, h: 0.3, l: 2.2 } },
          { id: 'p9', n: 'turret', j: 'turret', sh: 'trapezoid', m: 'hull', p: [0, 0.22, 0], edge: true, d: { w: 1.6, h: 0.5, l: 2.0, tw: 1.1, tl: 1.4 } },
          { id: 'p10', n: 'mantlet', j: 'turret', sh: 'box', m: 'steel', p: [0, 0.2, 0.9], d: { w: 0.7, h: 0.42, l: 0.4 } },
          { id: 'p11', n: 'railgun', j: 'gun', sh: 'cyl', m: 'dark', p: [0, 0, 1.7], r: [1.5708, 0, 0], d: { r: 0.14, h: 3.0, seg: 10 } },
          { id: 'p12', n: 'rail', j: 'gun', sh: 'box', m: 'steel', p: [0.19, 0.12, 1.7], mirror: true, d: { w: 0.06, h: 0.14, l: 2.7 } },
          { id: 'p13', n: 'coil', j: 'gun', sh: 'ref', p: [0, 0, 0.9], r: [0, 0, 0], d: { ref: 'gr-coil' }, s: [1.9, 1.9, 1.9] },
          { id: 'p14', n: 'antenna', j: 'deck', sh: 'ref', p: [-1.0, 0.2, -1.4], d: { ref: 'gr-antenna' }, s: [2, 2, 2] },
          { id: 'p15', n: 'flash panel', j: 'turret', sh: 'decal', m: 'flash', p: [0.56, 0.3, 0.2], r: [0, 1.5708, 0], d: { w: 0.5, h: 0.5, sym: 'lozenge', c: '#ffffff' } },
          { id: 'p16', n: 'muzzle', j: 'gun', sh: 'node', p: [0, 0, 3.25], tags: ['muzzle'] },
          { id: 'p17', n: 'turret node', j: 'turret', sh: 'node', p: [0, 0, 0], tags: ['turret'] },
        ],
        attach: { muzzle: 'p16', turret: 'p17' },
        flags: {},
      },
      unit: {
        v: 1, kind: 'unit', id: 'tmpl-hull', name: 'Forge Grav Hull', model: 'tcm:tmpl-hull',
        faction: 'custom', role: 'armour', unitKind: 'tank',
        hp: 900, spd: 6.4, dmg: 150, rng: 78, atkTime: 3.6, armor: 0.42, shield: 0,
        size: 3, vis: 56, color: '#8a9aa8', vehicle: true, hover: 0.7, mg: true, scale: 1,
      } },

    // ------------------------------------------------------------------- props
    { kind: 'prop', id: 'tmpl-barricade', name: 'Ceramic Barricade', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-barricade', name: 'Ceramic Barricade', skeleton: 'static', weather: 0.18,
        palette: [
          { id: 'crete', c: '#8f8b80', rough: 0.95 },
          { id: 'iron', c: '#4a4a42', rough: 0.6, metal: 0.4 },
          { id: 'stripe', c: '#c8a02c', rough: 0.8 },
        ],
        parts: [
          { id: 'p1', n: 'slab', j: 'body', sh: 'extrude', m: 'crete', p: [0, 0, 0], r: [0, 0, 0], edge: true,
            d: { outline: [[-0.65, 0], [0.65, 0], [0.55, 0.9], [-0.55, 0.9]], depth: 0.34, bevel: 0.02 } },
          { id: 'p2', n: 'buttress', j: 'body', sh: 'wedge', m: 'crete', p: [0.42, 0, -0.34], mirror: true, r: [0, 3.1416, 0],
            d: { w: 0.3, h: 0.55, l: 0.6 } },
          { id: 'p3', n: 'cap rail', j: 'body', sh: 'box', m: 'iron', p: [0, 0.93, 0], d: { w: 1.2, h: 0.07, l: 0.4 } },
          { id: 'p4', n: 'hazard stripe', j: 'body', sh: 'box', m: 'stripe', p: [0, 0.72, 0.18], d: { w: 1.0, h: 0.1, l: 0.02 } },
          { id: 'p5', n: 'rivets', j: 'body', sh: 'ref', p: [0, 0.84, 0.18], d: { ref: 'gr-rivets' } },
        ],
      },
      prop: { v: 1, kind: 'prop', id: 'tmpl-barricade', name: 'Ceramic Barricade', model: 'tcm:tmpl-barricade',
        height: 1.0, hp: 190, cover: 0.5, color: '#8f8b80', seethrough: false, vary: 0.06, spin: false } },

    { kind: 'prop', id: 'tmpl-pylon', name: 'Marker Pylon', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-pylon', name: 'Marker Pylon', skeleton: 'static',
        palette: [
          { id: 'stone', c: '#7d7a70', rough: 0.9 },
          { id: 'iron', c: '#3f3d37', rough: 0.55, metal: 0.5 },
          { id: 'glow', c: '#9fe8ff', glow: true },
        ],
        parts: [
          { id: 'p1', n: 'base', j: 'body', sh: 'lathe', m: 'stone', p: [0, 0, 0],
            d: { profile: [[0.5, 0], [0.46, 0.16], [0.3, 0.26], [0.26, 1.5], [0.34, 1.7], [0, 1.9]], seg: 12 } },
          { id: 'p2', n: 'ring', j: 'body', sh: 'torus', m: 'iron', p: [0, 1.2, 0], r: [1.5708, 0, 0], d: { r: 0.38, r2: 0.05, rs: 6, ts: 14 } },
          { id: 'p3', n: 'lamp', j: 'body', sh: 'sph', m: 'glow', p: [0, 1.94, 0], d: { r: 0.14, ws: 10, hs: 8 } },
          { id: 'p4', n: 'strut', j: 'body', sh: 'box', m: 'iron', p: [0.3, 0.6, 0], mirror: true, r: [0, 0, 0.16], d: { w: 0.06, h: 1.0, l: 0.06 } },
        ],
      },
      prop: { v: 1, kind: 'prop', id: 'tmpl-pylon', name: 'Marker Pylon', model: 'tcm:tmpl-pylon',
        height: 2.0, hp: 140, cover: 0.35, color: '#7d7a70', vary: 0.1 } },

    // ---------------------------------------------------------------- stalker
    // TIER 3, and the proof that it works: a skeleton the engine has never seen,
    // built from nothing but custom bones, animated by an AUTHORED WALK CLIP
    // through the generic animator — and still aiming, flinching and collapsing,
    // because those overlays target semantic TAGS rather than joint names.
    { kind: 'unit', id: 'tmpl-stalker', name: 'Stalker', stock: true, tmpl: true,
      model: {
        v: 1, kind: 'model', id: 'tmpl-stalker', name: 'Stalker',
        skeleton: 'custom', scale: 1, weather: 0.18,
        bones: [
          { id: 'core', parent: 'body', p: [0, 1.05, 0], tag: 'hips' },
          { id: 'spine', parent: 'core', p: [0, 0.05, 0.35], tag: 'spine' },
          { id: 'neck', parent: 'spine', p: [0, 0.12, 0.42], tag: 'neck' },
          { id: 'skull', parent: 'neck', p: [0, 0.06, 0.2], tag: 'head' },
          { id: 'mouth', parent: 'skull', p: [0, -0.06, 0.24], tag: 'aim' },
          { id: 'hipFL', parent: 'spine', p: [0.3, -0.05, 0.1], tag: 'thighL' },
          { id: 'kneeFL', parent: 'hipFL', p: [0, -0.42, 0], tag: 'kneeL' },
          { id: 'footFL', parent: 'kneeFL', p: [0, -0.4, 0], tag: 'footL' },
          { id: 'hipFR', parent: 'spine', p: [-0.3, -0.05, 0.1], tag: 'thighR' },
          { id: 'kneeFR', parent: 'hipFR', p: [0, -0.42, 0], tag: 'kneeR' },
          { id: 'footFR', parent: 'kneeFR', p: [0, -0.4, 0], tag: 'footR' },
          { id: 'hipRL', parent: 'core', p: [0.32, -0.05, -0.4] },
          { id: 'kneeRL', parent: 'hipRL', p: [0, -0.44, 0] },
          { id: 'footRL', parent: 'kneeRL', p: [0, -0.42, 0] },
          { id: 'hipRR', parent: 'core', p: [-0.32, -0.05, -0.4] },
          { id: 'kneeRR', parent: 'hipRR', p: [0, -0.44, 0] },
          { id: 'footRR', parent: 'kneeRR', p: [0, -0.42, 0] },
          { id: 'tail', parent: 'core', p: [0, 0.08, -0.66], tag: 'banner' },
        ],
        drivers: [{ bone: 'tail', kind: 'sway', axis: 'y', amp: 0.3, rate: 2.2, when: 'moving' }],
        palette: [
          { id: 'hide', c: '#4a4438', rough: 0.95 },
          { id: 'plate', c: '#2e2a24', rough: 0.8 },
          { id: 'iron', c: '#55504a', rough: 0.45, metal: 0.6 },
          { id: 'eye', c: '#ff7a3a', glow: true },
          { id: 'mark', c: '#ffffff', team: true },
        ],
        parts: [
          { id: 'p1', n: 'thorax', j: 'spine', sh: 'trapezoid', m: 'hide', p: [0, 0, 0], edge: true, d: { w: 0.62, h: 0.44, l: 0.72, tw: 0.44, tl: 0.5 } },
          { id: 'p2', n: 'abdomen', j: 'core', sh: 'sph', m: 'hide', p: [0, 0, -0.3], s: [1, 0.9, 1.5], d: { r: 0.34, ws: 10, hs: 8 } },
          { id: 'p3', n: 'carapace', j: 'spine', sh: 'extrude', m: 'plate', p: [0, 0.22, 0], r: [1.5708, 0, 0], edge: true,
            d: { outline: [[-0.28, -0.4], [0.28, -0.4], [0.32, 0.1], [0, 0.44], [-0.32, 0.1]], depth: 0.1, bevel: 0.012 } },
          { id: 'p4', n: 'skull', j: 'skull', sh: 'wedge', m: 'hide', p: [0, 0, 0.06], r: [0, 3.1416, 0], d: { w: 0.3, h: 0.24, l: 0.42 } },
          { id: 'p5', n: 'jaw', j: 'skull', sh: 'trapezoid', m: 'plate', p: [0, -0.11, 0.14], d: { w: 0.22, h: 0.1, l: 0.3, tw: 0.14, tl: 0.2 } },
          { id: 'p6', n: 'eye', j: 'skull', sh: 'sph', m: 'eye', p: [0.09, 0.05, 0.16], mirror: true, d: { r: 0.035, ws: 7, hs: 6 } },
          { id: 'p7', n: 'fang', j: 'skull', sh: 'cone', m: 'iron', p: [0.06, -0.12, 0.26], r: [2.6, 0, 0], mirror: true, d: { r: 0.026, h: 0.14, seg: 5 } },
          { id: 'p8', n: 'muzzle', j: 'mouth', sh: 'node', p: [0, 0, 0.06], tags: ['muzzle'] },
          { id: 'p9', n: 'thigh FL', j: 'hipFL', sh: 'cyl', m: 'hide', p: [0, -0.21, 0], d: { r: 0.1, h: 0.44, seg: 8 } },
          { id: 'p10', n: 'shin FL', j: 'kneeFL', sh: 'cyl', m: 'plate', p: [0, -0.2, 0], d: { r: 0.07, h: 0.42, seg: 7 } },
          { id: 'p11', n: 'claw FL', j: 'footFL', sh: 'wedge', m: 'iron', p: [0, -0.04, 0.06], r: [0, 3.1416, 0], d: { w: 0.14, h: 0.09, l: 0.24 } },
          { id: 'p12', n: 'thigh FR', j: 'hipFR', sh: 'cyl', m: 'hide', p: [0, -0.21, 0], d: { r: 0.1, h: 0.44, seg: 8 } },
          { id: 'p13', n: 'shin FR', j: 'kneeFR', sh: 'cyl', m: 'plate', p: [0, -0.2, 0], d: { r: 0.07, h: 0.42, seg: 7 } },
          { id: 'p14', n: 'claw FR', j: 'footFR', sh: 'wedge', m: 'iron', p: [0, -0.04, 0.06], r: [0, 3.1416, 0], d: { w: 0.14, h: 0.09, l: 0.24 } },
          { id: 'p15', n: 'thigh RL', j: 'hipRL', sh: 'cyl', m: 'hide', p: [0, -0.22, 0], d: { r: 0.11, h: 0.46, seg: 8 } },
          { id: 'p16', n: 'shin RL', j: 'kneeRL', sh: 'cyl', m: 'plate', p: [0, -0.21, 0], d: { r: 0.075, h: 0.44, seg: 7 } },
          { id: 'p17', n: 'claw RL', j: 'footRL', sh: 'wedge', m: 'iron', p: [0, -0.04, 0.06], r: [0, 3.1416, 0], d: { w: 0.14, h: 0.09, l: 0.24 } },
          { id: 'p18', n: 'thigh RR', j: 'hipRR', sh: 'cyl', m: 'hide', p: [0, -0.22, 0], d: { r: 0.11, h: 0.46, seg: 8 } },
          { id: 'p19', n: 'shin RR', j: 'kneeRR', sh: 'cyl', m: 'plate', p: [0, -0.21, 0], d: { r: 0.075, h: 0.44, seg: 7 } },
          { id: 'p20', n: 'claw RR', j: 'footRR', sh: 'wedge', m: 'iron', p: [0, -0.04, 0.06], r: [0, 3.1416, 0], d: { w: 0.14, h: 0.09, l: 0.24 } },
          { id: 'p21', n: 'tail', j: 'tail', sh: 'tube', m: 'hide', p: [0, 0, 0], d: { path: [[0, 0, 0], [0, 0.06, -0.3], [0, -0.02, -0.6]], r: 0.06, seg: 8, rseg: 6 } },
          { id: 'p22', n: 'spines', j: 'spine', sh: 'cone', m: 'iron', p: [0, 0.3, -0.2], d: { r: 0.03, h: 0.16, seg: 5 },
            mod: { array: { n: 4, step: [0, -0.02, 0.16], sstep: -0.1 } } },
          { id: 'p23', n: 'clan mark', j: 'spine', sh: 'decal', m: 'mark', p: [0.3, 0.06, 0.05], r: [0, 1.5708, 0], d: { w: 0.2, h: 0.2, sym: 'chevron', c: '#e8e8e8' } },
        ],
        attach: { muzzle: 'p8' },
        flags: {},
        // The authored walk. Diagonal pairs, so it trots: front-left moves with
        // rear-right. `speedSync` advances it with real ground speed, which is
        // what stops it skating.
        clips: {
          stand: { dur: 2.4, loop: true, tracks: [
            { b: 'spine', ch: 'rx', k: [[0, 0.02], [1.2, -0.02], [2.4, 0.02]] },
            { b: 'skull', ch: 'rx', k: [[0, 0.04], [1.2, -0.02], [2.4, 0.04]] },
            { b: 'hipFL', ch: 'rx', k: [[0, 0.18]] }, { b: 'kneeFL', ch: 'rx', k: [[0, -0.5]] },
            { b: 'hipFR', ch: 'rx', k: [[0, 0.18]] }, { b: 'kneeFR', ch: 'rx', k: [[0, -0.5]] },
            { b: 'hipRL', ch: 'rx', k: [[0, 0.22]] }, { b: 'kneeRL', ch: 'rx', k: [[0, -0.58]] },
            { b: 'hipRR', ch: 'rx', k: [[0, 0.22]] }, { b: 'kneeRR', ch: 'rx', k: [[0, -0.58]] },
          ] },
          walk: { dur: 0.9, loop: true, speedSync: true, baseSpd: 4.2, tracks: [
            { b: 'hipFL', ch: 'rx', k: [[0, 0.62], [0.225, 0.18], [0.45, -0.3], [0.675, 0.1], [0.9, 0.62]] },
            { b: 'kneeFL', ch: 'rx', k: [[0, -0.3], [0.225, -0.62], [0.45, -0.9], [0.675, -0.42], [0.9, -0.3]] },
            { b: 'hipRR', ch: 'rx', k: [[0, 0.66], [0.225, 0.2], [0.45, -0.3], [0.675, 0.14], [0.9, 0.66]] },
            { b: 'kneeRR', ch: 'rx', k: [[0, -0.36], [0.225, -0.7], [0.45, -1.0], [0.675, -0.48], [0.9, -0.36]] },
            { b: 'hipFR', ch: 'rx', k: [[0, -0.3], [0.225, 0.1], [0.45, 0.62], [0.675, 0.18], [0.9, -0.3]] },
            { b: 'kneeFR', ch: 'rx', k: [[0, -0.9], [0.225, -0.42], [0.45, -0.3], [0.675, -0.62], [0.9, -0.9]] },
            { b: 'hipRL', ch: 'rx', k: [[0, -0.3], [0.225, 0.14], [0.45, 0.66], [0.675, 0.2], [0.9, -0.3]] },
            { b: 'kneeRL', ch: 'rx', k: [[0, -1.0], [0.225, -0.48], [0.45, -0.36], [0.675, -0.7], [0.9, -1.0]] },
            { b: 'core', ch: 'py', k: [[0, 1.05], [0.225, 1.1], [0.45, 1.05], [0.675, 1.1], [0.9, 1.05]] },
            { b: 'spine', ch: 'ry', k: [[0, 0.07], [0.45, -0.07], [0.9, 0.07]] },
            { b: 'neck', ch: 'rx', k: [[0, 0.06], [0.45, 0.0], [0.9, 0.06]] },
          ], events: [{ t: 0.05, e: 'footstep' }, { t: 0.5, e: 'footstep' }] },
          run: { dur: 0.56, loop: true, speedSync: true, baseSpd: 7.5, tracks: [
            { b: 'hipFL', ch: 'rx', k: [[0, 0.9], [0.14, 0.2], [0.28, -0.5], [0.42, 0.1], [0.56, 0.9]] },
            { b: 'kneeFL', ch: 'rx', k: [[0, -0.24], [0.14, -0.8], [0.28, -1.2], [0.42, -0.5], [0.56, -0.24]] },
            { b: 'hipRR', ch: 'rx', k: [[0, 0.95], [0.14, 0.24], [0.28, -0.5], [0.42, 0.16], [0.56, 0.95]] },
            { b: 'kneeRR', ch: 'rx', k: [[0, -0.3], [0.14, -0.9], [0.28, -1.3], [0.42, -0.58], [0.56, -0.3]] },
            { b: 'hipFR', ch: 'rx', k: [[0, -0.5], [0.14, 0.1], [0.28, 0.9], [0.42, 0.2], [0.56, -0.5]] },
            { b: 'kneeFR', ch: 'rx', k: [[0, -1.2], [0.14, -0.5], [0.28, -0.24], [0.42, -0.8], [0.56, -1.2]] },
            { b: 'hipRL', ch: 'rx', k: [[0, -0.5], [0.14, 0.16], [0.28, 0.95], [0.42, 0.24], [0.56, -0.5]] },
            { b: 'kneeRL', ch: 'rx', k: [[0, -1.3], [0.14, -0.58], [0.28, -0.3], [0.42, -0.9], [0.56, -1.3]] },
            { b: 'core', ch: 'py', k: [[0, 1.02], [0.14, 1.16], [0.28, 1.02], [0.42, 1.16], [0.56, 1.02]] },
            { b: 'spine', ch: 'rx', k: [[0, 0.12], [0.28, 0.02], [0.56, 0.12]] },
          ], events: [{ t: 0.03, e: 'footstep' }, { t: 0.31, e: 'footstep' }] },
          prone: { dur: 1, loop: false, tracks: [
            { b: 'core', ch: 'py', k: [[0, 0.55]] },
            { b: 'hipFL', ch: 'rx', k: [[0, 1.1]] }, { b: 'kneeFL', ch: 'rx', k: [[0, -1.9]] },
            { b: 'hipFR', ch: 'rx', k: [[0, 1.1]] }, { b: 'kneeFR', ch: 'rx', k: [[0, -1.9]] },
            { b: 'hipRL', ch: 'rx', k: [[0, 1.2]] }, { b: 'kneeRL', ch: 'rx', k: [[0, -2.0]] },
            { b: 'hipRR', ch: 'rx', k: [[0, 1.2]] }, { b: 'kneeRR', ch: 'rx', k: [[0, -2.0]] },
            { b: 'spine', ch: 'rx', k: [[0, 0.1]] },
          ] },
          down: { dur: 1.2, loop: false, tracks: [
            { b: 'core', ch: 'py', k: [[0, 1.05], [1.2, 0.34]] },
            { b: 'hipFL', ch: 'rx', k: [[0, 0.18], [1.2, 1.5]] }, { b: 'kneeFL', ch: 'rx', k: [[0, -0.5], [1.2, -2.2]] },
            { b: 'hipFR', ch: 'rx', k: [[0, 0.18], [1.2, 1.4]] }, { b: 'kneeFR', ch: 'rx', k: [[0, -0.5], [1.2, -2.1]] },
            { b: 'hipRL', ch: 'rx', k: [[0, 0.22], [1.2, 1.5]] }, { b: 'kneeRL', ch: 'rx', k: [[0, -0.58], [1.2, -2.2]] },
            { b: 'hipRR', ch: 'rx', k: [[0, 0.22], [1.2, 1.4]] }, { b: 'kneeRR', ch: 'rx', k: [[0, -0.58], [1.2, -2.1]] },
            { b: 'neck', ch: 'rx', k: [[0, 0], [1.2, 0.7]] },
          ] },
        },
      },
      unit: {
        v: 1, kind: 'unit', id: 'tmpl-stalker', name: 'Stalker', model: 'tcm:tmpl-stalker',
        faction: 'custom', role: 'skirmisher', unitKind: 'rifle',
        hp: 150, spd: 6.8, dmg: 30, rng: 34, atkTime: 0.9, armor: 0.16, shield: 0,
        size: 1.3, vis: 46, color: '#4a4438', melee: true,
      } },

    // ----------------------------------------------------------------- terrain
    { kind: 'terrain', id: 'tmpl-ashwaste', name: 'Ash Waste', stock: true, tmpl: true,
      terrain: { v: 1, kind: 'terrain', id: 'ashwaste', name: 'Ash Waste', c: '#5c554c',
        speed: 0.86, passable: true, cover: 0.08, stealth: 0.12, carve: 0 } },
  ];

  // =======================================================================
  // THE VIEWPORT
  // =======================================================================
  //
  // Its own scene and camera, drawn through the game's renderer. A separate
  // scene keeps the battlefield out of the way without having to hide half of
  // it, and it means the forge can light the model for inspection (a soft fill
  // from below, which the battlefield never has) while still using the same
  // materials, the same tone mapping and the same skeletons.

  function buildView() {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x12161c);
    scene.fog = null;

    var hemi = new THREE.HemisphereLight(0xbcd4ec, 0x2a2620, 0.85);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xfff0d8, 1.5);
    key.position.set(3, 5.5, 3.4);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0x7fa8d8, 0.55);
    rim.position.set(-3.5, 1.6, -3);
    scene.add(rim);
    var fill = new THREE.DirectionalLight(0x505a66, 0.35);
    fill.position.set(0, -3, 1.5);
    scene.add(fill);

    // Ground: a dark disc plus a grid, so the model has something to sit on and
    // the player can judge how big it is.
    var disc = new THREE.Mesh(new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 1 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -0.002;
    scene.add(disc);
    var grid = new THREE.GridHelper(6, 60, 0x3a4a5a, 0x222a33);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    scene.add(grid);
    var axes = new THREE.GridHelper(6, 6, 0x54687c, 0x54687c);
    axes.material.transparent = true; axes.material.opacity = 0.4;
    scene.add(axes);

    // The mirror plane, drawn as a translucent sheet, because "place once, get
    // both sides" is only obvious if you can see where the centre line is.
    var mirror = new THREE.Mesh(new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ color: 0x6fa8e0, transparent: true, opacity: 0.06, side: THREE.DoubleSide }));
    mirror.rotation.y = Math.PI / 2; mirror.position.y = 1;
    mirror.visible = false;
    scene.add(mirror);

    var root = new THREE.Group();     // the model lives here
    scene.add(root);
    var ghost = new THREE.Group();    // scale reference silhouette
    scene.add(ghost);
    var bones = new THREE.Group();    // pickable joint markers
    scene.add(bones);
    var overlay = new THREE.Group();  // selection box + gizmo
    scene.add(overlay);

    var camera = new THREE.PerspectiveCamera(42, 1, 0.02, 200);

    view = {
      scene: scene, camera: camera, root: root, ghost: ghost, bones: bones,
      grid: grid, axes: axes, disc: disc, mirror: mirror, overlay: overlay,
      key: key,
      cam: { yaw: 0.7, pitch: 0.22, dist: 3.4, target: new THREE.Vector3(0, 0.9, 0) },
      selBox: null, gizmo: null, ray: new THREE.Raycaster(),
    };
    buildGizmo();
    layoutCamera();
  }

  function layoutCamera() {
    var c = view.cam, cam = view.camera;
    var cp = Math.cos(c.pitch) * c.dist;
    cam.position.set(c.target.x + Math.sin(c.yaw) * cp,
      c.target.y + Math.sin(c.pitch) * c.dist,
      c.target.z + Math.cos(c.yaw) * cp);
    cam.lookAt(c.target);
    var w = window.innerWidth, h = window.innerHeight;
    if (cam.aspect !== w / h) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }

  /** Frame the whole model (or the selection) in the viewport. */
  function frame(selOnly) {
    var box = new THREE.Box3();
    var obj = view.root;
    if (selOnly && S.sel.length) {
      box.makeEmpty();
      view.root.traverse(function (o) {
        if (o.isMesh && o.userData.tcmPart && S.sel.indexOf(o.userData.tcmPart) >= 0)
          box.expandByObject(o);
      });
    } else box.setFromObject(obj);
    if (box.isEmpty()) { view.cam.target.set(0, 0.9, 0); view.cam.dist = 3.4; layoutCamera(); return; }
    var c = box.getCenter(new THREE.Vector3());
    var sz = box.getSize(new THREE.Vector3());
    view.cam.target.copy(c);
    view.cam.dist = Math.max(0.35, Math.max(sz.x, sz.y, sz.z) * 2.1);
    layoutCamera();
  }

  // ---- the translate gizmo ------------------------------------------------
  // Three axis handles. Dragging one slides the selection along that axis in
  // its PARENT's space, snapped to the grid step. Rotation and scale stay in
  // the inspector: they are read as numbers far more often than dragged, and a
  // rotate ring that fights the orbit control is worse than a number field.

  function buildGizmo() {
    var g = new THREE.Group();
    var AX = [{ a: 'x', c: 0xe0645a, d: [1, 0, 0] },
              { a: 'y', c: 0x7ad06a, d: [0, 1, 0] },
              { a: 'z', c: 0x5a9ae0, d: [0, 0, 1] }];
    for (var i = 0; i < AX.length; i++) {
      var ax = AX[i];
      var m = new THREE.MeshBasicMaterial({ color: ax.c, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 });
      var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.22, 5), m);
      var head = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 7), m);
      shaft.position.set(ax.d[0] * 0.11, ax.d[1] * 0.11, ax.d[2] * 0.11);
      head.position.set(ax.d[0] * 0.25, ax.d[1] * 0.25, ax.d[2] * 0.25);
      if (ax.a === 'x') { shaft.rotation.z = -Math.PI / 2; head.rotation.z = -Math.PI / 2; }
      if (ax.a === 'z') { shaft.rotation.x = Math.PI / 2; head.rotation.x = Math.PI / 2; }
      shaft.userData.gizmo = ax.a; head.userData.gizmo = ax.a;
      shaft.renderOrder = 999; head.renderOrder = 999;
      g.add(shaft); g.add(head);
    }
    g.visible = false;
    view.overlay.add(g);
    view.gizmo = g;
  }

  /** Keep the selection box and the gizmo glued to the selected part, and keep
   *  the gizmo a constant size on screen whatever the zoom. */
  function syncOverlay() {
    var g = view.gizmo;
    if (view.selBox) { view.overlay.remove(view.selBox); view.selBox = null; }
    var target = null;
    if (S.sel.length) {
      view.root.traverse(function (o) {
        if (!target && o.userData && o.userData.tcmPart === S.sel[0] && o.userData.tcmSide !== -1) target = o;
      });
    }
    if (!target) { g.visible = false; return; }
    var box = new THREE.BoxHelper(target, 0xd9b370);
    box.material.depthTest = false; box.material.transparent = true; box.renderOrder = 998;
    view.overlay.add(box);
    view.selBox = box;
    var wp = target.getWorldPosition(new THREE.Vector3());
    g.position.copy(wp);
    var q = target.parent ? target.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    g.quaternion.copy(q);
    g.scale.setScalar(Math.max(0.35, view.camera.position.distanceTo(wp) * 0.55));
    g.visible = S.tab === 'build';
  }

  // =======================================================================
  // Building the preview
  // =======================================================================

  /** A stand-in unit with exactly the fields the pose engine and
   *  `_updateModelAnim` read. This is what lets the forge drive the REAL
   *  animators instead of a reimplementation of them — the whole reason the
   *  editor lives in the game page. */
  function makeFake(defOverride) {
    var def = defOverride || {};
    // Inherit from Unit.prototype: `_updateModelAnim` calls `this._poseInfantry`
    // and friends, so the stand-in has to BE a Unit as far as method lookup is
    // concerned. The own properties below shadow the few methods the forge needs
    // to control (which pose to hold, whether the man is pinned).
    var o = G.Unit ? Object.create(G.Unit.prototype) : {};
    return Object.assign(o, {
      game: stubGame, def: def, type: 'forge',
      pos: { x: 0, y: 0, z: 0 }, path: [], face: 0, targetFace: 0,
      alive: true, downed: false, garrison: null, dugin: false, hold: false,
      moveMode: 'normal', posture: 'normal', suppState: 'Steady', suppression: 0,
      healthState: 'Healthy', recoilT: 0, aimT: 0, digT: 0, _throwT: 0,
      bobT: 0, airH: 0, airV: 0, jetOn: false, jetFuel: 0, jetVX: 0,
      target: null, groundAtk: null, spriteMode: false, flashT: 0,
      _scanPhase: 0.7, _collapseSide: 1, _proneReflex: false, _landT: 0, _airWas: false,
      mesh: null, rig: null, turret: null, flashMats: [],
      _pinned: function () { return false; },
      _turnRate: function () { return 6; },
      _stance: function () { return S.pose; },
      _updateOverlays: function () {},
    });
  }

  function disposePreview() {
    if (!built) return;
    // Ownership rule (FORGE_PLAN §10): cached geometry and cached unlit
    // materials are engine-owned and must NEVER be disposed here — they are
    // shared with every other unit of the type. Only the per-unit lit
    // materials this build created are ours to free.
    if (built.flashMats) for (var i = 0; i < built.flashMats.length; i++) {
      var m = built.flashMats[i];
      if (m && m.dispose) m.dispose();
    }
    if (built.group && built.group.parent) built.group.parent.remove(built.group);
    built = null;
  }

  /** Rebuild the previewed model from the current document. Called after every
   *  mutation — a full rebuild is a millisecond or two and it guarantees the
   *  viewport shows exactly what a battle would build. */
  function rebuild() {
    if (!view) return;
    disposePreview();
    if (!S.doc) { view.mirror.visible = false; renderBones(); return; }
    var teamC = teamColor();
    var def = unitDefPreview();
    fake = makeFake(def);
    built = TCM.buildModel(S.doc, fake, teamC);
    // Tag every mesh with its part id so the viewport can pick it. TCM tags the
    // node it returns; this walks the whole tree so a modifier's copies and a
    // ref's children are pickable too.
    view.root.add(built.group);
    fake.mesh = built.group;
    fake.rig = built.rig;
    fake.turret = built.turret;
    fake.flashMats = built.flashMats || [];
    // The suit and hull animators want a rig; a static model has none, and
    // `_updateModelAnim` copes with that (it falls through to the bob/hover path).
    S.broken = !!built.broken;
    view.mirror.visible = S.tab === 'build' && anyMirror();
    renderBones();
    syncOverlay();
  }

  function anyMirror() {
    return ((S.doc && S.doc.parts) || []).some(function (p) { return p.mirror; });
  }

  function teamColor() {
    try {
      if (G.game && G.game.teamColor) return G.game.teamColor(S.team);
      if (G.game && G.game.teamHues) {
        var c = new THREE.Color();
        c.setHSL(G.game.teamHues[S.team] / 360, 0.55, 0.5);
        return c.getHex();
      }
    } catch (e) {}
    return S.team === 1 ? 0x6fa8e0 : 0xe07a72;
  }

  /** The def the preview animates with. Vehicle/hover/walker flags change how
   *  `_updateModelAnim` treats the model, so the preview has to see them. */
  function unitDefPreview() {
    var m = S.meta || {};
    var def = {
      name: m.name || 'preview', kind: m.unitKind || 'rifle',
      size: num(m.size, 1), spd: num(m.spd, 4), hp: num(m.hp, 100),
      scale: num(m.scale, 1),
    };
    UNIT_FLAGS.forEach(function (k) { if (m[k]) def[k] = m[k]; });
    if (m.hover) def.hover = typeof m.hover === 'number' ? m.hover : 0.6;
    return def;
  }

  /** Joint markers. Drawn as small octahedra with the joint name, and pickable,
   *  so "which bone is this" and "put the part on that bone" are both one click. */
  function renderBones() {
    var b = view.bones;
    while (b.children.length) b.remove(b.children[0]);
    b.visible = S.showBones && !!built;
    if (!b.visible || !built) return;
    var rig = built.rig || (built.group && built.group.userData && built.group.userData.rig);
    var names = joints();
    var geo = new THREE.OctahedronGeometry(0.03);
    for (var i = 0; i < names.length; i++) {
      var o = rig && rig[names[i]];
      if (!o || !o.isObject3D) continue;
      var sel = S.selBone === names[i];
      var m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: sel ? 0xffd050 : 0x6fa8e0, toneMapped: false, depthTest: false,
        transparent: true, opacity: sel ? 1 : 0.7,
      }));
      m.renderOrder = 997;
      o.getWorldPosition(m.position);
      m.userData.joint = names[i];
      b.add(m);
    }
  }

  /** The scale ghost: a stock unit, rendered as a translucent shell, so the
   *  player can judge size against the army they are building for (§4.8). */
  function setGhost(on, key) {
    S.showGhost = on == null ? !S.showGhost : !!on;
    if (key) S.ghostKey = key;
    var g = view.ghost;
    while (g.children.length) g.remove(g.children[0]);
    g.visible = S.showGhost;
    if (!S.showGhost) return;
    try {
      var mk = G.MODEL_BUILDERS[(G.UNIT_DEFS[S.ghostKey] || {}).model || S.ghostKey];
      var res = mk ? mk(makeFake(G.UNIT_DEFS[S.ghostKey] || {}), 0x8899aa) : null;
      if (res && res.group) {
        res.group.traverse(function (o) {
          if (!o.isMesh) return;
          o.material = new THREE.MeshBasicMaterial({
            color: 0x8fb6e0, transparent: true, opacity: 0.16, depthWrite: false,
          });
          o.castShadow = o.receiveShadow = false;
        });
        res.group.position.x = 1.1;
        g.add(res.group);
      }
    } catch (e) { warn('ghost build failed: ' + e.message); }
    return S.showGhost;
  }

  // =======================================================================
  // Per-frame
  // =======================================================================

  function update(dt) {
    S.clock += dt;
    if (!stubGame) stubGame = { time: 0, fpv: null, vmMount: null };
    stubGame.time = S.clock;
    if (S.spin) { S.turntable += dt * 0.5; view.root.rotation.y = S.turntable; }
    // Drive the model through the game's own animator. `_updateModelAnim` is a
    // Unit method, so it is called with the stand-in as `this` — the honest way
    // to preview, because there is exactly one animation code path in the game
    // and this is it.
    if (built && fake && G.Unit) {
      fake.target = S.dummy ? DUMMY : null;
      if (S.playing) {
        try { G.Unit.prototype._updateModelAnim.call(fake, dt); }
        catch (e) { poseError(e); }
      } else if (fake.rig) {
        fake.bobT = S.gait;
        try { G.Unit.prototype._updateModelAnim.call(fake, 0.0001); }
        catch (e) { poseError(e); }
      }
      // The animator parks the model at the unit's world position; the forge
      // wants it at the origin so the turntable and the grid agree.
      built.group.position.x = 0; built.group.position.z = 0;
      if (!fake.rig) built.group.position.y = Math.max(0, built.group.position.y);
    }
    layoutCamera();
    if (S.showBones) renderBones();
    if (SC.on) syncSculptOverlay();
    syncOverlay();
  }

  var DUMMY = {
    alive: true, pos: { x: 0.4, y: 1.0, z: 9 }, def: { size: 1 },
  };

  var poseErrT = 0;
  function poseError(e) {
    // A throw here means the rig is missing something a procedural system
    // indexes by name — exactly the class of bug that bit Batch N4 three times.
    // Say so out loud rather than quietly freezing the preview.
    if (poseErrT++ < 3) {
      warn('pose engine threw: ' + e.message);
      toast('Pose engine: ' + e.message, true);
    }
    S.playing = false;
  }

  function render(renderer) {
    if (!view) return;
    renderer.render(view.scene, view.camera);
  }

  // =======================================================================
  // ASSET LIFECYCLE
  // =======================================================================

  function list(kind) {
    var out = [];
    for (var k in S.lib.assets) {
      var a = S.lib.assets[k];
      if (kind && a.kind !== kind) continue;
      out.push({ id: a.id, kind: a.kind, name: a.name, stock: !!a.stock, pub: !!a.pub, tmpl: !!a.tmpl });
    }
    out.sort(function (x, y) { return x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind.localeCompare(y.kind); });
    return out;
  }

  /** Start something new. `from` is a template/asset id to fork, 'skeleton:NAME'
   *  to start from a bare rig, or nothing at all for an empty document. This is
   *  the start-from menu (§4.9): an empty viewport with no way in is where an
   *  in-tool-only editor dies. */
  function newAsset(kind, from, name) {
    kind = kind || 'unit';
    if (from && S.lib.assets[from]) return fork(from, name);
    var skel = 'static';
    if (String(from || '').indexOf('skeleton:') === 0) skel = String(from).slice(9);
    else if (kind === 'unit') skel = 'humanoid';
    var id = freeId(name || ('new-' + kind));
    var a = { kind: kind, id: id, name: name || ('New ' + kind), pub: false };
    if (kind !== 'terrain') {
      a.model = {
        v: 1, kind: 'model', id: id, name: a.name, skeleton: skel, scale: 1, weather: 0.1,
        proportions: skel === 'humanoid' ? { uniformC: '#4d5238', skinC: '#bfa07e', helmet: 'none', webbing: 'none', pack: false } : {},
        palette: [
          { id: 'body', c: '#6a6a5a', rough: 0.8 },
          { id: 'dark', c: '#3a3a32', rough: 0.9 },
          { id: 'team', c: '#ffffff', team: true },
        ],
        parts: [], attach: {}, flags: {},
      };
    }
    if (kind === 'unit') a.unit = {
      v: 1, kind: 'unit', id: id, name: a.name, model: 'tcm:' + id,
      faction: 'custom', role: 'lineInfantry', unitKind: 'rifle',
      hp: 100, spd: 4.2, dmg: 18, rng: 42, atkTime: 1.2, armor: 0.1, shield: 0,
      size: 1, vis: 40, color: '#6a6a5a',
    };
    if (kind === 'prop') a.prop = {
      v: 1, kind: 'prop', id: id, name: a.name, model: 'tcm:' + id,
      height: 1, hp: 80, cover: 0.35, color: '#6a6a5a', vary: 0.1,
    };
    if (kind === 'terrain') a.terrain = {
      v: 1, kind: 'terrain', id: slug(name || id), name: a.name, c: '#6a6258',
      speed: 1, passable: true, cover: 0.05, stealth: 0.05, carve: 0,
    };
    if (kind === 'roster') { delete a.model; a.roster = {
      v: 1, kind: 'roster', id: id, name: a.name, faction: 'custom',
      budget: 1200, entries: [], reinforce: [],
    }; }
    if (kind === 'faction') { delete a.model; a.faction = {
      v: 1, kind: 'faction', id: id, name: a.name, c: '#8a8a6a',
      doctrine: 'lineInfantry', bias: { armour: 1, infantry: 1, artillery: 1 },
    }; }
    S.lib.assets[id] = a;
    saveLib();
    open(id);
    return id;
  }

  /** Fork anything, including the stock templates. Nothing is a black box. */
  function fork(srcId, name) {
    var src = S.lib.assets[srcId];
    if (!src) { toast('No asset "' + srcId + '"', true); return null; }
    var a = clone(src);
    a.id = freeId(name || (src.name + ' copy'));
    a.name = name || (src.name + ' copy');
    a.stock = false; a.tmpl = false; a.pub = false;
    if (a.model) { a.model.id = a.id; a.model.name = a.name; }
    if (a.unit) { a.unit.id = a.id; a.unit.name = a.name; a.unit.model = 'tcm:' + a.id; }
    if (a.prop) { a.prop.id = a.id; a.prop.name = a.name; a.prop.model = 'tcm:' + a.id; }
    if (a.terrain) { a.terrain.id = slug(a.name); a.terrain.name = a.name; }
    S.lib.assets[a.id] = a;
    if (a.model) TCM.registerModel(a.model);
    saveLib();
    open(a.id);
    return a.id;
  }

  function open(id) {
    var a = S.lib.assets[id];
    if (!a) { toast('No asset "' + id + '"', true); return false; }
    S.id = id; S.kind = a.kind;
    S.doc = a.model || null;
    S.meta = a.unit || a.prop || a.terrain || a.roster || a.faction || null;
    S.sel = []; S.selBone = null;
    S.hist = []; S.histAt = -1;
    var flat = a.kind === 'terrain' || a.kind === 'roster' || a.kind === 'faction';
    if (flat) S.tab = 'stats';
    else if (S.tab === 'stats' && !a.model) S.tab = 'build';
    pushHist('open');
    rebuild();
    frame(false);
    renderAll();
    return true;
  }

  function rename(id, name) {
    var a = S.lib.assets[id]; if (!a || !name) return false;
    a.name = name;
    if (a.model) a.model.name = name;
    if (a.unit) a.unit.name = name;
    if (a.prop) a.prop.name = name;
    if (a.terrain) a.terrain.name = name;
    saveLib(); renderAll();
    return true;
  }

  function del(id) {
    var a = S.lib.assets[id]; if (!a) return false;
    delete S.lib.assets[id];
    saveLib();
    if (S.id === id) {
      var first = list()[0];
      if (first) open(first.id); else { S.id = null; S.doc = null; S.meta = null; rebuild(); }
    }
    renderAll();
    return true;
  }

  /** Save the selected parts as a reusable library entry. The single highest-
   *  value quality-of-life feature in the tool (§4.4) and it is nearly free:
   *  the saved entry is just a model, and `sh:'ref'` already instances models. */
  function saveToLibrary(name, ids) {
    ids = ids || S.sel;
    if (!S.doc || !ids.length) { toast('Select some parts first', true); return null; }
    var id = freeId(name || 'part');
    var picked = [], usedMats = {};
    for (var i = 0; i < ids.length; i++) {
      var p = part(ids[i]);
      if (!p) continue;
      var q = clone(p);
      q.j = 'body';           // a library part is authored in its own space
      usedMats[q.m] = 1;
      picked.push(q);
    }
    if (!picked.length) return null;
    var pal = (S.doc.palette || []).filter(function (m) { return usedMats[m.id]; });
    S.lib.assets[id] = {
      kind: 'part', id: id, name: name || 'Part',
      model: { v: 1, kind: 'model', id: id, name: name || 'Part', skeleton: 'static',
        palette: pal.length ? clone(pal) : [{ id: 'body', c: '#6a6a5a', rough: 0.8 }],
        parts: picked },
    };
    TCM.registerModel(S.lib.assets[id].model);
    saveLib(); renderAll();
    toast('Saved "' + (name || 'Part') + '" to the library');
    return id;
  }

  // =======================================================================
  // PART OPERATIONS
  // =======================================================================

  function addPart(spec) {
    spec = spec || {};
    if (!S.doc) return null;
    var sh = spec.sh || 'box';
    var id = spec.id || freePartId(S.doc);
    var p = {
      id: id, n: spec.n || sh, j: spec.j || (S.selBone || defaultJoint()), sh: sh,
      m: spec.m || firstMat(),
      p: spec.p ? spec.p.slice() : [0, 0, 0],
      r: spec.r ? spec.r.slice() : [0, 0, 0],
      d: spec.d ? clone(spec.d) : clone(SHAPE_DIMS[sh] || SHAPE_DIMS.box),
    };
    if (sh === 'node') { delete p.m; p.tags = spec.tags || []; }
    if (spec.s) p.s = spec.s.slice();
    if (spec.mirror) p.mirror = true;
    if (spec.edge) p.edge = true;
    if (spec.tags) p.tags = spec.tags.slice();
    if (sh === 'ref' && spec.ref) p.d = { ref: spec.ref };
    // Drop it where the camera is looking, so "add a box" puts the box where
    // the player is working rather than always at the joint origin.
    if (!spec.p && spec.atCursor !== false) {
      var jn = joints().indexOf(p.j) >= 0 ? p.j : 'body';
      p.j = jn;
    }
    edit('add ' + p.n, function () {
      if (!S.doc.parts) S.doc.parts = [];
      S.doc.parts.push(p);
      S.sel = [p.id];
    });
    return p.id;
  }

  function defaultJoint() {
    var j = joints();
    return j.indexOf('spine') >= 0 ? 'spine' : j.indexOf('torso') >= 0 ? 'torso' : j[0] || 'body';
  }
  function firstMat() {
    var pal = (S.doc && S.doc.palette) || [];
    for (var i = 0; i < pal.length; i++) if (!pal[i].team && !pal[i].glow) return pal[i].id;
    return pal.length ? pal[0].id : undefined;
  }

  function dupPart(id) {
    var src = part(id || S.sel[0]);
    if (!src) return null;
    var q = clone(src);
    q.id = freePartId(S.doc);
    q.n = src.n + ' copy';
    edit('duplicate', function () { S.doc.parts.push(q); S.sel = [q.id]; });
    return q.id;
  }

  function delPart(ids) {
    ids = ids == null ? S.sel.slice() : (Array.isArray(ids) ? ids : [ids]);
    if (!ids.length || !S.doc) return false;
    return edit('delete', function () {
      S.doc.parts = (S.doc.parts || []).filter(function (p) { return ids.indexOf(p.id) < 0; });
      // Anything that pointed at a deleted part has to let go, or the document
      // fails validation with a dangling attach.
      var at = S.doc.attach || {};
      for (var k in at) if (ids.indexOf(at[k]) >= 0) at[k] = null;
      S.sel = [];
    });
  }

  /** Patch a part. Accepts partial specs — `{p:[…]}`, `{m:'iron'}`,
   *  `{d:{w:0.4}}` (merged, not replaced), `{sh:'wedge'}` (dims re-defaulted
   *  for the new shape but anything shared is kept). */
  function setPart(id, patch) {
    var p = part(id);
    if (!p || !patch) return false;
    return edit('edit ' + (p.n || id), function () {
      for (var k in patch) {
        if (k === 'd') {
          p.d = p.d || {};
          for (var dk in patch.d) {
            if (patch.d[dk] === null) delete p.d[dk]; else p.d[dk] = patch.d[dk];
          }
        } else if (k === 'sh' && patch.sh !== p.sh) {
          var keep = p.d || {}, base = clone(SHAPE_DIMS[patch.sh] || {});
          for (var bk in base) if (keep[bk] !== undefined) base[bk] = keep[bk];
          p.sh = patch.sh; p.d = base;
          if (patch.sh === 'node') { delete p.m; p.tags = p.tags || []; }
          else if (!p.m) p.m = firstMat();
        } else if (patch[k] === null) delete p[k];
        else p[k] = patch[k];
      }
    });
  }

  function move(id, d, absolute) {
    var p = part(id || S.sel[0]); if (!p) return false;
    var base = p.p || [0, 0, 0];
    var np = absolute ? d.slice() : [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
    if (S.snap > 0) for (var i = 0; i < 3; i++) np[i] = Math.round(np[i] / S.snap) * S.snap;
    for (var j = 0; j < 3; j++) np[j] = Math.round(np[j] * 1e5) / 1e5;
    return setPart(p.id, { p: np });
  }

  function rotate(id, dDeg, absolute) {
    var p = part(id || S.sel[0]); if (!p) return false;
    var base = p.r || [0, 0, 0], out = [];
    for (var i = 0; i < 3; i++) {
      var deg = (absolute ? 0 : base[i] * 180 / Math.PI) + (dDeg[i] || 0);
      if (S.angSnap > 0) deg = Math.round(deg / S.angSnap) * S.angSnap;
      out[i] = Math.round(deg * Math.PI / 180 * 1e5) / 1e5;
    }
    return setPart(p.id, { r: out });
  }

  function scalePart(id, s) {
    var p = part(id || S.sel[0]); if (!p) return false;
    var b = p.s || [1, 1, 1];
    return setPart(p.id, { s: [b[0] * s, b[1] * s, b[2] * s] });
  }

  function mirror(id, on) {
    var p = part(id || S.sel[0]); if (!p) return false;
    return setPart(p.id, { mirror: (on == null ? !p.mirror : !!on) ? true : null });
  }

  function setMat(id, matId) {
    var ids = id == null ? S.sel : (Array.isArray(id) ? id : [id]);
    if (!ids.length) return false;
    return edit('paint', function () {
      ids.forEach(function (i) { var p = part(i); if (p && p.sh !== 'node') p.m = matId; });
    });
  }

  /** Fill by joint / by shape / everything — the fast way to restyle a model. */
  function fillMat(matId, by, value) {
    if (!S.doc) return false;
    return edit('fill', function () {
      (S.doc.parts || []).forEach(function (p) {
        if (p.sh === 'node') return;
        if (by === 'joint' && (p.j || 'body') !== value) return;
        if (by === 'shape' && (p.sh || 'box') !== value) return;
        if (by === 'mat' && p.m !== value) return;
        p.m = matId;
      });
    });
  }

  function setMod(id, mod) {
    var p = part(id || S.sel[0]); if (!p) return false;
    return edit('modifier', function () {
      if (!mod) { delete p.mod; return; }
      p.mod = p.mod || {};
      for (var k in mod) {
        if (mod[k] === null) delete p.mod[k];
        else p.mod[k] = clone(mod[k]);
      }
      if (!Object.keys(p.mod).length) delete p.mod;
    });
  }

  function setTag(id, tag, on) {
    var p = part(id || S.sel[0]); if (!p) return false;
    return edit('tag', function () {
      var t = (p.tags || []).slice();
      var at = t.indexOf(tag);
      if (on == null) on = at < 0;
      if (on && at < 0) t.push(tag);
      if (!on && at >= 0) t.splice(at, 1);
      p.tags = t;
      // A tagged node is what the engine binds to, so keep `attach` in step.
      S.doc.attach = S.doc.attach || {};
      if (tag === 'muzzle' || tag === 'barrelTip' || tag === 'turret')
        S.doc.attach[tag] = on ? p.id : (S.doc.attach[tag] === p.id ? null : S.doc.attach[tag]);
    });
  }

  function select(ids, add) {
    ids = ids == null ? [] : (Array.isArray(ids) ? ids : [ids]);
    S.sel = add ? S.sel.concat(ids.filter(function (i) { return S.sel.indexOf(i) < 0; })) : ids;
    syncOverlay();
    renderTree(); renderInspector();
    return S.sel.slice();
  }

  // =======================================================================
  // PALETTE
  // =======================================================================

  function addMat(spec) {
    if (!S.doc) return null;
    spec = spec || {};
    var base = slug(spec.id || spec.name || 'mat'), id = base, n = 2;
    while (mat(id)) id = base + n++;
    var m = { id: id, c: spec.c || '#7a7a6a', rough: num(spec.rough, 0.8) };
    if (spec.metal) m.metal = spec.metal;
    if (spec.flat === false) m.flat = false;
    if (spec.glow) m.glow = true;
    if (spec.team) m.team = spec.team === 2 ? 2 : true;
    if (spec.emissive) m.emissive = spec.emissive;
    edit('add material', function () {
      S.doc.palette = S.doc.palette || [];
      S.doc.palette.push(m);
    });
    return id;
  }

  function setMatDef(id, patch) {
    var m = mat(id); if (!m || !patch) return false;
    return edit('material', function () {
      for (var k in patch) { if (patch[k] === null) delete m[k]; else m[k] = patch[k]; }
    });
  }

  function delMat(id) {
    if (!mat(id)) return false;
    var users = (S.doc.parts || []).filter(function (p) { return p.m === id; }).length;
    if (users && !confirmish(users + ' part(s) use "' + id + '". Delete anyway? They fall back to the first material.')) return false;
    return edit('delete material', function () {
      S.doc.palette = S.doc.palette.filter(function (m) { return m.id !== id; });
      var fb = firstMat();
      (S.doc.parts || []).forEach(function (p) { if (p.m === id) p.m = fb; });
    });
  }

  function setWeather(v) {
    if (!S.doc) return false;
    return edit('weathering', function () { S.doc.weather = Math.max(0, Math.min(0.6, num(v, 0))); });
  }

  // =======================================================================
  // RIG
  // =======================================================================

  function setSkeleton(skel) {
    if (!S.doc || TCM.SKELETONS.indexOf(skel) < 0) return false;
    var keep = TCM.JOINTS[skel];
    return edit('skeleton → ' + skel, function () {
      S.doc.skeleton = skel;
      // Parts on joints the new skeleton doesn't have would fail validation, so
      // they fall back to `body` — visible and fixable, rather than a hard error.
      var moved = 0;
      (S.doc.parts || []).forEach(function (p) {
        var j = p.j || 'body';
        if (keep.indexOf(j) < 0 && !bone(j)) { p.j = 'body'; moved++; }
      });
      if (moved) toast(moved + ' part(s) moved to `body` — that joint is not on a ' + skel + ' rig');
    });
  }

  function setProportion(k, v) {
    if (!S.doc) return false;
    return edit('proportion', function () {
      S.doc.proportions = S.doc.proportions || {};
      if (v === null || v === '') delete S.doc.proportions[k];
      else S.doc.proportions[k] = v;
    });
  }

  function setFlag(k, v) {
    if (!S.doc) return false;
    return edit('flag', function () {
      S.doc.flags = S.doc.flags || {};
      if (v === null || v === false) delete S.doc.flags[k];
      else S.doc.flags[k] = v;
    });
  }

  function addBone(spec) {
    if (!S.doc) return null;
    spec = spec || {};
    var base = slug(spec.id || spec.name || 'bone'), id = base, n = 2;
    var taken = {}; joints().forEach(function (j) { taken[j] = 1; });
    while (taken[id]) id = base + n++;
    var b = { id: id, parent: spec.parent || S.selBone || 'body',
      p: spec.p ? spec.p.slice() : [0, 0, 0] };
    if (spec.r) b.r = spec.r.slice();
    if (spec.tag) b.tag = spec.tag;
    edit('add bone', function () {
      S.doc.bones = S.doc.bones || [];
      S.doc.bones.push(b);
      S.selBone = id;
    });
    return id;
  }

  function setBone(id, patch) {
    var b = bone(id); if (!b || !patch) return false;
    if (patch.parent) {
      // Guard the two ways a reparent can corrupt a rig: onto itself, or onto
      // one of its own descendants.
      if (patch.parent === id) return false;
      var cur = patch.parent, guard = 0;
      while (cur && guard++ < 64) {
        if (cur === id) { toast('That would make a cycle', true); return false; }
        var pb = bone(cur); cur = pb && pb.parent;
      }
    }
    return edit('bone', function () {
      for (var k in patch) { if (patch[k] === null) delete b[k]; else b[k] = patch[k]; }
    });
  }

  function delBone(id) {
    var b = bone(id); if (!b) return false;
    var users = (S.doc.parts || []).filter(function (p) { return (p.j || 'body') === id; }).length;
    return edit('delete bone', function () {
      var parent = b.parent || 'body';
      S.doc.bones = (S.doc.bones || []).filter(function (x) { return x.id !== id; });
      (S.doc.bones || []).forEach(function (x) { if (x.parent === id) x.parent = parent; });
      (S.doc.parts || []).forEach(function (p) { if ((p.j || 'body') === id) p.j = parent; });
      S.doc.drivers = (S.doc.drivers || []).filter(function (d) { return d.bone !== id; });
      if (S.selBone === id) S.selBone = null;
      if (users) toast(users + ' part(s) reparented to "' + parent + '"');
    });
  }

  /** Build one arm, get the other: copies a bone subtree with L/R substitution
   *  in the ids, plus every part hanging off it. */
  function mirrorBone(id) {
    var root = bone(id); if (!root) return false;
    var flip = function (s) {
      return /L$|Left/.test(s) ? s.replace(/L$/, 'R').replace(/Left/, 'Right')
        : /R$|Right/.test(s) ? s.replace(/R$/, 'L').replace(/Right/, 'Left') : s + '-m';
    };
    var subtree = [], seen = {};
    (function walk(bid) {
      seen[bid] = 1;
      (S.doc.bones || []).forEach(function (b) {
        if (b.parent === bid && !seen[b.id]) { subtree.push(b); walk(b.id); }
      });
    })(id);
    subtree.unshift(root);
    return edit('mirror bone', function () {
      var map = {};
      subtree.forEach(function (b) { map[b.id] = flip(b.id); });
      subtree.forEach(function (b) {
        var q = clone(b);
        q.id = map[b.id];
        q.parent = map[b.parent] || b.parent;
        if (q.p) q.p[0] = -q.p[0];
        if (q.r) { q.r[1] = -q.r[1]; q.r[2] = -q.r[2]; }
        if (q.tag) q.tag = flip(q.tag);
        S.doc.bones.push(q);
      });
      (S.doc.parts || []).slice().forEach(function (p) {
        if (!map[p.j || '']) return;
        var q = clone(p);
        q.id = freePartId(S.doc);
        q.j = map[p.j];
        if (q.p) q.p[0] = -q.p[0];
        if (q.r) { q.r[1] = -q.r[1]; q.r[2] = -q.r[2]; }
        delete q.tags;
        S.doc.parts.push(q);
      });
    });
  }

  function addDriver(spec) {
    if (!S.doc) return null;
    spec = spec || {};
    var d = { bone: spec.bone || S.selBone || 'body', kind: spec.kind || 'spin',
      axis: spec.axis || 'y', amp: num(spec.amp, 0.2), rate: num(spec.rate, 1) };
    if (spec.when) d.when = spec.when;
    if (spec.phase) d.phase = spec.phase;
    edit('add driver', function () {
      S.doc.drivers = S.doc.drivers || [];
      S.doc.drivers.push(d);
    });
    return (S.doc.drivers || []).length - 1;
  }

  function setDriver(i, patch) {
    var ds = (S.doc && S.doc.drivers) || [];
    if (!ds[i] || !patch) return false;
    return edit('driver', function () {
      for (var k in patch) { if (patch[k] === null || patch[k] === '') delete ds[i][k]; else ds[i][k] = patch[k]; }
    });
  }

  function delDriver(i) {
    var ds = (S.doc && S.doc.drivers) || [];
    if (!ds[i]) return false;
    return edit('delete driver', function () { ds.splice(i, 1); });
  }

  // =======================================================================
  // CLIPS — Tier 3 authoring  (FORGE_PLAN §6.6)
  // =======================================================================

  function clips() { return (S.doc && S.doc.clips) || null; }
  function clip(name) { var c = clips(); return c && c[name] || null; }

  function addClip(name, spec) {
    if (!S.doc) return null;
    name = name || S.pose;
    spec = spec || {};
    edit('add clip', function () {
      S.doc.clips = S.doc.clips || {};
      S.doc.clips[name] = {
        dur: num(spec.dur, 1), loop: spec.loop !== false,
        speedSync: spec.speedSync !== false && (name === 'walk' || name === 'run' || name === 'crawl' || name === 'sneak'),
        tracks: spec.tracks || [], events: spec.events || [],
      };
    });
    S.clip = name;
    return name;
  }

  function delClip(name) {
    if (!clip(name)) return false;
    return edit('delete clip', function () {
      delete S.doc.clips[name];
      if (!Object.keys(S.doc.clips).length) delete S.doc.clips;
    });
  }

  function setClip(name, patch) {
    var c = clip(name); if (!c || !patch) return false;
    return edit('clip', function () {
      for (var k in patch) { if (patch[k] === null) delete c[k]; else c[k] = patch[k]; }
    });
  }

  function addTrack(name, bone, ch) {
    var c = clip(name); if (!c) return false;
    var exists = c.tracks.some(function (t) { return t.b === bone && t.ch === ch; });
    if (exists) { toast('That bone already has a ' + ch + ' track'); return false; }
    return edit('add track', function () {
      c.tracks.push({ b: bone, ch: ch, ease: 'linear', k: [[0, 0], [c.dur, 0]] });
    });
  }

  function delTrack(name, i) {
    var c = clip(name); if (!c || !c.tracks[i]) return false;
    return edit('delete track', function () { c.tracks.splice(i, 1); });
  }

  /** Set (or insert) a key at time t on a track. The timeline calls this; so
   *  can a script, which is the only way to author a clip reliably here. */
  function setKey(name, trackI, t, v) {
    var c = clip(name); if (!c || !c.tracks[trackI]) return false;
    var tr = c.tracks[trackI];
    return edit('key', function () {
      t = Math.max(0, Math.min(c.dur, Math.round(t * 1000) / 1000));
      var at = -1;
      for (var i = 0; i < tr.k.length; i++) if (Math.abs(tr.k[i][0] - t) < 1e-4) { at = i; break; }
      if (v === null) { if (at >= 0 && tr.k.length > 1) tr.k.splice(at, 1); return; }
      v = Math.round(v * 1e4) / 1e4;
      if (at >= 0) tr.k[at][1] = v; else tr.k.push([t, v]);
      tr.k.sort(function (a, b) { return a[0] - b[0]; });
    });
  }

  function setEvent(name, i, patch) {
    var c = clip(name); if (!c) return false;
    return edit('clip event', function () {
      c.events = c.events || [];
      if (patch === null) { c.events.splice(i, 1); return; }
      if (i == null || i < 0) c.events.push({ t: num(patch.t, 0), e: patch.e || 'footstep' });
      else for (var k in patch) c.events[i][k] = patch[k];
      c.events.sort(function (a, b) { return a.t - b.t; });
    });
  }

  /** BORROW FROM STOCK — sample the hand-written infantry pose engine and emit
   *  it as keyframes on this model's tagged bones. A fork always beats a blank
   *  timeline (§6.6), and it means a from-scratch skeleton starts from a walk
   *  cycle that a person animated rather than one a player has to invent. */
  function borrowClip(stance, targetName) {
    if (!S.doc) return null;
    var P = G.INFPOSE && G.INFPOSE[stance];
    if (!P) { toast('No stock pose called "' + stance + '"', true); return null; }
    var name = targetName || stance;
    var tagged = tagMap();
    var dur = P.gait > 0.01 ? (Math.PI * 2 / P.gait) : 1;
    var N = P.gait > 0.01 ? 9 : 2;                     // 8 samples + the wrap
    var tracks = [];
    var push = function (tag, ch, fn) {
      var bone = tagged[tag];
      if (!bone) return;
      var keys = [];
      for (var i = 0; i < N; i++) {
        var u = i / (N - 1);                            // 0..1 of the cycle
        var bt = u * Math.PI * 2;
        keys.push([Math.round(u * dur * 1000) / 1000, Math.round(fn(bt) * 1e4) / 1e4]);
      }
      tracks.push({ b: bone, ch: ch, ease: 'linear', k: keys });
    };
    var amp = P.amp, swing = function (b) { return amp > 0.001 ? Math.sin(b) : 0; };
    var swing2 = function (b) { return amp > 0.001 ? Math.sin(b + Math.PI) : 0; };
    var bounce = function (b) { return amp > 0.001 ? Math.abs(Math.sin(b)) : 0; };
    push('thighL', 'rx', function (b) { return P.lx + swing(b) * amp; });
    push('thighR', 'rx', function (b) { return P.lx + swing2(b) * amp; });
    push('kneeL', 'rx', function (b) { return P.kx + Math.max(0, -swing(b)) * amp * 1.15; });
    push('kneeR', 'rx', function (b) { return P.kx + Math.max(0, -swing2(b)) * amp * 1.15; });
    push('spine', 'rx', function (b) { return P.sx + (amp > 0.001 ? -bounce(b) * 0.04 : 0); });
    push('spine', 'ry', function (b) { return P.sy + (amp > 0.001 ? swing(b) * 0.09 : 0); });
    push('head', 'rx', function () { return P.hx; });
    push('shoulderL', 'rx', function (b) { return P.aLx + (amp > 0.001 ? swing2(b) * 0.16 : 0); });
    push('shoulderR', 'rx', function (b) { return P.aRx - (amp > 0.001 ? swing2(b) * 0.16 : 0); });
    push('shoulderL', 'rz', function () { return P.aLz; });
    push('shoulderR', 'rz', function () { return P.aRz; });
    push('elbowL', 'rx', function () { return P.eLx; });
    push('elbowR', 'rx', function () { return P.eRx; });
    push('hips', 'py', function (b) {
      var rest = restOf(tagged.hips);
      return rest + P.by + bounce(b) * 0.05 * (amp / 0.6 || 0);
    });
    if (!tracks.length) {
      toast('This skeleton has no tagged bones yet — tag `thighL`, `kneeL`, `spine`, `head` on the Rig tab first.', true);
      return null;
    }
    var events = [];
    if (P.gait > 0.01) events = [{ t: Math.round(dur * 0.05 * 1000) / 1000, e: 'footstep' },
                                 { t: Math.round(dur * 0.55 * 1000) / 1000, e: 'footstep' }];
    addClip(name, { dur: Math.round(dur * 1000) / 1000, loop: P.gait > 0.01,
      speedSync: P.gait > 0.01, tracks: tracks, events: events });
    toast('Borrowed "' + stance + '" — ' + tracks.length + ' tracks from the stock pose engine');
    return name;
  }

  /** The timeline: one row per (bone, channel), keys draggable along the row.
   *  Compact rather than pretty — a 250px panel is not a DCC dope sheet, so the
   *  numbers stay reachable and every key is also settable from the API. */
  function timeline(name, c) {
    var wrap = h('div', { style: 'margin:4px 0' });
    var head = h('div', 'fg-h');
    head.appendChild(h('span', { text: 'tracks' }));
    var addSel = h('select', { style: 'flex:1;font-size:9.5px', onkeydown: function (e) { e.stopPropagation(); } });
    addSel.appendChild(h('option', { value: '', text: '+ track…' }));
    joints().forEach(function (j) {
      ['rx', 'ry', 'rz', 'px', 'py', 'pz'].forEach(function (ch) {
        addSel.appendChild(h('option', { value: j + '|' + ch, text: j + ' · ' + ch }));
      });
    });
    addSel.addEventListener('change', function () {
      if (!addSel.value) return;
      var p = addSel.value.split('|');
      addTrack(name, p[0], p[1]);
      addSel.value = '';
    });
    head.appendChild(addSel);
    wrap.appendChild(head);

    (c.tracks || []).forEach(function (tr, ti) {
      var row = h('div', { style: 'margin:2px 0' });
      row.appendChild(h('div', { style: 'display:flex;align-items:center;gap:4px' }, [
        h('span', { style: 'flex:1;font-size:9.5px;color:var(--t1);overflow:hidden;text-overflow:ellipsis', text: tr.b + ' · ' + tr.ch }),
        h('span', { class: 'fg-b', style: 'padding:0 5px;font-size:9px', text: tr.ease || 'linear',
          onclick: function () {
            var order = ['linear', 'ease', 'step'];
            setClip(name, {});   // no-op to keep the edit shape uniform
            edit('tangent', function () { tr.ease = order[(order.indexOf(tr.ease || 'linear') + 1) % 3]; });
          } }),
        h('span', { class: 'x', text: '✕', onclick: function () { delTrack(name, ti); } }),
      ]));
      // The key strip: click empty space to add a key at that time, click a key
      // to select it, and edit its value in the box underneath.
      var strip = h('div', { style: 'position:relative;height:14px;background:#0e131a;border:1px solid var(--border);' +
        'border-radius:3px;cursor:crosshair;margin:1px 0' });
      strip.addEventListener('click', function (e) {
        var r = strip.getBoundingClientRect();
        var t = (e.clientX - r.left) / Math.max(1, r.width) * c.dur;
        var near = null;
        tr.k.forEach(function (k, i) { if (Math.abs(k[0] - t) < c.dur * 0.04) near = i; });
        if (near != null) { S.key = { c: name, t: ti, i: near }; renderRight(); return; }
        setKey(name, ti, t, sampleAt(tr, t));
      });
      tr.k.forEach(function (k, i) {
        var sel = S.key && S.key.c === name && S.key.t === ti && S.key.i === i;
        strip.appendChild(h('div', { style: 'position:absolute;top:1px;bottom:1px;width:5px;margin-left:-2px;border-radius:2px;' +
          'left:' + (k[0] / c.dur * 100) + '%;background:' + (sel ? 'var(--accent)' : '#5a9ae0') }));
      });
      row.appendChild(strip);
      var sk = S.key && S.key.c === name && S.key.t === ti ? tr.k[S.key.i] : null;
      if (sk) {
        var kr = h('div', 'fg-row');
        kr.appendChild(h('label', { text: 'key ' + S.key.i }));
        var tin = h('input', { type: 'number', step: 0.01, value: sk[0],
          onchange: function () { setKey(name, ti, sk[0], null); setKey(name, ti, parseFloat(tin.value) || 0, sk[1]); },
          onkeydown: function (e) { e.stopPropagation(); } });
        var vin = h('input', { type: 'number', step: 0.02, value: sk[1],
          onchange: function () { setKey(name, ti, sk[0], parseFloat(vin.value) || 0); },
          onkeydown: function (e) { e.stopPropagation(); } });
        kr.appendChild(tin); kr.appendChild(vin);
        kr.appendChild(h('span', { class: 'x', text: '✕', onclick: function () { setKey(name, ti, sk[0], null); S.key = null; } }));
        row.appendChild(kr);
      }
      wrap.appendChild(row);
    });
    if (!(c.tracks || []).length)
      wrap.appendChild(h('div', { class: 'fg-note', text: 'No tracks. Add one above, or borrow a stock pose.' }));
    return wrap;
  }

  function sampleAt(tr, t) {
    return TCM.clips.sample({ k: tr.k, ease: tr.ease }, t);
  }

  /** tag → bone id, for the model as it stands. */
  function tagMap() {
    var out = {};
    var skel = (S.doc && S.doc.skeleton) || 'static';
    var preset = TCM.STOCK_TAGS[skel] || {};
    var have = joints();
    for (var t in preset) if (have.indexOf(preset[t]) >= 0) out[t] = preset[t];
    ((S.doc && S.doc.bones) || []).forEach(function (b) { if (b.tag) out[b.tag] = b.id; });
    return out;
  }

  function restOf(boneId) {
    var b = bone(boneId);
    return b && b.p ? num(b.p[1], 0) : 0;
  }

  /** Bespoke poses (§4.7): override individual INFPOSE channels for THIS model
   *  only, so a hunched thing gets its own gait instead of wearing a human's.
   *  Diff-based — one tweak costs about twenty bytes. */
  function setPoseChannel(poseName, ch, v) {
    if (!S.doc) return false;
    return edit('pose override', function () {
      S.doc.poses = S.doc.poses || {};
      var p = S.doc.poses[poseName] = S.doc.poses[poseName] || {};
      if (v === null || v === '') delete p[ch];
      else p[ch] = v;
      if (!Object.keys(p).length) delete S.doc.poses[poseName];
      if (!Object.keys(S.doc.poses).length) delete S.doc.poses;
    });
  }

  // =======================================================================
  // WEAPONS AND ABILITIES  (FORGE_PLAN §7.1, §7.2)
  // =======================================================================

  function weaponList() { return (S.meta && S.meta.weapons) || []; }

  function addWeapon(spec) {
    if (!S.meta) return null;
    spec = spec || {};
    var w = {
      v: 1, kind: 'weapon',
      id: slug(spec.id || spec.name || ('weapon-' + (weaponList().length + 1))),
      name: spec.name || 'New weapon',
      slot: spec.slot || (weaponList().length ? 'secondary' : 'primary'),
      modes: spec.modes || [defaultMode()],
      ammo: num(spec.ammo, 0), reload: num(spec.reload, 0),
    };
    edit('add weapon', function () {
      S.meta.weapons = S.meta.weapons || [];
      S.meta.weapons.push(w);
    });
    S.weapon = S.meta.weapons.length - 1;
    return w.id;
  }

  function defaultMode() {
    return {
      name: 'Primary', trigger: 'hip', projectile: 'bullet',
      dmg: 20, rof: 60, cone: 0.02, burst: 1, gap: 0.075,
      rng: 45, needsLos: true, lay: true, flash: 0.5, sfx: 'rifle',
    };
  }

  function delWeapon(i) {
    if (!weaponList()[i]) return false;
    return edit('delete weapon', function () {
      S.meta.weapons.splice(i, 1);
      if (!S.meta.weapons.length) delete S.meta.weapons;
    });
  }

  function setWeapon(i, patch) {
    var w = weaponList()[i]; if (!w || !patch) return false;
    return edit('weapon', function () {
      for (var k in patch) { if (patch[k] === null) delete w[k]; else w[k] = patch[k]; }
    });
  }

  function addMode(wi, spec) {
    var w = weaponList()[wi]; if (!w) return false;
    return edit('add mode', function () {
      w.modes.push(Object.assign(defaultMode(), { name: 'Alt', trigger: 'ads' }, spec || {}));
    });
  }

  function setMode(wi, mi, patch) {
    var w = weaponList()[wi]; if (!w || !w.modes[mi] || !patch) return false;
    return edit('mode', function () {
      for (var k in patch) { if (patch[k] === null) delete w.modes[mi][k]; else w.modes[mi][k] = patch[k]; }
    });
  }

  function delMode(wi, mi) {
    var w = weaponList()[wi]; if (!w || w.modes.length < 2) { toast('A weapon needs at least one mode', true); return false; }
    return edit('delete mode', function () { w.modes.splice(mi, 1); });
  }

  /** Start from a stock unit's armament expressed as data. With the parity
   *  table behind it, this is a real starting point rather than a guess. */
  function borrowWeapon(unitKey) {
    if (!S.meta) return null;
    var def = G.UNIT_DEFS[unitKey];
    if (!def) { toast('No unit "' + unitKey + '"', true); return null; }
    var w = TCM.weaponFromDef(def, unitKey);
    w.id = slug(unitKey + '-armament');
    w.name = def.name + ' armament';
    w.slot = weaponList().length ? 'secondary' : 'primary';
    edit('borrow weapon', function () {
      S.meta.weapons = S.meta.weapons || [];
      S.meta.weapons.push(w);
    });
    S.weapon = S.meta.weapons.length - 1;
    toast('Borrowed the ' + def.name + '\'s armament — ' + w.modes.length + ' mode(s)');
    return w.id;
  }

  function abilityList() { return (S.meta && S.meta.abilities) || []; }

  function addAbility(name, spec) {
    if (!S.meta || !TCM.ABILITIES[name]) return false;
    spec = spec || {};
    return edit('add ability', function () {
      S.meta.abilities = S.meta.abilities || [];
      if (S.meta.abilities.some(function (a) { return a.a === name; })) return false;
      S.meta.abilities.push({ a: name, trigger: spec.trigger || 'order',
        key: spec.key || null, cd: num(spec.cd, 6), params: spec.params || {} });
    });
  }

  function setAbility(i, patch) {
    var a = abilityList()[i]; if (!a || !patch) return false;
    return edit('ability', function () {
      for (var k in patch) {
        if (k === 'params') a.params = Object.assign(a.params || {}, patch.params);
        else if (patch[k] === null) delete a[k]; else a[k] = patch[k];
      }
    });
  }

  function delAbility(i) {
    if (!abilityList()[i]) return false;
    return edit('delete ability', function () {
      S.meta.abilities.splice(i, 1);
      if (!S.meta.abilities.length) delete S.meta.abilities;
    });
  }

  // =======================================================================
  // META (unit / prop / terrain fields)
  // =======================================================================

  function setMeta(patch) {
    if (!S.meta || !patch) return false;
    return edit('stats', function () {
      for (var k in patch) {
        if (patch[k] === null) delete S.meta[k];
        else S.meta[k] = patch[k];
      }
      if (patch.name && S.doc) S.doc.name = patch.name;
    });
  }

  // =======================================================================
  // SCULPTING  (FORGE_PLAN §4.10)
  // =======================================================================
  //
  // Two tiers, and which one you are in is explicit and visible:
  //
  //   TIER 1 — sparse deltas on top of the parametric shape. The box stays a
  //            box: widen it and the dent widens with it, mirroring still
  //            works, modifiers still work, and the whole thing is a few dozen
  //            integers in the document.
  //   TIER 2 — `sh:'mesh'`, one-way, for surgery that changes topology. Still an
  //            ordinary part: same joint, material, transform, mirror, modifiers.
  //
  // Selection lives in editor state, never in the document — it is a view of
  // the model, not part of it.

  var SC = {
    on: false,           // sculpt mode active
    part: null,          // the part being sculpted
    mode: 'vertex',      // vertex | edge | face
    sel: [],             // selected indices (vertices, or faces in face mode)
    radius: 0.12,        // soft-selection falloff, in unit space
    strength: 0.03,
    sym: true,
    mesh: null,          // the working { v, f, sym } for the current part
    points: null,        // THREE.Points overlay
    hi: null,            // selection highlight
  };

  function sculptTarget() { return part(SC.part) || part(S.sel[0]); }

  /** Enter sculpt mode on the selected part. Adds an empty sculpt layer if the
   *  part hasn't got one — the shape does not change, it just becomes editable. */
  function sculptBegin(id, res) {
    var p = part(id || S.sel[0]);
    if (!p) { toast('Select a part first', true); return false; }
    var meshable = TCM.mesh.MESHABLE.indexOf(p.sh || 'box') >= 0;
    if (!meshable && p.sh !== 'mesh') {
      toast('"' + p.sh + '" is not sculptable. Convert it to an editable mesh first, or use box/plate/wedge/trapezoid/prism/cyl/cone/sph.', true);
      return false;
    }
    if (p.sh !== 'mesh' && !p.sculpt) {
      edit('sculpt layer', function () { p.sculpt = { res: num(res, 1), sym: 'x', d: [] }; });
    } else if (p.sh !== 'mesh' && res != null && p.sculpt.res !== res) {
      setSculptRes(p.id, res);
    }
    SC.on = true; SC.part = p.id; SC.sel = [];
    S.sel = [p.id];
    S.tab = 'sculpt'; S.showBones = false;
    syncSculpt();
    return true;
  }

  function sculptEnd() {
    SC.on = false; SC.sel = [];
    clearSculptOverlay();
    renderAll();
    return true;
  }

  /** Decode the part into a working mesh: either the parametric base plus its
   *  deltas (Tier 1) or the stored topology (Tier 2). */
  function syncSculpt() {
    var p = sculptTarget();
    clearSculptOverlay();
    if (!p) { SC.mesh = null; renderAll(); return; }
    if (p.sh === 'mesh') {
      var dec = TCM.mesh.decode(p.d || {});
      SC.mesh = { v: dec.v, f: dec.f, sym: TCM.mesh.symmetryMap(dec), tier: 2, scale: [1, 1, 1] };
    } else {
      var base = TCM.mesh.base(p.sh || 'box', p.d, (p.sculpt && p.sculpt.res) || 0);
      var m = TCM.mesh.applySculpt(base, p.sculpt || { d: [] });
      SC.mesh = { v: m.v, f: m.f, sym: base.sym, tier: 1, scale: TCM.mesh.dimScale(p.sh || 'box', p.d) };
    }
    buildSculptOverlay();
    renderAll();
  }

  /** Change the subdivision level. Deltas index into the mesh, so this is the
   *  one operation that can strand them — say so rather than silently dropping. */
  function setSculptRes(id, res) {
    var p = part(id || SC.part); if (!p || p.sh === 'mesh') return false;
    res = Math.max(0, Math.min(3, res | 0));
    var had = ((p.sculpt && p.sculpt.d) || []).length;
    var vcount = TCM.mesh.base(p.sh || 'box', p.d, res).v.length / 3;
    var r = edit('sculpt resolution', function () {
      p.sculpt = p.sculpt || { res: 0, sym: 'x', d: [] };
      p.sculpt.res = res;
      var kept = (p.sculpt.d || []).filter(function (e) { return e[0] < vcount; });
      if (kept.length !== had) toast((had - kept.length) + ' sculpt edit(s) dropped — they were past the new resolution', true);
      p.sculpt.d = kept;
    });
    syncSculpt();
    return r;
  }

  /** Selection. Every one of these is callable, because the browser pane's
   *  synthesised drags can't be trusted to drive a sculpt. */
  function sculptSelect(idx, add) {
    idx = idx == null ? [] : (Array.isArray(idx) ? idx : [idx]);
    SC.sel = add ? SC.sel.concat(idx.filter(function (i) { return SC.sel.indexOf(i) < 0; })) : idx.slice();
    highlightSculpt();
    renderRight();
    return SC.sel.slice();
  }

  function sculptSelectAll() {
    var n = SC.mode === 'face' ? SC.mesh.f.length / 3 : SC.mesh.v.length / 3;
    var all = [];
    for (var i = 0; i < n; i++) all.push(i);
    return sculptSelect(all);
  }

  /** Vertices within a world-space box, so a test can grab "the top face" or
   *  "everything on the left" without knowing an index. */
  function sculptSelectBox(min, max, add) {
    if (!SC.mesh) return [];
    var hit = [], v = SC.mesh.v, s = SC.mesh.scale;
    for (var i = 0; i < v.length / 3; i++) {
      var x = v[i * 3] * s[0], y = v[i * 3 + 1] * s[1], z = v[i * 3 + 2] * s[2];
      if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]) hit.push(i);
    }
    if (SC.mode === 'face') {
      var inSel = {}; hit.forEach(function (i) { inSel[i] = 1; });
      var faces = [];
      for (var t = 0; t < SC.mesh.f.length / 3; t++)
        if (inSel[SC.mesh.f[t * 3]] && inSel[SC.mesh.f[t * 3 + 1]] && inSel[SC.mesh.f[t * 3 + 2]]) faces.push(t);
      return sculptSelect(faces, add);
    }
    return sculptSelect(hit, add);
  }

  /** Which vertices a brush touches, and how strongly. Soft selection with a
   *  smooth falloff is what makes a drag move a REGION instead of a spike —
   *  the difference between sculpting and poking holes. */
  function brushWeights(seeds) {
    var v = SC.mesh.v, w = {}, i, k;
    var verts = SC.mode === 'face' ? facesToVerts(seeds) : seeds;
    if (SC.radius <= 0) { verts.forEach(function (i2) { w[i2] = 1; }); return w; }
    var r2 = SC.radius * SC.radius;
    for (k = 0; k < verts.length; k++) {
      var a = verts[k] * 3;
      for (i = 0; i < v.length / 3; i++) {
        var dx = v[i * 3] - v[a], dy = v[i * 3 + 1] - v[a + 1], dz = v[i * 3 + 2] - v[a + 2];
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        var t = 1 - Math.sqrt(d2) / SC.radius;
        var f = t * t * (3 - 2 * t);                       // smoothstep falloff
        if (!(w[i] >= f)) w[i] = f;
      }
    }
    return w;
  }

  function facesToVerts(faces) {
    var out = [], seen = {};
    for (var i = 0; i < faces.length; i++) for (var k = 0; k < 3; k++) {
      var vi = SC.mesh.f[faces[i] * 3 + k];
      if (!seen[vi]) { seen[vi] = 1; out.push(vi); }
    }
    return out;
  }

  /** Vertex normals, averaged from the faces that use each vertex. */
  function vertNormals() {
    var m = SC.mesh, n = new Float64Array(m.v.length);
    for (var t = 0; t < m.f.length; t += 3) {
      var nrm = TCM.mesh.faceNormal(m, t / 3);
      for (var k = 0; k < 3; k++) {
        var i = m.f[t + k] * 3;
        n[i] += nrm[0]; n[i + 1] += nrm[1]; n[i + 2] += nrm[2];
      }
    }
    for (var j = 0; j < n.length; j += 3) {
      var L = Math.hypot(n[j], n[j + 1], n[j + 2]) || 1;
      n[j] /= L; n[j + 1] /= L; n[j + 2] /= L;
    }
    return n;
  }

  /** Write a set of unit-space vertex positions back into the document.
   *  Tier 1 diffs against the base and stores quantised integers; Tier 2
   *  re-encodes the whole mesh. Mirroring happens here, once, for both. */
  function commitVerts(newV, label) {
    var p = sculptTarget(); if (!p) return false;
    var m = SC.mesh;
    if (SC.sym && m.sym) {
      // Live symmetry: whatever moved on one side moves on the other. Free,
      // because the correspondence was precomputed with the base mesh.
      for (var i = 0; i < m.sym.length; i++) {
        var j = m.sym[i];
        if (j < 0 || j === i || j < i) continue;
        var moved = Math.abs(newV[i * 3] - m.v[i * 3]) + Math.abs(newV[i * 3 + 1] - m.v[i * 3 + 1]) + Math.abs(newV[i * 3 + 2] - m.v[i * 3 + 2]);
        var movedJ = Math.abs(newV[j * 3] - m.v[j * 3]) + Math.abs(newV[j * 3 + 1] - m.v[j * 3 + 1]) + Math.abs(newV[j * 3 + 2] - m.v[j * 3 + 2]);
        if (moved > 1e-9 && movedJ <= 1e-9) {
          newV[j * 3] = -newV[i * 3]; newV[j * 3 + 1] = newV[i * 3 + 1]; newV[j * 3 + 2] = newV[i * 3 + 2];
        } else if (movedJ > 1e-9 && moved <= 1e-9) {
          newV[i * 3] = -newV[j * 3]; newV[i * 3 + 1] = newV[j * 3 + 1]; newV[i * 3 + 2] = newV[j * 3 + 2];
        }
      }
    }
    var ok = edit(label || 'sculpt', function () {
      if (p.sh === 'mesh') {
        p.d = TCM.mesh.encode({ v: Array.prototype.slice.call(newV), f: m.f }, p.d);
        return;
      }
      var base = TCM.mesh.base(p.sh || 'box', p.d, (p.sculpt && p.sculpt.res) || 0);
      var Q = TCM.mesh.Q, out = [];
      for (var i2 = 0; i2 < newV.length / 3; i2++) {
        var dx = Math.round((newV[i2 * 3] - base.v[i2 * 3]) * Q);
        var dy = Math.round((newV[i2 * 3 + 1] - base.v[i2 * 3 + 1]) * Q);
        var dz = Math.round((newV[i2 * 3 + 2] - base.v[i2 * 3 + 2]) * Q);
        if (dx || dy || dz) out.push([i2, dx, dy, dz]);     // SPARSE: only what moved
      }
      p.sculpt = p.sculpt || { res: 0, sym: 'x', d: [] };
      p.sculpt.d = out;
    });
    syncSculpt();
    return ok;
  }

  // ---- the Tier 1 toolset ------------------------------------------------

  function sculptMove(delta, world) {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, w = brushWeights(SC.sel), v = m.v.slice();
    // A move typed in world units has to be divided back through the part's
    // dimension scale, or dragging a 3-unit-wide hull moves three times as far
    // as the number says.
    var s = world === false ? [1, 1, 1] : m.scale;
    for (var i in w) {
      var k = i * 3, f = w[i];
      v[k] += delta[0] / (s[0] || 1) * f;
      v[k + 1] += delta[1] / (s[1] || 1) * f;
      v[k + 2] += delta[2] / (s[2] || 1) * f;
    }
    return commitVerts(v, 'move vertices');
  }

  /** Push along the surface normal. Inflate outward, pinch inward. */
  function sculptInflate(amount) {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, w = brushWeights(SC.sel), n = vertNormals(), v = m.v.slice();
    for (var i in w) {
      var k = i * 3, f = w[i] * amount;
      v[k] += n[k] * f; v[k + 1] += n[k + 1] * f; v[k + 2] += n[k + 2] * f;
    }
    return commitVerts(v, amount >= 0 ? 'inflate' : 'pinch');
  }

  /** Relax toward the average of the neighbours. */
  function sculptSmooth(amount) {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, w = brushWeights(SC.sel), v = m.v.slice();
    var acc = new Float64Array(m.v.length), cnt = new Float64Array(m.v.length / 3);
    for (var t = 0; t < m.f.length; t += 3) for (var e = 0; e < 3; e++) {
      var a = m.f[t + e], b = m.f[t + (e + 1) % 3];
      acc[a * 3] += m.v[b * 3]; acc[a * 3 + 1] += m.v[b * 3 + 1]; acc[a * 3 + 2] += m.v[b * 3 + 2]; cnt[a]++;
      acc[b * 3] += m.v[a * 3]; acc[b * 3 + 1] += m.v[a * 3 + 1]; acc[b * 3 + 2] += m.v[a * 3 + 2]; cnt[b]++;
    }
    for (var i in w) {
      if (!cnt[i]) continue;
      var k = i * 3, f = w[i] * num(amount, 0.5);
      v[k] += (acc[k] / cnt[i] - m.v[k]) * f;
      v[k + 1] += (acc[k + 1] / cnt[i] - m.v[k + 1]) * f;
      v[k + 2] += (acc[k + 2] / cnt[i] - m.v[k + 2]) * f;
    }
    return commitVerts(v, 'smooth');
  }

  /** Flatten onto the average plane of the selection — how you get a crisp
   *  armour facet out of a rounded form. */
  function sculptFlatten(amount) {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, w = brushWeights(SC.sel), v = m.v.slice();
    var seeds = SC.mode === 'face' ? facesToVerts(SC.sel) : SC.sel;
    var c = [0, 0, 0], n = [0, 0, 0], i;
    for (i = 0; i < seeds.length; i++) {
      c[0] += m.v[seeds[i] * 3]; c[1] += m.v[seeds[i] * 3 + 1]; c[2] += m.v[seeds[i] * 3 + 2];
    }
    c[0] /= seeds.length; c[1] /= seeds.length; c[2] /= seeds.length;
    var vn = vertNormals();
    for (i = 0; i < seeds.length; i++) {
      n[0] += vn[seeds[i] * 3]; n[1] += vn[seeds[i] * 3 + 1]; n[2] += vn[seeds[i] * 3 + 2];
    }
    var L = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= L; n[1] /= L; n[2] /= L;
    for (var j in w) {
      var k = j * 3, f = w[j] * num(amount, 1);
      var d = (m.v[k] - c[0]) * n[0] + (m.v[k + 1] - c[1]) * n[1] + (m.v[k + 2] - c[2]) * n[2];
      v[k] -= n[0] * d * f; v[k + 1] -= n[1] * d * f; v[k + 2] -= n[2] * d * f;
    }
    return commitVerts(v, 'flatten');
  }

  /** Seeded noise — battle damage, cast texture, rock. Seeded so a rebuild
   *  reproduces it exactly rather than reshuffling the model every time. */
  function sculptNoise(amount, seed) {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, w = brushWeights(SC.sel), n = vertNormals(), v = m.v.slice();
    var h = hash32(num(seed, 1));
    for (var i in w) {
      var k = i * 3;
      var r = ((hash32(h + (i | 0) * 2654435761) >>> 0) / 4294967296 - 0.5) * 2;
      var f = w[i] * num(amount, 0.02) * r;
      v[k] += n[k] * f; v[k + 1] += n[k + 1] * f; v[k + 2] += n[k + 2] * f;
    }
    return commitVerts(v, 'noise');
  }
  function hash32(x) {
    x = (x | 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 2246822507);
    x = Math.imul(x ^ (x >>> 13), 3266489909);
    return (x ^ (x >>> 16)) >>> 0;
  }

  function sculptReset() {
    var p = sculptTarget(); if (!p) return false;
    if (p.sh === 'mesh') { toast('An editable mesh has no parametric shape to reset to.', true); return false; }
    var r = edit('clear sculpt', function () { p.sculpt.d = []; });
    syncSculpt();
    return r;
  }

  // ---- Tier 2: topology ---------------------------------------------------

  /** The one-way door. Presented as it is in a real DCC package: a button and a
   *  clear warning that the parametric dimensions are gone. Undo crosses it. */
  function toEditableMesh(id) {
    var p = part(id || SC.part || S.sel[0]); if (!p) return false;
    if (p.sh === 'mesh') { toast('Already an editable mesh.'); return false; }
    if (TCM.mesh.MESHABLE.indexOf(p.sh || 'box') < 0) { toast('"' + p.sh + '" cannot be converted — only the hand-authored primitives have stable topology.', true); return false; }
    if (!confirmish('Convert "' + (p.n || p.id) + '" to an editable mesh?\n\n' +
        'You gain topology tools (extrude, inset, bridge, subdivide).\n' +
        'You LOSE the parametric dimensions — w/h/l stop meaning anything.\n\n' +
        'Undo works across this.')) return false;
    var d = TCM.mesh.toEditable(p.sh || 'box', p.d, p.sculpt);
    var r = edit('convert to mesh', function () {
      p.sh = 'mesh';
      p.d = d;
      delete p.sculpt;
    });
    SC.part = p.id;
    syncSculpt();
    return r;
  }

  function topoOp(op, arg) {
    var p = sculptTarget();
    if (!p || p.sh !== 'mesh') { toast('Convert the part to an editable mesh first', true); return false; }
    if (op !== 'weld' && op !== 'flipAll' && !SC.sel.length) { toast('Select some faces first', true); return false; }
    if (op !== 'weld' && op !== 'flipAll' && SC.mode !== 'face') { toast('Switch to face mode', true); return false; }
    var m = { v: SC.mesh.v.slice(), f: SC.mesh.f.slice() }, out = null;
    if (op === 'extrude') out = TCM.mesh.extrude(m, SC.sel, num(arg, 0.08));
    else if (op === 'inset') out = TCM.mesh.inset(m, SC.sel, num(arg, 0.25));
    else if (op === 'delete') out = TCM.mesh.del(m, SC.sel);
    else if (op === 'subdivide') out = TCM.mesh.subdivideFaces(m, SC.sel);
    else if (op === 'bridge') {
      if (SC.sel.length !== 2) { toast('Bridge needs exactly two faces selected', true); return false; }
      out = TCM.mesh.bridge(m, SC.sel[0], SC.sel[1]);
    } else if (op === 'flip') out = TCM.mesh.flip(m, SC.sel);
    else if (op === 'flipAll') out = TCM.mesh.flip(m, null);
    else if (op === 'weld') out = TCM.mesh.weld(m, num(arg, 1e-3));
    if (!out) return false;
    var r = edit(op, function () { p.d = TCM.mesh.encode(out, p.d); });
    SC.sel = [];
    syncSculpt();
    return r;
  }

  // ---- viewport overlay ---------------------------------------------------

  function clearSculptOverlay() {
    if (!view) return;
    if (SC.points) { view.overlay.remove(SC.points); SC.points.geometry.dispose(); SC.points.material.dispose(); SC.points = null; }
    if (SC.hi) { view.overlay.remove(SC.hi); SC.hi.geometry.dispose(); SC.hi.material.dispose(); SC.hi = null; }
  }

  /** Draw the sculptable vertices as points, parented to the part's own node so
   *  they ride the skeleton — you can sculpt a shoulder pad while the man is
   *  mid-stride and the handles stay where the geometry is. */
  function buildSculptOverlay() {
    if (!view || !SC.on || !SC.mesh) return;
    var host = partNode(SC.part);
    if (!host) return;
    var m = SC.mesh, s = m.scale, pos = [];
    for (var i = 0; i < m.v.length / 3; i++)
      pos.push(m.v[i * 3] * s[0], m.v[i * 3 + 1] * s[1], m.v[i * 3 + 2] * s[2]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    SC.points = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x8fd8ff, size: 5, sizeAttenuation: false, depthTest: false, toneMapped: false,
    }));
    SC.points.renderOrder = 996;
    view.overlay.add(SC.points);
    highlightSculpt();
  }

  /** Update the overlay positions in place during a drag — rebuilding the
   *  buffer every mouse-move would allocate a geometry per frame. */
  function buildSculptOverlayFast() {
    if (!SC.points || !SC.mesh) return;
    var m = SC.mesh, s = m.scale;
    var arr = SC.points.geometry.attributes.position.array;
    if (arr.length !== m.v.length) { clearSculptOverlay(); buildSculptOverlay(); return; }
    for (var i = 0; i < m.v.length; i += 3) {
      arr[i] = m.v[i] * s[0]; arr[i + 1] = m.v[i + 1] * s[1]; arr[i + 2] = m.v[i + 2] * s[2];
    }
    SC.points.geometry.attributes.position.needsUpdate = true;
    highlightSculpt();
  }

  function highlightSculpt() {
    if (!view) return;
    if (SC.hi) { view.overlay.remove(SC.hi); SC.hi.geometry.dispose(); SC.hi.material.dispose(); SC.hi = null; }
    if (!SC.on || !SC.mesh || !SC.sel.length) return;
    var m = SC.mesh, s = m.scale, pos = [];
    if (SC.mode === 'face') {
      for (var i = 0; i < SC.sel.length; i++) for (var k = 0; k < 3; k++) {
        var vi = m.f[SC.sel[i] * 3 + k];
        pos.push(m.v[vi * 3] * s[0], m.v[vi * 3 + 1] * s[1], m.v[vi * 3 + 2] * s[2]);
      }
      var fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      SC.hi = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
        color: 0xffd050, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        depthTest: false, toneMapped: false,
      }));
    } else {
      for (var j = 0; j < SC.sel.length; j++) {
        var v = SC.sel[j];
        pos.push(m.v[v * 3] * s[0], m.v[v * 3 + 1] * s[1], m.v[v * 3 + 2] * s[2]);
      }
      var pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      SC.hi = new THREE.Points(pg, new THREE.PointsMaterial({
        color: 0xffd050, size: 9, sizeAttenuation: false, depthTest: false, toneMapped: false,
      }));
    }
    SC.hi.renderOrder = 997;
    view.overlay.add(SC.hi);
  }

  /** The overlay is in the part's local space, so it has to be parented to the
   *  part's world transform every frame the skeleton moves. */
  function syncSculptOverlay() {
    if (!SC.on || !SC.points) return;
    var host = partNode(SC.part);
    if (!host) return;
    host.updateWorldMatrix(true, false);
    SC.points.matrix.copy(host.matrixWorld);
    SC.points.matrixAutoUpdate = false;
    if (SC.hi) { SC.hi.matrix.copy(host.matrixWorld); SC.hi.matrixAutoUpdate = false; }
  }

  function partNode(id) {
    var found = null;
    if (!view) return null;
    view.root.traverse(function (o) {
      if (!found && o.userData && o.userData.tcmPart === id && o.userData.tcmSide !== -1) found = o;
    });
    return found;
  }

  /** Pick the nearest vertex (or the face under the cursor) to a screen ray. */
  function sculptPick(ndcV) {
    if (!SC.on || !SC.mesh) return null;
    var host = partNode(SC.part);
    if (!host) return null;
    host.updateWorldMatrix(true, false);
    var m = SC.mesh, s = m.scale;
    view.ray.setFromCamera(ndcV, view.camera);
    if (SC.mode === 'face') {
      var best = null, bd = Infinity;
      var tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      var out = new THREE.Vector3();
      for (var t = 0; t < m.f.length / 3; t++) {
        for (var k = 0; k < 3; k++) {
          var vi = m.f[t * 3 + k];
          tri[k].set(m.v[vi * 3] * s[0], m.v[vi * 3 + 1] * s[1], m.v[vi * 3 + 2] * s[2]).applyMatrix4(host.matrixWorld);
        }
        if (view.ray.ray.intersectTriangle(tri[0], tri[1], tri[2], false, out)) {
          var d = out.distanceTo(view.camera.position);
          if (d < bd) { bd = d; best = t; }
        }
      }
      return best;
    }
    var bestV = null, bestScore = Infinity, p3 = new THREE.Vector3();
    for (var i = 0; i < m.v.length / 3; i++) {
      p3.set(m.v[i * 3] * s[0], m.v[i * 3 + 1] * s[1], m.v[i * 3 + 2] * s[2]).applyMatrix4(host.matrixWorld);
      var dl = view.ray.ray.distanceToPoint(p3);
      if (dl > 0.06) continue;
      var score = dl + p3.distanceTo(view.camera.position) * 0.01;
      if (score < bestScore) { bestScore = score; bestV = i; }
    }
    return bestV;
  }

  // =======================================================================
  // VALIDATION, BUDGET, COST, CONTRACT
  // =======================================================================

  function report() {
    if (!S.doc) return { ok: true, errors: [], warnings: [], budget: { parts: 0, meshes: 0, tris: 0, mats: 0, unique: 0, level: 'green' } };
    return TCM.validate(S.doc);
  }

  /** Which engine behaviours this model has EARNED. The single most valuable
   *  piece of UI in the rig editor (FORGE_PLAN §6.1): it turns an opaque system
   *  into something the player can reason about. */
  function contract() {
    var r = { model: !S.broken, muzzle: false, barrelTip: false, turret: false,
      jets: 0, rig: false, animator: 'none', head: false, aim: false, locomotion: false,
      drivers: 0, poses: 0 };
    if (!built) return r;
    r.muzzle = !!built.muzzle;
    r.barrelTip = !!built.barrelTip;
    r.turret = !!built.turret;
    r.rig = !!built.rig;
    // Behaviours are earned through SEMANTIC TAGS, so the checklist reads the
    // tag map rather than guessing at joint names (FORGE_PLAN §6.1).
    var tags = built.tags || (built.rig && built.rig._tag) || {};
    r.tags = Object.keys(tags);
    var rig = built.rig;
    if (rig) {
      r.jets = (rig.jets && rig.jets.length) || 0;
      r.animator = rig.generic ? '_poseGeneric (authored clips)' : rig.suit ? '_poseSuit' : '_poseInfantry';
      r.head = !!tags.head;
      r.aim = !!tags.aim;
      r.locomotion = !!(tags.thighL && tags.thighR) || !!(rig.legs && rig.legs.length);
      r.clips = Object.keys((S.doc && S.doc.clips) || {}).length;
    } else if (S.doc && S.doc.skeleton === 'hull') {
      r.animator = 'hull (turret tracking + hull rock)';
      r.turret = r.turret || !!built.turret;
    } else r.animator = 'static';
    r.drivers = ((S.doc && S.doc.drivers) || []).length;
    r.poses = Object.keys((S.doc && S.doc.poses) || {}).length;
    return r;
  }

  /** Fightability lint. A custom unit the AI is allowed to field must be able to
   *  actually fight, or it deadlocks a battle and the AI has no way to notice
   *  (FORGE_PLAN §8.5). Errors here are what gate AI eligibility. */
  function lint() {
    var out = [];
    if (S.kind !== 'unit') return out;
    var m = S.meta || {}, c = contract();
    if (!c.model) out.push({ bad: true, t: 'the model failed to build — it renders as the magenta placeholder' });
    if (!c.muzzle) out.push({ bad: true, t: 'no part tagged `muzzle` — shots would leave from the model origin' });
    if (!m.role) out.push({ bad: true, t: 'no AI role — the AI cannot drive a unit it has no doctrine for' });
    if (!(num(m.spd, 0) > 0)) out.push({ bad: true, t: 'zero speed and not marked static — it can never reach anything' });
    if (!(num(m.hp, 0) > 0)) out.push({ bad: true, t: 'zero hit points' });
    // Damage and reach come from the weapon documents when there are any; the
    // `dmg`/`rng` fields are only the fallback for the behaviour-branch path.
    var ws = m.weapons || [];
    if (ws.length) {
      var anyMode = ws.some(function (w) { return (w.modes || []).length; });
      if (!anyMode) out.push({ bad: true, t: 'carries a weapon with no firing mode' });
      ws.forEach(function (w) {
        var v = TCM.validateWeapon(w);
        v.errors.forEach(function (e) { out.push({ bad: true, t: '"' + w.name + '": ' + e }); });
        v.warnings.forEach(function (e) { out.push({ bad: false, t: '"' + w.name + '": ' + e }); });
      });
    } else {
      if (!(num(m.dmg, 0) > 0)) out.push({ bad: true, t: 'zero damage — it can never win a fight' });
      if (!(num(m.rng, 0) > 0)) out.push({ bad: true, t: 'zero range' });
    }
    (m.abilities || []).forEach(function (a) {
      var d = TCM.ABILITIES[a.a];
      if (!d) out.push({ bad: true, t: 'unknown ability "' + a.a + '"' });
      else if (d.needs && !m[d.needs]) out.push({ bad: false, t: 'ability "' + a.a + '" needs the `' + d.needs + '` flag to do anything' });
    });
    var r = report();
    if (r.budget.level === 'red') out.push({ bad: false, t: 'over budget (' + r.budget.meshes + ' meshes / ' + Math.round(r.budget.tris / 100) / 10 + 'k tris) — 81 of these on the field will cost frames' });
    if (!num(m.vis, 0)) out.push({ bad: false, t: 'zero vision — it will never spot anything on its own' });
    return out;
  }

  /** Points cost. A wargame with player-made units needs a common currency or
   *  nothing is playable against anything (§12). The coefficients are hand-set
   *  rather than regressed, but every unit — stock and custom — is priced with
   *  THE SAME function, so the comparison against the stock table is meaningful
   *  even though the absolute scale is arbitrary. */
  function costOf(m) {
    m = m || {};
    var dmg = num(m.dmg, 0), at = Math.max(0.15, num(m.atkTime, 1));
    var dps = dmg / at;
    var rng = num(m._rng0 != null ? m._rng0 : m.rng, 0);   // round 105: a tube's real range is not its price
    // A unit that carries weapon documents is priced from THEM, since that is
    // what it actually fires — sum each weapon's best mode, and count the extra
    // modes as utility rather than as full extra damage.
    if (m.weapons && m.weapons.length && window.TCM) {
      dps = 0; rng = 0;
      for (var wi = 0; wi < m.weapons.length; wi++) {
        var w = m.weapons[wi], best = 0, bestRng = 0;
        (w.modes || []).forEach(function (mo, i) {
          var d = TCM.modeDps(mo) * (i === 0 ? 1 : 0.45);
          best += d;
          bestRng = Math.max(bestRng, num(mo.rng, 0));
        });
        dps += best * (wi === 0 ? 1 : 0.7);          // a second weapon is a bonus, not a doubling
        rng = Math.max(rng, bestRng);
      }
    }
    var pts = num(m.hp, 0) * 0.5
      + dps * (1 + rng / 120) * 1.6
      + num(m._spd0 != null ? m._spd0 : m.spd, 0) * 3     // the figure stock units were priced on (round 105)
      + num(m.armor, 0) * 180
      + num(m.shield, 0) * 0.6
      + num(m._size0 != null ? m._size0 : m.size, 1) * 8
      + ((m.abilities && m.abilities.length) || 0) * 18;
    if (m.plates) { var s = 0; for (var k in m.plates) s += num(m.plates[k], 0); pts += s * 0.5; }
    if (m.vehicle) pts += 40;
    if (m.hover) pts += 15;
    if (m.walker) pts += 20;
    if (m.jetpack) pts += 25;
    if (m.mg || m.heavyMg) pts += 15;
    if (m.aoe) pts += 30;
    if (m.capacity) pts += num(m.capacity, 0) * 6;
    return Math.max(1, Math.round(pts));
  }

  function cost() {
    if (S.kind !== 'unit' || !S.meta) return null;
    var pinned = num(S.meta.cost, null);
    var pts = costOf(S.meta);
    // Compare against the stock table, priced identically.
    var best = null;
    try {
      for (var k in G.UNIT_DEFS) {
        var d = G.UNIT_DEFS[k];
        if (d.custom) continue;
        var c = costOf(d);
        var diff = Math.abs(c - pts);
        if (!best || diff < best.diff) best = { key: k, name: d.name, c: c, diff: diff };
      }
    } catch (e) {}
    return {
      points: pinned == null ? pts : pinned, computed: pts, pinned: pinned,
      near: best ? { name: best.name, pct: Math.round((pts / Math.max(1, best.c) - 1) * 100) } : null,
    };
  }

  // =======================================================================
  // PUBLISHING — the moment custom content enters the live game
  // =======================================================================

  /** Register one asset into the live tables. Everything goes through
   *  `TCM.register*`, which validates first, so a broken document becomes a
   *  visible magenta placeholder instead of an exception in a battle. */
  function registerAsset(a, quiet) {
    if (!a) return false;
    try {
      if (a.model) TCM.registerModel(a.model);
      var ok = true;
      if (a.kind === 'unit' && a.unit) {
        var v = TCM.validate(a.model);
        if (!v.ok && !quiet) toast('"' + a.name + '" has ' + v.errors.length + ' error(s) — it will render as a placeholder', true);
        ok = TCM.registerUnit(a.unit, a.model);
        // Cost is what lets the deployer and the AI spend points on it.
        if (G.UNIT_DEFS[a.unit.id]) G.UNIT_DEFS[a.unit.id].cost = num(a.unit.cost, costOf(a.unit));
      } else if (a.kind === 'prop' && a.prop) {
        ok = TCM.registerProp(a.prop, a.model);
        // Cover and flammability live in the game's own side tables.
        if (G.COVER_DOODAD) G.COVER_DOODAD[a.prop.id] = num(a.prop.cover, 0.35);
        if (G.FLAMMABLE_OBS && a.prop.flammable) G.FLAMMABLE_OBS.add(a.prop.id);
      } else if (a.kind === 'terrain' && a.terrain) {
        ok = TCM.registerTerrain(a.terrain);
      } else if (a.kind === 'roster' && a.roster) {
        // Rosters live on the game, not in TCM: they reference unit TYPES, and
        // the deployer and the AI both read them from there.
        if (G.ROSTERS) G.ROSTERS[a.roster.id] = JSON.parse(JSON.stringify(a.roster));
        ok = !!G.ROSTERS;
      } else if (a.kind === 'faction' && a.faction) {
        G.FACTIONS = G.FACTIONS || {};
        G.FACTIONS[a.faction.id] = JSON.parse(JSON.stringify(a.faction));
        ok = true;
      } else if (a.kind === 'stamp') {
        ok = true;                       // stamps are editor-side only
      }
      if (!ok && !quiet) toast('The runtime refused to register "' + a.name + '" — see the console.', true);
      return ok;
    } catch (e) {
      warn('register "' + (a && a.id) + '" failed: ' + e.message);
      return false;
    }
  }

  /** Publish: mark the asset live, register it, and refresh the palettes the
   *  Edit mode builds from so it appears without a reload. */
  function publish(id) {
    var a = S.lib.assets[id || S.id];
    if (!a) return false;
    if (a.kind === 'unit') {
      var bad = (S.id === a.id ? lint() : []).filter(function (x) { return x.bad; });
      if (bad.length && !confirmish('This unit fails ' + bad.length + ' fightability check(s):\n\n• ' +
          bad.map(function (x) { return x.t; }).join('\n• ') +
          '\n\nPublish anyway? (the AI will not be allowed to field it)')) return false;
      a.aiOk = !bad.length;
    }
    a.pub = true;
    if (!registerAsset(a)) return false;
    saveLib();
    refreshGamePalettes();
    renderAll();
    toast('Published "' + a.name + '" — it is in the Edit palettes now');
    return true;
  }

  function unpublish(id) {
    var a = S.lib.assets[id || S.id];
    if (!a) return false;
    a.pub = false;
    saveLib();
    // The live tables keep the entry until reload — removing a unit type out
    // from under a battle that has already placed one would be worse.
    toast('"' + a.name + '" will not load next time. It stays live this session.');
    renderAll();
    return true;
  }

  /** Register every published asset. Called from the game's boot BEFORE the
   *  world is built, so custom terrain types exist before the Terrain object
   *  reads TYPE_DEF and custom units are in the palettes from the first frame. */
  function bootRegister(api) {
    G = G || api;
    THREE = THREE || api.THREE || window.THREE;
    TCM = window.TCM;
    if (!TCM) return 0;
    loadLib();
    var n = 0;
    // Models first (a unit or prop may `ref` any of them), published or not:
    // an unpublished part is still a legitimate dependency of a published unit.
    for (var k in S.lib.assets) if (S.lib.assets[k].model) TCM.registerModel(S.lib.assets[k].model);
    for (var j in S.lib.assets) {
      var a = S.lib.assets[j];
      if (!a.pub) continue;
      if (registerAsset(a, true)) n++;
    }
    return n;
  }

  /** Rebuild the Edit-mode tool palettes so newly published content appears.
   *  The rows are generated from the live tables, so this is a redraw, not a
   *  second copy of the data. */
  function refreshGamePalettes() {
    if (!G.game) return;
    var mk = function (tool, label, color) {
      var b = document.createElement('div');
      b.className = 'tool-btn';
      b.dataset.tool = tool;
      b.innerHTML = '<div class="swatch" style="background:#' +
        (color >>> 0).toString(16).padStart(6, '0') + '"></div>' + label;
      b.addEventListener('click', function () {
        var sel = document.querySelectorAll('.tool-btn.selected');
        for (var i = 0; i < sel.length; i++) sel[i].classList.remove('selected');
        b.classList.add('selected');
        G.game.editor.setTool(tool);
      });
      return b;
    };
    var cap = function (t) { return t[0].toUpperCase() + t.slice(1); };
    var rows = [
      { el: document.getElementById('unitTools'), src: G.UNIT_DEFS, label: function (k, d) { return d.name; }, tail: ['removeUnit'] },
      { el: document.getElementById('obstacleTools'), src: G.OBS_DEF, label: function (k, d) { return cap(k) + (d.explosive ? '💥' : ''); }, tail: ['removeObs'] },
    ];
    rows.forEach(function (r) {
      if (!r.el) return;
      r.el.innerHTML = '';
      for (var k in r.src) r.el.appendChild(mk(k, r.label(k, r.src[k]), r.src[k].color || 0x888888));
      r.tail.forEach(function (t) { r.el.appendChild(mk(t, '✕', 0x4a2a2a)); });
    });
    var pr = document.getElementById('paintTools');
    if (pr) {
      pr.innerHTML = '';
      G.TYPE_DEF.forEach(function (d) {
        pr.appendChild(mk(d.name, cap(d.label || d.name) + (d.carve ? '⛏' : ''), d.color));
      });
    }
    if (G.publishDefs) { try { G.publishDefs(); } catch (e) {} }
  }

  // =======================================================================
  // PACKS — export / import
  // =======================================================================

  /** Collect an asset plus everything it depends on. Without this a pack that
   *  uses a library part imports as a magenta box on someone else's machine. */
  function withDeps(ids) {
    var out = {}, queue = ids.slice(), guard = 0;
    while (queue.length && guard++ < 400) {
      var id = queue.shift();
      var a = S.lib.assets[id];
      if (!a || out[id]) continue;
      out[id] = clone(a);
      ((a.model && a.model.parts) || []).forEach(function (p) {
        var ref = p.sh === 'ref' && p.d && (p.d.ref || p.d.id);
        if (!ref) return;
        // A ref names a MODEL id; find the library asset that owns it.
        for (var k in S.lib.assets) {
          var b = S.lib.assets[k];
          if (b.model && b.model.id === ref && !out[k]) queue.push(k);
        }
      });
    }
    return out;
  }

  function exportPack(ids) {
    ids = ids && ids.length ? ids : Object.keys(S.lib.assets).filter(function (k) { return !S.lib.assets[k].stock; });
    var assets = withDeps(ids);
    return { format: 'tcpack', v: VERSION, made: 'the Forge', assets: assets };
  }

  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return true;
    } catch (e) { toast('Download failed: ' + e.message, true); return false; }
  }

  function exportFile(ids) {
    var pack = exportPack(ids);
    var n = Object.keys(pack.assets).length;
    download('forge-' + (ids && ids.length === 1 ? slug(ids[0]) : 'pack') + '.tcpack.json',
      JSON.stringify(pack, null, 1));
    toast('Exported ' + n + ' asset(s)');
    return n;
  }

  function exportOne(id) { return exportFile([id || S.id]); }

  /** Import a pack. Reports collisions rather than silently overwriting: the
   *  player's own work is never clobbered without being asked. */
  function importPack(json, how) {
    var pack;
    try { pack = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) { toast('Not valid JSON: ' + e.message, true); return null; }
    if (!pack || !pack.assets) { toast('Not a Forge pack (no assets)', true); return null; }
    var added = 0, renamed = 0, skipped = 0;
    for (var k in pack.assets) {
      var a = clone(pack.assets[k]);
      if (!a || !a.id) continue;
      a.stock = false; a.tmpl = false;
      if (S.lib.assets[a.id]) {
        var mode = how || (confirmish('"' + a.name + '" (' + a.id + ') already exists. Overwrite it?\nCancel keeps both by renaming the incoming one.') ? 'overwrite' : 'rename');
        if (mode === 'skip') { skipped++; continue; }
        if (mode === 'rename') {
          var nid = freeId(a.id);
          if (a.model) a.model.id = nid;
          if (a.unit) { a.unit.id = nid; a.unit.model = 'tcm:' + nid; }
          if (a.prop) { a.prop.id = nid; a.prop.model = 'tcm:' + nid; }
          a.id = nid; renamed++;
        }
      }
      S.lib.assets[a.id] = a;
      if (a.model) TCM.registerModel(a.model);
      added++;
    }
    saveLib();
    renderAll();
    toast('Imported ' + added + ' asset(s)' + (renamed ? ', ' + renamed + ' renamed' : '') + (skipped ? ', ' + skipped + ' skipped' : ''));
    return { added: added, renamed: renamed, skipped: skipped };
  }

  // =======================================================================
  // TEST — put the thing you just built into a battle
  // =======================================================================

  function spawnIntoBattle(team) {
    var a = S.lib.assets[S.id];
    if (!a) return false;
    if (a.kind === 'terrain') { publish(S.id); exit(); toast('Surface published — paint it from the Paint tab'); return true; }
    if (!a.pub) publish(S.id);
    if (!registerAsset(a)) return false;
    var g = G.game;
    exit();
    if (a.kind === 'prop') {
      var c = g.cameraRig.target;
      var gx = G.worldToCell(c.x), gz = G.worldToCell(c.z);
      var o = g.obstacles.add(gx, gz, a.prop.id);
      if (!o) { toast('No room there — pan somewhere clear and try again', true); return false; }
      g.ui.toast('Placed ' + a.name);
      return true;
    }
    var t = team || 1;
    var ctr = g.cameraRig.target;
    var u = g.addUnitNear(G.worldToCell(ctr.x) + 1, G.worldToCell(ctr.z) + 1, t, a.unit.id);
    if (!u) { toast('Could not place the unit there', true); return false; }
    g.select([u], false);
    g.ui.toast('Spawned ' + a.name + ' — press F to take control');
    return u;
  }

  function takeControl() {
    var u = spawnIntoBattle(1);
    if (!u || !u.pos) return false;
    var g = G.game;
    g.setMode('play');
    try { g.enterFpv(u); } catch (e) { warn('enterFpv failed: ' + e.message); }
    return true;
  }

  /** The pose gauntlet: walk every stock pose and watch for parts flying off.
   *  Cheap, and it catches a mis-parented part faster than any amount of
   *  staring at a turntable. */
  function gauntlet() {
    var i = 0;
    S.playing = true;
    var step = function () {
      if (S.tab !== 'test' || G.game.mode !== 'forge') return;
      setPose(POSES[i % POSES.length]);
      i++;
      if (i <= POSES.length) setTimeout(step, 900);
      else toast('Gauntlet done — ' + POSES.length + ' poses');
    };
    step();
    return POSES.length;
  }

  // =======================================================================
  // DOM PLUMBING
  // =======================================================================

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (typeof attrs === 'string') { e.className = attrs; attrs = null; }
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  // `textContent = ''` drops every child at once. Removing them one by one
  // throws if anything moved a node out from under the loop.
  function clear(e) { if (e) e.textContent = ''; return e; }
  function confirmish(msg) { try { return window.confirm(msg); } catch (e) { return true; } }
  function toast(msg, bad) {
    S.msg = msg;
    if (el.msg) {
      el.msg.textContent = msg;
      // THE BAR IS WHERE THE FORGE TELLS YOU THINGS AND IT WAS 22 PIXELS WIDE.
      // `flex:1` with no minimum against the tabs, the model name and the
      // budget pill left it about three characters, so EVERY message was
      // clipped: 'Select a part first' wants 76. It is how a real regression
      // hid for a whole round — the pose engine threw on every Forge open,
      // reported 'Pose engine: Cannot read properties of undefined (reading
      // fov)' into this box, and nobody could read it. A title as well, because
      // even a wide bar will meet a message wider than itself.
      el.msg.title = msg || '';
      el.msg.className = 'fg-msg fg-msg-bar' + (bad ? ' bad' : '');
      clearTimeout(el._msgT);
      el._msgT = setTimeout(function () { if (el.msg) el.msg.textContent = ''; }, 5200);
    }
    if (bad) warn(msg);
  }
  function isTyping() {
    var a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }

  var CSS = [
    '#fgBar,#fgLeft,#fgRight,#fgFoot{position:fixed;z-index:120;background:var(--panel);',
    'border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);',
    'font-size:11px;color:var(--text);display:none}',
    'body.forge #fgBar,body.forge #fgLeft,body.forge #fgRight,body.forge #fgFoot{display:flex}',
    'body.forge #editorPanel,body.forge #unitInfo,body.forge #minimap,body.forge #reinforceBar,',
    'body.forge #cmdBar,body.forge #formationBar,body.forge #controlsHint,body.forge #countPill,',
    'body.forge #pausePill,body.forge #orderHint{display:none!important}',
    '#fgBar{top:46px;left:8px;right:8px;height:30px;align-items:center;gap:4px;padding:0 8px}',
    '#fgLeft{top:82px;left:8px;width:216px;bottom:96px;flex-direction:column;padding:6px;overflow:hidden}',
    '#fgRight{top:82px;right:8px;width:250px;bottom:96px;flex-direction:column;padding:6px;overflow:hidden}',
    '#fgFoot{left:8px;right:8px;bottom:8px;height:80px;align-items:center;gap:10px;padding:0 10px;flex-wrap:wrap}',
    '.fg-tab{padding:3px 9px;border-radius:5px;border:1px solid transparent;cursor:pointer;',
    'font-weight:700;letter-spacing:.4px;color:var(--text-dim);text-transform:uppercase;font-size:10px}',
    '.fg-tab:hover{color:#fff;background:rgba(255,255,255,.05)}',
    '.fg-tab.on{background:linear-gradient(180deg,var(--accent),var(--accent-dim));color:#12160c;border-color:var(--accent)}',
    '.fg-b{background:linear-gradient(180deg,#1b2532,#141b24);border:1px solid var(--border-lt);',
    'border-radius:5px;color:var(--text);font-weight:600;padding:3px 8px;cursor:pointer;font-size:10.5px}',
    '.fg-b:hover{border-color:var(--accent);color:#fff}',
    '.fg-b.hot{background:linear-gradient(180deg,var(--accent),var(--accent-dim));color:#12160c;border-color:var(--accent)}',
    '.fg-b.on{border-color:var(--accent);color:var(--accent)}',
    '.fg-b.danger{border-color:#6a3630;color:#e08a7a}',
    '.fg-b:disabled{opacity:.4;cursor:default}',
    '.fg-h{font-size:9.5px;letter-spacing:1.1px;text-transform:uppercase;color:var(--accent);',
    'font-weight:800;margin:6px 2px 3px;display:flex;align-items:center;gap:5px}',
    '.fg-h:first-child{margin-top:0}',
    '.fg-h .fg-b{margin-left:auto;padding:1px 6px;font-size:9.5px}',
    '.fg-scroll{overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;padding-right:2px}',
    '.fg-scroll::-webkit-scrollbar{width:7px}.fg-scroll::-webkit-scrollbar-thumb{background:#2c3947;border-radius:4px}',
    '.fg-row{display:flex;align-items:center;gap:4px;margin:2px 0;min-height:19px}',
    // 62px held every label in this panel except one: 'weapon height' wants 65.
    // Three pixels, and the `l` of `height` was the casualty. A fixed-width
    // label column is only ever as wide as its longest member, and the way to
    // find that member is to sweep rather than to guess — see `tools/probe_ui.js`.
    '.fg-row>label{flex:0 0 70px;color:var(--text-dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fg-row input[type=number],.fg-row input[type=text],.fg-row select{background:#131a24;border:1px solid var(--border);',
    'border-radius:4px;color:var(--text);font-size:10.5px;padding:2px 4px;min-width:0;flex:1;font-family:inherit}',
    '.fg-row input[type=number]{-moz-appearance:textfield}',
    '.fg-row input:focus,.fg-row select:focus{outline:none;border-color:var(--accent)}',
    '.fg-row input[type=color]{width:26px;height:19px;padding:0;border:1px solid var(--border);background:none;flex:0 0 26px}',
    '.fg-row input[type=range]{flex:1;min-width:0;width:0;accent-color:var(--accent);height:14px}',
    '.fg-row input[type=checkbox]{accent-color:var(--accent);margin:0}',
    '.fg-row .v{flex:0 0 34px;text-align:right;font-family:"SF Mono",Menlo,monospace;color:var(--t1);font-size:10px}',
    '.fg-item{display:flex;align-items:center;gap:5px;padding:2px 5px;border-radius:4px;cursor:pointer;',
    'border:1px solid transparent;white-space:nowrap;overflow:hidden}',
    '.fg-item:hover{background:rgba(255,255,255,.05)}',
    '.fg-item.on{background:rgba(217,179,112,.16);border-color:var(--accent-dim)}',
    '.fg-item .n{flex:1;overflow:hidden;text-overflow:ellipsis}',
    '.fg-item .t{color:var(--text-dim);font-size:9px;font-family:"SF Mono",Menlo,monospace}',
    '.fg-item .x{color:var(--text-dim);padding:0 3px;border-radius:3px}',
    '.fg-item .x:hover{color:#e08a7a;background:rgba(224,138,122,.15)}',
    '.fg-group{margin:1px 0 3px}',
    '.fg-group>.g{display:flex;align-items:center;gap:4px;padding:2px 4px;color:var(--accent-dim);',
    'font-size:9.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700;cursor:pointer}',
    '.fg-group>.g:hover{color:var(--accent)}',
    '.fg-group .kids{padding-left:9px;border-left:1px solid #23303d;margin-left:5px}',
    '.fg-sw{width:12px;height:12px;border-radius:3px;border:1px solid rgba(0,0,0,.5);flex:0 0 12px}',
    '.fg-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin:2px 0}',
    '.fg-grid.t3{grid-template-columns:1fr 1fr 1fr}',
    '.fg-pill{padding:2px 7px;border-radius:9px;font-size:9.5px;font-weight:700;letter-spacing:.5px;',
    'border:1px solid var(--border);background:#131a24}',
    '.fg-pill.green{color:#7ad06a;border-color:#2f5a2a}.fg-pill.amber{color:#e0b45a;border-color:#5a4a20}',
    '.fg-pill.red{color:#e07a72;border-color:#5a2a26}',
    '.fg-msg{flex:1;font-size:10px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // Only the TOOLBAR message claims a minimum. `.fg-msg` is reused as a
    // generic small-text span (a face count, a template id), and those must go
    // on shrinking to fit their rows.
    '.fg-msg-bar{min-width:150px}',
    '.fg-msg.bad{color:#e08a7a}',
    '.fg-note{font-size:9.5px;color:var(--text-dim);line-height:1.45;margin:3px 2px;white-space:normal}',
    '.fg-note b{color:var(--accent)}',
    '.fg-ok{color:#7ad06a}.fg-no{color:#6a7684}.fg-bad{color:#e07a72}',
    '.fg-name{font-weight:700;color:var(--accent);font-size:11.5px;margin-right:auto;',
    'display:flex;align-items:center;gap:6px;overflow:hidden}',
    '.fg-name .k{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim);',
    'border:1px solid var(--border);border-radius:8px;padding:1px 6px}',
    '.fg-foot-col{display:flex;flex-direction:column;gap:3px;min-width:0}',
    '.fg-poses{display:flex;gap:3px;flex-wrap:wrap}',
    '.fg-poses .fg-b{padding:2px 6px;font-size:9.5px}',
    '#fgHint{font-size:9.5px;color:var(--text-dim);line-height:1.4;max-width:340px;white-space:normal}',
  ].join('');

  function buildDom() {
    if (el.bar) return;
    document.head.appendChild(h('style', { text: CSS }));

    // ---- top strip: tabs, name, the actions that matter ------------------
    el.tabs = h('div', { style: 'display:flex;gap:2px' });
    el.name = h('div', 'fg-name');
    el.budget = h('div', 'fg-pill');
    el.msg = h('div', 'fg-msg fg-msg-bar');
    el.bar = h('div', { id: 'fgBar' }, [
      el.tabs, el.name, el.msg, el.budget,
      h('button', { class: 'fg-b', title: 'Undo (Ctrl+Z)', onclick: undo, text: '↶' }),
      h('button', { class: 'fg-b', title: 'Redo (Ctrl+Shift+Z)', onclick: redo, text: '↷' }),
      h('button', { class: 'fg-b hot', title: 'Register into the live game and show it in the Edit palettes', onclick: function () { publish(); }, text: 'Publish' }),
      h('button', { class: 'fg-b', title: 'Spawn into the battle and take control', onclick: function () { takeControl(); }, text: '▶ Test' }),
      h('button', { class: 'fg-b', title: 'Back to Edit mode (Esc)', onclick: function () { G.game.setMode('edit'); }, text: '✕' }),
    ]);
    ['build', 'sculpt', 'paint', 'rig', 'guns', 'stats', 'test', 'library'].forEach(function (t) {
      el.tabs.appendChild(h('div', {
        class: 'fg-tab', 'data-tab': t, text: t,
        onclick: function () { setTab(t); },
      }));
    });

    el.leftHead = h('div', 'fg-h');
    el.leftBody = h('div', 'fg-scroll');
    el.leftFoot = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;padding-top:5px' });
    el.left = h('div', { id: 'fgLeft' }, [el.leftHead, el.leftBody, el.leftFoot]);

    el.rightHead = h('div', 'fg-h');
    el.rightBody = h('div', 'fg-scroll');
    el.right = h('div', { id: 'fgRight' }, [el.rightHead, el.rightBody]);

    el.foot = h('div', { id: 'fgFoot' });

    document.body.appendChild(el.bar);
    document.body.appendChild(el.left);
    document.body.appendChild(el.right);
    document.body.appendChild(el.foot);

    // Drag-drop a .tcpack.json anywhere on the window to import it.
    window.addEventListener('dragover', function (e) { if (G.game && G.game.mode === 'forge') e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!G.game || G.game.mode !== 'forge') return;
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { importPack(rd.result); };
      rd.readAsText(f);
    });
    el.file = h('input', { type: 'file', accept: '.json', style: 'display:none', onchange: function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { importPack(rd.result); e.target.value = ''; };
      rd.readAsText(f);
    } });
    document.body.appendChild(el.file);
    bindPointer();
  }

  // ---- small field builders ----------------------------------------------
  var binds = [];
  function bindv(node, get) { binds.push({ n: node, g: get }); return node; }
  function syncBinds() {
    for (var i = 0; i < binds.length; i++) {
      var b = binds[i];
      if (!b.n.parentNode) continue;
      if (b.n === document.activeElement) continue;
      var v = b.g();
      if (v == null) continue;
      if (b.n.tagName === 'SPAN' || b.n.tagName === 'DIV') b.n.textContent = v;
      else if (b.n.type === 'checkbox') b.n.checked = !!v;
      else if (String(b.n.value) !== String(v)) b.n.value = v;
    }
  }

  function fRow(label, kids) { return h('div', 'fg-row', [h('label', { text: label })].concat(kids)); }

  function fNum(label, get, set, step, min, max) {
    var inp = h('input', {
      type: 'number', step: step || 0.01, value: fmt(get()),
      min: min == null ? undefined : min, max: max == null ? undefined : max,
      onchange: function () { set(parseFloat(inp.value)); },
      onkeydown: function (e) { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); },
    });
    bindv(inp, function () { return fmt(get()); });
    return fRow(label, inp);
  }
  function fmt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    return Math.round(v * 1e4) / 1e4;
  }

  function fVec(label, get, set, step, degrees) {
    var mk = function (i) {
      var inp = h('input', {
        type: 'number', step: step || 0.01, value: fmt(comp(get(), i, degrees)),
        onchange: function () {
          var v = (get() || [0, 0, 0]).slice();
          v[i] = degrees ? (parseFloat(inp.value) || 0) * Math.PI / 180 : (parseFloat(inp.value) || 0);
          set(v.map(function (x) { return Math.round(x * 1e5) / 1e5; }));
        },
        onkeydown: function (e) { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); },
      });
      bindv(inp, function () { return fmt(comp(get(), i, degrees)); });
      return inp;
    };
    return fRow(label, [mk(0), mk(1), mk(2)]);
  }
  function comp(v, i, degrees) {
    var x = (v && v[i]) || 0;
    return degrees ? x * 180 / Math.PI : x;
  }

  function fSel(label, options, get, set) {
    var s = h('select', { onchange: function () { set(s.value); }, onkeydown: function (e) { e.stopPropagation(); } });
    options.forEach(function (o) {
      var val = typeof o === 'string' ? o : o.v;
      var txt = typeof o === 'string' ? o : o.t;
      s.appendChild(h('option', { value: val, text: txt }));
    });
    s.value = get();
    bindv(s, get);
    return fRow(label, s);
  }

  function fChk(label, get, set, title) {
    var c = h('input', { type: 'checkbox', onchange: function () { set(c.checked); } });
    c.checked = !!get();
    bindv(c, get);
    var r = fRow(label, c);
    if (title) r.title = title;
    r.querySelector('label').style.flex = '1';
    return r;
  }

  function fText(label, get, set) {
    var inp = h('input', {
      type: 'text', value: get() || '',
      onchange: function () { set(inp.value); },
      onkeydown: function (e) { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); },
    });
    bindv(inp, get);
    return fRow(label, inp);
  }

  function fColor(label, get, set) {
    var c = h('input', { type: 'color', value: get() || '#888888', oninput: function () { set(c.value); } });
    var t = h('input', { type: 'text', value: get() || '#888888',
      onchange: function () { set(t.value); },
      onkeydown: function (e) { if (e.key === 'Enter') t.blur(); e.stopPropagation(); } });
    bindv(c, get); bindv(t, get);
    return fRow(label, [c, t]);
  }

  function fRange(label, get, set, min, max, step, fmtv) {
    var out = h('span', 'v');
    var r = h('input', { type: 'range', min: min, max: max, step: step, value: get(),
      oninput: function () { out.textContent = (fmtv || fmt)(parseFloat(r.value)); },
      onchange: function () { set(parseFloat(r.value)); } });
    out.textContent = (fmtv || fmt)(get());
    bindv(r, get);
    bindv(out, function () { return (fmtv || fmt)(get()); });
    var row = fRow(label, [r, out]);
    return row;
  }

  function btn(label, fn, cls, title) {
    return h('button', { class: 'fg-b' + (cls ? ' ' + cls : ''), text: label, onclick: fn, title: title });
  }

  // =======================================================================
  // PANELS
  // =======================================================================

  function setTab(t) {
    var wasSculpt = S.tab === 'sculpt';
    S.tab = t;
    S.showBones = (t === 'rig');
    if (t === 'sculpt' && !SC.on) sculptBegin();
    else if (wasSculpt && t !== 'sculpt') { SC.on = false; clearSculptOverlay(); }
    renderAll();
    rebuildOverlayVisibility();
    return t;
  }
  function rebuildOverlayVisibility() {
    if (!view) return;
    view.mirror.visible = S.tab === 'build' && anyMirror();
    view.bones.visible = S.showBones;
    renderBones();
    syncOverlay();
  }

  function renderAll() {
    if (!el.bar) return;
    binds = [];
    renderBar();
    renderLeft();
    renderRight();
    renderFoot();
  }

  function renderBar() {
    var a = S.lib.assets[S.id];
    clear(el.name);
    // WIDENING ONE THING IN A FLEX ROW NARROWS ANOTHER, and giving the message
    // bar its minimum took this from 264 px to 76. The bar is the right place
    // for the room — a message is news and a name is not — but the name still
    // has to be recoverable, so it carries what it is showing.
    el.name.title = a ? (a.kind + ' \u00b7 ' + a.name + (a.stock ? ' \u00b7 stock' : '')) : 'nothing open';
    el.name.appendChild(h('span', { class: 'k', text: a ? a.kind : '—' }));
    el.name.appendChild(document.createTextNode(a ? a.name : 'nothing open'));
    if (a && a.stock) el.name.appendChild(h('span', { class: 'k', text: 'stock' }));
    if (a && a.pub) el.name.appendChild(h('span', { class: 'k', style: 'color:#7ad06a;border-color:#2f5a2a', text: 'live' }));
    var tabs = el.tabs.children;
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i].dataset.tab;
      tabs[i].classList.toggle('on', t === S.tab);
      // Rig makes no sense for a prop or a surface; Build makes none for a surface.
      var hide = ((S.kind === 'terrain' || S.kind === 'roster' || S.kind === 'faction') && t !== 'stats' && t !== 'library')
        || (S.kind === 'prop' && t === 'rig')
        || (S.kind === 'part' && (t === 'rig' || t === 'stats'))
        || (t === 'sculpt' && !S.doc)
        || (t === 'guns' && S.kind !== 'unit');
      tabs[i].style.display = hide ? 'none' : '';
    }
    var r = report();
    el.budget.className = 'fg-pill ' + r.budget.level;
    el.budget.textContent = r.budget.parts + 'p · ' + r.budget.meshes + 'm · ' +
      (Math.round(r.budget.tris / 100) / 10) + 'k△';
    el.budget.title = 'parts · meshes · triangles\n' +
      'green ≤160 meshes / 6k tris · amber ≤400 / 20k · red beyond.\n' +
      (r.budget.unique ? r.budget.unique + ' unique (uncached) meshes.\n' : '') +
      (r.errors.length ? '\nERRORS:\n' + r.errors.join('\n') : '') +
      (r.warnings.length ? '\nWARNINGS:\n' + r.warnings.join('\n') : '');
  }

  // ---- left panel ---------------------------------------------------------

  function renderLeft() {
    clear(el.leftHead); clear(el.leftBody); clear(el.leftFoot);
    if (S.tab === 'library') return renderLibrary();
    if (S.tab === 'rig') return renderBoneTree();
    if (S.tab === 'paint') return renderPalette();
    if (S.tab === 'sculpt') return renderSculptList();
    return renderTree();
  }

  /** The part tree, grouped by joint — which is also the mental model the rig
   *  works in, so "what is on the head" is one glance. */
  function renderTree() {
    clear(el.leftHead); clear(el.leftBody); clear(el.leftFoot);
    el.leftHead.appendChild(h('span', { text: 'Parts' }));
    el.leftHead.appendChild(h('span', { class: 'fg-b', text: '＋ part', onclick: function () { addPart({}); } }));
    if (!S.doc) { el.leftBody.appendChild(h('div', { class: 'fg-note', text: 'Nothing open. The Library tab has templates to fork.' })); return; }
    var byJoint = {};
    (S.doc.parts || []).forEach(function (p) {
      var j = p.j || 'body';
      (byJoint[j] = byJoint[j] || []).push(p);
    });
    var order = joints().filter(function (j) { return byJoint[j]; });
    Object.keys(byJoint).forEach(function (j) { if (order.indexOf(j) < 0) order.push(j); });
    order.forEach(function (j) {
      var grp = h('div', 'fg-group');
      var head = h('div', { class: 'g', onclick: function () { select(byJoint[j].map(function (p) { return p.id; })); } },
        [h('span', { text: '▾ ' + j }), h('span', { style: 'color:var(--text-dim)', text: '×' + byJoint[j].length })]);
      grp.appendChild(head);
      var kids = h('div', 'kids');
      byJoint[j].forEach(function (p) { kids.appendChild(partRow(p)); });
      grp.appendChild(kids);
      el.leftBody.appendChild(grp);
    });
    if (!(S.doc.parts || []).length)
      el.leftBody.appendChild(h('div', { class: 'fg-note', html: 'No parts yet. Add one with <b>＋ part</b>, or fork a template from the <b>Library</b> tab.' }));

    // Primitive picker — one click adds a shape on the current joint.
    var pick = h('div', 'fg-grid t3');
    TCM.SHAPES.forEach(function (sh) {
      // `mesh` isn't something you add — you get one by converting a primitive
      // on the Sculpt tab, which is where its provenance and its warning live.
      if (sh === 'mesh') return;
      pick.appendChild(btn(sh === 'trapezoid' ? 'trap' : sh, function () {
        if (sh === 'ref') { setTab('library'); toast('Pick a library part and press ⊕ to insert it'); return; }
        addPart({ sh: sh });
      }, null, 'Add a ' + sh));
    });
    el.leftFoot.appendChild(pick);
  }

  function partRow(p) {
    var on = S.sel.indexOf(p.id) >= 0;
    var m = mat(p.m);
    var sw = h('div', { class: 'fg-sw', style: 'background:' + (m ? (m.team ? '#ffffff' : m.c) : 'transparent') +
      (p.sh === 'node' ? ';border-style:dashed' : '') });
    return h('div', { class: 'fg-item' + (on ? ' on' : ''), onclick: function (e) { select(p.id, e.shiftKey); } }, [
      sw,
      h('span', { class: 'n', text: (p.n || p.id) + (p.mirror ? ' ⇄' : '') +
        (p.mod && p.mod.array ? ' ×' + p.mod.array.n : '') + (p.mod && p.mod.radial ? ' ⟳' + p.mod.radial.n : '') }),
      h('span', { class: 't', text: p.sh || 'box' }),
      h('span', { class: 'x', text: '✕', title: 'delete', onclick: function (e) { e.stopPropagation(); delPart([p.id]); } }),
    ]);
  }

  /** In sculpt mode the left panel lists the parts you can sculpt, flagged by
   *  tier, so switching between them is one click and the cost is visible. */
  function renderSculptList() {
    el.leftHead.appendChild(h('span', { text: 'Sculptable' }));
    if (!S.doc) return;
    var any = false;
    (S.doc.parts || []).forEach(function (p) {
      var t2 = p.sh === 'mesh';
      var t1 = TCM.mesh.MESHABLE.indexOf(p.sh || 'box') >= 0;
      if (!t1 && !t2) return;
      any = true;
      var edits = t2 ? ((p.d && p.d.f && p.d.f.length / 3) | 0) + '△'
        : (p.sculpt && p.sculpt.d ? p.sculpt.d.length + '✎' : '—');
      el.leftBody.appendChild(h('div', {
        class: 'fg-item' + (SC.part === p.id ? ' on' : ''),
        onclick: function () { sculptBegin(p.id); renderAll(); },
      }, [
        h('span', { style: 'color:' + (t2 ? 'var(--accent)' : 'var(--t1)'), text: t2 ? '◆' : '◇' }),
        h('span', { class: 'n', text: p.n || p.id }),
        h('span', { class: 't', text: edits }),
      ]));
    });
    if (!any) el.leftBody.appendChild(h('div', { class: 'fg-note', text:
      'Nothing in this model is sculptable. Add a box, plate, wedge, trapezoid, prism, cylinder, cone or sphere.' }));
    el.leftFoot.appendChild(h('div', { class: 'fg-note', html:
      '◇ parametric + deltas · ◆ editable mesh<br>Click a vertex or face in the viewport to select it; <b>shift</b> adds.' }));
  }

  function renderPalette() {
    el.leftHead.appendChild(h('span', { text: 'Palette' }));
    el.leftHead.appendChild(h('span', { class: 'fg-b', text: '＋ mat', onclick: function () { addMat({}); } }));
    if (!S.doc) return;
    (S.doc.palette || []).forEach(function (m) {
      var users = (S.doc.parts || []).filter(function (p) { return p.m === m.id; }).length;
      var tag = m.team ? (m.team === 2 ? 'team2' : 'team') : m.glow ? 'glow' : m.metal > 0.3 ? 'metal' : '';
      el.leftBody.appendChild(h('div', {
        class: 'fg-item' + (S.selMat === m.id ? ' on' : ''),
        onclick: function () { S.selMat = m.id; renderLeft(); renderRight(); },
      }, [
        h('div', { class: 'fg-sw', style: 'background:' + m.c + (m.glow ? ';box-shadow:0 0 5px ' + m.c : '') }),
        h('span', { class: 'n', text: m.id }),
        h('span', { class: 't', text: tag || (users + '×') }),
        h('span', { class: 'x', text: '✕', onclick: function (e) { e.stopPropagation(); delMat(m.id); } }),
      ]));
    });
    el.leftFoot.appendChild(btn('Assign to selection', function () {
      if (!S.selMat) return toast('Pick a palette entry first', true);
      setMat(null, S.selMat);
    }, 'hot'));
    el.leftFoot.appendChild(btn('Fill by joint', function () {
      var p = part(S.sel[0]);
      if (!p || !S.selMat) return toast('Select a part and a material', true);
      fillMat(S.selMat, 'joint', p.j || 'body');
    }));
    el.leftFoot.appendChild(btn('Fill by shape', function () {
      var p = part(S.sel[0]);
      if (!p || !S.selMat) return toast('Select a part and a material', true);
      fillMat(S.selMat, 'shape', p.sh || 'box');
    }));
    el.leftFoot.appendChild(btn('Replace material', function () {
      var p = part(S.sel[0]);
      if (!p || !S.selMat) return toast('Select a part and a material', true);
      fillMat(S.selMat, 'mat', p.m);
    }, null, 'Every part using the selected part\'s material takes the palette selection instead'));
  }

  function renderBoneTree() {
    el.leftHead.appendChild(h('span', { text: 'Skeleton' }));
    el.leftHead.appendChild(h('span', { class: 'fg-b', text: '＋ bone', onclick: function () { addBone({}); } }));
    if (!S.doc) return;
    var skel = S.doc.skeleton || 'static';
    var stock = TCM.JOINTS[skel] || ['body'];
    var custom = S.doc.bones || [];
    var kidsOf = function (id) { return custom.filter(function (b) { return (b.parent || 'body') === id; }); };
    var row = function (id, isCustom) {
      var parts = (S.doc.parts || []).filter(function (p) { return (p.j || 'body') === id; }).length;
      var b = isCustom ? bone(id) : null;
      var drv = (S.doc.drivers || []).filter(function (d) { return d.bone === id; }).length;
      var node = h('div', { class: 'fg-item' + (S.selBone === id ? ' on' : ''),
        onclick: function () { S.selBone = id; renderLeft(); renderRight(); renderBones(); } }, [
        h('span', { style: 'color:' + (isCustom ? 'var(--accent)' : 'var(--t1)'), text: isCustom ? '◆' : '◇' }),
        h('span', { class: 'n', text: id + (b && b.tag ? ' :' + b.tag : '') }),
        h('span', { class: 't', text: (parts ? parts + 'p' : '') + (drv ? ' ⟳' : '') }),
        isCustom ? h('span', { class: 'x', text: '✕', onclick: function (e) { e.stopPropagation(); delBone(id); } }) : null,
      ]);
      var wrap = h('div', 'fg-group');
      wrap.appendChild(node);
      var kids = kidsOf(id);
      if (kids.length) {
        var kd = h('div', 'kids');
        kids.forEach(function (k) { kd.appendChild(row(k.id, true)); });
        wrap.appendChild(kd);
      }
      return wrap;
    };
    stock.forEach(function (j) { el.leftBody.appendChild(row(j, false)); });
    // Custom bones parented to something that isn't a stock joint still need a home.
    custom.forEach(function (b) {
      if (stock.indexOf(b.parent || 'body') < 0 && !bone(b.parent))
        el.leftBody.appendChild(row(b.id, true));
    });
    el.leftFoot.appendChild(btn('Mirror subtree', function () {
      if (!S.selBone || !bone(S.selBone)) return toast('Select a custom bone', true);
      mirrorBone(S.selBone);
    }, null, 'Copy this bone, its children and their parts to the other side'));
    el.leftFoot.appendChild(btn('＋ driver', function () { addDriver({ bone: S.selBone || 'body' }); }));
  }

  function renderLibrary() {
    el.leftHead.appendChild(h('span', { text: 'Library' }));
    var u = usage();
    el.leftHead.appendChild(h('span', { style: 'margin-left:auto;color:var(--text-dim);font-size:9px', text: u.kb + ' KB' }));
    var kinds = ['unit', 'prop', 'terrain', 'roster', 'faction', 'stamp', 'part'];
    kinds.forEach(function (k) {
      var items = list(k);
      if (!items.length) return;
      el.leftBody.appendChild(h('div', { class: 'fg-h', style: 'margin-top:5px', text: k + 's' }));
      items.forEach(function (a) {
        el.leftBody.appendChild(h('div', {
          class: 'fg-item' + (S.id === a.id ? ' on' : ''),
          onclick: function () { open(a.id); },
        }, [
          h('span', { style: 'color:' + (a.pub ? '#7ad06a' : 'var(--text-dim)'), text: a.pub ? '●' : '○' }),
          h('span', { class: 'n', text: a.name }),
          a.stock ? h('span', { class: 't', text: 'stock' }) : null,
          k === 'part' ? h('span', { class: 'x', text: '⊕', title: 'insert into the open model as a ref',
            onclick: function (e) { e.stopPropagation(); insertRef(S.lib.assets[a.id].model.id); } }) : null,
          h('span', { class: 'x', text: '⑂', title: 'fork', onclick: function (e) { e.stopPropagation(); fork(a.id); } }),
          a.stock ? null : h('span', { class: 'x', text: '✕', title: 'delete', onclick: function (e) {
            e.stopPropagation();
            if (confirmish('Delete "' + a.name + '" for good?')) del(a.id);
          } }),
        ]));
      });
    });
    var f = el.leftFoot;
    f.appendChild(btn('＋ Unit', function () { newAsset('unit', 'skeleton:humanoid'); }, 'hot'));
    f.appendChild(btn('＋ Prop', function () { newAsset('prop'); }));
    f.appendChild(btn('＋ Surface', function () { newAsset('terrain'); }));
    f.appendChild(btn('＋ Roster', function () { newAsset('roster', null, 'New army list'); },
      null, 'An army list both sides can deploy from against a points budget'));
    f.appendChild(btn('＋ Faction', function () { newAsset('faction', null, 'New faction'); }));
    f.appendChild(btn('Save selection as part', function () {
      var n = window.prompt('Name this library part:', 'My part');
      if (n) saveToLibrary(n);
    }, null, 'Turn the current selection into a reusable library entry'));
    f.appendChild(btn('Export pack', function () { exportFile(); }));
    f.appendChild(btn('Import…', function () { el.file.click(); }));
  }

  /** Insert a library entry as an instanced sub-model. Editing the source
   *  updates every user — that is what lets a player restyle a whole army. */
  function insertRef(modelId) {
    if (!S.doc) return toast('Open a unit or prop first', true);
    if (modelId === S.doc.id) return toast('A model cannot ref itself', true);
    var id = addPart({ sh: 'ref', n: modelId, ref: modelId });
    setTab('build');
    return id;
  }

  // ---- right panel: the inspector ----------------------------------------

  function renderRight() {
    clear(el.rightHead); clear(el.rightBody);
    if (S.tab === 'sculpt') return renderSculpt();
    if (S.tab === 'guns') return renderWeapons();
    if (S.tab === 'paint') return renderMatInspector();
    if (S.tab === 'rig') return renderRigInspector();
    if (S.tab === 'stats') return renderStats();
    if (S.tab === 'test') return renderTest();
    if (S.tab === 'library') return renderLibInspector();
    return renderInspector();
  }

  function renderInspector() {
    if (S.tab !== 'build') return;
    clear(el.rightHead); clear(el.rightBody);
    var p = part(S.sel[0]);
    el.rightHead.appendChild(h('span', { text: p ? 'Part · ' + (p.n || p.id) : 'Inspector' }));
    var B = el.rightBody;
    if (!p) {
      B.appendChild(h('div', { class: 'fg-note', html:
        'Click a part in the viewport or the tree.<br><br><b>Keys</b>: <b>D</b> duplicate · <b>M</b> mirror · ' +
        '<b>Del</b> delete · <b>F</b> frame · <b>[</b>/<b>]</b> snap step · <b>Space</b> play/pause · ' +
        '<b>1–4</b> views · drag the coloured arrows to move.' }));
      if (S.sel.length > 1) B.appendChild(h('div', { class: 'fg-note', text: S.sel.length + ' parts selected — paint and delete apply to all of them.' }));
      return;
    }
    B.appendChild(fText('name', function () { return p.n; }, function (v) { setPart(p.id, { n: v }); }));
    B.appendChild(fSel('shape', TCM.SHAPES, function () { return p.sh || 'box'; }, function (v) { setPart(p.id, { sh: v }); }));
    B.appendChild(fSel('joint', joints(), function () { return p.j || 'body'; }, function (v) { setPart(p.id, { j: v }); }));
    if (p.sh !== 'node') {
      var mats = (S.doc.palette || []).map(function (m) { return m.id; });
      B.appendChild(fSel('material', mats.length ? mats : ['—'], function () { return p.m; }, function (v) { setPart(p.id, { m: v }); }));
    }
    B.appendChild(fVec('pos', function () { return p.p; }, function (v) { setPart(p.id, { p: v }); }, S.snap || 0.01));
    B.appendChild(fVec('rot°', function () { return p.r; }, function (v) { setPart(p.id, { r: v }); }, 5, true));
    B.appendChild(fVec('scale', function () { return p.s || [1, 1, 1]; }, function (v) { setPart(p.id, { s: v }); }, 0.05));

    var fields = SHAPE_FIELDS[p.sh || 'box'] || [];
    if (fields.length) {
      B.appendChild(h('div', { class: 'fg-h', text: 'dimensions' }));
      fields.forEach(function (f) {
        var isInt = ['seg', 'ws', 'hs', 'rs', 'ts', 'rseg', 'bevelSeg', 'curveSeg'].indexOf(f) >= 0;
        B.appendChild(fNum(f, function () { return p.d && p.d[f]; },
          function (v) { var o = {}; o[f] = isNaN(v) ? null : (isInt ? Math.round(v) : v); setPart(p.id, { d: o }); },
          isInt ? 1 : 0.01));
      });
    }
    if (p.sh === 'extrude') B.appendChild(outlineEditor(p, 'outline', 2));
    if (p.sh === 'lathe') B.appendChild(outlineEditor(p, 'profile', 2));
    if (p.sh === 'tube') B.appendChild(outlineEditor(p, 'path', 3));
    if (p.sh === 'decal') {
      B.appendChild(fSel('symbol', TCM.DECAL_SYMS, function () { return (p.d && p.d.sym) || 'star'; },
        function (v) { setPart(p.id, { d: { sym: v } }); }));
      B.appendChild(fText('numerals', function () { return p.d && p.d.num; }, function (v) { setPart(p.id, { d: { num: v } }); }));
      B.appendChild(fColor('ink', function () { return (p.d && p.d.c) || '#ffffff'; }, function (v) { setPart(p.id, { d: { c: v } }); }));
    }
    if (p.sh === 'ref') {
      var refs = list('part').map(function (a) { return { v: S.lib.assets[a.id].model.id, t: a.name }; });
      B.appendChild(fSel('source', refs.length ? refs : [{ v: '', t: '—' }],
        function () { return p.d && p.d.ref; }, function (v) { setPart(p.id, { d: { ref: v } }); }));
      B.appendChild(h('div', { class: 'fg-note', text: 'Instanced: editing the source updates every model that refs it.' }));
    }

    B.appendChild(h('div', { class: 'fg-h', text: 'two-bone blend' }));
    B.appendChild(fSel('follows', [{ v: '', t: '— none —' }].concat(joints().map(function (j) { return { v: j, t: j }; })),
      function () { return p.j2 || ''; }, function (v) { setPart(p.id, { j2: v || null }); }));
    if (p.j2) B.appendChild(fRange('weight', function () { return num(p.bw, 0.5); },
      function (v) { setPart(p.id, { bw: v }); }, 0, 1, 0.05));
    B.appendChild(h('div', { class: 'fg-note', text:
      'Parts are rigidly parented — correct for armour plates, which is what this game is made of. When a part should follow two joints (a pauldron trailing the arm, a robe trailing the hips), name a second bone and it interpolates. No skinning, no weight painting.' }));

    B.appendChild(h('div', { class: 'fg-h', text: 'options' }));
    B.appendChild(fChk('mirror ⇄', function () { return p.mirror; }, function (v) { mirror(p.id, v); },
      'Place once, get both sides. On a paired joint (armL/armR) it hops to the opposite joint too.'));
    B.appendChild(fChk('edge highlight', function () { return p.edge; }, function (v) { setPart(p.id, { edge: v || null }); },
      'A lighter shade of the same material — how miniature painters make low-poly read at distance.'));

    B.appendChild(h('div', { class: 'fg-h', text: 'modifiers' }));
    var mod = p.mod || {};
    B.appendChild(fChk('array', function () { return !!mod.array; }, function (v) {
      setMod(p.id, { array: v ? { n: 4, step: [0.06, 0, 0] } : null });
    }));
    if (mod.array) {
      B.appendChild(fNum('count', function () { return mod.array.n; }, function (v) { setMod(p.id, { array: { n: Math.max(1, Math.min(64, Math.round(v))), step: mod.array.step, rstep: mod.array.rstep, sstep: mod.array.sstep } }); }, 1, 1, 64));
      B.appendChild(fVec('step', function () { return mod.array.step; }, function (v) { setMod(p.id, { array: { n: mod.array.n, step: v, rstep: mod.array.rstep, sstep: mod.array.sstep } }); }, 0.01));
      B.appendChild(fVec('rot step°', function () { return mod.array.rstep; }, function (v) { setMod(p.id, { array: { n: mod.array.n, step: mod.array.step, rstep: v, sstep: mod.array.sstep } }); }, 2, true));
    }
    B.appendChild(fChk('radial', function () { return !!mod.radial; }, function (v) {
      setMod(p.id, { radial: v ? { n: 6, r: 0.12, axis: 'y' } : null });
    }));
    if (mod.radial) {
      B.appendChild(fNum('count', function () { return mod.radial.n; }, function (v) { setMod(p.id, { radial: { n: Math.max(1, Math.min(64, Math.round(v))), r: mod.radial.r, axis: mod.radial.axis, offset: mod.radial.offset } }); }, 1, 1, 64));
      B.appendChild(fNum('radius', function () { return mod.radial.r; }, function (v) { setMod(p.id, { radial: { n: mod.radial.n, r: v, axis: mod.radial.axis, offset: mod.radial.offset } }); }, 0.01));
      B.appendChild(fSel('axis', ['x', 'y', 'z'], function () { return mod.radial.axis || 'y'; }, function (v) { setMod(p.id, { radial: { n: mod.radial.n, r: mod.radial.r, axis: v, offset: mod.radial.offset } }); }));
    }

    B.appendChild(h('div', { class: 'fg-h', text: 'attachment tags' }));
    B.appendChild(h('div', { class: 'fg-note', text: 'These are the hooks the engine binds to: the muzzle a shot leaves from, the jets the animator scales, the vent that glows after a discharge.' }));
    var tg = h('div', 'fg-grid');
    TCM.PART_TAGS.forEach(function (t) {
      var on = (p.tags || []).indexOf(t) >= 0;
      tg.appendChild(btn(t, function () { setTag(p.id, t); }, on ? 'on' : null));
    });
    B.appendChild(tg);

    var ops = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;margin-top:7px' });
    ops.appendChild(btn('Duplicate', function () { dupPart(p.id); }));
    ops.appendChild(btn('Frame', function () { frame(true); }));
    ops.appendChild(btn('Delete', function () { delPart([p.id]); }, 'danger'));
    B.appendChild(ops);
  }

  /** Re-editable outlines: the point of storing the outline in the document is
   *  that selecting the part reopens it. One-shot extrusion would mean
   *  rebuilding from scratch to move one corner, and with no import fallback
   *  that is the difference between a tool and an abandoned tool (§4.1). */
  function outlineEditor(p, key, dims) {
    var wrap = h('div');
    wrap.appendChild(h('div', { class: 'fg-h' }, [
      h('span', { text: key + ' (' + (((p.d || {})[key] || []).length) + ' pts)' }),
      h('span', { class: 'fg-b', text: '＋', onclick: function () {
        var pts = ((p.d || {})[key] || []).slice();
        var last = pts[pts.length - 1] || (dims === 3 ? [0, 0, 0] : [0, 0]);
        pts.push(dims === 3 ? [last[0], last[1], last[2] + 0.05] : [last[0] + 0.05, last[1]]);
        var o = {}; o[key] = pts; setPart(p.id, { d: o });
      } }),
    ]));
    var pts = (p.d || {})[key] || [];
    pts.forEach(function (pt, i) {
      var row = h('div', 'fg-row');
      row.appendChild(h('label', { text: '#' + i }));
      for (var c = 0; c < dims; c++) (function (c) {
        var inp = h('input', { type: 'number', step: 0.01, value: fmt(pt[c] || 0),
          onchange: function () {
            var np = clone(pts);
            np[i][c] = parseFloat(inp.value) || 0;
            var o = {}; o[key] = np; setPart(p.id, { d: o });
          },
          onkeydown: function (e) { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); } });
        row.appendChild(inp);
      })(c);
      if (key === 'outline') {
        // Per-vertex straight/arc: a curved plate edge costs two points, not forty.
        row.appendChild(h('span', {
          class: 'fg-b' + (pt[2] ? ' on' : ''), text: pt[2] ? '⌒' : '∕',
          title: 'straight / arc control point',
          onclick: function () {
            var np = clone(pts);
            if (np[i][2]) np[i].length = 2; else np[i][2] = 1;
            var o = {}; o[key] = np; setPart(p.id, { d: o });
          },
        }));
      }
      row.appendChild(h('span', { class: 'x', text: '✕', onclick: function () {
        if (pts.length <= (key === 'outline' ? 3 : 2)) return toast('That is the minimum for a ' + p.sh, true);
        var np = clone(pts); np.splice(i, 1);
        var o = {}; o[key] = np; setPart(p.id, { d: o });
      } }));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderMatInspector() {
    var m = mat(S.selMat) || (S.doc && S.doc.palette && S.doc.palette[0]);
    if (m) S.selMat = m.id;
    el.rightHead.appendChild(h('span', { text: m ? 'Material · ' + m.id : 'Paint' }));
    var B = el.rightBody;
    if (!S.doc) return;
    B.appendChild(fRange('weathering', function () { return num(S.doc.weather, 0); }, setWeather, 0, 0.6, 0.02));
    B.appendChild(h('div', { class: 'fg-note', text: 'Seeded per-part colour jitter across four shade variants per entry. The difference between a kit and a war machine — and bounded, so it costs nothing per frame.' }));
    if (!m) { B.appendChild(h('div', { class: 'fg-note', text: 'No materials. Add one with ＋ mat.' })); return; }
    B.appendChild(h('div', { class: 'fg-h', text: 'entry' }));
    B.appendChild(fText('id', function () { return m.id; }, function (v) {
      var old = m.id, nid = slug(v);
      if (!nid || mat(nid)) return;
      edit('rename material', function () {
        m.id = nid;
        (S.doc.parts || []).forEach(function (p) { if (p.m === old) p.m = nid; });
      });
      S.selMat = nid;
    }));
    B.appendChild(fColor('colour', function () { return m.c; }, function (v) { setMatDef(m.id, { c: v }); }));
    B.appendChild(fRange('rough', function () { return num(m.rough, 0.8); }, function (v) { setMatDef(m.id, { rough: v }); }, 0, 1, 0.02));
    B.appendChild(fRange('metal', function () { return num(m.metal, 0); }, function (v) { setMatDef(m.id, { metal: v }); }, 0, 1, 0.02));
    B.appendChild(fChk('flat shaded', function () { return m.flat !== false; }, function (v) { setMatDef(m.id, { flat: v ? null : false }); },
      'Flat shading is the house style — it is what makes these read as painted miniatures.'));
    B.appendChild(fChk('glow (unlit)', function () { return !!m.glow; }, function (v) { setMatDef(m.id, { glow: v || null }); },
      'Unlit and additive: lenses, plasma coils, engine bells. Never flashes on hit, so it stays hot.'));
    B.appendChild(fChk('team colour', function () { return m.team === true; }, function (v) { setMatDef(m.id, { team: v ? true : null }); },
      'Takes the owning team\'s colour at build time.'));
    B.appendChild(fChk('team secondary', function () { return m.team === 2; }, function (v) { setMatDef(m.id, { team: v ? 2 : null }); },
      'A darker accent off the same hue — stripes, squad flashes.'));
    B.appendChild(h('div', { class: 'fg-h', text: 'decals' }));
    var dg = h('div', 'fg-grid t3');
    TCM.DECAL_SYMS.forEach(function (sym) {
      dg.appendChild(btn(sym, function () {
        var p = part(S.sel[0]);
        var spec = { sh: 'decal', n: sym, m: m.id, d: { w: 0.14, h: 0.14, sym: sym, c: m.c } };
        if (p) { spec.j = p.j; spec.p = (p.p || [0, 0, 0]).slice(); }
        addPart(spec);
        setTab('build');
      }, null, 'Stamp a ' + sym + ' decal on the selected part\'s joint'));
    });
    el.rightBody.appendChild(dg);
  }

  function renderRigInspector() {
    el.rightHead.appendChild(h('span', { text: 'Rig' }));
    var B = el.rightBody;
    if (!S.doc) return;
    B.appendChild(fSel('skeleton', TCM.SKELETONS, function () { return S.doc.skeleton || 'static'; }, setSkeleton));
    B.appendChild(fNum('model scale', function () { return num(S.doc.scale, 1); }, function (v) {
      edit('scale', function () { S.doc.scale = v; });
    }, 0.02));

    // ---- earned behaviours ------------------------------------------------
    var c = contract();
    B.appendChild(h('div', { class: 'fg-h', text: 'earned behaviours' }));
    var mark = function (label, ok, why) {
      return h('div', { class: 'fg-row', title: why || '' }, [
        h('label', { style: 'flex:1', text: label }),
        h('span', { class: ok ? 'fg-ok' : 'fg-no', text: ok === true ? '✓' : ok === false ? '—' : String(ok) }),
      ]);
    };
    B.appendChild(mark('animator', c.animator, 'Which of the game\'s pose engines drives this rig'));
    B.appendChild(mark('walk / aim / flinch / die', c.rig, 'A humanoid or suit rig inherits the whole pose library'));
    B.appendChild(mark('first-person eye', c.head, 'The eye rides the real posed head'));
    B.appendChild(mark('weapon elevation + recoil', c.aim, 'The weapon mount lays onto the target and kicks'));
    B.appendChild(mark('locomotion', c.locomotion, 'Legs to run the gait clock through'));
    B.appendChild(mark('muzzle', c.muzzle, 'Where a shot leaves from — without it, rounds depart the model origin'));
    B.appendChild(mark('turret tracking', c.turret));
    B.appendChild(mark('jets', c.jets ? '×' + c.jets : false, 'Scaled by the jump-pack burn'));
    B.appendChild(mark('drivers', c.drivers ? '×' + c.drivers : false));
    B.appendChild(mark('pose overrides', c.poses ? '×' + c.poses : false));
    B.appendChild(mark('authored clips', c.clips ? '×' + c.clips : false));
    B.appendChild(h('div', { class: 'fg-note', text: 'Tagged: ' + ((c.tags || []).join(', ') || 'nothing yet') }));

    // ---- proportions ------------------------------------------------------
    var skel = S.doc.skeleton || 'static';
    var PR = {
      humanoid: [['hunch', 0, 0.8, 0.02], ['bulk', 0.6, 1.6, 0.02], ['tall', 0.7, 1.4, 0.02],
                 ['armLen', 0.7, 1.5, 0.02], ['legLen', 0.7, 1.5, 0.02], ['neckY', 0.35, 0.75, 0.01]],
      suit: [['scale', 0.6, 2, 0.02], ['hipY', 0.8, 2, 0.02], ['torsoY', 0.1, 0.7, 0.02],
             ['headY', 0.2, 0.9, 0.02], ['hipW', 0.15, 0.7, 0.01], ['thighL', 0.3, 1, 0.02],
             ['shinL', 0.3, 1, 0.02], ['shW', 0.3, 1, 0.02]],
      quad: [['scale', 0.6, 2, 0.02], ['hipY', 0.5, 2, 0.02], ['torsoZ', 0, 1.2, 0.02],
             ['headY', 0, 1, 0.02], ['headZ', 0, 1.2, 0.02], ['hipW', 0.1, 0.8, 0.01],
             ['thighL', 0.2, 1, 0.02], ['shinL', 0.2, 1, 0.02], ['rearZ', 0, 1.5, 0.02]],
      flyer: [['hullY', 0, 2, 0.02], ['rotorY', 0, 2.5, 0.02], ['gunZ', -1, 2, 0.05],
              ['tailZ', 0, 3, 0.05], ['wingW', 0, 3, 0.05]],
      hull: [['deckY', 0, 2, 0.02], ['turretY', 0, 2.5, 0.02], ['gunY', -0.5, 1, 0.02]],
      static: [],
      // A custom skeleton has no proportions by definition — it IS its bones.
      custom: [],
    };
    if (!PR[skel]) PR[skel] = [];
    if (skel === 'custom')
      B.appendChild(h('div', { class: 'fg-note', html:
        'A <b>custom</b> skeleton is nothing but a root and the bones you add below. ' +
        'Tag them, and the engine binds to the tags — that is what earns the behaviours. ' +
        'It has no stock animator, so give it <b>clips</b>.' }));
    if (PR[skel].length) {
      B.appendChild(h('div', { class: 'fg-h', text: 'proportions' }));
      PR[skel].forEach(function (row) {
        B.appendChild(fRange(row[0], function () {
          var d = { hunch: 0, bulk: 1, tall: 1, armLen: 1, legLen: 1, neckY: 0.55,
            scale: 1, hipY: 1.3, torsoY: 0.3, headY: 0.5, hipW: 0.34, thighL: 0.58, shinL: 0.6, shW: 0.58,
            deckY: 0.7, turretY: 1, gunY: 0.2 };
          return num((S.doc.proportions || {})[row[0]], d[row[0]]);
        }, function (v) { setProportion(row[0], v); }, row[1], row[2], row[3]));
      });
    }
    if (skel === 'humanoid') {
      B.appendChild(fSel('helmet', ['none', 'm1', 'stahl', 'cap', 'hood'],
        function () { return (S.doc.proportions || {}).helmet || 'none'; }, function (v) { setProportion('helmet', v); }));
      B.appendChild(fSel('webbing', ['none', 'us', 'ger'],
        function () { return (S.doc.proportions || {}).webbing || 'none'; }, function (v) { setProportion('webbing', v); }));
      B.appendChild(fChk('stock pack', function () { return !!(S.doc.proportions || {}).pack; }, function (v) { setProportion('pack', v || null); }));
      B.appendChild(fColor('uniform', function () { return (S.doc.proportions || {}).uniformC || '#4d5238'; }, function (v) { setProportion('uniformC', v); }));
      B.appendChild(fColor('skin', function () { return (S.doc.proportions || {}).skinC || '#bfa07e'; }, function (v) { setProportion('skinC', v); }));
      B.appendChild(fChk('hide stock body', function () { return !!(S.doc.proportions || {}).stripBody; }, function (v) { setProportion('stripBody', v || null); },
        'Keeps the skeleton and its animation but hides the stock uniform, so your own geometry replaces the man entirely.'));
      B.appendChild(h('div', { class: 'fg-h', text: 'presets' }));
      var pg = h('div', 'fg-grid');
      [['Human', { hunch: 0, bulk: 1, tall: 1, armLen: 1, legLen: 1 }],
       ['Brute', { hunch: 0.4, bulk: 1.22, tall: 0.96, armLen: 1.18, legLen: 0.86 }],
       ['Lean', { hunch: 0.1, bulk: 0.88, tall: 1.08, armLen: 1.1, legLen: 1.14 }],
       ['Heavy', { hunch: 0.16, bulk: 1.3, tall: 1.04, armLen: 1.04, legLen: 0.94 }],
       ['Small', { hunch: 0.3, bulk: 0.74, tall: 0.72, armLen: 1.05, legLen: 0.8 }]].forEach(function (pr) {
        pg.appendChild(btn(pr[0], function () {
          edit('proportion preset', function () {
            S.doc.proportions = Object.assign(S.doc.proportions || {}, pr[1]);
            if (pr[0] === 'Brute') { S.doc.flags = S.doc.flags || {}; S.doc.flags.brute = true; }
          });
        }));
      });
      B.appendChild(pg);
    }

    // ---- rig flags --------------------------------------------------------
    B.appendChild(h('div', { class: 'fg-h', text: 'rig flags' }));
    B.appendChild(fChk('crew served', function () { return !!(S.doc.flags || {}).crewServed; }, function (v) { setFlag('crewServed', v); },
      'A gun crew lies down behind its piece when it is not moving.'));
    B.appendChild(fChk('low profile', function () { return !!(S.doc.flags || {}).lowProfile; }, function (v) { setFlag('lowProfile', v); },
      'Goes prone on defend/ambush, the way a sniper team does.'));
    B.appendChild(fChk('brute swagger', function () { var f = S.doc.flags || {}; return !!(f.brute || f.ork); },
      function (v) { setFlag('brute', v); if (!v) setFlag('ork', false); },
      'Wide stance, rolling shoulders, weapon at the hip, head thrust forward.'));

    // ---- selected bone ----------------------------------------------------
    var b = bone(S.selBone);
    if (b) {
      B.appendChild(h('div', { class: 'fg-h', text: 'bone · ' + b.id }));
      B.appendChild(fSel('parent', joints().filter(function (j) { return j !== b.id; }),
        function () { return b.parent || 'body'; }, function (v) { setBone(b.id, { parent: v }); }));
      B.appendChild(fVec('rest pos', function () { return b.p; }, function (v) { setBone(b.id, { p: v }); }, 0.01));
      B.appendChild(fVec('rest rot°', function () { return b.r; }, function (v) { setBone(b.id, { r: v }); }, 5, true));
      B.appendChild(fSel('semantic tag', [{ v: '', t: '— none —' }].concat(TCM.BONE_TAGS.map(function (t) { return { v: t, t: t }; })),
        function () { return b.tag || ''; }, function (v) { setBone(b.id, { tag: v || null }); }));
      B.appendChild(h('div', { class: 'fg-note', text:
        'The tag is what the engine binds to. Tag `head` and the first-person eye rides this bone; tag `aim` and the weapon elevates and recoils through it; tag `thighL`/`kneeL`/`footL` and locomotion works. Names are yours; tags are the contract.' }));
    } else if (S.selBone) {
      B.appendChild(h('div', { class: 'fg-h', text: 'joint · ' + S.selBone }));
      B.appendChild(h('div', { class: 'fg-note', text: 'A stock joint. Its rest transform comes from the skeleton builder — use the proportion sliders above. New parts you add land on it.' }));
    }

    // ---- drivers ----------------------------------------------------------
    B.appendChild(h('div', { class: 'fg-h' }, [
      h('span', { text: 'drivers' }),
      h('span', { class: 'fg-b', text: '＋', onclick: function () { addDriver({ bone: S.selBone || 'body' }); } }),
    ]));
    B.appendChild(h('div', { class: 'fg-note', text: 'A rotor, a swaying banner, a sweeping dish, a recoiling breech, a hatch that opens on garrison — with no engine code.' }));
    (S.doc.drivers || []).forEach(function (d, i) {
      var box = h('div', { style: 'border:1px solid var(--border);border-radius:5px;padding:3px;margin:3px 0' });
      box.appendChild(h('div', 'fg-row', [
        h('label', { style: 'flex:1;color:var(--accent)', text: d.kind + ' → ' + d.bone }),
        h('span', { class: 'x', text: '✕', onclick: function () { delDriver(i); } }),
      ]));
      box.appendChild(fSel('bone', joints(), function () { return d.bone; }, function (v) { setDriver(i, { bone: v }); }));
      box.appendChild(fSel('kind', DRIVER_KINDS, function () { return d.kind; }, function (v) { setDriver(i, { kind: v }); }));
      box.appendChild(fSel('axis', ['x', 'y', 'z'], function () { return d.axis || 'y'; }, function (v) { setDriver(i, { axis: v }); }));
      box.appendChild(fNum('amp', function () { return num(d.amp, 0.2); }, function (v) { setDriver(i, { amp: v }); }, 0.02));
      box.appendChild(fNum('rate', function () { return num(d.rate, 1); }, function (v) { setDriver(i, { rate: v }); }, 0.1));
      box.appendChild(fSel('when', DRIVER_WHEN.map(function (w) { return { v: w, t: w || 'always' }; }),
        function () { return d.when || ''; }, function (v) { setDriver(i, { when: v || null }); }));
      B.appendChild(box);
    });

    // ---- clips (Tier 3) ---------------------------------------------------
    B.appendChild(h('div', { class: 'fg-h' }, [
      h('span', { text: 'clips · tier 3' }),
      h('span', { class: 'fg-b', text: '＋ ' + S.pose, onclick: function () { addClip(S.pose); } }),
    ]));
    var cs = clips();
    if (!cs) {
      B.appendChild(h('div', { class: 'fg-note', html:
        'A skeleton the stock animators do not know needs its own animation. Author a clip per stance and the ' +
        '<b>generic animator</b> plays whichever matches — it reuses the game\'s own state selection, and the ' +
        'procedural overlays (aim, recoil, suppression, death) still apply on top.<br><br>' +
        '<b>Authoring a clip replaces the stock animator for this model.</b>' }));
    }
    var bg = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;margin:3px 0' });
    bg.appendChild(btn('Borrow "' + S.pose + '" from stock', function () { borrowClip(S.pose); }, 'hot',
      'Sample the hand-written infantry pose engine into keyframes on this model\'s tagged bones. A fork always beats a blank timeline.'));
    B.appendChild(bg);
    if (cs) {
      Object.keys(cs).forEach(function (cn) {
        var c = cs[cn];
        var on = S.clip === cn;
        B.appendChild(h('div', { class: 'fg-item' + (on ? ' on' : ''),
          onclick: function () { S.clip = on ? null : cn; setPose(cn); renderRight(); } }, [
          h('span', { style: 'color:var(--accent)', text: on ? '▾' : '▸' }),
          h('span', { class: 'n', text: cn }),
          h('span', { class: 't', text: c.tracks.length + 'tr ' + (c.speedSync ? '⏱' : '') }),
          h('span', { class: 'x', text: '✕', onclick: function (e) { e.stopPropagation(); delClip(cn); } }),
        ]));
        if (!on) return;
        B.appendChild(fNum('duration', function () { return c.dur; }, function (v) { setClip(cn, { dur: v }); }, 0.05));
        B.appendChild(fChk('loop', function () { return c.loop !== false; }, function (v) { setClip(cn, { loop: v }); }));
        B.appendChild(fChk('speed sync', function () { return !!c.speedSync; }, function (v) { setClip(cn, { speedSync: v }); },
          'Advance the clip with real ground speed, so the walk does not skate.'));
        if (c.speedSync) B.appendChild(fNum('base speed', function () { return num(c.baseSpd, 0); },
          function (v) { setClip(cn, { baseSpd: v || null }); }, 0.1));
        B.appendChild(timeline(cn, c));
        // events
        B.appendChild(h('div', { class: 'fg-h' }, [
          h('span', { text: 'events' }),
          h('span', { class: 'fg-b', text: '＋', onclick: function () { setEvent(cn, -1, { t: 0, e: 'footstep' }); } }),
        ]));
        (c.events || []).forEach(function (ev, i) {
          var row = h('div', 'fg-row');
          row.appendChild(h('label', { text: 't' }));
          var ti = h('input', { type: 'number', step: 0.01, value: ev.t,
            onchange: function () { setEvent(cn, i, { t: parseFloat(ti.value) || 0 }); },
            onkeydown: function (e) { e.stopPropagation(); } });
          row.appendChild(ti);
          var es = h('select', { onchange: function () { setEvent(cn, i, { e: es.value }); },
            onkeydown: function (e) { e.stopPropagation(); } });
          ['footstep', 'fire', 'land'].forEach(function (n) { es.appendChild(h('option', { value: n, text: n })); });
          es.value = ev.e;
          row.appendChild(es);
          row.appendChild(h('span', { class: 'x', text: '✕', onclick: function () { setEvent(cn, i, null); } }));
          B.appendChild(row);
        });
        B.appendChild(h('div', { class: 'fg-note', text: 'Events fire the hooks the engine already has, so a custom biped gets correct per-surface footstep audio for nothing.' }));
      });
    }

    // ---- pose overrides ---------------------------------------------------
    B.appendChild(h('div', { class: 'fg-h', text: 'pose override · ' + S.pose }));
    B.appendChild(h('div', { class: 'fg-note', text: 'Retune one channel of one pose for this model only. Diff-based: only what you change is stored.' }));
    var CH = [['sx', 'spine pitch'], ['sy', 'spine twist'], ['hx', 'head pitch'], ['bx', 'body pitch'],
              ['by', 'body height'], ['lx', 'thigh'], ['kx', 'knee'], ['lz', 'leg splay'],
              ['aLx', 'L shoulder'], ['aRx', 'R shoulder'], ['eLx', 'L elbow'], ['eRx', 'R elbow'],
              ['ay', 'weapon height'], ['az', 'weapon reach'], ['ax', 'weapon elev'],
              ['gait', 'cadence'], ['amp', 'stride']];
    var have = (S.doc.poses || {})[S.pose] || {};
    CH.forEach(function (ch) {
      var row = fNum(ch[1], function () {
        var v = have[ch[0]];
        return v === undefined ? (G.INFPOSE && G.INFPOSE[S.pose] ? G.INFPOSE[S.pose][ch[0]] : 0) : v;
      }, function (v) { setPoseChannel(S.pose, ch[0], isNaN(v) ? null : v); }, 0.02);
      if (have[ch[0]] !== undefined) {
        row.style.borderLeft = '2px solid var(--accent)';
        row.appendChild(h('span', { class: 'x', text: '⟲', title: 'revert to stock', onclick: function () { setPoseChannel(S.pose, ch[0], null); } }));
      }
      B.appendChild(row);
    });
  }

  function renderSculpt() {
    var B = el.rightBody;
    var p = sculptTarget();
    el.rightHead.appendChild(h('span', { text: p ? 'Sculpt · ' + (p.n || p.id) : 'Sculpt' }));
    if (!p || !SC.on || !SC.mesh) {
      B.appendChild(h('div', { class: 'fg-note', html:
        'Select a part on the <b>Build</b> tab, then come back here.<br><br>' +
        'Sculptable shapes: box, plate, wedge, trapezoid, prism, cyl, cone, sph. ' +
        'Anything else has to be converted to an editable mesh first — and only ' +
        'the hand-authored primitives have the stable vertex ordering that a ' +
        'saved sculpt indexes into.' }));
      return;
    }
    var tier2 = p.sh === 'mesh';
    B.appendChild(h('div', { class: 'fg-note', html: tier2
      ? '<b>Tier 2 — editable mesh.</b> ' + (SC.mesh.f.length / 3) + ' triangles, ' +
        (SC.mesh.v.length / 3) + ' vertices. Parametric dimensions are gone; topology tools are live.' +
        (p.d && p.d.from ? ' Was a <b>' + p.d.from + '</b>.' : '')
      : '<b>Tier 1 — non-destructive.</b> The ' + (p.sh || 'box') + ' stays a ' + (p.sh || 'box') +
        ': change its dimensions and your sculpt scales with it. ' +
        ((p.sculpt && p.sculpt.d && p.sculpt.d.length) || 0) + ' edited vertices of ' +
        (SC.mesh.v.length / 3) + '.' }));

    if (!tier2) {
      B.appendChild(fRange('resolution', function () { return (p.sculpt && p.sculpt.res) || 0; },
        function (v) { setSculptRes(p.id, v); }, 0, 3, 1));
      B.appendChild(h('div', { class: 'fg-note', text:
        'Each step subdivides ×4. Capped at 3 — a sphere at 3 is 1,500+ vertices and every one of them is unique geometry.' }));
    }

    B.appendChild(h('div', { class: 'fg-h', text: 'select' }));
    var mg = h('div', 'fg-grid t3');
    ['vertex', 'edge', 'face'].forEach(function (mo) {
      mg.appendChild(btn(mo, function () {
        SC.mode = mo; SC.sel = []; highlightSculpt(); renderRight();
      }, SC.mode === mo ? 'on' : null));
    });
    B.appendChild(mg);
    var sg = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;margin:3px 0' });
    sg.appendChild(btn('all', function () { sculptSelectAll(); }));
    sg.appendChild(btn('none', function () { sculptSelect([]); }));
    sg.appendChild(btn('grow', function () { sculptGrow(); }));
    sg.appendChild(btn('mirror sel', function () { sculptMirrorSelection(); }));
    B.appendChild(sg);
    B.appendChild(h('div', { class: 'fg-row' }, [
      h('label', { text: 'selected' }),
      h('span', { class: 'fg-msg', text: SC.sel.length + ' ' + (SC.mode === 'face' ? 'face' : 'vertex') + (SC.sel.length === 1 ? '' : 's') }),
    ]));

    B.appendChild(h('div', { class: 'fg-h', text: 'brush' }));
    B.appendChild(fRange('falloff', function () { return SC.radius; }, function (v) { SC.radius = v; }, 0, 0.6, 0.01));
    B.appendChild(h('div', { class: 'fg-note', text: 'Soft selection: a drag moves a region, not a spike. 0 = only the selected vertices.' }));
    B.appendChild(fRange('strength', function () { return SC.strength; }, function (v) { SC.strength = v; }, 0.002, 0.15, 0.002));
    B.appendChild(fChk('symmetry (x)', function () { return SC.sym; }, function (v) { SC.sym = v; },
      'Whatever you move on one side moves on the other. Precomputed with the base mesh, so it is free.'));

    B.appendChild(h('div', { class: 'fg-h', text: 'shape' }));
    var tg = h('div', 'fg-grid');
    tg.appendChild(btn('inflate', function () { sculptInflate(SC.strength); }));
    tg.appendChild(btn('pinch', function () { sculptInflate(-SC.strength); }));
    tg.appendChild(btn('smooth', function () { sculptSmooth(0.5); }));
    tg.appendChild(btn('flatten', function () { sculptFlatten(1); }));
    tg.appendChild(btn('noise', function () { sculptNoise(SC.strength, 1 + (S.hist.length | 0)); }));
    tg.appendChild(btn('relax ×4', function () { for (var i = 0; i < 4; i++) sculptSmooth(0.4); }));
    B.appendChild(tg);
    B.appendChild(h('div', { class: 'fg-h', text: 'nudge' }));
    var ng = h('div', 'fg-grid t3');
    [['−X', [-1, 0, 0]], ['+X', [1, 0, 0]], ['−Y', [0, -1, 0]],
     ['+Y', [0, 1, 0]], ['−Z', [0, 0, -1]], ['+Z', [0, 0, 1]]].forEach(function (d) {
      ng.appendChild(btn(d[0], function () {
        sculptMove([d[1][0] * SC.strength, d[1][1] * SC.strength, d[1][2] * SC.strength], false);
      }));
    });
    B.appendChild(ng);

    if (tier2) {
      B.appendChild(h('div', { class: 'fg-h', text: 'topology' }));
      B.appendChild(h('div', { class: 'fg-note', text: 'Face mode. These change the mesh itself, which deltas cannot express.' }));
      var pg = h('div', 'fg-grid');
      pg.appendChild(btn('extrude', function () { topoOp('extrude', SC.strength * 3); }));
      pg.appendChild(btn('inset', function () { topoOp('inset', 0.3); }));
      pg.appendChild(btn('subdivide', function () { topoOp('subdivide'); }));
      pg.appendChild(btn('bridge', function () { topoOp('bridge'); }, null, 'Select exactly two faces'));
      pg.appendChild(btn('flip', function () { topoOp('flip'); }));
      pg.appendChild(btn('delete', function () { topoOp('delete'); }, 'danger'));
      B.appendChild(pg);
      B.appendChild(btn('Weld duplicate vertices', function () { topoOp('weld', 1e-3); }));
      B.appendChild(btn('Flip every face', function () { topoOp('flipAll'); }));
    } else {
      B.appendChild(h('div', { class: 'fg-h', text: 'tier 2' }));
      B.appendChild(btn('Convert to editable mesh →', function () { toEditableMesh(p.id); }, 'hot',
        'One way. You gain extrude/inset/bridge/subdivide and lose the parametric dimensions.'));
      B.appendChild(h('div', { class: 'fg-note', text:
        'Deltas can move vertices but cannot add or remove them. Converting freezes the current shape into raw topology so it can be cut about.' }));
      B.appendChild(btn('Clear the sculpt', function () { sculptReset(); }, 'danger'));
    }
    var r = report();
    B.appendChild(h('div', { class: 'fg-h', text: 'cost' }));
    B.appendChild(h('div', { class: 'fg-note', html:
      '<b>' + r.budget.unique + '</b> unique (uncached) meshes of <b>' + r.budget.meshes + '</b>. ' +
      'Sculpted and editable-mesh parts opt out of the shared geometry cache by definition — each one is a real draw call and real memory.' }));
  }

  /** Grow the selection to its neighbours — the fastest way to go from one
   *  clicked vertex to the region you actually meant. */
  function sculptGrow() {
    if (!SC.mesh || !SC.sel.length) return false;
    var m = SC.mesh, has = {}, out = SC.sel.slice(), i;
    SC.sel.forEach(function (x) { has[x] = 1; });
    if (SC.mode === 'face') {
      var vs = {}; facesToVerts(SC.sel).forEach(function (v) { vs[v] = 1; });
      for (var t = 0; t < m.f.length / 3; t++) {
        if (has[t]) continue;
        if (vs[m.f[t * 3]] || vs[m.f[t * 3 + 1]] || vs[m.f[t * 3 + 2]]) { out.push(t); has[t] = 1; }
      }
    } else {
      for (i = 0; i < m.f.length; i += 3) for (var e = 0; e < 3; e++) {
        var a = m.f[i + e], b = m.f[i + (e + 1) % 3];
        if (has[a] && !has[b]) { out.push(b); has[b] = 1; }
        else if (has[b] && !has[a]) { out.push(a); has[a] = 1; }
      }
    }
    return sculptSelect(out);
  }

  function sculptMirrorSelection() {
    if (!SC.mesh || !SC.mesh.sym) return false;
    var out = SC.sel.slice(), has = {};
    SC.sel.forEach(function (x) { has[x] = 1; });
    if (SC.mode === 'face') {
      // Mirror a face by mirroring its vertices and finding the matching face.
      var want = {};
      for (var i = 0; i < SC.sel.length; i++) {
        var key = [];
        for (var k = 0; k < 3; k++) {
          var mv = SC.mesh.sym[SC.mesh.f[SC.sel[i] * 3 + k]];
          if (mv < 0) { key = null; break; }
          key.push(mv);
        }
        if (key) want[key.sort(function (a, b) { return a - b; }).join(',')] = 1;
      }
      for (var t = 0; t < SC.mesh.f.length / 3; t++) {
        if (has[t]) continue;
        var kk = [SC.mesh.f[t * 3], SC.mesh.f[t * 3 + 1], SC.mesh.f[t * 3 + 2]].sort(function (a, b) { return a - b; }).join(',');
        if (want[kk]) { out.push(t); has[t] = 1; }
      }
    } else {
      for (var j = 0; j < SC.sel.length; j++) {
        var m2 = SC.mesh.sym[SC.sel[j]];
        if (m2 >= 0 && !has[m2]) { out.push(m2); has[m2] = 1; }
      }
    }
    return sculptSelect(out);
  }

  // ---- weapons & abilities ------------------------------------------------

  function renderWeapons() {
    var B = el.rightBody;
    el.rightHead.appendChild(h('span', { text: 'Armament' }));
    if (!S.meta || S.kind !== 'unit') {
      B.appendChild(h('div', { class: 'fg-note', text: 'Only units carry weapons.' }));
      return;
    }
    var ws = weaponList();
    B.appendChild(h('div', { class: 'fg-note', html:
      ws.length
        ? 'This unit fires from its <b>weapon data</b>, not from a behaviour branch. Everything below is read straight off these documents at fire time.'
        : 'With no weapons the unit falls back to its <b>behaviour</b> setting on the Stats tab (the hand-written branch for that kind). Add a weapon and it switches to the data path.' }));

    var mk = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;margin:3px 0' });
    mk.appendChild(btn('＋ weapon', function () { addWeapon(); }, 'hot'));
    var bsel = h('select', { style: 'flex:1;font-size:9.5px', onkeydown: function (e) { e.stopPropagation(); } });
    bsel.appendChild(h('option', { value: '', text: 'borrow from a stock unit…' }));
    try {
      Object.keys(G.UNIT_DEFS).filter(function (k) { return !G.UNIT_DEFS[k].custom; }).sort().forEach(function (k) {
        bsel.appendChild(h('option', { value: k, text: G.UNIT_DEFS[k].name }));
      });
    } catch (e) {}
    bsel.addEventListener('change', function () { if (bsel.value) { borrowWeapon(bsel.value); bsel.value = ''; } });
    mk.appendChild(bsel);
    B.appendChild(mk);

    ws.forEach(function (w, wi) {
      var open = S.weapon === wi;
      B.appendChild(h('div', { class: 'fg-item' + (open ? ' on' : ''),
        onclick: function () { S.weapon = open ? -1 : wi; renderRight(); } }, [
        h('span', { style: 'color:var(--accent)', text: open ? '▾' : '▸' }),
        h('span', { class: 'n', text: w.name }),
        h('span', { class: 't', text: w.slot + ' · ' + w.modes.length + 'm' }),
        h('span', { class: 'x', text: '✕', onclick: function (e) { e.stopPropagation(); delWeapon(wi); } }),
      ]));
      if (!open) return;
      B.appendChild(fText('name', function () { return w.name; }, function (v) { setWeapon(wi, { name: v }); }));
      B.appendChild(fSel('slot', ['primary', 'secondary', 'melee', 'special'],
        function () { return w.slot; }, function (v) { setWeapon(wi, { slot: v }); }));
      B.appendChild(fNum('magazine', function () { return num(w.ammo, 0); }, function (v) { setWeapon(wi, { ammo: v }); }, 1));
      B.appendChild(fNum('reload (s)', function () { return num(w.reload, 0); }, function (v) { setWeapon(wi, { reload: v }); }, 0.1));
      w.modes.forEach(function (m, mi) { B.appendChild(modeBox(wi, mi, w, m)); });
      B.appendChild(btn('＋ firing mode', function () { addMode(wi); }, null,
        'A second mode on the same housing — a burst and an aimed lance, a coax and a main gun.'));
    });

    // ---- abilities --------------------------------------------------------
    B.appendChild(h('div', { class: 'fg-h', text: 'abilities' }));
    B.appendChild(h('div', { class: 'fg-note', text:
      'Each of these is an implementation the engine already has. New ones are added once by a developer and then every player-made unit can use them.' }));
    var have = {};
    abilityList().forEach(function (a, i) {
      have[a.a] = true;
      var d = TCM.ABILITIES[a.a] || {};
      var box = h('div', { style: 'border:1px solid var(--border);border-radius:5px;padding:3px;margin:3px 0' });
      box.appendChild(h('div', 'fg-row', [
        h('label', { style: 'flex:1;color:var(--accent)', text: d.label || a.a }),
        h('span', { class: 'x', text: '✕', onclick: function () { delAbility(i); } }),
      ]));
      box.appendChild(fSel('trigger', ['order', 'auto', 'key'], function () { return a.trigger; },
        function (v) { setAbility(i, { trigger: v }); }));
      if (a.trigger === 'key') box.appendChild(fText('key', function () { return a.key || ''; },
        function (v) { setAbility(i, { key: v.toUpperCase().slice(0, 1) || null }); }));
      box.appendChild(fNum('cooldown', function () { return num(a.cd, 6); }, function (v) { setAbility(i, { cd: v }); }, 0.5));
      if (d.needs) box.appendChild(h('div', { class: 'fg-note', text: 'Needs the `' + d.needs + '` flag on the Stats tab to do anything.' }));
      B.appendChild(box);
    });
    var ag = h('div', 'fg-grid');
    Object.keys(TCM.ABILITIES).forEach(function (k) {
      if (have[k]) return;
      ag.appendChild(btn(k, function () { addAbility(k); }, null, TCM.ABILITIES[k].label));
    });
    B.appendChild(ag);
  }

  function modeBox(wi, mi, w, m) {
    var box = h('div', { style: 'border:1px solid var(--border-lt);border-radius:5px;padding:4px;margin:4px 0' });
    box.appendChild(h('div', 'fg-row', [
      h('label', { style: 'flex:1;color:var(--t1);font-weight:700', text: m.name || ('mode ' + mi) }),
      h('span', { class: 'x', text: '✕', onclick: function () { delMode(wi, mi); } }),
    ]));
    box.appendChild(fText('name', function () { return m.name; }, function (v) { setMode(wi, mi, { name: v }); }));
    box.appendChild(fSel('projectile', TCM.PROJECTILES, function () { return m.projectile; },
      function (v) { setMode(wi, mi, { projectile: v }); }));
    box.appendChild(fSel('trigger', TCM.TRIGGERS, function () { return m.trigger || 'hip'; },
      function (v) { setMode(wi, mi, { trigger: v }); }));
    box.appendChild(fNum('damage', function () { return num(m.dmg, 0); }, function (v) { setMode(wi, mi, { dmg: v }); }, 1));
    box.appendChild(fNum('range', function () { return num(m.rng, 0); }, function (v) { setMode(wi, mi, { rng: v }); }, 1));
    box.appendChild(fNum('min range', function () { return num(m.minRng, 0); }, function (v) { setMode(wi, mi, { minRng: v || null }); }, 1));
    box.appendChild(fNum('rounds/min', function () { return num(m.rof, 60); }, function (v) { setMode(wi, mi, { rof: v }); }, 10));
    box.appendChild(fNum('cooldown (s)', function () { return num(m.cd, 0); }, function (v) { setMode(wi, mi, { cd: v || null }); }, 0.05));
    box.appendChild(fNum('burst', function () { return num(m.burst, 1); }, function (v) { setMode(wi, mi, { burst: Math.max(1, Math.round(v)) }); }, 1));
    if (num(m.burst, 1) > 1)
      box.appendChild(fNum('burst gap', function () { return num(m.gap, 0.075); }, function (v) { setMode(wi, mi, { gap: v }); }, 0.005));
    box.appendChild(fNum('cone (rad)', function () { return num(m.cone, 0); }, function (v) { setMode(wi, mi, { cone: v }); }, 0.001));
    box.appendChild(fNum('blast radius', function () { return num(m.aoe, 0); }, function (v) { setMode(wi, mi, { aoe: v || null }); }, 0.5));
    // The numbers a player can reason about, not the raw engine ones (§7.1).
    var sp = TCM.modeSpread(m), dps = TCM.modeDps(m), iv = TCM.modeInterval(m);
    box.appendChild(h('div', { class: 'fg-note', html:
      '<b>' + (Math.round(dps * 10) / 10) + '</b> dps · <b>' + (Math.round(60 / iv)) + '</b> rpm · ' +
      '<b>' + (Math.round(iv * 1000) / 1000) + '</b> s/shot<br>' +
      'cone <b>' + (Math.round(sp.mrad * 10) / 10) + '</b> mrad ≈ <b>' +
      (Math.round(sp.at100 * (G.METERS_PER_UNIT || 4) * 10) / 10) + ' m</b> group at 100 m<br>' +
      'reach <b>' + Math.round(num(m.rng, 0) * (G.METERS_PER_UNIT || 4)) + ' m</b>' }));
    box.appendChild(h('div', { class: 'fg-h', text: 'behaviour' }));
    box.appendChild(fChk('needs line of sight', function () { return m.needsLos !== false; },
      function (v) { setMode(wi, mi, { needsLos: v ? null : false }); },
      'Off for indirect fire — mortars and artillery drop over the hill.'));
    box.appendChild(fChk('lay the gun first', function () { return m.lay !== false; },
      function (v) { setMode(wi, mi, { lay: v ? null : false }); },
      'The shooter shoulders and settles before the first round. Off for vehicles and flamethrowers.'));
    box.appendChild(fChk('spends ammo', function () { return !!m.ammo; },
      function (v) { setMode(wi, mi, { ammo: v ? 1 : null }); }));
    box.appendChild(fChk('sustained fire', function () { return !!m.burstPause; },
      function (v) { setMode(wi, mi, { burstPause: v ? 12 : null }); },
      'Fires bursts then pauses to let the barrel settle, like a real machine-gunner.'));
    box.appendChild(fSel('sound', ['', 'rifle', 'mg', 'cannon', 'rocket', 'mortar', 'flame', 'pulse'],
      function () { return m.sfx || ''; }, function (v) { setMode(wi, mi, { sfx: v || null }); }));
    box.appendChild(fRange('muzzle flash', function () { return num(m.flash, 0.5); },
      function (v) { setMode(wi, mi, { flash: v }); }, 0, 1.5, 0.05));
    if (m.projectile === 'beam')
      box.appendChild(fColor('beam colour', function () { return m.color ? '#' + (m.color >>> 0).toString(16).padStart(6, '0') : '#9fe8ff'; },
        function (v) { setMode(wi, mi, { color: parseInt(v.slice(1), 16) }); }));
    return box;
  }

  // ---- stats: unit / prop / surface --------------------------------------

  function renderStats() {
    var B = el.rightBody;
    var m = S.meta;
    el.rightHead.appendChild(h('span', { text: S.kind === 'terrain' ? 'Surface' : S.kind === 'prop' ? 'Prop' : 'Unit' }));
    if (!m) { B.appendChild(h('div', { class: 'fg-note', text: 'A library part has no stats — it exists to be referenced by units and props.' })); return; }

    B.appendChild(fText('name', function () { return m.name; }, function (v) { setMeta({ name: v }); rename(S.id, v); }));
    B.appendChild(h('div', { class: 'fg-row' }, [h('label', { text: 'id' }), h('span', { class: 'fg-msg', text: m.id })]));

    if (S.kind === 'unit') {
      var kinds = [];
      try { for (var k in G.UNIT_DEFS) if (kinds.indexOf(G.UNIT_DEFS[k].kind) < 0) kinds.push(G.UNIT_DEFS[k].kind); } catch (e) {}
      kinds.sort();
      B.appendChild(fSel('behaviour', kinds.length ? kinds : ['rifle'], function () { return m.unitKind || 'rifle'; },
        function (v) { setMeta({ unitKind: v }); }));
      B.appendChild(fSel('AI role', ROLES, function () { return m.role || 'lineInfantry'; }, function (v) { setMeta({ role: v }); }));
      B.appendChild(fText('faction', function () { return m.faction; }, function (v) { setMeta({ faction: v }); }));
      B.appendChild(fColor('minimap', function () { return m.color || '#6a6a5a'; }, function (v) { setMeta({ color: v }); }));
      B.appendChild(h('div', { class: 'fg-h', text: 'combat' }));
      [['hp', 'hit points', 5, 1, 5000], ['spd', 'speed', 0.1, 0, 30], ['dmg', 'damage', 1, 0, 2000],
       ['rng', 'range', 1, 0, 400], ['atkTime', 'attack time', 0.05, 0.05, 20],
       ['armor', 'armour', 0.01, 0, 1], ['shield', 'shield', 5, 0, 2000],
       ['size', 'size', 0.05, 0.2, 8], ['vis', 'vision', 1, 0, 200], ['scale', 'mesh scale', 0.02, 0.2, 4]]
        .forEach(function (f) {
          B.appendChild(fNum(f[1], function () { return num(m[f[0]], f[0] === 'scale' ? 1 : 0); },
            function (v) { setMeta(makeP(f[0], isNaN(v) ? null : v)); }, f[2], f[3], f[4]));
        });
      // Derived numbers, in units a player can reason about (§7.1).
      var dps = num(m.dmg, 0) / Math.max(0.15, num(m.atkTime, 1));
      var rpm = 60 / Math.max(0.05, num(m.atkTime, 1));
      B.appendChild(h('div', { class: 'fg-note', html:
        '<b>' + Math.round(dps * 10) / 10 + '</b> dps · <b>' + Math.round(rpm) + '</b> shots/min · reach <b>' +
        Math.round(num(m.rng, 0) * (G.METERS_PER_UNIT || 4)) + ' m</b>' }));

      B.appendChild(h('div', { class: 'fg-h', text: 'flags' }));
      var fg = h('div', 'fg-grid');
      UNIT_FLAGS.forEach(function (f) {
        fg.appendChild(btn(f, function () {
          var v = m[f] ? null : (f === 'hover' ? 0.7 : true);
          setMeta(makeP(f, v));
        }, m[f] ? 'on' : null));
      });
      B.appendChild(fg);

      var c = cost();
      B.appendChild(h('div', { class: 'fg-h', text: 'points' }));
      B.appendChild(h('div', { class: 'fg-note', html: 'Computed <b>' + c.computed + '</b> pts' +
        (c.near ? ' — about a <b>' + c.near.name + '</b> ' + (c.near.pct >= 0 ? '+' : '') + c.near.pct + '%' : '') +
        '.<br>Both sides deploy against a points budget, so this is what keeps a custom unit playable against a stock one.' }));
      B.appendChild(fNum('pin cost', function () { return m.cost; }, function (v) { setMeta({ cost: isNaN(v) ? null : v }); }, 5));

      B.appendChild(h('div', { class: 'fg-h', text: 'fightability' }));
      var L = lint();
      if (!L.length) B.appendChild(h('div', { class: 'fg-note fg-ok', text: '✓ passes — the AI may field this unit.' }));
      L.forEach(function (x) {
        B.appendChild(h('div', { class: 'fg-note ' + (x.bad ? 'fg-bad' : ''), text: (x.bad ? '✕ ' : '! ') + x.t }));
      });
    }

    if (S.kind === 'prop') {
      B.appendChild(fColor('minimap', function () { return m.color || '#6a6a5a'; }, function (v) { setMeta({ color: v }); }));
      B.appendChild(fNum('height', function () { return num(m.height, 1); }, function (v) { setMeta({ height: v }); }, 0.1, 0, 12));
      B.appendChild(fNum('hit points', function () { return num(m.hp, 80); }, function (v) { setMeta({ hp: v }); }, 5, 1, 4000));
      B.appendChild(fRange('cover', function () { return num(m.cover, 0.35); }, function (v) { setMeta({ cover: v }); }, 0, 0.8, 0.01));
      B.appendChild(h('div', { class: 'fg-note', text: 'Height sets what it blocks and how much of a man it hides; cover is the damage reduction for anyone behind it.' }));
      B.appendChild(h('div', { class: 'fg-h', text: 'behaviour' }));
      B.appendChild(fChk('see through', function () { return !!m.seethrough; }, function (v) { setMeta({ seethrough: v || null }); },
        'Foliage: does not block line of sight.'));
      B.appendChild(fRange('bullets pass', function () { return num(m.passthrough, 0); }, function (v) { setMeta({ passthrough: v || null }); }, 0, 1, 0.05));
      B.appendChild(fChk('soft', function () { return !!m.soft; }, function (v) { setMeta({ soft: v || null }); }));
      B.appendChild(fChk('flammable', function () { return !!m.flammable; }, function (v) { setMeta({ flammable: v || null }); }));
      B.appendChild(fChk('explosive', function () { return !!m.explosive; }, function (v) { setMeta({ explosive: v || null }); }));
      if (m.explosive) {
        B.appendChild(fNum('blast radius', function () { return num(m.aoe, 4); }, function (v) { setMeta({ aoe: v }); }, 0.5));
        B.appendChild(fNum('blast damage', function () { return num(m.dmg, 45); }, function (v) { setMeta({ dmg: v }); }, 5));
      }
      B.appendChild(fChk('scatter brush', function () { return !!m.scatter; }, function (v) { setMeta({ scatter: v || null }); },
        'Painted several at a time across the brush radius, like trees.'));
      B.appendChild(fChk('big (burns long)', function () { return !!m.big; }, function (v) { setMeta({ big: v || null }); }));
      B.appendChild(fNum('garrison slots', function () { return num(m.slots, 0); }, function (v) { setMeta({ slots: v || null }); }, 1, 0, 12));
      if (num(m.slots, 0) > 0) B.appendChild(fNum('floors', function () { return num(m.floors, 1); }, function (v) { setMeta({ floors: v }); }, 1, 1, 3));
      B.appendChild(h('div', { class: 'fg-h', text: 'placement' }));
      B.appendChild(fChk('random spin', function () { return m.spin !== false; }, function (v) { setMeta({ spin: v ? null : false }); }));
      B.appendChild(fRange('size variation', function () { return num(m.vary, 0.1); }, function (v) { setMeta({ vary: v }); }, 0, 0.4, 0.02));
    }

    if (S.kind === 'roster') return renderRoster(B, m);
    if (S.kind === 'faction') return renderFaction(B, m);

    if (S.kind === 'terrain') {
      B.appendChild(fText('surface id', function () { return m.id; }, function (v) { setMeta({ id: slug(v) }); }));
      B.appendChild(fColor('colour', function () { return m.c; }, function (v) { setMeta({ c: v }); }));
      B.appendChild(fRange('speed', function () { return num(m.speed, 1); }, function (v) { setMeta({ speed: v }); }, 0, 1.5, 0.01));
      B.appendChild(fChk('passable', function () { return m.passable !== false; }, function (v) { setMeta({ passable: v }); }));
      B.appendChild(fRange('cover', function () { return num(m.cover, 0); }, function (v) { setMeta({ cover: v }); }, 0, 0.8, 0.01));
      B.appendChild(fRange('stealth', function () { return num(m.stealth, 0); }, function (v) { setMeta({ stealth: v }); }, 0, 0.8, 0.01));
      B.appendChild(fRange('carve depth', function () { return num(m.carve, 0); }, function (v) { setMeta({ carve: v || null }); }, 0, 1.2, 0.05));
      B.appendChild(h('div', { class: 'fg-note', html:
        'Carve digs the ground down as it paints — that is how <b>trench</b> works.<br><br>' +
        'Publish, then paint it from <b>Edit → Paint</b>. Saved maps record the surface <i>names</i> alongside the ' +
        'index array, so reordering your surfaces later cannot corrupt an old map.' }));
      var sw = h('div', { style: 'height:26px;border-radius:5px;margin:5px 0;border:1px solid var(--border);background:' + m.c });
      B.appendChild(sw);
    }
  }
  function makeP(k, v) { var o = {}; o[k] = v; return o; }

  // ---- rosters: what both sides deploy from (FORGE_PLAN §8.5) -------------

  function renderRoster(B, m) {
    B.appendChild(h('div', { class: 'fg-note', html:
      'An army list. <b>Both sides deploy from a roster against a points budget</b> — that is the mechanism that makes ' +
      '"everyone can field custom units" playable rather than chaotic. Minimums are bought first, then the rest is ' +
      'spent by weight until nothing affordable is left.' }));
    B.appendChild(fText('faction', function () { return m.faction || 'custom'; }, function (v) { setMeta({ faction: v }); }));
    B.appendChild(fNum('points budget', function () { return num(m.budget, 1200); }, function (v) { setMeta({ budget: v }); }, 50));

    B.appendChild(h('div', { class: 'fg-h' }, [
      h('span', { text: 'entries' }),
      h('span', { style: 'color:var(--text-dim);font-weight:400', text: (m.entries || []).length + '' }),
    ]));
    var add = h('select', { style: 'width:100%;font-size:9.5px;margin:2px 0', onkeydown: function (e) { e.stopPropagation(); } });
    add.appendChild(h('option', { value: '', text: '+ add a unit type…' }));
    try {
      Object.keys(G.UNIT_DEFS).sort(function (a, b) {
        var A = G.UNIT_DEFS[a], Bb = G.UNIT_DEFS[b];
        if (!!A.custom !== !!Bb.custom) return A.custom ? -1 : 1;   // yours first
        return A.name.localeCompare(Bb.name);
      }).forEach(function (k) {
        var d = G.UNIT_DEFS[k];
        add.appendChild(h('option', { value: k, text: (d.custom ? '★ ' : '') + d.name + '  (' + G.unitCost(k) + ' pts)' }));
      });
    } catch (e) {}
    add.addEventListener('change', function () {
      if (!add.value) return;
      addRosterEntry(add.value);
      add.value = '';
    });
    B.appendChild(add);

    var spentMin = 0, spentMax = 0;
    (m.entries || []).forEach(function (e, i) {
      var d = G.UNIT_DEFS[e.u];
      var cost = d ? G.unitCost(e.u) : 0;
      spentMin += cost * num(e.min, 0);
      spentMax += cost * num(e.max, 1);
      var box = h('div', { style: 'border:1px solid var(--border);border-radius:5px;padding:3px;margin:3px 0' });
      box.appendChild(h('div', 'fg-row', [
        h('label', { style: 'flex:1;color:' + (d && d.custom ? 'var(--accent)' : 'var(--t1)'),
          text: (d ? d.name : e.u) + (d && d.custom ? ' ★' : '') }),
        h('span', { class: 't', style: 'color:var(--text-dim)', text: cost + ' pts' }),
        h('span', { class: 'x', text: '✕', onclick: function () { delRosterEntry(i); } }),
      ]));
      if (!d) box.appendChild(h('div', { class: 'fg-note fg-bad', text: 'This unit type is not loaded — publish it first or the roster will skip it.' }));
      box.appendChild(fNum('min', function () { return num(e.min, 0); }, function (v) { setRosterEntry(i, { min: Math.max(0, Math.round(v)) }); }, 1));
      box.appendChild(fNum('max', function () { return num(e.max, 1); }, function (v) { setRosterEntry(i, { max: Math.max(1, Math.round(v)) }); }, 1));
      box.appendChild(fNum('weight', function () { return num(e.weight, 1); }, function (v) { setRosterEntry(i, { weight: v }); }, 0.5));
      B.appendChild(box);
    });
    B.appendChild(h('div', { class: 'fg-note', html:
      'Minimums cost <b>' + spentMin + '</b> pts of <b>' + num(m.budget, 1200) + '</b>' +
      (spentMin > num(m.budget, 1200) ? ' — <span class="fg-bad">over budget, the list cannot be filled</span>' : '') +
      '.<br>At maximum this list would field <b>' + spentMax + '</b> pts.' }));

    B.appendChild(h('div', { class: 'fg-h', text: 'reinforcement pool' }));
    B.appendChild(h('div', { class: 'fg-note', text: 'What the in-battle reinforcement panel offers, instead of the fixed four-button list.' }));
    var rf = h('div', 'fg-grid');
    (m.entries || []).forEach(function (e) {
      var on = (m.reinforce || []).indexOf(e.u) >= 0;
      var d = G.UNIT_DEFS[e.u];
      rf.appendChild(btn(d ? d.name : e.u, function () { toggleReinforce(e.u); }, on ? 'on' : null));
    });
    B.appendChild(rf);

    B.appendChild(h('div', { class: 'fg-h', text: 'deploy' }));
    var dg = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap' });
    dg.appendChild(btn('Deploy for me', function () { deployRoster(1); }, 'hot'));
    dg.appendChild(btn('Deploy for the enemy', function () { deployRoster(2); }));
    dg.appendChild(btn('Use for reinforcements', function () {
      publish(S.id);
      G.game.playerRoster = m.id;
      toast('The reinforcement panel now draws from "' + m.name + '"');
    }));
    B.appendChild(dg);

    B.appendChild(h('div', { class: 'fg-h', text: 'AI eligibility' }));
    B.appendChild(h('div', { class: 'fg-note', text:
      'Whether the AI may field YOUR units. Balance-checked is the default: only units whose computed cost sits inside the band the stock units already span, so a 40-hp joke or a 9,000-damage monster cannot turn up on the other side by surprise.' }));
    var pol = h('div', 'fg-grid');
    [['none', 'never'], ['mine', 'only marked'], ['checked', 'balance-checked'], ['all', 'anything']].forEach(function (p) {
      pol.appendChild(btn(p[1], function () {
        G.game.aiCustomPolicy = p[0];
        toast('AI may field custom units: ' + p[1]);
        renderRight();
      }, G.game.aiCustomPolicy === p[0] ? 'on' : null));
    });
    B.appendChild(pol);
  }

  function addRosterEntry(type) {
    if (!S.meta || S.kind !== 'roster') return false;
    return edit('roster entry', function () {
      S.meta.entries = S.meta.entries || [];
      if (S.meta.entries.some(function (e) { return e.u === type; })) return false;
      S.meta.entries.push({ u: type, min: 0, max: 4, weight: 1 });
    });
  }
  function setRosterEntry(i, patch) {
    var e = S.meta && S.meta.entries && S.meta.entries[i];
    if (!e) return false;
    return edit('roster entry', function () { for (var k in patch) e[k] = patch[k]; });
  }
  function delRosterEntry(i) {
    if (!S.meta || !S.meta.entries || !S.meta.entries[i]) return false;
    return edit('roster entry', function () {
      var u = S.meta.entries[i].u;
      S.meta.entries.splice(i, 1);
      S.meta.reinforce = (S.meta.reinforce || []).filter(function (t) { return t !== u; });
    });
  }
  function toggleReinforce(type) {
    if (!S.meta) return false;
    return edit('reinforcement pool', function () {
      S.meta.reinforce = S.meta.reinforce || [];
      var at = S.meta.reinforce.indexOf(type);
      if (at >= 0) S.meta.reinforce.splice(at, 1); else S.meta.reinforce.push(type);
    });
  }

  /** Put the whole list on the field, spending its budget. */
  function deployRoster(team, opts) {
    if (!S.meta || S.kind !== 'roster') return null;
    publish(S.id);
    var g = G.game;
    var c = g.cameraRig.target;
    var gx = G.worldToCell(c.x) + (team === 2 ? 14 : -14);
    var gz = G.worldToCell(c.z);
    exit();
    g.setMode('edit');
    var r = g.deployRoster(S.meta, team, gx, gz, opts || {});
    g.ui.toast('Deployed ' + r.placed.length + ' units for ' + ((G.TEAM_NAME && G.TEAM_NAME[team]) || ('Team ' + team)) + ' — ' +
      r.spent + '/' + r.budget + ' pts');
    return r;
  }

  // ---- custom factions ----------------------------------------------------

  function renderFaction(B, m) {
    B.appendChild(h('div', { class: 'fg-note', text:
      'Your own faction, so your units are not forced into the Allied or Axis armies. Units carrying this faction id inherit its colour on the minimap and its doctrine bias when the AI deploys them.' }));
    B.appendChild(fText('faction id', function () { return m.id; }, function (v) { setMeta({ id: slug(v) }); }));
    B.appendChild(fColor('colour', function () { return m.c; }, function (v) { setMeta({ c: v }); }));
    B.appendChild(fSel('doctrine', TCM.ROLES ? Object.keys(TCM.ROLES) : ROLES,
      function () { return m.doctrine || 'lineInfantry'; }, function (v) { setMeta({ doctrine: v }); }));
    B.appendChild(h('div', { class: 'fg-h', text: 'deployment bias' }));
    ['armour', 'infantry', 'artillery'].forEach(function (k) {
      B.appendChild(fRange(k, function () { return num((m.bias || {})[k], 1); }, function (v) {
        var b = Object.assign({}, m.bias || {}); b[k] = v; setMeta({ bias: b });
      }, 0, 3, 0.1));
    });
    var mine = [];
    try {
      list('unit').forEach(function (a) {
        var u = S.lib.assets[a.id].unit;
        if (u && u.faction === m.id) mine.push(u.name);
      });
    } catch (e) {}
    B.appendChild(h('div', { class: 'fg-h', text: 'units in this faction' }));
    B.appendChild(h('div', { class: 'fg-note', text: mine.length ? mine.join(', ')
      : 'None yet — set a unit\'s faction to "' + m.id + '" on its Stats tab.' }));
  }

  // ---- feature stamps -----------------------------------------------------
  //
  // The user's "model custom terrain" beyond surface types: a saved brush that
  // paints height + surface + props together. The player makes one by selecting
  // a patch of a map they already built.

  function captureStamp(gx0, gz0, gx1, gz1, name) {
    var g = G.game;
    var st = g.editor.captureStamp(gx0, gz0, gx1, gz1, name || 'Stamp');
    if (!st) { toast('Pick a patch between 1×1 and 64×64 cells', true); return null; }
    var id = freeId(name || 'stamp');
    st.id = id;
    S.lib.assets[id] = { kind: 'stamp', id: id, name: name || 'Stamp', stamp: st };
    saveLib(); renderAll();
    toast('Captured "' + st.name + '" — ' + st.w + '×' + st.h + ' cells, ' + st.props.length + ' props');
    return id;
  }

  function applyStamp(id, gx, gz, opts) {
    var a = S.lib.assets[id];
    if (!a || !a.stamp) { toast('No stamp "' + id + '"', true); return false; }
    return G.game.editor.applyStamp(a.stamp, gx, gz, opts);
  }

  function renderTest() {
    var B = el.rightBody;
    el.rightHead.appendChild(h('span', { text: 'Test' }));
    var r = report(), c = contract();
    B.appendChild(h('div', { class: 'fg-h', text: 'validation' }));
    if (r.ok && !r.warnings.length) B.appendChild(h('div', { class: 'fg-note fg-ok', text: '✓ clean — ' + r.budget.parts + ' parts, ' + r.budget.meshes + ' meshes, ' + r.budget.mats + ' materials.' }));
    r.errors.forEach(function (e) { B.appendChild(h('div', { class: 'fg-note fg-bad', text: '✕ ' + e })); });
    r.warnings.forEach(function (w) { B.appendChild(h('div', { class: 'fg-note', text: '! ' + w })); });

    B.appendChild(h('div', { class: 'fg-h', text: 'engine hooks' }));
    B.appendChild(h('div', { class: 'fg-note', html:
      'model <b class="' + (c.model ? 'fg-ok' : 'fg-bad') + '">' + (c.model ? 'builds' : 'PLACEHOLDER') + '</b> · ' +
      'muzzle ' + tick(c.muzzle) + ' · barrel tip ' + tick(c.barrelTip) + ' · turret ' + tick(c.turret) +
      ' · jets ' + (c.jets ? '×' + c.jets : '—') + ' · animator <b>' + c.animator + '</b>' }));

    B.appendChild(h('div', { class: 'fg-h', text: 'in the battle' }));
    var g = h('div', { style: 'display:flex;gap:3px;flex-wrap:wrap' });
    g.appendChild(btn('Pose gauntlet', function () { gauntlet(); }, null, 'Cycle every stock pose and watch for parts flying off'));
    g.appendChild(btn('Spawn (team 1)', function () { spawnIntoBattle(1); }, 'hot'));
    g.appendChild(btn('Spawn (team 2)', function () { spawnIntoBattle(2); }));
    g.appendChild(btn('Take control', function () { takeControl(); }));
    B.appendChild(g);
    B.appendChild(h('div', { class: 'fg-note', text: 'Spawning publishes first, then drops the thing at the middle of the last camera view.' }));

    B.appendChild(h('div', { class: 'fg-h', text: 'document' }));
    var ta = h('textarea', { style: 'width:100%;height:120px;background:#0e131a;border:1px solid var(--border);' +
      'border-radius:4px;color:#9fb4c8;font-family:"SF Mono",Menlo,monospace;font-size:9px;padding:4px',
      onkeydown: function (e) { e.stopPropagation(); } });
    ta.value = JSON.stringify(S.kind === 'terrain' ? S.meta : { model: S.doc, meta: S.meta }, null, 1);
    B.appendChild(ta);
    var g2 = h('div', { style: 'display:flex;gap:3px;margin-top:4px;flex-wrap:wrap' });
    g2.appendChild(btn('Apply edits', function () {
      try {
        var d = JSON.parse(ta.value);
        edit('json edit', function () {
          if (S.kind === 'terrain') S.meta = d;
          else { if (d.model) S.doc = d.model; if (d.meta) S.meta = d.meta; }
        });
        toast('Document replaced');
      } catch (e) { toast('Invalid JSON: ' + e.message, true); }
    }, null, 'Hand-edit the document — the schema is the API'));
    g2.appendChild(btn('Export this', function () { exportOne(S.id); }));
    g2.appendChild(btn('Copy', function () { ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) {} }));
    B.appendChild(g2);
  }
  function tick(v) { return v ? '<b class="fg-ok">✓</b>' : '<span class="fg-no">—</span>'; }

  function renderLibInspector() {
    var B = el.rightBody;
    el.rightHead.appendChild(h('span', { text: 'Start from' }));
    B.appendChild(h('div', { class: 'fg-note', html:
      'There is no mesh import and there never will be — everything you field, you build here. ' +
      'So start from something that already works and change it.' }));
    B.appendChild(h('div', { class: 'fg-h', text: 'fork a template' }));
    list().filter(function (a) { return a.tmpl; }).forEach(function (a) {
      B.appendChild(btn('⑂ ' + a.name, function () { fork(a.id); }, 'hot'));
    });
    B.appendChild(h('div', { class: 'fg-h', text: 'start from a skeleton' }));
    var sg = h('div', 'fg-grid');
    TCM.SKELETONS.forEach(function (sk) {
      sg.appendChild(btn(sk, function () { newAsset(sk === 'static' ? 'prop' : 'unit', 'skeleton:' + sk, 'New ' + sk); },
        null, sk === 'humanoid' ? 'Biped. Inherits the whole infantry pose library.'
          : sk === 'suit' ? 'Digitigrade walker. Reverse knees, jets, independent weapon arms.'
          : sk === 'hull' ? 'Vehicle. Turret yaw-tracks the target, gun elevates.'
          : 'No animation: props, weapons, terrain features.'));
    });
    B.appendChild(sg);
    B.appendChild(h('div', { class: 'fg-h', text: 'army lists' }));
    B.appendChild(h('div', { class: 'fg-note', html:
      'A <b>roster</b> is what puts your units in a battle on both sides: entries with minimums, maximums and weights, ' +
      'spent against a points budget. A <b>faction</b> gives them a home of their own.' }));
    B.appendChild(btn('＋ New army list', function () { newAsset('roster', null, 'New army list'); }));
    B.appendChild(h('div', { class: 'fg-h', text: 'storage' }));
    var u = usage();
    B.appendChild(h('div', { class: 'fg-note', text: u.assets + ' assets, ' + u.kb + ' KB of the ~5 MB localStorage budget.' }));
    B.appendChild(btn('Export everything', function () { exportFile(); }));
    B.appendChild(btn('Import a pack…', function () { el.file.click(); }));
    B.appendChild(h('div', { class: 'fg-note', text: 'You can also drop a .tcpack.json anywhere on this window.' }));
  }

  // ---- foot: pose scrubber, view options ---------------------------------

  function renderFoot() {
    clear(el.foot);
    var left = h('div', 'fg-foot-col');
    if (S.kind !== 'terrain' && S.kind !== 'roster' && S.kind !== 'faction') {
      var poses = h('div', 'fg-poses');
      POSES.forEach(function (p) {
        poses.appendChild(btn(p, function () { setPose(p); }, S.pose === p ? 'on' : null));
      });
      left.appendChild(poses);
      var ctl = h('div', { style: 'display:flex;gap:4px;align-items:center' });
      ctl.appendChild(btn(S.playing ? '⏸ pause' : '▶ play', function () { S.playing = !S.playing; renderFoot(); }));
      var scrub = h('input', { type: 'range', min: 0, max: 6.283, step: 0.01, value: S.gait,
        style: 'width:150px;accent-color:var(--accent)',
        oninput: function () { S.gait = parseFloat(scrub.value); S.playing = false; } });
      ctl.appendChild(h('span', { style: 'color:var(--text-dim);font-size:9.5px', text: 'gait' }));
      ctl.appendChild(scrub);
      ctl.appendChild(btn(S.dummy ? 'target: on' : 'target: off', function () { S.dummy = !S.dummy; renderFoot(); },
        S.dummy ? 'on' : null, 'Put a dummy in front so weapon elevation and turret tracking are visible'));
      ctl.appendChild(btn('team ' + S.team, function () { S.team = S.team === 1 ? 2 : 1; rebuild(); renderFoot(); },
        null, 'Team-flagged materials take this team\'s colour'));
      left.appendChild(ctl);
    }
    el.foot.appendChild(left);

    var mid = h('div', 'fg-foot-col');
    var v1 = h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
    v1.appendChild(btn('grid', function () { S.showGrid = !S.showGrid; view.grid.visible = view.axes.visible = view.disc.visible = S.showGrid; renderFoot(); }, S.showGrid ? 'on' : null));
    v1.appendChild(btn('bones', function () { S.showBones = !S.showBones; rebuildOverlayVisibility(); renderFoot(); }, S.showBones ? 'on' : null));
    v1.appendChild(btn('ghost', function () { setGhost(); renderFoot(); }, S.showGhost ? 'on' : null, 'A stock unit at 1.1 u to the side, for scale'));
    v1.appendChild(btn('spin', function () { S.spin = !S.spin; if (!S.spin) { S.turntable = 0; view.root.rotation.y = 0; } renderFoot(); }, S.spin ? 'on' : null));
    v1.appendChild(btn('frame', function () { frame(false); }));
    mid.appendChild(v1);
    var v2 = h('div', { style: 'display:flex;gap:4px;align-items:center' });
    v2.appendChild(h('span', { style: 'color:var(--text-dim);font-size:9.5px', text: 'snap' }));
    [0, 0.005, 0.01, 0.05, 0.1].forEach(function (s) {
      v2.appendChild(btn(s === 0 ? 'off' : String(s), function () { S.snap = s; renderFoot(); }, S.snap === s ? 'on' : null));
    });
    v2.appendChild(h('span', { style: 'color:var(--text-dim);font-size:9.5px;margin-left:5px', text: 'angle' }));
    [0, 5, 15, 45].forEach(function (s) {
      v2.appendChild(btn(s === 0 ? 'off' : s + '°', function () { S.angSnap = s; renderFoot(); }, S.angSnap === s ? 'on' : null));
    });
    mid.appendChild(v2);
    el.foot.appendChild(mid);

    el.foot.appendChild(h('div', { id: 'fgHint', html: hintFor(S.tab) }));
  }

  function hintFor(tab) {
    if (tab === 'sculpt') return 'Click a vertex or face to select it (<b>shift</b> adds), then drag it — the falloff makes it move a region. <b>Tier 1</b> keeps the shape parametric; convert to a mesh only when you need to change the topology.';
    if (tab === 'build') return 'Drag the coloured arrows to move the selection. <b>LMB</b> orbit · <b>RMB</b>/<b>MMB</b> pan · wheel zoom · <b>click</b> a part to select.';
    if (tab === 'paint') return 'Pick a palette entry, then <b>Assign to selection</b> or a fill. <b>Alt+click</b> a part in the viewport to eyedrop its material.';
    if (tab === 'rig') return 'Bones are drawn as diamonds; click one to select it, then add parts and they land on it. The <b>earned behaviours</b> list is what the engine will actually do for this rig.';
    if (tab === 'stats') return 'These are the numbers the simulation reads. Points cost is what both sides spend when deploying.';
    if (tab === 'test') return 'The pose gauntlet is the fast way to catch a mis-parented part. Spawning publishes first.';
    return 'Fork a template to get going — everything in the box is editable, including the stock content.';
  }

  function setPose(p) {
    if (POSES.indexOf(p) < 0) return false;
    S.pose = p;
    S.playing = true;
    renderFoot();
    if (S.tab === 'rig') renderRight();
    return p;
  }

  // =======================================================================
  // POINTER
  // =======================================================================
  //
  // Attached in the CAPTURE phase on the canvas and on window, and every event
  // is swallowed while forge mode is up. The game's Input is bound to the same
  // canvas in the bubble phase, so this is what keeps an orbit drag in the
  // forge from also panning the battlefield camera.

  var drag = null;

  function bindPointer() {
    var cv = G.game.renderer.domElement;
    var active = function () { return G.game && G.game.mode === 'forge'; };

    cv.addEventListener('mousedown', function (e) {
      if (!active()) return;
      e.stopPropagation(); e.preventDefault();
      onDown(e);
    }, true);
    window.addEventListener('mousemove', function (e) {
      if (!active()) return;
      if (drag) e.stopPropagation();
      onMove(e);
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (!active()) return;
      if (drag) e.stopPropagation();
      // A sculpt drag writes ONE history entry on release, not one per frame —
      // otherwise a single stroke buries the undo stack.
      if (drag && drag.kind === 'sculpt' && drag.moved && drag.pending) commitVerts(drag.pending, 'sculpt drag');
      drag = null;
    }, true);
    cv.addEventListener('wheel', function (e) {
      if (!active()) return;
      e.stopPropagation(); e.preventDefault();
      view.cam.dist = Math.max(0.15, Math.min(60, view.cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      layoutCamera();
    }, { capture: true, passive: false });
    cv.addEventListener('contextmenu', function (e) { if (active()) { e.stopPropagation(); e.preventDefault(); } }, true);
    cv.addEventListener('dblclick', function (e) {
      if (!active()) return;
      e.stopPropagation();
      frame(!!S.sel.length);
    }, true);
  }

  function ndc(e) {
    return new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1);
  }

  function onDown(e) {
    var p = ndc(e);
    view.ray.setFromCamera(p, view.camera);
    // 0. sculpt mode owns the left button: it picks vertices and faces on the
    // part being sculpted, and a drag on a selected one moves it.
    if (SC.on && SC.mesh && e.button === 0) {
      var hit = sculptPick(p);
      if (hit != null) {
        if (SC.sel.indexOf(hit) < 0) sculptSelect(hit, e.shiftKey);
        var host = partNode(SC.part);
        drag = { kind: 'sculpt', from: null, plane: null, host: host, moved: false, base: SC.mesh.v.slice() };
        var anchor = new THREE.Vector3();
        var m = SC.mesh, s = m.scale;
        var vi = SC.mode === 'face' ? m.f[hit * 3] : hit;
        anchor.set(m.v[vi * 3] * s[0], m.v[vi * 3 + 1] * s[1], m.v[vi * 3 + 2] * s[2]);
        if (host) { host.updateWorldMatrix(true, false); anchor.applyMatrix4(host.matrixWorld); }
        drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          view.camera.getWorldDirection(new THREE.Vector3()).negate(), anchor);
        drag.from = anchor.clone();
        return;
      }
      if (!e.shiftKey) sculptSelect([]);
      drag = { kind: 'orbit', x: e.clientX, y: e.clientY };
      return;
    }
    // 1. a gizmo handle wins over everything
    if (S.sel.length && view.gizmo.visible) {
      var gh = view.ray.intersectObjects(view.gizmo.children, false);
      if (gh.length) {
        var axis = gh[0].object.userData.gizmo;
        var pt = part(S.sel[0]);
        drag = { kind: 'gizmo', axis: axis, from: gh[0].point.clone(),
          start: (pt && pt.p ? pt.p.slice() : [0, 0, 0]), id: S.sel[0],
          dir: gizmoWorldAxis(axis), plane: null };
        drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          view.camera.getWorldDirection(new THREE.Vector3()).negate(), drag.from);
        return;
      }
    }
    // 2. a bone marker
    if (S.showBones && view.bones.children.length) {
      var bh = view.ray.intersectObjects(view.bones.children, false);
      if (bh.length) {
        S.selBone = bh[0].object.userData.joint;
        renderLeft(); renderRight(); renderBones();
        return;
      }
    }
    // 3. a part
    if (e.button === 0) {
      var ph = view.ray.intersectObject(view.root, true);
      var hitPart = null;
      for (var i = 0; i < ph.length; i++) {
        var o = ph[i].object, guard = 0;
        while (o && guard++ < 24) { if (o.userData && o.userData.tcmPart) { hitPart = o.userData.tcmPart; break; } o = o.parent; }
        if (hitPart) break;
      }
      if (hitPart) {
        if (e.altKey) {                       // eyedropper
          var hp = part(hitPart);
          if (hp && hp.m) { S.selMat = hp.m; toast('Picked material "' + hp.m + '"'); renderLeft(); renderRight(); }
          return;
        }
        select(hitPart, e.shiftKey);
        var pp = part(hitPart);
        if (pp) { S.selBone = pp.j || 'body'; renderBones(); }
        drag = { kind: 'none' };
        return;
      }
      if (!e.shiftKey) select([]);
    }
    // 4. empty space: orbit (LMB) or pan (RMB/MMB/shift)
    drag = { kind: (e.button === 0 && !e.shiftKey) ? 'orbit' : 'pan', x: e.clientX, y: e.clientY };
  }

  function gizmoWorldAxis(axis) {
    var v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    return v.applyQuaternion(view.gizmo.getWorldQuaternion(new THREE.Quaternion())).normalize();
  }

  function onMove(e) {
    if (!drag) return;
    if (drag.kind === 'orbit') {
      view.cam.yaw -= (e.clientX - drag.x) * 0.008;
      view.cam.pitch = Math.max(-1.45, Math.min(1.45, view.cam.pitch + (e.clientY - drag.y) * 0.006));
      drag.x = e.clientX; drag.y = e.clientY;
      layoutCamera();
    } else if (drag.kind === 'pan') {
      var k = view.cam.dist * 0.0016;
      var right = new THREE.Vector3().setFromMatrixColumn(view.camera.matrix, 0);
      var up = new THREE.Vector3().setFromMatrixColumn(view.camera.matrix, 1);
      view.cam.target.addScaledVector(right, -(e.clientX - drag.x) * k);
      view.cam.target.addScaledVector(up, (e.clientY - drag.y) * k);
      drag.x = e.clientX; drag.y = e.clientY;
      layoutCamera();
    } else if (drag.kind === 'sculpt') {
      view.ray.setFromCamera(ndc(e), view.camera);
      var hit = new THREE.Vector3();
      if (!view.ray.ray.intersectPlane(drag.plane, hit)) return;
      var d = hit.sub(drag.from);
      // Screen-space drag → the part's LOCAL space, so the handle tracks the
      // cursor whatever the skeleton has done to the joint underneath it.
      if (drag.host) {
        var inv = new THREE.Matrix4().copy(drag.host.matrixWorld).invert();
        var o = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
        d = d.applyMatrix4(new THREE.Matrix4().extractRotation(inv)).multiplyScalar(1);
        void o;
      }
      // Apply from the pre-drag positions each frame, so the move is absolute
      // rather than accumulating rounding as the mouse travels.
      var m = SC.mesh, w = brushWeights(SC.sel), v = drag.base.slice(), s = m.scale;
      for (var i in w) {
        var k = i * 3, f = w[i];
        v[k] += d.x / (s[0] || 1) * f;
        v[k + 1] += d.y / (s[1] || 1) * f;
        v[k + 2] += d.z / (s[2] || 1) * f;
      }
      SC.mesh = { v: v, f: m.f, sym: m.sym, tier: m.tier, scale: m.scale };
      drag.pending = v;
      drag.moved = true;
      buildSculptOverlayFast();
    } else if (drag.kind === 'gizmo') {
      view.ray.setFromCamera(ndc(e), view.camera);
      var hit = new THREE.Vector3();
      if (!view.ray.ray.intersectPlane(drag.plane, hit)) return;
      var delta = hit.sub(drag.from);
      // Project the free-space drag onto the axis being dragged, then convert
      // from world units into the part's parent space so the number in the
      // inspector means what it says.
      var along = delta.dot(drag.dir);
      var scale = 1 / Math.max(1e-6, worldScaleOf(drag.id));
      var d = [0, 0, 0];
      d[drag.axis === 'x' ? 0 : drag.axis === 'y' ? 1 : 2] = along * scale;
      var np = [drag.start[0] + d[0], drag.start[1] + d[1], drag.start[2] + d[2]];
      // A mirrored part's local +x is its own side; dragging follows the handle.
      move(drag.id, np, true);
      syncBinds();
    }
  }

  /** How many world units one unit of the part's local space is worth — the
   *  model scale times whatever the skeleton did to the joint. */
  function worldScaleOf(id) {
    var target = null;
    view.root.traverse(function (o) {
      if (!target && o.userData && o.userData.tcmPart === id) target = o;
    });
    if (!target || !target.parent) return num(S.doc && S.doc.scale, 1);
    var s = target.parent.getWorldScale(new THREE.Vector3());
    return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
  }

  // =======================================================================
  // KEYS
  // =======================================================================

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (!G.game || G.game.mode !== 'forge') return;
      if (isTyping()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
      var handled = true;
      var step = S.snap || 0.01;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') redo();
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { saveLib(); toast('Library saved'); }
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') dupPart();
      else if (e.code === 'Escape') G.game.setMode('edit');
      else if (e.code === 'KeyD') dupPart();
      else if (e.code === 'KeyM') mirror();
      else if (e.code === 'Delete' || e.code === 'Backspace') delPart();
      else if (e.code === 'KeyF') frame(!!S.sel.length);
      else if (e.code === 'Space') { S.playing = !S.playing; renderFoot(); }
      else if (e.code === 'BracketLeft') { S.snap = S.snap <= 0.005 ? 0 : S.snap === 0.01 ? 0.005 : S.snap === 0.05 ? 0.01 : 0.05; renderFoot(); }
      else if (e.code === 'BracketRight') { S.snap = S.snap === 0 ? 0.005 : S.snap === 0.005 ? 0.01 : S.snap === 0.01 ? 0.05 : 0.1; renderFoot(); }
      else if (e.code === 'Digit1') { view.cam.yaw = 0; view.cam.pitch = 0; layoutCamera(); }
      else if (e.code === 'Digit2') { view.cam.yaw = Math.PI / 2; view.cam.pitch = 0; layoutCamera(); }
      else if (e.code === 'Digit3') { view.cam.yaw = Math.PI; view.cam.pitch = 0; layoutCamera(); }
      else if (e.code === 'Digit4') { view.cam.yaw = 0.7; view.cam.pitch = 1.2; layoutCamera(); }
      else if (e.code === 'Tab') { setTab(nextTab()); }
      else if (e.code === 'ArrowLeft') move(null, [-step, 0, 0]);
      else if (e.code === 'ArrowRight') move(null, [step, 0, 0]);
      else if (e.code === 'ArrowUp') move(null, e.shiftKey ? [0, 0, -step] : [0, step, 0]);
      else if (e.code === 'ArrowDown') move(null, e.shiftKey ? [0, 0, step] : [0, -step, 0]);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function nextTab() {
    var order = ['build', 'sculpt', 'paint', 'rig', 'guns', 'stats', 'test', 'library'];
    var vis = order.filter(function (t) {
      return !(((S.kind === 'terrain' || S.kind === 'roster' || S.kind === 'faction') && t !== 'stats' && t !== 'library')
        || (S.kind === 'prop' && t === 'rig')
        || (S.kind === 'part' && (t === 'rig' || t === 'stats'))
        || (t === 'sculpt' && !S.doc)
        || (t === 'guns' && S.kind !== 'unit'));
    });
    return vis[(vis.indexOf(S.tab) + 1) % vis.length];
  }

  // =======================================================================
  // MODE
  // =======================================================================

  function enter() {
    document.body.classList.add('forge');
    if (!S.id) {
      var first = list('unit')[0] || list()[0];
      if (first) open(first.id);
    }
    rebuild();
    if (!S.hist.length) pushHist('open');
    frame(false);
    renderAll();
    return true;
  }

  function exit() {
    document.body.classList.remove('forge');
    stash();
    return true;
  }

  // =======================================================================
  // PUBLIC API — the UI is a shell over exactly this
  // =======================================================================

  window.Forge = {
    VERSION: VERSION,
    install: install, bootRegister: bootRegister,
    enter: enter, exit: exit, update: update, render: render,

    // library / assets
    list: list, newAsset: newAsset, fork: fork, open: open, rename: rename, del: del,
    save: saveLib, usage: usage, publish: publish, unpublish: unpublish,
    exportPack: exportPack, exportFile: exportFile, exportOne: exportOne, importPack: importPack,
    saveToLibrary: saveToLibrary, insertRef: insertRef,

    // parts
    addPart: addPart, dupPart: dupPart, delPart: delPart, setPart: setPart,
    move: move, rotate: rotate, scalePart: scalePart, mirror: mirror,
    setMat: setMat, fillMat: fillMat, setMod: setMod, setTag: setTag, select: select,

    // palette
    addMat: addMat, setMatDef: setMatDef, delMat: delMat, setWeather: setWeather,

    // sculpt (Phase 4). Every one is callable, because a sculpt cannot be
    // driven reliably through the browser pane's synthesised drags.
    sculptBegin: sculptBegin, sculptEnd: sculptEnd, setSculptRes: setSculptRes,
    sculptSelect: sculptSelect, sculptSelectAll: sculptSelectAll,
    sculptSelectBox: sculptSelectBox, sculptGrow: sculptGrow,
    sculptMirrorSelection: sculptMirrorSelection,
    sculptMove: sculptMove, sculptInflate: sculptInflate, sculptSmooth: sculptSmooth,
    sculptFlatten: sculptFlatten, sculptNoise: sculptNoise, sculptReset: sculptReset,
    toEditableMesh: toEditableMesh, topoOp: topoOp,
    sculptMode: function (m) { SC.mode = m; SC.sel = []; highlightSculpt(); renderRight(); return m; },
    sculptState: SC,

    // rig
    setSkeleton: setSkeleton, setProportion: setProportion, setFlag: setFlag,
    addBone: addBone, setBone: setBone, delBone: delBone, mirrorBone: mirrorBone,
    addDriver: addDriver, setDriver: setDriver, delDriver: delDriver,
    setPoseChannel: setPoseChannel,

    // clips (Phase 5, Tier 3)
    addClip: addClip, delClip: delClip, setClip: setClip,
    addTrack: addTrack, delTrack: delTrack, setKey: setKey, setEvent: setEvent,
    borrowClip: borrowClip, clips: clips, tagMap: tagMap,

    // weapons + abilities (Phase 6)
    addWeapon: addWeapon, delWeapon: delWeapon, setWeapon: setWeapon,
    addMode: addMode, setMode: setMode, delMode: delMode, borrowWeapon: borrowWeapon,
    addAbility: addAbility, setAbility: setAbility, delAbility: delAbility,
    weapons: weaponList, abilities: abilityList,

    // rosters, factions, stamps (Phase 7b)
    addRosterEntry: addRosterEntry, setRosterEntry: setRosterEntry,
    delRosterEntry: delRosterEntry, toggleReinforce: toggleReinforce,
    deployRoster: deployRoster,
    captureStamp: captureStamp, applyStamp: applyStamp,

    // meta + analysis
    setMeta: setMeta, report: report, contract: contract, lint: lint, cost: cost,
    costOf: costOf,

    // view / test
    setTab: setTab, setPose: setPose, frame: frame, setGhost: setGhost,
    gauntlet: gauntlet, spawnIntoBattle: spawnIntoBattle, takeControl: takeControl,
    undo: undo, redo: redo,

    // introspection, for tests
    state: S, doc: function () { return S.doc; }, meta: function () { return S.meta; },
    _view: function () { return view; }, _built: function () { return built; },
    _fake: function () { return fake; },
    POSES: POSES, ROLES: ROLES, UNIT_FLAGS: UNIT_FLAGS,
  };
})();
