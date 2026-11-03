/* ===========================================================================
 * FABRIC — what a building is made of, in the shader
 * ---------------------------------------------------------------------------
 * ONE MATERIAL DRAWS EVERY STRUCTURE IN THE GAME. That is a good decision — the
 * whole village is one batch and colour comes per-vertex, so brick, thatch,
 * plaster and charred timber share it — but it means a wall is a single flat
 * value over its entire face and a roof is a single flat value over its entire
 * pitch. Seen from the camera this game actually uses, which looks DOWN, most
 * of a village is roof, and a roof was a smooth salmon-coloured plane.
 *
 * Nothing here is a texture. There are no UVs to unwrap on procedurally built
 * geometry and no atlas to download; the surface is worked out from the
 * position and the normal that are already in the vertex stream:
 *
 *   COURSES      A roof is tiles laid in courses parallel to the eaves and a
 *                wall is blocks laid in courses parallel to the ground, so both
 *                are bands in Y. That single fact does most of the work: the
 *                banding is what says "this is made of many small things" and
 *                it is what a flat plane cannot say.
 *   EACH ONE     Quantising the position into the course grid and hashing it
 *                gives every tile and every block its own tone. Real roofs are
 *                mottled because tiles were fired in different batches and have
 *                weathered differently, and it is the strongest single cue that
 *                a roof is a roof.
 *   THE SHADOW   A thin darker line at each course boundary — the lip where one
 *                tile overlaps the next, and the mortar between two stones.
 *
 * ROOF OR WALL IS READ FROM THE NORMAL, not from the material, because there is
 * only the one material. A near-vertical face is masonry and takes coarse
 * courses; anything pitched or flat is roof and takes fine ones.
 *
 * …AND IT FADES WITH DISTANCE, for the reason the canopy's does (assets/canopy.js):
 * a course is a high-frequency pattern, and at the range a village is usually
 * seen one pixel spans several of them. Left alone that boils. The contrast
 * ramps out between `fadeNear` and `fadeFar`, leaving the flat colour that was
 * there before at ranges where nothing better could be resolved anyway.
 * ======================================================================== */
(function (root) {
  'use strict';

  var F = {};

  F.defaults = {
    // Course spacing in world units. The drawn world is a diorama — a storey is
    // about 2.6 units — so these are chosen to READ at playing range rather
    // than to be literally a tile deep.
    // LIFE SIZE (round 106). These were 0.26 / 0.34 for a roof and 0.42 / 0.62
    // for a wall — at true scale a 35 cm roof tile and a 57 x 85 cm block, so a
    // brick wall was laid in stones the size of a suitcase. Now a slate or tile
    // course is 18 cm, a rubble-stone course 32 cm, and a BRICK course 7.5 cm
    // (a 23 cm brick and its mortar) — brick told apart by its own colour, the
    // only masonry far redder than it is green.
    tileCourse: 0.132,     // roof tiles: 18 cm at true scale
    tileRun: 0.176,        // …24 cm along the course
    wallCourse: 0.235,     // stone courses: 32 cm
    wallRun: 0.403,        // …55 cm blocks
    brickCourse: 0.055,    // brick: 7.5 cm courses
    brickRun: 0.169,       // …23 cm bricks
    brickNear: 13.2,       // a 7.5 cm course is a pixel at ~90 m: gone by 40
    brickFar: 29.3,
    boardRun: 0.11,        // wood: boards 15 cm wide, on end
    weather: 2.57,         // weathering: ~3.5 m blotches at true scale
    weatherAmp: 0.16,
    mottle: 0.17,          // how much one tile differs from the next
    line: 0.22,            // the course shadow
    lineW: 0.13,           // …and how wide a share of the course it takes
    fadeNear: 26.0,
    fadeFar: 62.0,
    // THE SKY ON A WALL IN SHADE (round 98). Lambert sums every directional
    // light per vertex — the sun, the cool fill meant for the shadow side, the
    // bounce — and then multiplies the lot by the SUN's shadow mask, so a wall
    // facing away from the sun lost its fill too and kept only the ambient:
    // after the grade's curve, near-black, shutters and all. Units get their
    // fill back from assets/unitshade.js and the ground from its own term;
    // buildings had nothing. This scales their sky (ambient + hemisphere).
    // AT TRUE SCALE (round 106) a house is seen from beside it, and its walls
    // in shade were still black: a white wall's shaded face read (34,39,42)
    // against its sunlit gable's (235,234,230) on Villers-Bocage at 08:40 —
    // 40 to 1 in linear light, where a clear day gives a white wall 5-8 to 1.
    // At 3.6 it reads (80,86,87), about 11 to 1: still the hard key and the
    // dark shadows the look is built on, and the courses and brick show in
    // them. Rain (Ortona) and night (23:30) checked: no wall glows.
    sky: 3.6,
  };
  /** Live, so it can be tuned in the page: Fabric.sky.value = 2.0 */
  F.sky = { value: F.defaults.sky };
  /** TRUE SCALE (round 105): the game's building factor, once. The courses
   *  above were chosen for a storey of 2.6 units; a life-size storey is three
   *  metres, and its tiles and blocks — and the range at which a course is
   *  smaller than a pixel — come down with it. */
  F.scale = function (k) {
    if (!k || k === 1 || F._k) return;
    F._k = k;
    var D = F.defaults;
    D.tileCourse *= k; D.tileRun *= k; D.wallCourse *= k; D.wallRun *= k;
    D.brickCourse *= k; D.brickRun *= k; D.brickNear *= k; D.brickFar *= k; D.boardRun *= k; D.weather *= k;
    D.fadeNear *= k; D.fadeFar *= k;
  };

  function glsl(o) {
    return [
      'float fbHash(vec3 p){',
      '  p = fract(p * 0.3183099 + vec3(0.41, 0.17, 0.83));',
      '  p *= 23.0;',
      '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
      '}',
      // a smooth value noise: the weathering across a whole front
      'float fbNoise(vec3 p){',
      '  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mix(fbHash(i), fbHash(i + vec3(1.0, 0.0, 0.0)), f.x),',
      '                 mix(fbHash(i + vec3(0.0, 1.0, 0.0)), fbHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),',
      '             mix(mix(fbHash(i + vec3(0.0, 0.0, 1.0)), fbHash(i + vec3(1.0, 0.0, 1.0)), f.x),',
      '                 mix(fbHash(i + vec3(0.0, 1.0, 1.0)), fbHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);',
      '}',
    ].join('\n');
  }

  function chunk(o) {
    var f = function (v) { return (+v).toFixed(4); };
    return [
      '{',
      '  float fbUp = abs(normalize(vFabN).y);',
      // A near-vertical face is masonry; anything pitched or flat is roof.
      '  bool  fbRoof = fbUp > 0.45;',
      // …and WHAT the wall is, from its own colour (round 106). The vertex
      // colour is the material's hex as it stands (assets/structures.js MATS):
      // brick 0.46 far redder than green, timber and planking 0.24, thatch
      // 0.16, stone and concrete near 0. Brick is laid in 7.5 cm courses,
      // stone in 32 cm ones, and wood — a door, a shutter, a plank wall — is
      // boards standing on end, not blocks.
      '  float fbRed = (diffuseColor.r - diffuseColor.g) / (diffuseColor.r + 0.0001);',
      '  bool  fbBrick = !fbRoof && fbRed > 0.35;',
      '  bool  fbWood  = !fbRoof && !fbBrick && fbRed > 0.18;',
      '  float fbC = fbRoof ? ' + f(o.tileCourse) + ' : fbBrick ? ' + f(o.brickCourse) + ' : ' + f(o.wallCourse) + ';',
      '  float fbR = fbRoof ? ' + f(o.tileRun) + ' : fbBrick ? ' + f(o.brickRun) + ' : ' + f(o.wallRun) + ';',
      // Which course, and which unit along it. Courses run in Y for both — a
      // roof's tiles are parallel to the eaves and a wall's blocks to the
      // ground — and the run is taken along whichever horizontal axis the face
      // points least, so a wall's blocks run ALONG the wall and not into it.
      '  vec3  fbN = abs(normalize(vFabN));',
      '  float fbAlong = (fbN.x > fbN.z) ? vFabP.z : vFabP.x;',
      '  float fbCourse = floor(vFabP.y / fbC);',
      '  float fbUnit = floor(fbAlong / fbR + mod(fbCourse, 2.0) * 0.5);',  // stagger alternate courses
      // The lip where one tile overlaps the next, and the mortar between stones.
      '  float fbInto = fract(vFabP.y / fbC);',
      '  float fbLine = 1.0 - smoothstep(0.0, ' + (+o.lineW).toFixed(3) + ', fbInto);',
      // the head joints between one brick or block and the next along the course
      '  if (!fbRoof) {',
      '    float fbAl = fract(fbAlong / fbR + mod(fbCourse, 2.0) * 0.5);',
      '    fbLine = max(fbLine, 1.0 - smoothstep(0.0, ' + (+o.lineW).toFixed(3) + ' * fbC / fbR, fbAl));',
      '  }',
      // a board is one tall unit, its joint the only line
      '  float fbPx = max(fwidth(vFabP.y / fbC), fwidth(fbAlong / fbR));',
      '  if (fbWood) {',
      '    float fbB = fbAlong / ' + f(o.boardRun) + ';',
      '    fbUnit = floor(fbB); fbCourse = 0.0;',
      '    fbLine = 1.0 - smoothstep(0.0, 0.07, fract(fbB));',
      '    fbPx = fwidth(fbB);',
      '  }',
      // Each tile, block or board gets its own tone.
      '  float fbH = fbHash(vec3(fbUnit, fbCourse, fbRoof ? 3.0 : fbWood ? 11.0 : 7.0));',
      '  float fbTone = 1.0 + (fbH - 0.5) * 2.0 * ' + (+o.mottle).toFixed(3) + ';',
      '  fbTone *= 1.0 - fbLine * ' + (+o.line).toFixed(3) + ';',
      // …faded out where a course is smaller than a pixel. By the pixel's own
      // footprint (`fwidth`), so a wall seen edge-on fades where it would
      // shimmer, not at a range picked for a wall seen square; and by range
      // as before, so a far village is the flat colour it always was.
      '  float fbFade = 1.0 - smoothstep(fbBrick ? ' + (+o.brickNear).toFixed(2) + ' : ' + (+o.fadeNear).toFixed(2) + ', fbBrick ? ' + (+o.brickFar).toFixed(2) + ' : ' + (+o.fadeFar).toFixed(2) + ', length(vFabV));',
      '  fbFade *= 1.0 - smoothstep(0.18, 0.38, fbPx);',
      // (round 113) THE SURFACE ITSELF, baked in Blender (tools/blender/
      // fabric_bake.py -> assets/fabric_tex.js): what a wall or a roof is made
      // of is read off its own colour as before — brick red, render pale,
      // stone grey; roof slate blue-grey, straw yellow, clay the rest — and
      // its tile then says only what it is made OF: the house's own colour
      // times the tile's light and dark (0.5 is the house), the joint's colour
      // mixed in, the cavity darkened. Mipmapped, so it does not boil at range
      // and needs none of the fade the arithmetic does. Wood keeps its
      // arithmetic boards unless the pack carries planks (FAB_PLANKS: round
      // 113's second batch — six boards on end a tile, grain, knots, nails).
      '#ifdef FAB_TEX',
      // the layer and the coordinates first, and ONE sample outside any
      // branch: a mipmapped lookup needs its neighbours in the same flow
      '  float fbLum = (diffuseColor.r + diffuseColor.g + diffuseColor.b) / 3.0;',
      '  float fbL; vec2 fbUv;',
      '  {',
      '    if (fbRoof) {',
      '      bool fbStraw = diffuseColor.r > diffuseColor.b * 1.45 && diffuseColor.g > diffuseColor.b * 1.25 && fbRed < 0.35;',
      '      fbL = fbStraw ? 5.0 : (diffuseColor.b >= diffuseColor.r * 0.92 ? 3.0 : 4.0);',
      '      fbUv = fbL == 3.0 ? vec2(fbAlong / ' + f(6 * o.tileRun) + ', vFabP.y / ' + f(6 * o.tileCourse) + ')',
      '           : fbL == 4.0 ? vec2(fbAlong / ' + f(6 * o.tileRun) + ', vFabP.y / ' + f(8 * o.tileCourse) + ')',
      '           : vec2(fbAlong, vFabP.y) / ' + f(3 * o.wallCourse) + ';',
      '    } else if (fbWood) {',
      '      fbL = 6.0; fbUv = vec2(fbAlong / ' + f(6 * o.boardRun) + ', vFabP.y / ' + f(12 * o.boardRun) + ');',
      '    } else if (fbBrick) {',
      '      fbL = 0.0; fbUv = vec2(fbAlong / ' + f(4 * o.brickRun) + ', vFabP.y / ' + f(12 * o.brickCourse) + ');',
      '    } else if (fbLum > 0.5) {',
      '      fbL = 2.0; fbUv = vec2(fbAlong, vFabP.y) / ' + f(3 * o.wallCourse) + ';',
      '    } else {',
      '      fbL = 1.0; fbUv = vec2(fbAlong / ' + f(2 * o.wallRun) + ', vFabP.y / ' + f(3 * o.wallCourse) + ');',
      '    }',
      '  }',
      '  vec3 fbT = texture(uFabTex, vec3(fbUv, fbL)).rgb;',
      '#ifdef FAB_PLANKS',
      '  if (uFabTexOn > 0.5) {',
      '#else',
      '  if (uFabTexOn > 0.5 && !fbWood) {',
      '#endif',
      '    vec3 fbJ = fbL < 1.5 ? vec3(0.30, 0.285, 0.26) : diffuseColor.rgb * 0.5;',
      '    diffuseColor.rgb *= (0.62 + fbT.r * 0.76) * (1.0 - fbT.b * 0.4);',
      '    diffuseColor.rgb = mix(diffuseColor.rgb, fbJ, fbT.g * 0.8);',
      '  } else',
      '#endif',
      '  diffuseColor.rgb *= mix(1.0, fbTone, fbFade);',
      // …and a front is not one even colour: rain streaks, soot, a repair, a
      // patch the sun has bleached — a slow continuous variation over a few
      // metres, the same at every range, with no seam at a piece's edge
      '  float fbW = fbNoise(vFabP * ' + (1 / +o.weather).toFixed(4) + ') * 0.65 + fbNoise(vFabP * ' + (2.7 / +o.weather).toFixed(4) + ' + 13.0) * 0.35;',
      '  diffuseColor.rgb *= 1.0 + (fbW - 0.5) * ' + (+o.weatherAmp).toFixed(3) + ';',
      '}',
    ].join('\n');
  }

  /** (round 113) the pack has a plank layer where the shader expects it */
  function planks() { var T = root.FABRIC_TEX; return !!(T && T.layers && T.layers[6] === 'planks'); }

  /** Patch the structures material. Safe to call twice. */
  F.material = function (m, opts) {
    if (!m || m._fabric) return false;
    var o = Object.assign({}, F.defaults, opts || {});
    var prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
    m.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, '#include <common>',
        '#include <common>\nvarying vec3 vFabP;\nvarying vec3 vFabN;\nvarying vec3 vFabV;');
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>',
        '#include <begin_vertex>\nvFabP = position;\nvFabN = normal;');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>',
        '#include <project_vertex>\nvFabV = -mvPosition.xyz;');
      // (round 113) the Blender tiles, where WebGL2 can sample an array
      var tex = !!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2 && F.texture());
      if (tex) { sh.uniforms.uFabTex = F.texU; sh.uniforms.uFabTexOn = F.texOn; }
      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>',
        '#include <common>\nvarying vec3 vFabP;\nvarying vec3 vFabN;\nvarying vec3 vFabV;\n'
        + (tex ? '#define FAB_TEX\nuniform highp sampler2DArray uFabTex;\nuniform float uFabTexOn;\n' : '')
        + (tex && planks() ? '#define FAB_PLANKS\n' : '') + glsl(o));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>',
        '#include <color_fragment>\n' + chunk(o));
      // the sky's share of a wall in shade (see `sky` above); Lambert only —
      // a PBR fallback has no such line and keeps its own lighting
      if (sh.fragmentShader.indexOf('#include <lightmap_fragment>') >= 0 && /indirectDiffuse \+= vIndirectFront/.test(sh.fragmentShader)) {
        sh.uniforms.uFabSky = F.sky;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uFabSky;')
          .replace('#include <lightmap_fragment>', '#include <lightmap_fragment>\n\treflectedLight.indirectDiffuse *= uFabSky;');
      }
      if (!ok) F.failed = (F.failed || 0) + 1;
    };
    var key = '|fab7:' + [o.tileCourse, o.wallCourse, o.brickCourse, o.boardRun, o.weather, o.mottle, o.line].join(',') + (window.FABRIC_TEX ? '|tex' : '') + (planks() ? '|planks' : '');
    m.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + key;
    };
    // `fwidth` (the pattern's own anti-aliasing): built in under WebGL2, an
    // extension under WebGL1
    m.extensions = Object.assign({}, m.extensions || {}, { derivatives: true });
    m._fabric = true;
    m.needsUpdate = true;
    return true;
  };

  /** (round 113) The Blender tiles as one texture array: a grey placeholder at
   *  once (so the sampler is never unbound), the real six once the PNGs have
   *  decoded. `Fabric.texOn.value = 0` draws the arithmetic again, live. */
  F.texU = { value: null };
  F.texOn = { value: 0 };
  F.texture = function () {
    var T = root.FABRIC_TEX;
    if (!T || !T.png || !T.png.length || typeof THREE === 'undefined' || !THREE.DataTexture2DArray) return null;
    if (F.texU.value) return F.texU.value;
    var n = T.png.length, ph = new Uint8Array(4 * n);
    for (var i = 0; i < n; i++) { ph[i * 4] = 128; ph[i * 4 + 1] = 0; ph[i * 4 + 2] = 0; ph[i * 4 + 3] = 255; }
    var t0 = new THREE.DataTexture2DArray(ph, 1, 1, n);
    t0.needsUpdate = true;
    F.texU.value = t0;
    var size = T.size, data = new Uint8Array(size * size * 4 * n), left = n;
    T.png.forEach(function (b64, k) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = size; c.height = size;
        var cx = c.getContext('2d'); cx.drawImage(img, 0, 0, size, size);
        data.set(cx.getImageData(0, 0, size, size).data, k * size * size * 4);
        if (--left) return;
        var t = new THREE.DataTexture2DArray(data, size, size, n);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true; t.anisotropy = 4;
        t.needsUpdate = true;
        F.texU.value = t; F.texOn.value = F.texWanted === false ? 0 : 1;
      };
      img.src = 'data:image/png;base64,' + b64;
    });
    return t0;
  };

  root.Fabric = F;
})(window);
