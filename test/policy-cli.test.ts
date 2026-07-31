import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolvePolicyGet } from '../src/policy-cli';

/**
 * `policy get` is what the shipped workflow YAML captures with `$(…)` — its
 * output contract (raw primitives, JSON containers, default-degradation on
 * absent/malformed, loud failure without a default) is pinned here, and the
 * two de-inlined template call sites are asserted to actually use it (the
 * arch-check bans the old inline parser shape; this test proves the
 * replacement is present, not just the offender absent).
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-policy-get-'));
  mkdirSync(join(repo, '.dxkit'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writePolicy(text: string): void {
  writeFileSync(join(repo, '.dxkit', 'policy.json'), text, 'utf8');
}

describe('resolvePolicyGet', () => {
  it('prints primitives raw for shell capture', () => {
    writePolicy('{"depBump": {"allowMajor": true, "count": 3, "label": "weekly"}}');
    expect(resolvePolicyGet(repo, 'depBump.allowMajor')).toEqual({ ok: true, output: 'true' });
    expect(resolvePolicyGet(repo, 'depBump.count')).toEqual({ ok: true, output: '3' });
    expect(resolvePolicyGet(repo, 'depBump.label')).toEqual({ ok: true, output: 'weekly' });
  });

  it('prints objects and arrays as compact JSON, null as null', () => {
    writePolicy('{"flow": {"specs": ["a.json"]}, "x": null}');
    expect(resolvePolicyGet(repo, 'flow')).toEqual({ ok: true, output: '{"specs":["a.json"]}' });
    expect(resolvePolicyGet(repo, 'flow.specs')).toEqual({ ok: true, output: '["a.json"]' });
    expect(resolvePolicyGet(repo, 'x')).toEqual({ ok: true, output: 'null' });
  });

  it('reads a commented (JSONC) policy — the reason the command exists', () => {
    writePolicy(`{
      // opted in 2026-07
      "baseline": { "anchor": "cache" },
    }`);
    expect(resolvePolicyGet(repo, 'baseline.anchor')).toEqual({ ok: true, output: 'cache' });
  });

  it('degrades to --default on an absent path, absent file, or malformed file', () => {
    writePolicy('{"baseline": {}}');
    expect(resolvePolicyGet(repo, 'baseline.anchor', { default: 'tree' })).toEqual({
      ok: true,
      output: 'tree',
    });
    rmSync(join(repo, '.dxkit'), { recursive: true, force: true });
    expect(resolvePolicyGet(repo, 'baseline.anchor', { default: 'tree' })).toEqual({
      ok: true,
      output: 'tree',
    });
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
    writePolicy('{ broken');
    expect(resolvePolicyGet(repo, 'depBump.allowMajor', { default: 'false' })).toEqual({
      ok: true,
      output: 'false',
    });
  });

  it('fails loudly without a --default (a typo must never read as empty)', () => {
    writePolicy('{"depBump": {"allowMajor": true}}');
    const missing = resolvePolicyGet(repo, 'depBump.alowMajor');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("'depBump.alowMajor'");
    const malformed = (writePolicy('{ nope'), resolvePolicyGet(repo, 'depBump.allowMajor'));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toContain('not valid JSON/JSONC');
  });

  it('does not traverse into arrays or primitives', () => {
    writePolicy('{"flow": {"specs": ["a.json"]}}');
    expect(resolvePolicyGet(repo, 'flow.specs.0', { default: 'none' })).toEqual({
      ok: true,
      output: 'none',
    });
  });
});

describe('template call sites use policy get (the de-inlining, both directions)', () => {
  const templates = [
    {
      file: 'src-templates/.github/workflows/dxkit-dep-bump.yml',
      call: 'policy get depBump.allowMajor --default false',
    },
    {
      file: 'src-templates/.github/workflows/dxkit-guardrails.yml',
      call: 'policy get baseline.anchor --default tree',
    },
  ];

  for (const t of templates) {
    it(`${t.file} reads policy through the CLI`, () => {
      const text = readFileSync(join(__dirname, '..', t.file), 'utf8');
      expect(text).toContain(t.call);
      expect(text).not.toContain("require('./.dxkit/policy.json')");
    });
  }
});

// ─── policy set (4.3.4 — the incantation killer) ────────────────────────────

import { resolvePolicySet } from '../src/policy-cli';
import { installCiBaselineRefresh } from '../src/ship-installers';

describe('resolvePolicySet', () => {
  it('sets a cadence knob without quoting, comment-preserving, read-back verified', async () => {
    writePolicy('{\n  // keep this comment\n  "remediate": { "enabled": true }\n}\n');
    const out = await resolvePolicySet(repo, 'remediate.schedule', 'daily');
    expect(out.ok).toBe(true);
    expect(out.message).toContain('remediate.schedule = daily');
    const text = readFileSync(join(repo, '.dxkit', 'policy.json'), 'utf8');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('"schedule"');
    // No install here: says so instead of silently touching nothing.
    expect(out.notes.join(' ')).toContain('no dxkit install here');
  });

  it('parses JSON-shaped values (booleans, arrays) and leaves bare words as strings', async () => {
    writePolicy('{"lint": {"enabled": true}}');
    expect((await resolvePolicySet(repo, 'lint.blocking', 'true')).ok).toBe(true);
    const read = resolvePolicyGet(repo, 'lint.blocking');
    expect(read).toEqual({ ok: true, output: 'true' });
    const arr = await resolvePolicySet(repo, 'newAdvisories.blockSeverities', '[]');
    expect(arr.ok).toBe(true);
    expect(resolvePolicyGet(repo, 'newAdvisories.blockSeverities')).toEqual({
      ok: true,
      output: '[]',
    });
  });

  it('refuses an unknown path with suggestions — a typo never half-writes', async () => {
    writePolicy('{}');
    const out = await resolvePolicySet(repo, 'remediate.shedule', 'daily');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('not a settable policy knob');
    expect(out.message).toContain('remediate.schedule');
    expect(readFileSync(join(repo, '.dxkit', 'policy.json'), 'utf8')).toBe('{}');
  });

  it('enforces enum values where the knob declares them', async () => {
    writePolicy('{}');
    const out = await resolvePolicySet(repo, 'remediate.salvage', 'keep-everything');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('discard');
    expect(out.message).toContain('draft-pr');
  });

  it('re-renders the workflows the knob gates — no second update command needed', async () => {
    writePolicy('{"baseline": {"anchor": "branch"}}');
    // An installed repo: manifest + the refresh workflow on disk.
    writeFileSync(
      join(repo, '.vyuh-dxkit.json'),
      JSON.stringify({ generatedAt: 'x', mode: 'full', files: [] }),
    );
    installCiBaselineRefresh(repo, { policyAnchor: 'branch' });
    const before = readFileSync(join(repo, '.github/workflows/dxkit-baseline-refresh.yml'), 'utf8');
    expect(before).toContain("cron: '0 6 * * 1'");

    const out = await resolvePolicySet(repo, 'baseline.refreshCadence', 'daily');
    expect(out.ok).toBe(true);
    const after = readFileSync(join(repo, '.github/workflows/dxkit-baseline-refresh.yml'), 'utf8');
    expect(after).toContain("cron: '0 6 * * *'");
  });
});
