import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepoKind, kindIcon } from "../src/kind.js";

function dirWith(...files) {
  const dir = mkdtempSync(join(tmpdir(), "reap-kind-"));
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
}

describe("detectRepoKind", () => {
  test("marker files map to stacks", () => {
    expect(detectRepoKind(dirWith("Cargo.toml"))).toBe("rust");
    expect(detectRepoKind(dirWith("go.mod"))).toBe("go");
    expect(detectRepoKind(dirWith("pyproject.toml"))).toBe("python");
    expect(detectRepoKind(dirWith("requirements.txt"))).toBe("python");
    expect(detectRepoKind(dirWith("Gemfile"))).toBe("ruby");
    expect(detectRepoKind(dirWith("composer.json"))).toBe("php");
    expect(detectRepoKind(dirWith("pom.xml"))).toBe("jvm");
    expect(detectRepoKind(dirWith("mix.exs"))).toBe("elixir");
  });

  test("package.json alone is js; with tsconfig.json it is ts", () => {
    expect(detectRepoKind(dirWith("package.json"))).toBe("js");
    expect(detectRepoKind(dirWith("package.json", "tsconfig.json"))).toBe("ts");
  });

  test("no markers falls back to a plain repo", () => {
    expect(detectRepoKind(dirWith("README.md"))).toBe("repo");
  });
});

describe("kindIcon", () => {
  test("emoji is the default mode", () => {
    expect(kindIcon("rust")).toBe("🦀");
    expect(kindIcon("repo")).toBe("📁");
  });

  test("nerd mode returns PUA devicons (opt-in via GIT_REAP_ICONS=nerd)", () => {
    expect(kindIcon("rust", "nerd")).toBe("\ue7a8");
    expect(kindIcon("repo", "nerd")).toBe("\uf07b");
  });

  test("unknown kinds fall back to the plain repo icon", () => {
    expect(kindIcon("cobol")).toBe("📁");
  });
});
