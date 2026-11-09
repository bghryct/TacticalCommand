/* ===========================================================================
 * VFX — a pooled, instanced particle engine for smoke, fire and explosions
 * ---------------------------------------------------------------------------
 * The game's original `Effects` class allocates ONE THREE.Mesh WITH ITS OWN
 * MATERIAL per particle. A single HE burst is 45 of them; a burning Tiger is
 * ~20 more every second; a hunter-killer in flight adds ninety a second. Every
 * one of those is a separate transparent draw call that the renderer then has
 * to depth-sort. That is the framerate, and it is why this file exists.
 *
 * Here, EVERY particle in the world is drawn in THREE draw calls:
 *
 *   · additive   — fire, sparks, muzzle flashes, energy weapons
 *   · alpha      — smoke, dust, debris, blood
 *   · flipbook   — explosion fireballs, on an animated 4x4 sprite sheet
 *
 * How:
 *   1. ONE geometry (a unit quad) and ONE material per layer. Everything else
 *      is a per-instance attribute, so 3,000 particles are 3 batches.
 *   2. STRUCT-OF-ARRAYS simulation over preallocated Float32Arrays with a free
 *      list and swap-remove. After boot the engine never allocates — no GC
 *      pauses in the middle of a firefight.
 *   3. BILLBOARDING IN THE VERTEX SHADER, in view space: the CPU writes a
 *      position, a size and a roll; the GPU orients the quad. The old code did
 *      `quaternion.copy(camera.quaternion)` per particle per frame and paid for
 *      a matrix recompose each time.
 *   4. A HARD CAP with priority eviction. Past the cap, a new important
 *      particle (an explosion core) replaces the oldest unimportant one (a
 *      drifting smoke wisp) instead of being dropped or, worse, admitted.
 *   5. PROCEDURAL SHEETS drawn on a canvas at boot — no downloads, so file://
 *      still works, which is the rule the sky and terrain textures already
 *      follow.
 *
 * Contract: optional. If this file is missing, `Effects` keeps its original
 * per-mesh path and the game looks and behaves exactly as it did.
 * ======================================================================== */
(function () {
  'use strict';
  // COSMETIC RANDOMNESS, ITS OWN STREAM (round 95). Drawing on `Math.random`
  // moved the simulation's rolls — which every probe seeds — by how much
  // smoke and sparks were drawn — and how much of that was on screen, so a seeded battle depended on the camera. Mulberry32.
  var _cs = 0x1b873593;
  function crand() {
    _cs = (_cs + 0x6D2B79F5) | 0;
    var t = Math.imul(_cs ^ (_cs >>> 15), 1 | _cs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }


  var VERSION = 1;
  var THREE = null;
  var installed = false;

  // ---- particle behaviours -----------------------------------------------
  var K = {
    SMOKE:  0,   // rises, swells, thins
    FIRE:   1,   // rises fast, shrinks, cools through the flame ramp
    SPARK:  2,   // ballistic, stretched along its own velocity
    DEBRIS: 3,   // ballistic, tumbles, hits the ground and stops
    BOOM:   4,   // flipbook fireball
    FLASH:  5,   // one-frame blast light, very large, very short
    DUST:   6,   // ground-hugging, expands fast, hangs
    TRAIL:  7,   // barely moves — marks a sightline
    GIB:    8,   // ballistic body part, lands as a stain
    EMBER:  9,   // slow drifting hot mote, lives long
    FBALL: 10,   // flipbook: a fuel / ammunition fireball rolling into black smoke
    MFLASH: 11,  // a muzzle flash, laid along the bore as the camera sees it
    STREAK: 12,  // a hot round in flight (a ricochet): laid along its velocity ON SCREEN
    LICK: 13,    // (round 114) flipbook: one tongue of simulated flame
  };

  // Which layer each behaviour draws in.
  var LAYER = {};
  LAYER[K.SMOKE] = 1; LAYER[K.FIRE] = 0; LAYER[K.SPARK] = 0; LAYER[K.DEBRIS] = 1;
  LAYER[K.BOOM] = 2; LAYER[K.FLASH] = 0; LAYER[K.DUST] = 1; LAYER[K.TRAIL] = 1;
  LAYER[K.GIB] = 1; LAYER[K.EMBER] = 0; LAYER[K.FBALL] = 3; LAYER[K.MFLASH] = 0;
  LAYER[K.STREAK] = 0; LAYER[K.LICK] = 5;

  // HOW HARD THE WIND HAS HOLD OF IT.
  //
  // Nothing in this system knew the wind existed. The volumetric clouds
  // drifted (the RTT cloud carries `drift`), but every puff, wisp and dust
  // sheet spawned out of them stood exactly where it was born, so a burst on a
  // gusty day left a column standing straight up while the cloud it belonged
  // to walked away downwind.
  //
  // The number is a RELAXATION RATE, not a force: a particle's horizontal
  // velocity is pulled toward the wind's at this many e-folds a second, so
  // smoke takes about a second and a half to be moving with the air and dust —
  // heavier, and already being dragged down — takes longer and never quite
  // gets there. Ballistic things (debris, gibs, sparks) are on their own
  // trajectory and the wind is not going to move them.
  var WIND = {};
  WIND[K.SMOKE] = 0.85; WIND[K.DUST] = 0.5; WIND[K.TRAIL] = 0.7;
  WIND[K.EMBER] = 0.6;  WIND[K.FIRE] = 0.3; WIND[K.LICK] = 0.25;

  // Eviction priority — higher survives. A blast core outranks a smoke wisp.
  var PRIO = {};
  PRIO[K.SMOKE] = 1; PRIO[K.FIRE] = 3; PRIO[K.SPARK] = 2; PRIO[K.DEBRIS] = 2;
  PRIO[K.STREAK] = 3; PRIO[K.LICK] = 3;
  PRIO[K.BOOM] = 6; PRIO[K.FLASH] = 6; PRIO[K.DUST] = 2; PRIO[K.TRAIL] = 1;
  PRIO[K.GIB] = 4; PRIO[K.EMBER] = 2; PRIO[K.FBALL] = 6; PRIO[K.MFLASH] = 5;

  // ---- sprite sheets ------------------------------------------------------
  // Two 4x4 atlases (a general one and the explosion flipbook) drawn once.
  var SHEET = 4, CELL = 128;

  // General atlas cells, by index.
  var S = {
    PUFF: 0,     // soft round smoke puff
    WISP: 1,     // torn, wispy smoke
    GLOW: 2,     // hot additive core
    FLAME: 3,    // a flame tongue
    SPARK: 4,    // a stretched ember streak
    CHUNK: 5,    // an irregular dark debris chunk
    RING: 6,     // a thin shock ring
    STAR: 7,     // a four-point blast flash
    SOOT: 8,     // dense black smoke
    DUST: 9,     // pale brown dust
    DROP: 10,    // blood droplet
    CINDER: 11,  // small glowing cinder
    // baked sheet only (assets/vfx/sheets.js) — the canvas sheet leaves these blank
    MPLUME: 12,  // muzzle flash, side-on: a rifle or a machine gun
    MPLUME2: 13, // …a second take, so a burst is not one picture repeated
    MBRAKE: 14,  // a gun with a muzzle brake: the plume and the two side jets
    MFRONT: 15,  // a muzzle flash seen down the bore
  };

  function rngFrom(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function radial(ctx, cx, cy, r, stops) {
    var g = ctx.createRadialGradient(cx, cy, Math.max(0.5, r * 0.04), cx, cy, r);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283); ctx.fill();
  }

  /** A turbulent cloud: many overlapping soft blobs inside a disc. This is the
   *  difference between "a fuzzy ball" and "smoke". */
  function billow(ctx, cx, cy, r, n, R, colFn, softness) {
    for (var i = 0; i < n; i++) {
      var a = R() * 6.283, d = Math.pow(R(), 0.55) * r * 0.72;
      var bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d;
      var br = r * (0.20 + R() * 0.34);
      var f = 1 - d / r;
      radial(ctx, bx, by, br, colFn(f, R, i));
      void softness;
    }
  }

  function drawGeneral(ctx, k, R) {
    var c = CELL / 2, r = CELL / 2 - 4;
    if (k === S.PUFF) {
      billow(ctx, c, c, r, 22, R, function (f) {
        var v = Math.round(150 + f * 70);
        return [[0, 'rgba(' + v + ',' + v + ',' + (v - 8) + ',0.34)'],
                [0.55, 'rgba(' + v + ',' + v + ',' + (v - 8) + ',0.15)'],
                [1, 'rgba(' + v + ',' + v + ',' + v + ',0)']];
      });
    } else if (k === S.WISP) {
      // Torn edges: fewer, bigger, more offset blobs, and a bite taken out.
      billow(ctx, c, c, r, 12, R, function (f) {
        var v = Math.round(140 + f * 80);
        return [[0, 'rgba(' + v + ',' + v + ',' + v + ',0.30)'], [1, 'rgba(' + v + ',' + v + ',' + v + ',0)']];
      });
      ctx.globalCompositeOperation = 'destination-out';
      for (var i = 0; i < 5; i++) radial(ctx, c + (R() - 0.5) * r * 1.5, c + (R() - 0.5) * r * 1.5, r * (0.2 + R() * 0.3),
        [[0, 'rgba(0,0,0,0.85)'], [1, 'rgba(0,0,0,0)']]);
      ctx.globalCompositeOperation = 'source-over';
    } else if (k === S.GLOW) {
      radial(ctx, c, c, r, [[0, 'rgba(255,252,238,1)'], [0.22, 'rgba(255,214,132,0.92)'],
        [0.52, 'rgba(255,132,40,0.42)'], [1, 'rgba(120,30,0,0)']]);
    } else if (k === S.FLAME) {
      // A tongue: hot narrow base widening and tearing into the tip.
      var grd = ctx.createLinearGradient(0, CELL, 0, 0);
      grd.addColorStop(0, 'rgba(255,244,208,0.95)');
      grd.addColorStop(0.32, 'rgba(255,182,64,0.8)');
      grd.addColorStop(0.7, 'rgba(226,86,18,0.42)');
      grd.addColorStop(1, 'rgba(120,28,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(c - r * 0.42, CELL - 6);
      ctx.bezierCurveTo(c - r * 0.62, c, c - r * 0.20, 18, c, 4);
      ctx.bezierCurveTo(c + r * 0.24, 20, c + r * 0.60, c, c + r * 0.42, CELL - 6);
      ctx.closePath(); ctx.fill();
      for (var t = 0; t < 6; t++) {   // licks breaking off the tip
        radial(ctx, c + (R() - 0.5) * r * 0.7, 10 + R() * c * 0.7, r * (0.08 + R() * 0.13),
          [[0, 'rgba(255,190,80,0.55)'], [1, 'rgba(255,110,20,0)']]);
      }
    } else if (k === S.SPARK) {
      var lg = ctx.createLinearGradient(c, CELL, c, 0);
      lg.addColorStop(0, 'rgba(255,120,20,0)');
      lg.addColorStop(0.55, 'rgba(255,196,96,0.75)');
      lg.addColorStop(1, 'rgba(255,250,225,1)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(c - 3.5, CELL - 2); ctx.lineTo(c, 4); ctx.lineTo(c + 3.5, CELL - 2);
      ctx.closePath(); ctx.fill();
      radial(ctx, c, 12, 10, [[0, 'rgba(255,255,240,1)'], [1, 'rgba(255,160,40,0)']]);
    } else if (k === S.CHUNK) {
      ctx.fillStyle = 'rgba(46,40,32,1)';
      ctx.beginPath();
      var pts = 7;
      for (var p = 0; p < pts; p++) {
        var pa = p / pts * 6.283, pr = r * (0.42 + R() * 0.46);
        var x = c + Math.cos(pa) * pr, y = c + Math.sin(pa) * pr;
        if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(96,86,68,0.5)';   // a lit facet so it isn't a silhouette
      ctx.beginPath(); ctx.arc(c - r * 0.25, c - r * 0.25, r * 0.34, 0, 6.283); ctx.fill();
    } else if (k === S.RING) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(c, c, r * 0.82, 0, 6.283); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 13; ctx.beginPath(); ctx.arc(c, c, r * 0.82, 0, 6.283); ctx.stroke();
    } else if (k === S.STAR) {
      radial(ctx, c, c, r * 0.5, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,220,150,0)']]);
      ctx.save(); ctx.translate(c, c);
      for (var b = 0; b < 4; b++) {
        ctx.rotate(Math.PI / 2);
        var sg = ctx.createLinearGradient(0, 0, 0, -r);
        sg.addColorStop(0, 'rgba(255,246,214,0.95)'); sg.addColorStop(1, 'rgba(255,180,80,0)');
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(0, -r); ctx.lineTo(5, 0); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    } else if (k === S.SOOT) {
      billow(ctx, c, c, r, 20, R, function (f) {
        var v = Math.round(22 + f * 34);
        return [[0, 'rgba(' + v + ',' + (v - 2) + ',' + (v - 4) + ',0.44)'], [1, 'rgba(' + v + ',' + v + ',' + v + ',0)']];
      });
    } else if (k === S.DUST) {
      billow(ctx, c, c, r, 24, R, function (f) {
        var rr = Math.round(150 + f * 46), gg = Math.round(134 + f * 42), bb = Math.round(100 + f * 34);
        return [[0, 'rgba(' + rr + ',' + gg + ',' + bb + ',0.30)'], [1, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)']];
      });
    } else if (k === S.DROP) {
      radial(ctx, c, c, r * 0.62, [[0, 'rgba(128,20,14,0.98)'], [0.7, 'rgba(96,14,10,0.8)'], [1, 'rgba(70,10,8,0)']]);
    } else if (k === S.CINDER) {
      radial(ctx, c, c, r * 0.30, [[0, 'rgba(255,236,190,1)'], [0.5, 'rgba(255,150,50,0.8)'], [1, 'rgba(180,50,0,0)']]);
    }
  }

  /** The explosion flipbook: 16 frames of one HE burst, from white-hot flash
   *  through a rolling fireball to the smoke that is left. Read left-to-right,
   *  top-to-bottom. Drawn additively by the renderer, so the black is free. */
  function drawBoomFrame(ctx, f, R) {
    var c = CELL / 2, maxR = CELL / 2 - 3;
    var t = f / 15;                       // 0..1 through the burst
    var grow = Math.pow(t, 0.42);         // fast open, slow settle
    var rad = maxR * (0.16 + grow * 0.84);
    var heat = Math.max(0, 1 - t * 1.5);  // the fire is gone by ~2/3
    var soot = Math.min(1, Math.max(0, (t - 0.28) / 0.72));
    var fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;

    // Rolling smoke shell first, so fire sits inside it.
    if (soot > 0) {
      billow(ctx, c, c, rad, 16, R, function (ff) {
        var v = Math.round((28 + ff * 40) * (0.5 + heat * 0.9));
        var a = 0.30 * soot * fade * (0.4 + ff * 0.8);
        return [[0, 'rgba(' + (v + 12) + ',' + v + ',' + (v - 6) + ',' + a.toFixed(3) + ')'],
                [1, 'rgba(' + v + ',' + v + ',' + v + ',0)']];
      });
    }
    // The fireball: hot billows, brightest and tightest at the centre.
    if (heat > 0) {
      billow(ctx, c, c, rad * 0.86, 14, R, function (ff) {
        var h = heat * (0.35 + ff * 1.0);
        var rr = Math.round(255 * Math.min(1, h * 1.6));
        var gg = Math.round(200 * Math.min(1, h * 1.15));
        var bb = Math.round(90 * Math.min(1, h * 0.7));
        var a = (0.5 * h * fade).toFixed(3);
        return [[0, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + a + ')'],
                [0.6, 'rgba(' + rr + ',' + Math.round(gg * 0.6) + ',20,' + (a * 0.5).toFixed(3) + ')'],
                [1, 'rgba(120,30,0,0)']];
      });
    }
    // The initial flash, only on the first two frames.
    if (f < 2) {
      radial(ctx, c, c, maxR * (0.5 + f * 0.35),
        [[0, 'rgba(255,255,250,' + (1 - f * 0.45) + ')'], [0.4, 'rgba(255,226,160,0.6)'], [1, 'rgba(255,150,40,0)']]);
    }
  }

  /** THE BAKED SHEETS (tools/blender/vfx_bake.py -> tools/pack_vfx.py ->
   *  assets/vfx/sheets.js). Volumes rendered in Cycles: a ground burst that
   *  throws jets of earth and climbs into a cauliflower column, a fuel
   *  fireball rolling into black smoke, lit smoke puffs, side-on muzzle
   *  plumes. Each texel is ENCODED — R lit smoke grey (sRGB), G coverage,
   *  B heat (gamma 2) — and the shader rebuilds colour from it, so one
   *  sprite can be white-hot fire inside a black shell and the same smoke can
   *  be tinted brown over a field or black off a burning tank. Without the
   *  file the canvas sheets below are drawn exactly as before. */
  var BAKED = null;
  function bakedTex(src) {
    var img = new Image();
    var tex = new THREE.Texture(img);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    // a data: URL decodes off the main thread; until it has, the sheet reads as
    // (0,0,0) — no coverage, no heat — and nothing is drawn rather than garbage
    img.onload = function () { tex.needsUpdate = true; };
    img.src = src;
    return tex;
  }

  var _sheets = null;
  function sheets() {
    if (_sheets) return _sheets;
    var bk = typeof window !== 'undefined' ? window.VFX_SHEETS : null;
    if (bk && bk.general && bk.boom) {
      BAKED = bk;
      _sheets = { enc: true, general: bakedTex(bk.general.src), boom: bakedTex(bk.boom.src),
                  fireball: bk.fireball ? bakedTex(bk.fireball.src) : null,
                  billow: bk.billow ? bakedTex(bk.billow.src) : null, lick: bk.lick ? bakedTex(bk.lick.src) : null };
      return _sheets;
    }
    var mk = function (draw, seed) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = SHEET * CELL;
      var ctx = cv.getContext('2d');
      for (var k = 0; k < SHEET * SHEET; k++) {
        ctx.save();
        ctx.translate((k % SHEET) * CELL, Math.floor(k / SHEET) * CELL);
        ctx.beginPath(); ctx.rect(0, 0, CELL, CELL); ctx.clip();
        draw(ctx, k, rngFrom(seed + k * 7919));
        ctx.restore();
      }
      var tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      return tex;
    };
    _sheets = { enc: false, general: mk(drawGeneral, 9001), boom: mk(drawBoomFrame, 4242), fireball: null };
    return _sheets;
  }

  // =========================================================================
  // THE BATCH — one draw call's worth of billboards
  // =========================================================================
  var VS = [
    'attribute vec3 iPos;',
    'attribute vec4 iCol;',
    'attribute vec3 iSize;',     // w, h, roll
    'attribute vec2 iUv;',       // atlas cell offset (a flipbook: x is the frame, fractional)
    'attribute float iGnd;',     // (round 114) the ground under a flipbook puff
    'uniform vec2 uAtlas;',
    'uniform vec2 uFlip;',       // (frames, on): blend between two frames of a simulated sheet
    'uniform float uMode;',
    'varying float vEr;',        // (round 114) how far age has eaten into the coverage
    'varying vec2 vUvF;',
    'varying vec2 vUvB;',
    'varying float vMix;',
    'varying float vSoft;',
    'varying vec4 vColF;',
    'varying float vDepth;',
    'void main() {',
    '  vColF = iCol;',
    '  vEr = uFlip.y > 0.5 ? iUv.y : (uMode > 1.5 ? 1.0 - iCol.a : 0.0);',
    '  vSoft = 1.0;',
    '  if (uFlip.y > 0.5) {',
    '    float f = floor(iUv.x), G = 1.0 / uAtlas.x, f1 = min(f + 1.0, uFlip.x - 1.0);',
    '    vMix = iUv.x - f;',
    '    vUvF = (uv + vec2(mod(f, G), G - 1.0 - floor(f / G))) * uAtlas;',
    '    vUvB = (uv + vec2(mod(f1, G), G - 1.0 - floor(f1 / G))) * uAtlas;',
    '  } else { vUvF = uv * uAtlas + iUv; vUvB = vUvF; vMix = 0.0; }',
    // View-space billboard: the quad is built in the camera's own plane, so it
    // faces the eye by construction. No per-particle quaternion, no matrix.
    '  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);',
    '  float cr = cos(iSize.z), sr = sin(iSize.z);',
    '  vec2 q = position.xy * iSize.xy;',
    '  vec2 qr = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);',
    '  mv.xy += qr;',
    // SOFT AT THE GROUND: where a puff's quad would cut the ground it thins out
    // first, so smoke and dust settle on the field instead of ending in a line.
    // The world height of this corner is the particle's plus the camera's axes;
    // the varying carries it per pixel for one texture read's worth of nothing.
    '  if (uFlip.y > 0.5 && iGnd > -9000.0) {',
    '    float wy = iPos.y + viewMatrix[0][1] * qr.x + viewMatrix[1][1] * qr.y;',
    '    vSoft = (wy - iGnd) / max(0.02, iSize.x * 0.22);',
    '  } else vSoft = 1.0;',
    '  vDepth = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');

  var FS = [
    'uniform sampler2D uMap;',
    'uniform vec3 uFogColor;',
    'uniform float uFogDensity;',
    'uniform float uAdditive;',
    'uniform vec3 uLight;',
    'uniform float uEnc;',     // 1: a baked, ENCODED sheet (R lit grey, G coverage, B heat)
    'uniform float uMode;',    // 0 light (additive), 1 smoke (alpha), 2 fire-in-smoke (premultiplied)
    'uniform float uHeat;',    // how bright heat 1.0 is, linear — tone mapped after
    'uniform float uGlowOnly;', // 1 while PostFX draws the glow source: fire only, no smoke
    'uniform float uHot;',     // how far up the fire ramp this sheet's hottest texel goes
    'varying float vEr;',
    'uniform vec2 uFlip;',
    'varying vec2 vUvF;',
    'varying vec2 vUvB;',
    'varying float vMix;',
    'varying float vSoft;',
    'varying vec4 vColF;',
    'varying float vDepth;',
    // The fire ramp the sheets were baked with (vfx_bake.py FIRE): deep red,
    // orange, yellow, white. Brightness and colour come from ONE number, as
    // they do for anything incandescent.
    'vec3 fireRamp(float h) {',
    '  vec3 c = mix(vec3(0.25, 0.015, 0.0), vec3(0.85, 0.16, 0.01), smoothstep(0.0, 0.25, h));',
    '  c = mix(c, vec3(1.0, 0.42, 0.06), smoothstep(0.25, 0.5, h));',
    '  c = mix(c, vec3(1.0, 0.74, 0.32), smoothstep(0.5, 0.75, h));',
    '  return mix(c, vec3(1.0, 0.96, 0.86), smoothstep(0.75, 1.0, h));',
    '}',
    'void main() {',
    '  vec4 t = texture2D(uMap, vUvF);',
    '  if (uFlip.y > 0.5) {',
    '    t = mix(t, texture2D(uMap, vUvB), vMix);',
    '    float sf = clamp(vSoft, 0.0, 1.0); t.g *= sf * sf * (3.0 - 2.0 * sf);',
    '  }',
    '  float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth), 0.0, 1.0);',
    '  if (uEnc > 0.5) {',
    // AGE EATS THE THIN PARTS FIRST (round 114). A puff that faded uniformly went
    // from a shape to a paler copy of that shape, which is what a sticker does.
    // Taking a threshold off the coverage keeps the dense knots dense while the
    // edges tear away, for one subtraction.
    '    float gc = t.g;',
    '    if (vEr > 0.002) gc = clamp((gc - vEr) / max(0.06, 1.0 - vEr), 0.0, 1.0);',
    '    float lit = pow(t.r, 2.2), cov = gc * vColF.a, heat = t.b * t.b * uHot;',
    '    vec4 e;',
    '    if (uMode < 0.5) {',
    // light: the particle colour is the flame's, and the hottest part goes white
    '      if (heat * vColF.a < 0.003) discard;',
    // …toward a WARM white, and only at the very top of the ramp: a neutral
    // white under the grade came out steel-blue in a muzzle plume's core.
    '      vec3 hot = mix(vColF.rgb, vec3(1.0, 0.9, 0.72), smoothstep(0.7, 1.0, heat) * 0.5);',
    '      e = vec4(hot * heat * uHeat * (1.0 - fog), vColF.a);',
    '    } else if (uMode < 1.5) {',
    '      if (cov < 0.004) discard;',
    '      e = vec4(mix(lit * vColF.rgb * uLight, uFogColor, fog), cov);',
    '    } else {',
    // premultiplied: the smoke covers what is behind it, the fire adds on top
    '      if (cov < 0.003 && heat < 0.003) discard;',
    '      vec3 smoke = mix(lit * vColF.rgb * uLight, uFogColor, fog);',
    '      vec3 fire = fireRamp(heat) * heat * uHeat * vColF.a * (1.0 - fog);',
    // In the glow pass only the fire: the smoke round it is lit grey, and a
    // bloom on a dust cloud reads as a bug (see PostFX.adoptVfx).
    '      e = uGlowOnly > 0.5 ? vec4(fire, 0.0) : vec4(smoke * cov + fire, cov);',
    '    }',
    '    gl_FragColor = e;',
    '    #include <tonemapping_fragment>',
    '    #include <encodings_fragment>',
    '    return;',
    '  }',
    '  vec4 c = vec4(t.rgb * vColF.rgb, t.a * vColF.a);',
    '  if (c.a < 0.004) discard;',
    // SMOKE IS LIT; FIRE IS LIGHT. Smoke, dust, debris and blood take the
    // scene's light — at night a grey smoke screen kept its daytime grey and
    // stood in the dark like a lamp. Additive sprites (fire, flash, sparks,
    // tracer) and the fireball flipbook are their own light and stay as bright.
    '  if (uAdditive < 0.5) c.rgb *= uLight;',
    '  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);',
    '  f = clamp(f, 0.0, 1.0);',
    // Additive sprites must fade toward BLACK, not toward the fog colour —
    // adding the fog colour would make distant smoke GLOW through the haze.
    '  c.rgb = uAdditive > 0.5 ? c.rgb * (1.0 - f) : mix(c.rgb, uFogColor, f);',
    '  gl_FragColor = c;',
    // EVERY PARTICLE IN THE GAME BYPASSED THE TONE MAP AND THE OUTPUT
    // ENCODING. The renderer is ACES filmic into sRGB, and three.js only
    // applies either through these two chunks — which its own ShaderLib
    // materials include and a hand-written ShaderMaterial does not. So the
    // terrain, the models and the sky went through the curve and the smoke,
    // the dust, the muzzle flash and the fireballs went round it: particles
    // sat in a different colour space from the frame they were drawn into,
    // which is why explosions read as stickers rather than as light. Both
    // chunks operate on `gl_FragColor` in place, so they must come after it.
    '#include <tonemapping_fragment>',
    '#include <encodings_fragment>',
    '}',
  ].join('\n');

  /** `o.enc` — the sheet is a baked, encoded one; `o.premul` — fire inside
   *  smoke, blended ONE / ONE_MINUS_SRC_ALPHA; `o.grid` — cells per side;
   *  `o.heat` — how bright heat 1.0 is. */
  function Batch(scene, tex, additive, cap, o) {
    o = o || {};
    var grid = o.grid || SHEET, premul = !!o.premul;
    this.grid = grid;
    this.premul = premul;
    this.glow = premul;          // its fire is light: the glow pass adopts it (assets/postfx.js)
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.gnd = new Float32Array(cap).fill(-1e4);
    this.frames = o.frames || 0;
    this.additive = additive;

    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(this.size, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.InstancedBufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.aGnd = new THREE.InstancedBufferAttribute(this.gnd, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iGnd', this.aGnd);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iSize', this.aSize);
    g.setAttribute('iUv', this.aUv);
    g.instanceCount = 0;
    // Particles are everywhere and cheap to draw; culling the whole batch by a
    // bounding sphere that would have to be recomputed every frame is a worse
    // trade than always drawing it.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uAtlas: { value: new THREE.Vector2(1 / grid, 1 / grid) },
        uFlip: { value: new THREE.Vector2(o.frames || 0, o.frames ? 1 : 0) },
        uEnc: { value: o.enc ? 1 : 0 },
        uMode: { value: premul ? 2 : additive ? 0 : 1 },
        uHeat: { value: o.heat || 1 },
        uGlowOnly: { value: 0 },
        uHot: { value: o.hot || 1 },
        uFogColor: { value: new THREE.Color(0xa9c6dd) },
        uFogDensity: { value: 0.002 },
        uAdditive: { value: additive ? 1 : 0 },
        uLight: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: premul ? THREE.CustomBlending : additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    if (premul) {
      this.mat.blendSrc = THREE.OneFactor; this.mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      this.mat.blendSrcAlpha = THREE.OneFactor; this.mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = premul ? 11 : additive ? 12 : 10;
    this.geo = g;
    scene.add(this.mesh);
  }
  Batch.prototype.flush = function (n) {
    this.n = n;
    this.geo.instanceCount = n;
    if (n === 0) return;
    this.aPos.updateRange.count = n * 3; this.aPos.needsUpdate = true;
    this.aCol.updateRange.count = n * 4; this.aCol.needsUpdate = true;
    this.aSize.updateRange.count = n * 3; this.aSize.needsUpdate = true;
    this.aUv.updateRange.count = n * 2; this.aUv.needsUpdate = true;
    if (this.frames) { this.aGnd.updateRange.count = n; this.aGnd.needsUpdate = true; }
  };
  Batch.prototype.dispose = function () {
    this.mesh.parent && this.mesh.parent.remove(this.mesh);
    this.geo.dispose(); this.mat.dispose();
  };

  // =========================================================================
  // THE SYSTEM
  // =========================================================================
  function System(scene, opts) {
    opts = opts || {};
    this.scene = scene;
    this.cap = opts.cap || 3200;
    this.quality = 1;            // global spawn multiplier, driven by frame time
    this.terrain = null;         // set by the game, for ground collision
    this.windX = 0; this.windZ = 0;   // set by the game each frame; see WIND
    // TRUE SCALE (round 105): what the AUTHORED effects below draw at. They
    // were tuned against a diorama world drawn 3.3 times life, so a 75 mm
    // burst threw a fireball twenty metres across beside a life-size Sherman.
    // `K` scales each one about the point it was called at — every offset,
    // size, growth, throw and fall — so it is the same picture, as long, at
    // life size. Raw `spawn` (a smoke screen drawn at its simulated radius)
    // and the air (`windX`) are not scaled. 1 = as authored.
    this.K = 1;
    this._fxD = 0; this._ox = 0; this._oy = 0; this._oz = 0;
    var C = this.cap;

    // -- struct of arrays; index i is one particle, forever, until it dies ---
    this.px = new Float32Array(C); this.py = new Float32Array(C); this.pz = new Float32Array(C);
    this.vx = new Float32Array(C); this.vy = new Float32Array(C); this.vz = new Float32Array(C);
    this.sz = new Float32Array(C); this.szv = new Float32Array(C);   // size and its growth rate
    this.rot = new Float32Array(C); this.rotv = new Float32Array(C);
    this.life = new Float32Array(C); this.maxLife = new Float32Array(C);
    this.cr = new Float32Array(C); this.cg = new Float32Array(C); this.cb = new Float32Array(C);
    this.alpha = new Float32Array(C);
    this.kind = new Uint8Array(C);
    this.cell = new Uint8Array(C);      // atlas cell (or flipbook start frame)
    this.stretch = new Float32Array(C); // height/width ratio for streaks
    this.drag = new Float32Array(C);
    this.grav = new Float32Array(C);
    this.dirx = new Float32Array(C); this.dirz = new Float32Array(C);   // a muzzle flash's bore
    this.flip = new Uint8Array(C);
    this.fin = new Float32Array(C); this.gnd = new Float32Array(C);      // (round 114) drawn from the simulated smoke sheet; the ground under it
    this.n = 0;                          // live count; [0, n) is live, compacted

    var sh = sheets(), bk = BAKED;
    this.enc = sh.enc;
    this.batches = [
      new Batch(scene, sh.general, true, Math.ceil(C * 0.6), { enc: sh.enc, heat: bk ? bk.general.heat : 1 }),   // 0 additive
      new Batch(scene, sh.general, false, C, { enc: sh.enc }),                                                   // 1 alpha
      new Batch(scene, sh.boom, !sh.enc, 256, { enc: sh.enc, premul: sh.enc,                                     // 2 flipbook: the ground burst
        grid: bk ? bk.boom.grid : SHEET, heat: bk ? bk.boom.heat : 1 }),
    ];
    // (round 114) THE FLUID SIMS (tools/blender/vfx_sim.py). Slots 4 and 5 whether
    // or not there is a sheet for them: `update` asks `b4`, `b5` for what it can use.
    this.lickFrames = 0; this.billowFrames = 0;
    this.batches[3] = this.batches[3] || null;
    if (sh.billow) {
      this.batches[4] = new Batch(scene, sh.billow, false, 1400, { enc: true, grid: bk.billow.grid, frames: bk.billow.frames });
      this.billowFrames = bk.billow.frames;
    }
    if (sh.lick) {
      this.batches[5] = new Batch(scene, sh.lick, false, 256, { enc: true, premul: true, grid: bk.lick.grid, heat: Math.min(1.6, bk.lick.heat), hot: 0.55, frames: bk.lick.frames });
      this.lickFrames = bk.lick.frames;
    }
    this.boomFrames = bk ? bk.boom.frames : 16;
    this.boomGround = bk ? bk.boom.ground : 0.5;      // where the ground line sits in a cell (from the bottom)
    if (sh.fireball) {
      this.batches[3] = new Batch(scene, sh.fireball, false, 128, { enc: true, premul: true,                  // 3 flipbook: a fireball
        grid: bk.fireball.grid, heat: bk.fireball.heat });
      this.fbFrames = bk.fireball.frames;
    }
    // Reusable sort scratch for the alpha layer (back-to-front).
    this._order = new Int32Array(C);
    this._depth = new Float32Array(C);
    this.stats = { live: 0, spawned: 0, dropped: 0, draws: 0 };
    this._t = 0;
  }

  System.prototype = {

    /** Claim a slot. Past the cap, evict the lowest-priority, oldest particle
     *  rather than dropping the new one — so a blast is never swallowed by a
     *  field of drifting smoke. Returns an index, or -1 if nothing gave way. */
    _slot: function (kind) {
      if (this.n < this.cap) return this.n++;
      var want = PRIO[kind] || 1, worst = -1, worstScore = want;
      // Sample rather than scan: 24 probes finds a weaker particle with
      // near-certainty when one exists, and costs nothing when it doesn't.
      for (var t = 0; t < 24; t++) {
        var i = (crand() * this.n) | 0;
        var p = PRIO[this.kind[i]] || 1;
        if (p < worstScore) { worstScore = p; worst = i; }
      }
      if (worst < 0) { this.stats.dropped++; return -1; }
      return worst;
    },

    _kill: function (i) {
      var last = --this.n;
      if (i !== last) {
        this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
        this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
        this.sz[i] = this.sz[last]; this.szv[i] = this.szv[last];
        this.rot[i] = this.rot[last]; this.rotv[i] = this.rotv[last];
        this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
        this.cr[i] = this.cr[last]; this.cg[i] = this.cg[last]; this.cb[i] = this.cb[last];
        this.alpha[i] = this.alpha[last]; this.kind[i] = this.kind[last]; this.cell[i] = this.cell[last];
        this.stretch[i] = this.stretch[last]; this.drag[i] = this.drag[last]; this.grav[i] = this.grav[last];
        this.dirx[i] = this.dirx[last]; this.dirz[i] = this.dirz[last];
        this.flip[i] = this.flip[last]; this.fin[i] = this.fin[last]; this.gnd[i] = this.gnd[last];
      }
    },

    /** The one entry point. `o` carries whatever the behaviour needs; anything
     *  omitted takes the behaviour's own default. */
    spawn: function (kind, o) {
      var i = this._slot(kind);
      if (i < 0) return -1;
      this.stats.spawned++;
      var R = crand;
      this.px[i] = o.x; this.py[i] = o.y; this.pz[i] = o.z;
      this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
      this.sz[i] = o.size || 1; this.szv[i] = o.grow || 0;
      this.rot[i] = o.rot !== undefined ? o.rot : R() * 6.283;
      this.rotv[i] = o.spin || 0;
      this.life[i] = this.maxLife[i] = o.life || 1;
      this.cr[i] = o.r !== undefined ? o.r : 1;
      this.cg[i] = o.g !== undefined ? o.g : 1;
      this.cb[i] = o.b !== undefined ? o.b : 1;
      this.alpha[i] = o.a !== undefined ? o.a : 1;
      this.kind[i] = kind;
      this.cell[i] = o.cell || 0;
      this.stretch[i] = o.stretch || 1;
      this.drag[i] = o.drag !== undefined ? o.drag : 0.6;
      this.grav[i] = o.gravity !== undefined ? o.gravity : 0;
      this.dirx[i] = o.dx || 0; this.dirz[i] = o.dz || 0;
      this.flip[i] = o.flip && this.billowFrames && (kind === K.SMOKE || kind === K.DUST || kind === K.TRAIL) ? 1 : 0;
      this.fin[i] = o.fin || 0.3;
      if (this._fxD) {                  // inside an authored effect: see `K`
        var k = this.K;
        this.px[i] = this._ox + (o.x - this._ox) * k;
        this.py[i] = this._oy + (o.y - this._oy) * k;
        this.pz[i] = this._oz + (o.z - this._oz) * k;
        this.sz[i] *= k; this.szv[i] *= k;
        // a velocity that is the world's own (a round going away off a plate,
        // the hull an exhaust rides on) is not part of the picture
        if (!o.keepV) { this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k; this.grav[i] *= k; }
      }
      if (this.flip[i] || kind === K.LICK) this.gnd[i] = this.terrain ? this.terrain.heightAt(this.px[i], this.pz[i]) : -1e4;
      return i;
    },

    /** Simulate, then pack the live set into the three instance batches. */
    /** The air everything light is sitting in. Called once a frame by the
     *  game from its own `wind`, so one weather system drives the clouds, the
     *  foliage sway and every particle. */
    setWind: function (x, z) { this.windX = x || 0; this.windZ = z || 0; },

    update: function (dt, camera) {
      if (dt <= 0) dt = 0.0001;
      this._t += dt;
      var b0 = this.batches[0], b1 = this.batches[1], b2 = this.batches[2], b3 = this.batches[3] || null;
      var b4 = this.batches[4] || null, b5 = this.batches[5] || null;
      var n0 = 0, n1 = 0, n2 = 0, n3 = 0, n4 = 0, n5 = 0;
      var T = this.terrain;
      // the view matrix, for laying a muzzle flash along its bore on screen
      var ve = camera ? camera.matrixWorldInverse.elements : null;

      for (var i = 0; i < this.n; i++) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this._kill(i); i--; continue; }
        var k = this.kind[i];
        var t = this.life[i] / this.maxLife[i];     // 1 -> 0 over the lifetime

        // -- integrate -----------------------------------------------------
        var g = this.grav[i];
        if (g) this.vy[i] -= g * dt;
        var d = this.drag[i];
        if (d) {
          var f = 1 - Math.min(0.98, d * dt);
          this.vx[i] *= f; this.vz[i] *= f;
          if (k !== K.DEBRIS && k !== K.GIB && k !== K.SPARK) this.vy[i] *= f;
        }
        // …and then the air it is sitting in takes it. Drag alone pulls a puff
        // toward STANDING STILL, which is only correct in a dead calm; what it
        // should be pulled toward is the speed of the air around it.
        var wk = WIND[k];
        if (wk) {
          var wf = Math.min(1, wk * dt);
          this.vx[i] += (this.windX - this.vx[i]) * wf;
          this.vz[i] += (this.windZ - this.vz[i]) * wf;
        }
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        this.sz[i] += this.szv[i] * dt;
        this.rot[i] += this.rotv[i] * dt;

        // Ballistic things stop when they reach the ground.
        if ((k === K.DEBRIS || k === K.GIB) && this.vy[i] < 0 && T) {
          var gy = T.heightAt(this.px[i], this.pz[i]);
          if (this.py[i] <= gy + 0.05) {
            this.py[i] = gy + 0.04;
            this.vx[i] *= 0.2; this.vz[i] *= 0.2; this.vy[i] = 0;
            this.grav[i] = 0; this.rotv[i] = 0;
            if (this.life[i] > 0.9) this.life[i] = 0.9;   // settle and fade out
          }
        }

        // -- shade ---------------------------------------------------------
        var a = this.alpha[i], sx = this.sz[i], sy = this.sz[i] * this.stretch[i];
        var cr = this.cr[i], cg = this.cg[i], cb = this.cb[i];
        var cellIdx = this.cell[i];
        if (k === K.SMOKE || k === K.DUST || k === K.TRAIL) {
          // (round 114) A simulated puff fades in over seconds, not a share of its
          // life (a column's puffs live 20 s: it stood a body-length off the fire
          // while they came up), and fades out late: the erosion does the rest.
          if (this.flip[i]) a *= Math.min(1, t * 4.5) * Math.min(1, this.maxLife[i] * (1 - t) / this.fin[i]);
          else a *= Math.min(1, t * 2.2) * (t > 0.75 ? (1 - t) / 0.25 : 1);   // fade in AND out
        } else if (k === K.FIRE) {
          // A CHEMICAL FIRE DOES NOT COOL THROUGH AMBER, and this ramp was
          // applied to every flame particle in the game regardless of the
          // colour it was spawned with — so white phosphorus, asked for in
          // blue-white, came out the same orange as a burning hedgerow.
          // Phosphorus burns white from the moment it meets the air until it
          // is spent. Recognised by the spawn colour: anything with more blue
          // in it than red is not a wood fire, and keeps the colour it was
          // given.
          if (cb > cr) {
            a *= Math.min(1, t * 3.5);
          } else {
            // Cool along the flame ramp as it dies: white -> amber -> deep red.
            var h = t * t;
            cr *= 0.55 + h * 0.45; cg *= 0.12 + h * 0.88; cb *= h * h * 0.9;
            a *= Math.min(1, t * 3.5);
          }
        } else if (k === K.SPARK || k === K.EMBER) {
          a *= t * t;
        } else if (k === K.STREAK) {
          // A SPARK keeps the roll it was born with; a round going away from a
          // plate has to be drawn ALONG its path as the camera sees it, and
          // shorter the more of the motion is toward or away from the eye.
          a *= Math.min(1, t * 2.5);
          if (ve) {
            var svx = this.vx[i], svy = this.vy[i], svz = this.vz[i];
            var qx = ve[0] * svx + ve[4] * svy + ve[8] * svz, qy = ve[1] * svx + ve[5] * svy + ve[9] * svz;
            var sl = Math.sqrt(svx * svx + svy * svy + svz * svz) || 1, ss = Math.sqrt(qx * qx + qy * qy);
            sy = this.sz[i] * this.stretch[i] * Math.max(0.15, ss / sl);
            this.rot[i] = Math.atan2(-qx, qy);
          }
        } else if (k === K.FLASH) {
          a *= t * t;
        } else if (k === K.BOOM) {
          // Flipbook: walk the cells over the particle's life. The canvas sheet
          // fades its first frames in; a baked sheet starts on its flash and
          // thins out by itself, so it only fades the last few frames away.
          var nf = this.boomFrames;
          cellIdx = Math.min(nf - 1, Math.floor((1 - t) * nf));
          a *= this.enc ? 0.88 * (t < 0.55 ? t / 0.55 : 1) : (t > 0.85 ? (1 - t) / 0.15 : 1);
          // (round 114) `a` under 1 eats the coverage (`vEr`): the thin skirt goes first.
          // The sheet's later frames are lit paler: held back, or the column ends tan.
          if (this.enc) { var bg = Math.max(0.3, Math.min(1, t * 1.1)); cr *= bg; cg *= bg; cb *= bg; }
        } else if (k === K.LICK) {
          a *= t < 0.15 ? t / 0.15 : 1;
        } else if (k === K.FBALL) {
          var nfb = this.fbFrames || 1;
          cellIdx = Math.min(nfb - 1, Math.floor((1 - t) * nfb));
          a *= t < 0.12 ? t / 0.12 : 1;
        } else if (k === K.MFLASH) {
          // LAID ALONG THE BORE. The sprite's +Y is the barrel; turn it to
          // where the barrel points ON SCREEN, and let it shorten as the gun
          // turns toward the camera — side-on it is a long plume, down the
          // bore it is the star you see from the target's end.
          a *= t * (2 - t);
          if (ve) {
            var dxw = this.dirx[i], dzw = this.dirz[i];
            var vx = ve[0] * dxw + ve[8] * dzw, vy = ve[1] * dxw + ve[9] * dzw;
            var side = Math.sqrt(vx * vx + vy * vy);
            if (side < 0.36) {
              cellIdx = S.MFRONT; sx = sy = this.sz[i] * 1.35;
            } else {
              sy = this.sz[i] * this.stretch[i] * side;
              this.rot[i] = Math.atan2(-vx, vy);
            }
          }
        } else if (k === K.DEBRIS || k === K.GIB) {
          a *= Math.min(1, t * 4);
        }
        if (a <= 0.003) continue;

        // -- pack ----------------------------------------------------------
        var layer = LAYER[k], B, at;
        if (layer === 3 && !b3) layer = 2;
        if (this.flip[i] || k === K.LICK) {
          // A simulated sheet: the frame walks over the life and blends in the shader.
          if (k === K.LICK) { if (!b5 || n5 >= b5.cap) continue; B = b5; at = n5++; }
          else { if (!b4 || n4 >= b4.cap) continue; B = b4; at = n4++; }
          B.pos[at * 3] = this.px[i]; B.pos[at * 3 + 1] = this.py[i]; B.pos[at * 3 + 2] = this.pz[i];
          B.col[at * 4] = cr; B.col[at * 4 + 1] = cg; B.col[at * 4 + 2] = cb; B.col[at * 4 + 3] = a;
          B.size[at * 3] = sx; B.size[at * 3 + 1] = sy; B.size[at * 3 + 2] = this.rot[i];
          if (k === K.LICK) { B.uv[at * 2] = Math.min(B.frames - 1.001, (1 - t) * (B.frames - 1)); B.uv[at * 2 + 1] = 0; }
          else {
            // the sheet's first frames are a knot a tenth of the cell across: start
            // past them or a new puff is a dot. Then age eats the coverage (`vEr`).
            var ag = 1 - t, er = ag > 0.3 ? (ag - 0.3) / 0.7 : 0;
            B.uv[at * 2] = Math.min(B.frames - 1.001, (0.2 + ag * 0.8) * (B.frames - 1)); B.uv[at * 2 + 1] = er * er * 0.82;
          }
          B.gnd[at] = k === K.LICK ? -1e4 : this.gnd[i];
          continue;
        }
        if (layer === 3) { B = b3; at = n3; if (n3 >= B.cap) continue; n3++; }
        else if (layer === 2) { B = b2; at = n2; if (n2 >= B.cap) continue; n2++; }
        else if (layer === 0) { B = b0; at = n0; if (n0 >= B.cap) continue; n0++; }
        else { B = b1; at = n1; if (n1 >= B.cap) continue; n1++; }
        B.pos[at * 3] = this.px[i]; B.pos[at * 3 + 1] = this.py[i]; B.pos[at * 3 + 2] = this.pz[i];
        B.col[at * 4] = cr; B.col[at * 4 + 1] = cg; B.col[at * 4 + 2] = cb; B.col[at * 4 + 3] = a;
        B.size[at * 3] = sx; B.size[at * 3 + 1] = sy; B.size[at * 3 + 2] = this.rot[i];
        var gn = B.grid;
        B.uv[at * 2] = (cellIdx % gn) / gn;
        B.uv[at * 2 + 1] = 1 - (Math.floor(cellIdx / gn) + 1) / gn;
      }

      // The alpha layer is the only one where draw order is visible; sort it
      // back-to-front. Additive blending is order-independent by definition and
      // the flipbook layer is additive too, so neither needs this.
      if (n1 > 1 && n1 <= 2400 && camera) this._sortAlpha(b1, n1, camera);
      if (b4 && n4 > 1 && camera) this._sortAlpha(b4, n4, camera);

      b0.flush(n0); b1.flush(n1); b2.flush(n2); if (b3) b3.flush(n3); if (b4) b4.flush(n4); if (b5) b5.flush(n5);
      this.stats.live = this.n;
      this.stats.draws = (n0 > 0) + (n1 > 0) + (n2 > 0) + (n3 > 0) + (n4 > 0) + (n5 > 0);
    },

    _sortAlpha: function (B, n, camera) {
      var cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      var depth = this._depth, i, lo = Infinity, hi = -Infinity;
      for (i = 0; i < n; i++) {
        var dx = B.pos[i * 3] - cx, dy = B.pos[i * 3 + 1] - cy, dz = B.pos[i * 3 + 2] - cz;
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        depth[i] = d; if (d < lo) lo = d; if (d > hi) hi = d;
      }
      var view = this._farFirst(n, lo, hi);
      // Permute in place through a scratch copy of each attribute run.
      if (!this._tmp || this._tmp.length < n * 4) this._tmp = new Float32Array(n * 4);
      var tmp = this._tmp, j;
      for (i = 0; i < n; i++) { j = view[i]; tmp[i * 3] = B.pos[j * 3]; tmp[i * 3 + 1] = B.pos[j * 3 + 1]; tmp[i * 3 + 2] = B.pos[j * 3 + 2]; }
      B.pos.set(tmp.subarray(0, n * 3));
      for (i = 0; i < n; i++) { j = view[i]; tmp[i * 3] = B.size[j * 3]; tmp[i * 3 + 1] = B.size[j * 3 + 1]; tmp[i * 3 + 2] = B.size[j * 3 + 2]; }
      B.size.set(tmp.subarray(0, n * 3));
      for (i = 0; i < n; i++) { j = view[i]; tmp[i * 2] = B.uv[j * 2]; tmp[i * 2 + 1] = B.uv[j * 2 + 1]; }
      B.uv.set(tmp.subarray(0, n * 2));
      if (B.frames) { for (i = 0; i < n; i++) tmp[i] = B.gnd[view[i]]; B.gnd.set(tmp.subarray(0, n)); }
      for (i = 0; i < n; i++) { j = view[i]; tmp[i * 4] = B.col[j * 4]; tmp[i * 4 + 1] = B.col[j * 4 + 1]; tmp[i * 4 + 2] = B.col[j * 4 + 2]; tmp[i * 4 + 3] = B.col[j * 4 + 3]; }
      B.col.set(tmp.subarray(0, n * 4));
    },

    /** (round 108) FAR FIRST, BY A RADIX SORT OF THE DISTANCE. The alpha layer
     *  was ordered by copying the indices into a new array and sorting that
     *  with a comparator, every frame: up to 2,400 entries, and an allocation
     *  site V8 learned to put straight into the old generation — 7 KB a frame
     *  of the 39 that outlived a minor collection at 2,000 men, a fifth of
     *  what brought on the full collections (35-85 ms pauses on that heap).
     *  Two stable byte passes over a 16-bit key (the distance across this
     *  frame's span), in scratch kept here: the same order to within a
     *  65,536th of the span, ties by index as the stable sort had them. */
    _farFirst: function (n, lo, hi) {
      var C = this._order.length, a = this._order, depth = this._depth;
      var key = this._key || (this._key = new Uint16Array(C));
      var b = this._order2 || (this._order2 = new Int32Array(C));
      var cnt = this._cnt || (this._cnt = new Uint32Array(256));
      var s = hi > lo ? 65535 / (hi - lo) : 0, i, j, k, sum, t;
      for (i = 0; i < n; i++) { key[i] = ((hi - depth[i]) * s) | 0; a[i] = i; }
      cnt.fill(0); for (i = 0; i < n; i++) cnt[key[i] & 255]++;
      for (sum = 0, k = 0; k < 256; k++) { t = cnt[k]; cnt[k] = sum; sum += t; }
      for (i = 0; i < n; i++) { j = a[i]; b[cnt[key[j] & 255]++] = j; }
      cnt.fill(0); for (i = 0; i < n; i++) cnt[key[i] >> 8]++;
      for (sum = 0, k = 0; k < 256; k++) { t = cnt[k]; cnt[k] = sum; sum += t; }
      for (i = 0; i < n; i++) { j = b[i]; a[cnt[key[j] >> 8]++] = j; }
      return a;
    },

    /** Keep the particle fog in step with the scene's. */
    setFog: function (colorHex, density) {
      for (var i = 0; i < this.batches.length; i++) {
        this.batches[i].mat.uniforms.uFogColor.value.setHex(colorHex);
        this.batches[i].mat.uniforms.uFogDensity.value = density;
      }
    },

    /** The light smoke and dust are seen by, linear RGB (1 at noon). */
    setLight: function (r, g, b) {
      for (var i = 0; i < this.batches.length; i++) this.batches[i].mat.uniforms.uLight.value.setRGB(r, g, b);
    },

    clear: function () { this.n = 0; for (var i = 0; i < this.batches.length; i++) if (this.batches[i]) this.batches[i].flush(0); },
    dispose: function () { for (var i = 0; i < this.batches.length; i++) if (this.batches[i]) this.batches[i].dispose(); },

    // =====================================================================
    // AUTHORED EFFECTS — what the game actually calls
    // =====================================================================
    // Each of these is tuned to read at both scales the game is played at:
    // punchy and legible from the strategic camera, and still convincing from
    // eye level in first person, two metres from the impact.

    rnd: function (a, b) { return a + crand() * (b - a); },

    /** The core of an HE burst: flash, flipbook fireball, ejecta, dust ring.
     *  `power` ~= the blast radius in world units. */
    explosion: function (x, y, z, power, o) {
      o = o || {};
      var p = Math.max(0.6, power), q = this.quality;
      var i;
      // 1. the flash — one frame of white that sells the overpressure
      this.spawn(K.FLASH, { x: x, y: y + p * 0.25, z: z, size: p * 3.2, life: 0.09,
        cell: S.STAR, r: 1, g: 0.96, b: 0.86, a: 0.95, grow: p * 4 });
      // 2. the fireball flipbook — one big, two offset smaller, so the shape
      //    is asymmetric the way a real burst is
      this.spawn(K.BOOM, { x: x, y: y + p * 0.3, z: z, size: p * 2.6, life: 0.62,
        grow: p * 1.5, spin: this.rnd(-0.5, 0.5), a: 1 });
      for (i = 0; i < 2; i++) {
        this.spawn(K.BOOM, {
          x: x + this.rnd(-p * 0.5, p * 0.5), y: y + this.rnd(0, p * 0.7), z: z + this.rnd(-p * 0.5, p * 0.5),
          size: p * this.rnd(1.1, 1.8), life: this.rnd(0.42, 0.58), grow: p * 1.1,
          spin: this.rnd(-1.2, 1.2), a: 0.85,
        });
      }
      // 3. the column of smoke that stays behind and marks the crater
      for (i = 0; i < Math.round(5 * q); i++) {
        this.spawn(K.SMOKE, {
          x: x + this.rnd(-p * 0.4, p * 0.4), y: y + this.rnd(0.2, p), z: z + this.rnd(-p * 0.4, p * 0.4),
          vx: this.rnd(-0.7, 0.7), vy: this.rnd(1.4, 3.0), vz: this.rnd(-0.7, 0.7),
          size: p * this.rnd(0.7, 1.3), grow: p * this.rnd(0.5, 0.95), life: this.rnd(2.2, 4.2),
          spin: this.rnd(-0.5, 0.5), cell: crand() < 0.6 ? S.SOOT : S.PUFF,
          r: 0.5, g: 0.48, b: 0.45, a: this.rnd(0.42, 0.62), drag: 0.5,
        });
      }
      // 4. THE DUST RING. Cheap, and the single thing that most makes a burst
      //    look like it happened on ground rather than in a vacuum.
      if (o.ground !== false) {
        for (i = 0; i < Math.round(7 * q); i++) {
          var a = crand() * 6.283, sp = this.rnd(3.5, 9) * Math.min(2, p * 0.5);
          this.spawn(K.DUST, {
            x: x, y: y + 0.15, z: z,
            vx: Math.cos(a) * sp, vy: this.rnd(0.2, 1.1), vz: Math.sin(a) * sp,
            size: p * this.rnd(0.5, 0.9), grow: p * this.rnd(0.9, 1.6), life: this.rnd(1.4, 2.6),
            spin: this.rnd(-0.6, 0.6), cell: S.DUST,
            r: 0.72, g: 0.66, b: 0.52, a: this.rnd(0.34, 0.5), drag: 2.2,
          });
        }
      }
      // 5. ejecta: earth thrown up, and sparks
      for (i = 0; i < Math.round(8 * q); i++) {
        var ea = crand() * 6.283, es = this.rnd(3, 11);
        this.spawn(K.DEBRIS, {
          x: x, y: y + 0.3, z: z,
          vx: Math.cos(ea) * es * 0.5, vy: this.rnd(5, 13), vz: Math.sin(ea) * es * 0.5,
          size: this.rnd(0.10, 0.30), life: this.rnd(0.9, 1.7), spin: this.rnd(-9, 9),
          cell: S.CHUNK, r: 0.62, g: 0.56, b: 0.44, a: 1, gravity: 17, drag: 0.15,
        });
      }
      this.sparks(x, y + 0.4, z, Math.round(10 * q), 0xffc860, p);
    },

    /** JUST the fireball and its flash — no smoke, no dust, no ejecta.
     *  `Game.explode` already emits those as separate calls, so this is the
     *  piece that slots into the existing sequence without doubling it up. */
    burst: function (x, y, z, r, o) {
      o = o || {};
      var p = Math.max(0.5, r);
      if (this.enc) {
        if (o.groundY !== undefined) {
          // at life size (`K`) the sprite shrinks onto its own ground line,
          // not onto the point above it the burst was called at
          if (this._fxD) this._oy = o.groundY;
          // THE BAKED GROUND BURST is the flash, the jets of earth, the skirt
          // and the column in one sprite, anchored at its ground line — a
          // shell bursting in a field, not a ball of fire in the air. Tinted
          // the ground it came out of (`o.color`), and it never spins: the
          // ground line has to stay level.
          var gs = p * 3.7, gc = o.color || { r: 0.45, g: 0.4, b: 0.34 };
          this.spawn(K.FLASH, { x: x, y: o.groundY + p * 0.45, z: z, size: p * 2.4, life: 0.07,
            cell: S.STAR, r: 1, g: 0.95, b: 0.84, a: 0.9, grow: p * 3 });
          this.spawn(K.BOOM, { x: x, y: o.groundY + gs * (0.5 - this.boomGround), z: z, size: gs,
            life: Math.min(3.8, 1.7 + p * 0.22), grow: p * 0.22, rot: this.rnd(-0.05, 0.05), spin: 0,
            // (round 114) the sheet's lit grey is dark: at the bare tint a column of
            // earth was a black cut-out. Earth, and lit by the same sun as the field.
            r: gc.r * 2.5, g: gc.g * 2.3, b: gc.b * 2.05, a: 1, drag: 0 });
          // …AND WHAT THE COLUMN LEAVES IN THE AIR. The sprite ends in three seconds,
          // and there was nothing where it had stood. A few big soft puffs up its
          // height, coming up as it thins, drifting off on the wind.
          var nc = Math.max(3, Math.round((3 + p * 0.8) * this.quality));
          for (var ci = 0; ci < nc; ci++) {
            var ch = crand();
            this.spawn(K.SMOKE, { flip: 1, fin: 1.3,
              x: x + this.rnd(-0.2, 0.2) * gs * (0.35 + ch), y: o.groundY + gs * (0.06 + ch * 0.5), z: z + this.rnd(-0.2, 0.2) * gs * (0.35 + ch),
              vx: this.rnd(-0.3, 0.3), vy: this.rnd(0.15, 0.7), vz: this.rnd(-0.3, 0.3),
              size: gs * this.rnd(0.26, 0.44) * (1 - ch * 0.25), grow: gs * this.rnd(0.02, 0.05),
              life: this.rnd(5, 9) + p * 0.9, rot: this.rnd(-0.5, 0.5), spin: this.rnd(-0.08, 0.08),
              r: gc.r * 0.85, g: gc.g * 0.76, b: gc.b * 0.66, a: this.rnd(0.26, 0.48), drag: 0.5 });
          }
          return;
        }
        // A FIREBALL — fuel, ammunition, a vehicle going up: orange rolling
        // into black, in the air where the thing that burst was.
        this.spawn(K.FLASH, { x: x, y: y, z: z, size: p * 2.2, life: 0.08,
          cell: S.STAR, r: 1, g: 0.92, b: 0.78, a: 0.9, grow: p * 3 });
        this.spawn(this.fbFrames ? K.FBALL : K.BOOM, { x: x, y: y + p * 0.2, z: z, size: p * 3.0,
          life: Math.min(3.2, 1.3 + p * 0.25), grow: p * 0.5, vy: 0.4, spin: this.rnd(-0.15, 0.15),
          r: 0.3, g: 0.28, b: 0.26, a: 1, drag: 0.2 });
        return;
      }
      this.spawn(K.FLASH, { x: x, y: y, z: z, size: p * 2.6, life: 0.08,
        cell: S.STAR, r: 1, g: 0.95, b: 0.84, a: 0.95, grow: p * 4 });
      this.spawn(K.BOOM, { x: x, y: y, z: z, size: p * 2.3, life: 0.58,
        grow: p * 1.4, spin: this.rnd(-0.5, 0.5), a: o.a === undefined ? 1 : o.a });
      var extra = p > 1.2 ? 2 : 1;
      for (var i = 0; i < extra; i++) {
        this.spawn(K.BOOM, {
          x: x + this.rnd(-p * 0.45, p * 0.45), y: y + this.rnd(0, p * 0.6), z: z + this.rnd(-p * 0.45, p * 0.45),
          size: p * this.rnd(1.0, 1.7), life: this.rnd(0.4, 0.56), grow: p * 1.0,
          spin: this.rnd(-1.2, 1.2), a: 0.8,
        });
      }
    },

    /** Burning: a lick of flame plus the smoke off it.
     *  `tint` overrides the colour — white phosphorus does not burn orange,
     *  it burns a hard blue-white that is wrong enough to be frightening. */
    fire: function (x, y, z, count, scale, tint) {
      var s = scale || 1, n = Math.max(1, Math.round(count * this.quality));
      var tr = tint ? tint.r : 1, tg = tint ? tint.g : 0.86, tb = tint ? tint.b : 0.55;
      var er = tint ? tint.r : 1, eg = tint ? tint.g : 0.62, eb = tint ? tint.b : 0.22;
      if (this.lickFrames && !tint) {
        // (round 114) TONGUES OF FLAME from a fluid simulation: each rises, necks
        // and tears away, and a fire is two or three of them overlapping. It was a
        // handful of orange dots shrinking on the way up. Fewer particles, a warm
        // glow under them, and sparks off the top. A tinted fire (phosphorus) is
        // not a wood fire and keeps its own white glow below.
        var m = Math.max(1, Math.round(n * 0.55));
        for (var li = 0; li < m; li++) {
          var ls = this.rnd(2.2, 3.6) * s;
          this.spawn(K.LICK, {
            x: x + this.rnd(-0.42, 0.42) * s, y: y + ls * 0.38, z: z + this.rnd(-0.42, 0.42) * s,
            vy: this.rnd(0.1, 0.45) * s, vx: this.rnd(-0.1, 0.1), vz: this.rnd(-0.1, 0.1),
            size: ls, grow: 0.12 * s, life: this.rnd(0.75, 1.3), rot: this.rnd(-0.14, 0.14), spin: this.rnd(-0.06, 0.06),
            r: 0.07, g: 0.055, b: 0.045, a: this.rnd(0.82, 1), drag: 0.5,
          });
        }
        if (crand() < 0.5) {
          this.spawn(K.FIRE, { x: x, y: y + 0.25 * s, z: z, size: this.rnd(1.6, 2.4) * s, life: this.rnd(0.3, 0.55), cell: S.GLOW,
            r: 1, g: 0.42, b: 0.1, a: 0.22, drag: 0 });
        }
        if (crand() < 0.3 * n) {
          this.spawn(K.EMBER, {
            x: x + this.rnd(-0.4, 0.4) * s, y: y + this.rnd(0.3, 0.9) * s, z: z + this.rnd(-0.4, 0.4) * s,
            vx: this.rnd(-0.5, 0.5), vy: this.rnd(1.4, 3.0), vz: this.rnd(-0.5, 0.5),
            size: this.rnd(0.05, 0.11), life: this.rnd(0.9, 2.2),
            cell: S.CINDER, r: er, g: eg, b: eb, a: 1, drag: 0.8,
          });
        }
        return;
      }
      for (var i = 0; i < n; i++) {
        this.spawn(K.FIRE, {
          x: x + this.rnd(-0.5, 0.5) * s, y: y + this.rnd(0, 0.4) * s, z: z + this.rnd(-0.5, 0.5) * s,
          vx: this.rnd(-0.35, 0.35), vy: this.rnd(1.6, 3.4) * s, vz: this.rnd(-0.35, 0.35),
          size: this.rnd(0.6, 1.25) * s, grow: -this.rnd(0.2, 0.5) * s,
          life: this.rnd(0.36, 0.8), spin: this.rnd(-2, 2),
          // The FLAME cell is a painted orange tongue and the tint only
          // multiplies it, so a white-hot fire drawn on it comes out orange
          // anyway. A tinted fire uses the NEUTRAL glow, where the colour
          // asked for is the colour you get.
          cell: tint ? S.GLOW : (crand() < 0.55 ? S.FLAME : S.GLOW),
          r: tr, g: tg, b: tb, a: this.rnd(0.65, 0.95), drag: 0.9,
        });
        if (crand() < 0.35) {
          this.spawn(K.EMBER, {
            x: x + this.rnd(-0.4, 0.4) * s, y: y + this.rnd(0.2, 0.8) * s, z: z + this.rnd(-0.4, 0.4) * s,
            vx: this.rnd(-0.5, 0.5), vy: this.rnd(1.2, 2.6), vz: this.rnd(-0.5, 0.5),
            size: this.rnd(0.06, 0.14), life: this.rnd(0.8, 2.0),
            cell: S.CINDER, r: er, g: eg, b: eb, a: 1, drag: 0.8,
          });
        }
      }
    },

    /** Battlefield smoke. `o.dense` gives the heavy screening variety that
     *  hangs low and actually hides things. */
    smoke: function (x, y, z, count, o) {
      o = o || {};
      var s = o.scale || 1;
      var n = Math.max(1, Math.round(count * this.quality));
      if (this.billowFrames) {
        // (round 114) A PUFF THAT CHANGES SHAPE: a dense knot opening into a torn
        // rag as it goes, from a fluid simulation, so fewer of them make a thicker
        // column than the old round sprites did. Bigger quad: most of the sheet's
        // frames do not fill their cell. Oily soot off a fire is dark and rises
        // fast; a burst's smoke is grey and drifts.
        n = Math.max(1, Math.round(n * 0.75));
        for (var bi = 0; bi < n; bi++) {
          var bd = o.oily ? this.rnd(0.1, 0.17) : this.rnd(0.42, 0.6);
          this.spawn(K.SMOKE, {
            flip: 1, x: x + this.rnd(-0.7, 0.7) * s, y: y + this.rnd(0.1, 0.9) * s, z: z + this.rnd(-0.7, 0.7) * s,
            vx: this.rnd(-0.35, 0.35), vy: this.rnd(o.dense ? 0.22 : 0.7, o.dense ? 0.7 : 1.6) * s, vz: this.rnd(-0.35, 0.35),
            size: this.rnd(2.0, 3.4) * s, grow: this.rnd(0.35, 0.8) * s,
            life: this.rnd(o.dense ? 6.5 : 4.0, o.dense ? 13 : 8), rot: this.rnd(-0.5, 0.5), spin: this.rnd(-0.08, 0.08),
            r: bd * 1.04, g: bd, b: bd * 0.95, a: this.rnd(o.dense ? 0.55 : 0.34, o.dense ? 0.78 : 0.56), drag: 0.55,
          });
        }
        return;
      }
      for (var i = 0; i < n; i++) {
        var dark = o.oily ? this.rnd(0.14, 0.24) : this.rnd(0.42, 0.62);
        this.spawn(K.SMOKE, {
          x: x + this.rnd(-0.9, 0.9) * s, y: y + this.rnd(0, 1.0) * s, z: z + this.rnd(-0.9, 0.9) * s,
          vx: this.rnd(-0.4, 0.4), vy: this.rnd(o.dense ? 0.25 : 0.8, o.dense ? 0.9 : 1.9) * s, vz: this.rnd(-0.4, 0.4),
          size: this.rnd(1.1, 2.2) * s, grow: this.rnd(0.5, 1.2) * s,
          life: this.rnd(o.dense ? 5 : 1.8, o.dense ? 11 : 3.6), spin: this.rnd(-0.5, 0.5),
          cell: o.oily ? S.SOOT : (crand() < 0.5 ? S.PUFF : S.WISP),
          r: dark * 1.06, g: dark, b: dark * 0.94,
          // Thinner than it was. `dense` is the deliberate screening kind —
          // a smoke mission, a burning tank — and it keeps most of its weight
          // because hiding things is its JOB; the incidental smoke off every
          // burst on the field is what was making the air soupy.
          a: this.rnd(o.dense ? 0.30 : 0.19, o.dense ? 0.44 : 0.32), drag: 0.55,
        });
      }
    },

    /** Kicked-up earth and grit: the low, fast, pale layer.
     *
     *  `o.color` is a THREE colour-ish {r,g,b} — the ground it came off,
     *  because a shell in Norman mud throws something black and one on a chalk
     *  crest something nearly white. `o.throw` scales how hard it goes
     *  sideways and `o.rise` how much of it goes up: a surface burst is a flat
     *  sheet, a heavy shell that digs in first is a column. */
    dust: function (x, y, z, count, o) {
      o = o || {};
      var n = Math.max(1, Math.round(count * this.quality)), s = o.scale || 1;
      var th = o.throw === undefined ? 1 : o.throw, up = o.rise === undefined ? 1 : o.rise;
      var c = o.color, cr = c ? c.r : 0.74, cg = c ? c.g : 0.68, cb = c ? c.b : 0.54;
      var life = o.life === undefined ? 1 : o.life;
      if (this.billowFrames) {
        // (round 114) Dust is the same physics at the ground: it billows out and
        // hangs, in the colour of what it came off, and thins where it meets the
        // field (`iGnd`) rather than ending in a line across it.
        n = Math.max(1, Math.round(n * 0.7));
        for (var di = 0; di < n; di++) {
          var da = crand() * 6.283, dsp = this.rnd(1.0, 3.2) * s * th;
          this.spawn(K.DUST, {
            flip: 1, x: x + Math.cos(da) * this.rnd(0, 0.5) * s, y: y + this.rnd(0.25, 0.6) * s,
            z: z + Math.sin(da) * this.rnd(0, 0.5) * s,
            vx: Math.cos(da) * dsp, vy: this.rnd(0.15, 0.7) * up, vz: Math.sin(da) * dsp,
            size: this.rnd(1.3, 2.5) * s, grow: this.rnd(0.3, 0.7) * s,
            life: this.rnd(1.5, 3.2) * life, rot: this.rnd(-0.6, 0.6), spin: this.rnd(-0.1, 0.1),
            r: cr * 0.66, g: cg * 0.64, b: cb * 0.6, a: this.rnd(0.15, 0.3) * (o.a || 1), drag: 2.4,
          });
        }
        return;
      }
      for (var i = 0; i < n; i++) {
        // Thrown on a bearing rather than in a box: the sheet leaves the seat
        // of the burst radially, which is what makes it read as a ring.
        var a = crand() * 6.283, sp = this.rnd(1.0, 3.2) * s * th;
        this.spawn(K.DUST, {
          x: x + Math.cos(a) * this.rnd(0, 0.5) * s, y: y + this.rnd(0, 0.35) * s,
          z: z + Math.sin(a) * this.rnd(0, 0.5) * s,
          vx: Math.cos(a) * sp, vy: this.rnd(0.2, 1.0) * up, vz: Math.sin(a) * sp,
          size: this.rnd(0.7, 1.5) * s, grow: this.rnd(0.5, 1.1) * s,
          life: this.rnd(1.0, 2.4) * life, spin: this.rnd(-0.7, 0.7), cell: S.DUST,
          r: cr, g: cg, b: cb, a: this.rnd(0.22, 0.4) * (o.a || 1), drag: 2.4,
        });
      }
    },

    sparks: function (x, y, z, count, color, power) {
      var n = Math.max(1, Math.round(count * this.quality)), p = power || 1;
      var c = new THREE.Color(color === undefined ? 0xffc860 : color);
      for (var i = 0; i < n; i++) {
        var a = crand() * 6.283, e = this.rnd(0.1, 1.3), sp = this.rnd(4, 13) * Math.min(2, p);
        this.spawn(K.SPARK, {
          x: x, y: y, z: z,
          vx: Math.cos(a) * sp, vy: e * sp * 0.8, vz: Math.sin(a) * sp,
          size: this.rnd(0.05, 0.12), stretch: this.rnd(3, 7),
          rot: a, life: this.rnd(0.28, 0.75), cell: S.SPARK,
          r: c.r, g: c.g, b: c.b, a: 1, gravity: 16, drag: 0.5,
        });
      }
    },

    /** A ROUND GOING AWAY: one hot streak along (vx, vy, vz), drawn along its
     *  own path on screen (K.STREAK) — a shot deflected off a plate, which
     *  is what you SEE of a ricochet at any range: the tracer turning. */
    streak: function (x, y, z, vx, vy, vz, o) {
      o = o || {};
      var c = new THREE.Color(o.color === undefined ? 0xffd9a0 : o.color);
      this.spawn(K.STREAK, {
        x: x, y: y, z: z, vx: vx, vy: vy, vz: vz,
        size: o.size || 0.09, stretch: o.stretch || 14, rot: 0,
        life: o.life || 0.7, cell: S.SPARK, keepV: true,
        r: c.r, g: c.g, b: c.b, a: 1, gravity: o.gravity === undefined ? 2.5 : o.gravity, drag: o.drag || 0.05,
      });
    },

    /** AN ENGINE RUNNING: one small puff off an exhaust at (x, y, z), carried
     *  with the vehicle's own motion (vx, vz) and then the wind. `o.dark` is
     *  the grey of it — a diesel's is near black under load — and `o.scale`
     *  how hard the engine is working. */
    exhaust: function (x, y, z, vx, vz, o) {
      o = o || {};
      var dark = o.dark === undefined ? 0.5 : o.dark, s = o.scale || 1, k = this._fxD ? this.K : 1;
      this.spawn(K.SMOKE, {
        x: x + this.rnd(-0.08, 0.08), y: y, z: z + this.rnd(-0.08, 0.08), keepV: true,
        vx: (vx || 0) * 0.6 + this.rnd(-0.25, 0.25) * k, vy: this.rnd(0.45, 0.95) * s * k, vz: (vz || 0) * 0.6 + this.rnd(-0.25, 0.25) * k,
        size: this.rnd(0.32, 0.55) * s, grow: this.rnd(0.55, 1.0) * s,
        life: this.rnd(1.1, 2.1) * (o.life || 1), spin: this.rnd(-0.6, 0.6),
        cell: crand() < 0.5 ? S.PUFF : S.WISP,
        r: dark * 1.03, g: dark, b: dark * 1.03, a: this.rnd(0.16, 0.28) * (o.a || 1), drag: 0.9,
      });
    },

    /** THE SHAPED-CHARGE JET. A hollow charge does not throw a ball of fire
     *  about — it collapses a copper cone into a needle of metal moving at
     *  eight kilometres a second, and what you see from outside is a very
     *  short, very bright, very NARROW spike of incandescence going straight
     *  up off the plate, and almost nothing else. Every burst in this game
     *  looked like a bomb going off, including the Panzerfaust. This is what
     *  makes a Panzerfaust hit read as a Panzerfaust hit. */
    jet: function (x, y, z, count, color, power) {
      var n = Math.max(1, Math.round(count * this.quality)), p = power || 1;
      var c = new THREE.Color(color === undefined ? 0xfff4d0 : color);
      for (var i = 0; i < n; i++) {
        // A tight cone: almost all the velocity is vertical, and the spread is
        // a few degrees rather than a hemisphere.
        var a = crand() * 6.283, lat = this.rnd(0, 0.16), sp = this.rnd(16, 34) * p;
        this.spawn(K.SPARK, {
          x: x + Math.cos(a) * 0.12, y: y, z: z + Math.sin(a) * 0.12,
          vx: Math.cos(a) * lat * sp, vy: sp, vz: Math.sin(a) * lat * sp,
          size: this.rnd(0.04, 0.10), stretch: this.rnd(8, 18),
          rot: a, life: this.rnd(0.16, 0.42), cell: S.SPARK,
          r: c.r, g: c.g, b: c.b, a: 1, gravity: 13, drag: 0.9,
        });
      }
    },

    /** EARTH THROWN FLAT. A mortar bomb arrives nose down with a thin casing
     *  and an instantaneous fuze, so it bursts ON the surface and throws its
     *  fragments and the ground sideways in a low disc — which is exactly why
     *  a slit trench works against one and a shell splinter overhead does not.
     *  A shell that digs in first throws a column; this is the other one. */
    spray: function (x, y, z, count, color, rise) {
      var n = Math.max(1, Math.round(count * this.quality));
      var c = new THREE.Color(color === undefined ? 0x3a3025 : color);
      var up = rise === undefined ? 0.30 : rise;
      for (var i = 0; i < n; i++) {
        var a = crand() * 6.283, sp = this.rnd(6, 15);
        this.spawn(K.DEBRIS, {
          x: x, y: y, z: z,
          vx: Math.cos(a) * sp, vy: this.rnd(0.6, 3.4) * up * 3.2, vz: Math.sin(a) * sp,
          size: this.rnd(0.06, 0.17), life: this.rnd(0.5, 1.1), spin: this.rnd(-10, 10),
          cell: S.CHUNK, r: c.r * 1.4, g: c.g * 1.4, b: c.b * 1.4, a: 1, gravity: 19, drag: 0.22,
        });
      }
    },

    debris: function (x, y, z, count, color, sc) {
      var n = Math.max(1, Math.round(count * this.quality)), k = sc || 1;
      var c = new THREE.Color(color === undefined ? 0x3a3025 : color);
      for (var i = 0; i < n; i++) {
        var a = crand() * 6.283, sp = this.rnd(1.5, 5.5);
        this.spawn(K.DEBRIS, {
          x: x, y: y, z: z,
          vx: Math.cos(a) * sp, vy: this.rnd(2.5, 8), vz: Math.sin(a) * sp,
          size: this.rnd(0.09, 0.24) * (crand() < 0.25 ? 2.6 : 1) * k, life: this.rnd(0.9, 1.8), spin: this.rnd(-8, 8),
          cell: S.CHUNK, r: c.r * 1.4, g: c.g * 1.4, b: c.b * 1.4, a: 1, gravity: 17, drag: 0.1,
        });
      }
    },

    blood: function (x, y, z, count) {
      var n = Math.max(1, Math.round(count * this.quality));
      for (var i = 0; i < n; i++) {
        var a = crand() * 6.283, sp = this.rnd(0.8, 3.4);
        this.spawn(K.DEBRIS, {
          x: x, y: y, z: z,
          vx: Math.cos(a) * sp, vy: this.rnd(1.2, 4.5), vz: Math.sin(a) * sp,
          size: this.rnd(0.05, 0.13), life: this.rnd(0.5, 1.1), spin: this.rnd(-4, 4),
          cell: S.DROP, r: 1.0, g: 0.045, b: 0.035, a: 0.95, gravity: 16, drag: 0.2,
        });
      }
    },

    /** A ROUND THROUGH A MAN (round 106). Not a fountain in every direction:
     *  a rifle bullet goes through, and what comes out comes out of the far
     *  side along its path — a cone of drops and a puff of fine red mist that
     *  hangs for a moment — with a little back-spatter toward the gun. `dx`,
     *  `dz`: the way the round was going; `k`: how much (a limb ~0.6, the
     *  trunk 1, the head 2). Authored at the diorama's size, like the rest
     *  (`K` takes it to the drawing's). */
    woundSpray: function (x, y, z, dx, dz, k) {
      k = k || 1;
      var dl = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= dl; dz /= dl;
      var n = Math.max(2, Math.round(8 * k * this.quality));
      for (var i = 0; i < n; i++) {
        var sp = this.rnd(3, 8) * (0.75 + 0.25 * k), side = this.rnd(-0.5, 0.5), up = this.rnd(-0.15, 0.45);
        this.spawn(K.DEBRIS, {
          x: x + dx * 0.08, y: y, z: z + dz * 0.08,
          vx: (dx - dz * side) * sp, vy: up * sp + this.rnd(0.4, 1.8), vz: (dz + dx * side) * sp,
          size: this.rnd(0.045, 0.1) * (0.85 + 0.15 * k), life: this.rnd(0.35, 0.75), spin: this.rnd(-4, 4),
          // (round 114) THE BAKED DROP CELL IS GREY, and it was tinted grey: every
          // droplet in the game was a dark grey speck. The red has to be the tint.
          cell: S.DROP, r: 1.0, g: 0.045, b: 0.035, a: 0.95, gravity: 16, drag: 0.5,
        });
      }
      // the mist: finer than the drops, carried a little way and gone
      this.spawn(K.SMOKE, {
        x: x + dx * 0.12, y: y, z: z + dz * 0.12, vx: dx * 1.4 * k, vy: 0.15, vz: dz * 1.4 * k,
        size: 0.12 + 0.08 * k, grow: 0.5 * k, life: this.rnd(0.22, 0.42) * (0.8 + 0.2 * k), rot: this.rnd(0, 6.283),
        cell: S.PUFF, r: 0.36, g: 0.02, b: 0.018, a: 0.42 + 0.14 * Math.min(1, k), drag: 2.4,
      });
      // …and the back-spatter: a few drops thrown back the way it came
      var nb = Math.max(1, Math.round(2 * k * this.quality));
      for (var j = 0; j < nb; j++) {
        var bs = this.rnd(1, 3), bside = this.rnd(-0.7, 0.7);
        this.spawn(K.DEBRIS, {
          x: x - dx * 0.04, y: y, z: z - dz * 0.04,
          vx: (-dx - dz * bside) * bs, vy: this.rnd(0.6, 2.2), vz: (-dz + dx * bside) * bs,
          size: this.rnd(0.04, 0.07), life: this.rnd(0.3, 0.55), spin: this.rnd(-4, 4),
          cell: S.DROP, r: 1.0, g: 0.045, b: 0.035, a: 0.9, gravity: 16, drag: 0.4,
        });
      }
    },

    /** A muzzle flash: a star at the muzzle plus a cone of hot gas down-range,
     *  and the dust a big gun kicks off the ground behind it. */
    muzzle: function (x, y, z, size, dirX, dirZ) {
      var s = Math.max(0.25, size);
      if (this.enc && (dirX || dirZ)) {
        // A PLUME, LAID ALONG THE BORE (K.MFLASH, oriented in `update`): a
        // rifle's or a machine gun's is a narrow tongue a couple of its own
        // widths long; a cannon with a muzzle brake throws the two side jets
        // as well. The round glow stays, small, at the muzzle itself.
        var dl = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1, ux = dirX / dl, uz = dirZ / dl;
        var big = s > 0.8, len = s * (big ? 3.1 : 2.7);
        this.spawn(K.MFLASH, { x: x + ux * len * 0.5, y: y, z: z + uz * len * 0.5, size: len * 0.42,
          stretch: 2.4, life: big ? 0.075 : 0.05, rot: 0, dx: ux, dz: uz, drag: 0,
          // ORANGE, with the white only where it is hottest (the shader mixes
          // toward white with heat): a muzzle flash is a white core in an
          // orange tongue. Tinted near-white it read as a white leaf.
          cell: big ? S.MBRAKE : (crand() < 0.5 ? S.MPLUME : S.MPLUME2), r: 1, g: 0.58, b: 0.24, a: 1 });
        this.spawn(K.FLASH, { x: x, y: y, z: z, size: s * 1.05, life: 0.045,
          cell: S.GLOW, r: 1, g: 0.66, b: 0.34, a: 0.75, grow: s * 2 });
        if (big) {
          this.smoke(x + ux * s, y, z + uz * s, 2, { scale: s * 0.6 });
          this.sparks(x, y, z, Math.round(3 * s), 0xffd090, s * 0.6);
        }
        return;
      }
      this.spawn(K.FLASH, { x: x, y: y, z: z, size: s * 2.4, life: 0.055,
        cell: S.STAR, r: 1, g: 0.94, b: 0.72, a: 1, grow: s * 6 });
      this.spawn(K.FIRE, { x: x, y: y, z: z, size: s * 1.5, life: 0.09, cell: S.GLOW,
        r: 1, g: 0.82, b: 0.45, a: 0.9, grow: -s * 4,
        vx: (dirX || 0) * s * 5, vz: (dirZ || 0) * s * 5 });
      if (s > 0.8) {
        this.smoke(x + (dirX || 0) * s, y, z + (dirZ || 0) * s, 2, { scale: s * 0.6 });
        this.sparks(x, y, z, Math.round(3 * s), 0xffd090, s * 0.6);
      }
    },

    /** The expanding pressure ring on the ground. One quad, laid flat. */
    shockwave: function (x, y, z, radius) {
      this.spawn(K.DUST, {
        x: x, y: y + 0.12, z: z, size: radius * 0.5, grow: radius * 5,
        life: 0.42, cell: S.RING, r: 1, g: 0.95, b: 0.85, a: 0.5, drag: 0,
      });
    },

    trail: function (x, y, z, o) {
      o = o || {};
      this.spawn(K.TRAIL, {
        x: x + this.rnd(-0.06, 0.06), y: y, z: z + this.rnd(-0.06, 0.06),
        vy: this.rnd(0.04, 0.2), size: o.size || this.rnd(0.35, 0.7),
        grow: o.grow === undefined ? 0.25 : o.grow, life: o.life || this.rnd(0.9, 2.0),
        spin: this.rnd(-0.2, 0.2), cell: o.cell === undefined ? S.WISP : o.cell,
        r: o.r === undefined ? 0.55 : o.r, g: o.g === undefined ? 0.55 : o.g, b: o.b === undefined ? 0.55 : o.b,
        a: o.a === undefined ? 0.3 : o.a, drag: 0.9,
      });
    },
  };

  // The authored effects take `K` about the point they were called at (see the
  // constructor). One that calls another (a muzzle's smoke, a burst's sparks)
  // keeps the outer call's point, so the whole picture shrinks as one.
  ['explosion', 'burst', 'fire', 'smoke', 'dust', 'sparks', 'streak', 'exhaust', 'jet', 'spray', 'debris',
   'blood', 'woundSpray', 'muzzle', 'shockwave', 'trail'].forEach(function (name) {
    var f = System.prototype[name];
    if (!f) return;
    System.prototype[name] = function (x, y, z) {
      if (this.K === 1 || this._fxD) return f.apply(this, arguments);
      this._fxD = 1; this._ox = x; this._oy = y; this._oz = z;
      try { return f.apply(this, arguments); } finally { this._fxD = 0; }
    };
  });

  // =========================================================================
  // PUBLIC API
  // =========================================================================
  window.VFX = {
    VERSION: VERSION,
    KIND: K,
    CELL: S,
    install: function (api) { THREE = api.THREE; installed = true; return true; },
    create: function (scene, opts) {
      if (!installed) throw new Error('VFX.install() must run before create()');
      return new System(scene, opts);
    },
  };
})();
