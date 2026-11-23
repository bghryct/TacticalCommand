/* ===========================================================================
 * LOOK 120 — the air and the grade (round 120, the LOOK agent)
 * ---------------------------------------------------------------------------
 * Two switches, both OFF by default, both pure drawing (nothing the simulation
 * reads, no random stream, no three.js object made per frame):
 *
 *   game.haze120   AERIAL PERSPECTIVE. The game's haze was `FogExp2`: one flat
 *                  colour, the same whichever way you look, and the same high
 *                  over the field as down on it. Now the haze is
 *                    - LUMINOUS AND SUN-TINTED: brighter and warmer toward the
 *                      sun, a little cooler and darker away from it (a Mie-like
 *                      lobe with no pow);
 *                    - HEIGHT-DEPENDENT: it lies in a layer over the low ground,
 *                      so a level look across the field (first person) keeps
 *                      the old visibility and a look DOWN from the playing
 *                      camera passes through less of it, while the far ground
 *                      and the valleys hold it;
 *                    - DEEPER: a Beer-Lambert term on top of the old exp2, so the
 *                      middle distance (100-300 u) takes the haze the reference
 *                      look has, and the land meets the sky softly;
 *                    - IN AGREEMENT WITH THE DOME: the sky117 dome's horizon band
 *                      takes the same directional colour, so there is no seam.
 *                  `scene.fog.density` and `.color` are still the game's own
 *                  numbers (weather, banks, sky117's horizon cast), and
 *                  `fpvSightRange` reads the same density: what anyone can see
 *                  is unchanged.
 *
 *   game.grade120  A FILMIC SPLIT on top of the box-art grade: amber into the
 *                  highlights, a cool slate into the shadows. Inside the tone
 *                  mapping function, which runs on every pixel anyway (memory:
 *                  normandy-box-art-grade) - never a post pass.
 *
 * HOW THE SWITCHES REACH EVERY PROGRAM (and why OFF is the old drawing exactly)
 *   three r128 keys a program on its parameters; editing a ShaderChunk at run
 *   time reaches nothing that already compiled (the four-identical-frames trap).
 *   So each switch rides a parameter that IS in the key, and the old programs
 *   are never touched:
 *   - haze: the game only ever uses FogExp2. ON puts a stand-in fog on the scene
 *     that says `isFog` (linear), which compiles every fogged material WITHOUT
 *     `FOG_EXP2` - and the linear-fog branch of the fog chunks, dead code in this
 *     game, is where the haze lives. `fog.near` carries the game's density. A
 *     new fog object also makes three re-select every material's program on its
 *     next draw (materialProperties.fog !== fog), parked props included.
 *     OFF puts the game's own FogExp2 back (density and colour carried over):
 *     the exp2 programs, compiled from the stock text, come back from the cache.
 *   - grade: the game only ever uses CustomToneMapping. ON switches the renderer
 *     to CineonToneMapping, whose function (renamed stock one kept) now returns
 *     the box-art grade plus the split. OFF switches back to Custom.
 *   A custom ShaderMaterial that is fogged but lacks `uHaze120` reads zeros and
 *   falls back to the stock exp2 on the view depth and the flat fog colour.
 * ======================================================================== */
(function (root) {
  'use strict';
  var THREE = root.THREE;
  var L = root.Look120 = { ok: false, gradeOk: false, reason: '', gradeReason: '' };

  // Tunables (probe knobs; the defaults are the ones the sheets were taken at).
  L.cfg = {
    aerial: 0.0045,   // Beer-Lambert haze per world unit at the haze floor, clear day (on top of the game's exp2;
                      // 0.0022 was barely visible in the s5 sheets, and the reference's haze would need ~0.01)
    layer: 12,        // the haze layer's scale height, world units (the playing camera, ~55 u up, looks through ~a fifth)
    hmax: 2.2,        // the most a ray below the floor can collect, x the floor density
    lobe: 1.0,        // the sun lobe's tightness: (1 / (1 + lobe (1 - mu)))^2 (broad: a high sun still warms a level view)
    sunGain: 0.40,    // how much brighter the haze is toward the sun (clear sky, sun up)
    warm: 0.55,       // how far the sunward haze moves toward the sun's own hue (x warmCast)
    warmCast: [1.08, 1.0, 0.82],   // the dust and the low sun: a sunward haze is cream, not white
    away: 0.06,       // how much darker the haze is away from the sun
    cool: [-0.025, 0.0, 0.035],     // ...and the cast it takes there (gentle: a battlefield haze is dust, not a blue wall)
    band: 1.8,        // the dome's horizon band, x sky117's (a softer meet)
    nightAerial: 0.45 // the Beer-Lambert term at night, x
  };
  L.gradeCfg = { hi: [1.055, 1.0, 0.905], lo: [0.925, 0.985, 1.085], hiA: 0.20, hiB: 0.80, loA: 0.012, loB: 0.17 };

  // ---------------------------------------------------------------- 1. the shared haze uniform
  // ONE Float32Array, put into every built-in ShaderLib's uniforms. three's cloneUniforms copies a value that is
  // not a Color/Vector/Matrix/Texture/Array BY REFERENCE, so every material's clone shares it: one write a frame.
  //   [0] sun direction xyz, on (0/1)
  //   [1] haze colour toward the sun rgb, Beer-Lambert coefficient
  //   [2] haze colour away from the sun rgb, 1 / layer
  //   [3] haze floor y, hmax, lobe, 0
  var HZ = L.hz = new Float32Array(16);
  // FOUR vec4 uniforms, each a Float32Array VIEW into HZ (not a vec4[4] array): three r128 caches a single vec4 per
  // program and skips the GL call when it has not changed, but uploads an ARRAY uniform on every material switch.
  // The first build used `uniform vec4 uHaze120[4]` and cost +0.5 ms at Village's playing camera (400 draws, one
  // uncached upload each). The values below are written only when they move past a step, so a slow sun does not
  // re-upload them every frame either.
  var HZV = L.hzv = [HZ.subarray(0, 4), HZ.subarray(4, 8), HZ.subarray(8, 12), HZ.subarray(12, 16)];
  var NEXT = new Float32Array(16);

  function installChunks() {
    var C = THREE && THREE.ShaderChunk;
    if (!C) { L.reason = 'no THREE.ShaderChunk'; return false; }
    var F_LIN = 'float fogFactor = smoothstep( fogNear, fogFar, fogDepth );';
    var F_MIX = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
    var ff = C.fog_fragment;
    if (ff.split(F_LIN).length !== 2 || ff.split(F_MIX).length !== 2) { L.reason = 'fog_fragment is not the r128 text this was written against'; return false; }
    if (C.fog_vertex.indexOf('mvPosition') < 0) { L.reason = 'fog_vertex does not use mvPosition'; return false; }
    L._chunks = { pv: C.fog_pars_vertex, v: C.fog_vertex, pf: C.fog_pars_fragment, f: ff };
    C.fog_pars_vertex = C.fog_pars_vertex + [
      '',
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      '\tuniform vec4 uHz120a;',
      '\tuniform vec4 uHz120b;',
      '\tuniform vec4 uHz120c;',
      '\tuniform vec4 uHz120d;',
      '\tvarying vec2 vHaze120;',
      '#endif', ''].join('\n');
    C.fog_vertex = C.fog_vertex + [
      '',
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      '\t{',
      '\t\tvec3 hzV = mvPosition.xyz * mat3( viewMatrix );',                 // camera -> vertex, world axes
      '\t\tfloat hzR = length( hzV );',
      // the camera's height from the view matrix: three r128 uploads `cameraPosition` only to Phong/Standard/Toon/
      // Shader materials (and envMap users), so in a Lambert (the game's material) it read 0 and the haze was 4x
      '\t\tfloat hzCY = - dot( viewMatrix[ 3 ].xyz, viewMatrix[ 1 ].xyz );',
      // a material three gives no view matrix (sprites, points, lines) keeps the stock fog
      '\t\tfloat hzOn = uHz120a.w * step( 1e-6, hzR );',
      '\t\tfloat hzK = uHz120c.w;',
      '\t\tfloat hzY = hzV.y * hzK;',
      // the mean density along the ray, x the floor's: e^-k(yc - floor) (1 - e^-kdy) / kdy
      '\t\tfloat hzH = abs( hzY ) > 1e-3 ? ( 1.0 - exp( - hzY ) ) / hzY : 1.0 - 0.5 * hzY;',
      '\t\thzH = clamp( hzH * exp( - hzK * ( hzCY - uHz120d.x ) ), 0.0, max( uHz120d.y, 1.0 ) );',
      '\t\tfloat hzMu = dot( hzV, uHz120a.xyz ) / max( hzR, 1e-4 );',
      '\t\tfloat hzW = 1.0 / ( 1.0 + uHz120d.z * ( 1.0 - hzMu ) );',
      // with the uniform absent (all zeros) x is 0 and the colour is fogColor: the stock fog exactly
      // x: the height-weighted path, for the aerial term only. The weather's own exp2 keeps the stock view depth:
      // weighting IT by height took the fog off a fog map seen from the playing camera (Purple Heart Lane, s5)
      '\t\tvHaze120 = vec2( hzR * hzH * hzOn, hzW * hzW );',
      '\t}',
      '#endif', ''].join('\n');
    C.fog_pars_fragment = C.fog_pars_fragment + [
      '',
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      '\tuniform vec4 uHz120a;',
      '\tuniform vec4 uHz120b;',
      '\tuniform vec4 uHz120c;',
      '\tuniform vec4 uHz120d;',
      '\tvarying vec2 vHaze120;',
      '#endif', ''].join('\n');
    C.fog_fragment = ff.replace(F_LIN, [
      'float hzT = fogNear * fogDepth;',                                     // the game's exp2, exactly as before
      '\t\tfloat fogFactor = 1.0 - exp( - hzT * hzT - uHz120b.w * vHaze120.x );',
      '\t\tvec3 fogC120 = mix( fogColor, mix( uHz120c.xyz, uHz120b.xyz, vHaze120.y ), uHz120a.w );'].join('\n'))
      .replace(F_MIX, [
        '#ifdef FOG_EXP2',
        '\t' + F_MIX,
        '\t#else',
        '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogC120, fogFactor );',
        '\t#endif'].join('\n'));
    // every built-in program's uniforms (cloned per material at compile; the array goes by reference)
    var n = 0;
    for (var k in THREE.ShaderLib) {
      var s = THREE.ShaderLib[k];
      if (s && s.uniforms && s.uniforms.fogColor && !s.uniforms.uHz120a) {
        s.uniforms.uHz120a = { value: HZV[0] }; s.uniforms.uHz120b = { value: HZV[1] }; s.uniforms.uHz120c = { value: HZV[2] }; s.uniforms.uHz120d = { value: HZV[3] }; n++;
      }
    }
    L.libs = n;
    return true;
  }

  // ---------------------------------------------------------------- 2. the grade's split
  function installGrade() {
    var C = THREE && THREE.ShaderChunk;
    var HEAD = 'vec3 OptimizedCineonToneMapping( vec3 color ) {';
    var t = C && C.tonemapping_pars_fragment;
    if (!t || t.split(HEAD).length !== 2 || t.indexOf('vec3 CustomToneMapping( vec3 color )') < 0) {
      L.gradeReason = 'tonemapping_pars_fragment is not the r128 text this was written against'; return false;
    }
    var g = L.gradeCfg, f = function (a) { return 'vec3( ' + a.map(function (x) { return (+x).toFixed(4); }).join(', ') + ' )'; };
    C.tonemapping_pars_fragment = t.replace(HEAD, 'vec3 OptimizedCineonToneMapping_r128( vec3 color ) {') + [
      '',
      '// (round 120, game.grade120) the box-art grade, then a filmic split: amber into the light, slate into the shade',
      'vec3 OptimizedCineonToneMapping( vec3 color ) {',
      '\tcolor = CustomToneMapping( color );',
      '\tfloat l120 = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );',
      '\tcolor *= mix( vec3( 1.0 ), ' + f(g.hi) + ', smoothstep( ' + (+g.hiA).toFixed(4) + ', ' + (+g.hiB).toFixed(4) + ', l120 ) )',
      '\t       * mix( ' + f(g.lo) + ', vec3( 1.0 ), smoothstep( ' + (+g.loA).toFixed(4) + ', ' + (+g.loB).toFixed(4) + ', l120 ) );',
      '\treturn clamp( color, 0.0, 1.0 );',
      '}', ''].join('\n');
    return true;
  }

  L.ok = installChunks();
  L.gradeOk = installGrade();

  // ---------------------------------------------------------------- 3. the stand-in fog
  function standIn(orig) {
    return { isFog: true, isHaze120: true, name: 'haze120', orig: orig, color: orig.color, density: orig.density, far: 0,
      get near() { return this.density; },
      clone: function () { return this.orig.clone(); }, toJSON: function () { return this.orig.toJSON(); } };
  }
  function hazeOn(g) {
    var f = g.scene && g.scene.fog;
    if (!f) return null;
    if (f.isHaze120) return f;
    var h = L._hf;
    if (!h || h.orig !== f) h = L._hf = standIn(f);
    h.color = f.color; h.density = f.density;
    g.scene.fog = h;
    return h;
  }
  function hazeOff(g) {
    var f = g.scene && g.scene.fog;
    if (f && f.isHaze120) { f.orig.density = f.density; f.orig.color = f.color; g.scene.fog = f.orig; }
  }

  // ---------------------------------------------------------------- 4. the dome's horizon
  var DOME_LINE = 'c = mix(c, uFog, max(uHaze.y, 1.0 - smoothstep(0.0, uHaze.x, y)));';
  function domeBefore(sh) {
    if (sh.fragmentShader.indexOf(DOME_LINE) < 0) { L.domeReason = 'the dome horizon line moved'; return; }
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform vec3 uFog;', 'uniform vec3 uFog;\nuniform vec3 uHz120Sun;\nuniform vec3 uHz120Away;\nuniform vec3 uHz120Dir;\nuniform vec2 uHz120K;')
      .replace(DOME_LINE, [
        '{ float hzW = 1.0 / (1.0 + uHz120K.x * (1.0 - dot(d, uHz120Dir))); hzW *= hzW;',
        '  vec3 hzC = mix(uHz120Away, uHz120Sun, hzW);',
        '  c = mix(c, hzC, max(uHaze.y, 1.0 - smoothstep(0.0, uHaze.x * uHz120K.y, y))); }'].join('\n'));
    L.domeOk = true;
  }
  function setDome(g, on) {
    var dome = g.skyNew, m = dome && dome.mat;
    if (!m) return;
    if (!m.uniforms.uHz120Sun) {
      m.uniforms.uHz120Sun = { value: new THREE.Vector3(0.7, 0.75, 0.8) };
      m.uniforms.uHz120Away = { value: new THREE.Vector3(0.6, 0.7, 0.8) };
      m.uniforms.uHz120Dir = { value: new THREE.Vector3(0, 1, 0) };
      m.uniforms.uHz120K = { value: new THREE.Vector2(1.5, 1.8) };
    }
    var want = !!on;
    if (!!m._hz120 === want) return;
    m._hz120 = want;
    if (want) { m._hz120Prev = m.onBeforeCompile; m.onBeforeCompile = domeBefore; }
    else { m.onBeforeCompile = m._hz120Prev || THREE.ShaderMaterial.prototype.onBeforeCompile; }
    m.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 5. the haze floor
  // The low ground holds the haze: the floor is the 30th percentile of the field's height, read once a map.
  function floorOf(g) {
    var t = g.terrain;
    if (!t || !t.heightAt) return 0;
    var sig = (g.mapDef && g.mapDef.name) || '';
    if (L._floorT === t && L._floorSig === sig && L._floor != null) return L._floor;
    // GRID and cellCenter are the page's top-level `let`/`const`: global lexical bindings, not window properties
    /* global GRID, cellCenter */
    var N = 24, hs = [], G = (typeof GRID === 'number' && GRID > 0) ? GRID : (root.GRID || 224);
    var cc = typeof cellCenter === 'function' ? cellCenter : root.cellCenter;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) {
      var gx = Math.floor((i + 0.5) * G / N), gz = Math.floor((j + 0.5) * G / N);
      var x = cc ? cc(gx) : gx * 1.5, z = cc ? cc(gz) : gz * 1.5;
      var h = t.heightAt(x, z);
      if (isFinite(h)) hs.push(h);
    }
    hs.sort(function (a, b) { return a - b; });
    L._floor = hs.length ? hs[Math.floor(hs.length * 0.3)] : 0;
    L._floorT = t; L._floorSig = sig;
    return L._floor;
  }

  // ---------------------------------------------------------------- 6. once a frame, from _updateDaylight
  var sstep = function (a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  var WXT = [0, 0, 0, 0, 0, 0];
  L.daylight = function (g, elDeg, day, night) {
    if (!g || !g.scene) return;
    // ---- grade120: the renderer's tone-mapping mode, re-asserted (Grade.set/off may have reset it)
    var r = g.renderer;
    if (r && L.gradeOk && root.Grade && root.Grade.ok) {
      var wantG = g.grade120 === true, flip = false;
      if (wantG && r.toneMapping === THREE.CustomToneMapping) { r.toneMapping = THREE.CineonToneMapping; flip = true; }
      else if (!wantG && r.toneMapping === THREE.CineonToneMapping) { r.toneMapping = THREE.CustomToneMapping; flip = true; }
      // the mode is in every program's key; a version bump makes each live material look its program up again
      // (both sets stay cached, so flipping back costs a lookup, not a compile)
      if (flip) {
        L._gradeFlips = (L._gradeFlips || 0) + 1;
        if (g.scene.traverse) g.scene.traverse(function (o) {
          var m = o.material; if (!m) return;
          if (Array.isArray(m)) { for (var i = 0; i < m.length; i++) if (m[i]) m[i].needsUpdate = true; } else m.needsUpdate = true;
        });
      }
    }
    // ---- haze120
    var on = g.haze120 === true && L.ok;
    if (!on) { hazeOff(g); setDome(g, false); HZ[3] = 0; NEXT[3] = 0; return; }
    var f = hazeOn(g);
    if (!f) return;
    var c = L.cfg;
    // the sun: sky117's true direction (the disc sets), else the game's own
    var el = (g.sunElev || 0), az = (g.sunAz || 0);
    var sx = Math.sin(az) * Math.cos(el), sy = Math.sin(el), sz = Math.cos(az) * Math.cos(el);
    // how much sun the haze scatters: the sun up, and a sky that is not a deck
    var cover = 0.34;
    if (root.Sky117 && root.Sky117.weatherOf) { try { cover = root.Sky117.weatherOf(g, WXT)[0]; } catch (e) { cover = 0.34; } }
    var covK = sstep(0.6, 0.95, cover);
    var S = sstep(-3, 5, elDeg) * (1 - 0.85 * covK) * (1 - (night || 0));
    // the sun's hue, at unit luminance
    var sc = g.sun && g.sun.color, hr = 1, hg = 1, hb = 1;
    if (sc) { var lum = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b; if (lum > 1e-4) { hr = sc.r / lum; hg = sc.g / lum; hb = sc.b / lum; } }
    var fc = f.color, b = [fc.r, fc.g, fc.b], hue = [hr, hg, hb];
    var lift = 1 + c.sunGain * S, dark = 1 - c.away * S;
    // toward the sun: the haze's own brightness, carried toward the sun's hue warmed a little (a clear noon's
    // sun is nearly white, and a blue fog colour times a white sun is still blue) - then scaled, never clipped
    // per channel, so the hue survives the lift
    var lb = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2], W = c.warmCast, wh = [0, 0, 0], k;
    for (k = 0; k < 3; k++) wh[k] = Math.min(1.6, hue[k] * W[k]);
    var wl = Math.max(1e-4, 0.2126 * wh[0] + 0.7152 * wh[1] + 0.0722 * wh[2]), m = c.warm * S, mx = 0;
    for (k = 0; k < 3; k++) {
      NEXT[4 + k] = (b[k] + (lb * wh[k] / wl - b[k]) * m) * lift;
      if (NEXT[4 + k] > mx) mx = NEXT[4 + k];
      NEXT[8 + k] = Math.max(0, b[k] * dark * (1 + S * c.cool[k]));
    }
    if (mx > 0.96) for (k = 0; k < 3; k++) NEXT[4 + k] *= 0.96 / mx;
    NEXT[0] = sx; NEXT[1] = sy; NEXT[2] = sz; NEXT[3] = 1;
    NEXT[7] = c.aerial * (c.nightAerial + (1 - c.nightAerial) * (day == null ? 1 : day));
    NEXT[11] = 1 / Math.max(1, c.layer);
    NEXT[12] = floorOf(g); NEXT[13] = c.hmax; NEXT[14] = c.lobe; NEXT[15] = 0;
    // a group is written only when it has moved past a step (or a knob changed): the sun creeps every frame
    for (var q = 0; q < 16; q += 4) {
      var mv = 0;
      for (k = q; k < q + 4; k++) { var dd = Math.abs(NEXT[k] - HZ[k]); if (k === 7 || k === 11 || k >= 12) dd *= 1e6; if (dd > mv) mv = dd; }
      if (mv > 0.0015) for (k = q; k < q + 4; k++) HZ[k] = NEXT[k];
    }
    // the dome's horizon in the same colours
    setDome(g, true);
    var u = g.skyNew && g.skyNew.mat && g.skyNew.mat.uniforms;
    if (u && u.uHz120Sun) {
      u.uHz120Sun.value.set(HZ[4], HZ[5], HZ[6]); u.uHz120Away.value.set(HZ[8], HZ[9], HZ[10]);
      u.uHz120Dir.value.set(sx, sy, sz); u.uHz120K.value.set(c.lobe, c.band);
    }
  };

  /** The haze on the CPU, for a direction and a distance from the camera (for smoke and the like): [r, g, b, factor]. */
  L.hazeAt = function (g, dx, dy, dz, dist) {
    var f = g && g.scene && g.scene.fog;
    if (!f) return [0, 0, 0, 0];
    if (HZ[3] < 0.5 || !f.isHaze120) { var t0 = f.density * dist; return [f.color.r, f.color.g, f.color.b, 1 - Math.exp(-t0 * t0)]; }
    var len = Math.max(1e-4, Math.hypot(dx, dy, dz)), k = HZ[11], ry = dy / len * dist * k;
    var H = Math.abs(ry) > 1e-3 ? (1 - Math.exp(-ry)) / ry : 1 - 0.5 * ry;
    H = Math.min(Math.max(1, HZ[13]), Math.max(0, H * Math.exp(-k * ((g.camera ? g.camera.position.y : 0) - HZ[12]))));
    var mu = (dx * HZ[0] + dy * HZ[1] + dz * HZ[2]) / len, w = 1 / (1 + HZ[14] * (1 - mu)); w *= w;
    var t = f.density * dist;
    return [HZ[8] + (HZ[4] - HZ[8]) * w, HZ[9] + (HZ[5] - HZ[9]) * w, HZ[10] + (HZ[6] - HZ[10]) * w, 1 - Math.exp(-t * t - HZ[7] * dist * H)];
  };

  L.state = function (g) {
    g = g || root.game;
    var f = g && g.scene && g.scene.fog;
    return { ok: L.ok, reason: L.reason, gradeOk: L.gradeOk, gradeReason: L.gradeReason, libs: L.libs, domeOk: !!L.domeOk,
      haze: !!(f && f.isHaze120), toneMapping: g && g.renderer ? g.renderer.toneMapping : null,
      hz: Array.prototype.slice.call(HZ).map(function (x) { return +x.toFixed(5); }) };
  };
})(window);
