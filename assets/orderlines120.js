/* ===========================================================================
 * assets/orderlines120.js — round 120: thin order lines.
 *
 * The owner (23 Nov): "the ui for order commands like the lines etc for
 * movement shooting, sneaking etc ... they're too bold and thick".
 *
 * WHY THEY WERE THICK. `Game._updateOrderVis` laid every order as a flat
 * ribbon of a fixed WORLD width (0.56 u = 2.2 m) with 2.2 u filled diamonds
 * at the ends, so a path read ~5 px wide at the playing camera, ~30 px close
 * up and a hair at the zoom limit, and a section's destination was a heap of
 * ten diamonds. The colour was the only thing that told one order from
 * another.
 *
 * WHAT THIS DRAWS INSTEAD, behind `game.orderLines120` (default ON since 23 Nov; OFF is
 * the old drawing exactly):
 *   - every line a constant SCREEN width (1.4-2.0 CSS px, times the pixel
 *     ratio), anti-aliased in the fragment shader, with a thin dark rim so it
 *     holds over grass, crops and snow without shouting;
 *   - the TYPE in the shape as well as the colour (colour-blind safe):
 *       move     calm solid line, sparse small chevrons
 *       fast     brighter, wider line, close double chevrons
 *       sneak    fine dotted line
 *       assault  dashed line with chevrons
 *       fire     thin line to a small reticle (ring + four ticks); dashed
 *                when the line is obstructed or the man suppressed, long
 *                dashes for indirect fire; area fire ends in a ring + dot
 *       smoke    grey (the Close Combat cursor, assets/ccmenu.js)
 *       routes   the team's colour, long dashes, chevrons, small rings
 *   - a section reads as ONE line: the first man of each section in the
 *     selection is drawn strong with the chevrons, his mates faint;
 *   - queued waypoints and destinations are small rings, a man's own end a
 *     tiny dot, never a filled blob;
 *   - a gentle fade toward the start (the man's end of the line) and dash
 *     phases anchored at the destination, so the pattern does not crawl as
 *     he walks.
 *
 * HOW. One `Batch` is one indexed mesh, one draw call: four vertices a
 * primitive (a segment, or a screen-space disc / ring / reticle), expanded in
 * the vertex shader to a fixed pixel width from the projected end points. The
 * vertex is pulled toward the eye along its own view ray (same pixel, nearer
 * depth: 1.2% of the distance, 0.9-3 u), so grass and crops do not hide the
 * line while a hill or a house still does, and nothing z-fights. Buffers are
 * preallocated and only the used range is uploaded (the old mesh sent all
 * 864 KB every frame); no per-frame allocation here.
 *
 * Drawing only: nothing here reads or writes anything the simulation reads.
 * The meshes are built at install inside `cosmeticScope` (three.js UUIDs draw
 * Math.random).
 * ======================================================================== */
(function () {
  'use strict';

  // primitive kinds (aux.w = kind * 2 + end)
  var K = { SOLID: 0, DASH: 1, DOT: 2, LONG: 3, DISC: 4, RING: 5, RETICLE: 6, AREA: 7 };

  var VS = [
    'attribute vec3 other;',
    'attribute vec4 lcol;',
    'attribute vec4 aux;',
    'uniform vec2 uRes;',
    'uniform float uPr;',
    'uniform float uNear;',
    'uniform float uPullK;',
    'varying vec4 vCol;',
    'varying vec2 vUV;',
    'varying float vHw;',
    'varying float vR;',
    'varying float vKind;',
    'void main() {',
    '  float kind = floor(aux.w * 0.5 + 0.01);',
    '  float endF = aux.w - kind * 2.0;',
    '  vec4 a = modelViewMatrix * vec4(position, 1.0);',
    '  vec4 b = modelViewMatrix * vec4(other, 1.0);',
    '  float nz = -uNear * 2.0;',
    '  if (a.z > nz) {',
    '    if (b.z > nz) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vCol = vec4(0.0); vUV = vec2(0.0); vHw = 0.0; vR = 0.0; vKind = 0.0; return; }',
    '    a.xyz = mix(b.xyz, a.xyz, (b.z - nz) / (b.z - a.z));',
    '  } else if (b.z > nz) {',
    '    b.xyz = mix(a.xyz, b.xyz, (a.z - nz) / (a.z - b.z));',
    '  }',
    // same pixel, nearer depth: grass and crops stop hiding the line, a hill still does
    '  float L = length(a.xyz);',
    '  float pull = uPullK > 0.0 ? min(L * 0.5, clamp(uPullK * L, 0.9, 3.0)) : 0.0;',
    '  a.xyz *= (L - pull) / max(L, 1e-4);',
    '  vec4 ca = projectionMatrix * a;',
    '  vec4 cb = projectionMatrix * b;',
    '  vec2 sa = ca.xy / ca.w * 0.5 * uRes;',
    '  vec2 sb = cb.xy / cb.w * 0.5 * uRes;',
    '  vec2 dir = endF > 0.5 ? sa - sb : sb - sa;',
    '  float dl = length(dir);',
    '  bool pt = kind > 3.5;',
    '  dir = (pt || dl < 1e-4) ? vec2(1.0, 0.0) : dir / dl;',
    '  vec2 nrm = vec2(-dir.y, dir.x);',
    '  float hw = (pt ? aux.y : aux.z) * uPr;',
    '  float R = pt ? aux.z * uPr : 0.0;',
    '  float pad = R + hw + 1.0 * uPr + 1.0;',
    '  vec2 off = nrm * aux.x * pad;',
    '  float al = aux.y * uPr;',
    '  if (pt) { float s = endF * 2.0 - 1.0; off += dir * s * pad; al = s * pad; }',
    '  ca.xy += off / (0.5 * uRes) * ca.w;',
    '  gl_Position = ca;',
    '  vCol = lcol; vUV = vec2(al, aux.x * pad); vHw = hw; vR = R; vKind = kind;',
    '}',
  ].join('\n');

  var FS = [
    'uniform float uPr;',
    'uniform vec4 uHalo;',
    'varying vec4 vCol;',
    'varying vec2 vUV;',
    'varying float vHw;',
    'varying float vR;',
    'varying float vKind;',
    'void main() {',
    '  float k = vKind, d, rk = 1.0;',
    '  if (k > 1.5 && k < 2.5) {',
    // dots: round, one every 4.8 px, with only a breath of rim (a rim round every dot reads as hazard tape)
    '    float per = 4.8 * uPr, c = mod(vUV.x, per) - 0.5 * per;',
    '    d = length(vec2(vUV.y, c)) - vHw * 1.15;',
    '    rk = 0.35;',
    '  } else if (k < 3.5) {',
    '    d = abs(vUV.y) - vHw;',
    '    if (k > 0.5) {',
    '      float per = k < 1.5 ? 11.0 : k < 2.5 ? 4.8 : 17.0;',
    '      float on = k < 1.5 ? 6.0 : k < 2.5 ? 2.5 : 11.0;',
    '      per *= uPr; on *= uPr;',
    '      float p = mod(vUV.x, per);',
    '      d = max(d, max(-p, p - on));',
    '    }',
    '  } else {',
    '    float r = length(vUV);',
    '    if (k < 4.5) d = r - vR;',
    '    else {',
    '      d = abs(r - vR) - vHw;',
    '      if (k < 6.5 && k > 5.5) {',
    '        vec2 q = abs(vUV);',
    '        float t0 = vR * 0.42;',
    '        float t1 = max(q.x - vHw, max(t0 - q.y, q.y - vR));',
    '        float t2 = max(q.y - vHw, max(t0 - q.x, q.x - vR));',
    '        d = min(d, min(t1, t2));',
    '      } else if (k > 6.5) {',
    '        d = min(d, r - max(vHw * 1.7, 1.1 * uPr));',
    '      }',
    '    }',
    '  }',
    '  float core = clamp(0.5 - d, 0.0, 1.0);',
    '  float rim = clamp(0.5 + 0.9 * uPr - d, 0.0, 1.0);',
    '  float ha = uHalo.a * rk * rim * min(1.0, vCol.a * 1.25);',
    '  float a = mix(ha, vCol.a, core);',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(mix(uHalo.rgb, vCol.rgb, core), a);',
    '}',
  ].join('\n');

  /** One mesh, one draw call: segments and screen-space marks. `cap` in primitives. */
  function Batch(THREE, cap, opt) {
    opt = opt || {};
    this.cap = cap;
    var nv = cap * 4;
    this.P = new Float32Array(nv * 3); this.O = new Float32Array(nv * 3);
    this.C = new Float32Array(nv * 4); this.X = new Float32Array(nv * 4);
    this.chev = new Float32Array(cap);    // chevron spacing (CSS px) per segment, 0 = none
    this.chw = new Float32Array(cap);     // …and their arm half-width
    var I = nv > 65535 ? new Uint32Array(cap * 6) : new Uint16Array(cap * 6);
    for (var i = 0; i < cap; i++) {
      var v = i * 4, j = i * 6;
      I[j] = v; I[j + 1] = v + 1; I[j + 2] = v + 2; I[j + 3] = v + 1; I[j + 4] = v + 3; I[j + 5] = v + 2;
    }
    var g = new THREE.BufferGeometry();
    var mk = function (arr, k) { var a = new THREE.BufferAttribute(arr, k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aP = mk(this.P, 3); this.aO = mk(this.O, 3); this.aC = mk(this.C, 4); this.aX = mk(this.X, 4);
    g.setAttribute('position', this.aP); g.setAttribute('other', this.aO);
    g.setAttribute('lcol', this.aC); g.setAttribute('aux', this.aX);
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.setDrawRange(0, 0);
    this.uni = {
      uRes: { value: new THREE.Vector2(1, 1) }, uPr: { value: 1 }, uNear: { value: 0.1 },
      uPullK: { value: opt.pull == null ? 0.012 : opt.pull },
      uHalo: { value: new THREE.Vector4(0.02, 0.025, 0.03, opt.halo == null ? 0.34 : opt.halo) },
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: this.uni, vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false, depthTest: opt.depthTest !== false, side: THREE.DoubleSide,
    });
    mat.toneMapped = false;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opt.renderOrder || 6;
    this.mesh.visible = false;
    this.mesh.name = opt.name || 'orderLines120';
    this.n = 0;
    this._m = new THREE.Matrix4(); this._vp = new THREE.Matrix4(); this._v2 = new THREE.Vector2();
    this.e = this._vp.elements;
    this.W = 1; this.H = 1; this.k = 0.001; this.cx = 0; this.cy = 0; this.cz = 0;
    this.T = null; this.lift = 0.3;
    // the pen (a ground polyline)
    this.px = 0; this.py = 0; this.pz = 0; this.ps = 0; this.psx = 0; this.psy = 0; this.pok = false;
    this.p0 = 0; this.pAlong = 0;
    this.sx = 0; this.sy = 0;
  }
  var B = Batch.prototype;

  /** Start a frame: camera, viewport, ground. */
  B.begin = function (camera, renderer, terrain, scene) {
    if (scene && this.mesh.parent !== scene) scene.add(this.mesh);
    camera.updateMatrixWorld();
    this._m.copy(camera.matrixWorld).invert();
    this._vp.multiplyMatrices(camera.projectionMatrix, this._m);
    this.e = this._vp.elements;
    renderer.getSize(this._v2);
    this.W = this._v2.x || 1; this.H = this._v2.y || 1;
    renderer.getDrawingBufferSize(this.uni.uRes.value);
    this.uni.uPr.value = renderer.getPixelRatio();
    this.uni.uNear.value = camera.near;
    this.k = 2 * Math.tan(camera.fov * Math.PI / 360) / this.H;
    var me = camera.matrixWorld.elements;
    this.cx = me[12]; this.cy = me[13]; this.cz = me[14];
    this.T = terrain || null;
    this.n = 0;
  };
  /** Upload the used range and draw it (or hide). */
  B.end = function () {
    var n = this.n, g = this.mesh.geometry;
    g.setDrawRange(0, n * 6);
    if (n > 0) {
      var nv = n * 4;
      this.aP.updateRange.offset = 0; this.aP.updateRange.count = nv * 3; this.aP.needsUpdate = true;
      this.aO.updateRange.offset = 0; this.aO.updateRange.count = nv * 3; this.aO.needsUpdate = true;
      this.aC.updateRange.offset = 0; this.aC.updateRange.count = nv * 4; this.aC.needsUpdate = true;
      this.aX.updateRange.offset = 0; this.aX.updateRange.count = nv * 4; this.aX.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
    return n;
  };
  B.hide = function () {
    if (this.mesh.visible) { this.mesh.visible = false; this.mesh.geometry.setDrawRange(0, 0); }
    this.n = 0;
  };
  /** World units per CSS pixel at a point (as `Game._ccPx`). */
  B.pxAt = function (x, y, z) {
    var dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * this.k;
  };
  /** Project to CSS px into (sx, sy); false behind the camera. */
  B.proj = function (x, y, z) {
    var e = this.e, w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w < 1e-3) return false;
    this.sx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 * this.W;
    this.sy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 * this.H;
    return true;
  };
  B.gy = function (x, z) { return (this.T ? this.T.heightAt(x, z) : 0) + this.lift; };

  /** One segment, `hw` CSS px half-width, along (CSS px) s0 -> s1. */
  B.seg = function (ax, ay, az, bx, by, bz, hw, r, g, b, a0, a1, kind, s0, s1) {
    if (this.n >= this.cap) return -1;
    var i = this.n++, P = this.P, O = this.O, C = this.C, X = this.X;
    this.chev[i] = 0;
    for (var q = 0; q < 4; q++) {
      var end = q >> 1, o3 = (i * 4 + q) * 3, o4 = (i * 4 + q) * 4;
      if (end) { P[o3] = bx; P[o3 + 1] = by; P[o3 + 2] = bz; O[o3] = ax; O[o3 + 1] = ay; O[o3 + 2] = az; }
      else { P[o3] = ax; P[o3 + 1] = ay; P[o3 + 2] = az; O[o3] = bx; O[o3 + 1] = by; O[o3 + 2] = bz; }
      C[o4] = r; C[o4 + 1] = g; C[o4 + 2] = b; C[o4 + 3] = end ? a1 : a0;
      X[o4] = (q & 1) ? 1 : -1; X[o4 + 1] = end ? s1 : s0; X[o4 + 2] = hw; X[o4 + 3] = kind * 2 + end;
    }
    return i;
  };
  /** A screen-space mark at a point: a disc (R), a ring, a reticle or an area mark (R, stroke hw), CSS px. */
  B.mark = function (x, y, z, R, hw, kind, r, g, b, a) {
    if (this.n >= this.cap) return -1;
    var i = this.n++, P = this.P, O = this.O, C = this.C, X = this.X;
    this.chev[i] = 0;
    for (var q = 0; q < 4; q++) {
      var end = q >> 1, o3 = (i * 4 + q) * 3, o4 = (i * 4 + q) * 4;
      P[o3] = x; P[o3 + 1] = y; P[o3 + 2] = z; O[o3] = x; O[o3 + 1] = y; O[o3 + 2] = z;
      C[o4] = r; C[o4 + 1] = g; C[o4 + 2] = b; C[o4 + 3] = a;
      X[o4] = (q & 1) ? 1 : -1; X[o4 + 1] = hw; X[o4 + 2] = R; X[o4 + 3] = kind * 2 + end;
    }
    return i;
  };
  /** A straight 3-D line (a sight or fire line): along measured on screen. */
  B.line = function (ax, ay, az, bx, by, bz, hw, r, g, b, a0, a1, kind) {
    var s1 = 0;
    if (kind) {
      var ok = this.proj(ax, ay, az), x0 = this.sx, y0 = this.sy;
      var wl = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
      var smax = wl / Math.max(1e-4, Math.min(this.pxAt(ax, ay, az), this.pxAt(bx, by, bz)));
      s1 = smax;
      if (ok && this.proj(bx, by, bz)) s1 = Math.min(smax, Math.sqrt((this.sx - x0) * (this.sx - x0) + (this.sy - y0) * (this.sy - y0)));
    }
    // anchored at the target end: the pattern stands still on the target
    return this.seg(ax, ay, az, bx, by, bz, hw, r, g, b, a0, a1, kind, s1, 0);
  };

  // ---- the pen: a terrain-hugging polyline --------------------------------
  B.penStart = function (x, z, y) {
    this.px = x; this.pz = z; this.py = y == null ? this.gy(x, z) : y;
    this.pok = this.proj(this.px, this.py, this.pz); this.psx = this.sx; this.psy = this.sy;
    this.ps = 0; this.p0 = this.n;
  };
  /** Draw to (x, z) over the ground in a style: hw, colour, alpha, kind, chevron spacing. */
  B.penTo = function (x, z, hw, r, g, b, a, kind, chev, chw, liftY) {
    var dx = x - this.px, dz = z - this.pz, L = Math.sqrt(dx * dx + dz * dz);
    var steps = Math.max(1, Math.ceil(L / 2.5));
    for (var s = 1; s <= steps; s++) {
      var t = s / steps, cx = this.px + dx * t, cz = this.pz + dz * t;
      if (s === steps) { cx = x; cz = z; }
      var ax = s === 1 ? this.px : this._qx, az = s === 1 ? this.pz : this._qz;
      var ay = s === 1 ? this.py : this._qy;
      var cy = (liftY == null ? this.gy(cx, cz) : liftY);
      // its length on screen, never more than its length over the nearer
      // end's pixel: a segment by the camera plane projects to millions
      var ok = this.proj(cx, cy, cz), wx = cx - ax, wy = cy - ay, wz = cz - az;
      var dmax = Math.sqrt(wx * wx + wy * wy + wz * wz) / Math.max(1e-4, Math.min(this.pxAt(ax, ay, az), this.pxAt(cx, cy, cz)));
      var ds = dmax;
      if (ok && this.pok) { var ex = this.sx - this.psx, ey = this.sy - this.psy; ds = Math.min(dmax, Math.sqrt(ex * ex + ey * ey)); }
      var s0 = this.ps, s1 = s0 + ds;
      var i = this.seg(ax, ay, az, cx, cy, cz, hw, r, g, b, a, a, kind, s0, s1);
      if (i >= 0) { this.chev[i] = chev || 0; this.chw[i] = chw || 0.7; }
      this.ps = s1; this.pok = ok; this.psx = this.sx; this.psy = this.sy;
      this._qx = cx; this._qy = cy; this._qz = cz;
    }
    this.px = x; this.pz = z; this.py = this._qy;
  };
  /** Finish the polyline: fade toward its start, dash phase anchored at its
   *  end, chevrons spaced along it (pointing the way it goes). */
  B.penEnd = function (fade, chevOn) {
    var i0 = this.p0, i1 = this.n, tot = this.ps, X = this.X, C = this.C, i, q;
    if (i1 <= i0) return;
    var F = Math.max(1, Math.min(70, tot * 0.35));
    for (i = i0; i < i1; i++) {
      for (q = 0; q < 4; q++) {
        var o4 = (i * 4 + q) * 4, s = X[o4 + 1];
        if (fade) {
          var u = Math.min(1, s / F); u = u * u * (3 - 2 * u);
          C[o4 + 3] *= 0.45 + 0.55 * u;
        }
        X[o4 + 1] = tot - s;
      }
    }
    if (!chevOn) return;
    var P = this.P;
    for (i = i0; i < i1; i++) {
      var sp = this.chev[i];
      if (!(sp > 0)) continue;
      var o = i * 16, e0 = X[o + 1], e1 = X[o + 8 + 1];         // along-from-end at A and at B (e0 > e1)
      if (!(e0 > e1)) continue;
      var off = sp * 0.5, k0 = Math.ceil((e1 - off) / sp), k1 = Math.floor((e0 - off) / sp);
      if (k0 < 0) k0 = 0;
      if (k1 - k0 > 5) k1 = k0 + 5;                             // a 2.5 u segment never needs more
      for (var k = k0; k <= k1; k++) {
        var at = k * sp + off;
        if (at < 10) continue;                                  // the end has its own mark
        var t = (e0 - at) / (e0 - e1);
        var a3 = i * 12, b3 = i * 12 + 6;
        var ax = P[a3], ay = P[a3 + 1], az = P[a3 + 2], bx = P[b3], by = P[b3 + 1], bz = P[b3 + 2];
        var dx = bx - ax, dz = bz - az, dl = Math.sqrt(dx * dx + dz * dz);
        if (dl < 1e-4) continue;
        var c4 = i * 16;
        var al = C[c4 + 3] + (C[c4 + 8 + 3] - C[c4 + 3]) * t;
        this.chevron(ax + dx * t, ay + (by - ay) * t, az + dz * t, dx / dl, dz / dl, this.chw[i], C[c4], C[c4 + 1], C[c4 + 2], al, sp < 60);
      }
    }
  };
  /** A small ">" on the ground pointing (dx, dz); `dbl` adds a second behind it. */
  B.chevron = function (x, y, z, dx, dz, hw, r, g, b, a, dbl) {
    var s = 3.6 * this.pxAt(x, y, z), px = -dz, pz = dx;
    for (var c = 0; c < (dbl ? 2 : 1); c++) {
      var ox = x - dx * s * 1.15 * c, oz = z - dz * s * 1.15 * c;
      var tx = ox + dx * s * 0.6, tz = oz + dz * s * 0.6;
      var b1x = ox - dx * s * 0.6 + px * s, b1z = oz - dz * s * 0.6 + pz * s;
      var b2x = ox - dx * s * 0.6 - px * s, b2z = oz - dz * s * 0.6 - pz * s;
      this.seg(b1x, y, b1z, tx, y, tz, hw, r, g, b, a, a, K.SOLID, 0, 0);
      this.seg(b2x, y, b2z, tx, y, tz, hw, r, g, b, a, a, K.SOLID, 0, 0);
    }
  };
  /** A small screen-space ring standing on the ground at (x, z). */
  B.ring = function (x, z, rPx, hw, r, g, b, a) {
    return this.mark(x, this.gy(x, z), z, rPx, hw, K.RING, r, g, b, a);
  };

  // ---- the Close Combat cursor (assets/ccmenu.js) ------------------------
  // Its helpers pass world half-widths sized from `_ccPx`; here they become
  // pixels again, slimmer, with the rim. Colours keep CC's meanings, a touch
  // softer.
  var SOFT = [0, 0, 0];                  // one scratch colour: no garbage while the cursor aims
  function soft(c) {
    var l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    SOFT[0] = c[0] + (l - c[0]) * 0.16; SOFT[1] = c[1] + (l - c[1]) * 0.16; SOFT[2] = c[2] + (l - c[2]) * 0.16;
    return SOFT;
  }
  B.ccFlat = function (ax, az, bx, bz, hw, c, lift) {
    var T = this.T, l = lift == null ? 0.3 : lift;
    var ya = (T ? T.heightAt(ax, az) : 0) + l, yb = (T ? T.heightAt(bx, bz) : 0) + l;
    var px = this.pxAt((ax + bx) / 2, (ya + yb) / 2, (az + bz) / 2);
    var h = Math.max(0.55, Math.min(1.8, hw / Math.max(1e-4, px) * 0.62)), s = soft(c);
    this.seg(ax, ya, az, bx, yb, bz, h, s[0], s[1], s[2], 0.9, 0.9, K.SOLID, 0, 0);
  };
  B.ccLine = function (ax, ay, az, bx, by, bz, hw, c, kind) {
    var px = this.pxAt(ax, ay, az), h = Math.max(0.5, Math.min(1.4, hw / Math.max(1e-4, px) * 0.62)), s = soft(c);
    this.line(ax, ay, az, bx, by, bz, h, s[0], s[1], s[2], 0.3, 0.8, kind || 0);
  };
  B.ccDot = function (x, z, r, c) {
    var T = this.T, y = (T ? T.heightAt(x, z) : 0) + 0.34, px = this.pxAt(x, y, z);
    var R = Math.max(3.5, Math.min(7, r / Math.max(1e-4, px) * 0.9)), s = soft(c);
    this.mark(x, y, z, R, 0.75, K.RING, s[0], s[1], s[2], 0.95);
    this.mark(x, y, z, 1.7, 0, K.DISC, s[0], s[1], s[2], 0.95);
  };

  // ---- the order lines ----------------------------------------------------
  // Close Combat's colours (CC4 manual p. 13), desaturated a little:
  // Move blue, Sneak yellow, Move Fast purple; the assault is this game's own, orange.
  var STY = {
    normal:  { c: [0.50, 0.69, 0.96], hw: 1.0,  kind: K.SOLID, chev: 120, chw: 0.7 },
    fast:    { c: [0.80, 0.62, 1.00], hw: 1.15, kind: K.SOLID, chev: 46,  chw: 0.8 },
    sneak:   { c: [0.97, 0.84, 0.38], hw: 1.0,  kind: K.DOT,   chev: 0,   chw: 0.7 },
    assault: { c: [0.98, 0.63, 0.36], hw: 1.1,  kind: K.DASH,  chev: 64,  chw: 0.75 },
  };
  var FIRE = { direct: [0.95, 0.34, 0.29], obst: [0.96, 0.63, 0.32], ind: [0.95, 0.80, 0.42] };
  function sty(m) { return m === 'fast' ? STY.fast : m === 'sneak' ? STY.sneak : m === 'assault' ? STY.assault : STY.normal; }
  var LEAD_A = 0.9, MATE_A = 0.55, MATE_W = 0.72;

  function install(api) {
    var THREE = api.THREE, Game = api.Game, game = api.game, P = Game.prototype;
    var HALF = api.HALF, MARK_H = api.MARK_H;
    if (!('orderLines120' in P)) P.orderLines120 = true;   // ON (main, 23 Nov, from .claude/wip120/lines/sheet_crops_1to1.jpg); false = the old ribbons

    /** Called first thing in `_updateOrderVis`: true = drawn here (switch on). */
    P._ol120Frame = function () {
      var on = this.orderLines120 === true && !!this._ol120;
      if (!on) {
        if (this._ol120) this._ol120.hide();
        if (this._ol120Was) { this._ol120Was = false; this._ol120Routes(false); }
        return false;
      }
      if (!this._ol120Was) this._ol120Was = true;
      if (this.orderLines.visible) { this.orderLines.geometry.setDrawRange(0, 0); this.orderLines.visible = false; }
      var Bt = this._ol120;
      if (this.fpv) {                                  // (round 111) first person is a shooter, not a map
        Bt.hide();
        this._ol120Routes(true, true);
        if (this._mortLbl) this._mortarRangeLabels(null);
        return true;
      }
      Bt.begin(this.camera, this.renderer, this.terrain, this.scene);
      if (this.orderVisEnabled && this.mode === 'play') this._ol120Orders(Bt);
      this._ol120Routes(true, false, Bt);
      this._ol120Mortars(Bt);
      Bt.end();
      return true;
    };

    P._ol120Orders = function (Bt) {
      var sel = this.selection, leads = this._ol120L || (this._ol120L = []), tg = this._ol120T || (this._ol120T = []);
      leads.length = 0; tg.length = 0;
      for (var si = 0; si < sel.length; si++) {
        var u = sel[si];
        if (!u.alive || u.team !== this.playerTeam) continue;
        var key = u.squad || u, lead = leads.indexOf(key) < 0;
        if (lead) leads.push(key);
        var A = lead ? LEAD_A : MATE_A, W = lead ? 1 : MATE_W;
        // -- the way he is going: the rest of his path, then his queued legs,
        //    each leg in its own mode's shape and colour
        var i0 = u.pathIdx || 0, np = u.path ? u.path.length : 0, nq = u.queue ? u.queue.length : 0;
        if (np > i0 || nq) {
          Bt.penStart(u.pos.x, u.pos.z);
          var s = sty(u.moveMode), lx = u.pos.x, lz = u.pos.z, ls = s;
          for (var i = i0; i < np; i++) {
            Bt.penTo(u.path[i].x, u.path[i].z, s.hw * W, s.c[0], s.c[1], s.c[2], A, s.kind, lead ? s.chev : 0, s.chw);
            lx = u.path[i].x; lz = u.path[i].z;
          }
          for (var j = 0; j < nq; j++) {
            var q = u.queue[j], qs = sty(q.act === 'assault' ? 'assault' : q.mode);
            Bt.penTo(q.x, q.z, qs.hw * W, qs.c[0], qs.c[1], qs.c[2], A, qs.kind, lead ? qs.chev : 0, qs.chw);
            lx = q.x; lz = q.z; ls = qs;
          }
          Bt.penEnd(true, lead);
          // the end: a small ring where a lead's route ends (the section's
          // own destination ring is the cursor's, assets/ccmenu.js), a tiny
          // dot where each man will stand
          if (lead && nq) {
            for (j = 0; j < nq - 1; j++) {
              var qq = u.queue[j], wc = sty(qq.act === 'assault' ? 'assault' : qq.mode).c;
              Bt.ring(qq.x, qq.z, 3.2, 0.6, wc[0], wc[1], wc[2], 0.85);
            }
            Bt.ring(lx, lz, 5.5, 0.75, ls.c[0], ls.c[1], ls.c[2], 0.9);
          }
          var ey = Bt.gy(lx, lz);
          Bt.mark(lx, ey, lz, lead ? 2.1 : 1.5, 0, K.DISC, ls.c[0], ls.c[1], ls.c[2], lead ? 0.9 : 0.6);
        }
        // -- an assault in progress paints its objective chain
        if (u._assault && lead) {
          var as = this.assaults || [], a = null;
          for (var k = 0; k < as.length; k++) if (as[k].units && as[k].units.indexOf(u) >= 0) { a = as[k]; break; }
          if (a) {
            var S = STY.assault;
            Bt.penStart(a.obj.x, a.obj.z);
            var legs = a.legs || [];
            for (k = 0; k < legs.length; k++) Bt.penTo(legs[k].x, legs[k].z, S.hw, S.c[0], S.c[1], S.c[2], 0.75, K.DASH, 0, S.chw);
            Bt.penEnd(false, false);
            Bt.ring(a.obj.x, a.obj.z, 6.5, 0.8, S.c[0], S.c[1], S.c[2], 0.9);
            for (k = 0; k < legs.length; k++) Bt.ring(legs[k].x, legs[k].z, 3.2, 0.6, S.c[0], S.c[1], S.c[2], 0.85);
          }
        }
        // -- the fire line, to a man or to a point
        var fx = null, fz = null, tgt = null;
        if (u.target && u.target.alive) { tgt = u.target; fx = tgt.pos.x; fz = tgt.pos.z; }
        else if (u.groundAtk) { fx = u.groundAtk.x; fz = u.groundAtk.z; }
        if (fx !== null) {
          var gp = u._gunPos ? u._gunPos() : { x: u.pos.x, y: u.pos.y + MARK_H, z: u.pos.z };
          var ind = u.def.kind === 'mortar' || u.def.kind === 'artillery';
          var probe = tgt || this._ol120Probe(fx, fz);
          var los = ind ? true : this.hasLOS(u, probe);
          var sup = u._suppressed && u._suppressed();
          var fc = ind ? FIRE.ind : (!los || sup) ? FIRE.obst : FIRE.direct;
          var kd = ind ? K.LONG : (!los || sup) ? K.DASH : K.SOLID;
          var ty = this.terrain.heightAt(fx, fz) + 0.6;
          Bt.line(gp.x, gp.y, gp.z, fx, ty, fz, lead ? 0.75 : 0.6, fc[0], fc[1], fc[2], A * 0.45, A, kd);
          // one reticle a target, however many men are on it
          var tk = tgt || (Math.round(fx * 2) * 100003 + Math.round(fz * 2));
          if (tg.indexOf(tk) < 0) {
            tg.push(tk);
            Bt.mark(fx, ty, fz, tgt ? 6.5 : 7.5, 0.75, tgt ? K.RETICLE : K.AREA, fc[0], fc[1], fc[2], 0.92);
          }
        }
      }
    };
    /** A target point for the sight test of area fire (as the old code's). */
    P._ol120Probe = function (fx, fz) {
      var p = this._ol120Pr || (this._ol120Pr = { pos: new THREE.Vector3(), def: { size: 1 } });
      p.pos.set(fx, this.terrain.heightAt(fx, fz) + 0.5, fz);
      return p;
    };

    /** (round 113) A mortar team shows its mortar's reach: thin rings, the
     *  dead ground dashed. The labels are the old code's. */
    P._ol120Mortars = function (Bt) {
      var tubes = this.mode === 'play' ? this._selTubes() : [];
      var H = HALF();
      for (var t = 0; t < tubes.length; t++) {
        var m = tubes[t], R = m.def.rng || 0, r0 = m.def.minRng || 0;
        if (!(R > 0)) continue;
        this._ol120Circle(Bt, m.pos.x, m.pos.z, R, H, 0.9, FIRE.ind, 0.75, K.SOLID);
        if (r0 > 0) this._ol120Circle(Bt, m.pos.x, m.pos.z, r0, H, 0.8, [0.95, 0.52, 0.34], 0.75, K.DASH);
      }
      if (tubes.length || this._mortLbl) this._mortarRangeLabels(tubes);
    };
    P._ol120Circle = function (Bt, cx, cz, r, H, hw, c, a, kind) {
      var N = Math.max(48, Math.min(180, Math.ceil(2 * Math.PI * r / 3))), on = false;
      for (var i = 0; i <= N; i++) {
        var ang = i / N * Math.PI * 2, x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
        var inside = Math.abs(x) <= H && Math.abs(z) <= H;
        if (inside && on) Bt.penTo(x, z, hw, c[0], c[1], c[2], a, kind, 0, 0);
        else if (inside) { Bt.penStart(x, z); on = true; }
        else if (on) { Bt.penEnd(false, false); on = false; }
      }
      if (on) Bt.penEnd(false, false);
    };

    /** Routes (the ⇶ order and the editor's attack plans) in play: the old
     *  meshes (a 1 px line, 1.1-1.8 u discs, a 4 u cone) hidden, drawn here
     *  as long dashes in the team's colour with chevrons and small rings.
     *  `on` false puts the old meshes back as the old code leaves them. */
    P._ol120Routes = function (on, hideOnly, Bt) {
      var play = this.mode === 'play', runs = this._routeRuns || [], ar = this.attackRoutes || [], i, r;
      var pr = this.pendingRoute && this.pendingRoute.vis;
      if (!on) {
        if (this._syncRouteVis) this._syncRouteVis();
        for (i = 0; i < runs.length; i++) if (runs[i].visual && runs[i].visual._grp) runs[i].visual._grp.visible = true;
        if (pr && pr._grp) pr._grp.visible = true;
        return;
      }
      if (!play) {                                       // the editor keeps its bold plans
        if (this._ol120RW) { this._ol120RW = false; this._ol120Routes(false); }
        return;
      }
      this._ol120RW = true;
      for (i = 0; i < ar.length; i++) {
        r = ar[i];
        if (r._grp && r._grp.visible) r._grp.visible = false;
        if (!hideOnly && r.team === this.playerTeam) this._ol120Route(Bt, r, 0.5);
      }
      for (i = 0; i < runs.length; i++) {
        r = runs[i].visual;
        if (!r) continue;
        if (r._grp && r._grp.visible) r._grp.visible = false;
        if (!hideOnly) this._ol120Route(Bt, r, 0.72);
      }
      if (pr) {
        if (pr._grp && pr._grp.visible) pr._grp.visible = false;
        if (!hideOnly) this._ol120Route(Bt, pr, 0.9);
      }
    };
    P._ol120Route = function (Bt, r, a) {
      var pts = r.points;
      if (!pts || !pts.length) return;
      var c = this._ol120Col || (this._ol120Col = {}), key = r.team, rgb = c[key];
      if (!rgb) {
        var h = this.teamColorHex(r.team), cr = ((h >> 16) & 255) / 255, cg = ((h >> 8) & 255) / 255, cb = (h & 255) / 255;
        var l = 0.3 * cr + 0.59 * cg + 0.11 * cb;
        rgb = c[key] = [cr + (l - cr) * 0.2, cg + (l - cg) * 0.2, cb + (l - cb) * 0.2];
      }
      if (pts.length >= 2) {
        Bt.penStart(pts[0].x, pts[0].z);
        for (var i = 1; i < pts.length; i++) Bt.penTo(pts[i].x, pts[i].z, 0.9, rgb[0], rgb[1], rgb[2], a, K.LONG, 90, 0.7);
        Bt.penEnd(false, true);
      }
      for (var j = 0; j < pts.length; j++) Bt.ring(pts[j].x, pts[j].z, j === 0 ? 6 : 3.6, j === 0 ? 0.8 : 0.65, rgb[0], rgb[1], rgb[2], Math.min(1, a + 0.15));
    };
  }

  function orderLines120Install(api) {
    var g = api.game;
    if (!g || g._ol120) return !!(g && g._ol120);
    var make = function () {
      install(api);
      g._ol120 = new Batch(api.THREE, 12000, { renderOrder: 6, name: 'orderLines120' });
      g._ol120cc = new Batch(api.THREE, 4000, { renderOrder: 8, depthTest: false, pull: 0, halo: 0.12, name: 'orderCursor120' });
    };
    if (api.cosmeticScope) api.cosmeticScope(make, null, []); else make();
    return true;
  }

  window.OrderLines120 = { K: K, STY: STY, FIRE: FIRE, Batch: Batch, VS: VS, FS: FS, install: orderLines120Install };
  window.orderLines120Install = orderLines120Install;
})();
