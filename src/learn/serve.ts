/**
 * `vyuh-dxkit learn --serve` — the localhost assistant server (issue #245).
 *
 * Security posture, all load-bearing:
 *   - binds 127.0.0.1 ONLY — never reachable from the network;
 *   - READ-ONLY + relay: it serves the page, reports status, and relays one
 *     question at a time to the user's chosen provider. No mutation
 *     endpoint exists (the setup wizard is deliberately deferred, #247);
 *   - key handling: an env key (per-driver) stays in the process and is
 *     never sent to the browser; a browser-entered key is held in browser
 *     memory only, arrives per-request in the POST body, is used for
 *     exactly that provider call, and is never logged, stored, or echoed;
 *   - body size is capped and JSON is parsed defensively.
 */
import * as http from 'http';
import type { LearnBundle } from './bundle';
import type { LearnRepoStatus } from './repo-status';
import { renderLearnHtml } from './render';
import { assembleGrounding } from './grounding';
import {
  AUTO_MODEL,
  CUSTOM_BASE_URL_ENV,
  LLM_DRIVERS,
  envKeyFor,
  getDriver,
  listModels,
  relayAsk,
  resolveRouting,
  routeModel,
  type ProviderModel,
} from './drivers';
import { markdownToHtml } from './markdown';

const MAX_BODY_BYTES = 256 * 1024;

export interface LearnServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export interface ServeOptions {
  port?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

interface ModelsBody {
  driverId?: string;
  browserKey?: string;
  baseUrl?: string;
}

interface AskBody {
  driverId?: string;
  model?: string;
  baseUrl?: string;
  browserKey?: string;
  detail?: boolean;
  question?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => resolve(null));
  });
}

/** The status payload the page's JS renders its chooser + disclosure from. */
export function buildStatusPayload(
  bundle: LearnBundle,
  status: LearnRepoStatus | null,
  detail: boolean,
): unknown {
  const grounding = assembleGrounding(bundle, status, { detail });
  return {
    version: bundle.version,
    repoMode: status !== null,
    drivers: LLM_DRIVERS.map((d) => ({
      id: d.id,
      label: d.label,
      keyEnv: d.keyEnv,
      needsBaseUrl: d.endpoint === null,
      suggestedModels: d.suggestedModels,
      defaultModel: d.defaultModel,
      routing: d.routing ?? null,
      // Presence only — the key itself never crosses to the browser.
      envKeyPresent: envKeyFor(d) !== null,
    })),
    envBaseUrlPresent: !!process.env[CUSTOM_BASE_URL_ENV],
    disclosure: grounding.disclosure,
    detail,
  };
}

export async function startLearnServer(
  bundle: LearnBundle,
  status: LearnRepoStatus | null,
  opts: ServeOptions = {},
): Promise<LearnServer> {
  const fetchFn = opts.fetchFn ?? fetch;
  // Live model lists per driver(+base URL), fetched with the user's key so
  // the chooser is never a stale hardcoded snapshot. Session-scoped cache;
  // the compiled-in suggestions remain the labeled offline fallback.
  const modelCache = new Map<string, ProviderModel[]>();
  const html = renderLearnHtml(bundle, status, {
    generatedAt: new Date().toISOString(),
    serve: true,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/status')) {
        const detail = new URL(url, 'http://localhost').searchParams.get('detail') === '1';
        json(res, 200, buildStatusPayload(bundle, status, detail));
        return;
      }
      if (req.method === 'POST' && url === '/api/models') {
        const raw = await readBody(req);
        if (raw === null) {
          json(res, 413, { error: 'request body too large' });
          return;
        }
        let body: ModelsBody;
        try {
          body = JSON.parse(raw) as ModelsBody;
        } catch {
          json(res, 400, { error: 'invalid JSON' });
          return;
        }
        const driver = getDriver(body.driverId ?? '');
        if (!driver) {
          json(res, 400, { error: `unknown driver: ${body.driverId ?? '(none)'}` });
          return;
        }
        const baseUrl =
          (body.baseUrl ?? '').trim() || process.env[CUSTOM_BASE_URL_ENV] || undefined;
        const apiKey = envKeyFor(driver) ?? (body.browserKey ?? '').trim();
        const cacheKey = `${driver.id}|${baseUrl ?? ''}`;
        const fallback = {
          live: false,
          models: driver.suggestedModels,
          routing: driver.routing ?? null,
          note: 'suggestions from this dxkit release — may be outdated; enter a key to load the live list from the provider',
        };
        if (apiKey.length === 0) {
          json(res, 200, fallback);
          return;
        }
        let models = modelCache.get(cacheKey);
        if (!models) {
          const listed = await listModels({ driver, apiKey, baseUrl }, fetchFn);
          if (!listed.ok || !listed.models) {
            json(res, 200, {
              ...fallback,
              note: `${fallback.note} (live fetch failed: ${listed.error})`,
            });
            return;
          }
          models = listed.models;
          modelCache.set(cacheKey, models);
        }
        const sorted = [...models].sort(
          (a, b) => (b.created ?? 0) - (a.created ?? 0) || b.id.localeCompare(a.id),
        );
        json(res, 200, {
          live: true,
          models: sorted.map((m) => m.id),
          routing: resolveRouting(driver, models) ?? null,
          note: 'live list from the provider, fetched with your key',
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/ask') {
        const raw = await readBody(req);
        if (raw === null) {
          json(res, 413, { error: 'request body too large' });
          return;
        }
        let body: AskBody;
        try {
          body = JSON.parse(raw) as AskBody;
        } catch {
          json(res, 400, { error: 'invalid JSON' });
          return;
        }
        const driver = getDriver(body.driverId ?? '');
        if (!driver) {
          json(res, 400, { error: `unknown driver: ${body.driverId ?? '(none)'}` });
          return;
        }
        const question = (body.question ?? '').trim();
        if (question.length === 0) {
          json(res, 400, { error: 'empty question' });
          return;
        }
        // Key precedence: env key first (never leaves the process), else the
        // browser-entered key for this one request.
        const apiKey = envKeyFor(driver) ?? (body.browserKey ?? '').trim();
        if (apiKey.length === 0) {
          json(res, 400, {
            error: `no API key: set ${driver.keyEnv} in the terminal before --serve, or enter a key in the page`,
          });
          return;
        }
        const grounding = assembleGrounding(bundle, status, { detail: !!body.detail });
        const history = Array.isArray(body.history)
          ? body.history
              .filter(
                (m) =>
                  (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
              )
              .slice(-20)
          : [];
        // "Auto" (or an empty model) routes deterministically between the
        // driver's fast/deep tiers; an explicit model always wins. The
        // decision is returned and shown under the answer — never silent.
        const requested = (body.model ?? '').trim();
        const routeBaseUrl =
          (body.baseUrl ?? '').trim() || process.env[CUSTOM_BASE_URL_ENV] || undefined;
        const liveRouting = resolveRouting(
          driver,
          modelCache.get(`${driver.id}|${routeBaseUrl ?? ''}`),
        );
        const route =
          requested.length === 0 || requested === AUTO_MODEL
            ? routeModel(driver, question, {
                detail: !!body.detail,
                historyLength: history.length,
                routing: liveRouting,
              })
            : null;
        const result = await relayAsk(
          {
            driver,
            model: route ? route.model : requested,
            baseUrl: (body.baseUrl ?? '').trim() || process.env[CUSTOM_BASE_URL_ENV] || undefined,
            apiKey,
            system: grounding.system,
            messages: [...history, { role: 'user', content: question }],
          },
          fetchFn,
        );
        if (!result.ok) {
          json(res, 502, { error: result.error });
          return;
        }
        json(res, 200, {
          answer: result.answer,
          // Rendered through the ONE pinned markdown subset renderer (it
          // escapes everything), so the page can show formatted answers
          // without a client-side markdown engine.
          answerHtml: markdownToHtml(result.answer ?? ''),
          servedModel: route ? route.model : requested || driver.defaultModel,
          routed: route !== null,
          routeTier: route?.tier,
          routeReason: route?.reason,
          keySource: envKeyFor(driver) ? 'env' : 'browser',
        });
        return;
      }
      json(res, 404, { error: 'not found' });
    })().catch(() => {
      try {
        json(res, 500, { error: 'internal error' });
      } catch {
        // Response already closed.
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only — the whole security model depends on this bind.
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
