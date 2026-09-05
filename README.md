# Cortex — Backend

REST API, agent orchestration, and durable job execution for Cortex, an agent
chat application. This is the backend half of a two-repo split — the chat UI
lives in [cortex-frontend](https://github.com/sidd-2203/Cortex-Frontend).

> **Status:** Day 1 of a 3-day build. This README will keep growing as the
> remaining pieces (skills, credits, remaining Magica tools, attachments,
> full error-handling matrix) land.

## Stack

pnpm · Next.js 16 (App Router, Route Handlers only — no UI) · TypeScript
strict · PostgreSQL (Neon) · Prisma 7 · Clerk · OpenRouter Free ·
Trigger.dev · Zod

## Setup

```bash
pnpm install
cp .env.example .env   # fill in the values below
pnpm db:migrate        # applies prisma/migrations against DATABASE_URL
pnpm dev                # http://localhost:3000
```

Env vars (see `.env.example` for the full list with links to get each one):

| Var | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon (or any Postgres) — pooled connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk dashboard — same app as the frontend |
| `OPENROUTER_API_KEY` | openrouter.ai/keys — free tier, no card required |
| `TRIGGER_SECRET_KEY` | Trigger.dev dashboard → API keys (dev key for local) |
| `FRONTEND_ORIGIN` | the frontend's origin, for CORS |
| `MAGICA_API_KEY`, `TRANSLOADIT_KEY`/`SECRET` | not yet wired up (Day 2/3) |

To run the durable task worker locally (needed once the agent loop moves
into a real Trigger.dev task):

```bash
npx trigger.dev@latest dev
```

## Architecture

### Two repos, one contract

The frontend never redefines a type — `src/contracts/*.ts` (Zod schemas +
inferred types) is the single source of truth for every request/response
shape. Since there's no monorepo, the frontend currently keeps a flagged,
verbatim copy of these files (see the banner comment in each) rather than
inventing its own shapes. This is a known Day-1 shortcut — see Trade-offs.

### Data model (`prisma/schema.prisma`)

`User` → `Chat` → `Message` (ordered content blocks, JSONB) → `AgentRun` →
`ToolInvocation` / `RunSkill` / `Waitpoint`, plus `CreditLedger`. Notable
choices:

- **Ownership on every mutable row** (`ownerId`), checked on every mutation —
  never trusted from the client.
- **Cursor pagination** via composite `(createdAt, id)` / `(updatedAt, id)`
  indexes — no unbounded/offset scans.
- **One active run per chat** is enforced twice: once in the route handler
  (fast-path check before touching OpenRouter) and once at the database
  level via a hand-written partial unique index
  (`migrations/..._one_active_run_per_chat`) — Prisma's schema DSL can't
  express a partial index, so this one migration is raw SQL. This is the
  backstop that holds even under a race between two concurrent requests.
- **Idempotency keys are unique constraints**, not app-level checks —
  `AgentRun.idempotencyKey` is unique, so a retried send-turn request can
  never dispatch a second run for the same client-generated key.
- **JSONB only for validated, variable-shape content** (message content
  blocks, tool input/output) — everything filterable/sortable is a real
  column.

### Auth

Clerk, with a deliberate departure from the "gate everything in middleware"
pattern: every route calls `requireUser()` (`src/lib/auth.ts`) itself, which
is also what Clerk's own current guidance recommends over
`createRouteMatcher`-based middleware gating (path matching can diverge from
how Next.js actually routes a request). `src/proxy.ts` is CORS-only.

Frontend and backend are separate origins with no shared cookie jar, so the
frontend authenticates with a Clerk session **token** as a Bearer header,
not cookies.

### The agent loop (`src/lib/agent/run-turn.ts`)

`runTurn(runId, onTextDelta)` loads recent chat history, calls OpenRouter
Free (`openrouter/free` — the router that picks a real underlying free
model per request; never a paid fallback), and persists the result. It's
deliberately synchronous/in-process for Day 1 — this is the exact seam that
becomes a Trigger.dev durable task once retries/cancellation/survival-across-
restarts matter (Day 2). Nothing above this function (the route handler)
needs to change when that happens.

The actual model that served a request (from OpenRouter's response, not the
`openrouter/free` alias) is recorded on `AgentRun.model` — this is the "Model
Discovery" requirement in its Day-1 form; it becomes a first-class tool
invocation once the tool registry lands.

### Errors

Every route wraps its body in `withApiError()` (`src/lib/api-error.ts`),
which maps known error types to a consistent `{ error: { code, message } }`
envelope and logs a structured line (`src/lib/logger.ts`) tagged with
whatever correlation ids are on hand (chatId/runId/messageId/traceId).
Ownership failures return `404`, never `403` — an authenticated caller can't
distinguish someone else's chat from one that doesn't exist.

## Trade-offs / what I'd improve with more time

- **Shared types without a monorepo**: copying `src/contracts` into the
  frontend works but can drift. The real fix is either a small published
  package or a generated client — deferred past Day 1 to keep the two-repo
  setup simple while the core loop was still being proven.
- **`exactOptionalPropertyTypes`** was enabled, then turned off — it fought
  Prisma's generated types constantly for little practical benefit. Kept
  `noUncheckedIndexedAccess` and `noImplicitOverride`.
- **Partial persistence mid-stream**: the assistant message is written once,
  at the end of the stream, not incrementally as tokens arrive. Reload
  recovery of an *in-progress* run isn't possible yet — it becomes free once
  the loop moves into a Trigger.dev task with Realtime as the transport.
- **No tool-calling loop yet**: Day 1 is plain text completion. The tool
  registry, skills system, and the three required Magica tools land Day 2/3.
- **Credits, waitpoints**: modeled in the schema, not wired into the request
  path yet.

## Prisma 7 / Next 16 / React 19.2 note

These are all newer than typical training data cutoffs. Where behavior
looked surprising (no `url` in the `datasource` block, driver adapters being
mandatory, `middleware.ts` → `proxy.ts`), it was verified against the
bundled docs (`node_modules/next/dist/docs`) and live `prisma
generate`/`migrate` runs rather than assumed.
