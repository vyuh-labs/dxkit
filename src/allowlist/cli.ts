/**
 * `vyuh-dxkit allowlist <subcommand>` — orchestrates the user-facing
 * write/read paths over the allowlist module.
 *
 * Subcommands (Sprint 1 chunk):
 *
 * - `add <file>:<line>` — inline annotation insertion. Kind-agnostic;
 * the annotation grammar carries category + reason only. Refuses
 * non-inline-compatible categories (accepted-risk / deferred).
 *
 * - `add --fingerprint=<id> --kind=<kind>` — file-level allowlist
 * entry. Persists to `.dxkit/allowlist.json` (or its sanitized
 * mode + gitignored reasons sidecar). Required for any
 * accepted-risk / deferred suppression OR any kind that lacks a
 * stable single-line attachment point.
 *
 * - `list` — print every entry across the file-level allowlist.
 * Reads only; no mutation. Honors `--json` for structured output.
 *
 * - `defer [<fp>…] [--from-last-check]` — time-boxed deferral of blocking
 * findings (any kind by explicit fingerprint; `--from-last-check` bulk-sweeps
 * dependency advisories only). Short default expiry.
 *
 * - `show <fingerprint>` — print one entry's full detail. Falls
 * back to a "no entry found" message when the fingerprint isn't
 * present.
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
import { dxkitCli } from '../self-invocation';
import * as path from 'path';
import { execSync } from 'child_process';
import * as logger from '../logger';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
} from '../baseline/baseline-file';
import {
  canonicalRuleFor,
  codeContentAnchorFromHash,
  computeCodeFingerprint,
  computeContentFingerprint,
} from '../analyzers/tools/fingerprint';
import { buildEnclosingScopeMap, locationKey } from '../explore/finding-context';
import { readAllSnapshots } from '../ingest/snapshot';
import {
  buildSnykPolicy,
  dxkitIgnoreLinesToSnykExcludes,
  expiryToSnykDatetime,
  type SnykIgnore,
} from '../ingest/snyk-policy';
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
import { executeDefer, parseDeferExpiry } from './defer-core';
import { runCommentDefer } from './comment-defer';
import {
  ALLOWLIST_FILENAME,
  ALL_MODES,
  SOON_TO_EXPIRE_DAYS,
  addEntry,
  auditAllowlist,
  daysUntilDate,
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
  'defer',
  'comment-defer',
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
   * bare file path for file-level form (requires `--fingerprint`
   * + `--kind`). */
  readonly target?: string;
  readonly category?: string;
  readonly reason?: string;
  readonly kind?: string;
  readonly fingerprint?: string;
  /** Batch form: comma-separated fingerprint list sharing one kind /
   *  category / reason — one review decision covering a finding family
   *  (e.g. N by-design parallels in one bindings module) lands in one
   *  invocation. Each fingerprint still gets its own auditable entry. */
  readonly fingerprints?: string;
  /** Batch form: read fingerprints line-wise from stdin, so a guardrail
   *  output pipe can feed the add directly. */
  readonly fromStdin?: boolean;
  readonly expires?: string;
  readonly acknowledgedSeverity?: string;
  readonly addedBy?: string;
  /** Override the configured mode for this write only. Default
   * reads from `.dxkit/policy.json` (out of scope here; this
   * module accepts a flag to choose). */
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
   * audit can flag orphaned entries (suppress nothing in the current
   * finding set). Off by default — keeps `audit` a pure read of the
   * allowlist file unless the user opts in. */
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
   * injectable for deterministic tests. */
  readonly now?: string;
}

export interface AllowlistPruneOpts {
  readonly json?: boolean;
  /** Don't write; just print what would be removed. */
  readonly dryRun?: boolean;
  /** Skip confirmation prompt + write directly. Default behavior
   * in Sprint 1 (no interactive prompts in dxkit yet) — the flag
   * is accepted for future-proofing. */
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
    /** ALL positionals after the subcommand — `defer` takes a repeated
     *  fingerprint list. Falls back to `[positionalAfter]` when absent. */
    positionalsAfter?: readonly string[];
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
        fingerprints: args.values.fingerprints as string | undefined,
        fromStdin: !!args.values['from-stdin'],
        expires: args.values.expires as string | undefined,
        acknowledgedSeverity: args.values['acknowledged-severity'] as string | undefined,
        addedBy: args.values['added-by'] as string | undefined,
        mode: args.values.mode as AllowlistMode | undefined,
      });
    case 'defer':
      return runAllowlistDefer(cwd, {
        fingerprints: args.positionalsAfter ?? (args.positionalAfter ? [args.positionalAfter] : []),
        fromLastCheck: !!args.values['from-last-check'],
        reason: args.values.reason as string | undefined,
        expires: args.values.expires as string | undefined,
        addedBy: args.values['added-by'] as string | undefined,
        mode: args.values.mode as AllowlistMode | undefined,
        json: !!args.values.json,
      });
    case 'comment-defer':
      // The PR-comment lane's runner half. Input comes ONLY from the
      // DXKIT_COMMENT_* environment (the workflow's safe transport for
      // untrusted comment text) — deliberately no argv inputs.
      return runCommentDefer(cwd);
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
  // - `<file>:<line>` → inline (category must be inline-compatible)
  // - `--fingerprint=<id> --kind=<kind>` → file-level
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

  // Force SAME-LINE insertion (append to the finding's own line) so the write
  // never shifts subsequent line numbers. An above-line insert pushes every later
  // line down by one, so a second `allowlist add <file>:<line>` in the same file —
  // using line numbers from the pre-insert scan — would land one line off and
  // suppress nothing (the s24 batch line-shift bug). Same-line never shifts, so
  // sequential/batched adds all land on their real finding regardless of order.
  const result = insertAnnotation(absPath, target.line, { category, reason }, lang, {
    sameLineThreshold: Number.MAX_SAFE_INTEGER,
  });
  logger.info(
    `Inserted ${result.position} allowlist annotation at ${target.file}:${result.annotationLine} ` +
      `(category=${category})`,
  );
}

/** The add target set: `--fingerprint`, `--fingerprints=a,b,c`, and
 *  `--from-stdin` (line-wise) combined and deduplicated. More than one =
 *  batch semantics (one review decision covering a finding family — each
 *  fingerprint still gets its own auditable entry). */
function collectAddFingerprints(opts: AllowlistAddOpts): string[] {
  const out: string[] = [];
  if (opts.fingerprint?.trim()) out.push(opts.fingerprint.trim());
  if (opts.fingerprints) {
    for (const fp of opts.fingerprints.split(',')) {
      if (fp.trim()) out.push(fp.trim());
    }
  }
  if (opts.fromStdin) {
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch {
      /* no stdin available — contributes nothing */
    }
    for (const line of raw.split('\n')) {
      if (line.trim()) out.push(line.trim());
    }
  }
  return [...new Set(out)];
}

async function runAddFileLevel(args: {
  cwd: string;
  opts: AllowlistAddOpts;
  category: AllowlistCategory;
  reason: string;
}): Promise<void> {
  const { cwd, opts, category, reason } = args;
  const fingerprints = collectAddFingerprints(opts);
  const kindRaw = opts.kind?.trim();
  if (fingerprints.length === 0 || !kindRaw) {
    logger.fail(
      `file-level allowlist entry requires --fingerprint=<16-hex> (or --fingerprints=<id,id,…> ` +
        `/ --from-stdin for a batch) and --kind=<kind> ` +
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
  const batch = fingerprints.length > 1;

  // Resolve effective mode (CLI override → existing file mode → default 'full').
  const mode = resolveMode(cwd, opts.mode);

  // Build + validate EVERY entry before any write — a batch either passes
  // validation whole or writes nothing.
  const entries: AllowlistEntry[] = fingerprints.map((fingerprint) => ({
    fingerprint,
    kind,
    category,
    reason,
    addedBy,
    addedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(acknowledgedSeverity !== undefined ? { acknowledgedSeverity } : {}),
  }));
  for (const entry of entries) {
    const validationErrors = validateAllowlistEntry(entry, mode);
    if (validationErrors.length > 0) {
      logger.fail(`allowlist entry for fingerprint ${entry.fingerprint} failed validation:`);
      for (const e of validationErrors) {
        logger.fail(` - ${e.field}: ${e.message}`);
      }
      process.exit(1);
    }
  }

  const existing = loadAllowlist(cwd) ?? emptyAllowlistFile(mode);
  const alreadyPresent = entries.filter((e) => findEntry(existing, e.fingerprint));
  if (alreadyPresent.length > 0 && !batch) {
    // Single-fingerprint form keeps its hard failure — an accidental re-add
    // should stop and point at the existing entry.
    const fp = alreadyPresent[0].fingerprint;
    logger.fail(
      `allowlist already contains entry for fingerprint ${fp}. ` +
        `Run \`vyuh-dxkit allowlist show ${fp}\` to inspect, or remove first.`,
    );
    process.exit(1);
  }
  const presentSet = new Set(alreadyPresent.map((e) => e.fingerprint));
  const toAdd = entries.filter((e) => !presentSet.has(e.fingerprint));

  let updated: AllowlistFile = existing;
  for (const entry of toAdd) updated = addEntry(updated, entry);
  updated = { ...updated, mode };
  if (toAdd.length > 0) saveAllowlist(cwd, updated);

  if (!batch) {
    logger.info(
      `Added allowlist entry for fingerprint ${fingerprints[0]} (kind=${kind}, category=${category})` +
        (expiresAt ? `, expires ${expiresAt}` : ''),
    );
    return;
  }
  if (toAdd.length > 0) {
    logger.success(
      `Added ${toAdd.length} allowlist entr${toAdd.length === 1 ? 'y' : 'ies'} ` +
        `(kind=${kind}, category=${category}${expiresAt ? `, expires ${expiresAt}` : ''}).`,
    );
    for (const e of toAdd) logger.info(`  ${e.fingerprint}`);
  } else {
    logger.info('All fingerprints already have allowlist entries — nothing written.');
  }
  if (alreadyPresent.length > 0 && toAdd.length > 0) {
    logger.info(`Skipped ${alreadyPresent.length} fingerprint(s) already allowlisted.`);
  }
}

// ─── defer ────────────────────────────────────────────────────────────────

export interface AllowlistDeferOpts {
  /** Explicit fingerprints (positional, repeated). */
  readonly fingerprints?: readonly string[];
  /** Pull the blocking dep-vulns from the last same-tree guardrail run's
   *  verdict cache. */
  readonly fromLastCheck?: boolean;
  readonly reason?: string;
  /** ISO `YYYY-MM-DD`, or relative `+Nd`. Default: `+7d`
   *  (`DEFER_ADVISORY_EXPIRY_DAYS`). */
  readonly expires?: string;
  readonly addedBy?: string;
  readonly mode?: AllowlistMode;
  readonly json?: boolean;
}

/**
 * `vyuh-dxkit allowlist defer` — time-boxed deferral of blocking findings.
 * One command adds `category=deferred` entries with a SHORT shared expiry for
 * an explicit fingerprint list (any blocking kind — the repo's owners hold
 * the policy; see the core's header for the boundary argument) or the
 * blocking dep-vulns of the last same-tree guardrail run
 * (`--from-last-check`, the advisory bulk lane).
 *
 * The honesty mechanics, kept regardless of kind:
 *   - each entry is kind-stamped from the verdict cache — suppression matches
 *     on kind, so a deferred fingerprint waives exactly the finding it names;
 *   - `--from-last-check` sweeps ONLY dependency advisories (the one class
 *     that arrives in batches through no fault of the diff) and names
 *     anything it left blocking — a bulk sweep must not silently absorb a
 *     net-new secret standing next to the advisories;
 *   - the expiry is required-by-category and defaults SHORT
 *     (`DEFER_ADVISORY_EXPIRY_DAYS` days) — the window is the forcing
 *     function back into the fix lane.
 */
export async function runAllowlistDefer(cwd: string, opts: AllowlistDeferOpts): Promise<void> {
  // The defer LOGIC lives in the one core (`executeDefer` — shared with the
  // PR-comment lane); this wrapper only resolves CLI defaults and renders.
  const result = executeDefer(cwd, {
    ...(opts.fingerprints !== undefined ? { fingerprints: opts.fingerprints } : {}),
    ...(opts.fromLastCheck !== undefined ? { fromLastCheck: opts.fromLastCheck } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
    addedBy: opts.addedBy?.trim() || resolveGitUserEmail(cwd) || '',
    mode: resolveMode(cwd, opts.mode),
  });
  if (!result.ok) {
    logger.fail(result.message);
    process.exit(1);
  }
  const { added, alreadyPresent, leftBlocking, expiresAt, reason, targets, advisories } = result;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { added, alreadyPresent, leftBlocking, expiresAt, reason, advisories },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (added.length === 0) {
    logger.info(
      alreadyPresent.length > 0
        ? `All ${alreadyPresent.length} fingerprint(s) already have allowlist entries — nothing written.`
        : 'Nothing to defer.',
    );
  } else {
    logger.success(
      `Deferred ${added.length} finding${added.length === 1 ? '' : 's'} ` +
        `(category=deferred, expires ${expiresAt}).`,
    );
    for (const fp of added) {
      const meta = targets.get(fp);
      const kind = meta?.kind ? `[${meta.kind}] ` : '';
      logger.info(`  ${fp}  ${kind}${meta?.locator ?? ''}`.trimEnd());
    }
    logger.info(
      `  Commit .dxkit/allowlist.json (via your PR) — the expiry re-blocks these in ` +
        `${daysUntil(expiresAt)} day(s), so plan the fix now.`,
    );
    // The creation guard: what this window will and will not get you. Warned
    // rather than info'd — these are the facts a caller most needs to have read.
    for (const a of advisories) logger.warn(`  ${a}`);
  }
  if (alreadyPresent.length > 0) {
    logger.info(`Skipped ${alreadyPresent.length} fingerprint(s) already allowlisted.`);
  }
  if (leftBlocking.length > 0) {
    logger.warn(
      `Left blocking (--from-last-check sweeps only dependency advisories; defer these ` +
        `explicitly by fingerprint): ${leftBlocking.join('; ')}`,
    );
  }
}

/** Whole days from today (UTC) to an ISO date — for the defer summary line.
 *  Delegates to the ONE day-math home; the clamp is display-only (a defer
 *  window is always in the future, so it never fires in practice). */
function daysUntil(iso: string): number {
  return Math.max(0, daysUntilDate(iso));
}

// ─── list ─────────────────────────────────────────────────────────────────

export async function runAllowlistList(cwd: string, opts: AllowlistListOpts): Promise<void> {
  const file = loadAllowlist(cwd);
  if (opts.json) {
    process.stdout.write(JSON.stringify(file ?? emptyAllowlistFile('full'), null, 2) + '\n');
    return;
  }

  if (!file || file.entries.length === 0) {
    logger.info(`No allowlist entries. Run \`${dxkitCli('allowlist add')}\` to create one.`);
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
      ` ${entry.fingerprint} ${entry.kind}/${entry.category}` +
        ` (added ${entry.addedAt}${expires})${reasonPreview}`,
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
  logger.info(`Fingerprint: ${entry.fingerprint}`);
  logger.info(`Kind: ${entry.kind}`);
  logger.info(`Category: ${entry.category}`);
  logger.info(`Added at: ${entry.addedAt}`);
  if (entry.addedBy) logger.info(`Added by: ${entry.addedBy}`);
  if (entry.expiresAt) logger.info(`Expires at: ${entry.expiresAt}`);
  if (entry.acknowledgedSeverity) {
    logger.info(`Acknowledged sev.: ${entry.acknowledgedSeverity}`);
  }
  if (entry.reason) logger.info(`Reason: ${entry.reason}`);
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
  const horizon = opts.soonToExpireDays ?? SOON_TO_EXPIRE_DAYS;
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
      logger.info(` ${e.fingerprint} ${e.kind}/${e.category} expired ${e.expiresAt}`);
    }
  }

  if (report.soonToExpire.length > 0) {
    logger.warn(
      `Soon to expire (${report.soonToExpire.length}; within ${horizon} days) — review or extend:`,
    );
    for (const { entry, daysRemaining } of report.soonToExpire) {
      logger.info(
        ` ${entry.fingerprint} ${entry.kind}/${entry.category}` +
          ` expires ${entry.expiresAt} (in ${daysRemaining}d)`,
      );
    }
  }

  if (report.missingRationale.length > 0) {
    logger.warn(
      `Missing rationale (${report.missingRationale.length}) — ` +
        `add a reason or sync the gitignored reasons sidecar:`,
    );
    for (const e of report.missingRationale) {
      logger.info(` ${e.fingerprint} ${e.kind}/${e.category}`);
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
      logger.info(` ${e.fingerprint} ${e.kind}/${e.category}${reasonPreview}`);
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
    logger.info(` ${e.fingerprint} ${e.kind}/${e.category} expired ${e.expiresAt}`);
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
 *
 * 2.10 also syncs the PATH-EXCLUSION half: `.dxkit-ignore` patterns
 * (the paths dxkit's own analyzers skip) are emitted into the `.snyk`
 * `exclude.global` block, so Snyk and dxkit agree on what's out of
 * scope. The two halves compose into one `.snyk`; an export carrying
 * only exclusions (no allowlisted Snyk findings yet) still writes.
 */
export async function runAllowlistExport(cwd: string, opts: AllowlistExportOpts): Promise<void> {
  if (!opts.snyk) {
    logger.fail(`allowlist export currently supports only --snyk. Usage: allowlist export --snyk`);
    process.exit(1);
  }

  // Path-exclusion half of the sync: `.dxkit-ignore` → Snyk
  // `exclude.global`. Independent of allowlist findings, so it's read up
  // front and can carry an export even when no Snyk findings are
  // allowlisted (the two halves compose into one `.snyk`).
  const excludes = readDxkitIgnoreExcludes(cwd);

  const file = loadAllowlist(cwd);
  const snapshots = readAllSnapshots(cwd).filter((f) => f.engine === 'snyk-code');

  // Recompute each Snyk finding's canonical fingerprint and match it to
  // an active allowlist entry. Dedup (rule, path) so several findings on
  // the same rule+path collapse to one ignore directive.
  const created = opts.now ?? new Date().toISOString();
  const ignores: SnykIgnore[] = [];
  const seenRulePath = new Set<string>();
  let skippedExpired = 0;
  if (file && file.entries.length > 0) {
    // Recompute each ingested finding's CONTENT fingerprint exactly as the
    // security aggregator does: the enclosing-symbol scope (graph
    // pre-pass) + the spanHash carried on the snapshot + an in-bucket
    // ordinal. Falls back to the line fingerprint when no span was captured
    // — which is also what the aggregator does, so anchorless findings
    // still match. (Ordinals are assigned over the ingested set; a native
    // finding sharing the same (file, scope, spanHash) bucket would need to
    // be cross-counted, but distinct engines never produce an identical
    // normalized span hash, so the ingested-only ordinal matches the
    // aggregator's in practice.)
    const scopeMap =
      buildEnclosingScopeMap(
        cwd,
        snapshots.map((f) => ({ file: f.file, line: f.line })),
      ) ?? {};
    const ordinalOf = new Map<(typeof snapshots)[number], number>();
    const buckets = new Map<string, typeof snapshots>();
    for (const f of snapshots) {
      if (f.spanHash === undefined) continue;
      const scope = scopeMap[locationKey(f.file, f.line)] ?? '';
      const key = `${f.file}\0${scope}\0${f.spanHash}`;
      const list = buckets.get(key) ?? [];
      list.push(f);
      buckets.set(key, list);
    }
    for (const list of buckets.values()) {
      list
        .slice()
        .sort((a, b) => a.line - b.line)
        .forEach((f, i) => ordinalOf.set(f, i));
    }
    const fingerprintOf = (f: (typeof snapshots)[number]): string => {
      const canonical = canonicalRuleFor(f.engine, f.rule);
      if (f.spanHash !== undefined) {
        const scope = scopeMap[locationKey(f.file, f.line)] ?? '';
        const anchor = codeContentAnchorFromHash(scope, f.spanHash, ordinalOf.get(f) ?? 0);
        return computeContentFingerprint(canonical, f.file, anchor);
      }
      return computeCodeFingerprint(canonical, f.file, f.line);
    };
    for (const f of snapshots) {
      const fingerprint = fingerprintOf(f);
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
  }

  // Bail only when there's nothing to act on at all: no usable allowlist
  // context (entries + ingested snapshots to match them against) AND no
  // path exclusions. When an allowlist+snapshots context exists we still
  // write — an empty policy + JSON is meaningful output (preserves the
  // pre-2.10 behavior the export tests pin).
  const hasAllowlistContext = !!file && file.entries.length > 0 && snapshots.length > 0;
  if (!hasAllowlistContext && excludes.length === 0) {
    if (!file || file.entries.length === 0) {
      logger.info(`No allowlist entries and no .dxkit-ignore exclusions — nothing to export.`);
    } else {
      logger.info(
        `No Snyk Code findings have been ingested yet and no .dxkit-ignore ` +
          `exclusions are present. Run \`vyuh-dxkit ingest --from-snyk\` first.`,
      );
    }
    return;
  }

  const outPath = path.resolve(cwd, opts.out ?? '.snyk');
  const policy = buildSnykPolicy(ignores, excludes);
  fs.writeFileSync(outPath, policy, 'utf8');

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { out: outPath, ignores: ignores.length, excludes: excludes.length, skippedExpired },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const parts: string[] = [];
  parts.push(`${ignores.length} Snyk ignore${ignores.length === 1 ? '' : 's'}`);
  if (excludes.length > 0) {
    parts.push(`${excludes.length} path exclusion${excludes.length === 1 ? '' : 's'}`);
  }
  logger.success(
    `Wrote ${parts.join(' + ')} to ${outPath}` +
      (skippedExpired > 0 ? ` (${skippedExpired} expired skipped)` : '') +
      '.',
  );
  logger.dim(
    ' Note: Snyk Code (SAST) honors .snyk ignores only with the "consistent ignores" ' +
      'feature enabled for your org; SCA/dependency ignores are standard.',
  );
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Read `.dxkit-ignore` (if present) and convert its patterns into Snyk
 * `exclude.global` globs. Returns [] when the file is absent or
 * unreadable — the exclusion sync is best-effort and never blocks an
 * allowlist export.
 */
function readDxkitIgnoreExcludes(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.dxkit-ignore'), 'utf8');
    return dxkitIgnoreLinesToSnykExcludes(raw.split('\n'));
  } catch {
    return [];
  }
}

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
    // Relative form (`+7d`) resolves through the ONE defer-expiry parser —
    // every rendered remedy line says `--expires=+7d`, so `add` must accept
    // exactly what `defer` accepts (this shipped divergent once: the paired
    // remedy named a flag shape `add` refused).
    if (/^\+\d+d$/.test(raw)) return parseDeferExpiry(raw)!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      logger.fail(
        `--expires must be ISO date YYYY-MM-DD or relative +Nd; got ${JSON.stringify(raw)}`,
      );
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
