/**
 * The generated devcontainer pins what it installs (4.5.0 pins).
 *
 *   - Agent CLIs: `AGENT_CLI_PINS` is the one source of truth, every pin an
 *     exact `x.y.z` (never `latest`, a range, a tag or a pre-release), and
 *     the rendered `install-agent-clis.sh` carries exactly those pins as the
 *     per-container override defaults.
 *   - dxkit itself: the rendered `post-create.sh` names the dxkit version
 *     that generated it, and every generated global install of dxkit
 *     (`NO_MANIFEST_INSTALL`, the devcontainer, doctor's hint) is pinned.
 *   - `update` delivers new pins: a dxkit-owned devcontainer's scripts are
 *     refreshed in place without --force; an edited devcontainer.json is
 *     kept and the new render lands beside it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_CLI_PINS, EXACT_VERSION, renderAgentCliInstallCalls } from '../src/agent-cli-pins';
import { dxkitGlobalInstallCommand, dxkitPackageSpec } from '../src/dxkit-package';
import { NO_MANIFEST_INSTALL, INSTALL_OUTCOME_RECORD } from '../src/install';
import { DEVCONTAINER_READINESS_RECORD } from '../src/devcontainer-readiness';
import { VERSION } from '../src/constants';
import {
  installCiHostGates,
  installDevcontainer,
  installGuardrailEntryPoint,
  installHooks,
  renderDevcontainerScript,
  templatesDir,
} from '../src/ship-installers';
import { requiredToolsStillMissing } from '../src/tools-cli';
import type { ToolStatus } from '../src/analyzers/tools/tool-registry';

const SRC_TEMPLATES = path.join(__dirname, '..', 'src-templates', '.devcontainer');

describe('agent CLI pins', () => {
  it('every pin is an exact x.y.z version', () => {
    expect(AGENT_CLI_PINS.length).toBeGreaterThan(0);
    for (const pin of AGENT_CLI_PINS) {
      expect(pin.version, `${pin.package}`).toMatch(EXACT_VERSION);
    }
  });

  it('the exactness check rejects latest, ranges, tags and pre-releases', () => {
    for (const bad of [
      'latest',
      'next',
      '^2.1.0',
      '~2.1.0',
      '>=2.1.0',
      '2.1',
      '2.1.x',
      '2.1.0-beta.1',
      '*',
      '',
    ]) {
      expect(EXACT_VERSION.test(bad), bad).toBe(false);
    }
    expect(EXACT_VERSION.test('2.1.327')).toBe(true);
  });

  it('pins are well-formed and their override variables are distinct', () => {
    const envs = AGENT_CLI_PINS.map((p) => p.versionEnv);
    expect(new Set(envs).size).toBe(envs.length);
    for (const p of AGENT_CLI_PINS) {
      expect(p.package).toMatch(/^@?[a-z0-9-]+(\/[a-z0-9-]+)?$/);
      expect(p.versionEnv).toMatch(/^[A-Z][A-Z0-9_]*_VERSION$/);
      expect(p.bin).toMatch(/^[a-z0-9-]+$/);
    }
    // The documented overrides keep their names.
    expect(envs).toEqual(expect.arrayContaining(['CLAUDE_CODE_VERSION', 'CODEX_VERSION']));
  });

  it('the template carries no version of its own (the pins are rendered in)', () => {
    const template = fs.readFileSync(path.join(SRC_TEMPLATES, 'install-agent-clis.sh'), 'utf8');
    expect(template).not.toMatch(/:-latest/);
    expect(template).not.toMatch(/_VERSION:-\d/);
    expect(template).toContain('__DXKIT_AGENT_CLI_INSTALLS__');
  });

  it('the rendered script installs exactly the pinned versions, overridable per container', () => {
    const rendered = renderDevcontainerScript(
      path.join(templatesDir(), '.devcontainer'),
      'install-agent-clis.sh',
      os.tmpdir(),
    );
    expect(rendered).not.toContain('__DXKIT_');
    expect(rendered).not.toMatch(/latest/);
    for (const p of AGENT_CLI_PINS) {
      expect(rendered).toContain(`"\${${p.versionEnv}:-${p.version}}" "${p.package}" ${p.bin}`);
    }
    expect(renderAgentCliInstallCalls().split('\n')).toHaveLength(AGENT_CLI_PINS.length);
  });
});

describe('dxkit installs itself at the version that generated the files', () => {
  it('the global install spec is the running version', () => {
    expect(dxkitPackageSpec()).toBe(`@vyuhlabs/dxkit@${VERSION}`);
    expect(dxkitGlobalInstallCommand()).toBe(`npm install -g @vyuhlabs/dxkit@${VERSION}`);
    expect(dxkitPackageSpec('0.0.0')).toBe('@vyuhlabs/dxkit');
  });

  it('the CI install chain no-manifest fallback is pinned', () => {
    expect(NO_MANIFEST_INSTALL).toBe(dxkitGlobalInstallCommand());
  });

  it('the rendered post-create carries the pin, the record paths and the CI install chain', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pins-pc-'));
    try {
      const rendered = renderDevcontainerScript(
        path.join(templatesDir(), '.devcontainer'),
        'post-create.sh',
        repo,
      );
      expect(rendered).not.toContain('__DXKIT_');
      expect(rendered).toContain(`DXKIT_VERSION="${VERSION}"`);
      expect(rendered).toContain(`READINESS_RECORD="${DEVCONTAINER_READINESS_RECORD}"`);
      expect(rendered).toContain(INSTALL_OUTCOME_RECORD);
      // The one install renderer, not an inline ladder.
      expect(rendered).toContain('dxkit_install()');
      expect(rendered).not.toMatch(/npm install \|\| npm install --legacy-peer-deps/);
      // No unpinned dxkit install anywhere in the script.
      expect(rendered).not.toMatch(/npm install -g @vyuhlabs\/dxkit(\s|$|")/m);
      // Honest exit: no blanket WARN-and-continue on a step.
      expect(rendered).not.toMatch(/\|\| echo "WARN/);
      expect(rendered).not.toMatch(/set -e[uo]/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('installDevcontainer refresh (update delivers new pins)', () => {
  let tmp: string;
  const dc = (f: string): string => path.join(tmp, '.devcontainer', f);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pins-dc-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a fresh install writes the pinned scripts executable', () => {
    installDevcontainer(tmp);
    const clis = fs.readFileSync(dc('install-agent-clis.sh'), 'utf8');
    for (const p of AGENT_CLI_PINS) expect(clis).toContain(`${p.versionEnv}:-${p.version}`);
    if (process.platform !== 'win32') {
      expect(fs.statSync(dc('post-create.sh')).mode & 0o111).not.toBe(0);
    }
  });

  it('a plain re-run (update, no --force) refreshes stale dxkit scripts in place', () => {
    installDevcontainer(tmp);
    // What a pre-4.5.0 install left: the unpinned script.
    fs.writeFileSync(
      dc('install-agent-clis.sh'),
      '#!/usr/bin/env bash\n# pair with dxkit\nCLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"\n',
    );
    fs.writeFileSync(dc('post-create.sh'), '#!/usr/bin/env bash\necho "==> dxkit post-create"\n');

    const result = installDevcontainer(tmp);
    expect(result.installed).toEqual(
      expect.arrayContaining([
        '.devcontainer/install-agent-clis.sh',
        '.devcontainer/post-create.sh',
      ]),
    );
    expect(fs.readFileSync(dc('install-agent-clis.sh'), 'utf8')).not.toContain(':-latest');
    expect(fs.readFileSync(dc('post-create.sh'), 'utf8')).toContain(`DXKIT_VERSION="${VERSION}"`);
    // The unchanged devcontainer.json is a no-op, and no reference dir appears.
    expect(result.skipped).toContain('.devcontainer/devcontainer.json');
    expect(fs.existsSync(dc('.dxkit-reference'))).toBe(false);
  });

  it('a second plain run is a no-op', () => {
    installDevcontainer(tmp);
    const result = installDevcontainer(tmp);
    expect(result.installed).toEqual([]);
    expect(result.sidecars).toEqual([]);
  });

  it('an edited dxkit devcontainer.json is kept; the current render lands beside it', () => {
    installDevcontainer(tmp);
    const edited = fs
      .readFileSync(dc('devcontainer.json'), 'utf8')
      .replace('"forwardPorts": []', '"forwardPorts": [3000]');
    fs.writeFileSync(dc('devcontainer.json'), edited);
    const result = installDevcontainer(tmp);
    expect(fs.readFileSync(dc('devcontainer.json'), 'utf8')).toBe(edited);
    expect(result.sidecars).toContain('.devcontainer/.dxkit-reference/devcontainer.json');
    expect(result.notes.some((n) => n.includes('update --force'))).toBe(true);
  });

  it('a script the user replaced (no dxkit marker) is kept and the render goes to a sidecar', () => {
    installDevcontainer(tmp);
    fs.writeFileSync(dc('post-create.sh'), '#!/usr/bin/env bash\necho mine\n');
    const result = installDevcontainer(tmp);
    expect(fs.readFileSync(dc('post-create.sh'), 'utf8')).toBe('#!/usr/bin/env bash\necho mine\n');
    expect(result.sidecars).toContain('.devcontainer/post-create.sh.dxkit');
  });

  it('a user-owned devcontainer gets the rendered (pinned) scripts in the reference dir', () => {
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(dc('devcontainer.json'), JSON.stringify({ name: 'mine' }));
    installDevcontainer(tmp, { force: true });
    const ref = fs.readFileSync(dc('.dxkit-reference/install-agent-clis.sh'), 'utf8');
    expect(ref).not.toContain('__DXKIT_');
    for (const p of AGENT_CLI_PINS) expect(ref).toContain(`${p.versionEnv}:-${p.version}`);
    expect(fs.readFileSync(dc('.dxkit-reference/post-create.sh'), 'utf8')).not.toContain(
      '__DXKIT_',
    );
  });

  it('the rendered devcontainer.json disables the Claude Code self-updater', () => {
    installDevcontainer(tmp);
    const json = JSON.parse(
      fs.readFileSync(dc('devcontainer.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    );
    expect(json.containerEnv).toEqual({ DISABLE_AUTOUPDATER: '1' });
  });
});

describe('tools install --fail-on-missing (the post-create scanner step)', () => {
  const status = (name: string, layer: string, installScope?: string): ToolStatus =>
    ({
      name,
      available: false,
      path: null,
      version: null,
      source: 'missing',
      requirement: { name, layer, installScope, for: 'all' },
    }) as unknown as ToolStatus;

  it('counts a required dxkit-provisioned tool that did not install', () => {
    const missing = [
      status('semgrep', 'universal'),
      status('graphify', 'optional'),
      status('eslint', 'language', 'project-local'),
      status('gitleaks', 'universal'),
      status('npm-audit', 'language'),
    ];
    const results = [
      { name: 'semgrep', status: 'failed' as const, msg: 'pipx missing' },
      { name: 'graphify', status: 'failed' as const, msg: 'venv missing' },
      { name: 'eslint', status: 'skipped' as const, msg: 'project-local' },
      { name: 'gitleaks', status: 'installed' as const },
      { name: 'npm-audit', status: 'skipped' as const, msg: 'builtin' },
    ];
    // Optional and project-local tools never fail the environment; installed
    // and builtin ones are present.
    expect(requiredToolsStillMissing(missing, results)).toEqual(['semgrep']);
  });

  it('nothing missing is an empty list', () => {
    expect(requiredToolsStillMissing([], [])).toEqual([]);
  });
});

describe('no generated template installs an unpinned dxkit', () => {
  const TEMPLATES_ROOT = path.join(__dirname, '..', 'src-templates');
  /** Every template file, recursively (not a list: a new template is covered). */
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(dir, e.name);
      return e.isDirectory() ? walk(abs) : [abs];
    });
  }
  // An npm/pnpm/yarn/bun install naming the dxkit package with no version.
  const UNPINNED_INSTALL =
    /\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|i|add)\b[^\n]*@vyuhlabs\/dxkit(?![-@\w])/;
  // Markdown templates are prose an agent or human reads (skills, AGENTS.md):
  // they describe bootstrapping and upgrades, where "the latest dxkit" is the
  // intended instruction. Everything else a repo executes is scanned.
  const isProse = (f: string): boolean => /\.md(\.template)?$/.test(f);

  it('every executable template names dxkit through the spec placeholder', () => {
    const files = walk(TEMPLATES_ROOT).filter((f) => !isProse(f));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (UNPINNED_INSTALL.test(line))
            offenders.push(`${path.relative(TEMPLATES_ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the scan bites on the shapes it guards', () => {
    for (const bad of [
      'npm install -g @vyuhlabs/dxkit',
      'npm install --no-save @vyuhlabs/dxkit >/dev/null 2>&1',
      'echo "Install it with: npm install --save-dev @vyuhlabs/dxkit" >&2',
      'pnpm add -D @vyuhlabs/dxkit',
    ]) {
      expect(UNPINNED_INSTALL.test(bad), bad).toBe(true);
    }
    for (const ok of [
      `npm install -g @vyuhlabs/dxkit@${VERSION}`,
      'npm install --save-dev @vyuhlabs/dxkit-sdk',
      'npm install -g __DXKIT_PACKAGE_SPEC__',
    ]) {
      expect(UNPINNED_INSTALL.test(ok), ok).toBe(false);
    }
  });

  it('the hooks and the entry point they run render the pinned spec (no placeholder left)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pins-hooks-'));
    try {
      installHooks(repo, { withPrecommit: true });
      for (const hook of ['pre-push', 'pre-commit']) {
        const content = fs.readFileSync(path.join(repo, '.githooks', hook), 'utf8');
        expect(content, hook).not.toContain('__DXKIT_');
      }
      // The hooks resolve dxkit through dxkit-guardrails.sh, which carries the
      // install hint.
      installGuardrailEntryPoint(repo);
      const entry = fs.readFileSync(path.join(repo, 'dxkit-guardrails.sh'), 'utf8');
      expect(entry).not.toContain('__DXKIT_');
      expect(entry).toContain(`npm install --save-dev @vyuhlabs/dxkit@${VERSION}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the per-host gate workflow installs the pinned dxkit', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pins-hostgate-'));
    try {
      fs.writeFileSync(
        path.join(repo, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>',
      );
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(
        path.join(repo, 'src', 'Main.cs'),
        'class Program { static void Main() {} }',
      );
      installCiHostGates(repo, {});
      const content = fs.readFileSync(
        path.join(repo, '.github', 'workflows', 'dxkit-gate-windows.yml'),
        'utf8',
      );
      expect(content).not.toContain('__DXKIT_');
      expect(content).toContain(`npm install -g @vyuhlabs/dxkit@${VERSION}`);
      expect(content).not.toMatch(UNPINNED_INSTALL);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
