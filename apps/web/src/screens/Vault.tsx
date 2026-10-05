/**
 * VAULT tab: the Figma "Deposit" frame. One widget with DEPOSIT / WITHDRAW
 * tabs on the HOME halftone background. The program is the custody boundary.
 * WITHDRAW sends `instant_withdraw` when the pool can pay the amount at once
 * (up to min(Principal, Tickets), ticket 16) and says so before confirm.
 * Otherwise it sends `request_withdraw`, which deducts Principal and Tickets
 * now and pays out after the epoch ends (ADR 0009); `instantWithdraw.ts`
 * decides. The pending row below the widget carries that wait: the amount,
 * the day it pays in, and a "pay out now" button that sends the permissionless
 * `process_withdraw` when the operator has not.
 *
 * Ticket 07: `currentEpoch` comes from App's one `GET /state` poll instead
 * of a duplicate `/epochs/current` poll of its own; `onDone` tightens that
 * poll (see `useStatePoll.ts` `kick`) instead of triggering a chain re-read.
 *
 * Yield-claimer ticket 15: the balance (Principal plus unsettled yield,
 * ticking) and the "up to X%" rate sit in `YieldBalance.tsx`, which polls
 * `GET /players/:owner` and `GET /pool` itself. Buy Tickets is hidden for
 * now; its markup was removed but buyTickets.ts and useBuyTickets.ts stay, so
 * bringing it back is markup only, behind `buyTicketsVisible`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import {
  awaitSendResult,
  deposit,
  instantWithdraw,
  processWithdraw,
  requestWithdraw,
  shutdownWithdraw,
  type SendResult,
  type TxSigner,
} from "../actions.js";
import { track } from "../analytics.js";
import {
  apiBaseUrl,
  fetchPlayer,
  fetchPoolSummary,
  type CurrentEpochDto,
  type LiveYieldDto,
} from "../api.js";
import { LogoCog } from "../arena/Arena.js";
import {
  effectiveTickets,
  instantLimit,
  offersQueue,
  planWithdraw,
} from "../instantWithdraw.js";
import { CLUSTER, type HexVaultProgram } from "../chain.js";
import {
  addCapped,
  clampDecimals,
  formatAtomic,
  formatAtomic2,
  parseAtomic,
  pendingWithdrawal,
  previewWithdraw,
} from "../lib/money.js";
import {
  decodeErrorCode,
  decodePlayerError,
  decodeSendFailure,
  failureReason,
  NOTHING_PENDING_CODE,
  thrownCode,
  thrownReason,
} from "../playerErrors.js";
import { solRentWarning, type PoolLike } from "../read.js";
import { SHUTDOWN_BANNER } from "../shutdown.js";
import { useApiPoll } from "../useApiPoll.js";
import { YieldBalance } from "../YieldBalance.js";
import { GlyphRow } from "./Home.js";

const DECIMALS = 6;
const SYMBOL = "USDC";
const ONE = 10n ** BigInt(DECIMALS);
/**
 * The input, the pills and MAX all stay at two decimals so what the rows show
 * is what gets signed. Up to 0.009999 USDC of game dust in Tickets can
 * stay behind on a MAX withdraw; worth less than a cent.
 */
const INPUT_DECIMALS = 2;
/** The Figma quick pills: each adds this many whole USDC. */
const QUICK_ADDS = [50n, 100n, 500n] as const;

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
  entries: bigint;
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
  /** "Play HEXO" on the deposit-confirmed modal: App switches to the MINE tab. */
  onPlay: () => void;
}

export function Vault(props: VaultScreenProps) {
  const {
    program,
    owner,
    sendTransaction,
    pool,
    principal,
    entries,
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
    onPlay,
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
   * What the pills clamp to: wallet on deposit, Principal on withdraw.
   * `request_withdraw` only checks Principal now (ADR 0009), so Tickets
   * spent in the game no longer hold any of it back. Null only on deposit,
   * when the wallet balance read failed (ticket 15) — the pills and the
   * over-balance check both stand down rather than guess.
   */
  const cap = mode === "deposit" ? walletBalance : principal;
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

  // Withdraw mode asks `/pool?withdraw=` whether the pool can pay the typed
  // amount at once (and whether it is impaired). The amount settles for
  // 400 ms first so typing does not send a request per keystroke.
  const [coverAmount, setCoverAmount] = useState<bigint | null>(null);
  useEffect(() => {
    if (mode !== "withdraw" || !amount) {
      setCoverAmount(null);
      return;
    }
    const timer = window.setTimeout(() => setCoverAmount(amount), 400);
    return () => window.clearTimeout(timer);
  }, [mode, amount]);
  const loadCover = useCallback(
    async (signal: AbortSignal) => {
      const result = await fetchPoolSummary(apiBaseUrl(), signal, coverAmount ?? undefined);
      return result.ok
        ? { ok: true as const, data: { asked: coverAmount, live: result.data.live as LiveYieldDto } }
        : result;
    },
    [coverAmount],
  );
  const cover = useApiPoll(loadCover, 10_000);
  /** The instant transaction failed for lack of liquidity; stay on the queue. */
  const [forceQueue, setForceQueue] = useState(false);
  useEffect(() => setForceQueue(false), [amountText, mode]);

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
        // yield-claimer ticket 16: the pool could not pay at once; the copy
        // says so, and the form drops to the queued request for this amount.
        if (label === "Withdrawn" && result.kind === "failed" && offersQueue(result.code)) {
          setForceQueue(true);
        }
        setNote({ tone: "err", text: decodeSendFailure(result) });
        return;
      }
      if (label === "Deposit") track("deposit_confirmed", { amount_usdc: amountUsdc });
      else if (label === "Withdrawn") track("withdraw_instant", { amount_usdc: amountUsdc });
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
      if (label === "Withdrawn" && offersQueue(thrownCode(error))) setForceQueue(true);
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
  const currentEpochId = currentEpoch ? BigInt(currentEpoch.id) : null;
  const tickets = effectiveTickets(
    principal,
    entries,
    playerExtras.data ? BigInt(playerExtras.data.epochId) : null,
    currentEpochId,
  );
  /** The most `instant_withdraw` takes: the smaller of Principal and Tickets. */
  const instantMax = instantLimit(principal, tickets);
  const live = cover.data?.live ?? null;
  // The cover answer is only about the amount it was asked for.
  const coverable =
    cover.data !== null && cover.data.asked === amount ? live?.instantWithdrawCoverable ?? null : null;
  const haircutFactor = live?.haircutFactor ?? null;
  const plan =
    mode === "withdraw" && !shutdown && amount !== null && amount > 0n
      ? planWithdraw({ amount, principal, tickets, coverable, haircutFactor, forceQueue })
      : null;
  const withdrawPreview =
    mode === "withdraw" && amount !== null ? previewWithdraw(entries, amount) : null;

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
    } else if (plan?.kind === "instant") {
      void run("Withdrawn", program, () => instantWithdraw(program, signer, pool, amount));
    } else {
      void run("Withdraw requested", program, () =>
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

  const canSubmit =
    connected &&
    !busy &&
    !!amount &&
    amount > 0n &&
    !overCap &&
    !underMin &&
    !(mode === "deposit" && paused);

  const ctaText = !connected
    ? "CONNECT WALLET"
    : busy
      ? "SIGNING…"
      : mode === "deposit" && shutdown
        ? "POOL CLOSED"
        : mode === "deposit" && paused
          ? "POOL PAUSED"
          : mode === "withdraw" && plan?.kind === "queued"
            ? "REQUEST WITHDRAWAL"
            : mode.toUpperCase();

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
            <YieldBalance owner={owner} principal={principal} />
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
                  : shutdown
                    ? `Withdrawable ${fmt2(principal)} ${SYMBOL}`
                    : `Withdrawable now ${fmt2(instantMax)} ${SYMBOL}`}
              </span>
            </label>

            <div className="vault-quick">
              {QUICK_ADDS.map((units) => (
                <button
                  key={units.toString()}
                  type="button"
                  className="vault-pill"
                  onClick={() => addQuick(units)}
                >
                  +${units.toString()}
                </button>
              ))}
              <button
                type="button"
                className="vault-pill"
                disabled={cap === null}
                onClick={() => {
                  // On withdraw, MAX is what leaves at once; typing more queues the rest.
                  const max = mode === "withdraw" && !shutdown ? instantMax : cap;
                  if (max !== null) setAmountText(fmt2(max));
                }}
              >
                MAX
              </button>
            </div>

            <dl className="vault-rows">
              {mode === "deposit" ? (
                <>
                  <div className="vault-line">
                    <dt>Tickets</dt>
                    <dd>{fmt2(amount ?? 0n)}</dd>
                  </div>
                </>
              ) : (
                <>
                  {plan ? (
                    <div className="vault-line" data-testid="withdraw-kind">
                      <dt>Payout</dt>
                      <dd>
                        {plan.kind === "instant"
                          ? "Instant"
                          : `Queued, pays after day #${currentEpochId ?? "…"} ends`}
                      </dd>
                    </div>
                  ) : null}
                  <div className="vault-line">
                    <dt>{shutdown || plan?.kind === "queued" ? "You receive at day end" : "You receive"}</dt>
                    <dd data-testid="withdraw-receive">
                      {fmt2(plan ? plan.receive : (amount ?? 0n))} {SYMBOL}
                    </dd>
                  </div>
                  {plan && plan.haircut > 0n ? (
                    <div className="vault-line" data-testid="withdraw-haircut">
                      <dt>Haircut</dt>
                      <dd>
                        -{fmt2(plan.haircut)} {SYMBOL}
                      </dd>
                    </div>
                  ) : null}
                  <div className="vault-line" data-testid="withdraw-tickets-removed">
                    <dt>Tickets removed</dt>
                    <dd>
                      {fmt2(
                        (plan ? tickets - plan.ticketsAfter : null) ??
                          (withdrawPreview ? entries - withdrawPreview.entriesAfter : 0n),
                      )}
                    </dd>
                  </div>
                  <div className="vault-line">
                    <dt>Tickets after</dt>
                    <dd>
                      {fmt2(
                        plan
                          ? plan.ticketsAfter
                          : withdrawPreview
                            ? withdrawPreview.entriesAfter
                            : entries,
                      )}
                    </dd>
                  </div>
                </>
              )}
              {pending.kind === "none" ? null : (
                <div className="vault-line" data-testid="pending-withdraw">
                  <dt>
                    Pending {fmt2(pending.amount)} {SYMBOL}
                  </dt>
                  <dd className="vault-pending-state">
                    <span data-testid="pending-withdraw-state">
                      {pending.kind === "pending"
                        ? `pays out after day #${pending.epoch} ends`
                        : pending.kind === "processing"
                          ? "paying out…"
                          : "ready"}
                    </span>
                    {pending.kind === "due" ? (
                      <button
                        type="button"
                        className="vault-pill vault-payout"
                        data-testid="pay-out-now"
                        disabled={busy}
                        onClick={() => void payOutNow()}
                      >
                        PAY OUT NOW
                      </button>
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
              ) : null}
              {mode === "withdraw" ? (
                <span className="vault-note" data-testid="withdraw-lock-note">
                  {shutdown
                    ? "Principal and Tickets leave your account now. The pool is closed, so the payout lands in this same transaction."
                    : plan?.kind === "instant"
                      ? "Principal and Tickets leave your account now and the USDC lands in your wallet in this transaction."
                      : "Principal and Tickets leave your account now. The USDC pays out once today's draw is over."}
                </span>
              ) : null}
              {mode === "withdraw" && !shutdown && principal > instantMax ? (
                <span className="vault-note" data-testid="withdraw-locked-note">
                  Only the smaller of your Principal and Tickets leaves at once. The other{" "}
                  {fmt2(principal - instantMax)} {SYMBOL} unlocks at the next daily reset, or you can queue it now.
                </span>
              ) : null}
              {mode === "withdraw" && plan?.reason === "pool-short" ? (
                <span className="vault-note" data-testid="withdraw-pool-short-note">
                  The pool can't pay that much at once right now, so it goes in the queue.
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
          tickets={fmt2(entries)}
          onClose={() => setConfirmed(null)}
          onPlay={onPlay}
        />
      ) : null}
    </div>
  );
}

interface DepositConfirmedProps {
  amount: string;
  /** Live Tickets balance; refreshes in place once the chain read lands. */
  tickets: string;
  onClose: () => void;
  onPlay: () => void;
}

/** The Figma "deposit confirmed" popup: backdrop, ×, and Escape dismiss. */
function DepositConfirmed({ amount, tickets, onClose, onPlay }: DepositConfirmedProps) {
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
          You have <strong>{tickets} Tickets</strong> to play
        </p>
        <button
          type="button"
          className="vault-cta deposit-modal-play"
          data-testid="deposit-modal-play"
          onClick={onPlay}
        >
          Play HEXO
        </button>
      </section>
    </div>
  );
}
