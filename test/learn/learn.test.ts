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
import {
  gatherLearnRepoStatus,
  readBaselines,
  type LearnRepoStatus,
} from '../../src/learn/repo-status';
import { runLearn } from '../../src/learn';
import { userCommands, CORE_COMMAND_IDS } from '../../src/discovery/commands';
import { POSTURE_KNOBS } from '../../src/discovery/posture-knobs';
import {
  BASELINE_SCHEMA_VERSION,
  pathForBaseline,
  writeBaselineFile,
  type BaselineFile,
} from '../../src/baseline/baseline-file';

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

  it('carries every posture knob and all ten curated docs with real titles', () => {
    expect(bundle.knobs.length).toBe(POSTURE_KNOBS.length);
    expect(bundle.docs.map((d) => d.slug)).toEqual([
      'how-dxkit-thinks',
      'capabilities-and-limits',
      'quickstart-developer',
      'quickstart-reviewer',
      'quickstart-admin',
      'operating-the-lanes',
      'lane-tokens',
      'gate-embedding',
      'wave-gating',
      'extending-dxkit',
    ]);
    for (const d of bundle.docs) {
      expect(d.title, `${d.slug} packaging stub leaked`).not.toBe(d.slug);
      expect(d.markdown.length).toBeGreaterThan(500);
    }
  });
});

describe('learn page — self-contained + zero-context', () => {
  const bundle = buildLearnBundle();

  it('zero-repo render: full guide, self-contained, zero external loads, no network JS', () => {
    const html = renderLearnHtml(bundle, null);
    for (const id of CORE_COMMAND_IDS) expect(html).toContain(`>${id}</span>`);
    expect(html).toContain('What dxkit verifies, and what it cannot');
    expect(html).toContain('How dxkit thinks');
    // Self-containment: inline assets only — no CDN scripts, no remote
    // styles/fonts/images, no imports. The favicon is a data: URI.
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
    expect(html).not.toMatch(/<(img|iframe)\b/);
    expect(html).not.toMatch(/@import/);
    // The STATIC page's script performs zero network requests (search,
    // theme, copy, nav are pure client-side over embedded data).
    expect(html).not.toMatch(/fetch\(/);
    // Search + theme are present in both modes; the assistant is serve-only.
    expect(html).toContain('palette-input');
    expect(html).toContain('theme-toggle');
    expect(html).toContain('search-index');
    // Wiki mode: routed views (page-per-topic), hash router, crumbs, TOC,
    // prev/next — with graceful no-JS fallback (views hidden only under .spa).
    expect((html.match(/class="view"/g) ?? []).length).toBeGreaterThan(20);
    expect(html).toContain('hashchange');
    expect(html).toContain('id="crumbs"');
    expect(html).toContain('id="pagenav"');
    expect(html).toContain('id="toc"');
    expect(html).toContain('body.spa .view');
    expect(html).not.toContain('id="apanel"');
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
    expect(html).toContain('class="mode">guide<');
    expect(html).toContain('guardrail');
  });
});

describe('baselines — anchor-aware under the branch transport (the external-repo eval catch)', () => {
  function baselineFixture(cwd: string, findingsCount: number, createdAt: string): BaselineFile {
    const findings = Array.from({ length: findingsCount }, (_, i) => ({
      id: `${i}`.padStart(16, 'a'),
      kind: 'secret' as const,
      tool: 'gitleaks',
      rule: 'r',
      file: `src/f${i}.ts`,
      line: 1,
      severity: 'high' as const,
    }));
    return {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      name: 'main',
      createdAt,
      repo: { commitSha: 'a'.repeat(40), branch: 'main', root: cwd },
      analysis: {
        dxkitVersion: '4.3.6',
        policyHash: 'p'.repeat(16),
        ignoreHash: 'i'.repeat(16),
        toolchainHash: 't'.repeat(16),
        configHash: 'c'.repeat(16),
      },
      tools: { gitleaks: 'unknown' },
      saltMode: 'deterministic',
      findings,
    };
  }

  function anchorRepo(): { cwd: string; anchorFile: string } {
    const cwd = tmpdir();
    fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
    );
    // Stale tree copy: 1 finding, old date.
    writeBaselineFile(
      pathForBaseline(cwd, 'main'),
      baselineFixture(cwd, 1, '2026-07-19T00:00:00.000Z'),
    );
    // Fresh anchor content (what the side branch holds): 3 findings, today.
    const anchorFile = path.join(tmpdir(), 'main.json');
    writeBaselineFile(anchorFile, baselineFixture(cwd, 3, '2026-08-03T08:30:00.000Z'));
    return { cwd, anchorFile };
  }

  it('reads the ANCHOR content when reachable — the numbers the guardrail actually gates against', () => {
    const { cwd, anchorFile } = anchorRepo();
    const { summaries, debt } = readBaselines(cwd, () => anchorFile);
    expect(summaries).toEqual([
      { name: 'main', capturedAt: '2026-08-03T08:30:00.000Z', entryCount: 3, source: 'anchor' },
    ]);
    expect(debt!.total).toBe(3);
  });

  it('falls back to the tree copy DISCLOSED when the anchor is unreachable', () => {
    const { cwd } = anchorRepo();
    const { summaries } = readBaselines(cwd, () => null);
    expect(summaries).toEqual([
      { name: 'main', capturedAt: '2026-07-19T00:00:00.000Z', entryCount: 1, source: 'tree' },
    ]);
  });

  it('plain committed transport carries no source (no anchor question asked)', () => {
    const cwd = tmpdir();
    writeBaselineFile(
      pathForBaseline(cwd, 'main'),
      baselineFixture(cwd, 2, '2026-08-01T00:00:00.000Z'),
    );
    const { summaries } = readBaselines(cwd, () => {
      throw new Error('anchor loader must not be called without the branch transport');
    });
    expect(summaries[0].source).toBeUndefined();
    expect(summaries[0].entryCount).toBe(2);
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
      jobs: [
        {
          workflow: 'dxkit-baseline-refresh.yml',
          name: 'dxkit baseline refresh',
          triggers: ['cron 0 6 * * *'],
          nextRunUtc: '2026-08-04 06:00',
          dispatchable: false,
        },
      ],
      profile: {
        graph: {
          functionCount: 2253,
          fileCount: 310,
          callEdgeCount: 9800,
          hubs: [],
          refreshedAt: '2026-08-01T06:00:00.000Z',
          stale: false,
        },
        debt: {
          total: 18928,
          byKind: { code: 18925, secret: 3 },
          bySeverity: { high: 3, medium: 68, unrated: 18857 },
          floorFailing: [],
        },
        health: null,
      },
    };
  }

  it('repo mode lands on the repo HOME dashboard; zero-context lands on the showcase', () => {
    const repo = renderLearnHtml(bundle, syntheticStatus());
    // The home view exists and is the FIRST view in the DOM (router default).
    const firstView = repo.indexOf('<section class="view"');
    expect(repo.slice(firstView, firstView + 120)).toContain('id="home"');
    expect(repo).toContain('grandfathered findings in baseline');
    expect(repo).toContain('dxkit workflows installed');
    // Tier-1 profile tiles: graph size + freshness, debt severity shape.
    expect(repo).toContain('functions in the code graph');
    expect(repo).toContain('refreshed 2026-08-01');
    expect(repo).toContain('3 high · 68 medium');
    // Static page: tiles are plain (no assistant to ask).
    expect(repo).not.toContain('data-q=');
    // Serve mode: every tile is ASKABLE (opens the assistant prefilled).
    const served = renderLearnHtml(bundle, syntheticStatus(), { serve: true, generatedAt: 'x' });
    expect((served.match(/class="stat" data-q=/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(served).toContain('What does our debt look like?');
    // Static repo page carries no serve-only ask button.
    expect(repo).not.toContain('id="home-ask"');
    // Zero-context: no home view, the showcase is first.
    const zero = renderLearnHtml(bundle, null);
    expect(zero).not.toContain('id="home"');
    const zeroFirst = zero.indexOf('<section class="view"');
    expect(zero.slice(zeroFirst, zeroFirst + 120)).toContain('id="core"');
  });

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

  it('escapes repo-derived strings at the render boundary', () => {
    const html = renderLearnHtml(bundle, syntheticStatus());
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is read-only: the one write path is only ever quoted, and static-mode JS never fetches', () => {
    const html = renderLearnHtml(bundle, syntheticStatus());
    expect(html).toContain('configure --apply');
    // No forms, no inline JS handlers; the static page's script makes zero
    // network requests (theme/search/copy/nav only).
    expect(html).not.toMatch(/<form\b/);
    expect(html).not.toMatch(/on(click|submit|load)=/);
    expect(html).not.toMatch(/fetch\(/);
  });
});
