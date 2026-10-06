import { utils as anchorUtils } from "@anchor-lang/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";

import { API_URL, POOL_ID } from "../chain.js";
import {
  classifyFastPauseError,
  fastPauseMessage,
  FAST_PAUSE_SWITCHES,
  postFastPause,
  type FastPauseSwitch,
} from "./fastPause.js";
import { Panel } from "./ui.js";
import { useOps } from "./useOps.js";

const LABEL: Record<FastPauseSwitch, string> = {
  pool: "Pool",
  game: "Game",
  jackpot: "Jackpot",
  deploy: "Deployment",
};

export function FastPausePanel() {
  const { pool, summary, refresh } = useOps();
  const { publicKey, signMessage } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const paused: Record<FastPauseSwitch, boolean | null> = {
    pool: pool ? pool.pool.paused : null,
    game: pool ? pool.pool.gamePaused : null,
    jackpot: pool ? pool.pool.jackpotPaused : null,
    deploy: summary ? summary.deployPaused : null,
  };

  const press = async (feature: FastPauseSwitch) => {
    if (!publicKey || !signMessage) return;
    const ok = window.confirm(
      `Pause ${LABEL[feature].toLowerCase()} on pool ${POOL_ID.toString()}? Only the Admin can lift it. Your wallet will ask you to sign a message.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const time = Math.floor(Date.now() / 1000);
      const bytes = await signMessage(
        new TextEncoder().encode(fastPauseMessage(feature, POOL_ID.toString(), time)),
      );
      const result = await postFastPause(API_URL, {
        switch: feature,
        wallet: publicKey.toBase58(),
        time,
        signature: anchorUtils.bytes.bs58.encode(bytes),
      });
      if (result.ok) {
        setDone(`${LABEL[feature]} paused. Transaction ${result.signature}`);
        await refresh();
      } else {
        setError(classifyFastPauseError(result.status, result.reason, feature));
      }
    } catch (err) {
      // Most often the wallet declining the signature request.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel id="fast-pause" title="Fast pause">
      {!publicKey ? (
        <p className="ops-sync">Connect a wallet on the list to pause.</p>
      ) : !signMessage ? (
        <p className="ops-error" role="status">
          This wallet cannot sign messages, so it cannot use Fast pause. Connect another wallet.
        </p>
      ) : null}
      <div className="ops-fast-pause">
        {FAST_PAUSE_SWITCHES.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`fast-pause-${s}`}
            disabled={busy || !publicKey || !signMessage || paused[s] !== false}
            onClick={() => void press(s)}
          >
            {paused[s] ? `${LABEL[s]} paused` : `Pause ${LABEL[s].toLowerCase()}`}
          </button>
        ))}
      </div>
      {error && (
        <p className="ops-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ops-sync" role="status" data-testid="fast-pause-done">
          {done}
        </p>
      )}
    </Panel>
  );
}
