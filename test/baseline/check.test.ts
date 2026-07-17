import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';
import { computeFlowBindingFingerprint } from '../../src/analyzers/tools/fingerprint';

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

    it('captures a failing user custom-check into the baseline and grandfathers it (#25)', async () => {
      // A user-declared check that always fails. createBaseline runs it (scope
      // includes customChecks because the policy configured one), the producer
      // folds its failure into a `custom-check` baseline entry, and the guardrail
      // matches it as PERSISTED (pre-existing) — grandfathered, not a net-new block.
      mkdirSync(join(dir, '.dxkit'), { recursive: true });
      writeFileSync(
        join(dir, '.dxkit', 'policy.json'),
        JSON.stringify({
          checks: [{ name: 'custom:always-fail', command: ['node', '-e', 'process.exit(1)'] }],
        }),
      );
      const created = await createBaseline({ cwd: dir });
      const ccEntries = (created.file?.findings ?? []).filter((f) => f.kind === 'custom-check');
      expect(ccEntries.length).toBe(1);
      expect(ccEntries[0]).toMatchObject({ kind: 'custom-check', check: 'custom:always-fail' });

      const result = await runGuardrailCheck({ cwd: dir });
      // The still-failing check is present on both sides → persisted, not net-new.
      const ccPairs = result.pairs.filter((p) => p.kind === 'custom-check');
      expect(ccPairs.length).toBe(1);
      expect(ccPairs[0].classification.status).toBe('persisted');
      expect(ccPairs[0].classification.blocks).toBe(false);
    });

    it('renderers surface an UNMEASURED dependency audit — fail-loud, no silent clean (#73)', async () => {
      await createBaseline({ cwd: dir });
      const base = await runGuardrailCheck({ cwd: dir });
      // The guardrail sets depVulnsUnmeasured when a REQUESTED dep scan could not
      // run (scanner absent). A pass must not then read as "no net-new dep vulns".
      const unmeasured = { ...base, depVulnsUnmeasured: { reason: 'pip-audit not installed' } };
      const md = renderMarkdown(unmeasured);
      expect(md).toContain('Dependency audit UNMEASURED');
      expect(md).toContain('pip-audit not installed');
      expect(renderConsole(unmeasured)).toContain('UNMEASURED');
      expect(renderJson(unmeasured).depVulnsUnmeasured?.reason).toBe('pip-audit not installed');
      // The unmeasured signal is orthogonal to the verdict (it doesn't force a
      // block); it makes the gap VISIBLE rather than silently clean.
      expect(renderJson(base).depVulnsUnmeasured).toBeUndefined();
    });

    it('arming banner surfaces a deferred capture without changing the verdict (Rule 20)', async () => {
      await createBaseline({ cwd: dir });
      const base = await runGuardrailCheck({ cwd: dir });
      // A baseline captured where a scanner could not run (stale mirror) records
      // the class as deferred; the gate reads it into `deferredCapture`.
      const armed = {
        ...base,
        deferredCapture: [
          {
            id: 'semgrep',
            label: 'Static analysis security scanner (SAST)',
            reason: 'mirror',
            cause: 'scanner-missing' as const,
          },
        ],
      };
      // Loud in every renderer — never a silent green pass over an unobserved class.
      expect(renderConsole(armed)).toContain('COMPLETING ON CI');
      expect(renderConsole(armed)).toContain('Static analysis security scanner (SAST)');
      expect(renderMarkdown(armed)).toContain('COMPLETING ON CI');
      expect(renderJson(armed).deferredCapture).toHaveLength(1);
      // Orthogonal to the verdict: the deferred classes warn via recall, they do
      // not force a block. Exit code is exactly what it was without the marker.
      expect(renderJson(armed).verdict.exitCode).toBe(renderJson(base).verdict.exitCode);
      // A complete capture shows nothing new.
      expect(renderJson(base).deferredCapture).toBeUndefined();
      expect(renderConsole(base)).not.toContain('COMPLETING ON CI');
    });

    it('reads a committed baseline’s deferred marker end-to-end, honestly, without blocking (Rule 20)', async () => {
      const created = await createBaseline({ cwd: dir });
      expect(created.path).toBeDefined();
      // Simulate the incident: a capture that could not observe a class (a stale
      // mirror couldn't install the scanner) lands a `deferred` record on the
      // committed baseline instead of fail-open-committing it as measured.
      const file = JSON.parse(readFileSync(created.path!, 'utf8'));
      file.deferred = [
        {
          id: 'semgrep',
          label: 'Static analysis security scanner (SAST)',
          reason: 'behind a mirror',
          cause: 'scanner-missing',
        },
      ];
      writeFileSync(created.path!, JSON.stringify(file, null, 2));

      const result = await runGuardrailCheck({ cwd: dir });
      // The gate READS it from disk (not injected) — proves the whole wiring:
      // baseline.deferred → result.deferredCapture → arming banner.
      expect(result.deferredCapture).toHaveLength(1);
      expect(result.deferredCapture![0].id).toBe('semgrep');
      expect(renderConsole(result)).toContain('COMPLETING ON CI');
      // Honest, NOT a false block: nothing net-new here, and the deferred class
      // is disclosed rather than silently certified.
      expect(result.blocks).toBe(false);
      expect(renderJson(result).verdict.exitCode).toBe(0);
      expect(renderJson(result).deferredCapture).toHaveLength(1);
    });

    it('UNMEASURED remediation is reason-aware — absent vs present-but-unusable (#15)', async () => {
      await createBaseline({ cwd: dir });
      const base = await runGuardrailCheck({ cwd: dir });

      // Scanner genuinely absent → "tools install" is the right fix.
      const absent = { ...base, depVulnsUnmeasured: { reason: 'osv-scanner not installed' } };
      expect(renderConsole(absent)).toContain('tools install');
      expect(renderMarkdown(absent)).toContain('tools install');

      // Scanner PRESENT but the repo has no lockfile → don't tell the user to
      // reinstall; tell them to generate a lockfile.
      const noLock = {
        ...base,
        depVulnsUnmeasured: { reason: 'no lockfile to audit (package-lock.json / pnpm-lock.yaml)' },
      };
      expect(renderConsole(noLock)).not.toContain('tools install');
      expect(renderConsole(noLock).toLowerCase()).toContain('lockfile');

      // Scanner ran and failed at runtime → not an install problem either.
      const failed = { ...base, depVulnsUnmeasured: { reason: 'npm audit parse error: boom' } };
      expect(renderConsole(failed)).not.toContain('tools install');
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
      // #21: the fingerprint is printed on the finding line so `allowlist add
      // --fingerprint=<id>` can be copy-pasted straight from gate output.
      expect(consoleOut).toContain('fingerprint:');
      expect(consoleOut).toContain('allowlist add --fingerprint=');
      const jsonOut = renderJson(result);
      expect(jsonOut.summary.pairs).toBeGreaterThan(0);
      const mdOut = renderMarkdown(result);
      expect(mdOut).toMatch(/_Baseline_:/);
      expect(mdOut).toContain('Fingerprint'); // #21: markdown table carries the column

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

    it('an allowlist entry suppresses a WARNING-class finding too, not just a blocking one (#23)', async () => {
      await createBaseline({ cwd: dir });
      writeFileSync(join(dir, 'leftover.bak'), 'old\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'drop a .bak'], { cwd: dir });

      // Warn-only policy: the stale-file `added` finding WARNS (not blocks).
      const policyPath = join(dir, 'warn-policy.json');
      writeFileSync(policyPath, JSON.stringify({ block: [], warn: ['added'], blockRules: {} }));
      const findStale = (r: Awaited<ReturnType<typeof runGuardrailCheck>>) =>
        r.pairs.find((p) => p.kind === 'stale-file' && p.classification.status === 'added');

      const before = await runGuardrailCheck({ cwd: dir, policyPath });
      const staleBefore = findStale(before);
      expect(staleBefore?.classification.warns).toBe(true);
      expect(staleBefore?.classification.blocks).toBe(false);
      expect(staleBefore?.suppressedByAllowlist).toBeUndefined();
      expect(before.warns).toBe(true);
      const fp = staleBefore?.pair.currentId;
      expect(fp).toBeTruthy();

      // Allowlist it. The #23 bug: suppression was gated on `blocks`, so a
      // warning was never waived and persisted forever. Now it must be
      // suppressed + dropped from the warning verdict/count.
      const dxkitDir = join(dir, '.dxkit');
      execFileSync('mkdir', ['-p', dxkitDir]);
      writeFileSync(
        join(dxkitDir, 'allowlist.json'),
        JSON.stringify({
          schemaVersion: 'dxkit-allowlist/v1',
          mode: 'full',
          entries: [
            {
              fingerprint: fp,
              kind: 'stale-file',
              category: 'false-positive',
              reason: 'reviewed — generated artifact',
              addedBy: 'reviewer@example.com',
              addedAt: '2026-05-01',
            },
          ],
        }),
      );

      const after = await runGuardrailCheck({ cwd: dir, policyPath });
      const staleAfter = findStale(after);
      expect(staleAfter?.suppressedByAllowlist).toBeDefined(); // suppression ran for a WARNING
      expect(after.warns).toBe(false); // the warning is waived from the verdict
      // Renderers: it moves to the suppressed bucket, not the warnings bucket.
      const jsonOut = renderJson(after);
      expect(jsonOut.summary.suppressed).toBe(1);
      expect(jsonOut.summary.warning).toBe(0);
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

    it('a finding on a diff-added file stays `added` even when the ignore file also changed (#19)', async () => {
      await createBaseline({ cwd: dir });
      // The developer adds a .dxkit-ignore AND a new .bak file in the same
      // commit. The ignore hash changes, but the stale-file finding is on the
      // BRAND-NEW file the diff itself added — it's developer-introduced, so it
      // must stay `added`, NOT be re-labelled config_drift just because config
      // changed alongside it (feedback #19). (config_drift's genuine case — a
      // finding on an UNCHANGED file surfaced by the ignore change — is unit-
      // tested in policy.test.ts.)
      writeFileSync(join(dir, '.dxkit-ignore'), 'fixtures/\n');
      writeFileSync(join(dir, 'leftover.bak'), 'x\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'add ignore + bak'], { cwd: dir });

      const result = await runGuardrailCheck({ cwd: dir });
      expect(result.envelopeDrift.ignoreHashChanged).toBe(true);
      const staleBak = result.pairs.find((p) => p.kind === 'stale-file');
      expect(staleBak?.classification.status).toBe('added');
      expect(staleBak?.classification.reasons.some((r) => r.code === 'config-drift')).toBe(false);
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

describe('runGuardrailCheck — flow integration gate seam', () => {
  // Proves the flow gate is actually folded into the top-level verdict — not
  // just that the helper works in isolation. A monorepo fixture (backend route
  // + frontend call) run ref-based against `main` with a net-new dead call must
  // flip result.blocks and attach result.flowGate. Full pipeline (~15s).
  function makeFlowRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-guardrail-flow-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
    writeFileSync(join(dir, 'client.ts'), "axios.get('/articles');\n");
    writeFileSync(join(dir, 'server.ts'), "class C { @get('/articles') a() {} }\n");
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    return dir;
  }

  let dir: string;
  beforeEach(() => {
    dir = makeFlowRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ref-based mode carries recall on the prior side — no spurious drift (Rule 2.30 regression)', async () => {
    // The ref-based prior side is gathered by the same dxkit on the same machine,
    // so its recall inputs are identical to the current side's and `diffRecall`
    // must report ZERO drift. Before `scanToBaselineFile` unified the conversion,
    // `loadPriorSide` hand-built the prior BaselineFile and dropped `recall`, so
    // every kind read as `absent-from-baseline` and drifted on every ref-based
    // run (the public-repo default, the loop, `evaluate`, the self-guardrail).
    const result = await runGuardrailCheck({ cwd: dir, cliMode: 'ref-based', cliRef: 'main' });
    // The prior side carries recall (the direct fix): undefined before.
    expect(result.baseline.recall).toBeDefined();
    expect(Object.keys(result.baseline.recall ?? {}).length).toBeGreaterThan(0);
    // And it also carries coverage — dropped by the same omission.
    expect(result.baseline.coverage).toBeDefined();
    // Same env on both sides ⇒ no recall drift, no "cannot attribute" noise.
    expect(result.envelopeDrift.recallDrift).toEqual([]);
  }, 300_000);

  it('folds a net-new broken integration into the top-level BLOCK verdict', async () => {
    writeFileSync(join(dir, 'client.ts'), "axios.get('/articles');\naxios.get('/dead');\n");
    const result = await runGuardrailCheck({ cwd: dir, cliMode: 'ref-based', cliRef: 'main' });
    expect(result.blocks).toBe(true);
    expect(result.flowGate?.ran).toBe(true);
    expect(result.flowGate?.findings.map((f) => f.path)).toContain('/dead');
    // The finding surfaces in the JSON payload the CLI + Stop-gate consume.
    const json = renderJson(result);
    expect(json.flowGate?.findings.some((f) => f.path === '/dead')).toBe(true);
    expect(json.verdict.blocks).toBe(true);

    // The report tells ONE verdict story: the console header counts the flow
    // block, and the summary reconciles it via a Flow line (not a pairs-only
    // "blocking: 0" over a "BLOCKED — 1 regression" header). The finding also
    // prints its fingerprint so a reviewer can allowlist it from the output.
    const fp = computeFlowBindingFingerprint('GET', '/dead', 'client.ts');
    const consoleOut = renderConsole(result);
    expect(consoleOut).toContain('Guardrail BLOCKED — 1 new regression');
    expect(consoleOut).toMatch(/Flow:\s+1 \(blocking: 1,/);
    // The finding prints the FULL escape-hatch command (kind is always
    // flow-binding), so an intentional break is accepted from the output.
    expect(consoleOut).toContain(
      `allowlist add --fingerprint=${fp} --kind=flow-binding --category=false-positive`,
    );
    // The markdown (PR comment) carries the fingerprint in the flow table.
    const md = renderMarkdown(result);
    expect(md).toContain('Fingerprint');
    expect(md).toContain(fp);
  }, 300_000);

  it('warn flowMode surfaces the breakage without blocking the build', async () => {
    writeFileSync(join(dir, 'client.ts'), "axios.get('/articles');\naxios.get('/dead');\n");
    const result = await runGuardrailCheck({
      cwd: dir,
      cliMode: 'ref-based',
      cliRef: 'main',
      flowMode: 'warn',
    });
    expect(result.flowGate?.ran).toBe(true);
    expect(result.flowGate?.findings.map((f) => f.path)).toContain('/dead');
    // Flow warns, so IT does not block; the overall verdict isn't forced by flow.
    expect(result.flowGate?.blocks).toBe(false);
  }, 300_000);

  it('an allowlisted flow finding is waived from the top-level verdict', async () => {
    writeFileSync(join(dir, 'client.ts'), "axios.get('/articles');\naxios.get('/dead');\n");
    // Commit an allowlist accepting the /dead binding by its fingerprint — the
    // guardrail's own loadAllowlist must honor it for flow, like any kind.
    const fp = computeFlowBindingFingerprint('GET', '/dead', 'client.ts');
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'allowlist.json'),
      JSON.stringify({
        schemaVersion: 'dxkit-allowlist/v1',
        mode: 'full',
        identityScheme: 'v2',
        entries: [
          {
            fingerprint: fp,
            kind: 'flow-binding',
            category: 'false-positive',
            addedAt: '2026-01-01',
            reason: 'served externally',
            addedBy: 'test',
          },
        ],
      }),
    );
    const result = await runGuardrailCheck({ cwd: dir, cliMode: 'ref-based', cliRef: 'main' });
    expect(result.flowGate?.ran).toBe(true);
    expect(result.blocks).toBe(false); // the flow block was waived
    expect(result.flowGate?.suppressed.map((s) => s.finding.path)).toContain('/dead');
    expect(result.flowGate?.findings).toEqual([]);
  }, 300_000);

  it('gates in committed mode against the baseline anchor commit (not only ref-based)', async () => {
    // Committed mode has no committed prior flow side, but it DOES record the
    // baseline's anchor `repo.commitSha`. The gate must diff HEAD against that
    // commit — so a private repo on the default committed-full is flow-gated too.
    await createBaseline({ cwd: dir });
    writeFileSync(join(dir, 'client.ts'), "axios.get('/articles');\naxios.get('/dead');\n");
    const result = await runGuardrailCheck({ cwd: dir, cliMode: 'committed-full' });
    expect(result.mode.mode).toBe('committed-full');
    expect(result.flowGate?.ran).toBe(true);
    expect(result.flowGate?.findings.map((f) => f.path)).toContain('/dead');
    expect(result.blocks).toBe(true);
  }, 300_000);
});
