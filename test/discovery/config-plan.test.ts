/**
 * The deterministic config-planner contract (`vyuh-dxkit configure`).
 *
 * The whole value proposition of `configure` is REPRODUCIBILITY: the config a
 * repo gets is COMPUTED from observable facts, not chosen by an agent, so the
 * same repo yields the same plan on every run and in every environment. These
 * tests pin that:
 *   - each capability's `planConfig` is a pure function of repo facts (baseline
 *     reuses the canonical resolver via an injected visibility probe);
 *   - the plan is byte-identical across repeated runs;
 *   - `gatherConfigPlan` is registry-driven — a SYNTHETIC capability with its
 *     own `planConfig` flows through with no edit (the future-proof guarantee,
 *     mirror of the self-invocation / recipe playbooks);
 *   - `applyConfigPlan` merge-writes WITHOUT clobbering existing policy keys
 *     (the #68 discipline) and is idempotent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  gatherConfigPlan,
  type CapabilityDescriptor,
  type ConfigContext,
} from '../../src/discovery/commands';
import { applyConfigPlan, runConfigure } from '../../src/configure-cli';

const tmps: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-cfg-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writePolicy(dir: string, obj: unknown): void {
  fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dxkit', 'policy.json'), JSON.stringify(obj));
}

/** Deterministic probes so baseline planning never touches the network. */
const publicProbes: Omit<ConfigContext, 'cwd'> = {
  probeVisibility: () => 'public',
  probeDefaultRef: () => 'origin/main',
};
const privateProbes: Omit<ConfigContext, 'cwd'> = {
  probeVisibility: () => 'private',
  probeDefaultRef: () => 'origin/main',
};

describe('config planners — pure functions of repo facts', () => {
  it('baseline: public repo → ref-based (reuses the canonical resolver)', () => {
    const d = mkTmp();
    const plan = gatherConfigPlan(d, publicProbes);
    const baseline = plan.find((p) => p.capability === 'baseline');
    expect(baseline?.summary).toBe('ref-based (origin/main)');
    expect(baseline?.patch).toEqual({ baseline: { mode: 'ref-based', ref: 'origin/main' } });
  });

  it('baseline: private repo → committed-full', () => {
    const d = mkTmp();
    const baseline = gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'baseline');
    expect(baseline?.summary).toBe('committed-full');
    expect(baseline?.patch).toEqual({ baseline: { mode: 'committed-full' } });
  });

  it('baseline: already pinned → silent (no item)', () => {
    const d = mkTmp();
    writePolicy(d, { baseline: { mode: 'ref-based' } });
    const plan = gatherConfigPlan(d, publicProbes);
    expect(plan.find((p) => p.capability === 'baseline')).toBeUndefined();
  });

  it('flow: UI framework + no flow config → warn; configured → silent', () => {
    const d = mkTmp();
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18' } }),
    );
    const flow = gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'flow');
    expect(flow?.summary).toBe('warn');
    expect((flow?.patch as { flow: { mode: string } }).flow.mode).toBe('warn');
    // Silenced once a flow policy block exists.
    writePolicy(d, { flow: { mode: 'block' } });
    expect(gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'flow')).toBeUndefined();
  });

  it('checks: linter present + no lint policy → enabled warn-only; opted-in → silent', () => {
    const d = mkTmp();
    fs.writeFileSync(path.join(d, 'eslint.config.mjs'), 'export default {}');
    const lint = gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'checks');
    expect(lint?.patch).toEqual({ lint: { enabled: true, blocking: false } });
    // Silenced once the lint gate is enabled.
    writePolicy(d, { lint: { enabled: true } });
    expect(
      gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'checks'),
    ).toBeUndefined();
  });

  it('stamps the driving skill from the descriptor', () => {
    const d = mkTmp();
    fs.writeFileSync(path.join(d, 'eslint.config.mjs'), 'export default {}');
    const lint = gatherConfigPlan(d, privateProbes).find((p) => p.capability === 'checks');
    expect(lint?.skill).toBe('dxkit-checks');
  });
});

describe('config planner — determinism', () => {
  it('yields a byte-identical plan across repeated runs', () => {
    const d = mkTmp();
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18' } }),
    );
    fs.writeFileSync(path.join(d, 'eslint.config.mjs'), 'export default {}');
    const a = JSON.stringify(gatherConfigPlan(d, publicProbes));
    const b = JSON.stringify(gatherConfigPlan(d, publicProbes));
    expect(a).toBe(b);
  });

  it('is fail-open: an empty repo never throws (baseline still plans a default)', () => {
    const d = mkTmp();
    expect(() => gatherConfigPlan(d, privateProbes)).not.toThrow();
  });
});

describe('gatherConfigPlan — registry-driven (SYNTHETIC INJECTION)', () => {
  it('picks up a synthetic capability that declares its own planConfig', () => {
    const d = mkTmp();
    const fake: CapabilityDescriptor = {
      id: 'synthetic-cap',
      audience: 'user',
      group: 'setup',
      summary: 'synthetic',
      skill: 'dxkit-onboard',
      planConfig: () => ({
        capability: 'synthetic-cap',
        section: 'synthetic.knob',
        summary: 'on',
        patch: { synthetic: { knob: true } },
        reason: 'because the synthetic fact is present',
        evidence: 'synthetic=1',
      }),
    };
    // If gatherConfigPlan ever stopped iterating its registry argument, the
    // injected planner would be invisible and this would fail — the same
    // empirical guard the self-invocation + recipe playbooks use.
    const plan = gatherConfigPlan(d, privateProbes, [fake]);
    expect(plan).toHaveLength(1);
    expect(plan[0].section).toBe('synthetic.knob');
    expect(plan[0].skill).toBe('dxkit-onboard');
  });

  it('a throwing planner is skipped, never aborts the pass', () => {
    const d = mkTmp();
    const boom: CapabilityDescriptor = {
      id: 'boom',
      audience: 'user',
      group: 'setup',
      summary: 'boom',
      planConfig: () => {
        throw new Error('planner blew up');
      },
    };
    expect(() => gatherConfigPlan(d, privateProbes, [boom])).not.toThrow();
    expect(gatherConfigPlan(d, privateProbes, [boom])).toEqual([]);
  });
});

describe('applyConfigPlan — merge-safe, idempotent (#68 discipline)', () => {
  it('merges the plan while preserving every existing policy key', () => {
    const d = mkTmp();
    writePolicy(d, { code: { block: ['critical'] } });
    const plan = gatherConfigPlan(d, publicProbes);
    const res = applyConfigPlan(d, plan);
    expect(res.changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(d, '.dxkit', 'policy.json'), 'utf8'));
    // User's key survives.
    expect(after.code).toEqual({ block: ['critical'] });
    // Baseline section was merged in.
    expect(after.baseline.mode).toBe('ref-based');
  });

  it('is idempotent: applying the same plan twice leaves the file unchanged', () => {
    const d = mkTmp();
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18' } }),
    );
    const plan = gatherConfigPlan(d, privateProbes);
    expect(applyConfigPlan(d, plan).changed).toBe(true);
    // Re-planning now returns nothing (sections are pinned) → nothing to apply.
    expect(gatherConfigPlan(d, privateProbes).length).toBe(0);
    // Re-applying the ORIGINAL plan is still a no-op on the merged file.
    expect(applyConfigPlan(d, plan).changed).toBe(false);
  });

  it('nested merge preserves sibling keys within a section', () => {
    const d = mkTmp();
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18' } }),
    );
    // User already set flow.specs; the planner sets flow.mode — both must survive.
    writePolicy(d, { flow: { specs: ['openapi.yaml'] } });
    // flow planner is silent when a flow block exists, so drive the merge directly.
    applyConfigPlan(d, [
      {
        capability: 'flow',
        section: 'flow.mode',
        summary: 'warn',
        patch: { flow: { mode: 'warn' } },
        reason: 'r',
        evidence: 'e',
      },
    ]);
    const after = JSON.parse(fs.readFileSync(path.join(d, '.dxkit', 'policy.json'), 'utf8'));
    expect(after.flow).toEqual({ specs: ['openapi.yaml'], mode: 'warn' });
  });

  it('leaves a malformed policy.json intact (never clobbers unparseable input)', () => {
    const d = mkTmp();
    fs.mkdirSync(path.join(d, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(d, '.dxkit', 'policy.json'), '{ not json');
    const res = applyConfigPlan(d, [
      {
        capability: 'baseline',
        section: 'baseline.mode',
        summary: 'committed-full',
        patch: { baseline: { mode: 'committed-full' } },
        reason: 'r',
        evidence: 'e',
      },
    ]);
    expect(res.changed).toBe(false);
    expect(fs.readFileSync(path.join(d, '.dxkit', 'policy.json'), 'utf8')).toBe('{ not json');
  });

  it('empty plan is a no-op', () => {
    const d = mkTmp();
    expect(applyConfigPlan(d, []).changed).toBe(false);
  });
});

describe('configure check — the enforceable drift detector', () => {
  const origExit = process.exitCode;
  afterEach(() => {
    process.exitCode = origExit;
  });

  it('exits non-zero when a recommended section is un-applied, zero once applied', () => {
    const d = mkTmp();
    fs.writeFileSync(path.join(d, 'eslint.config.mjs'), 'export default {}');
    // Un-applied → check fails.
    process.exitCode = 0;
    runConfigure(d, { check: true, json: true, probes: privateProbes });
    expect(process.exitCode).toBe(1);
    // Apply, then check passes.
    applyConfigPlan(d, gatherConfigPlan(d, privateProbes));
    process.exitCode = 0;
    runConfigure(d, { check: true, json: true, probes: privateProbes });
    expect(process.exitCode).toBe(0);
  });
});
