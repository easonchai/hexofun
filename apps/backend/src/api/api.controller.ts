import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { PublicKey } from "@solana/web3.js";

import { ApiService } from "./api.service";

/** Cap borrowed from the api-design rule; the frontend never asks for more. */
const MAX_LIMIT = 100;

/** Keeps the `owners` query string short and the groupBy below it cheap. */
const MAX_OWNERS = 25;

const parseLimit = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException("`limit` must be a whole number of 1 or more.");
  }
  return Math.min(value, MAX_LIMIT);
};

const parseRoundId = (raw: string): bigint => {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException("A round id is a whole number, for example 12.");
  }
  return BigInt(raw);
};

const parseOwner = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

const parseOwners = (raw: string | undefined): string[] => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new BadRequestException(
      "`owners` must be a comma-separated list of wallet addresses.",
    );
  }
  const owners = trimmed.split(",").map((entry) => parseOwner(entry.trim()));
  if (owners.length > MAX_OWNERS) {
    throw new BadRequestException(`\`owners\` accepts at most ${MAX_OWNERS} addresses.`);
  }
  return owners;
};

/** The read half of spec.md §3.5. Everything comes from Postgres. */
@Controller()
export class ApiController {
  constructor(private readonly api: ApiService) {}

  @Get("pool")
  getPool() {
    return this.api.getPool();
  }

  @Get("epochs")
  getEpochs(@Query("limit") limit?: string) {
    return this.api.getEpochs(parseLimit(limit, 20));
  }

  @Get("epochs/current")
  getCurrentEpoch() {
    return this.api.getCurrentEpoch();
  }

  @Get("rounds")
  getRounds(@Query("limit") limit?: string) {
    return this.api.getRounds(parseLimit(limit, 50));
  }

  @Get("rounds/:id")
  getRound(@Param("id") id: string) {
    return this.api.getRound(parseRoundId(id));
  }

  @Get("players/:owner")
  getPlayer(@Param("owner") owner: string) {
    return this.api.getPlayer(parseOwner(owner));
  }

  @Get("leaderboard")
  getLeaderboard(@Query("limit") limit?: string) {
    return this.api.getLeaderboard(parseLimit(limit, 20));
  }

  @Get("feed")
  getFeed(@Query("limit") limit?: string, @Query("owner") owner?: string) {
    return this.api.getFeed(parseLimit(limit, 50), owner ? parseOwner(owner) : undefined);
  }

  @Get("positions/counts")
  getPositionCounts(@Query("owners") owners?: string) {
    return this.api.getPositionCounts(parseOwners(owners));
  }

  @Get("status")
  getStatus() {
    return this.api.getStatus();
  }

  /**
   * Ticket 06: the Pool, current Epoch, open Round, operator status and
   * chain time in one response, plus `owner`'s Player when given. Screens
   * poll this instead of their own separate requests.
   *
   * Ticket 07: `round`, when given, also returns that Round's full state
   * (any status) as `round`, plus `owner`'s Position in it — see
   * `ApiService.getState`'s comment for why this differs from `openRound`.
   */
  @Get("state")
  getState(@Query("owner") owner?: string, @Query("round") round?: string) {
    return this.api.getState(
      owner ? parseOwner(owner) : undefined,
      round !== undefined ? parseRoundId(round) : undefined,
    );
  }
}
