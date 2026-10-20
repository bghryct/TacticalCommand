/* ===========================================================================
 * TCM — Tactical Command Model runtime  (THE FORGE, Phase 0)
 * ---------------------------------------------------------------------------
 * Turns a plain-JSON model document into a THREE.Group that satisfies exactly
 * the same contract as a hand-written entry in the game's MODEL_BUILDERS table:
 *
 *     { group, flashMats[], turret, barrelTip, muzzle, weapon, rig, drones }
 *
 * The load-bearing idea (see FORGE_PLAN.md §1): a player-authored model does
 * NOT bring its own animation. Its parts hang off the named joints of one of
 * the game's existing skeletons, so it inherits `_poseInfantry` / `_poseSuit`
 * wholesale — the walk cycle, weapon elevation onto the target, recoil through
 * the shoulder, the suppression duck, the death collapse, and the first-person
 * eye riding the real posed head. None of that is reimplemented here.
 *
 * This file loads BEFORE the game script, so it cannot see the game's
 * internals. The game hands them over from inside the MODEL_BUILDERS IIFE:
 *
 *     if (window.TCM) window.TCM.install({ THREE, MODEL_BUILDERS, UNIT_DEFS,
 *       OBS_DEF, rigs: { infantry, suitRig }, helpers: { … } });
 *
 * Rules this file must never break:
 *   1. NEVER THROW. A bad document renders a magenta placeholder — one broken
 *      custom unit can never take a battle down.
 *   2. ALWAYS produce a complete skeleton. A missing joint is not a valid
 *      state; three separate code paths crashed in Batch N4 over exactly that.
 *   3. Materials that the game mutates per-hit (`flashMats`) are PER UNIT and
 *      never cached. Cache one and hitting a unit flashes the whole army.
 *      The one exception is `buildProp`: nothing mutates a prop's material
 *      (Obstacles drops its flashMats on the floor), so identical palette
 *      entries share one instance (`matCacheLit`) and PropBatcher can fold
 *      the scenery. Never dispose one of those — see `litMat`.
 * ======================================================================== */
(function () {
  'use strict';
  // COSMETIC RANDOMNESS, ITS OWN STREAM (round 95). Drawing on `Math.random`
  // moved the simulation's rolls — which every probe seeds — by how much
  // a Forge model's burn flickered, so a seeded battle depended on the camera. Mulberry32.
  var _cs = 0x3c6ef372;
  function crand() {
    _cs = (_cs + 0x6D2B79F5) | 0;
    var t = Math.imul(_cs ^ (_cs >>> 15), 1 | _cs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }


  var VERSION = 1;
  var G = null;                 // the injected game internals
  var THREE = null;

  // ---- caches -------------------------------------------------------------
  // Geometry is immutable once built, so forty identical rivets share one
  // buffer. Materials are split: unlit ones are immutable and cacheable,
  // lit ones get mutated on hit and death, so those stay per-unit (rule 3).
  var geoCache = new Map();
  var matCacheUnlit = new Map();
  // Lit materials shared between PROPS only. PropBatcher keys its buckets on
  // material.uuid and skips singletons, so a fresh material per prop was one
  // draw call per part — the same failure TODO §1.1 measured on the hand-built
  // props (861 props, 187 batched, 2,841 calls). No stock map places a TCM
  // prop; this is for Forge scenery.
  // `sharedLit` is true only while buildProp is building — a unit build must
  // never see it, or one hit flashes every unit of the type (rule 3).
  var matCacheLit = new Map();
  var sharedLit = false;

  function install(api) {
    G = api;
    THREE = api.THREE;
  }

  // =======================================================================
  // Schema: migration and validation
  // =======================================================================

  var SHAPES = ['box', 'cyl', 'cone', 'sph', 'torus', 'wedge', 'prism',
                'trapezoid', 'plate', 'node', 'ref',
                // Phase 3 shapes. `extrude` is the release blocker (FORGE_PLAN
                // §4.1) — with no mesh import it is the only route to a novel
                // silhouette, so its outline is stored as points and stays
                // re-editable. `lathe`/`tube` are the cheap route to smooth
                // curved volumes; `decal` is a painted symbol on a thin plate.
                'extrude', 'lathe', 'tube', 'decal',
                // Phase 4: a Tier-2 editable mesh — raw topology in the
                // document, still an ordinary part in every other respect.
                'mesh'];
  var SKELETONS = ['humanoid', 'suit', 'quad', 'flyer', 'hull', 'static', 'custom'];

  // ---- semantic bone tags  (FORGE_PLAN §6.1) ------------------------------
  //
  // Every procedural system in the game used to index joints by HARDCODED NAME
  // — `rig.aim`, `rig.head`, `rig.neck`. That is exactly why a from-scratch
  // skeleton could not work, and it is the bug that bit Batch N4 three times
  // when a suit rig had no `neck`.
  //
  // So a bone may carry a semantic TAG, and the shared procedural code targets
  // the tag. The stock skeletons are simply pre-tagged presets: their tags map
  // 1:1 onto the names they already had, so nothing about them changes. A
  // custom skeleton that tags `head` and `aim` immediately earns the
  // first-person eye, weapon elevation, recoil, the suppression duck and the
  // death collapse — with no new engine code.
  var BONE_TAGS = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'eye',
    'aim', 'offhand', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR',
    'thighL', 'thighR', 'kneeL', 'kneeR', 'footL', 'footR',
    'turret', 'gun', 'hatch', 'jet', 'rotor', 'wheel', 'track', 'banner'];

  // How each stock skeleton's own joint names map onto the tags.
  var STOCK_TAGS = {
    humanoid: { root: 'body', hips: 'hips', spine: 'spine', chest: 'spine', neck: 'neck',
      head: 'head', eye: 'head', aim: 'aim',
      shoulderL: 'armL', shoulderR: 'armR', elbowL: 'elbowL', elbowR: 'elbowR',
      handL: 'handL', handR: 'handR', thighL: 'legL', thighR: 'legR',
      kneeL: 'kneeL', kneeR: 'kneeR', footL: 'bootL', footR: 'bootR' },
    suit: { root: 'body', hips: 'hips', spine: 'torso', chest: 'torso', head: 'head', eye: 'head',
      aim: 'armR', offhand: 'armL', shoulderL: 'shL', shoulderR: 'shR',
      thighL: 'legL', thighR: 'legR', kneeL: 'kneeL', kneeR: 'kneeR',
      footL: 'footL', footR: 'footR' },
    quad: { root: 'body', hips: 'hips', spine: 'torso', chest: 'torso', head: 'head', eye: 'head',
      aim: 'armR', offhand: 'armL', shoulderL: 'shL', shoulderR: 'shR',
      thighL: 'legL', thighR: 'legR', kneeL: 'kneeL', kneeR: 'kneeR',
      footL: 'footL', footR: 'footR' },
    flyer: { root: 'body', chest: 'hull', head: 'hull', eye: 'hull', aim: 'gun',
      rotor: 'rotor', turret: 'gun' },
    hull: { root: 'body', chest: 'body', turret: 'turret', gun: 'gun', aim: 'gun', eye: 'turret' },
    static: { root: 'body', chest: 'body' },
    custom: { root: 'body' },
  };

  // Joints each stock skeleton guarantees. `validate` checks against these and
  // `buildModel` guarantees every one of them exists (rule 2).
  var JOINTS = {
    humanoid: ['body', 'hips', 'spine', 'neck', 'head', 'aim',
               'legL', 'legR', 'kneeL', 'kneeR', 'bootL', 'bootR',
               'armL', 'armR', 'elbowL', 'elbowR', 'handL', 'handR'],
    suit: ['body', 'hips', 'torso', 'head', 'pack',
           'legL', 'legR', 'kneeL', 'kneeR', 'footL', 'footR',
           'shL', 'shR', 'armL', 'armR'],
    quad: ['body', 'hips', 'torso', 'head', 'pack',
           'legL', 'legR', 'legL2', 'legR2', 'kneeL', 'kneeR', 'kneeL2', 'kneeR2',
           'footL', 'footR', 'footL2', 'footR2', 'shL', 'shR', 'armL', 'armR'],
    flyer: ['body', 'hull', 'rotor', 'gun', 'wingL', 'wingR', 'tail'],
    hull: ['body', 'turret', 'gun', 'deck'],
    static: ['body'],
    custom: ['body'],
  };
  // Joints that get mirrored onto their opposite number when a part is flagged
  // `mirror` — build one arm and you get the other.
  var PAIRED = { legL: 'legR', kneeL: 'kneeR', bootL: 'bootR', footL: 'footR',
                 armL: 'armR', elbowL: 'elbowR', handL: 'handR', shL: 'shR',
                 legL2: 'legR2', kneeL2: 'kneeR2', footL2: 'footR2',
                 wingL: 'wingR' };
  (function () { for (var k in PAIRED) PAIRED[PAIRED[k]] = k; })();

  var PART_TAGS = ['muzzle', 'barrelTip', 'turret', 'jet', 'heatVent', 'eye',
                   'garrisonSlot', 'weapon'];

  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    var d = JSON.parse(JSON.stringify(doc));
    if (!d.v) d.v = VERSION;              // pre-versioned drafts
    // Future: while (d.v < VERSION) { …step…; d.v++ }
    return d;
  }

  /** Never throws. Returns { ok, errors[], warnings[], budget }. */
  function validate(doc) {
    var errors = [], warnings = [];
    var budget = { parts: 0, meshes: 0, tris: 0, mats: 0, unique: 0 };
    try {
      if (!doc || typeof doc !== 'object') { errors.push('not an object'); return done(); }
      if (doc.v > VERSION) errors.push('document version ' + doc.v + ' is newer than this build (' + VERSION + ')');
      if (!doc.id) errors.push('missing id');
      var skel = doc.skeleton || 'static';
      if (SKELETONS.indexOf(skel) < 0) { errors.push('unknown skeleton "' + skel + '"'); return done(); }

      // --- bones ---
      var joints = {};
      JOINTS[skel].forEach(function (j) { joints[j] = true; });
      var bones = doc.bones || [];
      bones.forEach(function (b, i) {
        if (!b.id) { errors.push('bone[' + i + '] has no id'); return; }
        if (joints[b.id]) errors.push('bone "' + b.id + '" collides with a skeleton joint');
        joints[b.id] = true;
      });
      // parents must resolve, and no cycles
      bones.forEach(function (b) {
        if (b.parent && !joints[b.parent]) errors.push('bone "' + b.id + '" has unknown parent "' + b.parent + '"');
      });
      if (hasCycle(bones)) errors.push('bone hierarchy contains a cycle');

      // --- palette ---
      var mats = {};
      (doc.palette || []).forEach(function (m, i) {
        if (!m.id) { errors.push('palette[' + i + '] has no id'); return; }
        mats[m.id] = m;
      });
      budget.mats = Object.keys(mats).length;
      if (!budget.mats) warnings.push('no palette — parts will use a default grey');

      // --- parts ---
      var parts = doc.parts || [];
      budget.parts = parts.length;
      var ids = {};
      parts.forEach(function (p, i) {
        var at = 'part[' + i + (p.n ? ' "' + p.n + '"' : '') + ']';
        if (!p.id) errors.push(at + ' has no id');
        else if (ids[p.id]) errors.push(at + ' duplicate id "' + p.id + '"');
        else ids[p.id] = true;
        var sh = p.sh || 'box';
        if (SHAPES.indexOf(sh) < 0) errors.push(at + ' unknown shape "' + sh + '"');
        var j = p.j || 'body';
        if (!joints[j]) errors.push(at + ' unknown joint "' + j + '"');
        if (sh !== 'node' && sh !== 'ref' && p.m && !mats[p.m]) errors.push(at + ' unknown material "' + p.m + '"');
        if (sh === 'ref') {
          var rid = p.d && (p.d.ref || p.d.id);
          if (!rid) errors.push(at + ' is a ref with no target model');
          else if (rid === doc.id) errors.push(at + ' refs its own model');
          else if (!models[rid]) warnings.push(at + ' refs model "' + rid + '", which is not loaded');
        }
        if (sh === 'extrude' && p.d && p.d.outline && p.d.outline.length < 3)
          errors.push(at + ' extrude outline needs at least 3 points');
        if (sh === 'lathe' && p.d && p.d.profile && p.d.profile.length < 2)
          errors.push(at + ' lathe profile needs at least 2 points');
        if (sh === 'decal' && p.d && p.d.sym && DECAL_SYMS.indexOf(p.d.sym) < 0)
          warnings.push(at + ' unknown decal symbol "' + p.d.sym + '"');
        if (sh === 'mesh') {
          if (!p.d || !p.d.v || !p.d.f) errors.push(at + ' is an editable mesh with no geometry');
          else if (p.d.f.length % 3) errors.push(at + ' mesh has a partial triangle');
        }
        if (p.sculpt) {
          if (MESHABLE.indexOf(sh) < 0)
            warnings.push(at + ' has a sculpt layer but "' + sh + '" is not sculptable — it will be ignored');
          else {
            var sres = Math.max(0, Math.min(3, (p.sculpt.res | 0) || 0));
            if ((p.sculpt.res | 0) > 3) warnings.push(at + ' sculpt resolution capped at 3');
            var vcount = baseMesh(sh, p.d, sres).v.length / 3;
            if (vcount > 4000) warnings.push(at + ' subdivides to ' + vcount + ' vertices — that is expensive');
            var stale = 0;
            (p.sculpt.d || []).forEach(function (e) { if (e[0] >= vcount || e[0] < 0) stale++; });
            if (stale) warnings.push(at + ' has ' + stale + ' sculpt delta(s) pointing past the mesh (resolution changed?)');
          }
        }
        if (p.mirror && !PAIRED[j] && Math.abs((p.p && p.p[0]) || 0) < 1e-6)
          warnings.push(at + ' is mirrored but sits on the centre line — it will double up');
        (p.tags || []).forEach(function (t) {
          if (PART_TAGS.indexOf(t) < 0) warnings.push(at + ' unknown tag "' + t + '"');
        });
        // modifiers + instance caps
        var n = instanceCount(p);
        if (n > 64) { errors.push(at + ' expands to ' + n + ' instances (cap 64)'); n = 64; }
        var per = sh === 'node' ? 0 : sh === 'ref' ? refMeshCount(p.d && (p.d.ref || p.d.id)) : 1;
        budget.meshes += per * n * (p.mirror ? 2 : 1);
        budget.tris += (p.sculpt && MESHABLE.indexOf(sh) >= 0 ? sculptTriCost(sh, p.d, p.sculpt) : triCost(sh, p.d))
          * n * (p.mirror ? 2 : 1);
        // Unique geometry opts out of the shared cache: a sculpted or editable
        // mesh part is one-of-a-kind by definition, so it costs real memory and
        // a real draw call each. A model can be well inside the mesh count and
        // still be expensive if every part is bespoke — the player should see
        // it, which is why the budget has two axes (FORGE_PLAN §4.10).
        if (sh === 'decal' || sh === 'mesh' || p.sculpt) budget.unique += n * (p.mirror ? 2 : 1);
      });

      // --- drivers ---
      (doc.drivers || []).forEach(function (dv, i) {
        if (!joints[dv.bone]) errors.push('driver[' + i + '] targets unknown bone "' + dv.bone + '"');
      });

      // --- bone tags ---
      bones.forEach(function (b) {
        if (b.tag && BONE_TAGS.indexOf(b.tag) < 0) warnings.push('bone "' + b.id + '" has unknown tag "' + b.tag + '"');
      });

      // --- clips ---
      var clips = doc.clips || {};
      for (var cn in clips) {
        var c = clips[cn] || {};
        if (!(num(c.dur, 0) > 0)) errors.push('clip "' + cn + '" has no duration');
        (c.tracks || []).forEach(function (t, ti) {
          if (!joints[t.b]) errors.push('clip "' + cn + '" track[' + ti + '] targets unknown bone "' + t.b + '"');
          if (CLIP_CHANNELS.indexOf(t.ch) < 0) errors.push('clip "' + cn + '" track[' + ti + '] unknown channel "' + t.ch + '"');
          if (!t.k || !t.k.length) warnings.push('clip "' + cn + '" track[' + ti + '] has no keys');
        });
      }
      if (Object.keys(clips).length && !clips.stand && !clips.idle)
        warnings.push('no `stand` clip — the unit will hold its rest pose when idle');

      // --- attachments ---
      var att = doc.attach || {};
      ['muzzle', 'barrelTip', 'turret'].forEach(function (k) {
        if (att[k] && !ids[att[k]]) errors.push('attach.' + k + ' points at unknown part "' + att[k] + '"');
      });
    } catch (e) {
      errors.push('validator crashed: ' + e.message);
    }
    return done();

    function done() {
      budget.level = budget.meshes <= 160 && budget.tris <= 6000 ? 'green'
        : budget.meshes <= 400 && budget.tris <= 20000 ? 'amber' : 'red';
      return { ok: errors.length === 0, errors: errors, warnings: warnings, budget: budget };
    }
  }

  function hasCycle(bones) {
    var parent = {};
    bones.forEach(function (b) { parent[b.id] = b.parent; });
    for (var id in parent) {
      var seen = {}, cur = id, guard = 0;
      while (cur && guard++ < 200) {
        if (seen[cur]) return true;
        seen[cur] = true;
        cur = parent[cur];
      }
      if (guard >= 200) return true;
    }
    return false;
  }

  function instanceCount(p) {
    var n = 1, mod = p.mod || {};
    if (mod.array && mod.array.n > 0) n *= mod.array.n;
    if (mod.radial && mod.radial.n > 0) n *= mod.radial.n;
    return n;
  }

  // Rough triangle counts, for the budget meter only.
  function triCost(sh, d) {
    d = d || {};
    switch (sh) {
      case 'node': return 0;
      case 'sph': return 2 * (d.ws || 10) * (d.hs || 8);
      case 'cyl': case 'cone': return 4 * (d.seg || 8);
      case 'torus': return 2 * (d.rs || 6) * (d.ts || 12);
      case 'plate': case 'decal': return 2;
      case 'extrude': {
        var n = (d.outline && d.outline.length) || 5;
        return 2 * (n - 2) + 2 * n * (d.bevel > 0 ? 3 : 1);
      }
      case 'lathe': return 2 * (d.seg || 10) * Math.max(1, ((d.profile && d.profile.length) || 5) - 1);
      case 'tube': return 2 * (d.seg || 10) * (d.rseg || 6);
      case 'ref': return refTriCost(d && (d.ref || d.id));
      case 'mesh': return ((d.f && d.f.length) || 36) / 3;
      default: return 12;
    }
  }

  /** A sculpt layer multiplies the triangle count by 4 per subdivision pass. */
  function sculptTriCost(sh, d, sculpt) {
    return triCost(sh, d) * Math.pow(4, Math.max(0, Math.min(3, (sculpt.res | 0) || 0)));
  }

  function refMeshCount(id) {
    var sub = id && models[id];
    if (!sub) return 1;
    var n = 0, ps = sub.parts || [];
    for (var i = 0; i < ps.length; i++) {
      if ((ps[i].sh || 'box') === 'node') continue;
      n += Math.min(64, instanceCount(ps[i])) * (ps[i].mirror ? 2 : 1);
    }
    return Math.max(1, n);
  }

  /** A ref costs whatever the model it points at costs. Depth-capped. */
  var refCostDepth = 0;
  function refTriCost(id) {
    var sub = id && models[id];
    if (!sub || refCostDepth > 3) return 12;
    refCostDepth++;
    var t = 0;
    try {
      var ps = sub.parts || [];
      for (var i = 0; i < ps.length; i++)
        t += triCost(ps[i].sh || 'box', ps[i].d) * Math.min(64, instanceCount(ps[i])) * (ps[i].mirror ? 2 : 1);
    } finally { refCostDepth--; }
    return t;
  }

  // =======================================================================
  // THE DETERMINISTIC MESH CORE  (FORGE_PLAN §4.10)
  // =======================================================================
  //
  // Sculpting stores SPARSE DELTAS against vertex indices. That only works if a
  // given (shape, resolution) produces an identical vertex list every single
  // time, forever — otherwise every saved sculpt silently corrupts the first
  // time the numbers move. So:
  //
  //   * TCM owns these generators. They do NOT delegate to a Three.js geometry
  //     whose vertex order could change between library versions.
  //   * Nothing here is allowed to be non-deterministic. No Math.random, no
  //     Set/Map iteration order dependence, no floating-point-keyed lookups.
  //   * Primitives are generated at UNIT SIZE and scaled afterwards, so the
  //     topology depends only on (shape, res) — never on the dimensions. That
  //     is also what makes a dent scale with the plate it was sculpted into.
  //   * Any change to a generator is a SCHEMA VERSION BUMP plus a migration.
  //     `TCM.mesh.golden()` is the fingerprint that catches an accidental one.
  //
  // A mesh here is a plain `{ v: [x,y,z, …], f: [a,b,c, …] }`. Triangles only.

  var MESHABLE = ['box', 'plate', 'wedge', 'trapezoid', 'prism', 'cyl', 'cone', 'sph'];

  /** Unit-sized primitives. Vertex order is CANONICAL and pinned forever. */
  function unitPrim(sh, d) {
    d = d || {};
    switch (sh) {
      case 'plate':                            // one quad on XY, facing +Z
        return { v: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
                 f: [0, 1, 2, 0, 2, 3] };
      case 'wedge':
        return { v: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
                     -0.5, 0.5, -0.5, 0.5, 0.5, -0.5],
                 f: [0, 1, 2, 0, 2, 3, 4, 5, 1, 4, 1, 0, 3, 2, 5, 3, 5, 4, 0, 3, 4, 1, 5, 2] };
      case 'trapezoid': {
        // The top face is sized by tw/tl RELATIVE to w/l, so the taper survives
        // the unit-space trick: at generation time it is a pure ratio.
        var tx = num(d.tw, 0.15) / Math.max(1e-6, num(d.w, 0.3)) * 0.5;
        var tz = num(d.tl, 0.15) / Math.max(1e-6, num(d.l, 0.3)) * 0.5;
        return { v: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
                     -tx, 0.5, -tz, tx, 0.5, -tz, tx, 0.5, tz, -tx, 0.5, tz],
                 f: [0, 1, 2, 0, 2, 3, 7, 6, 5, 7, 5, 4, 0, 4, 5, 0, 5, 1,
                     3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2] };
      }
      case 'prism': case 'cyl': case 'cone': {
        // One ring of `seg` sides, capped. `cone` collapses the top ring to a
        // point; `prism` is the 4-sided case with square caps.
        var seg = sh === 'prism' ? Math.max(3, num(d.seg, 4) | 0)
          : Math.max(3, Math.min(24, num(d.seg, 8) | 0));
        var top = sh === 'cone' ? 0 : (sh === 'cyl'
          ? num(d.r2, num(d.r, 0.15)) / Math.max(1e-6, num(d.r1, num(d.r, 0.15))) : 1);
        var v = [], f = [], i;
        for (i = 0; i < seg; i++) {            // bottom ring 0..seg-1
          var a = i / seg * Math.PI * 2;
          v.push(Math.cos(a) * 0.5, -0.5, Math.sin(a) * 0.5);
        }
        var apex = -1;
        if (sh === 'cone') { apex = seg; v.push(0, 0.5, 0); }
        else for (i = 0; i < seg; i++) {        // top ring seg..2seg-1
          var b = i / seg * Math.PI * 2;
          v.push(Math.cos(b) * 0.5 * top, 0.5, Math.sin(b) * 0.5 * top);
        }
        var cb = v.length / 3; v.push(0, -0.5, 0);          // bottom centre
        var ct = -1;
        if (sh !== 'cone') { ct = v.length / 3; v.push(0, 0.5, 0); }
        for (i = 0; i < seg; i++) {
          var j = (i + 1) % seg;
          f.push(cb, j, i);                                   // bottom cap
          if (sh === 'cone') f.push(i, j, apex);
          else { f.push(i, j, seg + j, i, seg + j, seg + i); f.push(ct, seg + i, seg + j); }
        }
        return { v: v, f: f };
      }
      case 'sph': {
        // Latitude/longitude sphere with poles. Rings run south → north so the
        // index of any vertex is a pure function of (ws, hs).
        var ws = Math.max(4, Math.min(24, num(d.ws, 10) | 0));
        var hs = Math.max(3, Math.min(18, num(d.hs, 8) | 0));
        var sv = [0, -0.5, 0], sf = [], r, c;
        for (r = 1; r < hs; r++) {
          var phi = Math.PI * r / hs;
          for (c = 0; c < ws; c++) {
            var th = Math.PI * 2 * c / ws;
            sv.push(Math.sin(phi) * Math.cos(th) * 0.5, -Math.cos(phi) * 0.5, Math.sin(phi) * Math.sin(th) * 0.5);
          }
        }
        var north = sv.length / 3; sv.push(0, 0.5, 0);
        var ring = function (r2, c2) { return 1 + r2 * ws + (c2 % ws); };
        for (c = 0; c < ws; c++) sf.push(0, ring(0, c + 1), ring(0, c));
        for (r = 0; r < hs - 2; r++) for (c = 0; c < ws; c++)
          sf.push(ring(r, c), ring(r, c + 1), ring(r + 1, c + 1), ring(r, c), ring(r + 1, c + 1), ring(r + 1, c));
        for (c = 0; c < ws; c++) sf.push(ring(hs - 2, c), ring(hs - 2, c + 1), north);
        return { v: sv, f: sf };
      }
      default:                                  // box, and anything unrecognised
        return { v: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
                     -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
                 f: [0, 1, 2, 0, 2, 3, 7, 6, 5, 7, 5, 4, 0, 4, 5, 0, 5, 1,
                     3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2] };
    }
  }

  /** How a unit primitive is scaled into world dimensions. */
  function dimScale(sh, d) {
    d = d || {};
    switch (sh) {
      case 'plate': return [num(d.w, 0.3), num(d.h, 0.3), 1];
      case 'sph': return [num(d.r, 0.2) * 2, num(d.r, 0.2) * 2, num(d.r, 0.2) * 2];
      case 'cyl': {
        var r1 = num(d.r1, num(d.r, 0.15));
        return [r1 * 2, num(d.h, 0.4), r1 * 2];
      }
      case 'cone': return [num(d.r, 0.15) * 2, num(d.h, 0.4), num(d.r, 0.15) * 2];
      case 'prism': return [num(d.w, 0.3), num(d.h, 0.3), num(d.l, 0.3)];
      default: return [num(d.w, 0.3), num(d.h, 0.3), num(d.l, 0.3)];
    }
  }

  /** Deterministic 1-to-4 midpoint subdivision, applied `res` times.
   *
   *  Edge midpoints are allocated in face order, and within a face in edge
   *  order (0,1) (1,2) (2,0). The lookup is keyed on integer indices, never on
   *  positions, so nothing here can drift with floating point. This routine and
   *  `unitPrim` together ARE the topology contract. */
  function subdivideMesh(m, res) {
    var out = { v: m.v.slice(), f: m.f.slice() };
    for (var pass = 0; pass < Math.max(0, Math.min(3, res | 0)); pass++) {
      var v = out.v, f = out.f, nf = [];
      var mid = {};                              // "a_b" (a<b) → new index
      var get = function (a, b) {
        var k = a < b ? a + '_' + b : b + '_' + a;
        var hit = mid[k];
        if (hit !== undefined) return hit;
        var i = v.length / 3;
        v.push((v[a * 3] + v[b * 3]) / 2, (v[a * 3 + 1] + v[b * 3 + 1]) / 2, (v[a * 3 + 2] + v[b * 3 + 2]) / 2);
        mid[k] = i;
        return i;
      };
      for (var t = 0; t < f.length; t += 3) {
        var a = f[t], b = f[t + 1], c = f[t + 2];
        var ab = get(a, b), bc = get(b, c), ca = get(c, a);
        nf.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      }
      out.f = nf;
    }
    return out;
  }

  /** Vertex i ↔ its mirror across x=0, or -1. Precomputed per (shape, res) so
   *  live symmetric sculpting — the thing you actually need for faces, hulls
   *  and pauldrons — costs a lookup rather than a search. */
  function symmetryMap(m) {
    var n = m.v.length / 3, map = new Int32Array(n), key = {}, i;
    var q = function (x) { return Math.round(x * 1e5); };
    for (i = 0; i < n; i++) {
      map[i] = -1;
      key[q(m.v[i * 3]) + ',' + q(m.v[i * 3 + 1]) + ',' + q(m.v[i * 3 + 2])] = i;
    }
    for (i = 0; i < n; i++) {
      var j = key[q(-m.v[i * 3]) + ',' + q(m.v[i * 3 + 1]) + ',' + q(m.v[i * 3 + 2])];
      if (j !== undefined) map[i] = j;
    }
    return map;
  }

  var meshCache = new Map();       // "sh|res|dimhash" → { v, f, sym }

  /** The base mesh a sculpt bites into: unit primitive, subdivided, cached. */
  function baseMesh(sh, d, res) {
    res = Math.max(0, Math.min(3, (res | 0) || 0));
    // Only the dimensions that change TOPOLOGY belong in the key. w/h/l scale
    // afterwards, so a 0.2 box and a 2.0 box share one base mesh and one
    // symmetry map — and a sculpt survives resizing.
    var key = sh + '|' + res + '|' + [d && d.seg, d && d.ws, d && d.hs,
      sh === 'trapezoid' ? Math.round((num(d && d.tw, 0.15) / Math.max(1e-6, num(d && d.w, 0.3))) * 1e4) : 0,
      sh === 'trapezoid' ? Math.round((num(d && d.tl, 0.15) / Math.max(1e-6, num(d && d.l, 0.3))) * 1e4) : 0,
      sh === 'cyl' ? Math.round((num(d && d.r2, num(d && d.r, 0.15)) / Math.max(1e-6, num(d && d.r1, num(d && d.r, 0.15)))) * 1e4) : 0,
    ].join(',');
    var hit = meshCache.get(key);
    if (hit) return hit;
    var m = subdivideMesh(unitPrim(sh, d), res);
    m.sym = symmetryMap(m);
    meshCache.set(key, m);
    return m;
  }

  /** Sparse deltas are quantised integers in units of 0.001 UNIT space — a
   *  third the JSON size of floats and lossless at this scale. */
  var Q = 1000;

  function applySculpt(m, sculpt) {
    var v = m.v.slice();
    var ds = (sculpt && sculpt.d) || [];
    for (var i = 0; i < ds.length; i++) {
      var e = ds[i], k = e[0];
      if (k < 0 || k * 3 + 2 >= v.length) continue;    // stale index: ignore, never throw
      v[k * 3] += e[1] / Q; v[k * 3 + 1] += e[2] / Q; v[k * 3 + 2] += e[3] / Q;
    }
    return { v: v, f: m.f, sym: m.sym };
  }

  function meshToGeometry(m, scale) {
    var v = m.v;
    if (scale && (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1)) {
      v = new Array(m.v.length);
      for (var i = 0; i < m.v.length; i += 3) {
        v[i] = m.v[i] * scale[0]; v[i + 1] = m.v[i + 1] * scale[1]; v[i + 2] = m.v[i + 2] * scale[2];
      }
    }
    return buildGeo(v, m.f);
  }

  /** A sculpted part's geometry. Cached on the delta list's fingerprint, so
   *  rebuilding an unchanged model is still free — but two differently sculpted
   *  copies of the same box never collide. */
  function sculptGeo(sh, d, sculpt) {
    var key = 'sc|' + sh + '|' + geoKey(sh, d) + '|' + (sculpt.res | 0) + '|' +
      hashStr(JSON.stringify(sculpt.d || []));
    var hit = geoCache.get(key);
    if (hit) return hit;
    var g = meshToGeometry(applySculpt(baseMesh(sh, d, sculpt.res), sculpt), dimScale(sh, d));
    geoCache.set(key, g);
    return g;
  }

  /** A Tier-2 editable mesh: raw topology stored in the document as quantised
   *  int16 plus a scale factor. Still an ordinary part — same joint, material,
   *  transform, mirror and modifier stack as anything else. */
  function meshPartGeo(d) {
    var key = 'mp|' + hashStr(JSON.stringify([d.v || [], d.f || [], d.s || 1]));
    var hit = geoCache.get(key);
    if (hit) return hit;
    var s = num(d.s, 1) / Q, v = [], i;
    var raw = d.v || [];
    for (i = 0; i < raw.length; i++) v.push(raw[i] * s);
    var g = buildGeo(v, d.f || []);
    geoCache.set(key, g);
    return g;
  }

  /** Freeze a sculpted parametric part into an editable mesh. One way, and the
   *  UI says so: the parametric dimensions are gone afterwards. */
  function toEditableMesh(sh, d, sculpt) {
    var m = sculpt ? applySculpt(baseMesh(sh, d, sculpt.res), sculpt) : subdivideMesh(unitPrim(sh, d), 0);
    var sc = dimScale(sh, d), out = [], i;
    var max = 1e-6;
    for (i = 0; i < m.v.length; i += 3) {
      max = Math.max(max, Math.abs(m.v[i] * sc[0]), Math.abs(m.v[i + 1] * sc[1]), Math.abs(m.v[i + 2] * sc[2]));
    }
    // int16 holds ±32767; pick a scale that uses the range without clipping.
    var q = Math.min(Q, Math.floor(32000 / max));
    for (i = 0; i < m.v.length; i += 3) {
      out.push(Math.round(m.v[i] * sc[0] * q), Math.round(m.v[i + 1] * sc[1] * q), Math.round(m.v[i + 2] * sc[2] * q));
    }
    return { v: out, f: m.f.slice(), s: q, from: sh };
  }

  // ---- topology surgery ---------------------------------------------------
  // These operate on a decoded { v, f } and are shared by the editor and the
  // tests. Every one returns a NEW mesh; none mutates its input.

  function faceNormal(m, t) {
    var a = m.f[t * 3] * 3, b = m.f[t * 3 + 1] * 3, c = m.f[t * 3 + 2] * 3, v = m.v;
    var ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    var wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    var L = Math.hypot(nx, ny, nz) || 1;
    return [nx / L, ny / L, nz / L];
  }
  function faceCentre(m, t) {
    var a = m.f[t * 3] * 3, b = m.f[t * 3 + 1] * 3, c = m.f[t * 3 + 2] * 3, v = m.v;
    return [(v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3];
  }

  /** Push selected faces out along their normals, walling in the gap. The most
   *  useful topology tool there is, and the one Phase 4's gate names. */
  function extrudeFaces(m, tris, dist) {
    var out = { v: m.v.slice(), f: [] }, i, t;
    var sel = {}; tris.forEach(function (x) { sel[x] = 1; });
    var dup = {};                                    // old vertex → new vertex
    // Border edges of the selection get walls; interior edges do not.
    var edgeUse = {};
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      for (var e = 0; e < 3; e++) {
        var a = m.f[t * 3 + e], b = m.f[t * 3 + (e + 1) % 3];
        var k = a < b ? a + '_' + b : b + '_' + a;
        edgeUse[k] = (edgeUse[k] || 0) + 1;
      }
    }
    var newIdx = function (o) {
      if (dup[o] !== undefined) return dup[o];
      var n = out.v.length / 3;
      out.v.push(m.v[o * 3], m.v[o * 3 + 1], m.v[o * 3 + 2]);
      dup[o] = n;
      return n;
    };
    // Offset the duplicated ring along the averaged normal of its faces.
    var off = {};
    for (i = 0; i < tris.length; i++) {
      var nrm = faceNormal(m, tris[i]);
      for (var q = 0; q < 3; q++) {
        var vi = m.f[tris[i] * 3 + q];
        var acc = off[vi] || (off[vi] = [0, 0, 0, 0]);
        acc[0] += nrm[0]; acc[1] += nrm[1]; acc[2] += nrm[2]; acc[3]++;
      }
    }
    for (i = 0; i < tris.length; i++) for (var w = 0; w < 3; w++) newIdx(m.f[tris[i] * 3 + w]);
    for (var key in off) {
      var o = off[key], n2 = newIdx(key | 0) * 3;
      var L = Math.hypot(o[0], o[1], o[2]) || 1;
      out.v[n2] += o[0] / L * dist; out.v[n2 + 1] += o[1] / L * dist; out.v[n2 + 2] += o[2] / L * dist;
    }
    // Unselected faces survive untouched; selected faces move to the new ring.
    for (t = 0; t < m.f.length / 3; t++) {
      if (sel[t]) out.f.push(newIdx(m.f[t * 3]), newIdx(m.f[t * 3 + 1]), newIdx(m.f[t * 3 + 2]));
      else out.f.push(m.f[t * 3], m.f[t * 3 + 1], m.f[t * 3 + 2]);
    }
    // Wall the border.
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      for (var e2 = 0; e2 < 3; e2++) {
        var a2 = m.f[t * 3 + e2], b2 = m.f[t * 3 + (e2 + 1) % 3];
        var k2 = a2 < b2 ? a2 + '_' + b2 : b2 + '_' + a2;
        if (edgeUse[k2] !== 1) continue;             // interior to the selection
        var A = a2, B = b2, A2 = newIdx(a2), B2 = newIdx(b2);
        out.f.push(A, B, B2, A, B2, A2);
      }
    }
    return out;
  }

  /** Shrink selected faces toward their own centres, adding a border ring. */
  function insetFaces(m, tris, amount) {
    var out = { v: m.v.slice(), f: m.f.slice() };
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i], c = faceCentre(m, t), n = [];
      for (var q = 0; q < 3; q++) {
        var o = m.f[t * 3 + q] * 3, ni = out.v.length / 3;
        out.v.push(m.v[o] + (c[0] - m.v[o]) * amount,
          m.v[o + 1] + (c[1] - m.v[o + 1]) * amount,
          m.v[o + 2] + (c[2] - m.v[o + 2]) * amount);
        n.push(ni);
      }
      out.f[t * 3] = n[0]; out.f[t * 3 + 1] = n[1]; out.f[t * 3 + 2] = n[2];
      for (var e = 0; e < 3; e++) {
        var a = m.f[t * 3 + e], b = m.f[t * 3 + (e + 1) % 3];
        out.f.push(a, b, n[(e + 1) % 3], a, n[(e + 1) % 3], n[e]);
      }
    }
    return out;
  }

  function deleteFaces(m, tris) {
    var sel = {}; tris.forEach(function (t) { sel[t] = 1; });
    var f = [];
    for (var t = 0; t < m.f.length / 3; t++)
      if (!sel[t]) f.push(m.f[t * 3], m.f[t * 3 + 1], m.f[t * 3 + 2]);
    return compact({ v: m.v.slice(), f: f });
  }

  /** Subdivide only the selected faces. Border faces get split too, or the mesh
   *  cracks — each neighbour that shares a split edge is bisected to match. */
  function subdivideFaces(m, tris) {
    var out = { v: m.v.slice(), f: [] }, mid = {}, sel = {};
    tris.forEach(function (t) { sel[t] = 1; });
    var get = function (a, b) {
      var k = a < b ? a + '_' + b : b + '_' + a;
      if (mid[k] !== undefined) return mid[k];
      var i = out.v.length / 3;
      out.v.push((m.v[a * 3] + m.v[b * 3]) / 2, (m.v[a * 3 + 1] + m.v[b * 3 + 1]) / 2,
        (m.v[a * 3 + 2] + m.v[b * 3 + 2]) / 2);
      mid[k] = i;
      return i;
    };
    var t;
    for (t = 0; t < m.f.length / 3; t++) if (sel[t]) {
      var a = m.f[t * 3], b = m.f[t * 3 + 1], c = m.f[t * 3 + 2];
      get(a, b); get(b, c); get(c, a);
    }
    var has = function (a, b) { var k = a < b ? a + '_' + b : b + '_' + a; return mid[k]; };
    for (t = 0; t < m.f.length / 3; t++) {
      var A = m.f[t * 3], B = m.f[t * 3 + 1], C = m.f[t * 3 + 2];
      if (sel[t]) {
        var ab = get(A, B), bc = get(B, C), ca = get(C, A);
        out.f.push(A, ab, ca, ab, B, bc, ca, bc, C, ab, bc, ca);
        continue;
      }
      var e = [has(A, B), has(B, C), has(C, A)];
      var n = (e[0] !== undefined ? 1 : 0) + (e[1] !== undefined ? 1 : 0) + (e[2] !== undefined ? 1 : 0);
      if (n === 0) { out.f.push(A, B, C); continue; }
      if (n === 3) { out.f.push(A, e[0], e[2], e[0], B, e[1], e[2], e[1], C, e[0], e[1], e[2]); continue; }
      // 1 or 2 split edges: fan from a split midpoint so the seam stays welded.
      if (e[0] !== undefined && e[1] === undefined && e[2] === undefined) out.f.push(A, e[0], C, e[0], B, C);
      else if (e[1] !== undefined && e[0] === undefined && e[2] === undefined) out.f.push(B, e[1], A, e[1], C, A);
      else if (e[2] !== undefined && e[0] === undefined && e[1] === undefined) out.f.push(C, e[2], B, e[2], A, B);
      else if (e[0] !== undefined && e[1] !== undefined) out.f.push(A, e[0], e[1], A, e[1], C, e[0], B, e[1]);
      else if (e[1] !== undefined && e[2] !== undefined) out.f.push(B, e[1], e[2], B, e[2], A, e[1], C, e[2]);
      else out.f.push(C, e[2], e[0], C, e[0], B, e[2], A, e[0]);
    }
    return out;
  }

  /** Bridge two triangles with a tube of quads. Both are removed. */
  function bridgeFaces(m, t1, t2) {
    var out = { v: m.v.slice(), f: [] }, t;
    for (t = 0; t < m.f.length / 3; t++)
      if (t !== t1 && t !== t2) out.f.push(m.f[t * 3], m.f[t * 3 + 1], m.f[t * 3 + 2]);
    var A = [m.f[t1 * 3], m.f[t1 * 3 + 1], m.f[t1 * 3 + 2]];
    var B = [m.f[t2 * 3], m.f[t2 * 3 + 1], m.f[t2 * 3 + 2]];
    // Rotate B so its first vertex is nearest A's first — otherwise the bridge
    // crosses over itself.
    var best = 0, bd = Infinity;
    for (var r = 0; r < 3; r++) {
      var d2 = 0;
      for (var q = 0; q < 3; q++) {
        var a = A[q] * 3, b = B[(q + r) % 3] * 3;
        d2 += Math.pow(m.v[a] - m.v[b], 2) + Math.pow(m.v[a + 1] - m.v[b + 1], 2) + Math.pow(m.v[a + 2] - m.v[b + 2], 2);
      }
      if (d2 < bd) { bd = d2; best = r; }
    }
    for (var e = 0; e < 3; e++) {
      var a0 = A[e], a1 = A[(e + 1) % 3];
      var b0 = B[(e + best) % 3], b1 = B[(e + 1 + best) % 3];
      out.f.push(a0, a1, b1, a0, b1, b0);
    }
    return out;
  }

  /** Weld vertices closer than `eps`, then drop anything unreferenced. */
  function weldMesh(m, eps) {
    eps = eps || 1e-4;
    var q = function (x) { return Math.round(x / eps); };
    var seen = {}, remap = new Int32Array(m.v.length / 3), v = [], i;
    for (i = 0; i < m.v.length / 3; i++) {
      var k = q(m.v[i * 3]) + ',' + q(m.v[i * 3 + 1]) + ',' + q(m.v[i * 3 + 2]);
      if (seen[k] === undefined) { seen[k] = v.length / 3; v.push(m.v[i * 3], m.v[i * 3 + 1], m.v[i * 3 + 2]); }
      remap[i] = seen[k];
    }
    var f = [];
    for (i = 0; i < m.f.length; i += 3) {
      var a = remap[m.f[i]], b = remap[m.f[i + 1]], c = remap[m.f[i + 2]];
      if (a !== b && b !== c && a !== c) f.push(a, b, c);     // drop degenerates
    }
    return { v: v, f: f };
  }

  function flipFaces(m, tris) {
    var out = { v: m.v.slice(), f: m.f.slice() };
    var list = tris && tris.length ? tris : null;
    var n = m.f.length / 3;
    for (var t = 0; t < n; t++) {
      if (list && list.indexOf(t) < 0) continue;
      var b = out.f[t * 3 + 1];
      out.f[t * 3 + 1] = out.f[t * 3 + 2];
      out.f[t * 3 + 2] = b;
    }
    return out;
  }

  /** Drop vertices no face references, keeping the remainder in order. */
  function compact(m) {
    var used = {}, i;
    for (i = 0; i < m.f.length; i++) used[m.f[i]] = 1;
    var remap = {}, v = [];
    for (i = 0; i < m.v.length / 3; i++) {
      if (!used[i]) continue;
      remap[i] = v.length / 3;
      v.push(m.v[i * 3], m.v[i * 3 + 1], m.v[i * 3 + 2]);
    }
    var f = [];
    for (i = 0; i < m.f.length; i++) f.push(remap[m.f[i]]);
    return { v: v, f: f };
  }

  /** Encode a working mesh back into the document's quantised int16 form. */
  function encodeMesh(m, prev) {
    var max = 1e-6, i;
    for (i = 0; i < m.v.length; i++) max = Math.max(max, Math.abs(m.v[i]));
    var q = Math.min(Q, Math.floor(32000 / max));
    var v = [];
    for (i = 0; i < m.v.length; i++) v.push(Math.round(m.v[i] * q));
    return { v: v, f: m.f.slice(), s: q, from: (prev && prev.from) || 'mesh' };
  }
  function decodeMesh(d) {
    var s = num(d.s, Q), v = [], raw = d.v || [];
    for (var i = 0; i < raw.length; i++) v.push(raw[i] / s);
    return { v: v, f: (d.f || []).slice() };
  }

  /** The golden fingerprint. If a generator ever changes, this number changes,
   *  and every saved sculpt indexed against the old ordering is invalid. Pin it
   *  in a test; bump `VERSION` and write a migration if it must move. */
  function golden() {
    var acc = 2166136261;
    var mix = function (x) { acc ^= x | 0; acc = Math.imul(acc, 16777619); };
    for (var s = 0; s < MESHABLE.length; s++) {
      for (var res = 0; res <= 2; res++) {
        var m = baseMesh(MESHABLE[s], {}, res);
        mix(m.v.length); mix(m.f.length);
        for (var i = 0; i < m.v.length; i++) mix(Math.round(m.v[i] * 1e6));
        for (var j = 0; j < m.f.length; j++) mix(m.f[j]);
        for (var k = 0; k < m.sym.length; k++) mix(m.sym[k]);
      }
    }
    return acc >>> 0;
  }

  // =======================================================================
  // Geometry
  // =======================================================================

  function geoKey(sh, d) {
    var r = function (v, f) { return Math.round((v || 0) * (f || 1000)); };
    d = d || {};
    var k = sh + '|' + [d.w, d.h, d.l, d.r, d.r1, d.r2, d.seg, d.ws, d.hs, d.rs, d.ts,
      d.tw, d.tl, d.arc, d.depth, d.bevel, d.bevelSeg, d.taper, d.rseg]
      .map(function (v) { return r(v); }).join(',');
    // Array-valued dimensions (an extrude outline, a lathe profile, a tube
    // path) MUST take part in the key or two different shapes collide in the
    // cache and the second one silently renders as the first.
    if (d.outline || d.profile || d.path)
      k += '|' + hashStr(JSON.stringify([d.outline || 0, d.profile || 0, d.path || 0]));
    if (d.sym || d.num) k += '|' + d.sym + ':' + d.num;
    if (d.closed) k += '|c';
    return k;
  }

  function makeGeo(sh, d) {
    d = d || {};
    var key = geoKey(sh, d);
    var hit = geoCache.get(key);
    if (hit) return hit;
    var g = null;
    switch (sh) {
      case 'box':
        g = new THREE.BoxGeometry(num(d.w, 0.3), num(d.h, 0.3), num(d.l, 0.3));
        break;
      case 'cyl':
        g = new THREE.CylinderGeometry(num(d.r1, num(d.r, 0.15)), num(d.r2, num(d.r, 0.15)),
          num(d.h, 0.4), Math.max(3, Math.min(24, num(d.seg, 8) | 0)));
        break;
      case 'cone':
        g = new THREE.ConeGeometry(num(d.r, 0.15), num(d.h, 0.4),
          Math.max(3, Math.min(24, num(d.seg, 8) | 0)));
        break;
      case 'sph':
        g = new THREE.SphereGeometry(num(d.r, 0.2),
          Math.max(4, Math.min(24, num(d.ws, 10) | 0)), Math.max(3, Math.min(18, num(d.hs, 8) | 0)));
        break;
      case 'torus':
        g = new THREE.TorusGeometry(num(d.r, 0.15), num(d.r2, 0.03),
          Math.max(3, Math.min(12, num(d.rs, 6) | 0)), Math.max(4, Math.min(24, num(d.ts, 12) | 0)),
          num(d.arc, Math.PI * 2));
        break;
      case 'plate':
        g = new THREE.PlaneGeometry(num(d.w, 0.3), num(d.h, 0.3));
        break;
      case 'prism':
        // A 4-sided cylinder is a diamond in plan — the grav-hull trick.
        g = new THREE.CylinderGeometry(0.5, 0.5, num(d.h, 0.3), Math.max(3, num(d.seg, 4) | 0));
        g.scale(num(d.w, 0.3), 1, num(d.l, 0.3));
        break;
      case 'wedge':
        g = wedgeGeo(num(d.w, 0.3), num(d.h, 0.3), num(d.l, 0.3));
        break;
      case 'trapezoid':
        g = trapGeo(num(d.w, 0.3), num(d.h, 0.3), num(d.l, 0.3), num(d.tw, 0.15), num(d.tl, 0.15));
        break;
      case 'extrude':
        g = extrudeGeo(d);
        break;
      case 'lathe':
        g = latheGeo(d);
        break;
      case 'tube':
        g = tubeGeo(d);
        break;
      case 'decal':
        g = new THREE.PlaneGeometry(num(d.w, 0.2), num(d.h, 0.2));
        break;
      case 'mesh':
        return meshPartGeo(d);                   // owns its own cache key
      default:
        g = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    }
    geoCache.set(key, g);
    return g;
  }

  /** EXTRUDE — a 2D outline swept along Z, optionally bevelled and tapered.
   *
   *  The outline lives in the document as points, so selecting the part reopens
   *  it for editing (FORGE_PLAN §4.1: one-shot extrusion would be a trap). A
   *  point may carry a third element to mark it as an ARC control point, so a
   *  curved plate edge costs two points instead of forty.
   *
   *  Note for Phase 4: extrude/lathe/tube vertex order comes from Three.js, not
   *  from us, so these shapes are NOT sculptable — only the hand-authored
   *  primitives have the stable ordering that sparse sculpt deltas need. */
  function extrudeGeo(d) {
    var pts = (d.outline && d.outline.length >= 3) ? d.outline
      : [[-0.15, -0.1], [0.15, -0.1], [0.18, 0.08], [0, 0.16], [-0.18, 0.08]];
    var shape = new THREE.Shape();
    shape.moveTo(num(pts[0][0], 0), num(pts[0][1], 0));
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i];
      if (p[2]) {                                     // arc: p is the control point
        var nxt = pts[i + 1] || pts[0];
        shape.quadraticCurveTo(num(p[0], 0), num(p[1], 0), num(nxt[0], 0), num(nxt[1], 0));
        i++;
      } else shape.lineTo(num(p[0], 0), num(p[1], 0));
    }
    shape.closePath();
    var depth = Math.max(0.002, num(d.depth, 0.2));
    var bev = Math.max(0, num(d.bevel, 0));
    var g = new THREE.ExtrudeGeometry(shape, {
      depth: depth, bevelEnabled: bev > 0,
      bevelThickness: bev, bevelSize: bev, bevelOffset: 0,
      bevelSegments: Math.max(1, Math.min(4, num(d.bevelSeg, 1) | 0)),
      curveSegments: Math.max(2, Math.min(16, num(d.curveSeg, 6) | 0)),
    });
    // Per-face taper: scale the cross-section toward the far end. This is what
    // turns a plate into a blade, a wedge or a tapered nacelle.
    var taper = num(d.taper, 1);
    var pos = g.attributes.position, a = pos.array;
    for (var vi = 0; vi < a.length; vi += 3) {
      if (taper !== 1) {
        var f = 1 + (taper - 1) * Math.max(0, Math.min(1, a[vi + 2] / depth));
        a[vi] *= f; a[vi + 1] *= f;
      }
      a[vi + 2] -= depth / 2;                          // centre it on its origin
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  /** LATHE — revolve a profile. Domes, helmets, nacelles, shell casings. */
  function latheGeo(d) {
    var prof = (d.profile && d.profile.length >= 2) ? d.profile
      : [[0.02, -0.15], [0.14, -0.1], [0.16, 0.04], [0.09, 0.14], [0, 0.17]];
    var v = [];
    for (var i = 0; i < prof.length; i++)
      v.push(new THREE.Vector2(Math.max(0, num(prof[i][0], 0)), num(prof[i][1], 0)));
    return new THREE.LatheGeometry(v, Math.max(3, Math.min(24, num(d.seg, 10) | 0)),
      0, num(d.arc, Math.PI * 2));
  }

  /** TUBE — a swept round section along a spline. Cables, pipes, barrels,
   *  exhaust runs, gun-shield ribs. */
  function tubeGeo(d) {
    var path = (d.path && d.path.length >= 2) ? d.path : [[0, 0, -0.2], [0, 0.08, 0], [0, 0, 0.2]];
    var v = [];
    for (var i = 0; i < path.length; i++)
      v.push(new THREE.Vector3(num(path[i][0], 0), num(path[i][1], 0), num(path[i][2], 0)));
    var curve = new THREE.CatmullRomCurve3(v, !!d.closed);
    return new THREE.TubeGeometry(curve,
      Math.max(2, Math.min(48, num(d.seg, 10) | 0)), Math.max(0.002, num(d.r, 0.03)),
      Math.max(3, Math.min(16, num(d.rseg, 6) | 0)), !!d.closed);
  }

  // ---- decal symbols ------------------------------------------------------
  // A painted marking on a thin plate: lozenge, roundel, chevron, numerals.
  // Textures are immutable so they cache globally; the MATERIAL that carries
  // one is per-unit, because it is lit and therefore flashes on hit (rule 3).
  var decalTexCache = new Map();
  var DECAL_SYMS = ['star', 'cross', 'roundel', 'chevron', 'bar', 'skull',
                    'glyph', 'lozenge', 'num', 'ring', 'arrow'];

  function decalTexture(sym, colHex, num_) {
    var key = sym + '|' + colHex + '|' + (num_ || '');
    var hit = decalTexCache.get(key);
    if (hit) return hit;
    var S = 128;
    var cv = document.createElement('canvas'); cv.width = cv.height = S;
    var c = cv.getContext('2d');
    var col = '#' + ('000000' + colHex.toString(16)).slice(-6);
    c.clearRect(0, 0, S, S);
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = S * 0.11;
    c.lineJoin = 'miter';
    var M = S / 2;
    function poly(n, r, rot, inner) {
      c.beginPath();
      for (var i = 0; i < n * (inner ? 2 : 1); i++) {
        var rr = inner && (i % 2) ? r * inner : r;
        var a = rot + i * Math.PI * 2 / (n * (inner ? 2 : 1));
        var x = M + Math.sin(a) * rr, y = M - Math.cos(a) * rr;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.fill();
    }
    switch (sym) {
      case 'star': poly(5, M * 0.88, 0, 0.42); break;
      case 'cross':
        c.fillRect(M - S * 0.11, S * 0.08, S * 0.22, S * 0.84);
        c.fillRect(S * 0.14, M - S * 0.11, S * 0.72, S * 0.22); break;
      case 'roundel':
        c.beginPath(); c.arc(M, M, M * 0.82, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(M, M, M * 0.34, 0, Math.PI * 2); c.fill(); break;
      case 'ring':
        c.beginPath(); c.arc(M, M, M * 0.74, 0, Math.PI * 2); c.stroke(); break;
      case 'chevron':
        c.beginPath(); c.moveTo(S * 0.1, S * 0.74); c.lineTo(M, S * 0.24);
        c.lineTo(S * 0.9, S * 0.74); c.stroke(); break;
      case 'arrow':
        c.beginPath(); c.moveTo(M, S * 0.1); c.lineTo(S * 0.88, M); c.lineTo(S * 0.62, M);
        c.lineTo(S * 0.62, S * 0.9); c.lineTo(S * 0.38, S * 0.9); c.lineTo(S * 0.38, M);
        c.lineTo(S * 0.12, M); c.closePath(); c.fill(); break;
      case 'bar':
        c.fillRect(S * 0.06, S * 0.3, S * 0.88, S * 0.16);
        c.fillRect(S * 0.06, S * 0.56, S * 0.88, S * 0.16); break;
      case 'skull':
        c.beginPath(); c.arc(M, M * 0.85, M * 0.55, 0, Math.PI * 2); c.fill();
        c.fillRect(M - M * 0.3, M * 1.2, M * 0.6, M * 0.5);
        c.save(); c.globalCompositeOperation = 'destination-out';
        c.beginPath(); c.arc(M * 0.72, M * 0.82, M * 0.17, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(M * 1.28, M * 0.82, M * 0.17, 0, Math.PI * 2); c.fill();
        c.fillRect(M - M * 0.1, M * 1.2, M * 0.2, M * 0.42);
        c.restore(); break;
      case 'lozenge': case 'sept':                  // a pierced lozenge (`sept`: its name before round 112)
        c.beginPath(); c.moveTo(M, S * 0.06); c.lineTo(S * 0.94, M);
        c.lineTo(M, S * 0.94); c.lineTo(S * 0.06, M); c.closePath(); c.fill();
        c.save(); c.globalCompositeOperation = 'destination-out';
        c.beginPath(); c.arc(M, M, M * 0.3, 0, Math.PI * 2); c.fill(); c.restore(); break;
      case 'glyph':                                 // a crude daubed glyph
        c.beginPath(); c.moveTo(S * 0.16, S * 0.9); c.lineTo(S * 0.44, S * 0.1);
        c.lineTo(S * 0.62, S * 0.62); c.lineTo(S * 0.86, S * 0.14); c.stroke();
        c.fillRect(S * 0.66, S * 0.72, S * 0.24, S * 0.18); break;
      default:                                      // numerals
        c.font = 'bold ' + Math.round(S * 0.86) + 'px Impact, Haettenschweiler, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(num_ == null ? 7 : num_).slice(0, 2), M, M * 1.04);
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    decalTexCache.set(key, tex);
    return tex;
  }

  function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }

  /** A right prism with a triangular profile — the workhorse for angled plate,
   *  beaks, blades and glacis. Built by hand so the vertex order is OURS and
   *  stays stable forever (Phase 4's sculpt deltas index into it). */
  function wedgeGeo(w, h, l) {
    var x = w / 2, y = h / 2, z = l / 2;
    var v = [
      -x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z,   // base quad 0..3
      -x, y, -z, x, y, -z,                           // top edge   4..5
    ];
    var f = [
      0, 1, 2, 0, 2, 3,       // bottom
      4, 5, 1, 4, 1, 0,       // back
      3, 2, 5, 3, 5, 4,       // slope
      0, 3, 4,                // left
      1, 5, 2,                // right
    ];
    return buildGeo(v, f);
  }

  /** A box with an independently sized top face: nacelles, tapered hulls,
   *  greaves, gun receivers. */
  function trapGeo(w, h, l, tw, tl) {
    var x = w / 2, y = h / 2, z = l / 2, tx = tw / 2, tz = tl / 2;
    var v = [
      -x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z,
      -tx, y, -tz, tx, y, -tz, tx, y, tz, -tx, y, tz,
    ];
    var f = [
      0, 1, 2, 0, 2, 3,       // bottom
      7, 6, 5, 7, 5, 4,       // top
      0, 4, 5, 0, 5, 1,       // back
      3, 2, 6, 3, 6, 7,       // front
      0, 3, 7, 0, 7, 4,       // left
      1, 5, 6, 1, 6, 2,       // right
    ];
    return buildGeo(v, f);
  }

  function buildGeo(verts, faces) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(faces);
    g.computeVertexNormals();
    return g;
  }

  // =======================================================================
  // Materials
  // =======================================================================

  function hex(c, dflt) {
    if (typeof c === 'number') return c;
    if (typeof c === 'string') {
      var s = c.charAt(0) === '#' ? c.slice(1) : c;
      var n = parseInt(s, 16);
      if (isFinite(n)) return n;
    }
    return dflt == null ? 0x888888 : dflt;
  }

  /** Build the palette. Returns { byId, flashMats }.
   *
   *  `flashMats` is what the game mutates on hit (`m.emissive.setRGB`) and on
   *  death (`m.color.multiplyScalar`) — so ONLY lit materials go in it, and
   *  they are freshly built per unit, never cached. Unlit glow/team materials
   *  have no `.emissive` and would throw, and caching a lit one would flash
   *  every unit of the type at once. */
  var WEATHER_VARIANTS = 4;   // shade steps per palette entry — see buildPalette

  function buildPalette(doc, teamC) {
    var byId = {}, flashMats = [], variants = {}, edges = {};
    var pal = doc.palette || [];
    var weather = num(doc.weather, 0);
    // Edge highlighting is how miniature painters make low-poly read at
    // tabletop distance: a slightly lighter shade on the parts that catch the
    // light. Only built if something actually asks for it, and bounded by
    // palette size — one extra material per entry, never one per part.
    var wantEdge = (doc.parts || []).some(function (p) { return p && p.edge; });
    for (var i = 0; i < pal.length; i++) {
      var e = pal[i], m;
      if (e.team) {
        // `team: true` = the unit's team colour. `team: 2` = the secondary
        // channel, a darker accent off the same hue (stripes, squad flashes).
        var tc = e.team === 2 ? shadeHex(teamC, 0.52) : teamC;
        m = cachedUnlit('team' + tc, function () {
          return new THREE.MeshBasicMaterial({ color: tc });
        });
      } else if (e.glow) {
        m = cachedUnlit('glow' + hex(e.c) + (e.add !== false ? 'a' : ''), function () {
          var o = { color: hex(e.c, 0xffffff), toneMapped: false };
          if (e.add !== false) { o.blending = THREE.AdditiveBlending; o.transparent = true; o.depthWrite = false; }
          if (e.o != null) { o.transparent = true; o.opacity = e.o; }
          return new THREE.MeshBasicMaterial(o);
        });
      } else {
        // Every property the factory can set is in the key; `e` is a loop
        // var, but litMat calls make() synchronously so the closure is safe.
        var lk = 'std|' + hex(e.c, 0x888888) + '|' + num(e.rough, 0.8) + '|' + num(e.metal, 0)
          + '|' + (e.flat !== false ? 1 : 0) + '|' + (e.emissive ? hex(e.emissive, 0) : -1);
        m = litMat(lk, function () {
          var mm = new THREE.MeshStandardMaterial({
            color: hex(e.c, 0x888888),
            roughness: num(e.rough, 0.8),
            metalness: num(e.metal, 0),
            flatShading: e.flat !== false,
          });
          if (e.emissive) mm.emissive = new THREE.Color(hex(e.emissive, 0));
          return mm;
        });
        flashMats.push(m);
        // Weathering: a FIXED number of shade variants per palette entry, not
        // one clone per part. `_updateModelAnim` walks flashMats every frame for
        // every unit, so per-part clones would put the whole part list in that
        // loop — a 150-part model would cost 150 setRGB calls a frame instead
        // of a handful. Parts pick a variant from the seeded rng.
        if (weather > 0) {
          var list = [m];
          for (var w = 1; w < WEATHER_VARIANTS; w++) {
            var k = 1 + ((w / (WEATHER_VARIANTS - 1)) - 0.5) * weather;
            var c = litMat(lk + '|w' + w + ':' + weather, function () {   // k depends on `weather`, so it is in the key
              var cc = m.clone();
              cc.color.multiplyScalar(Math.max(0.55, Math.min(1.45, k)));
              return cc;
            });
            list.push(c);
            flashMats.push(c);
          }
          variants[e.id] = list;
        }
        if (wantEdge) {
          var hi = litMat(lk + '|edge', function () {
            var h = m.clone();
            h.color.multiplyScalar(1.34);
            return h;
          });
          flashMats.push(hi);
          edges[e.id] = hi;
        }
      }
      byId[e.id] = m;
    }
    if (!flashMats.length) {
      // The game indexes flashMats[0] and [1] unconditionally for bodyMat /
      // headMat, so there must always be at least one lit material.
      var fallback = litMat('std|fallback', function () {
        return new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.8, flatShading: true });
      });
      flashMats.push(fallback);
      if (!byId._default) byId._default = fallback;
    }
    if (!byId._default) byId._default = flashMats[0];
    return { byId: byId, flashMats: flashMats, variants: variants, edges: edges };
  }

  function cachedUnlit(key, make) {
    var hit = matCacheUnlit.get(key);
    if (!hit) { hit = make(); matCacheUnlit.set(key, hit); }
    return hit;
  }

  /** A lit material: fresh for a unit, shared under buildProp. Calls make()
   *  synchronously, so callers may close over loop variables. */
  function litMat(key, make) {
    if (!sharedLit) return make();
    var hit = matCacheLit.get(key);
    if (!hit) { hit = make(); matCacheLit.set(key, hit); }
    return hit;
  }

  function shadeHex(c, k) {
    var r = Math.min(255, Math.round(((c >> 16) & 255) * k));
    var g = Math.min(255, Math.round(((c >> 8) & 255) * k));
    var b = Math.min(255, Math.round((c & 255) * k));
    return (r << 16) | (g << 8) | b;
  }

  // =======================================================================
  // Skeletons
  // =======================================================================

  /** Build the requested skeleton and return { group, rig, joints }.
   *  `joints` maps every guaranteed joint name to an Object3D — ALWAYS
   *  complete, even for joints nothing hangs off (rule 2). */
  function buildSkeleton(doc, teamC) {
    var skel = doc.skeleton || 'static';
    var pr = doc.proportions || {};
    var rig = null, group = null;

    if (skel === 'humanoid' && G.rigs && G.rigs.infantry) {
      var built = G.rigs.infantry(hex(pr.uniformC, 0x6a6a5a), hex(pr.skinC, 0xbfa07e), {
        helmet: pr.helmet || 'none', webbing: pr.webbing || 'none',
        pack: !!pr.pack, gearC: hex(pr.gearC, 0x3a3a30),
      });
      group = built.g; rig = built.rig;
      // Proportion knobs, applied the way orkify() does.
      if (pr.hunch != null) rig.hunch = pr.hunch;
      if (pr.bulk) rig.spine.scale.set(pr.bulk, num(pr.tall, 1), pr.bulk);
      if (pr.armLen) { rig.armL.scale.y = pr.armLen; rig.armR.scale.y = pr.armLen; }
      if (pr.legLen) { rig.legL.scale.y = pr.legLen; rig.legR.scale.y = pr.legLen; }
      if (pr.hipsY != null) rig.hips.position.y = pr.hipsY;
      if (pr.neckY != null) rig.neck.position.y = pr.neckY;
      if (pr.stripBody) hideStock(rig);
    } else if (skel === 'suit' && G.rigs && G.rigs.suitRig) {
      rig = G.rigs.suitRig({
        scale: num(pr.scale, 1), hipY: pr.hipY, torsoY: pr.torsoY, headY: pr.headY,
        headZ: pr.headZ, hipW: pr.hipW, thighL: pr.thighL, shinL: pr.shinL,
        shW: pr.shW, shY: pr.shY, armY: pr.armY, packY: pr.packY, packZ: pr.packZ,
      });
      group = rig.g;
    } else if (skel === 'quad') {
      var q = buildQuadRig(pr);
      group = q.group; rig = q.rig;
    } else if (skel === 'flyer') {
      var fl = buildFlyerRig(pr);
      group = fl.group; rig = fl.rig;
    } else if (skel === 'hull') {
      var r = buildHullRig(pr);
      group = r.group; rig = r.rig;
    } else {
      group = new THREE.Group();
      var body = new THREE.Group(); group.add(body);
      rig = { g: group, body: body, static: skel !== 'custom' };
      if (skel === 'custom') rig.custom = true;
    }

    // Collect the guaranteed joints, then backfill anything the builder didn't
    // provide with an empty group so a lookup can never come back undefined.
    var joints = {};
    var want = JOINTS[skel] || JOINTS.static;
    for (var i = 0; i < want.length; i++) {
      var name = want[i];
      var o = rig[name];
      if (!o || !o.isObject3D) {
        o = new THREE.Group();
        (rig.body || group).add(o);
        rig[name] = o;
      }
      joints[name] = o;
    }
    if (!joints.body) { joints.body = rig.body || group; }
    return { group: group, rig: rig, joints: joints };
  }

  /** Hide the stock infantry's own greebles so a player model can replace the
   *  body entirely while keeping the skeleton and its animation. */
  function hideStock(rig) {
    var keep = {};
    ['body', 'hips', 'spine', 'neck', 'head', 'aim', 'legL', 'legR', 'kneeL',
     'kneeR', 'bootL', 'bootR', 'armL', 'armR', 'elbowL', 'elbowR', 'handL',
     'handR'].forEach(function (k) { if (rig[k]) keep[rig[k].uuid] = true; });
    (rig.body || rig.g).traverse(function (o) {
      if (o.isMesh && !keep[o.uuid]) o.visible = false;
    });
  }

  /** QUAD — four legs on the suit animator. `_poseSuit` walks `rig.legs[]` and
   *  reads each entry's `phase`, so a trot (diagonal pairs) is four numbers
   *  rather than a second animator. */
  function buildQuadRig(pr) {
    var S = num(pr.scale, 1);
    var group = new THREE.Group();
    var body = new THREE.Group(); group.add(body);
    var hips = new THREE.Group(); hips.position.y = num(pr.hipY, 1.0) * S; body.add(hips);
    var torso = new THREE.Group(); torso.position.z = num(pr.torsoZ, 0.5) * S; hips.add(torso);
    var head = new THREE.Group();
    head.position.set(0, num(pr.headY, 0.35) * S, num(pr.headZ, 0.55) * S); torso.add(head);
    var pack = new THREE.Group(); pack.position.set(0, num(pr.packY, 0.2) * S, -num(pr.packZ, 0.3) * S); torso.add(pack);
    var rig = { g: group, body: body, hips: hips, torso: torso, head: head, pack: pack,
      S: S, suit: true, quad: true, jets: [], legs: [], crewServed: false, lowProfile: false };
    // Front pair on the torso, rear pair on the hips. A trot is diagonal, so
    // front-left shares a phase with rear-right.
    var sets = [
      { k: 'L', parent: torso, z: 0, side: -1, phase: 0 },
      { k: 'R', parent: torso, z: 0, side: 1, phase: Math.PI },
      { k: 'L2', parent: hips, z: -num(pr.rearZ, 0.5) * S, side: -1, phase: Math.PI },
      { k: 'R2', parent: hips, z: -num(pr.rearZ, 0.5) * S, side: 1, phase: 0 },
    ];
    for (var i = 0; i < sets.length; i++) {
      var s = sets[i];
      var hip = new THREE.Group();
      hip.position.set(s.side * num(pr.hipW, 0.32) * S, 0, s.z);
      s.parent.add(hip);
      var knee = new THREE.Group(); knee.position.y = -num(pr.thighL, 0.45) * S; hip.add(knee);
      var ankle = new THREE.Group(); ankle.position.y = -num(pr.shinL, 0.45) * S; knee.add(ankle);
      rig['leg' + s.k] = hip; rig['knee' + s.k] = knee; rig['foot' + s.k] = ankle;
      rig.legs.push({ hip: hip, knee: knee, ankle: ankle, side: s.side, phase: s.phase });
    }
    for (var j = 0; j < 2; j++) {                 // optional weapon arms on the torso
      var kk = j ? 'R' : 'L';
      var sh = new THREE.Group();
      sh.position.set((j ? 1 : -1) * num(pr.shW, 0.4) * S, num(pr.shY, 0.2) * S, 0.1 * S);
      torso.add(sh);
      var arm = new THREE.Group(); arm.position.y = -num(pr.armY, 0.1) * S; sh.add(arm);
      rig['sh' + kk] = sh; rig['arm' + kk] = arm;
    }
    return { group: group, rig: rig };
  }

  /** FLYER — a hull that hovers, banks and spins something. The lift and the
   *  roll already come from `_updateModelAnim`'s hover branch; this just gives
   *  the parts somewhere to hang, and `rotor` a bone a driver can spin. */
  function buildFlyerRig(pr) {
    var group = new THREE.Group();
    var body = new THREE.Group(); group.add(body);
    var hull = new THREE.Group(); hull.position.y = num(pr.hullY, 0.4); body.add(hull);
    var rotor = new THREE.Group(); rotor.position.y = num(pr.rotorY, 0.9); hull.add(rotor);
    var gun = new THREE.Group(); gun.position.set(0, num(pr.gunY, -0.1), num(pr.gunZ, 0.5)); hull.add(gun);
    var tail = new THREE.Group(); tail.position.z = -num(pr.tailZ, 1.2); hull.add(tail);
    var rig = { g: group, body: body, hull: hull, rotor: rotor, gun: gun, tail: tail, flyer: true };
    for (var i = 0; i < 2; i++) {
      var w = new THREE.Group();
      w.position.set((i ? 1 : -1) * num(pr.wingW, 0.9), num(pr.wingY, 0), 0);
      hull.add(w);
      rig['wing' + (i ? 'R' : 'L')] = w;
    }
    return { group: group, rig: rig };
  }

  /** A vehicle: hull body, a turret that the game's own code yaw-tracks onto
   *  the target, a gun that elevates, and a deck for anything else. */
  function buildHullRig(pr) {
    var group = new THREE.Group();
    var body = new THREE.Group(); group.add(body);
    var deck = new THREE.Group(); deck.position.y = num(pr.deckY, 0.7); body.add(deck);
    var turret = new THREE.Group(); turret.position.y = num(pr.turretY, 1.0); body.add(turret);
    var gun = new THREE.Group(); gun.position.y = num(pr.gunY, 0.2); turret.add(gun);
    var rig = { g: group, body: body, deck: deck, turret: turret, gun: gun, hull: true };
    return { group: group, rig: rig };
  }

  // =======================================================================
  // buildModel — the contract
  // =======================================================================

  function placeholder(msg) {
    var group = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({ color: 0xff00c8, roughness: 0.4, flatShading: true });
    var m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.6), mat);
    m.position.y = 0.6; group.add(m);
    var body = new THREE.Group(); group.add(body);
    if (msg && window.console) console.warn('[TCM] ' + msg);
    return {
      group: group, flashMats: [mat], turret: null, barrelTip: null,
      muzzle: null, weapon: null, rig: null, drones: null, broken: true,
    };
  }

  /** Build a model document into the MODEL_BUILDERS contract. Never throws. */
  function buildModel(doc, unit, teamC) {
    if (!G || !THREE) return { group: new THREE.Group ? new THREE.Group() : null, flashMats: [] };
    try {
      doc = migrate(doc);
      var v = validate(doc);
      if (!v.ok) return placeholder('"' + (doc && doc.id) + '" invalid: ' + v.errors.join('; '));

      var sk = buildSkeleton(doc, teamC);
      var rig = sk.rig, joints = sk.joints, group = sk.group;

      // --- custom bones, in parent-before-child order --------------------
      var bones = orderBones(doc.bones || []);
      for (var i = 0; i < bones.length; i++) {
        var b = bones[i];
        var parent = joints[b.parent] || joints.body;
        var o = new THREE.Group();
        if (b.p) o.position.set(num(b.p[0], 0), num(b.p[1], 0), num(b.p[2], 0));
        if (b.r) o.rotation.set(num(b.r[0], 0), num(b.r[1], 0), num(b.r[2], 0));
        parent.add(o);
        joints[b.id] = o;
        rig[b.id] = o;
        if (b.tag) { rig['tag_' + b.tag] = o; }
      }

      // --- semantic tags + rest pose --------------------------------------
      // `rig._tag` is what every shared procedural system resolves through, so
      // a from-scratch skeleton earns the same behaviours a stock one does.
      // `rig._rest` is what the clip animator returns bones to each frame
      // before it lays a clip on top.
      var skelName = doc.skeleton || 'static';
      rig._tag = {};
      var preset = STOCK_TAGS[skelName] || {};
      for (var tk in preset) if (joints[preset[tk]]) rig._tag[tk] = joints[preset[tk]];
      for (var bi = 0; bi < bones.length; bi++) {
        var bb = bones[bi];
        if (bb.tag && joints[bb.id]) rig._tag[bb.tag] = joints[bb.id];   // a custom bone wins
      }
      rig._rest = {};
      for (var jn in joints) {
        var jo = joints[jn];
        rig._rest[jn] = { p: [jo.position.x, jo.position.y, jo.position.z],
          r: [jo.rotation.x, jo.rotation.y, jo.rotation.z] };
      }
      rig._joints = joints;

      // --- materials ------------------------------------------------------
      var pal = buildPalette(doc, teamC);
      pal._teamC = teamC;
      var weather = num(doc.weather, 0);
      var rng = mulberry(hashStr(doc.id || 'tcm'));

      // --- parts ----------------------------------------------------------
      var tagged = {}, jets = [], byId = {};
      var parts = doc.parts || [];
      for (var pi = 0; pi < parts.length; pi++) {
        var p = parts[pi];
        var sides = p.mirror ? [1, -1] : [1];
        for (var si = 0; si < sides.length; si++) {
          var node = makePart(p, sides[si], joints, pal, doc, weather, rng);
          if (!node) continue;
          if (si === 0) {
            byId[p.id] = node;
            (p.tags || []).forEach(function (t) {
              if (t === 'jet') jets.push(node); else tagged[t] = node;
            });
          } else if ((p.tags || []).indexOf('jet') >= 0) jets.push(node);
        }
      }

      // --- attachments ----------------------------------------------------
      var att = doc.attach || {};
      var muzzle = byId[att.muzzle] || tagged.muzzle || null;
      var barrelTip = byId[att.barrelTip] || tagged.barrelTip || muzzle;
      var turret = byId[att.turret] || tagged.turret || (rig.hull ? rig.turret : null);
      if (jets.length && Array.isArray(rig.jets)) rig.jets = rig.jets.concat(jets);
      else if (jets.length) rig.jets = jets;

      // --- rig flags the animators read -----------------------------------
      var flags = doc.flags || {};
      if (flags.crewServed) rig.crewServed = true;
      if (flags.lowProfile) rig.lowProfile = true;
      if (flags.brute || flags.ork) rig.brute = true;   // (`ork`: the flag's name in models saved before round 112)
      if (flags.hunch != null) rig.hunch = flags.hunch;
      if (tagged.heatVent) rig.heatVent = tagged.heatVent;

      // --- pose overrides, clips + drivers --------------------------------
      if (doc.poses) group.userData.tcmPoses = doc.poses;
      // Authored clips (Tier 3). The game already decides which state a unit is
      // in — `_stance()` returns exactly these names — so the generic animator
      // is "play the clip whose name matches the stance", reusing the whole
      // existing state-selection brain rather than inventing a state machine.
      if (doc.clips && Object.keys(doc.clips).length) {
        group.userData.tcmClips = compileClips(doc.clips, joints);
        rig.generic = true;
      }
      var drivers = compileDrivers(doc.drivers || [], joints);
      if (drivers.length) group.userData.tcmDrivers = drivers;
      // Two-bone blend (FORGE_PLAN §6.7). Parts are rigidly parented — that is
      // the art direction, not a shortcut, because this game is made of armour
      // plates and rigid parenting is CORRECT for those. The one case it looks
      // wrong is a part that should follow two joints at once: a shoulder pad
      // that trails the arm a little, a robe that trails the hips. So a part
      // may name a secondary bone and a weight, and its transform interpolates
      // between them. No skinning machinery, no weight painting, and it fixes
      // almost everything vertex skinning would have.
      var blends = compileBlends(parts, byId, joints);
      if (blends.length) group.userData.tcmBlends = blends;
      group.userData.tcm = doc.id;

      if (doc.scale && doc.scale !== 1) group.scale.setScalar(doc.scale);
      if (G.helpers && G.helpers.shadow) G.helpers.shadow(group);

      return {
        group: group, flashMats: pal.flashMats, turret: turret,
        barrelTip: barrelTip, muzzle: muzzle,
        weapon: tagged.weapon || null,
        // The game reads a non-null `unit.rig` as "drive this through a pose
        // engine", and each engine indexes joints its own skeleton guarantees.
        // So only hand back a rig the animators can actually drive: humanoid →
        // _poseInfantry, suit/quad → _poseSuit, anything with authored clips →
        // _poseGeneric. Everything else animates through the hull/hover/bob
        // paths, which need no rig at all. Getting this wrong is how Batch N4
        // threw three times.
        rig: articulatedRig(skelName, rig) ? rig : null,
        // Tags are still published for the editor's contract check even when
        // the rig itself isn't handed over.
        tags: rig._tag,
        drones: null,
      };
    } catch (e) {
      return placeholder('build of "' + (doc && doc.id) + '" threw: ' + e.message);
    }
  }

  function articulatedRig(skel, rig) {
    if (rig && rig.generic) return true;              // authored clips drive it
    return skel === 'humanoid' || skel === 'suit' || skel === 'quad';
  }

  // =======================================================================
  // CLIPS — the generic animator's data  (FORGE_PLAN §6.6)
  // =======================================================================
  //
  // A clip is keyframes on (bone, channel). The elegant part is that the game
  // ALREADY decides which state a unit is in: `Unit._stance(moving)` returns
  // stand / aim / walk / run / sneak / crouch / kneel / prone / crawl / dig /
  // throw / down. So the animator is "play the clip whose name matches the
  // stance, cross-fading" — it reuses the existing state-selection brain
  // instead of inventing a state machine.

  var CLIP_CHANNELS = ['rx', 'ry', 'rz', 'px', 'py', 'pz', 'sx', 'sy', 'sz'];

  function compileClips(clips, joints) {
    var out = {};
    for (var name in clips) {
      var c = clips[name] || {};
      var tracks = [];
      var src = c.tracks || [];
      for (var i = 0; i < src.length; i++) {
        var t = src[i];
        var o = joints[t.b];
        if (!o || CLIP_CHANNELS.indexOf(t.ch) < 0) continue;
        var keys = (t.k || []).slice().sort(function (a, b) { return a[0] - b[0]; });
        if (!keys.length) continue;
        tracks.push({ o: o, ch: t.ch, k: keys, ease: t.ease || 'linear', bone: t.b });
      }
      out[name] = {
        dur: Math.max(0.02, num(c.dur, 1)),
        loop: c.loop !== false,
        speedSync: !!c.speedSync,
        baseSpd: num(c.baseSpd, 0),
        tracks: tracks,
        events: (c.events || []).slice().sort(function (a, b) { return a.t - b.t; }),
      };
    }
    return out;
  }

  /** Sample one track at time `t` (seconds into the clip). */
  function sampleTrack(tr, t) {
    var k = tr.k, n = k.length;
    if (n === 1) return k[0][1];
    if (t <= k[0][0]) return k[0][1];
    if (t >= k[n - 1][0]) return k[n - 1][1];
    var lo = 0;
    for (var i = 1; i < n; i++) { if (k[i][0] > t) { lo = i - 1; break; } lo = i; }
    var hi = Math.min(n - 1, lo + 1);
    var span = k[hi][0] - k[lo][0];
    if (span <= 1e-9) return k[hi][1];
    var u = (t - k[lo][0]) / span;
    if (tr.ease === 'step') return k[lo][1];
    if (tr.ease === 'ease') u = u * u * (3 - 2 * u);
    return k[lo][1] + (k[hi][1] - k[lo][1]) * u;
  }

  /** Apply a clip's tracks onto the rig at weight `w`, accumulating into an
   *  output map so two clips can cross-fade without fighting each other. */
  function accumClip(clip, t, w, acc) {
    for (var i = 0; i < clip.tracks.length; i++) {
      var tr = clip.tracks[i];
      var v = sampleTrack(tr, t);
      var e = acc.get(tr.o);
      if (!e) { e = {}; acc.set(tr.o, e); }
      e[tr.ch] = (e[tr.ch] || 0) + v * w;
      e['_w' + tr.ch] = (e['_w' + tr.ch] || 0) + w;
    }
  }

  /** Parents before children, so a bone's parent always exists when we add it. */
  function orderBones(bones) {
    var out = [], added = {}, guard = 0;
    var left = bones.slice();
    while (left.length && guard++ < 500) {
      var progressed = false;
      for (var i = left.length - 1; i >= 0; i--) {
        var b = left[i];
        var ready = !b.parent || added[b.parent] || !bones.some(function (x) { return x.id === b.parent; });
        if (ready) { out.push(b); added[b.id] = true; left.splice(i, 1); progressed = true; }
      }
      if (!progressed) break;      // cycle — validate() already flagged it
    }
    return out;
  }

  /** One part instance (plus its array/radial expansion) parented to its joint.
   *  Returns the node the tags should point at. */
  function makePart(p, side, joints, pal, doc, weather, rng) {
    var sh = p.sh || 'box';
    var jname = p.j || 'body';
    if (side < 0 && PAIRED[jname]) jname = PAIRED[jname];
    var parent = joints[jname] || joints.body;
    if (!parent) return null;

    var pos = [num(p.p && p.p[0], 0) * side, num(p.p && p.p[1], 0), num(p.p && p.p[2], 0)];
    var rot = [num(p.r && p.r[0], 0), num(p.r && p.r[1], 0) * side, num(p.r && p.r[2], 0) * side];
    var scl = p.s ? [num(p.s[0], 1), num(p.s[1], 1), num(p.s[2], 1)] : null;

    // A node is an invisible attachment marker — the muzzle, the eye, a slot.
    if (sh === 'node') {
      var n = new THREE.Object3D();
      n.position.set(pos[0], pos[1], pos[2]);
      n.rotation.set(rot[0], rot[1], rot[2]);
      n.userData.tcmPart = p.id; n.userData.tcmSide = side;
      parent.add(n);
      return n;
    }

    // A ref is an instanced sub-model: the whole kit-bashing economy (a stock
    // greeble, a part saved to the personal library, a forked sub-assembly)
    // rides on this one shape. Built fresh per unit so its lit materials belong
    // to THIS unit's flashMats and hitting one soldier can't flash the army.
    if (sh === 'ref') {
      var src = refGroup(p.d && (p.d.ref || p.d.id), pal, doc);
      if (!src) return null;
      var holderR = new THREE.Group();
      holderR.userData.tcmPart = p.id; holderR.userData.tcmSide = side;
      holderR.position.set(pos[0], pos[1], pos[2]);
      holderR.rotation.set(rot[0], rot[1], rot[2]);
      if (scl) holderR.scale.set(scl[0], scl[1], scl[2]);
      // Mirroring reflects the ref's PLACEMENT (pos.x and yaw are already
      // negated above), not its internal geometry — a negative scale would
      // render the sub-model inside-out under backface culling.
      var modR = p.mod || {}, cnt = Math.min(64, instanceCount(p));
      for (var ri = 0; ri < cnt; ri++) {
        var inst = ri === 0 ? src : src.clone();
        if (modR.array || modR.radial) applyMod(inst, ri, modR, side);
        holderR.add(inst);
      }
      parent.add(holderR);
      return holderR;
    }

    var mat = pal.byId[p.m] || pal.byId._default;
    // Weathering: pick one of the pre-built shade variants. Seeded, so a unit
    // looks the same every time it is built instead of flickering on rebuild.
    var vs = pal.variants && pal.variants[p.m];
    if (vs && vs.length > 1) mat = vs[Math.floor(rng() * vs.length) % vs.length];
    if (p.edge && pal.edges && pal.edges[p.m]) mat = pal.edges[p.m];

    // A decal is a painted marking: the palette entry supplies the ink colour,
    // the shape supplies the symbol. Lit, so it joins flashMats — bounded
    // because a model has a handful of markings, not hundreds.
    if (sh === 'decal') {
      var ink = hex((p.d && p.d.c) || paletteColor(doc, p.m) || '#ffffff', 0xffffff);
      var dk = 'decal|' + ((p.d && p.d.sym) || 'star') + '|' + ink + '|' + ((p.d && p.d.num) || '');
      var dm = litMat(dk, function () {         // decalTexture is cached on the same triple
        return new THREE.MeshStandardMaterial({
          map: decalTexture((p.d && p.d.sym) || 'star', ink, p.d && p.d.num),
          transparent: true, roughness: 0.85, metalness: 0, flatShading: true,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
        });
      });
      pal.flashMats.push(dm);
      mat = dm;
    }

    // A sculpt layer sits ON TOP of the parametric shape, not instead of it:
    // the dimensions stay live, so widening the plate widens the dent with it.
    var geo = (p.sculpt && MESHABLE.indexOf(sh) >= 0) ? sculptGeo(sh, p.d, p.sculpt) : makeGeo(sh, p.d);
    var mod = p.mod || {};
    var holder = (mod.array || mod.radial) ? new THREE.Group() : null;
    if (holder) { holder.position.set(pos[0], pos[1], pos[2]); holder.rotation.set(rot[0], rot[1], rot[2]); parent.add(holder); }

    if (holder) { holder.userData.tcmPart = p.id; holder.userData.tcmSide = side; }
    var count = Math.min(64, instanceCount(p));
    var made = null;
    for (var i = 0; i < count; i++) {
      var m = new THREE.Mesh(geo, mat);
      // The editor picks parts by raycast, so every mesh carries its part id.
      m.userData.tcmPart = p.id; m.userData.tcmSide = side;
      if (holder) {
        applyMod(m, i, mod, side);
        holder.add(m);
      } else {
        m.position.set(pos[0], pos[1], pos[2]);
        m.rotation.set(rot[0], rot[1], rot[2]);
        parent.add(m);
      }
      if (scl) m.scale.set(scl[0], scl[1], scl[2]);
      if ((sh === 'plate' || sh === 'decal') && p.d && p.d.face) m.rotation.x -= Math.PI / 2;
      if (!made) made = holder || m;
    }
    return made;
  }

  /** Build a referenced sub-model as a flat static group and fold its lit
   *  materials into the host's flashMats. Depth-capped and cycle-guarded so a
   *  model that refs itself degrades to a marker instead of hanging the tab. */
  var refDepth = 0, refStack = {};
  function refGroup(id, pal, hostDoc) {
    var sub = id && models[id];
    if (!sub || refDepth > 4 || refStack[id]) {
      var g = new THREE.Group();
      var mm = new THREE.MeshBasicMaterial({ color: 0xff00c8 });
      var mk = new THREE.Mesh(makeGeo('box', { w: 0.08, h: 0.08, l: 0.08 }), mm);
      g.add(mk);
      if (window.console && id) console.warn('[TCM] ref "' + id + '" unresolved in "' + (hostDoc && hostDoc.id) + '"');
      return g;
    }
    refDepth++; refStack[id] = true;
    var built;
    try {
      built = buildModel(Object.assign({}, sub, { skeleton: 'static', scale: 1 }), null,
        pal._teamC == null ? 0xffffff : pal._teamC);
    } finally { refDepth--; refStack[id] = false; }
    if (built && built.flashMats) for (var i = 0; i < built.flashMats.length; i++) pal.flashMats.push(built.flashMats[i]);
    return built ? built.group : new THREE.Group();
  }

  function paletteColor(doc, matId) {
    var pal = (doc && doc.palette) || [];
    for (var i = 0; i < pal.length; i++) if (pal[i].id === matId) return pal[i].c;
    return null;
  }

  /** array = a line of copies; radial = copies about an axis. One part plus a
   *  radial modifier is a 12-blade rotor for the cost of one entry. */
  function applyMod(mesh, i, mod, side) {
    if (mod.array) {
      var a = mod.array, st = a.step || [0, 0, 0], rs = a.rstep || [0, 0, 0], ss = a.sstep;
      mesh.position.set(num(st[0], 0) * i * side, num(st[1], 0) * i, num(st[2], 0) * i);
      mesh.rotation.set(num(rs[0], 0) * i, num(rs[1], 0) * i * side, num(rs[2], 0) * i * side);
      if (ss) { var f = 1 + num(ss, 0) * i; mesh.scale.setScalar(Math.max(0.02, f)); }
    }
    if (mod.radial) {
      var r = mod.radial, n = Math.max(1, r.n | 0);
      var ang = (i / n) * Math.PI * 2 + num(r.offset, 0);
      var rad = num(r.r, 0);
      var ax = r.axis || 'y';
      if (ax === 'y') { mesh.position.set(Math.cos(ang) * rad, mesh.position.y, Math.sin(ang) * rad); mesh.rotation.y += -ang; }
      else if (ax === 'z') { mesh.position.set(Math.cos(ang) * rad, Math.sin(ang) * rad, mesh.position.z); mesh.rotation.z += ang; }
      else { mesh.position.set(mesh.position.x, Math.sin(ang) * rad, Math.cos(ang) * rad); mesh.rotation.x += ang; }
    }
  }

  // =======================================================================
  // Drivers — animation for custom bones, with no engine code
  // =======================================================================

  function compileBlends(parts, byId, joints) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p.j2 || !joints[p.j2]) continue;
      var node = byId[p.id];
      if (!node) continue;
      out.push({ o: node, b: joints[p.j2], w: Math.max(0, Math.min(1, num(p.bw, 0.5))),
        base: { x: node.position.x, y: node.position.y, z: node.position.z },
        rest: null });
    }
    return out;
  }

  /** Ticked from `_updateModelAnim` alongside the drivers. Nudges the part
   *  toward where the secondary bone has moved to, in the primary's space. */
  function applyBlends(unit) {
    var g = unit && unit.mesh;
    var list = g && g.userData && g.userData.tcmBlends;
    if (!list || !THREE) return;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.o.parent) continue;
      b.o.parent.updateWorldMatrix(true, false);
      b.b.updateWorldMatrix(true, false);
      if (!b.rest) {
        // Where the secondary bone sits at rest, in the part's parent space.
        b.rest = b.o.parent.worldToLocal(b.b.getWorldPosition(new THREE.Vector3()));
        b.restV = b.rest.clone();
        continue;
      }
      var now = b.o.parent.worldToLocal(b.b.getWorldPosition(new THREE.Vector3()));
      b.o.position.set(
        b.base.x + (now.x - b.restV.x) * b.w,
        b.base.y + (now.y - b.restV.y) * b.w,
        b.base.z + (now.z - b.restV.z) * b.w);
    }
  }

  function compileDrivers(list, joints) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i], o = joints[d.bone];
      if (!o) continue;
      out.push({
        o: o, kind: d.kind || 'spin', axis: d.axis || 'y',
        amp: num(d.amp, 0.2), rate: num(d.rate, 1), when: d.when || null,
        phase: num(d.phase, 0),
        base: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
        baseP: { x: o.position.x, y: o.position.y, z: o.position.z },
      });
    }
    return out;
  }

  /** Called once per frame from `_updateModelAnim`. */
  function applyDrivers(unit, dt, time) {
    var g = unit && unit.mesh;
    var list = g && g.userData && g.userData.tcmDrivers;
    if (!list) return;
    var moving = !!(unit.path && unit.path.length);
    var firing = unit.recoilT > 0;
    var airborne = (unit.airH || 0) > 0.05;
    var dead = !unit.alive;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.when === 'moving' && !moving) { relax(d); continue; }
      if (d.when === 'firing' && !firing) { relax(d); continue; }
      if (d.when === 'airborne' && !airborne) { relax(d); continue; }
      if (d.when === 'dead' && !dead) { relax(d); continue; }
      switch (d.kind) {
        case 'spin':
          d.o.rotation[d.axis] += d.rate * dt;
          break;
        case 'sway':
          d.o.rotation[d.axis] = d.base[d.axis] + Math.sin(time * d.rate + d.phase) * d.amp;
          break;
        case 'bob':
          d.o.position.y = d.baseP.y + Math.sin(time * d.rate + d.phase) * d.amp;
          break;
        case 'recoil':
          d.o.position.z = d.baseP.z - (unit.recoilT || 0) * d.amp * 4;
          break;
        case 'jet': {
          var burn = airborne ? ((unit.jetOn && unit.jetFuel > 0) ? 1 : 0.35) : 0;
          var s = burn > 0 ? 0.5 + burn * (0.7 + crand() * 0.5) : 0.01;
          d.o.scale.setScalar(s);
          d.o.visible = s > 0.05;
          break;
        }
        case 'open':
          d.o.rotation[d.axis] = d.base[d.axis] + (unit.garrison ? d.amp : 0);
          break;
      }
    }
  }
  function relax(d) {
    if (d.kind === 'sway') d.o.rotation[d.axis] += (d.base[d.axis] - d.o.rotation[d.axis]) * 0.1;
    else if (d.kind === 'bob') d.o.position.y += (d.baseP.y - d.o.position.y) * 0.1;
    else if (d.kind === 'jet') { d.o.scale.setScalar(0.01); d.o.visible = false; }
  }

  // =======================================================================
  // Props
  // =======================================================================

  /** Build a prop for one map cell. `doc` may be a prop document, a model
   *  document, or a model id. `seed` (a cell hash) drives per-instance
   *  variation, so a hedge line doesn't read as forty identical clones. */
  function buildProp(doc, teamC, seed) {
    if (typeof doc === 'string') doc = { model: doc };
    doc = doc || {};
    var m = doc.model;
    if (typeof m === 'string') m = models[String(m).replace(/^tcm:/, '')];
    if (!m && doc.parts) m = doc;                          // a bare model doc
    if (!m) return { group: placeholder('prop "' + doc.id + '" has no model').group, height: num(doc.height, 1), broken: true };
    // Share lit materials for the duration of this build (nested refs too).
    // buildModel never throws, but the finally guarantees a stuck flag can
    // never make the next UNIT build share — that is the rule-3 failure.
    var built;
    sharedLit = true;
    try { built = buildModel(Object.assign({}, migrate(m), { skeleton: 'static' }), null, teamC || 0xffffff); }
    finally { sharedLit = false; }
    var g = built.group;
    if (seed != null && !built.broken) {
      var rng = mulberry(seed | 0);
      if (doc.spin !== false) g.rotation.y = rng() * Math.PI * 2;
      var j = num(doc.vary, 0.12);
      if (j > 0) g.scale.multiplyScalar(1 + (rng() - 0.5) * 2 * j);
    }
    return { group: g, height: num(doc.height, 1), broken: !!built.broken };
  }

  // =======================================================================
  // WEAPONS AS DATA  (FORGE_PLAN §2.2, §7.1)
  // =======================================================================
  //
  // Today a unit's behaviour is a `switch` on `def.kind`, and every new weapon
  // means a new branch. That does not scale to player authoring. So a weapon
  // becomes a DOCUMENT with modes, and firing becomes a table lookup on
  // `mode.projectile` instead of a switch on the unit's kind.
  //
  // The projectile names map onto the `Projectiles.fire*` family that already
  // ships — this exposes what exists rather than adding new physics. `beam` is
  // the one genuinely new one, because instant hitscan plus a drawn line
  // unlocks laser / target designator / heat-ray for almost nothing.
  var PROJECTILES = ['bullet', 'pulse', 'shell', 'rocket', 'mortar', 'salvo',
                     'flame', 'grenade', 'arrow', 'beam', 'melee'];
  var TRIGGERS = ['hip', 'ads', 'auto', 'order'];

  var weapons = {};      // id → weapon doc

  function validateWeapon(doc) {
    var errors = [], warnings = [];
    try {
      if (!doc || typeof doc !== 'object') { errors.push('not an object'); return fin(); }
      if (!doc.id) errors.push('missing id');
      var modes = doc.modes || [];
      if (!modes.length) errors.push('a weapon needs at least one mode');
      modes.forEach(function (m, i) {
        var at = 'mode[' + i + (m.name ? ' "' + m.name + '"' : '') + ']';
        if (PROJECTILES.indexOf(m.projectile) < 0) errors.push(at + ' unknown projectile "' + m.projectile + '"');
        if (!(num(m.dmg, 0) > 0)) errors.push(at + ' does no damage');
        if (!(num(m.rng, 0) > 0)) errors.push(at + ' has no range');
        if (m.trigger && TRIGGERS.indexOf(m.trigger) < 0) warnings.push(at + ' unknown trigger "' + m.trigger + '"');
        if (num(m.rof, 0) <= 0 && num(m.cd, 0) <= 0) errors.push(at + ' has neither a rate of fire nor a cooldown');
        if (num(m.burst, 1) > 1 && !(num(m.gap, 0) > 0)) warnings.push(at + ' fires a burst with no gap between rounds');
      });
      if (doc.model && typeof doc.model === 'string' && !models[String(doc.model).replace(/^tcm:/, '')])
        warnings.push('model "' + doc.model + '" is not loaded');
    } catch (e) { errors.push('weapon validator crashed: ' + e.message); }
    return fin();
    function fin() { return { ok: errors.length === 0, errors: errors, warnings: warnings }; }
  }

  /** Seconds between shots for a mode. `rof` is rounds/minute, which is what a
   *  player can reason about; `cd` is an explicit recovery for single-shot
   *  weapons where rounds/minute is a fiction. */
  function modeInterval(m) {
    if (num(m.cd, 0) > 0) return m.cd;
    var rof = num(m.rof, 60);
    return 60 / Math.max(1, rof);
  }

  /** Damage per second, counting the burst pattern honestly: a 3-round burst
   *  every 1.2 s is three times the damage of one round every 1.2 s. */
  function modeDps(m) {
    var burst = Math.max(1, num(m.burst, 1) | 0);
    var iv = modeInterval(m) + (burst > 1 ? (burst - 1) * num(m.gap, 0) : 0);
    return num(m.dmg, 0) * burst / Math.max(0.01, iv);
  }

  /** Cone in mrad, and as a group size at 100 m — the two units a shooter can
   *  actually picture. */
  function modeSpread(m) {
    var cone = num(m.cone, 0);
    return { mrad: cone * 1000, at100: cone * 100 * 2 };
  }

  /**
   * Derive a weapon document from a stock unit def.
   *
   * This is the bridge that makes the refactor testable rather than a leap:
   * every hand-written `kind` branch has a numeric signature (damage, cone,
   * rate of fire, burst, reload), and this reproduces it AS DATA. The parity
   * check in `TCM.weaponParity()` compares the two, unit by unit.
   */
  function weaponFromDef(def, key) {
    var kind = def.kind || 'rifle';
    var mul = 1;
    var m = {
      name: 'Primary', trigger: 'hip', projectile: 'bullet',
      dmg: num(def.dmg, 10) * mul, rng: num(def.rng, 40),
      rof: 60 / Math.max(0.05, num(def.atkTime, 1)),
      cone: 0.02, burst: 1, gap: 0,
      needsLos: true, lay: true, ammo: num(def.ammo, 0),
    };
    // Each branch mirrors the numbers its hand-written counterpart uses.
    if (kind === 'rifle' || kind === 'officer' || kind === 'engineer') {
      m.cone = 0.02; m.sfx = 'rifle'; m.flash = 0.5;
    } else if (kind === 'sniper') {
      m.cone = 0.005; m.sniper = true; m.sfx = 'rifle'; m.flash = 0.35;
    } else if (kind === 'hmg') {
      m.cone = 0.035; m.mg = true; m.heavy = !!def.heavyMg; m.sfx = 'mg'; m.flash = 0.5;
      m.burst = num(def.burst, 6); m.burstPause = 12;      // barrel settles between bursts
    } else if (kind === 'rocket') {
      m.projectile = 'rocket'; m.cone = 0.02; m.aoe = num(def.aoe, 4);
      m.sfx = 'rocket'; m.flash = 0.9;
    } else if (kind === 'tank' || kind === 'apc') {
      m.projectile = def.mgOnly ? 'bullet' : 'shell';
      m.cone = def.mgOnly ? 0.06 : 0.012; m.aoe = num(def.aoe, 3);
      m.mg = !!def.mgOnly; m.sfx = def.mgOnly ? 'mg' : 'cannon'; m.lay = false;
    } else if (kind === 'atgun') {
      m.projectile = 'shell'; m.cone = 0.01; m.aoe = num(def.aoe, 2.5); m.sfx = 'cannon'; m.lay = false;
    } else if (kind === 'mortar' || kind === 'artillery') {
      m.projectile = 'mortar'; m.cone = 0.05; m.aoe = num(def.aoe, 6);
      m.needsLos = false; m.minRng = num(def.minRng, 8); m.sfx = 'mortar';
    } else if (kind === 'flame' || kind === 'flametank') {
      m.projectile = 'flame'; m.cone = 0.09; m.sfx = 'flame'; m.lay = false;
    } else if (kind === 'arrow') {
      m.projectile = 'arrow'; m.cone = 0.03; m.needsLos = false;
    } else if (kind === 'bomb' || kind === 'fireball') {
      m.projectile = 'grenade'; m.cone = 0.05; m.aoe = num(def.aoe, 5);
      m.minRng = num(def.minRng, 6); m.needsLos = false;
    } else if (kind === 'melee' || kind === 'suicide') {
      m.projectile = 'melee'; m.cone = 0; m.needsLos = false; m.lay = false;
    }
    // A pulse weapon is already two weapons in one housing, expressed as data —
    // this generalises exactly that shape.
    var modes = [m];
    if (def.pulse) {
      var P = def.pulse;
      m.projectile = 'pulse';
      m.dmg = num(P.dmg, m.dmg); m.burst = num(P.burst, 3); m.gap = num(P.gap, 0.075);
      m.cone = num(P.cone, 0.019); m.sfx = 'pulse';
      modes.push({
        name: 'Lance', trigger: 'ads', projectile: 'pulse', lance: true,
        dmg: num(P.aimedDmg, 420), cone: num(P.aimedCone, 0.0012),
        rng: num(def.rng, 40), cd: num(P.aimedCd, 1.7),
        sniper: true, rail: !!P.rail, sfx: 'pulse', needsLos: true, lay: true,
      });
    }
    return {
      v: 1, kind: 'weapon', id: 'stock-' + (key || def.name || 'weapon'),
      name: (def.name || 'Weapon') + ' armament',
      derivedFrom: key || null,
      modes: modes,
      ammo: num(def.ammo, 0), reload: num(def.reload, 0),
    };
  }

  /** The parity table the phase gate asks for: express every stock unit as
   *  data and compare the numbers against the hand-written branch. */
  function weaponParity() {
    var rows = [], bad = 0;
    if (!G || !G.UNIT_DEFS) return { rows: rows, mismatches: bad };
    for (var k in G.UNIT_DEFS) {
      var def = G.UNIT_DEFS[k];
      if (def.custom) continue;
      var w = weaponFromDef(def, k);
      var m0 = w.modes[0];
      // What the hand-written branch does, computed straight from the def.
      var wantRpm = 60 / Math.max(0.05, num(def.atkTime, 1));
      var wantDmg = num(def.dmg, 10);
      var wantBurst = def.kind === 'hmg' ? num(def.burst, 6) : (def.pulse ? num(def.pulse.burst, 3) : 1);
      var wantDmgEff = def.pulse ? num(def.pulse.dmg, wantDmg) : wantDmg;
      var row = {
        unit: k, kind: def.kind, projectile: m0.projectile,
        rpm: Math.round(m0.rof * 10) / 10, rpmWant: Math.round(wantRpm * 10) / 10,
        dmg: m0.dmg, dmgWant: wantDmgEff,
        burst: m0.burst, burstWant: wantBurst,
        rng: m0.rng, rngWant: num(def.rng, 40),
        ammo: w.ammo, ammoWant: num(def.ammo, 0),
        modes: w.modes.length,
        dps: Math.round(modeDps(m0) * 100) / 100,
        coneMrad: Math.round(modeSpread(m0).mrad * 100) / 100,
      };
      row.ok = Math.abs(row.rpm - row.rpmWant) < 0.05 && row.dmg === row.dmgWant
        && row.burst === row.burstWant && row.rng === row.rngWant && row.ammo === row.ammoWant;
      if (!row.ok) bad++;
      rows.push(row);
    }
    return { rows: rows, mismatches: bad, units: rows.length };
  }

  function registerWeapon(doc) {
    doc = migrate(doc);
    var v = validateWeapon(doc);
    if (!v.ok) { if (window.console) console.warn('[TCM] weapon "' + doc.id + '" invalid: ' + v.errors.join('; ')); return false; }
    weapons[doc.id] = doc;
    return true;
  }

  // =======================================================================
  // ABILITIES AS DATA  (FORGE_PLAN §7.2)
  // =======================================================================
  //
  // Each entry maps onto an implementation that ALREADY EXISTS in the game.
  // The schema supplies the trigger, cooldown and parameters; adding a new
  // ability is a developer job once, and then every player-made unit can use
  // it. That is the extension point.
  var ABILITIES = {
    jump:        { needs: 'jetpack',  label: 'Jump jets',      hook: 'jetHop' },
    smoke:       { needs: 'smoke',    label: 'Lay smoke',      hook: 'throwSmoke' },
    heal:        { needs: null,       label: 'Field medicine', hook: 'heal' },
    digIn:       { needs: null,       label: 'Dig in',         hook: 'digIn' },
    designate:   { needs: null,       label: 'Target designator', hook: 'designate' },
    stealthField:{ needs: null,       label: 'Stealth field',  hook: 'stealthField' },
    aura:        { needs: null,       label: 'Command aura',   hook: 'aura' },
    drones:      { needs: null,       label: 'Release drones', hook: 'releaseDrones' },
    hunterKiller:{ needs: 'hk',       label: 'Hunter-killer',  hook: 'launchHk' },
    charge:      { needs: null,       label: 'Charge',         hook: 'charge' },
    overwatch:   { needs: null,       label: 'Overwatch',      hook: 'overwatch' },
    shield:      { needs: null,       label: 'Shield burst',   hook: 'shieldBurst' },
    repair:      { needs: null,       label: 'Repair',         hook: 'engineerAct' },
    mine:        { needs: null,       label: 'Lay mine',       hook: 'layMine' },
    satchel:     { needs: null,       label: 'Satchel charge', hook: 'satchel' },
  };

  // =======================================================================
  // AI ROLES  (FORGE_PLAN §7.3)
  // =======================================================================
  //
  // `role` replaces the behavioural half of `kind`: a preset over the knobs
  // the FSM already reads. This is what lets the AI drive a unit it has never
  // seen — "a hovering four-legged thing that skirmishes and jump-jets away"
  // is a role plus a skeleton plus a weapon, not a code branch.
  var ROLES = {
    lineInfantry:  { hold: 0.55, kite: 0, cover: 0.8, priority: 'infantry', bound: 18, engage: 0.9 },
    assault:       { hold: 0.25, kite: 0, cover: 0.4, priority: 'nearest',  bound: 24, engage: 1.0 },
    skirmisher:    { hold: 0.7,  kite: 14, cover: 0.9, priority: 'soft',    bound: 22, engage: 0.8 },
    marksman:      { hold: 0.95, kite: 0, cover: 1.0, priority: 'leaders',  bound: 10, engage: 0.6 },
    weaponsTeam:   { hold: 0.9,  kite: 0, cover: 1.0, priority: 'infantry', bound: 8,  engage: 0.7 },
    atTeam:        { hold: 0.8,  kite: 8, cover: 1.0, priority: 'armour',   bound: 12, engage: 0.5 },
    armour:        { hold: 0.6,  kite: 6, cover: 0.2, priority: 'armour',   bound: 26, engage: 1.0 },
    tankDestroyer: { hold: 0.9,  kite: 12, cover: 0.5, priority: 'armour',  bound: 16, engage: 0.7 },
    artillery:     { hold: 1.0,  kite: 0, cover: 0.6, priority: 'clustered', bound: 6, engage: 0.4 },
    transport:     { hold: 1.0,  kite: 18, cover: 0.3, priority: 'none',    bound: 30, engage: 0.2 },
    walker:        { hold: 0.5,  kite: 8, cover: 0.3, priority: 'armour',   bound: 24, engage: 1.0 },
    flyer:         { hold: 0.4,  kite: 16, cover: 0,   priority: 'soft',    bound: 34, engage: 1.0 },
    commander:     { hold: 0.9,  kite: 10, cover: 0.9, priority: 'leaders', bound: 14, engage: 0.5 },
    engineer:      { hold: 0.9,  kite: 0, cover: 0.9, priority: 'none',     bound: 14, engage: 0.4 },
    medic:         { hold: 1.0,  kite: 12, cover: 1.0, priority: 'none',    bound: 14, engage: 0.2 },
  };

  // =======================================================================
  // Registration into the live game tables
  // =======================================================================

  var models = {};        // id → doc
  var props = {};         // id → prop doc
  var terrains = {};      // id → terrain doc

  function registerModel(doc) {
    doc = migrate(doc);
    models[doc.id] = doc;
    if (G && G.MODEL_BUILDERS) {
      G.MODEL_BUILDERS['tcm_' + doc.id] = function (unit, teamC) {
        return buildModel(models[doc.id], unit, teamC);
      };
    }
    return 'tcm_' + doc.id;
  }

  /** Register a unit document: writes UNIT_DEFS and wires up its model. */
  function registerUnit(udoc, mdoc) {
    try {
      udoc = migrate(udoc);
      var modelKey = null;
      if (mdoc) modelKey = registerModel(mdoc);
      else if (udoc.model && String(udoc.model).indexOf('tcm:') === 0) {
        var mid = String(udoc.model).slice(4);
        modelKey = models[mid] ? 'tcm_' + mid : null;
      }
      if (!G || !G.UNIT_DEFS) return false;
      var def = {
        name: udoc.name || udoc.id,
        // `kind` on the DOCUMENT says what sort of document this is ("unit"),
        // so the engine's behaviour kind travels as `unitKind`. Accept a bare
        // `kind` too, for hand-written docs that predate the distinction.
        kind: udoc.unitKind || (udoc.kind && udoc.kind !== 'unit' ? udoc.kind : 'rifle'),
        hp: num(udoc.hp, 100), spd: num(udoc.spd, 4), dmg: num(udoc.dmg, 10),
        rng: num(udoc.rng, 40), atkTime: num(udoc.atkTime, 1),
        armor: num(udoc.armor, 0.1), shield: num(udoc.shield, 0),
        size: num(udoc.size, 1), vis: num(udoc.vis, 40),
        color: hex(udoc.color, 0x8a8a8a),
        custom: true, forgeId: udoc.id,
      };
      if (modelKey) def.model = modelKey;
      if (udoc.faction) def.faction = udoc.faction;
      // Weapons and abilities travel as DATA on the def; the generic combat
      // path picks them up and the `kind` switch is never reached (§7.1).
      if (udoc.weapons && udoc.weapons.length) {
        def.weapons = udoc.weapons.map(function (w) {
          var doc = typeof w === 'string' ? weapons[String(w).replace(/^tcw:/, '')]
            : (w.w ? weapons[String(w.w).replace(/^tcw:/, '')] : w);
          return doc ? JSON.parse(JSON.stringify(doc)) : null;
        }).filter(Boolean);
        if (!def.weapons.length) delete def.weapons;
      }
      if (udoc.abilities && udoc.abilities.length) def.abilities = JSON.parse(JSON.stringify(udoc.abilities));
      if (udoc.role) {
        def.role = udoc.role;
        // The role preset writes the knobs the FSM already consults, so the AI
        // can drive a unit type it has never seen.
        var rp = ROLES[udoc.role];
        if (rp) def.doctrine = rp;
      }
      // pass-through of the flags the engine already understands
      ['vehicle', 'lightArmor', 'openTop', 'noTurret', 'walker', 'hover', 'floats',
       'mgOnly', 'capacity', 'lowProfile', 'aura', 'aoe', 'minRng', 'scale',
       'grenade', 'mg', 'melee', 'pulse', 'jetpack', 'hk', 'smart', 'rail',
       'railBlast', 'auto', 'burstAuto', 'fpvClear', 'heavyMg', 'quadMg',
       'ammo', 'smoke', 'pen', 'plates', 'burst'].forEach(function (k) {
        if (udoc[k] !== undefined) def[k] = udoc[k];
      });
      G.UNIT_DEFS[udoc.id] = def;
      return true;
    } catch (e) {
      if (window.console) console.warn('[TCM] registerUnit failed: ' + e.message);
      return false;
    }
  }

  /** Register a prop document: writes OBS_DEF so the game's own placement code
   *  and the editor's doodad palette pick it up. `def.tcm` is the hook the
   *  Obstacles builder tests to route through buildProp instead of its own
   *  hand-written if/else chain. */
  function registerProp(pdoc, mdoc) {
    try {
      pdoc = migrate(pdoc);
      if (mdoc) registerModel(mdoc);
      var mid = mdoc ? mdoc.id : String(pdoc.model || '').replace(/^tcm:/, '');
      if (!G || !G.OBS_DEF) return false;
      var def = {
        hp: num(pdoc.hp, 60), height: num(pdoc.height, 1),
        color: hex(pdoc.color, 0x8a7a5a),
        tcm: mid, custom: true, forgeId: pdoc.id,
      };
      if (pdoc.scatter) def.scatter = true;
      if (pdoc.explosive) { def.explosive = true; def.aoe = num(pdoc.aoe, 4); def.dmg = num(pdoc.dmg, 45); }
      if (pdoc.fire) def.fire = true;
      if (pdoc.seethrough) def.seethrough = true;
      if (pdoc.passthrough) def.passthrough = num(pdoc.passthrough, 0);
      if (pdoc.soft) def.soft = true;
      if (pdoc.big) def.big = true;
      if (pdoc.slots > 0) { def.garrison = pdoc.slots | 0; def.floors = Math.max(1, num(pdoc.floors, 1) | 0); }
      if (pdoc.spin === false) def.spin = false;
      G.OBS_DEF[pdoc.id] = def;
      props[pdoc.id] = pdoc;
      return true;
    } catch (e) {
      if (window.console) console.warn('[TCM] registerProp failed: ' + e.message);
      return false;
    }
  }

  /** Register a terrain surface: appends a TYPE_DEF row and refreshes the
   *  name→index tables. Indices must stay stable across sessions or saved maps
   *  break, so the caller records the id list in the save (see Game.serialize). */
  function registerTerrain(tdoc) {
    try {
      tdoc = migrate(tdoc);
      if (!G || !G.TYPE_DEF) return false;
      var row = {
        name: tdoc.id, color: hex(tdoc.c, 0x6a6258),
        speed: num(tdoc.speed, 1), passable: tdoc.passable !== false,
        cover: num(tdoc.cover, 0), stealth: num(tdoc.stealth, 0),
        custom: true, label: tdoc.name || tdoc.id,
      };
      if (tdoc.carve) row.carve = num(tdoc.carve, 0.8);
      var at = -1;
      for (var i = 0; i < G.TYPE_DEF.length; i++) if (G.TYPE_DEF[i].name === row.name) { at = i; break; }
      if (at >= 0) G.TYPE_DEF[at] = row; else G.TYPE_DEF.push(row);
      if (G.refreshTypes) G.refreshTypes();
      terrains[tdoc.id] = tdoc;
      return true;
    } catch (e) {
      if (window.console) console.warn('[TCM] registerTerrain failed: ' + e.message);
      return false;
    }
  }

  // =======================================================================
  // misc
  // =======================================================================

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  window.TCM = {
    VERSION: VERSION,
    install: install,
    migrate: migrate,
    validate: validate,
    buildModel: buildModel,
    buildProp: buildProp,
    registerModel: registerModel,
    registerUnit: registerUnit,
    registerProp: registerProp,
    registerTerrain: registerTerrain,
    registerWeapon: registerWeapon,
    // Weapons / abilities / roles as data (Phase 6)
    weapons: weapons, validateWeapon: validateWeapon,
    weaponFromDef: weaponFromDef, weaponParity: weaponParity,
    modeDps: modeDps, modeInterval: modeInterval, modeSpread: modeSpread,
    PROJECTILES: PROJECTILES, TRIGGERS: TRIGGERS, ABILITIES: ABILITIES, ROLES: ROLES,
    applyDrivers: applyDrivers,
    applyBlends: applyBlends,
    models: models, props: props, terrains: terrains,
    // The deterministic mesh core (Phase 4). Shared by the editor and the
    // tests; `golden()` is the fingerprint that catches an accidental change to
    // a generator, which would invalidate every saved sculpt.
    mesh: {
      MESHABLE: MESHABLE, Q: Q,
      unitPrim: unitPrim, subdivide: subdivideMesh, symmetryMap: symmetryMap,
      base: baseMesh, applySculpt: applySculpt, dimScale: dimScale,
      toEditable: toEditableMesh, encode: encodeMesh, decode: decodeMesh,
      extrude: extrudeFaces, inset: insetFaces, del: deleteFaces,
      subdivideFaces: subdivideFaces, bridge: bridgeFaces, weld: weldMesh,
      flip: flipFaces, compact: compact,
      faceNormal: faceNormal, faceCentre: faceCentre,
      golden: golden,
    },
    // Clips + tags (Phase 5). `sampleTrack`/`accumClip` are what the game's
    // generic animator calls; the rest is for the editor's timeline.
    clips: {
      CHANNELS: CLIP_CHANNELS, compile: compileClips,
      sample: sampleTrack, accum: accumClip,
    },
    // introspection, for the editor and for tests
    SHAPES: SHAPES, SKELETONS: SKELETONS, JOINTS: JOINTS, PAIRED: PAIRED,
    PART_TAGS: PART_TAGS, DECAL_SYMS: DECAL_SYMS,
    BONE_TAGS: BONE_TAGS, STOCK_TAGS: STOCK_TAGS,
    _caches: { geo: geoCache, mat: matCacheUnlit, lit: matCacheLit, decal: decalTexCache, mesh: meshCache },
  };
})();
