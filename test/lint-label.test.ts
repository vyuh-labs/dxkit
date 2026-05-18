import { describe, it, expect } from 'vitest';
import { parseLintLabel, stripNotRunSuffix } from '../src/analyzers/tools/lint-label';

describe('parseLintLabel', () => {
  it('returns the tool unchanged when there is no `(not run: …)` suffix', () => {
    expect(parseLintLabel('ruff')).toEqual({ tool: 'ruff', notRunPacks: null });
  });

  it('strips a single-pack `(not run: typescript)` suffix', () => {
    expect(parseLintLabel('ruff (not run: typescript)')).toEqual({
      tool: 'ruff',
      notRunPacks: 'typescript',
    });
  });

  it('strips a single-pack `(not run: typescript — reason)` suffix', () => {
    expect(parseLintLabel('ruff (not run: typescript — no eslint config found)')).toEqual({
      tool: 'ruff',
      notRunPacks: 'typescript — no eslint config found',
    });
  });

  it('preserves internal commas in the not-run section (multi-pack)', () => {
    expect(parseLintLabel('ruff (not run: typescript, go)')).toEqual({
      tool: 'ruff',
      notRunPacks: 'typescript, go',
    });
  });

  it('preserves multi-pack with per-pack reasons', () => {
    const label = 'ruff (not run: typescript — config error, go — not installed)';
    expect(parseLintLabel(label)).toEqual({
      tool: 'ruff',
      notRunPacks: 'typescript — config error, go — not installed',
    });
  });

  it('handles whitespace before the parenthetical', () => {
    expect(parseLintLabel('ruff   (not run: typescript)')).toEqual({
      tool: 'ruff',
      notRunPacks: 'typescript',
    });
  });

  it('returns null for notRunPacks on an empty parenthetical', () => {
    expect(parseLintLabel('ruff (not run: )')).toEqual({
      tool: 'ruff',
      notRunPacks: null,
    });
  });
});

describe('stripNotRunSuffix', () => {
  it('returns just the tool name', () => {
    expect(stripNotRunSuffix('ruff (not run: typescript)')).toBe('ruff');
  });

  it('survives multi-pack with internal commas (the F4 regression case)', () => {
    // Before centralization, the Tools-used footer split on the inner
    // comma and produced ["ruff (not run: typescript", "go)"] — two
    // garbled entries. The helper strips the parenthetical before any
    // split, so downstream comma-splitters see only the clean tool.
    expect(stripNotRunSuffix('ruff (not run: typescript, go)')).toBe('ruff');
  });

  it('leaves a clean tool name alone', () => {
    expect(stripNotRunSuffix('eslint')).toBe('eslint');
  });

  it('handles the empty string', () => {
    expect(stripNotRunSuffix('')).toBe('');
  });
});
