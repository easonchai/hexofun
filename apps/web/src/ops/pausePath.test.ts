import { describe, expect, it } from "vitest";

import type { PauseSwitch } from "./admin.js";
import { pausePath } from "./pausePath.js";
import type { Role } from "./role.js";

const ALL: PauseSwitch[] = ["pool", "game", "jackpot", "deploy", "buyTickets"];
const NOT_BOUGHT = ALL.filter((s) => s !== "buyTickets");
const kind = (role: Role | null, sw: PauseSwitch, paused: boolean | null, canSign = true) =>
  pausePath(role, sw, paused, canSign).kind;

describe("pausePath", () => {
  it("lets the Admin sign every pause and start", () => {
    for (const sw of ALL) {
      expect(kind("Admin", sw, false)).toBe("sign");
      expect(kind("Admin", sw, true)).toBe("sign");
    }
  });

  it("lets the Operator sign pauses except Bought tickets, which it prepares", () => {
    for (const sw of NOT_BOUGHT) expect(kind("Operator", sw, false)).toBe("sign");
    expect(kind("Operator", "buyTickets", false)).toBe("prepare");
  });

  it("sends a Fast pause signer through the backend for the four switches", () => {
    for (const sw of NOT_BOUGHT) expect(kind("Fast pause signer", sw, false)).toBe("fast");
  });

  it("never offers Fast pause on Bought tickets", () => {
    expect(kind("Fast pause signer", "buyTickets", false)).toBe("prepare");
  });

  it("falls back to Prepare when a Fast pause wallet cannot sign messages", () => {
    const path = pausePath("Fast pause signer", "pool", false, false);
    expect(path.kind).toBe("prepare");
    expect(path.note).toMatch(/cannot sign messages/);
  });

  it("prepares for a Viewer and for no wallet", () => {
    for (const sw of ALL) {
      expect(kind("Viewer", sw, false)).toBe("prepare");
      expect(kind(null, sw, false)).toBe("prepare");
    }
  });

  it("allows only the Admin to sign a start; everyone else prepares and is told why", () => {
    for (const role of ["Operator", "Fast pause signer", "Viewer", null] as const) {
      for (const sw of ALL) {
        expect(pausePath(role, sw, true, true)).toEqual({ kind: "prepare", note: "Only the Admin can restart" });
      }
    }
  });

  it("has no path while the state is unknown", () => {
    for (const role of ["Admin", "Operator", "Fast pause signer", "Viewer", null] as const) {
      expect(kind(role, "pool", null)).toBe("none");
    }
  });
});
