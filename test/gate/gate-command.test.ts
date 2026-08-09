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

describe('the --json payload is verdict.v1 (P0-2)', () => {
  it(
    'emits the frozen wire document: engine, policy hash, status, checks with causes, floor, receipt',
    async () => {
      const dir = makeTree({
        'README.md': '# generated package\n',
        'code/handlers.js': '// TODO wire discounts\n',
        '.dxkit/policy.json': securityPolicyJson({
          id: 'test.dod',
          version: '1',
          checks: [{ name: 'no_placeholder', pattern: '\\bTODO\\b', globs: ['code/**'] }],
        }),
      });
      const outcome = await runGateCommand(dir, {});
      const doc = JSON.parse(renderGateOutcome(outcome, true));
      expect(doc.schema).toBe('verdict.v1');
      expect(doc.engine.name).toBe('dxkit');
      expect(doc.engine.version).toMatch(/^\d+\.\d+\.\d+/);
      // The policy is named: hash always, id@version when declared (P0-3).
      expect(typeof doc.policy.hash).toBe('string');
      expect(doc.policy.hash.length).toBeGreaterThan(0);
      expect(doc.policy.id).toBe('test.dod');
      expect(doc.policy.version).toBe('1');
      expect(doc.status).toBe('blocked');
      expect(doc.exitCode).toBe(1);
      expect(doc.mode).toBe('fresh');
      // The text-rule finding rides with its durable identity + block flag.
      const finding = doc.findings.find(
        (f: { kind: string; blocking: boolean }) => f.kind === 'custom-check' && f.blocking,
      );
      expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(finding.file).toBe('code/handlers.js');
      // Every skipped check carries a cause — never a bare skip.
      const skipped = doc.checks.filter((c: { status: string }) => c.status === 'skipped');
      expect(skipped.every((c: { cause?: string }) => typeof c.cause === 'string')).toBe(true);
      // The floor did not run (untrusted) — declared, with the cause.
      expect(doc.floor.ran).toBe(false);
      expect(doc.floor.skippedWithCause).toContain('untrusted');
      // The human receipt is embedded verbatim.
      expect(doc.receipt).toContain('Gate verdict: BLOCKED');
    },
    HEAVY,
  );
});

describe('the floor runs across nested project roots', () => {
  it(
    'discovers a manifest nested under a subdirectory and prefixes its checks with the root',
    async () => {
      // The package-export convention: the runnable project nests under
      // code/, the tree root has no manifest. A root-only floor ran ZERO
      // checks here while reading as healthy — caught by the acceptance
      // matrix (the seeded failing test never executed).
      const dir = makeTree({
        'README.md': '# generated package\n',
        'code/package.json': JSON.stringify({ name: 'nested', version: '1.0.0' }),
        'code/index.js': 'module.exports = 1;\n',
        '.dxkit/policy.json': securityPolicyJson(),
      });
      const seen: string[] = [];
      const outcome = await runGateCommand(dir, {
        trusted: true,
        seams: {
          runFloor: (opts) => {
            seen.push(opts.cwd);
            return {
              ran: true,
              blocks: false,
              checks: [
                { pack: 'typescript', label: 'affected-tests', bin: 'jest', status: 'pass' },
              ],
            };
          },
        },
      });
      // One invocation per root: the tree root plus the nested project.
      expect(seen).toHaveLength(2);
      expect(seen[1].endsWith('/code')).toBe(true);
      // Nested checks carry the root prefix so attribution keys stay
      // collision-free across roots.
      const labels = outcome.floor?.checks.map((c) => c.label) ?? [];
      expect(labels).toContain('affected-tests');
      expect(labels).toContain('code:affected-tests');
    },
    HEAVY,
  );
});
