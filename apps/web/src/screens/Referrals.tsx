/**
 * REFERRALS tab (referral-page ticket 01): the Figma "Invite Page" (`204:12137`)
 * rebuilt one card per Figma frame. Ticket 01 built the hero (`204:12172`)
 * and the page shell; the row below it holds the Bonus Rate (`230:16970`,
 * ticket 03) and Referral's Bonus (`230:17196`, ticket 04) cards side by
 * side. Ticket 05 built Your Team (`204:12548`, `YourTeamCard` below), full
 * width beneath that row. Ticket 06 built the FAQ (`204:12299` collapsed /
 * `171:28875` open) that follows, shared with About.tsx via ../Faq.js.
 *
 * Logic lives in referrals.ts (the pure hero view-model) and useReferrals.ts
 * (the poll and the copy flow); this file only reads them, mirroring
 * screens/Vault.tsx's split from useAccessGate.ts.
 */
import type { PublicKey } from "@solana/web3.js";

import type { ReferralItemDto } from "../api.js";
import { BonusRateCard } from "../BonusRateCard.js";
import { Faq, type FaqItem } from "../Faq.js";
import { InfoTip } from "../InfoTip.js";
import {
  bonusRateView,
  referralBonusCardState,
  referralHeroState,
  teamRowView,
  type ReferralBonusCardState,
  type ReferralHeroState,
} from "../referrals.js";
import { useReferrals } from "../useReferrals.js";

export interface ReferralsScreenProps {
  owner: PublicKey | null;
  onConnect: () => void;
  /** DEPOSIT goes to EARN (spec.md Copy), never straight to the Vault widget
   *  — TABS.ts's comment on DASHBOARD: one way into the money path. */
  onDeposit: () => void;
}

/** spec.md Copy, "Hero tooltip" (Figma tooltip `230:17717`). */
const HERO_TIP = [
  "Share this code to build your team.",
  "When friends sign up and deposit $50+, you unlock daily bonus draw tickets and a 2% win-share whenever they win.",
] as const;

/**
 * spec.md Copy, "FAQ answers": verbatim from Figma `171:28875`, except
 * answer 1's "plus 2% Win-Share" (the "2%" was missing in Figma). Answer 2
 * keeps its lettered list; the rest, answer 4's "•" tiers included, are
 * plain text with a literal blank line where Figma's text had one, rendered
 * by styles.css's `white-space: pre-line`.
 */
const REFERRAL_FAQ: readonly FaqItem[] = [
  {
    q: "How does the referral system work?",
    a: "When friends join HEXO using your invite link, you form a team. For every qualified friend who deposits and saves, you earn daily bonus tickets entering the main daily prize draw, plus 2% Win-Share paid in $HEXO whenever they win.",
  },
  {
    q: 'What makes a referral "qualified"?',
    a: (
      <>
        <p>To become qualified, your friend must:</p>
        <ol>
          <li>Deposit at least $50.</li>
          <li>Hold that balance continuously for 7 days.</li>
        </ol>
        <p>
          Once qualified, they count toward your bonus rate starting from the very next daily
          draw. As long as their balance stays above $50, they generate bonus tickets for you.
        </p>
      </>
    ),
  },
  {
    q: "What happens if my referral withdraws below $50?",
    a: "If a referral drops below $50, they stop counting immediately—both for your bonus rate and your daily bonus ticket.\n\nIf they top back up to $50+, they will re-qualify after completing the continuous 7-day holding period.",
  },
  {
    q: "How are bonus rates calculated?",
    a: "Referral bonus rates are awarded in tiers based on your number of qualified team members:\n\n• 1–2 friends: 2%\n• 3–5 friends: 3%\n• 6–10 friends: 4%\n• 11+ friends: 5%",
  },
  {
    q: "Do referral bonus tickets accumulate?",
    a: "No. Bonus tickets are calculated for each daily draw and expire with that draw. They do not roll over.",
  },
  {
    q: "Do tickets won from the Hex Board count toward referral bonuses?",
    a: "No. Referral bonus tickets are calculated strictly from your friends' savings deposit tickets ($1 deposited = 1 ticket).",
  },
  {
    q: "What happens when someone in my team wins?",
    a: "You receive 2% of their prize value in $HEXO, auto-staked. Their prize amount is not reduced.",
  },
  {
    q: "Why doesn't the referral bonus dilute the draw unfairly?",
    a: "Referral bonus tickets are funded from the overall ticket pool dynamics rather than directly drawn from other participants' shares.\n\nThe overall pot grows alongside the tickets, meaning larger prizes for everyone rather than a thinner slice.",
  },
] as const;

/** spec.md Copy, "Referral's Bonus tooltip". */
const REFERRAL_BONUS_TIP = [
  "Bonus tickets earned for today's draw.",
  "• Calculated from qualified referral deposit tickets (capped at $2,500 per friend).\n• Expire after each 24h draw and do not roll over.\n• You cannot earn more bonus tickets than your own deposit tickets.",
] as const;

/** spec.md Copy, "Your Team tooltip". */
const YOUR_TEAM_TIP = [
  "Friends you've onboarded.",
  "Once a member holds $50+ for 7 continuous days, they actively generate daily bonus tickets for your account (capped at $2,500 deposit per member).",
] as const;

export function Referrals({ owner, onConnect, onDeposit }: ReferralsScreenProps) {
  const walletKey = owner?.toBase58();
  const referrals = useReferrals(walletKey);
  const hero = referralHeroState(walletKey, referrals.data);
  const copied = hero.kind === "has-code" && referrals.copiedCode === hero.code;
  const bonus = referralBonusCardState(walletKey, referrals.data);

  return (
    <div className="referrals-page" data-testid="referrals-screen">
      <div className="referrals-content">
        <ReferralHero
          state={hero}
          copied={copied}
          onCopy={() => {
            if (hero.kind === "has-code") referrals.copyLink(hero.code);
          }}
          onConnect={onConnect}
        />

        <div className="referrals-row">
          <BonusRateCard state={bonusRateView(walletKey, referrals.data)} />
          <ReferralBonusCard state={bonus} onDeposit={onDeposit} />
        </div>
        <YourTeamCard items={referrals.data?.referrals.items ?? []} />
        <ReferralFaq />

        {/* Disconnected always polls to "no wallet connected" (useReferrals.ts);
            the hero's own CONNECT action already says that, so only a real
            fetch failure while connected is worth a banner. */}
        {walletKey && referrals.error ? (
          <p className="screen-note err" data-testid="referrals-error">
            {referrals.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReferralHero({
  state,
  copied,
  onCopy,
  onConnect,
}: {
  state: ReferralHeroState;
  copied: boolean;
  onCopy: () => void;
  onConnect: () => void;
}) {
  return (
    <section className="referral-hero" aria-label="Invite your team">
      {/* Clips the background image + glow to the card's rounded corners.
          Separate from the card itself (which stays overflow: visible) so
          the InfoTip bubble below can overflow the card, per spec.md. */}
      <div className="referral-hero-bgclip" aria-hidden="true">
        <img className="referral-hero-bg" src="/referrals/hero-gift.webp" alt="" width={444} height={415} />
        <img className="referral-hero-glow" src="/referrals/hero-glow.webp" alt="" width={183} height={184} />
      </div>

      <div className="referral-hero-copy">
        <h1 className="referral-hero-title">
          We save,
          <br />
          we win.
        </h1>
        <p className="referral-hero-lead">
          Boost your daily tickets together. Earn ongoing bonus tickets on their savings plus a
          2% win-share—with zero deductions from their balance.
        </p>
      </div>

      <div className="referral-hero-stats">
        <div className="referral-stat">
          <span className="referral-stat-value">5%</span>
          <span className="referral-stat-label">Max Daily Boost</span>
        </div>
        <div className="referral-stat">
          <span className="referral-stat-value">2%</span>
          <span className="referral-stat-label">Team Win-Share</span>
        </div>
      </div>

      <div className="referral-hero-invite">
        <div className="referral-hero-invite-head">
          <h2 className="referral-hero-invite-title">Invite your team</h2>
          <InfoTip id="referral-hero-tip" paragraphs={HERO_TIP} />
        </div>
        <div className="referral-code-field" data-testid="referral-code-field">
          {state.kind === "disconnected" ? (
            <>
              <span className="referral-code-placeholder">
                Connect your wallet to get your code
              </span>
              <button
                type="button"
                className="referral-pill-btn"
                data-testid="referrals-connect"
                onClick={onConnect}
              >
                CONNECT
              </button>
            </>
          ) : state.kind === "no-code" ? (
            <span className="referral-code-placeholder">Getting your code…</span>
          ) : (
            <>
              <span className="referral-code-value" data-testid="referral-code">
                {state.code}
              </span>
              <button
                type="button"
                className="referral-pill-btn"
                data-testid="referrals-copy"
                onClick={onCopy}
              >
                {copied ? "COPIED" : "COPY"}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Your Team table (referral-page ticket 05; Figma `204:12548`). Full width,
 * below `.referrals-row`. The "→ View all draws" link in the Figma frame is
 * not rendered (spec.md). The phone breakpoint drops the JOINED column via
 * `.your-team-col-joined` (styles.css).
 */
function YourTeamCard({ items }: { items: readonly ReferralItemDto[] }) {
  const rows = items.map(teamRowView);

  return (
    <section className="your-team-card" aria-label="Your team" data-testid="your-team-card">
      <div className="your-team-head">
        <h2 className="your-team-title">Your team</h2>
        <InfoTip id="your-team-tip" paragraphs={YOUR_TEAM_TIP} />
      </div>

      {rows.length === 0 ? (
        <p className="your-team-empty" data-testid="your-team-empty">
          No referrals yet. Share your code above to start your team.
        </p>
      ) : (
        <div className="your-team-table" data-testid="your-team-table">
          <div className="your-team-row your-team-row-head" aria-hidden="true">
            <span>REFERRALS</span>
            <span>STATUS</span>
            <span>BONUS TICKETS</span>
            <span className="your-team-col-joined">JOINED</span>
          </div>
          {rows.map((row, index) => (
            <div className="your-team-row" key={`${row.wallet}-${index}`}>
              <span className="your-team-wallet">{row.wallet}</span>
              <span className={`your-team-pill your-team-pill-${row.status}`}>
                {row.statusLabel}
              </span>
              <span
                className={`your-team-bonus${row.bonus > 0 ? " your-team-bonus-nonzero" : ""}`}
              >
                {row.bonus > 0 ? `+${row.bonus}` : "0"}
              </span>
              <span className="your-team-joined your-team-col-joined">{row.joined}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** FAQ card (Figma `204:12299` collapsed / `171:28875` open copy). */
function ReferralFaq() {
  return (
    <section className="referral-faq" aria-label="FAQ">
      <h2 className="referral-faq-title">FAQ</h2>
      <div className="referral-faq-list" data-testid="referral-faq">
        <Faq items={REFERRAL_FAQ} itemClassName="referral-faq-item" numbered />
      </div>
    </section>
  );
}

/**
 * Referral's Bonus card (referral-page ticket 04; Figma `230:17196` for the
 * card, `230:17195` for its two states). The capped state's DEPOSIT button
 * goes to EARN, same as the hero's own `onDeposit`.
 */
function ReferralBonusCard({
  state,
  onDeposit,
}: {
  state: ReferralBonusCardState;
  onDeposit: () => void;
}) {
  return (
    <section className="referral-bonus-card" aria-label="Referral's bonus">
      <div className="referral-bonus-head">
        <h2 className="referral-bonus-title">Referral's bonus</h2>
        <InfoTip id="referral-bonus-tip" paragraphs={REFERRAL_BONUS_TIP} />
      </div>

      <div className="referral-bonus-amount-block">
        <p className="referral-bonus-amount" data-testid="referral-bonus-amount">
          {state.kind === "disconnected" ? (
            "—"
          ) : state.kind === "capped" ? (
            <>
              {`+${state.amount}`}
              <span className="referral-bonus-amount-uncapped">{`/${state.uncapped}`}</span>
            </>
          ) : (
            `+${state.amount}`
          )}
        </p>
        <p className="referral-bonus-caption">Bonus tickets for today's draw</p>
      </div>

      {state.kind === "capped" ? (
        <>
          <p className="referral-bonus-hint" data-testid="referral-bonus-hint">
            {`Deposit $${state.hintUsdc} more to unlock all ${state.uncapped} bonus tickets in the next draw.`}
          </p>
          <button
            type="button"
            className="referral-bonus-deposit"
            data-testid="referral-bonus-deposit"
            onClick={onDeposit}
          >
            DEPOSIT
          </button>
        </>
      ) : null}
    </section>
  );
}
