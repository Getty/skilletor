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
# an agent and a rule, and an https url source nobody serves - and the Claude Code hooks
# (session-start; user-prompt-submit with nothing due, then due: its detached background sync,
# and the next prompt's pending report; cwd-changed and post-tool-use moving into checkouts with
# a project config) write stdout, stderr, exit codes and files equal byte for byte to the
# transcript t/data/smoke/expected.txt, this run's temp dir written as <work>.
# t/70-smoke-binary.t runs this script with the Perl CLI from lib/ in place of the binary, so
# the transcript stays what the Perl code writes. A command ported later joins the cases below
# (and the transcript, SKILLETOR_SMOKE_UPDATE=1 prove -l t/70-smoke-binary.t).
#
# Windows (Git Bash): the same checks and transcript. The binary takes Windows paths: the home
# as USERPROFILE and HOME, the hooks' project and inputs in cygpath -m form (C:/Users/...), which
# the transcript writes as <work> as well. The background sync starts through Win32::Process.
#
# SKILLETOR_SMOKE_WAIT: how many seconds the next prompts may wait for the background sync's
# pending report (default 60).
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

# Its physical path (macOS: /private/var/...), the one the hooks print for a checkout in it.
work=$(cd "$(mktemp -d)" && pwd -P)
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
  envs=(PATH=/usr/bin:/bin SYSTEMROOT="${SYSTEMROOT:-C:\\Windows}" USERPROFILE="$w_home" HOME="$w_home"
        TEMP="$w_tmp" TMP="$w_tmp")
  # A path as the binary takes it: Windows' own, with forward slashes (JSON needs no escape).
  native() { cygpath -m "$1"; }
else
  envs=(PATH=/usr/bin:/bin HOME="$work/home")
  native() { printf '%s\n' "$1"; }
fi
nwork=$(native "$work")
bin() { env -i "${envs[@]}" "$BIN" "$@" </dev/null; }

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

# The fixture: a home with Claude Code's marker and the user config, its local source at ~/src.
# Every command runs in an empty cwd outside any git work tree (a clean image has no git), so
# its project scope is empty. The hooks' checkouts beside it (no git either) hold the project
# config t/data/smoke/project-config.json, which installs a skill of the user's source.
cp -R "$fixture/src" "$work/home/src"
mkdir -p "$work/home/.claude"
cp "$fixture/user-config.json" "$work/home/.claude/skilletor.json"
printf '{}\n' >"$work/home/.claude.json"
for c in prompted cwd-changed post-tool-use; do
  mkdir -p "$work/checkouts/$c/.claude"
  cp "$fixture/project-config.json" "$work/checkouts/$c/.claude/skilletor.json"
done

: >"$work/transcript"
# capture ARGS...: the command, in the empty cwd; its stdout, stderr and exit code into
# $work/out, $work/err and $work/rc.
capture() {
  local rc=0
  (cd "$work/cwd" && bin "$@") >"$work/out" 2>"$work/err" || rc=$?
  echo "$rc" >"$work/rc"
}
# capture_hook EVENT DIR INPUT: `hook EVENT` as Claude Code runs it, in the session's project
# $work/DIR, CLAUDE_PROJECT_DIR naming it, the event's JSON (the file $work/INPUT) on stdin.
capture_hook() {
  local rc=0
  (cd "$work/$2" && env -i "${envs[@]}" CLAUDE_PROJECT_DIR="$nwork/$2" "$BIN" hook "$1" <"$work/$3") \
    >"$work/out" 2>"$work/err" || rc=$?
  echo "$rc" >"$work/rc"
}
# record LABEL: the last capture, into the transcript.
record() {
  {
    printf '=== %s\n--- stdout\n' "$1"
    cat "$work/out"
    printf -- '--- stderr\n'
    cat "$work/err"
    printf -- '--- exit %s\n' "$(cat "$work/rc")"
  } >>"$work/transcript"
}
# run_case LABEL ARGS...: a command into the transcript; hook_case LABEL EVENT DIR INPUT: a hook.
run_case() { local label=$1; shift; capture "$@"; record "$label"; }
hook_case() { local label=$1; shift; capture_hook "$@"; record "$label"; }
# files LABEL [DIR]: every file of $work/DIR (default: the home) but skilletor's state dir (it
# holds times), sorted.
files() {
  {
    printf '=== %s\n' "$1"
    (cd "$work/${2:-home}" && find . -path ./.claude/skilletor -prune -o -type f -print | LC_ALL=C sort)
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

# The hooks' inputs as Claude Code sends them: the session "smoke" starts in the empty cwd and
# moves into two checkouts; the session "smoke-prompted" prompts in a checkout never checked.
printf '{"session_id":"smoke","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}\n' \
  "$nwork/cwd" >"$work/start.json"
printf '{"session_id":"smoke","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"hi"}\n' \
  "$nwork/cwd" >"$work/prompt.json"
printf '{"session_id":"smoke-prompted","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"hi"}\n' \
  "$nwork/checkouts/prompted" >"$work/prompted.json"
printf '{"session_id":"smoke","cwd":"%s","old_cwd":"%s","new_cwd":"%s","hook_event_name":"CwdChanged"}\n' \
  "$nwork/checkouts/cwd-changed" "$nwork/cwd" "$nwork/checkouts/cwd-changed" >"$work/moved.json"
printf '{"session_id":"smoke","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cd %s"}}\n' \
  "$nwork/checkouts/post-tool-use" "$nwork/checkouts/post-tool-use" >"$work/bash-cd.json"

hook_case "hook session-start (the check says changed: a sync, the url source's warning)" session-start cwd start.json
hook_case "hook user-prompt-submit (checked at the session start: nothing due)" user-prompt-submit cwd prompt.json
hook_case "hook user-prompt-submit in a checkout never checked (due: the background sync starts)" \
  user-prompt-submit checkouts/prompted prompted.json
# The next prompts there until one hands out the background sync's report, each one before it
# silent. Bounded: a background sync that never ran leaves no report.
wait_s=${SKILLETOR_SMOKE_WAIT:-60}
until_s=$((SECONDS + wait_s))
while :; do
  capture_hook user-prompt-submit checkouts/prompted prompted.json
  [ "$(cat "$work/rc")" = 0 ] && [ ! -s "$work/err" ] \
    || fail "a prompt waiting for the pending report exits $(cat "$work/rc"): $(head -c 400 "$work/err")"
  [ -s "$work/out" ] && break
  [ "$SECONDS" -lt "$until_s" ] || fail "no pending report within $wait_s s: the background sync did not run"
  sleep 0.2
done
record "the next prompt there: the background sync's pending report"
hook_case "hook cwd-changed (into a checkout whose lock does not match its config: synced)" \
  cwd-changed cwd moved.json
hook_case "hook post-tool-use (a cd from the session's start into another checkout: synced)" \
  post-tool-use cwd bash-cd.json
hook_case "hook post-tool-use again (the session's cwd as recorded: nothing to do)" post-tool-use cwd bash-cd.json
files "files at the end"
files "files of the checkouts at the end" checkouts

# This run's temp dir, which the hooks print with a checkout's path (Windows: its native form),
# as <work>.
work_re=$(printf '%s' "$work" | sed 's/[]\/$*.^[]/\\&/g')
nwork_re=$(printf '%s' "$nwork" | sed 's/[]\/$*.^[]/\\&/g')
sed -e "s/$nwork_re/<work>/g" -e "s/$work_re/<work>/g" "$work/transcript" >"$work/transcript.txt"

expected="$fixture/expected.txt"
if [ -n "${SKILLETOR_SMOKE_UPDATE:-}" ]; then
  cp "$work/transcript.txt" "$expected"
  echo "smoke: transcript written to t/data/smoke/expected.txt (review the diff)"
  exit 0
fi
[ -f "$expected" ] || fail "no expectation t/data/smoke/expected.txt"
if ! cmp -s "$work/transcript.txt" "$expected"; then
  if command -v diff >/dev/null 2>&1; then diff -u "$expected" "$work/transcript.txt" | head -n 60 >&2 || true; fi
  fail "sync, check, status, hooks: the transcript differs from t/data/smoke/expected.txt"
fi
echo "smoke sync, check, status, hooks: OK (byte-identical to t/data/smoke/expected.txt)"
echo "smoke: OK"
