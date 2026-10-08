import { utils as anchorUtils } from "@anchor-lang/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";

import { API_URL, POOL_ID, poolAddress } from "../chain.js";
import {
  classifyGameConfigError,
  fetchGameConfig,
  formFromFields,
  parseForm,
  submitGameConfig,
  type FormValues,
  type GameConfigRow,
} from "./gameConfig.js";
import { Panel } from "./ui.js";

import "./admin.css";

const LABELS: readonly [keyof FormValues, string][] = [
  ["roundSeconds", "Round seconds (60 or more)"],
  ["houseCutBps", "House cut bps (0 to 10000)"],
  ["ticketsPerUsdc", "Tickets per USDC"],
  ["bonusCapBps", "Bonus cap bps (0 to 10000)"],
  ["maxTilesPerBet", "Max tiles per bet (1 to 36)"],
];

/**
 * The Game config form: fills the row in force, signs the edit with the
 * connected wallet and shows the row the backend stored. A change applies
 * from the next Round that opens.
 */
export function GameConfigPanel() {
  const { publicKey, signMessage } = useWallet();
  const [inForce, setInForce] = useState<GameConfigRow | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GameConfigRow | null>(null);

  const load = useCallback(async () => {
    const result = await fetchGameConfig(API_URL);
    if (!result.ok) return setError(`Could not read the Game config (${result.reason}).`);
    setInForce(result.data.inForce);
    if (result.data.inForce) setValues(formFromFields(result.data.inForce));
  }, []);
  useEffect(() => void load(), [load]);

  const submit = async (): Promise<void> => {
    if (!values || !publicKey || !signMessage) return;
    setError(null);
    setDone(null);
    const parsed = parseForm(values);
    if (!parsed.ok) return setError(parsed.error);
    setBusy(true);
    const result = await submitGameConfig({
      baseUrl: API_URL,
      pool: poolAddress(POOL_ID).toBase58(),
      wallet: publicKey.toBase58(),
      fields: parsed.fields,
      signMessage,
      encodeSignature: anchorUtils.bytes.bs58.encode,
      nowSeconds: Date.now() / 1000,
    });
    setBusy(false);
    if (result.ok) {
      setDone(result.row);
      setInForce(result.row);
      setValues(formFromFields(result.row));
    } else {
      setError(classifyGameConfigError(result.status, result.code, result.reason));
    }
  };

  const off = !publicKey
    ? "Connect a team wallet to change the Game config."
    : !signMessage
      ? "This wallet cannot sign messages. Use a software wallet."
      : null;

  return (
    <Panel id="game-config" title="Game config">
      <p className="ops-sync" data-testid="game-config-state">
        {inForce
          ? `In force: change ${inForce.id}${inForce.signer ? `, signed by ${inForce.signer}` : ", the seed row"}. A change applies from the next Round that opens.`
          : "Not loaded yet."}
      </p>
      {values && (
        <form
          className="ops-admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="ops-admin-fields">
            {LABELS.map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  data-testid={`game-config-${key}`}
                  inputMode="numeric"
                  value={values[key]}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <label>
            Referral tiers (JSON, highest tier first)
            <textarea
              data-testid="game-config-referralTiers"
              rows={8}
              value={values.referralTiers}
              onChange={(e) => setValues({ ...values, referralTiers: e.target.value })}
            />
          </label>
          <button type="submit" data-testid="game-config-submit" disabled={busy || off !== null}>
            Sign and apply
          </button>
          {off && <p className="ops-sync">{off}</p>}
        </form>
      )}
      {error && (
        <p className="ops-error" role="alert" data-testid="game-config-error">
          {error}
        </p>
      )}
      {done && (
        <p className="ops-sync" role="status" data-testid="game-config-done">
          Applied as change {done.id}: Round {done.roundSeconds} s, house cut {done.houseCutBps} bps,{" "}
          {done.ticketsPerUsdc} Tickets per USDC, bonus cap {done.bonusCapBps} bps, max {done.maxTilesPerBet} tiles.
        </p>
      )}
    </Panel>
  );
}
