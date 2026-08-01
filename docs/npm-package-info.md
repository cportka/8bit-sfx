# npm package status & release guide

**Package name:** `8bit-sfx` · **Current version:** 0.4.0 · **Registry status: NOT YET PUBLISHED.**

The name `8bit-sfx` was checked against the npm registry on 2026-07-30 and is **free**
(`https://registry.npmjs.org/8bit-sfx` returns `{"error":"Not found"}`). Until the first
publish, consumers install straight from GitHub — this works today and is how
[pixel-rpg](https://github.com/cportka/pixel-rpg) consumes the package:

```sh
npm install github:cportka/8bit-sfx            # tracks main
npm install github:cportka/8bit-sfx#<commit>   # reproducible pin (recommended)
```

## What the published package contains

The `files` field ships `src/` (the ESM API), `sfx/` (all WAVs + `manifest.json`),
`scripts/generate_sfx.py`, and `CHANGELOG.md` — roughly **35 MB unpacked**, almost all of
it audio. That is well within npm's limits but heavy for a dependency; this is normal for
asset packages. Inspect exactly what would ship with:

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
npm publish                              # add --otp=XXXXXX if 2FA is enabled (it should be)
```

- The **first** publish claims the free name and creates the package page; add
  `--access public` explicitly if npm prompts (unscoped packages default to public).
- npm rejects re-publishing an existing version — the version bump in step 2 of the
  update loop is what makes `npm publish` possible.
- After publishing, tag the release (`git tag v0.4.0 && git push origin v0.4.0`) and cut
  the GitHub Release from the web UI, per the standard.
- Consider `npm publish --provenance` when publishing from GitHub Actions in the future;
  from a laptop, plain `npm publish` is fine.

## After the first publish

- Consumers can switch from the GitHub pin to the registry: `npm install 8bit-sfx@^0.4.0`.
- pixel-rpg's dev-dependency pin (`github:cportka/8bit-sfx#<sha>`) can move to the
  registry version at the owner's leisure — the parity test works with either source.
- Keep `0.x` semantics until `1.0.0`: MINOR may break, PATCH fixes. The first registry
  publish is the natural moment to consider cutting `1.0.0`.
