/* (round 118) THE TRENCH KIT, laid along smooth paths — `game.trenchKit118` (default OFF; needs `trench118`).
 *
 * The owner: "can the trenches also have organic curves, gunpits that actually protect but allow fire from
 * guns out, better sandbags, better bunker structures, concrete trenches, wood trenches, dirt trenches".
 *
 * The kit (assets/trenchkit118.pack.js, built in Blender by tools/blender/trench_kit.py) is a trim sheet
 * (albedo + normal, one material) and pieces in metres: a 3 m bay, an end, a sap and a gun pit, each in
 * concrete, timber and earth, and a sandbag laid in bonded courses. This file DRAWS the map's trench cells
 * with it. The simulation keeps its cells, its `lineOf` and its occupancy: nothing here is read back.
 *
 *  - The trench cells are joined into runs: 4-neighbours, and a diagonal only where no 4-neighbour links the
 *    two (so a staircase stays a staircase and a diagonal line is one run). At a junction the two most
 *    opposite arms run through; the others end at it as BRANCHES and open a gap in the through-run's wall.
 *  - Each run is a centripetal Catmull-Rom curve THROUGH its cells' centres (organic, and still on the cells
 *    the men stand in), extended half a cell past a dead end so the end cell is dug to its edge.
 *  - Bays are bent along the curve (every vertex at its own arc length), stretched to fit the run, and every
 *    vertex sits on the ground under it. Dead ends take the end piece; a lone cell is a 6 m bay bowed a
 *    little toward its front, shut at both ends.
 *  - The fire step and parapet face the map's middle (the side toward the enemy on a two-sided map).
 *  - The geometry is merged per map sector (4 x 4) into one mesh each: one material, a handful of draws.
 *  - The old trench pieces are kept (the simulation reads their line) but not drawn while the kit is.
 */
(function () {
  'use strict';
  const S = { group: null, hidden: [], mat: null, stats: null };
  const SECT = 4, UNDER = 1.4;   // UNDER: the bounce in the cut (vertex colour, below the ground); near the eye `Canopy.near` lifts the shade

  // DEFAULT ON (round 118, 04:55 UTC 11 Nov, main's review of .claude/wip118/bunker2/trench14_0430.jpg): the berm is the
  // field with fresh earth only at the lip, the sacks read as sacks, the end mound is welded; drawn / not drawn identical
  // in seeded battles; +0.1..0.4 ms with trenches in view. It was OFF before because (main's review of the Sedan and
  // Kotelnikovo captures) the bags read as white eggs scattered
  // on the berm, the spoil ends as plank ramps with stretched streaks, and the berm as a flat slab with hard ends. The
  // sim is untouched (seeded battles identical, null control, 3 seeds x 3 maps) and it costs +0.23 ms at 2,035 men;
  // turn it on when captures at 72 m, 26 m, close up and first person read as earthworks on grass and on snow.
  const TRENCHKIT118_ON = true;
  // THE BERM UNDER THE SPOIL IS THE FIELD (round 118, the bunker agent; as the bunkers' mounds, assets/bunker118.js): a copy
  // of every spoil triangle 2 cm lower (its toe 6 cm under the field), drawn with the TERRAIN's material, its colour, its
  // twenty ground surfaces' weights (`assets/groundsplat.js`) and uv taken bilinear from the terrain under each vertex.
  // Where the spoil dissolves (the feet's noise) the field heaped up shows, so the berm ends in the field's own grass or
  // snow, not on an outline. `EARTH` false = without it. One draw a sector, no new program.
  const EARTH = true;
  function earthGeo(P, N, terr) {
    const tm = terr && terr.mesh, ta = tm && tm.geometry && tm.geometry.attributes, SPL = ['splatA', 'splatB', 'splatC', 'splatD', 'splatE'];
    if (!ta || !ta.color || !tm.material || !SPL.every(k => ta[k])) return null;
    const T = THREE, n = P.length / 3, col = new Float32Array(n * 3), uv = new Float32Array(n * 2), sp = SPL.map(() => new Uint8Array(n * 4));
    const tc = ta.color.array, sa = SPL.map(k => ta[k].array), Wt = (GRID - 1) * TILE, c0 = cellCenter(0);
    for (let v = 0; v < n; v++) {
      const x = P[v * 3], z = P[v * 3 + 2], fx = (x - c0) / TILE, fz = (z - c0) / TILE;
      const gx = Math.max(0, Math.min(GRID - 2, Math.floor(fx))), gz = Math.max(0, Math.min(GRID - 2, Math.floor(fz)));
      const ax = Math.min(1, Math.max(0, fx - gx)), az = Math.min(1, Math.max(0, fz - gz));
      const i00 = gz * GRID + gx, i10 = i00 + 1, i01 = i00 + GRID, i11 = i01 + 1, w00 = (1 - ax) * (1 - az), w10 = ax * (1 - az), w01 = (1 - ax) * az, w11 = ax * az;
      for (let q = 0; q < 3; q++) col[v * 3 + q] = tc[i00 * 3 + q] * w00 + tc[i10 * 3 + q] * w10 + tc[i01 * 3 + q] * w01 + tc[i11 * 3 + q] * w11;
      uv[v * 2] = (x - c0) / Wt; uv[v * 2 + 1] = 1 - (z - c0) / Wt;
      for (let s = 0; s < 5; s++) { const A = sa[s], O = sp[s]; for (let q = 0; q < 4; q++) O[v * 4 + q] = Math.round(A[i00 * 4 + q] * w00 + A[i10 * 4 + q] * w10 + A[i01 * 4 + q] * w01 + A[i11 * 4 + q] * w11); }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    for (let s = 0; s < 5; s++) geo.setAttribute(SPL[s], new T.BufferAttribute(sp[s], 4, true));
    geo.computeBoundingSphere();
    return geo;
  }
  // the spoil's brightness per ground (see `gmul` in build): measured on turf and snow; the others are the turf factor eased
  // (turf 0.45 drew the berm a dark ring on Sedan; 1.0 a pale one: 0.70. Sand 0.70 measured 1.08x the field.)
  // (04:18) the berm is spoil only now (no grassed band): on turf a darker loam
  const GROUND_MUL = { turf: 0.58, snow: 1.00, sand: 0.70, stone: 0.70, ash: 0.80 };
  function groundMul(pal) { return GROUND_MUL[pal] != null ? GROUND_MUL[pal] : 0.7; }
  function on(g) {
    const want = g && g.trenchKit118 != null ? !!g.trenchKit118 : TRENCHKIT118_ON;
    if (!want || !window.TRENCHKIT118 || !window.THREE) return false;
    try { return typeof trench118On !== 'function' || trench118On(); } catch (e) { return false; }
  }

  // TWO PROGRAMS: the faded feet of the berms are cut away with `discard`, and a shader that can discard loses the early
  // depth test on a tile GPU for every fragment it draws (measured: +0.70 ms with the trenches in view when all of the
  // kit drew with it, against +0.23 without). So only the feet's triangles take the discarding program (`feet`).
  function material(feet) {
    if (feet ? S.matF : S.mat) return feet ? S.matF : S.mat;
    if (!S.mat && feet) material(false);
    const K = window.TRENCHKIT118, T = THREE;
    const tex = (b64, srgb) => {
      const img = new Image(), t = new T.Texture(img);
      img.onload = () => { t.needsUpdate = true; };
      img.src = 'data:image/png;base64,' + b64;
      t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 8;
      if (srgb) t.encoding = T.sRGBEncoding;
      return t;
    };
    if (!S.tex) {
      const map = tex(K.albedo, true), nrm = tex(K.normal, false);
      S.tex = [map, nrm];
      // the kit is not shown until both sheets have decoded (a frame drawn before that is black)
      S.ready = Promise.all([map, nrm].map(t => new Promise(res => { const im = t.image; if (im.complete && im.naturalWidth) res(); else { im.addEventListener('load', res); im.addEventListener('error', res); } })))
        .then(() => { S.loaded = true; if (S.group) S.group.visible = true; });
    }
    const [map, nrm] = S.tex;
    // no emissive fill: a constant term glowed at night (measured on The Dunkirk Perimeter's dark field); the cut is lit
    // by the scene's own sky and fill, as every other prop
    const M = new T.MeshPhongMaterial({ map, normalMap: nrm, vertexColors: true, specular: 0x030303, shininess: 10 });
    M.polygonOffset = true; M.polygonOffsetFactor = -1; M.polygonOffsetUnits = -2;
    M.name = feet ? 'trenchKitFeet118' : 'trenchKit118';
    if (feet) S.matF = M; else S.mat = M;
    // THE PLACE'S GROUND. The sheet's spoil is Normandy's: fresh loam grassing over. On sand, stone, ash and snow it is
    // recoloured to the map's commonest ground (`Obstacles._spoilPal`), its texture kept (the texel's own light and
    // dark times the ground's colour), and snow lies on whatever faces up, by the canopy's own snow (`Canopy.snow`).
    S.u = S.u || { uSnowTK: (window.Canopy && Canopy.snow) || { value: 0 }, uSpoilTK: { value: new T.Color(1, 1, 1) }, uSpoilMixTK: { value: 0 },
      // (round 118) THE SKY IN THE SHADE NEAR THE EYE, as the first-person agent gave the props (assets/canopy.js `C.near`,
      // `game.fpvNear118`; .claude/wip118/near/NOTES.md): the face the sun does not reach keeps only ambient + hemisphere,
      // and the grade's toe crushes that to black (the timber of a trench wall in first person). Same uniforms, same switch.
      uNearTK: (window.Canopy && Canopy.near) || { value: 0 }, uNearSunTK: (window.Canopy && Canopy.nearSun) || { value: 1 },
      uNearSkyTK: (window.Canopy && Canopy.nearSky) || { value: [3.6, 5.0, 12.0, 36.0] } };
    M.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S.u);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vUpTK;\nattribute float fade;\nvarying float vFadeTK;\nvarying vec2 vWTK;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vUpTK = objectNormal.y;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFadeTK = fade; vWTK = (modelMatrix * vec4(transformed, 1.0)).xz;');
      // THE FOOT FEATHERS INTO THE GROUND: where `fade` falls to 0 (a berm's last metre) the surface is cut away on a
      // world-space noise, so its edge is ragged and still, not a straight outline (it was a slab with corners)
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying float vUpTK; varying float vFadeTK; varying vec2 vWTK;
uniform float uSnowTK; uniform vec3 uSpoilTK; uniform float uSpoilMixTK; uniform float uNearTK; uniform float uNearSunTK; uniform vec4 uNearSkyTK;
float hTK(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nTK(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hTK(i), hTK(i + vec2(1.0, 0.0)), f.x), mix(hTK(i + vec2(0.0, 1.0)), hTK(i + vec2(1.0, 1.0)), f.x), f.y); }`)
        .replace('void main() {', feet ? `void main() {
  if (vFadeTK < 0.999) { float n = 0.50 * nTK(vWTK * 0.6) + 0.30 * nTK(vWTK * 2.2) + 0.20 * nTK(vWTK * 6.1); if (n > vFadeTK * 1.15 - 0.08) discard; }` : 'void main() {')
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  if (uNearTK > 0.0) {   // the share of the sun this face got, against the sun's own luminance: shade below ~0.06-0.30
    vec3 lwTK = vec3(0.2126, 0.7152, 0.0722);
    float sunRTK = dot(reflectedLight.directDiffuse, lwTK) / max(dot(diffuseColor.rgb, lwTK) * uNearSunTK, 1e-5);
    float shdTK = 1.0 - smoothstep(0.06, 0.30, sunRTK);
    float nrTK = 1.0 - smoothstep(uNearSkyTK.z, uNearSkyTK.w, length(vViewPosition));
    reflectedLight.indirectDiffuse *= 1.0 + (uNearSkyTK.x - 1.0) * shdTK * nrTK * uNearTK;
  }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  { float sp = step(${(K.bands.spoil[0]).toFixed(4)}, vUv.y) * step(vUv.y, ${(K.bands.spoil[1]).toFixed(4)});
    float l = dot(diffuseColor.rgb, vec3(0.30, 0.59, 0.11));
    diffuseColor.rgb = mix(diffuseColor.rgb, l * uSpoilTK, sp * uSpoilMixTK);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.60, 0.64), smoothstep(0.45, 0.85, vUpTK) * uSnowTK * 0.8); }`);
    };
    // v6 (round 118, the bunker agent): a 5 m octave in the feet's cut, so a berm's outline wanders (main: "a clean rounded
    // rectangle at 72 m"); and the earth's sheen down (specular 0x0b -> 0x03: the bunkers' mounds read as fabric)
    M.customProgramCacheKey = () => 'trenchKit118-ground-v6' + (feet ? '-feet' : '');
    return M;
  }

  /** THE HOLE IN THE GROUND. The terrain is one height field, drawn over the cut: from any eye above the ground
   *  (the playing camera, a man standing on the fire step) it hid the ditch, the men in it and its walls. The mouth
   *  of each run is drawn twice right after the ground (`renderOrder` -2 for the ground while the kit is laid):
   *  first it marks the stencil where it is the nearest surface, then it clears the depth there to the far plane,
   *  so the ditch, its walls and the men in it, drawn next, show through the ground. Nothing is written to colour. */
  function holeMats() {
    if (S.hm) return S.hm;
    const T = THREE;
    const a = new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    a.polygonOffset = true; a.polygonOffsetFactor = -2; a.polygonOffsetUnits = -4;
    a.stencilWrite = true; a.stencilFunc = T.AlwaysStencilFunc; a.stencilRef = 1;
    a.stencilFail = T.KeepStencilOp; a.stencilZFail = T.KeepStencilOp; a.stencilZPass = T.ReplaceStencilOp;
    const b = new T.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(0.0); gl_FragDepthEXT = 1.0; }',
      extensions: { fragDepth: true }, fog: false, lights: false,
    });
    b.colorWrite = false; b.depthWrite = true; b.depthTest = true; b.depthFunc = T.AlwaysDepth;
    b.stencilWrite = true; b.stencilFunc = T.EqualStencilFunc; b.stencilRef = 1;
    b.stencilFail = T.KeepStencilOp; b.stencilZFail = T.KeepStencilOp; b.stencilZPass = T.ZeroStencilOp;
    a.name = 'trenchHoleMark118'; b.name = 'trenchHoleClear118';
    return (S.hm = [a, b]);
  }

  /** Put the old trench pieces back and take the kit out (editor, map load, sculpt). */
  function unbake() {
    if (S.terrainMesh) { S.terrainMesh.renderOrder = S.tro || 0; S.terrainMesh = null; S.tro = null; }
    if (S.group) {
      if (S.group.parent) S.group.parent.remove(S.group);
      S.group.traverse(n => { if (n.isMesh && n.geometry) n.geometry.dispose(); });
      S.group = null;
    }
    for (const h of S.hidden) { h.o._noBatch = h.nb; if (h.o.mesh) { h.o.mesh.visible = h.vis; if (h.parent && !h.o.mesh.parent) h.parent.add(h.o.mesh); } }
    S.hidden = [];
  }

  const isTrench = o => o && (o.type === 'trench' || o.type === 'trenchseg') && o.mesh;

  /** Before the props are batched: with the kit on, the old trench pieces are kept out of the batch and not drawn. */
  function prepare(obs) {
    unbake();
    if (!obs || !obs.list || !on(window.game)) return;
    // out of the scene graph, not merely hidden: the batcher's leftovers pass shows every prop it did not batch
    // (`_unpark` sets `visible`), so a hidden piece came back on top of the kit. Its transform stays (`lineOf` reads it).
    for (const o of obs.list) if (isTrench(o)) {
      S.hidden.push({ o, nb: o._noBatch, vis: o.mesh.visible, parent: o.mesh.parent });
      o._noBatch = true; o.mesh.visible = false;
      if (o.mesh.parent) o.mesh.parent.remove(o.mesh);
    }
  }

  // ---------------------------------------------------------------- the runs
  function runs(obs) {
    const cell = new Map();
    for (const o of obs.list) if (isTrench(o)) cell.set(o.gz * GRID + o.gx, o);
    const has = (x, z) => x >= 0 && z >= 0 && x < GRID && z < GRID && cell.has(z * GRID + x);
    const nb = new Map();
    for (const [k, o] of cell) {
      const x = o.gx, z = o.gz, L = [];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (has(x + dx, z + dz)) L.push((z + dz) * GRID + x + dx);
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (has(x + dx, z + dz) && !has(x + dx, z) && !has(x, z + dz)) L.push((z + dz) * GRID + x + dx);
      nb.set(k, L);
    }
    const XZ = k => [cellCenter(k % GRID), cellCenter(Math.floor(k / GRID))];
    // at a junction the two most opposite arms run through; the rest are branches that end at it
    const pair = new Map();
    for (const [k, L] of nb) {
      if (L.length < 3) continue;
      const [cx, cz] = XZ(k);
      const dirs = L.map(a => { const [ax, az] = XZ(a), l = Math.hypot(ax - cx, az - cz) || 1; return [(ax - cx) / l, (az - cz) / l]; });
      const used = new Set(), m = new Map();
      for (;;) {
        let best = -0.3, bi = -1, bj = -1;
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
          if (used.has(i) || used.has(j)) continue;
          const d = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
          if (d < best) { best = d; bi = i; bj = j; }
        }
        if (bi < 0) break;
        used.add(bi); used.add(bj); m.set(L[bi], L[bj]); m.set(L[bj], L[bi]);
      }
      pair.set(k, m);
    }
    const next = (prev, cur) => {
      const L = nb.get(cur);
      if (L.length === 2) return L[0] === prev ? L[1] : L[0];
      if (L.length >= 3) { const v = pair.get(cur).get(prev); return v == null ? null : v; }
      return null;
    };
    const seen = new Set(), ek = (a, b) => (a < b ? a + ':' + b : b + ':' + a), out = [];
    for (const [k, L] of nb) for (const b of L) {
      if (seen.has(ek(k, b))) continue;
      seen.add(ek(k, b));
      const fwd = [k, b];
      for (let p = k, c = b, g = 0; g < 1e5; g++) { const n = next(p, c); if (n == null || seen.has(ek(c, n))) break; seen.add(ek(c, n)); fwd.push(n); p = c; c = n; }
      const back = [];
      for (let p = b, c = k, g = 0; g < 1e5; g++) { const n = next(p, c); if (n == null || seen.has(ek(c, n))) break; seen.add(ek(c, n)); back.push(n); p = c; c = n; }
      out.push(back.reverse().concat(fwd));
    }
    for (const [k, L] of nb) if (!L.length) out.push([k]);
    return { cell, nb, out, XZ };
  }

  // centripetal Catmull-Rom through P (world x, z), sampled every `step`; returns arrays and the arc length at each node
  function curve(P, step) {
    const n = P.length, X = [], Z = [], nodeAt = [0];
    const get = i => i < 0 ? [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]]
                   : i >= n ? [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]] : P[i];
    const d = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-4;
    for (let i = 0; i < n - 1; i++) {
      const p0 = get(i - 1), p1 = P[i], p2 = P[i + 1], p3 = get(i + 2);
      const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
      const k = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let j = i === 0 ? 0 : 1; j <= k; j++) {
        const t = t1 + (t2 - t1) * j / k;
        const L = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
        const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
        const C = L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2);
        X.push(C[0]); Z.push(C[1]);
      }
      nodeAt.push(X.length - 1);
    }
    const Sx = [0];
    for (let i = 1; i < X.length; i++) Sx.push(Sx[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]));
    return { X, Z, S: Sx, nodeS: nodeAt.map(i => Sx[i]), len: Sx[Sx.length - 1] };
  }

  // the frame at arc length s: position, unit tangent, left normal (tz, -tx)
  function frame(C, s, out) {
    const S_ = C.S, n = S_.length;
    if (s <= 0) s = 0; if (s >= C.len) s = C.len;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S_[m] <= s) lo = m; else hi = m; }
    const f = (s - S_[lo]) / Math.max(1e-9, S_[hi] - S_[lo]);
    out.x = C.X[lo] + (C.X[hi] - C.X[lo]) * f; out.z = C.Z[lo] + (C.Z[hi] - C.Z[lo]) * f;
    const a = Math.max(0, lo - 1), b = Math.min(n - 1, hi + 1);
    let tx = C.X[b] - C.X[a], tz = C.Z[b] - C.Z[a]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    out.tx = tx; out.tz = tz; out.nx = tz; out.nz = -tx;
    return out;
  }

  // ---------------------------------------------------------------- the build
  function build(obs) {
    if (S.group) { if (S.group.parent) S.group.parent.remove(S.group); S.group.traverse(n => { if (n.isMesh && n.geometry) n.geometry.dispose(); }); S.group = null; }
    const g = window.game, K = window.TRENCHKIT118;
    if (!on(g) || !obs || !obs.list || !S.hidden.length) return null;
    const t0 = performance.now(), U = 1 / METERS_PER_UNIT, terr = obs.terrain;
    const H = (x, z) => terr && terr.heightAt ? terr.heightAt(x, z) : 0;
    const R = runs(obs);
    const revDef = typeof trenchRevDefault118 === 'function' ? trenchRevDefault118() : 'dirt';
    const REVS = ['wood', 'concrete', 'dirt'];
    const bags = K.bag, bagN = bags.ao.length;
    // sector buckets
    const B = new Map();
    const bucket = (x, z) => {
      const sx = Math.max(0, Math.min(SECT - 1, Math.floor((x + HALF) / (WORLD / SECT))));
      const sz = Math.max(0, Math.min(SECT - 1, Math.floor((z + HALF) / (WORLD / SECT))));
      const key = sz * SECT + sx;
      let b = B.get(key); if (!b) { b = { p: [], n: [], uv: [], c: [], m: [], f: [] }; b.feet = { p: [], n: [], uv: [], c: [], f: [] }; b.e = { p: [], n: [] }; B.set(key, b); }
      return b;
    };
    const st = { runs: 0, lone: 0, pieces: 0, ends: 0, bags: 0, tris: 0, gaps: 0 };
    // the field's colour under a point, against the sheet's turf (~0.20, 0.26, 0.10): only on turf maps
    const SP0 = K.bands.spoil[0], SP1 = K.bands.spoil[1];
    const tcol = terr && terr.mesh && terr.mesh.geometry && terr.mesh.geometry.attributes.color;
    // (every ground, not only turf: on snow the berm's foot stood out bright against the field's own snow at 26 m;
    // there the tint may only darken). REF: what the kit's foot is drawn as on that ground.
    const gpal = obs._spoilPal ? obs._spoilPal() : 'turf';
    const REF = { turf: [0.20, 0.26, 0.10], snow: [0.56, 0.58, 0.62], sand: [0.52, 0.45, 0.31], stone: [0.36, 0.35, 0.33], ash: [0.20, 0.19, 0.18] }[gpal] || [0.20, 0.26, 0.10];
    const hiT = gpal === 'snow' ? 1.0 : 2.2;
    // (round 118, the bunker agent) THE SPOIL MATCHED TO THE FIELD BY MEASUREMENT: on Sedan's turf the berm's foot drew 1.47x
    // (sRGB) the field beside it and the crest 1.6x — the "pale raised pillow" — because the tint matches the terrain's
    // VERTEX colour and the terrain's own shader darkens that; on Kotelnikovo's snow it drew 0.9-0.96x. A factor on the
    // spoil band's vertex colour per ground (`groundMul`, shared with the bunkers' earth), from pixel windows on the berm
    // and the field 3-6 m apart at 26 m and 72 m (.claude/wip118/bunker2/NOTES.md).
    const gmul = groundMul(gpal), footMul = gpal === 'turf' ? 0.86 : 1;   // (0.72 drew a dark olive halo on Village)
    // THE BERM IS THE FIELD (main's review 04:27: "put the spoil on the terrain's material ... fresh earth only near the
    // lip, blending out into the terrain's own grass or snow, with no visible band edge at 26 m"): under the spoil lies
    // the berm in the field's own ground (`earthGeo`); the spoil is solid only at the lip and thins out over the first
    // half of the berm (the brown band on grass and the smooth white band on snow were the edge)
    const snowy = EARTH, SPW = 0.42 * (SP1 - SP0);
    const fdOf = (FD, UV, v) => {
      const f = FD ? FD[v] : 1;
      if (!snowy) return f;
      const vv = UV[v * 2 + 1];
      if (vv <= SP0 || vv >= SP1) return f;
      const t = Math.min(1, Math.max(0, (vv - SP0) / SPW)), s = Math.min(1, Math.max(0, (t - 0.22) / 0.48));   // (0.06/0.44 left only a line behind the bags)
      const r = Math.min(f, 1 - s * s * (3 - 2 * s));
      return r >= 0.999 ? 1 : r;   // a solid triangle stands at exactly 1
    };
    const turfTint = tcol ? (x, z) => {
      const gx = Math.max(0, Math.min(GRID - 1, Math.round((x + HALF - TILE / 2) / TILE))), gz = Math.max(0, Math.min(GRID - 1, Math.round((z + HALF - TILE / 2) / TILE)));
      const a = tcol.array, i = (gz * GRID + gx) * 3;
      return [Math.min(hiT, Math.max(0.3, a[i] / REF[0])), Math.min(hiT, Math.max(0.3, a[i + 1] / REF[1])), Math.min(hiT, Math.max(0.3, a[i + 2] / REF[2]))];
    } : null;
    const fr = { x: 0, z: 0, tx: 0, tz: 0, nx: 0, nz: 0 };
    // emit one piece through a mapping fn(x, y, z) -> [wx, wy, wz] and nfn(nx, ny, nz) -> world normal
    // (`flip`: the mapping is a reflection, so each triangle is wound the other way)
    const tmpP = [0, 0, 0];
    function emit(pc, map, nmap, flip, skip, b, ushift, uk, tone) {
      const P = pc.pos, N = pc.nor, UV = pc.uv, A = pc.ao, I = pc.idx, TG = pc.tag, FD = pc.fd;
      const wp = new Float32Array(P.length), wn = new Float32Array(N.length);
      for (let v = 0; v < A.length; v++) {
        const w = map(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); wp[v * 3] = w[0]; wp[v * 3 + 1] = w[1]; wp[v * 3 + 2] = w[2];
        const q = nmap(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); wn[v * 3] = q[0]; wn[v * 3 + 1] = q[1]; wn[v * 3 + 2] = q[2];
      }
      const B0 = b;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t], c1 = flip ? I[t + 2] : I[t + 1], c2 = flip ? I[t + 1] : I[t + 2];
        const fa = fdOf(FD, UV, a), f1 = fdOf(FD, UV, c1), f2 = fdOf(FD, UV, c2);
        b = (FD || snowy) && B0.feet && (fa < 0.999 || f1 < 0.999 || f2 < 0.999) ? B0.feet : B0;   // a faded foot: the discarding program
        const gone = fa <= 0 && f1 <= 0 && f2 <= 0;   // wholly cut away by the feet's noise: not drawn at all (its earth copy is)
        if (skip && TG && skip(TG[a], TG[I[t + 1]], TG[I[t + 2]], (P[a * 3] + P[I[t + 1] * 3] + P[I[t + 2] * 3]) / 3)) continue;
        if (TG && TG[a] === 3 && TG[I[t + 1]] === 3 && TG[I[t + 2]] === 3) {   // the mouth: the hole in the ground's depth
          for (const v of [a, c1, c2]) B0.m.push(wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]);
          continue;
        }
        if (!gone) for (const v of [a, c1, c2]) {
          b.p.push(wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]); b.n.push(wn[v * 3], wn[v * 3 + 1], wn[v * 3 + 2]);
          b.uv.push(UV[v * 2] * (uk || 1) + (ushift || 0), UV[v * 2 + 1]);
          // in the cut, light comes back off the sunlit wall and the sky over the slot: the fill alone left the timber black
          const ao = A[v] * (P[v * 3 + 1] < -0.02 ? UNDER : 1);
          // on turf, the spoil grassing over toward its foot takes the field's own colour there (the terrain's vertex
          // colour, linear), so the berm does not end in an outline of another green
          const vv = UV[v * 2 + 1], tw = turfTint && vv > SP0 && vv < SP1 ? Math.min(1, Math.max(0, ((vv - SP0) / (SP1 - SP0) - 0.45) / 0.4)) : 0;   // the grassed half only
          const am = (vv > SP0 && vv < SP1 ? ao * gmul : ao) * (tone || 1);
          // …and the grassed foot a little darker again on turf (at 0.70 it drew a light green halo round the berm on Village)
          if (tw > 0) { const q = turfTint(wp[v * 3], wp[v * 3 + 2]), af = am * (1 - (1 - footMul) * tw); b.c.push(af * (1 + (q[0] - 1) * tw), af * (1 + (q[1] - 1) * tw), af * (1 + (q[2] - 1) * tw)); }
          else b.c.push(am, am, am);
          b.f.push(fdOf(FD, UV, v));
        }
        // (round 118, the bunker agent) …and the berm again UNDER the spoil, in the field's own ground (`earthGeo`): where
        // the spoil dissolves, the field heaped up shows, not the flat field through a hole (no rim on snow, no halo)
        if (EARTH && B0.e && !(fa >= 1 && f1 >= 1 && f2 >= 1)) {   // (under solid spoil the copy would never show)
          const s0 = UV[a * 2 + 1], s1 = UV[c1 * 2 + 1], s2 = UV[c2 * 2 + 1];
          if (s0 > SP0 && s0 < SP1 && s1 > SP0 && s1 < SP1 && s2 > SP0 && s2 < SP1) for (const v of [a, c1, c2]) {
            const yl = P[v * 3 + 1];
            B0.e.p.push(wp[v * 3], wp[v * 3 + 1] - (0.02 + Math.max(0, 0.06 - yl)) * U, wp[v * 3 + 2]); B0.e.n.push(wn[v * 3], wn[v * 3 + 1], wn[v * 3 + 2]);
          }
        }
        if (!gone) st.tris++;
      }
    }
    // the bags of a piece, each through the piece's own mapping (so they follow the curve and the ground)
    function emitBags(list, map, nmap, flip, skipBag, b, seed) {
      for (let i = 0; i < list.length; i++) {
        const [bx, by, bz, yaw, sc] = list[i];
        if (skipBag && skipBag(bx, bz)) continue;
        const c = Math.cos(yaw), s = Math.sin(yaw), us = ((i * 0.3711 + seed * 0.137) % 1);
        // (round 118) no two sacks alike: a tone of its own (old hessian and new, wet and dry), its ends sagging over the
        // course below and its fill a little uneven (main: "a little variation in tone and some sag")
        const h1 = ((i * 0.6180339 + seed * 0.2718 + bx * 0.37 + bz * 0.71) % 1 + 1) % 1, h2 = ((h1 * 7.31 + 0.17) % 1);
        const tone = 0.80 + 0.32 * h1, sag = 0.018 + 0.024 * h2, hs = 0.88 + 0.16 * h2;
        const lm = (x, y, z) => { const e = x / 0.31; return map(bx + (x * c + z * s) * sc, by + (y * hs - sag * e * e) * sc, bz + (-x * s + z * c) * sc); };
        const ln = (x, y, z) => nmap(x * c + z * s, y, -x * s + z * c);
        emit(bags, lm, ln, !flip, null, b, us, 0, tone);   // the bag came out of Blender with Y and Z swapped: a reflection, wound the other way
        st.bags++;
      }
    }
    // a bent piece: x (metres along the piece, 0..len0) -> arc length s0 + x * k
    function bent(C, s0, k, fs) {
      const mp = (x, y, z) => {
        frame(C, s0 + x * U * k, fr);
        const wx = fr.x + fr.nx * fs * z * U, wz = fr.z + fr.nz * fs * z * U;
        tmpP[0] = wx; tmpP[1] = H(wx, wz) + y * U; tmpP[2] = wz; return tmpP;
      };
      const np = { v: [0, 0, 0] }, lastX = { x: 0 };
      const mn = (nx, ny, nz) => { const v = np.v; v[0] = fr.tx * nx + fr.nx * fs * nz; v[1] = ny; v[2] = fr.tz * nx + fr.nz * fs * nz; return v; };
      return { mp, mn };
    }
    function rigid(ox, oz, ax, az, sx, sz) {
      const mp = (x, y, z) => { const wx = ox + ax * x * U + sx * z * U, wz = oz + az * x * U + sz * z * U; tmpP[0] = wx; tmpP[1] = H(wx, wz) + y * U; tmpP[2] = wz; return tmpP; };
      const v = [0, 0, 0];
      const mn = (nx, ny, nz) => { v[0] = ax * nx + sx * nz; v[1] = ny; v[2] = az * nx + sz * nz; return v; };
      // handedness of (a, up, s): a . (up x s) = a.x * (-s.z)... up x s = (s.z, 0, -s.x)
      const det = ax * sz * 1 * 1 - az * sx;   // a . (up x s) with up=(0,1,0): (ax, az) . (sz, -sx)
      return { mp, mn, flip: det < 0 };
    }

    for (const chain of R.out) {
      const o0 = R.cell.get(chain[0]);
      // revetment: the commonest along the run
      const cnt = { wood: 0, concrete: 0, dirt: 0 };
      for (const k of chain) { const o = R.cell.get(k); const rv = REVS.includes(o.rev) ? o.rev : revDef; cnt[rv]++; }
      const rev = REVS.reduce((a, b) => (cnt[b] > cnt[a] ? b : a), REVS[0]);
      const bay = K.pieces['bay_' + rev], endp = K.pieces['end_' + rev];
      let P, capA, capB;
      if (chain.length === 1) {
        // a lone cell: a 6 m bay along the piece's own line, bowed toward its front, shut at both ends
        const th = o0.mesh.rotation.y, ax = Math.cos(th), az = -Math.sin(th), [cx, cz] = R.XZ(chain[0]);
        let nx = az, nz = -ax; if (nx * -cx + nz * -cz < 0) { nx = -nx; nz = -nz; }
        const h = TILE * 0.5, bow = 0.35 * U;
        P = [[cx - ax * h, cz - az * h], [cx + nx * bow, cz + nz * bow], [cx + ax * h, cz + az * h]];
        capA = capB = 'cap'; st.lone++;
      } else {
        P = chain.map(k => R.XZ(k));
        const deg = k => R.nb.get(k).length;
        const ends = [chain[0], chain[chain.length - 1]], closed = ends[0] === ends[1];
        capA = closed ? 'open' : deg(ends[0]) === 1 ? 'cap' : deg(ends[0]) >= 3 ? 'branch' : 'open';
        capB = closed ? 'open' : deg(ends[1]) === 1 ? 'cap' : deg(ends[1]) >= 3 ? 'branch' : 'open';
        // dug to the edge of a dead end's cell
        const ext = (a, b) => { const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / l * TILE * 0.5, a[1] + (a[1] - b[1]) / l * TILE * 0.5]; };
        if (capA === 'cap') P.unshift(ext(P[0], P[1]));
        if (capB === 'cap') P.push(ext(P[P.length - 1], P[P.length - 2]));
      }
      const C = curve(P, 0.25 * U);
      if (C.len < 0.5 * U) continue;
      C.chain = chain; C.capA = capA; C.capB = capB; C.rev = rev; C.bay = bay; C.endp = endp;
      // the front faces the map's middle
      let snx = 0, snz = 0, mx = 0, mz = 0;
      for (let i = 0; i < C.X.length; i += 4) { frame(C, C.S[i], fr); snx += fr.nx; snz += fr.nz; mx += fr.x; mz += fr.z; }
      C.fs = (snx * -mx + snz * -mz) >= 0 ? 1 : -1;
      C.gaps = [];
      R.runsC = R.runsC || []; R.runsC.push(C);
    }
    // a branch opens a gap in the wall of the run it meets
    const through = new Map();   // node -> [C, s]
    for (const C of (R.runsC || [])) {
      if (C.chain.length < 3) continue;
      const off = C.capA === 'cap' ? 1 : 0;
      for (let i = 1; i < C.chain.length - 1; i++) if (R.nb.get(C.chain[i]).length >= 3) through.set(C.chain[i], [C, C.nodeS[i + off]]);
    }
    for (const C of (R.runsC || [])) for (const [end, k, k2] of [['A', C.chain[0], C.chain[1]], ['B', C.chain[C.chain.length - 1], C.chain[C.chain.length - 2]]]) {
      if ((end === 'A' ? C.capA : C.capB) !== 'branch' || !through.has(k)) continue;
      const [T, s] = through.get(k), [jx, jz] = R.XZ(k), [bx, bz] = R.XZ(k2);
      frame(T, s, fr);
      const side = ((bx - jx) * fr.nx + (bz - jz) * fr.nz) * T.fs > 0 ? 1 : 2;
      T.gaps.push([s - 0.62 * U, s + 0.62 * U, side]); st.gaps++;
    }
    for (const C of (R.runsC || [])) {
      st.runs++;
      const fs = C.fs, trimA = C.capA === 'branch' ? 0.45 * U : 0, trimB = C.capB === 'branch' ? 0.45 * U : 0;
      const sA = trimA, sB = C.len - trimB, Leff = sB - sA;
      if (Leff <= 0.2 * U) continue;
      const n = Math.max(1, Math.round(Leff / (3 * U))), len = Leff / n, k = len / (3 * U);
      const gaps = C.gaps;
      for (let i = 0; i < n; i++) {
        const s0 = sA + i * len;
        frame(C, s0 + len * 0.5, fr);
        const b = bucket(fr.x, fr.z);
        const m = bent(C, s0, k, fs);
        const sAt = x => s0 + x * U * k;
        const skip = gaps.length ? (t0_, t1_, t2_, xc) => {
          if (!(t0_ === t1_ && t1_ === t2_) || (t0_ !== 1 && t0_ !== 2)) return false;
          const s = sAt(xc);
          for (const gp of gaps) if (t0_ === gp[2] && s >= gp[0] && s <= gp[1]) return true;
          return false;
        } : null;
        const skipBag = gaps.length ? (bx, bz) => { const s = sAt(bx); for (const gp of gaps) if (gp[2] === 1 && bz > 0 && s >= gp[0] && s <= gp[1]) return true; return false; } : null;
        emit(C.bay, m.mp, m.mn, fs > 0, skip, b, s0 / U / K.uM, k);   // the boards run on along the run
        emitBags(C.bay.bags, m.mp, m.mn, fs > 0, skipBag, b, i + C.chain[0]);
        st.pieces++;
      }
      // the ends: the end piece's +X points into the run
      for (const [cap, s, dir] of [[C.capA, sA, 1], [C.capB, sB, -1]]) {
        if (cap !== 'cap') continue;
        frame(C, s, fr);
        const ax = fr.tx * dir, az = fr.tz * dir, sx = fr.nx * fs, sz = fr.nz * fs;
        const m = rigid(fr.x, fr.z, ax, az, sx, sz), b = bucket(fr.x, fr.z);
        emit(C.endp, m.mp, m.mn, m.flip, null, b, 0);
        emitBags(C.endp.bags, m.mp, m.mn, m.flip, null, b, 7);
        st.ends++;
      }
    }
    // one mesh a sector
    const T = THREE, grp = new T.Group(); grp.name = 'trenchKit118';
    const mat = material();
    // the spoil in the colour of the map's commonest ground (turf: as drawn), divided by the sheet's spoil luminance (~0.23)
    const GROUND = { turf: [1, 1, 1, 0], sand: [0.52, 0.45, 0.31, 0.9], stone: [0.36, 0.35, 0.33, 0.7], ash: [0.20, 0.19, 0.18, 0.8], snow: [0.56, 0.58, 0.62, 0.85] };
    const pal = obs._spoilPal ? obs._spoilPal() : 'turf', gk = GROUND[pal] || GROUND.turf;
    S.u.uSpoilTK.value.setRGB(gk[0] / 0.23, gk[1] / 0.23, gk[2] / 0.23); S.u.uSpoilMixTK.value = gk[3]; st.ground = pal;
    for (const [, b] of B) {
      if (!b.p.length) continue;
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(b.p, 3));
      geo.setAttribute('normal', new T.Float32BufferAttribute(b.n, 3));
      geo.setAttribute('uv', new T.Float32BufferAttribute(b.uv, 2));
      geo.setAttribute('color', new T.Float32BufferAttribute(b.c, 3));
      geo.setAttribute('fade', new T.Float32BufferAttribute(b.f, 1));
      geo.computeBoundingSphere(); geo.computeBoundingBox();
      const me = new T.Mesh(geo, mat);
      me.castShadow = true; me.receiveShadow = true; me.matrixAutoUpdate = false; me.updateMatrix();
      grp.add(me);
      if (b.feet && b.feet.p.length) {   // the berms' faded feet, on the discarding program
        const fg = new T.BufferGeometry(), F = b.feet;
        fg.setAttribute('position', new T.Float32BufferAttribute(F.p, 3)); fg.setAttribute('normal', new T.Float32BufferAttribute(F.n, 3));
        fg.setAttribute('uv', new T.Float32BufferAttribute(F.uv, 2)); fg.setAttribute('color', new T.Float32BufferAttribute(F.c, 3));
        fg.setAttribute('fade', new T.Float32BufferAttribute(F.f, 1)); fg.computeBoundingSphere();
        const fm = new T.Mesh(fg, material(true)); fm.castShadow = false; fm.receiveShadow = true; fm.matrixAutoUpdate = false; fm.updateMatrix();
        fm.name = 'trenchKitFeet118'; grp.add(fm); st.feetTris = (st.feetTris || 0) + F.p.length / 9;
      }
      if (b.e && b.e.p.length) {   // the berm in the field's own ground, under the spoil
        const eg = earthGeo(b.e.p, b.e.n, obs.terrain);
        if (eg) {
          const em = new T.Mesh(eg, obs.terrain.mesh.material); em.castShadow = false; em.receiveShadow = true;
          em.matrixAutoUpdate = false; em.updateMatrix(); em.name = 'trenchKitEarth118'; grp.add(em); st.earthTris = (st.earthTris || 0) + b.e.p.length / 9;
        }
      }
      if (b.m.length) {   // the mouth, twice: mark where it is the nearest thing, then clear the ground's depth there
        const hg = new T.BufferGeometry(); hg.setAttribute('position', new T.Float32BufferAttribute(b.m, 3)); hg.computeBoundingSphere();
        const [m1, m2] = holeMats();
        for (const [mm, ro] of [[m1, -1.6], [m2, -1.5]]) {
          const h = new T.Mesh(hg, mm); h.renderOrder = ro; h.castShadow = false; h.receiveShadow = false;
          h.matrixAutoUpdate = false; h.updateMatrix(); h.name = 'trenchHole118'; grp.add(h); st.holes = (st.holes || 0) + 1;
        }
      }
    }
    // the ground draws first, so the hole can be cut in its depth before anything else is drawn
    const tm = obs.terrain && obs.terrain.mesh;
    if (tm && st.holes) { if (S.tro == null) S.tro = tm.renderOrder; tm.renderOrder = -2; S.terrainMesh = tm; }
    grp.matrixAutoUpdate = false; grp.updateMatrix(); grp.visible = !!S.loaded;
    (obs.scene || (g && g.scene)).add(grp);
    S.group = grp;
    st.meshes = grp.children.length; st.ms = +(performance.now() - t0).toFixed(1);
    S.stats = st;
    return st;
  }

  // ON THE COSMETIC STREAM (`cosmeticScope`): three.js gives every new mesh, geometry, material and texture a UUID
  // from `Math.random`, so building the kit on the seeded stream shifted every seeded battle on a map with trenches
  // (measured: Sedan and Dunkirk, all three seeds). The batcher and `Obstacles.add` are wrapped the same way.
  const C = f => function () { return typeof cosmeticScope === 'function' ? cosmeticScope(f, this, arguments) : f.apply(this, arguments); };
  /** A trench cell gone (shelled out, or deleted): its piece is not put back on unbake, and the kit is redrawn at the
   *  next rebake check (`Obstacles.maybeRebake`, every 8 s), so a destroyed trench is not still drawn. */
  function lost(o) {
    const i = S.hidden.findIndex(h => h.o === o);
    if (i < 0) return;                       // not one of the kit's (a foxhole, or the kit is not laid)
    S.hidden.splice(i, 1);
    if (S.group) S.dirty = true;
  }
  function dirty() { const d = !!S.dirty; S.dirty = false; return d; }
  window.TrenchKit118 = { prepare: C(prepare), build: C(build), unbake: C(unbake), on, stats: () => S.stats, group: () => S.group, lost, dirty,
    _runs: runs, _curve: curve, ready: C(() => { material(); return S.ready; }),
    // (round 118, bunkers) the kit's material and its ground uniforms, shared by assets/bunker118.js's models
    material: C(material), uniforms: () => S.u, groundMul };
})();
