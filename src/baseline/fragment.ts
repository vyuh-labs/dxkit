/**
 * Multi-environment baseline composition (CLAUDE.md Rule 20, design §3.4 —
 * the hidden enabler): ONE committed baseline assembled from findings
 * captured in DIFFERENT environments. Sound because finding identity is
 * environment-independent by design (Rule 9) — the same finding gets the same
 * id regardless of which runner produced it.
 *
 * A FRAGMENT is a partial capture from a placed host: the `custom-check`
 * findings (and their recall inputs) for the checks that host can observe and
 * the primary cannot — the `lint:csharp` backlog captured on the windows
 * runner. The MERGE folds fragments into the committed baseline by
 * observation unit (the check name): the fragment OWNS its declared checks —
 * their prior entries and recall keys are replaced wholesale, everything else
 * is untouched. Never append-only (stale entries would grandfather fixed
 * findings forever) and never whole-kind (the primary's own lint checks live
 * in the same kind).
 *
 * Composition guards are load-bearing: a fragment minted under a different
 * identity scheme or recall epoch is NOT comparable, and merging it would
 * poison the baseline with ids the guardrail can never match — refused with
 * the remedy named, never silently accepted (the Rule 19 discipline).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { BaselineFile } from './baseline-file';
import { CURRENT_IDENTITY_SCHEME, type BaselineEntry, type IdentitySchemeVersion } from './types';
import { RECALL_EPOCHS, type RecallMap } from './recall';
import { customCheckFindingsToBaselineEntries } from './producers/custom-checks';
import {
  gatherCustomCheckFindings,
  observableSpecs,
  recallInputsForSpecs,
  resolveCustomCheckSpecs,
  type GatherCustomChecksOptions,
} from '../analyzers/custom-checks/gather';
// exec-requirement-ok: the fragment capture is a deliberate Rule 20 consumer —
// it derives its default observation scope ("what can THIS host see that the
// primary cannot") from the same predicate the runners and resolver use.
import { currentEnvironment, hostOf, unmetRequirement, type ExecutionHost } from '../execution';

export const FRAGMENT_SCHEMA = 'dxkit-baseline-fragment.v1' as const;

export interface BaselineFragment {
  readonly schema: typeof FRAGMENT_SCHEMA;
  readonly capturedAt: string;
  /** Host that captured this fragment (provenance for diagnostics). */
  readonly host: ExecutionHost;
  /** Scheme + epoch the fragment was minted under — the comparability
   *  guards the merge enforces. */
  readonly identityScheme: IdentitySchemeVersion;
  readonly customCheckEpoch: number;
  /** The observation scope: check names this fragment FULLY observed. The
   *  merge replaces exactly these checks' entries + recall keys. */
  readonly checks: readonly string[];
  /** `custom-check` entries for the observed checks. */
  readonly findings: readonly BaselineEntry[];
  /** Recall inputs for the observed checks (`<check>/...` namespaced), from
   *  the ONE seam derivation (`recallInputsForSpecs`). */
  readonly recallInputs: Readonly<Record<string, string>>;
}

export interface CaptureFragmentOptions extends GatherCustomChecksOptions {
  /** Explicit check names to capture. Default: the checks THIS host can
   *  observe that the primary (linux) host cannot — i.e. exactly the slice
   *  the placement plan routed here. */
  readonly checks?: readonly string[];
}

/**
 * Capture a baseline fragment on the current host. Runs ONLY the selected
 * checks (a windows capture job must not re-run eslint), maps their findings
 * through the one custom-check producer, and derives their recall through the
 * one seam formula — a fragment is byte-compatible with what a full capture
 * on this host would have recorded for these checks.
 */
export function captureFragment(opts: CaptureFragmentOptions): BaselineFragment {
  const env = opts.env ?? currentEnvironment();
  const all = resolveCustomCheckSpecs(opts);
  const selected = opts.checks
    ? all.filter((s) => opts.checks!.includes(s.name))
    : // Default: observable HERE, not observable on the primary host — the
      // placement plan's slice, derived from the same declarations.
      observableSpecs(all, env).filter(
        (s) =>
          s.execution &&
          unmetRequirement(s.execution, { host: 'linux', hasToolchain: () => true }) !== null,
      );

  // Through the seam's ONE entry point, scoped to the selected checks — a
  // fragment's findings are byte-compatible with what a full capture on this
  // host would have recorded for them (the arch-check custom-check rule).
  const findings =
    selected.length === 0
      ? []
      : gatherCustomCheckFindings({ ...opts, env, onlyChecks: selected.map((s) => s.name) });

  return {
    schema: FRAGMENT_SCHEMA,
    capturedAt: new Date().toISOString(),
    host: hostOf(),
    identityScheme: CURRENT_IDENTITY_SCHEME,
    customCheckEpoch: RECALL_EPOCHS['custom-check'],
    checks: selected.map((s) => s.name),
    findings: customCheckFindingsToBaselineEntries(findings),
    recallInputs: recallInputsForSpecs(selected),
  };
}

/** Refusal error with the remedy in the message — callers surface it verbatim. */
export class FragmentMergeError extends Error {}

/**
 * Fold a fragment into a baseline. Pure — the caller decides where the result
 * is written (the refresh workflow commits it via the existing anchor path).
 *
 * Ownership semantics: for every check the fragment declares, ALL prior
 * `custom-check` entries with that check name and ALL `<check>/…` recall keys
 * are replaced by the fragment's. Other checks, other kinds, and the
 * envelope are untouched.
 */
export function mergeFragment(baseline: BaselineFile, fragment: BaselineFragment): BaselineFile {
  if (fragment.schema !== FRAGMENT_SCHEMA) {
    throw new FragmentMergeError(
      `Unknown fragment schema '${String((fragment as { schema?: string }).schema)}' — ` +
        `re-capture the fragment with this dxkit version.`,
    );
  }
  const baselineScheme = baseline.identityScheme ?? 'v1';
  if (fragment.identityScheme !== baselineScheme) {
    throw new FragmentMergeError(
      `Fragment identity scheme '${fragment.identityScheme}' does not match the baseline's ` +
        `'${baselineScheme}' — the ids would never line up. Remedy: upgrade the baseline first ` +
        `(vyuh-dxkit update migrates it), then re-capture the fragment.`,
    );
  }
  if (fragment.customCheckEpoch !== RECALL_EPOCHS['custom-check']) {
    throw new FragmentMergeError(
      `Fragment custom-check recall epoch ${fragment.customCheckEpoch} does not match this ` +
        `dxkit's epoch ${RECALL_EPOCHS['custom-check']} — capture and merge must run the same ` +
        `dxkit version. Remedy: re-capture the fragment with the version doing the merge.`,
    );
  }
  const owned = new Set(fragment.checks);
  // `'check' in f` narrows past sanitized entries (a sanitized baseline keeps
  // ids only) — a sanitized custom-check entry without its check name cannot
  // be attributed to the fragment's scope, so it is conservatively KEPT.
  const kept = baseline.findings.filter(
    (f) => !(f.kind === 'custom-check' && 'check' in f && owned.has(f.check)),
  );

  const slot = baseline.recall?.['custom-check'];
  const keptInputs = Object.fromEntries(
    Object.entries(slot?.inputs ?? {}).filter(([key]) => !owned.has(key.split('/')[0])),
  );
  const recall: RecallMap = {
    ...(baseline.recall ?? {}),
    'custom-check': {
      epoch: fragment.customCheckEpoch,
      inputs: { ...keptInputs, ...fragment.recallInputs },
    },
  };

  return { ...baseline, recall, findings: [...kept, ...fragment.findings] };
}

/** Write a fragment (pretty JSON, mkdir -p). */
export function writeFragment(filePath: string, fragment: BaselineFragment): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(fragment, null, 2) + '\n', 'utf8');
}

/** Read + shape-check a fragment file. Throws `FragmentMergeError` with the
 *  remedy on anything unrecognizable — a merge must never guess. */
export function readFragment(filePath: string): BaselineFragment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new FragmentMergeError(`Cannot read fragment ${filePath}: ${(err as Error).message}`);
  }
  const f = parsed as BaselineFragment;
  if (
    !f ||
    f.schema !== FRAGMENT_SCHEMA ||
    !Array.isArray(f.checks) ||
    !Array.isArray(f.findings) ||
    typeof f.identityScheme !== 'string' ||
    typeof f.customCheckEpoch !== 'number'
  ) {
    throw new FragmentMergeError(
      `${filePath} is not a dxkit baseline fragment (expected schema '${FRAGMENT_SCHEMA}').`,
    );
  }
  return f;
}
