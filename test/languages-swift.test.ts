/**
 * Swift pack — pack-specific tests.
 *
 * Two parser classes, two conventions (Recipe v4 G_v4_1):
 *   A. Source-text parsers (`extractSwiftImportsRaw`, `mapSwiftlintSeverity`)
 *      → synthetic inline strings.
 *   B. Tool-output parsers (`parseSwiftlintJson`, the shared osv-scanner
 *      parse with ecosystem 'SwiftURL') → REAL fixture bytes under
 *      `test/fixtures/raw/swift/`, captured per that dir's HARVEST.md.
 *      (`parseSwiftCoverageJson`'s real fixture is harvested by the Linux
 *      swift-toolchain verification pass — see HARVEST.md.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  swift,
  extractSwiftImportsRaw,
  resolveSwiftImportRaw,
  mapSwiftlintSeverity,
  parseSwiftlintJson,
  parseSwiftlintJsonViolations,
  parseSwiftCoverageJson,
} from '../src/languages/swift';
import { parseOsvScannerFindings } from '../src/analyzers/tools/osv-scanner-deps';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'swift');
const SPM_FIXTURE = path.join(__dirname, 'fixtures', 'analysis', 'swift-app');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('swift pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(swift.id).toBe('swift');
    expect(swift.displayName).toBe('Swift');
  });

  it('wires the capability providers', () => {
    expect(swift.capabilities?.depVulns).toBeDefined();
    expect(swift.capabilities?.lint).toBeDefined();
    expect(swift.capabilities?.coverage).toBeDefined();
    expect(swift.capabilities?.imports).toBeDefined();
    expect(swift.capabilities?.testFramework).toBeDefined();
  });

  it('detects the SwiftPM fixture and reads its tools-version', () => {
    expect(swift.detect(SPM_FIXTURE)).toBe(true);
    expect(swift.detectVersion!(SPM_FIXTURE)).toBe('5.9');
  });

  it('derives macos-only execution for an Xcode-shaped repo, host-agnostic for SwiftPM', () => {
    const spmReq = swift.correctness.execution(SPM_FIXTURE);
    expect(spmReq.hosts).toEqual(['any']);
    expect(spmReq.toolchains).toContain('swift');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-swift-xcode-'));
    try {
      fs.mkdirSync(path.join(dir, 'App.xcodeproj'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'App.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n');
      const req = swift.correctness.execution(dir);
      expect(req.hosts).toEqual(['macos']);
      expect(req.toolchains).toContain('xcode');
      // The floor's build half still answers (scheme-less xcodebuild, signing
      // disabled — a distribution cert is machine state, not code state) while
      // the test half is a disclosed null (needs a configured scheme).
      const build = swift.correctness.syntaxCheck({ cwd: dir, changedFiles: [], scope: 'full' });
      expect(build).toEqual({
        label: 'xcodebuild',
        bin: 'xcodebuild',
        args: ['build', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO'],
      });
      expect(
        swift.correctness.affectedTests({ cwd: dir, changedFiles: [], scope: 'full' }),
      ).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('swift depVulns — CocoaPods is a disclosed gap, never a fake clean', () => {
  it('Podfile.lock-only repo → unavailable with the no-advisory-database reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-swift-pods-'));
    try {
      fs.writeFileSync(path.join(dir, 'Podfile.lock'), 'PODS:\n  - AFNetworking (2.5.1)\n');
      const outcome = await swift.capabilities!.depVulns!.gatherOutcome!(dir);
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind === 'unavailable') {
        expect(outcome.reason).toContain('CocoaPods');
        expect(outcome.reason).toContain('UNAUDITED');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no lockfile at all → no-manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-swift-empty-'));
    try {
      const outcome = await swift.capabilities!.depVulns!.gatherOutcome!(dir);
      expect(outcome.kind).toBe('no-manifest');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section A — source-text parsers (synthetic inline strings)
// ═══════════════════════════════════════════════════════════════════════════

describe('mapSwiftlintSeverity', () => {
  it('tiers the force-family as high (crash-shaped, not style)', () => {
    expect(mapSwiftlintSeverity('force_cast')).toBe('high');
    expect(mapSwiftlintSeverity('force_try')).toBe('high');
    expect(mapSwiftlintSeverity('force_unwrapping')).toBe('high');
  });

  it('tiers memory-safety rules medium, style low, garbage low', () => {
    expect(mapSwiftlintSeverity('weak_delegate')).toBe('medium');
    expect(mapSwiftlintSeverity('line_length')).toBe('low');
    expect(mapSwiftlintSeverity(null)).toBe('low');
    expect(mapSwiftlintSeverity(undefined)).toBe('low');
  });
});

describe('extractSwiftImportsRaw', () => {
  it('extracts plain, testable, kind-qualified, and attribute-prefixed imports', () => {
    const src = [
      'import Foundation',
      '@testable import App',
      'import struct NIO.ByteBuffer',
      'import UIKit.UIView',
      '@preconcurrency import Dispatch',
      'let notAnImport = "import Fake"',
    ].join('\n');
    expect(extractSwiftImportsRaw(src)).toEqual(['Foundation', 'App', 'NIO', 'UIKit', 'Dispatch']);
  });

  it('dedupes repeated modules', () => {
    expect(extractSwiftImportsRaw('import Foundation\nimport Foundation\n')).toEqual([
      'Foundation',
    ]);
  });
});

describe('resolveSwiftImportRaw', () => {
  it('resolves an in-project SwiftPM target and rejects system modules', () => {
    expect(resolveSwiftImportRaw('Tests/AppTests/AppTests.swift', 'App', SPM_FIXTURE)).toBe(
      'Sources/App',
    );
    expect(resolveSwiftImportRaw('Sources/App/Greeter.swift', 'Foundation', SPM_FIXTURE)).toBe(
      null,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section B — tool-output parsers (REAL fixture bytes from HARVEST.md)
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSwiftlintJson (real 0.65.0 bytes)', () => {
  it('extracts located findings with absolute files, rules, and reasons', () => {
    const findings = parseSwiftlintJson(readFixture('lint-output.json'));
    expect(findings.length).toBe(3);
    const forceCast = findings.find((f) => f.rule === 'force_cast');
    expect(forceCast).toBeDefined();
    expect(forceCast!.file.endsWith('Sources/App/BadLint.swift')).toBe(true);
    expect(forceCast!.line).toBe(4);
    expect(forceCast!.message).toBe('Force casts should be avoided');
    // The convention the lint-formats parity net relies on: swiftlint JSON
    // emits ABSOLUTE paths.
    expect(path.isAbsolute(forceCast!.file)).toBe(true);
  });

  it('carries native severity on the violations shape (counts path)', () => {
    const violations = parseSwiftlintJsonViolations(readFixture('lint-output.json'));
    expect(violations.every((v) => v.severity === 'Error' || v.severity === 'Warning')).toBe(true);
  });

  it('is total over garbage', () => {
    expect(parseSwiftlintJson('')).toEqual([]);
    expect(parseSwiftlintJson('Linting Swift files at paths .')).toEqual([]);
    expect(parseSwiftlintJson('{"not":"an array"}')).toEqual([]);
  });
});

describe('osv-scanner SwiftURL parse (real 2.4.0 bytes)', () => {
  it('extracts swift-nio advisories from Package.resolved scan output', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings, counts } = parseOsvScannerFindings(raw, 'SwiftURL', 'swift');
    expect(findings.length).toBeGreaterThanOrEqual(4);
    const nio = findings.filter((f) => f.package === 'github.com/apple/swift-nio');
    expect(nio.length).toBe(findings.length);
    expect(nio[0].installedVersion).toBe('2.39.0');
    expect(nio.map((f) => f.id)).toContain('GHSA-7fj7-39wj-c64f');
    expect(nio.every((f) => f.packId === 'swift')).toBe(true);
    const total = counts.critical + counts.high + counts.medium + counts.low;
    expect(total).toBe(findings.length);
  });

  it('the ecosystem filter drops other ecosystems (polyglot no-double-count)', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings } = parseOsvScannerFindings(raw, 'npm', 'typescript');
    expect(findings).toEqual([]);
  });
});

describe('parseSwiftCoverageJson (real llvm-cov export bytes)', () => {
  it('computes per-file line coverage from the harvested swift-app artifact', () => {
    // The artifact's filenames are absolute paths from the machine that ran
    // `swift test --enable-code-coverage`; re-anchor them to a fake repo
    // root so the fixture parses on any checkout (the parser scopes to cwd).
    const raw = readFixture('coverage-output.json').replace(
      /"filename"\s*:\s*"[^"]*swift-app\//g,
      '"filename": "/repo/swift-app/',
    );
    const coverage = parseSwiftCoverageJson(raw, 'coverage-output.json', '/repo/swift-app');
    expect(coverage).not.toBeNull();
    expect(coverage!.linePercent).toBeGreaterThan(0);
    const greeter = coverage!.files.get('Sources/App/Greeter.swift');
    expect(greeter).toBeDefined();
    expect(greeter!.total).toBeGreaterThan(0);
    expect(greeter!.covered).toBe(greeter!.total); // the one test exercises all of Greeter
  });

  it('is total over garbage', () => {
    expect(parseSwiftCoverageJson('', 'x.json', '/repo')).toBeNull();
    expect(parseSwiftCoverageJson('{"data": "nope"}', 'x.json', '/repo')).toBeNull();
  });
});
