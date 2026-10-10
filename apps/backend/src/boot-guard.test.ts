// ticket 10: boot-guard tests with a stubbed connection for each mismatch.
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  assertAcceptedMintMatchesPool,
  assertClusterMatchesGenesis,
  assertPoolMatchesExpected,
  assertPoolRowsBelongToProgram,
  CLUSTER_GENESIS_HASHES,
  diffPoolPins,
  expectedPinsFromEnv,
  type PoolPinsView,
  runBootGuards,
  type BootGuardDeps,
} from "./boot-guard";
import { poolAddress } from "./chain/pda";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL_ADDRESS = poolAddress(PROGRAM_ID, 2n);
const ACTIVE = { address: POOL_ADDRESS.toBase58(), poolId: 2n };
const RETIRED = { address: poolAddress(PROGRAM_ID, 1n).toBase58(), poolId: 1n };
const MINT = Keypair.generate().publicKey;
const key = (): PublicKey => Keypair.generate().publicKey;
const CHAIN_POOL: PoolPinsView = {
  admin: key(),
  treasury: key(),
  buybackReserve: key(),
  acceptedMint: MINT,
  venueKind: 0,
  klendProgram: key(),
  klendMarket: key(),
  klendReserve: key(),
  klendCtoken: key(),
};

function deps(overrides: Partial<BootGuardDeps> = {}): BootGuardDeps {
  return {
    connection: {
      getGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet,
      getAccountInfo: async () => ({
        data: Buffer.alloc(0),
      }),
    },
    program: {
      coder: {
        accounts: {
          decode: () => CHAIN_POOL,
        },
      },
    },
    programId: PROGRAM_ID,
    poolAddress: POOL_ADDRESS,
    acceptedMint: MINT.toBase58(),
    cluster: "devnet",
    env: {},
    mirroredPoolRows: async () => [ACTIVE],
    ...overrides,
  };
}

describe("assertClusterMatchesGenesis", () => {
  it("passes when CLUSTER's genesis hash matches the RPC's", () => {
    expect(() =>
      assertClusterMatchesGenesis("devnet", CLUSTER_GENESIS_HASHES.devnet),
    ).not.toThrow();
  });

  it("throws when the RPC's genesis hash is a different cluster's", () => {
    expect(() =>
      assertClusterMatchesGenesis("devnet", CLUSTER_GENESIS_HASHES["mainnet-beta"]),
    ).toThrow(/CLUSTER=devnet/);
  });
});

describe("assertAcceptedMintMatchesPool", () => {
  it("passes when ACCEPTED_MINT matches the Pool's mint", () => {
    expect(() => assertAcceptedMintMatchesPool(MINT.toBase58(), MINT.toBase58())).not.toThrow();
  });

  it("throws when ACCEPTED_MINT does not match the Pool's mint", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => assertAcceptedMintMatchesPool(MINT.toBase58(), other)).toThrow(/ACCEPTED_MINT/);
  });
});

describe("assertPoolRowsBelongToProgram", () => {
  it("passes with a retired pool beside the Active one on the same program", () => {
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [RETIRED, ACTIVE])).not.toThrow();
  });

  it("passes with no mirrored rows yet (a fresh database)", () => {
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [])).not.toThrow();
  });

  it("throws, naming the row, when an address is not its poolId's PDA under PROGRAM_ID", () => {
    const otherProgram = Keypair.generate().publicKey;
    const foreign = { address: poolAddress(otherProgram, 1n).toBase58(), poolId: 1n };
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [ACTIVE, foreign])).toThrow(
      new RegExp(`${foreign.address}.*wrong DATABASE_URL or PROGRAM_ID`),
    );
  });
});

describe("runBootGuards", () => {
  it("passes when cluster, mint and every mirrored row all agree", async () => {
    await expect(runBootGuards(deps())).resolves.toBeUndefined();
  });

  it("throws on a cluster/genesis mismatch before checking anything else", async () => {
    await expect(
      runBootGuards(
        deps({
          connection: {
            getGenesisHash: async () => CLUSTER_GENESIS_HASHES["mainnet-beta"],
            getAccountInfo: async () => {
              throw new Error("must not be called: the cluster check should fail first");
            },
          },
        }),
      ),
    ).rejects.toThrow(/CLUSTER=devnet/);
  });

  it("throws when the fallback RPC is on another cluster, and passes with none or a matching one", async () => {
    await expect(
      runBootGuards(deps({ fallbackGenesisHash: async () => CLUSTER_GENESIS_HASHES["mainnet-beta"] })),
    ).rejects.toThrow(/RPC_FALLBACK_URL's genesis hash/);
    await expect(
      runBootGuards(deps({ fallbackGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet })),
    ).resolves.toBeUndefined();
    await expect(runBootGuards(deps())).resolves.toBeUndefined();
  });

  it("fails the boot, without the url, when the fallback RPC cannot answer", async () => {
    await expect(
      runBootGuards(
        deps({
          fallbackGenesisHash: async () => {
            throw new Error("fetch failed https://rpc.example/?api-key=secret");
          },
        }),
      ),
    ).rejects.toThrow(/^RPC_FALLBACK_URL did not answer getGenesisHash/);
  });

  it("throws on a mint mismatch when the Pool already exists on chain", async () => {
    await expect(
      runBootGuards(deps({ acceptedMint: Keypair.generate().publicKey.toBase58() })),
    ).rejects.toThrow(/ACCEPTED_MINT/);
  });

  it("skips the mint check when the Pool does not exist yet (bootstrap has not run)", async () => {
    await expect(
      runBootGuards(
        deps({
          connection: {
            getGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet,
            getAccountInfo: async () => null,
          },
          acceptedMint: Keypair.generate().publicKey.toBase58(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws when Postgres mirrors a Pool row from another program", async () => {
    await expect(
      runBootGuards(
        deps({
          mirroredPoolRows: async () => [
            { address: Keypair.generate().publicKey.toBase58(), poolId: 2n },
          ],
        }),
      ),
    ).rejects.toThrow(/wrong DATABASE_URL or PROGRAM_ID/);
  });
});

describe("diffPoolPins", () => {
  it("is empty when nothing is expected, or everything agrees", () => {
    expect(diffPoolPins(CHAIN_POOL, {})).toEqual([]);
    expect(
      diffPoolPins(CHAIN_POOL, {
        admin: CHAIN_POOL.admin,
        treasury: CHAIN_POOL.treasury,
        buybackReserve: CHAIN_POOL.buybackReserve,
        acceptedMint: MINT,
        venue: {
          kind: 0,
          klendProgram: CHAIN_POOL.klendProgram,
          klendMarket: CHAIN_POOL.klendMarket,
          klendReserve: CHAIN_POOL.klendReserve,
          klendCtoken: CHAIN_POOL.klendCtoken,
        },
      }),
    ).toEqual([]);
  });

  it("lists every field that differs, with both values", () => {
    const stranger = key();
    const lines = diffPoolPins(CHAIN_POOL, {
      admin: stranger,
      treasury: stranger,
      venue: {
        kind: 2,
        klendProgram: CHAIN_POOL.klendProgram,
        klendMarket: stranger,
        klendReserve: CHAIN_POOL.klendReserve,
        klendCtoken: CHAIN_POOL.klendCtoken,
      },
    });
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain(`admin: on chain ${CHAIN_POOL.admin.toBase58()}, expected ${stranger.toBase58()}`);
    expect(lines.join("\n")).toContain("venue kind: on chain 0, expected 2");
    expect(lines.join("\n")).toContain("venue market");
  });
});

describe("expectedPinsFromEnv", () => {
  const mainnetHash = CLUSTER_GENESIS_HASHES["mainnet-beta"];

  it("reads what is set and leaves the rest unchecked off mainnet", () => {
    const admin = key();
    const pins = expectedPinsFromEnv(
      { ADMIN_ADDRESS: admin.toBase58() },
      CLUSTER_GENESIS_HASHES.devnet,
      "devnet",
      POOL_ADDRESS,
      PROGRAM_ID,
    );
    expect(pins.admin?.equals(admin)).toBe(true);
    expect(pins.treasury).toBeUndefined();
    expect(pins.venue).toBeUndefined();
  });

  it("requires admin, treasury and buyback reserve on mainnet-beta", () => {
    expect(() =>
      expectedPinsFromEnv({}, mainnetHash, "mainnet-beta", POOL_ADDRESS, PROGRAM_ID),
    ).toThrow(/ADMIN_ADDRESS, TREASURY, BUYBACK_RESERVE must be set on mainnet-beta/);
  });

  it("falls back to Kamino's reserve as the venue on mainnet-beta", () => {
    const pins = expectedPinsFromEnv(
      { ADMIN_ADDRESS: key().toBase58(), TREASURY: key().toBase58(), BUYBACK_RESERVE: key().toBase58() },
      mainnetHash,
      "mainnet-beta",
      POOL_ADDRESS,
      PROGRAM_ID,
    );
    expect(pins.venue?.kind).toBe(0);
  });
});

describe("assertPoolMatchesExpected", () => {
  it("refuses a pool with a different admin and prints the diff (bootstrap's re-run check)", () => {
    const mine = key();
    expect(() =>
      assertPoolMatchesExpected(POOL_ADDRESS, CHAIN_POOL, { admin: mine }, "the flags and env"),
    ).toThrow(
      new RegExp(`does not match the flags and env.*admin: on chain ${CHAIN_POOL.admin.toBase58()}, expected ${mine.toBase58()}`, "s"),
    );
  });
});

describe("runBootGuards pins", () => {
  it("refuses a pool whose treasury differs from TREASURY", async () => {
    await expect(
      runBootGuards(deps({ env: { TREASURY: key().toBase58() } })),
    ).rejects.toThrow(/treasury: on chain/);
  });

  it("passes when the env's admin, treasury and buyback reserve are the pool's", async () => {
    await expect(
      runBootGuards(
        deps({
          env: {
            ADMIN_ADDRESS: CHAIN_POOL.admin.toBase58(),
            TREASURY: CHAIN_POOL.treasury.toBase58(),
            BUYBACK_RESERVE: CHAIN_POOL.buybackReserve.toBase58(),
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not check pins while the pool is not created yet", async () => {
    await expect(
      runBootGuards(
        deps({
          env: { TREASURY: key().toBase58() },
          connection: {
            getGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet,
            getAccountInfo: async () => null,
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
