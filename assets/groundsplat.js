/* ===========================================================================
 * GROUND SPLAT — the field painted with what it is made of.
 * ---------------------------------------------------------------------------
 * The terrain was a colour per cell (1.5 units) times one grey mottle, lit per
 * VERTEX — every surface in the game is Lambert, and Lambert in three r128 has
 * no bump or normal map, so the `bumpMap` the terrain carried never did
 * anything. From any height the ground read as a soft smear, which is most of
 * what "washed out" was: the largest thing in every frame had no edges in it.
 *
 * Now each cell carries a weight for each of twelve SURFACES (grass, turned
 * soil, a dirt road, standing crop, leaf litter, sand, snow, rubble, setts,
 * gravel, rock and a second, drier grass that breaks up the first), and the
 * fragment shader blends their textures from `assets/ground.js`:
 *
 *   ALBEDO   divided by the texture's own mean, so it carries structure and
 *            relative hue and the cell colour keeps the hue of the ground —
 *            and with it every rut, stain and scorch the game paints there.
 *   HEIGHT   blends the layers: where grass meets a road the taller of the two
 *            textures wins pixel by pixel, so the edge is tufts and stones,
 *            not a gradient.
 *   NORMAL   relights the direct sun per pixel against the per-vertex answer,
 *            so a clod has a lit side and a tuft a shadow. Only the ratio is
 *            applied — the cell is exactly as bright on average as before.
 *
 * Until the textures have decoded the ground is drawn exactly as it was.
 *
 *     GroundSplat.set({ micro: 0.9, detail: 1.0, ao: 0.6 })   // live tuning
 *     GroundSplat.enabled = false; game.terrain.mesh.material.needsUpdate = true;
 * ======================================================================== */
(function (root) {
  'use strict';
  const THREE = root.THREE;
  if (!THREE) return;
  const G = {};
  // (round 113) twenty: "multiple kinds of grass multiple kinds of road
  // multiple kinds of swamp and so on" (the user) — rough grass, short pasture,
  // wet mud, peat bog, a farm track, tarmac, a pine wood's needles and ploughed
  // furrows after the first twelve. Five weights a vertex (splatA..E).
  const N = 20;
  G.LAYERS = ['grass', 'soil', 'road', 'crops', 'forest', 'sand', 'snow', 'rubble', 'cobble', 'gravel', 'rock', 'grass2',
              'grass3', 'moss', 'mud', 'bog', 'track', 'tarmac', 'needles', 'plough'];
  G.enabled = true;
  G.ready = false;
  let FLOOR_V = null;
  G.floor = 0.5;
  G.soft = 0;
  const U = {
    uGAlb: { value: null },
    uGNh: { value: null },
    uGScale: { value: new Float32Array(N).fill(1 / 3) },
    uGMean: { value: Array.from({ length: N }, () => new THREE.Vector3(0.5, 0.5, 0.5)) },
    uGSun: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
    uGMicro: { value: 0.7 },
    uGDetail: { value: 0.9 },
    uGAO: { value: 0.55 },
    // the no-tile noise's frequency, per world unit (round 106): eight steps
    // across one feature of it, so a stretch of ground keeps its offset for
    // about three tiles — set against the tiles' own scale on load (`G.K`)
    uGNoTile: { value: 0.012 },
    // HEX TILING (round 106, continued): measured, the two offsets above left
    // the ground repeating at its tile period — 0.38 correlation at 3.4 m
    // against 0.42 with no offsets at all — because a stretch keeps its offset
    // for three tiles. Each pixel now reads three samples, one for each corner
    // of the triangle of a hexagon grid in WORLD space it falls in, each corner
    // its own random offset (Mikkelsen, "Practical Real-Time Hex-Tiling",
    // JCGT 2022), and blends them by their own heights. `uGHex`: grid cells a
    // world unit; `uGTile`: 0 plain tiling, 1 the two offsets, 2 hexagons.
    uGHex: { value: 3.3 },
    uGTile: { value: 2 },
    // (round 118, `game.fpvGround118`) THE GROUND AT THE EYE. A tile of fine detail — straw, blades, grit —
    // seen at its full resolution a metre or two away is pixel-scale contrast with nothing bigger in it,
    // and the tone curve's toe multiplies it on dark ground: Hedgerow Hell standing measured 0.39 of the
    // mean in single-pixel deviation (Village's grass 0.09). Near the eye no fetch is finer than mip
    // `floor` along the footprint's MINOR axis: the strands soften, the clumps stay (r118vis s8, floor 0.5:
    // HH stand 0.39 -> 0.24 and prone 0.36 -> 0.13 with the 12-pixel structure kept, Village's crop field
    // 0.15 -> 0.05). Beyond a pixel footprint of 0.02 units — every pixel of the playing camera — it is not
    // evaluated. x the floor (0 off), y the texture's size, z `soft`: the hexagon blend's height sharpening
    // let go where the floor holds (0 by default: at floor 0.75 it was needed, and darkened more).
    // DEFAULT OFF, AND WHY: dark ground near the eye reads 10-18% darker (mip 0 is brighter than its own
    // mean: the taller sample wins the blend, and a low sun's micro relight lifts rough ground), and with
    // the grain gone the terrain's per-vertex triangles show faintly (they are there with it off, masked).
    uGFloor: { get value() { const v = FLOOR_V || (FLOOR_V = new THREE.Vector4()); const g = root.game, T = root.GROUND_TEX;
      return g && g.fpvGround118 ? v.set(G.floor, (T && T.size) || 512, G.soft, 0) : v.set(0, 512, 0, 0); } },
    // (round 113) THE LIE OF THE LAND. Every surface was one colour for as far
    // as it ran: the cell colour carries the type and the map's patch noise,
    // and from the playing camera a grass tile (~1.8 m) is a few pixels, so its
    // structure mip-averages away and a field was a flat painted green — "the
    // textures don't feel realistic" (the user). Two octaves of world-space
    // noise, ~40 m and ~140 m (`uGMacro`, per world unit), and each surface's
    // own answer to them (`uGMacLo` / `uGMacHi`, linear multipliers): grass goes
    // from lush and dark to dry and straw-yellow, soil from damp to pale, a
    // crop from green to ripe. `uGMacAmt` scales it all; 0 is the old ground.
    uGMacro: { value: new THREE.Vector3(0.1, 0.0286, 0.31) },
    uGMacAmt: { value: 1.0 },
    // (round 113) …AND STRUCTURE AT RANGE: past the distance where a tile has
    // mip-averaged to its mean, the same surface sampled at `uGFar` of its
    // scale (six times the size: a clump, a patch, a wheel-rut's worth) is
    // mixed in, `uGFarAmt` of the way — one more fetch, for far pixels only
    uGFar: { value: 0.17 },
    uGFarAmt: { value: 0.6 },
    // …per surface: a stone, a sett or a pebble drawn six times its size is a
    // giant, so a pattern of things (road, setts, gravel, rubble) takes none
    // and the organic ones (grass, crops, litter, snow) all of it
    uGFarL: { value: new Float32Array(N) },
    // (round 118, `fpvGround118`) each surface's first mip against its full size, in linear light: GL builds
    // the chain by averaging the ENCODED bytes, so a straw-on-dark-soil tile one mip down is up to a third
    // darker than its own mean (Hedgerow Hell at the eye, floored: 49 -> 31). Where the floor lifts a
    // pixel's mip, its albedo is scaled back by the ratio it lifted it through.
    uGMip1: { value: new Float32Array(N).fill(1) },
    uGMacLo: { value: [] },
    uGMacHi: { value: [] },
  };
  {
    //            lush / damp / dark          dry / pale / ripe
    const M = {
      grass:  [[0.74, 0.84, 0.74], [1.26, 1.10, 0.74]],
      soil:   [[0.76, 0.74, 0.72], [1.16, 1.12, 1.04]],
      road:   [[0.86, 0.86, 0.86], [1.12, 1.10, 1.05]],
      crops:  [[0.80, 0.92, 0.74], [1.10, 1.02, 0.82]],
      forest: [[0.80, 0.82, 0.78], [1.16, 1.07, 0.90]],
      sand:   [[0.92, 0.92, 0.90], [1.08, 1.06, 1.03]],
      snow:   [[0.95, 0.96, 1.00], [1.03, 1.03, 1.02]],
      rubble: [[0.84, 0.84, 0.84], [1.12, 1.10, 1.06]],
      cobble: [[0.88, 0.88, 0.88], [1.08, 1.07, 1.05]],
      gravel: [[0.88, 0.88, 0.88], [1.10, 1.09, 1.06]],
      rock:   [[0.85, 0.85, 0.86], [1.12, 1.10, 1.06]],
      grass2: [[0.78, 0.86, 0.76], [1.26, 1.12, 0.76]],
      grass3: [[0.78, 0.86, 0.76], [1.24, 1.12, 0.78]],
      moss:   [[0.78, 0.86, 0.78], [1.18, 1.10, 0.82]],
      mud:    [[0.74, 0.72, 0.72], [1.12, 1.08, 1.02]],
      bog:    [[0.80, 0.80, 0.80], [1.18, 1.12, 0.96]],
      track:  [[0.86, 0.85, 0.84], [1.12, 1.10, 1.04]],
      tarmac: [[0.90, 0.90, 0.90], [1.08, 1.08, 1.06]],
      needles:[[0.82, 0.80, 0.78], [1.14, 1.08, 0.96]],
      plough: [[0.80, 0.78, 0.76], [1.12, 1.10, 1.04]],
    };
    const FAR = { grass: 1, soil: 0.5, road: 0, crops: 1, forest: 1, sand: 0.6, snow: 1, rubble: 0, cobble: 0, gravel: 0, rock: 0.8, grass2: 1,
                  grass3: 0.8, moss: 0.35, mud: 0.5, bog: 0.8, track: 0, tarmac: 0, needles: 1, plough: 0 };
    for (let i = 0; i < N; i++) {
      U.uGFarL.value[i] = FAR[G.LAYERS[i]] != null ? FAR[G.LAYERS[i]] : 0;
      const m = M[G.LAYERS[i]] || [[1, 1, 1], [1, 1, 1]];
      U.uGMacLo.value.push(new THREE.Vector3(m[0][0], m[0][1], m[0][2]));
      U.uGMacHi.value.push(new THREE.Vector3(m[1][0], m[1][1], m[1][2]));
    }
  }
  G.uniforms = U;
  G.set = function (o) {
    if (o.noTile != null) U.uGNoTile.value = o.noTile;
    if (o.hex != null) U.uGHex.value = o.hex;
    // the tiling is compiled in (round 108, `G_TILE` below): a new mode is a new program
    if (o.tile != null && o.tile !== U.uGTile.value) { U.uGTile.value = o.tile; for (const m of mats) m.needsUpdate = true; }
    if (o.micro != null) U.uGMicro.value = o.micro;
    if (o.detail != null) U.uGDetail.value = o.detail;
    if (o.ao != null) U.uGAO.value = o.ao;
    if (o.macro != null) U.uGMacAmt.value = o.macro;
    if (o.far != null) U.uGFarAmt.value = o.far;
    return { micro: U.uGMicro.value, detail: U.uGDetail.value, ao: U.uGAO.value };
  };

  // ---- decoding ------------------------------------------------------------
  function decode(src, S) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = S;
        // a CPU canvas (round 113): read back from a GPU one, the forty
        // pictures took 280-520 ms to decode, from this one 65-150
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, S, S);
        res(x.getImageData(0, 0, S, S).data);
      };
      im.onerror = rej;
      im.src = src;
    });
  }
  const s2l = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  let loading = null;
  const waiters = [];
  G.whenReady = function (fn) { if (G.ready) fn(); else { waiters.push(fn); G.load(); } };
  G.load = function () {
    if (loading) return loading;
    const T = root.GROUND_TEX;
    if (!T) return (loading = Promise.resolve(false));
    const S = T.size, L = T.layers;
    const alb = new Uint8Array(S * S * 4 * N), nh = new Uint8Array(S * S * 4 * N);
    loading = Promise.all(L.map((l, k) => Promise.all([decode(l.albedo, S), decode(l.nh, S)]).then(([a, b]) => {
      const i = G.LAYERS.indexOf(l.name);
      if (i < 0) return;
      alb.set(a, i * S * S * 4); nh.set(b, i * S * S * 4);
      // The HEIGHT rides in the albedo's alpha, so the blend — which needs it
      // for every layer at every distance — costs one fetch, not two. The
      // normal is fetched only where it can still be seen (see F_ALBEDO).
      const o = i * S * S * 4;
      for (let p = 0; p < a.length; p += 4) alb[o + p + 3] = b[p + 2];
      // `G.K` (round 105): the surfaces were photographed and tiled against the
      // diorama's six-metre men — a tuft of grass the size of a dinner plate
      // beside a life-size soldier. The game sets it to the figures' factor.
      U.uGScale.value[i] = 1 / (l.scale * (G.K || 1));
      U.uGNoTile.value = 0.012 / (G.K || 1);
      // the mean in LINEAR light, which is what the shader divides by
      let r = 0, g = 0, bl = 0;
      const lut = new Float32Array(256); for (let q = 0; q < 256; q++) lut[q] = s2l(q / 255);
      for (let p = 0; p < a.length; p += 4) { r += lut[a[p]]; g += lut[a[p + 1]]; bl += lut[a[p + 2]]; }
      const n = a.length / 4;
      U.uGMean.value[i].set(r / n, g / n, bl / n);
      // (round 118) the first mip as GL will build it (2x2 averages of the encoded bytes), linearised
      {
        let m1 = 0, n1 = 0;
        const L4 = G._lut4 || (G._lut4 = Float32Array.from({ length: 1021 }, (_, q) => s2l(q / 1020)));
        const Lw = (R_, G_, B_) => 0.2126 * L4[R_] + 0.7152 * L4[G_] + 0.0722 * L4[B_];
        for (let y = 0; y + 1 < S; y += 2) for (let x = 0; x + 1 < S; x += 2) {
          const p0 = (y * S + x) * 4, p1 = p0 + 4, p2 = p0 + S * 4, p3 = p2 + 4;
          m1 += Lw(a[p0] + a[p1] + a[p2] + a[p3], a[p0 + 1] + a[p1 + 1] + a[p2 + 1] + a[p3 + 1], a[p0 + 2] + a[p1 + 2] + a[p2 + 2] + a[p3 + 2]); n1++;
        }
        const L0 = 0.2126 * r / n + 0.7152 * g / n + 0.0722 * bl / n;
        U.uGMip1.value[i] = L0 > 1e-6 ? Math.min(1, (m1 / n1) / L0) : 1;
      }
    }))).then(() => {
      const mk = (data, srgb) => {
        const t = new THREE.DataTexture2DArray(data, S, S, N);
        t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true; t.anisotropy = 8;
        t.needsUpdate = true;
        return t;
      };
      U.uGAlb.value = mk(alb, true);
      U.uGNh.value = mk(nh, false);
      G.ready = true;
      while (waiters.length) { try { waiters.shift()(); } catch (e) { console.warn('GroundSplat', e); } }
      return true;
    }).catch(e => { console.warn('GroundSplat: textures failed to decode', e); return false; });
    return loading;
  };

  // ---- the shader ------------------------------------------------------------
  const V_PARS = `
attribute vec4 splatA; attribute vec4 splatB; attribute vec4 splatC; attribute vec4 splatD; attribute vec4 splatE;
varying vec4 vGSplatA; varying vec4 vGSplatB; varying vec4 vGSplatC; varying vec4 vGSplatD; varying vec4 vGSplatE;
varying vec3 vGPos; varying vec3 vGNrm;
`;
  const V_MAIN = `
vGSplatA = splatA; vGSplatB = splatB; vGSplatC = splatC; vGSplatD = splatD; vGSplatE = splatE;
vGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGNrm = normalize(mat3(modelMatrix) * objectNormal);
`;
  const F_PARS = `
precision highp sampler2DArray;
uniform sampler2DArray uGAlb; uniform sampler2DArray uGNh;
uniform float uGScale[${N}]; uniform vec3 uGMean[${N}]; uniform float uGMip1[${N}];
uniform vec3 uGSun; uniform float uGMicro; uniform float uGDetail; uniform float uGAO; uniform float uGNoTile;
uniform float uGHex;
uniform vec4 uGFloor;
uniform vec3 uGMacro; uniform float uGMacAmt; uniform vec3 uGMacLo[${N}]; uniform vec3 uGMacHi[${N}];
uniform float uGFar; uniform float uGFarAmt; uniform float uGFarL[${N}];
varying vec4 vGSplatA; varying vec4 vGSplatB; varying vec4 vGSplatC; varying vec4 vGSplatD; varying vec4 vGSplatE;
varying vec3 vGPos; varying vec3 vGNrm;
vec2 gN2 = vec2(0.0); float gH = 0.5; float gNear = 0.0;
// NO TILE (round 106). Each surface is one periodic texture, and at true scale
// it repeats every three or four metres: from the playing camera a field was a
// wallpaper of the same tuft and the same clod, a grid you could count. The
// texture is read twice at offsets that change across the ground, chosen by a
// smooth noise in WORLD space, and the two blended where the noise steps — so
// no two stretches of ground are the same stretch (after Quilez, "texture
// repetition"). One noise per pixel serves every layer; its scale is metres.
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 gLin(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
vec2 gHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float gVNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;
  // Replaces <map_fragment>: the old grey mottle is not sampled at all.
  const F_ALBEDO = `
{
  float gw[${N}];
  gw[0] = vGSplatA.x; gw[1] = vGSplatA.y; gw[2] = vGSplatA.z; gw[3] = vGSplatA.w;
  gw[4] = vGSplatB.x; gw[5] = vGSplatB.y; gw[6] = vGSplatB.z; gw[7] = vGSplatB.w;
  gw[8] = vGSplatC.x; gw[9] = vGSplatC.y; gw[10] = vGSplatC.z; gw[11] = vGSplatC.w;
  gw[12] = vGSplatD.x; gw[13] = vGSplatD.y; gw[14] = vGSplatD.z; gw[15] = vGSplatD.w;
  gw[16] = vGSplatE.x; gw[17] = vGSplatE.y; gw[18] = vGSplatE.z; gw[19] = vGSplatE.w;
  vec3 ga = vec3(0.0); float gs = 0.0; float gh = 0.0;
  // the lie of the land (round 113): one value for the whole pixel, every
  // surface's own response to it summed with the surfaces' weights below
  float gMv = gVNoise(vGPos.xz * uGMacro.x) * 0.55 + gVNoise(vGPos.xz * uGMacro.y + 31.7) * 0.45;
  gMv = smoothstep(0.18, 0.82, gMv + (gVNoise(vGPos.xz * uGMacro.z + 7.3) - 0.5) * 0.18);
  vec3 gMac = vec3(0.0);
  // How much ground one pixel covers. Past a few texels the mip chain has
  // averaged every normal flat, so the second fetch is skipped: gNear is 1
  // close in and 0 by the time a pixel spans ~5 texels of the finest layer.
  float gPix = length(fwidth(vGPos.xz));
  gNear = clamp(1.6 - gPix * 45.0, 0.0, 1.0);
  bool gFl = uGFloor.x > 0.0 && gPix < 0.02;
  float gSoft = gFl ? (1.0 - smoothstep(0.004, 0.012, gPix)) * uGFloor.z : 0.0;
  // (round 113) how far into the range where the tile is only its mean
  float gFarW = clamp(gPix * 45.0 - 1.2, 0.0, 1.0) * uGFarAmt;
  // (round 108) THE TILING IS COMPILED IN, not chosen per pixel: with all
  // three modes in one program every pixel carried the registers of the
  // two it was not using, and the ground was a third of the GPU's frame.
  // uGTile picks the program (G_TILE); G.set({ tile }) swaps it.
#if G_TILE == 1
  // the offsets: a smooth noise over the ground, stepped into eight levels,
  // each level its own offset (uGNoTile: about three tiles a level)
  float gK = gVNoise(vGPos.xz * uGNoTile) * 0.6 + gVNoise(vGPos.xz * uGNoTile * 2.7 + 17.0) * 0.4;
  float gL = gK * 8.0, gIa = floor(gL), gF = fract(gL);
  vec2 gOa = sin(vec2(3.0, 7.0) * gIa) * 9.7, gOb = sin(vec2(3.0, 7.0) * (gIa + 1.0)) * 9.7;
#elif G_TILE == 2
  // the triangle of the hexagon grid this pixel is in: its three corners'
  // weights and offsets (Mikkelsen's TriangleGrid, skewed simplex space)
  vec2 gSt = vGPos.xz * uGHex;
  vec2 gSk = vec2(gSt.x - 0.57735027 * gSt.y, 1.15470054 * gSt.y);
  vec2 gBase = floor(gSk);
  vec3 gT = vec3(fract(gSk), 0.0); gT.z = 1.0 - gT.x - gT.y;
  float gS = step(0.0, -gT.z), gS2 = 2.0 * gS - 1.0;
  vec3 gW = vec3(-gT.z * gS2, gS - gT.y * gS2, gS - gT.x * gS2);
  vec3 gW3 = gW * gW * gW;
  vec2 gO1 = gHash2(gBase + vec2(gS, gS)) * 7.0, gO2 = gHash2(gBase + vec2(gS, 1.0 - gS)) * 7.0, gO3 = gHash2(gBase + vec2(1.0 - gS, gS)) * 7.0;
#endif
  for (int i = 0; i < ${N}; i++) {
    float w = gw[i];
    if (w > 0.01) {
      vec2 uv = vGPos.xz * uGScale[i];
      vec2 ddx = dFdx(uv), ddy = dFdy(uv);
      float gCo = 1.0;
      if (gFl) { float gLm = log2(max(min(length(ddx), length(ddy)) * uGFloor.y, 1e-6)); float gKf = exp2(max(0.0, uGFloor.x - gLm)); ddx *= gKf; ddy *= gKf;
        float gL0 = clamp(gLm, 0.0, 1.0); gCo = mix(1.0, uGMip1[i], gL0) / mix(1.0, uGMip1[i], max(gL0, min(uGFloor.x, 1.0))); }
      float li = float(i);
#if G_TILE == 2
      // three corners, each its own stretch of the texture; the taller
      // sample wins near the seams so the edge is a tuft or a stone, not a
      // blur. Summed one sample at a time and divided once — the same
      // weights as gW^3 (a + 0.15)^4 normalised, without three samples and
      // three coordinates held at once (round 108).
      vec4 c = textureGrad(uGAlb, vec3(uv + gO1, li), ddx, ddy);
      if (gFl) c.rgb = gLin(c.rgb);
      float q = c.a + 0.15; q *= q; float h1 = gW3.x * q * q; h1 = mix(h1, gW.x, gSoft);
      vec4 at = c * h1;
      c = textureGrad(uGAlb, vec3(uv + gO2, li), ddx, ddy);
      if (gFl) c.rgb = gLin(c.rgb);
      q = c.a + 0.15; q *= q; float h2 = gW3.y * q * q; h2 = mix(h2, gW.y, gSoft);
      at += c * h2;
      c = textureGrad(uGAlb, vec3(uv + gO3, li), ddx, ddy);
      if (gFl) c.rgb = gLin(c.rgb);
      q = c.a + 0.15; q *= q; float h3 = gW3.z * q * q; h3 = mix(h3, gW.z, gSoft);
      at += c * h3;
      float hI = 1.0 / max(1e-5, h1 + h2 + h3);
      at *= hI;
#elif G_TILE == 1
      vec3 uva = vec3(uv + gOa, li), uvb = vec3(uv + gOb, li);
      vec4 ca = textureGrad(uGAlb, uva, ddx, ddy), cb = textureGrad(uGAlb, uvb, ddx, ddy);
      // where the offset steps, the taller of the two shows through first
      float gm = smoothstep(0.25, 0.75, gF + (cb.a - ca.a) * 0.35);
      vec4 at = mix(ca, cb, gm);
#else
      vec4 at = textureGrad(uGAlb, vec3(uv, li), ddx, ddy);
#endif
      float gFw = gFarW * uGFarL[i];
      if (gFw > 0.0) {
        // the same surface at six times the size, turned off the near grid
        vec2 uf = mat2(0.799, -0.602, 0.602, 0.799) * uv * uGFar + vec2(0.37, 0.61);
        vec4 af = textureGrad(uGAlb, vec3(uf, li), ddx * uGFar, ddy * uGFar);
        at = mix(at, af, gFw);
      }
      // height-weighted: the taller surface wins, pixel by pixel
      float x = 0.15 + at.a, x2 = x * x;
      float b = w * x2 * x2 * x;
      vec3 a = at.rgb * (at.rgb * (at.rgb * 0.305306011 + 0.682171111) + 0.012522878);   // sRGB -> linear, fitted
#if G_TILE == 2
      if (gFl) a = at.rgb;   // (round 118) the three samples were linearised before the blend
#endif
      ga += b * a / uGMean[i] * gCo;
      gMac += b * mix(uGMacLo[i], uGMacHi[i], gMv);
      if (gNear > 0.0) {
#if G_TILE == 2
        vec2 nh = textureGrad(uGNh, vec3(uv + gO1, li), ddx, ddy).rg * h1;
        nh += textureGrad(uGNh, vec3(uv + gO2, li), ddx, ddy).rg * h2;
        nh += textureGrad(uGNh, vec3(uv + gO3, li), ddx, ddy).rg * h3;
        nh *= hI;
#elif G_TILE == 1
        vec2 nh = mix(textureGrad(uGNh, uva, ddx, ddy).rg, textureGrad(uGNh, uvb, ddx, ddy).rg, gm);
#else
        vec2 nh = textureGrad(uGNh, vec3(uv, li), ddx, ddy).rg;
#endif
        gN2 += b * (nh * 2.0 - 1.0);
      }
      gh += b * at.a;
      gs += b;
    }
  }
  if (gs > 0.0) {
    ga /= gs; gN2 /= gs; gH = gh / gs;
    diffuseColor.rgb *= mix(vec3(1.0), ga, uGDetail);
    diffuseColor.rgb *= mix(vec3(1.0), gMac / gs, uGMacAmt);
  }
}
`;
  // After Lambert's per-vertex direct light is in: relight it per pixel.
  const F_LIGHT = `
{
  vec3 nG = normalize(vGNrm);
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - nG * nG.x);
  vec3 B = cross(T, nG);
  float nz = sqrt(max(0.0, 1.0 - dot(gN2, gN2)));
  vec3 nD = normalize(T * gN2.x + B * gN2.y + nG * nz);
  float dg = max(dot(nG, uGSun), 0.0), dd = max(dot(nD, uGSun), 0.0);
  float micro = clamp(mix(1.0, dd / max(dg, 0.22), uGMicro * gNear), 0.35, 1.75);
  reflectedLight.directDiffuse *= micro;
  reflectedLight.indirectDiffuse *= mix(1.0, 0.7 + 0.6 * gH, uGAO);
}
`;
  const LIGHT_HOOK = 'reflectedLight.directDiffuse *= BRDF_Diffuse_Lambert( diffuseColor.rgb ) * getShadowMask();';

  /** Patch the terrain's material and keep the sun uniform current. */
  const mats = [];
  const tileMode = () => (U.uGTile.value > 1.5 ? 2 : U.uGTile.value > 0.5 ? 1 : 0);
  G.apply = function (mesh, sunOf) {
    const mat = mesh.material;
    if (!mat || mat.userData.groundSplat) return false;
    mat.userData.groundSplat = true;
    mats.push(mat);
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      if (!G.enabled || !G.ready) return;
      Object.assign(sh.uniforms, U);
      sh.vertexShader = V_PARS + sh.vertexShader.replace('#include <project_vertex>', V_MAIN + '#include <project_vertex>');
      if (sh.fragmentShader.indexOf(LIGHT_HOOK) < 0) { console.warn('GroundSplat: lighting hook not found'); return; }
      sh.fragmentShader = '#define G_TILE ' + tileMode() + '\n' + F_PARS + sh.fragmentShader
        .replace('#include <map_fragment>', F_ALBEDO)
        .replace(LIGHT_HOOK, LIGHT_HOOK + F_LIGHT);
    };
    // COMPOSE WITH THE GRADE'S KEY, never replace it. `Grade.refresh` wraps
    // every material's key with its version and remembers the key it wrapped
    // (`_gradePrevKey`); overwriting the key here would drop the grade's
    // version, and the next re-grade would hand the terrain a stale program.
    const had = mat._gradePrevKey !== undefined;
    const base = had ? mat._gradePrevKey : mat.customProgramCacheKey;
    const mine = function () { return (base ? base.call(this) : '') + '|groundSplat' + (G.enabled && G.ready ? 1 + 't' + tileMode() : 0); };
    if (had) {
      mat._gradePrevKey = mine;
      mat.customProgramCacheKey = function () { return mine.call(this) + '|g' + ((root.Grade && root.Grade._ver) || 0); };
    } else mat.customProgramCacheKey = mine;
    mat.needsUpdate = true;
    const prevBR = mesh.onBeforeRender;
    mesh.onBeforeRender = function () {
      if (prevBR) prevBR.apply(this, arguments);
      const s = sunOf && sunOf();
      if (s) U.uGSun.value.copy(s.position).sub(s.target.position).normalize();
    };
    return true;
  };

  // ---- which surfaces a terrain TYPE is made of --------------------------------
  // Indexed by TYPE name; anything unknown (a Forge surface) is turned soil.
  const BY_TYPE = {
    grass: 0, mud: 1, stone: 10, water: 1, sand: 5, road: 2, forest: 4, rubble: 7, snow: 6,
    swamp: 1, trench: 1, crops: 3, gravel: 9, cobble: 8, marsh: 1, ash: 1, ford: 9, ice: 6,
    // (round 113) the surfaces added to paint (TYPE_DEF), each its own ground
    roughgrass: 12, pasture: 13, drygrass: 11, heath: 12, dirttrack: 16, tarmac: 17, muddytrack: 14,
    bog: 15, wetmeadow: 13, ploughed: 19, pinefloor: 18, beach: 5,
  };
  G.layerOfType = name => (name in BY_TYPE ? BY_TYPE[name] : 1);
  root.GroundSplat = G;
})(window);
