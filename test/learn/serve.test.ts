/**
 * `learn --serve` contract (issue #245):
 *   - the driver registry is well-formed (three drivers, decision 2026-08-02);
 *   - the relay speaks each wire format correctly and never echoes the key;
 *   - grounding: summaries by default, finding detail ONLY behind the toggle,
 *     and the disclosure derives from the SAME assembly as the payload;
 *   - the server binds localhost only, degrades without a key to a clear
 *     remedy (never an exception), and the assistant page stays free of
 *     external loads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLearnBundle } from '../../src/learn/bundle';
import { renderLearnHtml } from '../../src/learn/render';
import { assembleGrounding } from '../../src/learn/grounding';
import {
  LLM_DRIVERS,
  MAX_TOOL_CALLS,
  relayAsk,
  getDriver,
  routeModel,
  listModels,
  resolveRouting,
} from '../../src/learn/drivers';
import { startLearnServer, buildStatusPayload } from '../../src/learn/serve';
import type { LearnRepoStatus } from '../../src/learn/repo-status';

const KEY_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DXKIT_LLM_API_KEY', 'DXKIT_LLM_BASE_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEY_ENVS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEY_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function repoStatus(): LearnRepoStatus {
  return {
    cwd: '/repo',
    installed: true,
    doctor: {
      schema: 'doctor.v1',
      generatedAt: 'x',
      cwd: '/repo',
      checks: [
        { label: 'git', ok: true, tier: 'reports' },
        {
          label: 'SECRET-SHAPED failing label',
          ok: false,
          tier: 'operational',
          fix: { hint: 'do the thing', command: 'vyuh-dxkit fix-it' },
        },
      ],
      recommendations: [
        {
          id: 'baseline',
          recommendation: { reason: 'no baseline', command: 'vyuh-dxkit baseline create' },
        },
      ],
      summary: {
        reports: { pass: 1, fail: 0, status: 'ok' },
        dx: { pass: 0, fail: 0, status: 'ok' },
        operational: { pass: 0, fail: 1, status: 'fail' },
        fixable: [],
      },
    },
    policy: { preset: 'security-only', checksCount: 1, lintEnabled: false, lanes: [] },
    baselines: [{ name: 'main', capturedAt: '2026-08-01T00:00:00Z', entryCount: 42 }],
    lastVerdict: {
      signature: 's',
      policyHash: 'p',
      blocks: true,
      warns: false,
      blockingCount: 2,
      unattributableCount: 0,
      warningCount: 0,
      markdown: '',
      ranAt: '2026-08-01T12:00:00Z',
      blockingFindings: [{ fingerprint: 'fp-123', kind: 'dep-vuln', status: 'added' }],
    },
    jobs: [
      {
        workflow: 'dxkit-dep-bump.yml',
        name: 'dxkit dep bump',
        triggers: ['cron 0 7 * * 1', 'workflow_dispatch'],
        nextRunUtc: '2026-08-10 07:00',
        dispatchable: true,
      },
    ],
    profile: {
      graph: {
        functionCount: 2253,
        fileCount: 310,
        callEdgeCount: 9800,
        hubs: [
          { label: 'secretHubFunction', sourceFile: 'src/deep/hub.ts', callsIn: 41, callsOut: 3 },
        ],
        refreshedAt: '2026-08-01T06:00:00.000Z',
        stale: false,
      },
      debt: {
        total: 42,
        byKind: { 'dep-vuln': 30, secret: 2, code: 10 },
        bySeverity: { high: 3, medium: 29, unrated: 10 },
        floorFailing: [{ pack: 'typescript', label: 'tsc --noEmit' }],
      },
      health: {
        overallScore: 50,
        rating: 'C',
        analyzedAt: '2026-08-01T00:00:00Z',
        topActions: [
          { dimension: 'testing', reason: 'no coverage data available', upliftIfFixed: 35 },
        ],
      },
    },
  };
}

describe('driver registry — decision-locked shape', () => {
  it('ships exactly openai (default) + anthropic + custom, all well-formed', () => {
    // Registry order IS the chooser order; first entry is the page default.
    // OpenAI first (user decision 2026-08-03): cheapest per query, and its
    // API auto-caches the repeated grounding prefix.
    expect(LLM_DRIVERS.map((d) => d.id)).toEqual(['openai', 'anthropic', 'custom']);
    for (const d of LLM_DRIVERS) {
      expect(d.keyEnv.length).toBeGreaterThan(0);
      expect(['anthropic', 'openai-chat']).toContain(d.wire);
      if (d.id === 'custom') {
        expect(d.endpoint).toBeNull();
        expect(d.suggestedModels).toEqual([]);
      } else {
        expect(d.endpoint).toMatch(/^https:\/\//);
        expect(d.suggestedModels.length).toBeGreaterThan(0);
        expect(d.defaultModel.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('relay — wire formats, key hygiene', () => {
  it('anthropic wire: /v1/messages, key + version headers, system + messages, text joined', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await relayAsk(
      {
        driver: getDriver('anthropic')!,
        model: 'claude-opus-5',
        apiKey: 'your-unit-key-123',
        system: 'SYSTEM-PROMPT',
        messages: [{ role: 'user', content: 'q' }],
      },
      fetchFn,
    );
    expect(result).toEqual({ ok: true, answer: 'hello\nworld' });
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('your-unit-key-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(seen!.init.body));
    // The grounding is a stable prefix reused across a session, so the wire
    // marks it cacheable (G14) — repeat queries pay ~10% for cached input.
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM-PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('anthropic wire: a refusal is a disclosed error, not an empty answer', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), {
        status: 200,
      })) as typeof fetch;
    const result = await relayAsk(
      {
        driver: getDriver('anthropic')!,
        model: 'm',
        apiKey: 'k',
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
      },
      fetchFn,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusal');
  });

  it('openai wire: bearer auth, chat/completions, system message first', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await relayAsk(
      {
        driver: getDriver('openai')!,
        model: 'gpt-5.1',
        apiKey: 'your-unit-key-oai',
        system: 'SYS',
        messages: [{ role: 'user', content: 'q' }],
      },
      fetchFn,
    );
    expect(result).toEqual({ ok: true, answer: 'answer' });
    expect(seen!.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer your-unit-key-oai');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  it('no-tools requests carry no tools key on either wire (byte-compat pin)', async () => {
    for (const driverId of ['anthropic', 'openai'] as const) {
      let body: Record<string, unknown> = {};
      const fetchFn = (async (_u: unknown, init: unknown) => {
        body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'a' }],
            choices: [{ message: { content: 'a' } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      const result = await relayAsk(
        {
          driver: getDriver(driverId)!,
          model: 'm',
          apiKey: 'k',
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
        },
        fetchFn,
      );
      expect(result.ok).toBe(true);
      expect('tools' in body).toBe(false);
      expect('toolCalls' in result).toBe(false);
    }
  });

  it('anthropic tool loop: executes the requested tool, relays the result, ledgers the call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'let me check' },
              { type: 'tool_use', id: 'tu1', name: 'echo_tool', input: { x: 'main' } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const ran: unknown[] = [];
    const result = await relayAsk(
      {
        driver: getDriver('anthropic')!,
        model: 'm',
        apiKey: 'k',
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [
          {
            name: 'echo_tool',
            description: 'd',
            inputSchema: { type: 'object', properties: {} },
            run: (args) => {
              ran.push(args);
              return 'TOOL-OUTPUT';
            },
          },
        ],
      },
      fetchFn,
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('done');
    expect(ran).toEqual([{ x: 'main' }]);
    expect(result.toolCalls).toEqual([
      { tool: 'echo_tool', args: '{"x":"main"}', resultChars: 'TOOL-OUTPUT'.length },
    ]);
    // First request offered the tool; second carried the executed result.
    expect((bodies[0].tools as unknown[]).length).toBe(1);
    const second = bodies[1].messages as Array<{ role: string; content: unknown }>;
    const toolResult = second[second.length - 1];
    expect(toolResult.role).toBe('user');
    expect(JSON.stringify(toolResult.content)).toContain('TOOL-OUTPUT');
    expect(JSON.stringify(toolResult.content)).toContain('tu1');
  });

  it('openai tool loop: tool_calls round-trips via role:tool messages', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [{ id: 'c1', function: { name: 'echo_tool', arguments: '{"x":1}' } }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await relayAsk(
      {
        driver: getDriver('openai')!,
        model: 'm',
        apiKey: 'k',
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [
          {
            name: 'echo_tool',
            description: 'd',
            inputSchema: { type: 'object', properties: {} },
            run: () => 'TOOL-OUTPUT',
          },
        ],
      },
      fetchFn,
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('done');
    expect(result.toolCalls).toHaveLength(1);
    expect((bodies[0].tools as Array<{ type: string }>)[0].type).toBe('function');
    const second = bodies[1].messages as Array<{ role: string; tool_call_id?: string }>;
    const toolMsg = second[second.length - 1];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('c1');
  });

  it('a model that never stops calling tools is bounded: budget disclosed, loop converges', async () => {
    let calls = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        tool_choice?: unknown;
      };
      calls++;
      // Once the relay forces tool_choice none, answer with text.
      if (body.tool_choice) {
        return new Response(
          JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'forced' }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `t${calls}`, name: 'echo_tool', input: {} }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await relayAsk(
      {
        driver: getDriver('anthropic')!,
        model: 'm',
        apiKey: 'k',
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [
          {
            name: 'echo_tool',
            description: 'd',
            inputSchema: { type: 'object', properties: {} },
            run: () => 'x',
          },
        ],
      },
      fetchFn,
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('forced');
    expect(result.toolCalls!.length).toBeLessThanOrEqual(MAX_TOOL_CALLS);
    expect(calls).toBeLessThanOrEqual(MAX_TOOL_CALLS + 2);
  });

  it('custom driver without a base URL is a disclosed error', async () => {
    const result = await relayAsk(
      {
        driver: getDriver('custom')!,
        model: 'local-model',
        apiKey: 'k',
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
      },
      (async () => new Response('{}')) as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('base URL');
  });
});

describe('grounding — summaries by default, detail behind the toggle, disclosure = payload', () => {
  const bundle = buildLearnBundle();

  it('zero-context grounding has product facts only and says so', () => {
    const g = assembleGrounding(bundle, null);
    expect(g.repoMode).toBe(false);
    expect(g.system).toContain('guardrail');
    expect(g.system).toContain('How dxkit thinks');
    expect(g.disclosure.join(' ')).toContain('No repo data');
  });

  it('repo default: labels but no remedies, no fingerprints; disclosure says summaries', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: false });
    expect(g.detail).toBe(false);
    expect(g.system).toContain('1 failing');
    // G11: failing-check LABELS ride the summary tier so "what is missing
    // here?" is answerable without the toggle...
    expect(g.system).toContain('SECRET-SHAPED failing label');
    // ...but remedies (can embed repo paths) and fingerprints stay behind it.
    expect(g.system).not.toContain('vyuh-dxkit fix-it');
    expect(g.system).not.toContain('fp-123');
    expect(g.disclosure.join(' ')).toContain('SUMMARIES');
    expect(g.disclosure.join(' ')).toContain('LABELS');
  });

  it('installed workflows (jobs) ground the assistant: names, triggers, schedule — even without detail', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: false });
    expect(g.system).toContain('dxkit dep bump');
    expect(g.system).toContain('cron 0 7 * * 1');
    expect(g.system).toContain('2026-08-10 07:00');
    expect(g.disclosure.join(' ')).toContain('workflow list');
  });

  it('detail toggle: labels + remedies + fingerprints appear, and the disclosure says so', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: true });
    expect(g.detail).toBe(true);
    expect(g.system).toContain('SECRET-SHAPED failing label');
    expect(g.system).toContain('vyuh-dxkit fix-it');
    expect(g.system).toContain('fp-123');
    expect(g.disclosure.join(' ')).toContain('IN DETAIL');
  });

  it('repo profile: counts + freshness ride the summary tier; hub symbol names stay behind detail', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: false });
    // Graph shape, debt shape, health headline: counts + product-phrased
    // strings, each with its freshness stamp.
    expect(g.system).toContain('2253 functions');
    expect(g.system).toContain('refreshed 2026-08-01');
    expect(g.system).toContain('dep-vuln=30');
    expect(g.system).toContain('high=3');
    expect(g.system).toContain('overall 50/100 (C)');
    expect(g.system).toContain('no coverage data available');
    expect(g.system).toContain('tsc --noEmit');
    // Hub SYMBOL NAMES + their file paths are repo content: detail only.
    expect(g.system).not.toContain('secretHubFunction');
    expect(g.system).not.toContain('src/deep/hub.ts');
    expect(g.disclosure.join(' ')).toContain('COUNTS');
    const gd = assembleGrounding(bundle, repoStatus(), { detail: true });
    expect(gd.system).toContain('secretHubFunction');
    expect(gd.system).toContain('src/deep/hub.ts');
  });

  it('absent profile artifacts carry the exact enable command; a stale graph names the refresh', () => {
    const absent = repoStatus();
    absent.profile = { graph: null, debt: null, health: null };
    const g = assembleGrounding(bundle, absent, { detail: false });
    expect(g.system).toContain('code graph: not set up');
    expect(g.system).toContain('vyuh-dxkit describe');
    expect(g.system).toContain("run 'vyuh-dxkit health'");
    expect(g.system).toContain('no committed baseline to read');

    const staleSt = repoStatus();
    staleSt.profile = {
      ...staleSt.profile,
      graph: { ...staleSt.profile.graph!, stale: true },
    };
    const gs = assembleGrounding(bundle, staleSt, { detail: false });
    expect(gs.system).toContain('STALE');
  });

  it('repo mode discloses the point-query tool registry; zero-context does not', () => {
    const repo = buildStatusPayload(bundle, repoStatus(), false) as { disclosure: string[] };
    expect(repo.disclosure.join(' ')).toContain('function_callers');
    expect(repo.disclosure.join(' ')).toContain('read-only');
    const zero = buildStatusPayload(bundle, null, false) as { disclosure: string[] };
    expect(zero.disclosure.join(' ')).not.toContain('function_callers');
  });
});

describe('serve — localhost only, key hygiene, graceful no-key degrade', () => {
  const bundle = buildLearnBundle();

  it('binds 127.0.0.1, serves the assistant page with zero external loads', async () => {
    const s = await startLearnServer(bundle, null, {});
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const addr = s.server.address();
      expect(typeof addr === 'object' && addr ? addr.address : '').toBe('127.0.0.1');
      const html = await (await fetch(s.url)).text();
      expect(html).toContain('dxkit assistant');
      expect(html).toContain('assistant-panel');
      expect(html).toContain('<script>');
      expect(html).not.toMatch(/src=["']https?:/);
      expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
      expect(html).not.toMatch(/<(img|iframe)\b/);
    } finally {
      await s.close();
    }
  });

  it('/api/status exposes driver metadata + disclosure but never key material', async () => {
    process.env.ANTHROPIC_API_KEY = 'your-env-unit-key';
    const s = await startLearnServer(bundle, null, {});
    try {
      const raw = await (await fetch(`${s.url}api/status`)).text();
      expect(raw).not.toContain('your-env-unit-key');
      const status = JSON.parse(raw);
      const anthropic = status.drivers.find((d: { id: string }) => d.id === 'anthropic');
      expect(anthropic.envKeyPresent).toBe(true);
      expect(status.disclosure.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('no key anywhere: /api/ask degrades to a 400 naming the env var, never a crash', async () => {
    const s = await startLearnServer(bundle, null, {});
    try {
      const res = await fetch(`${s.url}api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ driverId: 'anthropic', question: 'hi' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('ANTHROPIC_API_KEY');
    } finally {
      await s.close();
    }
  });

  it('browser key is relayed to the provider and never echoed in the response', async () => {
    let seenKey = '';
    const fetchFn = (async (_url: unknown, init: unknown) => {
      seenKey = (init as { headers: Record<string, string> }).headers['x-api-key'];
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const s = await startLearnServer(bundle, null, { fetchFn });
    try {
      const res = await fetch(`${s.url}api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          driverId: 'anthropic',
          question: 'hi',
          browserKey: 'your-browser-unit-key',
        }),
      });
      expect(res.status).toBe(200);
      const raw = JSON.stringify(await res.json());
      expect(seenKey).toBe('your-browser-unit-key');
      expect(raw).not.toContain('your-browser-unit-key');
      expect(raw).toContain('"keySource":"browser"');
    } finally {
      await s.close();
    }
  });

  it('unknown driver and invalid JSON are 400s', async () => {
    const s = await startLearnServer(bundle, null, {});
    try {
      const r1 = await fetch(`${s.url}api/ask`, {
        method: 'POST',
        body: JSON.stringify({ driverId: 'nope', question: 'x' }),
      });
      expect(r1.status).toBe(400);
      const r2 = await fetch(`${s.url}api/ask`, { method: 'POST', body: '{not json' });
      expect(r2.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('status payload detail flag round-trips through the one grounding assembly', () => {
    const off = buildStatusPayload(bundle, repoStatus(), false) as { disclosure: string[] };
    const on = buildStatusPayload(bundle, repoStatus(), true) as { disclosure: string[] };
    expect(off.disclosure.join(' ')).toContain('SUMMARIES');
    expect(on.disclosure.join(' ')).toContain('IN DETAIL');
  });
});

describe('render — static mode never fetches, serve mode stays self-contained', () => {
  const bundle = buildLearnBundle();

  it('static file mode has no assistant and its JS makes no network requests', () => {
    const html = renderLearnHtml(bundle, null, {});
    expect(html).not.toContain('id="apanel"');
    expect(html).not.toMatch(/fetch\(/);
    expect(html).toContain('palette-input');
  });

  it('serve mode adds the panel + script but still no external loads', () => {
    const html = renderLearnHtml(bundle, null, { serve: true });
    expect(html).toContain('dxkit assistant');
    expect(html).toContain('bring-your-own-key');
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/@import/);
    // The serve page's JS talks ONLY to same-origin /api/* paths.
    const fetches = [...html.matchAll(/fetch\((['"])([^'"]+)\1/g)].map((m) => m[2]);
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) expect(f.startsWith('/api/')).toBe(true);
    // Fetches with computed URLs stay same-origin too (string-concat on /api/).
    expect(html).not.toMatch(/fetch\((['"])https?:/);
  });

  it('starter chips: shared prompts always, repo-only prompts only with a repo', () => {
    const zero = renderLearnHtml(bundle, null, { serve: true });
    expect(zero).toContain('id="chips"');
    expect(zero).toContain('bot token');
    expect(zero).toContain('Which branches does dxkit create');
    expect(zero).not.toContain('What is set up in this repo');
    const repo = renderLearnHtml(bundle, repoStatus(), { serve: true });
    expect(repo).toContain('What is set up in this repo');
    // The repo page also renders the installed-workflow inventory.
    expect(repo).toContain('Installed workflows');
    expect(repo).toContain('dxkit-dep-bump.yml');
  });
});

describe('live model lists — the provider is the source of truth, suggestions are labeled fallback', () => {
  const bundle = buildLearnBundle();

  it('listModels speaks both wire formats', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen.push(String(url));
      const headers = (init as { headers: Record<string, string> }).headers;
      if (String(url).includes('api.anthropic.com')) {
        expect(headers['x-api-key']).toBe('your-key');
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-future-9', created_at: '2027-01-01T00:00:00Z' }] }),
          { status: 200 },
        );
      }
      expect(headers.authorization).toBe('Bearer your-key');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-9.9', created: 1800000000 }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const a = await listModels({ driver: getDriver('anthropic')!, apiKey: 'your-key' }, fetchFn);
    expect(a.ok).toBe(true);
    expect(a.models![0].id).toBe('claude-future-9');
    const o = await listModels({ driver: getDriver('openai')!, apiKey: 'your-key' }, fetchFn);
    expect(o.ok).toBe(true);
    expect(o.models![0].id).toBe('gpt-9.9');
    expect(seen[0]).toContain('/v1/models');
    expect(seen[1]).toBe('https://api.openai.com/v1/models');
  });

  it('resolveRouting picks the NEWEST flagship/small tier from a live list (never stale)', () => {
    const openai = getDriver('openai')!;
    const live = resolveRouting(openai, [
      { id: 'gpt-5.1', created: 100 },
      { id: 'gpt-5.6', created: 500 },
      { id: 'gpt-5.6-mini', created: 500 },
      { id: 'gpt-5.6-audio-preview', created: 600 },
      { id: 'gpt-5-mini', created: 50 },
    ]);
    expect(live).toEqual({ fast: 'gpt-5.6-mini', deep: 'gpt-5.6' });
    // Empty/absent list → compiled-in fallback tiers.
    expect(resolveRouting(openai, undefined)).toEqual(openai.routing);
    // Pattern miss on a weird list → fallback per tier.
    expect(resolveRouting(openai, [{ id: 'whisper-1' }])).toEqual(openai.routing);
  });

  it('/api/models: no key → labeled fallback suggestions; with key → live list + resolved routing', async () => {
    const fetchFn = (async (url: unknown) =>
      String(url).endsWith('/models')
        ? new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-5.6', created: 500 },
                { id: 'gpt-5.6-mini', created: 500 },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
          })) as typeof fetch;
    const s = await startLearnServer(bundle, null, { fetchFn });
    try {
      const noKey = (await (
        await fetch(`${s.url}api/models`, {
          method: 'POST',
          body: JSON.stringify({ driverId: 'openai' }),
        })
      ).json()) as { live: boolean; models: string[]; note: string };
      expect(noKey.live).toBe(false);
      expect(noKey.note).toContain('may be outdated');
      const live = (await (
        await fetch(`${s.url}api/models`, {
          method: 'POST',
          body: JSON.stringify({ driverId: 'openai', browserKey: 'your-key' }),
        })
      ).json()) as { live: boolean; models: string[]; routing: { fast: string; deep: string } };
      expect(live.live).toBe(true);
      expect(live.models).toContain('gpt-5.6');
      expect(live.routing).toEqual({ fast: 'gpt-5.6-mini', deep: 'gpt-5.6' });
      // Auto asks now route on the LIVE tiers (cache shared with /api/ask).
      const ask = (await (
        await fetch(`${s.url}api/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            driverId: 'openai',
            model: 'auto',
            question: 'what is a baseline?',
            browserKey: 'your-key',
          }),
        })
      ).json()) as { servedModel: string };
      expect(ask.servedModel).toBe('gpt-5.6-mini');
    } finally {
      await s.close();
    }
  });
});

describe('auto model routing — deterministic, disclosed', () => {
  const bundle = buildLearnBundle();
  const anthropic = getDriver('anthropic')!;

  it('routes quick lookups to the fast tier and reasoning to the deep tier', () => {
    expect(routeModel(anthropic, 'what is a baseline?')).toMatchObject({
      model: 'claude-haiku-4-5',
      tier: 'fast',
    });
    expect(routeModel(anthropic, 'why is my PR blocked and how do I fix it?')).toMatchObject({
      model: 'claude-opus-5',
      tier: 'deep',
      reason: 'reasoning-shaped question',
    });
    // Fast-by-default tune (2026-08-03): a plain how-to is a LOOKUP the
    // grounding answers directly — retrieval, not reasoning.
    expect(routeModel(anthropic, 'How do I set up the bot token for this repo?').tier).toBe('fast');
    expect(routeModel(anthropic, 'list gates', { detail: true }).tier).toBe('deep');
    expect(routeModel(anthropic, 'and then?', { historyLength: 8 }).tier).toBe('deep');
    expect(routeModel(getDriver('custom')!, 'anything').reason).toContain('single-model');
  });

  it('serve: model "auto" routes and the response discloses the decision', async () => {
    let seenModel = '';
    const fetchFn = (async (_url: unknown, init: unknown) => {
      seenModel = JSON.parse(String((init as RequestInit).body)).model;
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok `x`' }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const s = await startLearnServer(bundle, null, { fetchFn });
    try {
      const res = await fetch(`${s.url}api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          driverId: 'anthropic',
          model: 'auto',
          question: 'what is a baseline?',
          browserKey: 'your-key',
        }),
      });
      const body = (await res.json()) as {
        routed: boolean;
        servedModel: string;
        routeTier: string;
        routeReason: string;
        answerHtml: string;
      };
      expect(seenModel).toBe('claude-haiku-4-5');
      expect(body.routed).toBe(true);
      expect(body.servedModel).toBe('claude-haiku-4-5');
      expect(body.routeTier).toBe('fast');
      expect(body.routeReason.length).toBeGreaterThan(0);
      // Answers come back rendered by the ONE pinned markdown renderer.
      expect(body.answerHtml).toContain('<code>x</code>');
    } finally {
      await s.close();
    }
  });

  it('an explicit model always wins over routing', async () => {
    let seenModel = '';
    const fetchFn = (async (_url: unknown, init: unknown) => {
      seenModel = JSON.parse(String((init as RequestInit).body)).model;
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const s = await startLearnServer(bundle, null, { fetchFn });
    try {
      const res = await fetch(`${s.url}api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          driverId: 'anthropic',
          model: 'claude-sonnet-5',
          question: 'why why why?',
          browserKey: 'your-key',
        }),
      });
      const body = (await res.json()) as { routed: boolean; servedModel: string };
      expect(seenModel).toBe('claude-sonnet-5');
      expect(body.routed).toBe(false);
      expect(body.servedModel).toBe('claude-sonnet-5');
    } finally {
      await s.close();
    }
  });
});
