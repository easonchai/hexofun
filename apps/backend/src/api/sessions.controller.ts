import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import bs58 from "bs58";

import type { DelegationCode, RevokeCode } from "./session";
import { SessionsService } from "./sessions.service";

/** Decodes a 64-byte base58 ed25519 signature; anything else is a 400. */
function parseSignature(raw: unknown): Uint8Array {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BadRequestException("Send a JSON body with a base58 `signature`.");
  }
  let signature: Uint8Array;
  try {
    signature = bs58.decode(raw);
  } catch {
    throw new BadRequestException("`signature` must be base58.");
  }
  if (signature.length !== 64) {
    throw new BadRequestException("`signature` must be a 64-byte ed25519 signature.");
  }
  return signature;
}

const DELEGATION_MESSAGES: Record<DelegationCode, string> = {
  BadMessage: "That is not a HexVault session delegation for this app.",
  BadSignature: "The signature does not match the wallet in the message.",
  IssuedAtOutOfRange: "The message was issued too long ago or too far ahead. Check your clock.",
  ExpiryTooLong: "A session may last at most 24 hours.",
  AlreadyExpired: "That session has already expired.",
  NonceInvalid: "That nonce is unknown, used or expired. Ask for a new one.",
};

const REVOKE_MESSAGES: Record<RevokeCode | "SessionNotFound", string> = {
  SessionNotFound: "No such session.",
  BadSignature: "The signature does not match the session's wallet, key and time.",
  StaleRevoke: "That request is too old or too far ahead. Sign it again.",
};

/**
 * Session delegation routes (off-chain-tickets ticket 15). Every refusal
 * carries a stable `code` next to the human `message`, so the web can tell a
 * stale nonce (ask again) from a bad signature (stop). Throttled in
 * api.module.ts, because the nonce route writes a row for anyone.
 */
@Controller("game/sessions")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get("nonce")
  async nonce(): Promise<{ nonce: string; expiresAt: string }> {
    const { nonce, expiresAt } = await this.sessions.issueNonce();
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  @Post()
  async create(@Body() body: unknown, @Headers("origin") origin?: string): Promise<{
    id: string;
    wallet: string;
    sessionPubkey: string;
    issuedAt: string;
    expiresAt: string;
  }> {
    const raw = body as { message?: unknown; signature?: unknown } | null | undefined;
    if (typeof raw?.message !== "string" || raw.message.length === 0) {
      throw new BadRequestException("Send a JSON body with the delegation `message`.");
    }
    const result = await this.sessions.create(raw.message, parseSignature(raw.signature), origin);
    if (!result.ok) {
      const payload = { code: result.code, message: DELEGATION_MESSAGES[result.code] };
      if (result.code === "BadSignature") throw new ForbiddenException(payload);
      if (result.code === "NonceInvalid") throw new ConflictException(payload);
      throw new BadRequestException(payload);
    }
    const { session } = result;
    return {
      id: session.id,
      wallet: session.wallet,
      sessionPubkey: session.sessionPubkey,
      issuedAt: session.issuedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post(":id/revoke")
  async revoke(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ id: string; revokedAt: string }> {
    const raw = body as { time?: unknown; signature?: unknown } | null | undefined;
    if (typeof raw?.time !== "number" || !Number.isSafeInteger(raw.time)) {
      throw new BadRequestException("`time` must be a whole number of unix seconds.");
    }
    const result = await this.sessions.revoke(id, {
      time: raw.time,
      signature: parseSignature(raw.signature),
    });
    if (!result.ok) {
      const payload = { code: result.code, message: REVOKE_MESSAGES[result.code] };
      if (result.code === "SessionNotFound") throw new NotFoundException(payload);
      if (result.code === "BadSignature") throw new ForbiddenException(payload);
      throw new BadRequestException(payload);
    }
    // `revokedAt` is set by the revoke above, or by the first one.
    return { id: result.session.id, revokedAt: result.session.revokedAt!.toISOString() };
  }
}
