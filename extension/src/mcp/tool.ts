import type { z } from 'zod';
import type { Workspace } from './workspace';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  runId: string;
  signal?: AbortSignal;
  /** Late-bound services (changeset, contextEngine, ...) registered by the integrator. */
  services: Record<string, unknown>;
}

export interface TemperTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

/** Throw from a handler to return an actionable error result (isError) to the model. */
export class ToolError extends Error {}

/** Type-preserving helper for defining a tool; returns the erased TemperTool. */
export function defineTool<S extends z.ZodObject>(tool: TemperTool<S>): TemperTool {
  return tool as unknown as TemperTool;
}

export class ToolRegistry {
  private readonly map = new Map<string, TemperTool>();
  constructor(tools: TemperTool[] = []) {
    for (const t of tools) this.register(t);
  }
  register(tool: TemperTool): this {
    if (this.map.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    this.map.set(tool.name, tool);
    return this;
  }
  get(name: string): TemperTool | undefined {
    return this.map.get(name);
  }
  list(): TemperTool[] {
    return [...this.map.values()];
  }
}
