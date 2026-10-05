/** MINE screen wiring: header, arena + control panel, tabs, live events. */
import { AnchorProvider, Program } from "@anchor-lang/core";
import { useConnection } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { eventsToRows } from "./activityRows.js";
import { Arena, LogoCog, LogoWordmark } from "./arena/Arena.js";
import { BetDrawer } from "./panel/BetDrawer.js";
import { ControlPanel } from "./panel/ControlPanel.js";
import { StakeBarButton } from "./panel/StakeBarButton.js";
import { About } from "./screens/About.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Home } from "./screens/Home.js";
import { Leaderboard } from "./screens/Leaderboard.js";
import { Referrals } from "./screens/Referrals.js";
import { Vault, type VaultMode } from "./screens/Vault.js";
import { WeeklyDraw } from "./screens/WeeklyDraw.js";
import { awaitSendResult, buyPosition, settlePosition } from "./actions.js";
import { track } from "./analytics.js";
import { apiBaseUrl, fetchFeed, type RoundDto } from "./api.js";
import { GAME_GATED, PROGRAM_ID, POOL_ID, poolAddress, type HexVaultProgram } from "./chain.js";
import { idl } from "./idl.js";
import {
  covers,
  decideAutoRound,
  displayTile,
  expectedReward,
  isRevealed,
  idleBoardLabel,
  phaseFor,
  type FeedRow,
  type RememberedBoard,
  type RoundLike,
} from "./engine.js";
import { formatAtomic, formatAtomic2, parseAtomic } from "./lib/money.js";
import {
  decodePlayerError,
  decodeSendFailure,
  failureReason,
  thrownReason,
} from "./playerErrors.js";
import { sfx, setSoundOn, subscribeSound, isSoundOn } from "./sfx.js";
import { SHUTDOWN_BANNER, SHUTDOWN_REASON } from "./shutdown.js";
import { SoundIcon } from "./SoundIcon.js";
import { WalletMenu } from "./WalletMenu.js";
import { poolFromDto, solRentWarning, useSolBalance, useWalletBalance } from "./read.js";
import { useGenesisCheck } from "./useGenesisCheck.js";
import { useChainClock } from "./useChainClock.js";
import { useApiPoll } from "./useApiPoll.js";
import { snapshot, useStatePoll } from "./useStatePoll.js";
import { useRoundEngine } from "./useRoundEngine.js";
import { useGameSigner } from "./wallets.js";
import { summarizeStatus } from "./status.js";
import { TABS, hashForTab, playLock, tabFromHash, type Tab } from "./tabs.js";

/** `GET /state`'s tracked Round (any status) → the engine's `RoundLike`. */
function roundLikeFrom(dto: RoundDto): RoundLike {
  return {
    roundId: BigInt(dto.id),
    epochId: BigInt(dto.epochId),
    startsAt: BigInt(dto.startsAt),
    endsAt: BigInt(dto.endsAt),
    status: Number(dto.status),
    winningTile: dto.winningTile ?? -1,
    pot: BigInt(dto.pot),
    houseCut: BigInt(dto.houseCut),
    tileTotals: dto.tileTotals.map((value) => BigInt(value)),
  };
}

/** The accepted asset is USDC (6 decimals) for every pool in this build. */
const SYMBOL = "USDC";
const DECIMALS = 6;
/**
 * How long after a round ends before the manual SETTLE POSITION button shows.
 * The operator settles one batch per 2 s tick, so a healthy crank clears a
 * round well inside this; the button is the fallback for a stalled one.
 * ponytail: fixed guess, derive from batch size × tick if rounds get crowded.
 */
const SETTLE_GRACE_SECONDS = 30n;

export function App() {
  const { connection } = useConnection();
  const signer = useGameSigner();
  const { publicKey, connected, sendTransaction } = signer;
  // What the actions sign with: the address plus, for the Privy embedded
  // wallet, its sponsored send path. Keyed on the two so the action
  // callbacks below don't rebuild on every signer object Privy hands back.
  const txSigner = useMemo(
    () => (publicKey ? { publicKey, sendTransaction } : null),
    [publicKey, sendTransaction],
  );
  const [tab, setTab] = useState<Tab>(() =>
    tabFromHash(window.location.hash),
  );
  /** Which tab the deposit widget opens on; set by the dashboard's buttons. */
  const [vaultMode, setVaultMode] = useState<VaultMode>("deposit");
  const [soundOn, setSoundOnState] = useState(isSoundOn());
  // Dark only: the toggle is gone, but the light tokens and the
  // `data-theme` attribute stay so re-enabling it is a one-line change.
  const [theme] = useState<"light" | "dark">("dark");
  const [stakeText, setStakeText] = useState("1");
  const [autoRounds, setAutoRounds] = useState(0);
  /** The panel's +/- buttons. Only a user crossing zero counts as a toggle;
   *  the auto-rounds loop counting itself down to zero does not. */
  const setAutoRoundsByUser = (value: number) => {
    if (value > 0 !== autoRounds > 0) track("auto_rounds_toggled", { on: value > 0 });
    setAutoRounds(value);
  };
  const [addressCopied, setAddressCopied] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Phone bet drawer (spec.md "Drawer"): controlled here so the deploy
  // success path and the win takeover path can both close it.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Privy and wallet-adapter hand back a fresh signer object on every render,
  // so memoizing the provider on it rebuilt the Program every render — and the
  // chain reads keyed off that Program write state, so the app looped:
  // read → render → new Program → read, as fast as the RPC answered. Key the
  // provider on the address and reach the live signer through a ref, so one
  // Program survives across renders.
  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);
  const ownerAddress = signer.publicKey?.toBase58();
  const provider = useMemo(() => {
    const sign = async <T,>(tx: T): Promise<T> => {
      const signTransaction = signerRef.current.signTransaction;
      if (!signTransaction) throw new Error("wallet cannot sign transactions");
      return (await signTransaction(tx as never)) as T;
    };
    const wallet = {
      get publicKey() {
        return signerRef.current.publicKey;
      },
      signTransaction: sign,
      signAllTransactions: <T,>(txs: T[]) => Promise.all(txs.map(sign)),
    };
    return new AnchorProvider(connection, wallet as never, {
      commitment: "confirmed",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerAddress stands in for the signer, on purpose
  }, [connection, ownerAddress]);
  // The IDL's baked-in address is the dev program; override it with the same
  // VITE_PROGRAM_ID chain.ts uses for PDAs, so a transaction and the account
  // it reads can never disagree on which program they mean.
  const program = useMemo<HexVaultProgram | null>(
    () =>
      new Program(
        { ...idl, address: PROGRAM_ID.toBase58() },
        provider,
      ) as unknown as HexVaultProgram,
    [provider],
  );

  const ownerKey = publicKey?.toBase58();
  const statePoll = useStatePoll(apiBaseUrl(), ownerKey);
  const state = statePoll.data;
  // Ticket 14: refuses to sign against any Pool other than this
  // build's own configuration. `/state` is unauthenticated input; a
  // compromised or misconfigured backend could otherwise route a signature
  // at an attacker's Pool. A mismatch (or a bad RPC genesis hash below)
  // leaves `pool` null, which every money-action gate below already treats
  // as "nothing to sign against yet".
  const expectedPoolAddress = useMemo(() => poolAddress(POOL_ID), []);
  const poolResult = state
    ? poolFromDto(state.pool, state.priorityFeeMicroLamports, expectedPoolAddress)
    : null;
  const genesisMismatch = useGenesisCheck(connection);
  const pool = poolResult?.ok && !genesisMismatch ? poolResult.pool : null;
  const refusalReason = genesisMismatch ?? (poolResult && !poolResult.ok ? poolResult.reason : null);
  const player = state?.player ?? null;
  // The tracked Round: open, or the last one this session saw once it has
  // settled (see api.service.ts `getState`'s comment on `round`).
  const round = state?.round ? roundLikeFrom(state.round) : null;
  // Ticket 11: irreversible once true. Read off `/state`'s `status`, not
  // `pool.paused` — shutdown forces `paused` too, but the reason shown for
  // each is different (see `shutdown.ts`).
  const shutdown = state?.status.shutdown ?? false;
  // game-jackpot-pause: display only, so read straight off `/state` rather
  // than the signing-side `pool`, which a refused Pool leaves null.
  const gamePaused = state?.pool.gamePaused ?? false;
  const jackpotPaused = state?.pool.jackpotPaused ?? false;
  const now = useChainClock(state ? BigInt(state.chainTime) : null, round?.roundId ?? null);
  // The wallet balance is the one chain read left in the browser, so it
  // reloads when something actually moved, not on every poll: `snapshot` is
  // unchanged while only chain time and the heartbeat tick. The nonce covers
  // the faucet, which mints to the wallet without touching `/state` at all.
  const [balanceNonce, setBalanceNonce] = useState(0);
  const walletBalance = useWalletBalance(
    connection,
    state?.pool.mint ?? null,
    publicKey ?? undefined,
    `${state ? snapshot(state) : ""}:${balanceNonce}`,
  );
  // Ticket 15: rent for a first deposit or Position's account creation.
  const solBalance = useSolBalance(connection, publicKey ?? undefined, balanceNonce);
  const rentWarning = solRentWarning(solBalance, { sponsored: sendTransaction !== undefined });
  const status = useMemo(
    () => summarizeStatus(state?.status ?? null, Date.now()),
    [state?.status],
  );
  const loadFeed = useCallback(
    (signal: AbortSignal) => fetchFeed(apiBaseUrl(), 12, signal),
    [],
  );
  const feedPoll = useApiPoll(loadFeed, 2000);
  const feedRows = useMemo<FeedRow[]>(
    () => eventsToRows(feedPoll.data ?? [], ownerKey),
    [feedPoll.data, ownerKey],
  );
  const trackedPosition = state?.position
    ? { tiles: BigInt(state.position.tiles), stakePerTile: BigInt(state.position.stakePerTile) }
    : null;
  const engine = useRoundEngine({
    round,
    position: trackedPosition,
    owner: publicKey ?? undefined,
    closeBuffer: pool?.closeBuffer ?? 0n,
    clockNow: now,
    feed: feedRows,
  });

  // `takeover` only ever fires for the Player's own Position (useRoundEngine
  // sets it inside `if (won)`), so this is exactly spec.md's "a win takeover
  // for the Player's own Position closes the drawer".
  useEffect(() => {
    if (engine.takeover) setDrawerOpen(false);
  }, [engine.takeover]);

  const principal = player ? BigInt(player.principal) : 0n;
  const entries = player ? BigInt(player.entries) : 0n;
  const pendingWithdraw = player ? BigInt(player.pendingWithdraw) : 0n;
  const pendingEpoch = player ? BigInt(player.pendingEpoch) : 0n;
  const fmt = useCallback((value: bigint) => formatAtomic2(value, DECIMALS), []);

  // Header chip copies the full address; the truncated form is unusable for
  // funding. Clipboard needs a secure context, so fall back to a prompt.
  const copyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1200);
    } catch {
      window.prompt("Copy address", address);
    }
  }, []);

  const feed = engine.feed;

  // --- Actions ---------------------------------------------------------------
  const stake = parseAtomic(stakeText, DECIMALS) ?? 0n;
  const position = engine.activePosition;
  // `round` is the tracked Round (any status once revealed); a genuinely
  // open one for gating positions is status 0 specifically — Requested
  // (VRF already in flight) never reaches here in practice since positions
  // close before the operator requests it, but this keeps that guaranteed
  // rather than assumed.
  const openRound = round && round.status === 0 ? round : null;
  const locked = Boolean(position) && Boolean(openRound);
  const deployedTotal = position
    ? BigInt(position.tiles.toString(2).replace(/[^1]/g, "").length) *
      position.stakePerTile
    : 0n;
  const spend = stake * BigInt(engine.selected.length);

  // Red text is for things the user can act on. Round state (no open
  // round, closed, already placed) is what the deploy button label already
  // says, so it only goes on the button as a tooltip.
  const problems: string[] = [];
  if (shutdown) problems.push(SHUTDOWN_REASON);
  if (!pool) problems.push(refusalReason ?? "no pool found yet");
  if (spend > entries)
    problems.push("not enough Tickets — deposit to earn more");
  // ticket 15: a Position opens the round's account, which needs rent; a
  // wallet with only USDC (email login) fails there with no clear reason.
  if (!position && rentWarning) problems.push(rentWarning);
  // ticket 11: `buy_position` refuses outright once shut down, ahead of the
  // ordinary round-state reasons below.
  const deployHint = shutdown
    ? SHUTDOWN_REASON
    : !openRound
      ? gamePaused
        ? "the game is paused"
        : "no open round (the operator opens rounds)"
      : locked
        ? `position already placed in round #${openRound.roundId}`
        : phaseFor(openRound, now ?? 0n, pool?.closeBuffer ?? 0n) !== "mine"
          ? "positions are closed for this round"
          : null;

  /** Places `tiles` at `stakeAmount` per tile in the open round. Returns whether the transaction landed. */
  const deploy = useCallback(
    async (tiles: number[], stakeAmount: bigint, autoRound = false): Promise<boolean> => {
      if (!pool || !openRound || !txSigner || !program) return false;
      if (tiles.length === 0 || stakeAmount <= 0n) return false;
      setDeployBusy(true);
      setDeployNote(null);
      try {
        sfx("click");
        const tileMask = tiles.reduce(
          (acc, tile) => acc | (1n << BigInt(tile - 1)),
          0n,
        );
        let result = await buyPosition(
          program,
          txSigner,
          pool,
          openRound.roundId,
          tileMask,
          stakeAmount,
        );
        if (result.kind === "unknown") result = await awaitSendResult(program, result);
        if (result.kind !== "landed") {
          track("position_failed", { reason: failureReason(result) });
          setDeployNote(decodeSendFailure(result));
          return false;
        }
        track("position_placed", { tile_count: tiles.length, stake_per_tile: Number(formatAtomic(stakeAmount, DECIMALS)), is_topup: Boolean(position), auto_round: autoRound });
        // No predicted Tickets balance: the panel shows "confirming…" (see
        // `deployNote` below) until the next poll's Position actually moves.
        setDeployNote(null);
        lastDeployRef.current = { tiles: [...tiles], stake: stakeAmount };
        sfx("prime");
        statePoll.kick();
        return true;
      } catch (error) {
        track("position_failed", { reason: thrownReason(error) });
        setDeployNote(decodePlayerError(error));
        return false;
      } finally {
        setDeployBusy(false);
      }
    },
    [pool, openRound, txSigner, program, statePoll.kick, position],
  );

  // Auto-rounds: re-place the last board when a fresh round opens. The
  // counter and the "handled this round" marker only move after deploy()
  // reports the transaction was actually sent — a board that can't be
  // placed (see decideAutoRound) leaves both alone, so it retries next
  // round instead of silently eating one.
  const lastDeployRef = useRef<RememberedBoard | null>(null);
  const autoRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoRounds <= 0 || !pool || !openRound || deployBusy) return;
    const key = openRound.roundId.toString();
    if (autoRoundRef.current === key) return;
    const phase = phaseFor(openRound, now ?? 0n, pool.closeBuffer);
    const decision = decideAutoRound(
      lastDeployRef.current,
      entries,
      phase,
      Boolean(position),
    );
    if (decision.action === "skip") return;
    const { tiles, stake: stakeForRound } = decision;
    void (async () => {
      const placed = await deploy(tiles, stakeForRound, true);
      if (!placed) return;
      autoRoundRef.current = key;
      setAutoRounds((value) => value - 1);
      setStakeText(formatAtomic(stakeForRound, DECIMALS));
      engine.setSelected(tiles);
    })();
  }, [
    openRound,
    autoRounds,
    position,
    now,
    pool,
    entries,
    deployBusy,
    engine,
    deploy,
  ]);

  // Theme attribute + sound subscription.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => subscribeSound(setSoundOnState), []);

  // Keep the URL hash in sync with the tab (INVITE/#referrals, ticket
  // referral-page/01): write it on every tab change, and follow it back on
  // `hashchange` so the browser's back/forward buttons work too. Guarded by
  // a same-value check so setting the hash never fires a redundant
  // `hashchange` (window.location.hash assignment is a no-op history entry
  // when unchanged, but browsers differ on firing the event).
  useEffect(() => {
    const hash = hashForTab(tab);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, [tab]);
  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const canPick = Boolean(
    pool &&
      openRound &&
      !shutdown &&
      phaseFor(openRound, now ?? 0n, pool.closeBuffer) === "mine" &&
      !locked &&
      connected,
  );

  // A revealed round leaves the Position open until it is settled; that is the
  // permissionless instruction which credits the round reward as Entries. The
  // operator sweeps positions every tick, so the manual button only shows once
  // the round has been over long enough that the sweep is clearly behind.
  const settleState = useMemo(() => {
    if (!round || !position || !publicKey) return null;
    if (!isRevealed(round)) return null;
    if ((now ?? 0n) < round.endsAt + SETTLE_GRACE_SECONDS) return null;
    const reward = covers(position.tiles, round.winningTile)
      ? expectedReward(round, position)
      : 0n;
    return { roundId: round.roundId, winningTile: round.winningTile, reward };
  }, [round, position, publicKey, now]);
  const rewardHint = settleState
    ? settleState.reward > 0n
      ? `round #${settleState.roundId}: you covered tile ${displayTile(settleState.winningTile)} — settle for +${fmt(settleState.reward)} Tickets`
      : `round #${settleState.roundId}: settle to close your position and get its rent back`
    : null;

  const [settleBusy, setSettleBusy] = useState(false);
  const settle = useCallback(async () => {
    if (!settleState || !pool || !txSigner || !program) return;
    setSettleBusy(true);
    try {
      sfx("land");
      let result = await settlePosition(program, txSigner, pool, settleState.roundId);
      if (result.kind === "unknown") result = await awaitSendResult(program, result);
      if (result.kind !== "landed") {
        setDeployNote(decodeSendFailure(result));
        return;
      }
      track("position_settled", { won: settleState.reward > 0n, reward: Number(formatAtomic(settleState.reward, DECIMALS)) });
      setDeployNote(
        settleState.reward > 0n
          ? `round reward settled: +${fmt(settleState.reward)} Tickets`
          : "position settled",
      );
      if (settleState.reward > 0n) sfx("win");
      statePoll.kick();
    } catch (error) {
      setDeployNote(decodePlayerError(error));
    } finally {
      setSettleBusy(false);
    }
  }, [settleState, pool, txSigner, program, fmt, statePoll.kick]);

  // Shown in the deploy note area whenever a send is outstanding and no
  // error replaced it: no predicted Tickets balance, just an honest "still
  // waiting on the read model" (ticket 07).
  const confirmingNote = statePoll.pending
    ? statePoll.stillConfirming
      ? "still confirming…"
      : "confirming…"
    : null;

  return (
    <main className="app" data-tab={tab}>
      <header className="topbar">
        <button
          type="button"
          className="brand"
          aria-label="Home"
          onClick={() => setTab("HOME")}
        >
          <LogoCog size={34} />
          <span className="brand-logo">
            <LogoWordmark height={15} />
          </span>
        </button>
        <nav className="nav" aria-label="Sections">
          {TABS.map((candidate) => {
            // PLAY needs Tickets, or is gated off entirely; aria-disabled
            // (not `disabled`) keeps the button hoverable so the data-tip
            // tooltip (styles.css) shows. The gate wins over the entries
            // lock (ticket 01, feature-gates).
            const lock =
              candidate.id === "MINE" ? playLock(GAME_GATED, entries) : null;
            return (
              <button
                key={candidate.id}
                type="button"
                // INVITE / ABOUT move into the wallet menu on phones (styles.css).
                className={`nav-item${tab === candidate.id ? " active" : ""}${
                  candidate.id === "REFERRALS" || candidate.id === "ABOUT" ? " nav-item-menu" : ""
                }`}
                data-testid={`tab-${candidate.id.toLowerCase()}`}
                aria-disabled={lock !== null}
                data-tip={lock?.tip}
                onClick={lock !== null ? undefined : () => setTab(candidate.id)}
              >
                <span className="nav-item-long">{candidate.long}</span>
                <span className="nav-item-short">{candidate.short}</span>
              </button>
            );
          })}
        </nav>
        <div className="topbar-right">
          {connected ? (
            <>
              <span className="chip" data-testid="topbar-tickets">
                Tickets: {fmt(entries)}
              </span>
              <span className="chip" data-testid="topbar-balance">
                {SYMBOL}: {walletBalance === null ? "—" : fmt(walletBalance)}
              </span>
            </>
          ) : null}
          <button
            type="button"
            className="sound-toggle"
            data-testid="sound-toggle"
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              setSoundOnState(next);
            }}
            aria-pressed={soundOn}
            aria-label="Sound"
          >
            <SoundIcon on={soundOn} />
          </button>
          {signer.connected && signer.publicKey ? (
            <WalletMenu
              address={signer.publicKey.toBase58()}
              tickets={fmt(entries)}
              balance={walletBalance === null ? "—" : fmt(walletBalance)}
              symbol={SYMBOL}
              addressCopied={addressCopied}
              onCopy={(address) => void copyAddress(address)}
              // Not `kick()`: a faucet grant changes nothing `/state` carries,
              // so arming the change watch would leave "confirming…" up for
              // good. The balance is what moved, so reload just that.
              onFunded={() => setBalanceNonce((value) => value + 1)}
              onDisconnect={() => signer.disconnect()}
              onNavigate={setTab}
            />
          ) : (
            <span data-testid="wallet-connector">
              <button
                type="button"
                className="btn-connect"
                data-testid="connect-button"
                onClick={() =>
                  signer.connected ? signer.disconnect() : signer.connect()
                }
              >
                {signer.connected ? "DISCONNECT" : "CONNECT"}
              </button>
            </span>
          )}
        </div>
      </header>

      {statePoll.error ? (
        <div className="screen-note err" data-testid="state-error">
          {statePoll.error}
        </div>
      ) : null}

      {refusalReason ? (
        <div className="screen-note err" data-testid="pool-refusal-banner">
          {refusalReason}
        </div>
      ) : null}

      {shutdown ? (
        <div className="screen-note err" data-testid="shutdown-banner">
          {SHUTDOWN_BANNER}
        </div>
      ) : null}

      <main className="main-content-split">
        {tab === "HOME" ? (
          <Home
            now={now}
            currentEpoch={state?.currentEpoch ?? null}
            launchAt={state?.launchAt ?? null}
            jackpotPaused={jackpotPaused}
            onDeposit={() => setTab("DASHBOARD")}
          />
        ) : null}
        {tab === "DASHBOARD" ? (
          <Dashboard
            owner={publicKey ?? null}
            principal={principal}
            entries={entries}
            now={now}
            currentEpoch={state?.currentEpoch ?? null}
            launchAt={state?.launchAt ?? null}
            jackpotPaused={jackpotPaused}
            player={player}
            onDeposit={() => {
              setVaultMode("deposit");
              setTab("VAULT");
            }}
            onWithdraw={() => {
              setVaultMode("withdraw");
              setTab("VAULT");
            }}
            onPlay={() => setTab("MINE")}
            onViewDraws={() => setTab("DAILY DRAW")}
          />
        ) : null}
        {tab === "MINE" ? (
          <>
            <Arena
              engine={engine}
              canPick={canPick}
              operatorStale={status.stale}
              houseCutBps={pool?.houseCutBps ?? 0}
              idleLabel={
                state
                  ? idleBoardLabel(state.openRound !== null, state.currentEpoch !== null, gamePaused)
                  : null
              }
              onToggleTile={(n) => {
                sfx("click");
                engine.setSelected(
                  engine.selected.includes(n)
                    ? engine.selected.filter((tile) => tile !== n)
                    : [...engine.selected, n],
                );
              }}
            />
            <ControlPanel
              engine={engine}
              entries={entries}
              decimals={DECIMALS}
              stakeText={stakeText}
              setStakeText={setStakeText}
              autoRounds={autoRounds}
              setAutoRounds={setAutoRoundsByUser}
              canDeploy={canPick}
              deployProblems={problems}
              deployHint={deployHint}
              deployBusy={deployBusy}
              deployNote={deployNote ?? confirmingNote}
              locked={locked}
              deployedTotal={deployedTotal}
              lastWin={engine.lastWin}
              feed={feed}
              rewardHint={rewardHint}
              settleBusy={settleBusy}
              onSettle={() => void settle()}
              onDeploy={() => void deploy(engine.selected, stake)}
            />
            <StakeBarButton
              stakeText={stakeText}
              selected={engine.selected}
              position={position}
              phase={engine.phase}
              decimals={DECIMALS}
              onOpen={() => setDrawerOpen(true)}
            />
            <BetDrawer
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              soundOn={soundOn}
              onToggleSound={() => {
                const next = !soundOn;
                setSoundOn(next);
                setSoundOnState(next);
              }}
            >
              {(tab) => (
                <ControlPanel
                  tab={tab}
                  engine={engine}
                  entries={entries}
                  decimals={DECIMALS}
                  stakeText={stakeText}
                  setStakeText={setStakeText}
                  autoRounds={autoRounds}
                  setAutoRounds={setAutoRoundsByUser}
                  canDeploy={canPick}
                  deployProblems={problems}
                  deployHint={deployHint}
                  deployBusy={deployBusy}
                  deployNote={deployNote ?? confirmingNote}
                  locked={locked}
                  deployedTotal={deployedTotal}
                  lastWin={engine.lastWin}
                  feed={feed}
                  rewardHint={rewardHint}
                  settleBusy={settleBusy}
                  onSettle={() => void settle()}
                  onDeploy={() => {
                    // Confirmed deploy closes the drawer; a failed one leaves
                    // it open with deployNote's error visible (spec.md
                    // "Drawer": close states).
                    void deploy(engine.selected, stake).then((placed) => {
                      if (placed) setDrawerOpen(false);
                    });
                  }}
                />
              )}
            </BetDrawer>
          </>
        ) : null}
        {tab === "VAULT" ? (
          <Vault
            program={program}
            owner={publicKey ?? null}
            sendTransaction={sendTransaction}
            pool={pool}
            principal={principal}
            entries={entries}
            walletBalance={walletBalance}
            solBalance={solBalance}
            paused={pool?.paused ?? false}
            shutdown={shutdown}
            currentEpoch={state?.currentEpoch ?? null}
            pendingWithdraw={pendingWithdraw}
            pendingEpoch={pendingEpoch}
            initialMode={vaultMode}
            onConnect={() => signer.connect()}
            onDone={statePoll.kick}
            onPlay={() => setTab("MINE")}
          />
        ) : null}
        {tab === "DAILY DRAW" ? (
          <WeeklyDraw
            owner={publicKey ?? undefined}
            now={now}
            currentEpoch={state?.currentEpoch ?? null}
            jackpotPaused={jackpotPaused}
            player={player}
          />
        ) : null}
        {tab === "LEADERBOARD" ? (
          <Leaderboard owner={publicKey ?? undefined} />
        ) : null}
        {tab === "REFERRALS" ? (
          <Referrals
            owner={publicKey ?? null}
            onConnect={() => signer.connect()}
            onDeposit={() => setTab("DASHBOARD")}
          />
        ) : null}
        {tab === "ABOUT" ? <About /> : null}
      </main>
    </main>
  );
}
