import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withOpenClawInstallLease } from "../helpers/openclaw-install-lease.js";

describe("OpenClaw integration install lease", () => {
  it("serializes simultaneous install critical sections", async () => {
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 3 }, () =>
        withOpenClawInstallLease(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await delay(25);
          active -= 1;
        })
      ),
    );

    expect(maximumActive).toBe(1);
  });
});
