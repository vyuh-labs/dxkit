import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ANCHOR_RULESET_NAME,
  anchorRefsFromPolicy,
  planAnchorRuleset,
  type RulesetDetail,
} from '../src/anchor-ruleset';
import { protectAnchorBranches, type GhApiFn } from '../src/setup-branch-protection';
import { GhError } from '../src/setup-gh';

/**
 * The PREVENT layer of the deleted-anchor class. Pure-planner matrix first
 * (no GitHub needed), then the executor through an injected `gh` recorder —
 * the gh-api harness that let this layer ship without a live repo.
 */

describe('anchorRefsFromPolicy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-anchorrefs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writePolicy = (policy: unknown): void => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy));
  };

  it('empty without a policy / without anchor-bearing sections', () => {
    expect(anchorRefsFromPolicy(dir)).toEqual([]);
    writePolicy({ baseline: { mode: 'ref-based' } });
    expect(anchorRefsFromPolicy(dir)).toEqual([]);
    writePolicy({ baseline: { anchor: 'tree' }, reports: { onMerge: false } });
    expect(anchorRefsFromPolicy(dir)).toEqual([]);
  });

  it('resolves the same refs the writers and readers use (defaults + overrides)', () => {
    writePolicy({ baseline: { anchor: 'branch' } });
    expect(anchorRefsFromPolicy(dir)).toEqual(['dxkit-baselines']);
    writePolicy({
      baseline: { anchor: 'branch', anchorRef: 'my-anchors' },
      reports: { onMerge: true },
    });
    expect(anchorRefsFromPolicy(dir)).toEqual(['my-anchors', 'dxkit-reports']);
    writePolicy({ reports: { onMerge: true, anchorRef: 'my-reports' } });
    expect(anchorRefsFromPolicy(dir)).toEqual(['my-reports']);
  });
});

describe('planAnchorRuleset (pure)', () => {
  it('nothing to do when no refs are configured', () => {
    const plan = planAnchorRuleset([], null);
    expect(plan.action).toBe('none');
  });

  it('creates a deletion-only ruleset when none exists', () => {
    const plan = planAnchorRuleset(['dxkit-baselines', 'dxkit-reports'], null);
    expect(plan.action).toBe('create');
    expect(plan.payload).toEqual({
      name: ANCHOR_RULESET_NAME,
      target: 'branch',
      enforcement: 'active',
      conditions: {
        ref_name: {
          include: ['refs/heads/dxkit-baselines', 'refs/heads/dxkit-reports'],
          exclude: [],
        },
      },
      rules: [{ type: 'deletion' }],
    });
    // The load-bearing negative: the refresh force-pushes orphan commits, so
    // the ruleset must never restrict pushes — deletion is the ONLY rule.
    expect(plan.payload?.rules).toHaveLength(1);
  });

  it('no-ops when the existing ruleset already covers every ref', () => {
    const existing: RulesetDetail = {
      id: 7,
      name: ANCHOR_RULESET_NAME,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/dxkit-baselines'], exclude: [] } },
      rules: [{ type: 'deletion' }],
    };
    expect(planAnchorRuleset(['dxkit-baselines'], existing).action).toBe('none');
  });

  it('updates to add a missing ref, preserving everything else (non-clobber)', () => {
    const existing: RulesetDetail = {
      id: 7,
      name: ANCHOR_RULESET_NAME,
      target: 'branch',
      enforcement: 'active',
      conditions: {
        ref_name: { include: ['refs/heads/dxkit-baselines'], exclude: ['refs/heads/keep'] },
      },
      rules: [{ type: 'deletion' }],
    };
    const plan = planAnchorRuleset(['dxkit-baselines', 'dxkit-reports'], existing);
    expect(plan.action).toBe('update');
    expect(plan.rulesetId).toBe(7);
    expect(plan.payload?.conditions?.ref_name?.include).toEqual([
      'refs/heads/dxkit-baselines',
      'refs/heads/dxkit-reports',
    ]);
    expect(plan.payload?.conditions?.ref_name?.exclude).toEqual(['refs/heads/keep']);
    // PUT body addresses the ruleset by URL, not by an id field.
    expect(plan.payload && 'id' in plan.payload && plan.payload.id).toBeFalsy();
  });

  it('repairs a ruleset that lost its deletion rule or was disabled', () => {
    const noRule: RulesetDetail = {
      id: 7,
      name: ANCHOR_RULESET_NAME,
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/dxkit-baselines'], exclude: [] } },
      rules: [],
    };
    const p1 = planAnchorRuleset(['dxkit-baselines'], noRule);
    expect(p1.action).toBe('update');
    expect(p1.payload?.rules).toEqual([{ type: 'deletion' }]);

    const disabled: RulesetDetail = {
      ...noRule,
      enforcement: 'disabled',
      rules: [{ type: 'deletion' }],
    };
    const p2 = planAnchorRuleset(['dxkit-baselines'], disabled);
    expect(p2.action).toBe('update');
    expect(p2.payload?.enforcement).toBe('active');
  });
});

describe('protectAnchorBranches (injected gh — the gh-api harness)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-anchorprotect-'));
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { anchor: 'branch' } }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  interface Call {
    endpoint: string;
    method?: string;
    body?: unknown;
  }
  const recorder = (responses: Record<string, unknown> = {}): { calls: Call[]; gh: GhApiFn } => {
    const calls: Call[] = [];
    const gh: GhApiFn = (endpoint, opts) => {
      calls.push({
        endpoint,
        ...(opts.method !== undefined ? { method: opts.method } : {}),
        ...(opts.inputJson !== undefined ? { body: JSON.parse(opts.inputJson) } : {}),
      });
      if (endpoint in responses) return responses[endpoint];
      return null;
    };
    return { calls, gh };
  };

  it('dry run reads but never writes', () => {
    const { calls, gh } = recorder();
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', dryRun: true, gh });
    expect(calls.every((c) => !c.method || c.method === 'GET')).toBe(true);
  });

  it('apply POSTs the create payload when no ruleset exists', () => {
    const { calls, gh } = recorder();
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.endpoint).toBe('repos/o/r/rulesets');
    expect(post?.body).toMatchObject({
      name: ANCHOR_RULESET_NAME,
      rules: [{ type: 'deletion' }],
    });
  });

  it('apply PUTs a merged update onto the existing dxkit ruleset', () => {
    const { calls, gh } = recorder({
      'repos/o/r/rulesets': [{ id: 42, name: ANCHOR_RULESET_NAME }],
      'repos/o/r/rulesets/42': {
        id: 42,
        name: ANCHOR_RULESET_NAME,
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/other'], exclude: [] } },
        rules: [{ type: 'deletion' }],
      },
    });
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.endpoint).toBe('repos/o/r/rulesets/42');
    expect((put?.body as RulesetDetail).conditions?.ref_name?.include).toEqual([
      'refs/heads/other',
      'refs/heads/dxkit-baselines',
    ]);
  });

  it('no-ops (no write) when the ruleset already covers the anchor', () => {
    const { calls, gh } = recorder({
      'repos/o/r/rulesets': [{ id: 42, name: ANCHOR_RULESET_NAME }],
      'repos/o/r/rulesets/42': {
        id: 42,
        name: ANCHOR_RULESET_NAME,
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/dxkit-baselines'], exclude: [] } },
        rules: [{ type: 'deletion' }],
      },
    });
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh });
    expect(calls.some((c) => c.method === 'POST' || c.method === 'PUT')).toBe(false);
  });

  it('never touches a customer ruleset with a different name', () => {
    const { calls, gh } = recorder({
      'repos/o/r/rulesets': [{ id: 9, name: 'corp-branch-rules' }],
    });
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh });
    // Not even a detail read of the foreign ruleset; the write creates OURS.
    expect(calls.some((c) => c.endpoint === 'repos/o/r/rulesets/9')).toBe(false);
    expect(calls.find((c) => c.method === 'POST')?.endpoint).toBe('repos/o/r/rulesets');
  });

  it('a gh failure warns and degrades — never throws, never fails the command', () => {
    const gh: GhApiFn = () => {
      throw new GhError('Permission denied — you need admin rights on the repo.', {
        httpStatus: 403,
      });
    };
    expect(() => protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh })).not.toThrow();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('silent no-op when the policy configures no anchor branches', () => {
    writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify({}));
    const { calls, gh } = recorder();
    protectAnchorBranches(dir, { owner: 'o', repo: 'r', gh });
    expect(calls).toHaveLength(0);
  });
});
