/**
 * What the page does with each alert and todo code: how loud it is, which
 * button clears it, and where its playbook is. Severity and buttons live here,
 * not in the backend (ops-console-ux spec). The anchors are placed in
 * docs/ops/incidents.md; `opsMap.test.ts` checks every code has one.
 */
import type { AlertDto, TodoCode, TodoItem } from "../api.js";

/** The backend's `AlertCode` in alerts.controller.ts; the test keeps the two in step. */
export const ALERT_CODES = [
  "OPERATOR_SOL_LOW",
  "OPERATOR_STALE",
  "RPC_DOWN",
  "RPC_FALLBACK_ACTIVE",
  "INDEXER_STALE",
  "WITHDRAW_SHORTFALL",
  "EPOCH_ROLLED_OVER_RECENTLY",
  "WITHDRAW_OWNERS_SKIPPED",
  "OPERATOR_SOL_READ_FAILED",
  "OPERATOR_FAILING",
  "EPOCH_NO_PROGRESS",
  "DRAWN_UNPAID",
  "SPARRING_SOL_LOW",
  "JACKPOT_LOW_NEAR_CLOSE",
  "WITHDRAW_FORECAST_SHORT",
  "SOLVENCY_NEGATIVE",
  "FREE_IDLE_LOW",
  "RESERVE_LIQUIDITY_LOW",
  "POOL_IMPAIRED",
  "DEPLOY_PAUSED",
  "VENUE_PROPOSED",
  "PARAMS_CHANGED",
  "TICKET_LEDGER_MISMATCH",
  "SNAPSHOT_MISMATCH",
  "ROUND_SETTLE_FAILED",
  "SNAPSHOT_NEAR_CAP",
  "EVENT_LOG_TRUNCATED",
] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

/** A button on the page. Its element id is `ops-action-<action>`. */
export type OpsAction =
  | "deploy"
  | "recall"
  | "harvest"
  | "withdraw"
  | "cover"
  | "rollover"
  | "venueSwitch"
  | "fundJackpot"
  | "setVenueParams"
  | "pause-deploy";

export type Severity = "red" | "amber";

export interface OpsEntry {
  severity: Severity;
  /** The button that clears it; null when the fix is outside the page. */
  action: OpsAction | null;
}

const RED = (action: OpsAction | null = null): OpsEntry => ({ severity: "red", action });
const AMBER = (action: OpsAction | null = null): OpsEntry => ({ severity: "amber", action });

export const OPS_MAP: Record<AlertCode | TodoCode, OpsEntry> = {
  OPERATOR_SOL_LOW: AMBER(),
  OPERATOR_STALE: RED(),
  RPC_DOWN: RED(),
  RPC_FALLBACK_ACTIVE: AMBER(),
  INDEXER_STALE: RED(),
  WITHDRAW_SHORTFALL: RED("recall"),
  EPOCH_ROLLED_OVER_RECENTLY: AMBER(),
  WITHDRAW_OWNERS_SKIPPED: AMBER("withdraw"),
  OPERATOR_SOL_READ_FAILED: AMBER(),
  OPERATOR_FAILING: RED(),
  EPOCH_NO_PROGRESS: RED("rollover"),
  DRAWN_UNPAID: RED(),
  SPARRING_SOL_LOW: AMBER(),
  JACKPOT_LOW_NEAR_CLOSE: AMBER("fundJackpot"),
  WITHDRAW_FORECAST_SHORT: AMBER("recall"),
  SOLVENCY_NEGATIVE: RED(),
  FREE_IDLE_LOW: AMBER("recall"),
  RESERVE_LIQUIDITY_LOW: AMBER("pause-deploy"),
  POOL_IMPAIRED: RED("cover"),
  DEPLOY_PAUSED: AMBER("pause-deploy"),
  VENUE_PROPOSED: AMBER(),
  PARAMS_CHANGED: AMBER(),
  TICKET_LEDGER_MISMATCH: AMBER(),
  SNAPSHOT_MISMATCH: AMBER(),
  ROUND_SETTLE_FAILED: AMBER(),
  SNAPSHOT_NEAR_CAP: AMBER(),
  EVENT_LOG_TRUNCATED: AMBER(),
  DEPLOY_DUE: AMBER("deploy"),
  RECALL_DUE: AMBER("recall"),
  HARVEST_DUE: AMBER("harvest"),
  WITHDRAWS_DUE: AMBER("withdraw"),
  STUCK_EPOCH: AMBER("rollover"),
  DEFICIT_OPEN: AMBER("cover"),
  VENUE_LOCK_ELAPSED: AMBER("venueSwitch"),
};

/** An unknown code from a newer backend still shows, amber and without a button. */
export const entryOf = (code: string): OpsEntry =>
  (OPS_MAP as Record<string, OpsEntry | undefined>)[code] ?? AMBER();

export const PLAYBOOK_URL = "https://github.com/easonchai/HexVault/blob/main/docs/ops/incidents.md";

/** "OPERATOR_STALE" to "operator-stale", the id placed in incidents.md. */
export const playbookAnchor = (code: string): string => code.toLowerCase().replaceAll("_", "-");

export const playbookHref = (code: string): string => `${PLAYBOOK_URL}#${playbookAnchor(code)}`;

export interface BannerLine {
  code: string;
  message: string;
  severity: Severity;
  action: OpsAction | null;
  /** The code whose playbook section the line links; defaults to `code`. */
  playbook?: string;
}

export interface Banner {
  state: "green" | Severity;
  /** Red alerts, then amber alerts, then todos due now. */
  lines: BannerLine[];
  /** Due, but the bot will do it on its next tick. Not counted against green. */
  bot: TodoItem[];
}

/**
 * `chainRead` false means the backend's chain read failed, so the todo list
 * may be missing items: the banner says so rather than reading green.
 */
export function bannerOf(alerts: readonly AlertDto[], todo: readonly TodoItem[], chainRead = true): Banner {
  const alertLines = alerts.map((a) => ({ code: a.code, message: a.message, ...entryOf(a.code) }));
  const lines: BannerLine[] = [
    ...alertLines.filter((l) => l.severity === "red"),
    ...alertLines.filter((l) => l.severity === "amber"),
    ...todo
      .filter((t) => t.due === "now")
      .map((t) => ({ code: t.code, message: t.message, ...entryOf(t.code) })),
    ...(chainRead
      ? []
      : [
          {
            code: "CHAIN_UNREAD",
            message: "The backend could not read the chain, so this list may be missing items.",
            severity: "amber" as const,
            action: null,
            playbook: "RPC_DOWN",
          },
        ]),
  ];
  const state = lines.some((l) => l.severity === "red") ? "red" : lines.length > 0 ? "amber" : "green";
  return { state, lines, bot: todo.filter((t) => t.due === "bot") };
}

/** The todos due now that name `action`: lights its button and pre-fills its field. */
export const dueFor = (todo: readonly TodoItem[], action: OpsAction): TodoItem | undefined =>
  todo.find((t) => t.due === "now" && entryOf(t.code).action === action);

/**
 * Scrolls to and focuses a button, opening any collapsed `<details>` it sits
 * in (Details, Advanced) first.
 */
export function goToAction(action: OpsAction): void {
  const el = document.getElementById(`ops-action-${action}`);
  if (!el) return;
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  });
}
