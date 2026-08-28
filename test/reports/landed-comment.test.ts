/**
 * The post-merge landed update (impact surface P2): the reports lane patches
 * the merged PR's EXISTING guardrail comment with actual-vs-projected scores.
 *
 * Pins:
 *   - ONE comment identity: the updater finds the comment by the SAME marker
 *     literal the guardrail workflow template writes (parity-pinned against
 *     the template so the identities cannot fork), and PATCHes it in place;
 *   - calibration honesty: the updated comment carries the actual labeled
 *     actual beside the original projection ("projection was P"); with no
 *     projection marker, actual only; zero movement reported as zero;
 *   - idempotence: a re-run replaces the landed section, never stacks;
 *   - degradation: no merged PR, no guardrail comment, or a token without
 *     `pull-requests: write` each produce a disclosed skip, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GUARDRAIL_COMMENT_MARKER,
  IMPACT_LANDED_MARKER,
  renderLandedSection,
  updateLandedComment,
  type GhExec,
} from '../../src/reports/landed-comment';
import {
  computeScoreProjection,
  impactProjectionMarker,
} from '../../src/baseline/impact-projection';
import { SCORING_METHODOLOGY_VERSION } from '../../src/scoring/methodology';
import type { ReportHistoryEntry, ReportScores } from '../../src/reports/history';

function scores(overrides: Partial<ReportScores> = {}): ReportScores {
  return {
    overall: 50,
    security: 40,
    quality: 60,
    tests: 55,
    documentation: 30,
    maintainability: 70,
    developerExperience: 65,
    ...overrides,
  };
}

function entry(overrides: Partial<ReportHistoryEntry> = {}): ReportHistoryEntry {
  return {
    sha: 'feedfacefeedface',
    date: '2026-08-27T00:00:00.000Z',
    dxkitVersion: '4.4.7',
    methodology: SCORING_METHODOLOGY_VERSION,
    scores: scores(),
    ...overrides,
  };
}

/** A guardrail PR comment body carrying a projection for security 40 -> 46. */
function guardrailCommentBody(): string {
  const projection = computeScoreProjection({
    current: scores({ security: 46 }),
    methodology: SCORING_METHODOLOGY_VERSION,
    history: [entry({ sha: 'baseentrysha0000' })],
  });
  const marker = impactProjectionMarker(projection);
  return `${GUARDRAIL_COMMENT_MARKER}\n### dxkit guardrails\n\nsecurity 40 -> 46 (projected)\n${marker}\n`;
}

/** Injected gh spy: routes api paths to canned JSON, records PATCH bodies. */
function ghSpy(fixtures: {
  pulls?: unknown;
  comments?: unknown;
  patchError?: string;
  pullsError?: string;
}): { exec: GhExec; patched: string[] } {
  const patched: string[] = [];
  const exec: GhExec = (args, opts) => {
    const joined = args.join(' ');
    if (joined.includes('/commits/')) {
      if (fixtures.pullsError) throw new Error(fixtures.pullsError);
      return JSON.stringify(fixtures.pulls ?? []);
    }
    if (joined.includes('-X PATCH')) {
      if (fixtures.patchError) throw new Error(fixtures.patchError);
      patched.push(opts?.input ?? '');
      return '';
    }
    if (joined.includes('/comments')) {
      return JSON.stringify(fixtures.comments ?? []);
    }
    throw new Error(`unexpected gh call: ${joined}`);
  };
  return { exec, patched };
}

describe('comment-identity parity with the workflow templates', () => {
  const templates = join(__dirname, '..', '..', 'src-templates', '.github', 'workflows');

  it('the guardrail template writes the SAME marker literal the updater searches for', () => {
    const yml = readFileSync(join(templates, 'dxkit-guardrails.yml'), 'utf8');
    expect(yml).toContain(`MARKER='${GUARDRAIL_COMMENT_MARKER}'`);
  });

  it('the reports template grants pull-requests: write and passes --pr-comment', () => {
    const yml = readFileSync(join(templates, 'dxkit-reports-refresh.yml'), 'utf8');
    expect(yml).toContain('pull-requests: write');
    expect(yml).toContain('report snapshot --pr-comment');
    expect(yml).toContain('GH_TOKEN');
  });
});

describe('renderLandedSection', () => {
  const prev = entry({ sha: 'baseentrysha0000' });

  it('actual beside the original projection, flat dimensions folded, overall named', () => {
    const cur = entry({ scores: scores({ security: 46, overall: 52 }) });
    const projection = {
      methodology: SCORING_METHODOLOGY_VERSION,
      scores: { security: { from: 40, to: 46 } },
    };
    const section = renderLandedSection(cur, prev, projection);
    expect(section).toContain(IMPACT_LANDED_MARKER);
    expect(section).toContain('security 40 -> 46 (actual; projection was 46)');
    expect(section).toContain('other dimensions unchanged');
    expect(section).toContain('Repo overall: 50 -> 52.');
  });

  it('a flat actual against a moving projection is listed (the calibration signal)', () => {
    const cur = entry({ scores: scores() }); // security stayed 40
    const projection = {
      methodology: SCORING_METHODOLOGY_VERSION,
      scores: { security: { from: 40, to: 46 } },
    };
    const section = renderLandedSection(cur, prev, projection);
    expect(section).toContain('security 40 -> 40 (actual; projection was 46)');
  });

  it('absent projection => actual only; zero movement reported as zero', () => {
    const section = renderLandedSection(entry(), prev, null);
    expect(section).toContain('scores unchanged (actual)');
    expect(section).not.toContain('projection was');
  });

  it('score-input drift across snapshots is disclosed, never diffed (Rule 19 cause 5)', () => {
    const section = renderLandedSection(
      entry({ scoreInputs: ['!gitleaks', 'grep-secrets', 'semgrep'] }),
      entry({ sha: 'baseentrysha0000', scoreInputs: ['gitleaks', 'semgrep'] }),
      null,
    );
    expect(section).toContain('not comparable across these snapshots');
    expect(section).toContain('gitleaks');
    expect(section).not.toContain('(actual');
  });

  it('a projected dimension unmeasured at merge keeps its calibration line', () => {
    const cur = entry({ scores: scores({ tests: null, security: 46, overall: 52 }) });
    const projection = {
      methodology: SCORING_METHODOLOGY_VERSION,
      scores: { security: { from: 40, to: 46 }, tests: { from: 55, to: 60 } },
    };
    const section = renderLandedSection(cur, prev, projection);
    expect(section).toContain('security 40 -> 46 (actual; projection was 46)');
    expect(section).toContain('tests not measured at merge (projection was 60)');
  });

  it('a methodology mismatch across snapshots is disclosed, never diffed', () => {
    const section = renderLandedSection(entry(), entry({ methodology: 'spec-v0' }), null);
    expect(section).toContain('not comparable across these snapshots');
    expect(section).toContain("'spec-v0'");
    expect(section).not.toContain('(actual');
  });

  it('the first snapshot on record says so instead of inventing a delta', () => {
    const section = renderLandedSection(entry(), undefined, null);
    expect(section).toContain('First score snapshot on record');
    expect(section).toContain('(overall 50)');
  });
});

describe('updateLandedComment', () => {
  const inputs = (exec: GhExec) => ({
    slug: 'acme/widgets',
    sha: 'feedfacefeedface',
    entry: entry({ scores: scores({ security: 46, overall: 52 }) }),
    prev: entry({ sha: 'baseentrysha0000' }),
    exec,
  });

  it('patches the SAME guardrail comment: actual + the original projection, marker retained', () => {
    const { exec, patched } = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [
        { id: 7, body: 'someone elses comment' },
        { id: 9, body: guardrailCommentBody() },
      ],
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome).toEqual({ status: 'updated', prNumber: 41 });
    expect(patched).toHaveLength(1);
    const body = patched[0]!;
    // Same identity: the guardrail marker still leads the body.
    expect(body.startsWith(GUARDRAIL_COMMENT_MARKER)).toBe(true);
    // The original projection line and its machine marker survive.
    expect(body).toContain('security 40 -> 46 (projected)');
    expect(body).toContain('<!-- dxkit-impact-projection ');
    // The landed section carries actual + the projection it calibrates.
    expect(body).toContain('security 40 -> 46 (actual; projection was 46)');
  });

  it('a re-run replaces the landed section instead of stacking a second one', () => {
    const first = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [{ id: 9, body: guardrailCommentBody() }],
    });
    updateLandedComment(inputs(first.exec));
    const second = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [{ id: 9, body: first.patched[0]! }],
    });
    updateLandedComment(inputs(second.exec));
    const body = second.patched[0]!;
    expect(body.split(IMPACT_LANDED_MARKER)).toHaveLength(2);
    expect(body.split('### Landed')).toHaveLength(2);
  });

  it('absent projection marker => actual-only landed line', () => {
    const { exec, patched } = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [{ id: 9, body: `${GUARDRAIL_COMMENT_MARKER}\nplain report\n` }],
    });
    updateLandedComment(inputs(exec));
    expect(patched[0]).toContain('security 40 -> 46 (actual)');
    expect(patched[0]).not.toContain('projection was');
  });

  it('the merge-commit match wins over listing order (rebase flows list several PRs)', () => {
    const { exec, patched } = ghSpy({
      pulls: [
        {
          number: 7,
          merge_commit_sha: 'someothersha0000',
          merged_at: '2026-08-27T00:00:00Z',
          base: { ref: 'main', repo: { default_branch: 'main' } },
        },
        { number: 41, merge_commit_sha: 'feedfacefeedface' },
      ],
      comments: [{ id: 9, body: guardrailCommentBody() }],
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome).toEqual({ status: 'updated', prNumber: 41 });
    expect(patched).toHaveLength(1);
  });

  it('without a merge-commit match, two merged default-branch candidates => disclosed ambiguous skip', () => {
    const candidate = (n: number) => ({
      number: n,
      merge_commit_sha: 'someothersha0000',
      merged_at: '2026-08-27T00:00:00Z',
      base: { ref: 'main', repo: { default_branch: 'main' } },
    });
    const { exec, patched } = ghSpy({
      pulls: [candidate(7), candidate(8)],
      comments: [{ id: 9, body: guardrailCommentBody() }],
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('ambiguous pull-request association');
    expect(patched).toHaveLength(0);
  });

  it('without a merge-commit match, exactly ONE merged default-branch candidate is accepted', () => {
    const { exec, patched } = ghSpy({
      pulls: [
        {
          number: 7,
          merge_commit_sha: 'someothersha0000',
          merged_at: '2026-08-27T00:00:00Z',
          base: { ref: 'main', repo: { default_branch: 'main' } },
        },
        { number: 8, merge_commit_sha: 'unrelatedsha0000' },
      ],
      comments: [{ id: 9, body: guardrailCommentBody() }],
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome).toEqual({ status: 'updated', prNumber: 7 });
    expect(patched).toHaveLength(1);
  });

  it('the cron re-publish with drifted score inputs => disclosed skip, comment untouched', () => {
    // Same merged sha, but the scheduled re-run scored under different
    // tooling (gitleaks gone, the grep fallback engaged): the landed line
    // must not be rewritten with movement the PR never caused.
    let ghCalls = 0;
    const exec: GhExec = () => {
      ghCalls += 1;
      throw new Error('gh must not be called on a drifted-inputs skip');
    };
    const outcome = updateLandedComment({
      slug: 'acme/widgets',
      sha: 'feedfacefeedface',
      entry: entry({
        scores: scores({ security: 12, overall: 30 }),
        scoreInputs: ['!gitleaks', 'grep-secrets', 'semgrep'],
      }),
      prev: entry({ sha: 'baseentrysha0000', scoreInputs: ['gitleaks', 'semgrep'] }),
      exec,
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('gitleaks');
    expect(outcome.reason).toContain('tooling drift');
    expect(ghCalls).toBe(0);
  });

  it('no merged PR for the sha => disclosed skip', () => {
    const { exec } = ghSpy({ pulls: [] });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('no merged pull request');
  });

  it('no guardrail comment on the PR => disclosed skip', () => {
    const { exec } = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [{ id: 7, body: 'hi' }],
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('no dxkit guardrail comment');
  });

  it('a PATCH refusal (missing pull-requests: write) => disclosed skip naming the scope, never a throw', () => {
    const { exec } = ghSpy({
      pulls: [{ number: 41, merge_commit_sha: 'feedfacefeedface' }],
      comments: [{ id: 9, body: guardrailCommentBody() }],
      patchError: 'HTTP 403: Resource not accessible by integration',
    });
    const outcome = updateLandedComment(inputs(exec));
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('403');
    expect(outcome.reason).toContain('pull-requests: write');
  });
});
