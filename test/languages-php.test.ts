/**
 * PHP pack — pack-specific tests.
 *
 * Two parser classes, two conventions (Recipe v4 G_v4_1):
 *   A. Source-text parsers (`extractPhpImportsRaw`, `mapPhpcsSeverity`)
 *      → synthetic inline strings.
 *   B. Tool-output parsers (`parsePhpcsJson`, the shared osv-scanner parse
 *      with ecosystem 'Packagist') → REAL fixture bytes under
 *      `test/fixtures/raw/php/`, captured per that dir's HARVEST.md.
 *      (`parsePhpCloverXml`'s real fixture needs a PHP with a coverage
 *      driver — see HARVEST.md; format-shape coverage below is interim.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  php,
  extractPhpImportsRaw,
  mapPhpcsSeverity,
  parsePhpcsJson,
  parsePhpcsJsonMessages,
  parsePhpCloverXml,
} from '../src/languages/php';
import { parseOsvScannerFindings } from '../src/analyzers/tools/osv-scanner-deps';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'php');
const APP_FIXTURE = path.join(__dirname, 'fixtures', 'analysis', 'php-app');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('php pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(php.id).toBe('php');
    expect(php.displayName).toBe('PHP');
  });

  it('wires the capability providers', () => {
    expect(php.capabilities?.depVulns).toBeDefined();
    expect(php.capabilities?.lint).toBeDefined();
    expect(php.capabilities?.coverage).toBeDefined();
    expect(php.capabilities?.imports).toBeDefined();
    expect(php.capabilities?.testFramework).toBeDefined();
  });

  it('detects the fixture (composer.json) and bare-source repos, reads the version', () => {
    expect(php.detect(APP_FIXTURE)).toBe(true);
    expect(php.detectVersion!(APP_FIXTURE)).toBe('8.1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-php-bare-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.php'), '<?php echo 1;\n');
      // Bare source, no composer.json — the pack must still activate
      // (the swift detection lesson: disclosures need an active pack).
      expect(php.detect(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('php correctness floor', () => {
  it('syntaxCheck lints exactly the changed .php files', () => {
    const cmd = php.correctness.syntaxCheck({
      cwd: APP_FIXTURE,
      changedFiles: ['src/Greeter.php', 'README.md'],
      scope: 'affected',
    });
    expect(cmd).toEqual({ label: 'php-lint', bin: 'php', args: ['-l', 'src/Greeter.php'] });
    // No changed php → nothing to lint (full scope included: PHP has no
    // whole-tree lint command — a disclosed absence, not a fake pass).
    expect(
      php.correctness.syntaxCheck({ cwd: APP_FIXTURE, changedFiles: [], scope: 'full' }),
    ).toBeNull();
  });

  it('affectedTests is null without a provisioned PHPUnit (fail-open, CI backstop)', () => {
    expect(
      php.correctness.affectedTests({ cwd: APP_FIXTURE, changedFiles: [], scope: 'full' }),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section A — source-text parsers (synthetic inline strings)
// ═══════════════════════════════════════════════════════════════════════════

describe('mapPhpcsSeverity', () => {
  it('tiers eval/forbidden-function sniffs high, style low, garbage low', () => {
    expect(mapPhpcsSeverity('Squiz.PHP.Eval.Discouraged')).toBe('high');
    expect(mapPhpcsSeverity('Generic.PHP.ForbiddenFunctions.Found')).toBe('high');
    expect(mapPhpcsSeverity('PSR12.Files.FileHeader.SpacingAfterBlock')).toBe('low');
    expect(mapPhpcsSeverity(null)).toBe('low');
    expect(mapPhpcsSeverity(undefined)).toBe('low');
  });
});

describe('extractPhpImportsRaw', () => {
  it('extracts use statements (plain, aliased, grouped, function/const) and requires', () => {
    const src = [
      '<?php',
      'use App\\Services\\Mailer;',
      'use GuzzleHttp\\Client as HttpClient;',
      'use App\\Models\\{User, Order as PlacedOrder};',
      'use function App\\Helpers\\format_date;',
      "require_once 'legacy/bootstrap.php';",
      '// use App\\Commented\\Out;',
      '$x = "use App\\\\NotAnImport;";',
    ].join('\n');
    const imports = extractPhpImportsRaw(src);
    expect(imports).toContain('App\\Services\\Mailer');
    expect(imports).toContain('GuzzleHttp\\Client');
    expect(imports).toContain('App\\Models\\User');
    expect(imports).toContain('App\\Models\\Order');
    expect(imports).toContain('App\\Helpers\\format_date');
    expect(imports).toContain('legacy/bootstrap.php');
    expect(imports).not.toContain('App\\Commented\\Out');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section B — tool-output parsers (REAL fixture bytes from HARVEST.md)
// ═══════════════════════════════════════════════════════════════════════════

describe('parsePhpcsJson (real 4.0.1 bytes)', () => {
  it('extracts located findings with absolute file keys, rules, and messages', () => {
    const findings = parsePhpcsJson(readFixture('lint-output.json'));
    expect(findings.length).toBeGreaterThanOrEqual(9);
    const brace = findings.find(
      (f) => f.rule === 'Squiz.Functions.MultiLineFunctionDeclaration.BraceOnSameLine',
    );
    expect(brace).toBeDefined();
    expect(brace!.file.endsWith('src/bad_lint.php')).toBe(true);
    expect(path.isAbsolute(brace!.file)).toBe(true);
    expect(typeof brace!.line).toBe('number');
  });

  it('carries the native ERROR/WARNING type on the messages shape (counts path)', () => {
    const messages = parsePhpcsJsonMessages(readFixture('lint-output.json'));
    expect(messages.every((m) => m.type === 'ERROR' || m.type === 'WARNING')).toBe(true);
    expect(messages.some((m) => m.type === 'WARNING')).toBe(true);
  });

  it('is total over garbage', () => {
    expect(parsePhpcsJson('')).toEqual([]);
    expect(parsePhpcsJson('PHP Warning: something unrelated')).toEqual([]);
    expect(parsePhpcsJson('{"totals":{}}')).toEqual([]);
  });
});

describe('osv-scanner Packagist parse (real 2.4.0 bytes)', () => {
  it('extracts guzzle advisories from the composer.lock scan output', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings, counts } = parseOsvScannerFindings(raw, 'Packagist', 'php');
    expect(findings.length).toBeGreaterThanOrEqual(4);
    const guzzle = findings.filter((f) => f.package === 'guzzlehttp/guzzle');
    expect(guzzle.length).toBe(findings.length);
    expect(guzzle[0].installedVersion).toBe('7.4.0');
    expect(guzzle.map((f) => f.id)).toContain('GHSA-25mq-v84q-4j7r');
    expect(guzzle.every((f) => f.packId === 'php')).toBe(true);
    const total = counts.critical + counts.high + counts.medium + counts.low;
    expect(total).toBe(findings.length);
  });

  it('the ecosystem filter drops other ecosystems (polyglot no-double-count)', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings } = parseOsvScannerFindings(raw, 'npm', 'typescript');
    expect(findings).toEqual([]);
  });
});

describe('parsePhpCloverXml (PHPUnit clover shape)', () => {
  it('computes per-file statement coverage and relativizes absolute names', () => {
    // Interim format-shape sample pending a real harvest (needs a PHP with
    // a coverage driver — see HARVEST.md). Field layout mirrors PHPUnit's
    // clover writer.
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<coverage generated="1700000000">',
      '  <project timestamp="1700000000">',
      '    <file name="/repo/src/Greeter.php">',
      '      <line num="9" type="method" name="greet" count="2"/>',
      '      <line num="11" type="stmt" count="2"/>',
      '      <line num="12" type="stmt" count="0"/>',
      '    </file>',
      '    <file name="/elsewhere/vendor/dep.php">',
      '      <line num="1" type="stmt" count="1"/>',
      '    </file>',
      '  </project>',
      '</coverage>',
    ].join('\n');
    const coverage = parsePhpCloverXml(xml, 'clover.xml', '/repo');
    expect(coverage).not.toBeNull();
    const greeter = coverage!.files.get('src/Greeter.php');
    expect(greeter).toEqual({ path: 'src/Greeter.php', covered: 1, total: 2, pct: 50 });
    // Out-of-repo entries (vendor mis-scoping) are dropped.
    expect(coverage!.files.size).toBe(1);
    expect(coverage!.linePercent).toBe(50);
  });

  it('is total over garbage', () => {
    expect(parsePhpCloverXml('', 'x.xml', '/repo')).toBeNull();
    expect(parsePhpCloverXml('not xml at all', 'x.xml', '/repo')).toBeNull();
  });
});
