import { BadRequestException, Body, Controller, Logger, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { PrismaService } from "../prisma/prisma.service";

const MAX_LEN = 2_000;
/** The table keeps the newest rows only; `create` trims the rest. */
export const MAX_ROWS = 10_000;
/** Per IP per minute. The web posts one report per failure, so this is generous. */
export const REPORTS_PER_MINUTE = 5;

/** One log line per report: a caller cannot forge a second line with a newline. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ");

interface ErrorReportBody {
  code?: unknown;
  message?: unknown;
  signature?: unknown;
  wallet?: unknown;
  page?: unknown;
}

interface ParsedErrorReport {
  code: string;
  message: string;
  signature: string | null;
  wallet: string | null;
  page: string | null;
}

/** A non-empty string, truncated; anything else (missing, wrong type, empty) is null. */
const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, MAX_LEN) : null;

function parseErrorReport(body: unknown): ParsedErrorReport {
  const raw = (body ?? {}) as ErrorReportBody;
  if (typeof raw.code !== "string" || raw.code.length === 0) {
    throw new BadRequestException("Send a JSON body with a `code` string.");
  }
  if (typeof raw.message !== "string" || raw.message.length === 0) {
    throw new BadRequestException("Send a JSON body with a `message` string.");
  }
  return {
    code: raw.code.slice(0, 200),
    message: raw.message.slice(0, MAX_LEN),
    signature: optionalString(raw.signature),
    wallet: optionalString(raw.wallet),
    page: optionalString(raw.page),
  };
}

/**
 * beta-launch-fixes ticket 16: stores decoded send failures and
 * error-boundary catches the web posts, so a broken money path reaches the
 * maintainers instead of only the depositor's console (`errorReport.ts`,
 * `ErrorBoundary.tsx`, `playerErrors.ts`'s `decodeSendFailure`). Write-only:
 * no route reads this back; an operator queries Postgres directly.
 */
@Controller("error-reports")
export class ErrorReportController {
  private readonly logger = new Logger(ErrorReportController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Throttle({ default: { limit: REPORTS_PER_MINUTE, ttl: 60_000 } })
  @Post()
  async create(@Body() body: unknown): Promise<{ ok: true }> {
    const report = parseErrorReport(body);
    this.logger.warn(`error report ${oneLine(report.code)}: ${oneLine(report.message)}`);
    const created = await this.prisma.errorReport.create({ data: report });
    // Ids only grow, so this keeps at most MAX_ROWS rows and costs one indexed delete.
    await this.prisma.errorReport.deleteMany({ where: { id: { lte: created.id - MAX_ROWS } } });
    return { ok: true };
  }
}
