/**
 * The circuit breaker (remediate rethink 3F), both directions: a class
 * pauses after N consecutive counted failures, and every unpause condition
 * lifts it with a disclosure (a policy change, a dxkit change, an explicit
 * dispatch, a success resetting the streak). Refusals and infrastructure
 * are neutral: they neither count nor reset, because nothing was tried.
 * Plus the gather integration: the ONE plan entry point applies the marks,
 * so the plan CLI and the recipe phase can never see different pause sets.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyClassPauses,
  evaluateClassPauses,
  remediateStamp,
  type RemediateStamp,
} from '../../../src/remediate/work-orders/breaker';
import {
  ORDER_LEDGER_SCHEMA_VERSION,
  type OrderOutcomeRow,
  type OrderRowOutcome,
} from '../../../src/lanes/order-ledger';
import { planRepoWorkOrders } from '../../../src/remediate/work-orders/gather';
import { resolveRemediateConfig } from '../../../src/remediate/config';
import type { WorkOrderPlan } from '../../../src/remediate/work-orders/types';

const STAMP: RemediateStamp = { dxkitVersion: '4.4.5', policyHash: 'hash-a' };

let tick = 0;
function row(outcome: OrderRowOutcome, overrides: Partial<OrderOutcomeRow> = {}): OrderOutcomeRow {
  tick += 1;
  return {
    schema_version: ORDER_LEDGER_SCHEMA_VERSION,
    timestamp: `2026-08-${String(10 + tick).padStart(2, '0')}T00:00:00.000Z`,
    lane: 'remediate',
    task: 'fix-vulns',
    orderId: `dep-advisory:pkg${tick}`,
    class: 'dep-advisory',
    tier: 'recipe',
    outcome,
    dxkitVersion: STAMP.dxkitVersion,
    policyHash: STAMP.policyHash,
    ...overrides,
  };
}

function evaluate(
  rows: OrderOutcomeRow[],
  opts: Partial<Parameters<typeof evaluateClassPauses>[1]> = {},
) {
  return evaluateClassPauses(rows, { threshold: 2, current: STAMP, ...opts });
}

describe('evaluateClassPauses', () => {
  it('pauses a class after N consecutive counted failures, with reason + unpause conditions', () => {
    const { pauses } = evaluate([row('guardrail-red'), row('failed-recipe')]);
    const pause = pauses.get('dep-advisory');
    expect(pause).toBeDefined();
    expect(pause!.failures).toBe(2);
    expect(pause!.reason).toContain('paused to stop re-spending');
    expect(pause!.unpause).toContain('fix-vulns');
    expect(pause!.unpause).toContain('policy');
  });

  it('one failure under the default threshold does not pause', () => {
    const { pauses } = evaluate([row('guardrail-red')]);
    expect(pauses.size).toBe(0);
  });

  it('a SUCCESS resets the streak (verified, and a budget-cut verified partial)', () => {
    for (const success of ['verified', 'budget-exhausted-verified'] as const) {
      const { pauses } = evaluate([row('guardrail-red'), row('floor-red'), row(success)]);
      expect(pauses.size).toBe(0);
    }
  });

  it('refused / never-ran / not-dispatched / paused rows neither count nor reset', () => {
    const { pauses } = evaluate([
      row('guardrail-red'),
      row('refused'),
      row('never-ran'),
      row('paused'),
      row('not-dispatched'),
      row('floor-red'),
    ]);
    expect(pauses.get('dep-advisory')?.failures).toBe(2);
    // And neutral-only history never pauses.
    const neutral = evaluate([row('refused'), row('refused'), row('refused')]);
    expect(neutral.pauses.size).toBe(0);
  });

  it('a dxkit version change since the latest failure LIFTS the pause, disclosed', () => {
    const rows = [row('guardrail-red'), row('guardrail-red')];
    const { pauses, disclosures } = evaluate(rows, {
      current: { ...STAMP, dxkitVersion: '4.4.6' },
    });
    expect(pauses.size).toBe(0);
    expect(disclosures.some((d) => d.includes('dxkit changed'))).toBe(true);
  });

  it('a remediate policy change since the latest failure LIFTS the pause, disclosed', () => {
    const rows = [row('guardrail-red'), row('guardrail-red')];
    const { pauses, disclosures } = evaluate(rows, { current: { ...STAMP, policyHash: 'hash-b' } });
    expect(pauses.size).toBe(0);
    expect(disclosures.some((d) => d.includes('policy changed'))).toBe(true);
  });

  it('an explicit dispatch of the owning task overrides the pause for its classes only, disclosed', () => {
    const rows = [
      row('guardrail-red'),
      row('guardrail-red'),
      row('failed-recipe', { class: 'lint-located', task: 'fix-lint' }),
      row('failed-recipe', { class: 'lint-located', task: 'fix-lint' }),
    ];
    const { pauses, disclosures } = evaluate(rows, { dispatchedTask: 'fix-vulns' });
    expect(pauses.has('dep-advisory')).toBe(false);
    expect(pauses.has('lint-located')).toBe(true);
    expect(disclosures.some((d) => d.includes('dispatched explicitly'))).toBe(true);
  });

  it('threshold 0 disables the breaker entirely', () => {
    const { pauses } = evaluate([row('guardrail-red'), row('guardrail-red')], { threshold: 0 });
    expect(pauses.size).toBe(0);
  });

  it('classes are independent: an unrelated class failing never pauses a healthy one', () => {
    const { pauses } = evaluate([
      row('guardrail-red', { class: 'lint-located' }),
      row('guardrail-red', { class: 'lint-located' }),
      row('verified'),
    ]);
    expect(pauses.has('lint-located')).toBe(true);
    expect(pauses.has('dep-advisory')).toBe(false);
  });
});

describe('applyClassPauses', () => {
  it('marks exactly the paused class orders, preserving plan order', () => {
    const plan: WorkOrderPlan = {
      orders: [
        { id: 'a', class: 'dep-advisory' },
        { id: 'b', class: 'lint-located' },
      ].map((o) => ({
        ...o,
        findings: [],
        envelope: { paths: ['x'], manifests: false },
        constraints: { forbidden: [] },
        done: { absentIds: [], verifier: 'floor' as const, command: 'x' },
        budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
        tier: 'agent' as const,
        provenance: { source: 'guardrail-blocking' as const },
      })),
      undispatchable: [],
    };
    const { pauses } = evaluate([row('guardrail-red'), row('guardrail-red')]);
    const marked = applyClassPauses(plan, pauses);
    expect(marked.orders[0].paused?.reason).toContain('failures');
    expect(marked.orders[1].paused).toBeUndefined();
    expect(marked.orders.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('remediateStamp', () => {
  it('is deterministic and changes when the remediate policy section changes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-stamp-'));
    fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.dxkit', 'policy.json'), '{"remediate":{"enabled":true}}');
    const a = remediateStamp(cwd);
    expect(remediateStamp(cwd)).toEqual(a);
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'policy.json'),
      '{"remediate":{"enabled":true,"tasks":["fix-lint"]}}',
    );
    const b = remediateStamp(cwd);
    expect(b.policyHash).not.toBe(a.policyHash);
    expect(b.dxkitVersion).toBe(a.dxkitVersion);
    // A change OUTSIDE the remediate section is not a remediate policy change.
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'policy.json'),
      '{"remediate":{"enabled":true,"tasks":["fix-lint"]},"loop":{"preset":"security-only"}}',
    );
    expect(remediateStamp(cwd).policyHash).toBe(b.policyHash);
  });
});

describe('gather integration (the ONE plan entry point applies the marks)', () => {
  function lintBaselineRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-breaker-gather-'));
    fs.mkdirSync(path.join(cwd, '.dxkit', 'baselines'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fx","version":"0.0.0"}');
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'baselines', 'main.json'),
      JSON.stringify({
        schemaVersion: 'dxkit-baseline/v1',
        name: 'main',
        createdAt: '2026-08-01T00:00:00.000Z',
        repo: { commitSha: 'base', branch: 'main', dirty: false },
        analysis: { dxkitVersion: 'test', toolchainHash: 'x' },
        tools: {},
        saltMode: 'none',
        findings: [
          {
            id: 'lint1',
            kind: 'custom-check',
            check: 'lint:typescript',
            blocking: true,
            file: 'src/a.ts',
            line: 3,
            rule: 'no-unused-vars',
          },
        ],
      }),
    );
    return cwd;
  }

  it('injected failure history pauses the class in the plan; explicit dispatch lifts it', async () => {
    const cwd = lintBaselineRepo();
    const config = resolveRemediateConfig(cwd);
    const history = [
      row('guardrail-red', { class: 'lint-located', task: 'fix-lint' }),
      row('guardrail-red', { class: 'lint-located', task: 'fix-lint' }),
    ];
    const paused = await planRepoWorkOrders(cwd, config, { history, stamp: STAMP });
    expect(paused.plan.orders.length).toBeGreaterThan(0);
    expect(paused.plan.orders.every((o) => o.paused)).toBe(true);
    expect(paused.pauses.map((p) => p.class)).toEqual(['lint-located']);

    const dispatched = await planRepoWorkOrders(cwd, config, {
      history,
      stamp: STAMP,
      dispatchedTask: 'fix-lint',
    });
    expect(dispatched.plan.orders.every((o) => o.paused === undefined)).toBe(true);
    expect(dispatched.pauses).toEqual([]);
    expect(dispatched.disclosures.some((d) => d.includes('dispatched explicitly'))).toBe(true);
  });

  it('remediate.pauseAfterFailures: 0 turns the breaker off at the plan entry point', async () => {
    const cwd = lintBaselineRepo();
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'policy.json'),
      '{"remediate":{"pauseAfterFailures":0}}',
    );
    const config = resolveRemediateConfig(cwd);
    expect(config.pauseAfterFailures).toBe(0);
    const out = await planRepoWorkOrders(cwd, config, {
      history: [
        row('guardrail-red', { class: 'lint-located' }),
        row('guardrail-red', { class: 'lint-located' }),
      ],
      stamp: STAMP,
    });
    expect(out.plan.orders.every((o) => o.paused === undefined)).toBe(true);
  });
});
