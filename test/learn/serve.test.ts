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
import { LLM_DRIVERS, relayAsk, getDriver, routeModel } from '../../src/learn/drivers';
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
  };
}

describe('driver registry — decision-locked shape', () => {
  it('ships exactly anthropic (default) + openai + custom, all well-formed', () => {
    expect(LLM_DRIVERS.map((d) => d.id)).toEqual(['anthropic', 'openai', 'custom']);
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
    expect(body.system).toBe('SYSTEM-PROMPT');
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

  it('repo default: counts only — no failing labels, no fingerprints; disclosure says summaries', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: false });
    expect(g.detail).toBe(false);
    expect(g.system).toContain('1 failing');
    expect(g.system).not.toContain('SECRET-SHAPED failing label');
    expect(g.system).not.toContain('fp-123');
    expect(g.disclosure.join(' ')).toContain('SUMMARIES ONLY');
  });

  it('detail toggle: labels + remedies + fingerprints appear, and the disclosure says so', () => {
    const g = assembleGrounding(bundle, repoStatus(), { detail: true });
    expect(g.detail).toBe(true);
    expect(g.system).toContain('SECRET-SHAPED failing label');
    expect(g.system).toContain('vyuh-dxkit fix-it');
    expect(g.system).toContain('fp-123');
    expect(g.disclosure.join(' ')).toContain('IN DETAIL');
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
    expect(off.disclosure.join(' ')).toContain('SUMMARIES ONLY');
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
