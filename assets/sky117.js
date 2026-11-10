// ROUND 117 — THE SKY, BAKED (switch: game.sky117; OFF is exactly the old Sky class, which is untouched).
//
// The old sky is a painted equirect canvas per weather: it does not know where the sun is, so noon,
// a 9° sun and dusk are the same blue; its clouds are blurred smears that never drift; its sun is a
// white sprite that never sets; and it costs up to five blended dome layers.
//
// This one is ONE opaque dome, drawn LAST at the far plane (so it shades only the pixels of sky that
// are actually on screen — none at all at the playing camera), sampling two small baked textures:
//   · a 32 x 32 table of single-scattering sky radiance (Rayleigh + Mie + ozone, earth's shadow) for
//     the current sun height, integrated on the CPU and re-baked four rows a frame when the sun has
//     moved a quarter of a degree;
//   · a 256 x 256 tileable cloud-noise tile, baked once from fixed hashes (no random stream at all).
// Per pixel: one table fetch, three noise fetches (shape, detail, shape toward the sun for the
// lighting), one for high cloud. Cover, gloom and haze follow the weather state and blend across a
// front; the clouds drift on game.wind (read, never written); the dome meets scene.fog.color exactly
// at the horizon, and that fog colour is the weather's own colour cast by the model's horizon.
// Nothing here reads or writes the simulation, and nothing draws from rand()/Math.random().
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;

  // ---------------------------------------------------------------- 1. the atmosphere (km)
  const RE = 6360, RA = 6420;
  const BR = [5.802e-3, 13.558e-3, 33.1e-3], HR = 8;      // Rayleigh scattering, scale height
  const BM = 3.996e-3, BME = 4.40e-3, HM = 1.2, G = 0.8;  // Mie scattering / extinction, asymmetry
  const BO = [0.650e-3, 1.881e-3, 0.085e-3];              // ozone absorption (tent at 25 +- 15 km)
  const I0 = 20;
  const NA = 32, NE = 32;                                  // table: azimuth from the sun x elevation
  const _d = [0, 0, 0];

  function rayTop(px, py, pz, dx, dy, dz) {
    const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - RA * RA;
    return -b + Math.sqrt(Math.max(0, b * b - c));
  }
  // optical depth (Rayleigh, Mie, ozone) from a point to the top of the air along a direction
  function depth(px, py, pz, dx, dy, dz, n, out) {
    const L = rayTop(px, py, pz, dx, dy, dz);
    let r = 0, m = 0, o = 0, t0 = 0;
    for (let i = 1; i <= n; i++) {
      const t1 = L * (i / n) * (i / n), tm = (t0 + t1) * 0.5, ds = t1 - t0;
      const x = px + dx * tm, y = py + dy * tm, z = pz + dz * tm;
      const h = Math.max(0, Math.sqrt(x * x + y * y + z * z) - RE);
      r += Math.exp(-h / HR) * ds; m += Math.exp(-h / HM) * ds; o += Math.max(0, 1 - Math.abs(h - 25) / 15) * ds;
      t0 = t1;
    }
    out[0] = r; out[1] = m; out[2] = o;
  }
  // what is left of sunlight at the ground for a sun at this elevation (radians): [r, g, b]
  function sunT(el) {
    const o = [0, 0, 0];
    if (el < -0.035) return o;
    depth(0, RE + 0.002, 0, Math.cos(el), Math.sin(el), 0, 32, _d);
    for (let c = 0; c < 3; c++) o[c] = Math.exp(-(BR[c] * _d[0] + BME * _d[1] + BO[c] * _d[2]));
    return o;
  }
  // sky radiance seen from the ground along (vx, vy, vz); the sun is at (sx, sy, 0)
  function radiance(vx, vy, vz, sx, sy, out) {
    const py0 = RE + 0.002, L = rayTop(0, py0, 0, vx, vy, vz), N = 16;
    const mu = vx * sx + vy * sy;
    const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
    const pM = (1 - G * G) / (4 * Math.PI * Math.pow(1 + G * G - 2 * G * mu, 1.5));
    let odR = 0, odM = 0, odO = 0, t0 = 0, r = 0, g = 0, b = 0;
    for (let i = 1; i <= N; i++) {
      const t1 = L * (i / N) * (i / N), tm = (t0 + t1) * 0.5, ds = t1 - t0;
      const x = vx * tm, y = py0 + vy * tm, z = vz * tm;
      const rad = Math.sqrt(x * x + y * y + z * z), h = Math.max(0, rad - RE);
      const dR = Math.exp(-h / HR) * ds, dM = Math.exp(-h / HM) * ds, dO = Math.max(0, 1 - Math.abs(h - 25) / 15) * ds;
      odR += dR * 0.5; odM += dM * 0.5; odO += dO * 0.5;
      const bs = x * sx + y * sy;                                   // is this point in the earth's shadow?
      if (!(bs < 0 && rad * rad - bs * bs < RE * RE)) {
        depth(x, y, z, sx, sy, 0, 6, _d);
        const a = odR + _d[0], m = odM + _d[1], o = odO + _d[2], s = BM * pM * dM;
        r += Math.exp(-(BR[0] * a + BME * m + BO[0] * o)) * (BR[0] * pR * dR + s);
        g += Math.exp(-(BR[1] * a + BME * m + BO[1] * o)) * (BR[1] * pR * dR + s);
        b += Math.exp(-(BR[2] * a + BME * m + BO[2] * o)) * (BR[2] * pR * dR + s);
      }
      odR += dR * 0.5; odM += dM * 0.5; odO += dO * 0.5;
      t0 = t1;
    }
    out[0] = r * I0; out[1] = g * I0; out[2] = b * I0;
  }
  // rows [j0, j1) of the table for a sun at elDeg, into a Float32Array(NA * NE * 3)
  function bakeRows(buf, elDeg, j0, j1) {
    const el = elDeg * Math.PI / 180, sx = Math.cos(el), sy = Math.sin(el), o = [0, 0, 0];
    for (let j = j0; j < j1; j++) {
      const v = j / (NE - 1), se = v * v, ce = Math.sqrt(Math.max(0, 1 - se * se));
      for (let i = 0; i < NA; i++) {
        const ca = 1 - 2 * i / (NA - 1), sa = Math.sqrt(Math.max(0, 1 - ca * ca)), k = (j * NA + i) * 3;
        if (elDeg < -18) { buf[k] = buf[k + 1] = buf[k + 2] = 0; continue; }
        radiance(ce * ca, se, ce * sa, sx, sy, o);
        buf[k] = o[0]; buf[k + 1] = o[1]; buf[k + 2] = o[2];
      }
    }
  }
  // the numbers the dome and the fog take from a finished table
  function tableStats(buf) {
    const st = { max: 1e-9, zen: [0, 0, 0], hz: [0, 0, 0], amb: [0, 0, 0] };
    for (let k = 0; k < buf.length; k++) if (buf[k] > st.max) st.max = buf[k];
    for (let c = 0; c < 3; c++) {
      let z = 0, h = 0, a = 0, n = 0;
      for (let i = 0; i < NA; i++) {
        z += buf[((NE - 1) * NA + i) * 3 + c];
        h += buf[(4 * NA + i) * 3 + c];                             // ~1° above the horizon, all round
        for (let j = NE >> 1; j < NE; j++) { a += buf[(j * NA + i) * 3 + c]; n++; }
      }
      st.zen[c] = z / NA; st.hz[c] = h / NA; st.amb[c] = a / n;
    }
    return st;
  }

  // ---------------------------------------------------------------- 2. cloud noise, baked once
  function hash2(x, y, s) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, PX, PY, s) {                                // periodic value noise
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const x0 = ((xi % PX) + PX) % PX, y0 = ((yi % PY) + PY) % PY, x1 = (x0 + 1) % PX, y1 = (y0 + 1) % PY;
    const a = hash2(x0, y0, s), b = hash2(x1, y0, s), c = hash2(x0, y1, s), d = hash2(x1, y1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, PX, PY, oct, s) {
    let a = 0.5, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * vnoise(x * PX, y * PY, PX, PY, s + o * 17); norm += a; a *= 0.5; PX *= 2; PY *= 2; }
    return sum / norm;
  }
  function billow(x, y, P, oct, s) {                                // folded noise: creases between rounded lumps
    let a = 0.5, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * Math.abs(2 * vnoise(x * P, y * P, P, P, s + o * 13) - 1); norm += a; a *= 0.5; P *= 2; }
    return sum / norm;
  }
  function worley(x, y, P, s) {                                     // distance to the nearest of a periodic scatter
    const X = x * P, Y = y * P, xi = Math.floor(X), yi = Math.floor(Y);
    let best = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j, wx = ((cx % P) + P) % P, wy = ((cy % P) + P) % P;
      const px = cx + hash2(wx, wy, s), py = cy + hash2(wx, wy, s + 7);
      const dd = (px - X) * (px - X) + (py - Y) * (py - Y);
      if (dd < best) best = dd;
    }
    return Math.min(1, Math.sqrt(best));
  }
  // R: cloud shape (billows), G: detail, B: streaked high cloud, A: unused. Also the cover -> threshold table.
  function bakeNoise(N) {
    const px = new Uint8Array(N * N * 4), f = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N)];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / N, y = j / N, k = j * N + i;
      // masses that cluster and leave clearings, warped so no edge is straight, with small rounded lumps on them
      const wx = x + 0.035 * (fbm(x, y, 6, 6, 2, 201) - 0.5), wy = y + 0.035 * (fbm(x, y, 6, 6, 2, 301) - 0.5);
      f[0][k] = 0.55 * fbm(wx, wy, 8, 8, 5, 11) + 0.25 * fbm(x, y, 3, 3, 2, 41) + 0.20 * (1 - billow(x, y, 16, 3, 61));
      f[1][k] = 0.7 * fbm(x, y, 16, 16, 4, 71) + 0.3 * (1 - worley(x, y, 22, 5));
      f[2][k] = fbm(x, y, 3, 11, 4, 131);
    }
    for (let c = 0; c < 3; c++) {
      let lo = 9, hi = -9;
      for (let k = 0; k < N * N; k++) { if (f[c][k] < lo) lo = f[c][k]; if (f[c][k] > hi) hi = f[c][k]; }
      for (let k = 0; k < N * N; k++) px[k * 4 + c] = Math.round(255 * (f[c][k] - lo) / (hi - lo));
    }
    const hist = new Float64Array(256), q = new Float32Array(101);
    for (let k = 0; k < N * N; k++) { px[k * 4 + 3] = 255; hist[px[k * 4]]++; }
    let acc = 0, v = 255;                                           // q[c] = the value that c% of the tile lies above
    for (let c = 0; c <= 100; c++) {
      while (v > 0 && acc + hist[v] <= c / 100 * N * N) { acc += hist[v]; v--; }
      q[c] = v / 255;
    }
    return { px, q };
  }

  // ---------------------------------------------------------------- 3. light, exposure, weather
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // Single scattering leaves twilight grey-violet: most of a low-sun sky is light scattered twice, and that
  // light is blue. One added term, scaled by the table's own brightness, from 10° of sun downward.
  function finishTable(buf, elDeg) {
    const st = tableStats(buf), lum = 0.3 * st.amb[0] + 0.59 * st.amb[1] + 0.11 * st.amb[2];
    const m = 2.5 * (1 - sstep(-3, 10, elDeg)) * lum;
    if (m > 0) for (let k = 0; k < buf.length; k += 3) { buf[k] += 0.12 * m; buf[k + 1] += 0.33 * m; buf[k + 2] += m; }
    return tableStats(buf);
  }
  // The eye adapts: the zenith's blue is held at one level — but not past what the bright horizon of a low sun
  // allows (that sky was a white void) — until it cannot be, and then the frame goes dark.
  const expoOf = st => Math.min(80, Math.max(1.2, Math.min(0.9 / Math.max(1e-6, st.zen[2]),
    2.2 / Math.max(1e-6, 0.3 * st.hz[0] + 0.59 * st.hz[1] + 0.11 * st.hz[2]))));
  const gainOf = elDeg => 0.12 + 0.88 * sstep(-9, 1.5, elDeg);
  const disp = (x, E, gain) => Math.sqrt(1 - Math.exp(-x * E)) * gain;             // the dome's own curve, on the CPU
  const undisp = (c, gain) => { const v = Math.min(0.97, c / gain); return -Math.log(1 - v * v); };
  const NIGHT = [0.144, 0.18, 0.30];           // the old sky's night cast on the fog (deep blue, not a black void) at 0.6:
                                               // at full strength the horizon was a bright blue band under a dark sky
  //            cover  edge  gloom veil  band  high cloud
  const WX = {
    clear:    [0.34, 0.12, 0.00, 0.00, 0.06, 0.55],
    overcast: [0.93, 0.30, 0.35, 0.06, 0.12, 0.00],
    fog:      [0.97, 0.34, 0.20, 0.70, 0.45, 0.00],
    rain:     [0.98, 0.34, 0.55, 0.28, 0.24, 0.00],
    storm:    [1.00, 0.38, 0.80, 0.22, 0.24, 0.00],
    snow:     [0.97, 0.34, 0.25, 0.48, 0.34, 0.00],
    night:    [0.30, 0.12, 0.00, 0.00, 0.06, 0.35],
  };
  function weatherOf(g, out) {                 // the weather state, blended across a front exactly as the game blends it
    const x = g._wx, a = WX[(x && x.fromKey) || g.weatherKey] || WX.clear, b = WX[(x && x.toKey) || g.weatherKey] || a;
    const k = (x && x.dur > 0) ? sstep(0, 1, x.t / x.dur) : 1;
    for (let i = 0; i < 6; i++) out[i] = a[i] + (b[i] - a[i]) * k;
    return out;
  }

  // ---------------------------------------------------------------- 4. the dome
  const VS = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4((viewMatrix * vec4(position, 0.0)).xyz, 1.0);   // the camera is always at its centre
  gl_Position = p.xyww;                                                 // on the far plane: drawn last, behind everything
}`;
  const FS = `
uniform sampler2D tLut;
uniform sampler2D tNoise;
uniform vec3 uSun;
uniform vec2 uSunH;
uniform vec3 uFog;
uniform vec3 uSunCol;
uniform vec3 uSunDisc;
uniform vec3 uAmb;
uniform vec4 uCloud;   // x threshold, y edge width, z overcast 0..1, w high cloud
uniform vec4 uDrift;   // xy low cloud, zw high cloud
uniform vec4 uTone;    // x exposure, y gain, z night 0..1, w lightning
uniform vec4 uHaze;    // x haze band (as sin elevation), y veil, z table scale, w where a cloud starts to be thick
varying vec3 vDir;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 d = normalize(vDir);
  float dith = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  float y = max(d.y, 0.0);
  vec2 hd = d.xz * inversesqrt(max(dot(d.xz, d.xz), 1e-6));
  // the clear sky: one fetch of the baked table (azimuth from the sun, elevation)
  vec2 luv = vec2(0.5 - 0.5 * dot(hd, uSunH), sqrt(y)) * (31.0 / 32.0) + 0.5 / 32.0;
  vec3 L = texture2D(tLut, luv).rgb;
  vec3 col = L * L * (uHaze.z * uTone.x);
  float mu = dot(d, uSun), mu0 = max(mu, 0.0);
  // high, thin cloud
  vec2 p = d.xz / (y + 0.09);
  float ci = texture2D(tNoise, p * 0.021 + uDrift.zw).b;
  float cia = smoothstep(0.42, 0.88, ci) * uCloud.w * smoothstep(0.03, 0.3, y);
  col = mix(col, uSunCol * 0.75 + uAmb, cia * 0.55);
  // the sun: a disc and its aureole, behind the low cloud
  float disc = smoothstep(0.99989, 0.99995, mu);
  float s1 = 1.0 - mu, g1 = 1.0 / (1.0 + s1 * 700.0), g2 = 1.0 / (1.0 + s1 * 70.0), g3 = 1.0 / (1.0 + s1 * 7.0);   // no pow()
  col += uSunDisc * (disc * 6.0 + g1 * g1 * 1.1 + g2 * g2 * 0.30 + g3 * g3 * 0.06) * (1.0 - cia * 0.5);
  // low cloud: shape, detail, and the shape a little toward the sun (denser there = this face is in shade)
  vec2 q = p * 0.22 + uDrift.xy;
  float n = texture2D(tNoise, q).r;
  float shape = n + (texture2D(tNoise, q * 4.3 + uDrift.xy * 0.6).g - 0.5) * 0.26;
  float n2 = texture2D(tNoise, q + uSunH * 0.03, 1.5).r;
  float a = smoothstep(uCloud.x, uCloud.x + uCloud.y, shape);
  float thick = smoothstep(uHaze.w, uHaze.w + 0.5, shape);
  float lit = clamp(0.6 + (n - n2) * 2.8, 0.15, 1.0);
  float m2 = mu0 * mu0, m4 = m2 * m2, silver = m4 * m4 * (1.0 - thick) * 0.5;
  vec3 cl = uSunCol * (lit * (1.0 - 0.6 * thick) + silver)
          + uAmb * (1.0 - 0.42 * thick) * mix(1.0, 0.78 + 0.4 * y, uCloud.z);
  float ap = mix(0.3 + 0.7 * smoothstep(0.0, 0.25, y), 1.0, uCloud.z);   // distance pales broken cloud into the sky
  col = mix(col, cl, a * ap);
  // the dome's own curve (it is not tone mapped, like the old sky), a little saturation, the night
  vec3 c = sqrt(1.0 - exp(-col));
  c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 1.18) * uTone.y;
  c += uTone.z * vec3(0.035, 0.055, 0.110) * (1.0 - a * 0.55);
  if (uTone.z > 0.02) {
    vec3 sp = d * 140.0, ip = floor(sp), fp = fract(sp) - 0.5;
    float h = fract(sin(dot(ip, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float st = step(0.9965, h) * smoothstep(0.35, 0.05, length(fp)) * (0.45 + 0.55 * fract(h * 917.0));
    c += st * uTone.z * (1.0 - a) * (1.0 - cia) * smoothstep(0.03, 0.25, y) * vec3(0.85, 0.9, 1.0);
  }
  c += uTone.w * vec3(0.55, 0.6, 0.75) * (0.35 + 0.65 * a);
  // haze: at and below the horizon the dome IS the fog colour, so there is no seam to find
  c = mix(c, uFog, max(uHaze.y, 1.0 - smoothstep(0.0, uHaze.x, y)));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) + dith, 1.0);
}`;

  function Dome(game) {
    const T = root.THREE;
    this.buf = new Float32Array(NA * NE * 3); this.buf2 = new Float32Array(NA * NE * 3);
    this.px = new Uint8Array(NA * NE * 4);
    this.lut = new T.DataTexture(this.px, NA, NE, T.RGBAFormat);
    this.lut.magFilter = this.lut.minFilter = T.LinearFilter;
    const nz = bakeNoise(256); this.q = nz.q;
    this.noise = new T.DataTexture(nz.px, 256, 256, T.RGBAFormat);
    this.noise.wrapS = this.noise.wrapT = T.RepeatWrapping; this.noise.magFilter = T.LinearFilter;
    this.noise.minFilter = T.LinearMipmapLinearFilter; this.noise.generateMipmaps = true; this.noise.anisotropy = 2;
    this.noise.needsUpdate = true;
    const v3 = () => new T.Vector3(), v4 = (a, b, c, d) => new T.Vector4(a, b, c, d);
    this.u = { tLut: { value: this.lut }, tNoise: { value: this.noise }, uSun: { value: new T.Vector3(0, 1, 0) },
      uSunH: { value: new T.Vector2(0, 1) }, uFog: { value: new T.Vector3(0.6, 0.7, 0.8) }, uSunCol: { value: v3() },
      uSunDisc: { value: v3() }, uAmb: { value: v3() }, uCloud: { value: v4(0.6, 0.16, 0, 0) }, uDrift: { value: v4(0, 0, 0, 0) },
      uTone: { value: v4(2, 1, 0, 0) }, uHaze: { value: v4(0.06, 0, 1, 0.5) } };
    this.mat = new T.ShaderMaterial({ uniforms: this.u, vertexShader: VS, fragmentShader: FS, side: T.BackSide,
      depthWrite: false, depthTest: true, fog: false, toneMapped: false });
    this.mesh = new T.Mesh(new T.SphereGeometry(100, 40, 20), this.mat);
    this.mesh.name = 'sky117'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 900; this.mesh.visible = false;
    this.mesh.scale.setScalar(((game.sky && game.sky.radius) || 2000) / 100);      // only for a pass that draws it with another material
    game.scene.add(this.mesh);
    this._c = new T.Color(); this._wx = [0, 0, 0, 0, 0, 0]; this._job = null; this.bakedEl = null; this.fog = [0, 0, 0];
    this.t90 = sunT(Math.PI / 2);
    this._bakeNow(50); this.ref = [0, 1, 2].map(c => disp(this.st.hz[c], this.E, 1));   // the horizon the weather table was tuned under
    this.bakedEl = null;
  }
  Dome.prototype._commit = function (buf, elDeg) {
    const st = finishTable(buf, elDeg), px = this.px, k = 1 / st.max;
    for (let i = 0, n = NA * NE; i < n; i++) {
      px[i * 4] = Math.round(255 * Math.sqrt(buf[i * 3] * k)); px[i * 4 + 1] = Math.round(255 * Math.sqrt(buf[i * 3 + 1] * k));
      px[i * 4 + 2] = Math.round(255 * Math.sqrt(buf[i * 3 + 2] * k)); px[i * 4 + 3] = 255;
    }
    this.lut.needsUpdate = true; this.st = st; this.E = expoOf(st); this.bakedEl = elDeg; this.bakes = (this.bakes || 0) + 1;
  };
  Dome.prototype._bakeNow = function (elDeg) { bakeRows(this.buf2, elDeg, 0, NE); this._commit(this.buf2, elDeg); };
  // the old Sky's five meshes leave the camera's layers while this one is up, and come back exactly as they were
  Dome.prototype._show = function (g, on) {
    const s = g.sky, olds = s ? [s.mesh, s.meshB, s.deck, s.stars, s.sunSprite] : [];
    for (const m of olds) {
      if (!m) continue;
      if (on) { if (m.layers.mask !== 0) { m._lm117 = m.layers.mask; m.layers.mask = 0; } }
      else if (m.layers.mask === 0 && m._lm117) { m.layers.mask = m._lm117; m._lm117 = 0; }
    }
    this.mesh.visible = on;
  };
  // once a frame from _updateDaylight, after the old sky block: the sun, the light on the cloud, the horizon
  Dome.prototype.daylight = function (g, elDeg, day, night, w) {
    const on = !!g.sky117; this._show(g, on); if (!on) return;
    if (this.bakedEl == null || Math.abs(elDeg - this.bakedEl) > 1.5) { this._job = null; this._bakeNow(elDeg); }
    else if (!this._job && Math.abs(elDeg - this.bakedEl) > 0.25) this._job = { el: elDeg, row: 0 };
    const u = this.u, el = elDeg * Math.PI / 180, az = g.sunAz || 0, st = this.st, E = this.E, gain = gainOf(elDeg);
    u.uSun.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    u.uSunH.value.set(Math.sin(az), Math.cos(az));
    const wx = weatherOf(g, this._wx), cover = wx[0], covK = sstep(0.6, 0.95, cover);
    const qc = this.q[Math.round(Math.min(1, Math.max(0, cover)) * 100)];
    u.uCloud.value.set(qc - wx[1] * (0.5 + 1.1 * covK), wx[1], covK, wx[5]);
    u.uTone.value.x = E; u.uTone.value.y = gain; u.uTone.value.z = night;
    // the horizon: the weather's own fog colour, cast by the model's horizon at this sun height
    const base = this._c.set(w.fogColor), b3 = [base.r, base.g, base.b], tint = [0, 0, 0], fog = this.fog;
    for (let c = 0; c < 3; c++) tint[c] = Math.min(1.6, disp(st.hz[c], E, gain) / this.ref[c]);
    const grey = 0.3 * tint[0] + 0.59 * tint[1] + 0.11 * tint[2];
    for (let c = 0; c < 3; c++) {
      let t = tint[c] + (grey - tint[c]) * covK * 0.7;               // under a full deck the sunset does not reach the haze
      t += (NIGHT[c] - t) * night;
      fog[c] = b3[c] * t;
      fog[c] += (disp(st.hz[c], E, gain) - fog[c]) * 0.35 * (1 - covK) * (1 - night);   // …and a clear sky's own horizon is in it
    }
    g.scene.fog.color.setRGB(fog[0], fog[1], fog[2]);
    if (g.scene.background && g.scene.background.isColor) g.scene.background.setRGB(fog[0], fog[1], fog[2]);
    u.uFog.value.set(fog[0], fog[1], fog[2]);
    u.uHaze.value.set(wx[4] + 0.12 * night, wx[3], st.max, qc);
    // the light on the cloud: the sun through the air it has crossed, the sky's own blue, and under a deck the deck's grey
    const tc = sunT((Math.max(elDeg, 0) * 0.8 + 2.5) * Math.PI / 180), td = sunT(Math.max(el, 0.0035));
    const sd = 1.5 * sstep(-3, 2, elDeg) * (1 - 0.88 * covK), dk = sstep(-3, 0, elDeg);
    const ambK = 0.62 * (0.35 + 0.65 * sstep(-4, 8, elDeg)), am = Math.max(st.amb[0], st.amb[1], st.amb[2], 1e-9);
    const sc = u.uSunCol.value, sdv = u.uSunDisc.value, ua = u.uAmb.value;
    sc.set(tc[0] / this.t90[0] * sd, tc[1] / this.t90[1] * sd, tc[2] / this.t90[2] * sd);
    sdv.set(td[0] / this.t90[0] * dk, td[1] / this.t90[1] * dk, td[2] / this.t90[2] * dk);
    for (let c = 0; c < 3; c++) {
      const clear = (0.6 + 0.4 * st.amb[c] / am) * ambK, deck = undisp(fog[c], gain) * 1.45;
      ua.setComponent(c, clear + (deck - clear) * covK);
    }
  };
  // once a frame from the loop: the table's next four rows, the drift, the lightning
  Dome.prototype.frame = function (g, dt, bolt) {
    const on = !!g.sky117; this._show(g, on); if (!on) return;
    if (g.camera) this.mesh.position.copy(g.camera.position);
    const j = this._job;
    if (j) {
      bakeRows(this.buf, j.el, j.row, Math.min(NE, j.row + 4)); j.row += 4;
      if (j.row >= NE) { this._commit(this.buf, j.el); this._job = null; }
    }
    const wnd = g.wind, d = this.u.uDrift.value, k = 0.0012 * (dt > 0 && dt < 0.5 ? dt : 0);
    if (wnd) {                                                      // with the wind, as the cloud shadows on the ground go
      d.x -= wnd.x * k; d.y -= wnd.z * k; d.z -= wnd.x * k * 0.3; d.w -= wnd.z * k * 0.3;
      d.x -= Math.floor(d.x); d.y -= Math.floor(d.y); d.z -= Math.floor(d.z); d.w -= Math.floor(d.w);
    }
    this.u.uTone.value.w = bolt > 0 ? Math.min(1, bolt) * 0.6 : 0;
  };

  root.Sky117 = { NA, NE, WX, sunT, radiance, bakeRows, tableStats, finishTable, bakeNoise, hash2, expoOf, gainOf, weatherOf,
    Dome, create: g => new Dome(g), VS, FS };
})();
