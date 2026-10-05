#!/bin/sh
# Refuses a program artifact built with --features test-vrf or test-venue.
# test-vrf stubs the ORAO CPI and puts the randomness account at a PDA of this
# program, so every draw is fabricated. test-venue stubs the yield venue with a
# reserve whose rate anyone can set, so anyone can mint themselves a gain.
# Deploying either is silent: the program loads and runs. There is no CI here,
# so the runbook's deploy steps call this first.
#
# Each feature leaves its name in the binary as a PDA seed literal
# (b"test-vrf", b"test-venue-reserve"), which is what the grep matches.
#
# Unconditional, so it also covers ops-and-envs ticket 06's rule that
# test-vrf may never combine with the staging or mainnet feature: any deploy
# target (dev, staging or mainnet) refuses a tainted binary here, before
# scripts/deploy.sh ever gets to `solana program deploy`. test-venue follows
# the same rule.
#
# Usage: sh scripts/check-deployable.sh [path/to/hex_vault.so]
set -eu

SO="${1:-target/deploy/hex_vault.so}"

if [ ! -f "$SO" ]; then
  echo "check-deployable: $SO is missing; run anchor build (no --features)" >&2
  exit 1
fi

for feature in test-vrf test-venue; do
  hits=$(strings "$SO" | grep -c "$feature" || true)
  if [ "$hits" -ne 0 ]; then
    echo "check-deployable: $SO is a $feature build ($hits matches); rebuild with a plain anchor build" >&2
    exit 1
  fi
done

# The test-only instructions live in test_vrf.rs and test_venue.rs, and the
# panic locations in them name the file. A build without test-venue must also
# carry the klend backing (yield-claimer ticket 12), whose source path is
# compiled in the same way: a binary with neither is a plain build of an
# older tree, and every venue call in it would fail.
hits=$(strings "$SO" | grep -c "src/test_vrf.rs\|src/test_venue.rs" || true)
if [ "$hits" -ne 0 ]; then
  echo "check-deployable: $SO contains test-only instruction code ($hits matches); rebuild with a plain anchor build" >&2
  exit 1
fi
if ! strings "$SO" | grep -q "src/klend.rs"; then
  echo "check-deployable: $SO has no klend backing; rebuild with a plain anchor build of this tree" >&2
  exit 1
fi

echo "check-deployable: $SO carries the klend backing and no test-only code"
