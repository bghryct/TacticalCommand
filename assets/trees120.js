/* ===========================================================================
 * TREES 120 — species with branches, leaf-cluster cards, three LODs and impostors (round 120, `game.trees120`)
 * ---------------------------------------------------------------------------
 * The trees of rounds 98-113 are a forked skeleton under a crown of icosphere clumps that the canopy shader cuts
 * with noise: a ball of leaves, the same cauliflower everywhere, one broadleaf for every theatre, 1,000-3,200
 * triangles at every distance and a two-octave noise with a discard in every pixel of every crown — 18 of Village's
 * 37 ms at the zoom limit (round 119). This draws them again:
 *
 *   · SPECIES grown in Blender (tools/blender/trees120.py -> assets/trees120.pack.js): a skeleton (trunk with a
 *     root flare, limbs, branches, twigs) and LEAF-CLUSTER CARDS hung on the twigs — oak, beech, ash, elm, Lombardy
 *     poplar, pollard willow, apple, chestnut, birch, linden, olive, spruce, Scots pine, stone pine, cypress,
 *     acacia, date palm, coconut; three of each. The pack is the skeleton and the cards, not triangles: `build`
 *     makes the tubes and quads here, at load.
 *   · THE LEAF ATLAS is drawn on a canvas at load (`atlas`): a spray of each species' leaves on its twig, the stem
 *     at the bottom of the cell where the twig holds the card. Nothing is downloaded. Its colour is a MODULATION
 *     of the vertex colour (x2), so one sprite takes any green, and the alpha keeps its coverage down the mips
 *     (the cut is scaled by the mip level, or a crown thins to nothing at range).
 *   · ONE MATERIAL (`material`) on the game's Lambert: bark (kind 3: grain, birch's lenticels, a palm's rings) and
 *     cards (kind 5), the wind on the trunk, on each limb with its own phase, and on the leaves; the canopy's snow,
 *     winter bareness, the near-eye sky (round 118) and the cloud deck; light through the leaves against the sun.
 *   · THREE LODs by PROJECTED SIZE (`pack`, from PropBatcher.cull): the whole tree near, a reduced one (no twigs,
 *     the cards merged) in the middle distance, and past that an IMPOSTOR — one quad per tree, from frames of the
 *     tree baked here at load (`Imp.bake`: albedo and the bent normal, three rings of eight azimuths), lit per
 *     pixel, blended between the four nearest frames, its own shadow from the frame nearest the sun. The bands
 *     cross-fade by a screen dither, so nothing pops. Every impostor on the map is ONE draw.
 *
 * Nothing here touches the simulation: every tree keeps its cell, its height (`simVK`) and its rng draws; this
 * only changes what is drawn, inside the cosmetic stream.
 * ======================================================================== */
(function (root) {
  'use strict';
  var T = root.Trees120 = root.Trees120 || {};
  T.v = 1;

  // ---- the species ------------------------------------------------------------------------------------------
  T.CELL = { oak: 0, beech: 1, ash: 2, elm: 3, poplar: 4, willow: 5, apple: 6, chestnut: 7, birch: 8, linden: 9,
    olive: 10, spruce: 11, pine: 12, stonepine: 13, cypress: 14, acacia: 15, palm: 16, coco: 17, ivy: 18, twigs: 19 };
  T.TWIG_CELL = 19;
  // evergreen: no bareness in the snow (the material's `uT120Dec` 0)
  T.EVERGREEN = { spruce: 1, pine: 1, stonepine: 1, cypress: 1, olive: 1, datepalm: 1, coco: 1 };
  // bark styles (hedge.z on kind 3): 0 grain, 1 birch, 2 palm rings, 3 plane-smooth (beech)
  T.BARK = { birch: 1, datepalm: 2, coco: 2, beech: 3 };

  function mulberry(seed) {
    return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function hash2(x, z) { var h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); }

  // ============================================================================================================
  // 1. THE LEAF ATLAS — a spray of each species' leaves, drawn on a canvas
  // ============================================================================================================
  var AT = T.AT = { cols: 8, rows: 4, cell: 256 };
  /** The half-width of a leaf at `t` (0 its base, 1 its tip), as a share of its length. */
  var LEAF = {
    ovate: function (t) { return 0.30 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.9); },
    oak: function (t) { return (0.20 + 0.13 * Math.abs(Math.sin(Math.PI * 4.5 * t))) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.7); },
    elm: function (t) { return 0.29 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.85) * (1 + 0.07 * ((t * 22) % 1)); },
    deltoid: function (t) { return 0.40 * Math.pow(1 - t, 0.85) * Math.sin(Math.min(1, t * 3.2) * Math.PI / 2); },
    lance: function (t) { return 0.115 * Math.sin(Math.PI * Math.pow(t, 0.85)); },
    willow: function (t) { return 0.085 * Math.sin(Math.PI * Math.pow(t, 0.8)); },
    chestnut: function (t) { return 0.17 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 + 0.10 * ((t * 16) % 1)); },
    heart: function (t) { return 0.44 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.75) * (t < 0.06 ? t / 0.06 * 0.7 + 0.3 : 1); },
    small: function (t) { return 0.36 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.9); },
  };
  /** Each cell's spray: leaf shape, leaves, their length in px, side stems, and a palette of modulations. */
  var SPRAY = {
    oak: { leaf: 'oak', n: 49, len: 30, stems: 3, ang: 52, tone: [1.0, 1.0, 1.0] },
    beech: { leaf: 'ovate', n: 57, len: 25, stems: 3, ang: 62, tone: [1.02, 1.04, 0.98], flat: 1 },
    ash: { leaf: 'pinnate', n: 13, len: 53, stems: 3, ang: 40, tone: [1.04, 1.04, 1.0] },
    elm: { leaf: 'elm', n: 60, len: 22, stems: 3, ang: 58, tone: [0.98, 1.0, 1.0] },
    poplar: { leaf: 'deltoid', n: 64, len: 19, stems: 3, ang: 30, tone: [1.0, 1.02, 0.98] },
    willow: { leaf: 'willow', n: 83, len: 34, stems: 4, ang: 26, tone: [1.0, 1.0, 1.02], hang: 1 },
    apple: { leaf: 'ovate', n: 49, len: 23, stems: 3, ang: 55, tone: [1.0, 1.0, 1.0], fruit: 5 },
    chestnut: { leaf: 'chestnut', n: 34, len: 45, stems: 3, ang: 48, tone: [0.98, 1.0, 1.0] },
    birch: { leaf: 'deltoid', n: 49, len: 16, stems: 4, ang: 40, tone: [1.04, 1.06, 0.96], twiggy: 1, hang: 1 },
    linden: { leaf: 'heart', n: 45, len: 26, stems: 3, ang: 55, tone: [1.0, 1.02, 0.98] },
    olive: { leaf: 'lance', n: 76, len: 25, stems: 4, ang: 38, tone: [0.98, 1.0, 1.04], silver: 1 },
    spruce: { needle: 'spray', n: 0, tone: [1.0, 1.0, 1.0] },
    pine: { needle: 'tuft', n: 0, tone: [1.0, 1.0, 1.0] },
    stonepine: { needle: 'tuft', dense: 1, n: 0, tone: [1.02, 1.04, 1.0] },
    cypress: { needle: 'scale', n: 0, tone: [1.0, 1.0, 1.0] },
    acacia: { leaf: 'bipinnate', n: 0, tone: [1.0, 1.0, 1.0] },
    palm: { frond: 'date', n: 0, tone: [1.0, 1.0, 1.0] },
    coco: { frond: 'coco', n: 0, tone: [1.0, 1.0, 1.0] },
    ivy: { leaf: 'small', n: 57, len: 17, stems: 3, ang: 60, tone: [0.75, 0.82, 0.85] },
    twigs: { twigs: 1, n: 0, stems: 4, tone: [1.0, 1.0, 1.0] },
  };

  /** The modulation (x2 in the shader) as a CSS colour: 1 = the vertex colour itself. */
  function mod(r, g, b) {
    var c = function (v) { return Math.max(0, Math.min(255, Math.round(v * 127.5))); };
    return 'rgb(' + c(r) + ',' + c(g) + ',' + c(b) + ')';
  }

  function drawSpray(cc, ca, x0, y0, S, spec, R) {
    var tone = spec.tone;
    var twig = mod(0.95, 0.52, 0.85);
    var both = function (fn) { fn(cc, true); fn(ca, false); };
    // the cell's background colour (where alpha is 0) is the leaves' own, darkened: what a mip blends toward
    cc.fillStyle = mod(0.72 * tone[0], 0.72 * tone[1], 0.72 * tone[2]); cc.fillRect(x0, y0, S, S);
    // stems: one main stem from the bottom centre (where the twig holds the card) and side stems off it
    var stems = [];
    var bx = x0 + S * 0.5, by = y0 + S * 0.985;
    var main = { x0: bx, y0: by, x1: bx + (R() - 0.5) * S * 0.16, y1: y0 + S * (0.10 + R() * 0.06) };
    stems.push(main);
    var ns = spec.stems || 3;
    for (var k = 1; k < ns; k++) {
      var t = 0.25 + 0.5 * (k / ns) + (R() - 0.5) * 0.1;
      var sx = main.x0 + (main.x1 - main.x0) * t, sy = main.y0 + (main.y1 - main.y0) * t;
      var side = k % 2 ? -1 : 1, a = (side * (28 + R() * 22)) * Math.PI / 180;
      var L = S * (0.36 + R() * 0.12) * (1 - t * 0.4);
      stems.push({ x0: sx, y0: sy, x1: sx + Math.sin(a) * L, y1: sy - Math.cos(a) * L });
    }
    both(function (c, col) {
      c.strokeStyle = col ? twig : '#fff'; c.lineCap = 'round';
      for (var i = 0; i < stems.length; i++) {
        var s = stems[i]; c.lineWidth = i ? S * 0.010 : S * 0.016;
        c.beginPath(); c.moveTo(s.x0, s.y0); c.quadraticCurveTo((s.x0 + s.x1) / 2 + (s.y1 - s.y0) * 0.06, (s.y0 + s.y1) / 2, s.x1, s.y1); c.stroke();
      }
    });
    var leaves = [];
    if (spec.leaf && spec.leaf !== 'pinnate' && spec.leaf !== 'bipinnate') {
      var per = Math.max(2, Math.round(spec.n / stems.length));
      for (var si = 0; si < stems.length; si++) {
        var st = stems[si];
        for (var j = 0; j < per; j++) {
          var tt = 0.22 + 0.78 * (j + R() * 0.6) / per;
          if (j === per - 1) tt = 1.0;
          var px = st.x0 + (st.x1 - st.x0) * tt, py = st.y0 + (st.y1 - st.y0) * tt;
          var dirA = Math.atan2(st.x1 - st.x0, -(st.y1 - st.y0));
          var sd = (j % 2 ? 1 : -1);
          var ang = dirA + (j === per - 1 ? (R() - 0.5) * 0.3 : sd * (spec.ang + (R() - 0.5) * 22) * Math.PI / 180);
          if (spec.hang) ang = dirA + sd * (spec.ang * 1.6 + R() * 30) * Math.PI / 180;
          var len = spec.len * (0.78 + R() * 0.4) * S / 256 * (j === per - 1 ? 1.08 : 1);
          leaves.push({ x: px, y: py, a: ang, L: len, l: 0.86 + R() * 0.3, h: (R() - 0.5) });
        }
      }
    }
    var shape = LEAF[spec.leaf] || LEAF.ovate;
    var leafPath = function (c, lf, fn, w) {
      c.save(); c.translate(lf.x, lf.y); c.rotate(lf.a);
      c.beginPath(); c.moveTo(0, 0);
      var N = 18, k;
      for (k = 1; k <= N; k++) { var t = k / N; c.lineTo(fn(t) * lf.L * (w || 1), -t * lf.L); }
      for (k = N - 1; k >= 1; k--) { var t2 = k / N; c.lineTo(-fn(t2) * lf.L * (w || 1), -t2 * lf.L); }
      c.closePath(); c.restore();
    };
    // back to front: the lower leaves first
    leaves.sort(function (a, b) { return a.y - b.y; }).reverse();
    for (var li = 0; li < leaves.length; li++) {
      var lf = leaves[li];
      var r = tone[0] * lf.l * (1 + lf.h * 0.10), g = tone[1] * lf.l, b = tone[2] * lf.l * (1 - lf.h * 0.18);
      if (spec.silver && li % 3 === 0) { r *= 1.25; g *= 1.18; b *= 1.6; }      // the olive shows its silver underside
      leafPath(cc, lf, shape); cc.fillStyle = mod(r, g, b); cc.fill();
      leafPath(ca, lf, shape); ca.fillStyle = '#fff'; ca.fill();
      // the midrib, lighter; the edge a touch darker
      cc.save(); cc.translate(lf.x, lf.y); cc.rotate(lf.a);
      cc.strokeStyle = mod(r * 1.22, g * 1.18, b * 1.1); cc.lineWidth = Math.max(0.8, lf.L * 0.035);
      cc.beginPath(); cc.moveTo(0, 0); cc.lineTo(0, -lf.L * 0.92); cc.stroke(); cc.restore();
    }
    if (spec.leaf === 'pinnate') {           // the ash: a rachis with paired lanceolate leaflets
      for (var si2 = 0; si2 < stems.length; si2++) {
        var s2 = stems[si2], dA = Math.atan2(s2.x1 - s2.x0, -(s2.y1 - s2.y0));
        for (var p = 0; p < 2; p++) {
          var tq = 0.45 + p * 0.45, cx = s2.x0 + (s2.x1 - s2.x0) * tq, cy = s2.y0 + (s2.y1 - s2.y0) * tq;
          var ra = dA + (p ? 0 : (si2 % 2 ? 0.6 : -0.6)), RL = spec.len * S / 256 * (0.8 + R() * 0.3);
          both(function (c, col) { c.strokeStyle = col ? mod(0.9, 1.05, 0.7) : '#fff'; c.lineWidth = S * 0.006; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.sin(ra) * RL, cy - Math.cos(ra) * RL); c.stroke(); });
          for (var q = 0; q < spec.n; q++) {
            var tf = (q + 0.7) / spec.n, lx = cx + Math.sin(ra) * RL * tf, ly = cy - Math.cos(ra) * RL * tf;
            for (var sdd = -1; sdd <= 1; sdd += 2) {
              var lf2 = { x: lx, y: ly, a: ra + sdd * 1.05, L: RL * 0.30, l: 0.86 + R() * 0.3, h: R() - 0.5 };
              if (q === spec.n - 1 && sdd > 0) lf2.a = ra;
              leafPath(cc, lf2, LEAF.lance, 1.9); cc.fillStyle = mod(tone[0] * lf2.l, tone[1] * lf2.l, tone[2] * lf2.l); cc.fill();
              leafPath(ca, lf2, LEAF.lance, 1.9); ca.fillStyle = '#fff'; ca.fill();
            }
          }
        }
      }
    }
    if (spec.leaf === 'bipinnate') {         // the acacia: tiers of fine leaflets in flat sprays
      for (var si3 = 0; si3 < stems.length; si3++) {
        var s3 = stems[si3];
        for (var p3 = 0; p3 < 9; p3++) {
          var t3 = 0.2 + 0.8 * p3 / 9, x3 = s3.x0 + (s3.x1 - s3.x0) * t3, y3 = s3.y0 + (s3.y1 - s3.y0) * t3;
          for (var sd3 = -1; sd3 <= 1; sd3 += 2) {
            var a3 = Math.atan2(s3.x1 - s3.x0, -(s3.y1 - s3.y0)) + sd3 * 1.3, L3 = S * (0.10 + R() * 0.05);
            for (var q3 = 0; q3 < 9; q3++) {
              var u3 = (q3 + 0.5) / 9, lx3 = x3 + Math.sin(a3) * L3 * u3, ly3 = y3 - Math.cos(a3) * L3 * u3, l3 = 0.85 + R() * 0.3;
              both(function (c, col) { c.fillStyle = col ? mod(tone[0] * l3, tone[1] * l3, tone[2] * l3) : '#fff';
                c.beginPath(); c.ellipse(lx3, ly3, S * 0.010, S * 0.019, a3, 0, Math.PI * 2); c.fill(); });
            }
          }
        }
      }
    }
    if (spec.needle === 'spray') {           // the spruce: a branchlet thick with short needles, the tips new and light
      for (var sn = 0; sn < stems.length; sn++) {
        var s4 = stems[sn], L4 = Math.hypot(s4.x1 - s4.x0, s4.y1 - s4.y0), a4 = Math.atan2(s4.x1 - s4.x0, -(s4.y1 - s4.y0));
        for (var d4 = 0; d4 < L4; d4 += S * 0.012) {
          var f4 = d4 / L4, x4 = s4.x0 + (s4.x1 - s4.x0) * f4, y4 = s4.y0 + (s4.y1 - s4.y0) * f4;
          for (var sd4 = -1; sd4 <= 1; sd4 += 2) {
            var na = a4 + sd4 * (0.8 + R() * 0.5), nl = S * (0.05 + R() * 0.025) * (1 - f4 * 0.3), lt = 0.8 + 0.5 * f4 + R() * 0.15;
            both(function (c, col) { c.strokeStyle = col ? mod(tone[0] * lt, tone[1] * lt * 1.02, tone[2] * lt) : '#fff'; c.lineWidth = S * 0.0075;
              c.beginPath(); c.moveTo(x4, y4); c.lineTo(x4 + Math.sin(na) * nl, y4 - Math.cos(na) * nl); c.stroke(); });
          }
        }
      }
    }
    if (spec.needle === 'tuft') {            // the pines: bundles of long needles radiating from the shoot tips
      for (var st5 = 0; st5 < stems.length; st5++) {
        var s5 = stems[st5];
        for (var b5 = 0; b5 < (spec.dense ? 3 : 2); b5++) {
          var f5 = b5 === 0 ? 1.0 : 0.55 + R() * 0.25, x5 = s5.x0 + (s5.x1 - s5.x0) * f5, y5 = s5.y0 + (s5.y1 - s5.y0) * f5;
          var a5 = Math.atan2(s5.x1 - s5.x0, -(s5.y1 - s5.y0));
          for (var n5 = 0; n5 < (spec.dense ? 70 : 55); n5++) {
            var aa = a5 + (R() - 0.5) * 2.6, ll = S * (0.12 + R() * 0.10), l5 = 0.75 + R() * 0.45;
            both(function (c, col) { c.strokeStyle = col ? mod(tone[0] * l5, tone[1] * l5, tone[2] * l5) : '#fff'; c.lineWidth = S * 0.007;
              c.beginPath(); c.moveTo(x5, y5); c.lineTo(x5 + Math.sin(aa) * ll, y5 - Math.cos(aa) * ll); c.stroke(); });
          }
        }
      }
    }
    if (spec.needle === 'scale') {           // the cypress: dense flattened fans of scale leaves
      for (var st6 = 0; st6 < stems.length; st6++) {
        var s6 = stems[st6];
        for (var k6 = 0; k6 < 46; k6++) {
          var f6 = 0.15 + 0.85 * R(), x6 = s6.x0 + (s6.x1 - s6.x0) * f6 + (R() - 0.5) * S * 0.12, y6 = s6.y0 + (s6.y1 - s6.y0) * f6 + (R() - 0.5) * S * 0.05;
          var l6 = 0.78 + R() * 0.35;
          both(function (c, col) { c.fillStyle = col ? mod(tone[0] * l6, tone[1] * l6, tone[2] * l6) : '#fff';
            c.beginPath(); c.ellipse(x6, y6, S * 0.028, S * 0.05, (R() - 0.5) * 0.8, 0, Math.PI * 2); c.fill(); });
        }
      }
    }
    if (spec.frond) {                        // a palm: a slice of a frond — the rachis up the middle, leaflets either side
      var coco = spec.frond === 'coco';
      cc.fillStyle = mod(0.72, 0.72, 0.72); cc.fillRect(x0, y0, S, S);
      ca.fillStyle = '#000'; ca.fillRect(x0, y0, S, S);
      both(function (c, col) { c.strokeStyle = col ? mod(1.15, 1.05, 0.65) : '#fff'; c.lineWidth = S * 0.022;
        c.beginPath(); c.moveTo(x0 + S * 0.5, y0 + S); c.lineTo(x0 + S * 0.5, y0); c.stroke(); });
      for (var k7 = 0; k7 < 26; k7++) {
        var y7 = y0 + S * (1 - (k7 + 0.5) / 26);
        for (var sd7 = -1; sd7 <= 1; sd7 += 2) {
          var lf7 = { x: x0 + S * 0.5, y: y7, a: sd7 * ((coco ? 105 : 62) + (R() - 0.5) * 16) * Math.PI / 180,
            L: S * (coco ? 0.50 : 0.46) * (0.85 + R() * 0.2), l: 0.85 + R() * 0.3, h: R() - 0.5 };
          leafPath(cc, lf7, LEAF.lance, coco ? 1.0 : 0.75); cc.fillStyle = mod(tone[0] * lf7.l, tone[1] * lf7.l, tone[2] * lf7.l); cc.fill();
          leafPath(ca, lf7, LEAF.lance, coco ? 1.0 : 0.75); ca.fillStyle = '#fff'; ca.fill();
        }
      }
    }
    if (spec.twigs) {                        // WINTER: the bare spray — twigs forking off the stems, finer and finer
      var twigC = mod(1.0, 1.0, 1.0);
      var fork = function (x, y, a, L, w, d) {
        var x2 = x + Math.sin(a) * L, y2 = y - Math.cos(a) * L;
        both(function (c, col) { c.strokeStyle = col ? twigC : '#fff'; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke(); });
        if (d <= 0 || L < S * 0.03) return;
        var k = 2 + (R() < 0.4 ? 1 : 0);
        for (var q = 0; q < k; q++) fork(x2, y2, a + (q - (k - 1) / 2) * (0.5 + R() * 0.35), L * (0.55 + R() * 0.2), Math.max(1, w * 0.68), d - 1);
      };
      for (var st9 = 0; st9 < stems.length; st9++) { var s9 = stems[st9]; fork(s9.x1, s9.y1, Math.atan2(s9.x1 - s9.x0, -(s9.y1 - s9.y0)), S * 0.13, S * 0.009, 4); }
    }
    if (spec.fruit) {                        // a few apples on the orchard's sprays
      for (var k8 = 0; k8 < spec.fruit; k8++) {
        var x8 = x0 + S * (0.25 + R() * 0.5), y8 = y0 + S * (0.3 + R() * 0.5), r8 = S * (0.022 + R() * 0.01), rd = R();
        both(function (c, col) { c.fillStyle = col ? mod(1.9, 0.6 + rd * 0.8, 0.45) : '#fff'; c.beginPath(); c.arc(x8, y8, r8, 0, Math.PI * 2); c.fill(); });
      }
    }
  }

  /** The atlas as an RGBA texture: colour from one canvas, alpha from another (a 2D canvas keeps no colour under
   *  alpha 0, and the mips need it), joined in a typed array. Mipmapped, linear, no premultiply. */
  T.atlas = function () {
    if (T._atlas) return T._atlas;
    var W = AT.cols * AT.cell, H = AT.rows * AT.cell;
    var mk = function () { var c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    var cC = mk(), cA = mk();
    var cc = cC.getContext('2d', { willReadFrequently: true }), ca = cA.getContext('2d', { willReadFrequently: true });
    cc.fillStyle = mod(0.7, 0.7, 0.7); cc.fillRect(0, 0, W, H);
    ca.fillStyle = '#000'; ca.fillRect(0, 0, W, H);
    var names = Object.keys(T.CELL);
    for (var i = 0; i < names.length; i++) {
      var k = T.CELL[names[i]], x0 = (k % AT.cols) * AT.cell, y0 = Math.floor(k / AT.cols) * AT.cell;
      cc.save(); ca.save();
      cc.beginPath(); cc.rect(x0, y0, AT.cell, AT.cell); cc.clip();
      ca.beginPath(); ca.rect(x0, y0, AT.cell, AT.cell); ca.clip();
      drawSpray(cc, ca, x0, y0, AT.cell, SPRAY[names[i]] || SPRAY.oak, mulberry(9100 + k * 31));
      cc.restore(); ca.restore();
    }
    var dc = cc.getImageData(0, 0, W, H).data, da = ca.getImageData(0, 0, W, H).data;
    var px = new Uint8Array(W * H * 4);
    for (var p = 0; p < W * H; p++) { px[p * 4] = dc[p * 4]; px[p * 4 + 1] = dc[p * 4 + 1]; px[p * 4 + 2] = dc[p * 4 + 2]; px[p * 4 + 3] = da[p * 4]; }
    var tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4; tex.flipY = false; tex.needsUpdate = true;
    T._atlasCanvas = cC; T._atlasAlpha = cA;
    return (T._atlas = tex);
  };

  // ============================================================================================================
  // 2. MESHES FROM THE PACK
  // ============================================================================================================
  function u8(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function unpackCards(c, lo, sp) {
    if (!c || !c.n) return { n: 0 };
    var C = new Int16Array(u8(c.c).buffer), NU = new Int8Array(u8(c.nu).buffer), S = u8(c.s), K = u8(c.k), n = c.n;
    var P = new Float32Array(n * 3);
    for (var i = 0; i < n * 3; i++) P[i] = lo[i % 3] + (C[i] + 32767) / 65534 * sp[i % 3];
    return { n: n, P: P, NU: NU, S: S, K: K };
  }
  T.unpack = function (e) {
    if (e._u) return e._u;
    var lo = e.lo, hi = e.hi, sp = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    var Q = new Int16Array(u8(e.p).buffer), n = e.n, P = new Float32Array(n * 3);
    for (var i = 0; i < n * 3; i++) P[i] = lo[i % 3] + (Q[i] + 32767) / 65534 * sp[i % 3];
    var Rr = new Uint16Array(u8(e.r).buffer), R = new Float32Array(n);
    for (var j = 0; j < n; j++) R[j] = Rr[j] / 10000;
    return (e._u = { P: P, R: R, A: u8(e.a), B: new Uint16Array(u8(e.b).buffer), nb: e.nb,
      c0: unpackCards(e.c0, lo, sp), c1: unpackCards(e.c1, lo, sp) });
  };
  T.pack = function () { return root.TREE120_PACK || null; };
  T.has = function (sp) { var P = T.pack(); return !!(P && P.species && P.species[sp] && P.species[sp].length); };

  /** LOD settings: the tube sides by level, which levels a LOD keeps, its card set. */
  var SIDES = [[10, 6, 4, 3], [6, 4, 3, 3]];

  /** One variant's geometry at `lod` (0 the whole tree, 1 reduced), in metres, cached. userData.t120 says what it
   *  is (and its `owner`: r128's BufferGeometry.clone shares userData, so a clone is not the owner). */
  T.geometry = function (spName, vi, lod) {
    var key = spName + ':' + vi + ':' + lod, G = T._geos || (T._geos = {});
    if (G[key]) return G[key];
    var P = T.pack(), list = P && P.species[spName];
    if (!list || !list.length) return null;
    var e = list[vi % list.length], U = T.unpack(e);
    var top = e.top, crx = e.crx || 1, cry = e.cry || 1, cyc = e.cy || top * 0.6;
    var pos = [], nor = [], col = [], hed = [], rim = [], uv = [], wnd = [], idx = [];
    var bark = e.bark, barkTop = e.barkTop || bark, style = T.BARK[spName] || 0;
    var palm = !!e.palm;
    var sway = function (y) { var t = Math.max(0, Math.min(1, y / top)); return Math.pow(t, 1.4); };
    var V = function (p, n, c, k, r, u, w) {
      pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); col.push(c[0], c[1], c[2]); hed.push(k[0], k[1], k[2]);
      rim.push(r[0], r[1], r[2]); uv.push(u[0], u[1]); wnd.push(w[0], w[1]);
      return pos.length / 3 - 1;
    };
    var norm = function (v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
    var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    // ---- bark: a tube along every branch, its frame carried down the branch (no twist) -----------------------
    var B = U.B, sides = SIDES[lod];
    for (var bi = 0; bi < U.nb; bi++) {
      var s0 = B[bi * 4], cnt = B[bi * 4 + 1], lvl = B[bi * 4 + 2], limb = B[bi * 4 + 3];
      if (lod === 1 && lvl >= 3) continue;
      if (lod === 1 && lvl === 2 && U.R[s0] < 0.035) continue;
      var S = sides[Math.min(3, lvl)], ph = (limb * 0.618034) % 1;
      var pts = [], rads = [], aos = [];
      for (var k = 0; k < cnt; k++) {
        // LOD1: every other node of a limb or branch (the ends kept): half the rings
        if (lod === 1 && lvl > 0 && k > 0 && k < cnt - 1 && k % 2) continue;
        var q = s0 + k; pts.push([U.P[q * 3], U.P[q * 3 + 1], U.P[q * 3 + 2]]); rads.push(U.R[q]); aos.push(U.A[q] / 255);
      }
      if (lvl === 0 && !palm) {
        // the root flare: rings in the first metre, swelling into buttresses at the ground
        var p0 = pts[0], p1 = pts[1], extra = [];
        for (var f = 1; f <= 3; f++) { var tt = [0.06, 0.18, 0.42][f - 1] / Math.max(0.3, p1[1] - p0[1]); tt = Math.min(0.9, tt);
          extra.push([p0[0] + (p1[0] - p0[0]) * tt, p0[1] + (p1[1] - p0[1]) * tt, p0[2] + (p1[2] - p0[2]) * tt]); }
        pts.splice(1, 0, extra[0], extra[1], extra[2]);
        rads.splice(1, 0, rads[0], rads[0], rads[0]); aos.splice(1, 0, aos[0], aos[0], aos[0]);
      }
      var tPrev = null, uP = null;
      var ring0 = pos.length / 3;
      for (var k2 = 0; k2 < pts.length; k2++) {
        var a = pts[Math.max(0, k2 - 1)], b = pts[Math.min(pts.length - 1, k2 + 1)];
        var tv = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        if (!uP) { var ref = Math.abs(tv[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0]; uP = norm(cross(tv, ref)); }
        else { uP = norm([uP[0] - tv[0] * dot(uP, tv), uP[1] - tv[1] * dot(uP, tv), uP[2] - tv[2] * dot(uP, tv)]); }
        var vP = cross(tv, uP);
        var r = rads[k2], ao = aos[k2], y = pts[k2][1];
        var flare = 1;
        if (lvl === 0 && !palm) flare = k2 === 0 ? 1.55 : k2 === 1 ? 1.32 : k2 === 2 ? 1.14 : k2 === 3 ? 1.04 : 1;
        var tb = Math.max(0, Math.min(1, (y / top - 0.40) / 0.25));
        var bc = [bark[0] + (barkTop[0] - bark[0]) * tb, bark[1] + (barkTop[1] - bark[1]) * tb, bark[2] + (barkTop[2] - bark[2]) * tb];
        for (var j = 0; j < S; j++) {
          var th = j / S * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          var nn = [uP[0] * cs + vP[0] * sn, uP[1] * cs + vP[1] * sn, uP[2] * cs + vP[2] * sn];
          var rr = r * (flare > 1 ? flare + (flare - 1) * 0.55 * Math.sin(th * 5 + limb) : 1);
          var p = [pts[k2][0] + nn[0] * rr, pts[k2][1] + nn[1] * rr, pts[k2][2] + nn[2] * rr];
          // the light that reaches the bark: under the crown and at the foot it is shade; moss on the north side, low
          var shade = (0.50 + 0.50 * ao) * (0.72 + 0.28 * Math.min(1, y / 1.0));
          var m = Math.max(0, 1 - y / 1.6) * Math.max(0, Math.min(1, -nn[2] * 0.8 + 0.3)) * (style === 1 ? 0.25 : 0.6);
          var c = [(bc[0] * (1 - m) + 0.20 * m) * shade, (bc[1] * (1 - m) + 0.24 * m) * shade, (bc[2] * (1 - m) + 0.13 * m) * shade];
          V(p, nn, c, [3, sway(p[1]) * (lvl ? 1 : 0.7), style], nn, [0, 0], [ph, 0]);
        }
        tPrev = tv;
      }
      for (var k3 = 0; k3 < pts.length - 1; k3++) for (var j2 = 0; j2 < S; j2++) {
        var a0 = ring0 + k3 * S + j2, a1 = ring0 + k3 * S + (j2 + 1) % S, b0 = a0 + S, b1 = a1 + S;
        idx.push(a0, a1, b1, a0, b1, b0);
      }
      // a thick cut end is capped (a broken palm stem, a pollard's knuckle)
      if (rads[rads.length - 1] > 0.05) {
        var last = ring0 + (pts.length - 1) * S, tip = pts[pts.length - 1], tn = tPrev || [0, 1, 0];
        var ci = V(tip, tn, [bark[0] * 0.8, bark[1] * 0.8, bark[2] * 0.8], [3, sway(tip[1]), style], tn, [0, 0], [ph, 0]);
        for (var j3 = 0; j3 < S; j3++) idx.push(last + j3, last + (j3 + 1) % S, ci);
      }
    }
    // ---- leaf cards -------------------------------------------------------------------------------------------
    var CD = lod ? U.c1 : U.c0, green = e.green, Rn = mulberry(4400 + vi * 17 + spName.length * 131);
    for (var ci2 = 0; ci2 < CD.n; ci2++) {
      var c3 = [CD.P[ci2 * 3], CD.P[ci2 * 3 + 1], CD.P[ci2 * 3 + 2]];
      var n3 = norm([CD.NU[ci2 * 6] / 127, CD.NU[ci2 * 6 + 1] / 127, CD.NU[ci2 * 6 + 2] / 127]);
      var u3 = norm([CD.NU[ci2 * 6 + 3] / 127, CD.NU[ci2 * 6 + 4] / 127, CD.NU[ci2 * 6 + 5] / 127]);
      var sz = CD.S[ci2] * 0.04, cell = CD.K[ci2 * 4], ao2 = CD.K[ci2 * 4 + 1] / 255, limb2 = CD.K[ci2 * 4 + 2];
      var rt = norm(cross(u3, n3));
      var gk = green[Math.floor(Rn() * green.length)], jit = 0.9 + Rn() * 0.2;
      var lit = (0.60 + 0.40 * Math.pow(ao2, 0.8)) * jit;
      var colr = [gk[0] * lit, gk[1] * lit, gk[2] * lit];
      var flip = Rn() < 0.5;
      var ph2 = (limb2 * 0.618034) % 1;
      var hw = sz * 0.5, base = pos.length / 3;
      var corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
      for (var q4 = 0; q4 < 4; q4++) {
        var cr = corners[q4];
        var pp = [c3[0] + rt[0] * cr[0] * hw + u3[0] * cr[1] * hw, c3[1] + rt[1] * cr[0] * hw + u3[1] * cr[1] * hw, c3[2] + rt[2] * cr[0] * hw + u3[2] * cr[1] * hw];
        // the light's normal: bent out from the crown's heart, so the crown shades as one volume
        var e3 = [pp[0] / crx, (pp[1] - cyc) / cry + 0.15, pp[2] / crx];
        var nb = palm ? norm([n3[0] * 0.6, n3[1] * 0.6 + 0.4, n3[2] * 0.6]) : norm([n3[0] * 0.3 + norm(e3)[0] * 0.7, n3[1] * 0.3 + norm(e3)[1] * 0.7, n3[2] * 0.3 + norm(e3)[2] * 0.7]);
        V(pp, nb, colr, [5, Math.max(0.05, sway(pp[1])), cell], n3, [flip ? 1 - cr[2] : cr[2], cr[3]], [ph2, cr[3] ? 1 : 0.3]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('hedge', new THREE.Float32BufferAttribute(hed, 3));
    g.setAttribute('hedgeRim', new THREE.Float32BufferAttribute(rim, 3));
    g.setAttribute('t120uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('t120w', new THREE.Float32BufferAttribute(wnd, 2));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    // the radial extent, for the impostor's frame
    var rxz = 0; for (var pi = 0; pi < pos.length; pi += 3) rxz = Math.max(rxz, Math.hypot(pos[pi], pos[pi + 2]));
    g.userData.t120 = { owner: g, sp: spName, vi: vi % list.length, lod: lod, top: top, rxz: rxz, key: spName + ':' + (vi % list.length),
      tris: idx.length / 3, ever: !!T.EVERGREEN[spName] };
    return (G[key] = g);
  };

  // ============================================================================================================
  // 3. THE MATERIAL — bark and cards on the game's Lambert, the wind, the LOD dither
  // ============================================================================================================
  var NOISE = [
    'float cnHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    'float cnNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(cnHash(i), cnHash(i + vec3(1.0,0.0,0.0)), f.x), mix(cnHash(i + vec3(0.0,1.0,0.0)), cnHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
    '             mix(mix(cnHash(i + vec3(0.0,0.0,1.0)), cnHash(i + vec3(1.0,0.0,1.0)), f.x), mix(cnHash(i + vec3(0.0,1.0,1.0)), cnHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z); }',
  ].join('\n');
  var CLOUD = [
    'float t120CH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float t120CN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(t120CH(i), t120CH(i + vec2(1.0, 0.0)), f.x), mix(t120CH(i + vec2(0.0, 1.0)), t120CH(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float t120Cloud(vec3 w) { if (uCloud.w <= 0.001) return 1.0; vec2 p = w.xz * uCloud.z + uCloud.xy;',
    '  float n = t120CN(p) * 0.62 + t120CN(p * 2.17 + 11.3) * 0.38; return 1.0 - uCloud.w * smoothstep(uCloudBand.x, uCloudBand.y, n); }',
  ].join('\n');
  // shared, live: the wind's own weights (trunk bend, limb, leaf flutter, flutter rate), the eye, the sun
  T.U = {
    uT120Wind: { value: new THREE.Vector4(0.05, 0.035, 0.55, 6.5) },
    uT120Eye: { value: new THREE.Vector3() },
    uT120Sun: { value: new THREE.Vector4(0, -1, 0, 0.45) },
    uT120SunC: { value: new THREE.Color(1, 1, 1) },
    uT120Bake: { value: 0 },
    uT120Atlas: { value: null },
    uT120AtlasN: { value: new THREE.Vector4(AT.cols, AT.rows, AT.cell, 0) },
  };
  var VHEAD = [
    'attribute vec3 hedge;', 'attribute vec3 hedgeRim;', 'attribute vec2 t120uv;', 'attribute vec2 t120w;',
    '#ifdef USE_INSTANCING', 'attribute float t120f;', '#endif',
    'uniform float uTime;', 'uniform vec4 uWind;', 'uniform vec4 uT120Wind;', 'uniform float uT120Bake;',
    'varying vec4 vT120K;', 'varying vec2 vT120Uv;', 'varying vec3 vT120W;', 'varying vec3 vT120ON;', 'varying float vT120F;', 'varying float vT120PH;',
  ].join('\n');
  // THE WIND, the same in the colour pass and the shadow pass: the tree bends from the root in the gust that runs
  // along the field (the props' own `PROP_WIND`), each limb on its own phase, the cards flutter about their stems.
  // World amplitudes scale with the tree; a felled tree (`_stillGeo`: hedge.y 0) is still.
  var WIND = [
    'vec3 transformed = vec3(position);',
    '#ifdef USE_INSTANCING',
    '  mat4 tM = modelMatrix * instanceMatrix;',
    '  vT120F = t120f;',
    '#else',
    '  mat4 tM = modelMatrix;',
    '  vT120F = 0.0;',
    '#endif',
    'vec3 tO = tM[3].xyz;',
    'float tS = length(tM[1].xyz);',
    'vT120PH = fract(sin(dot(floor(tO.xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453);',
    'if (uT120Bake < 0.5 && hedge.y > 0.0) {',
    '  float tPh = dot(tO.xz, vec2(0.19, 0.23));',
    '  float tG = sin(uTime * uWind.w + tPh) + 0.42 * sin(uTime * uWind.w * 2.3 + tPh * 1.7);',
    '  float tH = max(position.y, 0.0) * tS;',
    '  float tTr = uWind.z * tG * hedge.y * tH * uT120Wind.x;',
    '  float tLi = uWind.z * sin(uTime * uWind.w * 1.9 + t120w.x * 6.2832 + tPh) * hedge.y * tH * uT120Wind.y;',
    '  vec3 tDW = vec3(uWind.x * (tTr + tLi), tLi * 0.3, uWind.y * (tTr + tLi));',
    '  transformed += inverse(mat3(tM)) * tDW;',
    '  if (hedge.x > 4.5) transformed += hedgeRim * (uWind.z * sin(uTime * uT120Wind.w + t120w.x * 17.0 + dot(position, vec3(3.1, 2.3, 4.7))) * t120w.y * uT120Wind.z);',
    '}',
  ].join('\n');

  /** The colour material for broadleaf (`ever` false: bare in the snow) or evergreen trees. `opts.wind` is the
   *  game's PROP_WIND. Built once each; LOD bands share it (their fade is in the instance attribute). */
  T.material = function (opts) {
    opts = opts || {};
    var ever = !!opts.ever, W = opts.wind || { uTime: { value: 0 }, uWind: { value: new THREE.Vector4(1, 0, 0.1, 1) } };
    var C = root.Canopy || {};
    var mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    T.U.uT120Atlas.value = T.atlas();
    var U = T.U;
    mat.onBeforeCompile = function (sh) {
      var ok = true;
      var rep = function (src, a, b) { if (src.indexOf(a) < 0) { ok = false; return src; } return src.replace(a, b); };
      sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind;
      for (var k in U) sh.uniforms[k] = U[k];
      sh.uniforms.uHgSnow = C.snow || { value: 0 }; sh.uniforms.uHgNear = C.near || { value: 0 };
      sh.uniforms.uHgNearSky = C.nearSky || { value: [3.6, 5, 12, 36] }; sh.uniforms.uHgNearSun = C.nearSun || { value: 1 };
      sh.uniforms.uHgNearCap = C.nearCap || { value: 0.35 }; sh.uniforms.uHgBark = C.nearBark || { value: new THREE.Vector4() };
      sh.uniforms.uT120Dec = { value: ever ? 0 : 1 };
      sh.vertexShader = rep(sh.vertexShader, '#include <common>', '#include <common>\n' + VHEAD);
      sh.vertexShader = rep(sh.vertexShader, '#include <begin_vertex>', WIND);
      sh.vertexShader = rep(sh.vertexShader, '#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvT120K = vec4(hedge, objectNormal.y);\nvT120Uv = t120uv;\nvT120ON = objectNormal;');
      sh.vertexShader = rep(sh.vertexShader, '#include <project_vertex>', '#include <project_vertex>\nvT120W = (tM * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = rep(sh.fragmentShader, '#include <common>', '#include <common>\n' + [
        'uniform sampler2D uT120Atlas;', 'uniform vec4 uT120AtlasN;', 'uniform float uT120Bake;', 'uniform vec3 uT120Eye;',
        'uniform vec4 uT120Sun;', 'uniform vec3 uT120SunC;', 'uniform float uT120Dec;',
        'uniform float uHgSnow;', 'uniform float uHgNear;', 'uniform vec4 uHgNearSky;', 'uniform float uHgNearSun;', 'uniform float uHgNearCap;', 'uniform vec4 uHgBark;',
        'varying vec4 vT120K;', 'varying vec2 vT120Uv;', 'varying vec3 vT120W;', 'varying vec3 vT120ON;', 'varying float vT120F;', 'varying float vT120PH;',
        NOISE].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        // the LOD cross-fade: one screen dither, the near band keeps what the far band leaves
        'float tDi = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
        'if (vT120F > 1.5) { if (tDi >= vT120F - 2.0) discard; } else if (tDi < vT120F) discard;',
        'vec4 tA = vec4(1.0);',
        'float tBare = 0.0;',
        'float tD = length(vT120W - uT120Eye);',
        'if (vT120K.x > 4.5) {',
        '  vec2 tUv = clamp(vT120Uv, 0.004, 0.996);',
        '  float tCi = vT120K.z;',
        // WINTER (a deciduous tree, the snow in): the card is a spray of bare twigs, a lace that still reads as a
        // crown from the playing camera; one in five keeps its leaves — dead ones on an oak or a beech, ivy
        '  if (uT120Dec > 0.5 && uHgSnow > 0.0) {',
        '    tBare = smoothstep(0.12, 0.40, uHgSnow);',
        '    if (tBare > 0.5 && cnNoise(vT120W * 2.3 + 17.0) < 0.80) tCi = ' + T.TWIG_CELL + '.0; else tBare = tBare > 0.5 ? 0.6 : 0.0;',
        '  }',
        '  vec2 tCell = vec2(mod(tCi, uT120AtlasN.x), floor(tCi / uT120AtlasN.x + 0.001));',
        '  tA = texture2D(uT120Atlas, (tCell + vec2(tUv.x, 1.0 - tUv.y)) / uT120AtlasN.xy);',
        // the cut keeps its coverage down the mips: a crown does not thin to nothing at range
        '  vec2 tdx = dFdx(tUv * uT120AtlasN.z), tdy = dFdy(tUv * uT120AtlasN.z);',
        '  float tMip = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));',
        '  if (tA.a * (1.0 + tMip * (tCi > 18.5 ? 0.45 : 0.28)) < 0.5) discard;',
        '}',
      ].join('\n'));
      sh.fragmentShader = rep(sh.fragmentShader, '#include <color_fragment>', [
        '#include <color_fragment>',
        'float tN = cnNoise(vT120W * 5.0);',
        'if (vT120K.x > 4.5) {',
        '  diffuseColor.rgb *= tA.rgb * 2.0;',
        '  if (tBare > 0.5) diffuseColor.rgb = tBare > 0.75 ? vec3(0.20, 0.175, 0.15) * (0.75 + 0.5 * tN) : mix(diffuseColor.rgb, vec3(0.30, 0.17, 0.08) * (0.6 + tA.g), 0.8);',
        // the crown's own light: the top warm and full, the underside cool (the old canopy's `topWarm`/`under`)
        '  diffuseColor.rgb *= mix(vec3(0.84, 0.90, 0.98), vec3(1.12, 1.08, 0.90), clamp(vT120K.w * 0.6 + 0.5, 0.0, 1.0));',
        '} else if (vT120K.x > 2.5) {',
        // bark: plates and fissures up the trunk (the canopy's), birch's dark lenticels across a white bole, a
        // palm's rings
        '  float tFine = 1.0 - smoothstep(16.0, 44.0, tD);',
        '  float tG1 = cnNoise(vec3(vT120W.x * 27.0, vT120W.y * 5.0, vT120W.z * 27.0));',
        '  float tG2 = cnNoise(vec3(vT120W.x * 70.0, vT120W.y * 9.0, vT120W.z * 70.0) + 11.3);',
        '  if (vT120K.z > 2.5) { diffuseColor.rgb *= 0.92 + 0.16 * tG1; }',
        '  else if (vT120K.z > 1.5) { float tR = fract(vT120W.y * 9.0 + tG1 * 0.4); diffuseColor.rgb *= 0.78 + 0.30 * smoothstep(0.1, 0.5, tR) - 0.18 * smoothstep(0.85, 1.0, tR); }',
        '  else if (vT120K.z > 0.5) { float tL = smoothstep(0.60, 0.70, cnNoise(vec3(vT120W.x * 16.0, vT120W.y * 95.0, vT120W.z * 16.0)));',
        '    diffuseColor.rgb *= (1.0 - 0.70 * tL * tFine) * (1.0 - 0.55 * smoothstep(0.66, 0.80, tG1)); }',
        '  else { diffuseColor.rgb *= (1.0 + (tG1 - 0.5) * 0.55) * (1.0 - smoothstep(0.46, 0.74, tG2) * 0.5 * tFine); }',
        '}',
        // a tree's own green, from where it stands (not baked: the impostor adds the same per instance)
        'if (uT120Bake < 0.5) {',
        '  vec3 tTi = mix(vec3(0.805, 0.9025, 0.766), vec3(1.156, 1.078, 0.9415), vT120PH);',
        '  diffuseColor.rgb *= vT120K.x > 4.5 ? tTi : mix(vec3(1.0), tTi, 0.35);',
        '}',
        // snow on what faces the sky — the tops of the crown, the upper side of a limb
        'if (uHgSnow > 0.0) {',
        '  float tSn = smoothstep(0.50, 0.86, vT120K.w + (tN - 0.5) * 0.75) * uHgSnow * 0.9;',
        '  if (vT120K.x > 4.5) tSn *= (uT120Dec > 0.5 ? 0.5 : 0.95) * smoothstep(0.2, 0.6, tA.a);',
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.82, 0.86), tSn);',
        '}',
        // the impostor bake: the albedo (sqrt, for the 8-bit target) or the bent normal, nothing lit
        'if (uT120Bake > 0.5) { gl_FragColor = uT120Bake < 1.5 ? vec4(sqrt(max(diffuseColor.rgb, vec3(0.0))), 1.0) : vec4(normalize(vT120ON) * 0.5 + 0.5, 1.0); return; }',
      ].join('\n'));
      // a card is lit by its crown's normal whichever face is toward the eye
      sh.fragmentShader = sh.fragmentShader.split('( gl_FrontFacing ) ? vIndirectFront : vIndirectBack').join('( gl_FrontFacing || vT120K.x > 4.5 ) ? vIndirectFront : vIndirectBack');
      sh.fragmentShader = sh.fragmentShader.split('( gl_FrontFacing ) ? vLightFront : vLightBack').join('( gl_FrontFacing || vT120K.x > 4.5 ) ? vLightFront : vLightBack');
      var DL = 'reflectedLight.directDiffuse *= BRDF_Diffuse_Lambert( diffuseColor.rgb ) * getShadowMask();';
      if (sh.fragmentShader.indexOf(DL) >= 0) {
        sh.fragmentShader = sh.fragmentShader.replace(DL, DL + [
          '',
          // LIGHT THROUGH THE LEAVES: looking toward the sun through a crown, the leaves glow
          'if (vT120K.x > 4.5) {',
          '  vec3 tV = normalize(vT120W - uT120Eye);',
          '  float tT = pow(max(dot(tV, uT120Sun.xyz), 0.0), 4.0) * uT120Sun.w;',
          '  reflectedLight.directDiffuse += diffuseColor.rgb * uT120SunC * tT * getShadowMask();',
          '}',
          // (round 118, `C.near`) the sky a face in shade lost with its fill, given back near the eye
          'if (uHgNear > 0.0) {',
          '  vec3 tLw = vec3(0.2126, 0.7152, 0.0722);',
          '  float tSunR = dot(reflectedLight.directDiffuse, tLw) / max(dot(diffuseColor.rgb * RECIPROCAL_PI, tLw) * PI * uHgNearSun, 1e-5);',
          '  float tShd = 1.0 - smoothstep(0.06, 0.30, tSunR);',
          '  float tNr = 1.0 - smoothstep(uHgNearSky.z, uHgNearSky.w, tD);',
          '  float tSk = vT120K.x > 4.5 ? mix(uHgNearSky.x, uHgNearSky.y, 0.4) : uHgNearSky.x;',
          '  float tInE = dot(reflectedLight.indirectDiffuse, tLw) / max(dot(diffuseColor.rgb, tLw), 1e-5);',
          '  float tMul = 1.0 + (tSk - 1.0) * tShd * tNr * uHgNear;',
          '  reflectedLight.indirectDiffuse *= min(tMul, max(1.0, uHgNearCap * uHgNearSun / max(tInE, 1e-5)));',
          '}',
        ].join('\n'));
      }
      if (opts.cloud) {
        // THE CLOUD DECK (round 106's, on the tree's own world position: the game's per-material hook reads the
        // position before the instance matrix, so a batched prop took the shade of the map's centre)
        sh.uniforms.uCloud = opts.cloud.uCloud; sh.uniforms.uCloudBand = opts.cloud.uCloudBand;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uCloud;\nuniform vec2 uCloudBand;\n' + CLOUD)
          .replace('#include <tonemapping_fragment>', 'if (uT120Bake < 0.5) gl_FragColor.rgb *= t120Cloud(vT120W);\n#include <tonemapping_fragment>');
      }
      if (!ok) T.failed = (T.failed || 0) + 1;
    };
    mat.customProgramCacheKey = function () { return 't120tree5|' + (ever ? 'E' : 'D') + (opts.cloud ? 'C' : ''); };
    mat._canopyShaded = true; mat._t120 = true;
    // the shadow: the same wind, the cards' own cut, the LOD's hard switch at the middle of its fade
    var dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    dm.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind;
      for (var k in U) sh.uniforms[k] = U[k];
      sh.uniforms.uHgSnow = C.snow || { value: 0 }; sh.uniforms.uT120Dec = { value: ever ? 0 : 1 };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VHEAD);
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', WIND + '\nvT120K = vec4(hedge, 0.0);\nvT120Uv = t120uv;\nvT120W = (tM * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + [
        'uniform sampler2D uT120Atlas;', 'uniform vec4 uT120AtlasN;', 'uniform float uHgSnow;', 'uniform float uT120Dec;',
        'varying vec4 vT120K;', 'varying vec2 vT120Uv;', 'varying vec3 vT120W;', 'varying float vT120F;', NOISE].join('\n'));
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', [
        '#include <clipping_planes_fragment>',
        'if (vT120F > 1.5) { if (vT120F - 2.0 < 0.5) discard; } else if (vT120F >= 0.5) discard;',
        'if (vT120K.x > 4.5) {',
        '  vec2 tUv = clamp(vT120Uv, 0.004, 0.996);',
        '  float tCi = vT120K.z;',
        '  if (uT120Dec > 0.5 && uHgSnow > 0.0 && smoothstep(0.12, 0.40, uHgSnow) > 0.5 && cnNoise(vT120W * 2.3 + 17.0) < 0.80) tCi = ' + T.TWIG_CELL + '.0;',
        '  vec2 tCell = vec2(mod(tCi, uT120AtlasN.x), floor(tCi / uT120AtlasN.x + 0.001));',
        '  if (texture2D(uT120Atlas, (tCell + vec2(tUv.x, 1.0 - tUv.y)) / uT120AtlasN.xy).a < 0.5) discard;',
        '}',
      ].join('\n'));
    };
    dm.customProgramCacheKey = function () { return 't120depth4|' + (ever ? 'E' : 'D'); };
    mat._canopyDepth = dm;
    mat.needsUpdate = true;
    return mat;
  };

  // ============================================================================================================
  // 4. IMPOSTORS — frames of each tree baked at load, one quad per tree past the middle distance
  // ============================================================================================================
  var IMP = T.Imp = { px: 96, rings: [6, 28, 52], naz: 8, slots: {}, info: [], n: 0, rtA: null, rtN: null, cols: 24, rowsCap: 0 };
  IMP.frames = function () { return IMP.rings.length * IMP.naz; };
  /** Make room for `need` variants; a bigger atlas starts empty (every slot is baked again). */
  IMP.ensure = function (need) {
    var F = IMP.frames(), rows = Math.ceil(need * F / IMP.cols);
    if (IMP.rtA && rows <= IMP.rowsCap) return false;
    rows = Math.max(rows, Math.ceil(rows * 1.25));
    var W = IMP.cols * IMP.px, H = rows * IMP.px;
    var mk = function () {
      var rt = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      return rt;
    };
    if (IMP.rtA) { IMP.rtA.dispose(); IMP.rtN.dispose(); }
    IMP.rtA = mk(); IMP.rtN = mk(); IMP.rowsCap = rows; IMP.slots = {}; IMP.info = []; IMP.n = 0;
    // a new atlas is a new shape: the material must be told its rows, or every impostor samples the wrong frames
    if (IMP.mat) { IMP.U.uImpA.value = IMP.rtA.texture; IMP.U.uImpN.value = IMP.rtN.texture; IMP.syncG(); }
    return true;
  };
  /** The half-size of a variant's frame (its world height and crown, from any ring) and its centre height. */
  IMP.frameOf = function (g) {
    var u = g.userData.t120, top = u.top, r = u.rxz * 1.02, hs = r;
    for (var i = 0; i < IMP.rings.length; i++) { var el = IMP.rings[i] * Math.PI / 180; hs = Math.max(hs, top / 2 * Math.cos(el) + r * Math.sin(el)); }
    return { hs: hs * 1.10, cy: top / 2 };
  };
  /** Bake the variants in `list` ([{key, geo (LOD0), mat}]) that have no slot yet. Returns the number baked. */
  IMP.bake = function (renderer, list) {
    var todo = list.filter(function (x) { return IMP.slots[x.key] == null; });
    if (!todo.length) return 0;
    if (IMP.ensure(IMP.n + todo.length)) todo = list.slice();
    var F = IMP.frames();
    var scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    var keep = { rt: renderer.getRenderTarget(), ac: renderer.autoClear, cc: renderer.getClearColor(new THREE.Color()), ca: renderer.getClearAlpha(),
      sm: renderer.shadowMap.enabled, sc: renderer.getScissorTest(), vp: new THREE.Vector4(), sr: new THREE.Vector4() };
    renderer.getViewport(keep.vp); renderer.getScissor(keep.sr);
    var mesh = null;
    try {
      renderer.autoClear = false; renderer.shadowMap.enabled = false;
      for (var t = 0; t < todo.length; t++) { var x = todo[t]; IMP.slots[x.key] = IMP.n; IMP.info[IMP.n] = IMP.frameOf(x.geo); IMP.n++; }
      for (var pass = 1; pass <= 2; pass++) {
        var rt = pass === 1 ? IMP.rtA : IMP.rtN;
        T.U.uT120Bake.value = pass;
        for (var t2 = 0; t2 < todo.length; t2++) {
          var y = todo[t2], slot = IMP.slots[y.key], inf = IMP.info[slot];
          if (mesh) scene.remove(mesh);
          mesh = new THREE.Mesh(y.geo, y.mat); mesh.frustumCulled = false; scene.add(mesh);
          cam.left = -inf.hs; cam.right = inf.hs; cam.top = inf.hs; cam.bottom = -inf.hs; cam.updateProjectionMatrix();
          for (var f = 0; f < F; f++) {
            var ring = Math.floor(f / IMP.naz), az = (f % IMP.naz) / IMP.naz * Math.PI * 2, el = IMP.rings[ring] * Math.PI / 180;
            cam.position.set(Math.sin(az) * Math.cos(el) * 150, inf.cy + Math.sin(el) * 150, Math.cos(az) * Math.cos(el) * 150);
            cam.up.set(0, 1, 0); cam.lookAt(0, inf.cy, 0); cam.updateMatrixWorld();
            var cell = slot * F + f, cx = (cell % IMP.cols) * IMP.px, cy = Math.floor(cell / IMP.cols) * IMP.px;
            // THE TARGET'S OWN VIEWPORT: `renderer.setViewport` multiplies by the pixel ratio, which baked every
            // frame at twice its size over its neighbours'
            rt.viewport.set(cx, cy, IMP.px, IMP.px); rt.scissor.set(cx, cy, IMP.px, IMP.px); rt.scissorTest = true;
            renderer.setRenderTarget(rt);
            // what a mip blends toward: the tree's own dark green (albedo) or a normal facing the eye
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, true, false);
            renderer.render(scene, cam);
          }
        }
      }
    } finally {
      T.U.uT120Bake.value = 0;
      if (mesh) scene.remove(mesh);
      [IMP.rtA, IMP.rtN].forEach(function (rt) { if (!rt) return; rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height); rt.scissor.set(0, 0, rt.width, rt.height); });
      renderer.setScissorTest(keep.sc); renderer.setScissor(keep.sr); renderer.setViewport(keep.vp);
      renderer.setRenderTarget(keep.rt); renderer.autoClear = keep.ac; renderer.setClearColor(keep.cc, keep.ca); renderer.shadowMap.enabled = keep.sm;
    }
    // the mips, once: render nothing into each target with mips on
    [IMP.rtA, IMP.rtN].forEach(function (rt) {
      rt.texture.generateMipmaps = true;
      var s2 = new THREE.Scene(), c2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), k2 = renderer.getRenderTarget(), a2 = renderer.autoClear;
      renderer.autoClear = false; renderer.setRenderTarget(rt); renderer.render(s2, c2); renderer.setRenderTarget(k2); renderer.autoClear = a2;
      rt.texture.generateMipmaps = false;
    });
    if (IMP.U) IMP.syncVar();
    return todo.length;
  };
  IMP.syncVar = function () {
    var a = IMP.U.uImpVar.value;
    for (var i = 0; i < IMP.info.length && i < a.length; i++) a[i].set(IMP.info[i].hs, IMP.info[i].cy, 0, 0);
  };
  var IMPV = [
    'attribute float t120f;', 'attribute float t120v;',
    'uniform sampler2D uImpA;', 'uniform vec4 uImpG;', 'uniform vec4 uImpR;', 'uniform vec4 uImpVar[' + 96 + '];', 'uniform vec3 uT120Eye;', 'uniform vec4 uT120Sun;',
    'uniform float uTime;', 'uniform vec4 uWind;',
    'varying vec4 vImpFr;', 'varying vec2 vImpW;', 'varying vec2 vImpUv;', 'varying float vT120F;', 'varying vec2 vImpRot;', 'varying float vImpSlot;', 'varying float vT120PH;',
  ].join('\n');
  // the quad toward the eye (or the sun, in the shadow pass), and the four frames nearest the view, in the tree's frame
  function impVertex(eye) {
    return [
      'mat4 iM = modelMatrix * instanceMatrix;',
      'vec4 iV = uImpVar[int(t120v + 0.5)];',
      'float iS = length(iM[0].xyz);',
      'vec3 iC = (iM * vec4(0.0, iV.y, 0.0, 1.0)).xyz;',
      'vec3 iTo = ' + eye + ';',
      'vec3 iR = normalize(cross(vec3(0.0, 1.0, 0.0), iTo));',
      'vec3 iU = cross(iTo, iR);',
      // the wind: the top of the quad leans with the gust, as the crown does
      'float iPh = dot(iM[3].xz, vec2(0.19, 0.23));',
      'float iG = sin(uTime * uWind.w + iPh) + 0.42 * sin(uTime * uWind.w * 2.3 + iPh * 1.7);',
      'vec3 iWorld = iC + iR * position.x * iV.x * iS + iU * position.y * iV.x * iS;',
      'iWorld.xz += uWind.xy * uWind.z * iG * max(0.0, position.y + 0.3) * iV.y * iS * 0.035;',
      'vec3 transformed = iWorld;',
      'vec3 iL = normalize(inverse(mat3(iM)) * iTo);',
      'float iEl = degrees(asin(clamp(iL.y, -1.0, 1.0)));',
      'float iAz = atan(iL.x, iL.z) / 6.2831853 * uImpG.w;',
      'iAz = iAz < 0.0 ? iAz + uImpG.w : iAz;',
      'float iR0 = clamp((iEl - uImpR.x) / (uImpR.y - uImpR.x), 0.0, 1.0) + clamp((iEl - uImpR.y) / (uImpR.z - uImpR.y), 0.0, 1.0);',
      'float iRa = floor(min(iR0, 1.999));',
      'float iAa = floor(iAz);',
      'vImpFr = vec4(iRa, min(iRa + 1.0, 2.0), iAa, mod(iAa + 1.0, uImpG.w));',
      'vImpW = vec2(iR0 - iRa, iAz - iAa);',
      'vImpUv = position.xy * 0.5 + 0.5;',
      'vT120F = t120f;',
      'vImpSlot = t120v;',
      'vec3 iY = normalize(iM[2].xyz);',
      'vImpRot = vec2(iY.x, iY.z);',
      'vT120PH = fract(sin(dot(floor(iM[3].xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453);',
    ].join('\n');
  }
  var IMPF_HEAD = [
    'uniform sampler2D uImpA;', 'uniform sampler2D uImpN;', 'uniform vec4 uImpG;',
    'varying vec4 vImpFr;', 'varying vec2 vImpW;', 'varying vec2 vImpUv;', 'varying float vT120F;', 'varying vec2 vImpRot;', 'varying float vImpSlot;', 'varying float vT120PH;',
    'vec2 impCell(float ring, float az) { float c = vImpSlot * uImpG.z + ring * uImpG.w + az; return vec2(mod(c, uImpG.x), floor(c / uImpG.x + 0.001)); }',
    'vec2 impUv(vec2 cell) { return (cell + clamp(vImpUv, 0.01, 0.99)) / vec2(uImpG.x, uImpG.y); }',
  ].join('\n');
  IMP.material = function (wind, cloud) {
    if (IMP.mat) return IMP.mat;
    var W = wind || { uTime: { value: 0 }, uWind: { value: new THREE.Vector4(1, 0, 0.1, 1) } };
    var vars = []; for (var i = 0; i < 96; i++) vars.push(new THREE.Vector4(1, 1, 0, 0));
    IMP.U = { uImpA: { value: IMP.rtA ? IMP.rtA.texture : null }, uImpN: { value: IMP.rtN ? IMP.rtN.texture : null },
      uImpG: { value: new THREE.Vector4() }, uImpR: { value: new THREE.Vector4() }, uImpVar: { value: vars } };
    IMP.syncG = function () {
      var rows = IMP.rowsCap || 1;
      IMP.U.uImpG.value.set(IMP.cols, rows, IMP.frames(), IMP.naz);
      IMP.U.uImpR.value.set(IMP.rings[0], IMP.rings[1], IMP.rings[2], 0);
    };
    IMP.syncG(); IMP.syncVar();
    var m = new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x000000, shininess: 1, side: THREE.DoubleSide });
    m.onBeforeCompile = function (sh) {
      for (var k in IMP.U) sh.uniforms[k] = IMP.U[k];
      sh.uniforms.uT120Eye = T.U.uT120Eye; sh.uniforms.uT120Sun = T.U.uT120Sun; sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + IMPV)
        .replace('#include <begin_vertex>', impVertex('normalize(uT120Eye - iC)'))
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
        // the shadow is looked up from a point moved toward the sun by the crown's half-size: the quad's own
        // sun-facing billboard (its shadow) cuts through the middle of it, and every pixel behind that plane was
        // in the tree's own shadow — half of every impostor black
        .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(transformed - uT120Sun.xyz * iV.x * iS, 1.0);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + IMPF_HEAD)
        .replace('#include <clipping_planes_fragment>', [
          '#include <clipping_planes_fragment>',
          'float tDi = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
          'if (vT120F > 1.5) { if (tDi >= vT120F - 2.0) discard; } else if (tDi < vT120F) discard;',
          'vec2 c00 = impCell(vImpFr.x, vImpFr.z), c01 = impCell(vImpFr.x, vImpFr.w), c10 = impCell(vImpFr.y, vImpFr.z), c11 = impCell(vImpFr.y, vImpFr.w);',
          'vec4 w4 = vec4((1.0 - vImpW.x) * (1.0 - vImpW.y), (1.0 - vImpW.x) * vImpW.y, vImpW.x * (1.0 - vImpW.y), vImpW.x * vImpW.y);',
          'vec4 a00 = texture2D(uImpA, impUv(c00)), a01 = texture2D(uImpA, impUv(c01)), a10 = texture2D(uImpA, impUv(c10)), a11 = texture2D(uImpA, impUv(c11));',
          'vec4 wa = w4 * vec4(a00.a, a01.a, a10.a, a11.a);',
          'float iA = wa.x + wa.y + wa.z + wa.w;',
          'vec4 iAlb = vec4((a00.rgb * w4.x + a01.rgb * w4.y + a10.rgb * w4.z + a11.rgb * w4.w) / max(iA, 1e-3), iA);',
          'vec2 tdx = dFdx(vImpUv * 96.0), tdy = dFdy(vImpUv * 96.0);',
          'float tMip = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));',
          'if (iAlb.a * (1.0 + tMip * 0.30) < 0.5) discard;',
          'vec3 iN = (texture2D(uImpN, impUv(c00)).rgb * w4.x + texture2D(uImpN, impUv(c01)).rgb * w4.y + texture2D(uImpN, impUv(c10)).rgb * w4.z + texture2D(uImpN, impUv(c11)).rgb * w4.w) / max(iA, 1e-3) * 2.0 - 1.0;',
          // the frame's normal is the tree's own (object space): turn it with the instance
          'vec3 iNw = normalize(vec3(iN.x * vImpRot.y + iN.z * vImpRot.x, iN.y, -iN.x * vImpRot.x + iN.z * vImpRot.y));',
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          'vec3 iAl = iAlb.rgb;',
          'diffuseColor.rgb = iAl * iAl * mix(vec3(0.805, 0.9025, 0.766), vec3(1.156, 1.078, 0.9415), vT120PH);',
        ].join('\n'))
        .replace('#include <normal_fragment_begin>', 'vec3 normal = normalize((viewMatrix * vec4(iNw, 0.0)).xyz);\nvec3 geometryNormal = normal;');
      if (cloud) {
        sh.uniforms.uCloud = cloud.uCloud; sh.uniforms.uCloudBand = cloud.uCloudBand;
        sh.vertexShader = sh.vertexShader.replace('vImpSlot = t120v;', 'vImpSlot = t120v;\nvImpC = iC;').replace('#include <common>', '#include <common>\nvarying vec3 vImpC;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vImpC;\nuniform vec4 uCloud;\nuniform vec2 uCloudBand;\n' + CLOUD)
          .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb *= t120Cloud(vImpC);\n#include <tonemapping_fragment>');
      }
    };
    m.customProgramCacheKey = function () { return 't120imp3' + (cloud ? 'C' : ''); };
    m._t120imp = true;
    var dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    dm.onBeforeCompile = function (sh) {
      for (var k in IMP.U) sh.uniforms[k] = IMP.U[k];
      sh.uniforms.uT120Eye = T.U.uT120Eye; sh.uniforms.uT120Sun = T.U.uT120Sun; sh.uniforms.uTime = W.uTime; sh.uniforms.uWind = W.uWind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + IMPV)
        .replace('#include <begin_vertex>', impVertex('normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]))'))
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + IMPF_HEAD)
        .replace('#include <clipping_planes_fragment>', [
          '#include <clipping_planes_fragment>',
          'if (vT120F > 1.5) { if (vT120F - 2.0 < 0.5) discard; } else if (vT120F >= 0.5) discard;',
          'vec2 cN = impCell(vImpW.x < 0.5 ? vImpFr.x : vImpFr.y, vImpW.y < 0.5 ? vImpFr.z : vImpFr.w);',
          'if (texture2D(uImpA, impUv(cN)).a < 0.5) discard;',
        ].join('\n'));
    };
    dm.customProgramCacheKey = function () { return 't120impDepth2'; };
    m._canopyDepth = dm;
    IMP.mat = m;
    return m;
  };
  /** The one instanced quad set every impostor on the map is drawn with. */
  IMP.mesh = function (cap, wind, cloud) {
    var mat = IMP.material(wind, cloud);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    var fa = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1), va = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    fa.setUsage(THREE.DynamicDrawUsage); va.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('t120f', fa); g.setAttribute('t120v', va);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    var im = new THREE.InstancedMesh(g, mat, cap);
    im.customDepthMaterial = mat._canopyDepth;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; im.castShadow = true; im.receiveShadow = false; im.count = 0;
    im.userData.t120imp = true; im.userData.propBatch = true;
    return im;
  };

  // ============================================================================================================
  // 5. THE LOD BANDS — which instance draws at which LOD, packed each frame the camera moves (PropBatcher.cull)
  // ============================================================================================================
  // projected size of the instance's bound (diameter, px) at which a band begins, and the fade either side
  T.LOD = { near: 560, mid: 120, fade: 0.22, on: true };
  /** A tree batch's LOD set: the LOD0 InstancedMesh `im` (its bucket), a LOD1 mesh of the same instances, and the
   *  impostor slot. The instance attribute `t120f` carries the cross-fade (see the material). */
  T.lodBatch = function (im, b, scene) {
    var u = b.geo.userData.t120, n = b.mats.length;
    var g1src = T.geometry(u.sp, u.vi, 1);
    var mk = function (src) {
      var g = new THREE.BufferGeometry();
      for (var a in src.attributes) g.setAttribute(a, src.attributes[a]);
      g.setIndex(src.index); g.boundingSphere = src.boundingSphere;
      var fa = new THREE.InstancedBufferAttribute(new Float32Array(n), 1); fa.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('t120f', fa);
      return g;
    };
    im.geometry = mk(b.geo);
    var m1 = new THREE.InstancedMesh(mk(g1src), b.mat, n);
    m1.castShadow = im.castShadow; m1.receiveShadow = im.receiveShadow;
    if (b.mat._canopyDepth) m1.customDepthMaterial = b.mat._canopyDepth;
    m1.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m1.boundingSphere = im.boundingSphere; m1.frustumCulled = true; m1.count = 0;
    m1.userData.propBatch = true; m1.userData.cull = { t120child: true, nv: 0, ns: 0, split: false };
    scene.add(m1);
    im.userData.cull.t120 = { m1: m1, key: u.key, geo0: b.geo, mat: b.mat, slot: -1, tmp0: new Int32Array(n), tmp1: new Int32Array(n), f0: new Float32Array(n), f1: new Float32Array(n) };
    return m1;
  };
  /** Pack one tree batch's instances into its bands (and the impostor list). Called from PropBatcher.cull with
   *  its frustums; `out` collects the impostors for `impEnd`. Returns the instances drawn. */
  T.packGroup = function (im, C, F1, F2, cast, down, Ld, eye, focal, split, out) {
    var L = C.t120, m1 = L.m1, sp = C.sph, n = C.n;
    var S = T._S || (T._S = new THREE.Sphere()), S2 = T._S2 || (T._S2 = new THREE.Sphere());
    var near = T.LOD.near, mid = T.LOD.mid, fd = T.LOD.fade, slot = L.slot;
    var lists = T._lists || (T._lists = [[], [], [], [], [], []]);   // band0 shadow, band0 rest, band1 shadow, band1 rest
    for (var z = 0; z < 4; z++) lists[z].length = 0;
    var drawn = 0;
    for (var i = 0; i < n; i++) {
      var r = sp[i * 4 + 3];
      if (r < 0) continue;
      S.center.set(sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 2]); S.radius = r;
      var inC = F1.intersectsSphere(S), inS = false;
      if (cast && F2 && F2.intersectsSphere(S)) {
        if (inC) inS = true;
        else {
          var t = Math.min(200, Math.max(0, S.center.y + r - (C.gy ? C.gy[i] : -50)) / down) * 0.5;
          S2.center.set(S.center.x + Ld.x * t, S.center.y + Ld.y * t, S.center.z + Ld.z * t); S2.radius = r + t + 4;
          inS = F1.intersectsSphere(S2);
        }
      }
      if (!inC && !inS) continue;
      drawn++;
      var dx = S.center.x - eye.x, dy = S.center.y - eye.y, dz = S.center.z - eye.z;
      var px = 2 * r * focal / Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      if (!T.LOD.on) px = 1e9;
      if (!inC && px > mid) px = Math.min(px, near * (1 - fd) * 0.999);   // a shadow out of view: the reduced tree casts it
      // the bands and the fade between them: b0 the LOD0 share, b1 LOD1, b2 the impostor; fade as the far share
      var f01 = (near * (1 + fd) - px) / (2 * fd * near), f12 = (mid * (1 + fd) - px) / (2 * fd * mid);
      var sh = split ? inS : true, k = sh ? 0 : 1;
      if (f01 < 1) {   // LOD0 draws
        lists[k].push(i, f01 > 0 ? f01 : 0);
      }
      if (f01 > 0 && f12 < 1) {   // LOD1 draws
        var v1 = f01 < 1 ? 2 + f01 : (f12 > 0 ? f12 : 0);
        lists[2 + k].push(i, v1);
      }
      if (f12 > 0 && slot >= 0) {   // the impostor
        out[k].push(C, i, f12 < 1 ? 2 + f12 : 0, slot);
      } else if (f12 > 0) {          // no frames yet: LOD1 carries it
        lists[2 + k].push(i, 0);
      }
    }
    var write = function (mesh, A, B, fattr) {
      var arr = mesh.instanceMatrix.array, fa = fattr.array, all = C.all, j = 0;
      var put = function (Ls) { for (var q = 0; q < Ls.length; q += 2) { var ii = Ls[q]; for (var e = 0; e < 16; e++) arr[j * 16 + e] = all[ii * 16 + e]; fa[j] = Ls[q + 1]; j++; } };
      put(A); var ns = j; put(B);
      mesh.userData.cull.nv = j; mesh.userData.cull.ns = ns; mesh.userData.cull.split = split;
      if (split && mesh.onBeforeRender !== T.BEFORE) { mesh.onBeforeRender = T.BEFORE; mesh.onAfterRender = T.AFTER; }
      mesh.count = split ? ns : j;
      if (C.casts === undefined) C.casts = im.castShadow;
      mesh.castShadow = !!C.casts && (!split || ns > 0);
      mesh.visible = j > 0;
      mesh.instanceMatrix.updateRange.offset = 0; mesh.instanceMatrix.updateRange.count = j * 16; mesh.instanceMatrix.needsUpdate = true;
      fattr.updateRange.offset = 0; fattr.updateRange.count = j; fattr.needsUpdate = true;
    };
    write(im, lists[0], lists[1], im.geometry.attributes.t120f);
    write(m1, lists[2], lists[3], m1.geometry.attributes.t120f);
    return drawn;
  };
  T.BEFORE = function () { var C = this.userData.cull; if (C && C.split) this.count = C.nv; };
  T.AFTER = function () { var C = this.userData.cull; if (C && C.split) this.count = C.ns; };
  /** Write the frame's impostors (shadow-casting first) into the one quad set. */
  T.impEnd = function (mesh, out, split) {
    if (!mesh) return 0;
    var arr = mesh.instanceMatrix.array, fa = mesh.geometry.attributes.t120f, va = mesh.geometry.attributes.t120v, j = 0, cap = mesh.instanceMatrix.count;
    var put = function (Ls) {
      for (var q = 0; q < Ls.length && j < cap; q += 4) {
        var C = Ls[q], ii = Ls[q + 1], all = C.all;
        for (var e = 0; e < 16; e++) arr[j * 16 + e] = all[ii * 16 + e];
        fa.array[j] = Ls[q + 2]; va.array[j] = Ls[q + 3]; j++;
      }
    };
    put(out[0]); var ns = j; put(out[1]);
    mesh.userData.cull = mesh.userData.cull || { t120child: true };
    mesh.userData.cull.nv = j; mesh.userData.cull.ns = ns; mesh.userData.cull.split = split;
    if (split && mesh.onBeforeRender !== T.BEFORE) { mesh.onBeforeRender = T.BEFORE; mesh.onAfterRender = T.AFTER; }
    mesh.count = split ? ns : j; mesh.visible = j > 0; mesh.castShadow = !split || ns > 0;
    mesh.instanceMatrix.updateRange.offset = 0; mesh.instanceMatrix.updateRange.count = j * 16; mesh.instanceMatrix.needsUpdate = true;
    fa.updateRange.offset = 0; fa.updateRange.count = j; fa.needsUpdate = true;
    va.updateRange.offset = 0; va.updateRange.count = j; va.needsUpdate = true;
    return j;
  };

  // ============================================================================================================
  // 6. SPECIES BY THEATRE — cosmetic: the cell's hash, never the battle's dice
  // ============================================================================================================
  // per theatre and per kind of placed tree, the species and their weights. `broad` is the `tree` type's eight
  // generic shapes, `poplar` its tall two, `apple` its small two, `conifer` its conifer roll; `oak` and `pine` the
  // types of those names.
  var W8 = function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }); };
  T.THEATRE = {
    west: { broad: W8({ beech: 3, ash: 3, elm: 3, chestnut: 1.5, birch: 1, oak: 1 }), poplar: W8({ poplar: 1 }), apple: W8({ apple: 1 }),
      conifer: W8({ birch: 2, poplar: 1, ash: 1 }), oak: W8({ oak: 3, chestnut: 1 }), pine: W8({ beech: 3, ash: 2, elm: 2, chestnut: 1, oak: 1 }), water: 'willow' },
    lowlands: { broad: W8({ elm: 3, ash: 3, beech: 2, birch: 2, oak: 1 }), poplar: W8({ poplar: 1 }), apple: W8({ apple: 1 }),
      conifer: W8({ birch: 2, poplar: 1 }), oak: W8({ oak: 1 }), pine: W8({ pine: 3, beech: 1, birch: 1 }), water: 'willow' },
    east: { broad: W8({ birch: 4, linden: 3, oak: 1 }), poplar: W8({ poplar: 1, birch: 1 }), apple: W8({ apple: 1 }),
      conifer: W8({ spruce: 3, pine: 1 }), oak: W8({ oak: 2, linden: 1 }), pine: W8({ pine: 3, spruce: 2, birch: 1 }), water: 'willow' },
    north: { broad: W8({ birch: 3, beech: 1 }), poplar: W8({ spruce: 1 }), apple: W8({ birch: 1 }), conifer: W8({ spruce: 1 }),
      oak: W8({ oak: 1 }), pine: W8({ spruce: 3, pine: 2 }), water: 'willow' },
    italy: { broad: W8({ olive: 3, chestnut: 1, oak: 1, stonepine: 1 }), poplar: W8({ cypress: 2, poplar: 1 }), apple: W8({ olive: 1 }),
      conifer: W8({ cypress: 2, stonepine: 2 }), oak: W8({ oak: 1, chestnut: 1 }), pine: W8({ stonepine: 1 }), water: 'poplar' },
    desert: { broad: W8({ acacia: 2, datepalm: 1 }), poplar: W8({ datepalm: 1 }), apple: W8({ acacia: 1 }), conifer: W8({ datepalm: 1 }),
      oak: W8({ acacia: 1 }), pine: W8({ datepalm: 1 }), water: 'datepalm' },
    pacific: { broad: W8({ coco: 1 }), poplar: W8({ coco: 1 }), apple: W8({ coco: 1 }), conifer: W8({ coco: 1 }), oak: W8({ coco: 1 }),
      pine: W8({ coco: 1 }), water: 'coco' },
  };
  T.FLORA = { normandy: 'west', france40: 'west', ardennes: 'north', germany45: 'north', lowlands: 'lowlands', east: 'east',
    italy: 'italy', desert: 'desert', pacific: 'pacific' };
  /** The theatre's species list for the map (from Foliage.floraFor: the era, then the name). */
  T.theatreOf = function (mapDef) {
    var f = (root.Foliage && root.Foliage.floraFor && mapDef) ? root.Foliage.floraFor(mapDef.era, mapDef.name) : 'normandy';
    return T.FLORA[f] || 'west';
  };
  /** Which species and variant draws a placed tree. `kind` is broad/poplar/apple/conifer/oak/pine; species group
   *  in stands (a slow noise over the cells), the variant from the cell's own hash. */
  T.pick = function (theatre, kind, gx, gz, nearWater, winter) {
    var th = T.THEATRE[theatre] || T.THEATRE.west;
    var list = th[kind] || th.broad;
    // WINTER: what was placed as a pine or a conifer stands as a snow-laden spruce or pine (the north's), the
    // broadleaves bare round them — not a field of bare trees where the map drew a pinewood
    if (winter && (kind === 'pine' || kind === 'conifer') && theatre !== 'desert' && theatre !== 'pacific') list = T.THEATRE.north[kind];
    var sp;
    if (nearWater && th.water && kind !== 'pine' && hash2(gx * 0.37, gz * 0.53) < 0.75) sp = th.water;
    else {
      // stands: the weight table walked by a value that drifts over ~8 cells, plus a little of the cell's own
      var sx = gx / 8, sz = gz / 8, ix = Math.floor(sx), iz = Math.floor(sz), fx = sx - ix, fz = sz - iz;
      var v = (hash2(ix, iz) * (1 - fx) + hash2(ix + 1, iz) * fx) * (1 - fz) + (hash2(ix, iz + 1) * (1 - fx) + hash2(ix + 1, iz + 1) * fx) * fz;
      v = (v * 0.8 + hash2(gx, gz) * 0.2);
      var tot = 0, i; for (i = 0; i < list.length; i++) tot += list[i][1];
      var acc = 0; sp = list[list.length - 1][0];
      for (i = 0; i < list.length; i++) { acc += list[i][1] / tot; if (v <= acc) { sp = list[i][0]; break; } }
    }
    if (!T.has(sp)) { sp = null; for (var j = 0; j < list.length; j++) if (T.has(list[j][0])) { sp = list[j][0]; break; } }
    if (!sp) return null;
    var nv = T.pack().species[sp].length;
    return { sp: sp, vi: Math.floor(hash2(gx * 1.7 + 3.1, gz * 2.3 + 7.9) * nv) % nv };
  };

  /** Per frame, from PropBatcher.cull: the eye, the sun. */
  T.frame = function (camera, sun) {
    T.U.uT120Eye.value.setFromMatrixPosition(camera.matrixWorld);
    if (sun) {
      var d = T._sd || (T._sd = new THREE.Vector3());
      d.copy(sun.target ? sun.target.position : d.set(0, 0, 0)).sub(sun.position).normalize();
      T.U.uT120Sun.value.set(d.x, d.y, d.z, T.U.uT120Sun.value.w);
      T.U.uT120SunC.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
  };
})(window);
