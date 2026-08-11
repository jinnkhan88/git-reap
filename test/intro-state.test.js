import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introSeen, introStatePath, markIntroSeen } from "../src/intro-state.js";

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), "reap-intro-"));
}

describe("intro state", () => {
  test("starts unseen; markIntroSeen flips it; idempotent", () => {
    const dir = tmpDataDir();
    expect(introSeen(dir)).toBe(false);
    markIntroSeen(dir);
    expect(introSeen(dir)).toBe(true);
    expect(existsSync(introStatePath(dir))).toBe(true);
    markIntroSeen(dir); // no throw
    expect(introSeen(dir)).toBe(true);
  });
});
