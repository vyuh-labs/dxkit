/**
 * The recipe registry as the tier decider, synthetic-injection guarded, and
 * the class table as the spine (recipes and pending producers pinned).
 */
import { describe, it, expect } from 'vitest';
import {
  assignTier,
  planWorkOrders,
  type FloorFailureInput,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import { RECIPE_REGISTRY, matchRecipe } from '../../../src/remediate/work-orders/recipes-registry';
import {
  WORK_ORDER_CLASSES,
  type WorkOrderClassDeclaration,
} from '../../../src/remediate/work-orders/types';
import type { WorkOrder } from '../../../src/remediate/work-orders/types';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const NPM_CI = { bin: 'npm', args: ['ci'] };

function empty(): PlannerInput {
  return {
    floorFailures: [],
    blocking: [],
    deferred: [],
    debt: [],
    manifests: [{ dir: '', files: ['package-lock.json', 'package.json'] }],
    installFor: () => NPM_CI,
    policy: { maxSliceSize: 25, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
  };
}

const BUILD_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'typecheck',
  command: 'npx tsc --noEmit',
  attribution: 'pre-existing',
};

const IMPORT_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'import-resolution',
  command: '',
  attribution: 'net-new',
  precision: 'finding',
  netNewFindings: ['left-pad'],
  findings: ['left-pad'],
  unresolved: [{ specifier: 'left-pad', file: 'src/b.ts' }],
};

describe('recipe registry drives the tier (synthetic injection)', () => {
  const draft: Omit<WorkOrder, 'tier' | 'recipe'> = {
    id: 'synthetic-class:unit',
    class: 'synthetic-class',
    findings: [],
    envelope: { paths: ['x'], manifests: false },
    constraints: { forbidden: [] },
    done: { absentIds: [], verifier: 'guardrail', command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    provenance: { source: 'guardrail-blocking' },
  };

  it('an order of an unregistered class tiers agent under the built-in registry', () => {
    expect(assignTier(draft).tier).toBe('agent');
    expect(matchRecipe({ ...draft, tier: 'agent' })).toBeUndefined();
  });

  it('a fake recipe for a fake class, injected into the registry, tiers the order recipe', () => {
    const fake = {
      id: 'synthetic-fixer',
      class: 'synthetic-class',
      summary: 't',
      implemented: false,
      matches: () => true,
    };
    const tiered = assignTier(draft, [...RECIPE_REGISTRY, fake]);
    expect(tiered.tier).toBe('recipe');
    expect(tiered.recipe).toBe('synthetic-fixer');
  });

  it('the planner reads the registry it is handed (a fake recipe flips a real order)', () => {
    const input: PlannerInput = { ...empty(), floorFailures: [BUILD_FAILURE] };
    expect(planWorkOrders(input).orders[0].tier).toBe('agent');
    const fake = {
      id: 'floor-fixer',
      class: 'floor-failure',
      summary: 't',
      implemented: false,
      matches: () => true,
    };
    const flipped = planWorkOrders(input, { registry: [...RECIPE_REGISTRY, fake] }).orders[0];
    expect(flipped.tier).toBe('recipe');
    expect(flipped.recipe).toBe('floor-fixer');
  });

  it('a recipe needing the install step declines an order without one (a python-shaped repo never tiers an npm recipe)', () => {
    const noInstall = planWorkOrders({
      ...empty(),
      floorFailures: [IMPORT_FAILURE],
      installFor: () => undefined,
    });
    for (const o of noInstall.orders.filter((x) => x.class === 'unresolved-import')) {
      expect(o.tier).toBe('agent');
    }
  });

  it('the class table is the spine: every declared recipe is named by exactly its class, and vice versa', () => {
    const ids = RECIPE_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fromTable = Object.entries(WORK_ORDER_CLASSES)
      .filter(([, d]) => d.recipe !== null)
      .map(([c, d]) => [d.recipe, c]);
    expect(RECIPE_REGISTRY.map((r) => [r.id, r.class]).sort()).toEqual(fromTable.sort());
    // `implemented` and `execute` are one fact stated twice (4.4.5): the
    // plan surface reads the flag, the phase runner calls the function.
    for (const r of RECIPE_REGISTRY) {
      expect(r.implemented).toBe(r.execute !== undefined);
      expect(r.implemented).toBe(true);
    }
    // a class with no producer carries a reason (the DEFERRED_KINDS discipline)
    for (const d of Object.values(WORK_ORDER_CLASSES) as WorkOrderClassDeclaration[]) {
      if (d.producers.includes('pending')) expect(d.pendingReason).toBeTruthy();
      else expect(d.producers.length).toBeGreaterThan(0);
    }
  });
});

describe('order-intrinsic feasibility lives in matches (an executor-certain refusal tiers agent)', () => {
  const draftBase = {
    findings: [],
    envelope: { paths: ['package.json', 'package-lock.json'], manifests: true },
    constraints: { install: NPM_CI, forbidden: [] },
    done: { absentIds: [], verifier: 'floor' as const, command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    provenance: { source: 'guardrail-blocking' as const },
  };
  const floorFinding = (pack: string, specifier?: string) => ({
    kind: 'floor-check',
    id: 'f',
    attribution: 'pre-existing' as const,
    evidence: {
      type: 'floor' as const,
      pack,
      label: 'x',
      command: '',
      ...(specifier !== undefined ? { specifier } : {}),
    },
  });
  const lintFinding = (check: string) => ({
    kind: 'custom-check',
    id: 'l',
    attribution: 'pre-existing' as const,
    evidence: { type: 'custom-check' as const, check, file: 'src/a.ts', rule: 'eqeqeq' },
  });
  const advisoryFinding = (fixedVersion: string) => ({
    kind: 'dep-vuln',
    id: 'a',
    attribution: 'deferred' as const,
    evidence: { type: 'dep-vuln' as const, package: 'p', advisoryId: 'GHSA-1', fixedVersion },
  });
  const tierOf = (partial: Partial<WorkOrder> & Pick<WorkOrder, 'id' | 'class'>) =>
    assignTier({ ...draftBase, ...partial }).tier;

  it('lockfile-sync: a pack without a lockfileCheck, or an ambiguous root, tiers agent', () => {
    const ok = { id: 'stale-lockfile:typescript', class: 'stale-lockfile' as const };
    expect(tierOf({ ...ok, findings: [floorFinding('typescript')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [floorFinding('go')] })).toBe('agent');
    expect(
      tierOf({
        ...ok,
        findings: [floorFinding('typescript')],
        envelope: { paths: ['package.json', 'sub/package.json'], manifests: true },
      }),
    ).toBe('agent');
  });

  it('override-pin: a range-shaped fixed version or a two-root envelope tiers agent', () => {
    const ok = { id: 'dep-advisory:p', class: 'dep-advisory' as const };
    expect(tierOf({ ...ok, findings: [advisoryFinding('4.1.1')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [advisoryFinding('>=4.1.1')] })).toBe('agent');
    expect(
      tierOf({
        ...ok,
        findings: [advisoryFinding('4.1.1')],
        envelope: { paths: ['package.json', 'sub/package.json'], manifests: true },
      }),
    ).toBe('agent');
  });

  it('declare-dependency: an unsupported pack or a flag-shaped specifier tiers agent', () => {
    const ok = { id: 'unresolved-import:typescript:.', class: 'unresolved-import' as const };
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', 'left-pad')] })).toBe('recipe');
    // A pack whose declaration is a (planned) exemption tiers agent AND the
    // order carries the declared reason for the plan surface (4.4.7 V1).
    const go = assignTier({
      ...draftBase,
      ...ok,
      findings: [floorFinding('go', 'github.com/x/y')],
    });
    expect(go.tier).toBe('agent');
    expect(go.capabilityExemption?.pack).toBe('go');
    expect(go.capabilityExemption?.capability).toBe('declareDependency');
    expect(go.capabilityExemption?.reason).toContain('go');
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', '--registry=https://x')] })).toBe(
      'agent',
    );
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', './src/missing')] })).toBe(
      'agent',
    );
  });

  it('the wave-1 packs tier recipe through their declarations (python/ruby/php, 4.4.7 V2)', () => {
    // declare-dependency: python maps the import through the one alias
    // table; an ambiguous alias (cv2 serves three distributions) fails the
    // rail and tiers agent. Ruby rides the gem-name rail; a nested require
    // path names a file inside a gem, not a gem.
    const pyDeclare = {
      id: 'unresolved-import:python:.',
      class: 'unresolved-import' as const,
      envelope: { paths: ['pyproject.toml', 'uv.lock'], manifests: true },
    };
    expect(tierOf({ ...pyDeclare, findings: [floorFinding('python', 'requests')] })).toBe('recipe');
    expect(tierOf({ ...pyDeclare, findings: [floorFinding('python', 'yaml')] })).toBe('recipe');
    expect(tierOf({ ...pyDeclare, findings: [floorFinding('python', 'cv2')] })).toBe('agent');
    const rbDeclare = {
      id: 'unresolved-import:ruby:.',
      class: 'unresolved-import' as const,
      envelope: { paths: ['Gemfile', 'Gemfile.lock'], manifests: true },
    };
    expect(tierOf({ ...rbDeclare, findings: [floorFinding('ruby', 'nokogiri')] })).toBe('recipe');
    expect(
      tierOf({ ...rbDeclare, findings: [floorFinding('ruby', 'active_support/core_ext')] }),
    ).toBe('agent');
    // php: a namespace does not identify a Packagist package, a declared
    // exemption, disclosed on the order.
    const php = assignTier({
      ...draftBase,
      id: 'unresolved-import:php:.',
      class: 'unresolved-import' as const,
      envelope: { paths: ['composer.json', 'composer.lock'], manifests: true },
      findings: [floorFinding('php', 'Monolog')],
    });
    expect(php.tier).toBe('agent');
    expect(php.capabilityExemption?.capability).toBe('declareDependency');
    expect(php.capabilityExemption?.reason).toContain('Packagist');

    // override-pin: the three packs resolve through their declared
    // manifests; the concrete-semver rail still applies.
    const pin = (pack: string, paths: string[], fixedVersion: string) =>
      tierOf({
        id: 'dep-advisory:p',
        class: 'dep-advisory' as const,
        envelope: { paths, manifests: true },
        findings: [
          {
            kind: 'dep-vuln',
            id: 'a',
            attribution: 'deferred' as const,
            evidence: {
              type: 'dep-vuln' as const,
              package: 'p',
              advisoryId: 'GHSA-1',
              fixedVersion,
              pack,
            },
          },
        ],
      });
    expect(pin('python', ['pyproject.toml', 'uv.lock'], '2.5.0')).toBe('recipe');
    expect(pin('ruby', ['Gemfile', 'Gemfile.lock'], '1.16.5')).toBe('recipe');
    expect(pin('php', ['composer.json', 'composer.lock'], '2.4.5')).toBe('recipe');
    expect(pin('python', ['pyproject.toml'], '>=2.5')).toBe('agent');
    // The version grammar is pack-declared (Rule 6): RubyGems 4-segment
    // security releases (the rails-family shape) and PyPI 2-segment
    // releases tier recipe under their packs' schemes, while an
    // unorderable PEP 440 marker and npm's x.y.z default both refuse.
    expect(pin('ruby', ['Gemfile', 'Gemfile.lock'], '7.0.8.7')).toBe('recipe');
    expect(pin('python', ['pyproject.toml', 'uv.lock'], '2.31')).toBe('recipe');
    expect(pin('python', ['pyproject.toml', 'uv.lock'], '2.31.post1')).toBe('agent');
    expect(pin('typescript', ['package.json', 'package-lock.json'], '1.2.3.4')).toBe('agent');

    // lockfile-sync: python + php declare the capability AND a verifiable
    // sync check, so a one-root envelope tiers recipe. Ruby's sync check
    // is a DECLARED skip: the executor could never confirm a resync
    // (certain discard), so the order tiers agent with the pack's own
    // skip reason disclosed; same doctrine for a yarn-lockfile envelope
    // under the typescript pack.
    const staleOrder = (pack: string, paths: string[]) => ({
      ...draftBase,
      id: `stale-lockfile:${pack}`,
      class: 'stale-lockfile' as const,
      envelope: { paths, manifests: true },
      findings: [floorFinding(pack)],
    });
    const stale = (pack: string, paths: string[]) => assignTier(staleOrder(pack, paths)).tier;
    expect(stale('python', ['pyproject.toml', 'poetry.lock'])).toBe('recipe');
    expect(stale('php', ['composer.json', 'composer.lock'])).toBe('recipe');
    const ruby = assignTier(staleOrder('ruby', ['Gemfile', 'Gemfile.lock']));
    expect(ruby.tier).toBe('agent');
    expect(ruby.capabilityExemption?.capability).toBe('resyncLockfile');
    expect(ruby.capabilityExemption?.reason).toContain('could never be verified');
    expect(ruby.capabilityExemption?.reason).toContain('bundler');
    expect(stale('typescript', ['package.json', 'yarn.lock'])).toBe('agent');
    expect(stale('typescript', ['package.json', 'package-lock.json'])).toBe('recipe');

    // lint-autofix: ruff and rubocop declare fix modes; phpcs cannot
    // fix-and-verify in one run, a declared exemption.
    const lint = (check: string) =>
      tierOf({
        id: 'lint-located:src/a',
        class: 'lint-located' as const,
        envelope: { paths: ['src/a'], manifests: false },
        findings: [lintFinding(check)],
      });
    expect(lint('lint:python')).toBe('recipe');
    expect(lint('lint:ruby')).toBe('recipe');
    expect(lint('lint:php')).toBe('agent');
  });

  it('lint-autofix: a user check or a fixCommand-less pack tiers agent; a SLICED order stays recipe (grouped fix)', () => {
    const ok = {
      id: 'lint-located:src/a.ts',
      class: 'lint-located' as const,
      envelope: { paths: ['src/a.ts'], manifests: false },
      provenance: { source: 'debt-slice' as const, file: 'src/a.ts', slice: 1, of: 1 },
    };
    expect(tierOf({ ...ok, findings: [lintFinding('lint:typescript')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [lintFinding('arch-rules')] })).toBe('agent');
    expect(tierOf({ ...ok, findings: [lintFinding('lint:go')] })).toBe('agent');
    // The estate fix: 700 sliced orders on big files must not all go to the
    // agent at full budgets when one file-level --fix answers them.
    expect(
      tierOf({
        ...ok,
        findings: [lintFinding('lint:typescript')],
        provenance: { source: 'debt-slice', file: 'src/a.ts', slice: 1, of: 3 },
      }),
    ).toBe('recipe');
  });
});
