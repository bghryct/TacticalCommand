/* =========================================================================
 * CAMPAIGN — the Normandy operation, its briefings, and its battlegroups
 * =========================================================================
 *
 * WHAT A CAMPAIGN IS HERE
 *
 * Ten battles in order, from the shingle at Vierville on the morning of 6 June
 * to the summit of Hill 314 above Mortain on 7 August. What carries over is
 * your BATTLEGROUP: platoons of named squads that you built, that fought the
 * last battle, and that are carrying its casualties into this one.
 *
 * The model is Close Combat's, and it rests on three rules:
 *
 *   1. YOU BUY SQUADS, NOT SOLDIERS. A rifle squad is a leader with a
 *      Thompson, a BAR gunner and seven riflemen, and it costs nine
 *      requisition points. A German reserve squad is six frightened men with
 *      old rifles and costs four. The compositions live in
 *      `Squads.TEMPLATES`; the prices are single digits because that is the
 *      scale a battalion commander actually thinks in.
 *
 *   2. THE FORCE PERSISTS. Squads you requisition are yours for the campaign.
 *      They keep their name, their veterancy and their dead. "2nd Squad, 1st
 *      Platoon" that came off Hill 192 with four men out of nine goes onto
 *      Martinville Ridge with four men, unless you spend points replacing
 *      them.
 *
 *   3. THE STRUCTURE IS PLATOONS. One to nine of them, five slots each and
 *      expandable to nine — so three platoons of five is the ordinary shape
 *      and eighty-one squads is what an enormous requisition looks like.
 *
 * HISTORICAL CONDITIONING
 *
 * Four levers, and it is worth knowing which one to reach for:
 *
 *   · `TEMPLATES[].from` — the battle at which a type becomes available. No
 *     Shermans at Vierville, because none were ashore at that draw. Tigers
 *     from Villers-Bocage (sSSPzAbt 101). The Jagdpanther from Saint-Lô,
 *     because sPzJgAbt 654 went into action on 30 July and not a day before.
 *   · `rp` per battle — the Americans are resupplied and the Germans are not.
 *     That asymmetry is the campaign's clock and needs no scripting.
 *   · `battle.doctrine` — what shape the enemy's force takes here.
 *   · `battle.must` — what this battle historically fielded, bought first.
 *
 * Optional, like assets/squads.js: every call site in the game is guarded.
 * Requires assets/squads.js for the templates and the spawner.
 * ========================================================================= */
(function () {
  'use strict';

  var VERSION = '2.1';
  var G = null;
  // Each campaign saves under its own key, so a Normandy game in progress and a
  // Westheer game in progress do not overwrite each other.
  var SAVE_KEY = 'tc_campaign_normandy2';
  var MAX_PLATOONS = 9;
  var BASE_SLOTS = 5;
  var MAX_SLOTS = 9;

  function T() { return (window.Squads && window.Squads.TEMPLATES) || {}; }

  // =========================================================================
  // DIFFICULTY — AND WHAT A VICTORY IS WORTH
  // =========================================================================
  //
  // The campaign paid a FLAT per-battle allowance whether you took the ground,
  // held it or were thrown off it, so winning bought you nothing and the whole
  // economy was a slow bleed: replacements cost points, the allowance never
  // moved, and a player who fought well ended the operation no better off than
  // one who lost every battle and replayed it.
  //
  // Two things change that. A result now scales the allowance — a victory pays
  // in full, a stalemate three quarters, a defeat half, because a formation
  // that failed does not get the same priority on the dumps. And on top of it
  // a VICTORY AWARD, which is the interesting knob: the harder the setting, the
  // smaller the allowance and the larger the award. On Recruit you are carried
  // by the supply chain; on Elite you live on what you take. That is the same
  // shape as the operation itself, where the Americans were resupplied and the
  // Germans were not.
  //
  //   rp     multiplies YOUR allowance and starting requisition
  //   foeRp  multiplies the enemy's — the real difficulty lever, because the
  //          AI buys its battlegroup out of the same pool you do
  //   win    victory award, as a fraction of the battle's own allowance
  var DIFFICULTY = {
    recruit: { name: 'Recruit', rp: 1.45, foeRp: 0.80, win: 0.10,
               blurb: 'A generous allowance and a weaker opposition. You are carried by the supply chain, so a bad battle is not the end of the operation.' },
    regular: { name: 'Regular', rp: 1.00, foeRp: 1.00, win: 0.45,
               blurb: 'The operation as it was written. A victory is worth about half a battle\'s allowance again on top of it.' },
    veteran: { name: 'Veteran', rp: 0.82, foeRp: 1.20, win: 1.00,
               blurb: 'Less from the dumps and more across the start line — but taking the objective doubles what the battle pays.' },
    elite:   { name: 'Elite',   rp: 0.68, foeRp: 1.45, win: 1.50,
               blurb: 'You live on what you take. The allowance barely covers replacements; a victory pays more than on any other setting, and a defeat hands them three times theirs.' },
  };
  var DIFF_ORDER = ['recruit', 'regular', 'veteran', 'elite'];
  var pendingDiff = 'regular';        // what the picker last chose, for a NEW campaign

  // UNLIMITED REQUISITION — a setting, not a cheat menu.
  //
  // The economy above is the campaign's whole spine, and for some players that
  // spine is the point: you fight Villers-Bocage with what Hill 192 left you.
  // For others it is a tax on the part they came for, which is the battles. So
  // the player's pool can simply be bottomless.
  //
  // IT APPLIES TO THE PLAYER ONLY. The enemy buys its battlegroup out of the
  // same persistent force by the same rules, and giving both sides infinity
  // would not be generous — it would fill every map on both sides until the
  // frame rate decided the battle. The CAPS table still holds, so a bottomless
  // pool buys breadth and not nine platoons of King Tigers.
  //
  // A real number rather than Infinity: it is written to localStorage as JSON,
  // and `JSON.stringify(Infinity)` is `null`, which would load back as a force
  // with no requisition at all. 999999 is six digits of requisition against a
  // battalion commander's ordinary allowance of twenty — which is the point:
  // the number is meant to read as "stop thinking about this".
  var UNLIMITED_RP = 999999;
  var pendingUnlimited = false;
  /** Put the player's pool back to the top. Called wherever it can go down. */
  function topUp(st) {
    if (!st || !st.unlimited) return st;
    var f = st.force && st.force[CAMPAIGN.player];
    if (f) f.rp = UNLIMITED_RP;
    return st;
  }
  /** UNLIMITED MEANS UNLIMITED. A bottomless pool on its own is not what the
   *  setting is for: the scarcity caps and the historical availability dates
   *  would still say no, and "you may buy anything except the interesting
   *  things" is a worse answer than either rule on its own. With the setting
   *  on, the PLAYER's requisition screen has no price, no cap and no date —
   *  eighty-one slots and the whole catalogue to put in them.
   *
   *  It applies to the player only, in both directions: the enemy still buys
   *  out of its own pool, against its own caps, from the list its own campaign
   *  unlocked. That is what keeps a sandbox game a game. */
  function unlimited(st) { return !!(st && st.unlimited); }
  /** How many of one template a force may hold. */
  function capOf(id, st, team) {
    if (unlimited(st) && team === CAMPAIGN.player) return Infinity;
    return CAPS[id] === undefined ? 99 : CAPS[id];
  }
  /** What to print for a pool that cannot run out. Show the NUMBER rather than
   *  an infinity glyph: six figures against a battalion commander's ordinary
   *  twenty says what the setting does at a glance, and it never moves, which
   *  is the other half of what it says. */
  function rpText(st, f) { return String(f.rp); }
  function diffOf(st) { return DIFFICULTY[(st && st.diff) || 'regular'] || DIFFICULTY.regular; }
  /** One team's requisition for one battle. `won`/`drew` are from THAT team's
   *  point of view, `mine` says whether it is the player's. */
  function rpAward(base, won, drew, D, mine) {
    var mult = won ? 1 : drew ? 0.75 : 0.5;
    return Math.round((base * mult + (won ? base * D.win : 0)) * (mine ? D.rp : D.foeRp));
  }

  // =========================================================================
  // THE OPERATION
  // =========================================================================
  var NORMANDY = {
    id: 'normandy44', name: 'Normandy', subtitle: '6 June – 7 August 1944',
    side: 'US First Army', saveKey: 'tc_campaign_normandy2',
    blurb: 'Ten battles from the shingle at Vierville to the summit of Hill 314. '
         + 'You are resupplied and they are not, and that asymmetry is the clock.',
    player: 1,
    // What each side is given to build with before the first battle.
    startRP: { 1: 96, 2: 84 },
    battles: [
      { map: 'Vierville Draw', role: 'attack', deployMax: 15,
        objective: 'Take the crest either side of the draw.',
        rp: { 1: 14, 2: 10 },
        doctrine: { 1: { armour: 0, transport: 0 }, 2: { armour: 0.04, atgun: 0.20, mg: 0.20 } },
        // The naval shore fire control party went up the draw with the first
        // waves, and the Widerstandsnester had infantry guns firing down it.
        // Neither is something the weighted allocation will ever buy: it only
        // ever reaches about nineteen of the eighty-odd templates (see the
        // note on Villers-Bocage below), so anything a battle actually had
        // has to be named here.
        must: { 1: { us_fo: 1 }, 2: { ger_leig: 1 } } },
      { map: 'Pointe du Hoc', role: 'defend', deployMax: 10,
        objective: 'Hold the point until relief arrives.',
        rp: { 1: 12, 2: 14 },
        doctrine: { 1: { armour: 0, transport: 0, mg: 0.18 }, 2: { armour: 0.14 } },
        must: { 2: { ger_stug: 1 }, 1: { us_fo: 1 } } },
      { map: 'Purple Heart Lane', role: 'attack', deployMax: 14,
        objective: 'Force the causeway and take the far bridge.',
        rp: { 1: 18, 2: 11 },
        doctrine: { 1: { armour: 0.12 }, 2: { armour: 0.10, mg: 0.20, atgun: 0.14 } },
        must: { 2: { ger_leig: 1 }, 1: { us_fo: 1 } } },
      { map: 'Bloody Gulch', role: 'defend', deployMax: 15,
        objective: 'Hold the crossroads west of Carentan.',
        rp: { 1: 18, 2: 20 },
        doctrine: { 1: { armour: 0.06, at: 0.18, atgun: 0.18 }, 2: { armour: 0.38, transport: 0.10 } },
        // 17th SS Panzergrenadier attacked the Carentan crossroads, and a
        // Panzergrenadier regiment's gun company is 251/9s.
        must: { 2: { ger_stug: 2, ger_251: 1, ger_stummel: 1 }, 1: { us_fo: 1 } } },
      { map: 'Villers-Bocage', role: 'attack', deployMax: 15,
        objective: 'Take Point 213 and hold the town.',
        rp: { 1: 24, 2: 16 },
        doctrine: { 1: { armour: 0.46, rifle: 0.20 }, 2: { armour: 0.40, atgun: 0.10 } },
        // Villers-Bocage without the Tigers is a different battle, and the
        // weights will never buy one: a Tiger is thirty points and the
        // allocation always finds a Panzer IV first.
        must: { 1: { br_cromwell: 2, br_firefly: 1, br_daimler: 1 }, 2: { ger_tiger: 2 } } },
      { map: 'Hedgerow Hell', role: 'attack', deployMax: 16,
        objective: 'Work south to the lateral road.',
        rp: { 1: 22, 2: 13 },
        doctrine: { 1: { armour: 0.20, rifle: 0.36 }, 2: { armour: 0.12, mg: 0.20 } } },
      { map: 'Hill 192', role: 'attack', deployMax: 17,
        objective: 'Take the crest and both draws.',
        rp: { 1: 24, 2: 13 },
        doctrine: { 1: { armour: 0.24, mortar: 0.12 }, 2: { armour: 0.10, mg: 0.20, atgun: 0.14 } },
        // The 2nd Division's attack on 192 was an artillery attack with
        // infantry in it — the regiment's own Cannon Company firing over open
        // sights at the hedgerow corners.
        must: { 1: { us_105: 1, us_fo: 1 }, 2: { ger_sniper2: 1 } } },
      { map: 'Martinville Ridge', role: 'attack', deployMax: 17,
        objective: 'Advance west along the ridge into Saint-Lô.',
        rp: { 1: 24, 2: 14 },
        doctrine: { 1: { armour: 0.28 }, 2: { armour: 0.18, atgun: 0.16 } },
        // schwere Panzerjäger-Abteilung 654 fought its Nashorns in front of
        // Saint-Lô. Eighty-eight millimetres of gun on ten millimetres of
        // plate, on a ridge with sight lines down the whole approach.
        must: { 2: { ger_nashorn: 1 }, 1: { us_fo: 1 } } },
      { map: 'Cobra Breach', role: 'attack', deployMax: 18,
        objective: 'Break clean through the bombed box.',
        rp: { 1: 30, 2: 8 },
        doctrine: { 1: { armour: 0.50, transport: 0.10, rifle: 0.24 }, 2: { armour: 0.10, atgun: 0.18 } },
        // COBRA is where the 76 mm tanks turn up in numbers, and where the
        // columns need something fast out in front of them.
        must: { 1: { us_sherman: 2, us_sherman76: 2, us_jeep: 1 } } },
      { map: 'Hill 314, Mortain', role: 'defend', deployMax: 13,
        objective: 'Hold Hill 314 until the fog lifts.',
        rp: { 1: 14, 2: 34 },
        doctrine: { 1: { armour: 0.04, transport: 0, mg: 0.18, at: 0.14 }, 2: { armour: 0.44, transport: 0.08 } },
        // THE TWO OBSERVERS ON THE SUMMIT are the whole reason Hill 314 is a
        // famous action rather than a lost battalion, and the map's victory
        // condition now says so — keep them alive (see `Game._checkMapWin`).
        must: { 2: { ger_panther: 2, ger_tiger: 1, ger_stummel: 1 }, 1: { us_fo: 2, us_105: 1 } } },
    ],
  };


  // =========================================================================
  // THE SECOND OPERATION — the same summer from the other side of the hedge
  // =========================================================================
  //
  // You are a German battalion commander in Normandy, and the shape of the
  // campaign is the exact inverse of the American one. Where First Army is
  // resupplied every week and grows, the Westheer is fed a trickle and is
  // ground down: `rp` falls almost monotonically from Vierville to Chambois,
  // and the last two battles are fought with what survived the first eight.
  //
  // Eight of the ten battles are DEFENCES, because that is what the campaign in
  // Normandy was for the German army, and the two attacks are the two it
  // actually made — the counter-attack at Carentan and Unternehmen Lüttich at
  // Mortain. The final battle is neither: Chambois is a breakout, and the only
  // objective that matters there is the road east.
  //
  // `unlock` overrides `TEMPLATES[].from`, which is indexed against the
  // American campaign's battle order. Villers-Bocage is battle five there and
  // battle three here, and sSSPzAbt 101 has to have its Tigers either way.
  var WESTHEER = {
    id: 'westheer44', name: 'Westheer', subtitle: 'Normandy, 6 June – 21 August 1944',
    side: '7. Armee / Panzergruppe West', saveKey: 'tc_campaign_westheer1',
    blurb: 'Ten battles holding the hedgerows, the crest of 112 and the ruins of Saint-Lô, '
         + 'then Mortain and the corridor at Chambois. Nobody is going to reinforce you.',
    player: 2,
    startRP: { 1: 84, 2: 104 },
    unlock: { ger_tiger: 2, ger_panther: 3, ger_ss: 3, ger_fj: 1, ger_jagd: 7, ger_kt: 8, ger_hetzer: 5, ger_jagdpz4: 5 },
    battles: [
      { map: 'Vierville Draw', role: 'defend', deployMax: 13,
        objective: 'Hold the bluff. Nothing leaves this beach through D-1.',
        rp: { 1: 20, 2: 9 },
        doctrine: { 1: { armour: 0, transport: 0 }, 2: { armour: 0.04, atgun: 0.22, mg: 0.26 } },
        must: { 2: { ger_mg: 2, ger_pak40: 1, ger_leig: 1 } } },
      { map: 'Bloody Gulch', role: 'attack', deployMax: 15,
        objective: 'Retake the crossroads west of Carentan before they consolidate.',
        rp: { 1: 18, 2: 22 },
        doctrine: { 1: { armour: 0.06, at: 0.20, atgun: 0.16 }, 2: { armour: 0.38, transport: 0.12 } },
        must: { 2: { ger_stug: 2, ger_251: 1, ger_stummel: 1 } } },
      { map: 'Villers-Bocage', role: 'attack', deployMax: 14,
        objective: 'Take Point 213 and cut the column on the road.',
        rp: { 1: 22, 2: 20 },
        doctrine: { 1: { armour: 0.44, rifle: 0.22 }, 2: { armour: 0.42, atgun: 0.10 } },
        must: { 2: { ger_tiger: 2 }, 1: { br_cromwell: 2, br_firefly: 1 } } },
      { map: 'Hill 112', role: 'defend', deployMax: 15,
        objective: 'Hold the crest. Counter-attack every lodgement at once.',
        rp: { 1: 26, 2: 17 },
        doctrine: { 1: { armour: 0.34, mortar: 0.14 }, 2: { armour: 0.20, mg: 0.24, atgun: 0.16 } },
        must: { 2: { ger_ss: 2, ger_sniper2: 1 } } },
      { map: 'Carpiquet Airfield', role: 'defend', deployMax: 12,
        objective: 'Hold the southern hangars. There is no covered approach to them.',
        rp: { 1: 28, 2: 12 },
        doctrine: { 1: { armour: 0.36, rifle: 0.30 }, 2: { armour: 0.08, mg: 0.30, atgun: 0.20 } },
        must: { 2: { ger_ss: 2, ger_mg: 2, ger_nashorn: 1 } } },
      { map: 'Colombelles Steelworks', role: 'defend', deployMax: 15,
        objective: 'Hold the works and the streets behind them, floor by floor.',
        rp: { 1: 26, 2: 14 },
        doctrine: { 1: { armour: 0.24, rifle: 0.40 }, 2: { armour: 0.10, mg: 0.24, at: 0.18 } } },
      { map: 'Bourguébus Ridge', role: 'defend', deployMax: 16,
        objective: 'Let the armour into the corn and shoot it there.',
        rp: { 1: 34, 2: 16 },
        doctrine: { 1: { armour: 0.62, transport: 0.10 }, 2: { armour: 0.26, atgun: 0.30 } },
        must: { 2: { ger_flak88: 2, ger_tiger: 1 } } },
      { map: 'Saint-Lô: the Ruins', role: 'defend', deployMax: 15,
        objective: 'Give ground street by street. Do not be caught in the river loop.',
        rp: { 1: 30, 2: 11 },
        doctrine: { 1: { armour: 0.26, rifle: 0.38 }, 2: { armour: 0.10, mg: 0.22, at: 0.20 } },
        must: { 2: { ger_fj: 2 } } },
      { map: 'Hill 314, Mortain', role: 'attack', deployMax: 16,
        objective: 'Unternehmen Lüttich — take the hill and reach the sea.',
        rp: { 1: 16, 2: 24 },
        doctrine: { 1: { armour: 0.06, transport: 0, mg: 0.20, at: 0.16 }, 2: { armour: 0.46, transport: 0.10 } },
        // THE TWO OBSERVERS ON THE SUMMIT are the whole reason Hill 314 is a
        // famous action rather than a lost battalion, and the map's victory
        // condition now says so — keep them alive (see `Game._checkMapWin`).
        must: { 2: { ger_panther: 2, ger_tiger: 1, ger_stummel: 1 }, 1: { us_fo: 2, us_105: 1 } } },
      { map: 'Chambois Corridor', role: 'attack', deployMax: 17,
        objective: 'Force the corridor. Whatever is still on this bank at dusk is lost.',
        rp: { 1: 30, 2: 8 },
        doctrine: { 1: { armour: 0.44, atgun: 0.20 }, 2: { armour: 0.24, rifle: 0.44 } } },
    ],
  };

  // =========================================================================
  // THE OTHER FIVE — Market Garden, the Eastern Front twice, the Mediterranean
  // and France 1940
  // =========================================================================
  //
  // Everything above was written for one theatre with two sides, and two
  // things in the engine were hardcoded to it: who "the Allies" are, and what
  // a starting cadre looks like. `nations` and `startForce` are the two hooks
  // that opened it. A campaign now names the nations each team may requisition
  // from and the platoon it opens with, and Normandy and the Westheer keep the
  // old behaviour by not declaring either.
  //
  // On `unlock`: `TEMPLATES[].from` is indexed against the NORMANDY battle
  // order, which means nothing outside it. Every campaign here declares its own
  // for anything that should not be available at battle one — so the Red Army
  // does not open Barbarossa with IS-2s, and the Ostheer does not have a Tiger
  // in 1941.

  var MARKET_GARDEN = {
    id: 'market44', name: 'A Bridge Too Far', subtitle: '17–26 September 1944',
    side: 'XXX Corps & the Airborne Army', saveKey: 'tc_campaign_market1',
    blurb: 'Sixty miles of one road with five water obstacles on it, and a division sitting on each one waiting for the armour. '
         + 'The corridor is the campaign: you cannot leave it, and every hour costs somebody at the far end.',
    player: 1,
    nations: { 1: ['us', 'uk'], 2: ['ger'] },
    startRP: { 1: 104, 2: 88 },
    // Airborne troops are what this operation is made of, and they are
    // available from the first minute. What is NOT available is weight: no
    // heavy armour until XXX Corps is far enough up the road to have brought
    // any, which is what the unlock numbers say.
    unlock: {
      us_para: 0, br_commando: 0, us_ranger: 2, br_firefly: 1, br_churchill: 4,
      us_sherman76: 5, us_jumbo: 9, br_croc: 6, br_avre: 6, us_m12: 7,
      ger_tiger: 3, ger_panther: 4, ger_kt: 8, ger_jagd: 7, ger_ss: 0, ger_fj: 0,
      ger_stg: 5, ger_222: 0, ger_pak43: 5, ger_brummbar: 6,
      // >>> round 115 roster (tools/roster_r115.py writes these rows from tools/roster_r115_spec.py: edit the spec, not them)
      us_m8hmc: 0,
      us_m15: 0,
      us_m20: 0,
      br_archer: 3,
      br_challenger: 0,
      br_humber: 0,
      br_staghound: 0,
      br_dingo: 0,
      br_sherman: 0,
      br_stuart: 0,
      br_m10: 0,
      br_halftrack: 0,
      br_jeep: 0,
      us_longtom: 2,
      us_mortar42: 0,
      br_55in: 0,
      br_bofors: 0,
      br_para: 0,
      br_polish: 7,
      // <<< round 115 roster
    },
    startForce: {
      1: [{ name: '1st Parachute Platoon', squads: ['us_hq', 'us_para', 'us_para', 'us_60mm', 'us_bazooka'] }],
      2: [{ name: '1. Zug', squads: ['ger_hq', 'ger_ss', 'ger_gruppe', 'ger_mg', 'ger_faust'] }],
    },
    battles: [
      { map: 'Valkenswaard Road', role: 'attack', deployMax: 14,
        objective: 'Get the column up the road to Valkenswaard.',
        rp: { 1: 16, 2: 12 },
        doctrine: { 1: { armour: 0.34, rifle: 0.30 }, 2: { armour: 0.06, atgun: 0.28, mg: 0.22 } },
        must: { 2: { ger_flak88: 2, ger_fj: 2 }, 1: { br_cromwell: 2, br_firefly: 1 } } },
      { map: 'Son Bridge', role: 'attack', deployMax: 12,
        objective: 'Take the canal bridge before the charges are fired.',
        rp: { 1: 16, 2: 12 },
        doctrine: { 1: { armour: 0, transport: 0, rifle: 0.46 }, 2: { armour: 0.06, atgun: 0.26, mg: 0.22 } },
        must: { 1: { us_para: 3, us_engineer: 1 }, 2: { ger_flak88: 2 } } },
      { map: 'Groesbeek Heights', role: 'defend', deployMax: 15,
        objective: 'Hold the ridge and keep the landing zone clear.',
        rp: { 1: 18, 2: 18 },
        doctrine: { 1: { armour: 0, transport: 0, mg: 0.20, at: 0.16 }, 2: { armour: 0.22, rifle: 0.34 } },
        must: { 1: { us_para: 3, us_57mm: 2 }, 2: { ger_stug: 2 } } },
      { map: "Hell's Highway", role: 'defend', deployMax: 15,
        objective: 'Keep the corridor open where they cut it.',
        rp: { 1: 20, 2: 20 },
        doctrine: { 1: { armour: 0.16, at: 0.20, rifle: 0.36 }, 2: { armour: 0.36, transport: 0.10 } },
        must: { 2: { ger_panther: 1, ger_251: 1 }, 1: { us_fo: 1 } } },
      { map: 'Best', role: 'defend', deployMax: 14,
        objective: 'Hold the wood line short of the road.',
        rp: { 1: 18, 2: 22 },
        doctrine: { 1: { armour: 0, mg: 0.22, mortar: 0.14, rifle: 0.40 }, 2: { armour: 0.20, rifle: 0.40 } },
        must: { 1: { us_para: 3, us_mg30: 2 }, 2: { ger_stug: 2, ger_flame: 1 } } },
      { map: 'The Waal Crossing', role: 'attack', deployMax: 14,
        objective: 'Cross the river and take the far dyke.',
        rp: { 1: 22, 2: 16 },
        doctrine: { 1: { armour: 0.10, rifle: 0.52 }, 2: { armour: 0.10, mg: 0.30, atgun: 0.16 } },
        // Twenty-six canvas boats and the men who paddled them with rifle butts.
        must: { 1: { us_para: 4, us_engineer: 2, us_fo: 1 }, 2: { ger_mg: 3, ger_flak38: 1 } } },
      { map: 'Nijmegen Road Bridge', role: 'attack', deployMax: 15,
        objective: 'Clear the ramp and get armour onto the deck.',
        rp: { 1: 24, 2: 18 },
        doctrine: { 1: { armour: 0.36, rifle: 0.36 }, 2: { armour: 0.14, mg: 0.24, at: 0.20 } },
        must: { 1: { br_firefly: 2, us_para: 2 }, 2: { ger_ss: 3, ger_pak40: 1 } } },
      { map: 'Elst — the Island', role: 'attack', deployMax: 15,
        objective: 'Force the embanked road across the polder.',
        rp: { 1: 24, 2: 20 },
        doctrine: { 1: { armour: 0.42, rifle: 0.30 }, 2: { armour: 0.34, atgun: 0.22 } },
        // One road, and a Panther on it is a battalion position.
        must: { 2: { ger_panther: 2, ger_tiger: 1 }, 1: { br_firefly: 2, br_17pdr: 1 } } },
      { map: 'Driel and the Ferry', role: 'attack', deployMax: 13,
        objective: 'Get men across the Rhine to the perimeter.',
        rp: { 1: 16, 2: 28 },
        doctrine: { 1: { armour: 0.08, rifle: 0.50, mortar: 0.14 }, 2: { armour: 0.16, mg: 0.28 } },
        must: { 1: { us_para: 3 }, 2: { ger_ss: 2, ger_mg: 2 } } },
      { map: 'Oosterbeek Perimeter', role: 'defend', deployMax: 16,
        objective: 'Hold the cauldron until the boats come.',
        rp: { 1: 14, 2: 42 },
        doctrine: { 1: { armour: 0.04, transport: 0, mg: 0.22, at: 0.22, rifle: 0.38 },
                    2: { armour: 0.40, rifle: 0.34 } },
        // There is nothing behind this position except the river.
        must: { 1: { br_section: 3, br_piat: 2, br_6pdr: 1 }, 2: { ger_tiger: 2, ger_ss: 3, ger_nebel: 1 } } },
    ],
  };

  var REDARMY = {
    id: 'redarmy41', name: 'The Great Patriotic War', subtitle: '22 June 1941 – 30 April 1945',
    side: 'Raboche-Krestyanskaya Krasnaya Armiya', saveKey: 'tc_campaign_redarmy1',
    blurb: 'Eleven battles from the Citadel at Brest to the Tiergarten. The first four are fought with what survived '
         + 'the last one, and they are the point: this campaign has to be lost for three years before it can be won.',
    player: 1,
    nations: { 1: ['sov'], 2: ['ger'] },
    // A DELIBERATE ASYMMETRY, AND THE OPPOSITE ONE TO NORMANDY. The Red Army
    // starts poor and gets richer every battle; the Ostheer starts rich and is
    // ground down. `rp` below rises almost monotonically for team 1 and falls
    // for team 2, and that curve is the campaign's whole argument.
    startRP: { 1: 74, 2: 118 },
    unlock: {
      sov_t3476: 0, sov_kv1: 0, sov_guards: 2, sov_t34: 5, sov_isu152: 6,
      sov_su100: 8, sov_is2: 8, sov_katyusha: 3, sov_penal: 2, sov_scout: 1,
      ger_pz3: 0, ger_pak38: 0, ger_222: 0, ger_gebirg: 0,
      ger_tiger: 5, ger_panther: 6, ger_kt: 9, ger_jagd: 8, ger_nashorn: 6,
      ger_stg: 8, ger_pak43: 7, ger_brummbar: 5, ger_ss: 3, ger_fj: 4, ger_volks: 8,
      // >>> round 108 roster (tools/roster_r108.py writes these rows from tools/roster_r108_spec.py: edit the spec, not them)
      ger_pz1: 0,
      ger_flakpz1: 2,
      ger_pzjg1: 0,
      ger_bison: 0,
      ger_pz2: 0,
      ger_marder2: 4,
      ger_pz35t: 0,
      ger_pz38t: 0,
      ger_flakpz38t: 7,
      ger_aufkl38t: 7,
      ger_grille: 6,
      ger_stuh42: 6,
      ger_ostwind: 9,
      ger_stug4: 7,
      ger_pz4e: 0,
      ger_pz3f: 0,
      ger_stugb: 0,
      ger_hummel: 6,
      ger_elefant: 6,
      ger_sturmtiger: 9,
      ger_jagdtiger: 10,
      sov_t26: 0,
      sov_t40: 0,
      sov_t50: 1,
      sov_bt2: 0,
      sov_bt5: 0,
      sov_bt7: 0,
      sov_t60: 3,
      sov_t70: 4,
      sov_t28: 0,
      sov_t35: 0,
      sov_su122: 6,
      sov_su85: 7,
      sov_kv1s: 5,
      sov_kv2: 0,
      sov_kv85: 7,
      sov_su152: 6,
      sov_is1: 7,
      sov_isu122: 8,
      sov_isu122s: 9,
      // <<< round 108 roster
    },
    startForce: {
      1: [{ name: '1-ya Rota', squads: ['sov_hq', 'sov_rifle', 'sov_rifle', 'sov_maxim', 'sov_ptrd'] }],
      2: [{ name: '1. Zug', squads: ['ger_hq', 'ger_gruppe', 'ger_gruppe', 'ger_mg', 'ger_pak38'] }],
    },
    battles: [
      { map: 'Brest Fortress', role: 'defend', deployMax: 13,
        objective: 'Hold the Citadel. Nobody is coming.',
        rp: { 1: 9, 2: 26 },
        doctrine: { 1: { armour: 0, transport: 0, mg: 0.26, rifle: 0.46 }, 2: { armour: 0.16, rifle: 0.42 } },
        must: { 1: { sov_maxim: 2, sov_sapper: 1 }, 2: { ger_pioneer: 2, ger_flame: 1, ger_sig33: 1 } } },
      { map: 'The Smolensk Road', role: 'defend', deployMax: 14,
        objective: 'Block the highway east.',
        rp: { 1: 12, 2: 26 },
        doctrine: { 1: { armour: 0.18, atgun: 0.22, rifle: 0.38 }, 2: { armour: 0.40, transport: 0.10 } },
        // The KV-1 is the shock of 1941 and the reason the 37 mm got its name.
        must: { 1: { sov_kv1: 1, sov_t3476: 1, sov_zis3: 1 }, 2: { ger_pz3: 3, ger_pak38: 2 } } },
      { map: 'Yelnya Salient', role: 'attack', deployMax: 15,
        objective: 'Pinch out the bulge. Both shoulders at once.',
        rp: { 1: 16, 2: 22 },
        doctrine: { 1: { armour: 0.20, arty: 0.14, rifle: 0.40 }, 2: { armour: 0.12, mg: 0.24, atgun: 0.18 } },
        must: { 1: { sov_katyusha: 1, sov_t3476: 2 }, 2: { ger_mg: 2, ger_pak38: 2 } } },
      { map: 'Volokolamsk Highway', role: 'defend', deployMax: 14,
        objective: 'Hold the Moscow road. There is no depth behind it.',
        rp: { 1: 16, 2: 24 },
        doctrine: { 1: { atgun: 0.26, at: 0.16, mg: 0.22, rifle: 0.34 }, 2: { armour: 0.42, rifle: 0.34 } },
        must: { 1: { sov_45mm: 2, sov_ptrd: 2, sov_zis3: 1 }, 2: { ger_pz3: 2, ger_pz4: 1 } } },
      { map: "Pavlov’s House", role: 'defend', deployMax: 11,
        objective: 'Hold the house. The square in front of it is the city.',
        rp: { 1: 18, 2: 22 },
        doctrine: { 1: { mg: 0.24, at: 0.18, rifle: 0.46, armour: 0 }, 2: { armour: 0.14, rifle: 0.46 } },
        must: { 1: { sov_smg: 2, sov_sniper: 1, sov_ptrd: 1 }, 2: { ger_pioneer: 2, ger_flame: 1 } } },
      { map: 'Kotelnikovo', role: 'defend', deployMax: 16,
        objective: 'Stop the relief on the Myshkova.',
        rp: { 1: 22, 2: 22 },
        doctrine: { 1: { atgun: 0.28, armour: 0.22, rifle: 0.32 }, 2: { armour: 0.48, transport: 0.10 } },
        must: { 1: { sov_zis3: 2, sov_t3476: 2 }, 2: { ger_pz4: 2, ger_tiger: 1 } } },
      { map: 'Oboyan Road', role: 'defend', deployMax: 18,
        objective: 'Hold the second belt at Kursk.',
        rp: { 1: 28, 2: 26 },
        doctrine: { 1: { atgun: 0.32, armour: 0.20, mg: 0.18 }, 2: { armour: 0.50, rifle: 0.30 } },
        // The pakfront is the invention that mattered: batteries laid to fire
        // together on one tank rather than singly at whatever is nearest.
        must: { 1: { sov_zis3: 3, sov_45mm: 2, sov_isu152: 1 }, 2: { ger_panther: 2, ger_tiger: 2 } } },
      { map: 'The Minsk Highway', role: 'attack', deployMax: 18,
        objective: 'Cut the road out of the pocket.',
        rp: { 1: 32, 2: 16 },
        doctrine: { 1: { armour: 0.40, rifle: 0.36 }, 2: { armour: 0.16, transport: 0.16, rifle: 0.42 } },
        must: { 1: { sov_t34: 2, sov_guards: 2, sov_katyusha: 1 }, 2: { ger_truck: 2 } } },
      { map: 'Narva — the Blue Hills', role: 'attack', deployMax: 17,
        objective: 'Take the hills. There is no flank for twenty kilometres.',
        rp: { 1: 30, 2: 20 },
        doctrine: { 1: { armour: 0.28, arty: 0.14, rifle: 0.42 }, 2: { armour: 0.14, mg: 0.28, atgun: 0.20 } },
        must: { 1: { sov_guards: 3, sov_isu152: 1, sov_sapper: 2 }, 2: { ger_ss: 3, ger_pak43: 1 } } },
      { map: 'The Vistula Bridgehead', role: 'attack', deployMax: 19,
        objective: 'Break out of Baranów and do not stop.',
        rp: { 1: 38, 2: 14 },
        doctrine: { 1: { armour: 0.46, rifle: 0.34, arty: 0.10 }, 2: { armour: 0.16, atgun: 0.24 } },
        must: { 1: { sov_t34: 3, sov_is2: 1, sov_su100: 1, sov_katyusha: 1 }, 2: { ger_pak43: 1 } } },
      { map: 'Berlin — the Zoo Flak Tower', role: 'attack', deployMax: 18,
        objective: 'Clear the Tiergarten and reach the tower.',
        rp: { 1: 36, 2: 18 },
        doctrine: { 1: { armour: 0.34, rifle: 0.44 }, 2: { armour: 0.10, at: 0.30, rifle: 0.44 } },
        // Assault engineers lead in a city. They always did.
        must: { 1: { sov_sapper: 3, sov_isu152: 1, sov_is2: 1 }, 2: { ger_faust: 3, ger_ss: 2 } } },
    ],
  };

  var OSTHEER = {
    id: 'ostheer41', name: 'Ostheer', subtitle: 'The Eastern Front, 1941–1945',
    side: 'Heeresgruppe Mitte', saveKey: 'tc_campaign_ostheer1',
    blurb: 'The same four years from the other side: three summers of advancing and then two of holding ground '
         + 'with less every month. Nothing is replaced. The first battle is the easiest one you will fight.',
    player: 2,
    nations: { 1: ['sov'], 2: ['ger'] },
    startRP: { 1: 82, 2: 112 },
    // `from` is indexed against the NORMANDY order and is meaningless here, so
    // everything that matters is declared. The Ostheer's curve is the inverse
    // of the Red Army's: the good equipment arrives late and there is less of
    // everything else by then.
    unlock: {
      ger_pz3: 0, ger_pak38: 0, ger_222: 0, ger_gebirg: 0, ger_stug: 0, ger_pz4: 0,
      ger_tiger: 4, ger_panther: 5, ger_nashorn: 5, ger_brummbar: 4, ger_hetzer: 7,
      ger_jagd: 8, ger_kt: 9, ger_stg: 7, ger_pak43: 6, ger_volks: 8, ger_ost: 3,
      ger_ss: 2, ger_fj: 3, ger_jagdpz4: 6, ger_goliath: 4, ger_wirbel: 6,
      sov_t3476: 0, sov_kv1: 0, sov_guards: 2, sov_t34: 5, sov_isu152: 6,
      sov_su100: 8, sov_is2: 8, sov_katyusha: 3,
      // >>> round 108 roster (tools/roster_r108.py writes these rows from tools/roster_r108_spec.py: edit the spec, not them)
      ger_pz1: 0,
      ger_flakpz1: 2,
      ger_pzjg1: 0,
      ger_bison: 0,
      ger_pz2: 0,
      ger_marder2: 4,
      ger_pz35t: 0,
      ger_pz38t: 0,
      ger_flakpz38t: 8,
      ger_aufkl38t: 8,
      ger_grille: 6,
      ger_stuh42: 6,
      ger_ostwind: 10,
      ger_stug4: 8,
      ger_pz4e: 0,
      ger_pz3f: 0,
      ger_stugb: 0,
      ger_hummel: 6,
      ger_elefant: 7,
      ger_sturmtiger: 9,
      ger_jagdtiger: 10,
      sov_t26: 0,
      sov_t40: 0,
      sov_t50: 1,
      sov_bt2: 0,
      sov_bt5: 0,
      sov_bt7: 0,
      sov_t60: 3,
      sov_t70: 4,
      sov_t28: 0,
      sov_t35: 0,
      sov_su122: 6,
      sov_su85: 8,
      sov_kv1s: 5,
      sov_kv2: 0,
      sov_kv85: 8,
      sov_su152: 6,
      sov_is1: 8,
      sov_isu122: 9,
      sov_isu122s: 9,
      // <<< round 108 roster
    },
    startForce: {
      1: [{ name: '1-ya Rota', squads: ['sov_hq', 'sov_rifle', 'sov_rifle', 'sov_maxim', 'sov_ptrd'] }],
      2: [{ name: '1. Zug', squads: ['ger_hq', 'ger_gruppe', 'ger_gruppe', 'ger_mg', 'ger_pak38'] }],
    },
    battles: [
      { map: 'Brest Fortress', role: 'attack', deployMax: 15,
        objective: 'Clear the Citadel. The division is meant to be sixty kilometres east tonight.',
        rp: { 1: 10, 2: 24 },
        doctrine: { 1: { armour: 0, mg: 0.28, rifle: 0.48 }, 2: { armour: 0.16, rifle: 0.44 } },
        must: { 2: { ger_pioneer: 2, ger_flame: 1, ger_sig33: 1 }, 1: { sov_maxim: 2 } } },
      { map: 'The Smolensk Road', role: 'attack', deployMax: 16,
        objective: 'Keep the highway open and break what forms across it.',
        rp: { 1: 15, 2: 24 },
        doctrine: { 1: { armour: 0.18, atgun: 0.24, rifle: 0.38 }, 2: { armour: 0.44, transport: 0.12 } },
        must: { 2: { ger_pz3: 3, ger_pak38: 2, ger_222: 1 }, 1: { sov_kv1: 1, sov_t3476: 1 } } },
      { map: 'Yelnya Salient', role: 'defend', deployMax: 15,
        objective: 'Hold the salient shoulders.',
        rp: { 1: 20, 2: 17 },
        doctrine: { 1: { armour: 0.22, arty: 0.14, rifle: 0.40 }, 2: { mg: 0.26, atgun: 0.20, rifle: 0.38 } },
        must: { 2: { ger_mg: 2, ger_pak38: 2, ger_leig: 1 }, 1: { sov_katyusha: 1 } } },
      { map: 'Volokolamsk Highway', role: 'attack', deployMax: 16,
        objective: 'Open the Moscow road. It is a hundred and eight kilometres.',
        rp: { 1: 23, 2: 16 },
        doctrine: { 1: { atgun: 0.28, at: 0.16, mg: 0.22 }, 2: { armour: 0.46, rifle: 0.32 } },
        must: { 2: { ger_pz3: 2, ger_pz4: 1, ger_gebirg: 1 }, 1: { sov_45mm: 2, sov_ptrd: 2 } } },
      { map: 'The Grain Elevator', role: 'attack', deployMax: 12,
        objective: 'Take the elevator, floor by floor and cellar by cellar.',
        rp: { 1: 17, 2: 14 },
        doctrine: { 1: { mg: 0.26, rifle: 0.52, armour: 0 }, 2: { armour: 0.14, rifle: 0.50 } },
        must: { 2: { ger_pioneer: 2, ger_flame: 1, ger_sig33: 1 }, 1: { sov_smg: 2, sov_ptrd: 1 } } },
      { map: 'Kotelnikovo', role: 'attack', deployMax: 17,
        objective: 'Wintergewitter — open the corridor to Sixth Army.',
        rp: { 1: 29, 2: 15 },
        doctrine: { 1: { atgun: 0.30, armour: 0.20 }, 2: { armour: 0.50, transport: 0.10 } },
        must: { 2: { ger_pz4: 2, ger_tiger: 1, ger_251: 1 }, 1: { sov_zis3: 2, sov_t3476: 2 } } },
      { map: 'Oboyan Road', role: 'attack', deployMax: 18,
        objective: 'Zitadelle — break the belts on the Oboyan axis.',
        rp: { 1: 36, 2: 15 },
        doctrine: { 1: { atgun: 0.34, armour: 0.20 }, 2: { armour: 0.54, rifle: 0.28 } },
        must: { 2: { ger_panther: 2, ger_tiger: 2, ger_brummbar: 1 }, 1: { sov_zis3: 3, sov_45mm: 2 } } },
      { map: 'Ponyri Station', role: 'attack', deployMax: 17,
        objective: 'Take the station and the ground behind it.',
        rp: { 1: 38, 2: 12 },
        doctrine: { 1: { atgun: 0.30, mg: 0.20, rifle: 0.38 }, 2: { armour: 0.46, rifle: 0.32 } },
        must: { 2: { ger_brummbar: 1, ger_nashorn: 1 }, 1: { sov_zis3: 2, sov_sapper: 1 } } },
      { map: 'The Minsk Highway', role: 'defend', deployMax: 16,
        objective: 'Get the column across the Berezina going west.',
        rp: { 1: 44, 2: 10 },
        doctrine: { 1: { armour: 0.44, rifle: 0.34 }, 2: { transport: 0.18, at: 0.20, rifle: 0.44 } },
        must: { 2: { ger_truck: 2, ger_faust: 2 }, 1: { sov_t34: 2, sov_guards: 2 } } },
      { map: 'Narva — the Blue Hills', role: 'defend', deployMax: 16,
        objective: 'Hold the isthmus. There is no flank to lose.',
        rp: { 1: 48, 2: 9 },
        doctrine: { 1: { armour: 0.30, arty: 0.14 }, 2: { mg: 0.30, atgun: 0.22, rifle: 0.36 } },
        must: { 2: { ger_ss: 3, ger_pak43: 1, ger_nebel: 1 }, 1: { sov_guards: 3, sov_isu152: 1 } } },
      { map: 'Seelow Heights', role: 'defend', deployMax: 17,
        objective: 'Hold the last ridge in front of Berlin.',
        rp: { 1: 56, 2: 7 },
        doctrine: { 1: { armour: 0.44, rifle: 0.38, arty: 0.10 }, 2: { at: 0.30, atgun: 0.24, rifle: 0.38 } },
        must: { 2: { ger_faust: 3, ger_volks: 2, ger_flak88: 1 }, 1: { sov_is2: 2, sov_katyusha: 1 } } },
    ],
  };

  var MEDITERRANEAN = {
    id: 'desert41', name: 'Desert and Mountain', subtitle: 'North Africa and Italy, 1941–1945',
    side: 'Eighth Army & Fifth Army', saveKey: 'tc_campaign_med1',
    blurb: 'Two wars in one theatre. The desert has no cover and no flanks that are not open, so it is about range; '
         + 'Italy is a country built for defence, and it is about the river and the ridge in front of you.',
    player: 1,
    nations: { 1: ['us', 'uk'], 2: ['ger', 'it'] },
    startRP: { 1: 92, 2: 96 },
    // The Axis side here is TWO armies, and the Italian equipment is genuinely
    // poor and priced that way — which means the buyer will take a lot of it,
    // which is correct for 1941 and wrong for 1944. `it_*` gets no late unlock
    // because the Regio Esercito stops being a co-belligerent after battle six,
    // and by then the German list is affordable enough to crowd it out.
    unlock: {
      it_fante: 0, it_bersag: 0, it_m1340: 0, it_cannone47: 0, it_breda37: 0, it_hq: 0,
      it_semovente: 2,
      ger_pz3: 0, ger_pak38: 0, ger_222: 0, ger_gebirg: 3,
      ger_tiger: 5, ger_panther: 8, ger_fj: 5, ger_ss: 7, ger_pak43: 8,
      ger_brummbar: 8, ger_nashorn: 8, ger_hetzer: 9, ger_stg: 10,
      us_m3lee: 0, us_37mm: 0, us_sherman: 2, us_sherman76: 8, us_zippo: 9,
      br_churchill: 3, br_firefly: 7, br_17pdr: 5, br_croc: 8, br_kangaroo: 10,
      br_avre: 8, us_priest: 3, br_sexton: 5, us_jumbo: 11,
      // >>> round 115 roster (tools/roster_r115.py writes these rows from tools/roster_r115_spec.py: edit the spec, not them)
      us_m4a3e8: 13,
      us_m24: 13,
      us_m36: 12,
      us_m8hmc: 7,
      us_m3gmc: 5,
      us_m15: 7,
      us_m3a1sc: 5,
      us_m20: 9,
      br_matilda: 0,
      br_valentine: 4,
      br_archer: 12,
      br_bishop: 4,
      br_crusader: 3,
      br_churchill3: 6,
      br_humber: 7,
      br_staghound: 9,
      br_dingo: 0,
      br_sherman: 4,
      br_stuart: 5,
      br_m10: 7,
      br_priest: 4,
      br_halftrack: 7,
      br_grant: 2,
      us_longtom: 7,
      us_mortar42: 7,
      br_2pdr: 0,
      br_55in: 4,
      br_bofors: 0,
      // <<< round 115 roster
      // >>> round 108 roster (tools/roster_r108.py writes these rows from tools/roster_r108_spec.py: edit the spec, not them)
      ger_pz1: 0,
      ger_pzjg1: 0,
      ger_pz2: 0,
      ger_marder2: 2,
      ger_grille: 8,
      ger_stuh42: 7,
      ger_stug4: 12,
      ger_pz4e: 0,
      ger_pz3f: 0,
      ger_hummel: 7,
      ger_elefant: 10,
      // <<< round 108 roster
    },
    startForce: {
      1: [{ name: 'A Company', squads: ['us_hq', 'br_section', 'br_section', 'br_vickers', 'br_6pdr'] }],
      2: [{ name: '1. Kompanie', squads: ['ger_hq', 'ger_gruppe', 'it_fante', 'ger_mg', 'it_cannone47'] }],
    },
    battles: [
      { map: 'Tobruk — the Perimeter', role: 'defend', deployMax: 14,
        objective: 'Hold the perimeter posts at Ras el Medauuar.',
        rp: { 1: 14, 2: 18 },
        doctrine: { 1: { atgun: 0.24, mg: 0.22, arty: 0.12, rifle: 0.36 }, 2: { armour: 0.36, rifle: 0.38 } },
        must: { 1: { br_25pdr: 2, br_vickers: 2 }, 2: { ger_pz3: 2, it_fante: 2 } } },
      { map: 'Sidi Rezegh', role: 'defend', deployMax: 15,
        objective: 'Hold the airfield between the escarpments.',
        rp: { 1: 16, 2: 18 },
        doctrine: { 1: { armour: 0.34, atgun: 0.20 }, 2: { armour: 0.42, atgun: 0.16 } },
        must: { 1: { us_m3lee: 1, us_stuart: 2 }, 2: { ger_flak88: 2, ger_pz3: 2 } } },
      { map: 'Bir Hakeim', role: 'defend', deployMax: 14,
        objective: 'Hold the box at the southern hinge of the line.',
        rp: { 1: 18, 2: 20 },
        doctrine: { 1: { atgun: 0.28, mg: 0.24, rifle: 0.38 }, 2: { armour: 0.38, rifle: 0.36 } },
        must: { 1: { br_6pdr: 2, br_vickers: 2 }, 2: { it_m1340: 2, ger_pz3: 1 } } },
      { map: 'Alam Halfa Ridge', role: 'defend', deployMax: 16,
        objective: 'Hold the ridge. No armoured counter-attack — that is the plan.',
        rp: { 1: 22, 2: 22 },
        doctrine: { 1: { atgun: 0.34, armour: 0.22, arty: 0.12 }, 2: { armour: 0.50, rifle: 0.30 } },
        must: { 1: { br_6pdr: 3, us_sherman: 1 }, 2: { ger_pz4: 2, it_semovente: 1 } } },
      { map: 'El Alamein', role: 'attack', deployMax: 17,
        objective: 'Break through the minefield belts.',
        rp: { 1: 28, 2: 18 },
        doctrine: { 1: { armour: 0.40, rifle: 0.34, arty: 0.12 }, 2: { atgun: 0.30, mg: 0.24, rifle: 0.34 } },
        must: { 1: { us_sherman: 2, br_25pdr: 2, us_engineer: 1 }, 2: { ger_flak88: 2, it_cannone47: 2 } } },
      { map: 'Kasserine Pass', role: 'defend', deployMax: 15,
        objective: 'Hold the pass. Nothing behind it is ready.',
        rp: { 1: 24, 2: 24 },
        doctrine: { 1: { atgun: 0.26, at: 0.18, rifle: 0.40 }, 2: { armour: 0.44, rifle: 0.34 } },
        must: { 1: { us_37mm: 2, us_57mm: 1 }, 2: { ger_pz4: 2, ger_tiger: 1 } } },
      { map: 'Longstop Hill', role: 'attack', deployMax: 15,
        objective: 'Take both summits. The second is the one nobody mentioned.',
        rp: { 1: 26, 2: 18 },
        doctrine: { 1: { rifle: 0.46, mortar: 0.14, armour: 0.18 }, 2: { mg: 0.28, mortar: 0.16, rifle: 0.40 } },
        must: { 1: { br_section: 3, br_commando: 1 }, 2: { ger_gebirg: 2, ger_mg: 2 } } },
      { map: 'Salerno — the Beach', role: 'defend', deployMax: 17,
        objective: 'Shut the corridor between the beachheads.',
        rp: { 1: 26, 2: 26 },
        doctrine: { 1: { arty: 0.16, atgun: 0.22, rifle: 0.40 }, 2: { armour: 0.46, rifle: 0.34 } },
        must: { 1: { us_105: 2, us_fo: 1, us_57mm: 2 }, 2: { ger_pz4: 2, ger_tiger: 1 } } },
      { map: 'San Pietro', role: 'attack', deployMax: 15,
        objective: 'Take the terraced village below Sammucro.',
        rp: { 1: 24, 2: 20 },
        doctrine: { 1: { rifle: 0.48, mortar: 0.14, armour: 0.16 }, 2: { mg: 0.28, rifle: 0.42 } },
        must: { 1: { us_assault: 2, us_flame: 1 }, 2: { ger_mg: 2, ger_sniper2: 1 } } },
      { map: 'The Rapido', role: 'attack', deployMax: 15,
        objective: 'Get a bridgehead over the river and keep it.',
        rp: { 1: 24, 2: 24 },
        doctrine: { 1: { rifle: 0.52, mortar: 0.14, armour: 0.06 }, 2: { mg: 0.30, mortar: 0.16, atgun: 0.18 } },
        must: { 1: { us_engineer: 3, us_fo: 1 }, 2: { ger_fj: 2, ger_nebel: 1 } } },
      { map: 'Anzio — the Wadis', role: 'defend', deployMax: 17,
        objective: 'Hold the wadi line in front of the beachhead.',
        rp: { 1: 28, 2: 28 },
        doctrine: { 1: { mg: 0.24, arty: 0.16, rifle: 0.42 }, 2: { armour: 0.34, rifle: 0.42 } },
        must: { 1: { us_105: 2, us_mg30: 2 }, 2: { ger_tiger: 1, ger_nebel: 1, ger_flame: 1 } } },
      { map: 'The Abbey Hill', role: 'attack', deployMax: 16,
        objective: 'Take the shoulder below the abbey.',
        rp: { 1: 28, 2: 22 },
        doctrine: { 1: { rifle: 0.52, mortar: 0.16, armour: 0.06 }, 2: { mg: 0.30, mortar: 0.18, rifle: 0.40 } },
        must: { 1: { br_section: 3, br_commando: 2, us_fo: 1 }, 2: { ger_fj: 3, ger_fjmg: 2 } } },
      { map: 'The Gothic Line — Gemmano', role: 'attack', deployMax: 16,
        objective: 'Take the ridge and hold it through the counter-attack.',
        rp: { 1: 30, 2: 22 },
        doctrine: { 1: { rifle: 0.44, armour: 0.24, arty: 0.12 }, 2: { mg: 0.26, atgun: 0.20, rifle: 0.40 } },
        must: { 1: { br_churchill: 2, br_25pdr: 2 }, 2: { ger_mg: 3, ger_pak40: 1 } } },
      { map: 'The Argenta Gap', role: 'attack', deployMax: 18,
        objective: 'Force the gap between the lake and the flood.',
        rp: { 1: 36, 2: 16 },
        doctrine: { 1: { armour: 0.44, transport: 0.12, rifle: 0.34 }, 2: { at: 0.24, mg: 0.24, rifle: 0.42 } },
        // Kangaroos and Crocodiles: by 1945 the Eighth Army finally had the
        // tools the ground had been asking for since Salerno.
        must: { 1: { br_kangaroo: 2, br_croc: 1, br_avre: 1 }, 2: { ger_faust: 2, ger_fj: 2 } } },
    ],
  };

  var FRANCE40 = {
    id: 'france40', name: 'The Fall of France', subtitle: '10 May – 25 June 1940',
    side: 'Armée de Terre', saveKey: 'tc_campaign_france1',
    blurb: 'Better tanks than the Wehrmacht, a better anti-tank gun, and six weeks. The equipment is not the reason '
         + '1940 went the way it did, and this campaign is written so you can find that out from the inside.',
    player: 1,
    nations: { 1: ['fr', 'uk'], 2: ['ger'] },
    // THE ONLY CAMPAIGN WHERE BOTH SIDES SHRINK. France is not resupplied
    // because the depots are being overrun, and the Wehrmacht is not resupplied
    // because it is four hundred kilometres from its railheads. What changes is
    // the ratio, and it changes against you every battle.
    startRP: { 1: 108, 2: 96 },
    unlock: {
      fr_groupe: 0, fr_hq: 0, fr_hotch: 0, fr_canon25: 0, fr_h39: 0,
      fr_somua: 0, fr_b1bis: 1, fr_canon47: 1, fr_maquis: 6,
      br_section: 2, br_vickers: 2, br_churchill: 2, br_25pdr: 2, br_6pdr: 99,
      ger_pz3: 0, ger_pak38: 0, ger_222: 0, ger_gebirg: 0, ger_pz4: 0, ger_stug: 4,
      // None of the late-war German list existed in 1940. Locking it out is
      // one line and it is the difference between a campaign and a costume.
      ger_tiger: 99, ger_panther: 99, ger_kt: 99, ger_jagd: 99, ger_hetzer: 99,
      ger_nashorn: 99, ger_jagdpz4: 99, ger_brummbar: 99, ger_pak43: 99,
      ger_stg: 99, ger_volks: 99, ger_ss: 99, ger_fj: 5, ger_ost: 99,
      ger_faust: 99, ger_schreck: 99, ger_puma: 99, ger_wirbel: 99, ger_marder: 99,
      ger_flak38: 3, ger_wespe: 99, ger_goliath: 99, ger_sniper2: 99, ger_stummel: 99,
      // >>> round 115 roster (tools/roster_r115.py writes these rows from tools/roster_r115_spec.py: edit the spec, not them)
      br_matilda: 5,
      br_dingo: 0,
      fr_r35: 0,
      fr_h35: 0,
      fr_fcm36: 2,
      fr_amr35: 0,
      fr_d2: 6,
      fr_panhard: 0,
      fr_laffly: 2,
      fr_ue: 0,
      fr_lorraine: 0,
      br_2pdr: 0,
      fr_75: 0,
      fr_mortar81: 0,
      fr_mortar60: 0,
      br_bofors: 0,
      fr_155gpf: 0,
      fr_105l36: 0,
      fr_alpin: 8,
      fr_legion: 7,
      fr_tirailleur: 0,
      // <<< round 115 roster
      // >>> round 108 roster (tools/roster_r108.py writes these rows from tools/roster_r108_spec.py: edit the spec, not them)
      ger_pz1: 0,
      ger_pzjg1: 0,
      ger_bison: 0,
      ger_pz2: 0,
      ger_pz35t: 0,
      ger_pz38t: 0,
      ger_pz4e: 0,
      ger_pz3f: 0,
      ger_stugb: 4,
      // <<< round 108 roster
    },
    startForce: {
      1: [{ name: '1re Section', squads: ['fr_hq', 'fr_groupe', 'fr_groupe', 'fr_hotch', 'fr_canon25'] }],
      2: [{ name: '1. Zug', squads: ['ger_hq', 'ger_gruppe', 'ger_gruppe', 'ger_mg', 'ger_pak38'] }],
    },
    battles: [
      { map: 'Hannut', role: 'defend', deployMax: 15,
        objective: 'Hold the cavalry screen for the day, then break clean.',
        rp: { 1: 20, 2: 20 },
        doctrine: { 1: { armour: 0.42, atgun: 0.18, rifle: 0.32 }, 2: { armour: 0.46, rifle: 0.34 } },
        must: { 1: { fr_somua: 2, fr_h39: 2 }, 2: { ger_pz3: 3, ger_pz4: 1 } } },
      { map: 'Gembloux Gap', role: 'defend', deployMax: 15,
        objective: 'Hold the line the cavalry bought you time to dig.',
        rp: { 1: 18, 2: 24 },
        doctrine: { 1: { atgun: 0.26, mg: 0.24, rifle: 0.40 }, 2: { armour: 0.44, rifle: 0.36 } },
        must: { 1: { fr_canon25: 2, fr_hotch: 2 }, 2: { ger_pz3: 2, ger_flak88: 1 } } },
      { map: 'Sedan — the Bulson Ridge', role: 'attack', deployMax: 15,
        objective: 'Seal the Meuse bridgehead before the armour is across.',
        rp: { 1: 17, 2: 25 },
        doctrine: { 1: { armour: 0.38, rifle: 0.38 }, 2: { atgun: 0.26, mg: 0.24, rifle: 0.40 } },
        // THE HOUR AND A HALF. The counter-attack that was ordered for dawn
        // went in after the first German tanks arrived instead of before.
        must: { 1: { fr_b1bis: 1, fr_somua: 2 }, 2: { ger_pak38: 2, ger_flak88: 1 } } },
      { map: 'Stonne', role: 'attack', deployMax: 14,
        objective: 'Retake the village. It changed hands seventeen times.',
        rp: { 1: 16, 2: 26 },
        doctrine: { 1: { armour: 0.36, rifle: 0.42 }, 2: { atgun: 0.28, mg: 0.24, rifle: 0.40 } },
        must: { 1: { fr_b1bis: 1, fr_groupe: 2 }, 2: { ger_pak38: 2, ger_pioneer: 1 } } },
      { map: 'Montcornet', role: 'attack', deployMax: 14,
        objective: 'Cut the corridor at the crossroads.',
        rp: { 1: 14, 2: 27 },
        doctrine: { 1: { armour: 0.52, rifle: 0.28 }, 2: { atgun: 0.30, transport: 0.14, rifle: 0.38 } },
        must: { 1: { fr_b1bis: 2, fr_h39: 2 }, 2: { ger_flak88: 2, ger_truck: 1 } } },
      { map: 'Arras', role: 'attack', deployMax: 14,
        objective: 'Get in among the transport and stay there.',
        rp: { 1: 13, 2: 29 },
        doctrine: { 1: { armour: 0.48, rifle: 0.32 }, 2: { atgun: 0.28, transport: 0.16, rifle: 0.38 } },
        must: { 1: { br_churchill: 2, br_section: 1 }, 2: { ger_flak88: 2, ger_truck: 2 } } },
      { map: 'Abbeville Bridgehead', role: 'attack', deployMax: 15,
        objective: 'Take Mont de Caubert and pinch out the bridgehead.',
        rp: { 1: 12, 2: 31 },
        doctrine: { 1: { armour: 0.54, rifle: 0.26 }, 2: { atgun: 0.34, mg: 0.22, rifle: 0.36 } },
        // Tanks attacking dug-in guns without infantry lose. The map is written
        // to let you discover that and the `doctrine` weights invite it.
        must: { 1: { fr_b1bis: 2, fr_somua: 2 }, 2: { ger_pak38: 3, ger_flak88: 1 } } },
      { map: 'The Dunkirk Perimeter', role: 'defend', deployMax: 16,
        objective: 'Hold the canal line while the beach empties.',
        rp: { 1: 10, 2: 34 },
        doctrine: { 1: { mg: 0.26, atgun: 0.22, rifle: 0.44, armour: 0.04 }, 2: { armour: 0.24, rifle: 0.46 } },
        must: { 1: { fr_hotch: 2, br_vickers: 1, fr_canon47: 1 }, 2: { ger_pioneer: 2, ger_sig33: 1 } } },
      { map: 'The Somme — Hedgehogs', role: 'defend', deployMax: 16,
        objective: 'Hold the hedgehogs. Being cut off is expected.',
        rp: { 1: 9, 2: 36 },
        doctrine: { 1: { mg: 0.26, atgun: 0.24, rifle: 0.42 }, 2: { armour: 0.40, rifle: 0.38 } },
        must: { 1: { fr_canon47: 2, fr_hotch: 2 }, 2: { ger_pz3: 2, ger_sig33: 1 } } },
      { map: 'The Maginot Casemate', role: 'defend', deployMax: 13,
        objective: 'Hold the block and the interval either side.',
        rp: { 1: 8, 2: 39 },
        doctrine: { 1: { mg: 0.32, atgun: 0.22, rifle: 0.40, armour: 0 }, 2: { armour: 0.18, rifle: 0.52 } },
        must: { 1: { fr_hotch: 3, fr_canon47: 1 }, 2: { ger_pioneer: 3, ger_flame: 1, ger_flak88: 2 } } },
      { map: 'Saumur — the Cadets', role: 'defend', deployMax: 13,
        objective: 'Hold the Loire bridges. There is no strategic purpose to this.',
        rp: { 1: 7, 2: 42 },
        doctrine: { 1: { mg: 0.28, atgun: 0.22, rifle: 0.46, armour: 0.04 }, 2: { armour: 0.22, rifle: 0.50 } },
        must: { 1: { fr_groupe: 3, fr_hotch: 2 }, 2: { ger_pioneer: 2, ger_sig33: 1, ger_flak88: 1 } } },
    ],
  };

  var CAMPAIGNS = [NORMANDY, WESTHEER, MARKET_GARDEN, REDARMY, OSTHEER, MEDITERRANEAN, FRANCE40];
  // The one in play. Every `CAMPAIGN.` reference below reads through this, so
  // switching operations is one assignment and nothing else has to know.
  var CAMPAIGN = NORMANDY;
  function selectCampaign(id) {
    for (var i = 0; i < CAMPAIGNS.length; i++) {
      if (CAMPAIGNS[i].id !== id) continue;
      CAMPAIGN = CAMPAIGNS[i];
      SAVE_KEY = CAMPAIGN.saveKey;
      return CAMPAIGN;
    }
    return CAMPAIGN;
  }
  /** The battle a template becomes available at, in THIS campaign. */
  function fromOf(t) {
    if (!t) return 0;
    var u = CAMPAIGN.unlock;
    if (u && u[t.id] !== undefined) return u[t.id];
    return t.from || 0;
  }

  // The shape a side's force takes when the buyer fills it in.
  // `arty` WAS NOT IN THIS TABLE, and the buyer skips any template whose
  // category has no doctrine weight — so every on-map gun in the game (the
  // Nebelwerfer, the Wespe, the leFH, the sIG 33, the 155, the Priest, the
  // 25-pounder, the Cannon Company, the Sexton) was unreachable by automatic
  // requisition on both sides, permanently. It was almost certainly an
  // oversight from `autoBuildSupport` buying OFF-MAP missions separately, but
  // a battery you can see, shell and overrun is not the same thing as a fire
  // mission on a radio, and a defence with no guns of its own is not a
  // defence. Small weights: they are expensive, and the off-map allotment has
  // already taken its fifth of the budget before this runs.
  var AI_DOCTRINE = {
    attack: { rifle: 0.32, mg: 0.09, at: 0.08, mortar: 0.07, armour: 0.23, atgun: 0.06, command: 0.05, recon: 0.06, transport: 0.04, arty: 0.04 },
    defend: { rifle: 0.29, mg: 0.13, at: 0.10, mortar: 0.09, armour: 0.13, atgun: 0.14, command: 0.05, recon: 0.05, transport: 0.02, arty: 0.07 },
  };
  // Caps: how many of one template may sit in a battlegroup at once. Without
  // them the buyer fills nine platoons with the single best thing it can
  // afford, which is neither historical nor interesting to fight.
  var CAPS = {
    us_hq: 2, ger_hq: 2, us_sniper: 2, ger_sniper: 2, us_recon: 3, ger_aufklarer: 3,
    us_flame: 1, ger_flame: 1, us_arty: 2, ger_nebel: 2, ger_wespe: 2,
    us_3inch: 2, br_17pdr: 1, ger_flak88: 2, br_croc: 1,
    us_hellcat: 2, br_firefly: 2, br_churchill: 2, ger_tiger: 2,
    ger_jagd: 1, ger_kt: 1, ger_wirbel: 1, ger_panther: 3, us_m10: 3,
    // The new establishment. Caps are the historical scarcity, not a balance
    // knob: a rifle regiment had one Ranger battalion attached at most, the
    // AVREs came from one specialist brigade, and eight Jumbos reached Europe
    // for every four hundred Shermans.
    us_para: 4, us_ranger: 2, us_aid: 2, us_priest: 2, us_jumbo: 1,
    br_commando: 2, br_avre: 1, br_crab: 1, br_25pdr: 2, br_sniper: 2, br_cromwell: 3,
    ger_fjmg: 3, ger_flak38: 2, ger_lefh: 2, ger_sig33: 1, ger_jagdpz4: 2, ger_goliath: 2,
    // The five new theatres. Same rule as above: this is historical scarcity,
    // not a balance knob. Guards heavy tank regiments were army-level assets
    // and a rifle division saw one when it was given one; the Katyusha drove
    // away after ten seconds and belonged to somebody else; there were never
    // enough 47 APX to go round, which is most of why 1940 went as it did.
    sov_hq: 2, sov_is2: 2, sov_isu152: 2, sov_su100: 2, sov_katyusha: 2,
    sov_sniper: 2, sov_scout: 3, sov_kv1: 2, sov_guards: 6, sov_penal: 3,
    it_hq: 2, it_semovente: 2, it_bersag: 4, it_m1340: 4,
    fr_hq: 2, fr_b1bis: 2, fr_somua: 3, fr_canon47: 2, fr_maquis: 3,
    ger_pak43: 2, ger_brummbar: 1, ger_gebirg: 3, ger_222: 3, ger_stg: 3, ger_pz3: 4,
    us_marine: 4, us_zippo: 1, us_sherman105: 2, us_m3lee: 3, us_37mm: 3,
  };
  var STARTING_FORCE = {
    1: [{ name: '1st Platoon', squads: ['us_hq', 'us_rifle', 'us_rifle', 'us_rifle', 'us_mg30'] }],
    2: [{ name: '1. Zug', squads: ['ger_hq', 'ger_gruppe', 'ger_gruppe', 'ger_mg', 'ger_faust'] }],
  };

  // =========================================================================
  // STATE — the battlegroup
  // =========================================================================
  //
  //   force[team] = {
  //     seq,                                   // uid counter
  //     rp,                                    // requisition points in hand
  //     platoons: [ { name, slots: [uid|null …] } ],
  //     squads:   { uid: { uid, tmpl, name, men:[type…], vet, kills, battles } },
  //     support:  { fireSupportKey: missionsRemaining },
  //   }
  //
  // `support` is the off-map guns: batteries you never see and cannot lose,
  // bought by the mission. They do not persist the way a squad does — you buy
  // fire for THIS battle and any of it you do not call is gone, because the
  // guns were allotted to you for the operation and the operation is over.
  //
  // `men` is the ACTUAL roster, not the establishment. It shrinks when men are
  // killed and only grows when replacements are paid for, which is the whole
  // economy of the campaign in one array.
  function freshForce(team, diff) {
    var D = DIFFICULTY[diff] || DIFFICULTY.regular;
    var mine = team === CAMPAIGN.player;
    // THE SQUARE ROOT IS DELIBERATE. `deployMax` no longer caps anything —
    // everything you bought turns up — so the starting pool IS the force ratio
    // of the first battle, and applying the full multiplier to it put an Elite
    // player across the start line at about one to two before he had had a
    // chance to earn anything back. Softening the START and leaving the
    // per-battle ALLOWANCE at full strength makes the setting ramp through the
    // operation instead of deciding it before the first shot.
    var k = Math.sqrt(mine ? D.rp : D.foeRp);
    var f = { seq: 0, rp: Math.round((CAMPAIGN.startRP[team] || 60) * k),
              platoons: [], squads: {}, support: {} };
    // The cadre a side starts an operation with. Normandy and the Westheer
    // share the default; every other theatre brings its own, because "1st
    // Platoon, us_hq, three rifle squads" is not what a Soviet rifle company or
    // a 1940 section de combat looked like — and in a campaign whose Allied
    // nations are `fr`/`uk` it is not even buyable.
    var plan = (CAMPAIGN.startForce && CAMPAIGN.startForce[team]) || STARTING_FORCE[team] || [];
    for (var p = 0; p < plan.length; p++) {
      var pl = { name: plan[p].name, slots: [] };
      for (var i = 0; i < BASE_SLOTS; i++) pl.slots.push(null);
      f.platoons.push(pl);
      for (i = 0; i < plan[p].squads.length && i < BASE_SLOTS; i++) {
        var uid = addSquad(f, plan[p].squads[i], p, i);
        if (uid == null) break;
      }
    }
    return f;
  }

  function squadName(f, tmplId, platoonIdx, slotIdx) {
    var t = T()[tmplId];
    var base = t ? t.name : tmplId;
    return (slotIdx + 1) + '. ' + base;
  }

  /** Put a squad in a slot at full establishment. Returns its uid, or null. */
  function addSquad(f, tmplId, platoonIdx, slotIdx) {
    var t = T()[tmplId];
    if (!t) return null;
    var pl = f.platoons[platoonIdx];
    if (!pl || pl.slots[slotIdx] != null) return null;
    var uid = 'q' + (++f.seq);
    f.squads[uid] = {
      uid: uid, tmpl: tmplId, name: squadName(f, tmplId, platoonIdx, slotIdx),
      men: t.men.slice(), vet: t.vet === undefined ? 1 : t.vet, kills: 0, battles: 0,
    };
    pl.slots[slotIdx] = uid;
    return uid;
  }

  function removeSquad(f, uid) {
    for (var p = 0; p < f.platoons.length; p++) {
      var sl = f.platoons[p].slots;
      for (var i = 0; i < sl.length; i++) if (sl[i] === uid) sl[i] = null;
    }
    delete f.squads[uid];
  }

  function countTmpl(f, tmplId) {
    var n = 0;
    for (var u in f.squads) if (f.squads[u].tmpl === tmplId) n++;
    return n;
  }

  /** What it costs to bring a depleted squad back to establishment. */
  function replaceCost(sq) {
    var t = T()[sq.tmpl];
    if (!t) return 0;
    var missing = t.men.length - sq.men.length;
    if (missing <= 0) return 0;
    return Math.max(1, Math.round(t.rp * missing / t.men.length));
  }

  /** Refill a squad to establishment, restoring the men it is short of in the
   *  template's own order — a rifle squad gets its BAR back before its ninth
   *  rifleman. */
  function refill(sq) {
    var t = T()[sq.tmpl];
    if (!t) return;
    var have = {}, i;
    for (i = 0; i < sq.men.length; i++) have[sq.men[i]] = (have[sq.men[i]] || 0) + 1;
    var out = [];
    for (i = 0; i < t.men.length; i++) {
      var m = t.men[i];
      if (have[m]) { have[m]--; out.push(m); } else out.push(m);
    }
    sq.men = out;
  }

  function forceSize(f) { var n = 0; for (var u in f.squads) n++; return n; }
  function forceMen(f) { var n = 0; for (var u in f.squads) n += f.squads[u].men.length; return n; }

  // =========================================================================
  // READING A BATTLEGROUP AT A GLANCE — the Close Combat idea
  // =========================================================================
  //
  // Close Combat's force screen does one thing very well: it tells you the
  // STATE of every team without you clicking on anything. A row of little men,
  // one per soldier, dark where he is missing. You can see at a distance that
  // 2nd Section is at half strength and that the machine-gun team is intact,
  // and you make the decision from the shape of the list rather than by reading
  // numbers. This is that, in monospace.

  /** One glyph per arm, so the eye can sort the list without reading it. */
  var ARM_GLYPH = {
    command: '\u2605', rifle: '\u25AE', mg: '\u2593', mortar: '\u25E2', at: '\u27A4',
    atgun: '\u2316', arty: '\u25CE', recon: '\u25C7', armour: '\u25B0', transport: '\u25AD',
  };
  var ARM_NAME = {
    command: 'Command', rifle: 'Infantry', mg: 'Machine guns', mortar: 'Mortars',
    at: 'Anti-tank', atgun: 'Guns', arty: 'Artillery', recon: 'Reconnaissance',
    armour: 'Armour', transport: 'Transport',
  };
  var ARM_ORDER = ['command', 'rifle', 'mg', 'mortar', 'at', 'atgun', 'arty', 'recon', 'armour', 'transport'];

  /** A ROW OF MEN. Filled for a soldier still standing, hollow for a gap.
   *  Capped at twelve so a ten-man section and a two-man team still line up,
   *  and a vehicle — which is one "man" — reads as a single mark. */
  function pips(now, full) {
    var f = Math.max(0, Math.min(12, full)), k = Math.max(0, Math.min(f, now)), s = '';
    for (var i = 0; i < f; i++) s += (i < k ? '\u25CF' : '\u25CB');
    if (full > 12) s += '\u2026';
    return s;
  }

  /** What this squad has actually done. The campaign has recorded `kills` and
   *  `battles` on every squad since round two and has never once shown them. */
  function record(sq) {
    var b = sq.battles || 0, k = sq.kills || 0;
    if (!b && !k) return 'unblooded';
    return k + (k === 1 ? ' kill' : ' kills') + ' \u00b7 ' + b + (b === 1 ? ' battle' : ' battles');
  }

  /** Promotion needs two battles survived and then a roll each time; this says
   *  how close a squad is to the next rung, which is the thing that makes you
   *  want to keep a section alive rather than spend it. */
  function vetNote(sq) {
    if (sq.vet >= 2) return 'no further';
    var b = sq.battles || 0;
    if (b < 2) return (2 - b) + ' more battle' + (b === 1 ? '' : 's');
    return 'in line for promotion';
  }

  /** The battlegroup broken down by arm — a company commander's own summary. */
  function armCount(f) {
    var out = {}, u, sq, t;
    for (u in f.squads) {
      sq = f.squads[u]; t = T()[sq.tmpl];
      var c = (t && t.cat) || 'rifle';
      out[c] = (out[c] || 0) + 1;
    }
    return out;
  }

  function freshState(diff, unlimited) {
    var d = DIFFICULTY[diff] ? diff : 'regular';
    return topUp({ id: CAMPAIGN.id, v: 2, battle: 0, log: [], started: Date.now(), diff: d,
                   unlimited: !!unlimited,
                   force: { 1: freshForce(1, d), 2: freshForce(2, d) } });
  }

  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var st = JSON.parse(raw);
      return (st && st.id === CAMPAIGN.id && st.v === 2 && st.force) ? topUp(st) : null;
    } catch (e) { return null; }
  }
  function save(st) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(st)); } catch (e) { /* quota */ } }

  /** Templates a side may requisition at this point in the campaign. */
  /** TWO FUNCTIONS DISAGREED ABOUT WHO THE ALLIES ARE.
   *
   *  `templatesFor` — the player's own requisition list — has a paragraph
   *  explaining that team 1 draws from BOTH the American and the Commonwealth
   *  lists, because the campaign runs down the American sector but the player
   *  commands an Allied battlegroup and Villers-Bocage is a British battle.
   *  This function, which is what the BUYER sees, quietly took `'us'` only.
   *
   *  Measured: fifteen of the Allied side's fifty-four templates — the entire
   *  Commonwealth list — were unreachable by the automatic requisition, and
   *  that is why the `must: { 1: { br_cromwell: 2, br_firefly: 1 } }` on
   *  Villers-Bocage never put a Cromwell on the field. One rule now, in one
   *  place, and both callers use it. */
  /** WHO THIS SIDE IS, IN THIS OPERATION. The rule used to be hardcoded —
   *  team 2 is German, team 1 is American or British — which is true of
   *  Normandy and of nothing else. The Red Army, the Regio Esercito, the
   *  Armee de Terre and the 1940 Wehrmacht all exist in the templates now, and
   *  a campaign says which of them it is fought between. Normandy's default is
   *  the old rule exactly, so both existing operations are unchanged. */
  function nationsOf(team) {
    var n = CAMPAIGN.nations;
    if (n && n[team]) return n[team];
    return team === 2 ? ['ger'] : ['us', 'uk'];
  }
  function nationOK(t, team) {
    var want = nationsOf(team);
    for (var i = 0; i < want.length; i++) if (t.nation === want[i]) return true;
    return false;
  }
  /** The nation a FIRE SUPPORT entry has to match. The table's `nation` field
   *  is 'us' | 'ger' | 'both', so a theatre maps onto one of those two: an
   *  81 mm battery is an 81 mm battery whoever is firing it. */
  function fireNation(team) {
    var want = nationsOf(team);
    for (var i = 0; i < want.length; i++) if (want[i] === 'ger') return 'ger';
    return 'us';
  }

  function availableAt(team, battleIdx, st) {
    var tt = T(), out = [];
    var all = unlimited(st) && team === CAMPAIGN.player;   // no date either
    for (var k in tt) {
      var t = tt[k];
      if (!nationOK(t, team)) continue;
      if (!all && fromOf(t) > battleIdx) continue;
      out.push(t);
    }
    out.sort(function (a, b) { return a.rp - b.rp || (a.name < b.name ? -1 : 1); });
    return out;
  }

  // =========================================================================
  // THE BUYER — fills a battlegroup out to a doctrine, for the AI and for the
  // player's "Requisition to doctrine" button. One implementation, both sides.
  // =========================================================================
  function catOfTmpl(t) { return t.cat || 'rifle'; }

  function doctrineFor(team, role, battle) {
    var base = AI_DOCTRINE[role === 'attack' ? 'attack' : 'defend'], out = {}, k;
    for (k in base) out[k] = base[k];
    var ov = battle && battle.doctrine && battle.doctrine[team];
    if (ov) for (k in ov) out[k] = ov[k];
    var sum = 0;
    for (k in out) sum += out[k];
    if (sum > 0) for (k in out) out[k] /= sum;
    return out;
  }

  /** THE GUNS THE OTHER SIDE BOUGHT.
   *
   *  A German battalion on the defensive in Normandy did not hold a hedgerow
   *  with rifles; it held it with rifles and a registered mortar concentration
   *  on the field in front of them. So the enemy commander spends part of its
   *  requisition on fire missions before it spends the rest on men, and it
   *  spends more of it when it is defending — because a defender has had time
   *  to register his targets and an attacker has not.
   *
   *  Roughly a fifth of the budget, which is about what a real allotment was
   *  worth against a real rifle company. */
  function autoBuildSupport(f, team, role) {
    var FS = window.FIRE_SUPPORT_TABLE;
    if (!FS) return;
    f.support = f.support || {};
    var nat = fireNation(team);
    // A BOTTOMLESS POOL MUST NOT BUY A BOTTOMLESS BARRAGE. This takes a
    // fraction of what is in hand, and with unlimited requisition that fraction
    // is twenty-six thousand points of off-map guns. The per-key cap of three
    // below bounds the count, but the spent-against-budget arithmetic stops
    // meaning anything — so clamp to what a real allowance could ever be.
    var budget = Math.min(140, Math.floor(f.rp * (role === 'defend' ? 0.26 : 0.16)));
    if (budget < 6) return;
    // Mortars first — they are what an infantry battalion actually had on call,
    // they answer in twenty seconds, and they are cheap enough to buy several.
    var order = ['fs_mortar8cm', 'fs_mortar81', 'fs_mortar120', 'fs_arty105', 'fs_rocket', 'fs_arty155'];
    var spent = 0;
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < order.length; i++) {
        var k = order[i], d = FS[k];
        if (!d) continue;
        if (d.nation !== 'both' && d.nation !== nat) continue;
        if (spent + d.rp > budget) continue;
        if ((f.support[k] || 0) >= 3) continue;
        f.support[k] = (f.support[k] || 0) + 1;
        spent += d.rp;
      }
    }
    f.rp -= spent;
  }

  /** Spend `f.rp` filling empty slots in `f`. Mutates the force. */
  function autoBuild(f, team, battleIdx, role, battle) {
    autoBuildSupport(f, team, role);
    var avail = availableAt(team, battleIdx);
    if (!avail.length) return;
    var doc = doctrineFor(team, role, battle);
    var byCat = {}, i;
    for (i = 0; i < avail.length; i++) (byCat[catOfTmpl(avail[i])] || (byCat[catOfTmpl(avail[i])] = [])).push(avail[i]);

    // Room for roughly what the points can buy: the cheapest thing on the list
    // is the upper bound on how many squads this requisition could become.
    var cheapest = 99;
    for (i = 0; i < avail.length; i++) cheapest = Math.min(cheapest, avail[i].rp);
    var slots = emptySlots(f, Math.min(MAX_PLATOONS * BASE_SLOTS, Math.ceil(f.rp / Math.max(1, cheapest))));
    var room = function (t) {
      var cap = capOf(t.id, null, team);      // the AI never gets the sandbox
      return countTmpl(f, t.id) < cap;
    };
    var take = function (t) {
      if (!slots.length || f.rp < t.rp || !room(t)) return false;
      var s = slots.shift();
      if (addSquad(f, t.id, s.p, s.i) == null) return false;
      f.rp -= t.rp;
      return true;
    };

    // Battles that historically fielded a particular thing get it first — the
    // weighted allocation will never afford a Tiger on its own.
    var must = battle && battle.must && battle.must[team];
    if (must) for (var mid in must) {
      var mt = T()[mid];
      if (!mt || fromOf(mt) > battleIdx) continue;
      for (var n = 0; n < must[mid]; n++) take(mt);
    }

    // LARGEST REMAINDER, over templates rather than categories.
    //
    // Each template is owed `share of the battlegroup × doctrine[cat] × w /
    // (weights in cat)` points, MINUS what the battlegroup already has of it;
    // every purchase goes to whichever affordable template is furthest behind
    // what it is owed. Two failure modes this avoids, both of which happened:
    //
    //   · Dividing the budget up front and flooring by cost buys nothing
    //     expensive at all — an armour allowance of twenty points split six
    //     ways is three points of Panzer IV, i.e. none, and a panzer division
    //     turns up as infantry.
    //   · Picking the dearest thing in a category buys four assault squads and
    //     no rifle squads, because an assault squad costs one point more.
    //
    // THE REMAINDER HAS TO BE MEASURED AGAINST WHAT YOU HAVE.
    //
    // It used to be `budget × …` where budget was THIS BATTLE'S CASH, and the
    // claim was reset from zero every time. Largest-remainder only converges
    // if the remainder remembers: reset each round, the same highest-weighted
    // template in each category wins the first pick of every battle, buys
    // itself again, and no other template's claim ever gets a turn to grow.
    //
    // Measured over forty runs of the whole campaign: the buyer reached
    // NINETEEN of ninety-five side-templates, and bought the American side out
    // of exactly three — an HQ, a rifle squad and a machine gun. It was not
    // a shortage of points; it was a scoreboard with no memory.
    //
    // So the target is a share of the WHOLE battlegroup — what it is worth now
    // plus what is in hand — and what is already owned is subtracted. A
    // company with three rifle squads has met its rifle-squad claim and the
    // next pick goes to whatever it has none of, which is how an order of
    // battle actually fills out.
    var held = {}, heldRp = 0, hu, ht;
    for (hu in f.squads) {
      ht = T()[f.squads[hu].tmpl];
      if (!ht) continue;
      held[ht.id] = (held[ht.id] || 0) + ht.rp;
      heldRp += ht.rp;
    }
    var pot = heldRp + f.rp, owed = {}, c;
    for (c in doc) {
      var pool0 = byCat[c];
      if (!pool0 || !pool0.length) continue;
      var wsum = 0;
      for (i = 0; i < pool0.length; i++) wsum += (pool0[i].w || 1);
      if (wsum <= 0) continue;
      for (i = 0; i < pool0.length; i++) {
        owed[pool0[i].id] = pot * doc[c] * (pool0[i].w || 1) / wsum - (held[pool0[i].id] || 0);
      }
    }
    var guard = 0;
    while (slots.length && guard++ < 300) {
      var pick = null, best = -Infinity;
      for (i = 0; i < avail.length; i++) {
        var t2 = avail[i];
        if (owed[t2.id] === undefined) continue;
        if (t2.rp > f.rp || !room(t2)) continue;
        if (owed[t2.id] > best) { best = owed[t2.id]; pick = t2; }
      }
      if (!pick || !take(pick)) break;
      owed[pick.id] -= pick.rp;
    }
    // Anything left goes on the cheapest infantry that will still fit.
    guard = 0;
    while (slots.length && guard++ < 200) {
      var cheap = null;
      for (i = 0; i < avail.length; i++) {
        var t3 = avail[i];
        if (t3.rp > f.rp || !room(t3)) continue;
        if (t3.cat !== 'rifle' && t3.cat !== 'mg' && t3.cat !== 'at') continue;
        if (!cheap || t3.rp < cheap.rp) cheap = t3;
      }
      if (!cheap || !take(cheap)) break;
    }
  }

  /** Empty slots, in platoon order.
   *
   *  Grows the force to `want` free slots by raising new platoons, up to nine.
   *  Without this the AI sat on eighty-four unspent points for the whole
   *  campaign, because its starting platoon was full and nothing ever made
   *  another one — a battlegroup that cannot expand is not a battlegroup. */
  /** Room to put things. Grows the battlegroup until there is enough of it.
   *
   *  This stopped the moment the ninth platoon existed, so the automatic buyer
   *  could never use more than `MAX_PLATOONS × BASE_SLOTS` = 45 slots — while
   *  the force editor's `+ slot` control lets a platoon hold `MAX_SLOTS` = 9,
   *  i.e. 81. Two limits for the same thing, and the buyer had the lower one:
   *  measured with a large budget it sat at 45 squads, 0 empty slots and 1,078
   *  points it could not spend. Now it adds platoons first (which is the shape
   *  a battlegroup should grow in) and only then widens the ones it has. */
  function emptySlots(f, want) {
    var out, p, i;
    for (var grow = 0; grow < MAX_PLATOONS * (MAX_SLOTS - BASE_SLOTS) + MAX_PLATOONS + 2; grow++) {
      out = [];
      for (p = 0; p < f.platoons.length; p++) {
        var sl = f.platoons[p].slots;
        for (i = 0; i < sl.length; i++) if (sl[i] == null) out.push({ p: p, i: i });
      }
      if (out.length >= (want || 1)) break;
      if (f.platoons.length < MAX_PLATOONS) {
        var fresh = [];
        for (i = 0; i < BASE_SLOTS; i++) fresh.push(null);
        f.platoons.push({ name: ORD[f.platoons.length] + ' Platoon', slots: fresh });
        continue;
      }
      var widened = false;
      for (p = 0; p < f.platoons.length; p++) {
        if (f.platoons[p].slots.length < MAX_SLOTS) { f.platoons[p].slots.push(null); widened = true; }
      }
      if (!widened) break;
    }
    return out;
  }

  // =========================================================================
  // INSTALL
  // =========================================================================
  function install(api) {
    G = api;
    if (!window.Squads) throw new Error('Campaign needs assets/squads.js');
    patchGame(api.Game);
    patchBattle(api.Game);
    addTopBarButton(api.game);
    injectStyles();
    api.game.campaign = null;
    return true;
  }

  function patchGame(Game) {
    var P = Game.prototype;

    P.campaignStart = function (resume) {
      var st = resume ? load() : null;
      this.campaign = st || freshState(pendingDiff, pendingUnlimited);
      if (!st) save(this.campaign);
      this._briefSlot = null;
      this.showBriefing();
    };

    P.campaignAbandon = function () {
      this.campaign = null;
      this.playerTeam = 1;
      this._campaignLive = false;
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
      var el = document.getElementById('brief');
      if (el) el.style.display = 'none';
      document.body.classList.remove('briefing');
    };

    P.campaignBattle = function () {
      return this.campaign ? (CAMPAIGN.battles[this.campaign.battle] || null) : null;
    };

    P.campaignMapIndex = function (b) {
      for (var i = 0; i < G.MAPS.length; i++) if (G.MAPS[i].name === b.map) return i + 1;
      return 0;
    };

    P.playerForce = function () { return this.campaign.force[CAMPAIGN.player]; };

    // ---------------------------------------------------------------------
    // BRIEFING
    // ---------------------------------------------------------------------
    /**
     * THE BRIEFING FOR A MAP YOU JUST PICKED OFF THE LIST.
     *
     * Eighty of the ninety-six shipped maps carry a `brief` — situation,
     * mission, intelligence, the date and place, and a "what happened"
     * paragraph — and it amounts to about fifty-eight thousand characters of
     * written history. NONE OF IT WAS REACHABLE unless you were inside a
     * campaign: `showBriefing` reads `map.brief`, but it is only ever called
     * from the campaign flow, and nineteen of the maps carrying a briefing are
     * in no campaign at all. Picking "Arnhem Bridge" off the dropdown loaded
     * the ground and told you nothing about why you were standing on it.
     *
     * Same card, same styling, campaign furniture hidden: there is no
     * battlegroup to buy, no operation to place this battle in and nothing to
     * abandon. `Begin` just closes it.
     */
    P.showMapBriefing = function (mapIdx) {
      var map = G.MAPS[mapIdx - 1];
      var brief = map && map.brief;
      if (!brief) return false;
      var el = ensureBriefEl(this);
      el.style.display = 'block';
      document.body.classList.add('briefing');
      this._briefSlot = null;
      this._afterAction = false;
      el.classList.add('br-skirmish');          // CSS hides the campaign columns

      el.querySelector('#brTitle').textContent = map.name;
      el.querySelector('#brOp').textContent = brief.op || (map.era || '');
      el.querySelector('#brWhen').textContent = (brief.date || '') + (brief.place ? '  ·  ' + brief.place : '');
      var role = el.querySelector('#brRole');
      role.textContent = ''; role.className = 'br-role';

      var txt = '';
      if (brief.situation) txt += sect('Situation', brief.situation);
      if (brief.mission) txt += sect('Mission', brief.mission);
      if (brief.intel) txt += sect('Intelligence', brief.intel);
      // (round 116) how this battle is won: seven objectives, the score, the map's own mission
      var rule = this.vp116Rule ? this.vp116Rule(map) : '';
      if (rule) txt += sect('Victory', rule);
      txt += sect('Conditions', cap(brief.weather || 'clear') + ' · H-hour '
        + hhmm(brief.hour == null ? 480 : brief.hour) + ' · '
        // (round 116) the clock this battle will actually run (a briefed clock is tripled in a skirmish)
        + (this.vp116 !== false && this.battleDuration > 0 ? Math.round(this.battleDuration / 60) : (brief.clock || 20)) + ' minutes');
      if (brief.history) txt += sect('What happened', brief.history, 'br-hist');
      el.querySelector('#brText').innerHTML = txt;

      var self = this;
      var close = function () {
        el.style.display = 'none';
        el.classList.remove('br-skirmish');
        document.body.classList.remove('briefing');
        self._skirmishBrief = false;
        window.removeEventListener('keydown', onKey, true);
      };
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      window.addEventListener('keydown', onKey, true);
      el.querySelector('#brGo').onclick = close;
      this._skirmishBrief = true;
      return true;
    };

    P.showBriefing = function () {
      var st = this.campaign, b = this.campaignBattle();
      if (!b) { this.showCampaignEnd(); return; }
      var mi = this.campaignMapIndex(b), map = G.MAPS[mi - 1];
      var brief = (map && map.brief) || {};
      var el = ensureBriefEl(this);
      el.style.display = 'block';
      document.body.classList.add('briefing');
      this._briefSlot = null;
      this._afterAction = false;
      // The skirmish briefing shares this card and hides half of it. Clear the
      // class on the way IN as well as on the way out: they are closed by
      // different paths, and a campaign briefing with no battlegroup column is
      // a campaign you cannot buy anything for.
      el.classList.remove('br-skirmish');
      this._skirmishBrief = false;

      el.querySelector('#brTitle').textContent = b.map;
      el.querySelector('#brOp').textContent = 'Operation ' + (brief.op || CAMPAIGN.name)
        + '  ·  Battle ' + (st.battle + 1) + ' of ' + CAMPAIGN.battles.length;
      el.querySelector('#brWhen').textContent = (brief.date || '') + (brief.place ? '  ·  ' + brief.place : '');
      el.querySelector('#brRole').textContent = b.role === 'attack' ? 'YOU ATTACK' : 'YOU DEFEND';
      el.querySelector('#brRole').className = 'br-role ' + b.role;

      var txt = '';
      if (brief.situation) txt += sect('Situation', brief.situation);
      txt += sect('Mission', (b.objective || '') + (brief.mission ? ' ' + brief.mission : ''));
      if (brief.intel) txt += sect('Intelligence', brief.intel);
      var rule116 = this.vp116Rule ? this.vp116Rule(map) : '';   // (round 116)
      if (rule116) txt += sect('Victory', rule116);
      // "up to N squads may take the field" was the deploy cap talking, and
      // the cap is gone: everything you own goes in. What the number MEANS is
      // the frontage this ground held, which is worth telling you and is not
      // worth enforcing.
      txt += sect('Conditions', cap(brief.weather || 'clear') + ' · H-hour '
        + hhmm(brief.hour == null ? 480 : brief.hour) + ' · ' + (brief.clock || 20)
        + ' minutes · the ground here held about ' + b.deployMax + ' formations');
      if (brief.history) txt += sect('What happened', brief.history, 'br-hist');
      el.querySelector('#brText').innerHTML = txt;

      this._drawStrategicMap(el.querySelector('#brStrat'));
      this.drawForceBuilder();

      var self = this;
      el.querySelector('#brGo').onclick = function () { self.beginCampaignBattle(); };
      el.querySelector('#brAuto').onclick = function () {
        var f = self.playerForce();
        autoBuild(f, CAMPAIGN.player, st.battle, b.role, b);
        topUp(st);                    // …and it stays unlimited afterwards
        save(st); self.drawForceBuilder();
      };
      var ub = el.querySelector('#brUnlim');
      ub.onclick = function () {
        st.unlimited = !st.unlimited;
        pendingUnlimited = st.unlimited;      // …and it is what a NEW campaign starts with
        // Turning it OFF has to hand back a real allowance rather than leave
        // six figures in the pool. The battle's own allowance, which is what
        // the player would have had if they had never touched it.
        if (!st.unlimited) {
          var b2 = self.campaignBattle();
          st.force[CAMPAIGN.player].rp = Math.max(0, Math.round(((b2 && b2.rp && b2.rp[CAMPAIGN.player]) || 12)
            * diffOf(st).rp));
        }
        topUp(st); save(st); self.drawForceBuilder();
      };
      el.querySelector('#brClear').onclick = function () { self.addPlatoon(); };
      el.querySelector('#brQuit').onclick = function () {
        if (confirm('Abandon the campaign? The battlegroup and its history are lost.')) self.campaignAbandon();
      };
    };

    P._drawStrategicMap = function (host) {
      var st = this.campaign, h = '';
      for (var i = 0; i < CAMPAIGN.battles.length; i++) {
        var b = CAMPAIGN.battles[i];
        var cls = i < st.battle ? 'done' : i === st.battle ? 'now' : 'todo';
        var res = st.log[i];
        if (res) cls += ' ' + res.result;
        h += '<div class="br-stop ' + cls + '"><i></i><b>' + esc(b.map) + '</b>'
          + '<span>' + (res ? cap(res.result) : (i === st.battle ? 'Current' : '')) + '</span></div>';
      }
      host.innerHTML = h;
    };

    // ---------------------------------------------------------------------
    // THE FORCE BUILDER
    // ---------------------------------------------------------------------
    P.drawForceBuilder = function () {
      var st = this.campaign, b = this.campaignBattle();
      if (!st || !b) return;
      var f = this.playerForce(), team = CAMPAIGN.player, idx = st.battle;
      var host = document.getElementById('brPool');
      if (!host) return;
      var self = this;

      var h = '<div class="fb-head"><span>' + f.platoons.length + ' platoon' + (f.platoons.length === 1 ? '' : 's') + ' · '
        + forceSize(f) + ' squads · ' + forceMen(f) + ' men</span>'
        + '<b>' + rpText(st, f) + ' RP</b></div>';
      // The order of battle by arm. A commander does not think "nineteen
      // squads", he thinks "four rifle platoons, two MG, one mortar, no armour"
      // — and the gap in that sentence is the thing he does something about.
      var ac = armCount(f), armH = '';
      for (var ai = 0; ai < ARM_ORDER.length; ai++) {
        var an = ARM_ORDER[ai];
        if (!ac[an]) continue;
        armH += '<i title="' + ARM_NAME[an] + '">' + ARM_GLYPH[an] + '<b>' + ac[an] + '</b></i>';
      }
      if (!armH) armH = '<i class="none">nothing requisitioned yet</i>';
      h += '<div class="fb-arms">' + armH + '</div>';
      if (this._briefMove && f.squads[this._briefMove]) {
        h += '<div class="fb-moving">Moving <b>' + esc(f.squads[this._briefMove].name)
          + '</b> \u2014 click an empty slot to place it, or <i data-act="cancelmove">cancel</i></div>';
      }

      for (var p = 0; p < f.platoons.length; p++) {
        var pl = f.platoons[p];
        h += '<div class="fb-pl"><b>' + esc(pl.name) + '</b>'
          + '<span class="fb-tools">'
          + (pl.slots.length < MAX_SLOTS ? '<i data-act="addslot" data-p="' + p + '" title="Add a slot to this platoon">+ slot</i>' : '')
          + '<i data-act="delpl" data-p="' + p + '" title="Disband this platoon">remove</i>'
          + '</span></div>';
        for (var i = 0; i < pl.slots.length; i++) {
          var uid = pl.slots[i];
          var sel = this._briefSlot && this._briefSlot.p === p && this._briefSlot.i === i;
          if (uid == null) {
            var moving = !!this._briefMove;
            h += '<div class="fb-slot empty' + (sel ? ' sel' : '') + (moving ? ' drop' : '')
              + '" data-act="pick" data-p="' + p + '" data-i="' + i + '">'
              + '<b>' + (moving ? '\u2193 place here' : '\u2014 empty slot \u2014') + '</b>'
              + '<span class="fb-hint">' + (moving ? 'or pick a different slot' : 'click, then choose a squad from the list below') + '</span></div>';
            continue;
          }
          var sq = f.squads[uid], t = T()[sq.tmpl] || { men: [], rp: 0, name: sq.tmpl, note: '', cat: 'rifle' };
          var full = t.men.length, now = sq.men.length;
          var rc = replaceCost(sq);
          var vetName = ['Green', 'Regular', 'Veteran'][Math.max(0, Math.min(2, sq.vet))];
          var cat = t.cat || 'rifle';
          var lifted = this._briefMove === uid;
          // ONE ROW, AND YOU DO NOT HAVE TO READ IT TO USE IT. Arm glyph,
          // name, a man per soldier with the gaps showing, strength, what the
          // squad has been through, and what you can do about it.
          h += '<div class="fb-slot' + (now < full ? ' hurt' : '') + (lifted ? ' lifted' : '') + '" data-uid="' + uid + '"'
            + ' title="' + esc(t.name + ' \u2014 ' + (t.note || '')) + '">'
            + '<span class="fb-arm" title="' + (ARM_NAME[cat] || cat) + '">' + (ARM_GLYPH[cat] || '\u25AE') + '</span>'
            + '<b>' + esc(sq.name) + '</b>'
            + '<span class="fb-pips' + (now === 0 ? ' gone' : now < full ? ' part' : '') + '">' + pips(now, full) + '</span>'
            + '<span class="fb-str">' + now + '/' + full + '</span>'
            + '<span class="fb-vet v' + sq.vet + '" title="' + vetNote(sq) + '">' + vetName + '</span>'
            + '<span class="fb-note">' + esc(record(sq)) + '</span>'
            + '<span class="fb-acts">'
            + (rc > 0 ? '<i data-act="replace" data-uid="' + uid + '" class="' + (f.rp >= rc ? '' : 'off') + '" title="Bring it back to establishment">+' + rc + '</i>' : '')
            + '<i data-act="lift" data-uid="' + uid + '" title="Move this squad to another slot">\u21c5</i>'
            + '<i data-act="disband" data-uid="' + uid + '" title="Disband \u2014 no refund">\u00d7</i>'
            + '</span></div>';
        }
      }
      if (f.platoons.length < MAX_PLATOONS) {
        h += '<div class="fb-add" data-act="addpl">+ add platoon (' + (f.platoons.length + 1) + ' of ' + MAX_PLATOONS + ')</div>';
      }

      // ---- the requisition list -------------------------------------------
      h += '<div class="br-sep">Requisition' + (this._briefSlot ? ' — into the highlighted slot' : ' — pick an empty slot first') + '</div>';
      var avail = availableAt(team, idx, st), later = [];
      var tt = T();
      // …and with unlimited requisition there is no "not yet available":
      // everything is in the list above, so this stays empty.
      if (!unlimited(st)) for (var k in tt) {
        var t2 = tt[k];
        if (!nationOK(t2, team)) continue;
        if (fromOf(t2) > idx) later.push(t2);
      }
      // GROUPED BY ARM, the way an order of battle is written. A flat list
      // sorted by price makes you hunt for the mortar; a list with headings
      // makes the SHAPE of what you can buy visible, and the gaps in it.
      var buckets = {};
      for (i = 0; i < avail.length; i++) {
        var ab = avail[i], cb = ab.cat || 'rifle';
        (buckets[cb] || (buckets[cb] = [])).push(ab);
      }
      for (var bi = 0; bi < ARM_ORDER.length; bi++) {
        var bc = ARM_ORDER[bi], pool = buckets[bc];
        if (!pool || !pool.length) continue;
        var haveN = 0;
        for (var hk in f.squads) { var ht = T()[f.squads[hk].tmpl]; if (ht && (ht.cat || 'rifle') === bc) haveN++; }
        h += '<div class="rq-cat">' + ARM_GLYPH[bc] + ' ' + ARM_NAME[bc]
          + '<span>' + (haveN ? haveN + ' in the battlegroup' : 'none yet') + '</span></div>';
        for (i = 0; i < pool.length; i++) {
          var a = pool[i];
          var lim = capOf(a.id, st, team);
          var have = countTmpl(f, a.id);
          var capped = have >= lim;
          var can = !!this._briefSlot && (unlimited(st) || f.rp >= a.rp) && !capped;
          // WHAT IS ACTUALLY IN IT. "9 men" tells you nothing; a Thompson, a
          // BAR and seven Garands tells you what the squad is for, and it is
          // the difference between a rifle squad and an assault squad at the
          // moment you are choosing between them.
          var comp = {}, mi2;
          for (mi2 = 0; mi2 < a.men.length; mi2++) {
            var dn = (G.UNIT_DEFS[a.men[mi2]] || { name: a.men[mi2] }).name;
            comp[dn] = (comp[dn] || 0) + 1;
          }
          var parts = [];
          for (var cn in comp) parts.push((comp[cn] > 1 ? comp[cn] + '\u00d7 ' : '') + cn);
          var why = capped ? 'establishment: ' + lim + ' at most'
            : (!this._briefSlot ? 'pick an empty slot first'
            : (!st.unlimited && f.rp < a.rp ? 'needs ' + (a.rp - f.rp) + ' more RP' : ''));
          h += '<div class="rq-row' + (can ? '' : ' off') + '" data-act="buy" data-t="' + a.id + '"'
            + ' title="' + esc(parts.join(', ') + ((why || a.note) ? ' \u2014 ' + (why || a.note) : '')) + '">'
            + '<b>' + esc(a.name) + (have ? ' <u>\u00d7' + have + '</u>' : '') + '</b>'
            + '<span class="rq-rp">' + a.rp + '</span>'
            + '<span class="rq-men">' + pips(a.men.length, a.men.length) + '</span>'
            + '<span class="rq-note">' + esc(why || a.note || '') + '</span></div>';
        }
      }
      // ---- the guns behind the hill ---------------------------------------
      // Off-map support is bought by the MISSION, not by the battery, and it
      // does not carry over: what you do not fire today, you do not have
      // tomorrow. That is the trade — a 155 mission costs as much as a rifle
      // squad you would still own in September.
      var FS = window.FIRE_SUPPORT_TABLE || null;
      if (FS) {
        var nat = fireNation(team);
        f.support = f.support || {};
        h += '<div class="br-sep">Fire support — bought by the mission, and it does not keep</div>';
        for (var fk in FS) {
          var fd = FS[fk];
          if (fd.nation !== 'both' && fd.nation !== nat) continue;
          var have = f.support[fk] || 0;
          var afford = unlimited(st) || f.rp >= fd.rp;
          h += '<div class="rq-row' + (afford ? '' : ' off') + '" data-act="buyfire" data-t="' + fk + '" title="' + esc(fd.note || '') + '">'
            + '<b>' + fd.ic + '  ' + esc(fd.name) + (have ? '  ×' + have : '') + '</b>'
            + '<span class="rq-rp">' + fd.rp + '</span>'
            + '<span class="rq-men">' + fd.delay + 's</span>'
            + '<span class="rq-note">' + esc(fd.note || '') + '</span></div>';
        }
        var anyFire = false;
        for (var fk2 in f.support) if (f.support[fk2] > 0) anyFire = true;
        if (anyFire) {
          h += '<div class="rq-row" data-act="clearfire"><b>↺ Refund all fire missions</b>'
            + '<span class="rq-rp"></span><span class="rq-men"></span>'
            + '<span class="rq-note">Put the points back and spend them on men instead</span></div>';
        }
      }
      later.sort(function (x, y) { return fromOf(x) - fromOf(y); });
      if (later.length) {
        h += '<div class="br-sep">Not yet available</div>';
        for (i = 0; i < later.length; i++) {
          h += '<div class="rq-row off" title="' + esc(later[i].note || '') + '"><b>' + esc(later[i].name) + '</b>'
            + '<span class="rq-rp">' + later[i].rp + '</span>'
            + '<span class="rq-men">battle ' + (fromOf(later[i]) + 1) + '</span>'
            + '<span class="rq-note">' + esc(later[i].note || '') + '</span></div>';
        }
      }
      host.innerHTML = h;

      // NOTHING STAYS IN RESERVE ANY MORE. This line used to warn you that
      // squads you had bought and were paying to keep would not be coming, and
      // it was the only place the game admitted it. `deployMax` is now what it
      // reads as: the frontage the ground held historically. Going over it is
      // allowed, it is sometimes right, and it is your call — so it is stated
      // rather than enforced.
      var sz = forceSize(f), over = sz - b.deployMax;
      // What a victory here is worth, on the screen where you decide what to
      // spend — because the whole point of the award is that it changes what
      // you can afford to risk, and an economy the player cannot see is not a
      // decision. `st.battle` is this battle; the allowance is its own.
      var D = diffOf(st);
      var abase = (b.rp && b.rp[CAMPAIGN.player]) || 10;
      var winRp = rpAward(abase, true, false, D, true), loseRp = rpAward(abase, false, false, D, true);
      var line = st.unlimited
        ? 'Unlimited requisition \u2014 nothing costs anything, nothing is capped, everything is available  ·  '
          + 'the enemy is still buying out of ' + st.force[CAMPAIGN.player === 1 ? 2 : 1].rp + ' RP'
        : f.rp + ' RP in hand  ·  every squad deploys  ·  ' + D.name
          + ': taking this pays ' + winRp + ' RP, failing it ' + loseRp;
      if (over > 0) line += '  ·  ' + sz + ' formations on ground that held about ' + b.deployMax
        + ' — it will be crowded';
      document.getElementById('brSpend').textContent = line;
      document.getElementById('brSpend').className = 'br-spend' + (over > 0 ? ' wide' : '');
      document.getElementById('brUnits').textContent = sz + ' squads · ' + forceMen(f) + ' men';
      document.getElementById('brBar').style.width = Math.min(100, sz / b.deployMax * 100) + '%';
      document.getElementById('brBar').className = over > 0 ? 'over' : '';
      document.getElementById('brGo').disabled = sz === 0;
      // The toggle REFLECTS state, so it is redrawn here with everything else
      // and not where it was wired — `showBriefing` runs once and this runs
      // after every action, which is how often the thing it shows can change.
      var ub2 = document.getElementById('brUnlim');
      if (ub2) {
        ub2.textContent = (st.unlimited ? '\u2611' : '\u2610') + ' Unlimited requisition';
        ub2.className = 'br-b ghost' + (st.unlimited ? ' on' : '');
        ub2.title = st.unlimited
          ? 'On: ' + UNLIMITED_RP + ' points, no scarcity caps, no availability dates. Click for the campaign economy back.'
          : 'Off: you fight the next battle with what this one leaves you. Click for ' + UNLIMITED_RP
            + ' points, nothing capped, and the whole catalogue from battle one.';
      }

      if (!host._wired) {
        host._wired = true;
        host.addEventListener('mousedown', function (ev) {
          var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
          if (!el || el.classList.contains('off')) return;
          ev.stopPropagation();
          self.forceAction(el.dataset.act, el.dataset);
        });
      }
    };

    /** One entry point for every button in the force builder. */
    P.forceAction = function (act, d) {
      var st = this.campaign, f = this.playerForce();
      if (act === 'pick') {
        // A slot click means two different things depending on whether you are
        // carrying a squad. Picking a squad up and putting it down is how you
        // rearrange a battlegroup, and until now the only way to move one was
        // to disband it and buy it again at full price.
        if (this._briefMove) {
          var mv = f.squads[this._briefMove];
          var tp = +d.p, ti = +d.i;
          if (mv && f.platoons[tp] && f.platoons[tp].slots[ti] == null) {
            for (var mp = 0; mp < f.platoons.length; mp++) {
              var msl = f.platoons[mp].slots;
              for (var msi = 0; msi < msl.length; msi++) if (msl[msi] === mv.uid) msl[msi] = null;
            }
            f.platoons[tp].slots[ti] = mv.uid;
          }
          this._briefMove = null;
          this._briefSlot = null;
        } else this._briefSlot = { p: +d.p, i: +d.i };
      } else if (act === 'lift') {
        this._briefMove = (this._briefMove === d.uid) ? null : d.uid;
        this._briefSlot = null;
      } else if (act === 'cancelmove') {
        this._briefMove = null;
      } else if (act === 'buy') {
        if (!this._briefSlot) return;
        var t = T()[d.t];
        if (!t || (!unlimited(st) && f.rp < t.rp)) return;
        // THE HANDLER NEVER CHECKED AVAILABILITY. The requisition list only
        // renders a `buy` row for what is unlocked, so in ordinary play it
        // never came up — but the rule lived in the VIEW and not in the
        // action, which means it was one stale re-render or one scripted click
        // away from putting an IS-2 into a 1941 battlegroup. It is the same
        // shape as every "wired but wrong" finding: a check that is true by
        // accident rather than by construction.
        if (!unlimited(st) && fromOf(t) > st.battle) return;
        if (countTmpl(f, t.id) >= capOf(t.id, st, CAMPAIGN.player)) return;
        if (addSquad(f, t.id, this._briefSlot.p, this._briefSlot.i) == null) return;
        f.rp -= t.rp;
        this._briefSlot = null;
      } else if (act === 'buyfire') {
        var FSt = window.FIRE_SUPPORT_TABLE || {};
        var fd2 = FSt[d.t];
        if (!fd2 || (!unlimited(st) && f.rp < fd2.rp)) return;
        f.support = f.support || {};
        f.support[d.t] = (f.support[d.t] || 0) + 1;
        f.rp -= fd2.rp;
      } else if (act === 'clearfire') {
        var FSt2 = window.FIRE_SUPPORT_TABLE || {};
        f.support = f.support || {};
        for (var ck in f.support) {
          if (FSt2[ck]) f.rp += FSt2[ck].rp * f.support[ck];
        }
        f.support = {};
      } else if (act === 'replace') {
        var sq = f.squads[d.uid];
        if (!sq) return;
        var c = replaceCost(sq);
        if (c <= 0 || (!unlimited(st) && f.rp < c)) return;
        refill(sq); f.rp -= c;
      } else if (act === 'disband') {
        if (this._briefMove === d.uid) this._briefMove = null;
        removeSquad(f, d.uid);
      } else if (act === 'addpl') {
        if (f.platoons.length >= MAX_PLATOONS) return;
        var sl = [];
        for (var i = 0; i < BASE_SLOTS; i++) sl.push(null);
        f.platoons.push({ name: ORD[f.platoons.length] + ' Platoon', slots: sl });
      } else if (act === 'addslot') {
        var pl = f.platoons[+d.p];
        if (pl && pl.slots.length < MAX_SLOTS) pl.slots.push(null);
      } else if (act === 'delpl') {
        var p2 = +d.p, dead = f.platoons[p2];
        if (!dead) return;
        for (i = 0; i < dead.slots.length; i++) if (dead.slots[i] != null) delete f.squads[dead.slots[i]];
        f.platoons.splice(p2, 1);
        this._briefSlot = null;
      }
      topUp(st);          // a pool that cannot run out, put back after the spend
      save(st);
      this.drawForceBuilder();
    };

    P.addPlatoon = function () { this.forceAction('addpl', {}); };
  }

  function patchBattle(Game) {
    var P = Game.prototype;

    // ---------------------------------------------------------------------
    // THE BATTLE
    // ---------------------------------------------------------------------
    P.beginCampaignBattle = function () {
      var st = this.campaign, b = this.campaignBattle();
      var team = CAMPAIGN.player, foe = team === 1 ? 2 : 1;
      // The enemy spends its own points on its own battlegroup, by the same
      // rules and out of the same persistent force — so a company you mauled
      // at Hill 192 is short of men at Saint-Lô.
      autoBuild(st.force[foe], foe, st.battle, b.role === 'attack' ? 'defend' : 'attack', b);

      this._deployList = { 1: pickForBattle(st.force[1]), 2: pickForBattle(st.force[2]) };

      var el = document.getElementById('brief');
      if (el) el.style.display = 'none';
      document.body.classList.remove('briefing');

      var mi = this.campaignMapIndex(b), map = G.MAPS[mi - 1];
      var brief = (map && map.brief) || {};
      // WHOSE ARMY IS THIS. The Westheer campaign is played as team 2, and
      // everything that reads `playerTeam` — fog of war, the roster, the order
      // palette, which commander the doctrine layer leaves alone — follows from
      // this one assignment.
      this.playerTeam = CAMPAIGN.player;
      var self = this;
      this.campaignDeploy = function (m, ctx) { self._deploySquads(m, ctx); };
      this.loadMap(mi);
      this.campaignDeploy = null;

      if (brief.weather && this.setWeather) this.setWeather(brief.weather);
      if (brief.hour != null && this.setTimeOfDay) this.setTimeOfDay(brief.hour / 60);
      this.battleDuration = (brief.clock || 20) * 60;
      this.battleClock = 0;
      this._campaignLive = true;
      document.body.classList.add('campaign-battle');
      this.setMode('play');
      this._showCampaignPill(b);

      // The guns you bought. Both sides get theirs; the enemy's allocation is
      // built by the same doctrine that builds its battlegroup, so a defensive
      // battle answers your attack with registered mortar fire the way a real
      // one would.
      this.support = { 1: {}, 2: {} };
      for (var tm = 1; tm <= 2; tm++) {
        var sup = (st.force[tm] && st.force[tm].support) || {};
        for (var sk in sup) if (sup[sk] > 0) this.grantSupport(tm, sk, sup[sk], true);
      }
      // Spent: what you did not call, you do not keep.
      if (st.force[CAMPAIGN.player]) st.force[CAMPAIGN.player].support = {};

      // DEPLOYMENT. Before anything moves, the ground in front of your start
      // line is yours to arrange: put the machine guns where they can see, the
      // anti-tank gun where the road comes round the hedge, and dig.
      var self2 = this;
      setTimeout(function () {
        if (!self2._campaignLive) return;
        self2.beginDeployment(CAMPAIGN.player, null, {
          title: b.map + ' — deployment',
          sub: (b.role === 'attack'
            ? 'Form your start line. Lead sections forward, support weapons where they can see the objective.'
            : 'Site the position. Guns on the approaches, everyone else in a hole — you will not get another chance.')
            + '  Right-click inside the shaded ground to place. Enter begins.',
        });
      }, 60);
      if (this.ui) this.ui.toast(b.map + ' — ' + (b.role === 'attack' ? 'attack' : 'hold'));
    };

    /** Put the battlegroup on the ground.
     *
     *  The MAP owns the start lines: its own `deploy()` is run with a recording
     *  stub to harvest the anchors it would have used, and the campaign's
     *  platoons are dealt across them. Each squad arrives at the strength it
     *  came off the last battlefield with — `sq.men`, not the establishment. */
    P._deploySquads = function (map, ctx) {
      var zones = { 1: [], 2: [] };
      try {
        map.deploy({
          gx: ctx.gx,
          deploy: function (cx, cz, team, list) {
            (zones[team] || (zones[team] = [])).push({ cx: cx, cz: cz, w: list.length });
          },
        });
      } catch (e) { /* fall through to the defaults below */ }

      for (var team = 1; team <= 2; team++) {
        var zs = zones[team];
        if (!zs || !zs.length) zs = [{ cx: ctx.gx(0.5), cz: ctx.gx(team === 1 ? 0.85 : 0.15), w: 1 }];
        var plan = (this._deployList && this._deployList[team]) || [];
        var f = this.campaign.force[team];
        // A platoon lands together. Zones are dealt platoon by platoon so the
        // shape you built in the requisition screen is the shape that arrives.
        var byPl = {};
        for (var i = 0; i < plan.length; i++) {
          var key = plan[i].p;
          (byPl[key] || (byPl[key] = [])).push(plan[i]);
        }
        // A BATTLEGROUP CAN BE BIGGER THAN THE MAP'S START LINES. The zones
        // are dealt round-robin, so with more platoons than zones the fourth
        // platoon lands on the first one's ground. It used to be capped before
        // it got here; now that everything deploys, each time the deal wraps
        // the whole platoon is stepped sideways by a frontage so the second
        // wave forms up BESIDE the first rather than inside it.
        var pk = Object.keys(byPl), zi = 0;
        for (var q = 0; q < pk.length; q++) {
          var group = byPl[pk[q]];
          var zone = zs[zi % zs.length];
          var wrap = Math.floor(zi / zs.length);          // 0 for the first pass round
          zi++;
          var lane = wrap === 0 ? 0 : (wrap % 2 ? 1 : -1) * Math.ceil(wrap / 2) * 22;
          var back = wrap * 9;                            // …and a little further back each time
          for (var k = 0; k < group.length; k++) {
            var rec = group[k], sq = f.squads[rec.uid];
            if (!sq || !sq.men.length) continue;
            var jitter = (k % 3) * 7 - 7 + lane;
            var live = this.spawnSquad(sq.tmpl, team, zone.cx + jitter, zone.cz + (k % 2 ? 6 : -6) + (team === 1 ? back : -back), {
              men: sq.men.slice(), vet: sq.vet, name: sq.name, uid: sq.uid,
              platoon: rec.p, platoonName: f.platoons[rec.p] ? f.platoons[rec.p].name : null,
              initial: (T()[sq.tmpl] || { men: sq.men }).men.length,
            });
            if (live) live.campaignUid = sq.uid;
          }
        }
      }
    };

    // ---------------------------------------------------------------------
    // AFTER ACTION
    // ---------------------------------------------------------------------
    P.campaignResult = function (kind) {
      if (!this._campaignLive) return;
      this._campaignLive = false;
      document.body.classList.remove('campaign-battle');
      var pill = document.getElementById('cmPill');
      if (pill) pill.style.display = 'none';

      var st = this.campaign, team = CAMPAIGN.player, foe = team === 1 ? 2 : 1;
      var result = kind === 'win' ? 'won' : kind === 'lose' ? 'lost' : 'drawn';

      // Casualties come from the squads that were on the field: what each one
      // still has standing becomes its roster. Never counted off corpses — a
      // dead man is disposed once his body fades and is not in `game.units` by
      // the time the banner shows.
      var lost = { 1: 0, 2: 0 }, lostBy = { 1: {}, 2: {} };
      var earned = 0, earnedBase = 0, earnedBag = 0;
      // MEN TAKEN ARE NOT MEN KILLED, and the campaign could not tell the
      // difference. A prisoner leaves his squad the way a dead man does, so he
      // already falls out of `survivors` below and is counted in `lost` — which
      // is right, he is not coming back — but the campaign then reported eight
      // men shot to pieces when six of them walked to the rear with their hands
      // up. That is the wrong sentence about the battle, and it is usually the
      // sentence the player's own manoeuvre wrote.
      //
      // `prisonersBy[t]` is how many team `t` TOOK, so what a team LOST to the
      // bag is the other side's entry. Read it here: the counters live on the
      // Game and are emptied by the next map load, which happens after this.
      var PB = this.prisonersBy || {};
      var bagTook = { 1: PB[1] || 0, 2: PB[2] || 0 };
      var bagLost = { 1: bagTook[2], 2: bagTook[1] };
      var live = {};
      for (var i = 0; i < this.squads.length; i++) {
        var sq = this.squads[i];
        if (!sq.campaignUid) continue;
        live[sq.campaignUid] = sq;
      }
      for (var tm = 1; tm <= 2; tm++) {
        var plan = (this._deployList && this._deployList[tm]) || [];
        var f = st.force[tm];
        for (var j = 0; j < plan.length; j++) {
          var rec = plan[j], s = f.squads[rec.uid];
          if (!s) continue;
          s.battles++;
          var onField = live[rec.uid];
          var survivors = [];
          if (onField) {
            var m = onField.effectives();
            for (var k = 0; k < m.length; k++) survivors.push(m[k].type);
            s.kills += onField.members.reduce(function (a, u) { return a + (u.kills || 0); }, 0);
          }
          var before = s.men.length;
          s.men = survivors;
          lost[tm] += Math.max(0, before - survivors.length);
          if (before > survivors.length) lostBy[tm][s.tmpl] = (lostBy[tm][s.tmpl] || 0) + (before - survivors.length);
          // A squad that keeps taking casualties and keeps coming back is a
          // squad that has learnt something.
          if (survivors.length && s.battles >= 2 && s.vet < 2 && result !== 'lost') s.vet = Math.min(2, s.vet + (Math.random() < 0.3 ? 1 : 0));
          if (!s.men.length) removeSquad(f, s.uid);          // wiped out
        }
        // REQUISITION FOR THE NEXT BATTLE, and what this one was worth.
        // `result` is from the PLAYER's point of view, so the enemy's victory
        // is the player's defeat and the award has to be read the other way up.
        var D = diffOf(st), mineTm = tm === team;
        var base = (CAMPAIGN.battles[st.battle] && CAMPAIGN.battles[st.battle].rp[tm]) || 10;
        var wonTm = mineTm ? result === 'won' : result === 'lost';
        var gained = rpAward(base, wonTm, result === 'drawn', D, mineTm);
        // AND THIS IS WHERE ENCIRCLEMENT IS PAID FOR. A surrender is the only
        // thing in the game that converts a manoeuvre directly into an enemy
        // squad ceasing to exist without a shot, and until now it bought the
        // player nothing the same men shot in the open would not have. One
        // point a head, on the same difficulty multiplier as everything else,
        // capped at half the battle's allowance so that a company bagged whole
        // is a very good day and not a different game. Measured on the shipped
        // maps it fires rarely and small: Vierville Draw four prisoners on a
        // base of fourteen, Bocage none, Seelow none.
        var bagRp = Math.min(Math.round(bagTook[tm] * (mineTm ? D.rp : D.foeRp)), Math.round(base * 0.5));
        gained += bagRp;
        f.rp += gained;
        if (mineTm) {
          earned = gained; earnedBag = bagRp;
          earnedBase = Math.round(base * (wonTm ? 1 : result === 'drawn' ? 0.75 : 0.5) * D.rp);
        }
      }

      st.log[st.battle] = { map: (this.campaignBattle() || {}).map, result: result,
                            lost: lost[team], killed: lost[foe], rp: earned, rpBase: earnedBase,
                            taken: bagTook[team], bagged: bagLost[team], rpBag: earnedBag };
      if (result !== 'lost') st.battle++;
      save(st);
      this.showAfterAction(result, lostBy[team], lostBy[foe]);
    };

    P.showAfterAction = function (result, mine, theirs) {
      var st = this.campaign;
      var el = ensureBriefEl(this);
      el.style.display = 'block';
      document.body.classList.add('briefing');
      this._afterAction = true;
      var prev = st.log[Math.max(0, st.battle - (result === 'lost' ? 0 : 1))] || {};
      el.querySelector('#brTitle').textContent = result === 'won' ? 'Objective taken'
        : result === 'lost' ? 'The attack failed' : 'Neither side broke';
      el.querySelector('#brOp').textContent = 'After action  ·  ' + (prev.map || '');
      el.querySelector('#brWhen').textContent = '';
      el.querySelector('#brRole').textContent = result.toUpperCase();
      el.querySelector('#brRole').className = 'br-role ' + (result === 'won' ? 'attack' : 'defend');

      var f = this.playerForce();
      // The bag is reported as a CLAUSE inside the casualty sentence, not as a
      // line of its own — men taken are part of what a battle cost or won, not
      // a separate statistic — and it disappears entirely when nobody
      // surrendered, which on the shipped maps is most battles.
      // "The enemy lost 5, and 5 of those are your prisoners" is the sentence a
      // counter writes, not a person. When every loss on a side went into the
      // bag — which is what a clean encirclement looks like, and the one case
      // most worth reading well — say ALL of them.
      var yourBag = prev.bagged || 0, theirBag = prev.taken || 0;
      var mineTxt = yourBag >= (prev.lost || 0) ? ', all of them into the bag'
                  : yourBag ? ', ' + yourBag + ' of them into the bag' : '';
      var theirTxt = theirBag >= (prev.killed || 0) ? ', all of them your prisoners'
                   : theirBag ? ', and ' + theirBag + ' of those are your prisoners' : '';
      var txt = sect('Casualties', 'You lost ' + (prev.lost || 0) + ' men' + (yourBag ? mineTxt : '')
        + '. The enemy lost ' + (prev.killed || 0) + (theirBag ? theirTxt : '') + '.');
      txt += '<div class="br-lists"><div><h4>Your losses</h4>' + lossList(mine) + '</div>'
        + '<div><h4>Enemy losses</h4>' + lossList(theirs) + '</div></div>';
      var D = diffOf(st);
      // The prisoner award comes OUT of this before the rest is attributed to
      // taking the objective, or the objective silently takes credit for the
      // bag and two separate rewards become one number nobody can read.
      var bonus = Math.max(0, (prev.rp || 0) - (prev.rpBase || 0) - (prev.rpBag || 0));
      var gainTxt = 'The allowance for this battle was ' + (prev.rpBase || 0) + ' points'
        + (bonus > 0 ? ', and taking the objective was worth ' + bonus + ' more' : '')
        + (result === 'lost' ? ' — half, because the attack failed' : '')
        + (result === 'drawn' ? ' — three quarters, because neither side broke' : '')
        + (prev.rpBag ? '. The ' + theirBag + ' men you took are worth ' + prev.rpBag + ' more — cutting a'
                      + ' section off and making it fold is the cheapest ground you will ever take' : '')
        + '. You have ' + f.rp + '. Depleted squads can be brought back to strength in the next'
        + ' briefing, or left short and spent on something new — that is the decision the campaign'
        + ' is made of.';
      txt += sect('Requisition  ·  ' + D.name, gainTxt);
      el.querySelector('#brText').innerHTML = txt;
      this._drawStrategicMap(el.querySelector('#brStrat'));
      this.drawForceBuilder();

      var self = this, go = el.querySelector('#brGo');
      go.disabled = false;
      go.textContent = st.battle >= CAMPAIGN.battles.length ? 'End of campaign' : 'Next briefing →';
      go.onclick = function () {
        go.textContent = 'Begin battle →';
        if (st.battle >= CAMPAIGN.battles.length) self.showCampaignEnd(); else self.showBriefing();
      };
    };

    P.showCampaignEnd = function () {
      var st = this.campaign;
      var won = st.log.filter(function (l) { return l && l.result === 'won'; }).length;
      var el = ensureBriefEl(this);
      el.style.display = 'block';
      document.body.classList.add('briefing');
      el.querySelector('#brTitle').textContent = 'Normandy';
      el.querySelector('#brOp').textContent = 'Campaign complete';
      el.querySelector('#brWhen').textContent = '6 June – 7 August 1944';
      el.querySelector('#brRole').textContent = won + ' / ' + CAMPAIGN.battles.length;
      el.querySelector('#brRole').className = 'br-role attack';
      el.querySelector('#brText').innerHTML = sect('The operation',
        'Ten battles, ' + won + ' of them carried. The Falaise pocket closed on 21 August and the German army in the west lost roughly four hundred thousand men in Normandy.')
        + sect('Your battlegroup', 'What is left of it is on the right. It is the argument for husbanding a company rather than spending it.');
      this._drawStrategicMap(el.querySelector('#brStrat'));
      this.drawForceBuilder();
      var self = this, go = el.querySelector('#brGo');
      go.disabled = false; go.textContent = 'New campaign';
      go.onclick = function () {
        var was = self.campaign;
        self.campaign = freshState((was && was.diff) || pendingDiff,
                                   was ? was.unlimited : pendingUnlimited);
        save(self.campaign); go.textContent = 'Begin battle →'; self.showBriefing();
      };
    };

    P._showCampaignPill = function (b) {
      var el = document.getElementById('cmPill');
      if (!el) { el = document.createElement('div'); el.id = 'cmPill'; document.body.appendChild(el); }
      var st = this.campaign;
      el.innerHTML = '<b>' + esc(b.map) + '</b><i>' + (b.role === 'attack' ? 'ATTACK' : 'HOLD') + '</i>'
        + '<span>' + esc(b.objective || '') + '</span>'
        + '<u>' + (st.battle + 1) + '/' + CAMPAIGN.battles.length + '</u>';
      el.style.display = 'flex';
    };

    // Catch the end of a campaign battle wherever it is declared.
    var UIproto = G.UI && G.UI.prototype;
    if (UIproto && !UIproto._campaignPatched) {
      UIproto._campaignPatched = true;
      var baseBanner = UIproto.showBanner;
      UIproto.showBanner = function (kind, msg) {
        var r = baseBanner.call(this, kind, msg);
        var g = this.game;
        if (g && g._campaignLive && g.campaignResult) setTimeout(function () { g.campaignResult(kind); }, 1400);
        return r;
      };
    }
  }

  /** Which squads take the field, when the force is bigger than the map's cap.
   *  Whole platoons first, in order — a battlegroup arrives organised. */
  /** EVERYTHING YOU BOUGHT TURNS UP.
   *
   *  This used to stop at `battle.deployMax` — ten to eighteen squads — and it
   *  took them in ARRAY ORDER, so a battlegroup of nine platoons put its first
   *  three on the field and left the rest in a car park with no say from the
   *  player about which. You spent the points; the squad exists; it is on the
   *  roster between battles and it takes casualties. It should be there.
   *
   *  `deployMax` survives in the battle data as what it always should have
   *  been: the FRONTAGE the ground historically held, shown in the requisition
   *  screen so you know when you are packing a company onto a hedgerow that
   *  took a platoon. It no longer decides anything. */
  function pickForBattle(f) {
    var out = [];
    for (var p = 0; p < f.platoons.length; p++) {
      var sl = f.platoons[p].slots;
      for (var i = 0; i < sl.length; i++) {
        var uid = sl[i];
        if (uid != null && f.squads[uid] && f.squads[uid].men.length) out.push({ uid: uid, p: p, i: i });
      }
    }
    return out;
  }

  // =========================================================================
  // DOM
  // =========================================================================
  var ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

  function ensureBriefEl(game) {
    var el = document.getElementById('brief');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'brief';
    el.innerHTML = [
      '<div class="br-card">',
      '  <div class="br-head">',
      '    <div><div id="brOp" class="br-op"></div><h1 id="brTitle"></h1><div id="brWhen" class="br-when"></div></div>',
      '    <div id="brRole" class="br-role"></div>',
      '  </div>',
      '  <div class="br-body">',
      '    <div class="br-left"><div id="brText"></div><div class="br-stratwrap"><h4>The operation</h4><div id="brStrat" class="br-strat"></div></div></div>',
      '    <div class="br-right">',
      '      <div class="br-poolhead"><h4>Battlegroup</h4><span id="brUnits"></span></div>',
      '      <div class="br-budget"><div id="brBar"></div></div><div id="brSpend" class="br-spend"></div>',
      '      <div id="brPool" class="br-pool"></div>',
      '    </div>',
      '  </div>',
      '  <div class="br-foot">',
      '    <button id="brQuit" class="br-b ghost">Abandon campaign</button>',
      '    <span class="br-gap"></span>',
      // THE SETTING HAS TO BE REACHABLE FROM INSIDE A CAMPAIGN. It began as a
      // picker-only choice, and the picker does not open once an operation is
      // in progress — `btnCampaign` goes straight to the briefing — so a
      // player who had already started could not turn it on at all, and one
      // who had turned it on could not turn it off. It is a decision about how
      // you want to spend an afternoon, not a difficulty you commit to in
      // advance, so it belongs on the screen where you spend the points.
      '    <button id="brUnlim" class="br-b ghost"></button>',
      '    <button id="brClear" class="br-b ghost">+ Platoon</button>',
      '    <button id="brAuto" class="br-b">Requisition to doctrine</button>',
      '    <button id="brGo" class="br-b go">Begin battle →</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(el);
    return el;
  }

  function addTopBarButton(game) {
    var bar = document.getElementById('topBar');
    if (!bar || document.getElementById('btnCampaign')) return;
    var b = document.createElement('button');
    b.id = 'btnCampaign'; b.className = 'btn'; b.textContent = '⚑ Campaign';
    b.title = 'Seven operations — Normandy and the Westheer, Market Garden, the Eastern Front '
            + 'from either side, North Africa into Italy, and France 1940';
    b.onclick = function () {
      if (game.campaign) { game.showBriefing(); return; }
      showCampaignPicker(game);
    };
    bar.insertBefore(b, document.getElementById('btnReset') || null);
  }

  /** WHICH WAR. Seven operations across five theatres and six years, each with
   *  its own save; the picker shows which of them has a game in progress and
   *  where it has got to, because a saved campaign is a battlegroup with names
   *  and casualties in it and losing one by accident is not acceptable.
   *
   *  The two knobs above the list are both about the ECONOMY rather than about
   *  damage: difficulty decides what each side is given and what a victory is
   *  worth, and unlimited requisition takes the whole question away. */
  function showCampaignPicker(game) {
    var old = document.getElementById('campPick');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'campPick';
    var html = '<div class="cp-box"><h3>Choose an operation</h3>';
    // DIFFICULTY, and it is a requisition setting rather than a damage slider:
    // how much you are given, how much they are given, and how much a victory
    // is worth. A resumed campaign keeps the setting it was started on.
    html += '<div class="cp-diff"><h4>Difficulty</h4><div class="cp-drow">';
    for (var d = 0; d < DIFF_ORDER.length; d++) {
      var key = DIFF_ORDER[d], D = DIFFICULTY[key];
      html += '<button class="cp-d' + (key === pendingDiff ? ' sel' : '') + '" data-diff="' + key + '">'
        + esc(D.name) + '</button>';
    }
    html += '</div><p class="cp-dblurb">' + esc(DIFFICULTY[pendingDiff].blurb) + '</p>';
    // UNLIMITED REQUISITION. Sits under difficulty because it is the same kind
    // of decision — how much of this is about the economy — and it says plainly
    // what it does NOT do.
    html += '<div class="cp-unlim"><button class="cp-u' + (pendingUnlimited ? ' sel' : '') + '" data-unlim="1">'
      + (pendingUnlimited ? '\u2611' : '\u2610') + ' Unlimited requisition</button>'
      + '<span>' + (pendingUnlimited
          ? 'Buy anything you like, as much of it as you like, at no cost \u2014 no prices, no scarcity caps, and no waiting for a type to become available. Nine platoons of King Tigers if you want them. The enemy still buys out of its own pool against its own caps, so there is still a battle at the end of it.'
          : 'The campaign economy is on: you fight the next battle with what this one leaves you.')
      + '</span></div>';
    html += '</div>';
    for (var i = 0; i < CAMPAIGNS.length; i++) {
      var C = CAMPAIGNS[i], saved = null;
      try {
        var raw = localStorage.getItem(C.saveKey);
        var st = raw ? JSON.parse(raw) : null;
        if (st && st.id === C.id && st.v === 2 && st.force) saved = st;
      } catch (e) { saved = null; }
      html += '<div class="cp-row" data-id="' + C.id + '" data-resume="0">'
        + '<b>' + esc(C.name) + '</b><i>' + esc(C.subtitle) + '</i>'
        + '<span class="cp-side">' + esc(C.side) + '</span>'
        + '<p>' + esc(C.blurb) + '</p>'
        + (saved ? '<button class="cp-go" data-id="' + C.id + '" data-resume="1">Resume — battle '
              + (saved.battle + 1) + ' of ' + C.battles.length + '</button>' : '')
        + '<button class="cp-go" data-id="' + C.id + '" data-resume="0">'
        + (saved ? 'Start over' : 'Begin') + '</button>'
        + '</div>';
    }
    html += '<button class="cp-cancel">Cancel</button></div>';
    el.innerHTML = html;
    document.body.appendChild(el);
    el.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('cp-cancel') || e.target === el) { el.remove(); return; }
      var ub = e.target.closest ? e.target.closest('.cp-u') : null;
      if (ub) {
        pendingUnlimited = !pendingUnlimited;
        el.remove();
        showCampaignPicker(game);      // redraw: the text beside it changes too
        return;
      }
      var db = e.target.closest ? e.target.closest('.cp-d') : null;
      if (db) {
        pendingDiff = db.dataset.diff;
        var all = el.querySelectorAll('.cp-d');
        for (var i = 0; i < all.length; i++) all[i].classList.toggle('sel', all[i] === db);
        el.querySelector('.cp-dblurb').textContent = DIFFICULTY[pendingDiff].blurb;
        return;
      }
      var go = e.target.closest ? e.target.closest('.cp-go') : null;
      if (!go) return;
      var resume = go.dataset.resume === '1';
      selectCampaign(go.dataset.id);
      el.remove();
      if (!resume) { try { localStorage.removeItem(SAVE_KEY); } catch (err) { /* ignore */ } }
      game.campaignStart(resume);
    });
  }

  function sect(h, body, cls) {
    return '<div class="br-sect ' + (cls || '') + '"><h4>' + esc(h) + '</h4><p>' + esc(body) + '</p></div>';
  }
  function lossList(bag) {
    var keys = Object.keys(bag || {});
    if (!keys.length) return '<div>None</div>';
    keys.sort();
    return keys.map(function (t) {
      var tm = T()[t];
      return '<div>' + bag[t] + ' × ' + esc(tm ? tm.name : t) + '</div>';
    }).join('');
  }
  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
  function hhmm(m) {
    var h = Math.floor(m / 60) % 24, q = Math.round(m % 60);
    return (h < 10 ? '0' : '') + h + ':' + (q < 10 ? '0' : '') + q;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var PICKER_CSS = [
    '#campPick{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;',
    '  background:rgba(8,10,12,.72);backdrop-filter:blur(3px);font:13px/1.5 system-ui,sans-serif;color:#dfe4ea}',
    '#campPick .cp-box{background:#161a1f;border:1px solid #2c333c;border-radius:8px;padding:20px 22px;max-width:640px;width:92%}',
    '#campPick h3{margin:0 0 14px;font-size:16px;letter-spacing:.04em;text-transform:uppercase;color:#c8cfd8}',
    '#campPick .cp-row{border:1px solid #2a3038;border-radius:6px;padding:12px 14px;margin-bottom:10px;background:#1b2027}',
    '#campPick .cp-row b{font-size:15px;color:#f0f4f8}',
    '#campPick .cp-row i{margin-left:8px;color:#8d97a3;font-style:normal}',
    '#campPick .cp-side{display:block;margin-top:2px;color:#7f8b98;font-size:11px;letter-spacing:.06em;text-transform:uppercase}',
    '#campPick .cp-row p{margin:8px 0 10px;color:#aab3bd}',
    '#campPick button{font:inherit;cursor:pointer;border-radius:4px;border:1px solid #39424d;background:#232a32;color:#dfe4ea;padding:6px 12px;margin-right:8px}',
    '#campPick button:hover{background:#2d353f;border-color:#4a5561}',
    '#campPick .cp-cancel{margin-top:6px;background:transparent;border-color:#333b45;color:#8d97a3}',
    '#campPick .cp-diff{border:1px solid #2a3038;border-radius:6px;padding:10px 14px 12px;margin-bottom:12px;background:#141920}',
    '#campPick .cp-diff h4{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8d97a3}',
    '#campPick .cp-drow{display:flex;gap:0}',
    '#campPick .cp-d{margin-right:8px}',
    '#campPick .cp-unlim{display:flex;align-items:flex-start;gap:10px;margin-top:10px;',
    '  padding-top:9px;border-top:1px solid #2a3a4a}',
    '#campPick .cp-unlim span{font:11px/1.45 "Segoe UI",sans-serif;color:#8fa3b5;flex:1}',
    '#campPick .cp-u{background:#16202b;border:1px solid #33465a;color:#cfe0ee;border-radius:4px;',
    '  padding:5px 10px;cursor:pointer;font:12px/1 "Segoe UI",sans-serif;white-space:nowrap}',
    '#campPick .cp-u.sel{background:#2c4a33;border-color:#5d8f68;color:#dff3e2}',
    '#campPick .cp-d.sel{background:#3a4a2e;border-color:#6f8a52;color:#e8f0dc}',
    '#campPick .cp-dblurb{margin:10px 0 0;color:#aab3bd;min-height:2.6em}',
  ].join('');

  function injectStyles() {
    if (!document.getElementById('campPickCss')) {
      var pc = document.createElement('style'); pc.id = 'campPickCss'; pc.textContent = PICKER_CSS;
      document.head.appendChild(pc);
    }
    if (document.getElementById('brStyles')) return;
    var st = document.createElement('style');
    st.id = 'brStyles';
    st.textContent = [
      '#brief{position:fixed;inset:0;z-index:900;display:none;background:radial-gradient(120% 100% at 50% 0%,#16202a,#080c11 70%);',
      '  font:13px/1.5 ui-serif,Georgia,"Times New Roman",serif;color:#c3d2dd;overflow:auto;padding:18px}',
      '.br-card{max-width:1240px;margin:0 auto;background:rgba(12,17,23,.86);border:1px solid #2b3a49;border-radius:8px;',
      '  box-shadow:0 20px 60px rgba(0,0,0,.6)}',
      '.br-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:18px 22px 14px;border-bottom:1px solid #22303d}',
      '.br-op{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:2.4px;text-transform:uppercase;color:#c8a060}',
      '#brTitle{font-size:30px;font-weight:700;letter-spacing:.6px;margin:7px 0 4px;color:#e8dcc4}',
      '.br-when{font-size:12px;color:#8a9dad;font-style:italic}',
      '.br-role{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:2px;padding:6px 12px;border-radius:4px;white-space:nowrap;',
      '  border:1px solid #3a4a5a;color:#9fb3c4}',
      '.br-role.attack{border-color:#7a5a2a;color:#e2b878;background:rgba(122,90,42,.16)}',
      '.br-role.defend{border-color:#2a5a5a;color:#78d2c8;background:rgba(42,90,90,.16)}',
      '.br-body{display:grid;grid-template-columns:1fr 1.15fr;gap:0}',
      '.br-left{padding:16px 22px;border-right:1px solid #22303d}',
      '.br-right{padding:16px 18px;display:flex;flex-direction:column;min-height:0}',
      '#brief h4{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:2px;text-transform:uppercase;color:#c8a060;margin:0 0 7px}',
      '.br-sect{margin-bottom:15px}.br-sect p{margin:0;color:#bccadb}',
      '.br-hist p{color:#93a7b8;font-style:italic;border-left:2px solid #3a4a5a;padding-left:11px}',
      '.br-stratwrap{margin-top:18px;padding-top:14px;border-top:1px solid #22303d}',
      '.br-strat{display:flex;flex-direction:column;gap:1px}',
      '.br-stop{display:grid;grid-template-columns:16px 1fr auto;gap:9px;align-items:center;padding:3px 0;',
      '  font:11px/1.3 ui-monospace,Menlo,monospace;color:#61748a}',
      '.br-stop i{width:9px;height:9px;border-radius:50%;border:1px solid #45566a;display:block;margin-left:3px}',
      '.br-stop.done i{background:#4a6a52;border-color:#5e8468}',
      '.br-stop.done.lost i{background:#6a3a3a;border-color:#8a4a4a}',
      '.br-stop.now{color:#e8dcc4}.br-stop.now i{background:#c8a060;border-color:#e2c088;box-shadow:0 0 8px rgba(200,160,96,.55)}',
      '.br-stop span{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:#7a8fa2}',
      '.br-poolhead{display:flex;justify-content:space-between;align-items:baseline}',
      '.br-poolhead span{font:10px/1 ui-monospace,Menlo,monospace;color:#8a9dad}',
      '.br-budget{height:6px;background:#1b2530;border-radius:3px;overflow:hidden;margin:4px 0 3px}',
      '#brBar{height:100%;background:linear-gradient(90deg,#5e8468,#c8a060);width:0}',
      '#brBar.over{background:linear-gradient(90deg,#c8a060,#c87a3a)}',
      '.br-spend{font:10px/1.6 ui-monospace,Menlo,monospace;color:#c8a060;margin-bottom:7px}',
      '.br-spend.wide{color:#e8944a}',
      '.br-pool{flex:1;overflow:auto;max-height:58vh;border-top:1px solid #22303d;font:11px/1.35 ui-monospace,Menlo,monospace}',
      // ---- force builder ----
      '.fb-head{display:flex;justify-content:space-between;padding:6px 2px;color:#8a9dad;border-bottom:1px solid #18222c}',
      '.fb-head b{color:#c8a060}',
      '.fb-pl{display:flex;justify-content:space-between;align-items:center;padding:9px 2px 3px;',
      '  font-size:9.5px;letter-spacing:1.8px;text-transform:uppercase;color:#c8a060;border-top:1px solid #22303d}',
      '.fb-tools i{font-style:normal;cursor:pointer;color:#5f7286;margin-left:9px}',
      '.fb-tools i:hover{color:#c8a060}',
      // ---- the slot row: arm, name, a man per soldier, strength, record ----
      '.fb-slot{display:grid;grid-template-columns:15px 154px 100px 36px 52px 1fr auto;gap:6px;align-items:center;',
      '  padding:4px 4px;border-bottom:1px solid #18222c}',
      '.fb-slot b{color:#cfe0ee;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fb-slot.hurt b{color:#e8944a}',
      '.fb-slot.lifted{background:rgba(200,160,96,.13);outline:1px solid #c8a060}',
      '.fb-slot.empty{grid-template-columns:154px 1fr;cursor:pointer;opacity:.6;border:1px dashed #2f4050;border-radius:4px;margin:2px 0}',
      '.fb-slot.empty:hover{opacity:1;border-color:#c8a060}',
      '.fb-slot.empty.sel{opacity:1;border-color:#c8a060;background:rgba(200,160,96,.10)}',
      '.fb-slot.empty.drop{opacity:1;border-color:#9fc4a8;background:rgba(159,196,168,.12)}',
      '.fb-slot.empty.drop b{color:#9fc4a8}',
      '.fb-hint{color:#5f7286;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fb-arm{color:#7a8fa2;font-size:11px;text-align:center}',
      // THE ROW OF MEN. Filled for a soldier standing, hollow for a gap — the
      // one thing on this screen you read without reading.
      '.fb-pips{color:#9fc4a8;letter-spacing:.5px;font-size:10px;white-space:nowrap;overflow:hidden}',
      '.fb-pips.part{color:#e8b060}',
      '.fb-pips.gone{color:#8a4a4a}',
      '.fb-str{color:#c8a060;text-align:right}',
      '.fb-vet{font-size:9px;letter-spacing:.6px}',
      '.fb-vet.v0{color:#8a9dad}.fb-vet.v1{color:#9fc4a8}.fb-vet.v2{color:#e2c088}',
      '.fb-note{color:#61748a;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fb-acts i{font-style:normal;cursor:pointer;color:#7a8fa2;margin-left:8px;font-size:10px}',
      '.fb-acts i:hover{color:#c8a060}.fb-acts i.off{opacity:.3;pointer-events:none}',
      '.fb-add{padding:7px 2px;color:#5f7286;cursor:pointer;font-size:10px;letter-spacing:1px}',
      '.fb-add:hover{color:#c8a060}',
      // ---- the order of battle by arm, and the carry banner ----
      '.fb-arms{display:flex;flex-wrap:wrap;gap:11px;padding:6px 2px 7px;border-bottom:1px solid #18222c}',
      '.fb-arms i{font-style:normal;color:#7a8fa2;font-size:11px;display:flex;align-items:baseline;gap:3px}',
      '.fb-arms i b{color:#c8a060;font-size:10.5px}',
      '.fb-arms i.none{color:#5f7286;font-size:10px}',
      '.fb-moving{padding:5px 7px;margin:5px 0;border-radius:4px;font-size:10.5px;color:#cfe0ee;',
      '  background:rgba(200,160,96,.12);border:1px solid #6b5a34}',
      '.fb-moving b{color:#e2c088}',
      '.fb-moving i{font-style:normal;color:#9fb3c4;cursor:pointer;text-decoration:underline}',
      '.fb-moving i:hover{color:#c8a060}',
      '.rq-cat{display:flex;justify-content:space-between;align-items:baseline;padding:10px 2px 4px;',
      '  font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;color:#8a9dad;border-top:1px solid #22303d}',
      '.rq-cat span{color:#5f7286;letter-spacing:.6px;text-transform:none;font-size:10px}',
      '.rq-row b u{color:#c8a060;text-decoration:none;font-size:10px}',
      '.rq-row{display:grid;grid-template-columns:172px 34px 96px 1fr;gap:7px;align-items:center;',
      '  padding:4px 2px;border-bottom:1px solid #18222c;cursor:pointer}',
      '.rq-row b{color:#cfe0ee;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rq-row:hover{background:#18222c}',
      '.rq-row.off{opacity:.38;cursor:default}',
      '.rq-row.off:hover{background:none}',
      '.rq-rp{color:#c8a060;text-align:right}',
      '.rq-men{color:#6f8598;font-size:10px;letter-spacing:.5px;white-space:nowrap;overflow:hidden}',
      // THE NOTE IS PROSE AND IT WAS BEING TREATED AS A LABEL. Every purchasable
      // unit carries a line of history — "A First World War siege gun driven up
      // to a point-blank position", "A Universal Carrier with a flame gun where
      // the Bren went" — and `white-space:nowrap` with a 164px column showed
      // about the first twenty characters of it. Measured on the live briefing:
      // **39 notes clipped, the worst wanting 1,090 pixels in 164** — and with
      // no `title` of its own the rest was not recoverable at all, so some of
      // the best writing in the game was simply not readable.
      //
      // Two lines rather than one, and the full text goes on the row's tooltip
      // (which until now carried only the section's composition). A note that
      // is still too long is then one hover away instead of gone.
      '.rq-note{color:#61748a;font-size:10px;overflow:hidden;white-space:normal;',
      '  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.25}',
      '.br-sep{font:9.5px/1 ui-monospace,Menlo,monospace;letter-spacing:2px;text-transform:uppercase;color:#7a8fa2;',
      '  padding:13px 0 6px;border-bottom:1px solid #22303d}',
      '.br-lists{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0 16px}',
      '.br-lists div{font:11px/1.6 ui-monospace,Menlo,monospace;color:#93a7b8}',
      '.br-foot{display:flex;align-items:center;gap:9px;padding:13px 22px;border-top:1px solid #22303d}',
      '#brUnlim.on{background:#2c4a33;border-color:#5d8f68;color:#dff3e2}',
      '.br-gap{flex:1}',
      '.br-b{font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:1px;padding:9px 15px;border-radius:5px;cursor:pointer;',
      '  background:#1d2836;border:1px solid #3a4a5a;color:#cfe0ee}',
      '.br-b:hover{border-color:#c8a060;color:#e8dcc4}',
      '.br-b.ghost{background:transparent;color:#7a8fa2}',
      '.br-b.go{background:linear-gradient(180deg,#c8a060,#a8823f);border-color:#e2c088;color:#151008;font-weight:700}',
      '.br-b.go:disabled{opacity:.35;cursor:default;filter:grayscale(1)}',
      // A SKIRMISH BRIEFING IS THE SAME CARD WITH NOTHING TO BUY. There is no
      // battlegroup, no operation to place the battle in and nothing to
      // abandon, so the right-hand column, the strategic map and the campaign
      // buttons all go — leaving one column of history and a way out of it.
      '#brief.br-skirmish .br-body{grid-template-columns:1fr}',
      '#brief.br-skirmish .br-right,#brief.br-skirmish .br-stratwrap,',
      '#brief.br-skirmish #brQuit,#brief.br-skirmish #brUnlim,',
      '#brief.br-skirmish #brClear,#brief.br-skirmish #brAuto{display:none}',
      '#brief.br-skirmish .br-left{border-right:0}',
      '#brief.br-skirmish #brGo::after{content:"  (Esc)";opacity:.55;font-weight:400}',
      '@media (max-width:980px){.br-body{grid-template-columns:1fr}.br-left{border-right:0;border-bottom:1px solid #22303d}}',
      // In a campaign battle the force is what you requisitioned. No call-ins.
      'body.campaign-battle #reinforceBar{display:none!important}',
      '#cmPill{position:fixed;top:78px;left:50%;transform:translateX(-50%);z-index:110;display:none;align-items:center;gap:11px;',
      '  padding:5px 14px;border-radius:16px;background:rgba(14,19,25,.92);border:1px solid #2b3a49;',
      '  font:10.5px/1 ui-monospace,Menlo,monospace;color:#93a7b8;box-shadow:0 4px 16px rgba(0,0,0,.5)}',
      '#cmPill b{color:#e8dcc4;font-size:11.5px;letter-spacing:.4px}',
      '#cmPill i{font-style:normal;letter-spacing:1.6px;color:#c8a060}',
      '#cmPill span{color:#7d94a8;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cmPill u{text-decoration:none;color:#61748a}',
      'body.fpv #cmPill{display:none!important}',
    ].join('\n');
    document.head.appendChild(st);
  }

  window.Campaign = {
    VERSION: VERSION,
    CAMPAIGNS: CAMPAIGNS,
    DIFFICULTY: DIFFICULTY,
    DIFF_ORDER: DIFF_ORDER,
    rpAward: rpAward,
    diffOf: diffOf,
    select: selectCampaign,
    get CAMPAIGN() { return CAMPAIGN; },
    AI_DOCTRINE: AI_DOCTRINE,
    CAPS: CAPS,
    SAVE_KEY: SAVE_KEY,
    install: install,
    freshState: freshState,
    autoBuild: autoBuild,
    autoBuildSupport: autoBuildSupport,
    availableAt: availableAt,
    replaceCost: replaceCost,
  };
})();
