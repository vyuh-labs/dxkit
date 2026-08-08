/**
 * The in-process text-rule scanner (4.4.0 WP2 / P1-5 stage 1).
 *
 * Evaluates a declarative regex over the tree's files and mints located
 * `custom-check` findings through the seam's ONE validating boundary
 * (`validateLocated`). No spawn — which is exactly why it may run where
 * command checks may not: untrusted trees (the gate's default posture)
 * and bare generated packages with no toolchain. File discovery goes
 * through the canonical walker (`walkPaths` — exclusions respected,
 * depth-unlimited); glob scoping uses the paired-check glob semantics
 * (`globToRegex`) so a policy author learns ONE glob dialect.
 */

import * as fs from 'fs';
import * as path from 'path';
import { walkPaths } from '../tools/walk-paths';
import { globToRegex } from '../tools/suppressions';
import { validateLocated } from './parse';
import type { CustomCheckFinding, CustomCheckResult, CustomCheckSpec } from './types';

/** Per-file read ceiling. A text rule is a line-oriented source scan; a
 *  file past this size is skipped (disclosed in no way per-file — the
 *  gather stays fast on pathological blobs; binaries are skipped by the
 *  NUL probe below). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Run one text-rule spec over the tree. Pure read; never throws. */
export function runTextRule(cwd: string, spec: CustomCheckSpec): CustomCheckResult {
  const rule = spec.textRule;
  if (!rule) {
    return {
      name: spec.name,
      status: 'skipped-unavailable',
      findings: [],
      reason: 'not a text rule (internal dispatch error)',
    };
  }

  let re: RegExp;
  try {
    // Strip g/y: matching is per line; a sticky/global regex would carry
    // lastIndex state across lines and silently skip matches.
    const flags = (rule.flags ?? '').replace(/[gy]/g, '');
    re = new RegExp(rule.pattern, flags);
  } catch (err) {
    // The parseLocated discipline: a misconfigured pattern is ONE binary
    // finding naming the problem — never a crash, never a silent pass.
    const finding: CustomCheckFinding = {
      check: spec.name,
      blocking: spec.blocking,
      message: `text rule '${spec.name}': invalid pattern — ${(err as Error).message}`,
    };
    return { name: spec.name, status: 'fail', findings: [finding] };
  }

  const globRes = (rule.globs ?? []).map((g) => globToRegex(g));
  const inScope = (rel: string): boolean =>
    globRes.length === 0 || globRes.some((g) => g.test(rel));

  const files = walkPaths(cwd, { extensions: [], includeAllFiles: true });
  const raw: Array<{ file: string; line: number }> = [];
  for (const rel of files) {
    if (!inScope(rel)) continue;
    let content: string;
    try {
      const stat = fs.statSync(path.join(cwd, rel));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    // Binary probe: a NUL in the first chunk means this is not line-
    // oriented text; skip rather than mint nonsense line findings.
    if (content.slice(0, 4096).includes('\0')) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        raw.push({ file: rel, line: i + 1 });
      }
    }
  }

  const findings = validateLocated(spec.name, spec.blocking, raw, cwd);
  return {
    name: spec.name,
    status: findings.length > 0 ? 'fail' : 'pass',
    findings,
  };
}
