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
import {
  IMPORT_RESOLUTION_LABEL,
  type CommandExec,
  type CorrectnessFloorResult,
} from '../src/analyzers/correctness/run';
import { attributeFloorFailures } from '../src/analyzers/correctness/attribution';
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
    // The probe reads manifest patterns from `capabilities.depVulns` (the
    // real pack shape) — a top-level `depVulns` here is invisible to
    // `dependencyManifestFilesIn` and silently empties the base evidence.
    capabilities: { depVulns: { manifestPatterns: ['package.json', 'package-lock.json'] } },
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

/**
 * #284 — the measurement asymmetry, both live shapes: a lockfile MENTIONS
 * package names it never installed (peer metadata inside another entry,
 * under a --legacy-peer-deps install), and a short name is a literal
 * substring of a longer installed one. The old whole-blob containment read
 * both as "maybe provided at base" and hard-blocked pre-existing phantoms
 * on manifests-only diffs. The format-aware evidence answers what the
 * current side asks: was a package by that name INSTALLED at base?
 */
describe('refutedResolutionSpecifiers — #284 lockfile evidence (peer metadata, substrings)', () => {
  let dir: string;
  let baseSha: string;
  const packs = [packWithResolution({ kind: 'clean', checkedSpecifiers: 0 })];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-peer-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0' }));
    // The incident lockfile shape: '@render-three/fiber' is installed and its
    // entry DECLARES 'three' as a peer — but 'three' has no entry of its own
    // (--legacy-peer-deps never materialized it). 'three' is also a literal
    // substring of the installed package's name.
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@render-three/fiber': '^8.0.0' } },
          'node_modules/@render-three/fiber': {
            version: '8.0.0',
            peerDependencies: { three: '>=0.150' },
          },
        },
      }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'scene.js'),
      "const t = require('three');\nmodule.exports = t;\n",
    );
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
    // Allowlist-only change (the live shape: a diff that cannot introduce
    // an import).
    writeFileSync(join(dir, 'NOTES.md'), 'defer extended\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'chore: notes']);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refutes a peer-declared-but-never-installed phantom (the three class)', () => {
    // Old behavior: "three" appears in the lockfile blob (peer metadata AND
    // as a substring of @render-three/fiber) → kept blocking. New behavior:
    // no installed-tree entry names it → already unresolvable at base →
    // pre-existing, refuted.
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['three'])).toEqual(['three']);
  });

  it('keeps a package with an actual installed-tree entry (nothing over-refutes)', () => {
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['@render-three/fiber'])).toEqual([]);
  });

  it('an unparseable lockfile falls back to containment (keep the block)', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{ not json');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'break lockfile']);
    const brokenBase = git(dir, ['rev-parse', 'HEAD']).trim();
    // Containment sees "three" inside the broken blob's text? It does not
    // here (the broken blob has no such text), so the phantom still refutes;
    // the fallback path is exercised either way. Keep a mentioned name to
    // prove the conservative direction:
    writeFileSync(join(dir, 'package-lock.json'), '{ not json but mentions three somewhere');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'mention in broken blob']);
    const mentionedBase = git(dir, ['rev-parse', 'HEAD']).trim();
    expect(refutedResolutionSpecifiers(dir, brokenBase, packs, ['three'])).toEqual(['three']);
    expect(refutedResolutionSpecifiers(dir, mentionedBase, packs, ['three'])).toEqual([]);
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

/**
 * Relative-import identities (4.4.5). A missing `./x` target carries a
 * project-path identity (`./src/x`) and is never a manifest question: it was
 * pre-existing iff the base tree ALSO lacked the target AND a base file
 * already imported it (resolved from that file's directory, so a same-named
 * module elsewhere cannot refute a genuinely new miss). A target the base
 * tree HAD (deleted by this change) keeps the block.
 */
describe('refutedResolutionSpecifiers: relative (project-path) identities', () => {
  let dir: string;
  let baseSha: string;
  const packs = [
    {
      ...packWithResolution({ kind: 'clean', checkedSpecifiers: 0 }),
      sourceExtensions: ['.js', '.ts'],
    } as unknown as LanguageSupport,
  ];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-rel-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0' }));
    mkdirSync(join(dir, 'src', 'components'), { recursive: true });
    mkdirSync(join(dir, 'src', 'other'), { recursive: true });
    // Base: one bare phantom, one relative import already dangling at base,
    // one relative import that RESOLVES at base, and a same-named module in
    // another directory (the decoy the resolve-from-importer rule exists for).
    writeFileSync(
      join(dir, 'src', 'components', 'Card.js'),
      "const g = require('ghost-pkg');\nconst i = require('./legacyIcon');\nconst t = require('./theme');\nmodule.exports = [g, i, t];\n",
    );
    writeFileSync(join(dir, 'src', 'components', 'theme.js'), 'module.exports = 1;\n');
    writeFileSync(
      join(dir, 'src', 'other', 'a.js'),
      "const c = require('./categoryIcon');\nmodule.exports = c;\n",
    );
    writeFileSync(join(dir, 'src', 'other', 'categoryIcon.js'), 'module.exports = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refutes a relative miss the base already carried (target absent + imported there)', () => {
    expect(
      refutedResolutionSpecifiers(dir, baseSha, packs, ['./src/components/legacyIcon']),
    ).toEqual(['./src/components/legacyIcon']);
  });

  it('keeps a NEW relative miss (the uncommitted-file class), despite a same-named module elsewhere', () => {
    expect(
      refutedResolutionSpecifiers(dir, baseSha, packs, ['./src/components/categoryIcon']),
    ).toEqual([]);
  });

  it('keeps a target the base tree served (this change deleted it)', () => {
    expect(refutedResolutionSpecifiers(dir, baseSha, packs, ['./src/components/theme'])).toEqual(
      [],
    );
  });

  it('end to end through the ONE comparator: only the new relative miss is net-new', () => {
    // Current side: the pre-existing bare phantom, the pre-existing relative
    // miss, and the new relative miss, all in one failing check.
    const current = ['ghost-pkg', './src/components/legacyIcon', './src/components/categoryIcon'];
    const refuted = refutedResolutionSpecifiers(dir, baseSha, packs, current);
    expect(refuted).toEqual(['ghost-pkg', './src/components/legacyIcon']);
    const result: CorrectnessFloorResult = {
      checks: [
        {
          pack: 'synthetic',
          label: IMPORT_RESOLUTION_LABEL,
          bin: '',
          status: 'fail',
          output: '',
          findings: current,
        },
      ],
    } as unknown as CorrectnessFloorResult;
    const attributed = attributeFloorFailures(
      result,
      [{ pack: 'synthetic', label: IMPORT_RESOLUTION_LABEL, status: 'fail', findings: refuted! }],
      { absentMeans: 'net-new' },
    );
    expect(attributed).toHaveLength(1);
    expect(attributed[0].attribution).toBe('net-new');
    expect(attributed[0].precision).toBe('finding');
    expect(attributed[0].netNewFindings).toEqual(['./src/components/categoryIcon']);
  });
});
