/**
 * The coverage-parity matrix net (4.3.2 item 3 — the class-killer).
 *
 * The week's three defects shared one shape: a correct mechanism silently
 * switching off a coverage path at a subsystem seam (trust×diff,
 * manifest×policy, allowlist×refresh), with no disclosure. This net pins the
 * invariant that kills the class:
 *
 * > For every finding kind × surface: either the kind is OBSERVED on that
 * > surface, or the output SAYS why not.
 *
 * Surfaces are (mode, trust, scope) triples driven through the real
 * `runGuardrailCheck` on one fixture repo whose baseline holds two kinds with
 * different observation profiles:
 *   - `custom-check` — observed only when the seam may spawn (trust) and the
 *     gather is in scope; its observation record is `CustomChecksUnobserved`;
 *   - `large-file` — read from the unscoped Layer-0 metrics, so observed on
 *     EVERY surface (the control row: a disclosure for it would be
 *     over-disclosure).
 *
 * The disclosure channels a cell may answer with: `notObserved` (the seam /
 * kind-level record), `refExcludedKinds` (ref-based structural exclusion),
 * `depVulnsUnmeasured`, `deferredCapture`, or per-kind recall drift. The
 * scope- and scanner-level causes for native kinds (secret / code / dep-vuln
 * / duplication / test-gap / stale-file / license) are covered at unit level
 * through the pure `kindNotObservedReason` — an e2e secret cell would need a
 * key-shaped literal in this file, which the self-guardrail would rightly
 * flag as a net-new secret (the 4.3.0 lesson).
 *
 * A synthetic-injection tail proves the net BITES: a doctored result with the
 * lie state (all pairs of a kind minted `removed`, disclosures stripped) must
 * be flagged by the same helper every cell uses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createBaseline } from '../../src/baseline/create';
import {
  runGuardrailCheck,
  kindNotObservedReason,
  type GuardrailCheckResult,
} from '../../src/baseline/check';
import {
  FULL_SCOPE,
  KIND_OBSERVATION_SCOPE,
  scopeForRefBasedDiff,
} from '../../src/baseline/gather-scope';
import type { BaselineEntry } from '../../src/baseline/types';
import type { SecurityAggregate } from '../../src/analyzers/security/aggregator';
import { trustedLocalContext, untrustedContentContext } from '../../src/analysis-trust';

// ─── The one invariant every cell asserts ──────────────────────────────────

/**
 * Kinds in the lie state on this result: every pair of the kind reads
 * `removed` ("resolved") — or the kind vanished from the diff entirely —
 * while NO disclosure channel says why. Empty on an honest result. This is
 * the net's single predicate; each matrix cell runs it, and the injection
 * test proves it flags a doctored result.
 */
function observationViolations(result: GuardrailCheckResult): string[] {
  const kinds = [...new Set(result.baseline.findings.map((e) => e.kind))];
  const violations: string[] = [];
  for (const kind of kinds) {
    const pairs = result.pairs.filter((p) => p.kind === kind);
    const lieState =
      pairs.length === 0 || pairs.every((p) => p.classification.status === 'removed');
    if (!lieState) continue;
    const disclosed =
      result.notObserved.some((d) => d.kind === kind) ||
      result.refExcludedKinds.some((e) => e.kind === kind) ||
      (kind === 'dep-vuln' && result.depVulnsUnmeasured !== undefined) ||
      (result.deferredCapture ?? []).length > 0 ||
      result.envelopeDrift.recallDrift.some((d) => d.kind === kind);
    if (!disclosed) violations.push(kind);
  }
  return violations.sort();
}

// ─── The matrix (integration) ──────────────────────────────────────────────

describe('coverage-parity matrix — every kind × surface observes or discloses', () => {
  let dir: string;
  let cells: Record<'trustedFull' | 'untrusted' | 'scoped' | 'refBased', GuardrailCheckResult>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-coverage-parity-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    // A file over the large-file threshold (500): the always-observed kind.
    writeFileSync(
      join(dir, 'big.js'),
      Array.from({ length: 600 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n',
    );
    // A check with two located findings: the trust/scope-sensitive kind.
    writeFileSync(
      join(dir, 'lint.cjs'),
      // Fixture CONTENT: the fake linter's stdout, parsed by the regex below.
      'console.log("src/a.js:1: no-unused-vars broken");\n' + // slop-ok
        'console.log("src/b.js:2: eqeqeq broken");\n' + // slop-ok
        'process.exit(1);\n',
    );
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'policy.json'),
      JSON.stringify({
        checks: [
          {
            name: 'fake-lint',
            command: ['node', 'lint.cjs'],
            blocking: false,
            parse: { regex: '^(?<file>[^:]+):(?<line>\\d+): (?<rule>\\S+) (?<message>.*)$' },
          },
        ],
      }),
    );
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });

    await createBaseline({ cwd: dir });
    cells = {
      trustedFull: await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir }),
      untrusted: await runGuardrailCheck({ trust: untrustedContentContext(), cwd: dir }),
      scoped: await runGuardrailCheck({
        trust: trustedLocalContext(),
        cwd: dir,
        scope: { ...FULL_SCOPE, customChecks: false },
      }),
      refBased: await runGuardrailCheck({
        trust: trustedLocalContext(),
        cwd: dir,
        cliMode: 'ref-based',
        cliRef: 'HEAD',
      }),
    };
  }, 300_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the fixture seeds both observation profiles', () => {
    const kinds = new Set(cells.trustedFull.baseline.findings.map((e) => e.kind));
    expect(kinds.has('custom-check')).toBe(true);
    expect(kinds.has('large-file')).toBe(true);
  });

  it('no cell is in the lie state — the invariant holds on every surface', () => {
    for (const [name, result] of Object.entries(cells)) {
      expect({ cell: name, violations: observationViolations(result) }).toEqual({
        cell: name,
        violations: [],
      });
    }
  });

  it('trusted full-scope: everything observed, zero disclosures (no over-disclosure)', () => {
    const r = cells.trustedFull;
    for (const kind of ['custom-check', 'large-file'] as const) {
      const pairs = r.pairs.filter((p) => p.kind === kind);
      expect(pairs.length).toBeGreaterThan(0);
      for (const p of pairs) expect(p.classification.status).toBe('persisted');
    }
    expect(r.notObserved).toEqual([]);
    expect(r.refExcludedKinds).toEqual([]);
  });

  it('untrusted: custom-check answers via notObserved; large-file stays observed', () => {
    const r = cells.untrusted;
    const cc = r.pairs.filter((p) => p.kind === 'custom-check');
    expect(cc.length).toBe(2);
    for (const p of cc) expect(p.classification.status).toBe('not_observed');
    expect(r.notObserved.some((d) => d.kind === 'custom-check' && d.count === 2)).toBe(true);
    for (const p of r.pairs.filter((q) => q.kind === 'large-file')) {
      expect(p.classification.status).toBe('persisted');
    }
  });

  it('scoped-out gather: custom-check answers via notObserved with the scope reason', () => {
    const r = cells.scoped;
    const cc = r.pairs.filter((p) => p.kind === 'custom-check');
    expect(cc.length).toBe(2);
    for (const p of cc) expect(p.classification.status).toBe('not_observed');
    const d = r.notObserved.find((x) => x.kind === 'custom-check');
    expect(d?.count).toBe(2);
    expect(d?.reason).toContain('outside the gather scope');
    for (const p of r.pairs.filter((q) => q.kind === 'large-file')) {
      expect(p.classification.status).toBe('persisted');
    }
  });

  it('ref-based: custom-check answers via refExcludedKinds; large-file diffs normally', () => {
    const r = cells.refBased;
    expect(r.refExcludedKinds.some((e) => e.kind === 'custom-check')).toBe(true);
    expect(r.pairs.filter((p) => p.kind === 'custom-check')).toEqual([]);
    const lf = r.pairs.filter((p) => p.kind === 'large-file');
    expect(lf.length).toBeGreaterThan(0);
    for (const p of lf) expect(p.classification.status).toBe('persisted');
  });

  it('INJECTION: the net bites — the doctored lie state is flagged', () => {
    const base = cells.untrusted;
    const doctored: GuardrailCheckResult = {
      ...base,
      // Re-mint the unobserved pairs as `removed` and strip every disclosure —
      // exactly the pre-4.3.2 output shape ("Resolved (18406)", silence).
      pairs: base.pairs.map((p) =>
        p.kind === 'custom-check'
          ? { ...p, classification: { ...p.classification, status: 'removed' as const } }
          : p,
      ),
      notObserved: [],
    };
    expect(observationViolations(doctored)).toEqual(['custom-check']);
  });
});

// ─── kindNotObservedReason (unit — the scope- and scanner-level causes) ────

const RAN_PROVENANCE: SecurityAggregate['provenance'] = {
  secrets: { tool: 'gitleaks', ran: true },
  codePatterns: { tool: 'semgrep', ran: true },
  tlsBypass: { ran: true, patternCount: 0 },
  fileFindings: { ran: true },
  depVulns: { tool: 'osv-scanner', available: true, unavailableReason: '' },
};

describe('kindNotObservedReason', () => {
  const committed = (
    kind: BaselineEntry['kind'],
    over: Partial<Parameters<typeof kindNotObservedReason>[1]>,
  ) =>
    kindNotObservedReason(kind, {
      mode: 'committed-full',
      scope: FULL_SCOPE,
      provenance: RAN_PROVENANCE,
      ...over,
    });

  it('is silent in ref-based mode — both sides gather in the same environment', () => {
    for (const kind of ['secret', 'code', 'dep-vuln', 'duplication'] as const) {
      expect(
        kindNotObservedReason(kind, {
          mode: 'ref-based',
          scope: { ...FULL_SCOPE, secrets: false, duplication: false },
          provenance: { ...RAN_PROVENANCE, secrets: { tool: null, ran: false } },
        }),
      ).toBeUndefined();
    }
  });

  it('names the scoped-out gather for each scope-dependent kind', () => {
    const cases: Array<[BaselineEntry['kind'], keyof typeof FULL_SCOPE]> = [
      ['secret', 'secrets'],
      ['secret-hmac', 'secrets'],
      ['code', 'codePatterns'],
      ['dep-vuln', 'depVulns'],
      ['duplication', 'duplication'],
      ['test-gap', 'testGaps'],
      ['test-file-degradation', 'testGaps'],
      ['stale-file', 'hygiene'],
      ['license', 'licenses'],
    ];
    for (const [kind, flag] of cases) {
      const reason = committed(kind, { scope: { ...FULL_SCOPE, [flag]: false } });
      expect(reason).toContain('outside this run');
      expect(reason).toContain(flag);
    }
  });

  it('reads scanner-did-not-run off the aggregate provenance', () => {
    expect(
      committed('secret', {
        provenance: { ...RAN_PROVENANCE, secrets: { tool: null, ran: false } },
      }),
    ).toContain('no secret scanner ran');
    expect(
      committed('secret-hmac', {
        provenance: { ...RAN_PROVENANCE, secrets: { tool: null, ran: false } },
      }),
    ).toContain('no secret scanner ran');
    expect(
      committed('code', {
        provenance: { ...RAN_PROVENANCE, codePatterns: { tool: null, ran: false } },
      }),
    ).toContain('did not run');
    expect(
      committed('dep-vuln', {
        provenance: {
          ...RAN_PROVENANCE,
          depVulns: { tool: null, available: false, unavailableReason: 'not installed' },
        },
      }),
    ).toContain('could not run');
  });

  it('is silent when everything requested actually ran', () => {
    for (const kind of Object.keys(KIND_OBSERVATION_SCOPE) as Array<BaselineEntry['kind']>) {
      expect(committed(kind, {})).toBeUndefined();
    }
  });

  it('always-observed kinds stay silent even under a minimal scope', () => {
    const minimal = Object.fromEntries(
      Object.keys(FULL_SCOPE).map((k) => [k, false]),
    ) as unknown as typeof FULL_SCOPE;
    for (const kind of ['large-file', 'config', 'stale-allow'] as const) {
      expect(committed(kind, { scope: minimal })).toBeUndefined();
    }
  });
});

// ─── table consistency ─────────────────────────────────────────────────────

describe('KIND_OBSERVATION_SCOPE stays consistent with its siblings', () => {
  it('scopeForRefBasedDiff still skips exactly its four kinds', () => {
    const { skippedKinds } = scopeForRefBasedDiff(FULL_SCOPE);
    expect([...skippedKinds].sort()).toEqual([
      'custom-check',
      'duplication',
      'license',
      'test-gap',
    ]);
  });

  it('custom-check declares no scope flags here — the seam record owns it', () => {
    expect(KIND_OBSERVATION_SCOPE['custom-check']).toEqual([]);
  });
});
