import type { EpochState, PoolState } from "../operator/chain-state";
import {
  decideVenue,
  drainAmount,
  EMPTY_VENUE_STATE,
  nextHarvestAt,
  venueFailed,
  venueSucceeded,
  venueUnlocksAt,
  type VenueProposalState,
  type VenueState,
} from "../operator/venue";
import type { Stuck } from "./ops-summary";

export type TodoCode =
  | "DEPLOY_DUE"
  | "RECALL_DUE"
  | "HARVEST_DUE"
  | "WITHDRAWS_DUE"
  | "STUCK_EPOCH"
  | "DEFICIT_OPEN"
  | "VENUE_LOCK_ELAPSED";

/** One action due on the pool. `amount`, `owner` and `id` are what the matching
 *  console button needs: atomic USDC, a wallet, an epoch id. */
export interface TodoItem {
  code: TodoCode;
  message: string;
  /** "now": a person acts. "bot": the Operator does it on its next tick. */
  due: "now" | "bot";
  amount?: bigint;
  owner?: string;
  id?: bigint;
}

type TodoDraft = Omit<TodoItem, "due">;

/** The bot never rolls over, covers or migrates on its own. */
const ALWAYS_NOW: ReadonlySet<TodoCode> = new Set([
  "STUCK_EPOCH",
  "DEFICIT_OPEN",
  "VENUE_LOCK_ELAPSED",
]);

export interface TodoInput {
  /** The pool and clock read from the chain; null before the pool is indexed or when the read failed. */
  chain: { pool: PoolState; currentEpoch: EpochState | null; now: bigint } | null;
  /** The principal vault's balance; null when the read failed. */
  vaultBalance: bigint | null;
  proposal: VenueProposalState | null;
  /** A Harvest already landed inside the current epoch's pre-end window. */
  harvestedThisWindow: boolean;
  stuck: Stuck | null;
  deficit: bigint;
  /** Pending withdrawals whose epoch has ended, oldest first. */
  dueWithdrawals: readonly { owner: string; amount: bigint }[];
}

/**
 * Every action due on the pool, from the Operator's own rules: `decideVenue`
 * for deploy, recall and harvest, `drainAmount` for the drain or migrate after
 * a proposal's lock, `findStuck`'s output for the recovery crank. Pure, so
 * each rule is a direct unit test. `due` is set later by `TodoClock`.
 */
export function todoDrafts(input: TodoInput): TodoDraft[] {
  const { chain, vaultBalance, proposal, stuck } = input;
  const drafts: TodoDraft[] = [];

  if (stuck?.epoch) {
    drafts.push({ code: "STUCK_EPOCH", message: `Epoch ${stuck.epoch.id} is stuck. Roll it over.`, id: stuck.epoch.id });
  }
  if (input.deficit > 0n) {
    drafts.push({ code: "DEFICIT_OPEN", message: "The pool has an open deficit. Cover it.", amount: input.deficit });
  }

  if (chain !== null) {
    const { pool, currentEpoch, now } = chain;
    if (proposal !== null && now >= venueUnlocksAt(proposal)) {
      const drain = drainAmount(pool, proposal, null, now);
      drafts.push({
        code: "VENUE_LOCK_ELAPSED",
        message: `The venue proposal's lock has passed. ${drain === null ? "Migrate" : "Drain"} is next.`,
        ...(drain === null ? {} : { amount: drain }),
      });
    }

    if (vaultBalance !== null) {
      let state: VenueState =
        input.harvestedThisWindow && currentEpoch !== null
          ? { harvestedEpoch: currentEpoch.epochId, failedAt: {} }
          : EMPTY_VENUE_STATE;
      // `decideVenue` names one crank. Mark each one handled and ask again to
      // list the others: harvest, then recall, then deploy.
      for (let i = 0; i < 3; i++) {
        const crank = decideVenue({ pool, vaultBalance, now, currentEpoch, state, proposal, venueAvailable: null });
        if (crank === null || crank.kind === "drain" || crank.kind === "migrate") break;
        if (crank.kind === "harvest") {
          const opened = nextHarvestAt(currentEpoch, state);
          drafts.push({
            code: "HARVEST_DUE",
            message: `Harvest epoch ${currentEpoch?.epochId}: its window opened ${opened === null ? 0n : (now - opened) / 60n} min ago.`,
            ...(currentEpoch === null ? {} : { id: currentEpoch.epochId }),
          });
          state = venueSucceeded(state, "harvest", currentEpoch?.epochId ?? null);
        } else {
          drafts.push(
            crank.kind === "deploy"
              ? { code: "DEPLOY_DUE", message: "Idle USDC is above the target band. Deploy it to the venue.", amount: crank.amount }
              : {
                  code: "RECALL_DUE",
                  message: pool.shutdown
                    ? "The pool is shut down. Recall the venue position."
                    : "Free idle is under the floor. Recall USDC from the venue.",
                  amount: crank.amount,
                },
          );
          state = venueFailed(state, crank.kind, now);
        }
      }
    }
  }

  const [first] = input.dueWithdrawals;
  if (first) {
    drafts.push({
      code: "WITHDRAWS_DUE",
      message: `${input.dueWithdrawals.length} withdrawal(s) are past their epoch and unpaid, the first for ${first.owner}.`,
      amount: input.dueWithdrawals.reduce((sum, entry) => sum + entry.amount, 0n),
      owner: first.owner,
    });
  }
  return drafts;
}

/**
 * Sets `due`. Recovery codes are always "now". The rest are "bot" until the
 * Operator is down (the `/alerts` stale or failing rules) or the condition has
 * held longer than `tickStaleSeconds`, the time the bot had to act.
 *
 * The hold clock is in memory, like `AlertsController.idleLowSince`: a restart
 * restarts it, which delays "now" by one window. ponytail: persist it if
 * restarts during a real outage turn out to matter.
 */
export class TodoClock {
  private since = new Map<TodoCode, number>();

  mark(
    drafts: readonly TodoDraft[],
    opts: { operatorDown: boolean; nowSeconds: number; tickStaleSeconds: number },
  ): TodoItem[] {
    const next = new Map<TodoCode, number>();
    const items = drafts.map((draft): TodoItem => {
      if (ALWAYS_NOW.has(draft.code)) return { ...draft, due: "now" };
      const since = this.since.get(draft.code) ?? opts.nowSeconds;
      next.set(draft.code, since);
      const held = opts.nowSeconds - since > opts.tickStaleSeconds;
      return { ...draft, due: opts.operatorDown || held ? "now" : "bot" };
    });
    this.since = next;
    return items;
  }
}
