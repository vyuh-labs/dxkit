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
  it('pauses a class after N consecutive counted failures, with reason + the exact override commands', () => {
    const { pauses } = evaluate([row('guardrail-red'), row('failed-recipe')]);
    const pause = pauses.get('dep-advisory');
    expect(pause).toBeDefined();
    expect(pause!.failures).toBe(2);
    expect(pause!.reason).toContain('paused to stop re-spending');
    // The remedy is a WORKING command on both paths: the explicit CLI flag
    // and the workflow dispatch, plus the stale-template advice.
    expect(pause!.unpause).toContain('vyuh-dxkit remediate --task fix-vulns --dispatch-override');
    expect(pause!.unpause).toContain('vyuh-dxkit update');
    expect(pause!.unpause).toContain('policy');
  });

  it('one red FIRING is one failure event, however many orders of the class it carried', () => {
    // The shared tree verification smears the run verdict onto every
    // committed order: two orders in one red firing must not hit the
    // 2-failure threshold by themselves.
    const ts = '2026-08-20T00:00:00.000Z';
    const one = evaluate([
      row('guardrail-red', { timestamp: ts, orderId: 'dep-advisory:a' }),
      row('guardrail-red', { timestamp: ts, orderId: 'dep-advisory:b' }),
    ]);
    expect(one.pauses.size).toBe(0);
    // A SECOND red firing makes it two events: now the class pauses.
    const two = evaluate([
      row('guardrail-red', { timestamp: ts, orderId: 'dep-advisory:a' }),
      row('guardrail-red', { timestamp: ts, orderId: 'dep-advisory:b' }),
      row('guardrail-red', { timestamp: '2026-08-21T00:00:00.000Z', orderId: 'dep-advisory:a' }),
    ]);
    expect(two.pauses.get('dep-advisory')?.failures).toBe(2);
  });

  it('a firing with a success row alongside a failure row RESETS (the class produced verified work)', () => {
    const ts = '2026-08-20T00:00:00.000Z';
    const { pauses } = evaluate([
      row('guardrail-red'),
      row('guardrail-red'),
      row('failed-recipe', { timestamp: ts, orderId: 'dep-advisory:a' }),
      row('verified', { timestamp: ts, orderId: 'dep-advisory:b' }),
    ]);
    expect(pauses.size).toBe(0);
  });

  it('an aged-out pause is DISCLOSED as the retry-horizon lift, never silent', () => {
    // A paused marker is in the window but the failure evidence is not
    // (it aged past the window boundary): the pause lifts, and the lift
    // is named — an evidence-free silent unpause must not exist.
    const { pauses, disclosures } = evaluate([row('paused')]);
    expect(pauses.size).toBe(0);
    expect(disclosures.some((d) => d.includes('aged out') && d.includes('retry horizon'))).toBe(
      true,
    );
    // With a success in view, the reset explains itself: no age-out note.
    const reset = evaluate([row('paused'), row('verified')]);
    expect(reset.disclosures).toEqual([]);
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

  it('a lift RESETS the counted streak: one new failure after a dxkit change does not re-pause (threshold stays N, never 1)', () => {
    // Two failures under 4.4.5 paused the class; dxkit moved to 4.4.6 and
    // the pause lifted. The next firing fails once. The shipped shape
    // compared only the newest failure's stamp while counting all three,
    // so this single failure re-paused the class at an effective threshold
    // of 1. Only failures under the CURRENT stamp count.
    const rows = [
      row('guardrail-red'),
      row('guardrail-red'),
      row('paused'),
      row('guardrail-red', { dxkitVersion: '4.4.6' }),
    ];
    const { pauses, disclosures } = evaluate(rows, {
      current: { ...STAMP, dxkitVersion: '4.4.6' },
    });
    expect(pauses.size).toBe(0);
    // Not an age-out: the older evidence is in view, it is stale-stamped.
    expect(disclosures.some((d) => d.includes('aged out'))).toBe(false);
    expect(disclosures.some((d) => d.includes('dxkit changed'))).toBe(true);
    // A SECOND current-stamp failure reaches the threshold again: the
    // breaker is reset, not disabled.
    const again = evaluate([...rows, row('guardrail-red', { dxkitVersion: '4.4.6' })], {
      current: { ...STAMP, dxkitVersion: '4.4.6' },
    });
    expect(again.pauses.get('dep-advisory')?.failures).toBe(2);
  });

  it('the same reset holds for a policy change, and the lift is disclosed without a paused marker when the stale streak alone met the threshold', () => {
    const rows = [
      row('failed-recipe', { policyHash: 'hash-old' }),
      row('failed-recipe', { policyHash: 'hash-old' }),
      row('failed-recipe'),
    ];
    const { pauses, disclosures } = evaluate(rows);
    expect(pauses.size).toBe(0);
    expect(disclosures.some((d) => d.includes('policy changed'))).toBe(true);
    // A lone stale failure that never would have paused says nothing.
    const quiet = evaluate([row('failed-recipe', { policyHash: 'hash-old' })]);
    expect(quiet.disclosures).toEqual([]);
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
