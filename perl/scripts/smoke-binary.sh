#!/usr/bin/env bash
# Smoke-test a packed skilletor binary on a clean machine: no perl from the build, no node, no
# toolchain - the release-binaries workflow's smoke job (skill perl-par-binary-release).
#   scripts/smoke-binary.sh <binary> [<tarball>]       from the dist root (perl/) of a checkout
# With the tarball users download it is unpacked and checked as well: one directory named like
# the tarball, holding skilletor (executable as extracted, identical to the bare binary),
# LICENSE and README; the checks then run against the extracted binary.
#
# Checks: --version prints the plugin's version (../package.json, which the binary reports,
# provisional k167); --help starts with the usage header; an unknown command exits 2; the ported
# commands (sync, check, status) on the fixture t/data/smoke/ - a local source with a template,
# an agent and a rule, and an https url source nobody serves - write stdout, stderr, exit codes
# and files equal byte for byte to the transcript t/data/smoke/expected.txt.
# t/70-smoke-binary.t runs this script with the Perl CLI from lib/ in place of the binary, so
# the transcript stays what the Perl code writes. A command ported later joins the cases below
# (and the transcript, SKILLETOR_SMOKE_UPDATE=1 prove -l t/70-smoke-binary.t).
#
# Windows (Git Bash): --version, --help and the error path only. The Perl port's process layer
# is not Windows-ready yet (k186: Skilletor::Process::spawn_detached dies there), so the
# fixture commands are skipped, and the output says so.
#
# SKILLETOR_SMOKE_UPDATE=1 writes the transcript to t/data/smoke/expected.txt instead of
# comparing it - for the Perl CLI from lib/ only, never for a binary under test.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
[ -n "${1:-}" ] || { echo "usage: smoke-binary.sh <binary> [<tarball>]" >&2; exit 1; }
[ -f bin/skilletor ] && [ -d t/data/smoke ] && [ -f ../package.json ] \
  || fail "run from the dist root (perl/) of a skilletor checkout"
fixture=$(pwd)/t/data/smoke
[ -f "$1" ] || fail "no such binary: $1"
BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
chmod +x "$BIN"    # an Actions artifact or an HTTP download carries no mode
TARBALL=
if [ -n "${2:-}" ]; then
  [ -f "$2" ] || fail "no such tarball: $2"
  TARBALL=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
fi
windows=
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) windows=1 ;; esac

# The version the binary must report: the plugin's.
want=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' ../package.json | head -n 1)
[ -n "$want" ] || fail "cannot read the version from ../package.json"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/cwd" "$work/tmp"

if [ -n "$TARBALL" ]; then
  name=$(basename "$TARBALL" .tar.gz)
  mkdir "$work/tar"
  tar -xzf "$TARBALL" -C "$work/tar" || fail "cannot unpack $TARBALL"
  [ "$(ls -A "$work/tar")" = "$name" ] || fail "the tarball must hold exactly the directory $name/"
  for f in skilletor LICENSE README; do
    [ -f "$work/tar/$name/$f" ] || fail "the tarball lacks $name/$f"
  done
  [ -x "$work/tar/$name/skilletor" ] || fail "$name/skilletor is not executable as extracted"
  cmp -s "$work/tar/$name/skilletor" "$BIN" || fail "$name/skilletor differs from the bare binary"
  BIN="$work/tar/$name/skilletor"
  echo "smoke tarball: OK ($name)"
fi

# The binary under a wiped environment, as a user without perl starts it; PAR unpacks into the
# default cache under the temp dir. Windows needs SYSTEMROOT (Winsock, the crypto RNG), a TEMP
# for that cache and USERPROFILE as the home, all as Windows paths.
if [ -n "$windows" ]; then
  w_home=$(cygpath -w "$work/home")
  w_tmp=$(cygpath -w "$work/tmp")
  bin() {
    env -i PATH=/usr/bin:/bin SYSTEMROOT="${SYSTEMROOT:-C:\\Windows}" USERPROFILE="$w_home" HOME="$w_home" \
      TEMP="$w_tmp" TMP="$w_tmp" "$BIN" "$@" </dev/null
  }
else
  bin() { env -i PATH=/usr/bin:/bin HOME="$work/home" "$BIN" "$@" </dev/null; }
fi

out=$(bin --version) || fail "--version failed"
[ "$out" = "$want" ] || fail "--version prints '$out', want '$want'"
echo "smoke --version: OK ($out)"

rc=0
bin --help >"$work/help" 2>"$work/help.err" || rc=$?
[ "$rc" -eq 0 ] || fail "--help exits $rc: $(head -c 400 "$work/help.err")"
[ "$(head -n 1 "$work/help")" = "skilletor $want" ] || fail "--help starts with '$(head -n 1 "$work/help")'"
grep -q '^Commands:$' "$work/help" || fail "--help prints no Commands: block"
echo "smoke --help: OK"

rc=0
bin nope >/dev/null 2>"$work/nope.err" || rc=$?
[ "$rc" -eq 2 ] || fail "an unknown command exits $rc, want 2"
[ "$(cat "$work/nope.err")" = "skilletor: unknown command: nope" ] || fail "an unknown command says '$(head -c 400 "$work/nope.err")'"
echo "smoke error path: OK (unknown command, exit 2)"

if [ -n "$windows" ]; then
  echo "smoke sync, check, status: SKIPPED on Windows (k186: the process layer is not Windows-ready)"
  echo "smoke: OK (Windows: --version, --help, error path)"
  exit 0
fi

# The fixture: a home with Claude Code's marker and the user config, its local source at ~/src.
# Every command runs in an empty cwd outside any git work tree (a clean image has no git), so
# its project scope is empty.
cp -R "$fixture/src" "$work/home/src"
mkdir -p "$work/home/.claude"
cp "$fixture/user-config.json" "$work/home/.claude/skilletor.json"
printf '{}\n' >"$work/home/.claude.json"

: >"$work/transcript"
# run_case LABEL ARGS...: the command's stdout, stderr and exit code, into the transcript.
run_case() {
  local label=$1 rc=0
  shift
  (cd "$work/cwd" && bin "$@") >"$work/out" 2>"$work/err" || rc=$?
  {
    printf '=== %s\n--- stdout\n' "$label"
    cat "$work/out"
    printf -- '--- stderr\n'
    cat "$work/err"
    printf -- '--- exit %s\n' "$rc"
  } >>"$work/transcript"
}
# files LABEL: every file of the home but skilletor's state dir (it holds times), sorted.
files() {
  {
    printf '=== %s\n' "$1"
    (cd "$work/home" && find . -path ./.claude/skilletor -prune -o -type f -print | LC_ALL=C sort)
  } >>"$work/transcript"
}

run_case "status before a sync" status
run_case "sync" sync
files "files after the sync"
{
  printf '=== the rendered template: .claude/skills/tpl/SKILL.md\n'
  cat "$work/home/.claude/skills/tpl/SKILL.md" 2>/dev/null || printf '(missing)\n'
} >>"$work/transcript"
run_case "check after a sync (the url source never synced: changed)" check
run_case "check --json" check --json
run_case "status after a sync" status
run_case "status --json" status --json
run_case "sync again" sync
run_case "sync --json again" sync --json
run_case "an option sync does not take (exit 2)" sync --bogus
files "files at the end"

expected="$fixture/expected.txt"
if [ -n "${SKILLETOR_SMOKE_UPDATE:-}" ]; then
  cp "$work/transcript" "$expected"
  echo "smoke: transcript written to t/data/smoke/expected.txt (review the diff)"
  exit 0
fi
[ -f "$expected" ] || fail "no expectation t/data/smoke/expected.txt"
if ! cmp -s "$work/transcript" "$expected"; then
  if command -v diff >/dev/null 2>&1; then diff -u "$expected" "$work/transcript" | head -n 60 >&2 || true; fi
  fail "sync, check, status: the transcript differs from t/data/smoke/expected.txt"
fi
echo "smoke sync, check, status: OK (byte-identical to t/data/smoke/expected.txt)"
echo "smoke: OK"
