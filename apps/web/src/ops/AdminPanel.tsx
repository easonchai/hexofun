import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";

import { accountOf, POOL_ID, poolAddress } from "../chain.js";
import {
  adminMode,
  checkBounds,
  diffParams,
  encodeForSquads,
  fundJackpotIx,
  grantTicketsIx,
  parseAmount,
  parseUsdc,
  pauseIx,
  PARAMS_FIELDS,
  setParamsIx,
  setVenueParamsIx,
  VENUE_FIELDS,
  type Change,
  type Field,
  type PauseSwitch,
  type Values,
} from "./admin.js";
import { usdc } from "./format.js";
import { useSendTx } from "./tx.js";
import { Panel } from "./ui.js";
import { useOps } from "./useOps.js";

import "./admin.css";

const SWITCHES: readonly { sw: PauseSwitch; label: string }[] = [
  { sw: "pool", label: "Pool" },
  { sw: "game", label: "Game" },
  { sw: "jackpot", label: "Jackpot" },
  { sw: "deploy", label: "Deployment" },
  { sw: "buyTickets", label: "Bought tickets" },
];

const toBig = (raw: unknown): bigint | undefined => {
  if (typeof raw === "number") return BigInt(raw);
  if (typeof raw === "object" && raw !== null) return BigInt(raw.toString());
  return undefined;
};

/** The Pool's parameter fields straight from the account, so the forms diff against the chain. */
function usePoolValues(reload: unknown): { values: Values | null; error: string | null } {
  const { program } = useSendTx();
  const [state, setState] = useState<{ values: Values | null; error: string | null }>({
    values: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    accountOf(program, "pool")
      .fetch(poolAddress(POOL_ID))
      .then((raw) => {
        if (!live) return;
        const account = raw as Record<string, unknown>; // SAFETY: Anchor decodes the Pool account to an object keyed by the IDL's camelCase field names.
        const values: Values = {};
        for (const f of [...PARAMS_FIELDS, ...VENUE_FIELDS]) {
          const v = toBig(account[f.key]);
          if (v !== undefined) values[f.key] = v;
        }
        setState({ values, error: null });
      })
      .catch((cause: unknown) => {
        if (live) setState((s) => ({ ...s, error: cause instanceof Error ? cause.message : String(cause) }));
      });
    return () => {
      live = false;
    };
    // `program` changes with the wallet; `reload` bumps after a landed send.
  }, [program, reload]);
  return state;
}

interface Prepared {
  title: string;
  base58: string;
}

export function AdminPanel() {
  const { summary, pool } = useOps();
  const { connection } = useConnection();
  const tx = useSendTx();
  const { program, publicKey, pending, result, error } = tx;
  const { values, error: readError } = usePoolValues(result?.signature);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const adminKey = summary?.admin ?? null;
  const mode = adminMode(publicKey?.toBase58() ?? null, adminKey);
  const poolKey = poolAddress(POOL_ID);

  /**
   * Admin path: signs and sends when the wallet is the Admin, otherwise shows
   * the same instructions as base58 with the Admin as signer. `alwaysSign`
   * is for instructions the program does not gate on the Admin.
   */
  const run = async (
    title: string,
    build: (signer: PublicKey) => Promise<TransactionInstruction[]>,
    alwaysSign = false,
  ): Promise<void> => {
    setPrepared(null);
    setLocalError(null);
    setCopied(false);
    setBusy(true);
    try {
      if (alwaysSign || mode === "sign") {
        if (!publicKey) throw new Error("Connect a wallet first");
        await tx.send(await build(publicKey));
        return;
      }
      if (!adminKey) throw new Error("The Admin is not known yet");
      const admin = new PublicKey(adminKey);
      const ixs = await build(admin);
      // Finalized, as the CLI does: Squads simulates the import on its own node.
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      setPrepared({ title, base58: encodeForSquads(ixs, admin, blockhash) });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stateOf = (sw: PauseSwitch): boolean | null => {
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

  const disabled = busy || pending || mode === "unknown" || !pool;
  const verb = mode === "sign" ? "" : "Prepare ";

  return (
    <Panel id="admin" title="Admin actions">
      <p className="ops-sync" data-testid="admin-mode">
        {mode === "sign"
          ? "Signing as the Admin. Each action is sent from your wallet."
          : mode === "prepare"
            ? "Preparing a transaction for the Admin. Your wallet is not the Admin, so each action shows base58 to paste into Squads."
            : "Waiting for the Admin address."}
      </p>

      <div className="ops-admin-switches">
        {SWITCHES.map(({ sw, label }) => {
          const paused = stateOf(sw);
          return (
            <div className="ops-row" key={sw}>
              <span>{label}</span>
              <span data-halted={paused || undefined}>{paused === null ? "unavailable" : paused ? "Paused" : "Running"}</span>
              <button
                type="button"
                data-testid={`admin-${sw}`}
                disabled={disabled || paused === null || (mode === "sign" && !publicKey)}
                onClick={() =>
                  void run(`${paused ? "Start" : "Pause"} ${label.toLowerCase()}`, async (signer) => [
                    await pauseIx(program, sw, !paused, signer, poolKey),
                  ])
                }
              >
                {verb}
                {paused ? (mode === "sign" ? "Start" : "start") : mode === "sign" ? "Pause" : "pause"}
              </button>
            </div>
          );
        })}
      </div>

      {readError && !values && (
        <p className="ops-error" role="status">
          Could not read the Pool account for the parameter forms ({readError}).
        </p>
      )}
      {values && (
        <>
          <ParamForm
            id="params"
            title="Set params"
            kind="params"
            fields={PARAMS_FIELDS}
            current={values}
            mode={mode}
            disabled={disabled}
            onSubmit={(changes) =>
              run("Set params", async (signer) => [await setParamsIx(program, signer, poolKey, changes)])
            }
            sent={result?.signature}
          />
          <ParamForm
            id="venue"
            title="Set venue params"
            kind="venue"
            fields={VENUE_FIELDS}
            current={values}
            mode={mode}
            disabled={disabled}
            onSubmit={(changes) =>
              run("Set venue params", async (signer) => [await setVenueParamsIx(program, signer, poolKey, changes)])
            }
            sent={result?.signature}
          />
        </>
      )}

      <FundJackpotForm
        disabled={busy || pending || !publicKey || !pool}
        onSubmit={(amount) =>
          run(
            "Fund jackpot",
            async (signer) => {
              if (!pool) throw new Error("The pool is not loaded yet");
              return [await fundJackpotIx(program, signer, poolKey, new PublicKey(pool.pool.mint), amount)];
            },
            true,
          )
        }
      />
      <GrantTicketsForm
        mode={mode}
        disabled={disabled || !pool?.pool.weightTree}
        onSubmit={(owner, amount) =>
          run("Grant tickets", async (signer) => {
            if (!pool?.pool.weightTree) throw new Error("The pool's Weight tree is not indexed yet");
            return [await grantTicketsIx(program, signer, poolKey, new PublicKey(pool.pool.weightTree), owner, amount)];
          })
        }
      />

      {(error || localError) && (
        <p className="ops-error" role="alert" data-testid="admin-error">
          {localError ?? error}
        </p>
      )}
      {result && (
        <p className="ops-sync" role="status" data-testid="admin-done">
          Landed. <a href={result.url} target="_blank" rel="noopener noreferrer">{result.signature}</a>
        </p>
      )}
      {prepared && (
        <div className="ops-admin-prepared" data-testid="admin-prepared">
          <p className="ops-sync">
            {prepared.title}: unsigned legacy transaction, signer and fee payer {adminKey}. Paste it into
            Squads with Import base58 encoded tx. The blockhash expires in about a minute.
          </p>
          <textarea readOnly rows={5} value={prepared.base58} aria-label="Base58 transaction" />
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(prepared.base58).then(
                () => setCopied(true),
                () => setLocalError("The browser blocked the clipboard. Select the text and copy it by hand."),
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <p className="ops-sync">
        Shutdown, sweep-house, emergency-crank, set-operator, propose-admin, accept-admin,
        set-treasury-accounts and create-invite live in the CLI.
      </p>
    </Panel>
  );
}

function ParamForm({
  id,
  title,
  kind,
  fields,
  current,
  mode,
  disabled,
  onSubmit,
  sent,
}: {
  id: string;
  title: string;
  kind: "params" | "venue";
  fields: readonly Field[];
  current: Values;
  mode: ReturnType<typeof adminMode>;
  disabled: boolean;
  onSubmit: (changes: Change[]) => Promise<void>;
  /** A landed signature: clears the edits so the form shows the new chain values. */
  sent: string | undefined;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => setEdits({}), [sent]);
  const inputs = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.key, edits[f.key] ?? current[f.key]?.toString() ?? ""])),
    [fields, edits, current],
  );
  const { changes, errors } = useMemo(() => diffParams(fields, current, inputs), [fields, current, inputs]);
  const bounds = useMemo(() => checkBounds(kind, current, changes), [kind, current, changes]);
  const problems = [...errors, ...bounds];

  return (
    <form
      className="ops-admin-form"
      data-testid={`admin-form-${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (changes.length > 0 && problems.length === 0) void onSubmit(changes);
      }}
    >
      <h3>{title}</h3>
      <div className="ops-admin-fields">
        {fields.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <input
              inputMode="numeric"
              value={inputs[f.key]}
              data-testid={`admin-${id}-${f.key}`}
              onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      {changes.length === 0 ? (
        <p className="ops-sync">No changes yet. Nothing will be sent.</p>
      ) : (
        <table className="ops-admin-diff" data-testid={`admin-diff-${id}`}>
          <thead>
            <tr>
              <th>Field</th>
              <th>Now</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const f = fields.find((x) => x.key === c.key);
              const show = (n: bigint) => (f?.usdc ? `${n} (${usdc(n.toString())})` : n.toString());
              return (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td>{show(c.old)}</td>
                  <td>{show(c.next)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {problems.length > 0 && (
        <ul className="ops-error" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <button type="submit" disabled={disabled || changes.length === 0 || problems.length > 0}>
        {mode === "sign" ? "Sign and send" : "Prepare for Squads"}
      </button>
    </form>
  );
}

function FundJackpotForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (amount: bigint) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const amount = parseUsdc(text);
  return (
    <form
      className="ops-admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount !== null) void onSubmit(amount);
      }}
    >
      <h3>Fund jackpot</h3>
      <p className="ops-sync">Signs with the connected wallet and pays from its USDC account. Any wallet can do this.</p>
      <label>
        <span>Amount (USDC)</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} data-testid="admin-fund-amount" />
      </label>
      <button type="submit" disabled={disabled || amount === null}>
        Fund jackpot
      </button>
    </form>
  );
}

function GrantTicketsForm({
  mode,
  disabled,
  onSubmit,
}: {
  mode: ReturnType<typeof adminMode>;
  disabled: boolean;
  onSubmit: (owner: PublicKey, amount: bigint) => Promise<void>;
}) {
  const [wallet, setWallet] = useState("");
  const [text, setText] = useState("");
  const amount = parseAmount(text);
  const owner = useMemo(() => {
    try {
      return wallet.trim() ? new PublicKey(wallet.trim()) : null;
    } catch {
      return null;
    }
  }, [wallet]);
  return (
    <form
      className="ops-admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (owner && amount !== null) void onSubmit(owner, amount);
      }}
    >
      <h3>Grant tickets</h3>
      <label>
        <span>Player wallet</span>
        <input value={wallet} onChange={(e) => setWallet(e.target.value)} data-testid="admin-grant-wallet" />
      </label>
      <label>
        <span>Tickets</span>
        <input inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} data-testid="admin-grant-amount" />
      </label>
      {wallet.trim() && !owner && <p className="ops-error" role="alert">That is not a valid wallet address.</p>}
      <button type="submit" disabled={disabled || !owner || amount === null}>
        {mode === "sign" ? "Grant tickets" : "Prepare grant"}
      </button>
    </form>
  );
}
