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
  const N = 12;
  G.LAYERS = ['grass', 'soil', 'road', 'crops', 'forest', 'sand', 'snow', 'rubble', 'cobble', 'gravel', 'rock', 'grass2'];
  G.enabled = true;
  G.ready = false;
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
  };
  G.uniforms = U;
  G.set = function (o) {
    if (o.noTile != null) U.uGNoTile.value = o.noTile;
    if (o.hex != null) U.uGHex.value = o.hex;
    // the tiling is compiled in (round 108, `G_TILE` below): a new mode is a new program
    if (o.tile != null && o.tile !== U.uGTile.value) { U.uGTile.value = o.tile; for (const m of mats) m.needsUpdate = true; }
    if (o.micro != null) U.uGMicro.value = o.micro;
    if (o.detail != null) U.uGDetail.value = o.detail;
    if (o.ao != null) U.uGAO.value = o.ao;
    return { micro: U.uGMicro.value, detail: U.uGDetail.value, ao: U.uGAO.value };
  };

  // ---- decoding ------------------------------------------------------------
  function decode(src, S) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = S;
        const x = c.getContext('2d'); x.drawImage(im, 0, 0, S, S);
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
attribute vec4 splatA; attribute vec4 splatB; attribute vec4 splatC;
varying vec4 vGSplatA; varying vec4 vGSplatB; varying vec4 vGSplatC;
varying vec3 vGPos; varying vec3 vGNrm;
`;
  const V_MAIN = `
vGSplatA = splatA; vGSplatB = splatB; vGSplatC = splatC;
vGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGNrm = normalize(mat3(modelMatrix) * objectNormal);
`;
  const F_PARS = `
precision highp sampler2DArray;
uniform sampler2DArray uGAlb; uniform sampler2DArray uGNh;
uniform float uGScale[${N}]; uniform vec3 uGMean[${N}];
uniform vec3 uGSun; uniform float uGMicro; uniform float uGDetail; uniform float uGAO; uniform float uGNoTile;
uniform float uGHex;
varying vec4 vGSplatA; varying vec4 vGSplatB; varying vec4 vGSplatC;
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
  vec3 ga = vec3(0.0); float gs = 0.0; float gh = 0.0;
  // How much ground one pixel covers. Past a few texels the mip chain has
  // averaged every normal flat, so the second fetch is skipped: gNear is 1
  // close in and 0 by the time a pixel spans ~5 texels of the finest layer.
  float gPix = length(fwidth(vGPos.xz));
  gNear = clamp(1.6 - gPix * 45.0, 0.0, 1.0);
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
      float li = float(i);
#if G_TILE == 2
      // three corners, each its own stretch of the texture; the taller
      // sample wins near the seams so the edge is a tuft or a stone, not a
      // blur. Summed one sample at a time and divided once — the same
      // weights as gW^3 (a + 0.15)^4 normalised, without three samples and
      // three coordinates held at once (round 108).
      vec4 c = textureGrad(uGAlb, vec3(uv + gO1, li), ddx, ddy);
      float q = c.a + 0.15; q *= q; float h1 = gW3.x * q * q;
      vec4 at = c * h1;
      c = textureGrad(uGAlb, vec3(uv + gO2, li), ddx, ddy);
      q = c.a + 0.15; q *= q; float h2 = gW3.y * q * q;
      at += c * h2;
      c = textureGrad(uGAlb, vec3(uv + gO3, li), ddx, ddy);
      q = c.a + 0.15; q *= q; float h3 = gW3.z * q * q;
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
      // height-weighted: the taller surface wins, pixel by pixel
      float x = 0.15 + at.a, x2 = x * x;
      float b = w * x2 * x2 * x;
      vec3 a = at.rgb * (at.rgb * (at.rgb * 0.305306011 + 0.682171111) + 0.012522878);   // sRGB -> linear, fitted
      ga += b * a / uGMean[i];
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
  };
  G.layerOfType = name => (name in BY_TYPE ? BY_TYPE[name] : 1);
  root.GroundSplat = G;
})(window);
