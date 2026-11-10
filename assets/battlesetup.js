/* =============================================================================
 * BATTLE SETUP (round 111) — what each side fights with, chosen before every
 * battle.
 * =============================================================================
 *
 * Opened by the player's own ways into a new battle — Play (or Tab) out of the
 * editor, a map off the picker, a new battle size, Reset, ↺ Battle and the
 * banner's Restart — and never by `setMode('play')` itself, which the probes,
 * the tests, the campaign and the Forge all call directly. The campaign keeps
 * its own requisition and never sees this.
 *
 * For each side:
 *   · the ARMY it is built on — the seven with squad templates
 *     (assets/squads.js) — whose presets and batteries it starts from;
 *   · (round 114) ANY OTHER ARMY OF ITS ALLIANCE beside it. The list holds the
 *     whole alliance, an army filter narrows it (All by default), and one
 *     force may draw on all of them: a Sherman beside a T-34 and Tommies. The
 *     line is `ALLIANCES` below, for both sides alike: nothing crosses between
 *     the Allies and the Axis. There are no points here, only MAX_SQUADS a row;
 *   · the MAP'S OWN FORCES (what the map deployed, or what the editor put on
 *     the field), or a list of squad templates — the same atoms the campaign
 *     requisitions — by preset or one at a time;
 *   · FIRE SUPPORT — the FIRE_SUPPORT batteries that army called on, as many
 *     missions of each as asked. The map's grant (`_grantMapSupport`: the
 *     battalion mortars twice, the divisional 105s once or twice) is where it
 *     starts.
 *
 * Squads chosen here land on the MAP'S OWN START LINES, harvested from its
 * `deploy()` with a recording stub as the campaign does (`_deploySquads`): the
 * HQ behind the centre, the rifle squads dealt across the lines, mortars and
 * guns set back, armour on the flanks behind the infantry, all in open order
 * (`spawnSquad`'s `spacing`, two cells a man — round 110's rule for a stock
 * map's deploy).
 *
 * Remembered per map (localStorage, per viewer). Enter starts; Esc keeps the
 * field exactly as it is. The game is paused while the screen is up.
 * ========================================================================== */
(function () {
  'use strict';

  var A = null;              // what the main file hands over (`use` / `install`)
  var installed = false;
  var STORE = 'tc_battleSetup';

  var NATIONS = [
    ['us', 'United States'], ['uk', 'Britain'], ['sov', 'Soviet Union'], ['fr', 'France'],
    ['ger', 'Germany'], ['it', 'Italy'], ['jp', 'Japan'],
  ];
  var NAT_NAME = {};
  NATIONS.forEach(function (n) { NAT_NAME[n[0]] = n[1]; });
  var BLOC = { us: 'allied', uk: 'allied', fr: 'allied', ger: 'axis', it: 'axis', jp: 'axis', sov: 'soviet' };
  // (round 114) WHO MAY FIGHT IN ONE FORCE. `BLOC` above is whose batteries an
  // army calls on, and there the Red Army stands alone; here it is an Ally.
  var ALLIANCES = [
    ['allied', 'Allies', ['us', 'uk', 'sov', 'fr']],
    ['axis', 'Axis', ['ger', 'it', 'jp']],
  ];
  var ALLIANCE = {};
  ALLIANCES.forEach(function (a) { a[2].forEach(function (id) { ALLIANCE[id] = a; }); });
  // the short name on a row of the list and on the army filter
  var TAG = { us: 'US', uk: 'UK', sov: 'USSR', fr: 'FR', ger: 'GER', it: 'ITA', jp: 'JPN' };
  // (round 115) AN ARMY THE TEMPLATES NAME THAT THE TABLES ABOVE DO NOT — a
  // roster added after them — joins the alliance its men fight for (`nationOf`
  // of its first man) under its own code, rather than dropping off this screen
  // unseen. The lists are the templates'; these tables only give them names.
  var armiesSeen = -1;
  function syncArmies() {
    var all = TPL(), ids = Object.keys(all);
    if (ids.length === armiesSeen || !(A && A.nationOf)) return;
    armiesSeen = ids.length;
    ids.forEach(function (id) {
      var t = all[id], nat = t && t.nation;
      if (!nat || ALLIANCE[nat] || !t.men || !t.men.length) return;
      var b = A.nationOf(t.men[0]), al = ALLIANCES[b === 'axis' ? 1 : 0], code = String(nat).toUpperCase();
      al[2].push(nat); ALLIANCE[nat] = al;
      NAT_NAME[nat] = t.nationName || code; TAG[nat] = code.slice(0, 4);
      BLOC[nat] = b === 'axis' || b === 'soviet' ? b : 'allied';
      NATIONS.push([nat, NAT_NAME[nat]]);
    });
  }
  // FIRE_SUPPORT marks a battery 'us', 'ger' or 'both'. The Commonwealth and
  // the French called on the allied list, Italy and Japan on the German one; the Red
  // Army's own — the 120 mm mortar, the guns, the rockets — are the 'both' rows.
  var FS_NATION = { allied: 'us', axis: 'ger', soviet: null };
  // the battalion mortars every side has, as `Game._grantMapSupport` gives them
  var MORTAR = { allied: 'fs_mortar81', axis: 'fs_mortar8cm', soviet: 'fs_mortar120' };

  var CATS = [
    ['command', 'Headquarters'], ['rifle', 'Infantry'], ['mg', 'Machine guns'], ['at', 'Anti-tank teams'],
    ['recon', 'Reconnaissance'], ['mortar', 'Mortars'], ['atgun', 'Anti-tank guns'], ['arty', 'Artillery'],
    ['transport', 'Transport'], ['armour', 'Armour'],
  ];
  var CAT_NAME = {}, CAT_ORDER = {};
  CATS.forEach(function (c, i) { CAT_NAME[c[0]] = c[1]; CAT_ORDER[c[0]] = i; });
  // Templates rarer than this (`w`, how common the type was — the paper
  // panzers are 0.1) wait behind "more" so the common choices are on screen.
  var COMMON_W = 0.5;
  var MAX_SQUADS = 40, MAX_MISSIONS = 20;

  var PRESETS = [
    // (round 118, `game.snipers118`) the owner: snipers never showed up — no preset had one. A pair (the shot and
    // his observer) in the platoon and the company, each army's own where it has one (`baseOf` 'sniper').
    { id: 'platoon', name: 'Rifle platoon', note: 'An HQ, three rifle squads, a machine gun, a mortar, an anti-tank team and a sniper pair.',
      parts: [['command', 1], ['rifle', 3], ['mg', 1], ['mortar', 1], ['at', 1], ['recon', 1, 'sniper', 'r118']] },
    { id: 'company', name: 'Rifle company', note: 'An HQ, six rifle squads, two machine guns, two mortars, two anti-tank teams, scouts and a sniper pair.',
      parts: [['command', 1], ['rifle', 6], ['mg', 2], ['mortar', 2], ['at', 2], ['recon', 1, 'foot'], ['recon', 1, 'sniper', 'r118']] },
    { id: 'combined', name: 'Combined arms', note: 'A rifle platoon with an anti-tank gun and two tanks.',
      parts: [['command', 1], ['rifle', 3], ['mg', 1], ['mortar', 1], ['at', 1], ['atgun', 1], ['armour', 2]] },
    { id: 'armour', name: 'Armoured', note: 'Five tanks, two rifle squads to clear the hedges and a scout car.',
      parts: [['command', 1], ['rifle', 2], ['armour', 5], ['recon', 1, 'veh']] },
  ];

  // ---------------------------------------------------------------------------
  // THE PLANNING — no DOM, so tools/test_round111.js can run it in node.
  // ---------------------------------------------------------------------------
  function TPL() { return (window.Squads && window.Squads.TEMPLATES) || {}; }
  function DEF(t) { return (A && A.UNIT_DEFS && A.UNIT_DEFS[t]) || null; }
  function isVeh(t) { var d = DEF(t); return !!(d && d.vehicle); }
  function isGun(t) { var d = DEF(t); return !!(d && !d.vehicle && (d.kind === 'atgun' || d.kind === 'artillery')); }
  function clampI(v, a, b) { v = Math.round(+v || 0); return v < a ? a : v > b ? b : v; }

  /** The army a unit id belongs to, by the prefix every id is spelled with;
   *  the unprefixed ones (sherman, stug, mg42…) by `nationOf`. */
  function armyOf(type) {
    var t = String(type || '');
    if (/^us/.test(t)) return 'us';
    if (/^uk/.test(t)) return 'uk';      // not 'br' — that is the Brummbär
    if (/^ger/.test(t)) return 'ger';
    if (/^sov/.test(t)) return 'sov';
    if (/^fr/.test(t)) return 'fr';
    if (/^it/.test(t)) return 'it';
    if (/^jp/.test(t)) return 'jp';
    var n = A && A.nationOf ? A.nationOf(t) : 'allied';
    return n === 'axis' ? 'ger' : n === 'soviet' ? 'sov' : n === 'allied' ? 'us' : null;
  }
  /** The army most of a side's men belong to. */
  function sideArmy(units, team) {
    var tally = {}, best = null, bn = 0;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u.alive || u.team !== team) continue;
      var a = armyOf(u.type);
      if (!a) continue;
      tally[a] = (tally[a] || 0) + 1;
      if (tally[a] > bn) { bn = tally[a]; best = a; }
    }
    return best;
  }
  /** An army's templates: by arm, the commonest first. */
  function templatesOf(nation) {
    var all = TPL(), out = [];
    for (var k in all) if (all[k].nation === nation) out.push(all[k]);
    var hq = function (t) { return /_hq$/.test(t.id) ? 0 : 1; };   // the company HQ heads its arm
    out.sort(function (a, b) {
      return (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || (hq(a) - hq(b)) || (b.w - a.w) || (a.rp - b.rp) || (a.id < b.id ? -1 : 1);
    });
    return out;
  }
  /** (round 114) An army and the others of its alliance, it first. */
  function comrades(nation) {
    var al = ALLIANCE[nation];
    return al ? [nation].concat(al[2].filter(function (a) { return a !== nation; })) : [nation];
  }
  /** Can these two armies stand in one force? */
  function sameSide(a, b) { return !!ALLIANCE[a] && ALLIANCE[a] === ALLIANCE[b]; }
  /** What a side's list holds: the whole alliance, its lead army's rows first
   *  in each arm, or the one army `view` names. A view across the line is not
   *  a view: it gets the alliance. */
  function rosterOf(nation, view) {
    if (sameSide(nation, view)) return templatesOf(view);
    var out = [];
    comrades(nation).forEach(function (a) { out = out.concat(templatesOf(a)); });
    return out;
  }
  /** Squads of each army in a set of template counts. */
  function perArmy(counts) {
    var all = TPL(), o = {};
    for (var id in (counts || {})) {
      var t = all[id], n = counts[id] | 0;
      if (t && n > 0) o[t.nation] = (o[t.nation] || 0) + n;
    }
    return o;
  }
  /** The commonest template of an arm — what a preset means by "a rifle
   *  squad". The headquarters is the `_hq` one, not the observer or the aid
   *  post; `want` picks a recon car ('veh') or men on foot ('foot'), or (round 118) a sniper pair ('sniper'):
   *  the one whose shot is of the army's own kit first — the Scharfschütze with the Kar 98k, not the German
   *  template that borrowed the American sniper. */
  function baseOf(nation, cat, want) {
    var best = null, bestOwn = 0, all = TPL();
    for (var k in all) {
      var t = all[k];
      if (t.nation !== nation || t.cat !== cat) continue;
      if (cat === 'command' && !/_hq$/.test(k)) continue;
      if (want === 'veh' && !isVeh(t.men[0])) continue;
      if (want === 'foot' && isVeh(t.men[0])) continue;
      if (want === 'sniper') { var d0 = DEF(t.men[0]); if (!d0 || d0.kind !== 'sniper') continue; }
      var own = want === 'sniper' && armyOf(t.men[0]) === nation ? 1 : 0;
      if (best && own < bestOwn) continue;
      // a tie goes to the dearer — the armoured car, not the jeep, scouts for tanks
      if (!best || own > bestOwn || t.w > best.w || (t.w === best.w && (t.rp > best.rp || (t.rp === best.rp && t.id < best.id)))) { best = t; bestOwn = own; }
    }
    return best ? best.id : null;
  }
  function preset(nation, id) {
    var c = {};
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id !== id) continue;
      PRESETS[i].parts.forEach(function (p) {
        if (p[3] === 'r118' && root118() && root118().snipers118 === false) return;   // (round 118) OFF: the old presets
        var t = baseOf(nation, p[0], p[2]);
        if (t) c[t] = (c[t] || 0) + p[1];
      });
    }
    return c;
  }
  /** THE MAP'S FORCE, IN TEMPLATES — where the counts start when the player
   *  begins to change a side that was the map's own, so "two more tanks" is
   *  two more than the map had rather than two on an empty field. Each
   *  template has a KEY man, the first who is not a plain rifle-squad man: the
   *  officer of an HQ, the gun of a gun team, the hull of a tank. Each key man
   *  on the field is one of the commonest template he keys, which takes its
   *  bearers out of the pool; what is left of the riflemen is rifle squads. */
  function approxOne(units, team, nation) {
    var all = TPL(), list = templatesOf(nation), counts = {}, pool = {};
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.alive && u.team === team) pool[u.type] = (pool[u.type] || 0) + 1;
    }
    var rifle = baseOf(nation, 'rifle'), rifleMen = {};
    if (rifle) all[rifle].men.forEach(function (m) { rifleMen[m] = true; });
    var byKey = {};
    list.forEach(function (t) {
      if (t.id === rifle) return;
      var key = null;
      for (var j = 0; j < t.men.length; j++) if (!rifleMen[t.men[j]]) { key = t.men[j]; break; }
      if (!key) return;
      var o = byKey[key];
      if (!o || CAT_ORDER[t.cat] < CAT_ORDER[o.cat] || (t.cat === o.cat && t.w > o.w)) byKey[key] = t;
    });
    // headquarters first, so the HQ's own aid man is not counted a second time
    // as an aid post of his own
    var keys = Object.keys(pool).filter(function (k) { return byKey[k]; });
    keys.sort(function (a, b) { return CAT_ORDER[byKey[a].cat] - CAT_ORDER[byKey[b].cat]; });
    keys.forEach(function (type) {
      if (!(pool[type] > 0)) return;
      var t = byKey[type];
      var per = t.men.filter(function (m) { return m === type; }).length || 1;
      var n = Math.max(1, Math.round(pool[type] / per));
      counts[t.id] = (counts[t.id] || 0) + n;
      for (var j = 0; j < n; j++) t.men.forEach(function (m) { if (m !== type && pool[m] > 0) pool[m]--; });
      pool[type] = 0;
    });
    if (rifle) {
      var left = 0;
      for (var k in pool) if (rifleMen[k]) left += pool[k];
      var size = all[rifle].men.length, nR = Math.round(left / size);
      if (!nR && left >= Math.ceil(size / 3)) nR = 1;
      if (nR) counts[rifle] = (counts[rifle] || 0) + nR;
    }
    return counts;
  }
  /** (round 114) …and the same of a side that mixes armies, as a few maps' do:
   *  each man goes to the army of the alliance that fields him, the lead army
   *  first, so a British Firefly on an American map stays when the player
   *  starts to change that side. */
  function approx(units, team, nation) {
    var order = comrades(nation), home = {}, parts = {}, out = {}, i, a, id;
    for (i = order.length - 1; i >= 0; i--) {   // last write wins: the lead army last
      templatesOf(order[i]).forEach(function (t) { t.men.forEach(function (m) { home[m] = t.nation; }); });
    }
    for (i = 0; i < units.length; i++) {
      if (units[i].team !== team) continue;
      a = home[units[i].type] || nation;
      (parts[a] || (parts[a] = [])).push(units[i]);
    }
    for (a in parts) {
      var c = approxOne(parts[a], team, a);
      for (id in c) out[id] = (out[id] || 0) + c[id];
    }
    return out;
  }
  /** Squads, men, guns and vehicles in a set of template counts. */
  function counted(counts) {
    var o = { squads: 0, men: 0, guns: 0, vehicles: 0 }, all = TPL();
    for (var id in counts) {
      var n = counts[id] | 0, t = all[id];
      if (n <= 0 || !t) continue;
      o.squads += n;
      t.men.forEach(function (m) { if (isVeh(m)) o.vehicles += n; else if (isGun(m)) o.guns += n; else o.men += n; });
    }
    return o;
  }
  /** …and the same of what a side has on the field. */
  function onField(units, team) {
    var o = { men: 0, guns: 0, vehicles: 0, types: {} };
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u.alive || u.team !== team) continue;
      if (isVeh(u.type)) o.vehicles++; else if (isGun(u.type)) o.guns++; else o.men++;
      o.types[u.type] = (o.types[u.type] || 0) + 1;
    }
    return o;
  }
  /** The batteries an army called on, and (round 114) with `counts`, those of
   *  every other army with men in the force: a Soviet force with a Sherman in
   *  it has somebody to ask for the American guns. */
  function supportFor(nation, counts) {
    var FS = (A && A.FIRE_SUPPORT) || {}, who = perArmy(counts), own = {}, out = [];
    who[nation] = 1;
    for (var a in who) { var o = FS_NATION[BLOC[a] || 'allied']; if (o) own[o] = true; }
    for (var k in FS) { var n = FS[k].nation; if (n === 'both' || own[n]) out.push(k); }
    return out;
  }
  /** What `_grantMapSupport` would give this army. */
  function defaultSupport(nation, defending) {
    var o = {}, m = MORTAR[BLOC[nation] || 'allied'];
    if (m) o[m] = 2;
    o.fs_arty105 = defending ? 1 : 2;
    return o;
  }
  /** A side's missions carried over to another army: what it can still call
   *  is kept, and its battalion mortars become the new army's. */
  function adaptSupport(sup, nation, counts) {
    var ok = {}, out = {};
    supportFor(nation, counts).forEach(function (k) { ok[k] = true; });
    var mort = MORTAR[BLOC[nation] || 'allied'];
    for (var k in sup) {
      var n = sup[k] | 0;
      if (n <= 0) continue;
      var to = ok[k] ? k : (/^fs_mortar(81|8cm)$/.test(k) ? mort : null);
      if (to) out[to] = Math.max(out[to] || 0, n);
    }
    return out;
  }
  /** Where a map puts each side: its own `deploy()` run with a recording stub,
   *  as the campaign harvests it (`_deploySquads`). */
  function harvestZones(mapDef, G) {
    var zones = {};
    if (!mapDef || typeof mapDef.deploy !== 'function') return zones;
    try {
      mapDef.deploy({
        gx: function (f) { return Math.round(G * f); },
        deploy: function (cx, cz, team, list) {
          (zones[team] || (zones[team] = [])).push({ cx: cx, cz: cz, w: (list && list.length) || 1 });
        },
      });
    } catch (e) { return {}; }
    return zones;
  }
  /** A side's start lines read off its men when the map has none to give (an
   *  imported field): up to three, left to right, or a line across its half. */
  function fieldZones(units, team, G) {
    var pts = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.alive && u.team === team && u.pos) pts.push({ x: A.worldToCell(u.pos.x), z: A.worldToCell(u.pos.z) });
    }
    if (!pts.length) {
      var zz = Math.round(G * (team === 1 ? 0.85 : team === 2 ? 0.15 : 0.5));
      return [0.3, 0.5, 0.7].map(function (f) { return { cx: Math.round(G * f), cz: zz, w: 1 }; });
    }
    pts.sort(function (a, b) { return a.x - b.x; });
    var k = Math.min(3, Math.max(1, Math.round(pts.length / 6))), out = [];
    for (var g = 0; g < k; g++) {
      var part = pts.slice(Math.floor(g * pts.length / k), Math.floor((g + 1) * pts.length / k));
      if (!part.length) continue;
      var cx = 0, cz = 0;
      part.forEach(function (p) { cx += p.x; cz += p.z; });
      out.push({ cx: Math.round(cx / part.length), cz: Math.round(cz / part.length), w: part.length });
    }
    return out;
  }
  function centroid(zs) {
    var x = 0, z = 0;
    zs.forEach(function (q) { x += q.cx; z += q.cz; });
    return { x: x / zs.length, z: z / zs.length };
  }
  /** The way a side faces: from its lines toward the enemy's. */
  function facing(own, foe, team) {
    var dx = foe.x - own.x, dz = foe.z - own.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1) return { x: 0, z: team === 2 ? 1 : -1 };
    return { x: dx / d, z: dz / d };
  }
  /** Template counts as one squad per entry, by arm. */
  function expand(counts) {
    var all = TPL(), list = [];
    Object.keys(counts).sort().forEach(function (id) {
      var t = all[id], n = counts[id] | 0;
      for (var i = 0; i < n && t; i++) list.push({ id: id, cat: t.cat, veh: isVeh(t.men[0]) });
    });
    list.sort(function (a, b) { return CAT_ORDER[a.cat] - CAT_ORDER[b.cat]; });
    return list;
  }
  var LANE = 10, ROW = 8;          // cells between squads abreast, and between rows
  function roleOf(s) {
    if (s.cat === 'command') return 'hq';
    if (s.cat === 'mortar' || s.cat === 'arty' || s.cat === 'atgun') return 'sup';
    if (s.cat === 'transport') return 'trn';
    if (s.cat === 'armour' || s.veh) return 'arm';
    return 'inf';
  }
  /** WHERE EACH SQUAD STANDS. The start lines are taken left to right across
   *  the side's front. Rifle squads, machine guns, bazookas and scouts are
   *  dealt across them from the centre outwards, three abreast LANE apart and
   *  rows ROW deep; the HQ stands behind the centre of the middle line; the
   *  mortars and guns behind the infantry; the armour on the flanks behind
   *  them; transport at the back. A line whose block would run off the map is
   *  moved forward until it fits. Returns [{id, x, z, platoon}] in cells. */
  function layout(list, zones, fwd, G) {
    var px = -fwd.z, pz = fwd.x;   // left to right across the front
    var zs = zones.map(function (z) { return { cx: z.cx, cz: z.cz }; });
    zs.sort(function (a, b) { return (a.cx * px + a.cz * pz) - (b.cx * px + b.cz * pz); });
    var nz = zs.length, mid = (nz - 1) >> 1, ord = [mid];
    for (var d = 1; ord.length < nz; d++) { if (mid + d < nz) ord.push(mid + d); if (mid - d >= 0) ord.push(mid - d); }
    var inf = [], sup = [], arm = [], trn = [];
    for (var i = 0; i < nz; i++) { inf.push([]); sup.push([]); arm.push([]); trn.push([]); }
    var hq = [], ci = 0, si = 0, ai = 0, ti = 0;
    list.forEach(function (s) {
      var r = roleOf(s);
      if (r === 'hq') hq.push(s);
      else if (r === 'inf') inf[ord[ci++ % nz]].push(s);
      else if (r === 'sup') sup[ord[si++ % nz]].push(s);
      else if (r === 'arm') arm[ord[ai++ % nz]].push(s);
      else trn[ord[ti++ % nz]].push(s);
    });
    // the HQ goes in behind the first rank of the middle line
    for (i = 0; i < hq.length; i++) inf[mid].splice(Math.min(3 + i, inf[mid].length), 0, hq[i]);
    var out = [];
    for (var zi = 0; zi < nz; zi++) {
      var z = zs[zi], spots = [];
      inf[zi].forEach(function (s, k) {
        var row = Math.floor(k / 3), c = k % 3;
        spots.push({ s: s, lat: (c === 0 ? 0 : c === 1 ? 1 : -1) * LANE, back: row * ROW, pl: roleOf(s) === 'hq' ? null : zi });
      });
      var deep = Math.ceil(inf[zi].length / 3) * ROW + 4;
      sup[zi].forEach(function (s, k) { spots.push({ s: s, lat: (k % 2 ? 5 : -5), back: deep + Math.floor(k / 2) * 7, pl: null }); });
      arm[zi].forEach(function (s, k) { spots.push({ s: s, lat: (k % 2 ? -1 : 1) * (LANE + 4), back: deep + Math.floor(k / 2) * 9, pl: null }); });
      var tb = deep + Math.max(Math.ceil(sup[zi].length / 2) * 7, Math.ceil(arm[zi].length / 2) * 9) + 4;
      trn[zi].forEach(function (s, k) { spots.push({ s: s, lat: (k % 2 ? -1 : 1) * (LANE * 2), back: tb + Math.floor(k / 2) * 8, pl: null }); });
      if (!spots.length) continue;
      // room behind the line, to the map's edge, along the way it faces back
      var need = 0;
      spots.forEach(function (p) { need = Math.max(need, p.back); });
      var room = Infinity;
      if (fwd.x > 1e-6) room = Math.min(room, (z.cx - 3) / fwd.x); else if (fwd.x < -1e-6) room = Math.min(room, (G - 4 - z.cx) / -fwd.x);
      if (fwd.z > 1e-6) room = Math.min(room, (z.cz - 3) / fwd.z); else if (fwd.z < -1e-6) room = Math.min(room, (G - 4 - z.cz) / -fwd.z);
      var shift = need > room ? Math.min(need - room, Math.round(G * 0.12)) : 0;
      spots.forEach(function (p) {
        var x = Math.round(z.cx + px * p.lat - fwd.x * (p.back - shift));
        var zz = Math.round(z.cz + pz * p.lat - fwd.z * (p.back - shift));
        out.push({ id: p.s.id, x: Math.max(3, Math.min(G - 4, x)), z: Math.max(3, Math.min(G - 4, zz)), platoon: p.pl });
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // APPLYING A PLAN — on the Game
  // ---------------------------------------------------------------------------
  /** Put a plan on the field: a side that is not the map's own loses what it
   *  has and gets its squads on the map's start lines; each side's fire
   *  support is set to the plan's. Returns {team: squads placed}. */
  function applyPlan(plan) {
    var g = this, G = A.grid(), placed = {}, touched = false, T;
    syncArmies();
    if (g.fpv && g.exitFpv) g.exitFpv();
    var zones = harvestZones(g.mapDef, G), cen = {};
    for (T = 1; T <= 2; T++) {
      if (!zones[T] || !zones[T].length) zones[T] = fieldZones(g.units, T, G);
      cen[T] = centroid(zones[T]);
    }
    for (T = 1; T <= 2; T++) {
      var s = plan && plan.sides && plan.sides[T];
      if (!s || s.mode !== 'custom') continue;
      var list = expand(s.army ? cleanCounts(s.counts, s.army) : (s.counts || {}));   // the line holds however the plan was drawn
      if (!list.length) continue;           // a side is never emptied (the screen will not start one)
      for (var i = g.units.length - 1; i >= 0; i--) if (g.units[i].team === T) g.removeUnit(g.units[i]);
      var spots = layout(list, zones[T], facing(cen[T], cen[T === 1 ? 2 : 1], T), G), n = 0;
      for (var j = 0; j < spots.length; j++) {
        var p = spots[j];
        var sq = g.spawnSquad(p.id, T, p.x, p.z, {
          spacing: 2, platoon: p.platoon, platoonName: p.platoon == null ? null : ordinal(p.platoon + 1) + ' Platoon',
        });
        if (sq) n++;
      }
      placed[T] = n;
      touched = true;
    }
    if (plan && plan.support) {
      if (!g.support) g.support = { 1: {}, 2: {}, 3: {}, 4: {} };
      for (T = 1; T <= 2; T++) {
        var sup = plan.support[T];
        if (!sup) continue;
        g.support[T] = {};
        for (var k in sup) if ((sup[k] | 0) > 0) g.grantSupport(T, k, sup[k] | 0, true);
      }
      if (g.ui && g.ui.refreshSupportBar) g.ui.refreshSupportBar();
    }
    if (touched) {
      // the plans and alarms of the men who are no longer there…
      g._cmd = null; g._cmds = null; g.assaults = []; g.alarms = {}; g.lostAt = {};
      g.select([], false);
      // …and the doctrine read off them: a side changed from American to
      // British fights by the British manual (`Game._doctrineOf` caches by it)
      if (g._newBattleStamp) g._newBattleStamp();
    }
    return placed;
  }
  function ordinal(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); }

  // ---------------------------------------------------------------------------
  // THE SCREEN
  // ---------------------------------------------------------------------------
  var UI = null;     // { g, reason, then, open, pending, state }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function root118() { return (A && A.game) || window.game || null; }
  /** (round 118, `game.setupMem118`) WHAT THE MAP FIELDED when a choice was remembered: men by type and side.
   *  A remembered force replaces the side's men, so once the map's own forces change (a sniper placed in the
   *  editor and the map saved, or new squads written into the map) the memory is of a different map and the
   *  setup starts from what the map fields now. A memory from before this has no print and is not used. */
  function forcesPrint(units) {
    var c = {}, k, out = [];
    for (var i = 0; i < units.length; i++) { var u = units[i]; if (u && u.alive && (u.team === 1 || u.team === 2)) { k = u.team + ':' + u.type; c[k] = (c[k] || 0) + 1; } }
    for (k in c) out.push(k + '=' + c[k]);
    return out.sort().join(',');
  }
  function loadAll() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function saveAll(all) { try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (e) { /* private mode, quota */ } }
  /** Counts kept to templates that still exist, of this army's alliance and no
   *  other (round 114: of this army, until armies could mix), as integers. */
  function cleanCounts(c, nation) {
    var all = TPL(), out = {};
    for (var id in (c || {})) {
      var n = clampI(c[id], 0, MAX_SQUADS);
      if (n > 0 && all[id] && sameSide(all[id].nation, nation)) out[id] = n;
    }
    return out;
  }
  function cleanSupport(c, nation, counts) {
    var ok = {}, out = {};
    supportFor(nation, counts).forEach(function (k) { ok[k] = true; });
    for (var k in (c || {})) { var n = clampI(c[k], 0, MAX_MISSIONS); if (n > 0 && ok[k]) out[k] = n; }
    return out;
  }

  function initialState(g, reason) {
    var name = g.mapDef ? g.mapDef.name : '(this field)';
    var mem = loadAll()[name] || null;
    // A field changed in the editor is the player's own scenario: its sides
    // start as they stand rather than as remembered for the stock map.
    var edited = reason === 'play' && !!(g.editor && g.editor.undoStack && g.editor.undoStack.length);
    var st = { map: name, edited: edited, sides: {}, support: {}, more: {} };
    // (round 118) …and a memory of the map as it fielded something else is not this map's
    st.fp = forcesPrint(g.units);
    if (mem && g.setupMem118 !== false && reason !== 'restart' && mem.fp !== st.fp) mem = { support: mem.support };
    for (var T = 1; T <= 2; T++) {
      var army = sideArmy(g.units, T);
      var side = { team: T, mapArmy: army, army: army || (T === 2 ? 'ger' : 'us'), mode: 'map', counts: {}, preset: 'map', view: 'all' };
      var m = !edited && mem && mem.sides && mem.sides[T];
      if (m && m.mode === 'custom' && NAT_NAME[m.army]) {
        side.mode = 'custom'; side.army = m.army; side.counts = cleanCounts(m.counts, m.army); side.preset = m.preset || null;
      }
      st.sides[T] = side;
      var sup = {};
      if (mem && mem.support && mem.support[T]) sup = mem.support[T];
      else if (reason === 'restart') {
        // the snapshot does not carry the missions, and the last battle spent them
        if (onField(g.units, T).men + onField(g.units, T).vehicles >= 4) sup = defaultSupport(side.army, g._defendingSide ? g._defendingSide(T) : false);
      } else {
        var have = (g.support && g.support[T]) || {};
        for (var k in have) if (have[k] && have[k].n > 0) sup[k] = have[k].n;
      }
      st.support[T] = cleanSupport(adaptSupport(sup, side.army, side.counts), side.army, side.counts);
    }
    return st;
  }

  function sideRole(g, T) {
    var br = g.mapDef && g.mapDef.brief, a = br && br.attacker;
    if (!a) return '';
    return a === T ? 'attacks' : 'defends';
  }
  function menLabel(t) {
    var m = 0, v = 0, gn = 0;
    t.men.forEach(function (x) { if (isVeh(x)) v++; else if (isGun(x)) gn++; else m++; });
    var parts = [];
    if (v) parts.push(v + (v === 1 ? ' vehicle' : ' vehicles'));
    if (gn) parts.push(gn === 1 ? 'gun' : gn + ' guns');
    if (m) parts.push(m + (m === 1 ? ' man' : ' men'));
    return parts.join(' + ');
  }
  function sumLine(o, missions, squads) {
    var p = [];
    if (squads != null) p.push(squads + (squads === 1 ? ' squad' : ' squads'));
    p.push(o.men + ' men');
    if (o.guns) p.push(o.guns + (o.guns === 1 ? ' gun' : ' guns'));
    if (o.vehicles) p.push(o.vehicles + (o.vehicles === 1 ? ' vehicle' : ' vehicles'));
    p.push(missions + (missions === 1 ? ' fire mission' : ' fire missions'));
    return p.join(' · ');
  }
  function ctl(n) {
    return '<span class="bs-ctl"><i data-d="-1" title="one fewer (shift: five)">−</i><u' + (n ? '' : ' class="z"') + '>' + n
      + '</u><i data-d="1" title="one more (shift: five)">+</i></span>';
  }

  function renderSide(T) {
    var g = UI.g, st = UI.state, s = st.sides[T], h = '';
    var you = T === g.playerTeam, role = sideRole(g, T);
    var col = g.teamColorCss ? g.teamColorCss(T) : '#888';
    var opts = (s.mapArmy ? '' : '<option value=""' + (s.mode === 'map' ? ' selected' : '') + '>the map’s own</option>')
      + ALLIANCES.map(function (al) {
        return '<optgroup label="' + al[1] + '">' + al[2].map(function (id) {
          return '<option value="' + id + '"' + (id === s.army && (s.mapArmy || s.mode === 'custom') ? ' selected' : '') + '>' + NAT_NAME[id] + '</option>';
        }).join('') + '</optgroup>';
      }).join('');
    h += '<div class="bs-side" data-team="' + T + '">';
    h += '<div class="bs-sh"><i class="bs-sw" style="background:' + col + '"></i><b>Side ' + T
      + (you ? ' · you' : ' · enemy') + (role ? ' · ' + role : '') + '</b>'
      + '<select data-army="' + T + '" title="The army this side is built on: the presets and the batteries are its own. Any army of its alliance can stand beside it, from the list below.">' + opts + '</select></div>';
    h += '<div class="bs-pre"><i data-p="map" class="' + (s.mode === 'map' ? 'on' : '') + '" title="'
      + (st.edited ? 'The men you put on the field in the editor' : 'What this map deploys') + '">'
      + (st.edited ? 'As placed' : 'Map’s forces') + '</i>';
    PRESETS.forEach(function (p) {
      h += '<i data-p="' + p.id + '" class="' + (s.mode === 'custom' && s.preset === p.id ? 'on' : '') + '" title="' + esc(p.note) + '">' + p.name + '</i>';
    });
    h += '<i data-p="clear" class="' + (s.mode === 'custom' && s.preset === 'clear' ? 'on' : '') + '" title="Nothing — add squads one at a time">Clear</i></div>';
    var missions = 0;
    for (var k in st.support[T]) missions += st.support[T][k] | 0;
    if (s.mode === 'map') {
      var f = onField(g.units, T);
      h += '<div class="bs-sum">' + sumLine(f, missions, null) + '</div>';
      var types = Object.keys(f.types).sort(function (a, b) {
        return (isVeh(b) - isVeh(a)) || (f.types[b] - f.types[a]);
      });
      var names = types.slice(0, 12).map(function (t) { var d = DEF(t); return esc(d ? d.name : t) + ' ×' + f.types[t]; });
      if (types.length > 12) names.push('…');
      h += '<div class="bs-own">' + (names.length ? names.join(' · ') : 'Nobody on the field for this side yet.')
        + '<br>Pick a preset or add squads below to choose this side’s forces instead.</div>';
    } else {
      var c = counted(s.counts);
      h += '<div class="bs-sum">' + sumLine(c, missions, c.squads) + '</div>';
    }
    // (round 114) the army filter: narrows the list to one army of the alliance,
    // and says what each has in the force, including the rows it is hiding
    var view = sameSide(s.army, s.view) ? s.view : 'all', tagged = view === 'all';
    var have = s.mode === 'custom' ? perArmy(s.counts) : {}, inAll = 0, al = ALLIANCE[s.army];
    for (var hv in have) inAll += have[hv];
    h += '<div class="bs-arm"><span>' + (al ? al[1] : '') + '</span><i data-v="all" class="' + (tagged ? 'on' : '')
      + '" title="Every army of this alliance">All' + (inAll ? ' ' + inAll : '') + '</i>';
    if (al) al[2].forEach(function (id) {
      h += '<i data-v="' + id + '" class="' + (view === id ? 'on' : '') + '" title="' + NAT_NAME[id] + ' only">' + TAG[id] + (have[id] ? ' ' + have[id] : '') + '</i>';
    });
    h += '</div>';
    // the templates, by arm
    var byCat = {};
    rosterOf(s.army, view).forEach(function (t) { (byCat[t.cat] || (byCat[t.cat] = [])).push(t); });
    h += '<div class="bs-list" data-list="' + T + '">';
    CATS.forEach(function (cat) {
      var ts = byCat[cat[0]];
      if (!ts) return;
      var key = T + ':' + cat[0], all = !!st.more[key];
      var vis = ts.filter(function (t) { return all || t.w >= COMMON_W || (s.mode === 'custom' && s.counts[t.id] > 0); });
      var hidden = ts.length - vis.length, rare = ts.some(function (t) { return t.w < COMMON_W; });
      h += '<div class="bs-cat"><span>' + cat[1] + '</span>'
        + (hidden > 0 ? '<u data-more="' + cat[0] + '">+ ' + hidden + ' more</u>' : all && rare ? '<u data-more="' + cat[0] + '">fewer</u>' : '')
        + '</div>';
      vis.forEach(function (t) {
        var n = s.mode === 'custom' ? (s.counts[t.id] | 0) : 0;
        h += '<div class="bs-row' + (tagged ? ' tg' : '') + (n ? ' has' : '') + '" data-id="' + t.id + '" title="' + esc(NAT_NAME[t.nation] + (t.note ? '. ' + t.note : ''))
          + '">' + (tagged ? '<em>' + TAG[t.nation] + '</em>' : '') + '<b>' + esc(t.name)
          + '</b><span class="bs-men">' + menLabel(t) + '</span>' + ctl(n) + '</div>';
      });
    });
    h += '</div>';
    // fire support
    h += '<div class="bs-fs"><h4><span>Fire support</span><span><u data-fs="def" title="What a side gets on a map nobody requisitioned for">standard</u>'
      + ' · <u data-fs="none">none</u></span></h4><div class="bs-fsg">';
    // two to a row: a side's batteries are up to eight, and the squad list
    // above them is what needs the height
    supportFor(s.army, s.counts).forEach(function (k) {
      var fsd = A.FIRE_SUPPORT[k], n = st.support[T][k] | 0;
      h += '<div class="bs-row' + (n ? ' has' : '') + '" data-fs="' + k + '" title="' + esc((fsd.note || '') + ' (' + fsd.rounds + ' rounds a mission)')
        + '"><b>' + esc(fsd.ic || '') + ' ' + esc(fsd.name) + '</b>' + ctl(n) + '</div>';
    });
    h += '</div></div></div>';
    return h;
  }

  function render() {
    if (!UI || !UI.open) return;
    var g = UI.g, st = UI.state, el = document.getElementById('bsetup');
    var keep = {};
    Array.prototype.forEach.call(el.querySelectorAll('.bs-list'), function (l) { keep[l.dataset.list] = l.scrollTop; });
    var order = g.playerTeam === 2 ? [2, 1] : [1, 2];
    var others = (g.units || []).some(function (u) { return u.alive && (u.team === 3 || u.team === 4); });
    var h = '<div class="bs-card">';
    h += '<div class="bs-head"><div><div class="bs-op">Battle setup</div><div class="bs-title">' + esc(st.map) + '</div>'
      + '<div class="bs-sub">Choose what each side fights with and the fire support it can call. Any armies of one alliance can fight side by side.</div></div>'
      + '<div class="bs-keys">Enter — start the battle<br>Esc — keep the field as it is</div></div>';
    h += '<div class="bs-body">' + order.map(renderSide).join('') + '</div>';
    if (others) h += '<div class="bs-note3">Sides 3 and 4 fight with the map’s own forces.</div>';
    h += '<div class="bs-foot"><span class="bs-warn">' + esc(UI.warn || '') + '</span>'
      + '<button data-keep="1" title="Esc">Keep the field as it is</button>'
      + '<button data-go="1" class="go" title="Enter">Start the battle ▸</button></div>';
    h += '</div>';
    el.innerHTML = h;
    Array.prototype.forEach.call(el.querySelectorAll('.bs-list'), function (l) {
      if (keep[l.dataset.list] != null) l.scrollTop = keep[l.dataset.list];
    });
  }

  function setPreset(T, id) {
    var st = UI.state, s = st.sides[T];
    if (id === 'map') {
      s.mode = 'map'; s.counts = {}; s.preset = 'map';
      if (s.mapArmy && s.mapArmy !== s.army) { s.army = s.mapArmy; st.support[T] = adaptSupport(st.support[T], s.army); }
      if (!sameSide(s.army, s.view)) s.view = 'all';
      return;
    }
    // (round 114) with the list narrowed to one army a preset is that army's,
    // and it leads the force: a preset the list could not show would look like
    // nothing happened
    if (id !== 'clear' && sameSide(s.army, s.view)) s.army = s.view;
    s.mode = 'custom'; s.preset = id;
    s.counts = id === 'clear' ? {} : preset(s.army, id);
    st.support[T] = cleanSupport(adaptSupport(st.support[T], s.army, s.counts), s.army, s.counts);
  }

  function onClick(e) {
    if (!UI || !UI.open) return;
    var t = e.target;
    if (t.closest('[data-go]')) { start(); return; }
    if (t.closest('[data-keep]')) { keepField(); return; }
    var sideEl = t.closest('.bs-side');
    if (!sideEl) return;
    var T = +sideEl.dataset.team, st = UI.state, s = st.sides[T];
    UI.warn = '';
    var p = t.closest('[data-p]');
    if (p) { setPreset(T, p.dataset.p); render(); return; }
    var fv = t.closest('[data-v]');
    if (fv) {
      s.view = fv.dataset.v;
      render();
      var fl = document.querySelector('#bsetup [data-list="' + T + '"]');
      if (fl) fl.scrollTop = 0;     // the old position means nothing on the new list
      return;
    }
    var mo = t.closest('[data-more]');
    if (mo) { var key = T + ':' + mo.dataset.more; st.more[key] = !st.more[key]; render(); return; }
    var u = t.closest('u[data-fs]');
    if (u) {
      st.support[T] = u.dataset.fs === 'def'
        ? cleanSupport(defaultSupport(s.army, UI.g._defendingSide ? UI.g._defendingSide(T) : false), s.army) : {};
      render(); return;
    }
    var d = t.closest('[data-d]');
    if (!d) return;
    var row = t.closest('.bs-row'), delta = (+d.dataset.d) * (e.shiftKey ? 5 : 1);
    if (row.dataset.fs) {
      var k = row.dataset.fs, n = clampI((st.support[T][k] | 0) + delta, 0, MAX_MISSIONS);
      if (n) st.support[T][k] = n; else delete st.support[T][k];
      render(); return;
    }
    if (row.dataset.id) {
      if (s.mode !== 'custom') {
        // begin from what the map has, so "two more tanks" means two more
        s.mode = 'custom';
        s.counts = s.army === s.mapArmy ? approx(UI.g.units, T, s.army) : preset(s.army, 'combined');
      }
      s.preset = null;
      var id = row.dataset.id, m = clampI((s.counts[id] | 0) + delta, 0, MAX_SQUADS);
      if (m) s.counts[id] = m; else delete s.counts[id];
      st.support[T] = cleanSupport(st.support[T], s.army, s.counts);   // the last man of the army that could call it
      render();
    }
  }
  function onChange(e) {
    if (!UI || !UI.open) return;
    var sel = e.target;
    if (!sel || !sel.dataset || !sel.dataset.army) return;
    var T = +sel.dataset.army, st = UI.state, s = st.sides[T], army = sel.value;
    UI.warn = '';
    if (!NAT_NAME[army]) { setPreset(T, 'map'); render(); return; }
    var was = s.preset, built = s.mode === 'custom' && was == null && sameSide(army, s.army);
    s.army = army; s.view = 'all';
    // (round 114) a force built by hand keeps its squads when the lead changes
    // within its alliance; across the line they cannot come
    if (built) {
      st.support[T] = cleanSupport(adaptSupport(st.support[T], army, s.counts), army, s.counts);
      render();
      return;
    }
    st.support[T] = cleanSupport(adaptSupport(st.support[T], army), army);
    if (army === s.mapArmy && was === 'map') { render(); return; }
    var keep = was && was !== 'map' && was !== 'clear' ? was : 'combined';
    s.mode = 'custom'; s.preset = keep; s.counts = preset(army, keep);
    render();
  }
  function onKey(e) {
    if (!UI || !UI.open) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); start(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keepField(); return; }
    if (e.target && e.target.tagName === 'SELECT') return;   // arrow keys through the army list
    e.stopPropagation();                                      // nothing reaches the game while this is up
  }

  function start() {
    var st = UI.state, g = UI.g;
    for (var T = 1; T <= 2; T++) {
      var s = st.sides[T];
      if (s.mode === 'custom' && !counted(s.counts).squads) {
        UI.warn = 'Side ' + T + ' has nothing to fight with — pick a preset or add squads.';
        render();
        return;
      }
    }
    var all = loadAll();
    all[st.map] = {
      fp: st.fp,   // (round 118) what the map fielded when this was chosen (`forcesPrint`)
      sides: {
        1: { mode: st.sides[1].mode, army: st.sides[1].army, counts: st.sides[1].counts, preset: st.sides[1].preset },
        2: { mode: st.sides[2].mode, army: st.sides[2].army, counts: st.sides[2].counts, preset: st.sides[2].preset },
      },
      support: st.support,
    };
    if (!st.edited) saveAll(all);
    close();
    var placed = g.applyBattleSetup({ sides: st.sides, support: st.support });
    finish(true, placed);
  }
  function keepField() { close(); finish(false, null); }
  function close() {
    if (!UI) return;
    UI.open = false;
    var el = document.getElementById('bsetup');
    if (el) { el.classList.remove('on'); el.innerHTML = ''; }
    window.removeEventListener('keydown', onKey, true);
  }
  /** Into the battle. From the editor `then` is `setMode('play')`, which
   *  readies the flags and the defence and takes the restart snapshot; on a
   *  field already in play that is done here. */
  function finish(applied, placed) {
    var g = UI.g, then = UI.then;
    UI = null;
    if (then) { then(); }
    else {
      if (applied) {
        g._setupVictoryPoints();
        g._prepareDefence();
        if (g._activateRoutes) g._activateRoutes();
        g.battleSnapshot = g.serialize();
        g.battleOver = false; g.battleActive = false;
      }
      g.paused = false;
    }
    if (applied && placed && g.ui && g.ui.toast) {
      var n = (placed[1] || 0) + (placed[2] || 0);
      if (n) g.ui.toast('Battle setup: ' + n + ' squads deployed');
    }
  }

  function whenBriefingClosed(fn) {
    var b = document.body;
    if (!b.classList.contains('briefing')) { fn(); return; }
    var mo = new MutationObserver(function () {
      if (b.classList.contains('briefing')) return;
      mo.disconnect();
      fn();
    });
    mo.observe(b, { attributes: true, attributeFilter: ['class'] });
  }
  function ensureEl() {
    var el = document.getElementById('bsetup');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bsetup';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    // the field under the screen is not to be clicked or scrolled through it
    el.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
    document.body.appendChild(el);
    return el;
  }
  /** `Game.battleSetup(reason, then)`: the screen, before a new battle. The
   *  game is paused until it closes; `then` runs after it closes either way
   *  (Play from the editor passes `setMode('play')`). Reasons: 'play', 'map',
   *  'restart'. Returns whether the screen will show. */
  function openSetup(reason, then) {
    var g = this;
    if (g.campaign || g._campaignLive || typeof document === 'undefined' || g.battleSetupOff) {
      if (then) then();
      return false;
    }
    if (UI && UI.open) close();
    syncArmies();
    g.paused = true;
    var me = UI = { g: g, reason: reason || 'play', then: then || null, open: false, pending: true, warn: '' };
    whenBriefingClosed(function () {
      if (UI !== me || !me.pending) return;
      g.paused = true;                 // Space during the briefing unpaused it
      me.pending = false; me.open = true;
      me.state = initialState(g, me.reason);
      ensureEl().classList.add('on');
      window.addEventListener('keydown', onKey, true);
      render();
    });
    return true;
  }

  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('bsetupCss')) return;
    var st = document.createElement('style');
    st.id = 'bsetupCss';
    st.textContent = [
      '#bsetup{position:fixed;inset:0;z-index:950;display:none;background:rgba(5,8,11,.74);',
      '  font:13px/1.45 ui-serif,Georgia,"Times New Roman",serif;color:#c3d2dd;overflow:auto;padding:16px}',
      '#bsetup.on{display:block}',
      // the card fits the window: the squad lists scroll, the head, the fire
      // support and the buttons stay on screen
      '.bs-card{max-width:1180px;margin:0 auto;background:rgba(12,17,23,.95);border:1px solid #2b3a49;border-radius:8px;',
      '  box-shadow:0 20px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;max-height:calc(100vh - 32px);min-height:0}',
      '.bs-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding:12px 22px 10px;border-bottom:1px solid #22303d;flex:none}',
      '.bs-op{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:2.4px;text-transform:uppercase;color:#c8a060}',
      '.bs-title{font-size:24px;font-weight:700;letter-spacing:.5px;margin:5px 0 1px;color:#e8dcc4}',
      '.bs-sub{font-size:12px;color:#8a9dad;font-style:italic}',
      '.bs-keys{font:10px/1.7 ui-monospace,Menlo,monospace;color:#6f8598;text-align:right;white-space:nowrap}',
      '.bs-body{display:grid;grid-template-columns:1fr 1fr;flex:1;min-height:0}',
      '.bs-side{padding:10px 18px 10px;min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.bs-side+.bs-side{border-left:1px solid #22303d}',
      '.bs-sh{display:flex;align-items:center;gap:9px;margin-bottom:8px}',
      '.bs-sw{width:12px;height:12px;border-radius:3px;display:block;flex:none}',
      '.bs-sh b{font-size:15px;color:#e8dcc4;flex:1;min-width:0}',
      '.bs-sh select{background:#121a22;color:#cfe0ee;border:1px solid #2f4050;border-radius:4px;font:12px ui-serif,Georgia,serif;padding:3px 6px}',
      '.bs-pre{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0 8px}',
      '.bs-arm{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:6px 2px 5px}',
      '.bs-arm span{font:9.5px/1 ui-monospace,Menlo,monospace;letter-spacing:1.6px;text-transform:uppercase;color:#8a9dad;margin-right:3px}',
      '.bs-pre i,.bs-arm i{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:.5px;font-style:normal;padding:5px 8px;border:1px solid #2f4050;',
      '  border-radius:4px;color:#9fb3c4;cursor:pointer;user-select:none}',
      '.bs-pre i:hover,.bs-arm i:hover{border-color:#c8a060;color:#e2c088}',
      '.bs-pre i.on,.bs-arm i.on{border-color:#c8a060;color:#e2c088;background:rgba(200,160,96,.13)}',
      '.bs-sum{font:11px/1.4 ui-monospace,Menlo,monospace;color:#c8a060;padding:4px 2px 6px;border-bottom:1px solid #22303d}',
      '.bs-own{font-size:11.5px;color:#93a7b8;font-style:italic;padding:6px 2px 4px}',
      '.bs-list{flex:1;min-height:90px;overflow:auto;font:11px/1.35 ui-monospace,Menlo,monospace;padding-right:4px}',
      // (round 115) the reinforcement list's dark scrollbar, not the system's white one
      '.bs-list::-webkit-scrollbar{width:7px}.bs-list::-webkit-scrollbar-thumb{background:#3a4658;border-radius:4px}',
      '.bs-cat{display:flex;justify-content:space-between;align-items:baseline;padding:9px 2px 3px;font-size:9.5px;letter-spacing:1.6px;',
      '  text-transform:uppercase;color:#8a9dad;border-top:1px solid #1d2832}',
      '.bs-cat u,.bs-fs h4 u{text-decoration:none;color:#5f7286;letter-spacing:.4px;text-transform:none;cursor:pointer}',
      '.bs-cat u:hover,.bs-fs h4 u:hover{color:#c8a060}',
      '.bs-row{display:grid;grid-template-columns:minmax(0,1fr) auto 78px;gap:8px;align-items:center;padding:3px 2px;border-bottom:1px solid #161f28}',
      '.bs-row.tg{grid-template-columns:28px minmax(0,1fr) auto 78px}',
      '.bs-row em{font-style:normal;font-size:9px;letter-spacing:.3px;color:#7d90a2;white-space:nowrap}',
      // (round 115) a name too long for its box takes a second line: an ellipsis hid
      // the battery's own word ("81mm Mortar Batt…") at a 1024 px window
      '.bs-row b{color:#cfe0ee;font-weight:600;overflow-wrap:break-word;min-width:0}',
      '.bs-row.has b{color:#e2c088}',
      '.bs-men{color:#6f8598;font-size:10px;text-align:right;white-space:nowrap}',
      '.bs-ctl{display:flex;align-items:center;justify-content:flex-end;gap:6px}',
      '.bs-ctl i{font-style:normal;width:18px;height:18px;line-height:17px;text-align:center;border:1px solid #2f4050;border-radius:3px;',
      '  cursor:pointer;color:#9fb3c4;user-select:none}',
      '.bs-ctl i:hover{border-color:#c8a060;color:#e2c088}',
      '.bs-ctl u{text-decoration:none;min-width:18px;text-align:center;color:#e8dcc4}',
      '.bs-ctl u.z{color:#4a5a6a}',
      '.bs-fs{margin-top:8px;font:11px/1.35 ui-monospace,Menlo,monospace;flex:none;border-top:1px solid #22303d}',
      '.bs-fsg{display:grid;grid-template-columns:1fr 1fr;column-gap:16px}',
      '.bs-fsg .bs-row{grid-template-columns:minmax(0,1fr) 66px}',
      '.bs-fs h4{display:flex;justify-content:space-between;font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:2px;',
      '  text-transform:uppercase;color:#c8a060;margin:6px 0 4px;font-weight:normal}',
      '.bs-note3{font-size:11px;color:#6f8598;font-style:italic;padding:0 22px 10px}',
      '.bs-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;padding:10px 22px;border-top:1px solid #22303d;flex:none}',
      '.bs-warn{flex:1;color:#e8944a;font-size:12px}',
      '.bs-foot button{font:12px ui-serif,Georgia,serif;padding:7px 14px;border-radius:5px;cursor:pointer;border:1px solid #2f4050;',
      '  background:#121a22;color:#9fb3c4}',
      '.bs-foot button:hover{border-color:#c8a060;color:#e2c088}',
      '.bs-foot button.go{border-color:#c8a060;color:#14100a;background:#c8a060;font-weight:700}',
      '.bs-foot button.go:hover{background:#e2c088;color:#14100a}',
      // a narrow window stacks the sides and lets the whole card scroll
      '@media (max-width:760px){.bs-card{max-height:none}.bs-body{grid-template-columns:1fr}.bs-fsg{grid-template-columns:1fr}',
      '  .bs-side+.bs-side{border-left:0;border-top:1px solid #22303d}.bs-list{max-height:50vh}',
      '  .bs-head{flex-direction:column;align-items:flex-start}.bs-keys{text-align:left}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /** The planning half alone (the tests). */
  function use(api) { A = api; syncArmies(); return true; }
  function install(api) {
    if (installed) return true;
    use(api);
    var P = api.Game.prototype;
    P.battleSetup = openSetup;
    P.applyBattleSetup = applyPlan;
    injectStyles();
    installed = true;
    return true;
  }

  window.BattleSetup = {
    install: install, use: use,
    armyOf: armyOf, sideArmy: sideArmy, templatesOf: templatesOf, baseOf: baseOf, preset: preset, approx: approx,
    counted: counted, onField: onField, supportFor: supportFor, defaultSupport: defaultSupport, adaptSupport: adaptSupport,
    harvestZones: harvestZones, fieldZones: fieldZones, facing: facing, expand: expand, layout: layout,
    comrades: comrades, sameSide: sameSide, rosterOf: rosterOf, perArmy: perArmy, cleanCounts: cleanCounts, syncArmies: syncArmies,
    PRESETS: PRESETS, NATIONS: NATIONS, ALLIANCES: ALLIANCES, STORE: STORE,
    isOpen: function () { return !!(UI && (UI.open || UI.pending)); },
  };
})();
