import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { runGateCommand, renderGateOutcome } from '../../src/gate-cli';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

/**
 * 4.4.0 WP2b — `gate <dir>`: the one-shot tree gate (P0-1).
 *
 * Drives the command layer end to end over bare trees: text rules
 * (declarative, no spawn — enforced even on the default-UNTRUSTED
 * posture), the trust consent boundary for the floor and command
 * checks, floor attribution folding into the exit code, and the
 * gate-owned 0/1/2 exit contract.
 */

const HEAVY = 900_000;
const dirs: string[] = [];
let savedSalt: string | undefined;

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-gate-cmd-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A policy file with the security-only blocking posture — what a
 *  package-mode consumer's DoD would resemble (block on security, warn
 *  on the rest), written as the tree's own committed policy. */
function securityPolicyJson(extra: Record<string, unknown> = {}): string {
  const { policy } = policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY);
  return JSON.stringify({ ...policy, ...extra }, null, 2);
}

beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
});

afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('gate <dir> (fresh prior, default untrusted)', () => {
  it(
    'text rule blocks a seeded placeholder — enforced WITHOUT trust, with a durable identity',
    async () => {
      const dir = makeTree({
        'README.md': '# generated package\n',
        'code/handlers.js': 'function total() {\n  // TODO wire discounts\n  return 1;\n}\n',
        '.dxkit/policy.json': securityPolicyJson({
          checks: [
            {
              name: 'no_placeholder',
              pattern: '\\b(TODO|FIXME|XXX)\\b',
              globs: ['code/**'],
              blocking: true,
            },
            // A command check in the SAME policy: must be trust-gated off
            // (disclosed), while the text rule above still enforces.
            { name: 'never-runs', command: ['node', '-e', 'process.exit(1)'] },
          ],
        }),
      });
      const outcome = await runGateCommand(dir, {});
      expect(outcome.verdict).toBe('BLOCKED');
      expect(outcome.exitCode).toBe(1);
      const ruleFindings = outcome.result.pairs.filter(
        (p) => p.kind === 'custom-check' && p.classification.blocks,
      );
      expect(ruleFindings.length).toBe(1);
      expect(ruleFindings[0].file).toBe('code/handlers.js');
      expect(ruleFindings[0].line).toBe(2);
      expect(ruleFindings[0].pair.currentId).toMatch(/^[0-9a-f]{16}$/);

      // The command check was skipped for trust — DISCLOSED, never silent.
      const cc = outcome.result.current.customChecksUnobserved;
      expect(cc.gathered).toBe(true);
      if (cc.gathered) {
        const skipped = cc.checks.find((c) => c.name === 'never-runs');
        expect(skipped?.status).toBe('skipped-untrusted');
      }
      // And the floor did not run without consent — with the cause named.
      expect(outcome.floor).toBeUndefined();
      expect(outcome.floorSkipped?.cause).toBe('untrusted');
      expect(renderGateOutcome(outcome, false)).toContain('SKIPPED (untrusted)');
    },
    HEAVY,
  );

  it(
    'clean tree passes with exit 0; the run is deterministic across two invocations',
    async () => {
      const dir = makeTree({
        'README.md': '# generated package\n',
        'code/handlers.js': 'function total() {\n  return 1;\n}\n',
        '.dxkit/policy.json': securityPolicyJson({
          checks: [{ name: 'no_placeholder', pattern: '\\b(TODO|FIXME|XXX)\\b' }],
        }),
      });
      const a = await runGateCommand(dir, {});
      const b = await runGateCommand(dir, {});
      expect(a.verdict).toMatch(/^PASSED/);
      expect(a.exitCode).toBe(0);
      const proj = (o: typeof a) => ({
        verdict: o.verdict,
        exitCode: o.exitCode,
        blocking: o.result.pairs
          .filter((p) => p.classification.blocks)
          .map((p) => `${p.kind}:${p.file}:${p.pair.currentId}`)
          .sort(),
      });
      expect(proj(a)).toEqual(proj(b));
    },
    HEAVY,
  );
});

describe('the correctness floor under --trusted', () => {
  const fixtureTree = () =>
    makeTree({
      'README.md': '# generated package\n',
      '.dxkit/policy.json': securityPolicyJson(),
    });

  const failingFloor: CorrectnessFloorResult = {
    ran: true,
    blocks: true,
    checks: [
      {
        pack: 'typescript',
        label: 'affected-tests',
        bin: 'jest',
        status: 'fail',
        output: '1 failing',
      },
    ],
  };
  const passingFloor: CorrectnessFloorResult = {
    ran: true,
    blocks: false,
    checks: [{ pack: 'typescript', label: 'syntax', bin: 'tsc', status: 'pass' }],
  };

  it(
    'a net-new floor failure BLOCKS the gate (exit 1) — fresh mode attributes by construction',
    async () => {
      const dir = fixtureTree();
      const outcome = await runGateCommand(dir, {
        trusted: true,
        seams: { runFloor: () => failingFloor },
      });
      expect(outcome.floorNetNew).toHaveLength(1);
      expect(outcome.floorNetNew[0].check).toMatchObject({
        pack: 'typescript',
        label: 'affected-tests',
      });
      expect(outcome.verdict).toBe('BLOCKED');
      expect(outcome.exitCode).toBe(1);
      expect(renderGateOutcome(outcome, false)).toContain('net-new failure');
    },
    HEAVY,
  );

  it(
    'a passing floor leaves the findings verdict in charge (exit 0 on a clean tree)',
    async () => {
      const dir = fixtureTree();
      const outcome = await runGateCommand(dir, {
        trusted: true,
        seams: { runFloor: () => passingFloor },
      });
      expect(outcome.floorNetNew).toHaveLength(0);
      expect(outcome.exitCode).toBe(0);
    },
    HEAVY,
  );

  it(
    'tree-baseline mode: a failure the BASELINE tree already had is pre-existing, never blamed on the edit',
    async () => {
      const base = fixtureTree();
      const edited = fixtureTree();
      // Same failing floor on BOTH sides — the one attribution comparator
      // must classify it pre-existing (grandfathered), not net-new.
      const outcome = await runGateCommand(edited, {
        baselineDir: base,
        trusted: true,
        seams: { runFloor: () => failingFloor },
      });
      expect(outcome.floorNetNew).toHaveLength(0);
      expect(outcome.exitCode).toBe(0);
    },
    HEAVY,
  );
});

describe('the --json payload', () => {
  it(
    'carries the gate verdict + floor disclosure in machine shape',
    async () => {
      const dir = makeTree({
        'README.md': '# generated package\n',
        '.dxkit/policy.json': securityPolicyJson(),
      });
      const outcome = await runGateCommand(dir, {});
      const parsed = JSON.parse(renderGateOutcome(outcome, true));
      expect(parsed.gate.verdict).toMatch(/^PASSED/);
      expect(parsed.gate.exitCode).toBe(0);
      expect(parsed.gate.floor.skipped).toBe('untrusted');
      expect(typeof parsed.gate.floor.cause).toBe('string');
      // The engine payload rides along unchanged (WP3 swaps this wrapper
      // for verdict.v1; guardrail check --json is untouched either way).
      expect(parsed.verdict).toBeDefined();
    },
    HEAVY,
  );
});
