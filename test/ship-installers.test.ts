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
  installPrReview,
  installIgnoreFiles,
  installHooksPostinstall,
  detectDefaultBranch,
} from '../src/ship-installers';

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

  it('force overrides existing devcontainer.json', () => {
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.devcontainer/devcontainer.json'),
      JSON.stringify({ name: 'existing' }),
    );

    const result = installDevcontainer(tmp, { force: true });
    expect(result.installed).toContain('.devcontainer/devcontainer.json');
    const final = fs.readFileSync(path.join(tmp, '.devcontainer/devcontainer.json'), 'utf8');
    expect(final).toContain('dxkit dev environment');
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

  it('leaves existing custom postinstall in place + emits a chain note', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { postinstall: 'husky install' } }, null, 2),
    );
    const result = installHooksPostinstall(tmp);
    expect(result.installed).toEqual([]);
    expect(result.notes.some((n) => n.includes('postinstall preserved'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
    // Original script untouched.
    expect(pkg.scripts.postinstall).toBe('husky install');
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
