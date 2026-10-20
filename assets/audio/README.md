# Sample bank — real recordings in the game

**This folder is populated.** 290 clips, 4.6 MB, 72 bank names, from two
sources: the **USC Sound Effects Library** on archive.org (the first bank,
below) and **modern full-range recordings from freesound.org** (the second
bank, round 103 — see *The second bank* further down; 17 of them are CC BY 4.0
and are credited there by name). The first bank is the Red, Gold and Sunset
Editorial collections, digitised by USC and released **CC0 1.0**:

| what | from |
|---|---|
| rifles, the BAR, the Thompson, machine guns, the .50, the buzzsaw, field guns, naval cannon, mortars, a 37 mm AT gun, a bazooka, ricochets, bullet cracks, breech open and close | [SSE Library: GUNS](https://archive.org/details/SSE_Library_GUNS) |
| explosions — grenade, shell, heavy shell, and the dull cluster on the horizon — and the incoming whistle | [SSE Library: EXPLOSIONS](https://archive.org/details/SSE_Library_EXPLOSIONS), [Red Library: Explosions](https://archive.org/details/Red_Library_Explosions) |
| **tank engines, and the track clank** — the `M-4` cuts are a Sherman | [GOLD TAPE: 15 Tanks Bulldozers](https://archive.org/details/GOLD_TAPE_15_Tanks_Bulldozers) |
| boots on dirt, boots on gravel, running, and a column marching | [Red Library: Footsteps 1](https://archive.org/details/Red_Library_Footsteps_1) and [3](https://archive.org/details/Red_Library_Footsteps_3), [SSE Library: FOOTSTEPS](https://archive.org/details/SSE_Library_FOOTSTEPS) |
| **machine guns** — single shots for the `mg` bank, one continuous tear for `mg.rip` | [Red Library: Guns Machine](https://archive.org/details/Red_Library_Guns_Machine) |
| **field guns and tank main armament** — R12-37 and R12-15 are a **75 mm**, the Sherman's own gun | [Red Library: Guns Artillery](https://archive.org/details/Red_Library_Guns_Artillery) |
| **birds and wind** — the bed that replaced the tension drone | [Red Library: Animals Birds](https://archive.org/details/Red_Library_Animals_Birds), [SSE Library: WIND](https://archive.org/details/SSE_Library_WIND) |
| **wounded and dying men** — grunts, strains, screams, moans, choking, the wheeze of a man who has been shot | [Red Library: Fights](https://archive.org/details/Red_Library_Fights), [Voices Men 1](https://archive.org/details/Red_Library_Voices_Men_1) and [2](https://archive.org/details/Red_Library_Voices_Men_2), [SSE Library: VOICES](https://archive.org/details/SSE_Library_VOICES) |

`tools/audio_slice.py`, `tools/audio_slice2.py` and `tools/audio_voices.py` are
how they were made and will rebuild them from the raw downloads.

### The second bank (round 103): the weapons themselves, full range

Every clip in the first bank came off film or tape, and measures like it: the
rifles put 0.5% of their energy below 120 Hz, the tank engine 1.6%, the generic
field gun 4.1% — the game layered a synthesised thump under them to make up
for it. The second bank is modern recordings of the actual weapons: a **Kar
98k at 33%, an MG 42 at 54%, a 76 mm field gun at 66%**. Banks built from these
are listed in the manifest's `full`, and the game puts only 30% of the
synthesised body under them (`SFX._bodyK`) and sends them to the valley reverb
at 0.26 rather than 0.42 (`SFX._wet`): they were recorded outdoors and carry a
room of their own — the Kar 98k's decay runs a second.

`tools/audio_slice3.py` cuts them from `tools/audio_raw/freesound/` (the
sources and their licences are in `list.txt` there), and its JOBS table says
why each cut is where it is. Every take was looked at — spectrogram, onsets,
level, the cepstral voice screen — before it was cut, and four were not used:
the .50 (`183656`) is clipped (3% of its samples at full scale), the 6-pounder
(`702455`) overloaded the recorder, the MP 40 (`257874`) is one shot repeated,
and the desert pass-bys (`704815`) are distant rifle fire, not cracks.

| bank | what it is | recording |
|---|---|---|
| `rifle.garand`, `garand.ping` | M1 Garand, eight shots; the en-bloc clip ringing out | MPierluissi (CC0) |
| `rifle.kar98k`, `breech.kar98k[.close/.cycle]` | Kar 98k, one shot as mix, left and right mic; its bolt | Walking.With.Microphones (CC0) |
| `rifle.mosin`, `breech.mosin.cycle` | Mosin, five shots and the bolt between them | YleArkisto (CC BY) |
| `rifle.no4` | Lee-Enfield | kyles (CC0) |
| `rifle.ppsh41`, `rifle.mp40`, `rifle.sten` | one ROUND each with the burst's own tail spliced on (the MP 40 is an MP 38, the same gun) | Lubini, Lubini, poissonmort (CC BY) |
| `mg.mg42.rip` | 0.30 s windows of an MG 42 burst — the tear | Lubini (CC BY) |
| `mg.maxim`, `mg.ukvickers` | one round of a Maxim (the Vickers is the British Maxim) | YleArkisto (CC BY) |
| `rifle.p38`, `rifle.m1911`, `rifle.enfield2`, `rifle.pistol` | P 38; M1911; a .38 revolver for the Enfield No. 2; all of them for the other pistols | Lubini (CC BY), areniporgen (CC0), YleArkisto (CC BY) |
| `cannon` | **replaced**: a 76 mm field gun and a ZiS-3 (the film 75s are in `tools/audio_raw/retired/`) | YleArkisto (CC BY), Walking.With.Microphones (CC0) |
| `cannon.big` + | a 155 mm howitzer added to the four film cuts | YleArkisto (CC BY) |
| mortar banks + | four mortar shots added | qubodup (CC0) |
| `boom`, `boom.big`, `boom.far`, `boom.small` + | a near burst with debris, two shell impacts, 4 kg of TNT, a distant explosion, a grenade with its echo | juskiddink (CC BY), YleArkisto (CC BY), sidohzen (CC0) |
| `whistle` +, `rumble` + | two incoming shells cut to end as they land; a ZiS-3 salute heard from 1,200 m | YleArkisto (CC BY), Walking.With.Microphones (CC0) |
| `ricochet` +, `tracks` + | nine ricochets cut to a spang; tank pass-by track rumble | YleArkisto (CC BY) |
| `engine.tank` | **replaced**: a running Sherman M4A3E8's idle, a 10 s seamless loop | nicStage (CC BY) |

**Attribution (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/).**
All of these were trimmed, sliced, mixed to mono, levelled and re-encoded:

- Mosin shots, Maxim sustained fire, S&W .38 revolver, 76 mm cannon, 155 mm
  cannon, shell wail and impact, grenade with echo, ricochets, tank pass with
  tracks — by **YleArkisto** (Yle, the Finnish Broadcasting Company archive):
  https://freesound.org/s/255265/, /255270/, /255272/, /332935/, /332934/,
  /258206/, /256300/, /401921/, /386590/
- MG 42, PPSh-41, MP 38, P 38 — by **Lubini**: https://freesound.org/s/338242/,
  /338323/, /338046/, /338045/
- Sten — by **poissonmort**: https://freesound.org/s/157206/
- Near explosion with debris, distant explosion — by **juskiddink**:
  https://freesound.org/s/108641/, /108640/
- Sherman M4A3E8 start and idle — by **nicStage**: https://freesound.org/s/368670/

CC0 (no attribution required, credited anyway): MPierluissi (460851, 460848),
Walking.With.Microphones (802675, 802673, 556132, 634629), kyles (450853),
areniporgen (740897), qubodup (184382), sidohzen (165808).

**Close Combat's own sounds are not here and must not be.** The game was asked
for "the Close Combat sound files"; those are the publisher's copyright, and
nothing in this folder comes from any game.
`tools/audio_thin.py` is different — it rewrites the bird beds **in place**,
cutting the calls out and spacing them over silence.

**Only non-verbal cuts were taken from the voice tapes.** The same reels carry
prayers, farewells, cattle calls, a shaving-cream commercial and 1940s
Hollywood foreign-soldier caricatures. None of it is in the game and none of it
should be: soldiers in this game make no sound at all unless they are hit. A
careless second pass over the same folder is the one easy way to undo that.

### THE RULE THAT MATTERS MOST: read the catalogue, not the filename

A player reported voices mixed into the machine guns and the tank main gun. He
was right. `GUNArtl_squad firing 37mm anti tank guns` has the detachment on it,
shouting, and those cuts were the `cannon` bank and all three light AT guns —
44.9% voiced with a 0.43 s vowel in one of them.

**Every Red and SSE item ships a master catalogue CSV** describing every
recording: `RED_Metadata_20220627.csv`, `Master SSE UCS 20230213.csv`. Download
it first. It says `R30-03 Artillery Gun Sequence` is "Man shouts in Mandarin:
'Ready, Fire!'", that `R15-49 Man Hyperventilating and Screaming` is "sort of
saying 'no' in beginning", that `R16-09 Men Grunting and Shrieking` is "similar
to apes in a fight". None of those are in the game, and all three would have
been chosen on their names.

Then **every cut is screened** by `tools/audio_speech.py`, which finds a human
vowel by its harmonic comb in the cepstrum. A cut bound for a gun bank is
rejected if it has a voice in it; a cut bound for a voice bank is rejected if it
is too continuously voiced to be a cry rather than a word.
`voicescan.json` is the scan of the whole folder, and `tools/test_round35.js`
fails if anything outside the four `voice.*` banks has a man in it — **or if a
clip has been added since the scan was last run.** If you add a clip:

    python3 tools/audio_speech.py --report assets/audio

### Four rules that matter more than the recordings

1. **A clip's SHAPE is decided by its caller, not by taste.** `SFX.mg` is
   called once per ROUND below `RIP_RATE`, so the `mg` bank is single shots;
   `mg.rip` is the buzzsaw and is exactly `SFX.RIP_LEN` of continuous fire.
2. **"Tinny" is a MISSING OCTAVE, not too much treble.** Measured: the rifle
   bank puts 1.4% of its energy below 120 Hz and the machine guns 2.8%, because
   35 mm optical film never recorded that octave. No equaliser lifts what was
   never there, so `SFX._body` synthesises it and layers it under the sample —
   which is what film sound has always done with a thin gun take. For a VOICE
   the equivalent is pitch and not EQ: `deepen()` plays the cry 1.35 semitones
   slower and the whole vocal tract drops with it.
3. **A recording brings its own room.** The synth methods send 0.85–2.0 of
   valley reverb because a dry impulse needs it; a field recording already has
   a tail. `SFX._wet` cuts the send to 42% when a sample is backing the name,
   and the rifle clips are trimmed to the CRACK (under 0.6 s) so the game
   supplies the roll. Sending a recorded tail through a second one is the
   single thing that most makes a sampled gun sound wrong.
4. **A misnamed bank breaks nothing** — `resolve` returns null, the synth takes
   over, and there is no error anywhere. `node tools/test_audio_bank.js`.

**What is still synthesised, deliberately:** `garand.ping`, and the `voice()`
fallback in `assets/audio.js` — a glottal pulse train through three held
formants with a register break in it, which is what plays before the manifest
has loaded. The `voice.*` banks themselves are recordings now, of men who have
been hit; **nothing in this game makes a soldier open his mouth otherwise.**

## Two things to know first

1. **It will not load from `file://`.** Browsers block `fetch` for local files,
   so a page opened by double-clicking silently stays on the synth. Serve the
   folder over HTTP to hear samples:

   ```bash
   python3 -m http.server 8000
   ```

   then open `http://localhost:8000/tactical_command.html`. `assets/audio.js`
   detects `file://` and logs one `debug` line instead of a wall of CORS errors.

2. **Check the licence on every file yourself.** The pointers below are
   starting points, not licence assertions — Freesound in particular hosts CC0,
   CC-BY and CC-BY-NC side by side, and the licence is per-file. Record what you
   used in `credits` in the manifest; several of the sources below are CC-BY and
   *require* that attribution.

## manifest.json

```jsonc
{
  "credits": "rifle_*: Freesound #123456 by AUTHOR (CC0). mg42_*: OpenGameArt 'WW2 SFX' by AUTHOR (CC-BY 3.0).",
  "clips": {
    "rifle":        ["rifle_01.ogg", "rifle_02.ogg", "rifle_03.ogg"],
    "rifle.tail":   ["rifle_tail.ogg"],
    "mg":           ["mg_burst_01.ogg", "mg_burst_02.ogg"],
    "mg.heavy":     ["fifty_burst_01.ogg"],
    "cannon":       ["cannon_01.ogg", "cannon_02.ogg"],
    "cannon.big":   ["cannon_big_01.ogg"],
    "boom":         ["he_burst_01.ogg", "he_burst_02.ogg", "he_burst_03.ogg"],
    "ricochet":     ["ric_01.ogg", "ric_02.ogg", "ric_03.ogg"],
    "snap":         ["crack_01.ogg", "crack_02.ogg"],
    "breech":       ["breech_open.ogg"],
    "clang":        ["clang_01.ogg", "clang_02.ogg"],
    "step.grass":   ["step_grass_01.ogg", "step_grass_02.ogg", "step_grass_03.ogg"],
    "tracks":       ["track_clank_01.ogg", "track_clank_02.ogg"],
    "engine.tank":  ["tank_idle_loop.ogg"],
    "engine.truck": ["truck_idle_loop.ogg"],
    "voice.hit":    ["pain_01.ogg", "pain_02.ogg", "pain_03.ogg"],
    "voice.agony":  ["scream_01.ogg", "scream_02.ogg"],
    "voice.death":  ["death_01.ogg", "death_02.ogg"],
    "voice.shout":  ["shout_01.ogg", "shout_02.ogg", "shout_03.ogg"]
  }
}
```

### Naming a specific weapon

Clip names resolve down a **fallback chain**, so the manifest can be as specific
as your recordings actually are:

```
rifle.k98.tail  →  rifle.tail  →  rifle  →  (synthesis)
mg.mg42         →  mg          →  (synthesis)
cannon.flak88   →  cannon      →  (synthesis)
```

The game asks for the most specific name it knows — the **unit def's own key**,
so `rifle.gergren`, `rifle.usrifle`, `mg.mg42`, `mg.us30cal`, `cannon.pak75` —
**then the weapon's** (`def.arms`, an RTT_ARMS key: `rifle.kar98k`,
`rifle.garand`, `mg.maxim`; see `SFX._gunName`), then the family. Fill banks by
weapon: one `rifle.kar98k` covers all seven German rifle units. A unit key wins
when it exists — `rifle.gersniper` is a sniper heard from far off, on purpose.
Pistols ask for `rifle.<pistol key>` and then `rifle.pistol`.
Put six Kar 98k recordings under `"rifle.gergren"` and every Grenadier, SS man
and Volksgrenadier on the map is firing a Mauser while the Garands carry on
using the generic `rifle` clips. Nothing else has to change, and no name is ever
required. Unit keys are the ones in `UNIT_DEFS` (`game.def('gergren')`, or just
`Object.keys(UNIT_DEFS)` in the console).

Every name is optional. A name with no entry falls back to synthesis, so you can
add recorded rifles today and leave everything else alone. **Give the common
sounds three or more variants** — `play()` steps through them round-robin and
pitch-shifts each by ±6%, and three clips is roughly where a machine gun stops
sounding like a loop.

Prefer **Ogg Vorbis** (`.ogg`) at 44.1 kHz mono for one-shots — mono is correct
because the game does the panning, and a stereo file fights it. Loops
(`engine.*`) should be seamless and 2–4 seconds.

### Loudness

Normalise one-shots to about **−3 dBFS peak** and trim leading silence to zero.
The engine's own compressor sits at −18 dB threshold with a 5:1 ratio, so clips
that are too hot will duck everything else on the field.

## Where to get CC0 / open recordings

### Read this first: "recordings from WWII" is a copyright trap

The obvious idea is to use the actual wartime sound-effects records, and
archive.org streams a whole shelf of them — `BATTLE EFFECTS — World War II`
discs for artillery, machine guns, tanks and battle scenes, digitised from
78s by the Great 78 Project. **They are not free to use.**

Pre-1972 sound recordings had no federal copyright until the Music
Modernization Act of 2018, which then gave them one. Recordings published
between 1923 and 1946 are protected for **100 years from publication**. A 1944
effects disc therefore enters the US public domain in **2045**. Archive.org
hosts them for preservation and research; that is not a licence to ship them
in a game. (See the [Copyright Office on pre-1972
recordings](https://www.copyright.gov/music-modernization/pre1972-soundrecordings/).)

There are two ways to get genuinely period audio that is genuinely free:

1. **US federal government works are public domain**, including the Army Signal
   Corps' own films. [Army-Navy Screen
   Magazine](https://archive.org/details/ArmyNavyScreenMagazine) and [Combat
   Bulletin](https://archive.org/details/CB-20-1944) are Signal Corps
   productions full of real 1943-45 combat audio. The catch is that it is an
   optical film soundtrack with narration and music over most of it: narrow
   band, heavy surface noise, and you are hunting for a clean second and a half
   between two sentences of commentary. Worth it for the far layer — distant
   artillery, a barrage, the general noise of a battle — and rarely worth it
   for a close shot.
2. **A library that was itself cleared to CC0** and happens to contain period
   material. See SSE below: several of its cuts are labelled "from optical",
   which is exactly that — lifted off wartime film.

| Source | What it is good for | Licensing |
|---|---|---|
| **[SSE Library: GUNS](https://archive.org/details/SSE_Library_GUNS)** | **Start here.** 95 files, WAV and FLAC, the USC Cinema / Sunset Editorial library. See the mapping below — it covers most of the manifest on its own. | **CC0 1.0 Universal**, stated on the item page. As clean as licensing gets. |
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | Rifles, bolt-action, pump-action, pistols, revolvers, recorded and released by four students. Good close-mic material where SSE is cinematic. | CC0 — "may be used without royalty or credit". |
| [Freesound](https://freesound.org) | Everything, and the only realistic source for `voice.*`, `step.*` and `tracks`. Some uploads are extracted from US government video and are therefore period AND public domain. | **Per file** — filter to CC0 with the licence facet, or use a [CC0-filtered query](https://freesound.org/search/?q=gunshot&f=license%3A%22Creative+Commons+0%22). Account required. |
| [OpenGameArt](https://opengameart.org/art-search-advanced?field_art_type_tid%5B%5D=13) | Curated game-ready packs, already loudness-matched. | Per submission; set the licence filter to CC0. |
| [Army-Navy Screen Magazine](https://archive.org/details/ArmyNavyScreenMagazine) · [Combat Bulletin](https://archive.org/details/CB-20-1944) | Real Signal Corps combat audio, 1943-45. Distant fire, barrages, vehicle noise. | Public domain — works of the US federal government. |
| [Pixabay Sound Effects](https://pixabay.com/sound-effects/) | Explosions, engines, generic weapon fire. | Pixabay Content Licence — free commercially, no attribution. Not CC0; read the terms. |
| [Sonniss GDC Game Audio Bundle](https://sonniss.com/gameaudiogdc) | Professionally recorded, several gigabytes of weapons and vehicles. | Royalty-free under Sonniss's own licence. Free annual release. |
| [BBC Sound Effects](https://sound-effects.bbcrewind.co.uk/) | Archive material including period military recordings. | RemArc licence — **personal, educational and research only**. |
| ~~BATTLE EFFECTS 78s~~ | — | **In copyright until the 2040s.** See above. |

### What SSE Library: GUNS maps to

Nearly the whole manifest, from one CC0 item. The categories are its own:

| manifest name | SSE cuts to pull |
|---|---|
| `rifle` | Rifle category; `Cock and fire empty rifle` for the dry one |
| `mg` | `Light machine gun from optical`, `Machine gun bursts`, `Bren machine gun with canyon echo`, `Large machine gun` |
| `mg.heavy` | `50 cal Browning machine gun`, `50 cal machine gun with ricochets` |
| `mg.ussmg` / `mg.germp40` | `Tommy gun bursts` |
| `cannon` | `Cannon shot`, `Cannon fire with commands` |
| `cannon.big` | `8" gun/cannon`, `Big cannon with reverb`, `6 inch naval cannon fired up close` |
| `boom` | `Shells overhead with explosions`, `Cannon fire with shells falling nearby` |
| `distantRumble` | `Distant cannon fire`, `Bombardment with distant explosions` |
| `ricochet` | `Machine gun ricochets`, `Machine gun bullets hit nearby with ricochet` |
| **`breech`** | `Cocking rifle (bolt-action)`, `Loading clip into rifle`, `Slide breech pistol` — the reload layer, and the hardest category to find anywhere else |
| `cannon.germortar` / `cannon.usmortar` | `Mortar fire`, `Mortar Fire (long reverb)` |
| `cannon.us37mm` | `Squad firing 37mm anti tank guns` |
| `rocket` | `Bazooka shot`, `Bazooka shooting` |

**What it does NOT cover**, and where to go instead: `snap` (the supersonic
crack past your head — Freesound `bullet whizz`, `bullet flyby`), `clang`,
`step.*`, `tracks` and `engine.*` (Freesound: [qubodup's CC0 tracked-vehicle
loop](https://freesound.org/people/qubodup/sounds/200303/), or search
`excavator track`, `bulldozer` — construction plant is recorded far more often
than tanks and sounds nearly identical), and every `voice.*`.

### Specific hunting notes

- **Machine guns.** The thing that sells an MG42 is not the shot, it is the
  *rate* — 1200 rpm reads as a rip, not a rattle. If you can only find single
  shots, put ONE shot in `mg` and let the game's existing burst timing
  (`MG_CYCLIC`) fire it repeatedly; that is more convincing than a canned burst
  at the wrong rate. Search terms: `machine gun single shot`, `mg42`, `belt fed`.
- **Tank engines and tracks.** Search `tracked vehicle`, `excavator track`,
  `bulldozer` — construction plant is recorded far more often than tanks and
  sounds nearly identical. Get the idle as a seamless loop for `engine.tank` and
  the metallic clank separately for `tracks`.
- **Vocals.** This is the hardest category to source and the easiest to get
  wrong; a badly acted scream is worse than none. Search `man scream`, `pain
  grunt`, `male shout`. Note that `assets/audio.js` already synthesises these
  (`WarAudio.voice`) with a per-soldier vocal tract, so a squad does not sound
  like one man on a loop — check whether the synthesised version is good enough
  before spending an evening on samples. If you do add them, **give each
  category at least four variants**, or the repetition will be very obvious.
- **Distant artillery.** `distantRumble` wants a long, soft, low thud with no
  transient. Search `distant explosion`, `thunder rumble`.

## Testing what loaded

From the console:

```js
WarAudio.state()   // 'loaded' | 'absent' | 'loading' | 'error' | 'none'
WarAudio.count()   // how many clips decoded
WarAudio.has('mg') // is this name backed by a sample?
```

`'absent'` is the healthy state for a checkout with no audio files; with this
folder as it stands you should see `'loaded'` and **107**.

Two things that will make it look broken when it is not:

- **The audio context needs a gesture.** Nothing decodes until the page has
  been clicked once, so `state()` reads `'none'` on a freshly loaded tab.
- **Small arms are distance-culled** (`SFX._ok`). A rifle two hundred units
  from the camera plays nothing at all, sample or synth — so test with the
  listener near the firing, or you will conclude the bank is not loading.

`node tools/test_audio_bank.js` checks the manifest against the folder AND
against the names the game can actually ask for. A misnamed bank is the worst
bug this system has: `resolve` returns null, `SFX` synthesises, and there is no
error anywhere — the recordings are simply never heard.
