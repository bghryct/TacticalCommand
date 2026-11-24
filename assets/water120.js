/* ===========================================================================
 * WATER YOU CAN READ (round 120) — `game.water120`, default OFF.
 * ---------------------------------------------------------------------------
 * The water was a translucent plane at 82% opacity, tinted by depth at its
 * vertices (assets: `Terrain._updateWaterColors`), with four octaves of value
 * noise for ripples, a gradient for the sky and a sun glint (round 106,
 * `waterSurfaceMaterial`). From the playing camera that is a flat blue-green
 * sheet laid on the map: no bed under the shallows, no shoreline (the plane
 * simply goes under the bank), the same sky on a river as on the sea, nothing
 * of the banks in it, and a river that stands as still as a pond.
 *
 * This file is the picture of the same water, and only the picture:
 *
 *   DEPTH       The bed under every vertex is the terrain's own height. The
 *               water plane and the ground are the SAME grid with the SAME
 *               triangles (both PlaneGeometry(GRID-1) with a vertex on every
 *               cell centre), so the depth interpolated across a triangle is
 *               exact and crosses zero precisely on the drawn shoreline. Light
 *               is swallowed along the path down to the bed and back up
 *               (exp(-k path), k per metre by theatre: a turbid Normandy river
 *               loses the bed in a metre, Betio's lagoon in ten), so the
 *               shallows show their bed and the deep water its own colour.
 *   SURFACE     Fresnel (Schlick, n = 1.33). The normal is a procedural
 *               ripple tile (made here once, tileable by integer wave
 *               vectors) read three ways: wind waves running downwind,
 *               catspaws across them, and on a river a two-phase flow layer
 *               carried DOWNSTREAM along the river's own course (a geodesic
 *               from one end of the body to the other, smoothed, fastest in
 *               mid-channel). Ponds, floods and the sea do not flow. Rain
 *               rings when it rains; chop and swell with the wind.
 *   REFLECTION  The sky as the sky117 dome draws it — its scattering table and
 *               its drifting clouds — evaluated along the reflected ray, and
 *               the banks: a short march along the same ray through a skyline
 *               map of the field (the bank, the houses, and the crowns of trees
 *               and hedges as a top and a bottom, so the sky shows under a
 *               crown). Lit as faces turned to the water, toned with the
 *               game's own grade, fogged by the extra distance. The sun's glint.
 *   BANKS       A broken foam line where water meets land (the surf rolls in on
 *               a beach), and the ground patched: wet and darker in a band above
 *               the waterline, silt (sand on a beach) under it.
 *   SPLASH      (cosmetic) a white column where a round bursts in the water and
 *               rings where men and vehicles wade.
 *
 * The composite is done after the encode, in display space: the dome is
 * display-referred, so the reflection is the sky exactly as it is on screen.
 * The body (scattered light) keeps the game's Lambert lights, cloud shade,
 * tone curve and grade; foam and the banks are lit from the same light and
 * pushed through the same `toneMapping()` and `linearToOutputTexel()`.
 *
 * OFF is today's program byte for byte: the material's key gains `|w120` only
 * while ON, and nothing is injected while OFF. The uniforms go in either way
 * (three r128 keeps ONE uniform set per material, the last BUILT program's;
 * see weather119.js).
 *
 * Determinism: nothing here reads the simulation's random stream or writes what
 * the simulation reads. The ripple tile is made from a private hash; every
 * three.js object is made in `cosmeticScope`; it all runs from `Game._loop`.
 *
 *   game.water120 = true          // the switch
 *   game.wt120.stats()            // the bodies of water, their kinds, the cost knobs
 * ======================================================================== */
(function (root) {
  'use strict';
  const THREE = root.THREE;
  if (!THREE) return;
  const W = { ver: 1, on: false, dirty: true, fails: 0, groundOn: false, groundV2: true, groundLod: false, marchLod: false, fordOwn: true,
    // (WATER-3) the tier: 'auto' = the LITE program unless the water is seen up close (first person, a camera low over it);
    // true / false force it (probe arms). The wet band is drawn by the overlay (the ground's own program stays OFF's).
    lite: 'auto', liteNow: false, liteHi: 9.0, liteLo: 7.0, groundOverlay: true };

  // ---------------------------------------------------------------- knobs
  W.K = {
    fordDepth: 0.09,      // u: the water over a ford's bed (36 cm)
    ripple: 128,          // the ripple tile, texels a side (256 took 280 ms to make)
    tileA: 7.0,           // metres the wind-wave tile spans (waves 0.3-2.3 m)
    tileB: 2.2,           // the catspaw tile
    tileF: 3.4,           // the flow tile
    flowCycle: 1.7,       // seconds one flow phase lasts before it is faded out
    riverV: 0.85,         // m/s in mid-channel
    canalV: 0.10,
    streamV: 0.55,        // a channel two cells wide or less
    band: 0.085,          // u: the wet band above the waterline (34 cm)
    bandSea: 0.20,        // …on a beach, where the swash runs up
    foam: 1.0,
    skyDelay: 0.4,        // s after a build before the skyline is read (the props are in by then)
    skyAgain: 6.0,        // …and once more, for anything placed late
  };

  // the water's own colour (the light it scatters back, as the game's albedos are: sRGB values used as linear) and how
  // fast it swallows light (per metre). Physical albedos read as ink here: Arnhem's river came out (36, 44, 54) at 2.6x less.
  const BODY = {
    river:   { c: [0.095, 0.125, 0.080], k: 1.15 },   // the Orne, the Rhine, the Waal: turbid olive
    east:    { c: [0.086, 0.094, 0.062], k: 1.40 },   // the Dnieper's tributaries, brown
    italy:   { c: [0.073, 0.120, 0.088], k: 0.90 },   // the Rapido, the Sangro: green
    winter:  { c: [0.052, 0.068, 0.075], k: 1.10 },
    flood:   { c: [0.100, 0.105, 0.075], k: 1.60 },   // a flooded meadow: silt and drowned grass
    channel: { c: [0.075, 0.150, 0.150], k: 0.32 },   // the Channel, grey-green
    med:     { c: [0.045, 0.125, 0.190], k: 0.14 },   // Salerno, the desert coast
    pacific: { c: [0.050, 0.200, 0.215], k: 0.07 },   // Betio's lagoon over coral sand
  };
  W.BODY = BODY;
  const TINT = { river: [0.05, 0.02, 0.14], east: [0.04, 0.03, 0.16], italy: [0.10, 0.02, 0.08], winter: [0.06, 0.03, 0.06], flood: [0.03, 0.03, 0.12],
    channel: [0.20, 0.03, 0.05], med: [0.22, 0.04, 0.01], pacific: [0.26, 0.02, 0.01] };
  // the bed under the water (the ground patch), linear albedo
  const SILT = [0.16, 0.135, 0.095], SAND = [0.42, 0.37, 0.27], MEADOW = [0.11, 0.115, 0.06];
  // whose water is the sea (the largest body on the map's edge), and whose narrow water a canal
  const SEA_RE = /Vierville|Pointe du Hoc|Salerno|Dunkirk|Betio|Omaha|Utah|Gold Beach|Juno|Sword|Anzio|Tarawa|Dieppe|Tobruk|Sicily|Gela|Leyte|Saipan|Peleliu|Iwo Jima|Okinawa/;
  const CANAL_RE = /Son Bridge|Pegasus|Dunkirk|Mons|Nijmegen Road|Albert Canal|Antwerp/;
  const LEAF = new Set(['tree', 'oak', 'pine', 'deadtree', 'hedge', 'bush', 'shrub', 'scrub', 'poplar', 'orchard', 'conifer', 'palm', 'birch', 'willow', 'copse', 'bramble']);

  // ---------------------------------------------------------------- uniforms (shared by every program that draws water)
  const v4 = (a, b, c, d) => new THREE.Vector4(a || 0, b || 0, c || 0, d || 0);
  const col = (r, g, b) => new THREE.Color(r, g, b);
  const U = W.U = {
    uW120Ripple: { value: null },
    uW120Map: { value: null },
    uW120Shore: { value: null },
    uW120Lut: { value: null },
    uW120Noise: { value: null },
    uW120Grid: { value: v4(168, 1 / 336, -13.5, 0) },     // half the field, 1 / the field, the water level, the skyline's scale (u)
    uW120Wind: { value: v4(1, 0, 2, 0.3) },               // wind dir xz, m/s, chop 0..1
    uW120Rain: { value: v4(0, 0, 1, 0) },                 // rain 0..1, -, the sun's share (cloud, night), the dome on
    uW120BodyR: { value: col(0.034, 0.044, 0.028) },
    uW120BodyS: { value: col(0.020, 0.043, 0.046) },
    uW120Abs: { value: v4(1.15, 0.32, 1, 0) },            // k river, k sea (per metre), foam, -
    uW120SunC: { value: col(1.9, 1.75, 1.5) },            // the sun's light, linear
    uW120Amb: { value: col(0.55, 0.6, 0.7) },             // the light on a wall besides the sun, linear
    uW120Ground: { value: col(0.12, 0.13, 0.07) },        // albedos in the reflection: the bank, a house, a crown
    uW120House: { value: col(0.42, 0.39, 0.33) },
    uW120Leaf: { value: col(0.07, 0.10, 0.045) },
    uW120Cloud: { value: v4(0.6, 0.16, 0, 0) },           // the dome's uCloud, uDrift, uTone, uHaze, its fog, cloud light, sky fill, sun bearing
    uW120Drift: { value: v4(0, 0, 0, 0) },
    uW120Tone: { value: v4(2, 1, 0, 0) },
    uW120Haze: { value: v4(0.06, 0, 1, 0.5) },
    uW120Fog: { value: col(0.6, 0.65, 0.7) },
    uW120SkySun: { value: new THREE.Vector3(1, 1, 1) },
    uW120SkyAmb: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uW120SunH: { value: new THREE.Vector2(0, 1) },
    uW120Ring: { value: [v4(), v4(), v4(), v4(), v4(), v4(), v4(), v4()] },   // x, z (world), start (water time), strength
    uW120RingN: { value: 0 },
    uW120T: { value: 0 },                                  // the water's own clock (s)
    uW120March: { value: v4(10, 1.8, 200, 0.045) },          // (WATER-2) the bank march: steps, growth, no march past this eye distance (u; the mix is 0 there), the Fresnel gate
    uW120Look: { value: v4(0.35, 0.6, 0.06, 1) },             // (WATER-3) w: a ford reflects the clouds' mean
    uW120Calm: { value: v4(0.3, 1, 1, 0.45) },             // (WATER-2) x the banks' ray tilt, y the shore line by waves/current + bank softened by roughness, z sheltered + finer ripples, w the flow's stretch (1, 0, 0, 1 = the 18:18 look)
    uW120SkyMean: { value: new THREE.Vector3(0.3, 0.15, 0.3) },  // (WATER-2) the clouds' mean cover, thickness, high cloud: the sky where the Fresnel is under uW120Look.z              // (WATER-2) x a ford's absorption x this (a clear stream), y the banks' sun from above in their reflection
    uW120Dbg: { value: v4(1, 1, 1, 1) },                   // (cost probes) x the bank march, y the dome's sky, z the glint, w the flow
    uW120Fix: { value: v4(1, 2.5, 0, 0.4) },                 // (WATER-4) x the skirt drawn as the level it hangs from (0 = as before), y the ripples' facets on the body (0 = none), z the sky's fog early-out (1 = on; OFF by default: w4 t1 measured no saving), w the surf's strength (WATER-3: 0.75)
    uW120Skip: { value: v4(1, 0, 0.12, 0.72) },               // (WATER-3) x the march's empty-space skip on, y a ford's march steps, z the river's shelf from a ford (m a m), w a ford's wet bed (its light through the water)
    // the ground
    uW120Bank: { value: v4(0, -13.5, 0.085, 0.20) },      // on, the water level, the wet band (u), the band on a beach
    uW120Silt: { value: col(SILT[0], SILT[1], SILT[2]) },
    uW120Sand: { value: col(SAND[0], SAND[1], SAND[2]) },
    uW120Meadow: { value: col(MEADOW[0], MEADOW[1], MEADOW[2]) },
    uW120TintR: { value: new THREE.Vector3(0.05, 0.02, 0.14) },   // the bed's extra absorption per metre (river / sea)
    uW120TintS: { value: new THREE.Vector3(0.20, 0.03, 0.05) },
    uW120Abs2: { value: v4(1.15, 0.32, 0, 0) },                    // the grey k again, for the ground
    uW120Eye: { value: new THREE.Vector3() },
  };

  // ---------------------------------------------------------------- GLSL: the water plane
  const K = W.K;
  const f1 = x => (Math.round(x * 1000) / 1000).toFixed(3);
  const V_PARS = `
attribute vec4 aW120;
attribute float aW120S;
attribute float aW120F;
attribute vec2 aW120X;
attribute vec4 aW120E;
varying vec2 vW120X;
varying vec4 vW120E;
varying vec4 vW120;
varying float vW120S;
varying float vW120Fd;
uniform vec4 uW120Wind;
`;
  // after the swell: still water rocks less than the sea, and more in a wind
  const V_SWELL = `
  if (transformed.y > -1.0) {
    transformed.y *= aW120F != 0.0 ? 0.12 : mix(0.35, 2.2, aW120.w) * (0.55 + 0.9 * uW120Wind.w);
    transformed.y += aW120F;   // a ford's own surface, over its bed (0 on the river)
  }`;
  const V_MAIN = `
  vW120 = vec4(vWaterW.y - aW120.x, aW120.y, aW120.z, aW120.w);
  vW120S = aW120S;
  vW120Fd = aW120F != 0.0 ? 1.0 : 0.0;
  vW120X = aW120X;
  vW120E = aW120E;`;

  const F_PARS = `
varying vec4 vW120;
varying float vW120S;
varying float vW120Fd;
varying vec2 vW120X;
varying vec4 vW120E;
uniform vec4 uW120Skip;
uniform vec4 uW120Look;
uniform vec4 uW120Calm;
uniform vec3 uW120SkyMean;
uniform sampler2D uW120Ripple;
uniform sampler2D uW120Map;
uniform sampler2D uW120Lut;
uniform sampler2D uW120Noise;
uniform vec4 uW120Grid;
uniform vec4 uW120Wind;
uniform vec4 uW120Rain;
uniform vec3 uW120BodyR;
uniform vec3 uW120BodyS;
uniform vec4 uW120Abs;
uniform vec3 uW120SunC;
uniform vec3 uW120Amb;
uniform vec3 uW120Ground;
uniform vec3 uW120House;
uniform vec3 uW120Leaf;
uniform vec4 uW120Cloud;
uniform vec4 uW120Drift;
uniform vec4 uW120Tone;
uniform vec4 uW120Haze;
uniform vec3 uW120Fog;
uniform vec3 uW120SkySun;
uniform vec3 uW120SkyAmb;
uniform vec2 uW120SunH;
uniform vec4 uW120Ring[8];
uniform float uW120RingN;
uniform float uW120T;
uniform vec4 uW120Dbg;
uniform vec4 uW120March;
uniform vec4 uW120Fix;
vec3 w120Alb;
vec3 w120Lin;
float w120Hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float w120VN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(w120Hash(i), w120Hash(i + vec2(1.0, 0.0)), f.x), mix(w120Hash(i + vec2(0.0, 1.0)), w120Hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// linear light to what the screen shows: the game's own tone curve and grade, and the encode
vec3 w120Disp(vec3 c) {
#if defined( TONE_MAPPING )
  c = toneMapping(c);
#endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
// THE SKY ALONG d, as the sky117 dome draws it (display space). b: a mip bias, the cloud blurred on rough water.
vec3 w120Sky(vec3 d, float b, float fr) {
  float y = max(d.y, 0.0);
  if (uW120Rain.w < 0.5 || uW120Dbg.y < 0.5) return mix(uW120Fog, uW120Fog * vec3(0.55, 0.68, 0.92), pow(y, 0.6));
  vec2 pp = d.xz / (y + 0.09);
#ifndef W120_LITE
  float gb = exp2(b);
  vec2 ppx = dFdx(pp) * gb, ppy = dFdy(pp) * gb;
#endif
  // (WATER-4) A GRAZING RAY (the far water) sees the haze and nothing else: the dome's own fog weight is ~1 there, so the
  // LUT, the clouds and the tone are skipped (the same colour to 0.5%). The derivatives above are taken before this branch.
  float fogW = max(uW120Haze.y, 1.0 - smoothstep(0.0, uW120Haze.x, y));
  if (uW120Fix.z > 0.5 && fogW > 0.995) return clamp(uW120Fog, 0.0, 1.0);
  vec2 hd = d.xz * inversesqrt(max(dot(d.xz, d.xz), 1e-6));
  vec2 luv = vec2(0.5 - 0.5 * dot(hd, uW120SunH), sqrt(y)) * (31.0 / 32.0) + 0.5 / 32.0;
  vec3 tab = textureLod(uW120Lut, luv, 0.0).rgb;
  vec3 sc = tab * tab * (uW120Haze.z * uW120Tone.x);
  // (WATER-2) where the Fresnel is under uW120Look.z the sky is a few per cent of what the eye gets back: the clouds' MEAN
  // (uW120SkyMean, from the dome's own noise histogram) stands in for their pattern and the two noise reads are skipped.
  // The reads take explicit gradients (taken before the branch), so the compiler has no reason to hoist them out of it.
  float cia, ca, thick;
#ifndef W120_LITE
  if (fr >= uW120Look.z) {
    float ci = textureGrad(uW120Noise, pp * 0.021 + uW120Drift.zw, ppx * 0.021, ppy * 0.021).b;
    cia = smoothstep(0.42, 0.88, ci) * uW120Cloud.w * smoothstep(0.03, 0.3, y);
    float shp = textureGrad(uW120Noise, pp * 0.22 + uW120Drift.xy, ppx * 0.22, ppy * 0.22).r;
    ca = smoothstep(uW120Cloud.x, uW120Cloud.x + uW120Cloud.y, shp);
    thick = smoothstep(uW120Haze.w, uW120Haze.w + 0.5, shp);
  } else
#endif
  {
    cia = uW120SkyMean.z * uW120Cloud.w * smoothstep(0.03, 0.3, y);
    ca = uW120SkyMean.x; thick = uW120SkyMean.y;
  }
  sc = mix(sc, uW120SkySun * 0.75 + uW120SkyAmb, cia * 0.55);
  vec3 cl = uW120SkySun * (0.62 * (1.0 - 0.6 * thick)) + uW120SkyAmb * (1.0 - 0.42 * thick) * mix(1.0, 0.78 + 0.4 * y, uW120Cloud.z);
  float ap = mix(0.3 + 0.7 * smoothstep(0.0, 0.25, y), 1.0, uW120Cloud.z);
  sc = mix(sc, cl, ca * ap);
  vec3 c = sqrt(1.0 - exp(-sc));
  c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 1.18) * uW120Tone.y;
  c += uW120Tone.z * vec3(0.045, 0.070, 0.140) * (1.0 - ca * 0.55);
  c += uW120Tone.w * vec3(0.55, 0.6, 0.75) * (0.35 + 0.65 * ca);
  c = mix(c, uW120Fog, fogW);
  return clamp(c, 0.0, 1.0);
}
// is the point at height y (over the water level) at q inside something? m = the skyline texel x its scale
float w120In(float y, vec4 m) { return ((m.r > 0.02 && y < m.r) || (y < m.g && y > m.b)) ? 1.0 : 0.0; }
// THE BANKS IN THE WATER: march the reflected ray through the skyline map (rgb display, a coverage)
vec4 w120Bank(vec3 wp, vec3 r, float jit) {
#ifdef W120_LITE
  return vec4(0.0);
#else
  float hs = uW120Grid.w;
  float rh = length(r.xz);
  if (hs <= 0.0 || rh < 1e-3 || uW120Dbg.x < 0.5) return vec4(0.0);
  vec2 dir = r.xz / rh;
  float sl = r.y / rh;
  float base = max(wp.y - uW120Grid.z, 0.0) + 0.01;
  float tMax = min((hs - base) / max(sl, 1e-4), 110.0);
  // (WATER-3) EMPTY SPACE: nothing a ray could meet stands within vW120X.x (u) of this pixel (from the skyline, less a
  // margin for the filter and the interpolation): the march starts there. A ford's bank is a few paces off: fewer steps.
  // (WATER-3) …and along this ray's own way: a ray moving +x never leaves the half-plane ahead of it on x (so for -x, +z, -z):
  // the larger of its two half-planes' clear distances (vW120E: +x, -x, +z, -z) is a safe start
  float sk = max(vW120X.x, max(dir.x >= 0.0 ? vW120E.x : vW120E.y, dir.y >= 0.0 ? vW120E.z : vW120E.w));
  float t = max(0.3 * jit, sk * uW120Skip.x), tp = t, hitT = -1.0;
  float nSt = vW120Fd > 0.5 ? min(uW120March.x, uW120Skip.y) : uW120March.x;
  vec4 m = vec4(0.0);
  for (int i = 0; i < 15; i++) {
    if (t > tMax || float(i) >= nSt) break;
    m = W120_MAP((wp.xz + dir * t + uW120Grid.x) * uW120Grid.y) * hs;
    if (w120In(base + sl * t, m) > 0.5) { hitT = t; break; }
    tp = t; t = t * uW120March.y + 0.25;
  }
  if (hitT < 0.0) return vec4(0.0);
  for (int k = 0; k < 2; k++) {
    float tm = 0.5 * (tp + hitT);
    vec4 mm = W120_MAP((wp.xz + dir * tm + uW120Grid.x) * uW120Grid.y) * hs;
    if (w120In(base + sl * tm, mm) > 0.5) { hitT = tm; m = mm; } else tp = tm;
  }
  float yh = base + sl * hitT;
  float leaf = yh < m.r ? 0.0 : 1.0;
  float hsh = clamp(m.a / hs, 0.0, 1.0);   // a house; over the water, a bridge's deck
  vec3 alb = leaf > 0.5 ? mix(uW120Leaf, uW120House * 0.75, hsh) : mix(uW120Ground, uW120House, hsh);
  // lit as a face turned back to the water: the sun on it, the sky's fill, darker toward its foot
  vec2 sxz = uWaterSun.xz;
  float facing = max(0.0, -dot(dir, sxz));
  float up = leaf > 0.5 ? clamp((yh - m.b) / max(m.g - m.b, 0.05), 0.0, 1.0) : clamp(yh / max(m.r, 0.05), 0.0, 1.0);
  // (WATER-2) a bank's top and its grass take the sun from above too: lit only as a face turned to the water, a bank with the
  // sun behind it was mirrored near black (the first-person stream's dark blotches)
  float sunUp = max(normalize(uWaterSun).y, 0.0) * uW120Look.y;
  vec3 c = w120Disp(alb * (uW120Amb * (0.55 + 0.45 * up) + uW120SunC * max(facing * 0.85, sunUp) * uW120Rain.z));
#ifdef USE_FOG
#ifdef FOG_EXP2
  float fd = fogDensity * hitT;
  c = mix(c, fogColor, 1.0 - exp(-fd * fd));
#endif
#endif
  return vec4(c, 1.0 - smoothstep(45.0, 100.0, hitT));
#endif
}
// RAIN: a jittered grid of drops, each a ring running out and fading (two grids, metres)
vec2 w120Rings(vec2 pm, float I, float t) {
  vec2 s = vec2(0.0);
  for (int l = 0; l < 1; l++) {
    float cs = 0.42;
    vec2 q = pm / cs + float(l) * 17.3;
    vec2 c = floor(q), f = fract(q);
    float h = w120Hash(c + float(l) * 41.0);
    if (h > I * 0.85 + 0.1) continue;
    float life = fract(t * (0.9 + 0.5 * h) + h * 7.31);
    vec2 o = vec2(w120Hash(c + 3.7), w120Hash(c + 9.1)) * 0.5 + 0.25;
    vec2 d = f - o;
    float r = length(d), wv = (r - life * 0.42) * 26.0;
    float ring = sin(wv * 3.14159) * exp(-wv * wv * 0.35) * (1.0 - life) * (1.0 - life);
    s += d / max(r, 1e-3) * ring;
  }
  return s * 0.45;
}
// THE SURFACE'S SLOPE (per metre) at pm (metres); px = metres under one pixel; rough = what the pixel cannot resolve
vec2 w120Slope(vec2 pm, float px, out float rough) {
  float t = uW120T;
  vec2 wd = uW120Wind.xy;
  float ex = vW120.w;
  float grip = (0.35 + 0.65 * uW120Wind.w) * (0.45 + 0.75 * ex);
  vec2 pw = vec2(dot(pm, wd), dot(pm, vec2(-wd.y, wd.x)));            // into the wind's frame
  float fa = 1.0 - smoothstep(0.03, 0.16, px), fb = 1.0 - smoothstep(0.008, 0.05, px);
  // (WATER-2) far water: the wind-wave read only where its weight is not 0 (past 16 cm a pixel it is: the same picture)
  vec4 ta = fa > 0.0 ? texture2D(uW120Ripple, pw / ${f1(K.tileA)} - vec2(t * (0.06 + 0.05 * uW120Wind.w), 0.0)) : vec4(0.5);
  // (WATER-2) the catspaws only where a pixel can show them (their weight is 0 past 5 cm a pixel: the same picture)
#ifdef W120_LITE
  vec4 tb = vec4(0.5);
#else
  vec4 tb = fb > 0.0 ? texture2D(uW120Ripple, mat2(0.80, 0.60, -0.60, 0.80) * pw / ${f1(K.tileB)} - vec2(t * 0.19, t * 0.05)) : vec4(0.5);
#endif
  // (WATER-2) sheltered water (a stream, a ditch) carries smaller wind waves, and a finer octave runs over both: ripples,
  // not blobs (uW120Calm.z: 0 = the 18:18 surface)
  float shel = mix(1.0, mix(0.4, 1.0, ex), uW120Calm.z);
  vec2 sa = (ta.rg * 2.0 - 1.0) * 0.55 * fa * shel;
  sa = vec2(sa.x * wd.x - sa.y * wd.y, sa.x * wd.y + sa.y * wd.x);   // back to the world
  float fc = (1.0 - smoothstep(0.004, 0.02, px)) * uW120Calm.z;
#ifdef W120_LITE
  vec2 sc = vec2(0.0);
#else
  vec2 sc = fc > 0.0 ? (texture2D(uW120Ripple, mat2(0.31, -0.95, 0.95, 0.31) * pw / ${f1(K.tileB * 0.43)} + vec2(t * 0.11, -t * 0.23)).ba * 2.0 - 1.0) * 0.16 * fc : vec2(0.0);
#endif
  vec2 s = (sa + (tb.ba * 2.0 - 1.0) * 0.30 * fb + sc) * grip;
  rough = (1.0 - fa) * 0.6 + (1.0 - fb) * 0.4;
#ifndef W120_LITE
  vec2 fl = vW120.yz;
  float sp = length(fl);
  if (sp > 0.012 && px < 0.07 && uW120Dbg.w > 0.5) {
    // A RIVER RUNS DOWNSTREAM: two phases of the same pattern carried along the flow, each faded out before it stretches
    float cy = ${f1(K.flowCycle)};
    float ph0 = fract(t / cy), ph1 = fract(t / cy + 0.5);
    float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
    // (WATER-2) in the flow's frame, the pattern stretched along the stream by 1/uW120Calm.w (streaks, not blobs)
    vec2 fd = fl / sp, fq = vec2(-fd.y, fd.x);
    vec2 q = vec2(dot(pm, fd), dot(pm, fq));
    float st = uW120Calm.w;
    vec2 f0 = texture2D(uW120Ripple, vec2((q.x - sp * ph0 * cy) * st, q.y) / ${f1(K.tileF)} + vec2(0.37, 0.11)).ba * 2.0 - 1.0;
    vec2 f1 = texture2D(uW120Ripple, vec2((q.x - sp * ph1 * cy) * st, q.y) / ${f1(K.tileF)} + vec2(0.71, 0.53)).ba * 2.0 - 1.0;
    vec2 fm = mix(f1, f0, w0);
    fm = fd * (fm.x * st) + fq * fm.y;
    float fk = smoothstep(0.02, 0.35, sp) * (1.0 - smoothstep(0.012, 0.07, px));
    s = s * (1.0 - 0.45 * fk) + fm * (0.30 + 0.30 * min(sp, 1.2)) * fk;
  }
#endif
  return s;
}
void w120Composite() {
  vec3 wp = vWaterW;
  // (WATER-4) THE SKIRT. A dry vertex of the plane is parked 40 u down, so a triangle between the water's edge and the land
  // is a near-vertical sheet. Where the land in front of it lies under the level (a flood's field, a beach a pace from the sea)
  // the eye sees it: OFF's faint streaks; ON's curtain (the ripples, the reflection and the foam are functions of x and z, so
  // constant down a vertical face) and, as its depth goes negative down the sheet, a white smear of foam. It is drawn as what
  // the eye's ray meets first, the level it hangs from (a shallow edge); a ford's sheet, or one seen from under the level, is
  // dropped (at the end: after every derivative).
  vec3 gN = cross(dFdx(vWaterW), dFdy(vWaterW));
  float skirt = (uW120Fix.x > 0.5 && abs(gN.y) < 0.5 * length(gN)) ? 1.0 : 0.0;
  float drop = 0.0;
  vec4 wv = vW120;
  float wS = vW120S;
  if (skirt > 0.5) {
    float lv = uW120Grid.z, de = uWaterEye.y - wp.y;
    if (vW120Fd > 0.001 || uWaterEye.y < lv + 0.003 || de < 1e-4) drop = 1.0;
    // the water at the sheet's own top edge: its varyings run linearly down to the dry vertex (40 u under the level), so
    // the edge's depth and shore distance come back from the fraction w of the drop (the same on all its triangles)
    else {
      float w = clamp((lv - wp.y) / 40.0, 0.0, 0.5);
      wv.x = clamp((vW120.x + (lv - wp.y)) / (1.0 - w), 0.06, 4.0); wS = vW120S / (1.0 - w);
      wp = uWaterEye + (wp - uWaterEye) * ((uWaterEye.y - lv) / de);
    }
  }
  vec3 dv = uWaterEye - wp;
  float dEye = length(dv);
  vec3 v = dv / max(dEye, 1e-4);
  vec2 pm = wp.xz * 4.0;
  vec2 fw = fwidth(pm);
  float px = max(fw.x, fw.y);
  float rough;
  vec2 s = w120Slope(pm, px, rough);
  float near = 1.0 - smoothstep(0.015, 0.045, px);
#ifndef W120_LITE
  if (uW120Rain.x > 0.01 && near > 0.0) s += w120Rings(pm, uW120Rain.x, uW120T) * near;
#endif
  rough = min(1.0, rough + uW120Rain.x * 0.35);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uW120RingN) break;
    vec4 rg = uW120Ring[i];
    vec2 d = wp.xz - rg.xy;
    float rm = length(d) * 4.0, age = uW120T - rg.z;
    float wv = (rm - age * 1.6) * 2.2;
    if (age < 0.0 || abs(wv) > 3.0) continue;
    s += d / max(length(d), 1e-4) * sin(wv * 3.14159) * exp(-wv * wv * 0.4) * rg.w * exp(-age * 0.9) / (1.0 + rm * 0.25);
  }
  s *= mix(0.35, 1.0, smoothstep(0.03, 0.30, wv.x));   // shallow water carries small waves
  vec3 n = normalize(vec3(-s.x, 1.0, -s.y));
  float nv = max(dot(n, v), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - nv, 5.0);
  vec3 r = reflect(-v, n);
  // (WATER-2) the banks are found along a CALMER ray (uW120Calm.x of the ripples' tilt): the full tilt sent neighbouring
  // pixels' rays to the sky and to a bank by turns: black-and-light camouflage instead of a reflected bank
  vec3 rB = reflect(-v, normalize(vec3(-s.x * uW120Calm.x, 1.0, -s.y * uW120Calm.x)));
  rB.y = max(rB.y, 0.006); rB = normalize(rB);
  r.y = max(r.y, 0.006);
  r = normalize(r);
  // (WATER-3) THE CHEAP FORD: a 36 cm stream shows its bed; its sky is the clouds' mean (uW120Look.w) and it marches no bank
  // unless uW120Skip.y gives it steps
  float isFord = step(0.5, vW120Fd);
  vec3 refl = w120Sky(r, clamp(log2(max(px * 5.0, 1.0)), 0.0, 4.0) + rough * 1.5, fres * (1.0 - uW120Look.w * isFord));
  vec4 bank = fres > uW120March.w && dEye < uW120March.z && (isFord < 0.5 || uW120Skip.y > 0.5) ? w120Bank(wp, rB, 1.0) : vec4(0.0);
  refl = mix(refl, bank.rgb, bank.a * (1.0 - smoothstep(uW120March.z * 0.6, uW120March.z, dEye)) * (1.0 - 0.45 * rough * uW120Calm.y));
  // the sun on the ripples
  vec3 sunL = normalize(uWaterSun);
  float nh = max(dot(n, normalize(sunL + v)), 0.0);
  float shin = mix(1400.0, 90.0, clamp(rough, 0.0, 1.0));
  float spec = pow(nh, shin) * shin * 0.004 * fres * uW120Rain.z * uW120Dbg.z;
  vec3 glint = spec > 0.0008 ? w120Disp(uW120SunC * spec) : vec3(0.0);
  // what the water lets through of its bed, along the path down and back up
  float ex = vW120.w, sea = smoothstep(0.75, 0.95, ex);
  // a map's bed steps straight down at the bank; what is SEEN of the bed shelves as a beach, a lake's or a pond's edge would
  // (a river keeps its banks: embankments and walls)
  float shelf = length(vW120.yz) > 0.012 ? 1e3 : mix(mix(0.25, 0.12, smoothstep(0.30, 0.44, ex)), 0.05, sea);
  float dM = min(max(wv.x, 0.0) * 4.0, wS * shelf);
  // (WATER-3) beside a ford the river's bed shelves (1 in 3) down from the ford's 36 cm: no ruled line where a ford strip
  // meets the deep river
  dM = min(dM, 0.36 + vW120X.y * uW120Skip.z);
  float muR = sqrt(1.0 - (1.0 - nv * nv) * 0.565);
  // (WATER-2) a ford is a clear stream over gravel, not the murky river's water: its bed shows in first person
  float tr = exp(-mix(uW120Abs.x, uW120Abs.y, sea) * mix(1.0, uW120Look.x, vW120Fd) * dM * (1.0 + 1.0 / max(muR, 0.2)));
  // WATER MUST READ AS WATER (it stops a man on foot): a few metres out from the bank at least 40% of what is seen is the
  // water's own body, however shallow or clear (a reef flat, a ford, a pond in a marsh vanished into their beds)
  tr = min(tr, 1.0 - (0.25 + 0.15 * smoothstep(0.10, 0.35, wv.x)) * smoothstep(0.5, 4.0, wS + 3.0 * vW120Fd));
  // foam: a broken line where the water meets the land, lapping; the surf rolling in on a beach
  float dU = wv.x;
  float lap = 0.010 * sin(uW120T * 1.25 + pm.x * 0.13 + pm.y * 0.17) * (0.5 + ex);
  float fwU = max(0.010, px * 0.25);
  float fn = 0.5;
#ifdef W120_LITE
  if (dU < fwU * 3.0 + 0.03 || (sea > 0.0 && dM < 2.6)) fn = w120VN(pm * 0.9 + vec2(uW120T * 0.05, 0.0)) * 0.74 + 0.13;
#else
  if (dU < fwU * 3.0 + 0.03 || (sea > 0.0 && dM < 2.6)) fn = w120VN(pm * 0.9 + vec2(uW120T * 0.05, 0.0)) * 0.65 + w120VN(pm * 3.1 - vec2(0.0, uW120T * 0.08)) * 0.35;
#endif
  float shore = (1.0 - smoothstep(0.0, fwU, dU + lap)) * (1.0 - smoothstep(1.0, 5.0, wS)) * smoothstep(0.30, 0.62, fn + 0.18) * mix(0.35, 1.0, ex);
  // (WATER-2) a white line along every bank was a hard ruled stroke at 26 m: foam only where waves (open water) or a current
  // break on the bank, in patches, with a soft edge (uW120Calm.y: 0 = the 18:18 line)
  float shoreK = max(smoothstep(0.45, 0.9, ex), 0.6 * smoothstep(0.15, 0.7, length(vW120.yz)));
  float shore2 = (1.0 - smoothstep(-fwU * 0.5, fwU * 2.5, dU + lap)) * (1.0 - smoothstep(1.0, 5.0, wS)) * smoothstep(0.42, 0.72, fn) * shoreK * 0.8;
  shore = mix(shore, shore2, uW120Calm.y);
  float surf = 0.0;
  if (sea > 0.0 && dM < 2.6) {   // (WATER-2) surf is 0 past 2.6 m of depth: skip its noise there (the open sea)
    float ph = fract(dM * 0.32 - uW120T * 0.10 + fn * 0.25);
#ifdef W120_LITE
    float lace = w120VN(pm * 2.7 + vec2(0.0, uW120T * 0.3)) * 0.72 + 0.14;
#else
    float lace = w120VN(pm * 2.7 + vec2(0.0, uW120T * 0.3)) * 0.6 + w120VN(pm * 7.9 - vec2(uW120T * 0.2, 0.0)) * 0.4;
#endif
    surf = smoothstep(0.90, 0.985, ph) * (1.0 - smoothstep(0.3, 2.6, dM)) * sea * smoothstep(0.40, 0.70, lace) * smoothstep(0.25, 0.6, fn);
  }
  float phi = clamp(shore * 0.85 + surf * uW120Fix.w, 0.0, 1.0) * uW120Abs.z;
  vec3 foam = phi > 0.002 ? w120Disp(w120Lin / max(w120Alb, vec3(1e-4)) * 0.72) : vec3(0.0);
  // over the bed: foam, the reflection by Fresnel, the body where the bed is lost, and the glint
  vec3 body = gl_FragColor.rgb;
  // (WATER-4) THE RIPPLES' FACETS on the body, as OFF draws them (faces toward the sun lighter): looking down on deep water
  // the Fresnel is 3%, so without them the body is one flat colour (the Waal at 26 m). At a grazing view the reflection
  // draws the ripples already: there they fade out; capped at +-30%.
  body *= 1.0 + clamp(uW120Fix.y * smoothstep(0.25, 0.6, nv) * dot(n.xz, sunL.xz), -0.3, 0.3);
  vec3 pc = phi * foam + (1.0 - phi) * (fres * refl + (1.0 - fres) * (1.0 - tr) * body) + glint;
  // (WATER-3) the bed seen through a ford is wet stone, darker than the dry gravel on its banks
  float wetB = max(vW120Fd, 1.0 - smoothstep(0.0, 8.0, vW120X.y));   // a ford, and the river's shelf beside it
  float a = 1.0 - (1.0 - phi) * (1.0 - fres) * tr * mix(1.0, uW120Skip.w, wetB);
  a = clamp(max(a, max(pc.r, max(pc.g, pc.b)) * 0.999), 0.0, 1.0);
  gl_FragColor = vec4(pc / max(a, 1e-3), a);
  // (WATER-3) a ford's water feathers in over the first 3 m from its dry edge (no ruled cell-edged strip)
  gl_FragColor.a *= mix(1.0, smoothstep(0.0, 3.0, vW120S), vW120Fd);
#ifdef W120_DROP_ALPHA
  if (drop > 0.5) gl_FragColor = vec4(0.0);
#else
  if (drop > 0.5) discard;
#endif
}
`;
  const F_ALB = `
  w120Alb = mix(uW120BodyR, uW120BodyS, smoothstep(0.75, 0.95, vW120.w));
  diffuseColor.rgb = w120Alb;`;
  const OFF_SURF = '{ float wa = gl_FragColor.a; gl_FragColor.rgb = waterSurface(gl_FragColor.rgb, wa); gl_FragColor.a = wa; }';

  /** Called from `waterSurfaceMaterial`'s onBeforeCompile, after its own edits. The uniforms always; the code only ON. */
  W.patchWater = function (sh, renderer) {
    Object.assign(sh.uniforms, U);
    if (!W.on) return false;
    const vs = sh.vertexShader, fs = sh.fragmentShader;
    const ok = renderer && renderer.capabilities && renderer.capabilities.isWebGL2
      && vs.indexOf('void main() {') >= 0 && vs.indexOf('waterWave119(transformed);') >= 0 && vs.indexOf('#include <project_vertex>') >= 0
      && fs.indexOf('void main() {') >= 0 && fs.indexOf('#include <color_fragment>') >= 0 && fs.indexOf(OFF_SURF) >= 0
      && fs.indexOf('#include <encodings_fragment>') >= 0;
    if (!ok) { W.fails++; return false; }
    sh.vertexShader = vs.replace('void main() {', V_PARS + 'void main() {')
      .replace('waterWave119(transformed);', 'waterWave119(transformed);' + V_SWELL)
      .replace('#include <project_vertex>', V_MAIN + '\n#include <project_vertex>');
    const mapF = (W.marchLod ? '#define W120_MAP(p) textureLod(uW120Map, p, 0.0)\n' : '#define W120_MAP(p) texture2D(uW120Map, p)\n') + (W.liteNow ? '#define W120_LITE\n' : '') + (W.dropAlpha ? '#define W120_DROP_ALPHA\n' : '');
    sh.fragmentShader = fs.replace('void main() {', mapF + F_PARS + 'void main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>' + F_ALB)
      .replace(OFF_SURF, 'w120Lin = gl_FragColor.rgb;')
      .replace('#include <encodings_fragment>', '#include <encodings_fragment>\n  w120Composite();');
    return true;
  };
  /** The material's program key: `|w120` only while ON (OFF keeps today's program). */
  W.key = function () { return W.on ? '|w120:' + W.ver + (W.marchLod ? 'L' : '') + (W.liteNow ? 'lite' : '') + (W.dropAlpha ? 'A' : '') : ''; };

  // ---------------------------------------------------------------- GLSL: the ground (wet banks, the bed)
  const G_PARS = `
uniform sampler2D uW120Shore;
uniform vec4 uW120Bank;
uniform vec4 uW120Grid;
uniform vec3 uW120Silt;
uniform vec3 uW120Sand;
uniform vec3 uW120Meadow;
uniform vec3 uW120TintR;
uniform vec3 uW120TintS;
uniform vec4 uW120Abs2;
uniform vec3 uW120Eye;
float w120GH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float w120GN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(w120GH(i), w120GH(i + vec2(1.0, 0.0)), f.x), mix(w120GH(i + vec2(0.0, 1.0)), w120GH(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;
  const G_MAIN = `
  if (uW120Bank.x > 0.5) {
    float w120y = vGPos.y - uW120Bank.y;
    if (w120y < uW120Bank.w * 1.6) {
      vec4 w120s = texture2D(uW120Shore, (vGPos.xz + uW120Grid.x) * uW120Grid.y);
      if (w120s.r > 0.004) {
        float w120n = w120GN(vGPos.xz * 3.1) * 0.6 + w120GN(vGPos.xz * 9.7) * 0.4;
        float w120b = mix(uW120Bank.z, uW120Bank.w, w120s.g) * (0.55 + 0.9 * w120n);
        float w120w = w120s.r * (1.0 - smoothstep(0.0, w120b, w120y));
        float w120u = w120s.r * (1.0 - smoothstep(-0.12, 0.01, w120y));
        vec3 w120bed = mix(mix(uW120Silt, uW120Sand, w120s.g), uW120Meadow, w120s.b) * (0.8 + 0.4 * w120n);
        diffuseColor.rgb = mix(diffuseColor.rgb, w120bed, w120u * 0.7);
        diffuseColor.rgb *= 1.0 - 0.42 * w120w * (1.0 - 0.5 * w120u);
        // under the water: what is left of the light down to the bed and back up, per channel beyond the water's grey
        // (the water's own alpha takes the grey): the sea's shallows go green-blue, a peaty river's brown
        if (w120y < 0.0) {
          vec3 w120e = normalize(uW120Eye - vGPos);
          float w120p = -w120y * 4.0 * (1.0 + 1.0 / max(w120e.y, 0.15));
          diffuseColor.rgb *= exp(-mix(uW120TintR, uW120TintS, w120s.g) * w120p * w120s.r);
        }
      }
    }
  }`;
  // v2 (WATER-2, the cost): the shore map is read per VERTEX (the ground is one vertex per cell, at the texel centres, so
  // the interpolation across a triangle is the bilinear filter it replaces), the test against it comes first, and the
  // band's noise is one fetch of the sky's noise tile (its G: fbm on a 16-cell lattice) instead of two value noises.
  const G_VPARS2 = `
uniform sampler2D uW120Shore;
uniform vec4 uW120Grid;
varying vec3 vW120Sh;
`;
  const G_VMAIN2 = `
  vW120Sh = texture2D(uW120Shore, (vGPos.xz + uW120Grid.x) * uW120Grid.y).rgb;
`;
  const G_PARS2 = `
uniform sampler2D uW120Noise;
uniform vec4 uW120Bank;
uniform vec3 uW120Silt;
uniform vec3 uW120Sand;
uniform vec3 uW120Meadow;
uniform vec3 uW120TintR;
uniform vec3 uW120TintS;
uniform vec3 uW120Eye;
varying vec3 vW120Sh;
`;
  const G_MAIN2 = `
  if (uW120Bank.x > 0.5 && vW120Sh.r > 0.004) {
    float w120y = vGPos.y - uW120Bank.y;
    if (w120y < uW120Bank.w * 1.6) {
      vec3 w120s = vW120Sh;
      float w120n = W120_GNOISE(vGPos.xz * 0.194);
      float w120b = mix(uW120Bank.z, uW120Bank.w, w120s.g) * (0.55 + 0.9 * w120n);
      float w120w = w120s.r * (1.0 - smoothstep(0.0, w120b, w120y));
      float w120u = w120s.r * (1.0 - smoothstep(-0.12, 0.01, w120y));
      vec3 w120bed = mix(mix(uW120Silt, uW120Sand, w120s.g), uW120Meadow, w120s.b) * (0.8 + 0.4 * w120n);
      diffuseColor.rgb = mix(diffuseColor.rgb, w120bed, w120u * 0.7);
      diffuseColor.rgb *= 1.0 - 0.42 * w120w * (1.0 - 0.5 * w120u);
      if (w120y < 0.0) {
        vec3 w120e = normalize(uW120Eye - vGPos);
        float w120p = -w120y * 4.0 * (1.0 + 1.0 / max(w120e.y, 0.15));
        diffuseColor.rgb *= exp(-mix(uW120TintR, uW120TintS, w120s.g) * w120p * w120s.r);
      }
    }
  }`;
  const GA = '#include <emissivemap_fragment>';
  // ---------------------------------------------------------------- (WATER-2) the wet band as an OVERLAY (W.groundOverlay)
  // A patched ground program costs on every ground pixel, even where its branch is never taken (the crowd paid 2.1 ms for
  // one). Instead: the ground's own triangles over the SHORE QUADS only (an index into the ground's position buffer, shared,
  // so a crater moves both), drawn after the opaque world with a 2x-modulate blend: what the ground drew there is multiplied
  // by the wet band's darkening and the bed's tint, carried through the game's own tone curve.
  const O_VS = `
uniform sampler2D uW120Shore;
uniform vec4 uW120Grid;
varying vec3 vW120Sh;
varying vec3 vW120P;
varying float vW120Z;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW120P = wp.xyz;
  vW120Sh = texture2D(uW120Shore, (wp.xz + uW120Grid.x) * uW120Grid.y).rgb;
  vec4 mv = viewMatrix * wp;
  vW120Z = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
  const O_FS = `
uniform sampler2D uW120Noise;
uniform vec4 uW120Bank;
uniform vec3 uW120Silt;
uniform vec3 uW120Sand;
uniform vec3 uW120Meadow;
uniform vec3 uW120TintR;
uniform vec3 uW120TintS;
uniform vec3 uW120Eye;
uniform vec3 uW120Ground;
uniform vec3 uW120Amb;
uniform vec3 uW120SunC;
uniform float uW120FogD;
varying vec3 vW120Sh;
varying vec3 vW120P;
varying float vW120Z;
vec3 w120Out(vec3 c) {
#if defined( TONE_MAPPING )
  c = toneMapping(c);
#endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
void main() {
  vec3 w120s = vW120Sh;
  float w120y = vW120P.y - uW120Bank.y;
  if (w120s.r <= 0.004 || w120y > uW120Bank.w * 1.6) discard;
  float w120n = texture2D(uW120Noise, vW120P.xz * 0.194).g;
  float w120b = mix(uW120Bank.z, uW120Bank.w, w120s.g) * (0.55 + 0.9 * w120n);
  float w120w = w120s.r * (1.0 - smoothstep(0.0, w120b, w120y));
  float w120u = w120s.r * (1.0 - smoothstep(-0.12, 0.01, w120y));
  vec3 ref = max(uW120Ground / 0.85, vec3(0.02));
  vec3 w120bed = mix(mix(uW120Silt, uW120Sand, w120s.g), uW120Meadow, w120s.b) * (0.8 + 0.4 * w120n);
  // (WATER-3) under the water the bed is wet silt (sand on a beach, grass in a flood): its hue at 0.6 of the dry ground's
  // light, whatever the ground drew there (bed/ref was over 1 where the drawn ground is paler than the bank's mean colour)
  vec3 hue = sqrt(w120bed / max(max(w120bed.r, w120bed.g), max(w120bed.b, 1e-3)));
  vec3 m = mix(vec3(1.0), hue * 0.6, w120u * 0.75);
  m *= 1.0 - 0.42 * w120w * (1.0 - 0.5 * w120u);
  if (w120y < 0.0) {
    vec3 w120e = normalize(uW120Eye - vW120P);
    float w120p = -w120y * 4.0 * (1.0 + 1.0 / max(w120e.y, 0.15));
    m *= exp(-mix(uW120TintR, uW120TintS, w120s.g) * w120p * w120s.r);
  }
  // (WATER-3) darken only: a bed paler than the bank's mean drew a thin bright line along the ford/river boundaries
  m = min(m, vec3(1.0));
  // (WATER-3) …and back to 1 before the quads end (level - 0.6 u): no hard edge across a clear sea's bed
  m = mix(m, vec3(1.0), smoothstep(0.42, 0.58, -w120y));
  // the multiplier as the screen sees it: through the game's tone curve and encode, about a typical lit bank
  vec3 lr = ref * (uW120Amb + uW120SunC * 0.6);
  vec3 o = w120Out(lr * m) / max(w120Out(lr), vec3(1e-3));
  float fd = uW120FogD * vW120Z;
  o = mix(o, vec3(1.0), 1.0 - exp(-fd * fd));
  gl_FragColor = vec4(clamp(o * 0.5, 0.0, 1.0), 0.5);
}`;
  /** The overlay's index: the ground quads (PlaneGeometry's own winding) with shore near and the ground near the level. */
  function overlayIndex(T, N, sp, HS, level, band) {
    const out = [], lo = level - 0.6, hi = level + band * 1.6;
    const R = i => sp[i * 4], H = i => bedH(T, i) * HS;
    for (let z = 0; z < N - 1; z++) for (let x = 0; x < N - 1; x++) {
      const a = z * N + x, b = a + N, c = b + 1, d = a + 1;
      if (Math.max(R(a), R(b), R(c), R(d)) <= 1) continue;
      const ha = H(a), hb = H(b), hc = H(c), hd = H(d);
      if (Math.min(ha, hb, hc, hd) > hi || Math.max(ha, hb, hc, hd) < lo) continue;
      out.push(a, b, d, b, c, d);
    }
    return out;
  }
  W.overlayIndex = overlayIndex;
  W.groundFails = 0;
  /** Patch the ground's material (after groundsplat.js has, which hands the fragment `vGPos`). Composes with every
   *  earlier hook and key, with the grade's `_gradePrevKey` as weather119.js does. */
  W.patchGround = function (mat) {
    if (!mat || mat._w120) return false;
    mat._w120 = true;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      Object.assign(sh.uniforms, U);
      if (!W.on || !W.groundOn) return;
      const fs = sh.fragmentShader;
      if (fs.indexOf(GA) < 0 || fs.indexOf('vGPos') < 0 || fs.indexOf('void main() {') < 0) { W.groundFails++; return; }
      const vs = sh.vertexShader;
      if (W.groundV2 && vs.indexOf('vGPos = ') >= 0 && vs.indexOf('#include <project_vertex>') >= 0) {
        sh.vertexShader = G_VPARS2 + vs.replace('#include <project_vertex>', G_VMAIN2 + '#include <project_vertex>');
        const nz = W.groundLod ? '#define W120_GNOISE(p) textureLod(uW120Noise, p, 0.0).g\n' : '#define W120_GNOISE(p) texture2D(uW120Noise, p).g\n';
        sh.fragmentShader = fs.replace('void main() {', nz + G_PARS2 + 'void main() {').replace(GA, GA + '\n' + G_MAIN2);
        return;
      }
      sh.fragmentShader = fs.replace('void main() {', G_PARS + 'void main() {').replace(GA, GA + '\n' + G_MAIN);
    };
    const tag = function () { return W.on && W.groundOn ? '|w120g:' + W.ver + (W.groundV2 ? 'v2' + (W.groundLod ? 'l' : '') : '') : ''; };
    const had = mat._gradePrevKey !== undefined;
    const base = had ? mat._gradePrevKey : mat.customProgramCacheKey;
    const mine = function () { return (base ? base.call(this) : '') + tag(); };
    if (had) {
      mat._gradePrevKey = mine;
      mat.customProgramCacheKey = function () { return mine.call(this) + '|g' + ((root.Grade && root.Grade._ver) || 0); };
    } else mat.customProgramCacheKey = mine;
    mat.needsUpdate = true;
    return true;
  };

  // ---------------------------------------------------------------- the ripple tile (made once, no random stream)
  function prng(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** R,G: the slope of wind waves running along +u (a spread of +-30 deg about it); B,A: isotropic catspaws.
   *  Integer wave vectors, so the tile repeats without a seam. Slopes are scaled to an RMS of 0.33 and stored +-1. */
  function rippleTile(N) {
    const rnd = prng(0x120a7e5);
    const fields = [
      { n: 44, k0: 3, k1: 24, spread: 0.52, p: 1.0 },
      { n: 44, k0: 6, k1: 52, spread: 3.2, p: 0.85 },
    ];
    const out = new Uint8Array(N * N * 4), su = new Float32Array(N * N), sv = new Float32Array(N * N);
    const cu = new Float32Array(N), snu = new Float32Array(N), cv = new Float32Array(N), snv = new Float32Array(N);
    fields.forEach(function (F, fi) {
      su.fill(0); sv.fill(0);
      const seen = new Set();
      for (let w = 0; w < F.n; w++) {
        let kx = 0, kz = 0, tries = 0;
        do {
          const km = F.k0 * Math.pow(F.k1 / F.k0, rnd());
          const th = F.spread > 3 ? rnd() * Math.PI * 2 : (rnd() + rnd() + rnd() - 1.5) * F.spread;
          kx = Math.round(km * Math.cos(th)); kz = Math.round(km * Math.sin(th));
          tries++;
        } while ((kx === 0 && kz === 0 || seen.has(kx + ',' + kz)) && tries < 20);
        seen.add(kx + ',' + kz);
        const km = Math.hypot(kx, kz) || 1, amp = Math.pow(km, -F.p - 1) * (0.6 + 0.8 * rnd()), ph = rnd() * Math.PI * 2;
        for (let i = 0; i < N; i++) {
          const au = 2 * Math.PI * kx * i / N + ph, av = 2 * Math.PI * kz * i / N;
          cu[i] = Math.cos(au); snu[i] = Math.sin(au); cv[i] = Math.cos(av); snv[i] = Math.sin(av);
        }
        const ax = -amp * kx, az = -amp * kz;
        for (let v = 0; v < N; v++) {
          const c2 = cv[v], s2 = snv[v], row = v * N;
          for (let u = 0; u < N; u++) {
            const s = snu[u] * c2 + cu[u] * s2;     // sin(au + av)
            su[row + u] += ax * s; sv[row + u] += az * s;
          }
        }
      }
      let e = 0;
      for (let i = 0; i < N * N; i++) e += su[i] * su[i] + sv[i] * sv[i];
      const k = 0.33 / Math.sqrt(e / (N * N) + 1e-12);
      for (let i = 0; i < N * N; i++) {
        out[i * 4 + fi * 2] = Math.max(0, Math.min(255, Math.round((su[i] * k * 0.5 + 0.5) * 255)));
        out[i * 4 + fi * 2 + 1] = Math.max(0, Math.min(255, Math.round((sv[i] * k * 0.5 + 0.5) * 255)));
      }
    });
    return out;
  }
  W.rippleTile = rippleTile;

  // ---------------------------------------------------------------- the bodies of water, their kinds and courses
  /** (bridges120) A cell under a bridge's span is DRAWN as water though the simulation's type is the deck
   *  (`Terrain._wet120`), and its drawn bed is `Terrain._drawH120` (height units, NaN where none). Both null when
   *  bridges120 is off. */
  function wetBridge(T, i) { return !!(T._wet120 && T._wet120[i]); }
  function bedH(T, i) { const d = T._drawH120; if (d) { const v = d[i]; if (v === v && v != null) return v; } return T.h[i]; }
  W.bedH = bedH;
  /** 4-connected bodies of `water` cells: label per cell and, per body, its cells, box, edge runs, banks, sand. */
  function findBodies(type, N, WT, sandT, real) {
    real = real || type;
    const lab = new Int32Array(N * N).fill(-1), q = new Int32Array(N * N), list = [];
    for (let s = 0; s < N * N; s++) {
      if (type[s] !== WT || lab[s] >= 0) continue;
      const id = list.length; let qh = 0, qt = 0; q[qt++] = s; lab[s] = id;
      let x0 = N, z0 = N, x1 = -1, z1 = -1, bank = 0, sand = 0; const edge = [0, 0, 0, 0];
      while (qh < qt) {
        const i = q[qh++], x = i % N, z = (i / N) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
        if (x === 0) edge[0]++; if (x === N - 1) edge[1]++; if (z === 0) edge[2]++; if (z === N - 1) edge[3]++;
        for (let k = 0; k < 4; k++) {
          const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < N - 1 ? i + 1 : -1) : k === 2 ? (z > 0 ? i - N : -1) : (z < N - 1 ? i + N : -1);
          if (j < 0) continue;
          if (type[j] === WT) { if (lab[j] < 0) { lab[j] = id; q[qt++] = j; } }
          else { bank++; if (sandT && sandT.has(real[j])) sand++; }
        }
      }
      list.push({ id, n: qt, cells: q.slice(0, qt), box: [x0, z0, x1, z1], edge, bank, sand });
    }
    return { lab, list };
  }
  /** Cells to the nearest bank, inside the water (4-connected, as `Terrain.scourRivers`). */
  function bankDistance(type, N, WT) {
    const d = new Int16Array(N * N).fill(-1), q = new Int32Array(N * N); let qt = 0;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (type[i] !== WT) continue;
      if ((x > 0 && type[i - 1] !== WT) || (x < N - 1 && type[i + 1] !== WT) || (z > 0 && type[i - N] !== WT) || (z < N - 1 && type[i + N] !== WT)) { d[i] = 1; q[qt++] = i; }
    }
    for (let h = 0; h < qt; h++) {
      const i = q[h], x = i % N, z = (i / N) | 0;
      if (x > 0 && type[i - 1] === WT && d[i - 1] < 0) { d[i - 1] = d[i] + 1; q[qt++] = i - 1; }
      if (x < N - 1 && type[i + 1] === WT && d[i + 1] < 0) { d[i + 1] = d[i] + 1; q[qt++] = i + 1; }
      if (z > 0 && type[i - N] === WT && d[i - N] < 0) { d[i - N] = d[i] + 1; q[qt++] = i - N; }
      if (z < N - 1 && type[i + N] === WT && d[i + N] < 0) { d[i + N] = d[i] + 1; q[qt++] = i + N; }
    }
    return d;
  }
  /** The same, 8-connected and in fifths of a cell (5 and 7 a step): a rounder field, for the channel's axis. */
  function bankChamfer(type, N, WT) {
    const D = new Int32Array(N * N).fill(-1), Bk = [[], [], [], [], [], [], [], []];
    let left = 0;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (type[i] !== WT) continue;
      if ((x > 0 && type[i - 1] !== WT) || (x < N - 1 && type[i + 1] !== WT) || (z > 0 && type[i - N] !== WT) || (z < N - 1 && type[i + N] !== WT)) { D[i] = 5; Bk[5].push(i); left++; }
    }
    let cur = 5;
    while (left > 0) {
      const bk = Bk[cur & 7];
      while (bk.length) {
        const i = bk.pop(); left--;
        if (D[i] !== cur) continue;
        const x = i % N, z = (i / N) | 0;
        for (let k = 0; k < 8; k++) {
          const xx = x + NB8[k][0], zz = z + NB8[k][1];
          if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
          const j = zz * N + xx;
          if (type[j] !== WT) continue;
          const nd = cur + NB8[k][2];
          if (D[j] < 0 || nd < D[j]) { D[j] = nd; Bk[nd & 7].push(j); left++; }
        }
      }
      cur++;
    }
    return D;
  }
  /** Geodesic distance inside body `id` from `src` (8-connected, 5 and 7 a step: Dial's buckets). Returns the farthest cell. */
  const NB8 = [[-1, 0, 5], [1, 0, 5], [0, -1, 5], [0, 1, 5], [-1, -1, 7], [1, -1, 7], [-1, 1, 7], [1, 1, 7]];
  function geodesic(lab, id, N, src, D) {
    const B = [[], [], [], [], [], [], [], []];
    D[src] = 0; B[0].push(src);
    let cur = 0, left = 1, far = src;
    while (left > 0) {
      const bk = B[cur & 7];
      while (bk.length) {
        const i = bk.pop(); left--;
        if (D[i] !== cur) continue;
        if (cur > D[far]) far = i;
        const x = i % N, z = (i / N) | 0;
        for (let k = 0; k < 8; k++) {
          const xx = x + NB8[k][0], zz = z + NB8[k][1];
          if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
          const j = zz * N + xx;
          if (lab[j] !== id) continue;
          const nd = cur + NB8[k][2];
          if (D[j] < 0 || nd < D[j]) { D[j] = nd; B[nd & 7].push(j); left++; }
        }
      }
      cur++;
    }
    return far;
  }
  /** Classify every body and give each river cell its flow (m/s, x and z) — written into `flow` (2 a cell) and
   *  `expo` (0..1: how much the wind works on it; 1 is the sea). Pure function of the terrain arrays. */
  function analyse(T, N, mapName, TY) {
    const WT = 1, M = new Uint8Array(N * N), ford = new Uint8Array(N * N), sandT = new Set([TY.sand, TY.beach, TY.shingle].filter(v => v != null));
    for (let i = 0; i < N * N; i++) { const t = T.type[i]; if (t === TY.water || wetBridge(T, i)) M[i] = 1; else if (TY.ford != null && t === TY.ford) { M[i] = 1; ford[i] = 1; } }
    const B = findBodies(M, N, WT, sandT, T.type), dB = bankDistance(M, N, WT);
    const flow = new Float32Array(N * N * 2), expo = new Float32Array(N * N), kind = new Uint8Array(N * N);
    const D = new Int32Array(N * N).fill(-1), qi = new Int32Array(N * N).fill(-1), dB8 = bankChamfer(M, N, WT);
    const seaMap = SEA_RE.test(mapName || ''), canalMap = CANAL_RE.test(mapName || '');
    let seaId = -1, seaRun = 0;
    for (const b of B.list) { const run = Math.max(b.edge[0], b.edge[1], b.edge[2], b.edge[3]); if (run > seaRun) { seaRun = run; seaId = b.id; } }
    const out = [];
    for (const b of B.list) {
      const run = Math.max(b.edge[0], b.edge[1], b.edge[2], b.edge[3]);
      let maxDB = 1; for (let k = 0; k < b.n; k++) { const v = dB[b.cells[k]]; if (v > maxDB) maxDB = v; }
      // the course: from any cell to the farthest (one end), from there to the farthest again (the other end)
      const a0 = geodesic(B.lab, b.id, N, b.cells[0], D);
      for (let k = 0; k < b.n; k++) D[b.cells[k]] = -1;
      const endB = geodesic(B.lab, b.id, N, a0, D);
      const len = D[endB] / 5 + 1, wid = b.n / len, elong = len / Math.max(1, wid);
      const sea = (seaMap && b.id === seaId && run >= 0.35 * N) || (run >= 0.6 * N && b.sand >= 0.25 * b.bank);
      // long and narrow, or running off the field's edge (a river cut in two by a causeway is still a river)
      const river = !sea && len >= 32 && (elong >= 4 || (run >= 3 && elong >= 2.5));
      const canal = river && canalMap && wid <= 40;
      const k = sea ? 'sea' : canal ? 'canal' : river ? (maxDB <= 2 ? 'stream' : 'river') : (b.n < 2500 ? 'pond' : 'lake');
      const ex = sea ? 1 : river ? (canal ? 0.30 : 0.42 + 0.2 * Math.min(1, wid / 30)) : (k === 'pond' ? 0.18 + 0.2 * Math.min(1, b.n / 2000) : 0.45);
      const code = sea ? 3 : river ? 2 : 1;
      for (let q = 0; q < b.n; q++) { const i = b.cells[q]; expo[i] = ex; kind[i] = code; }
      if (river) {
        // which end is upstream: the deeper bed is downstream (a tie: the end nearer the field's origin is upstream)
        const bedAt = i => bedH(T, i);
        let up = a0;
        const ha = bedAt(a0), hb = bedAt(endB);
        if (Math.abs(ha - hb) > 0.05 ? hb > ha : (endB % N) + ((endB / N) | 0) < (a0 % N) + ((a0 / N) | 0)) up = endB;
        if (up !== a0) { for (let q = 0; q < b.n; q++) D[b.cells[q]] = -1; geodesic(B.lab, b.id, N, up, D); }
        // DOWNSTREAM. The geodesic from the upstream end gives the sense, but its level sets are arcs round the inner
        // bank of every bend, so its gradient cuts the corners (25 degrees off on a meander). The channel's own axis is
        // across the bank-distance field: the minor axis of that gradient's structure tensor, which a 3x3 average
        // keeps even on the mid-channel ridge where the gradient itself flips. Where the tensor has no axis (an
        // end, a pool) the geodesic is used as it is.
        for (let q = 0; q < b.n; q++) qi[b.cells[q]] = q;
        const gx = new Float32Array(b.n), gz = new Float32Array(b.n), jxx = new Float32Array(b.n), jxz = new Float32Array(b.n), jzz = new Float32Array(b.n);
        const val = (A_, i, d0) => (i >= 0 && qi[i] >= 0 ? A_[i] : d0);
        for (let q = 0; q < b.n; q++) {
          const i = b.cells[q], x = i % N, z = (i / N) | 0;
          gx[q] = val(D, x < N - 1 ? i + 1 : -1, D[i]) - val(D, x > 0 ? i - 1 : -1, D[i]);
          gz[q] = val(D, z < N - 1 ? i + N : -1, D[i]) - val(D, z > 0 ? i - N : -1, D[i]);
          const bx = val(dB8, x < N - 1 ? i + 1 : -1, dB8[i]) - val(dB8, x > 0 ? i - 1 : -1, dB8[i]);
          const bz = val(dB8, z < N - 1 ? i + N : -1, dB8[i]) - val(dB8, z > 0 ? i - N : -1, dB8[i]);
          jxx[q] = bx * bx; jxz[q] = bx * bz; jzz[q] = bz * bz;
        }
        const box = (arrs, passes) => {
          const tmp = arrs.map(() => new Float32Array(b.n));
          for (let pass = 0; pass < passes; pass++) {
            for (let q = 0; q < b.n; q++) {
              const i = b.cells[q], x = i % N, z = (i / N) | 0;
              for (let a = 0; a < arrs.length; a++) tmp[a][q] = 0;
              for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
                const j = qi[zz * N + xx]; if (j < 0) continue;
                for (let a = 0; a < arrs.length; a++) tmp[a][q] += arrs[a][j];
              }
            }
            for (let a = 0; a < arrs.length; a++) arrs[a].set(tmp[a]);
          }
        };
        box([gx, gz], 2); box([jxx, jxz, jzz], 2);
        for (let q = 0; q < b.n; q++) {
          const a_ = jxx[q], c_ = jzz[q], b_ = jxz[q], tr = a_ + c_ + 1e-9;
          const coh = Math.min(1, Math.sqrt((a_ - c_) * (a_ - c_) + 4 * b_ * b_) / tr);
          const th = 0.5 * Math.atan2(2 * b_, a_ - c_);
          let ax = -Math.sin(th), az = Math.cos(th);
          const gl = Math.hypot(gx[q], gz[q]) || 1, ux = gx[q] / gl, uz = gz[q] / gl;
          if (ax * ux + az * uz < 0) { ax = -ax; az = -az; }
          const w = coh * coh;
          gx[q] = ax * w + ux * (1 - w); gz[q] = az * w + uz * (1 - w);
        }
        box([gx, gz], 1);
        for (let q = 0; q < b.n; q++) { const m = Math.hypot(gx[q], gz[q]) || 1; gx[q] /= m; gz[q] /= m; }
        for (let q = 0; q < b.n; q++) qi[b.cells[q]] = -1;
        const vmax = canal ? K.canalV : maxDB <= 2 ? K.streamV : K.riverV;
        for (let q = 0; q < b.n; q++) {
          const i = b.cells[q], v = vmax * Math.min(1, 0.3 + 0.7 * Math.min(1, (dB[i] - 0.5) / Math.max(1, maxDB - 0.5)));
          flow[i * 2] = gx[q] * v; flow[i * 2 + 1] = gz[q] * v;
        }
      }
      for (let q = 0; q < b.n; q++) D[b.cells[q]] = -1;
      out.push({ id: b.id, n: b.n, kind: k, len: Math.round(len), wid: +wid.toFixed(1), maxDB, edgeRun: run, sand: b.bank ? +(b.sand / b.bank).toFixed(2) : 0, box: b.box, expo: +ex.toFixed(2) });
    }
    out.sort((a, b) => b.n - a.n);
    return { bodies: out, lab: B.lab, flow, expo, kind, dB8, ford };
  }
  W.analyse = analyse;

  /** Per vertex (= per cell): the bed, the flow and the exposure; a dry vertex beside the water takes its neighbours'. */
  function fillAttr(arr, T, N, A, HS) {
    const WT = A.kind;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const i = z * N + x, o = i * 4;
      arr[o] = bedH(T, i) * HS;
      if (WT[i]) { arr[o + 1] = A.flow[i * 2]; arr[o + 2] = A.flow[i * 2 + 1]; arr[o + 3] = A.expo[i]; continue; }
      let fx = 0, fz = 0, e = 0, n = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
        const j = zz * N + xx; if (!WT[j]) continue;
        fx += A.flow[j * 2]; fz += A.flow[j * 2 + 1]; e = Math.max(e, A.expo[j]); n++;
      }
      arr[o + 1] = n ? fx / n * 0.5 : 0; arr[o + 2] = n ? fz / n * 0.5 : 0; arr[o + 3] = e;
    }
  }
  /** The shore map: R near the water (1 within a cell, gone by four), G the sea's beach (a sand bed, a wide swash),
   *  B a flooded meadow (a grass bed). */
  function shoreMap(px, T, N, A, TY) {
    const WT = TY.water, d = new Int16Array(N * N).fill(-1), q = new Int32Array(N * N); let qt = 0;
    const src = new Int32Array(N * N).fill(-1);
    for (let i = 0; i < N * N; i++) if (A.kind[i]) { d[i] = 0; q[qt++] = i; src[i] = i; }
    for (let h = 0; h < qt; h++) {
      const i = q[h], x = i % N, z = (i / N) | 0; if (d[i] >= 4) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
        const j = zz * N + xx; if (d[j] >= 0) continue;
        d[j] = d[i] + 1; src[j] = src[i]; q[qt++] = j;
      }
    }
    for (let i = 0; i < N * N; i++) {
      const o = i * 4, dd = d[i];
      const p = dd < 0 ? 0 : dd <= 1 ? 1 : dd === 2 ? 0.6 : dd === 3 ? 0.25 : 0;
      px[o] = Math.round(p * 255);
      const s = src[i] >= 0 ? A.kind[src[i]] : 0;
      px[o + 1] = s === 3 && p > 0 ? 255 : 0;
      px[o + 2] = s === 1 && A.expo[src[i]] >= 0.44 && p > 0 ? 160 : 0;
      px[o + 3] = 255;
    }
  }
  /** THE SKYLINE: per cell, over the water level (u): R what is solid from the ground up (the bank, a house, a wall),
   *  G and B the top and the bottom of a crown (trees, hedges; a bridge's deck over the water), A how much of it is a house
   *  or a deck. Scale `hs`. */
  function skyline(g, T, N, wy, HS) {
    const solid = new Float32Array(N * N), ct = new Float32Array(N * N), cb = new Float32Array(N * N).fill(1e9), house = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (wetBridge(T, i)) { solid[i] = bedH(T, i) * HS - wy; const dk = T.h[i] * HS - wy; ct[i] = dk + 0.30; cb[i] = Math.max(0.05, dk - 0.35); house[i] = 255; }
      else solid[i] = T.h[i] * HS - wy;
    }
    const st = g.structures, S = root.Structures;
    if (st && st.any && st.mask && typeof st.floorY === 'function') {
      const FH = (S && S.FLOOR_H) || 2.2;
      for (let gz = 0; gz < N; gz++) for (let gx = 0; gx < N; gx++) {
        const i = gz * N + gx; if (!st.mask[i]) continue;
        const L = typeof st.topLevel === 'function' ? st.topLevel(gx, gz) : 0;
        const top = st.floorY(gx, gz, L) + FH * 1.45 - wy;
        if (top > solid[i]) { solid[i] = top; house[i] = 255; }
      }
    }
    const ob = g.obstacles && g.obstacles.list;
    if (ob) for (const o of ob) {
      if (!o || !(o.height > 0.3) || o.gx == null) continue;
      const i = o.gz * N + o.gx; if (i < 0 || i >= N * N) continue;
      const gy = T.h[i] * HS - wy, top = gy + o.height;
      if (LEAF.has(o.type)) {
        const bot = o.type === 'hedge' || o.type === 'bush' || o.type === 'shrub' || o.type === 'scrub' || o.type === 'bramble' ? gy : gy + o.height * (o.type === 'pine' || o.type === 'conifer' ? 0.12 : 0.32);
        const r = o.height > 2.4 ? 1 : 0;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const xx = o.gx + dx, zz = o.gz + dz; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
          const j = zz * N + xx, tj = top - (dx || dz ? 0.18 * o.height : 0), bj = bot + (dx || dz ? 0.12 * o.height : 0);
          if (tj > ct[j]) ct[j] = tj;
          if (bj < cb[j]) cb[j] = bj;
        }
      } else if (top > solid[i]) { solid[i] = top; house[i] = o.def && o.def.garrison ? 255 : 200; }
    }
    let hs = 1;
    for (let i = 0; i < N * N; i++) { if (solid[i] > hs) hs = solid[i]; if (ct[i] > hs) hs = ct[i]; }
    hs = Math.min(48, hs);
    const px = new Uint8Array(N * N * 4), k = 255 / hs;
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      px[o] = Math.max(0, Math.min(255, Math.round(solid[i] * k)));
      if (ct[i] > 0 && ct[i] > cb[i]) {
        px[o + 1] = Math.max(0, Math.min(255, Math.round(ct[i] * k)));
        px[o + 2] = Math.max(0, Math.min(255, Math.round(Math.max(0, cb[i]) * k)));
      }
      px[o + 3] = house[i];
    }
    return { px, hs };
  }
  W.skyline = skyline;
  /** (WATER-3) Multi-source distance (fifths of a cell, 5/7 chamfer, 8-connected) from every `src` cell, through the cells
   *  `pass` allows, out to `cap`; -1 where not reached. */
  function chamferFrom(N, src, pass, cap) {
    const D = new Int32Array(N * N).fill(-1), B = [[], [], [], [], [], [], [], []];
    let left = 0;
    for (let i = 0; i < N * N; i++) if (src(i)) { D[i] = 0; B[0].push(i); left++; }
    for (let cur = 0; left > 0 && cur <= cap; cur++) {
      const bk = B[cur & 7];
      while (bk.length) {
        const i = bk.pop(); left--;
        if (D[i] !== cur) continue;
        const x = i % N, z = (i / N) | 0;
        for (let k = 0; k < 8; k++) {
          const xx = x + NB8[k][0], zz = z + NB8[k][1];
          if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
          const j = zz * N + xx;
          if (!pass(j)) continue;
          const nd = cur + NB8[k][2];
          if (D[j] < 0 || nd < D[j]) { D[j] = nd; B[nd & 7].push(j); left++; }
        }
      }
    }
    return D;
  }
  /** (WATER-3) EMPTY SPACE for the bank march: per cell, u to the nearest texel of the skyline that a reflected ray could
   *  meet (a bank over the water, a house, a crown, a deck), x0.92 (the 5/7 chamfer overestimates by up to 8%) less 2.9
   *  cells (the bilinear filter's reach and a pixel's distance from its triangle's vertices: sqrt 2 each). Out to 80 cells. */
  function emptySkip(px, hs, N, TL) {
    const k = hs / 255, CAP = 400;
    const D = chamferFrom(N, i => px[i * 4] * k > 0.02 || px[i * 4 + 1] > px[i * 4 + 2], () => true, CAP);
    const out = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) { const d = D[i] < 0 || D[i] > CAP ? CAP : D[i]; out[i] = Math.max(0, (0.92 * d / 5 - 2.9) * TL); }
    return out;
  }
  W.emptySkip = emptySkip;
  /** (WATER-3) THE DIRECTIONAL SKIP: per cell, u a ray moving +x / -x / +z / -z runs before it could meet a skyline texel.
   *  F_d = the (1, sqrt 2) chamfer distance to the nearest occupied cell in the half-plane ahead (never decreasing along d);
   *  read 2 cells BACK (so it covers every pixel of the cell's triangles and the filter's reach), x0.92 (the chamfer's
   *  overestimate), less 4.9 cells (a pixel is within sqrt 2 of its vertex, a texel reaches sqrt 2): never past anything (test_round120_water group 8 checks it against brute force). */
  function halfSkip(px, hs, N, TL) {
    const k = hs / 255, CAP = 80, S2 = Math.SQRT2, occ = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) occ[i] = px[i * 4] * k > 0.02 || px[i * 4 + 1] > px[i * 4 + 2] ? 1 : 0;
    const out = new Float32Array(N * N * 4), F = new Float32Array(N * N);
    for (let d = 0; d < 4; d++) {
      const alongX = d < 2, sgn = d === 0 || d === 2 ? 1 : -1;
      const idx = (u, w) => (alongX ? w * N + u : u * N + w);
      for (let u = sgn > 0 ? N - 1 : 0; u >= 0 && u < N; u -= sgn) {
        const up = u + sgn, has = up >= 0 && up < N;
        for (let w = 0; w < N; w++) {
          const i = idx(u, w);
          if (occ[i]) { F[i] = 0; continue; }
          let v = CAP;
          if (has) {
            const a = F[idx(up, w)] + 1; if (a < v) v = a;
            if (w > 0) { const b = F[idx(up, w - 1)] + S2; if (b < v) v = b; }
            if (w < N - 1) { const c = F[idx(up, w + 1)] + S2; if (c < v) v = c; }
          }
          F[i] = v;
        }
        for (let w = 1; w < N; w++) { const i = idx(u, w), j = idx(u, w - 1); if (F[j] + 1 < F[i]) F[i] = F[j] + 1; }
        for (let w = N - 2; w >= 0; w--) { const i = idx(u, w), j = idx(u, w + 1); if (F[j] + 1 < F[i]) F[i] = F[j] + 1; }
      }
      for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
        const bx = d === 0 ? Math.max(0, x - 2) : d === 1 ? Math.min(N - 1, x + 2) : x;
        const bz = d === 2 ? Math.max(0, z - 2) : d === 3 ? Math.min(N - 1, z + 2) : z;
        out[(z * N + x) * 4 + d] = Math.max(0, 0.92 * F[bz * N + bx] - 4.9) * TL;
      }
    }
    return out;
  }
  W.halfSkip = halfSkip;
  /** (WATER-3) The water's LAYOUT (which cells are water, ford or a bridge's wet span; the level): a crater changes beds, not this. */
  function layoutSig(T, N) {
    const TY = root.TYPE || (typeof TYPE !== 'undefined' ? TYPE : {}), WT = TY.water, FT = TY.ford;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < N * N; i++) {
      const t = T.type[i], w = t === WT ? 1 : (FT != null && t === FT) ? 2 : (T._wet120 && T._wet120[i]) ? 3 : 0;
      if (w) h = Math.imul(h ^ (i * 4 + w), 16777619) >>> 0;
    }
    return h + ':' + T.waterY + ':' + (T._drawH120 ? 1 : 0) + ':' + (T._hasWater ? 1 : 0);
  }
  W.layoutSig = layoutSig;

  // ---------------------------------------------------------------- the controller
  function cosmetic(fn, self) {
    return typeof root.cosmeticScope === 'function' ? root.cosmeticScope(fn, self, []) : fn.call(self);
  }
  const gridN = () => (typeof GRID !== 'undefined' ? GRID : 224);
  const tileU = () => (typeof TILE !== 'undefined' ? TILE : 1.5);
  const hscale = () => (typeof HSCALE !== 'undefined' ? HSCALE : 0.75);
  function dataTex(px, N, linear, repeat, mips) {
    const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
    t.minFilter = mips ? THREE.LinearMipmapLinearFilter : t.magFilter;
    t.generateMipmaps = !!mips;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    if (mips) t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }

  function Ctl(game) {
    this.g = game;
    this.ok = false;
    this._on = false; this._map = null; this._terr = null; this._N = 0; this._ground = null;
    this.A = null; this.bodies = []; this.hs = 0; this._skyT = -1; this._skyAgain = -1;
    this.rings = []; this._wadeT = 0;
    this.ok = true;
  }
  const C = Ctl.prototype;

  /** (WATER-2) the shore-quad overlay: made once a build, shown only while W.groundOverlay (and ON, on a map with water). */
  C._overlay = function (g, T) {
    const want = !!(W.groundOverlay && T._hasWater && T.mesh && !W.noGround);
    let ov = this._ov;
    if (want && (!ov || this._ovDirty || ov.parent !== T.mesh)) {
      const self = this;
      cosmetic(function () {
        if (ov) { if (ov.parent) ov.parent.remove(ov); ov.geometry.dispose(); }
        const N = self._N, idx = overlayIndex(T, N, self._shorePx || new Uint8Array(N * N * 4), hscale(), T.waterY, U.uW120Bank.value.w || 0.2);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', T.mesh.geometry.attributes.position);
        geo.setIndex(idx);
        if (!self._ovMat) {
          self._ovMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uW120FogD: { value: 0 } }, U), vertexShader: O_VS, fragmentShader: O_FS,
            transparent: true, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor });
        }
        ov = self._ov = new THREE.Mesh(geo, self._ovMat);
        ov.name = 'water120-wetband'; ov.frustumCulled = false; ov.castShadow = ov.receiveShadow = false;
        ov.renderOrder = (T.water && T.water.renderOrder || 0) - 1;
        T.mesh.add(ov);
        self._ovTris = idx.length / 3;
      }, this);
      this._ovDirty = false;
    }
    if (ov) {
      ov.visible = want;
      if (want) { const f = g.scene && g.scene.fog; this._ovMat.uniforms.uW120FogD.value = f && f.density ? f.density : 0; }
    }
  };
  /** (WATER-3) the finer cull (see patch K's note in NOTES): chunks with no live quad are not drawn while ON */
  C._cull = function (T, N) {
    const wc = T && T._wcull; if (!wc || !T.water) return;
    if (wc.limit && !wc.limit._w120) wc._limOrig120 = wc.limit;
    const P = T.water.geometry.attributes.position.array, LIVE = (typeof WATER_DRY_Y !== 'undefined' ? WATER_DRY_Y : -40) + 1;
    const q = N - 1, Q = q + 1, S = new Int32Array(Q * Q);
    let live = 0;
    for (let z = 0; z < q; z++) {
      let row = 0;
      for (let x = 0; x < q; x++) {
        const a = z * N + x;
        if (P[a * 3 + 1] > LIVE || P[(a + 1) * 3 + 1] > LIVE || P[(a + N) * 3 + 1] > LIVE || P[(a + N + 1) * 3 + 1] > LIVE) { row++; live++; }
        S[(z + 1) * Q + x + 1] = S[z * Q + x + 1] + row;
      }
    }
    wc._sat120 = S; wc._satQ120 = Q; this.liveQuads = live;
    if (!wc.limit || !wc.limit._w120) {
      const f = function (qx0, qz0, qx1, qz1) {
        const o = wc._limOrig120;
        if (o && !o(qx0, qz0, qx1, qz1)) return false;
        const S = wc._sat120, Q = wc._satQ120;
        if (W.cull === false || !S) return true;
        const x0 = Math.max(0, Math.min(Q - 1, qx0 - 1)), z0 = Math.max(0, Math.min(Q - 1, qz0 - 1));
        const x1 = Math.max(0, Math.min(Q - 1, qx1 + 1)), z1 = Math.max(0, Math.min(Q - 1, qz1 + 1));
        return S[z1 * Q + x1] - S[z0 * Q + x1] - S[z1 * Q + x0] + S[z0 * Q + x0] > 0;
      };
      f._w120 = true; wc.limit = f;
    }
  };
  C._uncull = function (T) { const wc = T && T._wcull; if (wc && wc.limit && wc.limit._w120) wc.limit = wc._limOrig120 || null; };
  C._switch = function (g, on) {
    this._on = on; W.on = on;
    const T = g.terrain;
    if (T && T.water && T.water.material) T.water.material.needsUpdate = true;
    if (this._ground) this._ground.needsUpdate = true;
    if (on) this._map = null;          // build on the next frame
    else {
      W.groundOn = false;
      if (this._ov) this._ov.visible = false;
      U.uW120Bank.value.x = 0; U.uW120RingN.value = 0; this.rings.length = 0;
      if (T && T.water) {
        const geo = T.water.geometry, pos = geo.attributes.position, DRY = typeof WATER_DRY_Y !== 'undefined' ? WATER_DRY_Y : -40;
        if (this._fordV && this._fordGeo === geo && this._fordV.length) { for (const i of this._fordV) pos.setY(i, DRY); pos.updateRange.offset = 0; pos.updateRange.count = -1; pos.needsUpdate = true; }
        if (this._boxMine && T._waterBox === this._boxMine) T._waterBox = this._boxOrig;
        T.water.visible = !!T._hasWater;
      }
      this._fordV = null; this._boxMine = null; this._wetAny = false;
      this._uncull(T);
    }
  };

  /** Everything that depends on the water's shape: the bodies, the flow, the vertex data, the shore map. */
  C._build = function (g, light) {
    const T = g.terrain, N = gridN(), HS = hscale(), TY = root.TYPE || (typeof TYPE !== 'undefined' ? TYPE : null);
    if (!T || !T.water || !TY) return;
    const t0 = performance.now();
    const name = (g.mapDef && g.mapDef.name) || '';
    const A = light ? this.A : analyse(T, N, name, TY);
    this.A = A; this.bodies = A.bodies;
    const geo = T.water.geometry;
    let at = geo.attributes.aW120;
    if (!at || at.count !== N * N) { at = new THREE.BufferAttribute(new Float32Array(N * N * 4), 4); geo.setAttribute('aW120', at); }
    fillAttr(at.array, T, N, A, HS);
    at.needsUpdate = true;
    if (!light) {   // (WATER-3) the layout's own data: not again for a crater
    // metres from the bank, in the water (the shelf the eye is shown at a beach, a lake's or a pond's edge)
    let as = geo.attributes.aW120S;
    if (!as || as.count !== N * N) { as = new THREE.BufferAttribute(new Float32Array(N * N), 1); geo.setAttribute('aW120S', as); }
    const CM = tileU() * 4;
    for (let i = 0; i < N * N; i++) as.array[i] = A.kind[i] ? Math.max(0, (A.dB8[i] / 5 - 0.5) * CM) : 0;
    as.needsUpdate = true;
    // (WATER-3) aW120X: x the march's empty-space skip (u; written by `_sky` once the skyline is in), y metres to the nearest
    // ford through the water (a river's bed shelves up to a ford strip; 1e3 where there is none)
    let ax = geo.attributes.aW120X;
    if (!ax || ax.count !== N * N) { ax = new THREE.BufferAttribute(new Float32Array(N * N * 2), 2); geo.setAttribute('aW120X', ax); }
    let ae = geo.attributes.aW120E;
    if (!ae || ae.count !== N * N) { ae = new THREE.BufferAttribute(new Float32Array(N * N * 4), 4); geo.setAttribute('aW120E', ae); }
    else { ae.array.fill(0); ae.needsUpdate = true; }
    const dF = chamferFrom(N, i => A.ford[i] === 1, i => A.kind[i] !== 0, 5 * 60);
    for (let i = 0; i < N * N; i++) { ax.array[i * 2] = 0; ax.array[i * 2 + 1] = dF[i] >= 0 ? dF[i] / 5 * CM : 1e3; }
    ax.needsUpdate = true;
    cosmetic(function () {
      if (!U.uW120Ripple.value) U.uW120Ripple.value = dataTex(rippleTile(K.ripple), K.ripple, true, true, true);
      const sp = new Uint8Array(N * N * 4);
      shoreMap(sp, T, N, A, TY);
      this._shorePx = sp; this._ovDirty = true;
      if (U.uW120Shore.value) U.uW120Shore.value.dispose();
      U.uW120Shore.value = dataTex(sp, N, true, false, false);
    }, this);
    }
    // FORDS (only while ON): a ford is drawn as nothing today. Its own shallow surface over its bed, on the same plane:
    // its vertices are lifted in the vertex shader (`aW120F`); a vertex on dry ground meets the ground there.
    const pos = geo.attributes.position, DRY = typeof WATER_DRY_Y !== 'undefined' ? WATER_DRY_Y : -40;
    if (this._fordV && this._fordGeo === geo) for (const i of this._fordV) pos.setY(i, DRY);
    let af = geo.attributes.aW120F;
    if (!af || af.count !== N * N) { af = new THREE.BufferAttribute(new Float32Array(N * N), 1); geo.setAttribute('aW120F', af); }
    af.array.fill(0);
    const fordV = [], FT = TY.ford, WTY = TY.water, wy = T.waterY, LIM = (typeof MAXH !== 'undefined' ? MAXH : 20) * HS + 1;
    let fx0 = N, fz0 = N, fx1 = -1, fz1 = -1;
    if (FT != null) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      let water = false, top = -1e9;
      for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
        const cx = x + dx, cz = z + dz; if (cx < 0 || cz < 0) continue;
        const c = cz * N + cx, t = T.type[c];
        if (t === WTY || wetBridge(T, c)) water = true; else if (t === FT) top = Math.max(top, T.h[c] * HS);
      }
      if (water || top < -1e8) continue;
      const i = z * N + x;
      let level = top + K.fordDepth;
      // (WATER-2) a vertex IS its cell's centre (the plane and the ground share the grid): a ford's own vertex stands
      // fordDepth over its OWN bed. The highest of the four cells (a corner rule) stood the water 1.5 m deep on a stream bed
      // that slopes across (Village: the first-person man's rifle went under it).
      if (T.type[i] === FT && W.fordOwn) level = bedH(T, i) * HS + K.fordDepth;
      if (T.type[i] !== FT) level = Math.min(level, T.h[i] * HS - 0.02);
      const lift = level - wy;
      if (!(lift < LIM)) continue;                  // the cull box stops at MAXH
      af.array[i] = Math.abs(lift) < 1e-4 ? 1e-4 : lift;
      fordV.push(i); pos.setY(i, 0);
      if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (z < fz0) fz0 = z; if (z > fz1) fz1 = z;
    }
    af.needsUpdate = true;
    pos.updateRange.offset = 0; pos.updateRange.count = -1; pos.needsUpdate = true;
    this._fordV = fordV; this._fordGeo = geo; this.fords = fordV.length;
    // the box the plane's cull draws in: the fords' too
    if (T._waterBox !== this._boxMine) this._boxOrig = T._waterBox;
    if (fordV.length) {
      const o = this._boxOrig, has = !!(o && o.x1 >= o.x0);
      this._boxMine = { x0: Math.max(0, Math.min(has ? o.x0 : N, fx0 - 1)), z0: Math.max(0, Math.min(has ? o.z0 : N, fz0 - 1)),
        x1: Math.min(N - 1, Math.max(has ? o.x1 : -1, fx1 + 1)), z1: Math.min(N - 1, Math.max(has ? o.z1 : -1, fz1 + 1)) };
      T._waterBox = this._boxMine;
    } else { if (this._boxMine && T._waterBox === this._boxMine) T._waterBox = this._boxOrig; this._boxMine = null; }
    this._wetAny = !!T._hasWater || fordV.length > 0;
    if (!light) {
    // the colours this map's water takes
    const era = (g.mapDef && g.mapDef.era) || '';
    let snow = 0, n = 0;
    for (let i = 0; i < T.type.length; i += 97) { n++; if (T.type[i] === TY.snow || T.type[i] === TY.ice) snow++; }
    const winter = n && snow / n > 0.3;
    const big = A.bodies[0];
    const flood = big && big.kind === 'lake' && big.n > 4000;
    const rb = flood ? BODY.flood : /Eastern/.test(era) ? BODY.east : /Italy/.test(era) ? BODY.italy : winter ? BODY.winter : BODY.river;
    const sb = /Pacific/.test(era) ? BODY.pacific : /Italy|Desert/.test(era) ? BODY.med : BODY.channel;
    U.uW120BodyR.value.setRGB(rb.c[0], rb.c[1], rb.c[2]); U.uW120BodyS.value.setRGB(sb.c[0], sb.c[1], sb.c[2]);
    U.uW120Abs.value.set(rb.k, sb.k, K.foam, 0); U.uW120Abs2.value.set(rb.k, sb.k, 0, 0);
    const tr_ = TINT[Object.keys(BODY).find(k => BODY[k] === rb)] || TINT.river, ts_ = TINT[Object.keys(BODY).find(k => BODY[k] === sb)] || TINT.channel;
    U.uW120TintR.value.set(tr_[0], tr_[1], tr_[2]); U.uW120TintS.value.set(ts_[0], ts_[1], ts_[2]);
    U.uW120Leaf.value.setRGB(winter ? 0.10 : 0.065, winter ? 0.095 : 0.095, winter ? 0.08 : 0.042);
    // the bank's colour: what the ground beside the water is painted
    const cc = T.mesh && T.mesh.geometry.attributes.color;
    if (cc) {
      let r = 0, gg = 0, b = 0, m = 0;
      for (let i = 0; i < N * N; i += 3) if (A.kind[i] === 0 && ((i % N > 0 && A.kind[i - 1]) || (i % N < N - 1 && A.kind[i + 1]))) { r += cc.array[i * 3]; gg += cc.array[i * 3 + 1]; b += cc.array[i * 3 + 2]; m++; }
      if (m) U.uW120Ground.value.setRGB(r / m * 0.85, gg / m * 0.85, b / m * 0.85);
    }
    }
    this._N = N; this._map = g.mapDef; this._terr = T; W.dirty = false;
    try { this._cull(T, N); } catch (e) { W.cullFails = (W.cullFails || 0) + 1; }
    if (light) { this.rebeds = (this.rebeds || 0) + 1; this.rebedMs = +(performance.now() - t0).toFixed(1); return; }
    this._sig = layoutSig(T, N);
    this._skyT = K.skyDelay; this._skyAgain = K.skyAgain;
    this.buildMs = +(performance.now() - t0).toFixed(1);
  };
  /** (WATER-4) PREWARM. The material keeps a program per key, so a tier swap is a cache hit once both exist; but the FIRST
   *  use of a tier compiled it mid-game (the first entry into first person). Once a map's water is built, both tiers are
   *  compiled here (`renderer.compile`: the scene's own lights, so the water's own keys). `W.prewarm = false`: off. */
  C._prewarm = function (g) {
    const T = g.terrain, r = g.renderer, m = T && T.water && T.water.material;
    if (W.prewarm === false || !W.on || !r || !r.properties || typeof r.compile !== 'function' || !m || !g.scene || !g.camera) return;
    const keep = W.liteNow, t0 = performance.now();
    try { for (const lt of [!keep, keep]) { W.liteNow = lt; m.needsUpdate = true; r.compile(g.scene, g.camera); } }
    catch (e) { W.warmFails = (W.warmFails || 0) + 1; W.warmErr = String(e && e.message || e); }
    finally { W.liteNow = keep; m.needsUpdate = true; }
    this.warmMs = +(performance.now() - t0).toFixed(1);
    this.warmHeld = ((r.info && r.info.programs) || []).filter(p => p && p.cacheKey && p.cacheKey.indexOf('|w120:') >= 0).length;
  };
  C._sky = function (g) {
    const T = g.terrain, N = this._N; if (!T || !N) return;
    const t0 = performance.now();
    const r = skyline(g, T, N, T.waterY, hscale());
    cosmetic(function () {
      if (U.uW120Map.value && U.uW120Map.value.image && U.uW120Map.value.image.width === N) { U.uW120Map.value.image.data = r.px; U.uW120Map.value.needsUpdate = true; }
      else { if (U.uW120Map.value) U.uW120Map.value.dispose(); U.uW120Map.value = dataTex(r.px, N, true, false, false); }
    }, this);
    this.hs = r.hs;
    const ax = T.water && T.water.geometry.attributes.aW120X;
    if (ax && ax.count === N * N) {
      const E = emptySkip(r.px, r.hs, N, tileU());
      for (let i = 0; i < N * N; i++) ax.array[i * 2] = E[i];
      ax.needsUpdate = true;
      let s = 0, n = 0; for (let i = 0; i < N * N; i++) if (this.A && this.A.kind[i]) { s += E[i]; n++; }
      this.skipMean = n ? +(s / n).toFixed(1) : 0;
      const ae = T.water.geometry.attributes.aW120E;
      if (ae && ae.count === N * N) {
        const H = halfSkip(r.px, r.hs, N, tileU());
        ae.array.set(H); ae.needsUpdate = true;
        let s2 = 0; for (let i = 0; i < N * N; i++) if (this.A && this.A.kind[i]) s2 += Math.max(H[i * 4], H[i * 4 + 1], H[i * 4 + 2], H[i * 4 + 3]);
        this.skipDirMean = n ? +(s2 / n).toFixed(1) : 0;
      }
    }
    this.skyMs = +(performance.now() - t0).toFixed(1);
  };
  C._uniforms = function (g, dt) {
    const T = g.terrain, N = this._N, TL = tileU(), WD = N * TL;
    U.uW120Grid.value.set(WD / 2, 1 / WD, T.waterY, U.uW120Map.value ? this.hs : 0);
    // the wind (game.wind, world units a second: never written here)
    const w = g.wind || { x: 0, z: 0 }, wl = Math.hypot(w.x, w.z);
    const wd = U.uW120Wind.value;
    if (wl > 0.05) { wd.x = w.x / wl; wd.y = w.z / wl; }
    wd.z = wl; wd.w = Math.min(1, wl / 6);
    // rain: what weather119 says is falling (its rate), else the round-24 particles' rate
    const wx = g.wx119, fx = g.weatherFX;
    let rain = 0;
    if (wx && wx._on && wx.kind === 'rain') rain = wx.I || 0;
    else if (fx && fx.kind === 'rain') rain = fx.rate === undefined ? 1 : fx.rate;
    const dome = g.sky117 && g.skyNew && g.skyNew.u ? g.skyNew.u : null;
    const sun = g.sun, sunI = sun ? sun.intensity : 1;
    const cov = dome ? dome.uCloud.value.z : (g.weather && g.weather.light != null ? 1 - g.weather.light : 0);
    U.uW120Rain.value.set(Math.min(1, rain), 0, Math.max(0, Math.min(1, (1 - 0.92 * cov) * Math.min(1, sunI / 0.6))), dome ? 1 : 0);
    if (dome) {
      U.uW120Lut.value = dome.tLut.value; U.uW120Noise.value = dome.tNoise.value;
      U.uW120Cloud.value.copy(dome.uCloud.value); U.uW120Drift.value.copy(dome.uDrift.value);
      // (WATER-2) the clouds' means over the dome's noise tile, from its histogram (q[c] = the value c% of the tile lies above)
      const q = g.skyNew.q, cl = dome.uCloud.value, hz = dome.uHaze.value;
      if (q && q.length > 100) {
        const above = t => { let c = 0; while (c < 100 && q[c + 1] > t) c++; return c / 100; };
        const ramp = (a, w) => { let s = 0; for (let k = 0; k < 4; k++) s += above(a + w * (k + 0.5) / 4); return s / 4; };
        U.uW120SkyMean.value.set(ramp(cl.x, cl.y), ramp(hz.w, 0.5) * 0.6, 0.3);
      }
      U.uW120Tone.value.copy(dome.uTone.value); U.uW120Haze.value.copy(dome.uHaze.value);
      U.uW120SkySun.value.copy(dome.uSunCol.value); U.uW120SkyAmb.value.copy(dome.uAmb.value); U.uW120SunH.value.copy(dome.uSunH.value);
    }
    const fog = g.scene && g.scene.fog;
    if (fog) U.uW120Fog.value.copy(fog.color);
    if (g.camera) U.uW120Eye.value.setFromMatrixPosition ? U.uW120Eye.value.setFromMatrixPosition(g.camera.matrixWorld) : U.uW120Eye.value.copy(g.camera.position);
    // the light on a face turned to the water: the sun, and besides it the ambient, the sky's half of the hemisphere and the fill
    if (sun) U.uW120SunC.value.copy(sun.color).multiplyScalar(sunI);
    const am = U.uW120Amb.value.setRGB(0, 0, 0), add = (c, k) => { if (c) { am.r += c.r * k; am.g += c.g * k; am.b += c.b * k; } };
    if (g.ambientLight) add(g.ambientLight.color, g.ambientLight.intensity);
    if (g.hemiLight) { add(g.hemiLight.color, g.hemiLight.intensity * 0.5); add(g.hemiLight.groundColor, g.hemiLight.intensity * 0.5); }
    if (g.fillLight) add(g.fillLight.color, g.fillLight.intensity * 0.5);
    const bk = U.uW120Bank.value;
    bk.set(T._hasWater ? 1 : 0, T.waterY, K.band, K.bandSea);   // the ground's wet band follows the main level only (not a ford's)
  };
  /** Rings where men and vehicles wade (looked for four times a second; the eight newest near the camera). */
  C._wade = function (g, dt) {
    const T = g.terrain, t = this._t || 0, cam = g.camera && g.camera.position;
    this._wadeT -= dt;
    if (this._wadeT <= 0 && this.A && cam) {
      this._wadeT = 0.25;
      const N = this._N, TL = tileU(), H = N * TL / 2, kind = this.A.kind;
      for (const u of g.units) {
        if (!u.alive || !u.pos) continue;
        const cx = Math.floor((u.pos.x + H) / TL), cz = Math.floor((u.pos.z + H) / TL);
        if (cx < 0 || cz < 0 || cx >= N || cz >= N || !kind[cz * N + cx]) continue;
        if (Math.hypot(u.pos.x - cam.x, u.pos.z - cam.z) > 160) continue;
        const mv = u._simSpd != null ? u._simSpd : (u.vel ? Math.hypot(u.vel.x || 0, u.vel.z || 0) : 0);
        if (!(mv > 0.05) && Math.random() > 0.15) continue;
        this.rings.push({ x: u.pos.x, z: u.pos.z, t0: t, s: u.def && u.def.vehicle ? 0.5 : 0.22 });
      }
    }
    const R = this.rings;
    for (let i = R.length - 1; i >= 0; i--) if (t - R[i].t0 > 4 || t < R[i].t0) R.splice(i, 1);
    while (R.length > 8) R.shift();
    const arr = U.uW120Ring.value;
    for (let i = 0; i < R.length; i++) arr[i].set(R[i].x, R[i].z, R[i].t0, R[i].s);
    U.uW120RingN.value = R.length;
  };
  /** A round bursting in the water: a white column, its rain falling back, and a ring (cosmetic). */
  C.splash = function (x, z, r) {
    if (this.g.water120 !== true) return;
    const g = this.g, T = g.terrain, v = g.effects && g.effects.vfx, VK = root.VFX && root.VFX.KIND, VC = root.VFX && root.VFX.CELL;
    const s = Math.max(0.25, Math.min(3, r || 1)), y = T.waterY, KF = typeof K_FX !== 'undefined' ? K_FX : 1;
    this.rings.push({ x, z, t0: this._t || 0, s: Math.min(1.2, 0.35 + s * 0.3) });
    if (!v || !VK || !VC || typeof v.spawn !== 'function') return;
    const h = s * KF;
    for (let i = 0; i < 7; i++) {
      v.spawn(VK.SMOKE, { x: x + (Math.random() - 0.5) * 0.4 * h, y: y + 0.1, z: z + (Math.random() - 0.5) * 0.4 * h,
        vy: (7 + Math.random() * 6) * h, size: (0.9 + Math.random() * 0.6) * h, grow: 1.6 * h, life: 1.1 + Math.random() * 0.7,
        spin: Math.random() - 0.5, cell: VC.PUFF, r: 1.45, g: 1.48, b: 1.5, a: 0.85, drag: 1.5 });
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * 6.283, sp = (0.8 + Math.random() * 2.2) * h;
      v.spawn(VK.DEBRIS, { x, y: y + 0.1, z, vx: Math.cos(a) * sp, vy: (9 + Math.random() * 7) * h, vz: Math.sin(a) * sp,
        size: (0.06 + Math.random() * 0.06) * h, life: 1.2 + Math.random() * 0.8, cell: VC.DROP, r: 1.2, g: 1.3, b: 1.4, a: 0.9, gravity: 17, drag: 0.15 });
    }
  };
  C.frame = function (g, dt) {
    const on = g.water120 === true;
    if (on !== this._on) this._switch(g, on);
    if (!on) return;
    dt = Math.max(0, Math.min(0.25, dt || 0));
    const T = g.terrain;
    if (!T || !T.water) return;
    // the ground's material, once groundsplat.js has made it what it draws with
    const gm = T.mesh && T.mesh.material;
    if (gm && gm !== this._ground && (gm.userData.groundSplat || !root.GroundSplat || (this._waitT = (this._waitT || 0) + dt) > 8)) {
      if (W.patchGround(gm) || gm._w120) this._ground = gm;
    }
    if (g.mapDef !== this._map || T !== this._terr || W.dirty || this._N !== gridN() || !T.water.geometry.attributes.aW120) {
      // (WATER-3) a crater marks the water dirty on every water map: with the same layout only the beds moved (light)
      const light = W.lightRebuild !== false && !!this.A && this._sig && g.mapDef === this._map && T === this._terr && this._N === gridN()
        && !!T.water.geometry.attributes.aW120 && layoutSig(T, this._N) === this._sig;
      this._build(g, light);
    }
    const gOn = !!T._hasWater && !W.noGround && !W.groundOverlay;   // (W.noGround: a cost probe's arm; the overlay replaces the patch)
    if (gOn !== W.groundOn) { W.groundOn = gOn; if (this._ground) this._ground.needsUpdate = true; }
    const gv = (W.groundV2 ? 1 : 0) + (W.groundLod ? 2 : 0);   // (WATER-2: the per-vertex shore read, the noise's LOD; a probe's arm can flip them)
    if (gv !== this._gv) { this._gv = gv; if (this._ground) this._ground.needsUpdate = true; }
    // (WATER-3) THE TIER. The full water (the banks marched, the clouds, the fine ripples, the flow, rain rings) where the
    // water is seen up close: first person, or a camera within liteLo..liteHi u over the water (hysteresis). Above that a
    // pixel spans more than the fine ripples and the flow (they fade out past 5-7 cm a pixel), the Fresnel is a few per
    // cent (the banks and the clouds' pattern are a few per cent of what is seen): the LITE program, without them.
    let lite = W.lite === true;
    if (W.lite === 'auto') {
      const cm = g.camera && g.camera.matrixWorld;
      let hy = 1e3;
      if (cm) {
        let gy = T.waterY;
        try { const h = T.heightAt(cm.elements[12], cm.elements[14]); if (h > gy) gy = h; } catch (e) { /* off the field */ }
        hy = cm.elements[13] - gy;
      }
      W.camH = hy;
      lite = !g.fpv && (W.liteNow ? hy > W.liteLo : hy > W.liteHi);
    }
    W.liteNow = !!lite;
    const wk = W.key();   // (a probe's arm may flip W.marchLod: the water's program follows its key)
    if (wk !== this._wk) { if (this._wk !== undefined && T.water.material) T.water.material.needsUpdate = true; this._wk = wk; }
    if (!this._wetAny) { U.uW120Bank.value.x = 0; if (this._ov) this._ov.visible = false; return; }
    try { this._overlay(g, T); } catch (e) { W.ovFails = (W.ovFails || 0) + 1; W.ovErr = String(e && e.message || e); }
    if (this.fords) { T.water.visible = true; if (this._boxMine && T._waterBox !== this._boxMine) { this._boxOrig = T._waterBox; T._waterBox = this._boxMine; } }
    this._t = ((this._t || 0) + dt) % 3600; U.uW120T.value = this._t;
    if (this._skyT >= 0) { this._skyT -= dt; if (this._skyT < 0) { this._sky(g); this._prewarm(g); } }
    else if (this._skyAgain >= 0) { this._skyAgain -= dt; if (this._skyAgain < 0) this._sky(g); }
    this._uniforms(g, dt);
    this._wade(g, dt);
  };
  C.stats = function () {
    return { on: this._on, N: this._N, bodies: this.bodies.slice(0, 8), hs: +this.hs.toFixed(2), buildMs: this.buildMs, skyMs: this.skyMs, fords: this.fords || 0,
      fails: W.fails, groundFails: W.groundFails, ground: !!this._ground, rings: this.rings.length, lite: W.liteNow, skipMean: this.skipMean || 0, rebeds: this.rebeds || 0, rebedMs: this.rebedMs || 0, liveQuads: this.liveQuads || 0, cullFails: W.cullFails || 0, skipDirMean: this.skipDirMean || 0,
      overlay: !!W.groundOverlay, ovTris: this._ovTris || 0, warmMs: this.warmMs || 0, warmHeld: this.warmHeld || 0, warmFails: W.warmFails || 0 };
  };

  // every entry from the loop runs on the cosmetic stream (the wade test draws; three.js objects draw UUIDs)
  ['frame', 'splash'].forEach(function (k) {
    const f = C[k];
    C[k] = function () { const a = arguments, s = this; return cosmetic(function () { return f.apply(s, a); }, s); };
  });

  W.create = function (game) { return new Ctl(game); };
  root.Water120 = W;
})(window);
