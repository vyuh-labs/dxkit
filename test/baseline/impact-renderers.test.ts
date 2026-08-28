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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { deriveImpact } from '../../src/baseline/impact';
import { computeScoreProjection } from '../../src/baseline/impact-projection';
import { SCORING_METHODOLOGY_VERSION } from '../../src/scoring/methodology';
import { findTool, TOOL_DEFS } from '../../src/analyzers/tools/tool-registry';

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

/** A projected outcome (security 40 -> 46 against a comparable snapshot). */
const PROJECTED = computeScoreProjection({
  current: {
    overall: 52,
    security: 46,
    quality: 60,
    tests: 55,
    documentation: 30,
    maintainability: 70,
    developerExperience: 65,
  },
  methodology: SCORING_METHODOLOGY_VERSION,
  history: [
    {
      sha: 'baseentrysha0000',
      date: '2026-08-20T00:00:00.000Z',
      dxkitVersion: '4.4.7',
      methodology: SCORING_METHODOLOGY_VERSION,
      scores: {
        overall: 50,
        security: 40,
        quality: 60,
        tests: 55,
        documentation: 30,
        maintainability: 70,
        developerExperience: 65,
      },
    },
  ],
});

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
    // Above the fold: directly after the summary sentence (which closes the
    // heading block) and before the collapsed Resolved detail. This is the
    // slot the attribution-gap banner also occupies on a refused run, so
    // the position is part of the contract.
    expect(md.indexOf('### Impact')).toBeGreaterThan(md.indexOf('3 resolved.'));
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

  it('markdown: the projection line + hidden marker render inside the section, labeled projected (P2)', () => {
    const withResolved = { ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] };
    const md = renderMarkdown(withResolved, { scoreProjection: PROJECTED });
    expect(md).toContain('security 40 -> 46 (projected)');
    expect(md).toContain('<!-- dxkit-impact-projection ');
    // A non-projected outcome renders its disclosure, and no marker.
    const disclosed = renderMarkdown(withResolved, {
      scoreProjection: { status: 'unavailable', reason: 'no score history on the reports ref yet' },
    });
    expect(disclosed).toContain('scores not projected: no score history');
    expect(disclosed).not.toContain('<!-- dxkit-impact-projection ');
    // Disabled: no line at all, section otherwise intact.
    const off = renderMarkdown(withResolved, {
      scoreProjection: { status: 'disabled', reason: 'impact.projectScores is false' },
    });
    expect(off).toContain('### Impact');
    expect(off).not.toContain('(projected)');
  });

  it('console + json: the projection reaches the other two surfaces (labeled, additive)', () => {
    const withResolved = { ...base, pairs: [...base.pairs, ...RESOLVING_PAIRS] };
    const out = renderConsole(withResolved, { scoreProjection: PROJECTED });
    expect(out).toContain('security 40 -> 46 (projected)');
    const json = renderJson(withResolved, { scoreProjection: PROJECTED });
    expect(json.impact?.projection?.status).toBe('projected');
    // The JSON stays additive: without a projection the field is simply absent.
    expect(renderJson(withResolved).impact?.projection).toBeUndefined();
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
      'Not counted (cannot attribute to this change): 1 not re-verified this run, 1 demoted to tooling drift.',
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
      attributable: true,
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

// A synthetic attribution gap: the shape the refusal tier carries.
const GAP = { kind: 'secret', rules: ['newSecret'], findingCount: 1 };

describe('a refused run (CANNOT GATE) never renders a resolved claim (Rule 19 at run level)', () => {
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

  function refused(): GuardrailCheckResult {
    return {
      ...base,
      pairs: [...base.pairs, ...RESOLVING_PAIRS],
      attributionGaps: [GAP],
    } as unknown as GuardrailCheckResult;
  }

  it('markdown: the one-liner replaces the section, ahead of the gap banner', () => {
    const md = renderMarkdown(refused());
    expect(md).not.toContain('findings resolved');
    expect(md).not.toContain('### Impact');
    expect(md).toContain('Impact not attributable this run');
    // Ordering (the slot contract): after the verdict heading, before the
    // attribution-gap banner it defers to.
    expect(md.indexOf('Impact not attributable')).toBeGreaterThan(md.indexOf('## Guardrail'));
    expect(md.indexOf('Impact not attributable')).toBeLessThan(md.indexOf('Cannot attribute'));
  });

  it('console: same suppression, same one-liner', () => {
    const out = renderConsole(refused());
    expect(out).not.toContain('findings resolved');
    expect(out).toContain('Impact not attributable this run');
  });

  it('json: the impact field carries the counts flagged not attributable', () => {
    const json = renderJson(refused());
    expect(json.impact?.attributable).toBe(false);
    expect(json.impact?.resolved).toBe(3);
    expect(json.verdict.refused).toBe(true);
  });

  it('a missing required observation refuses the same way', () => {
    const req = {
      ...base,
      pairs: [...base.pairs, ...RESOLVING_PAIRS],
      requiredNotObserved: [{ check: 'x', reason: 'check x not observed', remedy: 'run it' }],
    } as unknown as GuardrailCheckResult;
    expect(renderMarkdown(req)).not.toContain('findings resolved');
    expect(renderJson(req).impact?.attributable).toBe(false);
  });
});

describe('the quiet line under unattributable delta pairs (advisory wave, tooling drift)', () => {
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

  it('an advisory wave never reads as "no debt impact" above its own blocking tables', () => {
    const wave = {
      ...base,
      pairs: [
        ...base.pairs,
        pair('newly_published_advisory', { kind: 'dep-vuln', severity: 'high' }),
        pair('newly_published_advisory', { kind: 'dep-vuln', severity: 'high' }),
      ],
    } as unknown as GuardrailCheckResult;
    const md = renderMarkdown(wave);
    expect(md).not.toContain('No debt impact');
    expect(md).toContain('No attributable debt impact; 2 findings could not be attributed');
    expect(md).toContain('from advisories published after baseline capture');
  });

  it('a pure tooling-drift run reads the same honest shape', () => {
    const drift = {
      ...base,
      pairs: [...base.pairs, pair('tooling_drift', { kind: 'code' })],
    } as unknown as GuardrailCheckResult;
    const md = renderMarkdown(drift);
    expect(md).not.toContain('No debt impact');
    expect(md).toContain('No attributable debt impact; 1 finding could not be attributed');
  });
});

// The end-to-end pin for the classifier fix (the removed direction of Rule
// 19): a finding GONE on a kind whose recall drifted must never headline as
// resolved. Needs a real secret scanner: the fixture plants a secret,
// baselines it, deletes it, then strips the baseline's recall so every kind
// drifts (exactly what a pre-Rule-19 baseline looks like).
const gitleaksAvailable = findTool(TOOL_DEFS.gitleaks, process.cwd()).available;
// Assembled at runtime so the dxkit repo's own secret scan never sees an
// AKIA-shaped literal here; the fixture file the test writes carries the
// full value, which is what the fixture's scan must find.
const FAKE_AWS_KEY = ['AKIA', 'Q3EGRI', 'J7MZ4KX2B6'].join('');

describe('a drifted kind cannot headline resolved findings (end to end)', () => {
  it.skipIf(!gitleaksAvailable)(
    'a secret gone under absent recall reads tooling_drift, never "-1 resolved"',
    async () => {
      const dir = makeRepo();
      writeFileSync(
        join(dir, 'src', 'config.js'),
        `const key = '${FAKE_AWS_KEY}';\nmodule.exports = key;\n`,
      );
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'add config']);
      await createBaseline({ cwd: dir });
      // The "fix" that is not a fix: the secret file disappears AND the
      // baseline loses its recall evidence (a pre-Rule-19 baseline).
      rmSync(join(dir, 'src', 'config.js'));
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'drop config']);
      const baselinePath = join(dir, '.dxkit', 'baselines', 'main.json');
      const file = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
      delete file.recall;
      writeFileSync(baselinePath, JSON.stringify(file, null, 2) + '\n');

      const result = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
      const goneSecrets = result.pairs.filter(
        (p) => p.kind === 'secret' && p.pair.currentId === undefined,
      );
      expect(goneSecrets.length).toBeGreaterThan(0);
      // The classifier, not the impact module, makes the call: the pair is
      // tooling_drift with a fixed verdict, so verdictCounts().resolved and
      // impact.resolved agree by construction.
      expect(goneSecrets.every((p) => p.classification.status === 'tooling_drift')).toBe(true);
      expect(goneSecrets.every((p) => !p.classification.blocks && !p.classification.warns)).toBe(
        true,
      );
      const impact = deriveImpact(result);
      expect(impact.resolved).toBe(0);
      expect(impact.excluded.some((e) => e.status === 'tooling_drift')).toBe(true);
      const md = renderMarkdown(result);
      expect(md).not.toMatch(/-\d+ findings? resolved/);
      expect(md).toContain('No attributable debt impact');
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );
});
