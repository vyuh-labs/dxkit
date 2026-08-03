/**
 * The provider relay for the learn assistant: ONE question in, one
 * answer out — raw HTTP by design (a provider-neutral relay behind the
 * driver registry in `./drivers`, not a per-provider SDK integration;
 * dxkit keeps its dependency surface minimal). Split from drivers.ts
 * when the WP18 tool loop landed (the gate's large-file rule — same
 * extraction precedent as page-css/page-js from render.ts).
 *
 * With `tools` present (repo mode), the relay runs a BOUNDED tool loop;
 * every locally executed call returns in the `toolCalls` disclosure
 * ledger. Keys are used per-request and never logged, stored, or echoed.
 */
import type { LlmDriver } from './drivers';

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
