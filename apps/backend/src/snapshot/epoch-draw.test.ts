// The Epoch snapshot rows as the draw reads them, against a real Postgres: the
// commitment `request_draw` sends, the nonce it is requested with, and the
// winner's proof `payout` sends. Own pool address, own rows, removed after.
const TEST_DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensurePoolRow } from "../operator/pool-row.fixture";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { claimNonce, readCommitment, winnerProof } from "./epoch-draw";
import { buildSumTree, verifyPayout } from "./sum-tree";

const POOL = Keypair.generate().publicKey.toBase58();
const EPOCH = 4n;
const owners = Array.from({ length: 5 }, () => Keypair.generate().publicKey).sort((a, b) =>
  Buffer.compare(a.toBuffer(), b.toBuffer()),
);
const tree = buildSumTree(owners.map((owner, i) => ({ wallet: owner.toBuffer(), tickets: BigInt(10 * (i + 1)) })));
const epochKey = { poolAddress_id: { poolAddress: POOL, id: EPOCH } };

describe.skipIf(!isDatabaseReachableSync(TEST_DATABASE_URL))("Epoch snapshot draw reads", () => {
  const prisma = new PrismaService();

  const seedEpoch = async (snapshot: boolean) => {
    await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL } });
    await prisma.epoch.deleteMany({ where: { poolAddress: POOL } });
    await prisma.epoch.create({
      data: {
        poolAddress: POOL,
        id: EPOCH,
        startsAt: 0n,
        endsAt: 1n,
        status: 1,
        jackpotAmount: 0n,
        target: "0",
        ...(snapshot
          ? {
              snapshotRoot: tree.root.toString("hex"),
              snapshotDepth: tree.depth,
              leafCount: tree.leafCount,
              totalTickets: tree.total,
            }
          : {}),
      },
    });
    if (snapshot) {
      await prisma.epochSnapshot.createMany({
        data: owners.map((owner, index) => ({
          poolAddress: POOL,
          epochId: EPOCH,
          index,
          owner: owner.toBase58(),
          tickets: BigInt(10 * (index + 1)),
        })),
      });
    }
  };

  beforeAll(async () => {
    await prisma.$connect();
    await ensurePoolRow(prisma, POOL, 1n);
  });

  afterAll(async () => {
    await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL } });
    await prisma.epoch.deleteMany({ where: { poolAddress: POOL } });
    await prisma.$disconnect();
  });

  it("has no commitment until the ledger took the snapshot", async () => {
    await seedEpoch(false);
    expect(await readCommitment(prisma, POOL, EPOCH)).toBeNull();
    expect(await readCommitment(prisma, POOL, 99n)).toBeNull();
  });

  it("reads the four fields the snapshot committed, and zeros for an empty one", async () => {
    await seedEpoch(true);
    expect(await readCommitment(prisma, POOL, EPOCH)).toEqual({
      root: tree.root,
      depth: tree.depth,
      leafCount: 5,
      total: 150n,
    });
    await prisma.epoch.update({
      where: epochKey,
      data: { snapshotRoot: null, snapshotDepth: 0, leafCount: 0, totalTickets: 0n },
    });
    expect(await readCommitment(prisma, POOL, EPOCH)).toEqual({
      root: Buffer.alloc(32),
      depth: 0,
      leafCount: 0,
      total: 0n,
    });
  });

  it("picks one nonce per epoch and hands the same one to every retry", async () => {
    await seedEpoch(true);
    const [a, b] = await Promise.all([claimNonce(prisma, POOL, EPOCH), claimNonce(prisma, POOL, EPOCH)]);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect((await claimNonce(prisma, POOL, EPOCH)).equals(a)).toBe(true);
    expect((await prisma.epoch.findUniqueOrThrow({ where: epochKey })).nonce).toBe(a.toString("hex"));
  });

  it("builds a proof for the leaf holding each target, at both range edges", async () => {
    await seedEpoch(true);
    // Ranges: [0,10) [10,30) [30,60) [60,100) [100,150).
    for (const [target, index] of [[0n, 0], [9n, 0], [10n, 1], [29n, 1], [30n, 2], [99n, 3], [100n, 4], [149n, 4]] as const) {
      const proof = await winnerProof(prisma, POOL, EPOCH, target);
      expect(proof?.index).toBe(index);
      expect(proof?.owner).toBe(owners[index]?.toBase58());
      expect(proof?.siblings).toHaveLength(tree.depth);
      expect(
        verifyPayout(tree, target, index, (owners[index] as (typeof owners)[0]).toBuffer(), proof?.tickets ?? 0n, proof?.siblings ?? []),
      ).toBe(true);
    }
  });

  it("builds nothing the chain would refuse: missing rows, a different root, a target past the total", async () => {
    await seedEpoch(true);
    expect(await winnerProof(prisma, POOL, EPOCH, 150n)).toBeNull();

    await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL, index: 4 } });
    expect(await winnerProof(prisma, POOL, EPOCH, 5n)).toBeNull();

    await seedEpoch(true);
    await prisma.epochSnapshot.updateMany({ where: { poolAddress: POOL, index: 1 }, data: { tickets: 21n } });
    expect(await winnerProof(prisma, POOL, EPOCH, 5n)).toBeNull();

    await seedEpoch(true);
    await prisma.epoch.update({ where: epochKey, data: { snapshotRoot: null } });
    expect(await winnerProof(prisma, POOL, EPOCH, 5n)).toBeNull();
  });
});
