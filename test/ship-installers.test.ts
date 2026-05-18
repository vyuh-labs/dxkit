import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installHooks,
  installDevcontainer,
  installCiGuardrails,
  installCiBaselineRefresh,
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

  it('writes hooks in place on a fresh dir', () => {
    const result = installHooks(tmp);
    expect(result.installed).toContain('.githooks/pre-commit');
    expect(result.installed).toContain('.githooks/pre-push');
    expect(result.sidecars).toHaveLength(0);

    expect(fs.existsSync(path.join(tmp, '.githooks/pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.githooks/pre-push'))).toBe(true);

    // Both files should be executable (POSIX-only check)
    if (process.platform !== 'win32') {
      const preCommitMode = fs.statSync(path.join(tmp, '.githooks/pre-commit')).mode;
      expect(preCommitMode & 0o111).not.toBe(0);
    }
  });

  it('writes sidecars when .githooks/pre-commit already exists', () => {
    fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.githooks/pre-commit'), '#!/bin/sh\necho existing\n');
    fs.writeFileSync(path.join(tmp, '.githooks/pre-push'), '#!/bin/sh\necho existing\n');

    const result = installHooks(tmp);
    expect(result.sidecars).toContain('.githooks/pre-commit.dxkit');
    expect(result.sidecars).toContain('.githooks/pre-push.dxkit');
    expect(result.installed).toHaveLength(0);

    // Existing files preserved
    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-commit'), 'utf8')).toContain(
      'echo existing',
    );
    // Sidecars carry dxkit content
    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-commit.dxkit'), 'utf8')).toContain(
      'dxkit pre-commit hook',
    );

    // Merge note surfaced
    expect(result.notes.some((n) => n.includes('sidecar'))).toBe(true);
  });

  it('writes sidecars when .husky/pre-commit exists (husky users)', () => {
    fs.mkdirSync(path.join(tmp, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.husky/pre-commit'), '#!/bin/sh\necho husky\n');

    const result = installHooks(tmp);
    expect(result.sidecars).toContain('.githooks/pre-commit.dxkit');
    // pre-push had no conflict — installed normally
    expect(result.installed).toContain('.githooks/pre-push');
  });

  it('force overrides existing hooks in place', () => {
    fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.githooks/pre-commit'), '#!/bin/sh\necho existing\n');

    const result = installHooks(tmp, { force: true });
    expect(result.installed).toContain('.githooks/pre-commit');
    expect(result.sidecars).not.toContain('.githooks/pre-commit.dxkit');

    expect(fs.readFileSync(path.join(tmp, '.githooks/pre-commit'), 'utf8')).toContain(
      'dxkit pre-commit hook',
    );
  });

  it('always emits the core.hooksPath activate note', () => {
    const result = installHooks(tmp);
    expect(result.notes.some((n) => n.includes('core.hooksPath'))).toBe(true);
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
