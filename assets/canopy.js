/* ===========================================================================
 * CANOPY — a tree whose leaves are a shader, not a picture stuck to a cone
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG. A tree was a SOLID CORE plus a spray of ALPHA CARDS: two or
 * three faceted cones (or spheres) carrying a flat green, and four to twelve
 * six-triangle quads carrying a canvas-drawn leaf texture. Seen at the range a
 * player fights at it passes. Seen from anywhere nearer it falls apart, because
 * the two halves agree about nothing:
 *
 *   · VALUE. The core is a mid green lit by the sun; the card texture is a mass
 *     of near-black strokes on transparency. The cards read as soot on a
 *     lampshade rather than as the same plant.
 *   · SCALE. The card's marks are sized to read as leaves when the card spans
 *     two or three metres on screen. Closer than that each mark is a black
 *     scribble a foot across.
 *   · FORM. A faceted cone has a straight silhouette and hard shading steps.
 *     Flat cards have none at all. Neither is a canopy, and stuck together they
 *     are visibly two different objects.
 *
 * WHAT THIS DOES INSTEAD. One canopy shell — the core geometry that was already
 * there — shaded procedurally so the leaves ARE the surface:
 *
 *   · a two-octave object-space noise stands for clumps of foliage, and the
 *     fragment is DISCARDED below a threshold, so the shell stops being a solid
 *     and becomes a mass with gaps in it;
 *   · the threshold RISES TOWARD THE SILHOUETTE. Through the middle of the
 *     crown, where you are looking at the near face and there is a whole tree
 *     behind it, the surface stays nearly closed. At the rim, where a real tree
 *     ends in twigs and single leaves, it opens up and the outline breaks.
 *     That is the entire reason a cone reads as a cone: its edge is a straight
 *     line, and this is what stops it being one;
 *   · the same noise drives colour, so the crown has lit clumps and shaded
 *     hollows rather than one flat green;
 *   · leaves facing up get sky and warmth, the underside goes cool and dark.
 *     A canopy is lit from above and hollow underneath, and that vertical
 *     gradient is most of what makes one look like a volume.
 *
 * It carries its OWN view-space normal and position, for the same reason
 * `assets/unitshade.js` does: the game's lit surfaces are `MeshLambertMaterial`,
 * which is Gouraud — its lighting finishes in the vertex shader and its fragment
 * stage declares neither `normal` nor `vViewPosition`.
 *
 * COMPOSED, NOT SUBSTITUTED. The canopy materials already carry the prop-wind
 * sway hook and a cache key to go with it. This wraps both rather than
 * replacing them, or every tree in the game stops moving in the wind.
 *
 * ROUND 98: THE GAME'S PROPS NO LONGER CALL `C.material`, `C.all` OR `C.bark`.
 * Hedges, trees, oaks, conifers, bushes, scrub, dead trees, trenches and
 * foxholes are each ONE merged geometry per variant on `C.hedgerow` (below),
 * which carries everything here — world-space noise, the rim cut, the depth
 * twin, bark, the wind, a green per prop — keyed by a per-vertex kind. The
 * per-material API stays, documented, for anything that wants a crown on a
 * mesh it did not build this way.
 * ======================================================================== */
(function (root) {
  'use strict';

  var C = {};

  C.defaults = {
    // Noise scale in the prop's own units.
    //
    // THE FIRST PASS AT THIS WAS FAR TOO COARSE. At 3.4 a crown two units wide
    // carries clumps most of a metre across, and close up the gaps read as
    // DAMAGE — a cone with bites taken out of it — rather than as the spaces
    // between foliage. Leaf clumps want to be a hand's width, not a window.
    freq: 14.0,
    // …and the fine octave is faded out with distance. A high-frequency
    // `discard` is the classic way to make a wood boil: at fifty units a tree is
    // a few dozen pixels, one pixel straddles many leaf clumps, and the cut
    // flickers as the camera moves. Beyond `fadeFar` the crown keeps its broken
    // OUTLINE — which is what stops it reading as a cone at any range — and
    // loses only the interior grain, which nobody can resolve there anyway.
    fadeNear: 16.0,
    fadeFar: 44.0,
    // How open the surface is through the body of the crown, and at its rim.
    // `cut` near zero is a solid; the gap between the two is what makes the
    // edge ragged while the middle stays a mass.
    cut: 0.30,
    edgeCut: 0.76,
    // How sharply the rim term ramps. Higher keeps the opening to the very edge.
    edgePow: 1.35,
    // Colour: how much the noise darkens the hollows, and the top-to-under
    // gradient applied over it.
    clump: 0.42,
    under: 0.46,
    topWarm: 0.14,
    // How open the SHADOW is. Between the body's cut and the rim's, so a wood
    // throws broken shade rather than a solid slab or a sieve.
    shadowCut: 0.42,
    // Tree-to-tree colour. `tintFreq` is deliberately tiny — a whole crown has
    // to sit inside one sample of it, or the variation lands WITHIN a tree and
    // reads as disease rather than as two different trees.
    tint: 0.13,
    tintFreq: 0.055,
  };

  function glslNoise() {
    return [
      // A cheap integer-ish hash — no `sin`, which matters because this runs
      // eight times per octave per pixel of every tree on the map.
      'float cnHash(vec3 p){',
      '  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));',
      '  p *= 17.0;',
      '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
      '}',
      'float cnNoise(vec3 p){',
      '  vec3 i = floor(p), f = fract(p);',
      '  f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mix(cnHash(i + vec3(0.0,0.0,0.0)), cnHash(i + vec3(1.0,0.0,0.0)), f.x),',
      '                 mix(cnHash(i + vec3(0.0,1.0,0.0)), cnHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
      '             mix(mix(cnHash(i + vec3(0.0,0.0,1.0)), cnHash(i + vec3(1.0,0.0,1.0)), f.x),',
      '                 mix(cnHash(i + vec3(0.0,1.0,1.0)), cnHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);',
      '}',
    ].join('\n');
  }

  /**
   * Patch one canopy material. Safe to call twice; it only patches once.
   * `mat` keeps whatever hook it already had — the wind sway, in practice.
   */
  /** TRUE SCALE (round 105): the game's prop factor. Every frequency here is
   *  per WORLD unit and every fade a world distance, sized for trees drawn
   *  3.3 times life — at life size a leaf clump has to be that much finer and
   *  the fine octave has to go that much nearer, or a true-size oak wears
   *  clumps a metre across. Applied after the options merge, so an explicit
   *  override (in the old units) is converted as well. */
  C.k = 1;
  C.scale = function (k) { C.k = k || 1; };
  function trueScale(o, worldScaled) {
    var k = C.k;
    if (k === 1) return o;
    // The hedgerow divides its world position instead (`HG_W`), which takes
    // every one of its noises at once, literals and all.
    if (!worldScaled) {
      if (o.freq != null) o.freq /= k;
      if (o.tintFreq != null) o.tintFreq /= k;
    }
    if (o.fadeNear != null) o.fadeNear *= k;
    if (o.fadeFar != null) o.fadeFar *= k;
    if (o.sway != null) o.sway *= k;
    return o;
  }

  C.material = function (mat, opts) {
    if (!mat || mat._canopyShaded) return false;
    var o = trueScale(Object.assign({}, C.defaults, opts || {}));
    var prev = mat.onBeforeCompile;
    var prevKey = mat.customProgramCacheKey;

    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }

      sh.vertexShader = rep(sh.vertexShader, '#include <common>',
        '#include <common>\nvarying vec3 vCanP;\nvarying vec3 vCanW;\nvarying vec3 vCanVN;\nvarying vec3 vCanVP;');
      // `transformedNormal` is the view-space normal after instancing; taking
      // the position from the ATTRIBUTE rather than from `transformed` keeps the
      // noise still while the wind bends the crown — otherwise the leaf pattern
      // swims through the tree as it sways.
      // TWO POSITIONS, AND THEY ARE FOR DIFFERENT THINGS.
      //
      // `vCanP` is the prop's OWN frame and drives the top-to-underside
      // gradient: that has to mean the tree's top and bottom, whatever the
      // camera or the ground is doing.
      //
      // `vCanW` is WORLD space and drives the noise — and that is what stops an
      // oak reading as cauliflower. An oak's crown is four spheres sharing one
      // `geo.ball`, so a noise sampled in LOCAL space gave all four lobes the
      // identical pattern, and a pattern repeated four times in a cluster is
      // precisely what says "these are copies of one object". In world space
      // every lobe, and every tree in the wood, samples a different part of one
      // continuous field. Props do not move, so nothing swims.
      sh.vertexShader = rep(sh.vertexShader, '#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvCanVN = transformedNormal;\nvCanP = position;\n' +
        '#ifdef USE_INSTANCING\n' +
        '  vCanW = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;\n' +
        '#else\n' +
        '  vCanW = (modelMatrix * vec4(position, 1.0)).xyz;\n' +
        '#endif');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>',
        '#include <project_vertex>\nvCanVP = -mvPosition.xyz;');

      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>',
        '#include <common>\nvarying vec3 vCanP;\nvarying vec3 vCanW;\nvarying vec3 vCanVN;\nvarying vec3 vCanVP;\n' + glslNoise());

      // The cut goes in at `<clipping_planes_fragment>`, the first thing in
      // `main`, so a discarded fragment costs nothing else: no lighting, no
      // shadow lookup, no fog, no tone map.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        '  vec3 cnP = vCanW * ' + (+o.freq).toFixed(3) + ';',
        '  float cnD = length(vCanVP);',
        '  float cnFine = 1.0 - smoothstep(' + (+o.fadeNear).toFixed(1) + ', ' + (+o.fadeFar).toFixed(1) + ', cnD);',
        '  float cnLow = cnNoise(cnP * 0.42);',
        '  float cnN = mix(cnLow, cnLow * 0.58 + cnNoise(cnP) * 0.42, cnFine);',
        // How edge-on this fragment is. 0 looking straight at the surface, 1 at
        // the silhouette — which is where a tree has to stop being solid.
        '  float cnRim = 1.0 - clamp(dot(normalize(vCanVN), normalize(vCanVP)), 0.0, 1.0);',
        '  cnRim = pow(cnRim, ' + (+o.edgePow).toFixed(2) + ');',
        '  float cnCut = mix(' + (+o.cut).toFixed(3) + ', ' + (+o.edgeCut).toFixed(3) + ', cnRim);',
        '  if (cnN < cnCut) discard;',
      ].join('\n'));

      // Colour after the base albedo is in `diffuseColor`, before lighting.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>', [
        '#include <color_fragment>',
        // Clumps: the same noise that cut the holes shades what is left, so the
        // gaps and the dark hollows belong to the same structure.
        '  float cnShade = mix(1.0 - ' + (+o.clump).toFixed(3) + ', 1.0, smoothstep(cnCut, 1.0, cnN));',
        // Up-facing leaves take the sky, the underside of the crown goes dark
        // and cool. `vCanP.y` is the prop's own frame, so this is the tree's
        // top and bottom whichever way the camera is.
        '  float cnUp = clamp(normalize(vCanP + vec3(0.0, 0.35, 0.0)).y * 0.5 + 0.5, 0.0, 1.0);',
        '  cnShade *= mix(1.0 - ' + (+o.under).toFixed(3) + ', 1.0, cnUp);',
        '  diffuseColor.rgb *= cnShade;',
        '  diffuseColor.rgb *= mix(vec3(0.88, 0.95, 1.0), vec3(1.0 + ' + (+o.topWarm).toFixed(3) +
          ', 1.0 + ' + (+o.topWarm * 0.55).toFixed(3) + ', 0.90), cnUp);',
        // NO TWO TREES ARE THE SAME GREEN. A wood is not a colour, it is a
        // range of them — one oak going over to yellow beside one still deep in
        // summer — and every tree on the map wearing the identical green is as
        // strong a "these are copies" cue as the identical noise pattern was.
        // Sampled at very low frequency in WORLD space, so it varies from tree
        // to tree and not within one crown.
        '  float cnTree = cnNoise(vCanW * ' + (+o.tintFreq).toFixed(3) + ' + 61.2);',
        '  diffuseColor.rgb *= mix(vec3(1.0 - ' + (+o.tint).toFixed(3) + ', 1.0, 1.0 - ' +
          (+o.tint * 0.55).toFixed(3) + '), vec3(1.0 + ' + (+o.tint).toFixed(3) + ', 1.0 + ' +
          (+o.tint * 0.35).toFixed(3) + ', 1.0 - ' + (+o.tint * 0.8).toFixed(3) + '), cnTree);',
      ].join('\n'));

      if (!ok) { C.failed = (C.failed || 0) + 1; }
    };

    // Two materials sharing this body still compile twice unless they agree on
    // a key — and the sway hook's own key has to survive, or the wind variants
    // collapse into one program.
    mat.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + '|can3';
    };
    // The noise is the detail now. Facets were the old way of getting some, and
    // with a procedural crown they only flatten it back into a polyhedron.
    mat.flatShading = false;
    mat._canopyShaded = true;
    // Built here because this is where the sway hook (`prev`) is in hand. The
    // renderer only uses it if something hangs it on a mesh — see where the
    // prop batcher builds its InstancedMesh.
    mat._canopyDepth = C.depthFor(mat, o, prev);
    mat.needsUpdate = true;
    return true;
  };

  /**
   * THE SHADOW HAS TO AGREE WITH THE CROWN.
   *
   * Three.js renders the shadow pass with its OWN depth material, which knows
   * nothing about a cutout done in the colour pass — the same fault round 44
   * found in the grass (see `makeDepthMaterial` in assets/foliage.js). Left
   * alone, a crown that is all lace and gaps casts the solid shadow of the cone
   * underneath it, which is the "two things that do not agree" problem this
   * file exists to fix, moved from the tree to the ground beneath it.
   *
   * The depth twin runs the same noise at the same frequency, so the holes in
   * the shadow are the holes in the tree, and the light comes through a wood in
   * patches. Two differences from the colour pass, both deliberate:
   *
   *   · NO RIM TERM. It is view-dependent, and the depth pass's view is the
   *     sun's. `<defaultnormal_vertex>` is also inside `#ifdef USE_DISPLACEMENTMAP`
   *     in the depth shader, so `transformedNormal` is not even in scope there.
   *     A single threshold between the body's and the edge's is the right
   *     analogue and it is cheaper.
   *   · NO FINE OCTAVE FADE. A shadow map is low-frequency by the time it is
   *     sampled; the grain would be filtered away and only cost fill.
   *
   * It carries the same wind hook as its colour twin, or the shadow stands
   * still while the tree moves.
   */
  C.depthFor = function (mat, o, prev) {
    var dm = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: mat.side,
      alphaTest: 0.5,          // marks the material as cutout for Three's sorting
    });
    dm.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);      // the same sway as the crown
      sh.vertexShader = sh.vertexShader.replace('#include <common>',
        '#include <common>\nvarying vec3 vCanP;');
      // World space here too, or the shadow's holes stop being the crown's.
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n' +
        '#ifdef USE_INSTANCING\n' +
        '  vCanP = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;\n' +
        '#else\n' +
        '  vCanP = (modelMatrix * vec4(position, 1.0)).xyz;\n' +
        '#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>',
        '#include <common>\nvarying vec3 vCanP;\n' + glslNoise());
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        '  float cnS = cnNoise(vCanP * ' + (+o.freq * 0.42).toFixed(3) + ');',
        '  if (cnS < ' + (+o.shadowCut).toFixed(3) + ') discard;',
      ].join('\n'));
    };
    dm.customProgramCacheKey = function () { return 'canDepth2|' + o.freq + '|' + o.shadowCut; };
    return dm;
  };

  /**
   * BARK — the trunk was the last flat thing on a tree.
   *
   * The crown has been worked for two rounds and the trunk under it was still
   * one smooth tapered cylinder in one flat brown: at close range the most
   * obviously untextured object left in the frame, and the thing that made a
   * finished canopy look like it was floating on a dowel.
   *
   * Bark runs in VERTICAL ridges, which is a noise stretched along Y — sampled
   * with the angle round the trunk as one axis and the height as the other, so
   * the pattern wraps seamlessly instead of seaming down one side the way a
   * planar projection would. Two octaves at different stretches: a broad one
   * for the plates of bark, a tighter one for the fissures between them.
   *
   * Object space, not world: a trunk is a cylinder about its OWN axis, and the
   * angle only means anything there.
   */
  C.bark = function (mat, opts) {
    if (!mat || mat._barked) return false;
    // TUNED BY LOOKING AT IT. The first set — grain 0.26, fissure 0.30, ridges
    // 2.4 — was visible in a screenshot only if you knew it was there: at six
    // units from the trunk it read as a faint lighter band and nothing else.
    // Bark at arm's length is PLATES and CRACKS, and the crack has to be a
    // crack. More ridges round the trunk, a deeper fissure, and a lower
    // threshold so more of the surface is broken by one.
    var o = Object.assign({ grain: 0.34, fissure: 0.52, ridges: 5.2, stretch: 0.30,
                            fissureLo: 0.46, fissureHi: 0.74,
                            fadeNear: 16.0, fadeFar: 44.0 }, opts || {});
    var prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      function rep(src, from, to) { return src.indexOf(from) < 0 ? src : src.replace(from, to); }
      sh.vertexShader = rep(sh.vertexShader, '#include <common>',
        '#include <common>\nvarying vec3 vBkP;\nvarying vec3 vBkV;');
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>',
        '#include <begin_vertex>\nvBkP = position;');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>',
        '#include <project_vertex>\nvBkV = -mvPosition.xyz;');
      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>',
        '#include <common>\nvarying vec3 vBkP;\nvarying vec3 vBkV;\n' + glslNoise());
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>', [
        '#include <color_fragment>',
        '{',
        '  float bkA = atan(vBkP.x, vBkP.z);',
        // The angle is the wrap axis, so there is no seam; Y is squashed, which
        // is what turns a blob noise into a vertical grain.
        '  float bkG = cnNoise(vec3(bkA * ' + (+o.ridges).toFixed(2) + ', vBkP.y * ' +
          (+o.stretch).toFixed(2) + ', 0.0));',
        '  float bkF = cnNoise(vec3(bkA * ' + (+o.ridges * 2.9).toFixed(2) + ', vBkP.y * ' +
          (+o.stretch * 1.7).toFixed(2) + ', 11.3));',
        '  float bkFade = 1.0 - smoothstep(' + (+o.fadeNear).toFixed(1) + ', ' +
          (+o.fadeFar).toFixed(1) + ', length(vBkV));',
        '  float bkTone = 1.0 + (bkG - 0.5) * 2.0 * ' + (+o.grain).toFixed(3) + ';',
        // The fissures are DARK and narrow — a smoothstep high up the range, so
        // most of the trunk is plate and a little of it is crack.
        '  bkTone *= 1.0 - smoothstep(' + (+o.fissureLo).toFixed(2) + ', ' +
          (+o.fissureHi).toFixed(2) + ', bkF) * ' + (+o.fissure).toFixed(3) + ';',
        '  diffuseColor.rgb *= mix(1.0, bkTone, bkFade);',
        '}',
      ].join('\n'));
    };
    mat.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + '|bark2';
    };
    mat.flatShading = false;      // the grain is the detail; facets fight it
    mat._barked = true;
    mat.needsUpdate = true;
    return true;
  };

  /**
   * THE HEDGEROW (round 98) — bank, crown and verge in ONE material.
   *
   * A bocage hedge was a crown of eight faceted balls in one of three flat
   * greens, and then a bank under it in a second material: a row of green
   * beads on a smooth green pipe, and 27 geometry/material pairs, each a draw
   * call in every sector of the map. Now each baked variant is one geometry
   * carrying all three parts, told apart by a per-vertex attribute:
   *
   *     hedge.x  what it is — 0 the earth bank, 1 the foliage, 2 the grass
   *              at the foot of the bank, 3 bark (the trees use this material
   *              too: trunk, limbs and crown in one geometry), 4 dressed or
   *              field stone (walls: mottled, moss on what faces the sky,
   *              never the bank's bare-earth patches down a vertical face)
   *              — and for stone, hedge.z is how DRY the country is: 0 moss
   *              on the tops, 1 none (desert, coral, ash), the tops bleached
   *              by the sun and the faces streaked with desert varnish
   *     hedge.y  how far it moves in the wind — none for the bank, most at
   *              the top of the crown
   *     hedge.z  for the grass, how far up the blade (0 root, 1 tip)
   *
   * The colour is in the vertex colours (species per clump, occlusion baked
   * in the crevices and underneath), the leaf and blade detail is here.
   *
   *   · the FOLIAGE is the crown shader's: world-space noise, cut open toward
   *     the silhouette so the outline ends in leaves. Its normals are bent
   *     toward the hedge's own axis when it is built, so the clumps shade as
   *     one mass instead of a string of balls;
   *   · the BANK is solid, mottled by the same noise;
   *   · the GRASS is noise stretched upright — blades — cut more and more
   *     toward the tip, and a plain band past `fadeFar`, because a
   *     high-frequency cut at range is how grass boils.
   *
   * The wind phase is taken from the VERTEX's world position, not the
   * prop's, so a gust runs along a hedge line instead of every cell nodding
   * on its own. `opts.wind` carries the game's shared wind uniforms.
   */
  /** SNOW on the hedgerow material — hedges, trees, conifers — shared by all
   *  of them: 0 in summer, 1 on a field that is white. The terrain sets it
   *  when it has counted its own snow (`Terrain.snowCover`). */
  C.snow = { value: 0 };
  /** THE STONE PALETTE IS NOT LINEAR ALBEDO (round 103). The kit's stone
   *  colours — Caen limestone at 0.54, granite at 0.40 — were picked by eye,
   *  which is to say in sRGB, and went into the vertex buffer as if they
   *  were the fraction of light the stone reflects. Lit that way a field of
   *  limestone walls and boulders stood white as sugar against grass half
   *  as bright (the same fault the vehicles had in round 45). Decoded part
   *  of the way here, for every stone prop at once: 0.54 -> 0.33, 0.40 ->
   *  0.22 — weathered limestone and granite, measured in the prop gallery
   *  (tools/probe_propgallery.js). */
  C.stoneGamma = { value: 1.8 };
  /** (round 118, `game.fpvNear118`) THE SKY ON A PROP IN SHADE, NEAR THE EYE.
   *  Every fence in first person drew solid black, and so did the shaded side
   *  of every crate, cart, trunk and hedge within a few metres. Measured
   *  (r118near s1): not this file's shading (a plain Lambert with the same
   *  vertex colours is as dark: 80% of fence pixels under 30/255 against 85%),
   *  not the shadow receive, not the fog; the albedo is right (untoned
   *  178/255). It is the fault round 98 found in the buildings
   *  (assets/fabric.js `sky`): Lambert sums the sun, the sky fill and the
   *  bounce per vertex and multiplies the lot by the SUN's shadow mask, so a
   *  face turned from the sun keeps only ambient + hemisphere — a white face
   *  85/255, a 0.45 wood 24/255 after the grade. Buildings got their sky back
   *  (x3.6); the props never did, and at the playing camera nobody sees the
   *  side of a fence. This gives it back WHERE THE SUN DOES NOT REACH (the
   *  direct light that survived the shadow mask, against the sky) and NEAR
   *  THE EYE (faded out by world distance, so the playing camera is the old
   *  picture): x, solid (wood, bark, stone, earth); y, leaves and blades; z..w,
   *  the fade in world units. `near` is live: 0 is the old drawing exactly. */
  // …AND ONLY UNDER A SUN. Overcast, the sky is the light and nothing lost its
  // fill: a x3.6 sky there turned a fence to driftwood (Village fog, 88 -> 128).
  // So the weight is how far the sun outshines the sky (sun / (ambient + hemi):
  // ~9 on a clear morning, ~6 in the game's fog, ~3.9 on snow, whose glare
  // raises the fill, 0 at night), 0 below 1.5, 1 above 3.5.
  C.near = { get value() {
    var g = root.game; if (!g || !g.fpvNear118) return 0;
    var s = g.sun ? g.sun.intensity : 0, a = (g.ambientLight ? g.ambientLight.intensity : 0) + (g.hemiLight ? g.hemiLight.intensity : 0);
    var t = Math.min(1, Math.max(0, (s / Math.max(a, 1e-3) - 1.5) / 2));
    return t * t * (3 - 2 * t);
  } };
  // x3.6 is the buildings' own sky; leaves x5 (a crown against the sun read 11/255,
  // x3.6 47, x5-6 a hedge), the verge's blades half way (x6 made them glow)
  C.nearSky = { value: [3.6, 5.0, 12.0, 36.0] };
  // the sun's own luminance (colour x intensity): a face is in shade when the
  // direct light that reached it is a small part of THAT, not of the sky
  // (in haze a face lit at a grazing angle had more sun than sky, and read as
  // shade by a sun/sky ratio: the fence went to driftwood)
  // …and a face in shade is never lit past this share of the full sun: in the
  // game's fog the sky is brighter, and x3.6 of it made Village's posts paler
  // in shade than in sun (r118near s7 B_fence_wi_fog). Clear days never reach it.
  C.nearCap = { value: 0.35 };
  C.nearSun = { get value() { var s = root.game && root.game.sun; return s ? s.intensity * (0.2126 * s.color.r + 0.7152 * s.color.g + 0.0722 * s.color.b) : 1; } };

  C.hedgerow = function (mat, opts) {
    if (!mat || mat._hedgerow) return false;
    var o = Object.assign({ freq: 20.0, fadeNear: 16.0, fadeFar: 44.0, cut: 0.16, edgeCut: 0.62, edgePow: 1.35,
      clump: 0.34, topWarm: 0.12, shadowCut: 0.22, tint: 0.10, tintFreq: 0.07,
      blade: 26.0, bankMottle: 0.26, sway: 0.35, perProp: 0.0, deciduous: false, wind: null }, opts || {});
    trueScale(o, true);
    var HG_W = C.k === 1 ? 'hgWP' : '(hgWP * ' + (1 / C.k).toFixed(5) + ')';
    // DECIDUOUS: an oak, a hawthorn hedge, a hazel bush is BARE in the snow —
    // a full green crown under snow read as a pile of snowballs. As the winter
    // comes in (`C.snow`) the leaves go: the cut rises until what is left is a
    // lace of twigs, brown-grey, with patches of holly and ivy that keep their
    // green. The conifers keep their needles (and the snow on them).
    var BARE = o.deciduous ? '    hgBare = smoothstep(0.12, 0.40, uHgSnow) * (1.0 - step(0.74, cnNoise(vHgW * 0.9 + 17.0)));' : '';
    var W = o.wind || { uTime: { value: 0 }, uWind: { value: new THREE.Vector4(1, 0, 0, 1) } };
    var f = function (v, n) { return (+v).toFixed(n == null ? 3 : n); };

    // The same displacement in the colour pass and the shadow pass, or the
    // shadow stands still while the hedge moves.
    var SWAY = [
      'vec3 transformed = vec3( position );',
      '#ifdef USE_INSTANCING',
      '  mat4 hgM = modelMatrix * instanceMatrix;',
      '#else',
      '  mat4 hgM = modelMatrix;',
      '#endif',
      '  vec3 hgAX = hgM[0].xyz, hgAZ = hgM[2].xyz;',
      '  float hgSX = max(length(hgAX), 1e-4), hgSZ = max(length(hgAZ), 1e-4);',
      '  hgAX /= hgSX; hgAZ /= hgSZ;',
      '  vec3 hgWP = (hgM * vec4(position, 1.0)).xyz;',
      '  float hgPh = hgWP.x * 0.19 + hgWP.z * 0.23;',
      '  float hgG = sin(uTime * uWind.w + hgPh) + 0.42 * sin(uTime * uWind.w * 2.3 + hgPh * 1.7);',
      '  vec2 hgWv = uWind.xy * (uWind.z * uHgSway * hgG) * (hedge.y * 0.37);',
      '  transformed.x += (hgWv.x * hgAX.x + hgWv.y * hgAX.z) / hgSX;',
      '  transformed.z += (hgWv.x * hgAZ.x + hgWv.y * hgAZ.z) / hgSZ;',
    ].join('\n');
    var HEAD = 'attribute vec3 hedge;\nuniform float uTime;\nuniform vec4 uWind;\nuniform float uHgSway;\n';
    // `hedgeRim` is the clump's own normal: the lighting normal is bent toward the
    // hedge's axis so the mass shades as one, and a rim read off THAT finds no
    // edge at a clump's outline — every clump ended in a clean polygon.

    var prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (sh) {
      var ok = true;
      function rep(src, from, to) { if (src.indexOf(from) < 0) { ok = false; return src; } return src.replace(from, to); }
      sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind; sh.uniforms.uHgSway = { value: o.sway };
      sh.uniforms.uHgSnow = C.snow; sh.uniforms.uHgStoneGamma = C.stoneGamma;
      sh.uniforms.uHgNear = C.near; sh.uniforms.uHgNearSky = C.nearSky; sh.uniforms.uHgNearSun = C.nearSun; sh.uniforms.uHgNearCap = C.nearCap;
      sh.vertexShader = rep(sh.vertexShader, '#include <common>',
        '#include <common>\n' + HEAD + 'attribute vec3 hedgeRim;\nattribute vec2 hedgeUP;\nvarying vec3 vHgW;\nvarying vec3 vHgVN;\nvarying vec3 vHgVP;\nvarying vec4 vHgK;\nvarying float vHgU;\nvarying float vHgPH;');
      // `vHgPH`: one number per PROP, from where it stands — a wood is a range of
      // greens tree by tree (see `perProp`), where a hedge line is one green
      // that drifts along it (see `tint`).
      // …or, for a piece MERGED into a world-space mesh (a draped line piece,
      // `PropBatcher._mergeDraped`, round 106), the same two numbers carried
      // per vertex (`hedgeUP`): its own x and its own place are gone from
      // `position` and `modelMatrix`, and the row of grass blades along a
      // merged wall read the WORLD x — a level green band along any wall that
      // ran north–south. An instanced piece has no `hedgeUP` and reads zero.
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>', SWAY + '\n  vHgW = ' + HG_W + ';\n  vHgU = hedgeUP.x != 0.0 ? hedgeUP.x : position.x + dot(hgM[3].xz, vec2(0.37, 0.61));' +
        '\n  vHgPH = hedgeUP.x != 0.0 ? hedgeUP.y : fract(sin(dot(floor(hgM[3].xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453);');
      // `objectNormal.y` is the world normal's y too: a prop only ever turns
      // about the vertical, so it is what faces the sky.
      sh.vertexShader = rep(sh.vertexShader, '#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvec3 hgRN = hedgeRim;\n#ifdef USE_INSTANCING\n' +
        // TRUE SCALE (round 105): a line prop keeps its length and loses height
        // and depth, so its instance scale is not uniform — and a normal taken
        // through a squashed matrix leans toward the long axis, every clump
        // reads as silhouette, and the rim cut threw the whole crown away. The
        // same correction three applies to the lighting normal: divide by the
        // squared column lengths first.
        (C.k !== 1 ? '  mat3 hgNM = mat3(instanceMatrix);\n  hgRN /= vec3(dot(hgNM[0], hgNM[0]), dot(hgNM[1], hgNM[1]), dot(hgNM[2], hgNM[2]));\n  hgRN = hgNM * hgRN;\n'
                   : '  hgRN = mat3(instanceMatrix) * hgRN;\n') +
        '#endif\n' +
        'vHgVN = normalMatrix * hgRN;\nvHgK = vec4(hedge, objectNormal.y);');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>',
        '#include <project_vertex>\nvHgVP = -mvPosition.xyz;');

      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>',
        '#include <common>\nuniform float uHgSnow;\nuniform float uHgStoneGamma;\nuniform float uHgNear;\nuniform vec4 uHgNearSky;\nuniform float uHgNearSun;\nuniform float uHgNearCap;\nvarying vec3 vHgW;\nvarying vec3 vHgVN;\nvarying vec3 vHgVP;\nvarying vec4 vHgK;\nvarying float vHgU;\nvarying float vHgPH;\n' + glslNoise() +
        '\nfloat hgBlade(float u, float n, float o){ float b = u * n + o; float h = 0.42 + 0.58 * fract(sin(floor(b) * 12.9898 + o) * 43758.5453); return h * pow(1.0 - abs(fract(b) - 0.5) * 2.0, 0.55); }');
      sh.fragmentShader = rep(sh.fragmentShader, '#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        '  float hgD = length(vHgVP);',
        '  float hgFine = 1.0 - smoothstep(' + f(o.fadeNear, 1) + ', ' + f(o.fadeFar, 1) + ', hgD);',
        '  vec3 hgP = vHgW * ' + f(o.freq) + ';',
        '  float hgLow = cnNoise(hgP * 0.42);',
        '  float hgN = mix(hgLow, hgLow * 0.58 + cnNoise(hgP) * 0.42, hgFine);',
        '  float hgCut = -1.0;',
        '  float hgTone = 1.0;',
        '  float hgBare = 0.0;',
        '  if (vHgK.x > 2.5) {',                          // bark and stone: solid
        '  } else if (vHgK.x > 1.5) {',
        // BLADES: two offset rows of pointed blades of random height along the
        // hedge — a row of grass in silhouette. Past `fadeFar` the verge is a
        // band cut level at half its height, because blades a pixel wide are
        // how grass boils.
        '    float hgB = max(hgBlade(vHgU, ' + f(o.blade) + ', 0.0), hgBlade(vHgU, ' + f(o.blade * 1.37) + ', 17.3) * 0.9);',
        '    if (vHgK.z > mix(0.55, hgB, hgFine)) discard;',
        '    hgTone = mix(1.0, 0.86 + hgB * 0.3, hgFine);',
        '  } else if (vHgK.x > 0.5) {',
        '    float hgRim = 1.0 - clamp(dot(normalize(vHgVN), normalize(vHgVP)), 0.0, 1.0);',
        '    hgCut = mix(' + f(o.cut) + ', ' + f(o.edgeCut) + ', pow(hgRim, ' + f(o.edgePow, 2) + '));',
        BARE,
        '    hgCut = mix(hgCut, max(hgCut, 0.60), hgBare);',
        '  }',
        '  if (hgN < hgCut) discard;',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>', [
        '#include <color_fragment>',
        '  if (vHgK.x > 3.5) {',
        // STONE: the palette decoded toward linear albedo (`C.stoneGamma`)…
        '    diffuseColor.rgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(uHgStoneGamma));',
        // …the noise as weathering, and moss or lichen on the tops
        '    diffuseColor.rgb *= (0.84 + hgN * 0.26) * (0.86 + 0.28 * cnNoise(vHgW * 2.3 + 1.7));',
        '    float hgMoss = smoothstep(0.55, 0.95, vHgK.w) * smoothstep(0.42, 0.72, cnNoise(vHgW * 4.3 + 3.1)) * (1.0 - vHgK.z);',
        '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.25, 0.12) * (0.8 + hgN * 0.4), hgMoss * 0.55);',
        // dry country: bleached where the sun stands on it, and dark streaks
        // run down the faces (noise stretched upright is a streak)
        '    float hgVar = smoothstep(0.45, 0.75, cnNoise(vec3(vHgW.x * 9.0, vHgW.y * 1.1, vHgW.z * 9.0) + 5.3)) * (1.0 - smoothstep(0.45, 0.85, vHgK.w));',
        '    diffuseColor.rgb *= 1.0 + vHgK.z * (0.10 * smoothstep(0.6, 0.95, vHgK.w) - 0.38 * hgVar);',
        '  } else if (vHgK.x > 2.5) {',
        // BARK: noise stretched upright in world space is vertical grain on a
        // trunk — plates, and narrow dark fissures between them (the tree
        // bark of `C.bark`, without its own-frame angle, which a merged
        // trunk-and-limbs geometry does not have).
        '    float hgG1 = cnNoise(vec3(vHgW.x * 7.0, vHgW.y * 1.3, vHgW.z * 7.0));',
        '    float hgG2 = cnNoise(vec3(vHgW.x * 19.0, vHgW.y * 2.4, vHgW.z * 19.0) + 11.3);',
        // …which on a face turned to the sky (a cart's bed, the top of a
        // crate) is not grain but blotches: it fades there
        '    float hgGA = 1.0 - 0.75 * abs(vHgK.w);',
        '    diffuseColor.rgb *= (1.0 + (hgG1 - 0.5) * 0.55 * hgGA) * (1.0 - smoothstep(0.46, 0.74, hgG2) * 0.5 * hgFine * hgGA);',
        '  } else if (vHgK.x > 1.5) {',
        '    diffuseColor.rgb *= hgTone;',
        '  } else if (vHgK.x > 0.5) {',
        '    diffuseColor.rgb *= mix(1.0 - ' + f(o.clump) + ', 1.0, smoothstep(hgCut, 1.0, hgN));',
        '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.150, 0.125, 0.100) * (0.75 + hgN * 0.5), hgBare);',
        '    float hgUp = clamp(vHgK.w, 0.0, 1.0);',
        '    diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0 + ' + f(o.topWarm) + ', 1.0 + ' + f(o.topWarm * 0.6) + ', 0.94), hgUp);',
        (o.perProp > 0 ? '    diffuseColor.rgb *= mix(vec3(1.0 - ' + f(o.perProp * 1.5) + ', 1.0 - ' + f(o.perProp * 0.75) + ', 1.0 - ' +
          f(o.perProp * 1.8) + '), vec3(1.0 + ' + f(o.perProp * 1.2) + ', 1.0 + ' + f(o.perProp * 0.6) + ', 1.0 - ' + f(o.perProp * 0.45) + '), vHgPH);' : ''),
        '  } else {',
        '    diffuseColor.rgb *= 1.0 - ' + f(o.bankMottle) + ' + hgN * ' + f(o.bankMottle * 1.25) + ';',
        // bare earth where the flank is steep and the turf has slipped: broad
        // patches, never on the crest
        '    float hgBare = smoothstep(0.46, 0.30, cnNoise(vHgW * 3.1 + 7.7)) * (1.0 - smoothstep(0.55, 0.92, vHgK.w));',
        '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.225, 0.168, 0.104) * (0.8 + hgN * 0.4), hgBare * 0.85);',
        '  }',
        // One green does not run the length of a hedge line — sampled slowly in
        // world space, so it changes over a field's length, not cell to cell.
        '  float hgT = cnNoise(vHgW * ' + f(o.tintFreq) + ' + 61.2);',
        '  diffuseColor.rgb *= mix(vec3(1.0 - ' + f(o.tint) + ', 1.0, 1.0 - ' + f(o.tint * 0.55) + '), vec3(1.0 + ' +
          f(o.tint) + ', 1.0 + ' + f(o.tint * 0.35) + ', 1.0 - ' + f(o.tint * 0.8) + '), hgT);',
        // …and SNOW, last, so no tint greens it. It lies on what faces the
        // sky — the tops of the tiers, the crowns, the crest of the bank and
        // the upper side of a limb — broken by the same noise the leaves
        // are, never on an underside.
        '  if (uHgSnow > 0.0) {',
        '    float hgSn = smoothstep(0.50, 0.86, vHgK.w + (hgN - 0.5) * 0.75) * uHgSnow * 0.9;',
        '    if (vHgK.x > 1.5 && vHgK.x < 2.5) hgSn *= 0.6;',
        '    hgSn *= 1.0 - hgBare * 0.65;',                   // bare twigs hold little of it
        // …nor does freshly turned earth (a crater's lip: earth with hedge.z 1)
        '    if (vHgK.x < 0.5) hgSn *= 1.0 - vHgK.z;',
        '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.82, 0.86), hgSn);',
        '  }',
      ].join('\n'));
      // (round 118, `C.near`) after the direct light has met the shadow mask:
      // the share of sky a face in shade lost with its fill, given back near
      // the eye. Lambert only (the line is its own); skipped whole when off.
      var hgDL = 'reflectedLight.directDiffuse *= BRDF_Diffuse_Lambert( diffuseColor.rgb ) * getShadowMask();';
      if (sh.fragmentShader.indexOf(hgDL) >= 0) {
        sh.fragmentShader = sh.fragmentShader.replace(hgDL, hgDL + [
          '',
          '\tif (uHgNear > 0.0) {',
          '\t\tvec3 hgLw = vec3(0.2126, 0.7152, 0.0722);',
          '\t\tfloat hgSunR = dot(reflectedLight.directDiffuse, hgLw) / max(dot(diffuseColor.rgb * RECIPROCAL_PI, hgLw) * PI * uHgNearSun, 1e-5);',
          // the sky fill is not under the sun's mask on a thin prop, so a face
          // in shade still has a little direct light: only the SUN's share
          // (several times the sky's) counts as sunlit
          '\t\tfloat hgShd = 1.0 - smoothstep(0.06, 0.30, hgSunR);',
          '\t\tfloat hgNr = 1.0 - smoothstep(uHgNearSky.z, uHgNearSky.w, hgD);',
          '\t\tfloat hgSk = vHgK.x > 1.5 && vHgK.x < 2.5 ? 1.0 + (uHgNearSky.y - 1.0) * 0.5 : (vHgK.x > 0.5 && vHgK.x < 1.5 ? uHgNearSky.y : uHgNearSky.x);',
          '\t\tfloat hgInE = dot(reflectedLight.indirectDiffuse, hgLw) / max(dot(diffuseColor.rgb, hgLw), 1e-5);',
          '\t\tfloat hgMul = 1.0 + (hgSk - 1.0) * hgShd * hgNr * uHgNear;',
          '\t\treflectedLight.indirectDiffuse *= min(hgMul, max(1.0, uHgNearCap * uHgNearSun / max(hgInE, 1e-5)));',
          '\t}',
        ].join('\n'));
      }
      if (!ok) { C.failed = (C.failed || 0) + 1; }
    };
    mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|hedgerow8|' + o.freq + '|' + o.cut + '|' + o.edgeCut + '|' + o.perProp + '|' + (o.deciduous ? 'D' : '') + '|' + C.k; };
    mat.vertexColors = true;
    mat._hedgerow = true;
    mat._canopyShaded = true;

    // The shadow: the bank solid, the crown with the crown's holes, the grass
    // none at all (it lies on the bank; its shadow would be a smudge that
    // costs the whole verge a second time).
    var dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5 });
    dm.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind; sh.uniforms.uHgSway = { value: o.sway };
      sh.uniforms.uHgSnow = C.snow;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + HEAD + 'varying vec3 vHgW;\nvarying float vHgKind;');
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', SWAY + '\n  vHgW = ' + HG_W + ';\n  vHgKind = hedge.x;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>',
        '#include <common>\nuniform float uHgSnow;\nvarying vec3 vHgW;\nvarying float vHgKind;\n' + glslNoise());
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        '  if (vHgKind > 1.5 && vHgKind < 2.5) discard;',
        '  float hgBare = 0.0;',
        BARE,
        '  if (vHgKind > 0.5 && vHgKind < 1.5 && cnNoise(vHgW * ' + f(o.freq * 0.42) + ') < mix(' + f(o.shadowCut) + ', 0.66, hgBare)) discard;',
      ].join('\n'));
    };
    dm.customProgramCacheKey = function () { return 'hedgerowDepth3|' + o.freq + '|' + o.shadowCut + '|' + (o.deciduous ? 'D' : '') + '|' + C.k; };
    mat._canopyDepth = dm;
    mat.needsUpdate = true;
    return true;
  };

  /** Apply to an array (the palette variants) and return it, for chaining. */
  C.all = function (arr, opts) {
    for (var i = 0; i < arr.length; i++) C.material(arr[i], opts);
    return arr;
  };

  root.Canopy = C;
})(window);
