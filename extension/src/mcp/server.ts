import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolError } from './tool';
import type { TemperTool, ToolContext } from './tool';
import type { Workspace } from './workspace';

export const MAX_RESULT_CHARS = 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface McpServerOptions {
  tools: TemperTool[];
  workspace: Workspace;
  /** Static run id or a getter evaluated per call (the active run changes over the server's life). */
  runId?: string | (() => string);
  services?: Record<string, unknown>;
  /** 0 = pick a random free port. */
  port?: number;
  host?: string;
  /** Observability hook, called after every tool call (never throws into the server). */
  onToolCall?: (name: string, args: unknown, result: ToolCallResult, durationMs: number) => void;
}

export interface RunningMcpServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

function errorText(e: unknown): string {
  if (e instanceof ToolError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return `Tool failed: ${msg}. Check the arguments and try again; if it keeps failing, use a different tool.`;
}

function buildServer(opts: McpServerOptions, signalOf: () => AbortSignal): McpServer {
  const server = new McpServer({ name: 'temper', version: '0.1.0' });
  for (const tool of opts.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown, extra: { signal?: AbortSignal }) => {
        const started = Date.now();
        let result: ToolCallResult;
        try {
          const ctx: ToolContext = {
            workspace: opts.workspace,
            runId: typeof opts.runId === 'function' ? opts.runId() : (opts.runId ?? ''),
            signal: extra.signal ?? signalOf(),
            services: opts.services ?? {},
          };
          let text = await tool.handler(args as never, ctx);
          if (text.length > MAX_RESULT_CHARS) {
            text = text.slice(0, MAX_RESULT_CHARS) + `\n... [truncated at ${MAX_RESULT_CHARS} chars; request a narrower range or query]`;
          }
          result = { text, isError: false };
        } catch (e) {
          result = { text: errorText(e), isError: true };
        }
        try {
          opts.onToolCall?.(tool.name, args, result, Date.now() - started);
        } catch {
          /* a broken logger must not break the tool call */
        }
        return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
      },
    );
  }
  return server;
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const host = opts.host ?? '127.0.0.1';
  const names = new Set<string>();
  for (const t of opts.tools) {
    if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    names.add(t.name);
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname !== '/mcp') return void res.writeHead(404).end();
        // Defence against DNS rebinding: only loopback Host headers are served.
        const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader)) return jsonRpcError(res, 403, -32000, 'Forbidden host');
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return jsonRpcError(res, 405, -32000, 'Method not allowed (stateless server: POST only)');
        }
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch {
          return jsonRpcError(res, 400, -32700, 'Parse error: body must be JSON-RPC');
        }
        const abort = new AbortController();
        const server = buildServer(opts, () => abort.signal);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          abort.abort();
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, json);
      } catch (e) {
        jsonRpcError(res, 500, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}
