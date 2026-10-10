#!/usr/bin/env node
// Checks a published Round record with no access to the backend
// (off-chain-tickets ticket 19). The steps are the ones in docs/game-verification.md:
// seven signature checks (S1 to S7), then six beacon steps (B1 to B6).
// It exits 1 on the first failed step and names it; 2 when the record cannot be read.
//
// Usage: node scripts/verify-round.mjs <record url> [--relay https://api.drand.sh]
//
// The only network call is the record itself, plus one drand relay fetch when
// --relay is given. Nothing here imports the backend: the constants and the
// tile and settle math are written out again on purpose, so a bug in the
// engine does not hide in the check.
import { createHash, createPublicKey, verify } from "node:crypto";

import { fetchBeacon, roundAt, roundTime } from "drand-client";

// Pinned drand quicknet (research 03). A record cannot change these.
const QUICKNET = {
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1692803367,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
};
const RECORD_VERSION = 1;
const BEACON_ROUND_GUARD = 2;
const TILE_COUNT = 36;
const TILE_DOMAIN = "hexvault/round/v1";
const SESSION_MAX_MS = 24 * 3600 * 1000;
const ISSUED_AT_SKEW_MS = 10 * 60 * 1000;
const U32 = 2 ** 32;
const REJECT_AT = U32 - (U32 % TILE_COUNT);

class Failure extends Error {}
const fail = (step, why) => {
  throw new Failure(`${step}: ${why}`);
};

const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(text) {
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leading = [...text].findIndex((ch) => ch !== "1");
  return Buffer.concat([Buffer.alloc(leading < 0 ? text.length : leading), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
}

/** Raw ed25519 over the UTF-8 bytes of `message`, as Phantom and Solflare sign it. */
function edVerify(keyBase58, message, signatureBase58) {
  try {
    const raw = base58(keyBase58);
    const signature = base58(signatureBase58);
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

const LABELS = ["cluster", "program", "pool", "round", "session", "seq", "tiles", "stake"];
/** The bet text apps/backend/src/api/bet.ts writes, byte for byte; null for anything else. */
function parseBet(message) {
  const lines = message.split("\n");
  if (lines.length !== LABELS.length + 1 || lines[0] !== "HexVault bet v1") return null;
  const v = {};
  for (const [i, label] of LABELS.entries()) {
    if (!lines[i + 1].startsWith(`${label}: `)) return null;
    v[label] = lines[i + 1].slice(label.length + 2);
  }
  const whole = /^(0|[1-9]\d{0,18})$/;
  if (!whole.test(v.round) || !whole.test(v.seq) || !whole.test(v.stake)) return null;
  if (!/^\d{1,2}(,\d{1,2})*$/.test(v.tiles)) return null;
  const bet = { ...v, round: BigInt(v.round), seq: Number(v.seq), stake: BigInt(v.stake), tiles: v.tiles.split(",").map(Number) };
  const again = ["HexVault bet v1", ...LABELS.map((l) => `${l}: ${l === "tiles" ? bet.tiles.join(",") : v[l]}`)].join("\n");
  return again === message ? bet : null;
}

/** First four bytes of the hash are a LITTLE-ENDIAN u32; `ctr` bumps while the sample is in the rejected tail. */
function deriveTile(seed, signature, roundId) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(roundId);
  for (let ctr = 0; ; ctr++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(ctr);
    const x = sha256(TILE_DOMAIN, seed, signature, id, counter);
    const sample = x.readUInt32LE(0);
    if (sample < REJECT_AT) return { tile: sample % TILE_COUNT, ctr };
  }
}

function usage(why) {
  console.error(`${why}\nUsage: node scripts/verify-round.mjs <record url> [--relay https://api.drand.sh]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const relayAt = args.indexOf("--relay");
const relay = relayAt >= 0 ? args.splice(relayAt, 2)[1] : undefined;
if (args.length !== 1 || (relayAt >= 0 && relay === undefined)) usage("Give one record URL.");

let record;
try {
  const res = await fetch(args[0], { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  record = await res.json();
} catch (cause) {
  console.error(`cannot read the record at ${args[0]}: ${cause.message}`);
  process.exit(2);
}
if (record.version !== RECORD_VERSION) usage(`record version ${record.version} is not one this script knows (${RECORD_VERSION}).`);
if (record.status !== "settled" && record.status !== "voided") {
  console.error(`Round ${record.round} is ${record.status}; it has no result to check yet.`);
  process.exit(2);
}

const ok = (step, note) => console.log(`ok   ${step}${note ? `  ${note}` : ""}`);

try {
  const voided = record.status === "voided";
  const roundId = BigInt(record.round);
  const openAt = Date.parse(record.commitment.openAt);
  const closeAt = Date.parse(record.close.closeAt);
  const { beacon, config } = record;

  // S1 to S2: the delegations.
  const delegations = new Map();
  for (const d of record.delegations) {
    const lines = d.message.split("\n");
    const pick = (prefix) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const who = `delegation of ${d.wallet} for ${d.sessionPubkey}`;
    if (delegations.has(d.sessionPubkey)) fail("S1 delegation signature", `${d.sessionPubkey} is delegated twice`);
    if (
      lines[1] !== d.wallet ||
      pick("- hexvault:session:") !== d.sessionPubkey ||
      pick("- hexvault:program:") !== record.program ||
      pick("Chain ID: ") !== record.cluster
    ) {
      fail("S1 delegation signature", `${who} does not name this wallet, key, program and cluster`);
    }
    if (!edVerify(d.wallet, d.message, d.signature)) fail("S1 delegation signature", `${who} is not signed by the wallet`);
    const issued = Date.parse(pick("Issued At: "));
    const expires = Date.parse(pick("Expiration Time: "));
    if (issued !== Date.parse(d.issuedAt) || expires !== Date.parse(d.expiresAt)) {
      fail("S2 delegation dates", `${who} lists dates that differ from the signed text`);
    }
    if (!(expires > issued) || expires - issued > SESSION_MAX_MS) fail("S2 delegation dates", `${who} runs longer than 24 hours`);
    delegations.set(d.sessionPubkey, { wallet: d.wallet, issued, expires });
  }
  ok("S1 delegation signature", `${delegations.size} delegation(s)`);
  ok("S2 delegation dates");

  // S3 to S5: each Position.
  const bets = record.positions.map((p, i) => {
    const bet = parseBet(p.message);
    if (bet === null) fail("S5 bet text", `position ${i + 1} is not a canonical bet text`);
    return bet;
  });
  record.positions.forEach((p, i) => {
    const d = delegations.get(bets[i].session);
    if (d === undefined || d.wallet !== p.owner) {
      fail("S3 session key", `position ${i + 1} names key ${bets[i].session}, which ${p.owner} did not delegate`);
    }
  });
  ok("S3 session key", `${bets.length} bet(s)`);
  record.positions.forEach((p, i) => {
    if (!edVerify(bets[i].session, p.message, p.signature)) fail("S4 bet signature", `position ${i + 1} is not signed by its session key`);
  });
  ok("S4 bet signature");
  bets.forEach((bet, i) => {
    const sorted = bet.tiles.every((t, j) => t < TILE_COUNT && (j === 0 || t > bet.tiles[j - 1]));
    if (bet.cluster !== record.cluster || bet.program !== record.program || bet.pool !== record.pool || bet.round !== roundId) {
      fail("S5 bet text", `position ${i + 1} names another cluster, program, pool or Round`);
    }
    if (!sorted || bet.tiles.length > config.maxTilesPerBet || bet.stake < 1n) {
      fail("S5 bet text", `position ${i + 1} has tiles or a stake the game does not allow`);
    }
  });
  ok("S5 bet text");

  // S6: timing, delegation life, revocations.
  const revoked = new Map(record.revocations.map((r) => [r.sessionPubkey, Date.parse(r.revokedAt)]));
  let last = openAt;
  record.positions.forEach((p, i) => {
    const at = Date.parse(p.receivedAt);
    const d = delegations.get(bets[i].session);
    if (at < last || at > closeAt) fail("S6 bet timing", `position ${i + 1} was received out of order or after close`);
    if (at < d.issued - ISSUED_AT_SKEW_MS || at >= d.expires) fail("S6 bet timing", `position ${i + 1} falls outside its delegation`);
    if (revoked.has(bets[i].session) && at >= revoked.get(bets[i].session)) {
      fail("S6 bet timing", `position ${i + 1} was received after its session was revoked`);
    }
    last = at;
  });
  ok("S6 bet timing");

  // S7: one Position per wallet, and the ordered list matches the hash published at close.
  const seen = new Set();
  for (const { owner } of record.positions) {
    if (seen.has(owner)) fail("S7 bet list", `${owner} has two positions`);
    seen.add(owner);
  }
  const listHash = sha256(...record.positions.map((p) => base58(p.signature))).toString("hex");
  if (listHash !== record.close.betListHash) fail("S7 bet list", `signatures hash to ${listHash}, the record says ${record.close.betListHash}`);
  ok("S7 bet list");

  // B1: the seed matches the commitment made before the first bet.
  if (voided) {
    if (beacon.seed !== null || beacon.tile !== null || beacon.drandSignature !== null) fail("B1 seed commitment", "a voided Round shows a seed, tile or beacon");
    ok("B1 seed commitment", "voided, no seed revealed");
  } else {
    if (!/^[0-9a-f]{64}$/.test(beacon.seed ?? "")) fail("B1 seed commitment", "the record has no 32-byte seed");
    if (sha256(Buffer.from(beacon.seed, "hex")).toString("hex") !== record.commitment.seedCommitment) {
      fail("B1 seed commitment", "sha256(seed) is not the commitment");
    }
    ok("B1 seed commitment");
  }

  // B2: the chain is the pinned one.
  if (beacon.chainHash !== QUICKNET.hash) fail("B2 pinned chain", `record names chain ${beacon.chainHash}`);
  if (beacon.roundGuard !== BEACON_ROUND_GUARD) fail("B2 pinned chain", `record uses a round guard of ${beacon.roundGuard}, not ${BEACON_ROUND_GUARD}`);
  ok("B2 pinned chain", `quicknet ${QUICKNET.hash.slice(0, 8)}`);

  // B3: the beacon round is the one after close, released after close.
  const r = roundAt(closeAt, QUICKNET) + BEACON_ROUND_GUARD;
  if (roundTime(QUICKNET, r) <= closeAt) fail("B3 beacon round", `round ${r} was released before close`);
  if (!voided && beacon.drandRound !== String(r)) fail("B3 beacon round", `Round closes at ${record.close.closeAt}, so the beacon is ${r}; the record uses ${beacon.drandRound}`);
  ok("B3 beacon round", `drand round ${r}`);

  // B4: the BLS signature, against the pinned key. A relay is only a second opinion.
  const clientFor = (get) => ({
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: "pinned", info: async () => QUICKNET }),
    get,
    latest: async () => {
      throw new Error("unused");
    },
  });
  const asBeacon = (signature) => ({ round: r, signature, randomness: sha256(Buffer.from(signature, "hex")).toString("hex") });
  if (voided) {
    if (relay === undefined) {
      ok("B4 beacon signature", "voided; pass --relay to confirm the beacon was really missing");
    } else {
      const served = await fetch(`${relay}/${QUICKNET.hash}/public/${r}`, { signal: AbortSignal.timeout(15_000) }).then((res) => (res.ok ? res.json() : null), () => null);
      let valid = false;
      if (served !== null) valid = await fetchBeacon(clientFor(async () => served), r).then(() => true, () => false);
      if (valid) fail("B4 beacon signature", `the Round was voided but the relay serves a valid beacon ${r}`);
      ok("B4 beacon signature", "voided and the relay has no valid beacon");
    }
  } else {
    await fetchBeacon(clientFor(async () => asBeacon(beacon.drandSignature)), r).catch(() => fail("B4 beacon signature", `the signature does not verify for drand round ${r}`));
    if (relay !== undefined) {
      const served = await fetch(`${relay}/${QUICKNET.hash}/public/${r}`, { signal: AbortSignal.timeout(15_000) }).then((res) => res.json());
      if (served.signature !== beacon.drandSignature) fail("B4 beacon signature", "the relay serves a different signature for this round");
    }
    ok("B4 beacon signature", relay === undefined ? undefined : "matches the relay");
  }

  // B5: the tile.
  if (voided) {
    ok("B5 tile", "voided, no tile");
  } else {
    const { tile, ctr } = deriveTile(Buffer.from(beacon.seed, "hex"), Buffer.from(beacon.drandSignature, "hex"), roundId);
    if (tile !== beacon.tile || ctr !== beacon.ctr) fail("B5 tile", `seed and beacon give tile ${tile} (ctr ${ctr}); the record says ${beacon.tile} (ctr ${beacon.ctr})`);
    ok("B5 tile", `tile ${tile}, ctr ${ctr}`);
  }

  // B6: the settle rows follow from the bets, the tile and the Game config.
  const stakes = bets.map((b) => BigInt(b.tiles.length) * b.stake);
  const pot = stakes.reduce((a, b) => a + b, 0n);
  const rows = (reason) => record.settle.filter((row) => row.reason === reason);
  const only = (list, what) => {
    const owners = list.map((row) => row.owner);
    if (new Set(owners).size !== owners.length) fail("B6 settle", `${what} has two rows for one wallet`);
  };
  for (const reason of ["reward", "refund", "house_credit"]) only(rows(reason), `${reason} rows`);
  const delta = (reason, owner) => BigInt(rows(reason).find((row) => row.owner === owner)?.delta ?? 0);

  if (voided) {
    if (rows("reward").length > 0 || rows("house_credit").length > 0) fail("B6 settle", "a voided Round books a reward or a House credit");
    for (const row of rows("refund")) {
      const at = record.positions.findIndex((p) => p.owner === row.owner);
      if (at < 0 || BigInt(row.delta) !== stakes[at]) fail("B6 settle", `refund to ${row.owner} is not that wallet's stake`);
    }
    ok("B6 settle", `${rows("refund").length} refund(s) of whole stakes`);
  } else {
    const winners = bets.map((b, i) => i).filter((i) => bets[i].tiles.includes(beacon.tile));
    const onTile = winners.reduce((sum, i) => sum + bets[i].stake, 0n);
    const wins = new Set(winners.map((i) => record.positions[i].owner));
    if (rows("refund").length > 0 || rows("reward").some((row) => !wins.has(row.owner))) fail("B6 settle", "a reward or refund goes to a wallet that did not win");
    let toHouse;
    if (onTile === 0n) {
      toHouse = pot;
    } else {
      const losers = pot - onTile;
      const cut = (losers * BigInt(config.houseCutBps)) / 10_000n;
      const payable = losers - cut;
      let shares = 0n;
      for (const i of winners) {
        const share = (payable * bets[i].stake) / onTile;
        shares += share;
        const got = delta("reward", record.positions[i].owner);
        // A stake an EpochBegan reset already returned (ADR 0020) is not paid twice, so the row is the share alone.
        if (got !== share + bets[i].stake && got !== share) fail("B6 settle", `reward to ${record.positions[i].owner} is ${got}, expected ${share + bets[i].stake}`);
      }
      toHouse = cut + payable - shares;
    }
    const houseRows = rows("house_credit");
    if (houseRows.length > 1 || (houseRows[0] ? BigInt(houseRows[0].delta) : 0n) !== toHouse) fail("B6 settle", `House credit is not ${toHouse}`);
    ok("B6 settle", `pot ${pot}, House ${toHouse}`);
  }

  console.log(`VERIFIED Round ${record.round}: ${record.status}${voided ? "" : `, tile ${beacon.tile}`}`);
} catch (cause) {
  if (!(cause instanceof Failure)) throw cause;
  console.error(`FAIL ${cause.message}`);
  process.exit(1);
}
