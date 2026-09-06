import { z } from "zod";
import type { ToolDefinition } from "@/contracts/tools";

export interface OpenRouterToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/**
 * The one tool registry — every tool the agent can call, typed contract and
 * all, lives here. Nothing about the agent loop or the frontend defines its
 * own version of a tool's shape; they consume this.
 */
class ToolRegistry {
  // `any` here is deliberate, not a shortcut: a heterogeneous collection of
  // differently-typed tools can't be variance-safe at the collection's own
  // type — each tool is fully typed at its `defineTool()` definition site,
  // which is what matters for catching a mismatched schema/execute pair.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** OpenRouter/OpenAI-compatible `tools` array for the chat completion request. */
  toOpenRouterTools(): OpenRouterToolSpec[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.inputSchema),
      },
    }));
  }
}

export const toolRegistry = new ToolRegistry();
