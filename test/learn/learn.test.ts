/**
 * The learn page contract (issue #244):
 *   - the bundle is registry-driven (every user-facing command, core tier
 *     first) + the five curated docs;
 *   - ZERO-CONTEXT mode is first-class: an empty directory renders the full
 *     guide with no repo reads and no throw;
 *   - the page is fully self-contained: no <script>, no external loads;
 *   - repo mode renders the doctor-derived setup panel READ-ONLY, with
 *     repo-derived strings escaped.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildLearnBundle } from '../../src/learn/bundle';
import { renderLearnHtml } from '../../src/learn/render';
import { gatherLearnRepoStatus, type LearnRepoStatus } from '../../src/learn/repo-status';
import { runLearn } from '../../src/learn';
import { userCommands, CORE_COMMAND_IDS } from '../../src/discovery/commands';
import { POSTURE_KNOBS } from '../../src/discovery/posture-knobs';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-learn-'));
}

describe('learn bundle — registry-driven, cannot drift', () => {
  const bundle = buildLearnBundle();

  it('contains every user-facing command exactly once, core tier first', () => {
    const ids = bundle.capabilities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of userCommands()) {
      expect(ids, `bundle missing ${c.id}`).toContain(c.id);
    }
    expect(ids.slice(0, CORE_COMMAND_IDS.length)).toEqual([...CORE_COMMAND_IDS]);
    for (const cap of bundle.capabilities.slice(0, CORE_COMMAND_IDS.length)) {
      expect(cap.tier).toBe('core');
    }
  });

  it('carries every posture knob and all five curated docs with real titles', () => {
    expect(bundle.knobs.length).toBe(POSTURE_KNOBS.length);
    expect(bundle.docs.map((d) => d.slug)).toEqual([
      'how-dxkit-thinks',
      'capabilities-and-limits',
      'quickstart-developer',
      'quickstart-reviewer',
      'quickstart-admin',
    ]);
    for (const d of bundle.docs) {
      expect(d.title, `${d.slug} packaging stub leaked`).not.toBe(d.slug);
      expect(d.markdown.length).toBeGreaterThan(500);
    }
  });
});

describe('learn page — self-contained + zero-context', () => {
  const bundle = buildLearnBundle();

  it('zero-repo render: full guide, no scripts, no external loads', () => {
    const html = renderLearnHtml(bundle, null);
    for (const id of CORE_COMMAND_IDS) expect(html).toContain(`>${id}</span>`);
    expect(html).toContain('What dxkit verifies, and what it cannot');
    expect(html).toContain('How dxkit thinks');
    // Self-containment: no JS at all in this increment, no remote fetches.
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<(link|img|iframe)\b/);
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/@import/);
    // No repo section without a repo.
    expect(html).not.toContain('Set up this repo');
  });

  it('gatherLearnRepoStatus returns null in an empty directory (never throws)', async () => {
    expect(await gatherLearnRepoStatus(tmpdir())).toBeNull();
  });

  it('runLearn in an empty directory writes the zero-context page', async () => {
    const dir = tmpdir();
    const result = await runLearn(dir);
    expect(result.repoMode).toBe(false);
    expect(result.outputPath).toBe(path.join(dir, 'dxkit-learn.html'));
    const html = fs.readFileSync(result.outputPath, 'utf-8');
    expect(html).toContain('capability guide');
    expect(html).toContain('guardrail');
  });
});

describe('learn page — repo mode renders doctor as a read-only setup panel', () => {
  const bundle = buildLearnBundle();

  function syntheticStatus(): LearnRepoStatus {
    return {
      cwd: '/repo',
      installed: true,
      doctor: {
        schema: 'doctor.v1',
        generatedAt: '2026-08-02T00:00:00.000Z',
        cwd: '/repo',
        checks: [
          { label: 'git', ok: true, tier: 'reports' },
          {
            label:
              "lane PRs cannot be opened — 'Allow GitHub Actions to create and approve pull requests' is off",
            ok: false,
            tier: 'operational',
            fix: {
              hint: 'Enable the setting under Settings, Actions, General.',
              command:
                'gh api -X PUT repos/{owner}/{repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true',
            },
          },
          {
            label: 'evil <script>alert(1)</script> label',
            ok: false,
            tier: 'operational',
            fix: { hint: 'escape <me> & "you"', command: 'echo "<x>"' },
          },
        ],
        recommendations: [
          {
            id: 'baseline',
            recommendation: {
              reason: '4 ungated checks found',
              command: 'vyuh-dxkit baseline create',
            },
          },
        ],
        summary: {
          reports: { pass: 1, fail: 0, status: 'ok' },
          dx: { pass: 0, fail: 0, status: 'ok' },
          operational: { pass: 0, fail: 2, status: 'fail' },
          fixable: [],
        },
      },
      policy: {
        preset: 'security-only',
        checksCount: 2,
        lintEnabled: true,
        lanes: ['baseline refresh'],
      },
      baselines: [{ name: 'main', capturedAt: '2026-08-01T06:00:00Z', entryCount: 18928 }],
      lastVerdict: null,
    };
  }

  it('renders the requirements checklist with remedies as copy-paste commands', () => {
    const html = renderLearnHtml(bundle, syntheticStatus());
    expect(html).toContain('Set up this repo');
    expect(html).toContain('Allow GitHub Actions to create and approve pull requests');
    expect(html).toContain('can_approve_pull_request_reviews=true');
    expect(html).toContain('4 ungated checks found');
    expect(html).toContain('baseline create');
    expect(html).toContain('security-only');
    expect(html).toContain('18928 grandfathered findings');
  });

  it('escapes repo-derived strings and stays script-free', () => {
    const html = renderLearnHtml(bundle, syntheticStatus());
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
  });

  it('is read-only: the one write path is only ever quoted', () => {
    const html = renderLearnHtml(bundle, syntheticStatus());
    expect(html).toContain('configure --apply');
    // No forms, no buttons, no JS handlers anywhere on the page.
    expect(html).not.toMatch(/<(form|button|input)\b/);
    expect(html).not.toMatch(/on(click|submit|load)=/);
  });
});
