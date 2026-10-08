import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Post,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import bs58 from "bs58";

import { parseBetMessage, type BetRefusal } from "./bet";
import { RoundsService } from "./rounds.service";

/** The throttle: 5 bets per session per 10 seconds. */
export const BETS_PER_WINDOW = 5;
export const BET_WINDOW_MS = 10_000;
/** A bet text is about 300 characters; anything past this is not one. */
const MAX_MESSAGE_LENGTH = 1024;

const REFUSAL_COPY: Record<BetRefusal, string> = {
  SessionInvalid: "Your betting session is missing, expired or revoked. Approve a new one.",
  BadSignature: "That is not a bet signed by your session key for this game.",
  SeqMismatch: "That bet is out of order. Reload and bet again.",
  RoundClosed: "That Round is closed.",
  RoundAlreadyOpen: "A Round is already open. Bet into it.",
  RoundOutsideEpoch: "A new Round would run past the end of the epoch. Betting resumes next epoch.",
  GamePaused: "The game is paused.",
  BadTiles: "Pick between one and the maximum number of tiles, and stake at least 1 per tile.",
  InsufficientTickets: "You do not have enough Tickets for that bet.",
  PositionExists: "You already have a bet in this Round.",
};

/** 401 for a dead session, 403 for a bad signature, 422 for a bet the rules refuse, 409 for the game's state. */
function refusal(code: BetRefusal): Error {
  const payload = { code, message: REFUSAL_COPY[code] };
  switch (code) {
    case "SessionInvalid":
      return new UnauthorizedException(payload);
    case "BadSignature":
      return new ForbiddenException(payload);
    case "BadTiles":
    case "InsufficientTickets":
      return new UnprocessableEntityException(payload);
    default:
      return new ConflictException(payload);
  }
}

/**
 * The bet route (off-chain-tickets ticket 16). Throttled per session and
 * address: the session key comes from the unverified text, so keying on it
 * alone would let anyone spend a stranger's allowance with garbage.
 */
@Controller("game/bets")
export class BetsController {
  constructor(private readonly rounds: RoundsService) {}

  @Post()
  @Throttle({
    default: {
      limit: BETS_PER_WINDOW,
      ttl: BET_WINDOW_MS,
      getTracker: (req) => {
        const message = (req.body as { message?: unknown } | undefined)?.message;
        const session = typeof message === "string" ? parseBetMessage(message)?.session : undefined;
        return `${String(req.ip)}:${session ?? ""}`;
      },
    },
  })
  async placeBet(@Body() body: unknown): Promise<{
    roundId: bigint;
    positionId: bigint;
    opened: boolean;
    closeAt: string;
    receivedAt: string;
  }> {
    const raw = body as { message?: unknown; signature?: unknown } | null | undefined;
    if (typeof raw?.message !== "string" || raw.message.length === 0 || raw.message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException("Send a JSON body with the bet `message`.");
    }
    if (typeof raw.signature !== "string") throw new BadRequestException("Send a base58 `signature`.");
    let signature: Uint8Array;
    try {
      signature = bs58.decode(raw.signature);
    } catch {
      throw new BadRequestException("`signature` must be base58.");
    }
    if (signature.length !== 64) throw new BadRequestException("`signature` must be a 64-byte ed25519 signature.");

    const result = await this.rounds.placeBet(raw.message, signature);
    if (!result.ok) throw refusal(result.code);
    return {
      roundId: result.roundId,
      positionId: result.positionId,
      opened: result.opened,
      closeAt: result.closeAt.toISOString(),
      receivedAt: result.receivedAt.toISOString(),
    };
  }
}
