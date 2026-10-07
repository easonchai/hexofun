import { describe, expect, it } from "vitest";

import { roleOf } from "./role.js";

const summary = { admin: "ADMIN", operatorKey: "OPERATOR", fastPauseWallets: ["TEAM"] };

describe("roleOf", () => {
  it("names each role", () => {
    expect(roleOf("ADMIN", summary)).toBe("Admin");
    expect(roleOf("OPERATOR", summary)).toBe("Operator");
    expect(roleOf("TEAM", summary)).toBe("Fast pause signer");
    expect(roleOf("SOMEONE", summary)).toBe("Viewer");
  });

  it("has no role without a wallet or a summary", () => {
    expect(roleOf(null, summary)).toBeNull();
    expect(roleOf("ADMIN", null)).toBeNull();
  });

  it("ranks the Admin above a listed wallet", () => {
    expect(roleOf("ADMIN", { ...summary, fastPauseWallets: ["ADMIN"] })).toBe("Admin");
  });
});
