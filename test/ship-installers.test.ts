import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  installHooks,
  installDevcontainer,
  installCiGuardrails,
  installCiBaselineRefresh,
  installCiGraphRefresh,
  graphRefreshEnabled,
  installCiReportsRefresh,
  installCiFlowRefresh,
  flowRefreshEnabled,
  reportsRefreshEnabled,
  installPrReview,
  installIgnoreFiles,
  installHooksPostinstall,
  installDxkitDevDependency,
  detectDefaultBranch,
} from '../src/ship-installers';
import { detectInstallFlags, managedGatedArtifacts } from '../src/managed-artifacts';
import { VERSION } from '../src/constants';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

describe('Phase Ship templates exist on disk', () => {
  it('hooks templates are present after build', () => {
    expect(fs.existsSync(path.join(TEMPLATES_DIR, '.githooks', 'pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES_DIR, '.githooks', 'pre-push'))).toBe(true);
  });

  it('devcontainer templates are present after build', () => {
    expect(fs.existsSync(path.join(TEMPLATES_DIR, '.devcontainer', 'devcontainer.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(TEMPLATES_DIR, '.devcontainer', 'post-create.sh'))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES_DIR, '.devcontainer', 'install-agent-clis.sh'))).toBe(
      true,
    );
  });

  it('CI workflow templates are present after build', () => {
    expect(
      fs.existsSync(path.join(TEMPLATES_DIR, '.github', 'workflows', 'dxkit-guardrails.yml')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(TEMPLATES_DIR, '.github', 'workflows', 'dxkit-baseline-refresh.yml')),
    ).toBe(true);
  });
});

describe('installHooks', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ship-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes only pre-push by default (pre-commit is opt-in)', () => {
    const result = installHooks(tmp);
    expect(result.installed).toContain('.githooks/pre-push');
    expect(result.installed).not.toContain('.githooks/pre-commit');
    expect(result.sidecars).toHaveLength(0);

    expect(fs.existsSync(path.join(tmp, '.githooks/pre-push'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.githooks/pre-commit'))).toBe(false);

    if (process.platform !== 'win32') {
      const prePushMode = fs.statSync(path.join(tmp, '.githooks/pre-push')).mode;
      expect(prePushMode & 0o111).not.toBe(0);
    }
  });

  it('writes both hooks when --with-precommit-hook is enabled', () => {
    const result = installHooks(tmp, { withPrecommit: true });
    expect(result.installed).toContain('.githooks/pre-commit');
    expect(result.installed).toContain('.githooks/pre-push');
    expect(result.sidecars).toHaveLength(0);

    expect(fs.existsSync(path.join(tmp, '.githooks/pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.githooks/pre-push'))).toBe(true);
  });

  it('writes sidecars when .githooks/pre-push already exists', () => {
    fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.githooks/pre-push'), '#!/bin/sh\necho existing\n');

    const result = installHooks(tmp);
    expect(result.sidecars).toContain('.githooks/pre-push.dxkit');
    expect(result.installed).toHaveLength(0);

    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-push'), 'utf8')).toContain(
      'echo existing',
    );
    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-push.dxkit'), 'utf8')).toContain(
      'dxkit pre-push hook',
    );
    expect(result.notes.some((n) => n.includes('sidecar'))).toBe(true);
  });

  it('writes pre-commit sidecar when --with-precommit-hook AND .husky/pre-commit exists', () => {
    fs.mkdirSync(path.join(tmp, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.husky/pre-commit'), '#!/bin/sh\necho husky\n');

    const result = installHooks(tmp, { withPrecommit: true });
    expect(result.sidecars).toContain('.githooks/pre-commit.dxkit');
    expect(result.installed).toContain('.githooks/pre-push');
  });

  it('force overrides existing pre-push in place', () => {
    fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.githooks/pre-push'), '#!/bin/sh\necho existing\n');

    const result = installHooks(tmp, { force: true });
    expect(result.installed).toContain('.githooks/pre-push');
    expect(result.sidecars).not.toContain('.githooks/pre-push.dxkit');

    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-push'), 'utf8')).toContain(
      'dxkit pre-push hook',
    );
  });

  it('always emits the core.hooksPath activate note', () => {
    const result = installHooks(tmp);
    expect(result.notes.some((n) => n.includes('core.hooksPath'))).toBe(true);
  });

  it('surfaces opt-in note when pre-commit is omitted (default)', () => {
    const result = installHooks(tmp);
    expect(result.notes.some((n) => n.includes('with-precommit-hook'))).toBe(true);
  });

  it('does NOT surface the opt-in note when pre-commit is installed', () => {
    const result = installHooks(tmp, { withPrecommit: true });
    expect(result.notes.some((n) => n.includes('with-precommit-hook'))).toBe(false);
  });
});

describe('installDevcontainer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ship-dc-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes all three files on a fresh dir', () => {
    const result = installDevcontainer(tmp);
    expect(result.installed).toContain('.devcontainer/devcontainer.json');
    expect(result.installed).toContain('.devcontainer/post-create.sh');
    expect(result.installed).toContain('.devcontainer/install-agent-clis.sh');
    expect(result.sidecars).toHaveLength(0);
  });

  it('writes to .dxkit-reference when devcontainer.json exists', () => {
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.devcontainer/devcontainer.json'),
      JSON.stringify({ name: 'existing' }),
    );

    const result = installDevcontainer(tmp);
    expect(result.installed).toHaveLength(0);
    expect(result.sidecars).toContain('.devcontainer/.dxkit-reference/devcontainer.json');
    expect(result.sidecars).toContain('.devcontainer/.dxkit-reference/post-create.sh');
    expect(result.sidecars).toContain('.devcontainer/.dxkit-reference/install-agent-clis.sh');

    // Original preserved
    const orig = JSON.parse(
      fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8'),
    );
    expect(orig.name).toBe('existing');

    // Merge note
    expect(result.notes.some((n) => n.includes('dxkit-reference'))).toBe(true);
  });

  it('force refreshes a dxkit-OWNED devcontainer.json', () => {
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    // A stale-but-dxkit-marked devcontainer (what a real prior install left).
    fs.writeFileSync(
      path.join(tmp, '.devcontainer/devcontainer.json'),
      JSON.stringify({ name: 'dxkit dev environment', stale: true }),
    );

    const result = installDevcontainer(tmp, { force: true });
    expect(result.installed).toContain('.devcontainer/devcontainer.json');
    const final = fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8');
    expect(final).toContain('dxkit dev environment');
    expect(final).not.toContain('"stale"');
  });

  it('force NEVER overwrites a USER-authored devcontainer.json (#11 data-loss guard)', () => {
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    const userJson = JSON.stringify({ name: 'existing', image: 'custom:latest' });
    fs.writeFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), userJson);

    const result = installDevcontainer(tmp, { force: true });
    // Preserved verbatim; dxkit's version lands only as a sidecar reference.
    expect(fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8')).toBe(
      userJson,
    );
    expect(result.sidecars).toContain('.devcontainer/.dxkit-reference/devcontainer.json');
    expect(result.installed).not.toContain('.devcontainer/devcontainer.json');
  });

  it('renders only Node + GitHub CLI features on an empty (no-stack) repo', () => {
    // No source files, no package.json deps → detect() returns
    // all-false language flags. Even so, dxkit's runtime + gh CLI
    // ship as always-on features.
    const result = installDevcontainer(tmp);
    expect(result.installed).toContain('.devcontainer/devcontainer.json');
    const content = fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8');
    expect(content).toContain('ghcr.io/devcontainers/features/node:1');
    expect(content).toContain('ghcr.io/devcontainers/features/github-cli:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/python:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/dotnet:2');
    expect(content).not.toContain('ghcr.io/devcontainers/features/ruby:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/java:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/rust:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/go:1');
  });

  it('renders only Python + Node + gh CLI on a Python-only repo', () => {
    // requirements.txt is enough to activate the python pack.
    fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'requests==2.0\n');
    fs.writeFileSync(path.join(tmp, 'app.py'), "print('hi')\n");
    const result = installDevcontainer(tmp);
    expect(result.installed).toContain('.devcontainer/devcontainer.json');
    const content = fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8');
    expect(content).toContain('ghcr.io/devcontainers/features/node:1');
    expect(content).toContain('ghcr.io/devcontainers/features/python:1');
    expect(content).toContain('ghcr.io/devcontainers/features/github-cli:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/dotnet:2');
    expect(content).not.toContain('ghcr.io/devcontainers/features/ruby:1');
    expect(content).not.toContain('ghcr.io/devcontainers/features/java:1');
  });

  it('produces JSON that parses cleanly after comment-strip (JSONC contract)', () => {
    installDevcontainer(tmp);
    const content = fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8');
    // Strip // line comments — devcontainer.json is JSONC, but the
    // features block itself is plain JSON, so this minimal scrub is
    // enough to validate structural integrity.
    const stripped = content.replace(/^\s*\/\/.*$/gm, '');
    expect(() => JSON.parse(stripped)).not.toThrow();
    const pkg = JSON.parse(stripped);
    expect(pkg.name).toBe('dxkit dev environment');
    expect(pkg.features).toBeTypeOf('object');
    expect(pkg.features['ghcr.io/devcontainers/features/node:1']).toBeDefined();
  });
});

describe('installCiGuardrails + installCiBaselineRefresh', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ship-ci-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs PR-gate workflow on fresh dir', () => {
    const result = installCiGuardrails(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-guardrails.yml');
  });

  it('installs baseline-refresh workflow on fresh dir', () => {
    const result = installCiBaselineRefresh(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-baseline-refresh.yml');
  });

  it('substitutes the default branch into the guardrail base-ref gate (#118)', () => {
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: tmp });

    installCiGuardrails(tmp);
    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-guardrails.yml'),
      'utf8',
    );
    // Placeholder resolved to the consumer's default branch...
    expect(content).not.toContain('__DXKIT_DEFAULT_BRANCH__');
    expect(content).toContain('DEFAULT_BRANCH="trunk"');
    // ...and the step forces a live ref-based gather at the PR base when the
    // PR targets a NON-default branch (the committed baseline is
    // default-branch-anchored).
    expect(content).toContain('DXKIT_PR_BASE: ${{ github.base_ref }}');
    expect(content).toContain('--mode ref-based --ref origin/$DXKIT_PR_BASE');
  });

  it('installs the graph-refresh workflow with the default branch substituted (#119)', () => {
    execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: tmp });
    const result = installCiGraphRefresh(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-graph-refresh.yml');
    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-graph-refresh.yml'),
      'utf8',
    );
    expect(content).not.toContain('__DXKIT_'); // every placeholder resolved
    expect(content).toContain('branches: [develop]');
    // Caches the graph (never commits it) and rebuilds via `explore refresh`.
    expect(content).toContain('actions/cache/save@v4');
    expect(content).toContain('path: .dxkit/reports/graph.json');
    expect(content).toContain('explore refresh');
  });

  it('graph refresh is opt-in via policy graph.refresh, and gated in the surface registry (#119)', () => {
    // No policy → disabled → surface contributes no uninstall artifact.
    expect(graphRefreshEnabled(tmp)).toBe(false);
    expect(detectInstallFlags(tmp).withGraphRefresh).toBe(false);

    // Opt in via policy → enabled, so `update`/`uninstall` pick it up even
    // before the workflow file exists on disk.
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ graph: { refresh: 'cache' } }),
    );
    expect(graphRefreshEnabled(tmp)).toBe(true);
    const flags = detectInstallFlags(tmp);
    expect(flags.withGraphRefresh).toBe(true);
    expect(managedGatedArtifacts(flags)).toContain('.github/workflows/dxkit-graph-refresh.yml');

    // 'off' is the same as absent.
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ graph: { refresh: 'off' } }),
    );
    expect(graphRefreshEnabled(tmp)).toBe(false);
  });

  it('installs the reports-refresh workflow with the default branch substituted', () => {
    execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: tmp });
    const result = installCiReportsRefresh(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-reports-refresh.yml');
    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-reports-refresh.yml'),
      'utf8',
    );
    expect(content).not.toContain('__DXKIT_'); // every placeholder resolved
    expect(content).toContain('branches: [develop]');
    // Renders the audit, then publishes the snapshot to the dxkit-reports ref.
    expect(content).toContain('report snapshot');
  });

  it('reports refresh is opt-in via policy reports.onMerge, and gated in the surface registry', () => {
    // No policy → disabled → surface contributes no uninstall artifact and the
    // legacy workspace-derived fallback does not stamp the flag.
    expect(reportsRefreshEnabled(tmp)).toBe(false);
    expect(detectInstallFlags(tmp).withReportsRefresh).toBe(false);

    // Opt in via policy → enabled, so `update`/`uninstall` pick it up even
    // before the workflow file exists on disk. This is the seam the init gap
    // left open: the surface + fallback were correct, but init never stamped
    // the flag on a modern manifest, so update silently skipped the workflow.
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ reports: { onMerge: true } }),
    );
    expect(reportsRefreshEnabled(tmp)).toBe(true);
    const flags = detectInstallFlags(tmp);
    expect(flags.withReportsRefresh).toBe(true);
    expect(managedGatedArtifacts(flags)).toContain('.github/workflows/dxkit-reports-refresh.yml');

    // onMerge:false is the same as absent.
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ reports: { onMerge: false } }),
    );
    expect(reportsRefreshEnabled(tmp)).toBe(false);
  });

  it('installs the flow-refresh workflow: default branch substituted, landing via the CLI only', () => {
    execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: tmp });
    const result = installCiFlowRefresh(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-flow-refresh.yml');
    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-flow-refresh.yml'),
      'utf8',
    );
    expect(content).not.toContain('__DXKIT_'); // every placeholder resolved
    expect(content).toContain('branches: [develop]');
    // The landing logic lives in the tested CLI — the workflow is one command,
    // with NO git write logic in its bash (the class-fix from the baseline
    // refresh applies here from day one).
    expect(content).toContain('flow publish --land=policy');
    expect(content).not.toContain('git push');
    expect(content).not.toContain('git commit');
  });

  it('flow refresh is opt-in via policy flow.onMergeRefresh, and gated in the surface registry', () => {
    expect(flowRefreshEnabled(tmp)).toBe(false);
    expect(detectInstallFlags(tmp).withFlowRefresh).toBe(false);

    // Opt in via policy → enabled even before the workflow file exists, so
    // `update` lays it down and `uninstall` removes it (the init-gap seam).
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ flow: { onMergeRefresh: true } }),
    );
    expect(flowRefreshEnabled(tmp)).toBe(true);
    const flags = detectInstallFlags(tmp);
    expect(flags.withFlowRefresh).toBe(true);
    expect(managedGatedArtifacts(flags)).toContain('.github/workflows/dxkit-flow-refresh.yml');

    // onMergeRefresh:false is the same as absent.
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({ flow: { onMergeRefresh: false } }),
    );
    expect(flowRefreshEnabled(tmp)).toBe(false);
  });

  it('skips when workflow file already exists', () => {
    fs.mkdirSync(path.join(tmp, '.github/workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.github/workflows/dxkit-guardrails.yml'),
      '# previous version',
    );

    const result = installCiGuardrails(tmp);
    expect(result.installed).toHaveLength(0);
    expect(result.skipped).toContain('.github/workflows/dxkit-guardrails.yml');

    // Original preserved
    expect(fs.readFileSync(path.join(tmp, '.github/workflows/dxkit-guardrails.yml'), 'utf8')).toBe(
      '# previous version',
    );
  });

  it('substitutes the consumer default branch into baseline-refresh', () => {
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: tmp });

    const result = installCiBaselineRefresh(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-baseline-refresh.yml');

    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-baseline-refresh.yml'),
      'utf8',
    );
    expect(content).toContain('branches: [trunk]');
    expect(content).not.toContain('__DXKIT_DEFAULT_BRANCH__');
    expect(result.notes.some((n) => n.includes("'trunk' branch"))).toBe(true);
  });

  it('falls back to main when default branch cannot be detected', () => {
    // No `git init` in tmp — detection should fall through every probe
    // to the 'main' default.
    const result = installCiBaselineRefresh(tmp);
    const content = fs.readFileSync(
      path.join(tmp, '.github/workflows/dxkit-baseline-refresh.yml'),
      'utf8',
    );
    expect(content).toContain('branches: [main]');
    // Note is only emitted when the detected branch isn't 'main' — quiet path.
    expect(result.notes.every((n) => !n.includes("'main' branch"))).toBe(true);
  });

  it('detectDefaultBranch prefers origin HEAD when available', () => {
    // Build a tiny remote + clone so origin/HEAD is set.
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-upstream-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'release'], { cwd: upstream });
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-clone-'));
    execFileSync('git', ['init', '-q', '-b', 'release'], { cwd: clone });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: clone });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
    fs.writeFileSync(path.join(clone, 'README.md'), 'x');
    execFileSync('git', ['add', '.'], { cwd: clone });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: clone });
    execFileSync('git', ['remote', 'add', 'origin', upstream], { cwd: clone });
    execFileSync('git', ['push', '-q', 'origin', 'release'], { cwd: clone });
    execFileSync('git', ['remote', 'set-head', 'origin', 'release'], { cwd: clone });

    expect(detectDefaultBranch(clone)).toBe('release');

    fs.rmSync(upstream, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('force overrides existing workflow', () => {
    fs.mkdirSync(path.join(tmp, '.github/workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.github/workflows/dxkit-guardrails.yml'),
      '# previous version',
    );

    const result = installCiGuardrails(tmp, { force: true });
    expect(result.installed).toContain('.github/workflows/dxkit-guardrails.yml');
    expect(
      fs.readFileSync(path.join(tmp, '.github/workflows/dxkit-guardrails.yml'), 'utf8'),
    ).toContain('dxkit guardrails');
  });
});

describe('installPrReview', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ship-pr-review-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs pr-review.yml on a fresh dir', () => {
    const result = installPrReview(tmp);
    expect(result.installed).toContain('.github/workflows/pr-review.yml');
    expect(fs.existsSync(path.join(tmp, '.github/workflows/pr-review.yml'))).toBe(true);
  });

  it('surfaces the dormant-until-configured note when installed', () => {
    const result = installPrReview(tmp);
    expect(
      result.notes.some((n) => n.includes('ANTHROPIC_API_KEY') && n.includes('ENABLE_AI_REVIEW')),
    ).toBe(true);
  });

  it('skips when pr-review.yml already exists (additive)', () => {
    fs.mkdirSync(path.join(tmp, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.github/workflows/pr-review.yml'), '# existing');
    const result = installPrReview(tmp);
    expect(result.skipped).toContain('.github/workflows/pr-review.yml');
    expect(result.installed).toHaveLength(0);
  });
});

describe('installIgnoreFiles', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ignore-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates .gitignore + .dxkit-ignore on a fresh dir', () => {
    const result = installIgnoreFiles(tmp);
    expect(result.installed).toContain('.gitignore');
    expect(result.installed).toContain('.dxkit-ignore');

    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
    expect(gi).toContain('.dxkit/reports/');
    expect(gi).toContain('.dxkit/dashboard.html');
    // Defensive: graphify's on-disk cache is redirected to /tmp at
    // runtime, but the ignore entry catches any reappearance (older
    // dxkit versions, future graphify code paths) before it lands
    // in a customer commit.
    expect(gi).toContain('graphify-out/');
    // Selective: baselines stay tracked (they're the guardrail anchor)
    expect(gi).not.toContain('.dxkit/baselines');
    expect(gi).not.toContain('.dxkit/\n'); // no broad .dxkit/ exclude

    const dki = fs.readFileSync(path.join(tmp, '.dxkit-ignore'), 'utf-8');
    expect(dki).toContain('extra paths dxkit');
    expect(dki).toContain('vendor/');
  });

  it('appends to existing .gitignore (additive, dedup)', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/\n.env\n');
    const result = installIgnoreFiles(tmp);
    expect(result.installed).toContain('.gitignore');

    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
    expect(gi).toContain('node_modules/'); // preserved
    expect(gi).toContain('.env'); // preserved
    expect(gi).toContain('.dxkit/reports/'); // appended
  });

  it('skips .gitignore append when the dxkit block is already present', () => {
    fs.writeFileSync(
      path.join(tmp, '.gitignore'),
      'node_modules/\n\n# dxkit — runtime outputs (analyzer reports + dashboard)\n.dxkit/reports/\n',
    );
    const result = installIgnoreFiles(tmp);
    expect(result.skipped).toContain('.gitignore');
  });

  it('never overwrites existing .dxkit-ignore unless --force', () => {
    fs.writeFileSync(path.join(tmp, '.dxkit-ignore'), '# custom\nmy-vendor/\n');
    const result = installIgnoreFiles(tmp);
    expect(result.skipped).toContain('.dxkit-ignore');

    const dki = fs.readFileSync(path.join(tmp, '.dxkit-ignore'), 'utf-8');
    expect(dki).toContain('my-vendor/'); // user content preserved
    expect(dki).not.toContain('extra paths dxkit'); // template NOT installed
  });

  it('force overwrites existing .dxkit-ignore', () => {
    fs.writeFileSync(path.join(tmp, '.dxkit-ignore'), '# custom\nmy-vendor/\n');
    const result = installIgnoreFiles(tmp, { force: true });
    expect(result.installed).toContain('.dxkit-ignore');

    const dki = fs.readFileSync(path.join(tmp, '.dxkit-ignore'), 'utf-8');
    expect(dki).toContain('extra paths dxkit'); // template installed
  });
});

describe('installHooksPostinstall', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-postinstall-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('skips cleanly when no package.json exists (non-Node repo)', () => {
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('adds scripts.postinstall when package.json has no scripts block', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toContain('package.json (postinstall)');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.scripts.postinstall).toBe('vyuh-dxkit hooks activate');
  });

  it('adds scripts.postinstall when scripts exists but postinstall is absent', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }, null, 2),
    );
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toContain('package.json (postinstall)');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.scripts.postinstall).toBe('vyuh-dxkit hooks activate');
    // Preserves existing scripts
    expect(pkg.scripts.test).toBe('vitest');
  });

  it('is idempotent: re-running skips when scripts.postinstall already has our command', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
    installHooksPostinstall(tmp);
    const result = installHooksPostinstall(tmp);
    expect(result.skipped).toContain('package.json (postinstall)');
    expect(result.installed).toEqual([]);
  });

  it('chains after an existing custom postinstall (exit-0-safe activate)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { postinstall: 'husky install' } }, null, 2),
    );
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toContain('package.json (postinstall)');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    // Existing command preserved, our activation appended with &&.
    expect(pkg.scripts.postinstall).toBe('husky install && vyuh-dxkit hooks activate');
  });

  it('is idempotent on a previously-chained postinstall', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify(
        { name: 'demo', scripts: { postinstall: 'husky install && vyuh-dxkit hooks activate' } },
        null,
        2,
      ),
    );
    const result = installHooksPostinstall(tmp);
    expect(result.skipped).toContain('package.json (postinstall)');
    expect(result.installed).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    // No double-append.
    expect(pkg.scripts.postinstall).toBe('husky install && vyuh-dxkit hooks activate');
  });

  it('handles a malformed package.json without crashing', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not valid json');
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toEqual([]);
    expect(result.notes.some((n) => n.includes('not valid JSON'))).toBe(true);
  });

  it('preserves trailing newline on the original package.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo' }, null, 2) + '\n',
    );
    installHooksPostinstall(tmp);
    const written = fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
  });
});

describe('installDxkitDevDependency', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-devdep-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('skips cleanly when no package.json exists (non-Node repo)', () => {
    const result = installDxkitDevDependency(tmp);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('adds dxkit to devDependencies pinned to the running version', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
    const result = installDxkitDevDependency(tmp);
    expect(result.installed).toContain('package.json (devDependencies)');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies['@vyuhlabs/dxkit']).toBe(`^${VERSION}`);
  });

  it('preserves an existing devDependencies block + other deps', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { vitest: '^3.0.0' } }, null, 2),
    );
    installDxkitDevDependency(tmp);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies.vitest).toBe('^3.0.0');
    expect(pkg.devDependencies['@vyuhlabs/dxkit']).toBe(`^${VERSION}`);
  });

  it('skips when dxkit is already in devDependencies (preserves the consumer pin)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { '@vyuhlabs/dxkit': '2.5.0' } }, null, 2),
    );
    const result = installDxkitDevDependency(tmp);
    expect(result.skipped).toContain('package.json (devDependencies)');
    expect(result.installed).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies['@vyuhlabs/dxkit']).toBe('2.5.0');
  });

  it('skips when dxkit is in (runtime) dependencies — never moves or duplicates it', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { '@vyuhlabs/dxkit': '2.5.0' } }, null, 2),
    );
    const result = installDxkitDevDependency(tmp);
    expect(result.skipped).toContain('package.json (devDependencies)');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies).toBeUndefined();
  });

  it('handles a malformed package.json without crashing', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not valid json');
    const result = installDxkitDevDependency(tmp);
    expect(result.installed).toEqual([]);
    expect(result.notes.some((n) => n.includes('not valid JSON'))).toBe(true);
  });

  it('preserves trailing newline on the original package.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo' }, null, 2) + '\n',
    );
    installDxkitDevDependency(tmp);
    const written = fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
  });
});
