/* ============================================================================
 * CLOSE COMBAT ORDERS — right-click a unit, and choose what it does.
 *
 * Close Combat (Atomic Games, 1996-2000) gives every order the same way.
 * Right-click a unit: a popup lists Move, Move Fast, Sneak, Fire, Smoke,
 * Defend and Ambush, and the ones it cannot carry out are marked. Left-click
 * the order. A move then wants a left-click on the map and leaves a coloured
 * dot there; Fire and Smoke bring up a targeting circle on a line from the
 * unit, coloured for what the shot can see and what it can kill; Defend and
 * Ambush put an arc over the unit for the way it faces. A click anywhere off
 * the menu throws it away. (CC4 manual, "Battlefield controls", pp. 13-18;
 * the text is in tools/close_combat_manual_extract.txt.)
 *
 * This file is that menu and the cursor graphics that go with it.
 *
 * IT DECIDES NOTHING ABOUT THE BATTLE. Every order lands in a Game.command*,
 * a Unit.order* or the squad layer's ccOrder/ccApply (assets/squads.js) that
 * already existed. The read-outs — sight line, kill chance, range — only READ
 * the world: no dice, no state, nothing the simulation will ever see. That
 * matters here more than anywhere: they run every frame the pointer moves,
 * and a picture that took the simulation's dice would make the battle depend
 * on where the mouse was ("art decides nothing", NORMANDY_HANDOFF.md).
 *
 * Three Close Combat rules needed the simulation's help and are in the main
 * file, each beside the code it changes:
 *   - Ambush springs at thirty metres (`ccAmbushR`, read by `_holdsFire`);
 *   - Defend and Ambush leave the man facing the arc he was given, after the
 *     shuffle into cover (`_ccArrive`, applied by `_setPosture`);
 *   - a smoke grenade goes thirty metres, fifteen lying down (`_smokeReach`).
 * ========================================================================== */
(function () {
  'use strict';

  var A = null;        // the api the main file hands in (see `install`)
  var THREE = null;

  // ===========================================================================
  // THE MANUAL
  // ===========================================================================
  /** The seven orders, in Close Combat's order, with its hot keys (p. 13). */
  var CC_MENU = [
    { id: 'move',   t: 'Move',      k: 'Z',
      tip: 'Advance at a walk, ready to fight on the way. They Defend when they get there.' },
    { id: 'fast',   t: 'Move Fast', k: 'X',
      tip: 'Run. Quick, loud and not looking about — they do not stop to shoot, but anyone in the way gets the bayonet. They Defend when they get there.' },
    { id: 'sneak',  t: 'Sneak',     k: 'C',
      tip: 'Crawl, quietly. The slowest way to move and the hardest to see, and they never open fire first. They lie in Ambush when they get there.' },
    { id: 'fire',   t: 'Fire',      k: 'V',
      tip: 'Shoot at what is under the circle — the man, or the ground if nobody is there.' },
    { id: 'smoke',  t: 'Smoke',     k: 'B',
      tip: 'Smoke on the circle. A grenade goes 30 m, 15 m lying down; a mortar or a gun as far as it can shoot.' },
    { id: 'defend', t: 'Defend',    k: 'N',
      tip: 'Stop, get into the nearest cover and fight from it, facing the blue arc. Drag the arc to turn them.' },
    { id: 'ambush', t: 'Ambush',    k: 'M',
      tip: 'Stop, get into cover and hold fire until the enemy is inside 30 metres, facing the green arc.' },
  ];
  var CC_KEY = {};
  for (var ki = 0; ki < CC_MENU.length; ki++) CC_KEY['Key' + CC_MENU[ki].k] = CC_MENU[ki].id;
  /** Palette entries that ARE one of the seven, so "More orders" leaves them out. */
  var CC_COVERED = { cmdFast: 1, cmdSneak: 1, cmdSmoke: 1, cmdDefend: 1, cmdAmbush: 1 };
  var MOVES = { move: 1, fast: 1, sneak: 1 };
  var AIMED = { move: 1, fast: 1, sneak: 1, fire: 1, smoke: 1 };
  /** "Ambushing units only attack when an enemy comes within 30 meters" (p. 18). */
  var AMBUSH_M = 30;
  /** How far a man shifts to get into cover on Defend or Ambush, in cells. */
  var COVER_CELLS = 3;

  /** Every colour is the manual's. */
  var COL = {
    move:   [0.32, 0.58, 1.00],                 // destination dot: Move, blue (p. 13)
    sneak:  [1.00, 0.86, 0.22],                 // …Sneak, yellow
    fast:   [0.72, 0.40, 1.00],                 // …Move Fast, purple
    defend: [0.32, 0.58, 1.00],                 // Defend arc, blue (p. 17)
    ambush: [0.36, 0.92, 0.42],                 // Ambush arc, green (p. 18)
    white:  [0.96, 0.96, 0.96],                 // the circle over nobody (p. 16)
    // the circle over an enemy, by the chance the shot kills him:
    // green 100-60 %, yellow 59-30, red 29-10, black 9-0
    odds:   [[0.32, 0.95, 0.36], [1.00, 0.86, 0.22], [1.00, 0.22, 0.16], [0.03, 0.03, 0.03]],
    clear:  [0.64, 1.00, 0.52],                 // direct fire, clear: light green
    obsc:   [0.10, 0.50, 0.18],                 // …through foliage or smoke: dark green
    block:  [1.00, 0.20, 0.15],                 // …blocked: red
    indSee: [1.00, 0.58, 0.14],                 // indirect fire, in sight: orange
    indBlind: [0.52, 0.32, 0.12],               // …out of sight: brown
  };
  /** The range number: green effective, yellow reduced, black cannot fire (p. 16). */
  var BAND_CSS = { eff: '#62e05a', reduced: '#ffd23a', none: '#000' };
  var ODDS_NAME = ['good', 'fair', 'poor', 'hopeless'];

  function oddsBand(p) { return p >= 0.6 ? 0 : p >= 0.3 ? 1 : p >= 0.1 ? 2 : 3; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ===========================================================================
  // THE ORDERS — what each of the seven does, routed into what already existed
  // ===========================================================================
  function installOrders(P) {
    /** Who an order from the menu goes to: your own men, alive, on their feet
     *  and not riding in something. An enemy you were inspecting is never
     *  given an order (the selection can hold one). */
    P.ccSel = function () {
      var g = this, out = [];
      for (var i = 0; i < this.selection.length; i++) {
        var u = this.selection[i];
        if (u.alive && !u.downed && !u.embarkedIn && g.isFriendly(u)) out.push(u);
      }
      return out;
    };

    function armed(u) { return (u.def.dmg || 0) > 0 || !!(u.def.mg && u.def.mg.dmg > 0); }

    /** Can this selection do it? `why` is what a marked order says (p. 13:
     *  "a tank that has blown a tread can neither Move, Move Fast nor Sneak"). */
    P.ccCan = function (id, sel) {
      sel = sel || this.ccSel();
      if (!sel.length) return { ok: false, why: 'Nobody selected' };
      var i, u;
      if (MOVES[id]) {
        var immob = 0;
        for (i = 0; i < sel.length; i++) {
          u = sel[i];
          if (u.immobilized) { immob++; continue; }
          if ((u.def.spd || 0) > 0) return { ok: true };
        }
        return { ok: false, why: immob ? 'Immobilised — cannot move' : 'Cannot move' };
      }
      if (id === 'fire') {
        for (i = 0; i < sel.length; i++) if (armed(sel[i])) return { ok: true };
        return { ok: false, why: 'No weapon' };
      }
      if (id === 'smoke') {
        if (this.deployment) return { ok: false, why: 'Not before the battle starts' };
        for (i = 0; i < sel.length; i++) if (sel[i].smokeAmmo > 0) return { ok: true };
        return { ok: false, why: 'No smoke' };
      }
      return { ok: true };
    };

    /** Give order `id`. An AIMED order — Move, Move Fast, Sneak, Fire, Smoke
     *  — always waits for a left-click on the map, wherever the menu was
     *  opened (p. 13); Defend and Ambush apply at once.
     *
     *  A right-click on the ground or on an enemy used to count as the aim, so
     *  choosing Move there sent the men straight to wherever the menu had been
     *  opened, before the player had picked anything — "the commands fire upon
     *  release of the command button". Where you right-click decides only
     *  WHOSE orders open. */
    P.ccGive = function (id) {
      var sel = this.ccSel();
      if (!sel.length) return;
      var can = this.ccCan(id, sel);
      if (!can.ok) { this.ui.toast(can.why); return; }
      if (sel.length !== this.selection.length) this.select(sel, false);
      if (AIMED[id]) { this.ccOrder(id); return; }
      this.ccPosture(id, null);
      if (this._refreshOrderBar) this._refreshOrderBar();
    };

    /** Move, Move Fast or Sneak to a point. Before the battle a move is where
     *  the section starts, not a march. */
    P.ccMoveTo = function (id, wx, wz, append) {
      if (this.deployment) { this.deployMove(wx, wz); return; }
      this.ccApply(id, wx, wz, append);
      // Where the dot goes: where the player clicked, which is the front of
      // the formation, not the middle of the slots behind it. Remembered with
      // the order it belongs to (`anchor`), so a later order does not inherit it.
      var all = this.ccSel();
      for (var k = 0; k < all.length; k++) {
        var w = all[k];
        w._ccDot = (w.explicit && w.state === 'move' && !(w.queue && w.queue.length))
          ? { x: wx, z: wz, ax: w.anchor.x, az: w.anchor.z } : null;
      }
      // A Move fights its way forward; Move Fast and Sneak do not (p. 14).
      // The mark is the ORDER — this anchor, this squad goal — so the squad
      // layer re-slotting a straggler keeps it, a route carries it from leg to
      // leg (`_updateMove`), and any other order drops it. `Unit.think` reads
      // it: he stops to fight and then goes on to where he was going.
      var ss = this.ccSel(), seen = [];
      for (var j = 0; j < ss.length; j++) {
        var v = ss[j], q = v.squad;
        // every Close Combat move is marked; its MODE decides whether it
        // fights. A Shift-click adds a leg to the route already marked.
        if (!append) v._ccMoveAt = { x: v.anchor.x, z: v.anchor.z };
        if (q && q._cc && seen.indexOf(q) < 0) {
          seen.push(q);
          if (!append) q._ccMove = q.moveGoal || null;
          if (id === 'move' && !append) q.task = 'Moving';
        }
      }
      // "When a squad of men has moved to a location using Sneak movement,
      // they then prepare to Ambush" (p. 14) — and it is Close Combat's
      // ambush, the one that waits for thirty metres. A vehicle has no
      // terminating posture (`_updateMove`), so it is not given one.
      if (id !== 'sneak') return;
      var sel = this.ccSel(), R = AMBUSH_M / A.WORLD_M;
      for (var i = 0; i < sel.length; i++) {
        var u = sel[i];
        if (u.def.vehicle) continue;
        var t = u.queueTail ? u.queueTail() : u.anchor;
        u._ccArrive = { posture: 'ambush', face: null, ambushR: R, x: t.x, z: t.z };
      }
    };

    /** Fire at a man (or a vehicle): engage him from where they stand. */
    P.ccFireAt = function (foe) {
      var sel = this.ccSel(), seen = [];
      this.commandAttack(foe);
      for (var i = 0; i < sel.length; i++) {
        var s = sel[i].squad;
        if (!s || !s._cc || seen.indexOf(s) >= 0) continue;
        seen.push(s); s.moveGoal = null; s.task = 'Firing';
      }
    };

    /** DEFEND AND AMBUSH. "Units that have been ordered to Defend stop, seek
     *  whatever cover is available, and engage any target of opportunity",
     *  facing the arc; Ambush is the same, holding fire to thirty metres
     *  (pp. 17-18). `at`, when the menu was opened on the ground, is the way
     *  to face; otherwise each man keeps the way he is facing.
     *
     *  The posture is set AT ONCE, where he stands — the order is given the
     *  moment it is given — and the move into cover is a few metres walked
     *  in it: Sneak into an ambush, Move into a defence, so that arriving
     *  re-applies the same posture with the arc he was told to watch. */
    P.ccPosture = function (kind, at) {
      var sel = this.ccSel();
      if (!sel.length) return;
      var R = kind === 'ambush' ? AMBUSH_M / A.WORLD_M : 0, taken = {}, shifted = 0, i, u, seen = [];
      for (i = 0; i < sel.length; i++) {
        u = sel[i];
        u._route = null;
        var face = at ? Math.atan2(at.x - u.pos.x, at.z - u.pos.z) : u.face;
        u._ccArrive = { posture: kind, face: face, ambushR: R, x: u.pos.x, z: u.pos.z };
        if (kind === 'ambush') u.orderAmbush(); else u.orderDefend();
        var s = u.squad;
        if (s && s._cc && seen.indexOf(s) < 0) { seen.push(s); s.moveGoal = null; s.task = kind === 'ambush' ? 'Ambush' : 'Defending'; }
        // Men only. A tank or a gun has its own idea of cover; a man in a
        // building or a hole is already in it; a crew-served weapon that
        // shifts has to be set up again.
        if (this.deployment || u.def.vehicle || u.garrison || u.dugin || u.digT > 0 || u.def.towed
            || u.def.kind === 'atgun' || u.def.kind === 'artillery' || u.def.kind === 'mortar'
            || (u._crewServed && u._crewServed())) continue;
        var c = this.ccCoverNear(u, face, taken);
        if (!c) continue;
        u._setPathTo(c.x, c.z);
        if (!u.path.length) continue;
        u._ccArrive = { posture: kind, face: face, ambushR: R, x: c.x, z: c.z };
        u.state = 'advance';
        u.moveMode = kind === 'ambush' ? 'sneak' : 'normal';
        shifted++;
      }
      this.sfx.order();
      this.ui.toast(kind === 'ambush'
        ? 'Ambush — holding fire until they are inside 30 m' + (shifted ? ' · ' + shifted + ' into cover' : '')
        : 'Defend — engaging from cover' + (shifted ? ' · ' + shifted + ' into cover' : ''));
    };

    /** The best cover a few metres from `u`, better than where he is, inside
     *  his section's frontage, not already picked by a man given the same
     *  order (`taken`), and preferring cover on the side he is to face. Null
     *  if he is already behind something. */
    P.ccCoverNear = function (u, face, taken) {
      var gx0 = A.worldToCell(u.pos.x), gz0 = A.worldToCell(u.pos.z);
      var here = this._coverAtCell(gx0, gz0);
      if (here >= A.coverMin()) return null;
      var best = null, bs = here * 3.2 + 0.3, R = COVER_CELLS, reach = R * A.TILE + 0.01;
      for (var dz = -R; dz <= R; dz++) for (var dx = -R; dx <= R; dx++) {
        if (!dx && !dz) continue;
        var gx = gx0 + dx, gz = gz0 + dz, key = gz * 8192 + gx;
        if (taken[key]) continue;
        var cover = this._coverAtCell(gx, gz);
        if (cover <= here + 0.05) continue;
        if (!this.pathfinder.passable(gx, gz)) continue;
        var wx = A.cellCenter(gx), wz = A.cellCenter(gz);
        var dd = Math.hypot(wx - u.pos.x, wz - u.pos.z);
        if (dd > reach) continue;
        if (u._tetherAt && !u._tetherAt(wx, wz)) continue;
        var fwd = Math.cos(A.angDiff(Math.atan2(wx - u.pos.x, wz - u.pos.z), face));
        var sc = cover * 3.2 - dd * 0.05 + fwd * 0.15;
        if (sc > bs) { bs = sc; best = { x: wx, z: wz, key: key }; }
      }
      if (best) taken[best.key] = 1;
      return best;
    };

    // The keys and the palette give the same two orders the menu does — one
    // Defend and one Ambush in the game, not two of each.
    P.commandDefend = function () { this.ccPosture('defend', null); };
    P.commandAmbush = function () { this.ccPosture('ambush', null); };

    /** Throw away an order waiting for its click. True if there was one. */
    P.ccDisarm = function () {
      var any = !!(this.ccArmed || this.pendingSmoke || this.pendingEngineer || this.pendingFire
        || this.pendingReinforce || this.pendingAssault || this.pendingFace || this.pendingMove);
      if (!any) return false;
      if (this.ccArmed) this.ccCancel();
      this.pendingSmoke = false; this.pendingEngineer = null; this.pendingFire = null;
      this.pendingReinforce = null; this.pendingAssault = false; this.pendingFace = false; this.pendingMove = null;
      if (this._ccm) { this._ccm.legs = 0; this._ccm.foe = null; }
      if (this.ui && this.ui._refreshCommands) this.ui._refreshCommands(true);
      if (this._refreshOrderBar) this._refreshOrderBar();
      this.ui.toast('Order cancelled');
      return true;
    };

    // ---- the armed order's click --------------------------------------------
    var baseOrder = P.ccOrder, baseExec = P.ccExecuteAt;
    var PROMPT = {
      move: 'Move — click where to go (hold Shift for a route)',
      fast: 'Move Fast — click where to go (hold Shift for a route)',
      sneak: 'Sneak — click where to go (hold Shift for a route)',
      fire: 'Fire — click the target', smoke: 'Smoke — click where to put it',
    };
    P.ccOrder = function (id) {
      if (this._ccm) { this._ccm.legs = 0; this._ccm.foe = null; }
      var r = baseOrder.call(this, id);
      if (this.ccArmed === id && PROMPT[id]) this.ui.toast(PROMPT[id]);
      return r;
    };
    /** The left-click an aimed order was waiting for.
     *
     *  Fire lands on the man under the circle if there is one (p. 16) — the
     *  squad layer only knew area fire. A move takes Close Combat's
     *  waypoints: hold Shift and click the legs, and the FIRST click replaces
     *  whatever the men were doing — the squad layer appended it to their old
     *  order instead — and letting go of Shift ends the route (p. 15). */
    P.ccExecuteAt = function (wx, wz, append) {
      var id = this.ccArmed, m = this._ccm || {};
      if (!id) return false;
      if (id === 'fire' && this._ccFoeAt) m.foe = this._ccFoeAt(m.mx, m.my);
      if (id === 'fire' && m.foe && m.foe.alive) {
        this.ccFireAt(m.foe);
        this.ccArmed = null; m.legs = 0; m.foe = null;
        this._refreshOrderBar();
        return true;
      }
      if (MOVES[id]) {
        var legs = m.legs || 0;
        this.ccMoveTo(id, wx, wz, !!append && legs > 0);
        if (append && !this.deployment) { m.legs = legs + 1; this.ccArmed = id; }
        else { m.legs = 0; this.ccArmed = null; }
        this._refreshOrderBar();
        return true;
      }
      m.legs = 0;
      return baseExec.call(this, wx, wz, append);
    };
  }

  // ===========================================================================
  // THE SIGHT LINE — Close Combat's coloured line, read off the world
  // ===========================================================================
  function installSight(P) {
    /** What `a`'s eye sees of a point: 'clear', 'obscured' (foliage, mist or
     *  smoke across it, but not enough to hide it) or 'blocked', with the
     *  range to the first obscurant and to the block (p. 17: "a white number
     *  appears along the targeting line indicating the range to the
     *  obstruction").
     *
     *  The same march as `Game._hasLOSCalc` — the same eye and mark heights,
     *  the same walls, crests, crop budget, mist and smoke — but it does not
     *  stop at the first thing it meets, because the line needs to say where
     *  that was. `b` is the unit at the far end, if there is one. Reads only. */
    P.ccSight = function (a, tx, tz, b) {
      var vh = this._vehLOS !== false;
      var ax = a.pos.x, az = a.pos.z, ay = a.pos.y + ((vh && a.def && a.def.eyeH) || 1.3 * this._losPostureF(a));
      var by = b ? b.pos.y + ((vh && b.def && b.def.markH) || 1.0 * this._losPostureF(b, true))
        : this.terrain.heightAt(tx, tz) + 1.0;
      var dx = tx - ax, dz = tz - az, d = Math.hypot(dx, dz);
      var out = { state: 'clear', obsc: null, block: null, d: d };
      if (d < 0.6) return out;
      var steps = Math.max(2, Math.ceil(d / 1.2));
      var w2c = A.worldToCell, OBS = A.OBS_DEF, HS = A.HSCALE;
      var acx = w2c(ax), acz = w2c(az), bcx = w2c(tx), bcz = w2c(tz);
      var agx = a.garrison ? a.garrison.gx : -99, agz = a.garrison ? a.garrison.gz : -99;
      var bgx = b && b.garrison ? b.garrison.gx : -99, bgz = b && b.garrison ? b.garrison.gz : -99;
      var fol = this.foliage, folStep = fol ? (d / steps) / A.TILE : 0, folSum = 0;
      var fogB = (this.fogBanks && this.fogBanks.banks.length) ? this.fogBanks : null, fogStep = fogB ? d / steps : 0, fogSum = 0;
      var str = (this.structures && this.structures.any) ? this.structures : null;
      var pgx = acx, pgz = acz, pyy = ay;
      var obsc = function (t) { if (out.obsc === null) out.obsc = d * t; };
      var block = function (t) { out.block = d * t; out.state = 'blocked'; return out; };
      for (var i = 1; i < steps; i++) {
        var t = i / steps, x = ax + dx * t, z = az + dz * t, y = ay + (by - ay) * t;
        var gx = w2c(x), gz = w2c(z);
        if (str && str.sightStep(pgx, pgz, gx, gz, y, pyy)) return block(t);
        pgx = gx; pgz = gz; pyy = y;
        if (this.terrain.heightAt(x, z) > y) return block(t);
        if ((gx === acx && gz === acz) || (gx === bcx && gz === bcz) || (gx === agx && gz === agz) || (gx === bgx && gz === bgz)) continue;
        var o = this.obstacles.at(gx, gz);
        var solidO = o && !OBS[o.type].seethrough;
        var floorY = (solidO || fol) ? this.terrain.height(gx, gz) * HS : 0;
        if (solidO && y < floorY + o.height) return block(t);
        if (fol) {
          var oc = fol.occlusionAt(gx, gz, y - floorY) * folStep;
          if (oc > 0) { folSum += oc; obsc(t); if (folSum > fol.losBudget) return block(t); }
        }
        if (fogB) {
          var mist = fogB.at(x, z);
          if (mist > 0.01 && y - this.terrain.heightAt(x, z) < A.FOG_LAYER_H) {
            fogSum += mist * fogStep; obsc(t);
            if (fogSum > A.FOG_LOS_BUDGET) return block(t);
          }
        }
      }
      if (str && (pgx !== bcx || pgz !== bcz) && str.sightStep(pgx, pgz, bcx, bcz, by, pyy)) return block(1);
      // Smoke is one integral over the whole line (`SmokeField.occlusion`),
      // so where it starts is found from the clouds themselves.
      if (window.RTT && this.smoke && this.smoke.clouds.length) {
        var Av = new RTT.Vec3(ax, ay, az), Bv = new RTT.Vec3(tx, by, tz);
        var occ = this.smoke.occlusion(Av, Bv);
        if (occ > 0.05) {
          var first = this._ccSmokeEntry(ax, ay, az, tx, by, tz);
          if (occ > A.smokeBlock()) { out.state = 'blocked'; out.block = first != null ? first : d * 0.5; return out; }
          if (out.obsc === null || (first != null && first < out.obsc)) out.obsc = first != null ? first : d * 0.5;
        }
      }
      if (out.obsc !== null) out.state = 'obscured';
      return out;
    };

    /** Where the line first enters a smoke cloud (horizontal range), or null. */
    P._ccSmokeEntry = function (ax, ay, az, bx, by, bz) {
      var cl = this.smoke.clouds, dx = bx - ax, dy = by - ay, dz = bz - az;
      var L2 = dx * dx + dy * dy + dz * dz, best = null;
      if (L2 < 1e-6) return null;
      var Lh = Math.hypot(dx, dz);
      for (var i = 0; i < cl.length; i++) {
        var c = cl[i], p = c.pos || c.position || c.center, r = c.radius || c.r || 0;
        if (!p || r <= 0) continue;
        var fx = ax - p.x, fy = ay - p.y, fz = az - p.z;
        var B = 2 * (fx * dx + fy * dy + fz * dz), C = fx * fx + fy * fy + fz * fz - r * r;
        var disc = B * B - 4 * L2 * C;
        if (disc < 0) continue;
        var t0 = (-B - Math.sqrt(disc)) / (2 * L2);
        if (t0 < 0) t0 = C < 0 ? 0 : t0;
        if (t0 < 0 || t0 > 1) continue;
        var h = t0 * Lh;
        if (best === null || h < best) best = h;
      }
      return best;
    };
  }

  // ===========================================================================
  // THE KILL CHANCE — the colour of the circle
  // ===========================================================================
  function installOdds(P) {
    /** Close Combat's range number: 'eff' inside the weapon's effective range,
     *  'reduced' too close or too far for full effect, 'none' cannot fire at
     *  all (p. 16-17). Effective range is the one the dispersion model
     *  already uses (`BALLISTICS.effFrac`, `rangeSpread`). */
    P.ccBand = function (u, d) {
      var def = u.def, max = def.rng || 0, min = def.minRng || 0;
      var indirect = def.kind === 'mortar' || def.kind === 'artillery';
      if (max <= 0 || d > max * 1.02) return 'none';
      if (d < min) return indirect ? 'none' : 'reduced';
      if (indirect) return 'eff';
      var ef = A.BALLISTICS.effFrac[def.kind] != null ? A.BALLISTICS.effFrac[def.kind] : A.BALLISTICS.effFrac._default;
      return d <= max * ef ? 'eff' : 'reduced';
    };

    /** The chance ONE order's worth of fire from `u` — a shot, a burst, a
     *  round — puts `foe` out of the fight. An estimate made from the same
     *  terms the fire code uses (dispersion with range and suppression and
     *  weather, the target's presented size and cover, damage against what is
     *  left of him, penetration against the plate he shows), with every
     *  random factor at its mean. It is the colour of a circle, so it needs to
     *  be right about the band, not the second decimal; it reads no dice. */
    P.ccShot = function (u, foe, sight) {
      var d = Math.hypot(foe.pos.x - u.pos.x, foe.pos.z - u.pos.z);
      var band = this.ccBand(u, d), def = u.def, k = def.kind;
      var indirect = k === 'mortar' || k === 'artillery';
      var r = { u: u, d: d, band: band, p: 0, indirect: indirect };
      if (band === 'none') return r;
      if (!indirect && sight && sight.state === 'blocked') return r;
      var C = A.COMBAT, wacc = (this.weather && this.weather.accuracy) || 1;
      var sup = u.suppression || 0, p = 0;
      if (foe.def.vehicle) {
        p = this._ccVsArmour(u, foe, d, wacc, sup);
      } else if (indirect || (def.aoe && !def.mg && (k === 'tank' || k === 'atgun'))) {
        // HE: the burst against a man. The bigger the burst against the
        // dispersion, the better; a man down or dug in is most of the way out
        // of it.
        var disp = indirect ? 1.2 + d * 0.035 : (0.55 + d * 0.011) * A.rangeSpread(def, d);
        disp *= (1 + sup * 1.4) * (2 - wacc);
        var aoe = def.aoe || 2;
        p = clamp((aoe * aoe) / (disp * disp + aoe * aoe), 0, 1) * 0.55;
        if (foe.dugin > 0) p *= 0.3;
        else if (foe.posture === 'prone') p *= 0.6;
        if (indirect && sight && sight.state === 'blocked') p *= 0.6;   // unobserved: no correction
        p *= Math.max(1, (def.burst || 1) * 0.6);
        p = Math.min(p, 0.98);
      } else {
        // Small arms: the error box `Projectiles.fireBullet` draws, at its
        // mean, against the man as he presents himself.
        var spread = k === 'hmg' ? 0.035 : k === 'sniper' ? 0.005 : 0.018;
        var err = d * spread * C.accuracyMul * 0.9 * (1 + sup * 1.6) * (2 - wacc)
          * A.rangeSpread(def, d) * (u._aimSteady ? u._aimSteady() : 1);
        err = Math.max(err, 0.05);
        var size = foe.def.size || 1;
        var pres = foe._presentedFrac ? foe._presentedFrac() : 1;
        var pLat = Math.min(1, size * 0.62 / (2 * err));
        var pVert = Math.min(1, size * 1.5 * pres / (0.9 * err));
        var cover = foe._coverValue ? foe._coverValue() : 0;
        var hit = pLat * pVert * (1 - cover * 0.7);
        var dmg = (def.dmg || 0) * (u.dmgMult ? u.dmgMult() : 1) * (C.lethality || 1);
        var kill = Math.min(1, dmg / Math.max(1, foe.hp || foe.maxHp || 100));
        var shots = k === 'hmg' ? 6 : (def.burst && def.burst > 1 ? Math.min(def.burst, 5) : 1);
        p = 1 - Math.pow(1 - hit * kill, shots);
      }
      if (!indirect && sight && sight.state === 'obscured') p *= 0.35;   // fire into the smoke on spec
      r.p = clamp(p, 0, 1);
      return r;
    };

    /** A gun or a rocket against a vehicle: hit, then the plate it shows. */
    P._ccVsArmour = function (u, foe, d, wacc, sup) {
      var def = u.def, fd = foe.def, k = def.kind;
      var pen0 = def.pen || 0;
      if (!pen0) {
        // A bullet does nothing to armour. An open-topped vehicle's crew is
        // another matter, and a lorry is a lorry.
        if (fd.openTop || !fd.plates) return (def.dmg || 0) > 0 ? (fd.plates ? 0.05 : 0.25) : 0;
        return 0;
      }
      var heat = k === 'rocket';
      var disp = (0.55 + d * 0.011) * A.rangeSpread(def, d) * (1 + sup * 1.4) * (2 - wacc);
      var size = fd.size || 2;
      var hit = Math.min(1, size / (2 * disp)) * Math.min(1, size * 0.8 / (2 * disp));
      var pen = heat ? pen0 : pen0 * (1 - 0.5 * Math.min(1, d / A.BALLISTICS.penRange));
      var pl = fd.plates;
      if (!pl) return hit * 0.8;
      // Which face he shows: the bearing from him to the gun against the way
      // his hull points.
      var bear = Math.atan2(u.pos.x - foe.pos.x, u.pos.z - foe.pos.z);
      var off = Math.abs(A.angDiff(bear, foe.face || 0));
      var T, slope;
      if (off < Math.PI / 4) { T = pl.front; slope = pl.frontSlope || 0; }
      else if (off > Math.PI * 3 / 4) { T = pl.rear; slope = 0; }
      else { T = pl.side; slope = pl.sideSlope || 0; }
      var teff = (T || 1) / Math.max(0.05, Math.cos(slope * Math.PI / 180)) * (1 + A.SLOPE_BONUS * Math.pow(slope / 90, 2));
      var ratio = pen / teff;
      // `Unit.takeDamage`'s own table: a clean penetration, a glance, nothing.
      var pk = ratio >= 1 ? clamp(0.45 + 0.55 * (ratio - 1), 0.45, 1) : ratio >= 0.85 ? 0.15 : 0.02;
      return hit * pk;
    };

    /** The whole selection's chance against one man: one or more of them
     *  gets him. `rows` keeps each firer's own answer for the lines. */
    P.ccOdds = function (shooters, foe, sights) {
      var miss = 1, rows = [];
      for (var i = 0; i < shooters.length; i++) {
        var r = this.ccShot(shooters[i], foe, sights ? sights[i] : null);
        rows.push(r);
        miss *= 1 - r.p;
      }
      return { p: 1 - miss, rows: rows };
    };
  }

  // ===========================================================================
  // THE MENU
  // ===========================================================================
  function installMenu(P) {
    /** What the menu's header calls the selection. */
    P.ccSelName = function (sel) {
      if (!sel.length) return '';
      var sq = sel[0].squad;
      if (sq && sel.length > 1 && sel.every(function (u) { return u.squad === sq; })) return (sq.name || ('Squad ' + sq.id)) + ' · ' + sel.length;
      if (sel.length === 1) return sel[0].def.name;
      return sel.length + (sel.some(function (u) { return u.def.vehicle; }) ? ' units' : ' men');
    };

    /** A right-click on the battlefield. Called from `Input.onDown` before
     *  anything else the right button does; true means it was handled.
     *
     *  On one of your own men it selects him (his section, as a left-click
     *  would) and opens his orders — Close Combat. With men already selected,
     *  a right-click anywhere else opens THEIR orders, so a man too small to
     *  hit is never in the way. It aims nothing: an aimed order still waits
     *  for its click (`ccGive`). The only things the right-click itself
     *  offers are what is under it — a lorry the riflemen could board, a
     *  building they could go into. */
    P.ccMenuRmb = function (e, input) {
      if (this.mode !== 'play' || this.fpv || this.ccMenuOff) return false;
      // An order waiting for its click: the right button throws it away.
      if (this.ccDisarm()) return true;
      var g = this, sel = this.ccSel();
      var mine = input.pickUnit(e, true, { filter: function (v) { return g.isFriendly(v); } });
      var foe = sel.length ? input.pickUnit(e, true, { filter: function (v) { return g.isFoe(v); } }) : null;
      // Both within reach of the pointer: the one it is nearer. Yours on a tie
      // — right-clicking your own man is what the button is for.
      if (mine && foe && this._ccScreenDist(foe, e) + 4 < this._ccScreenDist(mine, e)) mine = null;
      var at = null;
      if (mine) {
        var inSel = this.selection.indexOf(mine) >= 0;
        var room = mine.def.capacity && (!mine.passengers || mine.passengers.length < mine.def.capacity);
        var riders = sel.some(function (u) { return !u.def.vehicle && !u.def.towed && !u.garrison; });
        if (!inSel && room && riders) at = { x: mine.pos.x, z: mine.pos.z, board: mine };
        else if (!inSel) { this.selectUnit(mine, e.shiftKey, e.altKey); if (input._cyc) for (var i = 0; i < this.selection.length; i++) input._cyc.seen.add(this.selection[i]); }
      } else if (foe) {
        at = null;                        // his orders, not an order AT him
      } else {
        if (!sel.length) return false;
        var p = input.groundPoint(e);
        if (!p) return false;
        var gcx = A.worldToCell(p.x), gcz = A.worldToCell(p.z);
        var foot = sel.some(function (u) { return !u.def.vehicle && !u.def.towed && !u.garrison; });
        if (foot && !this.deployment) {
          if (this.structures && this.structures.any && this.structures.has(gcx, gcz) && this.structures.insideAt(gcx, gcz, 0) >= 0.35) at = { x: p.x, z: p.z, strc: { gx: gcx, gz: gcz } };
          else { var b = this.obstacles.buildingAt(gcx, gcz); if (b) at = { x: p.x, z: p.z, bldg: b }; }
        }
      }
      if (!this.ccSel().length) return false;
      this.ccMenuOpen(e.clientX, e.clientY, at);
      return true;
    };

    P._ccScreenDist = function (u, e) {
      var v = this._ccV || (this._ccV = new THREE.Vector3());
      v.set(u.pos.x, u.pos.y + (u.def.size || 1) * 0.55, u.pos.z).project(this.camera);
      var sx = (v.x + 1) / 2 * window.innerWidth, sy = (-v.y + 1) / 2 * window.innerHeight;
      return Math.hypot(sx - e.clientX, sy - e.clientY);
    };

    /** The state the men are in now, for the menu to light (gold, as the
     *  order bar did). */
    P._ccNow = function (sel) {
      var n = { defend: 0, ambush: 0, move: 0, fast: 0, sneak: 0 };
      for (var i = 0; i < sel.length; i++) {
        var u = sel[i];
        if (u.path && u.path.length) n[u.moveMode === 'fast' ? 'fast' : u.moveMode === 'sneak' ? 'sneak' : 'move']++;
        else if (u.posture === 'defend' || u.posture === 'ambush') n[u.posture]++;
      }
      var best = null, bn = 0;
      for (var k in n) if (n[k] > bn) { bn = n[k]; best = k; }
      return bn * 2 >= sel.length ? best : null;
    };

    P.ccMenuOpen = function (cx, cy, at) {
      var m = this._ccm, sel = this.ccSel();
      if (!m || !sel.length) return;
      this.ccMenuClose();
      m.at = at; m.units = sel.slice(); m.open = true;
      var now = this._ccNow(sel), h = '<div class="ccm-h">' + esc(this.ccSelName(sel)) + '</div>';
      // Before anything else, the one thing a right-click on a lorry with
      // riflemen selected obviously meant.
      if (at && at.board) h += '<div class="ccm-i ccm-x" data-x="board"><b>Board ' + esc(at.board.def.name) + '</b><u>↵</u></div><div class="ccm-sep"></div>';
      for (var i = 0; i < CC_MENU.length; i++) {
        var o = CC_MENU[i], can = this.ccCan(o.id, sel);
        var tip = can.ok ? o.tip : can.why;
        h += '<div class="ccm-i' + (can.ok ? '' : ' off') + (now === o.id && can.ok ? ' on' : '') + '" data-o="' + o.id + '" title="' + esc(tip) + '">'
          + '<b>' + o.t + '</b><u>' + o.k + '</u></div>';
      }
      // What only applies here, now: the building under the click, the
      // vehicle they are in, the gun that has to be limbered.
      var x = '';
      if (at && (at.strc || at.bldg)) x += '<div class="ccm-i ccm-x" data-x="enter"><b>Enter building</b><u></u></div>';
      var D = A.COMMAND_DEFS, g = this;
      var ctx = ['cmdUnload', 'cmdExitBldg', 'cmdLimber'];
      for (i = 0; i < ctx.length; i++) {
        var d = D.find(function (q) { return q.id === ctx[i]; });
        if (!d || (d.show && !d.show(sel, g))) continue;
        var lbl = d.id === 'cmdLimber' ? (sel.some(function (u) { return u.limbered; }) ? 'Unlimber' : 'Limber') : d.t === 'Exit Bldg' ? 'Leave building' : d.t;
        x += '<div class="ccm-i ccm-x" data-p="' + d.id + '" title="' + esc(d.tip) + '"><b>' + esc(lbl) + '</b><u>' + esc(d.k || '') + '</u></div>';
      }
      if (at && at.board) x += '<div class="ccm-i ccm-x" data-x="select"><b>Orders for the ' + esc(at.board.def.name) + '</b><u></u></div>';
      if (x) h += '<div class="ccm-sep"></div>' + x;
      h += '<div class="ccm-sep"></div><div class="ccm-i ccm-more" data-x="more"><b>More orders</b><u>▸</u></div>';
      m.el.innerHTML = h;
      m.el.style.display = 'block';
      this._ccPlace(m.el, cx, cy);
      m.hl = -1;
    };

    /** Keep a popup on the screen. */
    P._ccPlace = function (el, cx, cy) {
      var W = window.innerWidth, H = window.innerHeight;
      el.style.left = '0px'; el.style.top = '0px';
      var w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = Math.max(4, Math.min(cx + 2, W - w - 4)) + 'px';
      el.style.top = Math.max(4, Math.min(cy + 2, H - h - 4)) + 'px';
    };

    /** "More orders": everything else the ORDERS palette (COMMAND_DEFS) can
     *  do for this selection, grouped the way the palette groups it. Each
     *  entry runs the palette's own `run`, so nothing is implemented twice. */
    P._ccMoreOpen = function () {
      var m = this._ccm, sel = this.ccSel(), g = this;
      if (!m.open || !sel.length) return;
      var D = A.COMMAND_DEFS, G = A.COMMAND_GROUPS, h = '';
      for (var gi = 0; gi < G.length; gi++) {
        var rows = '';
        for (var i = 0; i < D.length; i++) {
          var d = D[i];
          if (d.g !== G[gi] || CC_COVERED[d.id]) continue;
          if (d.show && !d.show(sel, g)) continue;
          var on = d.on && d.on(sel, g);
          rows += '<div class="ccm-i' + (on ? ' on' : '') + '" data-p="' + d.id + '" title="' + esc(d.tip) + '">'
            + '<b><i>' + d.ic + '</i> ' + esc(d.t) + '</b><u>' + esc(d.k || '') + '</u></div>';
        }
        if (rows) h += '<div class="ccm-g">' + esc(G[gi]) + '</div>' + rows;
      }
      h += '<div class="ccm-sep"></div><div class="ccm-i" data-x="bar" title="The two-row order bar along the bottom of the screen, as it was before this menu">'
        + '<b>' + (this.ccBarShown ? 'Hide' : 'Show') + ' the order bar</b><u></u></div>';
      m.more.innerHTML = h;
      m.more.style.display = 'block';
      var r = m.el.getBoundingClientRect(), W = window.innerWidth, w = m.more.offsetWidth;
      var left = r.right + w + 4 <= W ? r.right - 1 : Math.max(4, r.left - w + 1);
      this._ccPlace(m.more, left, r.top);
      m.more.style.left = left + 'px';
    };

    P.ccMenuClose = function () {
      var m = this._ccm;
      if (!m || !m.open) return;
      m.open = false; m.at = null;
      m.el.style.display = 'none'; m.more.style.display = 'none';
    };

    /** A menu entry was chosen. */
    P._ccPick = function (it) {
      var m = this._ccm, at = m.at;
      if (it.classList.contains('off')) { this.ui.toast(it.title || 'Not possible'); return; }
      var o = it.dataset.o, p = it.dataset.p, x = it.dataset.x;
      if (x === 'more') { if (m.more.style.display === 'block') m.more.style.display = 'none'; else this._ccMoreOpen(); return; }
      // The selection the menu was opened for, whatever happened since.
      var live = m.units.filter(function (u) { return u.alive && !u.downed; });
      this.ccMenuClose();
      if (!live.length) return;
      if (live.length !== this.selection.length || live.some(function (u, i) { return this.selection[i] !== u; }, this)) this.select(live, false);
      if (o) { this.ccGive(o); return; }
      if (x === 'board') { this.commandLoad(at.board); return; }
      if (x === 'select') { this.selectUnit(at.board, false, false); return; }
      if (x === 'enter') {
        if (at.strc && this.commandOccupy(at.strc.gx, at.strc.gz)) return;
        var b = at.bldg || this.obstacles.buildingAt(A.worldToCell(at.x), A.worldToCell(at.z));
        if (b) this.commandGarrison(b); else this.ui.toast('No way in there');
        return;
      }
      if (x === 'bar') { this.ccShowBar(!this.ccBarShown); return; }
      if (p) {
        var d = A.COMMAND_DEFS.find(function (q) { return q.id === p; });
        if (!d) return;
        if (d.arm && this.ccArmed) this.ccCancel();
        d.run(this);
        if (this.ui && this.ui._refreshCommands) this.ui._refreshCommands(true);
        if (this._refreshOrderBar) this._refreshOrderBar();
      }
    };

    /** The order bar (assets/squads.js) is still there for anyone who wants
     *  it, off by default: the menu is the way orders are given now. */
    P.ccShowBar = function (on) {
      this.ccBarShown = !!on;
      document.body.classList.toggle('cc-menu', !on);
      try { localStorage.setItem('tc.ccBar', on ? '1' : '0'); } catch (e) { /* private window */ }
      if (this._refreshOrderBar) this._refreshOrderBar();
      this.ui.toast('Order bar ' + (on ? 'shown' : 'hidden') + ' — right-click a unit for its orders');
    };
  }

  // ===========================================================================
  // THE CURSOR — dot, circle, line, arcs
  // ===========================================================================
  var CAP = 16000;   // overlay vertices

  function installAim(P) {
    /** Build the overlay (one vertex-coloured mesh, drawn over everything —
     *  the same shape as `Game.orderLines`), the popups and the labels, and
     *  take the events. Called once, from `install`. */
    P.installCCMenu = function () {
      if (this._ccm) return;
      var g = this;
      var pos = new Float32Array(CAP * 3), col = new Float32Array(CAP * 3);
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false,
        side: THREE.DoubleSide, toneMapped: false, fog: false }));
      mesh.frustumCulled = false; mesh.renderOrder = 8; mesh.visible = false;
      this.scene.add(mesh);
      var el = document.createElement('div'); el.id = 'ccMenu'; el.className = 'ccm';
      var more = document.createElement('div'); more.id = 'ccMenuMore'; more.className = 'ccm';
      var rng = document.createElement('div'); rng.id = 'ccmRng';
      document.body.appendChild(el); document.body.appendChild(more); document.body.appendChild(rng);
      var obs = [];
      for (var i = 0; i < 4; i++) { var o = document.createElement('div'); o.className = 'ccm-ob'; document.body.appendChild(o); obs.push(o); }
      this._ccm = {
        el: el, more: more, rng: rng, obs: obs, mesh: mesh, pos: pos, col: col, n: 0,
        open: false, at: null, units: [], legs: 0, foe: null, drag: null, arcs: [], dest: null,
        ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), v: new THREE.Vector3(),
        mx: -1, my: -1, aimT: 0, aimKey: '', aim: null,
      };
      // AN ENTRY ACTS WHEN THE BUTTON IS LET GO OVER IT, like any menu: the
      // press only marks it. Acting on the press closed the menu under the
      // pointer, so the release landed on the battlefield behind it.
      var press = function (e) {
        e.stopPropagation(); e.preventDefault();
        if (e.button === 2) { g.ccMenuClose(); return; }   // right-click again cancels (p. 9)
        if (e.button !== 0) return;
        g._ccm.press = e.target.closest ? e.target.closest('.ccm-i') : null;
      };
      var release = function (e) {
        e.stopPropagation(); e.preventDefault();
        var m = g._ccm, it = e.target.closest ? e.target.closest('.ccm-i') : null;
        var was = m.press; m.press = null;
        if (e.button !== 0 || !it || it !== was) return;
        g._ccPick(it);
      };
      el.addEventListener('mousedown', press); more.addEventListener('mousedown', press);
      el.addEventListener('mouseup', release); more.addEventListener('mouseup', release);
      el.addEventListener('mouseover', function (e) {
        var it = e.target.closest ? e.target.closest('.ccm-i') : null;
        if (it && it.dataset.x === 'more' && more.style.display !== 'block') g._ccMoreOpen();
      });
      var noMenu = function (e) { e.preventDefault(); };
      el.addEventListener('contextmenu', noMenu); more.addEventListener('contextmenu', noMenu);
      el.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
      window.addEventListener('mousedown', function (e) { g._ccDown(e); }, true);
      window.addEventListener('mousemove', function (e) { g._ccMove(e); }, true);
      window.addEventListener('mouseup', function (e) { g._ccUp(e); }, true);
      window.addEventListener('keydown', function (e) { g._ccmKey(e, true); }, true);
      window.addEventListener('keyup', function (e) { g._ccmKey(e, false); }, true);
      window.addEventListener('resize', function () { g.ccMenuClose(); });
      window.addEventListener('blur', function () { g.ccMenuClose(); if (g._ccm) g._ccm.drag = null; });
      var shown = false;
      try { shown = localStorage.getItem('tc.ccBar') === '1'; } catch (e) { /* private window */ }
      this.ccBarShown = shown;
      document.body.classList.toggle('cc-menu', !shown);
    };

    function anyArmed(g) {
      return !!(g.ccArmed || g.pendingSmoke || g.pendingEngineer || g.pendingFire || g.pendingReinforce
        || g.pendingRoute || g.pendingAssault || g.pendingFace || g.pendingMove);
    }
    function typing(e) {
      var t = e.target;
      return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    }

    /** Every mouse-down, before the game sees it. A click anywhere off an open
     *  menu throws the menu away and does nothing else (p. 13: "either right
     *  or left-clicking on the map removes the popup menu"). A left-click on
     *  a facing arc or a destination dot picks it up to drag. */
    P._ccDown = function (e) {
      var m = this._ccm, cv = this.renderer.domElement;
      if (!m) return;
      if (e.target === cv) { m.mx = e.clientX; m.my = e.clientY; }
      if (m.open) {
        if (m.el.contains(e.target) || m.more.contains(e.target)) return;
        this.ccMenuClose();
        if (e.target === cv) { e.stopPropagation(); e.preventDefault(); }
        return;
      }
      if (m.drag && m.drag.sticky) {               // the click that sets a picked-up arc
        if (e.target === cv) { e.stopPropagation(); e.preventDefault(); }
        if (e.button === 0) this._ccDrop(e); else m.drag = null;
        return;
      }
      if (e.target !== cv || e.button !== 0 || this.mode !== 'play' || this.fpv) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || anyArmed(this)) return;
      var hit = this._ccGrab(e.clientX, e.clientY);
      if (!hit) return;
      e.stopPropagation(); e.preventDefault();
      hit.x0 = e.clientX; hit.y0 = e.clientY;
      m.drag = hit;
    };
    P._ccMove = function (e) {
      var m = this._ccm;
      if (!m) return;
      m.mx = e.clientX; m.my = e.clientY;
      if (m.drag) {
        var p = this._ccGround(e.clientX, e.clientY);
        if (p) { m.drag.px = p.x; m.drag.pz = p.z; }
      }
    };
    P._ccUp = function (e) {
      var m = this._ccm;
      if (!m || !m.drag || e.button !== 0 || m.drag.sticky) return;
      // A click without a drag picks the arc up; the next click puts it down
      // — Close Combat's way (p. 17). A drag puts it down on release.
      if (Math.hypot(e.clientX - m.drag.x0, e.clientY - m.drag.y0) < 5) { m.drag.sticky = true; return; }
      this._ccDrop(e);
    };
    P._ccDrop = function (e) {
      var m = this._ccm, d = m.drag;
      m.drag = null;
      var p = this._ccGround(e.clientX, e.clientY);
      if (!d || !p) return;
      if (d.kind === 'dest') { this._ccRedirect(d, p.x, p.z); return; }
      var ang = Math.atan2(p.x - d.cx, p.z - d.cz);
      for (var i = 0; i < d.units.length; i++) {
        var u = d.units[i];
        if (!u.alive || u.downed) continue;
        // Still shuffling into cover: he faces it when he gets there.
        if (u._ccArrive && u.path && u.path.length) { u._ccArrive.face = ang; continue; }
        u.orderFace(u.pos.x + Math.sin(ang) * 60, u.pos.z + Math.cos(ang) * 60);
      }
      this.sfx.order();
    };
    /** The dot was dragged: the same move, to the new place (p. 13). */
    P._ccRedirect = function (d, wx, wz) {
      var live = d.units.filter(function (u) { return u.alive && !u.downed; });
      if (!live.length) return;
      this.select(live, false);
      var id = d.mode === 'fast' ? 'fast' : d.mode === 'sneak' ? 'sneak' : 'move';
      this.ccMoveTo(id, wx, wz, false);
    };

    /** Keys, before the game sees them. With the menu open the seven letters
     *  are the seven orders and Escape shuts it; otherwise only the end of a
     *  Shift-held route, and Escape dropping a picked-up arc. */
    P._ccmKey = function (e, down) {
      var m = this._ccm;
      if (!m || typing(e)) return;
      if (down && m.open) {
        if (e.code === 'Escape') { this.ccMenuClose(); e.stopPropagation(); e.preventDefault(); return; }
        var id = CC_KEY[e.code];
        if (id && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.stopPropagation(); e.preventDefault();
          var it = m.el.querySelector('.ccm-i[data-o="' + id + '"]');
          if (it) this._ccPick(it);
          return;
        }
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
          var bd = m.el.querySelector('.ccm-i[data-x="board"]');
          if (bd) { e.stopPropagation(); e.preventDefault(); this._ccPick(bd); }
        }
        return;
      }
      if (down && e.code === 'Escape' && m.drag) { m.drag = null; e.stopPropagation(); e.preventDefault(); return; }
      // Let go of Shift and the route is laid: "When you have completed your
      // path, release the shift key and the unit proceeds as ordered" (p. 15).
      if (!down && (e.code === 'ShiftLeft' || e.code === 'ShiftRight') && this.ccArmed && MOVES[this.ccArmed] && m.legs > 0) {
        this.ccArmed = null; m.legs = 0;
        if (this._refreshOrderBar) this._refreshOrderBar();
      }
    };

    /** The ground under a screen point. A march along the ray against the
     *  height field rather than a raycast of the terrain mesh: it runs every
     *  frame the cursor is aiming, and the mesh is the biggest thing in the
     *  scene. */
    P._ccGround = function (sx, sy) {
      var m = this._ccm, T = this.terrain;
      m.ndc.set(sx / window.innerWidth * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
      m.ray.setFromCamera(m.ndc, this.camera);
      var o = m.ray.ray.origin, d = m.ray.ray.direction;
      var t = 0.5, prev = 0;
      for (var k = 0; k < 900 && t < 4000; k++) {
        var x = o.x + d.x * t, z = o.z + d.z * t;
        if (o.y + d.y * t <= T.heightAt(x, z)) {
          var lo = prev, hi = t;
          for (var b = 0; b < 12; b++) {
            var mid = (lo + hi) / 2;
            if (o.y + d.y * mid <= T.heightAt(o.x + d.x * mid, o.z + d.z * mid)) hi = mid; else lo = mid;
          }
          x = o.x + d.x * hi; z = o.z + d.z * hi;
          if (!A.inGrid(A.worldToCell(x), A.worldToCell(z))) return null;
          return { x: x, z: z };
        }
        prev = t; t += Math.max(0.35, t * 0.01);
      }
      return null;
    };

    // ---- drawing helpers -----------------------------------------------------
    function vtx(m, x, y, z, c) {
      var i = m.n * 3;
      m.pos[i] = x; m.pos[i + 1] = y; m.pos[i + 2] = z;
      m.col[i] = c[0]; m.col[i + 1] = c[1]; m.col[i + 2] = c[2];
      m.n++;
    }
    function quad(m, a1, a2, b1, b2, c) {
      if (m.n + 6 > CAP) return;
      vtx(m, a1[0], a1[1], a1[2], c); vtx(m, a2[0], a2[1], a2[2], c); vtx(m, b1[0], b1[1], b1[2], c);
      vtx(m, a2[0], a2[1], a2[2], c); vtx(m, b2[0], b2[1], b2[2], c); vtx(m, b1[0], b1[1], b1[2], c);
    }
    /** A flat ribbon on the ground from A to B. */
    P._ccFlat = function (ax, az, bx, bz, hw, c, lift) {
      var m = this._ccm, T = this.terrain, L = Math.hypot(bx - ax, bz - az) || 1;
      var px = -(bz - az) / L * hw, pz = (bx - ax) / L * hw, l = lift || 0.3;
      var ya = T.heightAt(ax, az) + l, yb = T.heightAt(bx, bz) + l;
      quad(m, [ax + px, ya, az + pz], [ax - px, ya, az - pz], [bx + px, yb, bz + pz], [bx - px, yb, bz - pz], c);
    };
    /** An arc on the ground: centre, radius, from angle a0 to a1 (0 = +z). */
    P._ccArc = function (cx, cz, r, a0, a1, hw, c, lift) {
      var seg = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 0.12));
      var px = cx + Math.sin(a0) * r, pz = cz + Math.cos(a0) * r;
      for (var s = 1; s <= seg; s++) {
        var a = a0 + (a1 - a0) * s / seg, x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
        this._ccFlat(px, pz, x, z, hw, c, lift);
        px = x; pz = z;
      }
    };
    /** A camera-facing ribbon in the air (a sight line). */
    P._ccLine = function (ax, ay, az, bx, by, bz, hw, c) {
      var m = this._ccm, cam = this.camera.position;
      var dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz) || 1;
      dx /= L; dy /= L; dz /= L;
      var vx = cam.x - (ax + bx) / 2, vy = cam.y - (ay + by) / 2, vz = cam.z - (az + bz) / 2;
      var px = dy * vz - dz * vy, py = dz * vx - dx * vz, pz = dx * vy - dy * vx;
      var pl = Math.hypot(px, py, pz) || 1;
      px = px / pl * hw; py = py / pl * hw; pz = pz / pl * hw;
      quad(m, [ax + px, ay + py, az + pz], [ax - px, ay - py, az - pz], [bx + px, by + py, bz + pz], [bx - px, by - py, bz - pz], c);
    };
    /** A filled dot (a flat octagon). */
    P._ccDot = function (x, z, r, c) {
      var m = this._ccm, y = this.terrain.heightAt(x, z) + 0.34;
      for (var s = 0; s < 8; s++) {
        if (m.n + 3 > CAP) return;
        var a0 = s / 8 * Math.PI * 2, a1 = (s + 1) / 8 * Math.PI * 2;
        vtx(m, x, y, z, c);
        vtx(m, x + Math.sin(a0) * r, y, z + Math.cos(a0) * r, c);
        vtx(m, x + Math.sin(a1) * r, y, z + Math.cos(a1) * r, c);
      }
    };
    /** World units per screen pixel at a point — so a dot, a circle or a
     *  line keeps a size you can see at every zoom, as Close Combat's did. */
    P._ccPx = function (x, y, z) {
      var c = this.camera, d = Math.hypot(c.position.x - x, c.position.y - y, c.position.z - z);
      return d * 2 * Math.tan(c.fov * Math.PI / 360) / window.innerHeight;
    };
    P._ccToScreen = function (x, y, z) {
      var v = this._ccm.v.set(x, y, z).project(this.camera);
      if (v.z > 1) return null;
      return { x: (v.x + 1) / 2 * window.innerWidth, y: (-v.y + 1) / 2 * window.innerHeight };
    };
    /** Units that can put fire on something: the selection minus the unarmed. */
    function firers(sel) {
      var out = [];
      for (var i = 0; i < sel.length && out.length < 16; i++) {
        var u = sel[i];
        if ((u.def.dmg || 0) > 0 || (u.def.mg && u.def.mg.dmg > 0)) out.push(u);
      }
      return out;
    }

    // ---- the frame --------------------------------------------------------------
    /** Draw the cursor's graphics for this frame. Runs straight after the
     *  order lines (`_updateOrderVis`, wrapped below). */
    P._ccFrame = function () {
      var m = this._ccm;
      if (!m) return;
      if (m.mesh.parent !== this.scene) this.scene.add(m.mesh);
      m.n = 0;
      var aimLbl = null, obLbls = [];
      var live = this.mode === 'play' && !this.fpv;
      if (live) {
        var sel = this.ccSel(), id = this.ccArmed;
        if (id && AIMED[id] && sel.length && m.mx >= 0) {
          var res = this._ccAimDraw(id, sel);
          if (res) { aimLbl = res.lbl; obLbls = res.obs || []; }
        } else { m.foe = null; m.aim = null; }
        this._ccArcsDraw(sel);
        this._ccDestDraw(sel);
      } else { m.foe = null; m.arcs = []; m.dest = null; m.drag = null; if (m.open) this.ccMenuClose(); }
      // labels
      if (aimLbl) {
        m.rng.style.display = 'block';
        m.rng.style.left = Math.round(aimLbl.x + 14) + 'px'; m.rng.style.top = Math.round(aimLbl.y + 10) + 'px';
        if (m.rng.textContent !== aimLbl.text) m.rng.textContent = aimLbl.text;
        m.rng.className = aimLbl.band === 'none' ? 'none' : '';
        m.rng.style.color = BAND_CSS[aimLbl.band] || '#fff';
      } else if (m.rng.style.display !== 'none') m.rng.style.display = 'none';
      for (var i = 0; i < m.obs.length; i++) {
        var L = obLbls[i], el = m.obs[i];
        if (!L) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
        el.style.display = 'block';
        el.style.left = Math.round(L.x + 6) + 'px'; el.style.top = Math.round(L.y - 18) + 'px';
        if (el.textContent !== L.text) el.textContent = L.text;
      }
      var geo = m.mesh.geometry;
      geo.setDrawRange(0, m.n);
      if (m.n) { geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; }
      m.mesh.visible = m.n > 0;
    };

    /** An aimed order is waiting for its click: draw what the click would do. */
    P._ccAimDraw = function (id, sel) {
      var m = this._ccm, p = this._ccGround(m.mx, m.my);
      if (!p) { m.foe = null; return null; }
      var T = this.terrain, i;
      if (MOVES[id]) {
        // The destination dot, in the colour of the way they will go (p. 13).
        var c = COL[id], px = this._ccPx(p.x, T.heightAt(p.x, p.z), p.z);
        this._ccDot(p.x, p.z, Math.max(0.6, 6 * px), c);
        this._ccArc(p.x, p.z, Math.max(1.1, 11 * px), 0, Math.PI * 2, Math.max(0.06, 1.2 * px), c, 0.32);
        if (m.legs > 0) {
          var sc = this._ccToScreen(p.x, T.heightAt(p.x, p.z), p.z);
          return sc ? { lbl: { x: sc.x, y: sc.y, text: 'leg ' + (m.legs + 1), band: 'eff' } } : null;
        }
        return null;
      }
      if (id === 'smoke') return this._ccSmokeDraw(sel, p);
      var foe = m.foe = this._ccFoeAt(m.mx, m.my);
      var fs = firers(sel);
      if (!fs.length) return null;
      var tx = foe ? foe.pos.x : p.x, tz = foe ? foe.pos.z : p.z;
      // The arithmetic is cheap per man but it is a march per man: recompute
      // when the aim moves or every tenth of a second, not every frame.
      var key = (foe ? 'f' + this.units.indexOf(foe) : '') + '|' + Math.round(tx * 4) + '|' + Math.round(tz * 4) + '|' + fs.length;
      var now = performance.now();
      if (!m.aim || m.aimKey !== key || now - m.aimT > 100) {
        var sights = [];
        for (i = 0; i < fs.length; i++) sights.push(this.ccSight(fs[i], tx, tz, foe));
        var odds = foe ? this.ccOdds(fs, foe, sights) : null;
        var rows = [];
        for (i = 0; i < fs.length; i++) {
          var dd = Math.hypot(tx - fs[i].pos.x, tz - fs[i].pos.z);
          rows.push({ u: fs[i], s: sights[i], d: dd, band: this.ccBand(fs[i], dd) });
        }
        m.aim = { odds: odds, rows: rows };
        m.aimKey = key; m.aimT = now;
      }
      var A2 = m.aim, ty = T.heightAt(tx, tz), px2 = this._ccPx(tx, ty, tz);
      // the lines, one per man (p. 17: line of sight is every soldier's own)
      // The number is the range from the middle of the selection — Close
      // Combat's team was a few men standing together — and the obstruction
      // numbers are those of the man standing nearest that middle.
      var mx = 0, mz = 0, nl = 0;
      for (i = 0; i < A2.rows.length; i++) if (A2.rows[i].u.alive) { mx += A2.rows[i].u.pos.x; mz += A2.rows[i].u.pos.z; nl++; }
      if (nl) { mx /= nl; mz /= nl; }
      var lead = null, ld = Infinity, bestBand = 'none', rank = { eff: 2, reduced: 1, none: 0 };
      for (i = 0; i < A2.rows.length; i++) {
        var r = A2.rows[i], u = r.u;
        if (!u.alive) continue;
        var ind = u.def.kind === 'mortar' || u.def.kind === 'artillery';
        var lc = ind ? (r.s.state === 'blocked' ? COL.indBlind : COL.indSee)
          : r.s.state === 'clear' ? COL.clear : r.s.state === 'obscured' ? COL.obsc : COL.block;
        var gp = u._gunPos ? u._gunPos() : { x: u.pos.x, y: u.pos.y + 1, z: u.pos.z };
        this._ccLine(gp.x, gp.y, gp.z, tx, ty + 0.9, tz, Math.max(0.05, 1.1 * this._ccPx(gp.x, gp.y, gp.z)), lc);
        if (rank[r.band] > rank[bestBand]) bestBand = r.band;
        var dm = Math.hypot(u.pos.x - mx, u.pos.z - mz);
        if (dm < ld) { ld = dm; lead = r; }
      }
      // the circle: white over nobody, the kill-chance colour over a man
      var rad = Math.max(foe ? (foe.def.size || 1) * 0.9 + 0.5 : 1.1, 13 * px2);
      var cc = foe && A2.odds ? COL.odds[oddsBand(A2.odds.p)] : COL.white;
      this._ccArc(tx, tz, rad, 0, Math.PI * 2, Math.max(foe ? 0.12 : 0.05, (foe ? 2.2 : 1.1) * px2), cc, 0.36);
      var sc2 = this._ccToScreen(tx, ty + 0.8, tz);
      if (!sc2 || !lead) return null;
      var text = Math.round(Math.hypot(tx - mx, tz - mz) * A.WORLD_M) + ' m';
      if (foe && A2.odds) text += '  ' + ODDS_NAME[oddsBand(A2.odds.p)];
      // where the lead man's line is obscured, and where it is stopped
      var obs = [];
      if (lead.s.obsc != null && lead.s.state !== 'clear') {
        var o1 = this._ccAlong(lead.u, tx, ty + 0.9, tz, lead.s.obsc / Math.max(lead.s.d, 0.01));
        if (o1) obs.push({ x: o1.x, y: o1.y, text: Math.round(lead.s.obsc * A.WORLD_M) + '' });
      }
      if (lead.s.block != null) {
        var o2 = this._ccAlong(lead.u, tx, ty + 0.9, tz, lead.s.block / Math.max(lead.s.d, 0.01));
        if (o2) obs.push({ x: o2.x, y: o2.y, text: Math.round(lead.s.block * A.WORLD_M) + '' });
      }
      return { lbl: { x: sc2.x, y: sc2.y, text: text, band: bestBand }, obs: obs };
    };
    /** The screen point a fraction `f` of the way along u's sight line. */
    P._ccAlong = function (u, tx, ty, tz, f) {
      var gp = u._gunPos ? u._gunPos() : { x: u.pos.x, y: u.pos.y + 1, z: u.pos.z };
      f = clamp(f, 0, 1);
      return this._ccToScreen(gp.x + (tx - gp.x) * f, gp.y + (ty - gp.y) * f, gp.z + (tz - gp.z) * f);
    };

    /** FIRE's circle sits on the man under the pointer if your side knows he
     *  is there — it cannot tell you about a man nobody has seen. Asked again
     *  at the click, so the order goes to whoever the pointer is on then. */
    P._ccFoeAt = function (sx, sy) {
      if (!this.input || !this.input.pickNear || sx < 0) return null;
      var g = this, fow = this.fowEnabled;
      var cands = this.units.filter(function (v) {
        return v.alive && !v.downed && g.isFoe(v) && (!fow || v._fowSeen) && v.mesh && v.mesh.visible;
      });
      return this.input.pickNear({ clientX: sx, clientY: sy }, cands);
    };

    /** Smoke: the circle, and a line from every man who will throw — the
     *  ones who can reach it (green), or, if nobody can, the nearest, who will
     *  throw it short (red). The same rule as `Game.throwSmoke`. */
    P._ccSmokeDraw = function (sel, p) {
      var T = this.terrain, ty = T.heightAt(p.x, p.z), px = this._ccPx(p.x, ty, p.z);
      var inReach = [], near = null, nd = Infinity, i, u, d;
      for (i = 0; i < sel.length; i++) {
        u = sel[i];
        if (!(u.smokeAmmo > 0)) continue;
        d = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
        if (d <= (u._smokeReach ? u._smokeReach() : Infinity)) inReach.push(u);
        if (d < nd) { nd = d; near = u; }
      }
      if (!near) return null;
      var who = inReach.length ? inReach : [near], c = inReach.length ? COL.clear : COL.block;
      for (i = 0; i < who.length && i < 16; i++) {
        u = who[i];
        var gp = u._gunPos ? u._gunPos() : { x: u.pos.x, y: u.pos.y + 1, z: u.pos.z };
        this._ccLine(gp.x, gp.y, gp.z, p.x, ty + 0.9, p.z, Math.max(0.05, 1.1 * this._ccPx(gp.x, gp.y, gp.z)), c);
      }
      this._ccArc(p.x, p.z, Math.max(2.2, 15 * px), 0, Math.PI * 2, Math.max(0.08, 1.6 * px), inReach.length ? COL.white : COL.block, 0.36);
      var sc = this._ccToScreen(p.x, ty + 0.8, p.z);
      if (!sc) return null;
      return { lbl: { x: sc.x, y: sc.y, text: Math.round(nd * A.WORLD_M) + ' m', band: inReach.length ? 'eff' : 'none' } };
    };

    /** The Defend (blue) and Ambush (green) arcs over every selected section
     *  holding one, centred on the section and pointing the way it faces —
     *  and, while one is being dragged, the circle it can be dragged round
     *  (p. 17). Remembered in `arcs` for `_ccGrab`. */
    P._ccArcsDraw = function (sel) {
      var m = this._ccm, groups = [], i, j;
      for (i = 0; i < sel.length; i++) {
        var u = sel[i];
        if (u.posture !== 'defend' && u.posture !== 'ambush') continue;
        var key = u.squad || u, gr = null;
        for (j = 0; j < groups.length; j++) if (groups[j].key === key) { gr = groups[j]; break; }
        if (!gr) { gr = { key: key, units: [] }; groups.push(gr); }
        gr.units.push(u);
      }
      m.arcs = [];
      var HALF = Math.PI / 4;
      for (i = 0; i < groups.length; i++) {
        var G = groups[i], n = G.units.length, cx = 0, cz = 0, sx = 0, sz = 0, amb = 0;
        for (j = 0; j < n; j++) {
          var v = G.units[j];
          cx += v.pos.x; cz += v.pos.z;
          var f = (v._ccArrive && v.path && v.path.length && v._ccArrive.face != null) ? v._ccArrive.face
            : (v.targetFace != null ? v.targetFace : v.face);
          sx += Math.sin(f); sz += Math.cos(f);
          if (v.posture === 'ambush') amb++;
        }
        cx /= n; cz /= n;
        var face = Math.atan2(sx, sz), r = 2.4;
        for (j = 0; j < n; j++) r = Math.max(r, Math.hypot(G.units[j].pos.x - cx, G.units[j].pos.z - cz) + 1.6);
        r = Math.min(r, 9);
        var kind = amb * 2 >= n ? 'ambush' : 'defend', c = COL[kind];
        var apx = this._ccPx(cx, this.terrain.heightAt(cx, cz), cz);
        var dr = m.drag && m.drag.kind === 'arc' && m.drag.key === G.key ? m.drag : null;
        if (dr && dr.px != null) face = Math.atan2(dr.px - cx, dr.pz - cz);
        if (dr) this._ccArc(cx, cz, r, 0, Math.PI * 2, Math.max(0.05, 1 * apx), c, 0.42);
        this._ccArc(cx, cz, r, face - HALF, face + HALF, Math.max(dr ? 0.24 : 0.17, (dr ? 3 : 2.2) * apx), c, 0.45);
        // the handle: a tick out from the middle of the arc
        var hl = Math.max(1.1, 10 * apx);
        this._ccFlat(cx + Math.sin(face) * r, cz + Math.cos(face) * r,
          cx + Math.sin(face) * (r + hl), cz + Math.cos(face) * (r + hl), Math.max(0.2, 2.6 * apx), c, 0.46);
        m.arcs.push({ kind: 'arc', key: G.key, units: G.units, cx: cx, cz: cz, r: r, face: face, hl: hl });
      }
    };

    /** The destination dot of each selected section that is on its way
     *  somewhere — one dot per section, at the middle of where its men will
     *  stand, in the colour of how they are going (p. 13). It can be dragged.
     *  A route of several legs is drawn by the order lines and is not
     *  draggable: which leg would it move? */
    P._ccDestDraw = function (sel) {
      var m = this._ccm, groups = [], i, j;
      m.dests = [];
      for (i = 0; i < sel.length; i++) {
        var u = sel[i];
        if (!u.explicit || u.state !== 'move' || !u.path || !u.path.length || (u.queue && u.queue.length)) continue;
        var key = u.squad || u, gr = null;
        for (j = 0; j < groups.length; j++) if (groups[j].key === key) { gr = groups[j]; break; }
        if (!gr) { gr = { key: key, units: [], x: 0, z: 0, modes: {} }; groups.push(gr); }
        gr.units.push(u);
        var cd = u._ccDot, own = cd && cd.ax === u.anchor.x && cd.az === u.anchor.z;
        gr.x += own ? cd.x : u.anchor.x; gr.z += own ? cd.z : u.anchor.z;
        gr.modes[u.moveMode] = (gr.modes[u.moveMode] || 0) + 1;
      }
      for (i = 0; i < groups.length; i++) {
        var G = groups[i], n = G.units.length, mode = 'normal', bn = 0;
        for (var k in G.modes) if (G.modes[k] > bn) { bn = G.modes[k]; mode = k; }
        var x = G.x / n, z = G.z / n;
        var dr = m.drag && m.drag.kind === 'dest' && m.drag.key === G.key ? m.drag : null;
        if (dr && dr.px != null) { x = dr.px; z = dr.pz; }
        var c = mode === 'fast' ? COL.fast : mode === 'sneak' ? COL.sneak : COL.move;
        var dpx = this._ccPx(x, this.terrain.heightAt(x, z), z);
        this._ccDot(x, z, Math.max(dr ? 0.85 : 0.65, (dr ? 8 : 6) * dpx), c);
        m.dests.push({ kind: 'dest', key: G.key, units: G.units, x: x, z: z, mode: mode });
      }
    };

    /** Is there an arc or a dot under this screen point? */
    P._ccGrab = function (sx, sy) {
      var m = this._ccm, T = this.terrain, i, best = null, bd = 14;
      var dests = m.dests || [];
      for (i = 0; i < dests.length; i++) {
        var D = dests[i], s = this._ccToScreen(D.x, T.heightAt(D.x, D.z) + 0.3, D.z);
        if (!s) continue;
        var dd = Math.hypot(s.x - sx, s.y - sy);
        if (dd < bd) { bd = dd; best = D; }
      }
      for (i = 0; i < m.arcs.length; i++) {
        var a = m.arcs[i];
        for (var k = -4; k <= 5; k++) {
          var ang = a.face + (k <= 4 ? k * (Math.PI / 16) : 0), rr = k === 5 ? a.r + a.hl * 0.7 : a.r;
          var x = a.cx + Math.sin(ang) * rr, z = a.cz + Math.cos(ang) * rr;
          var s2 = this._ccToScreen(x, T.heightAt(x, z) + 0.45, z);
          if (!s2) continue;
          var d2 = Math.hypot(s2.x - sx, s2.y - sy);
          if (d2 < bd) { bd = d2; best = a; }
        }
      }
      if (!best) return null;
      return { kind: best.kind, key: best.key, units: best.units, cx: best.cx, cz: best.cz, mode: best.mode, px: null, pz: null };
    };
  }

  // ===========================================================================
  // INSTALL
  // ===========================================================================
  function css() {
    if (document.getElementById('ccMenuCss')) return;
    var st = document.createElement('style');
    st.id = 'ccMenuCss';
    st.textContent = [
      '.ccm{position:fixed;z-index:160;display:none;min-width:156px;padding:3px 0;',
      '  background:rgba(14,18,24,.96);border:1px solid #3a4a5a;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.6);',
      '  font:12px/1.25 ui-monospace,Menlo,Consolas,monospace;color:#cfe0ee;user-select:none;-webkit-user-select:none}',
      '.ccm-h{padding:4px 10px 5px;margin-bottom:2px;border-bottom:1px solid #223040;font-size:9.5px;letter-spacing:1.2px;',
      '  text-transform:uppercase;color:#c8a060;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}',
      '.ccm-i{display:flex;justify-content:space-between;align-items:baseline;gap:22px;padding:3px 10px;cursor:pointer;white-space:nowrap}',
      '.ccm-i b{font-weight:600}',
      '.ccm-i b i{font-style:normal;display:inline-block;width:14px;text-align:center;color:#8fa4b8}',
      '.ccm-i u{text-decoration:none;color:#6f8598;font-size:10.5px;min-width:10px;text-align:right}',
      '.ccm-i:hover{background:#26425f;color:#fff}',
      '.ccm-i:hover u{color:#cfe0ee}',
      '.ccm-i.off,.ccm-i.off:hover{color:#4f5b66;background:none;cursor:default}',
      '.ccm-i.off u{color:#3c4650}',
      '.ccm-i.on b{color:#e8c088}',
      '.ccm-x b{color:#d8e8a8}',
      '.ccm-sep{height:1px;background:#223040;margin:3px 0}',
      '.ccm-g{padding:5px 10px 2px;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#6f8598}',
      '#ccMenuMore{max-height:80vh;overflow:auto}',
      '#ccmRng{position:fixed;z-index:150;pointer-events:none;display:none;font:bold 12px ui-monospace,Menlo,Consolas,monospace;',
      '  text-shadow:0 0 3px #000,0 0 2px #000,0 1px 1px #000;white-space:nowrap}',
      '#ccmRng.none{text-shadow:0 0 3px #fff,0 0 2px #fff,0 0 1px #fff}',
      '.ccm-ob{position:fixed;z-index:150;pointer-events:none;display:none;font:bold 11px ui-monospace,Menlo,Consolas,monospace;',
      '  color:#fff;text-shadow:0 0 3px #000,0 0 2px #000}',
      'body.cc-menu #ccBar{display:none!important}',
      'body.fpv .ccm,body.fpv #ccmRng,body.fpv .ccm-ob{display:none!important}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /** `api` is everything this file reads from the main one (see
   *  `ccMenuInstall` there). Installs after assets/squads.js, whose
   *  ccOrder / ccApply / ccExecuteAt it builds on. */
  function install(api) {
    A = api; THREE = api.THREE;
    var P = api.Game.prototype;
    if (!P.ccOrder || !P.ccApply || !P.ccExecuteAt) throw new Error('assets/squads.js must install first');
    installOrders(P);
    installSight(P);
    installOdds(P);
    installMenu(P);
    installAim(P);
    // the frame: straight after the order lines
    var baseVis = P._updateOrderVis;
    P._updateOrderVis = function () { baseVis.apply(this, arguments); this._ccFrame(); };
    // With the bar hidden, nothing is in the keyboard hint's corner.
    var baseBar = P._refreshOrderBar;
    if (baseBar) P._refreshOrderBar = function () {
      baseBar.apply(this, arguments);
      if (!this.ccBarShown) document.body.classList.remove('has-sel');
    };
    css();
    api.game.installCCMenu();
  }

  window.CCMenu = {
    CC_MENU: CC_MENU,
    CC_KEY: CC_KEY,
    CC_COVERED: CC_COVERED,
    COL: COL,
    AMBUSH_M: AMBUSH_M,
    oddsBand: oddsBand,
    install: install,
  };
})();
