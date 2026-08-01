import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBuiltPackageFixture,
  type BuiltPackageFixture,
} from "../helpers/package-fixture.js";

describe("package artifact fixtures", () => {
  it("gives simultaneous producers independent complete artifact directories", async () => {
    const outcomes = await Promise.allSettled([
      createBuiltPackageFixture(),
      createBuiltPackageFixture(),
    ]);
    const fixtures = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : []
    );

    try {
      expect(outcomes.map(({ status }) => status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const artifactDirectories = await Promise.all(
        fixtures.map(({ artifactDirectory }) => realpath(artifactDirectory)),
      );
      expect(new Set(artifactDirectories).size).toBe(2);
      await Promise.all(fixtures.map(({ artifactDirectory }) =>
        access(path.join(artifactDirectory, "index.js"))
      ));
    } finally {
      await Promise.all(fixtures.map(
        ({ cleanup }: BuiltPackageFixture) => cleanup(),
      ));
    }
  }, 120_000);
});
