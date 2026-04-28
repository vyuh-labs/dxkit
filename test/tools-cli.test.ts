/**
 * Unit tests for tools-cli's `selectToolNames` — the pure decision
 * function that maps install options to a list of TOOL_DEFS keys.
 *
 * Filesystem-touching code paths (findTool, runInstall) are covered
 * by the existing tools install end-to-end exercises in dxkit's own
 * dev workflow; this file targets the testable seam.
 */
import { describe, it, expect } from 'vitest';
import { selectToolNames } from '../src/tools-cli';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';
import type { DetectedStack } from '../src/types';

const NODE_ONLY: DetectedStack['languages'] = {
  typescript: true,
  python: false,
  go: false,
  rust: false,
  csharp: false,
  kotlin: false,
  java: false,
};

const EMPTY_STACK: DetectedStack['languages'] = {
  typescript: false,
  python: false,
  go: false,
  rust: false,
  csharp: false,
  kotlin: false,
  java: false,
};

describe('selectToolNames', () => {
  it('default mode returns tools required for the active stack only', () => {
    const names = selectToolNames(NODE_ONLY);
    // Universal tools always present
    expect(names).toContain('cloc');
    expect(names).toContain('gitleaks');
    expect(names).toContain('semgrep');
    // TypeScript pack tools present
    expect(names).toContain('eslint');
    // Other packs' tools absent (the D010 closure — inactive packs
    // don't pollute the required list)
    expect(names).not.toContain('ruff');
    expect(names).not.toContain('golangci-lint');
    expect(names).not.toContain('clippy');
    expect(names).not.toContain('detekt');
  });

  it('returns just the named tool when toolName is set', () => {
    expect(selectToolNames(NODE_ONLY, { toolName: 'gitleaks' })).toEqual(['gitleaks']);
    // Cross-stack: a tool from a pack the project doesn't use
    expect(selectToolNames(NODE_ONLY, { toolName: 'detekt' })).toEqual(['detekt']);
  });

  it('returns empty array for unknown tool name (caller surfaces the error)', () => {
    expect(selectToolNames(NODE_ONLY, { toolName: 'not-a-real-tool-xyz' })).toEqual([]);
  });

  it('--all returns every TOOL_DEFS key, sorted', () => {
    const names = selectToolNames(EMPTY_STACK, { all: true });
    const expected = Object.keys(TOOL_DEFS).sort();
    expect(names).toEqual(expected);
    // Sanity: --all must not be stack-filtered (cross-stack dev case)
    expect(names).toContain('ruff');
    expect(names).toContain('eslint');
    expect(names).toContain('golangci-lint');
    expect(names).toContain('clippy');
    expect(names).toContain('detekt');
  });

  it('--all is independent of stack (Node-only project still gets every tool)', () => {
    expect(selectToolNames(NODE_ONLY, { all: true })).toEqual(
      selectToolNames(EMPTY_STACK, { all: true }),
    );
  });

  it('toolName takes precedence over --all when both set', () => {
    // Defensive — caller shouldn't pass both, but the contract is
    // "if you ask for one tool, you get one tool" regardless.
    expect(selectToolNames(NODE_ONLY, { toolName: 'cloc', all: true })).toEqual(['cloc']);
  });
});
