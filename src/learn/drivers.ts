/**
 * The LLM driver registry for the learn assistant (issue #245) — the ONE
 * place provider facts live. Three drivers by design decision (2026-08-02;
 * default order revised 2026-08-03): OpenAI (default — cheapest per query,
 * and its API auto-caches the repeated grounding prefix), Anthropic on
 * selection, and an OpenAI-compatible custom endpoint that covers org
 * proxies, Azure-style gateways, and local models without naming products.
 * Registry ORDER is the page's chooser order; the first entry is the
 * default. Each driver declares its key env var, endpoint, wire format, and
 * a couple of SUGGESTED models plus a free-text override on the page — never
 * an exhaustive model list (those go stale between releases).
 *
 * The page's model chooser renders FROM this registry (via /api/status), so
 * adding a driver is one entry here and zero page edits.
 */

export interface LlmDriver {
  readonly id: 'anthropic' | 'openai' | 'custom';
  readonly label: string;
  /** Env var the serve process auto-detects a key from. */
  readonly keyEnv: string;
  /** Fixed API base; null for the custom driver (user supplies it). */
  readonly endpoint: string | null;
  /** Which request/response shape the relay speaks. */
  readonly wire: 'anthropic' | 'openai-chat';
  /** Suggestions only — the page always offers a free-text model field. */
  readonly suggestedModels: readonly string[];
  readonly defaultModel: string;
  /**
   * Auto-routing tiers (the "Auto" model choice): quick lookups go to `fast`,
   * reasoning-shaped questions to `deep`. Routing never crosses providers
   * (keys differ); a driver without tiers always serves its default model.
   */
  readonly routing?: { readonly fast: string; readonly deep: string };
}

export const LLM_DRIVERS: readonly LlmDriver[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    endpoint: 'https://api.openai.com/v1',
    wire: 'openai-chat',
    suggestedModels: ['gpt-5.1', 'gpt-5-mini', 'gpt-5-nano'],
    defaultModel: 'gpt-5.1',
    routing: { fast: 'gpt-5-mini', deep: 'gpt-5.1' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyEnv: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com',
    wire: 'anthropic',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    defaultModel: 'claude-opus-5',
    routing: { fast: 'claude-haiku-4-5', deep: 'claude-opus-5' },
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible endpoint (org proxy, local model)',
    keyEnv: 'DXKIT_LLM_API_KEY',
    endpoint: null,
    wire: 'openai-chat',
    suggestedModels: [],
    defaultModel: '',
  },
] as const;

export interface ProviderModel {
  id: string;
  /** Epoch seconds when the provider created the model, when reported. */
  created?: number;
}

export interface ListModelsResult {
  ok: boolean;
  models?: ProviderModel[];
  error?: string;
}

/**
 * Fetch the LIVE model list from the provider with the user's own key — the
 * fix for hardcoded suggestion lists going stale (they are training-data
 * snapshots; the provider is the source of truth). Fail-open: any error
 * returns { ok: false } and the caller falls back to the driver's
 * suggestions, LABELED as possibly outdated.
 */
export async function listModels(
  req: { driver: LlmDriver; apiKey: string; baseUrl?: string; timeoutMs?: number },
  fetchFn: typeof fetch = fetch,
): Promise<ListModelsResult> {
  const timeout = req.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (req.driver.wire === 'anthropic') {
      const res = await fetchFn(`${req.driver.endpoint}/v1/models?limit=100`, {
        signal: controller.signal,
        headers: { 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return { ok: false, error: `provider returned HTTP ${res.status}` };
      const data = (await res.json()) as {
        data?: Array<{ id?: string; created_at?: string }>;
      };
      const models = (data.data ?? [])
        .filter((m) => typeof m.id === 'string')
        .map((m) => ({
          id: m.id as string,
          created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) : undefined,
        }));
      return models.length > 0 ? { ok: true, models } : { ok: false, error: 'empty model list' };
    }
    const base = req.driver.endpoint ?? req.baseUrl;
    if (!base) return { ok: false, error: 'custom driver requires a base URL' };
    const res = await fetchFn(`${base.replace(/\/$/, '')}/models`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${req.apiKey}` },
    });
    if (!res.ok) return { ok: false, error: `provider returned HTTP ${res.status}` };
    const data = (await res.json()) as { data?: Array<{ id?: string; created?: number }> };
    const models = (data.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ id: m.id as string, created: m.created }));
    return models.length > 0 ? { ok: true, models } : { ok: false, error: 'empty model list' };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted ? 'model list timed out' : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Auto tiers against a LIVE model list: deep = the newest
 * flagship-shaped id, fast = the newest small-tier id — falling back to the
 * driver's compiled-in tiers when the pattern finds nothing. Deterministic
 * given the same list (sorted by created desc, then id desc).
 */
export function resolveRouting(
  driver: LlmDriver,
  models: readonly ProviderModel[] | undefined,
): { fast: string; deep: string } | undefined {
  if (!driver.routing) return undefined;
  if (!models || models.length === 0) return driver.routing;
  const sorted = [...models].sort(
    (a, b) => (b.created ?? 0) - (a.created ?? 0) || b.id.localeCompare(a.id),
  );
  const ids = sorted.map((m) => m.id);
  let deep: string | undefined;
  let fast: string | undefined;
  if (driver.wire === 'anthropic') {
    deep = ids.find((id) => /^claude-opus-/.test(id));
    fast = ids.find((id) => /^claude-haiku-/.test(id));
  } else {
    // Flagship: gpt-N[.M] with no size/date suffix; small tier: -mini/-nano.
    deep = ids.find((id) => /^gpt-\d+(\.\d+)?$/.test(id));
    fast = ids.find((id) => /^gpt-\d+(\.\d+)?-(mini|nano)$/.test(id));
  }
  return { fast: fast ?? driver.routing.fast, deep: deep ?? driver.routing.deep };
}

/** The sentinel the page sends when the model choice is "Auto". */
export const AUTO_MODEL = 'auto';

export interface RouteDecision {
  model: string;
  tier: 'fast' | 'deep';
  /** One human-readable clause, DISCLOSED under the answer — the routing is
   *  deterministic and the user always sees which model served and why. */
  reason: string;
}

/**
 * Deterministic per-question routing for the "Auto" model choice. Pure and
 * pinned by test: reasoning-shaped questions (why/how/design/debug...), long
 * or multi-part questions, deep follow-up chains, and detail-grounded asks go
 * to the deep tier; short lookups go to the fast tier.
 */
export function routeModel(
  driver: LlmDriver,
  question: string,
  opts: { detail?: boolean; historyLength?: number; routing?: { fast: string; deep: string } } = {},
): RouteDecision {
  const routing = opts.routing ?? driver.routing;
  if (!routing) {
    return {
      model: driver.defaultModel,
      tier: 'deep',
      reason: 'single-model provider (no routing tiers)',
    };
  }
  const q = question.trim();
  const deepReasons: string[] = [];
  if (opts.detail) deepReasons.push('finding-level grounding is on');
  if (q.length > 240) deepReasons.push('long question');
  if ((q.match(/\?/g) ?? []).length >= 2) deepReasons.push('multi-part question');
  // Fast-by-default (2026-08-03 tune from live routing observation): plain
  // how-to questions are LOOKUPS the grounding answers directly — "how do I
  // set up the bot token" needs retrieval, not reasoning. Deep is reserved
  // for genuinely analytic shapes (explain/compare/design/debug/why).
  if (
    /\b(why|explain|design|architect|compare|trade-?offs?|debug|root cause|investigate|plan|migrate|strategy|convince|justify|recommend|should (we|i)\b)/i.test(
      q,
    )
  ) {
    deepReasons.push('reasoning-shaped question');
  }
  if ((opts.historyLength ?? 0) >= 6) deepReasons.push('deep follow-up chain');
  if (deepReasons.length > 0) {
    return { model: routing.deep, tier: 'deep', reason: deepReasons[0] };
  }
  return { model: routing.fast, tier: 'fast', reason: 'quick lookup' };
}

export function getDriver(id: string): LlmDriver | undefined {
  return LLM_DRIVERS.find((d) => d.id === id);
}

/** Which env key (if any) the serve process can use for a driver. */
export function envKeyFor(driver: LlmDriver): string | null {
  const v = process.env[driver.keyEnv];
  return v && v.trim().length > 0 ? v : null;
}

/** Optional env base URL for the custom driver. */
export const CUSTOM_BASE_URL_ENV = 'DXKIT_LLM_BASE_URL';

/** A tool the relay may offer the model (transport projection of the
 *  learn agent-tool registry — the registry itself stays provider-free). */
export interface RelayTool {
  name: string;
  description: string;
  /** JSON Schema object both wires accept verbatim. */
  inputSchema: object;
  /** Executes locally; the returned text is sent to the provider as the
   *  tool result. Must not throw (the registry's contract). */
  run(args: Record<string, unknown>): string | Promise<string>;
}

/** One executed tool call — returned for the per-call disclosure ledger. */
export interface RelayToolCall {
  tool: string;
  /** JSON rendering of the model-supplied arguments. */
  args: string;
  /** Size of the text sent back to the provider. */
  resultChars: number;
}

/** Hard budget on locally executed tool calls per question. */
export const MAX_TOOL_CALLS = 8;
/** Tool results are capped before relay so one call can't blow the context. */
const MAX_TOOL_RESULT_CHARS = 8_000;

export interface RelayRequest {
  driver: LlmDriver;
  /** Free-text model wins over the driver default. */
  model: string;
  /** Full base URL for the custom driver (from form or env). */
  baseUrl?: string;
  apiKey: string;
  system: string;
  /** Prior turns + the current question, oldest first. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Read-only repo tools (repo mode only). Absent ⇒ single-shot relay,
   *  byte-identical to the pre-tool wire shape. */
  tools?: RelayTool[];
  timeoutMs?: number;
}

export interface RelayResult {
  ok: boolean;
  answer?: string;
  /** Disclosed, key-free error description. */
  error?: string;
  /** Every locally executed tool call, in order — the disclosure ledger. */
  toolCalls?: RelayToolCall[];
}

/** One bounded HTTP round. Never throws; timeouts read as errors. */
async function postRound(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `provider returned HTTP ${res.status}: ${await safeBody(res)}` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: controller.signal.aborted ? `provider timed out after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Execute one model-requested tool call against the offered registry,
 *  recording it in the ledger. Unknown tools answer with text (never a
 *  throw — the model can recover); results are size-capped before relay. */
async function execToolCall(
  tools: RelayTool[],
  name: string,
  args: Record<string, unknown>,
  ledger: RelayToolCall[],
  budgetLeft: boolean,
): Promise<string> {
  let out: string;
  if (!budgetLeft) {
    out = `Tool budget exhausted (${MAX_TOOL_CALLS} calls max per question) — answer from what you have.`;
  } else {
    const tool = tools.find((t) => t.name === name);
    out = tool ? await tool.run(args) : `Unknown tool: ${name}.`;
  }
  if (out.length > MAX_TOOL_RESULT_CHARS) out = `${out.slice(0, MAX_TOOL_RESULT_CHARS)}…`;
  ledger.push({ tool: name, args: JSON.stringify(args), resultChars: out.length });
  return out;
}

/**
 * Relay ONE question to the provider. Raw HTTP by design: this is a
 * provider-neutral relay behind a driver registry, not a per-provider SDK
 * integration, and dxkit keeps its dependency surface minimal. The fetch
 * implementation is injectable for tests. The key is used for exactly this
 * request and never logged, stored, or echoed.
 *
 * With `tools` present (repo mode), the relay runs a BOUNDED tool loop:
 * the model may request read-only repo tools, each executes locally, the
 * result is appended, and the conversation continues — at most
 * MAX_TOOL_CALLS executions, after which the model is forced to answer
 * (`tool_choice: none`). Every executed call lands in `toolCalls`, the
 * per-call disclosure ledger the page renders. Without `tools`, the wire
 * shape is byte-identical to the pre-tool relay.
 */
export async function relayAsk(
  req: RelayRequest,
  fetchFn: typeof fetch = fetch,
): Promise<RelayResult> {
  const timeout = req.timeoutMs ?? 60_000;
  const tools = req.tools ?? [];
  const ledger: RelayToolCall[] = [];
  // The ledger rides the result ONLY when tools were offered, so the
  // no-tools result shape stays byte-identical to the pre-tool relay.
  const withLedger = (r: RelayResult): RelayResult => (req.tools ? { ...r, toolCalls: ledger } : r);
  // Rounds are bounded independently of the call budget so a provider that
  // keeps requesting tools despite tool_choice:none cannot loop forever.
  const maxRounds = MAX_TOOL_CALLS + 2;

  if (req.driver.wire === 'anthropic') {
    interface AnthropicBlock {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }
    const url = `${req.driver.endpoint}/v1/messages`;
    const headers = {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
    };
    const messages: Array<{ role: string; content: unknown }> = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    for (let round = 0; round < maxRounds; round++) {
      const budgetLeft = ledger.length < MAX_TOOL_CALLS;
      const body = {
        model: req.model,
        max_tokens: 2048,
        // The grounding is a stable ~50k-token prefix reused across every
        // question in a session; cache_control makes repeat queries pay
        // ~10% for it (G14). OpenAI's wire needs nothing — it auto-caches
        // repeated prefixes.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
              ...(budgetLeft ? {} : { tool_choice: { type: 'none' } }),
            }
          : {}),
      };
      const round1 = await postRound(url, headers, body, timeout, fetchFn);
      if (!round1.ok) return withLedger({ ok: false, error: round1.error });
      const data = round1.data as { stop_reason?: string; content?: AnthropicBlock[] };
      if (data.stop_reason === 'refusal') {
        return withLedger({ ok: false, error: 'the provider declined this request (refusal)' });
      }
      const uses = (data.content ?? []).filter((b) => b.type === 'tool_use');
      if (data.stop_reason === 'tool_use' && uses.length > 0 && budgetLeft) {
        messages.push({ role: 'assistant', content: data.content });
        const results: unknown[] = [];
        for (const u of uses) {
          const out = await execToolCall(
            tools,
            u.name ?? '',
            (u.input ?? {}) as Record<string, unknown>,
            ledger,
            ledger.length < MAX_TOOL_CALLS,
          );
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      return withLedger(
        text.length > 0 ? { ok: true, answer: text } : { ok: false, error: 'empty response' },
      );
    }
    return withLedger({ ok: false, error: 'tool loop did not converge' });
  }

  // openai-chat wire (openai + custom).
  const base = req.driver.endpoint ?? req.baseUrl;
  if (!base) return { ok: false, error: 'custom driver requires a base URL' };
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${req.apiKey}`,
  };
  interface OpenAiToolCall {
    id?: string;
    function?: { name?: string; arguments?: string };
  }
  const messages: unknown[] = [{ role: 'system', content: req.system }, ...req.messages];
  for (let round = 0; round < maxRounds; round++) {
    const budgetLeft = ledger.length < MAX_TOOL_CALLS;
    const body = {
      model: req.model,
      messages,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            ...(budgetLeft ? {} : { tool_choice: 'none' }),
          }
        : {}),
    };
    const round1 = await postRound(url, headers, body, timeout, fetchFn);
    if (!round1.ok) return withLedger({ ok: false, error: round1.error });
    const data = round1.data as {
      choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
    };
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (calls.length > 0 && budgetLeft) {
      messages.push(msg);
      for (const tc of calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          // Malformed arguments read as empty — the tool answers accordingly.
        }
        const out = await execToolCall(
          tools,
          tc.function?.name ?? '',
          parsed,
          ledger,
          ledger.length < MAX_TOOL_CALLS,
        );
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
      }
      continue;
    }
    const answer = msg?.content;
    return withLedger(
      typeof answer === 'string' && answer.length > 0
        ? { ok: true, answer }
        : { ok: false, error: 'empty response' },
    );
  }
  return withLedger({ ok: false, error: 'tool loop did not converge' });
}

/** First 200 chars of an error body, never throwing, never echoing headers. */
async function safeBody(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '(unreadable body)';
  }
}
