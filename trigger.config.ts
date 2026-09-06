import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

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
    extensions: [additionalFiles({ files: ["agent-skills/**/*"] })],
  },
});
