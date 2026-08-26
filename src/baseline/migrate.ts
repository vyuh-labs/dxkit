/**
 * Identity-scheme migrator — carries a repo's baseline + allowlist across
 * a finding-identity scheme change so an upgrade is a single command
 * instead of a manual re-baseline + re-allowlist.
 *
 * The mechanism rests on two properties:
 *
 *   1. `identityFor` can compute ANY shipped scheme (see
 *      `finding-identity.ts`), so for each current finding we can derive
 *      both its OLD-scheme id and its NEW-scheme id.
 *   2. A current scan's baseline entries already carry the NEW (current)
 *      scheme id; recomputing the OLD id from each entry's metadata yields
 *      an `old → new` remap built from one scan, with no dependency on the
 *      stale artifact's stored ids.
 *
 * From that remap we:
 *   - rewrite the allowlist's `fingerprint`s onto the new scheme
 *     (preserving every reviewed suppression decision), and
 *   - regenerate the baseline with fresh new-scheme ids.
 *
 * Allowlist entries whose fingerprint matches neither the remap NOR a
 * current finding's id are surfaced as `unmapped` (the finding they
 * suppressed is gone — already-stale entries), never silently dropped.
 *
 * This is general across schemes: only the version-VARYING finding kinds
 * change id between two schemes (everything else maps to itself and is
 * left untouched), and `identityFor` + the retained prior-scheme id
 * functions handle any `from → to` pair. A future scheme needs no new
 * wiring here.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { createBaseline, gatherCurrentScan } from './create';
import { pathForBaseline, readBaselineFile, writeBaselineFile } from './baseline-file';
import { restampAtCommit } from './content-stamp';
import { entryToLocated } from './entry-to-located';
import type { BaselineFile } from './baseline-file';
import { identityFor } from './finding-identity';
import { RECALL_EPOCHS } from './recall';
import { isSanitized } from './sanitize';
import { CURRENT_IDENTITY_SCHEME } from './types';
import type {
  BaselineEntry,
  IdentityInput,
  IdentitySchemeVersion,
  RichBaselineEntry,
} from './types';
import { loadAllowlist, saveAllowlist } from '../allowlist/file';
import type { AllowlistEntry } from '../allowlist/file';
import { trustedLocalContext } from '../analysis-trust';

export interface MigrationResult {
  readonly fromScheme: IdentitySchemeVersion;
  readonly toScheme: IdentitySchemeVersion;
  /** Number of `old → new` id pairs whose id actually changed between the
   *  two schemes (version-independent kinds are excluded). */
  readonly remapSize: number;
  readonly allowlistTotal: number;
  /** Allowlist entries whose fingerprint was rewritten onto the new scheme. */
  readonly allowlistRemapped: number;
  /** Allowlist entries left unchanged because they already match a current
   *  finding under the new scheme (version-independent kinds / already
   *  current) — not a problem. */
  readonly allowlistUnchanged: number;
  /** Allowlist entries that match no current finding at all — the finding
   *  they suppressed is gone (already-stale). Surfaced for review. */
  readonly allowlistUnmapped: ReadonlyArray<AllowlistEntry>;
  /** Path of the regenerated baseline, or null when none was written
   *  (e.g. ref-based repos hold no committed baseline). */
  readonly baselinePath: string | null;
}

/**
 * Reconstruct the `IdentityInput` a baseline entry was minted from, so its
 * id can be recomputed under a different scheme. Fidelity is sufficient to
 * reproduce any scheme's id: `contentAnchor` is intentionally omitted —
 * only the v2 code/secret path consumes it, and an entry's stored `id`
 * already IS its current-scheme id (we never recompute the current id, only
 * the prior one, which no scheme derives from the anchor). Returns
 * `undefined` for sanitized entries (identity-only, no metadata).
 */
export function baselineEntryToIdentityInput(entry: BaselineEntry): IdentityInput | undefined {
  if (isSanitized(entry)) return undefined;
  const e = entry as RichBaselineEntry;
  switch (e.kind) {
    case 'secret':
    case 'code':
    case 'config':
      return { kind: e.kind, tool: e.tool, rule: e.rule, file: e.file, line: e.line };
    case 'dep-vuln':
      return {
        kind: 'dep-vuln',
        package: e.package,
        installedVersion: e.installedVersion,
        id: e.advisoryId,
      };
    case 'duplication':
      return {
        kind: 'duplication',
        fileA: e.fileA,
        fileB: e.fileB,
        lines: e.lines,
        startLineA: e.startLineA,
        startLineB: e.startLineB,
      };
    case 'coverage-gap':
      return { kind: 'coverage-gap', file: e.file, symbol: e.symbol, lineRange: e.lineRange };
    case 'test-gap':
      return { kind: 'test-gap', file: e.file, risk: e.risk };
    case 'hygiene':
      return { kind: 'hygiene', file: e.file, line: e.line, marker: e.marker };
    case 'test-file-degradation':
      return { kind: 'test-file-degradation', file: e.file, status: e.status };
    case 'god-file':
      return { kind: 'god-file', file: e.file };
    case 'stale-file':
      return { kind: 'stale-file', file: e.file, suffix: e.suffix };
    case 'large-file':
      return { kind: 'large-file', file: e.file };
    case 'secret-hmac':
      return { kind: 'secret-hmac', tool: e.tool, rule: e.rule, hmac: e.hmac };
    case 'stale-allow':
      return { kind: 'stale-allow', file: e.file, line: e.line, category: e.category };
    case 'flow-binding':
      // Line is display-only metadata on the entry, never an identity input.
      return { kind: 'flow-binding', method: e.method, path: e.path, file: e.file };
    case 'model-schema-drift':
      // from/to/file/line are display-only metadata; identity is the triple.
      return {
        kind: 'model-schema-drift',
        model: e.model,
        field: e.field,
        changeClass: e.changeClass,
      };
    case 'code-reimplementation':
      // `score` is display metadata; identity is the anchor pair.
      return { kind: 'code-reimplementation', anchors: e.anchors };
    case 'custom-check':
      // `blocking` + `message` are display/verdict metadata on the entry, never
      // identity inputs (Rule 9). File/line/rule reconstruct the located variant;
      // all absent for the binary variant.
      return {
        kind: 'custom-check',
        check: e.check,
        file: e.file,
        line: e.line,
        rule: e.rule,
      };
    case 'paired-change':
      // `blocking` + `message` are verdict/display metadata; identity is the
      // rule name alone.
      return { kind: 'paired-change', check: e.check };
    case 'broken-flow':
      // `missingSteps` is display metadata; identity is the flow id alone.
      return { kind: 'broken-flow', flow: e.flow };
    case 'license':
      // `version` is display metadata; identity is (package, licenseType).
      return { kind: 'license', package: e.package, licenseType: e.licenseType };
  }
}

/**
 * Build an `old → new` id remap from a current scan's entries. Each
 * entry's own `id` is the new (current) scheme id; the old id is
 * recomputed from its reconstructed input. Only ids that actually change
 * between the two schemes enter the map — version-independent kinds map to
 * themselves and are skipped. Pure.
 */
export function buildIdentityRemap(
  entries: ReadonlyArray<BaselineEntry>,
  from: IdentitySchemeVersion,
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const entry of entries) {
    const input = baselineEntryToIdentityInput(entry);
    if (!input) continue;
    // The migrator legitimately recomputes a prior-scheme id to build the
    // remap — it consumes identity, it doesn't mint a new finding kind.
    const fromId = identityFor(input, from); // rule10-producer-ok
    if (fromId !== entry.id) remap.set(fromId, entry.id);
  }
  return remap;
}

/**
 * Detect whether a repo's committed artifacts (baseline + allowlist) were
 * written under an OLDER identity scheme than the current one, returning
 * the scheme to migrate FROM (the OLDEST stale scheme found), or `null` when
 * everything is already current / there's nothing to migrate. A
 * lightweight probe — reads the stamped `identityScheme` (absent ⇒ `'v1'`)
 * without re-scanning. Used by `vyuh-dxkit update` to decide whether to
 * run the migrator after an upgrade.
 */
export function detectStaleScheme(
  cwd: string,
  baselineName = 'main',
): IdentitySchemeVersion | null {
  const found = new Set<IdentitySchemeVersion>();
  const blPath = pathForBaseline(cwd, baselineName);
  if (fs.existsSync(blPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(blPath, 'utf8')) as {
        identityScheme?: IdentitySchemeVersion;
      };
      found.add(raw.identityScheme ?? 'v1');
    } catch {
      /* unreadable baseline — leave migration to an explicit re-baseline */
    }
  }
  const allowlist = loadAllowlist(cwd);
  if (allowlist && allowlist.entries.length > 0) found.add(allowlist.identityScheme ?? 'v1');

  // Oldest stale scheme wins: a repo can only be migrated forward from the
  // furthest-behind artifact it holds. Generalized when v3 landed — the
  // v1-only check here was itself the "today only v1" hardcode this
  // function's contract warned about.
  const order: readonly IdentitySchemeVersion[] = ['v1', 'v2', 'v3'];
  for (const scheme of order) {
    if (scheme === CURRENT_IDENTITY_SCHEME) break;
    if (found.has(scheme)) return scheme;
  }
  return null;
}

/** Why a repo's baseline needs a recall refresh (CLAUDE.md Rule 19). */
export type StaleRecall =
  /** Written before recall attribution existed. dxkit cannot tell whether its
   *  findings are comparable to today's, so every kind degrades to warn. */
  | 'absent'
  /** dxkit changed what it observes for a kind since the baseline was
   *  captured (an epoch bump), so that kind degrades to warn. */
  | 'epoch-gap';

/** Why a content-hash restamp stamped nothing, when it did not. Every
 *  cause is disclosed by name; `null` when entries were stamped. */
export type RestampSkipCause =
  /** The baseline records a dirty capture (or predates the tree-state
   *  record): its line numbers describe a working tree, so the commit's
   *  content at those lines is not the finding's content. */
  | 'tree-unproven'
  /** The anchor commit is not in this clone (shallow, rewritten history). */
  | 'anchor-unreadable'
  /** The anchor is readable but every bare entry's file is not, at it. */
  | 'files-unreadable';

/** What a content-hash restamp did (see `restampContentHashes`). */
export interface RestampSummary {
  readonly restamped: number;
  readonly unreadable: number;
  /** Bare located entries the restamp was asked about. */
  readonly bare: number;
  readonly skipped: RestampSkipCause | null;
}

/** Bare located entries: the only ones a restamp could touch. Cheap (no
 *  git), so the update lane can tell "nothing eligible" apart from "could
 *  not run" without a per-file sweep. */
function countBareLocated(entries: readonly BaselineEntry[]): number {
  let n = 0;
  for (const entry of entries) {
    if ('contentHash' in entry && entry.contentHash !== undefined) continue;
    const loc = entryToLocated(entry);
    if (loc.file !== undefined && loc.line !== undefined && loc.line > 0) n += 1;
  }
  return n;
}

function commitReadable(cwd: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restamp a pre-scheme baseline's located entries with content hashes.
 *
 * A baseline written before the 4.4.5 stamp scheme has located entries with
 * no `contentHash`, so the matcher's content pass (the one that survives a
 * whole-file reformat) is silently unavailable until the next refresh. The
 * fix needs no rescan: the baseline's line numbers describe the tree at its
 * anchor commit, so the files can be read AT THAT COMMIT and hashed
 * (`restampAtCommit` — the migrate lane is the one commit-read call site).
 * Rides `vyuh-dxkit update` beside the scheme/recall probes; returns null
 * when there is nothing to do (no baseline, nothing bare, no recorded
 * anchor). The commit read is only sound when the baseline PROVES it was
 * captured on a clean tree at that commit (`repo.treeState === 'clean'`):
 * a dirty capture's line numbers describe the working tree, and hashing
 * the commit at those lines would stamp a wrong hash that every later
 * stamper preserves. Cleanliness unproven, anchor unreadable: nothing is
 * written and the cause is named, without the per-file sweep. Files
 * unreadable at the anchor leave their entries bare, disclosed via the
 * summary, never a throw.
 */
export function restampContentHashes(cwd: string, baselineName = 'main'): RestampSummary | null {
  const blPath = pathForBaseline(cwd, baselineName);
  if (!fs.existsSync(blPath)) return null;
  let file: BaselineFile;
  try {
    file = readBaselineFile(blPath);
  } catch {
    return null;
  }
  const sha = file.repo?.commitSha;
  if (!sha) return null;
  const bare = countBareLocated(file.findings);
  if (bare === 0) return null;
  if (file.repo?.treeState !== 'clean') {
    return { restamped: 0, unreadable: 0, bare, skipped: 'tree-unproven' };
  }
  if (!commitReadable(cwd, sha)) {
    return { restamped: 0, unreadable: 0, bare, skipped: 'anchor-unreadable' };
  }
  const result = restampAtCommit(file.findings, cwd, sha);
  if (result.restamped > 0) {
    writeBaselineFile(blPath, { ...file, findings: result.entries });
    return { restamped: result.restamped, unreadable: result.unreadable, bare, skipped: null };
  }
  // Nothing written, but the caller must SAY why. Silence here would read
  // as "reformat-tolerant matching is active".
  return { restamped: 0, unreadable: result.unreadable, bare, skipped: 'files-unreadable' };
}

/**
 * Detect whether a repo's committed baseline predates the current recall
 * contract (Rule 19), returning WHY or `null` when it is current.
 *
 * A lightweight probe: reads the stamped `recall` map without re-scanning,
 * mirroring `detectStaleScheme`. Used by `vyuh-dxkit update` to decide whether
 * a refresh is owed.
 *
 * The asymmetry with identity migration is load-bearing. An identity-scheme
 * bump changes how a finding is HASHED, so it migrates OFFLINE by recomputing
 * ids from stored metadata. A recall bump changes what dxkit can SEE, and
 * nothing stored can tell you what a scanner you never ran would have found —
 * so the only honest migration is a RESCAN, which needs the toolchain present.
 * That is why this returns a reason instead of a remap.
 */
export function detectStaleRecall(cwd: string, baselineName = 'main'): StaleRecall | null {
  const blPath = pathForBaseline(cwd, baselineName);
  if (!fs.existsSync(blPath)) return null; // ref-based / no committed baseline
  let file: BaselineFile;
  try {
    file = readBaselineFile(blPath);
  } catch {
    return null; // unreadable — leave it to an explicit re-baseline
  }
  if (!file.recall) return 'absent';

  // An epoch gap only matters for kinds the baseline actually holds findings
  // for: a kind with nothing recorded has nothing to misattribute, so forcing
  // a rescan over it would be churn with no signal.
  const kinds = new Set(file.findings.map((e) => e.kind));
  for (const kind of kinds) {
    const recorded = file.recall[kind];
    if (!recorded) return 'absent';
    if (recorded.epoch !== RECALL_EPOCHS[kind]) return 'epoch-gap';
  }
  return null;
}

/**
 * Migrate a repo's baseline + allowlist from `from` scheme to the current
 * scheme: one scan, rewrite the allowlist through the remap, regenerate
 * the baseline (only if one exists). Idempotent in spirit — running it
 * when already current produces an empty remap and a re-stamped baseline.
 * Returns a summary the caller renders.
 */
export async function migrateIdentity(opts: {
  readonly cwd: string;
  readonly from: IdentitySchemeVersion;
  readonly baselineName?: string;
  readonly verbose?: boolean;
}): Promise<MigrationResult> {
  const { cwd } = opts;
  const to = CURRENT_IDENTITY_SCHEME;

  // One scan: entries carry the new-scheme ids; the remap recomputes the
  // old id per entry.
  const scan = await gatherCurrentScan({
    cwd,
    trust: trustedLocalContext(),
    verbose: opts.verbose,
  });
  const remap = buildIdentityRemap(scan.findings, opts.from);
  const currentIds = new Set(scan.findings.map((f) => f.id));

  // Rewrite the allowlist, preserving reviewed decisions.
  const allowlist = loadAllowlist(cwd);
  let remapped = 0;
  let unchanged = 0;
  const unmapped: AllowlistEntry[] = [];
  if (allowlist) {
    const entries = allowlist.entries.map((entry) => {
      const next = remap.get(entry.fingerprint);
      if (next !== undefined) {
        remapped++;
        return { ...entry, fingerprint: next };
      }
      // Not in the remap: either it already matches a current finding
      // (version-independent kind / already current scheme) — leave it —
      // or it matches nothing (the suppressed finding is gone) — flag it.
      if (currentIds.has(entry.fingerprint)) unchanged++;
      else unmapped.push(entry);
      return entry;
    });
    saveAllowlist(cwd, { ...allowlist, identityScheme: to, entries });
  }

  // Regenerate the baseline with fresh new-scheme ids + stamped scheme —
  // but only if one already exists. A repo with no committed baseline
  // (ref-based posture) shouldn't gain one as a side effect of migrating;
  // its allowlist still gets remapped above.
  const baselineName = opts.baselineName ?? 'main';
  const hasBaseline = fs.existsSync(pathForBaseline(cwd, baselineName));
  const created = hasBaseline
    ? await createBaseline({ cwd, name: baselineName, force: true, verbose: opts.verbose })
    : null;

  return {
    fromScheme: opts.from,
    toScheme: to,
    remapSize: remap.size,
    allowlistTotal: allowlist?.entries.length ?? 0,
    allowlistRemapped: remapped,
    allowlistUnchanged: unchanged,
    allowlistUnmapped: unmapped,
    baselinePath: created?.path ?? null,
  };
}
