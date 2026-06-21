/**
 * Block-time hint generation.
 *
 * When the guardrail check rejects a finding, the developer needs
 * three things to act on it:
 *
 *   1. **Remediation** — the recommended fix (rotate the secret,
 *      upgrade the package, split the file, etc.). Generic per-kind
 *      prose; the conversational `dxkit-fix` skill produces
 *      LLM-backed, code-aware fixes when available.
 *   2. **Inline example** — the exact annotation comment to paste
 *      when the finding has a stable single-line attachment point
 *      and the chosen category is inline-compatible.
 *   3. **CLI command** — the exact `vyuh-dxkit allowlist add`
 *      invocation that handles the mutation without the developer
 *      typing annotation syntax.
 *
 * # Canonical input shape (CLAUDE.md Rule 9)
 *
 * This module consumes `BaselineEntry` directly — the canonical
 * per-kind discriminated union from `src/baseline/types.ts`. NO
 * intermediate "BlockingFinding" projection. The discriminated
 * union flows into the switch statements below so TypeScript's
 * exhaustiveness check fails the build when a new `IdentityKind`
 * variant is added without matching `case` branches here.
 *
 * Language is inferred from the entry's file path (when present)
 * via the canonical `LANGUAGES` registry. No language-specific
 * branches; pack additions auto-propagate.
 *
 * The returned `BlockHint` is a plain data object so callers can
 * render it as terminal output, emit it as JSON for the skill /
 * future MCP surface, etc. Rendering text lives at the call site,
 * NOT here.
 */

import * as path from 'path';
import { isSanitized } from '../baseline/sanitize';
import type { BaselineEntry, FindingSeverity } from '../baseline/types';
import { LANGUAGES } from '../languages';
import type { LanguageSupport } from '../languages/types';
import {
  CATEGORIES_BY_KIND,
  EXPIRING_CATEGORIES,
  INLINE_COMPATIBLE_CATEGORIES,
  INLINE_COMPATIBLE_KINDS,
  type AllowlistCategory,
} from './categories';
import { renderAnnotation } from './inline';
import { dxkitCli } from '../self-invocation';

/**
 * Subcommand string used in every `cliCommand` rendered by this
 * module. One place to update if the subcommand ever renames.
 */
const ALLOWLIST_ADD_CMD = dxkitCli('allowlist add');

export interface BlockHint {
  /** Generic per-kind remediation text. Always present. */
  readonly remediation: string;
  /** Categories that semantically apply to this kind. Empty for
   *  `license` (which drops out of the baseline producer registry
   *  in 2.6+). */
  readonly applicableCategories: readonly AllowlistCategory[];
  /** Inline annotation example. Populated only when the entry has
   *  a stable single-line attachment, the kind's first applicable
   *  category is inline-compatible, and the language is inferable
   *  from the file extension. */
  readonly inlineExample?: string;
  /** Shell command for the CLI write path. Always present. */
  readonly cliCommand: string;
  /** True when the kind has no inline-compatible category
   *  applicable (e.g. hygiene — only accepted-risk + deferred,
   *  both file-only). The CLI / skill routes the dev directly to
   *  the file-level surface when true. */
  readonly fileLevelOnly: boolean;
  /** Pointer to the file-level allowlist surface when an expiring
   *  category (accepted-risk / deferred) might apply. */
  readonly fileLevelHint?: string;
}

/**
 * Build the structured block-time hint from a baseline entry.
 * Pure function — no IO, no side effects. The caller renders the
 * fields into its medium of choice.
 *
 * The optional `severity` parameter is reserved for future
 * remediation-prose tuning (e.g. "rotate IMMEDIATELY" for
 * critical-severity secrets). Currently unused but threaded
 * through so callers don't need to refactor when the prose
 * starts varying on severity.
 */
export function formatBlockHint(entry: BaselineEntry, severity?: FindingSeverity): BlockHint {
  const applicableCategories = CATEGORIES_BY_KIND[entry.kind];
  const inlineCompatibleApplicable = applicableCategories.filter((c) =>
    INLINE_COMPATIBLE_CATEGORIES.has(c),
  );
  const fileLevelOnly =
    !INLINE_COMPATIBLE_KINDS.has(entry.kind) || inlineCompatibleApplicable.length === 0;

  const firstInlineCategory = inlineCompatibleApplicable[0];
  const inlineExample = buildInlineExample(entry, firstInlineCategory);
  const cliCommand = buildCliCommand(entry, applicableCategories);
  const fileLevelHint = buildFileLevelHint(applicableCategories);

  // Severity threaded for future use; not consumed yet — declare it
  // touched so an unused-parameter rule doesn't complain.
  void severity;

  return {
    remediation: remediationFor(entry.kind),
    applicableCategories,
    inlineExample,
    cliCommand,
    fileLevelOnly,
    fileLevelHint,
  };
}

/**
 * Generic per-kind remediation text. Exhaustive switch on the
 * canonical `BaselineEntry['kind']` union — TypeScript enforces
 * every variant has prose so a new kind can't ship without
 * matching `case` branches.
 */
export function remediationFor(kind: BaselineEntry['kind']): string {
  switch (kind) {
    case 'secret':
    case 'secret-hmac':
      return (
        'Rotate this credential immediately and load it from an environment variable ' +
        'or secret manager instead of source. Do not commit the replacement to git ' +
        'history — clean previous commits with git-filter-repo if necessary.'
      );
    case 'code':
      return (
        'Review the flagged code pattern. If the scanner is wrong (false positive), ' +
        'suppress via the allowlist with category=false-positive. Otherwise fix the ' +
        'underlying issue — the scanner caught it for a reason.'
      );
    case 'config':
      return (
        'Review the configuration setting. Many config-level findings ' +
        '(TLS validation disabled, debug mode in production, etc.) reflect ' +
        'operational risk; fix at the deployment / infrastructure layer where ' +
        'possible rather than in source.'
      );
    case 'dep-vuln':
      return (
        'Upgrade the vulnerable dependency to the patched version. Run ' +
        '`' +
        dxkitCli('vulnerabilities') +
        '` to see the suggested install command ' +
        'for this ecosystem.'
      );
    case 'duplication':
      return (
        'Extract the duplicated logic into a shared helper or accept the ' +
        'duplication via the allowlist when it is intentional ' +
        '(e.g., parallel test fixtures, generated code that must stay literal).'
      );
    case 'coverage-gap':
      return (
        'Add a test covering the uncovered region. If the code path is ' +
        'intentionally untested (build-time only, defensive error paths that ' +
        'cannot be reached from tests), accept the gap via the allowlist.'
      );
    case 'test-gap':
      return (
        'Create a test file for this source file. The convention follows the ' +
        "language's standard (e.g., `*_test.go` for go, `*.test.ts` for " +
        'typescript, `test_*.py` for python).'
      );
    case 'test-file-degradation':
      return (
        'Restore the test body. Empty or fully commented-out test functions pass ' +
        'silently in the test runner but provide no real coverage signal — they ' +
        'are worse than no test because they hide gaps from view.'
      );
    case 'hygiene':
      return (
        'Resolve the hygiene marker (TODO, FIXME, HACK, debug-print, or loose ' +
        '`any` type). Complete the work it points at, file it as a tracked issue ' +
        'in your task management system, or remove the marker if the underlying ' +
        'concern is already addressed.'
      );
    case 'god-file':
      return (
        'Split this file. It has grown beyond the maintainability threshold for ' +
        'this codebase — large files concentrate change risk and make focused ' +
        'review difficult. Extract cohesive subsets (related functions, related ' +
        'types) into separate modules.'
      );
    case 'large-file':
      return (
        'Split this file into smaller modules. Long files concentrate ' +
        'cognitive load and make change risk harder to assess; smaller ' +
        'modules with clear boundaries are easier to maintain.'
      );
    case 'stale-file':
      return (
        'Remove the stale on-disk artifact (typically `.swp`, `.bak`, `.orig`, ' +
        'or editor backup files). These should not be tracked in git — add the ' +
        'pattern to `.gitignore` and untrack the file.'
      );
    case 'stale-allow':
      return (
        'Remove the orphaned `dxkit-allow:` annotation — the finding it ' +
        'suppressed is no longer present, so the annotation is dead code. ' +
        'Allowlisting THIS finding is not supported; the only remediation is ' +
        'to delete the annotation comment.'
      );
  }
}

// ─── Internals ───────────────────────────────────────────────────────────

/**
 * Project a `BaselineEntry` to the file + line locator the hint
 * formatter needs. Exhaustive switch on entry.kind — TypeScript
 * enforces every variant is handled. Adding a new kind requires
 * extending this projection.
 *
 * Kinds without a stable file:line locator (`dep-vuln`, `duplication`,
 * `secret-hmac`) return `{}` and route to the `--fingerprint=<id>`
 * CLI form. Sanitized entries also return `{}` — the location was
 * stripped at write time and can only be addressed by fingerprint.
 */
function entryLocator(entry: BaselineEntry): { file?: string; line?: number } {
  if (isSanitized(entry)) return {};
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
    case 'hygiene':
    case 'stale-allow':
      return { file: entry.file, line: entry.line };
    case 'coverage-gap':
    case 'test-gap':
    case 'test-file-degradation':
    case 'god-file':
    case 'large-file':
    case 'stale-file':
      return { file: entry.file };
    case 'secret-hmac':
    case 'dep-vuln':
    case 'duplication':
      return {};
  }
}

/**
 * Look up the language pack matching a file's extension. Reads
 * from the canonical `LANGUAGES` registry — no per-language
 * branching here. A new language pack auto-propagates.
 */
function inferLanguage(file: string): LanguageSupport | undefined {
  const ext = path.extname(file).toLowerCase();
  if (!ext) return undefined;
  for (const lang of LANGUAGES) {
    if (lang.sourceExtensions.includes(ext)) return lang;
  }
  return undefined;
}

function buildInlineExample(
  entry: BaselineEntry,
  firstInlineCategory: AllowlistCategory | undefined,
): string | undefined {
  if (!firstInlineCategory) return undefined;
  if (!INLINE_COMPATIBLE_KINDS.has(entry.kind)) return undefined;
  const loc = entryLocator(entry);
  if (!loc.file || loc.line === undefined) return undefined;
  const lang = inferLanguage(loc.file);
  if (!lang || !lang.commentSyntax) return undefined;
  return renderAnnotation({ category: firstInlineCategory, reason: '<your reason here>' }, lang);
}

function buildCliCommand(
  entry: BaselineEntry,
  applicableCategories: readonly AllowlistCategory[],
): string {
  const firstCategory = applicableCategories[0];
  const reasonArg = `--reason="<rationale here>"`;
  const categoryArg = firstCategory ? `--category=${firstCategory}` : '--category=<category>';
  const loc = entryLocator(entry);

  // Two CLI forms, matching the two paths the `allowlist add` command
  // accepts. Both are directly executable — no inferred missing args.
  //
  //   1. `<file>:<line>` — inline annotation insertion (kind-agnostic,
  //      grammar-driven). Only chosen when the kind supports inline
  //      attachment AND the entry carries file + line.
  //   2. `--fingerprint=<id> --kind=<kind>` — file-level allowlist
  //      entry. The fingerprint is the identity; the kind is needed
  //      so the validator can apply per-kind rules.
  if (INLINE_COMPATIBLE_KINDS.has(entry.kind) && loc.file && loc.line !== undefined) {
    return `${ALLOWLIST_ADD_CMD} ${loc.file}:${loc.line} ${categoryArg} ${reasonArg}`;
  }
  return `${ALLOWLIST_ADD_CMD} --fingerprint=${entry.id} --kind=${entry.kind} ${categoryArg} ${reasonArg}`;
}

function buildFileLevelHint(
  applicableCategories: readonly AllowlistCategory[],
): string | undefined {
  const hasExpiringCategory = applicableCategories.some((c) => EXPIRING_CATEGORIES.has(c));
  if (!hasExpiringCategory) return undefined;
  return (
    'For accepted-risk or deferred suppression (both require an expiry date), ' +
    'use --category=accepted-risk or --category=deferred with --expires=YYYY-MM-DD, ' +
    'or edit .dxkit/allowlist.json directly.'
  );
}
