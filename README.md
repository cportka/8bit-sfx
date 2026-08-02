# 8bit-sfx

**Version:** 1.0.0

**8888 chip sound effects across 44 categories — synthesized on demand, not downloaded.**
There are no audio files in this package. Every effect is a deterministic function of its
name, so `render('kick_003')` produces the same samples in a browser, in Node, today and
in five years. Game SFX *and* musical sound design, every effect carrying a catalog
description so you can find what you need by reading instead of auditioning.
MIT licensed — use them in anything.

**Try them: <https://cportka.github.io/8bit-sfx/>** — the whole library, synthesized live
in your browser as you click.

## Install & use

```sh
npm install 8bit-sfx
```

```js
import { SfxPlayer, render, renderWav, describe, effectNames } from '8bit-sfx';

// Play — no preloading, no fetching, nothing to bundle
const sfx = new SfxPlayer();
button.addEventListener('click', () => {
  sfx.resume();              // browsers gate audio on a user gesture
  sfx.play('kick_003');      // synthesized on first use, then cached
  sfx.play('bass_120', { volume: 0.8, rate: 1.0 });
});

describe('bass_120');        // "wobble bass — ramp LFO on amp gate, 8.6 Hz at A1"
render('snare_012');         // Float32Array, 22050 Hz mono — feed it anywhere
renderWav('rpg_levelup');    // Uint8Array: a complete .wav file, if you want a file
effectNames();               // all 8888 names, no synthesis
```

Dependency-free and build-free — pure ES modules, no bundler required, no assets to copy.
The package is a **377 kB download** (3.0 MB unpacked): ~940 KB of engine plus the 2 MB
catalog. No audio ships — 8888 sounds cost kilobytes of code instead of ~130 MB of WAVs.

### API

| | |
|---|---|
| `render(name)` | `Float32Array` of samples in [-1, 1) at 22050 Hz |
| `renderPcm(name)` | `Uint8Array` of 8-bit unsigned PCM |
| `renderWav(name)` | `Uint8Array` containing a complete `.wav` file |
| `describe(name)` | the catalog blurb — what makes this effect different |
| `duration(name)` / `describeFull(name)` | length in seconds / full metadata entry |
| `effectNames()` / `CATEGORIES` / `COUNT` | the catalog's shape, without synthesizing |
| `categoryCharacter(cat)` | the one-line description of a category |
| `loadManifest()` | the prebuilt catalog: every effect's description and duration |
| `new SfxPlayer()` | Web Audio playback: `resume()`, `play(name, {volume, rate})`, `muted` |

## Categories

Each category holds **202** effects, named `<category>_000` … `<category>_201`. (The one
exception is `rpg`: `rpg_000`–`rpg_173` plus the 28 ported sounds under their event names.)

### Game sounds

<!-- GAME-TABLE -->
| Category | Character |
|---|---|
| `jump` | rising square hops, snappy or floaty tails |
| `coin` | bright two-note pickup blips, classic coin grab |
| `laser` | fast downward zaps, clean or warbled pew |
| `explosion` | noise booms, dry cracks to sub-heavy rolling blasts |
| `powerup` | rising scale fanfares, bright pickup arpeggios |
| `hit` | blunt impacts, noise burst over a diving low thud |
| `blip` | tiny UI ticks and menu selects, crisp square clicks |
| `alarm` | alternating two-tone sirens, frantic to steady |
| `drone` | sustained bass hums, gentle to seasick wobble |
| `jingle` | short melodic stingers, 3-6 notes resolving upward |
| `ambient` | wind gusts, cricket chorus, cave drips, thunder, rain, shimmer pads |
| `ui` | menu clicks, hovers, toggles, dings, error buzzes, key ticks |
| `voice` | chip-speech babble, grunts, hums, laughs, gasps, sighs, hey! calls |
| `dog` | chip barks big and small, yips, whines, whimpers, growls, pants, howls |
| `zombie` | undead groans, moans, hisses, gurgles, rattling breath, snarls |
| `monster` | creature roars, screeches, snarls, chitter, stomps, flaps, squelches |
| `water` | drips, splashes, pours, streams, underwater blubs |
| `fire` | crackling campfires, ignition whooshes, torch flutter, sizzles, ember pops |
| `footstep` | steps on grass, gravel, stone, wood, snow, mud, puddles |
| `mech` | creaks, slams, latches, levers, switches, rattles, ratchets, key jangles |
| `person` | heartbeats, breaths, sneezes, snores, claps, gut growls |
| `rpg` | sword swings, spells, loot jingles, level-ups, warps, save chimes (174 generated + 28 ported) |

### Musical sound design

<!-- MUSIC-TABLE -->
| Category | Character |
|---|---|
| `kick` | tight chip kicks, 808 drops, gated and crushed thumps |
| `snare` | noise-and-tone backbeats, cracks, gated slams, rimshots, flams |
| `hihat` | crisp closed ticks, open sizzles, pedal chicks, metallic sheen |
| `tom` | tuned rack and floor toms, falling bends, roto rises, fills |
| `cymbal` | long crashes, pinging rides, ride bells, splashes, chinas, chokes |
| `perc` | tuned cowbells, blocks, claves, shakers, congas, agogo bells |
| `bass` | plucked and sustained chip bass, acid sweeps, wobbles, slaps |
| `sub` | 808 slides, deep drops, gated and growling sub-bass |
| `lead` | square and PWM chip leads, glides, licks, echoes, stabs |
| `pluck` | harp and marimba plucks, glassy mallets, muted stabs, octave doubles |
| `arp` | chord-tone arpeggio runs, octave jumps, glissandi, ratchets |
| `chord` | tuned chord stabs, power chords, wide voicings, gated chops |
| `bell` | struck bronze bells, tubular chimes, music-box tines, shimmer tails |
| `organ` | drawbar stacks, church pipes, rock bite, leslie swirl, percussive taps |
| `string` | bowed swells, tremolo and spiccato bowing, pizzicato, detuned ensembles |
| `brass` | chip brass stabs, fanfares, swells, muted buzz, section falls |
| `reed` | breathy chip flutes, hollow clarinet, nasal oboe, ocarina, pan pipes |
| `pad` | warm detuned beds, glassy stacks, dark slabs, filter sweeps, gated pulses |
| `riser` | noise sweeps, pitch glides, gated builds, drum rolls, filter falls |
| `impact` | cinematic booms, metallic slams, sub drops, braams, debris tails |
| `glitch` | buffer stutters, bitcrush bursts, tape stops, garbled data chirps |
| `vinyl` | crackle beds, needle drops, tape hiss, wow/flutter, static, motor hum |


The `rpg` category also contains the complete sound set of
[pixel-rpg](https://github.com/cportka/pixel-rpg) — 28 sounds ported exactly from that
game's Web Audio engine, keeping their event names (`rpg_levelup`, `rpg_menu-open`, …) and
the game's intended relative loudness in the catalog's `gain` field.

## Exporting WAV files (optional)

The library never needs files, but you can have them:

```sh
npm run generate                       # every effect -> sfx/<category>/<name>.wav
npm run catalog                        # just rebuild sfx/manifest.json
node scripts/generate.mjs --only kick_003 rpg_levelup
```

`sfx/*.wav` is git-ignored — it's an export, not a source. The testing page also has a ⬇
button on every row that exports that one effect. Only `sfx/manifest.json` (the catalog)
is committed and shipped.

## How it works

`src/dsp.js` holds the chip-synth primitives: a seeded xorshift PRNG, NES-style 15-bit LFSR
noise, square/triangle/sawtooth oscillators, and a 16-level amplitude quantizer that gives
the library its 4-bit-DAC voice. Each category in `src/generators/` is a small module that
draws its parameters from the PRNG, renders samples, and records what it chose — which is
where the descriptions come from, so they always describe the actual synthesis rather than
an intention. Because the PRNG is seeded from the effect's name, the whole library is
reproducible from under a megabyte of code.

## Stability

1.0.0 is a stable API commitment: the exported functions, the manifest entry shape, and
effect naming are covered by SemVer. Effects only ever get appended — existing names keep
their sound.

## License

[MIT](LICENSE) — free for commercial and non-commercial use, attribution appreciated but
not required.
