import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, DetectedStack } from './types';
import { LANGUAGES } from './languages';

/**
 * Package version — the single source of truth is `package.json` at the
 * package root. Compiled output lives in `dist/`, so `__dirname` points
 * to the installed `node_modules/@vyuhlabs/dxkit/dist/` and `../package.json`
 * resolves to the shipped manifest. Falling back to `'0.0.0'` on unreadable
 * package.json keeps the CLI from crashing if someone runs dxkit from a
 * broken install; the fallback is unambiguous in bug reports.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readPackageVersion();

type LangVersionKey = keyof DetectedStack['versions'];

/**
 * Each language pack declares its own `defaultVersion` and `versionKey`;
 * this object derives the language portion from the registry. Adding
 * a 6th pack auto-extends `DEFAULT_VERSIONS` — no edit here required.
 * `postgres`/`redis` are infrastructure defaults (not pack-owned) and
 * stay hardcoded.
 */
const langVersionDefaults = Object.fromEntries(
  LANGUAGES.filter((l) => l.defaultVersion !== undefined).map(
    (l) => [l.versionKey ?? l.id, l.defaultVersion as string] as const,
  ),
) as Record<LangVersionKey, string>;

export const DEFAULT_VERSIONS = {
  ...langVersionDefaults,
  postgres: '16',
  redis: '7',
};

export const DEFAULT_COVERAGE = '80';

export function buildVariables(config: ResolvedConfig): Record<string, string> {
  const v: Record<string, string> = {
    PROJECT_NAME: config.projectName,
    PROJECT_NAME_SNAKE: config.projectName.replace(/-/g, '_'),
    PROJECT_NAME_KEBAB: config.projectName.replace(/_/g, '-'),
    PROJECT_DESCRIPTION: config.projectDescription || 'A project',
    GITHUB_ORG: 'myorg',
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

  // Per-pack `<KEY>_VERSION` template variables (Phase 10i.0-LP.6).
  // Adding a new pack with a `defaultVersion` auto-extends this loop.
  for (const lang of LANGUAGES) {
    if (lang.defaultVersion === undefined) continue;
    const key = lang.versionKey ?? (lang.id as LangVersionKey);
    const upper = key.toUpperCase();
    v[`${upper}_VERSION`] = config.versions[key] ?? lang.defaultVersion;
  }

  // Derived variables — bespoke per-language transformations of the
  // version string. Kept hardcoded; each is too idiosyncratic to
  // generalize cleanly. (PYTHON_VERSION_NODOT strips dots; GO_VERSION_SHORT
  // takes major.minor; RUST_MSRV maps `stable|nightly|beta` to a numeric
  // floor; CSHARP_TFM prepends `net` for .NET target framework moniker.)
  // If a future pack needs derivations, add a `versionDerivations?` capability.
  v.PYTHON_VERSION_NODOT = v.PYTHON_VERSION.replace('.', '');
  const goParts = v.GO_VERSION.split('.');
  v.GO_VERSION_SHORT = goParts.length >= 2 ? goParts.slice(0, 2).join('.') : v.GO_VERSION;
  v.RUST_MSRV = ['stable', 'nightly', 'beta'].includes(v.RUST_VERSION) ? '1.75' : v.RUST_VERSION;
  v.CSHARP_TFM = 'net' + v.CSHARP_VERSION;

  return v;
}

export function buildConditions(config: ResolvedConfig): Record<string, boolean> {
  // Per-pack `IF_<KEY>` conditions — iterated from the language
  // registry so adding a 6th pack auto-extends the condition
  // vocabulary. After 10f.4, `config.languages` is keyed on
  // `LanguageId`, so the lookup is `flags[lang.id]` directly.
  const langConditions: Record<string, boolean> = {};
  for (const lang of LANGUAGES) {
    langConditions[`IF_${lang.id.toUpperCase()}`] = config.languages[lang.id] ?? false;
  }

  return {
    ...langConditions,
    // Legacy template aliases (10f.4): templates use IF_NODE / IF_NEXTJS,
    // not IF_TYPESCRIPT. typescript pack activates for both Node and
    // Next.js projects (typescript.detect matches any package.json);
    // IF_NEXTJS is now sourced from the framework signal (nextjs
    // moved out of `languages` in 10f.4).
    IF_NODE: config.languages.typescript ?? false,
    IF_NEXTJS: config.framework === 'nextjs',
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
