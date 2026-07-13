import { describe, it, expect } from 'vitest';
import {
  buildRepoCard,
  labelForRoute,
  labelForCall,
  labelForBinding,
  labelForModel,
} from '../../src/describe/repo-card';
import { REPO_CARD_SCHEMA } from '../../src/describe/repo-card-schema';
import type { DescribeInput } from '../../src/describe/gather';

/**
 * Freeze net for `dxkit.repo-card.v1` (mirror of
 * `test/evaluate/evidence.test.ts`): the schema id and the top-level field
 * set are pinned. A field ADDITION here needs review; a REMOVAL or reshape
 * is a new `…v2` id. The label mapping is pinned separately since it is the
 * card's whole honesty contract.
 */

/** A minimal, fully-synthetic input so the freeze test needs no real repo. */
function fakeInput(overrides: Partial<DescribeInput> = {}): DescribeInput {
  return {
    stack: {
      languages: {} as never,
      infrastructure: { docker: true, postgres: false, redis: false },
      projectName: 'demo',
      projectDescription: 'a demo repo',
      versions: {},
      framework: 'express',
      requiredTools: [],
    } as never,
    provenance: {
      commitSha: 'abc1234',
      branch: 'main',
      cwd: '/tmp/demo',
      dxkitVersion: '3.7.0',
      ignoreFileMtime: null,
      inputsDigest: null,
      workingTreeDirty: false,
    },
    flow: {
      calls: [],
      routes: [],
      bindings: [],
      dynamicCalls: [],
    },
    diagnosis: null,
    coverage: {
      callSitesSeen: 0,
      extracted: 0,
      dynamic: 0,
      dynamicSites: [],
      paths: { exact: 0, templated: 0, opaque: 0 },
      note: 'no calls',
    },
    models: { models: [], dynamicModels: [] },
    freshness: null,
    ...overrides,
  };
}

describe('repo-card schema freeze', () => {
  it('pins the schema id', () => {
    expect(REPO_CARD_SCHEMA).toBe('dxkit.repo-card.v1');
  });

  it('pins the v1 top-level field set (additions require review; removals require a v2)', () => {
    const doc = buildRepoCard(fakeInput());
    expect(Object.keys(doc).sort()).toEqual(
      [
        'schema',
        'generatedAt',
        'dxkitVersion',
        'provenance',
        'stack',
        'flow',
        'models',
        'freshness',
        'coverage',
        'notes',
        'zeroWrite',
      ].sort(),
    );
  });

  it('always declares zero-write and the envelope schema', () => {
    const doc = buildRepoCard(fakeInput());
    expect(doc.zeroWrite).toBe(true);
    expect(doc.schema).toBe('dxkit.repo-card.v1');
    expect(new Date(doc.generatedAt).toString()).not.toBe('Invalid Date');
  });

  it('carries observed stack facts', () => {
    const doc = buildRepoCard(fakeInput());
    expect(doc.stack.name).toBe('demo');
    expect(doc.stack.framework).toBe('express');
    expect(doc.stack.infrastructure).toEqual(['docker']);
  });
});

describe('repo-card epistemic label mapping', () => {
  it('routes: static extraction is observed, declared contract is derived', () => {
    expect(labelForRoute('decorator')).toBe('observed');
    expect(labelForRoute('router-call')).toBe('observed');
    expect(labelForRoute('file-route')).toBe('observed');
    expect(labelForRoute('spec')).toBe('derived');
    expect(labelForRoute('openapi')).toBe('derived');
  });

  it('calls: literal URL is observed, computed URL is unknown', () => {
    expect(labelForCall({ path: '/api/users' })).toBe('observed');
    expect(labelForCall({ path: null })).toBe('unknown');
  });

  it('bindings: confidence tiers map to the honesty vocabulary', () => {
    expect(labelForBinding('exact')).toBe('observed');
    expect(labelForBinding('var-match')).toBe('derived');
    expect(labelForBinding('catch-all')).toBe('inferred');
    expect(labelForBinding('placeholder-only')).toBe('inferred');
    expect(labelForBinding('no-route')).toBe('unknown');
    expect(labelForBinding('external')).toBe('unknown');
  });

  it('models: spec-sourced is derived, extracted is observed', () => {
    expect(labelForModel('spec')).toBe('derived');
    expect(labelForModel('base-class')).toBe('observed');
    expect(labelForModel('struct-tag')).toBe('observed');
  });

  it('tallies sum to the total across labels', () => {
    const doc = buildRepoCard(fakeInput());
    const { total, observed, derived, inferred, unknown } = doc.flow.routes;
    expect(observed + derived + inferred + unknown).toBe(total);
  });
});
