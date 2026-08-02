# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog
(https://keepachangelog.com) and the project uses Semantic Versioning (https://semver.org).
Every change bumps the version and adds an entry below.

## [1.0.0] - 2026-08-02

The first stable release — and a change of substance: **effects are now synthesized on
demand instead of shipped as audio files.**

### Changed — the engine is JavaScript, and the package is a 377 kB download

- **Sounds are generated on the fly, in the browser or in Node.** The synthesis engine was
  rewritten from Python to JavaScript (`src/dsp.js` + `src/generators/*.js`), so
  `render('kick_003')` produces its samples wherever it runs. The npm package no longer
  contains a single `.wav`: a **377 kB download / 3.0 MB unpacked** (engine plus catalog),
  where shipping 8888 effects as audio would have been ~130 MB.
- **WAV export is now optional** (`npm run generate`), and `sfx/*.wav` is git-ignored.
  `sfx/manifest.json` — the catalog of names, descriptions, and durations — is still
  committed and shipped, so browsing 8888 effects never needs synthesis.
- **The Python generator is retired.** There is exactly one implementation of every sound,
  so the two can no longer drift; `scripts/generate.mjs` exports WAVs *using* that engine.
- **Nothing you already had changed.** The JS PRNG is bit-identical to the Python one, and
  every generator that existed in 0.4.1 was verified against its published WAVs: all 22 of
  those categories reproduce **byte-for-byte** across every effect, ported game sounds
  included. (The other 22 categories are new in this release.) Getting there
  required matching a subtlety — Python's `round()` is round-half-to-even, and after the
  16-level crush every sample lands exactly on a `.5` tie, so `Math.round` would have
  shifted half the bytes in every file by one step.
- **`powerup`, `fire` and `jingle` descriptions now tell all 202 variations apart.** Those
  describers only had to separate 100 effects before, so at 202 they collapsed up to a third
  onto identical wording. They now read the sound the way a buyer hears it — key and top
  note, melodic shape, closing interval, pace, pulse width, crackle density — for 200-202
  unique blurbs each (8629 of 8888 across the library). Audio is untouched: the tags behind
  the new wording are derived from draws the generators already made.

### Added

- **22 musical sound-design categories** (202 each): `kick`, `snare`, `hihat`, `tom`,
  `cymbal`, `perc`, `bass`, `sub`, `lead`, `pluck`, `arp`, `chord`, `bell`, `organ`,
  `string`, `brass`, `reed`, `pad`, `riser`, `impact`, `glitch`, `vinyl` — a full drum kit,
  pitched instruments, and transition/texture material for building tracks, not just game
  events. Pitched effects report their musical note (e.g. `C3`) in the description.
- **8888 effects across 44 categories**, uniformly 202 per category (asserted by the suite).
  Every category grew from 100 to 202: indices `000`–`099` keep exactly the sound they had.
- **The last four pixel-rpg sounds** — `xp`, `levelup`, `door`, `clock` — completing the
  ported set at 28 and closing the porting backlog (#4).
- **API:** `render()` (Float32Array), `renderPcm()`, `renderWav()` (a complete .wav),
  `describe()`, `duration()`, `describeFull()`, `effectNames()`, `categoryCharacter()`,
  `COUNT`, `CATEGORIES`/`GAME_CATEGORIES`/`MUSIC_CATEGORIES`. `SfxPlayer` now synthesizes
  rather than fetching — `play()` works with no preloading at all.
- **Testing page:** opens on an **All** view over the whole library (searchable by name and
  description), category chips grouped game/music, live in-browser synthesis, and a **⬇ per
  effect that exports that one sound as a `.wav`**.

### Breaking

- `SfxPlayer.load()` no longer fetches (it just warms the synthesis cache); `play()` works
  without it. `soundUrl()` still resolves a path but the package ships no `.wav` files, so it
  only resolves against an exported directory. Consumers that read `loadManifest()` — the
  shape is unchanged — are unaffected.
- Requires a runtime with ES modules and `TextEncoder` (Node 18+, any modern browser).

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
