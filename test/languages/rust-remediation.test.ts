/**
 * The rust remediation capabilities (4.4.7 V3): the crate-name rail, the
 * pin plan as a pure command decision over real Cargo.toml fixtures
 * (applied / refused / adversarial, rename and workspace tables included),
 * and the install strategy's declared commands. No network, no spawns.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isValidCrateName, rustRemediation } from '../../src/languages/rust-remediation';
import { rustInstallStrategy } from '../../src/languages/rust-install';
import type { PinTransitiveProvider } from '../../src/languages/capabilities/remediation';

const pin = (rustRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider;

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function rootWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-rust-remediation-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const CARGO_TOML = `[package]
name = "fx"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio_util = "0.7"

[dev-dependencies]
proptest = "1.4"
`;

function planAt(cargoToml: string, pkg = 'smallvec', version = '1.13.2') {
  return pin.plan({ cwd: rootWith({ 'Cargo.toml': cargoToml }), rootDir: '', pkg, version });
}

describe('the crate-name rail (Rule 11)', () => {
  it('accepts real crate names, refuses injection shapes', () => {
    expect(isValidCrateName('serde')).toBe(true);
    expect(isValidCrateName('tokio-util')).toBe(true);
    expect(isValidCrateName('proc_macro2')).toBe(true);
    expect(isValidCrateName('-flag')).toBe(false);
    expect(isValidCrateName('--precise')).toBe(false);
    expect(isValidCrateName('a b')).toBe(false);
    expect(isValidCrateName('vendor/pkg')).toBe(false);
    expect(isValidCrateName('')).toBe(false);
  });
});

describe('the cargo pin plan (a pure command decision over Cargo.toml)', () => {
  it('plans the lockfile-level pin: cargo update -p pkg --precise ver, writing Cargo.lock only', () => {
    const plan = planAt(CARGO_TOML);
    expect(plan.kind).toBe('command');
    if (plan.kind !== 'command') return;
    expect(plan.command).toEqual({
      bin: 'cargo',
      args: ['update', '-p', 'smallvec', '--precise', '1.13.2'],
    });
    expect(plan.writes).toEqual(['Cargo.lock']);
    expect(plan.revert).toContain('cargo update -p smallvec');
    expect(plan.notes?.join(' ')).toContain('Cargo.lock only');
  });

  it('refuses a DIRECT dependency across the dependencies-shaped tables, folding - and _', () => {
    for (const [pkg, version] of [
      ['serde', '1.0.200'],
      ['proptest', '1.5.0'],
      // crates.io folds - and _ into one name; over-matching only refuses.
      ['tokio-util', '0.7.12'],
    ] as const) {
      const refused = planAt(CARGO_TOML, pkg, version);
      expect(refused.kind, `${pkg} should refuse`).toBe('refused');
      if (refused.kind === 'refused') expect(refused.reason).toContain('declared directly');
    }
  });

  it('refuses a rename target, a workspace dependency, and a patched crate', () => {
    const renamed = planAt(
      '[package]\nname = "fx"\n\n[dependencies]\nlogging = { package = "log", version = "0.4" }\n',
      'log',
      '0.4.22',
    );
    expect(renamed.kind).toBe('refused');
    const workspace = planAt(
      '[workspace]\nmembers = ["a"]\n\n[workspace.dependencies]\nserde = "1.0"\n',
      'serde',
      '1.0.200',
    );
    expect(workspace.kind).toBe('refused');
    const patched = planAt(
      CARGO_TOML + '\n[patch.crates-io]\nsmallvec = { path = "../smallvec" }\n',
      'smallvec',
      '1.13.2',
    );
    expect(patched.kind).toBe('refused');
    const targetTable = planAt(
      CARGO_TOML + `\n[target.'cfg(windows)'.dependencies]\nwinapi = "0.3"\n`,
      'winapi',
      '0.3.9',
    );
    expect(targetTable.kind).toBe('refused');
  });

  it('refuses injection-shaped tokens and a missing Cargo.toml; a transitive crate pins', () => {
    expect(planAt(CARGO_TOML, '--precise', '1.0.0').kind).toBe('refused');
    expect(planAt(CARGO_TOML, 'smallvec', '^1.13').kind).toBe('refused');
    const noManifest = pin.plan({
      cwd: rootWith({}),
      rootDir: '',
      pkg: 'smallvec',
      version: '1.13.2',
    });
    expect(noManifest.kind).toBe('refused');
    expect(planAt(CARGO_TOML, 'smallvec', '1.13.2').kind).toBe('command');
  });
});

describe('the rust install strategy + declared exemptions', () => {
  it('declares the cargo commands: frozen fetch --locked, minimal update --workspace resync', () => {
    const dir = rootWith({ 'Cargo.toml': CARGO_TOML });
    const strategy = rustInstallStrategy.strategy(dir)!;
    expect(strategy.manager).toBe('cargo');
    expect(strategy.lockfile).toBe('Cargo.lock');
    expect(strategy.modes.frozen.primary).toEqual({ bin: 'cargo', args: ['fetch', '--locked'] });
    expect(strategy.modes.resync?.primary).toEqual({
      bin: 'cargo',
      args: ['update', '--workspace'],
    });
    expect(strategy.syncCheck?.kind).toBe('command');
    if (strategy.syncCheck?.kind === 'command') {
      expect(strategy.syncCheck.command.args).toEqual([
        'update',
        '--workspace',
        '--locked',
        '--dry-run',
      ]);
    }
    expect(rustInstallStrategy.strategy(rootWith({}))).toBeNull();
  });

  it('declares the reasoned exemptions: declare (resolution floor) and lintFix (whole-crate clippy)', () => {
    expect(rustRemediation.resyncLockfile.kind).toBe('capability');
    expect(rustRemediation.pinTransitive.kind).toBe('capability');
    expect(rustRemediation.declareDependency.kind).toBe('exemption');
    expect(rustRemediation.lintFix.kind).toBe('exemption');
    if (rustRemediation.lintFix.kind === 'exemption') {
      expect(rustRemediation.lintFix.reason).toContain('--allow-dirty');
    }
  });
});
