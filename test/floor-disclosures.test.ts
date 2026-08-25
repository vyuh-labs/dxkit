/**
 * A check that ANSWERS but declines part of its question (the import-
 * resolution check stepping back from a specifier class) must say so on
 * every surface, on pass as well as fail. The runner carries the pack's
 * `disclosures` onto the check result, and `describeEnvironmentSkips`, the
 * one disclosure line every surface renders, prints them, so a partial
 * answer never hides behind a green check (Rule 19).
 */

import { describe, it, expect } from 'vitest';
import {
  runCorrectnessFloor,
  describeEnvironmentSkips,
  IMPORT_RESOLUTION_LABEL,
  type CommandExec,
} from '../src/analyzers/correctness/run';
import type { LanguageSupport } from '../src/languages/types';
import type { ResolutionCheckResult } from '../src/languages/capabilities/correctness';

function packWith(resolution: ResolutionCheckResult): LanguageSupport {
  return {
    id: 'synthetic',
    correctness: {
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
      syntaxCheck: () => null,
      affectedTests: () => null,
      resolutionCheck: () => resolution,
    },
  } as unknown as LanguageSupport;
}

const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
const base = { cwd: '/repo', changedFiles: [], scope: 'full' as const, exec };

describe('import-resolution disclosures reach the rendered floor', () => {
  it('a PASSING check carries its disclosures and the shared disclosure line prints them', () => {
    const r = runCorrectnessFloor({
      ...base,
      packs: [
        packWith({
          kind: 'clean',
          checkedSpecifiers: 3,
          disclosures: ['relative imports were resolved against the filesystem'],
        }),
      ],
    });
    const check = r.checks.find((c) => c.label === IMPORT_RESOLUTION_LABEL)!;
    expect(check.status).toBe('pass');
    expect(check.disclosures).toEqual(['relative imports were resolved against the filesystem']);
    expect(describeEnvironmentSkips(r)).toEqual([
      'synthetic import-resolution disclosed: relative imports were resolved against the filesystem',
    ]);
  });

  it('a FAILING check renders the truthful per-finding detail and keeps its disclosures', () => {
    const r = runCorrectnessFloor({
      ...base,
      packs: [
        packWith({
          kind: 'unresolved',
          unresolved: [
            { specifier: 'form-data', file: 'src/a.js' },
            {
              specifier: './src/categoryIcon',
              file: 'src/Card.tsx',
              detail: 'exists on disk but is not tracked in git (uncommitted)',
            },
          ],
          disclosures: ['package imports were not judged: 12 packages do not resolve'],
        }),
      ],
    });
    const check = r.checks.find((c) => c.label === IMPORT_RESOLUTION_LABEL)!;
    expect(check.status).toBe('fail');
    expect(check.findings).toEqual(['form-data', './src/categoryIcon']);
    expect(check.output).toContain("'form-data' does not resolve against the installed tree");
    expect(check.output).toContain(
      "'./src/categoryIcon' exists on disk but is not tracked in git (uncommitted) (relative import in src/Card.tsx)",
    );
    expect(check.output).toContain('Commit the missing file');
    expect(check.output).toContain('Declare it in the dependency manifest');
    expect(describeEnvironmentSkips(r)).toEqual([
      'synthetic import-resolution disclosed: package imports were not judged: 12 packages do not resolve',
    ]);
  });

  it('a SKIPPED check keeps the disclosures accumulated before it stepped back', () => {
    const r = runCorrectnessFloor({
      ...base,
      packs: [
        packWith({
          kind: 'skipped',
          reason: '12 packages do not resolve',
          disclosures: ['60 relative imports reach no file, repo-wide'],
        }),
      ],
    });
    const check = r.checks.find((c) => c.label === IMPORT_RESOLUTION_LABEL)!;
    expect(check.status).toBe('skipped-unavailable');
    expect(check.output).toContain('12 packages');
    const lines = describeEnvironmentSkips(r);
    expect(lines.join('\n')).toContain('12 packages do not resolve');
    expect(lines.join('\n')).toContain('60 relative imports');
  });

  it('a clean check with nothing to disclose stays silent', () => {
    const r = runCorrectnessFloor({
      ...base,
      packs: [packWith({ kind: 'clean', checkedSpecifiers: 1 })],
    });
    expect(r.checks[0].disclosures).toBeUndefined();
    expect(describeEnvironmentSkips(r)).toEqual([]);
  });
});
