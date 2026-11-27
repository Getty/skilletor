#!/bin/sh
# The getty-bun starters against a fresh render at the pinned agent-bun-runtime (k282);
# scripts/check-starters.mjs says what it asserts. Clones agent-bun-runtime over the network.
set -eu
. "$CICD_WORKSPACE/.cicd/lib/prepare.sh"
bun run check-starters
