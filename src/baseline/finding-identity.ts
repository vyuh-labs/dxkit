/**
 * Per-finding identity dispatch. Pure module — no I/O, deterministic
 * output for deterministic input. Identity is the unit of comparison
 * across runs: two findings with the same identity are "the same
 * finding" for baseline / guardrail purposes.
 *
 * Two of the five identity schemes already live in `tools/fingerprint`
 * (dep-vuln + code/secret/config). This module wraps them in the
 * baseline's discriminated-union shape and adds the two new schemes
 * (duplication, coverage-gap) so callers reach all five through a
 * single dispatch.
 */

import { createHash } from 'crypto';
import {
  canonicalRuleFor,
  computeCodeFingerprint,
  computeFingerprint,
  lineWindowFor,
} from '../analyzers/tools/fingerprint';
import type {
  FindingId,
  HygieneMarker,
  IdentityInput,
  IdentitySchemeVersion,
  MatchPair,
  MatchReason,
  MatchResult,
  TestGapRisk,
} from './types';

/**
 * Compute the durable identity for a finding. `version` defaults to
 * `'v1'` — explicit so future scheme migrations can co-exist without
 * silent identity drift.
 *
 * Identity is the SAME 16-char hex string format across all kinds, so
 * a baseline can store identities in a single flat set without
 * tracking which kind they came from. Mixing across kinds is safe:
 * the input space for each scheme is disjoint (a dep-vuln tuple of
 * `(package, version, id)` can never collide with a code-finding
 * tuple of `(canonicalRule, file, lineWindow)` at SHA-1 strength).
 */
export function identityFor(
  input: IdentityInput,
  version: IdentitySchemeVersion = 'v1',
): FindingId {
  if (version !== 'v1') {
    throw new Error(`Unsupported identity-scheme version: ${version}`);
  }
  switch (input.kind) {
    case 'secret':
    case 'code':
    case 'config': {
      const canonicalRule = canonicalRuleFor(input.tool, input.rule);
      return computeCodeFingerprint(canonicalRule, input.file, input.line);
    }
    case 'dep-vuln':
      return computeFingerprint({
        package: input.package,
        installedVersion: input.installedVersion,
        id: input.id,
      });
    case 'duplication':
      return computeDuplicationIdentity(input.fileA, input.fileB, input.tokens);
    case 'coverage-gap':
      return computeCoverageGapIdentity(input.file, input.symbol, input.lineRange);
    case 'test-gap':
      return computeTestGapIdentity(input.file, input.risk);
    case 'hygiene':
      return computeHygieneIdentity(input.file, input.line, input.marker);
    case 'license':
      return computeLicenseIdentity(input.package, input.version, input.licenseType);
  }
}

/**
 * Symmetric-by-construction identity for a duplicate-block pair. File
 * names are sorted lexicographically before hashing so a clone reported
 * as `(a, b)` in one run and `(b, a)` in another hashes identically.
 *
 * `tokens` is included so refactoring one side of the pair (which
 * shrinks the block's token count) reports a fresh identity — that's
 * the right signal for a guardrail: "the duplicate moved or shrank,
 * which deserves a look."
 */
function computeDuplicationIdentity(fileA: string, fileB: string, tokens: number): FindingId {
  const [first, second] = [fileA, fileB].sort();
  const input = `duplication\0v1\0${first}\0${second}\0${tokens}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Identity for an uncovered-code gap. Prefers `(file, symbol)` when
 * the gap-detection pipeline knew the symbol name — that's stable
 * across refactors that move code within a file. Falls back to
 * `(file, lineRange)` when only a line range is available.
 *
 * Producers MUST supply at least one of `symbol` or `lineRange`;
 * supplying neither throws because the resulting identity would be
 * `(file)` only, which collapses every uncovered region in a file
 * into a single entry.
 */
function computeCoverageGapIdentity(
  file: string,
  symbol: string | undefined,
  lineRange: readonly [number, number] | undefined,
): FindingId {
  if (!symbol && !lineRange) {
    throw new Error(
      `coverage-gap identity requires either a symbol or a line range (file: ${file})`,
    );
  }
  const discriminator = symbol ? `sym:${symbol}` : `range:${lineRange![0]}-${lineRange![1]}`;
  const input = `coverage-gap\0v1\0${file}\0${discriminator}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Identity for a test-gap source file. Risk tier is part of identity:
 * a file moving between tiers (CRITICAL → HIGH, or vice versa) is
 * semantically a fresh finding — the prior tier's identity disappears,
 * the new tier's identity arrives. Guardrails will fire on the
 * net-new tier, which is the correct signal for regressions.
 */
function computeTestGapIdentity(file: string, risk: TestGapRisk): FindingId {
  const input = `test-gap\0v1\0${file}\0${risk}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Identity for a single hygiene-marker occurrence (TODO / FIXME /
 * HACK / console-log / any-type). Line number is bucketed via the
 * shared line-window so a reformat that shifts a TODO by one or two
 * lines doesn't churn identity. Marker text is NOT included — the
 * occurrence "is a TODO" regardless of what the comment body says.
 */
function computeHygieneIdentity(file: string, line: number, marker: HygieneMarker): FindingId {
  const input = `hygiene\0v1\0${marker}\0${file}\0${lineWindowFor(line)}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Identity for a package license attribution. Includes the license
 * type so a re-licensing event on the same `(package, version)` pin
 * registers as a fresh finding — compliance teams want to be
 * notified when a transitive dep switches from MIT to GPL even
 * without a version bump.
 */
function computeLicenseIdentity(
  packageName: string,
  version: string,
  licenseType: string,
): FindingId {
  const input = `license\0v1\0${packageName}\0${version}\0${licenseType}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Multiset-aware identity diff — the lowest layer of baseline
 * comparison. Pairs identities by occurrence count, not by presence:
 * an identity appearing twice in prior and once in current produces
 * one persisted pair and one removed pair (set-diff would have
 * incorrectly collapsed those to a single persisted).
 *
 * For each shared identity:
 *   - the first `min(priorCount, currentCount)` occurrences pair as
 *     `persisted` with confidence 1.0 (exact byte equality).
 *   - excess occurrences in `current` produce `added` pairs.
 *   - excess occurrences in `prior` produce `removed` pairs.
 *
 * Output ordering: pairs grouped by identity, then by status. The
 * flat-array views (`persisted`, `added`, `removed`) preserve
 * occurrence multiplicity — duplicate ids appear N times when N
 * occurrences were classified that way. Callers that want a
 * deduplicated view should run them through a Set themselves.
 */
export function matchAcrossRuns(
  prior: Iterable<FindingId>,
  current: Iterable<FindingId>,
): MatchResult {
  const priorCounts = countMultiset(prior);
  const currentCounts = countMultiset(current);
  const allIds = new Set<FindingId>([...priorCounts.keys(), ...currentCounts.keys()]);

  const pairs: MatchPair[] = [];
  const persisted: FindingId[] = [];
  const added: FindingId[] = [];
  const removed: FindingId[] = [];
  const exactReason: MatchReason = {
    code: 'exact-id',
    detail: 'identity fingerprint matched byte-for-byte across runs',
  };
  const newReason: MatchReason = {
    code: 'no-prior-match',
    detail: 'identity fingerprint not present in the baseline',
  };
  const goneReason: MatchReason = {
    code: 'no-current-match',
    detail: 'identity fingerprint not present in the current scan',
  };

  for (const id of allIds) {
    const p = priorCounts.get(id) ?? 0;
    const c = currentCounts.get(id) ?? 0;
    const matched = Math.min(p, c);
    for (let i = 0; i < matched; i++) {
      pairs.push({
        priorId: id,
        currentId: id,
        status: 'persisted',
        confidence: 1.0,
        reasons: [exactReason],
      });
      persisted.push(id);
    }
    for (let i = 0; i < c - matched; i++) {
      pairs.push({
        currentId: id,
        status: 'added',
        confidence: 1.0,
        reasons: [newReason],
      });
      added.push(id);
    }
    for (let i = 0; i < p - matched; i++) {
      pairs.push({
        priorId: id,
        status: 'removed',
        confidence: 1.0,
        reasons: [goneReason],
      });
      removed.push(id);
    }
  }

  return { pairs, persisted, added, removed, gitAware: false };
}

function countMultiset(items: Iterable<FindingId>): Map<FindingId, number> {
  const counts = new Map<FindingId, number>();
  for (const id of items) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
