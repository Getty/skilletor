#!/usr/bin/env bash
# Prove a packed binary where neither perl nor node exists: the shared conformance cases'
# `cli` steps run it inside a container, through t/60-conformance.t's SKILLETOR_CONFORMANCE_CLI.
#   maint/container-proof.sh <binary>   from the repository root, Text::Nunjucks on PERL5LIB
# The runner, its non-cli steps and the git fixtures run here; maint/container-exec.pl carries
# each `cli` step into the container with its environment, working directory and stdin. The
# cases' temp dirs and the binary live under one proof dir, bind-mounted at the same path.
# The container runs as its root, which rootless podman maps to the calling user, so the files
# it writes are the caller's (no case depends on a permission being refused).
# Image: $SKILLETOR_PROOF_IMAGE (default skilletor-noperl:probe), made when missing from
# $SKILLETOR_PROOF_BASE (default debian:stable-slim) with git and without perl, by docker run
# and docker commit: docker build does not work under rootless podman here.
# Output: the TAP in $SKILLETOR_PROOF_TAP (default: kept only on failure), then the `cli` steps
# passed, failed and skipped. Exit 0 only when every cli step passed.
set -euo pipefail

IMAGE="${SKILLETOR_PROOF_IMAGE:-skilletor-noperl:probe}"
BASE="${SKILLETOR_PROOF_BASE:-debian:stable-slim}"
[ -f t/60-conformance.t ] && [ -d conformance/cases ] \
  || { echo "ERROR: run from the root of a skilletor checkout" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is not installed" >&2; exit 1; }
BIN=$(perl -MCwd=abs_path -e 'print abs_path(shift) // ""' "${1:?usage: container-proof.sh <binary>}")
[ -f "$BIN" ] && [ -x "$BIN" ] || { echo "ERROR: no executable binary: $1" >&2; exit 1; }
perl -Ilib -MText::Nunjucks::Environment -e1 2>/dev/null \
  || { echo "ERROR: Text::Nunjucks is not on @INC (PERL5LIB=<p5-text-nunjucks checkout>/lib)" >&2; exit 1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Making $IMAGE from $BASE"
  maker="skilletor-proof-image-$$"
  # perl-base is Essential on Debian: --force-remove-essential, then whatever is left on disk.
  docker run --name "$maker" "$BASE" sh -c '
    set -e
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
    rm -rf /var/lib/apt/lists/*
    dpkg --purge --force-remove-essential --force-depends perl perl-base \
      $(dpkg-query -W -f "\${Package}\n" | grep -E "^(perl-modules|libperl)") >/dev/null 2>&1 || true
    rm -rf /usr/bin/perl* /usr/lib/x86_64-linux-gnu/perl* /usr/share/perl* /usr/lib/x86_64-linux-gnu/perl-base
    git --version'
  docker commit --change 'CMD ["sh"]' "$maker" "$IMAGE" >/dev/null
  docker rm "$maker" >/dev/null
fi

proof=$(mktemp -d "${TMPDIR:-/tmp}/skilletor-proof.XXXXXX")
proof=$(cd "$proof" && pwd -P)
container="skilletor-proof-$$"
tap="${SKILLETOR_PROOF_TAP:-$proof/conformance.tap}"
keep_tap=
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$keep_tap" ] && [ -z "${SKILLETOR_PROOF_TAP:-}" ]; then
    cp "$tap" "${TMPDIR:-/tmp}/skilletor-proof-$$.tap" && echo "TAP kept: ${TMPDIR:-/tmp}/skilletor-proof-$$.tap"
  fi
  rm -rf "$proof"
}
trap cleanup EXIT
mkdir "$proof/tmp"
cp "$BIN" "$proof/skilletor"

# No network: the cases' git sources are file:// repos under the proof dir.
docker run -d --rm --name "$container" --network none -v "$proof:$proof" "$IMAGE" sleep infinity >/dev/null
for tool in perl node; do
  if docker exec "$container" sh -c "command -v $tool"; then
    echo "FAIL: $tool exists in the container" >&2; exit 1
  fi
done
echo "container $IMAGE: no perl, no node"
docker exec "$container" "$proof/skilletor" --version \
  || { echo "FAIL: the binary does not start in the container" >&2; exit 1; }

cli=$(perl -MJSON::PP -e 'print JSON::PP->new->encode([@ARGV])' -- \
  "$(pwd -P)/maint/container-exec.pl" \
  ${DOCKER_HOST:+--docker-host "$DOCKER_HOST"} \
  --docker-config "${DOCKER_CONFIG:-$HOME/.docker}" \
  "$container" "$proof/skilletor")
rc=0
TMPDIR="$proof/tmp" SKILLETOR_CONFORMANCE_CLI="$cli" prove -lv t/60-conformance.t >"$tap" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || keep_tap=1
tail -n 4 "$tap"

# The cli steps of every case (conformance/cases/*/case.json) against the TAP: a step passed
# when every one of its assertions did, skipped when the Perl runner skipped it or its case.
perl -MJSON::PP - "$tap" conformance/cases <<'PERL' || { keep_tap=1; exit 1; }
use strict; use warnings;
my ( $tap, $cases ) = @ARGV;
my ( %seen, %bad, %skip, $case );
open my $fh, '<', $tap or die "$tap: $!";
while (<$fh>) {
  if    (/\A# Subtest: conformance: (\S+)/)          { $case = $1 }
  elsif (/\A(?:not )?ok \d+ (?:- conformance|# skip)/) { $skip{$case}{'*'} = 1 if /# skip/i && defined $case; undef $case }
  elsif ( defined $case && /\A    (not )?ok \d+ - step (\S+?)(:| skipped)/ ) {
    $seen{$case}{$2} = 1;
    $bad{$case}{$2}  = 1 if $1;
    $skip{$case}{$2} = 1 if $3 ne ':';
  }
}
my ( $pass, $fail, $skipped, @failed ) = ( 0, 0, 0 );
for my $file ( sort glob "$cases/*/case.json" ) {
  my ($name) = $file =~ m{([^/]+)/case\.json\z};
  open my $c, '<', $file or die "$file: $!";
  my $steps = decode_json( do { local $/; <$c> } )->{steps};
  for my $id ( map { $_->{id} } grep { $_->{op} eq 'cli' } @$steps ) {
    if    ( $skip{$name}{'*'} || $skip{$name}{$id} ) { $skipped++ }
    elsif ( !$seen{$name}{$id} || $bad{$name}{$id} ) { $fail++; push @failed, "$name/$id" }
    else                                             { $pass++ }
  }
}
print "cli steps in the container: $pass passed, $fail failed, $skipped skipped\n";
print "  failed: $_\n" for @failed;
exit( $fail ? 1 : 0 );
PERL
[ "$rc" -eq 0 ] || { echo "FAIL: t/60-conformance.t (exit $rc)" >&2; exit 1; }
echo "container proof: OK"
