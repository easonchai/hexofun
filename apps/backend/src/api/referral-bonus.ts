// Daily referral bonus math (docs/plan/hexo-referrals ticket 08). Pure and
// DB-free, same home and reasoning as referral.ts: the operator's daily job
// imports this without pulling in Prisma, and it is table-tested on its own.
//
// spec.md "Daily referral bonus job": for each referrer with a Player and a
// Principal of their own, the qualified-referral count picks a rate tier,
// applied to the sum of those referrals' own Principal (each counted up to
// $2,500), capped at the referrer's own Principal, then scaled down
// pool-wide (floored) if the total would exceed the epoch's bonus cap.

/** Qualified-referral counts to rate tiers, in basis points: 1-2 -> 2%,
 *  3-5 -> 3%, 6-10 -> 4%, 11+ -> 5%. Checked highest `min` first so the
 *  first match wins. `max: null` at the top tier (11+, tier 4), which has no
 *  upper bound. */
export const RATE_TIERS: readonly { tier: number; min: number; max: number | null; rateBps: number }[] = [
  { tier: 4, min: 11, max: null, rateBps: 500 },
  { tier: 3, min: 6, max: 10, rateBps: 400 },
  { tier: 2, min: 3, max: 5, rateBps: 300 },
  { tier: 1, min: 1, max: 2, rateBps: 200 },
];

/** $2,500 at 6 decimals: a qualified referral counts toward its referrer's
 *  basis only up to this much of its own Principal. */
export const REFERRAL_BONUS_BASIS_CAP = 2_500_000_000n;

/**
 * One referrer's inputs: their own Principal, what the operator path has
 * already granted them today (their remaining headroom is the difference),
 * and one entry per qualified referral, that referral's own Principal (for
 * the basis sum). A referrer with no Player, or a Principal of 0, gets
 * nothing either way `principal` is passed as 0n: the per-Player on-chain
 * cap would refuse them regardless.
 */
export interface ReferrerBonusInput {
  readonly referrer: string;
  readonly principal: bigint;
  /** `Player.bonusGranted` for this epoch, or 0 once the epoch counter has
   *  rolled over (mirroring the program's own lazy reset): what the
   *  operator path has already granted this referrer today, which eats
   *  into their remaining headroom the same way a fresh grant would. */
  readonly alreadyGrantedToday: bigint;
  readonly qualifiedReferralPrincipals: readonly bigint[];
}

export interface ReferrerBonus {
  readonly referrer: string;
  readonly amount: bigint;
  /** referral-page ticket 04: what `amount` would be without the
   *  own-Principal cap (`remainingGrantCap`), with the pool-wide scale-down
   *  in `computeBonuses` still applied to it the same way. Equal to `amount`
   *  whenever the own-Principal cap doesn't bind. */
  readonly uncapped: bigint;
  readonly qualifiedCount: number;
  readonly rateBps: number;
}

function rateBpsFor(qualifiedCount: number): number {
  return RATE_TIERS.find((tier) => qualifiedCount >= tier.min)?.rateBps ?? 0;
}

/**
 * The most a referrer can still receive this epoch: their own Principal
 * minus whatever the operator path has already granted them today, floored
 * at 0. Mirrors `grant_tickets`' own operator-path check
 * (`player.bonus_granted + amount <= player.principal`, i.e.
 * `amount <= principal - bonus_granted`), so this same function both caps a
 * fresh computation and re-clamps an already-recorded grant against a
 * Principal that has moved since it was written.
 */
export function remainingGrantCap(principal: bigint, alreadyGrantedToday: bigint): bigint {
  const headroom = principal - alreadyGrantedToday;
  return headroom > 0n ? headroom : 0n;
}

/** One referrer's bonus before the pool-wide cap scales it down. `uncapped`
 *  is the raw basis*rate figure, i.e. `amount` before `remainingGrantCap`
 *  clamps it. */
function preScaleBonus(input: ReferrerBonusInput): ReferrerBonus {
  const qualifiedCount = input.qualifiedReferralPrincipals.length;
  const rateBps = rateBpsFor(qualifiedCount);
  if (rateBps === 0) {
    return { referrer: input.referrer, amount: 0n, uncapped: 0n, qualifiedCount, rateBps };
  }
  const cap = remainingGrantCap(input.principal, input.alreadyGrantedToday);
  const basis = input.qualifiedReferralPrincipals.reduce(
    (sum, principal) =>
      sum + (principal < REFERRAL_BONUS_BASIS_CAP ? principal : REFERRAL_BONUS_BASIS_CAP),
    0n,
  );
  const raw = (basis * BigInt(rateBps)) / 10_000n;
  const amount = raw < cap ? raw : cap;
  return { referrer: input.referrer, amount, uncapped: raw, qualifiedCount, rateBps };
}

/**
 * Every referrer's daily bonus (docs/plan/hexo-referrals ticket 08): each
 * one's own cap first, then a single pool-wide pro-rata scale-down (floored)
 * when the sum would exceed `totalPrincipal * capBps / 10_000` minus
 * `alreadyGrantedThisEpoch` (beta-launch-fixes ticket 11): the pool-wide cap
 * is shared across the whole epoch, not recomputed fresh on every call, so a
 * referrer who first qualifies late in the day is scaled against whatever
 * headroom the epoch's earlier grants left rather than the full cap, which
 * used to let a late batch compute an amount the on-chain call then refused
 * outright. A referrer whose bonus comes out to 0, before or after scaling,
 * is left out of the result: `grant_tickets` refuses a zero amount.
 */
export function computeBonuses(
  referrers: readonly ReferrerBonusInput[],
  totalPrincipal: bigint,
  capBps: number,
  alreadyGrantedThisEpoch: bigint = 0n,
): ReferrerBonus[] {
  const preScaled = referrers.map(preScaleBonus).filter((bonus) => bonus.amount > 0n);
  if (preScaled.length === 0) return [];

  const sum = preScaled.reduce((total, bonus) => total + bonus.amount, 0n);
  const poolCap = (totalPrincipal * BigInt(capBps)) / 10_000n;
  const headroom = poolCap - alreadyGrantedThisEpoch;
  const cap = headroom > 0n ? headroom : 0n;
  if (sum <= cap) return preScaled;

  // Same cap/sum factor applied to `uncapped` as to `amount`, so a referrer
  // whose own-Principal cap didn't bind (uncapped === amount pre-scale)
  // still reads uncapped === amount after this scale-down too.
  return preScaled
    .map((bonus) => ({
      ...bonus,
      amount: (bonus.amount * cap) / sum,
      uncapped: (bonus.uncapped * cap) / sum,
    }))
    .filter((bonus) => bonus.amount > 0n);
}

/** One entry `splitShares` divides a grant across: `weight` is the basis it
 *  gets its proportional cut from. */
export interface ShareWeight {
  readonly referee: string;
  readonly weight: bigint;
}

export interface RefereeShare {
  readonly referee: string;
  readonly amount: bigint;
}

/**
 * referral-page ticket 05: splits `grantAmount` across `weights` in
 * proportion to each entry's own `weight`, floored, with the leftover atomic
 * units (`grantAmount` minus the floor sum) handed out one each by largest
 * remainder, so the shares always sum exactly to `grantAmount`. Ties break by
 * `referee` ascending, for a deterministic order. Returns 0 for every entry
 * when `grantAmount` or the total weight is 0 (or negative).
 *
 * The indexer's grant-time call weighs each qualified referee by their own
 * basis (min(Principal, REFERRAL_BONUS_BASIS_CAP)); its re-clamp call reuses
 * this with each existing share's own amount as the weight, so a later
 * shrink (the referrer's own-Principal cap tightening) keeps the same
 * proportions instead of re-deriving them from Principal data that may have
 * moved again since the shares were first written.
 */
export function splitShares(
  grantAmount: bigint,
  weights: readonly ShareWeight[],
): RefereeShare[] {
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0n);
  if (grantAmount <= 0n || totalWeight <= 0n) {
    return weights.map((w) => ({ referee: w.referee, amount: 0n }));
  }

  const floors = weights.map((w) => {
    const numerator = grantAmount * w.weight;
    return { referee: w.referee, amount: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  let leftover = grantAmount - floors.reduce((sum, f) => sum + f.amount, 0n);

  const byLargestRemainder = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.referee < b.referee ? -1 : a.referee > b.referee ? 1 : 0;
  });
  const amounts = new Map(floors.map((f) => [f.referee, f.amount]));
  for (const f of byLargestRemainder) {
    if (leftover <= 0n) break;
    amounts.set(f.referee, (amounts.get(f.referee) ?? 0n) + 1n);
    leftover -= 1n;
  }
  return weights.map((w) => ({ referee: w.referee, amount: amounts.get(w.referee) ?? 0n }));
}

export interface ReferralBand {
  readonly tier: number;
  readonly rateBps: number;
  readonly minCount: number;
  /** Null at the top tier (11+), which has no upper bound. */
  readonly maxCount: number | null;
}

/** Tier 0: no rate yet, below the first tier's minimum of 1. */
const NO_BAND: ReferralBand = { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 };

/**
 * The tier `qualifiedCount` referrals sits in, and the next, higher tier
 * (null at the top tier, 11+); spec.md "Referrals API response" `band` /
 * `nextBand`. Tier 0 means no rate yet (0 qualified referrals).
 */
export function bandForCount(
  qualifiedCount: number,
): { band: ReferralBand; nextBand: ReferralBand | null } {
  // RATE_TIERS is ordered highest-min-first, so the first match is the
  // current tier.
  const current = RATE_TIERS.find((tier) => qualifiedCount >= tier.min);
  const band: ReferralBand = current
    ? { tier: current.tier, rateBps: current.rateBps, minCount: current.min, maxCount: current.max }
    : NO_BAND;

  // The next band up is the smallest min still greater than the current
  // count, found by scanning from the low end.
  const next = [...RATE_TIERS].reverse().find((tier) => tier.min > qualifiedCount);
  const nextBand: ReferralBand | null = next
    ? { tier: next.tier, rateBps: next.rateBps, minCount: next.min, maxCount: next.max }
    : null;

  return { band, nextBand };
}
