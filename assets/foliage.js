/* ===========================================================================
 * FOLIAGE — dense instanced ground cover  (TERRAIN_PLAN "Groundworks", Part 5)
 * ---------------------------------------------------------------------------
 * Tall grass, wheat, maize, scrub and bushes painted onto the battlefield with
 * a terrain brush, rendered as ONE InstancedMesh per streamed chunk.
 *
 * The whole design exists to satisfy one number: DRAW CALLS. A browser can push
 * a few million triangles a frame without complaining and falls over at a few
 * thousand draw calls, so every decision here trades triangles for batches.
 *
 *   1. ONE TEXTURE ATLAS for every foliage kind (4x2 cells, generated on a
 *      canvas at boot — no network, so file:// still works, same rule the sky
 *      and the terrain detail texture already follow). The atlas cell is a
 *      per-INSTANCE attribute, so grass, wheat and bushes standing in the same
 *      chunk are one batch, not three.
 *   2. CHUNKED so the frustum can throw work away. One InstancedMesh per
 *      CHUNK cells square; a mesh that isn't on screen costs nothing.
 *   3. STREAMED so memory is bounded by the VIEW, not by the map. Chunks build
 *      when the camera comes within `buildR` and are disposed past `dropR`.
 *      A 448-cell "Huge" map costs exactly what a 224 one does.
 *   4. FREE LOD. Instances inside a chunk are shuffled at build time, so any
 *      PREFIX of them is a uniform random sample of the whole. Distance LOD is
 *      then one integer write — `mesh.count = n * f` — with no buffer upload.
 *   5. ZERO PER-BLADE CPU. Camera-facing billboards, wind sway, the distance
 *      fade and the look-down canopy fade all happen in the vertex shader, fed
 *      by four uniforms. The per-frame CPU cost of 200,000 blades is one loop
 *      over ~200 chunk records.
 *   6. NO TRANSPARENCY SORTING. Alpha-TEST, not alpha-blend: foliage writes
 *      depth, renders in the opaque pass, and never needs to be sorted.
 *   7. NO SHADOW CASTING. Casting would double the batch count for a barely
 *      visible result; foliage RECEIVES shadow (a fragment-side lookup, free)
 *      so it still sits correctly inside a wood's shade.
 *
 * Gameplay: foliage is concealment, not armour. It feeds `_stealthMul` (spot
 * range), `_coverValue` (incoming fire) and an accumulating occlusion budget in
 * `hasLOS` — you can see a man two metres into a cornfield and not one twenty
 * metres in. It burns, and shellfire flattens it.
 *
 * Contract: this file must be optional. If it fails to load, or `install()` is
 * never called, the game runs exactly as it did before.
 * ======================================================================== */
(function () {
  'use strict';

  var VERSION = 1;
  var THREE = null;
  var G = null;          // injected game internals (GRID, TILE, HSCALE, helpers…)
  var installed = false;

  // ---- chunking / streaming knobs ----------------------------------------
  var CHUNK = 16;        // cells per chunk side (16*1.5 = 24 world units)
  var MAX_PER_CHUNK = 3600;
  var BUILDS_PER_FRAME = 3;
  // (round 107) …and no more than this many milliseconds of them in one frame
  // once one is built: a chunk is a quarter of the work it was (see `install`)
  // or four times it, and a count alone does not bound the frame.
  var BUILD_MS = 0.6;
  // (round 107) THE CHUNK AT TRUE SCALE, TWICE THE SIDE IT SHRANK TO. The
  // miniature's chunk shrank with its blades (see `install`) to keep a full
  // chunk under MAX_PER_CHUNK — 5 cells on a side, 8,100 of them on a 448
  // field, and at the playing distance each one a draw call for a few dozen
  // blades: 119 of a 232-call frame, 2.5 ms of render, and 8,100 chunks walked
  // every frame. Twice the side with four times the cap holds every blade.
  var CHUNK_GROW = 2;   // (3 was tried: a chunk build reached 2.2 ms and the field streamed in visibly late)
  // Seconds a new zoom band must hold before the field is rebuilt at its
  // density. See `_updateBand` — this is what stops a step onto a bunker roof
  // from blinking the whole meadow out.
  var BAND_DWELL = 0.9;
  // Ceiling on how many blades may exist across every built chunk at once.
  // Chunks are considered nearest-first, so when this bites it is always the
  // far edge of the field that goes without.
  var MAX_INSTANCES = 260000;
  // (round 108) SLOW EDITS ARE DRAWN A FEW TIMES A SECOND. A fire takes the
  // crop down a little every frame (`flatten(.., soft)`) and a tank's tracks
  // every cell it enters (`paint` with `slow`); each re-dirtied its chunk, so
  // a battle with a hundred fires in it rebuilt chunks continuously — the
  // whole build budget, every frame, and ~450 KB a frame of garbage. The
  // density they change is written at once (it is cover); only the blades
  // wait, at most this long. Shell bursts and the editor's brush do not.
  var SOFT_REBUILD_S = 0.75;
  // (round 108) A BLADE FROM THE STRATEGIC VIEW IS A CARD. From the two top
  // bands a tuft is one to four pixels, and the universal cross is six
  // triangles to draw it: each one that touches a pixel shades a 2x2 quad of
  // them, so the field cost what its TRIANGLES cost, nearly whatever the
  // resolution (2.4 ms at ratio 1 in a 1920 x 1080 window on an M1, 2.7 at
  // 1.5). From CARD_BAND up every blade is drawn as the card the bush kinds
  // already are — one quad, swung to face the camera — at the same place, the
  // same height and the same colour (the yaw a cross would have drawn is drawn
  // all the same, so the field's random stream does not move), a former cross
  // CARD_W wider so the field covers the same ground, CARD_TINT darker so it is
  // the same colour (both by measurement: the share of the screen the grass
  // covered, 21.31-21.36% crosses against 21.36-21.39% cards, and the frame's
  // mean colour the same to 0.03/255). It replaced drawing 0.6 of the blades on
  // a big field (`CROWD_GRASS`): cards at full density cost less than crosses
  // did at 0.6 (12.3 against 13.1-13.8 ms of GPU at ratio 1 in a 1920 x 1080
  // window, 2,000 men). `game.foliage.cardLod = false` draws the crosses again
  // (the field is rebuilt at its next band change).
  var CARD_BAND = 3, CARD_W = 1.46, CARD_TINT = 0.93;

  // ---- zoom bands ---------------------------------------------------------
  // The camera in this game lives at two completely different scales: an eye
  // 1.7 units off the ground in first person, and a strategic view 60+ units
  // up. A single set of LOD distances cannot serve both — tuned for the eye,
  // the field visibly stops halfway up the screen from above; tuned for the
  // strategic view, first person builds a quarter of a million blades you are
  // standing in the middle of and cannot see.
  //
  // So the radii scale with camera height and the DENSITY scales down by
  // roughly the square, which keeps the instance count near constant while the
  // covered area grows: from high up a blade is sub-pixel anyway, and what you
  // actually read is the colour of the mass, not the individuals.
  //
  // Banding (rather than a continuous scale) is what makes it affordable:
  // a density change invalidates every built chunk, so it must happen a
  // handful of times across the whole zoom range, not every frame. Each band
  // carries its own `enter` height and a lower `exit`, so hovering exactly on a
  // boundary cannot make the field rebuild itself forever.
  var BANDS = [
    { enter: 0,   exit: -1,  radius: 1.00, density: 1.00 },
    { enter: 15,  exit: 12,  radius: 1.85, density: 0.70 },
    { enter: 32,  exit: 27,  radius: 3.00, density: 0.44 },
    { enter: 58,  exit: 50,  radius: 4.40, density: 0.28 },
    { enter: 92,  exit: 80,  radius: 6.20, density: 0.18 },
  ];

  // =========================================================================
  // FOLIAGE KINDS
  // -------------------------------------------------------------------------
  //  atlas   index into the generated sprite atlas (0..7)
  //  mode    'cross' = 3 static intersecting quads (best for turf/crops)
  //          'card'  = 1 camera-facing billboard (best for round bushes)
  //  w / h   world size of one instance, and the +/- randomisation on it
  //  per     instances per cell at full density (the density knob scales this)
  //  sway    wind response, 0 = rigid
  //  topFade how much the sprite thins out when the camera looks straight down
  //          (a cornfield you can't see your own men through is a bad cornfield)
  //  cover   fraction of incoming fire negated at full density
  //  conceal reduction of the range at which the enemy spots you
  //  los     occlusion units per cell of sightline at full density; the ray in
  //          hasLOS accumulates these and cuts off past `LOS_BUDGET`
  //  height  world height of the concealing mass (a sightline above it is clear)
  //  burn    catches fire from flame / HE
  // =========================================================================
  var DEFS = [
    { id: 'grass',     name: 'Meadow grass', atlas: 0, mode: 'cross', w: 1.45, h: 0.46, vary: 0.34,
      per: 7, sway: 0.16, topFade: 0.00, cover: 0.05, conceal: 0.06, los: 0.00, height: 0.5,
      burn: true,  tint: [0x5f7a38, 0x486b2f, 0x6c8340], swatch: '#5f7a38' },

    { id: 'tallgrass', name: 'Tall grass',   atlas: 1, mode: 'cross', w: 1.55, h: 1.40, vary: 0.36,
      per: 6,  sway: 0.30, topFade: 0.30, cover: 0.16, conceal: 0.30, los: 0.55, height: 1.2,
      burn: true,  tint: [0x6d7a3c, 0x7d8544, 0x5d6c33], swatch: '#6d7a3c' },

    { id: 'wheat',     name: 'Wheat field',  atlas: 2, mode: 'cross', w: 1.35, h: 1.50, vary: 0.20,
      per: 7,  sway: 0.34, topFade: 0.34, cover: 0.16, conceal: 0.34, los: 0.62, height: 1.3,
      burn: true,  tint: [0xb9a94f, 0xc8b85c, 0xa89642], swatch: '#b9a94f' },

    { id: 'corn',      name: 'Maize (corn)', atlas: 3, mode: 'cross', w: 1.45, h: 2.30, vary: 0.18,
      per: 5,  sway: 0.22, topFade: 0.55, cover: 0.22, conceal: 0.52, los: 1.05, height: 2.1,
      burn: true,  tint: [0x4f7a30, 0x5d8636, 0x44692a], swatch: '#4f7a30' },

    { id: 'brush',     name: 'Low brush',    atlas: 4, mode: 'card',  w: 2.10, h: 1.50, vary: 0.32,
      per: 2.4,  sway: 0.12, topFade: 0.18, cover: 0.26, conceal: 0.36, los: 0.80, height: 1.1,
      burn: true,  tint: [0x40592c, 0x4a6531, 0x374d26], swatch: '#40592c' },

    { id: 'fern',      name: 'Bracken',      atlas: 5, mode: 'cross', w: 1.70, h: 1.15, vary: 0.28,
      per: 4.5,  sway: 0.18, topFade: 0.10, cover: 0.14, conceal: 0.24, los: 0.35, height: 0.9,
      burn: true,  tint: [0x3f6330, 0x4c7137, 0x35562a], swatch: '#3f6330' },

    { id: 'reeds',     name: 'Reeds',        atlas: 6, mode: 'cross', w: 1.15, h: 1.85, vary: 0.28,
      per: 6,  sway: 0.42, topFade: 0.38, cover: 0.12, conceal: 0.42, los: 0.75, height: 1.6,
      burn: false, tint: [0x6f7d45, 0x7d8a4d, 0x5f6d3c], swatch: '#6f7d45' },

    { id: 'heather',   name: 'Heather',      atlas: 7, mode: 'cross', w: 1.35, h: 0.72, vary: 0.28,
      per: 5,  sway: 0.14, topFade: 0.00, cover: 0.07, conceal: 0.12, los: 0.00, height: 0.5,
      burn: true,  tint: [0x6a5f7a, 0x7a6c86, 0x5a5568], swatch: '#6a5f7a' },
  ];
  /** Below this standing height a plant throws no shadow worth the pass — see
   *  `Field._casts`. Meadow grass (0.5) and heather (0.5) are under it;
   *  bracken (0.9) are under it; brush (1.1), tall grass (1.2), wheat (1.3),
   *  reeds (1.6) and maize (2.1) are over. The main file's `PROP_SHADOW_MIN`
   *  is the same rule for scenery, one notch higher because a prop's listed
   *  height is its silhouette and a plant's is its concealing mass. */
  var SHADOW_MIN = 1.05;

  var BY_ID = {};
  for (var di = 0; di < DEFS.length; di++) { DEFS[di].index = di; BY_ID[DEFS[di].id] = DEFS[di]; }

  // Sightline occlusion needed to break line of sight completely. Tuned so a
  // man is invisible ~9 m into standing corn and ~14 m into wheat.
  var LOS_BUDGET = 3.2;

  // ---- quality tiers ------------------------------------------------------
  // `density` scales instances per cell; `fadeFar` is the world distance at
  // which an instance has shrunk to nothing; `buildR` the streaming radius.
  // These are the EYE-LEVEL numbers; the zoom band multiplies them.
  var QUALITY = {
    off:    { density: 0.00, fadeNear: 0,  fadeFar: 0,   buildR: 0,   label: 'Off' },
    low:    { density: 0.35, fadeNear: 20, fadeFar: 48,  buildR: 70,  label: 'Low' },
    medium: { density: 0.60, fadeNear: 30, fadeFar: 72,  buildR: 100, label: 'Medium' },
    high:   { density: 1.00, fadeNear: 42, fadeFar: 100, buildR: 138, label: 'High' },
    ultra:  { density: 1.55, fadeNear: 58, fadeFar: 140, buildR: 190, label: 'Ultra' },
  };

  // =========================================================================
  // SPRITE ATLAS — drawn on a canvas at boot, so there is nothing to download
  // =========================================================================
  // 4 columns x 2 rows of 256px cells in a 1024x512 texture. Every sprite is
  // drawn inside a padded box so mip generation never bleeds one cell into its
  // neighbour at the levels foliage is actually visible at.
  var ATLAS_COLS = 4, ATLAS_ROWS = 2, ATLAS_CELL = 256, ATLAS_PAD = 10;

  function rngFrom(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  /** `rngFrom`'s mulberry32 with its state in `S[0]` (an Int32Array) — the
   *  same draws for the same seed. A closure's seed is a context slot, and an
   *  int32 too big for a small integer is boxed on every store; the chunk
   *  build made one per cell and drew a few thousand times a chunk. */
  function rngNext(S) {
    var s = S[0] = S[0] + 0x6D2B79F5 | 0;
    var t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  /** One tapered, curving blade rising from (x0, y0). */
  function blade(ctx, x0, y0, len, wid, lean, curve, col) {
    var tipX = x0 + lean, tipY = y0 - len;
    var cx = x0 + curve, cy = y0 - len * 0.55;
    ctx.beginPath();
    ctx.moveTo(x0 - wid, y0);
    ctx.quadraticCurveTo(cx - wid * 0.5, cy, tipX, tipY);
    ctx.quadraticCurveTo(cx + wid * 0.5, cy, x0 + wid, y0);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
  }

  function shade(base, k) {
    var r = (base >> 16 & 255), g = (base >> 8 & 255), b = base & 255;
    r = Math.max(0, Math.min(255, Math.round(r * k)));
    g = Math.max(0, Math.min(255, Math.round(g * k)));
    b = Math.max(0, Math.min(255, Math.round(b * k)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawSprite(ctx, kind, S, R) {
    var base = S - ATLAS_PAD;          // ground line
    var W = S, half = W / 2;
    var i, n, x, len;
    ctx.lineCap = 'round';

    if (kind === 0 || kind === 1) {                       // grass / tall grass
      var tall = kind === 1;
      n = tall ? 22 : 34;
      var GREEN = tall ? 0x7f8c45 : 0x5d7a34;
      for (i = 0; i < n; i++) {
        x = ATLAS_PAD + R() * (W - ATLAS_PAD * 2);
        len = (tall ? 0.62 : 0.44) * base * (0.55 + R() * 0.75);
        var lean = (R() - 0.5) * len * 0.55;
        blade(ctx, x, base + R() * 6, len, 3 + R() * 4.5, lean, lean * 0.4, shade(GREEN, 0.72 + R() * 0.62));
        if (tall && R() < 0.5) {                          // seed head
          ctx.beginPath();
          ctx.ellipse(x + lean, base - len, 3.5, 11, lean * 0.03, 0, 6.283);
          ctx.fillStyle = shade(0x9a9350, 0.8 + R() * 0.5); ctx.fill();
        }
      }
    } else if (kind === 2) {                              // wheat
      for (i = 0; i < 20; i++) {
        x = ATLAS_PAD + R() * (W - ATLAS_PAD * 2);
        len = 0.70 * base * (0.7 + R() * 0.5);
        var ln = (R() - 0.5) * len * 0.30;
        blade(ctx, x, base + R() * 5, len, 2.2 + R() * 2, ln, ln * 0.5, shade(0xb2a458, 0.75 + R() * 0.55));
        // the ear: a stack of grains, drooping with the stalk
        var ex = x + ln, ey = base - len;
        for (var k = 0; k < 7; k++) {
          ctx.beginPath();
          ctx.ellipse(ex + ln * 0.06 * k, ey + k * 6.5, 4.6, 4.0, ln * 0.02, 0, 6.283);
          ctx.fillStyle = shade(0xd4c168, 0.72 + R() * 0.5); ctx.fill();
        }
      }
    } else if (kind === 3) {                              // maize / corn
      for (i = 0; i < 4; i++) {
        var sx = half + (i - 1.5) * (W * 0.24) + (R() - 0.5) * 14;
        var sh = base * (0.88 + R() * 0.12);
        ctx.beginPath();                                  // stalk
        ctx.moveTo(sx - 4, base); ctx.lineTo(sx - 2.4, base - sh);
        ctx.lineTo(sx + 2.4, base - sh); ctx.lineTo(sx + 4, base);
        ctx.closePath();
        ctx.fillStyle = shade(0x54792f, 0.85 + R() * 0.3); ctx.fill();
        for (var l = 0; l < 6; l++) {                     // broad drooping leaves
          var ly = base - sh * (0.22 + l * 0.13);
          var dir = (l % 2 ? 1 : -1) * (1 + R() * 0.3);
          var lw = W * (0.20 + R() * 0.13) * dir;
          ctx.beginPath();
          ctx.moveTo(sx, ly);
          ctx.quadraticCurveTo(sx + lw * 0.6, ly - 22, sx + lw, ly + 16);
          ctx.quadraticCurveTo(sx + lw * 0.55, ly - 4, sx, ly + 7);
          ctx.closePath();
          ctx.fillStyle = shade(0x4d7a2c, 0.7 + R() * 0.62); ctx.fill();
        }
        if (R() < 0.8) {                                  // tassel
          for (var t = 0; t < 5; t++) {
            ctx.strokeStyle = shade(0xa8a35c, 0.8 + R() * 0.4);
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(sx, base - sh);
            ctx.quadraticCurveTo(sx + (t - 2) * 6, base - sh - 16, sx + (t - 2) * 13, base - sh - 26);
            ctx.stroke();
          }
        }
      }
    } else if (kind === 4) {                              // low brush / bush
      // A dome of overlapping leaf clusters, densest at the base.
      for (i = 0; i < 190; i++) {
        var a = R() * Math.PI * 2, rr = Math.pow(R(), 0.62);
        var bx = half + Math.cos(a) * rr * (half - ATLAS_PAD) * 0.98;
        var by = base - Math.abs(Math.sin(a)) * rr * (base - ATLAS_PAD) * 0.94 - R() * 10;
        var rad = 7 + R() * 13;
        ctx.beginPath();
        ctx.ellipse(bx, by, rad, rad * (0.6 + R() * 0.4), R() * 3.14, 0, 6.283);
        // darker toward the middle so it reads as volume, not a flat blob
        var depth = 0.55 + 0.6 * (1 - rr);
        ctx.fillStyle = shade(0x3f5b2a, 1.35 - depth * 0.62);
        ctx.fill();
      }
      for (i = 0; i < 8; i++) {                           // a few bare twigs
        ctx.strokeStyle = 'rgba(58,44,30,0.75)'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(half, base);
        ctx.lineTo(half + (R() - 0.5) * W * 0.5, base - R() * base * 0.7); ctx.stroke();
      }
    } else if (kind === 5) {                              // bracken / fern
      for (i = 0; i < 11; i++) {
        var fa = -Math.PI / 2 + (R() - 0.5) * 1.5;
        var flen = base * (0.55 + R() * 0.4);
        var fx = half + (R() - 0.5) * W * 0.55;
        ctx.strokeStyle = shade(0x3f6330, 0.8 + R() * 0.4); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(fx, base);
        var tx = fx + Math.cos(fa) * flen, ty = base + Math.sin(fa) * flen;
        ctx.quadraticCurveTo(fx + Math.cos(fa) * flen * 0.5, base + Math.sin(fa) * flen * 0.65, tx, ty);
        ctx.stroke();
        for (var p = 1; p < 9; p++) {                     // pinnae down each frond
          var pt = p / 9;
          var px = fx + (tx - fx) * pt, py = base + (ty - base) * pt;
          var plen = 26 * (1 - pt * 0.75);
          for (var sgn = -1; sgn <= 1; sgn += 2) {
            ctx.strokeStyle = shade(0x477134, 0.75 + R() * 0.5); ctx.lineWidth = 2.6;
            ctx.beginPath(); ctx.moveTo(px, py);
            ctx.lineTo(px + sgn * plen, py - plen * 0.45); ctx.stroke();
          }
        }
      }
    } else if (kind === 6) {                              // reeds
      for (i = 0; i < 17; i++) {
        x = ATLAS_PAD + R() * (W - ATLAS_PAD * 2);
        len = base * (0.7 + R() * 0.3);
        var rl = (R() - 0.5) * 20;
        blade(ctx, x, base, len, 2.6 + R() * 1.6, rl, rl * 0.3, shade(0x74814a, 0.75 + R() * 0.5));
        if (R() < 0.55) {                                 // brown seed spike
          ctx.beginPath();
          ctx.ellipse(x + rl, base - len - 6, 4.2, 17, rl * 0.02, 0, 6.283);
          ctx.fillStyle = shade(0x6b4a2c, 0.8 + R() * 0.45); ctx.fill();
        }
      }
    } else {                                              // heather / flowers
      for (i = 0; i < 34; i++) {
        x = ATLAS_PAD + R() * (W - ATLAS_PAD * 2);
        len = 0.4 * base * (0.5 + R() * 0.7);
        blade(ctx, x, base, len, 3 + R() * 3, (R() - 0.5) * 12, 0, shade(0x53663a, 0.7 + R() * 0.6));
      }
      for (i = 0; i < 34; i++) {                          // blossom
        var bx2 = ATLAS_PAD + R() * (W - ATLAS_PAD * 2);
        var by2 = base - R() * base * 0.42;
        ctx.beginPath(); ctx.arc(bx2, by2, 3 + R() * 4, 0, 6.283);
        ctx.fillStyle = shade(R() < 0.7 ? 0x8f6f9e : 0xc08fb0, 0.8 + R() * 0.5);
        ctx.fill();
      }
    }
  }

  var _atlas = null;
  function atlasTexture() {
    if (_atlas) return _atlas;
    var cv = document.createElement('canvas');
    cv.width = ATLAS_COLS * ATLAS_CELL;
    cv.height = ATLAS_ROWS * ATLAS_CELL;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (var k = 0; k < ATLAS_COLS * ATLAS_ROWS; k++) {
      var cx = (k % ATLAS_COLS) * ATLAS_CELL, cy = Math.floor(k / ATLAS_COLS) * ATLAS_CELL;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath(); ctx.rect(0, 0, ATLAS_CELL, ATLAS_CELL); ctx.clip();
      drawSprite(ctx, k, ATLAS_CELL, rngFrom(1337 + k * 7919));
      ctx.restore();
    }
    _atlas = new THREE.CanvasTexture(cv);
    _atlas.wrapS = _atlas.wrapT = THREE.ClampToEdgeWrapping;
    _atlas.magFilter = THREE.LinearFilter;
    _atlas.minFilter = THREE.LinearMipmapLinearFilter;
    _atlas.generateMipmaps = true;
    _atlas.anisotropy = 4;
    return _atlas;
  }

  // =========================================================================
  // GEOMETRY — the universal 3-quad cross
  // =========================================================================
  // Every kind shares this. A 'card' instance collapses quads 1 and 2 in the
  // vertex shader and swings quad 0 to face the camera, so both render modes
  // live in one batch. Normals point straight up: foliage lit like turf rather
  // than like cardboard, and it never goes black when the sun is behind it.
  var _geo = null;
  function crossGeometry() {
    if (_geo) return _geo;
    var pos = [], uv = [], nrm = [], quad = [], idx = [];
    for (var q = 0; q < 3; q++) {
      var a = q * Math.PI / 3;                 // 0, 60, 120 degrees
      var cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
      var v0 = pos.length / 3;
      //        x            y   z            u  v
      pos.push(-cx, 0, -cz,  cx, 0, cz,  cx, 1, cz,  -cx, 1, -cz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      quad.push(q, q, q, q);
      idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }
    _geo = new THREE.BufferGeometry();
    _geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    _geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    _geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    _geo.setAttribute('aQuad', new THREE.Float32BufferAttribute(quad, 1));
    _geo.setIndex(idx);
    return _geo;
  }

  /** (round 108) CARD_BAND: quad 0 of the cross alone — four vertices, two
   *  triangles — the quad a card instance keeps. */
  var _cardGeo = null;
  function cardGeometry() {
    if (_cardGeo) return _cardGeo;
    var g = crossGeometry(), out = new THREE.BufferGeometry();
    for (var name in g.attributes) {
      var a = g.attributes[name];
      out.setAttribute(name, new THREE.Float32BufferAttribute(Array.prototype.slice.call(a.array, 0, 4 * a.itemSize), a.itemSize));
    }
    out.setIndex([0, 1, 2, 0, 2, 3]);
    return (_cardGeo = out);
  }

  // =========================================================================
  // MATERIAL — MeshLambertMaterial + an onBeforeCompile patch
  // =========================================================================
  // Everything that would otherwise be per-blade CPU work lives in here:
  // atlas UV selection, camera-facing billboards, wind, distance LOD and the
  // look-down canopy fade. Six uniforms drive 200,000 blades.
  //
  // r128 note: this patches the stock chunks `<common>`, `<uv_vertex>` and
  // `<begin_vertex>` in the vertex program and `<map_fragment>` in the
  // fragment program. If a Three.js bump renames them the patch simply does
  // nothing (String.replace is a no-op on a miss) and the foliage renders as
  // static, untinted, unbending sprites — ugly, never broken. `_patchOk`
  // records whether every anchor was found so the caller can warn once.
  var _patchOk = true;

  function makeMaterial(shared) {
    var mat = new THREE.MeshLambertMaterial({
      map: atlasTexture(),
      // Alpha TEST, not blend: opaque pass, writes depth, never needs sorting.
      // Kept low because mipmapping shrinks a thin blade's coverage as it
      // recedes — cut too hard and a distant field dissolves into the few
      // darkest pixels of each sprite, which reads as grit on the lens.
      alphaTest: 0.26,
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: true,
    });
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = shared.uTime;
      sh.uniforms.uWind = shared.uWind;         // vec4(dirX, dirZ, amp, speed)
      sh.uniforms.uFade = shared.uFade;         // vec2(near, far)
      sh.uniforms.uAtlas = shared.uAtlas;       // vec2(1/cols, 1/rows)
      sh.uniforms.uHealth = shared.uHealth;     // global scale (burnt fields wilt)
      sh.uniforms.uCam = shared.uCam;           // NOT `cameraPosition` — see below
      // CLOUD SHADOW. The field is the largest single surface in any frame and
      // it was the last one still in full sun under a cloud that was shading
      // the ground it grows out of. The game hands its own uniform objects in
      // through `setCloud`; standing alone, these are zeroed and the branch in
      // the shader costs a compare.
      sh.uniforms.uCloud = shared.uCloud;
      sh.uniforms.uCloudBand = shared.uCloudBand;

      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }

      sh.vertexShader = rep(sh.vertexShader, '#include <common>', [
        '#include <common>',
        'attribute float aQuad;',
        'attribute vec2  aAtlas;',
        'attribute vec3  aTint;',
        'attribute vec3  aFlags;',     // x = card(1)/cross(0), y = sway, z = topFade
        'uniform float uTime;',
        'uniform vec4  uWind;',
        'uniform vec2  uFade;',
        'uniform vec2  uAtlas;',
        'uniform float uHealth;',
        // Three.js uploads the built-in `cameraPosition` only for ShaderMaterial,
        // Phong, Toon, Standard and anything with an envMap. A Lambert material
        // gets a permanent (0,0,0) — so this carries the eye position instead.
        'uniform vec3  uCam;',
        'uniform vec4  uCloud;',      // xy drift, z scale, w depth
        'uniform vec2  uCloudBand;',
        'varying vec3  vFolTint;',
        'varying float vFolAlpha;',
        'varying float vFolSun;',
        // PER INSTANCE, NOT PER FRAGMENT. A cloud shadow varies over a hundred
        // and thirty world units and a blade of grass is a tenth of one, so
        // there is nothing to gain from evaluating the noise per pixel — and
        // two hundred thousand blades is exactly where that would be felt.
        // Same noise and the same band as the terrain (`CLOUD_GLSL_F` in the
        // main file) so the shadow crossing a hedge does not step.
        'float folHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
        'float folNoise(vec2 p) {',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  float a = folHash(i), b = folHash(i + vec2(1.0, 0.0));',
        '  float c = folHash(i + vec2(0.0, 1.0)), d = folHash(i + vec2(1.0, 1.0));',
        '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
        '}',
      ].join('\n'));

      // Atlas cell selection replaces the stock UV transform entirely.
      sh.vertexShader = rep(sh.vertexShader, '#include <uv_vertex>',
        'vUv = uv * uAtlas + aAtlas;');

      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>', [
        'vec3 transformed = vec3( position );',
        '#ifdef USE_INSTANCING',
        '  vec3 iPos = instanceMatrix[3].xyz;',
        '  vec3 iAxX = instanceMatrix[0].xyz;',
        '  vec3 iAxZ = instanceMatrix[2].xyz;',
        '  float sX  = max(length(iAxX), 1e-4);',
        '  float sZ  = max(length(iAxZ), 1e-4);',
        '  iAxX /= sX; iAxZ /= sZ;',
        // -- billboard: swing quad 0 to face the camera, collapse 1 and 2 -----
        '  if (aFlags.x > 0.5) {',
        '    if (aQuad > 0.5) { transformed = vec3(0.0); }',
        '    else {',
        '      vec3 toCam = uCam - iPos;',
        '      float ba = atan(toCam.x, toCam.z);',
        '      float bs = sin(ba), bc = cos(ba);',
        '      transformed.xz = vec2(bc * transformed.x + bs * transformed.z,',
        '                           -bs * transformed.x + bc * transformed.z);',
        '    }',
        '  }',
        // -- distance LOD: sink into the ground rather than pop out ----------
        '  float dCam = distance(uCam, iPos);',
        '  float lod  = 1.0 - smoothstep(uFade.x, uFade.y, dCam);',
        '  transformed.y *= lod * uHealth;',
        // -- wind: a world-space gust, expressed in instance-local axes ------
        '  float bend = uv.y * uv.y;',
        '  float ph   = iPos.x * 0.28 + iPos.z * 0.21;',
        '  float g    = sin(uTime * uWind.w + ph) + 0.45 * sin(uTime * uWind.w * 2.7 + ph * 1.9);',
        '  vec2  Wv   = uWind.xy * (uWind.z * aFlags.y * g);',
        '  transformed.x += (Wv.x * iAxX.x + Wv.y * iAxX.z) * bend / sX;',
        '  transformed.z += (Wv.x * iAxZ.x + Wv.y * iAxZ.z) * bend / sZ;',
        // -- looking straight down thins the canopy so you can see your men --
        '  float elev = clamp((uCam.y - iPos.y) / max(dCam, 0.001), 0.0, 1.0);',
        '  vFolAlpha = 1.0 - aFlags.z * elev * uv.y;',
        '  vFolTint  = aTint;',
        '  if (uCloud.w <= 0.001) { vFolSun = 1.0; } else {',
        '    vec2 cp = iPos.xz * uCloud.z + uCloud.xy;',
        '    float cn = folNoise(cp) * 0.62 + folNoise(cp * 2.17 + 11.3) * 0.38;',
        '    vFolSun = 1.0 - uCloud.w * smoothstep(uCloudBand.x, uCloudBand.y, cn);',
        '  }',
        '#else',
        '  vFolAlpha = 1.0; vFolTint = aTint; vFolSun = 1.0;',
        '#endif',
      ].join('\n'));

      // A leaf card has no back. MeshLambertMaterial computes double-sided
      // lighting in the vertex shader and lights the BACK face from the
      // INVERTED normal — so with an up-facing normal, every blade you happen
      // to be looking at from behind is lit from underground and renders black.
      // That is roughly half of them, and it is why untreated instanced foliage
      // looks like a field of soot. Light both faces the same way instead.
      sh.vertexShader = rep(sh.vertexShader, '#include <lights_lambert_vertex>', [
        '#include <lights_lambert_vertex>',
        '#ifdef DOUBLE_SIDED',
        '  vLightBack = vLightFront;',
        '  vIndirectBack = vIndirectFront;',
        '#endif',
      ].join('\n'));

      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>', [
        '#include <common>',
        'varying vec3  vFolTint;',
        'varying float vFolAlpha;',
        'varying float vFolSun;',
      ].join('\n'));

      sh.fragmentShader = rep(sh.fragmentShader, '#include <map_fragment>', [
        '#include <map_fragment>',
        'diffuseColor.rgb *= vFolTint;',
        'diffuseColor.a   *= vFolAlpha;',
      ].join('\n'));

      // …and the shade goes on the LIGHT, before the fog, the same place the
      // terrain applies it. Lambert has no tone-mapping chunk of its own in
      // this configuration, so `<fog_fragment>` is the anchor.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <fog_fragment>', [
        'gl_FragColor.rgb *= vFolSun;',
        '#include <fog_fragment>',
      ].join('\n'));

      // (round 108) THE GRASS'S SHADOW IN ONE TAP. The stock lookup is
      // three's soft PCF — sixteen depth reads and unpacks for every fragment
      // — and grass is alpha-cut, many blades deep, over most of the screen:
      // measured in a 2,000-man fight on an M1 at a Retina canvas, the field
      // cost 3.4 ms of GPU a frame and 1.4 of it was this lookup. A blade is a
      // few pixels of noise; a soft shadow edge across it is not something
      // anybody can see, and a hard one reads the same. One read, the same
      // bias, the same frustum test (`shared.oneTapShadow = false` is the
      // stock lookup, for an A/B; the cache key carries it).
      if (shared.oneTapShadow !== false && sh.fragmentShader.indexOf('* getShadowMask();') >= 0
          && sh.fragmentShader.indexOf('#include <shadowmask_pars_fragment>') >= 0) {
        sh.fragmentShader = sh.fragmentShader.replace('#include <shadowmask_pars_fragment>', [
          '#include <shadowmask_pars_fragment>',
          'float folShadowMask() {',
          '  float shadow = 1.0;',
          '  #ifdef USE_SHADOWMAP',
          '  #if NUM_DIR_LIGHT_SHADOWS > 0',
          '  DirectionalLightShadow folDL;',
          '  #pragma unroll_loop_start',
          '  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {',
          '    folDL = directionalLightShadows[ i ];',
          '    vec4 sc = vDirectionalShadowCoord[ i ];',
          '    sc.xyz /= sc.w; sc.z += folDL.shadowBias;',
          '    bool inF = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0;',
          '    shadow *= ( receiveShadow && inF ) ? texture2DCompare( directionalShadowMap[ i ], sc.xy, sc.z ) : 1.0;',
          '  }',
          '  #pragma unroll_loop_end',
          '  #endif',
          '  #endif',
          '  return shadow;',
          '}',
        ].join('\n')).replace('* getShadowMask();', '* folShadowMask();');
      }

      if (!ok) _patchOk = false;
    };
    // Two materials with the same `onBeforeCompile` source still compile twice
    // unless they share a cache key. One material for the whole field anyway,
    // but be explicit about it.
    mat.customProgramCacheKey = function () { return 'foliage1' + (shared.oneTapShadow === false ? '' : '|1tap'); };
    return mat;
  }

  // =========================================================================
  // THE SHADOW A BLADE CASTS IS THE BLADE, NOT THE QUAD IT IS PAINTED ON
  // =========================================================================
  // Every blade is a 3-quad cross with an alpha-cut leaf painted on it. The
  // COLOUR pass cuts the alpha and you see grass. The SHADOW pass is a separate
  // program — Three.js builds a MeshDepthMaterial of its own — and it was given
  // neither the atlas nor the cutout, so each blade cast three SOLID QUADS.
  // Three solid quads at sixty degrees to each other is an asterisk, and that
  // is exactly what was on the ground: hundreds of hard black stars scattered
  // over open grass, one per blade, worst on the tall crops because a corn
  // sprite is 5.8 m wide and 9.2 m tall.
  //
  // Measured on Default (mixed), a fixed camera, counting the pixels the field
  // darkens against a frame with foliage shadows off:
  //
  //      alphaTest 0.26 -> 6.52% of frame       alphaTest 0.95 -> 6.49%
  //
  // …which is the proof: cutting away three quarters of every leaf changed the
  // shadow by nothing at all, because the shadow had never looked at the leaf.
  // With this depth material the same frame reads 3.77% — a 42% reduction, and
  // what is left is leaf-shaped.
  //
  // The vertex half MUST match the colour pass or the shadow detaches from the
  // blade that casts it: same atlas cell, same billboard swing, same distance
  // LOD, same wind. The parts that only affect COLOUR — the tint, the cloud
  // shade, the look-down canopy fade — are left out, because a depth pass has
  // nowhere to put them and a binary cutout cannot express a partial fade.
  function makeDepthMaterial(shared) {
    var dm = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: atlasTexture(),
      alphaTest: 0.26,        // the colour pass's value; see makeMaterial
      side: THREE.DoubleSide,
    });
    dm.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = shared.uTime;
      sh.uniforms.uWind = shared.uWind;
      sh.uniforms.uFade = shared.uFade;
      sh.uniforms.uAtlas = shared.uAtlas;
      sh.uniforms.uHealth = shared.uHealth;
      sh.uniforms.uCam = shared.uCam;
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, '#include <common>', [
        '#include <common>',
        'attribute float aQuad;',
        'attribute vec2  aAtlas;',
        'attribute vec3  aFlags;',
        'uniform float uTime;',
        'uniform vec4  uWind;',
        'uniform vec2  uFade;',
        'uniform vec2  uAtlas;',
        'uniform float uHealth;',
        'uniform vec3  uCam;',
      ].join('\n'));
      // The atlas cell, exactly as the colour pass picks it — otherwise the
      // cutout tests the wrong sprite and the shadow is some other plant's.
      sh.vertexShader = rep(sh.vertexShader, '#include <uv_vertex>',
        'vUv = uv * uAtlas + aAtlas;');
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>', [
        'vec3 transformed = vec3( position );',
        '#ifdef USE_INSTANCING',
        '  vec3 iPos = instanceMatrix[3].xyz;',
        '  vec3 iAxX = instanceMatrix[0].xyz;',
        '  vec3 iAxZ = instanceMatrix[2].xyz;',
        '  float sX  = max(length(iAxX), 1e-4);',
        '  float sZ  = max(length(iAxZ), 1e-4);',
        '  iAxX /= sX; iAxZ /= sZ;',
        '  if (aFlags.x > 0.5) {',
        '    if (aQuad > 0.5) { transformed = vec3(0.0); }',
        '    else {',
        '      vec3 toCam = uCam - iPos;',
        '      float ba = atan(toCam.x, toCam.z);',
        '      float bs = sin(ba), bc = cos(ba);',
        '      transformed.xz = vec2(bc * transformed.x + bs * transformed.z,',
        '                           -bs * transformed.x + bc * transformed.z);',
        '    }',
        '  }',
        '  float dCam = distance(uCam, iPos);',
        '  float lod  = 1.0 - smoothstep(uFade.x, uFade.y, dCam);',
        '  transformed.y *= lod * uHealth;',
        '  float bend = uv.y * uv.y;',
        '  float ph   = iPos.x * 0.28 + iPos.z * 0.21;',
        '  float g    = sin(uTime * uWind.w + ph) + 0.45 * sin(uTime * uWind.w * 2.7 + ph * 1.9);',
        '  vec2  Wv   = uWind.xy * (uWind.z * aFlags.y * g);',
        '  transformed.x += (Wv.x * iAxX.x + Wv.y * iAxX.z) * bend / sX;',
        '  transformed.z += (Wv.x * iAxZ.x + Wv.y * iAxZ.z) * bend / sZ;',
        '#endif',
      ].join('\n'));
      if (!ok) _patchOk = false;
    };
    dm.customProgramCacheKey = function () { return 'foliageDepth1'; };
    return dm;
  }

  // =========================================================================
  // THE FIELD
  // =========================================================================
  function Field(scene, terrain, opts) {
    opts = opts || {};
    this.scene = scene;
    this.terrain = terrain;
    this.enabled = true;
    this.N = G.GRID * G.GRID;

    // Per-cell authoring data. `kind` is 1-based (0 = bare ground) so a zeroed
    // array is an empty map; `dens` is 0..255 mapping to 0..1.
    this.kind = new Uint8Array(this.N);
    this.dens = new Uint8Array(this.N);

    this.cw = Math.ceil(G.GRID / CHUNK);
    this.chunks = new Array(this.cw * this.cw);
    for (var cz = 0; cz < this.cw; cz++) for (var cx = 0; cx < this.cw; cx++) {
      this.chunks[cz * this.cw + cx] = {
        cx: cx, cz: cz, mesh: null, n: 0, dirty: false, empty: true,
        wx: (cx * CHUNK + CHUNK / 2 - G.GRID / 2) * G.TILE,
        wz: (cz * CHUNK + CHUNK / 2 - G.GRID / 2) * G.TILE,
        wy: 0, radius: CHUNK * G.TILE * 0.75,
      };
    }
    this.dirtyList = [];
    this.softList = [];        // (round 108) see SOFT_REBUILD_S
    this._softT = 0;
    this._rngS = new Int32Array(1);

    this.shared = {
      uTime:   { value: 0 },
      uWind:   { value: new THREE.Vector4(1, 0, 0.16, 1.1) },
      uFade:   { value: new THREE.Vector2(38, 88) },
      uAtlas:  { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) },
      uHealth: { value: 1 },
      uCam:    { value: new THREE.Vector3() },
      // Zeroed depth = no cloud. `setCloud` swaps in the game's own uniform
      // objects so the field, the ground and the men are shaded by ONE number.
      uCloud:     { value: new THREE.Vector4(0, 0, 0.0075, 0) },
      uCloudBand: { value: new THREE.Vector2(0.52, 0.80) },
    };
    this.material = makeMaterial(this.shared);
    // One depth material for the whole field, same as the colour one. It is
    // what makes a blade's shadow leaf-shaped; see makeDepthMaterial.
    this.depthMaterial = makeDepthMaterial(this.shared);
    this.geometry = crossGeometry();
    this.cardGeometry = cardGeometry();   // (round 108) CARD_BAND

    this.group = new THREE.Group();
    this.group.name = 'foliage';
    this.group.matrixAutoUpdate = false;      // stays at the origin forever
    scene.add(this.group);

    this.band = 0;
    this._groundY = 0;      // terrain height under the camera, for the zoom band
    this._bandWant = 0;     // band the height is asking for…
    this._bandT = 0;        // …and how long it has been asking (see _updateBand)
    // ---- SHADOW BAND ------------------------------------------------------
    // Every blade, bush and hedge in the game used to cast nothing. The note
    // that turned it off said "doubling the batch count buys ~nothing", and
    // that was measured on the wrong thing: it buys the darkest mass in the
    // frame. Measured on Ruined Town, the 1st percentile of image luminance
    // went 53 → 38 and the 10th 84 → 72 the moment the hedgerows started
    // casting — on a field whose whole image had been living between 108 and
    // 206, which is why it read as a bleached model kit.
    //
    // The reason to keep it BANDED rather than simply on: the sun's shadow
    // camera only covers ±`shadowSpan` world units around the view focus, so a
    // chunk outside that box contributes nothing to the shadow map and costs a
    // draw call to prove it. Measured at 273 units: 15 chunks casting instead
    // of 576, identical image, and no dropped frames where casting everywhere
    // pushed the 95th-percentile frame to 33 ms.
    this.shadowSpan = 48;   // half-extent of the sun's shadow box, world units
    this.shadowX = 0;       // …and where it is centred (the VIEW FOCUS, not
    this.shadowZ = 0;       //   the camera: they are 30+ units apart top-down)
    this.instances = 0;     // total blades across every built chunk
    this._catchUp = 0;      // extra build budget while a band change settles
    this.setQuality(opts.quality || 'high');
    this.windTarget = 0.16;
    this.time = 0;
    this.stats = { chunks: 0, drawn: 0, instances: 0, built: 0, band: 0 };
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._warned = false;
  }

  Field.prototype = {

    // ---- authoring -------------------------------------------------------

    /** Paint foliage into a disc. `strength` is 0..1 of full density; a
     *  negative strength erases. Returns the number of cells touched. */
    paint: function (gx, gz, defIndex, radius, strength, opts) {
      opts = opts || {};
      var touched = 0, r = Math.max(0.5, radius);
      var soft = opts.hard ? 0 : 1;
      var kv = defIndex + 1;
      var x0 = Math.floor(gx - r), x1 = Math.ceil(gx + r);
      var z0 = Math.floor(gz - r), z1 = Math.ceil(gz + r);
      for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
        if (!G.inGrid(x, z)) continue;
        var d = Math.hypot(x - gx, z - gz);
        if (d > r) continue;
        var fall = soft ? Math.max(0, 1 - d / r) : 1;
        // A little noise in the falloff keeps a painted field from reading as
        // a stamped circle — the edge frays the way a real crop line does.
        fall *= 0.72 + 0.56 * G.hash2(x * 1.7 + 11, z * 1.9 + 5);
        // NATURAL. A map that sows a ninety-cell disc of tall grass is not
        // asking for a ninety-cell disc of tall grass; it is asking for rough
        // ground over there. Modulated by the terrain's own patch noise, an
        // authored field thins and clumps the way the ground does instead of
        // carpeting every cell inside the radius — which is what put 97% of
        // Hedgerow Hell under a uniform mat despite `autoSow` only wanting 38%.
        // The editor's brush does NOT pass this: a player dragging a brush
        // means the cells under it.
        if (opts.natural) {
          // …but the thinning is a property of the GROUND. Woodland and a sown
          // crop field carry their cover edge to edge; it is open pasture and
          // bare going that clump. Without this the map's own sowing thinned a
          // wood exactly as hard as the field beside it and put Hedgerow Hell's
          // woods at 0.29 against its grass at 0.25.
          var sfc = G.TYPE_DEF[this.terrain.type[z * G.GRID + x]];
          var thick = sfc && (sfc.name === 'forest' || sfc.name === 'crops' || sfc.name === 'marsh');
          if (!thick) {
            var br = this.terrain.patch ? this.terrain.patch[z * G.GRID + x] : 0.5;
            var t = (br - (opts.floor === undefined ? 0.38 : opts.floor));
            if (t <= 0) continue;
            fall *= Math.min(1, t / 0.34);
          }
          // A map's own `sow()` of rough ground is the same automatic layer by
          // another name, and takes the same scale. `natural` is exactly the
          // flag that separates it from a drawn crop field or a brush stroke.
          fall *= this.SOW_SCALE;
        }
        if (fall <= 0.02) continue;
        var i = z * G.GRID + x;
        if (strength < 0) {                                  // eraser
          var was = this.dens[i];
          var nd = was + strength * 255 * fall;
          this.dens[i] = nd <= 0 ? 0 : nd;
          if (this.dens[i] === 0) this.kind[i] = 0;
          // (round 108) bare already: no blade here to redraw. A tank on a
          // track it has flattened, or on plough, queued its chunk anyway.
          if (!was) { touched++; continue; }
        } else {
          if (!this._plantable(x, z)) continue;
          if (this.kind[i] !== kv && this.dens[i] > 0 && !opts.replace) {
            // Painting a new kind over an old one thins the old first, so you
            // can blend a wheat field into its grass margin.
            this.dens[i] = Math.max(0, this.dens[i] - strength * 255 * fall);
            if (this.dens[i] > 8) { this._touch(x, z); touched++; continue; }
          }
          this.kind[i] = kv;
          this.dens[i] = Math.min(255, this.dens[i] + strength * 255 * fall);
        }
        this._touch(x, z, opts.slow);   // `slow`: see SOFT_REBUILD_S
        touched++;
      }
      return touched;
    },

    /** Surfaces that will hold a crop. Rock, water, roads and snow will not. */
    _plantable: function (gx, gz) {
      var t = this.terrain.typeAt(gx, gz);
      var def = G.TYPE_DEF[t];
      if (!def) return false;
      if (def.passable === false) return false;               // water, chasm
      var n = def.name;
      return !(n === 'stone' || n === 'road' || n === 'ice' || n === 'gravel' || n === 'rubble');
    },

    /** Wipe foliage in a world-space disc (shell craters, tank tracks). */
    flatten: function (wx, wz, r, amount, soft) {
      var gx = G.worldToCell(wx), gz = G.worldToCell(wz);
      var cr = Math.ceil(r / G.TILE);
      var amt = amount === undefined ? 1 : amount;
      var hit = 0;
      for (var z = gz - cr; z <= gz + cr; z++) for (var x = gx - cr; x <= gx + cr; x++) {
        if (!G.inGrid(x, z)) continue;
        var i = z * G.GRID + x;
        if (!this.dens[i]) continue;
        var d = Math.hypot((x - gx) * G.TILE, (z - gz) * G.TILE);
        if (d > r) continue;
        var take = amt * (1 - d / r) * 255;
        this.dens[i] = Math.max(0, this.dens[i] - take);
        if (this.dens[i] < 4) { this.dens[i] = 0; this.kind[i] = 0; }
        this._touch(x, z, soft);
        hit++;
      }
      return hit;
    },

    /** Does anything here burn? (fire spread asks before it takes hold) */
    flammableAt: function (gx, gz) {
      var d = this.defAt(gx, gz);
      return !!(d && d.burn && this.dens[gz * G.GRID + gx] > 40);
    },

    clear: function () {
      this.kind.fill(0); this.dens.fill(0);
      for (var i = 0; i < this.chunks.length; i++) this._dispose(this.chunks[i]);
      this._dropQueues();
    },

    /** Empty both rebuild queues AND the per-chunk flags that keep a chunk off
     *  them (`_touch` pushes only `if (!c.dirty)`): a list dropped with its
     *  flags still set is a set of chunks no edit can queue again. */
    _dropQueues: function () {
      for (var i = 0; i < this.chunks.length; i++) { this.chunks[i].dirty = false; this.chunks[i].soft = false; }
      this.dirtyList.length = 0;
      if (this.softList) this.softList.length = 0;
    },

    /** HOW MUCH OF IT THERE IS.
     *
     *  The ground layer is a function of the surface under it, and it was
     *  authored to the point where every plantable cell that could hold
     *  something did: mean density 0.32 with 82% of the map under cover, which
     *  reads as a lawn rolled over Normandy rather than as ground. This is the
     *  one number that scales the whole automatic layer, and it is applied to
     *  the density rather than to the coverage on purpose — thin cells fall
     *  under `autoSow`'s own 0.06 cutoff and drop out entirely, so the fringes
     *  disappear first and what is left is the thick heart of each patch. The
     *  hand-authored crop fields and the editor's brush are NOT scaled: a
     *  wheatfield somebody drew is a wheatfield.
     *
     *  0.40 = forty per cent of what the ground carried before. */
    SOW_SCALE: 0.40,

    /** Plant a whole map from its SURFACES, so the eighteen stock maps and the
     *  terrain generator get a living ground layer without anyone editing them.
     *  Purely a function of (surface, cell, the terrain's own patch noise), so
     *  it is stable across reloads and identical on both machines in a replay.
     *  Cells a map (or a player) has already planted are left alone unless
     *  `force` — so a hand-authored field always beats the automatic one. */
    autoSow: function (force) {
      var T = this.terrain, GR = G.GRID, i, x, z;
      var TY = G.TYPE;
      // surface -> [kind id, density in the HEART of a patch, patch FLOOR].
      //
      // `patch` is the terrain's own large-scale meadow noise. The old formula
      // was `dens * (1 - bias + bias * patch * 1.6)`, which bottoms out at 45%
      // of base however bare the noise says the ground is — so every plantable
      // cell on every map was planted. Measured on Hedgerow Hell: 195,415 of
      // 200,704 cells under a carpet, 100% of the grass, 100% of the mud and
      // 100% of the forest, and WOODLAND CAME OUT AT 0.56 AGAINST OPEN GRASS
      // AT 0.49 — a fourteen per cent difference between a wood and a field.
      //
      // `floor` is the noise level below which a surface carries nothing at
      // all, and it is the number that makes a clearing a clearing. The patch
      // field runs 0.07 to 0.94 with its quartiles at 0.40 / 0.50 / 0.59, which
      // is what these are set against.
      //
      // Calibrated in two passes, because the first was worse than the fault.
      // A floor of 0.50 on grass left only 43% of open ground planted and it
      // read as DESERT — bare tan dirt between the hedge banks, which is not
      // Normandy either. 0.28 keeps the pasture green over about four fifths
      // of it while the density underneath ranges from nothing to full, so a
      // field has thick corners, thin middles and worn bare patches instead of
      // one flat mat. The contrast that matters goes into the WOODS: fern at
      // 1.00 from a floor of 0.02 against grass's 0.88 from 0.28 puts woodland
      // at roughly three times the density of open ground, where it used to be
      // 0.56 against 0.49.
      var PLAN = {};
      function plan(t, id, dens, floor) { if (t !== undefined) PLAN[t] = [BY_ID[id].index + 1, dens, floor]; }
      plan(TY.grass,  'grass',     0.88, 0.28);   // pasture: thick and thin, with bare patches
      plan(TY.crops,  'wheat',     0.95, 0.00);   // a sown field is sown, edge to edge
      plan(TY.forest, 'fern',      1.00, 0.02);   // undergrowth everywhere, and thick
      plan(TY.marsh,  'reeds',     0.90, 0.10);
      plan(TY.swamp,  'reeds',     0.80, 0.14);
      plan(TY.mud,    'grass',     0.30, 0.58);   // a churned track carries very little
      plan(TY.sand,   'heather',   0.22, 0.66);
      var n = 0;
      for (z = 0; z < GR; z++) for (x = 0; x < GR; x++) {
        i = z * GR + x;
        var p = PLAN[T.type[i]];
        if (!p) continue;
        if (this.kind[i] && !force) continue;      // authored beats automatic
        if (!this._plantable(x, z)) continue;
        // Two noise fields: the terrain's broad patchiness decides WHERE a
        // meadow thickens, a fine hash breaks up the edge so it isn't a contour.
        var broad = T.patch ? T.patch[i] : 0.5;
        var fine = G.hash2(x * 0.9 + 3, z * 0.9 + 7);
        // Below the floor this surface is bare, and the ramp above it starts at
        // nothing — so a patch has an edge that thins out rather than a contour
        // line where full cover stops.
        var t = (broad - p[2]) / Math.max(0.05, 1 - p[2]);
        if (t <= 0) continue;
        var d = p[1] * this.SOW_SCALE * Math.pow(t, 0.7) * (0.72 + fine * 0.56);
        if (d <= 0.06) continue;
        this.kind[i] = p[0];
        this.dens[i] = Math.min(255, d * 255);
        n++;
        // A tall-grass fringe where meadow meets woodland reads as a real edge.
        if (T.type[i] === TY.grass && broad > 0.72 && fine > 0.55) {
          this.kind[i] = BY_ID.tallgrass.index + 1;
          this.dens[i] = Math.min(255, d * 300);
        }
      }
      if (n) for (i = 0; i < this.chunks.length; i++) { var c = this.chunks[i]; c.empty = false; if (!c.dirty) { c.dirty = true; this.dirtyList.push(c); } }
      return n;
    },

    // ---- gameplay queries (hot: called from combat, keep them arithmetic) --

    defAt: function (gx, gz) {
      if (!G.inGrid(gx, gz)) return null;
      var k = this.kind[gz * G.GRID + gx];
      return k ? DEFS[k - 1] : null;
    },
    /** 0..1 density at a cell. */
    densityAt: function (gx, gz) {
      if (!G.inGrid(gx, gz)) return 0;
      return this.dens[gz * G.GRID + gx] / 255;
    },
    /** Fraction of incoming fire this cell's foliage negates. */
    coverAt: function (gx, gz) {
      var d = this.defAt(gx, gz);
      return d ? d.cover * this.densityAt(gx, gz) : 0;
    },
    /** Multiplier on the range at which an enemy spots a unit standing here. */
    concealAt: function (gx, gz) {
      var d = this.defAt(gx, gz);
      return d ? 1 - d.conceal * this.densityAt(gx, gz) : 1;
    },
    /** HOW WELL IT GREW HERE, 0.62 to 1.40, smooth over about nine metres.
     *
     *  Every blade in the game was the SAME HEIGHT give or take its own
     *  `vary` jitter — an independent coin flip per instance, which at any
     *  distance averages back to one flat mat. Ground does not work like
     *  that: growth goes in patches, tall in the damp hollow and worn short
     *  on the path across the corner, and it is the patches you see rather
     *  than the individual blades.
     *
     *  Smooth (bilinear, smoothstepped) so neighbouring blades agree, seeded
     *  off the cell so a rebuild after a sculpt or a reload puts every blade
     *  back exactly where it was — the same contract as the placement. */
    growAt: function (gx, gz) {
      var fx = gx * 0.1667, fz = gz * 0.1667;      // one lobe per six cells
      var ix = Math.floor(fx), iz = Math.floor(fz);
      var tx = fx - ix, tz = fz - iz;
      tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz);
      var a = G.hash2(ix * 1.31 + 7.7, iz * 1.17 + 3.3);
      var b = G.hash2((ix + 1) * 1.31 + 7.7, iz * 1.17 + 3.3);
      var c = G.hash2(ix * 1.31 + 7.7, (iz + 1) * 1.17 + 3.3);
      var d = G.hash2((ix + 1) * 1.31 + 7.7, (iz + 1) * 1.17 + 3.3);
      var top = a + (b - a) * tx, bot = c + (d - c) * tx;
      return 0.62 + (top + (bot - top) * tz) * 0.78;
    },
    /** World height of the concealing mass — a sightline above it is clear.
     *  Density and the growth field both feed it, and both feed what is
     *  DRAWN, so the wheat a man is hiding in is as tall as it looks. */
    heightAt: function (gx, gz) {
      var d = this.defAt(gx, gz);
      return d ? d.height * (0.55 + 0.45 * this.densityAt(gx, gz)) * this._growC(gx, gz) : 0;
    },
    /** `growAt`, remembered per cell (round 107). It depends on nothing but the
     *  cell, and it is four hashes — a sine each — on every step of every
     *  sightline through a crop: two fifths of what a sightline cost. Kept in
     *  doubles, so every comparison against it is the one it always was. */
    _growC: function (gx, gz) {
      var N = G.GRID * G.GRID, C = this._growCache;
      if (!C || C.length !== N) { C = this._growCache = new Float64Array(N); C.fill(NaN); }
      var i = gz * G.GRID + gx, v = C[i];
      if (v !== v) v = C[i] = this.growAt(gx, gz);
      return v;
    },
    /** Sightline occlusion contributed by one cell, given the ray's height
     *  ABOVE the ground at that cell. Accumulated by `hasLOS`. */
    occlusionAt: function (gx, gz, hAbove) {
      if (!G.inGrid(gx, gz)) return 0;
      var k = this.kind[gz * G.GRID + gx];
      if (!k) return 0;
      var d = DEFS[k - 1];
      if (!d.los) return 0;
      var dens = this.dens[gz * G.GRID + gx] / 255;
      var top = d.height * (0.55 + 0.45 * dens) * this._growC(gx, gz);
      if (hAbove > top) return 0;                    // looking over the crop
      // Denser near the ground: a prone man in wheat is invisible, a standing
      // one shows his head and shoulders.
      var depth = 1 - Math.max(0, hAbove) / Math.max(top, 0.01);
      return d.los * dens * (0.35 + 0.65 * depth);
    },
    get losBudget() { return LOS_BUDGET; },

    // ---- streaming + LOD --------------------------------------------------

    setQuality: function (q) {
      this.quality = q in QUALITY ? q : 'high';
      this.enabled = QUALITY[this.quality].density > 0;
      this.group.visible = this.enabled;
      this._applyBand(true);
      return this.quality;
    },

    /** Recompute the working radii and density from (quality x zoom band).
     *  `force` drops every built chunk so they come back at the new density. */
    _applyBand: function (force) {
      var Q = QUALITY[this.quality] || QUALITY.high;
      var B = BANDS[this.band || 0];
      this.density = Q.density * B.density;
      // Fewer, larger blades from further up. Coverage is what reads at that
      // range, not individuals, and a tenth as many blades at the same size
      // would look like a field that had been mown in stripes. Kept modest and
      // capped: overshoot it and a meadow turns into a scribble of wide,
      // spiky cards that reads as visual noise rather than ground cover.
      this.sizeBoost = Math.min(1.75, Math.pow(1 / Math.max(0.05, this.density / Q.density), 0.42));
      this.groundBlend = Math.min(0.74, 0.34 + (this.band || 0) * 0.10);
      this.buildR = Q.buildR * B.radius;
      this.dropR = this.buildR * 1.3 + CHUNK * G.TILE;
      this.shared.uFade.value.set(Q.fadeNear * B.radius, Q.fadeFar * B.radius);
      if (force) {
        for (var i = 0; i < this.chunks.length; i++) this._dispose(this.chunks[i]);
        this._dropQueues();
        this.instances = 0;
        // Let the rebuild catch up quickly rather than crawl in at 3 a frame —
        // a zoom-out should settle within a few frames, not a second.
        this._catchUp = 90;
      }
    },

    /** Pick the zoom band for the current eye height, with hysteresis AND a
     *  DWELL TIME.
     *
     *  A band change drops every built chunk and streams the whole field back
     *  in over the next second, so it must only ever happen when the camera has
     *  really changed scale — not when it has crossed something. The `enter` /
     *  `exit` split stops a camera hovering exactly on a boundary from
     *  oscillating, but it does nothing about the case that actually bites in
     *  first person: an eye 1.7 units off the ground walks onto a bunker roof,
     *  a hedge bank or the lip of the cliff at Pointe du Hoc, the ground under
     *  it drops away for a moment, and the whole meadow blinks out and grows
     *  back. Requiring the new band to hold for `BAND_DWELL` seconds costs one
     *  comparison a frame and makes a genuine zoom (which takes longer than
     *  that) indistinguishable, while a step off a ledge never fires at all. */
    _updateBand: function (camY, dt) {
      var h = Math.max(0, camY - this._groundY);
      var b = this.band || 0;
      while (b < BANDS.length - 1 && h >= BANDS[b + 1].enter) b++;
      while (b > 0 && h < BANDS[b].exit) b--;
      if (b === this.band) { this._bandWant = b; this._bandT = 0; return false; }
      if (b !== this._bandWant) { this._bandWant = b; this._bandT = 0; }
      this._bandT += (dt || 0.016);
      if (this._bandT < BAND_DWELL) return false;
      this._bandT = 0;
      this.band = b; this._applyBand(true); return true;
    },

    /** Wind strength/direction, normally driven from the weather. */
    setWind: function (dirRad, amp, speed) {
      var w = this.shared.uWind.value;
      w.x = Math.sin(dirRad); w.y = Math.cos(dirRad);
      this.windTarget = amp;
      if (speed !== undefined) w.w = speed;
    },

    /** Foliage wilts and greys as a field burns (0 = ash, 1 = healthy). */
    setHealth: function (h) { this.shared.uHealth.value = Math.max(0, Math.min(1, h)); },

    /** Adopt the game's cloud-shadow uniforms, so the field is under the same
     *  cloud as the ground it grows out of and the men standing in it.
     *
     *  It takes the UNIFORM OBJECTS, not their values: the game advances the
     *  drift every frame in `_updateDaylight`, and copying numbers across would
     *  mean either a per-frame call or a field that lags the terrain it is
     *  sitting on — and a cloud edge that arrives at the grass a moment after
     *  it arrives at the mud is worse than no cloud at all. Called once, and
     *  guarded at the call site like every other entry point in this module. */
    setCloud: function (cloudUniform, bandUniform) {
      if (!cloudUniform) return false;
      this.shared.uCloud = cloudUniform;
      if (bandUniform) this.shared.uCloudBand = bandUniform;
      // The material was built with the OLD uniform objects bound into its
      // compiled program; `onBeforeCompile` re-runs and re-binds on recompile.
      if (this.material) this.material.needsUpdate = true;
      return true;
    },

    _touch: function (gx, gz, soft) {
      var cx = (gx / CHUNK) | 0, cz = (gz / CHUNK) | 0;
      if (cx < 0 || cz < 0 || cx >= this.cw || cz >= this.cw) return;
      var c = this.chunks[cz * this.cw + cx];
      c.empty = false;
      // a slow edit waits for the next soft flush (SOFT_REBUILD_S); `softRebuild = false` to A/B
      if (soft && this.softRebuild !== false) { if (!c.dirty && !c.soft) { c.soft = true; this.softList.push(c); } return; }
      if (!c.dirty) { c.dirty = true; this.dirtyList.push(c); }
    },

    /** Terrain was sculpted under us — every blade needs re-seating. */
    touchAll: function () {
      for (var i = 0; i < this.chunks.length; i++) {
        var c = this.chunks[i];
        if (c.mesh && !c.dirty) { c.dirty = true; this.dirtyList.push(c); }
      }
    },

    /** The game owns the sun's shadow frustum (it tightens for first person
     *  and widens for the strategic view), so it tells us where it is. */
    setShadowSpan: function (span, fx, fz) {
      this.shadowSpan = span; this.shadowX = fx; this.shadowZ = fz;
    },
    /** Is this chunk inside the sun's shadow box, and does it hold anything
     *  worth a shadow? Its own radius is added to the box, so a hedge just
     *  outside still throws its shadow INTO it.
     *
     *  WHAT CASTS IS WHAT STANDS UP. Every chunk cast, so a field of half-metre
     *  meadow grass threw two hundred thousand tiny hard shadows and the ground
     *  read as a dark stipple rather than as grass — all of the cost of the
     *  shadow pass and none of the picture. A blade that short does not put a
     *  shadow on anything you can see from the playing camera; wheat, corn,
     *  reeds, brush and the bracken under a wood do, and they still do. */
    _casts: function (c) {
      if (!c.tall) return false;
      var dx = c.wx - this.shadowX, dz = c.wz - this.shadowZ;
      return dx * dx + dz * dz < (this.shadowSpan + c.radius) * (this.shadowSpan + c.radius);
    },

    update: function (dt, camera) {
      if (!this.enabled) return;
      this.time += dt;
      this.shared.uTime.value = this.time;
      // Gusts: the wind amplitude wanders toward its target rather than
      // stepping, so a weather change doesn't snap the whole field sideways.
      var w = this.shared.uWind.value;
      w.z += (this.windTarget - w.z) * Math.min(1, dt * 0.6);

      var cam = camera.position;
      this.shared.uCam.value.copy(cam);
      // The zoom band is what lets one set of numbers serve both an eye 1.7
      // units off the ground and a strategic camera sixty units up.
      // Smoothed, for the same reason the band has a dwell time: the sample is
      // a single point, and a single point steps by four metres when the camera
      // crosses a hedge bank or a crater lip.
      var gy = this.terrain.heightAt(cam.x, cam.z);
      this._groundY += (gy - this._groundY) * Math.min(1, dt * 2.5);
      this._updateBand(cam.y, dt);

      var buildR2 = this.buildR * this.buildR;
      var dropR2 = this.dropR * this.dropR;
      var budget = BUILDS_PER_FRAME;
      if (this._catchUp > 0) { budget += 5; this._catchUp--; }
      var drawn = 0, inst = 0, live = 0;

      // The slow edits join the queue a few times a second (SOFT_REBUILD_S).
      this._softT -= dt;
      if (this._softT <= 0) {
        this._softT = SOFT_REBUILD_S;
        for (var si = 0; si < this.softList.length; si++) {
          var sc = this.softList[si];
          sc.soft = false;
          if (!sc.dirty) { sc.dirty = true; this.dirtyList.unshift(sc); }   // under the hard edits (popped last)
        }
        this.softList.length = 0;
      }
      // Rebuild edited chunks first — the brush must feel immediate.
      var bt0 = performance.now(), built = 0;
      while (budget > 0 && this.dirtyList.length) {
        var d = this.dirtyList.pop();
        d.dirty = false;
        if (d.mesh || this._near(d, cam, buildR2)) {
          this._build(d); budget--; built++;
          if (performance.now() - bt0 > BUILD_MS) budget = 0;   // (round 107) see BUILD_MS
        }
        else this._dispose(d);
      }

      // Pass 1: everything already built — drop what has gone out of range,
      // set the LOD on the rest, and note the nearest candidate to build.
      var bestI = -1, bestD = Infinity;
      // (round 108) NOTHING PAST THE FADE. The vertex shader sinks every blade
      // further than uFade.y from the eye into the ground (`lod`), and the
      // chunks out there were still drawn: at the playing distance over
      // Ponyri, all fifty grass draw calls of the frame were chunks wholly
      // past it, a draw call and a vertex shader for a field of nothing. A
      // chunk's blades all stand within `radius` of its centre across the
      // ground — plus half a tile, since `_build` scatters them about each
      // cell's corner, so a tile of margin — and an eye is never nearer in
      // three dimensions than across the ground: this hides only what could
      // not be seen. The chunk stays built.
      var fadeFar = this.shared.uFade.value.y + G.TILE;
      for (var i = 0; i < this.chunks.length; i++) {
        var c = this.chunks[i];
        if (c.empty) continue;
        var dx = c.wx - cam.x, dz = c.wz - cam.z, dy = c.wy - cam.y;
        var d2 = dx * dx + dz * dz + dy * dy;
        if (c.mesh) {
          live++;
          if (d2 > dropR2) { this._dispose(c); continue; }
          // Free LOD. Instances were shuffled at build time, so a prefix is a
          // uniform sample: one integer write thins a distant field.
          var dist = Math.sqrt(d2) - c.radius;
          var f = 1 - Math.max(0, Math.min(1, (dist - this.buildR * 0.35) / (this.buildR * 0.75)));
          f = 0.12 + f * 0.88;
          c.mesh.count = Math.max(0, Math.min(c.n, Math.ceil(c.n * f)));
          if (this.fadeCull !== false && Math.sqrt(dx * dx + dz * dz) - c.radius > fadeFar) c.mesh.count = 0;   // `fadeCull = false` to A/B
          if (c.mesh.count > 0) { drawn++; inst += c.mesh.count; }
          c.mesh.visible = c.mesh.count > 0;
          c.mesh.castShadow = c.mesh.visible && this._casts(c);
        } else if (d2 < buildR2 && d2 < bestD) { bestD = d2; bestI = i; }
      }

      // Pass 2: build the nearest unbuilt chunks, nearest FIRST. Ordering
      // matters as soon as the instance ceiling bites — when it does, it must
      // be the far edge of the field that goes without, never the ground the
      // camera is standing on.
      while (budget > 0 && bestI >= 0 && this.instances < MAX_INSTANCES) {
        if (built && performance.now() - bt0 > BUILD_MS) break;   // (round 107) see BUILD_MS
        this._build(this.chunks[bestI]); budget--; live++; built++;
        bestI = -1; bestD = Infinity;
        for (var j = 0; j < this.chunks.length; j++) {
          var c2 = this.chunks[j];
          if (c2.empty || c2.mesh) continue;
          var ex = c2.wx - cam.x, ez = c2.wz - cam.z, ey = c2.wy - cam.y;
          var e2 = ex * ex + ez * ez + ey * ey;
          if (e2 < buildR2 && e2 < bestD) { bestD = e2; bestI = j; }
        }
      }

      this.stats.chunks = live;
      this.stats.drawn = drawn;
      this.stats.instances = inst;
      this.stats.band = this.band;

      if (!_patchOk && !this._warned) {
        this._warned = true;
        console.warn('[foliage] shader patch anchor missing — foliage renders static ' +
                     '(check the Three.js revision; written against r128).');
      }
    },

    _near: function (c, cam, r2) {
      var dx = c.wx - cam.x, dz = c.wz - cam.z, dy = c.wy - cam.y;
      return dx * dx + dz * dz + dy * dy < r2;
    },

    // ---- chunk build ------------------------------------------------------

    _dispose: function (c) {
      if (!c.mesh) return;
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose && c.mesh.geometry.dispose();
      this.instances -= c.n;
      if (this.instances < 0) this.instances = 0;
      c.mesh = null; c.n = 0;
    },

    _build: function (c) {
      this._dispose(c);
      var GRIDl = G.GRID, TILEl = G.TILE, T = this.terrain;
      var x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
      var x1 = Math.min(GRIDl, x0 + CHUNK), z1 = Math.min(GRIDl, z0 + CHUNK);

      // How many blades one cell gets. Deterministic STOCHASTIC rounding: at a
      // high zoom band the raw figure is well under one per cell, and plain
      // rounding would floor every one of them to zero and delete the field.
      // Rounding by the cell's own hash instead keeps the right fraction of
      // cells populated, stably, so the same cells win on every rebuild.
      var self = this, RS = this._rngS || (this._rngS = new Int32Array(1));
      function R() { return rngNext(RS); }
      // (round 108) CARD_BAND: every blade a card from the strategic bands
      var cardLod = this.cardLod !== false && (this.band || 0) >= CARD_BAND, cardW = this.cardW || CARD_W, cardT = this.cardTint || CARD_TINT;
      function perCell(x, z, i, def) {
        var raw = def.per * (self.dens[i] / 255) * self.density;
        var whole = Math.floor(raw);
        return whole + (G.hash2(x * 2.13 + 0.7, z * 1.87 + 1.3) < raw - whole ? 1 : 0);
      }

      // Pass 1 — count, so the typed arrays are allocated exactly once.
      var total = 0, x, z, i, k, dens, def, n;
      for (z = z0; z < z1; z++) for (x = x0; x < x1; x++) {
        i = z * GRIDl + x;
        k = this.kind[i];
        if (!k || !this.dens[i]) continue;
        total += perCell(x, z, i, DEFS[k - 1]);
      }
      if (total <= 0) { c.empty = true; return; }
      if (total > MAX_PER_CHUNK) total = MAX_PER_CHUNK;

      var mats = new Float32Array(total * 16);
      var atl = new Float32Array(total * 2);
      var tint = new Float32Array(total * 3);
      var flags = new Float32Array(total * 3);

      var m = this._m4, q = this._q, pv = this._v, sv = this._s;
      var minY = 1e9, maxY = -1e9;
      var tallest = 0;              // the tallest KIND placed — see `_casts`
      var w = 0;
      var col = new THREE.Color(), grd = new THREE.Color();
      // The terrain's baked per-vertex colour, indexed by the same cell index.
      var tcol = (T.mesh && T.mesh.geometry.attributes.color) || null;

      // Pass 2 — place. Everything is seeded off the cell so a rebuild after a
      // sculpt, a save/load or a density change puts every blade back exactly
      // where it was. Nothing here may call Math.random().
      for (z = z0; z < z1 && w < total; z++) for (x = x0; x < x1 && w < total; x++) {
        i = z * GRIDl + x;
        k = this.kind[i];
        if (!k || !this.dens[i]) continue;
        def = DEFS[k - 1];
        dens = this.dens[i] / 255;
        n = perCell(x, z, i, def);
        if (n <= 0) continue;
        if (def.height > tallest) tallest = def.height;
        RS[0] = (x * 73856093) ^ (z * 19349663) ^ (k * 83492791);
        var cellX = (x - GRIDl / 2) * TILEl, cellZ = (z - GRIDl / 2) * TILEl;
        var atlU = (def.atlas % ATLAS_COLS) / ATLAS_COLS;
        var atlV = 1 - (Math.floor(def.atlas / ATLAS_COLS) + 1) / ATLAS_ROWS;
        var kindCard = def.mode === 'card' ? 1 : 0;
        var card = kindCard || cardLod ? 1 : 0;
        var cw = cardLod && !kindCard ? cardW : 1, ct = cardLod && !kindCard ? cardT : 1;

        for (var j = 0; j < n && w < total; j++, w++) {
          var px = cellX + (R() - 0.5) * TILEl;
          var pz = cellZ + (R() - 0.5) * TILEl;
          var py = T.heightAt(px, pz);
          if (py < minY) minY = py;
          // HOW TALL IT GREW HERE. Two terms the render was missing and the
          // gameplay model already had: the cell's own density (a thin patch
          // is short — `heightAt` has said so since it was written) and the
          // growth field (`growAt`, patches of tall and short across about
          // nine metres). Width takes the root of it, so a tall clump is a
          // little broader rather than stretched.
          var grow = (0.55 + 0.45 * dens) * this.growAt(x, z);
          var gw = Math.sqrt(grow);
          var sw = def.w * gw * (1 + (R() - 0.5) * 2 * def.vary) * this.sizeBoost * cw;
          var sh = def.h * grow * (1 + (R() - 0.5) * 2 * def.vary) * Math.min(1.3, this.sizeBoost);
          if (py + sh > maxY) maxY = py + sh;

          pv.set(px, py - 0.04, pz);          // rooted just under the surface
          sv.set(sw, sh, sw);
          // A 'card' instance carries NO yaw: its quad is swung to face the
          // camera in the vertex shader, which needs instance-local axes to be
          // world axes. A 'cross' gets a random yaw so a field isn't a lattice
          // — drawn even when it is drawn as a card (CARD_BAND), so every
          // draw after it is the one it was.
          var yaw = kindCard ? 0 : R() * Math.PI * 2;
          q.setFromAxisAngle(this._up, card ? 0 : yaw);
          m.compose(pv, q, sv);
          m.toArray(mats, w * 16);

          atl[w * 2] = atlU; atl[w * 2 + 1] = atlV;

          // Colour is the kind's own palette pulled part-way toward THE GROUND
          // IT IS GROWING OUT OF. That one blend is what stops a painted field
          // reading as a stipple of dark dots on unrelated turf: dry ground
          // gets dry grass, a shaded wood floor gets darker bracken, and scorch
          // marks show through the crop standing on them. `grd` is the
          // terrain's own baked vertex colour, so it already carries the
          // surface, the patchiness, the slope and the burn.
          col.setHex(def.tint[(R() * def.tint.length) | 0]);
          if (tcol) {
            grd.fromBufferAttribute(tcol, i);
            // Blend harder the further out the camera is. Up close you want
            // the crop to read as its own thing; from the strategic view an
            // individual tuft is a few pixels, and anything that contrasts
            // with the ground at that size reads as stipple rather than grass.
            col.lerp(grd, this.groundBlend);
          }
          // Multiplied over an already-coloured sprite, and lit afterwards, so
          // it has to sit above 1 or a meadow comes out closer to moss.
          var vv = (0.86 + R() * 0.34) * ct;
          tint[w * 3] = (col.r * 2.35) * vv;
          tint[w * 3 + 1] = (col.g * 2.35) * vv;
          tint[w * 3 + 2] = (col.b * 2.35) * vv;

          flags[w * 3] = card;
          flags[w * 3 + 1] = def.sway;
          flags[w * 3 + 2] = def.topFade;
        }
      }
      if (w <= 0) { c.empty = true; return; }
      // SHADOW_MIN is a world height, not a kind list, so a Forge-authored
      // plant is judged by how big it is like everything else.
      c.tall = tallest >= SHADOW_MIN;

      this._shuffle(w, mats, atl, tint, flags);

      var geo = (cardLod ? this.cardGeometry : this.geometry).clone();
      geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(atl, 2));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      geo.setAttribute('aFlags', new THREE.InstancedBufferAttribute(flags, 3));

      var mesh = new THREE.InstancedMesh(geo, this.material, w);
      // Three.js builds its own depth material for the shadow pass unless it
      // is handed one, and the one it builds knows nothing about the atlas,
      // the cutout, the billboard swing or the wind — so every blade cast a
      // solid three-quad asterisk. See makeDepthMaterial.
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.instanceMatrix.array.set(mats.subarray(0, w * 16));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;      // set from the shadow band below
      mesh.receiveShadow = true;    // fragment-side lookup: effectively free
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -1;        // draw before the transparent pass
      // The instance matrices are world-space, so the bounding volume must be
      // world-space too or the frustum test culls the chunk from the wrong place.
      c.wy = (minY + maxY) * 0.5;
      var halfW = CHUNK * TILEl * 0.5 + 1.5 * scaledK;
      var halfH = Math.max(1, (maxY - minY) * 0.5 + 1);
      geo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(c.wx, c.wy, c.wz), Math.sqrt(halfW * halfW * 2 + halfH * halfH));
      geo.boundingBox = new THREE.Box3(
        new THREE.Vector3(c.wx - halfW, minY - 0.5, c.wz - halfW),
        new THREE.Vector3(c.wx + halfW, maxY + 0.5, c.wz + halfW));
      c.radius = geo.boundingSphere.radius;

      mesh.castShadow = this._casts(c);   // right on the first frame it exists
      this.group.add(mesh);
      c.mesh = mesh; c.n = w; c.empty = false;
      this.instances += w;
      this.stats.built++;
    },

    /** Fisher-Yates over four parallel arrays, so `mesh.count = n` is a fair
     *  random sample of the chunk and distance LOD thins evenly. */
    _shuffle: function (n, mats, atl, tint, flags) {
      // (round 108) the same draws and the same swaps, without a view
      // (`subarray`) and a closure's boxed seed for every blade
      var RS = this._rngS || (this._rngS = new Int32Array(1));
      RS[0] = n * 2654435761;
      for (var i = n - 1; i > 0; i--) {
        var j = (rngNext(RS) * (i + 1)) | 0;
        if (j === i) continue;
        swap(mats, i, j, 16);
        swap(atl, i, j, 2); swap(tint, i, j, 3); swap(flags, i, j, 3);
      }
      function swap(a, i2, j2, s) {
        for (var k = 0; k < s; k++) {
          var t = a[i2 * s + k]; a[i2 * s + k] = a[j2 * s + k]; a[j2 * s + k] = t;
        }
      }
    },

    // ---- persistence ------------------------------------------------------

    /** Run-length encoded — a painted map is enormously repetitive, so a
     *  200k-cell field is a few hundred numbers rather than a megabyte of
     *  JSON. Format: flat [value, runLength, value, runLength, …]. */
    serialize: function () {
      var any = false, i;
      for (i = 0; i < this.N; i++) if (this.kind[i]) { any = true; break; }
      if (!any) return null;
      // Density is QUANTISED TO 16 LEVELS before encoding. Run-length coding
      // only pays when neighbours match, and an auto-sown field varies by a
      // byte or two per cell — which produces 200,000 runs of length one and a
      // quarter-megabyte of JSON that will not fit alongside three other maps
      // in a 5 MB localStorage quota. Sixteen levels is about 6% steps, which
      // is finer than the eye can read on ground cover, and it collapses the
      // encoded size by roughly an order of magnitude.
      // …EXCEPT THAT `& 0xC0` KEEPS THE TOP **TWO** BITS, NOT FOUR. It was four
      // levels, not sixteen — 25% steps rather than 6% — and a mask TRUNCATES,
      // so every value fell to the step below it and anything under 25%
      // density fell to ZERO. A saved map came back with its thin ground cover
      // deleted outright and the rest of it a quarter thinner, every time.
      // Sixteen real levels, rounded to nearest, and 255 stays 255.
      var q = new Uint8Array(this.N);
      for (i = 0; i < this.N; i++) q[i] = Math.round(this.dens[i] / 17) * 17;
      return { v: 2, grid: G.GRID, k: rle64(this.kind), d: rle64(q) };
    },

    load: function (data, srcGrid, off) {
      this.clear();
      if (!data || !data.k) return;
      srcGrid = srcGrid || data.grid || G.GRID; off = off || 0;
      // v1 wrote plain number arrays; v2 writes packed base64. Both load.
      var dec = (data.v >= 2) ? unrle64 : unrle;
      var k = dec(data.k, srcGrid * srcGrid);
      var d = dec(data.d, srcGrid * srcGrid);
      for (var z = 0; z < srcGrid; z++) for (var x = 0; x < srcGrid; x++) {
        var si = z * srcGrid + x, dx = x + off, dz = z + off;
        if (!G.inGrid(dx, dz)) continue;
        var kv = k[si];
        if (!kv || kv > DEFS.length) continue;
        var di = dz * G.GRID + dx;
        this.kind[di] = kv; this.dens[di] = d[si];
        this._touch(dx, dz);
      }
    },

    dispose: function () {
      this.clear();
      this.scene.remove(this.group);
      this.material.dispose();
    },
  };

  // ---- packed run-length coding ------------------------------------------
  // A JSON array of run pairs costs 4-8 characters per pair; on a fully sown
  // 224-cell map that is a quarter of a megabyte, which does not fit alongside
  // three other maps in a 5 MB localStorage quota. Packing each run into two
  // BYTES and base64ing the result is about 4x smaller, and combined with the
  // density quantisation above it brings a whole sown map down to a few tens
  // of kilobytes. Runs longer than 255 are simply split.
  function rle64(arr) {
    var out = [], run = 1, cur = arr[0], i;
    for (i = 1; i < arr.length; i++) {
      if (arr[i] === cur && run < 255) { run++; continue; }
      out.push(cur, run); cur = arr[i]; run = 1;
    }
    out.push(cur, run);
    // btoa takes a binary string; chunk it so the argument list never explodes.
    var bin = '', CH = 8192;
    for (i = 0; i < out.length; i += CH) bin += String.fromCharCode.apply(null, out.slice(i, i + CH));
    return btoa(bin);
  }
  function unrle64(b64, n) {
    var bin = atob(b64), out = new Uint8Array(n), w = 0;
    for (var i = 0; i + 1 < bin.length; i += 2) {
      var v = bin.charCodeAt(i), r = bin.charCodeAt(i + 1);
      for (var j = 0; j < r && w < n; j++) out[w++] = v;
    }
    return out;
  }

  function rle(arr) {
    var out = [], run = 1, cur = arr[0];
    for (var i = 1; i < arr.length; i++) {
      if (arr[i] === cur && run < 65535) { run++; continue; }
      out.push(cur, run); cur = arr[i]; run = 1;
    }
    out.push(cur, run);
    return out;
  }
  function unrle(pairs, n) {
    var out = new Uint8Array(n), w = 0;
    for (var i = 0; i + 1 < pairs.length; i += 2) {
      var v = pairs[i], r = pairs[i + 1];
      for (var j = 0; j < r && w < n; j++) out[w++] = v;
    }
    return out;
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================
  // TRUE SCALE (round 105). The blades, the crops' standing height and the
  // camera heights the zoom bands switch at were all drawn against the unit
  // models' diorama (a man 1.555 u tall). The game passes `K_FOL`; it is
  // applied ONCE (install runs on every field rebuild) as an exact
  // miniature: blade sizes, sway, band heights, fades and streaming radii by
  // k, and instances per cell by 1/k² — so at the camera distance that shows
  // a man as large as before, the field looks as full as before and costs the
  // same, and a wheatfield is chest high on a life-size man. Chunks shrink
  // with it so no chunk carries more blades than its cap.
  var scaledK = 1;
  function install(api) {
    THREE = api.THREE;
    G = api;
    installed = true;
    var k = api.K_FOL || 1;
    if (k !== 1 && scaledK === 1) {
      scaledK = k;
      for (var i = 0; i < DEFS.length; i++) {
        var d = DEFS[i];
        d.w *= k; d.h *= k; d.height *= k; d.sway *= k; d.per /= (k * k);
      }
      for (var b = 0; b < BANDS.length; b++) { BANDS[b].enter *= k; if (BANDS[b].exit > 0) BANDS[b].exit *= k; }
      for (var q in QUALITY) { QUALITY[q].fadeNear *= k; QUALITY[q].fadeFar *= k; QUALITY[q].buildR *= k; }
      var base = Math.max(4, Math.round(16 * k));
      CHUNK = Math.max(4, Math.round(16 * k * CHUNK_GROW));
      MAX_PER_CHUNK = Math.round(MAX_PER_CHUNK * (CHUNK / base) * (CHUNK / base));   // every blade still fits
      if (window.Foliage) window.Foliage.CHUNK = CHUNK;
    }
    return true;
  }

  function create(scene, terrain, opts) {
    if (!installed) throw new Error('Foliage.install() must run before create()');
    return new Field(scene, terrain, opts);
  }

  window.Foliage = {
    VERSION: VERSION,
    DEFS: DEFS,
    byId: function (id) { return BY_ID[id] || null; },
    QUALITY: QUALITY,
    CHUNK: CHUNK,
    LOS_BUDGET: LOS_BUDGET,
    install: install,
    create: create,
    /** Exposed for the editor's swatches and for tooling. */
    atlas: function () { return atlasTexture(); },
  };
})();
