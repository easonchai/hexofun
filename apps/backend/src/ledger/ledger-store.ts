// Applies chain events to the Ticket ledger tables (off-chain-tickets 11).
// Every function takes the indexer's own transaction, so the ledger, the Event
// rows and the cursor commit or roll back together.
import type { Prisma, PrismaClient } from "@prisma/client";
import bs58 from "bs58";

import type { DecodedEvent } from "../indexer/decode";
import { buildSumTree } from "../snapshot/sum-tree";
import { bookEvent, eventString, walletOf } from "./ticket-ledger";

/** Rows per `createMany`: five binds each, far under Postgres' 32,767. */
const SNAPSHOT_CHUNK = 2_000;
/** The consistency check runs when the last one is this old. */
export const LEDGER_CHECK_INTERVAL_S = 24n * 60n * 60n;

/** First half of the lock key; the second is the pool address hash. */
const LEDGER_LOCK_KEY = 0x4c454447;
/**
 * `$transaction` options for every taker of the ledger lock. An `EpochBegan`
 * snapshots and resets every wallet under it, so a bet, close or grant queued
 * behind that must be allowed to wait it out rather than die at Prisma's 5 s
 * default.
 */
export const LEDGER_TRANSACTION = { timeout: 120_000 } as const;

/**
 * Serializes every writer of a pool's ledger (indexer, grants, bets) until the
 * caller's transaction ends. The indexer writes balances read earlier in the
 * same transaction, so without it a concurrent grant's increment is lost.
 * Pass `LEDGER_TRANSACTION` to the enclosing `$transaction`.
 */
export async function lockLedger(tx: Prisma.TransactionClient, poolAddress: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_KEY}::int, hashtext(${poolAddress}))`;
}

/**
 * Applies one transaction's events, in emission order. The caller has claimed
 * the batch (`Event.ledgered`), so this runs once per transaction, and the
 * finalized catch-up calls it in chain order.
 */
export async function bookBatch(
  tx: Prisma.TransactionClient,
  poolAddress: string,
  signature: string,
  events: readonly DecodedEvent[],
  blockTime: bigint,
): Promise<void> {
  await lockLedger(tx, poolAddress);
  const cursor = await tx.cursor.findUnique({ where: { poolAddress }, select: { ledgerEpochId: true } });
  const reached = cursor?.ledgerEpochId ?? 0n;
  let epochId = reached;
  for (const [index, event] of events.entries()) {
    const ref = `${signature}:${index}`;
    if (event.name === "EpochBegan") {
      const began = BigInt(eventString(event, "epochId"));
      // A skipped EpochBegan means no snapshot and no reset. Throwing stops the catch-up on
      // this signature so INDEXER_STALE pages; a ledger that has reached no epoch takes any id.
      if (epochId !== 0n && began !== epochId + 1n) {
        throw new Error(`EpochBegan ${began} in ${signature} does not follow the ledger's epoch ${epochId}`);
      }
      epochId = began;
      await takeSnapshot(tx, poolAddress, epochId - 1n);
      await resetTickets(tx, poolAddress, epochId, eventString(event, "yieldIndex"), ref);
      continue;
    }
    const owner = walletOf(event);
    if (owner === null) continue;
    const where = { poolAddress_owner: { poolAddress, owner } };
    const row = await tx.ticketBalance.findUnique({ where });
    const booking = bookEvent(
      row === null ? undefined : { tickets: row.tickets, principal: row.principal, yieldIndex: BigInt(row.yieldIndex.toFixed()) },
      event,
      event.name === "TicketsBought" ? await ticketsPerUsdcAt(tx, poolAddress, blockTime) : undefined,
    );
    if (booking === null) continue;
    const state = { tickets: booking.next.tickets, principal: booking.next.principal, yieldIndex: booking.next.yieldIndex.toString(), epochId };
    await tx.ticketBalance.upsert({ where, create: { poolAddress, owner, ...state }, update: state });
    if (booking.row !== null) {
      await tx.ticketLedger.create({ data: { poolAddress, owner, epochId, ref, ...booking.row } });
    }
  }
  if (epochId !== reached) {
    await tx.cursor.upsert({
      where: { poolAddress },
      create: { poolAddress, ledgerEpochId: epochId },
      update: { ledgerEpochId: epochId },
    });
  }
}

/**
 * `ticketsPerUsdc` of the Game config row in force at `blockTime`: the newest
 * row created at or before it. Rows only append, so a later change never
 * reprices a buy already booked. An event older than the first row (a fresh
 * database catching up on history) takes the first row.
 */
async function ticketsPerUsdcAt(tx: Prisma.TransactionClient, poolAddress: string, blockTime: bigint): Promise<number> {
  const select = { ticketsPerUsdc: true };
  const row =
    (await tx.gameConfig.findFirst({
      where: { poolAddress, createdAt: { lte: new Date(Number(blockTime) * 1000) } },
      orderBy: { id: "desc" },
      select,
    })) ?? (await tx.gameConfig.findFirst({ where: { poolAddress }, orderBy: { id: "asc" }, select }));
  // Thrown inside the indexer's transaction, so the batch rolls back and the next tick retries.
  if (row === null) throw new Error(`no Game config row for ${poolAddress}, so a TicketsBought cannot be priced`);
  return row.ticketsPerUsdc;
}

/**
 * The ended epoch's snapshot, from every balance as it stands now: one
 * `EpochSnapshot` row per wallet above zero Tickets, sorted by wallet bytes,
 * and the sum tree's four outputs on the Epoch row. No epoch ended before epoch 1.
 */
async function takeSnapshot(tx: Prisma.TransactionClient, poolAddress: string, endedEpochId: bigint): Promise<void> {
  if (endedEpochId < 1n) return;
  const held = await tx.ticketBalance.findMany({
    where: { poolAddress, tickets: { gt: 0n } },
    select: { owner: true, tickets: true },
  });
  const leaves = held
    .map(({ owner, tickets }) => ({ owner, tickets, wallet: Buffer.from(bs58.decode(owner)) }))
    .sort((a, b) => Buffer.compare(a.wallet, b.wallet));
  for (let start = 0; start < leaves.length; start += SNAPSHOT_CHUNK) {
    await tx.epochSnapshot.createMany({
      data: leaves
        .slice(start, start + SNAPSHOT_CHUNK)
        .map(({ owner, tickets }, i) => ({ poolAddress, epochId: endedEpochId, index: start + i, owner, tickets })),
    });
  }
  // An empty snapshot has no tree; the draw rolls over on a zero total.
  const tree = leaves.length === 0 ? null : buildSumTree(leaves);
  const updated = await tx.epoch.updateMany({
    where: { poolAddress, id: endedEpochId },
    data: {
      snapshotRoot: tree === null ? null : tree.root.toString("hex"),
      snapshotDepth: tree?.depth ?? 0,
      leafCount: tree?.leafCount ?? 0,
      totalTickets: tree?.total ?? 0n,
    },
  });
  // The account sync mirrors every Epoch before the event catch-up runs. Failing
  // here rolls the batch back, so the next tick retries after a fresh sync.
  if (updated.count === 0) throw new Error(`epoch ${endedEpochId} is not mirrored yet, so its snapshot cannot be stored`);
}

/**
 * The cutoff reset: every wallet's Tickets become its Ticket basis, Principal
 * plus unsettled yield by the program's settle formula at the pool index the
 * event carries. A settle later raises Principal by exactly the unsettled part,
 * so the basis does not move. The House holds no Principal and so resets to zero.
 * One statement, so a 200,000-wallet reset is not 200,000 round trips; a wallet
 * whose Tickets do not change gets no ledger row.
 */
async function resetTickets(
  tx: Prisma.TransactionClient,
  poolAddress: string,
  epochId: bigint,
  poolIndex: string,
  ref: string,
): Promise<void> {
  await tx.$executeRaw`
    WITH basis AS (
      SELECT "owner", "tickets",
        GREATEST(0, "principal" + FLOOR("principal"::numeric * (${poolIndex}::numeric - "yieldIndex") / 1000000000000000000))::bigint AS "next"
      FROM "TicketBalance" WHERE "poolAddress" = ${poolAddress}
    ), booked AS (
      INSERT INTO "TicketLedger" ("poolAddress", "owner", "epochId", "delta", "reason", "ref")
      SELECT ${poolAddress}::text, "owner", ${epochId}::bigint, "next" - "tickets", 'reset'::"TicketReason", ${ref}::text
      FROM basis WHERE "next" <> "tickets"
    )
    UPDATE "TicketBalance" b
    SET "tickets" = basis."next", "epochId" = ${epochId}::bigint, "updatedAt" = now()
    FROM basis
    WHERE b."poolAddress" = ${poolAddress} AND b."owner" = basis."owner"`;
}

/** Wallets whose balance row differs from the sum of their ledger deltas. */
export async function countLedgerMismatches(prisma: PrismaClient, poolAddress: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
    FROM (SELECT "owner", "tickets" FROM "TicketBalance" WHERE "poolAddress" = ${poolAddress}) b
    FULL JOIN (
      SELECT "owner", SUM("delta") AS "sum" FROM "TicketLedger" WHERE "poolAddress" = ${poolAddress} GROUP BY "owner"
    ) l ON l."owner" = b."owner"
    WHERE COALESCE(b."tickets", 0) <> COALESCE(l."sum", 0)`;
  return Number(row?.count ?? 0n);
}

/** Runs the check when the stored one is a day old and records the result for `/alerts`. */
export async function checkLedgerIfDue(prisma: PrismaClient, poolAddress: string, now: bigint): Promise<void> {
  const last = await prisma.ledgerCheck.findUnique({ where: { poolAddress } });
  if (last !== null && now - last.checkedAt < LEDGER_CHECK_INTERVAL_S) return;
  const mismatches = await countLedgerMismatches(prisma, poolAddress);
  await prisma.ledgerCheck.upsert({
    where: { poolAddress },
    create: { poolAddress, checkedAt: now, mismatches },
    update: { checkedAt: now, mismatches },
  });
}
