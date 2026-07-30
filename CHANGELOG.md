# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog
(https://keepachangelog.com) and the project uses Semantic Versioning (https://semver.org).
Every change bumps the version and adds an entry below.

## [0.3.0] - 2026-07-30

### Added
- 1000 new effects in 10 new categories — ambient, ui, voice, dog, zombie, monster, water,
  fire, footstep, mech — bringing the library to 2000 generated effects plus the ported set.
- The `pixelrpg` set: all 24 sounds from cportka/pixel-rpg's `src/audio/sfx.js`, rendered by an
  exact Python port of its Web Audio engine semantics (linear-swept oscillators, exponential
  gain ramps, LCG noise — emulated in float64 so the stream matches browsers bit-for-bit —
  through a swept Q=1 bandpass), at full 8-bit resolution. Each entry carries a `gain` field
  preserving the game's intended cross-sound loudness balance.
- npm packaging: `package.json` (name `8bit-sfx`, `exports` for the API, manifest, and raw
  wavs) and a dependency-free ESM API in `src/index.js` — `loadManifest()`, `soundUrl()`, and a
  Web Audio `SfxPlayer` — working in browsers and Node without a build step.
- `tests/api.test.mjs`: node --test suite for the JS API, auto-discovered by the runner.
- `index.html`: an in-browser sound-testing page served by GitHub Pages from `main` —
  browse every category, search, and click to play. The manifest now carries a `version`
  stamp (from `package.json`) shown on the page and asserted by the JS tests.

### Changed
- Version source of truth moved from the bare `VERSION` file (removed) to `package.json`.

## [0.2.0] - 2026-07-30

### Added
- The sound library itself: 1000 deterministic 8-bit sound effects (10 categories × 100
  variations) as 8-bit unsigned mono WAV at 22050 Hz, generated NES-style by the new
  stdlib-only `scripts/generate_sfx.py`, indexed by `sfx/manifest.json`.
- Test case `tests/cases/sfx-library.sh`: manifest/file agreement, WAV format and
  audibility checks, and a byte-for-byte generator-determinism spot-check.
- README: category table, regeneration instructions, and a standalone-use/forking note.

## [0.1.0] - 2026-07-30

### Added
- Initial scaffold via repo-bootstrap (Portka standard): branch-per-change workflow, an enforced
  SemVer version sync, a basic test suite, and CI.
