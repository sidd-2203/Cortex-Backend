import { z } from "zod";

export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be lowercase kebab-case"),
  description: z.string().min(1),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export class MalformedFrontmatterError extends Error {
  constructor(
    public path: string,
    reason: string,
  ) {
    super(`Malformed frontmatter in ${path}: ${reason}`);
    this.name = "MalformedFrontmatterError";
  }
}

/**
 * Deliberately not a full YAML parser — frontmatter here is always a flat
 * `key: value` block (see SkillFrontmatterSchema), and pulling in a YAML
 * dependency for two string fields isn't worth it. Values are taken
 * verbatim after the first `:`, so a description can itself contain colons.
 */
function parseFlatYaml(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Splits a SKILL.md file into its frontmatter and body. Throws
 * MalformedFrontmatterError for anything that doesn't parse — the registry
 * catches this per-file so one bad skill doesn't take down discovery for
 * every other one.
 */
export function parseSkillFile(
  path: string,
  raw: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new MalformedFrontmatterError(path, "missing --- frontmatter block");
  }
  const [, frontmatterBlock, body] = match;
  const parsed = parseFlatYaml(frontmatterBlock!);
  const result = SkillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    throw new MalformedFrontmatterError(path, result.error.issues.map((i) => i.message).join("; "));
  }
  return { frontmatter: result.data, body: (body ?? "").trim() };
}
