/**
 * Opt-in `.env` loading for engine credentials — scoped strictly to a
 * declared key prefix (`SNYK_*`, `SONAR_*`).
 *
 * dxkit deliberately does NOT auto-load a whole `.env` into
 * `process.env` (pulling a developer's entire secrets file — GitHub
 * tokens, database URLs, unrelated API keys — into the process is a
 * footgun). But a local developer who keeps their engine token in
 * `.env` shouldn't have to re-`export` it before every
 * `ingest --from-snyk` / `--from-sonar`.
 *
 * The compromise: read the cwd's `.env` (or an explicit `--env-file`
 * path), parse it, and lift ONLY keys beginning with the requested
 * prefix into the environment — and only when they aren't already set,
 * so a real exported env / CI Actions secret always wins. CI, which
 * sets the token via the environment and has no `.env`, is a no-op.
 *
 * ONE loader, per-engine prefixes (Rule 2): `loadSnykEnv` and
 * `loadSonarEnv` are thin wrappers over the same core, so the parsing,
 * precedence, and committed-secrets advisory cannot drift between
 * engines.
 *
 * This module is pure data-in/data-out: it mutates `process.env` for
 * the lifted keys and returns a structured result (the keys it set +
 * any advisory warnings). The CLI renders the one-line notice + the
 * warnings; the module logs nothing itself, which keeps it testable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/** Prefix that gates which keys may be lifted from the file. Nothing
 *  outside the requested prefix is ever read into the environment. */
export const SNYK_ENV_PREFIX = 'SNYK_';
export const SONAR_ENV_PREFIX = 'SONAR_';

export interface EngineEnvLoadOptions {
  /** Skip `.env` loading entirely (`--no-env-file`). */
  readonly noEnvFile?: boolean;
  /** Explicit path override (`--env-file <path>`). Relative paths
   *  resolve against `cwd`. When set and the file is missing, that's
   *  a surfaced warning (the user asked for a specific file). */
  readonly envFile?: string;
}

/** Back-compat alias — the Snyk loader predates the generalization. */
export type SnykEnvLoadOptions = EngineEnvLoadOptions;

export interface EngineEnvLoadResult {
  /** Absolute path of the file that was read. */
  readonly path: string;
  /** Prefixed keys lifted into `process.env` (only those that weren't
   *  already set). Empty when the file had none or they were all
   *  already present in the environment. */
  readonly loadedKeys: ReadonlyArray<string>;
  /** Advisory messages for the caller to surface (e.g. the file looks
   *  committed to git). Never fatal. */
  readonly warnings: ReadonlyArray<string>;
}

/** Back-compat alias — see `EngineEnvLoadResult`. */
export type SnykEnvLoadResult = EngineEnvLoadResult;

/**
 * Parse a `.env`-style file body into key/value pairs, keeping ONLY
 * keys that start with `prefix`. Tolerant of the common shapes:
 * blank lines, `#` comments, an optional `export ` prefix, and
 * single/double-quoted values. No variable interpolation — values are
 * taken literally (after unquoting), which is correct for opaque
 * tokens and ids.
 */
export function parsePrefixedEnv(body: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!key.startsWith(prefix)) continue;
    out[key] = unquote(m[2]);
  }
  return out;
}

/** The original Snyk-scoped parser — a thin wrapper kept for
 *  callers/tests that predate the generalization. */
export function parseSnykEnv(body: string): Record<string, string> {
  return parsePrefixedEnv(body, SNYK_ENV_PREFIX);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Lift `<prefix>*` keys from the cwd's `.env` (or `--env-file`) into
 * `process.env`, unless `--no-env-file` is set or no file exists.
 * Real environment values are never overwritten. Returns `null` when
 * nothing was attempted (disabled, or no file present and none
 * explicitly requested); otherwise a result describing what happened.
 * `tokenName` names the secret in the committed-file advisory.
 */
export function loadPrefixedEnv(
  cwd: string,
  prefix: string,
  tokenName: string,
  opts: EngineEnvLoadOptions = {},
): EngineEnvLoadResult | null {
  if (opts.noEnvFile) return null;

  const explicit = opts.envFile !== undefined;
  const filePath = explicit ? path.resolve(cwd, opts.envFile as string) : path.join(cwd, '.env');

  if (!fs.existsSync(filePath)) {
    if (explicit) {
      return { path: filePath, loadedKeys: [], warnings: [`env-file not found: ${filePath}`] };
    }
    return null;
  }

  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      path: filePath,
      loadedKeys: [],
      warnings: [`could not read env-file ${filePath}: ${(err as Error).message}`],
    };
  }

  const parsed = parsePrefixedEnv(body, prefix);
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    // Real exported env / CI secret always wins. Treat an empty string
    // as "unset" so a blank export doesn't shadow a populated .env.
    const current = process.env[key];
    if (current === undefined || current === '') {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }

  const warnings: string[] = [];
  if (isTrackedByGit(cwd, filePath)) {
    warnings.push(
      `${path.basename(filePath)} appears to be committed to git — a secrets file ` +
        `should be gitignored. Move ${tokenName} out of version control.`,
    );
  }

  return { path: filePath, loadedKeys, warnings };
}

/** Lift `SNYK_*` keys — see `loadPrefixedEnv`. */
export function loadSnykEnv(
  cwd: string,
  opts: EngineEnvLoadOptions = {},
): EngineEnvLoadResult | null {
  return loadPrefixedEnv(cwd, SNYK_ENV_PREFIX, 'SNYK_TOKEN', opts);
}

/** Lift `SONAR_*` keys — see `loadPrefixedEnv`. */
export function loadSonarEnv(
  cwd: string,
  opts: EngineEnvLoadOptions = {},
): EngineEnvLoadResult | null {
  return loadPrefixedEnv(cwd, SONAR_ENV_PREFIX, 'SONAR_TOKEN', opts);
}

/** Whether `filePath` is tracked in the git index at `cwd`. Best-effort
 *  — any failure (not a repo, git missing) is treated as "not tracked"
 *  so the advisory simply doesn't fire. */
function isTrackedByGit(cwd: string, filePath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch ${JSON.stringify(filePath)}`, {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}
