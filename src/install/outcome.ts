/**
 * The CI install OUTCOME: what the rendered dependency-install chain (the
 * `Install dependencies + dxkit` step of every generated workflow) recorded
 * about how its install ended, classified by the pack's declared tolerance
 * classifiers, and the PR-comment / annotation text a guardrails run prints
 * from it when the gate never got to run.
 *
 * The class this closes (#381): the chain ran BEFORE dxkit, so an install
 * failure was opaque to the gate, and the workflow's comment step printed a
 * blanket "did not run; this is not a finding in your change" written for
 * infrastructure failures. A PR that edited package.json by hand without
 * re-syncing the lockfile died there with EUSAGE, a shape dxkit already
 * classifies (`lockfile-drift`, the node pack's `isLockfileDrift`) and the
 * floor already words. Nothing classified the chain's output, so the
 * change's own finding read as "not yours".
 *
 * ONE classification (Rule 2.30): the rendered chain captures its output
 * and calls back into dxkit (`vyuh-dxkit install classify`), which picks the
 * strategy the chain picked (same variant list, same order) and classifies
 * the captured log through `classifyChainOutput`, the executor's own
 * fallback-failure classification. Never a regex in bash. The record's path
 * is ONE constant shared by the writer (the rendered chain) and the reader
 * (`vyuh-dxkit install comment`, run by the workflow's comment step).
 */
import * as fs from 'fs';
import * as path from 'path';
import { tail } from '../analyzers/tools/bounded-exec';
import {
  describeLockfileDrift,
  lockfileDriftFacts,
  toleranceDoctrine,
  type InstallStrategyProvider,
  type LockfileDriftFacts,
  type ToleranceClass,
  TOLERANCE_CLASSES,
} from '../languages/capabilities/install-strategy';
import { LOCKFILE_DRIFT } from '../languages/node-install';
import { classifyChainOutput, type InstallFailureClass } from './run';
import { ciInstallStrategy, INSTALL_OUTCOME_RECORD, NO_MANIFEST_INSTALL } from './shell';

export interface InstallOutcomeRecord {
  readonly ok: boolean;
  /** The class of what stopped the install (failed runs only). */
  readonly class?: InstallFailureClass;
  /** The primary's class, when a fallback ran and failed differently. */
  readonly primaryClass?: InstallFailureClass;
  /** The last command that ran. */
  readonly command: string;
  /** Every command the chain ran, in order. */
  readonly attempts: readonly string[];
  /** The last lines of the captured output (display-capped). */
  readonly tail: string;
  /** The picked strategy's manager, or null on the no-manifest branch. */
  readonly manager: string | null;
  /** The drift-remedy facts of the picked strategy (null without one). */
  readonly drift: LockfileDriftFacts | null;
}

/**
 * Classify a captured chain log the way the executor would have: pick the
 * strategy the rendered chain picked for `cwd` (`ciInstallStrategy`: the
 * same variants in the same order), then `classifyChainOutput` over the
 * frozen plan. The no-manifest branch (`npm install -g @vyuhlabs/dxkit`)
 * has no plan and classifies as `unclassified`.
 */
export function classifyInstallLog(
  cwd: string,
  providers: readonly InstallStrategyProvider[],
  log: string,
  code: number,
): InstallOutcomeRecord {
  const strategy = ciInstallStrategy(providers, cwd);
  if (strategy === null) {
    return {
      ok: code === 0,
      ...(code === 0 ? {} : { class: 'unclassified' }),
      command: NO_MANIFEST_INSTALL,
      attempts: [NO_MANIFEST_INSTALL],
      tail: code === 0 ? '' : tail(log),
      manager: null,
      drift: null,
    };
  }
  const chain = classifyChainOutput(strategy.modes.frozen, log);
  const base = {
    command: chain.command,
    attempts: chain.attempts,
    manager: strategy.manager,
    drift: lockfileDriftFacts(strategy),
  };
  if (code === 0) return { ok: true, ...base, tail: '' };
  return {
    ok: false,
    class: chain.classification,
    ...(chain.primaryClassification !== undefined
      ? { primaryClass: chain.primaryClassification }
      : {}),
    ...base,
    tail: tail(log),
  };
}

export function writeInstallOutcome(cwd: string, record: InstallOutcomeRecord): string {
  const abs = path.join(cwd, INSTALL_OUTCOME_RECORD);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return abs;
}

/** The record at `cwd`, or null when no install step wrote one (an older
 *  workflow, or a failure before the chain's classification could run). */
export function readInstallOutcome(cwd: string): InstallOutcomeRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, INSTALL_OUTCOME_RECORD), 'utf8'));
    if (typeof raw !== 'object' || raw === null || typeof raw.ok !== 'boolean') return null;
    return raw as InstallOutcomeRecord;
  } catch {
    return null;
  }
}

/** What the guardrails workflow prints when the gate produced no report. */
export interface InstallOutcomeComment {
  /** The PR comment body (the workflow prepends its marker). */
  readonly markdown: string;
  /** The one-line job annotation (`::error::` workflow command). */
  readonly annotation: string;
  /** True when the failure is a finding of the change (a BLOCK), false when
   *  it is the "did not run" disclosure. */
  readonly finding: boolean;
}

const DID_NOT_RUN = '### dxkit guardrails: did not run';

function fence(text: string): string {
  return text.trim().length === 0 ? '' : `\n\`\`\`\n${text.trim()}\n\`\`\`\n`;
}

function commandList(attempts: readonly string[]): string {
  return attempts.map((c) => `\`${c}\``).join(', then ');
}

/** The one-line summary of a classified install failure (the install step
 *  prints it; the comment's annotation carries the same sentence). */
export function summarizeInstallOutcome(r: InstallOutcomeRecord): string {
  if (r.ok) return `dependency install succeeded (${r.command})`;
  if (r.class === LOCKFILE_DRIFT) {
    return `dependency install failed on lockfile drift: ${describeLockfileDrift(r.drift)}`;
  }
  return `dependency install failed (${r.class ?? 'unclassified'}): ${commandList(r.attempts)} exited non-zero`;
}

/**
 * Render the comment + annotation for a run whose gate produced no report.
 *   - `lockfile-drift`: a BLOCK carrying the floor's own drift sentence
 *     (manager-aware), labelled a finding of the change.
 *   - any other failure: the "did not run" disclosure, naming the commands
 *     that ran and their last lines instead of pointing at the job log; a
 *     classified non-drift class is named with its doctrine summary.
 *   - an OK record: the install is ruled out, a later step failed.
 */
export function renderInstallOutcomeComment(r: InstallOutcomeRecord): InstallOutcomeComment {
  if (r.ok) {
    return {
      finding: false,
      markdown:
        `${DID_NOT_RUN}\n\n` +
        `The dependency install succeeded (\`${r.command}\`), but a later step failed before the ` +
        'guardrail produced its report, so this PR was **not** gated.\n' +
        'This is not a finding in your change.\n\n' +
        'See the failing step in this job log.\n',
      annotation:
        '::error::dxkit guardrail did not run: a step after the dependency install failed, so ' +
        'this PR was NOT gated. See the failing step in this job.',
    };
  }
  if (r.class === LOCKFILE_DRIFT) {
    const sentence = describeLockfileDrift(r.drift);
    return {
      finding: true,
      markdown:
        '### dxkit guardrails: BLOCKED\n\n' +
        `**The dependency install failed on a lockfile that does not record the manifest.** ` +
        `${sentence}\n\n` +
        'This is a finding of the change, not an infrastructure failure: no gate ran because ' +
        `the tree cannot be installed the way CI installs it (${commandList(r.attempts)}).\n\n` +
        'If the base branch already carries this drift, fix it there first: every PR into it ' +
        'inherits the same failure until the lockfile is re-synced.\n' +
        `${fence(r.tail)}`,
      annotation: `::error::dxkit guardrail blocked: ${sentence} (a finding of this change; details in the PR comment)`,
    };
  }
  const cls = r.class ?? 'unclassified';
  const doctrine =
    cls in TOLERANCE_CLASSES ? toleranceDoctrine(cls as ToleranceClass).summary : null;
  const classified =
    doctrine !== null
      ? `dxkit classified the failure as \`${cls}\` (${doctrine}), which no authorized install ` +
        'fallback answered.'
      : 'dxkit could not classify the failure as a finding in the change (a registry or network ' +
        'problem, a missing toolchain, or a failure shape dxkit does not know); it may still be one.';
  return {
    finding: false,
    markdown:
      `${DID_NOT_RUN}\n\n` +
      `The dependency install failed before the gate, so this PR was **not** gated: ` +
      `${commandList(r.attempts)} exited non-zero. ${classified}\n\n` +
      `Last lines of \`${r.command}\`:\n${fence(r.tail)}`,
    annotation:
      `::error::dxkit guardrail did not run: the dependency install (${commandList(r.attempts)}) ` +
      `failed before the gate (${cls}), so this PR was NOT gated. Last lines in the PR comment.`,
  };
}
