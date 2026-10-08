export type Tab =
  | "HOME"
  | "MINE"
  | "DASHBOARD"
  | "VAULT"
  | "DAILY DRAW"
  | "LEADERBOARD"
  | "REFERRALS"
  | "ABOUT";

/**
 * Navbar items: the desktop long label and the phone short label. Only EARN,
 * PLAY, INVITE and ABOUT show; the other tabs stay routable (HOME via the
 * logomark, the rest via the URL hash below) but unlisted.
 *
 * EARN lands on the DASHBOARD, not the deposit widget: the widget is one hop
 * further in, behind the dashboard's own Deposit / Withdraw buttons, so there
 * is a single way into the money path.
 */
export const TABS = [
  { id: "DASHBOARD", long: "EARN", short: "EARN" },
  { id: "MINE", long: "PLAY", short: "PLAY" },
  { id: "REFERRALS", long: "INVITE", short: "INVITE" },
  { id: "ABOUT", long: "ABOUT", short: "ABOUT" },
] as const satisfies readonly { id: Tab; long: string; short: string }[];

/** URL hash → tab, so `/#play` opens the hex page directly (e2e specs rely on it). */
const HASH_TABS: Record<string, Tab> = {
  home: "HOME",
  play: "MINE",
  earn: "DASHBOARD",
  deposit: "VAULT",
  draw: "DAILY DRAW",
  ranks: "LEADERBOARD",
  referrals: "REFERRALS",
  about: "ABOUT",
};

export function tabFromHash(hash: string): Tab {
  return HASH_TABS[hash.replace(/^#/, "").toLowerCase()] ?? "HOME";
}

/** The inverse of `HASH_TABS`: what to write to the URL when `tab` changes,
 *  so back/forward (`hashchange`) can round-trip through `tabFromHash`. */
const TAB_HASHES: Record<Tab, string> = Object.fromEntries(
  Object.entries(HASH_TABS).map(([hash, tab]) => [tab, hash]),
) as Record<Tab, string>;

export function hashForTab(tab: Tab): string {
  return `#${TAB_HASHES[tab]}`;
}

/**
 * PLAY's lock state: `aria-disabled` (not `disabled`, so it stays hoverable
 * for the `data-tip` tooltip) plus the tooltip copy, or `null` when the tab
 * is clickable. The game gate wins over the zero-Tickets lock (ticket 01,
 * feature-gates): "Coming soon" shows even with tickets in hand.
 */
export function playLock(
  gameGated: boolean,
  tickets: bigint,
): { tip: string } | null {
  if (gameGated) return { tip: "Coming soon" };
  if (tickets === 0n) return { tip: "Deposit first to play" };
  return null;
}
