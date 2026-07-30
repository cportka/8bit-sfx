# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog
(https://keepachangelog.com) and the project uses Semantic Versioning (https://semver.org).
Every change bumps the version and adds an entry below.

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
