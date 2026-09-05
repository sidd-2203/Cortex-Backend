-- Enforce "one active run per chat" at the database level. Prisma's schema
-- DSL has no partial-index syntax, so this constraint is hand-written rather
-- than generated. The app layer already checks this before creating a run
-- (see POST /api/chats/[chatId]/messages) — this index is the backstop that
-- makes the invariant hold even under a race between two concurrent requests.
CREATE UNIQUE INDEX "one_active_run_per_chat"
ON "agent_runs" ("chatId")
WHERE "status" NOT IN ('COMPLETE', 'FAILED', 'CANCELLED');
