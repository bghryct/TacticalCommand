/* ===========================================================================
 * assets/bridges120.js — round 120: BRIDGES (`game.bridges120`, default OFF).
 *
 * The owner: "I want bridges." Until now every bridge in the game was a strip of road painted across a river: the
 * river stopped on both sides of an earth dam 78-138 m wide (census: .claude/wip120/bridges/NOTES.md). This file
 * makes a bridge a bridge:
 *
 *   THE SIMULATION (only with the switch on, and only on a map that has one):
 *   - a bridge is a DECK: the cells of its span carry men and vehicles over the water at the deck's height (the
 *     cells keep the deck in `Terrain.h`, as every system already reads it; `Terrain.heightAt` on a deck cell is the
 *     deck along the bridge and level across it, so a man at the parapet stands on the deck, not on a slope);
 *   - a WEIGHT CLASS per kind (`KINDS.cls`): a timber trestle carries men, guns and vehicles to 9 t, a Bailey and a
 *     pontoon bridge to 40 t, masonry, steel and a culvert everything. The search refuses a deck cell to a vehicle
 *     heavier than it (`Pathfinder.passable`, and the module's `passable0` the same way: `DECK`, `set_wcls`);
 *   - PARAPETS: a man on a deck's edge cell is covered from fire across that edge (`coverAt`, read by
 *     `Unit._coverValueCalc`), by what the kind has there (a masonry parapet, a lattice railing, a rope);
 *   - on the named maps the strip is cut back to a real deck (`SITES`): the rest of it is river again, at the bed.
 *   THE DRAWING: the kit (tools/blender/bridge_kit.py -> assets/bridges120.pack.js, loaded on first use) laid along
 *   the deck, bent to the deck's own heights; the ground under the span drawn at the bed and the water drawn over it
 *   (`Terrain._drawH120`, `_wet120`: drawing only — the simulation never reads them).
 *   THE EDITOR: drag across water with a kind's tool; the bridge fits the span, writes its deck and ramps, and is
 *   saved with the map (`bridges120`); undo is the editor's own snapshot.
 *
 * OFF (`game.bridges120` false) is the old game exactly: no layer, no map edit, no drawing, no key saved.
 * ======================================================================== */
(function () {
  'use strict';

  /** The kinds. `cls`: the heaviest weight class the deck carries (1 men, guns and vehicles to 9 t; 2 to 40 t;
   *  3 everything). `cells`: the deck's width in cells (6 m each). `cover`: what its parapet gives a man on the edge
   *  cell against fire across it. `clear`: the least height of the deck over the water, in height units (3 m), for a
   *  bridge laid in the editor; `float`: it lies on the water (pontoons). `max`: the longest gap it is laid across. */
  var KINDS = {
    arch:    { name: 'Stone arch',     cls: 3, cells: 2, cover: 0.55, clear: 1.0, max: 40,  surf: 'cobble', color: 0x9c9384 },
    girder:  { name: 'Steel girder',   cls: 3, cells: 2, cover: 0.25, clear: 0.9, max: 60,  surf: 'road',   color: 0x55605a },
    truss:   { name: 'Steel truss',    cls: 3, cells: 2, cover: 0.25, clear: 1.0, max: 140, surf: 'road',   color: 0x4d5a55 },
    bailey:  { name: 'Bailey bridge',  cls: 2, cells: 1, cover: 0.20, clear: 0.4, max: 40,  surf: 'road',   color: 0x5b6150 },
    pontoon: { name: 'Pontoon bridge', cls: 2, cells: 1, cover: 0.05, float: true, max: 120, surf: 'road', color: 0x6a5a44 },
    trestle: { name: 'Timber trestle', cls: 1, cells: 1, cover: 0.10, clear: 0.4, max: 30,  surf: 'dirttrack', color: 0x7a6040 },
    culvert: { name: 'Culvert',        cls: 3, cells: 2, cover: 0.40, clear: 0.35, max: 20, surf: 'road',   color: 0x7d7a72 },
  };
  var CLASS_NAME = ['', 'men and vehicles to 9 t', 'to 40 t', 'anything'];
  var TON_LIGHT = 9, TON_MED = 40;
  /** COMBAT WEIGHTS, tonnes (period figures, rounded). A type not here is estimated from its kind and hp (`tons`). */
  var TONS = {
    usjeep: 1.1, ukjeep: 1.1, frjeep: 1.1, carrier: 3.8, gertruck: 5.0, ukdingo: 2.8, frue: 2.6, gerflakpz1: 6.0,
    usm3a1sc: 5.6, frm3a1sc: 5.6, frlorraine: 6.0, ustruck: 7.0, frtruck: 7.0, usm15: 9.1, gerflakpz38t: 9.8, m16aa: 8.6,
    usm20: 6.8, frm20: 6.8, gerhalftrack: 8.5, ushalftrack: 9.3, lvt4: 16.5, frhalftrack: 9.3, ukhalftrack: 9.3,
    kangaroo: 29, wirbelwind: 22, gerostwind: 25, katyusha: 7.2, gerbison: 11.5, gergrille: 11.5, wespe: 11, m7priest: 22.9,
    ukpriest: 22.9, frm7: 22.9, sexton: 25.9, m12gmc: 26.6, ukbishop: 17.5, gerhummel: 24, uscalliope: 34, wasp: 4.2,
    uszippo: 32, crocodile: 46, goliath: 0.4, sdkfz222: 4.8, gerpzjg1: 6.4, frlaffly: 7.0, sovt40: 5.5, usm3gmc: 9.0,
    gerpz1: 5.4, sovt60: 5.8, m8: 7.9, marder: 10.7, framr35: 5.0, frm8: 7.9, geraufkl38t: 9.8, ukhumber: 7.1, puma: 11.7,
    daimler: 7.5, germarder2: 10.8, uktetrarch: 7.6, uklocust: 7.4, frpanhard: 8.2, stummel: 8.5, gerpz2: 9.5, sovt26: 9.6,
    sovt70: 9.2, stuart: 15.4, frm5a1: 15.4, ukstuart: 15.4, gerpz38t: 9.7, gerpz35t: 10.5, ukarcher: 15, frr35: 10.6,
    usm8hmc: 15.7, frm8hmc: 15.7, sovbt2: 11, su76: 10.6, frh35: 11, sovbt5: 11.5, frfcm36: 12.4, uslvta4: 18, jpchiha: 15,
    ukstaghound: 13.9, sovt50: 14, sovbt7: 13.9, nashorn: 24, frh39: 12, itm1340: 14, jpshinhoto: 15.8, gerdickermax: 22,
    hellcat: 17.7, itsemovente: 13.1, ukvalentine: 16.5, achilles: 29.6, usm24: 18.4, m10: 29.6, frm10: 29.6, ukm10: 29.6,
    frd2: 19.8, gerpz3f: 20, hetzer: 15.8, ukcrusader: 20, gerstugb: 20, gerpz4e: 21, panzer3: 23, usm36: 29, m3lee: 27,
    ukgrant: 27, gerstug4: 23, frsomua: 19.5, gerstuh42: 24, ukmatilda: 26.9, sovt28: 28, ddsherman: 31, stug: 23.9,
    gersturer: 35, ukcentaur: 28, jagdpz4: 25.8, sovsu85: 29.6, sherman: 30.3, panzer4: 25, cromwell: 27.9, su100: 31.6,
    t3476: 28.5, sherman105: 31, frm4a2: 31, uksherman: 31, sherman76: 32, sovsu122: 30.9, sovt44: 31.8, sovkv13: 31,
    crab: 32, brummbar: 28.2, ukcomet: 32.7, ukchallenger: 32.5, usm4a3e8: 33.7, sovt43: 34, firefly: 34.8, t3485: 32,
    kv1: 45, ukchurchill3: 39, frb1bis: 31.5, sovkv1s: 42.5, panther: 44.8, jumbo: 38, sovis1: 44, jagdpanther: 45.5,
    isu152: 46, sovsu152: 45.5, sovisu122: 46, ust26e4: 47, sovkv85: 46, sovisu122s: 46, sovisu1522: 46, sovis3: 46.5,
    pershing: 41.9, gerpanther2: 50, avre: 38, sovt35: 45, is2: 46, sovkv2: 52, sovsmk: 55, tiger: 57, gertigerp: 57,
    churchill: 40.7, gere50: 50, sovkv220: 63, sovsu100y: 64, gerelefant: 65, gersturmtiger: 65, sovkv3: 68,
    gerjagdtiger: 71.7, gere75: 75, kingtiger: 69.8, gerloewe: 76, sovkv5: 100, gere100: 140, germaus: 188,
  };

  /** THE NAMED BRIDGES, where the maps already have them (their strips): the kind, the crossing's centre (fractions
   *  of the field), the axis the road runs along, and the deck's cells across (`c`, fractions, as the map's road). */
  var SITES = {
    'Pegasus Bridge': [
      { kind: 'girder', at: [0.36, 0.50], ax: 'x', cells: [0, 1] },   // Bénouville: a steel bascule over the Caen canal
      { kind: 'truss',  at: [0.52, 0.50], ax: 'x', cells: [0, 1] },   // Ranville: the Orne bridge
    ],
    'Arnhem Bridge': [{ kind: 'truss', at: [0.50, 0.70], ax: 'z', cells: [-1, 1] }],
    'Remagen — the Ludendorff Bridge': [{ kind: 'truss', at: [0.50, 0.50], ax: 'x', cells: [-1, 1] }],
    'Son Bridge': [{ kind: 'girder', at: [0.50, 0.50], ax: 'z', cells: [-1, 1] }],
    'Purple Heart Lane': [
      { kind: 'culvert', at: [null, 0.22], ax: 'z', road: 'phl', cells: [-1, 1] },
      { kind: 'culvert', at: [null, 0.44], ax: 'z', road: 'phl', cells: [-1, 1] },
      { kind: 'culvert', at: [null, 0.63], ax: 'z', road: 'phl', cells: [-1, 1] },
      { kind: 'culvert', at: [null, 0.83], ax: 'z', road: 'phl', cells: [-1, 1] },
    ],
    'Vierzon Crossroads': [{ kind: 'arch', at: [0.50, null], ax: 'z', road: 'ford', cells: [0, 1] }],
  };

  var EDGE_N = 1, EDGE_E = 2, EDGE_S = 4, EDGE_W = 8;
  var STEP = 0.85;          // the most a ramp rises a cell (height units): wheels climb 1.0, a tank 1.15

  var B = window.Bridges120 = {
    KINDS: KINDS, TONS: TONS, SITES: SITES, CLASS_NAME: CLASS_NAME,
    /** THE DEFAULT: `game.bridges120` set either way wins (the prototype carries it). */
    ON: false,
    list: [], any: false,
    cap: null, bid: null, par: null, axl: null, drawH: null, wet: null,
    pick: [], _meshes: [], _drawn: false, _err: null,
    stats: { applied: 0, narrowed: 0, drawn: 0, tris: 0, draws: 0, ms: 0 },

    on: function (g) { return !!(g && g.bridges120 === true); },

    /** A unit's weight class: 0 a man or a gun his crew moves (every deck takes him), 1-3 a vehicle by its tonnes. */
    tons: function (def, key) {
      if (!def) return 0;
      if (key && TONS[key] != null) return TONS[key];
      if (!def.vehicle) return 0;
      var hp = def.hp || 200, k = def.kind;
      if (k === 'apc' || k === 'artillery') return hp <= 160 ? 6 : 20;
      return hp < 240 ? 8 : hp < 640 ? 30 : 50;
    },
    clsOf: function (def, key) {
      if (!def || !def.vehicle) return 0;
      var t = this.tons(def, key);
      return t <= TON_LIGHT ? 1 : t <= TON_MED ? 2 : 3;
    },

    // ---------------------------------------------------------------- the layers
    _ensure: function (g) {
      var N = GRID * GRID;
      if (!this.cap || this.cap.length !== N) {
        var W = window.WasmPath;
        // the deck's class lives where the WebAssembly search reads it (slot DECK), when the module has one
        this.cap = (W && W.ready && W.exports && W.exports.ptr_DECK && W.slot && W.slot('DECK', N)) || new Uint8Array(N);
        this.bid = new Int16Array(N); this.par = new Uint8Array(N); this.axl = new Uint8Array(N);
        this.drawH = new Float32Array(N); this.drawH.fill(NaN); this.wet = new Uint8Array(N);
      }
    },
    /** Every map load starts here (and `load(null)`): no bridge of the last map, no layer, no drawing. */
    clear: function (g) {
      this.syncUi(g);
      this._undraw(g);
      this.list.length = 0; this.any = false;
      if (this.cap) { this.cap.fill(0); this.bid.fill(0); this.par.fill(0); this.axl.fill(0); this.drawH.fill(NaN); this.wet.fill(0); }
      var T = g && g.terrain;
      if (T) { T._deck120 = null; T._drawH120 = null; T._wet120 = null; }
      if (g && g.pathfinder) g.pathfinder.deck120 = null;
    },

    /** The Props panel's bridge tools, shown only with the switch on (the panel is built once, at boot). */
    syncUi: function (g) {
      if (typeof document === 'undefined' || !document.querySelectorAll) return;
      var on = this.on(g), bs = document.querySelectorAll('[data-tool^="bridge120:"]');
      for (var i = 0; i < bs.length; i++) bs[i].style.display = on ? '' : 'none';
    },

    // ---------------------------------------------------------------- the map
    /** loadMap, after the map's terrain and before its roads are graded: the named bridges of a map built by code
     *  (a saved map carries its own, read by `load`). */
    atLoad: function (g, map, dataMap) {
      if (!this.on(g) || dataMap || !map) return;
      var sites = SITES[map.name];
      if (!sites) return;
      var t0 = performance.now();
      for (var i = 0; i < sites.length; i++) {
        var rec = this.fitSite(g, sites[i]);
        if (!rec || rec.err) { console.warn('bridges120: ' + map.name + ' site ' + i + ': ' + (rec ? rec.err : 'no crossing')); continue; }
        this.apply(g, rec, false);
      }
      this.stats.ms = performance.now() - t0;
    },
    /** loadMap, after the water's level is set and the rivers are scoured: the bed drawn under each span from the
     *  river beside it. Drawing only. */
    afterWater: function (g) {
      if (!this.list.length) return;
      for (var i = 0; i < this.list.length; i++) this._bedOf(g, this.list[i]);
      if (this._drawn) this._applyDrawn(g);
    },

    _cellIdx: function (rec, a, c) { return rec.ax === 'x' ? c * GRID + a : a * GRID + c; },
    _water: function (T, i) { return T.type[i] === TYPE.water; },

    /** A named site -> a bridge record over the strip the map painted. */
    fitSite: function (g, s) {
      var T = g.terrain, G = GRID, K = KINDS[s.kind];
      if (!T || !K) return { err: 'no terrain or kind' };
      var ax = s.ax, self = this;
      var idx = function (a, c) { return ax === 'x' ? c * G + a : a * G + c; };
      var A, C;
      if (s.road === 'phl') {
        // Purple Heart Lane's causeway meanders: x = road + sin(z * 0.014) * m(5) (the map's own formula)
        A = Math.round(G * s.at[1]);
        var road = Math.round(G * 0.5), m5 = Math.round(5 * MAPSCALE);
        C = road + Math.round(Math.sin(A * 0.014) * m5);
      } else if (s.road === 'ford') {
        // Vierzon: the river helper's ford at x = 0.50, the road painted over it 17 cells wide; the bridge crosses where
        // the river runs on either side of that strip (the first column out from it with water in the field's middle)
        C = Math.round(G * s.at[0]);
        var runZ = function (x) {
          for (var z = Math.round(G * 0.3); z < Math.round(G * 0.7); z++) if (T.type[z * G + x] === TYPE.water) {
            var z1 = z; while (z1 + 1 < G && T.type[(z1 + 1) * G + x] === TYPE.water) z1++; return (z + z1) / 2;
          }
          return null;
        };
        var xl = C, xr = C, zl = null, zr = null;
        while (xl > C - 40 && (zl = runZ(xl)) === null) xl--;
        while (xr < C + 40 && (zr = runZ(xr)) === null) xr++;
        if (zl === null && zr === null) return { err: 'no river beside the ford' };
        A = Math.round(zl === null ? zr : zr === null ? zl : (zl + zr) / 2);
      } else {
        A = Math.round(G * (ax === 'x' ? s.at[0] : s.at[1]));
        C = Math.round(G * (ax === 'x' ? s.at[1] : s.at[0]));
      }
      if (this._water(T, idx(A, C))) return { err: 'the crossing centre is in the water' };
      // the strip across, at the crossing's centre
      var lo = C, hi = C;
      while (lo > 1 && !this._water(T, idx(A, lo - 1)) && C - lo < 80) lo--;
      while (hi < G - 2 && !this._water(T, idx(A, hi + 1)) && hi - C < 80) hi++;
      // the river along the axis, in the columns just outside the strip
      var run = function (c) {
        if (c < 0 || c >= G || !self._water(T, idx(A, c))) return null;
        var a0 = A, a1 = A;
        while (a0 > 0 && self._water(T, idx(a0 - 1, c))) a0--;
        while (a1 < G - 1 && self._water(T, idx(a1 + 1, c))) a1++;
        return [a0, a1];
      };
      // the river on each side: several columns out, because a town's street painted into the river beside the strip
      // cuts one column's run short (Remagen) — each side's widest run
      var side = function (sg) {
        var q = null;
        for (var dd = 1; dd <= 12; dd++) { var r = run(sg < 0 ? lo - dd : hi + dd); if (r) q = q ? [Math.min(q[0], r[0]), Math.max(q[1], r[1])] : r; }
        return q;
      };
      var rl = side(-1), rr = side(1);
      if (!rl && !rr) return { err: 'no water either side of the strip' };
      rl = rl || rr; rr = rr || rl;
      // across the strip the river runs from one side's course to the other's (a meander is not squared off)
      var runAt = function (c) { var t = (c - (lo - 1)) / Math.max(1, (hi + 1) - (lo - 1)); return [Math.round(rl[0] + (rr[0] - rl[0]) * t), Math.round(rl[1] + (rr[1] - rl[1]) * t)]; };
      var c0 = C + s.cells[0], c1 = C + s.cells[1];
      if (c0 < lo || c1 > hi) { c0 = Math.max(c0, lo); c1 = Math.min(c1, hi); }
      var s0 = 1e9, s1 = -1;
      for (var cc = c0; cc <= c1; cc++) { var rc = runAt(cc); s0 = Math.min(s0, rc[0]); s1 = Math.max(s1, rc[1]); }
      var runs = {};
      for (var c2 = lo; c2 <= hi; c2++) runs[c2] = runAt(c2);
      return { kind: s.kind, ax: ax, s0: s0, s1: s1, c0: c0, c1: c1, lo: lo, hi: hi, site: true, runs: runs };
    },

    /** An editor drag (cells) -> a record, or { err }. */
    fitDrag: function (g, gx0, gz0, gx1, gz1, kind) {
      var T = g.terrain, G = GRID, K = KINDS[kind];
      if (!T || !K) return { err: 'Unknown bridge' };
      var ax = Math.abs(gx1 - gx0) >= Math.abs(gz1 - gz0) ? 'x' : 'z';
      var a0 = ax === 'x' ? Math.min(gx0, gx1) : Math.min(gz0, gz1), a1 = ax === 'x' ? Math.max(gx0, gx1) : Math.max(gz0, gz1);
      var C = Math.round(ax === 'x' ? (gz0 + gz1) / 2 : (gx0 + gx1) / 2);
      var idx = function (a, c) { return ax === 'x' ? c * G + a : a * G + c; };
      var s0 = -1, s1 = -1;
      for (var a9 = Math.max(1, a0); a9 <= Math.min(G - 2, a1); a9++) if (this.bid && this.bid[idx(a9, C)]) return { err: 'There is a bridge here already' };
      for (var a = Math.max(1, a0 - 2); a <= Math.min(G - 2, a1 + 2); a++) if (this._water(T, idx(a, C))) { if (s0 < 0) s0 = a; s1 = a; }
      if (s0 < 0) return { err: 'Drag across water: from one bank to the other' };
      if (s0 <= 1 || s1 >= G - 2) return { err: 'A bridge has to land on both banks' };
      if (this._water(T, idx(s0 - 1, C)) || this._water(T, idx(s1 + 1, C))) return { err: 'A bridge has to land on both banks' };
      var n = s1 - s0 + 1;
      if (n * 6 > K.max) return { err: K.name + ' spans at most ' + K.max + ' m; this gap is ' + n * 6 + ' m' };
      var w = K.cells, c0 = C - ((w - 1) >> 1), c1 = c0 + w - 1;
      if (c0 < 1 || c1 > G - 2) return { err: 'Too near the edge of the field' };
      // a bridge does not cross a building or another bridge
      for (var a2 = s0 - 1; a2 <= s1 + 1; a2++) for (var c = c0; c <= c1; c++) {
        var i = idx(a2, c);
        if (this.bid && this.bid[i]) return { err: 'There is a bridge here already' };
        var S = g.structures; if (S && S.has && (ax === 'x' ? S.has(a2, c) : S.has(c, a2))) return { err: 'A building is in the way' };
      }
      return { kind: kind, ax: ax, s0: s0, s1: s1, c0: c0, c1: c1, lo: c0, hi: c1, site: false };
    },

    /** Write the record into the field (narrow a strip / lay a new deck), then register it. */
    apply: function (g, rec, isNew) {
      var T = g.terrain, G = GRID, K = KINDS[rec.kind], self = this;
      this._ensure(g);
      var idx = function (a, c) { return self._cellIdx(rec, a, c); };
      var xz = function (a, c) { return rec.ax === 'x' ? [a, c] : [c, a]; };
      var O = g.obstacles;
      var wl = T.waterY / HSCALE;
      // the bed along the span: the river's own cells beside the deck
      this._bedOf(g, rec);
      if (rec.site) {
        // THE STRIP CUT BACK TO THE DECK: the rest of it over the river is river again, at the bed beside it
        for (var c = rec.lo; c <= rec.hi; c++) {
          if (c >= rec.c0 && c <= rec.c1) continue;
          var rn = rec.runs ? rec.runs[c] : [rec.s0, rec.s1];
          for (var a = rn[0]; a <= rn[1]; a++) {
            var i = idx(a, c);
            if (T.type[i] === TYPE.water) continue;
            var p = xz(a, c);
            if (O && O.at && O.at(p[0], p[1])) O.remove(p[0], p[1]);
            var bi = Math.max(0, Math.min(rec.bed.length - 1, a - rec.s0));
            T.type[i] = TYPE.water; T.h[i] = rec.bed[bi];
            this.stats.narrowed++;
          }
        }
        delete rec.runs;
      } else {
        // A NEW DECK: flat at the kind's height over the banks (a pontoon on the water), ramps within a wheel's climb
        var hA = T.h[idx(rec.s0 - 1, Math.round((rec.c0 + rec.c1) / 2))], hB = T.h[idx(rec.s1 + 1, Math.round((rec.c0 + rec.c1) / 2))];
        var deck = K.float ? wl + 0.25 : Math.max(hA, hB, wl + (K.clear || 0.5));
        var surf = TYPE[K.surf] != null ? TYPE[K.surf] : TYPE.road;
        for (var a1 = rec.s0; a1 <= rec.s1; a1++) {
          var hh = deck;
          if (K.float) hh = Math.max(deck, hA - (a1 - rec.s0 + 1) * STEP, hB - (rec.s1 - a1 + 1) * STEP);
          for (var c1 = rec.c0; c1 <= rec.c1; c1++) { var i1 = idx(a1, c1); T.h[i1] = hh; T.type[i1] = surf; }
        }
        // approach ramps on land where a bank is lower than the deck
        for (var side = -1; side <= 1; side += 2) {
          for (var k = 1; k < 40; k++) {
            var aa = side < 0 ? rec.s0 - k : rec.s1 + k;
            if (aa < 1 || aa > G - 2) break;
            var want = deck - k * STEP, raised = false;
            for (var c2 = rec.c0; c2 <= rec.c1; c2++) {
              var i2 = idx(aa, c2);
              if (T.type[i2] === TYPE.water || T.h[i2] >= want) continue;
              T.h[i2] = want; T.type[i2] = surf; raised = true;
              var p2 = xz(aa, c2); if (O && O.at && O.at(p2[0], p2[1])) O.remove(p2[0], p2[1]);
            }
            if (!raised) break;
          }
        }
        rec.deck = deck;
      }
      this.stats.applied++;
      this.register(g, rec);
      return rec;
    },

    /** The bed under the span (height units, per along-cell): the nearest river cell beside the deck. */
    _bedOf: function (g, rec) {
      var T = g.terrain, self = this, n = rec.s1 - rec.s0 + 1, bed = [];
      for (var a = rec.s0; a <= rec.s1; a++) {
        var best = null;
        for (var d = 1; d <= 40 && best === null; d++) {
          var cl = rec.c0 - d, ch = rec.c1 + d, il = cl >= 0 ? self._cellIdx(rec, a, cl) : -1, ih = ch < GRID ? self._cellIdx(rec, a, ch) : -1;
          var hl = il >= 0 && T.type[il] === TYPE.water ? T.h[il] : null, hh = ih >= 0 && T.type[ih] === TYPE.water ? T.h[ih] : null;
          if (hl !== null || hh !== null) best = hl === null ? hh : hh === null ? hl : Math.min(hl, hh);
        }
        bed.push(best === null ? T.waterY / HSCALE - 1 : best);
      }
      rec.bed = bed; rec.n = n;
    },

    /** The sim's layers for one record, and the record kept. */
    register: function (g, rec) {
      this._ensure(g);
      var K = KINDS[rec.kind], id = this.list.length + 1;
      if (this.list.indexOf(rec) < 0) this.list.push(rec);
      rec.id = this.list.indexOf(rec) + 1;
      var outA = rec.ax === 'x' ? EDGE_N : EDGE_W, outB = rec.ax === 'x' ? EDGE_S : EDGE_E;
      for (var a = rec.s0; a <= rec.s1; a++) for (var c = rec.c0; c <= rec.c1; c++) {
        var i = this._cellIdx(rec, a, c);
        this.cap[i] = K.cls; this.bid[i] = rec.id; this.axl[i] = rec.ax === 'x' ? 1 : 2;
        this.par[i] = (c === rec.c0 ? outA : 0) | (c === rec.c1 ? outB : 0);
      }
      if (!rec.bed) this._bedOf(g, rec);
      this.any = true;
      var T = g.terrain;
      if (T) T._deck120 = this.axl;
      if (g.pathfinder) g.pathfinder.deck120 = this.cap;
      if (g.scene) this._want(g);
      return rec;
    },

    /** The editor: lay a bridge of `kind` across the drag; returns the record or { err }. */
    place: function (g, gx0, gz0, gx1, gz1, kind) {
      if (!this.on(g)) return { err: 'Bridges are off (game.bridges120)' };
      var rec = this.fitDrag(g, gx0, gz0, gx1, gz1, kind);
      if (rec.err) return rec;
      this.apply(g, rec, true);
      var T = g.terrain;
      var x0 = rec.ax === 'x' ? rec.s0 - 40 : rec.c0 - 2, x1 = rec.ax === 'x' ? rec.s1 + 40 : rec.c1 + 2;
      var z0 = rec.ax === 'x' ? rec.c0 - 2 : rec.s0 - 40, z1 = rec.ax === 'x' ? rec.c1 + 2 : rec.s1 + 40;
      for (var z = Math.max(0, z0); z <= Math.min(GRID - 1, z1); z += 4) for (var x = Math.max(0, x0); x <= Math.min(GRID - 1, x1); x += 4) T._touch(x, z, 4);
      T.heightsDirty = T.colorsDirty = true;
      if (g.obstacles && g.obstacles.refreshHeights) g.obstacles.refreshHeights();
      return rec;
    },

    serialize: function () {
      return this.list.map(function (r) {
        return { kind: r.kind, ax: r.ax, s0: r.s0, s1: r.s1, c0: r.c0, c1: r.c1, lo: r.lo, hi: r.hi };
      });
    },
    /** A saved map's bridges (the deck is in the saved heights already): registered, drawn. `off` embeds a smaller
     *  map in a bigger field (Game.load). */
    load: function (g, data, off) {
      this.clear(g);
      if (!data || !data.length || !this.on(g)) return;
      off = off || 0;
      for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!KINDS[d.kind]) continue;
        this.register(g, { kind: d.kind, ax: d.ax === 'z' ? 'z' : 'x', s0: d.s0 + off, s1: d.s1 + off, c0: d.c0 + off, c1: d.c1 + off,
          lo: (d.lo != null ? d.lo : d.c0) + off, hi: (d.hi != null ? d.hi : d.c1) + off, site: false });
      }
    },

    // ---------------------------------------------------------------- the simulation's reads
    /** Terrain.heightAt on a deck cell: the deck along the bridge, level across it. */
    deckHeight: function (T, wx, wz, axl) {
      var gx = Math.floor((wx + HALF) / TILE), gz = Math.floor((wz + HALF) / TILE);
      if (axl === 1) {
        var u = clamp((wx + HALF - TILE / 2) / TILE, 0, GRID - 1.001), ix = Math.floor(u), f = u - ix, r = gz * GRID;
        return (T.h[r + ix] + (T.h[r + ix + 1] - T.h[r + ix]) * f) * HSCALE;
      }
      var v = clamp((wz + HALF - TILE / 2) / TILE, 0, GRID - 1.001), iz = Math.floor(v), fz = v - iz;
      return (T.h[iz * GRID + gx] + (T.h[(iz + 1) * GRID + gx] - T.h[iz * GRID + gx]) * fz) * HSCALE;
    },
    /** A parapet's cover for a man in cell (gx, gz) against fire from (fx, fz) (undirected: half of it). */
    coverAt: function (gx, gz, fx, fz) {
      if (!this.any || gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return 0;
      var i = gz * GRID + gx, p = this.par[i];
      if (!p) return 0;
      var rec = this.list[this.bid[i] - 1], K = rec && KINDS[rec.kind];
      if (!K) return 0;
      if (fx === undefined) return K.cover * 0.5;
      var dx = fx - cellCenter(gx), dz = fz - cellCenter(gz), L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      var best = 0;
      if ((p & EDGE_N) && dz < -0.35) best = Math.max(best, -dz);
      if ((p & EDGE_S) && dz > 0.35) best = Math.max(best, dz);
      if ((p & EDGE_W) && dx < -0.35) best = Math.max(best, -dx);
      if ((p & EDGE_E) && dx > 0.35) best = Math.max(best, dx);
      return best > 0 ? K.cover : 0;
    },
    /** The record whose deck covers cell (gx, gz), or null. */
    at: function (gx, gz) {
      if (!this.any || gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return null;
      var b = this.bid[gz * GRID + gx];
      return b ? this.list[b - 1] || null : null;
    },

    // ---------------------------------------------------------------- the drawing
    _packWait: false,
    _pack: function () {
      if (window.BRIDGES120PACK) return window.BRIDGES120PACK;
      if (!this._packWait && typeof document !== 'undefined' && document.createElement && document.head) {
        this._packWait = true;
        var sc = document.createElement('script'), self = this;
        sc.src = 'assets/bridges120.pack.js';
        sc.onload = function () { if (window.game && self.list.length) self.redraw(window.game); };
        sc.onerror = function () { self._err = 'pack failed to load'; };
        document.head.appendChild(sc);
      }
      return null;
    },
    _want: function (g) {
      var self = this;
      if (this._wantT) return;
      this._wantT = setTimeout(function () { self._wantT = null; if (window.game === g && self.list.length) self.redraw(g); }, 0);
    },
    /** Resolves once every record is drawn (or nothing is to be). */
    ready: function () {
      var self = this;
      return new Promise(function (res) {
        var t0 = performance.now();
        (function poll() {
          if (!self.list.length || (self._drawn && self._texReady) || self._err || performance.now() - t0 > 20000) return res(self._drawn);
          setTimeout(poll, 50);
        })();
      });
    },
    _undraw: function (g) {
      for (var i = 0; i < this._meshes.length; i++) {
        var m = this._meshes[i];
        if (m.parent) m.parent.remove(m);
        m.traverse(function (o) { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      }
      this._meshes.length = 0;
      for (var k = 0; k < this.pick.length; k++) this.pick[k].geometry.dispose();
      this.pick.length = 0;
      var T = g && g.terrain;
      if (T && (T._drawH120 || T._wet120)) {
        T._drawH120 = null; T._wet120 = null;
        this._touchDrawn(g, true);
      }
      this._drawn = false;
    },
    redraw: function (g) {
      var self = this;
      this._undraw(g);
      if (!g || !this.on(g) || !this.list.length || !window.THREE || !g.scene) return;
      if (!this._pack()) return;
      var run = function () {
        var t0 = performance.now(), tris = 0, draws = 0;
        for (var i = 0; i < self.list.length; i++) { var r = self._build(g, self.list[i]); tris += r.tris; draws += r.draws; }
        self.stats.drawn = self.list.length; self.stats.tris = tris; self.stats.draws = draws; self.stats.buildMs = performance.now() - t0;
        self._drawn = true;
        self._applyDrawn(g);
      };
      if (typeof cosmeticScope === 'function') cosmeticScope(run); else run();
    },
    /** The ground under each span drawn at the bed, and the water drawn over it. */
    _applyDrawn: function (g) {
      var T = g.terrain;
      if (!T || !this.drawH) return;
      this.drawH.fill(NaN); this.wet.fill(0);
      for (var i = 0; i < this.list.length; i++) {
        var rec = this.list[i];
        for (var a = rec.s0; a <= rec.s1; a++) for (var c = rec.c0; c <= rec.c1; c++) {
          var k = this._cellIdx(rec, a, c);
          this.drawH[k] = rec.bed[a - rec.s0]; this.wet[k] = 1;
        }
      }
      T._drawH120 = this.drawH; T._wet120 = this.wet;
      this._touchDrawn(g, false);
    },
    _touchDrawn: function (g, all) {
      var T = g.terrain;
      for (var i = 0; i < this.list.length; i++) {
        var rec = this.list[i];
        for (var a = rec.s0 - 1; a <= rec.s1 + 1; a += 2) for (var c = rec.c0 - 1; c <= rec.c1 + 1; c += 2) {
          var x = rec.ax === 'x' ? a : c, z = rec.ax === 'x' ? c : a;
          if (x >= 0 && z >= 0 && x < GRID && z < GRID) T._touch(x, z, 2);
        }
      }
      T.heightsDirty = T.colorsDirty = true;
      if (T._hasWater) { T._maskWater(); T._updateWaterColors(); }
    },
    /** The ground as it is DRAWN (the bed under a span), the mesh's own triangles. */
    _drawnY: function (T, wx, wz) {
      var dh = T._drawH120 || this.drawH;
      var u = clamp((wx + HALF - TILE / 2) / TILE, 0, GRID - 1.001), v = clamp((wz + HALF - TILE / 2) / TILE, 0, GRID - 1.001);
      var ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz, i = iz * GRID + ix;
      var H = function (k) { var d = dh ? dh[k] : NaN; return d === d ? d : T.h[k]; };
      var h00 = H(i), h10 = ix + 1 < GRID ? H(i + 1) : h00, h01 = iz + 1 < GRID ? H(i + GRID) : h00, h11 = (ix + 1 < GRID && iz + 1 < GRID) ? H(i + GRID + 1) : h00;
      return (fx + fz <= 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11)) * HSCALE;
    },
    _mat: null,
    _material: function () {
      if (this._mat) return this._mat;
      var P = window.BRIDGES120PACK, T = THREE, self = this;
      var tex = function (b64, srgb) {
        var img = new Image(), t = new T.Texture(img);
        img.onload = function () { t.needsUpdate = true; };
        img.src = 'data:image/png;base64,' + b64;
        t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 8;
        if (srgb) t.encoding = T.sRGBEncoding;
        return t;
      };
      var map = tex(P.albedo, true), nrm = tex(P.normal, false);
      var ims = [map.image, nrm.image];
      Promise.all(ims.map(function (im) { return new Promise(function (res) { if (im.complete && im.naturalWidth) res(); else { im.addEventListener('load', res); im.addEventListener('error', res); } }); }))
        .then(function () { self._texReady = true; for (var i = 0; i < self._meshes.length; i++) self._meshes[i].visible = true; });
      var M = new T.MeshPhongMaterial({ map: map, normalMap: nrm, vertexColors: true, specular: 0x0b0b0b, shininess: 14 });
      M.name = 'bridges120';
      var u = { uSnowB: (window.Canopy && Canopy.snow) || { value: 0 }, uNearB: (window.Canopy && Canopy.near) || { value: 0 },
        uNearSunB: (window.Canopy && Canopy.nearSun) || { value: 1 }, uNearSkyB: (window.Canopy && Canopy.nearSky) || { value: [3.6, 5.0, 12.0, 36.0] } };
      M.onBeforeCompile = function (sh) {
        Object.assign(sh.uniforms, u);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vUpB;')
          .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vUpB = objectNormal.y;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vUpB;\nuniform float uSnowB; uniform float uNearB; uniform float uNearSunB; uniform vec4 uNearSkyB;')
          .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' +
            '  if (uNearB > 0.0) {\n' +
            '    vec3 lwB = vec3(0.2126, 0.7152, 0.0722);\n' +
            '    float sunRB = dot(reflectedLight.directDiffuse, lwB) / max(dot(diffuseColor.rgb, lwB) * uNearSunB, 1e-5);\n' +
            '    float shdB = 1.0 - smoothstep(0.06, 0.30, sunRB);\n' +
            '    float nrB = 1.0 - smoothstep(uNearSkyB.z, uNearSkyB.w, length(vViewPosition));\n' +
            '    reflectedLight.indirectDiffuse *= 1.0 + (uNearSkyB.x - 1.0) * shdB * nrB * uNearB;\n' +
            '  }')
          .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.60, 0.64), smoothstep(0.55, 0.9, vUpB) * uSnowB * 0.8);');
      };
      M.customProgramCacheKey = function () { return 'bridges120-v1'; };
      this._mat = M;
      return M;
    },

    /** The pieces a record is laid from: [{ p: piece name, x0 (m along), mir, sx }]. */
    layout: function (rec) {
      var P = window.BRIDGES120PACK, K = P.kinds[rec.kind], meta = K.meta, pcs = K.pieces;
      var Lm = (rec.s1 - rec.s0 + 1) * TILE * METERS_PER_UNIT, out = [];
      var put = function (p, x0, mir, sx) { if (pcs[p]) out.push({ p: p, x0: x0, mir: !!mir, sx: sx || 1 }); };
      if (meta.mode === 'stretch') {
        var n = Math.max(1, Math.ceil((Lm + meta.pierW) / (meta.smax + meta.pierW)));
        while (n > 1 && (Lm - (n - 1) * meta.pierW) / n < meta.smin) n--;
        var S = (Lm - (n - 1) * meta.pierW) / n, x = 0;
        for (var k = 0; k < n; k++) {
          put('span', x, false, S / meta.S0); x += S;
          if (k < n - 1) { put('pier', x + meta.pierW / 2); x += meta.pierW; }
        }
      } else {
        var Bm = meta.B, nb = Math.max(1, Math.round(Lm / Bm));
        if (rec.kind === 'truss') {
          var nsp = Math.max(1, Math.ceil(nb / meta.nmax));
          nb = Math.max(nsp * 2, nb);
          var sx = (Lm - (nsp - 1) * meta.pierW) / (nb * Bm), xx = 0, left = nb;
          for (var s = 0; s < nsp; s++) {
            var np = Math.round(left / (nsp - s)); left -= np;
            for (var j = 0; j < np; j++) {
              var end = j === 0 || j === np - 1, mir = j === np - 1 || (j >= np / 2 && !end) || (np === 1);
              var x0 = xx + (mir ? (j + 1) : j) * Bm * sx;
              put(end ? 'endspan' : 'span', x0, mir, sx);
            }
            if (np % 2 === 0) put('node', xx + np / 2 * Bm * sx);
            xx += np * Bm * sx;
            if (s < nsp - 1) { put('pier', xx + meta.pierW / 2); xx += meta.pierW; }
          }
        } else {
          var sx2 = Lm / (nb * Bm);
          for (var j2 = 0; j2 < nb; j2++) {
            var endb = pcs.endspan && (j2 === 0 || j2 === nb - 1), mirb = pcs.endspan && j2 === nb - 1 && nb > 1;
            put(endb ? 'endspan' : 'span', (mirb ? j2 + 1 : j2) * Bm * sx2, mirb, sx2);
            var bent = rec.kind === 'trestle' ? j2 > 0 : rec.kind === 'bailey' ? (j2 > 0 && j2 % 8 === 0 && nb - j2 >= 4) : false;
            if (bent && pcs.pier) put('pier', j2 * Bm * sx2);
          }
        }
      }
      put('end', 0, false); put('end', Lm, true);
      return { pieces: out, Lm: Lm };
    },

    /** One record's model: its pieces laid along the deck and bent to it, merged per section, two LODs each. */
    _build: function (g, rec) {
      var P = window.BRIDGES120PACK, KD = P.kinds[rec.kind], meta = KD.meta, T = g.terrain, TH = THREE, self = this;
      var U = 1 / METERS_PER_UNIT, Wm = (rec.c1 - rec.c0 + 1) * TILE * METERS_PER_UNIT, Wr = meta.W, dW = Wm - Wr;
      var zE = Wr / 2 - (Wr >= 12 ? 1.8 : 1.2);
      var mapZ = function (z) { var a = Math.abs(z), s = z < 0 ? -1 : 1; return z + s * dW / 2 * Math.min(1, a / zE); };
      var ax = rec.ax, dx = ax === 'x' ? 1 : 0, dz = ax === 'x' ? 0 : 1;
      var ex = ax === 'x' ? 0 : -1, ez = ax === 'x' ? 1 : 0;      // across = along x up (right-handed: d x up)
      var a0w = cellCenter(rec.s0) - TILE / 2, cw = (cellCenter(rec.c0) + cellCenter(rec.c1)) / 2;
      var Ox = ax === 'x' ? a0w : cw, Oz = ax === 'x' ? cw : a0w;
      var L = this.layout(rec), mat = this._material();
      // the road surface along the centre line: the sim's deck (Terrain.heightAt, deck-aware), sampled every 0.5 m
      var deckY = function (xm) { var w = xm * U; return T.heightAt(Ox + dx * w, Oz + dz * w); };
      var wl = T.waterY;
      var BV = P.bandV, bandName = P.bands;
      var vOf = bandName.map(function (b) { var q = BV[b]; return [q[0], (q[1] - q[0]) * 1024]; });
      // sections of ~60 m along, each a LOD (hi near, lo far)
      var SECT = 60, nsec = Math.max(1, Math.ceil((L.Lm + 16) / SECT)), sec = [];
      for (var s = 0; s < nsec; s++) sec.push({ lists: [[], []] });
      for (var k = 0; k < L.pieces.length; k++) {
        var q = L.pieces[k], si = Math.max(0, Math.min(nsec - 1, Math.floor((q.x0 + 8) / SECT)));
        sec[si].lists[0].push(q); sec[si].lists[1].push(q);
      }
      var tris = 0, draws = 0, built = [];
      for (var s2 = 0; s2 < nsec; s2++) {
        var lod = new TH.LOD(), centre = null, geos = [];
        for (var lv = 0; lv < 2; lv++) {
          var lst = sec[s2].lists[lv];
          if (!lst.length) continue;
          var nv = 0, ni = 0;
          for (var a = 0; a < lst.length; a++) { var pc = KD.pieces[lst[a].p][lv]; nv += pc.band.length; ni += pc.idx.length; }
          var pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
          var ind = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni), vb = 0, ib = 0;
          for (var b = 0; b < lst.length; b++) {
            var it = lst[b], pz = KD.pieces[it.p][lv], n = pz.band.length;
            for (var v = 0; v < n; v++) {
              var x = pz.pos[v * 3], y = pz.pos[v * 3 + 1], z = pz.pos[v * 3 + 2];
              var xs = it.mir ? it.x0 - x * it.sx : it.x0 + x * it.sx, zz = mapZ(z);
              var wx = Ox + dx * xs * U + ex * zz * U, wz = Oz + dz * xs * U + ez * zz * U;
              var wy = deckY(xs) + y * U, ys = pz.ys[v];
              if (ys) { var gy = self._drawnY(T, wx, wz) - 0.04 * U * 4; wy = ys === 1 ? gy : Math.max(wy, gy); }
              var o = (vb + v) * 3;
              pos[o] = wx; pos[o + 1] = wy; pos[o + 2] = wz;
              var nx = pz.nor[v * 3] * (it.mir ? -1 : 1), ny = pz.nor[v * 3 + 1], nzz = pz.nor[v * 3 + 2];
              nor[o] = dx * nx + ex * nzz; nor[o + 1] = ny; nor[o + 2] = dz * nx + ez * nzz;
              var bi = pz.band[v], vv = vOf[bi];
              uv[(vb + v) * 2] = pz.uv[v * 2]; uv[(vb + v) * 2 + 1] = vv[0] + (2 + (vv[1] - 4) * pz.uv[v * 2 + 1]) / 1024;
              // the water's mark: masonry and timber darker and greener for a metre over the surface, darker under it
              var hw = (wy - wl) * METERS_PER_UNIT, damp = hw < -0.1 ? 0.55 : hw < 1.4 ? 0.62 + 0.38 * Math.max(0, hw / 1.4) : 1;
              col[o] = pz.col[v * 3] * damp * (damp < 1 ? 0.92 : 1); col[o + 1] = pz.col[v * 3 + 1] * damp; col[o + 2] = pz.col[v * 3 + 2] * damp * (damp < 1 ? 0.88 : 1);
            }
            var I = pz.idx;
            for (var t = 0; t < I.length; t += 3) {
              if (it.mir) { ind[ib++] = vb + I[t]; ind[ib++] = vb + I[t + 2]; ind[ib++] = vb + I[t + 1]; }
              else { ind[ib++] = vb + I[t]; ind[ib++] = vb + I[t + 1]; ind[ib++] = vb + I[t + 2]; }
            }
            vb += n;
          }
          var geo = new TH.BufferGeometry();
          geo.setAttribute('position', new TH.BufferAttribute(pos, 3)); geo.setAttribute('normal', new TH.BufferAttribute(nor, 3));
          geo.setAttribute('uv', new TH.BufferAttribute(uv, 2)); geo.setAttribute('color', new TH.BufferAttribute(col, 3));
          geo.setIndex(new TH.BufferAttribute(ind, 1));
          geo.computeBoundingSphere();
          if (!centre) centre = geo.boundingSphere.center.clone();
          geos.push(geo);
          if (lv === 0) tris += ni / 3;
        }
        if (!geos.length) continue;
        for (var gI = 0; gI < geos.length; gI++) {
          geos[gI].translate(-centre.x, -centre.y, -centre.z);
          var me = new TH.Mesh(geos[gI], mat);
          me.castShadow = true; me.receiveShadow = true; me.name = 'bridges120:' + rec.kind + ':' + s2 + ':' + (gI ? 'lo' : 'hi');
          lod.addLevel(me, gI ? 110 : 0);
        }
        lod.position.copy(centre); lod.name = 'bridges120:' + rec.kind + ':' + s2;
        lod.visible = !!this._texReady;
        lod.updateMatrixWorld(true);
        g.scene.add(lod); this._meshes.push(lod); built.push(lod);
        draws++;
      }
      // a deck ribbon for the cursor (never drawn): a click on the deck lands on the deck, not on the bed under it
      var rp = [], ri = [];
      for (var a2 = rec.s0 - 1; a2 <= rec.s1 + 1; a2++) {
        var xm = (a2 - rec.s0 + 0.5) * TILE * METERS_PER_UNIT, w2 = Wm / 2;
        for (var side = -1; side <= 1; side += 2) {
          var px = Ox + dx * xm * U + ex * side * w2 * U, pzz = Oz + dz * xm * U + ez * side * w2 * U;
          rp.push(px, deckY(xm), pzz);
        }
        if (a2 > rec.s0 - 1) { var bq = rp.length / 3 - 4; ri.push(bq, bq + 2, bq + 1, bq + 1, bq + 2, bq + 3); }
      }
      var pg = new TH.BufferGeometry();
      pg.setAttribute('position', new TH.BufferAttribute(new Float32Array(rp), 3)); pg.setIndex(ri); pg.computeBoundingSphere();
      var pm = new TH.Mesh(pg, new TH.MeshBasicMaterial({ side: TH.DoubleSide }));
      pm.name = 'bridges120:pick'; pm.updateMatrixWorld(true);
      this.pick.push(pm);
      rec._lods = built;
      return { tris: tris, draws: draws };
    },
  };
})();
