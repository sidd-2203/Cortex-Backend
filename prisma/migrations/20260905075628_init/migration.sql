-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('GRANT', 'TOOL_CHARGE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'STREAMING', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'THINKING', 'WORKING', 'WAITING', 'STOPPING', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitpointType" AS ENUM ('APPROVAL', 'DECISION');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "relatedInvocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'COMPLETE',
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "ownerId" TEXT NOT NULL,
    "assemblyId" TEXT,
    "type" "AttachmentType" NOT NULL,
    "url" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "triggerRunId" TEXT,
    "model" TEXT,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" "ToolStatus" NOT NULL DEFAULT 'PENDING',
    "cost" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_skills" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitpoints" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "WaitpointType" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "token" TEXT NOT NULL,
    "payload" JSONB,
    "resolution" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "waitpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_relatedInvocationId_key" ON "credit_ledger"("relatedInvocationId");

-- CreateIndex
CREATE INDEX "credit_ledger_ownerId_createdAt_idx" ON "credit_ledger"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "chats_ownerId_deletedAt_pinned_updatedAt_idx" ON "chats"("ownerId", "deletedAt", "pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "messages_chatId_createdAt_id_idx" ON "messages"("chatId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "attachments_ownerId_createdAt_idx" ON "attachments"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_idempotencyKey_key" ON "agent_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_runs_chatId_createdAt_idx" ON "agent_runs"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "tool_invocations_runId_sequence_idx" ON "tool_invocations"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "run_skills_runId_skillName_key" ON "run_skills"("runId", "skillName");

-- CreateIndex
CREATE UNIQUE INDEX "waitpoints_token_key" ON "waitpoints"("token");

-- CreateIndex
CREATE INDEX "waitpoints_runId_idx" ON "waitpoints"("runId");

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_relatedInvocationId_fkey" FOREIGN KEY ("relatedInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_skills" ADD CONSTRAINT "run_skills_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitpoints" ADD CONSTRAINT "waitpoints_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
