# Cortex — Backend

REST API, agent orchestration, and durable job execution for Cortex, an agent
chat application. This is the backend half of a two-repo split — the chat UI
lives in [cortex-frontend](https://github.com/sidd-2203/Cortex-Frontend).

**Live**: https://cortex-backend-peach.vercel.app ([health check](https://cortex-backend-peach.vercel.app/api/health))

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
| `MAGICA_API_KEY`, `TRANSLOADIT_KEY`/`SECRET` | not yet wired up |

The agent loop runs as a Trigger.dev task, not in-process — local dev needs
the task worker running alongside `pnpm dev`, or sent messages will dispatch
but never actually execute:

```bash
npx trigger.dev@latest dev
```

## Architecture

### Two repos, one contract

The frontend never redefines a type — `src/contracts/*.ts` (Zod schemas +
inferred types) is the single source of truth for every request/response
shape. Since there's no monorepo, the frontend currently keeps a flagged,
verbatim copy of these files (see the banner comment in each) rather than
inventing its own shapes — see Trade-offs.

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
frontend authenticates with a Clerk session token as a Bearer header, not
cookies.

### The agent loop (`src/lib/agent/run-turn.ts` + `src/trigger/agent-turn.ts`)

`runTurn(runId, onTextDelta)` loads recent chat history, calls OpenRouter
Free (`openrouter/free` — the router that picks a real underlying free
model per request; never a paid fallback), and persists the result. It runs
inside the `agent-turn` Trigger.dev task, not in the route handler — the
route handler dispatches the task and returns in around a second, regardless
of how long the actual completion takes. Vercel serverless functions cap out
well under what a full LLM response can take, so holding the connection
open for the whole completion is a real production risk, not just an
architecture preference.

The task pipes each token to a Trigger.dev Realtime stream
(`streams.pipe("delta", ...)`, via a small push-queue adapter in
`src/lib/agent/push-queue.ts` bridging the callback-style OpenRouter client
to an async iterable). The frontend subscribes to that stream directly via
`@trigger.dev/react-hooks` — the backend is never in the request path for
the actual streaming, only for dispatch. `POST .../messages` returns a
`{ runId, triggerRunId, publicAccessToken }` envelope (the token is scoped
read-only to that one run, minted per-request, never persisted); the
`GET .../active-run` endpoint mints a fresh one for reload recovery — if the
page refreshes mid-turn, the frontend asks "is there an in-flight run on
this chat?" and resumes watching it instead of silently losing it.

The actual model that served a request (from OpenRouter's response, not the
`openrouter/free` alias) is recorded on `AgentRun.model` — this is the
"Model Discovery" requirement in its current form; it becomes a first-class
tool invocation once the tool registry lands.

### Errors

Every route wraps its body in `withApiError()` (`src/lib/api-error.ts`),
which maps known error types to a consistent `{ error: { code, message } }`
envelope and logs a structured line (`src/lib/logger.ts`) tagged with
whatever correlation ids are on hand (chatId/runId/messageId/traceId).
Ownership failures return `404`, never `403` — an authenticated caller can't
distinguish someone else's chat from one that doesn't exist.

## Trade-offs / what's next

- **Shared types without a monorepo**: copying `src/contracts` into the
  frontend works but can drift. The real fix is either a small published
  package or a generated client — deferred for now to keep the two-repo
  setup simple while the core loop was still being proven.
- **`exactOptionalPropertyTypes`** was tried, then turned off — it fought
  Prisma's generated types constantly for little practical benefit. Kept
  `noUncheckedIndexedAccess` and `noImplicitOverride`.
- **Partial persistence mid-stream**: the assistant message row is still
  written once, at the end of the stream, not incrementally as tokens
  arrive — reload recovery works (the frontend resumes the Realtime
  subscription), but a hard crash mid-turn would lose the partial text from
  Postgres's perspective even though Trigger.dev's own stream buffer still
  has it.
- **No tool-calling loop yet**: still plain text completion. Tool registry,
  skills system, and the three required Magica tools aren't built yet.
- **Credits, waitpoints**: modeled in the schema, not wired into the request
  path yet.

## Prisma 7 / Next 16 / React 19.2

These are recent major releases with real breaking changes from earlier
versions (no `url` in the Prisma `datasource` block, driver adapters
mandatory, `middleware.ts` renamed to `proxy.ts`, among others). Where
behavior looked unfamiliar, it was checked directly against the bundled
docs (`node_modules/next/dist/docs`) and live `prisma generate`/`migrate`
runs rather than assumed.
