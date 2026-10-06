// audit-fixes ticket 03: create_pool validates the cToken pin and the
// payout timeout.
//
// The fixture's stub venue is exempt from the cToken check (its vault does not
// exist until test_venue_init), so these tests pin a venue whose
// klend_program is some other key, the way a real klend pool is pinned.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
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
  weightTreeAccount,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;

async function createPoolWith(opts: { ctokenOwner?: "pool" | "other"; payoutTimeout?: number }) {
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

  const weightTree = await weightTreeAccount(operator.publicKey);
  const p = { ...DEFAULT_PARAMS, payoutTimeout: opts.payoutTimeout ?? DEFAULT_PARAMS.payoutTimeout };
  return program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(p.epochSeconds),
      epochAnchor: new BN(await onChainNowSeconds()),
      roundSeconds: new BN(p.roundSeconds),
      closeBuffer: new BN(p.closeBuffer),
      vrfTimeout: new BN(p.vrfTimeout),
      minDeposit: new BN(p.minDeposit),
      houseCutBps: p.houseCutBps,
      minJackpot: new BN(p.minJackpot),
      payoutTimeout: new BN(p.payoutTimeout),
      baseRateBps: p.baseRateBps,
      ticketsPerUsdc: p.ticketsPerUsdc,
      bonusCapBps: p.bonusCapBps,
    })
    .accountsPartial({
      payer: operator.publicKey,
      pool,
      acceptedMint: mint,
      principalVault: principalVaultPda(pool),
      jackpotVault: jackpotVaultPda(pool),
      house: playerPda(pool, operator.publicKey),
      weightTree: weightTree.keypair.publicKey,
      treasury,
      buybackReserve,
      klendProgram: Keypair.generate().publicKey,
      klendMarket: Keypair.generate().publicKey,
      klendReserve: Keypair.generate().publicKey,
      klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([weightTree.ix])
    .signers([operator, weightTree.keypair])
    .rpc();
}

describe("create_pool checks", () => {
  it("refuses a cToken account owned by another key", async () => {
    await expect(createPoolWith({ ctokenOwner: "other" })).rejects.toThrow(/InvalidParameter/);
  }, TIMEOUT);

  it("refuses payout_timeout equal to epoch_seconds", async () => {
    await expect(
      createPoolWith({ payoutTimeout: DEFAULT_PARAMS.epochSeconds }),
    ).rejects.toThrow(/InvalidParameter/);
  }, TIMEOUT);

  it("accepts the pool's own associated token account", async () => {
    await createPoolWith({});
  }, TIMEOUT);
});
