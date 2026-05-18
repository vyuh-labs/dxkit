/**
 * CLI orthogonality smoke tests (D018).
 *
 * Pre-2.4.7, passing `--json` bypassed the markdown save. Consumers
 * that wanted both stdout JSON AND the on-disk markdown had to invoke
 * the command twice — once with `--json` for stdout and once without
 * for the file — which doubled wall-clock for slow analyzers
 * (a JS-heavy customer frontend's quality step ran 33 min total: Friction #19).
 *
 * Post-D018: `--json` controls stdout shape; `--no-save` controls
 * disk. They're orthogonal. These tests verify the contract for the
 * dev-report command (cheapest of the analyzers — git-history walks
 * only, no shell-outs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let tmp: string;
const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-cli-orth-'));

  // Minimum-viable repo: package.json + a README + one source file + a commit.
  execSync('git init && git config user.email "t@t" && git config user.name "T"', {
    cwd: tmp,
    stdio: 'pipe',
  });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'cli-orth-test', version: '0.0.0' }, null, 2),
  );
  fs.writeFileSync(path.join(tmp, 'README.md'), '# cli-orth-test\n');
  fs.writeFileSync(path.join(tmp, 'index.js'), '// hello\n');
  execSync('git add -A && git commit -m "init"', { cwd: tmp, stdio: 'pipe' });
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function reportsDir(): string {
  return path.join(tmp, '.dxkit', 'reports');
}

function clearReports(): void {
  if (fs.existsSync(reportsDir())) {
    fs.rmSync(reportsDir(), { recursive: true, force: true });
  }
}

function findReport(stem: string): string | undefined {
  if (!fs.existsSync(reportsDir())) return undefined;
  return fs.readdirSync(reportsDir()).find((f) => f.startsWith(stem) && f.endsWith('.md'));
}

describe('CLI orthogonality (D018): --json and disk save are independent', () => {
  it('dev-report --json: emits JSON on stdout AND writes markdown to disk', () => {
    clearReports();
    const stdout = execSync(`node "${cliPath}" dev-report "${tmp}" --json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Stdout: pure JSON, no logger pollution.
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('summary');

    // Disk: markdown saved despite --json.
    const md = findReport('developer-report-');
    expect(md).toBeDefined();
    expect(fs.statSync(path.join(reportsDir(), md!)).size).toBeGreaterThan(0);
  });

  it('dev-report --json --detailed: emits JSON on stdout AND writes md + detailed.md + detailed.json', () => {
    clearReports();
    const stdout = execSync(`node "${cliPath}" dev-report "${tmp}" --json --detailed`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(() => JSON.parse(stdout)).not.toThrow();

    const entries = fs.existsSync(reportsDir()) ? fs.readdirSync(reportsDir()) : [];
    const md = entries.find(
      (f) => f.startsWith('developer-report-') && f.endsWith('.md') && !f.endsWith('-detailed.md'),
    );
    const detailedMd = entries.find((f) => f.endsWith('-detailed.md'));
    const detailedJson = entries.find((f) => f.endsWith('-detailed.json'));
    expect(md).toBeDefined();
    expect(detailedMd).toBeDefined();
    expect(detailedJson).toBeDefined();
    // Detailed JSON must parse cleanly.
    expect(() =>
      JSON.parse(fs.readFileSync(path.join(reportsDir(), detailedJson!), 'utf-8')),
    ).not.toThrow();
  });

  it('dev-report --no-save: skips disk write regardless of --json', () => {
    clearReports();
    execSync(`node "${cliPath}" dev-report "${tmp}" --json --no-save`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // No markdown should have landed.
    expect(findReport('developer-report-')).toBeUndefined();
  });

  it('dev-report (no flags): writes markdown to disk and prints human summary to stdout', () => {
    clearReports();
    const stdout = execSync(`node "${cliPath}" dev-report "${tmp}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Human-readable summary, not JSON.
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain('Commits');

    // Markdown still saved.
    expect(findReport('developer-report-')).toBeDefined();
  });
});
