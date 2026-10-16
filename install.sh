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
# updates: the plugin, or the clone. It never uses sudo and touches nothing outside the bin
# dir, the clone and what `claude plugin` itself writes.
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
clone this script is run from, and links its bin/skilletor. Run it again to update.
EOF
}

# Run a command with nothing on stdin: claude and git never wait for an answer, and under
# `curl … | sh` stdin is this script.
quiet_stdin() { "$@" </dev/null; }

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js >= 18 is required but was not found on PATH."
  major=$(quiet_stdin node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || true)
  case "$major" in
    '' | *[!0-9]*) die "could not determine the Node.js version (Node.js >= 18 is required)." ;;
  esac
  [ "$major" -ge 18 ] || die "Node.js >= 18 is required, but found $(quiet_stdin node --version 2>/dev/null)."
}

# Exit 0 when the JSON array on stdin has an element with every key=value given; 2 when stdin
# is no JSON array.
json_has() {
  node -e '
    let list;
    try { list = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch (e) { process.exit(2); }
    if (!Array.isArray(list)) process.exit(2);
    const want = process.argv.slice(1).map((a) => a.split("="));
    process.exit(list.some((e) => e && want.every(([k, v]) => e[k] === v)) ? 0 : 1);
  ' "$@"
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
# plugin update installs into a new versioned directory.
write_shim() {
  printf '#!/bin/sh\n%s (written by skilletor'"'"'s install.sh; run that again to update)\n' "$SHIM_MARK"
  printf 'marketplace=%s\n' "$MARKETPLACE"
  cat <<'EOF'
# Runs the skilletor CLI of the Claude Code plugin installed in user scope (skilletor@<marketplace>
# in installed_plugins.json, that marketplace's first), whichever version is current.
set -eu
plugins=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json
if ! command -v node >/dev/null 2>&1; then
  echo "skilletor: Node.js is required but was not found on PATH (need >= 18)." >&2
  exit 1
fi
# shellcheck disable=SC2016 # JavaScript, single-quoted on purpose
root=$(node -e '
  var fs = require("fs"), file = process.argv[1], want = "skilletor@" + process.argv[2], plugins;
  try { plugins = JSON.parse(fs.readFileSync(file, "utf8")).plugins; } catch (e) {}
  if (!plugins || typeof plugins !== "object") plugins = {};
  var keys = Object.keys(plugins).filter(function (k) { return k.lastIndexOf("@") === 9 && k.slice(0, 9) === "skilletor" && k.length > 10; });
  keys.sort(function (a, b) { return (b === want) - (a === want) || (a < b ? -1 : a > b ? 1 : 0); });
  for (var i = 0; i < keys.length; i++) {
    var entries = [].concat(plugins[keys[i]]);
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e && e.scope === "user" && typeof e.installPath === "string" && fs.existsSync(e.installPath + "/bin/skilletor")) {
        process.stdout.write(e.installPath);
        process.exit(0);
      }
    }
  }
  process.stderr.write("skilletor: no skilletor plugin installed in user scope (" + file + "). " +
    "Install it with `claude plugin install " + want + "`, or run skilletor'"'"'s install.sh again.\n");
  process.exit(1);
' "$plugins" "$marketplace" </dev/null) || exit 1
if [ -x "$root/bin/skilletor" ]; then exec "$root/bin/skilletor" "$@"; fi
exec sh "$root/bin/skilletor" "$@"
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

# The checkout this script is run from (`sh install.sh` in a clone), if any. Under
# `curl … | sh` $0 is the shell, not a file named install.sh.
own_clone() {
  [ -f "$0" ] || return 1
  case "$0" in */install.sh | install.sh) ;; *) return 1 ;; esac
  dir=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd) || return 1
  [ -f "$dir/bin/skilletor" ] && [ -f "$dir/dist/skilletor.js" ] || return 1
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
  [ -f "$clone/bin/skilletor" ] || die "$clone has no bin/skilletor."
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
      die "on Windows, install the Claude Code plugin and use bin\\skilletor.exe; see https://github.com/Getty/skilletor#from-the-command-line" ;;
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

  check_node
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

  version=$(quiet_stdin "$target" --version 2>&1) || die "$target --version failed: $version"
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
