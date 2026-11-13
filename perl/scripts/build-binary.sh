#!/usr/bin/env bash
# Pack bin/skilletor into one standalone executable with PAR::Packer.
# Run from the dist root (perl/), with Text::Nunjucks on PERL5LIB: it is not on CPAN, so the
# build takes it from a checkout as the test suite does
# (PERL5LIB=<p5-text-nunjucks checkout>/lib:$PERL5LIB). Output: $SKILLETOR_BIN_OUT (default
# ./skilletor). scripts/verify-binary.sh is what proves a build: pp exits 0 on a binary that
# only dies at run time.
set -euo pipefail

OUT="${SKILLETOR_BIN_OUT:-./skilletor}"
[ -f bin/skilletor ] && [ -f lib/Skilletor.pm ] || { echo "ERROR: run from the dist root (perl/)" >&2; exit 1; }
command -v pp >/dev/null 2>&1 || { echo "ERROR: pp (PAR::Packer) is not installed" >&2; exit 1; }

# Text::Nunjucks uses builtin's true/false and is_bool: Perl 5.40 or newer.
perl -e 'exit($] >= 5.040 ? 0 : 1)' \
  || { echo "ERROR: perl $(perl -e 'print $^V') is too old; Text::Nunjucks needs 5.40" >&2; exit 1; }
perl -Ilib -MText::Nunjucks::Environment -e1 2>/dev/null \
  || { echo "ERROR: Text::Nunjucks is not on @INC; it is not on CPAN: PERL5LIB=<p5-text-nunjucks checkout>/lib" >&2; exit 1; }
# Every module needed at run time must be installed, or the loaded set below is short.
perl -Ilib -MMoo -MPath::Tiny -MJSON::MaybeXS -MHash::Ordered -Mnamespace::clean -Mnamespace::autoclean \
  -MHTTP::Tiny -MIO::Socket::SSL -MNet::SSLeay -MMozilla::CA -e1 \
  || { echo "ERROR: runtime dependencies missing (cpanm --installdeps . Mozilla::CA)" >&2; exit 1; }

# The loaded set: scripts/loaded-modules.pl runs every command of the usage text and every hook
# event on a fixture with a local, a git and a url source, and prints every module that came from
# its own file, the dist's own namespace (from lib/ only, never an installed older Skilletor),
# Text::Nunjucks' and the backends HTTP::Tiny and IO::Socket::SSL load by name included.
# verify-binary.sh requires the same list inside the archive.
loaded=(); while IFS= read -r m; do loaded+=("$m"); done < <(perl -Ilib scripts/loaded-modules.pl)
[ "${#loaded[@]}" -gt 100 ] || { echo "ERROR: loaded set suspiciously small (${#loaded[@]})" >&2; exit 1; }
mods=(); for m in "${loaded[@]}"; do mods+=(-M "$m"); done

# Left-out families: what pp's scanner reaches through a require the CLI never runs (Moose behind
# Moo::HandleMoose, CryptX behind Math::BigInt, Test2, the unicore tables, LWP behind
# IO::Socket::SSL::PublicSuffix, Pod). scripts/left-out-modules.pl holds the list and the reasons
# and prints one member per line, found in @INC on this host, less the loaded set: `pp -X Name`
# drops exactly Name.pm and has no wildcard. verify-binary.sh runs the same script on the archive.
nofam=()
while IFS= read -r m; do nofam+=(-X "$m"); done < <(perl -Ilib scripts/left-out-modules.pl -- "${loaded[@]}")
[ "${#nofam[@]}" -gt 0 ] || { echo "ERROR: no family member found to leave out" >&2; exit 1; }

# PAR_VERBATIM=1: pp's POD-stripping filter corrupts files with POD between code.
# -I lib: the checkout's lib/ wins over any installed copy (an older Skilletor in ~/perl5, say);
#     no -M 'Skilletor::**' glob, which searches all of @INC: the loaded set names lib/'s modules.
# Mozilla::CA's cacert.pem comes with it (Module::ScanDeps' preload for Mozilla/CA.pm).
PAR_VERBATIM=1 pp -o "$OUT" \
  -I lib \
  "${mods[@]}" \
  "${nofam[@]}" \
  bin/skilletor

chmod +x "$OUT"
echo "Built $OUT ($(du -h "$OUT" | cut -f1), ${#loaded[@]} modules, $((${#nofam[@]} / 2)) left out)"
