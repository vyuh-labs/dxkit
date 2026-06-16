import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';

/**
 * End-to-end exercise of the guardrail-check orchestrator. The
 * matcher + classifier have their own unit tests; this file proves
 * the orchestration glue (baseline file → producer rerun → match →
 * classify → render) works on a real git repo.
 *
 * Each `createBaseline` + `runGuardrailCheck` runs every analyzer
 * on the fixture repo (~10-15s), so the file consolidates many
 * assertions per test to keep total runtime reasonable. Per-axis
 * unit coverage lives in `git-aware-match.test.ts`, `policy.test.ts`,
 * and `entry-to-located.test.ts`; this file proves they wire
 * together correctly.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-guardrail-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

describe('runGuardrailCheck (integration)', () => {
  let savedEnv: string | undefined;

  beforeAll(() => {
    savedEnv = process.env.DXKIT_BASELINE_SALT;
    delete process.env.DXKIT_BASELINE_SALT;
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.DXKIT_BASELINE_SALT;
    else process.env.DXKIT_BASELINE_SALT = savedEnv;
  });

  describe('happy paths', () => {
    let dir: string;
    beforeEach(() => {
      dir = makeRepo();
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reports no changes, then detects a new stale-file across check + renderers + explicit --baseline path', async () => {
      // Step 1: clean repo. Baseline + immediate check should
      // report no per-finding changes and no envelope drift —
      // toolchainHash stability across the back-to-back gathers
      // is guaranteed by the per-process version cache.
      const created = await createBaseline({ cwd: dir });
      const noop = await runGuardrailCheck({ cwd: dir });
      expect(noop.blocks).toBe(false);
      expect(noop.warns).toBe(false);
      expect(noop.pairs).toEqual([]);
      expect(noop.envelopeDrift.toolchainHashChanged).toBe(false);
      // Renderers must not throw on the empty case.
      const emptyConsole = renderConsole(noop);
      expect(emptyConsole).toContain('Guardrail PASSED');
      expect(emptyConsole).toContain('Baseline');
      const emptyJson = renderJson(noop);
      expect(emptyJson.schema).toBe('dxkit.guardrail-check.v1');
      expect(emptyJson.verdict.exitCode).toBe(0);
      expect(emptyJson.summary.pairs).toBe(0);
      expect(() => JSON.parse(JSON.stringify(emptyJson))).not.toThrow();
      const emptyMd = renderMarkdown(noop);
      expect(emptyMd).toContain('## Guardrail: PASSED');

      // Step 2: introduce a stale .bak file the quality producer
      // catches. Confirm the addition surfaces + the renderers
      // include it + --baseline overrides the lookup path.
      writeFileSync(join(dir, 'leftover.bak'), 'old\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'drop a .bak'], { cwd: dir });

      const result = await runGuardrailCheck({ cwd: dir });
      const added = result.pairs.filter((p) => p.classification.status === 'added');
      expect(added.length).toBeGreaterThan(0);
      const staleAdds = added.filter((p) => p.kind === 'stale-file');
      expect(staleAdds).toHaveLength(1);
      expect(staleAdds[0].file).toContain('leftover.bak');

      const consoleOut = renderConsole(result);
      expect(consoleOut).toContain('stale-file');
      const jsonOut = renderJson(result);
      expect(jsonOut.summary.pairs).toBeGreaterThan(0);
      const mdOut = renderMarkdown(result);
      expect(mdOut).toMatch(/_Baseline_:/);

      // Explicit --baseline path override.
      const stashed = join(dir, 'stashed-baseline.json');
      if (!created.path) throw new Error('expected committed-mode baseline');
      writeFileSync(stashed, readFileSync(created.path));
      const viaPath = await runGuardrailCheck({ cwd: dir, baselinePath: stashed });
      expect(viaPath.baselinePath).toBe(stashed);
      expect(viaPath.baseline.name).toBe('main');
    }, 300_000);

    it('surfaces allowlist additions in the markdown PR-comment section', async () => {
      // Baseline-time: no .dxkit/allowlist.json file
      await createBaseline({ cwd: dir });

      // Add a file-level allowlist entry on the "current" branch
      // (working tree only — baseline-create won't be re-run).
      const allowlistDir = join(dir, '.dxkit');
      execFileSync('mkdir', ['-p', allowlistDir]);
      writeFileSync(
        join(allowlistDir, 'allowlist.json'),
        JSON.stringify(
          {
            schemaVersion: 'dxkit-allowlist/v1',
            mode: 'full',
            entries: [
              {
                fingerprint: 'aaaa111111111111',
                kind: 'dep-vuln',
                category: 'accepted-risk',
                reason: 'WAF rule mitigates the attack vector',
                addedBy: 'reviewer@example.com',
                addedAt: '2026-05-22',
                expiresAt: '2026-08-22',
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );

      const result = await runGuardrailCheck({ cwd: dir });
      expect(result.allowlistDelta).toBeDefined();
      expect(result.allowlistDelta.baselineAccessible).toBe(true);
      expect(result.allowlistDelta.added).toHaveLength(1);
      expect(result.allowlistDelta.added[0].fingerprint).toBe('aaaa111111111111');

      const md = renderMarkdown(result);
      expect(md).toContain('### Allowlist activity');
      expect(md).toContain('Added (1)');
      expect(md).toContain('aaaa111111111111');
      expect(md).toContain('accepted-risk');
      expect(md).toContain('WAF rule mitigates');
    }, 300_000);

    it('an active allowlist entry waives a net-new blocking finding from the verdict', async () => {
      // The expiry + kind-guard branches are unit-tested in
      // `allowlist-suppression.test.ts` (pure, instant). This case
      // proves the END-TO-END wiring: a real blocking finding's
      // verdict flips from block → pass once it's allowlisted.
      await createBaseline({ cwd: dir });

      // Introduce a net-new stale `.bak` — the quality producer flags
      // it as a `stale-file` finding with status `added`, which the
      // default brownfield policy blocks.
      writeFileSync(join(dir, 'leftover.bak'), 'old\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'drop a .bak'], { cwd: dir });

      const findStale = (r: Awaited<ReturnType<typeof runGuardrailCheck>>) =>
        r.pairs.find((p) => p.kind === 'stale-file' && p.classification.status === 'added');

      // Step A — no allowlist: the finding blocks and carries no
      // suppression.
      const before = await runGuardrailCheck({ cwd: dir });
      const staleBefore = findStale(before);
      expect(staleBefore).toBeDefined();
      expect(staleBefore?.classification.blocks).toBe(true);
      expect(staleBefore?.suppressedByAllowlist).toBeUndefined();
      expect(before.blocks).toBe(true);
      const fp = staleBefore?.pair.currentId;
      expect(fp).toBeTruthy();

      // Step B — active (non-expiring) entry: the classifier still
      // says "would block," but an active allowlist match waives the
      // verdict. The pair records WHY.
      const dxkitDir = join(dir, '.dxkit');
      execFileSync('mkdir', ['-p', dxkitDir]);
      writeFileSync(
        join(dxkitDir, 'allowlist.json'),
        JSON.stringify(
          {
            schemaVersion: 'dxkit-allowlist/v1',
            mode: 'full',
            entries: [
              {
                fingerprint: fp,
                kind: 'stale-file',
                category: 'false-positive',
                reason: 'reviewed — generated build artifact, not source debt',
                addedBy: 'reviewer@example.com',
                addedAt: '2026-05-01',
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );
      const suppressed = await runGuardrailCheck({ cwd: dir });
      const staleSupp = findStale(suppressed);
      expect(staleSupp?.classification.blocks).toBe(true);
      expect(staleSupp?.suppressedByAllowlist?.category).toBe('false-positive');
      expect(staleSupp?.suppressedByAllowlist?.fingerprint).toBe(fp);
      expect(suppressed.blocks).toBe(false);

      // Renderers surface the suppression in its own bucket — verdict
      // PASSED, zero live blocks, but the finding stays visible.
      const consoleOut = renderConsole(suppressed);
      expect(consoleOut).toContain('Guardrail PASSED');
      expect(consoleOut).toContain('Suppressed by allowlist (1)');
      const jsonOut = renderJson(suppressed);
      expect(jsonOut.verdict.blocks).toBe(false);
      expect(jsonOut.summary.blocking).toBe(0);
      expect(jsonOut.summary.suppressed).toBe(1);
      const mdOut = renderMarkdown(suppressed);
      expect(mdOut).toContain('## Guardrail: PASSED');
      expect(mdOut).toContain('Suppressed by allowlist (1)');
    }, 300_000);
  });

  describe('error + policy + drift paths', () => {
    let dir: string;
    beforeEach(() => {
      dir = makeRepo();
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('errors on missing baseline, malformed --policy, missing --policy file', async () => {
      await expect(runGuardrailCheck({ cwd: dir })).rejects.toThrow(/baseline file not found/);

      await createBaseline({ cwd: dir });
      await expect(
        runGuardrailCheck({ cwd: dir, policyPath: join(dir, 'does-not-exist.json') }),
      ).rejects.toThrow(/not readable/);

      const policyPath = join(dir, 'broken.json');
      writeFileSync(policyPath, '{ this is not json');
      await expect(runGuardrailCheck({ cwd: dir, policyPath })).rejects.toThrow(/not valid JSON/);
    }, 300_000);

    it('auto-discovers .dxkit/policy.json when no --policy flag is passed', async () => {
      await createBaseline({ cwd: dir });
      writeFileSync(join(dir, 'leftover.bak'), 'x\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'add bak'], { cwd: dir });

      // Permissive policy at the conventional location — no flag.
      const dxkitDir = join(dir, '.dxkit');
      // The .dxkit/ dir already exists (baseline was created above).
      writeFileSync(
        join(dxkitDir, 'policy.json'),
        JSON.stringify({ block: [], warn: ['added'], blockRules: {} }, null, 2),
      );

      const result = await runGuardrailCheck({ cwd: dir });
      expect(result.policy.block).toEqual([]);
      expect(result.blocks).toBe(false);
      const addedPairs = result.pairs.filter((p) => p.classification.status === 'added');
      expect(addedPairs.length).toBeGreaterThan(0);
      for (const p of addedPairs) expect(p.classification.blocks).toBe(false);
    }, 300_000);

    it('permissive --policy override unblocks every `added` finding', async () => {
      await createBaseline({ cwd: dir });
      writeFileSync(join(dir, 'leftover.bak'), 'x\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'add bak'], { cwd: dir });

      const policyPath = join(dir, 'policy.json');
      writeFileSync(
        policyPath,
        JSON.stringify({ block: [], warn: ['added'], blockRules: {} }, null, 2),
      );
      const result = await runGuardrailCheck({ cwd: dir, policyPath });
      expect(result.policy.block).toEqual([]);
      expect(result.blocks).toBe(false);
      const addedPairs = result.pairs.filter((p) => p.classification.status === 'added');
      expect(addedPairs.length).toBeGreaterThan(0);
      for (const p of addedPairs) expect(p.classification.blocks).toBe(false);
    }, 300_000);

    it('reclassifies `added` as `config_drift` when the ignore file changes', async () => {
      await createBaseline({ cwd: dir });
      // Add a .dxkit-ignore + a new .bak in the same commit; the
      // ignore-hash drift demotes the added entry's status.
      writeFileSync(join(dir, '.dxkit-ignore'), 'fixtures/\n');
      writeFileSync(join(dir, 'leftover.bak'), 'x\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'add ignore + bak'], { cwd: dir });

      const result = await runGuardrailCheck({ cwd: dir });
      expect(result.envelopeDrift.ignoreHashChanged).toBe(true);
      const driftPairs = result.pairs.filter(
        (p) =>
          p.classification.status === 'config_drift' || p.classification.status === 'tooling_drift',
      );
      expect(driftPairs.length).toBeGreaterThan(0);
    }, 300_000);
  });
});

describe('runGuardrailCheck — identity-scheme migration guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('freshly created baselines are stamped with the current scheme', async () => {
    const created = await createBaseline({ cwd: dir });
    if (!created.path) throw new Error('expected committed-mode baseline');
    const bl = JSON.parse(readFileSync(created.path, 'utf8'));
    expect(bl.identityScheme).toBe('v2');
  });

  it('rejects a committed baseline minted under an older scheme, with an actionable message', async () => {
    const created = await createBaseline({ cwd: dir });
    if (!created.path) throw new Error('expected committed-mode baseline');
    const bl = JSON.parse(readFileSync(created.path, 'utf8'));
    bl.identityScheme = 'v1'; // simulate a pre-2.11 baseline
    writeFileSync(created.path, JSON.stringify(bl, null, 2));
    await expect(runGuardrailCheck({ cwd: dir })).rejects.toThrow(
      /identity.*scheme|scheme.*changed/i,
    );
    await expect(runGuardrailCheck({ cwd: dir })).rejects.toThrow(
      /vyuh-dxkit update|baseline create --force/,
    );
  }, 300_000);

  it('treats a baseline with no identityScheme field as the original scheme and rejects it', async () => {
    const created = await createBaseline({ cwd: dir });
    if (!created.path) throw new Error('expected committed-mode baseline');
    const bl = JSON.parse(readFileSync(created.path, 'utf8'));
    delete bl.identityScheme; // pre-field baseline
    writeFileSync(created.path, JSON.stringify(bl, null, 2));
    await expect(runGuardrailCheck({ cwd: dir })).rejects.toThrow(/scheme/i);
  }, 300_000);
});
