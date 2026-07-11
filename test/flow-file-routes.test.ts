import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { extractFromTree } from '../src/analyzers/flow/extract';
import { deriveFileRoutePath } from '../src/analyzers/flow/file-routes';
import { getLanguage } from '../src/languages';
import { grammarShape } from '../src/ast/grammar-shape';
import type { FileRouteSupport, HttpFlowSupport } from '../src/languages/types';

const ts = getLanguage('typescript')!.httpFlow as HttpFlowSupport;
const tsShape = grammarShape('typescript')!;

/** Extract routes as `${METHOD} ${path}` keys for a source string served from
 *  `relPath` (the repo-relative path a file-route framework derives its URL
 *  from). */
async function routeKeys(src: string, relPath: string): Promise<string[]> {
  const tree = await parseSource(src, 'typescript');
  const { routes } = extractFromTree(tree!.rootNode, ts, tsShape, relPath, undefined, relPath);
  return routes.map((r) => `${r.method} ${r.path}`).sort();
}

// The Next.js App Router descriptor the TS pack must declare (2.28.0).
const nextAppRouter: FileRouteSupport = {
  handlerFile: 'route',
  baseDirs: ['src/app', 'app'],
  methodExports: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
};

describe('flow file-routes — Next.js App Router served side', () => {
  it('TS pack declares a fileRoutes descriptor', () => {
    expect(ts.fileRoutes).toBeDefined();
    expect(ts.fileRoutes?.handlerFile).toBe('route');
    expect(ts.fileRoutes?.baseDirs).toContain('app');
  });

  it('derives METHOD + path from directory for exported HTTP-verb functions', async () => {
    const keys = await routeKeys(
      `
      export async function GET(req) { return Response.json([]); }
      export async function POST(req) { return Response.json({}); }
    `,
      'app/api/users/route.ts',
    );
    expect(keys).toEqual(['GET /api/users', 'POST /api/users']);
  });

  it('marks derived routes via file-route with the export name as handler', async () => {
    const tree = await parseSource('export function GET() {}', 'typescript');
    const { routes } = extractFromTree(
      tree!.rootNode,
      ts,
      tsShape,
      'app/health/route.ts',
      undefined,
      'app/health/route.ts',
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].via).toBe('file-route');
    expect(routes[0].handler).toBe('GET');
    expect(routes[0].path).toBe('/health');
  });

  it('strips route groups (parenthesized dirs) and honors src/app base', async () => {
    const keys = await routeKeys(
      `export async function POST() {}`,
      'src/app/(payload)/api/form-submissions/route.ts',
    );
    expect(keys).toEqual(['POST /api/form-submissions']);
  });

  it('canonicalizes [id] to a single {var} and [[...slug]] catch-all to {*}', async () => {
    expect(await routeKeys(`export function GET() {}`, 'app/api/users/[id]/route.ts')).toEqual([
      'GET /api/users/{var}',
    ]);
    // A catch-all is a PREFIX matcher (`{*}`), distinct from a single dynamic
    // `{var}` — the join prefix-matches it against concrete client calls.
    expect(
      await routeKeys(`export async function POST() {}`, 'app/(payload)/api/[[...slug]]/route.ts'),
    ).toEqual(['POST /api/{*}']);
  });

  it('recognizes `export const GET` and `export { POST }` forms', async () => {
    expect(
      await routeKeys(`export const GET = async () => Response.json([]);`, 'app/api/me/route.ts'),
    ).toEqual(['GET /api/me']);
    expect(
      await routeKeys(`async function POST() {}\nexport { POST };`, 'app/api/webhooks/route.ts'),
    ).toEqual(['POST /api/webhooks']);
  });

  it('ignores non-verb exports and non-exported verb functions (precision)', async () => {
    expect(
      await routeKeys(
        `export const config = { runtime: 'edge' };\nfunction GET() {}\nexport function helper() {}`,
        'app/api/x/route.ts',
      ),
    ).toEqual([]);
  });

  it('does NOT derive routes for a handler file outside any base dir', async () => {
    expect(await routeKeys(`export function GET() {}`, 'lib/route.ts')).toEqual([]);
  });

  it('does NOT derive routes for a non-handler file under a base dir', async () => {
    // page.tsx is not the route handler; its exports are not HTTP verbs.
    expect(await routeKeys(`export function GET() {}`, 'app/api/users/page.tsx')).toEqual([]);
  });

  it('excludes private (_-prefixed) segments from routing', async () => {
    expect(await routeKeys(`export function GET() {}`, 'app/_internal/api/route.ts')).toEqual([]);
  });
});

describe('deriveFileRoutePath — the central path algebra (framework-general)', () => {
  const d = (relPath: string): string | null => deriveFileRoutePath(relPath, nextAppRouter);

  it('drops parallel-route slots (@-prefixed) as non-path segments', () => {
    expect(d('app/@modal/api/photos/route.ts')).toBe('/api/photos');
  });

  it('applies a urlPrefix for bases whose name is part of the served URL', () => {
    const pagesApi: FileRouteSupport = {
      handlerFile: '*',
      baseDirs: ['pages/api'],
      urlPrefix: '/api',
      methodExports: ['default'],
    };
    expect(deriveFileRoutePath('pages/api/users/[id].ts', pagesApi)).toBe('/api/users/{var}');
    expect(deriveFileRoutePath('pages/api/health/index.ts', pagesApi)).toBe('/api/health');
  });

  it('a handler file at the base root serves the ROOT route', () => {
    // Pre-root-fix this derived null (the normalizer rejected a bare `/`);
    // an `app/route.ts` genuinely serves `GET /`, and root routes are real
    // routes since the wave-2 validation fix.
    expect(d('app/route.ts')).toBe('/');
  });
});
