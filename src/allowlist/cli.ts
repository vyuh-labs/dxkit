/**
 * `vyuh-dxkit allowlist <subcommand>` — orchestrates the user-facing
 * write/read paths over the allowlist module.
 *
 * Subcommands (Sprint 1 chunk):
 *
 *   - `add <file>:<line>` — inline annotation insertion. Kind-agnostic;
 *     the annotation grammar carries category + reason only. Refuses
 *     non-inline-compatible categories (accepted-risk / deferred).
 *
 *   - `add --fingerprint=<id> --kind=<kind>` — file-level allowlist
 *     entry. Persists to `.dxkit/allowlist.json` (or its sanitized
 *     mode + gitignored reasons sidecar). Required for any
 *     accepted-risk / deferred suppression OR any kind that lacks a
 *     stable single-line attachment point.
 *
 *   - `list` — print every entry across the file-level allowlist.
 *     Reads only; no mutation. Honors `--json` for structured output.
 *
 *   - `show <fingerprint>` — print one entry's full detail. Falls
 *     back to a "no entry found" message when the fingerprint isn't
 *     present.
 *
 * Subcommands `audit` and `prune` land in a follow-up commit.
 *
 * # Architectural posture
 *
 * Every IO goes through `loadAllowlist` / `saveAllowlist` in
 * `src/allowlist/file.ts` (arch-rule 1 enforces this). Inline
 * annotation insertion goes through `insertAnnotation` in
 * `src/allowlist/inline.ts`. Per-kind / per-category validation
 * goes through `categories.ts` helpers. NO duplicated taxonomy or
 * IO logic here — this file is pure orchestration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as logger from '../logger';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
} from '../baseline/baseline-file';
import { canonicalRuleFor, computeCodeFingerprint } from '../analyzers/tools/fingerprint';
import { readAllSnapshots } from '../ingest/snapshot';
import { buildSnykPolicy, expiryToSnykDatetime, type SnykIgnore } from '../ingest/snyk-policy';
import { LANGUAGES } from '../languages';
import type { LanguageSupport } from '../languages/types';
import type { IdentityKind } from '../baseline/producers';
import type { FindingSeverity } from '../baseline/types';
import {
  ALL_CATEGORIES,
  DEFAULT_EXPIRY_DAYS,
  INLINE_COMPATIBLE_CATEGORIES,
  defaultExpiryDate,
  isCategoryValidForKind,
  requiresExpiry,
  type AllowlistCategory,
} from './categories';
import {
  ALLOWLIST_FILENAME,
  ALL_MODES,
  addEntry,
  auditAllowlist,
  emptyAllowlistFile,
  findEntry,
  isEntryActive,
  loadAllowlist,
  pathForAllowlist,
  pruneExpired,
  removeEntry,
  saveAllowlist,
  validateAllowlistEntry,
  type AllowlistEntry,
  type AllowlistFile,
  type AllowlistMode,
  type AuditReport,
} from './file';
import { insertAnnotation } from './inline';

/** Subcommands recognized under `vyuh-dxkit allowlist`. */
export const ALLOWLIST_SUBCOMMANDS = [
  'add',
  'list',
  'show',
  'audit',
  'prune',
  'remove',
  'export',
] as const;
export type AllowlistSubcommand = (typeof ALLOWLIST_SUBCOMMANDS)[number];

export interface AllowlistAddOpts {
  /** Positional target. `<file>:<line>` for inline form; absent or a
   *  bare file path for file-level form (requires `--fingerprint`
   *  + `--kind`). */
  readonly target?: string;
  readonly category?: string;
  readonly reason?: string;
  readonly kind?: string;
  readonly fingerprint?: string;
  readonly expires?: string;
  readonly acknowledgedSeverity?: string;
  readonly addedBy?: string;
  /** Override the configured mode for this write only. Default
   *  reads from `.dxkit/policy.json` (out of scope here; this
   *  module accepts a flag to choose). */
  readonly mode?: AllowlistMode;
}

export interface AllowlistShowOpts {
  readonly fingerprint?: string;
  readonly json?: boolean;
}

export interface AllowlistListOpts {
  readonly json?: boolean;
}

export interface AllowlistAuditOpts {
  readonly json?: boolean;
  /** Soon-to-expire horizon in days (default 14). */
  readonly soonToExpireDays?: number;
  /** Cross-check fingerprints against the committed baseline so the
   *  audit can flag orphaned entries (suppress nothing in the current
   *  finding set). Off by default — keeps `audit` a pure read of the
   *  allowlist file unless the user opts in. */
  readonly againstBaseline?: boolean;
  /** Named baseline to diff against (default `main`). */
  readonly baselineName?: string;
}

export interface AllowlistRemoveOpts {
  readonly fingerprint?: string;
  readonly json?: boolean;
}

export interface AllowlistExportOpts {
  /** Target format. Only `--snyk` is supported today. */
  readonly snyk?: boolean;
  /** Output path (default `.snyk` in cwd). */
  readonly out?: string;
  readonly json?: boolean;
  /** ISO datetime stamped as each ignore's `created`. Defaults to now;
   *  injectable for deterministic tests. */
  readonly now?: string;
}

export interface AllowlistPruneOpts {
  readonly json?: boolean;
  /** Don't write; just print what would be removed. */
  readonly dryRun?: boolean;
  /** Skip confirmation prompt + write directly. Default behavior
   *  in Sprint 1 (no interactive prompts in dxkit yet) — the flag
   *  is accepted for future-proofing. */
  readonly yes?: boolean;
}

/**
 * Dispatch entry point called from `src/cli.ts`. Validates the
 * subcommand name + routes to the per-subcommand handler. Unknown
 * subcommands exit with a clear error and the list of recognized
 * names.
 */
export async function runAllowlist(
  cwd: string,
  subcommand: string | undefined,
  args: {
    positionalAfter?: string;
    values: Record<string, unknown>;
  },
): Promise<void> {
  if (!subcommand || !isAllowlistSubcommand(subcommand)) {
    logger.fail(
      `Unknown allowlist subcommand: ${JSON.stringify(subcommand ?? '(none)')}. ` +
        `Expected one of: ${ALLOWLIST_SUBCOMMANDS.join(', ')}.`,
    );
    process.exit(1);
  }

  switch (subcommand) {
    case 'add':
      return runAllowlistAdd(cwd, {
        target: args.positionalAfter,
        category: args.values.category as string | undefined,
        reason: args.values.reason as string | undefined,
        kind: args.values.kind as string | undefined,
        fingerprint: args.values.fingerprint as string | undefined,
        expires: args.values.expires as string | undefined,
        acknowledgedSeverity: args.values['acknowledged-severity'] as string | undefined,
        addedBy: args.values['added-by'] as string | undefined,
        mode: args.values.mode as AllowlistMode | undefined,
      });
    case 'list':
      return runAllowlistList(cwd, { json: !!args.values.json });
    case 'show':
      return runAllowlistShow(cwd, {
        fingerprint: args.positionalAfter,
        json: !!args.values.json,
      });
    case 'audit': {
      const horizonRaw = args.values['soon-days'] as string | undefined;
      const horizon = horizonRaw ? parseInt(horizonRaw, 10) : undefined;
      return runAllowlistAudit(cwd, {
        json: !!args.values.json,
        soonToExpireDays: Number.isFinite(horizon) ? horizon : undefined,
        againstBaseline: !!args.values['against-baseline'],
        baselineName: args.values['baseline-name'] as string | undefined,
      });
    }
    case 'prune':
      return runAllowlistPrune(cwd, {
        json: !!args.values.json,
        dryRun: !!args.values['dry-run'],
        yes: !!args.values.yes,
      });
    case 'remove':
      return runAllowlistRemove(cwd, {
        fingerprint: args.positionalAfter,
        json: !!args.values.json,
      });
    case 'export':
      return runAllowlistExport(cwd, {
        snyk: !!args.values.snyk,
        out: args.values.out as string | undefined,
        json: !!args.values.json,
      });
  }
}

// ─── add ──────────────────────────────────────────────────────────────────

export async function runAllowlistAdd(cwd: string, opts: AllowlistAddOpts): Promise<void> {
  // Validate category up-front so the rest of the flow can assume
  // it's a canonical value.
  const category = parseCategory(opts.category);
  const reason = (opts.reason ?? '').trim();
  if (!reason) {
    logger.fail('--reason is required (non-empty rationale string)');
    process.exit(1);
  }

  // Two routing paths: inline annotation insertion vs file-level entry.
  // The target shape decides:
  //   - `<file>:<line>` → inline (category must be inline-compatible)
  //   - `--fingerprint=<id> --kind=<kind>` → file-level
  const inlineTarget = parseInlineTarget(opts.target);
  if (inlineTarget) {
    return runAddInline({ cwd, target: inlineTarget, category, reason });
  }

  // File-level form
  return runAddFileLevel({ cwd, opts, category, reason });
}

interface InlineTarget {
  readonly file: string;
  readonly line: number;
}

function parseInlineTarget(target: string | undefined): InlineTarget | null {
  if (!target) return null;
  const m = target.match(/^(.+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2], 10) };
}

async function runAddInline(args: {
  cwd: string;
  target: InlineTarget;
  category: AllowlistCategory;
  reason: string;
}): Promise<void> {
  const { cwd, target, category, reason } = args;
  if (!INLINE_COMPATIBLE_CATEGORIES.has(category)) {
    logger.fail(
      `category ${JSON.stringify(category)} is file-only — ` +
        `use --fingerprint=<id> --kind=<kind> form instead. ` +
        `Inline-compatible categories: ${[...INLINE_COMPATIBLE_CATEGORIES].join(', ')}.`,
    );
    process.exit(1);
  }

  const absPath = path.resolve(cwd, target.file);
  const lang = inferLanguage(target.file);
  if (!lang || !lang.commentSyntax) {
    logger.fail(
      `cannot infer language from file extension for ${JSON.stringify(target.file)}; ` +
        `inline annotation requires a known language pack with commentSyntax`,
    );
    process.exit(1);
  }

  const result = insertAnnotation(absPath, target.line, { category, reason }, lang);
  logger.info(
    `Inserted ${result.position} allowlist annotation at ${target.file}:${result.annotationLine} ` +
      `(category=${category})`,
  );
}

async function runAddFileLevel(args: {
  cwd: string;
  opts: AllowlistAddOpts;
  category: AllowlistCategory;
  reason: string;
}): Promise<void> {
  const { cwd, opts, category, reason } = args;
  const fingerprint = opts.fingerprint?.trim();
  const kindRaw = opts.kind?.trim();
  if (!fingerprint || !kindRaw) {
    logger.fail(
      `file-level allowlist entry requires --fingerprint=<16-hex> and --kind=<kind> ` +
        `(or pass <file>:<line> for inline annotation when kind+category are inline-compatible)`,
    );
    process.exit(1);
  }
  const kind = kindRaw as IdentityKind;
  if (!isCategoryValidForKind(kind, category)) {
    logger.fail(
      `category ${JSON.stringify(category)} does not apply to kind ${JSON.stringify(kind)}`,
    );
    process.exit(1);
  }

  const expiresAt = resolveExpiresAt(opts.expires, category);
  const addedBy = opts.addedBy?.trim() || resolveGitUserEmail(cwd);
  if (!addedBy) {
    logger.fail(`--added-by is required (or set git config user.email so it can be inferred)`);
    process.exit(1);
  }
  const addedAt = todayISO();
  const acknowledgedSeverity = parseSeverityOpt(opts.acknowledgedSeverity);

  const entry: AllowlistEntry = {
    fingerprint,
    kind,
    category,
    reason,
    addedBy,
    addedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(acknowledgedSeverity !== undefined ? { acknowledgedSeverity } : {}),
  };

  // Resolve effective mode (CLI override → existing file mode → default 'full').
  const mode = resolveMode(cwd, opts.mode);
  const validationErrors = validateAllowlistEntry(entry, mode);
  if (validationErrors.length > 0) {
    logger.fail(`allowlist entry failed validation:`);
    for (const e of validationErrors) {
      logger.fail(`  - ${e.field}: ${e.message}`);
    }
    process.exit(1);
  }

  const existing = loadAllowlist(cwd) ?? emptyAllowlistFile(mode);
  if (findEntry(existing, fingerprint)) {
    logger.fail(
      `allowlist already contains entry for fingerprint ${fingerprint}. ` +
        `Run \`vyuh-dxkit allowlist show ${fingerprint}\` to inspect, or remove first.`,
    );
    process.exit(1);
  }

  const updated: AllowlistFile = { ...addEntry(existing, entry), mode };
  saveAllowlist(cwd, updated);
  logger.info(
    `Added allowlist entry for fingerprint ${fingerprint} (kind=${kind}, category=${category})` +
      (expiresAt ? `, expires ${expiresAt}` : ''),
  );
}

// ─── list ─────────────────────────────────────────────────────────────────

export async function runAllowlistList(cwd: string, opts: AllowlistListOpts): Promise<void> {
  const file = loadAllowlist(cwd);
  if (opts.json) {
    process.stdout.write(JSON.stringify(file ?? emptyAllowlistFile('full'), null, 2) + '\n');
    return;
  }

  if (!file || file.entries.length === 0) {
    logger.info(`No allowlist entries. Run \`vyuh-dxkit allowlist add\` to create one.`);
    return;
  }
  logger.info(
    `${file.entries.length} allowlist entr${file.entries.length === 1 ? 'y' : 'ies'} ` +
      `(mode=${file.mode}, schema=${file.schemaVersion}):`,
  );
  for (const entry of file.entries) {
    const expires = entry.expiresAt ? ` · expires ${entry.expiresAt}` : '';
    const reasonPreview = entry.reason ? ` — ${truncate(entry.reason, 60)}` : '';
    logger.info(
      `  ${entry.fingerprint}  ${entry.kind}/${entry.category}` +
        `  (added ${entry.addedAt}${expires})${reasonPreview}`,
    );
  }
}

// ─── show ─────────────────────────────────────────────────────────────────

export async function runAllowlistShow(cwd: string, opts: AllowlistShowOpts): Promise<void> {
  const fp = opts.fingerprint?.trim();
  if (!fp) {
    logger.fail(`Usage: vyuh-dxkit allowlist show <fingerprint>`);
    process.exit(1);
  }
  const file = loadAllowlist(cwd);
  if (!file) {
    logger.fail(`No allowlist file at ${pathForAllowlist(cwd)}`);
    process.exit(1);
  }
  const entry = findEntry(file, fp);
  if (!entry) {
    logger.fail(`No allowlist entry for fingerprint ${fp}`);
    process.exit(1);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    return;
  }
  logger.info(`Fingerprint:        ${entry.fingerprint}`);
  logger.info(`Kind:               ${entry.kind}`);
  logger.info(`Category:           ${entry.category}`);
  logger.info(`Added at:           ${entry.addedAt}`);
  if (entry.addedBy) logger.info(`Added by:           ${entry.addedBy}`);
  if (entry.expiresAt) logger.info(`Expires at:         ${entry.expiresAt}`);
  if (entry.acknowledgedSeverity) {
    logger.info(`Acknowledged sev.:  ${entry.acknowledgedSeverity}`);
  }
  if (entry.reason) logger.info(`Reason:             ${entry.reason}`);
}

// ─── audit ────────────────────────────────────────────────────────────────

export async function runAllowlistAudit(cwd: string, opts: AllowlistAuditOpts): Promise<void> {
  const file = loadAllowlist(cwd);
  if (!file) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { expired: [], soonToExpire: [], missingRationale: [] } satisfies AuditReport,
          null,
          2,
        ) + '\n',
      );
      return;
    }
    logger.info(`No allowlist file at ${pathForAllowlist(cwd)} — nothing to audit.`);
    return;
  }

  // Orphan detection is opt-in: only when `--against-baseline` is set
  // do we read the committed baseline and build the current-finding
  // fingerprint set. Without it, audit stays a pure read of the file.
  let currentFingerprints: ReadonlySet<string> | undefined;
  if (opts.againstBaseline) {
    currentFingerprints = baselineFingerprintSet(cwd, opts.baselineName);
    if (!currentFingerprints) {
      logger.warn(
        `--against-baseline requested but no baseline found at ` +
          `${pathForBaseline(cwd, opts.baselineName ?? DEFAULT_BASELINE_NAME)} — ` +
          `skipping orphan detection. Refresh the baseline in CI first ` +
          `(see the dxkit-baseline-refresh workflow).`,
      );
    }
  }

  const report = auditAllowlist(file, {
    soonToExpireDays: opts.soonToExpireDays,
    ...(currentFingerprints ? { currentFingerprints } : {}),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const total = file.entries.length;
  const horizon = opts.soonToExpireDays ?? 14;
  logger.info(
    `Allowlist audit: ${total} entr${total === 1 ? 'y' : 'ies'} ` +
      `(mode=${file.mode}); soon-to-expire window=${horizon} days`,
  );

  if (
    report.expired.length === 0 &&
    report.soonToExpire.length === 0 &&
    report.missingRationale.length === 0 &&
    (report.orphaned?.length ?? 0) === 0
  ) {
    logger.success(`No issues found.`);
    return;
  }

  if (report.expired.length > 0) {
    logger.warn(
      `Expired (${report.expired.length}) — run \`vyuh-dxkit allowlist prune\` to remove:`,
    );
    for (const e of report.expired) {
      logger.info(`  ${e.fingerprint}  ${e.kind}/${e.category}  expired ${e.expiresAt}`);
    }
  }

  if (report.soonToExpire.length > 0) {
    logger.warn(
      `Soon to expire (${report.soonToExpire.length}; within ${horizon} days) — review or extend:`,
    );
    for (const { entry, daysRemaining } of report.soonToExpire) {
      logger.info(
        `  ${entry.fingerprint}  ${entry.kind}/${entry.category}` +
          `  expires ${entry.expiresAt} (in ${daysRemaining}d)`,
      );
    }
  }

  if (report.missingRationale.length > 0) {
    logger.warn(
      `Missing rationale (${report.missingRationale.length}) — ` +
        `add a reason or sync the gitignored reasons sidecar:`,
    );
    for (const e of report.missingRationale) {
      logger.info(`  ${e.fingerprint}  ${e.kind}/${e.category}`);
    }
  }

  if (report.orphaned && report.orphaned.length > 0) {
    logger.warn(
      `Orphaned (${report.orphaned.length}) — fingerprint matches no current finding. ` +
        `REVIEW, don't bulk-remove: re-baselining can churn fingerprints, and an ` +
        `orphan may still suppress an intermittently-detected finding. Confirm the ` +
        `finding is truly gone, then \`vyuh-dxkit allowlist remove <fingerprint>\`:`,
    );
    for (const e of report.orphaned) {
      const reasonPreview = e.reason ? ` — ${truncate(e.reason, 50)}` : '';
      logger.info(`  ${e.fingerprint}  ${e.kind}/${e.category}${reasonPreview}`);
    }
  }
}

// ─── prune ────────────────────────────────────────────────────────────────

export async function runAllowlistPrune(cwd: string, opts: AllowlistPruneOpts): Promise<void> {
  const file = loadAllowlist(cwd);
  if (!file) {
    logger.info(`No allowlist file at ${pathForAllowlist(cwd)} — nothing to prune.`);
    return;
  }

  const { kept, removed } = pruneExpired(file);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ dryRun: !!opts.dryRun, removed, keptCount: kept.entries.length }, null, 2) +
        '\n',
    );
    if (!opts.dryRun && removed.length > 0) saveAllowlist(cwd, kept);
    return;
  }

  if (removed.length === 0) {
    logger.info(`No expired entries — allowlist is clean.`);
    return;
  }

  const verb = opts.dryRun ? 'Would remove' : 'Removing';
  logger.warn(`${verb} ${removed.length} expired entr${removed.length === 1 ? 'y' : 'ies'}:`);
  for (const e of removed) {
    logger.info(`  ${e.fingerprint}  ${e.kind}/${e.category}  expired ${e.expiresAt}`);
  }

  if (opts.dryRun) {
    logger.info(`(dry-run — no changes written; rerun without --dry-run to apply)`);
    return;
  }
  saveAllowlist(cwd, kept);
  logger.success(`Pruned ${removed.length} expired entries.`);
}

// ─── remove ─────────────────────────────────────────────────────────────────

export async function runAllowlistRemove(cwd: string, opts: AllowlistRemoveOpts): Promise<void> {
  const fp = opts.fingerprint?.trim();
  if (!fp) {
    logger.fail(`Usage: vyuh-dxkit allowlist remove <fingerprint>`);
    process.exit(1);
  }
  const file = loadAllowlist(cwd);
  if (!file) {
    logger.fail(`No allowlist file at ${pathForAllowlist(cwd)} — nothing to remove.`);
    process.exit(1);
  }
  const entry = findEntry(file, fp);
  if (!entry) {
    logger.fail(
      `No allowlist entry for fingerprint ${fp}. ` +
        `Run \`vyuh-dxkit allowlist list\` to see current entries.`,
    );
    process.exit(1);
  }

  const updated = removeEntry(file, fp);
  saveAllowlist(cwd, updated);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ removed: entry }, null, 2) + '\n');
    return;
  }
  logger.success(`Removed allowlist entry ${fp} (kind=${entry.kind}, category=${entry.category}).`);
}

// ─── export ─────────────────────────────────────────────────────────────────

/**
 * `allowlist export --snyk` — emit a `.snyk` policy file that ignores
 * every Snyk-originated finding the team has allowlisted in dxkit, so
 * the suppression propagates to Snyk's own gate (the OUTBOUND half of
 * the sync; 2.9.1 did the inbound SARIF-suppressions direction).
 *
 * Each ingested Snyk finding's canonical fingerprint is recomputed via
 * the shared helpers (Rule 9 — no parallel hash). A finding whose
 * fingerprint matches an ACTIVE allowlist entry becomes a `.snyk`
 * ignore keyed on the Snyk-native rule id + path, carrying the entry's
 * reason + expiry. Expired entries are skipped (they no longer
 * suppress). Only `snyk-code` findings export — native semgrep /
 * gitleaks findings have no Snyk equivalent.
 */
export async function runAllowlistExport(cwd: string, opts: AllowlistExportOpts): Promise<void> {
  if (!opts.snyk) {
    logger.fail(`allowlist export currently supports only --snyk. Usage: allowlist export --snyk`);
    process.exit(1);
  }

  const file = loadAllowlist(cwd);
  if (!file || file.entries.length === 0) {
    logger.info(`No allowlist entries — nothing to export.`);
    return;
  }

  const snapshots = readAllSnapshots(cwd).filter((f) => f.engine === 'snyk-code');
  if (snapshots.length === 0) {
    logger.info(
      `No Snyk Code findings have been ingested yet. ` +
        `Run \`vyuh-dxkit ingest --from-snyk\` first.`,
    );
    return;
  }

  // Recompute each Snyk finding's canonical fingerprint and match it to
  // an active allowlist entry. Dedup (rule, path) so several findings on
  // the same rule+path collapse to one ignore directive.
  const created = opts.now ?? new Date().toISOString();
  const ignores: SnykIgnore[] = [];
  const seenRulePath = new Set<string>();
  let skippedExpired = 0;
  for (const f of snapshots) {
    const fingerprint = computeCodeFingerprint(canonicalRuleFor(f.engine, f.rule), f.file, f.line);
    const entry = findEntry(file, fingerprint);
    if (!entry) continue;
    if (!isEntryActive(entry)) {
      skippedExpired++;
      continue;
    }
    const key = `${f.rule}\0${f.file}`;
    if (seenRulePath.has(key)) continue;
    seenRulePath.add(key);
    ignores.push({
      ruleId: f.rule,
      path: f.file,
      reason: entry.reason,
      expires: expiryToSnykDatetime(entry.expiresAt),
      created,
    });
  }

  const outPath = path.resolve(cwd, opts.out ?? '.snyk');
  const policy = buildSnykPolicy(ignores);
  fs.writeFileSync(outPath, policy, 'utf8');

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ out: outPath, ignores: ignores.length, skippedExpired }, null, 2) + '\n',
    );
    return;
  }

  if (ignores.length === 0) {
    logger.info(
      `No Snyk-originated findings are allowlisted — wrote an empty policy to ${outPath}.` +
        (skippedExpired > 0
          ? ` (${skippedExpired} expired entr${skippedExpired === 1 ? 'y' : 'ies'} skipped.)`
          : ''),
    );
    return;
  }
  logger.success(
    `Wrote ${ignores.length} Snyk ignore${ignores.length === 1 ? '' : 's'} to ${outPath}` +
      (skippedExpired > 0 ? ` (${skippedExpired} expired skipped)` : '') +
      '.',
  );
  logger.dim(
    '  Note: Snyk Code (SAST) honors .snyk ignores only with the "consistent ignores" ' +
      'feature enabled for your org; SCA/dependency ignores are standard.',
  );
}

// ─── Internals ────────────────────────────────────────────────────────────

function isAllowlistSubcommand(value: string): value is AllowlistSubcommand {
  return (ALLOWLIST_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Build the set of fingerprints present in the committed baseline —
 * the union of every entry's `id` plus its `absorbedFingerprints`.
 * The absorbed set matters: cross-tool dedup collapses several
 * findings into one representative, and an allowlist entry keyed on a
 * collapsed contributor still suppresses the merged finding (CLAUDE.md
 * Rule 9 robust matching). Including absorbed fingerprints here keeps
 * such entries OUT of the orphaned bucket.
 *
 * Returns `undefined` when no baseline exists on disk (the caller
 * renders a steer-to-CI notice rather than reporting false orphans).
 */
function baselineFingerprintSet(
  cwd: string,
  name: string | undefined,
): ReadonlySet<string> | undefined {
  const baselinePath = pathForBaseline(cwd, name ?? DEFAULT_BASELINE_NAME);
  if (!fs.existsSync(baselinePath)) return undefined;
  const baseline = readBaselineFile(baselinePath);
  const set = new Set<string>();
  for (const entry of baseline.findings) {
    set.add(entry.id);
    if ('absorbedFingerprints' in entry && entry.absorbedFingerprints) {
      for (const fp of entry.absorbedFingerprints) set.add(fp);
    }
  }
  return set;
}

function parseCategory(raw: string | undefined): AllowlistCategory {
  if (!raw) {
    logger.fail(`--category is required. One of: ${ALL_CATEGORIES.join(', ')}.`);
    process.exit(1);
  }
  if (!(ALL_CATEGORIES as readonly string[]).includes(raw)) {
    logger.fail(
      `--category ${JSON.stringify(raw)} is not a known category. ` +
        `One of: ${ALL_CATEGORIES.join(', ')}.`,
    );
    process.exit(1);
  }
  return raw as AllowlistCategory;
}

const VALID_SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

function parseSeverityOpt(raw: string | undefined): FindingSeverity | undefined {
  if (raw === undefined) return undefined;
  if (!(VALID_SEVERITIES as readonly string[]).includes(raw)) {
    logger.fail(
      `--acknowledged-severity ${JSON.stringify(raw)} is not a known severity. ` +
        `One of: ${VALID_SEVERITIES.join(', ')}.`,
    );
    process.exit(1);
  }
  return raw as FindingSeverity;
}

function resolveExpiresAt(
  raw: string | undefined,
  category: AllowlistCategory,
): string | undefined {
  if (raw !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      logger.fail(`--expires must be ISO date YYYY-MM-DD; got ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    return raw;
  }
  if (requiresExpiry(category)) {
    // Default to DEFAULT_EXPIRY_DAYS from today
    return defaultExpiryDate(new Date());
  }
  return undefined;
}

function resolveMode(cwd: string, override: AllowlistMode | undefined): AllowlistMode {
  if (override !== undefined) {
    if (!(ALL_MODES as readonly string[]).includes(override)) {
      logger.fail(
        `--mode ${JSON.stringify(override)} is not a known mode. ` +
          `One of: ${ALL_MODES.join(', ')}.`,
      );
      process.exit(1);
    }
    return override;
  }
  const existing = loadAllowlist(cwd);
  return existing?.mode ?? 'full';
}

function resolveGitUserEmail(cwd: string): string | undefined {
  try {
    const out = execSync('git config --get user.email', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function inferLanguage(file: string): LanguageSupport | undefined {
  const ext = path.extname(file).toLowerCase();
  if (!ext) return undefined;
  for (const lang of LANGUAGES) {
    if (lang.sourceExtensions.includes(ext)) return lang;
  }
  return undefined;
}

function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// DEFAULT_EXPIRY_DAYS exported for callers that want to surface the
// default in user-facing messages (e.g., the skill).
export { DEFAULT_EXPIRY_DAYS };
// ALLOWLIST_FILENAME exported for downstream tests + callers that
// want to reference the canonical filename without re-importing.
export { ALLOWLIST_FILENAME };
