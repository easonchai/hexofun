import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { awaitFinalized } from "./finality";
import { IndexerService } from "./indexer.service";

/**
 * Solami Mirage: the Yellowstone geyser feed for one saved filter (the Active
 * pool's confirmed, non-failed transactions) over a plain WebSocket. Each
 * binary frame is a protobuf `SubscribeUpdate`. Nothing is sent after the
 * handshake, and Solami pings every 30 s, which Node's WebSocket answers.
 *
 * Third live feed beside `onLogs` and the webhook, through the same
 * `ingestPushed`, so a signature any two deliver is stored once and none of
 * them moves the cursor. Unlike the webhook it needs no event the decoder
 * knows about: every transaction touching the pool arrives. Off unless
 * `MIRAGE_STREAM_URL` is set; a dead socket (lapsed plan, bandwidth gone,
 * node restart) is logged and retried with capped backoff while the Indexer
 * runs on as before. Never on the boot path and never awaited.
 */

/** Frames arrive at `confirmed`; the Indexer stores only finalized
 *  transactions (see finality.ts). */
const COMMITMENT_NOTE = "confirmed";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Solami's close codes, from its Mirage stream docs. */
const CLOSE_REASONS: Readonly<Record<number, string>> = {
  1001: "node restarting",
  4002: "streaming bandwidth exhausted",
  4029: "concurrent stream limit reached",
};

// Field numbers from yellowstone-grpc-proto (geyser.proto, solana-storage.proto),
// read 2026-10-12. Only the path to the signature, slot, error and log lines
// is decoded; every other field is skipped by wire type.
const UPDATE_TRANSACTION = 4;
const UPDATE_PING = 6;
const TX_INFO = 1;
const TX_SLOT = 2;
const INFO_SIGNATURE = 1;
const INFO_META = 4;
const META_ERR = 1;
const META_LOG_MESSAGES = 6;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

type Field = { number: number; varint: bigint } | { number: number; bytes: Uint8Array };

/** One pass over a protobuf message, yielding varint and length-delimited
 *  fields and skipping fixed-width ones. Throws on a malformed buffer. */
function* fields(buf: Uint8Array): Generator<Field> {
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[at];
      if (byte === undefined) throw new Error("varint past end of buffer");
      at += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 63n) throw new Error("varint longer than 64 bits");
    }
  };
  while (at < buf.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === WIRE_VARINT) {
      yield { number, varint: varint() };
    } else if (wire === WIRE_LENGTH) {
      const length = Number(varint());
      if (at + length > buf.length) throw new Error("length-delimited field past end of buffer");
      yield { number, bytes: buf.subarray(at, at + length) };
      at += length;
    } else if (wire === WIRE_FIXED64) {
      at += 8;
    } else if (wire === WIRE_FIXED32) {
      at += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

const bytesOf = (field: Field, number: number): Uint8Array | undefined =>
  field.number === number && "bytes" in field ? field.bytes : undefined;

export type MirageFrame =
  | { kind: "ping" }
  | { kind: "other" }
  | { kind: "transaction"; signature: string; slot: bigint; logs: string[]; failed: boolean };

/** Decodes a `SubscribeUpdate` frame down to what `ingestPushed` needs. */
export function decodeFrame(buf: Uint8Array): MirageFrame {
  for (const field of fields(buf)) {
    if (field.number === UPDATE_PING) return { kind: "ping" };
    const tx = bytesOf(field, UPDATE_TRANSACTION);
    if (tx === undefined) continue;
    let slot: bigint | undefined;
    let info: Uint8Array | undefined;
    for (const f of fields(tx)) {
      if (f.number === TX_SLOT && "varint" in f) slot = f.varint;
      info = bytesOf(f, TX_INFO) ?? info;
    }
    if (slot === undefined || info === undefined) throw new Error("transaction frame without slot or info");
    let signature: string | undefined;
    const logs: string[] = [];
    let failed = false;
    for (const f of fields(info)) {
      const sig = bytesOf(f, INFO_SIGNATURE);
      if (sig !== undefined) signature = bs58.encode(sig);
      const meta = bytesOf(f, INFO_META);
      if (meta === undefined) continue;
      for (const m of fields(meta)) {
        if (m.number === META_ERR) failed = true;
        const line = bytesOf(m, META_LOG_MESSAGES);
        if (line !== undefined) logs.push(Buffer.from(line).toString("utf8"));
      }
    }
    if (signature === undefined) throw new Error("transaction frame without signature");
    return { kind: "transaction", signature, slot, logs, failed };
  }
  return { kind: "other" };
}

/** Slot of the newest Mirage frame the Indexer took and whether the socket is
 *  open now, for `/status`; `connected` is null with the feed off. One
 *  process serves one pool, so module state is the whole store. */
let lastSlot: number | null = null;
let connected: boolean | null = null;
export const mirageLastSlot = (): number | null => lastSlot;
export const mirageConnected = (): boolean | null => connected;

/** The subset of the WebSocket the service drives; tests pass a fake. */
export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;
/** Nothing provides this token; it exists so Nest leaves the constructor's
 *  default factory in place instead of failing to resolve a function type. */
export const MIRAGE_SOCKET_FACTORY = Symbol("MIRAGE_SOCKET_FACTORY");

/** Node 22+ ships WebSocket globally. */
// SAFETY: the handlers above read a subset of the DOM event fields and the
// service only ever assigns them; the DOM types reject the narrower
// parameters by contravariance, not by shape.
const openSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

@Injectable()
export class MirageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MirageService.name);
  private readonly url: string | undefined;
  private socket: SocketLike | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private delayMs = RECONNECT_MIN_MS;
  private stopped = false;

  constructor(
    private readonly indexer: IndexerService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
    @Optional() @Inject(MIRAGE_SOCKET_FACTORY) private readonly connect: SocketFactory = openSocket,
  ) {
    this.url = config.get("MIRAGE_STREAM_URL", { infer: true });
    connected = this.url === undefined ? null : false;
  }

  onModuleInit(): void {
    if (this.url === undefined) {
      this.logger.log("mirage feed off (MIRAGE_STREAM_URL unset)");
      return;
    }
    this.logger.log(`mirage feed on, ingesting ${COMMITMENT_NOTE} frames once finalized`);
    this.open();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private open(): void {
    if (this.stopped || this.url === undefined) return;
    let socket: SocketLike;
    try {
      socket = this.connect(this.url);
    } catch (error) {
      this.logger.error("mirage socket could not be created", error instanceof Error ? error.stack : String(error));
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      connected = true;
      this.logger.log("mirage socket connected");
    };
    socket.onmessage = (event) => {
      // A frame proves the stream is healthy; the next outage starts the
      // backoff from the floor again.
      this.delayMs = RECONNECT_MIN_MS;
      void this.handleFrame(toBytes(event.data));
    };
    // The handshake failure (403, 404, 503) surfaces as close 1006 with no
    // reason in Node's WebSocket; the runbook has the curl that shows it.
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      connected = false;
      const reason = CLOSE_REASONS[event.code] ?? event.reason ?? "";
      this.logger.warn(`mirage socket closed (${event.code}${reason ? `, ${reason}` : ""}); retrying in ${Math.round(this.delayMs / 1000)} s`);
      this.scheduleReconnect();
    };
    this.socket = socket;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.open(), this.delayMs).unref();
    this.delayMs = Math.min(this.delayMs * 2, RECONNECT_MAX_MS);
  }

  /** One frame: decoded, waited to finality, then handed to the Indexer.
   *  Public so the test can drive it without a socket. */
  async handleFrame(buf: Uint8Array): Promise<void> {
    let frame: MirageFrame;
    try {
      frame = decodeFrame(buf);
    } catch (error) {
      this.logger.error(`mirage frame not decoded (${buf.length} bytes)`, error instanceof Error ? error.stack : String(error));
      return;
    }
    if (frame.kind !== "transaction" || frame.failed) return;
    try {
      const slot = await awaitFinalized(
        async (sig) => (await this.chain.connection.getSignatureStatuses([sig])).value[0] ?? null,
        frame.signature,
      );
      if (slot === null) {
        this.logger.warn(`mirage frame ${frame.signature} did not finalize; the RPC walk picks it up if it landed`);
        return;
      }
      await this.indexer.ingestPushed({ signature: frame.signature, slot: BigInt(slot), logs: frame.logs, err: null });
      lastSlot = Math.max(lastSlot ?? 0, slot);
    } catch (error) {
      this.logger.error(`mirage ingest of ${frame.signature} failed`, error instanceof Error ? error.stack : String(error));
    }
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  // A text frame would be a protocol change; decoding it as bytes fails
  // loudly in `decodeFrame` instead of silently dropping it.
  return Buffer.from(String(data), "utf8");
}
