/**
 * The refresh lane's degraded-capture refusal (4.4.8, #388).
 *
 * `baseline refresh` captures with `createBaseline({ force: true })` and used
 * to publish whatever came back. A capture in which a kind the prior recorded
 * drops to zero, on a tree whose diff touched none of that kind's inputs, is a
 * degraded scan far more often than a repo that fixed everything overnight: a
 * registry hiccup, a scanner exit, an unavailable provider read as "no
 * findings". The shipped incident: a daily refresh published an anchor with
 * ZERO dependency findings on a tree whose audit reports 122 and whose prior
 * anchor held 13. Nothing in the run said a scanner had produced nothing, and
 * from the next day on the repo's whole dependency debt read as "newly
 * published" (the companion defect, #389).
 *
 * The evidence the refusal reads is the ONE observation answer the guardrail's
 * removed-direction attribution reads (Rule 2.30, `classify-pairs.ts`):
 * `kindNotObservedReason` over the fresh scan's aggregate per-source provenance
 * and scope, plus the custom-check seam's own record for `custom-check`. No
 * second "did it run" table: the provenance says what actually ran.
 *
 * Per kind the prior recorded (count N > 0), the fresh capture is
 *   - REFUSED when the fresh side did NOT observe the kind and the diff
 *     prior-anchor -> tree touched none of its inputs (a dependency manifest
 *     for `dep-vuln`; any tracked file for every other kind). The fresh side
 *     carries no evidence about the kind, so publishing it would replace N
 *     recorded findings with nothing to back the claim.
 *   - PUBLISHED and DISCLOSED when the count dropped to zero but the fresh
 *     side observed the kind (the repo really cleared them), or the diff
 *     explains the drop. Never silent: the run summary names the kind and the
 *     explanation.
 *
 * A capture with no observation record at all (the test seam returned nothing)
 * reads as unobserved for every kind: absent evidence is not "comparable and
 * clean" (Rule 19's absent-recall discipline).
 */

import { describeCheckSkip } from '../analyzers/custom-checks/types';
import { kindNotObservedReason } from '../gate/observation';
import { dxkitCli } from '../self-invocation';
import type { BaselineFile } from './baseline-file';
import type { CurrentScan } from './create';
import { FULL_SCOPE } from './gather-scope';
import type { ResolvedMode } from './modes';
import type { BaselineEntry } from './types';

type IdentityKind = BaselineEntry['kind'];

/** What the fresh capture could observe, per kind: the refusal's evidence. */
export interface CaptureObservation {
  /**
   * Why `kind` was NOT observed by the fresh capture, or undefined when it
   * was. `priorEntries` are the prior anchor's entries of that kind (the
   * custom-check seam answers per check, so it needs the check names).
   */
  notObservedReason(
    kind: IdentityKind,
    priorEntries: ReadonlyArray<BaselineEntry>,
  ): string | undefined;
}

/**
 * The observation record of a real capture, composed exactly as the gate's
 * removed-direction attribution composes it: the custom-check seam's record
 * for `custom-check`, the aggregate provenance predicate for every other
 * kind. `createBaseline` always gathers the full scope, so the scope side of
 * the predicate is `FULL_SCOPE`.
 */
export function observationFromScan(
  scan: CurrentScan,
  mode: ResolvedMode['mode'],
): CaptureObservation {
  const cc = scan.customChecksUnobserved;
  const skippedByCheck = cc.gathered
    ? new Map(cc.checks.map((c) => [c.name, describeCheckSkip(c)]))
    : undefined;
  return {
    notObservedReason(kind, priorEntries) {
      if (kind !== 'custom-check') {
        return kindNotObservedReason(kind, {
          mode,
          scope: FULL_SCOPE,
          provenance: scan.aggregate.provenance,
        });
      }
      if (!cc.gathered) return cc.reason;
      // The kind is unobserved when EVERY check the prior recorded findings for
      // was skipped this run. A sanitized entry carries no check name, so it
      // cannot be attributed to a skip and does not count against the kind
      // (bias toward the false negative, as the gate does).
      const named = priorEntries.flatMap((e) => ('check' in e ? [e.check] : []));
      if (named.length === 0 || skippedByCheck!.size === 0) return undefined;
      const skips = named.map((check) => skippedByCheck!.get(check));
      if (skips.some((s) => s === undefined)) return undefined;
      const unique = [...new Set(skips as string[])];
      return `every check the prior recorded was ${unique.join('; ')}`;
    },
  };
}

/** The observation record of a capture that recorded NO evidence (the test
 *  seam returned nothing): unobserved for every kind, by Rule 19. */
export const NO_OBSERVATION_RECORD: CaptureObservation = {
  notObservedReason: () => 'the capture recorded no observation evidence for this kind',
};

/** One kind the fresh capture cannot honestly replace the prior's record of. */
export interface DegradedKind {
  readonly kind: IdentityKind;
  readonly priorCount: number;
  readonly freshCount: number;
  /** What the provenance said about the fresh capture of this kind. */
  readonly provenance: string;
}

/** One kind whose count dropped to zero and PUBLISHES, with why that is honest. */
export interface ClearedKind {
  readonly kind: IdentityKind;
  readonly priorCount: number;
  readonly explanation: string;
}

export interface CaptureDegradation {
  readonly refused: ReadonlyArray<DegradedKind>;
  readonly cleared: ReadonlyArray<ClearedKind>;
}

/**
 * Compare the fresh capture with the prior per kind (see the module docs for
 * the rule). Pure. `changed` is the diff prior-anchor -> working tree, or null
 * when it could not be computed (no evidence either way, so the diff explains
 * nothing); `manifestTouched` is the pack-declared manifest discriminator
 * already computed by the lane (the ONE `changedFilesTouchDependencyManifest`,
 * Rule 6). Deterministic order (kinds sorted) for renderers and tests.
 */
export function assessCaptureDegradation(args: {
  readonly prior: BaselineFile;
  readonly fresh: BaselineFile;
  readonly changed: ReadonlyArray<string> | null;
  readonly manifestTouched: boolean;
  readonly observation: CaptureObservation;
}): CaptureDegradation {
  const priorByKind = new Map<IdentityKind, BaselineEntry[]>();
  for (const f of args.prior.findings) {
    const list = priorByKind.get(f.kind) ?? [];
    list.push(f);
    priorByKind.set(f.kind, list);
  }
  const freshCounts = new Map<IdentityKind, number>();
  for (const f of args.fresh.findings) freshCounts.set(f.kind, (freshCounts.get(f.kind) ?? 0) + 1);

  const refused: DegradedKind[] = [];
  const cleared: ClearedKind[] = [];
  for (const kind of [...priorByKind.keys()].sort()) {
    const priorEntries = priorByKind.get(kind)!;
    const priorCount = priorEntries.length;
    const freshCount = freshCounts.get(kind) ?? 0;
    const touched =
      kind === 'dep-vuln' ? args.manifestTouched : args.changed !== null && args.changed.length > 0;
    const touchedWhat = kind === 'dep-vuln' ? 'a dependency manifest' : 'tracked files';
    const reason = args.observation.notObservedReason(kind, priorEntries);

    if (reason !== undefined && !touched) {
      refused.push({ kind, priorCount, freshCount, provenance: reason });
      continue;
    }
    if (freshCount === 0) {
      cleared.push({
        kind,
        priorCount,
        explanation:
          reason === undefined
            ? `the fresh capture observed the kind and found none (the repo cleared them)` +
              (touched ? `; the diff since the prior anchor also touched ${touchedWhat}` : '')
            : `the diff since the prior anchor touched ${touchedWhat}, which explains the drop; ` +
              `note the provenance said: ${reason}`,
      });
    }
  }
  return { refused, cleared };
}

/** Render one cleared kind for the run summary. */
export function describeClearedKind(c: ClearedKind): string {
  return `${c.kind}: ${c.priorCount} -> 0 published as a full clear (${c.explanation})`;
}

/**
 * The refusal a refresh raises over a degraded capture: which kinds, prior vs
 * fresh counts, what the provenance said, what was left untouched, and the
 * remedy. There is deliberately no override flag: a refresh cannot publish
 * what it did not observe. The manual path (an explicit re-capture + publish)
 * already exists and is named here.
 */
export function degradedCaptureRefusal(refused: ReadonlyArray<DegradedKind>): string {
  const kinds = refused
    .map((d) => `${d.kind} ${d.priorCount} -> ${d.freshCount} (${d.provenance})`)
    .join('; ');
  const n = refused.length;
  return (
    `refusing to refresh: the fresh capture did not observe ${n} kind${n === 1 ? '' : 's'} the ` +
    `prior baseline recorded, and nothing in the diff since the prior anchor explains the ` +
    `drop, so publishing it would replace recorded findings with an unobserved scan: ${kinds}. ` +
    `The prior anchor and the committed tree copy were left untouched. Re-run once the ` +
    `scanner is healthy: \`${dxkitCli('tools list')}\` shows what resolves here and ` +
    `\`${dxkitCli('tools install')}\` provisions it. To replace the prior deliberately, ` +
    `re-capture by hand with \`${dxkitCli('baseline create --force')}\` and ` +
    `\`${dxkitCli('baseline publish')}\`.`
  );
}
