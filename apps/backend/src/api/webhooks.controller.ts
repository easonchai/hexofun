import { createHmac } from "node:crypto";

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { IndexerService } from "../indexer/indexer.service";
import { sameKey } from "./access.controller";

// Read off live Raw deliveries (probe 2026-10-10, ~40 deliveries on a watched
// klend reserve): the bare hex HMAC-SHA256 of the raw body, keyed with the
// whole secret (`whsec_` included), in `X-Webhook-Signature`; an
// `application/json` body with `signature` and `slot` at the top, `status`
// "succeeded" or "failed", and the log lines at `transaction.logs`. A
// non-signer `addresses` entry (a PDA) matches. Bodies ran to 42 KB.
// Deliveries arrive 0-1 s after the block, before finality, so a delivery is
// only ingested once the RPC reports its signature finalized (`awaitFinalized`).
const SIGNATURE_HEADER = "x-webhook-signature";
const DIGEST_ENCODING = "hex";
const SIGNATURE_PATH = ["signature"];
const SLOT_PATH = ["slot"];
const STATUS_PATH = ["status"];
const LOGS_PATH = ["transaction", "logs"];
const SUCCEEDED = "succeeded";
/** A Solana transaction is at most 1,232 bytes and its log is cut at 10 KB;
 *  the largest probe delivery was 42 KB, so this leaves room. */
export const MAX_BODY_BYTES = 128 * 1024;
/** Finality takes ~32 slots (~13 s); give it about 40 s before leaving the
 *  transaction to the RPC walk. */
export const FINALITY_CHECKS = 10;
export const FINALITY_INTERVAL_MS = 4_000;

/** Slot of the newest delivery the Indexer took, for `/status`. One process
 *  serves one pool, so module state is the whole store. */
let lastSlot: number | null = null;
export const webhookLastSlot = (): number | null => lastSlot;

/** ApiController's read tier, spelled out: importing it would close an import
 *  cycle through api.service.ts, which reads `webhookLastSlot` above. */
const DELIVERIES_PER_MINUTE = 60;

const at = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    // SAFETY: a non-null object indexed by a string key reads a property or
    // undefined; the caller checks the type of whatever comes back.
    (node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    value,
  );

interface PushedTransaction {
  signature: string;
  slot: number;
  status: string;
  logs: string[];
}

/** The fields the Indexer needs, or a 400 naming the first one missing. */
function parseDelivery(body: unknown): PushedTransaction {
  const signature = at(body, SIGNATURE_PATH);
  const slot = at(body, SLOT_PATH);
  const status = at(body, STATUS_PATH);
  const logs = at(body, LOGS_PATH);
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 128) {
    throw new BadRequestException(`\`${SIGNATURE_PATH.join(".")}\` must be a transaction signature.`);
  }
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
    throw new BadRequestException(`\`${SLOT_PATH.join(".")}\` must be a slot number.`);
  }
  if (typeof status !== "string") {
    throw new BadRequestException(`\`${STATUS_PATH.join(".")}\` must be the transaction status.`);
  }
  if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) {
    throw new BadRequestException(`\`${LOGS_PATH.join(".")}\` must be the transaction's log lines.`);
  }
  return { signature, slot, status, logs };
}

type SignatureStatusLike = { slot: number; err: unknown; confirmationStatus?: string | null } | null;

/**
 * The slot `signature` finalized in, or null if it failed or did not finalize
 * within FINALITY_CHECKS. The slot comes from the RPC, not the delivery: a
 * transaction re-included after a fork lands in another slot. A failed status
 * read counts as "not yet"; the caller logs the null.
 */
export async function awaitFinalized(
  status: (signature: string) => Promise<SignatureStatusLike>,
  signature: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
): Promise<number | null> {
  for (let check = 0; check < FINALITY_CHECKS; check += 1) {
    if (check > 0) await sleep(FINALITY_INTERVAL_MS);
    const value = await status(signature).catch(() => null);
    if (value?.err) return null;
    if (value?.confirmationStatus === "finalized") return value.slot;
  }
  return null;
}

/**
 * Solami ticket 09: a Solami webhook pushes the Active pool's transactions
 * here as a second live feed beside the Indexer's `onLogs` socket. Off (404)
 * unless `SOLAMI_WEBHOOK_SECRET` is set. A delivery is answered at once and
 * ingested in the background once finalized, through the same `ingestPushed`
 * the socket uses, so `persist` dedups the two by signature and neither moves
 * the cursor; the RPC catch-up walk stays the gap filler.
 *
 * Throttled at the read tier, 60 a minute per sending address. The pool sends
 * far fewer transactions than that, and a 429 is retried by Solami and covered
 * by the walk anyway.
 */
@Controller("webhooks")
@Throttle({ default: { limit: DELIVERIES_PER_MINUTE, ttl: 60_000 } })
export class WebhooksController {
  private readonly secret: string | undefined;
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly indexer: IndexerService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.secret = config.get("SOLAMI_WEBHOOK_SECRET", { infer: true });
    this.logger.log(
      this.secret === undefined
        ? "solami webhook route off (SOLAMI_WEBHOOK_SECRET unset)"
        : "solami webhook route on at POST /webhooks/solami",
    );
  }

  @Post("solami")
  @HttpCode(200)
  async solami(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers(SIGNATURE_HEADER) given: string | undefined,
  ): Promise<{ ok: true }> {
    if (this.secret === undefined) throw new NotFoundException();
    const raw = req.rawBody;
    if (raw === undefined) throw new BadRequestException("Send a JSON body.");
    if (raw.length > MAX_BODY_BYTES) throw new PayloadTooLargeException();
    const expected = createHmac("sha256", this.secret).update(raw).digest(DIGEST_ENCODING);
    if (typeof given !== "string" || !sameKey(given, expected)) {
      throw new UnauthorizedException(`Missing or wrong \`${SIGNATURE_HEADER}\`.`);
    }
    const delivery = parseDelivery(req.body);
    // Holding the request ~13 s for finality would invite Solami's retries.
    if (delivery.status === SUCCEEDED) void this.ingestWhenFinalized(delivery);
    return { ok: true };
  }

  private async ingestWhenFinalized({ signature, logs }: PushedTransaction): Promise<void> {
    try {
      const slot = await awaitFinalized(
        async (sig) => (await this.chain.connection.getSignatureStatuses([sig])).value[0] ?? null,
        signature,
      );
      if (slot === null) {
        this.logger.warn(`webhook delivery ${signature} did not finalize; the RPC walk picks it up if it landed`);
        return;
      }
      await this.indexer.ingestPushed({ signature, slot: BigInt(slot), logs, err: null });
      lastSlot = Math.max(lastSlot ?? 0, slot);
    } catch (error) {
      this.logger.error(`webhook ingest of ${signature} failed`, error instanceof Error ? error.stack : String(error));
    }
  }
}
