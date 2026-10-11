#!/usr/bin/env node
// Writes the subgraph test fixtures: one pool's life (create, epoch, two
// deposits, a ticket buy, a harvest, a draw, a payout) as the mapping sees
// each transaction: slot, signature, top-level instructions, log lines.
//
//   node subgraph/tests/make-fixtures.mjs
//
// Generated, not captured: public devnet answered 429 to every getTransaction
// on 2026-10-10. Events are encoded by Anchor's own borsh coder from the IDL,
// so the Rust decoder is checked against an independent encoder. Instruction
// data is the 8-byte discriminator alone; the mapping reads nothing past it.
// Signatures are sha512 of the fixture name, so reruns write the same files.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BN, BorshCoder, utils } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(fs.readFileSync(path.join(here, "../../apps/web/src/idl/hex_vault.json"), "utf8"));
const coder = new BorshCoder(idl);
const program = idl.address;
const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const klend = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";

// Deterministic stand-in keys, one per account name.
const key = (name) => new PublicKey(crypto.createHash("sha256").update(name).digest());
const pool = key("pool");
const alice = key("alice");
const operator = key("operator");

const event = (name, data) => {
  const def = idl.events.find((e) => e.name === name);
  const body = coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(def.discriminator), body]).toString("base64")}`;
};

const instruction = (name, signer) => {
  const ix = idl.instructions.find((i) => i.name === name);
  const accounts = ix.accounts.map((a) => (a.name === "pool" ? pool : a.signer ? signer : key(a.name)).toBase58());
  return { data: Buffer.from(ix.discriminator).toString("base64"), accounts };
};

const title = (name) => name.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase());

const write = (fixture, slot, ixName, signer, events, cpi = []) => {
  const signature = utils.bytes.bs58.encode(crypto.createHash("sha512").update(fixture).digest());
  const ix = instruction(ixName, signer);
  const lines = [
    `signature ${signature}`,
    `slot ${slot}`,
    `ix ComputeBudget111111111111111111111111111111 AsBRAgA= `,
    `ix ${program} ${ix.data} ${ix.accounts.join(",")}`,
    "log Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "log Program ComputeBudget111111111111111111111111111111 success",
    `log Program ${program} invoke [1]`,
    `log Program log: Instruction: ${title(ixName)}`,
    ...cpi.map((l) => `log ${l}`),
    ...events.map((l) => `log ${l}`),
    `log Program ${program} consumed 61234 of 200000 compute units`,
    `log Program ${program} success`,
  ];
  fs.writeFileSync(path.join(here, "fixtures", `${fixture}-${signature}.txt`), lines.join("\n") + "\n");
};

const transfer = [
  `Program ${token} invoke [2]`,
  "Program log: Instruction: TransferChecked",
  `Program ${token} consumed 6200 of 150000 compute units`,
  `Program ${token} success`,
];
const index = new BN("1000000000000000000");
const usdc = (n) => new BN(n * 1_000_000);

fs.rmSync(path.join(here, "fixtures"), { recursive: true, force: true });
fs.mkdirSync(path.join(here, "fixtures"));

write("create_pool", 509_560_000, "create_pool", operator, [
  event("PoolCreated", { pool, pool_id: new BN(1), admin: operator, operator, accepted_mint: key("accepted_mint") }),
]);
write("begin_epoch", 509_560_100, "begin_epoch", operator, [
  event("EpochBegan", { epoch_id: new BN(1), starts_at: new BN(1791590400), ends_at: new BN(1791676800), yield_index: index }),
]);
write("deposit", 509_570_000, "deposit", alice, [
  ...transfer,
  event("Deposited", { owner: alice, amount: usdc(250), principal: usdc(250), yield_index: index }),
]);
write("deposit_again", 509_571_000, "deposit", alice, [
  ...transfer,
  event("Deposited", { owner: alice, amount: usdc(50), principal: usdc(300), yield_index: index }),
]);
write("buy_tickets", 509_572_000, "buy_tickets", alice, [
  ...transfer,
  event("TicketsBought", { owner: alice, epoch_id: new BN(1), usdc: usdc(5), principal: usdc(300), yield_index: index }),
]);
// A Kamino CPI line first: it must decode to nothing.
write("harvest", 509_580_000, "harvest", operator, [
  `Program ${klend} invoke [2]`,
  "Program data: AQIDBAUGBwgJCgsMDQ4PEBESExQ=",
  `Program ${klend} success`,
  event("Synced", {
    pool, gain: new BN(1_234_567), fee: new BN(123_456), depositor_share: new BN(900_000), prize_share: new BN(211_111),
    yield_index: index, venue_value: usdc(300), deficit_repaid: new BN(0),
  }),
  event("Harvested", {
    pool, gain: new BN(1_234_567), fee: new BN(123_456), depositor_share: new BN(900_000), prize_share: new BN(211_111), fee_paid: new BN(123_456),
    prize_paid: new BN(211_111),
  }),
]);
write("draw", 509_760_100, "draw", operator, [
  event("EpochDrawn", { epoch_id: new BN(1), target: new BN(3_141_592), total_tickets: new BN(5_000_000) }),
]);
write("payout", 509_760_200, "payout", operator, [
  ...transfer,
  event("JackpotPaid", {
    epoch_id: new BN(1), winner: alice, amount: usdc(42), is_house: false, compounded: true, principal: usdc(342),
    yield_index: index, index: 0, tickets: new BN(5_000_000),
  }),
]);

console.log(`make-fixtures: wrote ${fs.readdirSync(path.join(here, "fixtures")).length} fixtures`);
