import { describe, expect, it } from "vitest";

import { classifyFastPauseError, fastPauseMessage, FAST_PAUSE_SWITCHES } from "./fastPause.js";

// Backend's apps/backend/src/api/invite-code.ts fastPauseMessage produces the same
// strings; its test (fast-pause.test.ts) pins the same format. The web cannot
// import backend source, so each suite pins the literal.
describe("fastPauseMessage", () => {
  const POOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  it("matches the backend wire format byte for byte for each switch", () => {
    for (const s of FAST_PAUSE_SWITCHES) {
      expect(fastPauseMessage(s, POOL, 1700000000)).toBe(`HEXO fast pause: ${s} ${POOL} 1700000000`);
    }
    expect(fastPauseMessage("game", "POOLADDR", 1700000000)).toBe(
      "HEXO fast pause: game POOLADDR 1700000000",
    );
  });

  it("lists the four switches the route accepts", () => {
    expect([...FAST_PAUSE_SWITCHES]).toEqual(["pool", "game", "jackpot", "deploy"]);
  });
});

describe("classifyFastPauseError", () => {
  it("maps 404 to not enabled", () => {
    expect(classifyFastPauseError(404, "x", "game")).toBe("Fast pause is not enabled on this env.");
  });

  it("maps 403 to wallet not on the list", () => {
    expect(classifyFastPauseError(403, "x", "game")).toBe("This wallet is not on the list.");
  });

  it("maps 502 to did not land and names the CLI command", () => {
    const pool = classifyFastPauseError(502, "x", "pool");
    expect(pool).toMatch(/did not land/i);
    expect(pool).toContain("pnpm --filter @hexvault/backend admin pause");
    expect(classifyFastPauseError(502, "x", "game")).toContain("admin pause-game");
    expect(classifyFastPauseError(502, "x", "jackpot")).toContain("admin pause-jackpot");
    expect(classifyFastPauseError(502, "x", "deploy")).toContain("admin pause-deploy");
  });

  it("falls back to the reason, then to a network line", () => {
    expect(classifyFastPauseError(400, "bad time", "pool")).toBe("bad time");
    expect(classifyFastPauseError(null, "", "pool")).toBe("Could not reach the server. Try again.");
  });
});
