# Checking a Round

Every settled or voided Round has a public record. You need nothing from the backend except that one JSON document.

```
curl https://<api host>/rounds/<id>/record
node scripts/verify-round.mjs https://<api host>/rounds/<id>/record
```

The script runs every check below, prints one `ok` line per step, and stops at the first failure with `FAIL <step>: <reason>` and exit code 1. Exit code 2 means the record could not be read or the Round has no result yet. Run `pnpm install` once at the repo root first, since the script needs `drand-client` for the BLS check. It makes no network call beyond the record. `--relay https://api.drand.sh` adds one fetch of the beacon for comparison.

## What the record holds

In this order.

1. `config`. The Game config row that was in force when the Round opened (house cut, tiles per bet, signer and signature of the change).
2. `commitment`. `seedCommitment`, the sha256 of the Round's 32-byte seed, and `openAt`.
3. `delegations`. For each wallet that bet, every session delegation that overlaps the Round, as the signed text and the wallet's signature.
4. `positions`. Every accepted bet in accepted order, with its text, the session key's signature, and the server's `receivedAt`.
5. `close`. `closeAt` and `betListHash`.
6. `beacon`. The quicknet chain hash, the round guard, the drand round and signature, and after the reveal the `seed`, `ctr` and `tile`. A voided Round shows nulls here.
7. `settle`. The ledger rows the Round booked, `reward`, `house_credit` or `refund`.
8. `revocations`. Sessions revoked between `openAt` and `closeAt`.

Signatures are base58 ed25519. The signed bytes are the UTF-8 text, raw, with no wallet header. The `seed` is hex.

## Seven signature checks

1. **S1 delegation signature.** Each delegation text names the wallet, the session key, this program and this cluster, and the wallet's ed25519 signature over its bytes verifies.
2. **S2 delegation dates.** The `Issued At` and `Expiration Time` in the text equal the dates listed, and the delegation runs at most 24 hours.
3. **S3 session key.** Each Position's bet text names a session key, and a delegation in the record gives that key to the Position's owner.
4. **S4 bet signature.** The session key's ed25519 signature over the Position's bet text verifies.
5. **S5 bet text.** The text is in the exact bet format, names this cluster, program, pool and Round, lists distinct ascending tiles from 0 to 35 within the config's tile limit, and stakes at least 1 per tile.
6. **S6 bet timing.** Bets arrive in order between `openAt` and `closeAt`. Each falls inside its delegation (the start may precede `Issued At` by up to 10 minutes, the skew the server allows) and before any revocation of its session.
7. **S7 bet list.** No wallet has two Positions, and the sha256 of the signatures, concatenated as 64-byte values in accepted order, equals `betListHash`.

Within one Round every session has one Position, so S7 cannot show a gap in a session's `seq`. To check for omitted bets, read the same session's `seq` in the neighbouring Rounds' records. The numbers must run 0, 1, 2 with none missing.

## Six beacon steps

1. **B1 seed commitment.** `sha256(seed)` equals `seedCommitment`. A voided Round never reveals its seed, so this step only checks that none is shown.
2. **B2 pinned chain.** The record's chain hash is the quicknet hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` and the round guard is 2. The script carries the chain's public key, period (3 s) and genesis (1692803367) itself and never takes them from the record.
3. **B3 beacon round.** `r = roundAt(closeAt) + 2`, where `roundAt` is `floor((closeAt - genesis) / period) + 1`, with `closeAt` and `genesis` both in seconds. The record's `drandRound` must equal `r`, and round `r` is released after `closeAt`.
4. **B4 beacon signature.** The BLS signature in the record verifies for round `r` under the pinned public key (scheme `bls-unchained-g1-rfc9380`, message `sha256(uint64_be(r))`). With `--relay`, the relay must serve the same signature.
5. **B5 tile.** Compute `x = sha256("hexvault/round/v1" || seed || signature || roundId_le_u64 || ctr_le_u32)` starting at `ctr = 0`. The first four bytes are read as a **little-endian** u32. While that value is at or above `2^32 - (2^32 mod 36)`, bump `ctr` and hash again. Then `tile = u32 mod 36`. Both `tile` and `ctr` must match the record. The signature is the 48 raw bytes, not the hex text.
6. **B6 settle.** Recompute the rows from the Positions, the tile and `config.houseCutBps`, and compare.

### How B6 computes the rows

- The pot is the sum over Positions of tiles times stake per tile.
- Winners are the Positions covering the tile. `onTile` is the sum of their stakes per tile. The losers' pot is the pot minus `onTile`.
- The house cut is `losersPot * houseCutBps / 10000`, rounded down. The rest, `payable`, is shared by stake, each winner's share being `payable * stake / onTile` rounded down.
- A winner's `reward` row is its stake on the tile plus its share. The rounding dust that the shares leave behind goes to the House in the same `house_credit` row as the cut, so the settle rows add up to the pot.
- A tile nobody covered sends the whole pot to the House as one `house_credit` row, with no cut.
- A winner whose stake an `EpochBegan` reset already returned (ADR 0020) gets a `reward` of the share alone. The script accepts either amount for a winner and cannot see the reset, so it prints nothing about which one applied. Compare the reset row in the wallet's ledger if it matters.
- A void gives every Position a `refund` row of its whole stake and the House nothing. A refund that is missing from the record means the same reset returned that stake.

## Voided Rounds

A Round is voided when no valid beacon `r` came within 10 minutes of its release. The record then has `status: "voided"`, null `seed`, `tile` and beacon fields, and refund rows. A void is honest only if the beacon really was missing. Run with `--relay`: if the relay serves a valid round `r`, the script fails B4, because a halted chain catches up and the old round then appears. A void with a retrievable beacon is a fault by the operator.

## What this does not prove

- **Timestamps.** `receivedAt` and `openAt` are the server's word. Nothing in the record disproves a bet backdated to before `closeAt`.
- **A dropped last bet.** A missing bet in the middle of a session shows as a `seq` gap across Rounds. A dropped last bet shows only in the bettor's own log of what it sent.
- **Revocation dates.** The record keeps when a session was revoked, not the wallet's signed revoke request, so the revocations section is also the server's word.
- **Commitment time.** The commitment is posted at `openAt`, but the record cannot prove it was visible before the first bet. Compare it with the value `GET /state` served while the Round was open.
