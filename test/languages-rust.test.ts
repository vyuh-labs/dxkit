import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rust,
  extractRustImportsRaw,
  parseLcov,
  mapClippyLintSeverity,
} from '../src/languages/rust';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-rs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('rust.detect', () => {
  it('detects via Cargo.toml', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(rust.detect(tmp)).toBe(true);
  });

  it('returns false without Cargo.toml', () => {
    expect(rust.detect(tmp)).toBe(false);
  });
});

describe('extractRustImportsRaw', () => {
  const run = extractRustImportsRaw;

  it('captures simple `use X;`', () => {
    expect(run('use std::io;')).toEqual(['std::io']);
  });

  it('captures nested path', () => {
    expect(run('use std::collections::HashMap;')).toEqual(['std::collections::HashMap']);
  });

  it('captures crate-relative imports', () => {
    expect(run('use crate::config;\nuse super::utils;')).toEqual(['crate::config', 'super::utils']);
  });

  it('captures block imports with braces', () => {
    expect(run('use std::{io, fs};')).toEqual(['std::{io, fs}']);
  });

  it('ignores non-use code', () => {
    expect(run('fn main() {}\nlet x = 1;')).toEqual([]);
  });
});

describe('rust.capabilities.coverage (lcov)', () => {
  it('returns null when no artifact exists', async () => {
    expect(await rust.capabilities!.coverage!.gather(tmp)).toBeNull();
  });

  it('parses lcov.info at repo root', async () => {
    const lcov = [
      'SF:src/main.rs',
      'DA:1,5',
      'DA:2,0',
      'LH:1',
      'LF:2',
      'end_of_record',
      'SF:src/lib.rs',
      'DA:1,3',
      'LH:1',
      'LF:1',
      'end_of_record',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'lcov.info'), lcov);
    const env = await rust.capabilities!.coverage!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.coverage.source).toBe('lcov');
    // 2 hit out of 3 total = 66.7%
    expect(env!.coverage.linePercent).toBe(66.7);
    expect(env!.coverage.files.size).toBe(2);
    expect(env!.coverage.files.get('src/main.rs')?.pct).toBe(50);
    expect(env!.coverage.files.get('src/lib.rs')?.pct).toBe(100);
  });

  it('falls back to cobertura XML when no lcov exists', async () => {
    const xml = `<coverage line-rate="0.75" lines-covered="30" lines-valid="40"><packages/></coverage>`;
    fs.writeFileSync(path.join(tmp, 'coverage.cobertura.xml'), xml);
    const env = await rust.capabilities!.coverage!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.coverage.source).toBe('cobertura');
    expect(env!.coverage.linePercent).toBe(75);
  });
});

describe('parseLcov', () => {
  it('returns null for empty input', () => {
    expect(parseLcov('', 'f', tmp)).toBeNull();
  });

  it('handles absolute paths in SF lines', () => {
    const lcov = `SF:${tmp}/src/main.rs\nLH:5\nLF:10\nend_of_record\n`;
    const cov = parseLcov(lcov, 'lcov.info', tmp);
    expect(cov).not.toBeNull();
    expect(cov!.files.get('src/main.rs')?.pct).toBe(50);
  });
});

describe('rust registration', () => {
  it('has correct extensions and test patterns', () => {
    expect(rust.sourceExtensions).toEqual(['.rs']);
    expect(rust.testFilePatterns).toContain('*_test.rs');
    expect(rust.testFilePatterns).toContain('tests/*.rs');
  });

  it('declares expected tools', () => {
    expect(rust.tools).toEqual(['clippy', 'cargo-audit', 'cargo-llvm-cov', 'cargo-license']);
  });

  it('declares empty semgrep rulesets', () => {
    expect(rust.semgrepRulesets).toEqual([]);
  });

  it('imports capability has empty edges (no file-level resolver)', async () => {
    fs.writeFileSync(path.join(tmp, 'main.rs'), 'use std::io;\n');
    const env = await rust.capabilities!.imports!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.edges.size).toBe(0);
    expect(env!.extracted.get('main.rs')).toEqual(['std::io']);
  });
});

describe('rust.mapLintSeverity (clippy)', () => {
  const map = mapClippyLintSeverity;

  it('maps memory-safety clippy lints to critical', () => {
    expect(map('clippy::uninit_assumed_init')).toBe('critical');
    expect(map('clippy::uninit_vec')).toBe('critical');
    expect(map('clippy::transmuting_null')).toBe('critical');
    expect(map('clippy::not_unsafe_ptr_arg_deref')).toBe('critical');
    expect(map('clippy::cast_ref_to_mut')).toBe('critical');
    expect(map('clippy::invalid_atomic_ordering')).toBe('critical');
  });

  it('maps correctness-bug clippy lints to high', () => {
    expect(map('clippy::panicking_unwrap')).toBe('high');
    expect(map('clippy::never_loop')).toBe('high');
    expect(map('clippy::while_immutable_condition')).toBe('high');
    expect(map('clippy::out_of_bounds_indexing')).toBe('high');
    expect(map('clippy::logic_bug')).toBe('high');
    expect(map('clippy::cmp_nan')).toBe('high');
  });

  it('maps rustc-native lints to medium', () => {
    expect(map('unused_variables')).toBe('medium');
    expect(map('dead_code')).toBe('medium');
    expect(map('deprecated')).toBe('medium');
  });

  it('maps other clippy groups (style, perf, pedantic) to low', () => {
    expect(map('clippy::needless_pass_by_value')).toBe('low');
    expect(map('clippy::redundant_closure')).toBe('low');
    expect(map('clippy::too_many_arguments')).toBe('low');
    expect(map('clippy::module_name_repetitions')).toBe('low');
  });

  it('maps undefined and empty string to low', () => {
    expect(map(undefined)).toBe('low');
    expect(map('')).toBe('low');
  });
});

describe('rust.correctness', () => {
  const ctx = (over: Partial<{ changedFiles: string[]; scope: 'affected' | 'full' }> = {}) => ({
    cwd: tmp,
    changedFiles: over.changedFiles ?? ['src/lib.rs'],
    scope: over.scope ?? ('affected' as const),
  });

  it('syntaxCheck: cargo check when a Cargo.toml is present', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(rust.correctness!.syntaxCheck(ctx())).toEqual({
      label: 'check',
      bin: 'cargo',
      args: ['check'],
    });
  });

  it('syntaxCheck: null without a Cargo.toml', () => {
    expect(rust.correctness!.syntaxCheck(ctx())).toBeNull();
  });

  it('affectedTests: cargo test when a .rs changed on the affected surface', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(
      rust.correctness!.affectedTests(ctx({ changedFiles: ['src/lib.rs', 'README.md'] })),
    ).toEqual({
      label: 'affected-tests',
      bin: 'cargo',
      args: ['test'],
    });
  });

  it('affectedTests: null on the affected surface when no .rs changed', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(rust.correctness!.affectedTests(ctx({ changedFiles: ['README.md'] }))).toBeNull();
  });

  it('affectedTests: cargo test at full scope', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(rust.correctness!.affectedTests(ctx({ scope: 'full' }))?.args).toEqual(['test']);
  });

  it('affectedTests: cargo test when the diff is undeterminable (empty changedFiles)', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(
      rust.correctness!.affectedTests(ctx({ changedFiles: [], scope: 'affected' }))?.args,
    ).toEqual(['test']);
  });

  it('affectedTests: null without a Cargo.toml', () => {
    expect(rust.correctness!.affectedTests(ctx())).toBeNull();
  });

  // Workspace mode: narrow to the changed members' crates via `-p <crate>`.
  function writeWorkspace(): void {
    fs.writeFileSync(
      path.join(tmp, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/alpha", "crates/beta"]\n',
    );
    for (const [dir, name] of [
      ['crates/alpha', 'alpha'],
      ['crates/beta', 'beta'],
    ]) {
      fs.mkdirSync(path.join(tmp, dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`);
    }
  }

  it('affectedTests: narrows to the changed member crate (-p) in a workspace', () => {
    writeWorkspace();
    const cmd = rust.correctness!.affectedTests(ctx({ changedFiles: ['crates/alpha/src/lib.rs'] }));
    expect(cmd?.args).toEqual(['test', '-p', 'alpha']);
  });

  it('affectedTests: unions multiple changed member crates', () => {
    writeWorkspace();
    const cmd = rust.correctness!.affectedTests(
      ctx({ changedFiles: ['crates/alpha/src/lib.rs', 'crates/beta/src/main.rs', 'README.md'] }),
    );
    expect(cmd?.args).toEqual(['test', '-p', 'alpha', '-p', 'beta']);
  });

  it('affectedTests: falls back to the whole workspace when a .rs is unattributable', () => {
    writeWorkspace();
    // A .rs at the workspace root (virtual manifest, no [package]) can't be
    // attributed to a named crate → run the whole workspace, never under-test.
    const cmd = rust.correctness!.affectedTests(ctx({ changedFiles: ['build.rs'] }));
    expect(cmd?.args).toEqual(['test']);
  });

  it('affectedTests: workspace full scope runs the whole workspace', () => {
    writeWorkspace();
    expect(
      rust.correctness!.affectedTests(
        ctx({ changedFiles: ['crates/alpha/src/lib.rs'], scope: 'full' }),
      )?.args,
    ).toEqual(['test']);
  });
});
