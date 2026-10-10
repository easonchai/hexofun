// GET /referrals/:wallet's response shape (docs/plan/hexo-referrals ticket
// 11). Pure and DB-free, same home and reasoning as referral.ts and
// referral-bonus.ts: referrals.controller.ts fetches rows from Postgres and
// hands them here, so the response shape is unit tested without a database.

import type { ReferralTier } from "./game-config";
import { daysToQualify, isQualified } from "./referral";
import { bandForCount, type ReferralBand } from "./referral-bonus";

/** First 4 and last 4 characters of a base58 wallet, so a referrer sees who
 *  referred without seeing the full address (spec.md Frontend: "Mask
 *  referee wallets"). Short enough addresses are shown as-is. */
export function maskWallet(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/** One Referral row, reduced to what the Your Team table needs
 *  (referral-page ticket 05): qualification, when it bound, and its own
 *  share of today's grant (0n when the referral isn't part of the basis, or
 *  no grant has landed yet). */
export interface ReferralInput {
  readonly referee: string;
  readonly aboveSince: bigint | null;
  readonly boundAt: bigint;
  readonly bonusToday: bigint;
}

/** spec.md "Referrals API response": Active / N days left / Under $50. */
export type ReferralStatus = "qualified" | "holding" | "below";

export interface ReferralItemDto {
  readonly wallet: string;
  readonly status: ReferralStatus;
  /** Whole days left before qualifying; null except while `status` is
   *  "holding" (below $50 has nothing counting down, qualified already
   *  arrived). */
  readonly daysLeft: number | null;
  readonly bonusToday: bigint;
  readonly joinedAt: bigint;
}

export interface ReferralsPageDto {
  readonly items: ReferralItemDto[];
  readonly nextCursor: string | null;
}

/** spec.md "Referrals API response": default page size. */
export const DEFAULT_REFERRALS_PAGE_SIZE = 50;

export interface ReferralsResponse {
  /** The wallet's own Referral code (ADR 0014); null before its first
   *  deposit, since the indexer creates it on that event. */
  readonly referralCode: string | null;
  readonly referrals: ReferralsPageDto;
  readonly qualifiedCount: number;
  /** Current band (referral-page ticket 03); tier 0 means no rate yet. */
  readonly band: ReferralBand;
  /** The next, higher band; null at the top band (11+). */
  readonly nextBand: ReferralBand | null;
  /** referral-page ticket 04: atomic Ticket amounts. `uncapped` is what the
   *  Referrer would get without their own Principal capping it; the web
   *  shows the capped-hint state only when it's greater than `amount`.
   *  `bonusYesterday` is gone (spec.md "Referrals API response"). */
  readonly bonusToday: { amount: bigint; uncapped: bigint };
}

function referralStatus(
  aboveSince: bigint | null,
  now: bigint,
  qualifySeconds: number,
): ReferralStatus {
  if (isQualified(aboveSince, now, qualifySeconds)) return "qualified";
  return aboveSince === null ? "below" : "holding";
}

/**
 * Newest `boundAt` first, ties broken by `referee` ascending so the order is
 * deterministic; `cursor` names the last referee already seen, so the page
 * starts right after it. A cursor that no longer matches any row (stale, or
 * simply never sent) restarts from the top — cheap and safe, since the web
 * only ever reads the first page (spec.md "no load-more control").
 */
function paginateReferrals(
  referrals: readonly ReferralInput[],
  cursor: string | null,
  limit: number,
): { page: ReferralInput[]; nextCursor: string | null } {
  const sorted = [...referrals].sort((a, b) => {
    if (a.boundAt !== b.boundAt) return a.boundAt > b.boundAt ? -1 : 1;
    return a.referee < b.referee ? -1 : a.referee > b.referee ? 1 : 0;
  });
  const startIndex = cursor === null ? 0 : sorted.findIndex((r) => r.referee === cursor) + 1;
  const slice = sorted.slice(startIndex, startIndex + limit + 1);
  const hasMore = slice.length > limit;
  const page = hasMore ? slice.slice(0, limit) : slice;
  return { page, nextCursor: hasMore ? page[page.length - 1]!.referee : null };
}

/**
 * Builds GET /referrals/:wallet's response (ticket 11; `referralCode` added
 * by ADR 0014 / docs/plan/referral-page ticket 01) from already-fetched
 * rows: this wallet's own ReferralCode, its Referrals (each already carrying
 * its own share of today's grant — ticket 05), and today's ReferralGrant
 * `{amount, uncapped}` (both 0n when the job has not granted today yet —
 * referral-page ticket 04). `band`/`nextBand` (referral-page ticket 03) and
 * `qualifiedCount` are computed over every Referral, not just the page that
 * ends up in `referrals.items`. Invite codes are never in this response
 * (beta-launch-fixes ticket 13): they are private, and returning a wallet's
 * unused codes here let anyone harvest them off the leaderboard.
 */
export function buildReferralsResponse(
  tiers: readonly ReferralTier[],
  referralCode: string | null,
  referrals: readonly ReferralInput[],
  now: bigint,
  qualifySeconds: number,
  bonusToday: { amount: bigint; uncapped: bigint },
  cursor: string | null = null,
  limit: number = DEFAULT_REFERRALS_PAGE_SIZE,
): ReferralsResponse {
  const qualifiedCount = referrals.filter((referral) =>
    isQualified(referral.aboveSince, now, qualifySeconds),
  ).length;
  const { band, nextBand } = bandForCount(tiers, qualifiedCount);
  const { page, nextCursor } = paginateReferrals(referrals, cursor, limit);

  return {
    referralCode,
    referrals: {
      items: page.map((referral) => {
        const status = referralStatus(referral.aboveSince, now, qualifySeconds);
        return {
          wallet: maskWallet(referral.referee),
          status,
          daysLeft:
            status === "holding" ? daysToQualify(referral.aboveSince, now, qualifySeconds) : null,
          bonusToday: referral.bonusToday,
          joinedAt: referral.boundAt,
        };
      }),
      nextCursor,
    },
    qualifiedCount,
    band,
    nextBand,
    bonusToday,
  };
}
