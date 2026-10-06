import { describe, expect, it } from "vitest";

import { idl } from "../idl.js";
import { errorText, explorerTxUrl, failureText } from "./tx.js";

const code = (name: string) => idl.errors!.find((e) => e.name === name)!.code;

describe("error names", () => {
  it("maps a program code to its name", () => {
    expect(errorText(code("NothingToHarvest"))).toMatch(/^NothingToHarvest: /);
    expect(failureText({ kind: "failed", code: code("NoDeficit") })).toMatch(/^NoDeficit/);
  });
  it("falls back for unknown and missing codes", () => {
    expect(errorText(999_999)).toBe("Program error 999999");
    expect(errorText(null)).toMatch(/failed/);
  });
  it("reads the code out of a thrown error's text", () => {
    const thrown = new Error(`custom program error: 0x${code("NothingToHarvest").toString(16)}`);
    expect(failureText({ kind: "thrown", error: thrown })).toMatch(/^NothingToHarvest/);
  });
  it("says so when the wallet declines", () => {
    expect(failureText({ kind: "thrown", error: new Error("User rejected the request.") })).toMatch(/declined/);
  });
  it("tells an expired send to be retried", () => {
    expect(failureText({ kind: "expired" })).toMatch(/Try again/);
  });
});

describe("explorerTxUrl", () => {
  it("follows the cluster", () => {
    expect(explorerTxUrl("SIG", "devnet", "https://api.devnet.solana.com")).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=devnet",
    );
    expect(explorerTxUrl("SIG", "mainnet-beta", "https://rpc.example.com")).toBe(
      "https://explorer.solana.com/tx/SIG",
    );
  });
  it("points a localhost RPC at the custom-URL mode", () => {
    expect(explorerTxUrl("SIG", "devnet", "http://127.0.0.1:8899")).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
    );
  });
});
