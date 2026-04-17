import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { go } from '../src/languages/go';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-go-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('go.detect', () => {
  it('detects via go.mod', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/m\n\ngo 1.21\n');
    expect(go.detect(tmp)).toBe(true);
  });

  it('returns false without go.mod', () => {
    expect(go.detect(tmp)).toBe(false);
  });
});

describe('go.extractImports', () => {
  const run = go.extractImports!;

  it('captures single-line import', () => {
    expect(run('import "fmt"')).toEqual(['fmt']);
  });

  it('captures aliased single-line import', () => {
    expect(run('import f "fmt"')).toEqual(['fmt']);
  });

  it('captures multi-line import block', () => {
    const src = `
import (
  "fmt"
  "os"
  "strings"
)`;
    expect(run(src)).toEqual(['fmt', 'os', 'strings']);
  });

  it('captures aliased imports inside block', () => {
    const src = `
import (
  "fmt"
  errors "github.com/pkg/errors"
)`;
    expect(run(src)).toEqual(['fmt', 'github.com/pkg/errors']);
  });

  it('handles both single-line and block imports in same file', () => {
    const src = `
import "log"

import (
  "net/http"
  "encoding/json"
)`;
    const result = run(src);
    expect(result).toContain('log');
    expect(result).toContain('net/http');
    expect(result).toContain('encoding/json');
  });

  it('returns empty for file without imports', () => {
    expect(run('package main\n\nfunc main() {}')).toEqual([]);
  });
});

describe('go.resolveImport', () => {
  it('resolves internal module path to directory', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/mymod\n\ngo 1.21\n');
    fs.mkdirSync(path.join(tmp, 'internal', 'util'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'internal', 'util', 'helper.go'), 'package util\n');
    expect(go.resolveImport!('main.go', 'example.com/mymod/internal/util', tmp)).toBe(
      'internal/util',
    );
  });

  it('returns null for external packages', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/mymod\n\ngo 1.21\n');
    expect(go.resolveImport!('main.go', 'github.com/pkg/errors', tmp)).toBeNull();
  });

  it('returns null for stdlib packages', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/mymod\n\ngo 1.21\n');
    expect(go.resolveImport!('main.go', 'fmt', tmp)).toBeNull();
  });
});

describe('go.parseCoverage', () => {
  it('returns null when no artifact exists', () => {
    expect(go.parseCoverage!(tmp)).toBeNull();
  });

  it('parses coverage.out', () => {
    const raw = [
      'mode: set',
      'example.com/m/main.go:1.1,5.2 3 1',
      'example.com/m/main.go:6.1,9.1 2 0',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'coverage.out'), raw);
    const cov = go.parseCoverage!(tmp);
    expect(cov).not.toBeNull();
    expect(cov!.source).toBe('go');
    expect(cov!.linePercent).toBe(60);
  });

  it('prefers coverage.out over cover.out', () => {
    fs.writeFileSync(path.join(tmp, 'coverage.out'), 'mode: set\nfoo.go:1.1,2.1 1 1\n');
    fs.writeFileSync(path.join(tmp, 'cover.out'), 'mode: set\nbar.go:1.1,2.1 1 0\n');
    const cov = go.parseCoverage!(tmp);
    expect(cov!.linePercent).toBe(100);
  });
});

describe('go registration', () => {
  it('has correct extensions and test patterns', () => {
    expect(go.sourceExtensions).toEqual(['.go']);
    expect(go.testFilePatterns).toEqual(['*_test.go']);
  });

  it('declares expected tools', () => {
    expect(go.tools).toEqual(['golangci-lint', 'govulncheck']);
  });

  it('uses p/gosec semgrep ruleset', () => {
    expect(go.semgrepRulesets).toEqual(['p/gosec']);
  });
});
