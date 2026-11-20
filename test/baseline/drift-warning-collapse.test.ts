import { describe, it, expect } from 'vitest';
import { formatDriftWarningSummary } from '../../src/baseline/check-renderers';
import type { ClassifiedPair } from '../../src/baseline/check';

/**
 * gh #157: the envelope-drift warning WALL collapses to ONE summary line, and
 * names the truer gate-just-enabled cause when it applies — so a policy.json
 * edit or a dxkit upgrade doesn't bury the specific warnings under dozens of
 * `config_drift` lines.
 */

function driftPair(reasonCode: string): ClassifiedPair {
  return {
    classification: {
      status: 'config_drift',
      reasons: [{ code: reasonCode, detail: 'x' }],
      blocks: false,
      warns: true,
    },
  } as unknown as ClassifiedPair;
}

describe('formatDriftWarningSummary', () => {
  it('collapses N drift warnings into a single summary line with the count', () => {
    const out = formatDriftWarningSummary(
      [driftPair('config-drift'), driftPair('config-drift'), driftPair('config-drift')],
      '  ',
    );
    // One headline line + one guidance line — NOT one line per finding.
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('3 findings unmatched after an envelope change');
    expect(out[1]).toContain('--json');
  });

  it('names the gate-just-enabled cause when every drift finding is a new dimension', () => {
    const out = formatDriftWarningSummary(
      [driftPair('dimension-newly-measured'), driftPair('dimension-newly-measured')],
      '  ',
    );
    expect(out[0]).toMatch(/gate\/dimension was newly enabled/);
  });

  it('reports a partial gate-enabled breakdown when mixed with generic drift', () => {
    const out = formatDriftWarningSummary(
      [driftPair('dimension-newly-measured'), driftPair('config-drift')],
      '  ',
    );
    expect(out[0]).toContain('2 findings');
    expect(out[0]).toMatch(/1 from a newly-enabled gate\/dimension/);
  });

  it('falls back to the generic envelope-change cause when none are gate-enabled', () => {
    const out = formatDriftWarningSummary([driftPair('config-drift')], '  ');
    expect(out[0]).toMatch(/dxkit upgrade or policy\/config change/);
    expect(out[0]).toContain('1 finding unmatched');
  });
});

/**
 * VERIFY-39 F-6: the TOOLING-drift wall collapses to one summary block per
 * KIND. On a pre-Rule-19 baseline the entire backlog demotes at once — a real
 * repo produced 18,396 four-line drift blocks (73,665 console lines) that
 * buried the verdict. Same disease as gh #157, one status over.
 */

import { formatToolingDriftSummary } from '../../src/baseline/check-renderers';

function toolingPair(kind: string, file: string, line: number, detail?: string): ClassifiedPair {
  return {
    pair: { currentId: `fp-${file}-${line}`, status: 'added', confidence: 1, reasons: [] },
    kind,
    file,
    line,
    locator: `${file}:${line}`,
    classification: {
      status: 'tooling_drift',
      reasons: [
        { code: 'no-prior-match', detail: 'identity fingerprint not present in the baseline' },
        {
          code: 'tooling-drift',
          detail: detail ?? 'the baseline predates recall attribution',
        },
      ],
      blocks: false,
      warns: true,
    },
  } as unknown as ClassifiedPair;
}

describe('formatToolingDriftSummary (F-6)', () => {
  it('collapses N same-kind drift findings into ONE block: count + cause + exemplar + remedy', () => {
    const pairs = Array.from({ length: 500 }, (_, i) =>
      toolingPair('custom-check', `src/f${i}.ts`, i + 1),
    );
    const out = formatToolingDriftSummary(pairs, '  ');
    // Bounded output regardless of finding count — the whole point.
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]).toContain('500 custom-check findings demoted to TOOLING-DRIFT');
    expect(out[0]).toContain('the baseline predates recall attribution');
    expect(out[1]).toContain('e.g. src/f0.ts:1');
    expect(out[out.length - 1]).toContain('--json');
    expect(out[out.length - 1]).toContain('re-baseline');
  });

  it('groups per kind — each kind gets its own count, cause, and exemplar', () => {
    const out = formatToolingDriftSummary(
      [
        toolingPair('custom-check', 'a.ts', 1),
        toolingPair('custom-check', 'b.ts', 2),
        toolingPair('dep-vuln', 'package.json', 1, 'osv-scanner version changed'),
      ],
      '  ',
    );
    expect(out.join('\n')).toContain('2 custom-check findings');
    expect(out.join('\n')).toContain('1 dep-vuln finding');
    expect(out.join('\n')).toContain('osv-scanner version changed');
  });

  it('singular form for one finding', () => {
    const out = formatToolingDriftSummary([toolingPair('secret', 'x.env', 3)], '  ');
    expect(out[0]).toContain('1 secret finding demoted');
  });
});

/**
 * The PR comment LISTS tooling-drift findings, bounded per kind. It used to
 * carry only "N custom-check" with no rows, so a reviewer could not see what
 * a newly added check reported (its findings demote to tooling drift until
 * the first refresh re-captures its recall) until after that refresh.
 */

import {
  markdownToolingDriftRows,
  MAX_TOOLING_DRIFT_ROWS_PER_KIND,
} from '../../src/baseline/check-renderers';

describe('markdownToolingDriftRows (PR comment)', () => {
  it('lists each finding of a newly added check with its location', () => {
    const pairs = [
      toolingPair('custom-check', 'src/routes.ts', 12),
      toolingPair('custom-check', 'src/client.ts', 40),
    ];
    const md = markdownToolingDriftRows(pairs).join('\n');
    expect(md).toContain('| Kind | Severity | Location | Fingerprint |');
    expect(md).toContain('src/routes.ts:12');
    expect(md).toContain('src/client.ts:40');
    expect(md).not.toContain('Not shown');
  });

  it('caps rows per kind so a brownfield demotion cannot flood the comment, naming what is hidden', () => {
    const many = Array.from({ length: 500 }, (_, i) => toolingPair('dep-vuln', `pkg${i}`, 0));
    const fresh = [toolingPair('custom-check', 'src/new.ts', 3)];
    const lines = markdownToolingDriftRows([...many, ...fresh]);
    const rows = lines.filter((l) => l.startsWith('| ') && !l.startsWith('| Kind'));
    expect(rows).toHaveLength(MAX_TOOLING_DRIFT_ROWS_PER_KIND + 1);
    // The small kind is still shown even though the big one sorts first.
    expect(lines.join('\n')).toContain('src/new.ts:3');
    expect(lines.join('\n')).toContain(
      `Not shown: ${500 - MAX_TOOLING_DRIFT_ROWS_PER_KIND} dep-vuln`,
    );
  });
});
