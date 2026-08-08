import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTextRule } from '../../src/analyzers/custom-checks/text-rule';
import { normalizeCustomChecks } from '../../src/analyzers/custom-checks/config';
import { recallInputsForSpecs } from '../../src/analyzers/custom-checks/gather';
import { runCustomChecks } from '../../src/analyzers/custom-checks/run';
import { clearWalkPathsCache } from '../../src/analyzers/tools/walk-paths';
import { untrustedContentContext } from '../../src/analysis-trust';
import { TEXT_RULE_BIN, type CustomCheckSpec } from '../../src/analyzers/custom-checks/types';

/**
 * The declarative text rule (4.4.0 / P1-5 stage 1) — the third consumer
 * of the custom-check seam. Pure unit layer: normalization, the
 * in-process scanner, recall identity, and the no-spawn property that
 * lets it run on untrusted trees.
 */

const spec = (over: Partial<CustomCheckSpec> = {}): CustomCheckSpec => ({
  name: 'no_placeholder',
  command: { bin: TEXT_RULE_BIN, args: [] },
  textRule: { pattern: '\\b(TODO|FIXME|XXX)\\b', globs: ['code/**'] },
  blocking: true,
  expectedExit: 0,
  parse: { mode: 'exit' },
  ...over,
});

describe('normalizeCustomChecks — the pattern variant', () => {
  it('normalizes a pattern entry to a text-rule spec', () => {
    const { specs, warnings } = normalizeCustomChecks([
      { name: 'no_placeholder', pattern: '\\bTODO\\b', globs: ['src/**'], flags: 'i' },
    ]);
    expect(warnings).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0].textRule).toEqual({ pattern: '\\bTODO\\b', flags: 'i', globs: ['src/**'] });
    expect(specs[0].command.bin).toBe(TEXT_RULE_BIN);
    expect(specs[0].blocking).toBe(true);
  });

  it('declaring both command and pattern is a named misconfig, not a silent pick', () => {
    const { specs, warnings } = normalizeCustomChecks([
      { name: 'both', command: 'true', pattern: 'x' },
    ]);
    expect(specs).toHaveLength(0);
    expect(warnings.join(' ')).toContain('both');
  });

  it('an entry with neither command nor pattern is still dropped with a warning', () => {
    const { specs, warnings } = normalizeCustomChecks([{ name: 'empty' }]);
    expect(specs).toHaveLength(0);
    expect(warnings.join(' ')).toContain('empty');
  });
});

describe('runTextRule (the in-process scanner)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-text-rule-'));
    clearWalkPathsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearWalkPathsCache();
  });

  it('mints one located finding per matching line, repo-relative POSIX, in-scope only', () => {
    mkdirSync(join(dir, 'code'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'code', 'a.js'), 'ok\n// TODO one\nok\n// FIXME two\n');
    writeFileSync(join(dir, 'docs', 'notes.md'), 'TODO out of scope\n');
    const result = runTextRule(dir, spec());
    expect(result.status).toBe('fail');
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual([
      'code/a.js:2',
      'code/a.js:4',
    ]);
    expect(result.findings.every((f) => f.check === 'no_placeholder' && f.blocking)).toBe(true);
  });

  it('a clean tree passes; empty globs scan everything', () => {
    writeFileSync(join(dir, 'clean.txt'), 'nothing here\n');
    expect(runTextRule(dir, spec()).status).toBe('pass');
    writeFileSync(join(dir, 'top.txt'), 'a TODO at top level\n');
    clearWalkPathsCache();
    const everywhere = runTextRule(dir, spec({ textRule: { pattern: '\\bTODO\\b' } }));
    expect(everywhere.status).toBe('fail');
    expect(everywhere.findings[0].file).toBe('top.txt');
  });

  it('an invalid pattern is ONE binary misconfig finding — never a crash, never a silent pass', () => {
    const result = runTextRule(dir, spec({ textRule: { pattern: '(unclosed' } }));
    expect(result.status).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBeUndefined();
    expect(result.findings[0].message).toContain('invalid pattern');
  });

  it('binary files are skipped (NUL probe)', () => {
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0x00, 0x01]));
    const result = runTextRule(dir, spec({ textRule: { pattern: 'TODO' } }));
    expect(result.status).toBe('pass');
  });
});

describe('the seam properties', () => {
  it('runs under an UNTRUSTED context (no spawn), where a command check is trust-skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-text-trust-'));
    try {
      writeFileSync(join(dir, 'x.js'), '// TODO\n');
      clearWalkPathsCache();
      const out = runCustomChecks({
        cwd: dir,
        trust: untrustedContentContext(),
        specs: [
          spec({ textRule: { pattern: '\\bTODO\\b' } }),
          {
            name: 'cmd-check',
            command: { bin: 'node', args: ['-e', 'process.exit(1)'] },
            blocking: true,
            expectedExit: 0,
            parse: { mode: 'exit' },
          },
        ],
      });
      const byName = new Map(out.results.map((r) => [r.name, r]));
      expect(byName.get('no_placeholder')?.status).toBe('fail');
      expect(byName.get('cmd-check')?.status).toBe('skipped-untrusted');
      expect(out.findings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clearWalkPathsCache();
    }
  });

  it('recall identity is the rule itself: pattern + flags + globs (Rule 19)', () => {
    const a = recallInputsForSpecs([spec()]);
    expect(Object.keys(a)).toEqual(['no_placeholder/text']);
    expect(a['no_placeholder/text']).toMatch(/^rule:/);
    // Mutating any component drifts the input; an identical rule does not.
    const b = recallInputsForSpecs([spec()]);
    expect(b).toEqual(a);
    const mutated = recallInputsForSpecs([
      spec({ textRule: { pattern: '\\bTODO\\b', globs: ['code/**'] } }),
    ]);
    expect(mutated['no_placeholder/text']).not.toBe(a['no_placeholder/text']);
  });
});
