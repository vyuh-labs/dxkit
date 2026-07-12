/**
 * Shared signal predicates for the doctor probes + config planners in
 * `./advisor`. Each `has*Signal` is the ONE implementation of "does this repo
 * exhibit the condition capability X keys off" (Rule 2 — one concept, one code
 * path), consumed by BOTH a `whenToRecommend` probe and a `planConfig` planner
 * so the two can never diverge. Split out of `advisor.ts` to keep that module a
 * cohesive set of probe/planner DECLARATIONS while their shared detection logic
 * lives here. Leaf module — imports analyzer/pack facts, nothing in
 * `./discovery` imports it back, so no registry↔probe cycle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CONTRACT_SOURCE_READERS } from '../analyzers/flow/contract-sources';
import { tryLoadGraph } from '../explore/load';
import { isClaudeLoopInstalled } from '../loop/scaffold';
import { LANGUAGES } from '../languages';

export function existsAt(...parts: string[]): boolean {
  try {
    return fs.existsSync(path.join(...parts));
  } catch {
    return false;
  }
}

export function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function dirHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * Does any pack-declared manifest signal match this repo? The ONE
 * signal-matching implementation (Rule 2), shared by the flow and schema
 * probes. `package.json` matches on dependency KEYS (a word-boundary text
 * search would also hit versions/scripts); plain-text manifests
 * (requirements.txt, pyproject.toml, go.mod…) match on word-boundary tokens
 * — precise enough for a fail-open recommendation probe.
 */
function manifestSignalHit(
  cwd: string,
  signals: ReadonlyArray<{ manifest: string; anyOf: string[] }>,
): boolean {
  for (const signal of signals) {
    if (signal.manifest === 'package.json') {
      const pkg = readJsonSafe(path.join(cwd, signal.manifest));
      if (!pkg) continue;
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
      };
      if (signal.anyOf.some((f) => f in deps)) return true;
    } else {
      let text: string;
      try {
        text = fs.readFileSync(path.join(cwd, signal.manifest), 'utf8');
      } catch {
        continue;
      }
      const hit = signal.anyOf.some((f) =>
        new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
      );
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Signal: this repo has an HTTP framework a flow-capable pack declares but no
 * flow setup yet — the case where flow's integration gate adds value. Shared
 * by BOTH the doctor probe (`recommendFlow`) and the deterministic planner
 * (`planFlowMode`) so the two never diverge (Rule 2 — one concept, one code
 * path). The framework tokens are PACK-DECLARED (`httpFlow.flowSignals`,
 * Rule 6) — pre-M6 this probe hardcoded a JS UI-framework list against
 * package.json, so a pure FastAPI/Django repo was never recommended the
 * capability its pack had just gained.
 */
export function hasFlowSignal(cwd: string): boolean {
  // Already configured? workspace.json or a flow policy block means yes.
  if (existsAt(cwd, '.dxkit', 'workspace.json')) return false;
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json'));
  if (policy && 'flow' in policy) return false;
  return manifestSignalHit(
    cwd,
    LANGUAGES.flatMap((p) => p.httpFlow?.flowSignals ?? []),
  );
}

/**
 * One signal function for the schema-gate capability, shared by the doctor
 * probe (`recommendSchema`) and the planner (`planSchemaMode`) so the two
 * never diverge (Rule 2). Tokens are PACK-DECLARED
 * (`modelSchema.schemaSignals`, Rule 6). Silenced once a `schema` policy
 * block exists — configured repos are never re-recommended.
 */
export function hasSchemaSignal(cwd: string): boolean {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json'));
  if (policy && 'schema' in policy) return false;
  return manifestSignalHit(
    cwd,
    LANGUAGES.flatMap((p) => p.modelSchema?.schemaSignals ?? []),
  );
}

/** Minimum call-graph density (calls-edges per function) at which the structural-
 *  duplicate signal is reliable — the anti-slop proof's boundary: a dense
 *  backend / CLI / library graph, not a thin framework-mediated frontend where
 *  the detector honestly finds little. Below this the seam gate is not worth
 *  proposing (it would surface nothing), so the probe stays silent. */
const DUPLICATION_MIN_CALL_DENSITY = 0.8;

/**
 * One signal for the structural-duplicate (seam) gate, shared by the doctor
 * probe (`recommendDuplication`) and the planner (`planDuplicationMode`) so the
 * two never diverge (Rule 2). Fires only when (a) the repo has not configured
 * `duplication` yet, AND (b) an existing code graph shows a call density high
 * enough for the detector to work — evidence the gate would actually fire, not a
 * blind proposal. A repo with no graph yet, or a thin frontend graph, is left
 * alone (the seam gate needs a dense call graph to add value).
 */
export function hasDuplicationSignal(cwd: string): boolean {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json'));
  if (policy && 'duplication' in policy) return false;
  const graph = tryLoadGraph(cwd);
  if (!graph) return false;
  const fns = graph.nodes.filter((n) => n.kind === 'function' || n.kind === 'method').length;
  if (fns === 0) return false;
  const calls = graph.edges.filter((e) => e.relation === 'calls').length;
  return calls / fns >= DUPLICATION_MIN_CALL_DENSITY;
}

/**
 * Signal: this repo runs a linter but has NOT wired it into dxkit's gate. Shared
 * by the doctor probe (`recommendChecks`) and the deterministic planner
 * (`planLintGate`) so they never diverge (Rule 2). Conservative: fires only on
 * a concrete linter config / `lint` script, and goes silent the moment the
 * `checks` / `lint` policy opts in.
 */
export function hasLintSignal(cwd: string): boolean {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json')) ?? {};
  // `.dxkit/policy.json` is flat (resolvePolicy spreads it at the top level),
  // so `checks` / `lint` are top-level keys — mirror of the flow probe's
  // `'flow' in policy`.
  const checks = policy.checks;
  const lint = policy.lint as Record<string, unknown> | undefined;
  // Already opted in? (a declared check, or the lint gate enabled) → silent.
  if (Array.isArray(checks) && checks.length > 0) return false;
  if (lint?.enabled === true) return false;

  // A concrete linter signal: a standalone lint config, or a package.json
  // `lint` script. Kept conservative so this never nags a repo without one.
  const lintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'ruff.toml',
    '.ruff.toml',
    '.rubocop.yml',
    '.golangci.yml',
    '.golangci.yaml',
  ];
  if (lintConfigs.some((f) => existsAt(cwd, f))) return true;
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};
  return typeof scripts.lint === 'string';
}

/**
 * One signal for the declared-artifact capability, shared by the doctor probe
 * (`recommendExtensions`) and the planner (`planFlowSources`) so they never
 * diverge (Rule 2). Kinds and filename signals are REGISTRY-DERIVED (each
 * reader's `sniff`) — no format literal lives here, so a new reader extends
 * this probe automatically. Conservative: silent the moment ANY
 * `flow.sources` entry exists (a configured repo is never re-nagged), scans
 * the git-tracked list only (bounded), openapi excluded (`flow.specs` and
 * the flow planner own specs).
 */
export function undeclaredContractArtifacts(cwd: string): Array<{ kind: string; path: string }> {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json')) ?? {};
  const flow = policy.flow as Record<string, unknown> | undefined;
  const sources = flow?.sources;
  if (Array.isArray(sources) && sources.length > 0) return [];
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', timeout: 10_000 })
      .split('\n')
      .slice(0, 20_000);
  } catch {
    return [];
  }
  const readers = CONTRACT_SOURCE_READERS.filter((r) => r.kind !== 'openapi');
  const out: Array<{ kind: string; path: string }> = [];
  for (const f of files) {
    if (out.length >= 10) break;
    const reader = readers.find((r) => r.sniff(f));
    if (reader) out.push({ kind: reader.kind, path: f });
  }
  return out;
}

/**
 * Signal: the loop Stop-gate is installed but `loop.preset` is unpinned. Shared
 * by the planner (`planLoopPreset`) and the doctor probe (`recommendLoopPreset`)
 * so the two never diverge (Rule 2). Reuses the canonical Stop-hook detector
 * (`isClaudeLoopInstalled`, Rule 2).
 */
export function loopStopGateNeedsPreset(cwd: string): boolean {
  if (!isClaudeLoopInstalled(cwd)) return false;
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json')) ?? {};
  const loop = policy.loop as Record<string, unknown> | undefined;
  return !(loop && typeof loop.preset === 'string'); // true ⟹ unpinned
}
