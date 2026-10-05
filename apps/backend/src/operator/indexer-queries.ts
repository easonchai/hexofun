// The operator reads Postgres, not the RPC, for anything that needs a list of
// accounts (spec §3.3). The indexer module owns those queries; this token
// keeps the two modules from importing each other, so either can land first.
export const INDEXER_QUERIES = Symbol("INDEXER_QUERIES");

export interface IndexerQueries {
  /**
   * Positions still on chain whose Round has reached a terminal status
   * (Settled, Forfeited, Voided), across every such Round, with the Round id
   * so the operator can group a batch by Round.
   */
  unsettledPositions(): Promise<{ address: string; owner: string; roundId: bigint }[]>;
  /**
   * Terminal Rounds with no Position left on them and not yet marked closed
   * (ops-and-envs ticket 08): what `close_round` may still reclaim rent
   * from. Oldest id first.
   */
  roundsToClose(): Promise<bigint[]>;
  /**
   * Every qualifying referrer's daily bonus for `epochId` not yet sent
   * (docs/plan/hexo-referrals ticket 08). Computes and records the whole
   * epoch's bonuses (via computeBonuses) the first time a referrer is seen
   * for this epoch, writing `ReferralGrant` before anything is sent, so the
   * table's own `@@unique([epochId, referrer])` makes this idempotent across
   * restarts. Skips a referrer whose mirrored `Player.bonusEpoch` already
   * equals `epochId`: the grant already landed on chain even though this
   * table's row still shows no `txSig`, which is exactly the gap a crash
   * between a confirmed send and `markReferralGrantsSent` leaves behind.
   * Every amount handed back is also re-clamped against the referrer's
   * current Principal (and persisted back to the row if it moved), so a
   * withdrawal after the row was first written cannot leave a stale amount
   * that fails on chain forever.
   */
  referralGrantsDue(epochId: bigint): Promise<{ referrer: string; amount: bigint }[]>;
  /** Records the signature of a batch of grants just sent, so a later tick
   *  or a restart does not resend them. */
  markReferralGrantsSent(
    epochId: bigint,
    referrers: readonly string[],
    txSig: string,
  ): Promise<void>;
}
