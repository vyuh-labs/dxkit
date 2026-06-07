/**
 * Snyk Code (SAST) reader — pulls a project's already-computed findings
 * from the Snyk REST API.
 *
 * Why API-read (not `snyk code test`): reading stored issues does NOT
 * consume the org's Snyk Code test quota. On a free/limited tier where
 * tests are capped per billing period, this is the only repeatable way
 * to get the findings out. An admin provides a `SNYK_TOKEN` once
 * (ideally as a CI secret); the refresh job commits a snapshot so every
 * other developer and CI run reads it without a token.
 *
 * Endpoint (REST):
 *   GET /rest/orgs/{org_id}/issues
 *       ?version=<date>&type=code
 *       &scan_item.type=project&scan_item.id=<project_id>
 *   Authorization: token <SNYK_TOKEN>
 *
 * Field paths (confirmed against the published OpenAPI):
 *   - severity → attributes.effective_severity_level
 *                (info|low|medium|high|critical)
 *   - cwe      → attributes.classes[] where source == 'CWE' (id 'CWE-23')
 *   - title    → attributes.title
 *   - location → attributes.coordinates[].representations[].sourceLocation
 *                .file  +  .region.start.line
 *
 * VALIDATION NOTE: the precise auth scheme (`token` vs `Bearer`) and the
 * exact nesting of `sourceLocation` for code issues must be confirmed
 * against a REAL response from a live token before this is trusted in
 * production — synthetic-schema parsers drift from real output. The
 * parser below is defensive (missing fields skip, never throw) so a
 * schema surprise degrades to "fewer findings", never a crash.
 */
import type { ExternalFinding } from './types';
import type { Severity } from '../analyzers/security/types';

export interface SnykReadOptions {
  token: string;
  orgId: string;
  projectId: string;
  /** REST API base; override for self-hosted/regional tenants
   *  (e.g. https://api.eu.snyk.io). */
  apiBase?: string;
  /** REST API version date. Snyk requires an explicit version. */
  version?: string;
}

const DEFAULT_API_BASE = 'https://api.snyk.io';
const DEFAULT_VERSION = '2024-10-15';

/** Snyk's five-level severity → dxkit's four-tier. `info` folds to
 *  `low` (dxkit has no info tier). */
function mapSeverity(level: string | undefined): Severity {
  switch (level) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'info':
      return 'low';
    default:
      return 'medium';
  }
}

interface SnykClass {
  id?: string;
  source?: string;
}
interface SnykRepresentation {
  sourceLocation?: {
    file?: string;
    region?: { start?: { line?: number } };
  };
}
interface SnykCoordinate {
  representations?: SnykRepresentation[];
}
interface SnykIssue {
  id?: string;
  attributes?: {
    title?: string;
    type?: string;
    effective_severity_level?: string;
    classes?: SnykClass[];
    coordinates?: SnykCoordinate[];
  };
}
interface SnykIssuesResponse {
  data?: SnykIssue[];
  links?: { next?: string };
}

/** Extract the first CWE id from an issue's `classes`. */
function cweFromClasses(classes: SnykClass[] | undefined): string {
  if (!classes) return '';
  for (const c of classes) {
    if ((c.source || '').toUpperCase() === 'CWE' && c.id) {
      const m = /(\d+)/.exec(c.id);
      if (m) return `CWE-${parseInt(m[1], 10)}`;
    }
  }
  return '';
}

/** First resolvable source location (file + line) in an issue. */
function locationFrom(coords: SnykCoordinate[] | undefined): { file: string; line: number } | null {
  for (const c of coords || []) {
    for (const r of c.representations || []) {
      const file = r.sourceLocation?.file;
      const line = r.sourceLocation?.region?.start?.line;
      if (file && line) return { file, line };
    }
  }
  return null;
}

/** Map one Snyk issue → `ExternalFinding`, or null when it has no
 *  usable source location (can't be fingerprinted/fixed). */
export function snykIssueToFinding(issue: SnykIssue): ExternalFinding | null {
  const a = issue.attributes;
  if (!a) return null;
  const loc = locationFrom(a.coordinates);
  if (!loc) return null;
  return {
    engine: 'snyk-code',
    severity: mapSeverity(a.effective_severity_level),
    category: 'code',
    cwe: cweFromClasses(a.classes),
    rule: issue.id || a.title || 'snyk-code',
    title: a.title || 'Snyk Code finding',
    file: loc.file,
    line: loc.line,
  };
}

/**
 * Fetch all Snyk Code findings for a project, following pagination.
 * Pure-ish: the only side effect is the network read. Throws on auth /
 * network failure so the CLI can surface a clear message; a successful
 * call with zero issues returns `[]`.
 */
export async function fetchSnykCodeFindings(opts: SnykReadOptions): Promise<ExternalFinding[]> {
  const base = opts.apiBase || DEFAULT_API_BASE;
  const version = opts.version || DEFAULT_VERSION;
  const params = new URLSearchParams({
    version,
    type: 'code',
    'scan_item.type': 'project',
    'scan_item.id': opts.projectId,
    limit: '100',
  });
  let url: string | null = `${base}/rest/orgs/${opts.orgId}/issues?${params.toString()}`;
  const out: ExternalFinding[] = [];
  let guard = 0;

  while (url && guard < 1000) {
    guard++;
    const res: Response = await fetch(url, {
      headers: {
        // Snyk REST API convention. If a live token rejects this,
        // switch to `Bearer ${opts.token}` (see VALIDATION NOTE).
        Authorization: `token ${opts.token}`,
        Accept: 'application/vnd.api+json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Snyk API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as SnykIssuesResponse;
    for (const issue of json.data || []) {
      const f = snykIssueToFinding(issue);
      if (f) out.push(f);
    }
    const next = json.links?.next;
    // `next` is a relative REST path; resolve against the base.
    url = next ? (next.startsWith('http') ? next : `${base}${next}`) : null;
  }
  return out;
}
