import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles, syncEnvVars } from "@trigger.dev/build/extensions/core";

// Deploying task code to Trigger.dev does not carry Vercel's env vars with
// it — their cloud runtime is a separate place that needs its own copies.
// This reads them from whatever .env `trigger.dev deploy` already loads
// (the project's .env by default) and pushes them alongside each deploy,
// so they can never silently drift out of sync with what's actually in
// this file. Only lists what code reachable from a task actually uses
// (verified by grepping src/lib/agent, openrouter.ts, tools, skills,
// magica, db.ts) — Transloadit isn't here because uploads happen
// synchronously in API routes, never inside a task.
const REQUIRED_ENV_VARS = [
  { name: "DATABASE_URL", isSecret: true },
  { name: "OPENROUTER_API_KEY", isSecret: true },
  { name: "MAGICA_API_KEY", isSecret: true },
  { name: "MAGICA_BASE_URL", isSecret: false },
] as const;

export default defineConfig({
  project: "proj_jsblequlingyzgnshzvz",
  runtime: "node-24",
  logLevel: "log",
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
  build: {
    // agent-skills/*.md is read via fs at runtime (see src/lib/skills/registry.ts),
    // not imported — Trigger.dev's build only bundles the static import graph
    // by default, so without this the skill files simply wouldn't exist in
    // the deployed task's filesystem.
    extensions: [
      additionalFiles({ files: ["agent-skills/**/*"] }),
      syncEnvVars(async () => {
        const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v.name]);
        if (missing.length > 0) {
          throw new Error(
            `Missing required env var(s) for deploy: ${missing.map((v) => v.name).join(", ")} — ` +
              `set them in .env before running trigger.dev deploy.`,
          );
        }
        return REQUIRED_ENV_VARS.map((v) => ({ name: v.name, value: process.env[v.name]!, isSecret: v.isSecret }));
      }),
    ],
  },
});
