import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  getBalance,
  requireSufficientCredits,
  settleToolCharge,
  InsufficientCreditsError,
} from "./ledger";

// Integration test against the real dev database — the whole point of this
// module is atomic, race-safe DB behavior, which a mocked Prisma client
// can't meaningfully stand in for. relatedInvocationId has a real foreign
// key to ToolInvocation, so settlement needs a real row to point at, same
// as it would in actual use (see execute-tool-call.ts).

describe("credits ledger", () => {
  const ownerId = "test_user_credits_ledger";
  const STARTING_BALANCE = 50;
  let runId: string;
  let chatId: string;

  async function makeInvocation() {
    const inv = await prisma.toolInvocation.create({
      data: { runId, toolName: "test-tool", input: {}, status: "SUCCEEDED", sequence: 0 },
    });
    return inv.id;
  }

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ownerId },
      update: { creditBalance: STARTING_BALANCE },
      create: { id: ownerId, email: "credits-ledger-test@test.local", creditBalance: STARTING_BALANCE },
    });
    const chat = await prisma.chat.create({ data: { ownerId, title: "credits ledger test" } });
    chatId = chat.id;
    const run = await prisma.agentRun.create({
      data: { chatId, idempotencyKey: `credits-test-${Date.now()}`, status: "WORKING" },
    });
    runId = run.id;
  });

  afterAll(async () => {
    await prisma.creditLedger.deleteMany({ where: { ownerId } });
    await prisma.toolInvocation.deleteMany({ where: { runId } });
    await prisma.agentRun.deleteMany({ where: { chatId } });
    await prisma.chat.delete({ where: { id: chatId } });
    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  it("getBalance reflects the user's current creditBalance", async () => {
    expect(await getBalance(ownerId)).toBe(STARTING_BALANCE);
  });

  it("requireSufficientCredits passes when the balance covers the cost", async () => {
    await expect(requireSufficientCredits(ownerId, STARTING_BALANCE)).resolves.toBeUndefined();
  });

  it("requireSufficientCredits throws InsufficientCreditsError when it doesn't", async () => {
    await expect(requireSufficientCredits(ownerId, STARTING_BALANCE + 1)).rejects.toThrow(
      InsufficientCreditsError,
    );
  });

  it("requireSufficientCredits is a no-op for a zero/free cost", async () => {
    await expect(requireSufficientCredits(ownerId, 0)).resolves.toBeUndefined();
  });

  it("settleToolCharge decrements the balance and records one ledger entry", async () => {
    const invocationId = await makeInvocation();
    await settleToolCharge({ ownerId, toolInvocationId: invocationId, cost: 10 });

    expect(await getBalance(ownerId)).toBe(STARTING_BALANCE - 10);
    const entries = await prisma.creditLedger.findMany({ where: { ownerId, relatedInvocationId: invocationId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.delta).toBe(-10);
    expect(entries[0]!.reason).toBe("TOOL_CHARGE");
  });

  it("settling the same invocation twice charges exactly once (idempotent)", async () => {
    const invocationId = await makeInvocation();
    await settleToolCharge({ ownerId, toolInvocationId: invocationId, cost: 5 });
    const balanceAfterFirst = await getBalance(ownerId);

    await settleToolCharge({ ownerId, toolInvocationId: invocationId, cost: 5 });
    const balanceAfterSecond = await getBalance(ownerId);

    expect(balanceAfterSecond).toBe(balanceAfterFirst); // not charged twice
    const entries = await prisma.creditLedger.findMany({ where: { ownerId, relatedInvocationId: invocationId } });
    expect(entries).toHaveLength(1);
  });

  it("settleToolCharge throws InsufficientCreditsError and doesn't touch the balance when it can't cover the cost", async () => {
    const invocationId = await makeInvocation();
    const before = await getBalance(ownerId);
    await expect(
      settleToolCharge({ ownerId, toolInvocationId: invocationId, cost: before + 1000 }),
    ).rejects.toThrow(InsufficientCreditsError);

    expect(await getBalance(ownerId)).toBe(before); // unchanged
    const entries = await prisma.creditLedger.findMany({ where: { ownerId, relatedInvocationId: invocationId } });
    expect(entries).toHaveLength(0);
  });

  it("settleToolCharge is a no-op for a zero/free cost", async () => {
    const invocationId = await makeInvocation();
    const before = await getBalance(ownerId);
    await settleToolCharge({ ownerId, toolInvocationId: invocationId, cost: 0 });
    expect(await getBalance(ownerId)).toBe(before);
  });
});
