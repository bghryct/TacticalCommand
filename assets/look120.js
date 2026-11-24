/* ===========================================================================
 * LOOK 120 — the air and the grade (round 120: LOOK, then LOOK-2)
 * ---------------------------------------------------------------------------
 * Two switches, both OFF by default, both pure drawing (nothing the simulation
 * reads, no random stream, no three.js object made per frame):
 *
 *   game.haze120   AERIAL PERSPECTIVE with a CLEAR NEAR ZONE (LOOK-2). The
 *                  game's haze was `FogExp2`: one flat colour, and so light at
 *                  the playing camera that the far field read as crisp as the
 *                  ground underfoot. Now, on top of the weather's own exp2:
 *                    - NOTHING inside the near zone: out to about rifle range in
 *                      first person (`nearFpv`), and from the RTS camera out to
 *                      what it looks at plus `nearAdd` - so the men you are
 *                      fighting with stay crisp at every zoom;
 *                    - past it, a Beer-Lambert haze (`aerial` per unit), capped
 *                      at `fmax` so a far treeline is a pale ghost, never a flat
 *                      wall, lying in a broad layer over the low ground
 *                      (`layer`: the density at the ray's mean height, one exp);
 *                    - WARM AND LUMINOUS: the haze takes the theatre's dust
 *                      (Normandy summer gold, desert and steppe ochre, winter
 *                      blue-white) at the horizon's own brightness, lifted a
 *                      little on a clear day; greyer under a deck and in rain;
 *                      brighter and warmer toward the sun, cooler away (a lobe
 *                      with no pow);
 *                    - UNITS TAKE A SHARE (`unitShare`) of the aerial term (every
 *                      UnitShade material: men, vehicles, guns), so a man in the
 *                      open never melts into the haze;
 *                    - the sky117 dome's horizon band takes the same colours and
 *                      widens (`band`, `veil`): a cream low sky, no seam.
 *                  The whole haze factor is worked out PER VERTEX (two exp) and
 *                  the fragment only mixes - fewer fragment ops than the stock
 *                  exp2 it replaces. `scene.fog.density` and `.color` are still
 *                  the game's own numbers (weather, banks, sky117's horizon
 *                  cast), and `fpvSightRange` reads the same density: what
 *                  anyone can see, sight and fog of war, are unchanged.
 *
 *   game.grade120  A FILMIC SPLIT folded INTO the box-art grade (LOOK-2): the
 *                  Cineon slot holds a copy of the installed CustomToneMapping
 *                  whose gentle split line is replaced by a stronger one -
 *                  amber into the light, slate into the shade - so ON costs the
 *                  same few ALU as OFF (no second function, no pass).
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
 *     to CineonToneMapping, whose function (renamed stock one kept) is the graded
 *     copy. OFF switches back to Custom.
 *   - units: UnitShade.material is wrapped so a unit's vertex shader starts with
 *     `#define HZ120_UNIT`, read only inside the haze branch: the exp2 programs
 *     (OFF) compile to the same code.
 *   A custom ShaderMaterial that is fogged but lacks the haze uniforms reads
 *   zeros and falls back to the stock exp2 on the view depth and the flat colour.
 * ======================================================================== */
(function (root) {
  'use strict';
  var THREE = root.THREE;
  var L = root.Look120 = { ok: false, gradeOk: false, reason: '', gradeReason: '', version: 2 };

  // Tunables (probe knobs; the defaults are the ones the LOOK-2 sheets were taken at).
  L.cfg = {
    aerial: 0.0095,   // Beer-Lambert haze per world unit PAST the near zone, clear day, at the haze floor (s7: 0.006 read
                      // only at the horizon; the reference's depth wants the trees at 100-150 u half gone)
    fmax: 0.90,       // the most the aerial term takes: a far treeline stays a pale ghost
    nearFpv: 45,      // the near zone in first person, world units (a rifle's range, 44 u): no aerial haze inside it
    nearAdd: 25,      // ...from the RTS camera: its distance to what it looks at, plus this
    layer: 100,       // the haze layer's scale height over the floor (the playing camera, ~60 u up, keeps most of it)
    unitShare: 0.4,   // men, vehicles and guns take this share of the aerial term
    dust: 0.85,       // how far a clear day's haze takes the theatre's dust colour
    lift: 0.16,       // ...and how much brighter than the horizon it is (luminous, not grey)
    grey: 0.6,        // under a deck, in rain and fog: how far toward its own grey the haze goes
    lobe: 1.0,        // the sun lobe's tightness: (1 / (1 + lobe (1 - mu)))^2 (broad: a high sun still warms a level view)
    sunGain: 0.40,    // how much brighter the haze is toward the sun (clear sky, sun up)
    warm: 0.55,       // how far the sunward haze moves toward the sun's own hue (x warmCast)
    warmCast: [1.08, 1.0, 0.82],
    away: 0.06,       // how much darker the haze is away from the sun
    cool: [-0.025, 0.0, 0.035],
    band: 3.5,        // the dome's horizon band, x sky117's, on a clear day (a cream low sky); 1.3 under a deck
    veil: 0.30,       // the haze over the whole dome on a clear day (a milky summer sky, not a postcard blue)
    nightAerial: 0.45 // the aerial term at night, x
  };
  // The theatres' dust, in display space (fog is applied after the tone map and the encode in three r128).
  L.DUST = {
    summer: [0.96, 0.89, 0.71],   // Normandy, Italy, the Low Countries in summer: gold
    desert: [0.94, 0.79, 0.55],   // ochre
    steppe: [0.94, 0.84, 0.62],   // dry ochre-gold
    winter: [0.85, 0.90, 0.98]    // blue-white
  };
  // grade120: the split folded into the installed grade (see installGrade). l is linear luma (before the encode).
  // The split tapers to nothing at white ((1 - l)) and stops growing at l 0.38: s7's straight split turned a snowfield
  // beige, and s9's (hi 0.30) still creamed it.
  L.gradeCfg = { pivot: 0.18, lo: -0.16, hi: 0.20, split: [0.70, 0.15, -0.70] };

  // ---------------------------------------------------------------- 1. the shared haze uniform
  // ONE Float32Array; FIVE vec4 uniforms, each a VIEW into it, put into every built-in ShaderLib's uniforms. three's
  // cloneUniforms copies a value that is not a Color/Vector/Matrix/Texture/Array BY REFERENCE, so every material's
  // clone shares it: one write a frame. Single vec4s, never a vec4[] (r128 uploads an array uniform on every material
  // switch; a vec4 is cached per program and re-sent only when it changes: LOOK measured +0.5 ms for the array).
  //   a [0]  sun direction xyz, on (0/1)
  //   b [4]  haze colour toward the sun rgb, aerial coefficient
  //   c [8]  haze colour away from the sun rgb, fmax
  //   d [12] near zone, 1 / layer, lobe, haze floor y
  //   e [16] unit share, 0, 0, 0
  var HZ = L.hz = new Float32Array(20);
  var HZV = L.hzv = [HZ.subarray(0, 4), HZ.subarray(4, 8), HZ.subarray(8, 12), HZ.subarray(12, 16), HZ.subarray(16, 20)];
  var NEXT = new Float32Array(20);
  var NAMES = ['uHz120a', 'uHz120b', 'uHz120c', 'uHz120d', 'uHz120e'];

  function installChunks() {
    var C = THREE && THREE.ShaderChunk;
    if (!C) { L.reason = 'no THREE.ShaderChunk'; return false; }
    var F_LIN = 'float fogFactor = smoothstep( fogNear, fogFar, fogDepth );';
    var F_MIX = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
    var ff = C.fog_fragment;
    if (ff.split(F_LIN).length !== 2 || ff.split(F_MIX).length !== 2) { L.reason = 'fog_fragment is not the r128 text this was written against'; return false; }
    if (C.fog_vertex.indexOf('fogDepth = - mvPosition.z;') < 0) { L.reason = 'fog_vertex is not the r128 text this was written against'; return false; }
    L._chunks = { pv: C.fog_pars_vertex, v: C.fog_vertex, pf: C.fog_pars_fragment, f: ff };
    var decl = NAMES.map(function (n) { return '\tuniform vec4 ' + n + ';'; });
    C.fog_pars_vertex = C.fog_pars_vertex + [''].concat(
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      '\tuniform float fogNear;',                       // the game's density (the stand-in's near)
      decl, '\tvarying vec2 vHaze120;', '#endif', '').join('\n');
    C.fog_vertex = C.fog_vertex + [
      '',
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      '\t{',
      '\t\tvec3 hzV = mvPosition.xyz * mat3( viewMatrix );',                 // camera -> vertex, world axes
      '\t\tfloat hzR = length( hzV );',
      // a material three gives no view matrix (sprites, points, lines) keeps the stock fog
      '\t\tfloat hzOn = uHz120a.w * step( 1e-6, hzR );',
      // the camera's height from the view matrix (three r128 uploads `cameraPosition` only to Phong/Standard/Toon/
      // Shader materials, so in a Lambert, the game's material, it reads 0)
      '\t\tfloat hzCY = - dot( viewMatrix[ 3 ].xyz, viewMatrix[ 1 ].xyz );',
      // the layer: the density at the ray's mean height over the floor (one exp; no integral)
      '\t\tfloat hzH = exp( - uHz120d.y * max( hzCY + 0.5 * hzV.y - uHz120d.w, 0.0 ) );',
      // the aerial optical depth PAST the near zone
      '\t\tfloat hzA = uHz120b.w * max( hzR - uHz120d.x, 0.0 ) * hzH * hzOn;',
      '#ifdef HZ120_UNIT',
      '\t\thzA *= uHz120e.x;',                                                // a man, a tank, a gun: a share of it
      '#endif',
      // the weather's exp2 on the stock view depth (never less fog than OFF), and the aerial term capped at fmax
      '\t\tfloat hzT = fogNear * fogDepth;',
      '\t\tfloat hzF = 1.0 - exp( - hzT * hzT ) * ( 1.0 - uHz120c.w * ( 1.0 - exp( - hzA ) ) );',
      '\t\tfloat hzMu = dot( hzV, uHz120a.xyz ) / max( hzR, 1e-4 );',
      '\t\tfloat hzW = 1.0 / ( 1.0 + uHz120d.z * ( 1.0 - hzMu ) );',
      '\t\tvHaze120 = vec2( hzF, hzW * hzW );',
      '\t}',
      '#endif', ''].join('\n');
    C.fog_pars_fragment = C.fog_pars_fragment + [''].concat(
      '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
      decl, '\tvarying vec2 vHaze120;', '#endif', '').join('\n');
    // the fragment only mixes: the factor came from the vertex (fogDepth goes unread there)
    C.fog_fragment = ff.replace(F_LIN, [
      'float fogFactor = vHaze120.x;',
      '\t\tvec3 fogC120 = mix( fogColor, mix( uHz120c.xyz, uHz120b.xyz, vHaze120.y ), uHz120a.w );'].join('\n'))
      .replace(F_MIX, [
        '#ifdef FOG_EXP2',
        '\t' + F_MIX,
        '\t#else',
        '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogC120, fogFactor );',
        '\t#endif'].join('\n'));
    // every built-in program's uniforms (cloned per material at compile; the views go by reference); and the fog
    // library, so a custom ShaderMaterial merged from it later shares them too
    var n = 0, put = function (u) { for (var i = 0; i < 5; i++) u[NAMES[i]] = { value: HZV[i] }; };
    for (var k in THREE.ShaderLib) {
      var s = THREE.ShaderLib[k];
      if (s && s.uniforms && s.uniforms.fogColor && !s.uniforms.uHz120a) { put(s.uniforms); n++; }
    }
    if (THREE.UniformsLib && THREE.UniformsLib.fog && !THREE.UniformsLib.fog.uHz120a) put(THREE.UniformsLib.fog);
    L.libs = n;
    return true;
  }

  // ---------------------------------------------------------------- 2. units take a share
  // Every unit material (men, vehicles, crew-served guns, baked or procedural) goes through UnitShade.material. Its
  // vertex shader now starts with `#define HZ120_UNIT`, which only the haze branch reads; the program key is
  // UnitShade's own (`|us3:...`), shared with no non-unit material, so OFF compiles to the same code.
  function hookUnits() {
    var US = root.UnitShade;
    if (!US || typeof US.material !== 'function') { L.unitReason = 'no UnitShade.material'; return false; }
    if (US._hz120) return true;
    var orig = US.material;
    US.material = function (m) {
      var r = orig.apply(this, arguments);
      if (m && m._unitShaded && !m._hz120Unit) {
        m._hz120Unit = true;
        var prev = m.onBeforeCompile;
        m.onBeforeCompile = function (sh, renderer) {
          if (prev) prev.call(this, sh, renderer);
          if (sh.vertexShader.indexOf('#define HZ120_UNIT') < 0) sh.vertexShader = '#define HZ120_UNIT\n' + sh.vertexShader;
        };
      }
      return r;
    };
    US._hz120 = true;
    return true;
  }

  // ---------------------------------------------------------------- 3. the grade, folded
  // At load the Cineon slot gets a FALLBACK (the installed grade, then the split: a second function), between markers.
  // The first time grade120 is ON (and whenever the installed grade's text changes), `syncGrade` replaces it with a COPY
  // of the installed CustomToneMapping whose gentle split line is the stronger one: the same ALU count as OFF.
  var G_HEAD = 'vec3 CustomToneMapping( vec3 color ) {', G_M0 = '// <grade120>', G_M1 = '// </grade120>';
  var SPLIT_RE = /\n([ \t]*)color \+= [0-9.]+ \* \(l - 0\.5\) \* vec3\([^)]*\);/;
  function v3(a) { return 'vec3( ' + a.map(function (x) { return (+x).toFixed(4); }).join(', ') + ' )'; }
  function splitLine(ind) {
    var g = L.gradeCfg;
    return '\n' + ind + 'color *= 1.0 + clamp( l - ' + (+g.pivot).toFixed(4) + ', ' + (+g.lo).toFixed(4) + ', ' + (+g.hi).toFixed(4) +
      ' ) * max( 1.0 - l, 0.0 ) * ' + v3(g.split) + ';   // (round 120, grade120) amber into the light, slate into the shade, white left white';
  }
  function installGrade() {
    var C = THREE && THREE.ShaderChunk;
    var HEAD = 'vec3 OptimizedCineonToneMapping( vec3 color ) {';
    var t = C && C.tonemapping_pars_fragment;
    if (!t || t.split(HEAD).length !== 2 || t.indexOf('vec3 CustomToneMapping( vec3 color )') < 0) {
      L.gradeReason = 'tonemapping_pars_fragment is not the r128 text this was written against'; return false;
    }
    C.tonemapping_pars_fragment = t.replace(HEAD, 'vec3 OptimizedCineonToneMapping_r128( vec3 color ) {') + [
      '', G_M0,
      '// (round 120, game.grade120) fallback until the installed grade is copied: the grade, then the split',
      'vec3 OptimizedCineonToneMapping( vec3 color ) {',
      '\tcolor = CustomToneMapping( color );',
      '\tfloat l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );',
      splitLine('\t').slice(1),
      '\treturn clamp( color, 0.0, 1.0 );',
      '}', G_M1, ''].join('\n');
    return true;
  }
  /** Copy the installed grade into the Cineon slot with the stronger split. Returns true when the chunk was rewritten. */
  function syncGrade() {
    var C = THREE.ShaderChunk, t = C.tonemapping_pars_fragment;
    if (t === L._gradeSeen) return false;
    var i0 = t.indexOf(G_M0), i1 = t.indexOf(G_M1);
    if (i0 < 0 || i1 < i0) { L.gradeReason = 'the grade120 markers are gone'; L._gradeSeen = t; return false; }
    var a = t.indexOf(G_HEAD), b = a < 0 ? -1 : t.indexOf('\n}', a);
    var body = (a >= 0 && b > a && a < i0) ? t.slice(a, b + 2) : '';
    var fold = '';
    if (body && body.indexOf('return color; }') < 0 && SPLIT_RE.test(body)) {
      fold = body.replace(G_HEAD, 'vec3 OptimizedCineonToneMapping( vec3 color ) {').replace(SPLIT_RE, function (m, ind) { return splitLine(ind); });
      L.gradeFolded = true; L.gradeReason = '';
    } else {
      L.gradeFolded = false; L.gradeReason = 'the installed grade has no split line to fold into: the fallback (a second function) stays';
    }
    if (fold) {
      C.tonemapping_pars_fragment = t.slice(0, i0) + G_M0 + '\n// (round 120, game.grade120) the installed box-art grade with a stronger split, folded (same ALU as OFF)\n' +
        fold + '\n' + t.slice(i1);
    }
    L._gradeSeen = C.tonemapping_pars_fragment;
    return !!fold;
  }
  L.syncGrade = syncGrade;

  L.ok = installChunks();
  L.unitsOk = hookUnits();
  L.gradeOk = installGrade();

  // ---------------------------------------------------------------- 4. the stand-in fog
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

  // ---------------------------------------------------------------- 5. the dome's horizon
  var DOME_LINE = 'c = mix(c, uFog, max(uHaze.y, 1.0 - smoothstep(0.0, uHaze.x, y)));';
  function domeBefore(sh) {
    if (sh.fragmentShader.indexOf(DOME_LINE) < 0) { L.domeReason = 'the dome horizon line moved'; return; }
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform vec3 uFog;', 'uniform vec3 uFog;\nuniform vec3 uHz120Sun;\nuniform vec3 uHz120Away;\nuniform vec3 uHz120Dir;\nuniform vec3 uHz120K;')
      .replace(DOME_LINE, [
        '{ float hzW = 1.0 / (1.0 + uHz120K.x * (1.0 - dot(d, uHz120Dir))); hzW *= hzW;',
        '  vec3 hzC = mix(uHz120Away, uHz120Sun, hzW);',
        '  c = mix(c, hzC, max(max(uHaze.y, uHz120K.z), 1.0 - smoothstep(0.0, uHaze.x * uHz120K.y, y))); }'].join('\n'));
    L.domeOk = true;
  }
  function setDome(g, on) {
    var dome = g.skyNew, m = dome && dome.mat;
    if (!m) return;
    if (!m.uniforms.uHz120Sun) {
      m.uniforms.uHz120Sun = { value: new THREE.Vector3(0.7, 0.75, 0.8) };
      m.uniforms.uHz120Away = { value: new THREE.Vector3(0.6, 0.7, 0.8) };
      m.uniforms.uHz120Dir = { value: new THREE.Vector3(0, 1, 0) };
      m.uniforms.uHz120K = { value: new THREE.Vector3(1.0, 1.8, 0) };
    }
    var want = !!on;
    if (!!m._hz120 === want) return;
    m._hz120 = want;
    if (want) { m._hz120Prev = m.onBeforeCompile; m.onBeforeCompile = domeBefore; }
    else { m.onBeforeCompile = m._hz120Prev || THREE.ShaderMaterial.prototype.onBeforeCompile; }
    m.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 6. the map: the haze floor and the theatre
  // The low ground holds the haze: the floor is the 30th percentile of the field's height, read once a map.
  function floorOf(g) {
    var t = g.terrain;
    if (!t || !t.heightAt) return 0;
    var sig = (g.mapDef && g.mapDef.name) || '';
    if (L._floorT === t && L._floorSig === sig && L._floor != null) return L._floor;
    // GRID and cellCenter are the page's top-level `let`/`const`: global lexical bindings, not window properties
    /* global GRID, cellCenter, TYPE */
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
  var sstep = function (a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  var lum = function (c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  /** The theatre's dust from the field itself (the map's `era` is 'WWII' on half the catalogue): snow and ice make
   *  winter, sand desert, dry grass and heath (or the Eastern Front: Soviet troops in the deploy) steppe; else a temperate
   *  summer. Once a map. Returns { dust: [r,g,b], snow, sand, dry, kind }. */
  function theatreOf(g) {
    var t = g.terrain, sig = (g.mapDef && g.mapDef.name) || '';
    if (L._thT === t && L._thSig === sig && L._th) return L._th;
    var TY = (typeof TYPE !== 'undefined') ? TYPE : root.TYPE, arr = t && t.type, n = 0, snow = 0, sand = 0, dry = 0;
    if (TY && arr && arr.length) {
      for (var q = 0; q < arr.length; q += 7) {
        var v = arr[q]; n++;
        if (v === TY.snow || v === TY.ice) snow++;
        else if (v === TY.sand) sand++;                       // not beach: Omaha and Tarawa are not deserts
        else if (v === TY.drygrass || v === TY.heath) dry++;
      }
    }
    n = Math.max(1, n); snow /= n; sand /= n; dry /= n;
    var era = (g.mapDef && g.mapDef.era) || '';
    // the Eastern Front from the armies on the map: its deploy lists are written out as text (the map lint reads them)
    var east = /Eastern/i.test(era);
    if (!east && g.mapDef && typeof g.mapDef.deploy === 'function') { try { east = /['"]sov/.test(String(g.mapDef.deploy)); } catch (e) { east = false; } }
    var wW = sstep(0.12, 0.45, snow);
    var wD = Math.max(/Desert/i.test(era) ? 1 : 0, sstep(0.18, 0.45, sand));
    var wS = Math.max(east ? 0.75 : 0, sstep(0.10, 0.35, dry));
    var D = L.DUST, out = [0, 0, 0];
    for (var k = 0; k < 3; k++) {
      var temperate = D.summer[k] + (D.steppe[k] - D.summer[k]) * wS;
      var warm = temperate + (D.desert[k] - temperate) * wD;
      out[k] = warm + (D.winter[k] - warm) * wW;
    }
    var kind = wW > 0.5 ? 'winter' : wD > 0.5 ? 'desert' : wS > 0.5 ? 'steppe' : 'summer';
    L._th = { dust: out, snow: +snow.toFixed(3), sand: +sand.toFixed(3), dry: +dry.toFixed(3), kind: kind, era: era, east: east };
    L._thT = t; L._thSig = sig;
    return L._th;
  }
  L.theatreOf = theatreOf;

  /** The near zone: about rifle range in first person; from the RTS camera, its distance to what it looks at plus
   *  `nearAdd` (the men around the point you are looking at stay crisp at every zoom). */
  function nearOf(g, c) {
    if (g.fpv) return c.nearFpv;
    var cam = g.camera, rig = g.cameraRig, d = 0;
    if (cam && rig && rig.target) { var p = cam.position, t = rig.target; d = Math.sqrt((p.x - t.x) * (p.x - t.x) + (p.y - t.y) * (p.y - t.y) + (p.z - t.z) * (p.z - t.z)); }
    return Math.max(c.nearFpv, d + c.nearAdd);
  }

  // ---------------------------------------------------------------- 7. once a frame, from _updateDaylight
  var WXT = [0, 0, 0, 0, 0, 0];
  L.daylight = function (g, elDeg, day, night) {
    if (!g || !g.scene) return;
    // ---- grade120: the renderer's tone-mapping mode, re-asserted (Grade.set/off may have reset it)
    var r = g.renderer;
    if (r && L.gradeOk && root.Grade && root.Grade.ok) {
      var wantG = g.grade120 === true, flip = false;
      // the folded copy is made before the first Cineon program compiles, and again if the grade's text changes
      if (wantG && syncGrade() && r.toneMapping === THREE.CineonToneMapping) flip = true;
      if (wantG && r.toneMapping === THREE.CustomToneMapping) { r.toneMapping = THREE.CineonToneMapping; flip = true; }
      else if (!wantG && r.toneMapping === THREE.CineonToneMapping) { r.toneMapping = THREE.CustomToneMapping; flip = true; }
      // the mode is in every program's key; r128 never re-keys on a mode change by itself, so every live material
      // looks its program up again (both sets stay cached, so flipping back costs a lookup, not a compile)
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
    var c = L.cfg, k;
    // the sun: sky117's true direction (the disc sets), else the game's own
    var el = (g.sunElev || 0), az = (g.sunAz || 0);
    var sx = Math.sin(az) * Math.cos(el), sy = Math.sin(el), sz = Math.cos(az) * Math.cos(el);
    // how much sun the haze scatters: the sun up, and a sky that is not a deck
    var cover = 0.34;
    if (root.Sky117 && root.Sky117.weatherOf) { try { cover = root.Sky117.weatherOf(g, WXT)[0]; } catch (e) { cover = 0.34; } }
    var covK = sstep(0.6, 0.95, cover), nt = night || 0;
    var S = sstep(-3, 5, elDeg) * (1 - 0.85 * covK) * (1 - nt);
    // CLEARNESS: a clear day's haze is dust in sunlight; under a deck, in rain or fog it is the weather's own grey
    var wl = (g.weather && g.weather.light != null) ? g.weather.light : 1;
    var wet = Math.min(1, Math.max(0, (1 - wl) * 2.2));
    var Q = (1 - 0.9 * covK) * (1 - wet) * sstep(-4, 8, elDeg) * (1 - nt);
    // the base: the weather's fog colour as sky117 cast it at this hour
    var fc = f.color, b = [fc.r, fc.g, fc.b], lb = Math.max(1e-4, lum(b));
    // the theatre's dust at the horizon's own brightness, lifted (a luminous haze), as far as the day is clear
    var th = theatreOf(g), dust = th.dust, ld = Math.max(1e-4, lum(dust)), mD = c.dust * Q, lift = 1 + c.lift * Q;
    for (k = 0; k < 3; k++) b[k] = b[k] + (dust[k] * lb / ld * lift - b[k]) * mD;
    // greyer under a deck and in rain: toward its own luminance
    var gk = c.grey * Math.max(covK, wet) * (1 - nt), lg = lum(b);
    for (k = 0; k < 3; k++) b[k] = b[k] + (lg - b[k]) * gk;
    // the sun's hue, at unit luminance
    var sc = g.sun && g.sun.color, hue = [1, 1, 1];
    if (sc) { var ls = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b; if (ls > 1e-4) hue = [sc.r / ls, sc.g / ls, sc.b / ls]; }
    var lift2 = 1 + c.sunGain * S, dark = 1 - c.away * S;
    // toward the sun: the haze's own brightness carried toward the sun's hue warmed a little, then scaled (never
    // clipped per channel, so the hue survives the lift)
    var bl = lum(b), W = c.warmCast, wh = [0, 0, 0];
    for (k = 0; k < 3; k++) wh[k] = Math.min(1.6, hue[k] * W[k]);
    var whl = Math.max(1e-4, lum(wh)), m = c.warm * S, mx = 0;
    for (k = 0; k < 3; k++) {
      NEXT[4 + k] = (b[k] + (bl * wh[k] / whl - b[k]) * m) * lift2;
      if (NEXT[4 + k] > mx) mx = NEXT[4 + k];
      NEXT[8 + k] = Math.max(0, b[k] * dark * (1 + S * c.cool[k]));
    }
    if (mx > 0.97) for (k = 0; k < 3; k++) NEXT[4 + k] *= 0.97 / mx;
    var mx2 = Math.max(NEXT[8], NEXT[9], NEXT[10]);
    if (mx2 > 0.97) for (k = 8; k < 11; k++) NEXT[k] *= 0.97 / mx2;
    NEXT[0] = sx; NEXT[1] = sy; NEXT[2] = sz; NEXT[3] = 1;
    // the aerial term: full on a clear day, less where the weather's own exp2 already fills the air, less at night
    var wxK = 1 - 0.35 * Math.max(covK, wet);
    NEXT[7] = c.aerial * wxK * (c.nightAerial + (1 - c.nightAerial) * (day == null ? 1 : day));
    NEXT[11] = c.fmax;
    NEXT[12] = nearOf(g, c); NEXT[13] = 1 / Math.max(1, c.layer); NEXT[14] = c.lobe; NEXT[15] = floorOf(g);
    NEXT[16] = c.unitShare; NEXT[17] = 0; NEXT[18] = 0; NEXT[19] = 0;
    // a group is written only when it has moved past a step (or a knob changed): the sun creeps every frame
    for (var q = 0; q < 20; q += 4) {
      var mv = 0;
      for (k = q; k < q + 4; k++) { var dd = Math.abs(NEXT[k] - HZ[k]); if (k === 7 || k === 11 || k >= 12) dd *= 1e6; if (dd > mv) mv = dd; }
      if (mv > 0.0015) for (k = q; k < q + 4; k++) HZ[k] = NEXT[k];
    }
    L._Q = Q;
    // the dome's horizon in the same colours, its band wider and a veil over it on a clear day
    setDome(g, true);
    var u = g.skyNew && g.skyNew.mat && g.skyNew.mat.uniforms;
    if (u && u.uHz120Sun) {
      u.uHz120Sun.value.set(HZ[4], HZ[5], HZ[6]); u.uHz120Away.value.set(HZ[8], HZ[9], HZ[10]);
      u.uHz120Dir.value.set(sx, sy, sz);
      u.uHz120K.value.set(c.lobe, 1.3 + (c.band - 1.3) * Q, c.veil * Q);
    }
  };

  /** The haze on the CPU, for a direction and a distance from the camera (smoke and the like): [r, g, b, factor].
   *  `unit` true: a unit's share. Agrees with the vertex shader. */
  L.hazeAt = function (g, dx, dy, dz, dist, unit) {
    var f = g && g.scene && g.scene.fog;
    if (!f) return [0, 0, 0, 0];
    var t = f.density * dist;
    if (HZ[3] < 0.5 || !f.isHaze120) return [f.color.r, f.color.g, f.color.b, 1 - Math.exp(-t * t)];
    var len = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy + dz * dz)), vy = dy / len * dist;
    var cy = g.camera ? g.camera.position.y : 0;
    var H = Math.exp(-HZ[13] * Math.max(cy + 0.5 * vy - HZ[15], 0));
    var a = HZ[7] * Math.max(dist - HZ[12], 0) * H * (unit ? HZ[16] : 1);
    var mu = (dx * HZ[0] + dy * HZ[1] + dz * HZ[2]) / len, w = 1 / (1 + HZ[14] * (1 - mu)); w *= w;
    return [HZ[8] + (HZ[4] - HZ[8]) * w, HZ[9] + (HZ[5] - HZ[9]) * w, HZ[10] + (HZ[6] - HZ[10]) * w,
      1 - Math.exp(-t * t) * (1 - HZ[11] * (1 - Math.exp(-a)))];
  };

  L.state = function (g) {
    g = g || root.game;
    var f = g && g.scene && g.scene.fog;
    return { ok: L.ok, reason: L.reason, gradeOk: L.gradeOk, gradeReason: L.gradeReason, gradeFolded: !!L.gradeFolded, libs: L.libs,
      unitsOk: !!L.unitsOk, domeOk: !!L.domeOk, haze: !!(f && f.isHaze120), toneMapping: g && g.renderer ? g.renderer.toneMapping : null,
      theatre: L._th ? { kind: L._th.kind, snow: L._th.snow, sand: L._th.sand, dry: L._th.dry, era: L._th.era } : null, Q: L._Q,
      hz: Array.prototype.slice.call(HZ).map(function (x) { return +x.toFixed(5); }) };
  };
})(window);
