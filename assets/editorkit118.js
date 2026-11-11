/* ===========================================================================
 * assets/editorkit118.js — round 118: what you place in the editor is what you
 * get in the battle. Two switches, both on the game object.
 *
 * The owner: "I can't figure out how to add [trenches] in the editor ... we
 * need really good cover and cover editability things like trenches".
 * The trench kit (assets/trenchkit118.js) drew trenches only in Play: Edit
 * takes the props' batch apart and showed the OLD trench pieces, so a trench
 * laid in the Cover tab looked one way while editing and another in battle.
 *
 * 1. `game.editorKit118` — THE KIT IN THE EDITOR. In Edit mode the kit is laid
 *    by the battle's own build (`TrenchKit118.build(obs, { editor: true })`),
 *    one group per map sector (4 x 4, 336 m). After an edit only the sectors
 *    whose runs changed (a signature a sector: the runs' cells, ends,
 *    revetment, front, gaps, a lone cell's turn) or whose ground moved under a
 *    trench (sculpt, paint, a crater) are laid again: during a drag at most
 *    four times a second (MINGAP), at the end of a stroke, undo, redo, a
 *    clear and a load at once. The old pieces are taken out of the scene
 *    graph while the kit stands for them (the editor finds props by CELL, not
 *    by mesh: select, delete, turn, sculpt all work on cells) and are put back
 *    on the way out of Edit, before the battle's own bake lays its kit.
 *    Show cover / Hiding: the overlay's own material is drawn on the kit's
 *    berms too (children of the overlay mesh: shown exactly when it is).
 * 2. `game.craterTool118` — A CRATER TOOL, in the Cover tab's Dig in: the
 *    crater the shells dig (`explode` at true scale): `craterOf` for the
 *    charge, `Terrain.craterTrue` (the hole the simulation has), the burst's
 *    scorch (`_scorchRound`) and the drawn lip (`_craterLip`'s geometry and
 *    material, in a pool of this file's own so an undo takes it away again).
 *    A shell hole (155 mm on delay) or a bomb crater (500 lb). UNDO is the
 *    editor's own (the heights are in its snapshot). SAVED: the holes are in
 *    the terrain heights a map already saves; the map also carries
 *    `craters118` [{x, z, k}] (only when there is one) so a load draws their
 *    lips and scorch again. A shell's crater in a battle is saved only as
 *    heights (and only if the field is saved after it); its scorch and lip
 *    are runtime state and are not (`Terrain.serialize` is h and t).
 *
 * OFF = the editor exactly as before: no wrapper, group, pool or key is left.
 * ======================================================================== */
(function () {
  'use strict';
  var EK = window.EditorKit118 = {
    on: false, DEFAULT: true, craterOn: false, CRATER_DEFAULT: true,
    MINGAP: 250,   // ms between two lays during a drag: four a second
    grp: null, sect: new Map(), sigs: {}, hidden: [], dirty: new Set(), needFull: false,
    job: null, jobAt: 0, lastT: -1e9, loading: 0, tro: null, tm: null,
    stats: { lays: 0, full: 0, part: 0, sectors: 0, lastMs: 0, maxMs: 0, planMs: 0, lastSectors: 0 },
    craters: [], lip: null, err: null,
    CRATERS: {
      shell: { name: 'Shell hole', kg: function () { return typeof RTT_FILLER !== 'undefined' && RTT_FILLER.arty155 || 6.86; }, kind: 'delay',
        how: 'Click to blow a shell hole: the ground dug as a 155 mm shell on delay digs it, its lip and scorch with it.',
        gives: 'The hole the battle has: a man lying in it is below the field round it' },
      bomb: { name: 'Bomb crater', kg: function () { var F = typeof FIRE_SUPPORT !== 'undefined' && FIRE_SUPPORT.fs_airstrike; return F && F.filler || 110; }, kind: 'delay',
        how: 'Click to blow a bomb crater: the ground dug as a 500 lb bomb digs it, its lip and scorch with it.',
        gives: 'A deep hole: a man in it is under the lip' },
    },
  };
  var WK = [], WC = [];   // the wrappers of each switch
  var DEAD = new Map();   // a wrapper switched off under another one: skipped when the one outside it comes off

  /* ---------------------------------------------------------------- helpers */
  function wrap(list, obj, name, h) {
    var orig = obj && obj[name]; if (typeof orig !== 'function') return;
    var own = Object.prototype.hasOwnProperty.call(obj, name), rec = { obj: obj, name: name, orig: orig, own: own, w: null, dead: false };
    var w = function () {
      if (rec.dead) return orig.apply(this, arguments);   // unwrapped while another wrapper sat outside it: a pass-through
      var pre = null;
      try { if (h.pre) pre = h.pre.apply(this, arguments); } catch (e) { EK.err = String(e && e.stack || e); }
      if (pre === wrap.SKIP) return undefined;
      var r = orig.apply(this, arguments);
      try { if (h.post) h.post.call(this, arguments, pre, r); } catch (e) { EK.err = String(e && e.stack || e); }
      return r;
    };
    rec.w = w; obj[name] = w; list.push(rec);
  }
  wrap.SKIP = {};
  function unwrap(list) {
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i];
      if (r.obj[r.name] === r.w) {
        var rr = r;
        while (DEAD.has(rr.orig)) { var d = DEAD.get(rr.orig); DEAD.delete(rr.orig); rr = d; }
        if (rr.own) r.obj[r.name] = rr.orig; else delete r.obj[r.name];
      } else { r.dead = true; DEAD.set(r.w, r); }   // another wrapper sits outside this one: a pass-through until it comes off
    }
    list.length = 0;
  }
  function TK() { return window.TrenchKit118; }
  function G_() { return window.game; }
  function kitWanted(G) { var K = TK(); return !!(EK.on && G && G.mode === 'edit' && K && K.build && K.on(G)); }
  var isTrench = function (o) { return o && (o.type === 'trench' || o.type === 'trenchseg') && o.mesh; };
  function cosm(f) { return typeof cosmeticScope === 'function' ? cosmeticScope(f, null, []) : f(); }

  /* ---------------------------------------------------------------- the kit in the editor */
  function hideNew(obs) {
    var n = 0;
    for (var i = 0; i < obs.list.length; i++) {
      var o = obs.list[i];
      if (!isTrench(o) || !o.mesh.parent) continue;
      o.mesh.updateMatrixWorld(true);
      EK.hidden.push({ o: o, parent: o.mesh.parent });
      o.mesh.parent.remove(o.mesh); n++;
    }
    return n;
  }
  function unhideAll(obs) {
    var live = obs ? new Set(obs.list) : null;
    for (var i = 0; i < EK.hidden.length; i++) {
      var h = EK.hidden[i];
      if (live && live.has(h.o) && h.o.mesh && !h.o.mesh.parent && h.parent) h.parent.add(h.o.mesh);
    }
    EK.hidden = [];
  }
  function disposeGroup(g) {
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    g.traverse(function (n) { if (n.isMesh && n.geometry && n.name !== 'trenchKitOv118') n.geometry.dispose(); });
    if (g.userData.ov) for (var i = 0; i < g.userData.ov.length; i++) { var m = g.userData.ov[i]; if (m.parent) m.parent.remove(m); }
  }
  function groundFirst(G, want) {
    var tm = G && G.terrain && G.terrain.mesh;
    if (want && tm) { if (EK.tm !== tm) { if (EK.tm) groundFirst(G, false); EK.tm = tm; EK.tro = tm.renderOrder; } tm.renderOrder = -2; }
    else if (EK.tm) { EK.tm.renderOrder = EK.tro || 0; EK.tm = null; EK.tro = null; }
  }
  // Show cover's overlay on the kit's berms: the overlay's own material on each sector's kit geometry, as children of the
  // overlay mesh (so it draws exactly when Show cover does, and goes with it)
  function overlayMesh(G) {
    var tm = G && G.terrain && G.terrain.mesh; if (!tm) return null;
    for (var i = 0; i < tm.children.length; i++) if (tm.children[i].name === 'coverOverlay118') return tm.children[i];
    return null;
  }
  function attachOverlay(g) {
    var G = G_(), ov = overlayMesh(G); if (!ov || !g) return;
    if (g.userData.ovOn === ov) return;
    if (g.userData.ov) for (var i = 0; i < g.userData.ov.length; i++) { var m0 = g.userData.ov[i]; if (m0.parent) m0.parent.remove(m0); }
    var list = [];
    g.traverse(function (n) {
      if (!n.isMesh || (n.name !== 'trenchKit118' && n.name !== 'trenchKitFeet118')) return;
      var m = new THREE.Mesh(n.geometry, ov.material); m.name = 'trenchKitOv118'; m.renderOrder = ov.renderOrder;
      m.matrixAutoUpdate = false; m.frustumCulled = true; m.castShadow = false; m.receiveShadow = false;
      ov.add(m); list.push(m);
    });
    g.userData.ov = list; g.userData.ovOn = ov;
  }
  EK.attachOverlay = function () { EK.sect.forEach(function (g) { attachOverlay(g); }); };
  function replace(G, k, g) {
    var old = EK.sect.get(k);
    if (old) disposeGroup(old);
    EK.sect.delete(k);
    if (g && g.children.length) {
      g.visible = true; g.updateMatrix();
      EK.grp.add(g); EK.sect.set(k, g);
      cosm(function () { attachOverlay(g); });
    }
  }
  function ensureGroup(G) {
    if (EK.grp) { if (!EK.grp.parent) G.scene.add(EK.grp); return; }
    cosm(function () {
      var g = new THREE.Group(); g.name = 'trenchKitEditor118'; g.matrixAutoUpdate = false;
      var K = TK(); g.visible = !!(K.loaded && K.loaded());
      if (!g.visible && K.ready) K.ready().then(function () { if (EK.grp === g) g.visible = true; });
      G.scene.add(g); EK.grp = g;
    });
  }
  function holes() { var n = 0; EK.sect.forEach(function (g) { g.traverse(function (m) { if (m.name === 'trenchHole118') n++; }); }); return n; }
  /** Lay the kit again: every sector (`full`), or only those whose signature changed or whose ground moved. */
  function lay(full) {
    if (EK.job) { clearTimeout(EK.job); EK.job = null; }
    var G = G_();
    if (!kitWanted(G)) { if (EK.grp || EK.hidden.length) teardown(G); return null; }
    var obs = G.obstacles, K = TK(), t0 = performance.now(), tm = G.terrain && G.terrain.mesh;
    // a new terrain (another map) is another material for the berms' earth: lay every sector
    if (tm && (EK.tmat !== tm.material || EK.tgeo !== tm.geometry)) { full = true; EK.tmat = tm.material; EK.tgeo = tm.geometry; }
    if (full || EK.needFull) {
      EK.sect.forEach(function (g) { disposeGroup(g); }); EK.sect.clear(); EK.sigs = {};
      unhideAll(obs); EK.needFull = false; full = true; EK.dirty.clear();
    }
    ensureGroup(G);
    hideNew(obs);
    var sigs = {}, plan = cosm(function () { return K.build(obs, { editor: true, plan: true, sigs: sigs }); });
    var t1 = performance.now(), only = new Set(), k;
    if (plan) {
      for (k in sigs) if (full || sigs[k] !== EK.sigs[k]) only.add(+k);
      for (k in EK.sigs) if (!(k in sigs)) only.add(+k);
      EK.dirty.forEach(function (d) { if (d in sigs) only.add(d); });
    } else EK.sect.forEach(function (g, kk) { only.add(kk); });   // the kit is off for this map: clear what was laid
    EK.dirty.clear();
    var r = null;
    // the field's colours the berms take are the terrain's buffers: pushed now, not over the next frames (a crater's
    // scorch beside a trench drew the berm green, the battle's bake later took it dark)
    if (plan && only.size && G.terrain && G.terrain.flush) G.terrain.flush();
    if (plan && only.size) r = cosm(function () { return K.build(obs, { editor: true, only: only, sigs: {} }); });
    only.forEach(function (kk) { replace(G, kk, r && r.sect.get(kk)); });
    EK.sigs = plan ? sigs : {};
    groundFirst(G, holes() > 0);
    var ms = performance.now() - t0, s = EK.stats;
    s.lays++; if (full) s.full++; else s.part++;
    s.lastMs = +ms.toFixed(2); s.planMs = +(t1 - t0).toFixed(2); s.lastSectors = r ? only.size : 0; s.sectors += s.lastSectors;
    if (ms > s.maxMs) s.maxMs = +ms.toFixed(2);
    EK.lastT = performance.now();
    return s;
  }
  EK.lay = function (full) { return lay(!!full); };
  function schedule(now) {
    var G = G_(); if (!kitWanted(G)) return;
    var t = performance.now(), wait = now ? 0 : Math.max(0, EK.lastT + EK.MINGAP - t);
    if (EK.job) { if (EK.jobAt <= t + wait) return; clearTimeout(EK.job); }
    EK.jobAt = t + wait;
    EK.job = setTimeout(function () { EK.job = null; try { lay(false); } catch (e) { EK.err = String(e && e.stack || e); } }, wait);
  }
  EK.schedule = schedule;
  function teardown(G) {
    if (EK.job) { clearTimeout(EK.job); EK.job = null; }
    EK.sect.forEach(function (g) { disposeGroup(g); }); EK.sect.clear(); EK.sigs = {}; EK.dirty.clear();
    if (EK.grp) { if (EK.grp.parent) EK.grp.parent.remove(EK.grp); EK.grp = null; }
    groundFirst(G, false);
    unhideAll(G && G.obstacles);
  }
  EK.teardown = function () { teardown(G_()); };
  // the ground moved under cells x0..x1, z0..z1: the sectors of any trench cell within two cells of it
  function groundMoved(G, x0, z0, x1, z1) {
    var K = TK(), obs = G.obstacles; if (!K || !obs) return;
    var N = GRID, occ = obs.occupied, by = obs._byCell, W = WORLD / K.SECT;
    x0 = Math.max(0, x0 - 2); z0 = Math.max(0, z0 - 2); x1 = Math.min(N - 1, x1 + 2); z1 = Math.min(N - 1, z1 + 2);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 40000) { EK.sect.forEach(function (g, kk) { EK.dirty.add(kk); }); return; }
    var sec = function (c) { return Math.max(0, Math.min(K.SECT - 1, Math.floor((cellCenter(c) + HALF) / W))); };
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var i = z * N + x;
      if (occ && occ[i] !== 7) { if (!by || !isTrench(by.get(i))) continue; }
      else if (!occ && !(by && isTrench(by.get(i)))) continue;
      for (var dz = -1; dz <= 1; dz += 2) for (var dx = -1; dx <= 1; dx += 2) EK.dirty.add(sec(Math.min(N - 1, Math.max(0, z + dz))) * K.SECT + sec(Math.min(N - 1, Math.max(0, x + dx))));
    }
  }
  EK.groundMoved = function (x0, z0, x1, z1) { groundMoved(G_(), x0, z0, x1, z1); };
  var SCULPT = { raise: 1, lower: 1, smooth: 1, flatten: 1, setheight: 1, noise: 1, erode: 1, ramp: 1 };
  function groundTool(t) { return !!t && (SCULPT[t] || (typeof TYPE !== 'undefined' && TYPE[t] !== undefined) || t.indexOf('crater118:') === 0); }
  function strokeRect(ed, x0, z0, x1, z1) {
    var G = G_(), pad = (ed.brush | 0) + 2;
    var a = ed._mirrored ? ed._mirrored(x0, z0) : [[x0, z0]], b = ed._mirrored ? ed._mirrored(x1, z1) : [[x1, z1]];
    for (var i = 0; i < a.length; i++) { var p = a[i], q = b[i] || p; groundMoved(G, Math.min(p[0], q[0]) - pad, Math.min(p[1], q[1]) - pad, Math.max(p[0], q[0]) + pad, Math.max(p[1], q[1]) + pad); }
  }
  function hookKit(G) {
    var ed = G.editor, obs = G.obstacles;
    wrap(WK, G, 'setMode', {
      pre: function (mode) { var was = this.mode; if (EK.on && was === 'edit' && mode !== 'edit') teardown(this); return was; },
      post: function (args, was) { if (EK.on && this.mode === 'edit' && was !== 'edit' && !EK.loading) lay(true); } });
    wrap(WK, G, 'load', {
      pre: function () { EK.loading++; },
      post: function () { EK.loading = Math.max(0, EK.loading - 1); if (EK.on && this.mode === 'edit' && !EK.loading) lay(false); } });
    wrap(WK, G, 'loadMap', {
      pre: function () { EK.loading++; },
      post: function () { EK.loading = Math.max(0, EK.loading - 1); if (EK.on && this.mode === 'edit' && !EK.loading) lay(true); } });
    // the list was emptied: the pieces hidden before are gone with it (their sectors go at the next lay, by signature)
    wrap(WK, obs, 'clear', { post: function () { if (EK.on && G.mode === 'edit') { EK.hidden = []; schedule(true); } } });
    // a trench piece placed while editing is never drawn: the kit stands for it at the next lay
    wrap(WK, obs, 'add', { post: function (args, pre, r) {
      if (!EK.on || G.mode !== 'edit' || EK.loading) return;
      var k = args[1] * GRID + args[0], o = this._byCell ? this._byCell.get(k) : (this.at ? this.at(args[0], args[1]) : null);
      if (isTrench(o) && o.mesh.parent && EK.grp) { o.mesh.updateMatrixWorld(true); EK.hidden.push({ o: o, parent: o.mesh.parent }); o.mesh.parent.remove(o.mesh); }
      schedule(false);
    } });
    wrap(WK, ed, 'apply', { post: function (args) {
      if (!EK.on || G.mode !== 'edit' || args[0] == null) return;
      schedule(false);   // (the signature holds the ground under each run: a sculpt or a crater beside a trench shows in it)
    } });
    wrap(WK, ed, 'endStroke', {
      pre: function () { var s = this.stroke; return s ? [s.gx0, s.gz0] : null; },
      post: function (args, pre) {
        if (!EK.on || G.mode !== 'edit') return;
        schedule(true);
      } });
    var CT = window.CoverTab118;
    if (CT && typeof CT.setMode === 'function') wrap(WK, CT, 'setMode', { post: function () { if (EK.on) cosm(function () { EK.attachOverlay(); }); } });
  }
  function setKit(v) {
    var G = G_(); v = !!v;
    if (v === EK.on) return;
    EK.on = v;
    if (v) { hookKit(G); if (G.mode === 'edit') lay(true); }
    else { unwrap(WK); teardown(G); }
  }

  /* ---------------------------------------------------------------- the crater tool */
  function lipPool(G) {
    if (EK.lip) return EK.lip;
    return cosm(function () {
      var cap = 256, im = new THREE.InstancedMesh(G.obstacles._craterLipGeo(), G.obstacles.mat.hedge, cap);
      im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; im.count = 0; im.name = 'craterLipEd118';
      G.scene.add(im);
      return (EK.lip = { im: im, cap: cap, m: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
        v: new THREE.Vector3(), s: new THREE.Vector3(), n: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) });
    });
  }
  // the lip as `Game._craterLip` draws a shell's (same geometry, material, size and turn)
  function lipAdd(G, wx, wz, kg, R) {
    if (!(kg >= 0.3)) return;
    var P = lipPool(G), T = G.terrain, rr = R > 0 ? R : 0.49 * K_FIG * Math.cbrt(kg);
    if (P.im.count >= P.cap) return;
    var hx0 = T.heightAt(wx - rr, wz), hx1 = T.heightAt(wx + rr, wz), hz0 = T.heightAt(wx, wz - rr), hz1 = T.heightAt(wx, wz + rr);
    var hash = Math.abs(Math.sin(wx * 12.9898 + wz * 78.233) * 43758.5453) % 1;
    P.n.set(hx0 - hx1, 2 * rr, hz0 - hz1).normalize();
    P.q.setFromUnitVectors(P.up, P.n).multiply(P.q2.setFromAxisAngle(P.up, hash * 6.283));
    P.v.set(wx, (hx0 + hx1 + hz0 + hz1) / 4, wz);
    P.s.set(rr, rr * (0.85 + hash * 0.3), rr);
    P.im.setMatrixAt(P.im.count, P.m.compose(P.v, P.q, P.s));
    P.im.count++;
    P.im.instanceMatrix.needsUpdate = true;
  }
  function crSpec(k) {
    var C = EK.CRATERS[k] || EK.CRATERS.shell, kg = C.kg(), cr = craterOf(kg, C.kind);
    var vis = typeof heVisual === 'function' ? heVisual(kg) : cr.r;
    return { kg: kg, cr: cr, scorchR: TRUE_SCALE ? vis * K_FX * 0.6 : undefined, R: cr.r / METERS_PER_UNIT };
  }
  EK.spec = crSpec;
  /** Dig one crater as a burst of that charge digs it (the dimple, the scorch, the lip) and remember it. */
  function dig(G, wx, wz, k, redraw) {
    var s = crSpec(k), T = G.terrain;
    if (!redraw) {
      if (TRUE_SCALE) T.craterTrue(wx, wz, s.cr.r, s.cr.d);
      else T.crater(wx, wz, (typeof heRadius === 'function' ? heRadius(s.kg) : s.R * 2) * 0.5, 0.4, s.scorchR);
    }
    if (TRUE_SCALE && G._scorchRound) G._scorchRound(wx, wz, s.scorchR);
    else if (redraw && !TRUE_SCALE && G._scorchRound) G._scorchRound(wx, wz, s.R);
    lipAdd(G, wx, wz, s.kg, TRUE_SCALE ? s.R : undefined);
    if (!redraw) EK.craters.push({ x: Math.round(wx * 100) / 100, z: Math.round(wz * 100) / 100, k: EK.CRATERS[k] ? k : 'shell' });
  }
  EK.dig = function (wx, wz, k) { var G = G_(); dig(G, wx, wz, k, false); G.obstacles.refreshHeights(); };
  function redrawAll(G) {
    if (EK.lip) { EK.lip.im.count = 0; EK.lip.im.instanceMatrix.needsUpdate = true; }
    for (var i = 0; i < EK.craters.length; i++) { var c = EK.craters[i]; dig(G, c.x, c.z, c.k, true); }
  }
  function hookCrater(G) {
    var ed = G.editor;
    // the tool: one crater a click (and its mirror images), at the point clicked
    wrap(WC, ed, '_applyPlacement', { pre: function (gx, gz, tool) {
      if (!tool || String(tool).indexOf('crater118:') !== 0) return null;
      if (!EK.craterOn) return wrap.SKIP;
      if (this.stroke && this.stroke.cells && this.stroke.cells.size > 1) return wrap.SKIP;   // a drag does not scatter craters
      var wp = this.strWorld, f = this._stampFlip, ox = 0, oz = 0;
      if (wp && isFinite(wp.x) && isFinite(wp.z)) {
        ox = wp.x - cellCenter(worldToCell(wp.x)); oz = wp.z - cellCenter(worldToCell(wp.z));
        if (f && f[0]) ox = -ox; if (f && f[1]) oz = -oz;
      }
      dig(this.game, cellCenter(gx) + ox, cellCenter(gz) + oz, String(tool).slice(10), false);
      this.game.obstacles.refreshHeights();
      if (this.game.sfx && this.game.sfx.place) this.game.sfx.place();
      return wrap.SKIP;
    } });
    wrap(WC, G, 'serialize', { post: function (args, pre, r) {
      if (EK.craterOn && r && EK.craters.length) r.craters118 = EK.craters.map(function (c) { return { x: c.x, z: c.z, k: c.k }; });
    } });
    wrap(WC, G, 'load', { post: function (args, pre, r) {
      if (!EK.craterOn) return;
      var d = args[0], L = d && Array.isArray(d.craters118) ? d.craters118 : [];
      var off = d && d.grid && d.grid < GRID ? Math.floor((GRID - d.grid) / 2) * TILE : 0;
      EK.craters = L.filter(function (c) { return c && isFinite(c.x) && isFinite(c.z); }).map(function (c) { return { x: +c.x + off, z: +c.z + off, k: EK.CRATERS[c.k] ? c.k : 'shell' }; });
      redrawAll(this);
    } });
    wrap(WC, G, 'loadMap', { pre: function () { if (EK.craterOn) { EK.craters = []; if (EK.lip) { EK.lip.im.count = 0; EK.lip.im.instanceMatrix.needsUpdate = true; } } } });
  }
  function setCrater(v) {
    var G = G_(); v = !!v;
    if (v === EK.craterOn) return;
    EK.craterOn = v;
    if (v) hookCrater(G);
    else {
      unwrap(WC);
      EK.craters = [];
      if (EK.lip) { if (EK.lip.im.parent) EK.lip.im.parent.remove(EK.lip.im); EK.lip.im.dispose && EK.lip.im.dispose(); EK.lip = null; }
      if (G.editor && String(G.editor.tool).indexOf('crater118:') === 0 && G.editor.setTool) G.editor.setTool('removeObs');
    }
    [].forEach.call(document.querySelectorAll('.tool-btn[data-tool^="crater118:"]'), function (b) { b.style.display = v ? '' : 'none'; });
  }

  /* ---------------------------------------------------------------- the switches */
  window.editorKit118Install = function () {
    var G = G_(); if (!G || !G.editor || !G.obstacles || G._ek118) return;
    G._ek118 = EK;
    var kitInit = G.editorKit118 != null ? G.editorKit118 === true : EK.DEFAULT;
    var crInit = G.craterTool118 != null ? G.craterTool118 === true : EK.CRATER_DEFAULT;
    Object.defineProperty(G, 'editorKit118', { configurable: true, enumerable: true, get: function () { return EK.on; }, set: setKit });
    Object.defineProperty(G, 'craterTool118', { configurable: true, enumerable: true, get: function () { return EK.craterOn; }, set: setCrater });
    if (crInit) setCrater(true);
    if (kitInit) setKit(true);
  };
})();
