/**
 * The routine cranks, signed by the connected wallet: Deploy, Recall, Harvest
 * and Process withdraw. The Operator bot normally runs these; a button lights
 * when the banner says one is due and the bot cannot be trusted with it. Each
 * builds its instructions at click time from a fresh read of the Pool account
 * (`instructions.ts`), so nothing here caches chain state.
 */
import { PublicKey as Key } from "@solana/web3.js";
import { useEffect, useState } from "react";

import { formatAtomic } from "../lib/money.js";
import { USDC_DECIMALS } from "./format.js";
import { TxStatus, useCrank, wrap } from "./crank.js";
import { deployToVenue, harvest, parseUsdcAmount, processWithdraw, recall } from "./instructions.js";
import { dueFor } from "./opsMap.js";
import { Panel, Why, whyOff } from "./ui.js";
import { useOps } from "./useOps.js";

export function CranksPanel() {
  const { summary: s } = useOps();
  const crank = useCrank();
  const { tx, run, off } = crank;
  const [amount, setAmount] = useState("");
  const [withdrawOwner, setWithdrawOwner] = useState("");

  // A todo due now lights its button and fills an empty field with its figure.
  const todo = s?.todo ?? [];
  const deployDue = dueFor(todo, "deploy");
  const recallDue = dueFor(todo, "recall");
  const withdrawDue = dueFor(todo, "withdraw");
  const dueAmount = (deployDue ?? recallDue)?.amount;
  const dueOwner = withdrawDue?.owner;
  useEffect(() => {
    if (dueAmount) setAmount((a) => (a === "" ? formatAtomic(BigInt(dueAmount), USDC_DECIMALS) : a));
  }, [dueAmount]);
  useEffect(() => {
    if (dueOwner) setWithdrawOwner((o) => (o === "" ? dueOwner : o));
  }, [dueOwner]);

  const parsed = parseUsdcAmount(amount);
  const ownerKey = (() => {
    try {
      return withdrawOwner.trim() ? new Key(withdrawOwner.trim()) : null;
    } catch {
      return null;
    }
  })();
  const withdrawWhy = whyOff(
    [withdrawOwner.trim() === "", "Enter the player's wallet."],
    [ownerKey === null, "That is not a valid wallet address."],
  );

  return (
    <Panel id="cranks" title="Routine cranks">
      <p className="ops-sync">The Operator bot runs these. Press one only when the banner names it.</p>
      {!tx.ready && <p className="ops-sync">Connect a wallet to act.</p>}

      <label>
        Amount (USDC)
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          data-testid="crank-amount"
        />
      </label>
      <div className="ops-actions">
        <button
          type="button"
          id="ops-action-deploy"
          data-due={deployDue ? true : undefined}
          disabled={off || parsed === null}
          onClick={() => parsed !== null && void run(async (p, pool) => [await deployToVenue(p, pool, parsed)])}
        >
          Deploy to venue
        </button>
        <button
          type="button"
          id="ops-action-recall"
          data-due={recallDue ? true : undefined}
          disabled={off || parsed === null}
          onClick={() => parsed !== null && void run(async (p, pool) => [await recall(p, pool, parsed)])}
        >
          Recall
        </button>
        <button
          type="button"
          data-testid="crank-harvest"
          id="ops-action-harvest"
          data-due={dueFor(todo, "harvest") ? true : undefined}
          disabled={off}
          onClick={() => void run(wrap(harvest))}
        >
          Harvest
        </button>
      </div>
      <Why reason={whyOff([parsed === null, "Deploy and Recall are off. Enter an amount in USDC."])} />

      <label>
        Player wallet
        <input
          value={withdrawOwner}
          onChange={(e) => setWithdrawOwner(e.target.value)}
          placeholder="Wallet address"
          spellCheck={false}
        />
      </label>
      <div className="ops-actions">
        <button
          type="button"
          id="ops-action-withdraw"
          data-due={withdrawDue ? true : undefined}
          disabled={off || ownerKey === null}
          onClick={() => ownerKey && void run((p, pool, caller) => processWithdraw(p, pool, caller, ownerKey))}
        >
          Process withdraw
        </button>
      </div>
      <Why reason={withdrawWhy} />

      <TxStatus crank={crank} />
    </Panel>
  );
}
