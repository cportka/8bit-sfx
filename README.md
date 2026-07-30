# 8bit-sfx

**Version:** 0.2.0

A free 8-bit sound effects library: **1000 effects**, synthesized NES-style (square and
triangle waves, 15-bit LFSR noise, 16-level amplitude quantization) as 8-bit unsigned
mono WAV at 22050 Hz. MIT licensed — use them in anything.

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

Files live at `sfx/<category>/<category>_NNN.wav` (`NNN` = `000`–`099`), indexed by
[`sfx/manifest.json`](sfx/manifest.json) with per-effect duration and format metadata.

## Regenerating

Every effect is procedurally generated and **deterministic** — a private PRNG is seeded
from the effect's name, so regeneration is byte-for-byte identical on any platform:

```sh
python3 scripts/generate_sfx.py                 # regenerate the whole library + manifest
python3 scripts/generate_sfx.py --out /tmp/x --only jump_007   # spot-check one effect
```

Python 3 stdlib only — no dependencies. The test suite (`bash tests/run-tests.sh`)
verifies manifest/file agreement, WAV integrity, and generator determinism; CI runs it
on every push and PR.

## Standalone use / forking

The repo is fully self-contained: assets, generator, tests, and CI have no dependencies
beyond `bash` and `python3`, so a fork or clone of this repository works as a complete
standalone library out of the box. (The optional `.claude/` directory only configures how
Claude Code works in this repo — deleting it changes nothing about the library.)

## License

[MIT](LICENSE) — free for commercial and non-commercial use, attribution appreciated but
not required.
