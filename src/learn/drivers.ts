/**
 * The LLM driver registry for the learn assistant (issue #245) — the ONE
 * place provider facts live. Three drivers by design decision (2026-08-02):
 * Anthropic (default), OpenAI, and an OpenAI-compatible custom endpoint that
 * covers org proxies, Azure-style gateways, and local models without naming
 * products. Each driver declares its key env var, endpoint, wire format, and
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
  if (
    /\b(why|how (do|should|can|would)|explain|design|architect|compare|trade-?offs?|debug|root cause|investigate|plan|migrate|strategy|convince|justify)\b/i.test(
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
  timeoutMs?: number;
}

export interface RelayResult {
  ok: boolean;
  answer?: string;
  /** Disclosed, key-free error description. */
  error?: string;
}

/**
 * Relay ONE question to the provider. Raw HTTP by design: this is a
 * provider-neutral relay behind a driver registry, not a per-provider SDK
 * integration, and dxkit keeps its dependency surface minimal. The fetch
 * implementation is injectable for tests. The key is used for exactly this
 * request and never logged, stored, or echoed.
 */
export async function relayAsk(
  req: RelayRequest,
  fetchFn: typeof fetch = fetch,
): Promise<RelayResult> {
  const timeout = req.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (req.driver.wire === 'anthropic') {
      const res = await fetchFn(`${req.driver.endpoint}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 2048,
          system: req.system,
          messages: req.messages,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: `provider returned HTTP ${res.status}: ${await safeBody(res)}` };
      }
      const data = (await res.json()) as {
        stop_reason?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      if (data.stop_reason === 'refusal') {
        return { ok: false, error: 'the provider declined this request (refusal)' };
      }
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      return text.length > 0 ? { ok: true, answer: text } : { ok: false, error: 'empty response' };
    }

    // openai-chat wire (openai + custom).
    const base = req.driver.endpoint ?? req.baseUrl;
    if (!base) return { ok: false, error: 'custom driver requires a base URL' };
    const res = await fetchFn(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `provider returned HTTP ${res.status}: ${await safeBody(res)}` };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = data.choices?.[0]?.message?.content;
    return typeof answer === 'string' && answer.length > 0
      ? { ok: true, answer }
      : { ok: false, error: 'empty response' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: controller.signal.aborted ? `provider timed out after ${timeout}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** First 200 chars of an error body, never throwing, never echoing headers. */
async function safeBody(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '(unreadable body)';
  }
}
