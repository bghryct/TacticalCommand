/* ===========================================================================
 * FIGURES — the period soldier, built the way a 1/35 figure kit is built.
 * ---------------------------------------------------------------------------
 * The rifleman was forty boxes on a skeleton: a head a fifth of his height,
 * shoulders nearly half his height across, and every army in one of two
 * uniforms. A Tommy was drawn as a GI and a Red Army rifleman as a German,
 * because the builders were written per weapon — `usInfantry`, `gerInfantry` —
 * and every other nation borrowed whichever one was nearer.
 *
 * This keeps the skeleton — every joint the pose engine drives, in the same
 * tree, with the same names — and replaces what hangs on it:
 *
 *   SHAPE   rounded, tapered parts (lofts of superelliptic rings) instead of
 *           boxes. A thigh is wider at the hip than the knee, a sleeve ends in
 *           a cuff, a torso has a chest and a waist, a boot has a toe. The head
 *           is a head's size, and the legs are a man's length.
 *   KIT     what each army actually wore — 1944, and 1940 for France. The
 *           helmet first, because it is the one thing that reads at any range:
 *           the M1's even brim, the Stahlhelm's flared skirt, the Brodie's
 *           wide flat bowl, the Adrian's crest. Then the cloth: tunic and
 *           trousers as two colours, as they were — an American's light M1941
 *           jacket over darker wool trousers, a German's feldgrau and black
 *           leather. How the lower leg was covered. The webbing, down to which
 *           hip the canteen hung on and whether the pouches rode on the belt
 *           (US, German) or the chest (British).
 *
 * Proportions. The pose table (`INFPOSE`) positions the BODY and bends the
 * JOINTS; it never says where a joint is. So the joints move without a pose
 * changing: hips at 0.585 (was 0.52), the knee 0.29 below (was 0.26) and the
 * sole 0.38 below that (was 0.345) — the sole lands exactly where it did, the
 * legs are ten per cent longer, the man is about seven heads tall instead of
 * five. Arms hang from 0.19 either side of the spine instead of 0.245.
 *
 * Nothing in the simulation reads the drawn man: hits use `_presentedFrac` and
 * a body cylinder, muzzles come from `MUZZLES`. Every shape is built once and
 * shared; the game's skin merge folds a man into one draw call as before.
 *
 *   Figures.kitFor('ukrifle')        -> the kit object (or null: not a period army)
 *   Figures.soldier(cfg, helpers)    -> { g, uniform, dark, skin, gear, head, rig }
 * ======================================================================== */
(function (root) {
  'use strict';
  const THREE = root.THREE;
  if (!THREE) return;
  const TAU = Math.PI * 2;
  const F = {};

  // ------------------------------------------------------------------------
  // GEOMETRY. Everything is a stack of rings.
  // ------------------------------------------------------------------------
  const CACHE = new Map();
  function cached(key, make) {
    if (!CACHE.has(key)) {
      const g = make();
      if (g) g.userData.figShared = true;
      CACHE.set(key, g);
    }
    return CACHE.get(key);
  }
  F.cacheSize = () => CACHE.size;

  /** A stack of superelliptic rings, listed TOP TO BOTTOM (a shell's inner
   *  surface may climb back up — its faces then look inward, which is right).
   *  ring: { y, rx, rz, cx, cz, p (2 = ellipse, higher = squarer), crease }.
   *  A ring of zero radius is a pole. `crease` duplicates the ring so the
   *  edge stays sharp under smooth normals. Angle 0 is the front (+z). */
  function loft(list, seg, o) {
    o = o || {};
    const P = [], I = [], rows = [];
    const vert = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
    const ring = q => {
      const cx = q.cx || 0, cz = q.cz || 0;
      if (q.rx <= 1e-6 && q.rz <= 1e-6) return { pole: vert(cx, q.y, cz) };
      const e = 2 / (q.p || 2), row = [];
      for (let i = 0; i < seg; i++) {
        const t = i / seg * TAU, s = Math.sin(t), c = Math.cos(t);
        let x = cx + q.rx * Math.sign(s) * Math.pow(Math.abs(s), e);
        let z = cz + q.rz * Math.sign(c) * Math.pow(Math.abs(c), e);
        let y = q.y;
        if (o.deform) { const d = o.deform(x, y, z, t, q); x = d[0]; y = d[1]; z = d[2]; }
        row.push(vert(x, y, z));
      }
      return { row };
    };
    const seq = [];
    const first = list[0], last = list[list.length - 1];
    if (o.capTop) seq.push({ y: first.y, rx: 0, rz: 0, cx: first.cx, cz: first.cz }, first);
    for (const q of list) { seq.push(q); if (q.crease) seq.push(q); }
    if (o.capBottom) seq.push(last, { y: last.y, rx: 0, rz: 0, cx: last.cx, cz: last.cz });
    for (const q of seq) rows.push(ring(q));
    for (let k = 0; k + 1 < rows.length; k++) {
      const A = rows[k], B = rows[k + 1];
      if (A.pole !== undefined && B.pole !== undefined) continue;
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        if (A.pole !== undefined) I.push(B.row[i], B.row[j], A.pole);
        else if (B.pole !== undefined) I.push(A.row[i], B.pole, A.row[j]);
        else I.push(A.row[i], B.row[i], A.row[j], B.row[i], B.row[j], A.row[j]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
  F.loft = loft;

  function ellipsoid(rx, ry, rz, seg, rows) {
    const list = [];
    for (let k = 0; k <= rows; k++) {
      const a = k / rows * Math.PI;
      list.push({ y: ry * Math.cos(a), rx: rx * Math.sin(a), rz: rz * Math.sin(a) });
    }
    return loft(list, seg || 10, {});
  }
  /** A lathe profile [[r, y, crease?], ...] top to bottom, squashed in plan. */
  function lathe(profile, seg, sx, sz, deform) {
    return loft(profile.map(q => ({ y: q[1], rx: q[0] * sx, rz: q[0] * sz, crease: !!q[2] })), seg, { deform });
  }
  /** A band round a body — a belt, an armband, a cuff: outer wall, top and
   *  bottom faces; the inner wall is against the body and never seen. */
  function band(rx, rz, h, t, seg, p) {
    return loft([
      { y: h / 2, rx, rz, p, crease: true },
      { y: h / 2, rx: rx + t, rz: rz + t, p, crease: true },
      { y: -h / 2, rx: rx + t, rz: rz + t, p, crease: true },
      { y: -h / 2, rx, rz, p },
    ], seg, {});
  }
  /** A box with its edges broken — a pack, a pouch, a bread bag. */
  function cbox(w, h, d, b, seg) {
    const hw = w / 2, hd = d / 2, hh = h / 2;
    return loft([
      { y: hh, rx: hw - b, rz: hd - b, p: 5 },
      { y: hh - b, rx: hw, rz: hd, p: 5 },
      { y: -hh + b, rx: hw, rz: hd, p: 5 },
      { y: -hh, rx: hw - b, rz: hd - b, p: 5 },
    ], seg || 8, { capTop: true, capBottom: true });
  }
  /** A roll bent into a loop — the Red Army greatcoat worn across the body.
   *  Ellipse of semi-axes a (local x) and b (local y), tube radius r. */
  function roll(a, b, r, seg, tseg) {
    const P = [], I = [];
    for (let i = 0; i < seg; i++) {
      const th = i / seg * TAU;
      const cx = a * Math.cos(th), cy = b * Math.sin(th);
      let nx = Math.cos(th) / a, ny = Math.sin(th) / b;
      const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
      for (let j = 0; j < tseg; j++) {
        const ph = j / tseg * TAU, c = Math.cos(ph), s = Math.sin(ph);
        P.push(cx + r * c * nx, cy + r * c * ny, r * s);
      }
    }
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      for (let j = 0; j < tseg; j++) {
        const j2 = (j + 1) % tseg;
        const A = i * tseg + j, B = i2 * tseg + j, C = i2 * tseg + j2, D = i * tseg + j2;
        I.push(A, B, D, B, C, D);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
  /** A flat ribbon laid over a surface — a strap, a brace. `pts` are points
   *  on the surface with the outward normal at each; the ribbon faces out. */
  function ribbon(pts, w) {
    const P = [], I = [];
    const v = new THREE.Vector3(), t = new THREE.Vector3(), n = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      t.set(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]).normalize();
      n.set(pts[i].n[0], pts[i].n[1], pts[i].n[2]).normalize();
      s.crossVectors(t, n).normalize().multiplyScalar(w / 2);
      v.set(pts[i].p[0], pts[i].p[1], pts[i].p[2]).addScaledVector(n, 0.005);
      P.push(v.x - s.x, v.y - s.y, v.z - s.z, v.x + s.x, v.y + s.y, v.z + s.z);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = i * 2;
      I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
  /** A thin fin swept over a dome from front to back — the Adrian's crest. */
  function crest(ry, rz, y0, h, w, a0, a1, n) {
    const P = [], I = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      const y = y0 + ry * Math.cos(a), z = rz * Math.sin(a);
      let ny = Math.cos(a) / ry, nz = Math.sin(a) / rz;
      const l = Math.hypot(ny, nz); ny /= l; nz /= l;
      const hh = h * Math.min(1, 0.35 + 0.65 * Math.sin(Math.PI * i / n));
      P.push(-w / 2, y, z, w / 2, y, z, w / 2, y + ny * hh, z + nz * hh, -w / 2, y + ny * hh, z + nz * hh);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 4, b = a + 4;
      I.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);   // right side
      I.push(a, b, a + 3, b, b + 3, a + 3);               // left side
      I.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);   // top
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }

  // ------------------------------------------------------------------------
  // CAMOUFLAGE, as a per-vertex multiplier on the part's own colour. The skin
  // merge reads it (`tint`) when it bakes the colour into the vertices.
  // ------------------------------------------------------------------------
  const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
  function hash3(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    let r = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return r;
  }
  /** layers: [[hex, freq, cover, seed], ...] painted over `baseHex` in order. */
  // AT THEIR REAL SIZE (round 106, measured): each colour drawn alone over a
  // 2 m swatch, four slices through the noise, its blots sized by their MEAN
  // CHORD (x 4/pi, the full width of an equal ellipse; robust where the
  // blots merge, which a count of separate blots is not, and steady where an
  // autocorrelation's first zero swung 2:1 between swatches). The first
  // colour of each, at 0.889 figure units to the metre (a rifleman: 1.552 in
  // the bind pose, 1.746 m drawn): splinter 9 x 17 cm, pea-dot 5.4, oak leaf
  // 6.5, frog spot 6.5 — the period cloth's 8 x 16, 5-8, 6-12 and 6. The
  // Zeltbahn is the smock's 1931 splinter, so it shares the smock's numbers.
  const PATTERNS = {
    // Erbsenmuster, the Waffen-SS pea-dot of 1944: a brown ground with green,
    // dark brown and a light ochre in small blots.
    peadot: { base: 0x6d6645, layers: [[0x4c5434, 38, 0.34, 1], [0x4f3d2b, 46, 0.26, 2], [0x8e8762, 53, 0.14, 3]] },
    // Splittermuster, the Fallschirmjäger smock: pale grey-tan with green and
    // brown splinters.
    splinter: { base: 0x8b876b, layers: [[0x5b6444, 20, 0.36, 4], [0x6d593d, 24, 0.24, 5]] },
    // The SS oak-leaf helmet cover, and the US Marine frogskin cover.
    oak: { base: 0x5f693c, layers: [[0x6e5936, 35, 0.4, 6], [0x3f4a2a, 44, 0.22, 7]] },
    frog: { base: 0x61693f, layers: [[0x6f5b3b, 34, 0.36, 8], [0x8c8660, 42, 0.2, 9]] },
    // The German Zeltbahn, rolled on the A-frame: the same 1931 splinter.
    zelt: { base: 0x6a694c, layers: [[0x4f5838, 20, 0.36, 10], [0x6a563a, 24, 0.22, 11]] },
  };
  // PER PIXEL, NOT PER VERTEX (round 106). A man is some 3,500 vertices, a
  // few centimetres apart over his tunic, and a splinter is five to fifteen
  // centimetres — so the pattern sampled at the vertices came out as a faint
  // smear on the Fallschirmjäger smock, and the Waffen-SS pea-dot and the
  // oak-leaf helmet cover did not show at all. Each part now carries WHICH
  // pattern it wears (`camo`, an id) and the skin's shader draws it from the
  // part's own bind-pose position (`F.camoGLSL`, `Unit._skinModel`): the same
  // layers, frequencies and seeds, at their real size, moving with the cloth.
  // `F.pixelCamo = false` puts back the vertex tint.
  F.pixelCamo = true;
  const PATTERN_ID = { peadot: 1, splinter: 2, oak: 3, frog: 4, zelt: 5 };
  function patterned(geo, name) {
    const pat = PATTERNS[name];
    if (!pat) return geo;
    const g = geo.clone();
    const pos = g.attributes.position, n = pos.count;
    const base = lin(pat.base), T = new Float32Array(n * 3);
    if (F.pixelCamo && PATTERN_ID[name]) {
      T.fill(1);
      g.setAttribute('camo', new THREE.BufferAttribute(new Float32Array(n).fill(PATTERN_ID[name]), 1));
    } else for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let c = base;
      for (const [hex, f, cover, seed] of pat.layers) {
        const k = vnoise(x * f + seed * 17.1, y * f - seed * 3.7, z * f + seed * 9.3);
        if (k > 1 - cover) c = lin(hex);
      }
      T[i * 3] = c.r / base.r; T[i * 3 + 1] = c.g / base.g; T[i * 3 + 2] = c.b / base.b;
    }
    g.setAttribute('tint', new THREE.BufferAttribute(T, 3));
    return g;
  }
  F.PATTERNS = PATTERNS;
  F.PATTERN_ID = PATTERN_ID;
  /** The patterns as GLSL: `vec3 figCamo(float id, vec3 p)`, the colour ratio
   *  (layer over ground) at bind-pose position `p` in figure units. Layers
   *  painted in order over the ground, as the vertex version did; each edge
   *  softened over the pixel's own footprint (`fwidth`) so a pattern seen from
   *  afar greys to its average instead of crawling. */
  F.camoGLSL = function () {
    const v3 = c => 'vec3(' + c.r.toFixed(4) + ', ' + c.g.toFixed(4) + ', ' + c.b.toFixed(4) + ')';
    const L = [
      'float fcHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
      'float fcNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mix(fcHash(i), fcHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(fcHash(i + vec3(0.0, 1.0, 0.0)), fcHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),',
      '             mix(mix(fcHash(i + vec3(0.0, 0.0, 1.0)), fcHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(fcHash(i + vec3(0.0, 1.0, 1.0)), fcHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }',
      'vec3 figCamo(float id, vec3 p) {',
      '  vec3 r = vec3(1.0); float k, e;',
    ];
    for (const name of Object.keys(PATTERN_ID)) {
      const pat = PATTERNS[name];
      if (!pat) continue;
      const base = lin(pat.base);
      L.push('  if (abs(id - ' + PATTERN_ID[name].toFixed(1) + ') < 0.5) {');
      // a splinter is a shard, longer than it is wide; the rest are blots —
      // and the Zeltbahn is printed in the same 1931 splinter as the smock
      const an = name === 'splinter' || name === 'zelt' ? 'vec3(1.25, 0.62, 1.25)' : 'vec3(1.0)';
      for (const [hex, f, cover, seed] of pat.layers) {
        const c = lin(hex), ratio = { r: c.r / base.r, g: c.g / base.g, b: c.b / base.b };
        L.push('    k = fcNoise(p * ' + an + ' * ' + f.toFixed(2) + ' + vec3(' + (seed * 17.1).toFixed(2) + ', ' + (-seed * 3.7).toFixed(2) + ', ' + (seed * 9.3).toFixed(2) + '));');
        // value noise bunches round a half; stretched, `cover` is the share
        // of the cloth the colour takes, as the pattern means it
        L.push('    k = clamp((k - 0.5) * 2.1 + 0.5, 0.0, 1.0);');
        L.push('    e = fwidth(k) + 0.0005;');
        L.push('    r = mix(r, ' + v3(ratio) + ', smoothstep(' + (1 - cover).toFixed(3) + ' - e, ' + (1 - cover).toFixed(3) + ' + e, k));');
      }
      L.push('  }');
    }
    L.push('  return r;', '}');
    return L.join('\n');
  };

  // ------------------------------------------------------------------------
  // THE PARTS. Figure units: the man stands about 1.45 tall; +z is his front,
  // -x his right side.
  // ------------------------------------------------------------------------
  // THE SOLE ON THE GROUND (round 106). The leg is 0.67 long (0.29 + 0.38), so
  // with the hips at 0.585 the sole stood 0.085 BELOW the man's feet — ten
  // centimetres of boot under the cobbles at true scale, and a man 1.65 m tall
  // who was built 1.75. The hips go up by the difference; a pose pitches the
  // body about its origin at the ground, so a prone man barely moves.
  const HIPS_Y = 0.67, KNEE_Y = -0.29, SOLE_Y = -0.38, NECK_Y = 0.55, HEAD_Y = 0.14;
  const SOLE_TOP = SOLE_Y + 0.02;
  // THE ANKLE (round 104), in the knee's frame: on the shin's line, seven
  // centimetres of figure above the sole. The boot and the sole hang from it.
  const ANKLE_Y = SOLE_Y + 0.07, ANKLE_Z = -0.005;
  const ARM_X = 0.19, ARM_Y = 0.47, ELBOW_Y = -0.27, HAND_Y = -0.26, LEG_X = 0.095;

  // The jacket's rings, shared by the torso and by everything laid over it.
  const TORSO = [
    { y: 0.585, rx: 0.062, rz: 0.058, cz: -0.012 },
    { y: 0.555, rx: 0.1, rz: 0.08, cz: -0.014, p: 2.2 },
    { y: 0.52, rx: 0.158, rz: 0.098, cz: -0.012, p: 2.6 },
    { y: 0.47, rx: 0.181, rz: 0.112, cz: -0.006, p: 2.8 },
    { y: 0.38, rx: 0.178, rz: 0.126, cz: 0.004, p: 2.6 },
    { y: 0.26, rx: 0.166, rz: 0.126, cz: 0.008, p: 2.5 },
    { y: 0.14, rx: 0.157, rz: 0.118, cz: 0.004, p: 2.4 },
    { y: 0.04, rx: 0.154, rz: 0.114, cz: 0, p: 2.4 },
    { y: -0.04, rx: 0.157, rz: 0.116, cz: 0, p: 2.4 },
  ];
  function torsoRing(y) {
    const L = TORSO;
    if (y >= L[0].y) return L[0];
    for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1];
      if (y <= a.y && y >= b.y) {
        const f = (a.y - y) / (a.y - b.y), m = (u, v) => u + (v - u) * f;
        return { y, rx: m(a.rx, b.rx), rz: m(a.rz, b.rz), cz: m(a.cz || 0, b.cz || 0), p: m(a.p || 2, b.p || 2) };
      }
    }
    return L[L.length - 1];
  }
  /** How far outside the jacket a point is: < 1 inside, 1 on it. */
  function torsoF(x, y, z) {
    const q = torsoRing(y), p = q.p || 2;
    return Math.pow(Math.abs(x) / q.rx, p) + Math.pow(Math.abs(z - (q.cz || 0)) / q.rz, p);
  }
  /** The jacket's surface at height y, at lateral x, front (+1) or back (-1),
   *  with its true outward normal — the gradient, so that over the top of the
   *  shoulder the normal points up and a strap lies flat there. */
  function onTorso(x, y, side) {
    const q = torsoRing(y), p = q.p || 2;
    const fx = Math.min(0.985, Math.abs(x) / q.rx);
    const z = (q.cz || 0) + side * q.rz * Math.pow(1 - Math.pow(fx, p), 1 / p);
    const h = 0.004;
    let nx = (torsoF(x + h, y, z) - torsoF(x - h, y, z)) / (2 * h);
    let ny = (torsoF(x, y + h, z) - torsoF(x, y - h, z)) / (2 * h);
    let nz = (torsoF(x, y, z + h) - torsoF(x, y, z - h)) / (2 * h);
    const l = Math.hypot(nx, ny, nz) || 1;
    return { p: [x, y, z], n: [nx / l, ny / l, nz / l] };
  }
  /** Height of the shoulder ridge at lateral x: where the jacket's width
   *  comes down to |x|. */
  function ridgeY(x) {
    const L = TORSO, ax = Math.abs(x);
    for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1];
      if (ax >= a.rx && ax <= b.rx) return a.y + (b.y - a.y) * (ax - a.rx) / (b.rx - a.rx);
    }
    return L[3].y;
  }
  /** Round the belt at angle a (0 = front, + = his left): [x, z, rotY]. */
  function onBelt(a, out, rx, rz) {
    rx = rx || 0.168; rz = rz || 0.126;
    const x = rx * Math.sin(a), z = rz * Math.cos(a);
    let nx = Math.sin(a) / rx, nz = Math.cos(a) / rz;
    const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    return [x + nx * out, z + nz * out, Math.atan2(nx, nz)];
  }

  const GEO = {
    torso: () => cached('torso', () => loft(TORSO, 12, { capTop: true, capBottom: true })),
    pelvis: () => cached('pelvis', () => loft([
      { y: 0.06, rx: 0.15, rz: 0.108, p: 2.4 },
      { y: 0.0, rx: 0.164, rz: 0.115, p: 2.4 },
      { y: -0.07, rx: 0.155, rz: 0.11, p: 2.4 },
      { y: -0.12, rx: 0.1, rz: 0.08 },
      { y: -0.14, rx: 0, rz: 0 },
    ], 10, { capTop: true })),
    // The skirt of the jacket, below the belt. `len` is how far it hangs.
    skirt: (len, flare) => cached('skirt' + len + ':' + flare, () => loft([
      { y: 0.06, rx: 0.163, rz: 0.12, p: 2.5 },
      { y: -0.02, rx: 0.17 + flare * 0.3, rz: 0.125 + flare * 0.3, p: 2.5 },
      { y: -len, rx: 0.176 + flare, rz: 0.13 + flare, p: 2.5, crease: true },
      { y: -len, rx: 0.155, rz: 0.11, p: 2.5 },
    ], 12, {})),
    // A leg is ten per cent longer than the one it replaces (see the header).
    thigh: (baggy) => cached('thigh' + baggy, () => loft([
      { y: 0.075, rx: 0, rz: 0 },
      { y: 0.055, rx: 0.06, rz: 0.064 },
      { y: 0.0, rx: 0.079 + baggy * 0.4, rz: 0.083 + baggy * 0.3 },
      { y: -0.1, rx: 0.078 + baggy, rz: 0.082 + baggy * 0.6 },
      { y: -0.2, rx: 0.068 + baggy * 0.5, rz: 0.073 + baggy * 0.3 },
      { y: -0.28, rx: 0.06, rz: 0.066 },
      { y: -0.31, rx: 0.042, rz: 0.048 },
      { y: -0.322, rx: 0, rz: 0 },
    ], 8, {})),
    shin: () => cached('shin', () => loft([
      { y: 0.025, rx: 0.059, rz: 0.065 },
      { y: -0.09, rx: 0.058, rz: 0.066, cz: -0.006 },
      { y: -0.2, rx: 0.05, rz: 0.055 },
      { y: -0.27, rx: 0.046, rz: 0.05 },
    ], 8, { capBottom: true })),
    // What covers the lower leg — the national signature below the knee.
    lower: (kind) => cached('lower' + kind, () => {
      const R = (y, r, rz, crease) => ({ y, rx: r, rz: rz || r + 0.006, crease });
      switch (kind) {
        case 'leggings':   // US M1938 canvas leggings, laced up the outside
          return loft([R(-0.075, 0.061, 0.068, true), R(-0.17, 0.059, 0.065), R(-0.27, 0.056, 0.062, true)], 8, { capBottom: true });
        case 'jackboots':  // Marschstiefel, to the calf
          return loft([R(-0.045, 0.066, 0.073, true), R(-0.06, 0.064, 0.071), R(-0.17, 0.06, 0.067), R(-0.27, 0.056, 0.063, true)], 8, { capBottom: true });
        case 'kirza':      // Red Army boots, higher and looser
          return loft([R(-0.02, 0.069, 0.075, true), R(-0.04, 0.066, 0.072), R(-0.2, 0.061, 0.067), R(-0.225, 0.064, 0.07), R(-0.27, 0.057, 0.064, true)], 8, { capBottom: true });
        case 'gaiters':    // German canvas Gamaschen over the ankle boot
        case 'anklets':    // British web anklets
          return loft([R(-0.18, 0.06, 0.066, true), R(-0.27, 0.057, 0.063, true)], 8, { capBottom: true });
        case 'jumpboots':  // Corcoran jump boots, trousers bloused over the top
          return loft([R(-0.12, 0.06, 0.066, true), R(-0.2, 0.058, 0.064), R(-0.27, 0.056, 0.062, true)], 8, { capBottom: true });
        case 'blouse':     // the trouser leg bloused over a jump boot
          return loft([R(-0.07, 0.061, 0.067), R(-0.105, 0.07, 0.076), R(-0.125, 0.062, 0.068)], 8, {});
        case 'puttees': {  // wound puttees — a spiral of ridges, ankle to knee
          const L = [];
          for (let i = 0; i <= 8; i++) {
            const y = -0.03 - i * 0.03, r = 0.054 + 0.012 * (1 - i / 8);
            L.push({ y, rx: r + (i % 2 ? 0.0 : 0.005), rz: r + 0.006 + (i % 2 ? 0.0 : 0.005) });
          }
          return loft(L, 8, {
            capBottom: true,
            deform: (x, y, z, t) => [x, y + 0.011 * (t / TAU - 0.5), z],
          });
        }
        default: return null;
      }
    }),
    // The boot, lofted heel to toe along +z.
    boot: (tall) => cached('boot' + tall, () => {
      const S = SOLE_TOP;
      const g = loft([
        { y: 0.085, rx: 0.047, rz: 0.049, cz: S + 0.049 },
        { y: 0.06, rx: 0.058, rz: 0.054, cz: S + 0.054 },
        { y: -0.02, rx: 0.062, rz: 0.048, cz: S + 0.048 },
        { y: -0.1, rx: 0.06, rz: 0.036, cz: S + 0.036 },
        { y: -0.15, rx: 0.052, rz: 0.027, cz: S + 0.027 },
        { y: -0.178, rx: 0.034, rz: 0.019, cz: S + 0.019 },
      ], 8, { capTop: true, capBottom: true });
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0, -0.005);
      return g;
    }),
    sole: () => cached('sole', () => {
      const g = new THREE.BoxGeometry(0.116, 0.02, 0.272);
      g.translate(0, SOLE_Y + 0.01, 0.045);
      return g;
    }),
    shoulder: () => cached('shoulder', () => ellipsoid(0.068, 0.07, 0.076, 8, 5)),
    upperArm: () => cached('uarm', () => loft([
      { y: 0.0, rx: 0.064, rz: 0.07 },
      { y: -0.1, rx: 0.063, rz: 0.069 },
      { y: -0.2, rx: 0.056, rz: 0.061 },
      { y: -0.27, rx: 0.052, rz: 0.057 },
      { y: -0.29, rx: 0.036, rz: 0.04 },
      { y: -0.3, rx: 0, rz: 0 },
    ], 8, {})),
    forearm: () => cached('farm', () => loft([
      { y: 0.03, rx: 0.046, rz: 0.05 },
      { y: 0.0, rx: 0.053, rz: 0.057 },
      { y: -0.1, rx: 0.053, rz: 0.056 },
      { y: -0.19, rx: 0.046, rz: 0.048, crease: true },
      { y: -0.192, rx: 0.051, rz: 0.053 },
      { y: -0.222, rx: 0.05, rz: 0.052, crease: true },
      { y: -0.222, rx: 0.034, rz: 0.034 },
      { y: -0.23, rx: 0, rz: 0 },
    ], 8, {})),
    hand: () => cached('hand', () => ellipsoid(0.037, 0.05, 0.045, 6, 4)),
    thumb: () => cached('thumb', () => ellipsoid(0.014, 0.027, 0.016, 4, 3)),
    neck: () => cached('neck', () => loft([
      { y: 0.09, rx: 0.041, rz: 0.043 },
      { y: -0.045, rx: 0.049, rz: 0.051 },
    ], 8, { capTop: true })),
    // A collar: a short stand round the neck, lower at the front.
    collar: (h) => cached('collar' + h, () => loft([
      { y: 0.585 + h, rx: 0.05, rz: 0.049, cz: -0.004, crease: true },
      { y: 0.585 + h, rx: 0.059, rz: 0.058, cz: -0.004, crease: true },
      { y: 0.555, rx: 0.08, rz: 0.075, cz: -0.008 },
    ], 12, { deform: (x, y, z, t) => [x, y > 0.57 ? y - 0.016 * front(t) : y, z] })),
    cranium: () => cached('cranium', () => ellipsoid(0.07, 0.093, 0.085, 10, 7)),
    jaw: () => cached('jaw', () => loft([
      { y: -0.005, rx: 0.064, rz: 0.07, cz: 0.004 },
      { y: -0.055, rx: 0.058, rz: 0.066, cz: 0.012 },
      { y: -0.088, rx: 0.042, rz: 0.048, cz: 0.02 },
      { y: -0.104, rx: 0.02, rz: 0.024, cz: 0.03 },
      { y: -0.108, rx: 0, rz: 0, cz: 0.03 },
    ], 8, {})),
    brow: () => cached('brow', () => ellipsoid(0.056, 0.013, 0.02, 6, 3)),
    eye: () => cached('eye', () => ellipsoid(0.017, 0.009, 0.006, 4, 2)),
    ear: () => cached('ear', () => ellipsoid(0.011, 0.025, 0.019, 5, 3)),
    nose: () => cached('nose', () => {
      const g = new THREE.CylinderGeometry(0.004, 0.014, 0.04, 4, 1);
      g.rotateY(Math.PI / 4); g.scale(1, 1, 1.3); g.rotateX(-0.28);
      return g;
    }),
    belt: (h) => cached('belt' + h, () => band(0.158, 0.118, h, 0.01, 12, 2.4)),
    armband: () => cached('armband', () => band(0.064, 0.07, 0.042, 0.006, 8, 2)),
    box: (w, h, d) => cached('b' + w + ':' + h + ':' + d, () => new THREE.BoxGeometry(w, h, d)),
    cbox: (w, h, d, b) => cached('cb' + w + ':' + h + ':' + d + ':' + b, () => cbox(w, h, d, b, 6)),
    ell: (rx, ry, rz) => cached('e' + rx + ':' + ry + ':' + rz, () => ellipsoid(rx, ry, rz, 8, 5)),
    cyl: (r, h, seg) => cached('c' + r + ':' + h + ':' + seg, () => loft([
      { y: h / 2, rx: r, rz: r, crease: true }, { y: -h / 2, rx: r, rz: r },
    ], seg || 8, { capTop: true, capBottom: true })),
    // The German gas-mask canister: fluted, the one thing that says Wehrmacht
    // from behind.
    gasmask: () => cached('gasmask', () => {
      const L = [];
      for (let i = 0; i <= 6; i++) L.push({ y: 0.13 - i * 0.043, rx: i % 2 ? 0.05 : 0.055, rz: i % 2 ? 0.05 : 0.055 });
      return loft(L, 8, { capTop: true, capBottom: true });
    }),
    skatka: () => cached('skatka', () => {
      // The loop's plane holds the diagonal from his left shoulder to his right
      // hip and the front-back axis; it is built flat and turned into place.
      const g = roll(0.335, 0.165, 0.036, 18, 6);
      const D = new THREE.Vector3(0.56, 0.83, 0).normalize(), Z = new THREE.Vector3(0, 0, 1);
      const N = new THREE.Vector3().crossVectors(D, Z);
      g.applyMatrix4(new THREE.Matrix4().makeBasis(D, Z, N));
      g.computeVertexNormals();
      return g;
    }),
  };
  F.GEO = GEO;

  // ---- Straps: ribbons laid over the jacket -------------------------------
  function strapPath(spec) {
    // spec: list of [x, y, side] control points on one face; densified.
    const pts = [];
    for (let i = 0; i + 1 < spec.length; i++) {
      const a = spec[i], b = spec[i + 1];
      const steps = Math.max(1, Math.round(Math.abs(b[1] - a[1]) / 0.05));
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        pts.push(onTorso(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2]));
      }
    }
    const l = spec[spec.length - 1];
    pts.push(onTorso(l[0], l[1], l[2]));
    return pts;
  }
  /** Over the shoulder at |x| = 0.1: up the front from (xf, yf), across the
   *  ridge, down the back to (xb, yb). */
  function strapOver(xf, xb, yf, yb, w) {
    const sx = Math.sign(xf) * 0.1, ry = ridgeY(sx);
    const pts = strapPath([[xf, yf, 1], [sx, 0.49, 1]]);
    for (const f of [0.35, 0.65, 0.88]) pts.push(onTorso(sx, 0.49 + (ry - 0.49) * f, 1));
    const top = torsoRing(ry);
    pts.push({ p: [sx, ry + 0.002, top.cz || 0], n: [Math.sign(sx) * 0.3, 1, 0] });
    for (const f of [0.88, 0.65, 0.35]) pts.push(onTorso(sx, 0.49 + (ry - 0.49) * f, -1));
    return ribbon(pts.concat(strapPath([[sx, 0.49, -1], [xb, yb, -1]])), w);
  }
  function strapKey(k, make) { return cached('strap' + k, make); }

  // ------------------------------------------------------------------------
  // HEADGEAR. Lathe profiles [r, y, crease], top to bottom, then back up
  // the inside. Head frame: the eyes are at y 0, the crown at 0.105.
  // ------------------------------------------------------------------------
  const front = t => (1 + Math.cos(t)) / 2;          // 1 at the front, 0 at the back
  const HELMETS = {
    // US M1: a deep bowl with an even, narrow brim and the rolled steel rim.
    m1: {
      sx: 0.9, sz: 1.0, y: 0.022, tilt: -0.1,
      prof: [[0, 0.142], [0.045, 0.139], [0.078, 0.126], [0.1, 0.104], [0.113, 0.078], [0.12, 0.05], [0.123, 0.03],
             [0.127, 0.019, 1], [0.137, 0.009], [0.14, 0.003, 1], [0.133, -0.001, 1], [0.12, 0.012], [0.112, 0.04], [0, 0.06]],
    },
    // Stahlhelm M40/42: the dome breaks into a flared skirt that sweeps down
    // over the ears and out over the neck, and rises to a short visor.
    stahl: {
      sx: 0.92, sz: 1.0, y: 0.03, tilt: -0.06,
      prof: [[0, 0.132], [0.045, 0.129], [0.078, 0.117], [0.099, 0.097], [0.11, 0.072], [0.116, 0.046], [0.118, 0.022],
             [0.119, 0.003, 1], [0.128, -0.022], [0.142, -0.046, 1], [0.136, -0.05, 1], [0.122, -0.024], [0.111, 0.004], [0, 0.035]],
      deform: (x, y, z, t) => {
        const f = front(t);
        if (y < 0.004) {
          y = y + (0.004 - y) * 0.62 * Math.pow(f, 1.5);
          const back = 1 - f, k = 1 + 0.07 * back * Math.min(1, -y / 0.05);
          x *= k; z *= k;
        }
        return [x, y, z];
      },
    },
    // Brodie Mk II: the shallow bowl on a wide flat brim.
    brodie: {
      sx: 0.88, sz: 1.02, y: 0.05, tilt: 0.06,
      prof: [[0, 0.1], [0.045, 0.097], [0.078, 0.086], [0.098, 0.068], [0.108, 0.048], [0.113, 0.028], [0.115, 0.014, 1],
             [0.14, 0.006], [0.158, -0.002], [0.164, -0.008, 1], [0.16, -0.012, 1], [0.14, -0.006], [0.115, 0.004], [0, 0.03]],
    },
    // SSh-40: a tall dome, a short flare, the front a little higher.
    ssh40: {
      sx: 0.9, sz: 1.0, y: 0.028, tilt: -0.04,
      prof: [[0, 0.146], [0.045, 0.143], [0.078, 0.13], [0.1, 0.108], [0.114, 0.08], [0.121, 0.05], [0.124, 0.022],
             [0.126, 0.0], [0.13, -0.012, 1], [0.134, -0.02, 1], [0.127, -0.022, 1], [0.12, -0.008], [0.112, 0.02], [0, 0.05]],
      deform: (x, y, z, t) => {
        if (y < 0.02) y = y + (0.02 - y) * 0.45 * Math.pow(front(t), 2);
        return [x, y, z];
      },
    },
    // Adrian M26: a dome on a brim peaked front and back; the crest is added.
    adrian: {
      sx: 0.88, sz: 1.0, y: 0.03, tilt: -0.03,
      prof: [[0, 0.118], [0.045, 0.115], [0.078, 0.103], [0.1, 0.083], [0.11, 0.06], [0.114, 0.038], [0.116, 0.024, 1],
             [0.132, 0.014], [0.15, 0.006, 1], [0.146, 0.002, 1], [0.118, 0.012], [0, 0.04]],
      deform: (x, y, z, t) => {
        const r = Math.hypot(x / 0.88, z);
        if (r > 0.117) {
          const c2 = Math.cos(t) * Math.cos(t), ext = (r - 0.116) * (1 + 1.7 * c2), k = (0.116 + ext) / r;
          x *= k; z *= k;
          y -= 0.02 * c2 * Math.min(1, (r - 0.116) / 0.034);
        }
        return [x, y, z];
      },
    },
    // Italian M33: rounder than the Stahlhelm, the skirt shorter, flared behind.
    m33: {
      sx: 0.92, sz: 1.0, y: 0.03, tilt: -0.05,
      prof: [[0, 0.14], [0.045, 0.137], [0.078, 0.124], [0.1, 0.103], [0.112, 0.078], [0.118, 0.05], [0.12, 0.024],
             [0.121, 0.004, 1], [0.13, -0.018], [0.138, -0.03, 1], [0.132, -0.034, 1], [0.12, -0.014], [0.11, 0.015], [0, 0.045]],
      deform: (x, y, z, t) => {
        if (y < 0.004) {
          y = y + (0.004 - y) * 0.5 * Math.pow(front(t), 2);
          const k = 1 + 0.05 * (1 - front(t)) * Math.min(1, -y / 0.03);
          x *= k; z *= k;
        }
        return [x, y, z];
      },
    },
    // Japanese Type 90: a round dome and a small flat brim.
    type90: {
      sx: 0.9, sz: 1.0, y: 0.03, tilt: -0.05,
      prof: [[0, 0.136], [0.045, 0.133], [0.078, 0.121], [0.1, 0.1], [0.112, 0.075], [0.118, 0.048], [0.12, 0.024],
             [0.122, 0.01, 1], [0.13, 0.0], [0.134, -0.006, 1], [0.128, -0.008, 1], [0.118, 0.006], [0, 0.04]],
    },
    // Fallschirmjäger M38: no brim at all — a rounded shell cut close.
    fj: {
      sx: 0.92, sz: 1.0, y: 0.028, tilt: -0.04,
      prof: [[0, 0.132], [0.045, 0.129], [0.078, 0.117], [0.1, 0.097], [0.112, 0.072], [0.118, 0.045], [0.12, 0.02],
             [0.121, -0.004], [0.123, -0.022, 1], [0.117, -0.024, 1], [0.112, 0.0], [0, 0.03]],
      deform: (x, y, z, t) => {
        if (y < 0.02) y = y + (0.02 - y) * 0.6 * Math.pow(front(t), 2);
        return [x, y, z];
      },
    },
  };
  function helmetGeo(kind, camo) {
    return cached('helm' + kind + ':' + (camo || ''), () => {
      const H = HELMETS[kind];
      const g = lathe(H.prof, 12, H.sx, H.sz, H.deform);
      return camo ? patterned(g, camo) : g;
    });
  }
  /** A point on a helmet's dome at angle t (0 front) and height y. */
  function onHelmet(kind, t, y) {
    const H = HELMETS[kind], P = H.prof;
    let r = P[1][0];
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      if (y <= a[1] && y >= b[1] && b[1] < a[1]) { r = a[0] + (b[0] - a[0]) * (a[1] - y) / (a[1] - b[1]); break; }
    }
    return [r * H.sx * Math.sin(t), y, r * H.sz * Math.cos(t)];
  }

  const CAPS = {
    // Red Army pilotka: a boat-shaped side cap worn to the right.
    pilotka: () => cached('pilotka', () => loft([
      { y: 0.14, rx: 0.018, rz: 0.088, crease: true },
      { y: 0.11, rx: 0.06, rz: 0.1 },
      { y: 0.075, rx: 0.074, rz: 0.1, crease: true },
      { y: 0.05, rx: 0.075, rz: 0.098 },
    ], 12, { capBottom: true })),
    // A beret: the Commando green, the maquisard's black.
    beret: () => cached('beret', () => {
      const g = ellipsoid(0.098, 0.03, 0.102, 12, 6);
      g.translate(0, 0.088, -0.004);
      return g;
    }),
    beretBand: () => cached('beretBand', () => band(0.072, 0.086, 0.018, 0.004, 12, 2)),
    // German M43 Einheitsfeldmütze / Gebirgsjäger Bergmütze: crown, turn-up, short peak.
    feldmutze: () => cached('feldmutze', () => loft([
      { y: 0.145, rx: 0.058, rz: 0.07, crease: true },
      { y: 0.13, rx: 0.075, rz: 0.088, crease: true },
      { y: 0.06, rx: 0.075, rz: 0.088 },
    ], 12, { capTop: true, capBottom: true })),
    peak: () => cached('peak', () => {
      const g = ellipsoid(0.066, 0.006, 0.048, 10, 4);
      return g;
    }),
    // Peaked service cap (Schirmmütze / furazhka): a wide crown on a band.
    visor: () => cached('visorcap', () => loft([
      { y: 0.16, rx: 0.098, rz: 0.108, crease: true },
      { y: 0.145, rx: 0.102, rz: 0.112, crease: true },
      { y: 0.115, rx: 0.078, rz: 0.088 },
    ], 14, { capTop: true, capBottom: true })),
    visorBand: () => cached('visorBand', () => band(0.074, 0.086, 0.04, 0.004, 14, 2)),
    // The French officer's kepi, soft pattern, tilted forward.
    kepi: () => cached('kepi', () => loft([
      { y: 0.17, rx: 0.07, rz: 0.08, crease: true },
      { y: 0.06, rx: 0.076, rz: 0.089 },
    ], 12, { capTop: true, capBottom: true })),
    hood: () => cached('hood', () => ellipsoid(0.105, 0.1, 0.11, 12, 7)),
  };

  // ------------------------------------------------------------------------
  // THE KITS. Colours are the cloth as issued, not a team hue.
  // ------------------------------------------------------------------------
  const K = (base, over) => Object.assign({}, base, over);
  const KITS = {};
  KITS.us = {
    army: 'us',
    tunic: 0x877b57, collar: 0x5c5540, trousers: 0x5a4f3a, skin: 0xc28a63,
    jacket: 'm41', skirt: 0.10, flare: 0.004, breastPockets: false,
    head: 'm1', helm: 0x4b4f35,
    legs: 'leggings', legC: 0x8e8465, boots: 0x5e3f28,
    web: 'us', webC: 0x8a8060, pack: 'm28', packC: 0x857b5b,
    rifle: { len: 1.08, woodC: 0x6a4424, clip: true }, nade: 'mk2',
    officerHead: 'm1', officerMark: 'stripe',
  };
  KITS.uspara = K(KITS.us, {
    tunic: 0x8d8461, trousers: 0x857c5c, collar: 0x8d8461, jacket: 'm42', skirt: 0.12, cargo: true,
    legs: 'jumpboots', boots: 0x4d311f, pack: 'none', scrim: true, rifle: { len: 1.08, woodC: 0x6a4424, clip: true },
  });
  KITS.usmc = K(KITS.us, {
    tunic: 0x60654a, trousers: 0x5c6146, collar: 0x60654a, helmCamo: 'frog', helm: 0x61693f, pack: 'none',
  });
  KITS.usranger = K(KITS.us, { pack: 'none', helmMark: 'diamond' });
  KITS.uk = {
    army: 'uk',
    tunic: 0x6c5b3c, collar: 0x6c5b3c, trousers: 0x685839, skin: 0xc48c65,
    jacket: 'bd', skirt: 0, flare: 0, breastPockets: true, mapPocket: true,
    head: 'brodie', helm: 0x58543a, scrim: true,
    legs: 'anklets', legC: 0x8b8864, boots: 0x201d1a,
    web: 'uk', webC: 0x8b8864, pack: 'uk', packC: 0x8b8864,
    rifle: { len: 1.13, woodC: 0x5b3b22 }, nade: 'mills',
    officerHead: 'brodie',
  };
  KITS.ukcommando = K(KITS.uk, { head: 'beret', helm: 0x2e4a2b, pack: 'none', scrim: false });
  KITS.ger = {
    army: 'ger',
    tunic: 0x5c604e, collar: 0x454a3c, trousers: 0x56594b, skin: 0xc38b64,
    jacket: 'm40', skirt: 0.11, flare: 0.006, breastPockets: true, skirtPockets: true,
    head: 'stahl', helm: 0x4d5245,
    legs: 'jackboots', legC: 0x1d1b18, boots: 0x1d1b18,
    web: 'ger', webC: 0x1f1d1a, pack: 'ger', packC: 0x4f5545,
    rifle: { len: 1.11, woodC: 0x5c3d24 }, nade: 'stick',
    officerHead: 'visor', capC: 0x5c604e, bandC: 0x2f3a2c,
  };
  KITS.gerss = K(KITS.ger, { camo: 'peadot', tunic: 0x6d6645, trousers: 0x6d6645, collar: 0x6d6645, helmCamo: 'oak', helm: 0x5f693c });
  KITS.gerfj = K(KITS.ger, {
    jacket: 'smock', skirt: 0.16, flare: 0.012, camo: 'splinter', tunic: 0x8b876b, collar: 0x8b876b, trousers: 0x5e6367,
    head: 'fj', helm: 0x6b6a51, legs: 'jumpboots', boots: 0x1d1b18, pack: 'none', bandolier: true, skirtPockets: false,
  });
  KITS.gergebirg = K(KITS.ger, { head: 'bergmutze', legs: 'gaiters', legC: 0x56594b, boots: 0x2a2119 });
  KITS.gervolks = K(KITS.ger, { tunic: 0x5b5a4a, collar: 0x5b5a4a, trousers: 0x55544a, legs: 'gaiters', legC: 0x5d5b4a, pack: 'none' });
  KITS.sov = {
    army: 'sov',
    tunic: 0x7d7651, collar: 0x7d7651, trousers: 0x6a6446, skin: 0xc48c65,
    jacket: 'gym', skirt: 0.12, flare: 0.008, breastPockets: true, breeches: 0.014,
    head: 'ssh40', helm: 0x4b5335,
    legs: 'kirza', legC: 0x201d1a, boots: 0x201d1a,
    web: 'sov', webC: 0x5b3b22, pouchC: 0x5f4e35, pack: 'sidor', packC: 0x6d654a, skatka: 0x6c6352,
    rifle: { len: 1.23, woodC: 0x5a3a22, bayonet: true }, nade: 'rgd',
    officerHead: 'visor', capC: 0x7d7651, bandC: 0x8a2a24,
  };
  KITS.sovsmg = K(KITS.sov, { head: 'pilotka', helm: 0x7d7651, skatka: 0 });
  KITS.fr = {
    army: 'fr',
    tunic: 0x7b6c46, collar: 0x7b6c46, trousers: 0x6f6243, skin: 0xc48c65,
    jacket: 'm38', skirt: 0.12, flare: 0.006, breastPockets: true,
    head: 'adrian', helm: 0x5b5a41,
    legs: 'puttees', legC: 0x6d6041, boots: 0x3f2b1c,
    web: 'fr', webC: 0x5a3b22, pack: 'none',
    rifle: { len: 1.02, woodC: 0x5a3a22 }, nade: 'mk2',
    officerHead: 'kepi', capC: 0x7b6c46,
  };
  KITS.frmaquis = K(KITS.fr, {
    tunic: 0x5c4b3a, collar: 0x5c4b3a, trousers: 0x57534c, jacket: 'civil', skirt: 0.13, breastPockets: false,
    head: 'beret', helm: 0x1d1d20, legs: 'none', boots: 0x2e2218, web: 'civil', armband: 0xe6e2d6,
  });
  KITS.it = {
    army: 'it',
    tunic: 0x6b6b53, collar: 0x6b6b53, trousers: 0x666650, skin: 0xc08861,
    jacket: 'm40', skirt: 0.11, flare: 0.006, breastPockets: true,
    head: 'm33', helm: 0x5b5e4a,
    legs: 'puttees', legC: 0x666650, boots: 0x3f2b1c,
    web: 'it', webC: 0x55573f, pack: 'none',
    rifle: { len: 1.18, woodC: 0x5f3f24 }, nade: 'srcm',
    officerHead: 'pilotka', capC: 0x6b6b53,
  };
  KITS.itbersag = K(KITS.it, { plume: true });
  KITS.jp = {
    army: 'jp',
    tunic: 0x8a7a4b, collar: 0x8a7a4b, trousers: 0x85764a, skin: 0xbf8a5e,
    jacket: 'm38', skirt: 0.12, flare: 0.006, breastPockets: true,
    head: 'type90', helm: 0x676243, star: true,
    legs: 'puttees', legC: 0x857649, boots: 0x4a3322,
    web: 'jp', webC: 0x5e3e25, pack: 'jp', packC: 0x7b6c45,
    rifle: { len: 1.2, woodC: 0x6a4424, bayonet: true }, nade: 'type97',
    officerHead: 'feldmutze', capC: 0x8a7a4b,
  };
  KITS.jpsnlf = K(KITS.jp, { tunic: 0x5c6040, trousers: 0x585c3e, collar: 0x5c6040, legC: 0x585c3e });
  F.KITS = KITS;

  // Which kit a unit id wears. The id's own prefix is its army (see
  // `nationOf`); the ids named after their weapon are listed.
  const BY_TYPE = {
    uspara: 'uspara', usmarine: 'usmc', usranger: 'usranger',
    ukcommando: 'ukcommando',
    gerss: 'gerss', gerfj: 'gerfj', gergebirg: 'gergebirg', gervolks: 'gervolks',
    sovppsh: 'sovsmg', sovsapper: 'sovsmg',
    frmaquis: 'frmaquis', itbersag: 'itbersag', jpsnlf: 'jpsnlf',
    bazooka: 'us', fiftycal: 'us', sniper: 'us',
    panzerfaust: 'ger', mg42: 'ger', schreck: 'ger', mg34: 'ger',
    maxim: 'sov',
  };
  const PREFIX = [['us', 'us'], ['uk', 'uk'], ['ger', 'ger'], ['sov', 'sov'], ['fr', 'fr'], ['it', 'it'], ['jp', 'jp']];
  F.kitKey = function (type) {
    if (!type) return null;
    if (BY_TYPE[type]) return BY_TYPE[type];
    for (const [p, k] of PREFIX) if (type.startsWith(p)) return k;
    return null;
  };
  F.kitFor = function (type) {
    const k = F.kitKey(type);
    return k ? KITS[k] : null;
  };
  const MEDICS = new Set(['usmedic', 'gersani', 'ukramc', 'sovsanin', 'jpeisei', 'itportaf', 'frbrancard']);
  F.isMedic = type => MEDICS.has(type);

  // ------------------------------------------------------------------------
  // THE SOLDIER
  // ------------------------------------------------------------------------
  /**
   * cfg: { kit, helmet, webbing, pack, gearC, helmC, medic, officer } — the
   * builder's own flags still count: `pack: false` (a gunner, a flamethrower),
   * `helmet: 'cap'` (an officer's head), `helmet: 'hood'` (a sniper).
   * H: { mat(hex) -> Material }.
   */
  F.soldier = function (cfg, H) {
    const kit = cfg.kit;
    const mats = new Map();
    const M = hex => { let m = mats.get(hex); if (!m) { m = H.mat(hex); mats.set(hex, m); } return m; };
    const put = (parent, geo, hex, x, y, z, rx, ry, rz) => {
      const m = new THREE.Mesh(geo, M(hex));
      m.position.set(x || 0, y || 0, z || 0);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      parent.add(m);
      return m;
    };
    const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();
    const camoGeo = (key, geo) => kit.camo ? cached(key + ':' + kit.camo, () => patterned(geo, kit.camo)) : geo;
    const officer = cfg.helmet === 'cap' || cfg.officer;
    const sniper = cfg.helmet === 'hood';
    const medic = !!cfg.medic;
    const tunicC = kit.tunic, trouserC = kit.trousers;

    const g = new THREE.Group();
    const body = new THREE.Group(); g.add(body);
    const hips = new THREE.Group(); hips.position.y = HIPS_Y; body.add(hips);

    // ---- legs --------------------------------------------------------------
    const leg = (side) => {
      const legG = new THREE.Group(); legG.position.x = side * LEG_X; hips.add(legG);
      // `userData.flex`: a limb part whose skin bends with the joint at its end
      // (round 104, `Unit._skinModel`) rather than staying rigid on one bone
      put(legG, camoGeo('thigh' + (kit.breeches || 0), GEO.thigh(kit.breeches || 0)), trouserC).userData.flex = 'leg';
      if (kit.cargo) put(legG, GEO.cbox(0.036, 0.12, 0.1, 0.01), shade(trouserC, 0.92), side * 0.082, -0.12, 0.012);
      if (kit.mapPocket && side > 0) put(legG, GEO.box(0.085, 0.1, 0.02), shade(trouserC, 0.9), 0.012, -0.08, 0.082, -0.05, 0, 0);
      const knee = new THREE.Group(); knee.position.y = KNEE_Y; legG.add(knee);
      put(knee, camoGeo('shin', GEO.shin()), trouserC).userData.flex = 'leg';
      const lower = kit.legs && kit.legs !== 'none' ? GEO.lower(kit.legs) : null;
      if (lower) {
        const c = kit.legs === 'jumpboots' ? kit.boots : kit.legC;
        put(knee, lower, c).userData.flex = 'leg';
        if (kit.legs === 'jumpboots') put(knee, camoGeo('blouse', GEO.lower('blouse')), trouserC).userData.flex = 'leg';
        if (kit.legs === 'leggings') put(knee, GEO.box(0.006, 0.17, 0.018), shade(kit.legC, 0.7), side * 0.062, -0.175, 0.0);
      }
      // THE FOOT TURNS AT THE ANKLE (round 104): it was part of the shin, so
      // a walking man's boots tipped with his shins and a kneeling man's toes
      // stood in the air. Built where they were, hung from the joint.
      const ankle = new THREE.Group(); ankle.position.set(0, ANKLE_Y, ANKLE_Z); knee.add(ankle);
      const boot = put(ankle, GEO.boot(0), kit.boots, 0, -ANKLE_Y, -ANKLE_Z);
      boot.userData.flex = 'leg';
      put(ankle, GEO.sole(), shade(kit.boots, 0.55), 0, -ANKLE_Y, -ANKLE_Z);
      return { leg: legG, knee, ankle, boot };
    };
    const L = leg(-1), R = leg(1);
    // the seat of the trousers, and the jacket's skirt over it
    put(hips, camoGeo('pelvis', GEO.pelvis()), trouserC).userData.flex = 'hip';
    if (kit.skirt > 0) {
      put(hips, camoGeo('skirt' + kit.skirt + ':' + kit.flare, GEO.skirt(kit.skirt, kit.flare)), tunicC, 0, 0.03, 0).userData.flex = 'hip';
      if (kit.skirtPockets) for (const sx of [-1, 1]) {
        put(hips, GEO.box(0.088, 0.08, 0.02), shade(tunicC, 0.94), sx * 0.085, -0.02, 0.126, 0, sx * 0.3, 0);
        put(hips, GEO.box(0.094, 0.028, 0.024), shade(tunicC, 0.84), sx * 0.085, 0.024, 0.127, 0, sx * 0.3, 0);
      }
    }

    // ---- torso ---------------------------------------------------------------
    const spine = new THREE.Group(); spine.position.y = 0.03; hips.add(spine);
    put(spine, camoGeo('torso', GEO.torso()), tunicC).userData.flex = 'torso';
    put(spine, GEO.collar(0.035), kit.collar);
    if (kit.breastPockets) for (const sx of [-1, 1]) {
      const s = onTorso(sx * 0.083, 0.34, 1);
      put(spine, GEO.box(0.084, 0.088, 0.018), shade(tunicC, 0.95), s.p[0], 0.33, s.p[2] + 0.006, 0, sx * 0.25, 0);
      put(spine, GEO.box(0.09, 0.03, 0.022), shade(tunicC, 0.84), s.p[0], 0.385, s.p[2] + 0.008, -0.08, sx * 0.25, 0);
    }
    if (kit.jacket === 'm42' || kit.jacket === 'smock') for (const sx of [-1, 1]) {
      // the jump jacket's slanted chest pockets
      const s = onTorso(sx * 0.08, 0.3, 1);
      put(spine, GEO.cbox(0.1, 0.12, 0.03, 0.008), shade(tunicC, 0.92), s.p[0], 0.3, s.p[2] + 0.01, 0, sx * 0.25, sx * -0.3);
    }

    // ---- webbing -----------------------------------------------------------------
    const web = cfg.webbing === 'none' || sniper ? 'none' : (kit.web || 'none');
    const packOk = cfg.pack !== false && !officer && !sniper;
    const webC = kit.webC;
    const onBeltPut = (geo, hex, a, y, out, extraRotY) => {
      const [x, z, ry] = onBelt(a, out);
      return put(spine, geo, hex, x, y, z, 0, ry + (extraRotY || 0), 0);
    };
    if (web !== 'none' && web !== 'civil') {
      put(spine, GEO.belt(0.05), webC, 0, 0.02, 0);
      const buckle = { us: 0x6d6448, ger: 0x8a8b83, uk: 0x8f8b62, sov: 0xa28c4c, fr: 0x8a7a52, it: 0x8a8b83, jp: 0x7a6a44 }[web];
      put(spine, GEO.box(0.046, 0.042, 0.012), buckle, 0, 0.02, 0.134);
    }
    if (web === 'us') {
      // M1923 cartridge belt: ten pockets, five each side of the buckle
      for (const s of [-1, 1]) for (let k = 0; k < 5; k++)
        onBeltPut(GEO.box(0.052, 0.07, 0.032), webC, s * (0.42 + k * 0.3), 0.022, 0.026);
      // suspenders, and the canteen on the right hip
      for (const s of [-1, 1]) put(spine, strapKey('us' + s, () => strapOver(s * 0.075, s * 0.07, 0.05, 0.1, 0.028)), webC);
      onBeltPut(GEO.ell(0.05, 0.075, 0.03), webC, -2.05, -0.05, 0.04);
      if (packOk && kit.pack === 'm28') {
        put(spine, GEO.cbox(0.19, 0.3, 0.075, 0.014), kit.packC, 0, 0.29, -0.158);
        put(spine, GEO.cbox(0.12, 0.19, 0.035, 0.008), webC, 0, 0.065, -0.152);        // the e-tool under it
        put(spine, GEO.box(0.022, 0.26, 0.03), 0x3f3e33, 0.105, 0.3, -0.16);           // bayonet on the pack
      }
    } else if (web === 'ger') {
      // two sets of three-cell pouches either side of the buckle
      for (const s of [-1, 1]) {
        onBeltPut(GEO.cbox(0.125, 0.074, 0.04, 0.008), webC, s * 0.56, 0.024, 0.024);
      }
      // the Y-straps: two up the front, over the shoulders, one down the back
      for (const s of [-1, 1]) put(spine, strapKey('gerY' + s, () => strapOver(s * 0.07, s * 0.03, 0.05, 0.36, 0.026)), webC);
      put(spine, strapKey('gerYb', () => ribbon(strapPath([[0, 0.37, -1], [0, 0.04, -1]]), 0.026)), webC);
      // bread bag and canteen on the right hip, e-tool and bayonet on the left
      onBeltPut(GEO.cbox(0.2, 0.15, 0.07, 0.016), 0x6f6a54, -2.25, -0.055, 0.042);
      onBeltPut(GEO.ell(0.047, 0.076, 0.033), 0x5c4530, -1.72, -0.085, 0.06);
      onBeltPut(GEO.cyl(0.034, 0.045, 8), 0x1d1c1a, -1.72, 0.0, 0.06);
      onBeltPut(GEO.cbox(0.14, 0.19, 0.03, 0.01), 0x1e1c19, 1.95, -0.085, 0.024);
      onBeltPut(GEO.box(0.024, 0.25, 0.035), 0x1b1a18, 1.62, -0.1, 0.05);
      // the fluted gas-mask canister, slung across the back
      put(spine, GEO.gasmask(), 0x4d5546, 0.02, 0.1, -0.175, 0, 0, 1.15);
      if (packOk && kit.pack === 'ger') {
        // A-frame: the mess tin over the rolled Zeltbahn
        put(spine, GEO.cbox(0.15, 0.13, 0.065, 0.028), kit.packC, 0, 0.39, -0.158);
        put(spine, cached('zelt', () => patterned(cbox(0.22, 0.09, 0.06, 0.022, 8), 'zelt')), 0x6a694c, 0, 0.27, -0.152);
      }
    } else if (web === 'uk') {
      // '37 pattern: the two big basic pouches on the chest
      for (const s of [-1, 1]) {
        const p = onTorso(s * 0.085, 0.22, 1);
        put(spine, GEO.cbox(0.1, 0.115, 0.058, 0.012), webC, p.p[0], 0.21, p.p[2] + 0.03, 0.08, s * 0.18, 0);
        put(spine, GEO.box(0.104, 0.03, 0.062), shade(webC, 0.9), p.p[0], 0.27, p.p[2] + 0.031, 0.08, s * 0.18, 0);
        put(spine, strapKey('ukB' + s, () => strapOver(s * 0.085, -s * 0.12, 0.28, 0.05, 0.03)), webC);
      }
      onBeltPut(GEO.cyl(0.05, 0.14, 10), webC, -1.95, -0.05, 0.04);                   // water bottle
      onBeltPut(GEO.box(0.022, 0.22, 0.03), webC, 1.72, -0.06, 0.03);                 // helve and bayonet
      if (packOk && kit.pack === 'uk') {
        put(spine, GEO.cbox(0.24, 0.2, 0.08, 0.016), kit.packC, 0, 0.37, -0.162);
        put(spine, GEO.cbox(0.12, 0.13, 0.035, 0.01), webC, 0, 0.16, -0.152);
      }
    } else if (web === 'sov') {
      for (const s of [-1, 1]) onBeltPut(GEO.cbox(0.072, 0.078, 0.038, 0.008), kit.pouchC, s * 0.5, 0.022, 0.022);
      onBeltPut(GEO.ell(0.05, 0.075, 0.034), kit.packC, -1.95, -0.05, 0.04);
      onBeltPut(GEO.cbox(0.13, 0.19, 0.03, 0.01), kit.packC, 1.95, -0.08, 0.024);
      if (kit.skatka) put(spine, GEO.skatka(), kit.skatka, 0.012, 0.268, -0.004);
      else put(spine, strapKey('sovS', () => strapOver(0.07, -0.1, 0.05, 0.05, 0.026)), kit.packC);
      if (packOk && kit.pack === 'sidor') {
        put(spine, GEO.ell(0.12, 0.14, 0.07), kit.packC, 0, 0.27, -0.172);
        put(spine, GEO.cyl(0.028, 0.05, 8), shade(kit.packC, 0.85), 0, 0.42, -0.165);
      }
    } else if (web === 'jp') {
      for (const s of [-1, 1]) onBeltPut(GEO.cbox(0.1, 0.07, 0.045, 0.01), webC, s * 0.56, 0.024, 0.026);
      onBeltPut(GEO.cbox(0.13, 0.08, 0.05, 0.01), webC, Math.PI, 0.024, 0.028);
      onBeltPut(GEO.ell(0.048, 0.07, 0.04), 0x5e4b30, -1.9, -0.06, 0.045);
      onBeltPut(GEO.cbox(0.17, 0.15, 0.06, 0.015), 0x7d7048, 2.0, -0.06, 0.04);
      onBeltPut(GEO.box(0.022, 0.32, 0.03), 0x1f1d1a, 1.4, -0.14, 0.035);
      if (packOk && kit.pack === 'jp') {
        put(spine, GEO.cbox(0.25, 0.23, 0.1, 0.02), kit.packC, 0, 0.3, -0.176);
        put(spine, GEO.cyl(0.045, 0.32, 10), 0x6d5f40, 0, 0.44, -0.17, 0, 0, Math.PI / 2);
      }
    } else if (web === 'it') {
      for (const s of [-1, 1]) for (const a of [0.4, 0.78]) onBeltPut(GEO.cbox(0.07, 0.08, 0.045, 0.01), webC, s * a, 0.024, 0.026);
      for (const s of [-1, 1]) put(spine, strapKey('itY' + s, () => strapOver(s * 0.07, s * 0.07, 0.05, 0.05, 0.024)), webC);
      onBeltPut(GEO.cbox(0.19, 0.15, 0.065, 0.016), 0x6a6a52, -2.15, -0.055, 0.04);
      onBeltPut(GEO.ell(0.047, 0.074, 0.034), 0x5a4a38, -1.7, -0.08, 0.06);
    } else if (web === 'fr') {
      for (const s of [-1, 1]) onBeltPut(GEO.cbox(0.09, 0.09, 0.05, 0.01), webC, s * 0.56, 0.02, 0.028);
      onBeltPut(GEO.cbox(0.11, 0.085, 0.05, 0.01), webC, Math.PI, 0.02, 0.028);
      for (const s of [-1, 1]) put(spine, strapKey('frY' + s, () => strapOver(s * 0.07, s * 0.03, 0.05, 0.36, 0.024)), webC);
      put(spine, strapKey('gerYb', () => ribbon(strapPath([[0, 0.37, -1], [0, 0.04, -1]]), 0.026)), webC);
      onBeltPut(GEO.cbox(0.2, 0.17, 0.06, 0.016), 0x6f6446, -2.1, -0.05, 0.035);
      onBeltPut(GEO.ell(0.055, 0.09, 0.04), 0x6c5f3f, -1.6, -0.07, 0.06);
    } else if (web === 'civil') {
      put(spine, strapKey('civS', () => strapOver(0.08, -0.1, 0.05, 0.05, 0.024)), 0x4a3a28);
      onBeltPut(GEO.cbox(0.2, 0.16, 0.06, 0.016), 0x6a5e44, -2.0, -0.02, 0.035);
    }
    if (kit.bandolier) {
      // the Fallschirmjäger's twelve-pocket bandolier round the neck
      for (const s of [-1, 1]) {
        put(spine, strapKey('fjB' + s, () => {
          const pts = strapPath([[s * 0.07, 0.52, 1], [s * 0.1, 0.16, 1]]);
          return ribbon(pts, 0.055);
        }), 0x6d6a4a);
      }
    }

    // ---- head --------------------------------------------------------------
    const neck = new THREE.Group(); neck.position.y = NECK_Y; spine.add(neck);
    put(neck, GEO.neck(), kit.skin, 0, 0.0, -0.004).userData.flex = 'neck';   // blends into the collar (round 106)
    const head = new THREE.Group(); head.position.y = HEAD_Y; neck.add(head);
    const skull = put(head, GEO.cranium(), kit.skin, 0, 0.012, -0.008);
    put(head, GEO.jaw(), kit.skin);
    put(head, GEO.brow(), shade(kit.skin, 0.95), 0, 0.016, 0.07);
    for (const s of [-1, 1]) {
      put(head, GEO.eye(), shade(kit.skin, 0.36), s * 0.026, 0.001, 0.077);
      put(head, GEO.ear(), shade(kit.skin, 0.94), s * 0.07, -0.012, -0.006);
    }
    put(head, GEO.nose(), kit.skin, 0, -0.024, 0.086);

    let helmet = null;
    let headKind = sniper ? 'hood' : officer ? (kit.officerHead || kit.head) : kit.head;
    if (headKind === 'bergmutze') headKind = 'feldmutze';
    if (HELMETS[headKind]) {
      const Hd = HELMETS[headKind];
      // A group carries the helmet's seat and tilt, so the markings, scrim and
      // plume ride on it. They must not be CHILDREN OF THE HELMET MESH: the
      // skin merge only folds in meshes without children, and a helmet with
      // its markings hung on it stayed out as a separate, flat-shaded draw.
      const hg = new THREE.Group(); hg.position.y = Hd.y; hg.rotation.x = Hd.tilt; head.add(hg);
      helmet = put(hg, helmetGeo(headKind, kit.helmCamo), kit.helm);
      const mark = (hex, t, y, w, h, rz) => {
        const p = onHelmet(headKind, t, y);
        return put(hg, GEO.box(w, h, 0.008), hex, p[0], p[1], p[2], 0, t, rz || 0);
      };
      if (headKind === 'adrian') put(hg, cached('crest', () => crest(0.1, 0.1, 0.018, 0.024, 0.014, -1.25, 1.25, 12)), kit.helm);
      if (kit.star && headKind === 'type90') mark(0xb49a4c, 0, 0.07, 0.024, 0.024, Math.PI / 4);
      if (kit.plume) for (let i = 0; i < 6; i++) {
        const f = put(hg, GEO.ell(0.012, 0.01, 0.075), i % 2 ? 0x1c1f1b : 0x262a23,
          -0.1 - i * 0.004, 0.06 - i * 0.006, -0.03 - i * 0.012, 0.35 + i * 0.1, -0.35 + i * 0.05, 0.25);
        f.scale.set(1, 1, 1 + i * 0.08);
      }
      if (officer && kit.officerMark === 'stripe') mark(0xe8e4d8, Math.PI, 0.06, 0.018, 0.07);
      if (kit.helmMark === 'diamond') mark(0xd8782a, Math.PI, 0.06, 0.034, 0.034, Math.PI / 4);
      if (medic && kit.army === 'us') for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        mark(0xe8e4d8, t, 0.072, 0.052, 0.052);
        const p = onHelmet(headKind, t, 0.072);
        const n = [Math.sin(t) * 0.006, 0, Math.cos(t) * 0.006];
        put(hg, GEO.box(0.042, 0.012, 0.006), 0xb02a22, p[0] + n[0], p[1], p[2] + n[2], 0, t, 0);
        put(hg, GEO.box(0.012, 0.042, 0.006), 0xb02a22, p[0] + n[0], p[1], p[2] + n[2], 0, t, 0);
      }
      if (kit.scrim) {
        // burlap scrim through the helmet net
        for (let i = 0; i < 9; i++) {
          const t = i * 2.39996, y = 0.05 + (i % 3) * 0.028;
          const p = onHelmet(headKind, t, Math.min(y, HELMETS[headKind].prof[2][1]));
          put(hg, GEO.box(0.034, 0.01, 0.05), i % 3 === 1 ? 0x5b5c3c : 0x74663f,
            p[0] * 1.03, p[1] + 0.006, p[2] * 1.03, 0.4 * Math.sin(i * 1.7), t, 0.5 * Math.cos(i * 2.3));
        }
      }
    } else if (headKind === 'pilotka') {
      helmet = put(head, CAPS.pilotka(), officer ? kit.capC : kit.helm, 0, 0.0, -0.005, 0, 0, -0.12);
      if (kit.army === 'sov') put(head, GEO.ell(0.011, 0.011, 0.005), 0xa82a1e, -0.008, 0.095, 0.095);
    } else if (headKind === 'beret') {
      helmet = put(head, CAPS.beret(), kit.helm, 0, 0, 0, 0, 0, -0.26);
      put(head, CAPS.beretBand(), shade(kit.helm, 0.8), 0, 0.064, -0.004);
      if (kit.army === 'uk') put(head, GEO.box(0.02, 0.026, 0.006), 0xb8b8b0, 0.05, 0.085, 0.082, 0, 0.5, 0);
    } else if (headKind === 'feldmutze') {
      helmet = put(head, CAPS.feldmutze(), officer ? kit.capC : kit.tunic, 0, 0, -0.004);
      put(head, CAPS.peak(), shade(officer ? kit.capC : kit.tunic, 0.8), 0, 0.058, 0.086, 0.12, 0, 0);
      if (kit.army === 'jp') put(head, GEO.box(0.018, 0.018, 0.006), 0xb49a4c, 0, 0.1, 0.09, 0, 0, Math.PI / 4);
      else put(head, GEO.box(0.02, 0.012, 0.006), 0x9a9a8a, -0.05, 0.08, 0.06, 0, -0.6, 0);   // the edelweiss
    } else if (headKind === 'visor') {
      helmet = put(head, CAPS.visor(), kit.capC, 0, 0, -0.004);
      put(head, CAPS.visorBand(), kit.bandC, 0, 0.098, -0.004);
      put(head, CAPS.peak(), 0x1b1c19, 0, 0.078, 0.092, 0.3, 0, 0);
    } else if (headKind === 'kepi') {
      helmet = put(head, CAPS.kepi(), kit.capC, 0, 0, -0.012, -0.18, 0, 0);
      put(head, CAPS.peak(), 0x1b1c19, 0, 0.062, 0.088, 0.2, 0, 0);
    } else if (headKind === 'hood') {
      helmet = put(head, CAPS.hood(), shade(kit.tunic, 0.8), 0, 0.03, -0.012);
    }

    // ---- arms ------------------------------------------------------------------
    const arm = (side) => {
      const a = new THREE.Group(); a.position.set(side * ARM_X, ARM_Y, 0); spine.add(a);
      put(a, camoGeo('shoulder', GEO.shoulder()), tunicC, 0, -0.012, 0).userData.flex = 'arm';
      put(a, camoGeo('uarm', GEO.upperArm()), tunicC).userData.flex = 'arm';
      const elbow = new THREE.Group(); elbow.position.y = ELBOW_Y; a.add(elbow);
      put(elbow, camoGeo('farm', GEO.forearm()), tunicC).userData.flex = 'arm';
      const hand = new THREE.Group(); hand.position.y = HAND_Y; elbow.add(hand);
      put(hand, GEO.hand(), kit.skin, 0, -0.004, 0.006);
      put(hand, GEO.thumb(), kit.skin, -side * 0.03, 0.004, 0.028, 0.3, 0, 0);
      return { arm: a, elbow, hand };
    };
    const AL = arm(-1), AR = arm(1);
    // medic's armband on the left arm; the FFI armband
    if (medic || kit.armband) {
      const band = put(AR.arm, GEO.armband(), kit.armband || 0xe8e4d8, 0, -0.07, 0);
      if (medic) {
        put(AR.arm, GEO.box(0.004, 0.028, 0.009), 0xb02a22, 0.071, -0.07, 0);
        put(AR.arm, GEO.box(0.004, 0.009, 0.028), 0xb02a22, 0.071, -0.07, 0);
      }
      band.userData.fixed = true;
    }

    const aim = new THREE.Group(); aim.position.set(0.02, 0.36, 0.1); spine.add(aim);

    const uniform = M(tunicC), dark = M(trouserC), skin = M(kit.skin), gear = M(webC || tunicC);
    const rig = {
      body, hips, spine, neck, head, helmet, aim,
      legL: L.leg, legR: R.leg, kneeL: L.knee, kneeR: R.knee, bootL: L.boot, bootR: R.boot,
      ankleL: L.ankle, ankleR: R.ankle,
      armL: AL.arm, armR: AR.arm, elbowL: AL.elbow, elbowR: AR.elbow, handL: AL.hand, handR: AR.hand,
      mats: { uniform, dark, light: uniform, skin, gear },
      v2: true, kit,
    };
    rig.rest = {
      bodyY: 0, hipsY: HIPS_Y,
      armL: { x: -0.35, z: 0.16 }, armR: { x: -0.35, z: -0.16 },
      elbowL: -0.9, elbowR: -0.9,
    };
    AL.arm.rotation.set(-0.35, 0, 0.16); AR.arm.rotation.set(-0.35, 0, -0.16);
    AL.elbow.rotation.x = -0.9; AR.elbow.rotation.x = -0.9;
    return { g, uniform, dark, skin, gear, head: skull, rig };
  };

  /** The team's colour as armbands on both upper arms. */
  F.armbands = function (rig, mat) {
    const out = [];
    for (const a of [rig.armL, rig.armR]) {
      const m = new THREE.Mesh(GEO.armband(), mat);
      m.position.set(0, -0.125, 0);
      a.add(m); out.push(m);
    }
    return out;
  };

  /** A grenade of the man's own army, hung on his kit. */
  F.grenades = function (rig, kit, n, H) {
    const M = hex => H.mat(hex);
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = i % 2 ? 1 : -1, k = Math.floor(i / 2);
      let m;
      switch (kit.nade) {
        case 'stick': {       // tucked into the belt, handle down
          m = new THREE.Group();
          const head = new THREE.Mesh(GEO.cyl(0.03, 0.075, 8), M(0x4d5343)); head.position.y = 0.07; m.add(head);
          const h = new THREE.Mesh(GEO.cyl(0.013, 0.2, 6), M(0x6a4a2c)); h.position.y = -0.06; m.add(h);
          const p = onBelt(s * (0.2 + k * 0.2), 0.035);
          m.position.set(p[0], 0.04, p[1]); m.rotation.set(0.15, 0, s * 0.2);
          break;
        }
        case 'rgd': case 'type97': case 'srcm': {
          const c = kit.nade === 'srcm' ? 0xa4322a : kit.nade === 'rgd' ? 0x4b5238 : 0x3f4430;
          m = new THREE.Mesh(GEO.cyl(0.026, kit.nade === 'rgd' ? 0.1 : 0.07, 8), M(c));
          const p = onBelt(s * (1.0 + k * 0.25), 0.035);
          m.position.set(p[0], 0.04, p[1]);
          break;
        }
        default: {            // Mk 2 / Mills: the pineapple, hooked on a strap
          m = new THREE.Mesh(GEO.ell(0.03, 0.04, 0.03), M(kit.nade === 'mills' ? 0x4a4f36 : 0x4a5236));
          const p = onTorso(s * 0.075, 0.2 + k * 0.08, 1);
          m.position.set(p.p[0], p.p[1], p.p[2] + 0.034);
        }
      }
      rig.spine.add(m); out.push(m);
    }
    return out;
  };

  F.onBelt = onBelt;
  F.onTorso = onTorso;
  root.Figures = F;
})(window);
