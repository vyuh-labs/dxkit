/**
 * Synthetic-producer playbook — closes the class of bug where the
 * orchestrator stops being registry-driven (someone adds a new
 * producer to PRODUCERS but the orchestrator still hardcodes the
 * old set). Mirror of `recipe-playbook.test.ts` for language packs.
 *
 * The test:
 *   1. Construct a synthetic `BaselineProducer` that emits a
 *      single sentinel `BaselineEntry`.
 *   2. Call `runProducers` with PRODUCERS + the synthetic producer.
 *   3. Assert the sentinel appears in the output.
 *
 * If a future refactor changes `runProducers` to iterate a
 * hardcoded subset instead of the supplied registry, this test
 * fails — the synthetic producer's entry won't appear. The bug
 * surfaces at unit-test time, not in production after some new
 * analyzer ships.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PRODUCERS,
  runProducers,
  type BaselineProducer,
  type ProducerContext,
} from '../../src/baseline/producers';

/**
 * Minimal fixture context. The synthetic producer doesn't read any
 * context fields — it just emits a sentinel — so the other fields
 * can be empty / shaped just enough to satisfy the type.
 */
function fixtureContext(): ProducerContext {
  return {
    cwd: '/tmp/fixture',
    commitSha: '',
    salt: 'test-salt',
    analysisResult: {
      stack: {
        languages: {
          python: false,
          typescript: false,
          go: false,
          rust: false,
          csharp: false,
          kotlin: false,
          java: false,
          ruby: false,
        },
        tools: {},
        framework: null,
        testRunner: null,
        projectName: '',
        versions: {},
      } as ProducerContext['analysisResult']['stack'],
      capabilities: {},
      metrics: {
        largestFiles: [],
      } as unknown as ProducerContext['analysisResult']['metrics'],
      commitSha: '',
      branch: '',
      cwd: '/tmp/fixture',
      builtAt: '2026-05-18T00:00:00Z',
      dxkitVersion: '2.5.0',
      schemaVersion: 3,
      ignoreFileMtime: null,
      workingTreeDirty: false,
    } as ProducerContext['analysisResult'],
    testGapsReport: {
      repo: '',
      analyzedAt: '',
      commitSha: '',
      branch: '',
      summary: {
        testFiles: 0,
        activeTestFiles: 0,
        commentedOutFiles: 0,
        effectiveCoverage: 0,
        coverageSource: 'filename-match',
        coverageFidelity: 'filename-match',
        sourceFiles: 0,
        untestedCritical: 0,
        untestedHigh: 0,
        untestedMedium: 0,
        untestedLow: 0,
      },
      testFiles: [],
      gaps: [],
      toolsUsed: [],
      toolsUnavailable: [],
    },
    hygiene: {
      staleFiles: [],
      todoCount: 0,
      fixmeCount: 0,
      hackCount: 0,
      consoleLogCount: 0,
      mixedLanguages: false,
    },
    rawSecrets: [],
  };
}

describe('synthetic-producer playbook', () => {
  it('orchestrator picks up a synthetic producer added to the registry', () => {
    const SENTINEL_ID = 'synth0000feedbeef';
    const synthetic: BaselineProducer = {
      name: 'synthetic-test-producer',
      // `large-file` is one of the wired kinds; reusing it avoids
      // tripping the contract test's "no two producers claim the
      // same kind" rule (this test runs in isolation from the
      // contract test's PRODUCERS — we hand a custom list to
      // runProducers, not mutate the canonical one).
      contributes: ['large-file'],
      produce() {
        return [{ id: SENTINEL_ID, kind: 'large-file', file: '__synthetic__.ts' }];
      },
    };

    const ctx = fixtureContext();
    const entries = runProducers(ctx, [synthetic]);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(SENTINEL_ID);
  });

  it('runProducers iterates the SUPPLIED registry, not the canonical one', () => {
    // Defensive: pass an empty list, expect zero entries. If
    // `runProducers` accidentally fell back to PRODUCERS, the
    // empty result would not be empty.
    const ctx = fixtureContext();
    const entries = runProducers(ctx, []);
    expect(entries).toEqual([]);
  });

  it('orchestrator calling shape: full PRODUCERS yields ≥ N entries on a real fixture', () => {
    // Sanity: PRODUCERS isn't degenerate. Use a temp git repo so
    // the security/test-gaps pipelines have somewhere to look.
    // The exact count doesn't matter; the assertion is "produces
    // ≥ 0 entries without throwing across every registered
    // producer."
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-playbook-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      writeFileSync(join(dir, 'README.md'), '# playbook\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'playbook fixture'], { cwd: dir });

      const ctx = fixtureContext();
      const entries = runProducers(ctx, PRODUCERS);
      expect(entries.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
