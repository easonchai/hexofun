import { describe, expect, it } from "vitest";

import {
  launchCountdown,
  launchCountdownLabel,
  prizeCardState,
  showsNextDrawLabel,
} from "./launch.js";

describe("launchCountdown", () => {
  it("is unscheduled with no launch time configured", () => {
    expect(launchCountdown(null, 1_000n)).toEqual({
      scheduled: false,
      remainingSeconds: null,
    });
  });

  it("is unscheduled with no launch time even before the chain clock is known", () => {
    expect(launchCountdown(null, null)).toEqual({
      scheduled: false,
      remainingSeconds: null,
    });
  });

  it("is scheduled with an unknown remainder before the chain clock is known", () => {
    expect(launchCountdown("2026-01-01T00:00:00.000Z", null)).toEqual({
      scheduled: true,
      remainingSeconds: null,
    });
  });

  it("counts down to a future launch time", () => {
    const launchAt = new Date(1_700_003_600_000).toISOString();
    const result = launchCountdown(launchAt, 1_700_000_000n);
    expect(result.scheduled).toBe(true);
    expect(result.remainingSeconds).toBe(3_600n);
  });

  it("floors a past launch time at 0 rather than going negative", () => {
    const launchAt = new Date(1_700_000_000_000).toISOString();
    const result = launchCountdown(launchAt, 1_700_003_600n);
    expect(result.remainingSeconds).toBe(0n);
  });
});

describe("launchCountdownLabel", () => {
  it("names the unscheduled case", () => {
    expect(launchCountdownLabel(launchCountdown(null, 1_000n))).toBe("Coming soon");
  });

  it("shows a placeholder before the chain clock is known", () => {
    expect(
      launchCountdownLabel(launchCountdown("2026-01-01T00:00:00.000Z", null)),
    ).toBe("First draw in —");
  });

  it("formats the remainder as DD:HH:MM:SS", () => {
    const launchAt = new Date(1_700_003_661_000).toISOString(); // +1h 1s
    const label = launchCountdownLabel(launchCountdown(launchAt, 1_700_000_000n));
    expect(label).toBe("First draw in 00:01:01:01");
  });
});

describe("prizeCardState", () => {
  it("is live with no gate, an epoch and no pause", () => {
    expect(prizeCardState(false, true, false, false)).toBe("live");
  });

  it("falls to paused when the chain switch is on", () => {
    expect(prizeCardState(false, true, true, false)).toBe("paused");
  });

  it("falls to launch with no epoch yet while LAUNCH_AT is scheduled", () => {
    expect(prizeCardState(false, false, false, true)).toBe("launch");
    expect(prizeCardState(false, false, true, true)).toBe("launch");
  });

  it("stays live (clock at zero) with no epoch and nothing scheduled", () => {
    expect(prizeCardState(false, false, false, false)).toBe("live");
    expect(prizeCardState(false, false, true, false)).toBe("live");
  });

  it("the gate wins over a live epoch, even over paused", () => {
    expect(prizeCardState(true, true, false, false)).toBe("launch");
    expect(prizeCardState(true, true, true, true)).toBe("launch");
  });
});

describe("showsNextDrawLabel", () => {
  it("shows above the live countdown and the launch countdown", () => {
    expect(showsNextDrawLabel("live", false, 3_600n)).toBe(true);
    expect(showsNextDrawLabel("live", false, null)).toBe(true);
    expect(showsNextDrawLabel("launch", false, null)).toBe(true);
  });

  it("is gone while DRAWING… is up, whether the program says so or the clock ran out", () => {
    expect(showsNextDrawLabel("live", true, 3_600n)).toBe(false);
    expect(showsNextDrawLabel("live", false, 0n)).toBe(false);
    expect(showsNextDrawLabel("live", false, -5n)).toBe(false);
  });

  it("is gone while DRAW PAUSED is up", () => {
    expect(showsNextDrawLabel("paused", false, 3_600n)).toBe(false);
  });

  it("comes back with the next round's countdown", () => {
    expect(showsNextDrawLabel("live", true, 0n)).toBe(false);
    expect(showsNextDrawLabel("live", false, 86_400n)).toBe(true);
  });
});
