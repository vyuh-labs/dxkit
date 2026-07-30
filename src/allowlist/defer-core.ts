/**
 * The ONE defer implementation (Rule 2). `allowlist defer` (the local CLI)
 * and `allowlist comment-defer` (the PR-comment lane) are two front-ends over
 * this core: parse/render differ, but what a deferral IS — category=deferred,
 * short shared expiry, kind read from the last verdict, idempotent — is
 * decided here once.
 *
 * ANY blocking finding is deferrable by explicit fingerprint (4.3.2). The
 * repo's owners hold the policy: a write-access reviewer could already land
 * the same entry by editing the allowlist file, so restricting the
 * convenience lane was friction, not a boundary. What the platform keeps is
 * the honesty mechanics — every deferral is time-boxed (expiry is the forcing
 * function), attributed, kind-stamped from the verdict cache so suppression
 * matches exactly one finding, and surfaced in the PR's allowlist delta.
 * `--from-last-check` stays scoped to dependency advisories: it is the bulk
 * lane for the one class that arrives in batches through no fault of the
 * diff (a feed publish), and a bulk sweep must not silently absorb a net-new
 * secret standing next to them — those are deferred one fingerprint at a
 * time, deliberately.
 *
 * Non-exiting by design: every refusal is a RETURNED value so the comment
 * lane can turn it into a reply instead of a dead process. The CLI wrapper
 * maps a refusal to `logger.fail` + exit(1), byte-compatible with the
 * pre-refactor behavior.
 */

import { dxkitCli } from '../self-invocation';
import { readVerdictForTree } from '../baseline/verdict-cache';
import {
  addEntry,
  daysUntilDate,
  emptyAllowlistFile,
  findEntry,
  loadAllowlist,
  saveAllowlist,
  validateAllowlistEntry,
  type AllowlistEntry,
  type AllowlistMode,
} from './file';
import { DEFER_ADVISORY_EXPIRY_DAYS, deferAdvisoryExpiryDate } from './categories';
import { deferAdvisories } from './defer-guard';

export interface DeferRequest {
  /** Explicit fingerprints (deduped by the core). */
  readonly fingerprints?: readonly string[];
  /** Pull the blocking dep-vulns from the last same-tree guardrail run. */
  readonly fromLastCheck?: boolean;
  /** Non-empty rationale. The core refuses a blank one. */
  readonly reason?: string;
  /** ISO `YYYY-MM-DD` or relative `+Nd`; default the short advisory window. */
  readonly expires?: string;
  /** Attribution; required (the caller resolves a default). */
  readonly addedBy?: string;
  /** Allowlist mode for a fresh file; resolved by the caller. */
  readonly mode: AllowlistMode;
}

export interface DeferOutcome {
  readonly ok: true;
  readonly added: readonly string[];
  readonly alreadyPresent: readonly string[];
  /** Creation-time advisories about the window just chosen (how many findings
   *  share it, whether any lane could close them, whether it shuts before the
   *  lane's next run). Facts, never a veto — see `defer-guard.ts`. Empty when
   *  there is nothing worth saying, and empty when nothing was written. BOTH
   *  front-ends render these; a new front-end inherits them from the core. */
  readonly advisories: readonly string[];
  /** Non-dep-vuln blockers `--from-last-check` left alone (the bulk lane is
   *  advisory-scoped; defer them explicitly by fingerprint), as
   *  `"<kind> <locator>"` strings. */
  readonly leftBlocking: readonly string[];
  readonly expiresAt: string;
  readonly reason: string;
  /** Kind/locator/severity display metadata for the added fingerprints. */
  readonly targets: ReadonlyMap<
    string,
    { kind?: AllowlistEntry['kind']; locator?: string; severity?: string }
  >;
}

export interface DeferRefusal {
  readonly ok: false;
  /** Human-facing refusal, ready for console or a reply comment. */
  readonly message: string;
}

export type DeferResult = DeferOutcome | DeferRefusal;

function refuse(message: string): DeferRefusal {
  return { ok: false, message };
}

/** Parse a defer expiry: ISO `YYYY-MM-DD` or relative `+Nd`. Null = invalid. */
export function parseDeferExpiry(raw: string | undefined, now = new Date()): string | null {
  if (raw === undefined) return deferAdvisoryExpiryDate(now);
  const rel = raw.match(/^\+(\d+)d$/);
  if (rel) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + Number(rel[1]));
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return null;
}

/**
 * Execute a deferral. Reads the same-tree verdict cache for
 * `--from-last-check` and for the explicit-fingerprint kind cross-check,
 * writes `.dxkit/allowlist.json` when anything was added.
 */
export function executeDefer(cwd: string, req: DeferRequest, now = new Date()): DeferResult {
  const reason = (req.reason ?? '').trim();
  if (!reason) return refuse('--reason is required (non-empty rationale string)');

  const expiresAt = parseDeferExpiry(req.expires, now);
  if (expiresAt === null) {
    return refuse(
      `--expires must be ISO date YYYY-MM-DD or relative +Nd; got ${JSON.stringify(req.expires)}`,
    );
  }
  // A window that already closed writes an entry that suppresses NOTHING: the
  // matcher skips an expired entry, so the finding keeps blocking while the
  // allowlist claims it was accepted. Refusing is the honest answer — silently
  // writing a dead entry fails the caller's actual intent.
  const windowDays = daysUntilDate(expiresAt, now);
  if (windowDays < 0) {
    return refuse(
      `--expires ${expiresAt} is already in the past (${-windowDays} day(s) ago), so the entry ` +
        `would suppress nothing and the findings would keep blocking. Pass a future date, ` +
        `or \`--expires +${DEFER_ADVISORY_EXPIRY_DAYS}d\`.`,
    );
  }

  const explicit = [...new Set((req.fingerprints ?? []).map((f) => f.trim()).filter(Boolean))];
  if (explicit.length === 0 && !req.fromLastCheck) {
    return refuse(
      'Nothing to defer. Pass fingerprints (vyuh-dxkit allowlist defer <fp> [<fp>…]) ' +
        'or --from-last-check to defer the blocking dep-vulns of the last guardrail run.',
    );
  }

  // The last same-tree run's blocking findings — the source for
  // --from-last-check, and the kind cross-check for explicit fingerprints.
  const cached = readVerdictForTree(cwd);
  const cachedBlocking = cached?.blockingFindings;

  const targets = new Map<
    string,
    { kind?: AllowlistEntry['kind']; locator?: string; severity?: string }
  >();
  const leftBlocking: string[] = [];
  if (req.fromLastCheck) {
    if (!cachedBlocking) {
      return refuse(
        cached
          ? 'The cached verdict has no finding list (written by an older dxkit). ' +
              `Re-run \`${dxkitCli('guardrail check')}\` on this tree, then retry.`
          : 'No cached guardrail verdict for this tree. Run ' +
              `\`${dxkitCli('guardrail check')}\` first (same tree, no edits in between), then retry.`,
      );
    }
    for (const f of cachedBlocking) {
      // The bulk lane is advisory-scoped: a sweep for a feed publish must not
      // silently absorb a net-new secret standing next to the advisories.
      // Anything else stays listed, deferable explicitly by fingerprint.
      if (f.kind === 'dep-vuln') {
        targets.set(f.fingerprint, {
          kind: 'dep-vuln',
          ...(f.locator !== undefined ? { locator: f.locator } : {}),
          ...(f.severity !== undefined ? { severity: f.severity } : {}),
        });
      } else {
        leftBlocking.push(`${f.kind} ${f.locator ?? f.fingerprint}`);
      }
    }
    if (targets.size === 0 && explicit.length === 0) {
      return refuse(
        leftBlocking.length > 0
          ? `The last run's blocking findings are not dependency advisories, and the bulk lane ` +
              `sweeps only those (${leftBlocking.join('; ')}). Defer them explicitly by ` +
              `fingerprint (\`${dxkitCli('allowlist defer <fingerprint>')}\`), or review each ` +
              `with \`${dxkitCli('allowlist add')}\`.`
          : 'The last guardrail run had no blocking findings — nothing to defer.',
      );
    }
  }
  for (const fp of explicit) {
    // Kind-stamp from the cache when we have it, so the entry suppresses
    // exactly the finding it names (suppression matches fingerprint AND
    // kind). An unknown fingerprint keeps the historical dep-vuln default —
    // the advisory workflows defer against a warm cache, and a cold-cache
    // explicit defer predates kinds here.
    const known = cachedBlocking?.find((f) => f.fingerprint === fp);
    if (!targets.has(fp)) {
      targets.set(fp, {
        ...(known?.kind !== undefined ? { kind: known.kind as AllowlistEntry['kind'] } : {}),
        ...(known?.locator !== undefined ? { locator: known.locator } : {}),
        ...(known?.severity !== undefined ? { severity: known.severity } : {}),
      });
    }
  }

  const addedBy = req.addedBy?.trim();
  if (!addedBy) {
    return refuse('--added-by is required (or set git config user.email so it can be inferred)');
  }
  const addedAt = now.toISOString().slice(0, 10);
  let file = loadAllowlist(cwd) ?? emptyAllowlistFile(req.mode);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const [fingerprint] of targets) {
    if (findEntry(file, fingerprint)) {
      alreadyPresent.push(fingerprint);
      continue;
    }
    const entry: AllowlistEntry = {
      fingerprint,
      kind: targets.get(fingerprint)?.kind ?? 'dep-vuln',
      category: 'deferred',
      reason,
      addedBy,
      addedAt,
      expiresAt,
    };
    const validationErrors = validateAllowlistEntry(entry, req.mode);
    if (validationErrors.length > 0) {
      return refuse(
        `allowlist entry for ${fingerprint} failed validation: ` +
          validationErrors.map((e) => `${e.field}: ${e.message}`).join('; '),
      );
    }
    file = addEntry(file, entry);
    added.push(fingerprint);
  }

  if (added.length > 0) saveAllowlist(cwd, { ...file, mode: req.mode });

  // Advisories describe the window that was just written, so they are computed
  // only when something WAS written — an all-already-present run chose no window.
  const advisories =
    added.length > 0 ? deferAdvisories(cwd, { count: added.length, expiresAt, now }) : [];

  return { ok: true, added, alreadyPresent, leftBlocking, expiresAt, reason, targets, advisories };
}
