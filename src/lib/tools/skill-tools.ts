import { defineTool } from "@/contracts/tools";
import {
  LoadSkillInputSchema,
  LoadSkillOutputSchema,
  ReadSkillAssetInputSchema,
  ReadSkillAssetOutputSchema,
} from "@/contracts/tools";
import { getSkillsRegistry } from "@/lib/skills/registry";
import { prisma } from "@/lib/db";
import { toolRegistry } from "./registry";

export const loadSkillTool = defineTool({
  name: "load_skill",
  description:
    "Load the full guidance for a skill by name. Skills are only shown to you as name + description until loaded — call this before following a skill's guidance.",
  inputSchema: LoadSkillInputSchema,
  outputSchema: LoadSkillOutputSchema,
  execute: async (input, ctx) => {
    const skill = getSkillsRegistry().get(input.name); // throws SkillNotFoundError if unknown

    // Durable + dedup: recorded once per (run, skill) no matter how many
    // times it's loaded in that run — a retried or repeated tool call for
    // the same skill converges on the same row instead of erroring or
    // duplicating.
    await prisma.runSkill.upsert({
      where: { runId_skillName: { runId: ctx.runId, skillName: skill.name } },
      update: {},
      create: { runId: ctx.runId, skillName: skill.name, contentHash: skill.contentHash },
    });

    return { name: skill.name, content: skill.body };
  },
});

export const readSkillAssetTool = defineTool({
  name: "read_skill_asset",
  description:
    "Read a supplementary file that belongs to a skill (referenced by that skill's own guidance, e.g. a reference sheet).",
  inputSchema: ReadSkillAssetInputSchema,
  outputSchema: ReadSkillAssetOutputSchema,
  execute: async (input) => {
    const content = getSkillsRegistry().readAsset(input.skillName, input.assetPath);
    return { content };
  },
});

export function registerSkillTools(): void {
  toolRegistry.register(loadSkillTool);
  toolRegistry.register(readSkillAssetTool);
}
