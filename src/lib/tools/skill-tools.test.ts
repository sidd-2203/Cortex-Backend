import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { loadSkillTool } from "./skill-tools";

// Integration test against the real dev database — dedup and resume are
// specifically about RunSkill's persistence behavior, which a pure
// filesystem/unit test can't exercise meaningfully. Uses a real skill from
// agent-skills/ (concise-answers) since which skill it is doesn't matter
// here, only what happens to the RunSkill row.

describe("load_skill: RunSkill dedup and resume", () => {
  const ownerId = "test_user_skill_dedup";
  let chatId: string;
  let runId: string;

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ownerId },
      update: {},
      create: { id: ownerId, email: "skill-dedup-test@test.local" },
    });
    const chat = await prisma.chat.create({ data: { ownerId, title: "dedup test" } });
    chatId = chat.id;
    const run = await prisma.agentRun.create({
      data: { chatId, idempotencyKey: `test-${Date.now()}`, status: "WORKING" },
    });
    runId = run.id;
  });

  afterAll(async () => {
    await prisma.runSkill.deleteMany({ where: { runId } });
    await prisma.agentRun.deleteMany({ where: { chatId } });
    await prisma.chat.delete({ where: { id: chatId } });
    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  it("dedup: loading the same skill twice in one run creates exactly one RunSkill row", async () => {
    await loadSkillTool.execute({ name: "concise-answers" }, { runId, chatId, ownerId });
    await loadSkillTool.execute({ name: "concise-answers" }, { runId, chatId, ownerId });

    const rows = await prisma.runSkill.findMany({ where: { runId, skillName: "concise-answers" } });
    expect(rows).toHaveLength(1);
  });

  it("resume: loading a skill already recorded for this run (as if the run were re-entered) doesn't error or duplicate", async () => {
    // Simulates re-entering an already-in-progress run (e.g. after a retry)
    // where the skill was already loaded and recorded before.
    await expect(loadSkillTool.execute({ name: "concise-answers" }, { runId, chatId, ownerId })).resolves.toBeDefined();

    const rows = await prisma.runSkill.findMany({ where: { runId, skillName: "concise-answers" } });
    expect(rows).toHaveLength(1);
  });

  it("loading a different skill in the same run adds a second, distinct row", async () => {
    await loadSkillTool.execute({ name: "math-explainer" }, { runId, chatId, ownerId });
    const rows = await prisma.runSkill.findMany({ where: { runId } });
    const names = rows.map((r) => r.skillName).sort();
    expect(names).toEqual(["concise-answers", "math-explainer"]);
  });
});
