import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, DetectedStack } from './types';
import { LANGUAGES } from './languages';
import { DXKIT_VERSION } from './dxkit-package';

/** Package version, read once from the shipped package.json by the leaf
 *  `dxkit-package` module (which the install-chain renderer also reads). */
export const VERSION = DXKIT_VERSION;

/**
 * The Node major dxkit itself requires: the `engines.node` floor of the
 * shipped package.json, read from the ONE place it is declared. `doctor`'s
 * runtime check reads this instead of carrying its own integer, so the floor
 * moves once (in package.json) and the check + its remedy follow.
 */
function readPackageNodeEngineFloor(): number {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const engine = (JSON.parse(raw) as { engines?: { node?: string } }).engines?.node ?? '';
    const m = engine.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* fall through to the declared floor */
  }
  return 22;
}

export const NODE_ENGINE_FLOOR = readPackageNodeEngineFloor();

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

/**
 * The per-pack `<KEY>_VERSION` template variables (`NODE_VERSION`,
 * `PYTHON_VERSION`, ...) for a repo's detected versions, the ONE substitution
 * source for every template that names a language runtime, whether rendered
 * by the generator or by the workflow writer (`node-version: '{{NODE_VERSION}}'`
 * in every generated `setup-node` step). Detected value first (the pack's
 * `detectVersion`, via `detect(cwd).versions`), else the pack's
 * `defaultVersion`, so a customer that declares Node 20 keeps running its
 * gate on 20 and a repo that declares nothing gets the pack default. Adding a pack with a `defaultVersion`
 * auto-extends the vocabulary. The agent file's section headings read
 * `<KEY>_STACK_LABEL` instead (what the repo states, never the default).
 */
export function packVersionVariables(
  versions: Partial<DetectedStack['versions']>,
): Record<string, string> {
  const v: Record<string, string> = {};
  for (const lang of LANGUAGES) {
    if (lang.defaultVersion === undefined) continue;
    const key = lang.versionKey ?? (lang.id as LangVersionKey);
    const upper = key.toUpperCase();
    v[`${upper}_VERSION`] = versions[key] ?? lang.defaultVersion;
  }
  return v;
}

export function buildVariables(config: ResolvedConfig): Record<string, string> {
  const v: Record<string, string> = {
    PROJECT_NAME: config.projectName,
    PROJECT_NAME_SNAKE: config.projectName.replace(/-/g, '_'),
    PROJECT_NAME_KEBAB: config.projectName.replace(/_/g, '-'),
    // Repo evidence or nothing (IF_PROJECT_DESCRIPTION gates the line): never a
    // placeholder printed as if it described the product.
    PROJECT_DESCRIPTION: config.projectDescription || '',
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
  Object.assign(v, packVersionVariables(config.versions));

  // Per-pack `<KEY>_STACK_LABEL`: what the repo targets, as `detect()` read it
  // through `packStackLabel` (Rule 6). A config without labels (pre-4.5.0
  // manifest, a test fixture) gets the bare displayName, never the default
  // version dressed up as a repo fact.
  for (const lang of LANGUAGES) {
    const key = (lang.versionKey ?? lang.id) as LangVersionKey;
    v[`${key.toUpperCase()}_STACK_LABEL`] = config.stackLabels?.[key] ?? lang.displayName;
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
    IF_PROJECT_DESCRIPTION: !!config.projectDescription,
  };
}
