/**
 * User-defined suppressions for scanner findings.
 *
 * Reads `.dxkit-suppressions.json` at the repo root. Example:
 *
 *   {
 *     "gitleaks": [
 *       { "rule": "generic-api-key", "paths": ["test/fixtures/**"], "reason": "fake keys in fixtures" }
 *     ],
 *     "semgrep": [
 *       { "rule": "*", "paths": ["scripts/migrations/**"], "reason": "legacy, grandfathered" }
 *     ]
 *   }
 *
 * A finding is suppressed when:
 *   - its rule matches an entry's `rule` (exact string, or "*" as wildcard), AND
 *   - its path matches at least one of the entry's `paths` globs.
 *
 * Globs support `**` (any path segments), `*` (any chars except `/`), and `?`.
 * Leading `./` is normalized away.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SuppressionRule {
  /** Rule ID to match, or "*" for any rule from this tool. */
  rule: string;
  /** Glob patterns (relative to repo root) — finding suppressed if any match. */
  paths: string[];
  /** Optional human-readable reason (surfaced in reports). */
  reason?: string;
}

export interface Suppressions {
  gitleaks: SuppressionRule[];
  semgrep: SuppressionRule[];
  slop: SuppressionRule[];
}

const EMPTY: Suppressions = { gitleaks: [], semgrep: [], slop: [] };

const cache = new Map<string, Suppressions>();

/** Load suppressions for a repo root, memoized. Returns empty suppressions if file is missing/malformed. */
export function loadSuppressions(cwd: string): Suppressions {
  const hit = cache.get(cwd);
  if (hit) return hit;

  const filePath = path.join(cwd, '.dxkit-suppressions.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    cache.set(cwd, EMPTY);
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cache.set(cwd, EMPTY);
    return EMPTY;
  }

  const resolved: Suppressions = {
    gitleaks: extractRules(parsed, 'gitleaks'),
    semgrep: extractRules(parsed, 'semgrep'),
    slop: extractRules(parsed, 'slop'),
  };
  cache.set(cwd, resolved);
  return resolved;
}

/** Clear memo — useful for tests. */
export function clearSuppressionsCache(): void {
  cache.clear();
}

function extractRules(parsed: unknown, key: string): SuppressionRule[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const bucket = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(bucket)) return [];
  return bucket
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      rule: typeof e.rule === 'string' ? e.rule : '',
      paths: Array.isArray(e.paths)
        ? e.paths.filter((p): p is string => typeof p === 'string')
        : [],
      reason: typeof e.reason === 'string' ? e.reason : undefined,
    }))
    .filter((r) => r.rule && r.paths.length > 0);
}

/**
 * Apply suppressions to a set of findings.
 *
 * Callers pass accessors (findings vary in shape across tools). Returns the
 * kept findings plus a parallel list of suppressed findings with the matched
 * reason annotated.
 */
export function applySuppressions<T>(
  findings: T[],
  rules: SuppressionRule[],
  getRule: (f: T) => string,
  getPath: (f: T) => string,
): { kept: T[]; suppressed: Array<{ finding: T; reason?: string }> } {
  if (rules.length === 0) return { kept: findings, suppressed: [] };

  const compiled = rules.map((r) => ({
    rule: r.rule,
    regexes: r.paths.map(globToRegex),
    reason: r.reason,
  }));

  const kept: T[] = [];
  const suppressed: Array<{ finding: T; reason?: string }> = [];

  for (const f of findings) {
    const fRule = getRule(f);
    const fPath = normalizePath(getPath(f));
    let matched: { reason?: string } | null = null;

    for (const c of compiled) {
      if (c.rule !== '*' && c.rule !== fRule) continue;
      if (c.regexes.some((re) => re.test(fPath))) {
        matched = { reason: c.reason };
        break;
      }
    }

    if (matched) {
      suppressed.push({ finding: f, reason: matched.reason });
    } else {
      kept.push(f);
    }
  }

  return { kept, suppressed };
}

/** Convert a glob pattern to an anchored regex. Supports `**`, `*`, `?`. */
export function globToRegex(glob: string): RegExp {
  let g = glob;
  if (g.startsWith('./')) g = g.slice(2);

  let re = '';
  let i = 0;
  while (i < g.length) {
    // leading or mid-path `**/` — optional path prefix
    if (g.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    // trailing `/**` — optional path suffix
    if (i + 3 === g.length && g.startsWith('/**', i)) {
      re += '(?:/.*)?';
      i += 3;
      continue;
    }
    // bare `**` — any chars including slashes
    if (g.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }

    const c = g[i];
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()|[]{}^$\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}

function normalizePath(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (n.startsWith('./')) n = n.slice(2);
  return n;
}
