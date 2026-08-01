# 8bit-sfx

**Version:** 0.4.0

A free 8-bit sound effects library and npm package: **2200 effects** across 22 categories
— including the complete ported sound set of
[pixel-rpg](https://github.com/cportka/pixel-rpg) inside the `rpg` category — all
synthesized NES-style (square and triangle waves, 15-bit LFSR noise, 16-level amplitude
quantization) as 8-bit unsigned mono WAV at 22050 Hz. **Every effect carries a catalog
description in the manifest** derived from its actual synthesis parameters, so you can
find the sound you want by reading, not auditioning. MIT licensed — use them in anything.

**Try them: <https://cportka.github.io/8bit-sfx/>** — a testing page (GitHub Pages, deployed
from `main`) that browses every category and plays effects in the browser.

## Install & use

```sh
npm install 8bit-sfx        # or: npm install github:cportka/8bit-sfx
```

```js
import { SfxPlayer, loadManifest, soundUrl } from '8bit-sfx';

const sfx = new SfxPlayer();
button.addEventListener('click', async () => {
  sfx.resume();                        // browsers gate audio on a user gesture
  await sfx.load('coin_042', 'jump_007', 'dog_013');
  sfx.play('coin_042', { volume: 0.8, rate: 1.0 });
});

const manifest = await loadManifest(); // every effect + category + duration
const url = soundUrl('zombie_031');    // direct URL to the wav (browser or Node)
```

The package is dependency-free and build-free: `soundUrl()`/`loadManifest()` resolve via
`import.meta.url`, so they work served from `node_modules`, through a bundler, or in Node.
Raw files are also importable as `8bit-sfx/sfx/<category>/<name>.wav` and the manifest as
`8bit-sfx/manifest`. Prefer plain files? Everything lives under [`sfx/`](sfx/).

## Categories

| Category | Count | Character |
|---|---|---|
| `jump` | 100 | upward square-wave sweeps |
| `coin` | 100 | bright two-note pickup blips |
| `laser` | 100 | fast downward zaps |
| `explosion` | 100 | filtered noise booms with rumble |
| `powerup` | 100 | rising arpeggios |
| `hit` | 100 | short noise + square impacts |
| `blip` | 100 | tiny UI ticks and menu selects |
| `alarm` | 100 | alternating two-tone sirens |
| `drone` | 100 | low engine/ambient hums |
| `jingle` | 100 | 3–6 note melodic stingers |
| `ambient` | 100 | wind, rain, crickets, cave drips, distant thunder |
| `ui` | 100 | clicks, toggles, dings, error buzzes, success chimes |
| `voice` | 100 | chip-imitated people: babble blips, grunts, laughs, sighs |
| `dog` | 100 | barks, yips, whines, growls, pants, howls |
| `zombie` | 100 | groans, moans, hisses, gurgles, rattling breaths |
| `monster` | 100 | roars, screeches, snarls, chitters, stomps |
| `water` | 100 | drips, splashes, pours, streams, underwater blubs |
| `fire` | 100 | crackles, ignition whooshes, torch flutters, sizzles |
| `footstep` | 100 | single steps: grass, gravel, stone, wood, snow, mud |
| `mech` | 100 | doors, chests, levers, switches, gates, winches |
| `person` | 100 | human body foley: heartbeats, breaths, sneezes, claps, snores |
| `rpg` | 100 | swords, spells, potions, level-ups, loot — plus the complete [pixel-rpg](https://github.com/cportka/pixel-rpg) sound set, ported exactly |

Files live at `sfx/<category>/<category>_NNN.wav` (`NNN` = `000`–`099`; the 24 ported
game sounds in `rpg` keep their event names, e.g. `rpg_menu-open.wav`), indexed by
[`sfx/manifest.json`](sfx/manifest.json) with per-effect **description**, duration, and
format metadata.

## Regenerating

Every effect is procedurally generated and **deterministic** — a private PRNG is seeded
from the effect's name, so regeneration is byte-for-byte identical on any platform:

```sh
npm run generate                                                # the whole library + manifest
python3 scripts/generate_sfx.py --out /tmp/x --only jump_007    # spot-check one effect
```

Python 3 stdlib only — no dependencies. The ported game sounds in `rpg` are rendered by an exact port
of that game's Web Audio engine semantics from its pure-data `SOUNDS` table. The test
suite (`npm test`) verifies manifest/file agreement, WAV integrity, the JS API, and
generator determinism; CI runs it on every push and PR.

## Standalone use / forking

The repo is fully self-contained: assets, generator, JS API, tests, and CI have no
dependencies beyond `bash`, `python3`, and (for the JS tests) `node`, so a fork or clone
works as a complete standalone library out of the box. (The optional `.claude/` directory
only configures how Claude Code works in this repo — deleting it changes nothing about
the library.)

## License

[MIT](LICENSE) — free for commercial and non-commercial use, attribution appreciated but
not required.
