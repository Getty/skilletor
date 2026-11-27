# Sourced by the .cicd jobs (k282), not a job itself (SimpiCI runs top-level files only).
# The image is docker.io/oven/bun at the pinned Bun: Debian, as root, the checkout read-only.
# It installs what the suite and the drift check call and the image lacks (git; python3 for the
# Hermes plugin tests; CA certificates for the git sources), checks that the image's Bun is the
# pin (a Bun bump renames the job files), and copies the checkout to $CICD_OUTPUT/src, where the
# job continues. No ownership is copied: git refuses a repository owned by another user.
set -eu

missing=
command -v git >/dev/null 2>&1 || missing="$missing git"
command -v python3 >/dev/null 2>&1 || missing="$missing python3"
[ -e /etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-certificates"
if [ -n "$missing" ]; then
  apt-get update -qq
  # shellcheck disable=SC2086 # one word per package
  DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --no-install-recommends $missing >/dev/null
fi

pin=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).gettyBun.bunVersion)' \
  "$CICD_WORKSPACE/package.json")
if [ "$(bun --version)" != "$pin" ]; then
  printf 'the image runs Bun %s, package.json gettyBun.bunVersion pins %s: rename the .cicd job files\n' \
    "$(bun --version)" "$pin" >&2
  exit 1
fi

cp -R "$CICD_WORKSPACE"/. "$CICD_OUTPUT/src"
cd "$CICD_OUTPUT/src"
