/**
 * Health remediation actions — one set per dimension, ranked against that
 * dimension's pure scorer from `scoring.ts`.
 *
 * Each scorer is pure over `ScoreInput` (metrics + capabilities), so
 * actions declare a patch over `ScoreInput` and `rank()` computes the
 * score delta for the specific dimension the action targets. Capability-
 * owned fields (lint tier counts, dep-vuln counts, secret findings,
 * structural stats) live under `input.capabilities.<id>`; surviving
 * generic/grep-derived metrics (`consoleLogCount`, `filesOver500Lines`,
 * `ciConfigCount`, etc.) stay under `input.metrics`.
 *
 * Patches that target a capability clone the specific envelope they
 * mutate; `withCapability` preserves every other envelope by reference
 * (envelopes are frozen in spirit — downstream consumers treat them as
 * immutable). When a guard fires, the capability is guaranteed present,
 * so `withCapability` never has to gracefully no-op inside an action's
 * own patch.
 */
import { Evidence } from '../evidence';
import { RankedAction, RemediationAction, rank } from '../remediation';
import { CapabilityReport, HealthMetrics } from '../types';
import type {
  CodePatternsResult,
  CoverageResult,
  DepVulnResult,
  DuplicationResult,
  ImportsResult,
  LintResult,
  SecretsResult,
  StructuralResult,
  TestFrameworkResult,
} from '../../languages/capabilities/types';
import {
  ScoreInput,
  scoreTest,
  scoreQuality,
  scoreDocumentation,
  scoreSecurity,
  scoreMaintainability,
  scoreDeveloperExperience,
} from '../scoring';

type HealthAction = RemediationAction<ScoreInput>;

/** Shallow-clone the metrics slice with `patch` merged on top. */
function withMetrics(cur: ScoreInput, patch: Partial<HealthMetrics>): ScoreInput {
  return { ...cur, metrics: { ...cur.metrics, ...patch } };
}

/**
 * Per-capability envelope types — kept as a union so `withCapability` can
 * infer the patch shape from the capability id.
 */
type CapabilityEnvelopes = {
  depVulns: DepVulnResult;
  lint: LintResult;
  coverage: CoverageResult;
  imports: ImportsResult;
  testFramework: TestFrameworkResult;
  secrets: SecretsResult;
  codePatterns: CodePatternsResult;
  duplication: DuplicationResult;
  structural: StructuralResult;
};

/**
 * Shallow-clone one capability envelope with `patch` merged on top.
 * Returns `cur` unchanged when the envelope isn't present — the dispatcher
 * only populates capabilities that had real data, and an action whose
 * guard fired against a present envelope will never be asked to patch an
 * absent one.
 */
function withCapability<K extends keyof CapabilityReport & keyof CapabilityEnvelopes>(
  cur: ScoreInput,
  key: K,
  patch: Partial<CapabilityEnvelopes[K]>,
): ScoreInput {
  const existing = cur.capabilities[key] as CapabilityEnvelopes[K] | undefined;
  if (!existing) return cur;
  return {
    ...cur,
    capabilities: {
      ...cur.capabilities,
      [key]: { ...existing, ...patch },
    },
  };
}

/** Pull the legacy "error count" (critical + high) from the lint envelope. */
function lintErrorsFrom(c: CapabilityReport): number {
  return (c.lint?.counts.critical ?? 0) + (c.lint?.counts.high ?? 0);
}

// ─── Testing dimension ──────────────────────────────────────────────────────

function testingActions(input: ScoreInput): HealthAction[] {
  const { metrics: m, capabilities: c } = input;
  const actions: HealthAction[] = [];
  const commentedCodeRatio = c.structural?.commentedCodeRatio ?? null;

  if (commentedCodeRatio !== null && commentedCodeRatio > 0.5) {
    actions.push({
      id: 'health.testing.restore-commented-tests',
      title: 'Restore commented-out test files',
      rationale:
        'High commented-code ratio across test files indicates atrophied tests. See test-gaps-detailed.md.',
      evidence: [],
      patch: (cur) => withCapability(cur, 'structural', { commentedCodeRatio: 0.1 }),
    });
  }
  if (m.testFiles < m.sourceFiles * 0.1 && m.sourceFiles > 0) {
    const target = Math.ceil(m.sourceFiles * 0.2);
    actions.push({
      id: 'health.testing.raise-test-ratio',
      title: `Raise test-to-source ratio (${m.testFiles} tests for ${m.sourceFiles} source files)`,
      rationale:
        'Under 10% test-to-source ratio is critical. Start with top CRITICAL untested files — see test-gaps-detailed.md for the ranked list.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { testFiles: target }),
    });
  }
  if (!m.coverageConfigExists) {
    actions.push({
      id: 'health.testing.add-coverage-config',
      title: 'Add test coverage tooling',
      rationale:
        'No coverage config (nyc/c8/jest.coverage/coverage.py). Configure + set threshold.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { coverageConfigExists: true }),
    });
  }
  return actions;
}

// ─── Quality dimension ──────────────────────────────────────────────────────

function qualityActions(input: ScoreInput): HealthAction[] {
  const { metrics: m, capabilities: c } = input;
  const actions: HealthAction[] = [];
  const lintErrors = lintErrorsFrom(c);
  const lintTool = c.lint?.tool ?? null;
  const maxFunctionsInFile = c.structural?.maxFunctionsInFile ?? null;
  const maxFunctionsFilePath = c.structural?.maxFunctionsFilePath ?? null;

  if (m.consoleLogCount > 20) {
    actions.push({
      id: 'health.quality.remove-console',
      title: `Remove console statements (${m.consoleLogCount})`,
      rationale: 'See quality-review-detailed.md for top offender files.',
      evidence: m.largestFilePath
        ? [{ file: m.largestFilePath, rule: 'console-log', tool: 'grep' }]
        : [],
      patch: (cur) => withMetrics(cur, { consoleLogCount: 10 }),
    });
  }
  if (m.anyTypeCount > 100 && lintTool?.includes('eslint')) {
    actions.push({
      id: 'health.quality.remove-any-types',
      title: `Replace ${m.anyTypeCount} \`: any\` type annotations`,
      rationale: 'Loose any-types defeat TypeScript. Most can be inferred or narrowed.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { anyTypeCount: 50 }),
    });
  }
  if (lintErrors > 10) {
    actions.push({
      id: 'health.quality.fix-lint-errors',
      title: `Fix ${lintErrors} lint errors`,
      rationale: `Run \`${lintTool || 'lint'} --fix\` for auto-fixable ones.`,
      evidence: [],
      // Zero out the "error" tier counts (critical + high); warnings (medium
      // + low) stay as-is since this action only claims error-fixing.
      patch: (cur) =>
        withCapability(cur, 'lint', {
          counts: {
            critical: 0,
            high: 0,
            medium: cur.capabilities.lint?.counts.medium ?? 0,
            low: cur.capabilities.lint?.counts.low ?? 0,
          },
        }),
    });
  }
  if (maxFunctionsInFile !== null && maxFunctionsInFile > 50) {
    const ev: Evidence[] = maxFunctionsFilePath
      ? [
          {
            file: maxFunctionsFilePath,
            rule: 'god-file',
            tool: 'graphify',
            message: `${maxFunctionsInFile} functions`,
          },
        ]
      : [];
    actions.push({
      id: 'health.quality.split-god-file',
      title: `Split densest file (${maxFunctionsInFile} functions)`,
      rationale: 'Files with 50+ functions are hard to test and review.',
      evidence: ev,
      patch: (cur) => withCapability(cur, 'structural', { maxFunctionsInFile: 40 }),
    });
  }
  return actions;
}

// ─── Documentation dimension ────────────────────────────────────────────────

function docsActions(input: ScoreInput): HealthAction[] {
  const m = input.metrics;
  const actions: HealthAction[] = [];
  if (!m.readmeExists || m.readmeLines < 50) {
    actions.push({
      id: 'health.docs.expand-readme',
      title: m.readmeExists
        ? `Expand README (currently ${m.readmeLines} lines)`
        : 'Create a README.md',
      rationale: 'README is the first impression. Target 50+ lines covering setup, run, test.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { readmeExists: true, readmeLines: 120 }),
    });
  }
  if (!m.contributingExists) {
    actions.push({
      id: 'health.docs.add-contributing',
      title: 'Add CONTRIBUTING.md',
      rationale: 'Codifies contribution expectations, PR template, commit conventions.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { contributingExists: true }),
    });
  }
  if (!m.architectureDocsExist) {
    actions.push({
      id: 'health.docs.add-architecture',
      title: 'Add architecture/ADR documentation',
      rationale: 'System design context prevents tribal-knowledge debt.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { architectureDocsExist: true }),
    });
  }
  if (!m.apiDocsExist && (m.controllers > 0 || m.sourceFiles > 100)) {
    actions.push({
      id: 'health.docs.add-api-docs',
      title: 'Add API documentation',
      rationale: 'With controllers/routes present, API surface should be documented.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { apiDocsExist: true }),
    });
  }
  return actions;
}

// ─── Security dimension ─────────────────────────────────────────────────────

function securityActions(input: ScoreInput): HealthAction[] {
  const { metrics: m, capabilities: c } = input;
  const actions: HealthAction[] = [];
  const secretFindings = c.secrets?.findings.length ?? 0;
  const depVulnCritical = c.depVulns?.counts.critical ?? 0;
  const depVulnHigh = c.depVulns?.counts.high ?? 0;
  const depAuditTool = c.depVulns?.tool ?? null;

  if (secretFindings > 0) {
    actions.push({
      id: 'health.security.remove-secrets',
      title: `Rotate & remove ${secretFindings} hardcoded secret${secretFindings === 1 ? '' : 's'}`,
      rationale:
        'Git history retains secrets — rotate credentials AND purge via git-filter-repo. See vulnerability-scan-detailed.md.',
      evidence: [],
      patch: (cur) => withCapability(cur, 'secrets', { findings: [] }),
    });
  }
  if (m.privateKeyFiles > 0) {
    actions.push({
      id: 'health.security.remove-private-keys',
      title: `Remove ${m.privateKeyFiles} private key file${m.privateKeyFiles === 1 ? '' : 's'} from git`,
      rationale: 'Private keys in git are compromised. Rotate + remove + add to .gitignore.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { privateKeyFiles: 0 }),
    });
  }
  if (depVulnCritical > 0 || depVulnHigh > 0) {
    actions.push({
      id: 'health.security.update-deps',
      title: `Update vulnerable dependencies (${depVulnCritical}C ${depVulnHigh}H)`,
      rationale: `Run \`${depAuditTool || 'audit tool'} fix\` or bump affected packages.`,
      evidence: [],
      patch: (cur) =>
        withCapability(cur, 'depVulns', {
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
        }),
    });
  }
  if (m.evalCount > 0) {
    actions.push({
      id: 'health.security.remove-eval',
      title: `Remove ${m.evalCount} eval() call${m.evalCount === 1 ? '' : 's'}`,
      rationale: 'eval() enables arbitrary code execution. Replace with explicit parsing.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { evalCount: 0 }),
    });
  }
  return actions;
}

// ─── Maintainability dimension ──────────────────────────────────────────────

function maintainabilityActions(input: ScoreInput): HealthAction[] {
  const m = input.metrics;
  const actions: HealthAction[] = [];
  if (m.largestFileLines > 2000) {
    actions.push({
      id: 'health.maint.split-largest-file',
      title: `Split ${m.largestFilePath} (${m.largestFileLines} lines)`,
      rationale: 'Files over 2000 lines are too large for effective code review.',
      evidence: m.largestFilePath
        ? [{ file: m.largestFilePath, rule: 'large-file', tool: 'wc' }]
        : [],
      patch: (cur) => withMetrics(cur, { largestFileLines: 500 }),
    });
  }
  if (m.nodeEngineVersion) {
    const major = parseInt(m.nodeEngineVersion.match(/(\d+)/)?.[1] || '20');
    if (major < 18) {
      actions.push({
        id: 'health.maint.upgrade-node',
        title: `Upgrade Node engine (currently ${m.nodeEngineVersion})`,
        rationale: 'Node < 18 is out of LTS. Upgrade package.json engines.node.',
        evidence: [{ file: 'package.json', rule: 'outdated-node', tool: 'npm' }],
        patch: (cur) => withMetrics(cur, { nodeEngineVersion: '>=20' }),
      });
    }
  }
  if (m.filesOver500Lines > 15) {
    actions.push({
      id: 'health.maint.reduce-large-files',
      title: `Reduce ${m.filesOver500Lines} files > 500 lines`,
      rationale: 'Large files are hard to navigate and review.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { filesOver500Lines: 5 }),
    });
  }
  return actions;
}

// ─── Developer Experience dimension ─────────────────────────────────────────

function dxActions(input: ScoreInput): HealthAction[] {
  const m = input.metrics;
  const actions: HealthAction[] = [];
  if (m.ciConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-ci',
      title: 'Add CI configuration',
      rationale:
        'No CI on this branch — lint/test/typecheck should block merges. Add .github/workflows or equivalent.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { ciConfigCount: 1 }),
    });
  }
  if (m.dockerConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-dockerfile',
      title: 'Add Dockerfile / containerization',
      rationale: 'Containerized setup eliminates "works on my machine" onboarding friction.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { dockerConfigCount: 1 }),
    });
  }
  if (m.precommitConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-precommit',
      title: 'Add pre-commit hooks (husky / pre-commit)',
      rationale: 'Catch lint/format issues before code leaves the developer machine.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { precommitConfigCount: 1 }),
    });
  }
  if (!m.envExampleExists) {
    actions.push({
      id: 'health.dx.add-env-example',
      title: 'Add .env.example',
      rationale: 'Documents required environment variables without leaking secrets.',
      evidence: [],
      patch: (cur) => withMetrics(cur, { envExampleExists: true }),
    });
  }
  return actions;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface DimensionPlan {
  dimension: string;
  baseline: number;
  ideal: number;
  actions: RankedAction<ScoreInput>[];
}

export function buildHealthPlans(input: ScoreInput): DimensionPlan[] {
  const dims: Array<{
    name: string;
    scorer: (i: ScoreInput) => { score: number };
    build: (i: ScoreInput) => HealthAction[];
  }> = [
    { name: 'Testing', scorer: scoreTest, build: testingActions },
    { name: 'Quality', scorer: scoreQuality, build: qualityActions },
    { name: 'Documentation', scorer: scoreDocumentation, build: docsActions },
    { name: 'Security', scorer: scoreSecurity, build: securityActions },
    { name: 'Maintainability', scorer: scoreMaintainability, build: maintainabilityActions },
    { name: 'Developer Experience', scorer: scoreDeveloperExperience, build: dxActions },
  ];
  return dims.map((d) => {
    const baseline = d.scorer(input).score;
    const actions = rank(d.build(input), input, d.scorer);
    // "Ideal" = apply every action's patch in sequence, then score.
    let ideal = input;
    for (const a of actions) ideal = a.patch(ideal);
    return {
      dimension: d.name,
      baseline,
      ideal: d.scorer(ideal).score,
      actions,
    };
  });
}
