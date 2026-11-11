/* Round 118 — THE MAPS' BUNKERS (`game.bunkerMaps118`, default ON; false = the old game exactly).
 *
 * Fifteen shipped maps put 89 `bunker` and `pillbox` PROPS on the field (Vierville Draw, Betio, Bir Hakeim, Seelow
 * Heights...): a solid block in the obstacle layer that a man stands BESIDE, cover 0.75, and nobody can be inside.
 * With the switch on, at the map's load each one becomes a real bunker of assets/bunker118.js — a one-cell building
 * with walls, a slab, an embrasure and a door — on the ground of the side whose men stand nearest it, its embrasure
 * toward the ground the other side reaches first, and the computer's side puts a crew in it from the men it
 * deployed round it.
 *
 *   - THE FACING: one breadth-first walk a side from the enemy's men (a man's climb, props, walls); the bunker faces
 *     the cell on a ring APPROACH_R cells out that the walk reaches first, the enemy's centroid only when it reaches
 *     none. (Facing the centroid, every enemy who came within 240 m of a Vierville bunker was outside its arc.)
 *   - THE KIND: a `bunker` prop is a concrete casemate; a `pillbox` is a casemate too, or a log dugout on the maps
 *     whose works were log and coral or field timber (Betio, Peleliu, Khalkhin Gol). The Tobruk is not used: its sim is
 *     a 3 m building whose walls stop rounds above the low apron that is drawn (see .claude/wip118/bunker3/NOTES.md).
 *   - THE SEAT: the prop's own cell, or the nearest cell within two that is fit: level enough (3x3 height range
 *     <= SEAT_R3), not on or beside a road, water or a building (5x5), 4+ cells from another bunker (the earth mound
 *     is 3x3), the door cell open, nobody standing on it. A prop with no fit seat stays the old prop (reported).
 *   - THE GRADE: the front row cut or filled to the slab's foot (-0.15..+0.20 height units: the embrasure is not
 *     looking into a bank and its face does not float), the door cell level with the floor, the sides and rear
 *     corners held within -0.35..+0.60 (the earth drapes them), the next ring moved half as far as the cells it
 *     borders (feathered; a cliff two cells off stays a cliff). Roads, water and building cells are never touched.
 *     Props in the 3x3 are taken off (they would stand in the earth).
 *   - THE GARRISON (computer's side only — the player's side is never manned, autoCommand or not): an MG team in a
 *     casemate (the nearest MG of the side within R_DEF cells and a man of his own section), riflemen in a dugout,
 *     at most SHARE of the side's infantry in all. They are put in at deployment, claim the cell (`_strSpot`, so the
 *     section's formation leaves them alone) and are marked `_b118Gar`: the section's next task releases them only
 *     when it is a withdrawal (`Game._squadTask`); `tick` (every step) cancels a leg that leaves the cell and sends a
 *     displaced man back; the slab gone, the bunker down, the man routed or dead, he is let go. A restart
 *     (`Game.restartBattle`) gives the bunkers their side and crew back (`restore`).
 *
 * Runs once per map load, after the objectives are placed (the old props weigh in `_autoObjectives`; converting
 * first would move the objectives of the 10 maps that place theirs that way) and before `_prepareDefence`.
 * Deterministic: no random numbers; the drawing is Bunker118's (cosmetic stream).
 */
(function () {
  'use strict';
  var EDGE_D = [[0, -1], [1, 0], [0, 1], [-1, 0]];          // N, E, S, W (Structures' EDGE_D)
  var LOG_MAPS = /^(Betio|Peleliu|Khalkhin Gol)/;            // log-and-coral / field-timber works: a pillbox is a dugout
  var NO_GARRISON = { mortar: 1, artillery: 1, atgun: 1, sniper: 1, officer: 1 };
  var BUILDING_PROPS = { house: 1, building: 1, tower: 1, church: 1, barn: 1, farmhouse: 1, ruin: 1, warehouse: 1, hangar: 1 };
  var M = {
    /** THE DEFAULT. `game.bunkerMaps118` set either way wins; left unset, the map load sets it from this. false = the
     *  old game. ON from 05:40 UTC 11 Nov (.claude/wip118/bunker3/NOTES.md): all 13 converted maps pass the lint, a
     *  60 s battle and the captures; 1800 s battles (Vierville, Khalkhin Gol, Betio x 3 seeds, off/on, repeats
     *  identical) keep their objectives and nothing sticks. */
    ON: true,
    SEAT_R3: 1.25,        // height units (1 = 3 m) over the 3x3 the seat may span before it is too steep to seat
    SEAT_SEARCH: 2,       // cells round the prop searched for a seat
    SPACING: 4,           // cells (Chebyshev) between two bunkers: the earth mounds are 3x3
    R_DEF: 30,            // cells: the owning side's men this close at deployment are its defence of the bunker
    SHARE: 0.2,           // at most this share of a side's infantry is put into bunkers at deployment
    GAR: { casemate: 2, tobruk: 2, dugout: 3 },   // men put in at deployment (the caps are 3 / 2 / 4)
    last: null,           // the last map's report: { map, conv, skipped, gar }
    crew: [],             // the men put in at deployment, while they are its crew
    on: function (g) {
      if (!g || !window.Bunker118) return false;
      if (g.bunkerMaps118 == null) g.bunkerMaps118 = this.ON === true;
      return g.bunkerMaps118 === true && g.bunker118 === true;
    },
    kindFor: function (type, mapName) { return type === 'pillbox' && LOG_MAPS.test(mapName || '') ? 'dugout' : 'casemate'; },
    /** The edge (0 N, 1 E, 2 S, 3 W) nearest the bearing from (cx, cz) to (ex, ez). */
    faceToward: function (cx, cz, ex, ez) {
      var dx = ex - cx, dz = ez - cz, best = 0, bd = -Infinity;
      for (var e = 0; e < 4; e++) { var d = dx * EDGE_D[e][0] + dz * EDGE_D[e][1]; if (d > bd) { bd = d; best = e; } }
      return best;
    },
    /** THE APPROACH. Walking distance (cells, 8-way, a man's climb, props and walls in the way) from every man of
     *  the sides hostile to `own`: the field the enemy has to cross. One breadth-first walk a side, at load. */
    APPROACH_R: 12,       // cells: the ring round a bunker on which the enemy's first arrival sets its facing
    _approach: function (g, own, cache) {
      if (cache[own]) return cache[own];
      var G = GRID, N = G * G, T = g.terrain, pf = g.pathfinder, S = g.structures, dist = new Int32Array(N).fill(-1), q = new Int32Array(N), h = 0, t = 0;
      for (var i = 0; i < g.units.length; i++) {
        var u = g.units[i]; if (!u.alive || !(u.team > 0) || !areHostile(own, u.team) || u.def.vehicle) continue;
        var ux = worldToCell(u.pos.x), uz = worldToCell(u.pos.z), k = uz * G + ux;
        if (ux < 0 || uz < 0 || ux >= G || uz >= G || dist[k] >= 0) continue;
        dist[k] = 0; q[t++] = k;
      }
      var DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
      while (h < t) {
        var c = q[h++], cx = c % G, cz = (c / G) | 0, ch = T.height(cx, cz), dc = dist[c];
        for (var d = 0; d < 8; d++) {
          var nx = cx + DX[d], nz = cz + DZ[d]; if (nx < 0 || nz < 0 || nx >= G || nz >= G) continue;
          var n = nz * G + nx; if (dist[n] >= 0 || !pf.passable(nx, nz)) continue;
          if (Math.abs(T.height(nx, nz) - ch) > CLIMB) continue;
          if (S && S.any && d < 4 && !S.canCross(cx, cz, 0, DX[d], DZ[d])) continue;
          dist[n] = dc + 1; q[t++] = n;
        }
      }
      cache[own] = dist;
      return dist;
    },
    /** The edge facing the ground the enemy reaches first on a ring APPROACH_R cells out, or -1. */
    faceApproach: function (g, x, z, dist) {
      var G = GRID, R = this.APPROACH_R, best = -1, bd = Infinity, bx = 0, bz = 0;
      for (var a = 0; a < 64; a++) {
        var an = a / 64 * 6.2832, px = Math.round(x + Math.cos(an) * R), pz = Math.round(z + Math.sin(an) * R);
        if (px < 0 || pz < 0 || px >= G || pz >= G) continue;
        var dv = dist[pz * G + px]; if (dv < 0) continue;
        if (dv < bd) { bd = dv; bx = px; bz = pz; best = 1; }
      }
      return best < 0 ? -1 : this.faceToward(x, z, bx, bz);
    },
    _roadKin: function (g) {
      var T = g.terrain, G = GRID, n = 0, gr = 0;
      for (var i = 0; i < G * G; i += 7) { n++; if (typeKin(T.type[i]) === 'gravel') gr++; }
      var gravelIsGround = gr > n * 0.25;   // a gravel desert is not one big road (the round-116 rule)
      return function (t) { var k = typeKin(t); return k === 'road' || k === 'cobble' || k === 'ford' || (!gravelIsGround && k === 'gravel'); };
    },
    /** Why (x, z) cannot take a bunker facing `face`, or null. */
    seatWhy: function (g, x, z, face, ctx) {
      var G = GRID, T = g.terrain, S = g.structures, O = g.obstacles;
      if (x < 3 || z < 3 || x >= G - 3 || z >= G - 3) return 'edge';
      if (!T.typePassable(x, z) || T.type[z * G + x] === TYPE.water) return 'ground';
      var mn = Infinity, mx = -Infinity;
      for (var dz = -2; dz <= 2; dz++) for (var dx = -2; dx <= 2; dx++) {
        var nx = x + dx, nz = z + dz, i = nz * G + nx, r1 = Math.max(Math.abs(dx), Math.abs(dz)) <= 1;
        if (S && S.mask && S.mask[i]) return 'building';
        if (r1) {
          var t = T.type[i];
          if (t === TYPE.water) return 'water';
          if (ctx.road(t)) return 'road';
          var h = T.height(nx, nz); if (h < mn) mn = h; if (h > mx) mx = h;
          var o = O.at(nx, nz); if (o && BUILDING_PROPS[o.type]) return 'building';
        }
      }
      if (mx - mn > this.SEAT_R3) return 'steep';
      for (var k = 0; k < ctx.taken.length; k++) if (Math.max(Math.abs(ctx.taken[k].gx - x), Math.abs(ctx.taken[k].gz - z)) < this.SPACING) return 'near';
      var b = EDGE_D[(face + 2) % 4], bx = x + b[0], bz = z + b[1];
      if (!T.typePassable(bx, bz)) return 'door';
      var out = 0;   // the way to the door: one of the three cells behind it open (props in the 3x3 come off)
      for (var s = -1; s <= 1; s++) { var ox = bx + b[0] + s * b[1], oz = bz + b[1] - s * b[0]; if (g.pathfinder.passable(ox, oz)) out++; }
      if (!out) return 'door';
      if (!ctx.prop(x, z) && g.unitAtCell && g.unitAtCell(x, z)) return 'unit';
      return null;
    },
    /** Cut and fill round a bunker at (x, z) facing `face`; returns the largest change (height units). The 3x3 is
     *  clamped to bands round the floor's height h0; the ring outside it takes half its neighbours' change. */
    grade: function (g, x, z, face, ctx) {
      var T = g.terrain, G = GRID, S = g.structures, h0 = T.height(x, z), f = EDGE_D[face], worst = 0, dl = {};
      var keep = function (i) { var t = T.type[i]; return t === TYPE.water || ctx.road(t) || (S && S.mask && S.mask[i]); };
      for (var dz = -1; dz <= 1; dz++) for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        var nx = x + dx, nz = z + dz, i = nz * G + nx;
        if (keep(i)) continue;
        var along = dx * f[0] + dz * f[1], side = dx * f[1] - dz * f[0], lo, hi;
        if (along === 1) { lo = h0 - 0.15; hi = h0 + 0.20; }
        else if (along === -1 && side === 0) { lo = h0 - 0.10; hi = h0 + 0.10; }
        else { lo = h0 - 0.35; hi = h0 + 0.60; }
        var h = T.height(nx, nz), v = Math.min(hi, Math.max(lo, h));
        dl[i] = v - h;
        if (v !== h) { T.setHeight(nx, nz, v); worst = Math.max(worst, Math.abs(v - h)); }
      }
      // the next ring follows HALF of what the cells it borders were moved: the cut or fill is feathered out, and a
      // cliff two cells off stays a cliff (clamping that ring to the graded one moved a bluff 6.5 units on Vierville)
      for (var dz2 = -2; dz2 <= 2; dz2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
        if (Math.max(Math.abs(dx2), Math.abs(dz2)) !== 2) continue;
        var px = x + dx2, pz = z + dz2, pi = pz * G + px;
        if (keep(pi)) continue;
        var sum = 0, cnt = 0;
        for (var qz = -1; qz <= 1; qz++) for (var qx = -1; qx <= 1; qx++) {
          var ix = px + qx, iz = pz + qz;
          if (Math.max(Math.abs(ix - x), Math.abs(iz - z)) !== 1) continue;
          var di = dl[iz * G + ix]; if (di !== undefined) { sum += di; cnt++; }
        }
        if (!cnt) continue;
        var dv = 0.5 * sum / cnt;
        if (Math.abs(dv) < 0.02) continue;
        var ph = T.height(px, pz);
        T.setHeight(px, pz, ph + dv); worst = Math.max(worst, Math.abs(dv));
      }
      return worst;
    },
    /** Every bunker / pillbox prop on the field -> a Bunker118 bunker. Returns the report. */
    convert: function (g, mapName) {
      var O = g.obstacles, G = GRID, B = window.Bunker118;
      var rep = { map: mapName || null, conv: [], skipped: [], gar: [] };
      var props = [];
      for (var i = 0; i < O.list.length; i++) { var o = O.list[i]; if (o.type === 'bunker' || o.type === 'pillbox') props.push({ gx: o.gx, gz: o.gz, type: o.type }); }
      if (!props.length) return rep;
      props.sort(function (a, b) { return (a.type === b.type ? 0 : a.type === 'bunker' ? -1 : 1) || a.gz - b.gz || a.gx - b.gx; });
      var isProp = {}; for (var p0 = 0; p0 < props.length; p0++) isProp[props[p0].gz * G + props[p0].gx] = 1;
      var ctx = { road: this._roadKin(g), taken: B.list.slice(), prop: function (x, z) { return !!isProp[z * G + x]; }, walk: {} };
      // one drawing at the end, not one per bunker (`build` redraws every bunker each time: 21 on Betio)
      var redraw = B.redraw, built = 0;
      B.redraw = function () {};
      try { built = this._convertAll(g, mapName, props, ctx, rep); } finally { B.redraw = redraw; }
      if (built) B.redraw(g);
      return rep;
    },
    _convertAll: function (g, mapName, props, ctx, rep) {
      var O = g.obstacles, T = g.terrain, G = GRID, B = window.Bunker118;
      var men = g.units.filter(function (u) { return u.alive && u.team > 0; });
      for (var k = 0; k < props.length; k++) {
        var p = props[k], cx = cellCenter(p.gx), cz = cellCenter(p.gz);
        // whose ground: the side with the nearest man; the other side's men give the bearing
        var dmin = {}, own = 0;
        for (var j = 0; j < men.length; j++) { var u = men[j], d = Math.hypot(u.pos.x - cx, u.pos.z - cz); if (dmin[u.team] == null || d < dmin[u.team]) dmin[u.team] = d; }
        for (var t in dmin) if (!own || dmin[t] < dmin[own]) own = +t;
        var ex = 0, ez = 0, en = 0;
        for (var j2 = 0; j2 < men.length; j2++) { var w = men[j2]; if (own && areHostile(own, w.team)) { ex += w.pos.x; ez += w.pos.z; en++; } }
        if (!own || !en) { rep.skipped.push({ gx: p.gx, gz: p.gz, type: p.type, why: 'no sides' }); continue; }
        // THE FACING: toward the ground the enemy reaches first (its approach), not its centroid — Vierville's
        // strongpoints stand on the shoulders of the draws, and the beach's centroid put the draw outside the arc
        var face = this.faceApproach(g, p.gx, p.gz, this._approach(g, own, ctx.walk));
        if (face < 0) face = this.faceToward(cx, cz, ex / en, ez / en);
        // the seat: the prop's cell, else the nearest fit one within SEAT_SEARCH
        var seat = null, why0 = this.seatWhy(g, p.gx, p.gz, face, ctx);
        if (!why0) seat = { x: p.gx, z: p.gz };
        for (var r = 1; r <= this.SEAT_SEARCH && !seat; r++) {
          for (var dz = -r; dz <= r && !seat; dz++) for (var dx = -r; dx <= r && !seat; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            var sx = p.gx + dx, sz = p.gz + dz;
            if (ctx.prop(sx, sz) && (sx !== p.gx || sz !== p.gz)) continue;   // another prop's own cell
            if (!this.seatWhy(g, sx, sz, face, ctx)) seat = { x: sx, z: sz };
          }
        }
        if (!seat) { rep.skipped.push({ gx: p.gx, gz: p.gz, type: p.type, why: why0, own: own }); continue; }
        // the old prop, and anything the earth would bury, come off
        var removed = [];
        if (O.at(p.gx, p.gz)) { O.remove(p.gx, p.gz); }
        for (var qz = -1; qz <= 1; qz++) for (var qx = -1; qx <= 1; qx++) {
          var ox = seat.x + qx, oz = seat.z + qz, ob = O.at(ox, oz);
          if (ob && !BUILDING_PROPS[ob.type]) { removed.push(ob.type); O.remove(ox, oz); }
        }
        var dh = this.grade(g, seat.x, seat.z, face, ctx);
        var kind = this.kindFor(p.type, mapName);
        var rec = B.build(g, seat.x, seat.z, kind, face);
        if (!rec) { rep.skipped.push({ gx: p.gx, gz: p.gz, type: p.type, why: 'build', own: own }); continue; }
        rec.team = own; rec.map118 = true;
        ctx.taken.push(rec);
        rep.conv.push({ gx: seat.x, gz: seat.z, from: p.type, at: [p.gx, p.gz], kind: kind, face: face, own: own,
          dOwn: +(dmin[own] / TILE).toFixed(1), dh: +dh.toFixed(2), removed: removed });
      }
      if (rep.conv.length) {
        if (T.flush) T.flush();
        if (O.refreshHeights) O.refreshHeights();
        // men standing on ground that was graded (within 2 cells of a seat) stand on it again; nobody else is touched
        for (var m = 0; m < g.units.length; m++) {
          var v = g.units[m]; if (!v.alive || (v.lvl | 0) || !g.groundYAt) continue;
          var vx = worldToCell(v.pos.x), vz = worldToCell(v.pos.z), hit = false;
          for (var c2 = 0; c2 < rep.conv.length && !hit; c2++) hit = Math.max(Math.abs(rep.conv[c2].gx - vx), Math.abs(rep.conv[c2].gz - vz)) <= 2;
          if (!hit) continue;
          v.pos.y = g.groundYAt(v.pos.x, v.pos.z, 0);
          if (v.mesh) v.mesh.position.y = v.pos.y;
        }
      }
      return rep.conv.length;
    },
    /** At deployment: the computer's sides man their bunkers from the men round them. `dryRecs` (a probe's): pick for
     *  these records and return the men WITHOUT moving anyone (the switch-off arm's would-be crews). */
    garrison: function (g, rep, dryRecs) {
      var B = window.Bunker118, G = GRID;
      var inf = {}, budget = {};
      var fit = function (u) { return u.alive && !u.downed && u.team > 0 && !u.def.vehicle && !u.def.towed && !u.embarkedIn && !u.garrison && !(u.lvl | 0); };
      for (var i = 0; i < g.units.length; i++) { var u0 = g.units[i]; if (fit(u0)) inf[u0.team] = (inf[u0.team] || 0) + 1; }
      for (var t in inf) budget[t] = Math.max(2, Math.floor(inf[t] * this.SHARE));
      if (rep) rep.budget = JSON.parse(JSON.stringify(budget));
      var dry = !!dryRecs, picked = [];
      var recs = dry ? dryRecs.slice() : B.list.filter(function (r) { return r.map118 && r.team; });
      // the bunkers with the side's men closest first, so a short budget mans the front ones
      var dOf = {}; (rep && rep.conv || []).forEach(function (c) { dOf[c.gz * G + c.gx] = c.dOwn; });
      recs.sort(function (a, b) { return (dOf[a.gz * G + a.gx] || 0) - (dOf[b.gz * G + b.gx] || 0) || a.gz - b.gz || a.gx - b.gx; });
      for (var k = 0; k < recs.length; k++) {
        var r = recs[k], T0 = r.team, K = B.KINDS[r.kind];
        if (T0 === g.playerTeam) continue;                             // never the player's side (whatever autoCommand says)
        var want = Math.min(this.GAR[r.kind] || 2, K.cap, budget[T0] || 0);
        if (want <= 0) continue;
        var cx = cellCenter(r.gx), cz = cellCenter(r.gz), R = this.R_DEF * TILE;
        var pool = [];
        for (var j = 0; j < g.units.length; j++) {
          var c = g.units[j];
          if (c.team !== T0 || !fit(c) || NO_GARRISON[c.def.kind] || c._b118Gar || c._bunker118 || (dry && picked.indexOf(c) >= 0)) continue;
          if (!c._underAI || !c._underAI()) continue;                 // never the player's men
          var d = Math.hypot(c.pos.x - cx, c.pos.z - cz);
          if (d <= R) pool.push({ u: c, d: d });
        }
        if (!pool.length) continue;
        pool.sort(function (a, b) { return a.d - b.d || a.u.id - b.u.id; });
        var picks = [], take = function (q) { picks.push(q.u); pool.splice(pool.indexOf(q), 1); };
        var MG = function (q) { return q.u.def.kind === 'hmg'; }, LMG = function (q) { return q.u.def.kind === 'lmg'; };
        var RIF = function (q) { return q.u.def.kind === 'rifle' || q.u.def.kind === 'smg'; };
        if (r.kind !== 'dugout') { var gun = pool.filter(MG)[0] || pool.filter(LMG)[0]; if (gun) take(gun); }
        while (picks.length < want) {
          var lead = picks[0], q = null;
          if (lead && lead.squad) q = pool.filter(function (e) { return RIF(e) && e.u.squad === lead.squad; })[0];
          if (!q) q = pool.filter(RIF)[0];
          if (!q) break;
          take(q);
        }
        if (!picks.length) continue;
        if (dry) { for (var pi = 0; pi < picks.length; pi++) picked.push(picks[pi]); } else this._putIn(g, r, picks);
        budget[T0] -= picks.length;
        if (rep) rep.gar.push({ gx: r.gx, gz: r.gz, team: T0, men: picks.map(function (u) { return u.def.kind; }) });
      }
      return picked;
    },
    /** Men into the cell: the first at the embrasure, the rest behind him. */
    _putIn: function (g, r, men) {
      var f = EDGE_D[r.face], sx = f[1], sz = -f[0], cx = cellCenter(r.gx), cz = cellCenter(r.gz), key = (0 * GRID + r.gz) * GRID + r.gx;
      var SLOT = [[0.32, 0], [-0.12, 0.38], [-0.12, -0.38], [-0.42, 0]];
      var face = Math.atan2(f[0], f[1]);
      for (var i = 0; i < men.length; i++) {
        var u = men[i], s = SLOT[i % SLOT.length], x = cx + f[0] * s[0] + sx * s[1], z = cz + f[1] * s[0] + sz * s[1];
        var y = g.groundYAt ? g.groundYAt(x, z, 0) : u.pos.y;
        u.pos.x = x; u.pos.z = z; u.pos.y = y; u.lvl = 0;
        if (u.anchor) { u.anchor.x = x; u.anchor.z = z; u.anchor.y = y; }
        u.path = []; u.pathIdx = 0; u.target = null; u.groundAtk = null;
        u.face = u.targetFace = face;
        if (u.mesh) { u.mesh.position.set(x, y, z); u.mesh.rotation.y = face; }
        u._strSpot = key; u._bunker118 = r; u._b118Gar = true; u._b118Slot = { x: x, z: z };
        u.hold = true; u.posture = 'defend';
        if (this.crew.indexOf(u) < 0) this.crew.push(u);
      }
    },
    /** EVERY STEP: the crew stays in. Measured on Vierville Draw (seed 7, 60 s) before this: 8 of 9 men put in at
     *  deployment had walked out — the alarm march (`hold` cleared), `_survival`'s dash to cover under incoming fire
     *  (`dugin` cleared), the leash to the section's anchor, `_chase`, `_aiObjectives`. A leg that ends outside the
     *  cell is cancelled while he is inside; a man found outside is sent back to his place. Let go: the dead, the
     *  surrendered, a bunker that is down or has lost its slab, a section that withdraws (`Game._squadTask`); a routed
     *  or broken man is left to his morale and comes back when he has rallied. Nothing here draws a random number. */
    tick: function (g, dt) {
      var C = this.crew;
      if (!C.length) return;
      var B = window.Bunker118;
      for (var i = C.length - 1; i >= 0; i--) {
        var u = C[i], r = u._bunker118;
        if (!u.alive || u.surrendered || !u._b118Gar || !r || !g.structures || !g.structures.has(r.gx, r.gz)) {
          u._b118Gar = false; if (!u.alive || u.surrendered) u._bunker118 = null;
          C.splice(i, 1); continue;
        }
        // THE SLAB IS GONE: plunging fire now reaches them whole (`Bunker118.blastCut`) and the position is a hole in
        // the ground with walls round it. The crew is let go to fight as the rest of the section does.
        var S = g.structures;
        if (S.roofM && S.li && S.roofM[S.li(r.gx, r.gz, 0)] === 0) {
          u._b118Gar = false; u._bunker118 = null; u._strSpot = null; u.hold = false;
          C.splice(i, 1); continue;
        }
        if (u.downed || u.ccState === 'routed' || u.ccState === 'broken' || u.embarkedIn) continue;
        var key = (0 * GRID + r.gz) * GRID + r.gx, inCell = worldToCell(u.pos.x) === r.gx && worldToCell(u.pos.z) === r.gz && !(u.lvl | 0);
        var p = u.path, end = p && p.length ? p[p.length - 1] : null;
        var endIn = !!end && worldToCell(end.x) === r.gx && worldToCell(end.z) === r.gz;
        if (inCell) {
          if (end && !endIn) { u.path = []; u.pathIdx = 0; if (u.state === 'advance' || u.state === 'return' || u.state === 'move') u.state = 'idle'; }
          u._strSpot = key; u.hold = true; if (u.posture !== 'prone') u.posture = 'defend';
          if (u.anchor && u._b118Slot) { u.anchor.x = u._b118Slot.x; u.anchor.z = u._b118Slot.z; }
        } else if (!endIn && u.orderMove && !((u._b118T || -1e9) > g.time)) {
          u._b118T = g.time + 2;                                   // a man who cannot be routed in is asked again in 2 s, not every step
          var sl = u._b118Slot || { x: cellCenter(r.gx), z: cellCenter(r.gz) };
          u.target = null; u.groundAtk = null;
          u.orderMove(sl.x, sl.z, false, 'fast', 0);
          u.explicit = false; u._strSpot = key; u._pendingCover = true;
          if (u._commitMove) u._commitMove(10);
        }
      }
    },
    /** A RESTART (`Game.restartBattle` loads the snapshot `loadMap` took at its end): the bunkers come back from the
     *  map record without their side or crew, so the men of the bunker's side standing in it are its crew again. Only
     *  for the map this report is of; never the player's side. */
    restore: function (g) {
      this.crew.length = 0;
      var R = this.last, B = window.Bunker118;
      if (!R || !R.conv.length || !this.on(g) || !g.mapDef || R.map !== g.mapDef.name) return 0;
      var byCell = {};
      for (var i = 0; i < R.conv.length; i++) byCell[R.conv[i].gz * GRID + R.conv[i].gx] = R.conv[i];
      for (var k = 0; k < B.list.length; k++) { var r = B.list[k], c = byCell[r.gz * GRID + r.gx]; if (c) { r.team = c.own; r.map118 = true; } }
      for (var j = 0; j < g.units.length; j++) {
        var u = g.units[j];
        if (!u.alive || u.downed || u.def.vehicle || (u.lvl | 0)) continue;
        var rb = B.at(g, u.pos.x, u.pos.z);
        if (!rb || !rb.map118 || u.team !== rb.team || rb.team === g.playerTeam) continue;
        u._strSpot = (0 * GRID + rb.gz) * GRID + rb.gx; u._bunker118 = rb; u._b118Gar = true; u._b118Slot = { x: u.pos.x, z: u.pos.z };
        u.hold = true; u.posture = 'defend';
        this.crew.push(u);
      }
      return this.crew.length;
    },
    /** The map load's hook (Game.loadMap, after `_setupVictoryPoints`, before `_prepareDefence`). */
    apply: function (g, map) {
      this.last = null; this.crew.length = 0;
      if (!this.on(g)) return null;
      var rep = this.convert(g, map && map.name);
      if (rep.conv.length) this.garrison(g, rep);
      this.last = rep;
      return rep;
    },
  };
  window.BunkerMaps118 = M;
})();
