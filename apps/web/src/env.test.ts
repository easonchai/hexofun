import { describe, expect, it } from "vitest";

import { validateProdEnv } from "./env.js";

const FULL_ENV = {
  VITE_CLUSTER: "mainnet-beta",
  VITE_PUBLIC_RPC_URL: "https://rpc.example.com",
  VITE_API_URL: "https://api.example.com",
  VITE_PRIVY_APP_ID: "app-id",
  VITE_PROGRAM_ID: "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6",
  VITE_POOL_ID: "1",
};

describe("validateProdEnv", () => {
  it("passes when every required value is set", () => {
    expect(() => validateProdEnv(FULL_ENV)).not.toThrow();
  });

  it("fails per missing value, naming each one", () => {
    const { VITE_PRIVY_APP_ID: _drop, ...rest } = FULL_ENV;
    expect(() => validateProdEnv(rest)).toThrow(/VITE_PRIVY_APP_ID/);
  });

  it("names every missing value at once, not just the first", () => {
    expect(() => validateProdEnv({})).toThrow(
      /VITE_CLUSTER.*VITE_PUBLIC_RPC_URL.*VITE_API_URL.*VITE_PRIVY_APP_ID.*VITE_PROGRAM_ID.*VITE_POOL_ID/s,
    );
  });

  it("requires the public RPC URL, with a message naming it", () => {
    const { VITE_PUBLIC_RPC_URL: _drop, ...rest } = FULL_ENV;
    expect(() => validateProdEnv(rest)).toThrow(
      /Missing required production environment value\(s\): VITE_PUBLIC_RPC_URL/,
    );
  });

  it("treats a blank value the same as a missing one", () => {
    expect(() => validateProdEnv({ ...FULL_ENV, VITE_API_URL: "   " })).toThrow(
      /VITE_API_URL/,
    );
  });
});
