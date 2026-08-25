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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { attributePrePushResolution } from '../src/analyzers/correctness/resolution-attribution';
import {
  typescript,
  tsResolutionCheck,
  tsRelativeImportIdentities,
  tsJudgesFileForResolution,
} from '../src/languages/typescript';

/** The refuted list alone (null when the base was unreadable), for the
 *  package-class cases that predate the disclosure channel. */
const refutedList = (...args: Parameters<typeof refutedResolutionSpecifiers>): string[] | null => {
  const ev = refutedResolutionSpecifiers(...args);
  return ev === null ? null : [...ev.refuted];
};
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
    expect(refutedList(dir, baseSha, packs, ['ghost-pkg', 'left-pad'])).toEqual([
      'ghost-pkg',
      'left-pad',
    ]);
  });

  it('keeps a specifier the base lockfile mentions (the genuine un-hoist class blocks)', () => {
    expect(refutedList(dir, baseSha, packs, ['hoisted-pkg'])).toEqual([]);
  });

  it('keeps a newly-added import (absent from base source — the change introduced it)', () => {
    expect(refutedList(dir, baseSha, packs, ['new-ghost'])).toEqual([]);
  });

  it('yields no refutation at all when the base is unreadable', () => {
    expect(refutedList(dir, 'not-a-sha', packs, ['ghost-pkg'])).toBeNull();
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
    expect(refutedList(dir, baseSha, packs, ['three'])).toEqual(['three']);
  });

  it('keeps a package with an actual installed-tree entry (nothing over-refutes)', () => {
    expect(refutedList(dir, baseSha, packs, ['@render-three/fiber'])).toEqual([]);
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
    expect(refutedList(dir, brokenBase, packs, ['three'])).toEqual(['three']);
    expect(refutedList(dir, mentionedBase, packs, ['three'])).toEqual([]);
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
 * already imported it, decided by the PACK'S OWN extractor on the base blob
 * (the same comment stripping, template blanking and test / static-dir
 * exclusions the current side uses), so a commented-out import, a template
 * string, a test file or a public/ file at base cannot refute a genuinely
 * NEW production miss. A target the base tree HAD (deleted by this change)
 * keeps the block.
 */
describe('refutedResolutionSpecifiers: relative (project-path) identities', () => {
  let dir: string;
  let baseSha: string;
  const packs = [typescript];
  const refutedOf = (specs: string[]) =>
    refutedResolutionSpecifiers(dir, baseSha, packs, specs)?.refuted ?? null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-rel-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0' }));
    for (const d of ['src/components', 'src/other', 'src/__tests__', 'public/vendor']) {
      mkdirSync(join(dir, d), { recursive: true });
    }
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
    // The unsafe-direction shapes: each mentions a missing module in a way
    // the current side would NOT count as an import.
    writeFileSync(
      join(dir, 'src', 'components', 'Shapes.js'),
      [
        "// const c = require('./commentedOut');",
        "const tpl = `import x from './inTemplate';`;",
        'module.exports = tpl;',
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'src', '__tests__', 'Card.test.js'),
      "const f = require('./fromTestOnly');\nmodule.exports = f;\n",
    );
    writeFileSync(
      join(dir, 'public', 'vendor', 'bundle.js'),
      "var q = require('./fromPublicOnly');\nmodule.exports = q;\n",
    );
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refutes a relative miss the base already carried (target absent + imported there)', () => {
    expect(refutedOf(['./src/components/legacyIcon'])).toEqual(['./src/components/legacyIcon']);
  });

  it('keeps a NEW relative miss (the uncommitted-file class), despite a same-named module elsewhere', () => {
    expect(refutedOf(['./src/components/categoryIcon'])).toEqual([]);
  });

  it('keeps a target the base tree served (this change deleted it)', () => {
    expect(refutedOf(['./src/components/theme'])).toEqual([]);
  });

  it('a commented-out import, a template string, a test file or a public/ file at base never refutes', () => {
    expect(
      refutedOf([
        './src/components/commentedOut',
        './src/components/inTemplate',
        './src/__tests__/fromTestOnly',
        './public/vendor/fromPublicOnly',
      ]),
    ).toEqual([]);
  });

  it('end to end through the ONE comparator: only the new relative miss is net-new', () => {
    // Current side: the pre-existing bare phantom, the pre-existing relative
    // miss, and the new relative miss, all in one failing check.
    const current = ['ghost-pkg', './src/components/legacyIcon', './src/components/categoryIcon'];
    const refuted = refutedOf(current);
    expect(refuted).toEqual(['ghost-pkg', './src/components/legacyIcon']);
    const result: CorrectnessFloorResult = {
      checks: [
        {
          pack: 'typescript',
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
      [{ pack: 'typescript', label: IMPORT_RESOLUTION_LABEL, status: 'fail', findings: refuted! }],
      { absentMeans: 'net-new' },
    );
    expect(attributed).toHaveLength(1);
    expect(attributed[0].attribution).toBe('net-new');
    expect(attributed[0].precision).toBe('finding');
    expect(attributed[0].netNewFindings).toEqual(['./src/components/categoryIcon']);
  });

  it('the pre-push note splits the remedy per identity class', () => {
    const current = ['ghost-pkg', './src/components/legacyIcon', './src/components/categoryIcon'];
    const result = {
      ran: true,
      blocks: true,
      checks: [
        {
          pack: 'typescript',
          label: IMPORT_RESOLUTION_LABEL,
          bin: '',
          status: 'fail',
          output: '',
          findings: current,
        },
      ],
    } as unknown as CorrectnessFloorResult;
    const out = attributePrePushResolution(dir, baseSha, packs, result);
    expect(out?.blocks).toBe(true);
    expect(out?.note).toContain('1 unresolved package import(s) are PRE-EXISTING');
    expect(out?.note).toContain('1 missing relative import target(s) are PRE-EXISTING');
    expect(out?.note).toContain('Commit the missing file');
    expect(out?.note).toContain(
      'net-new unresolved import(s) BLOCK: ./src/components/categoryIcon',
    );
  });

  it('a SHORT basename still refutes: the needles are import-shaped, not bare substrings', () => {
    // `db` as a bare substring matches half a codebase; as `/db'` it only
    // matches an import tail, so the pre-existing dangling import refutes.
    const short = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-short-'));
    try {
      git(short, ['init', '-q', '-b', 'main']);
      git(short, ['config', 'user.email', 'test@example.com']);
      git(short, ['config', 'user.name', 'test']);
      git(short, ['config', 'commit.gpgsign', 'false']);
      mkdirSync(join(short, 'src'));
      writeFileSync(
        join(short, 'src', 'a.js'),
        "const d = require('./db');\nmodule.exports = d;\n",
      );
      // Plenty of prose mentions of `db` that must NOT count as candidates.
      writeFileSync(
        join(short, 'src', 'notes.js'),
        '// db db db\nconst dbName = 1;\nmodule.exports = dbName;\n',
      );
      git(short, ['add', '.']);
      git(short, ['commit', '-q', '-m', 'base']);
      const sha = git(short, ['rev-parse', 'HEAD']).trim();
      const ev = refutedResolutionSpecifiers(short, sha, packs, ['./src/db']);
      expect(ev?.refuted).toEqual(['./src/db']);
      expect(ev?.undecided).toEqual([]);
    } finally {
      rmSync(short, { recursive: true, force: true });
    }
  });

  it('past the candidate ceiling the identity degrades to DISCLOSED undecided and does not block', () => {
    // 2001 base files import './config': past the candidate ceiling, so the
    // probe cannot attribute; the pre-push surface warns instead of blocking.
    const many = mkdtempSync(join(tmpdir(), 'dxkit-floor-attrib-many-'));
    try {
      git(many, ['init', '-q', '-b', 'main']);
      git(many, ['config', 'user.email', 'test@example.com']);
      git(many, ['config', 'user.name', 'test']);
      git(many, ['config', 'commit.gpgsign', 'false']);
      mkdirSync(join(many, 'src'));
      for (let i = 0; i < 2001; i++) {
        writeFileSync(join(many, 'src', `m${i}.js`), "const c = require('./config');\n");
      }
      git(many, ['add', '.']);
      git(many, ['commit', '-q', '-m', 'base']);
      const sha = git(many, ['rev-parse', 'HEAD']).trim();
      const ev = refutedResolutionSpecifiers(many, sha, packs, ['./src/config']);
      expect(ev?.refuted).toEqual([]);
      expect(ev?.undecided).toEqual(['./src/config']);
      expect(ev?.disclosures.join('\n')).toContain('too many to read');
      const result = {
        ran: true,
        blocks: true,
        checks: [
          {
            pack: 'typescript',
            label: IMPORT_RESOLUTION_LABEL,
            bin: '',
            status: 'fail',
            output: '',
            findings: ['./src/config'],
          },
        ],
      } as unknown as CorrectnessFloorResult;
      const out = attributePrePushResolution(many, sha, packs, result);
      expect(out?.blocks).toBe(false);
      expect(out?.note).toContain('cannot attribute');
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });
});

/**
 * PARITY (Rule 2.30): the current-side check and the base-side probe hold
 * different shapes of one concept (a walked working tree vs blobs at a ref)
 * and MUST agree. On a committed fixture where base == current, every
 * project-path identity the check reports must be refuted by the probe
 * (it existed, dangling, at that very commit), and every identity the
 * pack's content reader mints for a file must be exactly what the check
 * would probe for it.
 */
describe('parity: current-side relative findings vs base-side refutation', () => {
  it('base == current: every current relative miss is refuted; nothing else is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-floor-parity-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'test']);
      git(dir, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(dir, 'package.json'), '{}');
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(dir, 'node_modules'));
      for (const d of ['src/a', 'src/b', 'src/__tests__', 'public']) {
        mkdirSync(join(dir, d), { recursive: true });
      }
      writeFileSync(join(dir, 'src', 'a', 'present.ts'), 'export const p = 1;\n');
      writeFileSync(
        join(dir, 'src', 'a', 'index.ts'),
        [
          "import { p } from './present';",
          "import { m } from './missing';",
          "import { m2 } from '../b/missing.js';",
          "import { w } from '../b/widgets/index';",
          "import { s } from './users.service';",
          "import './styles.css';",
          "const t = `import { z } from './in-template';`;",
          "// import { c } from './commented';",
          'export default [p, m, m2, w, s, t];',
        ].join('\n') + '\n',
      );
      // A multi-line import: the matched grep line alone carries no
      // `import`, so the decision must read the whole blob.
      writeFileSync(
        join(dir, 'src', 'b', 'other.ts'),
        "import {\n  w,\n} from './widgets';\nexport default w;\n",
      );
      writeFileSync(
        join(dir, 'src', '__tests__', 'x.test.ts'),
        "import { t } from './test-only-missing';\nexport default t;\n",
      );
      writeFileSync(join(dir, 'public', 'v.js'), "require('./public-only');\n");
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'base']);
      const sha = git(dir, ['rev-parse', 'HEAD']).trim();

      const current = tsResolutionCheck({ cwd: dir, changedFiles: [], scope: 'full' });
      expect(current.kind).toBe('unresolved');
      const found = current.kind === 'unresolved' ? current.unresolved.map((u) => u.specifier) : [];
      expect(found.sort()).toEqual(
        ['./src/a/missing', './src/b/missing', './src/b/widgets', './src/a/users.service'].sort(),
      );
      // Base == current, so every one of them was already dangling at base.
      const ev = refutedResolutionSpecifiers(dir, sha, [typescript], found);
      expect(ev?.disclosures).toEqual([]);
      expect([...(ev?.refuted ?? [])].sort()).toEqual([...found].sort());
      // And identities the current side never minted are never refuted.
      const never = [
        './src/a/in-template',
        './src/a/commented',
        './src/__tests__/test-only-missing',
        './public/public-only',
      ];
      expect(refutedResolutionSpecifiers(dir, sha, [typescript], never)?.refuted).toEqual([]);

      // The content reader is the current side's own candidate set, file by file.
      for (const rel of [
        'src/a/index.ts',
        'src/b/other.ts',
        'src/__tests__/x.test.ts',
        'public/v.js',
      ]) {
        const content = readFileSync(join(dir, rel), 'utf8');
        const minted = tsRelativeImportIdentities(rel, content);
        const judged = tsJudgesFileForResolution(rel);
        expect(minted === null).toBe(!judged);
        if (minted !== null) {
          for (const f of found.filter((id) => minted.includes(id))) expect(minted).toContain(f);
          expect(minted).not.toContain('./src/a/in-template');
          expect(minted).not.toContain('./src/a/commented');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
