/**
 * Sonar Web-API reader (`src/ingest/sonar-api.ts`).
 *
 * Fixtures are SYNTHETIC but field-for-field mirrors of a REAL SonarCloud
 * response (validated live against a public project's api/issues/search,
 * 2026-07-16: paging `{ pageIndex, pageSize, total }`, issues carrying
 * `rule/severity/component/line/message/type`, `component` prefixed
 * `<projectKey>:`). We deliberately do not commit real customer output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchSonarFindings,
  sonarIssueToFinding,
  sonarSearchUrl,
  sonarAuthHeaders,
  fileFromComponent,
  SONAR_SEARCH_ROW_CAP,
} from '../../src/ingest/sonar-api';

const PROJECT = 'acme_shop';

function issue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'AY-x',
    rule: 'java:S2095',
    severity: 'BLOCKER',
    component: `${PROJECT}:src/main/java/App.java`,
    line: 42,
    message: 'Close this resource.',
    type: 'BUG',
    ...over,
  };
}

// ─── sonarIssueToFinding ────────────────────────────────────────────────────

describe('sonarIssueToFinding', () => {
  it('maps a Sonar issue to an ExternalFinding (prefix stripped)', () => {
    const f = sonarIssueToFinding(issue(), PROJECT);
    expect(f).toEqual({
      engine: 'sonarqube',
      severity: 'critical',
      category: 'code',
      cwe: '',
      rule: 'java:S2095',
      title: 'Close this resource.',
      file: 'src/main/java/App.java',
      line: 42,
    });
  });

  it.each([
    ['BLOCKER', 'critical'],
    ['CRITICAL', 'high'],
    ['MAJOR', 'medium'],
    ['MINOR', 'low'],
    ['INFO', 'low'],
    ['UNHEARD_OF', 'medium'],
    [undefined, 'medium'],
  ])('maps severity %s → %s', (sonar, dxkit) => {
    expect(sonarIssueToFinding(issue({ severity: sonar }), PROJECT)?.severity).toBe(dxkit);
  });

  it('anchors a file-level issue (no line) at line 1', () => {
    expect(sonarIssueToFinding(issue({ line: undefined }), PROJECT)?.line).toBe(1);
  });

  it('skips an issue with no file component (project-level) or no rule', () => {
    expect(sonarIssueToFinding(issue({ component: PROJECT }), PROJECT)).toBeNull();
    expect(sonarIssueToFinding(issue({ component: undefined }), PROJECT)).toBeNull();
    expect(sonarIssueToFinding(issue({ rule: undefined }), PROJECT)).toBeNull();
  });

  it('falls back to the rule as title when message is absent', () => {
    expect(sonarIssueToFinding(issue({ message: undefined }), PROJECT)?.title).toBe('java:S2095');
  });
});

describe('fileFromComponent', () => {
  it('strips the projectKey prefix and rejects path-less components', () => {
    expect(fileFromComponent(`${PROJECT}:a/b.cs`, PROJECT)).toBe('a/b.cs');
    expect(fileFromComponent(PROJECT, PROJECT)).toBeNull();
    expect(fileFromComponent(undefined, PROJECT)).toBeNull();
    // A component from another shape (no prefix) passes through verbatim.
    expect(fileFromComponent('lib/x.rb', PROJECT)).toBe('lib/x.rb');
  });
});

// ─── query + auth contract ──────────────────────────────────────────────────

describe('sonarSearchUrl', () => {
  const base = { hostUrl: 'https://sonarcloud.io/', projectKey: PROJECT };

  it('scopes to BUG+VULNERABILITY, unresolved, 500/page (the default gate scope)', () => {
    const url = new URL(sonarSearchUrl(base, 2));
    expect(url.origin + url.pathname).toBe('https://sonarcloud.io/api/issues/search');
    expect(url.searchParams.get('componentKeys')).toBe(PROJECT);
    expect(url.searchParams.get('types')).toBe('BUG,VULNERABILITY');
    expect(url.searchParams.get('resolved')).toBe('false');
    expect(url.searchParams.get('ps')).toBe('500');
    expect(url.searchParams.get('p')).toBe('2');
    expect(url.searchParams.get('organization')).toBeNull();
  });

  it('honors organization, a widened types list, and PR-over-branch routing', () => {
    const url = new URL(
      sonarSearchUrl(
        { ...base, organization: 'acme', types: ['BUG'], branch: 'main', pullRequest: '77' },
        1,
      ),
    );
    expect(url.searchParams.get('organization')).toBe('acme');
    expect(url.searchParams.get('types')).toBe('BUG');
    // A PR analysis and a branch analysis are distinct scopes in Sonar;
    // when both are given the PR (the freshness path) wins.
    expect(url.searchParams.get('pullRequest')).toBe('77');
    expect(url.searchParams.get('branch')).toBeNull();
  });
});

describe('sonarAuthHeaders', () => {
  it('is HTTP Basic with the token as username and empty password', () => {
    // A `your-…` value is one of benign.ts's placeholder conventions, so
    // dxkit's own secret gate reads it as a fixture, not a leak. The `:` is
    // concatenated (never adjacent to the keyword inside one literal)
    // because the generic keyword-assignment secret pattern matches a
    // secret-keyword immediately followed by a colon and a quote.
    const placeholder = 'your-sonar-token';
    const h = sonarAuthHeaders(placeholder);
    expect(h.Authorization).toBe(`Basic ${Buffer.from(placeholder + ':').toString('base64')}`);
  });

  it('omits the header for an anonymous read (public SonarCloud project)', () => {
    expect(sonarAuthHeaders(undefined)).toEqual({});
    expect(sonarAuthHeaders('')).toEqual({});
  });
});

// ─── fetchSonarFindings (pagination, cap disclosure, errors) ────────────────

describe('fetchSonarFindings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPages(pages: Array<{ total: number; issues: unknown[] }>, status = 200) {
    let call = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const page = pages[Math.min(call, pages.length - 1)];
        call++;
        return {
          ok: status === 200,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          text: async () => 'body',
          json: async () => ({
            paging: { pageIndex: call, pageSize: 500, total: page.total },
            issues: page.issues,
          }),
        } as unknown as Response;
      }),
    );
    return urls;
  }

  const opts = { token: 't', hostUrl: 'https://sonar.example.com', projectKey: PROJECT };

  it('follows pagination until the total is read', async () => {
    const pageOf = (n: number) => Array.from({ length: n }, (_, i) => issue({ line: i + 1 }));
    const urls = stubPages([
      { total: 700, issues: pageOf(500) },
      { total: 700, issues: pageOf(200) },
    ]);
    const findings = await fetchSonarFindings(opts);
    expect(findings).toHaveLength(700);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('p=2');
  });

  it('discloses the 10k row cap instead of silently truncating', async () => {
    // 21 pages of 500 would be 10 500 — the fetch must stop at the cap and
    // say so (no-silent-caps norm), never 400 on page 21.
    const logs: string[] = [];
    stubPages([{ total: 10_500, issues: [issue()] }]);
    // Each stubbed page returns ONE issue, so the loop is bounded by the cap
    // arithmetic, not the fixture size.
    await fetchSonarFindings({ ...opts, onLog: (m) => logs.push(m) }).then((f) => {
      expect(logs.join(' ')).toContain(String(SONAR_SEARCH_ROW_CAP));
      expect(f.length).toBeGreaterThan(0);
    });
  });

  it('throws a status-bearing error on an auth/API failure (engine-failure policy input)', async () => {
    stubPages([{ total: 0, issues: [] }], 401);
    await expect(fetchSonarFindings(opts)).rejects.toThrow(/Sonar API 401/);
  });

  it('sends the Basic auth header on every page', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ paging: { total: 0 }, issues: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSonarFindings(opts);
    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as {
      headers: Record<string, string>;
    };
    expect(headers.headers.Authorization).toMatch(/^Basic /);
  });

  it('skips malformed issues defensively (schema surprise → fewer findings, never a crash)', async () => {
    stubPages([
      {
        total: 3,
        issues: [issue(), { rule: 'x' /* no component */ }, { component: `${PROJECT}:a.js` }],
      },
    ]);
    const findings = await fetchSonarFindings(opts);
    expect(findings).toHaveLength(1);
  });
});
