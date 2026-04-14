/**
 * Health remediation actions — one RemediationAction set per dimension,
 * ranked against that dimension's pure scorer from scoring.ts.
 *
 * Because each scorer is pure over HealthMetrics, actions declare a patch
 * over HealthMetrics and rank() computes the score delta for the specific
 * dimension the action targets.
 */
import { Evidence } from '../evidence';
import { RankedAction, RemediationAction, rank } from '../remediation';
import { HealthMetrics } from '../types';
import {
  scoreTest,
  scoreQuality,
  scoreDocumentation,
  scoreSecurity,
  scoreMaintainability,
  scoreDeveloperExperience,
} from '../scoring';

type HealthAction = RemediationAction<HealthMetrics>;

// ─── Testing dimension ──────────────────────────────────────────────────────

function testingActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (m.commentedCodeRatio !== null && m.commentedCodeRatio > 0.5) {
    actions.push({
      id: 'health.testing.restore-commented-tests',
      title: 'Restore commented-out test files',
      rationale:
        'High commented-code ratio across test files indicates atrophied tests. See test-gaps-detailed.md.',
      evidence: [],
      patch: (cur) => ({ ...cur, commentedCodeRatio: 0.1 }),
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
      patch: (cur) => ({ ...cur, testFiles: target }),
    });
  }
  if (!m.coverageConfigExists) {
    actions.push({
      id: 'health.testing.add-coverage-config',
      title: 'Add test coverage tooling',
      rationale:
        'No coverage config (nyc/c8/jest.coverage/coverage.py). Configure + set threshold.',
      evidence: [],
      patch: (cur) => ({ ...cur, coverageConfigExists: true }),
    });
  }
  return actions;
}

// ─── Quality dimension ──────────────────────────────────────────────────────

function qualityActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (m.consoleLogCount > 20) {
    actions.push({
      id: 'health.quality.remove-console',
      title: `Remove console statements (${m.consoleLogCount})`,
      rationale: 'See quality-review-detailed.md for top offender files.',
      evidence: m.largestFilePath
        ? [{ file: m.largestFilePath, rule: 'console-log', tool: 'grep' }]
        : [],
      patch: (cur) => ({ ...cur, consoleLogCount: 10 }),
    });
  }
  if (m.anyTypeCount > 100 && m.lintTool?.includes('eslint')) {
    actions.push({
      id: 'health.quality.remove-any-types',
      title: `Replace ${m.anyTypeCount} \`: any\` type annotations`,
      rationale: 'Loose any-types defeat TypeScript. Most can be inferred or narrowed.',
      evidence: [],
      patch: (cur) => ({ ...cur, anyTypeCount: 50 }),
    });
  }
  if (m.lintErrors > 10) {
    actions.push({
      id: 'health.quality.fix-lint-errors',
      title: `Fix ${m.lintErrors} lint errors`,
      rationale: `Run \`${m.lintTool || 'lint'} --fix\` for auto-fixable ones.`,
      evidence: [],
      patch: (cur) => ({ ...cur, lintErrors: 0 }),
    });
  }
  if (m.maxFunctionsInFile !== null && m.maxFunctionsInFile > 50) {
    const ev: Evidence[] = m.maxFunctionsFilePath
      ? [
          {
            file: m.maxFunctionsFilePath,
            rule: 'god-file',
            tool: 'graphify',
            message: `${m.maxFunctionsInFile} functions`,
          },
        ]
      : [];
    actions.push({
      id: 'health.quality.split-god-file',
      title: `Split densest file (${m.maxFunctionsInFile} functions)`,
      rationale: 'Files with 50+ functions are hard to test and review.',
      evidence: ev,
      patch: (cur) => ({ ...cur, maxFunctionsInFile: 40 }),
    });
  }
  return actions;
}

// ─── Documentation dimension ────────────────────────────────────────────────

function docsActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (!m.readmeExists || m.readmeLines < 50) {
    actions.push({
      id: 'health.docs.expand-readme',
      title: m.readmeExists
        ? `Expand README (currently ${m.readmeLines} lines)`
        : 'Create a README.md',
      rationale: 'README is the first impression. Target 50+ lines covering setup, run, test.',
      evidence: [],
      patch: (cur) => ({ ...cur, readmeExists: true, readmeLines: 120 }),
    });
  }
  if (!m.contributingExists) {
    actions.push({
      id: 'health.docs.add-contributing',
      title: 'Add CONTRIBUTING.md',
      rationale: 'Codifies contribution expectations, PR template, commit conventions.',
      evidence: [],
      patch: (cur) => ({ ...cur, contributingExists: true }),
    });
  }
  if (!m.architectureDocsExist) {
    actions.push({
      id: 'health.docs.add-architecture',
      title: 'Add architecture/ADR documentation',
      rationale: 'System design context prevents tribal-knowledge debt.',
      evidence: [],
      patch: (cur) => ({ ...cur, architectureDocsExist: true }),
    });
  }
  if (!m.apiDocsExist && (m.controllers > 0 || m.sourceFiles > 100)) {
    actions.push({
      id: 'health.docs.add-api-docs',
      title: 'Add API documentation',
      rationale: 'With controllers/routes present, API surface should be documented.',
      evidence: [],
      patch: (cur) => ({ ...cur, apiDocsExist: true }),
    });
  }
  return actions;
}

// ─── Security dimension ─────────────────────────────────────────────────────

function securityActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (m.secretFindings > 0) {
    actions.push({
      id: 'health.security.remove-secrets',
      title: `Rotate & remove ${m.secretFindings} hardcoded secret${m.secretFindings === 1 ? '' : 's'}`,
      rationale:
        'Git history retains secrets — rotate credentials AND purge via git-filter-repo. See vulnerability-scan-detailed.md.',
      evidence: [],
      patch: (cur) => ({ ...cur, secretFindings: 0 }),
    });
  }
  if (m.privateKeyFiles > 0) {
    actions.push({
      id: 'health.security.remove-private-keys',
      title: `Remove ${m.privateKeyFiles} private key file${m.privateKeyFiles === 1 ? '' : 's'} from git`,
      rationale: 'Private keys in git are compromised. Rotate + remove + add to .gitignore.',
      evidence: [],
      patch: (cur) => ({ ...cur, privateKeyFiles: 0 }),
    });
  }
  if (m.depVulnCritical > 0 || m.depVulnHigh > 0) {
    actions.push({
      id: 'health.security.update-deps',
      title: `Update vulnerable dependencies (${m.depVulnCritical}C ${m.depVulnHigh}H)`,
      rationale: `Run \`${m.depAuditTool || 'audit tool'} fix\` or bump affected packages.`,
      evidence: [],
      patch: (cur) => ({
        ...cur,
        depVulnCritical: 0,
        depVulnHigh: 0,
        depVulnMedium: 0,
        depVulnLow: 0,
      }),
    });
  }
  if (m.evalCount > 0) {
    actions.push({
      id: 'health.security.remove-eval',
      title: `Remove ${m.evalCount} eval() call${m.evalCount === 1 ? '' : 's'}`,
      rationale: 'eval() enables arbitrary code execution. Replace with explicit parsing.',
      evidence: [],
      patch: (cur) => ({ ...cur, evalCount: 0 }),
    });
  }
  return actions;
}

// ─── Maintainability dimension ──────────────────────────────────────────────

function maintainabilityActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (m.largestFileLines > 2000) {
    actions.push({
      id: 'health.maint.split-largest-file',
      title: `Split ${m.largestFilePath} (${m.largestFileLines} lines)`,
      rationale: 'Files over 2000 lines are too large for effective code review.',
      evidence: m.largestFilePath
        ? [{ file: m.largestFilePath, rule: 'large-file', tool: 'wc' }]
        : [],
      patch: (cur) => ({ ...cur, largestFileLines: 500 }),
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
        patch: (cur) => ({ ...cur, nodeEngineVersion: '>=20' }),
      });
    }
  }
  if (m.filesOver500Lines > 15) {
    actions.push({
      id: 'health.maint.reduce-large-files',
      title: `Reduce ${m.filesOver500Lines} files > 500 lines`,
      rationale: 'Large files are hard to navigate and review.',
      evidence: [],
      patch: (cur) => ({ ...cur, filesOver500Lines: 5 }),
    });
  }
  return actions;
}

// ─── Developer Experience dimension ─────────────────────────────────────────

function dxActions(m: HealthMetrics): HealthAction[] {
  const actions: HealthAction[] = [];
  if (m.ciConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-ci',
      title: 'Add CI configuration',
      rationale:
        'No CI on this branch — lint/test/typecheck should block merges. Add .github/workflows or equivalent.',
      evidence: [],
      patch: (cur) => ({ ...cur, ciConfigCount: 1 }),
    });
  }
  if (m.dockerConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-dockerfile',
      title: 'Add Dockerfile / containerization',
      rationale: 'Containerized setup eliminates "works on my machine" onboarding friction.',
      evidence: [],
      patch: (cur) => ({ ...cur, dockerConfigCount: 1 }),
    });
  }
  if (m.precommitConfigCount === 0) {
    actions.push({
      id: 'health.dx.add-precommit',
      title: 'Add pre-commit hooks (husky / pre-commit)',
      rationale: 'Catch lint/format issues before code leaves the developer machine.',
      evidence: [],
      patch: (cur) => ({ ...cur, precommitConfigCount: 1 }),
    });
  }
  if (!m.envExampleExists) {
    actions.push({
      id: 'health.dx.add-env-example',
      title: 'Add .env.example',
      rationale: 'Documents required environment variables without leaking secrets.',
      evidence: [],
      patch: (cur) => ({ ...cur, envExampleExists: true }),
    });
  }
  return actions;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface DimensionPlan {
  dimension: string;
  baseline: number;
  ideal: number;
  actions: RankedAction<HealthMetrics>[];
}

export function buildHealthPlans(metrics: HealthMetrics): DimensionPlan[] {
  const dims: Array<{
    name: string;
    scorer: (m: HealthMetrics) => { score: number };
    build: (m: HealthMetrics) => HealthAction[];
  }> = [
    { name: 'Testing', scorer: scoreTest, build: testingActions },
    { name: 'Quality', scorer: scoreQuality, build: qualityActions },
    { name: 'Documentation', scorer: scoreDocumentation, build: docsActions },
    { name: 'Security', scorer: scoreSecurity, build: securityActions },
    { name: 'Maintainability', scorer: scoreMaintainability, build: maintainabilityActions },
    { name: 'Developer Experience', scorer: scoreDeveloperExperience, build: dxActions },
  ];
  return dims.map((d) => {
    const baseline = d.scorer(metrics).score;
    const actions = rank(d.build(metrics), metrics, d.scorer);
    // "Ideal" = apply every action's patch in sequence, then score.
    let ideal = metrics;
    for (const a of actions) ideal = a.patch(ideal);
    return {
      dimension: d.name,
      baseline,
      ideal: d.scorer(ideal).score,
      actions,
    };
  });
}
