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
import { createBaseline, gatherCurrentScan } from './create';
import { pathForBaseline, readBaselineFile } from './baseline-file';
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
 * the scheme to migrate FROM (today only `'v1'`), or `null` when
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

  if (found.has('v1') && CURRENT_IDENTITY_SCHEME !== 'v1') return 'v1';
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
  const scan = await gatherCurrentScan({ cwd, verbose: opts.verbose });
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
