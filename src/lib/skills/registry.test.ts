import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  SkillsRegistry,
  SkillNotFoundError,
  AssetNotFoundError,
  AssetPathTraversalError,
} from "./registry";

const FIXTURES_DIR = resolve(import.meta.dirname, "__fixtures__");

describe("SkillsRegistry.load", () => {
  it("discovers every well-formed skill folder", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const names = registry.list().map((s) => s.name);
    expect(names).toContain("valid-skill");
    expect(names).toContain("skill-with-assets");
  });

  it("selective loading: list() exposes only name + description, never the body", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const summary = registry.list().find((s) => s.name === "valid-skill");
    expect(summary).toEqual({
      name: "valid-skill",
      description: "A well-formed test skill with no assets.",
    });
    expect(summary).not.toHaveProperty("body");
    expect(summary).not.toHaveProperty("content");
  });

  it("get() only returns the full body when explicitly requested by name", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const skill = registry.get("valid-skill");
    expect(skill.body).toContain("only visible after load_skill");
  });

  it("skips a folder with malformed frontmatter (missing block entirely) and records a warning", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(registry.list().map((s) => s.name)).not.toContain("malformed-no-frontmatter");
    expect(registry.warnings.some((w) => w.includes("malformed-no-frontmatter"))).toBe(true);
  });

  it("skips a folder with malformed frontmatter (missing required field) and records a warning", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(registry.list().map((s) => s.name)).not.toContain("missing-description");
    expect(registry.warnings.some((w) => w.includes("malformed-missing-description"))).toBe(true);
  });

  it("silently skips a folder with no SKILL.md at all", () => {
    // Should neither throw nor appear in the list — just not a skill.
    expect(() => SkillsRegistry.load(FIXTURES_DIR)).not.toThrow();
  });

  it("duplicates: keeps the first skill discovered (deterministic folder order) and warns about the rest", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const shared = registry.get("shared-name");
    expect(shared.body).toContain("Body of the first duplicate");
    expect(registry.warnings.some((w) => w.includes('Duplicate skill name "shared-name"'))).toBe(true);
  });

  it("throws SkillNotFoundError for an unknown skill name", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(() => registry.get("does-not-exist")).toThrow(SkillNotFoundError);
  });
});

describe("SkillsRegistry.readAsset", () => {
  it("reads a real asset within the skill's assets/ folder", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const content = registry.readAsset("skill-with-assets", "note.txt");
    expect(content).toContain("harmless test asset");
  });

  it("throws AssetNotFoundError for a nonexistent asset", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(() => registry.readAsset("skill-with-assets", "nope.txt")).toThrow(AssetNotFoundError);
  });

  it("traversal: rejects ../ escaping the skill's own folder entirely", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(() => registry.readAsset("skill-with-assets", "../../secret.txt")).toThrow(
      AssetPathTraversalError,
    );
  });

  it("traversal: rejects escaping assets/ into the skill's own folder", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    // SKILL.md.bak sits next to SKILL.md, one level up from assets/ — a
    // read_skill_asset call must not be able to reach it either.
    expect(() => registry.readAsset("skill-with-assets", "../SKILL.md.bak")).toThrow(
      AssetPathTraversalError,
    );
  });

  it("traversal: rejects an absolute path", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    const absoluteSecret = resolve(FIXTURES_DIR, "secret.txt");
    expect(() => registry.readAsset("skill-with-assets", absoluteSecret)).toThrow(
      AssetPathTraversalError,
    );
  });

  it("throws SkillNotFoundError when the skill itself doesn't exist", () => {
    const registry = SkillsRegistry.load(FIXTURES_DIR);
    expect(() => registry.readAsset("does-not-exist", "note.txt")).toThrow(SkillNotFoundError);
  });
});

describe("SkillsRegistry.load with a missing root directory", () => {
  it("doesn't throw, just returns an empty registry with a warning", () => {
    const registry = SkillsRegistry.load(resolve(FIXTURES_DIR, "does-not-exist-at-all"));
    expect(registry.list()).toEqual([]);
    expect(registry.warnings.length).toBeGreaterThan(0);
  });
});
