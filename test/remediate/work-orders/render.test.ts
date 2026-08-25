/**
 * Work-order rendering: the agent prompt carries the ids, the attribution
 * split, the envelope, the install command (or its disclosed absence), the
 * done command, and the ONE shared ground-rules list; the summary line
 * carries tier + budget; neither uses an em-dash.
 */
import { describe, it, expect } from 'vitest';
import {
  attributionSentence,
  renderWorkOrderPrompt,
  renderWorkOrderSummary,
} from '../../../src/remediate/work-orders/render';
import { SHARED_RULES } from '../../../src/remediate/tasks';
import type { WorkOrder } from '../../../src/remediate/work-orders/types';

const ORDER: WorkOrder = {
  id: 'dep-advisory:axios',
  class: 'dep-advisory',
  findings: [
    {
      kind: 'dep-vuln',
      id: 'aaaa000011112222',
      attribution: 'net-new',
      evidence: {
        type: 'dep-vuln',
        package: 'axios',
        installedVersion: '1.6.0',
        advisoryId: 'GHSA-1',
        fixedVersion: '1.7.0',
        reachable: true,
        severity: 'high',
      },
    },
    {
      kind: 'dep-vuln',
      id: 'bbbb000011112222',
      attribution: 'deferred',
      evidence: {
        type: 'dep-vuln',
        package: 'axios',
        advisoryId: 'GHSA-2',
        expiresAt: '2026-09-01',
      },
    },
  ],
  envelope: { paths: ['package.json', 'pnpm-lock.yaml'], manifests: true },
  constraints: {
    install: { bin: 'pnpm', args: ['install'] },
    forbidden: ['editing anything outside the envelope'],
  },
  done: {
    absentIds: ['aaaa000011112222', 'bbbb000011112222'],
    verifier: 'guardrail',
    command: 'npx vyuh-dxkit guardrail check',
  },
  budget: { turns: 16, minutes: 9, usd: 1, derivation: 'turns = min(80, max(10, 8 + 4 * 2)) = 16' },
  tier: 'recipe',
  recipe: 'override-pin',
  provenance: { source: 'advisories', blocking: 1, deferred: 1, earliestExpiry: '2026-09-01' },
};

describe('renderWorkOrderPrompt', () => {
  const text = renderWorkOrderPrompt(ORDER);

  it('names every finding id and its structured evidence', () => {
    expect(text).toContain('aaaa000011112222');
    expect(text).toContain('bbbb000011112222');
    expect(text).toContain('GHSA-1');
    expect(text).toContain('fixed in 1.7.0');
    expect(text).toContain('reachable from your code');
    expect(text).toContain('deferred until 2026-09-01');
  });

  it('carries the attribution split sentence', () => {
    expect(text).toContain('1 of these are net-new');
    expect(text).toContain('1 are deferred advisories');
    expect(text).toContain('Everything else in the repo is grandfathered');
  });

  it('carries the envelope, the pack-declared install command, and the constraints', () => {
    expect(text).toContain('- package.json');
    expect(text).toContain('- pnpm-lock.yaml');
    expect(text).toContain('manifests and lockfiles inside the envelope may change');
    expect(text).toContain('installs with: pnpm install');
    expect(text).toContain('do not: editing anything outside the envelope');
  });

  it('discloses a missing install command instead of guessing one', () => {
    const none = renderWorkOrderPrompt({ ...ORDER, constraints: { forbidden: [] } });
    expect(none).toContain('no install command is known for this repo');
    expect(none).not.toContain('npm ci');
  });

  it('carries the done command, the budget derivation, and the ONE shared ground rules list', () => {
    expect(text).toContain('Check with: npx vyuh-dxkit guardrail check');
    expect(text).toContain('16 turns, 9 minutes, $1');
    expect(text).toContain('turns = min(80, max(10, 8 + 4 * 2)) = 16');
    expect(text.endsWith(SHARED_RULES)).toBe(true);
  });

  it('renders the captured output tail once per order and every importer of a floor finding', () => {
    const floor: WorkOrder = {
      ...ORDER,
      id: 'unresolved-import:typescript:.',
      class: 'unresolved-import',
      outputTail: 'the tail',
      findings: [
        {
          kind: 'floor-check',
          id: 'typescript/import-resolution#lodash',
          attribution: 'net-new',
          evidence: {
            type: 'floor',
            pack: 'typescript',
            label: 'import-resolution',
            command: '',
            specifier: 'lodash',
            importingFiles: ['src/a.ts', 'src/z.ts'],
          },
        },
      ],
    };
    const t = renderWorkOrderPrompt(floor);
    expect(t).toContain('imported by src/a.ts, src/z.ts');
    expect(t.split('the tail')).toHaveLength(2);
  });

  it('uses no em-dash in the order prose (the appended shared rules are the existing task constant)', () => {
    expect(text.slice(0, text.length - SHARED_RULES.length)).not.toContain('—');
    expect(renderWorkOrderSummary(ORDER)).not.toContain('—');
    expect(attributionSentence(ORDER)).not.toContain('—');
  });
});

describe('renderWorkOrderSummary', () => {
  it('is one line with id, count, attribution, tier + recipe, budget, verifier', () => {
    const line = renderWorkOrderSummary(ORDER);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('dep-advisory:axios');
    expect(line).toContain('2 finding(s)');
    expect(line).toContain('net-new');
    expect(line).toContain('recipe override-pin (declared, not yet executable)');
    expect(line).toContain('16 turns / 9 min / $1');
    expect(line).toContain('done via guardrail');
  });

  it('says agent for an agent-tier order and debt for a pre-existing-only order', () => {
    const debt: WorkOrder = {
      ...ORDER,
      tier: 'agent',
      recipe: undefined,
      findings: ORDER.findings.map((f) => ({ ...f, attribution: 'pre-existing' })),
    };
    const line = renderWorkOrderSummary(debt);
    expect(line).toContain('tier agent');
    expect(line).toContain('debt');
  });
});
