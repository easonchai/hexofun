// Chain-reading half of `scripts/surf.sh`, the long-running Surfpool fork.
//
//   tsx tests/fork/surf.ts vrf                 fake ORAO fulfiller, runs until killed
//   tsx tests/fork/surf.ts warp <seconds>      jump the fork clock forward
//   tsx tests/fork/surf.ts warp-epoch <min>    jump to <min> minutes before the epoch ends
//   tsx tests/fork/surf.ts restore-clock       jump back to the chain time the last run reached
//
// Env: SURF_RPC (the fork), SURF_DIR (the .surf state dir), HEXVAULT_IDL_PATH.
//
// The fake fulfiller: a plain build sends a real ORAO `request_v2`, which
// creates a Pending `RandomnessV2` at ORAO's request PDA. ORAO's oracles never
// see the fork, so this rewrites that account as Fulfilled with random bytes,
// keeping its client and seed. `vrf::read_fulfilled` checks only the address
// and the layout, so the program settles as it would on mainnet.
// `surf.sh vrf off` creates $SURF_DIR/vrf-off, which pauses it.
//
// Surfpool's --db keeps accounts across a restart but not the clock: it comes
// back at wall time, so every warp is lost. The loop records chain time in
// $SURF_DIR/chain-time each pass, and `surf.sh up --resume` replays it.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, utils, type Idl } from "@anchor-lang/core";
import type { HexVault } from "../../target/types/hex_vault.js";

const ORAO_VRF = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const SEED_ORAO_REQUEST = Buffer.from("orao-vrf-randomness-request");
/** `[8 discriminator][1 tag][32 client][32 seed][64 randomness]`, vrf.rs. */
const FULFILLED_LEN = 8 + 1 + 32 + 32 + 64;
const DISCRIMINATOR = Buffer.from(utils.sha256.hash("account:RandomnessV2"), "hex").subarray(0, 8);

const rpc = must("SURF_RPC");
const surfDir = must("SURF_DIR");
const connection = new Connection(rpc, "confirmed");
// SAFETY: surf.sh copies this file from the same `anchor build` that wrote
// target/types/hex_vault.ts.
const idl = JSON.parse(readFileSync(must("HEXVAULT_IDL_PATH"), "utf8")) as Idl as HexVault;
// Read-only: the wallet never signs anything here.
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {});
const program = new Program<HexVault>(idl, provider);

function must(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function surf(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Seeds of every Round and Epoch that has asked for randomness. */
async function requestedSeeds(): Promise<{ label: string; seed: Buffer }[]> {
  const [rounds, epochs] = await Promise.all([
    program.account.round.all(),
    program.account.epoch.all(),
  ]);
  const out: { label: string; seed: Buffer }[] = [];
  for (const { account } of rounds) {
    const seed = Buffer.from(account.vrfSeed);
    if (seed.some((b) => b !== 0)) out.push({ label: `round ${account.roundId}`, seed });
  }
  for (const { account } of epochs) {
    const seed = Buffer.from(account.vrfSeed);
    if (seed.some((b) => b !== 0)) out.push({ label: `epoch ${account.epochId}`, seed });
  }
  return out;
}

/** Rewrites a Pending ORAO request as Fulfilled. False if not Pending. */
async function fulfill(seed: Buffer): Promise<boolean> {
  const address = PublicKey.findProgramAddressSync([SEED_ORAO_REQUEST, seed], ORAO_VRF)[0];
  const info = await connection.getAccountInfo(address);
  if (!info || !info.owner.equals(ORAO_VRF)) return false;
  if (!DISCRIMINATOR.equals(info.data.subarray(0, 8))) return false;
  if (info.data[8] === 1 && info.data.length === FULFILLED_LEN) return false;

  // Exactly FULFILLED_LEN: the Pending account is longer, and
  // `vrf::parse_fulfilled` slices everything past byte 73 into 64 bytes.
  const data = Buffer.alloc(FULFILLED_LEN);
  info.data.copy(data, 0, 0, FULFILLED_LEN - 64); // discriminator, tag, client, seed
  data[8] = 1; // Fulfilled
  randomBytes(64).copy(data, FULFILLED_LEN - 64);
  await surf("surfnet_setAccount", [
    address.toBase58(),
    { lamports: info.lamports, data: data.toString("hex"), owner: ORAO_VRF.toBase58(), executable: false },
  ]);
  return true;
}

async function vrfLoop(): Promise<never> {
  console.log("surf-vrf: watching for ORAO requests");
  for (;;) {
    try {
      writeFileSync(clockFile, String(await chainNow()));
      if (!existsSync(join(surfDir, "vrf-off"))) {
        for (const { label, seed } of await requestedSeeds()) {
          if (await fulfill(seed)) console.log(`surf-vrf: fulfilled ${label}`);
        }
      }
    } catch (error) {
      // The fork restarting or a slow lazy fetch; the next pass retries.
      console.error(`surf-vrf: ${(error as Error).message}`);
    }
    await sleep(2_000);
  }
}

const clockFile = join(surfDir, "chain-time");

/** The Clock sysvar's unix_timestamp. `getBlockTime` reads 0 after a resume. */
async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("no Clock sysvar");
  // slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp
  return Number(info.data.readBigInt64LE(32));
}

/** Never call `surfnet_timeTravel` with no params: it skips ~9,000 slots. */
async function warpTo(target: number): Promise<void> {
  const now = await chainNow();
  if (target <= now) throw new Error(`target ${target} is not after chain time ${now}`);
  await surf("surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
  await sleep(1_500);
  console.log(`warped ${target - now}s: chain time ${new Date((await chainNow()) * 1000).toISOString()}`);
}

async function currentEpochEnd(): Promise<number> {
  const pools = await program.account.pool.all();
  const pool = pools[0]?.account;
  if (!pool || BigInt(pool.currentEpochId) === 0n) throw new Error("no epoch yet: run `surf.sh admin start-jackpot`");
  const epochs = await program.account.epoch.all();
  const epoch = epochs.find((e) => BigInt(e.account.epochId) === BigInt(pool.currentEpochId));
  if (!epoch) throw new Error(`epoch ${pool.currentEpochId} not found`);
  return Number(epoch.account.endsAt);
}

const [command, arg] = process.argv.slice(2);
if (command === "vrf") {
  await vrfLoop();
} else if (command === "warp") {
  const seconds = Number(arg);
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("usage: warp <seconds>");
  await warpTo((await chainNow()) + seconds);
} else if (command === "warp-epoch") {
  const minutes = Number(arg ?? 8);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("usage: warp-epoch [minutes-before-end]");
  await warpTo((await currentEpochEnd()) - Math.round(minutes * 60));
} else if (command === "restore-clock") {
  const saved = existsSync(clockFile) ? Number(readFileSync(clockFile, "utf8")) : 0;
  if (saved > (await chainNow())) await warpTo(saved);
  else console.log("clock already at or past the last run's chain time");
} else {
  throw new Error(`unknown command "${command}"; vrf | warp <s> | warp-epoch [min] | restore-clock`);
}
