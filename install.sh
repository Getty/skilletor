#!/bin/sh
# skilletor installer: set skilletor up from a plain shell and leave a stable `skilletor`
# command on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Getty/skilletor/main/install.sh | sh -s -- --no-plugin
#   sh install.sh [--bin-dir DIR] [--no-plugin]     # from a clone
#
# With Claude Code (`claude` on PATH) it installs the plugin skilletor@getty in user scope
# (adding the Getty/marketplace marketplace first) and writes a small `skilletor` script into
# the bin dir that runs whichever version of that install is current, so it survives plugin
# updates. Without Claude Code, or with --no-plugin, it clones the repository (or uses the
# clone it is run from) and links the clone's bin/skilletor into the bin dir. Running it again
# updates: the plugin, or the clone. It never uses sudo and touches nothing outside the bin dir,
# the clone and what `claude plugin` itself writes – but the `skilletor --version` it ends with
# runs the getty-bun starter (bootstrap/getty-bun.sh), which installs the pinned Bun under
# ${GETTY_HOME:-~/.getty} on its first run. It needs neither Node.js nor Bun nor a JSON tool:
# sh, awk and git (k281).
#
# Everything runs from main() on the last line, so a download cut short runs nothing.
set -u

MARKETPLACE=getty
MARKETPLACE_SOURCE=Getty/marketplace
PLUGIN=skilletor@getty
DEFAULT_REPO=https://github.com/Getty/skilletor.git
SHIM_MARK='# skilletor-install-shim'

say() { printf 'skilletor install: %s\n' "$*"; }
warn() { printf 'skilletor install: warning: %s\n' "$*" >&2; }
die() { printf 'skilletor install: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'skilletor install: %s (see --help)\n' "$*" >&2; exit 2; }

usage() {
  cat <<'EOF'
Usage: install.sh [--bin-dir DIR] [--no-plugin]

Sets skilletor up from a plain shell and puts a `skilletor` command into DIR.

  --bin-dir DIR   where the `skilletor` command goes (absolute; default ~/.local/bin)
                  env: SKILLETOR_BIN_DIR
  --no-plugin     do not touch Claude Code; install the CLI from a clone of the repository
                  env: SKILLETOR_NO_PLUGIN=1
  -h, --help      print this and exit

With `claude` on PATH: adds the Getty/marketplace marketplace, installs (or updates) the
plugin skilletor@getty in user scope, and writes a command that runs that install.
Without it (or with --no-plugin): clones the repository into
${XDG_DATA_HOME:-~/.local/share}/skilletor (SKILLETOR_REPO names another one) or uses the
clone this script is run from, and links its bin/skilletor. The first run of the command
installs the pinned Bun under ${GETTY_HOME:-~/.getty}. Run it again to update.
EOF
}

# Run a command with nothing on stdin: claude and git never wait for an answer, and under
# `curl … | sh` stdin is this script.
quiet_stdin() { "$@" </dev/null; }

# The flattened form of the JSON document on stdin (POSIX awk; no Node, no jq): one line per
# string, number, true, false or null in it – its path, a tab, its value: `/0/name<TAB>getty`,
# `/plugins/skilletor@getty/0/scope<TAB>user`. Of a string's escapes it decodes \" \\ and \/;
# the others stay as written. Exit 2 when stdin is no JSON document, or, with root '[', no
# array. write_shim copies the program into the shim, so it holds no single quote.
JSON_FLAT_AWK='
  function fail() { bad = 1; exit 2 }
  function ws() { while (pos <= n && index(" \t\r\n", substr(s, pos, 1)) > 0) pos++ }
  function str(   out, c) {
    out = ""
    pos++
    while (pos <= n) {
      c = substr(s, pos, 1)
      if (c == "\"") { pos++; return out }
      if (c == "\\") {
        c = substr(s, pos + 1, 1)
        if (c == "\"" || c == "\\" || c == "/") out = out c
        else out = out "\\" c
        pos += 2
        continue
      }
      out = out c
      pos++
    }
    fail()
  }
  function value(path,   c, end, i, k, t) {
    ws()
    c = substr(s, pos, 1)
    if (c == "{" || c == "[") {
      end = (c == "{") ? "}" : "]"
      pos++
      ws()
      if (substr(s, pos, 1) == end) { pos++; return }
      for (i = 0; ; i++) {
        ws()
        if (c == "{") {
          if (substr(s, pos, 1) != "\"") fail()
          k = str()
          ws()
          if (substr(s, pos, 1) != ":") fail()
          pos++
          value(path "/" k)
        } else value(path "/" i)
        ws()
        t = substr(s, pos, 1)
        pos++
        if (t == end) return
        if (t != ",") fail()
      }
    }
    if (c == "\"") { t = str(); print path "\t" t; return }
    t = ""
    while (pos <= n && index("+-0123456789.eEtruefalsn", substr(s, pos, 1)) > 0) { t = t substr(s, pos, 1); pos++ }
    if (t == "") fail()
    print path "\t" t
  }
  { s = s $0 "\n" }
  END {
    if (bad) exit 2
    n = length(s)
    pos = 1
    ws()
    if (root != "" && substr(s, pos, 1) != root) exit 2
    value("")
    ws()
    if (pos <= n) exit 2
  }
'
json_flat() { awk -v root="${1-}" "$JSON_FLAT_AWK"; }

# Exit 0 when the JSON array on stdin has an element with every key=value given (no spaces in
# them); 1 when it has none; 2 when stdin is no JSON array.
json_has() {
  flat=$(json_flat '[') || return 2
  printf '%s\n' "$flat" | awk -v want="$*" '
    BEGIN {
      nw = split(want, w, " ")
      for (j = 1; j <= nw; j++) { eq = index(w[j], "="); wk[j] = substr(w[j], 1, eq - 1); wv[j] = substr(w[j], eq + 1) }
    }
    {
      tab = index($0, "\t")
      p = substr($0, 2, tab - 2)
      slash = index(p, "/")
      if (slash < 2 || substr(p, 1, slash - 1) !~ /^[0-9]+$/) next
      i = substr(p, 1, slash - 1)
      k = substr(p, slash + 1)
      seen[i] = 1
      for (j = 1; j <= nw; j++) if (wk[j] == k && wv[j] == substr($0, tab + 1)) hit[i, j] = 1
    }
    END {
      for (i in seen) {
        ok = 1
        for (j = 1; j <= nw; j++) if (!((i, j) in hit)) ok = 0
        if (ok) exit 0
      }
      exit 1
    }
  '
}

install_plugin() {
  say "Claude Code found: installing the plugin $PLUGIN."
  list=$(quiet_stdin claude plugin marketplace list --json) || die "\`claude plugin marketplace list --json\` failed."
  printf '%s' "$list" | json_has "name=$MARKETPLACE"
  case $? in
    0)
      say "marketplace $MARKETPLACE is known; updating it."
      quiet_stdin claude plugin marketplace update "$MARKETPLACE" || die "\`claude plugin marketplace update $MARKETPLACE\` failed."
      ;;
    1)
      quiet_stdin claude plugin marketplace add "$MARKETPLACE_SOURCE" || die "\`claude plugin marketplace add $MARKETPLACE_SOURCE\` failed."
      ;;
    *) die "could not read the output of \`claude plugin marketplace list --json\`." ;;
  esac
  list=$(quiet_stdin claude plugin list --json) || die "\`claude plugin list --json\` failed."
  printf '%s' "$list" | json_has "id=$PLUGIN" scope=user
  case $? in
    0) quiet_stdin claude plugin update "$PLUGIN" --scope user || die "\`claude plugin update $PLUGIN\` failed." ;;
    1) quiet_stdin claude plugin install "$PLUGIN" --scope user || die "\`claude plugin install $PLUGIN\` failed." ;;
    *) die "could not read the output of \`claude plugin list --json\`." ;;
  esac
}

# The command for a plugin install: it looks the install path up on every run, because each
# plugin update installs into a new versioned directory, and runs the bundle there through
# that install's getty-bun starter. sh and awk only, like this script.
write_shim() {
  printf '#!/bin/sh\n%s (written by skilletor'"'"'s install.sh; run that again to update)\n' "$SHIM_MARK"
  printf 'marketplace=%s\n' "$MARKETPLACE"
  printf "json_flat_awk='%s'\n" "$JSON_FLAT_AWK"
  cat <<'EOF'
# Runs the skilletor CLI of the Claude Code plugin installed in user scope (skilletor@<marketplace>
# in installed_plugins.json, that marketplace's first), whichever version is current, through
# the plugin's getty-bun starter, which installs the pinned Bun on its first run.
set -eu
plugins=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json
# Every user-scope install path of a skilletor@<m> entry: "<0 for this marketplace, else 1>
# <TAB><entry><TAB><path>", sorted, so this marketplace's come first, then by key.
candidates=$( { awk "$json_flat_awk" 2>/dev/null <"$plugins" || :; } | awk -v want="skilletor@$marketplace" '
  {
    tab = index($0, "\t")
    p = substr($0, 1, tab - 1)
    if (substr(p, 1, 9) != "/plugins/") next
    rest = substr(p, 10)
    slash = index(rest, "/")
    if (slash == 0) next
    key = substr(rest, 1, slash - 1)
    if (key !~ /^skilletor@[^@]+$/) next
    field = substr(rest, slash + 1)
    entry = key
    slash = index(field, "/")
    if (slash > 0 && substr(field, 1, slash - 1) ~ /^[0-9]+$/) {
      entry = key "/" substr(field, 1, slash - 1)
      field = substr(field, slash + 1)
    }
    owner[entry] = key
    if (field == "scope") scope[entry] = substr($0, tab + 1)
    if (field == "installPath") path[entry] = substr($0, tab + 1)
  }
  END {
    for (e in path) if (scope[e] == "user") printf "%d\t%s\t%s\n", owner[e] != want, e, path[e]
  }
' | LC_ALL=C sort)
tab=$(printf '\t')
root=
while IFS=$tab read -r _rank _entry path; do
  if [ -n "$path" ] && [ -f "$path/bootstrap/getty-bun.sh" ] && [ -f "$path/dist/skilletor.js" ]; then
    root=$path
    break
  fi
done <<LIST
$candidates
LIST
if [ -z "$root" ]; then
  echo "skilletor: no skilletor plugin installed in user scope ($plugins). Install it with \`claude plugin install skilletor@$marketplace\`, or run skilletor's install.sh again." >&2
  exit 1
fi
exec sh "$root/bootstrap/getty-bun.sh" run dist/skilletor.js "$@"
EOF
}

# What is at $target now, for the report; refuses a file this script did not write.
existing() {
  if [ -L "$target" ]; then
    printf 'link to %s' "$(readlink "$target")"
  elif [ -f "$target" ] && grep -q "^$SHIM_MARK" "$target" 2>/dev/null; then
    printf 'shim'
  elif [ -e "$target" ]; then
    die "$target exists and is not one this script wrote; move it away or pass --bin-dir."
  fi
}

place_shim() {
  prev=$(existing) || exit 1
  tmpfile=$bin_dir/.skilletor.install.$$
  if ! { write_shim >"$tmpfile" && chmod 755 "$tmpfile"; }; then
    rm -f "$tmpfile"
    die "could not write $tmpfile."
  fi
  if [ "$prev" = shim ] && cmp -s "$tmpfile" "$target"; then
    rm -f "$tmpfile"
    say "$target: unchanged."
    return
  fi
  mv -f "$tmpfile" "$target" || { rm -f "$tmpfile"; die "could not write $target."; }
  if [ -n "$prev" ] && [ "$prev" != shim ]; then
    say "$target: written (replaced the $prev)."
  else
    say "$target: written."
  fi
}

place_link() {
  launcher=$1
  prev=$(existing) || exit 1
  if [ "$prev" = "link to $launcher" ]; then
    say "$target: unchanged (links to $launcher)."
    return
  fi
  tmplink=$bin_dir/.skilletor.install.$$
  rm -f "$tmplink"
  if ! { ln -s "$launcher" "$tmplink" && mv -f "$tmplink" "$target"; }; then
    rm -f "$tmplink"
    die "could not link $target."
  fi
  if [ -n "$prev" ]; then
    say "$target: links to $launcher (replaced the $prev)."
  else
    say "$target: links to $launcher."
  fi
}

# What a clone needs to run: the launcher, the starter it runs and the bundle.
CLONE_FILES='bin/skilletor bootstrap/getty-bun.sh dist/skilletor.js'

# The checkout this script is run from (`sh install.sh` in a clone), if any. Under
# `curl … | sh` $0 is the shell, not a file named install.sh.
own_clone() {
  [ -f "$0" ] || return 1
  case "$0" in */install.sh | install.sh) ;; *) return 1 ;; esac
  dir=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd) || return 1
  for file in $CLONE_FILES; do
    [ -f "$dir/$file" ] || return 1
  done
  printf '%s' "$dir"
}

install_clone() {
  if clone=$(own_clone); then
    say "using the clone this script runs from: $clone (update it with git pull)."
  else
    clone=${XDG_DATA_HOME:-$HOME/.local/share}/skilletor
    repo=${SKILLETOR_REPO:-$DEFAULT_REPO}
    if [ -d "$clone/.git" ]; then
      say "updating the clone in $clone."
      quiet_stdin git -C "$clone" pull --ff-only --quiet || die "\`git pull\` in $clone failed; update it by hand or move it away."
    elif [ -e "$clone" ]; then
      die "$clone exists but is not a git clone; move it away."
    else
      say "cloning $repo into $clone."
      mkdir -p -- "$(dirname -- "$clone")" || die "could not create $(dirname -- "$clone")."
      quiet_stdin git clone --quiet -- "$repo" "$clone" || die "\`git clone $repo\` failed."
    fi
  fi
  for file in $CLONE_FILES; do
    [ -f "$clone/$file" ] || die "$clone has no $file."
  done
  place_link "$clone/bin/skilletor"
}

main() {
  bin_dir=${SKILLETOR_BIN_DIR:-}
  no_plugin=${SKILLETOR_NO_PLUGIN:-}
  while [ $# -gt 0 ]; do
    case $1 in
      --bin-dir)
        [ $# -ge 2 ] || usage_error "--bin-dir needs a directory"
        bin_dir=$2
        shift 2
        ;;
      --bin-dir=*) bin_dir=${1#*=}; shift ;;
      --no-plugin) no_plugin=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown option: $1" ;;
    esac
  done
  case "$no_plugin" in '' | 0) no_plugin= ;; *) no_plugin=1 ;; esac

  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      die "install.sh does not run on Windows; see https://github.com/Getty/skilletor#from-the-command-line" ;;
  esac
  [ -n "${HOME:-}" ] || die "HOME is not set."
  [ -n "$bin_dir" ] || bin_dir=$HOME/.local/bin
  case "$bin_dir" in
    /*) ;;
    *) usage_error "the bin dir must be an absolute path: $bin_dir" ;;
  esac

  # Git's repository-local variables (a git hook, `rebase -x`) would aim the clone's
  # commands at another repository.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX

  command -v awk >/dev/null 2>&1 || die "awk is required but was not found on PATH."
  command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH."
  mkdir -p -- "$bin_dir" || die "could not create $bin_dir."
  target=$bin_dir/skilletor

  plugin=
  if [ -z "$no_plugin" ] && command -v claude >/dev/null 2>&1; then
    plugin=1
    install_plugin
    place_shim
  else
    if [ -n "$no_plugin" ]; then
      say "--no-plugin: installing the CLI only, from a clone."
    else
      say "Claude Code not found (no claude on PATH): installing the CLI only, from a clone."
    fi
    install_clone
  fi

  # The first run of the starter installs the pinned Bun; its messages go to stderr as they
  # come, stdout is the version.
  version=$(quiet_stdin "$target" --version) || die "$target --version failed (see above)."
  say "skilletor $version is ready: $target"
  case ":${PATH:-}:" in
    *":$bin_dir:"* | *":$bin_dir/:"*) ;;
    *)
      warn "$bin_dir is not on your PATH. Add it in your shell's profile:"
      warn "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  if [ -n "$plugin" ]; then
    say "Running Claude Code sessions load the plugin after a restart."
  fi
  say "Next: skilletor add Getty && skilletor install getty-perl-moo@getty"
}

main "$@"
