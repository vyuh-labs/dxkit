/**
 * The generated devcontainer scripts, EXECUTED (4.5.0 pins). The scripts run
 * against stub `npm` / `vyuh-dxkit` / agent-CLI binaries on an isolated PATH,
 * so the test observes what the scripts actually install and how they exit,
 * not what their text looks like:
 *
 *   - the agent CLIs install at the pinned versions; `skip` and an exact
 *     override are honoured; an install that fails or lands at the wrong
 *     version fails the script (it used to warn and exit 0);
 *   - dxkit is installed globally at exactly the generating version, a global
 *     at another version is replaced, and a project-local devDependency is
 *     preferred and linked onto PATH;
 *   - post-create runs EVERY step, prints one NOT READY summary listing each
 *     failure, writes the readiness record doctor reads, and exits non-zero;
 *     a fully provisioned environment exits 0 with `ready: true`;
 *   - dxkit's git hooks are activated, and a hook that stays inactive is a
 *     failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_CLI_PINS } from '../src/agent-cli-pins';
import { VERSION } from '../src/constants';
import { installDevcontainer } from '../src/ship-installers';
import {
  DEVCONTAINER_READINESS_RECORD,
  describeDevcontainerReadiness,
  readDevcontainerReadiness,
} from '../src/devcontainer-readiness';

/** git env for the sandbox repo: never the ambient GIT_DIR / GIT_WORK_TREE a
 *  hook exports, which would point these commands at dxkit's own repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

const CLAUDE = AGENT_CLI_PINS.find((p) => p.bin === 'claude')!;
const CODEX = AGENT_CLI_PINS.find((p) => p.bin === 'codex')!;

/** A stub dxkit CLI at `version`: `--version`, `tools install` (fails when
 *  STUB_TOOLS_FAIL=1), `hooks activate` (a no-op when STUB_HOOKS_NOOP=1),
 *  `install classify`; every call is logged. */
function dxkitStub(version: string): string {
  return [
    '#!/bin/bash',
    'echo "dxkit $*" >> "$STUB_LOG"',
    'case "$1" in',
    `  --version) echo "${version}" ;;`,
    '  tools) [ "${STUB_TOOLS_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;',
    '  hooks) [ "${STUB_HOOKS_NOOP:-0}" = 1 ] || git config --local core.hooksPath .githooks; exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
}

/** A stub npm: `prefix -g`, `install -g <pkg>@<v>` (writes a stub binary
 *  reporting <v>; fails for a spec starting with STUB_NPM_FAIL; reports a
 *  wrong version for the bin named in STUB_WRONG_VERSION), `ci`/`install`
 *  (exit STUB_NPM_CI_CODE). Every call is logged. */
const NPM_STUB = `#!/bin/bash
echo "npm $*" >> "$STUB_LOG"
if [ "$1" = prefix ]; then echo "$STUB_GLOBAL"; exit 0; fi
if [ "$1" = install ] && [ "$2" = -g ]; then
  spec="$3"
  if [ -n "\${STUB_NPM_FAIL:-}" ] && [[ "$spec" == "$STUB_NPM_FAIL"* ]]; then exit 1; fi
  name="\${spec%@*}"; ver="\${spec##*@}"
  case "$name" in
    @anthropic-ai/claude-code) bin=claude; out="$ver (Claude Code)" ;;
    @openai/codex) bin=codex; out="codex-cli $ver" ;;
    @vyuhlabs/dxkit)
      "$STUB_DIR/make-dxkit" "$ver" "$STUB_GLOBAL/bin/vyuh-dxkit"; exit 0 ;;
    *) exit 1 ;;
  esac
  [ "\${STUB_WRONG_VERSION:-}" = "$bin" ] && out="9.9.9"
  printf '#!/bin/bash\\necho "%s"\\n' "$out" > "$STUB_GLOBAL/bin/$bin"
  chmod +x "$STUB_GLOBAL/bin/$bin"
  exit 0
fi
if [ "$1" = ci ] || [ "$1" = install ]; then exit "\${STUB_NPM_CI_CODE:-0}"; fi
exit 0
`;

interface Sandbox {
  root: string;
  repo: string;
  stubs: string;
  global: string;
  log: string;
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-postcreate-'));
  const repo = path.join(root, 'repo');
  const stubs = path.join(root, 'stubs');
  const global = path.join(root, 'global');
  fs.mkdirSync(repo);
  fs.mkdirSync(stubs);
  fs.mkdirSync(path.join(global, 'bin'), { recursive: true });
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  const write = (name: string, body: string): void => {
    fs.writeFileSync(path.join(stubs, name), body, { mode: 0o755 });
  };
  write('npm', NPM_STUB);
  write('corepack', '#!/bin/bash\nexit 0\n');
  // python3 with pip + venv (what the always-on python feature provides);
  // STUB_PY_FAIL=1 is a container built from an older devcontainer.json.
  write('python3', '#!/bin/bash\n[ "${STUB_PY_FAIL:-0}" = 1 ] && exit 1\nexit 0\n');
  // make-dxkit <version> <dest>: the stub generator, callable from the npm stub.
  write(
    'make-dxkit',
    `#!/bin/bash\ncat > "$2" <<'EOF'\n${dxkitStub('__V__')}EOF\nsed -i "s/__V__/$1/" "$2"\nchmod +x "$2"\n`,
  );
  // Real node and git, without the rest of their directories (which may hold
  // a real claude / codex / vyuh-dxkit that would leak into the sandbox).
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: GIT_ENV });
  return { root, repo, stubs, global, log };
}

function run(
  sb: Sandbox,
  script: 'post-create.sh' | 'install-agent-clis.sh',
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string; calls: string[] } {
  const r = spawnSync('bash', [path.join('.devcontainer', script)], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: {
      HOME: sb.root,
      PATH: `${sb.stubs}:${path.join(sb.global, 'bin')}:/usr/bin:/bin`,
      STUB_LOG: sb.log,
      STUB_GLOBAL: sb.global,
      STUB_DIR: sb.stubs,
      // What the rendered devcontainer.json's containerEnv sets.
      DISABLE_AUTOUPDATER: '1',
      DXKIT_CONTAINER_CONTRACT: '1',
      ...env,
    },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean),
  };
}

describe.skipIf(process.platform === 'win32')('generated devcontainer scripts (executed)', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox();
    installDevcontainer(sb.repo);
  });
  afterEach(() => {
    fs.rmSync(sb.root, { recursive: true, force: true });
  });

  describe('install-agent-clis.sh', () => {
    it('installs both CLIs at the pinned versions', () => {
      const r = run(sb, 'install-agent-clis.sh');
      expect(r.code).toBe(0);
      expect(r.calls).toContain(`npm install -g ${CLAUDE.package}@${CLAUDE.version}`);
      expect(r.calls).toContain(`npm install -g ${CODEX.package}@${CODEX.version}`);
    });

    it('honours skip and an exact override', () => {
      const r = run(sb, 'install-agent-clis.sh', {
        CLAUDE_CODE_VERSION: 'skip',
        CODEX_VERSION: '0.1.2',
      });
      expect(r.code).toBe(0);
      expect(r.calls.some((c) => c.includes(CLAUDE.package))).toBe(false);
      expect(r.calls).toContain(`npm install -g ${CODEX.package}@0.1.2`);
    });

    it('a CLI already at the pinned version is not reinstalled; one at another version is', () => {
      fs.writeFileSync(
        path.join(sb.global, 'bin', 'claude'),
        `#!/bin/bash\necho "${CLAUDE.version} (Claude Code)"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(sb.global, 'bin', 'codex'),
        '#!/bin/bash\necho "codex-cli 0.0.1"\n',
        {
          mode: 0o755,
        },
      );
      const r = run(sb, 'install-agent-clis.sh');
      expect(r.code).toBe(0);
      expect(r.calls.some((c) => c.includes(CLAUDE.package))).toBe(false);
      expect(r.calls).toContain(`npm install -g ${CODEX.package}@${CODEX.version}`);
    });

    it('a failed install fails the script (no warn-and-succeed)', () => {
      const r = run(sb, 'install-agent-clis.sh', { STUB_NPM_FAIL: CODEX.package });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('FAIL: OpenAI Codex CLI');
      // The other CLI still installed: one failure does not stop the rest.
      expect(r.calls).toContain(`npm install -g ${CLAUDE.package}@${CLAUDE.version}`);
    });

    it('a CLI that prints the pinned version but exits non-zero is not "installed"', () => {
      fs.writeFileSync(
        path.join(sb.global, 'bin', 'claude'),
        `#!/bin/bash\necho "${CLAUDE.version} (Claude Code)"\nexit 3\n`,
        { mode: 0o755 },
      );
      const r = run(sb, 'install-agent-clis.sh');
      expect(r.calls).toContain(`npm install -g ${CLAUDE.package}@${CLAUDE.version}`);
      expect(r.code).toBe(0);
    });

    it('an install that lands at the wrong version fails the script', () => {
      const r = run(sb, 'install-agent-clis.sh', { STUB_WRONG_VERSION: 'claude' });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`reports 9.9.9, not the requested ${CLAUDE.version}`);
    });
  });

  describe('post-create.sh', () => {
    it('a fully provisioned non-Node repo is READY: pinned dxkit, tools, hooks, agents', () => {
      fs.mkdirSync(path.join(sb.repo, '.githooks'));
      fs.writeFileSync(path.join(sb.repo, '.githooks', 'pre-push'), '#!/bin/sh\n');
      const r = run(sb, 'post-create.sh');
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('environment READY');
      expect(r.calls).toContain(`npm install -g @vyuhlabs/dxkit@${VERSION}`);
      expect(r.calls).toContain('dxkit tools install --yes --fail-on-missing');
      expect(r.calls).toContain('dxkit hooks activate');
      expect(
        execFileSync('git', ['config', '--local', 'core.hooksPath'], {
          cwd: sb.repo,
          encoding: 'utf8',
          env: GIT_ENV,
        }).trim(),
      ).toBe('.githooks');
      const record = readDevcontainerReadiness(sb.repo);
      expect(record).toMatchObject({
        ready: true,
        generatedBy: VERSION,
        dxkit: VERSION,
        failures: [],
      });
    });

    it('a global dxkit at another version is replaced with the pinned one, never reused', () => {
      fs.writeFileSync(path.join(sb.global, 'bin', 'vyuh-dxkit'), dxkitStub('1.0.0'), {
        mode: 0o755,
      });
      const r = run(sb, 'post-create.sh');
      expect(r.code).toBe(0);
      expect(r.calls).toContain(`npm install -g @vyuhlabs/dxkit@${VERSION}`);
      expect(r.stdout).toContain(`global dxkit is 1.0.0; installing the pinned ${VERSION}`);
    });

    it('a project-local dxkit devDependency is preferred and linked onto PATH', () => {
      fs.writeFileSync(path.join(sb.repo, 'package.json'), '{"name":"app","private":true}\n');
      fs.writeFileSync(path.join(sb.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
      fs.mkdirSync(path.join(sb.repo, 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(
        path.join(sb.repo, 'node_modules', '.bin', 'vyuh-dxkit'),
        dxkitStub('7.7.7'),
        {
          mode: 0o755,
        },
      );
      const r = run(sb, 'post-create.sh');
      expect(r.code).toBe(0);
      expect(r.calls).toContain('npm ci');
      expect(r.calls.some((c) => c.startsWith('npm install -g @vyuhlabs/dxkit'))).toBe(false);
      expect(fs.realpathSync(path.join(sb.global, 'bin', 'vyuh-dxkit'))).toBe(
        fs.realpathSync(path.join(sb.repo, 'node_modules', '.bin', 'vyuh-dxkit')),
      );
      // A devDependency at another version is the repo's choice: noted, not a failure.
      expect(r.stdout).toContain(`generated by dxkit ${VERSION}`);
      expect(readDevcontainerReadiness(sb.repo)).toMatchObject({ ready: true, dxkit: '7.7.7' });
    });

    it('every step runs and every failure is reported: NOT READY, exit 1, recorded', () => {
      fs.writeFileSync(path.join(sb.repo, 'package.json'), '{"name":"app","private":true}\n');
      fs.writeFileSync(path.join(sb.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
      fs.mkdirSync(path.join(sb.repo, '.githooks'));
      fs.writeFileSync(path.join(sb.repo, '.githooks', 'pre-push'), '#!/bin/sh\n');
      const r = run(sb, 'post-create.sh', {
        STUB_NPM_CI_CODE: '1',
        STUB_TOOLS_FAIL: '1',
        STUB_HOOKS_NOOP: '1',
        STUB_NPM_FAIL: CODEX.package,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('environment NOT READY (4 step(s) failed)');
      for (const step of ['project dependencies', 'scanner toolchain', 'git hooks', 'agent CLIs']) {
        expect(r.stderr, step).toContain(`x ${step}:`);
      }
      // The steps after the first failure still ran.
      expect(r.calls).toContain(`npm install -g ${CLAUDE.package}@${CLAUDE.version}`);
      const record = readDevcontainerReadiness(sb.repo);
      expect(record?.ready).toBe(false);
      expect(record?.failures.map((f) => f.step)).toEqual([
        'project dependencies',
        'scanner toolchain',
        'git hooks',
        'agent CLIs',
      ]);
      for (const f of record?.failures ?? []) expect(f.remedy.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(sb.repo, DEVCONTAINER_READINESS_RECORD))).toBe(true);
    });

    it('a devDependency OLDER than the generating dxkit is a failure', () => {
      fs.writeFileSync(path.join(sb.repo, 'package.json'), '{"name":"app","private":true}\n');
      fs.writeFileSync(path.join(sb.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
      fs.mkdirSync(path.join(sb.repo, 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(
        path.join(sb.repo, 'node_modules', '.bin', 'vyuh-dxkit'),
        dxkitStub('0.0.1'),
        {
          mode: 0o755,
        },
      );
      const r = run(sb, 'post-create.sh');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `x dxkit: the project's devDependency is dxkit 0.0.1, older than the ${VERSION}`,
      );
    });

    it('another vyuh-dxkit earlier on PATH than the linked devDependency is a failure', () => {
      fs.writeFileSync(path.join(sb.repo, 'package.json'), '{"name":"app","private":true}\n');
      fs.writeFileSync(path.join(sb.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
      fs.mkdirSync(path.join(sb.repo, 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(
        path.join(sb.repo, 'node_modules', '.bin', 'vyuh-dxkit'),
        dxkitStub('7.7.7'),
        {
          mode: 0o755,
        },
      );
      // Same version, different binary, ahead of npm's global bin on PATH.
      fs.writeFileSync(path.join(sb.stubs, 'vyuh-dxkit'), dxkitStub('7.7.7'), { mode: 0o755 });
      const r = run(sb, 'post-create.sh');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('x dxkit on PATH:');
    });

    it('a container built from an older devcontainer.json is reported with the remedy, as advice', () => {
      // The upgrade path: `update` refreshed the scripts but kept the older
      // devcontainer.json, so this is an EXISTING install. It must keep
      // working as before: every failure is still reported and recorded,
      // but post-create does not fail the container set-up.
      const r = run(sb, 'post-create.sh', {
        DISABLE_AUTOUPDATER: '',
        DXKIT_CONTAINER_CONTRACT: '',
        STUB_PY_FAIL: '1',
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('environment NOT READY');
      expect(r.stderr).toContain('built from an older devcontainer.json');
      const record = readDevcontainerReadiness(sb.repo);
      expect(record?.ready).toBe(false);
      expect(record?.advisory).toBe(true);
      expect(describeDevcontainerReadiness(record!)).toContain('advice only');
      expect(r.stderr).toContain('x devcontainer.json: DISABLE_AUTOUPDATER is not set');
      expect(r.stderr).toContain('python3 lacks pip or venv');
      expect(r.stderr).toContain('.dxkit-reference/devcontainer.json');
      // Not a configuration failure when Claude Code is not installed at all.
      const skipped = run(sb, 'post-create.sh', {
        DISABLE_AUTOUPDATER: '',
        CLAUDE_CODE_VERSION: 'skip',
      });
      expect(skipped.code).toBe(0);
    });

    it('advice never masks a failure in a container built from the current devcontainer.json', () => {
      // Same scanner failure, current container: strict.
      const r = run(sb, 'post-create.sh', { STUB_TOOLS_FAIL: '1' });
      expect(r.code).toBe(1);
      expect(r.stderr).not.toContain('built from an older devcontainer.json');
      // A CURRENT container whose python or autoupdater setting is broken is
      // not mistaken for an older one: the build-time marker decides, never
      // the runtime probes.
      const broken = run(sb, 'post-create.sh', {
        DISABLE_AUTOUPDATER: '',
        STUB_PY_FAIL: '1',
        STUB_TOOLS_FAIL: '1',
      });
      expect(broken.code).toBe(1);
      expect(broken.stderr).toContain('x devcontainer.json:');
      expect(broken.stderr).not.toContain('built from an older devcontainer.json');
    });

    it('an older container is advisory even when its runtime probes happen to pass', () => {
      const r = run(sb, 'post-create.sh', { DXKIT_CONTAINER_CONTRACT: '', STUB_TOOLS_FAIL: '1' });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('x scanner toolchain:');
      expect(r.stderr).toContain('built from an older devcontainer.json');
      expect(readDevcontainerReadiness(sb.repo)?.advisory).toBe(true);
    });

    it('dxkit unavailable at the pinned version is a failure, and the steps needing it say so', () => {
      const r = run(sb, 'post-create.sh', { STUB_NPM_FAIL: '@vyuhlabs/dxkit' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`x dxkit: dxkit ${VERSION} is not on PATH`);
      expect(r.stderr).toContain('x scanner toolchain: not installed: no runnable dxkit');
    });
  });
});
