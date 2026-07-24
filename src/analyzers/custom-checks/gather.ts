/**
 * The ONE entry point that gathers a repo's custom-check findings for a cwd:
 * user-declared checks (`.dxkit/policy.json:checks`) PLUS pack-declared built-in
 * lint (`lint.enabled`). Both normalize to runner specs and run through the one
 * `runCustomChecks` — so the baseline producer (create time) and the guardrail
 * current-scan see the identical set from the identical code path (Rule 2).
 *
 * Zero-cost when nothing is configured: no `checks`, `lint.enabled` falsy →
 * returns `[]` without spawning anything. So a repo that hasn't opted into
 * custom checks pays nothing, and the custom-check kind contributes no baseline
 * entries.
 */

import { createHash } from 'crypto';
import * as path from 'path';
import { detectActiveLanguages } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import type { BrownfieldPolicy } from '../../baseline/policy';
import { lintGateSpecs, normalizeCustomChecks } from './config';
import { runCustomChecks } from './run';
import type { CommandExec } from '../tools/bounded-exec';
import { currentEnvironment, unmetRequirement, type ExecutionEnvironment } from '../../execution';
import {
  extensionRecallInputs,
  gatherExtensionFindings,
} from '../../extensions/extension-findings';
import type { CustomCheckFinding, CustomCheckSpec } from './types';
import type { AnalysisTrustContext } from '../../analysis-trust';

export interface GatherCustomChecksOptions {
  readonly cwd: string;
  /** REQUIRED (4.2): whose tree is this? Threaded to the one runner — an
   *  untrusted context never spawns a repo-declared command, and requiring
   *  it here means the guardrail's create-scan path cannot forget it (the
   *  ungated-sink class). */
  readonly trust: AnalysisTrustContext;
  readonly policy: BrownfieldPolicy;
  /** Active language packs. Defaults to `detectActiveLanguages(cwd)`; injected
   *  in tests + reused by callers that already detected them. */
  readonly packs?: readonly LanguageSupport[];
  /** Repo-relative changed files, threaded to lint providers (most lint the
   *  whole tree; the field is available for packs that scope). */
  readonly changedFiles?: readonly string[];
  /** Per-command wall-clock budget (ms); a slow check is a fail-open skip. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
  /** Injected for tests; defaults to the real local host + toolchain probes. */
  readonly env?: ExecutionEnvironment;
  /**
   * Scope the gather to these check names — the fragment capture's slice
   * (Rule 20 / design §3.4). When set, ONLY the named checks run, and
   * committed extension findings are NOT appended (a scoped host capture owns
   * its checks; extension snapshots are the primary capture's to read).
   * Undefined = the full seam, exactly as before.
   */
  readonly onlyChecks?: readonly string[];
}

/**
 * The specs whose declared execution requirement THIS environment satisfies
 * (Rule 20) — the ONE observability filter shared by the recall derivation
 * below and the fragment capture (`src/baseline/fragment.ts`). A spec with no
 * declaration (a user check) always passes: dxkit cannot know what `make
 * lint` needs and does not invent a requirement.
 */
export function observableSpecs(
  specs: readonly CustomCheckSpec[],
  env: ExecutionEnvironment,
): CustomCheckSpec[] {
  return specs.filter((s) => !s.execution || unmetRequirement(s.execution, env) === null);
}

/** Resolve the full spec set (user checks + built-in lint) for a repo. Pure
 *  aside from `detectActiveLanguages` (which reads the tree). Exposed so callers
 *  can tell "are any checks configured?" without running them. */
export function resolveCustomCheckSpecs(opts: GatherCustomChecksOptions): CustomCheckSpec[] {
  const { specs: userSpecs } = normalizeCustomChecks(opts.policy.checks);
  const packs = opts.packs ?? detectActiveLanguages(opts.cwd);
  const lintSpecs = lintGateSpecs(
    packs,
    { cwd: opts.cwd, changedFiles: opts.changedFiles ?? [] },
    opts.policy.lint,
    opts.policy.recall,
  );
  return [...userSpecs, ...lintSpecs];
}

/**
 * What determines what the `custom-check` kind can SEE on this repo (CLAUDE.md
 * Rule 19) — resolved at the SEAM, for all three of its consumers, exactly like
 * `gatherCustomCheckFindings` resolves their findings. One entry point, one
 * answer: the baseline producer and the guardrail's current scan cannot see
 * different recall for the same repo (Rule 2).
 *
 * Per spec, three inputs come from the spec itself and the rest from the pack:
 *
 *   - `cmd`   — a different command sees different files and rules;
 *   - `parse` — the regex decides what is EXTRACTABLE from the output, so
 *               changing it changes recall as surely as a tool bump does;
 *   - `exit`  — which exit code counts as clean;
 *   - `<pack inputs>` — the linter's own version, its plugins, its config
 *               (Rule 6: only the pack knows its ecosystem).
 *
 * Cheap: pure string work over already-resolved specs plus a manifest read per
 * extension. No command is executed — this is called on every scan, including
 * the ones that find nothing.
 */
export function customCheckRecallInputs(opts: GatherCustomChecksOptions): Record<string, string> {
  // Rule 20 honesty: a check this environment CANNOT run contributes no
  // recall inputs — it was not observed, and claiming its recall would
  // fabricate comparability (the exact proxy Rule 19 exists to kill). The
  // latent lie this closes: a baseline captured on linux recorded
  // `lint:csharp/...` inputs (config hashes need no dotnet) while the runner
  // env-skipped the check, so a later windows gate read "comparable, zero
  // grandfathered findings" and flagged the repo's ENTIRE pre-existing lint
  // backlog as net-new. Unobserved must read as ABSENT, which the recall
  // diff already treats as "cannot attribute" — the honest answer.
  const env = opts.env ?? currentEnvironment();
  return {
    ...recallInputsForSpecs(observableSpecs(resolveCustomCheckSpecs(opts), env)),
    ...extensionRecallInputs(opts.cwd),
  };
}

/** The per-spec recall derivation, factored so the fragment capture
 *  (`src/baseline/fragment.ts`) reuses the ONE formula for the checks it
 *  observed on its host (Rule 2 — a second derivation would drift). */
export function recallInputsForSpecs(specs: readonly CustomCheckSpec[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const spec of specs) {
    // A declared-but-unresolvable gate (F-9 stub) was NOT observed — claiming
    // its recall would fabricate comparability, the same lie the env filter
    // above this function exists to kill. Unobserved reads as absent.
    if (spec.unavailable) continue;
    inputs[`${spec.name}/cmd`] = normalizeCommandForRecall(spec.command.bin, spec.command.args);
    inputs[`${spec.name}/parse`] =
      spec.parse.mode === 'regex'
        ? `regex:${hashText(spec.parse.pattern)}`
        : spec.parse.mode === 'structured'
          ? // The function itself cannot be hashed; the pack-declared label IS
            // the parse's recall identity, and packs must change it when the
            // parse's semantics change.
            `structured:${spec.parse.label}`
          : 'exit';
    inputs[`${spec.name}/exit`] = String(spec.expectedExit);
    for (const [key, value] of Object.entries(spec.recallInputs ?? {})) {
      inputs[`${spec.name}/${key}`] = value;
    }
  }
  return inputs;
}

/**
 * Render a check's command as a recall input, with absolute paths reduced to
 * their basename.
 *
 * A recall input must be stable across MACHINES, not just across runs on one
 * machine — the baseline is captured in one place (a developer's laptop, a
 * refresh job) and compared in another (CI). Absolute paths are the one part of
 * a command that reliably differs between the two:
 *
 *   - dxkit's own eslint formatter resolves to wherever dxkit is installed
 *     (`/home/me/projects/dxkit-repo/dist/...` locally,
 *     `<repo>/node_modules/@vyuhlabs/dxkit/dist/...` for a user);
 *   - a pack resolves its linter through `findTool`, so `bin` is an absolute
 *     path into a venv, a Homebrew prefix, or `~/.cargo/bin`.
 *
 * Left raw, those read as permanent drift: the lint gate would degrade to
 * warn-only on every CI run, forever, while looking perfectly healthy. That is
 * the OVER-drift failure — worse than the misattribution this rule fixes,
 * because nothing ever fails to announce it. Caught by running the real thing
 * against a real repo; no unit test would have noticed, because in a test the
 * two sides share a machine.
 *
 * Dropping the directory loses nothing that matters. WHICH linter binary ran is
 * already carried by its resolved version (a pack's `recallInputs`), and dxkit's
 * own files are covered by the kind's `epoch`. The basename is kept because it
 * still discriminates a real change (`--config a.yml` -> `--config b.yml`).
 */
function normalizeCommandForRecall(bin: string, args: readonly string[]): string {
  return [bin, ...args].map(normalizePathToken).join(' ');
}

function normalizePathToken(token: string): string {
  // `--flag=/abs/path` — normalize the value, keep the flag.
  const eq = token.indexOf('=');
  if (eq > 0) {
    const flag = token.slice(0, eq);
    const value = token.slice(eq + 1);
    return path.isAbsolute(value) ? `${flag}=${path.basename(value)}` : token;
  }
  return path.isAbsolute(token) ? path.basename(token) : token;
}

/** 16-char SHA-1 for recall-input bundling. Envelope metadata, never a finding
 *  identity (Rule 9) — the parse pattern is hashed only so a 400-char regex
 *  does not dominate the baseline's recall record. */
function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16); // fingerprint-helper-ok: recall-input hash, not finding identity
}

/**
 * Run every configured custom check for `cwd` and return the flattened
 * findings. Returns `[]` (no spawn) when nothing is configured.
 */
export function gatherCustomCheckFindings(
  opts: GatherCustomChecksOptions,
): readonly CustomCheckFinding[] {
  const all = resolveCustomCheckSpecs(opts);
  const specs = opts.onlyChecks ? all.filter((s) => opts.onlyChecks!.includes(s.name)) : all;
  const commandFindings =
    specs.length === 0
      ? []
      : runCustomChecks({
          cwd: opts.cwd,
          trust: opts.trust,
          specs,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        }).findings;
  if (opts.onlyChecks) return commandFindings;
  // The seam's third consumer (after user checks + pack lint): findings
  // committed by findings-kind EXTENSIONS. Snapshot reads only — nothing
  // executes here (extensions run at refresh time; gates stay offline) —
  // and both the baseline producer and the guardrail current scan reach
  // extension findings through THIS one entry point, so the two sides
  // always see the identical set (Rule 2).
  return [...commandFindings, ...gatherExtensionFindings(opts.cwd)];
}
