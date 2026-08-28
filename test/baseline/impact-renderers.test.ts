/**
 * DELIVERY: the Impact section reaches all three check surfaces (console /
 * JSON / markdown), with the design's UX calls implemented as code:
 *
 *   - non-zero only: a change that resolves findings gets the section; a
 *     neutral change gets ONE quiet line on the PR comment (markdown), and
 *     no extra block on the console (the summary footer already reports
 *     zero resolved);
 *   - no duplication with the blocking surface: a regressing change's added
 *     findings stay in the existing finding tables: Impact counts them in
 *     the headline and never re-lists them;
 *   - JSON is additive: the `impact` field joins the v1 payload without
 *     touching any existing field, and is ALWAYS emitted (zero as zero);
 *   - the cap-aware line renders when the caller supplies a score result
 *     from the same run, and only then.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck, type GuardrailCheckResult } from '../../src/baseline/check';
import {
  GUARDRAIL_JSON_SCHEMA,
  renderConsole,
  renderJson,
  renderMarkdown,
} from '../../src/baseline/check-renderers';
import type { ImpactScoreInput } from '../../src/baseline/impact';
import type { ClassifiedPair } from '../../src/gate/result';
import type { BaselineEntry, FindingSeverity, FindingStatus } from '../../src/baseline/types';
import { trustedLocalContext } from '../../src/analysis-trust';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-impact-render-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  writeFileSync(join(dir, 'src', 'index.js'), 'module.exports = () => 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

let seq = 0;

/** Synthetic classified pair spread onto the real base result. */
function pair(
  status: FindingStatus,
  over: { kind?: BaselineEntry['kind']; severity?: FindingSeverity; priorId?: string } = {},
): ClassifiedPair {
  seq += 1;
  const matcherStatus = status === 'removed' || status === 'not_observed' ? 'removed' : 'added';
  return {
    pair: {
      ...(matcherStatus === 'removed'
        ? { priorId: over.priorId ?? `prior-${seq}` }
        : { currentId: `current-${seq}` }),
      status: matcherStatus,
      confidence: 1,
      reasons: [],
    },
    classification: { status, blocks: false, warns: false, reasons: [] },
    kind: over.kind ?? 'dep-vuln',
    ...(over.severity !== undefined ? { severity: over.severity } : {}),
  } as unknown as ClassifiedPair;
}

const RESOLVING_PAIRS = [
  pair('removed', { kind: 'dep-vuln', severity: 'high' }),
  pair('removed', { kind: 'dep-vuln', severity: 'high' }),
  pair('removed', { kind: 'dep-vuln', severity: 'medium' }),
];

const CAPPED_SCORE: ImpactScoreInput = {
  dimension: 'security',
  score: 40,
  capsApplied: [
    {
      id: 'secrets-cap',
      tier: 'trust-broken',
      ceiling: 40,
      reason: '8 baseline secrets committed',
      upliftIfRemoved: 25,
    },
  ],
  topActions: [],
};

describe('the Impact section reaches every check surface', () => {
  let base: GuardrailCheckResult;
  let dir: string;

  beforeAll(async () => {
    dir = makeRepo();
    await createBaseline({ cwd: dir });
    base = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('markdown: a resolving change gets the section above the finding tables', () => {
    const md = renderMarkdown({ ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] });
    expect(md).toContain('### Impact');
    expect(md).toContain(
      '-3 findings resolved (dep-vuln: 2 high, 1 medium) · +0 added by this change',
    );
    // Above the fold: before the collapsed Resolved detail.
    expect(md.indexOf('### Impact')).toBeLessThan(md.indexOf('<summary>Resolved'));
  });

  it('markdown: a neutral change gets exactly one quiet line, never a section', () => {
    const md = renderMarkdown(base);
    expect(md).not.toContain('### Impact');
    expect(md).toContain('No debt impact: this change neither resolves nor adds findings.');
  });

  it('markdown: a regressing change with nothing resolved defers to the finding tables', () => {
    const md = renderMarkdown({
      ...base,
      pairs: [...base.pairs, pair('added', { kind: 'code', severity: 'medium' })],
    });
    expect(md).not.toContain('### Impact');
    expect(md).toContain('No findings resolved by this change; the +1 it adds are reported');
  });

  it('markdown: the cap-aware line renders when a same-run score result is supplied', () => {
    const withResolved = { ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] };
    const md = renderMarkdown(withResolved, { impactScores: [CAPPED_SCORE] });
    expect(md).toContain(
      'security stays 40, capped by 8 baseline secrets committed (clearing that unlocks up to 65)',
    );
    // Without a score result the section carries the finding delta alone.
    expect(renderMarkdown(withResolved)).not.toContain('capped by');
  });

  it('markdown: an excluded (not_observed / tooling_drift) pair is disclosed, not counted', () => {
    const md = renderMarkdown({
      ...base,
      pairs: [
        ...base.pairs,
        ...RESOLVING_PAIRS,
        pair('not_observed', { kind: 'custom-check' }),
        pair('tooling_drift', { kind: 'code' }),
      ],
    });
    expect(md).toContain('-3 findings resolved');
    expect(md).toContain(
      'Not counted (cannot attribute to this change): 1 not re-verified this run, 1 tooling drift.',
    );
  });

  it('console: the Impact block renders for a resolving change and not for a neutral one', () => {
    const withResolved = renderConsole({ ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] });
    expect(withResolved).toContain('Impact');
    expect(withResolved).toContain('-3 findings resolved (dep-vuln: 2 high, 1 medium)');
    expect(renderConsole(base)).not.toContain('findings resolved (');
  });

  it('console: the cap-aware line rides the Impact block when scores are supplied', () => {
    const out = renderConsole(
      { ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] },
      { impactScores: [CAPPED_SCORE] },
    );
    expect(out).toContain('security stays 40, capped by 8 baseline secrets committed');
  });

  it('json: the impact field is always present, zero reported as zero', () => {
    const neutral = renderJson(base);
    expect(neutral.impact).toEqual({
      resolved: 0,
      resolvedByKind: [],
      added: 0,
      net: 0,
      excluded: [],
      capNotes: [],
    });
  });

  it('json: a resolving change carries the structured delta and cap notes', () => {
    const json = renderJson(
      { ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] },
      { impactScores: [CAPPED_SCORE] },
    );
    expect(json.impact?.resolved).toBe(3);
    expect(json.impact?.net).toBe(3);
    expect(json.impact?.resolvedByKind).toEqual([
      {
        kind: 'dep-vuln',
        count: 3,
        bySeverity: [
          { severity: 'high', count: 2 },
          { severity: 'medium', count: 1 },
        ],
      },
    ]);
    expect(json.impact?.capNotes).toEqual([
      {
        dimension: 'security',
        score: 40,
        ceiling: 40,
        reason: '8 baseline secrets committed',
        unlocksUpTo: 65,
      },
    ]);
  });

  it('json: the field is additive: schema id and the existing shape are untouched', () => {
    const json = renderJson(base);
    expect(json.schema).toBe(GUARDRAIL_JSON_SCHEMA);
    // The pre-impact contract every embedder reads, unchanged.
    expect(json.verdict).toEqual({ blocks: false, warns: false, refused: false, exitCode: 0 });
    expect(json.summary.resolved).toBe(0);
    expect(Array.isArray(json.pairs)).toBe(true);
    expect(json.attributionGaps).toEqual([]);
    expect(json.requiredNotObserved).toEqual([]);
  });

  it('json: summary.resolved and impact.resolved agree (one resolved concept)', () => {
    const json = renderJson({ ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] });
    expect(json.impact?.resolved).toBe(json.summary.resolved);
  });
});
