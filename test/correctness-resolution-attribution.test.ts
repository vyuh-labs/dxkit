/**
 * Pre-push attribution for import-resolution failures (4.3.3).
 *
 * The class this closes, observed live on a real repository: a chore branch
 * bumping one unrelated lockfile entry escalated the pre-push floor to full
 * scope, and the repo's PRE-EXISTING phantom imports (specifiers imported by
 * untouched files and declared in no manifest at the base either) hard-blocked
 * the push. The floor's own law — only a net-new failure blocks — was already
 * enforced on the two-sided surfaces (CI, the loop); pre-push was point-in-
 * time because a base worktree run is too expensive for a hook. The fix is a
 * sound base answer WITHOUT a base run: a specifier could only have resolved
 * at the merge base if some package by that name was installed there, and
 * every install is recorded in a manifest/lockfile. Absent from every base
 * manifest blob + already imported (quoted) in base source ⇒ already broken
 * at base ⇒ pre-existing ⇒ warn, not block.
 *
 * Every uncertainty keeps the block: a specifier the base lockfile mentions
 * (the genuine un-hoist class) blocks; a newly-added import (absent from base
 * source) blocks; an unreadable base yields no refutation at all. Routed
 * through the ONE comparator (`attributeFloorFailures`), never a second
 * partition path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  runFloorForSurface,
  refutedResolutionSpecifiers,
} from '../src/analyzers/correctness/surface-run';
import type { CommandExec } from '../src/analyzers/correctness/run';
import type { LanguageSupport } from '../src/languages/types';
import type {
  CorrectnessContext,
  ResolutionCheckResult,
} from '../src/languages/capabilities/correctness';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/**
 * Fixture: base commit with two quoted phantom imports ('ghost-pkg',
 * 'left-pad'), a lockfile that mentions 'hoisted-pkg' (transitively provided
 * at base) but neither phantom, then a HEAD commit that only touches the
 * lockfile — the incident shape.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/hoisted-pkg': { version: '1.0.0' } },
    }),
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'app.js'),
    "const g = require('ghost-pkg');\nconst l = require('left-pad');\nmodule.exports = { g, l };\n",
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['branch', 'base-marker']);
  // The chore change: only the lockfile moves (an unrelated version bump).
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/hoisted-pkg': { version: '1.0.1' } },
    }),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'chore: bump lockfile']);
  return dir;
}

/** Synthetic pack: injected resolution verdict, exec-driven commands, and the
 *  manifest patterns the base-probe filters the base tree with. */
function packWithResolution(
  resolution: ResolutionCheckResult,
  opts: { syntaxFails?: boolean } = {},
): LanguageSupport {
  return {
    id: 'synthetic',
    depVulns: { manifestPatterns: ['package.json', 'package-lock.json'] },
    correctness: {
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
      syntaxCheck: (_ctx: CorrectnessContext) =>
        opts.syntaxFails ? { label: 'syntax', bin: 'fake-syntax', args: [] } : null,
      affectedTests: () => null,
      resolutionCheck: () => resolution,
    },
  } as unknown as LanguageSupport;
}

const passExec: CommandExec = () => ({ available: true, code: 0, output: '' });
const failSyntaxExec: CommandExec = (c) =>
  c.bin === 'fake-syntax'
    ? { available: true, code: 1, output: 'syntax broken' }
    : { available: true, code: 0, output: '' };

const unresolved = (...specs: string[]): ResolutionCheckResult => ({
  kind: 'unresolved',
  unresolved: specs.map((s) => ({ specifier: s, file: 'src/app.js' })),
});

describe('refutedResolutionSpecifiers — the base probe', () => {
  let dir: string;
  let baseSha: string;
  const packs = [packWithResolution({ kind: 'clean', checkedSpecifiers: 0 })];

  beforeAll(() => {
    dir = makeRepo();
    baseSha = git(dir, ['rev-parse', 'base-marker']).trim();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refutes a phantom: absent from every base manifest, imported (quoted) at base', () => {
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['ghost-pkg', 'left-pad'])).toEqual([
      'ghost-pkg',
      'left-pad',
    ]);
  });

  it('keeps a specifier the base lockfile mentions (the genuine un-hoist class blocks)', () => {
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['hoisted-pkg'])).toEqual([]);
  });

  it('keeps a newly-added import (absent from base source — the change introduced it)', () => {
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['new-ghost'])).toEqual([]);
  });

  it('yields no refutation at all when the base is unreadable', () => {
    expect(refutedResolutionSpecifiers(dir, 'not-a-sha', packs, ['ghost-pkg'])).toBeNull();
  });
});

describe('runFloorForSurface pre-push — resolution failures are attributed', () => {
  let dir: string;

  beforeAll(() => {
    dir = makeRepo();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (resolution: ResolutionCheckResult, exec: CommandExec, syntaxFails = false) =>
    runFloorForSurface({
      surface: 'pre-push',
      cwd: dir,
      base: 'base-marker',
      packs: [packWithResolution(resolution, { syntaxFails })],
      exec,
    });

  it('pre-existing phantoms warn instead of blocking, with the base named', () => {
    const outcome = run(unresolved('ghost-pkg', 'left-pad'), passExec);
    expect(outcome.ran).toBe(true);
    expect(outcome.blocks).toBe(false);
    expect(outcome.summary).toContain('PRE-EXISTING');
    expect(outcome.summary).toContain('not blocked');
  });

  it('a net-new unresolved import still blocks, named, while the phantoms stay refuted', () => {
    const outcome = run(unresolved('ghost-pkg', 'new-ghost'), passExec);
    expect(outcome.blocks).toBe(true);
    expect(outcome.summary).toContain('net-new unresolved import(s) BLOCK: new-ghost');
    expect(outcome.summary).toContain('PRE-EXISTING');
  });

  it('another failing check keeps its point-in-time block even when resolution is refuted', () => {
    const outcome = run(unresolved('ghost-pkg'), failSyntaxExec, true);
    expect(outcome.blocks).toBe(true);
  });

  it('no resolvable base keeps the point-in-time verdict (no refutation invented)', () => {
    const outcome = runFloorForSurface({
      surface: 'pre-push',
      cwd: dir,
      base: 'no-such-ref',
      packs: [packWithResolution(unresolved('ghost-pkg'))],
      exec: passExec,
    });
    expect(outcome.blocks).toBe(true);
  });
});

describe('runFloorForSurface pre-push — floor-debt envelope demotes grandfathered checks (4.3.7)', () => {
  let dir: string;

  beforeAll(() => {
    dir = makeRepo();
    // The committed baseline's floor-debt envelope records the syntax check
    // already FAILING at capture — the repo's grandfathered debt.
    mkdirSync(join(dir, '.dxkit', 'baselines'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'baselines', 'main.json'),
      JSON.stringify({
        schemaVersion: 'dxkit-baseline/v1',
        name: 'main',
        createdAt: '2026-08-01T00:00:00Z',
        repo: {},
        analysis: {},
        tools: [],
        findings: [],
        floorDebt: {
          capturedAtCommit: 'abcdef123456abcdef123456abcdef123456abcd',
          capturedAt: '2026-08-01T00:00:00Z',
          checks: [{ pack: 'synthetic', label: 'syntax', command: 'fake-syntax', status: 'fail' }],
        },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a check recorded failing in the envelope warns instead of hard-blocking the push', () => {
    // The incident shape: CI's two-sided floor reported these failures as
    // pre-existing/unattributable while the local pre-push hook hard-blocked
    // them (bypassed with --no-verify — a gate that trains bypassing).
    const outcome = runFloorForSurface({
      surface: 'pre-push',
      cwd: dir,
      base: 'base-marker',
      packs: [packWithResolution(unresolved('ghost-pkg'), { syntaxFails: true })],
      exec: failSyntaxExec,
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.blocks).toBe(false);
    expect(outcome.summary).toContain('floor-debt');
    expect(outcome.summary).toContain('pre-existing debt, not blocked at pre-push');
    expect(outcome.summary).toContain('abcdef123456');
  });

  it('a failing check ABSENT from the envelope still blocks (point-in-time kept)', () => {
    const outcome = runFloorForSurface({
      surface: 'pre-push',
      cwd: dir,
      base: 'base-marker',
      packs: [
        {
          ...packWithResolution(unresolved(), { syntaxFails: true }),
          correctness: {
            ...(
              packWithResolution(unresolved(), { syntaxFails: true }) as {
                correctness: object;
              }
            ).correctness,
            syntaxCheck: () => ({ label: 'other-syntax', bin: 'fake-syntax', args: [] }),
            resolutionCheck: () => null,
          },
        } as unknown as LanguageSupport,
      ],
      exec: failSyntaxExec,
    });
    expect(outcome.blocks).toBe(true);
  });
});
