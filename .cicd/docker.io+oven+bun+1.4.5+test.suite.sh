#!/bin/sh
# The gate of every change (k282): frozen install, typecheck, the suite, the dist bundle.
set -eu
. "$CICD_WORKSPACE/.cicd/lib/prepare.sh"
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run check-dist
