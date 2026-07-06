import { describe, it, expect } from 'vitest';

import { baselineEntryToIdentityInput } from '../../src/baseline/migrate';
import { entryToLocated } from '../../src/baseline/entry-to-located';
import { identityFor } from '../../src/baseline/finding-identity';
import type { BaselineEntry } from '../../src/baseline/types';

/** Every discriminant the BaselineEntry union takes (mirror of the
 *  `IdentityKind` alias in producers/index.ts, inlined to avoid importing the
 *  producer module into a pure-matcher test). */
type IdentityKind = BaselineEntry['kind'];

/**
 * THE MATCHER RELOCATION INVARIANT (the class-level guard).
 *
 * A finding whose identity is sensitive to line position — shifting it down
 * the file changes its identity hash — MUST receive a full `(file, line,
 * rule)` locator from `entryToLocated`, so the matcher's line-aware pass can
 * relocate it through a `git diff` instead of reading benign churn (a comment
 * inserted above it) as removed+added → false net-new debt. A kind may be
 * locator-less (or line-less) ONLY when its identity is line-INDEPENDENT.
 *
 * This was violated once: `duplication` (added to the baseline producers
 * later) hashed exact start lines yet sat in the locator-less group with
 * dep-vuln + secret-hmac, so any line shift false-flagged every duplicate as
 * net-new. `coverage-gap`'s range variant had the same latent shape. Rather
 * than fix those two by hand and wait for the next kind to repeat it, this
 * test derives line-sensitivity empirically (shift the sample, recompute the
 * id) and asserts the locator is complete whenever it matters — so a future
 * kind that lands line-sensitive-but-locator-less fails here, not in a user's
 * guardrail.
 *
 * Mirror of the recipe/producer playbook tests: it makes "the matcher stopped
 * being relocation-complete" an empirical, automatic failure.
 */

const ID = '0'.repeat(16);
const SHIFT = 50; // larger than any line-window bucket, so a line-based id must move

interface Sample {
  readonly label: string;
  readonly entry: BaselineEntry;
  /** The same finding moved SHIFT lines down the file (benign churn). */
  readonly shifted: BaselineEntry;
}

const SAMPLES: ReadonlyArray<Sample> = [
  {
    label: 'secret',
    entry: { id: ID, kind: 'secret', tool: 'gitleaks', rule: 'aws-key', file: 'a.js', line: 10 },
    shifted: {
      id: ID,
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'aws-key',
      file: 'a.js',
      line: 10 + SHIFT,
    },
  },
  {
    label: 'code',
    entry: { id: ID, kind: 'code', tool: 'semgrep', rule: 'eval', file: 'a.js', line: 10 },
    shifted: {
      id: ID,
      kind: 'code',
      tool: 'semgrep',
      rule: 'eval',
      file: 'a.js',
      line: 10 + SHIFT,
    },
  },
  {
    label: 'config',
    entry: { id: ID, kind: 'config', tool: 'git', rule: 'env-in-git', file: '.env', line: 0 },
    shifted: { id: ID, kind: 'config', tool: 'git', rule: 'env-in-git', file: '.env', line: SHIFT },
  },
  {
    label: 'dep-vuln',
    entry: { id: ID, kind: 'dep-vuln', package: 'lodash', advisoryId: 'GHSA-1234' },
    shifted: { id: ID, kind: 'dep-vuln', package: 'lodash', advisoryId: 'GHSA-1234' },
  },
  {
    label: 'duplication',
    entry: {
      id: ID,
      kind: 'duplication',
      fileA: 'a.js',
      fileB: 'b.js',
      lines: 13,
      startLineA: 10,
      startLineB: 20,
    },
    shifted: {
      id: ID,
      kind: 'duplication',
      fileA: 'a.js',
      fileB: 'b.js',
      lines: 13,
      startLineA: 10 + SHIFT,
      startLineB: 20 + SHIFT,
    },
  },
  {
    label: 'coverage-gap (symbol-anchored)',
    entry: { id: ID, kind: 'coverage-gap', file: 'a.js', symbol: 'doThing', lineRange: [10, 20] },
    shifted: {
      id: ID,
      kind: 'coverage-gap',
      file: 'a.js',
      symbol: 'doThing',
      lineRange: [10 + SHIFT, 20 + SHIFT],
    },
  },
  {
    label: 'coverage-gap (range-anchored)',
    entry: { id: ID, kind: 'coverage-gap', file: 'a.js', lineRange: [10, 20] },
    shifted: { id: ID, kind: 'coverage-gap', file: 'a.js', lineRange: [10 + SHIFT, 20 + SHIFT] },
  },
  {
    label: 'test-gap',
    entry: { id: ID, kind: 'test-gap', file: 'a.js', risk: 'critical' },
    shifted: { id: ID, kind: 'test-gap', file: 'a.js', risk: 'critical' },
  },
  {
    label: 'hygiene',
    entry: { id: ID, kind: 'hygiene', file: 'a.js', line: 10, marker: 'todo' },
    shifted: { id: ID, kind: 'hygiene', file: 'a.js', line: 10 + SHIFT, marker: 'todo' },
  },
  {
    label: 'test-file-degradation',
    entry: { id: ID, kind: 'test-file-degradation', file: 'a.test.js', status: 'empty' },
    shifted: { id: ID, kind: 'test-file-degradation', file: 'a.test.js', status: 'empty' },
  },
  {
    label: 'god-file',
    entry: { id: ID, kind: 'god-file', file: 'a.js' },
    shifted: { id: ID, kind: 'god-file', file: 'a.js' },
  },
  {
    label: 'stale-file',
    entry: { id: ID, kind: 'stale-file', file: 'a.js.bak', suffix: 'bak' },
    shifted: { id: ID, kind: 'stale-file', file: 'a.js.bak', suffix: 'bak' },
  },
  {
    label: 'large-file',
    entry: { id: ID, kind: 'large-file', file: 'a.js' },
    shifted: { id: ID, kind: 'large-file', file: 'a.js' },
  },
  {
    label: 'secret-hmac',
    entry: { id: ID, kind: 'secret-hmac', tool: 'gitleaks', rule: 'aws-key', hmac: 'deadbeef' },
    shifted: { id: ID, kind: 'secret-hmac', tool: 'gitleaks', rule: 'aws-key', hmac: 'deadbeef' },
  },
  {
    label: 'stale-allow',
    entry: { id: ID, kind: 'stale-allow', file: 'a.js', line: 10, category: 'false-positive' },
    shifted: {
      id: ID,
      kind: 'stale-allow',
      file: 'a.js',
      line: 10 + SHIFT,
      category: 'false-positive',
    },
  },
  {
    // The LOCATED (linter-diagnostic) variant — line-window-bucketed identity,
    // so shifting it re-mints and it must carry a full locator. The binary
    // variant (no file) is line-independent and needs no sample here.
    label: 'custom-check (located)',
    entry: {
      id: ID,
      kind: 'custom-check',
      check: 'lint:typescript',
      blocking: true,
      file: 'a.ts',
      line: 10,
      rule: 'no-unused-vars',
    },
    shifted: {
      id: ID,
      kind: 'custom-check',
      check: 'lint:typescript',
      blocking: true,
      file: 'a.ts',
      line: 10 + SHIFT,
      rule: 'no-unused-vars',
    },
  },
];

/** Empirically: does shifting this finding down the file change its identity? */
function isLineSensitive(s: Sample): boolean {
  const base = baselineEntryToIdentityInput(s.entry);
  const moved = baselineEntryToIdentityInput(s.shifted);
  if (!base || !moved) throw new Error(`${s.label}: identity input was undefined`);
  return identityFor(base) !== identityFor(moved);
}

describe('matcher relocation invariant', () => {
  it('covers every IdentityKind (a new kind must add a sample here)', () => {
    // Exhaustiveness: this list mirrors the IdentityKind union. The
    // `satisfies` check fails to compile if a union member is dropped; the
    // runtime check fails if a kind has no sample, so a new finding kind
    // cannot land without being put through the invariant below.
    const allKinds = [
      'secret',
      'code',
      'config',
      'dep-vuln',
      'duplication',
      'coverage-gap',
      'test-gap',
      'hygiene',
      'test-file-degradation',
      'god-file',
      'stale-file',
      'large-file',
      'secret-hmac',
      'stale-allow',
      'custom-check',
    ] as const satisfies ReadonlyArray<IdentityKind>;
    const sampled = new Set(SAMPLES.map((s) => s.entry.kind));
    for (const kind of allKinds) {
      expect(sampled.has(kind), `no relocation sample for kind '${kind}'`).toBe(true);
    }
  });

  for (const s of SAMPLES) {
    it(`${s.label}: line-sensitive identity ⟹ a full (file,line,rule) locator`, () => {
      const located = entryToLocated(s.entry);
      if (isLineSensitive(s)) {
        expect(located.file, `${s.label} is line-sensitive but has no file locator`).toBeDefined();
        expect(
          located.line,
          `${s.label} is line-sensitive but has no line locator — the matcher cannot relocate it across a shift, so benign churn reads as net-new`,
        ).toBeDefined();
        expect(
          located.rule,
          `${s.label} is line-sensitive but has no rule discriminator`,
        ).toBeDefined();
      }
    });
  }
});

describe('duplication relocation locator', () => {
  it('uses the canonical representative side, stable across a line shift', () => {
    // The locator side must match the side the identity hash canonicalizes
    // on (sorted by file, then line), so prior + current pick the same side
    // and the matcher maps the right line through the diff.
    const entry: BaselineEntry = {
      id: ID,
      kind: 'duplication',
      // Deliberately B-before-A by sort: 'a.js' < 'b.js', so the A side is
      // canonical regardless of declaration order.
      fileA: 'b.js',
      fileB: 'a.js',
      lines: 13,
      startLineA: 20,
      startLineB: 5,
    };
    const located = entryToLocated(entry);
    expect(located.file).toBe('a.js'); // canonical first side (lexicographically smaller file)
    expect(located.line).toBe(5);
    expect(located.rule).toBe('duplication');
  });
});

describe('content-hash passthrough (git-independent relocation)', () => {
  // The matcher's content-hash pass relocates a finding WITHOUT git history
  // (shallow clone / force-pushed baseline) — but only if entryToLocated
  // propagates the stamped contentHash to the LocatedIdentity. Dropping it
  // silently (as stale-allow once did) leaves that kind unprotected whenever
  // git is unavailable. Every kind whose entry can carry a contentHash must
  // pass it through; this guards against the drop.
  const HASH = 'feedfacefeedface';
  const withHash: ReadonlyArray<{ label: string; entry: BaselineEntry }> = [
    {
      label: 'secret',
      entry: {
        id: ID,
        kind: 'secret',
        tool: 'gitleaks',
        rule: 'aws-key',
        file: 'a.js',
        line: 10,
        contentHash: HASH,
      },
    },
    {
      label: 'code',
      entry: {
        id: ID,
        kind: 'code',
        tool: 'semgrep',
        rule: 'eval',
        file: 'a.js',
        line: 10,
        contentHash: HASH,
      },
    },
    {
      label: 'config',
      entry: {
        id: ID,
        kind: 'config',
        tool: 'git',
        rule: 'env-in-git',
        file: '.env',
        line: 0,
        contentHash: HASH,
      },
    },
    {
      label: 'hygiene',
      entry: { id: ID, kind: 'hygiene', file: 'a.js', line: 10, marker: 'todo', contentHash: HASH },
    },
    {
      label: 'duplication',
      entry: {
        id: ID,
        kind: 'duplication',
        fileA: 'a.js',
        fileB: 'b.js',
        lines: 13,
        startLineA: 10,
        startLineB: 20,
        contentHash: HASH,
      },
    },
    {
      label: 'stale-allow',
      entry: {
        id: ID,
        kind: 'stale-allow',
        file: 'a.js',
        line: 10,
        category: 'false-positive',
        contentHash: HASH,
      },
    },
  ];

  for (const { label, entry } of withHash) {
    it(`${label}: entryToLocated propagates the stamped contentHash`, () => {
      expect(entryToLocated(entry).contentHash).toBe(HASH);
    });
  }
});
