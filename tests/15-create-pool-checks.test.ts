// audit-fixes ticket 03: create_pool validates the cToken pin and the
// payout timeout.
//
// The fixture's stub venue is exempt from the cToken check (its vault does not
// exist until test_venue_init), so these tests pin a venue whose
// klend_program is some other key, the way a real klend pool is pinned.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DEFAULT_PARAMS,
  DEVNET_VRF_NETWORK_STATE,
  airdrop,
  connection,
  jackpotVaultPda,
  nextPoolId,
  onChainNowSeconds,
  playerPda,
  poolPda,
  principalVaultPda,
  program,
  PROGRAM_DATA,
  provider,
  VENUE_KIND,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;
const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

async function createPoolWith(opts: {
  ctokenOwner?: "pool" | "other";
  payoutTimeout?: number;
  venueKind?: number;
  epochSeconds?: number;
  klendProgram?: PublicKey;
  /** Pay with a key that is not the upgrade authority. */
  payer?: Keypair;
}) {
  const poolId = nextPoolId();
  const pool = poolPda(poolId);
  const operator = Keypair.generate();
  const admin = Keypair.generate();
  await airdrop(operator.publicKey, 10);
  const mint = await createMint(connection, operator, operator.publicKey, null, 6);
  const plain = () => createAccount(connection, operator, mint, operator.publicKey, Keypair.generate());
  const treasury = await plain();
  const buybackReserve = await plain();

  let klendCtoken;
  if (opts.ctokenOwner === "other") {
    klendCtoken = await plain();
  } else {
    klendCtoken = getAssociatedTokenAddressSync(mint, pool, true);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(operator.publicKey, klendCtoken, pool, mint),
      ),
      [operator],
    );
  }

  const p = { ...DEFAULT_PARAMS, payoutTimeout: opts.payoutTimeout ?? DEFAULT_PARAMS.payoutTimeout };
  return program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(opts.epochSeconds ?? p.epochSeconds),
      epochAnchor: new BN(await onChainNowSeconds()),
      vrfTimeout: new BN(p.vrfTimeout),
      minDeposit: new BN(p.minDeposit),
      minJackpot: new BN(p.minJackpot),
      payoutTimeout: new BN(p.payoutTimeout),
      baseRateBps: p.baseRateBps,
      venueKind: opts.venueKind ?? VENUE_KIND.klend,
    })
    .accountsPartial({
      payer: opts.payer?.publicKey ?? provider.wallet.publicKey,
      programData: PROGRAM_DATA,
      pool,
      acceptedMint: mint,
      principalVault: principalVaultPda(pool),
      jackpotVault: jackpotVaultPda(pool),
      house: playerPda(pool, operator.publicKey),
      treasury,
      buybackReserve,
      klendProgram:
        opts.klendProgram ??
        (opts.venueKind === undefined || opts.venueKind === VENUE_KIND.klend
          ? KLEND_PROGRAM
          : Keypair.generate().publicKey),
      klendMarket: Keypair.generate().publicKey,
      klendReserve: Keypair.generate().publicKey,
      klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(opts.payer ? [opts.payer] : [])
    .rpc();
}

describe("create_pool checks", () => {
  it("refuses a payer that is not the program's upgrade authority", async () => {
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 10);
    await expect(createPoolWith({ payer: stranger })).rejects.toThrow(/NotUpgradeAuthority/);
  }, TIMEOUT);

  it("refuses a klend pool pinned to any program but klend", async () => {
    await expect(createPoolWith({ klendProgram: Keypair.generate().publicKey })).rejects.toThrow(
      /KlendProgramMismatch/,
    );
  }, TIMEOUT);

  it("refuses an epoch_seconds above seven days", async () => {
    await expect(createPoolWith({ epochSeconds: 7 * 86_400 + 1 })).rejects.toThrow(
      /InvalidParameter/,
    );
  }, TIMEOUT);

  it("refuses a cToken account owned by another key", async () => {
    await expect(createPoolWith({ ctokenOwner: "other" })).rejects.toThrow(/InvalidParameter/);
  }, TIMEOUT);

  it("refuses payout_timeout equal to epoch_seconds", async () => {
    await expect(
      createPoolWith({ payoutTimeout: DEFAULT_PARAMS.epochSeconds }),
    ).rejects.toThrow(/InvalidParameter/);
  }, TIMEOUT);

  it("refuses a venue kind the build does not support, by name", async () => {
    await expect(createPoolWith({ venueKind: VENUE_KIND.unsupported })).rejects.toThrow(
      /UnsupportedVenueKind/,
    );
    await expect(createPoolWith({ venueKind: 255 })).rejects.toThrow(/UnsupportedVenueKind/);
  }, TIMEOUT);

  it("takes the kVault kind on every build, and checks its pins against a vault state", async () => {
    // Localnet has no kVault program: random keys are not a vault, and the
    // program pin is the first thing refused, by name. The pins' own checks
    // run against the real vault in tests/fork/kvault.pool.fork.ts.
    await expect(createPoolWith({ venueKind: VENUE_KIND.kvault })).rejects.toThrow(/VaultPinMismatch/);
  }, TIMEOUT);

  it("skips the cToken ownership check for the stub kind only", async () => {
    await createPoolWith({ ctokenOwner: "other", venueKind: VENUE_KIND.stub });
  }, TIMEOUT);

  it("accepts the pool's own associated token account", async () => {
    await createPoolWith({});
  }, TIMEOUT);
});
