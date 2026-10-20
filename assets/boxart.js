/* ===========================================================================
 * BOX ART — the finished frame, repainted as a gouache on board
 * ---------------------------------------------------------------------------
 * The grade (assets/grade.js) moves the frame's COLOUR toward a Tamiya box-art
 * painting and costs nothing, because it runs inside tone mapping. What it
 * cannot do is make the frame look PAINTED: a painting is flat, edge-kept
 * patches of colour where the render has per-pixel noise, and a painter's line
 * where the render has an aliased silhouette. Both need a pixel's
 * NEIGHBOURS, which only a pass over the finished image can see.
 *
 * So this is that pass, and it is an option with a price on it:
 *
 *   1. the finished canvas is copied into a texture (`copyFramebufferToTexture`
 *      — the scene render itself is untouched and keeps its MSAA);
 *   2. a KUWAHARA filter at half resolution: for each pixel, the four
 *      quadrants of a (2r+1)² window are summarised by mean and variance and
 *      the flattest quadrant's mean wins. Noise inside a region is averaged
 *      away and the boundary between two regions is kept, which is exactly
 *      what a brush does — it is the classic real-time oil/gouache filter;
 *   3. a composite back onto the canvas: the painted colour, an INK line where
 *      the painted image has a strong edge, the weave of a painting board, and
 *      a light vignette.
 *
 * THE ORDER IS THE COST on a tile-based GPU (see assets/postfx.js): the canvas
 * has to leave tile memory once for the copy. The composite clears before it
 * draws, so the canvas is not loaded back in. The glow is added after this
 * pass, onto the painting.
 *
 *     game.boxArt.enabled = true / false          (the Box Art button)
 *     game.boxArt.radius                          brush size, half-res pixels (soft mode only)
 *     game.boxArt.verify()                        compile + one frame, or why not
 *
 * ROUND 97: CRISP BY DEFAULT. "The box art filter was supposed to make
 * everything look like historical models … not blurry nonsense." It was the
 * Kuwahara: seventy per cent of every pixel came from a HALF-RESOLUTION image
 * whose whole job is to average detail away, which is the opposite of what a
 * box painting does to a model — Koike paints every rivet. The default is now
 * one full-resolution pass straight off the render: an unsharp mask that makes
 * edges crisper, a light gouache flattening of the value (a soft posterise,
 * not a blur), the umber ink line on colour edges, the board and the vignette.
 * No half-resolution target, so it is cheaper as well. `soft = true` puts the
 * old painted pass back for anyone who liked it.
 * ======================================================================== */
(function (root) {
  'use strict';

  var VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  ].join('\n');

  // Kuwahara, four quadrants, radius R (a compile-time constant so the loops
  // unroll). One pass over the (2R+1)^2 window; a pixel on the cross belongs to
  // every quadrant it borders, as in the textbook filter.
  function kuwaharaFrag(R) {
    return [
      '#define R ' + R,
      'uniform sampler2D tSrc;',
      'uniform vec2 uTexel;',       // one SOURCE texel in uv
      'uniform float uStep;',       // source texels per window step
      'varying vec2 vUv;',
      'void main() {',
      '  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);',
      '  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);',
      '  float n = float((R + 1) * (R + 1));',
      '  for (int j = -R; j <= R; j++) {',
      '    for (int i = -R; i <= R; i++) {',
      '      vec3 c = texture2D(tSrc, vUv + vec2(float(i), float(j)) * uTexel * uStep).rgb;',
      '      vec3 c2 = c * c;',
      '      if (i <= 0 && j <= 0) { m0 += c; s0 += c2; }',
      '      if (i >= 0 && j <= 0) { m1 += c; s1 += c2; }',
      '      if (i <= 0 && j >= 0) { m2 += c; s2 += c2; }',
      '      if (i >= 0 && j >= 0) { m3 += c; s3 += c2; }',
      '    }',
      '  }',
      '  m0 /= n; m1 /= n; m2 /= n; m3 /= n;',
      '  float v0 = dot(abs(s0 / n - m0 * m0), vec3(1.0));',
      '  float v1 = dot(abs(s1 / n - m1 * m1), vec3(1.0));',
      '  float v2 = dot(abs(s2 / n - m2 * m2), vec3(1.0));',
      '  float v3 = dot(abs(s3 / n - m3 * m3), vec3(1.0));',
      '  vec3 col = m0; float best = v0;',
      '  if (v1 < best) { best = v1; col = m1; }',
      '  if (v2 < best) { best = v2; col = m2; }',
      '  if (v3 < best) { best = v3; col = m3; }',
      '  gl_FragColor = vec4(col, 1.0);',
      '}',
    ].join('\n');
  }

  // The composite: paint, ink, board, vignette.
  var COMPOSITE = [
    'uniform sampler2D tPaint;',
    'uniform sampler2D tSrc;',
    'uniform vec2 uPTexel;',        // one PAINT texel in uv
    'uniform vec2 uRes;',           // drawing buffer, pixels
    'uniform float uInk;',          // 0..1 strength of the line
    'uniform float uInkLo;',        // edge magnitude where the line starts
    'uniform float uInkHi;',        // …and where it is at full strength
    'uniform float uBoard;',        // 0..1 strength of the board weave
    'uniform float uVignette;',
    'uniform float uDetail;',       // how much of the original render shows through
    'varying vec2 vUv;',
    'float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
    // What the line follows: CHROMATICITY, the colour with its brightness
    // divided out, plus a little of the brightness itself. A shadow falling
    // across one material changes how bright it is and not what colour it is,
    // so it gets no line; the edge of a tank against grass changes both. A
    // luminance edge inked every tree shadow on the field.
    'vec3 chroma(vec3 c) { float l = lum(c); return c / (l + 0.06) * 0.22 + vec3(l * 0.35); }',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main() {',
    '  vec3 paint = texture2D(tPaint, vUv).rgb;',
    '  vec3 src = texture2D(tSrc, vUv).rgb;',
    // A little of the render survives, the way a painter keeps his highlights sharp.
    '  vec3 col = mix(paint, src, uDetail);',
    // Sobel on the PAINTED luminance: the filter has already flattened the
    // noise, so what is left is the edge between two painted regions.
    '  vec2 t = uPTexel;',
    '  vec3 tl = chroma(texture2D(tPaint, vUv + vec2(-t.x,  t.y)).rgb);',
    '  vec3 tc = chroma(texture2D(tPaint, vUv + vec2( 0.0,  t.y)).rgb);',
    '  vec3 tr = chroma(texture2D(tPaint, vUv + vec2( t.x,  t.y)).rgb);',
    '  vec3 ml = chroma(texture2D(tPaint, vUv + vec2(-t.x,  0.0)).rgb);',
    '  vec3 mr = chroma(texture2D(tPaint, vUv + vec2( t.x,  0.0)).rgb);',
    '  vec3 bl = chroma(texture2D(tPaint, vUv + vec2(-t.x, -t.y)).rgb);',
    '  vec3 bc = chroma(texture2D(tPaint, vUv + vec2( 0.0, -t.y)).rgb);',
    '  vec3 br = chroma(texture2D(tPaint, vUv + vec2( t.x, -t.y)).rgb);',
    '  vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);',
    '  vec3 gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);',
    '  float e = sqrt(dot(gx, gx) + dot(gy, gy));',
    '  float ink = smoothstep(uInkLo, uInkHi, e) * uInk;',
    // Ink is a darker, warmer version of the colour under it, not black —
    // a painter outlines in burnt umber, not in a felt tip.
    '  col = mix(col, col * vec3(0.32, 0.26, 0.22), ink);',
    // The board: a fine weave plus a slow mottle, in screen space so it stays
    // put like the texture of the surface the picture is painted on.
    '  vec2 px = gl_FragCoord.xy;',
    '  float weave = sin(px.x * 1.7) * sin(px.y * 1.7);',
    '  float mott = hash(floor(px / 3.0)) - 0.5;',
    '  col *= 1.0 + (weave * 0.35 + mott * 0.65) * uBoard;',
    // Vignette: box art is lit toward its subject.
    '  vec2 q = vUv - 0.5;',
    '  col *= 1.0 - dot(q, q) * uVignette;',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}',
  ].join('\n');

  // The crisp pass: everything from the full-resolution render and its own
  // 3x3 neighbourhood. Nothing here averages detail away.
  var CRISP = [
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',          // one source texel in uv
    'uniform float uSharp;',         // unsharp-mask gain
    'uniform float uPoster;',        // 0..1 how far toward flat painted values
    'uniform float uBands;',         // how many values the gouache is mixed in
    'uniform float uInk;',
    'uniform float uInkLo;',
    'uniform float uInkHi;',
    'uniform float uBoard;',
    'uniform float uVignette;',
    'varying vec2 vUv;',
    'float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
    'vec3 chroma(vec3 c) { float l = lum(c); return c / (l + 0.06) * 0.22 + vec3(l * 0.35); }',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main() {',
    '  vec2 t = uTexel;',
    '  vec3 tl = texture2D(tSrc, vUv + vec2(-t.x,  t.y)).rgb;',
    '  vec3 tc = texture2D(tSrc, vUv + vec2( 0.0,  t.y)).rgb;',
    '  vec3 tr = texture2D(tSrc, vUv + vec2( t.x,  t.y)).rgb;',
    '  vec3 ml = texture2D(tSrc, vUv + vec2(-t.x,  0.0)).rgb;',
    '  vec3 c  = texture2D(tSrc, vUv).rgb;',
    '  vec3 mr = texture2D(tSrc, vUv + vec2( t.x,  0.0)).rgb;',
    '  vec3 bl = texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb;',
    '  vec3 bc = texture2D(tSrc, vUv + vec2( 0.0, -t.y)).rgb;',
    '  vec3 br = texture2D(tSrc, vUv + vec2( t.x, -t.y)).rgb;',
    // UNSHARP: the render minus its own 3x3 blur, added back. Edges get crisper.
    '  vec3 blur = (tl + tr + bl + br + 2.0 * (tc + ml + mr + bc) + 4.0 * c) / 16.0;',
    '  vec3 col = max(c + uSharp * (c - blur), 0.0);',
    // GOUACHE: value mixed in a few steps, the steps themselves soft — a
    // painter lays a light, a mid and a dark, not a continuous ramp.
    '  float l = lum(col);',
    '  float b = l * uBands;',
    '  float f = fract(b);',
    '  float q = (floor(b) + smoothstep(0.25, 0.75, f)) / uBands;',
    '  col *= mix(1.0, (q + 0.004) / (l + 0.004), uPoster);',
    // INK on colour edges (see COMPOSITE: a shadow is not an edge).
    '  vec3 gx = (chroma(tr) + 2.0 * chroma(mr) + chroma(br)) - (chroma(tl) + 2.0 * chroma(ml) + chroma(bl));',
    '  vec3 gy = (chroma(tl) + 2.0 * chroma(tc) + chroma(tr)) - (chroma(bl) + 2.0 * chroma(bc) + chroma(br));',
    '  float e = sqrt(dot(gx, gx) + dot(gy, gy));',
    '  float ink = smoothstep(uInkLo, uInkHi, e) * uInk;',
    '  col = mix(col, col * vec3(0.32, 0.26, 0.22), ink);',
    '  vec2 px = gl_FragCoord.xy;',
    '  float weave = sin(px.x * 1.7) * sin(px.y * 1.7);',
    '  float mott = hash(floor(px / 3.0)) - 0.5;',
    '  col *= 1.0 + (weave * 0.35 + mott * 0.65) * uBoard;',
    '  vec2 qv = vUv - 0.5;',
    '  col *= 1.0 - dot(qv, qv) * uVignette;',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}',
  ].join('\n');

  function quad(fragmentShader, uniforms) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: VERT, fragmentShader: fragmentShader,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    var mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  function BoxArtPass(renderer) {
    this.renderer = renderer;
    this.enabled = false;
    this.radius = 2;          // brush, in HALF-resolution pixels
    this.scale = 2;           // paint target is 1/scale of the drawing buffer
    this.ink = 0.6;
    this.inkLo = 0.16;
    this.inkHi = 0.42;
    this.board = 0.03;
    this.vignette = 0.32;
    this.detail = 0.3;
    // crisp mode (the default): see the header
    this.soft = false;
    this.sharp = 0.55;
    this.poster = 0.3;
    this.bands = 7;
    this.crispInk = 0.5;
    this.crispInkLo = 0.2;
    this.crispInkHi = 0.5;
    this.ok = true;
    this.camera2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene2 = new THREE.Scene();
    this.uK = { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 } };
    this.uC = { tPaint: { value: null }, tSrc: { value: null }, uPTexel: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2() }, uInk: { value: this.ink }, uInkLo: { value: this.inkLo },
      uInkHi: { value: this.inkHi }, uBoard: { value: this.board }, uVignette: { value: this.vignette },
      uDetail: { value: this.detail } };
    this._kR = -1;
    this.qK = null;
    this.qC = quad(COMPOSITE, this.uC);
    this.uX = { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharp: { value: this.sharp },
      uPoster: { value: this.poster }, uBands: { value: this.bands }, uInk: { value: this.crispInk },
      uInkLo: { value: this.crispInkLo }, uInkHi: { value: this.crispInkHi }, uBoard: { value: this.board },
      uVignette: { value: this.vignette } };
    this.qX = quad(CRISP, this.uX);
    this._pos = new THREE.Vector2(0, 0);
    this.setSize();
  }

  BoxArtPass.prototype.setSize = function () {
    var sz = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(sz);
    var w = sz.x | 0, h = sz.y | 0;
    if (this.w === w && this.h === h && this.pw === ((w / this.scale) | 0)) return;
    this.dispose();
    this.w = w; this.h = h;
    this.pw = Math.max(8, (w / this.scale) | 0); this.ph = Math.max(8, (h / this.scale) | 0);
    // What the canvas is copied into. A DataTexture with no data: the GPU
    // storage is allocated on first bind and `copyTexImage2D` fills it. RGB,
    // because the game's context is created with `alpha: false` and a copy may
    // not invent a channel the framebuffer does not have — asked for RGBA,
    // `copyTexImage2D` is INVALID_OPERATION (1282) and the frame goes black.
    var attrs = this.renderer.getContext().getContextAttributes() || {};
    this.copy = new THREE.DataTexture(null, w, h, attrs.alpha === false ? THREE.RGBFormat : THREE.RGBAFormat);
    this.copy.minFilter = THREE.LinearFilter; this.copy.magFilter = THREE.LinearFilter;
    this.copy.generateMipmaps = false;
    this.rtP = new THREE.WebGLRenderTarget(this.pw, this.ph, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
    });
  };

  BoxArtPass.prototype.dispose = function () {
    if (this.copy) this.copy.dispose();
    if (this.rtP) this.rtP.dispose();
    this.copy = this.rtP = null;
  };

  BoxArtPass.prototype._pass = function (mesh, target, clear) {
    this.scene2.children.length = 0;
    this.scene2.add(mesh);
    this.renderer.setRenderTarget(target || null);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this.scene2, this.camera2);
  };

  /** Repaint the canvas. Call straight after the scene has been drawn to it. */
  BoxArtPass.prototype.apply = function () {
    if (!this.enabled || !this.ok) return false;
    var r = this.renderer;
    this.setSize();
    if (!this.soft) return this._applyCrisp(r);
    var R = Math.max(1, Math.min(6, this.radius | 0));
    if (R !== this._kR) { this._kR = R; if (this.qK) this.qK.material.dispose(); this.qK = quad(kuwaharaFrag(R), this.uK); }
    var autoClear = r.autoClear;
    r.autoClear = false;
    try {
      r.setRenderTarget(null);
      r.copyFramebufferToTexture(this._pos, this.copy);
      // 1. paint, at 1/scale: each window step is `scale` source texels, so the
      //    brush is the same size on screen whatever the resolution.
      this.uK.tSrc.value = this.copy;
      this.uK.uTexel.value.set(1 / this.w, 1 / this.h);
      this.uK.uStep.value = this.scale;
      this._pass(this.qK, this.rtP, false);
      // 2. composite back onto the canvas, cleared first so a tile GPU does not
      //    load the old frame back in to draw over it.
      var u = this.uC;
      u.tPaint.value = this.rtP.texture; u.tSrc.value = this.copy;
      u.uPTexel.value.set(1 / this.pw, 1 / this.ph);
      u.uRes.value.set(this.w, this.h);
      u.uInk.value = this.ink; u.uInkLo.value = this.inkLo; u.uInkHi.value = this.inkHi;
      u.uBoard.value = this.board; u.uVignette.value = this.vignette; u.uDetail.value = this.detail;
      this._pass(this.qC, null, true);
    } finally {
      r.autoClear = autoClear;
      r.setRenderTarget(null);
    }
    return true;
  };

  /** The crisp pass: copy the canvas, draw it back sharpened and inked. */
  BoxArtPass.prototype._applyCrisp = function (r) {
    var autoClear = r.autoClear;
    r.autoClear = false;
    try {
      r.setRenderTarget(null);
      r.copyFramebufferToTexture(this._pos, this.copy);
      var u = this.uX;
      u.tSrc.value = this.copy;
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      u.uSharp.value = this.sharp; u.uPoster.value = this.poster; u.uBands.value = this.bands;
      u.uInk.value = this.crispInk; u.uInkLo.value = this.crispInkLo; u.uInkHi.value = this.crispInkHi;
      u.uBoard.value = this.board; u.uVignette.value = this.vignette;
      this._pass(this.qX, null, true);
    } finally {
      r.autoClear = autoClear;
      r.setRenderTarget(null);
    }
    return true;
  };

  /** Compile the shaders and run one pass: true, or the reason it cannot. */
  BoxArtPass.prototype.verify = function () {
    var was = this.enabled;
    try {
      this.enabled = true;
      this.apply();
      var gl = this.renderer.getContext();
      var err = gl.getError();
      this.ok = err === gl.NO_ERROR;
      if (!this.ok) this.reason = 'GL error ' + err;
    } catch (e) { this.ok = false; this.reason = String(e && e.message || e); }
    this.enabled = was;
    return this.ok || this.reason;
  };

  root.BoxArtPass = BoxArtPass;
})(window);
