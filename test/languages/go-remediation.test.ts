/**
 * The go remediation capabilities (4.4.7 V3): the module-path rail, the
 * v-tolerant pin-version grammar (pseudo-versions included), the pin plan
 * as a pure decision over real go.mod fixtures (applied / refused /
 * adversarial), and the install strategy's declared commands. No network,
 * no spawns: everything here is the pure half of the seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { goRemediation, isValidGoModulePath } from '../../src/languages/go-remediation';
import { goInstallStrategy } from '../../src/languages/go-install';
import { pickPinVersion } from '../../src/remediate/recipes/shared';
import type { PinTransitiveProvider } from '../../src/languages/capabilities/remediation';

const pin = (goRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider;

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function rootWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-go-remediation-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const GO_MOD = `module example.com/app

go 1.22

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgolang.org/x/text v0.3.7 // indirect
)
`;

function planAt(goMod: string, pkg = 'golang.org/x/text', version = '0.3.8') {
  return pin.plan({ cwd: rootWith({ 'go.mod': goMod }), rootDir: '', pkg, version });
}

describe('the go module-path rail (Rule 11)', () => {
  it('accepts real module paths, refuses injection and query shapes', () => {
    expect(isValidGoModulePath('golang.org/x/text')).toBe(true);
    expect(isValidGoModulePath('github.com/Sirupsen/logrus')).toBe(true);
    expect(isValidGoModulePath('gopkg.in/yaml.v3')).toBe(true);
    expect(isValidGoModulePath('-flag')).toBe(false);
    expect(isValidGoModulePath('--registry=https://evil')).toBe(false);
    expect(isValidGoModulePath('a b')).toBe(false);
    expect(isValidGoModulePath('example.com/x/...')).toBe(false);
    expect(isValidGoModulePath('./relative')).toBe(false);
    expect(isValidGoModulePath('example.com//x')).toBe(false);
    expect(isValidGoModulePath('')).toBe(false);
  });
});

describe('the go pin-version grammar (v-tolerant semver + pseudo-versions)', () => {
  const scheme = pin.versions!;

  it('bare and v-prefixed semver are both concrete; ranges and wildcards refuse', () => {
    expect(scheme.concrete('0.3.8')).toBe(true);
    expect(scheme.concrete('v0.3.8')).toBe(true);
    expect(scheme.concrete('v1.2.3+incompatible')).toBe(true);
    expect(scheme.concrete('v0.0.0-20240101000000-abcdefabcdef')).toBe(true);
    expect(scheme.concrete('>=0.3.8')).toBe(false);
    expect(scheme.concrete('v1.x')).toBe(false);
    expect(scheme.concrete('latest')).toBe(false);
  });

  it('orders across the v prefix and by pseudo-version timestamp', () => {
    expect(pickPinVersion(['v0.3.8', '0.3.9'], scheme)).toBe('0.3.9');
    expect(
      pickPinVersion(
        ['v0.0.0-20230101000000-aaaaaaaaaaaa', 'v0.0.0-20240601000000-bbbbbbbbbbbb'],
        scheme,
      ),
    ).toBe('v0.0.0-20240601000000-bbbbbbbbbbbb');
    // A release outranks the pseudo-versions of its prerelease line.
    expect(pickPinVersion(['v0.3.8', 'v0.3.8-0.20240101000000-abcdefabcdef'], scheme)).toBe(
      'v0.3.8',
    );
  });
});

describe('the go pin plan (a pure command decision over go.mod)', () => {
  it('plans the tool-owned pin: go get pkg@vX.Y.Z, writing go.mod + go.sum', () => {
    const plan = planAt(GO_MOD);
    expect(plan.kind).toBe('command');
    if (plan.kind !== 'command') return;
    expect(plan.command).toEqual({ bin: 'go', args: ['get', 'golang.org/x/text@v0.3.8'] });
    expect(plan.writes).toEqual(['go.mod', 'go.sum']);
    expect(plan.revert).toContain('go mod tidy');
  });

  it('keeps an already v-prefixed version verbatim', () => {
    const plan = planAt(GO_MOD, 'golang.org/x/text', 'v0.3.8');
    expect(plan.kind).toBe('command');
    if (plan.kind !== 'command') return;
    expect(plan.command.args).toEqual(['get', 'golang.org/x/text@v0.3.8']);
  });

  it('refuses a DIRECT requirement (block and one-line forms); an indirect one pins', () => {
    const direct = planAt(GO_MOD, 'github.com/gin-gonic/gin', '1.9.2');
    expect(direct.kind).toBe('refused');
    if (direct.kind === 'refused') expect(direct.reason).toContain('direct requirement');
    const oneLine = planAt(
      'module example.com/app\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      'github.com/gin-gonic/gin',
      '1.9.2',
    );
    expect(oneLine.kind).toBe('refused');
    // The indirect entry is exactly what the pin serves.
    expect(planAt(GO_MOD).kind).toBe('command');
  });

  it('refuses a module under a replace directive (the replacement wins)', () => {
    const replaced = planAt(
      GO_MOD + '\nreplace golang.org/x/text => ../local-text\n',
      'golang.org/x/text',
      '0.3.8',
    );
    expect(replaced.kind).toBe('refused');
    if (replaced.kind === 'refused') expect(replaced.reason).toContain('replace directive');
    const blockReplaced = planAt(
      GO_MOD + '\nreplace (\n\tgolang.org/x/text => example.com/fork v0.0.1\n)\n',
    );
    expect(blockReplaced.kind).toBe('refused');
  });

  it('refuses injection-shaped tokens before any argv exists, and a missing go.mod', () => {
    expect(planAt(GO_MOD, '--registry=evil', '0.3.8').kind).toBe('refused');
    expect(planAt(GO_MOD, 'golang.org/x/text', '0.3.8 --something').kind).toBe('refused');
    const noMod = pin.plan({
      cwd: rootWith({}),
      rootDir: '',
      pkg: 'golang.org/x/text',
      version: '0.3.8',
    });
    expect(noMod.kind).toBe('refused');
  });
});

describe('the go install strategy (the resync + sync-check spine)', () => {
  it('declares the module commands: frozen download, tidy resync, tidy -diff check', () => {
    const dir = rootWith({ 'go.mod': GO_MOD });
    const strategy = goInstallStrategy.strategy(dir)!;
    expect(strategy.manager).toBe('gomod');
    expect(strategy.lockfile).toBe('go.sum');
    expect(strategy.modes.frozen.primary).toEqual({ bin: 'go', args: ['mod', 'download'] });
    expect(strategy.modes.resync?.primary).toEqual({ bin: 'go', args: ['mod', 'tidy'] });
    expect(strategy.syncCheck?.kind).toBe('command');
    if (strategy.syncCheck?.kind === 'command') {
      expect(strategy.syncCheck.command.args).toEqual(['mod', 'tidy', '-diff']);
      // A rejected -diff flag (an EOL toolchain) is named, never read as drift.
      expect(
        strategy.syncCheck.classifyFailure?.('flag provided but not defined: -diff'),
      ).toContain('go 1.23');
      expect(strategy.syncCheck.classifyFailure?.('go.mod requires go >= 1.22')).toBeNull();
    }
    expect(goInstallStrategy.strategy(rootWith({}))).toBeNull();
  });

  it('declares the reasoned exemption for declare (the compiler is the resolution floor)', () => {
    expect(goRemediation.declareDependency.kind).toBe('exemption');
    if (goRemediation.declareDependency.kind === 'exemption') {
      expect(goRemediation.declareDependency.reason).toContain('resolution floor');
    }
    expect(goRemediation.resyncLockfile.kind).toBe('capability');
    expect(goRemediation.lintFix.kind).toBe('capability');
  });
});
