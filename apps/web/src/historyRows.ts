/**
 * Account History rows: `GET /feed?owner=` events → what the Dashboard lists.
 * Split out of `screens/Dashboard.tsx` so a test can import it without the
 * screen's wallet and CSS imports.
 */
import type { EventDto } from "./api.js";
import { eventKey } from "./chain.js";
import { formatMoney2 } from "./lib/money.js";

const DECIMALS = 6;

/** Atomic (6dp) string → "$2,423.55". */
export const dollars = (atomic: string) =>
  `$${formatMoney2(BigInt(atomic.replace(/[^0-9]/g, "") || "0"), DECIMALS)}`;

/** An event's atomic field as a bigint; absent reads as 0. */
const atomicField = (data: Record<string, unknown>, name: string): bigint =>
  BigInt(String(data[name] ?? "0").replace(/[^0-9]/g, "") || "0");

export interface HistoryRow {
  key: string;
  label: string;
  signature: string;
  amount: string;
  blockTime: string | null;
  /** Prize rows read lime across the row; deposits and withdrawals do not. */
  prize: boolean;
}

/**
 * The event kinds that touch a Player's USDC or queue. Everything else the
 * feed carries (positions, rounds, rollovers) belongs to the game, not the
 * money path, so it is dropped rather than shown with a blank amount. One
 * event can give two rows, so this returns a list.
 */
export function toHistoryRows(row: EventDto): HistoryRow[] {
  const data = row.data ?? {};
  const amount = dollars(String(data.amount ?? "0"));
  const key = `${row.slot}-${row.signature}-${row.index}`;
  const base = { signature: row.signature, blockTime: row.blockTime, prize: false };
  switch (eventKey(row.name)) {
    case "deposited":
      return [{ ...base, key, label: "Deposit", amount: `+ ${amount}` }];
    case "withdrawn":
      return [{ ...base, key, label: "Withdraw", amount: `- ${amount}` }];
    // A request pays its pending-deposit part at once (ADR 0020) and queues
    // the rest. The queued part reads "requested" here, then as Withdraw when
    // `process_withdraw` moves it. `pending` is the Player's whole queue, not
    // this request's share, so the queued part is `amount - refunded`.
    case "withdrawRequested": {
      const rows: HistoryRow[] = [];
      const paid = atomicField(data, "paid");
      if (paid > 0n) {
        rows.push({ ...base, key: `${key}-refund`, label: "Refund", amount: `- ${dollars(paid.toString())}` });
      }
      const queued = atomicField(data, "amount") - atomicField(data, "refunded");
      if (queued > 0n) {
        rows.push({ ...base, key: `${key}-requested`, label: "Withdraw requested", amount: dollars(queued.toString()) });
      }
      return rows;
    }
    // Nothing moved: the queue cleared and the money stayed in the vault.
    case "withdrawCancelled":
      return [{ ...base, key, label: "Withdraw cancelled", amount }];
    case "jackpotPaid":
      return [{ ...base, key, label: "Prize Win", amount, prize: true }];
    default:
      return [];
  }
}
