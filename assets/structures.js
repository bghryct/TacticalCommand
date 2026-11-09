/* ===========================================================================
 * STRUCTURES — modular, destructible, walk-in buildings
 * ---------------------------------------------------------------------------
 * The stock `building` prop is a solid box with teleport-in "window slots".
 * This is the real thing: buildings assembled out of MODULAR PIECES on the
 * terrain grid, with interiors squads walk through, partitions they clear room
 * by room, stairs they climb, and every piece individually destructible.
 *
 * THE GEOMETRY MODEL — the one decision everything else follows
 * ------------------------------------------------------------
 * Walls live on cell EDGES, not in cells.
 *
 *   A cell is a SPACE (a bit of room, a corridor, a stair well). An edge
 *   between two cells is a SURFACE (wall, doorway, window, or open air).
 *
 * That is what makes interiors work at all. If a wall occupied a cell — the way
 * every prop in this game does — then a wall would consume the floor it stands
 * on, a room would need a one-cell gap around it, and no unit could ever be
 * "inside". With walls on edges, the pathfinder's cells stay the rooms and the
 * walls are the connectivity between them: a partition is one edge flipped from
 * open to solid, and a doorway is that same edge flipped to `door`.
 *
 * The third axis is LEVELS: `LEVELS` floors of `FLOOR_H` each, stacked over the
 * same cell. A cell at level 0 is ground; at level 1+ it exists only where a
 * floor slab was laid. Stairs are a per-cell feature connecting L to L+1, and a
 * unit's `lvl` rides the geometry (see `walkY`).
 *
 * STORAGE — flat typed arrays, allocated lazily
 * ---------------------------------------------
 * Indexed `(L * GRID + gz) * GRID + gx`, four edge slots per cell:
 *
 *   wallM/wallK/wallH   material · kind (solid/door/window/rubble) · hp 0-255
 *   floorM/floorH       floor slab material · hp
 *   roofM/roofK/roofH   roof material · shape (flat/slope/ridge) · hp
 *   feat                stairs / ramp / ladder + direction + which half
 *   mask                per-CELL "anything here at all", for the hot paths
 *
 * `mask` is the important one: `hasLOS`, the pathfinder and the projectile
 * sweep all run millions of times a second over a battlefield that is 99 %
 * open ground, and they must cost one byte-load to say "nothing here".
 *
 * RENDERING — merged chunks, one material
 * ---------------------------------------
 * Every piece bakes its colour into VERTEX COLOURS, so one shared
 * MeshStandardMaterial draws brick, wood, thatch, concrete and rubble together.
 * Pieces are merged per CHUNK (16x16 cells, all levels) into a single
 * BufferGeometry, so a whole town block is ~1 draw call plus 1 for its glass.
 * Damage marks a chunk dirty and at most two chunks rebuild per frame.
 *
 * A 3-floor, 5x4-cell brick house is ~170 pieces => ~2k triangles => 2 draws.
 *
 * Contract: this file is OPTIONAL. If it fails to load, or `install()` is never
 * called, `game.structures` stays null, every call site is guarded and the game
 * runs exactly as it did before.
 * ======================================================================== */
(function () {
  'use strict';

  var VERSION = 1;
  var THREE = null;
  var G = null;            // injected game internals (GRID, TILE, HSCALE, helpers)
  var installed = false;

  // ---- the module's own geometry constants -------------------------------
  // Sized against the UNIT models, not METERS_PER_UNIT: a rifleman's eye sits
  // at 1.3 world units, so a 2.2-unit storey reads as a real room around him
  // and a 3-storey building comes out 6.6 units — the same height as the stock
  // `building` prop it replaces.
  var LEVELS   = 4;        // ground + 3
  // TRUE SCALE (round 105). Every number in this file that is a SIZE of
  // something a man walks through — the storey, the wall, the door, the
  // window, the stair, the chimney — was drawn against the unit models'
  // diorama (a rifleman's eye at 1.3 u), and `S` brings it to life size
  // (the game passes `K_BLD`; 1 is the old house to the byte). What is a
  // FRACTION OF A CELL stays: the cell is a real six metres, and so is a
  // roof's pitch across it (`ROOF_RISE` is a slope, not a size).
  var S = 1;
  // TWO WINDOWS A CELL (round 106, the goal check's sixth list). A cell is six
  // metres and a window edge carried ONE opening at its middle: a house front
  // had a window every 6 m, where a Norman or Dutch front has one every 3 or so.
  // At true scale a window edge is two openings, at a quarter of the cell
  // either side of its middle — drawn, glazed, dressed and tested by a round
  // alike (`emitWall`, `_rayWall`). A sightline already sees through a whole
  // window edge (`_sightEdge`). The diorama keeps one window to the byte.
  var PAIR = false;
  function pairs() { return PAIR && window.Structures.windowPairs !== false; }
  var FLOOR_H  = 2.2;      // storey height, world units
  var WALL_TH  = 0.18;     // wall thickness
  var FLOOR_TH = 0.16;     // slab thickness
  var ROOF_H   = 1.15;     // ridge rise over the eaves
  var ROOF_RISE = 0.62;    // default rise per cell in from the eaves (~22.5 deg)
  // Pitch is a property of the ROOFING, not of the grid: thatch is laid steep
  // so it sheds water, corrugated sheet is laid nearly flat because it doesn't
  // have to. One rise per material keeps every panel of a roof continuous,
  // because a roof is all one material.
  function riseOf(mat) { return mat.rise === undefined ? ROOF_RISE : mat.rise; }
  // Cells per render chunk side. This is the one real tension in the file: a
  // BIG chunk is fewer draw calls but a slower rebuild when a shell lands in
  // it, and the rebuild happens on the frame the shell lands. At 16 a chunk of
  // nine townhouses took 4 ms to re-merge — a quarter of a frame. At 8 it is
  // about 1 ms, and the extra draw calls are a rounding error next to the ~930
  // the battlefield already issues.
  var CHUNK    = 8;

  // Edges, clockwise from north. Edge e of cell c is the same surface as edge
  // (e+2)%4 of the neighbour — `setWall` writes BOTH so every read is one load.
  var EDGE_D = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N, E, S, W  (dx, dz)

  // Wall kinds.
  var K_SOLID = 0, K_DOOR = 1, K_WINDOW = 2, K_RUBBLE = 3, K_ARCH = 4;
  // SHELL HOLES (round 110). A wall is six metres of masonry at true scale, and
  // a 75 mm round that struck it turned all six metres into a knee-high heap —
  // the panel was the smallest thing that could be damaged. A panel now carries
  // a grid of HOLE_COLS x HOLE_ROWS openings (`wallHole`, one bit each, the same
  // on both of its addresses): a round blows out as many as its charge can, a
  // round that meets a blown cell goes through it, and a panel with HOLE_FALL of
  // them gone comes down. A hole that reaches the floor is a breach a man can
  // get through, and that is flagged on the KIND itself (`K_BREACH`), because
  // the WebAssembly search reads `wallK` and blocks only a kind equal to
  // K_SOLID or K_WINDOW — so a breached wall is open to it with no rebuild.
  // Everything that asks what a wall IS reads `kind & 7` (`wallKind`).
  var K_BREACH = 8, HOLE_COLS = 4, HOLE_ROWS = 2, HOLE_FALL = 5, HOLE_ROW0 = (1 << HOLE_COLS) - 1;
  // (round 110) `damageArea` measures a wall from its own edge, not its cell's
  // middle; the switch is for an A/B (`Structures.EDGE_BLAST.on = false`)
  var EDGE_BLAST = { on: true };
  // …and what one intact floor slab between a burst and a storey lets through
  var SLAB_SHIELD = 0.35;
  function holeCount(h) { var n = 0; while (h) { n += h & 1; h >>= 1; } return n; }
  // Roof shapes.
  var R_FLAT = 0, R_SLOPE_N = 1, R_SLOPE_E = 2, R_SLOPE_S = 3, R_SLOPE_W = 4, R_RIDGE_X = 5, R_RIDGE_Z = 6;
  // Cell features (vertical connectors). Packed: kind | dir<<3 | part<<5.
  var F_NONE = 0, F_STAIR = 1, F_RAMP = 2, F_LADDER = 3;
  var P_SINGLE = 0, P_LOW = 1, P_HIGH = 2;           // which half of a 2-cell run

  /**
   * MATERIALS. `hp` is per piece, so a concrete wall eats a tank round and a
   * thatch roof does not. `fire` is flammability 0..1 (0 = will not burn).
   * `cover` is what standing behind an intact piece of it is worth.
   * `pen` is the fraction of small-arms rounds that punch straight through —
   * a plank wall is concealment, a concrete one is armour.
   */
  // Hexes are deliberately DARKER than the colour you want on screen. The
  // renderer runs `outputEncoding = sRGBEncoding` over linear material colours
  // (see the exposure note in Batch X), which lifts every mid-tone: a literal
  // brick red comes out pastel pink across a surface this big. Props get away
  // with it because they are small; a four-storey wall does not.
  var MATS = [
    null,
    { id: 'wood',     name: 'Wood',      color: 0x6b5133, hp: 110, fire: 1.00, cover: 0.45, pen: 0.35, sound: 'wood',  ruin: false, crush: 40,  track: 0.05 },
    { id: 'plank',    name: 'Planking',  color: 0x574227, hp: 85,  fire: 1.00, cover: 0.40, pen: 0.45, sound: 'wood',  ruin: false, crush: 28,  track: 0.04 },
    { id: 'thatch',   name: 'Thatch',    color: 0x9a8146, hp: 45,  fire: 1.00, cover: 0.28, pen: 0.70, sound: 'foliage', ruin: false, rise: 1.25, crush: 14, track: 0.02 },
    // (round 113) MEASURED ON SCREEN, sunlit, at the playing camera: 0x743f2e
    // drew a brick front as (202, 151, 125) — peach — and 0x3d1f18 a tiled
    // roof as (118, 86, 78), a grey-pink. These draw (177, 105, 89) and
    // (154, 96, 81): Norman brick, and flat clay tile weathered brown (the
    // tile then browner again, 0x3f1a10: in a low sun 0x582010 was orange).
    { id: 'brick',    name: 'Brick',     color: 0x601c0c, hp: 300, fire: 0.00, cover: 0.72, pen: 0.05, sound: 'stone', ruin: true,  crush: 150, track: 0.20 },
    { id: 'stone',    name: 'Stone',     color: 0x77736a, hp: 420, fire: 0.00, cover: 0.78, pen: 0.02, sound: 'stone', ruin: true,  crush: 0,   track: 0.32 },
    { id: 'concrete', name: 'Concrete',  color: 0x8e8b83, hp: 800, fire: 0.00, cover: 0.86, pen: 0.00, sound: 'stone', ruin: true,  crush: 0,   track: 0.46 },
    { id: 'tile',     name: 'Roof tile', color: 0x3f1a10, hp: 80,  fire: 0.15, cover: 0.30, pen: 0.30, sound: 'stone', ruin: false, rise: 0.78, crush: 30, track: 0.05 },
    { id: 'metal',    name: 'Corrugate', color: 0x5c6663, hp: 110, fire: 0.05, cover: 0.35, pen: 0.25, sound: 'metal', ruin: false, rise: 0.42, crush: 45, track: 0.10 },
    { id: 'glass',    name: 'Glass',     color: 0x9fc4d8, hp: 8,   fire: 0.00, cover: 0.05, pen: 0.95, sound: 'metal', ruin: false, crush: 2,   track: 0.00 },
  ];
  var M_WOOD = 1, M_PLANK = 2, M_THATCH = 3, M_BRICK = 4, M_STONE = 5, M_CONCRETE = 6, M_TILE = 7, M_METAL = 8, M_GLASS = 9;

  function matOf(m) { return MATS[m] || null; }

  // =========================================================================
  // GEOMETRY BUILDER — accumulates transformed boxes into one merged mesh
  // =========================================================================
  // Hand-rolled rather than BufferGeometryUtils (which the page doesn't load).
  // Every piece is boxes: a rotated box is a roof slope, a stair tread, a ramp,
  // a window jamb. Colour is per-vertex so ONE material draws the lot.

  var _m4 = null, _eu = null, _v3 = null;

  function Builder(hintBoxes) {
    // Typed arrays that GROW BY DOUBLING, not JS arrays copied into typed
    // arrays at the end. Under bombardment a chunk is re-merged the frame it is
    // hit, and the push-then-copy version spent about 6 ms a chunk doing it.
    var n = Math.max(64, hintBoxes || 256);
    this.cap = n * 24;
    this.pos = new Float32Array(this.cap * 3);
    this.nrm = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.idx = new Uint32Array(n * 36);
    this.n = 0; this.ni = 0;
  }
  Builder.prototype._grow = function () {
    var cap2 = this.cap * 2;
    var p = new Float32Array(cap2 * 3); p.set(this.pos); this.pos = p;
    var q = new Float32Array(cap2 * 3); q.set(this.nrm); this.nrm = q;
    var c = new Float32Array(cap2 * 3); c.set(this.col); this.col = c;
    var i = new Uint32Array(cap2 / 24 * 36); i.set(this.idx); this.idx = i;
    this.cap = cap2;
  };
  // Unit cube corners and per-face data, laid out once.
  var BOX_F = [
    // [nx,ny,nz, corner offsets(4 x 3)]
    [0, 0, 1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    [0, 0, -1, 1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1],
    [1, 0, 0, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1, 1, 1],
    [-1, 0, 0, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1],
    [0, 1, 0, -1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, -1],
    [0, -1, 0, -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1],
  ];

  /** Append an axis-box, optionally rotated, with a flat vertex colour.
   *  `faces` (optional) is a bitmask of the faces to emit, in BOX_F's order —
   *  +z 1, -z 2, +x 4, -x 8, +y 16, -y 32 — for dressing where only one or two
   *  faces can ever be seen (a shutter flat on a wall is its front face). */
  Builder.prototype.box = function (px, py, pz, sx, sy, sz, rx, ry, rz, r, g, b, faces) {
    if (this.n + 24 > this.cap) this._grow();
    if (faces === undefined) faces = 63;
    var rot = !!(rx || ry || rz);
    if (rot) { _eu.set(rx || 0, ry || 0, rz || 0); _m4.makeRotationFromEuler(_eu); }
    var e = _m4.elements;
    var hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    var base = this.n, P = this.pos, N = this.nrm, C = this.col, I = this.idx;
    var v = base * 3, ii = this.ni;
    var emitted = 0;
    for (var f = 0; f < 6; f++) {
      if (!(faces & (1 << f))) continue;
      var F = BOX_F[f];
      var nx = F[0], ny = F[1], nz = F[2];
      if (rot) {
        var tnx = e[0] * nx + e[4] * ny + e[8] * nz;
        var tny = e[1] * nx + e[5] * ny + e[9] * nz;
        var tnz = e[2] * nx + e[6] * ny + e[10] * nz;
        nx = tnx; ny = tny; nz = tnz;
      }
      for (var c2 = 0; c2 < 4; c2++) {
        var ox = F[3 + c2 * 3] * hx, oy = F[4 + c2 * 3] * hy, oz = F[5 + c2 * 3] * hz;
        if (rot) {
          var tx = e[0] * ox + e[4] * oy + e[8] * oz;
          var ty = e[1] * ox + e[5] * oy + e[9] * oz;
          var tz = e[2] * ox + e[6] * oy + e[10] * oz;
          ox = tx; oy = ty; oz = tz;
        }
        P[v] = px + ox; P[v + 1] = py + oy; P[v + 2] = pz + oz;
        N[v] = nx; N[v + 1] = ny; N[v + 2] = nz;
        C[v] = r; C[v + 1] = g; C[v + 2] = b;
        v += 3;
      }
      var q2 = base + emitted * 4;
      I[ii] = q2; I[ii + 1] = q2 + 1; I[ii + 2] = q2 + 2;
      I[ii + 3] = q2; I[ii + 4] = q2 + 2; I[ii + 5] = q2 + 3;
      ii += 6; emitted++;
    }
    this.ni = ii;
    this.n += emitted * 4;
  };

  /** (round 113) Append a modelled piece — `m` an unpacked compact entry
   *  ({n, P, N, C}: corners, non-indexed, C its occlusion) — laid along X
   *  (`alongX`) or turned onto Z, scaled by (sx along, sy up, sz across) and
   *  coloured (r, g, b) times its occlusion. */
  Builder.prototype.mesh = function (m, px, py, pz, alongX, sx, sy, sz, r, g, b) {
    var nv = m.n;
    while (this.n + nv > this.cap) this._grow();
    var P = this.pos, N = this.nrm, C = this.col, I = this.idx, v = this.n * 3, base = this.n, ii = this.ni;
    for (var k = 0; k < nv; k++) {
      var lx = m.P[k * 3] * sx, ly = m.P[k * 3 + 1] * sy, lz = m.P[k * 3 + 2] * sz;
      var nx = m.N[k * 3] / sx, ny = m.N[k * 3 + 1] / sy, nz = m.N[k * 3 + 2] / sz;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (alongX) { P[v] = px + lx; P[v + 2] = pz + lz; N[v] = nx; N[v + 2] = nz; }
      else { P[v] = px + lz; P[v + 2] = pz - lx; N[v] = nz; N[v + 2] = -nx; }    // a quarter turn: a proper rotation, so no face turns inside out
      P[v + 1] = py + ly; N[v + 1] = ny;
      var a = m.C[k * 3];
      C[v] = r * a; C[v + 1] = g * a; C[v + 2] = b * a;
      I[ii + k] = base + k;
      v += 3;
    }
    this.n += nv; this.ni += nv;
  };

  /** (round 113) The spill a shelled wall leaves, modelled in Blender
   *  (tools/blender/props.py -> PROP_PACK.spill), unpacked once; null without
   *  the pack (the three boxes below stand in) or with `game.propPack113`. */
  var _spill = null;
  function spillPieces() {
    var PK = window.PROP_PACK && window.PROP_PACK.spill;
    if (!PK || !PK.length || typeof window.unpackCompact !== 'function' || (window.game && window.game.propPack113 === false)) return null;
    return _spill || (_spill = PK.map(function (e) { return window.unpackCompact(e); }));
  }

  /** (round 113, third batch) THE HOUSES' KIT, modelled in Blender
   *  (tools/blender/doodads.py `chim_stack`, `chim_pots`, `door_frame`,
   *  `door_leaf`, `door_step`; PROP_PACK): a chimney stack with its
   *  oversailing courses and flaunching and the clay pots on it, and an
   *  outside door — its frame, a ledged and braced plank door (or a panelled
   *  one), a worn stone step. Occlusion only, tinted per house like the boxes
   *  they replace, in this file's own units (S = 1). Null without the pack,
   *  with `game.propPack113 = false`, or `Structures.KIT.on = false` (then
   *  rebuild): the boxes below. Drawing only — the simulation reads the wall
   *  grid. Inside doors keep the boxes: a town has thousands of them. */
  var KIT = { on: true, quoins: false }, _kit = null;   // quoins: unfinished, off
  function kitPieces() {
    var P = window.PROP_PACK;
    if (!KIT.on || !P || !P.chimStack || !P.chimPots || !P.doorFrame || !P.doorLeaf || !P.doorStep || typeof window.unpackCompact !== 'function'
        || (window.game && window.game.propPack113 === false)) return null;
    if (_kit) return _kit;
    var u = function (a) { return a.map(function (e) { return window.unpackCompact(e); }); };
    return (_kit = { stack: u(P.chimStack), pots: u(P.chimPots), frame: u(P.doorFrame), leaf: u(P.doorLeaf), step: u(P.doorStep),
      win: P.winFrame && P.winSill && P.winShutters ? { frame: u(P.winFrame), sill: u(P.winSill), shut: u(P.winShutters) } : null,
      ridge: P.roofRidge ? u(P.roofRidge) : null, quoin: P.quoin ? u(P.quoin) : null });
  }

  Builder.prototype.reset = function () { this.n = 0; this.ni = 0; };
  /** `slice`, not `subarray`: the geometry has to OWN its buffers, because the
   *  builder itself is reused for the next chunk. */
  Builder.prototype.geometry = function () {
    if (!this.n) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.n * 3), 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    return g;
  };

  // ---- colour helpers -----------------------------------------------------
  // Every piece gets a small deterministic tint jitter so a fifty-metre brick
  // terrace is not one flat rectangle of the same hex code, and a damaged one
  // darkens toward soot. Free: it is vertex data on geometry we already build.
  var _c = { r: 0, g: 0, b: 0 };
  function shade(mat, seed, dmg, lightMul) {
    var base = mat.color;
    var j = ((seed * 2654435761) >>> 0) / 4294967296;         // 0..1
    // ±2.5%, not ±6.5% (round 106): every piece is a whole cell, and at life
    // size a cell is six metres — a roof or a brick front came out as a
    // patchwork of six-metre panels of different tone, a grid nobody builds.
    // The weathering is continuous now, in the surface (assets/fabric.js).
    var k = (1 + (j - 0.5) * 0.05) * (lightMul || 1);
    var d = dmg > 0 ? (1 - dmg * 0.55) : 1;                    // scorch/soot
    _c.r = Math.min(1, ((base >> 16) & 255) / 255 * k * d);
    _c.g = Math.min(1, ((base >> 8) & 255) / 255 * k * d);
    _c.b = Math.min(1, (base & 255) / 255 * k * d);
    return _c;
  }

  // =========================================================================
  // PIECE EMITTERS — one function per modular piece
  // =========================================================================
  // All take (B, x, y, z) where (x,z) is the CELL CENTRE and y is the level's
  // floor surface, and draw in world space so the merge is transform-free.

  var T = 1.5;   // TILE, refreshed on install

  /** Solid / door / window / arch / rubble wall on one edge of a cell. */
  function emitWall(B, cx, y, cz, edge, mat, kind, dmg, seed, holes) {
    var d = EDGE_D[edge];
    var wx = cx + d[0] * T * 0.5, wz = cz + d[1] * T * 0.5;
    var horiz = (edge === 0 || edge === 2);                 // runs along X
    var lx = horiz ? T : WALL_TH, lz = horiz ? WALL_TH : T;
    var c = shade(mat, seed, dmg);
    var H = FLOOR_H;
    if (holes && kind !== K_RUBBLE) { emitHoledWall(B, wx, y, wz, horiz, mat, kind, c, holes, seed); return; }

    if (kind === K_RUBBLE) {
      // A masonry wall shot down: a knee-high spill of broken courses. Still
      // worth getting behind, no longer worth hiding behind.
      var rc = shade(mat, seed + 7, 0.35);
      // (round 113) MODELLED IN BLENDER: a ridge of dust and broken courses
      // along the wall's line with the occlusion between them, in the wall's
      // own material — the fabric shader gives its pieces their brick or
      // stone. 0.42-0.62 of S high: never over the 0.62 the sightline test
      // gives a rubble wall (`_rayWall`, `aperture`). Three boxes without the pack.
      var SP = spillPieces();
      if (SP) {
        var js = (((seed + 31) * 2654435761) >>> 0) / 4294967296;
        B.mesh(SP[(seed >>> 0) % SP.length], wx, y, wz, horiz, T * 1.02, (0.42 + js * 0.2) * S, WALL_TH * 3.2, rc.r, rc.g, rc.b);
        return;
      }
      for (var i = 0; i < 3; i++) {
        var t = (i - 1) * T * 0.3;
        var jj = (((seed + i * 31) * 2654435761) >>> 0) / 4294967296;
        var hgt = (0.28 + jj * 0.34) * S;
        B.box(wx + (horiz ? t : 0), y + hgt * 0.5, wz + (horiz ? 0 : t),
          (horiz ? T * 0.34 : WALL_TH * 2.2), hgt, (horiz ? WALL_TH * 2.2 : T * 0.34),
          0, jj * 0.5, (jj - 0.5) * 0.3, rc.r, rc.g, rc.b);
      }
      return;
    }
    if (kind === K_ARCH) {                                  // open frame: posts + lintel
      var pw = T * 0.16;
      for (var s = -1; s <= 1; s += 2) {
        B.box(wx + (horiz ? s * (T * 0.5 - pw * 0.5) : 0), y + H * 0.5, wz + (horiz ? 0 : s * (T * 0.5 - pw * 0.5)),
          (horiz ? pw : WALL_TH), H, (horiz ? WALL_TH : pw), 0, 0, 0, c.r, c.g, c.b);
      }
      B.box(wx, y + H - 0.16 * S, wz, lx, 0.32 * S, lz, 0, 0, 0, c.r, c.g, c.b);
      return;
    }
    if (kind === K_DOOR) {
      // Jambs either side of a 0.72-wide opening, plus the lintel over it.
      var open = 0.72 * S, side = (T - open) * 0.5, dh = 1.55 * S;
      for (var s2 = -1; s2 <= 1; s2 += 2) {
        var off = s2 * (T - side) * 0.5;
        B.box(wx + (horiz ? off : 0), y + H * 0.5, wz + (horiz ? 0 : off),
          (horiz ? side : WALL_TH), H, (horiz ? WALL_TH : side), 0, 0, 0, c.r, c.g, c.b);
      }
      B.box(wx, y + dh + (H - dh) * 0.5, wz, (horiz ? open : WALL_TH), H - dh, (horiz ? WALL_TH : open), 0, 0, 0, c.r, c.g, c.b);
      return;
    }
    if (kind === K_WINDOW && pairs()) {
      // two openings at a quarter of the cell either side of the middle: three
      // piers (the middle one as wide as two side jambs, so the rhythm runs on
      // across the next cell), a sill and a lintel each
      var ow2 = 0.82 * S, sill2 = 0.78 * S, top2 = 1.62 * S, q = T * 0.25;
      var sj2 = q - ow2 * 0.5, mid2 = T * 0.5 - ow2;
      var piers = [[-(T * 0.5 - sj2 * 0.5), sj2], [0, mid2], [T * 0.5 - sj2 * 0.5, sj2]];
      for (var pi = 0; pi < 3; pi++) {
        var po = piers[pi][0], pw2 = piers[pi][1];
        B.box(wx + (horiz ? po : 0), y + H * 0.5, wz + (horiz ? 0 : po),
          (horiz ? pw2 : WALL_TH), H, (horiz ? WALL_TH : pw2), 0, 0, 0, c.r, c.g, c.b);
      }
      for (var s4 = -1; s4 <= 1; s4 += 2) {
        var oo = s4 * q;
        B.box(wx + (horiz ? oo : 0), y + sill2 * 0.5, wz + (horiz ? 0 : oo), (horiz ? ow2 : WALL_TH), sill2, (horiz ? WALL_TH : ow2), 0, 0, 0, c.r, c.g, c.b);
        B.box(wx + (horiz ? oo : 0), y + top2 + (H - top2) * 0.5, wz + (horiz ? 0 : oo), (horiz ? ow2 : WALL_TH), H - top2, (horiz ? WALL_TH : ow2), 0, 0, 0, c.r, c.g, c.b);
      }
      return;
    }
    if (kind === K_WINDOW) {
      // Sill, lintel and jambs around a 0.82 x 0.8 opening at chest height —
      // the shape that makes a building a firing position.
      var ow = 0.82 * S, sill = 0.78 * S, top = 1.62 * S, sj = (T - ow) * 0.5;
      for (var s3 = -1; s3 <= 1; s3 += 2) {
        var off3 = s3 * (T - sj) * 0.5;
        B.box(wx + (horiz ? off3 : 0), y + H * 0.5, wz + (horiz ? 0 : off3),
          (horiz ? sj : WALL_TH), H, (horiz ? WALL_TH : sj), 0, 0, 0, c.r, c.g, c.b);
      }
      B.box(wx, y + sill * 0.5, wz, (horiz ? ow : WALL_TH), sill, (horiz ? WALL_TH : ow), 0, 0, 0, c.r, c.g, c.b);
      B.box(wx, y + top + (H - top) * 0.5, wz, (horiz ? ow : WALL_TH), H - top, (horiz ? WALL_TH : ow), 0, 0, 0, c.r, c.g, c.b);
      return;
    }
    // Solid. Masonry gets a course line near the top so a big blank face reads
    // as built rather than extruded.
    B.box(wx, y + H * 0.5, wz, lx, H, lz, 0, 0, 0, c.r, c.g, c.b);
    if (mat.ruin) {
      var t2 = shade(mat, seed + 3, dmg, 0.88);
      // (round 113) 3% longer ALONG the wall and half again as thick ACROSS it,
      // whichever way it runs. It was `lx * 1.03, lz * 1.5` for both, so on a
      // north-south wall (lx its thickness, lz its length) the band ran half
      // again the cell's length — a quarter cell past each end: a strip at
      // the top of every storey sticking 1.5 m out into the street wherever
      // an inside wall met a facade, and past the corner of every gable end.
      B.box(wx, y + H - 0.09 * S, wz, horiz ? lx * 1.03 : lx * 1.5, 0.1 * S, horiz ? lz * 1.5 : lz * 1.03, 0, 0, 0, t2.r, t2.g, t2.b);
    }
  }

  /**
   * A WALL WITH SHELL HOLES IN IT (round 110): the panel less every opening it
   * has — its own windows or door, and the holes — drawn as the strips between
   * them. Each hole is its cell of the grid (`_holeBit`), ragged by a hashed
   * inset on every side it does not share with another hole, so two side by
   * side read as one wider breach; a tooth of masonry is left standing into
   * each, and broken brick lies either side of one that reaches the floor.
   * The simulation's hole is the whole cell, so a round can pass a little way
   * into the drawn jamb — never the other way round.
   */
  var _ops = [], _xs = [];
  function hsh(seed, k) { return ((((seed + k * 7919) | 0) * 2654435761) >>> 0) / 4294967296; }
  function emitHoledWall(B, wx, y, wz, horiz, mat, kind, c, holes, seed) {
    var H = FLOOR_H, cw = T / HOLE_COLS, rh = H / HOLE_ROWS;
    _ops.length = 0;
    // its own openings, in panel coordinates: u along the edge from its start, v up from the floor
    if (kind === K_WINDOW) {
      var ow = 0.82 * S, sl = 0.78 * S, tp = 1.62 * S;
      if (pairs()) _ops.push(T * 0.25 - ow * 0.5, T * 0.25 + ow * 0.5, sl, tp, T * 0.75 - ow * 0.5, T * 0.75 + ow * 0.5, sl, tp);
      else _ops.push(T * 0.5 - ow * 0.5, T * 0.5 + ow * 0.5, sl, tp);
    } else if (kind === K_DOOR) {
      var dw = 0.72 * S;
      _ops.push(T * 0.5 - dw * 0.5, T * 0.5 + dw * 0.5, 0, 1.55 * S);
    } else if (kind === K_ARCH) {
      _ops.push(T * 0.16, T * 0.84, 0, H - 0.32 * S);
    }
    var nOwn = _ops.length;
    var dk = { r: c.r * 0.8, g: c.g * 0.8, b: c.b * 0.8 };
    for (var b = 0; b < HOLE_COLS * HOLE_ROWS; b++) {
      if (!(holes & (1 << b))) continue;
      var col = b % HOLE_COLS, row = (b / HOLE_COLS) | 0;
      var nl = col > 0 && (holes & (1 << (b - 1))), nr = col < HOLE_COLS - 1 && (holes & (1 << (b + 1)));
      var nd = row > 0 && (holes & (1 << (b - HOLE_COLS))), nu = row < HOLE_ROWS - 1 && (holes & (1 << (b + HOLE_COLS)));
      var u0 = col * cw + (nl ? 0 : cw * (0.06 + 0.16 * hsh(seed, b * 4))),
          u1 = (col + 1) * cw - (nr ? 0 : cw * (0.06 + 0.16 * hsh(seed, b * 4 + 1))),
          v0 = row * rh + (nd ? 0 : rh * (0.05 + 0.12 * hsh(seed, b * 4 + 2))),
          v1 = (row + 1) * rh - (nu ? 0 : Math.max(0.14 * S, rh * (0.08 + 0.16 * hsh(seed, b * 4 + 3))));
      _ops.push(u0, u1, v0, v1);
      // a tooth of broken masonry standing into the hole from one of its free sides
      var side = (hsh(seed, b * 4 + 5) * 4) | 0, tw = cw * (0.14 + 0.14 * hsh(seed, b * 4 + 6)), th = rh * (0.16 + 0.22 * hsh(seed, b * 4 + 7));
      var tu, tv, sw, sh;
      if (side === 0 && !nd) { tu = u0 + (u1 - u0) * (0.25 + 0.5 * hsh(seed, b * 4 + 8)); tv = v0 + th * 0.5; sw = tw; sh = th; }
      else if (side === 1 && !nu) { tu = u0 + (u1 - u0) * (0.25 + 0.5 * hsh(seed, b * 4 + 8)); tv = v1 - th * 0.5; sw = tw; sh = th; }
      else if (side === 2 && !nl) { tu = u0 + th * 0.5; tv = v0 + (v1 - v0) * (0.3 + 0.4 * hsh(seed, b * 4 + 8)); sw = th; sh = tw; }
      else if (!nr) { tu = u1 - th * 0.5; tv = v0 + (v1 - v0) * (0.3 + 0.4 * hsh(seed, b * 4 + 8)); sw = th; sh = tw; }
      if (tu !== undefined) {
        var to = tu - T * 0.5;
        var tr = (hsh(seed, b * 4 + 9) - 0.5) * 0.6;     // tilted in the plane of the wall
        B.box(wx + (horiz ? to : 0), y + tv, wz + (horiz ? 0 : to), horiz ? sw : WALL_TH * 0.8, sh, horiz ? WALL_TH * 0.8 : sw,
          horiz ? 0 : tr, 0, horiz ? tr : 0, dk.r, dk.g, dk.b);
      }
      // broken brick either side of a hole down to the floor
      if (row === 0) {
        var ru = (u0 + u1) * 0.5 - T * 0.5, rw = (u1 - u0) * 0.8, rhh = (0.1 + 0.12 * hsh(seed, b * 4 + 10)) * S;
        B.box(wx + (horiz ? ru : 0), y + rhh * 0.5, wz + (horiz ? 0 : ru), horiz ? rw : WALL_TH * 3.2, rhh, horiz ? WALL_TH * 3.2 : rw,
          0, (hsh(seed, b * 4 + 11) - 0.5) * 0.5, 0, dk.r, dk.g, dk.b);
      }
    }
    // the strips between the openings
    _xs.length = 0; _xs.push(0, T);
    for (var k = 0; k < _ops.length; k += 4) { _xs.push(Math.max(0, Math.min(T, _ops[k])), Math.max(0, Math.min(T, _ops[k + 1]))); }
    _xs.sort(function (p, q) { return p - q; });
    var runA = -1, runB = -1, runKey = null, runCov = null;
    for (var xi = 0; xi < _xs.length - 1; xi++) {
      var a = _xs[xi], bb = _xs[xi + 1];
      if (bb - a < 1e-4) continue;
      var mid = (a + bb) * 0.5, cov = [];
      for (var k2 = 0; k2 < _ops.length; k2 += 4) if (_ops[k2] <= mid && _ops[k2 + 1] >= mid) cov.push(_ops[k2 + 2], _ops[k2 + 3]);
      // merge the covered heights
      var segs = [];
      for (var q = 0; q < cov.length; q += 2) segs.push([cov[q], cov[q + 1]]);
      segs.sort(function (p, r) { return p[0] - r[0]; });
      var mg = [];
      for (var q2 = 0; q2 < segs.length; q2++) {
        if (mg.length && segs[q2][0] <= mg[mg.length - 1][1] + 1e-4) mg[mg.length - 1][1] = Math.max(mg[mg.length - 1][1], segs[q2][1]);
        else mg.push([segs[q2][0], segs[q2][1]]);
      }
      var key = mg.map(function (p) { return p[0].toFixed(4) + ':' + p[1].toFixed(4); }).join(',');
      if (key === runKey) { runB = bb; continue; }
      if (runKey !== null) solidStrip(B, wx, y, wz, horiz, runA, runB, runCov, c, H);
      runA = a; runB = bb; runKey = key; runCov = mg;
    }
    if (runKey !== null) solidStrip(B, wx, y, wz, horiz, runA, runB, runCov, c, H);
    // the course line along the top, as on an unbroken masonry face (`c` is the
    // shared colour `shade` returns, so it is read here and not shaded again)
    if (mat.ruin && kind === K_SOLID) {
      B.box(wx, y + H - 0.09 * S, wz, horiz ? T * 1.03 : WALL_TH * 1.5, 0.1 * S, horiz ? WALL_TH * 1.5 : T * 1.03, 0, 0, 0, c.r * 0.88, c.g * 0.88, c.b * 0.88);
    }
    return nOwn;
  }
  /** The solid parts of one strip [ua, ub] of a holed panel: everything not covered. */
  function solidStrip(B, wx, y, wz, horiz, ua, ub, cov, c, H) {
    var off = (ua + ub) * 0.5 - T * 0.5, w = ub - ua, v = 0;
    for (var i = 0; i <= cov.length; i++) {
      var c0 = i < cov.length ? cov[i][0] : H;
      if (c0 > v + 1e-4) {
        B.box(wx + (horiz ? off : 0), y + (v + c0) * 0.5, wz + (horiz ? 0 : off),
          horiz ? w : WALL_TH, c0 - v, horiz ? WALL_TH : w, 0, 0, 0, c.r, c.g, c.b);
      }
      if (i < cov.length) v = Math.max(v, cov[i][1]);
    }
  }

  // ---- THE DRESSING (round 98) --------------------------------------------
  // A French or Belgian village house is read by its joinery: casement windows
  // with a cross of glazing bars, a stone sill, and a pair of painted wooden
  // shutters folded back against the wall — grey-blue, faded green, ox-blood,
  // brown — and a plank door. Without them a house here was a brick box with
  // square holes. All of it is paint and wood the simulation never reads:
  // cover, sight and breaching are the wall grid's, drawn or not.
  var DRESS = { on: true };   // the A/B switch (Structures.DRESS.on = false, then rebuild every chunk)
  var SHUTTER = [0x5a6f7c, 0x4d6448, 0x6a2c24, 0x4a3a2a, 0x6b6f5a, 0x3f5560];
  var FRAME = [0xcdc6b4, 0xb9b3a2, 0x5a6f7c, 0x4a3a2a];
  var _dc = { r: 0, g: 0, b: 0 };
  function hexc(h, k) {
    _dc.r = ((h >> 16) & 255) / 255 * k; _dc.g = ((h >> 8) & 255) / 255 * k; _dc.b = (h & 255) / 255 * k;
    return _dc;
  }
  /** A house's colours, the same for every window in it: `hseed` is taken
   *  over a block of cells (see the caller), so a house rarely mixes two. */
  function paletteOf(hseed) {
    var j = (hseed * 2654435761) >>> 0;
    return { sh: SHUTTER[j % SHUTTER.length], fr: FRAME[(j >>> 8) % FRAME.length], closed: ((j >>> 16) % 100) };
  }
  /** `out`: +1 when the outside is across the edge, -1 when it is this side,
   *  0 for a wall between two rooms (no shutters on the inside of a house). */
  function emitWindowDressing(B, cx, y, cz, edge, out, pal, seed, off) {
    var d = EDGE_D[edge];
    var horiz = (edge === 0 || edge === 2);
    off = off || 0;
    var wx = cx + d[0] * T * 0.5 + (horiz ? off : 0), wz = cz + d[1] * T * 0.5 + (horiz ? 0 : off);
    var ow = 0.82 * S, sill = 0.78 * S, top = 1.62 * S, hh = top - sill, mid = y + (sill + top) * 0.5;
    var fr = hexc(pal.fr, 1), frr = fr.r, frg = fr.g, frb = fr.b;
    // faces: both along the wall's normal, the outward one, the top
    var NB = horiz ? 3 : 12, OB = horiz ? (out * d[1] > 0 ? 1 : 2) : (out * d[0] > 0 ? 4 : 8), TOP = 16;
    function bx(a, b2, yy, la, ly, ln, r, g, b, faces) {
      B.box(horiz ? wx + a : wx + b2 * d[0], yy, horiz ? wz + b2 * d[1] : wz + a,
        horiz ? la : ln, ly, horiz ? ln : la, 0, 0, 0, r, g, b, faces);
    }
    // (round 113, third batch) THE BLENDER WINDOW (tools/blender/doodads.py
    // `win_frame`, `win_sill`, `win_shutters`): the same frame, sill and
    // shutters in about the boxes' triangles (42 against 36 — a town has tens
    // of thousands), the reveal's and the joints' shading baked by Cycles;
    // turned to whichever side is outside, tinted per house as before
    var KW = kitPieces();
    if (KW && KW.win) {
      var sg = out ? (horiz ? (out * d[1] > 0 ? 1 : -1) : (out * d[0] > 0 ? 1 : -1)) : 1;
      B.mesh(KW.win.frame[0], wx, y, wz, horiz, sg * S, S, sg * S, frr, frg, frb);
      if (!out) return;
      var sc0 = hexc(0x8a8478, 1);
      B.mesh(KW.win.sill[0], wx, y, wz, horiz, sg * S, S, sg * S, sc0.r, sc0.g, sc0.b);
      var sh0 = hexc(pal.sh, 0.95 + ((seed >>> 3) % 10) * 0.01), fo = WALL_TH * 0.5 + 0.022 * S;
      B.mesh(KW.win.shut[((seed >>> 5) % 100) < 14 ? 1 : 0], horiz ? wx : wx + sg * fo, y, horiz ? wz + sg * fo : wz, horiz, sg * S, S, sg * S, sh0.r, sh0.g, sh0.b);
      return;
    }
    // the casement frame in the opening, and its glazing bars — seen from
    // either side, never edge-on, so two faces each
    for (var s = -1; s <= 1; s += 2) bx(s * (ow * 0.5 - 0.03 * S), 0, mid, 0.06 * S, hh, WALL_TH * 0.62, frr, frg, frb, NB);
    bx(0, 0, y + top - 0.03 * S, ow, 0.06 * S, WALL_TH * 0.62, frr, frg, frb, NB);
    bx(0, 0, y + sill + 0.03 * S, ow, 0.06 * S, WALL_TH * 0.62, frr, frg, frb, NB);
    bx(0, 0, mid, 0.035 * S, hh, WALL_TH * 0.4, frr, frg, frb, NB);
    bx(0, 0, y + sill + hh * 0.62, ow, 0.035 * S, WALL_TH * 0.4, frr, frg, frb, NB);
    if (!out) return;
    // the stone sill, standing proud of the wall outside: its top and its front
    var sc = hexc(0x8a8478, 1);
    bx(0, out * 0.05 * S, y + sill - 0.03 * S, ow + 0.14 * S, 0.06 * S, WALL_TH + 0.10 * S, sc.r, sc.g, sc.b, TOP | OB);
    // the shutters: folded back flat against the wall, or (sometimes) closed —
    // a board on a wall is its front face and nothing else
    var sh = hexc(pal.sh, 0.95 + ((seed >>> 3) % 10) * 0.01), shr = sh.r, shg = sh.g, shb = sh.b;
    var face = out * (WALL_TH * 0.5 + 0.022 * S);
    var closed = ((seed >>> 5) % 100) < 14;
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      var a0 = closed ? s2 * ow * 0.25 : s2 * (ow * 0.5 + 0.21 * S);
      bx(a0, face, mid, ow * 0.5, hh + 0.04 * S, 0.035 * S, shr, shg, shb, OB | TOP);
    }
  }
  function emitDoorDressing(B, cx, y, cz, edge, out, pal, seed) {
    var d = EDGE_D[edge];
    var horiz = (edge === 0 || edge === 2);
    var wx = cx + d[0] * T * 0.5, wz = cz + d[1] * T * 0.5;
    var open = 0.72 * S, dh = 1.55 * S;
    var fr = hexc(pal.fr, 0.9), frr = fr.r, frg = fr.g, frb = fr.b;
    var NB = horiz ? 3 : 12, AB = horiz ? 12 : 3, TOP = 16;
    function bx(a, b2, yy, la, ly, ln, r, g, b, faces) {
      B.box(horiz ? wx + a : wx + b2 * d[0], yy, horiz ? wz + b2 * d[1] : wz + a,
        horiz ? la : ln, ly, horiz ? ln : la, 0, 0, 0, r, g, b, faces);
    }
    var KP = out ? kitPieces() : null;
    if (KP) {
      // (round 113) the Blender door: frame, leaf standing open into the
      // room on its hinge side, the step outside — where the boxes stood
      B.mesh(KP.frame[0], wx, y, wz, horiz, S, S, S, frr, frg, frb);
      var dc0 = hexc(pal.sh, 0.8), dr = dc0.r, dg = dc0.g, db = dc0.b;
      var inw = -out, hinge0 = open * 0.5 - 0.04 * S, leafW0 = open - 0.08 * S, dep0 = inw * (WALL_TH * 0.5 + leafW0 * 0.5 * 0.985);
      var lf = KP.leaf[((seed >>> 4) % 100) < 25 ? 1 : 0];
      B.mesh(lf, horiz ? wx + hinge0 - 0.02 * S : wx + dep0 * d[0], y, horiz ? wz + dep0 * d[1] : wz + hinge0 - 0.02 * S, !horiz, S, S, S, dr, dg, db);
      var st0 = hexc(0x8a8478, 0.95), sb = out * (WALL_TH * 0.5 + 0.14 * S);
      B.mesh(KP.step[0], horiz ? wx : wx + sb * d[0], y, horiz ? wz + sb * d[1] : wz, horiz, S, S, S, st0.r, st0.g, st0.b);
      return;
    }
    for (var s = -1; s <= 1; s += 2) bx(s * (open * 0.5 - 0.035 * S), 0, y + dh * 0.5, 0.07 * S, dh, WALL_TH * 0.7, frr, frg, frb, NB);
    bx(0, 0, y + dh - 0.035 * S, open, 0.07 * S, WALL_TH * 0.7, frr, frg, frb, NB);
    // the door itself, standing open into the room — its two faces
    var dc = hexc(pal.sh, 0.8);
    var inward = out ? -out : -1;
    var hinge = open * 0.5 - 0.04 * S;
    var leafW = open - 0.08 * S, depth = inward * (WALL_TH * 0.5 + leafW * 0.5 * 0.985);
    bx(hinge - 0.02 * S, depth, y + (dh - 0.06 * S) * 0.5, 0.05 * S, dh - 0.06 * S, leafW, dc.r, dc.g, dc.b, AB);
    if (out) {     // a stone step before an outside door: its top and its front
      var st = hexc(0x8a8478, 0.95);
      var OB = horiz ? (out * d[1] > 0 ? 1 : 2) : (out * d[0] > 0 ? 4 : 8);
      bx(0, out * (WALL_TH * 0.5 + 0.14 * S), y + 0.05 * S, open + 0.24 * S, 0.10 * S, 0.30 * S, st.r, st.g, st.b, TOP | OB);
    }
  }
  /** WHAT A ROOF IS COVERED WITH, house by house. From the camera this game
   *  uses most of a village is roof, and every tiled roof was the same
   *  red-brown: Normandy's are slate in the towns and flat clay tiles in the
   *  country, some new and orange, some weathered to brown or lichen-grey.
   *  Only the tile roofs vary — thatch, corrugated iron and concrete are what
   *  they are. Returns a look-alike of the material with its own colour. */
  // (round 113) the clay tiles re-measured with the base tile (see MATS): a
  // brown and a redder firing; the slates and the lichen-grey as they were
  var ROOF_LOOK = [null, 0x33383f, 0x42200f, 0x562412, 0x2c323a, 0x564a3e];
  var _roofMats = {};
  // A HOUSE'S OWN FRONT (round 106). The houses of a block (`_buildBlock`) are
  // told apart by their walls as a street's are — brick of several firings,
  // limewash and render over it, Caen stone — and not only by the roof and the
  // shutters. Drawing only: the material, and so the wall's strength, is the
  // house's. 0 is the material's own colour; nothing but a block sets a look.
  var WALL_LOOK = {
    // (round 113) the three firings re-measured with the base brick (MATS)
    brick: [0, 0x6a2412, 0x521a0e, 0x5e2a16, 0xd9cdb2, 0xcfb58a, 0xd6cfc0, 0xbdb3a0, 0xd2a593],
    stone: [0, 0xc9bd9c, 0xa9a394, 0xb9ad93, 0xd7cfb9, 0x8f8a7e],
    wood:  [0, 0x75583a, 0x5f4a33, 0xcdbf9f],
    plank: [0, 0x5f4a2e, 0x4e3c25, 0x6a5537],
  };
  var _wallMats = {};
  /** (round 113) A FRONT FOR A HOUSE NOBODY GAVE ONE. Only a block's houses
   *  (`_buildBlock`) carried a look; a house laid in the editor — every house
   *  in Village, which is brick — was the material's one colour, so a whole
   *  village was one brick. By the house's id: seven in ten a brick of its own
   *  firing, three limewashed or rendered over it, as a Norman street is.
   *  `Structures.HOUSE_LOOK.on = false` (then rebuild) is one colour again. */
  var HOUSE_LOOK = { on: true };
  function houseLook(bid) {
    var h = (bid * 2246822519) >>> 0, r = h % 100;
    return r < 70 ? ((h >>> 8) % 4) : 4 + ((h >>> 8) % 5);
  }
  function wallLook(mat, look) {
    var L = look && mat && WALL_LOOK[mat.id];
    if (!L) return mat;
    var h = L[look % L.length];
    if (!h) return mat;
    return _wallMats[mat.id + h] || (_wallMats[mat.id + h] = Object.assign({}, mat, { color: h }));
  }
  function roofLook(mat, bid) {
    if (!mat || mat.id !== 'tile' || !bid) return mat;
    var h = ROOF_LOOK[(bid * 2654435761 >>> 7) % ROOF_LOOK.length];
    if (!h) return mat;
    return _roofMats[h] || (_roofMats[h] = Object.assign({}, mat, { color: h }));
  }
  /** A chimney stack on the ridge at a gable end, for a masonry house. */
  function emitChimney(B, cx, yRidge, cz, edge, mat, seed) {
    var d = EDGE_D[edge];
    var c = shade(mat, seed + 13, 0, 0.92);
    var x = cx + d[0] * T * 0.36, z = cz + d[1] * T * 0.36;
    var KP = kitPieces();
    if (KP) {    // (round 113) the Blender stack and its pots
      B.mesh(KP.stack[0], x, yRidge, z, true, S, S, S, c.r, c.g, c.b);
      var pt = hexc(0x7a3b28, 0.9);
      B.mesh(KP.pots[(seed >>> 3) % KP.pots.length], x, yRidge, z, (seed & 1) === 0, S, S, S, pt.r, pt.g, pt.b);
      return;
    }
    B.box(x, yRidge + 0.45 * S, z, 0.46 * S, 1.25 * S, 0.46 * S, 0, 0, 0, c.r, c.g, c.b);
    var k = shade(mat, seed + 17, 0, 0.8);
    B.box(x, yRidge + 1.10 * S, z, 0.56 * S, 0.08 * S, 0.56 * S, 0, 0, 0, k.r, k.g, k.b);           // the capping course
    var pot = hexc(0x7a3b28, 0.9);
    B.box(x, yRidge + 1.24 * S, z, 0.14 * S, 0.2 * S, 0.14 * S, 0, 0, 0, pot.r, pot.g, pot.b);    // a clay pot
  }

  /** Glass pane for a window — drawn into the transparent batch. */
  function emitGlass(B, cx, y, cz, edge, seed, off) {
    var d = EDGE_D[edge];
    var horiz = (edge === 0 || edge === 2);
    var c = shade(MATS[M_GLASS], seed, 0);
    off = off || 0;
    B.box(cx + d[0] * T * 0.5 + (horiz ? off : 0), y + 1.2 * S, cz + d[1] * T * 0.5 + (horiz ? 0 : off),
      (horiz ? 0.8 * S : 0.05 * S), 0.82 * S, (horiz ? 0.05 * S : 0.8 * S), 0, 0, 0, c.r, c.g, c.b);
  }

  /** Floor slab: the surface of level L, hanging under it. */
  function emitFloor(B, cx, y, cz, mat, dmg, seed) {
    var c = shade(mat, seed, dmg, 0.92);
    B.box(cx, y - FLOOR_TH * 0.5, cz, T, FLOOR_TH, T, 0, 0, 0, c.r, c.g, c.b);
  }

  /**
   * Roof cell. `rank` is how many cells in from the eaves this one sits, and it
   * is what makes a multi-cell roof a PLANE instead of a staircase of little
   * gables: each cell's panel is lifted `rank * ROOF_RISE` and pitched to meet
   * its neighbours exactly. A 3-cell half-span comes out at 22.5 degrees.
   */
  function emitRoof(B, cx, y, cz, mat, shape, rank, dmg, seed) {
    var c = shade(mat, seed, dmg);
    var RISE = riseOf(mat);
    var ov = (RISE > 1 ? 0.34 : 0.18) * S;     // thatch is laid with deep eaves
    var base = y + (rank || 0) * RISE;
    if (shape === R_FLAT) {
      B.box(cx, y + 0.12 * S, cz, T + ov, 0.24 * S, T + ov, 0, 0, 0, c.r, c.g, c.b);
      return;
    }
    var pitch = Math.atan2(RISE, T);
    var len = Math.hypot(T, RISE);
    if (shape === R_RIDGE_X || shape === R_RIDGE_Z) {
      // The capping cell where the two slopes meet.
      var alongX = (shape === R_RIDGE_X);
      for (var s = -1; s <= 1; s += 2) {
        B.box(cx + (alongX ? 0 : s * T * 0.25), base + RISE * 0.25, cz + (alongX ? s * T * 0.25 : 0),
          alongX ? T + ov : len * 0.5 + ov, 0.17 * S, alongX ? len * 0.5 + ov : T + ov,
          alongX ? s * pitch : 0, 0, alongX ? 0 : -s * pitch, c.r, c.g, c.b);
      }
      var rc = shade(mat, seed + 5, dmg, 1.06);
      // (round 113, third batch) half-round ridge tiles, modelled in Blender
      // (`roof_ridge`), where the pack has them — not on thatch or iron
      var KR = RISE <= ROOF_RISE * 1.01 ? kitPieces() : null;
      if (KR && KR.ridge) { B.mesh(KR.ridge[0], cx, base + RISE * 0.5 + 0.03 * S, cz, alongX, T + ov, S, S, rc.r, rc.g, rc.b); return; }
      B.box(cx, base + RISE * 0.5 + 0.08 * S, cz,
        alongX ? T + ov : 0.24 * S, 0.14 * S, alongX ? 0.24 * S : T + ov, 0, 0, 0, rc.r, rc.g, rc.b);
      return;
    }
    // Single slope, descending toward `shape`'s direction.
    var dir = shape - 1;                  // 0..3 → N E S W
    var dd = EDGE_D[dir];
    var alongX2 = (dir === 1 || dir === 3);
    B.box(cx, base + RISE * 0.5, cz,
      alongX2 ? len + ov : T + ov, 0.17 * S, alongX2 ? T + ov : len + ov,
      alongX2 ? 0 : dd[1] * pitch, 0, alongX2 ? -dd[0] * pitch : 0, c.r, c.g, c.b);
  }

  /** Stairs / ramp / ladder inside one cell (or one half of a two-cell run). */
  function emitFeature(B, cx, y, cz, kind, dir, part, mat, dmg, seed) {
    var c = shade(mat, seed, dmg, 0.96);
    var d = EDGE_D[dir];                       // the direction of CLIMB
    var alongX = (dir === 1 || dir === 3);
    var runCells = (part === P_SINGLE) ? 1 : 2;
    var rise = FLOOR_H / runCells;             // this cell's share of the climb
    var y0 = y + (part === P_HIGH ? FLOOR_H * 0.5 : 0);

    if (kind === F_LADDER) {
      var lx = cx - d[0] * T * 0.4, lz = cz - d[1] * T * 0.4;
      for (var s = -1; s <= 1; s += 2) {
        B.box(lx + (alongX ? 0 : s * 0.22 * S), y + FLOOR_H * 0.5, lz + (alongX ? s * 0.22 * S : 0),
          0.06 * S, FLOOR_H, 0.06 * S, 0, 0, 0, c.r, c.g, c.b);
      }
      for (var r = 0; r < 6; r++) {
        B.box(lx, y + 0.2 * S + r * (FLOOR_H - 0.3 * S) / 5, lz,
          alongX ? 0.06 * S : 0.44 * S, 0.05 * S, alongX ? 0.44 * S : 0.06 * S, 0, 0, 0, c.r, c.g, c.b);
      }
      return;
    }
    if (kind === F_RAMP) {
      var pitch = Math.atan2(rise, T);
      var len = Math.hypot(T, rise);
      B.box(cx, y0 + rise * 0.5, cz, alongX ? len : T * 0.92, 0.16 * S, alongX ? T * 0.92 : len,
        alongX ? 0 : -d[1] * pitch, 0, alongX ? d[0] * pitch : 0, c.r, c.g, c.b);
      return;
    }
    // Stairs: real treads, so a steep single-cell flight still reads as stairs.
    var N = 7;
    for (var i = 0; i < N; i++) {
      var f = (i + 0.5) / N;
      var sx = cx + d[0] * (f - 0.5) * T, sz = cz + d[1] * (f - 0.5) * T;
      var h = y0 + rise * f;
      B.box(sx, h - rise / (N * 2) - 0.04 * S, sz,
        alongX ? T / N : T * 0.82, 0.1 * S + rise / N, alongX ? T * 0.82 : T / N,
        0, 0, 0, c.r, c.g, c.b);
    }
    // A stringer down each side ties the flight together visually.
    var sc = shade(mat, seed + 11, dmg, 0.85);
    var pitchS = Math.atan2(rise, T), lenS = Math.hypot(T, rise);
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      B.box(cx + (alongX ? 0 : s2 * T * 0.42), y0 + rise * 0.5 - 0.14 * S, cz + (alongX ? s2 * T * 0.42 : 0),
        alongX ? lenS : 0.08 * S, 0.16 * S, alongX ? 0.08 * S : lenS,
        alongX ? 0 : -d[1] * pitchS, 0, alongX ? d[0] * pitchS : 0, sc.r, sc.g, sc.b);
    }
  }

  /**
   * The GABLE END — the triangle of wall between the eaves and the ridge.
   *
   * Without it a pitched roof is two flaps with daylight between them, which is
   * exactly what the first build looked like. It cannot come from the wall grid
   * (a wall is one storey tall by definition), so it is derived at merge time
   * from the roof cell's own shape and rank, and raked in three steps across
   * the cell — a crow-stepped gable, which is both what the grid can express
   * and what half of northern Europe actually builds.
   */
  function emitGable(B, cx, yr, cz, mat, e, shape, rank, dmg, seed, rise) {
    var c = shade(mat, seed, dmg, 0.97);
    var RISE = rise === undefined ? ROOF_RISE : rise;
    var d = EDGE_D[e];
    var alongZ = (e === 1 || e === 3);        // an E/W end wall: profile runs along Z
    var ridge = (shape === R_RIDGE_X || shape === R_RIDGE_Z);
    var up = 0;
    if (!ridge) {
      var sd = shape - 1;                     // the roof descends toward sd
      up = alongZ ? -EDGE_D[sd][1] : -EDGE_D[sd][0];
    }
    var N = 3;
    for (var k = 0; k < N; k++) {
      var f = (k + 0.5) / N;
      var t = ridge ? (1 - Math.abs(f - 0.5) * 2) * 0.5 : (up > 0 ? f : 1 - f);
      var h = (rank + t) * RISE;
      if (h <= 0.03 * S) continue;
      var off = (f - 0.5) * T;
      B.box(cx + (alongZ ? d[0] * T * 0.5 : off), yr + h * 0.5, cz + (alongZ ? off : d[1] * T * 0.5),
        alongZ ? WALL_TH : T / N, h, alongZ ? T / N : WALL_TH, 0, 0, 0, c.r, c.g, c.b);
    }
  }

  /** A corner post — carries a floor where there is no wall under it. */
  function emitPillar(B, cx, y, cz, mat, dmg, seed) {
    var c = shade(mat, seed, dmg);
    B.box(cx, y + FLOOR_H * 0.5, cz, 0.26 * S, FLOOR_H, 0.26 * S, 0, 0, 0, c.r, c.g, c.b);
  }

  // =========================================================================
  // THE STRUCTURE GRID
  // =========================================================================

  function Structures(scene, terrain, opts) {
    opts = opts || {};
    this.scene = scene;
    this.terrain = terrain;
    this.game = null;                  // set by the game after construction
    this.any = false;                  // fast "is anything built at all"
    this.group = new THREE.Group();
    this.group.name = 'structures';
    this.scene.add(this.group);

    this.NC = Math.ceil(G.GRID / CHUNK);
    this.chunks = new Array(this.NC * this.NC);
    this.dirty = [];                   // chunk indices awaiting a rebuild
    this.fires = [];                   // burning pieces
    this.settleQ = [];                 // columns whose support must be re-checked
    this._pieces = 0; this._tris = 0;

    // One material draws every structure in the game: colour is per-vertex, so
    // brick, thatch, concrete and charred timber share a single batch.
    //
    // THE LIGHTING MODEL IS THE GAME'S, not this file's. Round 55 moved every
    // lit surface off `MeshStandardMaterial` — the game has no environment map,
    // so PBR's metalness term was buying nothing and costing a full BRDF per
    // pixel — but this module builds its own material and so kept the expensive
    // one. A village is a large share of the screen on half the maps.
    // `PaintedMaterial` is the game's own factory and drops the PBR-only keys.
    var Painted = window.PaintedMaterial;
    this.mat = Painted
      ? new Painted({ vertexColors: true, roughness: 0.93, metalness: 0.0, flatShading: true })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.0, flatShading: true });
    // …and the surface it draws — courses, per-tile tone, the course shadow.
    // See assets/fabric.js for why a building needed this and a texture did not.
    if (window.Fabric) window.Fabric.material(this.mat);
    this.glassMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.18, metalness: 0.1, transparent: true,
      opacity: 0.34, depthWrite: false, side: THREE.DoubleSide,
    });
    // …and under the clouds, as the street and the men in it are (round 106):
    // a cloud going over a village shaded everything but the houses
    if (window.cloudShadeMaterial) { window.cloudShadeMaterial(this.mat); window.cloudShadeMaterial(this.glassMat); }
    this._alloc();
  }

  /**
   * The storage. Only the two per-COLUMN arrays are allocated up front; the ten
   * per-(cell, storey) ones wait until something is actually built.
   *
   * That matters because the field can be 448 cells square, where the full set
   * is about 17 MB — real memory to hand a map with no buildings on it. `mask`
   * is 200 KB at that size and answers "is anything here" for every hot path,
   * so nothing else needs to exist until the first wall goes up.
   */
  Structures.prototype._alloc = function () {
    var N2 = G.GRID * G.GRID;
    this.N2 = N2; this.N3 = N2 * LEVELS;
    this.mask = new Uint8Array(N2);     // per COLUMN: anything here at all
    this.baseY = new Float32Array(N2);  // the storey-0 footing of this column
    this.bid = new Uint8Array(N2);      // which house this column is (render dressing only)
    this.look = new Uint8Array(N2);     // its front's colour, for a block's houses (`wallLook`)
    this.wallM = null;
  };
  /** Bring the per-storey arrays into existence. Every WRITE calls this; reads
   *  answer "nothing" while they are absent. */
  Structures.prototype._ensure = function () {
    if (this.wallM) return;
    var N3 = this.N3;
    // The four arrays the pathfinder reads live where its WebAssembly search
    // can read them in place (assets/wasmpath.js) — ordinary arrays otherwise.
    var W = window.WasmPath, shared = W && W.ready && !/[?&]nowasm\b/.test(window.location ? window.location.search : '');
    var slot = function (name, n) { return (shared && W.slot(name, n)) || new Uint8Array(n); };
    this.wallM = slot('WALLM', N3 * 4);
    this.wallK = slot('WALLK', N3 * 4);
    this.wallH = new Uint8Array(N3 * 4);
    this.wallHole = new Uint8Array(N3 * 4);   // shell holes, a bit per cell of the panel (round 110)
    this.floorM = slot('FLOORM', N3);
    this.floorH = new Uint8Array(N3);
    this.roofM = new Uint8Array(N3);
    this.roofK = new Uint8Array(N3);
    this.roofH = new Uint8Array(N3);
    this.feat = slot('FEAT', N3);
    this.featH = new Uint8Array(N3);
  };

  /**
   * The battlefield changed size. `GRID` is mutable in the Normandy build (a
   * map declares its own field), and every array here is sized by it — so this
   * throws the lot away and starts again, exactly like Terrain and Obstacles.
   * Call it from the game's `_resizeWorld`, never mid-battle.
   */
  Structures.prototype.resize = function (n) {
    if (n) G.GRID = n;
    this.clear();
    this.NC = Math.ceil(G.GRID / CHUNK);
    this.chunks = new Array(this.NC * this.NC);
    this._alloc();
    this.any = false;
  };

  // ---- indexing -----------------------------------------------------------
  Structures.prototype.ci = function (gx, gz) { return gz * G.GRID + gx; };
  Structures.prototype.li = function (gx, gz, L) { return (L * G.GRID + gz) * G.GRID + gx; };
  Structures.prototype.inb = function (gx, gz, L) {
    return gx >= 0 && gz >= 0 && gx < G.GRID && gz < G.GRID && L >= 0 && L < LEVELS;
  };
  /** Anything built in this column? One byte-load — the early-out every hot
   *  path (LOS, pathfinding, the projectile sweep) takes on open ground. */
  Structures.prototype.has = function (gx, gz) {
    return this.any && gx >= 0 && gz >= 0 && gx < G.GRID && gz < G.GRID && this.mask[gz * G.GRID + gx] !== 0;
  };
  Structures.prototype.base = function (gx, gz) {
    var c = this.ci(gx, gz);
    return this.mask[c] ? this.baseY[c] : this.terrain.height(gx, gz) * G.HSCALE;
  };
  /** World Y of the walking surface of level L in this column. */
  Structures.prototype.floorY = function (gx, gz, L) { return this.base(gx, gz) + L * FLOOR_H; };
  /** THE FOOTING A WALL STANDS ON (round 106): its house's. A wall is stored on
   *  both of its cells and drawn by one of them; where that one is the street
   *  (a column with no house of its own, `bid` 0) and a house stands across
   *  the edge, the wall is the house's and stands on its footing. `setWall`
   *  gives such a column the footing of the first house that touches it,
   *  which is right for every street but the alley between two houses that
   *  stand at different heights (Ortona: a window drawn 0.83 m off its storey). */
  Structures.prototype.wallBase = function (gx, gz, e) {
    var c = this.ci(gx, gz);
    if (this.bid && !this.bid[c]) {
      var d = EDGE_D[e], nx = gx + d[0], nz = gz + d[1];
      if (nx >= 0 && nz >= 0 && nx < G.GRID && nz < G.GRID) {
        var n = this.ci(nx, nz);
        if (this.bid[n] && this.mask[n]) return this.baseY[n];
      }
    }
    return this.base(gx, gz);
  };
  /** Which storey a world Y falls in, against a footing. */
  Structures.prototype._levelAt = function (base, y) {
    var l = Math.floor((y - base + 0.35 * S) / FLOOR_H);
    return l < 0 ? 0 : l > LEVELS - 1 ? LEVELS - 1 : l;
  };
  /** Which storey a world Y falls in, for this column. */
  Structures.prototype.levelOf = function (gx, gz, y) {
    var l = Math.floor((y - this.base(gx, gz) + 0.35 * S) / FLOOR_H);
    return l < 0 ? 0 : l > LEVELS - 1 ? LEVELS - 1 : l;
  };

  // ---- reads --------------------------------------------------------------
  Structures.prototype.wallMat = function (gx, gz, L, e) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 0;
    return this.wallM[this.li(gx, gz, L) * 4 + e];
  };
  Structures.prototype.wallKind = function (gx, gz, L, e) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 0;
    return this.wallK[this.li(gx, gz, L) * 4 + e] & 7;
  };
  /** The shell holes in this panel: a bit per cell, column + row * HOLE_COLS. */
  Structures.prototype.wallHoles = function (gx, gz, L, e) {
    if (!this.wallM || !this.wallHole || !this.inb(gx, gz, L)) return 0;
    return this.wallHole[this.li(gx, gz, L) * 4 + e];
  };
  Structures.prototype.floorMat = function (gx, gz, L) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 0;
    return this.floorM[this.li(gx, gz, L)];
  };
  Structures.prototype.roofMat = function (gx, gz, L) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 0;
    return this.roofM[this.li(gx, gz, L)];
  };
  Structures.prototype.featAt = function (gx, gz, L) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 0;
    return this.feat[this.li(gx, gz, L)];
  };
  /** Is this cell INDOORS at level L — something over it, a floor or a roof?
   *  Only the render dressing asks (which side of a window the shutters hang
   *  on); a wall can be stored in the cell on either side of it, so "is there
   *  anything in this column" cannot tell a room from the street. */
  Structures.prototype._roomAt = function (gx, gz, L) {
    if (!this.wallM || !this.inb(gx, gz, 0)) return false;
    for (var L2 = L; L2 < LEVELS; L2++) {
      if (L2 > L && this.floorM[this.li(gx, gz, L2)]) return true;
      if (this.roofM[this.li(gx, gz, L2)]) return true;
    }
    return false;
  };
  /** (round 113) WHICH HOUSE, FOR ITS COLOURS ONLY. A block's houses carry
   *  `bid`; a house laid in the editor has none, so the whole of Village was
   *  one brick and one roof. The connected run of roofed columns a column
   *  stands in, numbered by a flood the first time anything asks after a map
   *  is laid (`clear` forgets it). Drawing only — nothing in the battle reads it. */
  Structures.prototype._houseOf = function (gx, gz) {
    if (!this._hid) this._floodHouses();
    return this._hid[gz * G.GRID + gx];
  };
  Structures.prototype._floodHouses = function () {
    var N = G.GRID, hid = this._hid = new Uint8Array(N * N), q = new Int32Array(N * N), n = 0;
    if (!this.wallM) return;
    for (var z0 = 0; z0 < N; z0++) for (var x0 = 0; x0 < N; x0++) {
      var i0 = z0 * N + x0;
      if (hid[i0] || !this.mask[i0] || !this._roomAt(x0, z0, 0)) continue;
      var id = 1 + (n++ % 255), h = 0, t = 0;
      hid[i0] = id; q[t++] = i0;
      while (h < t) {
        var i = q[h++], x = i % N, z = (i - x) / N;
        for (var k = 0; k < 4; k++) {
          var nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
          var j = nz * N + nx;
          if (hid[j] || !this.mask[j] || !this._roomAt(nx, nz, 0)) continue;
          hid[j] = id; q[t++] = j;
        }
      }
    }
  };
  /** Highest level with a floor slab in this column (0 if none). */
  Structures.prototype.topLevel = function (gx, gz) {
    for (var L = LEVELS - 1; L > 0; L--) if (this.floorMat(gx, gz, L)) return L;
    return 0;
  };

  // ---- writes -------------------------------------------------------------
  Structures.prototype._touchCol = function (gx, gz, base) {
    var c = this.ci(gx, gz);
    if (!this.mask[c]) {
      this.mask[c] = 1;
      // A column's footing is fixed the first time something is built on it,
      // so later shellfire cratering the ground doesn't drop the house into it.
      // `base`: the footing of the house whose wall made this column — see
      // `setWall`.
      this.baseY[c] = base != null ? base : this.terrain.height(gx, gz) * G.HSCALE;
    }
    this.any = true;
    this.markDirty(gx, gz);
    if (this.terrain) this.terrain.minimapDirty = true;
  };
  Structures.prototype._colEmpty = function (gx, gz) {
    for (var L = 0; L < LEVELS; L++) {
      var i = this.li(gx, gz, L);
      if (this.floorM[i] || this.roofM[i] || this.feat[i]) return false;
      for (var e = 0; e < 4; e++) if (this.wallM[i * 4 + e]) return false;
    }
    return true;
  };
  Structures.prototype._reap = function (gx, gz) {
    if (this._colEmpty(gx, gz)) { this.mask[this.ci(gx, gz)] = 0; this.markDirty(gx, gz); }
  };

  /**
   * Set a wall on one edge. The edge is a SURFACE shared by two cells, so both
   * sides are written — every read then costs one array load instead of two,
   * which matters because the pathfinder asks this question constantly.
   */
  Structures.prototype.setWall = function (gx, gz, L, e, mat, kind) {
    if (!this.inb(gx, gz, L)) return false;
    this._ensure();
    kind = kind || K_SOLID;
    var i = this.li(gx, gz, L) * 4 + e;
    this.wallM[i] = mat; this.wallK[i] = kind; this.wallH[i] = mat ? 255 : 0;
    if (this.wallHole) this.wallHole[i] = 0;
    if (mat) this._touchCol(gx, gz); else this.markDirty(gx, gz);
    var d = EDGE_D[e], nx = gx + d[0], nz = gz + d[1];
    if (this.inb(nx, nz, L)) {
      var j = this.li(nx, nz, L) * 4 + ((e + 2) % 4);
      this.wallM[j] = mat; this.wallK[j] = kind; this.wallH[j] = mat ? 255 : 0;
      if (this.wallHole) this.wallHole[j] = 0;
      // THE STREET OUTSIDE STANDS AT THE HOUSE'S FOOTING (round 106). A wall is
      // stored on both its cells, and the street cell outside a house's south
      // and east walls is the one that DRAWS them (`_rebuildChunk` draws a
      // cell's north and west surfaces) — at that cell's own footing, which was
      // the terrain where it stood. A house is levelled to its highest corner,
      // so on a slope its south and east walls were drawn stepping down the
      // hill cell by cell, up to 4.4 m below the house (Ruined Town), the upper
      // floors standing out over their tops; and a round from the street tested
      // them at those heights too (`levelOf`, `_rayWall`). The column a house's
      // wall creates takes the house's footing. A man at street level still
      // stands on the terrain (`groundYAt`).
      if (mat) this._touchCol(nx, nz, this.baseY[this.ci(gx, gz)]); else { this.markDirty(nx, nz); this._reap(nx, nz); }
    }
    if (!mat) this._reap(gx, gz);
    return true;
  };
  Structures.prototype.setFloor = function (gx, gz, L, mat) {
    if (!this.inb(gx, gz, L)) return false;
    this._ensure();
    var i = this.li(gx, gz, L);
    this.floorM[i] = mat; this.floorH[i] = mat ? 255 : 0;
    if (mat) this._touchCol(gx, gz); else { this.markDirty(gx, gz); this._reap(gx, gz); }
    return true;
  };
  Structures.prototype.setRoof = function (gx, gz, L, mat, shape, rank) {
    if (!this.inb(gx, gz, L)) return false;
    this._ensure();
    var i = this.li(gx, gz, L);
    this.roofM[i] = mat; this.roofK[i] = (shape || R_FLAT) | ((rank || 0) << 3); this.roofH[i] = mat ? 255 : 0;
    if (mat) this._touchCol(gx, gz); else { this.markDirty(gx, gz); this._reap(gx, gz); }
    return true;
  };
  /** Vertical connector. `part` P_LOW/P_HIGH make a two-cell run out of two
   *  calls; P_SINGLE is one steep flight in one cell. */
  Structures.prototype.setFeature = function (gx, gz, L, kind, dir, part, mat) {
    if (!this.inb(gx, gz, L)) return false;
    this._ensure();
    var i = this.li(gx, gz, L);
    this.feat[i] = kind ? (kind | (dir << 3) | (part << 5)) : 0;
    this.featH[i] = kind ? 255 : 0;
    this._featMat = this._featMat || {};
    if (kind) { this._featMat[i] = mat || M_WOOD; this._touchCol(gx, gz); }
    else { delete this._featMat[i]; this.markDirty(gx, gz); this._reap(gx, gz); }
    return true;
  };
  Structures.prototype.featMat = function (i) { return (this._featMat && this._featMat[i]) || M_WOOD; };

  /** Erase every piece in one cell at one level (the editor's rubber). */
  Structures.prototype.eraseCell = function (gx, gz, L) {
    if (!this.inb(gx, gz, L)) return false;
    var hit = false;
    for (var e = 0; e < 4; e++) if (this.wallMat(gx, gz, L, e)) { this.setWall(gx, gz, L, e, 0, 0); hit = true; }
    var i = this.li(gx, gz, L);
    if (this.floorM[i]) { this.setFloor(gx, gz, L, 0); hit = true; }
    if (this.roofM[i]) { this.setRoof(gx, gz, L, 0, 0); hit = true; }
    if (this.feat[i]) { this.setFeature(gx, gz, L, 0, 0, 0, 0); hit = true; }
    return hit;
  };
  /** Erase the whole column — every storey of one cell. */
  Structures.prototype.eraseColumn = function (gx, gz) {
    var hit = false;
    for (var L = 0; L < LEVELS; L++) if (this.eraseCell(gx, gz, L)) hit = true;
    return hit;
  };

  // =========================================================================
  // NAVIGATION — what a man can walk on, and what he can walk through
  // =========================================================================

  /** Is level L of this cell a surface you can stand on? Level 0 is the
   *  ground (the caller still applies terrain rules); above that you need a
   *  floor slab, or a flight of stairs to be standing on. */
  Structures.prototype.standable = function (gx, gz, L) {
    if (L === 0) return true;
    if (!this.wallM || !this.inb(gx, gz, L)) return false;
    var i = this.li(gx, gz, L);
    if (this.floorM[i]) return true;
    // The top of a flight counts: you can stand on the stairs themselves.
    return this.feat[i] !== 0;
  };

  /** Does the surface between two horizontally adjacent cells stop a man?
   *  Solid walls and windows do. Doorways, archways, and a wall shot down to
   *  rubble do not — rubble you scramble over. */
  Structures.prototype.edgeBlocks = function (gx, gz, L, e) {
    if (!this.any) return false;
    if (!this.inb(gx, gz, L)) return false;
    var i = this.li(gx, gz, L) * 4 + e;
    var m = this.wallM[i];
    if (!m) return false;
    var k = this.wallK[i];
    return k === K_SOLID || k === K_WINDOW;
  };
  /**
   * (round 115) THE PART OF AN EDGE A MAN GETS THROUGH. `edgeBlocks` answers
   * for the whole six metres: a door edge was open along all of it, so a man
   * shoved against the wall beside a doorway, or driven along it in first
   * person, went through the brick. 0 = shut (wall, window), 1 = open along
   * its length (nothing, rubble), 2 = open only between `spanLo` and `spanHi`
   * (world units along the edge from its start): the doorway, the arch, the
   * run of blown cells of a breach nearest `along`.
   */
  Structures.prototype.moveSpan = function (gx, gz, L, e, along) {
    if (!this.wallM || !this.inb(gx, gz, L)) return 1;
    var i = this.li(gx, gz, L) * 4 + e;
    if (!this.wallM[i]) return 1;
    var kr = this.wallK[i], k = kr & 7;
    if (k === K_RUBBLE) return 1;
    var lo = 1e9, hi = -1e9;
    if (k === K_DOOR) { lo = T * 0.5 - 0.36 * S; hi = T * 0.5 + 0.36 * S; }
    else if (k === K_ARCH) { lo = T * 0.16; hi = T * 0.84; }
    if (kr & K_BREACH) {
      var h = this.wallHole ? this.wallHole[i] : 0, cw = T / HOLE_COLS, best = -1, bd = 1e9;
      for (var c = 0; c < HOLE_COLS; c++) if (h & (1 << c)) { var dd = Math.abs((c + 0.5) * cw - along); if (dd < bd) { bd = dd; best = c; } }
      if (best < 0) return 1;              // flagged with no hole kept: open, as the search has it
      var c0 = best, c1 = best;
      while (c0 > 0 && (h & (1 << (c0 - 1)))) c0--;
      while (c1 < HOLE_COLS - 1 && (h & (1 << (c1 + 1)))) c1++;
      if (hi < lo || Math.abs((lo + hi) * 0.5 - along) > Math.abs((c0 + c1 + 1) * 0.5 * cw - along)) { lo = c0 * cw; hi = (c1 + 1) * cw; }
    }
    if (hi < lo) return 0;
    this.spanLo = lo; this.spanHi = hi;
    return 2;
  };
  /**
   * (round 115) NOBODY WALKS UNDER A FLIGHT FROM ITS FOOT. A stair cell is a
   * node on its own storey, and both searches crossed it level in any
   * direction — out through its HIGH end at floor height, under the treads,
   * into the room beneath the landing. A pathed man did it at floor height
   * (`walkY`'s `flat`); a man in first person walking that route climbed the
   * flight instead and came out on the landing (Ortona, a real battle). There
   * is no headroom under the low half of a flight, so at floor level a flight
   * cell is not crossed across its high end (out of it or into it), and not
   * diagonally; its foot, its sides and the run between its two cells are as
   * before. True when the step (x, z, L) + (dx, dz) is one of those.
   */
  Structures.prototype.underFlight = function (x, z, L, dx, dz) {
    if (!this.feat || !this.inb(x, z, L)) return false;
    var fa = this.feat[this.li(x, z, L)], nx = x + dx, nz = z + dz;
    var fb = this.inb(nx, nz, L) ? this.feat[this.li(nx, nz, L)] : 0;
    if ((fa & 7) === F_LADDER) fa = 0;
    if ((fb & 7) === F_LADDER) fb = 0;
    if (!fa && !fb) return false;
    if (dx && dz) return true;
    if (fa && ((fa >> 5) & 3) !== P_LOW) { var da = EDGE_D[(fa >> 3) & 3]; if (da[0] === dx && da[1] === dz) return true; }
    if (fb && ((fb >> 5) & 3) !== P_LOW) { var db = EDGE_D[(fb >> 3) & 3]; if (db[0] === -dx && db[1] === -dz) return true; }
    return false;
  };
  /** The same question, but between two cells given as a delta. Diagonals need
   *  both orthogonal surfaces open — you cannot slip through a corner. */
  Structures.prototype.canCross = function (gx, gz, L, dx, dz) {
    if (!this.any) return true;
    if (dx && dz) {
      var ex = dx > 0 ? 1 : 3, ez = dz > 0 ? 2 : 0;
      if (this.edgeBlocks(gx, gz, L, ex) || this.edgeBlocks(gx, gz, L, ez)) return false;
      // and the far side of the corner cell we clip through
      if (this.edgeBlocks(gx + dx, gz, L, ez) || this.edgeBlocks(gx, gz + dz, L, ex)) return false;
      return true;
    }
    var e = dx > 0 ? 1 : dx < 0 ? 3 : dz > 0 ? 2 : 0;
    return !this.edgeBlocks(gx, gz, L, e);
  };
  /**
   * Where a flight of stairs in this cell PUTS you.
   *
   * Not straight up: a staircase rises across its cell and delivers you onto
   * the LANDING beyond it, one storey higher. That matters because the cell the
   * flight occupies has no slab over it — it is a stairwell — so "up" would
   * be into open air. A ladder is the exception and does go straight up.
   *
   * Returns {x, z, L} or null.
   */
  Structures.prototype.portalUp = function (gx, gz, L) {
    if (!this.any || !this.inb(gx, gz, L)) return null;
    var f = this.feat[this.li(gx, gz, L)];
    if (!f) return null;
    var kind = f & 7, dir = (f >> 3) & 3, part = (f >> 5) & 3;
    if (kind === F_LADDER) return this.standable(gx, gz, L + 1) ? { x: gx, z: gz, L: L + 1 } : null;
    if (part === P_LOW) return null;              // the low half of a two-cell run
    var d = EDGE_D[dir], nx = gx + d[0], nz = gz + d[1];
    if (!this.inb(nx, nz, L + 1) || !this.standable(nx, nz, L + 1)) return null;
    return { x: nx, z: nz, L: L + 1 };
  };
  /** The reverse: stepping off a landing onto the head of a flight. */
  Structures.prototype.portalDown = function (gx, gz, L) {
    if (!this.any || L <= 0) return null;
    for (var e = 0; e < 4; e++) {
      var d = EDGE_D[e], nx = gx + d[0], nz = gz + d[1];
      if (!this.inb(nx, nz, L - 1)) continue;
      var f = this.feat[this.li(nx, nz, L - 1)];
      if (!f) continue;
      var kind = f & 7, dir = (f >> 3) & 3, part = (f >> 5) & 3;
      if (kind === F_LADDER) { if (nx === gx && nz === gz) return { x: gx, z: gz, L: L - 1 }; continue; }
      if (part === P_LOW) continue;
      // its climb direction must point AT us
      if (nx + EDGE_D[dir][0] === gx && nz + EDGE_D[dir][1] === gz) return { x: nx, z: nz, L: L - 1 };
    }
    return null;
  };
  /** Does some neighbouring flight arrive in this cell at this storey? */
  Structures.prototype.stairFeeds = function (gx, gz, L) { return !!this.portalDown(gx, gz, L); };

  /**
   * Settle which storey a unit at this position actually belongs to. Continuous
   * movement (first person, separation shoves, knockback) can put a man in a
   * cell his old level doesn't exist in; this is the single rule that decides
   * where he really is, so the player and the AI never disagree about it.
   */
  Structures.prototype.resolveLevel = function (wx, wz, lvl, y) {
    if (!this.any) return 0;
    var gx = G.worldToCell(wx), gz = G.worldToCell(wz);
    if (!this.has(gx, gz)) return 0;                       // stepped out of the building
    if (lvl < 0) lvl = 0;
    if (this.featAt(gx, gz, lvl)) return lvl;              // standing on the flight itself
    if (y != null) {
      // The honest answer: of the surfaces you could be standing on in this
      // cell, the one your feet are nearest. That is what disambiguates the
      // top of a staircase — a landing cell has an ordinary ground floor under
      // it, and only your HEIGHT says which of the two you are on.
      var best = lvl, bd = Infinity;
      for (var L = 0; L < LEVELS; L++) {
        if (!this.standable(gx, gz, L)) continue;
        var d = Math.abs(this.floorY(gx, gz, L) - y);
        if (L === lvl) d -= 0.35 * S;                      // stay put unless clearly wrong
        if (d < bd) { bd = d; best = L; }
      }
      return best;
    }
    if (this.standable(gx, gz, lvl)) return lvl;
    if (lvl > 0 && this.featAt(gx, gz, lvl - 1)) return lvl - 1;   // stepped onto its head
    if (this.standable(gx, gz, lvl + 1) && this.stairFeeds(gx, gz, lvl + 1)) return lvl + 1;
    if (lvl > 0 && this.standable(gx, gz, lvl - 1)) return lvl - 1; // through the hole
    return lvl;
  };

  /** Vehicles never go indoors above the ground floor, and never up stairs. */
  Structures.prototype.vehicleOk = function (L) { return L === 0; };

  /**
   * WHAT A VEHICLE MEETS AT A SURFACE.
   *
   * A wall is a wall to a tank whether or not somebody cut a door in it — a
   * doorway is 0.7 units wide and a Sherman is 2.3 — so unlike `canCross`, which
   * answers for a man, this treats every kind of wall as an obstruction and
   * only varies how much WORK it takes to push through:
   *
   *   `work`  tonne-seconds to flatten. 0 means it does not give at all.
   *   `risk`  chance per second of throwing a track while grinding on it.
   *
   * Openings weaken a panel; rubble is a spoil heap you climb rather than a
   * wall you break, so it is cheap to cross and nasty to the running gear.
   * Returns null when the way is clear.
   */
  Structures.prototype.vehicleBlock = function (gx, gz, L, dx, dz) {
    if (!this.any) return null;
    var best = null;
    var take = function (self, e) {
      if (!self.inb(gx, gz, L)) return;
      var i = self.li(gx, gz, L) * 4 + e;
      var m = self.wallM[i];
      if (!m) return;
      var mat = MATS[m], k = self.wallK[i] & 7;
      var work = mat.crush, risk = mat.track;
      if (k === K_RUBBLE) { work = (work || 130) * 0.35; risk = risk * 0.85; }
      else if (k === K_DOOR || k === K_ARCH) work = work * 0.55;
      else if (k === K_WINDOW) work = work * 0.75;
      // a panel with shell holes in it is part-way to coming down already
      var hn = self.wallHole ? holeCount(self.wallHole[i]) : 0;
      if (hn && k !== K_RUBBLE) work = work * Math.max(0.35, 1 - hn * 0.11);
      var rec = { kind: 'wall', gx: gx, gz: gz, L: L, e: e, mat: m, wk: k,
                  work: work, risk: risk, maxHp: mat.hp, name: mat.name };
      // Report the WORST surface being crossed — a diagonal that clips a stone
      // corner is stopped by the stone, not waved through by the plank.
      if (!best || (best.work > 0 && (rec.work === 0 || rec.work > best.work))) best = rec;
    };
    if (dx) take(this, dx > 0 ? 1 : 3);
    if (dz) take(this, dz > 0 ? 2 : 0);
    return best;
  };

  /**
   * The walking height at a world point for a unit on storey `lvl` — the
   * function that makes stairs work. Inside a flight it interpolates by how far
   * along the run you have walked, so a man climbing is at every intermediate
   * height rather than teleporting a storey.
   */
  Structures.prototype.walkY = function (wx, wz, lvl, flat) {
    var gx = G.worldToCell(wx), gz = G.worldToCell(wz);
    if (!this.has(gx, gz)) return null;
    // `flat` (round 110): a man whose route stays on this storey crosses the
    // foot of a flight at floor height rather than walking up it — see
    // `Unit._routeClimbs`
    if (flat) return this.floorY(gx, gz, lvl);
    var st = this._stairSpan(gx, gz, lvl);
    if (!st) return this.floorY(gx, gz, lvl);
    return this.floorY(gx, gz, st.L) + st.frac(wx, wz) * FLOOR_H;
  };

  /** The flight of stairs a unit at (cell, lvl) is standing on. */
  Structures.prototype._stairSpan = function (gx, gz, lvl) {
    var f = this.featAt(gx, gz, lvl);
    if (!f || (f & 7) === F_LADDER) return null;
    var dir = (f >> 3) & 3, part = (f >> 5) & 3;
    var d = EDGE_D[dir];
    // Anchor on the LOW cell of the run so both halves share one parameter.
    var ax = gx, az = gz, run = (part === P_SINGLE) ? 1 : 2;
    if (part === P_HIGH) { ax = gx - d[0]; az = gz - d[1]; }
    var cx = G.cellCenter(ax), cz = G.cellCenter(az);
    return {
      L: lvl, dir: dir, run: run,
      frac: function (wx, wz) {
        var along = d[0] ? (wx - cx) * d[0] : (wz - cz) * d[1];
        var t = (along + T * 0.5) / (T * run);
        return t < 0 ? 0 : t > 1 ? 1 : t;
      },
    };
  };

  /** Which storey a unit standing here belongs to — see `resolveLevel`. On a
   *  flight that is decided by geometry, not by the path, which is what keeps a
   *  first-person player and an AI squad on the same rules. */
  Structures.prototype.stairLevel = function (wx, wz, lvl, y) {
    return this.resolveLevel(wx, wz, lvl, y);
  };

  // =========================================================================
  // SIGHT & FIRE — what the eye and the bullet run into
  // =========================================================================

  /** Does the surface between two adjacent sampled cells stop a sightline at
   *  height `y`? Called from `hasLOS` once per marched cell, so it must be
   *  cheap and must early-out on open ground.
   *
   *  Windows and doorways and blown-out rubble do NOT block sight — that is
   *  the whole point of a window. A floor slab between two storeys does. */
  Structures.prototype.sightStep = function (gx0, gz0, gx1, gz1, y, prevY) {
    if (!this.any) return false;
    var h0 = this.has(gx0, gz0), h1 = this.has(gx1, gz1);
    if (!h0 && !h1) return false;
    var dx = gx1 - gx0, dz = gz1 - gz0;
    if (dx || dz) {
      // Both orthogonal surfaces of a diagonal step, same rule as movement —
      // each on its own house's storeys (`wallBase`).
      var ex = dx > 0 ? 1 : 3, ez = dz > 0 ? 2 : 0;
      if (dx && this._sightEdge(gx0, gz0, this._levelAt(this.wallBase(gx0, gz0, ex), y), ex, y)) return true;
      if (dz && this._sightEdge(gx0, gz0, this._levelAt(this.wallBase(gx0, gz0, ez), y), ez, y)) return true;
    }
    // Ceilings only stop a sightline that CROSSES them. Being under a slab is
    // not the same as looking through one — a man at head height in a room has
    // a ceiling right above him and can still see straight across it.
    if (h1 && prevY !== undefined && prevY !== y) {
      var La = this.levelOf(gx1, gz1, prevY), Lb = this.levelOf(gx1, gz1, y);
      if (La !== Lb && this.floorMat(gx1, gz1, Math.max(La, Lb))) return true;
    }
    return false;
  };
  Structures.prototype._sightEdge = function (gx, gz, L, e, y) {
    if (!this.inb(gx, gz, L)) return false;
    var i = this.li(gx, gz, L) * 4 + e;
    var m = this.wallM[i];
    if (!m) return false;
    var k = this.wallK[i];
    // windows, doors, arches, rubble and a breach (`K_BREACH`) see through…
    if (k !== K_SOLID) return false;
    // …and so does a shell hole in the row the sightline crosses (round 110)
    var h = this.wallHole ? this.wallHole[i] : 0;
    if (h && y !== undefined) {
      var row = (y - (this.wallBase(gx, gz, e) + L * FLOOR_H)) < FLOOR_H * 0.5 ? 0 : 1;
      if (h & (HOLE_ROW0 << (row * HOLE_COLS))) return false;
    }
    return true;
  };

  /**
   * Sweep a segment against the structure and return the first piece it hits.
   * Used by the projectile integrator, so it answers with everything the caller
   * needs to decide penetration: the material, the piece reference, and where.
   * Returns null on a clean flight.
   */
  Structures.prototype.raySegment = function (x0, y0, z0, x1, y1, z1) {
    if (!this.any) return null;
    var dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    var len = Math.hypot(dx, dz);
    var steps = Math.max(1, Math.ceil(len / (T * 0.34)));
    var pgx = G.worldToCell(x0), pgz = G.worldToCell(z0), py = y0;
    for (var s = 1; s <= steps; s++) {
      var t = s / steps;
      var x = x0 + dx * t, y = y0 + dy * t, z = z0 + dz * t;
      var gx = G.worldToCell(x), gz = G.worldToCell(z);
      if (gx !== pgx || gz !== pgz) {
        if (this.has(pgx, pgz) || this.has(gx, gz)) {
          // (round 115) AT THE CROSSING, NOT AT THE SAMPLE. The sample after a
          // cell change is up to a third of a cell (2 m) past the wall, and the
          // opening was tested there: a round leaving a window at 20 degrees
          // was judged by a point 0.7 m along the wall from where it went
          // through, so a man firing from a window put more than half his
          // rounds into the masonry beside it (78 of 146 in four Ortona
          // houses). `_rayCross` finds where the segment meets each surface it
          // crosses, in the order it meets them. `Structures.exactRay = false`
          // is the old test.
          if (window.Structures.exactRay !== false) {
            var hx = this._rayCross(pgx, pgz, gx, gz, x0, y0, z0, dx, dy, dz);
            if (hx) return hx;
          } else {
          var ddx = gx - pgx, ddz = gz - pgz;
          var e = -1;
          if (ddx > 0) e = 1; else if (ddx < 0) e = 3; else if (ddz > 0) e = 2; else if (ddz < 0) e = 0;
          // each surface on ITS storeys (`wallBase`): the house's, not the street's
          if (e >= 0) {
            var hit = this._rayWall(pgx, pgz, this._levelAt(this.wallBase(pgx, pgz, e), y), e, x, y, z);
            if (hit) return hit;
          } else {                       // a diagonal step: test both surfaces
            var e1 = ddx > 0 ? 1 : 3, e2 = ddz > 0 ? 2 : 0;
            var h1 = this._rayWall(pgx, pgz, this._levelAt(this.wallBase(pgx, pgz, e1), y), e1, x, y, z)
                  || this._rayWall(pgx, pgz, this._levelAt(this.wallBase(pgx, pgz, e2), y), e2, x, y, z);
            if (h1) return h1;
          }
          }
        }
      }
      // Floors and roofs: the round crossing a storey boundary inside a cell.
      if (this.has(gx, gz) && (y !== py)) {
        var Lp = this.levelOf(gx, gz, py), Ln = this.levelOf(gx, gz, y);
        if (Lp !== Ln) {
          var hi = Math.max(Lp, Ln);
          if (this.floorMat(gx, gz, hi)) {
            return { kind: 'floor', gx: gx, gz: gz, L: hi, mat: this.floorMat(gx, gz, hi), x: x, y: this.floorY(gx, gz, hi), z: z };
          }
        }
        var top = this.topLevel(gx, gz);
        var rm = this.roofMat(gx, gz, top);
        if (rm) {
          var ry = this.floorY(gx, gz, top) + FLOOR_H;
          if ((py > ry && y <= ry) || (py < ry && y >= ry)) {
            return { kind: 'roof', gx: gx, gz: gz, L: top, mat: rm, x: x, y: ry, z: z };
          }
        }
      }
      // (round 115) …AND THE ATTIC UNDER THE SLOPES. A round flying over the
      // eaves of a pitched roof went through the roof as if it were air: the
      // eaves' plane was the only surface tested. The sightline is stopped
      // there (`sightCross`), so the round is too.
      if (window.Structures.exactRay !== false && this.has(gx, gz) && this.wallM) {
        var atop = this.topLevel(gx, gz), ai = this.li(gx, gz, atop), arm = this.roofM[ai];
        if (arm) {
          var ary = this.floorY(gx, gz, atop) + FLOOR_H;
          if (y > ary) {
            var ash = this.roofK[ai] & 7, ark = this.roofK[ai] >> 3;
            if (y < ary + (ash === R_FLAT ? 0.24 * S : (ark + 0.5) * riseOf(MATS[arm]))) return { kind: 'roof', gx: gx, gz: gz, L: atop, mat: arm, x: x, y: y, z: z };
          }
        }
      }
      pgx = gx; pgz = gz; py = y;
    }
    return null;
  };
  /**
   * (round 115) WHERE A SEGMENT CROSSES THE SURFACES BETWEEN TWO CELLS — the
   * one between two neighbours, or both of a diagonal step in the order the
   * segment meets them (the second on the cell it passed through). `t` runs
   * along (x0, y0, z0) + (dx, dy, dz) * t. Returns the piece struck at the
   * crossing point, or null.
   */
  Structures.prototype._crossT = function (gx, gz, e, x0, z0, dx, dz) {
    if (e === 1 || e === 3) { var xb = G.cellCenter(gx) + (e === 1 ? T : -T) * 0.5; return dx ? (xb - x0) / dx : 0; }
    var zb = G.cellCenter(gz) + (e === 2 ? T : -T) * 0.5; return dz ? (zb - z0) / dz : 0;
  };
  Structures.prototype._rayCross = function (pgx, pgz, gx, gz, x0, y0, z0, dx, dy, dz) {
    var sx = gx - pgx, sz = gz - pgz;
    if (sx && sz) {
      var ex = sx > 0 ? 1 : 3, ez = sz > 0 ? 2 : 0;
      var tx = this._crossT(pgx, pgz, ex, x0, z0, dx, dz), tz = this._crossT(pgx, pgz, ez, x0, z0, dx, dz);
      if (tx <= tz) return this._rayCross1(pgx, pgz, ex, tx, x0, y0, z0, dx, dy, dz) || this._rayCross1(pgx + sx, pgz, ez, tz, x0, y0, z0, dx, dy, dz);
      return this._rayCross1(pgx, pgz, ez, tz, x0, y0, z0, dx, dy, dz) || this._rayCross1(pgx, pgz + sz, ex, tx, x0, y0, z0, dx, dy, dz);
    }
    var e = sx > 0 ? 1 : sx < 0 ? 3 : sz > 0 ? 2 : 0;
    return this._rayCross1(pgx, pgz, e, this._crossT(pgx, pgz, e, x0, z0, dx, dz), x0, y0, z0, dx, dy, dz);
  };
  Structures.prototype._rayCross1 = function (gx, gz, e, t, x0, y0, z0, dx, dy, dz) {
    var xc = x0 + dx * t, yc = y0 + dy * t, zc = z0 + dz * t;
    return this._rayWall(gx, gz, this._levelAt(this.wallBase(gx, gz, e), yc), e, xc, yc, zc);
  };
  /** `_rayWall`'s answer as a yes/no, allocating nothing — for sightlines. */
  Structures.prototype._wallStops = function (gx, gz, L, e, x, y, z) {
    if (!this.inb(gx, gz, L)) return false;
    var i = this.li(gx, gz, L) * 4 + e;
    if (!this.wallM[i]) return false;
    var k = this.wallK[i] & 7;
    var fw = this.wallBase(gx, gz, e) + L * FLOOR_H;
    if (this.wallHole && this.wallHole[i] && k !== K_RUBBLE
        && (this.wallHole[i] & (1 << this._holeBit(gx, gz, e, fw, x, y, z)))) return false;
    if (k === K_RUBBLE) return y <= fw + 0.62 * S;
    if (k === K_DOOR) return !(y < fw + 1.55 * S && this._nearEdgeCentre(gx, gz, e, x, z, 0.36 * S));
    if (k === K_WINDOW) return !(y > fw + 0.78 * S && y < fw + 1.62 * S
      && (pairs() ? this._nearPair(gx, gz, e, x, z, 0.41 * S) : this._nearEdgeCentre(gx, gz, e, x, z, 0.41 * S)));
    if (k === K_ARCH) return !(y < fw + FLOOR_H - 0.32 * S);
    return true;
  };
  /**
   * (round 115) A SIGHTLINE STOPS WHERE A ROUND WOULD. `sightStep` let a line
   * through any window, door or breach EDGE at any height and anywhere along
   * its six metres, so a man saw through a house wherever both its fronts had
   * a window: of street pairs either side of a building whose sightline it
   * passed, a round along the same line struck a wall in 52-69% (Village,
   * Ortona, Nijmegen, Berlin, Saint-Lo) — men saw, and shot at, what no round
   * could reach. Here every surface is tested where the line CROSSES it, by
   * the opening a round uses (`_wallStops`), EXCEPT the walls of the two
   * cells the line starts and ends in (`oa`, `ob`, cell indices): a man at a
   * window looks out of it, and is seen in it, as before — he is at his
   * opening, and `Projectiles._windowFire` puts his fire through it. And a
   * roof is a roof: the line that crosses the eaves' plane inside a roofed
   * column, or passes through the attic under its slopes, is stopped. The
   * same arguments as `sightStep`, plus the line (a + d t) and the two cells.
   */
  Structures.prototype.sightCross = function (gx0, gz0, gx1, gz1, y, prevY, ax, ay, az, dx, dy, dz, oa, ob) {
    if (!this.any) return false;
    var h0 = this.has(gx0, gz0), h1 = this.has(gx1, gz1);
    if (!h0 && !h1) return false;
    var sx = gx1 - gx0, sz = gz1 - gz0;
    if (sx || sz) {
      if (sx && sz) {
        var ex = sx > 0 ? 1 : 3, ez = sz > 0 ? 2 : 0;
        var tx = this._crossT(gx0, gz0, ex, ax, az, dx, dz), tz = this._crossT(gx0, gz0, ez, ax, az, dx, dz);
        if (tx <= tz) {
          if (this._sightCross1(gx0, gz0, ex, tx, ax, ay, az, dx, dy, dz, oa, ob)) return true;
          if (this._sightCross1(gx1, gz0, ez, tz, ax, ay, az, dx, dy, dz, oa, ob)) return true;
        } else {
          if (this._sightCross1(gx0, gz0, ez, tz, ax, ay, az, dx, dy, dz, oa, ob)) return true;
          if (this._sightCross1(gx0, gz1, ex, tx, ax, ay, az, dx, dy, dz, oa, ob)) return true;
        }
      } else {
        var e = sx > 0 ? 1 : sx < 0 ? 3 : sz > 0 ? 2 : 0;
        if (this._sightCross1(gx0, gz0, e, this._crossT(gx0, gz0, e, ax, az, dx, dz), ax, ay, az, dx, dy, dz, oa, ob)) return true;
      }
    }
    if (h1) {
      if (prevY !== undefined && prevY !== y) {
        var La = this.levelOf(gx1, gz1, prevY), Lb = this.levelOf(gx1, gz1, y);
        if (La !== Lb && this.floorMat(gx1, gz1, Math.max(La, Lb))) return true;
      }
      // the roof, and the attic under it (not the end cells': a man is not
      // in his own roof, and the street next to a house is not under it)
      var ci1 = gz1 * G.GRID + gx1;
      if (ci1 !== oa && ci1 !== ob && this.wallM) {
        var top = this.topLevel(gx1, gz1), ri = this.li(gx1, gz1, top), rm = this.roofM[ri];
        if (rm) {
          var ry = this.floorY(gx1, gz1, top) + FLOOR_H;
          if (prevY !== undefined && (prevY - ry) * (y - ry) < 0) return true;
          var sh = this.roofK[ri] & 7, rk = this.roofK[ri] >> 3;
          var rt = sh === R_FLAT ? 0.24 * S : (rk + 0.5) * riseOf(MATS[rm]);
          if (y > ry && y < ry + rt) return true;
        }
      }
    }
    return false;
  };
  Structures.prototype._sightCross1 = function (gx, gz, e, t, ax, ay, az, dx, dy, dz, oa, ob) {
    var yc = ay + dy * t;
    var L = this._levelAt(this.wallBase(gx, gz, e), yc);
    if (!this.inb(gx, gz, L) || !this.wallM) return false;
    if (!this.wallM[this.li(gx, gz, L) * 4 + e]) return false;
    var d = EDGE_D[e], c0 = gz * G.GRID + gx, c1 = (gz + d[1]) * G.GRID + gx + d[0];
    if (c0 === oa || c1 === oa || c0 === ob || c1 === ob) return this._sightEdge(gx, gz, L, e, yc);
    return this._wallStops(gx, gz, L, e, ax + dx * t, yc, az + dz * t);
  };
  Structures.prototype._rayWall = function (gx, gz, L, e, x, y, z) {
    if (!this.inb(gx, gz, L)) return null;
    var i = this.li(gx, gz, L) * 4 + e;
    var m = this.wallM[i];
    if (!m) return null;
    var k = this.wallK[i] & 7;
    var fw = this.wallBase(gx, gz, e) + L * FLOOR_H;     // the storey the wall is drawn on
    // through a shell hole (round 110)
    if (this.wallHole && this.wallHole[i] && k !== K_RUBBLE
        && (this.wallHole[i] & (1 << this._holeBit(gx, gz, e, fw, x, y, z)))) return null;
    if (k === K_RUBBLE) {              // only the bottom half-metre is left
      if (y > fw + 0.62 * S) return null;
    } else if (k === K_DOOR) {
      if (y < fw + 1.55 * S && this._nearEdgeCentre(gx, gz, e, x, z, 0.36 * S)) return null;
    } else if (k === K_WINDOW) {
      if (y > fw + 0.78 * S && y < fw + 1.62 * S
          && (pairs() ? this._nearPair(gx, gz, e, x, z, 0.41 * S) : this._nearEdgeCentre(gx, gz, e, x, z, 0.41 * S))) return null;
    } else if (k === K_ARCH) {
      if (y < fw + FLOOR_H - 0.32 * S) return null;
    }
    return { kind: 'wall', gx: gx, gz: gz, L: L, e: e, mat: m, wk: k, x: x, y: y, z: z };
  };
  /**
   * THE OPENING IN THIS WALL NEAREST A POINT (round 110): a window of the pair,
   * the doorway, an arch, what is left above a heap of rubble, or a shell hole
   * — the way a round fired from inside gets out and the way one fired from
   * outside gets in. Returns its point on the wall nearest (wx, wz) along the
   * edge, its height band [y0, y1] and the edge's outward normal, or null for
   * an unbroken solid wall. The same answer from either of the wall's cells.
   */
  Structures.prototype.aperture = function (gx, gz, L, e, wx, wz) {
    if (!this.wallM || !this.inb(gx, gz, L)) return null;
    var i = this.li(gx, gz, L) * 4 + e, m = this.wallM[i];
    if (!m) return null;
    var k = this.wallK[i] & 7, H = FLOOR_H, fw = this.wallBase(gx, gz, e) + L * FLOOR_H;
    var horiz = (e === 0 || e === 2), d = EDGE_D[e];
    var c0 = horiz ? G.cellCenter(gx) - T * 0.5 : G.cellCenter(gz) - T * 0.5;
    var along = (horiz ? wx : wz) - c0;
    var ops = [];
    if (k === K_WINDOW) {
      var ow = 0.82 * S, sl = 0.78 * S, tp = 1.62 * S;
      if (pairs()) ops.push([T * 0.25 - ow * 0.5, T * 0.25 + ow * 0.5, sl, tp], [T * 0.75 - ow * 0.5, T * 0.75 + ow * 0.5, sl, tp]);
      else ops.push([T * 0.5 - ow * 0.5, T * 0.5 + ow * 0.5, sl, tp]);
    } else if (k === K_DOOR) {
      var dw = 0.72 * S; ops.push([T * 0.5 - dw * 0.5, T * 0.5 + dw * 0.5, 0, 1.55 * S]);
    } else if (k === K_ARCH) ops.push([T * 0.16, T * 0.84, 0, H - 0.32 * S]);
    else if (k === K_RUBBLE) ops.push([0, T, 0.62 * S, H]);
    var h = (this.wallHole && k !== K_RUBBLE) ? this.wallHole[i] : 0;
    for (var b = 0; b < HOLE_COLS * HOLE_ROWS; b++) if (h & (1 << b)) {
      var col = b % HOLE_COLS, row = (b / HOLE_COLS) | 0;
      ops.push([col * T / HOLE_COLS, (col + 1) * T / HOLE_COLS, row * H / HOLE_ROWS, (row + 1) * H / HOLE_ROWS]);
    }
    var best = null, bd = Infinity;
    for (var q = 0; q < ops.length; q++) {
      var o = ops[q], dd = along < o[0] ? o[0] - along : along > o[1] ? along - o[1] : 0;
      if (dd < bd) { bd = dd; best = o; }
    }
    if (!best) return null;
    var inset = Math.min(0.03, (best[1] - best[0]) * 0.25);
    var u = Math.max(best[0] + inset, Math.min(best[1] - inset, along));
    return {
      x: horiz ? c0 + u : G.cellCenter(gx) + d[0] * T * 0.5,
      z: horiz ? G.cellCenter(gz) + d[1] * T * 0.5 : c0 + u,
      y0: fw + best[2], y1: fw + best[3], nx: d[0], nz: d[1], far: bd,
    };
  };
  /** Which cell of the hole grid a point on this wall is in (round 110):
   *  column along the edge from its start, row up from the storey's floor. The
   *  same answer on both of the wall's addresses — the edge has the same start
   *  from either side. */
  Structures.prototype._holeBit = function (gx, gz, e, fw, x, y, z) {
    var a = (e === 0 || e === 2) ? x - (G.cellCenter(gx) - T * 0.5) : z - (G.cellCenter(gz) - T * 0.5);
    var col = Math.floor(a / T * HOLE_COLS);
    col = col < 0 ? 0 : col >= HOLE_COLS ? HOLE_COLS - 1 : col;
    var row = Math.floor((y - fw) / FLOOR_H * HOLE_ROWS);
    row = row < 0 ? 0 : row >= HOLE_ROWS ? HOLE_ROWS - 1 : row;
    return row * HOLE_COLS + col;
  };
  /**
   * BLOW `n` CELLS OUT OF A WALL (round 110), starting with the one the round
   * struck at (x, y, z) and growing to the nearest — `Game.shellIntoWall` says
   * how many from the charge. Both addresses take the same holes; a hole down
   * to the floor marks the wall `K_BREACH` (open to a man on foot, to both
   * searches); a panel with HOLE_FALL cells gone comes down as it always did.
   * Returns the cells newly blown.
   */
  Structures.prototype.punchHole = function (ref, n, x, y, z) {
    if (!this.wallM || !this.wallHole || !ref || ref.kind !== 'wall' || !(n > 0) || !this.inb(ref.gx, ref.gz, ref.L)) return 0;
    var i = this.li(ref.gx, ref.gz, ref.L) * 4 + ref.e;
    var m = this.wallM[i];
    if (!m) return 0;
    var kb = this.wallK[i] & 7;
    if (kb === K_RUBBLE) return 0;
    var d = EDGE_D[ref.e], nx = ref.gx + d[0], nz = ref.gz + d[1];
    var j = this.inb(nx, nz, ref.L) ? this.li(nx, nz, ref.L) * 4 + ((ref.e + 2) % 4) : -1;
    var h = this.wallHole[i] | (j >= 0 ? this.wallHole[j] : 0);
    var b0 = this._holeBit(ref.gx, ref.gz, ref.e, this.wallBase(ref.gx, ref.gz, ref.e) + ref.L * FLOOR_H, x, y, z);
    var c0 = b0 % HOLE_COLS, r0 = (b0 / HOLE_COLS) | 0, made = 0, order = [];
    for (var b = 0; b < HOLE_COLS * HOLE_ROWS; b++) {
      var dc = b % HOLE_COLS - c0, dr = ((b / HOLE_COLS) | 0) - r0;
      order.push({ b: b, d: dc * dc + dr * dr + (b === b0 ? -1 : Math.random() * 0.5) });
    }
    order.sort(function (p, q) { return p.d - q.d; });
    for (var k = 0; k < order.length && made < n; k++) {
      var bit = 1 << order[k].b;
      if (h & bit) continue;
      h |= bit; made++;
    }
    if (!made) return 0;
    this.wallHole[i] = h; if (j >= 0) this.wallHole[j] = h;
    if ((h & HOLE_ROW0) && (kb === K_SOLID || kb === K_WINDOW)) {
      this.wallK[i] = kb | K_BREACH; if (j >= 0) this.wallK[j] = kb | K_BREACH;
    }
    this.markDirty(ref.gx, ref.gz); if (j >= 0) this.markDirty(nx, nz);
    if (holeCount(h) >= HOLE_FALL) this._destroyPiece(ref, m, {});
    return made;
  };
  /** Is this world point within `half` of the middle of that cell edge? —
   *  i.e. inside the door/window opening rather than through the jamb. */
  /** …or within `half` of either of a window edge's two openings, a quarter
   *  of the cell either side of its middle (`pairs`). */
  Structures.prototype._nearPair = function (gx, gz, e, x, z, half) {
    var horiz = (e === 0 || e === 2);
    var c = horiz ? G.cellCenter(gx) : G.cellCenter(gz);
    var v = horiz ? x : z;
    return Math.abs(Math.abs(v - c) - T * 0.25) <= half;
  };
  Structures.prototype._nearEdgeCentre = function (gx, gz, e, x, z, half) {
    var horiz = (e === 0 || e === 2);
    var c = horiz ? G.cellCenter(gx) : G.cellCenter(gz);
    var v = horiz ? x : z;
    return Math.abs(v - c) <= half;
  };

  // =========================================================================
  // COVER — a wall is only cover from the side the shooter is on
  // =========================================================================

  /**
   * What the pieces around this cell are worth to a man standing in it,
   * against fire coming from (fx,fz). Directional: the wall you are behind
   * protects you, the one at your back does not.
   */
  Structures.prototype.coverAt = function (gx, gz, L, fx, fz) {
    if (!this.has(gx, gz)) return 0;
    var cx = G.cellCenter(gx), cz = G.cellCenter(gz);
    var best = 0;
    for (var e = 0; e < 4; e++) {
      var m = this.wallMat(gx, gz, L, e);
      if (!m) continue;
      var d = EDGE_D[e];
      if (fx !== undefined) {
        // Only the surfaces between you and the shot count.
        var toX = fx - cx, toZ = fz - cz;
        var len = Math.hypot(toX, toZ) || 1;
        if ((toX / len) * d[0] + (toZ / len) * d[1] < 0.12) continue;
      }
      var k = this.wallKind(gx, gz, L, e);
      var mat = MATS[m];
      var v = mat.cover;
      if (k === K_WINDOW) v *= 0.72;      // firing from a window sill
      else if (k === K_DOOR) v *= 0.5;
      else if (k === K_RUBBLE) v *= 0.55;
      else if (k === K_ARCH) v *= 0.22;
      var hp = this.wallH[this.li(gx, gz, L) * 4 + e] / 255;
      v *= 0.45 + 0.55 * hp;              // a battered wall protects less
      var hn = this.wallHole ? holeCount(this.wallHole[this.li(gx, gz, L) * 4 + e]) : 0;
      if (hn && k !== K_RUBBLE) v *= Math.max(0.3, 1 - hn * 0.11);   // …and a holed one less again
      if (v > best) best = v;
    }
    return best;
  };

  /** 0..1 — how enclosed this cell is. Full walls and a floor overhead is a
   *  room; one wall and open sky is a corner. Feeds concealment. */
  Structures.prototype.insideAt = function (gx, gz, L) {
    if (!this.has(gx, gz)) return 0;
    var n = 0;
    for (var e = 0; e < 4; e++) if (this.wallMat(gx, gz, L, e)) n++;
    var overhead = this.floorMat(gx, gz, L + 1) || this.roofMat(gx, gz, L) ? 1 : 0;
    return Math.min(1, (n / 4) * 0.75 + overhead * 0.25);
  };

  /** Is this cell/level an interior space — walls or a roof over it, and
   *  something to stand on? Used to pick fighting positions inside. */
  Structures.prototype.isInterior = function (gx, gz, L) {
    if (!this.has(gx, gz) || !this.standable(gx, gz, L)) return false;
    return this.insideAt(gx, gz, L) >= 0.5;
  };
  /** How many of this cell's surfaces are windows or doorways facing out —
   *  a firing position is a cell with an opening in it. */
  Structures.prototype.firingValue = function (gx, gz, L) {
    if (!this.has(gx, gz)) return 0;
    var v = 0;
    for (var e = 0; e < 4; e++) {
      var k = this.wallKind(gx, gz, L, e), m = this.wallMat(gx, gz, L, e);
      if (!m) continue;
      if (k === K_WINDOW) v += 1;
      else if (k === K_RUBBLE) v += 0.6;
      else if (k === K_DOOR || k === K_ARCH) v += 0.4;
      else if (this.wallHole && this.wallHole[this.li(gx, gz, L) * 4 + e]) v += 0.6;   // a shell hole is a loophole
    }
    return v;
  };

  // =========================================================================
  // DAMAGE, COLLAPSE AND FIRE
  // =========================================================================

  Structures.prototype._pieceHp = function (mat) { return MATS[mat].hp; };

  /**
   * Hurt one piece. `ref` is what `raySegment` returns, or `{kind,gx,gz,L,e}`.
   * A masonry wall that dies becomes RUBBLE rather than vanishing — that is
   * what makes a shelled village read as ruins instead of as an empty field.
   */
  Structures.prototype.damagePiece = function (ref, dmg, opts) {
    opts = opts || {};
    if (!this.wallM || !ref || !this.inb(ref.gx, ref.gz, ref.L)) return false;
    var i = this.li(ref.gx, ref.gz, ref.L), arr, ai, mat;
    if (ref.kind === 'wall') { arr = this.wallH; ai = i * 4 + ref.e; mat = this.wallM[ai]; }
    else if (ref.kind === 'floor') { arr = this.floorH; ai = i; mat = this.floorM[i]; }
    else if (ref.kind === 'roof') { arr = this.roofH; ai = i; mat = this.roofM[i]; }
    else if (ref.kind === 'feat') { arr = this.featH; ai = i; mat = this.featMat(i); }
    else return false;
    if (!mat || !arr[ai]) return false;
    var max = this._pieceHp(mat);
    var frac = Math.min(255, Math.round(dmg / max * 255));
    var was = arr[ai];
    arr[ai] = was > frac ? was - frac : 0;
    this.markDirty(ref.gx, ref.gz);
    if (arr[ai] > 0) {
      if (opts.fire && MATS[mat].fire > 0) this.ignitePiece(ref);
      return false;
    }
    this._destroyPiece(ref, mat, opts);
    // …AND WRECKAGE BURNS. Ignition used to be reachable only by a piece that
    // SURVIVED its hit, so the bigger the shell the less likely anything
    // caught: measured on a wood-walled building, a 6-pounder and a 75 mm lit
    // it one burst in twenty and a 10.5 cm and a 15 cm lit it **none in
    // twenty**, because they blew the panel apart instead. That is backwards —
    // a heavy round through a timber barn is the likeliest thing on the
    // battlefield to set it alight. What is left standing in the same cell
    // takes instead, which is the rest of the building.
    if (opts.fire && MATS[mat].fire > 0) this.igniteCell(ref.gx, ref.gz, ref.L);
    return true;
  };

  Structures.prototype._destroyPiece = function (ref, mat, opts) {
    var m = MATS[mat];
    var wx = G.cellCenter(ref.gx), wz = G.cellCenter(ref.gz);
    var wy = this.floorY(ref.gx, ref.gz, ref.L) + FLOOR_H * 0.4;
    if (ref.kind === 'wall') {
      var i = this.li(ref.gx, ref.gz, ref.L) * 4 + ref.e;
      var k = this.wallK[i] & 7;
      if (m.ruin && k !== K_RUBBLE && !(opts && opts.fell)) {
        // Masonry collapses into a spoil heap you can still fight from.
        this.setWall(ref.gx, ref.gz, ref.L, ref.e, this.wallM[i], K_RUBBLE);
        var j = this.li(ref.gx, ref.gz, ref.L) * 4 + ref.e;
        this.wallH[j] = 110;
        var d = EDGE_D[ref.e], nx = ref.gx + d[0], nz = ref.gz + d[1];
        if (this.inb(nx, nz, ref.L)) this.wallH[this.li(nx, nz, ref.L) * 4 + ((ref.e + 2) % 4)] = 110;
      } else {
        this.setWall(ref.gx, ref.gz, ref.L, ref.e, 0, 0);
      }
      var dd = EDGE_D[ref.e];
      wx += dd[0] * T * 0.5; wz += dd[1] * T * 0.5;
      // (round 110) …AND THE WALL THAT STOOD ON IT COMES DOWN WITH IT. A wall
      // of a house is carried by the wall under it, not by the floor, and a
      // ground-floor front knocked into the street left the storeys above it
      // standing on nothing — a façade floating over a gap, for the rest of
      // the battle. It falls into the street (`fell`: no heap up there), and
      // whatever stood on it after it. Rubble is still a wall to stand on: a
      // panel only falls when the one under it is gone or has become a heap.
      if (EDGE_BLAST.on && ref.L + 1 < LEVELS) {
        var ui = this.li(ref.gx, ref.gz, ref.L + 1) * 4 + ref.e, um = this.wallM[ui];
        if (um && (this.wallK[ui] & 7) !== K_RUBBLE) this._destroyPiece({ kind: 'wall', gx: ref.gx, gz: ref.gz, L: ref.L + 1, e: ref.e }, um, { fell: true });
      }
    } else if (ref.kind === 'floor') {
      this.setFloor(ref.gx, ref.gz, ref.L, 0);
      wy = this.floorY(ref.gx, ref.gz, ref.L);
    } else if (ref.kind === 'roof') {
      this.setRoof(ref.gx, ref.gz, ref.L, 0, 0);
      wy = this.floorY(ref.gx, ref.gz, ref.L) + FLOOR_H;
    } else if (ref.kind === 'feat') {
      this.setFeature(ref.gx, ref.gz, ref.L, 0, 0, 0, 0);
    }
    this._unignite(ref);
    this.settleQ.push((ref.L * G.GRID + ref.gz) * G.GRID + ref.gx);
    if (this.game) this.game._structurePieceDestroyed(ref, m, wx, wy, wz);
  };

  /**
   * Blast damage. Walls, floors and roofs inside the sphere all take a share,
   * falling off with distance — which is why a 105 through a roof takes the
   * roof, the attic floor and the top of the walls with it.
   */
  Structures.prototype.damageArea = function (wx, wy, wz, radius, dmg, opts) {
    if (!this.any) return 0;
    opts = opts || {};
    // (round 110) `opts.skip`: the wall a round struck, whose damage the strike
    // itself has already done (`Game.shellIntoWall`) — on either address
    var sk = opts.skip && opts.skip.kind === 'wall' ? opts.skip : null, skx = 0, skz = 0, ske = 0;
    if (sk) { var sd = EDGE_D[sk.e]; skx = sk.gx + sd[0]; skz = sk.gz + sd[1]; ske = (sk.e + 2) % 4; }
    var r = Math.ceil(radius / T);
    var cx = G.worldToCell(wx), cz = G.worldToCell(wz);
    var hits = 0;
    for (var dz = -r; dz <= r; dz++) for (var dx = -r; dx <= r; dx++) {
      var gx = cx + dx, gz = cz + dz;
      if (!this.has(gx, gz)) continue;
      var px = G.cellCenter(gx), pz = G.cellCenter(gz);
      var dh = Math.hypot(px - wx, pz - wz);
      if (dh > radius + T) continue;
      // (round 110) THE STOREY THE BURST IS IN, in this column — what a slab
      // between it and a piece shields (`SLAB_SHIELD`, below)
      var Lb = EDGE_BLAST.on ? this.levelOf(gx, gz, wy) : -1;
      for (var L = 0; L < LEVELS; L++) {
        var fy = this.floorY(gx, gz, L);
        // A FLOOR IS IN THE WAY. The height weighting below was the only thing
        // between a burst and the storeys over and under it, so a 105 mm round
        // through a roof, bursting in the attic, knocked down the walls of the
        // room under the attic floor as well. Every intact slab between the
        // burst's storey and this one takes most of it: `sh` for this storey's
        // walls and roof, `shF` for its own floor (which the burst meets face on
        // from above, and from below only through the slabs under it).
        var sh = 1, shF = 1;
        if (Lb >= 0 && L !== Lb) {
          var lo = Math.min(L, Lb), hi = Math.max(L, Lb);
          for (var sl = lo + 1; sl <= hi; sl++) if (this.floorM[this.li(gx, gz, sl)]) {
            sh *= SLAB_SHIELD;
            if (!(L > Lb && sl === L)) shF *= SLAB_SHIELD;
          }
        }
        // Height counts for MORE than ground distance. A shell that comes
        // through an attic window wrecks the attic; the family in the cellar
        // are deafened, not buried. Without this weighting one burst reaches
        // every storey at once and four rounds level a townhouse.
        var dv = Math.max(0, Math.max(fy - wy, wy - (fy + FLOOR_H))) * 2.2;
        var d = Math.hypot(dh, dv);
        var cellIn = d <= radius;
        // (round 110) a wall is measured where it STANDS, on its edge (below):
        // a cell whose middle is out of reach can still have a wall in it
        if (!cellIn && !(EDGE_BLAST.on && Math.hypot(Math.max(0, dh - T * 0.5), dv) <= radius)) continue;
        // A steep falloff keeps the damage where the round actually went off.
        var fall = cellIn ? Math.pow(1 - d / radius, 1.7) : 0;
        var take = dmg * fall * sh;
        var i = this.li(gx, gz, L);
        for (var e = 0; e < 4; e++) {
          if (!this.wallM[i * 4 + e]) continue;
          if (sk && L === sk.L && ((gx === sk.gx && gz === sk.gz && e === sk.e) || (gx === skx && gz === skz && e === ske))) continue;
          var tw = take;
          if (EDGE_BLAST.on) {
            // EACH WALL FROM WHERE IT STANDS (round 110). Every wall of a cell
            // took the blast at the distance of the cell's MIDDLE, so a burst
            // against one wall of a room was as close to the room's far wall,
            // three metres further off, and a round inside one room took all
            // four walls of every room round it: a twelve-round 105 mm
            // concentration on a Nijmegen block, its rounds now striking the
            // roofs, took 188 of 396 walls and 40 of 68 floors.
            var ed = EDGE_D[e];
            var de = Math.hypot(Math.hypot(px + ed[0] * T * 0.5 - wx, pz + ed[1] * T * 0.5 - wz), dv);
            if (de > radius) continue;
            tw = dmg * Math.pow(1 - de / radius, 1.7) * sh;
          }
          if (this.damagePiece({ kind: 'wall', gx: gx, gz: gz, L: L, e: e }, tw, opts)) hits++;
          else if (opts.fire) this.ignitePiece({ kind: 'wall', gx: gx, gz: gz, L: L, e: e });
        }
        if (!cellIn) continue;
        // Slabs are joisted into the walls and are the LAST thing to go —
        // which is what keeps a shelled building a building instead of a heap.
        if (this.floorM[i] && this.damagePiece({ kind: 'floor', gx: gx, gz: gz, L: L }, take * 0.45 * (sh > 0 ? shF / sh : 1), opts)) hits++;
        if (this.roofM[i] && this.damagePiece({ kind: 'roof', gx: gx, gz: gz, L: L }, take * 0.8, opts)) hits++;
        if (opts.fire) this.igniteCell(gx, gz, L);
      }
    }
    return hits;
  };

  // ---- structural support -------------------------------------------------
  /**
   * A slab needs something under it. Support propagates: a floor is held up if
   * it sits over a wall or a pillar, or if it is joined to a neighbouring slab
   * on the same storey that is. Anything left over falls, taking whatever is
   * standing on it — that is the cascade that turns a hit at the base of a
   * building into a collapse rather than a hole.
   */
  Structures.prototype._supportedUnder = function (gx, gz, L) {
    if (L <= 0) return true;
    var i = this.li(gx, gz, L - 1);
    for (var e = 0; e < 4; e++) if (this.wallM[i * 4 + e]) return true;
    if (this.feat[i]) return true;                       // a stair well carries it
    return false;
  };
  Structures.prototype._settle = function (budget) {
    var done = 0;
    var seen = {};
    while (this.settleQ.length && done < budget) {
      var idx = this.settleQ.shift();
      if (seen[idx]) continue;
      seen[idx] = 1;
      var L = Math.floor(idx / this.N2);
      var rem = idx - L * this.N2;
      var gz = Math.floor(rem / G.GRID), gx = rem - gz * G.GRID;
      done++;
      // Walk up the column: any storey whose slab lost its support goes.
      for (var l = Math.max(1, L); l < LEVELS; l++) {
        if (!this.floorMat(gx, gz, l)) continue;
        if (this._componentSupported(gx, gz, l)) continue;
        this._collapseComponent(gx, gz, l);
        break;
      }
    }
  };
  /** Flood the connected slab component at this storey; supported if ANY of
   *  its cells has something underneath. Bounded so a warehouse floor can't
   *  make the check unbounded work. */
  Structures.prototype._componentSupported = function (gx, gz, L) {
    var stack = [[gx, gz]], seen = {}, n = 0;
    seen[gz * G.GRID + gx] = 1;
    while (stack.length && n < 420) {
      var c = stack.pop(); n++;
      if (this._supportedUnder(c[0], c[1], L)) return true;
      for (var e = 0; e < 4; e++) {
        var d = EDGE_D[e], nx = c[0] + d[0], nz = c[1] + d[1];
        if (!this.inb(nx, nz, L) || seen[nz * G.GRID + nx]) continue;
        if (!this.floorMat(nx, nz, L)) continue;
        seen[nz * G.GRID + nx] = 1; stack.push([nx, nz]);
      }
    }
    return n >= 420;                    // too big to judge: assume it stands
  };
  Structures.prototype._collapseComponent = function (gx, gz, L) {
    var stack = [[gx, gz]], seen = {}, cells = [], n = 0;
    seen[gz * G.GRID + gx] = 1;
    while (stack.length && n < 420) {
      var c = stack.pop(); n++; cells.push(c);
      for (var e = 0; e < 4; e++) {
        var d = EDGE_D[e], nx = c[0] + d[0], nz = c[1] + d[1];
        if (!this.inb(nx, nz, L) || seen[nz * G.GRID + nx]) continue;
        if (!this.floorMat(nx, nz, L)) continue;
        seen[nz * G.GRID + nx] = 1; stack.push([nx, nz]);
      }
    }
    for (var k = 0; k < cells.length; k++) {
      var cx = cells[k][0], cz = cells[k][1];
      for (var l = L; l < LEVELS; l++) {
        var mat = this.floorMat(cx, cz, l);
        if (mat) this._destroyPiece({ kind: 'floor', gx: cx, gz: cz, L: l }, mat, { collapse: true });
        var rm = this.roofMat(cx, cz, l);
        if (rm) this._destroyPiece({ kind: 'roof', gx: cx, gz: cz, L: l }, rm, { collapse: true });
        for (var e2 = 0; e2 < 4; e2++) {
          var wm = this.wallM[this.li(cx, cz, l) * 4 + e2];
          if (wm) this._destroyPiece({ kind: 'wall', gx: cx, gz: cz, L: l, e: e2 }, wm, { collapse: true });
        }
        if (this.feat[this.li(cx, cz, l)]) this.setFeature(cx, cz, l, 0, 0, 0, 0);
      }
      if (this.game) this.game._structureCollapsed(cx, cz, L);
    }
  };

  // ---- fire ---------------------------------------------------------------
  var MAX_FIRES = 200;
  // (round 115) A TIMBER HOUSE TAKES MINUTES TO GO UP. Every burning piece
  // reached for the next one every 2.4-5.6 s and burned through in ~30 s, so a
  // village went from one lit wall to 126 fires in a minute, and a man in a
  // room was dead within two seconds of its first flame. In the game (the
  // instance's `game.fire115` not false): spreading x`spread`, burning x`burn`,
  // and `heatAt` says how far a fire has grown — smoke for its first
  // `smoke` seconds, then flames over `grow` more.
  var FIRE_RATE = { spread: 10, burn: 0.25, smoke: 25, grow: 90 };
  /**
   * A wall is ONE surface with two addresses, and fire has to know that. Left
   * un-canonicalised, a burning wall spreads into the cell on its other side,
   * lights "another" wall that is in fact itself, and the two copies then
   * fight over the same hit points. Every fire key comes through here first:
   * an east or south surface is rewritten as the west or north surface of the
   * neighbour, so both addresses collapse to one.
   */
  Structures.prototype._canonWall = function (gx, gz, L, e) {
    if (e === 1 || e === 2) {
      var d = EDGE_D[e];
      return { gx: gx + d[0], gz: gz + d[1], L: L, e: (e + 2) % 4 };
    }
    return { gx: gx, gz: gz, L: L, e: e };
  };
  Structures.prototype._fireKey = function (ref) {
    if (ref.kind === 'wall') {
      var c = this._canonWall(ref.gx, ref.gz, ref.L, ref.e);
      return 'w' + (this.li(c.gx, c.gz, c.L) * 4 + c.e);
    }
    return ref.kind[0] + this.li(ref.gx, ref.gz, ref.L);
  };
  Structures.prototype.ignitePiece = function (ref) {
    if (this.fires.length >= MAX_FIRES) return false;
    var mat = ref.kind === 'wall' ? this.wallMat(ref.gx, ref.gz, ref.L, ref.e)
      : ref.kind === 'floor' ? this.floorMat(ref.gx, ref.gz, ref.L)
        : ref.kind === 'roof' ? this.roofMat(ref.gx, ref.gz, ref.L) : 0;
    if (!mat || !MATS[mat].fire) return false;
    var key = this._fireKey(ref);
    for (var i = 0; i < this.fires.length; i++) if (this.fires[i].key === key) return false;
    var c = ref.kind === 'wall' ? this._canonWall(ref.gx, ref.gz, ref.L, ref.e) : ref;
    this.fires.push({ key: key, kind: ref.kind, gx: c.gx, gz: c.gz, L: c.L, e: c.e || 0, t: 0, spread: (2.2 + Math.random() * 2.5) * this._fireK('spread') });
    return true;
  };
  /** Set light to anything in a cell that will take — the entry point for
   *  flamethrowers, WP and incendiary bursts. */
  Structures.prototype.igniteCell = function (gx, gz, L) {
    if (!this.has(gx, gz)) return 0;
    var n = 0;
    for (var e = 0; e < 4; e++) if (this.ignitePiece({ kind: 'wall', gx: gx, gz: gz, L: L, e: e })) n++;
    if (this.ignitePiece({ kind: 'floor', gx: gx, gz: gz, L: L })) n++;
    if (this.ignitePiece({ kind: 'roof', gx: gx, gz: gz, L: L })) n++;
    return n;
  };
  Structures.prototype._unignite = function (ref) {
    var key = this._fireKey(ref);
    for (var i = 0; i < this.fires.length; i++) if (this.fires[i].key === key) { this.fires.splice(i, 1); return; }
  };
  /** (round 115) The fire model's pace (FIRE_RATE) in a game that has not
   *  switched it off; 1 outside a game (the module's own tests). */
  Structures.prototype._fireK = function (k) {
    return (this.game && this.game.fire115 !== false) ? FIRE_RATE[k] : 1;
  };
  /** (round 115) HOW FAR THE FIRE IN THIS CELL HAS GROWN, 0..1: 0 while it is
   *  smoke (its first FIRE_RATE.smoke seconds), 1 when it is a room ablaze —
   *  the oldest piece alight in it or in a wall of it, on storey L. */
  Structures.prototype.heatAt = function (gx, gz, L) {
    var best = 0;
    for (var i = 0; i < this.fires.length; i++) {
      var f = this.fires[i];
      if (L !== undefined && f.L !== L) continue;
      var hit = f.gx === gx && f.gz === gz;
      if (!hit && f.kind === 'wall') { var d = EDGE_D[f.e]; hit = f.gx + d[0] === gx && f.gz + d[1] === gz; }
      if (!hit) continue;
      var h = (f.t - FIRE_RATE.smoke) / FIRE_RATE.grow;
      if (h > best) best = h > 1 ? 1 : h;
    }
    return best;
  };
  /** Is this cell alight? A burning wall is a surface between two rooms, and
   *  it is on fire in BOTH of them — the men on either side are in the heat. */
  Structures.prototype.burningAt = function (gx, gz, L) {
    for (var i = 0; i < this.fires.length; i++) {
      var f = this.fires[i];
      if (L !== undefined && f.L !== L) continue;
      if (f.gx === gx && f.gz === gz) return true;
      if (f.kind === 'wall') {
        var d = EDGE_D[f.e];
        if (f.gx + d[0] === gx && f.gz + d[1] === gz) return true;
      }
    }
    return false;
  };

  /** Fire eats the piece it is on, throws light and smoke, and reaches for the
   *  next flammable surface. A timber-framed house goes room by room; a
   *  thatched hut goes all at once. */
  Structures.prototype._updateFires = function (dt) {
    if (!this.fires.length) return;
    for (var i = this.fires.length - 1; i >= 0; i--) {
      var f = this.fires[i];
      var mat = f.kind === 'wall' ? this.wallMat(f.gx, f.gz, f.L, f.e)
        : f.kind === 'floor' ? this.floorMat(f.gx, f.gz, f.L) : this.roofMat(f.gx, f.gz, f.L);
      if (!mat) { this.fires.splice(i, 1); continue; }
      f.t += dt;
      var m = MATS[mat];
      // Burn-through, ACCUMULATED. Hit points are stored in a byte, so the
      // smallest damage a piece can register is hp/255 — and a frame's worth of
      // fire is smaller than that. Applied per frame it rounds to zero every
      // time and a timber house burns merrily for ever without losing a plank.
      // Bank it instead and spend it when it is worth a whole unit.
      f.acc = (f.acc || 0) + m.fire * m.hp * dt / (18 + m.hp * 0.10) * this._fireK('burn');
      var quantum = m.hp / 255;
      if (f.acc >= quantum) {
        var give = f.acc; f.acc = 0;
        this.damagePiece({ kind: f.kind, gx: f.gx, gz: f.gz, L: f.L, e: f.e }, give, {});
      }
      f.spread -= dt;
      if (f.spread <= 0) {
        f.spread = (2.4 + Math.random() * 3.2) * this._fireK('spread');
        this._spreadFrom(f);
      }
    }
  };
  Structures.prototype._spreadFrom = function (f) {
    // Fire climbs: up first (it always does), then along the storey.
    if (Math.random() < 0.55 && f.L + 1 < LEVELS) this.igniteCell(f.gx, f.gz, f.L + 1);
    var e = (Math.random() * 4) | 0;
    var d = EDGE_D[e];
    this.igniteCell(f.gx + d[0], f.gz + d[1], f.L);
    this.igniteCell(f.gx, f.gz, f.L);
  };

  // =========================================================================
  // RENDERING — merged chunks
  // =========================================================================

  Structures.prototype.markDirty = function (gx, gz) {
    var cx = (gx / CHUNK) | 0, cz = (gz / CHUNK) | 0;
    if (cx < 0 || cz < 0 || cx >= this.NC || cz >= this.NC) return;
    var k = cz * this.NC + cx;
    var c = this.chunks[k];
    if (!c) { c = this.chunks[k] = { cx: cx, cz: cz, mesh: null, glass: null, dirty: true }; this.dirty.push(k); return; }
    if (!c.dirty) { c.dirty = true; this.dirty.push(k); }
  };

  Structures.prototype._rebuildChunk = function (k) {
    var c = this.chunks[k];
    if (!c) return;
    c.dirty = false;
    // ONE scratch builder for the whole layer, reused for every rebuild: after
    // the first few chunks its buffers are big enough for any of them and the
    // merge allocates nothing at all.
    var B = this._B || (this._B = new Builder(2048));
    var Gl = this._Gl || (this._Gl = new Builder(128));
    B.reset(); Gl.reset();
    var x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
    var x1 = Math.min(G.GRID, x0 + CHUNK), z1 = Math.min(G.GRID, z0 + CHUNK);
    var pieces = 0;
    for (var gz = z0; gz < z1; gz++) for (var gx = x0; gx < x1; gx++) {
      if (!this.mask[gz * G.GRID + gx]) continue;
      var seed0 = gx * 73856093 ^ gz * 19349663;
      for (var L = 0; L < LEVELS; L++) {
        var i = this.li(gx, gz, L);
        var y = this.floorY(gx, gz, L);
        var cx = G.cellCenter(gx), cz = G.cellCenter(gz);
        // (round 113, third batch) QUOINS at a masonry house's outside corners
        // (`quoin`, Blender): where two neighbouring edges of a room are both
        // walls of brick or stone with no room across either. UNFINISHED — off
        // until KIT.quoins (see NORMANDY_HANDOFF.md, "Round 113 paused").
        var KQ = DRESS.on && KIT.quoins ? kitPieces() : null;
        if (KQ && KQ.quoin && this._roomAt(gx, gz, L)) {
          for (var qe = 0; qe < 4; qe++) {
            var qe2 = (qe + 1) % 4, qm = this.wallM[i * 4 + qe], qm2 = this.wallM[i * 4 + qe2];
            if (!qm || !qm2 || !MATS[qm].ruin || !MATS[qm2].ruin || (this.wallH[i * 4 + qe] < 230) || (this.wallH[i * 4 + qe2] < 230)) continue;
            var qa = EDGE_D[qe], qb = EDGE_D[qe2];
            if (this._roomAt(gx + qa[0], gz + qa[1], L) || this._roomAt(gx + qb[0], gz + qb[1], L)) continue;
            // the corner's two outward faces → the piece's +X/+Z by a proper turn
            // (Builder.mesh: alongX keeps x,z; else x,z → z,-x). Corners N-E,
            // E-S, S-W, W-N are qe 0-3: quarter turn, none, quarter turn and a
            // half, a half. Worked on paper from the transform, not yet seen.
            var qAlong = (qe & 1) === 1, qs = qe < 2 ? S : -S;
            var qc = shade(MATS[qm], seed0 + 41, 0, 1.12);
            B.mesh(KQ.quoin[0], cx + (qa[0] + qb[0]) * T * 0.5, this.wallBase(gx, gz, qe) + L * FLOOR_H, cz + (qa[1] + qb[1]) * T * 0.5, qAlong, qs, S, qs, qc.r, qc.g, qc.b);
          }
        }
        // Walls: only draw the N and W surfaces of each cell, plus the S and E
        // surfaces on the far boundary — otherwise every shared surface would
        // be drawn twice, doubling the triangle count of every interior wall.
        for (var e = 0; e < 4; e++) {
          var m = this.wallM[i * 4 + e];
          if (!m) continue;
          if (e === 2 || e === 1) {
            var d = EDGE_D[e], nx = gx + d[0], nz = gz + d[1];
            if (this.inb(nx, nz, L) && this.wallM[this.li(nx, nz, L) * 4 + ((e + 2) % 4)]) continue;
          }
          var k2 = this.wallK[i * 4 + e] & 7, holes = this.wallHole ? this.wallHole[i * 4 + e] : 0;
          var dmg = 1 - this.wallH[i * 4 + e] / 255;
          var yw = this.wallBase(gx, gz, e) + L * FLOOR_H;     // the wall's house's storey
          var lk = this.look[gz * G.GRID + gx];
          if (!lk && HOUSE_LOOK.on) {
            var hb = this.bid[gz * G.GRID + gx] || this._houseOf(gx, gz);
            if (!hb) { var dh = EDGE_D[e], hx = gx + dh[0], hz = gz + dh[1]; if (hx >= 0 && hz >= 0 && hx < G.GRID && hz < G.GRID) hb = this._houseOf(hx, hz); }
            if (hb) lk = houseLook(hb);
          }
          if (!lk && !this.bid[gz * G.GRID + gx]) {
            var de0 = EDGE_D[e], lx0 = gx + de0[0], lz0 = gz + de0[1];
            if (lx0 >= 0 && lz0 >= 0 && lx0 < G.GRID && lz0 < G.GRID) lk = this.look[lz0 * G.GRID + lx0];
          }
          emitWall(B, cx, yw, cz, e, wallLook(MATS[m], lk), k2, dmg, seed0 + e * 17 + L * 5, holes);
          if (holes && k2 !== K_RUBBLE) { pieces++; continue; }   // glass and shutters went with the blast
          if (k2 === K_WINDOW && dmg < 0.35) {
            if (pairs()) { emitGlass(Gl, cx, yw, cz, e, seed0 + e, -T * 0.25); emitGlass(Gl, cx, yw, cz, e, seed0 + e + 3, T * 0.25); }
            else emitGlass(Gl, cx, yw, cz, e, seed0 + e);
          }
          if ((k2 === K_WINDOW || k2 === K_DOOR) && dmg < 0.35 && DRESS.on) {
            // which side is out of doors: the one with no room across it
            var de = EDGE_D[e], ox = gx + de[0], oz = gz + de[1];
            var inHere = this._roomAt(gx, gz, L), inThere = this._roomAt(ox, oz, L);
            var outS = inThere === inHere ? 0 : (inThere ? -1 : 1);
            var pal = paletteOf(this.bid[gz * G.GRID + gx] || ((gx >> 3) * 92821 ^ (gz >> 3) * 68917));
            if (k2 === K_WINDOW && pairs()) {
              emitWindowDressing(B, cx, yw, cz, e, outS, pal, seed0 + e * 29 + L * 3, -T * 0.25);
              emitWindowDressing(B, cx, yw, cz, e, outS, pal, seed0 + e * 29 + L * 3 + 64, T * 0.25);
            } else if (k2 === K_WINDOW) emitWindowDressing(B, cx, yw, cz, e, outS, pal, seed0 + e * 29 + L * 3);
            else emitDoorDressing(B, cx, yw, cz, e, outS, pal, seed0 + e * 29);
          }
          pieces++;
        }
        if (this.floorM[i]) { emitFloor(B, cx, y, cz, MATS[this.floorM[i]], 1 - this.floorH[i] / 255, seed0 + L * 3); pieces++; }
        if (this.roofM[i]) {
          var rsh = this.roofK[i] & 7, rrk = this.roofK[i] >> 3, rdm = 1 - this.roofH[i] / 255;
          emitRoof(B, cx, y + FLOOR_H, cz, roofLook(MATS[this.roofM[i]], this.bid[gz * G.GRID + gx] || (HOUSE_LOOK.on ? this._houseOf(gx, gz) : 0)), rsh, rrk, rdm, seed0 + L * 11); pieces++;
          if (rsh !== R_FLAT) {
            // Close the ends of the ridge. The gable edges are the ones facing
            // ALONG the ridge; where the roof carries on into the next cell
            // there is nothing to close.
            var slopeX = (rsh === R_SLOPE_E || rsh === R_SLOPE_W || rsh === R_RIDGE_Z);
            var ends = slopeX ? [0, 2] : [1, 3];
            for (var q = 0; q < 2; q++) {
              var ge = ends[q], gd = EDGE_D[ge];
              if (this.roofMat(gx + gd[0], gz + gd[1], L)) continue;
              var gm = this.wallM[i * 4 + ge] || this.roofM[i];
              emitGable(B, cx, y + FLOOR_H, cz, MATS[gm], ge, rsh, rrk, rdm, seed0 + ge * 7, riseOf(MATS[this.roofM[i]]));
              pieces++;
              // the chimney stack at one gable end of a masonry house's ridge
              if ((rsh === R_RIDGE_X || rsh === R_RIDGE_Z) && MATS[gm].ruin && rdm < 0.35
                  && ((((gx >> 3) * 31 + (gz >> 3) * 17) & 1) === q)) {
                emitChimney(B, cx, y + FLOOR_H + (rrk + 0.5) * riseOf(MATS[this.roofM[i]]), cz, ge, MATS[gm], seed0 + ge);
              }
            }
          }
        }
        if (this.feat[i]) {
          var f = this.feat[i];
          emitFeature(B, cx, y, cz, f & 7, (f >> 3) & 3, (f >> 5) & 3, MATS[this.featMat(i)], 1 - this.featH[i] / 255, seed0 + L * 23);
          pieces++;
        }
      }
    }
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    if (c.glass) { this.group.remove(c.glass); c.glass.geometry.dispose(); c.glass = null; }
    var g1 = B.geometry();
    if (g1) {
      c.mesh = new THREE.Mesh(g1, this.mat);
      c.mesh.castShadow = true; c.mesh.receiveShadow = true;
      c.mesh.matrixAutoUpdate = false; c.mesh.updateMatrix();
      this.group.add(c.mesh);
    }
    var g2 = Gl.geometry();
    if (g2) {
      c.glass = new THREE.Mesh(g2, this.glassMat);
      c.glass.matrixAutoUpdate = false; c.glass.updateMatrix();
      this.group.add(c.glass);
    }
    c.pieces = pieces;
    c.tris = (B.ni + Gl.ni) / 3;
  };

  /** Per-frame: rebuild what changed (bounded), then run the fire. */
  /**
   * Per-frame: rebuild what changed, settle whatever lost its support, run the
   * fires. Rebuilding is TIME-BOXED rather than counted — a chunk holding nine
   * townhouses costs several times one holding a shed, so "two chunks a frame"
   * is a frame-time promise the renderer cannot keep. Under a barrage the
   * damage appears a frame or two late instead, which nobody can see, rather
   * than dropping the frame rate, which everybody can.
   */
  Structures.prototype.update = function (dt, budgetMs) {
    var ms = budgetMs === undefined ? 3 : budgetMs;
    if (this.dirty.length) {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      var first = true;
      while (this.dirty.length) {
        // Check BEFORE the rebuild, not after: checking after always overruns
        // by a whole chunk, which doubled the frame cost the budget existed to
        // cap. One chunk always goes through, so progress is guaranteed.
        if (!first && t0 && performance.now() - t0 > ms) break;
        var k = this.dirty.shift();
        if (!this.chunks[k] || !this.chunks[k].dirty) continue;
        this._rebuildChunk(k);
        first = false;
      }
    }
    if (this.settleQ.length) this._settle(24);
    if (dt) this._updateFires(dt);
  };
  /** Build everything now — used after a load, so a map doesn't pop in. */
  Structures.prototype.flush = function () {
    var guard = 0;
    while (this.dirty.length && guard++ < 4096) {
      var k = this.dirty.shift();
      if (this.chunks[k] && this.chunks[k].dirty) this._rebuildChunk(k);
    }
  };

  /** Ground under a building moved (sculpting): re-seat the footings. */
  Structures.prototype.reseat = function (gx, gz) {
    var c = this.ci(gx, gz);
    if (!this.mask[c]) return;
    this.baseY[c] = this.terrain.height(gx, gz) * G.HSCALE;
    this.markDirty(gx, gz);
  };

  Structures.prototype.stats = function () {
    var pieces = 0, tris = 0, draws = 0, chunks = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      if (!c) continue;
      chunks++;
      pieces += c.pieces || 0; tris += c.tris || 0;
      if (c.mesh) draws++;
      if (c.glass) draws++;
    }
    return { pieces: pieces, tris: Math.round(tris), draws: draws, chunks: chunks, fires: this.fires.length };
  };

  Structures.prototype.clear = function () {
    // THE STAIRS HAVE MOVED. `Pathfinder._stairsOn` caches every flight on a
    // storey — scanning two hundred thousand cells per search is not a search —
    // and this stamp is how it knows the cache is about to describe a different
    // town. Bumped here rather than tracked per piece: a map load is the only
    // event that replaces the whole set, and a single flight shelled out of a
    // building is caught by `portalUp` being re-checked at the point of use.
    this._stairStamp = (this._stairStamp || 0) + 1;
    this._hid = null;                      // (round 113) the houses, flooded again on demand
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      if (!c) continue;
      if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
      if (c.glass) { this.group.remove(c.glass); c.glass.geometry.dispose(); }
    }
    this.chunks = new Array(this.NC * this.NC);
    this.dirty.length = 0; this.fires.length = 0; this.settleQ.length = 0;
    if (this.wallM) {
      this.wallM.fill(0); this.wallK.fill(0); this.wallH.fill(0); if (this.wallHole) this.wallHole.fill(0);
      this.floorM.fill(0); this.floorH.fill(0);
      this.roofM.fill(0); this.roofK.fill(0); this.roofH.fill(0);
      this.feat.fill(0); this.featH.fill(0);
    }
    this.mask.fill(0); this.baseY.fill(0);
    // …and which house a column was, and its front (round 106): `wallBase` reads
    // `bid` for the footing of a wall a street cell draws, and a street cell of
    // this map must not keep the house id the last map left in it
    this.bid.fill(0); if (this.look) this.look.fill(0);
    this._featMat = {};
    this.any = false;
    if (this.terrain) this.terrain.minimapDirty = true;
  };

  Structures.prototype.dispose = function () {
    this.clear();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.mat.dispose(); this.glassMat.dispose();
  };

  // =========================================================================
  // SERIALIZATION — one record per built column, run-length free
  // =========================================================================
  // A map stores what was BUILT, not what is left standing: damage is runtime
  // state (the same rule the props follow), so a reloaded map starts intact.

  Structures.prototype.serialize = function () {
    if (!this.any) return null;
    var out = [];
    for (var gz = 0; gz < G.GRID; gz++) for (var gx = 0; gx < G.GRID; gx++) {
      if (!this.mask[gz * G.GRID + gx]) continue;
      var col = { x: gx, z: gz, b: Math.round(this.baseY[gz * G.GRID + gx] * 100) / 100, p: [] };
      for (var L = 0; L < LEVELS; L++) {
        var i = this.li(gx, gz, L);
        var rec = 0, w = [];
        for (var e = 0; e < 4; e++) w.push(this.wallM[i * 4 + e] ? (this.wallM[i * 4 + e] | ((this.wallK[i * 4 + e] & 7) << 5)) : 0);
        if (w[0] || w[1] || w[2] || w[3] || this.floorM[i] || this.roofM[i] || this.feat[i]) {
          rec = { l: L };
          if (w[0] || w[1] || w[2] || w[3]) rec.w = w;
          if (this.floorM[i]) rec.f = this.floorM[i];
          if (this.roofM[i]) { rec.r = this.roofM[i]; rec.rk = this.roofK[i]; }
          if (this.feat[i]) { rec.s = this.feat[i]; rec.sm = this.featMat(i); }
          col.p.push(rec);
        }
      }
      if (col.p.length) out.push(col);
    }
    return out.length ? { v: VERSION, cols: out } : null;
  };

  Structures.prototype.load = function (data, off) {
    this.clear();
    if (!data || !data.cols) return;
    off = off || 0;
    for (var n = 0; n < data.cols.length; n++) {
      var col = data.cols[n];
      var gx = col.x + off, gz = col.z + off;
      if (gx < 0 || gz < 0 || gx >= G.GRID || gz >= G.GRID) continue;
      for (var k = 0; k < col.p.length; k++) {
        var rec = col.p[k], L = rec.l;
        if (rec.w) for (var e = 0; e < 4; e++) {
          var v = rec.w[e];
          if (v) this.setWall(gx, gz, L, e, v & 31, (v >> 5) & 7);
        }
        if (rec.f) this.setFloor(gx, gz, L, rec.f);
        if (rec.r) this.setRoof(gx, gz, L, rec.r, (rec.rk || 0) & 7, (rec.rk || 0) >> 3);
        if (rec.s) this.setFeature(gx, gz, L, rec.s & 7, (rec.s >> 3) & 3, (rec.s >> 5) & 3, rec.sm || M_WOOD);
      }
      // The footing rides with the map so a building keeps its plot even if
      // the terrain under it was saved a hair different.
      if (col.b !== undefined) this.baseY[this.ci(gx, gz)] = col.b;
    }
    this.flush();
  };

  // =========================================================================
  // THE GENERATOR — a whole believable building from one dragged rectangle
  // =========================================================================
  // The point is not to replace hand-placing pieces but to make the first 95 %
  // of a building free, and leave every piece of it editable afterwards. What
  // comes out is ordinary walls, slabs, stairs and roof cells with no memory of
  // having been generated — so a shell lands on it and the physics is the same.

  function rngFrom(seed) {
    var s = (seed || 1) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /** Presets — the shapes a WWII battlefield is actually made of. */
  var PRESETS = [
    { id: 'house',     name: 'Brick house',   mat: M_BRICK,    floorMat: M_WOOD,  roofMat: M_TILE,   roof: 'gable', floors: 2, winEvery: 2, rooms: 1 },
    { id: 'townhouse', name: 'Town house',    mat: M_BRICK,    floorMat: M_WOOD,  roofMat: M_TILE,   roof: 'gable', floors: 3, winEvery: 2, rooms: 1 },
    { id: 'farmhouse', name: 'Stone farm',    mat: M_STONE,    floorMat: M_WOOD,  roofMat: M_TILE,   roof: 'hip',   floors: 2, winEvery: 3, rooms: 1 },
    { id: 'timber',    name: 'Timber house',  mat: M_WOOD,     floorMat: M_PLANK, roofMat: M_TILE,   roof: 'gable', floors: 2, winEvery: 2, rooms: 1 },
    { id: 'hut',       name: 'Thatched hut',  mat: M_WOOD,     floorMat: M_PLANK, roofMat: M_THATCH, roof: 'hip',   floors: 1, winEvery: 3, rooms: 0 },
    { id: 'barn',      name: 'Barn',          mat: M_PLANK,    floorMat: M_PLANK, roofMat: M_METAL,  roof: 'gable', floors: 1, winEvery: 0, rooms: 0, tall: true },
    { id: 'warehouse', name: 'Warehouse',     mat: M_BRICK,    floorMat: M_CONCRETE, roofMat: M_METAL, roof: 'gable', floors: 2, winEvery: 2, rooms: 0 },
    { id: 'bunker',    name: 'Concrete works', mat: M_CONCRETE, floorMat: M_CONCRETE, roofMat: M_CONCRETE, roof: 'flat', floors: 2, winEvery: 3, slits: true, rooms: 1 },
    { id: 'ruin',      name: 'Shelled ruin',  mat: M_BRICK,    floorMat: M_WOOD,  roofMat: M_TILE,   roof: 'gable', floors: 2, winEvery: 2, rooms: 1, ruin: 0.72 },
  ];

  /**
   * Build a building. `o.gx/gz` is one corner of the footprint, `o.w/d` its
   * size in cells. Everything else has a sane default; a preset id fills them.
   * Returns the number of pieces laid.
   */
  /** Every storey of a building this size, flooded from its staircase landings;
   *  anything the flood does not reach gets a ladder from the floor below.
   *  Footprint-local, so it costs nothing on a map with no buildings and about
   *  a hundred cell tests on a house. See the note at the call site. */
  Structures.prototype._ensureUpward = function (x0, z0, x1, z1, floors, o) {
    var NB = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    var w = x1 - x0 + 1, d = z1 - z0 + 1, n = w * d;
    for (var L = 1; L < floors; L++) {
      var seen = new Uint8Array(n), q = [], any = false;
      var xx, zz, idx;
      // Seeds: every cell a flight below delivers you onto.
      for (zz = z0; zz <= z1; zz++) for (xx = x0; xx <= x1; xx++) {
        if (!this.standable(xx, zz, L)) continue;
        any = true;
        if (!this.stairFeeds(xx, zz, L)) continue;
        idx = (zz - z0) * w + (xx - x0);
        if (seen[idx]) continue;
        seen[idx] = 1; q.push(xx, zz);
      }
      if (!any) continue;                       // no such storey in this plot
      for (var h = 0; h < q.length; h += 2) {
        var cx = q[h], cz = q[h + 1];
        for (var e = 0; e < 4; e++) {
          var nx = cx + NB[e][0], nz = cz + NB[e][1];
          if (nx < x0 || nz < z0 || nx > x1 || nz > z1) continue;
          var ni = (nz - z0) * w + (nx - x0);
          if (seen[ni] || !this.standable(nx, nz, L)) continue;
          if (!this.canCross(cx, cz, L, NB[e][0], NB[e][1])) continue;
          seen[ni] = 1; q.push(nx, nz);
        }
      }
      // Whatever is left over is a room with no way into it. One ladder each,
      // in a cell that is also standable on the floor below — otherwise the
      // ladder would rise out of thin air.
      for (zz = z0; zz <= z1; zz++) for (xx = x0; xx <= x1; xx++) {
        idx = (zz - z0) * w + (xx - x0);
        if (seen[idx] || !this.standable(xx, zz, L)) continue;
        if (!this.standable(xx, zz, L - 1) || this.feat[this.li(xx, zz, L - 1)]) continue;
        this.setFeature(xx, zz, L - 1, F_LADDER, 0, P_SINGLE, o.stairMat || M_WOOD);
        // …and flood from it, so one ladder serves the whole room rather than
        // every cell of it getting its own.
        seen[idx] = 1;
        var q2 = [xx, zz];
        for (var h2 = 0; h2 < q2.length; h2 += 2) {
          var ax = q2[h2], az = q2[h2 + 1];
          for (var e2 = 0; e2 < 4; e2++) {
            var bx = ax + NB[e2][0], bz = az + NB[e2][1];
            if (bx < x0 || bz < z0 || bx > x1 || bz > z1) continue;
            var bi = (bz - z0) * w + (bx - x0);
            if (seen[bi] || !this.standable(bx, bz, L)) continue;
            if (!this.canCross(ax, az, L, NB[e2][0], NB[e2][1])) continue;
            seen[bi] = 1; q2.push(bx, bz);
          }
        }
      }
    }
  };

  Structures.prototype.build = function (o) {
    o = o || {};
    var pre = null;
    if (o.preset) for (var pi = 0; pi < PRESETS.length; pi++) if (PRESETS[pi].id === o.preset) pre = PRESETS[pi];
    if (pre) for (var key in pre) if (o[key] === undefined && key !== 'id' && key !== 'name') o[key] = pre[key];

    var x0 = Math.min(o.gx, o.gx + o.w - 1), z0 = Math.min(o.gz, o.gz + o.d - 1);
    var w = Math.max(1, Math.abs(o.w | 0)), d = Math.max(1, Math.abs(o.d | 0));
    x0 = Math.max(0, Math.min(G.GRID - w, x0)); z0 = Math.max(0, Math.min(G.GRID - d, z0));
    var x1 = x0 + w - 1, z1 = z0 + d - 1;
    var floors = Math.max(1, Math.min(LEVELS, o.floors || 2));
    var mat = o.mat || M_BRICK, fmat = o.floorMat || M_WOOD, rmat = o.roofMat || M_TILE;
    var winEvery = o.winEvery === undefined ? 2 : o.winEvery;
    var rnd = rngFrom(o.seed || (x0 * 7919 + z0 * 104729 + 13));
    var laid = 0;

    // ---- A BLOCK, NOT ONE BUILDING (round 106) ------------------------------
    // The maps size a building in cells as if a cell were about a metre ("a
    // farmhouse is eight metres by six") and a cell is SIX: over the 100 maps
    // the median building is 6 x 5 cells, 36 x 30 m, the town helper's plots
    // 7-10 x 5-7. The diorama drew a storey 8.8 m tall and hid it — a 36 m
    // block with 17 m walls reads as a house. At three metres a storey it read
    // as a warehouse: one roof rising 6 m over 30 m of depth, a window every
    // 12 m. What a plot that size held was a BLOCK: houses 12 m deep along its
    // edges round an open yard — terraced in a town, the farmhouse and its
    // barns round a cour carree on a farm — or a row of them, back to back at
    // 24 m (`_buildBlock`). Only what a MAP asks for (`o.block`, the map
    // helper's), only at true scale (the diorama keeps its old town to the
    // byte), and never a building the map names as one (`court: false`).
    if (o.block && !o._part && o.court !== false && S !== 1 && window.Structures.blocks !== false) {
      var blk = this._buildBlock(o, x0, z0, w, d, floors, rnd);
      if (blk >= 0) return blk;
    }

    // ---- the plot ---------------------------------------------------------
    // A building stands on level ground. Take the HIGHEST corner so nothing
    // floats, flatten the terrain to it, and pin every column's footing there.
    var hMax = -Infinity;
    for (var gz = z0; gz <= z1; gz++) for (var gx = x0; gx <= x1; gx++) hMax = Math.max(hMax, this.terrain.height(gx, gz));
    if (o.flatten !== false && this.game && this.game._structureFlatten) this.game._structureFlatten(x0, z0, w, d, hMax);
    var baseY = hMax * G.HSCALE;
    this._ensure();
    for (var gz2 = z0; gz2 <= z1; gz2++) for (var gx2 = x0; gx2 <= x1; gx2++) {
      this.mask[this.ci(gx2, gz2)] = 1; this.baseY[this.ci(gx2, gz2)] = baseY;
      this.bid[this.ci(gx2, gz2)] = 1 + (((x0 * 7919 + z0 * 104729) >>> 0) % 255);   // one house, one set of colours
      this.look[this.ci(gx2, gz2)] = o.look || 0;
    }
    this.any = true;

    // ---- door: middle of one wall, on the ground floor --------------------
    var doorEdge = o.doorEdge === undefined ? [0, 1, 2, 3][(rnd() * 4) | 0] : o.doorEdge;
    var doorCell = null;
    if (doorEdge === 0 || doorEdge === 2) doorCell = { x: x0 + ((w / 2) | 0), z: doorEdge === 0 ? z0 : z1 };
    else doorCell = { x: doorEdge === 3 ? x0 : x1, z: z0 + ((d / 2) | 0) };

    // ---- shell: perimeter walls, windows, floors --------------------------
    for (var L = 0; L < floors; L++) {
      for (var gz3 = z0; gz3 <= z1; gz3++) for (var gx3 = x0; gx3 <= x1; gx3++) {
        if (L > 0) { this.setFloor(gx3, gz3, L, fmat); laid++; }
        for (var e = 0; e < 4; e++) {
          var dd = EDGE_D[e], nx = gx3 + dd[0], nz = gz3 + dd[1];
          if (nx >= x0 && nx <= x1 && nz >= z0 && nz <= z1) continue;      // interior surface
          var kind = K_SOLID;
          if (L === 0 && gx3 === doorCell.x && gz3 === doorCell.z && e === doorEdge) kind = K_DOOR;
          else if (winEvery > 0) {
            // Windows on a rhythm, never in a corner — a corner window looks
            // wrong and a corner is where the load goes.
            var along = (e === 0 || e === 2) ? (gx3 - x0) : (gz3 - z0);
            var span = (e === 0 || e === 2) ? w : d;
            var corner = (along === 0 || along === span - 1) && span > 2 && !o.winCorners;
            if (!corner && (along % winEvery === (winEvery > 1 ? 1 : 0))) kind = K_WINDOW;
          }
          // A PARTY WALL HAS NO WINDOWS (round 106). Where the house next door
          // already stands on this edge, a window opened onto its floor slab
          // at whatever level that house was built: 2.4% of the windows seen
          // through, all in the walls two houses share. A door stays — houses
          // in a street were knocked through, and the pathing uses them.
          if (kind === K_WINDOW && this.wallM[this.li(gx3, gz3, L) * 4 + e] && this.inb(nx, nz, L) && this.mask[nz * G.GRID + nx]) kind = K_SOLID;
          this.setWall(gx3, gz3, L, e, mat, kind); laid++;
        }
      }
    }

    // ---- the back door, onto the yard (a block's house) ---------------------
    // In the middle of the wall opposite the street door, where nothing stands
    // across it — the house next door built later makes a shared wall solid.
    if (o.backDoor) {
      var bEdge = (doorEdge + 2) % 4, bd = EDGE_D[bEdge];
      var bx = (bEdge === 0 || bEdge === 2) ? x0 + ((w / 2) | 0) : (bEdge === 3 ? x0 : x1);
      var bz = (bEdge === 0 || bEdge === 2) ? (bEdge === 0 ? z0 : z1) : z0 + ((d / 2) | 0);
      var bnx = bx + bd[0], bnz = bz + bd[1];
      // a HOUSE across it, not `mask`: a yard cell has mask as soon as the
      // first wing's wall is drawn from it, and every yard door went missing
      var bni = bnz * G.GRID + bnx;
      if (!(bnx >= 0 && bnz >= 0 && bnx < G.GRID && bnz < G.GRID && this.mask[bni] && this.bid[bni])) {
        this.setWall(bx, bz, 0, bEdge, mat, K_DOOR); laid++;
      }
    }

    // ---- interior partitions: recursive splits, one doorway each ----------
    if (o.rooms && w >= 4 && d >= 4) {
      var self = this;
      var split = function (ax, az, bx, bz, depth) {
        var ww = bx - ax + 1, dd2 = bz - az + 1;
        if (depth > 2 || (ww < 5 && dd2 < 5)) return;
        var vertical = (ww >= dd2);
        if (vertical && ww < 5) vertical = false;
        if (!vertical && dd2 < 5) vertical = true;
        if (vertical) {
          var cut = ax + 1 + ((rnd() * (ww - 3)) | 0);           // wall between cut and cut+1
          var door = az + ((rnd() * dd2) | 0);
          for (var z = az; z <= bz; z++) {
            for (var L2 = 0; L2 < floors; L2++) self.setWall(cut, z, L2, 1, mat, z === door ? K_DOOR : K_SOLID);
            laid += floors;
          }
          split(ax, az, cut, bz, depth + 1); split(cut + 1, az, bx, bz, depth + 1);
        } else {
          var cutz = az + 1 + ((rnd() * (dd2 - 3)) | 0);
          var doorx = ax + ((rnd() * ww) | 0);
          for (var x = ax; x <= bx; x++) {
            for (var L3 = 0; L3 < floors; L3++) self.setWall(x, cutz, L3, 2, mat, x === doorx ? K_DOOR : K_SOLID);
            laid += floors;
          }
          split(ax, az, bx, cutz, depth + 1); split(ax, cutz + 1, bx, bz, depth + 1);
        }
      };
      split(x0, z0, x1, z1, 0);
    }

    // ---- stairs -----------------------------------------------------------
    // One flight per storey, stacked in the same well, with the slab over the
    // flight left OUT — that hole is what makes it a staircase rather than a
    // ramp into a ceiling. Every wall the flight and its landing need is opened.
    if (floors > 1 && o.stairs !== false && w >= 2 && d >= 2) {
      var sdir = (w >= d) ? 1 : 2;                    // climb east on wide plans, south on deep ones
      // NOT ACROSS A DOORWAY (round 106). The flight started in the middle of
      // the west (or north) wall, and the front door is in the middle of a
      // random wall: in a quarter of the houses the first treads were laid
      // across it — 2.7% of every door in the game opened onto a staircase's
      // foot (seen through, all 15,211 of them). The flight takes the first
      // place, of its own wall and the far one at the middle and the
      // quarters, whose cell has no doorway on any side but the landing's.
      var self2 = this, nearWall = sdir === 1 ? x0 : z0, farWall = sdir === 1 ? x1 : z1, span = sdir === 1 ? d : w;
      var along0 = sdir === 1 ? z0 : x0, picks = [];
      [(span / 2) | 0, (span / 4) | 0, ((3 * span) / 4) | 0].forEach(function (k) {
        picks.push([sdir, nearWall, along0 + k]); picks.push([sdir === 1 ? 3 : 0, farWall, along0 + k]);
      });
      var clear = function (dirC, cx2, cz2) {
        // every storey of the well: a flight's foot, or the hole above it
        for (var Lc = 0; Lc < floors; Lc++) for (var ec = 0; ec < 4; ec++) {
          if (ec === dirC) continue;                   // the landing's side is opened anyway
          if (self2.wallMat(cx2, cz2, Lc, ec) && self2.wallKind(cx2, cz2, Lc, ec) === K_DOOR) return false;
        }
        return true;
      };
      var sx = (sdir === 1) ? x0 : x0 + ((w / 2) | 0);
      var sz = (sdir === 1) ? z0 + ((d / 2) | 0) : z0;
      for (var pk = 0; pk < picks.length; pk++) {
        var pd = picks[pk][0], px2 = (pd === 1 || pd === 3) ? picks[pk][1] : picks[pk][2], pz2 = (pd === 1 || pd === 3) ? picks[pk][2] : picks[pk][1];
        var ld2 = EDGE_D[pd];
        if (px2 + ld2[0] < x0 || px2 + ld2[0] > x1 || pz2 + ld2[1] < z0 || pz2 + ld2[1] > z1) continue;
        if (clear(pd, px2, pz2)) { sdir = pd; sx = px2; sz = pz2; break; }
      }
      var sd = EDGE_D[sdir];
      if (sx + sd[0] > x1) sx = x1 - 1;
      if (sz + sd[1] > z1) sz = z1 - 1;
      if (sx + sd[0] < x0) sx = x0 + 1;
      if (sz + sd[1] < z0) sz = z0 + 1;
      var lx = sx + sd[0], lz = sz + sd[1];
      for (var L4 = 0; L4 < floors - 1; L4++) {
        this.setFeature(sx, sz, L4, F_STAIR, sdir, P_SINGLE, o.stairMat || M_WOOD); laid++;
        this.setFloor(sx, sz, L4 + 1, 0);                       // open the stairwell
        this.setWall(sx, sz, L4, sdir, 0, 0);                   // nothing between flight and landing
        this.setWall(sx, sz, L4 + 1, sdir, 0, 0);
        this.setFloor(lx, lz, L4 + 1, fmat);                    // the landing you step onto
      }
    }

    // ---- roof -------------------------------------------------------------
    var top = floors - 1;
    var style = o.roof || 'gable';
    if (style !== 'none') {
      for (var gz4 = z0; gz4 <= z1; gz4++) for (var gx4 = x0; gx4 <= x1; gx4++) {
        var shape = R_FLAT, rank = 0;
        if (style === 'flat') { shape = R_FLAT; }
        else if (style === 'shed') {
          var dEdge = EDGE_D[doorEdge];
          rank = (doorEdge === 0 || doorEdge === 2) ? (doorEdge === 0 ? (gz4 - z0) : (z1 - gz4)) : (doorEdge === 3 ? (gx4 - x0) : (x1 - gx4));
          shape = doorEdge + 1;
        } else if (style === 'hip') {
          var dn = gz4 - z0, ds = z1 - gz4, de = x1 - gx4, dw = gx4 - x0;
          var mn = Math.min(dn, ds, de, dw);
          rank = mn;
          shape = (mn === dn) ? R_SLOPE_N : (mn === ds) ? R_SLOPE_S : (mn === de) ? R_SLOPE_E : R_SLOPE_W;
          // On an EVEN span the two middle rows are one cell apart and never
          // equal, so a strict test gives a hip roof with no ridge at all —
          // a truncated pyramid. Allow the pair, which is what a hipped roof
          // on an even-width building actually has: a short flat ridge.
          var ridgeX = (w >= d);
          if (ridgeX ? (mn === dn && Math.abs(dn - ds) <= 1) : (mn === dw && Math.abs(dw - de) <= 1)) {
            shape = ridgeX ? R_RIDGE_X : R_RIDGE_Z;
          }
        } else {                       // gable: ridge along the longer axis
          // A block's house (round 106) runs its ridge along the street it
          // fronts (`o.ridge`), and on an EVEN span — a house two cells deep —
          // its two middle rows are slopes meeting at the ridge line: two
          // ridge cells side by side drew two little roofs and a valley.
          var even = o._part ? 0 : 1;
          if (o.ridge ? o.ridge === 'x' : w >= d) {
            var dn2 = gz4 - z0, ds2 = z1 - gz4;
            rank = Math.min(dn2, ds2);
            shape = (Math.abs(dn2 - ds2) <= even) ? R_RIDGE_X : (dn2 < ds2 ? R_SLOPE_N : R_SLOPE_S);
          } else {
            var dw2 = gx4 - x0, de2 = x1 - gx4;
            rank = Math.min(dw2, de2);
            shape = (Math.abs(dw2 - de2) <= even) ? R_RIDGE_Z : (dw2 < de2 ? R_SLOPE_W : R_SLOPE_E);
          }
        }
        // The triangle between the eaves and the ridge is drawn from the roof
        // cell itself (see `emitGable`) — it is not a wall, because a wall is
        // one storey tall by definition and this one is not.
        this.setRoof(gx4, gz4, top, rmat, shape, Math.min(7, rank)); laid++;
      }
    }

    // ---- make sure every storey is one connected space --------------------
    // The partitioner puts one doorway in each wall it raises, which is enough
    // on its own. It stops being enough once the stairs cut a hole in the floor
    // above: if that hole lands where a doorway was, the storey silently comes
    // apart into two rooms with no way between them, and half of a building the
    // player just placed is unreachable. Rather than special-case the stair
    // position, check the finished article and open whatever is still shut.
    for (var Lc = 0; Lc < floors; Lc++) laid += this.connectFloor(x0, z0, x1, z1, Lc, mat);

    // ---- shelled ----------------------------------------------------------
    // A HOUSE OF A BLOCK (round 106) is two cells across: its joists span
    // wall to wall and its floors held where a hall's long spans came down —
    // and shelled at the hall's rate, a 2 x 2 house's upper storey came apart
    // into single cells no ladder could reach (Berlin, Pavlov's House)
    if (o.ruin > 0) this.ruinate(x0, z0, w, d, o.ruin, rnd, o._part ? 0.6 : 1);

    // ---- AND A WAY UP TO EVERY PART OF EVERY FLOOR ------------------------
    //
    // ONE FLIGHT PER BUILDING IS NOT ONE FLIGHT PER FLOOR. The block above
    // stacks a single stair well and opens the two walls it needs; everything
    // the room partition then cut off from that landing is an upper storey with
    // no way into it. Measured on Berlin — the Zoo Flak Tower, flood-filling
    // every standable first-floor cell: **608 separate regions, 80 with a
    // staircase and 528 without** — 2,240 orphaned cells against 1,909
    // reachable, and 1,525 firing positions nobody could ever occupy against
    // 867 that could. The AI was choosing among all of them by how good the
    // window looked, so two choices in three were a window it could see and
    // never reach; it walked as far as the route went, stopped in the street
    // and stood there.
    //
    // The fix is additive and cannot alter a building that was already right:
    // flood from the landings, and for each region left over, put a LADDER in
    // the cell of it that is also standable on the floor below. A ladder rises
    // inside its own cell, so it needs no landing, no wall opened and no room —
    // which is the only reason it can be dropped into a finished plan. It is
    // also what an attic actually had.
    //
    // IT RUNS LAST, AFTER `connectFloor` AND AFTER `ruinate`, and the order is
    // the whole thing. `connectFloor` already opens doorways until a storey is
    // internally walkable — and then `ruinate` shells the building and breaks
    // it again. Placed before them, this pass fixed a plan that was about to be
    // knocked down: Berlin, which is built entirely of `ruin` presets, stayed
    // at 35% reachable while every intact map went to 84-100%. A ruin keeps its
    // broken walls, its holed floors and its fallen roof; what it does not keep
    // is a first storey that the men who fought in Berlin and Ortona could
    // never have climbed to.
    if (floors > 1) this._ensureUpward(x0, z0, x1, z1, floors, o);
    if (!o._noFlush) this.flush();
    return laid;
  };

  // ---- A BLOCK ------------------------------------------------------------
  // What a plot bigger than a house held, by what the map asked for (see the
  // note at the head of `build`): `terrace` — houses two or three cells wide,
  // a street door and a yard door each, a window in every bay, a storey more
  // or less than the next; `farm` — the farmhouse on the side of the door and
  // its barns round the yard, stone or timber, tile or thatch; `hall` —
  // warehouse halls of three to five cells; `hut` — the cell or two at the
  // plot's middle. A plot five cells or more both ways is a RING two cells
  // (12 m) deep round an open yard, entered by a gate a cell wide; three or
  // four deep, one row or two back to back. Each house is a whole building —
  // its own walls, stairs, roof and colours — and the yard is open ground.
  var BLOCK_KIND = { house: 'terrace', townhouse: 'terrace', timber: 'terrace', ruin: 'terrace',
                     farmhouse: 'farm', barn: 'farm', warehouse: 'hall', hut: 'hut' };
  var WING = 2;
  function runs(n, mn, mx, rnd) {
    var out = [];
    while (n > 0) {
      if (n <= mx) { out.push(n); break; }
      var k = mn + ((rnd() * (mx - mn + 1)) | 0);
      if (n - k < mn) k = n - mn;
      out.push(k); n -= k;
    }
    return out;
  }
  Structures.prototype._buildBlock = function (o, x0, z0, w, d, floors, rnd) {
    var kind = BLOCK_KIND[o.preset || 'house'];
    if (!kind) return -1;
    if (kind === 'hut' ? (w <= 2 && d <= 2) : (Math.min(w, d) < 3 && Math.max(w, d) < 4)) return -1;
    var x1 = x0 + w - 1, z1 = z0 + d - 1, laid = 0, self = this;
    // the plot levelled once at its highest corner, as the one building was
    var hMax = -Infinity;
    for (var gz = z0; gz <= z1; gz++) for (var gx = x0; gx <= x1; gx++) hMax = Math.max(hMax, this.terrain.height(gx, gz));
    if (o.flatten !== false && this.game && this.game._structureFlatten) this.game._structureFlatten(x0, z0, w, d, hMax);
    var part = function (px, pz, pw, pd, x) {
      var p = { gx: px, gz: pz, w: pw, d: pd, preset: o.preset, floors: floors, seed: (rnd() * 4294967296) >>> 0,
                _part: true, _noFlush: true, flatten: false, rooms: 0, roof: 'gable', look: 1 + ((rnd() * 251) | 0) };
      if (o.ruin !== undefined) p.ruin = o.ruin;
      for (var k in x) p[k] = x[k];
      laid += self.build(p);
    };
    if (kind === 'hut') {
      var hw = Math.min(2, w), hd = Math.min(2, d);
      part(x0 + ((w - hw) >> 1), z0 + ((d - hd) >> 1), hw, hd, { doorEdge: o.doorEdge, roof: 'hip', look: 0 });
      if (!o._noFlush) this.flush();
      return laid;
    }
    // [gx, gz, w, d, the street's edge, runs along x]
    var strips = [], ring = w >= 2 * WING + 1 && d >= 2 * WING + 1;
    if (ring) {
      strips.push([x0, z0, w, WING, 0, true], [x0, z1 - WING + 1, w, WING, 2, true],
                  [x0, z0 + WING, WING, d - 2 * WING, 3, false], [x1 - WING + 1, z0 + WING, WING, d - 2 * WING, 1, false]);
    } else if (w >= d) {
      if (d >= 4) strips.push([x0, z0, w, WING, 0, true], [x0, z0 + WING, w, d - WING, 2, true]);
      else strips.push([x0, z0, w, d, o.doorEdge === 2 ? 2 : 0, true]);
    } else {
      if (w >= 4) strips.push([x0, z0, WING, d, 3, false], [x0 + WING, z0, w - WING, d, 1, false]);
      else strips.push([x0, z0, w, d, o.doorEdge === 1 ? 1 : 3, false]);
    }
    // the gate into the yard: a cell of the wing on the door's side (the south
    // if none), clear of the corners
    // ON A SLOPE the plot is levelled to its highest corner, and the street
    // below a downhill wing can be further down than a man climbs: the gate
    // goes in the wing whose street is the gentlest step, at its gentlest cell
    var climb = (this.game && this.game.pathfinder && this.game.pathfinder.climbMax) || 2.2;
    var stepOut = function (gx, gz, e) {
      var dd = EDGE_D[e], ox = gx + dd[0], oz = gz + dd[1];
      if (ox < 0 || oz < 0 || ox >= G.GRID || oz >= G.GRID) return Infinity;
      return Math.abs(self.terrain.height(ox, oz) - hMax);
    };
    var gateS = -1, gateAt = -1;
    if (ring) {
      var bestG = Infinity;
      for (var si = 0; si < strips.length; si++) {
        var sg = strips[si], sl = sg[5] ? sg[2] : sg[3], sm = sg[5] ? WING : 0;
        for (var k2 = sm; k2 <= sl - 1 - sm; k2++) {
          // the street's step at this cell (a W/E wing's own cell; a N/S wing's
          // street side), the map's door side first on a tie
          var cx2 = sg[5] ? sg[0] + k2 : (sg[4] === 3 ? sg[0] : sg[0] + WING - 1);
          var cz2 = sg[5] ? (sg[4] === 0 ? sg[1] : sg[1] + WING - 1) : sg[1] + k2;
          var stp = stepOut(cx2, cz2, sg[4]) + (sg[4] === o.doorEdge ? 0 : 0.01) + k2 * 1e-4;
          if (stp < bestG) { bestG = stp; gateS = si; gateAt = k2; }
        }
      }
    }
    var built = [];
    // the farmhouse is on the side of the door; the rest of a farm is barns
    var mainS = o.preset === 'farmhouse' ? 0 : -1;
    if (mainS === 0) for (var sj = 0; sj < strips.length; sj++) if (strips[sj][4] === o.doorEdge) mainS = sj;
    for (var s = 0; s < strips.length; s++) {
      var st = strips[s], ax = st[5], len = ax ? st[2] : st[3];
      var street = st[4], ridge = ax ? 'x' : 'z';
      var cut = (s === gateS && gateAt >= 0) ? [[0, gateAt], [gateAt + 1, len]] : [[0, len]];
      var houseDone = false;
      for (var r = 0; r < cut.length; r++) {
        var a = cut[r][0], n = cut[r][1] - a;
        if (n <= 0) continue;
        var units = kind === 'terrace' ? runs(n, 2, 3, rnd) : runs(n, 3, 5, rnd);
        for (var u = 0, at = a; u < units.length; at += units[u], u++) {
          var ul = units[u];
          var px = ax ? st[0] + at : st[0], pz = ax ? st[1] : st[1] + at;
          var pw = ax ? ul : st[2], pd = ax ? st[3] : ul;
          built.push([px, pz, pw, pd]);
          if (kind === 'terrace') {
            part(px, pz, pw, pd, { doorEdge: street, backDoor: true, ridge: ridge, winEvery: 1, winCorners: true,
              floors: Math.max(1, floors - (floors > 1 && rnd() < 0.3 ? 1 : 0)) });
          } else if (kind === 'hall') {
            part(px, pz, pw, pd, { doorEdge: street, backDoor: true, ridge: ridge, winCorners: true });
          } else if (s === mainS && !houseDone) {
            houseDone = true;
            part(px, pz, pw, pd, { preset: 'farmhouse', doorEdge: street, backDoor: true, ridge: ridge, winEvery: 1, winCorners: true });
          } else {
            // a barn or a byre: one storey, a door out and one onto the yard.
            // Not the yard's alone: a corner barn's yard side is the next wing,
            // and two rows back to back face each other — doors there were
            // walled up by the next building and the barn had no way in.
            part(px, pz, pw, pd, { preset: 'barn', floors: 1, doorEdge: street, backDoor: true, ridge: ridge,
              mat: rnd() < 0.55 ? M_STONE : M_PLANK, roofMat: rnd() < 0.7 ? M_TILE : M_THATCH });
          }
        }
      }
    }
    // A DOOR A MAN CAN CLIMB TO. Each house's street door was laid on its
    // street, and a downhill street can be a cliff from it: a house with no
    // ground-floor door that opens onto open ground within a man's climb gets
    // one, in its outside wall with the gentlest step.
    for (var bi = 0; bi < built.length; bi++) {
      var hb = built[bi], ok = false, best = null, bestStep = Infinity;
      for (var hz = hb[1]; hz < hb[1] + hb[3]; hz++) for (var hx = hb[0]; hx < hb[0] + hb[2]; hx++) {
        for (var he = 0; he < 4; he++) {
          var hd2 = EDGE_D[he], qx = hx + hd2[0], qz = hz + hd2[1];
          if (qx >= hb[0] && qx < hb[0] + hb[2] && qz >= hb[1] && qz < hb[1] + hb[3]) continue;   // inside the house
          if (qx < 0 || qz < 0 || qx >= G.GRID || qz >= G.GRID) continue;
          var qi = qz * G.GRID + qx;
          if (this.mask[qi] && this.bid[qi]) continue;                   // the next house
          if (!this.wallMat(hx, hz, 0, he)) continue;
          var hs = stepOut(hx, hz, he);
          if (this.wallKind(hx, hz, 0, he) === K_DOOR && hs <= climb) ok = true;
          if (hs < bestStep) { bestStep = hs; best = [hx, hz, he]; }
        }
      }
      if (!ok && best && bestStep <= climb) {
        this.setWall(best[0], best[1], 0, best[2], this.wallMat(best[0], best[1], 0, best[2]), K_DOOR); laid++;
      }
    }
    // NO WINDOW LOOKS INTO THE NEXT HOUSE. A house's windows were laid before
    // the house behind it stood, and the party-wall rule sees only a wall at
    // the same storey: where two rows stand back to back, or two wings meet,
    // the taller house kept its upper back windows over the lower one's roof,
    // the roof's slope across them. Every storey of a wall between two houses
    // is blank.
    for (var wi = 0; wi < built.length; wi++) {
      var wb = built[wi];
      for (var wz = wb[1]; wz < wb[1] + wb[3]; wz++) for (var wx = wb[0]; wx < wb[0] + wb[2]; wx++) {
        for (var wL = 0; wL < LEVELS; wL++) for (var we = 0; we < 4; we++) {
          if (!this.wallMat(wx, wz, wL, we) || this.wallKind(wx, wz, wL, we) !== K_WINDOW) continue;
          var wd = EDGE_D[we], ax2 = wx + wd[0], az2 = wz + wd[1];
          if (ax2 >= wb[0] && ax2 < wb[0] + wb[2] && az2 >= wb[1] && az2 < wb[1] + wb[3]) continue;
          if (ax2 < 0 || az2 < 0 || ax2 >= G.GRID || az2 >= G.GRID) continue;
          var ai2 = az2 * G.GRID + ax2;
          if (this.mask[ai2] && this.bid[ai2]) this.setWall(wx, wz, wL, we, this.wallMat(wx, wz, wL, we), K_SOLID);
        }
      }
    }
    if (!o._noFlush) this.flush();
    return laid;
  };

  /**
   * Open doorways until every square of one storey can be walked to from every
   * other. Returns the number of doors it had to add — normally 0.
   */
  Structures.prototype.connectFloor = function (x0, z0, x1, z1, L, mat) {
    var cells = [], key = {};
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      if (!this.standable(x, z, L)) continue;
      if (L > 0 && !this.floorMat(x, z, L) && !this.feat[this.li(x, z, L)]) continue;
      cells.push([x, z]); key[x + ',' + z] = true;
    }
    if (cells.length < 2) return 0;
    var self = this;
    var flood = function (sx, sz) {
      var seen = {}, stack = [[sx, sz]];
      seen[sx + ',' + sz] = 1;
      while (stack.length) {
        var c = stack.pop();
        for (var e = 0; e < 4; e++) {
          var d = EDGE_D[e], nx = c[0] + d[0], nz = c[1] + d[1];
          if (!key[nx + ',' + nz] || seen[nx + ',' + nz]) continue;
          if (self.edgeBlocks(c[0], c[1], L, e)) continue;
          seen[nx + ',' + nz] = 1; stack.push([nx, nz]);
        }
      }
      return seen;
    };
    var opened = 0, guard = 0;
    while (guard++ < 40) {
      var seen = flood(cells[0][0], cells[0][1]);
      var n = 0;
      for (var k in seen) n++;
      if (n >= cells.length) break;
      var punched = false;
      for (var i = 0; i < cells.length && !punched; i++) {
        var c = cells[i];
        if (seen[c[0] + ',' + c[1]]) continue;
        for (var e2 = 0; e2 < 4; e2++) {
          var d2 = EDGE_D[e2], nx2 = c[0] + d2[0], nz2 = c[1] + d2[1];
          if (!seen[nx2 + ',' + nz2]) continue;
          var m = this.wallMat(c[0], c[1], L, e2);
          if (!m) continue;
          this.setWall(c[0], c[1], L, e2, m, K_DOOR);
          opened++; punched = true; break;
        }
      }
      if (!punched) break;      // cut off by a hole in the floor, not by a wall
    }
    return opened;
  };

  /** Knock a finished building about: the difference between a suburb and a
   *  front line. Masonry goes to rubble, roofs and upper floors go entirely. */
  Structures.prototype.ruinate = function (x0, z0, w, d, amount, rnd, floorMul) {
    rnd = rnd || Math.random;
    floorMul = floorMul || 1;
    for (var gz = z0; gz < z0 + d; gz++) for (var gx = x0; gx < x0 + w; gx++) {
      if (!this.has(gx, gz)) continue;
      for (var L = 0; L < LEVELS; L++) {
        var i = this.li(gx, gz, L);
        var lift = 1 + L * 0.45;                      // the top of a building goes first
        if (this.roofM[i] && rnd() < amount * 0.85) this.setRoof(gx, gz, L, 0, 0, 0);
        if (this.floorM[i] && rnd() < amount * 0.4 * lift * floorMul) this.setFloor(gx, gz, L, 0);
        for (var e = 0; e < 4; e++) {
          var m = this.wallM[i * 4 + e];
          if (!m) continue;
          var r = rnd();
          if (r < amount * 0.32 * lift) {
            if (MATS[m].ruin) { this.setWall(gx, gz, L, e, m, K_RUBBLE); this.wallH[i * 4 + e] = 110; }
            else this.setWall(gx, gz, L, e, 0, 0);
          } else if (r < amount * 0.5 * lift) {
            this.wallH[i * 4 + e] = 60 + ((rnd() * 90) | 0);   // battered but standing
            this.markDirty(gx, gz);
          }
        }
      }
    }
  };

  /** Draw a run of wall between two cells — the editor's line tool, and how a
   *  compound wall or a garden enclosure gets made without a building.
   *
   *  A run of wall is a run of SURFACES that lie ALONG the drag, so a drag east
   *  lays the north edge of every cell it crosses and a drag south lays the
   *  west edge. Deterministic, so dragging back over a wall erases the same
   *  surfaces it drew. */
  Structures.prototype.wallLine = function (gx0, gz0, gx1, gz1, L, mat, kind) {
    var dx = gx1 - gx0, dz = gz1 - gz0;
    var n = Math.max(Math.abs(dx), Math.abs(dz));
    var side = (Math.abs(dx) >= Math.abs(dz)) ? 0 : 3;     // N for E-W runs, W for N-S runs
    var laid = 0;
    for (var i = 0; i <= n; i++) {
      var t = n ? i / n : 0;
      var cx = Math.round(gx0 + dx * t), cz = Math.round(gz0 + dz * t);
      if (this.setWall(cx, cz, L, side, mat, kind || K_SOLID)) laid++;
    }
    return laid;
  };

  /** Perimeter of a dragged rectangle: an enclosure, a compound, a courtyard. */
  Structures.prototype.wallRect = function (gx0, gz0, gx1, gz1, L, mat, kind) {
    var x0 = Math.min(gx0, gx1), x1 = Math.max(gx0, gx1);
    var z0 = Math.min(gz0, gz1), z1 = Math.max(gz0, gz1);
    var laid = 0;
    for (var x = x0; x <= x1; x++) {
      if (this.setWall(x, z0, L, 0, mat, kind || K_SOLID)) laid++;
      if (this.setWall(x, z1, L, 2, mat, kind || K_SOLID)) laid++;
    }
    for (var z = z0; z <= z1; z++) {
      if (this.setWall(x0, z, L, 3, mat, kind || K_SOLID)) laid++;
      if (this.setWall(x1, z, L, 1, mat, kind || K_SOLID)) laid++;
    }
    return laid;
  };

  /** Fill a dragged rectangle with floor slabs (a storey, a platform, a yard). */
  Structures.prototype.floorRect = function (gx0, gz0, gx1, gz1, L, mat) {
    var x0 = Math.min(gx0, gx1), x1 = Math.max(gx0, gx1);
    var z0 = Math.min(gz0, gz1), z1 = Math.max(gz0, gz1);
    var laid = 0;
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) { this.setFloor(x, z, L, mat); laid++; }
    return laid;
  };

  /** Which cell edge a world point is nearest to — how the editor turns a click
   *  into "this surface" instead of "this cell". Returns {gx,gz,e,inset}. */
  Structures.prototype.pickEdge = function (wx, wz) {
    var gx = G.worldToCell(wx), gz = G.worldToCell(wz);
    var fx = (wx - (G.cellCenter(gx) - T * 0.5)) / T;      // 0..1 inside the cell
    var fz = (wz - (G.cellCenter(gz) - T * 0.5)) / T;
    var dN = fz, dS = 1 - fz, dW = fx, dE = 1 - fx;
    var m = Math.min(dN, dS, dW, dE);
    var e = (m === dN) ? 0 : (m === dE) ? 1 : (m === dS) ? 2 : 3;
    return { gx: gx, gz: gz, e: e, inset: m };
  };

  // =========================================================================
  // MODULE
  // =========================================================================

  window.Structures = {
    VERSION: VERSION,
    LEVELS: LEVELS, FLOOR_H: FLOOR_H, WALL_TH: WALL_TH, ROOF_RISE: ROOF_RISE, CHUNK: CHUNK,
    /** The field changed size (Normandy's mutable GRID). Instances then need
     *  `resize(n)` of their own; this keeps the module's own view in step. */
    setGrid: function (n) { if (G) G.GRID = n; },
    MATS: MATS, PRESETS: PRESETS, EDGE_D: EDGE_D, HOUSE_LOOK: HOUSE_LOOK,
    DRESS: DRESS,
    KIT: KIT,            // (round 113) the Blender chimneys and doors (KIT.on = false, then rebuild)
    /** A map's big plots built as blocks of houses (`_buildBlock`): false, and
     *  a reload, gives the one building per plot back. */
    blocks: true,
    /** (round 115) a round is tested against a wall where it crosses it
     *  (`_rayCross`); false: at the next sample, as before */
    exactRay: true,
    FIRE_RATE: FIRE_RATE,    // (round 115) the pace of a house fire (`_fireK`, `heatAt`)
    K_SOLID: K_SOLID, K_DOOR: K_DOOR, K_WINDOW: K_WINDOW, K_RUBBLE: K_RUBBLE, K_ARCH: K_ARCH,
    K_BREACH: K_BREACH, HOLE_COLS: HOLE_COLS, HOLE_ROWS: HOLE_ROWS, HOLE_FALL: HOLE_FALL, EDGE_BLAST: EDGE_BLAST,
    R_FLAT: R_FLAT, R_RIDGE_X: R_RIDGE_X, R_RIDGE_Z: R_RIDGE_Z,
    F_STAIR: F_STAIR, F_RAMP: F_RAMP, F_LADDER: F_LADDER,
    P_SINGLE: P_SINGLE, P_LOW: P_LOW, P_HIGH: P_HIGH,
    M_WOOD: M_WOOD, M_PLANK: M_PLANK, M_THATCH: M_THATCH, M_BRICK: M_BRICK,
    M_STONE: M_STONE, M_CONCRETE: M_CONCRETE, M_TILE: M_TILE, M_METAL: M_METAL, M_GLASS: M_GLASS,

    /** Hand the module the game's internals. Idempotent. */
    install: function (deps) {
      if (installed) return true;
      THREE = deps.THREE;
      G = deps;
      T = deps.TILE;
      // True scale: the storey, the wall and the slab, once (see `S`).
      if (deps.K_BLD && deps.K_BLD !== 1) {
        S = deps.K_BLD;
        FLOOR_H *= S; WALL_TH *= S; FLOOR_TH *= S; ROOF_H *= S;
        window.Structures.FLOOR_H = FLOOR_H; window.Structures.WALL_TH = WALL_TH; window.Structures.S = S;
        PAIR = true; window.Structures.windowPairs = true;
      }
      _m4 = new THREE.Matrix4(); _eu = new THREE.Euler(); _v3 = new THREE.Vector3();
      installed = true;
      return true;
    },
    create: function (scene, terrain, opts) {
      if (!installed) throw new Error('Structures.install() first');
      return new Structures(scene, terrain, opts);
    },
    /** Material index by id string, for the editor's palette. */
    matId: function (id) {
      for (var i = 1; i < MATS.length; i++) if (MATS[i].id === id) return i;
      return 0;
    },
  };
})();
