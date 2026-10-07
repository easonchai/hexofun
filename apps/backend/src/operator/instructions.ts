// One builder per step of spec §3.4. Every account is passed explicitly
// (`accountsPartial`) so building an instruction never costs an RPC round
// trip, and so the unit tests can build the real instructions offline.
import { BN, type Idl, type Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  epochAddress,
  jackpotVaultAddress,
  playerAddress,
  positionAddress,
  principalVaultAddress,
  roundAddress,
  venueProposalAddress,
} from "../chain/pda";
import { kvaultRemaining } from "../chain/kvault";
import { VENUE_KIND } from "../chain/venue-kind";
import type { EpochState, PoolState, RoundState } from "./chain-state";
import {
  ORAO_VRF_PROGRAM_ID,
  ORAO_VRF_TREASURY,
  randomNonce,
  randomnessAddress,
  vrfSeed,
} from "./vrf";

const bn = (value: bigint): BN => new BN(value.toString());

/**
 * What an instruction does at the venue, which decides the remaining accounts
 * a kVault pool needs: `sync` only values the position, `move` also deposits,
 * `redeem` may withdraw. klend and the stub take the same accounts for the
 * last two and none for the first.
 */
type VenueUse = "sync" | "move" | "redeem";

/** The calls this file makes on an Anchor methods builder. */
interface BuiltAccounts {
  remainingAccounts(accounts: AccountMeta[]): BuiltAccounts;
  instruction(): Promise<TransactionInstruction>;
}

interface MethodBuilder {
  /** `null` leaves an optional account out. */
  accountsPartial(accounts: Record<string, PublicKey | null>): BuiltAccounts;
}

type MethodFactory = (...args: unknown[]) => MethodBuilder;

export class OperatorInstructions {
  constructor(
    private readonly program: Program<Idl>,
    private readonly programId: PublicKey,
    private readonly operator: PublicKey,
    /**
     * True when the deployed program is a `test-vrf` build, which puts the
     * randomness account at a PDA of this program instead of ORAO's. Read off
     * the IDL, the only thing that tracks which build is out there.
     */
    private readonly testVrf: boolean,
  ) {}

  randomnessFor(seed: Uint8Array): PublicKey {
    return randomnessAddress(this.programId, seed, this.testVrf);
  }

  /**
   * `Program<Idl>` carries no generated instruction types, so its methods
   * namespace is keyed by plain strings and every entry reads as optional.
   * Looking one up here turns a stale IDL into one clear error instead of a
   * "cannot invoke undefined" at the call site.
   */
  private method(name: string, ...args: unknown[]): MethodBuilder {
    // SAFETY: the shape is checked structurally by MethodBuilder; only the
    // name is unknown to the compiler, and it is checked right below.
    const factory = (this.program.methods as Record<string, MethodFactory | undefined>)[name];
    if (!factory) {
      throw new Error(`instruction ${name} is missing from the IDL; re-run sync-idl`);
    }
    return factory(...args);
  }

  private epoch(pool: PoolState, epochId: bigint): PublicKey {
    return epochAddress(this.programId, pool.address, epochId);
  }

  private round(pool: PoolState, roundId: bigint): PublicKey {
    return roundAddress(this.programId, pool.address, roundId);
  }

  private player(pool: PoolState, owner: PublicKey): PublicKey {
    return playerAddress(this.programId, pool.address, owner);
  }

  /** The four pinned klend addresses an instruction that runs sync names. */
  private venue(pool: PoolState): Record<string, PublicKey> {
    return {
      klendProgram: pool.klendProgram,
      klendMarket: pool.klendMarket,
      klendReserve: pool.klendReserve,
      klendCtoken: pool.klendCtoken,
    };
  }

  /**
   * What a venue deposit or redeem needs beyond the pinned four (klend.rs,
   * in this order): the lending market authority, the reserve's liquidity
   * supply vault, the cToken mint and the instructions sysvar. klend derives
   * the first three from the market and the liquidity mint, so no RPC read is
   * needed, and the program checks each against the reserve itself
   * (`KlendAccountMismatch`). The stub kind ignores remaining accounts. The
   * builder switches on the pool's venue kind, not on which program is pinned.
   *
   * A kVault pool (kvault.rs) takes the klend program, every allocation
   * reserve and market of the vault, then the vault's own accounts and the
   * source reserve's, all derived from `pool.kvault`, the vault state the
   * operator read this tick (`chain/kvault.ts`). Every instruction that syncs
   * needs the reserve and market blocks, because the vault's value is read
   * from them.
   */
  private venueRemaining(pool: PoolState, use: VenueUse = "move"): AccountMeta[] {
    if (pool.venueKind === VENUE_KIND.stub) return [];
    if (pool.venueKind === VENUE_KIND.kvault) {
      // Derived from the vault state the operator read this tick, never from
      // env: the curator can change the allocation list at any time.
      if (!pool.kvault) {
        throw new Error(`pool ${pool.address.toBase58()} is a kVault pool, but its vault was not read`);
      }
      return kvaultRemaining(pool.kvault, {
        valueOnly: use === "sync",
        ...(use === "redeem" ? { writableMint: pool.acceptedMint } : {}),
      });
    }
    if (use === "sync") return [];
    if (pool.venueKind !== VENUE_KIND.klend) {
      throw new Error(`pool ${pool.address.toBase58()} has venue kind ${pool.venueKind}, which this operator cannot build accounts for`);
    }
    const derive = (...seeds: (string | PublicKey)[]): PublicKey =>
      PublicKey.findProgramAddressSync(
        seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : seed.toBuffer())),
        pool.klendProgram,
      )[0];
    const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
      pubkey,
      isSigner: false,
      isWritable,
    });
    return [
      meta(derive("lma", pool.klendMarket), false),
      meta(derive("reserve_liq_supply", pool.klendMarket, pool.acceptedMint), true),
      meta(derive("reserve_coll_mint", pool.klendMarket, pool.acceptedMint), true),
      meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
    ];
  }

  async beginEpoch(pool: PoolState): Promise<TransactionInstruction[]> {
    // `current_epoch` does not exist before the first epoch; the program skips
    // it in that case, but the address still has to be supplied.
    // `epochTwoBehind` (beta-launch-fixes ticket 03) is likewise only read
    // once `current_epoch_id >= 2`; the address still has to be supplied, and
    // clamping at 0 keeps it in range for the two calls before that.
    const twoBehindId = pool.currentEpochId > 0n ? pool.currentEpochId - 1n : 0n;
    return [
      await this.method("beginEpoch")
        .accountsPartial({
          operator: this.operator,
          pool: pool.address,
          currentEpoch: this.epoch(pool, pool.currentEpochId),
          epochTwoBehind: this.epoch(pool, twoBehindId),
          newEpoch: this.epoch(pool, pool.currentEpochId + 1n),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  /**
   * Step 3b (docs/plan/hexo-referrals ticket 08): one `grant_tickets` per
   * referrer, batched into one transaction. Signed by the operator, so every grant is capped on chain per
   * Player per day at their own Principal and pool-wide at `bonus_cap_bps`
   * of `total_principal` (`grant_tickets`' operator path).
   */
  async grantTickets(
    pool: PoolState,
    grants: readonly { referrer: string; amount: bigint }[],
  ): Promise<TransactionInstruction[]> {
    return Promise.all(
      grants.map((grant) =>
        this.method("grantTickets", bn(grant.amount))
          .accountsPartial({
            signer: this.operator,
            pool: pool.address,
            player: this.player(pool, new PublicKey(grant.referrer)),
            weightTree: pool.weightTree,
          })
          .instruction(),
      ),
    );
  }

  /**
   * Step 6b: pay one batch of due withdrawal requests. `process_withdraw`
   * syncs, settles and writes the Weight tree, so it names both. The optional
   * owner signer is left out (the tick sends none while the pool is impaired,
   * the only time the program wants it), so the operator is here only as the fee payer and as
   * the payer of the owner token accounts it creates. Each payout is
   * preceded by an idempotent ATA creation: the program transfers to a
   * token account of the accepted mint owned by `player.owner`, and a
   * depositor who closed theirs between the request and the payout would
   * otherwise block their own money.
   */
  async processWithdrawals(
    pool: PoolState,
    owners: readonly { owner: string }[],
  ): Promise<TransactionInstruction[]> {
    const principalVault = principalVaultAddress(this.programId, pool.address);
    const batches = await Promise.all(
      owners.map(async (entry) => {
        const owner = new PublicKey(entry.owner);
        const ownerToken = getAssociatedTokenAddressSync(pool.acceptedMint, owner);
        return [
          createAssociatedTokenAccountIdempotentInstruction(
            this.operator,
            ownerToken,
            owner,
            pool.acceptedMint,
          ),
          await this.method("processWithdraw")
            .accountsPartial({
              pool: pool.address,
              player: this.player(pool, owner),
              // Null, not omitted: the client would fill the operator in.
              owner: null,
              weightTree: pool.weightTree,
              acceptedMint: pool.acceptedMint,
              ownerToken,
              principalVault,
              ...this.venue(pool),
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .remainingAccounts(this.venueRemaining(pool, "sync"))
            .instruction(),
        ];
      }),
    );
    return batches.flat();
  }

  /**
   * Step 4: sends the ended epoch to the draw, or rolls it over when it holds
   * no Weight or a prize under `min_jackpot`. Operator-only. A fresh nonce is
   * generated per call and mixed into the seed (beta-launch-fixes ticket 02),
   * so the randomness address is derived here rather than read back off the
   * Epoch, and is unknowable before this call.
   */
  async requestDraw(pool: PoolState, epochId: bigint): Promise<TransactionInstruction[]> {
    const nonce = randomNonce();
    return [
      await this.method("requestDraw", Array.from(nonce))
        .accountsPartial({
          operator: this.operator,
          pool: pool.address,
          epoch: this.epoch(pool, epochId),
          weightTree: pool.weightTree,
          jackpotVault: jackpotVaultAddress(this.programId, pool.address),
          randomness: this.randomnessFor(vrfSeed("epoch", pool.address, epochId, nonce)),
          vrfNetworkState: pool.vrfNetworkState,
          vrfTreasury: ORAO_VRF_TREASURY,
          vrfProgram: ORAO_VRF_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  /** Permissionless (production-hardening ticket 01): the operator still
   *  cranks it, but the first account is `caller`, not `operator`. */
  async draw(pool: PoolState, epoch: EpochState): Promise<TransactionInstruction[]> {
    return [
      await this.method("draw")
        .accountsPartial({
          caller: this.operator,
          pool: pool.address,
          epoch: this.epoch(pool, epoch.epochId),
          randomness: this.randomnessFor(epoch.vrfSeed),
        })
        .instruction(),
    ];
  }

  /**
   * Takes the Epoch rather than its id: the program checks the randomness
   * account against the epoch's own seed before it will roll over.
   * Permissionless (production-hardening ticket 01): first account is
   * `caller`, not `operator`.
   */
  async rolloverEpoch(pool: PoolState, epoch: EpochState): Promise<TransactionInstruction[]> {
    return [
      await this.method("rolloverEpoch")
        .accountsPartial({
          caller: this.operator,
          pool: pool.address,
          epoch: this.epoch(pool, epoch.epochId),
          randomness: this.randomnessFor(epoch.vrfSeed),
        })
        .instruction(),
    ];
  }

  /**
   * Permissionless: the instruction takes no signer, so the operator is here
   * only as the fee payer. A non-House winner needs no token account of
   * their own any more (docs/plan/hexo-referrals ticket 02): the prize
   * compounds into `principal_vault` and the winner's Principal instead of
   * being paid to a token account, so there is nothing to create first.
   */
  async payout(
    pool: PoolState,
    epochId: bigint,
    winner: PublicKey,
  ): Promise<TransactionInstruction[]> {
    return [
      await this.method("payout")
        .accountsPartial({
          pool: pool.address,
          weightTree: pool.weightTree,
          acceptedMint: pool.acceptedMint,
          epoch: this.epoch(pool, epochId),
          winner: this.player(pool, winner),
          jackpotVault: jackpotVaultAddress(this.programId, pool.address),
          principalVault: principalVaultAddress(this.programId, pool.address),
          treasury: pool.treasury,
          buybackReserve: pool.buybackReserve,
          ...this.venue(pool),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(this.venueRemaining(pool, "sync"))
        .instruction(),
    ];
  }

  /**
   * A fresh nonce is generated per call and mixed into the seed
   * (beta-launch-fixes ticket 02), so the randomness address is derived here
   * from `round.roundId` rather than read back off `round.vrfSeed` (still
   * `[0; 32]` before the first successful request), and is unknowable before
   * this call.
   */
  async requestRoundRandomness(
    pool: PoolState,
    round: RoundState,
  ): Promise<TransactionInstruction[]> {
    const nonce = randomNonce();
    return [
      await this.method("requestRoundRandomness", Array.from(nonce))
        .accountsPartial({
          payer: this.operator,
          pool: pool.address,
          round: this.round(pool, round.roundId),
          randomness: this.randomnessFor(vrfSeed("round", pool.address, round.roundId, nonce)),
          vrfNetworkState: pool.vrfNetworkState,
          vrfTreasury: ORAO_VRF_TREASURY,
          vrfProgram: ORAO_VRF_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  /** Permissionless (production-hardening ticket 01): first account is
   *  `caller`, not `operator`; `house` still pins to `pool.house`. */
  async settleRound(pool: PoolState, round: RoundState): Promise<TransactionInstruction[]> {
    return [
      await this.method("settleRound")
        .accountsPartial({
          caller: this.operator,
          pool: pool.address,
          round: this.round(pool, round.roundId),
          randomness: this.randomnessFor(round.vrfSeed),
          house: pool.house,
          weightTree: pool.weightTree,
        })
        .instruction(),
    ];
  }

  /**
   * Takes the Round rather than its id: the program checks the randomness
   * account against the round's own seed before it will void. Permissionless
   * (production-hardening ticket 01): first account is `caller`, not
   * `operator`.
   */
  async voidRound(pool: PoolState, round: RoundState): Promise<TransactionInstruction[]> {
    return [
      await this.method("voidRound")
        .accountsPartial({
          caller: this.operator,
          pool: pool.address,
          round: this.round(pool, round.roundId),
          randomness: this.randomnessFor(round.vrfSeed),
        })
        .instruction(),
    ];
  }

  async settlePositions(
    pool: PoolState,
    roundId: bigint,
    positions: readonly { address: string; owner: string }[],
  ): Promise<TransactionInstruction[]> {
    const round = this.round(pool, roundId);
    return Promise.all(
      positions.map((position) => {
        const owner = new PublicKey(position.owner);
        return this.method("settlePosition")
          .accountsPartial({
            pool: pool.address,
            weightTree: pool.weightTree,
            round,
            player: this.player(pool, owner),
            owner,
            position: new PublicKey(position.address),
          })
          .instruction();
      }),
    );
  }

  /**
   * Permissionless, and the only builder here whose signer is not the
   * operator: the Sparring player buys for itself, so the owner is passed in
   * and `ChainService.send` gets its keypair.
   */
  async buyPosition(
    pool: PoolState,
    roundId: bigint,
    owner: PublicKey,
    tiles: bigint,
    stakePerTile: bigint,
  ): Promise<TransactionInstruction[]> {
    const round = this.round(pool, roundId);
    return [
      await this.method("buyPosition", bn(tiles), bn(stakePerTile))
        .accountsPartial({
          owner,
          pool: pool.address,
          player: this.player(pool, owner),
          weightTree: pool.weightTree,
          round,
          position: positionAddress(this.programId, round, owner),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  /**
   * Permissionless (ops-and-envs ticket 08): reclaims a terminal Round's
   * rent for the operator once nothing settled on it is still owed. The
   * operator is both the fee payer and the rent destination, so it is
   * passed once for both roles.
   */
  async closeRound(pool: PoolState, roundId: bigint): Promise<TransactionInstruction[]> {
    return [
      await this.method("closeRound")
        .accountsPartial({
          pool: pool.address,
          operator: this.operator,
          round: this.round(pool, roundId),
        })
        .instruction(),
    ];
  }

  async createRound(
    pool: PoolState,
    startsAt: bigint,
    endsAt: bigint,
  ): Promise<TransactionInstruction[]> {
    return [
      await this.method("createRound", bn(startsAt), bn(endsAt))
        .accountsPartial({
          operator: this.operator,
          pool: pool.address,
          currentEpoch: this.epoch(pool, pool.currentEpochId),
          round: this.round(pool, pool.nextRoundId),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  /**
   * The three venue cranks (yield-claimer ticket 13) are permissionless: the
   * operator is only the fee payer. Each syncs first, and the klend backing
   * refreshes its own reserve by CPI, so no refresh instruction goes in front.
   * `amount` is atomic USDC.
   */
  async deployToVenue(pool: PoolState, amount: bigint): Promise<TransactionInstruction[]> {
    return [
      await this.method("deployToVenue", bn(amount))
        .accountsPartial({
          pool: pool.address,
          principalVault: principalVaultAddress(this.programId, pool.address),
          acceptedMint: pool.acceptedMint,
          ...this.venue(pool),
          // Usually absent on chain; the program refuses a deploy while it exists.
          venueProposal: venueProposalAddress(this.programId, pool.address),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(this.venueRemaining(pool))
        .instruction(),
    ];
  }

  async recall(pool: PoolState, amount: bigint): Promise<TransactionInstruction[]> {
    return [
      await this.method("recall", bn(amount))
        .accountsPartial({
          pool: pool.address,
          principalVault: principalVaultAddress(this.programId, pool.address),
          acceptedMint: pool.acceptedMint,
          ...this.venue(pool),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(this.venueRemaining(pool, "redeem"))
        .instruction(),
    ];
  }

  /**
   * `drain_venue` (venue-switch ticket 04): brings `amount` home from the
   * venue to the principal vault. `signer` is the Operator for the tick's
   * crank and the Admin for the CLI; the program lets either in at any time
   * and anyone while a proposal is open.
   */
  async drainVenue(
    pool: PoolState,
    amount: bigint,
    signer: PublicKey = this.operator,
  ): Promise<TransactionInstruction[]> {
    return [
      await this.method("drainVenue", bn(amount))
        .accountsPartial({
          signer,
          pool: pool.address,
          principalVault: principalVaultAddress(this.programId, pool.address),
          acceptedMint: pool.acceptedMint,
          ...this.venue(pool),
          venueProposal: venueProposalAddress(this.programId, pool.address),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(this.venueRemaining(pool, "redeem"))
        .instruction(),
    ];
  }

  /**
   * `migrate_venue` (venue-switch ticket 05): permissionless, so the operator
   * only pays the fee. `pool` is the pool as it reads BEFORE the migration:
   * the sync inside it values the old venue, so the four pins and the extras
   * are the old ones. The proposal closes into `pool.admin`, who paid its rent.
   */
  async migrateVenue(pool: PoolState): Promise<TransactionInstruction[]> {
    return [
      await this.method("migrateVenue")
        .accountsPartial({
          pool: pool.address,
          admin: pool.admin,
          proposal: venueProposalAddress(this.programId, pool.address),
          ...this.venue(pool),
        })
        .remainingAccounts(this.venueRemaining(pool, "sync"))
        .instruction(),
    ];
  }

  /**
   * Fast pause (ops-console ticket 06). The Operator may only turn a switch
   * on, so these three hardcode `true`: no argument can pass `false`.
   */
  async setPauseOn(pool: PublicKey): Promise<TransactionInstruction> {
    return this.method("setPause", true)
      .accountsPartial({ signer: this.operator, pool })
      .instruction();
  }

  async setFeaturePauseOn(
    pool: PublicKey,
    feature: "game" | "jackpot",
  ): Promise<TransactionInstruction> {
    // Anchor encodes a unit enum variant as `{ variantName: {} }`.
    const variant = feature === "game" ? { game: {} } : { jackpot: {} };
    return this.method("setFeaturePause", variant, true)
      .accountsPartial({ signer: this.operator, pool })
      .instruction();
  }

  async setDeployPauseOn(pool: PublicKey): Promise<TransactionInstruction> {
    return this.method("setDeployPause", true)
      .accountsPartial({ signer: this.operator, pool })
      .instruction();
  }

  /** Pays the fee owed to `pool.treasury` and the prize share owed to the
   *  jackpot vault. */
  async harvest(pool: PoolState): Promise<TransactionInstruction[]> {
    return [
      await this.method("harvest")
        .accountsPartial({
          pool: pool.address,
          principalVault: principalVaultAddress(this.programId, pool.address),
          jackpotVault: jackpotVaultAddress(this.programId, pool.address),
          treasury: pool.treasury,
          acceptedMint: pool.acceptedMint,
          ...this.venue(pool),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(this.venueRemaining(pool, "redeem"))
        .instruction(),
    ];
  }
}
