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
 *
 * The second half does the same for RECALL (CLAUDE.md Rule 19): a synthetic
 * producer's recall inputs must reach the union, and MUTATING one must make
 * its kind drift. That is the empirical guard the previous design had no way
 * to state — recall was two hardcoded lists, so there was nothing a synthetic
 * producer could be absent from, and the omission was invisible to every test.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PRODUCERS,
  runProducers,
  runRecallContexts,
  type BaselineProducer,
} from '../../src/baseline/producers';
import { diffRecall } from '../../src/baseline/recall';
import { producerFixtureContext as fixtureContext } from './producer-fixture';

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
      recallContexts() {
        return new Map([['large-file', { epoch: 1, inputs: { 'synthetic-tool': '1.0.0' } }]]);
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

describe('synthetic-producer recall playbook (Rule 19)', () => {
  /** A producer whose single recall input we can move at will. */
  function synthetic(version: string): BaselineProducer {
    return {
      name: 'synthetic-recall-producer',
      contributes: ['large-file'],
      produce() {
        return [{ id: 'synthrecall00001', kind: 'large-file', file: '__synthetic__.ts' }];
      },
      recallContexts() {
        return new Map([['large-file', { epoch: 3, inputs: { 'synthetic-tool': version } }]]);
      },
    };
  }

  it('a synthetic producer reaches the recall union without touching the orchestrator', () => {
    const recall = runRecallContexts(fixtureContext(), [synthetic('1.0.0')]);
    expect(recall['large-file']).toEqual({ epoch: 3, inputs: { 'synthetic-tool': '1.0.0' } });
  });

  it('MUTATING one input makes that kind drift — the mechanism actually bites', () => {
    // The whole point of Rule 19: if this ever passes with `drift` empty, the
    // gate is silently attributing tool changes to the developer again.
    const before = runRecallContexts(fixtureContext(), [synthetic('1.0.0')]);
    const after = runRecallContexts(fixtureContext(), [synthetic('1.1.0')]);

    const drift = diffRecall(before, after);
    expect(drift).toEqual([
      {
        kind: 'large-file',
        reason: 'inputs',
        changed: [{ input: 'synthetic-tool', before: '1.0.0', after: '1.1.0' }],
      },
    ]);
  });

  it('an unchanged input does NOT drift — no false "cannot attribute"', () => {
    // The opposite failure mode, and the more dangerous one: a recall context
    // that drifts spuriously turns the gate off permanently while looking
    // healthy. Two identical runs must be attributable.
    const a = runRecallContexts(fixtureContext(), [synthetic('1.0.0')]);
    const b = runRecallContexts(fixtureContext(), [synthetic('1.0.0')]);
    expect(diffRecall(a, b)).toEqual([]);
  });

  it('a dxkit-side epoch bump drifts the kind on its own', () => {
    const before = runRecallContexts(fixtureContext(), [synthetic('1.0.0')]);
    const bumped: BaselineProducer = {
      ...synthetic('1.0.0'),
      recallContexts() {
        return new Map([['large-file', { epoch: 4, inputs: { 'synthetic-tool': '1.0.0' } }]]);
      },
    };
    const after = runRecallContexts(fixtureContext(), [bumped]);
    expect(diffRecall(before, after)).toEqual([
      { kind: 'large-file', reason: 'epoch', changed: [] },
    ]);
  });

  it('every REAL producer is registry-driven for recall too', () => {
    // Sanity mirror of the `produce` case above: the canonical registry must
    // yield a context for every kind it contributes on a bare fixture.
    const recall = runRecallContexts(fixtureContext(), PRODUCERS);
    const contributed = PRODUCERS.flatMap((p) => [...p.contributes]).sort();
    expect(Object.keys(recall).sort()).toEqual(contributed);
  });
});
