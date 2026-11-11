/* Round 118 — BUNKERS: a concrete casemate, a Tobruk pit and a log dugout (`game.bunker118`, default OFF).
 *
 * OFF is the old game exactly: nothing here runs, nothing is built, the map file is unchanged.
 *
 * A bunker is a ONE-CELL BUILDING in the building layer (assets/structures.js): concrete or log walls,
 * a slab roof, an EMBRASURE (a window) to its front and a door to its rear. A cell is 6 m, the size of
 * an MG casemate. Everything the game already does for a man in a house then holds for a man in it:
 *   - a round stops on the walls and goes in only through an opening (`_rayWall`, `Structures.aperture`);
 *     concrete is hp 800, pen 0 (MATS); the dugout's logs are `wood` (pen 0.35: the earth bank is not modelled);
 *   - fragments stop on the walls (`Game._fragWall`) and the roof slab (`_slabsBetween`);
 *   - a shell holes the wall by its charge (`shellIntoWall`, K_BREACH) and a breach is a new opening;
 *   - he fires OUT through the embrasure (`Projectiles._windowFire`), and fire at him goes at it (`winTarget`);
 *   - the AI's garrison choice scores a cell by its openings (`_aiOccupyStructure`).
 * What this file adds:
 *   - THE ARC (`holds`, `inArc`): a man in a bunker acquires and fires only at what is inside its embrasure's
 *     arc. The rear door is how he got in, not a loophole (a flanker at the door can still fire IN: that is how
 *     bunkers were taken);
 *   - the registry (kind, front) saved with the map (`bunkers118`), and the editor's three buttons;
 *   - the GARRISON (`tick`): AI infantry near a bunker that is not full are sent into it, once a second.
 */
(function () {
  'use strict';
  // `half`: half the embrasure's field of fire, degrees. An MG casemate's embrasure gave 60-90 degrees; a Tobruk
  // (Ringstand 58c) fired all round from its ring; a dugout's firing slit was wider than a casemate's.
  var KINDS = {
    casemate: { name: 'Casemate', mat: 'concrete', half: 40, ring: false, cap: 3 },
    tobruk:   { name: 'Tobruk',   mat: 'concrete', half: 180, ring: true,  cap: 2 },
    dugout:   { name: 'Dugout',   mat: 'wood',     half: 50, ring: false, cap: 4 },
  };
  var EDGE_D = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N, E, S, W — Structures' EDGE_D
  var GARRISON_R = 14;                                  // cells: how far an AI man is sent from to man a bunker
  var BLAST_CUT = 0.08;                                 // of a burst outside the walls or on the slab, what reaches him
  var GARRISON_TRIES = 12;                              // times a man whose leg was cleared is sent in again
  var GARRISON_COMMIT_S = 25;                           // s: how long his walk in outranks a target he sees on the way
  var NO_GARRISON = { mortar: 1, artillery: 1, atgun: 1, sniper: 1 };

  function matId(id) {
    var M = window.Structures && window.Structures.MATS;
    if (M) for (var i = 1; i < M.length; i++) if (M[i] && M[i].id === id) return i;
    return 6;
  }

  var BUNK_MAT = function () { return window.Bunker118 && window.Bunker118._mat; };
  var B = {
    KINDS: KINDS, EDGE_D: EDGE_D, GARRISON_R: GARRISON_R,
    // what a rifleman has to hit of a man behind an embrasure: a slit about a third of a window's height
    // (`PRESENT.win` 0.07, round 115), read where a round finds him (`_presentedFrac`'s caller)
    SLIT_PRESENT: 0.025,
    list: [],
    cells: new Map(),
    _acc: 0,
    on: function (g) { return !!(g && g.bunker118 === true); },
    /** THE DEFAULT. `game.bunker118` set either way wins; left unset, a map load sets it from this (the editor's
     *  panel, built before the game exists, reads this too). false = the old game. */
    ON: false,
    clear: function () {
      this.list.length = 0; this.cells.clear(); this._acc = 0; if (this._undraw) this._undraw();
      if (this.ON === true && window.game && window.game.bunker118 == null) window.game.bunker118 = true;
    },
    /** The editor's prop angle (degrees) -> the embrasure's edge: 0 N (-z), 90 E, 180 S, 270 W. */
    faceFromDeg: function (deg) { return (Math.round((((deg || 0) % 360) + 360) % 360 / 90)) % 4; },
    _key: function (gx, gz) { return gz * GRID + gx; },
    _put: function (r) {
      var k = this._key(r.gx, r.gz), old = this.cells.get(k);
      if (old) this.list.splice(this.list.indexOf(old), 1);
      this.list.push(r); this.cells.set(k, r);
    },
    /** Build one at cell (gx, gz), its embrasure on edge `face`. Returns the record, or null. */
    build: function (g, gx, gz, kind, face) {
      var S = g && g.structures, W = window.Structures, K = KINDS[kind];
      if (!S || !W || !K) return null;
      if (gx < 1 || gz < 1 || gx >= GRID - 1 || gz >= GRID - 1) return null;
      face = (((face | 0) % 4) + 4) % 4;
      var M = matId(K.mat), rear = (face + 2) % 4;
      // the plot clear of props, as the map helper does for a building
      if (g.obstacles && g.obstacles.blocked && g.obstacles.blocked(gx, gz)) g.obstacles.remove(gx, gz);
      S.build({ gx: gx, gz: gz, w: 1, d: 1, preset: 'bunker', floors: 1, winEvery: 0, rooms: 0, roof: 'flat',
        mat: M, floorMat: M, roofMat: M, doorEdge: rear, backDoor: false, block: false, court: false,
        seed: (gx * 7919 + gz * 104729) >>> 0 });
      for (var e = 0; e < 4; e++) {
        if (e === rear) continue;
        if (e === face || K.ring) S.setWall(gx, gz, 0, e, M, W.K_WINDOW);
      }
      if (S.flush) S.flush();
      if (g.obstacles && g.obstacles.refreshHeights) g.obstacles.refreshHeights();
      var r = { gx: gx, gz: gz, kind: kind, face: face };
      this._put(r);
      this.redraw(g);
      return r;
    },
    /** The bunker whose cell (wx, wz) is in, while its building stands. */
    at: function (g, wx, wz) {
      if (!this.list.length) return null;
      var gx = worldToCell(wx), gz = worldToCell(wz);
      var r = this.cells.get(this._key(gx, gz));
      if (!r) return null;
      var S = g.structures;
      if (!S || !S.has(gx, gz)) return null;   // erased in the editor, or knocked down
      return r;
    },
    /** Is the point (tx, tz) inside bunker r's field of fire? Measured from the cell's centre. */
    inArc: function (r, tx, tz) {
      var K = KINDS[r.kind];
      if (!K || K.half >= 180) return true;
      var dx = tx - cellCenter(r.gx), dz = tz - cellCenter(r.gz), l = Math.sqrt(dx * dx + dz * dz);
      if (l < 1e-6) return true;
      var d = EDGE_D[r.face];
      return (dx * d[0] + dz * d[1]) / l >= Math.cos(K.half * Math.PI / 180);
    },
    /** True when `u` is in a bunker and `t` is outside its arc: he neither picks nor fires at that man. */
    holds: function (g, u, t) {
      if (!t || !t.pos || !this.list.length || u.def.vehicle) return false;
      var r = this.at(g, u.pos.x, u.pos.z);
      return !!r && !this.inArc(r, t.pos.x, t.pos.z);
    },
    /** What reaches a man in a bunker of a burst at (wx, wy, wz) — a factor on its damage (1 = all of it). A shell
     *  that came down through a roof (`plunge`: it bursts in the top storey, `_missionRoof`) is stopped by the slab
     *  while the slab stands; a burst outside it is stopped by the walls, an embrasure being a slit (`_fragWall`
     *  already takes the walls of a house, which have windows). Measured before this: men inside the casemate were
     *  killed by plunging mortar and gun fire (116-133 a hit) through an intact concrete roof. */
    blastCut: function (g, u, wx, wy, wz, o) {
      var r = this.at(g, u.pos.x, u.pos.z);
      if (!r) return 1;
      var S = g.structures, roof = S.roofM ? S.roofM[S.li(r.gx, r.gz, 0)] : 1;
      if (o && o.plunge) return roof ? BLAST_CUT : 1;
      return (worldToCell(wx) === r.gx && worldToCell(wz) === r.gz) ? 1 : BLAST_CUT;
    },
    /** For the acquisition loop: the bunker `u` is in (null almost always), read once per scan. */
    arcOf: function (g, u) {
      if (!this.list.length || u.def.vehicle) return null;
      return this.at(g, u.pos.x, u.pos.z);
    },
    /** THE GARRISON, once a second: a bunker short of its crew takes the nearest AI infantry of the side that
     *  holds it (the first to reach it) from within GARRISON_R cells, idle and on no order of the player's. */
    tick: function (g, dt) {
      if (!this.list.length) return;
      this._acc += dt;
      if (this._acc < 1) return;
      this._acc = 0;
      var units = g.units;
      for (var i = 0; i < this.list.length; i++) {
        var r = this.list[i], K = KINDS[r.kind];
        if (!g.structures || !g.structures.has(r.gx, r.gz)) continue;
        var cx = cellCenter(r.gx), cz = cellCenter(r.gz), n = 0, S = g.structures;
        for (var j = 0; j < units.length; j++) {
          var u = units[j];
          if (!u.alive || u.downed || u.def.vehicle) continue;
          var inside = worldToCell(u.pos.x) === r.gx && worldToCell(u.pos.z) === r.gz;
          if (inside || u._bunker118 === r) { n++; if (!r.team) r.team = u.team; }
          // ON HIS WAY IN, STILL: something cleared his leg (a rule that stops a man to fight, the stuck detector) —
          // he is sent again, up to GARRISON_TRIES times, then let go
          if (!inside && u._bunker118 === r && !(u.path && u.path.length) && !u.explicit) {
            if ((u._b118Tries = (u._b118Tries || 0) + 1) > GARRISON_TRIES) { u._bunker118 = null; n--; continue; }
            u.target = null; u.groundAtk = null;
            u.orderMove(cx, cz, false, 'fast', 0);
            u._strSpot = (0 * GRID + r.gz) * GRID + r.gx; u._pendingCover = true; u._bunker118 = r;
            if (u._commitMove) u._commitMove(GARRISON_COMMIT_S);
          }
        }
        if (n >= K.cap) continue;
        var best = null, bd = GARRISON_R * TILE;
        for (var k = 0; k < units.length; k++) {
          var c = units[k];
          if (!c.alive || c.downed || c.def.vehicle || c.def.towed || c.surrendered || c.embarkedIn) continue;
          if (r.team && c.team !== r.team) continue;   // the side that holds it: the first man to reach it, or be sent
          if (c.explicit || (c.path && c.path.length) || c._bunker118 || NO_GARRISON[c.def.kind]) continue;
          if (!c._underAI || !c._underAI()) continue;
          var cgx = worldToCell(c.pos.x), cgz = worldToCell(c.pos.z);
          if (S.has(cgx, cgz) && S.insideAt(cgx, cgz, c.lvl | 0) >= 0.5) continue;   // in this bunker already, or holding a house
          var d = Math.sqrt((c.pos.x - cx) * (c.pos.x - cx) + (c.pos.z - cz) * (c.pos.z - cz));
          if (d < bd) { bd = d; best = c; }
        }
        if (!best) continue;
        best.target = null; best.groundAtk = null;
        // at the run: a man on a 'fast' leg holds his fire and keeps going (`_holdsFire`); at 'normal' the stop-to-fight
        // rule (`_updateCombat`) cleared his path on the first target in range, 2 m out (nobody arrived in 20 s)
        best.orderMove(cx, cz, false, 'fast', 0);
        best.explicit = false;
        best._strSpot = (0 * GRID + r.gz) * GRID + r.gx;   // a claim, as `_aiOccupyStructure` makes one (after the order)
        best._pendingCover = true;
        // and committed to the leg (`Unit._commitMove`), so nothing that asks re-tasks him on the way
        if (best._commitMove) best._commitMove(GARRISON_COMMIT_S);
        best._bunker118 = r;
        if (!r.team) r.team = best.team;
      }
    },
    // ---- THE DRAWING (cosmetic; one mesh, one draw call, a bunker) ------------------------------------------------
    // The building layer draws a bunker cell as a small house: glazed shuttered windows, a white flat roof. Until the
    // Blender model, a shell is drawn ROUND it in code — a concrete (or log) block a little outside its walls, cut
    // where the house's openings are (so the men inside still see out, and the door is still a door), a slab that
    // overhangs, and earth banked on its sides and rear. Nothing here is read by the simulation.
    _mat: null,
    _meshes: [],
    _undraw: function () {
      for (var i = 0; i < this._meshes.length; i++) { var m = this._meshes[i]; if (m.parent) m.parent.remove(m); if (m.geometry) m.geometry.dispose(); }
      this._meshes.length = 0;
    },
    redraw: function (g) {
      this._undraw();
      if (!g || g.bunker118 !== true || !this.list.length || !window.THREE || !g.scene) return;
      var self = this, run = function () { for (var i = 0; i < self.list.length; i++) self._draw(g, self.list[i]); };
      if (typeof cosmeticScope === 'function') cosmeticScope(run); else run();
    },
    _draw: function (g, r) {
      var TH = window.THREE, W3 = window.Structures || {}, S = W3.S || 0.25, H = W3.FLOOR_H || 0.75;
      // two buckets: the walls (vertical faces) on the building layer's material, lit and graded as the houses are
      // (on a plain Lambert the face away from the sun drew black whatever fill was added); the slab's top, the banks
      // and the ring on a Lambert (the building material draws a level face as white roof tiles)
      var K = KINDS[r.kind], BK = [{ P: [], N: [], C: [], lin: false }, { P: [], N: [], C: [], lin: true }];
      var T = TILE, Wd = T / 2 + 0.28 * S, top = H + 0.55 * S, base = -0.4 * S, th = 0.3 * S;
      // drawn with the building layer's own material (`Structures.mat`: the game's PaintedMaterial + Fabric, vertex
      // colours as the buildings use them), so it is lit and graded as the houses are. On a plain Lambert the face away
      // from the sun drew black whatever fill was added, and 0x7b7871 drew white as linear albedo.
      var useS = !!(g.structures && g.structures.mat);
      var col = function (hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; };
      var CON = col(r.kind === 'dugout' ? 0x5c4631 : 0x86837b), SLAB = col(r.kind === 'dugout' ? 0x4f5a34 : 0x7b7871), EARTH = col(0x5d4c35), TURF = col(0x55603a);
      var quad = function (a, b, c, d, n, k) {
        var bk = BK[(useS && n[1] === 0) ? 0 : 1], kk = bk.lin && useS ? k : (bk.lin ? [Math.pow(k[0], 2.2), Math.pow(k[1], 2.2), Math.pow(k[2], 2.2)] : k);
        if (bk.lin) kk = [Math.pow(k[0], 2.2), Math.pow(k[1], 2.2), Math.pow(k[2], 2.2)];
        bk.P.push.apply(bk.P, a.concat(b, c, a, c, d)); for (var i = 0; i < 6; i++) { bk.N.push(n[0], n[1], n[2]); bk.C.push(kk[0], kk[1], kk[2]); }
      };
      var box = function (x0, y0, z0, x1, y1, z1, k, kTop) {
        quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], kTop || k);
        quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], k);
        quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], k);
        quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], k);
        quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], k);
      };
      // a bank of earth along a wall: from the wall's top-ish down to the ground `out` beyond it (local x side `sx`)
      var bankX = function (sx, z0, z1, h, out) {
        var x0 = sx * Wd, x1 = sx * (Wd + out), nx = sx * h, ny = out, l = Math.sqrt(nx * nx + ny * ny);
        if (sx > 0) quad([x0, h, z0], [x0, h, z1], [x1, base, z1], [x1, base, z0], [nx / l, ny / l, 0], TURF);
        else quad([x0, h, z1], [x0, h, z0], [x1, base, z0], [x1, base, z1], [nx / l, ny / l, 0], TURF);
      };
      var bankZ = function (x0, x1, h, out) {   // behind the rear wall (local -z)
        var z0 = -Wd, z1 = -(Wd + out), l = Math.sqrt(h * h + out * out);
        quad([x0, h, z0], [x1, h, z0], [x1, base, z1], [x0, base, z1], [0, out / l, -h / l], TURF);
      };
      // the embrasure: over the house's window pair (Structures.aperture: 0.82 wide at T/4 and 3T/4, sill 0.78-1.62)
      var xs = T * 0.25 + 0.41 * S, ys0 = 0.98 * S, ys1 = 1.42 * S, z0f = T / 2 + 0.06 * S;
      box(-Wd, base, z0f, Wd, ys0, Wd, CON);
      box(-Wd, ys1, z0f, Wd, top, Wd, CON);
      box(-Wd, ys0, z0f, -xs, ys1, Wd, CON);
      box(xs, ys0, z0f, Wd, ys1, Wd, CON);
      // the sides
      box(-Wd, base, -Wd, -T / 2 - 0.06 * S, top, z0f, CON);
      box(T / 2 + 0.06 * S, base, -Wd, Wd, top, z0f, CON);
      // the rear, cut for the door (0.72 wide, 1.55 tall)
      var dw = 0.42 * S, dh = 1.6 * S, zr = -T / 2 - 0.06 * S;
      box(-Wd, base, -Wd, -dw, top, zr, CON);
      box(dw, base, -Wd, Wd, top, zr, CON);
      box(-dw, dh, -Wd, dw, top, zr, CON);
      // the slab, overhanging
      var ov = 0.45 * S;
      box(-Wd - ov, top, -Wd - ov, Wd + ov, top + 0.55 * S, Wd + ov, SLAB, SLAB);
      if (r.kind === 'dugout') box(-Wd + 0.4 * S, top + 0.55 * S, -Wd + 0.4 * S, Wd - 0.4 * S, top + 1.1 * S, Wd - 0.6 * S, TURF, TURF);
      if (r.kind === 'tobruk') {   // the ring on the slab, and its pintle
        var R0 = 0.62 * S, R1 = 0.95 * S, yr = top + 0.55 * S, hr = 0.28 * S, n = 14;
        for (var i = 0; i < n; i++) {
          var a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
          quad([R1 * c0, yr, R1 * s0], [R1 * c0, yr + hr, R1 * s0], [R1 * c1, yr + hr, R1 * s1], [R1 * c1, yr, R1 * s1], [c0, 0, s0], CON);
          quad([R0 * c0, yr + hr, R0 * s0], [R0 * c0, yr - 0.5 * S, R0 * s0], [R0 * c1, yr - 0.5 * S, R0 * s1], [R0 * c1, yr + hr, R0 * s1], [-c0, 0, -s0], col(0x2a2926));
          quad([R0 * c0, yr + hr, R0 * s0], [R0 * c1, yr + hr, R0 * s1], [R1 * c1, yr + hr, R1 * s1], [R1 * c0, yr + hr, R1 * s0], [0, 1, 0], SLAB);
        }
      }
      // earth banked up the sides and the rear (not over the door), to the slab's edge
      var hb = top - 0.15 * S, out = 2.6 * S;
      bankX(1, -Wd, Wd - 0.9 * S, hb, out); bankX(-1, -Wd, Wd - 0.9 * S, hb, out);
      bankZ(-Wd, -dw - 0.7 * S, hb, out); bankZ(dw + 0.7 * S, Wd, hb, out);
      // to the world: +z local is the embrasure's edge
      var d = EDGE_D[r.face], fx = d[0], fz = d[1], rx = fz, rz = -fx;
      var cx = cellCenter(r.gx), cz = cellCenter(r.gz), S2 = g.structures;
      var by = (S2 && S2.baseY) ? S2.baseY[S2.ci(r.gx, r.gz)] : g.terrain.heightAt(cx, cz);
      if (!this._mat) this._mat = new TH.MeshLambertMaterial({ vertexColors: true });
      for (var bi = 0; bi < 2; bi++) {
      var P = BK[bi].P, N = BK[bi].N, C = BK[bi].C;
      if (!P.length) continue;
      var pos = new Float32Array(P.length), nor = new Float32Array(N.length);
      for (var v = 0; v < P.length; v += 3) {
        pos[v] = cx + P[v] * rx + P[v + 2] * fx; pos[v + 1] = by + P[v + 1]; pos[v + 2] = cz + P[v] * rz + P[v + 2] * fz;
        nor[v] = N[v] * rx + N[v + 2] * fx; nor[v + 1] = N[v + 1]; nor[v + 2] = N[v] * rz + N[v + 2] * fz;
      }
      // the winding follows the turn: a reflection (det < 0) is wound back
      var det = rx * fz - rz * fx;
      if (det < 0) for (var t = 0; t < pos.length; t += 9) for (var q = 0; q < 3; q++) { var tmp = pos[t + 3 + q]; pos[t + 3 + q] = pos[t + 6 + q]; pos[t + 6 + q] = tmp; }
      var geo = new TH.BufferGeometry();
      geo.setAttribute('position', new TH.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new TH.BufferAttribute(nor, 3));
      geo.setAttribute('color', new TH.BufferAttribute(new Float32Array(C), 3));
      var mat = bi === 0 ? g.structures.mat : this._mat, mesh = new TH.Mesh(geo, mat);
      // a fill that follows the sky (the face away from the sun drew black: ambient + hemisphere alone go under the
      // grade's toe, and 0.045 was still black); it goes with the hemisphere light, so it is gone at night
      if (bi === 1) mesh.onBeforeRender = function () { var h = g.hemiLight, m = BUNK_MAT(); if (m) m.emissive.setScalar(h ? 0.05 * Math.min(1, h.intensity / 0.4) : 0); };
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'bunker118:' + r.kind + (bi ? ':top' : ':walls');
      g.scene.add(mesh); this._meshes.push(mesh);
      }
    },
    serialize: function () {
      if (!this.list.length) return null;
      return this.list.map(function (r) { return [r.gx, r.gz, r.kind, r.face]; });
    },
    load: function (data, off) {
      this.clear();
      if (!data || !data.length) return;
      off = off || 0;
      for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!d || !KINDS[d[2]]) continue;
        this._put({ gx: (d[0] | 0) + off, gz: (d[1] | 0) + off, kind: d[2], face: (d[3] | 0) & 3 });
      }
      if (window.game) this.redraw(window.game);
    },
  };
  window.Bunker118 = B;
})();
