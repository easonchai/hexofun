// One-off admin CLI: set-params, pause, unpause, pause-game, pause-jackpot,
// start-game, start-jackpot, pause-deploy, start-deploy, pause-buy-tickets,
// start-buy-tickets, set-venue-params, set-treasury-accounts, cover-deficit,
// fund-jackpot, grant-tickets, set-operator,
// propose-admin, accept-admin, propose-venue, cancel-venue, drain-venue, create-invite, shutdown, emergency-crank,
// sweep-house, void-round, rollover-epoch. Same shape as ../bootstrap.ts (plain tsx script, no command
// framework, argument parsing split into its own file for a chain-free unit
// test) but this pool already exists, so unlike bootstrap this reuses
// ChainService and the same full .env the backend itself runs on, instead of
// re-deriving connections and PDAs by hand.
//
// In local mode stdout carries nothing; every line (including the tx
// signature) goes to stderr, matching bootstrap.ts's stdout/stderr split. In
// multisig mode stdout carries exactly one line, the base58 transaction, so
// `admin ... | pbcopy` hands Squads something it can import. create-invite
// touches no chain at all, so it never reaches `run()`; its own lines
// (each code, one per line) go to stdout instead, for the same reason:
// `admin create-invite ... | pbcopy` or a script should get codes and
// nothing else.
import "reflect-metadata"; // ChainService's @Injectable()/@Inject() decorators need this; NestFactory normally pulls it in, but there is no Nest app here.
import { existsSync } from "node:fs";

import { BN } from "@anchor-lang/core";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { generateInviteCode } from "../api/invite-code";
import { ChainService } from "../chain/chain.service";
import { venueProposalAddress } from "../chain/pda";
import { rpcStatus, withRpcFallback } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { validateEnv } from "../config/env";
import {
  decodeEpoch,
  decodePool,
  decodeRound,
  type PoolState,
} from "../operator/chain-state";
import { OperatorInstructions } from "../operator/instructions";
import { randomnessAddress } from "../operator/vrf";
import {
  parseAdminCommand,
  type AdminCommand,
  type SetParamsInput,
  type SetVenueParamsInput,
} from "./args";
import {
  checkLedgerAddress,
  ledgerSigner,
  parseAdminKeypair,
  type AdminSigner,
} from "./ledger";
import { adminMode, encodeForSquads, type AdminMode } from "./squads";

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * `Program<Idl>`'s methods namespace is a plain index signature (no codegen
 * for a generic Idl), so a stale IDL turns into a clear error here instead of
 * "cannot invoke undefined" at the call site. Same shape as
 * OperatorInstructions.method in ../operator/instructions.ts; not shared with
 * it because that class is built around round/epoch progression, not the
 * three plain calls this file makes.
 */
interface MethodBuilder {
  accountsPartial(accounts: Record<string, PublicKey | null>): {
    instruction(): Promise<TransactionInstruction>;
  };
}
type MethodFactory = (...args: unknown[]) => MethodBuilder;

function method(chain: ChainService, name: string, ...args: unknown[]): MethodBuilder {
  const factory = (chain.program.methods as Record<string, MethodFactory | undefined>)[
    name
  ];
  if (!factory) {
    throw new Error(
      `instruction ${name} is missing from the IDL; run \`pnpm --filter @hexvault/backend sync-idl\``,
    );
  }
  return factory(...args);
}

async function readPool(chain: ChainService): Promise<PoolState> {
  const address = chain.poolAddress();
  const info = await chain.connection.getAccountInfo(address);
  if (!info) {
    throw new Error(
      `pool ${address.toBase58()} not found on this cluster; has bootstrap run?`,
    );
  }
  return decodePool(chain.program, address, info.data);
}

/**
 * Every admin-gated command ends here. Local mode signs and sends with the
 * loaded key, as it always did, unless a Ledger is loaded (ticket 09), in
 * which case it signs and sends through that instead. Multisig mode prints
 * the unsigned transaction on stdout and nothing else, for Squads to import.
 */
async function submit(
  chain: ChainService,
  mode: AdminMode,
  instructions: TransactionInstruction[],
  summary: string,
  ledger?: AdminSigner,
): Promise<void> {
  if (!mode.multisig) {
    const signature = ledger
      ? await sendWithLedger(chain, ledger, instructions)
      : await chain.send(instructions);
    log(`signature ${signature}`);
    log(summary);
    return;
  }
  // Same "finalized" blockhash as ChainService.send, and for the same
  // reason: a "confirmed" one from a load-balanced pool is unknown to nodes
  // a few slots behind, and Squads simulates the import against its own.
  const { blockhash } = await chain.connection.getLatestBlockhash("finalized");
  process.stdout.write(`${encodeForSquads(instructions, mode.signer, blockhash)}\n`);
  log(summary);
  log(
    `unsigned, signer and fee payer ${mode.signer.toBase58()}; paste into Squads' "Import base58 encoded tx" now, the blockhash expires in about a minute`,
  );
}

/**
 * Builds, signs through the Ledger and sends: `chain.send`'s shape, but for a
 * signer that never hands over a `Keypair` for `chain.send`'s own signature
 * to use. Lands through `chain.sendSigned` (ticket 04), the same
 * subscription-and-rebroadcast loop the operator's own sends use, so a
 * dropped packet gets the same second flight here too.
 */
async function sendWithLedger(
  chain: ChainService,
  ledger: AdminSigner,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await chain.connection.getLatestBlockhash("finalized");
  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: ledger.publicKey,
  }).add(...instructions);
  log("confirm on the Ledger");
  let signed: Transaction;
  try {
    signed = await ledger.signTransaction(tx);
  } catch (cause) {
    throw new Error("Ledger signing failed", { cause });
  }
  // SAFETY: signTransaction has just filled the fee payer's signature slot.
  const signature = bs58.encode(signed.signature as Buffer);
  await chain.sendSigned(signed.serialize(), signature, lastValidBlockHeight);
  return signature;
}

// `set_pause` takes the admin or the operator when pausing and the admin
// alone when unpausing. Pausing therefore always signs locally, whichever of
// the two keys is loaded; unpausing goes through `submit` because on mainnet
// the admin is the multisig.
async function pause(chain: ChainService): Promise<void> {
  const ix = await method(chain, "setPause", true)
    .accountsPartial({ signer: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log("pool paused");
}

async function unpause(
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "setPause", false)
    .accountsPartial({ signer: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], "unpause the pool", ledger);
}

type Feature = "game" | "jackpot";

// game-jackpot-pause ticket 02: `set_feature_pause` has `set_pause`'s role
// rule, so pausing signs locally with whichever key is loaded, same as
// `pause`, and starting goes through `submit`, same as `unpause`.
async function pauseFeature(chain: ChainService, feature: Feature): Promise<void> {
  const ix = await method(chain, "setFeaturePause", { [feature]: {} }, true)
    .accountsPartial({ signer: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log(`${feature} paused`);
}

/** The program would refuse an operator start anyway; checking the pool's
 *  admin first means a wrong key never costs a fee or a Squads proposal. */
async function startFeature(
  chain: ChainService,
  mode: AdminMode,
  feature: Feature,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  if (!mode.signer.equals(pool.admin)) {
    const role = mode.signer.equals(pool.operator) ? "the operator" : "not the admin";
    throw new Error(
      `start-${feature} is admin only: ${mode.signer.toBase58()} is ${role} of pool ${pool.address.toBase58()}; refusing before sending`,
    );
  }
  const ix = await method(chain, "setFeaturePause", { [feature]: {} }, false)
    .accountsPartial({ signer: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], `start the ${feature}`, ledger);
}

// yield-claimer ticket 10: `set_deploy_pause` has `set_pause`'s role rule.
// Pausing signs locally with whichever key is loaded (the Operator's too, the
// 3am stop for a venue in trouble), and resuming is admin only, so it goes
// through `submit` and a wrong key is refused before it costs a fee.
async function pauseDeploy(chain: ChainService): Promise<void> {
  const ix = await method(chain, "setDeployPause", true)
    .accountsPartial({ signer: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log("deploy paused");
}

async function startDeploy(
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  if (!mode.signer.equals(pool.admin)) {
    const role = mode.signer.equals(pool.operator) ? "the operator" : "not the admin";
    throw new Error(
      `start-deploy is admin only: ${mode.signer.toBase58()} is ${role} of pool ${pool.address.toBase58()}; refusing before sending`,
    );
  }
  const ix = await method(chain, "setDeployPause", false)
    .accountsPartial({ signer: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], "resume deploying to the venue", ledger);
}

// `set_buy_tickets_pause` is Admin only in both directions (ADR 0019), so both
// go through `submit`. Bootstrap sets it on mainnet; this clears it.
async function setBuyTicketsPause(
  chain: ChainService,
  mode: AdminMode,
  paused: boolean,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "setBuyTicketsPause", paused)
    .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    paused ? "pause buying tickets" : "resume buying tickets",
    ledger,
  );
}

/** Only the fields given are sent; the program leaves a `null` one alone. */
async function setVenueParams(
  chain: ChainService,
  mode: AdminMode,
  params: SetVenueParamsInput,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "setVenueParams", {
    yieldFeeBps: params.yieldFeeBps ?? null,
    idleFloorBps: params.idleFloorBps ?? null,
    idleTargetBps: params.idleTargetBps ?? null,
    reserveShareCapBps: params.reserveShareCapBps ?? null,
    reserveLiquidityFloorBps: params.reserveLiquidityFloorBps ?? null,
    minVenueMove:
      params.minVenueMove === undefined ? null : new BN(params.minVenueMove.toString()),
    lossToleranceBps: params.lossToleranceBps ?? null,
  })
    .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], "set venue params", ledger);
}

async function setTreasuryAccounts(
  chain: ChainService,
  mode: AdminMode,
  treasury: PublicKey,
  buybackReserve: PublicKey,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  const ix = await method(chain, "setTreasuryAccounts")
    .accountsPartial({
      admin: mode.signer,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      treasury,
      buybackReserve,
    })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    `set the treasury to ${treasury.toBase58()} and the buyback reserve to ${buybackReserve.toBase58()}`,
    ledger,
  );
}

/**
 * Not Admin-gated in the program: the signer pays from its own USDC account,
 * so this goes through `submit` for the multisig's sake but takes whichever
 * key signs. The program moves at most the deficit, so `amount` may overshoot.
 */
async function coverDeficit(
  chain: ChainService,
  mode: AdminMode,
  amount: bigint,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  // A Squads vault is a PDA, so its ATA owner is off the curve.
  const payerToken = getAssociatedTokenAddressSync(pool.acceptedMint, mode.signer, true);
  const ix = await method(chain, "coverDeficit", new BN(amount.toString()))
    .accountsPartial({
      payer: mode.signer,
      pool: pool.address,
      principalVault: chain.principalVaultAddress(pool.address),
      acceptedMint: pool.acceptedMint,
      payerToken,
      klendProgram: pool.klendProgram,
      klendMarket: pool.klendMarket,
      klendReserve: pool.klendReserve,
      klendCtoken: pool.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    `cover the deficit with up to ${amount} atomic units from ${payerToken.toBase58()}`,
    ledger,
  );
}

function bnOrNull(value: number | undefined): BN | null {
  return value === undefined ? null : new BN(value);
}

async function setParams(
  chain: ChainService,
  mode: AdminMode,
  params: SetParamsInput,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "setParams", {
    epochSeconds: bnOrNull(params.epochSeconds),
    epochAnchor: bnOrNull(params.epochAnchor),
    roundSeconds: bnOrNull(params.roundSeconds),
    closeBuffer: bnOrNull(params.closeBuffer),
    vrfTimeout: bnOrNull(params.vrfTimeout),
    minDeposit: params.minDeposit === undefined ? null : new BN(params.minDeposit.toString()),
    houseCutBps: params.houseCutBps === undefined ? null : params.houseCutBps,
    minJackpot:
      params.minJackpot === undefined ? null : new BN(params.minJackpot.toString()),
    payoutTimeout: bnOrNull(params.payoutTimeout),
    baseRateBps: params.baseRateBps ?? null,
    ticketsPerUsdc: params.ticketsPerUsdc ?? null,
    bonusCapBps: params.bonusCapBps ?? null,
  })
    .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    "set params (epoch/round changes apply to the next epoch/round, not the open one)",
    ledger,
  );
}

// ponytail: no auto-mint of a shortfall first. The operator does not mint or
// fund the jackpot itself; an admin topping this up by hand is expected to
// already hold hexUSDC (see the runbook's minting recipe). Auto-minting here
// would silently paper over a genuinely out-of-funds authority. Upgrade
// path: a --mint-shortfall flag if that friction turns out to matter.
async function fundJackpot(chain: ChainService, amount: bigint): Promise<void> {
  const pool = await readPool(chain);
  const source = getAssociatedTokenAddressSync(pool.acceptedMint, chain.keypair.publicKey);
  const ix = await method(chain, "fundJackpot", new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: chain.keypair.publicKey,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      source,
      jackpotVault: chain.jackpotVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log(`jackpot funded with ${amount} atomic units from ${source.toBase58()}`);
}

/**
 * The admin path of `grant_tickets`: uncapped, for the rare manual fix. The
 * referral job (docs/plan/hexo-referrals ticket 08) is the only intended
 * caller of the operator path, which signs with the operator key directly
 * through `OperatorInstructions` rather than this CLI.
 */
async function grantTickets(
  chain: ChainService,
  mode: AdminMode,
  owner: PublicKey,
  amount: bigint,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  const ix = await method(chain, "grantTickets", new BN(amount.toString()))
    .accountsPartial({
      signer: mode.signer,
      pool: pool.address,
      player: chain.playerAddress(owner),
      weightTree: pool.weightTree,
    })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    `grant ${amount} tickets to ${owner.toBase58()} (admin path, uncapped)`,
    ledger,
  );
}

/**
 * Irreversible on chain, so the CLI makes the operator name the pool out
 * loud first: `--confirm` must equal the configured `POOL_ID`, not just be
 * present, or nothing is sent.
 */
async function shutdownCommand(
  chain: ChainService,
  mode: AdminMode,
  confirm: bigint,
  ledger?: AdminSigner,
): Promise<void> {
  if (confirm !== chain.poolId) {
    throw new Error(
      `--confirm ${confirm} does not match the configured pool ${chain.poolId}; refusing an irreversible shutdown`,
    );
  }
  const ix = await method(chain, "shutdown")
    .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], `shut down pool ${chain.poolId} (irreversible)`, ledger);
}

interface CrankPlayer {
  readonly address: PublicKey;
  readonly owner: PublicKey;
  readonly principal: bigint;
  readonly pendingWithdraw: bigint;
}

/**
 * Every Player of this pool with `principal + pending_withdraw > 0`, House
 * excluded, read straight off the chain rather than through the indexer's
 * Postgres mirror: this crank is the last resort after `shutdown`, so it
 * must not depend on the indexer being up or caught up. Mirrors
 * `IndexerService.fetchAll`'s own discriminator-memcmp technique
 * (indexer/indexer.service.ts).
 */
async function playersOwedABalance(chain: ChainService): Promise<CrankPlayer[]> {
  const coder = chain.program.coder.accounts;
  // SAFETY: same shape indexer.service.ts's own memcmp call relies on;
  // BorshAccountsCoder.memcmp returns { offset: 0, bytes: base58(discriminator) }.
  const { bytes } = coder.memcmp("player") as { bytes: string };
  const accounts = await chain.connection.getProgramAccounts(chain.programId, {
    filters: [{ memcmp: { offset: 0, bytes } }],
  });
  const pool = chain.poolAddress();
  const players: CrankPlayer[] = [];
  for (const { pubkey, account } of accounts) {
    let raw: { owner: PublicKey; principal: BN; pendingWithdraw: BN; isHouse: boolean };
    try {
      raw = coder.decode("player", account.data);
    } catch {
      continue; // an account this program owns but a stale layout does not decode
    }
    if (!pubkey.equals(chain.playerAddress(raw.owner, pool))) continue; // a different pool's Player
    if (raw.isHouse) continue; // exits through sweep-house instead
    const principal = BigInt(raw.principal.toString());
    const pendingWithdraw = BigInt(raw.pendingWithdraw.toString());
    // A queued withdrawal is part of Principal until it pays (ADR 0020).
    if (principal <= 0n) continue;
    players.push({ address: pubkey, owner: raw.owner, principal, pendingWithdraw });
  }
  return players;
}

/**
 * Permissionless (spec.md "emergency_withdraw"): any signer pays the fee, so
 * this signs and sends locally with whatever key is loaded rather than going
 * through `submit()`'s admin/Squads path. Creates each owner's ATA
 * idempotently first, same as the operator's own `processWithdrawals`
 * (operator/instructions.ts), then batches `emergency_withdraw` `batchSize`
 * players per transaction. Stops at the first `InsufficientVault` rather
 * than sending every remaining batch into the same wall.
 */
async function emergencyCrank(chain: ChainService, batchSize: number): Promise<void> {
  const pool = await readPool(chain);
  const players = await playersOwedABalance(chain);
  if (players.length === 0) {
    log("no Player owes a balance; nothing to crank");
    return;
  }
  const principalVault = chain.principalVaultAddress(pool.address);
  let paid = 0;
  for (let start = 0; start < players.length; start += batchSize) {
    const batch = players.slice(start, start + batchSize);
    const instructions: TransactionInstruction[] = [];
    for (const player of batch) {
      const ownerToken = getAssociatedTokenAddressSync(pool.acceptedMint, player.owner);
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          chain.keypair.publicKey,
          ownerToken,
          player.owner,
          pool.acceptedMint,
        ),
        await method(chain, "emergencyWithdraw")
          .accountsPartial({
            pool: pool.address,
            player: player.address,
            weightTree: pool.weightTree,
            // Null, not omitted: the client would fill the fee payer in.
            owner: null,
            acceptedMint: pool.acceptedMint,
            ownerToken,
            principalVault,
            klendProgram: pool.klendProgram,
            klendMarket: pool.klendMarket,
            klendReserve: pool.klendReserve,
            klendCtoken: pool.klendCtoken,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
    }
    try {
      const signature = await chain.send(instructions);
      paid += batch.length;
      log(`signature ${signature}`);
      log(`paid ${batch.map((player) => player.owner.toBase58()).join(", ")}`);
    } catch (cause) {
      if ((cause instanceof Error ? cause.message : "") !== "InsufficientVault") throw cause;
      const skipped = players.length - paid;
      log(`insufficient vault: stopped before this batch of ${batch.length}; ${skipped} player(s) still owed`);
      const { amount } = await getAccount(chain.connection, principalVault);
      log(`principal vault holds ${amount}; recall the venue position if it is not all home`);
      log(`emergency-crank done: paid ${paid}, skipped ${skipped}`);
      return;
    }
  }
  log(`emergency-crank done: paid ${paid}, skipped 0`);
}

/** Admin-only, only valid once the pool is shut down (spec.md "sweep_house"):
 *  moves the jackpot vault's unreserved balance to treasury. */
async function sweepHouse(
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  const ix = await method(chain, "sweepHouse")
    .accountsPartial({
      admin: mode.signer,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      jackpotVault: chain.jackpotVaultAddress(pool.address),
      treasury: pool.treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    `sweep the unreserved jackpot to treasury ${pool.treasury.toBase58()}`,
    ledger,
  );
}

/** Same detection the operator uses (operator.service.ts): a test-vrf build
 *  keeps its randomness account under this program, not ORAO's. */
function isTestVrf(chain: ChainService): boolean {
  return chain.program.idl.instructions.some((ix) => ix.name === "testFulfill");
}

/**
 * Permissionless stuck-state exits (mainnet readiness 2026-09-28, blocker 4).
 * Both sign locally with the loaded key like `emergency-crank`: the program
 * takes any `caller` and enforces the deadline itself, so a too-early call
 * fails with `VrfTimeoutNotElapsed` / `PayoutTimeoutNotElapsed` rather than
 * doing anything. The randomness account is derived from the stored seed
 * and may not exist; the program allows that.
 */
async function voidRound(chain: ChainService, roundId: bigint): Promise<void> {
  const pool = await readPool(chain);
  const address = chain.roundAddress(roundId, pool.address);
  const info = await chain.connection.getAccountInfo(address);
  if (!info) throw new Error(`round ${roundId} (${address.toBase58()}) not found`);
  const round = decodeRound(chain.program, info.data);
  const ix = await method(chain, "voidRound")
    .accountsPartial({
      caller: chain.keypair.publicKey,
      pool: pool.address,
      round: address,
      randomness: randomnessAddress(chain.programId, round.vrfSeed, isTestVrf(chain)),
    })
    .instruction();
  const signature = await chain.send([ix]);
  log(`signature ${signature}`);
  log(`voided round ${roundId} (status was ${round.status})`);
}

async function rolloverEpoch(chain: ChainService, epochId: bigint): Promise<void> {
  const pool = await readPool(chain);
  const address = chain.epochAddress(epochId, pool.address);
  const info = await chain.connection.getAccountInfo(address);
  if (!info) throw new Error(`epoch ${epochId} (${address.toBase58()}) not found`);
  const epoch = decodeEpoch(chain.program, info.data);
  const ix = await method(chain, "rolloverEpoch")
    .accountsPartial({
      caller: chain.keypair.publicKey,
      pool: pool.address,
      epoch: address,
      randomness: randomnessAddress(chain.programId, epoch.vrfSeed, isTestVrf(chain)),
    })
    .instruction();
  const signature = await chain.send([ix]);
  log(`signature ${signature}`);
  log(`rolled over epoch ${epochId} (status was ${epoch.status})`);
}

/** The slice of PrismaClient `createInvite` needs, so `admin.test.ts` can
 *  drive it with an in-memory fake instead of a real Postgres. */
export interface InviteCodeStore {
  inviteCode: {
    create(args: {
      data: {
        code: string;
        ownerWallet: string | null;
        maxUses: number;
        uses: number;
        createdAt: bigint;
      };
    }): Promise<unknown>;
  };
}

/**
 * Writes `command.count` fresh codes to Postgres and prints each one, one per
 * line, to stdout. Never touches the chain, so `main()` calls this instead of
 * `run()` and skips building a ChainService for it altogether.
 */
export async function createInvite(
  store: InviteCodeStore,
  command: Extract<AdminCommand, { kind: "create-invite" }>,
): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < command.count; i++) {
    const code = generateInviteCode();
    await store.inviteCode.create({
      data: {
        code,
        ownerWallet: command.owner?.toBase58() ?? null,
        maxUses: command.maxUses,
        uses: 0,
        createdAt: now,
      },
    });
    process.stdout.write(`${code}\n`);
  }
}

/**
 * The command dispatch, exported so `admin.test.ts` can drive it with a
 * fabricated ChainService and watch what lands on stdout against stderr.
 * `main.ts` is the entry point that actually invokes it, so importing this
 * file never touches an env or a network. `create-invite` never reaches
 * here; `main()` handles it before this is called.
 */
export async function run(
  command: AdminCommand,
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  switch (command.kind) {
    case "pause":
      return pause(chain);
    case "unpause":
      return unpause(chain, mode, ledger);
    case "pause-game":
      return pauseFeature(chain, "game");
    case "pause-jackpot":
      return pauseFeature(chain, "jackpot");
    case "start-game":
      return startFeature(chain, mode, "game", ledger);
    case "start-jackpot":
      return startFeature(chain, mode, "jackpot", ledger);
    case "pause-deploy":
      return pauseDeploy(chain);
    case "start-deploy":
      return startDeploy(chain, mode, ledger);
    case "pause-buy-tickets":
      return setBuyTicketsPause(chain, mode, true, ledger);
    case "start-buy-tickets":
      return setBuyTicketsPause(chain, mode, false, ledger);
    case "set-venue-params":
      return setVenueParams(chain, mode, command.params, ledger);
    case "set-treasury-accounts":
      return setTreasuryAccounts(chain, mode, command.treasury, command.buybackReserve, ledger);
    case "cover-deficit":
      return coverDeficit(chain, mode, command.amount, ledger);
    case "set-params":
      return setParams(chain, mode, command.params, ledger);
    case "fund-jackpot":
      return fundJackpot(chain, command.amount);
    case "grant-tickets":
      return grantTickets(chain, mode, command.owner, command.amount, ledger);
    case "set-operator": {
      const ix = await method(chain, "setOperator", command.key)
        .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `set the operator to ${command.key.toBase58()}`,
        ledger,
      );
    }
    case "propose-admin": {
      const ix = await method(chain, "proposeAdmin", command.key)
        .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `propose ${command.key.toBase58()} as the next admin; it then runs accept-admin`,
        ledger,
      );
    }
    // venue-switch ticket 03. The admin signs and pays the proposal's rent on
    // the first proposal, so on mainnet the multisig vault needs a little SOL.
    case "propose-venue": {
      const ix = await method(
        chain,
        "proposeVenue",
        {
          venueKind: command.venueKind,
          klendProgram: command.program,
          klendMarket: command.market,
          klendReserve: command.reserve,
          klendCtoken: command.ctoken,
        },
      )
        .accountsPartial({
          admin: mode.signer,
          pool: chain.poolAddress(),
          proposal: venueProposalAddress(chain.programId, chain.poolAddress()),
        })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `propose venue kind ${command.venueKind} (reserve ${command.reserve.toBase58()}); deploys stop until cancel-venue or the migration, and the 48 hour lock restarts`,
        ledger,
      );
    }
    // venue-switch ticket 04. The deploy pause rides in the same transaction,
    // before the drain, so the Operator's crank cannot put the USDC back.
    // Whichever of Admin or Operator signs, both may do both.
    case "drain-venue": {
      const pool = await readPool(chain);
      const instructions = new OperatorInstructions(
        chain.program,
        chain.programId,
        mode.signer,
        false,
      );
      const pause = await method(chain, "setDeployPause", true)
        .accountsPartial({ signer: mode.signer, pool: pool.address })
        .instruction();
      const drain = await instructions.drainVenue(pool, command.amount, mode.signer);
      return submit(
        chain,
        mode,
        [pause, ...drain],
        `pause deploys and drain ${command.amount} atomic units from the venue into the principal vault; start-deploy resumes deploys`,
        ledger,
      );
    }
    case "cancel-venue": {
      const ix = await method(chain, "cancelVenue")
        .accountsPartial({
          admin: mode.signer,
          pool: chain.poolAddress(),
          proposal: venueProposalAddress(chain.programId, chain.poolAddress()),
        })
        .instruction();
      return submit(chain, mode, [ix], "cancel the open venue proposal; deploys resume", ledger);
    }
    // Signed by the pending admin, which is whoever is taking the pool over:
    // the loaded key when a person is, ADMIN_ADDRESS when the multisig is.
    case "accept-admin": {
      const ix = await method(chain, "acceptAdmin")
        .accountsPartial({ pendingAdmin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `accept the admin role as ${mode.signer.toBase58()}`,
        ledger,
      );
    }
    case "shutdown":
      return shutdownCommand(chain, mode, command.confirm, ledger);
    case "emergency-crank":
      return emergencyCrank(chain, command.batch);
    case "sweep-house":
      return sweepHouse(chain, mode, ledger);
    case "void-round":
      return voidRound(chain, command.roundId);
    case "rollover-epoch":
      return rolloverEpoch(chain, command.epochId);
  }
}

export async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  // Argument parsing happens before any env or network access, so a typo'd
  // command or a missing flag fails instantly with no chain touched.
  const command = parseAdminCommand(process.argv.slice(2));

  const env = validateEnv(process.env);

  if (command.kind === "create-invite") {
    const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
      await createInvite(prisma, command);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const primary = new Connection(env.RPC_URL, "confirmed");
  const fallback = env.RPC_FALLBACK_URL
    ? new Connection(env.RPC_FALLBACK_URL, "confirmed")
    : undefined;
  const connection = withRpcFallback(primary, fallback, env.RPC_TIMEOUT_MS);
  // Built directly, not through Nest DI: this script never boots a Nest
  // application, so ChainService's own constructor is the whole wiring.
  const chain = new ChainService(connection, new ConfigService<HexVaultEnv, true>(env));

  const ledger = await loadLedgerSigner(env.ADMIN_ADDRESS);
  const mode = adminMode(env.ADMIN_ADDRESS, ledger?.publicKey ?? chain.keypair.publicKey);
  // `connection.rpcEndpoint` reads straight through withRpcFallback's proxy
  // to the real Connection's own URL (security review ticket 14: it is a
  // plain getter, not a wrapped method, so the proxy never gets a chance to
  // redact it) — logging it here would print the RPC URL, api key and all,
  // to every CLI run. `rpcStatus` reports which endpoint is serving without
  // ever naming it, the same "primary"/"fallback" pair /status uses.
  log(
    `signer ${chain.keypair.publicKey.toBase58()} on the ${rpcStatus(connection).endpoint} RPC, pool ${chain.poolAddress().toBase58()}`,
  );
  if (ledger) {
    log(`admin signer is the Ledger at ${ledger.publicKey.toBase58()}`);
  }
  if (mode.multisig) {
    log(`admin is ${mode.signer.toBase58()}, not the loaded key: nothing will be sent`);
  }

  await run(command, chain, mode, ledger);
}

/**
 * ADMIN_KEYPAIR is admin-CLI-only (nothing else reads it), so it lives
 * outside HexVaultEnv/validateEnv, same as bootstrap.ts's own ad hoc env
 * reads. Unset, or anything that isn't a usb://ledger URI, returns
 * `undefined`: signing stays on chain.keypair exactly as before this ticket.
 */
async function loadLedgerSigner(
  adminAddress: string | undefined,
): Promise<AdminSigner | undefined> {
  const selector = parseAdminKeypair(process.env.ADMIN_KEYPAIR);
  if (!selector.ledger) return undefined;
  // Dynamic import: these two packages talk to real USB hardware at import
  // time, so this only runs (and only needs to work) when ADMIN_KEYPAIR
  // actually asks for a Ledger. admin.test.ts never sets it, so the test
  // suite never touches USB.
  const [{ default: TransportNodeHid }, { default: Solana }] = await Promise.all([
    import("@ledgerhq/hw-transport-node-hid"),
    import("@ledgerhq/hw-app-solana"),
  ]);
  const transport = await TransportNodeHid.create();
  const ledger = await ledgerSigner(new Solana(transport), selector.account);
  checkLedgerAddress(ledger.publicKey, adminAddress);
  return ledger;
}

/** Same cause-chain print as bootstrap.ts: the outer message names the step
 *  (here, just "admin"), the innermost names the RPC or program error. */
export function reportFailure(error: unknown): void {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `admin: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
}
