// Every event in the IDL decoded from a `Program data:` line.
//
// The bytes are laid out here by hand rather than by the Anchor coder that
// decodes them: encoding with the coder under test would pass whatever the
// coder happens to do. A field reordered in events.rs, a type widened, or a
// stale IDL snapshot all fail here.
import { BN, BorshCoder, convertIdlToCamelCase, EventParser } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import {
  decodeEventLogs,
  jsonify,
  playerRow,
  poolRow,
  type DecodedPlayer,
  type DecodedPool,
} from "./decode";

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
// `Program` camelCases the IDL before building its coder, so the field names
// the indexer stores are camelCase even though the IDL file is snake_case.
// The coder here is built the same way for the same reason.
const parser = new EventParser(PROGRAM_ID, new BorshCoder(convertIdlToCamelCase(idl)));

const u8 = (value: number): Buffer => Buffer.from([value]);
const u16 = (value: number): Buffer => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
};
const u32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
};
const bool = (value: boolean): Buffer => Buffer.from([value ? 1 : 0]);

const u64 = (value: bigint): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
};

const i64 = (value: bigint): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return buf;
};

const u128 = (value: bigint): Buffer =>
  Buffer.concat([u64(value & 0xffffffffffffffffn), u64(value >> 64n)]);

const key = (base58: string): Buffer => new PublicKey(base58).toBuffer();

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POOL = "So11111111111111111111111111111111111111112";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A Yield index past 2^64, so a narrow decode of the post-state field fails. */
const INDEX = (1n << 70n) + 5n;
const INDEX_STR = "1180591620717411303429";

/** One transaction's logs, shaped the way the RPC delivers them. */
function logs(discriminator: number[], fields: Buffer[]): string[] {
  const payload = Buffer.concat([Buffer.from(discriminator), ...fields]);
  return [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    "Program log: Instruction: Whatever",
    `Program data: ${payload.toString("base64")}`,
    `Program ${PROGRAM_ID.toBase58()} consumed 12345 of 200000 compute units`,
    `Program ${PROGRAM_ID.toBase58()} success`,
  ];
}

function discriminatorOf(name: string): number[] {
  const event = (idl.events ?? []).find((candidate) => candidate.name === name);
  if (!event) throw new Error(`event ${name} is not in the IDL`);
  return event.discriminator;
}

interface Case {
  name: string;
  fields: Buffer[];
  data: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "PoolCreated",
    fields: [key(POOL), u64(7n), key(OWNER), key(MINT), key(MINT)],
    data: { pool: POOL, poolId: "7", admin: OWNER, operator: MINT, acceptedMint: MINT },
  },
  {
    name: "OperatorChanged",
    fields: [key(POOL), key(OWNER), key(MINT)],
    data: { pool: POOL, previous: OWNER, operator: MINT },
  },
  {
    name: "AdminProposed",
    fields: [key(POOL), key(OWNER)],
    data: { pool: POOL, pendingAdmin: OWNER },
  },
  {
    name: "AdminChanged",
    fields: [key(POOL), key(OWNER), key(MINT)],
    data: { pool: POOL, previous: OWNER, admin: MINT },
  },
  {
    name: "ParamsSet",
    fields: [
      key(POOL),
      i64(86_400n),
      i64(1_789_315_200n),
      i64(120n),
      u64(1_000_000n),
      u64(2_000_000n),
      i64(86_400n),
      u16(488),
    ],
    data: {
      pool: POOL,
      epochSeconds: "86400",
      epochAnchor: "1789315200",
      vrfTimeout: "120",
      minDeposit: "1000000",
      minJackpot: "2000000",
      payoutTimeout: "86400",
      baseRateBps: 488,
    },
  },
  {
    name: "Paused",
    fields: [key(POOL), bool(true)],
    data: { pool: POOL, paused: true },
  },
  {
    name: "FeaturePaused",
    fields: [key(POOL), u8(1), bool(true), i64(1_700_000_000n)],
    data: { pool: POOL, feature: { jackpot: {} }, paused: true, at: "1700000000" },
  },
  {
    name: "Deposited",
    fields: [key(OWNER), u64(1_000_000n), u64(3_000_000n), u128(INDEX)],
    data: { owner: OWNER, amount: "1000000", principal: "3000000", yieldIndex: INDEX_STR },
  },
  {
    name: "WithdrawRequested",
    fields: [key(OWNER), u64(500_000n), u64(750_000n), u64(4n), u64(200_000n), u64(190_000n), u64(50_000n), u64(2_000_000n), u128(INDEX)],
    data: {
      owner: OWNER,
      amount: "500000",
      pending: "750000",
      pendingEpoch: "4",
      refunded: "200000",
      paid: "190000",
      redeemed: "50000",
      principal: "2000000",
      yieldIndex: INDEX_STR,
    },
  },
  {
    name: "WithdrawCancelled",
    fields: [key(OWNER), u64(750_000n), u64(4n), u64(2_750_000n), u128(INDEX)],
    data: { owner: OWNER, amount: "750000", pendingEpoch: "4", principal: "2750000", yieldIndex: INDEX_STR },
  },
  {
    name: "Withdrawn",
    fields: [key(OWNER), u64(500_000n), u64(2_500_000n), u128(INDEX)],
    data: { owner: OWNER, amount: "500000", principal: "2500000", yieldIndex: INDEX_STR },
  },
  {
    name: "EpochBegan",
    fields: [u64(3n), i64(1_700_000_000n), i64(1_700_086_400n), u128(INDEX)],
    data: { epochId: "3", startsAt: "1700000000", endsAt: "1700086400", yieldIndex: INDEX_STR },
  },
  {
    name: "JackpotFunded",
    fields: [key(OWNER), u64(10_000_000n)],
    data: { source: OWNER, amount: "10000000" },
  },
  {
    name: "EpochDrawn",
    fields: [u64(2n), u64(42n), u64(1n << 60n)],
    data: { epochId: "2", target: "42", totalTickets: "1152921504606846976" },
  },
  {
    name: "JackpotPaid",
    fields: [u64(2n), key(OWNER), u64(10_000_000n), bool(true), bool(false), u64(3_000_000n), u128(INDEX), u32(7), u64(4_000n)],
    data: {
      epochId: "2",
      winner: OWNER,
      amount: "10000000",
      isHouse: true,
      compounded: false,
      principal: "3000000",
      yieldIndex: INDEX_STR,
      index: 7,
      tickets: "4000",
    },
  },
  {
    name: "EpochRolledOver",
    fields: [u64(2n), u64(10_000_000n)],
    data: { epochId: "2", jackpotAmount: "10000000" },
  },
  {
    name: "TicketsBought",
    fields: [key(OWNER), u64(2n), u64(500_000n), u64(3_000_000n), u128(INDEX)],
    data: { owner: OWNER, epochId: "2", usdc: "500000", principal: "3000000", yieldIndex: INDEX_STR },
  },
  {
    name: "PoolShutdown",
    fields: [key(POOL), i64(1_700_000_000n)],
    data: { pool: POOL, at: "1700000000" },
  },
  {
    name: "EmergencyWithdrawn",
    fields: [key(OWNER), u64(3_000_000n), u64(500_000n), u64(3_500_000n), u64(0n), u128(INDEX)],
    data: { owner: OWNER, claim: "3000000", pending: "500000", total: "3500000", principal: "0", yieldIndex: INDEX_STR },
  },
  {
    name: "HouseSwept",
    fields: [u64(10_000_000n)],
    data: { jackpot: "10000000" },
  },
  // Live yield (yield-claimer tickets 05 to 11). A u128 past 2^64 in `Synced`
  // catches a yield index decoded as the wrong width.
  {
    name: "Synced",
    fields: [
      key(POOL),
      u64(1_000n),
      u64(100n),
      u64(700n),
      u64(150n),
      u128((1n << 70n) + 5n),
      u64(40_000_000n),
      u64(50n),
    ],
    data: {
      pool: POOL,
      gain: "1000",
      fee: "100",
      depositorShare: "700",
      prizeShare: "150",
      yieldIndex: "1180591620717411303429",
      venueValue: "40000000",
      deficitRepaid: "50",
    },
  },
  {
    name: "VenueDeployed",
    fields: [key(POOL), u64(40_000_000n), u64(40_000_100n)],
    data: { pool: POOL, amount: "40000000", venueValue: "40000100" },
  },
  {
    name: "VenueRecalled",
    fields: [key(POOL), u64(5_000_000n), u64(35_000_100n)],
    data: { pool: POOL, amount: "5000000", venueValue: "35000100" },
  },
  {
    name: "VenueDrained",
    fields: [key(POOL), u64(5_000_000n), u64(4_999_999n), u64(30_000_000n)],
    data: { pool: POOL, asked: "5000000", received: "4999999", venueValue: "30000000" },
  },
  {
    name: "VenueMigrated",
    fields: [
      key(POOL), Buffer.from([0]), key(OWNER), key(MINT), key(OWNER), key(MINT),
      Buffer.from([2]), key(MINT), key(OWNER), key(MINT), key(OWNER), u64(30_000_000n),
    ],
    data: {
      pool: POOL,
      oldVenueKind: 0,
      oldKlendProgram: OWNER,
      oldKlendMarket: MINT,
      oldKlendReserve: OWNER,
      oldKlendCtoken: MINT,
      newVenueKind: 2,
      newKlendProgram: MINT,
      newKlendMarket: OWNER,
      newKlendReserve: MINT,
      newKlendCtoken: OWNER,
      leftBehind: "30000000",
    },
  },
  {
    name: "VenueProposed",
    fields: [key(POOL), Buffer.from([2]), key(OWNER), key(MINT), key(OWNER), key(MINT), i64(1_800_000_000n), i64(1_800_172_800n)],
    data: {
      pool: POOL,
      venueKind: 2,
      klendProgram: OWNER,
      klendMarket: MINT,
      klendReserve: OWNER,
      klendCtoken: MINT,
      proposedAt: "1800000000",
      unlocksAt: "1800172800",
    },
  },
  {
    name: "VenueProposalCancelled",
    fields: [key(POOL), Buffer.from([0]), key(OWNER), key(MINT), key(OWNER), key(MINT), i64(1_800_000_000n)],
    data: {
      pool: POOL,
      venueKind: 0,
      klendProgram: OWNER,
      klendMarket: MINT,
      klendReserve: OWNER,
      klendCtoken: MINT,
      proposedAt: "1800000000",
    },
  },
  {
    name: "Harvested",
    fields: [key(POOL), u64(1_000n), u64(100n), u64(700n), u64(150n), u64(99n), u64(150n)],
    data: {
      pool: POOL,
      gain: "1000",
      fee: "100",
      depositorShare: "700",
      prizeShare: "150",
      feePaid: "99",
      prizePaid: "150",
    },
  },
  {
    name: "ImpairedSet",
    fields: [key(POOL), u64(900n), u64(300n), u64(100n), u64(500n)],
    data: { pool: POOL, loss: "900", prizeAbsorbed: "300", feeAbsorbed: "100", deficit: "500" },
  },
  {
    name: "ImpairedCleared",
    fields: [key(POOL), u64(500n), u8(1)],
    data: { pool: POOL, deficit: "500", cause: 1 },
  },
  {
    name: "DeficitCovered",
    fields: [key(POOL), key(OWNER), u64(200n), u64(300n)],
    data: { pool: POOL, payer: OWNER, amount: "200", deficit: "300" },
  },
  {
    name: "DeployPauseSet",
    fields: [key(POOL), bool(true)],
    data: { pool: POOL, paused: true },
  },
  {
    name: "BuyTicketsPauseSet",
    fields: [key(POOL), bool(true), i64(1_700_000_000n)],
    data: { pool: POOL, paused: true, at: "1700000000" },
  },
  {
    name: "TreasuryAccountsSet",
    fields: [key(POOL), key(OWNER), key(MINT)],
    data: { pool: POOL, treasury: OWNER, buybackReserve: MINT },
  },
  {
    name: "VenueParamsSet",
    fields: [key(POOL), u16(1_000), u16(500), u16(1_000), u16(500), u16(20_000), u64(100_000_000n), u16(1)],
    data: {
      pool: POOL,
      yieldFeeBps: 1_000,
      idleFloorBps: 500,
      idleTargetBps: 1_000,
      reserveShareCapBps: 500,
      reserveLiquidityFloorBps: 20_000,
      minVenueMove: "100000000",
      lossToleranceBps: 1,
    },
  },
];

describe("decodeEventLogs", () => {
  it.each(CASES)("decodes $name", ({ name, fields, data }) => {
    const decoded = decodeEventLogs(parser, logs(discriminatorOf(name), fields));
    expect(decoded).toEqual([{ name, data }]);
  });

  it("covers every event in the IDL", () => {
    expect(CASES.map((event) => event.name).sort()).toEqual(
      (idl.events ?? []).map((event) => event.name).sort(),
    );
  });

  it("indexes several events from one transaction in emission order", () => {
    const first = logs(discriminatorOf("Deposited"), [
      key(OWNER),
      u64(1n),
      u64(1n),
      u128(1n),
    ]);
    const second = logs(discriminatorOf("EpochBegan"), [u64(1n), i64(0n), i64(60n), u128(1n)]);
    // Splice the second event's data line into the first transaction's logs.
    const combined = [...first.slice(0, 3), second[2] as string, ...first.slice(3)];
    expect(decodeEventLogs(parser, combined).map((event) => event.name)).toEqual([
      "Deposited",
      "EpochBegan",
    ]);
  });

  it("ignores a log line that is not an event", () => {
    expect(
      decodeEventLogs(parser, [
        `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
        "Program log: nothing to see",
        `Program ${PROGRAM_ID.toBase58()} success`,
      ]),
    ).toEqual([]);
  });

  it("names the batch it could not parse", () => {
    expect(() => decodeEventLogs(parser, ["Program log: orphaned line"])).toThrow(
      /cannot parse program logs: Program log: orphaned line/,
    );
  });
});

describe("jsonify", () => {
  it("keeps a u64 exact as a decimal string", () => {
    const decoded = decodeEventLogs(
      parser,
      logs(discriminatorOf("Deposited"), [
        key(OWNER),
        u64(18_446_744_073_709_551_615n),
        u64(0n),
        u128(0n),
      ]),
    );
    expect(decoded[0]?.data).toMatchObject({ amount: "18446744073709551615" });
  });

  it("passes plain values through", () => {
    expect(jsonify({ a: [1, "b", true], c: null })).toEqual({ a: [1, "b", true], c: null });
  });
});

/** A decoded Pool as the Anchor coder hands it back, with the fields these
 *  tests do not care about at harmless values. */
function decodedPool(overrides: Partial<DecodedPool> = {}): DecodedPool {
  return {
    poolId: new BN(7),
    admin: new PublicKey(OWNER),
    operator: new PublicKey(MINT),
    house: new PublicKey(OWNER),
    pendingAdmin: PublicKey.default,
    acceptedMint: new PublicKey(MINT),
    pendingWithdrawals: new BN(0),
    minJackpot: new BN(0),
    epochSeconds: new BN(86_400),
    epochAnchor: new BN(0),
    minDeposit: new BN(0),
    paused: false,
    currentEpochId: new BN(3),
    currentEpochStart: new BN(0),
    currentEpochEndsAt: new BN(0),
    previousEpochEndsAt: new BN(0),
    totalPrincipal: new BN(0),
    baseRateBps: 488,
    version: 1,
    shutdown: false,
    gamePaused: false,
    jackpotPaused: false,
    klendProgram: new PublicKey(MINT),
    klendMarket: new PublicKey(MINT),
    klendReserve: new PublicKey(POOL),
    klendCtoken: new PublicKey(MINT),
    venueKind: 1,
    yieldIndex: new BN(0),
    venueValue: new BN(0),
    lastSyncAt: new BN(0),
    yieldOwed: new BN(0),
    feeOwed: new BN(0),
    prizeOwed: new BN(0),
    jackpotReserved: new BN(0),
    deficit: new BN(0),
    yieldFeeBps: 1_000,
    idleFloorBps: 500,
    idleTargetBps: 1_000,
    reserveShareCapBps: 500,
    reserveLiquidityFloorBps: 20_000,
    minVenueMove: new BN(100_000_000),
    lossToleranceBps: 1,
    deployPaused: false,
    impaired: false,
    buyTicketsPaused: false,
    ...overrides,
  };
}

describe("poolRow", () => {
  // The epoch grid timestamps take the same BN -> BigInt path as
  // `epochSeconds`, so a name that drifts from the IDL drops them silently.
  // The API's interceptor is what turns these columns into decimal strings.
  it("carries the epoch grid timestamps", () => {
    const pool = decodedPool({
      pendingWithdrawals: new BN(250_000),
      epochAnchor: new BN(1_789_315_200),
      currentEpochEndsAt: new BN(1_789_488_000),
      previousEpochEndsAt: new BN(1_789_401_600),
      totalPrincipal: new BN(3_000_000),
      minDeposit: new BN(1_000_000),
    });
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      epochSeconds: 86_400n,
      epochAnchor: 1_789_315_200n,
      currentEpochEndsAt: 1_789_488_000n,
      previousEpochEndsAt: 1_789_401_600n,
      // The browser reads this off the API now, so it has to survive the
      // decode rather than being dropped (ticket 07).
      minDeposit: 1_000_000n,
    });
  });

  // Ticket 05: the ceiling rate.
  it("carries the ceiling rate and drops what the program no longer holds", () => {
    const row = poolRow(new PublicKey(POOL), decodedPool(), 9n);
    expect(row).toMatchObject({ baseRateBps: 488 });
    for (const gone of ["roundSeconds", "closeBuffer", "houseCutBps", "ticketsPerUsdc", "bonusCapBps", "weightTree"]) {
      expect(row).not.toHaveProperty(gone);
    }
  });

  // Ticket 14: the venue and yield state. A yield index past 2^64 proves the
  // BN -> Decimal(40,0) string path, not a truncating Number one.
  it("carries the venue and yield state", () => {
    const pool = decodedPool({
      yieldIndex: new BN("1180591620717411303429"),
      venueValue: new BN(40_000_000),
      lastSyncAt: new BN(1_700_000_000),
      yieldOwed: new BN(11),
      feeOwed: new BN(12),
      prizeOwed: new BN(13),
      jackpotReserved: new BN(15),
      deficit: new BN(14),
      deployPaused: true,
      impaired: true,
      buyTicketsPaused: true,
    });
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      klendProgram: MINT,
      venueKind: 1,
      klendReserve: POOL,
      yieldIndex: "1180591620717411303429",
      venueValue: 40_000_000n,
      lastSyncAt: 1_700_000_000n,
      yieldOwed: 11n,
      feeOwed: 12n,
      prizeOwed: 13n,
      jackpotReserved: 15n,
      deficit: 14n,
      yieldFeeBps: 1_000,
      idleFloorBps: 500,
      idleTargetBps: 1_000,
      reserveShareCapBps: 500,
      reserveLiquidityFloorBps: 20_000,
      minVenueMove: 100_000_000n,
      lossToleranceBps: 1,
      deployPaused: true,
      impaired: true,
      buyTicketsPaused: true,
    });
  });

  // Ticket 03: the old single `authority` column is gone, and /status reads
  // what depositors are owed off this row.
  it("splits the roles and carries the withdrawal fields", () => {
    const pool = decodedPool({
      pendingAdmin: new PublicKey(POOL),
      pendingWithdrawals: new BN(250_000),
      minJackpot: new BN(1_000_000),
    });
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      admin: OWNER,
      operator: MINT,
      pendingAdmin: POOL,
      pendingWithdrawals: 250_000n,
      minJackpot: 1_000_000n,
    });
  });

  it("reports no pending admin when the handover slot is the default key", () => {
    expect(poolRow(new PublicKey(POOL), decodedPool(), 9n).pendingAdmin).toBeNull();
  });
});

describe("playerRow", () => {
  const decodedPlayer = (overrides: Partial<DecodedPlayer> = {}): DecodedPlayer => ({
    owner: new PublicKey(OWNER),
    principal: new BN(3_000_000),
    epochId: new BN(4),
    isHouse: false,
    pendingWithdraw: new BN(0),
    pendingEpoch: new BN(0),
    requestedAt: new BN(0),
    boughtEpoch: new BN(0),
    boughtAmount: new BN(0),
    yieldIndex: new BN(0),
    pendingDeposit: new BN(0),
    pendingDepositEpoch: new BN(0),
    ...overrides,
  });

  // Ticket 03: `request_withdraw` parks the amount on the Player and the
  // vault screen reads it back off /players/:owner, so a field dropped here
  // is a depositor who cannot see their own pending money.
  it("carries the pending withdrawal, the epoch it pays in and when it was requested", () => {
    const player = decodedPlayer({
      pendingWithdraw: new BN(750_000),
      pendingEpoch: new BN(4),
      requestedAt: new BN(1_700_000_000),
    });
    expect(playerRow(player, POOL, 0n)).toMatchObject({
      poolAddress: POOL,
      pendingWithdraw: 750_000n,
      pendingEpoch: 4n,
      requestedAt: 1_700_000_000n,
    });
  });

  // Ticket 05: the bought ticket counter. The Tickets column is not in the
  // row: the program no longer holds them, so the mirror leaves it alone.
  it("carries the bought ticket counter and leaves the Tickets column to the ledger", () => {
    const player = decodedPlayer({ boughtEpoch: new BN(4), boughtAmount: new BN(200_000) });
    const row = playerRow(player, POOL, 0n);
    expect(row).toMatchObject({ boughtEpoch: 4n, boughtAmount: 200_000n });
    for (const absent of ["tickets", "entries", "leafIndex", "bonusEpoch", "bonusGranted"]) {
      expect(row).not.toHaveProperty(absent);
    }
  });

  // Ticket 14: the index at the last settle. It is a u128, so one past 2^64
  // proves the string path.
  it("carries the yield index at the last settle", () => {
    const player = decodedPlayer({ yieldIndex: new BN("18446744073709551617") });
    expect(playerRow(player, POOL, 0n)).toMatchObject({ yieldIndex: "18446744073709551617" });
  });

  // Ticket 20: the Read model folds the pending deposit by its epoch.
  it("carries the pending deposit and the epoch it was made in", () => {
    const player = decodedPlayer({ pendingDeposit: new BN(2_000_000), pendingDepositEpoch: new BN(4) });
    expect(playerRow(player, POOL, 0n)).toMatchObject({
      pendingDeposit: 2_000_000n,
      pendingDepositEpoch: 4n,
    });
  });
});
