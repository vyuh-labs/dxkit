/**
 * The MCP server contract (v1: stdio, tools-only):
 *   - JSON-RPC handshake: initialize echoes the client's protocol version,
 *     advertises the tools capability, names the server;
 *   - tools/list is REGISTRY PARITY — the one agent-tool registry, never a
 *     hand-kept list (Rule 2: the learn relay and MCP share it);
 *   - tools/call routes through the registry contract (never throws;
 *     absent graph answers with the enable command);
 *   - notifications get no response; unknown methods/tools get JSON-RPC
 *     errors; malformed stdio lines are ignored, never fatal.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import { createMcpHandler, runMcpServer } from '../src/mcp-cli';
import { agentTools } from '../src/learn/agent-tools';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-mcp-'));
}

describe('MCP handler — handshake + registry parity', () => {
  const cwd = tmpRepo();
  const tools = agentTools({ cwd, detail: true }, () => '');
  const handle = createMcpHandler(tools, { version: '4.3.6' });

  it('initialize echoes the client protocol version and advertises tools', () => {
    const res = handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x' } },
    })!;
    expect(res.id).toBe(1);
    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: object };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo).toEqual({ name: 'vyuh-dxkit', version: '4.3.6' });
  });

  it('initialize without a client version falls back to a published revision', () => {
    const res = handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })!;
    const result = res.result as { protocolVersion: string };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('tools/list is the agent-tool registry, verbatim (one registry, two transports)', () => {
    const res = handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })!;
    const listed = (res.result as { tools: Array<{ name: string; inputSchema: object }> }).tools;
    expect(listed.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    for (const t of listed) expect(t.inputSchema).toBeDefined();
  });

  it('tools/call routes through the registry contract (absent graph → enable command)', () => {
    const res = handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'function_callers', arguments: { symbol: 'main' } },
    })!;
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('vyuh-dxkit describe');
  });

  it('unknown tool and unknown method are JSON-RPC errors; ping and notifications behave', () => {
    const badTool = handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nope' },
    })!;
    expect(badTool.error?.code).toBe(-32602);
    const badMethod = handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' })!;
    expect(badMethod.error?.code).toBe(-32601);
    expect(handle({ jsonrpc: '2.0', id: 7, method: 'ping' })!.result).toEqual({});
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});

describe('MCP stdio wrapper', () => {
  it('answers a full newline-delimited session and survives malformed lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const done = runMcpServer({ cwd: tmpRepo(), version: '4.3.6', input, output });
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }) + '\n',
    );
    input.write('this is not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await done;
    const lines = Buffer.concat(chunks)
      .toString('utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: number; result?: unknown });
    // Two responses: the two requests. The notification and the malformed
    // line produced nothing and killed nothing.
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    const listed = lines[1].result as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toContain('file_blast_radius');
  });
});
