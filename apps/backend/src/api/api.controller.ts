import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { PublicKey } from "@solana/web3.js";

import { ApiService } from "./api.service";

/** Cap borrowed from the api-design rule; the frontend never asks for more. */
const MAX_LIMIT = 100;

const parseLimit = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException("`limit` must be a whole number of 1 or more.");
  }
  return Math.min(value, MAX_LIMIT);
};

/** Leaves per `GET /epochs/:id/snapshot` page. */
const SNAPSHOT_PAGE = 10_000;

const MAX_DAYS = 365;

const parseDays = (raw: string | undefined): number => {
  if (raw === undefined) return 30;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1) {
    throw new BadRequestException("`days` must be a whole number of 1 or more.");
  }
  return Math.min(value, MAX_DAYS);
};

const parseOwner = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
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

  /** The Epoch snapshot's leaves in tree order plus the sum tree's outputs,
   *  `SNAPSHOT_PAGE` leaves at a time; pass `after` the `nextIndex` of the last page. */
  @Get("epochs/:id/snapshot")
  getEpochSnapshot(
    @Param("id") id: string,
    @Query("after") after?: string,
    @Query("limit") limit?: string,
  ) {
    if (!/^\d+$/.test(id) || (after !== undefined && !/^\d+$/.test(after))) {
      throw new BadRequestException("`id` and `after` must be whole numbers.");
    }
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) {
      throw new BadRequestException("`limit` must be a whole number of 1 or more.");
    }
    return this.api.getEpochSnapshot(BigInt(id), Number(after ?? 0), Math.min(Number(limit ?? SNAPSHOT_PAGE), SNAPSHOT_PAGE));
  }

  /** The epoch's Referral bonus grants with the inputs behind each; empty when it granted nothing. */
  @Get("epochs/:id/referral-grants")
  getEpochReferralGrants(@Param("id") id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException("`id` must be a whole number.");
    return this.api.getEpochReferralGrants(BigInt(id));
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

  @Get("rates/daily")
  getDailyPaidRates(@Query("days") days?: string) {
    return this.api.getDailyPaidRates(parseDays(days));
  }

  @Get("status")
  getStatus() {
    return this.api.getStatus();
  }

  /**
   * Ticket 06: the Pool, current Epoch, operator status and chain time in
   * one response, plus `owner`'s Player when given. Screens poll this instead
   * of their own separate requests.
   */
  @Get("state")
  getState(@Query("owner") owner?: string) {
    return this.api.getState(owner ? parseOwner(owner) : undefined);
  }
}
