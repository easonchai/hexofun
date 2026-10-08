import { describe, expect, it } from "vitest";

import { burnerEnabled, isLocalRpc } from "./dev-burner.js";

/**
 * The burner is an in-page keypair, so its gate is a security boundary. It
 * replaced a VITE_CLUSTER check, which no longer exists: the RPC endpoint is
 * now the only thing that says "this is a local validator".
 */
describe("dev burner gate", () => {
  it("recognises a local validator endpoint, and only that", () => {
    expect(isLocalRpc("http://127.0.0.1:8899")).toBe(true);
    expect(isLocalRpc("http://localhost:8899")).toBe(true);
    // No endpoint set: chain.ts defaults to the local validator.
    expect(isLocalRpc(undefined)).toBe(true);
    expect(isLocalRpc("   ")).toBe(true);
    expect(isLocalRpc("https://api.devnet.solana.com")).toBe(false);
    expect(isLocalRpc("https://devnet.helius-rpc.com/?api-key=x")).toBe(false);
    // A hostname that merely contains "localhost" is not localhost.
    expect(isLocalRpc("https://localhost.evil.example")).toBe(false);
  });

  it("needs the opt-in flag as well as the local endpoint", () => {
    const local = "http://127.0.0.1:8899";
    expect(
      burnerEnabled({ VITE_BURNER_WALLET: "1", VITE_PUBLIC_RPC_URL: local }, true),
    ).toBe(true);
    expect(burnerEnabled({ VITE_PUBLIC_RPC_URL: local }, true)).toBe(false);
    expect(
      burnerEnabled({ VITE_BURNER_WALLET: "0", VITE_PUBLIC_RPC_URL: local }, true),
    ).toBe(false);
    expect(
      burnerEnabled(
        {
          VITE_BURNER_WALLET: "1",
          VITE_PUBLIC_RPC_URL: "https://api.devnet.solana.com",
        },
        true,
      ),
    ).toBe(false);
  });

  it("stays off in a production build even with the flag and no RPC URL", () => {
    expect(burnerEnabled({ VITE_BURNER_WALLET: "1" }, false)).toBe(false);
    expect(
      burnerEnabled({ VITE_BURNER_WALLET: "1", VITE_PUBLIC_RPC_URL: "" }, false),
    ).toBe(false);
  });
});
