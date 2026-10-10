import { describe, expect, it } from "vitest";

import { playLock } from "./tabs.js";

// App.tsx wires `playLock`'s result straight onto the PLAY nav item:
// non-null -> aria-disabled + data-tip, and `onClick` left undefined, so a
// click can never call `setTab`. Asserting the result here is asserting
// what App.tsx renders and whether clicking it does anything (ticket 01,
// feature-gates; no jsdom/@testing-library/react in this repo to click a
// real DOM node).
describe("playLock", () => {
  it("is not locked with tickets and no gate", () => {
    expect(playLock(false, 1n)).toBeNull();
  });

  it("locks on the zero-Tickets rule when not gated", () => {
    expect(playLock(false, 0n)).toEqual({ tip: "Deposit first to play" });
  });

  it("locks with the gate's own tip even with tickets in hand", () => {
    expect(playLock(true, 1n)).toEqual({ tip: "Coming soon" });
  });

  it("the gate wins over the zero-Tickets lock", () => {
    expect(playLock(true, 0n)).toEqual({ tip: "Coming soon" });
  });
});
