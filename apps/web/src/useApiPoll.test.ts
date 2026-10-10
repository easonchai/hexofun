import { describe, expect, it } from "vitest";

import { scoped } from "./useApiPoll.js";

// The hooks hold their data as { key, value } and read it through `scoped`
// (no jsdom/@testing-library here to render them), so this is the reset a
// wallet switch gets: data held for the old owner reads as empty under the
// new one until a fetch for the new owner stores its own.
describe("scoped", () => {
  const held = { key: "Ai1ce", value: { principal: "5" } };

  it("returns the value under the key it was held for", () => {
    expect(scoped(held, "Ai1ce", null)).toEqual({ principal: "5" });
  });

  it("returns the empty value as soon as the owner changes", () => {
    expect(scoped(held, "B0b", null)).toBeNull();
  });

  it("stays empty when the new owner's fetch failed, as a 404 does", () => {
    // A failed fetch keeps `scoped(current, newKey, empty)` as the carried data.
    const afterFailure = { key: "B0b", value: scoped(held, "B0b", null) };
    expect(scoped(afterFailure, "B0b", null)).toBeNull();
  });

  it("is empty before anything is held", () => {
    expect(scoped(null, undefined, null)).toBeNull();
  });
});
