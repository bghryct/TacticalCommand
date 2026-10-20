/* ===========================================================================
 * POSTFX — a glow on the things that are actually hot, at a price we can pay
 * ---------------------------------------------------------------------------
 * Nothing in this game glowed. There was no post chain at all: `renderer.render`
 * went straight to the canvas, so a shell burst, a muzzle flash, a burning tank
 * and a tracer all stopped at white and none of them threw any light into the
 * frame around them. A bright thing reads as bright because of what it does to
 * its NEIGHBOURS, and none of them did anything to theirs.
 *
 * WHY THIS IS NOT A NORMAL BLOOM, WHICH IS WHAT I BUILT FIRST.
 *
 * The textbook chain renders the whole scene into a target, cuts the bright
 * pixels out of it, blurs them and composites. It works and it looked good, and
 * measured against the frame-delta of the real loop at 2.85 Mpix it cost this:
 *
 *      direct to canvas                    16.8 ms median     59.9 fps
 *      scene into a 4x MSAA target         19.6 ms            +2.7
 *      …plus bright pass, blur, composite  20.7 ms            +1.1
 *      the same with MSAA off entirely     18.5 ms            +1.7
 *
 * So the effect was never the cost — routing the whole frame through a target
 * was, and even stripped of its antialiasing it missed 60 fps and THE STANDARD
 * both. `antialias: true` applies to the DEFAULT framebuffer and to nothing
 * else, so the cheap version is also the one that throws away every roof edge
 * in the game.
 *
 * The thing worth noticing is that almost nothing in the frame should glow. The
 * sky should not, sunlit grass should not, a white farmhouse wall should not —
 * only fire, flashes, tracers and bursts should, and those are already sitting
 * in their own additively-blended particle batches. So: leave the scene render
 * completely alone, draw ONLY those batches again into a quarter-size target,
 * blur that, and blend it over the finished canvas. The base image is not
 * copied, not resolved and not touched — it is bit-for-bit the frame that was
 * there before, because it never left the canvas.
 *
 * The trade is that the glow has no depth information, so a fire behind a ridge
 * throws a little light over the ridge. At a fixed 39-degree camera that is
 * almost never visible, and it is the same approximation most games ship.
 * ======================================================================== */
(function (root) {
  'use strict';

  // A layer the additive particle batches are put on IN ADDITION to layer 0, so
  // they still draw in the ordinary pass and can also be drawn alone.
  var GLOW_LAYER = 3;

  var VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  ].join('\n');

  var BLUR = [
    'uniform sampler2D tSrc;',
    'uniform vec2 uDir;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 s = texture2D(tSrc, vUv).rgb * 0.2270270270;',
    '  s += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;',
    '  s += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;',
    '  s += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;',
    '  s += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;',
    '  gl_FragColor = vec4(s, 1.0);',
    '}',
  ].join('\n');

  // Two levels: a tight halo and a wide one. A single blur radius gives a burst
  // a hard bright ring; the wide level is what makes it read as a glare.
  var COMPOSITE = [
    'uniform sampler2D tTight;',
    'uniform sampler2D tWide;',
    'uniform float uStrength;',
    'uniform float uWide;',
    'uniform float uThreshold;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 t = texture2D(tTight, vUv).rgb;',
    '  vec3 w = texture2D(tWide, vUv).rgb;',
    '  vec3 g = t + w * uWide;',
    // A floor, so the faint end of a smoke wisp does not get a halo — only the
    // things that are genuinely hot.
    '  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));',
    '  g *= smoothstep(uThreshold * 0.5, uThreshold, l);',
    '  gl_FragColor = vec4(g * uStrength, 1.0);',
    '}',
  ].join('\n');

  function quad(fragmentShader, uniforms, blending) {
    var g = new THREE.BufferGeometry();
    // One oversized triangle, not two: no diagonal seam, one fewer vertex.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 2, 0, 0, 2]), 2));
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: VERT, fragmentShader: fragmentShader,
      depthTest: false, depthWrite: false, toneMapped: false,
      blending: blending || THREE.NoBlending, transparent: !!blending,
    });
    var mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  function PostFX(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    // Tuned by eye against a shelled position. At 1.35 the fireballs blew out
    // to flat white discs and lost the orange that makes them read as fire;
    // the threshold keeps the halo off the smoke and dust, which are additive
    // too but must stay grey — a glowing dust cloud looks like a bug.
    this.strength = 0.72;
    this.wide = 0.55;
    this.threshold = 0.16;
    this.scale = 4;            // glow target is 1/scale of the drawing buffer
    // Fewer additive particles than this and the chain is skipped entirely.
    this.minParticles = 14;
    this.sources = [];
    this.ok = true;
    this.lastDrew = false;

    this.camera2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene2 = new THREE.Scene();
    // Holds the glow sources for the length of one pass; see render().
    this.glowScene = new THREE.Scene();
    this.uBlur = { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } };
    this.uComp = { tTight: { value: null }, tWide: { value: null },
      uStrength: { value: this.strength }, uWide: { value: this.wide },
      uThreshold: { value: this.threshold } };
    this.qBlur = quad(BLUR, this.uBlur);
    this.qComp = quad(COMPOSITE, this.uComp, THREE.AdditiveBlending);
    this._black = new THREE.Color(0, 0, 0);
    this.setSize();
  }

  /** Point the chain at the additive particle batches. Called by the game once
   *  the effects system exists; anything added here also keeps drawing normally. */
  PostFX.prototype.addSource = function (obj) {
    if (!obj || this.sources.indexOf(obj) >= 0) return;
    obj.layers.enable(GLOW_LAYER);
    this.sources.push(obj);
  };

  /** True once any source has been detached — a map change rebuilds the VFX
   *  batches and the old meshes are then orphans that will never glow again. */
  PostFX.prototype.stale = function () {
    for (var i = 0; i < this.sources.length; i++) if (!this.sources[i].parent) return true;
    return false;
  };

  PostFX.prototype.adoptVfx = function (vfx) {
    if (!vfx || !vfx.batches) return 0;
    // Drop orphans first, or a map change leaves this pointing at dead meshes.
    for (var k = this.sources.length - 1; k >= 0; k--) {
      if (!this.sources[k].parent) this.sources.splice(k, 1);
    }
    var n = 0, list = vfx.batches;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      // Only the additive batches: fire, flashes, tracers, bursts. The normally
      // blended one is smoke and dust, which must not glow. A baked burst
      // (`glow`) is fire in smoke: its fire only (`_glowOnly`).
      if (b && b.mesh && (b.additive || b.glow)) { this.addSource(b.mesh); b.mesh._vfxBatch = b; n++; }
    }
    return n;
  };

  /** Switch the premultiplied (fire-in-smoke) sources between their normal
   *  draw and fire-only, for the glow pass. */
  PostFX.prototype._glowOnly = function (v) {
    for (var i = 0; i < this.sources.length; i++) {
      var b = this.sources[i]._vfxBatch;
      if (b && b.glow && b.mat && b.mat.uniforms.uGlowOnly) b.mat.uniforms.uGlowOnly.value = v;
    }
  };

  PostFX.prototype._rt = function (w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false,
    });
  };

  PostFX.prototype.setSize = function () {
    var sz = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(sz);
    var w = Math.max(8, (sz.x / this.scale) | 0), h = Math.max(8, (sz.y / this.scale) | 0);
    if (this.gw === w && this.gh === h) return;
    this.dispose(true);
    this.gw = w; this.gh = h;
    this.rtA = this._rt(w, h);
    this.rtB = this._rt(w, h);
    this.rtC = this._rt(Math.max(4, w >> 1), Math.max(4, h >> 1));
    this.rtD = this._rt(Math.max(4, w >> 1), Math.max(4, h >> 1));
  };

  PostFX.prototype._pass = function (mesh, target) {
    this.scene2.children.length = 0;
    this.scene2.add(mesh);
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this.scene2, this.camera2);
  };

  /**
   * ALL THE RENDER-TARGET WORK, AND IT HAPPENS BEFORE THE SCENE IS DRAWN.
   *
   * The order matters more than anything else in this file. Drawing the scene
   * to the canvas, then binding a render target, then coming back to the canvas
   * to composite makes a tile-based GPU — which is what an Apple machine has —
   * flush the whole framebuffer out of tile memory and load it back again. It
   * is the same picture either way and it cost about 3 ms a frame.
   *
   * So the glow is generated FIRST, into targets, while the canvas has not been
   * touched yet; then the scene is drawn; then one additive pass goes over it.
   * The canvas is entered once and never left.
   */
  PostFX.prototype.prepare = function (scene, camera) {
    var r = this.renderer;
    this.lastDrew = false; this._ready = false;
    if (!this.ok || !this.enabled || !this.sources.length) return;
    this.setSize();

    // IS ANYTHING ACTUALLY ALIGHT? An empty glow pass still costs a clear, a
    // blur chain and a full-screen blend, and most frames of most battles have
    // nothing burning in them at all.
    //
    // This asked `geometry.drawRange.count > 0`, and in Three.js drawRange
    // defaults to **Infinity** — so the test was always true and the whole
    // chain ran on every frame of every battle whether or not a single thing
    // was burning. Counted in the loop profile: 1043 `renderer.render` calls
    // for 149 game frames, seven per frame, six of them this. The same shape as
    // the `opts.pen || …` bug in round 50: a sentinel value that is not the one
    // the comparison assumes.
    //
    // The VFX batch knows how many particles it has alive. Ask it — and ask for
    // ENOUGH of them. A battlefield nearly always has a tracer or a muzzle
    // flash somewhere, so "more than nothing" almost never skips; six passes to
    // put a halo round two sparks is not worth the frame it takes. Below the
    // threshold the glow is imperceptible and the chain is a pure cost.
    var alive = 0;
    for (var i = 0; i < this.sources.length; i++) {
      var s = this.sources[i];
      if (!s.visible || !s.parent) continue;
      var b = s._vfxBatch;
      alive += b ? (b.n || 0) : this.minParticles;   // no batch: assume it is worth drawing
    }
    if (alive < this.minParticles) return;

    var prevAutoClear = r.autoClear;
    var prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();

    // ONLY THE SOURCES, AND ONLY THE SOURCES IN THE SCENE GRAPH TOO.
    //
    // The obvious way to draw two meshes out of a scene is a layer mask on the
    // camera. It gives the right PICTURE and it does not give the right price:
    // `WebGLRenderer.render` still walks the entire graph, tests every object's
    // layers and rebuilds and re-sorts its render lists — the mask skips the
    // draw call, not the traversal. Measured, that cost 3.0 ms a frame on a
    // scene of a few thousand objects, which is the whole frame budget's worth
    // of headroom for two particle meshes.
    //
    // So move the sources into a scene of their own for the pass and put them
    // straight back. Their matrices are world-space with `matrixAutoUpdate`
    // off and both scenes sit at the identity, so the transforms survive the
    // move untouched, and draw order in the main scene is carried by explicit
    // `renderOrder` rather than by child index.
    var i, n = this.sources.length;
    for (i = 0; i < n; i++) this.glowScene.add(this.sources[i]);
    // A baked fire-in-smoke batch draws its FIRE only into the glow source.
    this._glowOnly(1);
    r.autoClear = true;
    r.setClearColor(this._black, 1);
    r.setRenderTarget(this.rtA);
    r.clear(true, true, false);
    r.render(this.glowScene, camera);
    this._glowOnly(0);
    for (i = 0; i < n; i++) scene.add(this.sources[i]);
    r.setClearColor(prevClear, prevAlpha);

    // Tight halo at 1/scale…
    this.uBlur.tSrc.value = this.rtA.texture;
    this.uBlur.uDir.value.set(1 / this.gw, 0); this._pass(this.qBlur, this.rtB);
    this.uBlur.tSrc.value = this.rtB.texture;
    this.uBlur.uDir.value.set(0, 1 / this.gh); this._pass(this.qBlur, this.rtA);
    // …and a wide one at half that again, for the glare around a big burst.
    this.uBlur.tSrc.value = this.rtA.texture;
    this.uBlur.uDir.value.set(2 / this.gw, 0); this._pass(this.qBlur, this.rtC);
    this.uBlur.tSrc.value = this.rtC.texture;
    this.uBlur.uDir.value.set(0, 2 / this.gh); this._pass(this.qBlur, this.rtD);

    r.autoClear = prevAutoClear;
    r.setRenderTarget(null);
    this._ready = true;
  };

  /** One additive pass over the finished frame. Nothing is read back: the
   *  hardware blend does the work, so the base image is never copied. */
  PostFX.prototype.composite = function () {
    if (!this._ready) return;
    this._ready = false;
    var r = this.renderer;
    var prevAutoClear = r.autoClear;
    this.uComp.tTight.value = this.rtA.texture;
    this.uComp.tWide.value = this.rtD.texture;
    this.uComp.uStrength.value = this.strength;
    this.uComp.uWide.value = this.wide;
    this.uComp.uThreshold.value = this.threshold;
    r.autoClear = false;
    this._pass(this.qComp, null);
    r.autoClear = prevAutoClear;
    this.lastDrew = true;
  };

  /** (round 108) EVERY PROGRAM THE CHAIN USES, COMPILED BEFORE IT IS NEEDED:
   *  the glow sources as they are drawn into a target (linear) — not the
   *  programs the scene draws them with (sRGB, on the canvas) — the blur into
   *  a target and the blend onto the canvas. They were made on the first frame
   *  anything burned, 3.5-4.9 ms each on top of it. Called by the game's
   *  prewarm; the sources are put back in `scene`, as `prepare` puts them. */
  PostFX.prototype.warm = function (scene, camera) {
    if (!this.ok) return;
    var r = this.renderer, was = r.getRenderTarget(), i, n = this.sources.length;
    this.setSize();
    try {
      if (n && camera && scene) {
        for (i = 0; i < n; i++) this.glowScene.add(this.sources[i]);
        try { r.setRenderTarget(this.rtA); r.compile(this.glowScene, camera); }
        finally { for (i = 0; i < n; i++) scene.add(this.sources[i]); }
      }
      this.scene2.children.length = 0; this.scene2.add(this.qBlur);
      r.setRenderTarget(this.rtB); r.compile(this.scene2, this.camera2);
      this.scene2.children.length = 0; this.scene2.add(this.qComp);
      r.setRenderTarget(null); r.compile(this.scene2, this.camera2);
      this.scene2.children.length = 0;
    } finally { r.setRenderTarget(was); }
  };

  PostFX.prototype.dispose = function (keepQuads) {
    var keys = ['rtA', 'rtB', 'rtC', 'rtD'];
    for (var i = 0; i < keys.length; i++) {
      if (this[keys[i]]) { this[keys[i]].dispose(); this[keys[i]] = null; }
    }
    if (!keepQuads) this.ok = false;
  };

  PostFX.GLOW_LAYER = GLOW_LAYER;
  root.PostFX = PostFX;
})(window);
