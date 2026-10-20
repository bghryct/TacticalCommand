/* ===========================================================================
 * UNITSHADE — what makes a painted model look painted, in a dozen instructions
 * ---------------------------------------------------------------------------
 * Box art armour reads as a solid object sitting in a place. Two things do most
 * of that work, and neither of them is detail:
 *
 *   THE EDGE. A painted tank has a light along its silhouette — sky bouncing
 *   off the top of the hull, the turret rim, the mudguards. It is what stops a
 *   vehicle reading as a flat shape and it is the first thing a modeller
 *   drybrushes on. A Fresnel term gives it for two instructions.
 *
 *   THE DIRT. Every vehicle in every box painting is filthy at the running gear
 *   and comparatively clean on the turret roof, because that is what happens to
 *   a tank in a field. The gradient from muddy skirts to clean deck is most of
 *   what says "this thing has been driven somewhere".
 *
 * WHY THIS IS A MATERIAL PATCH AND NOT A PASS.
 *
 * Round 48 measured what a post pass costs here: 2.7 ms to route the frame
 * through a target before any effect runs, plus the default framebuffer's MSAA.
 * Round 51 put the box-art tone curve inside `CustomToneMapping` for nothing at
 * all. This is the same trick one level down: the work happens in a fragment
 * shader that was already going to run, on the units' pixels only — which are a
 * small part of any frame — so it is a handful of ALU on a few per cent of the
 * screen. No target, no resolve, no extra draw call.
 *
 * Everything it needs is cheap to carry. The view-space normal and position are
 * this file's own varyings rather than the host shader's, because a Gouraud
 * material has neither in its fragment stage — see the note on `uRim`. Formerly:
 * `normal` and `vViewPosition` are in
 * scope in the standard fragment shader, and the height and upness come from
 * OBJECT space — `position.y` is height up the model from its own base and
 * `normal.y` is how much a face points at the sky — so no per-unit uniform is
 * needed and one patched material serves every unit that shares it.
 * ======================================================================== */
(function (root) {
  'use strict';

  var U = {};

  U.defaults = {
    rim: 0.42,          // strength of the silhouette light
    rimPow: 2.6,        // how tightly it hugs the edge
    rimColor: [0.62, 0.70, 0.86],   // sky, because that is where it comes from
    dust: 0.55,         // how muddy the bottom gets
    dustLo: 0.05,       // model-space height where dirt is heaviest…
    dustHi: 0.95,       // …and where it has run out
    dustColor: [0.52, 0.45, 0.34],  // dry Normandy earth
    // ---- the paint ------------------------------------------------------
    // A vehicle was ONE FLAT COLOUR over its whole hull: turret, mantlet,
    // glacis, tracks and running gear all the same value, so a Tiger read as a
    // smooth toy rather than as welded plate. Two things fix that, and both
    // belong on the ALBEDO rather than on the lit result — paint is under the
    // light, not over it.
    plate: 0.13,        // per-plate tonal drift: how much adjacent armour differs
    plateFreq: 2.2,     // …at roughly the size of a plate, in model units
    camo: null,         // {a:[r,g,b], b:[r,g,b], freq, cover} or null for plain
    seed: 0,            // so two Tigers off the same line are not identical
    // RUNNING GEAR IS NOT THE COLOUR OF THE HULL. Track links, sprockets, idlers
    // and road wheels are bare steel polished by their own movement, packed with
    // grease and thrown mud — on any real vehicle they are the darkest thing on
    // it by a wide margin, and painting them hull colour is most of why a tank
    // model reads as a single moulded object. Every vehicle model in the game
    // stands about 1.4–1.5 units tall, so an absolute height catches the running
    // gear on all of them without needing to know which part is which.
    gear: 0.0,          // strength; the call site turns it on for vehicles
    gearHi: 0.42,       // model height where the running gear gives way to hull
    gearColor: [0.30, 0.29, 0.28],
    // ---- the sheen ------------------------------------------------------
    // THERE IS NO SPECULAR ANYWHERE IN THE GAME. Round 55 moved every lit
    // surface to `MeshLambertMaterial`, which is pure diffuse, and a painted
    // steel hull with no highlight at all reads as cardboard: the facets have
    // distinct flat values and nothing joins them into a FORM. It is the
    // single most missing thing on a vehicle seen close.
    //
    // Broad and weak on purpose. This is the sheen of matt service paint in
    // sun, not a wet gloss — the point is to recover curvature and edge, not
    // to make a Tiger look varnished.
    spec: 0.26,
    gloss: 16.0,
    specColor: [1.0, 0.97, 0.88],   // sunlight, slightly warm
    // ---- the bounce -----------------------------------------------------
    // MEASURED: a German grenadier on snow renders at a luminance of about 40
    // against the snow's 206 — a black silhouette with no form in it at all.
    // The vertex colours are the reason, and they are nearly uniform: every
    // sample across helmet, tunic, webbing and boots falls inside RGB
    // (27..36, 26..37, 18..27). There is nothing there to see.
    //
    // The fix is not to repaint him. What a dark object in the open actually
    // has, and what this lacked, is BOUNCE: sky on every upward face and
    // ground light under every downward one. It is the difference between a
    // figure and a cut-out, and it is what a miniature painter is doing when
    // he puts a lighter grey on the top of a boot.
    //
    // Applied only where the fragment is ALREADY crushed, so it lifts the
    // shadow side and leaves the lit side — and the man's identity colour —
    // alone. Team readability does not change; the silhouette does not change.
    bounce: 0.30,
    bounceSky: [0.42, 0.52, 0.72],     // north light
    bounceGround: [0.40, 0.36, 0.26],  // earth, or the snow's own glare
  };

  /** THE SUN, IN VIEW SPACE, SHARED BY EVERY UNIT MATERIAL.
   *
   *  Lambert finishes its lighting in the vertex shader, so the fragment stage
   *  has no light uniforms to borrow — the same reason this file carries its
   *  own normal and view vector. One vector, written once a frame by the game
   *  (see `_syncUnitSun`), read by every patched material. */
  U.sun = { value: new THREE.Vector3(0.35, 0.82, 0.45) };

  /** The same cheap hash noise the canopy uses — no `sin`, and one octave is
   *  enough when the thing being broken up is a painted surface rather than a
   *  silhouette. */
  function glslNoise() {
    return [
      'float usHash(vec3 p){',
      '  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));',
      '  p *= 17.0;',
      '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
      '}',
      'float usNoise(vec3 p){',
      '  vec3 i = floor(p), f = fract(p);',
      '  f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mix(usHash(i + vec3(0.0,0.0,0.0)), usHash(i + vec3(1.0,0.0,0.0)), f.x),',
      '                 mix(usHash(i + vec3(0.0,1.0,0.0)), usHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
      '             mix(mix(usHash(i + vec3(0.0,0.0,1.0)), usHash(i + vec3(1.0,0.0,1.0)), f.x),',
      '                 mix(usHash(i + vec3(0.0,1.0,1.0)), usHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);',
      '}',
    ].join('\n');
  }

  /** The albedo half: paint, before any light touches it. */
  function paintChunk(o) {
    var L = ['{', '  vec3 usP = vUsObj * ' + (+o.plateFreq).toFixed(3) +
             ' + vec3(' + (+o.seed).toFixed(2) + ');'];
    // ---- plates ---------------------------------------------------------
    // Armour is welded from plates that were cut, primed and painted at
    // different times, and they never quite match. A slow drift at about the
    // size of a plate is what stops a hull reading as one moulded piece.
    L.push('  float usPl = usNoise(usP) - 0.5;');
    L.push('  diffuseColor.rgb *= 1.0 + usPl * ' + (+o.plate).toFixed(3) + ' * 2.0;');
    // ---- camouflage -----------------------------------------------------
    // Disruptive patches, sprayed: soft edges, two colours over the base. Only
    // for the armies that actually did it — see the table at the call site.
    if (o.camo) {
      var a = o.camo.a, b = o.camo.b;
      var f = (o.camo.freq != null ? o.camo.freq : 1.15);
      var cov = (o.camo.cover != null ? o.camo.cover : 0.5);
      L.push('  float usC = usNoise(usP * ' + (f / Math.max(o.plateFreq, 1e-3)).toFixed(4) + ' + 31.7);');
      // Two thresholds either side of the base, so the base keeps the majority
      // of the hull and the two patch colours break it up.
      //
      // THEY HAVE TO SIT WHERE THE NOISE ACTUALLY IS. The first version put
      // them at 0.65–0.78 and 0.18–0.39, reasoning about a [0,1] range. A value
      // noise built from a hash is not uniform over that range — it is piled up
      // around the middle, because every sample is an interpolation between
      // eight of them — so both thresholds sat out in the tails and the tank
      // came out very nearly plain. Placed symmetrically about 0.5 instead,
      // with `cover` moving them apart rather than up and down.
      var d = 0.075 + 0.16 * (1 - cov), w = 0.085;
      L.push('  float usCa = smoothstep(' + (0.5 + d).toFixed(3) + ', ' + (0.5 + d + w).toFixed(3) + ', usC);');
      L.push('  float usCb = 1.0 - smoothstep(' + (0.5 - d - w).toFixed(3) + ', ' + (0.5 - d).toFixed(3) + ', usC);');
      // Tinted rather than replaced: a patch of olive over dunkelgelb is still
      // lit by the same sun and still darkens into the same shadows, and a
      // hard replace makes the hull look like a decal sheet.
      L.push('  vec3 usCol = mix(vec3(1.0), vec3(' + a[0] + ', ' + a[1] + ', ' + a[2] + '), usCa);');
      L.push('  usCol = mix(usCol, vec3(' + b[0] + ', ' + b[1] + ', ' + b[2] + '), usCb);');
      L.push('  diffuseColor.rgb *= usCol;');
    }
    // ---- running gear ---------------------------------------------------
    if (o.gear > 0) {
      var g = o.gearColor;
      L.push('  float usG = (1.0 - smoothstep(' + (+o.gearHi * 0.55).toFixed(3) + ', ' +
             (+o.gearHi).toFixed(3) + ', vUsH)) * ' + (+o.gear).toFixed(3) + ';');
      // Toward steel, not onto it: the track guards and the lower hull sit in
      // the same band and they ARE painted, so a hard replace would erase them.
      L.push('  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(' + g[0] + ', ' + g[1] + ', ' + g[2] +
             '), clamp(usG, 0.0, 0.9));');
    }
    L.push('}');
    return L.join('\n');
  }

  function chunk(o) {
    var c = o.rimColor, d = o.dustColor, sc = o.specColor;
    var bs = o.bounceSky, bg = o.bounceGround;
    return [
      '{',
      // ---- the dirt -------------------------------------------------------
      // Low on the model and facing upward collects the most: that is where
      // the track throws it and where it settles.
      '  float uLow = 1.0 - smoothstep(' + (+o.dustLo).toFixed(3) + ', ' + (+o.dustHi).toFixed(3) + ', vUsH);',
      '  float uUp  = clamp(vUsN * 0.5 + 0.5, 0.0, 1.0);',
      '  float uDust = uLow * mix(0.30, 1.0, uUp) * ' + (+o.dust).toFixed(3) + ';',
      // Dirt does not repaint the tank a flat brown — it dulls whatever is
      // already there and shifts it toward earth, which is why a muddy olive
      // hull still reads as olive.
      '  float uLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));',
      '  vec3 uMud = vec3(' + d[0] + ', ' + d[1] + ', ' + d[2] + ') * (0.45 * uUsLight + 0.85 * uLum);',
      '  gl_FragColor.rgb = mix(gl_FragColor.rgb, uMud, clamp(uDust, 0.0, 0.85));',
      // ---- the edge -------------------------------------------------------
      // Fresnel against the view, off THIS FILE'S OWN VARYINGS.
      //
      // It used to read `normal` and `vViewPosition` straight out of the host
      // shader, which is true of MeshStandardMaterial and MeshPhongMaterial and
      // FALSE of MeshLambertMaterial: Lambert is Gouraud, so its lighting is
      // done in the vertex shader and its fragment stage declares neither.
      // When round 55 moved the game's lit surfaces to Lambert every unit
      // material failed to compile — `'normal' : undeclared identifier`.
      //
      // Carrying the two values as our own varyings makes the rim independent
      // of the host's lighting model, so this works on all four.
      '  float uRim = 1.0 - clamp(dot(normalize(vUsVN), normalize(vUsVP)), 0.0, 1.0);',
      '  uRim = pow(uRim, ' + (+o.rimPow).toFixed(2) + ');',
      // Only where there is light to bounce: a rim light on a tank standing in
      // shadow is a glow, and glowing tanks are not what this is for.
      '  gl_FragColor.rgb += vec3(' + c[0] + ', ' + c[1] + ', ' + c[2] + ') * uRim * ' +
        (+o.rim).toFixed(3) + ' * smoothstep(0.02, 0.35, uLum) * uUsLight;',
      // ---- the sheen ------------------------------------------------------
      // Blinn-Phong off this file's own normal and view vector, against the
      // shared sun. Gated two ways, both of which are what actually happens:
      //   · by the DIRT. A filthy lower hull is matt; a clean upper deck is not.
      //     The dust term is already to hand, so the sheen fades out exactly
      //     where the mud is thickest.
      //   · by the LIGHT already on the fragment. A highlight on a surface in
      //     shadow is a lamp, and there are no lamps on a tank at midday.
      // ---- the bounce -----------------------------------------------------
      '  float uDark = 1.0 - smoothstep(0.0, 0.26, uLum);',
      '  float uSky = clamp(vUsN * 0.5 + 0.5, 0.0, 1.0);',
      '  vec3 uBnc = mix(vec3(' + bg[0] + ', ' + bg[1] + ', ' + bg[2] + '), vec3(' +
        bs[0] + ', ' + bs[1] + ', ' + bs[2] + '), uSky);',
      // …BUT NOT ON BLOOD (round 106). The bounce lifts what is dark, and a
      // wound soaked into a tunic (`Unit._paintWound`) is dark on purpose:
      // lifted by a blue sky fill it read as a purple-grey smudge, and a man
      // shot through the chest looked like a man who had leaned on wet paint.
      // Blood is told apart by its own albedo — far redder than anything a
      // uniform, a face or a helmet is painted — and keeps its darkness.
      '  float uBlood = clamp((diffuseColor.r - max(diffuseColor.g, diffuseColor.b)) / (diffuseColor.r + 0.002) * 3.3 - 2.0, 0.0, 1.0)',
      '               * (1.0 - step(0.2, diffuseColor.r));',
      '  gl_FragColor.rgb += uBnc * uDark * ' + (+o.bounce).toFixed(3) + ' * uUsLight * (1.0 - 0.9 * uBlood);',
      '  vec3 uN = normalize(vUsVN), uV = normalize(vUsVP);',
      '  vec3 uH = normalize(uUsSun + uV);',
      '  float uSpec = pow(max(dot(uN, uH), 0.0), ' + (+o.gloss).toFixed(1) + ');',
      '  gl_FragColor.rgb += vec3(' + sc[0] + ', ' + sc[1] + ', ' + sc[2] + ') * uSpec * ' +
        (+o.spec).toFixed(3) + ' * (1.0 - clamp(uDust, 0.0, 0.85)) * smoothstep(0.05, 0.40, uLum);',
      '}',
    ].join('\n');
  }

  /** Patch one material. Safe to call repeatedly; it only ever patches once. */
  /** HOW MUCH LIGHT THERE IS, 0 (a moonless night) to 1 (noon), set each frame
   *  by the daylight system (`Game._updateDaylight`). The bounce fill and the
   *  dirt's floor were CONSTANTS added on top of the lit colour — so at night,
   *  when the scene's light fell away, every unit kept them and glowed against
   *  a dark field. They are light, and they scale with it now. */
  U.light = { value: 1.0 };

  U.material = function (m, opts) {
    if (!m || m._unitShaded) return false;
    // Unlit and sprite materials have neither a normal nor a view position to
    // work with, and nothing to gain: they are UI, flashes and impostors.
    if (!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial ||
          m.isMeshPhongMaterial)) return false;
    var o = Object.assign({}, U.defaults, opts || {});
    // A BAKED MODEL IS ALREADY PAINTED. Its texture carries the camouflage, the
    // plate tones, the mud and the worn steel (tools/blender); adding the
    // procedural ones on top would paint it twice. The light — rim, sheen,
    // bounce — is still this file's.
    if (m.userData && m.userData.painted) { o.camo = null; o.plate = 0; o.gear = 0; o.dust = 0; }
    var prevCompile = m.onBeforeCompile;
    m.onBeforeCompile = function (sh, renderer) {
      if (prevCompile) prevCompile.call(this, sh, renderer);
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, '#include <common>',
        '#include <common>\nvarying float vUsH;\nvarying float vUsN;\nvarying vec3 vUsVN;\nvarying vec3 vUsVP;\nvarying vec3 vUsObj;');
      // OBJECT space, deliberately. `position.y` is height up the model from
      // its own base and `normal.y` is how much the face points at the sky —
      // both independent of where the unit is standing or which way it is
      // facing, so one patched material serves every unit sharing it.
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>',
        '#include <begin_vertex>\nvUsH = position.y;\nvUsN = normal.y;\nvUsObj = position;');
      // `transformedNormal` is the view-space normal AFTER skinning, morphing
      // and instancing; `mvPosition` is the view-space position. Taking them
      // from the chunks that produce them means the rim is correct on a skinned
      // man and on an instanced prop, not just on a static mesh.
      sh.vertexShader = rep(sh.vertexShader, '#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvUsVN = transformedNormal;');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>',
        '#include <project_vertex>\nvUsVP = -mvPosition.xyz;');
      sh.uniforms.uUsSun = U.sun;
      sh.uniforms.uUsLight = U.light;
      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>',
        '#include <common>\nvarying float vUsH;\nvarying float vUsN;\nvarying vec3 vUsVN;\nvarying vec3 vUsVP;\nvarying vec3 vUsObj;\nuniform vec3 uUsSun;\nuniform float uUsLight;\n' + glslNoise());
      // THE PAINT GOES ON THE ALBEDO, not on the lit result. `<color_fragment>`
      // is where `diffuseColor` has just taken the material colour and any
      // vertex colours, and is the last point before the light is applied — so
      // a camouflage patch darkens into shadow and catches the sun like the
      // paint it is meant to be, instead of floating over the top like a decal.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>',
        '#include <color_fragment>\n' + paintChunk(o));
      // Before the tone map, so the grade in `assets/grade.js` sees the result
      // and the two compose instead of fighting.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <tonemapping_fragment>',
        chunk(o) + '\n#include <tonemapping_fragment>');
      if (!ok) U.patchOk = false;
    };
    // Three caches programs on the material's parameters plus this key, and
    // nothing here changes a parameter — so without a key of our own the
    // renderer hands back the unpatched program it compiled earlier. Round 51
    // learned this the expensive way. Compose with any existing key.
    var prevKey = m.customProgramCacheKey;
    // THE KEY HAS TO CARRY THE PAINT. The camouflage colours and the plate
    // strength are baked into the GLSL as literals, so two materials that
    // differ only in their scheme produce different source — and if they agree
    // on a cache key the renderer hands the second one the first one's program.
    // Every vehicle in the game would then wear whichever scheme compiled
    // first. The seed is in it too, or every Tiger gets one pattern.
    var paintKey = '|us3:' + (+o.plate).toFixed(3) + ':' + (+o.plateFreq).toFixed(2) + ':' + (+o.seed).toFixed(2) +
      ':g' + (+o.gear).toFixed(2) + ':' + (+o.gearHi).toFixed(2) +
      ':s' + (+o.spec).toFixed(2) + ':' + (+o.gloss).toFixed(1) +
      ':b' + (+o.bounce).toFixed(2) +
      (o.camo ? ':' + o.camo.a.join(',') + '/' + o.camo.b.join(',') + '/' +
        (o.camo.freq != null ? o.camo.freq : 1.15) + '/' + (o.camo.cover != null ? o.camo.cover : 0.5) : ':plain');
    m.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + paintKey;
    };
    m._unitShaded = true;
    m.needsUpdate = true;
    return true;
  };

  /** Patch every material under a unit's mesh. */
  U.apply = function (root3, opts) {
    if (!root3) return 0;
    var n = 0;
    root3.traverse(function (o) {
      if (!o.material) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < list.length; i++) if (U.material(list[i], opts)) n++;
    });
    return n;
  };

  U.patchOk = true;
  root.UnitShade = U;
})(window);
