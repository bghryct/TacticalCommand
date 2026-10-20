/* ===========================================================================
 * WAR AUDIO — a sample layer and a better synth over the procedural SFX engine
 * ---------------------------------------------------------------------------
 * The game's `SFX` class synthesises everything in-page, which is why it works
 * from `file://` with an empty `assets/` folder. That property is worth
 * keeping, so this file does not replace it — it sits on top of it:
 *
 *   1. A SAMPLE BANK. If `assets/audio/manifest.json` exists, every clip it
 *      lists is decoded into an AudioBuffer and `SFX` plays the real recording
 *      instead of its synthesis, through the same positional bus (so distance
 *      attenuation, air absorption, panning, the speed-of-sound delay and the
 *      valley reverb all still apply). If the manifest is missing — which is
 *      the case on a fresh checkout, and always the case on `file://` where
 *      fetch is blocked — nothing happens and the synth carries on. There is
 *      no error, no console noise, and no silent battlefield.
 *
 *   2. A VOICE SYNTH. Soldiers shouting and screaming is the one thing the
 *      original engine had no answer for, and it is the thing that makes a
 *      firefight feel like it has people in it. Rather than wait for samples,
 *      this synthesises the human voice directly: a glottal pulse train driven
 *      through three formant resonators, with a pitch contour, a breath layer
 *      and a per-soldier vocal-tract length. It is recognisably a man
 *      shouting, and it costs nothing to ship.
 *
 *   3. ENGINE LOOPS. A tank should be audible before it is visible. This gives
 *      each vehicle a continuous engine — a stack of detuned sawtooths at the
 *      firing frequency, a rumble bed and a track-clank layer — with one
 *      throttle parameter the game drives from the unit's speed.
 *
 * See `assets/audio/README.md` for where to get CC0 recordings and exactly
 * what the manifest expects.
 * ======================================================================== */
(function () {
  'use strict';
  // COSMETIC RANDOMNESS, ITS OWN STREAM (round 95). Drawing on `Math.random`
  // moved the simulation's rolls — which every probe seeds — by how much
  // the listener could hear, so a seeded battle depended on the camera. Mulberry32.
  var _cs = 0x68e31da4;
  function crand() {
    _cs = (_cs + 0x6D2B79F5) | 0;
    var t = Math.imul(_cs ^ (_cs >>> 15), 1 | _cs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }


  var VERSION = 1;

  var A = {
    ctx: null,
    master: null,       // the game's master GainNode
    wet: null,          // the game's reverb send
    ready: false,
    banks: {},          // name -> [AudioBuffer, …] (variants, chosen round-robin)
    full: {},           // name -> true: a full-range recording (manifest `full`)
    rr: {},             // round-robin cursor per name
    loops: {},          // id -> loop record
    beds: {},           // id -> ambience bed record
    manifestState: 'none',   // none | loading | loaded | absent | error
    loaded: 0, wanted: 0,
  };

  function rnd(a, b) { return a + crand() * (b - a); }

  // =========================================================================
  // 1. SAMPLE BANK
  // =========================================================================

  /** Hook into the game's existing audio graph. Called from `SFX.ensure()`. */
  function install(api) {
    A.ctx = api.ctx;
    A.master = api.master;
    A.wet = api.wet || null;
    A.ready = !!A.ctx;
    return A.ready;
  }

  /** Load `<base>/manifest.json` and every clip it names.
   *
   *  Shape:
   *    {
   *      "credits": "…",
   *      "clips": {
   *        "rifle":  ["rifle_01.ogg", "rifle_02.ogg", "rifle_03.ogg"],
   *        "mg42":   ["mg42_burst.ogg"],
   *        "pain":   ["pain_01.ogg", "pain_02.ogg"],
   *        "engine.tank": ["tank_idle_loop.ogg"]
   *      }
   *    }
   *
   *  Every failure mode ends the same way: the bank stays empty and the synth
   *  keeps playing. A missing manifest is the NORMAL state, not an error, so it
   *  is reported at `debug` level and never thrown. */
  /** Fetch one clip, trying again on a dropped connection. The bank asks for
   *  every clip at once — 371 of them — and a local server can drop one of
   *  that many: "Failed to fetch" on a file that is there, and that clip was
   *  silently missing from its bank until the next reload. */
  function fetchClip(url, tries) {
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
      .catch(function (e) {
        if (!(tries > 0)) throw e;
        return new Promise(function (res) { setTimeout(res, 250); })
          .then(function () { return fetchClip(url, tries - 1); });
      });
  }

  function loadManifest(base) {
    if (!A.ready || A.manifestState === 'loading' || A.manifestState === 'loaded') return Promise.resolve(A.manifestState);
    base = (base || 'assets/audio').replace(/\/$/, '');
    if (typeof fetch !== 'function' || location.protocol === 'file:') {
      // `file://` blocks XHR/fetch for local files in every current browser.
      // Say so once, clearly, rather than emitting a CORS error per clip.
      A.manifestState = 'absent';
      console.debug('[audio] running from file:// — sample bank unavailable, using synthesis. ' +
                    'Serve the folder over HTTP to enable recorded audio.');
      return Promise.resolve(A.manifestState);
    }
    A.manifestState = 'loading';
    return fetch(base + '/manifest.json')
      .then(function (r) { if (!r.ok) throw new Error('no manifest'); return r.json(); })
      .then(function (man) {
        var clips = man.clips || {};
        (man.full || []).forEach(function (n) { A.full[n] = true; });
        var jobs = [];
        Object.keys(clips).forEach(function (name) {
          var files = clips[name];
          if (!Array.isArray(files)) files = [files];
          A.wanted += files.length;
          files.forEach(function (f) {
            jobs.push(fetchClip(base + '/' + f, 2)
              .then(function (buf) {
                return new Promise(function (res, rej) {
                  // The callback form, because Safari's promise-returning
                  // decodeAudioData arrived late and this has to work there.
                  A.ctx.decodeAudioData(buf, res, rej);
                });
              })
              .then(function (audio) {
                (A.banks[name] || (A.banks[name] = [])).push(audio);
                A.loaded++;
              })
              .catch(function (e) { console.debug('[audio] skipped', f, e.message); }));
          });
        });
        return Promise.all(jobs);
      })
      .then(function () {
        A.manifestState = 'loaded';
        console.debug('[audio] sample bank: ' + A.loaded + '/' + A.wanted + ' clips over ' +
                      Object.keys(A.banks).length + ' names');
        return A.manifestState;
      })
      .catch(function () {
        A.manifestState = 'absent';
        console.debug('[audio] no assets/audio/manifest.json — using synthesis (this is fine)');
        return A.manifestState;
      });
  }

  function has(name) { var b = A.banks[name]; return !!(b && b.length); }

  /** Is the clip `name` would play a FULL-RANGE recording — one with its own
   *  bottom octave? The film-sourced banks are not, and the game layers a
   *  synthesised body under them; under a modern recording that is mud. */
  function full(name) { var k = resolve(name); return !!(k && A.full[k]); }

  /**
   * RESOLVE A NAME DOWN A FALLBACK CHAIN.
   *
   * The game asks for the most specific thing it knows — `rifle.k98`, not
   * `rifle` — and this walks back towards the general until it finds something
   * the bank actually has:
   *
   *     rifle.k98.tail  →  rifle.k98  →  rifle.tail  →  rifle
   *
   * That is what makes a sample bank worth building incrementally. Drop in six
   * recordings of a Kar 98k and every German rifleman on the map is firing a
   * Kar 98k; drop in nothing and the Mauser, the Garand and the Mosin all fall
   * back to the same `rifle` clips, or to the synth, and nothing breaks. It is
   * also why the manifest can name a hundred weapons without anybody having to
   * record a hundred weapons.
   */
  function resolve(name) {
    if (has(name)) return name;
    var parts = String(name).split('.');
    if (parts.length < 2) return null;
    var base = parts[0];
    // A trailing variant tag survives the walk back: the family's own tail is
    // a better answer than the family's own shot.
    if (parts.length > 2 && has(base + '.' + parts[parts.length - 1])) {
      return base + '.' + parts[parts.length - 1];
    }
    return has(base) ? base : null;
  }

  /** Play a sampled clip through a caller-supplied positional bus.
   *  `p` is the game's `_place()` result: { gain, pan, lp, t, d }.
   *  `dest` is the game's `_bus(p, wet)` node.
   *
   *  RETURNS HOW LONG THE CLIP WILL SOUND FOR, in seconds, or false. It used to
   *  return `true`, and the caller had no way to know — so `SFX._sample` could
   *  not push out the bus's death time the way `_osc`, `_noise` and `_voice`
   *  all do, and `SFX._sweepBuses` disconnected the chain 0.6 s after the sound
   *  started. Every recording longer than that was CUT OFF: a 2.6 s explosion
   *  played for six hundred milliseconds. Still truthy, so old call sites are
   *  unaffected. */
  function play(name, p, dest, o) {
    if (!A.ready) return false;
    var key = resolve(name);
    if (!key) return false;
    o = o || {};
    name = key;
    var bank = A.banks[name];
    // Round-robin, not random: three shots in a row must not be the same clip,
    // which is the tell that gives a sample bank away instantly.
    var i = (A.rr[name] = ((A.rr[name] || 0) + 1) % bank.length);
    var src = A.ctx.createBufferSource();
    src.buffer = bank[i];
    // Per-shot pitch variation does most of the work of making a bank of three
    // clips sound like an inexhaustible supply.
    src.playbackRate.value = (o.rate || 1) * rnd(1 - (o.detune === undefined ? 0.06 : o.detune),
                                                 1 + (o.detune === undefined ? 0.06 : o.detune));
    var g = A.ctx.createGain();
    g.gain.value = o.gain === undefined ? 1 : o.gain;
    src.connect(g).connect(dest || A.master);
    var t = (p && p.t) || A.ctx.currentTime;
    src.start(t + (o.delay || 0));
    return src.buffer.duration / Math.max(0.01, src.playbackRate.value);
  }

  // =========================================================================
  // 2. THE VOICE
  // =========================================================================
  // Speech is a buzz (the vocal folds) shaped by resonances (the tract). Model
  // exactly that: a sawtooth glottal source at the fundamental, through three
  // parallel bandpass "formants", plus a breath/strain noise layer. Choosing
  // the formant triple picks the vowel; the pitch contour and the noise level
  // pick the emotion. Nothing here needs a sample and it lands somewhere no
  // amount of filtered white noise ever gets to.

  // Formant frequencies (Hz) for a male voice, F1/F2/F3 per vowel.
  var VOWEL = {
    a:  [730, 1090, 2440],    // "arh" — the open, involuntary one
    ah: [640, 1190, 2390],
    o:  [570, 840, 2410],     // "oh"
    u:  [300, 870, 2240],     // a groan
    // 'e' [530,1840,2480] and 'ee' [270,2290,3010] used to live here. They are
    // the FRONT vowels, and a front vowel next to a back one is a diphthong,
    // and a diphthong is a word. They went out with the vowel sweep below.
  };

  // `v` used to be a SEQUENCE the formants swept through — 'a'→'ee'→'a' for a
  // scream, 'ee'→'a' for panic. That is the textbook way to synthesise a
  // diphthong, and a diphthong is heard as a word: a squad under fire came out
  // as a field full of men muttering something just out of earshot.
  //
  // It is now a set of ALTERNATIVES and the soldier's seed picks ONE, held for
  // the length of the cry. Two men cry differently and neither of them says
  // anything. What carries the pain instead is `crack` — the register break at
  // the top of a scream, where the voice slips into falsetto for a few
  // milliseconds. It is the single most recognisable thing about a man
  // screaming and the old synth did not have it at all.
  //
  // 'shout', 'charge' and 'panic' are gone with their callers. Nothing in this
  // game makes a man open his mouth except being hit.
  var CRIES = {
    // kind:     [vowels],        f0,   dur,    contour,  strain, gain,  crack
    hit:      { v: ['a', 'ah'],  f0: 150, dur: 0.44, up: -0.30, strain: 0.55, gain: 0.90, crack: 0 },
    agony:    { v: ['a', 'ah'],  f0: 205, dur: 1.20, up: 0.18,  strain: 0.85, gain: 1.00, crack: 0.60 },
    death:    { v: ['ah', 'o'],  f0: 128, dur: 1.40, up: -0.62, strain: 0.62, gain: 0.95, crack: 0.25 },
    groan:    { v: ['u', 'o'],   f0: 104, dur: 1.30, up: -0.22, strain: 0.34, gain: 0.55, crack: 0 },
  };

  /** A man's voice. `p` is the positional record, `dest` the positional bus.
   *  `seed` should be stable per soldier so the same man always sounds the
   *  same — a squad of identical voices is worse than no voices. */
  function voice(kind, p, dest, seed, noiseBuf) {
    if (!A.ready) return false;
    var C = CRIES[kind] || CRIES.hit;
    var ctx = A.ctx, t0 = (p && p.t) || ctx.currentTime;
    // Vocal-tract length varies about 12% between men; that is roughly a
    // major second of formant shift and is what makes voices individual.
    var s = (Math.sin((seed || 0) * 12.9898) * 43758.5453) % 1;
    s = s - Math.floor(s);
    var tract = 0.88 + s * 0.26;
    var f0 = C.f0 * (0.9 + s * 0.22);
    var dur = C.dur * (0.86 + crand() * 0.3);
    var out = ctx.createGain();
    out.gain.value = (C.gain || 1) * 0.5;
    out.connect(dest || A.master);

    // -- the glottal source: a sawtooth with a pitch contour ----------------
    var src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 0.82, t0);
    src.frequency.linearRampToValueAtTime(f0 * (1 + C.up * 0.55), t0 + dur * 0.18);
    var held = t0 + dur * 0.55;
    if (C.crack) {
      // THE REGISTER BREAK. A man screaming pushes the voice past what the
      // chest register will carry and it snaps up into falsetto for a few
      // milliseconds before it catches. Model it literally: ramp up to the
      // ceiling, jump, slide back down.
      var tc = t0 + dur * (0.28 + rnd(0, 0.10));
      src.frequency.linearRampToValueAtTime(f0 * (1 + C.up), tc);
      src.frequency.setValueAtTime(f0 * (1 + C.up) * (1.4 + C.crack * 0.55), tc + 0.014);
      held = Math.max(held, tc + dur * 0.26);
    }
    src.frequency.linearRampToValueAtTime(f0 * (1 + C.up), held);
    src.frequency.exponentialRampToValueAtTime(Math.max(45, f0 * (1 + C.up) * 0.55), t0 + dur);
    // Vibrato: a held scream wavers. Without it this sounds like a synthesiser.
    var lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = rnd(4.6, 7.2);
    lfoG.gain.value = f0 * (0.02 + C.strain * 0.05);
    lfo.connect(lfoG).connect(src.frequency);

    // -- the amplitude envelope: hard onset, held, collapse -----------------
    var vg = ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t0);
    vg.gain.linearRampToValueAtTime(1, t0 + 0.035);
    vg.gain.setValueAtTime(1, t0 + dur * 0.45);
    vg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(vg);

    // -- strain noise: the rasp of a voice pushed past its limit ------------
    if (noiseBuf && C.strain > 0) {
      var ns = ctx.createBufferSource();
      ns.buffer = noiseBuf; ns.loop = true;
      var nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 1500 * tract; nf.Q.value = 0.8;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.linearRampToValueAtTime(C.strain * 0.5, t0 + 0.05);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      ns.connect(nf).connect(ng).connect(vg);
      ns.start(t0); ns.stop(t0 + dur + 0.05);
    }

    // -- three formants, HELD on one vowel ---------------------------------
    // ONE vowel, held, chosen by the man's own seed — see the note on CRIES.
    var vw = C.v[Math.min(C.v.length - 1, Math.floor(s * C.v.length))];
    for (var k = 0; k < 3; k++) {
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = k === 0 ? 7 : (k === 1 ? 9 : 11);
      bp.frequency.value = VOWEL[vw][k] * tract;
      var fg = ctx.createGain();
      fg.gain.value = k === 0 ? 1 : (k === 1 ? 0.5 : 0.22);   // higher formants are quieter
      vg.connect(bp).connect(fg).connect(out);
    }
    // A little of the raw source through, or it sounds like a vocoder.
    var dry = ctx.createGain(); dry.gain.value = 0.14;
    vg.connect(dry).connect(out);

    src.start(t0); src.stop(t0 + dur + 0.08);
    lfo.start(t0); lfo.stop(t0 + dur + 0.08);
    return true;
  }

  // =========================================================================
  // 3. ENGINE LOOPS
  // =========================================================================
  // One record per vehicle, created on demand and torn down when it dies. The
  // game drives `throttle` (0 idle .. 1 flat out) and a world position; this
  // owns the sound. A sampled loop is used when the bank has one, otherwise
  // everything is synthesised.

  var ENGINE = {
    tank:      { cyl: 12, idle: 9.5,  rev: 22,  rumble: 46,  clank: 1.00, gain: 0.55 },
    halftrack: { cyl: 6,  idle: 12,   rev: 30,  rumble: 62,  clank: 0.70, gain: 0.42 },
    truck:     { cyl: 6,  idle: 11,   rev: 28,  rumble: 66,  clank: 0.00, gain: 0.34 },
    light:     { cyl: 8,  idle: 12.5, rev: 34,  rumble: 72,  clank: 0.55, gain: 0.38 },
  };

  /** Start (or fetch) a vehicle's engine loop. `id` is any stable key. */
  function engineStart(id, kind, noiseBuf) {
    if (!A.ready) return null;
    if (A.loops[id]) return A.loops[id];
    var ctx = A.ctx, E = ENGINE[kind] || ENGINE.tank;
    var rec = { id: id, E: E, nodes: [], out: null, sampled: false };
    var out = ctx.createGain(); out.gain.value = 0;
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 0.5;
    out.connect(lp);
    if (pan) { lp.connect(pan); pan.connect(A.master); } else lp.connect(A.master);
    rec.out = out; rec.pan = pan; rec.lp = lp;

    var sampleName = 'engine.' + kind;
    if (has(sampleName)) {
      var src = ctx.createBufferSource();
      src.buffer = A.banks[sampleName][0];
      src.loop = true;
      src.playbackRate.value = 1;
      src.connect(out); src.start();
      rec.src = src; rec.sampled = true;
    } else {
      // Firing frequency: a 12-cylinder four-stroke fires 6 times per
      // revolution, so the "note" you hear is well below the crank speed.
      // Idle sits around 9-12 Hz — you feel it more than hear it, which is
      // exactly right for a tank.
      var fire = ctx.createOscillator(); fire.type = 'sawtooth';
      fire.frequency.value = E.idle * (E.cyl / 2);
      var fireG = ctx.createGain(); fireG.gain.value = 0.5;
      var fireF = ctx.createBiquadFilter(); fireF.type = 'lowpass'; fireF.frequency.value = 340; fireF.Q.value = 6;
      fire.connect(fireG).connect(fireF).connect(out);
      // A second, detuned bank: a big engine is never in phase with itself.
      var fire2 = ctx.createOscillator(); fire2.type = 'square';
      fire2.frequency.value = E.idle * (E.cyl / 2) * 1.007;
      var fire2G = ctx.createGain(); fire2G.gain.value = 0.22;
      fire2.connect(fire2G).connect(fireF);
      // The rumble bed: filtered noise under everything.
      var rum = null;
      if (noiseBuf) {
        rum = ctx.createBufferSource(); rum.buffer = noiseBuf; rum.loop = true;
        var rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = E.rumble; rf.Q.value = 2.2;
        var rg = ctx.createGain(); rg.gain.value = 1.5;
        rum.connect(rf).connect(rg).connect(out);
        rec.rumF = rf;
        rum.start();
      }
      fire.start(); fire2.start();
      rec.fire = fire; rec.fire2 = fire2; rec.rum = rum;
    }
    A.loops[id] = rec;
    return rec;
  }

  /** Per-frame: where the vehicle is, and how hard it is working. */
  function engineUpdate(id, o) {
    var rec = A.loops[id];
    if (!rec) return;
    var E = rec.E, th = Math.max(0, Math.min(1, o.throttle || 0));
    var g = (o.gain === undefined ? 1 : o.gain) * E.gain * (0.55 + th * 0.65);
    var now = A.ctx.currentTime;
    rec.out.gain.setTargetAtTime(g, now, 0.09);
    if (rec.pan) rec.pan.pan.setTargetAtTime(o.pan || 0, now, 0.08);
    if (rec.lp) rec.lp.frequency.setTargetAtTime(Math.max(180, o.lp === undefined ? 1200 : o.lp), now, 0.1);
    var rpm = E.idle + (E.rev - E.idle) * th;
    if (rec.sampled) {
      rec.src.playbackRate.setTargetAtTime(0.72 + th * 0.62, now, 0.14);
    } else {
      rec.fire.frequency.setTargetAtTime(rpm * (E.cyl / 2), now, 0.15);
      rec.fire2.frequency.setTargetAtTime(rpm * (E.cyl / 2) * 1.007, now, 0.15);
      if (rec.rumF) rec.rumF.frequency.setTargetAtTime(E.rumble * (0.8 + th * 0.7), now, 0.15);
    }
  }

  function engineStop(id) {
    var rec = A.loops[id];
    if (!rec) return;
    var now = A.ctx.currentTime;
    rec.out.gain.cancelScheduledValues(now);
    rec.out.gain.setTargetAtTime(0, now, 0.12);
    setTimeout(function () {
      try {
        if (rec.src) rec.src.stop();
        if (rec.fire) rec.fire.stop();
        if (rec.fire2) rec.fire2.stop();
        if (rec.rum) rec.rum.stop();
        rec.out.disconnect();
      } catch (e) { /* already gone */ }
    }, 500);
    delete A.loops[id];
  }

  function stopAllLoops() { Object.keys(A.loops).forEach(engineStop); Object.keys(A.beds).forEach(bedStop); }

  // =========================================================================
  // 4. AMBIENCE BEDS
  // =========================================================================
  // A looping bank clip at a settable gain, straight to master — no position,
  // because a field of birds is not in one place. This is what replaced the
  // game's tension drone: a 41 Hz sine pair that swelled as the fighting
  // closed in. What a Normandy field actually does is go QUIET — the birds
  // stop, and the silence is the tension. That is documented in every account
  // of the fighting and it is a better mechanic than a sub-bass hum.

  /** Start a named bed if the bank has it. Returns true if it is playing. */
  function bedStart(id, name) {
    if (!A.ready) return false;
    if (A.beds[id]) return true;
    if (!has(name)) return false;
    var bank = A.banks[name];
    var src = A.ctx.createBufferSource();
    src.buffer = bank[(crand() * bank.length) | 0];
    src.loop = true;
    // A field recording loops badly at its own length; detuning each start
    // keeps two maps from sounding like the same tape.
    src.playbackRate.value = rnd(0.94, 1.06);
    var g = A.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(A.master);
    src.start(A.ctx.currentTime + crand() * 0.5);
    A.beds[id] = { src: src, gain: g };
    return true;
  }
  /** Fade a bed toward `v` over `tau` seconds (default a slow 2 s). */
  function bedGain(id, v, tau) {
    var b = A.beds[id];
    if (!b) return;
    b.gain.gain.setTargetAtTime(Math.max(0, v), A.ctx.currentTime, tau || 2);
  }
  function bedStop(id) {
    var b = A.beds[id];
    if (!b) return;
    b.gain.gain.setTargetAtTime(0, A.ctx.currentTime, 0.4);
    setTimeout(function () { try { b.src.stop(); b.gain.disconnect(); } catch (e) {} }, 1500);
    delete A.beds[id];
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================
  window.WarAudio = {
    VERSION: VERSION,
    install: install,
    loadManifest: loadManifest,
    state: function () { return A.manifestState; },
    count: function () { return A.loaded; },
    has: has,
    full: full,
    resolve: resolve,
    play: play,
    voice: voice,
    CRIES: CRIES,
    bedStart: bedStart,
    bedGain: bedGain,
    bedStop: bedStop,
    engineStart: engineStart,
    engineUpdate: engineUpdate,
    engineStop: engineStop,
    stopAllLoops: stopAllLoops,
  };
})();
