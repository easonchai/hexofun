// The Sparring player's whole decision: given a state, it either buys one
// Position or does nothing. The instruction is the real one, decoded back out
// of the recorded transaction, so a wrong account list or a bad tile mask
// still shows up here.
import {
  AnchorProvider,
  BorshInstructionCoder,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import { playerAddress, poolAddress, positionAddress, roundAddress } from "../chain/pda";
import {
  ROUND_STATUS,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";
import {
  ALL_TILES,
  STAKE_PER_TILE,
  playSparring,
  type SparringContext,
} from "./sparring";

const AUTHORITY = Keypair.generate().publicKey;
const SPARRING = Keypair.generate().publicKey;
const WEIGHT_TREE = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const ROUND = roundAddress(PROGRAM_ID, POOL, 3n);

// No RPC is reached: every account is passed explicitly.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);
const coder = new BorshInstructionCoder(idl);
const instructions = new OperatorInstructions(
  program,
  PROGRAM_ID,
  AUTHORITY,
  true,
);

const NOW = 1_800_000_000n;

const pool = (over: Partial<PoolState> = {}): PoolState => ({
  address: POOL,
  admin: AUTHORITY,
  operator: AUTHORITY,
  acceptedMint: Keypair.generate().publicKey,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: 3_600n,
  roundSeconds: 60n,
  closeBuffer: 5n,
  vrfTimeout: 120n,
  payoutTimeout: 86_400n,
  paused: false,
  currentEpochId: 2n,
  nextRoundId: 4n,
  openRoundId: 3n,
  totalPrincipal: 1_000_000_000n,
  shutdown: false,
  gamePaused: false,
  jackpotPaused: false,
  weightTree: WEIGHT_TREE,
  klendProgram: PublicKey.default,
  klendMarket: PublicKey.default,
  klendReserve: PublicKey.default,
  klendCtoken: PublicKey.default,
  pendingWithdrawals: 0n,
  venueValue: 0n,
  feeOwed: 0n,
  prizeOwed: 0n,
  idleFloorBps: 500,
  idleTargetBps: 1_000,
  minVenueMove: 100_000_000n,
  deployPaused: false,
  impaired: false,
  ...over,
});

const round = (over: Partial<RoundState> = {}): RoundState => ({
  roundId: 3n,
  endsAt: NOW + 30n,
  status: ROUND_STATUS.OPEN,
  vrfSeed: new Uint8Array(32).fill(5),
  requestedAt: 0n,
  ...over,
});

/** Runs one pass and hands back whatever single transaction it sent. */
async function play(over: Partial<SparringContext> = {}): Promise<{
  bought: boolean;
  sent: TransactionInstruction[][];
}> {
  const sent: TransactionInstruction[][] = [];
  const bought = await playSparring({
    now: NOW,
    pool: pool(),
    openRound: round(),
    owner: SPARRING,
    // 1000 hexUSDC, what the setup script deposits.
    entries: 1_000_000_000n,
    hasPosition: false,
    ix: instructions,
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    ...over,
  });
  return { bought, sent };
}

/** The one instruction of the one transaction, decoded. */
function onlyInstruction(sent: TransactionInstruction[][]): {
  ix: TransactionInstruction;
  name: string;
  args: Record<string, { toString(): string }>;
} {
  expect(sent).toHaveLength(1);
  const [ix] = sent[0] ?? [];
  if (!ix) throw new Error("no instruction was sent");
  expect(sent[0]).toHaveLength(1);
  const decoded = coder.decode(ix.data);
  if (!decoded) throw new Error("the instruction is not one of this program's");
  return {
    ix,
    name: decoded.name,
    args: decoded.data as Record<string, { toString(): string }>,
  };
}

describe("playSparring", () => {
  it("buys a position on all 36 tiles at one whole Ticket each", async () => {
    const { bought, sent } = await play();
    expect(bought).toBe(true);

    const { ix, name, args } = onlyInstruction(sent);
    expect(name).toBe("buy_position");

    // Bits 0..35 all set, nothing above: that trips the program's tile_count check.
    expect(BigInt(String(args.tiles))).toBe(ALL_TILES);
    expect(ALL_TILES).toBe(0xfffffffffn);
    // The coder hands back the IDL's own field names, so snake_case.
    expect(String(args.stake_per_tile)).toBe(String(STAKE_PER_TILE));

    // The owner signs and pays, not the authority.
    expect(ix.keys.map((key) => key.pubkey.toBase58())).toEqual([
      SPARRING.toBase58(),
      POOL.toBase58(),
      playerAddress(PROGRAM_ID, POOL, SPARRING).toBase58(),
      WEIGHT_TREE.toBase58(),
      ROUND.toBase58(),
      positionAddress(PROGRAM_ID, ROUND, SPARRING).toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys[0]?.isSigner).toBe(true);
  });

  it("skips a round it already holds a position in", async () => {
    const { bought, sent } = await play({ hasPosition: true });
    expect(bought).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("skips once the round is within two seconds of its close buffer", async () => {
    // closeBuffer 5, so `buy_position` refuses from endsAt - 5 on.
    const late = await play({ openRound: round({ endsAt: NOW + 6n }) });
    expect(late.sent).toHaveLength(0);

    const inTime = await play({ openRound: round({ endsAt: NOW + 7n }) });
    expect(inTime.sent).toHaveLength(1);
  });

  it("sits out when its Tickets are short", async () => {
    // One Ticket short of covering the board.
    const { bought, sent } = await play({ entries: STAKE_PER_TILE * 35n });
    expect(bought).toBe(false);
    expect(sent).toHaveLength(0);

    const exact = await play({ entries: STAKE_PER_TILE * 36n });
    expect(exact.sent).toHaveLength(1);
  });

  it("does nothing with no open round", async () => {
    const none = await play({ openRound: null });
    expect(none.sent).toHaveLength(0);

    const closed = await play({
      openRound: round({ status: ROUND_STATUS.REQUESTED }),
    });
    expect(closed.sent).toHaveLength(0);
  });
});
