import { describe, expect, it } from "vitest";

import { findLeak } from "./check-bundle-keys.mjs";

describe("findLeak", () => {
  it("flags a bundle carrying a keyed RPC URL", () => {
    const hit = findLeak([
      { path: "dist/assets/index.js", text: 'const RPC="https://x/?api-key=abc"' },
    ]);
    expect(hit).toEqual({
      file: "dist/assets/index.js",
      pattern: "api-key query param",
    });
  });

  it("flags a Solami keyed RPC or WebSocket URL", () => {
    for (const url of [
      "https://rpc.solami.fast/sol?api_key=abc",
      "wss://ws.solami.dev/ws/sol?api_key=abc",
    ]) {
      expect(findLeak([{ path: "dist/a.js", text: `const U="${url}"` }])).toEqual({
        file: "dist/a.js",
        pattern: "Solami api_key",
      });
    }
    expect(findLeak([{ path: "dist/a.js", text: 'q.api_key="x"' }])).toBeNull();
  });

  it("passes a clean bundle", () => {
    const hit = findLeak([
      { path: "dist/assets/index.js", text: 'const RPC="https://api.devnet.solana.com"' },
    ]);
    expect(hit).toBeNull();
  });

  it("ticket 14: allows exactly the one domain-locked host through", () => {
    const files = [
      {
        path: "dist/assets/index.js",
        text: 'const RPC="https://my-app.helius-rpc.com/?api-key=abc123"',
      },
    ];
    expect(findLeak(files, "my-app.helius-rpc.com")).toBeNull();
  });

  it("ticket 14: still fails on api-key= for any other host", () => {
    const files = [
      {
        path: "dist/assets/index.js",
        text: 'const RPC="https://my-app.helius-rpc.com/?api-key=abc123"; const OTHER="https://someone-elses-app.helius-rpc.com/?api-key=xyz789"',
      },
    ];
    expect(findLeak(files, "my-app.helius-rpc.com")).toEqual({
      file: "dist/assets/index.js",
      pattern: "api-key query param",
    });
  });

  it("ticket 14: no allowed host means no exception at all", () => {
    const files = [
      { path: "dist/assets/index.js", text: 'const RPC="https://x/?api-key=abc"' },
    ];
    expect(findLeak(files, undefined)).toEqual({
      file: "dist/assets/index.js",
      pattern: "api-key query param",
    });
  });
});
