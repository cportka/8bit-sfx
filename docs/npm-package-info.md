# npm package status & release guide

**Package name:** `8bit-sfx` · **This version:** 1.0.0 · **Registry status: PUBLISHED** —
`0.4.1` is live on npm (`latest`); **1.0.0 is prepared here and awaits your `npm publish`.**

<https://www.npmjs.com/package/8bit-sfx>

```sh
npm install 8bit-sfx          # the registry (how pixel-rpg consumes it)
```

## What 1.0.0 means

1.0.0 is the **stable API commitment**: the full ESM surface (21 exports — `render`,
`renderPcm`, `renderWav`, `describe`, `describeFull`, `duration`, `effectNames`,
`categoryCharacter`, `loadManifest`, `soundUrl`, `SfxPlayer`, `COUNT`, `CATEGORIES`,
`GAME_CATEGORIES`, `MUSIC_CATEGORIES`, `GENERATED_COUNTS`, `VARIATIONS`, `PORTED_NAMES`,
`SR`/`SAMPLE_RATE`, `padIndex`), the manifest entry shape (`file`, `category`,
`description`, `duration_s`, `sample_rate`, plus `label`/`gain` on ported sounds), and
effect naming are now covered by SemVer: breaking any of them requires 2.0.0. Existing
effect **names keep their audio** — the generator is seeded per effect name, so effects
only ever get appended, never re-rolled.

## What the published package contains

The `files` field ships `src/` (the engine — ~200 KB of JavaScript), `sfx/manifest.json`
(the catalog), `scripts/generate.mjs`, and `CHANGELOG.md`: a **377 kB tarball / 3.0 MB unpacked**, of
which the catalog is nearly all.

**No audio files ship.** Effects are synthesized on demand from the engine, so 8888 sounds
cost kilobytes of code rather than ~130 MB of WAVs — the reason 1.0.0 exists in this shape.
Consumers who want files run `npm run generate` (or the ⬇ button on the testing page). Inspect
exactly what would ship with:

```sh
npm pack --dry-run
```

## How to update the package (any change)

Per the Portka standard (see `.claude/CLAUDE.md`), every change follows the same loop —
Claude Code does these steps automatically when working in this repo:

1. Branch from `main`; make the change. If sounds changed, regenerate: `npm run generate`
   (deterministic — unchanged categories stay byte-identical).
2. Bump the SemVer version in **`package.json`** (the single source of truth), add a
   `## [x.y.z]` section to `CHANGELOG.md`, and match the `**Version:**` line in
   `README.md`. `tests/run-tests.sh` fails if these disagree (the manifest's `version`
   stamp is regenerated from `package.json` and asserted by the JS tests).
3. `npm test` locally, open a PR, let the `validate` workflow go green, merge.

## How to publish to npm (owner's manual step)

Publishing — like tagging — is **never done by the agent**; it is the outward-facing
release step reserved for the owner:

```sh
git checkout main && git pull            # publish exactly what was merged
npm test                                 # belt and braces
npm login                                # first time on this machine (account: your npm user)
npm publish --otp=XXXXXX                 # XXXXXX = the 6-digit code from your authenticator app
```

### If you get `E403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`

That error is npm's registry policy, not a problem with the package: **npm refuses
publishes from accounts without 2FA** (and from legacy/classic tokens). Two ways out —
do ONE of them:

1. **Enable 2FA on the account** (the recommended path):
   - <https://www.npmjs.com/settings/~/security> (npmjs.com → avatar → *Account
     Settings* → *Two-Factor Authentication*) → enable **Authorization and Publishing**
     with an authenticator app (or a passkey).
   - Then re-run `npm login` (the browser flow picks up the 2FA) and publish with the
     current 6-digit code: `npm publish --otp=123456`. Without `--otp`, npm may prompt
     for the code or open a browser confirmation — either is fine.
2. **Granular access token with 2FA bypass** (for CI/automation): npmjs.com → *Access
   Tokens* → *Generate New Token* → **Granular Access Token**, scope it to the
   `8bit-sfx` package with *Read and write* permission, and check **Bypass two-factor
   authentication**. Then publish with it:
   `NPM_CONFIG_//registry.npmjs.org/:_authToken=npm_XXXX npm publish`
   (or put the token in `~/.npmrc` as `//registry.npmjs.org/:_authToken=npm_XXXX`).
   Treat the token like a password; prefer option 1 for publishes from your laptop.

- The **first** publish claims the free name and creates the package page; add
  `--access public` explicitly if npm prompts (unscoped packages default to public).
- npm rejects re-publishing an existing version — the version bump in step 2 of the
  update loop is what makes `npm publish` possible. A publish that died with E403 did
  NOT consume the version; re-running with 2FA sorted will work without a new bump.
- After publishing, tag the release (`git tag v1.0.0 && git push origin v1.0.0`) and cut
  the GitHub Release from the web UI, per the standard.
- Consider `npm publish --provenance` when publishing from GitHub Actions in the future;
  from a laptop, plain `npm publish` is fine.

## After publishing 1.0.0

- **pixel-rpg needs a follow-up:** its devDependency is `^0.4.1`, and a caret range on a
  `0.x` version will **not** resolve to `1.0.0`. Bump it to `^1.0.0` and delete the now-empty
  `PENDING_PORT` set in `tests/sfx-package.test.mjs` (all 28 game sounds ship as of 1.0.0, so
  that test fails on purpose until the list goes).
- From here SemVer is strict: new categories/effects are MINOR, renames or manifest-shape
  changes are MAJOR. The 44 × 202 uniform shape is asserted by the test suite, so growing the
  library means growing every category together.
