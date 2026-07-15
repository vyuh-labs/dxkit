/**
 * Unit tests for the recall-attribution module (CLAUDE.md Rule 19).
 *
 * The two failure modes are opposite and BOTH are bad:
 *
 *   - under-drift: a real tool change reads as attributable, so the gate blames
 *     the developer for findings a plugin bump surfaced (the shipped bug);
 *   - over-drift: an input that moves on its own (a timestamp, a path) reads as
 *     permanent drift, so the gate silently stops enforcing while looking
 *     healthy — the more dangerous one, because nothing fails.
 *
 * So every case here asserts BOTH directions.
 */
import { describe, it, expect } from 'vitest';
import {
  RECALL_DRIFT_REMEDY,
  describeRecallDrift,
  diffRecall,
  hashRecallInputs,
  recallInputsUnion,
  type RecallMap,
} from '../../src/baseline/recall';

describe('diffRecall', () => {
  it('identical contexts are attributable', () => {
    const map: RecallMap = { secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } } };
    expect(diffRecall(map, map)).toEqual([]);
  });

  it('an absent baseline drifts every kind — never assumes comparability', () => {
    // §7's chosen behavior, and the one that must never quietly become
    // "assume it's fine": a baseline predating Rule 19 carries no evidence
    // that the two sides are comparable, so the honest answer is "I don't
    // know", not "probably".
    const current: RecallMap = {
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      'custom-check': { epoch: 2, inputs: {} },
    };
    expect(diffRecall(undefined, current)).toEqual([
      { kind: 'custom-check', reason: 'absent-from-baseline', changed: [] },
      { kind: 'secret', reason: 'absent-from-baseline', changed: [] },
    ]);
  });

  it('a kind absent from an OLDER baseline drifts, but its siblings do not', () => {
    // Per-kind, not global: a repo that just enabled lint must not lose
    // secret attribution as collateral.
    const baseline: RecallMap = { secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } } };
    const current: RecallMap = {
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      'custom-check': { epoch: 2, inputs: { 'lint:typescript/cmd': 'npx eslint .' } },
    };
    expect(diffRecall(baseline, current)).toEqual([
      { kind: 'custom-check', reason: 'absent-from-baseline', changed: [] },
    ]);
  });

  it('a moved input names WHICH input and its old -> new — the react-hooks case', () => {
    // The live case this whole design exists for: an unchanged argv, a bumped
    // plugin, 535 findings that appear from nowhere.
    const baseline: RecallMap = {
      'custom-check': {
        epoch: 2,
        inputs: {
          'lint:typescript/cmd': 'npx --no-install eslint .',
          'lint:typescript/eslint-plugin-react-hooks': '7.0.1',
        },
      },
    };
    const current: RecallMap = {
      'custom-check': {
        epoch: 2,
        inputs: {
          'lint:typescript/cmd': 'npx --no-install eslint .',
          'lint:typescript/eslint-plugin-react-hooks': '7.1.1',
        },
      },
    };
    expect(diffRecall(baseline, current)).toEqual([
      {
        kind: 'custom-check',
        reason: 'inputs',
        changed: [
          { input: 'lint:typescript/eslint-plugin-react-hooks', before: '7.0.1', after: '7.1.1' },
        ],
      },
    ]);
  });

  it('an epoch bump drifts even when every input is identical', () => {
    // Cause 6: dxkit changed what it can see. No environmental input moves,
    // so nothing else in the system could possibly notice.
    const baseline: RecallMap = { 'custom-check': { epoch: 1, inputs: { a: '1' } } };
    const current: RecallMap = { 'custom-check': { epoch: 2, inputs: { a: '1' } } };
    expect(diffRecall(baseline, current)).toEqual([
      { kind: 'custom-check', reason: 'epoch', changed: [] },
    ]);
  });

  it('reports appearing and disappearing inputs', () => {
    const baseline: RecallMap = { code: { epoch: 1, inputs: { semgrep: '1.2.0' } } };
    const current: RecallMap = {
      code: { epoch: 1, inputs: { semgrep: '1.2.0', 'snyk-code': 'abc' } },
    };
    expect(diffRecall(baseline, current)).toEqual([
      { kind: 'code', reason: 'inputs', changed: [{ input: 'snyk-code', after: 'abc' }] },
    ]);
  });

  it('a kind the current run no longer produces is not reported', () => {
    // Nothing to attribute: there are no current findings of that kind, so
    // announcing its drift is noise that trains readers to ignore the signal.
    const baseline: RecallMap = { secret: { epoch: 1, inputs: { gitleaks: '8.0.0' } } };
    expect(diffRecall(baseline, {})).toEqual([]);
  });

  it('is deterministic in kind order', () => {
    const baseline: RecallMap = {};
    const current: RecallMap = {
      secret: { epoch: 1, inputs: {} },
      code: { epoch: 1, inputs: {} },
      'dep-vuln': { epoch: 1, inputs: {} },
    };
    expect(diffRecall(baseline, current).map((d) => d.kind)).toEqual([
      'code',
      'dep-vuln',
      'secret',
    ]);
  });
});

describe('recallInputsUnion', () => {
  it('merges kinds that agree on a shared input into one entry', () => {
    // The common case: secret + config + secret-hmac all come from the same
    // scanner pass, so they report the same gitleaks version.
    const map: RecallMap = {
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      config: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      code: { epoch: 1, inputs: { semgrep: '1.2.0' } },
    };
    expect(recallInputsUnion(map)).toEqual({ gitleaks: '8.24.0', semgrep: '1.2.0' });
  });

  it('namespaces a CONTESTED key instead of letting one kind silently win', () => {
    // Losing data here would be the lossy-projection bug all over again, one
    // layer down.
    const map: RecallMap = {
      secret: { epoch: 1, inputs: { scanner: '1.0.0' } },
      code: { epoch: 1, inputs: { scanner: '2.0.0' } },
    };
    expect(recallInputsUnion(map)).toEqual({ 'code:scanner': '2.0.0', 'secret:scanner': '1.0.0' });
  });

  it('an empty map projects to an empty record', () => {
    expect(recallInputsUnion({})).toEqual({});
  });

  it('is order-independent — the toolchainHash must not depend on key insertion', () => {
    const a: RecallMap = {
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      code: { epoch: 1, inputs: { semgrep: '1.2.0' } },
    };
    const b: RecallMap = {
      code: { epoch: 1, inputs: { semgrep: '1.2.0' } },
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
    };
    expect(JSON.stringify(recallInputsUnion(a))).toBe(JSON.stringify(recallInputsUnion(b)));
  });
});

describe('hashRecallInputs', () => {
  it('is stable across key order', () => {
    expect(hashRecallInputs({ a: '1', b: '2' })).toBe(hashRecallInputs({ b: '2', a: '1' }));
  });

  it('changes when a value changes', () => {
    expect(hashRecallInputs({ a: '1' })).not.toBe(hashRecallInputs({ a: '2' }));
  });
});

describe('describeRecallDrift', () => {
  it('names the input, both versions, and reads as a sentence', () => {
    const text = describeRecallDrift({
      kind: 'custom-check',
      reason: 'inputs',
      changed: [{ input: 'eslint-plugin-react-hooks', before: '7.0.1', after: '7.1.1' }],
    });
    expect(text).toContain('custom-check');
    expect(text).toContain('eslint-plugin-react-hooks');
    expect(text).toContain('7.0.1');
    expect(text).toContain('7.1.1');
  });

  it('explains an absent baseline in terms a reader can act on', () => {
    const text = describeRecallDrift({
      kind: 'secret',
      reason: 'absent-from-baseline',
      changed: [],
    });
    expect(text).toContain('secret');
    expect(text.toLowerCase()).toContain('baseline');
  });

  it('the shared remedy names the command that fixes it', () => {
    expect(RECALL_DRIFT_REMEDY).toContain('baseline create');
  });
});
