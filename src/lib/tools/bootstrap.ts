import { registerSkillTools } from "./skill-tools";
import { registerMagicaTools } from "./magica-tools";

// toolRegistry.register() throws on a duplicate name, and runTurn() is
// invoked once per turn in the same long-lived process (a Trigger.dev task
// worker) — so registration needs to happen exactly once per process, not
// once per call.
let registered = false;

export function ensureToolsRegistered(): void {
  if (registered) return;
  registerSkillTools();
  registerMagicaTools();
  registered = true;
}
