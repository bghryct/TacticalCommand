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

  var B = {
    KINDS: KINDS, EDGE_D: EDGE_D, GARRISON_R: GARRISON_R,
    // what a rifleman has to hit of a man behind an embrasure: a slit about a third of a window's height
    // (`PRESENT.win` 0.07, round 115), read where a round finds him (`_presentedFrac`'s caller)
    SLIT_PRESENT: 0.025,
    list: [],
    cells: new Map(),
    _acc: 0,
    on: function (g) { return !!(g && g.bunker118 === true); },
    clear: function () { this.list.length = 0; this.cells.clear(); this._acc = 0; },
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
    },
  };
  window.Bunker118 = B;
})();
