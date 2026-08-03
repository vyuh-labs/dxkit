/**
 * `vyuh-dxkit mcp` — the MCP (Model Context Protocol) server surface (v1).
 *
 * The SECOND consumer of the one transport-neutral repo tool registry
 * (`src/learn/agent-tools.ts` — Rule 2): any MCP-capable coding agent
 * (Claude Code, Cursor, VS Code) registers dxkit once and gets the same
 * read-only point-query tools the learn assistant calls. Registration is
 * one line in the agent's MCP config (docs/commands/mcp.md has the exact
 * command per agent, built from the canonical DXKIT_CLI).
 *
 * v1 scope, deliberate: stdio transport only (newline-delimited JSON-RPC
 * 2.0 — no port, no network listener), tools capability only. Hand-rolled
 * on purpose: the subset a tools-only server needs is small, and dxkit
 * keeps its dependency surface minimal.
 *
 * Trust posture (inherited from the registry, restated because this is a
 * trust boundary): every tool is READ-ONLY — no write path exists here, no
 * policy command executes, and nothing this server returns feeds a
 * verdict. Path arguments are guarded in the registry. Unlike the learn
 * relay (whose results go to a third-party provider), the MCP consumer is
 * a LOCAL agent that already has full filesystem + git access in this
 * repo, so contributor names ride by default; `--no-names` suppresses
 * them (the learn detail-tier rule, opt-in here).
 */
import * as readline from 'readline';
import { agentTools, type AgentTool } from './learn/agent-tools';

/** The protocol revision this server answers with when the client's
 *  requested revision is unparseable. The tools subset used here is
 *  stable across published revisions; negotiation echoes the client. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpHandlerOptions {
  /** Server version reported in serverInfo (the dxkit version). */
  version: string;
}

/**
 * Pure MCP message handler: one parsed JSON-RPC message in, one response
 * out (or null for notifications / malformed input). The stdio wrapper
 * below and the tests share this one implementation.
 */
export function createMcpHandler(
  tools: AgentTool[],
  opts: McpHandlerOptions,
): (msg: JsonRpcRequest) => JsonRpcResponse | null {
  return (msg) => {
    // Notifications (no id) never get a response; malformed ids neither.
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const method = msg.method ?? '';

    if (!isRequest) return null;

    if (method === 'initialize') {
      const requested = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion:
            typeof requested === 'string' && requested.length > 0
              ? requested
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vyuh-dxkit', version: opts.version },
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `unknown tool: ${name || '(none)'}` },
        };
      }
      const args =
        msg.params?.arguments && typeof msg.params.arguments === 'object'
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      // The registry contract: run never throws — absence and bad args
      // come back as explanatory text the agent can act on.
      const text = tool.run(args);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError: false },
      };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  };
}

export interface RunMcpOptions {
  cwd: string;
  version: string;
  /** Suppress contributor names in history/ownership tools. */
  noNames?: boolean;
  /** Injectable streams for tests. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * The stdio server: newline-delimited JSON-RPC over stdin/stdout. Runs
 * until stdin closes (the agent owns the process lifecycle). Malformed
 * lines are ignored — a transport hiccup must not kill the session.
 */
export function runMcpServer(opts: RunMcpOptions): Promise<void> {
  const tools = agentTools({ cwd: opts.cwd, detail: !opts.noNames });
  const handle = createMcpHandler(tools, { version: opts.version });
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = readline.createInterface({ input, terminal: false });
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        return;
      }
      const res = handle(msg);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    });
    rl.on('close', () => resolve());
  });
}
