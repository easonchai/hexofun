/**
 * Shared by the two live feeds Solami pushes before finality: the webhook
 * (solami-index 09, 0-1 s after the block) and the Mirage stream (confirmed).
 * The Indexer's `onLogs` subscribes at `finalized`, and `persist` must never
 * see a transaction a fork can still drop, so both feeds wait here first.
 */

/** Finality takes ~32 slots (~13 s); give it about 40 s before leaving the
 *  transaction to the RPC walk. */
export const FINALITY_CHECKS = 10;
export const FINALITY_INTERVAL_MS = 4_000;

export type SignatureStatusLike = { slot: number; err: unknown; confirmationStatus?: string | null } | null;

/**
 * The slot `signature` finalized in, or null if it failed or did not finalize
 * within FINALITY_CHECKS. The slot comes from the RPC, not the delivery: a
 * transaction re-included after a fork lands in another slot. A failed status
 * read counts as "not yet"; the caller logs the null.
 */
export async function awaitFinalized(
  status: (signature: string) => Promise<SignatureStatusLike>,
  signature: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
): Promise<number | null> {
  for (let check = 0; check < FINALITY_CHECKS; check += 1) {
    if (check > 0) await sleep(FINALITY_INTERVAL_MS);
    const value = await status(signature).catch(() => null);
    if (value?.err) return null;
    if (value?.confirmationStatus === "finalized") return value.slot;
  }
  return null;
}
