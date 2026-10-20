/* ===========================================================================
 * GRADE — the box-art tone curve, and it costs nothing
 * ---------------------------------------------------------------------------
 * Measured against a Tamiya King Tiger box painting, cropped past the title
 * band, the game's frame was not the wrong COLOUR — it was the wrong SHAPE:
 *
 *                            box art     game
 *      contrast (p90/p10)         25      1.7
 *      p10 / p90              49/227  127/164
 *      warmth (mean R-B)          26       15
 *      far ÷ near chroma        0.41     2.73
 *
 * The whole frame lived in a thirty-seven level band. No darks, no highlights,
 * and a distance that was THREE TIMES more colourful than the foreground, which
 * is aerial perspective backwards. A painting does the opposite of all of that:
 * it keeps its contrast and its colour on the subject and washes the distance
 * into warm haze.
 *
 * WHY THIS IS A TONE MAPPING FUNCTION AND NOT A POST PASS.
 *
 * Round 48 established the expensive thing about post-processing here: routing
 * the whole 2.85 Mpix frame through a render target costs 2.7 ms before any
 * effect runs, and it throws away the default framebuffer's MSAA. But tone
 * mapping ALREADY runs on every pixel of every material — it is the last thing
 * `<tonemapping_fragment>` does before the sRGB encode — so replacing the
 * function with a graded one adds a dozen ALU operations to a shader that was
 * going to run anyway. No target, no resolve, no extra bandwidth, and the
 * antialiasing is untouched.
 *
 * The curve is ACES first, because five rounds of exposure, key-to-fill and
 * auto-exposure work are calibrated on it and none of that should move. The
 * grade sits after it:
 *
 *   contrast   an S-curve, which is what puts the darks and the highlights back
 *   warmth     split toning — amber into the highlights, blue-grey into the
 *              shadows. This is the low sun and the dust, and it is most of why
 *              painted armour art reads warm.
 *   sat        colour held in the midtones and dropped at both extremes, the
 *              way a painter mixes toward grey at the top and bottom of a value
 *              range rather than toward saturated black and white.
 * ======================================================================== */
(function (root) {
  'use strict';

  var G = {};

  // Tuned against the reference; see `tools/probe_boxart.js` for the measurement.
  //
  // `gain` about `pivot` is the one that matters and the first version did not
  // have it. An S-curve RESHAPES a tonal range; it cannot WIDEN one, and the
  // game's problem was width — the whole frame inside thirty-seven levels. A
  // smoothstep at full strength moved the contrast figure from 2.5 to 3.8 and
  // no further. Solving the two percentiles for the range the painting has
  // (p10 49, p90 227 from the game's 90 and 138) gives gain 2.9 about a pivot
  // of 0.41, and that is where these came from rather than from taste.
  // Landed against the reference, measured AT THE FRAMING THE PAINTING IS.
  //
  // The first pass at this tuned on an open field seen from seventy world
  // units and concluded the game could not reach box-art contrast at all —
  // 2.8 against the painting's 25 — and blamed the content. That was the
  // instrument: an empty field at long range compared against a close-up of a
  // tank in smoke. Measured at three framings with the same grade:
  //
  //      open ground, dist 70     contrast  3.9    p10  90
  //      the village, dist 45     contrast 10.8    p10  54
  //      close on armour, dist 22 contrast 15.2    p10  40      (box art 25 / 49)
  //
  // The game was already most of the way there wherever there was something in
  // the frame. Tuned on the armour view, which is the comparable one:
  //
  //      meanValue 133 (137)   p10 44 (49)   contrast 20.4 (25)   warmth 23 (26)
  //
  // `gain` stays modest on purpose. Pushed harder it reports better contrast
  // and paints black holes — see the power-law note below.
  //
  // `gain` IS 1.5 AND NOT 1.55 FOR A MEASURED REASON. At exactly 1.5 the
  // contrast curve has a closed form with no transcendental in it (see
  // `contrastGLSL`), and `pow` was the only one the grade had. Measured at
  // ratio 2 on Winter Crossroads, frozen: the grade cost 2.2 ms of a 21.4 ms
  // frame. The difference between 1.55 and 1.50 is about six percent of the
  // curve's lift at mid grey, which the box-art probe cannot distinguish; the
  // difference in cost is three `pow` per pixel of every material in the game.
  // ROUND 97: "everything looks washed out". It was three of these numbers.
  // `lift` 0.020 is added in LINEAR light before the sRGB encode — a floor of
  // 39/255 under every black, which is what milky shadows are. `shoulder` 0.21
  // capped white at 0.83. And `sat` 0.66, weighted by a midtone bump that is
  // 0.62 at the ends, left 41-75% of every colour. Round 51 set them against
  // one empty field; with models, dirt and ground to show, they read as fog.
  // …and then it overshot. With the fog gone the ground was a lime green at
  // chroma 0.47 against the painting's 0.20, mean 161 against 137, and still
  // only contrast 2.6 over an open field: bright, compressed AND garish, which
  // is "washed out" by another route. `sat` 0.75 and `expo` 1.75 bring the
  // field to chroma 0.32 and mean 142; `gain` back to 1.5 (the sqrt fast path)
  // about a pivot of 0.16 takes the open-field contrast from 2.7 to 3.3. Read
  // on Villers-Bocage's opening view with the round-97 ground textures; then,
  // on the same map at dist 45 with the tufted grass, `expo` 1.55 and `sat`
  // 0.8 put the ground at mean 135 / p50 138 against the painting's 137 / 139.
  G.defaults = { gain: 1.5, pivot: 0.16, shoulder: 0.06, warm: 0.35, sat: 0.8, lift: 0.0, expo: 1.55 };

  /**
   * THE CONTRAST CURVE, IN THE CHEAPEST EXACT FORM FOR THE GAIN ASKED FOR.
   *
   * The curve is `pivot * pow(color / pivot, gain)`, and for the gains anyone
   * actually uses that is an identity away from something much cheaper:
   *
   *   gain 1.5   pivot*(c/p)^1.5 = c*sqrt(c)/sqrt(p)     3 sqrt, 6 mul
   *   gain 2     pivot*(c/p)^2   = c*c/p                 3 mul
   *   gain 1     …is the identity                        nothing at all
   *
   * Verified against the `pow` form across the range: equal to the last bit of
   * a double at c = 0, 1e-4, 0.02, pivot, 0.5, 1 and 4. `pow` on a GPU is
   * `exp2(log2(x) * y)` — two transcendentals — where `sqrt` is a single
   * hardware instruction, and this runs on every pixel of every material.
   *
   * Any other gain falls back to `pow`, so tuning still works; it is only the
   * shipped value that gets the fast path. The `max` guard goes with it: `pow`
   * of zero is not reliably defined across drivers, `sqrt(0.0)` is exactly 0.
   */
  function contrastGLSL(o) {
    var p = +o.pivot, gain = +o.gain;
    if (Math.abs(gain - 1) < 1e-6) return [];
    if (Math.abs(gain - 1.5) < 1e-6) {
      return ['  color = color * sqrt(color) * ' + (1 / Math.sqrt(p)).toFixed(6) + ';'];
    }
    if (Math.abs(gain - 2) < 1e-6) {
      return ['  color = color * color * ' + (1 / p).toFixed(6) + ';'];
    }
    return [
      '  color = max(color, 1e-5);',
      '  color = ' + p.toFixed(4) + ' * pow(color / ' + p.toFixed(4) + ', vec3(' + gain.toFixed(3) + '));',
    ];
  }

  function glsl(o) {
    return [
      'vec3 CustomToneMapping( vec3 color ) {',
      '  color *= toneMappingExposure * ' + (+o.expo).toFixed(3) + ';',
      // ---- ACES, unchanged: everything else in the rig is tuned on it -----
      '  const mat3 ACESIn = mat3(',
      '    0.59719, 0.07600, 0.02840,',
      '    0.35458, 0.90834, 0.13383,',
      '    0.04823, 0.01566, 0.83777);',
      '  const mat3 ACESOut = mat3(',
      '     1.60475, -0.10208, -0.00327,',
      '    -0.53108,  1.10813, -0.07276,',
      '    -0.07367, -0.00605,  1.07602);',
      '  vec3 v = ACESIn * color;',
      '  vec3 aa = v * (v + 0.0245786) - 0.000090537;',
      '  vec3 bb = v * (0.983729 * v + 0.4329510) + 0.238081;',
      '  color = clamp(ACESOut * (aa / bb), 0.0, 1.0);',
      // ---- the grade -------------------------------------------------------
      // CONTRAST AS A POWER LAW ABOUT A PIVOT, not a straight line and a clamp.
      //
      // `(color - pivot) * gain + pivot` gives the right numbers and the wrong
      // picture: it drives everything below the pivot negative and everything
      // above one past white, and the clamp then turns both into flat areas.
      // Measured it read p10 57 — respectable — while every tree shadow on the
      // field was a hole of pure black and the sky was blown out. A painting
      // has deep darks; it does not have empty ones.
      //
      // `pivot * pow(color/pivot, gain)` is the same contrast through the
      // midtones and cannot produce either: it approaches zero asymptotically
      // instead of crossing it, so shadows go dark and keep their shape.
      ].concat(contrastGLSL(o)).concat([
      // …and a soft shoulder, so a bright sky rolls off instead of clipping.
      '  color = color / (1.0 + color * ' + (+o.shoulder).toFixed(3) + ');',
      // A real black FLOOR rather than a hair of lift. Box art almost never
      // goes to true black — the darkest thing in the reference painting sits
      // around forty-nine of two hundred and fifty-five, which is paint, not a
      // hole. This is in linear light, so it is a much smaller number than the
      // one it produces on screen.
      '  color = color * (1.0 - ' + (+o.lift).toFixed(4) + ') + ' + (+o.lift).toFixed(4) + ';',
      '  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));',
      // A GLOBAL warm bias, not just a split tone. The first version only split
      // toned, and because most of a battlefield frame sits BELOW mid grey the
      // cool half of the split dominated and the picture got colder the harder
      // it was pushed — mean warmth went 11, -2, -12, -23. Box art is warm
      // nearly everywhere: low sun, dust, smoke.
      '  color *= vec3(1.0 + 0.105 * ' + (+o.warm).toFixed(3) + ', 1.0 + 0.012 * ' +
        (+o.warm).toFixed(3) + ', 1.0 - 0.115 * ' + (+o.warm).toFixed(3) + ');',
      // …and then the split on top, gently: amber into the light, blue-grey
      // into the shade. That is the shape of sunlight, and it is what keeps the
      // warmth from reading as a flat sepia wash.
      '  color += ' + (+o.warm * 0.45).toFixed(3) + ' * (l - 0.5) * vec3(0.055, 0.010, -0.065);',
      // A painter's saturation: full in the midtones, falling away at both ends.
      '  float m = 1.0 - abs(l * 2.0 - 1.0);',
      '  color = mix(vec3(l), color, ' + (+o.sat).toFixed(3) + ' * (0.62 + 0.52 * m));',
      '  return clamp(color, 0.0, 1.0);',
      '}',
    ]).join('\n');
  }

  /** Install the graded curve. Every material that has already compiled needs
   *  telling, or half the scene keeps the old function until something else
   *  happens to dirty it. */
  G.install = function (renderer, scene, opts) {
    var o = Object.assign({}, G.defaults, opts || {});
    G.current = o;
    if (G._original == null) G._original = THREE.ShaderChunk.tonemapping_pars_fragment;
    // THE STOCK HOOK IS A ONE-LINER, which is the whole reason the first
    // attempt at this produced a black screen. Three.js ships
    // `vec3 CustomToneMapping( vec3 color ) { return color; }` on a single
    // line, so slicing from the function's start to the next `\n}` ran past it,
    // left the stock body in place and bit the `#` off the `#ifndef saturate`
    // that follows — `'ifndef' : syntax error`, every fragment shader in the
    // game failed to compile, and the scene rendered black. Anchor on the
    // exact line and assert it was there.
    var STOCK = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
    if (G._original.indexOf(STOCK) < 0) {
      G.ok = false;
      G.reason = 'the CustomToneMapping hook is not the one-liner this was written against';
      return false;
    }
    THREE.ShaderChunk.tonemapping_pars_fragment = G._original.replace(STOCK, glsl(o));
    renderer.toneMapping = THREE.CustomToneMapping;
    G.refresh(scene);
    G.ok = true;
    return true;
  };

  /**
   * `needsUpdate` IS NOT ENOUGH TO RE-GRADE A LIVE SCENE.
   *
   * Three.js caches compiled programs on a key built from the material's
   * parameters and its `customProgramCacheKey` — and editing `ShaderChunk`
   * text changes neither, so every material dutifully recompiled and got the
   * cached program back. A four-point sweep of the grade returned four
   * identical frames, which reads as "the grade does nothing".
   *
   * So the key carries a grade version. Any existing key function is kept and
   * composed with rather than replaced, because the foliage and the props both
   * define one and quietly dropping theirs would compile their shaders twice.
   * The original is stored once per material so repeated tuning does not build
   * a chain of wrappers.
   */
  G.refresh = function (scene) {
    G._ver = (G._ver || 0) + 1;
    var ver = G._ver, seen = new Set();
    scene.traverse(function (n) {
      if (!n.material) return;
      var list = Array.isArray(n.material) ? n.material : [n.material];
      for (var k = 0; k < list.length; k++) {
        var m = list[k];
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        if (m._gradePrevKey === undefined) m._gradePrevKey = m.customProgramCacheKey || null;
        var prev = m._gradePrevKey;
        m.customProgramCacheKey = function () {
          return (prev ? prev.call(this) : '') + '|g' + ver;
        };
        m.needsUpdate = true;
      }
    });
    G.touched = seen.size;
  };

  /** Re-grade live, for tuning against the probe. */
  G.set = function (renderer, scene, opts) { return G.install(renderer, scene, opts); };

  /** Back to stock ACES — the control arm for any A/B. */
  G.off = function (renderer, scene) {
    if (G._original != null) THREE.ShaderChunk.tonemapping_pars_fragment = G._original;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    G.refresh(scene);
    G.ok = false;
  };

  root.Grade = G;
})(window);
