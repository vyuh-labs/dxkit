/**
 * The execution-environment REQUIREMENT model — the third pack-declared
 * dimension alongside language and capability (CLAUDE.md Rule 20).
 *
 * dxkit's original model implicitly assumed "the machine driving the analysis
 * can also build and scan the repo". That is false for any stack that needs a
 * specific provisioned environment (a `net9.0-windows` WinForms build needs
 * Windows + the .NET SDK + a chosen solution; a Swift scheme needs macOS +
 * Xcode). When the assumption broke, capabilities either silently fail-open
 * skipped (an invisible coverage gap) or misread an environment problem as a
 * code finding. The fix is to make the requirement EXPLICIT: every capability
 * that executes repo-facing commands declares what it needs, and every
 * "can this run here?" question is answered by the ONE predicate in this
 * module — never by a scattered `process.platform` check or a bare
 * binary-missing skip.
 *
 * Two separated concerns, deliberately:
 *   - a REQUIREMENT is repo-intrinsic — a pure function of the repository's
 *     contents (its TFMs, its build system), never of the current machine.
 *     Declaring it must be deterministic and environment-independent, the same
 *     discipline recall inputs follow (Rule 19): a requirement that embeds a
 *     machine fact would read differently on every host and poison placement.
 *   - AVAILABILITY is host-intrinsic — what this machine is and has
 *     (`src/execution/environment.ts`).
 * `unmetRequirement` compares the two. The placement resolver (the 4.0
 * increment that routes capabilities to CI jobs) composes on the same
 * predicate; local runners use it today to disclose an environment boundary
 * instead of skipping silently.
 */

import { toolchainInstallHint, type ToolchainId, type ToolchainProblem } from './toolchains';

/** An operating-system host a capability can execute on. */
export type ExecutionHost = 'linux' | 'macos' | 'windows';

/** A host constraint: a concrete host, or `'any'` (no OS constraint). */
export type HostRequirement = ExecutionHost | 'any';

/**
 * What a capability needs from the environment that runs it.
 *
 * `toolchains` names AMBIENT toolchains (SDKs / runtimes the ecosystem owns:
 * the .NET SDK, a JDK, the Go distribution) — the things `vyuh-dxkit tools
 * install` deliberately does NOT manage. Registry TOOLS (gitleaks, ruff,
 * osv-scanner…) are NOT listed here: their detection and provisioning already
 * flow through `findTool` / the tool registry (Rule 1), and a missing tool is
 * the runners' existing fail-open path. The boundary line: if `tools install`
 * can provision it, it is a tool; if the repo's ecosystem provisions it, it is
 * a toolchain and belongs in this declaration.
 */
export interface ExecutionRequirement {
  /** Hosts that can run this capability. Non-empty; `['any']` means no OS
   *  constraint. Repo-derived where the truth is repo-dependent (a
   *  `net9.0-windows` TFM narrows the C# build to `['windows']`). */
  readonly hosts: readonly HostRequirement[];
  /** Ambient toolchains required (see the tool/toolchain boundary above).
   *  Every id must resolve in `TOOLCHAIN_DEFS` — contract-tested. */
  readonly toolchains: readonly ToolchainId[];
  /** The capability must COMPILE the project, so it needs the complete build
   *  environment (restored packages, generated sources, the works) — not just
   *  the toolchain binary on PATH. */
  readonly needsBuild: boolean;
  /**
   * How the build/run target is resolved:
   *   - `'none'`       — no target concept (a linter over files, a lockfile scan).
   *   - `'discovered'` — the toolchain/pack can find the target itself
   *                      (a root `.sln`, Cargo's workspace, Go's `./...`).
   *   - `'configured'` — ambiguous without user configuration (the 29-`.sln`
   *                      repo with no root solution).
   */
  readonly buildTarget: 'none' | 'discovered' | 'configured';
  /** Placement cost: `'cheap'` runs in seconds without touching the project's
   *  own build (a file scan, a lockfile audit); `'build'` runs the project's
   *  toolchain over the tree (compile, test suite, CodeQL DB). */
  readonly weight: 'cheap' | 'build';
}

/** A requirement builder: pure, deterministic, repo-intrinsic. Reads repo
 *  files only — NEVER the current machine (no PATH probes, no
 *  `process.platform`); availability is `environment.ts`'s side of the line. */
export type ExecutionRequirementFor = (cwd: string) => ExecutionRequirement;

/** The environment surface `unmetRequirement` reads. `currentEnvironment`
 *  (environment.ts) produces the real one; tests and the future placement
 *  resolver (which reasons about REMOTE environments: the ubuntu / windows /
 *  macos CI runners) construct their own. */
export interface ExecutionEnvironment {
  readonly host: ExecutionHost;
  hasToolchain(id: ToolchainId): boolean;
  /** Health diagnosis for a PRESENT toolchain — null when healthy. Optional:
   *  an environment that cannot answer (a hand-built test env, a remote CI
   *  runner the resolver reasons about) simply skips the health tier; the
   *  predicate then treats presence as the whole story. */
  toolchainProblem?(id: ToolchainId): ToolchainProblem | null;
}

/**
 * Why a requirement is not satisfied here. Structured so renderers can phrase
 * it and the placement resolver can route on it — never a prose-only reason.
 *
 * `unhealthy-toolchain` covers the present-but-unusable class (the
 * half-provisioned-SDK shape, F-14): minted from a failed registry health
 * probe, or post-failure by `classifyEnvironmentFailure` when a capability
 * command fails in an environment-shaped way.
 */
export type UnmetRequirement =
  | {
      readonly kind: 'wrong-host';
      readonly requiredHosts: readonly ExecutionHost[];
      readonly currentHost: ExecutionHost;
    }
  | { readonly kind: 'missing-toolchain'; readonly toolchains: readonly ToolchainId[] }
  | {
      readonly kind: 'unhealthy-toolchain';
      readonly toolchain: ToolchainId;
      readonly problem: string;
      readonly remedy?: string;
    };

/**
 * THE satisfaction predicate — every "can this capability run in this
 * environment?" decision routes through here (arch-check enforced). Returns
 * `null` when satisfied, else the first (most fundamental) unmet dimension:
 * the wrong OS makes toolchain presence irrelevant, so host is checked first.
 */
export function unmetRequirement(
  req: ExecutionRequirement,
  env: ExecutionEnvironment,
): UnmetRequirement | null {
  if (!req.hosts.includes('any') && !req.hosts.includes(env.host)) {
    return {
      kind: 'wrong-host',
      requiredHosts: req.hosts.filter((h): h is ExecutionHost => h !== 'any'),
      currentHost: env.host,
    };
  }
  const missing = req.toolchains.filter((t) => !env.hasToolchain(t));
  if (missing.length > 0) return { kind: 'missing-toolchain', toolchains: missing };
  // Health tier: a present toolchain may still be unable to serve (the F-14
  // shape). Only environments that can answer participate — the check is
  // memoized per environment, so the probe cost is once per run.
  if (env.toolchainProblem) {
    for (const t of req.toolchains) {
      const problem = env.toolchainProblem(t);
      if (problem !== null) {
        return {
          kind: 'unhealthy-toolchain',
          toolchain: t,
          problem: problem.problem,
          remedy: problem.remedy,
        };
      }
    }
  }
  return null;
}

/**
 * One human line for an unmet requirement — shared by every renderer so the
 * boundary is phrased once. Says WHERE the capability can run and the ROOT
 * remedy, not just that it can't run here: the point of the model is that
 * "not here" is a routing fact with a named fix, never a dead end or a
 * remediation loop. `host` (when the caller knows it) selects the per-host
 * install hint for a missing toolchain.
 */
export function describeUnmetRequirement(unmet: UnmetRequirement, host?: ExecutionHost): string {
  switch (unmet.kind) {
    case 'wrong-host':
      return (
        `needs ${unmet.requiredHosts.join(' or ')} (this environment is ${unmet.currentHost}) — ` +
        `runs where that host is available (e.g. a ${unmet.requiredHosts[0]} CI job)`
      );
    case 'missing-toolchain': {
      const base =
        `needs the ${unmet.toolchains.join(', ')} toolchain${unmet.toolchains.length > 1 ? 's' : ''} — ` +
        `not present in this environment`;
      if (!host) return base;
      const hints = unmet.toolchains.map((t) => toolchainInstallHint(t, host));
      return `${base} (install: ${hints.join('; ')})`;
    }
    case 'unhealthy-toolchain': {
      const base = `the ${unmet.toolchain} toolchain is present but not usable here: ${unmet.problem}`;
      return unmet.remedy ? `${base} (remedy: ${unmet.remedy})` : base;
    }
  }
}
