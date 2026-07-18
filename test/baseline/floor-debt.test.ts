/**
 * The floor-debt envelope (T2.3 follow-through): the committed inventory of
 * pre-existing build/test debt, captured at baseline time so cleanup agents
 * can prioritize and fix it. Informational — Rule 15 intact: no fingerprint,
 * no matcher, never a gate input. These tests pin capture fidelity (details
 * survive: reproduction command + error output), the create-time wiring
 * (default ON, env kill-switch, explicit option beats env), and the
 * read-path round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureFloorDebt, failingFloorDebt } from '../../src/baseline/floor-debt';
import { createBaseline } from '../../src/baseline/create';
import { readBaselineFile, pathForBaseline } from '../../src/baseline/baseline-file';
import type { CommandExec } from '../../src/analyzers/correctness/run';
import type { LanguageSupport } from '../../src/languages/types';

function syntheticPack(id: string): LanguageSupport {
  return {
    id,
    correctness: {
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
      syntaxCheck: () => ({ label: 'compile', bin: 'fake-cc', args: ['--strict', 'src/'] }),
      affectedTests: () => ({ label: 'tests', bin: 'fake-test', args: ['run'] }),
    },
  } as unknown as LanguageSupport;
}

describe('captureFloorDebt', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-floordebt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('records failing checks WITH the reproduction command and error output', () => {
    const exec: CommandExec = (cmd) =>
      cmd.bin === 'fake-cc'
        ? { available: true, code: 2, output: 'src/app.x:14: error: broken widget\n' }
        : { available: true, code: 0, output: '' };
    const debt = captureFloorDebt(repo, { exec, packs: [syntheticPack('ts')] });
    expect(debt).not.toBeNull();
    const failing = failingFloorDebt(debt!);
    expect(failing).toHaveLength(1);
    // The two things a cleanup agent needs: HOW to reproduce, WHAT broke.
    expect(failing[0].command).toBe('fake-cc --strict src/');
    expect(failing[0].output).toContain('error: broken widget');
    // Provenance is stamped.
    expect(debt!.capturedAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(debt!.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The passing sibling is recorded too — 'all green' must be
    // distinguishable from 'never measured'.
    expect(debt!.checks.map((c) => c.status).sort()).toEqual(['fail', 'pass']);
  });

  it('returns null when no active pack provides a floor (envelope omitted, not empty-green)', () => {
    expect(captureFloorDebt(repo, { packs: [] })).toBeNull();
  });
});

describe('createBaseline floor-debt wiring', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-floordebt-create-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    // A ts-pack repo whose typecheck script fails fast with real output —
    // the cheapest honest "pre-existing broken build". Pack detection needs
    // a real source file, not just a package.json.
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture',
          version: '1.0.0',
          scripts: {
            typecheck: 'node -e "console.error(\'TS9999: fixture broken\');process.exit(1)"',
          },
        },
        null,
        2,
      ),
    );
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('explicit floor:true captures the envelope (beats the suite env kill-switch) and it round-trips', async () => {
    // The suite sets DXKIT_BASELINE_NO_FLOOR=1 globally; an explicit option
    // must win, or the product default would be untestable.
    const created = await createBaseline({ cwd: repo, floor: true });
    expect(created.path).toBeTruthy();
    const file = readBaselineFile(pathForBaseline(repo, 'main'));
    expect(file.floorDebt).toBeDefined();
    const failing = failingFloorDebt(file.floorDebt!);
    expect(failing.length).toBeGreaterThanOrEqual(1);
    const typecheck = failing.find((c) => /typecheck|compile/i.test(c.label));
    expect(typecheck, 'the broken typecheck script must be recorded as debt').toBeDefined();
    expect(typecheck!.output).toContain('TS9999: fixture broken');
    expect(typecheck!.command.length).toBeGreaterThan(0);
  }, 120_000);

  it('the env kill-switch (suite default) omits the envelope; --no-floor maps to floor:false', async () => {
    const created = await createBaseline({ cwd: repo }); // env says no-floor
    expect(created.path).toBeTruthy();
    const file = readBaselineFile(pathForBaseline(repo, 'main'));
    expect(file.floorDebt).toBeUndefined();

    rmSync(pathForBaseline(repo, 'main'), { force: true });
    const explicit = await createBaseline({ cwd: repo, floor: false, force: true });
    expect(explicit.path).toBeTruthy();
    expect(readBaselineFile(pathForBaseline(repo, 'main')).floorDebt).toBeUndefined();
  }, 120_000);
});
