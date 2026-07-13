import { describe, it, expect } from 'vitest';
import { tierDeadSurfaces } from '../../../src/analyzers/convergence/dead-surface-gather';
import { convergeSeams } from '../../../src/analyzers/convergence/index';
import type { UnconsumedRoute } from '../../../src/analyzers/flow/diagnose';
import type { DuplicateFinding } from '../../../src/analyzers/duplication/findings';

/**
 * The pure join layer of phase 2 — `tierDeadSurfaces` (route + signals → tiers)
 * and `convergeSeams` (dead ∩ duplicate). Tested deterministically so the
 * convergence firing is proven independent of graphify + the flow extractor
 * (the real pipeline's no-false-positive behavior is covered by the real-repo
 * stress pass). The file join is the load-bearing part — a real multi-project
 * repo caught a relative-vs-absolute mismatch that silently zeroed it, so these
 * assert both sides meet on the same key.
 */

function route(
  method: string,
  path: string,
  file: string,
  handler: string | null = null,
): UnconsumedRoute {
  return { method, path, file, line: 1, handler };
}

function dup(fileA: string, fileB: string): DuplicateFinding {
  return {
    id: 'deadbeefdeadbeef',
    anchors: [
      { file: fileA, symbol: 'listTeamsLegacy', line: 10 },
      { file: fileB, symbol: 'listTeams', line: 4 },
    ],
    score: 0.95,
  };
}

describe('tierDeadSurfaces — signal → tier over real route shapes', () => {
  const conventionPatterns = ['/webhook', '/cli/'];

  it('a convention route lands expected', () => {
    const surfaces = tierDeadSurfaces(
      [route('POST', '/webhook/stripe', 'src/api/stripe/route.ts')],
      {
        crossRepoConsumersVisible: true,
        calledSymbols: new Set(),
        conventionPatterns,
        duplicateFiles: new Set(),
      },
    );
    expect(surfaces[0].tier).toBe('expected');
    expect(surfaces[0].reason).toBe('convention');
  });

  it('a direct-called route (specific handler in the call graph) lands expected', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/divisions', 'src/api/divisions.ts', 'getDivisions')],
      {
        crossRepoConsumersVisible: true,
        calledSymbols: new Set(['getDivisions']),
        conventionPatterns,
        duplicateFiles: new Set(),
      },
    );
    expect(surfaces[0].tier).toBe('expected');
    expect(surfaces[0].reason).toBe('direct-call');
  });

  it('a generic-verb handler is NOT trusted for the direct-call seam', () => {
    // `GET` collides across the codebase — a spurious match must not mark the
    // route consumed. It stays likely (bias to false-negative on deadness).
    const surfaces = tierDeadSurfaces([route('GET', '/orphan', 'src/api/orphan.ts', 'GET')], {
      crossRepoConsumersVisible: true,
      calledSymbols: new Set(['GET']),
      conventionPatterns,
      duplicateFiles: new Set(),
    });
    expect(surfaces[0].tier).toBe('likely');
  });

  it('a dead + duplicated route with visible consumers lands removable (convergence)', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/teams-legacy', 'src/routes/teams.ts', 'listTeamsLegacy')],
      {
        crossRepoConsumersVisible: true,
        calledSymbols: new Set(),
        conventionPatterns,
        duplicateFiles: new Set(['src/routes/teams.ts']),
      },
    );
    expect(surfaces[0].tier).toBe('removable');
    expect(surfaces[0].reason).toBe('converged-dead');
    expect(surfaces[0].convergesWithDuplicate).toBe(true);
  });

  it('the SAME dead+dup route WITHOUT visible consumers stays likely (never shout cross-repo)', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/teams-legacy', 'src/routes/teams.ts', 'listTeamsLegacy')],
      {
        crossRepoConsumersVisible: false,
        calledSymbols: new Set(),
        conventionPatterns,
        duplicateFiles: new Set(['src/routes/teams.ts']),
      },
    );
    expect(surfaces[0].tier).toBe('likely');
    expect(surfaces[0].convergesWithDuplicate).toBe(true); // the dup fact is still recorded
  });
});

describe('convergeSeams — dead ∩ duplicate', () => {
  const dupFinding = dup('src/routes/teams.ts', 'src/routes/teams.ts');

  it('fires when a removable dead route shares a file with a duplicate', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/teams-legacy', 'src/routes/teams.ts', 'listTeamsLegacy')],
      {
        crossRepoConsumersVisible: true,
        calledSymbols: new Set(),
        conventionPatterns: [],
        duplicateFiles: new Set(['src/routes/teams.ts']),
      },
    );
    const conv = convergeSeams(surfaces, [dupFinding]);
    expect(conv).toHaveLength(1);
    expect(conv[0].route.path).toBe('/teams-legacy');
    expect(conv[0].signals).toEqual(['code-reimplementation', 'dead-surface']);
    expect(conv[0].duplicate.id).toBe(dupFinding.id);
  });

  it('does NOT fire on a likely (unconfirmed) dead route even if a duplicate co-locates', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/teams-legacy', 'src/routes/teams.ts', 'listTeamsLegacy')],
      {
        crossRepoConsumersVisible: false, // deadness unconfirmed
        calledSymbols: new Set(),
        conventionPatterns: [],
        duplicateFiles: new Set(['src/routes/teams.ts']),
      },
    );
    expect(convergeSeams(surfaces, [dupFinding])).toHaveLength(0);
  });

  it('does NOT fire when the duplicate is in a different file', () => {
    const surfaces = tierDeadSurfaces(
      [route('GET', '/teams-legacy', 'src/routes/teams.ts', 'listTeamsLegacy')],
      {
        crossRepoConsumersVisible: true,
        calledSymbols: new Set(),
        conventionPatterns: [],
        duplicateFiles: new Set(['src/other.ts']),
      },
    );
    expect(convergeSeams(surfaces, [dup('src/other.ts', 'src/elsewhere.ts')])).toHaveLength(0);
  });

  it('is empty when there are no duplicates or no dead surfaces', () => {
    expect(convergeSeams([], [dupFinding])).toEqual([]);
  });
});
