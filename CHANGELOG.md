# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog
(https://keepachangelog.com) and the project uses Semantic Versioning (https://semver.org).
Every change bumps the version and adds an entry below.

## [0.4.1] - 2026-08-01

### Added
- Funding metadata: `.github/FUNDING.yml` (GitHub Sponsors, Buy Me a Coffee, Venmo,
  BTC/ETH) and the matching `funding` field in `package.json`, which npm surfaces via
  `npm fund` once the package is published.

### Fixed
- `docs/npm-package-info.md`: the publish guide now covers npm's `E403 … Two-factor
  authentication or granular access token with bypass 2fa enabled is required` refusal —
  the registry requires 2FA on the account (or a granular token with 2FA bypass) before
  any publish; documented both remedies step by step. A publish that failed with E403
  did not consume the version number.

### Changed
- Testing page: category chips now show just the category name, and the selected
  category (or a search) renders as a clean table — play button, effect name,
  full-width readable description, duration — instead of button soup. Clicking a
  category no longer auto-plays a random sample.

## [0.4.0] - 2026-07-30

### Added
- **Per-effect catalog descriptions**: every generator now records its synthesis decisions
  (`rng.tags`) and a per-category describer turns them into a short, distinctive
  `description` field in the manifest — derived from the actual parameters (sub-style,
  pitches, counts, textures), so users can pick sounds by reading instead of auditioning.
  The 24 ported game sounds carry hand-written descriptions. Shown as tooltips and in the
  playback status on the testing page, and searchable there.
- **`person` category** (100 effects): human body foley — heartbeats, breathing, sneezes,
  coughs, snores, yawns, gulps, chewing, claps, finger snaps, shivers, stomach growls —
  distinct from `voice` (which stays vocal: babble, grunts, laughs, sighs).
- **`rpg` category grown to 100**: 76 new RPG-mechanics staples (swords, bows, spell
  casts, heals, potions, level-ups, quest stingers, loot jingles, chests, shields, traps,
  teleports, game-over stings, save chimes) alongside the 24 ported game sounds.
- `docs/npm-package-info.md`: the package's npm status (name free, not yet published) and
  the update/publish playbook.

### Changed
- **Renamed the `pixelrpg` category to `rpg`** (files `rpg/rpg_<name>.wav`). Consumers
  filtering on `category === 'pixelrpg'` must switch to `'rpg'`; the ported sounds'
  `label` fields are unchanged. All other 0.3.0 categories are byte-identical.

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
