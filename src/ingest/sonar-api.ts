/**
 * SonarQube / SonarCloud reader — pulls a project's already-computed
 * issues from the Sonar Web API.
 *
 * Why API-read (not SARIF-parse): Sonar is not a SARIF-native emitter —
 * without this reader a Sonar customer would have to hand-build an
 * API→SARIF converter. Reading issues does not re-run analysis, so the
 * fetch is quota-free; an admin provides `SONAR_TOKEN` once (ideally as
 * a CI secret), the refresh job commits the snapshot, and every other
 * developer and CI run reads it without a token.
 *
 * Endpoint (identical shape on SonarQube Server and SonarCloud):
 *   GET {host}/api/issues/search
 *       ?componentKeys=<projectKey>&types=BUG,VULNERABILITY
 *       &resolved=false&ps=500&p=<n>
 *       [&organization=<org>]            (SonarCloud)
 *       [&branch=<b> | &pullRequest=<id>]
 *   Authorization: Basic base64("<token>:")   (token as username, empty
 *   password — the scheme that works across all SonarQube versions AND
 *   SonarCloud; Bearer is 10.x+ only.)
 *
 * Default scope is BUG + VULNERABILITY — NOT `CODE_SMELL`: Sonar's
 * maintainability firehose would make the gate noisy, and the dxkit
 * value here is unification (one baseline / allowlist / PR verdict
 * spanning native + Sonar findings), so the ingest takes the classes
 * that belong in a security-shaped gate. Callers can widen it.
 *
 * VALIDATION NOTE: the paging shape + issue fields below were validated
 * against a REAL SonarCloud response (public project, api/issues/search)
 * — see test fixtures. The parser is defensive regardless (missing
 * fields skip, never throw) so a schema surprise degrades to "fewer
 * findings", never a crash.
 */
import type { ExternalFinding } from './types';
import type { Severity } from '../analyzers/security/types';

export interface SonarReadOptions {
  /** Sonar user token. Sent as HTTP Basic `base64("<token>:")`. Empty →
   *  anonymous (works only for public SonarCloud projects; a private
   *  project then 401s with a clear message). */
  token?: string;
  /** Server base URL — `https://sonarcloud.io`, or a self-hosted
   *  `https://sonar.example.com`. No trailing slash needed. */
  hostUrl: string;
  /** The Sonar project key (`componentKeys`). */
  projectKey: string;
  /** Issue types to ingest. Default `['BUG', 'VULNERABILITY']`. */
  types?: readonly string[];
  /** SonarCloud organization key (SonarCloud requires it on some orgs;
   *  harmless when omitted on Server). */
  organization?: string;
  /** Read a specific branch's issues. */
  branch?: string;
  /** Read a PR analysis' issues — the freshness path: to gate an issue a
   *  PR introduces, Sonar must have analyzed THAT PR. */
  pullRequest?: string;
  /** Progress/truncation disclosure sink. */
  onLog?: (msg: string) => void;
}

/** Sonar caps any paged `issues/search` at this many rows — requesting
 *  past it 400s. Reaching it is DISCLOSED, never silent (no-silent-caps). */
export const SONAR_SEARCH_ROW_CAP = 10_000;

const PAGE_SIZE = 500;

/** Sonar's five-level severity → dxkit's four tiers. */
function mapSeverity(severity: string | undefined): Severity {
  switch ((severity || '').toUpperCase()) {
    case 'BLOCKER':
      return 'critical';
    case 'CRITICAL':
      return 'high';
    case 'MAJOR':
      return 'medium';
    case 'MINOR':
    case 'INFO':
      return 'low';
    default:
      return 'medium';
  }
}

/** Strip the `<projectKey>:` prefix Sonar prepends to a file component.
 *  Returns null for a component that carries no file path (the project
 *  itself, a directory-less module) — such an issue can't be
 *  fingerprinted or fixed at a location. */
export function fileFromComponent(
  component: string | undefined,
  projectKey: string,
): string | null {
  if (!component) return null;
  const prefix = `${projectKey}:`;
  const file = component.startsWith(prefix) ? component.slice(prefix.length) : component;
  if (!file || file === projectKey) return null;
  return file;
}

export interface SonarIssue {
  key?: string;
  rule?: string;
  severity?: string;
  component?: string;
  line?: number;
  message?: string;
  type?: string;
}

interface SonarSearchResponse {
  paging?: { pageIndex?: number; pageSize?: number; total?: number };
  total?: number;
  issues?: SonarIssue[];
}

/** Map one Sonar issue → `ExternalFinding`, or null when it carries no
 *  usable file component. Pure + defensive: a malformed issue skips,
 *  never throws. CWE is '' for v1 — Sonar carries CWE on the RULE's
 *  security-standards metadata, not the issue; identity does not depend
 *  on it (Rule 9), so this is lossless for fingerprinting. */
export function sonarIssueToFinding(issue: SonarIssue, projectKey: string): ExternalFinding | null {
  const file = fileFromComponent(issue.component, projectKey);
  if (!file) return null;
  const rule = issue.rule || '';
  if (!rule) return null;
  return {
    engine: 'sonarqube',
    severity: mapSeverity(issue.severity),
    category: 'code',
    cwe: '',
    rule,
    title: issue.message || rule,
    file,
    // A file-level issue (no line) still anchors at the top of the file.
    line: typeof issue.line === 'number' && issue.line > 0 ? issue.line : 1,
  };
}

/** The search URL for one page — exported so the query contract (types
 *  scope, resolved=false, branch/PR routing) is testable without a
 *  network. */
export function sonarSearchUrl(opts: SonarReadOptions, page: number): string {
  const params = new URLSearchParams({
    componentKeys: opts.projectKey,
    types: (opts.types && opts.types.length > 0 ? opts.types : ['BUG', 'VULNERABILITY']).join(','),
    resolved: 'false',
    ps: String(PAGE_SIZE),
    p: String(page),
  });
  if (opts.organization) params.set('organization', opts.organization);
  if (opts.pullRequest) params.set('pullRequest', opts.pullRequest);
  else if (opts.branch) params.set('branch', opts.branch);
  const base = opts.hostUrl.replace(/\/+$/, '');
  return `${base}/api/issues/search?${params.toString()}`;
}

/** The auth header for a token, or none for an anonymous read. Basic
 *  with the token as username and an empty password — universal across
 *  SonarQube versions and SonarCloud. */
export function sonarAuthHeaders(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` };
}

/**
 * Fetch a project's open BUG + VULNERABILITY issues, following
 * pagination up to Sonar's 10k search cap (disclosed via `onLog` when
 * hit). Throws on auth / network failure so the CLI can route it
 * through the one engine-failure policy; a successful read with zero
 * issues returns `[]`.
 */
export async function fetchSonarFindings(opts: SonarReadOptions): Promise<ExternalFinding[]> {
  const log = opts.onLog ?? (() => {});
  const out: ExternalFinding[] = [];
  let page = 1;
  let total = Infinity;

  while ((page - 1) * PAGE_SIZE < Math.min(total, SONAR_SEARCH_ROW_CAP)) {
    const res: Response = await fetch(sonarSearchUrl(opts, page), {
      headers: { Accept: 'application/json', ...sonarAuthHeaders(opts.token) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sonar API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as SonarSearchResponse;
    total = json.paging?.total ?? json.total ?? 0;
    const issues = json.issues ?? [];
    if (issues.length === 0) break;
    for (const issue of issues) {
      const f = sonarIssueToFinding(issue, opts.projectKey);
      if (f) out.push(f);
    }
    page++;
  }

  if (total > SONAR_SEARCH_ROW_CAP) {
    log(
      `Sonar reports ${total} matching issues but caps a paged search at ` +
        `${SONAR_SEARCH_ROW_CAP} — ingested the first ${SONAR_SEARCH_ROW_CAP} ` +
        `(newest analysis first). Narrow with --sonar-branch or fix down the backlog.`,
    );
  }
  return out;
}
