/**
 * The structural-duplicate DETECTOR — pure scoring over function signatures.
 * (Replaces the graph-based test/explore/duplicate-pairs-query.test.ts: the
 * signal now reads callee sets from dxkit's own AST, so the detector is a pure
 * function of `FunctionSignature[]`.)
 *
 * The load-bearing case is the IDF regression: two handlers that share only the
 * ubiquitous framework skeleton but call DIFFERENT data functions must NOT be
 * flagged — the false-positive class the graph-based signal produced on
 * framework-heavy code (a coincidental 1.00 from a 3-callee framework match).
 */
import { describe, it, expect } from 'vitest';
import {
  duplicatePairs,
  DUP_MIN_CALLEES,
  DUP_DEFAULT_MIN_SCORE,
} from '../../../src/analyzers/duplication/detect';
import type { FunctionSignature } from '../../../src/analyzers/duplication/signatures';

function sig(file: string, name: string, callees: string[], line = 1): FunctionSignature {
  return { file, name, line, callees: new Set(callees) };
}

describe('duplicatePairs — structural-duplicate scoring', () => {
  it('flags a true copy-paste: identical callee set + name', () => {
    const sigs = [
      sig('a.ts', 'load', ['fetchThing', 'parseThing', 'renderThing']),
      sig('b.ts', 'load', ['fetchThing', 'parseThing', 'renderThing']),
    ];
    const pairs = duplicatePairs(sigs, { minScore: 0.75 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBeCloseTo(1, 5);
    expect(pairs[0].calleeJaccard).toBeCloseTo(1, 5);
  });

  it('scores on STRUCTURE, not name: a renamed copy (identical callees) is verified', () => {
    // Same callee set, DIFFERENT names — a renamed/reformatted copy. The score is
    // the structural similarity (1.0) regardless of the name, so it reads as the
    // near-identical copy it is (jscpd/aislop miss this — the tokens changed).
    const sigs = [
      sig('a.ts', 'loadDivisions', ['authenticate', 'queryRows', 'normalize', 'respond']),
      sig('b.ts', 'fetchTeamsView', ['authenticate', 'queryRows', 'normalize', 'respond']),
    ];
    const pairs = duplicatePairs(sigs, { minScore: 0.75 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBeCloseTo(1, 5); // structural — name did not lower it
  });

  it('does NOT flag two functions with no shared callees', () => {
    const sigs = [sig('a.ts', 'load', ['a1', 'a2', 'a3']), sig('b.ts', 'load', ['b1', 'b2', 'b3'])];
    expect(duplicatePairs(sigs, { minScore: 0.75 })).toHaveLength(0);
  });

  it('excludes a function calling fewer than DUP_MIN_CALLEES helpers', () => {
    expect(DUP_MIN_CALLEES).toBe(3);
    const sigs = [
      sig('a.ts', 'f', ['x', 'y']), // only 2 callees → no structural signal
      sig('b.ts', 'f', ['x', 'y']),
    ];
    expect(duplicatePairs(sigs, { minScore: 0.5 })).toHaveLength(0);
  });

  it('IDF REGRESSION: framework handlers sharing only ubiquitous calls are NOT duplicates', () => {
    // A corpus of route handlers: every one calls the SAME framework skeleton
    // (auth/json/handleError) + one distinct DATA function. Only the two that
    // call the same data function are a real copy — the rest must not pair, even
    // though they share 3 of 4 callees, because the shared callees are ubiquitous
    // (IDF ≈ 0) and the discriminating data call differs.
    const skeleton = ['auth', 'json', 'handleError'];
    const sigs = [
      sig('api/divisions.ts', 'GET', [...skeleton, 'getDivisions']),
      sig('api/cli/divisions.ts', 'GET', [...skeleton, 'getDivisions']), // the real copy
      sig('api/leagues.ts', 'GET', [...skeleton, 'getLeagues']),
      sig('api/seasons.ts', 'GET', [...skeleton, 'getSeasons']),
      sig('api/teams.ts', 'GET', [...skeleton, 'getTeams']),
      sig('api/players.ts', 'GET', [...skeleton, 'getPlayers']),
    ];
    const pairs = duplicatePairs(sigs, { minScore: 0.75 });
    // Exactly ONE pair — the divisions copy — despite every handler sharing the
    // framework skeleton and the identical name `GET`.
    expect(pairs).toHaveLength(1);
    const files = pairs[0] && [pairs[0].a.file, pairs[0].b.file].sort();
    expect(files).toEqual(['api/cli/divisions.ts', 'api/divisions.ts']);
  });

  it('name is a minor corroborator, not the signal: same name + weak callee overlap stays below the floor', () => {
    // Two same-named functions sharing only ubiquitous helpers → callee signal ~0,
    // so even nameJaccard 1.0 cannot lift the blend over 0.75.
    const skeleton = ['log', 'wrap', 'guard'];
    const sigs = [
      sig('a.ts', 'run', [...skeleton, 'doA']),
      sig('b.ts', 'run', [...skeleton, 'doB']),
      sig('c.ts', 'run', [...skeleton, 'doC']),
    ];
    expect(duplicatePairs(sigs, { minScore: 0.75 })).toHaveLength(0);
  });

  it('diff-scopes to pairs touching a focus file', () => {
    const sigs = [
      sig('unchanged-a.ts', 'load', ['fetchThing', 'parseThing', 'renderThing']),
      sig('unchanged-b.ts', 'load', ['fetchThing', 'parseThing', 'renderThing']),
      sig('changed.ts', 'load', ['fetchThing', 'parseThing', 'renderThing']),
    ];
    // No focus → all three pairwise combinations (3).
    expect(duplicatePairs(sigs, { minScore: 0.75 })).toHaveLength(3);
    // Focus on the changed file → only pairs touching it (2).
    const scoped = duplicatePairs(sigs, {
      minScore: 0.75,
      focusFiles: new Set(['changed.ts']),
    });
    expect(scoped).toHaveLength(2);
    for (const p of scoped) expect([p.a.file, p.b.file]).toContain('changed.ts');
  });

  it('default report threshold is exported and applied', () => {
    expect(DUP_DEFAULT_MIN_SCORE).toBe(0.5);
  });
});
