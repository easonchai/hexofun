import { Controller, Get } from "@nestjs/common";

import { OpsSummaryService } from "./ops-summary";

/** The Ops console's read route. Public like `GET /status`, which it extends. */
@Controller("ops")
export class OpsController {
  constructor(private readonly ops: OpsSummaryService) {}

  @Get("summary")
  getSummary() {
    return this.ops.getOpsSummary();
  }
}
