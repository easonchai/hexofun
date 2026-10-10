import { utils as anchorUtils } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";

import { API_URL, POOL_ID, poolAddress } from "../chain.js";
import { encodeForSquads, pauseIx, type PauseSwitch } from "./admin.js";
import { classifyFastPauseError, postFastPause, signFastPause } from "./fastPause.js";
import { PAUSE_LABEL, pauseConfirm } from "./opsCopy.js";
import { isFastPauseSwitch, pausePath, type PausePathKind } from "./pausePath.js";
import { PreparedTx } from "./PreparedTx.js";
import { roleOf } from "./role.js";
import { useSendTx } from "./tx.js";
import { Panel } from "./ui.js";
import { useOps } from "./useOps.js";

const SWITCHES: readonly PauseSwitch[] = ["pool", "game", "jackpot", "deploy", "buyTickets"];

/** The button's words: what pressing it does for this wallet. */
function actionLabel(kind: PausePathKind, paused: boolean | null, label: string): string {
  const verb = paused ? "Start" : "Pause";
  if (kind === "fast") return `Fast pause ${label.toLowerCase()}`;
  if (kind === "prepare") return "Prepare for Squads";
  return `${verb} ${label.toLowerCase()}`;
}

/** The five pause switches: state, and the one action the connected wallet has for each. */
export function PausePanel() {
  const { pool, summary, refresh } = useOps();
  const { connection } = useConnection();
  const { publicKey, signMessage } = useWallet();
  const tx = useSendTx();
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<{ title: string; base58: string } | null>(null);

  const adminKey = summary?.admin ?? null;
  const role = roleOf(publicKey?.toBase58() ?? null, summary);
  const poolKey = poolAddress(POOL_ID);

  const pausedOf = (sw: PauseSwitch): boolean | null => {
    switch (sw) {
      case "pool":
        return pool ? pool.pool.paused : null;
      case "game":
        return pool ? pool.pool.gamePaused : null;
      case "jackpot":
        return pool ? pool.pool.jackpotPaused : null;
      case "deploy":
        return summary ? summary.deployPaused : null;
      case "buyTickets":
        return pool ? pool.live.buyTicketsPaused : null;
    }
  };

  const press = async (sw: PauseSwitch, kind: PausePathKind, paused: boolean): Promise<void> => {
    if (!window.confirm(pauseConfirm(kind, sw, paused, POOL_ID.toString()))) return;
    const title = `${paused ? "Start" : "Pause"} ${PAUSE_LABEL[sw].toLowerCase()}`;
    setBusy(true);
    setSigned(false);
    setError(null);
    setDone(null);
    setPrepared(null);
    try {
      if (kind === "sign") {
        if (!publicKey) throw new Error("Connect a wallet first");
        setSigned(true);
        await tx.send([await pauseIx(tx.program, sw, !paused, publicKey, poolKey)]);
      } else if (kind === "fast") {
        if (!publicKey || !signMessage || !isFastPauseSwitch(sw)) return;
        const time = Math.floor(Date.now() / 1000);
        const bytes = await signFastPause(signMessage, sw, time);
        const result = await postFastPause(API_URL, {
          switch: sw,
          wallet: publicKey.toBase58(),
          time,
          signature: anchorUtils.bytes.bs58.encode(bytes),
        });
        if (result.ok) {
          setDone(`${PAUSE_LABEL[sw]} paused. Transaction ${result.signature}`);
          await refresh();
        } else {
          setError(classifyFastPauseError(result.status, result.reason, sw));
        }
      } else {
        if (!adminKey) throw new Error("The Admin is not known yet");
        const admin = new PublicKey(adminKey);
        const ix = await pauseIx(tx.program, sw, !paused, admin, poolKey);
        // Finalized, as the CLI does: Squads simulates the import on its own node.
        const { blockhash } = await connection.getLatestBlockhash("finalized");
        setPrepared({ title, base58: encodeForSquads([ix], admin, blockhash) });
      }
    } catch (cause) {
      // Most often the wallet declining the signature request.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel id="pause" title="Pause">
      <div className="ops-pause">
        {SWITCHES.map((sw) => {
          const paused = pausedOf(sw);
          const path = pausePath(role, sw, paused, signMessage !== undefined);
          // Without the Admin's key there is nothing to prepare for.
          const unknownAdmin = path.kind === "prepare" && !adminKey;
          const note = unknownAdmin ? "Waiting for the Admin address" : path.note;
          return (
            <div className="ops-pause-row" key={sw}>
              <span>{PAUSE_LABEL[sw]}</span>
              <span data-halted={paused || undefined}>
                {paused === null ? "unavailable" : paused ? "Paused" : "Running"}
              </span>
              <button
                type="button"
                id={`ops-action-pause-${sw}`}
                data-testid={`pause-${sw}`}
                disabled={busy || tx.pending || path.kind === "none" || unknownAdmin}
                onClick={() => paused !== null && void press(sw, path.kind, paused)}
              >
                {actionLabel(path.kind, paused, PAUSE_LABEL[sw])}
              </button>
              {note && <p className="ops-sync">{note}</p>}
            </div>
          );
        })}
      </div>
      {(error || (signed && tx.error)) && (
        <p className="ops-error" role="alert" data-testid="pause-error">
          {error ?? tx.error}
        </p>
      )}
      {signed && tx.result && (
        <p className="ops-sync" role="status" data-testid="pause-done">
          Landed. <a href={tx.result.url} target="_blank" rel="noopener noreferrer">{tx.result.signature}</a>
        </p>
      )}
      {done && (
        <p className="ops-sync" role="status" data-testid="pause-done">
          {done}
        </p>
      )}
      {prepared && <PreparedTx {...prepared} adminKey={adminKey} />}
    </Panel>
  );
}
