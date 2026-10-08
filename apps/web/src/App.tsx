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
import { track } from "./analytics.js";
import { apiBaseUrl, fetchFeed } from "./api.js";
import { httpBetApi, sendBet } from "./bet.js";
import { CLUSTER, GAME_GATED, PROGRAM_ID, POOL_ID, poolAddress, type HexVaultProgram } from "./chain.js";
import { idl } from "./idl.js";
import {
  decideAutoRound,
  idleBoardLabel,
  openRoundFrom,
  phaseFor,
  positionsFrom,
  resultRoundFrom,
  tileCountOf,
  type FeedRow,
  type RememberedBoard,
} from "./engine.js";
import { formatAtomic, formatAtomic2, parseAtomic } from "./lib/money.js";
import { decodeBetRefusal, decodePlayerError, thrownReason } from "./playerErrors.js";
import { sfx, setSoundOn, subscribeSound, isSoundOn } from "./sfx.js";
import { SHUTDOWN_BANNER, SHUTDOWN_REASON } from "./shutdown.js";
import { SoundIcon } from "./SoundIcon.js";
import { WalletMenu } from "./WalletMenu.js";
import { poolFromDto, useSolBalance, useWalletBalance } from "./read.js";
import { useGenesisCheck } from "./useGenesisCheck.js";
import { useChainClock } from "./useChainClock.js";
import { useApiPoll } from "./useApiPoll.js";
import { snapshot, useStatePoll } from "./useStatePoll.js";
import { useRoundEngine } from "./useRoundEngine.js";
import { LEDGER_COPY } from "./session.js";
import { storage as browserStorage, useSession } from "./useSession.js";
import { useGameSigner } from "./wallets.js";
import { summarizeStatus } from "./status.js";
import { TABS, hashForTab, playLock, tabFromHash, type Tab } from "./tabs.js";

/** The accepted asset is USDC (6 decimals) for every pool in this build. */
const SYMBOL = "USDC";
const DECIMALS = 6;
/** The Game config's `roundSeconds` default. Only the epoch-tail label reads it. */
const ROUND_SECONDS = 60n;
export function App() {
  const { connection } = useConnection();
  const signer = useGameSigner();
  const { publicKey, connected, sendTransaction } = signer;
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
  // Phone bet drawer (spec.md "Drawer"): controlled here so the win takeover
  // path can close it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Ticket 15: one wallet prompt per 24 hours buys a browser-held session key.
  const betSession = useSession(signer);
  const { ensure: ensureSession } = betSession;
  // Opening the drawer asks for a delegation when none is live (or under five
  // minutes remain); a live one opens silently.
  useEffect(() => {
    if (drawerOpen && !betSession.cannotSign) void ensureSession();
  }, [drawerOpen, betSession.cannotSign, ensureSession]);

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
  // Ticket 11: irreversible once true. Read off `/state`'s `status`, not
  // `pool.paused` — shutdown forces `paused` too, but the reason shown for
  // each is different (see `shutdown.ts`).
  const shutdown = state?.status.shutdown ?? false;
  // game-jackpot-pause: display only, so read straight off `/state` rather
  // than the signing-side `pool`, which a refused Pool leaves null.
  const gamePaused = state?.pool.gamePaused ?? false;
  const jackpotPaused = state?.pool.jackpotPaused ?? false;
  const now = useChainClock(state ? BigInt(state.chainTime) : null, null);
  // Ticket 18: the Rounds come from the API. Their `closeAt` is on the
  // server's wall clock, so the countdown anchors to `serverTime` through its
  // own offset, re-anchored when a Round opens. `now` above stays chain time,
  // the clock epochs are on.
  const open = useMemo(() => openRoundFrom(state?.openRound ?? null), [state?.openRound]);
  const lastRound = useMemo(() => resultRoundFrom(state?.lastRound ?? null), [state?.lastRound]);
  const positions = useMemo(() => positionsFrom(state?.positions ?? []), [state?.positions]);
  const roundNow = useChainClock(state ? BigInt(state.serverTime) : null, open?.roundId ?? null);
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
  // Ticket 15: rent for a first deposit's account creation.
  const solBalance = useSolBalance(connection, publicKey ?? undefined, balanceNonce);
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
  const principal = player ? BigInt(player.principal) : 0n;
  // The read model's `weight` is the Player's Tickets from the backend's Ticket
  // ledger, the same number as `tickets`: the cutoff reset has already run.
  const tickets = player ? BigInt(player.weight) : 0n;
  const pendingWithdraw = player ? BigInt(player.pendingWithdraw) : 0n;
  const fmt = useCallback((value: bigint) => formatAtomic2(value, DECIMALS), []);

  const engine = useRoundEngine({
    open,
    last: lastRound,
    positions,
    owner: publicKey ?? undefined,
    clockNow: roundNow,
    tickets,
    feed: feedRows,
  });

  // `takeover` only ever fires for the Player's own Position (useRoundEngine
  // sets it inside `if (won)`), so this is exactly spec.md's "a win takeover
  // for the Player's own Position closes the drawer".
  useEffect(() => {
    if (engine.takeover) setDrawerOpen(false);
  }, [engine.takeover]);

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

  // --- Actions ---------------------------------------------------------------
  // A bet is a message the session key signs and `POST /game/bets` checks
  // (ADR 0025); there is no transaction, so no SOL balance matters here.
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  const lastDeployRef = useRef<RememberedBoard | null>(null);
  const autoRoundRef = useRef<string | null>(null);
  // The Round a bet names, read after the wallet prompt: approving a first
  // delegation can take longer than the countdown the click saw.
  const betTargetRef = useRef<bigint | null>(null);
  useEffect(() => {
    betTargetRef.current =
      state === null ? null : open && phaseFor(open, roundNow ?? 0n) === "mine" ? open.roundId : BigInt(state.nextRoundId);
  }, [state, open, roundNow]);
  const stake =parseAtomic(stakeText, DECIMALS) ?? 0n;
  const position = engine.position;
  // One bet per wallet per Round, so the panel locks on the open Round's.
  const locked = position !== null;
  const deployedTotal = position
    ? BigInt(tileCountOf(position.tiles)) * position.stakePerTile
    : 0n;
  const spend = stake * BigInt(engine.selected.length);
  // What a bet needs besides the board: a wallet that can sign, a live game.
  const canBet =
    connected && state !== null && !shutdown && !gamePaused && !betSession.cannotSign && !refusalReason;
  const canDeploy = canBet && !locked && spend <= tickets;

  // Red text is for things the player can act on. Round state is what the
  // board and the button already say.
  const problems: string[] = [];
  if (shutdown) problems.push(SHUTDOWN_REASON);
  if (refusalReason) problems.push(refusalReason);
  if (spend > tickets) problems.push("not enough Tickets — deposit to earn more");
  const deployHint = shutdown
    ? SHUTDOWN_REASON
    : gamePaused
      ? "the game is paused"
      : !connected
        ? "connect a wallet to play"
        : betSession.cannotSign
          ? "this wallet cannot play"
          : locked
            ? "your bet is in this round"
            : null;

  /**
   * Signs and posts a bet for `tiles` (display numbers 1..36) at `stakeAmount`
   * per tile. It names the open Round while its countdown runs, else the next
   * id, which opens a Round. Returns the Round the bet landed in, or null.
   */
  const deploy = useCallback(
    async (tiles: number[], stakeAmount: bigint, autoRound = false): Promise<bigint | null> => {
      if (!canBet || tiles.length === 0 || stakeAmount <= 0n || !state) return null;
      setDeployBusy(true);
      setDeployNote(null);
      try {
        sfx("click");
        // A live session answers silently; otherwise the wallet is asked once.
        const ensured = await ensureSession();
        if (!ensured?.ok) {
          track("position_failed", { reason: `session_${ensured?.reason ?? "unavailable"}` });
          setDeployNote(ensured ? ensured.message : decodeBetRefusal("SessionInvalid"));
          return null;
        }
        const target = betTargetRef.current;
        if (target === null) return null;
        const outcome = await sendBet(
          {
            api: httpBetApi(apiBaseUrl()),
            storage: browserStorage(),
            cluster: CLUSTER,
            programId: PROGRAM_ID.toBase58(),
            pool: expectedPoolAddress.toBase58(),
            session: ensured.session,
          },
          { tiles: tiles.map((tile) => tile - 1), stake: stakeAmount, round: target },
        );
        if (!outcome.ok) {
          track("position_failed", { reason: outcome.code });
          // The server no longer knows this key; the next bet asks the wallet again.
          if (outcome.code === "SessionInvalid") betSession.drop();
          setDeployNote(decodeBetRefusal(outcome.code));
          return null;
        }
        track("position_placed", {
          tile_count: tiles.length,
          stake_per_tile: Number(formatAtomic(stakeAmount, DECIMALS)),
          auto_round: autoRound,
        });
        // No predicted Tickets balance: the panel shows "confirming…" until the
        // next poll's balance actually moves.
        lastDeployRef.current = { tiles: [...tiles], stake: stakeAmount };
        sfx("prime");
        statePoll.kick();
        return outcome.roundId;
      } catch (error) {
        // A browser without WebCrypto Ed25519, or a network failure, lands here.
        track("position_failed", { reason: thrownReason(error) });
        setDeployNote(decodePlayerError(error));
        return null;
      } finally {
        setDeployBusy(false);
      }
    },
    [canBet, state, ensureSession, betSession, expectedPoolAddress, statePoll.kick],
  );

  // Auto-rounds: re-place the last board in the next Round. The counter only
  // moves once a bet lands. A board that fails is not retried until the next
  // Round, so a refused wallet prompt cannot loop.
  useEffect(() => {
    if (autoRounds <= 0 || !canBet || !state || deployBusy) return;
    const key = (open ? open.roundId : BigInt(state.nextRoundId)).toString();
    if (autoRoundRef.current === key) return;
    const decision = decideAutoRound(lastDeployRef.current, tickets, phaseFor(open, roundNow ?? 0n), locked);
    if (decision.action === "skip") return;
    const { tiles, stake: stakeForRound } = decision;
    autoRoundRef.current = key;
    void (async () => {
      const landed = await deploy(tiles, stakeForRound, true);
      if (landed === null) return;
      autoRoundRef.current = landed.toString();
      setAutoRounds((value) => value - 1);
      setStakeText(formatAtomic(stakeForRound, DECIMALS));
      engine.setSelected(tiles);
    })();
  }, [open, state, autoRounds, canBet, locked, roundNow, tickets, deployBusy, deploy, engine]);

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

  // Shown in the deploy note area whenever a send is outstanding: no
  // predicted Tickets balance, just an honest "still waiting on the read
  // model" (ticket 07).
  const confirmingNote = statePoll.pending
    ? statePoll.stillConfirming
      ? "still confirming…"
      : "confirming…"
    : null;

  const panelProps = {
    engine,
    tickets,
    decimals: DECIMALS,
    stakeText,
    setStakeText,
    autoRounds,
    setAutoRounds: setAutoRoundsByUser,
    canDeploy,
    deployProblems: problems,
    deployHint,
    deployBusy,
    deployNote: deployNote ?? confirmingNote,
    locked,
    deployedTotal,
    lastWin: engine.lastWin,
    feed: engine.feed,
    // A bet that lands closes the phone drawer; a refused one keeps it open with the note.
    onDeploy: () =>
      void deploy(engine.selected, stake).then((landed) => {
        if (landed !== null) setDrawerOpen(false);
      }),
  };

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
            // tooltip (styles.css) shows. The gate wins over the Tickets
            // lock (ticket 01, feature-gates).
            const lock =
              candidate.id === "MINE" ? playLock(GAME_GATED, tickets) : null;
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
                Tickets: {fmt(tickets)}
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
              tickets={fmt(tickets)}
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
            tickets={tickets}
            now={now}
            currentEpoch={state?.currentEpoch ?? null}
            launchAt={state?.launchAt ?? null}
            jackpotPaused={jackpotPaused}
            player={player}
            baseRateBps={pool?.baseRateBps ?? null}
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
              canPick={canBet && !locked}
              operatorStale={status.stale}
              idleLabel={
                state
                  ? idleBoardLabel(
                      open !== null,
                      state.currentEpoch !== null,
                      gamePaused,
                      now ?? 0n,
                      state.currentEpoch ? BigInt(state.currentEpoch.endsAt) : null,
                      ROUND_SECONDS,
                    )
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
            {betSession.cannotSign ? (
              <div className="screen-note err ledger-copy" data-testid="ledger-copy">
                {LEDGER_COPY}
              </div>
            ) : null}
            <ControlPanel {...panelProps} />
            <StakeBarButton
              stakeText={stakeText}
              selected={engine.selected}
              position={position}
              phase={engine.phase}
              decimals={DECIMALS}
              onOpen={() => setDrawerOpen(true)}
              disabled={betSession.cannotSign}
            />
            <BetDrawer
              open={drawerOpen && !betSession.cannotSign}
              onOpenChange={setDrawerOpen}
              session={{
                active: betSession.session !== null,
                busy: betSession.busy,
                error: betSession.error,
                onRevoke: () => void betSession.revoke(),
              }}
              soundOn={soundOn}
              onToggleSound={() => {
                const next = !soundOn;
                setSoundOn(next);
                setSoundOnState(next);
              }}
            >
              {(tab) => <ControlPanel tab={tab} {...panelProps} />}
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
            walletBalance={walletBalance}
            solBalance={solBalance}
            paused={pool?.paused ?? false}
            shutdown={shutdown}
            currentEpoch={state?.currentEpoch ?? null}
            pendingWithdraw={pendingWithdraw}
            initialMode={vaultMode}
            onConnect={() => signer.connect()}
            onDone={statePoll.kick}
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
