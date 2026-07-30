/**
 * DELIVERY: the lapse projection reaches all three check surfaces.
 *
 * The whole point of the projection is that the computation already existed and
 * was never delivered — `auditAllowlist` has known which suppressions expire
 * soon since the allowlist shipped, reachable only from `doctor` and
 * `allowlist audit`, two commands nobody runs on a normal day. A projection
 * computed onto the result and rendered by only ONE of the three surfaces would
 * reproduce the same bug one layer in (the same discipline `GateFailure` is
 * pinned by: console / JSON / markdown, or it did not ship).
 *
 * Both directions, because over-disclosure is its own failure: an empty
 * projection must be SILENT on every surface. A "nothing expiring" section on
 * every run trains readers to skip the exact area where the real warning
 * eventually appears.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck, type GuardrailCheckResult } from '../../src/baseline/check';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';
import {
  EXPIRY_PROJECTION_REMEDY,
  type ExpiryProjection,
} from '../../src/baseline/expiry-projection';
import { SOON_TO_EXPIRE_DAYS } from '../../src/allowlist/file';
import { trustedLocalContext } from '../../src/analysis-trust';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-expiry-render-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  writeFileSync(join(dir, 'src', 'index.js'), 'module.exports = () => 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** A populated projection covering both consequence tiers and the whole
 *  reporting range (lapses today, and lapses inside the horizon). */
const LAPSING: ExpiryProjection = {
  horizonDays: SOON_TO_EXPIRE_DAYS,
  lapsing: [
    {
      source: 'finding',
      fingerprint: 'aaaa111122223333',
      category: 'deferred',
      expiresAt: '2026-08-01',
      daysRemaining: 3,
      consequence: 'block',
      subject: 'dep-vuln package-lock.json:1',
    },
    {
      source: 'flow',
      fingerprint: 'bbbb111122223333',
      category: 'accepted-risk',
      expiresAt: '2026-08-05',
      daysRemaining: 7,
      consequence: 'warn',
      subject: 'GET /api/orders',
    },
  ],
  willBlock: 1,
  willWarn: 1,
  nextLapseDays: 3,
};

describe('the lapse projection reaches every check surface', () => {
  let base: GuardrailCheckResult;
  let dir: string;

  beforeAll(async () => {
    dir = makeRepo();
    await createBaseline({ cwd: dir });
    base = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a real run computes the projection (the field is not just a type)', () => {
    // No allowlist in this repo, so nothing is suppressed and nothing can lapse
    // — but the projection is still COMPUTED, with the shared horizon.
    expect(base.suppressionExpiry).toBeDefined();
    expect(base.suppressionExpiry.horizonDays).toBe(SOON_TO_EXPIRE_DAYS);
    expect(base.suppressionExpiry.lapsing).toEqual([]);
    expect(base.suppressionExpiry.willBlock).toBe(0);
  });

  it('is SILENT on all three surfaces when nothing expires', () => {
    expect(renderConsole(base)).not.toContain('Suppressions expiring');
    expect(renderConsole(base)).not.toContain('Expiring:');
    expect(renderMarkdown(base)).not.toContain('Suppressions expiring');
    // JSON always carries the field (an agent reads it without probing), but it
    // says plainly that nothing is pending.
    expect(renderJson(base).suppressionExpiry.lapsing).toEqual([]);
  });

  it('console names the count, the countdown, the consequence, and the remedy', () => {
    const out = renderConsole({ ...base, suppressionExpiry: LAPSING });
    expect(out).toContain('Suppressions expiring (2)');
    expect(out).toContain('2 allowlist suppressions expire within 14 days');
    expect(out).toContain('next in 3d');
    expect(out).toContain('1 will BLOCK');
    expect(out).toContain('dep-vuln package-lock.json:1');
    expect(out).toContain('GET /api/orders');
    expect(out).toContain(EXPIRY_PROJECTION_REMEDY.slice(0, 30));
    // And the summary footer, for a reader who skims to the bottom and stops.
    expect(out).toContain('Expiring:    2 suppression(s) within 14d');
  });

  it('console flags the block tier so a lapse that will break the build stands out', () => {
    const warnOnly: ExpiryProjection = {
      ...LAPSING,
      lapsing: [LAPSING.lapsing[1]!],
      willBlock: 0,
      willWarn: 1,
      nextLapseDays: 7,
    };
    expect(renderConsole({ ...base, suppressionExpiry: LAPSING })).toContain(
      '⚠ Suppressions expiring',
    );
    expect(renderConsole({ ...base, suppressionExpiry: warnOnly })).toContain(
      'Suppressions expiring (1)',
    );
    expect(renderConsole({ ...base, suppressionExpiry: warnOnly })).not.toContain(
      '⚠ Suppressions expiring',
    );
  });

  it('json carries the whole structure, unabridged', () => {
    const json = renderJson({ ...base, suppressionExpiry: LAPSING });
    expect(json.suppressionExpiry).toEqual(LAPSING);
    // It must NOT leak into the verdict: a lapse that has not happened is not a
    // regression, and this run passed.
    expect(json.verdict.blocks).toBe(false);
    expect(json.verdict.refused).toBe(false);
    expect(json.verdict.exitCode).toBe(0);
  });

  it('markdown carries a callout plus a per-entry table', () => {
    const md = renderMarkdown({ ...base, suppressionExpiry: LAPSING });
    expect(md).toContain('⚠️');
    expect(md).toContain('2 allowlist suppressions expire within 14 days');
    expect(md).toContain('<summary>Suppressions expiring (2)</summary>');
    expect(md).toContain('| Source | Finding | Category | Expires | In | On lapse |');
    expect(md).toContain('dep-vuln package-lock.json:1');
    expect(md).toContain('**blocks**');
    expect(md).toContain('| 7d |');
    // Disclosure, not a verdict change — the heading still reports the pass.
    expect(md).toContain('## Guardrail: PASSED');
  });

  it('markdown drops to an informational icon when no lapse would block', () => {
    const warnOnly: ExpiryProjection = {
      ...LAPSING,
      lapsing: [LAPSING.lapsing[1]!],
      willBlock: 0,
      willWarn: 1,
      nextLapseDays: 7,
    };
    const md = renderMarkdown({ ...base, suppressionExpiry: warnOnly });
    expect(md).toContain('ℹ️');
    expect(md).toContain('1 will warn');
    expect(md).not.toContain('**blocks**');
  });

  it('names the baseline path honestly in ref-based mode (no literal "undefined")', () => {
    // The console printed `Path: undefined` whenever there was no on-disk
    // baseline, which is every ref-based run.
    const refBased = {
      ...base,
      baselinePath: undefined,
      mode: { ...base.mode, mode: 'ref-based' as const, ref: 'origin/main' },
    };
    const out = renderConsole(refBased);
    expect(out).not.toContain('Path:        undefined');
    expect(out).toContain('origin/main');
  });
});
