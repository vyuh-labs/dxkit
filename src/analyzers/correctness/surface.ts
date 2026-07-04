/**
 * The correctness-floor SURFACE resolver — decides, per surface, whether the
 * floor runs by default. This is the canonical resolver for the correctness
 * capability (mirror of `resolveBaselineMode` for baseline modes, Rule 11): one
 * function, one precedence order, so no two call sites drift on the default.
 *
 * Three surfaces run the floor, with different postures:
 *   - `loop-stop`  — an autonomous loop's Stop-gate. ALWAYS default-on: an agent
 *     must never declare "done" on code that does not compile or whose tests
 *     fail. (An explicit flag/policy can still turn it off, but the default is
 *     on regardless of what CI the repo has.)
 *   - `pre-push` / `ci` — ADAPTIVE. If the repo already runs its tests in its own
 *     CI, dxkit's floor is redundant there, so it defaults to OPT-IN. If no
 *     test-running CI is detected, the floor defaults ON so pushes/PRs are still
 *     checked. When we cannot tell (a CI exists but its test step is opaque), we
 *     FAIL TOWARD ON — a redundant floor run is cheap; a missed regression is not.
 *
 * Precedence (highest first), mirroring the loop-preset + baseline-mode
 * resolvers:
 *   1. explicit `flag` argument (a `--correctness` / `--no-correctness` CLI flag)
 *   2. `DXKIT_FLOOR_<SURFACE>` env var (benchmark / CI override)
 *   3. `.dxkit/policy.json` → `correctness.surfaces.<surface>`
 *   4. the surface's default (always-on for loop-stop; adaptive for pre-push/ci)
 */

import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_POLICY_FILENAME } from '../../baseline/policy';

export type CorrectnessSurface = 'loop-stop' | 'pre-push' | 'ci';

export type SurfaceDecisionSource =
  | 'always-on' // loop-stop default
  | 'flag' // explicit CLI flag
  | 'env' // DXKIT_FLOOR_<SURFACE>
  | 'policy' // .dxkit/policy.json correctness.surfaces.<surface>
  | 'adaptive-no-test-ci' // no test-running CI → dxkit provides the net
  | 'adaptive-test-ci-detected' // repo already tests in CI → opt-in (off)
  | 'adaptive-uncertain'; // CI exists but test step opaque → fail toward on

export interface SurfaceResolution {
  readonly surface: CorrectnessSurface;
  readonly enabled: boolean;
  readonly source: SurfaceDecisionSource;
  /** One-line human-readable rationale, for `doctor` / CLI output. */
  readonly reason: string;
}

export type TestCiStatus = 'has-test-ci' | 'no-test-ci' | 'uncertain';

export interface TestCiDetection {
  readonly status: TestCiStatus;
  /** When `has-test-ci`, the file + command that proved it (for the reason). */
  readonly evidence?: string;
}

// ─── Test-CI detection ──────────────────────────────────────────────────────

/** CI config files we can read as text and scan for a test invocation. Ordered
 *  by ubiquity; GitHub Actions workflows are handled separately (a directory). */
const FLAT_CI_FILES = [
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  'Jenkinsfile',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.travis.yml',
  'bitbucket-pipelines.yml',
];

/** Substrings that mark a real test invocation, unioned across ecosystems. Kept
 *  deliberately specific (a bare "test" would match too much) so a match is a
 *  confident "this CI runs tests" signal. */
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bnpm (run )?test\b/,
  /\byarn (run )?test\b/,
  /\bpnpm (run )?test\b/,
  /\bnpx (vitest|jest|mocha|ava|playwright)\b/,
  /\b(vitest|jest|mocha|ava)\b/,
  /\bpytest\b/,
  /\bpython -m (pytest|unittest)\b/,
  /\b(tox|nox)\b/,
  /\bgo test\b/,
  /\bcargo (test|nextest)\b/,
  /\bmvn (.*\s)?(test|verify)\b/,
  /\b(\.\/)?gradlew? (.*\s)?(test|check)\b/,
  /\bdotnet test\b/,
  /\b(bundle exec )?rspec\b/,
  /\brake (.*\s)?test\b/,
  /\bmake (.*\s)?test\b/,
  /\bjust (.*\s)?test\b/,
];

/** Is a workflow file one dxkit itself installed? Its own guardrail/floor CI is
 *  the surface being resolved, not a pre-existing test-CI, so it must not count
 *  as the repo "already testing in CI". */
function isDxkitAuthoredWorkflow(name: string): boolean {
  return name.startsWith('dxkit-');
}

function textRunsTests(text: string): boolean {
  return TEST_COMMAND_PATTERNS.some((re) => re.test(text));
}

function matchedTestCommand(text: string): string | undefined {
  for (const re of TEST_COMMAND_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Detect whether the repo runs its tests in its OWN CI. Reads GitHub Actions
 * workflows (excluding dxkit-authored ones) plus the common flat CI configs,
 * scanning for a test invocation:
 *   - a matching test command in any file → `has-test-ci`;
 *   - no CI config found at all → `no-test-ci` (dxkit's floor should default on);
 *   - CI config exists but no test command matched (opaque `make ci`, a called
 *     reusable workflow, etc.) → `uncertain` (fail toward on).
 * Best-effort and never throws — an unreadable file is skipped.
 */
export function detectTestCi(cwd: string): TestCiDetection {
  let sawAnyCi = false;

  // GitHub Actions workflows (a directory of yml/yaml files).
  const wfDir = path.join(cwd, '.github', 'workflows');
  let wfNames: string[] = [];
  try {
    wfNames = fs
      .readdirSync(wfDir)
      .filter((n) => (n.endsWith('.yml') || n.endsWith('.yaml')) && !isDxkitAuthoredWorkflow(n));
  } catch {
    /* no workflows dir */
  }
  for (const name of wfNames) {
    sawAnyCi = true;
    let text: string;
    try {
      text = fs.readFileSync(path.join(wfDir, name), 'utf8');
    } catch {
      continue;
    }
    if (textRunsTests(text)) {
      return {
        status: 'has-test-ci',
        evidence: `.github/workflows/${name}: ${matchedTestCommand(text)}`,
      };
    }
  }

  // Flat CI config files.
  for (const rel of FLAT_CI_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    sawAnyCi = true;
    if (textRunsTests(text)) {
      return { status: 'has-test-ci', evidence: `${rel}: ${matchedTestCommand(text)}` };
    }
  }

  return sawAnyCi ? { status: 'uncertain' } : { status: 'no-test-ci' };
}

// ─── Policy + env reads ─────────────────────────────────────────────────────

/** Read `correctness.surfaces.<surface>` from `.dxkit/policy.json`. Best-effort:
 *  a missing / malformed file or absent block yields an empty map. */
export function readSurfacePolicy(cwd: string): Partial<Record<CorrectnessSurface, boolean>> {
  try {
    const raw = fs.readFileSync(path.join(cwd, DEFAULT_POLICY_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as {
      correctness?: { surfaces?: Partial<Record<CorrectnessSurface, unknown>> };
    };
    const surfaces = parsed.correctness?.surfaces;
    if (!surfaces || typeof surfaces !== 'object') return {};
    const out: Partial<Record<CorrectnessSurface, boolean>> = {};
    for (const s of ['loop-stop', 'pre-push', 'ci'] as const) {
      if (typeof surfaces[s] === 'boolean') out[s] = surfaces[s];
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_VAR: Record<CorrectnessSurface, string> = {
  'loop-stop': 'DXKIT_FLOOR_LOOP',
  'pre-push': 'DXKIT_FLOOR_PREPUSH',
  ci: 'DXKIT_FLOOR_CI',
};

/** Parse a truthy/falsy env override, or undefined when unset/unrecognized. */
function envOverride(surface: CorrectnessSurface): boolean | undefined {
  const raw = process.env[ENV_VAR[surface]];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return undefined;
}

// ─── The resolver ───────────────────────────────────────────────────────────

export interface ResolveSurfaceOptions {
  readonly surface: CorrectnessSurface;
  readonly cwd: string;
  /** Explicit `--correctness` / `--no-correctness` CLI flag (highest precedence). */
  readonly flag?: boolean;
  /** Injected for tests; defaults to reading `.dxkit/policy.json`. */
  readonly policySurfaces?: Partial<Record<CorrectnessSurface, boolean>>;
  /** Injected for tests; defaults to the real `detectTestCi`. */
  readonly detect?: (cwd: string) => TestCiDetection;
}

/**
 * Resolve whether the correctness floor is enabled on a surface. Pure aside from
 * the default policy/env reads (both injectable); never throws.
 */
export function resolveCorrectnessSurface(opts: ResolveSurfaceOptions): SurfaceResolution {
  const { surface } = opts;

  // 1. explicit CLI flag
  if (opts.flag !== undefined) {
    return {
      surface,
      enabled: opts.flag,
      source: 'flag',
      reason: `explicitly ${opts.flag ? 'enabled' : 'disabled'} via flag`,
    };
  }

  // 2. env override
  const env = envOverride(surface);
  if (env !== undefined) {
    return {
      surface,
      enabled: env,
      source: 'env',
      reason: `${env ? 'enabled' : 'disabled'} via ${ENV_VAR[surface]}`,
    };
  }

  // 3. policy file
  const policy = opts.policySurfaces ?? readSurfacePolicy(opts.cwd);
  const pol = policy[surface];
  if (pol !== undefined) {
    return {
      surface,
      enabled: pol,
      source: 'policy',
      reason: `${pol ? 'enabled' : 'disabled'} via .dxkit/policy.json correctness.surfaces.${surface}`,
    };
  }

  // 4. surface default
  if (surface === 'loop-stop') {
    return {
      surface,
      enabled: true,
      source: 'always-on',
      reason: 'loop Stop-gate runs the floor by default — an agent must not stop on broken code',
    };
  }

  // pre-push / ci: adaptive on the repo's own test-CI
  const det = (opts.detect ?? detectTestCi)(opts.cwd);
  if (det.status === 'has-test-ci') {
    return {
      surface,
      enabled: false,
      source: 'adaptive-test-ci-detected',
      reason: `opt-in — the repo already runs tests in CI (${det.evidence}); enable explicitly to also run dxkit's floor here`,
    };
  }
  if (det.status === 'no-test-ci') {
    return {
      surface,
      enabled: true,
      source: 'adaptive-no-test-ci',
      reason:
        'no test-running CI detected — the floor runs by default so changes are still checked',
    };
  }
  return {
    surface,
    enabled: true,
    source: 'adaptive-uncertain',
    reason:
      'a CI exists but its test step is opaque — running the floor to be safe (fail toward on)',
  };
}
