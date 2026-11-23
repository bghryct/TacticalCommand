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
  //  atlas   index into the sprite atlas (0..7 painted at boot, 8..47 the
  //          Blender cells from assets/foliage_sprites.js — see `pasteSprites`)
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
  //  root    (Blender kinds) the fraction of the quad below the plant's foot;
  //          the instance is sunk by that much and ROOT_SINK more
  //  blend   (Blender kinds) how far the tint follows the ground under it, as
  //          a share of the field's `groundBlend` — 1 when absent
  // =========================================================================
  // (round 113) THE FORTY BLENDER KINDS draw their colour from the sprite, so
  // their tint only has to leave it alone: 0x6c6c6c x 2.35 (the chunk build's
  // gain) is 1.0, and the other two lean it a shade warm and a shade cool so
  // neighbouring clumps are not one colour. ROOT is plants.py's ground line,
  // GROUND_PX of its CELL.
  var ROOT = 8 / 256, ROOT_SINK = 0.01;
  var SPRITE_TINT = [0x6c6c6c, 0x716e66, 0x676b65];
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

    // ---- (round 113) FORTY MORE: modelled and lit in Blender ------------------
    // "40 more types of vegetation like the maize and reeds etc. basically more
    // kinds of optical cover with no real hard cover benefit" — the user. Each
    // is a plant built in metres at its real size (tools/blender/plants.py);
    // `w` x `h` is the quad measured off its geometry (the cell is drawn at that
    // aspect, so it comes back undistorted). The gameplay numbers follow the
    // eight above, from the height of the concealing mass in metres (H) and how
    // solid it is to the eye against standing wheat (op):
    //     conceal = 0.04 + 0.21 H op          (wheat 0.35, maize 0.54, reeds 0.42)
    //     los     = 0.6 op (H - 0.4)^0.85     (wheat 0.63, maize 1.06), none under 0.6 m
    //     cover   = 0.02 + 0.012 H            a stalk stops nothing; the woody
    //                                         few (gorse, vine, bamboo) 0.04-0.08
    // Crops replace wheat by theatre and field, the wild ones turn up in the
    // ground they grow in (`flora`); all of them are in the editor's palette.
    { id: 'clover',     name: 'Clover',     atlas: 8, mode: 'cross', w: 0.95, h: 0.26, vary: 0.25,
      per: 9, sway: 0.12, topFade: 0.00, cover: 0.02, conceal: 0.08, los: 0.00, height: 0.20,
      burn: true, root: ROOT, blend: 0.5, tint: SPRITE_TINT, swatch: '#696439' },
    { id: 'poppies',    name: 'Poppies',    atlas: 9, mode: 'cross', w: 1.04, h: 0.53, vary: 0.28,
      per: 9, sway: 0.20, topFade: 0.00, cover: 0.02, conceal: 0.07, los: 0.00, height: 0.31,
      burn: true, root: ROOT, blend: 0.35, tint: SPRITE_TINT, swatch: '#b33e10' },
    { id: 'beet',       name: 'Sugar beet', atlas: 10, mode: 'cross', w: 1.12, h: 0.28, vary: 0.22,
      per: 9, sway: 0.10, topFade: 0.00, cover: 0.02, conceal: 0.10, los: 0.00, height: 0.28,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#3c741d' },
    { id: 'potato',     name: 'Potatoes',   atlas: 11, mode: 'cross', w: 0.98, h: 0.59, vary: 0.22,
      per: 9, sway: 0.12, topFade: 0.05, cover: 0.03, conceal: 0.14, los: 0.00, height: 0.49,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#3d6b1c' },
    { id: 'flax',       name: 'Flax',       atlas: 12, mode: 'cross', w: 0.86, h: 0.82, vary: 0.22,
      per: 9, sway: 0.30, topFade: 0.10, cover: 0.03, conceal: 0.11, los: 0.10, height: 0.62,
      burn: true, root: ROOT, blend: 0.4, tint: SPRITE_TINT, swatch: '#558070' },
    { id: 'lavender',   name: 'Lavender',   atlas: 13, mode: 'cross', w: 0.88, h: 0.59, vary: 0.22,
      per: 9, sway: 0.14, topFade: 0.05, cover: 0.03, conceal: 0.11, los: 0.00, height: 0.44,
      burn: true, root: ROOT, blend: 0.35, tint: SPRITE_TINT, swatch: '#6d588f' },
    { id: 'garrigue',   name: 'Garrigue',   atlas: 14, mode: 'card', w: 1.19, h: 0.47, vary: 0.30,
      per: 3, sway: 0.08, topFade: 0.10, cover: 0.05, conceal: 0.13, los: 0.00, height: 0.44,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#997a68' },
    { id: 'stubble',    name: 'Stubble',    atlas: 15, mode: 'cross', w: 1.18, h: 0.15, vary: 0.25,
      per: 9, sway: 0.04, topFade: 0.00, cover: 0.02, conceal: 0.05, los: 0.00, height: 0.12,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#ba993b' },
    { id: 'rice',       name: 'Rice paddy', atlas: 16, mode: 'cross', w: 0.91, h: 0.80, vary: 0.20,
      per: 9, sway: 0.30, topFade: 0.20, cover: 0.03, conceal: 0.16, los: 0.18, height: 0.67,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#59971c' },
    { id: 'sedge',      name: 'Sedge',      atlas: 17, mode: 'cross', w: 1.07, h: 0.69, vary: 0.25,
      per: 9, sway: 0.26, topFade: 0.10, cover: 0.03, conceal: 0.14, los: 0.12, height: 0.53,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#516825' },
    { id: 'marram',     name: 'Marram grass', atlas: 18, mode: 'cross', w: 1.02, h: 0.94, vary: 0.28,
      per: 9, sway: 0.30, topFade: 0.15, cover: 0.03, conceal: 0.14, los: 0.17, height: 0.71,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#8fa26d' },
    { id: 'barley',     name: 'Barley',     atlas: 19, mode: 'cross', w: 1.15, h: 0.81, vary: 0.18,
      per: 9, sway: 0.34, topFade: 0.30, cover: 0.03, conceal: 0.20, los: 0.27, height: 0.76,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#c6b23b' },
    { id: 'oats',       name: 'Oats',       atlas: 20, mode: 'cross', w: 0.95, h: 0.98, vary: 0.18,
      per: 9, sway: 0.34, topFade: 0.30, cover: 0.03, conceal: 0.21, los: 0.31, height: 0.84,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#85983c' },
    { id: 'rye',        name: 'Rye',        atlas: 21, mode: 'cross', w: 1.19, h: 1.58, vary: 0.16,
      per: 7.4, sway: 0.36, topFade: 0.36, cover: 0.04, conceal: 0.32, los: 0.59, height: 1.33,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#a0a553' },
    { id: 'buckwheat',  name: 'Buckwheat',  atlas: 22, mode: 'cross', w: 0.96, h: 0.85, vary: 0.20,
      per: 9, sway: 0.22, topFade: 0.15, cover: 0.03, conceal: 0.17, los: 0.21, height: 0.71,
      burn: true, root: ROOT, blend: 0.4, tint: SPRITE_TINT, swatch: '#975c37' },
    { id: 'rapeseed',   name: 'Rapeseed',   atlas: 23, mode: 'cross', w: 1.01, h: 1.34, vary: 0.18,
      per: 9, sway: 0.24, topFade: 0.25, cover: 0.04, conceal: 0.27, los: 0.47, height: 1.16,
      burn: true, root: ROOT, blend: 0.35, tint: SPRITE_TINT, swatch: '#a89a0f' },
    { id: 'lupin',      name: 'Lupins',     atlas: 24, mode: 'cross', w: 0.84, h: 0.89, vary: 0.22,
      per: 9, sway: 0.18, topFade: 0.10, cover: 0.03, conceal: 0.15, los: 0.17, height: 0.67,
      burn: true, root: ROOT, blend: 0.4, tint: SPRITE_TINT, swatch: '#5f695c' },
    { id: 'tobacco',    name: 'Tobacco',    atlas: 25, mode: 'cross', w: 1.44, h: 1.61, vary: 0.18,
      per: 6.1, sway: 0.16, topFade: 0.45, cover: 0.04, conceal: 0.34, los: 0.62, height: 1.33,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#50891e' },
    { id: 'beans',      name: 'Field beans', atlas: 26, mode: 'cross', w: 0.83, h: 1.01, vary: 0.18,
      per: 9, sway: 0.18, topFade: 0.25, cover: 0.03, conceal: 0.22, los: 0.33, height: 0.89,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#548046' },
    { id: 'vineyard',   name: 'Vineyard',   atlas: 27, mode: 'cross', w: 1.39, h: 1.42, vary: 0.15,
      per: 7.1, sway: 0.10, topFade: 0.30, cover: 0.06, conceal: 0.30, los: 0.54, height: 1.24,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#4b811b' },
    { id: 'nettles',    name: 'Nettles',    atlas: 28, mode: 'cross', w: 0.92, h: 1.08, vary: 0.22,
      per: 9, sway: 0.18, topFade: 0.20, cover: 0.03, conceal: 0.25, los: 0.40, height: 0.93,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#325e1c' },
    { id: 'thistles',   name: 'Thistles',   atlas: 29, mode: 'cross', w: 0.96, h: 0.93, vary: 0.25,
      per: 9, sway: 0.16, topFade: 0.10, cover: 0.03, conceal: 0.12, los: 0.14, height: 0.71,
      burn: true, root: ROOT, blend: 0.5, tint: SPRITE_TINT, swatch: '#6a6c4f' },
    { id: 'cowparsley', name: 'Cow parsley', atlas: 30, mode: 'cross', w: 1.13, h: 1.17, vary: 0.22,
      per: 9, sway: 0.24, topFade: 0.15, cover: 0.03, conceal: 0.16, los: 0.21, height: 0.89,
      burn: true, root: ROOT, blend: 0.45, tint: SPRITE_TINT, swatch: '#5c8533' },
    { id: 'willowherb', name: 'Willowherb', atlas: 31, mode: 'cross', w: 0.82, h: 1.59, vary: 0.22,
      per: 9, sway: 0.24, topFade: 0.25, cover: 0.04, conceal: 0.20, los: 0.33, height: 1.16,
      burn: true, root: ROOT, blend: 0.4, tint: SPRITE_TINT, swatch: '#c5486e' },
    { id: 'foxglove',   name: 'Foxgloves',  atlas: 32, mode: 'cross', w: 0.87, h: 1.32, vary: 0.22,
      per: 9, sway: 0.18, topFade: 0.15, cover: 0.03, conceal: 0.13, los: 0.15, height: 0.80,
      burn: true, root: ROOT, blend: 0.4, tint: SPRITE_TINT, swatch: '#965077' },
    { id: 'gorse',      name: 'Gorse',      atlas: 33, mode: 'card', w: 1.44, h: 1.34, vary: 0.28,
      per: 3, sway: 0.08, topFade: 0.18, cover: 0.06, conceal: 0.39, los: 0.72, height: 1.24,
      burn: true, root: ROOT, blend: 0.45, tint: SPRITE_TINT, swatch: '#565011' },
    { id: 'broom',      name: 'Broom',      atlas: 34, mode: 'card', w: 1.05, h: 1.56, vary: 0.28,
      per: 3, sway: 0.14, topFade: 0.25, cover: 0.05, conceal: 0.31, los: 0.56, height: 1.42,
      burn: true, root: ROOT, blend: 0.45, tint: SPRITE_TINT, swatch: '#858209' },
    { id: 'bramble',    name: 'Bramble',    atlas: 35, mode: 'card', w: 1.72, h: 0.80, vary: 0.30,
      per: 3, sway: 0.08, topFade: 0.10, cover: 0.06, conceal: 0.25, los: 0.37, height: 0.76,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#3c5b24' },
    { id: 'feathergrass', name: 'Feather grass', atlas: 36, mode: 'cross', w: 1.26, h: 0.54, vary: 0.28,
      per: 9, sway: 0.42, topFade: 0.10, cover: 0.02, conceal: 0.08, los: 0.00, height: 0.36,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#8b9562' },
    { id: 'wormwood',   name: 'Wormwood',   atlas: 37, mode: 'cross', w: 1.01, h: 0.75, vary: 0.25,
      per: 9, sway: 0.18, topFade: 0.10, cover: 0.03, conceal: 0.14, los: 0.14, height: 0.62,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#93985a' },
    { id: 'esparto',    name: 'Esparto grass', atlas: 38, mode: 'cross', w: 1.13, h: 0.88, vary: 0.28,
      per: 9, sway: 0.26, topFade: 0.15, cover: 0.03, conceal: 0.16, los: 0.17, height: 0.62,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#9e904e' },
    { id: 'camelthorn', name: 'Camel thorn', atlas: 39, mode: 'card', w: 1.15, h: 0.58, vary: 0.30,
      per: 3, sway: 0.08, topFade: 0.05, cover: 0.04, conceal: 0.11, los: 0.00, height: 0.49,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#697834' },
    { id: 'cattail',    name: 'Bulrush',    atlas: 40, mode: 'cross', w: 0.93, h: 1.98, vary: 0.20,
      per: 7.6, sway: 0.34, topFade: 0.40, cover: 0.04, conceal: 0.36, los: 0.68, height: 1.69,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#637835' },
    { id: 'rushes',     name: 'Rushes',     atlas: 41, mode: 'cross', w: 0.81, h: 0.94, vary: 0.24,
      per: 9, sway: 0.24, topFade: 0.20, cover: 0.03, conceal: 0.20, los: 0.28, height: 0.80,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#456525' },
    { id: 'sunflower',  name: 'Sunflowers', atlas: 42, mode: 'cross', w: 1.27, h: 2.16, vary: 0.15,
      per: 5.1, sway: 0.16, topFade: 0.45, cover: 0.04, conceal: 0.42, los: 0.81, height: 1.78,
      burn: true, root: ROOT, blend: 0.35, tint: SPRITE_TINT, swatch: '#767e0f' },
    { id: 'hemp',       name: 'Hemp',       atlas: 43, mode: 'cross', w: 1.12, h: 2.18, vary: 0.15,
      per: 5.7, sway: 0.22, topFade: 0.50, cover: 0.05, conceal: 0.45, los: 0.88, height: 2.04,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#37801a' },
    { id: 'sorghum',    name: 'Sorghum',    atlas: 44, mode: 'cross', w: 1.54, h: 2.30, vary: 0.15,
      per: 4, sway: 0.22, topFade: 0.50, cover: 0.05, conceal: 0.44, los: 0.85, height: 1.87,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#5c851c' },
    { id: 'sugarcane',  name: 'Sugar cane', atlas: 45, mode: 'cross', w: 2.15, h: 3.30, vary: 0.18,
      per: 2, sway: 0.20, topFade: 0.55, cover: 0.05, conceal: 0.55, los: 1.25, height: 2.84,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#579f20' },
    { id: 'kunai',      name: 'Kunai grass', atlas: 46, mode: 'cross', w: 1.21, h: 1.45, vary: 0.22,
      per: 8, sway: 0.34, topFade: 0.38, cover: 0.04, conceal: 0.33, los: 0.60, height: 1.24,
      burn: true, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#729122' },
    { id: 'bamboo',     name: 'Bamboo',     atlas: 47, mode: 'cross', w: 2.24, h: 5.12, vary: 0.18,
      per: 1.2, sway: 0.20, topFade: 0.55, cover: 0.08, conceal: 0.55, los: 1.25, height: 4.00,
      burn: false, root: ROOT, blend: 0.6, tint: SPRITE_TINT, swatch: '#568c1b' },
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
  // (round 113) THE SOWN KINDS: a map that sows one gets a field to the edge
  // of its plough (`sow` in the main file), where a wild plant clumps
  ['wheat', 'clover', 'beet', 'potato', 'flax', 'lavender', 'stubble', 'rice', 'barley', 'oats', 'rye', 'buckwheat',
   'rapeseed', 'lupin', 'tobacco', 'beans', 'vineyard', 'sunflower', 'hemp', 'sorghum', 'sugarcane'].forEach(function (id) { BY_ID[id].crop = true; });

  // =========================================================================
  // (round 113) THE THEATRE'S PLANTS — what `flora` grows where
  // -------------------------------------------------------------------------
  // Every map's crop is wheat and its wild ground eight kinds, because that is
  // all there was. A theatre is a season and a country: Normandy in June is
  // wheat, barley, oats, clover ley, beet and potatoes in small fields, with
  // poppies and cow parsley in the grass; Arnhem in September is stubble,
  // beet and potatoes; the steppe is rye and sunflowers to the horizon with
  // feather grass and wormwood between; Italy is wheat, vines, maize and
  // tobacco; the Pacific rice, cane, kunai grass and bamboo; and on every
  // bombed street, rosebay willowherb.
  //
  //  field    Voronoi spacing of the crop fields, in cells (a cell is 6 m)
  //  crops    what a sown field (wheat) becomes, per field, by weight
  //  tall     what tall grass becomes outright (the Pacific's kunai)
  //  meadow   patches in grass where a smooth noise passes `cut`
  //  wood / marsh / heath / scrub   the same for bracken, reeds, heather, brush
  //  rubble   sparse colonists on rubble ground that carries nothing
  //  cut / cuts  the noise level each patch starts at. The noise (`patchy`
  //           in `flora`) is measured: 12% of cells lie above 0.78, 20% above
  //           0.71, 40% above 0.57, half above 0.51 — so grass keeps seven
  //           eighths of itself and a marsh is half reeds, half the rest
  var FLORA_BASE = {
    wood:   [['bramble', 3], ['foxglove', 2], ['nettles', 2], ['willowherb', 1]],
    marsh:  [['cattail', 3], ['rushes', 3], ['sedge', 2]],
    heath:  [['gorse', 3], ['broom', 2], ['marram', 2]],
    scrub:  [['bramble', 3], ['gorse', 2], ['broom', 2]],
    rubble: [['willowherb', 3], ['nettles', 2]],
  };
  var FLORA_CUTS = { wood: 0.71, marsh: 0.51, heath: 0.57, scrub: 0.71, rubble: 0.64 };
  function flora(o) {
    for (var k in FLORA_BASE) if (!(k in o)) o[k] = FLORA_BASE[k];
    if (o.cut === undefined) o.cut = 0.78;
    o.cuts = o.cuts || {};
    for (var c in FLORA_CUTS) if (o.cuts[c] === undefined) o.cuts[c] = FLORA_CUTS[c];
    return o;
  }
  var FLORA = {
    normandy: flora({ field: 18,
      crops:  [['wheat', 30], ['barley', 14], ['oats', 14], ['clover', 10], ['beet', 8], ['potato', 7], ['buckwheat', 6], ['flax', 5], ['beans', 4], ['stubble', 2]],
      meadow: [['poppies', 3], ['cowparsley', 3], ['thistles', 2], ['nettles', 2], ['clover', 2], ['foxglove', 1]] }),
    france40: flora({ field: 20,
      crops:  [['wheat', 30], ['barley', 12], ['oats', 12], ['rapeseed', 10], ['clover', 10], ['beet', 8], ['potato', 8], ['flax', 6], ['lupin', 4]],
      meadow: [['poppies', 4], ['cowparsley', 3], ['clover', 2], ['thistles', 1]] }),
    lowlands: flora({ field: 16,
      crops:  [['stubble', 26], ['beet', 24], ['potato', 18], ['clover', 10], ['buckwheat', 8], ['beans', 7], ['oats', 7]],
      meadow: [['thistles', 2], ['nettles', 2], ['clover', 2], ['cowparsley', 1]],
      marsh:  [['rushes', 4], ['cattail', 3], ['sedge', 3]],
      heath:  [['broom', 3], ['gorse', 2], ['marram', 1]],
      wood:   [['bramble', 3], ['nettles', 2], ['willowherb', 2], ['foxglove', 1]] }),
    east: flora({ field: 34, cut: 0.68,
      crops:  [['wheat', 24], ['rye', 18], ['sunflower', 16], ['buckwheat', 10], ['beet', 8], ['potato', 8], ['hemp', 6], ['flax', 5], ['corn', 5]],
      meadow: [['feathergrass', 3], ['wormwood', 3], ['thistles', 2], ['nettles', 1]],
      wood:   [['nettles', 2], ['willowherb', 2], ['bramble', 1]],
      marsh:  [['cattail', 3], ['sedge', 3], ['rushes', 2]],
      heath:  [['wormwood', 3], ['feathergrass', 3]],
      scrub:  [['wormwood', 2], ['broom', 1]],
      rubble: [['nettles', 3], ['willowherb', 2]] }),
    italy: flora({ field: 14,
      crops:  [['wheat', 28], ['vineyard', 18], ['corn', 12], ['tobacco', 10], ['beans', 10], ['hemp', 8], ['sorghum', 6], ['sunflower', 4], ['lavender', 4]],
      meadow: [['poppies', 3], ['garrigue', 3], ['thistles', 2], ['broom', 1], ['lavender', 1]],
      wood:   [['bramble', 3], ['broom', 1], ['nettles', 1]],
      marsh:  [['cattail', 2], ['rushes', 2], ['sedge', 2]],
      heath:  [['garrigue', 4], ['broom', 2], ['lavender', 1]],
      scrub:  [['garrigue', 3], ['broom', 3]],
      rubble: [['nettles', 2], ['willowherb', 1]] }),
    desert: flora({ field: 16, cut: 0.69,
      crops:  [['barley', 45], ['stubble', 25], ['sorghum', 15], ['beans', 15]],
      meadow: [['esparto', 3], ['camelthorn', 2], ['wormwood', 1]],
      wood:   [['camelthorn', 1], ['esparto', 1]],
      marsh:  [['rushes', 2], ['sedge', 1], ['cattail', 1]],
      heath:  [['esparto', 3], ['camelthorn', 3]],
      scrub:  [['camelthorn', 3], ['garrigue', 1]],
      rubble: [['camelthorn', 1]] }),
    pacific: flora({ field: 12, cut: 0.61, tall: 'kunai',
      crops:  [['rice', 45], ['sugarcane', 35], ['corn', 10], ['sorghum', 10]],
      meadow: [['kunai', 1]],
      wood:   [['bamboo', 1]],
      marsh:  [['sedge', 2], ['rushes', 2], ['cattail', 1]],
      heath:  [['kunai', 1]],
      scrub:  [['bamboo', 2], ['kunai', 2]],
      rubble: [['kunai', 1]] }),
    ardennes: flora({ field: 16, cut: 0.86,
      crops:  [['stubble', 50], ['beet', 20], ['clover', 15], ['potato', 15]],
      meadow: [['thistles', 1], ['nettles', 1]] }),
    germany45: flora({ field: 22,
      crops:  [['rye', 25], ['wheat', 20], ['rapeseed', 14], ['beet', 14], ['potato', 12], ['lupin', 10], ['clover', 5]],
      meadow: [['cowparsley', 3], ['nettles', 2], ['clover', 2], ['thistles', 1]] }),
  };
  /** The map's `era` -> its plants. Anything not listed is Normandy — except
   *  where the map's NAME says otherwise: the generic eras ('WWII', 'Four
   *  Ways') hold the Kursk steppe and the Sangro too. */
  var NAME_FLORA = [
    [/steppe|kursk|kharkov|stalingrad|prokhorovka|ukrain|russia|smolensk|rzhev|kiev|minsk|dnieper/i, 'east'],
    [/sangro|cassino|anzio|ortona|salerno|rapido|sicil|ital|gothic line/i, 'italy'],
    [/desert|tobruk|alamein|gazala|tunis|libya|kasserine/i, 'desert'],
    [/pacific|guadalcanal|iwo|okinawa|saipan|peleliu|tarawa|betio|jungle|island/i, 'pacific'],
    [/arnhem|nijmegen|eindhoven|holland|dutch|polder|market garden/i, 'lowlands'],
  ];
  function floraFor(era, name) {
    var key = ERA_FLORA[era];
    if (!key || key === 'normandy') {
      for (var i = 0; i < NAME_FLORA.length && name; i++) if (NAME_FLORA[i][0].test(name)) return NAME_FLORA[i][1];
    }
    return key || 'normandy';
  }
  var ERA_FLORA = {
    'Normandy 1944': 'normandy', 'WWII': 'normandy', 'Four Ways': 'normandy',
    'France 1940': 'france40', 'Market Garden': 'lowlands', 'The Eastern Front': 'east',
    'Italy': 'italy', 'The Desert': 'desert', 'The Pacific': 'pacific',
    'The Ardennes': 'ardennes', 'Germany 1945': 'germany45',
  };

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
  // 8 columns x 6 rows of 256px cells in a 2048x1536 texture: the first row
  // painted here, the five under it the Blender cells (round 113). Every
  // sprite is drawn inside a padded box so mip generation never bleeds one
  // cell into its neighbour at the levels foliage is actually visible at.
  var ATLAS_COLS = 8, ATLAS_ROWS = 6, ATLAS_CELL = 256, ATLAS_PAD = 10, ATLAS_PAINTED = 8;
  var FOL_NEAR_GAIN = 0.55;      // (round 115) of the tint's gain, where a texel is a pixel or more

  // ===========================================================================
  // (round 120, `game.foliage120`) THE FIELD THE REFERENCES DRAW
  // ---------------------------------------------------------------------------
  // "better foliage modeling ... overall I want the graphics to improve
  // significantly" — the owner. The eight kinds the whole map is mostly made of
  // (meadow and tall grass, wheat, maize, bracken, reeds, heather, brush) were
  // canvas scribbles: a few dozen fat strokes, one drawing each, so a meadow was
  // the same tuft a hundred thousand times. ON, they are drawn from Blender
  // models (tools/blender/plants120.py, assets/foliage_sprites120.js — loaded
  // only when the switch is on), several drawings to a kind, picked per plant;
  // the light comes through a blade with the sun behind it; the wind rolls
  // across the field in gusts you can watch travel; and from the strategic
  // camera the field is a CARPET (`_carpet120`): an opaque-cost layer on the
  // ground in the crop's own far colour, so fewer, smaller cards are needed
  // over it and the field runs to the horizon without a ring where the cards
  // stop. DRAWING ONLY: which cell carries what plant, how dense and how tall
  // (`coverAt`, `concealAt`, `heightAt`, `occlusionAt`) are not touched.
  // OFF (the default) is the round-119 field exactly: its own atlas, material,
  // depth material and build.
  //
  //  V120     kind -> the ids (in FOLIAGE_SPRITES120) of the drawings it picks
  //           from; a kind not listed keeps its round-113 cell
  //  BAND120  per zoom band: the share of the band's density drawn as blades,
  //           and the cap on how much a far card is blown up (round 108's
  //           `sizeBoost`, 1.75): the carpet carries the coverage instead
  var A120_COLS = 8, A120_ROWS = 9, A120_FIRST = 48;
  var V120 = {
    grass:     ['grass_a', 'grass_b', 'grass_c', 'grass_d'],
    tallgrass: ['tall_a', 'tall_b'],
    wheat:     ['wheat_a', 'wheat_b'],
    corn:      ['corn_a'],
    fern:      ['fern_a'],
    reeds:     ['reeds_a'],
    heather:   ['heather_a'],
    brush:     ['brush_a', 'brush_b', 'brush_c'],
    sunflower: ['sun_f'],
    stubble:   ['dry_a'],
  };
  // the theatre's season: summer-dry grass on the steppe, in Italy and the desert, dead grass under snow
  var V120T = {
    east:   { grass: ['grass_a', 'grass_d', 'dry_a', 'grass_c'], tallgrass: ['tall_a', 'dry_b', 'tall_b'], brush: ['brush_a', 'brush_c'] },
    italy:  { grass: ['grass_d', 'dry_a', 'grass_c', 'grass_b'], tallgrass: ['tall_a', 'dry_b'], brush: ['brush_b', 'brush_a'] },
    desert: { grass: ['dry_a', 'dry_b', 'grass_d'], tallgrass: ['dry_b', 'dry_a'], brush: ['brush_b'] },
    pacific: { brush: ['tropic_a', 'brush_b'] },
    winter: { grass: ['dry_a', 'grass_d'], tallgrass: ['dry_b', 'dry_a'], heather: ['dry_a'] },
  };
  // FACING: "sunflowers with heads that face one way" — the owner. A facing kind is turned to one bearing
  // (`yaw`, +- a little; the turn the field's stream drew is still drawn, then mapped onto that), and the
  // side of each quad that looks away from it shows the plant from BEHIND (`back`, drawn mirrored, so its
  // silhouette and its shadow are the front's): a field of faces from one side, of green backs from the other
  var FACE120 = { sunflower: { back: 'sun_b', yaw: Math.PI / 4, spread: 0.45 } };
  // their colour is in the drawing: a neutral tint a shade under the forty's (they were lit a little brighter)
  var TINT120 = [0x646464, 0x686660, 0x60645e];
  // near the eye (bands 0 and 1) a meadow is a sward, not tufts on a lawn: more of the grasses
  var NEAR120 = { grass: 1.3, tallgrass: 1.2 };
  var BAND120 = [
    { dens: 1.00, boost: 1.75, fade: 1.00 },
    { dens: 1.00, boost: 1.60, fade: 1.00 },
    { dens: 0.85, boost: 1.45, fade: 0.90 },
    { dens: 0.60, boost: 1.30, fade: 0.70 },
    { dens: 0.55, boost: 1.25, fade: 0.62 },
  ];
  // the carpet: cover near the eye (its share of the cell's density), and the
  // distances (x the band's fade) over which it comes up to full
  var CARPET120 = { near: 0.0, from: 0.30, to: 0.95, reg: 6, mottle: 0.14, cap: 0.7 };
  // the light: transmission through a blade toward a low sun, the bright sheen
  // a gust lays on a bending crop, and the colour patches across a field
  var LOOK120 = { trans: 0.55, sheen: 0.16, gustScale: 0.11, gustSpeed: 1.1, gust: 1.0, varScale: 0.045, varAmt: 0.20, dry: 0.30 };
  /** Is the round-120 field asked for? Read once a frame by `update`. */
  function on120() { var g = window.game; return !!(g && g.foliage120 === true); }

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
    // (round 113) read back once for the mip chain (`buildMips`): a canvas
    // kept in memory reads back in a few ms, a GPU one pays a readback
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (var k = 0; k < ATLAS_PAINTED; k++) {
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
    pasteSprites(cv, _atlas);
    return _atlas;
  }

  /** (round 113) THE FORTY BLENDER KINDS. assets/foliage_sprites.js carries
   *  their cells (tools/blender/plants.py) as a JPEG of colour and a grey PNG
   *  of coverage — a third of the bytes of one RGBA PNG, whose anti-aliased
   *  edges do not compress. This puts the two back together and copies each
   *  kind's cell to its atlas slot, then re-uploads the atlas. Decoding is
   *  asynchronous: until it lands those kinds cut away to nothing, exactly as
   *  if their cells were empty, and a page without the file never draws them
   *  (`Foliage.sprites()` says which). Purely cosmetic either way. */
  var spritesState = 'none', spritesMs = null;

  /** (round 113) THE ATLAS'S MIP CHAIN, BUILT HERE ONCE THE BLENDER CELLS ARE
   *  IN — because a plant drawn true does not survive the GPU's own.
   *
   *  The painted kinds are blades four to eight pixels wide; a real stalk is
   *  two. From the tactical camera a crop quad is ~16 px tall, so it is drawn
   *  from mip level 4, where every 16 x 16 block of the cell is one texel and
   *  its alpha is the block's coverage: a field of thin stalks falls under the
   *  0.26 cutout everywhere but in its ears, and a barley field read as bare
   *  ground with a few streaks across it (round 113, measured on Village). And
   *  a box filter averages the black of the empty texels into the colour, so
   *  what does survive is darkened by its own coverage — the reason the painted
   *  tints carry a gain of 2.35, and why painted wheat burns white up close.
   *
   *  So, for the Blender cells only, the alpha is scaled per cell per level so
   *  that the same share of the cell passes the cut as passes it at level 0
   *  (the coverage-preserving mipmaps of Castaño, 2010) — the plant keeps its
   *  body at every distance. Its colour is the ALPHA-WEIGHTED mean of the
   *  texels under it, darkened by the square root of their coverage: the true
   *  colour, with no darkening at all, read as pale mint specks on the stubble
   *  where every painted clump beside it is a dark tuft (the painted tints and
   *  the field's whole look are tuned to that darkening), and the box filter's
   *  full darkening is the "moss" the 2.35 gain was put in to undo. A tuft
   *  seen from a distance is darker than its sunlit leaf; this is half way.
   *  (A/B'd on Village from the tactical camera, round 113.) Everything else — the eight
   *  painted cells and the padding — gets the plain 2 x 2 box average the GPU
   *  would have made, so the old kinds look exactly as they did. One pass at
   *  load, ~4 M texel visits; `MIP_KEEP = false` hands the chain back to GL. */
  var MIP_KEEP = true, MIP_CUT = 0.26, MIP_MAX_GAIN = 6, HB = 512, HIST = new Uint32Array(HB);
  function buildMips(cv, tex) {
    var W = cv.width, H = cv.height, C = ATLAS_CELL;
    var base = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
    var mips = [cv], levels = [base.data], dims = [[W, H]];
    // 1) the GPU's chain: a 2 x 2 box average of the level above — over the
    //    painted row only while a cell is still a pixel or more, since step 2
    //    writes every texel of the rows under it; the levels smaller than a
    //    cell are made again from the finished chain in step 3
    var w = W, h = H, src = base.data, lvl = 0, paintedH = Math.ceil(ATLAS_PAINTED / ATLAS_COLS) * C;
    function box(src, w, h, dst, dw, dh, yEnd) {
      for (var y = 0; y < yEnd; y++) {
        var y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        for (var x = 0; x < dw; x++) {
          var x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
          var a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4, o = (y * dw + x) * 4;
          dst[o] = (src[a] + src[b] + src[c] + src[d] + 2) >> 2;
          dst[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1] + 2) >> 2;
          dst[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2] + 2) >> 2;
          dst[o + 3] = (src[a + 3] + src[b + 3] + src[c + 3] + src[d + 3] + 2) >> 2;
        }
      }
    }
    while (w > 1 || h > 1) {
      var dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1);
      var dst = new Uint8ClampedArray(dw * dh * 4);
      lvl++;
      box(src, w, h, dst, dw, dh, (C >> lvl) >= 1 ? Math.min(dh, paintedH >> lvl) : dh);
      levels.push(dst); dims.push([dw, dh]);
      src = dst; w = dw; h = dh;
    }
    // 2) the Blender cells, remade level by level from sums carried down the chain
    var n0 = C * C, A = new Float32Array(n0), R = new Float32Array(n0), G2 = new Float32Array(n0), B = new Float32Array(n0);
    for (var k = 0; k < DEFS.length; k++) {
      var def = DEFS[k];
      if (def.atlas < ATLAS_PAINTED) continue;
      var cx = (def.atlas % ATLAS_COLS) * C, cy = Math.floor(def.atlas / ATLAS_COLS) * C;
      var cov0 = 0, i, j;
      for (j = 0; j < C; j++) for (i = 0; i < C; i++) {
        var q = ((cy + j) * W + cx + i) * 4, t = j * C + i, al = base.data[q + 3] / 255;
        A[t] = al; R[t] = base.data[q] * al; G2[t] = base.data[q + 1] * al; B[t] = base.data[q + 2] * al;
        if (al >= MIP_CUT) cov0++;
      }
      cov0 /= n0;
      var cs = C;
      for (var L = 1; L < levels.length && cs > 1; L++) {
        var ns = cs >> 1, lw = dims[L][0], out = levels[L];
        // sums of 2 x 2 blocks, in place at the top-left of the arrays
        for (j = 0; j < ns; j++) for (i = 0; i < ns; i++) {
          var p0 = (j * 2) * cs + i * 2, p1 = p0 + 1, p2 = p0 + cs, p3 = p2 + 1, t2 = j * ns + i;
          var sa = A[p0] + A[p1] + A[p2] + A[p3], sr = R[p0] + R[p1] + R[p2] + R[p3];
          var sg = G2[p0] + G2[p1] + G2[p2] + G2[p3], sb = B[p0] + B[p1] + B[p2] + B[p3];
          A[t2] = sa; R[t2] = sr; G2[t2] = sg; B[t2] = sb;
        }
        cs = ns;
        var area = Math.pow(4, L), cnt = cs * cs;
        // the gain that lets the level-0 share of the cell through the cut:
        // the coverage value at that share, read off a histogram (a sort of a
        // level-1 cell is 16,384 numbers, forty times)
        var vals = new Float32Array(cnt);
        HIST.fill(0);
        for (i = 0; i < cnt; i++) { var v1 = vals[i] = A[i] / area; HIST[Math.min(HB - 1, (v1 * HB) | 0)]++; }
        // (the bin's lower edge, and aimed a little over the cut: a gain that
        // lands a texel exactly on 0.26 rounds it to 66/255 and the test drops it)
        var want = Math.floor(cov0 * cnt), seen = 0, at = 0;
        for (var hb = HB - 1; hb >= 0; hb--) { seen += HIST[hb]; if (seen > want) { at = Math.max(hb, 0.5) / HB; break; } }
        var gain = at > 1e-4 ? Math.max(1, Math.min(MIP_MAX_GAIN, MIP_CUT * 1.12 / at)) : 1;
        var ox = cx >> L, oy = cy >> L;
        for (j = 0; j < cs; j++) for (i = 0; i < cs; i++) {
          var t3 = j * cs + i, o2 = ((oy + j) * lw + ox + i) * 4, sa2 = A[t3];
          if (sa2 > 1e-6) {
            var dk = Math.sqrt(Math.min(1, vals[t3]));
            out[o2] = R[t3] / sa2 * dk; out[o2 + 1] = G2[t3] / sa2 * dk; out[o2 + 2] = B[t3] / sa2 * dk;
          } else { out[o2] = out[o2 + 1] = out[o2 + 2] = 0; }
          out[o2 + 3] = Math.min(255, Math.round(vals[t3] * gain * 255));
        }
      }
    }
    // 3) below a pixel a cell, the plain average of the finished level above
    for (var m3 = 1; m3 < levels.length; m3++) if ((C >> m3) < 1)
      box(levels[m3 - 1], dims[m3 - 1][0], dims[m3 - 1][1], levels[m3], dims[m3][0], dims[m3][1], dims[m3][1]);
    for (var m = 1; m < levels.length; m++) mips.push(new ImageData(levels[m], dims[m][0], dims[m][1]));
    tex.mipmaps = mips;
    tex.generateMipmaps = false;
  }

  function pasteSprites(cv, tex) {
    var S = window.FOLIAGE_SPRITES;
    if (!S || !S.jpg || !S.alpha || typeof Image === 'undefined') { spritesState = 'absent'; return; }
    spritesState = 'loading';
    var rgb = new Image(), cov = new Image(), n = 0;
    function done() {
      if (++n < 2) return;
      var t0 = performance.now();
      try {
        var w = rgb.width, h = rgb.height;
        var c1 = document.createElement('canvas'); c1.width = w; c1.height = h;
        var x1 = c1.getContext('2d', { willReadFrequently: true });   // read back, not drawn: keep it in memory
        x1.drawImage(rgb, 0, 0);
        var px = x1.getImageData(0, 0, w, h), d = px.data;
        x1.clearRect(0, 0, w, h);
        x1.drawImage(cov, 0, 0);
        var al = x1.getImageData(0, 0, w, h).data;
        for (var i = 3; i < d.length; i += 4) d[i] = al[i - 3];
        var ctx = cv.getContext('2d'), C = S.cell || ATLAS_CELL, cols = S.cols || 8;
        for (var k = 0; k < DEFS.length; k++) {
          var def = DEFS[k], j = S.ids.indexOf(def.id);
          if (j < 0 || def.atlas < ATLAS_PAINTED) continue;
          var sx = (j % cols) * C, sy = Math.floor(j / cols) * C;
          var ax = (def.atlas % ATLAS_COLS) * ATLAS_CELL, ay = Math.floor(def.atlas / ATLAS_COLS) * ATLAS_CELL;
          ctx.putImageData(px, ax - sx, ay - sy, sx, sy, C, C);
        }
        var t1 = performance.now();
        if (MIP_KEEP) buildMips(cv, tex);
        tex.needsUpdate = true;
        spritesState = 'ready';
        spritesMs = [t1 - t0, performance.now() - t1];
      } catch (e) { spritesState = 'failed'; if (window.console) console.warn('foliage sprites:', e.message); }
    }
    rgb.onload = cov.onload = done;
    rgb.onerror = cov.onerror = function () { spritesState = 'failed'; };
    rgb.src = 'data:image/jpeg;base64,' + S.jpg;
    cov.src = 'data:image/png;base64,' + S.alpha;
  }

  // =========================================================================
  // (round 120) THE ON ATLAS — `game.foliage120`
  // =========================================================================
  // The round-113 atlas's 48 cells in the same places, and under them (rows 6
  // and 7) the drawings of assets/foliage_sprites120.js. A texture, a mip chain
  // and a material of its own, so the OFF field is the round-119 one to the
  // byte; built, and the sprites fetched, the first time the switch is on.
  var _atlas120 = null, sprites120 = 'none', sprites120Ms = null, cellFar120 = null, CELLQ120 = {};
  function atlasTexture120() {
    if (_atlas120) return _atlas120;
    var cv = document.createElement('canvas');
    cv.width = A120_COLS * ATLAS_CELL;
    cv.height = A120_ROWS * ATLAS_CELL;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (var k = 0; k < ATLAS_PAINTED; k++) {
      var cx = (k % A120_COLS) * ATLAS_CELL, cy = Math.floor(k / A120_COLS) * ATLAS_CELL;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath(); ctx.rect(0, 0, ATLAS_CELL, ATLAS_CELL); ctx.clip();
      drawSprite(ctx, k, ATLAS_CELL, rngFrom(1337 + k * 7919));
      ctx.restore();
    }
    _atlas120 = new THREE.CanvasTexture(cv);
    _atlas120.wrapS = _atlas120.wrapT = THREE.ClampToEdgeWrapping;
    _atlas120.magFilter = THREE.LinearFilter;
    _atlas120.minFilter = THREE.LinearMipmapLinearFilter;
    _atlas120.generateMipmaps = true;
    _atlas120.anisotropy = 4;
    load120(cv, _atlas120);
    return _atlas120;
  }
  /** A sprite sheet's JPEG colour and PNG coverage, put back together (as `pasteSprites`). */
  function decodeSheet120(S, cb) {
    var rgb = new Image(), cov = new Image(), n = 0, bad = false;
    function done() {
      if (++n < 2 || bad) return;
      try {
        var w = rgb.width, h = rgb.height;
        var c1 = document.createElement('canvas'); c1.width = w; c1.height = h;
        var x1 = c1.getContext('2d', { willReadFrequently: true });
        x1.drawImage(rgb, 0, 0);
        var px = x1.getImageData(0, 0, w, h), d = px.data;
        x1.clearRect(0, 0, w, h);
        x1.drawImage(cov, 0, 0);
        var al = x1.getImageData(0, 0, w, h).data;
        for (var i = 3; i < d.length; i += 4) d[i] = al[i - 3];
        cb(px);
      } catch (e) { cb(null); }
    }
    rgb.onload = cov.onload = done;
    rgb.onerror = cov.onerror = function () { if (!bad) { bad = true; cb(null); } };
    rgb.src = 'data:image/jpeg;base64,' + S.jpg;
    cov.src = 'data:image/png;base64,' + S.alpha;
  }
  function load120(cv, tex) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') { sprites120 = 'absent'; return; }
    sprites120 = 'loading';
    function go() {
      var S0 = window.FOLIAGE_SPRITES, S1 = window.FOLIAGE_SPRITES120, ctx = cv.getContext('2d'), left = 0, t0 = performance.now();
      function fin() {
        if (--left > 0) return;
        try {
          var t1 = performance.now();
          buildMips120(cv, tex);
          cellFar120 = farColours120(tex);
          tex.needsUpdate = true;
          sprites120 = S1 && Object.keys(CELLQ120).length ? 'ready' : 'absent';
          sprites120Ms = [t1 - t0, performance.now() - t1];
        } catch (e) { sprites120 = 'failed'; if (window.console) console.warn('foliage120 atlas:', e.message); }
      }
      if (S0 && S0.jpg && S0.alpha) {
        left++;
        decodeSheet120(S0, function (px) {
          if (px) {
            var C = S0.cell || ATLAS_CELL, cols = S0.cols || 8;
            for (var k = 0; k < DEFS.length; k++) {
              var def = DEFS[k], j = S0.ids.indexOf(def.id);
              if (j < 0 || def.atlas < ATLAS_PAINTED) continue;
              var sx = (j % cols) * C, sy = Math.floor(j / cols) * C;
              var ax = (def.atlas % A120_COLS) * ATLAS_CELL, ay = Math.floor(def.atlas / A120_COLS) * ATLAS_CELL;
              ctx.putImageData(px, ax - sx, ay - sy, sx, sy, C, C);
            }
          }
          fin();
        });
      }
      if (S1 && S1.jpg && S1.alpha) {
        left++;
        decodeSheet120(S1, function (px) {
          if (px) {
            var C = S1.cell || ATLAS_CELL, cols = S1.cols || 8;
            for (var j = 0; j < S1.ids.length; j++) {
              var cell = A120_FIRST + j;
              if (cell >= A120_COLS * A120_ROWS) break;
              var sx = (j % cols) * C, sy = Math.floor(j / cols) * C;
              var ax = (cell % A120_COLS) * ATLAS_CELL, ay = Math.floor(cell / A120_COLS) * ATLAS_CELL;
              ctx.putImageData(px, ax - sx, ay - sy, sx, sy, C, C);
              CELLQ120[S1.ids[j]] = { cell: cell, q: (S1.quad && S1.quad[S1.ids[j]]) || null };
            }
          }
          fin();
        });
      }
      if (!left) { left = 1; fin(); }
    }
    if (window.FOLIAGE_SPRITES120) go();
    else {
      // loaded on demand: OFF pages never fetch it
      var s = document.createElement('script');
      s.src = 'assets/foliage_sprites120.js';
      s.onload = go;
      s.onerror = go;        // without it the ON field draws the round-113 cells
      document.head.appendChild(s);
    }
  }
  /** `buildMips` for the ON atlas: the painted row on GL's 2 x 2 box, every
   *  other cell — the forty and the new — coverage-preserving, by the same
   *  rule and the same numbers. */
  function buildMips120(cv, tex) {
    var W = cv.width, H = cv.height, C = ATLAS_CELL, COLS = A120_COLS;
    var base = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
    var mips = [cv], levels = [base.data], dims = [[W, H]];
    var w = W, h = H, src = base.data, lvl = 0, paintedH = Math.ceil(ATLAS_PAINTED / COLS) * C;
    function box(src, w, h, dst, dw, dh, yEnd) {
      for (var y = 0; y < yEnd; y++) {
        var y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        for (var x = 0; x < dw; x++) {
          var x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
          var a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4, o = (y * dw + x) * 4;
          dst[o] = (src[a] + src[b] + src[c] + src[d] + 2) >> 2;
          dst[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1] + 2) >> 2;
          dst[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2] + 2) >> 2;
          dst[o + 3] = (src[a + 3] + src[b + 3] + src[c + 3] + src[d + 3] + 2) >> 2;
        }
      }
    }
    while (w > 1 || h > 1) {
      var dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1);
      var dst = new Uint8ClampedArray(dw * dh * 4);
      lvl++;
      box(src, w, h, dst, dw, dh, (C >> lvl) >= 1 ? Math.min(dh, paintedH >> lvl) : dh);
      levels.push(dst); dims.push([dw, dh]);
      src = dst; w = dw; h = dh;
    }
    var n0 = C * C, A = new Float32Array(n0), R = new Float32Array(n0), G2 = new Float32Array(n0), B = new Float32Array(n0);
    for (var k = ATLAS_PAINTED; k < A120_COLS * A120_ROWS; k++) {
      var cx = (k % COLS) * C, cy = Math.floor(k / COLS) * C;
      var cov0 = 0, i, j;
      for (j = 0; j < C; j++) for (i = 0; i < C; i++) {
        var q = ((cy + j) * W + cx + i) * 4, t = j * C + i, al = base.data[q + 3] / 255;
        A[t] = al; R[t] = base.data[q] * al; G2[t] = base.data[q + 1] * al; B[t] = base.data[q + 2] * al;
        if (al >= MIP_CUT) cov0++;
      }
      cov0 /= n0;
      var cs = C;
      for (var L = 1; L < levels.length && cs > 1; L++) {
        var ns = cs >> 1, lw = dims[L][0], out = levels[L];
        for (j = 0; j < ns; j++) for (i = 0; i < ns; i++) {
          var p0 = (j * 2) * cs + i * 2, p1 = p0 + 1, p2 = p0 + cs, p3 = p2 + 1, t2 = j * ns + i;
          var sa = A[p0] + A[p1] + A[p2] + A[p3], sr = R[p0] + R[p1] + R[p2] + R[p3];
          var sg = G2[p0] + G2[p1] + G2[p2] + G2[p3], sb = B[p0] + B[p1] + B[p2] + B[p3];
          A[t2] = sa; R[t2] = sr; G2[t2] = sg; B[t2] = sb;
        }
        cs = ns;
        var area = Math.pow(4, L), cnt = cs * cs;
        var vals = new Float32Array(cnt);
        HIST.fill(0);
        for (i = 0; i < cnt; i++) { var v1 = vals[i] = A[i] / area; HIST[Math.min(HB - 1, (v1 * HB) | 0)]++; }
        var want = Math.floor(cov0 * cnt), seen = 0, at = 0;
        for (var hb = HB - 1; hb >= 0; hb--) { seen += HIST[hb]; if (seen > want) { at = Math.max(hb, 0.5) / HB; break; } }
        var gain = at > 1e-4 ? Math.max(1, Math.min(MIP_MAX_GAIN, MIP_CUT * 1.12 / at)) : 1;
        var ox = cx >> L, oy = cy >> L;
        for (j = 0; j < cs; j++) for (i = 0; i < cs; i++) {
          var t3 = j * cs + i, o2 = ((oy + j) * lw + ox + i) * 4, sa2 = A[t3];
          if (sa2 > 1e-6) {
            var dk = Math.sqrt(Math.min(1, vals[t3]));
            out[o2] = R[t3] / sa2 * dk; out[o2 + 1] = G2[t3] / sa2 * dk; out[o2 + 2] = B[t3] / sa2 * dk;
          } else { out[o2] = out[o2 + 1] = out[o2 + 2] = 0; }
          out[o2 + 3] = Math.min(255, Math.round(vals[t3] * gain * 255));
        }
      }
    }
    for (var m3 = 1; m3 < levels.length; m3++) if ((C >> m3) < 1)
      box(levels[m3 - 1], dims[m3 - 1][0], dims[m3 - 1][1], levels[m3], dims[m3][0], dims[m3][1], dims[m3][1]);
    for (var m = 1; m < levels.length; m++) mips.push(new ImageData(levels[m], dims[m][0], dims[m][1]));
    tex.mipmaps = mips;
    tex.generateMipmaps = false;
  }
  /** Each cell's colour as a card shows it from the strategic camera: the mean
   *  of its level-5 texels (8 x 8 a cell) that pass the cut — what `_carpet120`
   *  lays under the cards, so the field and the carpet are one colour. */
  function farColours120(tex) {
    var L = 5, M = tex.mipmaps && tex.mipmaps[L], out = [];
    if (!M || !M.data) return null;
    var cs = ATLAS_CELL >> L, w = M.width, d = M.data, cut = MIP_CUT * 255;
    for (var k = 0; k < A120_COLS * A120_ROWS; k++) {
      var ox = (k % A120_COLS) * cs, oy = Math.floor(k / A120_COLS) * cs, r = 0, g = 0, b = 0, n = 0;
      for (var j = 0; j < cs; j++) for (var i = 0; i < cs; i++) {
        var q = ((oy + j) * w + ox + i) * 4;
        if (d[q + 3] < cut) continue;
        r += d[q]; g += d[q + 1]; b += d[q + 2]; n++;
      }
      out.push(n ? [r / n / 255, g / n / 255, b / n / 255] : null);
    }
    return out;
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
      sh.uniforms.uNear = shared.uNear;         // (round 116) the crop parted round a man's eye, see `setNear`
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
        'uniform vec4  uNear;',
        'uniform vec4  uCloud;',      // xy drift, z scale, w depth
        'uniform vec2  uCloudBand;',
        'varying vec3  vFolTint;',
        'varying float vFolAlpha;',
        'varying float vFolSun;',
        'varying float vFolD;',       // (round 118) the instance's distance from the eye, for `Canopy.near`
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
        // (round 116) -- parted round the first-person eye: what he is lying or kneeling in is
        //    pressed down where he is (`setNear`), so he looks out through it, not into a leaf
        '  if (uNear.w > 0.0) { transformed.y *= mix(0.08, 1.0, smoothstep(uNear.z, uNear.w, distance(iPos.xz, uNear.xy))); }',
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
        '  vFolD     = dCam;',
        '  if (uCloud.w <= 0.001) { vFolSun = 1.0; } else {',
        '    vec2 cp = iPos.xz * uCloud.z + uCloud.xy;',
        '    float cn = folNoise(cp) * 0.62 + folNoise(cp * 2.17 + 11.3) * 0.38;',
        '    vFolSun = 1.0 - uCloud.w * smoothstep(uCloudBand.x, uCloudBand.y, cn);',
        '  }',
        '#else',
        '  vFolAlpha = 1.0; vFolTint = aTint; vFolSun = 1.0; vFolD = 0.0;',
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

      // (round 115) THE 2.35 GAIN IS FOR FAR OFF. It undoes what the mip chain's box filter
      // darkens into a tuft a few pixels tall; at the top of the chain, near the camera and in
      // first person, nothing is darkened and it burned the pale kinds white and the crops a
      // lurid green. Eased off by how many texels a pixel spans: none from the tactical camera.
      sh.fragmentShader = rep(sh.fragmentShader, '#include <map_fragment>', [
        '#include <map_fragment>',
        '#if __VERSION__ >= 300',
        '  vec2 folT = vUv * vec2(' + (ATLAS_COLS * ATLAS_CELL) + '.0, ' + (ATLAS_ROWS * ATLAS_CELL) + '.0);',
        '  float folL = max(length(dFdx(folT)), length(dFdy(folT)));',
        '  diffuseColor.rgb *= vFolTint * mix(' + FOL_NEAR_GAIN.toFixed(3) + ', 1.0, smoothstep(1.0, 5.0, folL));',
        '#else',
        '  diffuseColor.rgb *= vFolTint;',
        '#endif',
        // …and no leaf is whiter than chalk: a gained albedo past 0.45 (linear) rolls off
        // instead of burning out, at any distance; the darker kinds are untouched
        '{ float folY = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
        '  if (folY > 0.45) diffuseColor.rgb *= (0.45 + (folY - 0.45) * 0.15) / folY; }',
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

      // (round 118, `game.fpvNear118`) THE SKY A PLANT IN SHADE LOST. The same
      // fault as the props (assets/canopy.js `C.near`): Lambert multiplies the
      // sun, the sky fill and the bounce by the SUN's shadow mask, so a fern in
      // a pine's shadow or a reed in a hedge's kept only ambient + hemisphere
      // and read as a black card a metre from the eye. Given back where the
      // sun does not reach, near the eye, by the props' own weights; the
      // blades' factor (half way to the leaves'). Off, the branch is skipped.
      var folDL = /reflectedLight\.directDiffuse \*= BRDF_Diffuse_Lambert\( diffuseColor\.rgb \) \* (getShadowMask|folShadowMask)\(\);/;
      var CN = window.Canopy;
      if (CN && CN.near && CN.nearSky && CN.nearSun && folDL.test(sh.fragmentShader)) {
        sh.uniforms.uFolNear = CN.near; sh.uniforms.uFolNearSky = CN.nearSky; sh.uniforms.uFolNearSun = CN.nearSun; sh.uniforms.uFolNearCap = CN.nearCap || { value: 0.35 };
        sh.uniforms.uFolField = CN.nearField || { value: new THREE.Vector4(0, 0, 0, 0) };   // (round 118, `fpvField118`)
        sh.fragmentShader = sh.fragmentShader.replace('varying float vFolSun;',
          'varying float vFolSun;\nvarying float vFolD;\nuniform float uFolNear;\nuniform vec4 uFolNearSky;\nuniform float uFolNearSun;\nuniform float uFolNearCap;\nuniform vec4 uFolField;');
        sh.fragmentShader = sh.fragmentShader.replace(folDL, function (m) { return m + [
          '',
          '\tif (uFolNear > 0.0) {',
          '\t\tvec3 folLw = vec3(0.2126, 0.7152, 0.0722);',
          '\t\tfloat folSunR = dot(reflectedLight.directDiffuse, folLw) / max(dot(diffuseColor.rgb, folLw) * uFolNearSun, 1e-5);',
          '\t\tfloat folShd = 1.0 - smoothstep(0.06, 0.30, folSunR);',
          '\t\tfloat folNr = 1.0 - smoothstep(uFolNearSky.z, uFolNearSky.w, vFolD);',
          '\t\tfloat folInE = dot(reflectedLight.indirectDiffuse, folLw) / max(dot(diffuseColor.rgb, folLw), 1e-5);',
          '\t\tfloat folMul = 1.0 + (uFolNearSky.y - 1.0) * 0.5 * folShd * folNr * uFolNear;',
          '\t\treflectedLight.indirectDiffuse *= min(folMul, max(1.0, uFolNearCap * uFolNearSun / max(folInE, 1e-5)));',
          // (round 118, `Canopy.nearField`) on a bright field the eye adapts to the shade it looks into:
          // a fern in a pine's shadow on snow was black with the lift on (w 0 when off: not taken)
          '\t\tif (uFolField.w > 0.0) reflectedLight.indirectDiffuse *= 1.0 + (uFolField.w - 1.0) * folShd * folNr * uFolNear;',
          '\t}',
        ].join('\n'); });
      }

      if (!ok) _patchOk = false;
    };
    // Two materials with the same `onBeforeCompile` source still compile twice
    // unless they share a cache key. One material for the whole field anyway,
    // but be explicit about it.
    mat.customProgramCacheKey = function () { return 'foliage4' + (shared.oneTapShadow === false ? '' : '|1tap') + (window.Canopy && window.Canopy.near ? '|near118' : ''); };
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
      sh.uniforms.uNear = shared.uNear;
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
        'uniform vec4  uNear;',
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
        // (round 116) -- parted round the first-person eye: what he is lying or kneeling in is
        //    pressed down where he is (`setNear`), so he looks out through it, not into a leaf
        '  if (uNear.w > 0.0) { transformed.y *= mix(0.08, 1.0, smoothstep(uNear.z, uNear.w, distance(iPos.xz, uNear.xy))); }',
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
    dm.customProgramCacheKey = function () { return 'foliageDepth2'; };
    return dm;
  }

  // =========================================================================
  // (round 120) THE ON MATERIALS — composed over the round-119 ones
  // =========================================================================
  // The blades' program is `makeMaterial`'s with four things added; the depth
  // twin is `makeDepthMaterial`'s with the same wind, so the shadow moves with
  // the blade (normandy-shadow-pass-is-blind). Own cache keys.
  //
  //  GUSTS THAT ROLL. The round-119 wind swung every blade about the upright
  //  on a phase fixed to the ground — a field that shimmers in place. Wind
  //  leans a crop DOWNWIND and the gusts are patches of stronger lean carried
  //  downwind at the wind's speed, longer across the wind than along it, so
  //  you watch the fronts cross a wheatfield. A gust also lays a SHEEN: a
  //  bending crop shows the paler side of its stalks.
  //  LIGHT THROUGH A BLADE. Toward a low sun a leaf glows; the sun's colour,
  //  through the plant's own, by how nearly the eye looks into the sun past it,
  //  where the sun reaches it (its shadow mask).
  //  PATCHES. A field is not one green: a low world-space noise moves a plant
  //  lighter or darker and, at its high end, drier — the same field across
  //  the blades and the carpet under them.
  var NOISE120 = [
    'float folHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float folNoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = folHash(i), b = folHash(i + vec2(1.0, 0.0));',
    '  float c = folHash(i + vec2(0.0, 1.0)), d = folHash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
  ].join('\n');
  // `p` the plant's (or the carpet vertex's) world xz; leaves `gust120` 0..1
  function gustGLSL120(p) {
    return [
      '  vec2 wd120 = uWind.xy;',
      '  vec2 wq120 = vec2(dot(' + p + ', wd120), dot(' + p + ', vec2(-wd120.y, wd120.x)) * 0.45);',
      '  vec2 gp120 = (wq120 - vec2(uTime * uWave120.y, 0.0)) * uWave120.x;',
      '  float gust120 = smoothstep(0.28, 0.82, folNoise(gp120) * 0.65 + folNoise(gp120 * 2.3 + 5.1) * 0.35);',
    ].join('\n');
  }
  var G_LINE = '  float g    = sin(uTime * uWind.w + ph) + 0.45 * sin(uTime * uWind.w * 2.7 + ph * 1.9);';
  var G_LINE120 = gustGLSL120('iPos.xz') + '\n' +
    '  float g    = 0.45 + uWave120.z * 1.5 * gust120 + 0.32 * sin(uTime * uWind.w * 2.6 + ph * 1.7);';
  // per instance (or carpet vertex): the colour patch on `t` at world `p`
  function patchGLSL120(t, p) {
    return '  { float cv0 = folNoise(' + p + ' * uVar120.x + 17.3) - 0.5, cv1 = folNoise(' + p + ' * uVar120.x * 3.1 + 3.7) - 0.5;\n' +
           '    ' + t + ' *= 1.0 + (cv0 * 0.8 + cv1 * 0.4) * uVar120.y;\n' +
           '    ' + t + ' = mix(' + t + ', ' + t + ' * vec3(1.10, 1.0, 0.72), clamp(cv0 * 2.0, 0.0, 1.0) * uVar120.z); }';
  }
  function makeMaterial120(shared) {
    var mat = makeMaterial(shared);
    mat.map = atlasTexture120();
    var base = mat.onBeforeCompile, baseKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (sh) {
      base.call(this, sh);
      sh.uniforms.uAtlas = shared.uAtlas120;
      sh.uniforms.uSun120 = shared.uSun120;
      sh.uniforms.uSunCol120 = shared.uSunCol120;
      sh.uniforms.uWave120 = shared.uWave120;
      sh.uniforms.uVar120 = shared.uVar120;
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, 'varying float vFolD;',
        'varying float vFolD;\nuniform vec4  uSun120;\nuniform vec4  uWave120;\nuniform vec4  uVar120;\nvarying float vFolTr120;\nvarying float vFolGust120;');
      sh.vertexShader = rep(sh.vertexShader, 'attribute vec2  aAtlas;', 'attribute vec4  aAtlas;\nvarying vec2  vFolBk120;\nvarying float vFolQ120;');
      sh.vertexShader = rep(sh.vertexShader, 'vUv = uv * uAtlas + aAtlas;', 'vUv = uv * uAtlas + aAtlas.xy; vFolBk120 = uv * uAtlas + aAtlas.zw; vFolQ120 = aQuad;');
      sh.vertexShader = rep(sh.vertexShader, G_LINE, G_LINE120);
      sh.vertexShader = rep(sh.vertexShader, '  vFolD     = dCam;', [
        '  vFolD     = dCam;',
        '  vFolGust120 = gust120;',
        '  vFolTr120 = pow(max(dot(normalize(iPos - uCam), uSun120.xyz), 0.0), 3.0) * uSun120.w;',
        patchGLSL120('vFolTint', 'iPos.xz'),
      ].join('\n'));
      sh.vertexShader = rep(sh.vertexShader, '  vFolAlpha = 1.0; vFolTint = aTint; vFolSun = 1.0; vFolD = 0.0;',
        '  vFolAlpha = 1.0; vFolTint = aTint; vFolSun = 1.0; vFolD = 0.0; vFolGust120 = 0.0; vFolTr120 = 0.0;');
      sh.fragmentShader = rep(sh.fragmentShader, 'varying float vFolSun;',
        'varying float vFolSun;\nuniform vec3  uSunCol120;\nuniform vec4  uWave120;\nvarying float vFolTr120;\nvarying float vFolGust120;\nvarying vec2  vFolBk120;\nvarying float vFolQ120;');
      // the side of a quad that looks away from the plant's bearing shows its back (the third quad is wound
      // the other way round from the first two, so its sides are swapped)
      sh.fragmentShader = rep(sh.fragmentShader, '#include <map_fragment>', [
        '#ifdef USE_MAP',
        '  bool fr120 = gl_FrontFacing; if (vFolQ120 > 1.5) fr120 = !fr120;',
        '  vec4 texelColor = texture2D( map, fr120 ? vUv : vFolBk120 );',
        '  texelColor = mapTexelToLinear( texelColor );',
        '  diffuseColor *= texelColor;',
        '#endif',
      ].join('\n'));
      var shf = sh.fragmentShader.indexOf('* folShadowMask();') >= 0 ? 'folShadowMask()' : 'getShadowMask()';
      sh.fragmentShader = rep(sh.fragmentShader, '#include <aomap_fragment>', [
        '{ float folSh120 = ' + shf + ';',
        '  reflectedLight.directDiffuse *= 1.0 + uWave120.w * vFolGust120;',
        '  reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol120 * (vFolTr120 * folSh120); }',
        '#include <aomap_fragment>',
      ].join('\n'));
      if (!ok) _patchOk = false;
    };
    mat.customProgramCacheKey = function () { return baseKey() + '|120'; };
    return mat;
  }
  function makeDepthMaterial120(shared) {
    var dm = makeDepthMaterial(shared);
    dm.map = atlasTexture120();
    var base = dm.onBeforeCompile;
    dm.onBeforeCompile = function (sh) {
      base.call(this, sh);
      sh.uniforms.uAtlas = shared.uAtlas120;
      sh.uniforms.uWave120 = shared.uWave120;
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, 'attribute float aQuad;', 'attribute float aQuad;\nuniform vec4  uWave120;\n' + NOISE120);
      sh.vertexShader = rep(sh.vertexShader, 'attribute vec2  aAtlas;', 'attribute vec4  aAtlas;');
      sh.vertexShader = rep(sh.vertexShader, 'vUv = uv * uAtlas + aAtlas;', 'vUv = uv * uAtlas + aAtlas.xy;');
      sh.vertexShader = rep(sh.vertexShader, G_LINE, G_LINE120);
      if (!ok) _patchOk = false;
    };
    dm.customProgramCacheKey = function () { return 'foliageDepth2|120'; };
    return dm;
  }
  /** (round 120) THE CARPET'S MATERIAL. Lambert, lit as the blades are (an
   *  upright normal), in the opaque pass AFTER the ground (renderOrder 1) and
   *  blended over it, so it costs a flat layer of fill and no cutout; on the
   *  ground's own triangles, pulled forward by a polygon offset, writing no
   *  depth. Its colour is mixed in the vertex shader from the plant's far
   *  colour and the plant tinted by the ground (`_carpetBuild120`), by the
   *  band's ground blend — so a zoom does not rebuild it. Cover comes up with
   *  distance (`uCarpet120`); a fine mottle and the same gusts, cloud and
   *  patches as the blades. */
  function makeCarpetMaterial120(shared) {
    var mat = new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: false, depthWrite: false, fog: true, side: THREE.FrontSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = shared.uTime;
      sh.uniforms.uWind = shared.uWind;
      sh.uniforms.uCam = shared.uCam;
      sh.uniforms.uCloud = shared.uCloud;
      sh.uniforms.uCloudBand = shared.uCloudBand;
      sh.uniforms.uWave120 = shared.uWave120;
      sh.uniforms.uVar120 = shared.uVar120;
      sh.uniforms.uCarpet120 = shared.uCarpet120;
      sh.uniforms.uCarpetB120 = shared.uCarpetB120;
      var ok = true;
      function rep(src, from, to) {
        if (src.indexOf(from) < 0) { ok = false; return src; }
        return src.replace(from, to);
      }
      sh.vertexShader = rep(sh.vertexShader, '#include <common>', [
        '#include <common>',
        'attribute vec3  aGround120;',
        'attribute vec2  aCover120;',      // x = cover (the cell's density), y = its kind's ground blend share
        'uniform float uTime;',
        'uniform vec4  uWind;',
        'uniform vec3  uCam;',
        'uniform vec4  uCloud;',
        'uniform vec2  uCloudBand;',
        'uniform vec4  uWave120;',
        'uniform vec4  uVar120;',
        'uniform vec4  uCarpet120;',       // x near cover, y..z distance it comes up over, w mottle
        'uniform vec4  uCarpetB120;',      // x the band's ground blend, y the card tint
        'varying float vCpA;',
        'varying float vCpSun;',
        'varying float vCpGust;',
        'varying vec2  vCpW;',
        NOISE120,
      ].join('\n'));
      sh.vertexShader = rep(sh.vertexShader, '#include <color_vertex>', [
        '#include <color_vertex>',
        '#ifdef USE_COLOR',
        '  vColor.rgb = mix(color.rgb, aGround120, uCarpetB120.x * aCover120.y) * uCarpetB120.y;',
        patchGLSL120('vColor.rgb', 'position.xz'),
        '#endif',
      ].join('\n'));
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>', [
        '#include <begin_vertex>',
        '{ float dC = distance(uCam, position);',
        '  vCpA = aCover120.x * mix(uCarpet120.x, 1.0, smoothstep(uCarpet120.y, uCarpet120.z, dC)) * ' + CARPET120.cap.toFixed(3) + ';',
        gustGLSL120('position.xz'),
        '  vCpGust = gust120;',
        '  vCpW = position.xz;',
        '  if (uCloud.w <= 0.001) { vCpSun = 1.0; } else {',
        '    vec2 cp = position.xz * uCloud.z + uCloud.xy;',
        '    float cn = folNoise(cp) * 0.62 + folNoise(cp * 2.17 + 11.3) * 0.38;',
        '    vCpSun = 1.0 - uCloud.w * smoothstep(uCloudBand.x, uCloudBand.y, cn);',
        '  } }',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>', [
        '#include <common>',
        'uniform vec4  uWave120;',
        'uniform vec4  uCarpet120;',
        'varying float vCpA;',
        'varying float vCpSun;',
        'varying float vCpGust;',
        'varying vec2  vCpW;',
        'float cpHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
        'float cpNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(cpHash(i), cpHash(i + vec2(1.0, 0.0)), f.x), mix(cpHash(i + vec2(0.0, 1.0)), cpHash(i + vec2(1.0, 1.0)), f.x), f.y); }',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <clipping_planes_fragment>', [
        'if (vCpA < 0.012) discard;',          // no cover here: nothing to blend, no light to pay for
        '#include <clipping_planes_fragment>',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>', [
        '#include <color_fragment>',
        // the blades' own roll-off of a bright albedo (makeMaterial)
        '{ float folY = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
        '  if (folY > 0.45) diffuseColor.rgb *= (0.45 + (folY - 0.45) * 0.15) / folY; }',
        // a clumped mottle a few tens of centimetres across, so it is a crop and not paint
        '{ float m = cpNoise(vCpW * 0.9) * 0.55 + cpNoise(vCpW * 3.1 + 7.7) * 0.45;',
        '  diffuseColor.rgb *= 1.0 + (m - 0.5) * 2.0 * uCarpet120.w;',
        '  diffuseColor.a = vCpA * (0.82 + 0.36 * m); }',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <aomap_fragment>', [
        'reflectedLight.directDiffuse *= 1.0 + uWave120.w * vCpGust;',
        '#include <aomap_fragment>',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <fog_fragment>', [
        'gl_FragColor.rgb *= vCpSun;',
        'gl_FragColor.a = clamp(diffuseColor.a, 0.0, 1.0);',
        '#include <fog_fragment>',
      ].join('\n'));
      if (!ok) _patchOk = false;
    };
    var base1 = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh) {
      base1.call(this, sh);
      if (sh.fragmentShader.indexOf('* getShadowMask();') >= 0 && sh.fragmentShader.indexOf('#include <shadowmask_pars_fragment>') >= 0) {
        sh.fragmentShader = sh.fragmentShader.replace('#include <shadowmask_pars_fragment>', [
          '#include <shadowmask_pars_fragment>',
          'float cpShadowMask() {',
          '  float shadow = 1.0;',
          '  #ifdef USE_SHADOWMAP',
          '  #if NUM_DIR_LIGHT_SHADOWS > 0',
          '  DirectionalLightShadow cpDL;',
          '  #pragma unroll_loop_start',
          '  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {',
          '    cpDL = directionalLightShadows[ i ];',
          '    vec4 sc = vDirectionalShadowCoord[ i ];',
          '    sc.xyz /= sc.w; sc.z += cpDL.shadowBias;',
          '    bool inF = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0;',
          '    shadow *= ( receiveShadow && inF ) ? texture2DCompare( directionalShadowMap[ i ], sc.xy, sc.z ) : 1.0;',
          '  }',
          '  #pragma unroll_loop_end',
          '  #endif',
          '  #endif',
          '  return shadow;',
          '}',
        ].join('\n')).replace('* getShadowMask();', '* cpShadowMask();');
      }
    };
    mat.customProgramCacheKey = function () { return 'folCarpet120b'; };
    return mat;
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
      uNear:   { value: new THREE.Vector4(0, 0, 0, 0) },   // (round 116) x, z, r0, r1; r1 0 = off
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
          var sk = sfc && (sfc.kin || sfc.name);   // (round 113) a pine wood is a wood
          var thick = sk === 'forest' || sk === 'crops' || sk === 'marsh';
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
          // (round 119) `notOn`: surfaces (by kin) this paint refuses. A crop is sown on ploughland, not a beach:
          // Salerno's map sowed maize and wheat discs, scaled with the field, over 10,399 of its 16,716 sand cells.
          if (opts.notOn) { var nsf = G.TYPE_DEF[this.terrain.type[i]]; if (nsf && opts.notOn.indexOf(nsf.kin || nsf.name) >= 0) continue; }
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
      var n = def.kin || def.name;           // (round 113) tarmac and a dirt track are roads
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
    /** (round 118) NOTHING GROWS UNDER A ROOF. The sowing reads the ground's
     *  type, and the ground under a house is still the field it was laid on:
     *  Village grew grass and weeds in its kitchens — drawn, and read by the
     *  battle (`coverAt`, `concealAt`, `heightAt`: a man indoors stood in a
     *  meadow). Every roofed cell of a building's plot (`_roomAt` at storey 0:
     *  not a yard, not the street outside a wall) is cleared after each sow.
     *  `game.grass118 = false` (then reload the map) keeps the old cover. */
    unsowRoofed: function (S) {
      var g = window.game;
      if (!S || !S.any || !S.mask || typeof S._roomAt !== 'function' || (g && g.grass118 === false)) return 0;
      var GR = G.GRID, n = 0;
      for (var z = 0; z < GR; z++) for (var x = 0; x < GR; x++) {
        var i = z * GR + x;
        if (!this.kind[i] || !S.mask[i] || !S._roomAt(x, z, 0)) continue;
        this.kind[i] = 0; this.dens[i] = 0; n++;
      }
      if (n) for (var c = 0; c < this.chunks.length; c++) { var ch = this.chunks[c]; if (!ch.dirty) { ch.dirty = true; this.dirtyList.push(ch); } }
      this._unsown118 = n;
      return n;
    },
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
      // (round 113) the surfaces added to paint: rough grass carries tall grass,
      // pasture a short sward, heath its heather, a bog and a wet meadow their
      // reeds (bulrush, rushes and sedge by `flora`), a pine wood its bracken;
      // tracks, tarmac and ploughland carry nothing
      plan(TY.roughgrass, 'tallgrass', 0.75, 0.25);
      plan(TY.pasture,    'grass',     0.55, 0.40);
      plan(TY.drygrass,   'grass',     0.70, 0.30);
      plan(TY.heath,      'heather',   0.85, 0.12);
      plan(TY.bog,        'reeds',     0.50, 0.35);
      plan(TY.wetmeadow,  'reeds',     0.45, 0.30);
      plan(TY.pinefloor,  'fern',      0.65, 0.20);
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

    /** (round 113) GROW THE THEATRE'S PLANTS on what the map planted, sown or
     *  painted (see FLORA). A sown field (wheat) becomes the crop its FIELD
     *  draws — one crop to a field, the fields a Voronoi patchwork `field`
     *  cells across — and the wild kinds come up in patches of the ground they
     *  belong to: wildflowers in grass, brambles and foxgloves under the
     *  bracken, bulrush and rushes among the reeds, gorse on the heath, and on
     *  rubble nobody planted a thin scatter of willowherb. Maize, and anything
     *  already one of the forty, is left as it is.
     *
     *  `name` (the map's) only refines a generic era — see NAME_FLORA.
     *
     *  A pure function of (cell, kind, era) like `autoSow`: identical on both
     *  machines and after a reload, and idempotent (a cell it left as it was
     *  hashes to the same answer the next time). The densities are the map's;
     *  only rubble, which had none, is given one. Returns the cells changed. */
    flora: function (era, name) {
      var th = FLORA[floraFor(era, name)];
      var T = this.terrain, GR = G.GRID, TY = G.TYPE, i, x, z, n = 0;
      var h = G.hash2;
      function id(name) { return BY_ID[name] ? BY_ID[name].index + 1 : 0; }
      function pickW(list, u) {
        var tot = 0, j;
        for (j = 0; j < list.length; j++) tot += list[j][1];
        u *= tot;
        for (j = 0; j < list.length; j++) { u -= list[j][1]; if (u < 0) return list[j][0]; }
        return list[list.length - 1][0];
      }
      // a uniform draw per Voronoi region `size` cells across: one answer for
      // a whole field or patch, with edges that are not the grid's
      function region(gx, gz, size, salt) {
        var fx = gx / size, fz = gz / size, ix = Math.floor(fx), iz = Math.floor(fz);
        var best = 1e9, bx = 0, bz = 0;
        for (var dz = -1; dz <= 1; dz++) for (var dx = -1; dx <= 1; dx++) {
          var cx = ix + dx, cz = iz + dz;
          var px = cx + h(cx * 1.731 + salt, cz * 2.917 + 0.7), pz = cz + h(cx * 3.113 + 0.9, cz * 1.317 + salt);
          var d = (px - fx) * (px - fx) + (pz - fz) * (pz - fz);
          if (d < best) { best = d; bx = cx; bz = cz; }
        }
        return h(bx * 0.913 + salt * 3.1, bz * 1.271 + 9.3);
      }
      // smooth value noise, ~0.2-0.8: where a patch is
      function patchy(gx, gz, size, salt) {
        var fx = gx / size + salt * 7.13, fz = gz / size - salt * 3.71, ix = Math.floor(fx), iz = Math.floor(fz);
        var tx = fx - ix, tz = fz - iz;
        tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz);
        var a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
        return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
      }
      var K = { wheat: id('wheat'), grass: id('grass'), tall: id('tallgrass'), fern: id('fern'),
                reeds: id('reeds'), heath: id('heather'), brush: id('brush') };
      var rubbleT = TY && TY.rubble;
      for (z = 0; z < GR; z++) for (x = 0; x < GR; x++) {
        i = z * GR + x;
        var k = this.kind[i], to = 0;
        if (!k) {
          if (rubbleT !== undefined && th.rubble && T.type[i] === rubbleT && this._plantable(x, z)) {
            var r = patchy(x, z, 4, 6.6);
            if (r > th.cuts.rubble) { to = id(pickW(th.rubble, region(x, z, 8, 4.2))); if (to) this.dens[i] = Math.round(Math.min(0.4, 0.16 + (r - th.cuts.rubble) * 0.8) * 255); }
          }
        } else if (k === K.wheat) {
          to = id(pickW(th.crops, region(x, z, th.field, 11.3)));
        } else if (k === K.grass || k === K.tall) {
          if (th.tall && k === K.tall) to = id(th.tall);
          else if (patchy(x, z, 7, 3.7) > th.cut) to = id(pickW(th.meadow, region(x, z, 16, 5.9)));
        } else if (k === K.fern) {
          if (patchy(x, z, 6, 8.1) > th.cuts.wood) to = id(pickW(th.wood, region(x, z, 12, 2.3)));
        } else if (k === K.reeds) {
          if (patchy(x, z, 5, 1.9) > th.cuts.marsh) to = id(pickW(th.marsh, region(x, z, 9, 7.7)));
        } else if (k === K.heath) {
          if (patchy(x, z, 6, 4.4) > th.cuts.heath) to = id(pickW(th.heath, region(x, z, 12, 6.1)));
        } else if (k === K.brush) {
          if (patchy(x, z, 6, 9.2) > th.cuts.scrub) to = id(pickW(th.scrub, region(x, z, 12, 3.3)));
        }
        if (to && to !== k) { this.kind[i] = to; n++; }
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
      // (round 120) ON: fewer, smaller far cards over the carpet, which comes up as they thin
      if (this._on120) {
        var B120 = BAND120[this.band || 0];
        this.density *= B120.dens;
        this.sizeBoost = Math.min(B120.boost, this.sizeBoost);
        this.shared.uFade.value.y *= B120.fade;
        var fy120 = this.shared.uFade.value.y;
        if (this.shared.uCarpet120) this.shared.uCarpet120.value.set(CARPET120.near, fy120 * CARPET120.from, fy120 * CARPET120.to, CARPET120.mottle);
        if (this.shared.uCarpetB120) this.shared.uCarpetB120.value.set(this.groundBlend, this.cardLod !== false && (this.band || 0) >= CARD_BAND ? (this.cardTint || CARD_TINT) : 1, 0, 0);
      }
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
    /** (round 116) Press the field down round (x, z): flat inside r0, full height past r1
     *  (world units); r1 = 0 turns it off. The first-person eye in a crop. Drawing only:
     *  the sightline already skips a man's own cell (`Game._hasLOSCalc`). */
    setNear: function (x, z, r0, r1) {
      var v = this.shared.uNear.value;
      if (v.x !== x || v.y !== z || v.z !== r0 || v.w !== r1) v.set(x, z, r0, r1);
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
      // (round 120) `game.foliage120`, read once a frame: a change draws the field again
      var on120now = on120();
      if (on120now !== !!this._on120) { this._on120 = on120now; if (on120now) this._ensure120(); this._applyBand(true); if (!on120now) this._carpetDrop120(); }
      if (this._on120) this._update120(dt, cam);

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
      if (this._on120) return this._build120(c);   // (round 120) `game.foliage120`
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

        // (round 118) IN ITS OWN CELL. `cellX` is the cell's corner (the
        // cell is [cellX, cellX + TILE]) and the scatter was centred on it:
        // every plant stood half a cell (3 m) west and north of the cell the
        // battle reads it in, so a meadow's edge grew into the kitchen across
        // the wall. `game.grass118 = false` (then reload) is the old scatter.
        var half118 = (window.game && window.game.grass118 === false) ? 0 : 0.5;
        for (var j = 0; j < n && w < total; j++, w++) {
          var px = cellX + (R() - 0.5 + half118) * TILEl;
          var pz = cellZ + (R() - 0.5 + half118) * TILEl;
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

          // rooted just under the surface; a Blender kind's foot is ROOT of the
          // way up its quad, so it goes down by that much as well
          pv.set(px, py - (def.root !== undefined ? def.root * sh + ROOT_SINK : 0.04), pz);
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
            // (round 113) …by `blend` of it for the Blender kinds: their colour
            // is in the sprite, and a poppy pulled three quarters of the way to
            // the mud under it is not red
            col.lerp(grd, this.groundBlend * (def.blend !== undefined ? def.blend : 1));
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

    // ---- (round 120) `game.foliage120` ------------------------------------

    /** The ON materials and their uniforms, made the first time the switch is on. */
    _ensure120: function () {
      if (this.material120) return;
      var s = this.shared;
      s.uAtlas120 = { value: new THREE.Vector2(1 / A120_COLS, 1 / A120_ROWS) };
      s.uSun120 = { value: new THREE.Vector4(0.55, 0.71, 0.43, LOOK120.trans) };
      s.uSunCol120 = { value: new THREE.Vector3(1.7, 1.53, 1.29) };
      s.uWave120 = { value: new THREE.Vector4(LOOK120.gustScale, LOOK120.gustSpeed, LOOK120.gust, LOOK120.sheen) };
      s.uVar120 = { value: new THREE.Vector4(LOOK120.varScale, LOOK120.varAmt, LOOK120.dry, 0) };
      s.uCarpet120 = { value: new THREE.Vector4(CARPET120.near, 10, 60, CARPET120.mottle) };
      s.uCarpetB120 = { value: new THREE.Vector4(0.34, 1, 0, 0) };
      this.material120 = makeMaterial120(s);
      this.depthMaterial120 = makeDepthMaterial120(s);
      this.carpetMaterial120 = makeCarpetMaterial120(s);
    },

    /** Once a frame while ON: the sun the blades glow against, the drawings
     *  arriving, and the carpet kept in step with the field. */
    _update120: function (dt, cam) {
      var g = window.game, S = g && g.sun, s = this.shared;
      if (S && S.position && S.target) {
        var v = s.uSun120.value, dx = S.position.x - S.target.position.x, dy = S.position.y - S.target.position.y, dz = S.position.z - S.target.position.z;
        var l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        v.set(dx / l, dy / l, dz / l, this.trans120 !== undefined ? this.trans120 : LOOK120.trans);
        s.uSunCol120.value.set(S.color.r * S.intensity, S.color.g * S.intensity, S.color.b * S.intensity);
      }
      // the drawings landed (or never will): the field is drawn again with them
      var st = sprites120;
      if (st !== this._st120 && st !== 'loading' && st !== 'none') {
        this._st120 = st;
        for (var i = 0; i < this.chunks.length; i++) { var c = this.chunks[i]; if (c.mesh && !c.dirty) { c.dirty = true; this.dirtyList.push(c); } }
        if (this._cp) this._cp.sig.fill(0);
      }
      if (this.carpet120 !== false) this._carpetTick120(cam);
      else if (this._cp) this._carpetDrop120();
    },

    /** The far colour of kind `k` (1-based), as `_build120` would tint it:
     *  [plant colour x its tint, plant colour, ground blend share]. */
    _kindFar120: function (k) {
      var C = this._far120 || (this._far120 = {}), hit = C[k];
      if (hit) return hit;
      var def = DEFS[k - 1], cells = this._cells120(def), r = 0, g = 0, b = 0, n = 0;
      for (var j = 0; j < cells.length; j++) {
        var f = cellFar120 && cellFar120[cells[j].cell];
        if (f) { r += f[0]; g += f[1]; b += f[2]; n++; }
      }
      if (!n) {   // the atlas not in yet: the editor's swatch
        var sw = parseInt((def.swatch || '#556b2f').slice(1), 16);
        r = (sw >> 16 & 255) / 255 * 0.45; g = (sw >> 8 & 255) / 255 * 0.45; b = (sw & 255) / 255 * 0.45; n = 1;
      }
      r /= n; g /= n; b /= n;
      var T = cells.tint || def.tint, tr = 0, tg = 0, tb = 0;
      for (var t = 0; t < T.length; t++) { tr += (T[t] >> 16 & 255) / 255; tg += (T[t] >> 8 & 255) / 255; tb += (T[t] & 255) / 255; }
      tr /= T.length; tg /= T.length; tb /= T.length;
      var gain = 2.35 * 1.03;
      hit = { a: [r * tr * gain, g * tg * gain, b * tb * gain], p: [r * gain, g * gain, b * gain],
              bl: cells.blend !== undefined ? cells.blend : (def.blend !== undefined ? def.blend : 1) };
      if (cellFar120) C[k] = hit;
      return hit;
    },

    /** Which drawings the season calls for: the map's theatre (`floraFor`), or
     *  'winter' under snow (`Canopy.snow`). A new map clears the caches. */
    _theatre120: function () {
      var g = window.game, md = g && g.mapDef, CN = window.Canopy;
      var snow = !!(CN && CN.snow && CN.snow.value > 0.3);
      if (this._th120md === md && this._th120snow === snow && this._th120) return this._th120;
      this._th120md = md; this._th120snow = snow;
      this._th120 = snow ? 'winter' : floraFor(md && md.era, md && md.name);
      this._cellsC120 = {}; this._far120 = {};
      return this._th120;
    },
    /** The drawings kind `def` picks from: [{cell, w, h}], with `tint`/`blend`
     *  for the round-120 ones (their colour is in the sprite). */
    _cells120: function (def) {
      var th = this._theatre120(), C = this._cellsC120 || (this._cellsC120 = {}), hit = C[def.id];
      if (hit) return hit;
      var ids = (V120T[th] && V120T[th][def.id]) || V120[def.id], out = [];
      if (ids && sprites120 === 'ready') {
        for (var j = 0; j < ids.length; j++) {
          var q = CELLQ120[ids[j]];
          if (!q) continue;
          out.push({ cell: q.cell, w: q.q ? q.q[0] * scaledK : def.w, h: q.q ? q.q[1] * scaledK : def.h });
        }
      }
      if (out.length) { out.tint = TINT120; out.blend = 0.55; }
      if (out.length && FACE120[def.id] && CELLQ120[FACE120[def.id].back]) out.back = CELLQ120[FACE120[def.id].back].cell;
      else out.push({ cell: def.atlas, w: def.w, h: def.h });
      if (sprites120 === 'ready' || sprites120 === 'absent' || sprites120 === 'failed') C[def.id] = out;
      return out;
    },

    /** `_build`, ON: the same plants in the same places at the same heights
     *  (every draw of the field's random stream is the one `_build` makes), each
     *  drawn from one of its kind's drawings, picked by a hash of the cell and
     *  the plant so it costs the stream nothing; the drawing's own quad. */
    _build120: function (c) {
      this._dispose(c);
      var GRIDl = G.GRID, TILEl = G.TILE, T = this.terrain;
      var x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
      var x1 = Math.min(GRIDl, x0 + CHUNK), z1 = Math.min(GRIDl, z0 + CHUNK);
      var self = this, RS = this._rngS || (this._rngS = new Int32Array(1));
      function R() { return rngNext(RS); }
      var cardLod = this.cardLod !== false && (this.band || 0) >= CARD_BAND, cardW = this.cardW || CARD_W, cardT = this.cardTint || CARD_TINT;
      var near = (this.band || 0) <= 1;
      function perCell(x, z, i, def) {
        var raw = def.per * (self.dens[i] / 255) * self.density * (near && NEAR120[def.id] ? NEAR120[def.id] : 1);
        var whole = Math.floor(raw);
        return whole + (G.hash2(x * 2.13 + 0.7, z * 1.87 + 1.3) < raw - whole ? 1 : 0);
      }
      var total = 0, x, z, i, k, dens, def, n;
      for (z = z0; z < z1; z++) for (x = x0; x < x1; x++) {
        i = z * GRIDl + x;
        k = this.kind[i];
        if (!k || !this.dens[i]) continue;
        total += perCell(x, z, i, DEFS[k - 1]);
      }
      if (total <= 0) { c.empty = true; return; }
      if (total > MAX_PER_CHUNK * 1.3) total = Math.floor(MAX_PER_CHUNK * 1.3);
      var mats = new Float32Array(total * 16);
      var atl = new Float32Array(total * 4);
      var tint = new Float32Array(total * 3);
      var flags = new Float32Array(total * 3);
      var m = this._m4, q = this._q, pv = this._v, sv = this._s;
      var minY = 1e9, maxY = -1e9, tallest = 0, w = 0;
      var col = new THREE.Color(), grd = new THREE.Color();
      var tcol = (T.mesh && T.mesh.geometry.attributes.color) || null;
      var half118 = (window.game && window.game.grass118 === false) ? 0 : 0.5;
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
        var cells = this._cells120(def), tintL = cells.tint || def.tint, blendK = cells.blend !== undefined ? cells.blend : (def.blend !== undefined ? def.blend : 1);
        var face = FACE120[def.id] && cells.back !== undefined ? FACE120[def.id] : null;
        var kindCard = def.mode === 'card' ? 1 : 0;
        var card = kindCard || cardLod ? 1 : 0;
        var cw = cardLod && !kindCard ? cardW : 1, ct = cardLod && !kindCard ? cardT : 1;
        if (tcol) grd.fromBufferAttribute(tcol, i);
        for (var j = 0; j < n && w < total; j++, w++) {
          var px = cellX + (R() - 0.5 + half118) * TILEl;
          var pz = cellZ + (R() - 0.5 + half118) * TILEl;
          var py = T.heightAt(px, pz);
          if (py < minY) minY = py;
          var vc = cells.length > 1 ? cells[Math.min(cells.length - 1, (G.hash2(x * 3.17 + j * 0.731, z * 2.71 + j * 1.37) * cells.length) | 0)] : cells[0];
          var grow = (0.55 + 0.45 * dens) * this.growAt(x, z);
          var gw = Math.sqrt(grow);
          var sw = vc.w * gw * (1 + (R() - 0.5) * 2 * def.vary) * this.sizeBoost * cw;
          var sh = vc.h * grow * (1 + (R() - 0.5) * 2 * def.vary) * Math.min(1.3, this.sizeBoost);
          if (py + sh > maxY) maxY = py + sh;
          var rootK = vc.cell >= ATLAS_PAINTED ? ROOT : def.root;
          pv.set(px, py - (rootK !== undefined ? rootK * sh + ROOT_SINK : 0.04), pz);
          sv.set(sw, sh, sw);
          var yaw = kindCard ? 0 : R() * Math.PI * 2;
          if (face) yaw = face.yaw + (yaw / (Math.PI * 2) - 0.5) * face.spread;
          q.setFromAxisAngle(this._up, card ? 0 : yaw);
          m.compose(pv, q, sv);
          m.toArray(mats, w * 16);
          atl[w * 4] = (vc.cell % A120_COLS) / A120_COLS;
          atl[w * 4 + 1] = 1 - (Math.floor(vc.cell / A120_COLS) + 1) / A120_ROWS;
          var bk = face ? cells.back : vc.cell;
          atl[w * 4 + 2] = (bk % A120_COLS) / A120_COLS;
          atl[w * 4 + 3] = 1 - (Math.floor(bk / A120_COLS) + 1) / A120_ROWS;
          col.setHex(tintL[(R() * tintL.length) | 0]);
          if (tcol) col.lerp(grd, this.groundBlend * blendK);
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
      c.tall = tallest >= SHADOW_MIN;
      this._shuffle120(w, mats, atl, tint, flags);
      var geo = (cardLod ? this.cardGeometry : this.geometry).clone();
      geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(atl, 4));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      geo.setAttribute('aFlags', new THREE.InstancedBufferAttribute(flags, 3));
      var mesh = new THREE.InstancedMesh(geo, this.material120, w);
      mesh.customDepthMaterial = this.depthMaterial120;
      mesh.instanceMatrix.array.set(mats.subarray(0, w * 16));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -1;
      c.wy = (minY + maxY) * 0.5;
      var halfW = CHUNK * TILEl * 0.5 + 1.5 * scaledK;
      var halfH = Math.max(1, (maxY - minY) * 0.5 + 1);
      geo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(c.wx, c.wy, c.wz), Math.sqrt(halfW * halfW * 2 + halfH * halfH));
      geo.boundingBox = new THREE.Box3(
        new THREE.Vector3(c.wx - halfW, minY - 0.5, c.wz - halfW),
        new THREE.Vector3(c.wx + halfW, maxY + 0.5, c.wz + halfW));
      c.radius = geo.boundingSphere.radius;
      mesh.castShadow = this._casts(c);
      this.group.add(mesh);
      c.mesh = mesh; c.n = w; c.empty = false;
      this.instances += w;
      this.stats.built++;
    },

    // ---- (round 120) THE CARPET ------------------------------------------
    // The whole field, region by region (CARPET120.reg chunks a side), on the
    // ground's own vertices (the cell centres, the ground's triangles). Built
    // nearest first, then kept in step by a signature of each region's plants
    // and ground, checked a few regions a frame: an edit, a crater or a new
    // map shows within a second, and nothing has to tell it.
    _carpetTick120: function (cam) {
      var GR = G.GRID, cp = this._cp;
      if (!cp || cp.grid !== GR || cp.terrain !== this.terrain) {
        this._carpetDrop120();
        var rc = CHUNK * CARPET120.reg, rw = Math.ceil((GR - 1) / rc);
        cp = this._cp = { grid: GR, terrain: this.terrain, rc: rc, rw: rw, regs: new Array(rw * rw), sig: new Int32Array(rw * rw), rr: 0, wx: [], wz: [] };
        for (var r = 0; r < rw * rw; r++) {
          cp.regs[r] = null;
          var rx = r % rw, rz = (r / rw) | 0;
          cp.wx.push(((rx + 0.5) * rc - GR / 2) * G.TILE); cp.wz.push(((rz + 0.5) * rc - GR / 2) * G.TILE);
        }
      }
      var t0 = performance.now(), n = cp.regs.length, built = 0;
      // the unbuilt ones, nearest the eye first
      for (var pass = 0; pass < 4; pass++) {
        var best = -1, bd = Infinity;
        for (var i = 0; i < n; i++) {
          if (cp.regs[i] !== null) continue;
          var dx = cp.wx[i] - cam.x, dz = cp.wz[i] - cam.z, d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = i; }
        }
        if (best < 0) break;
        cp.sig[best] = this._carpetSig120(best);
        this._carpetBuild120(best); built++;
        if (performance.now() - t0 > BUILD_MS) break;
      }
      // …then a few signatures a frame, round the field
      for (var k = 0; k < 4 && !built; k++) {
        var ri = cp.rr = (cp.rr + 1) % n;
        if (cp.regs[ri] === null) continue;
        var sg = this._carpetSig120(ri);
        if (sg !== cp.sig[ri]) { cp.sig[ri] = sg; this._carpetBuild120(ri); built++; }
      }
    },
    _carpetSig120: function (ri) {
      var cp = this._cp, GR = G.GRID, rc = cp.rc, rx = ri % cp.rw, rz = (ri / cp.rw) | 0;
      var x0 = rx * rc, z0 = rz * rc, x1 = Math.min(GR - 1, x0 + rc), z1 = Math.min(GR - 1, z0 + rc);
      var h = 0x811c9dc5 | 0, K = this.kind, D = this.dens, H = this.terrain.h;
      for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
        var i = z * GR + x;
        h = Math.imul(h ^ (K[i] << 8 | D[i]), 16777619);
        h = Math.imul(h ^ ((H[i] * 64) | 0), 16777619);
      }
      return (h ^ (sprites120 === 'ready' ? 0x5bd1e995 : 0) ^ (cellFar120 ? 0x27d4eb2f : 0)) | 1;
    },
    _carpetBuild120: function (ri) {
      var cp = this._cp, GR = G.GRID, rc = cp.rc, rx = ri % cp.rw, rz = (ri / cp.rw) | 0;
      var x0 = rx * rc, z0 = rz * rc, x1 = Math.min(GR - 1, x0 + rc), z1 = Math.min(GR - 1, z0 + rc);
      var old = cp.regs[ri];
      if (old && old !== 0) { this.group.remove(old); old.geometry.dispose(); }
      cp.regs[ri] = 0;      // built, nothing to draw (yet)
      var T = this.terrain, tg = T.mesh && T.mesh.geometry, tp = tg && tg.attributes.position, tc = tg && tg.attributes.color;
      if (!tp) return;
      var nx = x1 - x0 + 1, nz = z1 - z0 + 1, NV = nx * nz;
      var cov = new Float32Array(NV), any = false, x, z, i, v;
      for (z = z0; z <= z1; z++) for (x = x0; x <= x1; x++) {
        i = z * GR + x; v = (z - z0) * nx + (x - x0);
        if (this.kind[i] && this.dens[i]) { cov[v] = this.dens[i] / 255; any = true; }
      }
      if (!any) return;
      var idx = [];
      for (z = 0; z < nz - 1; z++) for (x = 0; x < nx - 1; x++) {
        var a = z * nx + x, b = (z + 1) * nx + x, c = (z + 1) * nx + x + 1, d = z * nx + x + 1;
        if (cov[a] > 0 || cov[b] > 0 || cov[d] > 0) idx.push(a, b, d);     // the ground's own split of the square
        if (cov[b] > 0 || cov[c] > 0 || cov[d] > 0) idx.push(b, c, d);
      }
      if (!idx.length) return;
      var pos = new Float32Array(NV * 3), nrm = new Float32Array(NV * 3), colA = new Float32Array(NV * 3), colB = new Float32Array(NV * 3), cv = new Float32Array(NV * 2);
      var have = new Uint8Array(NV);
      for (z = z0; z <= z1; z++) for (x = x0; x <= x1; x++) {
        i = z * GR + x; v = (z - z0) * nx + (x - x0);
        pos[v * 3] = tp.getX(i); pos[v * 3 + 1] = tp.getY(i); pos[v * 3 + 2] = tp.getZ(i);
        nrm[v * 3 + 1] = 1;
        if (!cov[v]) continue;
        var F = this._kindFar120(this.kind[i]);
        var gr = tc ? tc.getX(i) : F.a[0], gg = tc ? tc.getY(i) : F.a[1], gb = tc ? tc.getZ(i) : F.a[2];
        colA[v * 3] = F.a[0]; colA[v * 3 + 1] = F.a[1]; colA[v * 3 + 2] = F.a[2];
        colB[v * 3] = F.p[0] * gr; colB[v * 3 + 1] = F.p[1] * gg; colB[v * 3 + 2] = F.p[2] * gb;
        cv[v * 2] = cov[v]; cv[v * 2 + 1] = F.bl;
        have[v] = 1;
      }
      // a corner with no plant takes the colour of one beside it, so an edge
      // fades out in the plant's colour and not toward black
      for (z = 0; z < nz; z++) for (x = 0; x < nx; x++) {
        v = z * nx + x;
        if (have[v]) continue;
        for (var dz = -1; dz <= 1; dz++) for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
          var u = zz * nx + xx;
          if (have[u] !== 1) continue;
          for (var e = 0; e < 3; e++) { colA[v * 3 + e] = colA[u * 3 + e]; colB[v * 3 + e] = colB[u * 3 + e]; }
          cv[v * 2 + 1] = cv[u * 2 + 1]; have[v] = 2; dz = 2; break;
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
      geo.setAttribute('aGround120', new THREE.BufferAttribute(colB, 3));
      geo.setAttribute('aCover120', new THREE.BufferAttribute(cv, 2));
      geo.setIndex(NV > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.carpetMaterial120);
      mesh.name = 'foliageCarpet120';
      mesh.renderOrder = 1;          // after the ground, still in the opaque pass
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      cp.regs[ri] = mesh;
    },
    _carpetDrop120: function () {
      var cp = this._cp;
      if (!cp) return;
      for (var i = 0; i < cp.regs.length; i++) {
        var m = cp.regs[i];
        if (m) { this.group.remove(m); m.geometry.dispose(); }
      }
      this._cp = null;
    },

    /** `_shuffle` for the ON build (four atlas numbers a plant): the same seed, draws and swaps. */
    _shuffle120: function (n, mats, atl, tint, flags) {
      var RS = this._rngS || (this._rngS = new Int32Array(1));
      RS[0] = n * 2654435761;
      for (var i = n - 1; i > 0; i--) {
        var j = (rngNext(RS) * (i + 1)) | 0;
        if (j === i) continue;
        swap(mats, i, j, 16);
        swap(atl, i, j, 4); swap(tint, i, j, 3); swap(flags, i, j, 3);
      }
      function swap(a, i2, j2, s) {
        for (var k = 0; k < s; k++) {
          var t = a[i2 * s + k]; a[i2 * s + k] = a[j2 * s + k]; a[j2 * s + k] = t;
        }
      }
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
      if (this._carpetDrop120) this._carpetDrop120();   // (round 120)
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
    /** (round 113) the theatre tables `flora` grows from, and where the Blender
     *  cells are: 'none' (atlas not built), 'loading', 'ready', 'absent', 'failed' */
    FLORA: FLORA,
    ERA_FLORA: ERA_FLORA,
    floraFor: floraFor,
    sprites: function () { return spritesState; },
    /** [ms to put the cells together, ms to build the mip chain] — once, at load */
    spritesMs: function () { return spritesMs; },
    /** (round 113) for tools/test_round113.js: the field's methods (`flora`)
     *  and the mip chain, callable on stand-ins without a scene or a canvas */
    Field: Field,
    _buildMips: function (cv, tex) { return buildMips(cv, tex); },
    /** (round 113) set before the atlas is built; false leaves the mip chain to GL */
    set mipKeep(v) { MIP_KEEP = !!v; },
    /** (round 120, `game.foliage120`) the ON atlas, its drawings' state ('none', 'loading', 'ready',
     *  'absent', 'failed'), [ms to decode, ms for the mip chain], and the tables, for tooling */
    atlas120: function () { return atlasTexture120(); },
    sprites120: function () { return sprites120; },
    sprites120Ms: function () { return sprites120Ms; },
    cells120: function () { return CELLQ120; },
    far120: function () { return cellFar120; },
    V120: V120, V120T: V120T, FACE120: FACE120, NEAR120: NEAR120, TINT120: TINT120, BAND120: BAND120, CARPET120: CARPET120, LOOK120: LOOK120,
    get mipKeep() { return MIP_KEEP; },
  };
})();
