#!/usr/bin/env bash
#
# run-tests.sh — basic suite scaffolded by repo-bootstrap (Portka standard).
# Binds to the repo's version source of truth (package.json / pyproject.toml / Cargo.toml /
# VERSION / README **Version:**), checks it is SemVer and that CHANGELOG.md and the README
# version line agree, then runs any tests/cases/*.sh. Exit 0 if nothing FAILed, 1 otherwise.
#
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root: $ROOT" >&2; exit 1; }

PASS=0; FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Find the version source of truth, preferring a project manifest over a bare VERSION / README.
# (Bash twin of bootstrap-repo.sh's python detect_version — same priority order by design; if you
# change one, change both. Pure bash here so the scaffold runs dependency-light in the target repo.)
detect_version() {
  local v=""
  if [[ -f package.json ]]; then
    if command -v node >/dev/null 2>&1; then
      v="$(node -e 'try{process.stdout.write(String(require("./package.json").version||""))}catch(e){}' 2>/dev/null)"
    elif command -v python3 >/dev/null 2>&1; then
      v="$(python3 -c 'import json;print(json.load(open("package.json")).get("version") or "")' 2>/dev/null)"
    else
      v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
    fi
    if [[ -n "$v" ]]; then printf 'package.json\t%s\n' "$v"; return; fi
  fi
  local f
  for f in pyproject.toml Cargo.toml; do
    if [[ -f "$f" ]]; then
      v="$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
      if [[ -n "$v" ]]; then printf '%s\t%s\n' "$f" "$v"; return; fi
    fi
  done
  if [[ -f VERSION ]]; then
    v="$(tr -d '[:space:]' < VERSION)"
    if [[ -n "$v" ]]; then printf 'VERSION\t%s\n' "$v"; return; fi
  fi
  if [[ -f README.md ]]; then
    v="$(sed -n 's/.*\*\*Version:\*\*[[:space:]]*\([0-9][^ |]*\).*/\1/p' README.md | head -1)"
    if [[ -n "$v" ]]; then printf 'README.md\t%s\n' "$v"; return; fi
  fi
}

SRC_VER="$(detect_version)"
SRC="$(printf '%s' "$SRC_VER" | cut -f1)"
VER="$(printf '%s' "$SRC_VER" | cut -f2-)"

if [[ -z "$SRC_VER" ]]; then
  fail "no version source found (package.json / pyproject.toml / Cargo.toml / VERSION / README **Version:**)"
else
  if [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.]+)?$ ]]; then
    pass "version is SemVer ($VER from $SRC)"
  else
    fail "version '$VER' (from $SRC) is not SemVer"
  fi
  if [[ -f CHANGELOG.md ]]; then
    # Anchor to a real Keep-a-Changelog heading (## [x.y.z]) — a bare substring match also passed on
    # a URL, a prose mention, or an unrelated version, so a CHANGELOG with no release section for
    # $VER could slip through. Escape dots; brackets are optional (## [1.2.3] or ## 1.2.3).
    _ver_re="^##[[:space:]]+\[?${VER//./\\.}\]?([[:space:]]|\$)"
    if grep -qE "$_ver_re" CHANGELOG.md; then
      pass "CHANGELOG.md has a release section for $VER"
    else
      fail "CHANGELOG.md has no '## [$VER]' release section"
    fi
  fi
  # Cross-check the README version line only when one exists (don't force the convention on repos
  # that track their version elsewhere — requiring it is what made the old scaffold ship red, #59).
  if [[ -f README.md ]] && grep -q '\*\*Version:\*\*' README.md; then
    if grep -qF "**Version:** $VER" README.md; then
      pass "README **Version:** line matches ($VER)"
    else
      fail "README **Version:** line disagrees with $SRC ($VER)"
    fi
  fi
fi

shopt -s nullglob
# Native test suite (scaffolded by repo-bootstrap 1.12.0, #100): if this repo also carries a JS/Python
# test suite, run it HERE and fail closed on its result — so this bash runner (what CI invokes) is a
# SUPERSET of `npm test` / `pytest`, and the two can't drift green-here / red-there. Skipped with a
# note when the toolchain isn't installed, so a docs- or bash-only repo is unaffected.
# JS: let `node --test` DISCOVER its own tests (so a test outside tests/*.mjs still runs); it exits 0
# and prints "# tests 0" when it finds none, which we treat as a clean skip (no false pass/fail).
if [[ -f package.json ]] && command -v node >/dev/null 2>&1; then
  _js_out="$(node --test 2>&1)"; _js_rc=$?
  if grep -qE '(^|[^0-9])# tests 0([^0-9]|$)|no test files found' <<<"$_js_out"; then
    :   # no JS tests discovered — nothing to assert
  elif [[ "$_js_rc" -eq 0 ]]; then pass "native JS: node --test"; else fail "native JS: node --test (run 'node --test' for details)"; fi
fi
# Python: PREFER a real pytest (via the module, not just the CLI) — it runs BOTH pytest-style bare
# `def test_*()` and unittest.TestCase suites and discovers beyond tests/. Only fall back to `unittest`
# when pytest isn't importable, and then trust it ONLY if it actually ran a test: `unittest discover`
# silently IGNORES bare-function tests and still prints "OK" on 0 collected, which would false-green a
# pytest-style suite (review finding). When present tests can't be run, emit a NOTE, never a PASS.
_py_tests=(tests/test_*.py tests/*_test.py test_*.py)
if [[ ${#_py_tests[@]} -gt 0 || -f pyproject.toml ]]; then
  if python3 -c 'import pytest' >/dev/null 2>&1; then
    python3 -m pytest -q >/dev/null 2>&1; _py_rc=$?
    if [[ "$_py_rc" -eq 0 ]]; then pass "native Py: pytest"
    elif [[ "$_py_rc" -eq 5 ]]; then :          # pytest exit 5 = no tests collected — clean skip
    else fail "native Py: pytest (run 'python3 -m pytest' for details)"; fi
  elif [[ ${#_py_tests[@]} -gt 0 ]] && command -v python3 >/dev/null 2>&1; then
    _ut_out="$(python3 -m unittest discover -s tests -p 'test_*.py' 2>&1)"; _ut_rc=$?
    if grep -qE '^Ran [1-9][0-9]* test' <<<"$_ut_out"; then
      if [[ "$_ut_rc" -eq 0 ]]; then pass "native Py: unittest"; else fail "native Py: unittest (run 'python3 -m unittest discover -s tests' for details)"; fi
    else
      echo "  note: Python tests present but no pytest installed and unittest collected 0 (pytest-style?) — install pytest to run them here"
    fi
  fi
fi

for t in tests/cases/*.sh; do
  if bash "$t"; then pass "case: $t"; else fail "case: $t"; fi
done

echo
echo "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
