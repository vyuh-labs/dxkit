import { ResolvedConfig } from './types';

export const VERSION = '1.1.0';

export const DEFAULT_VERSIONS = {
  python: '3.12',
  go: '1.24.0',
  node: '20',
  rust: 'stable',
  csharp: '8.0',
  postgres: '16',
  redis: '7',
};

export const DEFAULT_COVERAGE = '80';

/** Files that must NEVER be overwritten (user-accumulated knowledge). */
export const EVOLVING_FILES = [
  '.claude/skills/learned/references/gotchas.md',
  '.claude/skills/learned/references/conventions.md',
  '.claude/skills/learned/references/deny-recommendations.md',
  '.claude/skills/quality/references/gotchas.md',
  '.claude/skills/test/references/gotchas.md',
  '.claude/skills/deploy/references/gotchas.md',
  '.claude/skills/gcloud/references/gotchas.md',
  '.claude/skills/codebase/SKILL.md',
  '.claude/skills/codebase/references/architecture.md',
];

export function buildVariables(config: ResolvedConfig): Record<string, string> {
  const v: Record<string, string> = {
    PROJECT_NAME: config.projectName,
    PROJECT_NAME_SNAKE: config.projectName.replace(/-/g, '_'),
    PROJECT_NAME_KEBAB: config.projectName.replace(/_/g, '-'),
    PROJECT_DESCRIPTION: config.projectDescription || 'A project',
    GITHUB_ORG: 'myorg',
    PYTHON_VERSION: config.versions.python ?? DEFAULT_VERSIONS.python,
    GO_VERSION: config.versions.go ?? DEFAULT_VERSIONS.go,
    NODE_VERSION: config.versions.node ?? DEFAULT_VERSIONS.node,
    RUST_VERSION: config.versions.rust ?? DEFAULT_VERSIONS.rust,
    CSHARP_VERSION: config.versions.csharp ?? DEFAULT_VERSIONS.csharp,
    POSTGRES_VERSION: DEFAULT_VERSIONS.postgres,
    REDIS_VERSION: DEFAULT_VERSIONS.redis,
    DB_NAME: 'app_dev',
    DB_USER: 'app_user',
    DB_PASSWORD: 'dev_password',
    COVERAGE_THRESHOLD: config.coverageThreshold || DEFAULT_COVERAGE,
    TEST_COMMAND: config.testRunner?.command || 'npm test',
    TEST_FRAMEWORK: config.testRunner?.framework || 'unknown',
    TEST_COVERAGE_COMMAND: config.testRunner?.coverageCommand || '',
    FRAMEWORK: config.framework || '',
  };

  // Derived variables
  v.PYTHON_VERSION_NODOT = v.PYTHON_VERSION.replace('.', '');
  const goParts = v.GO_VERSION.split('.');
  v.GO_VERSION_SHORT = goParts.length >= 2 ? goParts.slice(0, 2).join('.') : v.GO_VERSION;
  v.RUST_MSRV = ['stable', 'nightly', 'beta'].includes(v.RUST_VERSION) ? '1.75' : v.RUST_VERSION;
  v.CSHARP_TFM = 'net' + v.CSHARP_VERSION;

  return v;
}

export function buildConditions(config: ResolvedConfig): Record<string, boolean> {
  return {
    IF_PYTHON: config.languages.python,
    IF_GO: config.languages.go,
    IF_NODE: config.languages.node || config.languages.nextjs,
    IF_RUST: config.languages.rust,
    IF_NEXTJS: config.languages.nextjs,
    IF_CSHARP: config.languages.csharp,
    IF_POSTGRES: config.infrastructure.postgres,
    IF_REDIS: config.infrastructure.redis,
    IF_HAS_SERVICES: config.infrastructure.postgres || config.infrastructure.redis,
    IF_DOCKER: config.infrastructure.docker,
    IF_GCLOUD: config.tools.gcloud,
    IF_PULUMI: config.tools.pulumi,
    IF_INFISICAL: config.tools.infisical,
    IF_GH_CLI: config.tools.ghCli,
    IF_CLAUDE_CODE: config.claudeCode,
    IF_QUALITY_CHECKS: config.qualityChecks,
    IF_COVERAGE_ENABLED: parseInt(config.coverageThreshold || DEFAULT_COVERAGE) > 0,
    IF_PRECOMMIT: config.precommit,
    IF_AI_SESSIONS: config.aiSessions,
    IF_AI_PROMPTS: config.aiPrompts,
  };
}
