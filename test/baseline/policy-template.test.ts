import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  POLICY_STANZAS,
  SCAFFOLD_EXEMPT_KNOBS,
  POLICY_PARAMS,
  type ScaffoldCtx,
} from '../../src/baseline/policy-metadata';
import { renderPolicyScaffold, applicableStanzas } from '../../src/baseline/policy-template';
import { parsePolicyText } from '../../src/baseline/policy-text';
import { mergeIntoPolicyFile } from '../../src/baseline/policy-write';
import { POSTURE_KNOBS } from '../../src/discovery/posture-knobs';

/**
 * The scaffold is the HUMAN-facing discovery layer (design B / §9): these
 * tests pin the three promises that make it trustworthy. Coverage — a posture
 * knob cannot ship invisible to the file (every `POSTURE_KNOBS` path is
 * taught by a stanza or carries a declared scaffold exemption, the
 * `DEFERRED_KINDS` discipline). Validity — the rendered scaffold parses
 * as-is, AND with every stanza activated (the "uncomment to activate"
 * promise is mechanically true, E3). Durability — dxkit's own merge-writer
 * edits a scaffolded file without destroying what it teaches.
 */

const CTX: ScaffoldCtx = { packIds: ['typescript'], lintCapable: true };

function render(active: Record<string, unknown> = {}, ctx: ScaffoldCtx = CTX): string {
  return renderPolicyScaffold({ active, ctx, version: '4.3.0-test' });
}

describe('scaffold coverage (the config-knob discipline, extended to the file)', () => {
  const covered = new Set(POLICY_STANZAS.flatMap((s) => s.coversKnobs));
  const exempt = new Set(SCAFFOLD_EXEMPT_KNOBS.map((e) => e.path));

  for (const knob of POSTURE_KNOBS) {
    it(`knob '${knob.path}' is taught by a stanza or carries a declared exemption`, () => {
      expect(covered.has(knob.path) || exempt.has(knob.path)).toBe(true);
    });
  }

  it('no knob is both covered and exempt (a contradiction, not belt-and-braces)', () => {
    for (const path of exempt) expect(covered.has(path)).toBe(false);
  });

  it('every exemption references a real POSTURE_KNOBS path with a non-empty reason', () => {
    const knownPaths = new Set(POSTURE_KNOBS.map((k) => k.path));
    for (const e of SCAFFOLD_EXEMPT_KNOBS) {
      expect(knownPaths.has(e.path)).toBe(true);
      expect(e.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('stanza keys are unique and anchors/params are well-formed', () => {
    const keys = POLICY_STANZAS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of POLICY_STANZAS) expect(s.anchor).toMatch(/^[a-z0-9-]+$/);
    for (const p of POLICY_PARAMS) expect(p.anchor).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('scaffold validity (E3 — the activation promise)', () => {
  it('the rendered scaffold parses as-is through the one parser', () => {
    const parsed = parsePolicyText(render()) as Record<string, unknown>;
    expect(parsed.$schema).toContain('policy.schema.json');
  });

  it('parses with EVERY stanza uncommented, yielding each example value', () => {
    const text = renderPolicyScaffold({
      active: {},
      ctx: CTX,
      version: '4.3.0-test',
      activateAllStanzas: true,
    });
    const parsed = parsePolicyText(text) as Record<string, unknown>;
    for (const stanza of applicableStanzas({}, CTX)) {
      expect(parsed[stanza.key], `stanza '${stanza.key}' must activate to its example`).toEqual(
        stanza.example(CTX),
      );
    }
  });

  it('renders active values with per-parameter comments from the metadata table', () => {
    const text = render({ flow: { mode: 'warn' }, baseline: { mode: 'committed-full' } });
    const flowLine = text.split('\n').find((l) => l.includes('"mode": "warn"'));
    expect(flowLine).toContain('(block | warn | off)');
    expect(flowLine).toContain('policy-guide#flow-mode');
    expect(text).toContain('policy-guide#baseline-mode');
  });

  it('suppresses a stanza whose key is already active', () => {
    const text = render({ flow: { mode: 'block' } });
    expect(text).not.toContain('// ── UI-to-API integration gate');
    expect(text).toContain('// ── Paired-change rules');
  });

  it('tailors per stack: no lint stanza when no active pack has a lintGate', () => {
    const noLint = render({}, { packIds: [], lintCapable: false });
    expect(noLint).not.toContain('// ── Lint gate');
    expect(render()).toContain('// ── Lint gate');
  });

  it('stamps the scaffolding version in the header', () => {
    expect(render()).toContain('scaffolded by dxkit 4.3.0-test');
  });
});

describe('scaffold durability (the P1 writer keeps what the scaffold teaches)', () => {
  it('a configure-style merge into a fresh scaffold preserves every stanza', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dxkit-scaffold-'));
    try {
      mkdirSync(join(repo, '.dxkit'), { recursive: true });
      const scaffold = render({ baseline: { mode: 'committed-full' } });
      writeFileSync(join(repo, '.dxkit', 'policy.json'), scaffold, 'utf8');

      const outcome = mergeIntoPolicyFile(repo, { flow: { mode: 'warn' } });
      expect(outcome.changed).toBe(true);

      const after = readFileSync(join(repo, '.dxkit', 'policy.json'), 'utf8');
      // every commented stanza header line survives the edit
      for (const line of scaffold.split('\n').filter((l) => l.trimStart().startsWith('// ──'))) {
        expect(after).toContain(line.trim());
      }
      expect(parsePolicyText(after)).toMatchObject({
        baseline: { mode: 'committed-full' },
        flow: { mode: 'warn' },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
