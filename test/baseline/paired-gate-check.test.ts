/**
 * The paired-change gate — declared "changing X requires also changing Y"
 * rules evaluated over the changed-path set. Pins:
 *   - fires when the diff touches `if` without touching `then`; silent when
 *     the companion change is present or the trigger surface untouched;
 *   - a DELETED `if` file still triggers (the gate reads changed PATHS, not
 *     the exists-on-disk projection);
 *   - per-rule blocking vs warn-only verdicts;
 *   - the allowlist waiver (active `paired-change` entry, expiry honored);
 *   - every fail-open path is DISCLOSED, never silent: off / no-base-ref /
 *     no-changed-set / error-with-GateFailure (the gate-failopen contract);
 *   - malformed rules are dropped with a warning, never crash the gate.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  evaluatePairedGateForGuardrail,
  evaluatePairedRule,
} from '../../src/baseline/paired-gate-check';
import { normalizePairedChecks } from '../../src/analyzers/custom-checks/config';
import { computeChangedPaths } from '../../src/baseline/changed-files';
import { computePairedChangeFingerprint } from '../../src/analyzers/tools/fingerprint';
import { emptyAllowlistFile } from '../../src/allowlist/file';
import type { AllowlistFile } from '../../src/allowlist/file';

const MODEL_RULE = {
  name: 'model-needs-migration',
  if: ['src/models/**'],
  then: ['migrations/**'],
  message: 'a data-model change ships with its migration',
};

function repoWith(policy: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxkit-paired-'));
  mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  writeFileSync(path.join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy));
  return dir;
}

function allowlistWith(entry: Partial<AllowlistFile['entries'][number]>): AllowlistFile {
  const file = emptyAllowlistFile('full');
  return {
    ...file,
    entries: [
      {
        fingerprint: 'x',
        kind: 'paired-change',
        category: 'deferred',
        addedAt: '2026-01-01',
        ...entry,
      } as AllowlistFile['entries'][number],
    ],
  };
}

describe('evaluatePairedRule — the pure per-rule predicate', () => {
  const { rules } = normalizePairedChecks([MODEL_RULE]);
  const rule = rules[0];

  it('fires when if is touched and then is not', () => {
    const f = evaluatePairedRule(rule, ['src/models/user.ts', 'README.md']);
    expect(f).not.toBeNull();
    expect(f!.check).toBe('model-needs-migration');
    expect(f!.blocking).toBe(true);
    expect(f!.ifMatched).toEqual(['src/models/user.ts']);
    expect(f!.id).toBe(computePairedChangeFingerprint('model-needs-migration'));
  });

  it('is silent when the companion change is present', () => {
    expect(evaluatePairedRule(rule, ['src/models/user.ts', 'migrations/0042_user.sql'])).toBeNull();
  });

  it('is silent when the trigger surface is untouched', () => {
    expect(evaluatePairedRule(rule, ['src/routes/user.ts'])).toBeNull();
  });

  it('matches ** across directory levels and caps the evidence sample', () => {
    const paths = Array.from({ length: 9 }, (_, i) => `src/models/nested/deep/m${i}.ts`);
    const f = evaluatePairedRule(rule, paths);
    expect(f).not.toBeNull();
    expect(f!.ifMatched.length).toBeLessThanOrEqual(5);
  });
});

describe('normalizePairedChecks — the ONE rule normalizer', () => {
  it('drops malformed entries with a warning, keeps the rest', () => {
    const { rules, warnings } = normalizePairedChecks([
      MODEL_RULE,
      { if: ['a/**'], then: ['b/**'] }, // no name
      { name: 'no-globs' }, // no if/then
      { name: 'model-needs-migration', if: ['x'], then: ['y'] }, // duplicate
      { name: 'warn-rule', if: 'docs-src/**', then: ['docs/**'], blocking: false },
    ]);
    expect(rules.map((r) => r.name)).toEqual(['model-needs-migration', 'warn-rule']);
    expect(rules[1].blocking).toBe(false);
    expect(rules[1].ifGlobs).toEqual(['docs-src/**']); // string form accepted
    expect(warnings).toHaveLength(3);
  });

  it('returns empty for absent config', () => {
    expect(normalizePairedChecks(undefined).rules).toHaveLength(0);
  });
});

describe('evaluatePairedGateForGuardrail — fail-open, always says why', () => {
  it('skips off (unattached) when no rules are declared', () => {
    const dir = repoWith({});
    try {
      const out = evaluatePairedGateForGuardrail({ cwd: dir, baseRef: 'HEAD' });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('off');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips no-base-ref with rules declared — disclosed, not silent', () => {
    const dir = repoWith({ pairedChecks: [MODEL_RULE] });
    try {
      const out = evaluatePairedGateForGuardrail({ cwd: dir });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('no-base-ref');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips no-changed-set when the changed paths cannot be computed', () => {
    const dir = repoWith({ pairedChecks: [MODEL_RULE] });
    try {
      const out = evaluatePairedGateForGuardrail({
        cwd: dir,
        baseRef: 'deadbeef',
        changedPathsProvider: () => null,
      });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('no-changed-set');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures a GateFailure on a thrown provider — never a silent black hole', () => {
    const dir = repoWith({ pairedChecks: [MODEL_RULE] });
    try {
      const out = evaluatePairedGateForGuardrail({
        cwd: dir,
        baseRef: 'HEAD',
        changedPathsProvider: () => {
          throw new Error('git exploded');
        },
      });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('error');
      expect(out.error?.step).toBe('changed-paths');
      expect(out.error?.message).toContain('git exploded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks on a violated blocking rule; warns on a warn-only rule', () => {
    const dir = repoWith({
      pairedChecks: [
        MODEL_RULE,
        { name: 'api-needs-docs', if: ['src/api/**'], then: ['docs/api/**'], blocking: false },
      ],
    });
    try {
      const out = evaluatePairedGateForGuardrail({
        cwd: dir,
        baseRef: 'HEAD',
        changedPathsProvider: () => ['src/models/user.ts', 'src/api/routes.ts'],
      });
      expect(out.ran).toBe(true);
      expect(out.findings).toHaveLength(2);
      expect(out.blocks).toBe(true); // model rule
      expect(out.warns).toBe(true); // api rule (warn-only)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an active allowlist entry waives the violation from the verdict', () => {
    const dir = repoWith({ pairedChecks: [MODEL_RULE] });
    const fp = computePairedChangeFingerprint('model-needs-migration');
    try {
      const out = evaluatePairedGateForGuardrail({
        cwd: dir,
        baseRef: 'HEAD',
        allowlist: allowlistWith({ fingerprint: fp, expiresAt: '2099-01-01' }),
        now: new Date('2026-07-25'),
        changedPathsProvider: () => ['src/models/user.ts'],
      });
      expect(out.findings).toHaveLength(0);
      expect(out.suppressed).toHaveLength(1);
      expect(out.suppressed[0].category).toBe('deferred');
      expect(out.blocks).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an EXPIRED allowlist entry re-blocks — the expiry is the forcing function', () => {
    const dir = repoWith({ pairedChecks: [MODEL_RULE] });
    const fp = computePairedChangeFingerprint('model-needs-migration');
    try {
      const out = evaluatePairedGateForGuardrail({
        cwd: dir,
        baseRef: 'HEAD',
        allowlist: allowlistWith({ fingerprint: fp, expiresAt: '2026-01-01' }),
        now: new Date('2026-07-25'),
        changedPathsProvider: () => ['src/models/user.ts'],
      });
      expect(out.findings).toHaveLength(1);
      expect(out.blocks).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeChangedPaths — deletions count (the paired-gate projection)', () => {
  it('includes a deleted file that computeChangedFiles drops', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dxkit-paired-git-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'test']);
      mkdirSync(path.join(dir, 'src/models'), { recursive: true });
      writeFileSync(path.join(dir, 'src/models/user.ts'), 'export const u = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();

      unlinkSync(path.join(dir, 'src/models/user.ts'));
      writeFileSync(path.join(dir, 'new.txt'), 'x\n');

      const paths = computeChangedPaths(dir, base);
      expect(paths).not.toBeNull();
      expect(paths).toContain('src/models/user.ts'); // the deletion
      expect(paths).toContain('new.txt'); // the untracked addition

      // And the real gate fires on that deletion end-to-end.
      mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
      writeFileSync(
        path.join(dir, '.dxkit', 'policy.json'),
        JSON.stringify({ pairedChecks: [MODEL_RULE] }),
      );
      const out = evaluatePairedGateForGuardrail({ cwd: dir, baseRef: base });
      expect(out.ran).toBe(true);
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0].ifMatched).toEqual(['src/models/user.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
