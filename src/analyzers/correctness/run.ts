/**
 * The correctness-floor runner — executes each active pack's syntax + affected-
 * test commands and folds them into one pass/fail signal.
 *
 * Policy, in one place so every surface behaves the same:
 *   - fail-CLOSED on a real failure — a non-zero exit from a check that ran is a
 *     genuine syntax error / failing test, and it BLOCKS.
 *   - fail-OPEN on infrastructure — a missing binary (the toolchain isn't
 *     installed here) skips the check rather than failing it. A hook must not
 *     block a developer who simply hasn't installed a linter locally; CI, where
 *     the toolchain is present, is the backstop.
 *
 * Commands come from `LanguageSupport.correctness` via the registry helper
 * (Rule 6); this module never hardcodes a per-language command. Command
 * execution is injected so tests exercise the policy without a real toolchain.
 */

import {
  activeCorrectnessProviders,
  changedFilesTouchDependencyManifest,
  dependencyManifestFilesIn,
} from '../../languages';
import type { LanguageId, LanguageSupport } from '../../languages/types';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
  CorrectnessScope,
} from '../../languages/capabilities/correctness';
import {
  classifyEnvironmentFailure,
  currentEnvironment,
  describeUnmetRequirement,
  hostOf,
  unmetRequirement,
  type ExecutionEnvironment,
  type UnmetRequirement,
} from '../../execution';
// The spawn + timeout + fail-open exec primitive is shared with the custom-check
// gate runner — one code path (Rule 2). Re-exported so existing callers (and
// tests) keep importing `CommandExec` / `makeCommandExec` from here.
import {
  makeCommandExec,
  defaultCommandExec,
  tail,
  type CommandExec,
  type CommandOutcome,
} from '../tools/bounded-exec';

export { makeCommandExec, defaultCommandExec, type CommandExec, type CommandOutcome };

export type CorrectnessStatus =
  | 'pass'
  | 'fail'
  | 'skipped-unavailable'
  | 'skipped-timeout'
  /** The command's output outran the capture buffer. Fail-OPEN, for the same
   *  reason a timeout is: the floor blocks, so it may only block on a failure it
   *  actually OBSERVED. A fragment cut at an arbitrary byte is not an observation.
   *  (This previously coded as `fail` and blocked — infrastructure failing closed,
   *  contrary to this module's own stated policy.) */
  | 'skipped-overflow'
  /** The pack's declared `ExecutionRequirement` (Rule 20) is unmet here —
   *  wrong host / missing ambient toolchain. Fail-OPEN like the other
   *  infrastructure skips, but DISCLOSED: `unmet` carries the structured
   *  reason so every surface can say WHERE the floor would run instead of
   *  silently reporting nothing (the dpl-studio class). Checked BEFORE exec,
   *  so a `dotnet build` of a Windows-only target never runs on Linux just to
   *  fail in a way that reads as broken code. */
  | 'skipped-environment'
  | 'skipped-none';

export interface CorrectnessCheckResult {
  readonly pack: LanguageId;
  readonly label: string;
  readonly bin: string;
  /** Full argv (excluding the bin) — with `bin`, the reproduction command
   *  an agent runs to see the failure itself. Absent on requirement-level
   *  skips (no command was built). */
  readonly args?: readonly string[];
  readonly status: CorrectnessStatus;
  /** Captured output tail on `fail` (for the block message), or the
   *  disclosed reason on `skipped-unavailable` (missing binary / wrapper
   *  not executable — carries the remedy). */
  readonly output?: string;
  /** Present only on `skipped-environment` — the structured unmet-requirement
   *  reason (phrase via `describeUnmetRequirement`). */
  readonly unmet?: UnmetRequirement;
  /** FINDING-level identities for a check whose failure decomposes into
   *  diffable findings (today: the import-resolution check, one entry per
   *  unresolved specifier). When present on a failing check, the attribution
   *  comparator diffs the SET instead of the check's pass/fail bit — so a repo
   *  with pre-existing unresolved debt still blocks on a NEW break instead of
   *  grandfathering the whole check. Absent on command-backed checks (their
   *  granularity is the check — item for the failure-level attribution
   *  refinement). */
  readonly findings?: readonly string[];
}

export interface CorrectnessFloorResult {
  /** True when at least one check actually executed (not all skipped). */
  readonly ran: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  /** True when any check that ran failed — the floor blocks. */
  readonly blocks: boolean;
  /** Present when an `affected` request was escalated to `full` because the
   *  diff touched a dependency manifest/lockfile. A manifest change alters
   *  module resolution for EVERY file, so no affected-subset is sound — the
   *  shipped class: a dep-override PR whose diff was `package.json` +
   *  lockfile + docs read as "no source changed, nothing to run" and the
   *  floor ran NOTHING while the change broke the build. Disclosed so every
   *  surface can say WHY the full suite ran on a fast surface. `files` names
   *  the matched manifests (empty only in the no-declared-patterns fail-safe
   *  case, where escalation is still the honest default). */
  readonly scopeEscalated?: {
    readonly reason: 'dependency-manifest-changed';
    readonly files: readonly string[];
  };
}

export interface CorrectnessFloorOptions {
  readonly cwd: string;
  readonly changedFiles: readonly string[];
  readonly scope: CorrectnessScope;
  /** Active language packs (from `activeLanguagesFromStack` / `-Flags`). */
  readonly packs: readonly LanguageSupport[];
  /** Per-command wall-clock budget (ms). A command that exceeds it is a
   *  fail-OPEN skip, never a block — the fast surface stays fast, CI is the
   *  backstop. Undefined → no timeout. Ignored when `exec` is injected. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
  /** Injected for tests; defaults to the real local host + toolchain probes. */
  readonly env?: ExecutionEnvironment;
}

/** The one label the import-resolution check reports under — shared by the
 *  floor-state snapshot, the attribution comparator's finding-level path, and
 *  every renderer. */
export const IMPORT_RESOLUTION_LABEL = 'import-resolution';

/** Run a command's optional failure parser defensively: a parser throw or a
 *  non-array result is "not parseable" (null → check-level precision), never
 *  an error that breaks the floor. Results are deduped and order-normalized —
 *  identity must not depend on output order. */
function parseFailuresSafely(cmd: CorrectnessCommand, output: string): string[] | null {
  try {
    const raw = cmd.parseFailures!(output);
    if (raw === null || !Array.isArray(raw)) return null;
    const cleaned = [...new Set(raw.filter((f) => typeof f === 'string' && f.length > 0))].sort();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Execute a pack's optional import-resolution check (a pure computation, not a
 * command). Findings are keyed by SPECIFIER — the durable identity of "package
 * X does not resolve": a second file importing the same missing package is the
 * same root cause, while a NEW missing package on an already-red repo is a new
 * finding (the granularity the class fix requires). A throw is infrastructure:
 * disclosed skip, never a verdict.
 */
function runResolutionCheck(
  id: LanguageId,
  provider: CorrectnessProvider,
  ctx: CorrectnessContext,
): CorrectnessCheckResult {
  const base = { pack: id, label: IMPORT_RESOLUTION_LABEL, bin: '' };
  try {
    const res = provider.resolutionCheck!(ctx);
    if (res.kind === 'clean') return { ...base, status: 'pass' };
    if (res.kind === 'unresolved') {
      const lines = res.unresolved.map(
        (u) =>
          `'${u.specifier}' does not resolve against the installed tree (imported by ${u.file})`,
      );
      lines.push(
        'An import of an uninstalled/undeclared package fails at build or run time. ' +
          'Declare it in the dependency manifest and install it (or remove the import).',
      );
      return {
        ...base,
        status: 'fail',
        output: lines.join('\n'),
        findings: [...new Set(res.unresolved.map((u) => u.specifier))],
      };
    }
    return { ...base, status: 'skipped-unavailable', output: res.reason };
  } catch (err) {
    return {
      ...base,
      status: 'skipped-unavailable',
      output: `import-resolution check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run the correctness floor across the active packs. Never throws — an exec
 * error surfaces as a `fail` check (fail-closed), a missing binary as
 * `skipped-unavailable` (fail-open). `blocks` is true iff a check that ran
 * failed.
 */
export function runCorrectnessFloor(opts: CorrectnessFloorOptions): CorrectnessFloorResult {
  const exec = opts.exec ?? makeCommandExec(opts.timeoutMs);
  const env = opts.env ?? currentEnvironment();
  // Manifest-aware scope (decided ONCE here, never per-pack — Rule 2.30): a
  // diff that touches a dependency manifest/lockfile changes module resolution
  // for every file, which is the OPPOSITE of docs-only, so the pack-level
  // "no relevant source changed → skip" affected heuristics must never see it.
  // Escalate the whole run to `full`; the fail-open timeout bounds the cost on
  // fast surfaces. The predicate is the SAME pack-declared manifest union the
  // dep-audit skip consults (`manifestPatterns`, Rule 6). An empty changed set
  // (undeterminable diff) is not escalation — packs already treat it as full.
  const escalate =
    opts.scope === 'affected' &&
    opts.changedFiles.length > 0 &&
    changedFilesTouchDependencyManifest(opts.changedFiles, opts.packs);
  const scope: CorrectnessScope = escalate ? 'full' : opts.scope;
  const scopeEscalated = escalate
    ? ({
        reason: 'dependency-manifest-changed',
        files: dependencyManifestFilesIn(opts.changedFiles, opts.packs),
      } as const)
    : undefined;
  const ctx = { cwd: opts.cwd, changedFiles: opts.changedFiles, scope };
  const checks: CorrectnessCheckResult[] = [];

  for (const { id, provider } of activeCorrectnessProviders(opts.packs)) {
    // Rule 20: consult the pack's declared requirement BEFORE executing. An
    // unmet environment is a disclosed boundary — running anyway would either
    // fail-open invisibly (missing toolchain) or, worse, fail in a way that
    // reads as broken code (a Windows-only build target on a Linux host).
    const requirement = provider.execution(opts.cwd);
    const unmet = unmetRequirement(requirement, env);
    if (unmet !== null) {
      checks.push({ pack: id, label: 'floor', bin: '', status: 'skipped-environment', unmet });
      continue;
    }
    const commands = [provider.syntaxCheck(ctx), provider.affectedTests(ctx)];
    for (const cmd of commands) {
      if (cmd === null) continue; // pack declined this check for this change
      const outcome = exec(cmd, opts.cwd);
      if (!outcome.available) {
        checks.push({
          pack: id,
          label: cmd.label,
          bin: cmd.bin,
          args: cmd.args,
          status: 'skipped-unavailable',
          // WHY it was unavailable (not-on-PATH vs present-but-not-executable
          // vs spawn errno) — carried so every surface can disclose the skip
          // with its remedy instead of silently thinning the floor (Rule 20).
          ...(outcome.output ? { output: outcome.output } : {}),
        });
        continue;
      }
      if (outcome.timedOut) {
        // Exceeded the budget — fail-OPEN. The run didn't finish, so it says
        // nothing about correctness; CI (unbounded) is the backstop.
        checks.push({
          pack: id,
          label: cmd.label,
          bin: cmd.bin,
          args: cmd.args,
          status: 'skipped-timeout',
        });
        continue;
      }
      if (outcome.overflowed) {
        // Output outran the capture buffer — fail-OPEN, same reasoning as the
        // timeout above. The floor BLOCKS, so it must only block on a failure it
        // actually read; a fragment is not evidence of a broken build.
        checks.push({
          pack: id,
          label: cmd.label,
          bin: cmd.bin,
          args: cmd.args,
          status: 'skipped-overflow',
        });
        continue;
      }
      if (outcome.code !== 0) {
        // Post-failure tier of the F-14 fix: a failure whose output is
        // ENVIRONMENT-shaped (SDK resolution, toolchain-too-old — the
        // registry-declared signatures of the toolchains this floor runs on)
        // is a boundary, not broken code. The classifier defaults to null, so
        // a real compile error / failing test stays a blocking failure.
        const envFailure = classifyEnvironmentFailure(requirement.toolchains, outcome.output);
        if (envFailure !== null) {
          checks.push({
            pack: id,
            label: cmd.label,
            bin: cmd.bin,
            args: cmd.args,
            status: 'skipped-environment',
            unmet: { kind: 'unhealthy-toolchain', ...envFailure },
          });
          continue;
        }
      }
      // Failure-level identities (4.2): parse the FULL captured output — the
      // display tail is a truncation, and a snapshot built from a truncated
      // parse would under-record the base set and false-block later. A parser
      // that returns null or nothing on a failing run means "not confidently
      // parseable": the check stays at check-level precision and the
      // comparator DISCLOSES that instead of guessing.
      const parsed =
        outcome.code !== 0 && cmd.parseFailures ? parseFailuresSafely(cmd, outcome.output) : null;
      checks.push({
        pack: id,
        label: cmd.label,
        bin: cmd.bin,
        args: cmd.args,
        status: outcome.code === 0 ? 'pass' : 'fail',
        // DISPLAY only — `tail` belongs here, at the renderer boundary, not in the
        // capture primitive where a parser could mistake it for the whole stream.
        ...(outcome.code === 0 ? {} : { output: tail(outcome.output) }),
        ...(parsed !== null && parsed.length > 0 ? { findings: parsed } : {}),
      });
    }
    // The import-resolution check (optional capability): a direct computation,
    // not a command — no spawn, no PATH, no timeout budget needed. A throw is
    // infrastructure, never a verdict: fail-OPEN as a disclosed skip.
    if (provider.resolutionCheck) {
      checks.push(runResolutionCheck(id, provider, ctx));
    }
  }

  const ran = checks.some((c) => c.status === 'pass' || c.status === 'fail');
  const blocks = checks.some((c) => c.status === 'fail');
  return { ran, checks, blocks, ...(scopeEscalated ? { scopeEscalated } : {}) };
}

/** One-line disclosure of a manifest-driven scope escalation (null when the
 *  run was not escalated). Every surface that summarizes a floor run appends
 *  it, so a full-suite run on a fast surface always says why. */
export function describeScopeEscalation(result: CorrectnessFloorResult): string | null {
  if (!result.scopeEscalated) return null;
  const files = result.scopeEscalated.files;
  const which = files.length > 0 ? ` (${files.join(', ')})` : '';
  return `dependency manifest changed${which} — ran the full suite (a dependency change can affect any file)`;
}

/**
 * What a full-scope floor run WOULD execute here — the estimate an operator
 * sees BEFORE the expensive part (4.2 evaluate-first onboarding): capture runs
 * each pack's compile pass + FULL test suite, which is minutes on a real
 * repo, and a spinner that says only "capturing baseline" makes that read as
 * a hang. Pure: calls the pack command BUILDERS (never executes) at the same
 * full-scope context the capture uses, so the plan can never drift from the
 * run. Empty when no floor-capable pack is active (capture would no-op).
 */
export function describeFloorCapturePlan(cwd: string, packs: readonly LanguageSupport[]): string[] {
  const ctx = { cwd, changedFiles: [] as string[], scope: 'full' as const };
  const plan: string[] = [];
  for (const { id, provider } of activeCorrectnessProviders(packs)) {
    for (const cmd of [provider.syntaxCheck(ctx), provider.affectedTests(ctx)]) {
      if (cmd !== null) plan.push(`${id} ${cmd.label}: ${[cmd.bin, ...cmd.args].join(' ')}`);
    }
    if (provider.resolutionCheck) plan.push(`${id} import-resolution: read-only, sub-second`);
  }
  return plan;
}

/** One-line human summary of a floor result (for the Stop-gate / hook block). */
export function describeCorrectnessFloor(result: CorrectnessFloorResult): string {
  const failed = result.checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) return 'correctness floor: all checks passed';
  const which = failed.map((c) => `${c.pack} ${c.label}`).join(', ');
  return `correctness floor: ${failed.length} check(s) failed — ${which}`;
}

/** The environment-boundary disclosures in a floor result, one line per pack
 *  (empty when none). Shared by every surface that renders a floor run, so a
 *  capability that cannot run HERE is always named, with where it would run
 *  and the root remedy — never a silent skip (Rule 20). The floor always runs
 *  on the local host, so the local host selects the install hints. */
export function describeEnvironmentSkips(result: CorrectnessFloorResult): string[] {
  return [
    ...result.checks
      .filter((c) => c.status === 'skipped-environment' && c.unmet)
      .map(
        (c) =>
          `${c.pack} floor not measurable in this environment: ${describeUnmetRequirement(c.unmet as UnmetRequirement, hostOf())}`,
      ),
    // Unavailable-with-a-reason is the same disclosure obligation: a check
    // that could not even spawn (binary missing / wrapper not executable)
    // must be named with its remedy, never silently thin the floor.
    ...result.checks
      .filter((c) => c.status === 'skipped-unavailable' && c.output)
      .map((c) => `${c.pack} ${c.label} skipped: ${c.output}`),
  ];
}
