/* ===========================================================================
 * WEATHER YOU CAN SEE (round 119) — `game.weather119`, default OFF.
 * ---------------------------------------------------------------------------
 * The weather has been a simulated process since round 24 (`Game.setWeather`,
 * `_updateWeatherBlend`, `_updateWeatherFront`): a front walks the live
 * numbers toward the next preset, the rain RATE builds 0 -> 1 and tapers, the
 * wind builds and veers. What the player SAW of it was the sky and a
 * `THREE.Points` cloud of 2,200 square dots. Nothing fell, nothing got wet.
 *
 * This file is the picture of that state, and only the picture:
 *
 *   PRECIPITATION  GPU-driven streaks (rain, and drizzle at its light end) and
 *                  flakes (snow), two instanced draws. Every drop's place is a
 *                  fixed seed in a box, moved in the VERTEX SHADER by offsets
 *                  the CPU integrates (fall and wind drift per speed class, so
 *                  a change of wind bends the rain without a drop jumping) and
 *                  wrapped into the box — world-locked, so a drop stays where
 *                  it is while the camera pans. No CPU work per drop and not
 *                  the VFX pool (it caps at 3,200). The box is sized to what
 *                  the camera looks at, in steps of root 2 with a cross-fade.
 *                  Rate, kind and the storm's weight come from `weatherFX`
 *                  and the blended weather; slant and drift from `game.wind`.
 *   UNDER COVER    A cap map, one texel per cell: the lowest roof or upper
 *                  floor over it (assets/structures.js). No drop falls under
 *                  a roof — seen from inside a house the rain is out of the
 *                  window — and no floor indoors gets wet or takes snow.
 *   SURFACES       The ground (`assets/groundsplat.js`'s twenty surfaces each
 *                  darken, shine and hold water their own way) and the
 *                  buildings (`assets/fabric.js`'s one material): darker when
 *                  wet, a sky sheen by Fresnel, puddles in hollows, ruts and
 *                  craters (a pool map from the heights, the ruts and the
 *                  surface) with rings when it rains; snow on what faces the
 *                  sky, roofs first and then the ground. Wetness, puddles and
 *                  snow are integrated with their own time constants, so
 *                  nothing snaps: it takes a shower to wet a field and an hour
 *                  of sun to dry it.
 *   FIRST PERSON   No drop is drawn in front of an enemy on screen (the
 *                  owner's rule: in first person no enemy is ever hidden).
 *
 * Determinism: nothing here reads the simulation's random stream or writes
 * anything the simulation reads. The drop seeds come from a private
 * mulberry32; every three.js object is made inside `cosmeticScope`; all of it
 * runs from `Game._loop`, which a seeded probe never runs.
 *
 *   game.weather119 = false                    // the switch (default ON since main's review, 15 Nov)
 *   game.wx119.set({ wet: 1, pud: 0.6 })       // force a surface state (captures)
 *   game.wx119.hold = true                     // …and keep it there
 *   game.wx119.rate = 0.25                     // force the falling rate (drizzle)
 *   game.wx119.stats()
 * ======================================================================== */
(function (root) {
  'use strict';
  const THREE = root.THREE;
  if (!THREE) return;
  const W = { ver: 1 };

  // ---------------------------------------------------------------- knobs
  W.K = {
    rainN: 12000,         // drops at the heaviest rain (one instanced draw). 9,000 read too thin at the playing camera
    snowN: 8000,
    boxMin: 10, boxMax: 170,            // the drop box, world units (RTS)
    boxFpv: 9, boxFpvH: 6,              // …around the eye
    rainV: 2.3, drizV: 0.9, snowV: 0.28, // fall, world units a second (a real 9 m/s, 3.5 m/s, 1.1 m/s)
    rtsRainV: 0.55, rtsSnowV: 0.07,     // RTS: the fall as a share of the box a second (it must cross the screen)
    expoFpv: 0.075, expoRts: 0.032,     // streak length = fall x exposure
    widFpv: 0.005, widRts: 0.0012,      // a streak's drawn width (world; x box in RTS)
    pxMin: 2.0,                         // …never thinner than this many pixels (its alpha pays for the rest)
    alphaRain: 0.36, alphaDriz: 0.32, alphaSnow: 0.9, alphaFpv: 1.3,   // first person: x this (the box is small)
    flakeFpv: 0.006, flakeRts: 0.0028,  // a flake's size (world; x box in RTS)
    flakePx: [1.6, 7.0],
    nearFpv: 0.25, nearRts: 0.12,        // RTS: a share of the box (a drop at the lens is a smear, and the fill is most of the cost)
    pxMax: 2.6, lenMax: 96,               // no streak wider or longer on screen than this (px): the fill is the cost
    nearShade: 28,                        // beyond this (world units from the eye) wet ground takes the cheap sky term only
    skyGain: 1.6,                        // the sky a wet surface reflects, as light against the fog's colour
    snowKey: 0.46,                       // what fresh snow reflects, for the exposure (GROUND_KEY_REF's scale)
    fade: 0.35,                          // cross-fade between two boxes, s
    // the surfaces' clocks, seconds
    wetUp: 18, wetDown: 420, pudUp: 90, pudDown: 520, snowUp: 120, roofUp: 80, melt: 1100, rainMelt: 70,
  };

  // ---------------------------------------------------------------- shared surface uniforms
  const SU = {
    uWxOn: { value: 0 },
    uWxS: { value: new THREE.Vector4() },            // wet, puddles, ground snow, roof snow
    uWxR: { value: new THREE.Vector4() },            // rain intensity, time, -, -
    uWxSky: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uWxZen: { value: new THREE.Color(0.45, 0.5, 0.55) },
    uWxEye: { value: new THREE.Vector3() },
    uWxGrid: { value: new THREE.Vector4(168, 1 / 336, 0, 0) },
    uWxSnowC: { value: new THREE.Vector4(0.45, 0.465, 0.49, 1.06) },
    uWxSun: { value: new THREE.Vector3(0.4, 0.8, 0.3) },               // toward the sun, world
    uWxSunC: { value: new THREE.Color(0, 0, 0) },                      // its light (colour x intensity)
    uWxCap: { value: null },
    uWxPool: { value: null },
  };
  W.uniforms = SU;
  // the ground's twenty surfaces (GroundSplat.LAYERS order): how dark rain makes it, how much it shines, how
  // readily water lies on it
  const LAY = ['grass', 'soil', 'road', 'crops', 'forest', 'sand', 'snow', 'rubble', 'cobble', 'gravel', 'rock', 'grass2',
               'grass3', 'moss', 'mud', 'bog', 'track', 'tarmac', 'needles', 'plough'];
  const DARK  = [0.24, 0.40, 0.40, 0.18, 0.30, 0.32, 0.04, 0.34, 0.42, 0.38, 0.38, 0.24, 0.24, 0.26, 0.36, 0.32, 0.40, 0.44, 0.28, 0.40];
  const GLOSS = [0.12, 0.45, 0.60, 0.08, 0.20, 0.30, 0.10, 0.35, 0.80, 0.40, 0.65, 0.12, 0.12, 0.25, 0.60, 0.75, 0.55, 1.00, 0.18, 0.40];
  const POOL  = [0.25, 0.65, 0.75, 0.15, 0.20, 0.10, 0.00, 0.35, 0.55, 0.40, 0.30, 0.25, 0.25, 0.35, 1.00, 0.90, 0.90, 0.60, 0.15, 0.75];
  W.LAYERS = LAY; W.DARK = DARK; W.GLOSS = GLOSS; W.POOL = POOL;
  const f4 = v => (+v).toFixed(4);
  const arr = a => 'float[20](' + a.map(f4).join(', ') + ')';

  const V_PARS = 'varying vec3 vWxP;\nvarying vec3 vWxN;\n';
  // THE GROUND'S SURFACE, PER VERTEX (a vertex a cell): what it is made of (dark, gloss, pool, snow layer) from the
  // splat weights, and whether it is under the open sky, once a vertex and not twenty multiplies and a texture fetch
  // a pixel (round 119's first cost A/B: +2.45 ms on Ortona in rain, the surfaces' share of it measured separately)
  const V_GROUND_PARS = 'varying vec4 vWxSurf;\nvarying float vWxOpen;\nuniform highp sampler2D uWxCap;\nuniform vec4 uWxGrid;\n';
  const V_GROUND = `{
  float sw[20];
  sw[0] = splatA.x; sw[1] = splatA.y; sw[2] = splatA.z; sw[3] = splatA.w;
  sw[4] = splatB.x; sw[5] = splatB.y; sw[6] = splatB.z; sw[7] = splatB.w;
  sw[8] = splatC.x; sw[9] = splatC.y; sw[10] = splatC.z; sw[11] = splatC.w;
  sw[12] = splatD.x; sw[13] = splatD.y; sw[14] = splatD.z; sw[15] = splatD.w;
  sw[16] = splatE.x; sw[17] = splatE.y; sw[18] = splatE.z; sw[19] = splatE.w;
  float wD[20] = ${arr(DARK)};
  float wG[20] = ${arr(GLOSS)};
  float wP[20] = ${arr(POOL)};
  float ws = 0.0, dk = 0.0, gl = 0.0, po = 0.0;
  for (int i = 0; i < 20; i++) { float w = sw[i]; dk += w * wD[i]; gl += w * wG[i]; po += w * wP[i]; ws += w; }
  vWxSurf = ws > 0.001 ? vec4(dk / ws, gl / ws, po / ws, sw[6] / ws) : vec4(0.30, 0.40, 0.40, 0.0);
  float cap = texture2D(uWxCap, (vWxP.xz + uWxGrid.x) * uWxGrid.y).r;
  vWxOpen = smoothstep(cap - 0.32, cap - 0.06, vWxP.y);
}
`;
  const V_MAIN = `{
  vec4 wxP4 = vec4(transformed, 1.0);
  vec3 wxN3 = objectNormal;
#ifdef USE_INSTANCING
  wxP4 = instanceMatrix * wxP4;
  wxN3 = mat3(instanceMatrix) * wxN3;
#endif
  vWxP = (modelMatrix * wxP4).xyz;
  vWxN = mat3(modelMatrix) * wxN3;
}
`;
  const F_PARS = `
uniform float uWxOn;
uniform vec4 uWxS;
uniform vec4 uWxR;
uniform vec3 uWxSky;
uniform vec3 uWxZen;
uniform vec3 uWxEye;
uniform vec4 uWxGrid;
uniform vec4 uWxSnowC;
uniform highp sampler2D uWxCap;
uniform sampler2D uWxPool;
varying vec3 vWxP;
varying vec3 vWxN;
uniform vec3 uWxSun;
uniform vec3 uWxSunC;
float wxWetF = 0.0; float wxPudF = 0.0; float wxGloss = 0.0; float wxTop = 1.0; float wxShadow = 1.0;
float wxHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), f.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 wxUv(vec2 xz) { return (xz + uWxGrid.x) * uWxGrid.y; }
// 1 under the open sky, 0 under a roof or an upper floor (the cap map); a wall looks a step outward from itself
float wxOpen(vec3 p, vec3 n) {
  vec2 q = p.xz + n.xz * (0.42 * (1.0 - abs(n.y)));
  float cap = texture2D(uWxCap, wxUv(q)).r;
  return smoothstep(cap - 0.32, cap - 0.06, p.y);
}
// the sky a wet surface shows, and the rings a drop makes in a puddle
vec3 wxSkyR(vec3 r) { return mix(uWxSky, uWxZen, clamp(r.y, 0.0, 1.0)); }
vec2 wxRipple(vec2 xz, float near) {
  if (near <= 0.0 || uWxR.x <= 0.01) return vec2(0.0);
  vec2 q = xz * 7.0, ci = floor(q), cf = fract(q) - 0.5;
  float h = wxHash(ci);
  if (h > uWxR.x * 0.9 + 0.1) return vec2(0.0);
  float t = fract(uWxR.y * (0.9 + h * 0.5) + h * 7.3);
  vec2 o = (vec2(wxHash(ci + 7.13), wxHash(ci + 3.71)) - 0.5) * 0.5;
  vec2 d = cf - o; float r = length(d);
  float k = (r - t * 0.5) * 26.0;
  float ring = (abs(k) < 3.14159) ? sin(k) * (1.0 - t) * (1.0 - t) : 0.0;
  return (r > 0.001 ? d / r : vec2(0.0)) * ring * 0.55 * near;
}
`;
  // ---- the ground: after its albedo is complete (the splat, the cell colour)
  const F_GROUND = `
if (uWxOn > 0.5) {
  vec3 wn = normalize(vWxN);
  float flat1 = smoothstep(0.80, 0.97, wn.y);
#ifdef WX_SPLAT
  float wo = vWxOpen;
  float dk = vWxSurf.x, gl = vWxSurf.y, po = vWxSurf.z, sn = vWxSurf.w;
  float wxH = gH;
#else
  float wo = wxOpen(vWxP, wn);
  float dk = 0.30, gl = 0.40, po = 0.40, sn = 0.0;
  float wxH = 0.5;
#endif
  // SNOW lies on what faces the sky, in the hollows of the surface first
  float sc = uWxS.z * wo * smoothstep(0.55, 0.85, wn.y) * (1.0 - sn);
  if (sc > 0.0) {
    float n = wxNoise(vWxP.xz * 0.9) * 0.55 + wxNoise(vWxP.xz * 3.7 + 5.0) * 0.2 + (1.0 - wxH) * 0.25;
    float th = 1.0 - sc * 1.25;
    sc = smoothstep(th, th + 0.16, n);
    diffuseColor.rgb = mix(diffuseColor.rgb, uWxSnowC.rgb * (0.9 + 0.2 * wxH), sc);
  }
  // WET: darker, a little richer, and water lying where the ground holds it
  float wet = uWxS.x * wo * (1.0 - sc);
  float pud = 0.0;
  if (uWxS.y > 0.0 && wet > 0.0 && flat1 > 0.0) {
    float pool = texture2D(uWxPool, wxUv(vWxP.xz)).r;
    float pp = clamp(pool * 0.9 + po * 0.62, 0.0, 1.0) * flat1;
    float th = 1.0 - 0.48 * uWxS.y;
    if (pp * 0.55 + 0.45 > th) {                              // can water stand here at all? (most grass cannot)
      float pn = wxNoise(vWxP.xz * 1.7);
      if (distance(uWxEye, vWxP) < uWxR.z) pn = pn * 0.62 + wxNoise(vWxP.xz * 4.9 + 3.1) * 0.38;   // the finer octave near
      float h = pp * 0.55 + pn * 0.45 - (wxH - 0.5) * 0.1;
      pud = smoothstep(th, th + 0.035, h) * wet;
      wet = min(1.0, wet + smoothstep(th - 0.09, th, h) * 0.25 * uWxS.y);   // the mud at a puddle's edge
    }
  }
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 1.0 + 0.14 * wet);
  // water darkens the hollows of a surface most (the joints between setts, between clods) and stands on its tops
  float top = smoothstep(0.30, 0.72, wxH);
  diffuseColor.rgb *= (1.0 - wet * dk * (1.25 - 0.5 * top)) * (1.0 - pud * 0.30);
  wxWetF = wet; wxPudF = pud; wxGloss = gl; wxTop = mix(0.35, 1.0, top);
}
`;
  // ---- a building (one material draws them all): after fabric.js's courses and tiles
  const F_FABRIC = `
if (uWxOn > 0.5) {
  vec3 wn = normalize(vWxN);
  float wo = wxOpen(vWxP, wn);
  float roof = smoothstep(0.42, 0.62, wn.y);
  // SNOW on what faces the sky and is not too steep to hold it
  float sc = uWxS.w * wo * smoothstep(0.60, 0.86, wn.y);
  if (sc > 0.0) {
    float n = wxNoise(vWxP.xz * 1.3 + vWxP.y * 0.7) * 0.6 + wxNoise(vWxP.xz * 4.3 + 2.0) * 0.4;
    float th = 1.0 - sc * 1.2;
    sc = smoothstep(th, th + 0.14, n);
    diffuseColor.rgb = mix(diffuseColor.rgb, uWxSnowC.rgb * uWxSnowC.w, sc);
  }
  float wet = uWxS.x * wo * mix(0.8, 1.0, roof) * (1.0 - sc);
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 1.0 + 0.10 * wet);
  diffuseColor.rgb *= 1.0 - wet * mix(0.30, 0.26, roof);
  wxWetF = wet; wxGloss = mix(0.22, 0.65, roof);
}
`;
  // ---- the light: the sky in the wet, a mirror in a puddle (before the tone map, so it is light, not paint)
  const F_LIGHT = `
if (uWxOn > 0.5 && (wxWetF > 0.002 || wxPudF > 0.002)) {
  vec3 dE = uWxEye - vWxP;
  float dEye = length(dE);
  // FAR AND DRY OF STANDING WATER: the sky's share and nothing else. From the RTS camera a wet field is darker and a
  // little lifted by the sky; the Fresnel term, the ripples and the sun's glint are a few pixels' worth there and were
  // most of the shading's cost (round 119 cost split).
  if (wxPudF < 0.002 && dEye > uWxR.z) {
    outgoingLight = outgoingLight * (1.0 - 0.05 * wxWetF * wxGloss) + uWxSky * (0.09 * wxWetF * wxGloss * wxTop);
  } else {
  vec3 V = dE / max(dEye, 1e-4);
  vec3 N = normalize(vWxN);
  float pxw = length(fwidth(vWxP.xz));
  vec2 rp = wxRipple(vWxP.xz, wxPudF * (1.0 - smoothstep(0.012, 0.05, pxw)));
  vec3 Np = normalize(vec3(rp.x, 1.0, rp.y));
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float fr = 1.0 - nv; fr *= fr; fr *= fr * (1.0 - nv);
  float sheen = wxWetF * wxGloss * (0.10 + 0.6 * fr) * wxTop;
  float pv = clamp(dot(Np, V), 0.0, 1.0), pf = 1.0 - pv; pf *= pf; pf *= pf;
  float mir = wxPudF * (0.30 + 0.62 * pf);
  vec3 R = reflect(-V, normalize(mix(N, Np, wxPudF)));
  outgoingLight = outgoingLight * (1.0 - mir - sheen * 0.5) + wxSkyR(R) * (sheen + mir);
  // the sun in the wet: a broad glint off the wet ground, a sharp one off standing water (and only in the light)
  float rl = max(dot(R, uWxSun), 0.0), r2 = rl * rl, r4 = r2 * r2, r8 = r4 * r4, r16 = r8 * r8, r32 = r16 * r16;
  outgoingLight += uWxSunC * wxShadow * (wxWetF * wxGloss * wxTop * 0.45 * r32 * r16 + wxPudF * 1.6 * r32 * r32 * r32);
  }
}
`;

  /** Patch a lit material with the weather. `kind`: 'ground' | 'fabric'. Composes with every earlier
   *  onBeforeCompile and program key (and with the grade's `_gradePrevKey` as groundsplat.js does). OFF
   *  (`game.weather119` false) the program is the one the material had: nothing is injected. */
  W.fails = 0;
  W.patched = [];
  function patch(mat, kind) {
    if (!mat || mat._wx119) return false;
    mat._wx119 = kind;
    W.patched = W.patched.filter(m => m._wx119 !== kind || m === mat);   // a new map's building material replaces the last
    W.patched.push(mat);
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      // THE UNIFORMS GO IN WHETHER OR NOT THE CODE DOES. three r128 keeps ONE uniform set per material — the set of
      // the program it last BUILT — and hands it to a program it switches back to from its cache. Built ON, then OFF,
      // then ON again (cached), the ON program ran with the OFF set: the cap map's sampler was never bound, it fell to
      // unit 0 with the ground's texture array, and the ground and every house stopped drawing (session 1).
      Object.assign(sh.uniforms, SU);
      if (!W.on) return;
      const VA = '#include <project_vertex>', FA = '#include <emissivemap_fragment>', FL = '#include <envmap_fragment>';
      if (!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2)) { W.fails++; return; }   // float[20](), highp float maps
      if (sh.vertexShader.indexOf(VA) < 0 || sh.fragmentShader.indexOf(FA) < 0 || sh.fragmentShader.indexOf(FL) < 0
          || sh.vertexShader.indexOf('#include <beginnormal_vertex>') < 0) { W.fails++; return; }
      const splat = kind === 'ground' && sh.fragmentShader.indexOf('vGSplatA') >= 0 && sh.fragmentShader.indexOf('float gH') >= 0
        && sh.vertexShader.indexOf('splatE') >= 0;
      // A BUILDING ADDS NO VARYING. Ortona's houses are 1.9 M triangles, and two more vec3s a vertex was most of what
      // the wet cost there (round 119, cost split): fabric.js already hands the fragment the chunk's position and
      // normal (`vFabP`, `vFabN`), which ARE world space — a chunk mesh sits at the identity.
      const fab = kind === 'fabric' && sh.fragmentShader.indexOf('varying vec3 vFabP;') >= 0 && sh.fragmentShader.indexOf('varying vec3 vFabN;') >= 0;
      // …AND NEITHER DOES THE GROUND beyond what it is made of: groundsplat.js already hands the fragment the world
      // position and normal (`vGPos`, `vGNrm`); only the surface (vec4) and the open sky (float) are new.
      const gsp = splat && sh.vertexShader.indexOf('vGPos = ') >= 0 && sh.vertexShader.indexOf('vGNrm = ') >= 0;
      if (gsp) sh.vertexShader = V_GROUND_PARS + sh.vertexShader.replace(VA, V_GROUND.replace(/vWxP/g, 'vGPos') + VA);
      else if (!fab) sh.vertexShader = V_PARS + (splat ? V_GROUND_PARS : '') + sh.vertexShader.replace(VA, V_MAIN + (splat ? V_GROUND : '') + VA);
      if (splat) sh.fragmentShader = 'varying vec4 vWxSurf;\nvarying float vWxOpen;\n' + sh.fragmentShader;
      // the sun's shadow, as the direct light already took it (a second getShadowMask() is a second set of PCF taps)
      const SHL = 'reflectedLight.directDiffuse *= BRDF_Diffuse_Lambert( diffuseColor.rgb ) * getShadowMask();';
      let fs = sh.fragmentShader;
      if (fs.indexOf(SHL) >= 0) fs = fs.replace(SHL, 'reflectedLight.directDiffuse *= BRDF_Diffuse_Lambert( diffuseColor.rgb ) * (wxShadow = getShadowMask());');
      const own = fab ? '#define vWxP vFabP\n#define vWxN vFabN\n' : gsp ? '#define vWxP vGPos\n#define vWxN vGNrm\n' : '';
      sh.fragmentShader = (splat ? '#define WX_SPLAT\n' : '') + (own ? own + F_PARS.replace('varying vec3 vWxP;\nvarying vec3 vWxN;\n', '') : F_PARS) + fs
        .replace(FA, FA + '\n' + (kind === 'ground' ? F_GROUND : F_FABRIC))
        .replace(FL, FL + '\n' + F_LIGHT);
    };
    const tag = function () { return '|wx119:' + (W.on ? W.ver : 0); };
    const had = mat._gradePrevKey !== undefined;
    const base = had ? mat._gradePrevKey : mat.customProgramCacheKey;
    const mine = function () { return (base ? base.call(this) : '') + tag(); };
    if (had) {
      mat._gradePrevKey = mine;
      mat.customProgramCacheKey = function () { return mine.call(this) + '|g' + ((root.Grade && root.Grade._ver) || 0); };
    } else mat.customProgramCacheKey = mine;
    mat.extensions = Object.assign({}, mat.extensions || {}, { derivatives: true });
    mat.needsUpdate = true;
    return true;
  }
  W.patch = patch;
  function recompile() { for (const m of W.patched) m.needsUpdate = true; }

  // ---------------------------------------------------------------- precipitation
  const P_VS = `
attribute vec2 aCorner;
attribute vec4 aSeed;
uniform vec3 uBoxO;
uniform vec3 uBoxS;
uniform vec4 uFall;
uniform vec4 uDrX;
uniform vec4 uDrZ;
uniform vec3 uDir;
uniform float uLen;
uniform float uWorldW;
uniform float uPxMin;
uniform float uPxMax;
uniform float uLenMax;
uniform vec2 uRes;
uniform float uAlpha;
uniform float uKind;
uniform float uT;
uniform float uFogD;
uniform float uNear;
uniform float uSize;
uniform vec2 uPxClamp;
uniform highp sampler2D uCap;
uniform vec4 uGrid;
uniform mat4 uPV;
uniform vec4 uMask[12];
uniform float uMaskD[12];
uniform int uMaskN;
varying vec2 vC;
varying float vA;
void main() {
  float cls = floor(aSeed.w * 3.999);
  float fall = cls < 0.5 ? uFall.x : cls < 1.5 ? uFall.y : cls < 2.5 ? uFall.z : uFall.w;
  float dx = cls < 0.5 ? uDrX.x : cls < 1.5 ? uDrX.y : cls < 2.5 ? uDrX.z : uDrX.w;
  float dz = cls < 0.5 ? uDrZ.x : cls < 1.5 ? uDrZ.y : cls < 2.5 ? uDrZ.z : uDrZ.w;
  float sp = 0.82 + cls * 0.12;
  vec3 p = aSeed.xyz * uBoxS + vec3(dx, -fall, dz);
  if (uKind > 0.5) {
    float ph = aSeed.w * 37.0 + aSeed.x * 11.0;
    p.x += sin(uT * (0.9 + aSeed.y) + ph) * uSize * 3.0;
    p.z += cos(uT * (0.7 + aSeed.z) + ph * 1.3) * uSize * 3.0;
  }
  p = uBoxO + mod(p - uBoxO, uBoxS);
  float a = uAlpha;
  // NOT UNDER A ROOF: the cap map holds the lowest roof or floor over each cell
  float cap = texture2D(uCap, (p.xz + uGrid.x) * uGrid.y).r;
  if (p.y < cap) a = 0.0;
  vec3 tail = uKind > 0.5 ? p : p - uDir * uLen * sp;
  vec4 cH = uPV * vec4(p, 1.0);
  vec4 cT = uPV * vec4(tail, 1.0);
  if (cH.w < uNear || cT.w < uNear) a = 0.0;
  a *= exp(-(uFogD * cH.w) * (uFogD * cH.w));
  vec2 sH = cH.xy / cH.w, sT = cT.xy / cT.w;
  // FIRST PERSON: no drop over an enemy on screen, nearer than he is
  vec2 c = (sH + sT) * 0.5;
  for (int i = 0; i < 12; i++) {
    if (i >= uMaskN) break;
    vec2 q = abs(c - uMask[i].xy) - uMask[i].zw;
    if (q.x < 0.0 && q.y < 0.0 && cH.w < uMaskD[i]) a = 0.0;
  }
  float focal = projectionMatrix[1][1] * uRes.y * 0.5;
  vec4 pos;
  if (uKind < 0.5) {
    vec2 d = (sH - sT) * uRes * 0.5;
    float L = length(d);
    vec2 dir = L > 0.001 ? d / L : vec2(0.0, 1.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float wpx = uWorldW * focal / cH.w;
    a *= min(1.0, wpx / uPxMin);
    wpx = clamp(wpx, uPxMin, uPxMax);
    // the whole quad at the head's depth, the tail drawn back along the streak on screen (clamped)
    vec2 ndc = sH - (aCorner.y > 0.5 ? 0.0 : min(L, uLenMax)) * dir * 2.0 / uRes;
    ndc += nrm * aCorner.x * wpx / uRes;
    pos = vec4(ndc * cH.w, cH.z, cH.w);
  } else {
    float spx = uSize * focal / cH.w;
    a *= min(1.0, spx / uPxClamp.x);
    spx = clamp(spx, uPxClamp.x, uPxClamp.y);
    pos = cH;
    pos.xy += vec2(aCorner.x, aCorner.y * 2.0 - 1.0) * spx / uRes * pos.w;
  }
  if (a < 0.002) pos = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = pos;
  vC = aCorner;
  vA = a;
}
`;
  const P_FS = `
uniform vec3 uCol;
uniform float uKind;
varying vec2 vC;
varying float vA;
void main() {
  float a;
  if (uKind < 0.5) {
    float across = 1.0 - vC.x * vC.x;
    float along = smoothstep(0.0, 0.45, vC.y) * (1.0 - smoothstep(0.82, 1.0, vC.y) * 0.6);
    a = vA * across * along;
  } else {
    vec2 q = vec2(vC.x, vC.y * 2.0 - 1.0);
    a = vA * (1.0 - smoothstep(0.2, 1.0, dot(q, q)));
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol, a);
}
`;
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  /** Two layers sharing one buffer of drop seeds: a box is replaced by the next size with a cross-fade. */
  function buildPrecip(scene, capU, gridU) {
    const N = Math.max(W.K.rainN, W.K.snowN), rnd = mulberry32(0x119a17);
    const seed = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) seed[i] = rnd();
    const seedA = new THREE.InstancedBufferAttribute(seed, 4);
    const corner = new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2);
    const index = [0, 1, 2, 2, 1, 3];
    const layers = [];
    for (let k = 0; k < 2; k++) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(index);
      geo.setAttribute('aCorner', corner);
      geo.setAttribute('aSeed', seedA);
      geo.instanceCount = 0;
      const mk = [];
      for (let i = 0; i < 12; i++) mk.push(new THREE.Vector4());
      const mat = new THREE.ShaderMaterial({
        // DoubleSide: a streak's quad is laid tail to head along the fall, so which way round its triangles wind on
        // screen depends on which way the rain slants. FrontSide culled every streak (session 6: 0 pixels; the
        // same drops as flakes, 88,546).
        vertexShader: P_VS, fragmentShader: P_FS, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
        uniforms: {
          uBoxO: { value: new THREE.Vector3() }, uBoxS: { value: new THREE.Vector3(1, 1, 1) },
          uFall: { value: new THREE.Vector4() }, uDrX: { value: new THREE.Vector4() }, uDrZ: { value: new THREE.Vector4() },
          uDir: { value: new THREE.Vector3(0, 1, 0) }, uLen: { value: 0.1 }, uWorldW: { value: 0.004 }, uPxMin: { value: W.K.pxMin },
          uPxMax: { value: W.K.pxMax }, uLenMax: { value: W.K.lenMax },
          uRes: { value: new THREE.Vector2(2048, 1536) }, uAlpha: { value: 0 }, uKind: { value: 0 }, uT: { value: 0 },
          uFogD: { value: 0 }, uNear: { value: 0.25 }, uSize: { value: 0.01 }, uPxClamp: { value: new THREE.Vector2(1.6, 7) },
          uCap: capU, uGrid: gridU,
          uMask: { value: mk }, uMaskD: { value: new Float32Array(12) }, uMaskN: { value: 0 }, uPV: { value: new THREE.Matrix4() },
          uCol: { value: new THREE.Color(0.8, 0.85, 0.9) },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = 7; mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.name = 'weather119';
      mesh.raycast = function () {};
      scene.add(mesh);
      layers.push({ mesh, mat, geo, B: 0, fade: 0, want: 0, fall: [0, 0, 0, 0], dx: [0, 0, 0, 0], dz: [0, 0, 0, 0],
                    fpv: false, O: new THREE.Vector3(), S: new THREE.Vector3() });
    }
    return layers;
  }

  // ---------------------------------------------------------------- the controller
  function Ctl(game) {
    this.g = game;
    this.ok = false;
    this.hold = false;
    this.rate = null;           // forced falling rate (captures), null = the weather's
    this.state = { wet: 0, pud: 0, snow: 0, roof: 0, winter: 0, roofAcc: 0 };
    this._on = false; this._map = null; this._t = 0;
    this._capN = 0; this._capRow = 1e9; this._poolRow = 1e9; this._poolT = 0; this._sigT = 0;
    this._cap = null; this._pool = null; this._chunkSig = null;
    this.capU = { value: null }; SU.uWxCap = this.capU;
    this.poolU = { value: null }; SU.uWxPool = this.poolU;
    this.gridU = SU.uWxGrid;
    this.layers = null;
    this.cur = 0;
    this._v = new THREE.Vector3(); this._f = new THREE.Vector3(); this._c = new THREE.Vector3();
    this.I = 0; this.kind = null;
    this.maskN = 0;
    this.ok = true;
  }
  const C = Ctl.prototype;

  function cosmetic(fn, self) {
    return typeof root.cosmeticScope === 'function' ? root.cosmeticScope(fn, self, []) : fn.call(self);
  }
  function gridN() { return typeof GRID !== 'undefined' ? GRID : 224; }   // the page's `let GRID` (shared global scope)
  function tileU() { return typeof TILE !== 'undefined' ? TILE : 1.5; }

  /** Allocate the cap and pool maps for this field size (inside the cosmetic scope: textures draw UUIDs). */
  C._alloc = function (N) {
    cosmetic(function () {
      if (this.capU.value) this.capU.value.dispose();
      if (this.poolU.value) this.poolU.value.dispose();
      this._cap = new Float32Array(N * N).fill(-1e4);
      this._pool = new Uint8Array(N * N);
      const ct = new THREE.DataTexture(this._cap, N, N, THREE.RedFormat, THREE.FloatType);
      ct.magFilter = ct.minFilter = THREE.NearestFilter; ct.generateMipmaps = false; ct.unpackAlignment = 1; ct.needsUpdate = true;
      const pt = new THREE.DataTexture(this._pool, N, N, THREE.RedFormat, THREE.UnsignedByteType);
      pt.magFilter = pt.minFilter = THREE.LinearFilter; pt.generateMipmaps = false; pt.unpackAlignment = 1; pt.needsUpdate = true;
      this.capU.value = ct; this.poolU.value = pt;
      this._capN = N;
      const T = tileU(), WD = N * T;
      this.gridU.value.set(WD / 2, 1 / WD, 1 / N, 0);
    }, this);
  };

  /** The lowest roof or upper floor over a cell (world Y), or -1e4 under the open sky. */
  C._capCell = function (st, N, gx, gz, LV, FH) {
    const c = gz * N + gx;
    if (!st.mask || !st.mask[c] || !st.roofM) return -1e4;
    let cap = -1e4;
    for (let L = 0; L < LV; L++) {
      const i = (L * N + gz) * N + gx;
      if (st.roofM[i]) { const y = st.floorY(gx, gz, L) + FH; if (y > cap) cap = y; }
      if (L > 0 && st.floorM && st.floorM[i]) { const y = st.floorY(gx, gz, L); if (y > cap) cap = y; }
    }
    return cap;
  };
  C._capRows = function (r0, r1) {
    const g = this.g, st = g.structures, N = this._capN, cap = this._cap;
    if (!st || !st.any || !st.roofM) { cap.fill(-1e4, r0 * N, r1 * N); return; }
    const LV = Math.max(1, Math.round(st.roofM.length / (N * N))), FH = (root.Structures && root.Structures.FLOOR_H) || 2.2;
    for (let gz = r0; gz < r1; gz++) for (let gx = 0; gx < N; gx++) cap[gz * N + gx] = this._capCell(st, N, gx, gz, LV, FH);
  };
  /** Where water lies: hollows (below the cells around), ruts and churned ground, and the wet surfaces. 0..255. */
  C._poolRows = function (r0, r1) {
    const g = this.g, T = g.terrain, N = this._capN, P = this._pool;
    if (!T || !T.h || T.h.length !== N * N) return;
    const h = T.h, rut = T.rut, ty = T.type, TY = root.TYPE || (typeof TYPE !== 'undefined' ? TYPE : {});
    const wetT = new Set([TY.mud, TY.swamp, TY.marsh, TY.muddytrack, TY.bog, TY.wetmeadow, TY.ploughed, TY.trench].filter(v => v != null));
    const roadT = new Set([TY.road, TY.dirttrack, TY.ford].filter(v => v != null));
    const water = TY.water;
    for (let z = r0; z < r1; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (x === 0 || z === 0 || x === N - 1 || z === N - 1) { P[i] = 0; continue; }
        const t = ty[i];
        if (t === water) { P[i] = 0; continue; }
        const avg = (h[i - 1] + h[i + 1] + h[i - N] + h[i + N]) * 0.25;
        const hol = Math.max(0, Math.min(1, (avg - h[i]) * 0.9));
        let v = hol * 0.75 + (rut ? rut[i] * 0.55 : 0);
        if (wetT.has(t)) v += 0.22; else if (roadT.has(t)) v += 0.12;
        P[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
    }
  };
  /** Work the maps a slice at a time; restart a sweep when the town or the ground changed. */
  C._cover = function (dt) {
    const g = this.g, N = gridN();
    if (N !== this._capN || !this._cap) { this._alloc(N); this._capRow = 0; this._poolRow = 0; this._chunkSig = null; }
    const st = g.structures;
    // what the town looks like now: a rebuilt chunk is a new mesh (Object3D ids are a counter, not random)
    this._sigT -= dt;
    if (this._sigT <= 0 && st && st.chunks && this._capRow >= N && this._chunkSig && this._chunkSig.length === st.chunks.length) {
      this._sigT = 0.5;
      const n = st.chunks.length;
      let any = false;
      const CH = Math.max(1, Math.round(N / Math.max(1, st.NC || Math.sqrt(n))));
      for (let k = 0; k < n; k++) {
        const c = st.chunks[k], id = c && c.mesh ? c.mesh.id : 0;
        if (id === this._chunkSig[k]) continue;
        this._chunkSig[k] = id;
        if (!c) continue;
        const x0 = c.cx * CH, z0 = c.cz * CH, x1 = Math.min(N, x0 + CH), z1 = Math.min(N, z0 + CH);
        const LV = st.roofM ? Math.max(1, Math.round(st.roofM.length / (N * N))) : 1, FH = (root.Structures && root.Structures.FLOOR_H) || 2.2;
        for (let gz = z0; gz < z1; gz++) for (let gx = x0; gx < x1; gx++) this._cap[gz * N + gx] = this._capCell(st, N, gx, gz, LV, FH);
        any = true;
      }
      if (any && this.capU.value) this.capU.value.needsUpdate = true;
    }
    const ROWS = 56;
    if (this._capRow < N) {
      // the town as the sweep starts: a chunk rebuilt during or after it is a new mesh id, and is redone alone
      if (this._capRow === 0) {
        const n = st && st.chunks ? st.chunks.length : 0;
        this._chunkSig = new Int32Array(n);
        for (let k = 0; k < n; k++) { const c = st.chunks[k]; this._chunkSig[k] = c && c.mesh ? c.mesh.id : 0; }
      }
      const r1 = Math.min(N, this._capRow + ROWS);
      this._capRows(this._capRow, r1);
      this._capRow = r1;
      if (r1 >= N && this.capU.value) this.capU.value.needsUpdate = true;
    }
    // the pool map again every few seconds while there is water about (craters are dug mid-battle)
    this._poolT -= dt;
    if (this._poolRow >= N && this._poolT <= 0 && this.state.wet > 0.01) { this._poolRow = 0; }
    if (this._poolRow < N) {
      const r1 = Math.min(N, this._poolRow + ROWS);
      this._poolRows(this._poolRow, r1);
      this._poolRow = r1;
      if (r1 >= N) { if (this.poolU.value) this.poolU.value.needsUpdate = true; this._poolT = 6; }
    }
  };

  /** The state a map opens in: it has been raining if the map says rain; a winter map has snow on its roofs. */
  C._initFor = function (g) {
    const s = this.state, k = g.weatherKey;
    let snowCells = 0, n = 0;
    const T = g.terrain, TY = root.TYPE || (typeof TYPE !== 'undefined' ? TYPE : null);
    if (T && T.type && TY) {
      const ty = T.type, step = Math.max(1, Math.floor(ty.length / 20000));
      for (let i = 0; i < ty.length; i += step) { n++; if (ty[i] === TY.snow || ty[i] === TY.ice) snowCells++; }
    }
    s.winter = (n && snowCells / n > 0.3) || g.season === 'winter' ? 1 : 0;
    const rainy = k === 'rain' || k === 'storm', snowy = k === 'snow';
    s.wet = rainy ? 1 : 0;
    s.pud = rainy ? (k === 'storm' ? 0.85 : 0.65) : 0;
    s.snow = snowy && !s.winter ? 0.8 : 0;
    s.roofAcc = snowy ? 0.95 : 0;
    s.roof = Math.max(s.roofAcc, s.winter ? 0.92 : 0);
    this._capRow = 0; this._poolRow = 0; this._chunkSig = null;
  };

  /** What is falling, and how hard: `weatherFX` (the round-24 particles) carries the kind and the rate a
   *  front has walked to; storm against rain is read off the blended fog. */
  C._falling = function (g) {
    const fx = g.weatherFX;
    let kind = fx && fx.kind ? fx.kind : null, rate = fx ? (fx.rate === undefined ? 1 : fx.rate) : 0;
    if (this.rate != null) { rate = this.rate; if (!kind) kind = g.weatherKey === 'snow' ? 'snow' : 'rain'; }
    if (!kind || rate <= 0.02) return { kind: null, rate: 0, I: 0 };
    let I = rate;
    if (kind === 'rain') {
      const fog = g.weather && g.weather.fog != null ? g.weather.fog : 0.0075;
      const storm = Math.max(0, Math.min(1, (fog - 0.0075) / (0.011 - 0.0075)));
      I = rate * (0.62 + 0.38 * storm);
    }
    return { kind, rate, I };
  };

  C._integrate = function (g, dt, F) {
    const s = this.state, K = W.K;
    if (this.hold) return;
    const light = g.weather && g.weather.light != null ? g.weather.light : 1;
    const rainI = F.kind === 'rain' ? F.I : 0, snowR = F.kind === 'snow' ? F.rate : 0;
    // wet: a shower wets the field in a minute or so; it dries over the better part of an hour (faster in sun and wind)
    if (rainI > 0.01) {
      const tgt = Math.min(1, 0.5 + 0.8 * rainI);
      const tau = tgt > s.wet ? K.wetUp / (0.3 + rainI) : 150;
      s.wet += (tgt - s.wet) * (1 - Math.exp(-dt / tau));
    } else {
      const w = g.wind ? Math.hypot(g.wind.x, g.wind.z) : 0;
      s.wet -= s.wet * (1 - Math.exp(-dt * (0.6 + 0.6 * light + 0.25 * w) / K.wetDown));
    }
    // puddles: only from steady rain, and they outlast the wet
    if (rainI > 0.3) s.pud += (Math.min(1, rainI * 1.3) * s.wet - s.pud) * (1 - Math.exp(-dt / K.pudUp));
    else s.pud -= s.pud * (1 - Math.exp(-dt / K.pudDown));
    // snow: settles on the ground in a couple of minutes, on roofs sooner; rain takes it off, the sun slowly
    if (snowR > 0.02) {
      if (!s.winter) s.snow = Math.min(1, s.snow + snowR * dt / K.snowUp);
      s.roofAcc = Math.min(1, s.roofAcc + snowR * dt / K.roofUp);
    } else {
      const m = rainI > 0.01 ? dt / K.rainMelt : dt * light / K.melt;
      s.snow = Math.max(0, s.snow - m); s.roofAcc = Math.max(0, s.roofAcc - m);
    }
    s.roof = Math.max(s.roofAcc, s.winter ? 0.92 : 0);
  };

  /** Two boxes of drops; `want` 1 for the box that fits the camera now, 0 for the one fading out. */
  C._place = function (g, dt, F) {
    const K = W.K, cam = g.camera, fpv = !!(g.fpv && !g.hk);
    const fwd = cam.getWorldDirection(this._f);
    let B, H, cx, cy, cz;
    if (fpv) {
      B = K.boxFpv; H = K.boxFpvH;
      const hl = Math.hypot(fwd.x, fwd.z) || 1;
      cx = cam.position.x + fwd.x / hl * B * 0.3; cz = cam.position.z + fwd.z / hl * B * 0.3; cy = cam.position.y + 1.0;
    } else {
      const t = g.cameraRig ? g.cameraRig.target : cam.position;
      const cd = cam.position.distanceTo(t);
      const raw = Math.max(K.boxMin, Math.min(K.boxMax, cd * 0.8));
      const lv = Math.round(Math.log(raw) / Math.log(Math.SQRT2));
      B = Math.pow(Math.SQRT2, lv);
      const L0 = this.layers[this.cur];
      if (L0.B && !L0.fpv && Math.abs(Math.log(L0.B / raw)) < Math.log(Math.SQRT2) * 0.75) B = L0.B;   // hysteresis
      H = B * 0.8;
      cx = cam.position.x + fwd.x * B * 0.5; cy = cam.position.y + fwd.y * B * 0.5; cz = cam.position.z + fwd.z * B * 0.5;
    }
    let L = this.layers[this.cur];
    if (L.B !== B || L.fpv !== fpv) {
      if (L.B && L.fade > 0.01) { L.want = 0; this.cur ^= 1; L = this.layers[this.cur]; }
      L.B = B; L.fpv = fpv; L.fade = L.fade || 0;
      for (let i = 0; i < 4; i++) { L.fall[i] = 0; L.dx[i] = 0; L.dz[i] = 0; }
    }
    L.want = 1; L.H = H;
    L.S.set(B, H, B); L.O.set(cx - B / 2, cy - H / 2, cz - B / 2);
    for (const Q of this.layers) {
      const sp = dt / K.fade;
      Q.fade = Q.want ? Math.min(1, Q.fade + sp) : Math.max(0, Q.fade - sp);
    }
  };

  /** Drive both layers' uniforms. */
  C._precip = function (g, dt, F) {
    const K = W.K, kind = F.kind, I = F.I;
    if (!this.layers) this.layers = cosmetic(function () { return buildPrecip(g.scene, this.capU, this.gridU); }, this);
    if (!kind || this.noPrecip) { for (const Q of this.layers) { Q.mesh.visible = false; Q.fade = 0; Q.want = 0; } return; }
    this._place(g, dt, F);
    const cam = g.camera, r = g.renderer, sz = r.getDrawingBufferSize ? r.getDrawingBufferSize(this._v) : { x: 2048, y: 1536 };
    const snow = kind === 'snow';
    const s = snow ? 1 : smoothstep(0.08, 0.6, I);   // 0 drizzle .. 1 rain
    // this frame's camera (set above in _loop), once: projection x view
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const PV = this._pv || (this._pv = new THREE.Matrix4());
    PV.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const W0 = g.wind || { x: 0, z: 0 };
    const day = g._daylight == null ? 1 : g._daylight, light = g.weather && g.weather.light != null ? g.weather.light : 1;
    const fog = g.scene.fog, fc = fog ? fog.color : new THREE.Color(0.6, 0.65, 0.7);
    const fogD = fog && fog.density != null ? fog.density : 0;
    for (const Q of this.layers) {
      if (Q.fade <= 0.001 || !Q.B) { Q.mesh.visible = false; continue; }
      const m = Q.mat.uniforms, fpv = Q.fpv;
      const phys = snow ? K.snowV : K.drizV + (K.rainV - K.drizV) * s;
      const v = fpv ? phys : Math.max(phys, Q.B * (snow ? K.rtsSnowV : K.rtsRainV) * (snow ? 1 : 0.55 + 0.45 * s));
      const wk = v / phys;                                     // the wind's share scales with the fall: the slant stays true
      const wx = W0.x * wk * (snow ? 1.6 : 1), wz = W0.z * wk * (snow ? 1.6 : 1);
      for (let i = 0; i < 4; i++) {
        const c = 0.82 + i * 0.12;
        Q.fall[i] = (Q.fall[i] + v * c * dt) % Q.H;
        Q.dx[i] = (Q.dx[i] + wx * c * dt) % Q.B;
        Q.dz[i] = (Q.dz[i] + wz * c * dt) % Q.B;
      }
      m.uFall.value.set(Q.fall[0], Q.fall[1], Q.fall[2], Q.fall[3]);
      m.uDrX.value.set(Q.dx[0], Q.dx[1], Q.dx[2], Q.dx[3]);
      m.uDrZ.value.set(Q.dz[0], Q.dz[1], Q.dz[2], Q.dz[3]);
      m.uBoxO.value.copy(Q.O); m.uBoxS.value.copy(Q.S);
      m.uDir.value.set(-wx, v, -wz).normalize().negate();
      m.uLen.value = v * (fpv ? K.expoFpv : K.expoRts) * (0.55 + 0.45 * s);
      m.uWorldW.value = fpv ? K.widFpv * (0.6 + 0.4 * s) : Q.B * K.widRts * (0.6 + 0.4 * s);
      m.uPxMin.value = K.pxMin;
      m.uRes.value.set(sz.x, sz.y);
      m.uKind.value = snow ? 1 : 0;
      m.uT.value = this._t;
      m.uFogD.value = fogD * (fpv ? 0.6 : 0.8);
      m.uNear.value = fpv ? K.nearFpv : K.nearRts * Q.B;
      m.uPxMax.value = K.pxMax; m.uLenMax.value = K.lenMax;
      m.uSize.value = fpv ? K.flakeFpv : Q.B * K.flakeRts;
      m.uPxClamp.value.set(K.flakePx[0], K.flakePx[1]);
      const lit = (0.35 + 0.65 * day) * (0.75 + 0.25 * light);
      if (snow) m.uCol.value.setRGB(0.93 * lit + 0.05, 0.95 * lit + 0.05, 0.98 * lit + 0.05);
      else m.uCol.value.setRGB(fc.r, fc.g, fc.b).lerp(this._white || (this._white = new THREE.Color(1, 1, 1)), 0.5).multiplyScalar(0.55 + 0.45 * lit);
      const base = (snow ? K.alphaSnow : K.alphaDriz + (K.alphaRain - K.alphaDriz) * s) * (fpv && !snow ? K.alphaFpv : 1);
      m.uAlpha.value = base * Q.fade * (snow ? 0.6 + 0.4 * F.rate : 0.75 + 0.25 * I);
      // how many drops: most of the box at a downpour, half of it in drizzle (finer and fainter, not fewer)
      const NN = snow ? K.snowN : K.rainN;
      Q.geo.instanceCount = Math.max(0, Math.min(NN, Math.round(NN * (snow ? 0.25 + 0.75 * F.rate : 0.6 + 0.4 * I))));
      // first person: the enemies on screen
      m.uPV.value.copy(PV);
      m.uMaskN.value = fpv ? this.maskN : 0;
      if (fpv && this.maskN) { for (let i = 0; i < this.maskN; i++) { m.uMask.value[i].copy(this._mask[i]); m.uMaskD.value[i] = this._maskD[i]; } }
      Q.mesh.visible = Q.geo.instanceCount > 0 && m.uAlpha.value > 0.002;
    }
  };

  /** First person: a screen box over every enemy in view (up to twelve, nearest first). No drop nearer than
   *  he is is drawn inside it — the rule is that no enemy is ever hidden in first person. */
  C._fpvMask = function (g) {
    this.maskN = 0;
    if (!g.fpv || g.hk) return;
    const cam = g.camera;
    cam.updateMatrixWorld();                                   // this frame's eye (set by _updateFpvCam above), not the last
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const P = cam.projectionMatrix.elements, me = cam.matrixWorldInverse.elements;
    if (!this._mask) { this._mask = []; for (let i = 0; i < 12; i++) this._mask.push(new THREE.Vector4()); this._maskD = new Float32Array(12); this._cand = []; }
    const cand = this._cand; cand.length = 0;
    const pt = g.playerTeam, cp = cam.position;
    const hostile = typeof root.areHostile === 'function' ? root.areHostile : (typeof areHostile === 'function' ? areHostile : (a, b) => a !== b);
    for (const u of g.units) {
      if (!u.alive || !hostile(u.team, pt)) continue;
      const dx = u.pos.x - cp.x, dz = u.pos.z - cp.z, d2 = dx * dx + dz * dz;
      if (d2 > 260 * 260) continue;
      const veh = !!(u.def && u.def.vehicle), r = veh ? 1.5 : 0.34, hy = veh ? 0.6 : 0.24;
      const x = u.pos.x, y = (u.pos.y || 0) + hy, z = u.pos.z;
      // view space
      const vx = me[0] * x + me[4] * y + me[8] * z + me[12], vy = me[1] * x + me[5] * y + me[9] * z + me[13], vz = me[2] * x + me[6] * y + me[10] * z + me[14];
      const w = -vz;
      if (w < 0.05) continue;
      const nx = (P[0] * vx + P[8] * vz) / w, ny = (P[5] * vy + P[9] * vz) / w;
      const hx = P[0] * r / w + 0.01, hyy = P[5] * (veh ? 1.0 : 0.36) / w + 0.01;
      if (nx - hx > 1 || nx + hx < -1 || ny - hyy > 1 || ny + hyy < -1) continue;
      cand.push({ d: w, nx, ny, hx, hy: hyy, far: w + r });
    }
    cand.sort((a, b) => a.d - b.d);
    const n = Math.min(12, cand.length);
    for (let i = 0; i < n; i++) { const c = cand[i]; this._mask[i].set(c.nx, c.ny, c.hx, c.hy); this._maskD[i] = c.far; }
    this.maskN = n;
  };

  /** The surfaces' uniforms. */
  C._surfaces = function (g) {
    const s = this.state;
    const any = s.wet > 0.002 || s.pud > 0.002 || s.snow > 0.002 || s.roof > 0.002;
    SU.uWxOn.value = any && !this.noSurf ? 1 : 0;
    SU.uWxS.value.set(s.wet, s.pud, s.snow, s.roof);
    SU.uWxR.value.set(this.kind === 'rain' ? this.I : 0, this._t, W.K.nearShade, 0);
    SU.uWxEye.value.copy(g.camera.position);
    const sun = g.sun;
    if (sun && sun.target) {
      SU.uWxSun.value.set(sun.position.x - sun.target.position.x, sun.position.y - sun.target.position.y, sun.position.z - sun.target.position.z).normalize();
      const k = (sun.intensity || 0) * 0.55;
      SU.uWxSunC.value.setRGB(sun.color.r * k, sun.color.g * k, sun.color.b * k);
    }
    const fc = g.scene.fog ? g.scene.fog.color : null;
    if (fc) {
      // the horizon the dome shows, as light (the dome is drawn untone-mapped; this goes in before the curve)
      const k = W.K.skyGain * (0.25 + 0.75 * (g._daylight == null ? 1 : g._daylight));
      SU.uWxSky.value.setRGB(fc.r * k, fc.g * k, fc.b * k);
      SU.uWxZen.value.setRGB(fc.r * k * 0.72, fc.g * k * 0.76, fc.b * k * 0.84);
    }
  };

  function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  /** SNOW ON A GREEN MAP IS A SNOWFIELD. The exposure stops down for a bright ground (`_updateDaylight`'s
   *  `albedoStop`, from the map's baked `groundKey`), so Winter Crossroads' snow reads grey-white; snow that settles
   *  on Village did not change the key and burned out. Recomputed every frame after `_updateDaylight` has set the
   *  exposure afresh, so it never compounds. */
  C._exposure = function (g) {
    const s = this.state, T = g.terrain;
    if (!(s.snow > 0.01) || !T || !T.groundKey || !g.renderer) return;
    const REF = typeof GROUND_KEY_REF !== 'undefined' ? GROUND_KEY_REF : 0.24, POW = typeof GROUND_KEY_POW !== 'undefined' ? GROUND_KEY_POW : 0.65;
    const k0 = T.groundKey, k1 = k0 * (1 - s.snow) + W.K.snowKey * s.snow;
    const st = k => (k > REF ? Math.max(0.5, Math.pow(REF / k, POW)) : 1);
    g.renderer.toneMappingExposure *= st(k1) / st(k0);
  };

  /** Called from `Game._loop` after the round-24 weather, every frame. */
  C.frame = function (g, dt) {
    const on = g.weather119 === true;
    if (on !== this._on) this._switch(g, on);
    if (!on) return;
    dt = Math.max(0, Math.min(0.25, dt || 0));
    this._t = (this._t + dt) % 600;
    // the surfaces this patches: the ground (after groundsplat.js has patched it) and the one building material
    const T = g.terrain;
    if (T && T.mesh && T.mesh.material && !T.mesh.material._wx119 && (T.mesh.material.userData.groundSplat || !root.GroundSplat || this._waitT > 8)) patch(T.mesh.material, 'ground');
    this._waitT = (this._waitT || 0) + dt;
    const st = g.structures;
    if (st && st.mat && !st.mat._wx119) patch(st.mat, 'fabric');
    if (g.mapDef !== this._map || T !== this._terr) { this._map = g.mapDef; this._terr = T; this._initFor(g); }
    const F = this._falling(g);
    this.kind = F.kind; this.I = F.I;
    this._integrate(g, dt, F);
    this._cover(dt);
    this._fpvMask(g);
    this._precip(g, dt, F);
    this._surfaces(g);
    this._exposure(g);
    if (g.weatherFX && g.weatherFX.points) g.weatherFX.points.visible = false;   // the round-24 dots: this draws instead
  };
  C._switch = function (g, on) {
    this._on = on; W.on = on;
    recompile();
    if (!on) {
      if (this.layers) for (const Q of this.layers) { Q.mesh.visible = false; Q.fade = 0; Q.want = 0; Q.B = 0; }
      SU.uWxOn.value = 0;
      const fx = g.weatherFX;
      if (fx && fx.points) fx.points.visible = (fx.rate === undefined ? 1 : fx.rate) > 0.02;
    } else {
      this._map = null;   // the state a map opens in
    }
  };
  /** Force a surface state (for captures and probes). */
  C.set = function (o) {
    const s = this.state;
    for (const k of ['wet', 'pud', 'snow', 'roofAcc', 'winter']) if (o[k] != null) s[k] = +o[k];
    if (o.roof != null) s.roofAcc = +o.roof;
    s.roof = Math.max(s.roofAcc, s.winter ? 0.92 : 0);
    if (this.g) this._surfaces(this.g);
    return Object.assign({}, s);
  };
  C.stats = function () {
    const L = this.layers || [];
    return { on: this._on, kind: this.kind, I: +this.I.toFixed(3), state: Object.assign({}, this.state),
             layers: L.map(Q => ({ B: Q.B, fpv: Q.fpv, fade: +Q.fade.toFixed(2), n: Q.geo.instanceCount, vis: Q.mesh.visible })),
             capN: this._capN, capDone: this._capRow >= this._capN, mask: this.maskN, fails: W.fails, patched: W.patched.map(m => m._wx119) };
  };

  W.create = function (game) { return new Ctl(game); };
  W.on = false;
  root.Weather119 = W;
})(window);
