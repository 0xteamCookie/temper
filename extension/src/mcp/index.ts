// Local MCP server (streamable HTTP, 127.0.0.1) exposing editor capabilities to the agent as tools.
// Read-only workspace tools live here; propose_edit / submit_changeset / run_command / get_context
// are registered by other modules through the same TemperTool interface.
import { listDirTool } from './tools/listDir';
import { findSymbolTool } from './tools/findSymbol';
import { readFileTool } from './tools/readFile';
import { searchCodeTool } from './tools/searchCode';
import type { TemperTool } from './tool';

export { startMcpServer, MAX_RESULT_CHARS } from './server';
export type { McpServerOptions, RunningMcpServer, ToolCallResult } from './server';
export { defineTool, ToolError, ToolRegistry } from './tool';
export type { TemperTool, ToolContext, ToolAnnotations } from './tool';
export { NodeWorkspace, isExcludedName } from './workspace';
export type { Workspace, DirEntry, WalkOptions } from './workspace';
export { readFileTool, listDirTool, searchCodeTool, findSymbolTool };
export { extractSymbols } from './tools/findSymbol';

export const readOnlyTools: TemperTool[] = [readFileTool, listDirTool, searchCodeTool, findSymbolTool];
