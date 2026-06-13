import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectScannerCoverageDrift } from '../src/analyzers/security/scanner-drift';

/**
 * C-D3: the scanner-coverage-drift detector compares this run's tool set
 * against the most recent prior persisted vuln-scan report and reports
 * which scanners are newly active — the signal that explains a score
 * change on an unchanged commit after a dxkit upgrade enabled more
 * scanners.
 */
describe('detectScannerCoverageDrift', () => {
  let repo: string;
  let reportDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-drift-'));
    reportDir = path.join(repo, '.dxkit', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function writePrior(date: string, toolsUsed: string[]): void {
    fs.writeFileSync(
      path.join(reportDir, `vulnerability-scan-${date}-detailed.json`),
      JSON.stringify({ toolsUsed }),
    );
  }

  it('returns null when there is no reports directory', () => {
    fs.rmSync(reportDir, { recursive: true, force: true });
    expect(detectScannerCoverageDrift(repo, ['gitleaks'], '2026-06-10')).toBeNull();
  });

  it('returns null on a first run (no prior report)', () => {
    expect(detectScannerCoverageDrift(repo, ['gitleaks'], '2026-06-10')).toBeNull();
  });

  it('detects the customer case: grep-secrets + snyk-code added since the prior run', () => {
    writePrior('2026-06-09', ['find', 'git', 'gitleaks']);
    const drift = detectScannerCoverageDrift(
      repo,
      ['find', 'git', 'gitleaks', 'grep-secrets', 'snyk-code'],
      '2026-06-10',
    );
    expect(drift).toEqual({ added: ['grep-secrets', 'snyk-code'], previousDate: '2026-06-09' });
  });

  it('returns null when the scanner set is unchanged', () => {
    writePrior('2026-06-09', ['find', 'git', 'gitleaks']);
    expect(detectScannerCoverageDrift(repo, ['gitleaks', 'find', 'git'], '2026-06-10')).toBeNull();
  });

  it('returns null when the scanner set shrank (not the confusing case)', () => {
    writePrior('2026-06-09', ['find', 'git', 'gitleaks', 'snyk-code']);
    expect(detectScannerCoverageDrift(repo, ['find', 'git', 'gitleaks'], '2026-06-10')).toBeNull();
  });

  it('compares against the most recent prior report, not an older one', () => {
    writePrior('2026-06-04', ['gitleaks']);
    writePrior('2026-06-09', ['gitleaks', 'grep-secrets']);
    // Most recent prior is 06-09 (already has grep-secrets) → only snyk-code is new.
    const drift = detectScannerCoverageDrift(
      repo,
      ['gitleaks', 'grep-secrets', 'snyk-code'],
      '2026-06-10',
    );
    expect(drift).toEqual({ added: ['snyk-code'], previousDate: '2026-06-09' });
  });

  it('ignores same-day and future reports', () => {
    writePrior('2026-06-10', ['gitleaks', 'grep-secrets', 'snyk-code']); // today — skipped
    writePrior('2026-06-09', ['gitleaks']); // the honest comparison point
    const drift = detectScannerCoverageDrift(
      repo,
      ['gitleaks', 'grep-secrets', 'snyk-code'],
      '2026-06-10',
    );
    expect(drift).toEqual({ added: ['grep-secrets', 'snyk-code'], previousDate: '2026-06-09' });
  });

  it('fails open past an unreadable prior report to the next-most-recent', () => {
    fs.writeFileSync(
      path.join(reportDir, 'vulnerability-scan-2026-06-09-detailed.json'),
      '{ not valid json',
    );
    writePrior('2026-06-08', ['gitleaks']);
    const drift = detectScannerCoverageDrift(repo, ['gitleaks', 'snyk-code'], '2026-06-10');
    expect(drift).toEqual({ added: ['snyk-code'], previousDate: '2026-06-08' });
  });
});
