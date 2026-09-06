import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseSkillFile, MalformedFrontmatterError } from "./frontmatter";

export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  contentHash: string;
  dir: string;
}

export interface SkillSummary {
  name: string;
  description: string;
}

export class SkillNotFoundError extends Error {
  constructor(public skillName: string) {
    super(`Unknown skill: ${skillName}`);
    this.name = "SkillNotFoundError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(
    public skillName: string,
    public assetPath: string,
  ) {
    super(`Asset not found: ${skillName}/assets/${assetPath}`);
    this.name = "AssetNotFoundError";
  }
}

export class AssetPathTraversalError extends Error {
  constructor(
    public skillName: string,
    public assetPath: string,
  ) {
    super(`Asset path escapes the skill's directory: ${assetPath}`);
    this.name = "AssetPathTraversalError";
  }
}

/**
 * Skills are discovered once per process from `agent-skills/<name>/SKILL.md`
 * and cached — "discovered at startup" in spirit, without needing an actual
 * long-running server (this module is a lazily-initialized singleton, so a
 * cold Trigger.dev task/Next.js invocation scans once and every subsequent
 * call in that process reuses the result).
 *
 * A folder becomes a skill with zero code changes elsewhere — the registry
 * only ever reads the filesystem, nothing here names a specific skill.
 */
export class SkillsRegistry {
  private readonly skills = new Map<string, SkillEntry>();
  readonly warnings: string[] = [];

  private constructor() {}

  static load(rootDir: string): SkillsRegistry {
    const registry = new SkillsRegistry();

    let dirNames: string[];
    try {
      dirNames = readdirSync(rootDir).sort(); // sorted: discovery order is deterministic
    } catch {
      registry.warnings.push(`Skills directory not found: ${rootDir}`);
      return registry;
    }

    for (const dirName of dirNames) {
      const skillDir = join(rootDir, dirName);
      if (!statSync(skillDir).isDirectory()) continue;

      const skillFilePath = join(skillDir, "SKILL.md");
      let raw: string;
      try {
        raw = readFileSync(skillFilePath, "utf8");
      } catch {
        registry.warnings.push(`${dirName}: no SKILL.md found, skipping`);
        continue;
      }

      let parsed: ReturnType<typeof parseSkillFile>;
      try {
        parsed = parseSkillFile(skillFilePath, raw);
      } catch (err) {
        if (err instanceof MalformedFrontmatterError) {
          registry.warnings.push(err.message + " — skipping this skill");
          continue;
        }
        throw err;
      }

      const { name, description } = parsed.frontmatter;
      if (registry.skills.has(name)) {
        registry.warnings.push(
          `Duplicate skill name "${name}" (folder "${dirName}") — keeping the first one discovered, skipping this one`,
        );
        continue;
      }

      registry.skills.set(name, {
        name,
        description,
        body: parsed.body,
        contentHash: createHash("sha256").update(raw).digest("hex"),
        dir: resolve(skillDir),
      });
    }

    return registry;
  }

  /** Name + description only — this is all the model ever sees unsolicited. */
  list(): SkillSummary[] {
    return [...this.skills.values()].map(({ name, description }) => ({ name, description }));
  }

  get(name: string): SkillEntry {
    const skill = this.skills.get(name);
    if (!skill) throw new SkillNotFoundError(name);
    return skill;
  }

  /**
   * Reads a file from `<skill>/assets/<assetPath>`. Resolves the final path
   * and checks it's still inside that skill's own directory before reading
   * anything — rejects `../../etc/passwd`-style traversal, and rejects an
   * absolute path explicitly rather than relying on `path.join` happening
   * to neutralize it (it does, on both POSIX and Windows, by flattening an
   * absolute second argument into a literal sub-path — but that's
   * `path.join`'s documented quirk, not a security decision we made, and
   * isn't something worth depending on).
   */
  readAsset(skillName: string, assetPath: string): string {
    const skill = this.get(skillName);
    if (isAbsolute(assetPath)) {
      throw new AssetPathTraversalError(skillName, assetPath);
    }

    const assetsDir = resolve(join(skill.dir, "assets"));
    const resolvedPath = resolve(join(assetsDir, assetPath));

    if (resolvedPath !== assetsDir && !resolvedPath.startsWith(assetsDir + sep)) {
      throw new AssetPathTraversalError(skillName, assetPath);
    }

    try {
      return readFileSync(resolvedPath, "utf8");
    } catch {
      throw new AssetNotFoundError(skillName, assetPath);
    }
  }
}

let cached: SkillsRegistry | null = null;

/**
 * Resolved from `process.cwd()` rather than this file's own location —
 * this module runs under two different bundlers (Next.js/Turbopack for
 * route handlers, esbuild for the Trigger.dev task), and `import.meta.url`-
 * relative resolution isn't guaranteed to survive both the same way. Both
 * runtimes invoke from the repo root, which is also what
 * `additionalFiles({ files: ["agent-skills/**\/*"] })` in trigger.config.ts
 * assumes.
 */
export function getSkillsRegistry(): SkillsRegistry {
  if (!cached) {
    cached = SkillsRegistry.load(resolve(process.cwd(), "agent-skills"));
  }
  return cached;
}
