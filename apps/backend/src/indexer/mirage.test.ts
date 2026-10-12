// No database and no socket: frames are built here with a minimal protobuf
// encoder against the same field numbers the decoder reads, and the service
// is driven through `handleFrame` and a recording fake socket. What the feed
// owes the Indexer is one `ingestPushed` per finalized, non-failed frame.
// Dedup against `onLogs` and the webhook is covered in indexer.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";

import { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import type { IndexerService } from "./indexer.service";
import { MirageService, type SocketLike, decodeFrame, mirageConnected, mirageLastSlot } from "./mirage.service";

const SIGNATURE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOGS = ["Program LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 invoke [1]", "Program log: hi"];
const FRAME_SLOT = 77n;
const FINAL_SLOT = 80;

// --- a just-enough protobuf encoder -----------------------------------------

function varint(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest === 0n) return [...out, byte];
    out.push(byte | 0x80);
  }
}
const tag = (field: number, wire: number): number[] => varint(BigInt((field << 3) | wire));
const uint64 = (field: number, value: bigint): number[] => [...tag(field, 0), ...varint(value)];
const bytes = (field: number, value: Uint8Array | number[]): number[] => [
  ...tag(field, 2),
  ...varint(BigInt(value.length)),
  ...value,
];
const str = (field: number, value: string): number[] => bytes(field, Buffer.from(value, "utf8"));
const fixed64 = (field: number): number[] => [...tag(field, 1), 0, 0, 0, 0, 0, 0, 0, 0];

/** A `SubscribeUpdate{transaction}` with the fields Solami fills, plus a few
 *  the decoder must skip (fee, balances, compute units). */
function transactionFrame({ failed = false, slot = FRAME_SLOT } = {}): Uint8Array {
  const meta = [
    ...(failed ? bytes(1, bytes(1, [0, 0, 0, 0])) : []),
    ...uint64(2, 5000n), // fee
    ...bytes(3, varint(10n)), // pre_balances, packed
    ...LOGS.flatMap((line) => str(6, line)),
    ...uint64(16, 1234n), // compute_units_consumed
  ];
  const info = [...bytes(1, bs58.decode(SIGNATURE)), ...uint64(2, 0n), ...bytes(3, []), ...bytes(4, meta), ...uint64(5, 3n)];
  const transaction = [...bytes(1, info), ...uint64(2, slot)];
  return Uint8Array.from([...str(1, "hexo"), ...bytes(4, transaction), ...fixed64(99)]);
}

const pingFrame = (): Uint8Array => Uint8Array.from(bytes(6, []));

describe("decodeFrame", () => {
  it("reads signature, slot, log lines and success off a transaction frame", () => {
    expect(decodeFrame(transactionFrame())).toEqual({
      kind: "transaction",
      signature: SIGNATURE,
      slot: FRAME_SLOT,
      logs: LOGS,
      failed: false,
    });
  });

  it("marks a frame with an err as failed", () => {
    expect(decodeFrame(transactionFrame({ failed: true }))).toMatchObject({ kind: "transaction", failed: true });
  });

  it("reads a slot wider than 32 bits", () => {
    expect(decodeFrame(transactionFrame({ slot: 455_719_846n * 1000n }))).toMatchObject({ slot: 455_719_846_000n });
  });

  it("names a ping and shrugs at an update it does not read", () => {
    expect(decodeFrame(pingFrame())).toEqual({ kind: "ping" });
    expect(decodeFrame(Uint8Array.from(bytes(3, uint64(1, 5n))))).toEqual({ kind: "other" });
  });

  // A frame Solami delivered on 2026-10-12 for a mainnet pool-1 deposit,
  // saved raw off the socket. The RPC's finalized view of the same signature
  // had slot 455898981, no error and 48 log lines.
  it("decodes a real Solami frame to what the RPC reports for the same signature", () => {
    const frame = readFileSync(path.join(__dirname, "fixtures", "mirage-deposit-frame.bin"));
    const decoded = decodeFrame(new Uint8Array(frame));
    expect(decoded).toMatchObject({
      kind: "transaction",
      signature: "5mWT19qYsAdkbUPfMh1JGtXK4gaeoWeMraFZfJ57tKhy3MWUrDn78suBJTJVdhAw1i5xFCCEab6z5hhnV3sF9Pqn",
      slot: 455898981n,
      failed: false,
    });
    if (decoded.kind !== "transaction") throw new Error("unreachable");
    expect(decoded.logs).toHaveLength(48);
    expect(decoded.logs).toContain("Program log: Instruction: Deposit");
  });

  it("throws on a truncated frame instead of returning a partial transaction", () => {
    // 10 bytes is exactly the trailing fixed64; 20 cuts into the transaction.
    const whole = transactionFrame();
    expect(() => decodeFrame(whole.subarray(0, whole.length - 20))).toThrow(/past end/);
  });
});

// --- the service ------------------------------------------------------------

type Pushed = Parameters<IndexerService["ingestPushed"]>[0];

class RecordingSocket implements SocketLike {
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = 0;
  close(): void {
    this.closed += 1;
  }
}

function build(url: string | undefined, status = "finalized") {
  const pushed: Pushed[] = [];
  const sockets: RecordingSocket[] = [];
  const indexer = { ingestPushed: (tx: Pushed) => Promise.resolve(void pushed.push(tx)) } as unknown as IndexerService;
  const chain = {
    connection: { getSignatureStatuses: async () => ({ value: [{ slot: FINAL_SLOT, err: null, confirmationStatus: status }] }) },
  } as unknown as ChainService;
  const config = { get: () => url } as unknown as ConfigService<HexVaultEnv, true>;
  const service = new MirageService(indexer, chain, config, () => {
    const socket = new RecordingSocket();
    sockets.push(socket);
    return socket;
  });
  return { service, pushed, sockets };
}

describe("MirageService", () => {
  it("stays off, opens nothing and reports null with MIRAGE_STREAM_URL unset", () => {
    const { service, sockets } = build(undefined);
    service.onModuleInit();
    expect(sockets).toEqual([]);
    expect(mirageConnected()).toBeNull();
  });

  it("hands a frame to the Indexer at its finalized slot, binary from the socket", async () => {
    const { service, pushed, sockets } = build("wss://example.test/mirage/stream/x?api_key=k");
    service.onModuleInit();
    const [socket] = sockets;
    expect(socket?.binaryType).toBe("arraybuffer");
    expect(mirageConnected()).toBe(false);
    socket?.onopen?.();
    expect(mirageConnected()).toBe(true);
    const frame = transactionFrame();
    socket?.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    await vi.waitFor(() => expect(pushed).toEqual([{ signature: SIGNATURE, slot: BigInt(FINAL_SLOT), logs: LOGS, err: null }]));
    expect(mirageLastSlot()).toBe(FINAL_SLOT);
  });

  it("ingests nothing for a failed transaction, a ping or an undecodable frame", async () => {
    const { service, pushed } = build("wss://example.test/x?api_key=k");
    await service.handleFrame(transactionFrame({ failed: true }));
    await service.handleFrame(pingFrame());
    await service.handleFrame(Uint8Array.from([0xff, 0xff]));
    expect(pushed).toEqual([]);
  });

  it("leaves a frame that never finalizes to the RPC walk", async () => {
    const { service, pushed } = build("wss://example.test/x?api_key=k", "confirmed");
    // Fake timers skip the 40 s wait; the finality helper has its own tests.
    vi.useFakeTimers();
    try {
      const run = service.handleFrame(transactionFrame());
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(pushed).toEqual([]);
  });

  it("reopens after a close with growing delay and stops on destroy", async () => {
    vi.useFakeTimers();
    try {
      const { service, sockets } = build("wss://example.test/x?api_key=k");
      service.onModuleInit();
      sockets[0]?.onclose?.({ code: 4002, reason: "" });
      expect(mirageConnected()).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      sockets[1]?.onclose?.({ code: 1006, reason: "" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(3);
      service.onModuleDestroy();
      expect(sockets[2]?.closed).toBe(1);
      sockets[2]?.onclose?.({ code: 1000, reason: "" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sockets).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
