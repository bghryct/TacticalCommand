/* ===========================================================================
 * GROUND MATCH (round 118) — the earthworks' earth stays the field under it.
 * ---------------------------------------------------------------------------
 * The trench kit's berm (assets/trenchkit118.js `earthGeo`) and the bunkers' mounds (assets/bunker118.js) are drawn
 * with the TERRAIN's own material: colour, the twenty ground surfaces' weights (`assets/groundsplat.js`, splatA..E) and
 * uv, taken bilinear from the terrain under each vertex. They were taken ONCE, when the earthwork was laid, and the
 * terrain's colour is not fixed: `Terrain.flush` re-bakes a cell's colour and surfaces whenever it is scorched, rutted,
 * stained, cratered or painted. So a berm laid on green grass stayed green after a bomb had scorched the field round it
 * to black-brown: the "bright green grass band with a ragged edge, both sides of the trench" on the dark ground of the
 * editor's crater capture (the band's inner edge is the spoil dissolving into the copy). In a battle it happened by
 * every trench under fire: nothing ever re-sampled the copy (the editor re-lays a sector a moment later, Play never).
 *
 * Now every copy is registered here; `Terrain.flush` reports the rows whose colour it re-baked (`rows`), the copies
 * over those rows are marked, and a copy in view re-samples the marked rows in its `onBeforeRender` (a budget of
 * vertices a frame, so a barrage costs a few frames of catching up, never one long frame). The same arithmetic as the
 * build: the bank always has the field's colour, scorch, ruts and surfaces. Drawing only: no `Math.random`, no new
 * three.js object, nothing the simulation reads.
 *
 *   game.groundMatch118 = false   -> the copies keep the colour of the moment they were built (the old game exactly)
 *   GroundMatch118.stats           -> copies, marks, vertices re-sampled, ms
 * ======================================================================== */
(function () {
  'use strict';
  var SPL = ['splatA', 'splatB', 'splatC', 'splatD', 'splatE'];
  var GM = window.GroundMatch118 = {
    ON: true,
    BUDGET: 1000,          // points of ground re-sampled a frame, at most (each written to its ~4 twins): ~0.2 ms
    list: [], queue: [], _frame: -1,
    stats: { added: 0, marks: 0, passes: 0, verts: 0, ms: 0, maxMs: 0 },
  };
  function on() { var g = window.game; return g && g.groundMatch118 != null ? g.groundMatch118 === true : GM.ON; }
  GM.on = on;
  function rooted(o) { while (o.parent) o = o.parent; return !!o.isScene; }

  /** Register a copy. `mesh`: drawn with the terrain's material, its geometry carrying color + splatA..E at world
   *  positions. `o.terr`: the Terrain. `o.verts`: the vertex ids to keep (default all). `o.mul` (per vertex) and `o.add`
   *  (per vertex x3): colour = field x mul + add (the bunkers' occlusion and bare-earth blend; the kit's is the field). */
  GM.add = function (mesh, o) {
    var geo = mesh && mesh.geometry, T = o && o.terr;
    if (!geo || !T || !T.mesh || !geo.attributes.color || !geo.attributes.splatA || typeof GRID === 'undefined') return null;
    var P = geo.attributes.position.array, ids = o.verts || null, m = ids ? ids.length : P.length / 3;
    var N = GRID, c0 = cellCenter(0), k, v, u;
    // ONE SAMPLE A POINT OF GROUND: the kit's copy is a triangle soup (each point ~6 times over), so the field is read
    // once for each distinct (x, z) and written to all its twins
    var key = new Map(), uOf = new Int32Array(m), UX = [], UZ = [];
    for (k = 0; k < m; k++) {
      v = ids ? ids[k] : k;
      var x = P[v * 3], z = P[v * 3 + 2], q = Math.round(x * 256) * 2097152 + Math.round(z * 256);
      u = key.get(q);
      if (u === undefined) { u = UX.length; key.set(q, u); UX.push(x); UZ.push(z); }
      uOf[k] = u;
    }
    var NU = UX.length, ust = new Int32Array(NU + 1), uvs = new Uint32Array(m);
    for (k = 0; k < m; k++) ust[uOf[k] + 1]++;
    for (u = 0; u < NU; u++) ust[u + 1] += ust[u];
    var fill = ust.slice(0, NU);
    for (k = 0; k < m; k++) uvs[fill[uOf[k]]++] = ids ? ids[k] : k;
    // …and the samples in the order of the terrain row they read (a counting sort): re-baked rows are one slice
    var row = new Int32Array(NU), rs = new Int32Array(N + 1), z0 = N, z1 = -1;
    for (u = 0; u < NU; u++) {
      var gz = Math.max(0, Math.min(N - 2, Math.floor((UZ[u] - c0) / TILE)));
      row[u] = gz; rs[gz + 1]++; if (gz < z0) z0 = gz; if (gz > z1) z1 = gz;
    }
    for (var r = 0; r < N; r++) rs[r + 1] += rs[r];
    var uord = new Uint32Array(NU), f2 = rs.slice(0, N);
    for (u = 0; u < NU; u++) uord[f2[row[u]]++] = u;
    var e = { mesh: mesh, geo: geo, T: T, ux: new Float32Array(UX), uz: new Float32Array(UZ), ust: ust, uvs: uvs, uord: uord, rs: rs,
      z0: z0, z1: z1, mul: o.mul || null, add: o.add || null, dlo: N, dhi: -1, cur: 0, end: 0, queued: false, dead: false };
    // the copies a re-lay disposed go now, not at the next scorch (an unrooted one may be a sibling of this one, still
    // being built in a group not yet in the scene: `rows` drops those)
    for (var d = GM.list.length - 1; d >= 0; d--) if (GM.list[d].dead) GM.list.splice(d, 1);
    GM.list.push(e); GM.stats.added++; GM.stats.points = (GM.stats.points || 0) + NU; GM.stats.vertsReg = (GM.stats.vertsReg || 0) + m;
    geo.addEventListener('dispose', function () { e.dead = true; });
    var prev = mesh.onBeforeRender;
    mesh.onBeforeRender = function (renderer) {
      if (prev) prev.apply(this, arguments);
      if (e.queued) GM.tick(renderer && renderer.info ? renderer.info.render.frame : -2);
    };
    return e;
  };

  /** `Terrain.flush` re-baked the colour (and surfaces) of rows lo..hi: mark the copies over them. */
  GM.rows = function (T, lo, hi) {
    var L = GM.list;
    if (!L.length || !on()) return;
    for (var i = L.length - 1; i >= 0; i--) {
      var e = L[i];
      if (e.dead || !rooted(e.mesh)) { e.dead = true; L.splice(i, 1); continue; }
      if (e.T !== T || hi < e.z0 || lo - 1 > e.z1) continue;   // a point in row gz reads rows gz and gz + 1
      e.dlo = Math.min(e.dlo, Math.max(e.z0, lo - 1)); e.dhi = Math.max(e.dhi, Math.min(e.z1, hi));
      if (!e.queued) { e.queued = true; GM.queue.push(e); }
      GM.stats.marks++;
    }
  };

  var tv = new Float64Array(3), ts = new Uint8Array(20);
  // re-sample the points uord[e.cur .. e.end) of one copy, at most `lim`; returns the points done
  function sample(e, lim) {
    var T = e.T, ta = T.mesh.geometry.attributes, tc = ta.color.array, N = GRID;
    if (tc.length !== N * N * 3) { e.dead = true; return 0; }
    var A = e.geo.attributes, C = A.color.array, c0 = cellCenter(0), mul = e.mul, add = e.add;
    var sa = [ta.splatA.array, ta.splatB.array, ta.splatC.array, ta.splatD.array, ta.splatE.array];
    var so = [A.splatA.array, A.splatB.array, A.splatC.array, A.splatD.array, A.splatE.array];
    var ux = e.ux, uz = e.uz, ust = e.ust, uvs = e.uvs, uord = e.uord, vmin = 1e9, vmax = -1, j = e.cur, stop = Math.min(e.end, e.cur + lim);
    for (; j < stop; j++) {
      var u = uord[j], fx = (ux[u] - c0) / TILE, fz = (uz[u] - c0) / TILE;
      var gx = Math.max(0, Math.min(N - 2, Math.floor(fx))), gz = Math.max(0, Math.min(N - 2, Math.floor(fz)));
      var ax = Math.min(1, Math.max(0, fx - gx)), az = Math.min(1, Math.max(0, fz - gz));
      var i00 = gz * N + gx, i10 = i00 + 1, i01 = i00 + N, i11 = i01 + 1;
      var w00 = (1 - ax) * (1 - az), w10 = ax * (1 - az), w01 = (1 - ax) * az, w11 = ax * az, q;
      for (q = 0; q < 3; q++) tv[q] = tc[i00 * 3 + q] * w00 + tc[i10 * 3 + q] * w10 + tc[i01 * 3 + q] * w01 + tc[i11 * 3 + q] * w11;
      for (var s = 0; s < 5; s++) {
        var S = sa[s];
        for (q = 0; q < 4; q++) ts[s * 4 + q] = Math.round(S[i00 * 4 + q] * w00 + S[i10 * 4 + q] * w10 + S[i01 * 4 + q] * w01 + S[i11 * 4 + q] * w11);
      }
      for (var k = ust[u], kn = ust[u + 1]; k < kn; k++) {
        var v = uvs[k], mv = mul ? mul[v] : 1;
        if (add) { C[v * 3] = tv[0] * mv + add[v * 3]; C[v * 3 + 1] = tv[1] * mv + add[v * 3 + 1]; C[v * 3 + 2] = tv[2] * mv + add[v * 3 + 2]; }
        else { C[v * 3] = tv[0] * mv; C[v * 3 + 1] = tv[1] * mv; C[v * 3 + 2] = tv[2] * mv; }
        for (var s2 = 0; s2 < 5; s2++) { var O = so[s2], b = v * 4, t4 = s2 * 4; O[b] = ts[t4]; O[b + 1] = ts[t4 + 1]; O[b + 2] = ts[t4 + 2]; O[b + 3] = ts[t4 + 3]; }
        if (v < vmin) vmin = v; if (v > vmax) vmax = v;
      }
    }
    if (vmax >= 0) {
      var up = function (a, sz) {
        var w = a.updateRange, o = vmin * sz, end = (vmax + 1) * sz;
        if (w.count !== -1) { o = Math.min(o, w.offset); end = Math.max(end, w.offset + w.count); }
        w.offset = o; w.count = end - o; a.needsUpdate = true;
      };
      up(A.color, 3); for (var s3 = 0; s3 < 5; s3++) up(A[SPL[s3]], 4);
    }
    var done = j - e.cur; e.cur = j;
    return done;
  }

  /** Once a frame (from a marked copy's onBeforeRender): re-sample the marked rows, up to BUDGET points. */
  GM.tick = function (frame) {
    if (frame === GM._frame) return;
    GM._frame = frame;
    if (!on()) return;
    var Q = GM.queue, budget = GM.BUDGET, t0 = performance.now(), n = 0;
    while (Q.length && budget > 0) {
      var e = Q[0];
      if (e.dead) { Q.shift(); e.queued = false; continue; }
      if (e.cur >= e.end) {   // a pass done (or none begun): the next, over the rows marked since
        if (e.dlo > e.dhi) { Q.shift(); e.queued = false; continue; }
        e.cur = e.rs[e.dlo]; e.end = e.rs[e.dhi + 1]; e.dlo = GRID; e.dhi = -1; GM.stats.passes++;
      }
      var d = sample(e, budget);
      budget -= Math.max(1, d); n += d;
    }
    var ms = performance.now() - t0;
    GM.stats.verts += n; GM.stats.ms += ms; if (ms > GM.stats.maxMs) GM.stats.maxMs = ms;
  };

  /** Every live copy re-sampled now, whole (tests and captures). */
  GM.syncAll = function () {
    for (var i = 0; i < GM.list.length; i++) { var e = GM.list[i]; if (e.dead) continue; e.cur = 0; e.end = e.uord.length; sample(e, 1e12); }
  };
})();
