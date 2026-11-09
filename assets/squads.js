/* =========================================================================
 * SQUADS — Close Combat command dynamics for Tactical Command
 * =========================================================================
 *
 * WHAT THIS IS FOR
 *
 * The game already had a Squad class: a bag of units with a leader, a colour
 * ring and a shared formation. What it did not have is the thing that makes
 * Close Combat feel like Close Combat — that a squad is a CREATURE, not a
 * selection. It has a name, a state of mind, and a will of its own that your
 * orders argue with rather than dictate to.
 *
 * Five systems, in the order they matter:
 *
 *   1. ORGANISATION.  An order of battle arrives from a map or a force pool
 *      as a list of units. `organiseSquads()` turns it into a real one:
 *      rifle platoons around an officer, weapons sections, gun sections,
 *      tank platoons — grouped by where they actually deployed, named the way
 *      each army named them ("2nd Platoon, A Company" / "3. Zug").
 *
 *   2. COHESION.  A squad ordered to move goes together. Stragglers are
 *      hurried, the leading element is held back for the rear, and the squad
 *      arrives as a squad. This is also why a twelve-man platoon crossing
 *      2.7 km is affordable: the shape is maintained by a 4 Hz check, not by
 *      re-pathing everybody every time somebody trips over a hedge.
 *
 *   3. MORALE.  One number per squad — `fear`, 0..1 — fed by suppression,
 *      casualties, losing the leader, and being shot at from a flank. It
 *      moves a state machine: steady → cautious → nervous → shaken → pinned →
 *      broken. The state is not cosmetic: shaken squads stop attacking,
 *      pinned squads refuse move orders, and broken squads rout to the rear
 *      and cannot be commanded at all until they rally.
 *
 *   4. BOUNDING OVERWATCH.  A squad that is under fire while moving stops
 *      walking in a line. Half of it moves while the other half is down and
 *      watching, and they swap. It is the single most visible difference
 *      between troops that look like counters and troops that look trained.
 *
 *   5. THE ROSTER.  A panel of your squads with strength, morale and what
 *      each one is actually doing — the readout Close Combat put at the
 *      bottom of the screen, because knowing that 2nd Platoon is shaken is
 *      the information the whole game turns on.
 *
 * DESIGN CONSTRAINTS
 *
 *   · This file must be OPTIONAL. Every call site in tactical_command.html is
 *     guarded; with the script absent the game plays exactly as it did.
 *   · It patches prototypes rather than forking them, and every patch chains
 *     to the original. Nothing here reimplements movement, pathing, cover or
 *     suppression — it steers the mechanisms already there.
 *   · No new per-frame per-unit work. Cohesion and morale run at 4 Hz over
 *     squads, of which there are a few dozen, not units, of which there are
 *     hundreds.
 * ========================================================================= */
(function () {
  'use strict';
  // (round 107) Math.hypot is seven times a square root here; see `hyp` in the game.
  const sqHyp = (x, z) => Math.sqrt(x * x + z * z), sqHyp3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

  var VERSION = '1.0';
  var G = null;              // injected game internals (set by install)
  var installed = false;

  // =========================================================================
  // MORALE — the ladder, and what each rung does
  // =========================================================================
  // `enter` is the fear level at which a squad falls TO this state; it leaves
  // for the state above only once fear drops below `enter - HYST`. Without the
  // hysteresis a squad sitting on a threshold flickers between "advancing" and
  // "pinned" several times a second, which reads as a bug even when the
  // underlying number is behaving perfectly.
  var HYST = 0.06;
  // How long a section must hold a rung before it can be pushed to the next,
  // growing as it goes down: `RUNG_DWELL * (1 + rank * 0.4)`. Steady to broken
  // is therefore at least fourteen seconds of unrelieved pressure, and the
  // player gets to see each stage of it and do something about it. Mirrors
  // `CC_RUNG_DWELL` on the individual soldier.
  var RUNG_DWELL = 2.0;
  // Per second, for a section standing at the breaking point. `broken` is a
  // roll against the leader, the officer and the men's own steel — not a line
  // the number crosses.
  // Measured: at 0.5 an unled section that reached `pinned` broke inside five
  // seconds, which gives the player no chance to relieve it. At 0.22 an unled
  // one goes in about ten seconds and a led one with an officer in earshot
  // holds for half a minute — which is what the leader is FOR.
  var SQ_ROUT_RATE = 0.22;
  // SURRENDER. How close the enemy has to be to take a section, how far a
  // friend may be and still count as help within reach, how fast a hopeless
  // section goes into the bag, and how long they stand with their hands up
  // before they leave the field. See `_squadSurrenderCheck`.
  var SURRENDER_NEAR = 26;
  var SURRENDER_HELP = 40;
  var SURRENDER_RATE = 0.35;
  var SURRENDER_SHOW = 4.0;
  // The per-soldier rungs that count as "this man has personally lost it",
  // read by `_squadMorale`. The squad's number is built out of these.
  var CC_DOWN = { cowering: 1, panicked: 1, broken: 1, routed: 1, stunned: 1 };
  var MORALE = [
    { id: 'steady',   enter: 0.00, label: 'Steady',   color: '#7fd48a', short: 'OK' },
    { id: 'cautious', enter: 0.26, label: 'Cautious', color: '#c9d47f', short: 'CAUT' },
    { id: 'nervous',  enter: 0.44, label: 'Nervous',  color: '#e8c05a', short: 'NERV' },
    { id: 'shaken',   enter: 0.62, label: 'Shaken',   color: '#e8944a', short: 'SHKN' },
    { id: 'pinned',   enter: 0.80, label: 'Pinned',   color: '#e2603c', short: 'PIN' },
    { id: 'broken',   enter: 0.93, label: 'BROKEN',   color: '#ff4040', short: 'BRK' },
  ];
  // Not a rung on the ladder — a terminal state, reached by being killed
  // rather than by being frightened, and never left.
  var DESTROYED = { id: 'destroyed', enter: 2, label: 'Destroyed', color: '#6b7480', short: '—' };
  var MORALE_BY_ID = { destroyed: DESTROYED };
  for (var mi = 0; mi < MORALE.length; mi++) MORALE_BY_ID[MORALE[mi].id] = MORALE[mi];
  var RANK = { steady: 0, cautious: 1, nervous: 2, shaken: 3, pinned: 4, broken: 5, destroyed: 6 };

  // =========================================================================
  // ORGANISATION — how an order of battle is cut into squads
  // =========================================================================
  // Roles are read off the unit definition rather than a hand-written table,
  // so player-made units from the Forge organise themselves correctly too.
  function roleOf(def) {
    if (!def) return 'rifle';
    var k = def.kind;
    if (k === 'officer') return 'command';
    if (k === 'tank' || k === 'flametank') return 'armour';
    if (k === 'apc') return 'transport';
    if (k === 'atgun') return 'atgun';
    if (k === 'artillery') return 'artillery';
    if (k === 'mortar') return 'mortar';
    if (k === 'hmg') return 'mg';
    if (k === 'rocket') return 'at';
    if (k === 'sniper') return 'sniper';
    if (k === 'engineer') return 'engineer';
    return 'rifle';   // rifle, smg, flame, and anything custom
  }

  // Per-nation naming, because "Squad 4" is not a briefing and "3. Zug" is.
  var NAMING = {
    allied: {
      rifle:     ['1st Platoon', '2nd Platoon', '3rd Platoon', '4th Platoon', '5th Platoon'],
      weapons:   ['Weapons Sect', '2nd Weapons', '3rd Weapons'],
      at:        ['AT Section', '2nd AT Sect', '3rd AT Sect'],
      armour:    ['Able Tanks', 'Baker Tanks', 'Charlie Tanks', 'Dog Tanks'],
      recon:     ['Recon Troop', '2nd Recon'],
      artillery: ['Bty Fire Direction', '2nd Battery'],
      transport: ['Transport Sect', '2nd Transport'],
      company:   ['A Company', 'B Company', 'C Company'],
    },
    axis: {
      rifle:     ['1. Zug', '2. Zug', '3. Zug', '4. Zug', '5. Zug'],
      weapons:   ['Schwere Waffen', '2. Schwere Waffen', '3. Schwere Waffen'],
      at:        ['Pak-Zug', '2. Pak-Zug', '3. Pak-Zug'],
      armour:    ['Panzerzug I', 'Panzerzug II', 'Panzerzug III', 'Panzerzug IV'],
      recon:     ['Aufklarer', '2. Aufklarer'],
      artillery: ['Artillerie', '2. Artillerie'],
      transport: ['Fahrzeuge', '2. Fahrzeuge'],
      company:   ['1. Kompanie', '2. Kompanie', '3. Kompanie'],
    },
  };

  // How big each kind of squad wants to be, and what it will absorb.
  // `attach` lets a rifle platoon pick up its own MG or bazooka team, which is
  // how these units actually fought — the support weapon belongs to the
  // platoon, not to a pool somewhere behind it.
  // How far apart two men can be and still be in the same section, in world
  // units. A rifle section held a frontage of a few tens of metres; past that
  // they are two sections, however similar their weapons.
  var SECTION_SPAN = 34;

  var SHAPES = [
    // `size: 'estab'` — cut this one at the army's own paper strength (twelve
    // for a US rifle squad, nine for a Gruppe) rather than at a fixed number.
    // Four was a fire team, and it is what a stock map's order of battle got
    // however many men were standing there. See `estabOf` in the main file and
    // `TEMPLATES` above, which has carried the same numbers for the campaign
    // all along.
    { group: 'rifle',     roles: ['rifle', 'engineer'], size: 'estab', lead: 'command',
      attach: [{ role: 'mg', n: 1 }, { role: 'at', n: 1 }] },
    { group: 'weapons',   roles: ['mg', 'mortar'],      size: 3, lead: null, attach: [] },
    { group: 'at',        roles: ['atgun', 'at'],       size: 2, lead: null, attach: [] },
    { group: 'armour',    roles: ['armour'],            size: 3, lead: null, attach: [] },
    { group: 'recon',     roles: ['sniper'],            size: 2, lead: null, attach: [] },
    { group: 'artillery', roles: ['artillery'],         size: 3, lead: null, attach: [] },
    { group: 'transport', roles: ['transport'],         size: 3, lead: null, attach: [] },
  ];


  // =========================================================================
  // SQUAD TEMPLATES — what you actually buy
  // =========================================================================
  //
  // The purchasable atom is a SQUAD, not a soldier. That is the whole point of
  // the Close Combat model: you requisition "a rifle squad" and you get the
  // men that squad was made of, in the proportions it really had.
  //
  // A US rifle squad is not nine riflemen. It is a leader with a Thompson, a
  // BAR gunner who is the squad's base of fire, and seven riflemen who
  // manoeuvre around him. A German Gruppe is an MG42 and the men who carry its
  // ammunition. A Volksgrenadier reserve squad is six men with old rifles and
  // three weeks' training, and it costs four points because that is what it is
  // worth.
  //
  // `rp` is REQUISITION POINTS on the Close Combat scale — single digits for
  // infantry, teens for medium armour, thirty for a Tiger — and deliberately
  // NOT the internal `unitCost` the engine balances Forge units with. The two
  // scales answer different questions: unitCost asks "is this unit fair?",
  // requisition asks "what can a battalion afford this week?".
  //
  // `from` is the campaign battle index at which the type first appears.
  var TEMPLATES = {
    // ---------------- United States ----------------
    us_hq:       { name: 'Company HQ', nation: 'us', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['usofficer', 'ussmg', 'usrifle', 'usrifle', 'usmedic'],
                   note: 'The captain, his runner, his radio operator and an aid man. Steadies every squad within earshot.' },
    us_rifle:    { name: 'Rifle Squad', nation: 'us', w: 6, rp: 11, cat: 'rifle', from: 0, vet: 1,
                   men: ['ussmg', 'usrifle', 'usbar', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'TWELVE men, as the table of organisation had it: a staff sergeant, his assistant, a BAR gunner with his loader and ammunition bearer, and seven Garands. The BAR is the squad — the other eleven manoeuvre around it.' },
    us_rifle_vet:{ name: 'Veteran Rifle Squad', nation: 'us', w: 1.6, rp: 14, cat: 'rifle', from: 3, vet: 2,
                   men: ['ussmg', 'usbar', 'usbar', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'Been in the hedgerows a month and scrounged a second BAR, which is what every veteran squad in Normandy did. Twelve men who know what to do with them.' },
    us_assault:  { name: 'Assault Squad', nation: 'us', w: 1.2, rp: 13, cat: 'rifle', from: 0, vet: 1,
                   men: ['ussmg', 'ussmg', 'usgrease', 'usbar', 'usbar', 'usengineer', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'The hedgerow assault squad COBRA was fought with: grease guns, two BARs, and a demolition man to blow the bank. Murderous inside fifty metres, helpless past two hundred.' },
    us_engineer: { name: 'Engineer Squad', nation: 'us', w: 1, rp: 11, cat: 'rifle', from: 0, vet: 1,
                   men: ['usengineer', 'usengineer', 'usengineer', 'usengineer', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'A combat engineer squad is twelve men — four with demolitions and eight who carry, dig and cover them. They blow the hole in the hedgerow bank the tanks go through.' },
    us_mg30:     { name: '.30 cal MG Team', nation: 'us', w: 3, rp: 7, cat: 'mg', from: 0, vet: 1,
                   men: ['us30cal', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'The light machine gun SQUAD: a squad leader, the gunner, his assistant and two ammunition bearers. Five men, because one man cannot feed an M1919 and live.' },
    us_mg50:     { name: '.50 cal MG Team', nation: 'us', w: 1.6, rp: 9, cat: 'mg', from: 0, vet: 1,
                   men: ['fiftycal', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'Ground-mounted on the M3 tripod, which takes four men to shift. It goes through a wall, and everyone within a mile knows where it is.' },
    us_mortar:   { name: '81mm Mortar Team', nation: 'us', w: 2, rp: 9, cat: 'mortar', from: 0, vet: 1,
                   men: ['usmortar', 'usrifle', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'The 81mm squad — gunner, assistant and four ammunition bearers, because the bombs weigh more than the mortar does. Indirect fire: it does not need to see what it is killing.' },
    us_bazooka:  { name: 'Bazooka Team', nation: 'us', w: 3, rp: 5, cat: 'at', from: 0, vet: 1,
                   men: ['bazooka', 'usrifle'],
                   note: 'One rocket, a hundred and fifty metres, and it has to be a flank shot.' },
    us_sniper:   { name: 'Sniper Team', nation: 'us', w: 1, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['sniper', 'usscout'],
                   note: 'Shooter and observer, which is how snipers actually work — one man on the glass, one on the trigger. They kill officers and machine gunners.' },
    us_recon:    { name: 'Recon Patrol', nation: 'us', w: 2, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['usscout', 'usscout', 'usscout', 'usscout'],
                   note: 'They see far further than they shoot. The minimap only shows what your men have found.' },
    us_flame:    { name: 'Flamethrower Team', nation: 'us', w: 0.4, rp: 8, cat: 'rifle', from: 1, vet: 1,
                   men: ['usflame', 'usrifle', 'usrifle'],
                   note: 'Operator, assistant with the spare tanks, and a rifleman to keep anybody from shooting the operator. Nothing hit by it keeps fighting.' },
    us_57mm:     { name: '57mm AT Gun', nation: 'us', w: 2, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['us57mm'], note: 'The licence-built 6-pounder. Adequate until a Panther turns up.' },
    us_3inch:    { name: '3-inch AT Gun', nation: 'us', w: 1, rp: 10, cat: 'atgun', from: 2, vet: 1,
                   men: ['us3inch'], note: 'A brute of a gun on a howitzer carriage. Very hard to move.' },
    us_arty:     { name: '155mm Howitzer', nation: 'us', w: 1, rp: 12, cat: 'arty', from: 2, vet: 1,
                   men: ['arty155'], note: 'Divisional weight, on call.' },
    us_truck:    { name: 'GMC Truck', nation: 'us', w: 1, rp: 4, cat: 'transport', from: 1, vet: 1,
                   men: ['ustruck'], note: 'Carries a squad. Stops nothing at all.' },
    us_halftrack:{ name: 'M3 Half-track', nation: 'us', w: 2, rp: 7, cat: 'transport', from: 1, vet: 1,
                   men: ['ushalftrack'], note: 'Open-topped, but it stops small arms and keeps up with the tanks.' },
    us_m16:      { name: 'M16 Quad .50', nation: 'us', w: 0.8, rp: 11, cat: 'transport', from: 5, vet: 1,
                   men: ['m16aa'], note: 'Four fifties on a half-track. Meant for aircraft, used on infantry.' },
    us_stuart:   { name: 'M5 Stuart', nation: 'us', w: 1, rp: 10, cat: 'armour', from: 1, vet: 1,
                   men: ['stuart'], note: 'Fast, thin, and its 37mm will not kill anything with armour.' },
    us_m8:       { name: 'M8 Greyhound', nation: 'us', w: 1.4, rp: 9, cat: 'recon', from: 1, vet: 1,
                   men: ['m8'], note: 'Six wheels and a 37mm. Reconnaissance, not fighting.' },
    us_sherman:  { name: 'M4 Sherman', nation: 'us', w: 4, rp: 17, cat: 'armour', from: 1, vet: 1,
                   men: ['sherman'], note: 'The workhorse. Reliable, plentiful, and out-gunned by everything German.' },
    us_m10:      { name: 'M10 Wolverine', nation: 'us', w: 1.5, rp: 15, cat: 'armour', from: 3, vet: 1,
                   men: ['m10'], note: 'A 3-inch gun in an open turret. Kill from a flank or do not shoot.' },
    us_hellcat:  { name: 'M18 Hellcat', nation: 'us', w: 1, rp: 14, cat: 'armour', from: 6, vet: 1,
                   men: ['hellcat'], note: 'Faster than anything on the field and made of tinfoil.' },
    // ---------------- British / Commonwealth ----------------
    // `br_carrier` and `br_cromwell` were each declared TWICE in this object —
    // once here with `nation: 'us'` and again in the Commonwealth block below
    // with `nation: 'uk'`. A duplicate key in an object literal is not an
    // error, it is a silent overwrite: the later definition won, so these two
    // were dead text that nonetheless read as if they were the live ones. The
    // Commonwealth copies are the better-written pair (earlier availability,
    // truer weights, notes that say something), so they are the ones kept.
    // THESE FIVE READ `nation: 'us'` FOR FIFTEEN ROUNDS. Harmless in Normandy,
    // where `nationOK` lets team 1 buy from 'us' OR 'uk' — which is exactly why
    // nobody noticed. It stops being harmless the moment a campaign declares a
    // narrower Allied side: in France 1940 team 1 is French and British, and a
    // Churchill marked American is a tank the Arras battle names in its `must`
    // list and the player can never replace.
    br_6pdr:     { name: 'QF 6-pounder', nation: 'uk', w: 1, rp: 8, cat: 'atgun', from: 4, vet: 1,
                   men: ['qf6pdr'], note: 'The original. Light enough that a crew can shift it.' },
    br_17pdr:    { name: 'QF 17-pounder', nation: 'uk', w: 0.6, rp: 13, cat: 'atgun', from: 4, vet: 1,
                   men: ['qf17pdr'], note: 'Kills anything the Germans have. Weighs three tons and everyone knows where it is.' },
    br_firefly:  { name: 'Sherman Firefly', nation: 'uk', w: 1, rp: 22, cat: 'armour', from: 4, vet: 2,
                   men: ['firefly'], note: 'One per troop of four, and the Germans shoot at it first.' },
    br_churchill:{ name: 'Churchill VII', nation: 'uk', w: 1, rp: 20, cat: 'armour', from: 4, vet: 1,
                   men: ['churchill'], note: 'Slow as a walk and almost impossible to kill from the front.' },
    br_croc:     { name: 'Churchill Crocodile', nation: 'uk', w: 0.4, rp: 26, cat: 'armour', from: 5, vet: 2,
                   men: ['crocodile'], note: '79th Armoured. A Churchill that throws fire eighty metres.' },

    // ---------------- Germany ----------------
    /** THE AID MAN WAS AMERICAN-ONLY BY ACCIDENT, AGAIN.
     *
     *  Round 43 gave every army an aid SECTION (`*_aid`) after finding the
     *  medic had never once saved anybody. It did not look at the HQs, and the
     *  HQ is the route that matters: measured over every battle of all seven
     *  campaigns, a company HQ is in the order of battle 100% of the time and
     *  the buyer picks an aid section in 4 offers out of 275. `us_hq` had
     *  carried a medic since it was written; no other nation's did, so a
     *  German, Soviet, Italian or French battlegroup went to war with no way
     *  to get a downed man back — in `westheer44` and `ostheer41` that is the
     *  PLAYER's own company.
     *
     *  The organic man, not an extra one: `ger_hq` and `sov_hq` swap a rifle
     *  for him and stay four strong at the same price, which is also what the
     *  establishments actually were. A Kompanietrupp had its
     *  Sanitätsunteroffizier; a Soviet rifle company had its saninstruktor. */
    ger_hq:      { name: 'Kompanie HQ', nation: 'ger', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['gerofficer', 'germp40', 'gergren', 'gersani'],
                   note: 'The Hauptmann, his Melder, a runner and the company Sanitätsunteroffizier.' },
    ger_gruppe:  { name: 'Rifle Gruppe', nation: 'ger', w: 6, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['germp40', 'mg42', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren'],
                   note: 'K.St.N. 131: NINE men — a Gruppenführer with an MP40, the MG42 gunner, two men carrying its belts, and five riflemen. The riflemen exist to feed and protect the gun.' },
    ger_reserve: { name: 'Reserve Squad', nation: 'ger', w: 2.5, rp: 5, cat: 'rifle', from: 0, vet: 0,
                   men: ['mg42', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks'],
                   note: 'Static-division men with old rifles and three weeks of training, on the same nine-man establishment as anybody else because the MG42 is not optional. Cheap, and they break.' },
    ger_volks:   { name: 'Volksgrenadier Squad', nation: 'ger', w: 2.5, rp: 8, cat: 'rifle', from: 0, vet: 0,
                   men: ['gerstg44', 'mg42', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks', 'gervolks'],
                   note: 'A Volksgrenadier Gruppe: nine men, an NCO with a Sturmgewehr and the same MG42. Short of everything except automatic fire.' },
    ger_ss:      { name: 'SS-Panzergrenadiere', nation: 'ger', w: 1.4, rp: 15, cat: 'rifle', from: 3, vet: 2,
                   men: ['germp40', 'mg42', 'mg42', 'gerss', 'gerss', 'gerss', 'gerss', 'gerss', 'gerss', 'gerss'],
                   note: 'K.St.N. 1114 — the armoured Panzergrenadier group: TEN men and TWO MG42s, because they fought off the half-track and could carry the ammunition for both. They counter-attack as a reflex.' },
    ger_fj:      { name: 'Fallschirmjäger', nation: 'ger', w: 1.4, rp: 15, cat: 'rifle', from: 2, vet: 2,
                   men: ['germp40', 'mg42', 'mg42', 'gerfj', 'gerfj', 'gerfj', 'gerfj', 'gerfj', 'gerfj', 'gerfj'],
                   note: 'Ten men and two MG42s to a Gruppe. The best defensive infantry in Normandy, and they knew the ground better than the men attacking it.' },
    ger_pioneer: { name: 'Pionier Squad', nation: 'ger', w: 1, rp: 11, cat: 'rifle', from: 0, vet: 1,
                   men: ['gerengineer', 'gerengineer', 'gerengineer', 'mg42', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren'],
                   note: 'A Pionier Gruppe of ten: three men on mines, wire and geballte Ladung, the section machine gun, and the men who cover them while they work.' },
    ger_mg:      { name: 'MG42 Team', nation: 'ger', w: 3, rp: 8, cat: 'mg', from: 0, vet: 1,
                   men: ['mg42', 'gergren', 'gergren', 'gergren', 'gergren'],
                   note: 'The schwere MG Trupp — the gun on the Lafette 42 tripod with a five-man detachment, because tripod, gun and belt boxes are separate loads. Twelve hundred rounds a minute, and the sound alone stops an attack.' },
    ger_mortar:  { name: '8cm Mortar Team', nation: 'ger', w: 2, rp: 9, cat: 'mortar', from: 0, vet: 1,
                   men: ['germortar', 'gergren', 'gergren', 'gergren', 'gergren'], note: 'GrW 34 with its five-man Trupp. Fast, accurate, and it ranges the whole map.' },
    ger_faust:   { name: 'Panzerfaust Team', nation: 'ger', w: 3, rp: 4, cat: 'at', from: 0, vet: 1,
                   men: ['panzerfaust', 'gergren'],
                   note: 'One shot at thirty metres that kills a Sherman. Then they are riflemen.' },
    ger_sniper:  { name: 'Scharfschütze', nation: 'ger', w: 1, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['sniper', 'gergren'], note: 'Patient, and he shoots the man giving the orders. The second man is on the binoculars.' },
    ger_aufklarer: { name: 'Aufklärungstrupp', nation: 'ger', w: 2, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['gerscout', 'gerscout', 'gerscout', 'gerscout'],
                   note: 'A Spähtrupp of four with binoculars and Zeltbahnen. They find you before you find them.' },
    ger_flame:   { name: 'Flammenwerfer Team', nation: 'ger', w: 0.4, rp: 8, cat: 'rifle', from: 1, vet: 1,
                   men: ['gerflame', 'gergren', 'gergren'], note: 'Operator, the man with the spare fuel, and a rifleman covering them both. For clearing a house the hard way.' },
    ger_pak40:   { name: '7.5cm PaK 40', nation: 'ger', w: 2.4, rp: 9, cat: 'atgun', from: 0, vet: 1,
                   men: ['pak75'], note: 'The backbone of the anti-tank defence. Low, hard to see, kills Shermans.' },
    ger_flak88:  { name: '8.8cm Flak 36', nation: 'ger', w: 0.8, rp: 14, cat: 'atgun', from: 0, vet: 1,
                   men: ['flak88'], note: 'Kills anything at any range on this map. Tall, and impossible to hide.' },
    ger_nebel:   { name: 'Nebelwerfer 41', nation: 'ger', w: 1, rp: 9, cat: 'arty', from: 1, vet: 1,
                   men: ['nebelwerfer'], note: 'Six rockets that scream. Terrible for morale, indifferent at killing.' },
    ger_wespe:   { name: 'Wespe', nation: 'ger', w: 1, rp: 13, cat: 'arty', from: 5, vet: 1,
                   men: ['wespe'], note: 'A 10.5cm howitzer that drives itself.' },
    ger_truck:   { name: 'Opel Blitz', nation: 'ger', w: 1, rp: 4, cat: 'transport', from: 1, vet: 1,
                   men: ['gertruck'], note: 'Carries a Gruppe, and burns.' },
    ger_251:     { name: 'Sd.Kfz. 251', nation: 'ger', w: 2, rp: 7, cat: 'transport', from: 1, vet: 1,
                   men: ['gerhalftrack'], note: 'Half-track. Armoured against splinters and nothing else.' },
    ger_puma:    { name: 'Puma 8-Rad', nation: 'ger', w: 1.4, rp: 10, cat: 'recon', from: 1, vet: 1,
                   men: ['puma'], note: 'Eight wheels, a 5cm gun, and quicker than anything chasing it.' },
    ger_marder:  { name: 'Marder III', nation: 'ger', w: 1, rp: 11, cat: 'armour', from: 1, vet: 1,
                   men: ['marder'], note: 'An excellent gun in an open box. One burst of HE ends it.' },
    ger_stug:    { name: 'StuG III', nation: 'ger', w: 3, rp: 16, cat: 'armour', from: 1, vet: 1,
                   men: ['stug'], note: 'Cheap, low, and everywhere. No turret, so it has to face what it fights.' },
    ger_pz4:     { name: 'Panzer IV Ausf. H', nation: 'ger', w: 3, rp: 17, cat: 'armour', from: 1, vet: 1,
                   men: ['panzer4'], note: 'The other workhorse. An even fight against a Sherman.' },
    ger_hetzer:  { name: 'Hetzer', nation: 'ger', w: 1, rp: 14, cat: 'armour', from: 6, vet: 1,
                   men: ['hetzer'], note: 'Small, sloped and very hard to spot in a hedgerow.' },
    ger_panther: { name: 'Panther', nation: 'ger', w: 1.5, rp: 24, cat: 'armour', from: 3, vet: 1,
                   men: ['panther'], note: 'Frontally near-immune at range. Its flanks are a Sherman problem.' },
    ger_tiger:   { name: 'Tiger I', nation: 'ger', w: 0.7, rp: 30, cat: 'armour', from: 4, vet: 2,
                   men: ['tiger'], note: 'schwere SS-Panzerabteilung 101. It decides the ground it stands on.' },
    ger_jagd:    { name: 'Jagdpanther', nation: 'ger', w: 0.4, rp: 28, cat: 'armour', from: 7, vet: 2,
                   men: ['jagdpanther'], note: 'An 8.8 on a Panther hull. Kills at any range on this map.' },
    ger_kt:      { name: 'Tiger II', nation: 'ger', w: 0.3, rp: 38, cat: 'armour', from: 8, vet: 2,
                   men: ['kingtiger'], note: 'A handful reached Normandy. Nothing you have will hurt its front.' },
    ger_wirbel:  { name: 'Wirbelwind', nation: 'ger', w: 0.5, rp: 12, cat: 'armour', from: 8, vet: 1,
                   men: ['wirbelwind'], note: 'Four 2cm cannon on a Panzer IV hull. Shreds infantry.' },
    // =====================================================================
    // THE REST OF THE ORDER OF BATTLE
    //
    // Sections built out of the units added alongside them. Two things worth
    // knowing about how these differ from the ones above:
    //
    //  * A British section is NOT an American one. The Bren is a magazine gun
    //    where the BAR is, so a British section's sustained fire is worse and
    //    its rifle fire is the same — which is why British infantry leant so
    //    much harder on the Vickers, the 3-inch and the 25-pounder behind them.
    //  * The German airborne and SS squads are the best infantry on the map and
    //    are priced like it; the Ostbataillon is the worst by a distance and is
    //    priced like that too. A defender who fills his line with Osttruppen
    //    has a lot of men and very little that will hold.

    // ---------------- United States ----------------
    us_para:     { name: 'Parachute Rifle Squad', nation: 'us', w: 1.4, rp: 13, cat: 'rifle', from: 0, vet: 2,
                   men: ['ussmg', 'usbar', 'usbar', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara'],
                   note: 'Twelve men, two BARs, and a grenade habit. They came down scattered and fought that way — very good, very hard to replace.' },
    us_ranger:   { name: 'Ranger Section', nation: 'us', w: 0.8, rp: 16, cat: 'rifle', from: 1, vet: 2,
                   men: ['usranger', 'usranger', 'usranger', 'usranger', 'usbar', 'usbar', 'ussmg', 'uspara', 'uspara', 'uspara', 'uspara', 'uspara'],
                   note: 'A Ranger assault section is twelve men, and a Ranger company is two of them. Murderous getting into a position, expensive to lose holding one.' },
    us_60mm:     { name: '60mm Mortar Team', nation: 'us', w: 2.4, rp: 6, cat: 'mortar', from: 0, vet: 1,
                   men: ['us60mm', 'usrifle', 'usrifle', 'usrifle', 'usrifle'],
                   note: 'The company mortar, five men and a handcart. Short range, small bomb, and it is answering inside twenty seconds because it is right behind you.' },
    // ---- AID POSTS -------------------------------------------------------
    // Every army had stretcher-bearers and every army's establishment names
    // them; until round 43 only the American one was in this game, so a player
    // fighting as anybody else could not buy an aid man at all and the medic
    // mechanic — which round 43 had just finished repairing — was a US-only
    // feature by accident rather than by design. `note` said "two medics" over
    // a list of three, which is how long it had been since anyone read it.
    us_aid:      { name: 'Aid Post', nation: 'us', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['usmedic', 'usmedic', 'usmedic'],
                   note: 'Three aid men. A man they reach is a man who fights at the next battle instead of a name in the casualty return.' },
    ger_aid:     { name: 'Sanitätstrupp', nation: 'ger', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['gersani', 'gersani', 'gersani'],
                   note: 'The company Sanitätsunteroffizier and his bearers. The Truppenverbandplatz is a hundred metres behind you and they are the road to it.' },
    br_aid:      { name: 'RAMC Section', nation: 'uk', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['ukramc', 'ukramc', 'ukramc'],
                   note: 'Stretcher-bearers of the Royal Army Medical Corps, attached from the field ambulance. Unarmed, and they go where the shooting is.' },
    sov_aid:     { name: 'Sanitarnoye Otdeleniye', nation: 'sov', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['sovsanin', 'sovsanin', 'sovsanin'],
                   note: 'Saninstruktors — half of them women, most of them decorated. Soviet practice sent them forward WITH the section rather than waiting behind it, which is why so few of them survived a war.' },
    it_aid:      { name: 'Sezione Sanità', nation: 'it', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['itportaf', 'itportaf', 'itportaf'],
                   note: 'Portaferiti of the Regio Esercito. The field hospital they are carrying him to is short of everything except patients.' },
    fr_aid:      { name: 'Équipe de Brancardiers', nation: 'fr', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['frbrancard', 'frbrancard', 'frbrancard'],
                   note: 'Brancardiers-secouristes, two to a stretcher. In 1940 they walked back through their own retreating army to reach the poste de secours.' },
    us_priest:   { name: 'M7 Priest Battery', nation: 'us', w: 0.7, rp: 15, cat: 'arty', from: 3, vet: 1,
                   men: ['m7priest'],
                   note: '105mm on a Sherman hull. It keeps up with the advance, which a towed gun does not.' },
    us_jumbo:    { name: 'M4A3E2 Jumbo', nation: 'us', w: 0.4, rp: 22, cat: 'armour', from: 6, vet: 2,
                   men: ['jumbo'],
                   note: 'A Sherman with a hundred millimetres of glacis, at the cost of everything that made a Sherman worth having. It leads.' },
    // ---- Round twenty: the American arms that were missing ----------------
    us_sherman76:{ name: 'Sherman 76 Section', nation: 'us', w: 1.6, rp: 20, cat: 'armour', from: 3, vet: 1,
                   men: ['sherman76', 'sherman76'],
                   note: 'The tanks the battalion keeps for the other side\u2019s tanks. Slower to load than the 75 and a worse shell against a house \u2014 but it will go through a Panzer IV at any range on this map.' },
    us_fo:       { name: 'Forward Observer Party', nation: 'us', w: 1.2, rp: 10, cat: 'command', from: 0, vet: 2,
                   men: ['usfo', 'ussmg', 'usrifle', 'usrifle'],
                   note: 'A lieutenant, a radio and two men to carry it. While he can see the target, the guns land where you asked and come again in a third of the time. He is not there to fight.' },
    us_105:      { name: '105mm Cannon Company', nation: 'us', w: 0.9, rp: 11, cat: 'arty', from: 1, vet: 1,
                   men: ['us105'],
                   note: 'The regiment\u2019s own howitzers, answering to the regiment. Not as heavy as divisional artillery and a great deal quicker to arrive.' },
    us_m12:      { name: 'M12 155mm GMC', nation: 'us', w: 0.35, rp: 19, cat: 'armour', from: 5, vet: 1,
                   men: ['m12gmc'],
                   note: 'A First World War siege gun driven up to a pillbox and fired at it over open sights. Ten rounds, no roof, and nothing else will knock a casemate down.' },
    us_jeep:     { name: 'Recon Jeep', nation: 'us', w: 1.4, rp: 4, cat: 'recon', from: 0, vet: 1,
                   men: ['usjeep'],
                   note: 'Fast, sees a long way, and dies to anything at all. Use it to find out what is over the hill, not to hold it.' },

    // ---------------- Britain & Canada ----------------
    br_section:  { name: 'Rifle Section', nation: 'uk', w: 6, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['uksten', 'ukbren', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle'],
                   note: 'Ten men: a corporal with a Sten, a Bren group of two, and the rifle group. The Bren is the section.' },
    br_commando: { name: 'Commando Troop', nation: 'uk', w: 0.8, rp: 15, cat: 'rifle', from: 1, vet: 2,
                   men: ['uksten', 'ukbren', 'ukcommando', 'ukcommando', 'ukcommando', 'ukcommando', 'ukcommando', 'ukcommando', 'ukcommando', 'ukcommando'],
                   note: 'A Commando section: ten men on the same Bren-and-rifle-group pattern as the line infantry, trained to get in close and be gone. Do not use them to hold a hedgerow.' },
    br_vickers:  { name: 'Vickers MMG Team', nation: 'uk', w: 2.4, rp: 9, cat: 'mg', from: 0, vet: 1,
                   men: ['ukvickers', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle'],
                   note: 'Water-cooled, tripod-mounted, belt-fed, and SIX men — gun, tripod, condenser and the belt boxes are four separate loads. It will fire all day on a fixed line and it will not move quickly.' },
    br_piat:     { name: 'PIAT Team', nation: 'uk', w: 3, rp: 5, cat: 'at', from: 0, vet: 1,
                   men: ['ukpiat', 'ukrifle'],
                   note: 'A spring-launched bomb from a hundred metres. Awful odds — and it will open a Tiger if it connects.' },
    br_mortar3:  { name: '3-inch Mortar Team', nation: 'uk', w: 2, rp: 9, cat: 'mortar', from: 0, vet: 1,
                   men: ['ukmortar3', 'ukrifle', 'ukrifle', 'ukrifle', 'ukrifle'],
                   note: 'A detachment of five: barrel, baseplate, bipod and two men on the bombs. Heavier bomb than an 81, and it does not need to see you.' },
    br_25pdr:    { name: 'QF 25-pounder', nation: 'uk', w: 1.2, rp: 12, cat: 'arty', from: 1, vet: 1,
                   men: ['qf25pdr'],
                   note: 'Gun and howitzer in one carriage — it will shell a village and then shoot at a tank over open sights.' },
    br_avre:     { name: 'Churchill AVRE', nation: 'uk', w: 0.4, rp: 20, cat: 'armour', from: 2, vet: 1,
                   men: ['avre'],
                   note: 'A 290mm petard throwing a 18 kg demolition charge forty metres. For strongpoints, and nothing else.' },
    // ---- Round twenty: the Commonwealth arms that were missing ------------
    br_daimler:  { name: 'Armoured Car Troop', nation: 'uk', w: 1.6, rp: 7, cat: 'recon', from: 0, vet: 2,
                   men: ['daimler', 'daimler'],
                   note: 'The armoured-car regiment worked miles ahead of the division, and its orders were to find the enemy and not to fight him. Sees a hundred and fifty metres, shoots sixty.' },
    br_wasp:     { name: 'Wasp Flame Carriers', nation: 'uk', w: 0.7, rp: 12, cat: 'armour', from: 2, vet: 1,
                   men: ['wasp', 'wasp'],
                   note: 'A Universal Carrier with a flame gun where the Bren went. The Canadians burned hedgerow positions out by the troop, from a range at which a man on foot would already be dead.' },
    br_kangaroo: { name: 'Kangaroo Troop', nation: 'uk', w: 0.8, rp: 11, cat: 'transport', from: 3, vet: 1,
                   men: ['kangaroo', 'kangaroo'],
                   note: 'Priests with the guns cut out, before TOTALIZE \u2014 the first armoured personnel carrier anybody built. It exists to cross the beaten zone with a section inside it.' },
    br_sexton:   { name: 'Sexton Battery', nation: 'uk', w: 0.8, rp: 15, cat: 'arty', from: 2, vet: 1,
                   men: ['sexton'],
                   note: 'The 25-pounder on a Ram hull: a field regiment that keeps up with the armour instead of coming into action behind it.' },
    br_crab:     { name: 'Sherman Crab', nation: 'uk', w: 0.4, rp: 17, cat: 'armour', from: 0, vet: 1,
                   men: ['crab'],
                   note: 'Flail tank. It beats a lane through a minefield at walking pace while everything shoots at it.' },
    br_sniper:   { name: 'Sniper Pair', nation: 'uk', w: 1, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['sniper', 'ukrifle'], note: 'Observer and shot. They will find the German officer before you do.' },
    br_carrier:  { name: 'Carrier Section', nation: 'uk', w: 1.6, rp: 6, cat: 'transport', from: 0, vet: 1,
                   men: ['carrier'], note: 'Universal Carrier — eyes, a Bren, and a way to get a mortar forward.' },
    br_cromwell: { name: 'Cromwell', nation: 'uk', w: 2.4, rp: 16, cat: 'armour', from: 1, vet: 1,
                   men: ['cromwell'], note: 'Fast, thin, and a gun that cannot answer a Panther. Use the speed.' },

    // ---------------- Germany ----------------
    ger_fjmg:    { name: 'Fallschirmjäger MG Trupp', nation: 'ger', w: 1.6, rp: 11, cat: 'mg', from: 2, vet: 2,
                   men: ['mg34', 'gerfj', 'gerfj', 'gerfj', 'gerfj'],
                   note: 'MG34 on the Lafette tripod with a proper five-man crew. On a fixed line it beats a whole company off a field.' },
    ger_ost:     { name: 'Ostbataillon', nation: 'ger', w: 5, rp: 5, cat: 'rifle', from: 0, vet: 0,
                   men: ['gerost', 'gerost', 'gerost', 'gerost', 'gerost', 'gerost', 'gerost', 'gerost', 'gerost'],
                   note: 'Soviet prisoners in German uniform, holding the coast because nobody better could be spared. Nine to a Gruppe, numerous, and they will not stand.' },
    ger_schreck: { name: 'Panzerschreck Team', nation: 'ger', w: 2.4, rp: 7, cat: 'at', from: 1, vet: 1,
                   men: ['schreck', 'gergren'],
                   note: 'The bazooka done properly: bigger warhead, a hundred and fifty metres, and a back-blast that shows everyone where you are.' },
    ger_flak38:  { name: '2cm Flak 38', nation: 'ger', w: 1.4, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['flak38'],
                   note: 'Meant for aircraft, used on infantry. It does not so much kill a section as remove it.' },
    ger_lefh:    { name: '10.5cm leFH 18', nation: 'ger', w: 1.4, rp: 13, cat: 'arty', from: 1, vet: 1,
                   men: ['lefh18'],
                   note: 'The German divisional field piece. Everything you have seen shelled was probably shelled by one of these.' },
    ger_sig33:   { name: '15cm sIG 33', nation: 'ger', w: 0.8, rp: 12, cat: 'arty', from: 2, vet: 1,
                   men: ['sig33'],
                   note: 'An infantry gun that throws a 38 kg shell four kilometres. It flattens a farmhouse in one round.' },
    ger_jagdpz4: { name: 'Jagdpanzer IV/70', nation: 'ger', w: 1.2, rp: 21, cat: 'armour', from: 5, vet: 1,
                   men: ['jagdpz4'],
                   note: 'The Panther gun in a low casemate. Nose-heavy, blind to the flanks, and lethal down a lane.' },
    ger_goliath: { name: 'Goliath Section', nation: 'ger', w: 0.6, rp: 6, cat: 'at', from: 2, vet: 1,
                   men: ['goliath', 'goliath', 'gerengineer'],
                   note: 'Two wire-guided demolition carriers and the pioneer driving them. Slow, fragile, and if one arrives there is nothing left of what it arrived at.' },
    // ---- Round twenty: the German company\u2019s own supporting arms --------
    ger_stummel: { name: 'Sd.Kfz. 251/9 Stummel', nation: 'ger', w: 1.0, rp: 13, cat: 'armour', from: 2, vet: 1,
                   men: ['stummel'],
                   note: 'The Panzergrenadier company\u2019s own gun, in the back of its own halftrack. It goes in WITH the assault group and puts a shell through whatever is holding it up.' },
    ger_leig:    { name: '7.5cm leIG 18', nation: 'ger', w: 1.2, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['leig18'],
                   note: 'Two of these were in every infantry company\u2019s heavy platoon, manhandled into the line and fired over open sights. Useless against armour, decisive against a house.' },
    ger_nashorn: { name: 'Nashorn', nation: 'ger', w: 0.5, rp: 21, cat: 'armour', from: 4, vet: 2,
                   men: ['nashorn'],
                   note: 'An 8.8cm PaK 43 in an open box of ten-millimetre plate. It will kill anything on the field at a range nothing on the field can answer, and a Bren gun will kill it. Keep it back.' },
    ger_sniper2: { name: 'Scharfsch\u00fctze', nation: 'ger', w: 1.0, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['gersniper', 'gergren'],
                   note: 'One man, a scoped K98k, and a great deal of patience. He shoots officers, gun crews and radio operators, in that order.' },

    // ---------------- The Red Army ----------------
    // The Eastern Front maps had four Soviet vehicles and no Soviet infantry.
    sov_rifle:   { name: 'Strelkovoye Otdeleniye', nation: 'sov', w: 6, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['sovppsh', 'sovdp28', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'Shtat 04/551: nine men — a sergeant with a PPSh, a DP-28 gunner with his loader, and six Mosins. The Degtyaryov is the squad’s whole base of fire and it was missing from this one.' },
    sov_smg:     { name: 'Avtomatchiki', nation: 'sov', w: 2.2, rp: 11, cat: 'rifle', from: 0, vet: 1,
                   men: ['sovppsh', 'sovppsh', 'sovppsh', 'sovppsh', 'sovppsh', 'sovppsh', 'sovppsh', 'sovppsh', 'sovppsh'],
                   note: 'The SMG platoon: nine men, seventy-one rounds a drum, and a doctrine that consists of getting inside fifty metres. They rode into the attack on the tanks.' },
    sov_maxim:   { name: 'Maxim Team', nation: 'sov', w: 2.4, rp: 8, cat: 'mg', from: 0, vet: 1,
                   men: ['maxim', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'A water-cooled gun of 1910 on a wheeled Sokolov mount, with the five men it takes to move it. Heavy beyond reason, and it will fire all day.' },
    sov_zis3:    { name: '76mm ZiS-3', nation: 'sov', w: 2.0, rp: 9, cat: 'atgun', from: 0, vet: 1,
                   men: ['zis3'],
                   note: 'Divisional gun, anti-tank gun and infantry gun on one carriage. More of them were built than any other artillery piece of the war.' },
    sov_su76:    { name: 'SU-76M', nation: 'sov', w: 2.0, rp: 12, cat: 'armour', from: 1, vet: 1,
                   men: ['su76'],
                   note: 'Open-topped, thin, and its crews had an unprintable name for it. Used exactly as the manual said \u2014 with the infantry, against machine guns, never against tanks.' },
    sov_t34:     { name: 'T-34-85 Troika', nation: 'sov', w: 1.4, rp: 20, cat: 'armour', from: 2, vet: 1,
                   men: ['t3485'],
                   note: 'Sloped, fast, and finally with a gun that answers a Panther. The tank the whole design of the war argued with.' },

    // ---------------- The Red Army, the rest of it ----------------
    // Six templates was a token Red Army: no command squad, no engineers, no
    // anti-tank rifle, no heavy tank, nothing to call fire with. A campaign
    // fought from the Soviet side needs an order of battle, not a sample.
    sov_hq:      { name: 'Rota Command', nation: 'sov', w: 1, rp: 6, cat: 'command', from: 0, vet: 1,
                   men: ['sovofficer', 'sovppsh', 'sovrifle', 'sovsanin'],
                   note: 'The company commander, the politruk who stands beside him, and the saninstruktor. Between them they hold a line together that has every reason to come apart.' },
    sov_guards:  { name: 'Guards Otdeleniye', nation: 'sov', w: 1.8, rp: 13, cat: 'rifle', from: 2, vet: 2,
                   men: ['sovppsh', 'sovppsh', 'sovdp28', 'sovdp28', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'Gvardeyskiy: a title a division earned by surviving something, and it came with a second DP and men who had already done this. They are why the Guards armies led every breakthrough from Stalingrad on.' },
    sov_penal:   { name: 'Shtrafnaya Rota', nation: 'sov', w: 1.4, rp: 5, cat: 'rifle', from: 0, vet: 0,
                   men: ['sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'A penal company: officers under sentence and men off the sentence lists, sent at the thing nobody else would be sent at. Cheap, and the cheapness is the point being made.' },
    sov_sapper:  { name: 'Sapyory', nation: 'sov', w: 1.2, rp: 11, cat: 'rifle', from: 0, vet: 1,
                   men: ['sovsapper', 'sovsapper', 'sovsapper', 'sovppsh', 'sovrifle', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'Assault engineers. They carried the charges that went under the wire, into the bunker embrasure and against the wall of the house, and in the cities they led.' },
    sov_ptrd:    { name: 'PTRD Team', nation: 'sov', w: 2.0, rp: 6, cat: 'at', from: 0, vet: 1,
                   men: ['sovptrd', 'sovrifle', 'sovrifle'],
                   note: 'Fourteen and a half millimetres of anti-tank rifle, two metres long, fired lying down at the side of a tank from a range that requires it to have driven past you first. It will not kill a Tiger and it will blind one.' },
    sov_mortar:  { name: '82mm Mortar Team', nation: 'sov', w: 2.4, rp: 7, cat: 'mortar', from: 0, vet: 1,
                   men: ['sovmortar', 'sovrifle', 'sovrifle', 'sovrifle'],
                   note: 'The battalion mortar, and there were more of them per rifle battalion than in any other army. Soviet fire planning was mortar fire planning.' },
    sov_sniper:  { name: 'Snayper Pair', nation: 'sov', w: 1.0, rp: 6, cat: 'recon', from: 0, vet: 2,
                   men: ['sovsniper', 'sovrifle'],
                   note: 'A shooter and a spotter, trained at a school that produced them by the thousand and sent women through it on the same terms. In the ruins they were the whole defence some days.' },
    sov_scout:   { name: 'Razvedchiki', nation: 'sov', w: 1.6, rp: 8, cat: 'recon', from: 0, vet: 2,
                   men: ['sovppsh', 'sovppsh', 'sovppsh', 'sovsniper'],
                   note: 'Divisional reconnaissance: four men in white or in mud, sent out at night to come back with a prisoner. They fight only when the alternative is being taken themselves.' },
    sov_45mm:    { name: '45mm M-42', nation: 'sov', w: 2.2, rp: 7, cat: 'atgun', from: 0, vet: 1,
                   men: ['sov45mm'],
                   note: 'The regimental anti-tank gun, low enough to hide behind a fold in the ground and light enough for the crew to move it without a tractor. Against a Panther it is a way of giving your position away.' },
    sov_t3476:   { name: 'T-34/76', nation: 'sov', w: 2.2, rp: 16, cat: 'armour', from: 0, vet: 1,
                   men: ['t3476'],
                   note: 'The tank that made 1941 a shock: sloped plate nothing in the German inventory could beat and a diesel that ran in the cold. Two men in the turret, and the commander is one of them — which is the whole reason it lost gunfights it should have won.' },
    sov_kv1:     { name: 'KV-1', nation: 'sov', w: 1.2, rp: 22, cat: 'armour', from: 0, vet: 1,
                   men: ['kv1'],
                   note: 'Forty-five tonnes of heavy tank that in 1941 simply could not be penetrated, and was blind, slow and mechanically wretched. One of them held up a whole division at Raseiniai for a day.' },
    sov_is2:     { name: 'IS-2', nation: 'sov', w: 1.0, rp: 30, cat: 'armour', from: 5, vet: 2,
                   men: ['is2'],
                   note: 'A hundred and twenty-two millimetres firing a separate-loading round at three a minute, on plate a Panther cannot beat frontally. A breakthrough tank, issued to Guards heavy regiments and used against buildings as often as against tanks.' },
    sov_su100:   { name: 'SU-100', nation: 'sov', w: 1.2, rp: 26, cat: 'armour', from: 5, vet: 1,
                   men: ['su100'],
                   note: 'A hundred millimetres of naval gun in a low casemate. It will kill anything the Germans put in front of it at any range it can see, and it cannot traverse.' },
    sov_isu152:  { name: 'ISU-152', nation: 'sov', w: 1.0, rp: 28, cat: 'armour', from: 3, vet: 1,
                   men: ['isu152'],
                   note: 'Zveroboy — the beast-killer. A gun-howitzer firing a forty-three kilogram shell that does not need to penetrate a Tiger to finish it. Twenty rounds, and two men to load each one.' },
    sov_katyusha:{ name: 'BM-13 Battery', nation: 'sov', w: 1.0, rp: 24, cat: 'arty', from: 1, vet: 1,
                   men: ['katyusha'],
                   note: 'Sixteen rails on a Studebaker. Ten seconds of the most frightening noise on the Eastern Front, then it drives away, because everything within two kilometres now knows where it was.' },

    // ---------------- Regio Esercito ----------------
    // Italy fought the desert and then, after September 1943, both sides of
    // its own peninsula. The equipment is genuinely poor and priced that way;
    // the Bersaglieri and the guastatori were not.
    it_hq:       { name: 'Comando di Compagnia', nation: 'it', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['itofficer', 'itfante', 'itportaf'],
                   note: 'An officer of an army that was sent to fight a modern war with the equipment of the last one, and knew it. The portaferiti carries no weapon at all.' },
    it_fante:    { name: 'Squadra Fucilieri', nation: 'it', w: 6, rp: 7, cat: 'rifle', from: 0, vet: 1,
                   men: ['itbreda30', 'itfante', 'itfante', 'itfante', 'itfante', 'itfante', 'itfante', 'itfante'],
                   note: 'Eight men round a Breda 30 — a light machine gun fed from a fixed magazine that had to be charged with a stripper clip, oiled the cartridges to make them feed, and jammed on desert sand doing it. The rifles are Carcanos of 1891.' },
    it_bersag:   { name: 'Squadra Bersaglieri', nation: 'it', w: 2.2, rp: 10, cat: 'rifle', from: 0, vet: 2,
                   men: ['itbersag', 'itbersag', 'itbreda30', 'itfante', 'itfante', 'itfante', 'itfante', 'itfante'],
                   note: 'The assault infantry, in the cockerel feathers they wore into battle and at the running pace they did everything at. At Takrouna and on the Don they fought long after the formations beside them had gone.' },
    it_breda37:  { name: 'Breda 37 Team', nation: 'it', w: 2.6, rp: 7, cat: 'mg', from: 0, vet: 1,
                   men: ['itbreda37', 'itfante', 'itfante', 'itfante'],
                   note: 'Eight millimetres, twenty-round strips, and a solid gun on a solid tripod — the one Italian infantry weapon nobody complained about.' },
    it_cannone47:{ name: 'Cannone da 47/32', nation: 'it', w: 2.2, rp: 7, cat: 'atgun', from: 0, vet: 1,
                   men: ['itcannone47'],
                   note: 'A Böhler-licence gun that will hole a Stuart or a Crusader and nothing newer. Light enough to be manhandled into a wadi, which is where it belongs.' },
    it_m1340:    { name: 'Carro M13/40', nation: 'it', w: 2.0, rp: 12, cat: 'armour', from: 0, vet: 1,
                   men: ['itm1340'],
                   note: 'Riveted, underpowered and thirty millimetres thick at its best. Its crews called them scatolette di sardine — sardine tins — and went on attacking with them anyway.' },
    it_semovente:{ name: 'Semovente 75/18', nation: 'it', w: 1.6, rp: 16, cat: 'armour', from: 1, vet: 1,
                   men: ['itsemovente'],
                   note: 'The one good armoured vehicle Italy built: a 75 mm howitzer in a low casemate on the M13 hull, firing an effective hollow-charge round. Used properly it killed Grants.' },

    // ---------------- Japan (round 114) ----------------
    // Its men have fought on the maps since the four-team round and it had no
    // template, so the battle setup could not offer it: "every Axis army" was
    // two. No campaign's `nationsOf` lists 'jp', and `templatesFor` reads 'us',
    // 'uk' and 'ger' by name, so no requisition list changes.
    jp_hq:       { name: 'Chūtai Honbu', nation: 'jp', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['jpofficer', 'jprifle', 'jprifle', 'jpeisei'],
                   note: 'The company commander with his sword, two runners and an aid man. Orders went by runner and by whistle; a radio at this level was a rarity.' },
    jp_aid:      { name: 'Eiseihei Team', nation: 'jp', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['jpeisei', 'jpeisei', 'jpeisei'],
                   note: 'Stretcher men and medical orderlies, in an army whose doctrine gave them far less to work with than any they faced.' },
    jp_rifle:    { name: 'Hohei Buntai', nation: 'jp', w: 6, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['jprifle', 'jptype99', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle'],
                   note: 'Thirteen men round one light machine gun, trained to close with the bayonet at ranges other armies would have called too short.' },
    jp_snlf:     { name: 'Rikusentai Buntai', nation: 'jp', w: 1.4, rp: 12, cat: 'rifle', from: 0, vet: 2,
                   men: ['jpsnlf', 'jptype99', 'jpsnlf', 'jpsnlf', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle', 'jprifle'],
                   note: 'The naval landing force: fewer men, better fed, and more automatic weapons than the army squad beside them.' },
    jp_type92:   { name: 'Type 92 HMG Team', nation: 'jp', w: 2.6, rp: 8, cat: 'mg', from: 0, vet: 1,
                   men: ['jptype92', 'jprifle', 'jprifle', 'jprifle'],
                   note: 'A slow, heavy, strip-fed gun that its enemies called the woodpecker for its sound, carried on poles between two men.' },
    jp_knee:     { name: 'Type 89 Discharger', nation: 'jp', w: 2.4, rp: 6, cat: 'mortar', from: 0, vet: 1,
                   men: ['jpknee', 'jprifle', 'jprifle', 'jprifle'],
                   note: 'The so-called knee mortar, fired with its curved base plate on the ground: a light tube at platoon level, and the reason a Japanese platoon could drop shells on you at all.' },
    jp_lunge:    { name: 'Lunge Mine Team', nation: 'jp', w: 1, rp: 5, cat: 'at', from: 0, vet: 1,
                   men: ['jplunge', 'jplunge', 'jplunge'],
                   note: 'A hollow charge on a bamboo pole, thrust at the hull. What an army issues when it has no bazooka, and the man who used it did not expect to walk away.' },
    jp_type1at:  { name: 'Type 1 47mm', nation: 'jp', w: 2, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['jptype1at'],
                   note: 'The best Japanese anti-tank gun of the war, and there were never enough. It will hole a Sherman from the side at short range.' },
    jp_chiha:    { name: 'Type 97 Chi-Ha', nation: 'jp', w: 2.4, rp: 12, cat: 'armour', from: 0, vet: 1,
                   men: ['jpchiha'],
                   note: 'Built to support infantry against infantry, with a short gun and thin riveted plate. Against anything that shoots back with armour-piercing it is a target.' },
    jp_shinhoto: { name: 'Shinhoto Chi-Ha', nation: 'jp', w: 1.4, rp: 14, cat: 'armour', from: 0, vet: 1,
                   men: ['jpshinhoto'],
                   note: 'The Chi-Ha with a new turret and a long 47 mm gun: the answer to the Stuart that arrived in time to meet the Sherman.' },

    // ---------------- France, 1940 — and after ----------------
    // Better tanks than the Wehrmacht and no idea what to do with them. The
    // equipment here is not the reason 1940 went the way it did, and the
    // campaign is written so the player can find that out.
    fr_hq:       { name: 'Chef de Section', nation: 'fr', w: 1, rp: 5, cat: 'command', from: 0, vet: 1,
                   men: ['frofficer', 'frrifle', 'frbrancard'],
                   note: 'A section commander of an army whose orders arrive by motorcycle courier because its tanks have no radios, and the brancardier who will carry him back.' },
    fr_groupe:   { name: 'Groupe de Combat', nation: 'fr', w: 6, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['frfm2429', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle', 'frrifle'],
                   note: 'Twelve men in two halves: the équipe de feu round the FM 24/29 and the équipe de choc that closes. The FM is an excellent weapon and the doctrine round it is the one from 1918.' },
    fr_hotch:    { name: 'Hotchkiss M1914', nation: 'fr', w: 2.6, rp: 8, cat: 'mg', from: 0, vet: 1,
                   men: ['frhotch', 'frrifle', 'frrifle', 'frrifle'],
                   note: 'Gas-operated, air-cooled, fed from thirty-round strips, and unchanged since Verdun because it did not need changing. In a casemate it will hold a road all day.' },
    fr_canon25:  { name: 'Canon de 25 SA-L', nation: 'fr', w: 2.4, rp: 6, cat: 'atgun', from: 0, vet: 1,
                   men: ['frcanon25'],
                   note: 'A 25 mm anti-tank gun on a carriage light enough for six men to lift, with a flat trajectory and a shell that will go through any German tank of 1940 at the ranges it was sited for.' },
    fr_canon47:  { name: 'Canon de 47 APX', nation: 'fr', w: 1.6, rp: 10, cat: 'atgun', from: 0, vet: 1,
                   men: ['frcanon47'],
                   note: 'The best anti-tank gun in service anywhere in 1940 and there were not enough of them. It will beat the front of anything the Panzerwaffe owns.' },
    fr_h39:      { name: 'Hotchkiss H39', nation: 'fr', w: 2.2, rp: 12, cat: 'armour', from: 0, vet: 1,
                   men: ['frh39'],
                   note: 'A cavalry tank with forty millimetres of cast armour and a one-man turret, so the commander lays, loads, fires and commands. It is proof against every German anti-tank gun and it cannot fight.' },
    fr_somua:    { name: 'Somua S35', nation: 'fr', w: 1.6, rp: 18, cat: 'armour', from: 0, vet: 1,
                   men: ['frsomua'],
                   note: 'Forty-seven millimetres of gun, forty-one of sloped cast armour and a road speed of forty. On paper the best tank in France in 1940; in practice its commander is still alone in the turret and the radio is not fitted.' },
    fr_b1bis:    { name: 'Char B1 bis', nation: 'fr', w: 1.0, rp: 26, cat: 'armour', from: 0, vet: 1,
                   men: ['frb1bis'],
                   note: 'Sixty millimetres all round, a 75 in the hull and a 47 in the turret, and at Stonne one of them — Eure — took a hundred and forty hits and drove home. It runs out of fuel in six hours and the driver aims the hull gun by steering.' },
    fr_maquis:   { name: 'Groupe Maquis', nation: 'fr', w: 1.8, rp: 6, cat: 'rifle', from: 0, vet: 1,
                   men: ['frmaquis', 'frmaquis', 'frmaquis', 'frmaquis', 'frmaquis', 'frmaquis'],
                   note: 'Sten guns dropped by parachute, a Bren if they are lucky, and ground they have lived on all their lives. They will not hold anything and they know where everything is.' },

    // ---------------- Wehrmacht: the early war and the east ----------------
    ger_pz3:     { name: 'Panzer III', nation: 'ger', w: 2.2, rp: 14, cat: 'armour', from: 0, vet: 1,
                   men: ['panzer3'],
                   note: 'The tank the Panzer divisions were actually built around: a three-man turret, a commander who only commands, and a radio in every one. Outgunned by 1942 and still winning fights the paper says it should lose.' },
    ger_pak38:   { name: '5cm PaK 38', nation: 'ger', w: 2.2, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['gerpak38'],
                   note: 'The gun that had to answer the T-34 with tungsten it did not have enough of. Low, quick to lay, and dead the moment it is seen.' },
    ger_pak43:   { name: '8.8cm PaK 43', nation: 'ger', w: 1.0, rp: 18, cat: 'atgun', from: 5, vet: 2,
                   men: ['pak43'],
                   note: 'Not the Flak 88 on a pedestal — the purpose-built anti-tank version on a cruciform carriage, firing a longer round with a shield low enough to hide. It kills anything at any range on any map here.' },
    ger_brummbar:{ name: 'Sturmpanzer IV', nation: 'ger', w: 1.0, rp: 24, cat: 'armour', from: 4, vet: 1,
                   men: ['brummbar'],
                   note: 'A 15 cm infantry howitzer in a hundred millimetres of casemate, built for exactly one job: driving up to a building somebody is holding and removing the building.' },
    ger_gebirg:  { name: 'Gebirgsjäger Gruppe', nation: 'ger', w: 1.6, rp: 12, cat: 'rifle', from: 0, vet: 2,
                   men: ['gergebirg', 'gergebirg', 'mg42', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren', 'gergren'],
                   note: 'Mountain troops, and the only German infantry that routinely fought above the snow line. In Italy they held ground that on the map has no approach to it.' },
    ger_222:     { name: 'Sd.Kfz. 222', nation: 'ger', w: 1.6, rp: 9, cat: 'recon', from: 0, vet: 1,
                   men: ['sdkfz222'],
                   note: 'A four-wheeled armoured car with a 2 cm cannon and a wire basket over the open turret to keep grenades out. It is there to find the enemy and drive away from him.' },
    ger_stg:     { name: 'Sturmgruppe StG 44', nation: 'ger', w: 1.4, rp: 15, cat: 'rifle', from: 6, vet: 2,
                   men: ['gerstg44', 'gerstg44', 'gerstg44', 'gerstg44', 'mg42', 'gergren', 'gergren', 'gergren'],
                   note: 'The first assault rifle, issued first to the units most likely to need it. Four of them in a Gruppe change what the Gruppe can do inside two hundred metres, which is where this war is fought.' },

    // ---------------- US Army & Marines: the rest ----------------
    us_marine:   { name: 'USMC Rifle Squad', nation: 'us', w: 1.6, rp: 12, cat: 'rifle', from: 0, vet: 2,
                   men: ['usmarine', 'usmarine', 'usbar', 'usbar', 'usbar', 'usmarine', 'usmarine', 'usmarine', 'usmarine', 'usmarine', 'usmarine', 'usmarine'],
                   note: 'Thirteen men in three fire teams, each with its own BAR — the organisation the Marines arrived at in the Pacific and the Army never adopted. Three bases of fire in one squad.' },
    us_zippo:    { name: 'M4A3R3 Zippo', nation: 'us', w: 1.0, rp: 20, cat: 'armour', from: 4, vet: 1,
                   men: ['uszippo'],
                   note: 'A Sherman with the bow gun replaced by a flame projector and a hundred and fifty gallons behind it. Against a bunker it is the only thing that reliably works.' },
    us_sherman105:{ name: 'M4 (105mm)', nation: 'us', w: 1.4, rp: 20, cat: 'armour', from: 3, vet: 1,
                   men: ['sherman105'],
                   note: 'The assault-gun Sherman: a 105 mm howitzer instead of the 75, two per medium company, for the pillbox and the house and the hedgerow corner that the 75 will not shift.' },
    us_m3lee:    { name: 'M3 Lee', nation: 'us', w: 1.6, rp: 14, cat: 'armour', from: 0, vet: 1,
                   men: ['m3lee'],
                   note: 'A 75 in a hull sponson because nobody could yet build a turret ring big enough, three metres tall, riveted, and in 1942 the first Allied tank in the desert that could fire a decent high-explosive shell. The crews were fond of it and embarrassed by it.' },
    us_37mm:     { name: '37mm Gun M3', nation: 'us', w: 2.0, rp: 5, cat: 'atgun', from: 0, vet: 1,
                   men: ['us37mm'],
                   note: 'The pre-war anti-tank gun, obsolete against anything with armour by 1942 and kept because its canister round is murder on infantry at short range.' },
    // >>> round 115 roster (tools/roster_r115.py writes these rows from tools/roster_r115_spec.py: edit the spec, not them)
    us_m4a3e8:     { name: 'M4A3E8 Sherman', nation: 'us', w: 1, rp: 17, cat: 'armour', from: 99, vet: 1,
                   men: ['usm4a3e8'], note: 'The 76 mm Sherman on horizontal volute springs and a 23-inch track: the "Easy Eight" of the winter of 1944, with wet stowage, so it burned far less often than the Shermans before it.' },
    us_m24:        { name: 'M24 Chaffee', nation: 'us', w: 1, rp: 12, cat: 'recon', from: 99, vet: 1,
                   men: ['usm24'], note: 'A light tank at last with a real gun: the 75 mm of the Sherman in a lighter barrel, on a fast, low, well-sloped hull. First in action in the Ardennes. Its armour is still a light tank\'s.' },
    us_m36:        { name: 'M36 Jackson', nation: 'us', w: 0.8, rp: 16, cat: 'armour', from: 99, vet: 1,
                   men: ['usm36'], note: 'The 90 mm on an M10\'s hull in an open turret: the only American tank destroyer that could meet a Panther from the front, from the autumn of 1944. Open on top, like every one of them.' },
    us_m8hmc:      { name: 'M8 HMC', nation: 'us', w: 0.8, rp: 10, cat: 'armour', from: 0, vet: 1,
                   men: ['usm8hmc'], note: 'The pack howitzer in an open turret on a Stuart: the assault-gun troop of a cavalry squadron, for the machine gun nest the armoured cars cannot shift.' },
    us_m3gmc:      { name: 'M3 GMC', nation: 'us', w: 0.6, rp: 9, cat: 'armour', from: 99, vet: 1,
                   men: ['usm3gmc'], note: 'The French 75 of 1897 on a half-track, behind a shield: the tank destroyer battalions\' gun in Tunisia, and the Marines\' on Saipan. Quick, hard-hitting, and quarter-inch plate.' },
    us_m15:        { name: 'M15A1 MGMC', nation: 'us', w: 0.5, rp: 9, cat: 'armour', from: 0, vet: 1,
                   men: ['usm15'], note: 'A 37 mm automatic cannon between two .50s on one mount, built to shoot at aircraft. There were few aircraft by 1944, and it was turned on houses and hedgerows instead.' },
    us_m3a1sc:     { name: 'M3A1 Scout Car', nation: 'us', w: 1, rp: 6, cat: 'recon', from: 0, vet: 1,
                   men: ['usm3a1sc'], note: 'The White scout car: an open armoured body on four driven wheels, a .50 and a .30 on the rail round its top, and eight men. Fast on a road and helpless off it.' },
    us_m20:        { name: 'M20 Utility Car', nation: 'us', w: 0.8, rp: 6, cat: 'recon', from: 0, vet: 1,
                   men: ['usm20'], note: 'A Greyhound with the turret taken off and a .50 on a ring in its place: the troop leader\'s car, the radio car, the ammunition runner. Six wheels and seventy-five kilometres an hour.' },
    us_lvta4:      { name: 'LVT(A)-4', nation: 'us', w: 0.6, rp: 12, cat: 'armour', from: 99, vet: 1,
                   men: ['uslvta4'], note: 'The amtank: a howitzer turret on an amphibian, swimming in ahead of the first wave and fighting up the beach. Its hull is boat plate, and its tracks are its paddles.' },
    us_t26e4:      { name: 'T26E4 Super Pershing (prototype)', nation: 'us', w: 0.2, rp: 22, cat: 'armour', from: 99, vet: 2,
                   men: ['ust26e4'], note: 'One Pershing with a 73-calibre 90 mm, sent to the 3rd Armored Division to answer the Tiger II; its crew welded boiler plate over the mantlet. It killed a tank at Grevenbroich in April 1945.' },
    us_calliope:   { name: 'M4 Calliope (T34)', nation: 'us', w: 0.4, rp: 14, cat: 'arty', from: 8, vet: 1,
                   men: ['uscalliope'], note: 'Sixty 4.5-inch rockets in a frame over a Sherman\'s turret, laid by the 75 and gone in a few seconds. The tank kept its gun; the frame could be dropped with the crew inside.' },
    br_matilda:    { name: 'Matilda II', nation: 'uk', w: 1, rp: 13, cat: 'armour', from: 99, vet: 1,
                   men: ['ukmatilda'], note: 'Seventy-eight millimetres of cast armour that no German anti-tank gun of 1940 could pierce: at Arras it stopped Rommel cold, and in the desert it was the Queen until the 88 came. The 2-pounder fires no high explosive.' },
    br_valentine:  { name: 'Valentine IX', nation: 'uk', w: 1.2, rp: 11, cat: 'armour', from: 99, vet: 1,
                   men: ['ukvalentine'], note: 'Vickers\' small infantry tank, the most numerous British tank of the war: reliable, well armoured, slow. The 6-pounder filled the two-man turret so full there was no room for a machine gun.' },
    br_archer:     { name: 'Archer', nation: 'uk', w: 0.8, rp: 13, cat: 'armour', from: 99, vet: 1,
                   men: ['ukarcher'], note: 'A 17-pounder on a Valentine, pointing backwards over the engine: reversed into a hide, one shot, and away forwards. Low enough to hide behind a hedge, which was the whole idea.' },
    br_bishop:     { name: 'Bishop', nation: 'uk', w: 0.5, rp: 11, cat: 'arty', from: 99, vet: 1,
                   men: ['ukbishop'], note: 'A 25-pounder in a tall steel box on a Valentine. The box held its elevation to fifteen degrees, so it reached barely six kilometres; crews dug ramps to tilt it. The Sexton replaced it gladly.' },
    br_crusader:   { name: 'Crusader III', nation: 'uk', w: 1.2, rp: 11, cat: 'armour', from: 99, vet: 1,
                   men: ['ukcrusader'], note: 'Fast, low, handsome and unreliable: the cruiser of the desert. The Mk III\'s 6-pounder could at last fight a Panzer III, and it went into battle at El Alamein; its Liberty engine burned easily.' },
    br_tetrarch:   { name: 'Tetrarch', nation: 'uk', w: 0.5, rp: 8, cat: 'recon', from: 0, vet: 1,
                   men: ['uktetrarch'], note: 'The tank that flew: carried to Normandy by Hamilcar glider on the night of D-Day with the 6th Airborne Division\'s reconnaissance regiment. It steered by bending its tracks round four big wheels.' },
    br_locust:     { name: 'Locust', nation: 'uk', w: 0.4, rp: 8, cat: 'recon', from: 99, vet: 1,
                   men: ['uklocust'], note: 'The American airborne tank, which only the British took to war: eight crossed the Rhine by glider in Operation Varsity. The Littlejohn adaptor on its 37 mm squeezed the shot to a higher velocity.' },
    br_comet:      { name: 'Comet I', nation: 'uk', w: 1, rp: 18, cat: 'armour', from: 99, vet: 1,
                   men: ['ukcomet'], note: 'The best British tank of the war: the Cromwell made strong, with the 77 mm HV, a short 17-pounder that fired its own case. The 11th Armoured Division had it across the Rhine in March 1945.' },
    br_challenger: { name: 'Challenger', nation: 'uk', w: 0.6, rp: 16, cat: 'armour', from: 6, vet: 1,
                   men: ['ukchallenger'], note: 'A Cromwell stretched by a road wheel to carry the 17-pounder in a turret like a garden shed: the Cromwell regiments\' answer to the Firefly, two to a troop from the summer of 1944.' },
    br_centaur:    { name: 'Centaur IV (95 mm)', nation: 'uk', w: 0.5, rp: 14, cat: 'armour', from: 0, vet: 1,
                   men: ['ukcentaur'], note: 'The Royal Marines Armoured Support Group\'s close-support tank on D-Day: a 95 mm howitzer, meant to fire from its landing craft and then off the beach, a white bearing scale painted round its turret.' },
    br_churchill3: { name: 'Churchill III', nation: 'uk', w: 0.8, rp: 15, cat: 'armour', from: 99, vet: 1,
                   men: ['ukchurchill3'], note: 'The first Churchill with a gun worth having, the 6-pounder in a welded turret. At Longstop Hill in April 1943 they climbed slopes the Germans thought no tank could, and took it.' },
    br_humber:     { name: 'Humber Mk IV', nation: 'uk', w: 1, rp: 7, cat: 'recon', from: 0, vet: 2,
                   men: ['ukhumber'], note: 'The commonest British armoured car, with the American 37 mm: the divisional reconnaissance regiments\' car, whose orders were to find the enemy and report, not to fight him.' },
    br_staghound:  { name: 'Staghound', nation: 'uk', w: 0.8, rp: 8, cat: 'recon', from: 0, vet: 2,
                   men: ['ukstaghound'], note: 'Built by Chevrolet for the British and never used by the Americans: a big, comfortable, reliable armoured car with two engines and an automatic gearbox. The Commonwealth\'s armoured car regiments in Italy and the North-West.' },
    br_dingo:      { name: 'Daimler Dingo', nation: 'uk', w: 1, rp: 5, cat: 'recon', from: 0, vet: 1,
                   men: ['ukdingo'], note: 'The two-man scout car, as good as any of its kind: it could reverse as fast as it went forward, which is the first thing a scout needs. A Bren and thirty millimetres of plate in front.' },
    fr_r35:        { name: 'Renault R35', nation: 'fr', w: 1.6, rp: 7, cat: 'armour', from: 99, vet: 1,
                   men: ['frr35'], note: 'The infantry\'s tank, nine hundred of them in 1940: forty millimetres of cast armour and the short 37 of the Great War, one man in the turret to command, load and fire it. It kept pace with a walking man, and was meant to.' },
    fr_h35:        { name: 'Hotchkiss H35', nation: 'fr', w: 1.2, rp: 7, cat: 'armour', from: 99, vet: 1,
                   men: ['frh35'], note: 'The cavalry\'s light tank before the H39, with the old short 37: good against infantry, useless against a Panzer IV. The light mechanised divisions had it at Hannut.' },
    fr_fcm36:      { name: 'FCM 36', nation: 'fr', w: 0.8, rp: 8, cat: 'armour', from: 99, vet: 1,
                   men: ['frfcm36'], note: 'Welded, sloped all over and diesel-powered — the most modern tank in France, and the dearest, so a hundred were built. Both battalions went into the counter-attack at Sedan and did not come back.' },
    fr_amr35:      { name: 'AMR 35', nation: 'fr', w: 1, rp: 5, cat: 'recon', from: 99, vet: 1,
                   men: ['framr35'], note: 'The cavalry\'s reconnaissance machine-gun tank: fast, small, thirteen millimetres thick. It carries a 7.5 mm Reibel and nothing that can hurt a tank.' },
    fr_d2:         { name: 'Char D2', nation: 'fr', w: 0.5, rp: 11, cat: 'armour', from: 99, vet: 1,
                   men: ['frd2'], note: 'Renault\'s medium infantry tank: fifty built, and de Gaulle commanded them in the 507e RCC before the war. Re-armed with the 47 SA 35 in the B1\'s turret; the 19e BCC fought them at Abbeville.' },
    fr_panhard:    { name: 'Panhard 178', nation: 'fr', w: 1, rp: 7, cat: 'recon', from: 99, vet: 1,
                   men: ['frpanhard'], note: 'The best armoured car in the world in 1940: four-wheel drive, a driving position at each end, and a 25 mm that would hole any German light tank. The Germans took every one they could find.' },
    fr_laffly:     { name: 'Laffly W15 TCC', nation: 'fr', w: 0.5, rp: 8, cat: 'armour', from: 99, vet: 1,
                   men: ['frlaffly'], note: 'The best French anti-tank gun on the back of a Laffly lorry, facing over the tailboard behind its shield: a "tank hunter" improvised in the spring of 1940, seventy built, all of them in the battle.' },
    fr_ue:         { name: 'Renault UE', nation: 'fr', w: 0.8, rp: 4, cat: 'transport', from: 99, vet: 1,
                   men: ['frue'], note: 'The infantry\'s little tracked carrier: five thousand built, towing the 25 mm and carrying the battalion\'s ammunition forward under fire. Two men under two domed hoods, and a bin behind.' },
    fr_m4a2:       { name: 'M4A2 Sherman (2e DB)', nation: 'fr', w: 1.4, rp: 15, cat: 'armour', from: 99, vet: 2,
                   men: ['frm4a2'], note: 'Leclerc\'s division: the diesel M4A2, crewed by Frenchmen who had come from Chad, the Levant and Spain, landed at Utah in August 1944 and were in Paris on the 25th. Each tank carries a French name.' },
    fr_m10:        { name: 'M10 (RBFM)', nation: 'fr', w: 0.8, rp: 14, cat: 'armour', from: 99, vet: 2,
                   men: ['frm10'], note: 'The Régiment blindé de fusiliers-marins: sailors in tank destroyers, the 2e DB\'s anti-tank regiment. Their M10s were named after storms and ships.' },
    fr_m8:         { name: 'M8 Greyhound (2e DB)', nation: 'fr', w: 1, rp: 7, cat: 'recon', from: 99, vet: 2,
                   men: ['frm8'], note: 'The 1er Régiment de marche de spahis marocains: colonial cavalry in American armoured cars, the 2e DB\'s eyes on the road to Paris.' },
    fr_m5a1:       { name: 'M5A1 Stuart (2e DB)', nation: 'fr', w: 0.8, rp: 8, cat: 'armour', from: 99, vet: 2,
                   men: ['frm5a1'], note: 'The light tank squadrons of the 2e DB\'s armoured regiments, the 501e RCC and the 12e Cuirassiers among them: fast, reliable, and out-gunned by anything German.' },
    fr_halftrack:  { name: 'M3 Half-track (RMT)', nation: 'fr', w: 1.2, rp: 8, cat: 'transport', from: 99, vet: 2,
                   men: ['frhalftrack'], note: 'The Régiment de marche du Tchad\'s half-tracks: the 9th Company, the "Nueve", Spanish Republicans, were the first into Paris on the night of 24 August 1944.' },
    fr_m8hmc:      { name: 'M8 HMC (2e DB)', nation: 'fr', w: 0.6, rp: 10, cat: 'armour', from: 99, vet: 2,
                   men: ['frm8hmc'], note: 'The 2e DB\'s assault guns, with the armoured regiments\' headquarters squadrons: the pack howitzer in an open turret on a Stuart.' },
    br_sherman:    { name: 'Sherman III', nation: 'uk', w: 1.6, rp: 14, cat: 'armour', from: 0, vet: 1,
                   men: ['uksherman'], note: 'The commonest tank in the British and Commonwealth armoured regiments from El Alamein on: the diesel Sherman III and its sisters, three to a troop with the Firefly. The Guards drove them up Hell\'s Highway.' },
    br_stuart:     { name: 'Stuart VI', nation: 'uk', w: 1, rp: 8, cat: 'recon', from: 0, vet: 1,
                   men: ['ukstuart'], note: 'The "Honey" of the desert grown up: the M5A1 in the reconnaissance troops of British armoured regiments, fast and quiet and lightly armed.' },
    br_m10:        { name: 'M10 3-inch SP', nation: 'uk', w: 0.8, rp: 13, cat: 'armour', from: 0, vet: 1,
                   men: ['ukm10'], note: 'The Royal Artillery\'s anti-tank regiments took the M10 with its American 3-inch gun before the 17-pounder conversion, the Achilles, replaced it; both served side by side in Normandy.' },
    br_priest:     { name: 'Priest (105 mm SP)', nation: 'uk', w: 0.6, rp: 13, cat: 'arty', from: 0, vet: 1,
                   men: ['ukpriest'], note: 'Ninety M7s reached the Eighth Army in time for El Alamein, and it was the British who named it, for its pulpit; the Canadians took the guns out to make the first Kangaroos.' },
    br_halftrack:  { name: 'M5 Half-track', nation: 'uk', w: 1, rp: 8, cat: 'transport', from: 0, vet: 1,
                   men: ['ukhalftrack'], note: 'International Harvester\'s M5, the half-track Lend-Lease sent to the British: the motor battalions of the armoured brigades rode to battle in them.' },
    br_jeep:       { name: 'Jeep (Airborne Recce)', nation: 'uk', w: 1, rp: 4, cat: 'recon', from: 0, vet: 2,
                   men: ['ukjeep'], note: 'The airborne reconnaissance squadrons\' jeeps, flown in by glider: at Arnhem Major Gough\'s were to rush the bridge ahead of the brigade.' },
    fr_m7:         { name: 'M7 Priest (French)', nation: 'fr', w: 0.6, rp: 13, cat: 'arty', from: 99, vet: 1,
                   men: ['frm7'], note: 'The armoured divisions of the new French army — Leclerc\'s 2e DB and the 1st and 5th DB of de Lattre\'s First Army — had their self-propelled 105s from the same American factories.' },
    fr_jeep:       { name: 'Jeep (2e DB)', nation: 'fr', w: 1, rp: 4, cat: 'recon', from: 99, vet: 1,
                   men: ['frjeep'], note: 'Leclerc drove into Paris in one, named "Tailly". Every reconnaissance troop and every staff of the 2e DB went about in them.' },
    fr_truck:      { name: 'GMC CCKW (2e DB)', nation: 'fr', w: 0.8, rp: 5, cat: 'transport', from: 99, vet: 1,
                   men: ['frtruck'], note: 'The "Jimmy" that carried the Régiment de marche du Tchad\'s infantry and everything the division ate and fired.' },
    fr_m3a1sc:     { name: 'M3A1 Scout Car (French)', nation: 'fr', w: 0.8, rp: 6, cat: 'recon', from: 99, vet: 1,
                   men: ['frm3a1sc'], note: 'The White scout car with the French armoured cavalry in Tunisia and Italy, and with the 2e DB\'s spahis; open, fast and thin.' },
    fr_m20:        { name: 'M20 Utility Car (2e DB)', nation: 'fr', w: 0.6, rp: 6, cat: 'recon', from: 99, vet: 1,
                   men: ['frm20'], note: 'The command car of the 2e DB\'s spahi squadrons, the Greyhound without its turret and a .50 on a ring.' },
    br_grant:      { name: 'Grant I', nation: 'uk', w: 1, rp: 13, cat: 'armour', from: 99, vet: 1,
                   men: ['ukgrant'], note: 'The first British tank with a 75 mm that could fire high explosive, in a sponson low on the hull, and the British turret on top: at Gazala in May 1942 the Afrikakorps met it, and did not enjoy it.' },
    fr_lorraine:   { name: 'Lorraine 38L VBCP', nation: 'fr', w: 0.6, rp: 6, cat: 'transport', from: 99, vet: 1,
                   men: ['frlorraine'], note: 'An armoured infantry carrier in 1940, before most armies had one: the light mechanised divisions\' dragons portés rode to battle in an armoured box on the Lorraine supply tractor.' },
    us_longtom:    { name: '155mm Gun "Long Tom"', nation: 'us', w: 0.4, rp: 16, cat: 'arty', from: 2, vet: 1,
                   men: ['uslongtom'], note: 'The corps gun: a 43 kg shell to twenty-three kilometres, fourteen men and a tractor to move it. It does not belong anywhere near the front, and it reaches the enemy\'s rear from behind your own.' },
    us_mortar42:   { name: '4.2-inch Mortar Team', nation: 'us', w: 0.6, rp: 10, cat: 'mortar', from: 0, vet: 1,
                   men: ['usmortar42'], note: 'The chemical battalions\' rifled mortar, built for gas and firing high explosive and white phosphorus instead: an 11 kg bomb, four kilometres, and the heaviest punch an American infantry regiment could call on.' },
    br_2pdr:       { name: 'QF 2-pounder', nation: 'uk', w: 0.8, rp: 6, cat: 'atgun', from: 99, vet: 1,
                   men: ['uk2pdr'], note: 'The British anti-tank gun of 1940-42, standing on its three legs with its wheels off the ground so it turns right round. Good against anything in 1940, and a peashooter by 1942. No high explosive.' },
    br_55in:       { name: 'BL 5.5-inch Medium Gun', nation: 'uk', w: 0.4, rp: 15, cat: 'arty', from: 0, vet: 1,
                   men: ['uk55in'], note: 'The medium regiments\' gun from El Alamein to the end: a 45 kg shell to fifteen kilometres, and the two big spring cylinders on its front that make it the easiest gun in the army to recognise.' },
    fr_75:         { name: 'Canon de 75 mle 1897', nation: 'fr', w: 1, rp: 9, cat: 'arty', from: 99, vet: 1,
                   men: ['fr75'], note: 'The soixante-quinze: the first field gun with a true recoil system, fifteen rounds a minute in 1897, still the divisional gun in 1940 — and, over open sights with its old armour-piercing shell, an anti-tank gun.' },
    fr_mortar81:   { name: 'Mortier de 81 Brandt', nation: 'fr', w: 1, rp: 8, cat: 'mortar', from: 99, vet: 1,
                   men: ['frmortar81'], note: 'Edgar Brandt\'s 81 mm of 1927, the mortar the world copied: the American M1 is a licence-built Brandt. A 3.25 kg bomb to 2.8 km.' },
    fr_mortar60:   { name: 'Mortier de 60 Brandt', nation: 'fr', w: 1.2, rp: 5, cat: 'mortar', from: 99, vet: 1,
                   men: ['frmortar60'], note: 'The company\'s light mortar of 1935, and again the American M2 is a Brandt under licence. A 1.3 kg bomb to 1.7 km, carried by two men.' },
    fr_105:        { name: 'Obusier de 105 M2', nation: 'fr', w: 0.8, rp: 11, cat: 'arty', from: 99, vet: 1,
                   men: ['fr105'], note: 'The American 105 mm howitzer in the French divisional artillery of 1943-45: the 64e RADB fired it for the 2e DB from Normandy to Berchtesgaden.' },
    fr_bazooka:    { name: 'Équipe bazooka', nation: 'fr', w: 1.6, rp: 5, cat: 'at', from: 99, vet: 1,
                   men: ['frbazooka'], note: 'The rearmed French infantry of 1944 carried the American 2.36-inch rocket launcher: two men, a tube, and the only thing a section had against a Panther.' },
    br_bofors:     { name: 'Bofors 40 mm', nation: 'uk', w: 0.6, rp: 8, cat: 'atgun', from: 0, vet: 1,
                   men: ['ukbofors'], note: 'The light anti-aircraft regiments\' gun, two rounds a second; with the Luftwaffe gone by the summer of 1944 it was turned on the ground, and in the Netherlands the Bofors "pepperpot" barrage went in front of the infantry.' },
    fr_155gpf:     { name: 'Canon de 155 GPF', nation: 'fr', w: 0.4, rp: 14, cat: 'arty', from: 99, vet: 1,
                   men: ['fr155gpf'], note: 'Filloux\'s great gun of 1917, the first with split trails; in 1940 the army corps still had nothing heavier, and the Americans had built it themselves as their M1918.' },
    fr_105l36:     { name: 'Canon de 105 L mle 1936', nation: 'fr', w: 0.6, rp: 12, cat: 'arty', from: 99, vet: 1,
                   men: ['fr105l36'], note: 'Schneider\'s long 105, the modern gun of the French corps artillery in 1940: split trails, pneumatic tyres, fifteen kilometres. There were too few of them.' },
    br_para:       { name: 'Airborne Section', nation: 'uk', w: 1.4, rp: 12, cat: 'rifle', from: 0, vet: 2,
                   men: ['uksten', 'ukbren', 'ukpara', 'ukpara', 'ukpara', 'ukpara', 'ukpara', 'ukpara', 'ukpara', 'ukpara'], note: 'The Red Berets in their Denison smocks: the 6th Airborne at the Orne bridges, the 1st at Arnhem, where they held the north end of the bridge for four days with what they carried.' },
    br_canadian:   { name: 'Canadian Rifle Section', nation: 'uk', w: 2, rp: 9, cat: 'rifle', from: 0, vet: 1,
                   men: ['uksten', 'ukbren', 'ukcanadian', 'ukcanadian', 'ukcanadian', 'ukcanadian', 'ukcanadian', 'ukcanadian', 'ukcanadian', 'ukcanadian'], note: 'Every man a volunteer: the 3rd Canadian Division came ashore on Juno and got further inland on D-Day than anyone, and then fought the 12th SS for Caen.' },
    br_polish:     { name: 'Polish Rifle Section', nation: 'uk', w: 1.2, rp: 10, cat: 'rifle', from: 9, vet: 2,
                   men: ['uksten', 'ukbren', 'ukpolish', 'ukpolish', 'ukpolish', 'ukpolish', 'ukpolish', 'ukpolish', 'ukpolish', 'ukpolish'], note: 'An army in exile in British battledress: the 1st Armoured Division corked the Falaise pocket on Hill 262, Sosabowski\'s brigade jumped at Driel, and the 2nd Corps took Monte Cassino.' },
    fr_alpin:      { name: 'Section de Chasseurs alpins', nation: 'fr', w: 1.2, rp: 10, cat: 'rifle', from: 99, vet: 2,
                   men: ['frfm2429', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin', 'fralpin'], note: 'The "blue devils" in their great floppy berets: mountain infantry, who took Narvik back from the Germans in May 1940 and in June held the Alps against the Italians without giving a metre.' },
    fr_legion:     { name: 'Groupe de la Légion étrangère', nation: 'fr', w: 1, rp: 11, cat: 'rifle', from: 99, vet: 2,
                   men: ['frfm2429', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion', 'frlegion'], note: 'Foreigners in French service, the white képi their badge: the 13e Demi-Brigade at Narvik and Bir Hakeim, the régiments de marche of volunteers who held the Inor wood and the Somme in 1940.' },
    fr_tirailleur: { name: 'Section de Tirailleurs sénégalais', nation: 'fr', w: 1.4, rp: 9, cat: 'rifle', from: 99, vet: 1,
                   men: ['frfm2429', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur', 'frtirailleur'], note: 'West African infantry, a hundred thousand of them in France in 1940: they held the Somme hedgehogs and Lyon\'s approaches to the end, and too many who surrendered were shot by their captors.' },
    // <<< round 115 roster
    // >>> round 108 roster (tools/roster_r108.py writes these rows from tools/roster_r108_spec.py: edit the spec, not them)
    ger_pz1:      { name: 'Panzer I', nation: 'ger', w: 1, rp: 6, cat: 'recon', from: 99, vet: 1,
                   men: ['gerpz1'], note: 'Two machine guns and thirteen millimetres of plate: a training tank, and in 1940 still a third of the panzer regiments. Use it to find things, not to fight them.' },
    ger_flakpz1:  { name: 'Flakpanzer I', nation: 'ger', w: 0.3, rp: 7, cat: 'armour', from: 99, vet: 1,
                   men: ['gerflakpz1'], note: 'A 2 cm Flak 38 bolted into a Panzer I with its superstructure cut away. Twenty-four were built and Flak-Abteilung 614 lost the last of them at Stalingrad.' },
    ger_pzjg1:    { name: 'Panzerjäger I', nation: 'ger', w: 0.6, rp: 8, cat: 'armour', from: 99, vet: 1,
                   men: ['gerpzjg1'], note: 'The first German tank destroyer: a Czech 4.7 cm anti-tank gun behind a three-sided shield on a Panzer I. It will hole a Matilda\'s side and a T-34\'s, and a rifle bullet through the open top will end it.' },
    ger_bison:    { name: 'Bison', nation: 'ger', w: 0.6, rp: 10, cat: 'arty', from: 99, vet: 1,
                   men: ['gerbison'], note: 'A whole 15 cm sIG 33, wheels and trail and all, lifted onto a Panzer I behind a box of plate taller than the tank is wide. Six companies went to France. It carries almost no ammunition of its own.' },
    ger_pz2:      { name: 'Panzer II', nation: 'ger', w: 1.6, rp: 8, cat: 'recon', from: 99, vet: 1,
                   men: ['gerpz2'], note: 'A 2 cm gun and a machine gun, and a third of the tanks that went into France. By 1941 it was a reconnaissance vehicle, which is what it should be used as.' },
    ger_marder2:  { name: 'Marder II', nation: 'ger', w: 1, rp: 10, cat: 'armour', from: 0, vet: 1,
                   men: ['germarder2'], note: 'The PaK 40 on a Panzer II, the commonest German self-propelled anti-tank gun in Russia and still in the infantry divisions\' Panzerjäger companies in Normandy. A good gun in a tin box.' },
    ger_pz35t:    { name: 'Panzer 35(t)', nation: 'ger', w: 1, rp: 9, cat: 'armour', from: 99, vet: 1,
                   men: ['gerpz35t'], note: 'The Czech LT vz. 35, taken with the factories in March 1939: 6. Panzer-Division\'s tank in France and on the road to Leningrad. Riveted, and its pneumatic gearbox froze in the Russian winter.' },
    ger_pz38t:    { name: 'Panzer 38(t)', nation: 'ger', w: 1.6, rp: 10, cat: 'armour', from: 99, vet: 1,
                   men: ['gerpz38t'], note: 'ČKD\'s TNHP: reliable, quick, and a quarter of the panzer divisions\' tanks in 1941. The 3.7 cm will not hurt a T-34, and nothing in 1941 would.' },
    ger_flakpz38t: { name: 'Flakpanzer 38(t)', nation: 'ger', w: 0.5, rp: 8, cat: 'armour', from: 1, vet: 1,
                   men: ['gerflakpz38t'], note: 'A 2 cm Flak 38 in an open box on the late Panzer 38(t). 12. SS-Panzer-Division brought them to Normandy, and like every light flak gun it spent more of its time on infantry than on aircraft.' },
    ger_aufkl38t: { name: 'Aufklärer 38(t)', nation: 'ger', w: 0.8, rp: 9, cat: 'recon', from: 4, vet: 2,
                   men: ['geraufkl38t'], note: 'The eight-wheeled armoured car\'s open turret, 2 cm gun and MG 42 on the Panzer 38(t)\'s chassis, for the reconnaissance battalions of 1944. It sees a long way and should leave before it is seen.' },
    ger_grille:   { name: 'Grille', nation: 'ger', w: 0.8, rp: 12, cat: 'arty', from: 0, vet: 1,
                   men: ['gergrille'], note: 'The infantry regiment\'s heavy gun on the Panzer 38(t)\'s late chassis: thirty-eight kilograms of high explosive a round, and it can follow the regiment it belongs to.' },
    ger_stuh42:   { name: 'StuH 42', nation: 'ger', w: 1, rp: 17, cat: 'armour', from: 1, vet: 1,
                   men: ['gerstuh42'], note: 'The StuG III with a 10.5 cm howitzer in place of its gun: one in three of an assault-gun brigade\'s pieces from 1943. High explosive for the house, and a hollow-charge round for whatever comes round the corner of it.' },
    ger_ostwind:  { name: 'Ostwind', nation: 'ger', w: 0.4, rp: 13, cat: 'armour', from: 99, vet: 1,
                   men: ['gerostwind'], note: 'One 3.7 cm Flak 43 in an open six-sided turret on a Panzer IV: the Wirbelwind\'s successor, fewer than fifty of them. Every round explodes, which is what makes it so bad to be in front of.' },
    ger_stug4:    { name: 'StuG IV', nation: 'ger', w: 1.2, rp: 16, cat: 'armour', from: 1, vet: 1,
                   men: ['gerstug4'], note: 'The StuG III\'s casemate on a Panzer IV, built when the bombers stopped Alkett. A thousand of them, the driver in a little armoured box of his own in front.' },
    ger_pz4e:     { name: 'Panzer IV Ausf. E', nation: 'ger', w: 1.2, rp: 13, cat: 'armour', from: 99, vet: 1,
                   men: ['gerpz4e'], note: 'The "short" Panzer IV: the close-support tank of the panzer battalion\'s heavy company, its stubby 7.5 cm meant for the anti-tank gun the Panzer IIIs could not see. Against a T-34 it is a door-knocker.' },
    ger_pz3f:     { name: 'Panzer III Ausf. F', nation: 'ger', w: 1.4, rp: 11, cat: 'armour', from: 99, vet: 1,
                   men: ['gerpz3f'], note: 'The Panzer III of the French campaign: thirty millimetres all round and the 3.7 cm "door-knocker" with two machine guns beside it. Built to fight tanks, and outclassed by every one it met in 1941.' },
    ger_stugb:    { name: 'StuG III Ausf. B', nation: 'ger', w: 1, rp: 12, cat: 'armour', from: 99, vet: 1,
                   men: ['gerstugb'], note: 'The infantry\'s assault gun of 1940-41: a short 7.5 cm in a low box on the Panzer III, built to put a shell into a pillbox from two hundred metres. No machine gun at all — the infantry are supposed to be with it.' },
    ger_hummel:   { name: 'Hummel', nation: 'ger', w: 0.6, rp: 18, cat: 'arty', from: 2, vet: 1,
                   men: ['gerhummel'], note: 'A 15 cm field howitzer in the Nashorn\'s open box: one battery of six in every panzer artillery regiment. Eighteen rounds aboard and a munitions carrier somewhere behind with the rest.' },
    ger_dickermax: { name: 'Dicker Max (prototype)', nation: 'ger', w: 0.15, rp: 22, cat: 'armour', from: 99, vet: 2,
                   men: ['gerdickermax'], note: 'Prototype. A 10.5 cm heavy gun in an open box on a Panzer IV chassis, built to break the Maginot Line and sent to Russia instead. Two built; one burned out in 1941.' },
    ger_sturer:   { name: 'Sturer Emil (prototype)', nation: 'ger', w: 0.15, rp: 24, cat: 'armour', from: 99, vet: 2,
                   men: ['gersturer'], note: 'Prototype. A 12.8 cm K 40 on a lengthened Henschel chassis, open to the sky. Two went to Russia in 1942 and claimed thirty-one tanks; the Red Army captured one at Stalingrad and it is at Kubinka.' },
    ger_panther2: { name: 'Panther II (prototype)', nation: 'ger', w: 0.15, rp: 30, cat: 'armour', from: 99, vet: 2,
                   men: ['gerpanther2'], note: 'Prototype. The Panther redesigned to share the Tiger II\'s parts, with the narrow Schmalturm and the 8.8 cm KwK 43. One hull was finished; it is at Fort Knox with an ordinary Panther\'s turret on it.' },
    ger_e50:      { name: 'E-50 (paper)', nation: 'ger', w: 0.1, rp: 32, cat: 'armour', from: 99, vet: 2,
                   men: ['gere50'], note: 'Drawings only. The medium of the E-series, meant to replace the Panther and the Tiger alike: every plate sloped, the running gear in bogies hung outside the hull, the Schmalturm and the 8.8 cm.' },
    ger_tigerp:   { name: 'Tiger (P) (prototype)', nation: 'ger', w: 0.15, rp: 30, cat: 'armour', from: 99, vet: 2,
                   men: ['gertigerp'], note: 'Prototype. Porsche\'s Tiger, petrol-electric, that lost to Henschel\'s: ninety hulls became Ferdinands, and one served schwere Panzerjäger-Abteilung 653 as its command tank into 1944.' },
    ger_elefant:  { name: 'Elefant', nation: 'ger', w: 0.3, rp: 34, cat: 'armour', from: 99, vet: 2,
                   men: ['gerelefant'], note: 'The Ferdinand of Kursk, rebuilt with a hull machine gun and a cupola: the 8.8 cm L/71 in a casemate two hundred millimetres thick, on Porsche\'s petrol-electric chassis. It kills at any range and breaks down at all of them.' },
    ger_sturmtiger: { name: 'Sturmtiger', nation: 'ger', w: 0.2, rp: 34, cat: 'armour', from: 99, vet: 2,
                   men: ['gersturmtiger'], note: 'A Tiger rebuilt round a 38 cm naval rocket mortar, to take a fortified house down with one round. Eighteen built. Fourteen rounds, loaded with a hand crane through the roof, and every one of them is three hundred and fifty kilogrammes.' },
    ger_jagdtiger: { name: 'Jagdtiger', nation: 'ger', w: 0.25, rp: 42, cat: 'armour', from: 99, vet: 2,
                   men: ['gerjagdtiger'], note: 'The heaviest armoured vehicle to fight in the war: a lengthened Tiger II under a casemate two hundred and fifty millimetres thick, carrying a 12.8 cm gun. About eighty were built, and more were lost to their own crews than to the enemy.' },
    ger_loewe:    { name: 'Löwe (paper)', nation: 'ger', w: 0.1, rp: 44, cat: 'armour', from: 99, vet: 2,
                   men: ['gerloewe'], note: 'Drawings only. Krupp\'s VK 70.01 of 1942, the turret at the back over the engine and the 10.5 cm L/70 reaching out over the whole hull. Cancelled for the Tiger II and the Maus.' },
    ger_e75:      { name: 'E-75 (paper)', nation: 'ger', w: 0.1, rp: 44, cat: 'armour', from: 99, vet: 2,
                   men: ['gere75'], note: 'Drawings only. The heavy of the E-series, to replace the Tiger II on its own hull with two hundred millimetres on the glacis and a heavy Schmalturm with the 10.5 cm.' },
    ger_e100:     { name: 'E-100 (prototype)', nation: 'ger', w: 0.08, rp: 52, cat: 'armour', from: 99, vet: 2,
                   men: ['gere100'], note: 'Prototype. Adler\'s super-heavy hull, half-built at Haustenbeck when the war ended, meant to carry the Maus\'s turret with its 12.8 cm and 7.5 cm guns. The British took the hull away to look at.' },
    ger_maus:     { name: 'Maus (prototype)', nation: 'ger', w: 0.08, rp: 56, cat: 'armour', from: 99, vet: 2,
                   men: ['germaus'], note: 'Prototype. One hundred and eighty-eight tonnes, petrol-electric, a 12.8 cm and a 7.5 cm in one turret. Two ran at Kummersdorf in 1944; no bridge in Europe would carry it, so it was to ford rivers on the bottom.' },
    sov_t26:      { name: 'T-26', nation: 'sov', w: 2, rp: 8, cat: 'armour', from: 0, vet: 1,
                   men: ['sovt26'], note: 'The Red Army\'s commonest tank of 1941: a licence-built Vickers six-tonner with a 45 mm gun. Ten thousand of them, and most were lost in the first six months, many without fuel or spares.' },
    sov_t40:      { name: 'T-40', nation: 'sov', w: 0.8, rp: 6, cat: 'recon', from: 0, vet: 1,
                   men: ['sovt40'], note: 'An amphibious scout with a 12.7 mm DShK and a propeller under its tail. It swims at six kilometres an hour, and it is the only thing in either army that will cross that river without a bridge.' },
    sov_t50:      { name: 'T-50', nation: 'sov', w: 0.4, rp: 11, cat: 'armour', from: 0, vet: 1,
                   men: ['sovt50'], note: 'The best light tank of 1941 on paper: sloped plate, a commander\'s cupola, a diesel and torsion bars. Its engine could not be built in quantity and only sixty-nine ever were.' },
    sov_bt2:      { name: 'BT-2', nation: 'sov', w: 0.6, rp: 7, cat: 'recon', from: 0, vet: 1,
                   men: ['sovbt2'], note: 'Christie\'s fast tank built under licence: it could take its tracks off and run on its road wheels at seventy kilometres an hour. A 37 mm gun, thirteen millimetres of plate and an aircraft engine that burned.' },
    sov_bt5:      { name: 'BT-5', nation: 'sov', w: 1, rp: 8, cat: 'armour', from: 0, vet: 1,
                   men: ['sovbt5'], note: 'The BT with the 45 mm gun in a bigger turret: Spain, Khalkhin Gol and the frontier battles of 1941. Fast, thin, and very easy to set alight.' },
    sov_bt7:      { name: 'BT-7', nation: 'sov', w: 1.4, rp: 9, cat: 'armour', from: 0, vet: 1,
                   men: ['sovbt7'], note: 'The last of the BTs: welded, a conical turret, and the Christie suspension that became the T-34\'s. More of them faced Barbarossa than anything but the T-26.' },
    sov_t60:      { name: 'T-60', nation: 'sov', w: 1, rp: 6, cat: 'recon', from: 0, vet: 1,
                   men: ['sovt60'], note: 'Built in car factories in the winter of 1941 because something had to be: a 20 mm gun, two men, and the nickname "brothers\' grave". Six thousand of them held the line that winter.' },
    sov_t70:      { name: 'T-70', nation: 'sov', w: 1.2, rp: 8, cat: 'armour', from: 0, vet: 1,
                   men: ['sovt70'], note: 'The light tank of 1942-43: a 45 mm gun, sloped front, two lorry engines, and a commander who loads, aims and fires it himself. Second only to the T-34 in numbers built.' },
    sov_t28:      { name: 'T-28', nation: 'sov', w: 0.8, rp: 12, cat: 'armour', from: 0, vet: 1,
                   men: ['sovt28'], note: 'Three turrets: the 76 mm in the middle and two machine-gun turrets in front. The infantry-support tank of the 1930s, and in 1941 there were still four hundred of them.' },
    sov_t35:      { name: 'T-35', nation: 'sov', w: 0.3, rp: 16, cat: 'armour', from: 0, vet: 1,
                   men: ['sovt35'], note: 'Five turrets and eleven men: a 76 mm, two 45 mm guns and five machine guns. The parade tank of Red Square; in 1941 most broke down on the way to the front before a German ever saw them.' },
    sov_smk:      { name: 'SMK (prototype)', nation: 'sov', w: 0.1, rp: 24, cat: 'armour', from: 99, vet: 2,
                   men: ['sovsmk'], note: 'Prototype. Two turrets on one heavy hull, 76 mm above 45 mm, sent with the KV against the Mannerheim Line in December 1939. A mine stopped it in no man\'s land and it took two months to recover.' },
    sov_su100y:   { name: 'SU-100Y (prototype)', nation: 'sov', w: 0.1, rp: 28, cat: 'armour', from: 99, vet: 2,
                   men: ['sovsu100y'], note: 'Prototype. A 130 mm naval gun in a box on the T-100\'s hull, built to smash Finnish bunkers. It arrived after the war ended, and in the autumn of 1941 went to the defence of Moscow instead.' },
    sov_su122:    { name: 'SU-122', nation: 'sov', w: 0.8, rp: 16, cat: 'armour', from: 0, vet: 1,
                   men: ['sovsu122'], note: 'The M-30 divisional howitzer in a casemate on the T-34: the Red Army\'s first assault gun, at the front from January 1943. Twenty-two kilogrammes of high explosive, and a hollow-charge round for the Tiger.' },
    sov_su85:     { name: 'SU-85', nation: 'sov', w: 1, rp: 18, cat: 'armour', from: 0, vet: 1,
                   men: ['sovsu85'], note: 'The 85 mm anti-aircraft gun\'s descendant in the SU-122\'s casemate: the answer to the Tiger and the Panther until the T-34-85 carried the same gun in a turret.' },
    sov_t43:      { name: 'T-43 (prototype)', nation: 'sov', w: 0.1, rp: 18, cat: 'armour', from: 99, vet: 1,
                   men: ['sovt43'], note: 'Prototype. The T-34 re-armoured to the KV\'s standard, with torsion bars and a three-man turret. Two prototypes were tried in battle in 1943; its turret went onto the T-34-85 instead.' },
    sov_t44:      { name: 'T-44', nation: 'sov', w: 0.2, rp: 22, cat: 'armour', from: 99, vet: 1,
                   men: ['sovt44'], note: 'The T-34\'s successor: the engine turned across the hull, the turret moved back, 120 mm on the glacis. In production from November 1944; the war ended before one fired in anger.' },
    sov_kv1s:     { name: 'KV-1S', nation: 'sov', w: 1, rp: 20, cat: 'armour', from: 0, vet: 1,
                   men: ['sovkv1s'], note: 'The KV lightened — "S" for skorostnoy, fast — with a cast turret and a cupola at last. It kept up with the T-34s, and it gave up armour to do it.' },
    sov_kv2:      { name: 'KV-2', nation: 'sov', w: 0.6, rp: 24, cat: 'armour', from: 0, vet: 1,
                   men: ['sovkv2'], note: 'A 152 mm howitzer in a turret like a garden shed on a KV: built for the Mannerheim Line\'s bunkers. Its turret will not traverse on a slope and nothing the Germans had in 1941 would go through it.' },
    sov_kv13:     { name: 'KV-13 (prototype)', nation: 'sov', w: 0.1, rp: 18, cat: 'armour', from: 99, vet: 1,
                   men: ['sovkv13'], note: 'Prototype. A "universal" tank between the T-34 and the KV: a cast hull with 120 mm in front on five road wheels. It failed its trials, and its hull became the IS.' },
    sov_kv220:    { name: 'KV-220 (prototype)', nation: 'sov', w: 0.1, rp: 26, cat: 'armour', from: 99, vet: 2,
                   men: ['sovkv220'], note: 'Prototype. A KV lengthened by a road wheel, a hundred millimetres all round, an 85 mm gun in a big turret. The one built went into the defence of Leningrad in October 1941 and did not come back.' },
    sov_kv3:      { name: 'KV-3 (prototype)', nation: 'sov', w: 0.1, rp: 30, cat: 'armour', from: 99, vet: 2,
                   men: ['sovkv3'], note: 'Prototype. The heavy breakthrough tank of 1941: the KV-220\'s long hull with 120 mm of plate and the 107 mm ZiS-6. Kirov\'s works were evacuated before it was finished.' },
    sov_kv5:      { name: 'KV-5 (paper)', nation: 'sov', w: 0.08, rp: 40, cat: 'armour', from: 99, vet: 2,
                   men: ['sovkv5'], note: 'Drawings only. A hundred tonnes, 180 mm of plate, the 107 mm gun and a little machine-gun turret for the driver. Leningrad was surrounded while the drawings were being finished.' },
    sov_kv85:     { name: 'KV-85', nation: 'sov', w: 0.5, rp: 24, cat: 'armour', from: 0, vet: 1,
                   men: ['sovkv85'], note: 'The stopgap of 1943: the IS-85\'s cast turret and 85 mm gun on the KV-1S hull, a hundred and forty-eight built while the IS was readied. It could finally answer the Tiger at a range the Tiger chose.' },
    sov_su152:    { name: 'SU-152', nation: 'sov', w: 0.8, rp: 26, cat: 'armour', from: 0, vet: 1,
                   men: ['sovsu152'], note: 'The ML-20 gun-howitzer on the KV-1S, rushed into production in twenty-five days in early 1943. At Kursk it earned the name the ISU inherited: Zveroboy, the beast-killer.' },
    sov_is1:      { name: 'IS-1', nation: 'sov', w: 0.4, rp: 26, cat: 'armour', from: 0, vet: 1,
                   men: ['sovis1'], note: 'The first of the Iosif Stalin tanks, with the 85 mm gun: a hundred and seven built before the 122 mm replaced it. The hull and turret of the IS-2, and the gun of the T-34-85.' },
    sov_is3:      { name: 'IS-3', nation: 'sov', w: 0.2, rp: 34, cat: 'armour', from: 99, vet: 2,
                   men: ['sovis3'], note: 'The pike nose and the bowl turret that frightened the West at the Berlin victory parade in September 1945. In production from May; it fought in no battle of this war.' },
    sov_isu122:   { name: 'ISU-122', nation: 'sov', w: 0.7, rp: 28, cat: 'armour', from: 0, vet: 1,
                   men: ['sovisu122'], note: 'The ISU-152\'s casemate with the long 122 mm A-19 in it, because there were more A-19s than ML-20s. A tank destroyer by accident, and a very good one.' },
    sov_isu122s:  { name: 'ISU-122S', nation: 'sov', w: 0.5, rp: 29, cat: 'armour', from: 0, vet: 1,
                   men: ['sovisu122s'], note: 'The ISU-122 with the IS-2\'s D-25 gun, its two-chamber muzzle brake and a semi-automatic breech: a round every twenty seconds instead of every thirty.' },
    sov_isu1522:  { name: 'ISU-152-2 (prototype)', nation: 'sov', w: 0.1, rp: 32, cat: 'armour', from: 99, vet: 2,
                   men: ['sovisu1522'], note: 'Prototype. Object 247: the ISU with the long 152 mm BL-10 at 880 metres a second, built to kill the Tiger II and the Jagdtiger from beyond their reach. The barrel wore out on trial and the war ended.' },
    // <<< round 108 roster
  };
  // `w` is the template's share WITHIN its doctrinal category. Without it the
  // buyer picks the dearest thing in the category every time and a rifle
  // company comes out as four assault squads: an assault squad costs ten
  // points and a rifle squad nine, so "dearest affordable" never once buys the
  // squad the company was actually made of.
  for (var tk in TEMPLATES) { TEMPLATES[tk].id = tk; if (TEMPLATES[tk].w === undefined) TEMPLATES[tk].w = 1; }

  /** (round 115) WHO MAY FIGHT BESIDE WHOM — the battle setup's alliances
   *  (assets/battlesetup.js `ALLIANCES`), here so the reinforcements read the
   *  same rule: the Americans, the Commonwealth, the Red Army and the French
   *  are the Allies; the Germans, the Italians and the Japanese the Axis.
   *  Nothing crosses between them. An army no row names has none. */
  var ALLIANCE_OF = { us: 'allied', uk: 'allied', sov: 'allied', fr: 'allied', ger: 'axis', it: 'axis', jp: 'axis' };
  function allianceOf(nation) { return ALLIANCE_OF[nation] || null; }

  /** Every template a side may draw from, in requisition order: EVERY ARMY OF
   *  ITS ALLIANCE. `nation` is the side's own army; without one, team 2 is the
   *  Axis and any other team the Allies.
   *
   *  It was team 1 = American or British, team 2 = German (the Commonwealth
   *  had been added for Villers-Bocage, a British battle in an American
   *  campaign); the French, the Red Army, the Italians and the Japanese were
   *  on no list while the battle setup already let one force mix its whole
   *  alliance. The campaign reads its own `nationsOf` (assets/campaign.js),
   *  which this does not touch. */
  function templatesFor(team, nation) {
    var al = (nation && allianceOf(nation)) || (team === 2 ? 'axis' : 'allied'), out = [], k;
    for (k in TEMPLATES) if (allianceOf(TEMPLATES[k].nation) === al) out.push(TEMPLATES[k]);
    out.sort(function (a, b) { return a.rp - b.rp; });
    return out;
  }

  // =========================================================================
  // CLOSE COMBAT ORDER SET
  // =========================================================================
  //
  // Eight orders, given to a SQUAD, exactly the way Close Combat gives them:
  // pick the order, then click the ground. Five of them take a point on the
  // map; three apply where the squad already stands.
  //
  // None of this reimplements movement or posture. Every one of these routes
  // into a `Game.command*` or `Unit.order*` that already existed — what is new
  // is that the order lands on the whole squad, is remembered as the squad's
  // TASK so the roster can report it, and cancels whatever the squad was doing
  // before, which is what makes the orders feel like orders.
  var CC_ORDERS = [
    { id: 'move',   t: 'Move',      k: '', ic: '→', aim: true,
      tip: 'Advance in formation at walking pace, returning fire. The squad keeps together and waits for stragglers.' },
    { id: 'fast',   t: 'Move Fast', k: 'F', ic: '»', aim: true,
      tip: 'Run. Much quicker, upright, loud, and they cannot shoot while they do it. For crossing ground nobody is watching.' },
    { id: 'sneak',  t: 'Sneak',     k: 'N', ic: '·', aim: true,
      tip: 'Move crouched and hold fire. Slow, and very hard to spot — the only way to cross open ground in front of a gun.' },
    { id: 'fire',   t: 'Fire',      k: '', ic: '✱', aim: true,
      tip: 'Put fire on a point whether or not anything is visible there. Suppresses what is behind the hedge.' },
    { id: 'smoke',  t: 'Smoke',     k: 'K', ic: '☁', aim: true,
      tip: 'Everyone carrying smoke lobs it at that point. Breaks a sightline for about a minute.' },
    { id: 'defend', t: 'Defend',    k: 'G', ic: '⛊', aim: false,
      tip: 'Hold this ground. The squad goes to cover, steadies its aim, and will not follow anything.' },
    { id: 'hide',   t: 'Hide',      k: 'C', ic: '◍', aim: false,
      tip: 'Go to ground and hold fire completely. Nearly invisible until something walks onto them.' },
    { id: 'dig',    t: 'Dig In',    k: 'Y', ic: '⛏', aim: false,
      tip: 'Scrape holes. Takes time, and doubles what the ground is worth once it is done.' },
  ];
  // The ORDERS palette (COMMAND_DEFS, main file) routes six of its entries
  // through ccOrder; the other 28 it owns alone become the bar's second row.
  // Keyed by palette id so the row is DERIVED from COMMAND_DEFS, never copied:
  // a new palette entry lands on the bar by itself, and the two can never
  // disagree on a tooltip or a key. tools/test_orderbar.js pins this table
  // against the palette's `run` bodies.
  var CC_PALETTE_DUP = { cmdFast: 'fast', cmdSneak: 'sneak', cmdSmoke: 'smoke', cmdDefend: 'defend', cmdHide: 'hide', cmdDig: 'dig' };

  function installOrders(P) {
    /** Arm or apply an order. Aiming orders wait for a click on the ground. */
    P.ccOrder = function (id) {
      var sel = this._liveSel();
      if (!sel.length) return;
      var def = null;
      for (var i = 0; i < CC_ORDERS.length; i++) if (CC_ORDERS[i].id === id) def = CC_ORDERS[i];
      if (!def) return;
      // Arming a new order throws away any other armed order — two half-given
      // orders on the pointer at once is how you end up laying smoke on your
      // own start line.
      this.pendingSmoke = false; this.pendingMove = null; this.pendingAssault = false;
      this.pendingFace = false; this.pendingEngineer = null;
      if (this.pendingRoute && this.cancelRoute) this.cancelRoute();
      if (!def.aim) { this.ccApply(id, null, null); this.ccArmed = null; this._refreshOrderBar(); return; }
      // Aiming orders wait for a left-click, and ONLY ccExecuteAt acts on
      // them. Setting the engine's own `pendingSmoke` / `pendingMove` here as
      // well would give the same click two owners.
      this.ccArmed = id;
      this.ui.toast(def.t + ' — click the ground');
      this._refreshOrderBar();
    };

    P.ccCancel = function () {
      this.ccArmed = null;
      this.pendingSmoke = false; this.pendingFire = false; this.pendingMove = null;
      this._refreshOrderBar();
    };

    /** The armed order lands. Called from the click handler. */
    P.ccExecuteAt = function (wx, wz, append) {
      var id = this.ccArmed;
      if (!id) return false;
      this.ccApply(id, wx, wz, append);
      // One click, one order — EXCEPT with shift held, which keeps the order on
      // the pointer so a section can be given a whole march of legs in the same
      // posture: crawl to the ditch, crawl to the gate, crawl to the wall.
      if (!append) { this.ccArmed = null; }
      this._refreshOrderBar();
      return true;
    };

    P.ccApply = function (id, wx, wz, append) {
      var sel = this._liveSel();
      if (!sel.length) return;
      var squads = [], i;
      for (i = 0; i < sel.length; i++) {
        var s = sel[i].squad;
        if (s && s._cc && squads.indexOf(s) < 0) squads.push(s);
      }
      var setTask = function (t) { for (var j = 0; j < squads.length; j++) squads[j].task = t; };

      switch (id) {
        case 'move':
          this.pendingMove = null;
          this._lastMoveMode = 'normal';
          this.commandMove(wx, wz, !!append);
          break;
        case 'fast':
          this.pendingMove = 'fast';
          this._lastMoveMode = 'fast';
          this.commandMove(wx, wz, !!append);
          setTask('Running');
          break;
        case 'sneak':
          this.pendingMove = 'sneak';
          this._lastMoveMode = 'sneak';
          this.commandMove(wx, wz, !!append);
          setTask('Sneaking');
          break;
        case 'fire':
          // Area fire. The squad stops where it is and shoots at the ground.
          for (i = 0; i < squads.length; i++) squads[i].moveGoal = null;
          this.commandAttackGround(wx, wz);
          setTask('Firing');
          break;
        case 'smoke':
          this.throwSmoke(wx, wz);
          setTask('Smoke out');
          break;
        case 'defend':
          for (i = 0; i < squads.length; i++) squads[i].moveGoal = null;
          this.commandDefend();
          setTask('Defending');
          break;
        case 'hide':
          for (i = 0; i < squads.length; i++) squads[i].moveGoal = null;
          this.commandHide();
          setTask('Hiding');
          break;
        case 'dig':
          for (i = 0; i < squads.length; i++) squads[i].moveGoal = null;
          this.commandDigIn();
          setTask('Digging in');
          break;
      }
    };

    // ---- the order bar -----------------------------------------------------
    P.installOrderBar = function () {
      if (document.getElementById('ccBar')) return;
      var el = document.createElement('div');
      el.id = 'ccBar';
      var h = '<div class="cc-row">';
      for (var i = 0; i < CC_ORDERS.length; i++) {
        var o = CC_ORDERS[i];
        h += '<button class="cc-b" data-o="' + o.id + '" title="' + esc(o.tip) + '">'
          + '<i>' + o.ic + '</i><b>' + esc(o.t) + '</b>'
          + (o.k ? '<u>' + o.k + '</u>' : '') + '</button>';
      }
      h += '</div>';
      // Second row: the ORDERS palette's own entries (COMMAND_DEFS, handed in
      // by squadsInstall) minus the six this bar already has. Same markup, the
      // exact title the palette put on its button, and each one runs the
      // palette's own `run` — nothing is re-implemented here. `body.cc-bar` is
      // what hides the palette, and it is only set once the row exists, so an
      // api without COMMAND_DEFS leaves the palette exactly as it was.
      var defs = (G && G.COMMAND_DEFS) || [], row2 = '', d;
      this._ccRow2 = {};   // palette id -> def (row 2)
      this._ccDup = {};    // cc order id -> palette def (row 1's "lit gold" state)
      for (i = 0; i < defs.length; i++) {
        d = defs[i];
        if (CC_PALETTE_DUP[d.id]) { this._ccDup[CC_PALETTE_DUP[d.id]] = d; continue; }
        this._ccRow2[d.id] = d;
        row2 += '<button class="cc-b" data-p="' + d.id + '" title="' + esc(d.tip + (d.k ? '  (' + d.k + ')' : '')) + '">'
          + '<i>' + d.ic + '</i><b>' + esc(d.t) + '</b>'
          + (d.k ? '<u>' + esc(d.k) + '</u>' : '') + '</button>';
      }
      if (row2) {
        h += '<div class="cc-row cc-row2">' + row2 + '</div><div class="cc-hint" id="ccHint"></div>';
        document.body.classList.add('cc-bar');
      }
      el.innerHTML = h;
      document.body.appendChild(el);
      var self = this;
      el.addEventListener('mousedown', function (e) {
        var b = e.target.closest ? e.target.closest('.cc-b') : null;
        if (!b) return;
        e.stopPropagation(); e.preventDefault();
        if (b.dataset.o) { self.ccOrder(b.dataset.o); return; }
        var d = self._ccRow2 && self._ccRow2[b.dataset.p];
        if (!d) return;
        // One order on the pointer at a time. Input.onDown checks ccArmed
        // first, so an arming palette order (Assault, Route, Face, the
        // charges) must evict an armed CC order — the way ccOrder evicts theirs
        // — or the next click lands the CC order and leaves Assault pulsing.
        if (d.arm && self.ccArmed) self.ccCancel();
        d.run(self);
        if (self.ui && self.ui._refreshCommands) self.ui._refreshCommands(true);
        self._refreshOrderBar();
      });
      this._refreshOrderBar();
    };

    P._refreshOrderBar = function () {
      var el = document.getElementById('ccBar');
      if (!el) return;
      var sel = this._liveSel ? this._liveSel() : [];
      var show = this.mode === 'play' && !this.fpv && sel.length > 0
        && !document.body.classList.contains('briefing');
      el.style.display = show ? 'flex' : 'none';
      // The keyboard hint lives in the bottom-right corner the order bar
      // spills into. It is only in the way when there is something selected,
      // which is exactly when the bar is up.
      document.body.classList.toggle('has-sel', show);
      if (!show) return;
      // One language across both rows, the palette's: gold = the posture the
      // men are already in, pulse = waiting for a click. Row 1 keeps its gold
      // for an armed order as well, so nothing it showed before is lost.
      var live = sel.filter(function (u) { return !u.downed; }), g = this, d, ok, armed;
      var btns = el.querySelectorAll('.cc-b[data-o]');
      for (var i = 0; i < btns.length; i++) {
        armed = this.ccArmed === btns[i].dataset.o;
        d = this._ccDup && this._ccDup[btns[i].dataset.o];
        btns[i].classList.toggle('on', armed || !!(d && d.on && live.length && d.on(live, g)));
        btns[i].classList.toggle('armed', armed);
      }
      if (this._ccRow2) {
        var r2 = el.querySelectorAll('.cc-b[data-p]'), key = '';
        for (i = 0; i < r2.length; i++) {
          d = this._ccRow2[r2[i].dataset.p];
          ok = live.length > 0 && (!d.show || d.show(live, g));
          r2[i].classList.toggle('off', !ok);
          r2[i].classList.toggle('on', ok && !!d.on && !!d.on(live, g));
          r2[i].classList.toggle('armed', ok && !!d.arm && !!d.arm(g));
          if (ok) key += r2[i].dataset.p + ' ';
        }
        // The hint line (what an armed order is waiting for, the route's
        // waypoint count) is still written by UI._refreshCommands for the
        // hidden palette; mirror it under the bar.
        var hint = document.getElementById('ccHint'), src = this.ui && this.ui.el && this.ui.el.cmdHint;
        if (hint && src) {
          if (hint.innerHTML !== src.innerHTML) hint.innerHTML = src.innerHTML;
          key += '|' + hint.innerHTML.length;
        }
        // Two rows are taller than the 104px the formation bar was stacked at
        // (main CSS), and during deployment the deploy bar (bottom 14, z 130)
        // sits exactly where this bar does. Measured, not assumed — row 2 wraps
        // on a narrow window — but offsetHeight forces layout, so only when
        // the visible set changed.
        var dp = document.getElementById('deployBar'), dpUp = !!(dp && dp.classList.contains('visible'));
        if (dpUp) key += '|dp';
        key += '|' + (typeof window !== 'undefined' ? window.innerWidth : 0);   // a resize re-wraps row 2 without changing the visible set
        if (key !== this._ccKey) {
          this._ccKey = key;
          var bottom = dpUp ? dp.offsetHeight + 22 : 14;
          el.style.bottom = bottom + 'px';
          var fb = document.getElementById('formationBar');
          if (fb) fb.style.bottom = (bottom + el.offsetHeight + 8) + 'px';
        }
      }
    };
  }

  function installSpawn(P, SquadC) {
    /** Put a squad on the ground from a template.
     *
     *  `opts.men` overrides the template roster, which is how a squad that has
     *  taken casualties comes back onto the next map at the strength it left
     *  the last one — the campaign hands us the survivors, not the paper
     *  establishment. */
    P.spawnSquad = function (tmplId, team, cx, cz, opts) {
      var t = TEMPLATES[tmplId];
      if (!t) return null;
      opts = opts || {};
      var men = opts.men || t.men;
      if (!men || !men.length) return null;
      var self = this;
      var free = function (x, z) { return self.pathfinder.passable(x, z) && !self.unitAtCell(x, z); };
      // (round 111) `opts.spacing` cells between men: 2 is open order, the way
      // a stock map's deploy() lays a section down (round 110). 1, the
      // default, is the campaign's huddle round the point.
      var sp = opts.spacing > 1 ? opts.spacing : 1;
      var units = [];
      for (var i = 0; i < men.length; i++) {
        var placed = null;
        for (var r = 0; r < 50 && !placed; r++) {
          var steps = Math.max(1, r * 6);
          for (var a = 0; a < steps && !placed; a++) {
            var an = a / steps * 6.2832;
            var x = Math.round(cx + Math.cos(an) * r * sp), z = Math.round(cz + Math.sin(an) * r * sp);
            if (free(x, z)) placed = { x: x, z: z };
          }
        }
        if (!placed) continue;
        var u = this.addUnit(placed.x, placed.z, team, men[i]);
        if (u) units.push(u);
      }
      if (!units.length) return null;
      var sq = new SquadC(this, units);
      sq.ccInit();
      sq.tmpl = tmplId;
      sq.group = t.cat;
      sq.vet = opts.vet === undefined ? (t.vet === undefined ? 1 : t.vet) : opts.vet;
      sq.name = opts.name || t.name;
      sq.uid = opts.uid || null;
      sq.platoon = opts.platoon === undefined ? null : opts.platoon;
      sq.platoonName = opts.platoonName || null;
      // Establishment strength, not what turned up — a squad that deploys four
      // men out of nine must read as 4/9, because that is the fact the player
      // has to make a decision about.
      sq.initial = opts.initial || t.men.length;
      // VETERANCY NEVER REACHED THE SOLDIER. `_rollSoldier` is called exactly
      // once in the game, from the Unit constructor, with a hard-coded 1 —
      // under a comment promising a re-roll "once that is known". This is
      // where it becomes known. Without this line a Veteran Rifle Squad and a
      // green one were the same twelve men: same morale, same intelligence,
      // same experience, same officer. The `if` guard is because squads.js is
      // also loaded against Forge and editor unit objects.
      for (var k = 0; k < units.length; k++) {
        units[k]._vet = sq.vet;
        if (units[k]._rollSoldier) units[k]._rollSoldier(sq.vet);
      }
      this.squads.push(sq);
      return sq;
    };

    /** Select every squad in a platoon — the Close Combat unit of manoeuvre. */
    P.selectPlatoon = function (team, idx, add) {
      var out = [];
      for (var i = 0; i < this.squads.length; i++) {
        var sq = this.squads[i];
        if (sq.platoon !== idx) continue;
        var live = sq.effectives();
        if (live.length && live[0].team === team) out = out.concat(live);
      }
      if (!out.length) return;
      this.select(out, !!add);
      var cx = 0, cz = 0;
      for (i = 0; i < out.length; i++) { cx += out[i].pos.x; cz += out[i].pos.z; }
      if (this.cameraRig) this.cameraRig.target.set(cx / out.length, 0, cz / out.length);
    };
  }

  // =========================================================================
  // INSTALL
  // =========================================================================
  function install(api) {
    if (installed) return true;
    G = api;
    var Game = api.Game, Unit = api.Unit, Squad = api.Squad;
    if (!Game || !Unit || !Squad) throw new Error('Squads.install needs {Game, Unit, Squad}');

    patchSquad(Squad);
    patchUnit(Unit);
    patchGame(Game, Squad);
    installOrders(Game.prototype);
    installSpawn(Game.prototype, Squad);
    injectStyles();
    installed = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // SQUAD — the creature
  // -------------------------------------------------------------------------
  function patchSquad(Squad) {
    var P = Squad.prototype;

    /** Set up the fields the rest of this file depends on. Called lazily so a
     *  squad made by the stock `formSquad()` (J key) gets them too. */
    P.ccInit = function () {
      if (this._cc) return this;
      this._cc = true;
      this.fear = 0;
      this.state = 'steady';
      this.initial = this.members.length || 1;
      this.moveGoal = null;         // { x, z, mode, form, ang }
      this.task = 'Holding';
      this.bound = 0;               // which half is moving during overwatch
      this.boundT = 0;
      this.fireT = 0;               // time since the squad was last shot at
      this.routT = 0;
      this.name = this.name || null;
      this.group = this.group || 'rifle';
      this._tick = Math.random() * 0.25;
      return this;
    };

    /** Living members that can actually be commanded — not downed, not riding
     *  inside something, not a corpse waiting to fade. */
    P.effectives = function () {
      var out = [], m = this.members;
      for (var i = 0; i < m.length; i++) {
        var u = m[i];
        if (u.alive && !u.downed && !u.embarkedIn) out.push(u);
      }
      return out;
    };

    P.strength = function () {
      return this.effectives().length / Math.max(1, this.initial);
    };

    /** Mean suppression across the squad, weighted toward the worst-off man:
     *  one pinned soldier in a section of four is a section that is going to
     *  ground, not a section that is 25% suppressed. */
    /** How much fire is on this section right now, 0..1.
     *
     *  A SECTION IS NOT PINNED BECAUSE ONE MAN IS. The old weighting was
     *  `mean * 0.6 + worst * 0.4`, and `worst` is one man: a single grenadier
     *  caught in the open at full suppression contributed 0.4 all by himself,
     *  so eleven men went to ground because the twelfth was unlucky. Measured:
     *  that is how `1. Zug` reached pinned at 8/11 strength in two seconds.
     *
     *  What a section actually reads is how much of ITSELF is under fire, so
     *  the second term is the fraction of the men who are genuinely being shot
     *  at rather than the worst single case. One man of eleven now moves the
     *  number by a ninth, not by four tenths. */
    P.pressure = function () {
      var live = this.effectives();
      if (!live.length) return 1;
      var sum = 0, heavy = 0;
      for (var i = 0; i < live.length; i++) {
        var s = live[i].suppression || 0;
        sum += s;
        if (s > 0.5) heavy++;
      }
      return Math.min(1, (sum / live.length) * 0.7 + (heavy / live.length) * 0.3);
    };

    /** True while the squad's own state overrides the player's orders. */
    Object.defineProperty(P, 'locksOrders', {
      get: function () { return this.state === 'broken' || this.state === 'pinned'; },
      configurable: true,
    });

    P.moraleDef = function () { return MORALE_BY_ID[this.state] || MORALE[0]; };

    /** Issue an order to every member without the morale lock refusing it.
     *  Used by the rout and by rally behaviour, which must be able to move a
     *  squad that is by definition not taking orders. */
    P.internal = function (fn) {
      this._internalOrder = true;
      try { fn(); } finally { this._internalOrder = false; }
    };
  }

  // -------------------------------------------------------------------------
  // UNIT — three small hooks
  // -------------------------------------------------------------------------
  function patchUnit(Unit) {
    var P = Unit.prototype;

    // 1. A pinned or broken squad does not accept move orders. This is the
    //    single choke point for it: every path into movement — the player's
    //    click, the autopilot, the route controller, the AI — goes through
    //    orderMove, so one guard here covers all of them.
    var baseMove = P.orderMove;
    P.orderMove = function (wx, wz, keepQueue, mode) {
      var sq = this.squad;
      if (sq && sq._cc && sq.locksOrders && !sq._internalOrder) return;
      // A MEDIC ON A CASUALTY IS NOT AVAILABLE FOR THE FORMATION.
      //
      // Nothing in this file knows what a medic is, and everything in it moves
      // people: the closing-up slot, the rider screen, the overwatch arc, the
      // bound. Measured in round 43 with everything else cleared off the map, a
      // medic eight units from a dying man — no target, not held, not explicit
      // — walked AWAY from him to thirty units in seven seconds and the man
      // died, because `sq.internal(m.orderMove(slot))` had the last word every
      // tick. `Unit._thinkHeal` sets `_medicCase` while he is working; a
      // SQUAD-internal order does not move him while it is set.
      //
      // Two deliberate exceptions. A PLAYER order still goes through and drops
      // the case — the man giving orders outranks the man's own judgement, and
      // that is the whole contract of `explicit`. And a pinned or broken squad
      // is already handled above: a rout outranks first aid, because a man who
      // runs, runs.
      if (this._medicCase) {
        if (sq && sq._internalOrder) return;
        this._medicCase = null;
      }
      // An order the SQUAD gives itself — a rout, a bound, closing up — is not
      // the player speaking, and must not read as though it were.
      //
      // `explicit` means "a human spoke to this man". `_autoFree` tests it, and
      // NOTHING but another player order ever clears it again. So a rifleman on
      // your side who broke and ran had `explicit` set by his own rout, and was
      // then invisible to your auto-command for the rest of the battle: he
      // never rejoined his section, never took another order, and stood where
      // the rout left him. Measured on Hedgerow Hell: 111 m from his section,
      // last order 272 seconds earlier.
      var internal = !!(sq && sq._internalOrder);
      var wasExp = this.explicit, wasT = this._lastOrderT;
      // `apply(arguments)` rather than the four named parameters: the base
      // method grew a fifth (the destination STOREY, for the building layer)
      // and a wrapper that lists its arguments silently drops anything added
      // later — which is exactly how a section ordered upstairs all ended up
      // milling about on the ground floor.
      var r = baseMove.apply(this, arguments);
      if (internal) { this.explicit = wasExp; this._lastOrderT = wasT; }
      return r;
    };

    // 2. Suppression on one man is the squad's business. The stock code
    //    already echoes it to squadmates; this records WHEN, which is what
    //    tells a moving squad it is under fire and should start bounding.
    // …AND `apply`, NOT A NAMED LIST. The note twenty lines up says exactly
    // this about `orderMove` — "a wrapper that lists its arguments silently
    // drops anything added later" — and this wrapper then did it again: the
    // base method grew a third argument (`ambient`, which separates the crack
    // of passing fire from a shell landing; see `SUPP_FEAR_AMBIENT`) and this
    // swallowed it, so the whole change was inert wherever squads.js is
    // loaded, which is everywhere. Same file, same shape, twenty lines apart.
    var baseSupp = P.applySuppression;
    P.applySuppression = function (amt, noEcho) {
      var r = baseSupp.apply(this, arguments);
      if (amt > 0.04 && this.squad && this.squad._cc && this.game) this.squad.fireT = this.game.time;
      return r;
    };
  }

  // -------------------------------------------------------------------------
  // GAME — organisation, the tick, the orders, the roster
  // -------------------------------------------------------------------------
  function patchGame(Game, Squad) {
    var P = Game.prototype;

    // ---------------------------------------------------------------------
    // ORGANISATION
    // ---------------------------------------------------------------------
    /** Cut both sides' deployed units into squads. Idempotent and safe to call
     *  after any deployment; existing squads are dissolved first so a reload
     *  does not leave the old order of battle stapled to the new one. */
    P.organiseSquads = function () {
      for (var i = this.squads.length - 1; i >= 0; i--) {
        var sq = this.squads[i];
        for (var j = sq.members.length - 1; j >= 0; j--) sq.remove(sq.members[j]);
      }
      this.squads.length = 0;
      this._squadSeq = 0;
      this._organiseTeam(1);
      this._organiseTeam(2);
      return this.squads.length;
    };

    P._organiseTeam = function (team) {
      var all = this.units.filter(function (u) { return u.alive && u.team === team && !u.squad; });
      if (!all.length) return;
      var nation = (typeof G.nationOf === 'function') ? G.nationOf(all[0].type) : 'allied';
      var names = NAMING[nation === 'axis' ? 'axis' : 'allied'];
      var used = {};

      // Bucket by role.
      var byRole = {};
      for (var i = 0; i < all.length; i++) {
        var r = roleOf(all[i].def);
        (byRole[r] || (byRole[r] = [])).push(all[i]);
      }
      // Spatial coherence: a platoon should be men who deployed together, not
      // men who happen to share a weapon. Sorting each bucket along the axis
      // it is most spread out on makes consecutive chunks neighbours.
      for (var k in byRole) sortSpatially(byRole[k]);

      var self = this;
      // The section this army cuts. Taken from the men actually present, so a
      // mixed field gets each side's own establishment.
      var estab = (typeof G.estabOf === 'function') ? G.estabOf(all[0].type) : 10;
      var makeSquad = function (members, group) {
        if (!members.length) return null;
        var sq = new Squad(self, members);
        sq.ccInit();
        sq.group = group;
        sq.initial = members.length;
        var pool = names[group] || names.rifle;
        var n = used[group] = (used[group] || 0);
        sq.name = pool[n % pool.length] + (n >= pool.length ? ' (' + (Math.floor(n / pool.length) + 1) + ')' : '');
        used[group] = n + 1;
        self.squads.push(sq);
        return sq;
      };

      for (var s = 0; s < SHAPES.length; s++) {
        var shape = SHAPES[s];
        var shapeSize = shape.size === 'estab' ? estab : shape.size;
        // Pool the roles this shape claims, keeping them spatially ordered.
        var pool = [];
        for (var ri = 0; ri < shape.roles.length; ri++) {
          var b = byRole[shape.roles[ri]];
          if (b) { pool = pool.concat(b); byRole[shape.roles[ri]] = []; }
        }
        if (!pool.length) continue;
        sortSpatially(pool);
        var leaders = shape.lead ? (byRole[shape.lead] || []) : [];
        while (pool.length) {
          // MEN WHO CAN SEE EACH OTHER.
          //
          // Chunking a spatially sorted list in fours is nearly right, and was
          // wrong in exactly the case that matters: two anti-tank guns sited on
          // opposite flanks, or the only two mortars on the map, are one "AT
          // Section" a hundred and fifty metres across. Nothing can make that
          // behave like a section — it cannot move as one, its base of fire is
          // in two places, and the doctrine layer reads a centroid that is
          // standing in the open between them.
          //
          // So a section is grown from a man outward, taking the nearest
          // remaining man each time, and STOPPING when the next nearest is
          // further off than a section frontage. What is left starts another
          // section. Two guns far apart are now two sections, which is what
          // they are.
          var take = [pool.shift()];
          while (take.length < shapeSize && pool.length) {
            var cc = centroidOf(take), bi = -1, bd = Infinity;
            for (var pi = 0; pi < pool.length; pi++) {
              var pd = sqDist(pool[pi].pos, cc);
              if (pd < bd) { bd = pd; bi = pi; }
            }
            if (bi < 0 || bd > SECTION_SPAN * SECTION_SPAN) break;
            take.push(pool.splice(bi, 1)[0]);
          }
          // One officer per rifle platoon, nearest to the men.
          if (leaders.length) {
            var c = centroidOf(take), best = -1, bd = Infinity;
            for (var li = 0; li < leaders.length; li++) {
              var d = sqDist(leaders[li].pos, c);
              if (d < bd) { bd = d; best = li; }
            }
            // …and only if he is actually with them. Attached with no distance
            // check at all, the one officer on the map was posted to a platoon
            // on the other side of it and the section started the battle a
            // hundred and eighty metres across — before a shot was fired.
            if (best >= 0 && bd <= SECTION_SPAN * SECTION_SPAN * 2.25) take.push(leaders.splice(best, 1)[0]);
          }
          // …and its own support weapon, if one is going spare nearby.
          for (var ai = 0; ai < shape.attach.length; ai++) {
            var att = shape.attach[ai], src = byRole[att.role];
            if (!src || !src.length) continue;
            var c2 = centroidOf(take);
            for (var t = 0; t < att.n && src.length; t++) {
              var bi = 0, bd2 = Infinity;
              for (var xi = 0; xi < src.length; xi++) {
                var dd = sqDist(src[xi].pos, c2);
                if (dd < bd2) { bd2 = dd; bi = xi; }
              }
              // Only if it is genuinely with them — a machine gun 600 m away is
              // somebody else's machine gun, and so, it turns out, is one at
              // ninety metres: that was the old limit and it was wide enough to
              // staple a gun team to a platoon it could not support and could
              // not keep up with.
              if (bd2 > SECTION_SPAN * SECTION_SPAN * 2.25) break;
              take.push(src.splice(bi, 1)[0]);
            }
          }
          makeSquad(take, shape.group);
        }
        // Officers nobody claimed become a command element of their own.
        if (shape.lead && leaders.length) {
          byRole[shape.lead] = leaders;
        }
      }
      // Anything left over — spare officers, unrecognised roles — is still a
      // squad. A unit outside the roster is a unit the player cannot find.
      var rest = [];
      for (var kk in byRole) if (byRole[kk] && byRole[kk].length) rest = rest.concat(byRole[kk]);
      sortSpatially(rest);
      while (rest.length) makeSquad(rest.splice(0, 3), 'weapons');
    };

    // ---------------------------------------------------------------------
    // THE TICK — cohesion, morale, bounding, rout. 4 Hz, over squads.
    // ---------------------------------------------------------------------
    /** `force` EXISTS FOR THE HEADLESS PROBES, AND THE REASON IS A BUG THAT HID
     *  AN ENTIRE LAYER OF THE GAME FROM EVERY MEASUREMENT WE HAVE TAKEN.
     *
     *  `squadTick` runs from `Game._loop`, not from `stepSim`, and every probe
     *  in `tools/` knows that and calls it explicitly. Every probe ALSO sets
     *  `game.paused = true`, because that stops the real loop stepping the
     *  simulation a second time and makes a headless run about five times
     *  faster. The guard below then returned immediately, so the explicit call
     *  did nothing: measured 749 calls to `_squadMorale` and
     *  `_squadSurrenderCheck` over 300 steps unpaused, and **zero** over the
     *  same 300 steps paused.
     *
     *  Everything in this function was therefore absent from every headless
     *  measurement ever taken here: squad morale, the surrender check, section
     *  cohesion. A census that reported "nobody ever surrenders" was reporting
     *  that nobody ever ASKED. (The doctrine layer is unaffected — `_squadTask`
     *  and friends run from `_aiDoctrine` inside `stepSim`.)
     *
     *  The game's own behaviour is unchanged: `_loop` calls this without
     *  `force` and a paused game still ticks no squads. */
    P.squadTick = function (dt, force) {
      // The roster is redrawn in EVERY mode. Behind the early-out below it was
      // never told to hide, so its header sat over the editor for the whole
      // session with nothing in it.
      if (this.ui && this._sqRosterT !== undefined) {
        this._sqRosterT -= dt;
        if (this._sqRosterT <= 0) { this._sqRosterT = 0.35; this._drawSquadRoster(); this._refreshOrderBar(); }
      }
      if (this.mode !== 'play' || (this.paused && !force)) return;
      for (var i = this.squads.length - 1; i >= 0; i--) {
        var sq = this.squads[i];
        if (!sq._cc) sq.ccInit();
        sq._tick -= dt;
        if (sq._tick > 0) continue;
        // (round 108) EACH SECTION ON ITS OWN BEAT. Reset to 0.25 the beat was
        // lost at every long frame: every section due inside it ticked on the
        // same frame and stayed together after, so a battle's hitches herded
        // the sections into a few lumps — 320 of them in five, 1.5-2.2 ms on
        // one frame in three and nothing between. Carried, a section keeps the
        // phase it was given (`_tick` at creation) and the cost stays even.
        sq._tick += 0.25;
        if (!(sq._tick > 0)) sq._tick = 0.25;
        var live = sq.effectives();
        if (!live.length) {
          // Wiped out. A terminal state, not a rung — otherwise the roster
          // reports a section with nobody left in it as "PINNED", which is
          // the last state it happened to be in when the last man fell.
          sq.state = 'destroyed'; sq.task = 'Destroyed'; sq.fear = 1;
          continue;
        }
        this._squadMorale(sq, live, 0.25);
        // …and the other end of the ladder. Checked after the morale so it
        // sees this tick's state, and before the cohesion layer, which has
        // nothing to say to men who have stopped fighting.
        if (this._squadSurrenderCheck(sq, live, 0.25)) continue;
        if (sq._gaveUp) continue;
        // The section the player is RIDING conforms to him instead of to a
        // move goal — see `_riderSupport`. It returns true when it has taken
        // the squad, and then the cohesion layer must not also speak.
        if (this._riderSupport(sq, live, 0.25)) continue;
        this._squadCohesion(sq, live, 0.25);
      }
    };

    /** Morale: one number, moved slowly, read as a state.
     *
     *  THIS LADDER AND THE MAN'S LADDER WERE TWO SEPARATE GAMES. `_deriveCC`
     *  in the main file is the Close Combat model — five rolled attributes, a
     *  seven-rung condition ladder, a beat between rungs — and this ran beside
     *  it reading none of it. Measured before the fix (tools/probe_morale.js):
     *  the man's ladder never left `steady` over five minutes and twenty-one
     *  dead, while this one took `1. Zug` from steady to PINNED in TWO SECONDS
     *  at 73% strength, and broke `1st Platoon` at 6/14. One ladder was inert
     *  and the other was a hair trigger, and it was the hair trigger the player
     *  saw, because this is the one that puts the toast on the screen and
     *  refuses the order.
     *
     *  So the squad number now READS THE MEN. Their own condition, their own
     *  fear and the quality they were rolled with all feed it, which is what
     *  makes a Fallschirmjäger section and a Volksgrenadier section take the
     *  same fire and do different things about it — and it falls one rung at a
     *  time, on the same principle as `_deriveCC`. */
    P._squadMorale = function (sq, live, dt) {
      var strength = live.length / Math.max(1, sq.initial);
      var pressure = sq.pressure();
      // …and a section whose commander has just been hit and whose next man
      // has not yet taken over is worse off than one with no leader at all,
      // because nobody is even trying to hold it together (Squad._pickLeader).
      var leader = sq.leader && sq.leader.alive && !sq.leader.downed && !sq.leaderless;

      // Steadying influences: an officer in earshot, and cover underfoot.
      var officer = 0, cover = 0;
      for (var i = 0; i < live.length; i++) {
        if (live[i]._coverValue) cover += Math.min(1, live[i]._coverValue() || 0);
      }
      cover /= live.length;
      var c = sq.centroid();
      if (c) {
        // (round 107) the side's officers (`Game._auraUnits`), not every man on the field
        var aura = this._auraUnits ? this._auraUnits(live[0].team) : this.units;
        for (var j = 0; j < aura.length; j++) {
          var o = aura[j];
          if (!o.alive || o.team !== live[0].team || !o.def.aura) continue;
          if (sqDist(o.pos, c) < 40 * 40) { officer = 1; break; }
        }
      }

      // The target the squad's fear is heading for.
      //
      // Calibration, which took a pass to get right — the first weights had a
      // section with every man at 90% suppression AND half its strength gone
      // sitting at "nervous", which is not what that section is doing. The
      // anchors now are: everyone suppressed, officer present = shaken;
      // everyone suppressed with the leader dead = pinned; half strength on
      // top of that = pinned to broken. Casualties leave a permanent residue —
      // a platoon at 40% never comes all the way back to steady, because it
      // shouldn't.
      // Veterancy and training. A Fallschirmjäger squad and a Volksgrenadier
      // reserve squad take the same fire and do not do the same thing about
      // it, and that difference is most of what "historically conditioned"
      // means once the shooting starts.
      var green = 0;
      for (var gi = 0; gi < live.length; gi++) if (live[gi].def.green) green++;
      green /= live.length;
      var vet = (sq.vet === undefined ? 1 : sq.vet) - 1;      // -1 green, 0 regular, +1 veteran

      // THE MEN THEMSELVES. Three numbers off the per-soldier ladder, which
      // this function previously did not look at once:
      //   down   — the fraction who have personally lost it (cowering or below)
      //   mfear  — how frightened the ones still fighting are
      //   steel  — the morale and experience they were ROLLED with. This is
      //            the bridge: `_rollSoldier` spreads five attributes over a
      //            section precisely so that some men hold when others do not,
      //            and until now the squad state threw all of it away.
      // …AND `down` READ A LADDER THAT IS DELIBERATELY INERT, SO A THIRD OF
      // THIS FORMULA'S RANGE COULD NEVER BE DELIVERED.
      //
      // `ccState` is the per-man Close Combat ladder. The main file's own note
      // above `CCLADDER` records that it never leaves `steady` — "no man left
      // `steady` in 300 seconds across 92 men" — and that it is left that way
      // ON PURPOSE, because round 41 tuned the fear budget down and because
      // `suppState` already models what it would buy. That decision was right
      // and it had a consequence nobody could see: `down` is ALWAYS ZERO here,
      // so 0.34 of this target — plus 0.22 more through `mfear` — is dead
      // weight, and this ladder cannot reach `shaken` at all.
      //
      // Measured with every man pinned at full suppression, in cover, leader
      // and officer present: `pressure * 0.62` = 0.581 is the ONLY positive
      // term, the cover and officer discounts take it to **0.38**, and the
      // section sits at `cautious`. The comment fifty lines up states the
      // anchor for exactly that case as `shaken`. Across a whole battle on
      // Chambois Corridor — the Falaise pocket — 14,656 of 14,680 surrender
      // checks were refused for `notShaken`, so surrender, which the manual
      // calls "the reward for encirclement", had never once fired.
      //
      // (None of this was visible until `squadTick` stopped returning early in
      // headless probes — see the `force` argument on it.)
      //
      // The fix is the one `CCLADDER`'s note prescribes: **make the two
      // ladders one, and read the signal the game actually produces.** A man
      // held at `Pinned` — suppression at or above 0.82, face in the dirt — has
      // personally lost it in precisely the sense this term means. Not
      // double-counting: the per-man `fire` multiplier and the section's state
      // are different consumers of the same fact.
      //
      // It lands on the documented anchors without moving a single weight:
      // everyone pinned -> 0.38 + 0.34 = 0.72 = shaken, and with the leader
      // gone and half the strength lost -> broken.
      var down = 0, mfear = 0, steel = 0;
      for (var mi2 = 0; mi2 < live.length; mi2++) {
        var mu = live[mi2];
        if (CC_DOWN[mu.ccState] || mu.suppState === 'Pinned') down++;
        mfear += Math.min(1, mu.fear || 0);
        steel += (mu.aMorale === undefined ? 0.45 : mu.aMorale) * 0.55
               + (mu.aExp === undefined ? 0.4 : mu.aExp) * 0.45;
      }
      down /= live.length; mfear /= live.length; steel /= live.length;

      // CASUALTIES: A SHOCK, THEN A RESIDUE. Losing five men in ten seconds is
      // an event; losing five over ten minutes is attrition, and a section
      // that has been ground down all morning is tired, not panicking. The old
      // term knew only the ratio, so a platoon at 6/14 carried a permanent
      // 0.30 of fear whether it had lost them in one burst or over an hour —
      // which is most of why sections "broke too easily" after a bad start.
      var lost = Math.max(0, (sq._lastLive === undefined ? live.length : sq._lastLive) - live.length);
      sq._lastLive = live.length;
      sq.shock = (sq.shock || 0) * Math.pow(0.5, dt / 14) + lost / Math.max(4, sq.initial);
      if (sq.shock > 1) sq.shock = 1;
      // …and the memory of a mate breaking fades too, or a section that has
      // been through one bad minute is deaf to the next one forever.
      if (sq._brokeN) sq._brokeN = sq._brokeN * Math.pow(0.5, dt / 30);

      // (round 114) "less panic and running away" (the user): every term that
      // pushes a section toward breaking is cut by about a fifth to a third. A
      // section under heavy fire still goes to ground (`nervous`, `shaken`,
      // `pinned`); it takes losses and a lost leader to make it run.
      var N14 = this.nerve114 !== false;
      var target = pressure * (N14 ? 0.5 : 0.62)
        + down * (N14 ? 0.26 : 0.34)                   // how many have actually lost it
        + mfear * (N14 ? 0.17 : 0.22)                  // …and how close the rest are
        + sq.shock * (N14 ? 0.3 : 0.42)                // men lost in the last quarter-minute
        + Math.pow(1 - strength, 1.6) * (N14 ? 0.18 : 0.26)   // the worn-down residue
        + (leader ? 0 : (N14 ? 0.1 : 0.16))            // ONE leader term, not two
        + green * 0.08
        - vet * 0.12
        - officer * 0.12
        - cover * 0.12
        - (steel - 0.45) * 0.55;                       // the men are soldiers, and tough
      target = Math.max(0, Math.min(1, target));

      // Fear rises fast and falls slowly — men are frightened in a second and
      // recover over a minute — and rally faster with a leader in earshot.
      // "Fast" was `1.9`, which at the 4 Hz tick closes 47% of the gap every
      // quarter second: the number reached its target in about a second, and a
      // squad crossed four rungs in two. Fast is not instant.
      var rise = 0.5, fall = (N14 ? 0.095 : 0.055) * (leader ? 1.4 : 1) * (officer ? 1.5 : 1);
      var k = target > sq.fear ? rise : fall;
      sq.fear += (target - sq.fear) * Math.min(1, k * dt);

      // A squad that has broken stays broken for a while whatever the numbers
      // say. Men who have run do not turn round because the shooting stopped
      // twelve seconds ago, and a rout that rallies instantly is not a rout.
      if (sq.state === 'broken' && (this.time - sq.routT) < (N14 ? 14 : 25)) {
        sq.fear = Math.max(sq.fear, MORALE[5].enter);
      }

      // Ladder with hysteresis.
      var want = 'steady';
      for (var m = MORALE.length - 1; m >= 0; m--) {
        if (sq.fear >= MORALE[m].enter) { want = MORALE[m].id; break; }
      }
      if (RANK[want] < RANK[sq.state]) {
        var cur = MORALE_BY_ID[sq.state];
        if (sq.fear > cur.enter - HYST) want = sq.state;      // not out of it yet
      }
      // ONE RUNG AT A TIME, ON A BEAT — the same rule `_deriveCC` applies to
      // the individual soldier, and for the same reason. Without it a section
      // whose number moved went steady -> cautious -> nervous -> shaken ->
      // pinned in consecutive ticks, which is one second, and the player saw a
      // squad that was fighting simply stop.
      if (RANK[want] > RANK[sq.state]) {
        var beat = RUNG_DWELL * (1 + RANK[sq.state] * 0.4);
        if (this.time - (sq._rungT || -99) < beat) want = sq.state;
        else {
          for (var nx = 0; nx < MORALE.length; nx++) {
            if (RANK[MORALE[nx].id] === RANK[sq.state] + 1) { want = MORALE[nx].id; break; }
          }
        }
      }
      // BROKEN IS A DECISION, NOT A THRESHOLD. A section standing at the edge
      // of it may hold, and whether it does is its leader, its officer and the
      // men — which is the whole Close Combat argument. Rolled per second off
      // a clock the squad owns, so the 4 Hz tick does not multiply it.
      if (want === 'broken' && sq.state !== 'broken') {
        var hold = (N14 ? 0.4 : 0.2) + (leader ? 0.26 : 0) + officer * 0.22 + steel * 0.5 + Math.max(0, vet) * 0.1;
        if (Math.random() >= SQ_ROUT_RATE * (N14 ? 0.45 : 1) * dt * (1 - Math.min(0.93, hold))) want = 'pinned';
      }
      if (want !== sq.state) { sq._rungT = this.time; this._squadStateChange(sq, sq.state, want, live); }
    };

    /** What actually happens when a squad's state changes. This is where the
     *  morale number stops being a number. */
    P._squadStateChange = function (sq, from, to, live) {
      sq.state = to;
      var i;
      if (to === 'shaken') {
        // Stops attacking, goes to ground where it stands, keeps firing.
        sq.moveGoal = null;
        sq.internal(function () {
          for (i = 0; i < live.length; i++) if (live[i].orderTakeCover) live[i].orderTakeCover();
        });
        sq.task = 'Taking cover';
      } else if (to === 'pinned') {
        sq.moveGoal = null;
        sq.internal(function () {
          for (i = 0; i < live.length; i++) {
            if (live[i].orderStop) live[i].orderStop();
            if (live[i].orderProne) live[i].orderProne();
          }
        });
        sq.task = 'PINNED';
        if (live[0] && live[0].team === this.playerTeam && this.ui)
          this.ui.toast((sq.name || 'Squad') + ' is pinned down');
      } else if (to === 'broken') {
        this._squadRout(sq, live);
      } else if (from === 'broken' || from === 'pinned') {
        // Rallied. Stand up, but do not go anywhere until told.
        sq.internal(function () {
          for (i = 0; i < live.length; i++) if (live[i]._setPosture) live[i]._setPosture('normal');
        });
        sq.task = 'Rallied';
        if (live[0] && live[0].team === this.playerTeam && this.ui)
          this.ui.toast((sq.name || 'Squad') + ' has rallied');
      } else {
        sq.task = sq.moveGoal ? 'Advancing' : 'Holding';
      }
    };

    /** A broken squad runs. Not randomly — toward its own baseline, which is
     *  the edge of the map its side deployed nearest to. It sheds its orders,
     *  refuses new ones, and drops smoke if it has any. */
    P._squadRout = function (sq, live) {
      var c = sq.centroid();
      if (!c) return;
      // Away from the nearest enemy, biased toward friendly rear.
      var ex = 0, ez = 0, n = 0;
      for (var i = 0; i < this.units.length; i++) {
        var e = this.units[i];
        if (!e.alive || e.team === live[0].team || e.team === 0) continue;
        if (sqDist(e.pos, c) > 160 * 160) continue;
        ex += e.pos.x; ez += e.pos.z; n++;
      }
      var ax, az;
      if (n) { ax = c.x - (ex / n - c.x); az = c.z - (ez / n - c.z); }
      else { ax = sq._homeX !== undefined ? sq._homeX : c.x; az = sq._homeZ !== undefined ? sq._homeZ : c.z; }
      var dx = ax - c.x, dz = az - c.z, d = sqHyp(dx, dz) || 1;
      // (round 114) a run for the next hedge, not for the map's edge
      var runD = this.nerve114 !== false ? 36 : 70;
      var tx = c.x + dx / d * runD, tz = c.z + dz / d * runD;
      sq.moveGoal = null;
      sq.routT = this.time;
      sq.internal(function () {
        for (var j = 0; j < live.length; j++) {
          var u = live[j];
          if (u._setPosture) u._setPosture('normal');
          u.orderMove(tx + (Math.random() - 0.5) * 16, tz + (Math.random() - 0.5) * 16, false, 'fast');
        }
      });
      sq.task = 'ROUTING';
      if (live[0].team === this.playerTeam && this.ui) this.ui.toast((sq.name || 'Squad') + ' has broken!');
      if (this.sfx && this.sfx.order) this.sfx.order();
    };

    /** HANDS UP.
     *
     *  The morale ladder ended at `routed`, and `routed` meant a man ran
     *  toward his own rear for ever. That is one of the two things a broken
     *  section did in 1944 and it is not the commoner one. A great many more
     *  men went into the bag than were shot: a section whose position is
     *  hopeless, whose officer is down, that is out of ammunition and has
     *  enemy within a stone's throw and nobody of its own behind it, put its
     *  hands up — and every company commander on both sides spent the war
     *  trying to produce exactly that situation rather than a firefight.
     *
     *  So it is the terminus of the same ladder, and it needs all four of the
     *  conditions that actually produced it:
     *
     *    BROKEN      — the section has already come apart (`_squadMorale`).
     *    CUT OFF     — nobody of theirs within supporting distance. A section
     *                  with friends behind it fights or runs to them.
     *    SURROUNDED  — the enemy is CLOSE. You cannot surrender to a machine
     *                  gun four hundred metres away; somebody has to be near
     *                  enough to take you, and near enough that running is no
     *                  longer on offer.
     *    NO WAY OUT  — dry, or leaderless, or so badly cut about that the odds
     *                  are hopeless. One of the three is enough.
     *
     *  Rolled per second like the rout, against the same things that hold a
     *  section together, so good troops under a good leader go into the bag
     *  last and green troops with nobody in charge go first. */
    P._squadSurrenderCheck = function (sq, live, dt) {
      // SHAKEN IS ENOUGH, and requiring `broken` made this unreachable. Tested
      // with a section of eight genuinely cut off and closed on by twenty: it
      // was WIPED OUT without ever surrendering, because a section now needs
      // eighteen seconds of unrelieved pressure to walk the ladder to `broken`
      // and a hopeless position does not last that long. Men did not wait to
      // come apart before putting their hands up — they put them up when the
      // position was plainly untenable and somebody was standing over them,
      // which is `shaken` and below. How far down they are scales the roll.
      if (sq._gaveUp) return false;
      var rank = RANK[sq.state] || 0;
      if (rank < RANK.shaken) return false;
      var c = sq.centroid();
      if (!c) return false;
      var team = live[0].team;
      var nearEnemy = 0, nearFriend = 0, i, u;
      for (i = 0; i < this.units.length; i++) {
        u = this.units[i];
        if (!u.alive || u.downed || u.team === 0 || u.crewBailed) continue;
        var d2 = sqDist(u.pos, c);
        if (u.team === team) { if (u.squad !== sq && d2 < SURRENDER_HELP * SURRENDER_HELP) nearFriend++; }
        else if (d2 < SURRENDER_NEAR * SURRENDER_NEAR) nearEnemy++;
      }
      if (!nearEnemy || nearFriend) return false;          // nobody to give up to, or help is at hand
      var dry = sq._ammoState === 'dry';
      var leaderless = !(sq.leader && sq.leader.alive && !sq.leader.downed) || sq.leaderless;
      var cutAbout = live.length <= Math.max(1, Math.round((sq.initial || live.length) * 0.45));
      if (!dry && !leaderless && !cutAbout) return false;   // still a going concern
      // What holds them: the men they were rolled as, whoever is still giving
      // orders, and how badly they are outnumbered on the spot.
      var steel = 0;
      for (i = 0; i < live.length; i++) {
        u = live[i];
        steel += (u.aMorale === undefined ? 0.45 : u.aMorale) * 0.55
               + (u.aExp === undefined ? 0.4 : u.aExp) * 0.45;
      }
      steel /= live.length;
      var odds = nearEnemy / Math.max(1, live.length);
      var hold = 0.25 + steel * 0.6 + (leaderless ? 0 : 0.2) - Math.min(0.3, odds * 0.12);
      // A shaken section is a long way from giving up; a broken one is not.
      var deep = 1 + (rank - RANK.shaken) * 0.9;
      if (Math.random() >= SURRENDER_RATE * deep * dt * (1 - Math.min(0.95, hold))) return false;
      this._squadSurrender(sq, live);
      return true;
    };

    /** They put their weapons down and are out of the battle. */
    P._squadSurrender = function (sq, live) {
      sq._gaveUp = true;
      sq.state = 'broken';          // whatever rung they were on, they are done
      sq.task = 'SURRENDERED';
      var self = this;
      sq.internal(function () {
        for (var i = 0; i < live.length; i++) {
          var u = live[i];
          u.surrendered = true;
          u.target = null; u.groundAtk = null; u.path = []; u.queue = [];
          u.hold = true; u.explicit = false;
          if (u._setPosture) u._setPosture('normal');
          if (u.orderStop) u.orderStop();
          // Out of the fight, and stays out: `_handsUpT` runs the short beat in
          // which they stand up and are taken, then they leave the field.
          u._handsUpT = SURRENDER_SHOW;
        }
      });
      var mine = live[0].team === this.playerTeam;
      if (this.ui) {
        this.ui.toast(mine ? (sq.name || 'A section') + ' has surrendered'
                           : (sq.name || 'A section') + ' is surrendering — ' + live.length + ' prisoners',
                      mine ? 'bad' : 'good');
      }
      // TAKING PRISONERS IS GOOD FOR THE MEN, and watching your neighbours go
      // into the bag is not. Both are the same event seen from two sides.
      for (var j = 0; j < this.units.length; j++) {
        var o = this.units[j];
        if (!o.alive || o.def.vehicle) continue;
        var d = sqHyp(o.pos.x - live[0].pos.x, o.pos.z - live[0].pos.z);
        if (d > 34) continue;
        if (o.team === live[0].team) { if (o.addFear) o.addFear(0.18 * (1 - d / 34), 'they gave up'); }
        else if (o.fear !== undefined) { o.fear = Math.max(0, o.fear - 0.22 * (1 - d / 34)); if (o._deriveCC) o._deriveCC(); }
      }
    };

    /** Cohesion + bounding overwatch. Runs only for squads with a live move
     *  goal, so a dug-in defence costs nothing. */
    P._squadCohesion = function (sq, live, dt) {
      if (sq.locksOrders) return;
      var goal = sq.moveGoal;
      if (!goal) {
        // A section under the commander's doctrine layer (`Game._squadRun`)
        // writes its own task line — do not overwrite it with 'Holding'.
        if (!sq._task && (sq.task === 'Advancing' || sq.task === 'Bounding')) sq.task = 'Holding';
        // A Close Combat move ends in a posture (`Unit._updateMove`: Sneak in
        // Ambush, Move and Move Fast in Defend). Once nobody is still walking,
        // the roster says which, instead of 'Sneaking' for the rest of the day.
        else if (!sq._task && (sq.task === 'Moving' || sq.task === 'Running' || sq.task === 'Sneaking')
                 && !live.some(function (u) { return u.path && u.path.length; })) {
          sq.task = live.some(function (u) { return u.posture === 'ambush'; }) ? 'Ambush'
            : live.some(function (u) { return u.posture === 'defend'; }) ? 'Defending' : 'Holding';
        }
        return;
      }
      var arrived = 0, far = null, farD = 0;
      var cx = 0, cz = 0;
      for (var i = 0; i < live.length; i++) { cx += live[i].pos.x; cz += live[i].pos.z; }
      cx /= live.length; cz /= live.length;
      for (i = 0; i < live.length; i++) {
        var u = live[i];
        var dg = sqHyp(u.pos.x - goal.x, u.pos.z - goal.z);
        if (dg < goal.spread + 6) arrived++;
        var db = sqHyp(u.pos.x - cx, u.pos.z - cz);
        if (db > farD) { farD = db; far = u; }
      }
      // Everybody home: the order is complete.
      if (arrived >= Math.ceil(live.length * 0.8)) {
        sq.moveGoal = null;
        // …and what they are doing there: Close Combat ends a Sneak in Ambush
        // and a Move or a Move Fast in Defend (`Unit._updateMove`).
        sq.task = goal.mode === 'sneak' ? 'Ambush' : 'Defending';
        return;
      }

      var underFire = (this.time - (sq.fireT || -99)) < 4;
      if (underFire && live.length >= 3 && goal.mode !== 'sneak') {
        this._squadBound(sq, live, goal);
        return;
      }

      sq.task = 'Advancing';
      // Straggler control. Someone a long way off the centre is told to hurry;
      // if the squad is genuinely strung out, the front waits.
      var COH = goal.spread * 2.2 + 14;
      if (far && farD > COH) {
        var behind = distToGoal(far, goal) > distToGoal({ pos: { x: cx, z: cz } }, goal);
        if (behind && far.moveMode !== 'fast' && far.state === 'move') {
          far.moveMode = 'fast';
          sq.task = 'Closing up';
        } else if (!behind && !far._sqWait) {
          // The leading man is out in front on his own — hold him.
          sq.internal(function () { if (far.orderStop) far.orderStop(); });
          far._sqWait = true;
          far._sqWaitT = this.time;
          sq.task = 'Waiting for stragglers';
        }
      }
      // Anyone halted for the rear gets moving again once they have closed
      // up — or after eight seconds regardless. Without the timeout a squad
      // whose rear element is dead or pinned leaves its point man standing in
      // the open forever waiting for men who are never coming.
      for (i = 0; i < live.length; i++) {
        var m = live[i];
        if (!m._sqWait) continue;
        var closed = sqHyp(m.pos.x - cx, m.pos.z - cz) <= COH * 0.75;
        var timedOut = (this.time - (m._sqWaitT || 0)) > 8;
        if (!closed && !timedOut) continue;
        m._sqWait = false;
        var slot = (goal.slots && goal.slots[i % goal.slots.length]) || goal;
        sq.internal(function () { m.orderMove(slot.x, slot.z, false, goal.mode); });
      }
      if (sq.task === 'Waiting for stragglers' && !live.some(function (u) { return u._sqWait; })) sq.task = 'Advancing';
    };

    // ---------------------------------------------------------------------
    // SUPPORTING THE MAN YOU ARE RIDING
    // ---------------------------------------------------------------------
    //
    // Taking direct control of one soldier used to strand his section. Every
    // autonomous layer in the game reads "the player is handling this squad"
    // and steps back, so the player drove one man forward and the other eleven
    // stood exactly where they had been left.
    //
    // A section does not work like that. The man in front is its point, and
    // the rest of it CONFORMS to him: they watch what he watches, they shoot at
    // what he shoots at, they move when he moves, and they do not walk past
    // him. That is fire-and-movement seen from inside one rifleman.
    //
    // Three jobs, chosen by what is actually happening to him:
    //
    //   FOLLOW     he is moving and nobody is shooting — a wedge in his lee, at
    //              his pace, echeloned so that nobody masks his fire and nobody
    //              gets in front of the point man.
    //   OVERWATCH  he has stopped — they go firm in an arc facing his sightline
    //              and take whatever cover is under them.
    //   SUPPORT    he is in contact — the BASE OF FIRE goes down where it
    //              stands and shoots at what is shooting at him; the MANOEUVRE
    //              element works round the flank of it. Smoke if he is pinned.
    //
    // Whichever it is, the section is marked `_riderSupT` so the commander's
    // doctrine layer leaves it alone (`Unit._autoFree`) — otherwise the AI
    // would order the same men somewhere else half a second later.
    // Distances are in world units; a rifle reaches 120 of them and a squad's
    // own cohesion tether is 22 (`SQUAD_TETHER.move`). The wedge is sized to
    // sit INSIDE that tether — the first cut put the tail man 34 units back,
    // outside his own section's cohesion radius, and the straggler logic then
    // spent the whole advance telling him to hurry up.
    var RIDER = {
      lead: 5,        // how far behind the point man the wedge starts
      rank: 1.7,      // and how much deeper each rank sits
      spread: 2.6,    // lateral spacing between files
      hold: 9,        // overwatch arc radius
      reissue: 4.5,   // a follower re-paths when his slot has moved this far
      fireArc: 0.55,  // radians off the rider's sightline that counts as "his target"
      contact: 3.5,   // seconds since the section was shot at that still counts as contact
      see: 130,       // furthest a threat is worth calling a threat (rifle reach)
    };

    /** True if this squad is the one being ridden, and it has been handled. */
    P._riderSupport = function (sq, live, dt) {
      var f = this.fpv;
      if (!f || !f.unit || !f.unit.alive) return false;
      var rider = f.unit;
      if (live.indexOf(rider) < 0) return false;
      var others = [], i;
      for (i = 0; i < live.length; i++) if (live[i] !== rider && !live[i].embarkedIn) others.push(live[i]);
      // Mark the whole section as spoken-for whatever happens below, so the
      // commander's doctrine does not pick these men up between ticks.
      var now = this.time;
      for (i = 0; i < others.length; i++) others[i]._riderSupT = now;
      sq.moveGoal = null;                      // the rider IS the goal now
      if (!others.length) { sq.task = 'Point man (alone)'; return true; }

      // Where he is looking, and how fast he is going.
      var yaw = f.yaw || 0;
      var lx = Math.sin(yaw), lz = Math.cos(yaw);
      var aim = null;
      try { if (this._fpvAimPoint) aim = this._fpvAimPoint(); } catch (e) { aim = null; }
      if (aim) {
        var ax = aim.x - rider.pos.x, az = aim.z - rider.pos.z;
        var al = sqHyp(ax, az);
        if (al > 2) { lx = ax / al; lz = az / al; }
      }
      var moving = !!(f.moveInput || (rider.vel && sqHyp(rider.vel.x || 0, rider.vel.z || 0) > 0.6)
        || (rider._spd !== undefined && rider._spd > 0.6));
      if (rider._lastPos === undefined) rider._lastPos = { x: rider.pos.x, z: rider.pos.z, t: now };
      if (now - rider._lastPos.t > 0.2) {
        var trav = sqHyp(rider.pos.x - rider._lastPos.x, rider.pos.z - rider._lastPos.z);
        moving = trav / (now - rider._lastPos.t) > 0.8;
        rider._lastPos = { x: rider.pos.x, z: rider.pos.z, t: now };
        rider._riderMoving = moving;
      } else moving = !!rider._riderMoving;

      // Is he in contact? Either the section has been shot at recently, or he
      // has fired, or something hostile is close enough to matter.
      var threat = this._riderThreat(rider, live, lx, lz);
      var shotAt = (now - (sq.fireT || -99)) < RIDER.contact;
      var fired = (now - (rider._lastShotT || -99)) < RIDER.contact;
      var inContact = !!threat && (shotAt || fired || rider.suppression > 0.2);

      if (inContact) this._riderFireSupport(sq, rider, others, threat, lx, lz);
      else if (moving) this._riderFollow(sq, rider, others, lx, lz);
      else this._riderOverwatch(sq, rider, others, lx, lz);
      return true;
    };

    /** What is he up against? The enemy nearest his sightline that somebody in
     *  the section can actually see — his own eyes first, then theirs, because
     *  a section shoots at what its point man is shooting at even when only he
     *  can see it. */
    P._riderThreat = function (rider, live, lx, lz) {
      var best = null, bestScore = Infinity, i, j;
      var foes = this.unitGrid ? this.unitGrid.enemiesOf(rider.team) : this.units;
      for (i = 0; i < foes.length; i++) {
        var e = foes[i];
        if (!e.alive || e.downed || e.embarkedIn) continue;
        if (this.isFoe && !this.isFoe(e) && e.team === rider.team) continue;
        var dx = e.pos.x - rider.pos.x, dz = e.pos.z - rider.pos.z;
        var d = sqHyp(dx, dz);
        if (d > RIDER.see || d < 0.01) continue;
        // Angle off his sightline — a man he is looking straight at wins.
        var cos = (dx / d) * lx + (dz / d) * lz;
        var off = Math.acos(Math.max(-1, Math.min(1, cos)));
        var seen = this.hasLOS(rider, e);
        if (!seen) {
          for (j = 0; j < live.length; j++) if (this.hasLOS(live[j], e)) { seen = true; break; }
        }
        if (!seen) continue;
        // Straight ahead and close beats off to a flank and far.
        var score = d * (off < RIDER.fireArc ? 0.35 : 1) + off * 26;
        if (score < bestScore) { bestScore = score; best = e; }
      }
      return best;
    };

    /** A wedge in his lee. Nobody gets in front of the point man. */
    P._riderFollow = function (sq, rider, others, lx, lz) {
      sq.task = 'Following point';
      var rx = -lz, rz = lx;                       // right of his line of march
      var mode = rider.moveMode === 'fast' || (this.fpv && this.fpv.sprint) ? 'fast'
        : (rider.posture === 'prone' || rider.posture === 'hide' || (this.fpv && this.fpv.stance === 'prone')) ? 'sneak'
        : 'normal';
      var self = this;
      sq.internal(function () {
        for (var i = 0; i < others.length; i++) {
          var u = others[i];
          // Alternate files, deepening — a wedge, and the deeper a man is the
          // wider he sits, so the section can all shoot forward at once.
          var rank = Math.floor(i / 2) + 1;
          var side = (i & 1) ? 1 : -1;
          var back = RIDER.lead + rank * RIDER.rank;
          var out = side * (RIDER.spread * (0.5 + rank * 0.35));
          var tx = rider.pos.x - lx * back + rx * out;
          var tz = rider.pos.z - lz * back + rz * out;
          var d = sqHyp(u.pos.x - tx, u.pos.z - tz);
          if (d < RIDER.reissue && u.path && u.path.length) continue;
          if (d < 2.2) continue;
          // A man badly behind closes at a run whatever the rider is doing.
          u.moveMode = d > 26 ? 'fast' : mode;
          if (u._setPosture && mode !== 'sneak' && u.posture === 'prone') u._setPosture('normal');
          u.orderMove(tx, tz, false, u.moveMode);
        }
      });
    };

    /** He has stopped: go firm in an arc around him, facing his sightline. */
    P._riderOverwatch = function (sq, rider, others, lx, lz) {
      sq.task = 'Overwatch on point';
      var rx = -lz, rz = lx;
      var n = others.length;
      sq.internal(function () {
        for (var i = 0; i < n; i++) {
          var u = others[i];
          // An arc, not a ring: they face the same way he does and sit behind
          // the line of his shoulders, so the whole section can fire forward.
          var t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;          // -1 .. +1
          var ang = t * 1.15;                                    // ±66°
          var tx = rider.pos.x + (rx * Math.sin(ang) - lx * Math.cos(ang) * 0.35) * RIDER.hold;
          var tz = rider.pos.z + (rz * Math.sin(ang) - lz * Math.cos(ang) * 0.35) * RIDER.hold;
          var d = sqHyp(u.pos.x - tx, u.pos.z - tz);
          if (d > 5.5) { u.moveMode = 'normal'; u.orderMove(tx, tz, false, 'normal'); }
          else if (!u.path || !u.path.length) {
            if (u.orderTakeCover) u.orderTakeCover();
            if (u.orderFace) u.orderFace(u.pos.x + lx * 40, u.pos.z + lz * 40);
          }
        }
      });
    };

    /**
     * He is in contact. This is the whole reason the feature exists.
     *
     * The section splits the way it is trained to: the men who can already see
     * the threat become the BASE OF FIRE and stay exactly where they are,
     * shooting; the rest become the MANOEUVRE element and work round the flank
     * the rider is NOT on. Nobody advances across his front — `_friendlyInLine`
     * stops the shot, but a man standing in his sights is still a man he cannot
     * shoot past, and that is what loses the fight.
     */
    P._riderFireSupport = function (sq, rider, others, threat, lx, lz) {
      var self = this, i;
      // Which flank is free? The one the rider is NOT leaning towards.
      var tx0 = threat.pos.x - rider.pos.x, tz0 = threat.pos.z - rider.pos.z;
      var tl = sqHyp(tx0, tz0) || 1;
      var px = -tz0 / tl, pz = tx0 / tl;             // perpendicular to the threat line
      // THE SPLIT. This is the whole of minor-unit tactics and it is one line
      // of arithmetic: some of the section shoots, the rest moves, and the
      // ratio between them is a national habit rather than a universal truth.
      // `DOCTRINE.overwatch` is exactly that number — 1.35 for the Americans,
      // who put down a heavy base of fire and enveloped wide, 0.95 for the
      // Germans, whose Stoßtrupp was small and whose rushes were short.
      //
      // The first cut said "base of fire = everyone who can see it", and on
      // open ground that is the whole section: twelve men in a firing line and
      // nobody manoeuvring, which is the one thing the doctrine forbids.
      var D = this._doctrineOf ? this._doctrineOf(rider.team) : null;
      var baseFrac = Math.max(0.3, Math.min(0.72, 0.5 * (D && D.overwatch ? D.overwatch : 1)));
      var wide = 1 * (D && D.flankWide ? D.flankWide : 1);
      var seers = [], blind = [];
      for (i = 0; i < others.length; i++) {
        (this.hasLOS(others[i], threat) ? seers : blind).push(others[i]);
      }
      // The men who can already see it shoot first — they are in position by
      // definition and a man who has to move to see it is the one to send.
      var want = Math.max(1, Math.round(others.length * baseFrac));
      seers.sort(function (a, b) { return sqDist(a.pos, threat.pos) - sqDist(b.pos, threat.pos); });
      var base = seers.slice(0, want);
      var move = seers.slice(want).concat(blind);
      // Somebody has to shoot. If nobody can see it at all, the nearest men
      // fire at the ground where it is — suppression needs no sight picture.
      if (!base.length && move.length) base = move.splice(0, 1);
      sq.task = 'Supporting point (' + base.length + ' firing, ' + move.length + ' flanking)';
      sq.internal(function () {
        for (var i = 0; i < base.length; i++) {
          var u = base[i];
          if (u.def.vehicle) { if (u.orderAttack) u.orderAttack(threat, true); continue; }
          // Down, and firing. `engageInPlace` is the difference between a base
          // of fire and eleven men wandering into the open one at a time.
          if (u.path && u.path.length && u.orderStop) u.orderStop();
          if (u.orderAttack) u.orderAttack(threat, true);
          else if (self.commandAttackGround) u.groundAtk = { x: threat.pos.x, z: threat.pos.z };
          if (u._setPosture && u.posture !== 'prone' && u.posture !== 'defend') u._setPosture('defend');
        }
        // The manoeuvre element: round the flank, short of the objective, at a
        // run, and out of the rider's line.
        var side = 1;
        var rdx = rider.pos.x - threat.pos.x, rdz = rider.pos.z - threat.pos.z;
        if ((rdx * px + rdz * pz) > 0) side = -1;    // he is on that side: take the other
        for (i = 0; i < move.length; i++) {
          var m = move[i];
          var out = (18 + i * 5) * side * wide;
          var tgtx = threat.pos.x + px * out - (tx0 / tl) * 13;
          var tgtz = threat.pos.z + pz * out - (tz0 / tl) * 13;
          var d = sqHyp(m.pos.x - tgtx, m.pos.z - tgtz);
          if (d < 6) { if (m.orderAttack) m.orderAttack(threat, true); continue; }
          m.moveMode = 'fast';
          if (m._setPosture && m.posture === 'prone') m._setPosture('normal');
          m.orderMove(tgtx, tgtz, false, 'fast');
        }
      });
      // If the point man is being cut to pieces, somebody puts smoke between
      // him and the thing doing it.
      if (rider.suppression > 0.55) {
        for (i = 0; i < others.length; i++) {
          if (others[i].smokeAmmo > 0 && others[i]._aiPopSmoke) { others[i]._aiPopSmoke(threat); break; }
        }
      }
    };

    /** Bounding overwatch: half up, half down, swap every few seconds. The
     *  half that is down goes to cover and holds; the half that is up runs. */
    P._squadBound = function (sq, live, goal) {
      sq.task = 'Bounding';
      sq.boundT -= 0.25;
      if (sq.boundT > 0) return;
      sq.boundT = 4.5;
      sq.bound = sq.bound ? 0 : 1;
      var half = sq.bound;
      sq.internal(function () {
        for (var i = 0; i < live.length; i++) {
          var u = live[i];
          if ((i & 1) === half) {
            // Moving element: a short rush toward its slot, not the whole way.
            var slot = (goal.slots && goal.slots[i % goal.slots.length]) || goal;
            var dx = slot.x - u.pos.x, dz = slot.z - u.pos.z;
            var d = sqHyp(dx, dz) || 1, step = Math.min(d, 34);
            if (u._setPosture) u._setPosture('normal');
            u.orderMove(u.pos.x + dx / d * step, u.pos.z + dz / d * step, false, 'fast');
          } else {
            // Overwatch element: down, in cover, watching the way they are going.
            if (u.orderTakeCover) u.orderTakeCover(); else if (u.orderStop) u.orderStop();
            if (u.orderFace) u.orderFace(goal.x, goal.z);
          }
        }
      });
    };

    // ---------------------------------------------------------------------
    // ORDERS — the squad, not the selection, is what you command
    // ---------------------------------------------------------------------
    var baseCommandMove = P.commandMove;
    P.commandMove = function (wx, wz, append) {
      var sel = this._liveSel();
      // Refuse, out loud, for anything the squad's own state has taken away.
      var locked = [];
      for (var i = 0; i < sel.length; i++) {
        var s = sel[i].squad;
        if (s && s._cc && s.locksOrders && locked.indexOf(s) < 0) locked.push(s);
      }
      if (locked.length && this.ui) {
        this.ui.toast(locked.map(function (s) {
          return (s.name || 'Squad') + ' ' + (s.state === 'broken' ? 'has broken — it will not go' : 'is pinned');
        }).join(' · '));
      }
      var mode = this.pendingMove || 'normal';
      baseCommandMove.apply(this, arguments);
      this._lastMoveMode = null;
      if (append) return;

      // Record the goal on every squad ENTIRELY inside the selection. A part
      // of a squad detached by Alt-click keeps its individual orders and does
      // not drag the rest of the platoon's cohesion logic along with it.
      var squads = [];
      for (i = 0; i < sel.length; i++) {
        var sq = sel[i].squad;
        if (sq && sq._cc && squads.indexOf(sq) < 0) squads.push(sq);
      }
      for (i = 0; i < squads.length; i++) {
        var s2 = squads[i];
        var live = s2.effectives();
        var all = live.every(function (u) { return sel.indexOf(u) >= 0; });
        if (!all || s2.locksOrders) continue;
        var ang = Math.atan2(wx - (s2.centroid() || { x: wx }).x, wz - (s2.centroid() || { z: wz }).z);
        s2.moveGoal = {
          x: wx, z: wz, mode: mode, ang: ang,
          spread: 3 + live.length * 1.6 * (this.formationSpacing || 1),
          slots: this._formationSlots(live.length, wx, wz, ang, s2.formation),
        };
        s2.boundT = 0;
        s2.task = 'Advancing';
        for (var j = 0; j < live.length; j++) live[j]._sqWait = false;
      }
    };

    // `pendingMove` is consumed inside commandMove, so grab it on the way past.
    var baseMoveMode = P.commandMoveMode;
    if (baseMoveMode) {
      P.commandMoveMode = function (m) { this._lastMoveMode = m; return baseMoveMode.apply(this, arguments); };
    }

    // EVERY WRAPPER IN THIS FILE FORWARDS `arguments`. Two of them have
    // already been caught listing their parameters and silently dropping one
    // the base method grew later — `orderMove` (the destination storey) and
    // `applySuppression` (`ambient`). These three match their bases today;
    // they are written this way so that stays true for free.
    var baseSelect = P.select;
    P.select = function (list, add) {
      var r = baseSelect.apply(this, arguments);
      if (this._refreshOrderBar) this._refreshOrderBar();
      return r;
    };

    /** Select a squad by index in the roster (the panel calls this). */
    P.selectSquad = function (sq, add) {
      var live = sq.effectives();
      if (!live.length) return;
      this.select(live, !!add);
      // Centre on it, the way clicking a Close Combat team badge does.
      var c = sq.centroid();
      if (c && this.cameraRig) this.cameraRig.target.set(c.x, 0, c.z);
    };

    /** Every squad on a side, strongest first — the roster's ordering. */
    P.squadsOf = function (team) {
      return this.squads.filter(function (s) {
        var l = s.effectives();
        return l.length && l[0].team === team;
      });
    };

    // ---------------------------------------------------------------------
    // THE ROSTER PANEL
    // ---------------------------------------------------------------------
    P.installSquadRoster = function () {
      if (document.getElementById('sqPanel')) return;
      var el = document.createElement('div');
      el.id = 'sqPanel';
      el.innerHTML = '<div class="sq-h"><span><b class="sq-caret">\u25bc</b> Order of Battle</span>'
        + '<i id="sqCount"></i></div><div id="sqList"></div>';
      document.body.appendChild(el);
      // FOLDABLE. It is the tallest thing on the left of the screen and for
      // most of a battle you want the ground, not the roster. The header is the
      // handle; `mousedown` rather than `click` so it matches every other
      // control in this panel and never reaches the map underneath.
      el.querySelector('.sq-h').addEventListener('mousedown', function (e) {
        el.classList.toggle('sq-fold');
        e.stopPropagation();
      });
      this._sqRosterT = 0;
      var self = this;
      document.getElementById('sqList').addEventListener('mousedown', function (e) {
        var head = e.target.closest ? e.target.closest('.sq-pl') : null;
        if (head) {
          self.selectPlatoon(self.playerTeam, parseInt(head.dataset.pl, 10), e.shiftKey);
          e.stopPropagation();
          return;
        }
        var row = e.target.closest ? e.target.closest('.sq-row') : null;
        if (!row) return;
        var sq = self.squads[parseInt(row.dataset.i, 10)];
        if (sq) self.selectSquad(sq, e.shiftKey);
        e.stopPropagation();
      });
    };

    P._drawSquadRoster = function () {
      var list = document.getElementById('sqList');
      if (!list) return;
      var panel = document.getElementById('sqPanel');
      var show = this.mode === 'play' && !this.fpv && !document.body.classList.contains('briefing');
      panel.style.display = show ? '' : 'none';
      if (!show) return;
      var mine = [], self = this;
      for (var i = 0; i < this.squads.length; i++) {
        var sq = this.squads[i];
        if (!sq._cc) continue;
        var live = sq.effectives();
        if (!live.length || live[0].team !== this.playerTeam) continue;
        mine.push({ sq: sq, i: i, live: live });
      }
      var sel = this.selection || [];
      // Grouped by platoon, the way an order of battle is actually read.
      mine.sort(function (a, b) {
        var pa = a.sq.platoon === null || a.sq.platoon === undefined ? 99 : a.sq.platoon;
        var pb = b.sq.platoon === null || b.sq.platoon === undefined ? 99 : b.sq.platoon;
        return pa - pb || a.i - b.i;
      });
      var html = '', lastP = -999;
      for (i = 0; i < mine.length; i++) {
        var r = mine[i], d = r.sq.moraleDef();
        var pl = r.sq.platoon === null || r.sq.platoon === undefined ? 99 : r.sq.platoon;
        if (pl !== lastP) {
          lastP = pl;
          html += '<div class="sq-pl" data-pl="' + pl + '">'
            + esc(r.sq.platoonName || (pl === 99 ? 'Attached' : ORDINALS[pl] + ' Platoon')) + '</div>';
        }
        var pct = Math.round(r.live.length / Math.max(1, r.sq.initial) * 100);
        var on = r.live.some(function (u) { return sel.indexOf(u) >= 0; });
        html += '<div class="sq-row' + (on ? ' on' : '') + '" data-i="' + r.i + '">'
          + '<b style="color:' + d.color + '">' + esc(r.sq.name || 'Squad') + '</b>'
          + '<span class="sq-bar"><i style="width:' + pct + '%;background:' + d.color + '"></i></span>'
          + '<span class="sq-n">' + r.live.length + '/' + r.sq.initial + '</span>'
          + '<span class="sq-st" style="color:' + d.color + '">' + d.short + '</span>'
          // …and a `title` for the few that are longer than any sane column,
          // so nothing the commander wrote is ever unrecoverable.
          + '<span class="sq-task" title="' + esc(r.sq.task || '') + '">' + esc(r.sq.task || '') + '</span>'
          + '</div>';
      }
      list.innerHTML = html || '<div class="sq-empty">No formations in the field</div>';
      var cnt = document.getElementById('sqCount');
      if (cnt) cnt.textContent = mine.length + ' formations';
    };
  }

  // =========================================================================
  // helpers
  // =========================================================================
  var ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  function sqDist(a, b) { var dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
  function centroidOf(list) {
    var x = 0, z = 0;
    for (var i = 0; i < list.length; i++) { x += list[i].pos.x; z += list[i].pos.z; }
    return { x: x / list.length, z: z / list.length };
  }
  function distToGoal(u, g) { return sqHyp(u.pos.x - g.x, u.pos.z - g.z); }
  /** Sort along whichever axis the group is more spread out on, so that
   *  consecutive slices of the array are units that deployed next to each
   *  other rather than units that happen to be alphabetically adjacent. */
  function sortSpatially(list) {
    if (list.length < 3) return list;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var p = list[i].pos;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    var byX = (maxX - minX) >= (maxZ - minZ);
    list.sort(function (a, b) { return byX ? a.pos.x - b.pos.x : a.pos.z - b.pos.z; });
    return list;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function injectStyles() {
    if (document.getElementById('sqStyles')) return;
    var st = document.createElement('style');
    st.id = 'sqStyles';
    st.textContent = [
      // TOP-left, not bottom-left: the ORDERS palette (#commandBar) is anchored
      // to the bottom-left corner and grows upward, and with a full selection
      // it grew straight through the order of battle. Two panels sharing one
      // corner is one panel too many.
      // THE TASK COLUMN WAS EATING THE HALF THAT MATTERED. At 326px the grid
      // left the task 84px, and measured on a live battle EIGHT OF TEN rows
      // were truncated: 'Working round (unseen)' wants 126 and lost the
      // '(unseen)' — which is the whole distinction between a section
      // advancing and a section sneaking — 'Holding the first hedgerow bank'
      // wants 177, and 'Closing to fire' lost a character for want of two.
      // The game's own help tells the player to read this column; it has to be
      // able to hold what it writes there.
      '#sqPanel{position:fixed;left:8px;top:48px;z-index:100;width:372px;max-height:38vh;overflow:auto;',
      '  background:rgba(14,18,24,.92);border:1px solid #2a3a4a;border-radius:6px;',
      '  font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#a8bccc;box-shadow:0 6px 22px rgba(0,0,0,.5)}',
      '#sqPanel .sq-h{display:flex;justify-content:space-between;align-items:center;padding:5px 8px;',
      '  border-bottom:1px solid #223040;color:#c8a060;font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase}',
      '#sqPanel .sq-h i{font-style:normal;color:#5f7286}',
      '#sqPanel .sq-h{cursor:pointer;user-select:none}',
      '#sqPanel .sq-h:hover{color:#e8cf90}',
      '#sqPanel .sq-caret{font-weight:400;font-size:9px;color:#7e8da0;display:inline-block;transition:transform .12s}',
      '#sqPanel.sq-fold{max-height:none;overflow:visible}',
      '#sqPanel.sq-fold #sqList{display:none}',
      '#sqPanel.sq-fold .sq-caret{transform:rotate(-90deg)}',
      '.sq-row{display:grid;grid-template-columns:96px 38px 34px 30px 1fr;gap:6px;align-items:center;',
      '  padding:3px 8px;cursor:pointer;border-left:2px solid transparent;white-space:nowrap}',
      '.sq-row:hover{background:#1a2532}',
      '.sq-row.on{background:#1d2b3a;border-left-color:#c8a060}',
      '.sq-row b{font-weight:700;overflow:hidden;text-overflow:ellipsis}',
      '.sq-bar{height:5px;background:#20303e;border-radius:3px;overflow:hidden;display:block}',
      '.sq-bar i{display:block;height:100%}',
      '.sq-n{color:#7d94a8;font-size:10px}',
      '.sq-st{font-size:9px;font-weight:700;letter-spacing:.5px}',
      '.sq-task{color:#6f8598;font-size:9.5px;overflow:hidden;text-overflow:ellipsis}',
      'body.fpv #sqPanel{display:none}',
      '.sq-pl{padding:6px 8px 2px;font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:#c8a060;',
      '  border-top:1px solid #223040;cursor:pointer}',
      '.sq-pl:hover{color:#e8dcc4;background:#1a2532}',
      '#ccBar{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:105;display:none;gap:4px;',
      '  padding:6px;background:rgba(14,18,24,.94);border:1px solid #2a3a4a;border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.55)}',
      '.cc-b{display:flex;flex-direction:column;align-items:center;gap:1px;min-width:62px;padding:6px 8px 4px;cursor:pointer;',
      '  background:linear-gradient(180deg,#1b2532,#141b24);border:1px solid #2a3a4a;border-radius:6px;color:#a8bccc;',
      '  font:10px/1 ui-monospace,Menlo,Consolas,monospace}',
      '.cc-b i{font-style:normal;font-size:15px;line-height:1;color:#cfe0ee}',
      '.cc-b b{font-weight:700;letter-spacing:.4px}',
      '.cc-b u{text-decoration:none;font-size:8px;color:#5f7286}',
      '.cc-b:hover{border-color:#c8a060;color:#e8dcc4}',
      '.cc-b.on{border-color:#c8a060;background:linear-gradient(180deg,#3a2f18,#241d0f);color:#e8dcc4}',
      '.cc-b.on i{color:#e8c088}',
      'body.fpv #ccBar{display:none!important}',
      '#ccBar{flex-direction:column;max-width:max(540px,calc(100vw - 660px))}',   /* rows stack; 18px clear of #unitInfo (right 12 + 300); the 540px floor is row 1 (8 × 62 + 7 × 4 + 12) so the Close Combat row never wraps on a narrow window */
      '.cc-row{display:flex;gap:4px;flex-wrap:wrap;justify-content:center}',
      '.cc-row2 .cc-b{min-width:0}',                                       /* up to ~14 buttons for a rifle squad — let short labels shrink */
      '.cc-b.off{display:none}',
      '.cc-b.armed{border-color:#ffd070;color:#ffe0a0;animation:ccPulse .9s ease-in-out infinite}',
      '@keyframes ccPulse{0%,100%{box-shadow:0 0 0 1px rgba(255,208,112,.25)}50%{box-shadow:0 0 0 3px rgba(255,208,112,.45)}}',
      '.cc-hint{font-size:9.5px;color:#6f8598;text-align:center;padding:3px 4px 0;line-height:1.4}',
      '.cc-hint b{color:#c8a060}',
      'body.cc-bar #commandBar{display:none!important}',                    /* the bar owns every order the palette had */
    ].join('\n');
    document.head.appendChild(st);
  }

  window.Squads = {
    VERSION: VERSION,
    MORALE: MORALE,
    SHAPES: SHAPES,
    NAMING: NAMING,
    roleOf: roleOf,
    TEMPLATES: TEMPLATES,
    CC_ORDERS: CC_ORDERS,
    CC_PALETTE_DUP: CC_PALETTE_DUP,
    templatesFor: templatesFor,
    allianceOf: allianceOf, ALLIANCE_OF: ALLIANCE_OF,
    install: install,
  };
})();
