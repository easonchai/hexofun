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

import type { HexVaultEnv } from "../config/env";
import { IndexerService } from "../indexer/indexer.service";
import { sameKey } from "./access.controller";

// shortcut: everything in this block comes from solami.dev's docs bundle (the
// webhooks page and the workshop's verify sample, read 2026-10-10), not from a
// delivery we watched arrive. The live probe (ticket 09 probe, 07 item 1d)
// confirms them; change them here if it disagrees.
//
// Documented: the header name; an HMAC-SHA256 of the raw body keyed with the
// webhook's secret, hex encoded; `signature` and `slot` at the envelope's top
// level (the dashboard's stream preview reads them there).
// Not documented: the raw envelope's transaction layout. `raw` is "the serialized
// transaction projection", read here as a `getTransaction` answer under
// `transaction`, so the log lines and error sit at `transaction.meta`. Also
// unconfirmed: the header is the bare hex digest (no `sha256=` prefix); the
// secret is used whole, `whsec_` included; the body is sent as
// `application/json` (anything else is 415 before this controller runs); the
// size cap below; whether an `addresses` entry matches a non-signer account
// such as the pool PDA (runbook "Solami webhook"); and the commitment a
// delivery is sent at, where `onLogs` waits for finalized.
const SIGNATURE_HEADER = "x-webhook-signature";
const DIGEST_ENCODING = "hex";
const SIGNATURE_PATH = ["signature"];
const SLOT_PATH = ["slot"];
const LOGS_PATH = ["transaction", "meta", "logMessages"];
const ERR_PATH = ["transaction", "meta", "err"];
/** A Solana transaction is at most 1,232 bytes and its log is cut at 10 KB;
 *  the JSON projection around them is unmeasured, so this leaves room. */
export const MAX_BODY_BYTES = 128 * 1024;

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
  logs: string[];
  err: unknown;
}

/** The fields the Indexer needs, or a 400 naming the first one missing. */
function parseDelivery(body: unknown): PushedTransaction {
  const signature = at(body, SIGNATURE_PATH);
  const slot = at(body, SLOT_PATH);
  const logs = at(body, LOGS_PATH);
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 128) {
    throw new BadRequestException(`\`${SIGNATURE_PATH.join(".")}\` must be a transaction signature.`);
  }
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
    throw new BadRequestException(`\`${SLOT_PATH.join(".")}\` must be a slot number.`);
  }
  if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) {
    throw new BadRequestException(`\`${LOGS_PATH.join(".")}\` must be the transaction's log lines.`);
  }
  return { signature, slot, logs, err: at(body, ERR_PATH) ?? null };
}

/**
 * Solami ticket 09: a Solami webhook pushes the Active pool's transactions
 * here as a second live feed beside the Indexer's `onLogs` socket. Off (404)
 * unless `SOLAMI_WEBHOOK_SECRET` is set. A delivery goes through the same
 * `ingestPushed` the socket uses, so `persist` dedups the two by signature and
 * neither moves the cursor; the RPC catch-up walk stays the gap filler.
 *
 * Throttled at the read tier, 60 a minute per sending address. The pool sends
 * far fewer transactions than that, and a 429 is retried by Solami and covered
 * by the walk anyway.
 */
@Controller("webhooks")
@Throttle({ default: { limit: DELIVERIES_PER_MINUTE, ttl: 60_000 } })
export class WebhooksController {
  private readonly secret: string | undefined;

  constructor(
    private readonly indexer: IndexerService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.secret = config.get("SOLAMI_WEBHOOK_SECRET", { infer: true });
    new Logger(WebhooksController.name).log(
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
    await this.indexer.ingestPushed({ ...delivery, slot: BigInt(delivery.slot) });
    lastSlot = Math.max(lastSlot ?? 0, delivery.slot);
    return { ok: true };
  }
}
