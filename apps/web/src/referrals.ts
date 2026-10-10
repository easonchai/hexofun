/**
 * Pure Referrals-screen logic (referral-page ticket 01): the hero card's
 * code-field view-model and the `?ref=CODE` share link. Kept out of
 * Referrals.tsx so the layout can change without touching this, mirroring
 * how ticket 09 split access.ts / useAccessGate.ts / AccessGate.tsx.
 *
 * The band/bonus/team helpers this file used to hold (hexo-referrals ticket
 * 11) are gone with the placeholder screen they served; ticket 03 brings the
 * band view-model back below, now over the API's `band`/`nextBand` shape,
 * and ticket 04 adds `referralBonusCardState` for the Referral's Bonus card.
 * Ticket 05 adds `teamRowView` for Your Team, over the API's paginated
 * `referrals.items` shape (spec.md "Referrals API response").
 */
import type { ReferralBandDto, ReferralItemDto, ReferralsDto } from "./api.js";
import { shortDate } from "./screens/Dashboard.js";

/** Hero card's code-field state (spec.md "Web page structure", user stories
 *  6-7): no wallet connected, connected but the code has not loaded yet
 *  (GET /referrals/:wallet mints one for any wallet past the gate, deposited
 *  or not), or connected with a code to show and share. */
export type ReferralHeroState =
  | { kind: "disconnected" }
  | { kind: "no-code" }
  | { kind: "has-code"; code: string };

export function referralHeroState(
  owner: string | null | undefined,
  data: ReferralsDto | null,
): ReferralHeroState {
  if (!owner) return { kind: "disconnected" };
  if (!data?.referralCode) return { kind: "no-code" };
  return { kind: "has-code", code: data.referralCode };
}

/** spec.md Copy: "COPY copies `${origin}/?ref=CODE`", using the app's own origin. */
export function shareLink(origin: string, code: string): string {
  return `${origin}/?ref=${code}`;
}

/** `?ref=CODE` from `location.search`; "" when absent. Mirrors
 *  `inviteCodeFromSearch` (access.ts ticket 09). */
export function refCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get("ref")?.trim() ?? "";
}

/** The exact bytes `POST /referrals/apply` must be signed over (ticket 02),
 *  mirroring the backend's `applyReferralMessage`
 *  (apps/backend/src/api/invite-code.ts). Distinct from `accessMessage`, so a
 *  redeem signature can't be replayed here. */
export function applyReferralMessage(wallet: string, code: string): string {
  return `HEXO apply referral: ${wallet} ${code}`;
}

/** Tier 0: no qualified referrals yet, matching the backend's `bandForCount(0)`. */
const ZERO_BAND: ReferralBandDto = { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 };
/** Tier 1's range (spec.md "Bonus Rate tooltip": "1–2 friends: 2%"), the
 *  implicit next band before the first poll lands — matching what
 *  `bandForCount(0)` actually returns, so this looks the same as a freshly
 *  connected wallet with 0 qualified referrals. */
const FIRST_BAND: ReferralBandDto = { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 };

/** Bonus Rate card's view-model (referral-page ticket 03, Figma `230:16970`). */
export type BonusRateView =
  | { kind: "disconnected" }
  | {
      kind: "ready";
      /** "3%", "0%" at tier 0. */
      ratePercent: string;
      /** "TIER 2 (3-5 QUALIFIED REFERRALS)", "TIER 4 (11+ QUALIFIED REFERRALS)"
       *  at the top tier; null at tier 0, which has no range of its own. */
      tierLabel: string | null;
      /** qualifiedCount / nextBand.minCount; 1 (full) at the top tier. */
      progressFraction: number;
      /** "N qualified referrals · M more to unlock X%"; "N qualified
       *  referrals · Max tier" at the top tier; "1-2 qualified referrals
       *  unlock 2%" at tier 0 (spec.md user story 13). */
      progressCopy: string;
    };

const percent = (rateBps: number): string => `${rateBps / 100}%`;

const tierLabel = (band: ReferralBandDto): string =>
  `TIER ${band.tier} (${band.minCount}${band.maxCount === null ? "+" : `-${band.maxCount}`} QUALIFIED REFERRALS)`;

export function bonusRateView(
  owner: string | null | undefined,
  data: ReferralsDto | null,
): BonusRateView {
  if (!owner) return { kind: "disconnected" };

  const { qualifiedCount, band, nextBand } = data ?? {
    qualifiedCount: 0,
    band: ZERO_BAND,
    nextBand: FIRST_BAND,
  };
  const ratePercent = percent(band.rateBps);

  if (nextBand === null) {
    return {
      kind: "ready",
      ratePercent,
      tierLabel: tierLabel(band),
      progressFraction: 1,
      progressCopy: `${qualifiedCount} qualified referrals · Max tier`,
    };
  }

  const progressCopy =
    band.tier === 0
      ? `${nextBand.minCount}-${nextBand.maxCount} qualified referrals unlock ${percent(nextBand.rateBps)}`
      : `${qualifiedCount} qualified referrals · ${nextBand.minCount - qualifiedCount} more to unlock ${percent(nextBand.rateBps)}`;

  return {
    kind: "ready",
    ratePercent,
    tierLabel: band.tier === 0 ? null : tierLabel(band),
    progressFraction: qualifiedCount / nextBand.minCount,
    progressCopy,
  };
}

/** Tickets share USDC's atomic scale (money.ts): 6 decimals. The Referral's Bonus card shows whole
 *  Tickets only (ticket 04), so this truncates rather than rounds. */
const TICKET_DECIMALS = 1_000_000n;

function wholeTickets(atomic: string): number {
  return Number(BigInt(atomic) / TICKET_DECIMALS);
}

/** Referral's Bonus card state (referral-page ticket 04, Figma `230:17196` /
 *  `230:17195`): the capped state shows only once the own-Principal cap
 *  actually bound (`uncapped > amount`), never merely because a grant hasn't
 *  landed yet — a wallet with no grant today is "not-capped" at `amount: 0`,
 *  which the card renders as "+0" (spec.md "No grant today shows '+0'"). */
export type ReferralBonusCardState =
  | { kind: "disconnected" }
  | { kind: "not-capped"; amount: number }
  | { kind: "capped"; amount: number; uncapped: number; hintUsdc: number };

export function referralBonusCardState(
  owner: string | null | undefined,
  data: ReferralsDto | null,
): ReferralBonusCardState {
  if (!owner) return { kind: "disconnected" };
  const bonus = data?.bonusToday ?? { amount: "0", uncapped: "0" };
  const amount = wholeTickets(bonus.amount);
  const uncapped = wholeTickets(bonus.uncapped);
  if (uncapped <= amount) return { kind: "not-capped", amount };
  // spec.md "Referral grant gains uncapped": both are already whole Tickets
  // computed the same own-Principal-cap boundary as the deposit headroom
  // (referral-bonus.ts's remainingGrantCap), so the gap between them reads
  // directly as whole USDC still needed — exact while the pool-wide cap
  // isn't binding, understating it when the pool cap also binds (ponytail:
  // spec.md's own note; the API would need to expose the scale factor to
  // fix this precisely).
  return { kind: "capped", amount, uncapped, hintUsdc: uncapped - amount };
}

/** Your Team row view-model (referral-page ticket 05, Figma `204:12548`):
 *  the status pill's label, this referral's own bonus in whole Tickets, and
 *  JOINED as "Sun, Sep 6" local time. */
export interface TeamRowView {
  readonly wallet: string;
  readonly status: ReferralItemDto["status"];
  /** "Active" | "N days left" | "Under $50" (spec.md "Referrals API response"). */
  readonly statusLabel: string;
  readonly bonus: number;
  readonly joined: string;
}

function teamStatusLabel(item: ReferralItemDto): string {
  if (item.status === "qualified") return "Active";
  if (item.status === "below") return "Under $50";
  const days = item.daysLeft ?? 0;
  return `${days} day${days === 1 ? "" : "s"} left`;
}

/** ticket 22: each row's bonus truncates to whole Tickets the same way
 *  `referralBonusCardState`'s own `amount` does (`wholeTickets` above).
 *  ponytail: each row truncates independently, so a handful of rows can sum
 *  to one or two whole Tickets under the Referral's Bonus card's own
 *  (likewise truncated) total when several fractional remainders each round
 *  down — a largest-remainder pass over the whole-Ticket totals would close
 *  that gap if it ever turns out to matter. */
export function teamRowView(item: ReferralItemDto): TeamRowView {
  return {
    wallet: item.wallet,
    status: item.status,
    statusLabel: teamStatusLabel(item),
    bonus: wholeTickets(item.bonusToday),
    joined: shortDate(item.joinedAt),
  };
}
