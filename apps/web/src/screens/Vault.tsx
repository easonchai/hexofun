/**
 * VAULT tab: the Figma "Deposit" frame. One widget with DEPOSIT / WITHDRAW
 * tabs on the HOME halftone background. The program is the custody boundary.
 * WITHDRAW sends `request_withdraw` (ADR 0020): the part that is still a
 * pending deposit pays in the same transaction and the rest queues and pays
 * after the epoch ends (ADR 0009). The sheet previews that split from the
 * pending deposit (`splitWithdraw`). The pending row below the widget carries
 * the wait: the amount, about when it pays, and a "pay out now" button that
 * sends the permissionless `process_withdraw` when the operator has not.
 *
 * Ticket 07: `currentEpoch` comes from App's one `GET /state` poll instead
 * of a duplicate `/epochs/current` poll of its own; `onDone` tightens that
 * poll (see `useStatePoll.ts` `kick`) instead of triggering a chain re-read.
 *
 * Estimated yield is a year at the pool's base rate, shown as "~" because the
 * venue's real rate floats under that ceiling. Buy Tickets is hidden for
 * now; its markup was removed but buyTickets.ts and useBuyTickets.ts stay, so
 * bringing it back is markup only, behind `buyTicketsVisible`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import {
  awaitSendResult,
  deposit,
  processWithdraw,
  cancelWithdraw,
  requestWithdraw,
  shutdownWithdraw,
  type SendResult,
  type TxSigner,
} from "../actions.js";
import { track } from "../analytics.js";
import { apiBaseUrl, fetchPlayer, type CurrentEpochDto } from "../api.js";
import { LogoCog } from "../arena/Arena.js";
import { InfoTip } from "../InfoTip.js";
import { CLUSTER, type HexVaultProgram } from "../chain.js";
import {
  addCapped,
  clampDecimals,
  depositOpen,
  formatAtomic,
  formatAtomic2,
  formatMoney2,
  haircutValue,
  parseAtomic,
  pendingTickets,
  canCancelWithdraw,
  pendingWithdrawal,
  splitWithdraw,
  unsettledYieldLine,
} from "../lib/money.js";
import {
  decodeErrorCode,
  decodePlayerError,
  decodeSendFailure,
  failureReason,
  NOTHING_PENDING_CODE,
  thrownReason,
} from "../playerErrors.js";
import { solRentWarning, type PoolLike } from "../read.js";
import { SHUTDOWN_BANNER } from "../shutdown.js";
import { useApiPoll } from "../useApiPoll.js";
import { useLivePool } from "../useLiveYield.js";
import { GlyphRow } from "./Home.js";

const DECIMALS = 6;
const SYMBOL = "USDC";
const ONE = 10n ** BigInt(DECIMALS);
/**
 * The input, the pills and MAX all stay at two decimals so what the rows show
 * is what gets signed. Up to 0.009999 USDC of Principal can stay behind on a
 * MAX withdraw; worth less than a cent.
 */
const INPUT_DECIMALS = 2;
/** The Figma quick pills: each adds this many whole USDC. */
const QUICK_ADDS = [50n, 100n, 500n] as const;
/** Withdraw's pills: this percent of what can be withdrawn. */
const QUICK_PERCENTS = [25n, 50n, 75n] as const;
/** Figma types the CTA in mixed case; Syncopate's lowercase glyphs draw "DePOSIT". */
const MODE_CTA = { deposit: "Deposit", withdraw: "Withdraw" } as const;

/** ADR 0020: a deposit earns no Ticket until the next epoch. */
const TICKETS_TIP = ["Tickets from this deposit join the draw from tomorrow."];

const RECEIVE_TIP = [
  "A deposit from today never held a Ticket, so it comes back at once. The rest stays in today's draw, keeps earning yield, and pays after the day ends.",
];

const YIELD_TIP = [
  "Base yield is paid into your deposit once a day, so it compounds. The estimate is a year at today's rate.",
];

/** `base_rate_bps` APR compounded daily, as a percentage: 488 bps is about 5%. */
export const apyFromBaseRateBps = (baseRateBps: number): number =>
  ((1 + baseRateBps / 10_000 / 365) ** 365 - 1) * 100;

/** A year of compounded Base yield on `amount` at `apy` percent, in atomic
 *  units. Display only: floats are fine at these magnitudes. */
const yearlyYield = (amount: bigint, apy: number): bigint =>
  BigInt(Math.floor((Number(amount) * apy) / 100));

/**
 * `NothingPending` (playerErrors.ts, ticket 09 — this used to be this file's
 * own `payoutError`): the operator's crank paid this withdrawal before the
 * click landed. `payOutNow` below treats that as a success, not an error.
 */
const NOTHING_PENDING_NOTE = decodeErrorCode(NOTHING_PENDING_CODE);

/** Ticket 15: shown while an `"unknown"` `SendResult` is being polled to a
 *  real outcome, with a link so the depositor can check for themselves too. */
const explorerUrl = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;

const CHECKING_NOTE = "Checking your transaction…";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Unix seconds as the Figma's local "6 OCT, 12:00AM (GMT+8)"; `gap` goes
 *  between the time and AM/PM (the modal has one, the widget does not). */
export function receiveTime(unixSeconds: number, gap = ""): string {
  const at = new Date(unixSeconds * 1000);
  const hours = at.getHours();
  const clock = `${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")}${gap}${hours < 12 ? "AM" : "PM"}`;
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `GMT${offset < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}, ${clock} (${zone})`;
}

/** Local HH:MM of a unix-seconds time; the preview and the pending row say "about". */
const clockTime = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

export type VaultMode = "deposit" | "withdraw";
type Mode = VaultMode;

export interface VaultScreenProps {
  /** Null until a wallet is connected; the CTA then reads CONNECT WALLET. */
  program: HexVaultProgram | null;
  owner: PublicKey | null;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  principal: bigint;
  /** Null when the chain read failed (ticket 15): a stuttering RPC must
   *  never look like an empty wallet and block a deposit as over balance. */
  walletBalance: bigint | null;
  /** Connected wallet's own SOL, for the rent warning below; null while
   *  unread or unavailable. */
  solBalance: bigint | null;
  paused: boolean;
  /** ticket 11: irreversible. Withdraw goes one-step; everything else refuses. */
  shutdown: boolean;
  currentEpoch: CurrentEpochDto | null;
  /** Requested but unpaid Principal; 0 when nothing is pending. */
  pendingWithdraw: bigint;
  /** The epoch that pending amount was requested in, so the day it pays after. */
  pendingEpoch: bigint;
  /**
   * Which tab the widget opens on. The dashboard's two buttons are the only
   * way in, and they arrive with an intent already; App unmounts the screen on
   * every tab change, so this is read fresh on each arrival.
   */
  initialMode?: Mode | undefined;
  onConnect: () => void;
  onDone: () => void;
}

export function Vault(props: VaultScreenProps) {
  const {
    program,
    owner,
    sendTransaction,
    pool,
    principal,
    walletBalance,
    solBalance,
    paused,
    shutdown,
    currentEpoch,
    pendingWithdraw,
    pendingEpoch,
    initialMode,
    onConnect,
    onDone,
  } = props;
  // Two decimals everywhere, including what the pills write into the input
  // (see INPUT_DECIMALS).
  const fmt2 = (value: bigint) => formatAtomic2(value, DECIMALS);

  const [mode, setMode] = useState<Mode>(initialMode ?? "deposit");
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<
    { tone: "ok" | "err"; text: string; href?: string } | null
  >(null);
  /** Atomic amount of the deposit that just landed; null closes the modal. */
  const [confirmed, setConfirmed] = useState<bigint | null>(null);
  /**
   * A `process_withdraw` has been sent and the read model has not caught up.
   * Keyed on the pending amount so the flag clears itself the moment the
   * payout lands (or a fresh request books a different amount).
   */
  const [payoutSent, setPayoutSent] = useState<bigint | null>(null);

  const connected = owner !== null && program !== null && pool !== null;
  const amount = parseAtomic(amountText, DECIMALS);
  const amountUsdc = amount === null ? 0 : Number(formatAtomic(amount, DECIMALS));
  /**
   * What the pills clamp to: wallet on deposit, Principal less what is already
   * queued on withdraw (a queued amount stays inside Principal, ADR 0020).
   * `request_withdraw` only checks that, so Tickets spent in the game do not
   * hold any of it back. Null only on deposit,
   * when the wallet balance read failed (ticket 15) — the pills and the
   * over-balance check both stand down rather than guess.
   */
  const cap =
    mode === "deposit" ? walletBalance : principal > pendingWithdraw ? principal - pendingWithdraw : 0n;
  const balanceUnavailable = mode === "deposit" && walletBalance === null;
  const rentWarning = solRentWarning(solBalance, { sponsored: sendTransaction !== undefined });

  const ownerBase58 = owner?.toBase58();
  const loadPlayerExtras = useCallback(
    (signal: AbortSignal) =>
      ownerBase58
        ? fetchPlayer(apiBaseUrl(), ownerBase58, signal)
        : Promise.resolve({ ok: false as const, reason: "no wallet connected" }),
    [ownerBase58],
  );
  const playerExtras = useApiPoll(loadPlayerExtras, 10_000);

  // While the pool is impaired every withdrawal pays a share of the amount, and
  // the program takes no deposit.
  const livePool = useLivePool();
  const haircutFactor = livePool?.live.haircutFactor ?? null;
  const impaired = livePool?.pool.impaired ?? false;

  // The payout landed (or the request was never there): drop the flag, so a
  // later request for the same amount does not inherit this one's state.
  useEffect(() => {
    if (pendingWithdraw === 0n) setPayoutSent(null);
  }, [pendingWithdraw]);

  const pending = pendingWithdrawal(
    pendingWithdraw,
    pendingEpoch,
    currentEpoch ? BigInt(currentEpoch.id) : null,
    payoutSent !== null && payoutSent === pendingWithdraw,
    shutdown,
  );

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setAmountText("");
    setNote(null);
  };

  const addQuick = (units: bigint) =>
    setAmountText(fmt2(addCapped(amount ?? 0n, units * ONE, connected ? cap : null)));

  const run = async (
    label: string,
    signerProgram: HexVaultProgram,
    action: () => Promise<SendResult>,
  ) => {
    setBusy(true);
    setNote(null);
    try {
      let result = await action();
      if (result.kind === "unknown") {
        // Ticket 15: the confirmation itself failed, not the transaction — a
        // retry here could double-send. Money buttons (`busy`) stay disabled
        // while this polls the signature to a real outcome.
        setNote({ tone: "ok", text: CHECKING_NOTE, href: explorerUrl(result.signature) });
        result = await awaitSendResult(signerProgram, result);
      }
      if (result.kind !== "landed") {
        if (label === "Deposit") track("deposit_failed", { amount_usdc: amountUsdc, reason: failureReason(result) });
        setNote({ tone: "err", text: decodeSendFailure(result) });
        return;
      }
      if (label === "Deposit") track("deposit_confirmed", { amount_usdc: amountUsdc });
      else track("withdraw_requested", { amount_usdc: amountUsdc, shutdown: label === "Withdraw" });
      // Deposit gets the confirmed modal; withdraw keeps the inline note.
      if (label === "Deposit" && amount !== null) {
        setConfirmed(amount);
      } else {
        setNote({
          tone: "ok",
          text: `${label}: ${result.signature.slice(0, 16)}…`,
        });
      }
      setAmountText("");
      onDone();
    } catch (error) {
      if (label === "Deposit") track("deposit_failed", { amount_usdc: amountUsdc, reason: thrownReason(error) });
      setNote({
        tone: "err",
        text: decodePlayerError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  // `cap` is null only on deposit with an unavailable balance read (ticket
  // 15): unknown is not "over balance", so this stands down rather than
  // guess — `balanceUnavailable`'s own note carries the warning instead.
  const overCap = connected && amount !== null && cap !== null && amount > cap;
  const underMin =
    mode === "deposit" && pool !== null && amount !== null && amount < pool.minDeposit;
  const apy = pool ? apyFromBaseRateBps(pool.baseRateBps) : null;
  const currentEpochId = currentEpoch ? BigInt(currentEpoch.id) : null;
  // ADR 0020: a deposit earns no Ticket until the next epoch. The read model
  // sends the row, and the same lazy fold `touch` does runs here against the
  // epoch the screen already holds.
  const pendingNow = playerExtras.data
    ? pendingTickets(
        BigInt(playerExtras.data.pendingDeposit),
        BigInt(playerExtras.data.pendingDepositEpoch),
        currentEpochId,
      )
    : 0n;
  // The refund part pays in the transaction; at Shutdown the whole amount does.
  const split =
    mode === "withdraw" && amount !== null && amount > 0n
      ? shutdown
        ? { payNow: amount, queued: 0n }
        : splitWithdraw(amount, pendingNow)
      : null;
  // The queue pays when the epoch ends, as long as that is still ahead; the
  // same moment a deposit's Tickets start counting.
  const epochEnd = currentEpoch ? Number(currentEpoch.endsAt) : 0;
  const epochAhead = epochEnd * 1000 > Date.now();
  const expectedAt =
    shutdown || (split !== null && split.queued === 0n)
      ? "Now"
      : epochAhead
        ? receiveTime(epochEnd).replace(" (", "\n(")
        : "After today's draw";
  const queuedMaturesAt = playerExtras.data?.pendingMaturesAt;
  const yieldEarned = unsettledYieldLine(playerExtras.data?.unsettledYield, DECIMALS);

  const submit = () => {
    if (!connected || !amount) return;
    const signer: TxSigner = { publicKey: owner, sendTransaction };
    if (mode === "deposit") {
      track("deposit_submitted", { amount_usdc: amountUsdc });
      void run("Deposit", program, () => deposit(program, signer, pool, amount));
    } else if (shutdown) {
      // One transaction: request_withdraw + process_withdraw (ticket 11).
      void run("Withdraw", program, () =>
        shutdownWithdraw(program, signer, pool, amount, pendingWithdraw),
      );
    } else {
      // One instruction (ADR 0020): the pending-deposit part refunds in the same
      // transaction and the rest queues. The note says which happened.
      const label =
        split === null || split.payNow === 0n
          ? "Withdraw requested"
          : split.queued === 0n
            ? "Refunded"
            : "Refunded today's deposit, rest requested";
      void run(label, program, () =>
        requestWithdraw(program, signer, pool, amount),
      );
    }
  };

  const payOutNow = async () => {
    if (!connected) return;
    setBusy(true);
    setNote(null);
    setPayoutSent(pendingWithdraw);
    try {
      let result = await processWithdraw(program, { publicKey: owner, sendTransaction }, pool);
      if (result.kind === "unknown") {
        setNote({ tone: "ok", text: CHECKING_NOTE, href: explorerUrl(result.signature) });
        result = await awaitSendResult(program, result);
      }
      if (result.kind === "landed") {
        track("withdraw_paid_out");
        setNote({ tone: "ok", text: "Payout sent." });
        onDone();
      } else if (result.kind === "failed" && result.code === NOTHING_PENDING_CODE) {
        // Already paid by the operator: the read model is stale, so refresh
        // it the same way a successful payout does instead of offering the
        // button again.
        setNote({ tone: "ok", text: NOTHING_PENDING_NOTE });
        onDone();
      } else {
        setPayoutSent(null);
        setNote({ tone: "err", text: decodeSendFailure(result) });
      }
    } catch (error) {
      setPayoutSent(null);
      setNote({ tone: "err", text: decodePlayerError(error) });
    } finally {
      setBusy(false);
    }
  };

  const cancelNow = async () => {
    if (!connected) return;
    setBusy(true);
    setNote(null);
    try {
      let result = await cancelWithdraw(program, { publicKey: owner, sendTransaction }, pool);
      if (result.kind === "unknown") {
        setNote({ tone: "ok", text: CHECKING_NOTE, href: explorerUrl(result.signature) });
        result = await awaitSendResult(program, result);
      }
      if (result.kind === "landed") {
        setNote({ tone: "ok", text: "Withdrawal cancelled. Your money stays in the vault." });
        onDone();
      } else if (result.kind === "failed" && result.code === NOTHING_PENDING_CODE) {
        // The crank paid it first. Same refresh as a landed cancel.
        setNote({ tone: "ok", text: NOTHING_PENDING_NOTE });
        onDone();
      } else {
        setNote({ tone: "err", text: decodeSendFailure(result) });
      }
    } catch (error) {
      setNote({ tone: "err", text: decodePlayerError(error) });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    connected &&
    !busy &&
    !!amount &&
    amount > 0n &&
    !overCap &&
    !underMin &&
    !(mode === "deposit" && !depositOpen(paused, impaired));

  const ctaText = !connected
    ? "CONNECT WALLET"
    : busy
      ? "SIGNING…"
      : mode === "deposit" && shutdown
        ? "POOL CLOSED"
        : mode === "deposit" && paused
          ? "POOL PAUSED"
          : mode === "deposit" && impaired
            ? "DEPOSITS CLOSED"
            : MODE_CTA[mode];

  return (
    <div className="vault" data-testid="vault-screen">
      {/* Pre-dithered checkmark coin (scripts/dither-video.mjs). Without autoplay the poster stays. */}
      <video
        className="home-bg"
        src="/vault-bg.mp4"
        poster="/vault-bg.png"
        autoPlay={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <div className="vault-row">
        <GlyphRow />
        <section className="vault-widget" aria-label="Deposit or withdraw">
          <div className="vault-tabs" role="tablist">
            {(["deposit", "withdraw"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={mode === candidate}
                className={`vault-tab${mode === candidate ? " active" : ""}`}
                data-testid={`vault-tab-${candidate}`}
                onClick={() => switchMode(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>

          <div className="vault-body">
            <label className="vault-amount">
              <span className="vault-amount-dollar" aria-hidden="true">
                $
              </span>
              <input
                value={amountText}
                placeholder="0"
                onChange={(event) =>
                  setAmountText(clampDecimals(event.target.value, INPUT_DECIMALS))
                }
                inputMode="decimal"
                data-testid={`${mode}-input`}
                aria-label={`${mode} amount`}
              />
              <span className="vault-amount-symbol">{SYMBOL}</span>
              <span className="vault-amount-available" data-testid="withdrawable-now">
                {mode === "deposit"
                  ? walletBalance === null
                    ? "Balance unavailable"
                    : `Available ${fmt2(walletBalance)} ${SYMBOL}`
                  : `Available to withdraw: ${fmt2(shutdown ? principal : (cap ?? 0n))} ${SYMBOL}`}
              </span>
            </label>

            <div className="vault-quick">
              {mode === "deposit"
                ? QUICK_ADDS.map((units) => (
                    <button
                      key={units.toString()}
                      type="button"
                      className="vault-pill"
                      onClick={() => addQuick(units)}
                    >
                      +${units.toString()}
                    </button>
                  ))
                : QUICK_PERCENTS.map((percent) => (
                    <button
                      key={percent.toString()}
                      type="button"
                      className="vault-pill"
                      disabled={cap === null}
                      onClick={() => {
                        if (cap !== null) setAmountText(fmt2((cap * percent) / 100n));
                      }}
                    >
                      {percent.toString()}%
                    </button>
                  ))}
              <button
                type="button"
                className="vault-pill"
                disabled={cap === null}
                onClick={() => {
                  if (cap !== null) setAmountText(fmt2(cap));
                }}
              >
                MAX
              </button>
            </div>

            <dl className="vault-rows">
              {mode === "deposit" ? (
                <>
                  <div className="vault-line" data-testid="vault-tickets">
                    <dt className="vault-line-label">
                      Tickets
                      <InfoTip id="tickets-tip" paragraphs={TICKETS_TIP} />
                    </dt>
                    <dd>{fmt2(amount ?? 0n)}</dd>
                  </div>
                  <div className="vault-line" data-testid="estimated-yield">
                    <dt className="vault-line-label">
                      Estimated yield
                      <InfoTip id="estimated-yield-tip" paragraphs={YIELD_TIP} />
                    </dt>
                    <dd>
                      {apy === null
                        ? "—"
                        : `$${fmt2(yearlyYield(amount ?? 0n, apy))} (~${Number(apy.toFixed(2))}% APY)`}
                    </dd>
                  </div>
                </>
              ) : (
                <>
                  <div className="vault-line" data-testid="withdraw-receive">
                    <dt>You will receive</dt>
                    <dd>${fmt2(haircutValue(amount ?? 0n, haircutFactor))}</dd>
                  </div>
                  <div className="vault-line" data-testid="withdraw-expected">
                    <dt className="vault-line-label">
                      Expected to receive at
                      <InfoTip id="receive-tip" paragraphs={RECEIVE_TIP} />
                    </dt>
                    <dd className="vault-line-when">{expectedAt}</dd>
                  </div>
                </>
              )}
              {mode === "withdraw" || yieldEarned === null ? null : (
                <div className="vault-line" data-testid="unsettled-yield">
                  <dt>Yield</dt>
                  <dd>${yieldEarned}</dd>
                </div>
              )}
              {pending.kind === "none" ? null : (
                <div className="vault-line" data-testid="pending-withdraw">
                  <dt>
                    Pending {fmt2(pending.amount)} {SYMBOL}
                  </dt>
                  <dd className="vault-pending-state">
                    <span data-testid="pending-withdraw-state">
                      {pending.kind === "pending"
                        ? queuedMaturesAt
                          ? `pays after today's draw, about ${clockTime(Number(queuedMaturesAt))}`
                          : "pays after today's draw"
                        : pending.kind === "processing"
                          ? "paying out…"
                          : "ready"}
                    </span>
                    {pending.kind === "due" && impaired ? (
                      <span data-testid="pending-withdraw-haircut">
                        pays {fmt2(haircutValue(pending.amount, haircutFactor))} {SYMBOL} now
                      </span>
                    ) : null}
                    {pending.kind === "due" ? (
                      <button
                        type="button"
                        className="vault-pill vault-payout"
                        data-testid="pay-out-now"
                        disabled={busy}
                        onClick={() => void payOutNow()}
                      >
                        {impaired ? "TAKE IT NOW" : "PAY OUT NOW"}
                      </button>
                    ) : null}
                    {canCancelWithdraw(pending) ? (
                      <button
                        type="button"
                        className="vault-pill"
                        data-testid="cancel-withdraw"
                        disabled={busy}
                        onClick={() => void cancelNow()}
                      >
                        CANCEL
                      </button>
                    ) : null}
                    {canCancelWithdraw(pending) ? (
                      <span data-testid="cancel-withdraw-hint">
                        Cancel and your money stays in the vault, still earning.
                      </span>
                    ) : null}
                  </dd>
                </div>
              )}
            </dl>

            <button
              type="button"
              className="vault-cta"
              disabled={connected && !canSubmit}
              data-testid={`${mode}-submit`}
              onClick={connected ? submit : onConnect}
            >
              {ctaText}
            </button>

            <div className="vault-notes">
              {mode === "deposit" && shutdown ? (
                <span className="vault-note" data-testid="deposit-shutdown-note">
                  {SHUTDOWN_BANNER}
                </span>
              ) : mode === "deposit" && paused ? (
                <span className="vault-note">
                  Pool is paused: deposits are blocked; withdrawals stay live.
                </span>
              ) : mode === "deposit" && impaired ? (
                <span className="vault-note" data-testid="deposit-impaired-note">
                  Deposits reopen when the pool recovers from its venue loss.
                </span>
              ) : null}
              {mode === "withdraw" && shutdown ? (
                <span className="vault-note" data-testid="withdraw-lock-note">
                  The pool is closed, so the whole payout lands in this same transaction.
                </span>
              ) : null}
              {mode === "withdraw" && haircutFactor !== null && haircutFactor < 1 ? (
                <span className="vault-note" data-testid="withdraw-impaired-note">
                  The pool lost value on its lending venue, so every withdrawal pays{" "}
                  {Number((haircutFactor * 100).toFixed(2))}% of the amount until it recovers.
                </span>
              ) : null}
              {overCap ? (
                <span className="vault-note" data-testid={`${mode}-over-balance`}>
                  {mode === "deposit"
                    ? "Amount is more than your wallet balance."
                    : "Amount is more than your Principal."}
                </span>
              ) : null}
              {balanceUnavailable ? (
                <span className="vault-note" data-testid="deposit-balance-unavailable">
                  Balance unavailable right now. Try again in a moment.
                </span>
              ) : null}
              {mode === "deposit" && rentWarning ? (
                <span className="vault-note" data-testid="sol-rent-warning">
                  {rentWarning}
                </span>
              ) : null}
              {mode === "deposit" && pool ? (
                <span className="vault-note">
                  Minimum deposit {fmt2(pool.minDeposit)} {SYMBOL}.
                </span>
              ) : null}
              {note ? (
                <span className={`vault-note ${note.tone}`} data-testid="vault-note">
                  {note.text}
                  {note.href ? (
                    <>
                      {" "}
                      <a href={note.href} target="_blank" rel="noopener noreferrer">
                        View on explorer
                      </a>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        </section>
        <GlyphRow />
      </div>

      {confirmed !== null ? (
        <DepositConfirmed
          amount={`$${fmt2(confirmed)} ${SYMBOL}`}
          tickets={formatMoney2(confirmed, DECIMALS).replace(/\.00$/, "")}
          availableAt={epochAhead ? receiveTime(epochEnd, " ") : null}
          onClose={() => setConfirmed(null)}
        />
      ) : null}
    </div>
  );
}

interface DepositConfirmedProps {
  amount: string;
  /** What the deposit adds from the next epoch. */
  tickets: string;
  /** When the next epoch starts; null when the clock is unknown or past. */
  availableAt: string | null;
  onClose: () => void;
}

/** The Figma "deposit confirmed" popup: backdrop, ×, and Escape dismiss. */
function DepositConfirmed({ amount, tickets, availableAt, onClose }: DepositConfirmedProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="deposit-modal-backdrop" onClick={onClose} data-testid="deposit-modal">
      <section
        className="deposit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="deposit-modal-head">
          <span className="deposit-modal-brand">
            <LogoCog size={18} />
            DEPOSIT
          </span>
          <button
            ref={closeRef}
            type="button"
            className="deposit-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <img
          className="deposit-modal-coin"
          src="/deposit-check.png"
          alt=""
          width={188}
          height={188}
        />
        <p className="deposit-modal-kicker">DEPOSIT CONFIRMED</p>
        <p className="deposit-modal-amount" id="deposit-modal-title" data-testid="deposit-modal-amount">
          {amount}
        </p>
        <p className="deposit-modal-sub">
          <strong>{tickets} Tickets</strong> available{" "}
          {availableAt ? (
            <>
              on <strong>{availableAt}</strong>
            </>
          ) : (
            "from the next draw"
          )}
        </p>
        <button
          type="button"
          className="vault-cta deposit-modal-ok"
          data-testid="deposit-modal-ok"
          onClick={onClose}
        >
          Got it!
        </button>
      </section>
    </div>
  );
}
