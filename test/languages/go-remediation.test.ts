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
import {
  goRemediation,
  goTreeRefusal,
  isValidGoModulePath,
} from '../../src/languages/go-remediation';
import { goInstallStrategy } from '../../src/languages/go-install';
import { lockfileCheckFromStrategy } from '../../src/languages/capabilities/correctness';
import { executeLockfileCheck } from '../../src/analyzers/correctness/lockfile-check';
import { defaultResolvedTolerances } from '../../src/install/tolerances';
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
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
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
      // A rejected -diff flag (an EOL toolchain) classifies as a disclosed
      // SKIP (cannot judge), never as drift and never as a re-worded fail.
      const classified = strategy.syncCheck.classifyFailure?.(
        'flag provided but not defined: -diff',
      );
      expect(classified).toEqual({ skipped: expect.stringContaining('go 1.23') as string });
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

describe('the go tree admission (vendored modules and go.work workspaces refuse)', () => {
  it('a vendored module refuses the pin AND the resync with the mechanism named', () => {
    const cwd = rootWith({ 'go.mod': GO_MOD, 'vendor/modules.txt': '# example.com 1\n' });
    const plan = pin.plan({ cwd, rootDir: '', pkg: 'golang.org/x/text', version: '0.3.8' });
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') expect(plan.reason).toContain('vendor');
    const resync = goRemediation.resyncLockfile;
    expect(resync.kind).toBe('capability');
    if (resync.kind === 'capability') {
      expect(resync.provider.refusal?.({ cwd, rootDir: '' })).toContain('inconsistent vendoring');
    }
  });

  it('a go.work workspace refuses, from the module root or any ancestor', () => {
    const atRoot = rootWith({ 'go.mod': GO_MOD, 'go.work': 'go 1.22\nuse .\n' });
    expect(goTreeRefusal(atRoot, '')).toContain('go.work');
    const nested = rootWith({
      'go.work': 'go 1.22\nuse ./svc\n',
      'svc/go.mod': GO_MOD,
    });
    expect(goTreeRefusal(nested, 'svc')).toContain('go.work.sum');
    const plan = pin.plan({
      cwd: nested,
      rootDir: 'svc',
      pkg: 'golang.org/x/text',
      version: '0.3.8',
    });
    expect(plan.kind).toBe('refused');
  });

  it('a plain module (no vendor, no go.work) still plans the pin', () => {
    const cwd = rootWith({ 'go.mod': GO_MOD });
    expect(goTreeRefusal(cwd, '')).toBeNull();
    expect(pin.plan({ cwd, rootDir: '', pkg: 'golang.org/x/text', version: '0.3.8' }).kind).toBe(
      'command',
    );
  });
});

describe('replace directives across MULTIPLE blocks', () => {
  it('a module named only in the second replace block still refuses', () => {
    const twoBlocks =
      GO_MOD +
      '\nreplace (\n\texample.com/other => ../other\n)\n\nreplace (\n\tgolang.org/x/text => ../local-text\n)\n';
    const plan = planAt(twoBlocks, 'golang.org/x/text', '0.3.8');
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') expect(plan.reason).toContain('replace directive');
  });
});

describe('the OSV query form (bare versions for the Go ecosystem)', () => {
  it('osvVersion strips the v prefix and leaves bare versions alone', () => {
    expect(pin.osvVersion?.('v0.3.8')).toBe('0.3.8');
    expect(pin.osvVersion?.('0.3.8')).toBe('0.3.8');
    expect(pin.osvVersion?.('v0.0.0-20240101000000-abcdefabcdef')).toBe(
      '0.0.0-20240101000000-abcdefabcdef',
    );
  });
});

describe('the sync check on an EOL toolchain (cannot judge = a disclosed skip)', () => {
  it('a rejected -diff flag yields a SKIPPED check (no stale-lockfile order can mint), a real diff still fails', () => {
    const cwd = rootWith({ 'go.mod': GO_MOD });
    const strategy = goInstallStrategy.strategy(cwd)!;
    const check = lockfileCheckFromStrategy(strategy, defaultResolvedTolerances())!;
    // Orders mint only from status 'fail' (the floor's failed-check set),
    // so the skipped status is exactly what keeps an unjudgeable tree from
    // minting a weekly discard-loop order.
    const oldToolchain = executeLockfileCheck('go', check, cwd, () => ({
      available: true,
      code: 2,
      output: 'flag provided but not defined: -diff',
    }));
    expect(oldToolchain.status).toBe('skipped-unavailable');
    expect(oldToolchain.output).toContain('go 1.23');
    const drifted = executeLockfileCheck('go', check, cwd, () => ({
      available: true,
      code: 1,
      output: 'diff go.mod.orig go.mod',
    }));
    expect(drifted.status).toBe('fail');
  });
});
