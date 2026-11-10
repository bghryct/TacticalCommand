/* ===========================================================================
 * EXTMODELS — external glTF models, loaded once and cloned per unit
 * ---------------------------------------------------------------------------
 * The game builds its vehicles procedurally (see MODEL_BUILDERS) and that is
 * still the right default: sixty boxes through the shared geometry cache cost
 * almost nothing and every model inherits the same flat-shaded look. This is
 * the door for an authored mesh where one exists.
 *
 * THREE RULES, all of them learned the hard way elsewhere in this file tree:
 *
 *  1. NEVER BLOCK A SPAWN. `MODEL_BUILDERS` is synchronous — a unit is built
 *     the instant it is added — and a glTF arrives whenever the network says
 *     so. So a builder asks for a clone, gets null until the load lands, and
 *     falls back to its procedural model. `Unit.rebuildVisual()` swaps the
 *     real thing in afterwards.
 *
 *  2. MATERIALS ARE PER UNIT, TEXTURES ARE SHARED. The game mutates a model's
 *     `flashMats` on every hit; share one material between two Nashorns and
 *     hitting either flashes both. Cloning a material is cheap. Cloning a
 *     texture is not, and is never needed — so `clone()` copies materials and
 *     leaves the maps pointing at the one upload.
 *
 *  3. NEVER THROW. A missing file, a 404 on a texture, a GLTFLoader that did
 *     not load at all: every one of those returns null and the unit keeps the
 *     model it already had. One bad asset cannot take a battle down.
 * ========================================================================= */
(function (root) {
  'use strict';
  var E = {};
  var cache = {};      // name -> { proto: Group|null, state: 'loading'|'ready'|'failed', onReady: [] }
  // A normal-mapped model is lit per pixel (see _prepare); these are its dull
  // sheen. `perPixel` false = the Lambert arm, for measuring what it costs.
  E.perPixel = true;
  E.lazy = true;       // (round 117) decode a model when it is first asked for, not at boot (see `preload`)

  /** Put an object reference on `userData` WITHOUT it being copied by clone.
   *
   *  Object3D.clone() copies userData with JSON.parse(JSON.stringify(...)), so
   *  a Group kept there is serialised whole — its geometry written out as JSON
   *  and read back — on every clone. The prototype kept its turret there, and
   *  every baked vehicle's spawn cost 330 ms of main thread (measured, round
   *  98; since round 97). JSON.stringify skips a non-enumerable property, and
   *  readers of `userData.turret` still see it. */
  function hidden(ud, key, val) {
    Object.defineProperty(ud, key, { value: val, enumerable: false, writable: true, configurable: true });
  }
  E.SPECULAR = 0x141414;
  E.SHININESS = 22;

  /** Start loading `name`. Safe to call before THREE or the loader exist.
   *
   *  TWO SOURCES, AND THE EMBEDDED ONE WINS. `GLTFLoader` fetches through
   *  `THREE.FileLoader`, which is an XMLHttpRequest, and Chrome blocks XHR
   *  against local files — so a model that loads perfectly over
   *  http://localhost silently vanishes the moment somebody double-clicks the
   *  .html, which is how this game is most often opened. The builder falls
   *  back to its procedural model and nobody is told anything.
   *
   *  A <script> tag is not blocked on file://. So `tools/pack_model.py` emits
   *  the whole model — .bin and every texture inlined as data URIs — as a
   *  script that registers itself on `EXT_MODEL_DATA`, and this parses it with
   *  no network at all. `url` stays as the fallback for anything not packed. */
  E.preload = function (name, url, opts) {
    if (cache[name]) return;
    // (round 117) LAZY. Every pack used to be decoded here, at boot: 254 models,
    // two 2048x2048 or 1024x1024 maps apiece, 4.5 GB of decoded pixels held for
    // the life of the page (measured: a 6.5 GB renderer one minute after load,
    // which is what reset a 16 GB machine running several pages). A battle
    // fields a dozen or two of them. `opts.lazy` registers the model and decodes
    // it the first time something asks (`ready`, `clone`, `want`); the caller
    // gets null meanwhile and is rebuilt by its `onReady`, exactly as a unit
    // built before a boot-time load landed always was. `ExtModels.lazy = false`
    // (or `?eagerModels=1`) before boot is the old arm.
    var lazy = !!(opts && opts.lazy) && E.lazy !== false;
    cache[name] = { proto: null, state: lazy ? 'idle' : 'loading', onReady: [], url: url, opts: Object.assign({ crewKey: name }, opts || {}) };
    if (!lazy) E._load(name);
  };
  /** (round 117) Ask for a lazily registered model: starts its decode, once. */
  E.want = function (name) {
    var r = cache[name];
    if (r && r.state === 'idle') { r.state = 'loading'; E._load(name); }
  };
  /** (round 117) Resolves when nothing is decoding. A SEEDED PROBE MUST PRIME: load the map (which asks for its
   *  models), `await ExtModels.settle()`, then load it again and run — a battle begun on the fallback models is a
   *  different battle from one begun on the scale models (Village 1697120508 against -1386000172, round 117). */
  E.settle = function (ms) {
    var t0 = Date.now();
    return new Promise(function (res) {
      (function poll() { if (E.stats().loading === 0 || Date.now() - t0 > (ms || 30000)) res(E.stats()); else setTimeout(poll, 50); })();
    });
  };
  /** (round 117) How many models are in each state — the probe for the above. */
  E.stats = function () {
    var c = { idle: 0, loading: 0, ready: 0, failed: 0 };
    for (var k in cache) c[cache[k].state] = (c[cache[k].state] || 0) + 1;
    return c;
  };
  E._load = function (name) {
    var rec = cache[name], url = rec.url;
    if (!root.THREE || !root.THREE.GLTFLoader) {
      rec.state = 'failed';
      console.warn('[extmodels] no GLTFLoader — ' + name + ' will use its procedural model');
      return;
    }
    // (round 117) ON THE COSMETIC STREAM. A lazy model lands in the middle of a battle, not at boot, and preparing
    // it and rebuilding the units that waited for it makes meshes and materials (four `Math.random` draws apiece
    // for a UUID): none of that may move the simulation's rolls. `cosmeticScope` is the page's (absent in tests).
    var land = function (gltf) {
      try {
        rec.proto = E._prepare(gltf.scene, rec.opts);
        rec.state = 'ready';
        var cbs = rec.onReady; rec.onReady = [];
        for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
      } catch (e) { rec.state = 'failed'; console.warn('[extmodels] ' + name + ' prepare failed', e); }
    };
    var done = function (gltf) {
      if (typeof root.cosmeticScope === 'function') root.cosmeticScope(land, null, [gltf]); else land(gltf);
    };
    var packed = root.EXT_MODEL_DATA && root.EXT_MODEL_DATA[name];
    if (packed) {
      try {
        new root.THREE.GLTFLoader().parse(JSON.stringify(packed), '', done, function (err) {
          rec.state = 'failed';
          console.warn('[extmodels] ' + name + ' packed data failed to parse', err);
        });
        return;
      } catch (e) { rec.state = 'failed'; console.warn('[extmodels] ' + name + ' parse threw', e); return; }
    }
    if (root.location && root.location.protocol === 'file:') {
      rec.state = 'failed';
      console.warn('[extmodels] ' + name + ' is not packed and the page is on file:// — '
        + 'the browser will not let a .gltf be fetched from disk, so the procedural model is used. '
        + 'Run tools/pack_model.py, or serve the folder over HTTP.');
      return;
    }
    try {
      new root.THREE.GLTFLoader().load(url, function (gltf) {
        done(gltf);
      }, null, function (err) {
        rec.state = 'failed';
        console.warn('[extmodels] ' + name + ' failed to load', err);
      });
    } catch (e) { rec.state = 'failed'; }
  };

  /** Orient, scale and centre an authored mesh into the game's convention:
   *  +Z is forward, +Y is up, and the origin sits on the ground between the
   *  tracks. `opts.yaw` turns the author's forward axis onto +Z; `opts.scale`
   *  is world units per model unit (the game runs at about 0.62 per metre). */
  E._prepare = function (scene, opts) {
    var THREE = root.THREE;
    var g = new THREE.Group();
    // WRAP, NEVER OVERWRITE. A Sketchfab export carries its own transform on
    // the scene root — typically the Z-up to Y-up quarter turn — and assigning
    // `scene.rotation.y` clobbers it, which silently left the model lying
    // along the wrong axis (measured: 5.38 long on X where the game wanted it
    // on Z). The author's transform is part of the asset; ours goes outside it.
    var inner = new THREE.Group();
    inner.add(scene);
    inner.rotation.y = opts.yaw || 0;
    inner.scale.setScalar(opts.scale || 1);
    g.add(inner);
    // Sit it on the ground and centre it, so the builder can place it without
    // knowing anything about how the author modelled it.
    //
    // CENTRE THE HULL, NOT THE BOUNDS. A gun that overhangs the nose is part of
    // the bounding box, so centring on the box pushes the vehicle backwards by
    // half its overhang — the Nashorn's 88 put its hull 0.58 units behind where
    // the unit actually stood, which reads as the tracks lagging the marker.
    // The game's own builders centre the hull and let the gun stick out, so
    // `opts.centreOn` names the meshes that ARE the hull (here the tracks, a
    // separate material) and everything else is allowed to overhang.
    g.updateMatrixWorld(true);
    var b = new THREE.Box3();
    if (opts.centreOn) {
      var re = new RegExp(opts.centreOn, 'i'), found = false;
      inner.traverse(function (o) {
        if (!o.isMesh) return;
        var mn = (o.material && o.material.name) || '';
        if (re.test(mn) || re.test(o.name || '')) { b.union(new THREE.Box3().setFromObject(o)); found = true; }
      });
      if (!found) b.setFromObject(inner);
    } else b.setFromObject(inner);
    var full = new THREE.Box3().setFromObject(inner);
    b.min.y = full.min.y;   // ground on the lowest point, whatever that is
    inner.position.x -= (b.min.x + b.max.x) / 2;
    inner.position.z -= (b.min.z + b.max.z) / 2;
    inner.position.y -= b.min.y;
    g.updateMatrixWorld(true);
    // A TURRET IS A SEPARATE THING THAT SPINS. Split it out BEFORE merging, or
    // it is welded to the hull and the tank aims by turning its whole body.
    // `opts.turret` is a regex matched against node names — these exports name
    // their parts (`SM_turret_02`, `SM_gun_07`, `SM_hull`), which is the whole
    // reason this is possible without hand-editing the mesh.
    //
    // The pivot is the turret's own horizontal centre, not the vehicle's: a
    // T-34's ring sits forward of the hull midpoint, and spinning it about the
    // wrong point makes the gun swing in an arc instead of rotating on the spot.
    if (opts.turret) {
      var tre = new RegExp(opts.turret, 'i');
      var picked = [];
      inner.traverse(function (o) {
        if (!o.isMesh) return;
        for (var n = o; n; n = n.parent) {
          if (n.name && tre.test(n.name)) { picked.push(o); return; }
        }
      });
      if (picked.length) {
        var tg = new THREE.Group();
        var tb = new THREE.Box3();
        for (var i = 0; i < picked.length; i++) tb.union(new THREE.Box3().setFromObject(picked[i]));
        var pivot = new THREE.Vector3((tb.min.x + tb.max.x) / 2, 0, (tb.min.z + tb.max.z) / 2);
        // …UNLESS THE MODEL SAYS WHERE ITS RING IS. The bounds' centre is a
        // guess that a long gun drags forward (a Panther's L/70 puts it well
        // ahead of the ring, and the turret then swings in an arc). A model
        // built in tools/blender puts the turret node's ORIGIN on the ring
        // centre; `turretPivot: 'node'` spins about that.
        if (opts.turretPivot === 'node') {
          var np = new THREE.Vector3();
          picked[0].getWorldPosition(np);
          pivot.set(np.x, 0, np.z);
        }
        // Re-parent each turret mesh under the pivot, keeping its world pose.
        for (var j = 0; j < picked.length; j++) {
          var m2 = picked[j];
          m2.updateMatrixWorld(true);
          var keep = m2.matrixWorld.clone();
          if (m2.parent) m2.parent.remove(m2);
          tg.add(m2);
          m2.matrix.copy(keep);
          m2.matrix.decompose(m2.position, m2.quaternion, m2.scale);
        }
        tg.position.copy(pivot);
        for (var k2 = 0; k2 < tg.children.length; k2++) tg.children[k2].position.sub(pivot);
        g.add(tg);
        hidden(g.userData, 'turret', tg);
      }
    }
    if (opts.merge !== false) {
      E._mergeByMaterial(g.userData.turret || g, !!g.userData.turret);
      if (g.userData.turret) E._mergeByMaterial(g, false, g.userData.turret);
    }
    // A BAKED MODEL IS LAMBERT, LIKE EVERYTHING ELSE. glTF arrives as
    // MeshStandardMaterial, and PBR with no environment map renders dark and
    // flat here (round 55 moved every lit surface to Lambert for that reason
    // and for cost). The paint, the mud and the occlusion are in the texture;
    // `painted` tells assets/unitshade.js not to paint it again.
    //
    // …UNLESS IT CARRIES A NORMAL MAP (round 98). Lambert lights per vertex and
    // r128's Lambert has no normalMap at all, so the relief tools/blender bakes
    // — every plate edge rounded, weld beads, bolt heads, Zimmerit — would be
    // thrown away. Those models go to Phong, lit per pixel, with a faint dull
    // specular: paint is matte, but a rounded edge catching the sun is most of
    // what makes a scale model read as metal. `E.perPixel = false` puts them
    // back on Lambert at the next clone — the A/B arm (see ArtCost.lit).
    if (opts.lambert) {
      g.traverse(function (o) {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        var sm = o.material;
        var lm;
        if (sm.normalMap) {
          lm = new THREE.MeshPhongMaterial({ map: sm.map || null, normalMap: sm.normalMap, color: 0xffffff,
                                             specular: E.SPECULAR, shininess: E.SHININESS, side: sm.side });
          // glTF's normal maps are +Y up, its textures unflipped, and there are
          // no tangents in these files: the loader's (1, -1) is already right
          // for three's derivative tangent frame — copy it, never re-derive it
          if (sm.normalScale) lm.normalScale.copy(sm.normalScale);
          lm.normalMap.anisotropy = 4;
        } else {
          lm = new THREE.MeshLambertMaterial({ map: sm.map || null, color: 0xffffff, side: sm.side });
        }
        if (lm.map) { lm.map.encoding = THREE.sRGBEncoding; lm.map.anisotropy = 4; }
        lm.name = sm.name; lm.userData.painted = true;
        o.material = lm;
        sm.dispose();
      });
    }
    if (E.splitGun && g.userData.turret) {
      try { E._splitGun(g, opts); } catch (e) { console.warn('[extmodels] gun split failed', e); }
    }
    if (E.spinWheels && opts.wheels) {
      try { E._tagWheels(g); } catch (e) { console.warn('[extmodels] wheel tagging failed', e); }
    }
    if (E.splitCrew && root.CREW_BOXES && opts.crewKey && root.CREW_BOXES[opts.crewKey]) {
      try { E._splitCrew(g, root.CREW_BOXES[opts.crewKey], opts); } catch (e) { console.warn('[extmodels] crew split failed', e); }
    }
    g.updateMatrixWorld(true);
    g.userData.bounds = new THREE.Box3().setFromObject(g);
    g.userData.authored = true;     // the game's vertex-colour merge must skip this
    return g;
  };

  /** THE GUN IS ITS OWN PART (round 104). tools/blender joins each group's
   *  parts into one object, so a tank's barrel arrives welded into its turret
   *  and can neither recoil into the mantlet nor elevate. It is found by its
   *  SHAPE: a thin tube running back from the `Muzzle` marker until the radius
   *  jumps where the mantlet (or a towed gun's cradle) begins — measured on 34
   *  models, the Sherman's tube shows 1.28 u, the Panther's 2.56, the King
   *  Tiger's 3.28. Those triangles move onto a `GunPivot` on the bore axis a
   *  little behind the mantlet's face, in the turret, and the game lays and
   *  recoils it (`Unit._gunAnim`). Done once, on the prototype; every clone
   *  inherits the split. The muzzle marker stays on the turret: where shots
   *  leave is data, not the mesh. `E.splitGun = false` before a load is the
   *  A/B arm. A hull-mounted gun (a Crocodile's projector) is left alone. */
  /** ROAD WHEELS THAT TURN (round 104). A tank rolled across the field on
   *  wheels that never went round, because they are joined into the hull mesh
   *  with everything else. They are found the way the gun is, by SHAPE: each
   *  part tools/blender built is its own island of the mesh (parts are joined,
   *  never welded), and a wheel's islands — the tyre, the rim, the hub, the
   *  sprocket's toothed rings — are discs: square from the side, thin across,
   *  low on the hull and outboard. Islands on one axle are one wheel; a bolt, a
   *  spoke or a cap lying wholly inside a disc rides with it. Each vertex gets
   *  `aWheel` (its wheel's centre and radius, the sign saying which track) and
   *  the hull's material turns it about the axle (`E._wheelMat`), by the
   *  distance its track has run over the wheel's radius. The track itself does
   *  not run: its links are geometry, and they stay. The hull's own transform
   *  is baked into its geometry first, so its frame is the vehicle's
   *  (+z forward, x across) and the axle is always x. Done once per prototype;
   *  `E.spinWheels = false` before a load is the A/B arm. */
  E.spinWheels = true;
  E._tagWheels = function (g) {
    var THREE = root.THREE, tur = g.userData.turret || null;
    g.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    var hulls = [];
    g.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || Array.isArray(o.material)) return;
      for (var p = o; p; p = p.parent) if (p === tur) return;
      hulls.push(o);
    });
    var tagged = 0;
    for (var h = 0; h < hulls.length; h++) {
      var o = hulls[h], geo = o.geometry;
      var mm = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      // ITS CHILDREN KEEP THEIR PLACE (round 106). The hull's frame becomes the
      // vehicle's below, and what hangs on it — the `Muzzle` of a gun with no
      // turret — kept its old LOCAL place, so it lost the model's 0.75 and its
      // centring: a Nashorn's muzzle 3 m past the end of its barrel, a Wespe's
      // 1.2 m. Each child is put back where it was in the world.
      var kids = o.children.map(function (c) { return [c, new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld)]; });
      geo.applyMatrix4(mm);
      if (o.parent !== g) { o.parent.remove(o); g.add(o); }
      o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      for (var kc = 0; kc < kids.length; kc++) { kids[kc][1].decompose(kids[kc][0].position, kids[kc][0].quaternion, kids[kc][0].scale); kids[kc][0].updateMatrix(); }
      var P = geo.attributes.position, n = P.count, idx = geo.index, i, k;
      var par = new Int32Array(n);
      for (i = 0; i < n; i++) par[i] = i;
      var find = function (q) { while (par[q] !== q) { par[q] = par[par[q]]; q = par[q]; } return q; };
      var unite = function (a, b) { a = find(a); b = find(b); if (a !== b) par[a] = b; };
      var nt = (idx ? idx.count : n) / 3;
      for (var t = 0; t < nt; t++) {
        var a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        unite(a, b); unite(b, c);
      }
      var boxes = new Map(), top = -1e9, wMax = 0;
      for (i = 0; i < n; i++) {
        var x = P.getX(i), y = P.getY(i), z = P.getZ(i), rt = find(i);
        var B = boxes.get(rt);
        if (!B) { B = [x, x, y, y, z, z]; boxes.set(rt, B); }
        if (x < B[0]) B[0] = x; if (x > B[1]) B[1] = x;
        if (y < B[2]) B[2] = y; if (y > B[3]) B[3] = y;
        if (z < B[4]) B[4] = z; if (z > B[5]) B[5] = z;
        if (y > top) top = y;
        if (Math.abs(x) > wMax) wMax = Math.abs(x);
      }
      // …and ROUND, not just square: a skirt plate (Schürzen) is square from
      // the side and thin across too, and spun as a wheel it is absurd. A disc's
      // farthest vertex from its centre is its radius; a square's is 1.41 of it.
      var far = new Map();
      for (i = 0; i < n; i++) {
        var B0 = boxes.get(find(i));
        var ey = P.getY(i) - (B0[2] + B0[3]) / 2, ez = P.getZ(i) - (B0[4] + B0[5]) / 2;
        var d2 = ey * ey + ez * ez, rt0 = find(i);
        if (!(far.get(rt0) >= d2)) far.set(rt0, d2);
      }
      var wheels = [];
      boxes.forEach(function (B, rt) {
        var dx = B[1] - B[0], dy = B[3] - B[2], dz = B[5] - B[4];
        if (dy < 0.1 || Math.abs(dy - dz) > 0.06 * Math.max(dy, dz) || dx > 1.2 * dy) return;
        if (Math.sqrt(far.get(rt)) > 0.54 * Math.max(dy, dz)) return;   // a square, not a disc
        var cx = (B[0] + B[1]) / 2, cy = (B[2] + B[3]) / 2, cz = (B[4] + B[5]) / 2, rr = dy / 2;
        if (cy + rr > 0.62 * top || Math.abs(cx) < 0.3 * wMax) return;   // a spare wheel on the hull, a hatch
        for (var q = 0; q < wheels.length; q++) {
          var W = wheels[q];
          if ((W.cx > 0) === (cx > 0) && Math.abs(W.cy - cy) < 0.03 && Math.abs(W.cz - cz) < 0.03) {
            W.r = Math.max(W.r, rr); W.x0 = Math.min(W.x0, B[0]); W.x1 = Math.max(W.x1, B[1]); W.roots.push(rt);
            return;
          }
        }
        wheels.push({ cx: cx, cy: cy, cz: cz, r: rr, x0: B[0], x1: B[1], roots: [rt] });
      });
      // RUNNING GEAR COMES IN PAIRS: a wheel has its twin on the other side of
      // the hull. A round fitting on one flank (a muffler, a stowage drum) has
      // not, and it does not turn.
      wheels = wheels.filter(function (W) {
        for (var q4 = 0; q4 < wheels.length; q4++) {
          var V = wheels[q4];
          if ((V.cx > 0) !== (W.cx > 0) && Math.abs(V.cy - W.cy) < 0.03 && Math.abs(V.cz - W.cz) < 0.05
              && Math.abs(V.r - W.r) < 0.02) return true;
        }
        return false;
      });
      if (!wheels.length) continue;
      var owner = new Map();
      for (k = 0; k < wheels.length; k++) for (var q2 = 0; q2 < wheels[k].roots.length; q2++) owner.set(wheels[k].roots[q2], k);
      boxes.forEach(function (B, rt) {
        if (owner.has(rt)) return;
        var cx = (B[0] + B[1]) / 2, cy = (B[2] + B[3]) / 2, cz = (B[4] + B[5]) / 2;
        var half = Math.sqrt((B[3] - B[2]) * (B[3] - B[2]) + (B[5] - B[4]) * (B[5] - B[4])) / 2;
        var best = -1, bd = 1e9;
        for (var q3 = 0; q3 < wheels.length; q3++) {
          var W = wheels[q3];
          if ((W.cx > 0) !== (cx > 0) || cx < W.x0 - 0.12 || cx > W.x1 + 0.12) continue;
          var d = Math.sqrt((cy - W.cy) * (cy - W.cy) + (cz - W.cz) * (cz - W.cz));
          if (d + half > W.r) continue;                         // wholly inside the disc, or not its
          if (d < bd) { bd = d; best = q3; }
        }
        if (best >= 0) owner.set(rt, best);
      });
      var A = new Float32Array(n * 4);
      for (i = 0; i < n; i++) {
        var wi = owner.get(find(i));
        if (wi === undefined) continue;
        var W2 = wheels[wi];
        A[i * 4] = W2.cy; A[i * 4 + 1] = W2.cz; A[i * 4 + 2] = W2.cx > 0 ? W2.r : -W2.r;
      }
      geo.setAttribute('aWheel', new THREE.BufferAttribute(A, 4));
      geo.userData.wheels = wheels.length;
      tagged += wheels.length;
      if (E.runTracks) {
        try { E._tagTracks(geo, P, n, find, boxes, owner, top); }
        catch (e) { console.warn('[extmodels] track tagging failed', e); }
      }
    }
    g.userData.wheelCount = tagged;
    return tagged;
  };

  /** THE TRACK RUNS ROUND (round 104). The wheels turned and the belt stood
   *  still. afv.py lays a track as link plates with a grouser on each, spaced
   *  evenly round a loop through the wheels, and glTF splits every flat box
   *  into one island per face — so a link's two broad faces are the commonest
   *  island on the flank: the track's width across, small along the loop.
   *  Mutual nearest pairs of those are a link's two faces (a link's thickness
   *  apart; the next link is a pitch away), their midpoint its centre; the
   *  centres chained nearest-first ARE the loop, sampled at the pitch. It goes
   *  into a float texture (NS even steps of position and tangent per flank) and
   *  every island inside a link's own slab — its faces, its grouser — gets
   *  `aTrack`: the link's arc position and the vertex's place in the link's
   *  frame. The hull's material moves the link along the loop by the distance
   *  the track has run, turning it with the loop's tangent, so a link rides up
   *  round the sprocket and back along the top. Measured against the table as
   *  the shader reads it, so the rest pose is exact. A flank whose links do not
   *  chain into a clean loop (a jump of more than 1.8 pitches) is left alone.
   *  `E.runTracks = false` before a load is the A/B arm. */
  E.runTracks = true;
  E.TRACK_SAMPLES = 256;
  E._tagTracks = function (geo, P, n, find, boxes, owner, top) {
    var THREE = root.THREE, NS = E.TRACK_SAMPLES, sides = [1, -1];
    var T = new Float32Array(n * 4), tex = new Float32Array(NS * 2 * 4);
    var info = { L: [1, 1], dir: [0, 0], N: NS, links: [0, 0] }, any = false, i, j, k;
    for (var si = 0; si < 2; si++) {
      var side = sides[si], small = [], hist = new Map();
      boxes.forEach(function (B, rt) {
        if (owner.has(rt)) return;
        var cx = (B[0] + B[1]) / 2;
        if ((cx > 0) !== (side > 0)) return;
        var cy = (B[2] + B[3]) / 2, cz = (B[4] + B[5]) / 2;
        var xw = B[1] - B[0], yz = Math.sqrt((B[3] - B[2]) * (B[3] - B[2]) + (B[5] - B[4]) * (B[5] - B[4]));
        if (yz > 0.3 || cy > 0.85 * top) return;                 // a Churchill's track runs over its panniers
        small.push({ rt: rt, B: B, xw: xw, yz: yz, cy: cy, cz: cz });
        if (xw >= 0.15 && yz >= 0.06) { var key = Math.round(xw * 50); hist.set(key, (hist.get(key) || 0) + 1); }
      });
      var bestK = -1, bestC = 0;
      hist.forEach(function (c, key) { if (c > bestC) { bestC = c; bestK = key; } });
      if (bestC < 40) continue;                                  // under twenty links: no track
      var wT = bestK / 50;
      var plates = small.filter(function (q) { return Math.abs(q.xw - wT) <= 0.025 && q.yz >= 0.06; });
      // …in the track's own lane: spare links hung on a glacis or an engine
      // deck are the same shape, and they are not part of the loop
      var lane = plates.map(function (q) { return (q.B[0] + q.B[1]) / 2; }).sort(function (x, y) { return x - y; })[plates.length >> 1];
      plates = plates.filter(function (q) { return Math.abs((q.B[0] + q.B[1]) / 2 - lane) <= 0.04; });
      var nn = function (a) {
        var best = -1, bd = 1e9;
        for (var q = 0; q < plates.length; q++) {
          if (q === a) continue;
          var d = Math.sqrt((plates[q].cy - plates[a].cy) * (plates[q].cy - plates[a].cy) + (plates[q].cz - plates[a].cz) * (plates[q].cz - plates[a].cz));
          if (d < bd) { bd = d; best = q; }
        }
        return [best, bd];
      };
      var links = [], used = new Uint8Array(plates.length), thick = [];
      for (var a = 0; a < plates.length; a++) {
        if (used[a]) continue;
        var r1 = nn(a);
        if (r1[0] < 0 || used[r1[0]] || nn(r1[0])[0] !== a) continue;
        used[a] = used[r1[0]] = 1;
        links.push({ y: (plates[a].cy + plates[r1[0]].cy) / 2, z: (plates[a].cz + plates[r1[0]].cz) / 2 });
        thick.push(r1[1]);
      }
      if (links.length < 20) continue;
      // THE LOOP: the link centres in order round it. Two ways, and the one
      // that closes cleanly wins (every step about one pitch): a WALK that
      // prefers to keep going the way it was going — plain nearest-first
      // stranded itself and jumped across the loop — and the ANGLE round the
      // centre, which a loop that is star-shaped about it gets right but a
      // Tiger's top run, sagging between its wheels, does not.
      var walk = function () {
        var st0 = 0;
        for (var q = 1; q < links.length; q++) if (links[q].z < links[st0].z) st0 = q;
        var ord = [st0], vis = new Uint8Array(links.length), dy = 0, dz = 0;
        vis[st0] = 1;
        for (var stp = 1; stp < links.length; stp++) {
          var cur = links[ord[ord.length - 1]], bj = -1, bc = 1e9;
          for (var q2 = 0; q2 < links.length; q2++) {
            if (vis[q2]) continue;
            var ey = links[q2].y - cur.y, ez = links[q2].z - cur.z, d = Math.sqrt(ey * ey + ez * ez);
            var dl0 = Math.sqrt(dy * dy + dz * dz), cs = dl0 > 0 && d > 0 ? (ey * dy + ez * dz) / (d * dl0) : 1;
            var cost = d * (1.5 - 0.5 * cs);
            if (cost < bc) { bc = cost; bj = q2; }
          }
          vis[bj] = 1; dy = links[bj].y - cur.y; dz = links[bj].z - cur.z; ord.push(bj);
        }
        return ord;
      };
      var angle = function () {
        var gy0 = 0, gz0 = 0;
        for (var q = 0; q < links.length; q++) { gy0 += links[q].y; gz0 += links[q].z; }
        gy0 /= links.length; gz0 /= links.length;
        return links.map(function (_, q) { return q; }).sort(function (a1, b1) {
          return Math.atan2(links[a1].y - gy0, links[a1].z - gz0) - Math.atan2(links[b1].y - gy0, links[b1].z - gz0);
        });
      };
      var measure = function (ord) {
        var Mq = ord.length, gq = new Float64Array(Mq);
        for (var q = 0; q < Mq; q++) {
          var A0 = links[ord[q]], B0 = links[ord[(q + 1) % Mq]];
          gq[q] = Math.sqrt((B0.y - A0.y) * (B0.y - A0.y) + (B0.z - A0.z) * (B0.z - A0.z));
        }
        var sq = Array.prototype.slice.call(gq).sort(function (x, y) { return x - y; });
        return { ord: ord, gaps: gq, pitch: sq[Mq >> 1], worst: sq[Mq - 1] / sq[Mq >> 1] };
      };
      var cand1 = measure(walk()), cand2 = cand1.worst <= 1.8 ? null : measure(angle());
      var pick = cand2 && cand2.worst < cand1.worst ? cand2 : cand1;
      if (pick.worst > 1.8) continue;                           // neither closes cleanly: leave this flank
      var order = pick.ord, gaps = pick.gaps, pitch = pick.pitch, M = order.length;
      var S = new Float64Array(M + 1);
      for (j = 0; j < M; j++) S[j + 1] = S[j] + gaps[j];
      var L = S[M];
      var poly = function (s) {
        s = ((s % L) + L) % L;
        var lo = 0, hi = M;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
        var f = (s - S[lo]) / (gaps[lo] || 1), p0 = links[order[lo]], p1 = links[order[(lo + 1) % M]];
        return [p0.y + (p1.y - p0.y) * f, p0.z + (p1.z - p0.z) * f];
      };
      for (k = 0; k < NS; k++) {
        var s0 = L * k / NS, pA = poly(s0), pM = poly(s0 - pitch * 0.5), pP = poly(s0 + pitch * 0.5);
        var ty = pP[0] - pM[0], tz = pP[1] - pM[1], tl = Math.sqrt(ty * ty + tz * tz) || 1;
        var o4 = (si * NS + k) * 4;
        tex[o4] = pA[0]; tex[o4 + 1] = pA[1]; tex[o4 + 2] = ty / tl; tex[o4 + 3] = tz / tl;
      }
      // the table exactly as the shader reads it
      var look = function (s) {
        s = ((s % L) + L) % L;
        var u = s / L * NS, i0 = Math.floor(u) % NS, f = u - Math.floor(u), i1 = (i0 + 1) % NS;
        var a0 = (si * NS + i0) * 4, a1 = (si * NS + i1) * 4;
        var vy = tex[a0 + 2] + (tex[a1 + 2] - tex[a0 + 2]) * f, vz = tex[a0 + 3] + (tex[a1 + 3] - tex[a0 + 3]) * f;
        var vl = Math.sqrt(vy * vy + vz * vz) || 1;
        return [tex[a0] + (tex[a1] - tex[a0]) * f, tex[a0 + 1] + (tex[a1 + 1] - tex[a0 + 1]) * f, vy / vl, vz / vl];
      };
      // FORWARD: the bottom run runs backward under the hull. And OUTWARD:
      // at the bottom of the loop, away from the hull is down.
      var lowK = 0;
      for (k = 1; k < NS; k++) if (tex[(si * NS + k) * 4] < tex[(si * NS + lowK) * 4]) lowK = k;
      var lowT = tex[(si * NS + lowK) * 4 + 3], lowNy = -tex[(si * NS + lowK) * 4 + 3];
      info.dir[si] = lowT > 0 ? -1 : 1;
      var out = lowNy < 0 ? 1 : -1;
      info.L[si] = L; info.links[si] = M;
      var th = thick.slice().sort(function (x, y) { return x - y; })[thick.length >> 1];
      var x0 = 1e9, x1 = -1e9;
      for (j = 0; j < plates.length; j++) { if (plates[j].B[0] < x0) x0 = plates[j].B[0]; if (plates[j].B[1] > x1) x1 = plates[j].B[1]; }
      var sOf = new Float64Array(links.length);
      for (j = 0; j < M; j++) sOf[order[j]] = S[j];
      var islLink = new Map();
      for (var q5 = 0; q5 < small.length; q5++) {
        var sm = small[q5];
        if (sm.B[0] < x0 - 0.03 || sm.B[1] > x1 + 0.03) continue;
        var best2 = -1, bdl = 1e9;
        for (j = 0; j < links.length; j++) {
          var dl = (links[j].y - sm.cy) * (links[j].y - sm.cy) + (links[j].z - sm.cz) * (links[j].z - sm.cz);
          if (dl < bdl) { bdl = dl; best2 = j; }
        }
        if (best2 < 0 || Math.sqrt(bdl) > pitch * 0.75) continue;
        var fr = look(sOf[best2]);
        var ddt = (sm.cy - fr[0]) * fr[2] + (sm.cz - fr[1]) * fr[3];
        var ddn = ((sm.cy - fr[0]) * -fr[3] + (sm.cz - fr[1]) * fr[2]) * out;
        if (Math.abs(ddt) > pitch * 0.6 || ddn < -th * 0.9 || ddn > th * 2.0) continue;   // inside the link's own slab
        islLink.set(sm.rt, best2);
      }
      for (i = 0; i < n; i++) {
        var lk = islLink.get(find(i));
        if (lk === undefined) continue;
        var f2 = look(sOf[lk]), vy2 = P.getY(i) - f2[0], vz2 = P.getZ(i) - f2[1];
        T[i * 4] = sOf[lk];
        T[i * 4 + 1] = vy2 * f2[2] + vz2 * f2[3];
        T[i * 4 + 2] = vy2 * -f2[3] + vz2 * f2[2];
        T[i * 4 + 3] = side;
      }
      any = true;
    }
    if (!any) return null;
    geo.setAttribute('aTrack', new THREE.BufferAttribute(T, 4));
    var dtex = new THREE.DataTexture(tex, NS, 2, THREE.RGBAFormat, THREE.FloatType);
    dtex.minFilter = dtex.magFilter = THREE.NearestFilter;
    dtex.generateMipmaps = false;
    dtex.needsUpdate = true;
    info.tex = dtex;
    geo.userData.trackLoop = info;
    return info;
  };

  /** The hull's material turns each wheel's vertices about its axle by
   *  `uWheel` (metres of track run, +x side and -x side) over its radius.
   *  The material is the unit's own clone, so the uniform is the unit's. */
  E._wheelMat = function (m, wu, trk) {
    var prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
    var U = trk ? { uTrkTex: { value: trk.tex }, uTrkN: { value: trk.N },
                    uTrk: { value: new root.THREE.Vector4(trk.L[0], trk.L[1], trk.dir[0], trk.dir[1]) } } : null;
    m.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      sh.uniforms.uWheel = wu;
      var head = '#include <common>\nattribute vec4 aWheel;\nuniform vec2 uWheel;\n'
        + 'vec2 wheelTurn(vec2 d, float a) { float c = cos(a), s = sin(a); return vec2(c * d.x - s * d.y, s * d.x + c * d.y); }\n';
      var nrm = '#include <beginnormal_vertex>\n'
        + 'float wAng = aWheel.z == 0.0 ? 0.0 : (aWheel.z > 0.0 ? uWheel.x : uWheel.y) / abs(aWheel.z);\n'
        + 'objectNormal.yz = wheelTurn(objectNormal.yz, wAng);\n';
      var pos = '#include <begin_vertex>\n'
        + 'transformed.yz = aWheel.xy + wheelTurn(transformed.yz - aWheel.xy, wAng);\n';
      if (U) {
        sh.uniforms.uTrkTex = U.uTrkTex; sh.uniforms.uTrkN = U.uTrkN; sh.uniforms.uTrk = U.uTrk;
        // the link rides the loop: its arc position plus the distance run,
        // turned with the loop's tangent there
        head += 'attribute vec4 aTrack;\nuniform sampler2D uTrkTex;\nuniform float uTrkN;\nuniform vec4 uTrk;\n'
          + 'vec4 trkAt(float s, float row, float L) {\n'
          + '  float u = mod(s, L) / L * uTrkN; float i0 = floor(u); float f = u - i0; float i1 = mod(i0 + 1.0, uTrkN);\n'
          + '  vec4 a = texture2D(uTrkTex, vec2((i0 + 0.5) / uTrkN, (row + 0.5) * 0.5));\n'
          + '  vec4 b = texture2D(uTrkTex, vec2((i1 + 0.5) / uTrkN, (row + 0.5) * 0.5));\n'
          + '  vec4 r = mix(a, b, f); r.zw = normalize(r.zw); return r; }\n';
        nrm += 'vec4 tq1 = vec4(0.0);\n'
          + 'if (aTrack.w != 0.0) {\n'
          + '  bool tPos = aTrack.w > 0.0; float tL = tPos ? uTrk.x : uTrk.y;\n'
          + '  float tRun = tPos ? uTrk.z * uWheel.x : uTrk.w * uWheel.y; float tRow = tPos ? 0.0 : 1.0;\n'
          + '  vec4 tq0 = trkAt(aTrack.x, tRow, tL); tq1 = trkAt(aTrack.x + tRun, tRow, tL);\n'
          + '  float tc = dot(tq0.zw, tq1.zw), ts = tq0.z * tq1.w - tq0.w * tq1.z;\n'
          + '  objectNormal.yz = vec2(tc * objectNormal.y - ts * objectNormal.z, ts * objectNormal.y + tc * objectNormal.z);\n'
          + '}\n';
        pos += 'if (aTrack.w != 0.0) transformed.yz = tq1.xy + aTrack.y * tq1.zw + aTrack.z * vec2(-tq1.w, tq1.z);\n';
      }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', head)
        .replace('#include <beginnormal_vertex>', nrm)
        .replace('#include <begin_vertex>', pos);
    };
    m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + (U ? '|wheel1trk1' : '|wheel1'); };
    m.needsUpdate = true;
  };

  E.splitGun = true;
  E._splitGun = function (g, opts) {
    var THREE = root.THREE, tur = g.userData.turret;
    var mz = g.getObjectByName('Muzzle');
    if (!tur || !mz) return;
    var under = false;
    for (var n = mz; n; n = n.parent) if (n === tur) { under = true; break; }
    if (!under) return;
    g.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(tur.matrixWorld).invert();
    var M = new THREE.Vector3(); mz.getWorldPosition(M); M.applyMatrix4(inv);
    var meshes = [];
    tur.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.attributes.position && !Array.isArray(o.material)) meshes.push(o);
    });
    if (!meshes.length) return;
    var mats = meshes.map(function (o) { return new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); });
    var v = new THREE.Vector3(), i, k;
    // along the bore (s, back from the muzzle) and off it (r), in the turret
    var sr = function (A, j, m) {
      v.fromBufferAttribute(A, j).applyMatrix4(m);
      return [M.z - v.z, Math.sqrt((v.x - M.x) * (v.x - M.x) + (v.y - M.y) * (v.y - M.y))];
    };
    // the tube's own radius at the muzzle, brake and all
    var front = 0;
    for (k = 0; k < meshes.length; k++) {
      var A = meshes[k].geometry.attributes.position;
      for (i = 0; i < A.count; i++) { var q = sr(A, i, mats[k]); if (q[0] > -0.15 && q[0] < 0.4 && q[1] < 0.4 && q[1] > front) front = q[1]; }
    }
    if (!(front > 0.008) || front > 0.25) return;          // no thin tube at the marker: not a gun
    // …and where the radius jumps: the mantlet, the cradle, the shield
    var thr = Math.max(front * 1.6, front + 0.06), sm = Infinity;
    for (k = 0; k < meshes.length; k++) {
      var A2 = meshes[k].geometry.attributes.position;
      for (i = 0; i < A2.count; i++) { var q2 = sr(A2, i, mats[k]); if (q2[1] > thr && q2[1] < 0.7 && q2[0] > 0.3 && q2[0] < sm) sm = q2[0]; }
    }
    if (!isFinite(sm)) return;
    var pivot = new THREE.Group();
    pivot.name = 'GunPivot';
    pivot.position.set(M.x, M.y, M.z - sm - 0.15);
    pivot.userData.tube = sm;                                // how much tube shows
    pivot.userData.uPerM = (opts && opts.scale) || 0.62;     // world units per metre of model
    var nm = new THREE.Matrix3();
    for (k = 0; k < meshes.length; k++) {
      var o = meshes[k], geo = o.geometry, P = geo.attributes.position, idx = geo.index;
      var nTri = (idx ? idx.count : P.count) / 3;
      var gunTri = [], restIdx = [];
      for (var t = 0; t < nTri; t++) {
        var tri = idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
        var isGun = true, ahead = false;
        for (var c = 0; c < 3; c++) {
          var q3 = sr(P, tri[c], mats[k]);
          if (q3[1] >= thr || q3[0] < -0.2) { isGun = false; break; }
          if (q3[0] < sm - 0.01) ahead = true;
        }
        if (isGun && ahead) gunTri.push(tri[0], tri[1], tri[2]); else restIdx.push(tri[0], tri[1], tri[2]);
      }
      if (!gunTri.length) continue;
      // the tube, compact and in the pivot's frame
      var gg = new THREE.BufferGeometry(), names = Object.keys(geo.attributes);
      nm.getNormalMatrix(mats[k]);
      for (var a = 0; a < names.length; a++) {
        var src = geo.attributes[names[a]], isz = src.itemSize;
        var arr = new Float32Array(gunTri.length * isz);
        for (var j = 0; j < gunTri.length; j++) for (var e = 0; e < isz; e++) arr[j * isz + e] = src.array[gunTri[j] * isz + e];
        var att = new THREE.BufferAttribute(arr, isz, src.normalized);
        if (names[a] === 'position') {
          for (var p2 = 0; p2 < gunTri.length; p2++) {
            v.fromBufferAttribute(att, p2).applyMatrix4(mats[k]).sub(pivot.position);
            att.setXYZ(p2, v.x, v.y, v.z);
          }
        } else if (names[a] === 'normal') {
          for (var p3 = 0; p3 < gunTri.length; p3++) {
            v.fromBufferAttribute(att, p3).applyMatrix3(nm).normalize();
            att.setXYZ(p3, v.x, v.y, v.z);
          }
        }
        gg.setAttribute(names[a], att);
      }
      gg.computeBoundingSphere();
      var gm = new THREE.Mesh(gg, o.material);
      gm.name = 'Gun'; gm.castShadow = o.castShadow; gm.receiveShadow = o.receiveShadow;
      pivot.add(gm);
      // …and the turret without it
      geo.setIndex(restIdx);
      geo.computeBoundingSphere();
    }
    if (pivot.children.length) tur.add(pivot);
  };

  /** THE CREW ARE THEIR OWN PART (round 106). tools/blender joins the tank
   *  commander up in his hatch (`afv.commander`) and the men riding in an open
   *  vehicle (`afv.bust`) into the turret or hull they sit in, so they were
   *  plate: a commander stood in the hatch of every burnt-out wreck, and rode
   *  the turret a brew-up threw across the field. `tools/blender/crew_boxes.py`
   *  records where each of their parts is (assets/crewboxes.js); here every
   *  triangle lying wholly inside one of those boxes is lifted out into a mesh
   *  named `Crew` in the same frame, with the same material — one more draw
   *  for a vehicle that has a crew showing, none for one that has not — and
   *  the game shows it only while there is a crew to show (`Unit._syncCrewMesh`).
   *
   *  The boxes are in the exported model's metres (relative to the turret
   *  ring for the turret); the frame they are mapped into is found, not
   *  assumed: the group's own mesh, scaled, laid corner to corner on the box
   *  recorded for the whole group — the low, left, rear corner, which the gun
   *  split (`_splitGun`, the barrel forward) does not move. */
  E.splitCrew = true;
  E._splitCrew = function (g, rec, opts) {
    var THREE = root.THREE, sc = (opts && opts.scale) || 1, tur = g.userData.turret || null;
    g.updateMatrixWorld(true);
    var kinds = [];
    ['turret', 'hull'].forEach(function (gn) {
      var G = rec.groups && rec.groups[gn];
      if (!G || !G.parts || !G.parts.length) return;
      var frame = gn === 'turret' ? tur : g;
      if (!frame) return;
      var inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
      var meshes = [];
      frame.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || Array.isArray(o.material)) return;
        if (o.name === 'Gun' || o.name === 'Crew') return;
        for (var n = o; n && n !== frame; n = n.parent) if (n.name === 'GunPivot' || (gn === 'hull' && n === tur)) return;
        meshes.push(o);
      });
      if (!meshes.length) return;
      var mats = meshes.map(function (o) { return new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); });
      var v = new THREE.Vector3(), bb = new THREE.Box3(), k, i;
      for (k = 0; k < meshes.length; k++) {
        var A = meshes[k].geometry.attributes.position;
        for (i = 0; i < A.count; i++) bb.expandByPoint(v.fromBufferAttribute(A, i).applyMatrix4(mats[k]));
      }
      var ox = bb.min.x - sc * G.box[0], oy = bb.min.y - sc * G.box[1], oz = bb.min.z - sc * G.box[2];
      var eps = 0.003 * sc;
      var boxes = function (list) {
        return (list || []).map(function (p) {
          return [sc * p[0] + ox - eps, sc * p[1] + oy - eps, sc * p[2] + oz - eps, sc * p[3] + ox + eps, sc * p[4] + oy + eps, sc * p[5] + oz + eps];
        });
      };
      // the men first, then the lid of the hatch they stand in (a hatch thrown
      // open beside the commander: shown unless he is down inside with it shut)
      var sets = [{ B: boxes(G.parts), kind: (G.kinds || []).indexOf('commander') >= 0 ? 'commander' : 'bust' }];
      if (G.lids && G.lids.length) sets.push({ B: boxes(G.lids), kind: 'lid' });
      var nm = new THREE.Matrix3(), got = 0;
      sets.forEach(function (S) {
      var B = S.B;
      var inside = function (x, y, z) {
        for (var b = 0; b < B.length; b++) {
          var q = B[b];
          if (x >= q[0] && x <= q[3] && y >= q[1] && y <= q[4] && z >= q[2] && z <= q[5]) return b;
        }
        return -1;
      };
      for (k = 0; k < meshes.length; k++) {
        var o = meshes[k], geo = o.geometry, P = geo.attributes.position, idx = geo.index;
        var nTri = (idx ? idx.count : P.count) / 3, crew = [], rest = [];
        for (var t = 0; t < nTri; t++) {
          var a0 = idx ? idx.getX(t * 3) : t * 3, a1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, a2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          var isCrew = true;
          for (var c = 0; c < 3 && isCrew; c++) {
            v.fromBufferAttribute(P, c === 0 ? a0 : c === 1 ? a1 : a2).applyMatrix4(mats[k]);
            if (inside(v.x, v.y, v.z) < 0) isCrew = false;
          }
          if (isCrew) crew.push(a0, a1, a2); else rest.push(a0, a1, a2);
        }
        // …AND THE REST OF HIM (round 106, the final audit). A triangle goes
        // with the crew only when all three of its corners are inside a
        // recorded part, and on some figures the boxes are a centimetre or two
        // tight: the Churchill's and the Stuart's commanders kept their heads,
        // helmets and forearms in the turret, floating over the shut cupola of
        // every buttoned-up tank and every wreck. So a PIECE of the model — a
        // connected run of triangles, corners welded at half a millimetre —
        // that lies 70% or more inside the boxes grown by 2 cm goes too.
        // Measured over all 49 models: a figure's pieces are 75-100% inside,
        // a cupola ring a fifth, a periscope or a vision block by the hatch
        // at most 60%.
        if (S.kind !== 'lid' && rest.length) {
          var gro = 0.017 * sc, Bg = B.map(function (q) { return [q[0] - gro, q[1] - gro, q[2] - gro, q[3] + gro, q[4] + gro, q[5] + gro]; });
          var nV = P.count, FP = new Float32Array(nV * 3), wq = 1 / (0.0005 * sc), wid = {}, nW = 0, W = new Int32Array(nV);
          for (i = 0; i < nV; i++) {
            v.fromBufferAttribute(P, i).applyMatrix4(mats[k]);
            FP[i * 3] = v.x; FP[i * 3 + 1] = v.y; FP[i * 3 + 2] = v.z;
            var wk = Math.round(v.x * wq) + ',' + Math.round(v.y * wq) + ',' + Math.round(v.z * wq);
            if (wid[wk] === undefined) wid[wk] = nW++;
            W[i] = wid[wk];
          }
          var par = new Int32Array(nW), r0;
          for (r0 = 0; r0 < nW; r0++) par[r0] = r0;
          var find = function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
          for (r0 = 0; r0 < rest.length; r0 += 3) {
            var ra = find(W[rest[r0]]), rb = find(W[rest[r0 + 1]]), rc = find(W[rest[r0 + 2]]);
            par[ra] = rb; par[find(rb)] = find(rc);
          }
          // each piece: its welded corners, and how many of them are inside
          var tot = {}, ins = {}, seenW = new Uint8Array(nW);
          for (r0 = 0; r0 < rest.length; r0++) {
            var vi = rest[r0], w0 = W[vi];
            if (seenW[w0]) continue;
            seenW[w0] = 1;
            var root0 = find(w0);
            tot[root0] = (tot[root0] || 0) + 1;
            var px = FP[vi * 3], py = FP[vi * 3 + 1], pz = FP[vi * 3 + 2], hit = false;
            for (var bq = 0; bq < Bg.length && !hit; bq++) {
              var g4 = Bg[bq];
              if (px >= g4[0] && px <= g4[3] && py >= g4[1] && py <= g4[4] && pz >= g4[2] && pz <= g4[5]) hit = true;
            }
            if (hit) ins[root0] = (ins[root0] || 0) + 1;
          }
          var keep = [];
          for (r0 = 0; r0 < rest.length; r0 += 3) {
            var rr = find(W[rest[r0]]);
            if ((ins[rr] || 0) >= 0.7 * tot[rr]) crew.push(rest[r0], rest[r0 + 1], rest[r0 + 2]);
            else keep.push(rest[r0], rest[r0 + 1], rest[r0 + 2]);
          }
          rest = keep;
        }
        if (!crew.length || !rest.length) continue;
        var cg = new THREE.BufferGeometry(), names = Object.keys(geo.attributes);
        nm.getNormalMatrix(mats[k]);
        for (var an = 0; an < names.length; an++) {
          var src = geo.attributes[names[an]], isz = src.itemSize;
          var arr = new Float32Array(crew.length * isz);
          for (var j = 0; j < crew.length; j++) for (var e = 0; e < isz; e++) arr[j * isz + e] = src.array[crew[j] * isz + e];
          var att = new THREE.BufferAttribute(arr, isz, src.normalized);
          if (names[an] === 'position') {
            for (var p2 = 0; p2 < crew.length; p2++) { v.fromBufferAttribute(att, p2).applyMatrix4(mats[k]); att.setXYZ(p2, v.x, v.y, v.z); }
          } else if (names[an] === 'normal') {
            for (var p3 = 0; p3 < crew.length; p3++) { v.fromBufferAttribute(att, p3).applyMatrix3(nm).normalize(); att.setXYZ(p3, v.x, v.y, v.z); }
          }
          cg.setAttribute(names[an], att);
        }
        cg.computeBoundingSphere();
        var cm = new THREE.Mesh(cg, o.material);
        cm.name = 'Crew'; cm.castShadow = o.castShadow; cm.receiveShadow = o.receiveShadow;
        cm.userData.crewKind = S.kind;
        cm.userData.crew = true;            // not plate: no shell marks on him (`_buildMarkPieces`)
        frame.add(cm);
        geo.setIndex(rest);
        geo.computeBoundingSphere();
        got += crew.length / 3;
        if (S.kind === 'lid') kinds.push(gn + ':lid');
      }
      });
      // THE HATCH, SHUT (round 106). With the commander gone the cupola he
      // stood in showed what the bake had left there — his own occlusion, a
      // dark round mark like an open hole — so a buttoned-up tank looked
      // abandoned. A lid now closes over the opening when he is down inside:
      // a disc the size of the hatch on the cupola's top, painted from the
      // roof beside it (a patch of the plate clear of the cupola, laid on by
      // that plate's own linear UV map; failing that, the UV of the nearest
      // up-facing vertex a hatch's width away), shown only while the hatch is
      // shut (`Unit._syncCrewMesh`).
      if (G.covers && G.covers.length && meshes.length) {
        // the group's own plate: its biggest mesh (a hull's wheels may be split out)
        var si = 0;
        for (var mi = 1; mi < meshes.length; mi++) if (meshes[mi].geometry.attributes.position.count > meshes[si].geometry.attributes.position.count) si = mi;
        var src = meshes[si], sg = src.geometry, SP = sg.attributes.position, SN = sg.attributes.normal, SU = sg.attributes.uv;
        var nmat = new THREE.Matrix3().getNormalMatrix(mats[si]), nv = new THREE.Vector3();
        // the plate's level triangles in the frame, with their UVs, so a lid
        // vertex can take the paint straight below a point on the roof
        var TR = [];
        if (SU) {
          var ia = sg.index ? sg.index.array : null, nT = (ia ? ia.length : SP.count) / 3;
          var tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3();
          for (var q0 = 0; q0 < nT; q0++) {
            var j0 = ia ? ia[q0 * 3] : q0 * 3, j1 = ia ? ia[q0 * 3 + 1] : q0 * 3 + 1, j2 = ia ? ia[q0 * 3 + 2] : q0 * 3 + 2;
            tA.fromBufferAttribute(SP, j0).applyMatrix4(mats[si]); tB.fromBufferAttribute(SP, j1).applyMatrix4(mats[si]); tC.fromBufferAttribute(SP, j2).applyMatrix4(mats[si]);
            var ex = tB.x - tA.x, ey = tB.y - tA.y, ez = tB.z - tA.z, fx = tC.x - tA.x, fy = tC.y - tA.y, fz = tC.z - tA.z;
            var cxn = ey * fz - ez * fy, cyn = ez * fx - ex * fz, czn = ex * fy - ey * fx, cl = Math.hypot(cxn, cyn, czn);
            if (cl < 1e-9 || Math.abs(cyn) / cl < 0.6) continue;     // level, either winding (MIRROR_X)
            TR.push(tA.x, tA.y, tA.z, tB.x, tB.y, tB.z, tC.x, tC.y, tC.z,
                    SU.getX(j0), SU.getY(j0), SU.getX(j1), SU.getY(j1), SU.getX(j2), SU.getY(j2));
          }
        }
        // The plate's paint as a linear map at a point: the highest level
        // triangle over (x, z), its UV there, and how UV runs with x and z
        // across that triangle. One map for the whole lid — sampling each
        // vertex on its own crossed the atlas's island seams and smeared a
        // striped wedge of the sheet across the hatch.
        var mapAt = function (x, z) {
          var best = -Infinity, hit = null;
          for (var q1 = 0; q1 < TR.length; q1 += 15) {
            var ax = TR[q1], az = TR[q1 + 2], bx = TR[q1 + 3], bz = TR[q1 + 5], qx = TR[q1 + 6], qz = TR[q1 + 8];
            var dn = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
            if (Math.abs(dn) < 1e-12) continue;
            var l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / dn, l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / dn, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            var y = l1 * TR[q1 + 1] + l2 * TR[q1 + 4] + l3 * TR[q1 + 7];
            if (y > best) { best = y; hit = [q1, l1, l2, l3]; }
          }
          if (!hit) return null;
          var o = hit[0], u0 = TR[o + 9], v0 = TR[o + 10], u1 = TR[o + 11], v1 = TR[o + 12], u2 = TR[o + 13], v2 = TR[o + 14];
          var e1x = TR[o + 3] - TR[o], e1z = TR[o + 5] - TR[o + 2], e2x = TR[o + 6] - TR[o], e2z = TR[o + 8] - TR[o + 2];
          var det = e1x * e2z - e2x * e1z;
          if (Math.abs(det) < 1e-12) return null;
          var du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
          return { u: hit[1] * u0 + hit[2] * u1 + hit[3] * u2, v: hit[1] * v0 + hit[2] * v1 + hit[3] * v2,
                   ux: (du1 * e2z - du2 * e1z) / det, uz: (du2 * e1x - du1 * e2x) / det,
                   vx: (dv1 * e2z - dv2 * e1z) / det, vz: (dv2 * e1x - dv1 * e2x) / det };
        };
        G.covers.forEach(function (cv) {
          var cx = sc * cv[0] + ox, cy = sc * cv[1] + oy, cz = sc * cv[2] + oz, r = sc * cv[3], th = 0.035 * sc;
          var cg2 = new THREE.CylinderGeometry(r, r * 1.02, th, 20, 1);
          cg2.translate(cx, cy + th * 0.5, cz);
          if (SU && SN) {
            var bu = 0, bvv = 0, bd = Infinity;
            for (var q = 0; q < SP.count; q++) {
              nv.fromBufferAttribute(SN, q).applyMatrix3(nmat).normalize();
              if (nv.y < 0.75) continue;
              v.fromBufferAttribute(SP, q).applyMatrix4(mats[si]);
              var dd = Math.hypot(v.x - cx, v.z - cz);
              if (dd < r * 1.6) continue;                      // not the cupola's own (darkened) top
              var score = dd + Math.abs(v.y - cy) * 2;
              if (score < bd) { bd = score; bu = SU.getX(q); bvv = SU.getY(q); }
            }
            var cu = cg2.attributes.uv, cpos = cg2.attributes.position;
            // …and each vertex its own spot of that roof (round 106): the disc
            // laid on the plate 2.6 lid-radii toward the turret's middle, clear
            // of the cupola's ring, so a camouflaged turret's hatch carries the
            // camouflage instead of one texel's flat colour
            var shx = -cx, shz = -cz, shl = Math.hypot(shx, shz);
            if (shl < 1e-4) { shx = 1; shz = 0; shl = 1; }
            shx = shx / shl * r * 2.6; shz = shz / shl * r * 2.6;
            var L = TR.length ? mapAt(cx + shx, cz + shz) : null;
            for (var w = 0; w < cu.count; w++) {
              if (!L) { cu.setXY(w, bu, bvv); continue; }
              var ddx = cpos.getX(w) - cx, ddz = cpos.getZ(w) - cz;
              cu.setXY(w, L.u + L.ux * ddx + L.uz * ddz, L.v + L.vx * ddx + L.vz * ddz);
            }
          }
          var lid = new THREE.Mesh(cg2, src.material);
          lid.name = 'Crew'; lid.castShadow = true; lid.receiveShadow = true;
          lid.userData.crewKind = 'cover'; lid.userData.crew = true;
          lid.visible = false;
          frame.add(lid);
          kinds.push(gn + ':cover');
        });
      }
      if (got) kinds.push(gn + ':' + got);
    });
    g.userData.crewSplit = kinds.join(' ');
  };

  /** Merge every mesh that shares a material into one, ONCE, on the prototype.
   *
   *  The game has its own merge (`Unit._mergeModelMeshes`) and it cannot be
   *  used here: it bakes each mesh's material COLOUR into vertex colours and
   *  collapses everything onto a single `vertexColors` material, which is
   *  exactly right for a model built of flat-shaded boxes and destroys a
   *  textured one — the maps have nowhere to go.
   *
   *  So: group by material, bake each mesh's matrix into its geometry, and
   *  concatenate. An authored vehicle with a hull material and a track material
   *  becomes two draws instead of twelve. Measured on the Nashorn: **+11.4 draw
   *  calls per vehicle before this, and 12 of them cost +2.9 ms of render.**
   *
   *  Done on the prototype, so every clone inherits it for free. */
  E._mergeByMaterial = function (root, _unused, skipSubtree) {
    var THREE = window.THREE;
    var byMat = {}, order = [];
    root.updateMatrixWorld(true);
    var inSkip = function (o) {
      if (!skipSubtree) return false;
      for (var n = o; n; n = n.parent) if (n === skipSubtree) return true;
      return false;
    };
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || Array.isArray(o.material)) return;
      if (inSkip(o)) return;                 // the turret merges on its own
      var id = o.material.uuid;
      if (!byMat[id]) { byMat[id] = { mat: o.material, list: [] }; order.push(id); }
      byMat[id].list.push(o);
    });
    if (!order.length) return;
    var inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var rec = byMat[order[i]];
      if (rec.list.length < 2) continue;              // nothing to gain
      var geos = [], total = 0, hasUv = true, hasN = true;
      for (var j = 0; j < rec.list.length; j++) {
        var m = rec.list[j];
        var geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        var mm = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
        geo.applyMatrix4(mm);
        if (!geo.attributes.uv) hasUv = false;
        if (!geo.attributes.normal) hasN = false;
        total += geo.attributes.position.count;
        geos.push(geo);
      }
      var pos = new Float32Array(total * 3);
      var nor = hasN ? new Float32Array(total * 3) : null;
      var uv = hasUv ? new Float32Array(total * 2) : null;
      var o3 = 0, o2 = 0;
      for (var k = 0; k < geos.length; k++) {
        var gg = geos[k], n = gg.attributes.position.count;
        pos.set(gg.attributes.position.array.subarray(0, n * 3), o3);
        if (nor) nor.set(gg.attributes.normal.array.subarray(0, n * 3), o3);
        if (uv) uv.set(gg.attributes.uv.array.subarray(0, n * 2), o2);
        o3 += n * 3; o2 += n * 2;
        gg.dispose();
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nor) merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      if (uv) merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      merged.computeBoundingSphere();
      var mesh = new THREE.Mesh(merged, rec.mat);
      mesh.castShadow = true;
      out.push(mesh);
      for (var q = 0; q < rec.list.length; q++) {
        var old = rec.list[q];
        if (old.parent) old.parent.remove(old);
      }
    }
    for (var z = 0; z < out.length; z++) root.add(out[z]);
  };

  /** (round 118) TEST HOOK: put decoded models back to their never-asked state (`idle`, no prototype), so one page
   *  can run a seeded battle on the fallbacks after one on the scale models (`tools/probe_simmodel118.js`). The next
   *  `ready`/`clone` asks for each again. `names` limits it; returns the names reset. Nothing in the game calls it. */
  E._forgetForTest = function (names) {
    var out = [];
    for (var k in cache) {
      var r = cache[k];
      if (r.state !== 'ready' || (names && names.indexOf(k) < 0)) continue;
      r.state = 'idle'; r.proto = null; out.push(k);
    }
    return out;
  };
  E.ready = function (name) { var r = cache[name]; if (r && r.state === 'idle') E.want(name); return !!(r && r.state === 'ready'); };
  E.onReady = function (name, cb) {
    var r = cache[name];
    if (!r) return;
    if (r.state === 'ready') { cb(); return; }
    if (r.state === 'loading' || r.state === 'idle') r.onReady.push(cb);
  };

  // ---- PAINT VARIANTS (round 98) --------------------------------------------
  // The same model painted for another theatre — Panzergrau for 1940-42,
  // Afrikakorps brown, winter whitewash (tools/blender/afv.py variants_for).
  // Only the colour map differs, so a variant is one JPEG, shipped in its own
  // script (tools/pack_variants.py) and loaded the first time a map asks for
  // it: a <script> tag, because this game is opened from file:// as often as
  // not, and an XHR there is refused.
  var vtex = {}, vload = {};
  /** The variant's texture, or null while it is not loaded (never throws). */
  E.variantTexture = function (name, variant) {
    var key = name + '.' + variant;
    if (vtex[key]) return vtex[key];
    var V = root.EXT_MODEL_VARIANTS && root.EXT_MODEL_VARIANTS[name];
    var uri = V && V[variant];
    if (!uri || !root.THREE) return null;
    var THREE = root.THREE, img = new Image();
    var tex = new THREE.Texture(img);
    tex.flipY = false;                       // glTF's convention, as the base map's
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    img.onload = function () { tex.needsUpdate = true; };
    img.src = uri;
    vtex[key] = tex;
    return tex;
  };
  /** Load a variant's script once; `cb` when it has registered (or never). */
  E.loadVariant = function (name, variant, cb) {
    var key = name + '.' + variant;
    if (vload[key] === true) { if (cb) cb(); return; }
    if (vload[key] === 'failed') return;
    if (vload[key]) { if (cb) vload[key].push(cb); return; }
    vload[key] = cb ? [cb] : [];
    try {
      var s = document.createElement('script');
      s.src = 'assets/models/variants/' + name + '.' + variant + '.js';
      s.onload = function () {
        var l = vload[key]; vload[key] = true;
        for (var i = 0; i < l.length; i++) { try { l[i](); } catch (e) {} }
      };
      s.onerror = function () { vload[key] = 'failed'; };
      document.head.appendChild(s);
    } catch (e) { vload[key] = 'failed'; }
  };

  /** A fresh Group for one unit: geometry and textures shared, materials not.
   *  `opts.variant` paints it for another theatre when that variant has loaded. */
  E.clone = function (name, opts) {
    var r = cache[name];
    if (r && r.state === 'idle') E.want(name);     // (round 117) first asked for: start its decode
    if (!r || r.state !== 'ready' || !r.proto) return null;
    var g = r.proto.clone(true);
    var mats = [];
    var THREE = root.THREE;
    g.traverse(function (o) {
      if (!o.isMesh) return;
      if (Array.isArray(o.material)) o.material = o.material.map(function (m) { var c = m.clone(); mats.push(c); return c; });
      else if (o.material && o.material.isMeshPhongMaterial && !E.perPixel) {
        // the A/B arm: the same maps, lit per vertex, no relief
        var p = o.material, lm = new THREE.MeshLambertMaterial({ map: p.map, color: 0xffffff, side: p.side });
        lm.name = p.name; lm.userData.painted = true;
        o.material = lm; mats.push(lm);
      }
      else if (o.material) { o.material = o.material.clone(); mats.push(o.material); }
      o.castShadow = true;
    });
    hidden(g.userData, 'materials', mats);
    var vt = opts && opts.variant ? E.variantTexture(name, opts.variant) : null;
    if (vt) for (var mi = 0; mi < mats.length; mi++) if (mats[mi].map) mats[mi].map = vt;
    // the wheels' turn, on this unit's own hull material (round 104)
    var wu = null;
    if (E.spinWheels) g.traverse(function (o) {
      if (!o.isMesh || !o.geometry.attributes.aWheel || Array.isArray(o.material)) return;
      if (!wu) wu = { value: new THREE.Vector2(0, 0) };
      E._wheelMat(o.material, wu, E.runTracks ? o.geometry.userData.trackLoop || null : null);
    });
    if (wu) hidden(g.userData, 'wheelU', wu);
    // The clone's OWN turret, found by position in the tree — `userData.turret`
    // copied from the prototype would point every tank at one shared group and
    // they would all traverse together.
    if (r.proto.userData.turret) {
      var idx = r.proto.children.indexOf(r.proto.userData.turret);
      if (idx >= 0) hidden(g.userData, 'turret', g.children[idx]);
    }
    return g;
  };

  root.ExtModels = E;
})(window);
