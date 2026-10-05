/**
 * Owns the Buy Tickets widget's state (ticket 10): the amount input, the
 * derived tickets/disabled-reason, and send-and-confirm. The
 * markup only reads what this returns, mirroring useAccessGate.ts.
 */
import { useCallback, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { awaitSendResult, buyTickets, type TxSigner } from "./actions.js";
import { buyDisabledReason, ticketsFromUsdc } from "./buyTickets.js";
import type { HexVaultProgram } from "./chain.js";
import { parseAtomic } from "./lib/money.js";
import { decodePlayerError, decodeSendFailure } from "./playerErrors.js";
import type { PoolLike } from "./read.js";

const DECIMALS = 6;

export interface UseBuyTicketsOptions {
  program: HexVaultProgram | null;
  owner: PublicKey | null;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  paused: boolean;
  /** ticket 11: `buy_tickets` refuses outright once the pool is shut down. */
  shutdown: boolean;
  principal: bigint;
  /** Null until `GET /players/:owner` has answered once. */
  allowanceLeft: bigint | null;
  onDone: () => void;
}

export interface BuyTicketsState {
  amountText: string;
  setAmountText: (text: string) => void;
  amount: bigint | null;
  tickets: bigint;
  allowanceLeft: bigint | null;
  /** Reason the button is disabled, or null when it can be pressed. */
  disabledReason: string | null;
  busy: boolean;
  error: string | null;
  canSubmit: boolean;
  submit: () => void;
}

export function useBuyTickets(options: UseBuyTicketsOptions): BuyTicketsState {
  const {
    program,
    owner,
    sendTransaction,
    pool,
    paused,
    shutdown,
    principal,
    allowanceLeft,
    onDone,
  } = options;
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = parseAtomic(amountText, DECIMALS);
  const tickets = amount !== null ? ticketsFromUsdc(amount, pool?.ticketsPerUsdc ?? 0) : 0n;

  // `allowanceLeft` lags behind `principal`/`paused`/`shutdown` (its own
  // slower poll), so "loading…" only shows for a depositor who is genuinely
  // waiting on it. Shutdown, paused and zero-Principal are already known from
  // the fast state poll, and short-circuit inside buyDisabledReason before
  // its allowance check runs.
  const disabledReason =
    owner === null
      ? "connect a wallet"
      : shutdown || paused || principal <= 0n || allowanceLeft !== null
        ? buyDisabledReason({ paused, shutdown, principal, allowanceLeft: allowanceLeft ?? 0n })
        : "loading…";

  const canSubmit =
    !busy &&
    disabledReason === null &&
    amount !== null &&
    amount > 0n &&
    allowanceLeft !== null &&
    amount <= allowanceLeft &&
    program !== null &&
    owner !== null &&
    pool !== null;

  const submit = useCallback(() => {
    if (!canSubmit || !program || !owner || !pool || amount === null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        let result = await buyTickets(program, { publicKey: owner, sendTransaction }, pool, amount);
        if (result.kind === "unknown") result = await awaitSendResult(program, result);
        if (result.kind !== "landed") {
          setError(decodeSendFailure(result));
          return;
        }
        setAmountText("");
        onDone();
      } catch (err) {
        setError(decodePlayerError(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [canSubmit, program, owner, pool, sendTransaction, amount, onDone]);

  return {
    amountText,
    setAmountText,
    amount,
    tickets,
    allowanceLeft,
    disabledReason,
    busy,
    error,
    canSubmit,
    submit,
  };
}
