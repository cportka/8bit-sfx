#!/usr/bin/env bash
#
# sfx-library.sh — validate the committed sound-effect library.
# Checks the manifest and files agree, every WAV is a well-formed 8-bit mono
# 22050 Hz file with audible content, and the generator reproduces committed
# files byte-for-byte (so regeneration can't silently drift the assets).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - <<'EOF' || exit 1
import glob, json, sys, wave

manifest = json.load(open("sfx/manifest.json"))
files = sorted(glob.glob("sfx/*/*.wav"))
listed = sorted(e["file"] for e in manifest["effects"])

errs = []
if manifest["count"] != len(manifest["effects"]):
    errs.append("manifest count field disagrees with its own entries")
if len(files) != len(listed) or [f.removeprefix("sfx/") for f in files] != listed:
    errs.append("files on disk (%d) do not match manifest entries (%d)" % (len(files), len(listed)))
if not 1950 <= len(files) <= 2150:
    errs.append("expected ~2000+ effects, found %d" % len(files))
if sum(1 for e in manifest["effects"] if e["category"] == "pixelrpg") != 24:
    errs.append("pixelrpg ported set should have exactly 24 sounds")

for f in files:
    try:
        with wave.open(f) as w:
            data = w.readframes(w.getnframes())
            if w.getframerate() != 22050 or w.getsampwidth() != 1 or w.getnchannels() != 1:
                errs.append("wrong format: " + f)
            elif not data or max(data) - min(data) < 8:
                errs.append("empty or near-silent: " + f)
    except Exception as e:
        errs.append("unreadable %s: %s" % (f, e))

for e in errs[:10]:
    print("  " + e, file=sys.stderr)
sys.exit(1 if errs else 0)
EOF

# Determinism spot-check: regenerate a few effects and compare byte-for-byte.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
python3 scripts/generate_sfx.py --out "$tmp" \
  --only jump_007 explosion_042 jingle_099 water_013 footstep_055 pixelrpg_zombie || exit 1
for f in jump/jump_007 explosion/explosion_042 jingle/jingle_099 \
         water/water_013 footstep/footstep_055 pixelrpg/pixelrpg_zombie; do
  cmp -s "sfx/$f.wav" "$tmp/$f.wav" || { echo "  generator drift: $f.wav" >&2; exit 1; }
done
