import { describe, it, expect } from 'vitest';
import { identityFor, matchAcrossRuns } from '../../src/baseline/finding-identity';
import type { IdentityInput } from '../../src/baseline/types';

/**
 * Each fixture describes a plausible inter-run scenario for one
 * finding-kind: a prior-run identity input and a current-run
 * identity input, plus the matcher outcome that should fall out.
 *
 *   `persisted`: identity unchanged between runs — the finding is
 *     still present, regardless of cosmetic drift the scheme is
 *     designed to absorb.
 *   `changed`: identity differs between runs — semantically the
 *     finding is "new + the old one disappeared." `matchAcrossRuns`
 *     reports it as one `added` plus one `removed`.
 *
 * Every fixture name describes the drift class being tested. New
 * variations land here as plain rows, not new test blocks.
 */
type ExpectedOutcome = 'persisted' | 'changed';

interface IdentityFixture {
  readonly name: string;
  readonly prior: IdentityInput;
  readonly current: IdentityInput;
  readonly expected: ExpectedOutcome;
}

const FIXTURES: ReadonlyArray<IdentityFixture> = [
  // ─── gitleaks-style secrets (5) ────────────────────────────────────────
  {
    name: 'secret/clean — same rule, same file, same line',
    prior: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 42,
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 42,
    },
    expected: 'persisted',
  },
  {
    name: 'secret/line-shifted within line-window — drift absorbed',
    prior: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 42,
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 43,
    },
    expected: 'persisted',
  },
  {
    name: 'secret/file-renamed — identity changes (file is part of identity)',
    prior: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/old.ts',
      line: 42,
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/new.ts',
      line: 42,
    },
    expected: 'changed',
  },
  {
    name: 'secret/cross-tool with canonical-rule mapping — private-key collapses',
    prior: {
      kind: 'secret',
      tool: 'find',
      rule: 'private-key-file',
      file: 'certs/server.pem',
      line: 0,
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'private-key',
      file: 'certs/server.pem',
      line: 0,
    },
    expected: 'persisted',
  },
  {
    name: 'secret/rule-evolved — different rule string, different identity',
    prior: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 42,
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'aws-access-token',
      file: 'src/config/index.ts',
      line: 42,
    },
    expected: 'changed',
  },

  // ─── config-class findings (1) ────────────────────────────────────────
  {
    name: 'config/env-tracked-in-git persists at line 0',
    prior: { kind: 'config', tool: 'git', rule: 'env-in-git', file: '.env', line: 0 },
    current: { kind: 'config', tool: 'git', rule: 'env-in-git', file: '.env', line: 0 },
    expected: 'persisted',
  },

  // ─── semgrep-style code patterns (5) ──────────────────────────────────
  {
    name: 'code/clean — same rule, same file, same line',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
    },
    expected: 'persisted',
  },
  {
    name: 'code/line-shifted within line-window — drift absorbed',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 99,
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
    },
    expected: 'persisted',
  },
  {
    name: 'code/file-moved across directories — identity changes',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/handlers/files.ts',
      line: 100,
    },
    expected: 'changed',
  },
  {
    name: 'code/cross-tool TLS-bypass canonicalization — registry + semgrep collapse',
    prior: {
      kind: 'code',
      tool: 'tls-bypass-registry',
      rule: 'tls-validation-disabled',
      file: 'src/services/upstream.ts',
      line: 50,
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'bypass-tls-verification',
      file: 'src/services/upstream.ts',
      line: 50,
    },
    expected: 'persisted',
  },
  {
    name: 'code/line-shifted across line-window boundary, NO anchor — identity changes (v1 fallback)',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 200,
    },
    expected: 'changed',
  },

  // ─── D-G5 content-anchored motion-stability (the fix) ──────────────────
  {
    // THE bug D-G5 closes: with a content anchor, a finding shifted far
    // past the line window keeps its identity. (Same construct, same
    // enclosing symbol, same ordinal — only the line moved.)
    name: 'code/content-anchored — shifted 100 lines, SAME anchor — persists',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
      contentAnchor: 'handleUpload a1b2c3d4e5f60718 0',
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 200,
      contentAnchor: 'handleUpload a1b2c3d4e5f60718 0',
    },
    expected: 'persisted',
  },
  {
    name: 'code/content-anchored — enclosing symbol renamed — identity changes',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
      contentAnchor: 'handleUpload a1b2c3d4e5f60718 0',
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/api/files.ts',
      line: 100,
      contentAnchor: 'handleDownload a1b2c3d4e5f60718 0',
    },
    expected: 'changed',
  },
  {
    name: 'code/content-anchored — second identical construct (ordinal) — distinct identity',
    prior: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'code-injection',
      file: 'src/eval.ts',
      line: 10,
      contentAnchor: 'run ffff0000ffff0000 0',
    },
    current: {
      kind: 'code',
      tool: 'semgrep',
      rule: 'code-injection',
      file: 'src/eval.ts',
      line: 10,
      contentAnchor: 'run ffff0000ffff0000 1',
    },
    expected: 'changed',
  },
  {
    // The original failure mode: 4 secrets fell out of the allowlist when
    // unrelated edits shifted their lines. With the HMAC anchor, the same
    // secret value keeps its identity wherever it sits.
    name: 'secret/content-anchored (HMAC) — shifted far, SAME value — persists',
    prior: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 42,
      contentAnchor: 'cafebabedeadbeef',
    },
    current: {
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      file: 'src/config/index.ts',
      line: 142,
      contentAnchor: 'cafebabedeadbeef',
    },
    expected: 'persisted',
  },

  // ─── dep-vuln (4) ──────────────────────────────────────────────────────
  {
    name: 'dep-vuln/clean — same package, version, advisory',
    prior: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.3',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    current: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.3',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    expected: 'persisted',
  },
  {
    name: 'dep-vuln/severity-rescored — identity unchanged (severity excluded from hash)',
    // Note: severity isn't carried in IdentityInput at all, so this fixture
    // is structurally identical to the clean case; included to document
    // the contract.
    prior: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.3',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    current: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.3',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    expected: 'persisted',
  },
  {
    name: 'dep-vuln/version-bumped — same advisory, identity UNCHANGED (version excluded from hash)',
    prior: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.3',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    current: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-a',
      installedVersion: '1.2.4',
      id: 'GHSA-aaaa-bbbb-cccc',
    },
    // Bumping to a still-vulnerable version is the SAME finding — identity
    // must not depend on installedVersion (it's environment-dependent; a
    // lockfile-only scanner can't resolve it). See computeFingerprint.
    expected: 'persisted',
  },
  {
    name: 'dep-vuln/new advisory against same install — identity changes',
    prior: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-b',
      installedVersion: '2.0.0',
      id: 'GHSA-xxxx-yyyy-zzzz',
    },
    current: {
      kind: 'dep-vuln',
      package: 'fixture-pkg-b',
      installedVersion: '2.0.0',
      id: 'GHSA-1111-2222-3333',
    },
    expected: 'changed',
  },

  // ─── duplication / jscpd (5) ──────────────────────────────────────────
  {
    name: 'duplication/clean — same pair, same lines + positions',
    prior: {
      kind: 'duplication',
      fileA: 'src/api/users.ts',
      fileB: 'src/api/admins.ts',
      lines: 80,
      startLineA: 10,
      startLineB: 40,
    },
    current: {
      kind: 'duplication',
      fileA: 'src/api/users.ts',
      fileB: 'src/api/admins.ts',
      lines: 80,
      startLineA: 10,
      startLineB: 40,
    },
    expected: 'persisted',
  },
  {
    name: 'duplication/pair-order swapped — identity unchanged (sides are symmetric)',
    prior: {
      kind: 'duplication',
      fileA: 'src/api/users.ts',
      fileB: 'src/api/admins.ts',
      lines: 80,
      startLineA: 10,
      startLineB: 40,
    },
    current: {
      kind: 'duplication',
      fileA: 'src/api/admins.ts',
      fileB: 'src/api/users.ts',
      lines: 80,
      startLineA: 40,
      startLineB: 10,
    },
    expected: 'persisted',
  },
  {
    name: 'duplication/block-refactored — lines count drops, identity changes',
    prior: {
      kind: 'duplication',
      fileA: 'src/api/users.ts',
      fileB: 'src/api/admins.ts',
      lines: 80,
      startLineA: 10,
      startLineB: 40,
    },
    current: {
      kind: 'duplication',
      fileA: 'src/api/users.ts',
      fileB: 'src/api/admins.ts',
      lines: 30,
      startLineA: 10,
      startLineB: 40,
    },
    expected: 'changed',
  },
  {
    name: 'duplication/intra-file — two clones at different positions get distinct identities',
    prior: {
      kind: 'duplication',
      fileA: 'src/big-controller.ts',
      fileB: 'src/big-controller.ts',
      lines: 60,
      startLineA: 100,
      startLineB: 250,
    },
    current: {
      kind: 'duplication',
      fileA: 'src/big-controller.ts',
      fileB: 'src/big-controller.ts',
      lines: 60,
      startLineA: 500,
      startLineB: 700,
    },
    expected: 'changed',
  },
  {
    name: 'duplication/intra-file persisted — same file pair + same positions',
    prior: {
      kind: 'duplication',
      fileA: 'src/big-controller.ts',
      fileB: 'src/big-controller.ts',
      lines: 60,
      startLineA: 100,
      startLineB: 250,
    },
    current: {
      kind: 'duplication',
      fileA: 'src/big-controller.ts',
      fileB: 'src/big-controller.ts',
      lines: 60,
      startLineA: 100,
      startLineB: 250,
    },
    expected: 'persisted',
  },

  // ─── coverage gaps (3) ────────────────────────────────────────────────
  {
    name: 'coverage-gap/clean — same file + symbol',
    prior: { kind: 'coverage-gap', file: 'src/services/payments.ts', symbol: 'refundOrder' },
    current: { kind: 'coverage-gap', file: 'src/services/payments.ts', symbol: 'refundOrder' },
    expected: 'persisted',
  },
  {
    name: 'coverage-gap/line-range-only — body shifts but range unchanged',
    prior: { kind: 'coverage-gap', file: 'src/services/payments.ts', lineRange: [120, 180] },
    current: { kind: 'coverage-gap', file: 'src/services/payments.ts', lineRange: [120, 180] },
    expected: 'persisted',
  },
  {
    name: 'coverage-gap/symbol-renamed — identity changes',
    prior: { kind: 'coverage-gap', file: 'src/services/payments.ts', symbol: 'refundOrder' },
    current: { kind: 'coverage-gap', file: 'src/services/payments.ts', symbol: 'reverseOrder' },
    expected: 'changed',
  },

  // ─── test-gap source files (3) ────────────────────────────────────────
  {
    name: 'test-gap/clean — same file + same risk tier',
    prior: { kind: 'test-gap', file: 'src/services/payments.ts', risk: 'high' },
    current: { kind: 'test-gap', file: 'src/services/payments.ts', risk: 'high' },
    expected: 'persisted',
  },
  {
    name: 'test-gap/risk-escalated — identity changes (regression signal)',
    prior: { kind: 'test-gap', file: 'src/services/payments.ts', risk: 'medium' },
    current: { kind: 'test-gap', file: 'src/services/payments.ts', risk: 'critical' },
    expected: 'changed',
  },
  {
    name: 'test-gap/file-renamed — identity changes',
    prior: { kind: 'test-gap', file: 'src/services/old-payments.ts', risk: 'high' },
    current: { kind: 'test-gap', file: 'src/services/payments.ts', risk: 'high' },
    expected: 'changed',
  },

  // ─── hygiene offenders, per-occurrence (4) ────────────────────────────
  {
    name: 'hygiene/clean — same TODO at same file + line',
    prior: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'todo' },
    current: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'todo' },
    expected: 'persisted',
  },
  {
    name: 'hygiene/line-shifted within window — drift absorbed (formatter run)',
    prior: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'todo' },
    current: { kind: 'hygiene', file: 'src/api/users.ts', line: 43, marker: 'todo' },
    expected: 'persisted',
  },
  {
    name: 'hygiene/marker-class-changed — TODO became FIXME, identity changes',
    prior: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'todo' },
    current: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'fixme' },
    expected: 'changed',
  },
  {
    name: 'hygiene/line-shifted past window boundary — identity changes',
    prior: { kind: 'hygiene', file: 'src/api/users.ts', line: 42, marker: 'console-log' },
    current: { kind: 'hygiene', file: 'src/api/users.ts', line: 142, marker: 'console-log' },
    expected: 'changed',
  },

  // ─── test-file-degradation (2) ────────────────────────────────────────
  {
    name: 'test-file-degradation/clean — same file + same status',
    prior: { kind: 'test-file-degradation', file: 'test/api/users.test.ts', status: 'empty' },
    current: { kind: 'test-file-degradation', file: 'test/api/users.test.ts', status: 'empty' },
    expected: 'persisted',
  },
  {
    name: 'test-file-degradation/status-transition — identity changes',
    prior: { kind: 'test-file-degradation', file: 'test/api/users.test.ts', status: 'empty' },
    current: {
      kind: 'test-file-degradation',
      file: 'test/api/users.test.ts',
      status: 'commented-out',
    },
    expected: 'changed',
  },

  // ─── god-file (2) ─────────────────────────────────────────────────────
  {
    name: 'god-file/clean — same file remains top offender',
    prior: { kind: 'god-file', file: 'src/handlers/orders.ts' },
    current: { kind: 'god-file', file: 'src/handlers/orders.ts' },
    expected: 'persisted',
  },
  {
    name: 'god-file/different-file — identity changes',
    prior: { kind: 'god-file', file: 'src/handlers/orders.ts' },
    current: { kind: 'god-file', file: 'src/handlers/inventory.ts' },
    expected: 'changed',
  },

  // ─── stale-file (2) ───────────────────────────────────────────────────
  {
    name: 'stale-file/clean — same path + suffix',
    prior: { kind: 'stale-file', file: 'src/legacy/dump.bak', suffix: 'bak' },
    current: { kind: 'stale-file', file: 'src/legacy/dump.bak', suffix: 'bak' },
    expected: 'persisted',
  },
  {
    name: 'stale-file/different-suffix — identity changes',
    prior: { kind: 'stale-file', file: 'src/legacy/dump.bak', suffix: 'bak' },
    current: { kind: 'stale-file', file: 'src/legacy/dump.bak', suffix: 'orig' },
    expected: 'changed',
  },

  // ─── large-file (2) ───────────────────────────────────────────────────
  {
    name: 'large-file/clean — same file over threshold',
    prior: { kind: 'large-file', file: 'src/services/payments.ts' },
    current: { kind: 'large-file', file: 'src/services/payments.ts' },
    expected: 'persisted',
  },
  {
    name: 'large-file/different-file — identity changes',
    prior: { kind: 'large-file', file: 'src/services/payments.ts' },
    current: { kind: 'large-file', file: 'src/services/orders.ts' },
    expected: 'changed',
  },

  // ─── secret-hmac (3) ──────────────────────────────────────────────────
  {
    name: 'secret-hmac/clean — same tool, rule, HMAC',
    prior: {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      hmac: 'a1b2c3d4e5f60718',
    },
    current: {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      hmac: 'a1b2c3d4e5f60718',
    },
    expected: 'persisted',
  },
  {
    name: 'secret-hmac/different-secret — identity changes',
    prior: {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      hmac: 'a1b2c3d4e5f60718',
    },
    current: {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: 'generic-api-key',
      hmac: 'deadbeefcafebabe',
    },
    expected: 'changed',
  },
  {
    name: 'secret-hmac/cross-tool with canonical-rule mapping — private-key collapses',
    // Same underlying secret value (same HMAC) detected by two
    // different scanners using two different rule names. The
    // canonical-rule map collapses them so identity matches.
    prior: {
      kind: 'secret-hmac',
      tool: 'find',
      rule: 'private-key-file',
      hmac: 'a1b2c3d4e5f60718',
    },
    current: {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: 'private-key',
      hmac: 'a1b2c3d4e5f60718',
    },
    expected: 'persisted',
  },

  // ─── stale-allow (3) ──────────────────────────────────────────────────
  {
    name: 'stale-allow/clean — same file, line, category',
    prior: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 42,
      category: 'test-fixture',
    },
    current: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 42,
      category: 'test-fixture',
    },
    expected: 'persisted',
  },
  {
    name: 'stale-allow/line-window absorbs small line drift',
    // The 3-line window in `lineWindowFor` buckets lines by
    // floor(line / 3) * 3. Lines 42, 43, 44 all bucket to 42,
    // so a formatter-driven shift inside the bucket doesn't
    // churn identity. (Lines that cross a bucket boundary —
    // 41 → bucket 39, 42 → bucket 42 — DO churn; that's the
    // window's deliberate granularity.)
    prior: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 42,
      category: 'test-fixture',
    },
    current: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 44,
      category: 'test-fixture',
    },
    expected: 'persisted',
  },
  {
    name: 'stale-allow/category-change → identity changes',
    // Reclassifying an annotation (test-fixture → false-positive
    // on the same source line) is semantically a different stale-allow.
    prior: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 42,
      category: 'test-fixture',
    },
    current: {
      kind: 'stale-allow',
      file: 'src/auth/oauth.ts',
      line: 42,
      category: 'false-positive',
    },
    expected: 'changed',
  },

  // ─── flow-binding (4) ─────────────────────────────────────────────────
  {
    name: 'flow-binding/clean — same method, path, file',
    prior: { kind: 'flow-binding', method: 'GET', path: '/articles/{var}', file: 'web/List.tsx' },
    current: { kind: 'flow-binding', method: 'GET', path: '/articles/{var}', file: 'web/List.tsx' },
    expected: 'persisted',
  },
  {
    name: 'flow-binding/verb change → identity changes',
    // A call re-pointed from GET to DELETE is a different integration.
    prior: { kind: 'flow-binding', method: 'GET', path: '/articles/{var}', file: 'web/List.tsx' },
    current: {
      kind: 'flow-binding',
      method: 'DELETE',
      path: '/articles/{var}',
      file: 'web/List.tsx',
    },
    expected: 'changed',
  },
  {
    name: 'flow-binding/path change → identity changes',
    prior: { kind: 'flow-binding', method: 'GET', path: '/articles/{var}', file: 'web/List.tsx' },
    current: { kind: 'flow-binding', method: 'GET', path: '/comments/{var}', file: 'web/List.tsx' },
    expected: 'changed',
  },
  {
    name: 'flow-binding/moving the call to a different consuming file → identity changes',
    // Identity is line-INDEPENDENT (a call moving within a file persists), but
    // the consuming FILE is an identity input: a different file is a different
    // integration dependency. (A pure file rename is relocated by the matcher's
    // whole-file rename pass, not the hash.)
    prior: { kind: 'flow-binding', method: 'GET', path: '/articles/{var}', file: 'web/List.tsx' },
    current: {
      kind: 'flow-binding',
      method: 'GET',
      path: '/articles/{var}',
      file: 'web/Detail.tsx',
    },
    expected: 'changed',
  },

  // ─── custom-check / lint findings (5) ─────────────────────────────────
  {
    name: 'custom-check/located clean — same check, file, line, rule',
    prior: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-unused-vars',
    },
    current: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-unused-vars',
    },
    expected: 'persisted',
  },
  {
    name: 'custom-check/located line-shifted within window — drift absorbed',
    prior: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-unused-vars',
    },
    current: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 43,
      rule: 'no-unused-vars',
    },
    expected: 'persisted',
  },
  {
    name: 'custom-check/located rule-changed — different diagnostic, identity changes',
    prior: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-unused-vars',
    },
    current: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-explicit-any',
    },
    expected: 'changed',
  },
  {
    name: 'custom-check/binary clean — same whole-command check name',
    // A binary (pass/fail) check has no file: identity is just the check name,
    // so it persists as long as the same command keeps failing.
    prior: { kind: 'custom-check', check: 'check:seam' },
    current: { kind: 'custom-check', check: 'check:seam' },
    expected: 'persisted',
  },
  {
    name: 'custom-check/binary → located are distinct identities for one check',
    // A binary failure of `lint:typescript` and a located diagnostic under the
    // same check name must not collapse — the file discriminator separates them.
    prior: { kind: 'custom-check', check: 'lint:typescript' },
    current: {
      kind: 'custom-check',
      check: 'lint:typescript',
      file: 'src/api/users.ts',
      line: 42,
      rule: 'no-unused-vars',
    },
    expected: 'changed',
  },
];

describe('identityFor — per-kind deterministic identity', () => {
  it('produces a stable 16-char lowercase hex id for every fixture', () => {
    for (const fx of FIXTURES) {
      const id = identityFor(fx.prior);
      expect(id, fx.name).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is deterministic — repeated calls return the same id', () => {
    for (const fx of FIXTURES) {
      expect(identityFor(fx.prior), fx.name).toBe(identityFor(fx.prior));
    }
  });

  it('rejects unsupported scheme versions', () => {
    expect(() =>
      identityFor(
        { kind: 'secret', tool: 'gitleaks', rule: 'generic-api-key', file: 'a.ts', line: 1 },
        // @ts-expect-error — verifying runtime guard on a hypothetical future version
        'v3',
      ),
    ).toThrow(/Unsupported identity-scheme version/);
  });

  it('rejects coverage-gap inputs missing both symbol and lineRange', () => {
    expect(() => identityFor({ kind: 'coverage-gap', file: 'src/services/payments.ts' })).toThrow(
      /requires either a symbol or a line range/,
    );
  });
});

describe('identityFor — scheme versions (migration support)', () => {
  // identityFor can compute EITHER shipped scheme, so the migrator can
  // derive a finding's (old, new) id pair from one scan. Only two kinds
  // changed between v1 and v2; everything else is version-independent.
  const codeAnchored: IdentityInput = {
    kind: 'code',
    tool: 'semgrep',
    rule: 'path-traversal',
    file: 'src/a.ts',
    line: 100,
    contentAnchor: 'handleUpload abc0abc0abc0abc0 0',
  };
  const dep: IdentityInput = {
    kind: 'dep-vuln',
    package: 'lodash',
    installedVersion: '4.17.20',
    id: 'GHSA-aaaa-bbbb-cccc',
  };

  it('code: v1 is line-based (ignores the content anchor), v2 is content-anchored', () => {
    const v1 = identityFor(codeAnchored, 'v1');
    const v2 = identityFor(codeAnchored, 'v2');
    expect(v1).not.toBe(v2);
    // v1 ignores the anchor — same id with or without it.
    const noAnchor: IdentityInput = {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/a.ts',
      line: 100,
    };
    expect(identityFor(noAnchor, 'v1')).toBe(v1);
  });

  it('code without an anchor: v2 falls back to the v1 line hash (equal ids)', () => {
    const noAnchor: IdentityInput = {
      kind: 'code',
      tool: 'semgrep',
      rule: 'path-traversal',
      file: 'src/a.ts',
      line: 100,
    };
    expect(identityFor(noAnchor, 'v2')).toBe(identityFor(noAnchor, 'v1'));
  });

  it('dep-vuln: v1 hashes the installed version, v2 does not (distinct ids)', () => {
    expect(identityFor(dep, 'v1')).not.toBe(identityFor(dep, 'v2'));
    // v1 is environment-dependent: a different installed version → different id.
    expect(identityFor(dep, 'v1')).not.toBe(
      identityFor({ ...dep, installedVersion: '4.17.21' }, 'v1'),
    );
    // v2 is version-independent: same advisory, any version → same id.
    expect(identityFor(dep, 'v2')).toBe(identityFor({ ...dep, installedVersion: '4.17.21' }, 'v2'));
  });

  it('version-independent kinds: v1 id === v2 id (no migration needed)', () => {
    const kinds: IdentityInput[] = [
      { kind: 'test-gap', file: 'src/a.ts', risk: 'high' },
      { kind: 'large-file', file: 'src/a.ts' },
      {
        kind: 'duplication',
        fileA: 'a.ts',
        fileB: 'b.ts',
        lines: 30,
        startLineA: 1,
        startLineB: 5,
      },
      { kind: 'secret-hmac', tool: 'gitleaks', rule: 'generic-api-key', hmac: 'deadbeefdeadbeef' },
    ];
    for (const k of kinds) {
      expect(identityFor(k, 'v1')).toBe(identityFor(k, 'v2'));
    }
  });

  it('defaults to the current scheme (v2)', () => {
    expect(identityFor(codeAnchored)).toBe(identityFor(codeAnchored, 'v2'));
  });
});

describe('identityFor — fixture-driven drift behavior', () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const priorId = identityFor(fx.prior);
      const currentId = identityFor(fx.current);
      if (fx.expected === 'persisted') {
        expect(priorId).toBe(currentId);
      } else {
        expect(priorId).not.toBe(currentId);
      }
    });
  }
});

describe('matchAcrossRuns — set diff over identity', () => {
  it('classifies every fixture into the expected bucket', () => {
    for (const fx of FIXTURES) {
      const prior = [identityFor(fx.prior)];
      const current = [identityFor(fx.current)];
      const result = matchAcrossRuns(prior, current);
      if (fx.expected === 'persisted') {
        expect(result.persisted.length, fx.name).toBe(1);
        expect(result.added.length, fx.name).toBe(0);
        expect(result.removed.length, fx.name).toBe(0);
      } else {
        expect(result.persisted.length, fx.name).toBe(0);
        expect(result.added.length, fx.name).toBe(1);
        expect(result.removed.length, fx.name).toBe(1);
      }
    }
  });

  it('treats empty inputs as empty outputs', () => {
    const result = matchAcrossRuns([], []);
    expect(result.persisted).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('handles intersection + disjoint sets together', () => {
    const a = ['aaaa1111bbbb2222', 'cccc3333dddd4444'];
    const b = ['cccc3333dddd4444', 'eeee5555ffff6666'];
    const result = matchAcrossRuns(a, b);
    expect([...result.persisted].sort()).toEqual(['cccc3333dddd4444']);
    expect([...result.added].sort()).toEqual(['eeee5555ffff6666']);
    expect([...result.removed].sort()).toEqual(['aaaa1111bbbb2222']);
  });

  it('preserves occurrence count via multiset semantics', () => {
    // Two prior instances of the same fingerprint, one current instance:
    // one persists, one is removed. Set-based dedup would have hidden
    // the removal and reported a clean "no change" — that's the bug
    // multiset matching fixes.
    const a = ['aaaa1111bbbb2222', 'aaaa1111bbbb2222'];
    const b = ['aaaa1111bbbb2222'];
    const result = matchAcrossRuns(a, b);
    expect(result.persisted).toEqual(['aaaa1111bbbb2222']);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['aaaa1111bbbb2222']);
  });

  it('emits structured pairs with reasons + confidence', () => {
    const result = matchAcrossRuns(['aaaa1111bbbb2222'], ['aaaa1111bbbb2222']);
    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs;
    expect(pair.status).toBe('persisted');
    expect(pair.confidence).toBe(1.0);
    expect(pair.reasons[0].code).toBe('exact-id');
    expect(pair.priorId).toBe('aaaa1111bbbb2222');
    expect(pair.currentId).toBe('aaaa1111bbbb2222');
  });

  it('marks the result as non-git-aware', () => {
    const result = matchAcrossRuns(['aaaa1111bbbb2222'], []);
    expect(result.gitAware).toBe(false);
    expect(result.degradedReason).toBeUndefined();
  });
});

/**
 * The list of finding kinds that the dispatch supports. Mirrors the
 * `IdentityInput` discriminant union in `src/baseline/types.ts`. When
 * a new kind is added to the union, TypeScript's exhaustiveness check
 * on `identityFor`'s switch forces a code update; this list is the
 * matching test-side enforcement that ensures the new kind ships with
 * fixture coverage.
 *
 * Update procedure: add the new kind here, then add at least one
 * fixture row in `FIXTURES` exercising it.
 */
const EXPECTED_KINDS = [
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
  'flow-binding',
  'custom-check',
] as const;

describe('identityFor — coverage contract (Rule 9)', () => {
  it('every supported finding kind has at least one fixture row', () => {
    const covered = new Set(FIXTURES.map((f) => f.prior.kind));
    for (const kind of EXPECTED_KINDS) {
      expect(covered.has(kind), `missing fixture row for kind: ${kind}`).toBe(true);
    }
  });

  it('every fixture kind appears in the expected-kinds contract list', () => {
    const expected = new Set<string>(EXPECTED_KINDS);
    for (const fx of FIXTURES) {
      expect(
        expected.has(fx.prior.kind),
        `fixture "${fx.name}" exercises kind "${fx.prior.kind}" not declared in EXPECTED_KINDS`,
      ).toBe(true);
    }
  });
});

describe('identityFor — cross-kind disjointness', () => {
  it('does not collide across kinds even with structurally-similar inputs', () => {
    const ids = new Set<string>([
      identityFor({
        kind: 'secret',
        tool: 'gitleaks',
        rule: 'api-key',
        file: 'src/a.ts',
        line: 10,
      }),
      identityFor({ kind: 'code', tool: 'gitleaks', rule: 'api-key', file: 'src/a.ts', line: 10 }),
      identityFor({
        kind: 'config',
        tool: 'gitleaks',
        rule: 'api-key',
        file: 'src/a.ts',
        line: 10,
      }),
      identityFor({
        kind: 'dep-vuln',
        package: 'gitleaks',
        installedVersion: 'api-key',
        id: 'src/a.ts',
      }),
      identityFor({
        kind: 'duplication',
        fileA: 'gitleaks',
        fileB: 'api-key',
        lines: 10,
        startLineA: 1,
        startLineB: 1,
      }),
      identityFor({ kind: 'coverage-gap', file: 'src/a.ts', symbol: 'gitleaks' }),
    ]);
    // The first three (secret/code/config) intentionally collide — they
    // share the same canonical-rule + file + lineWindow input space and
    // the kind itself is NOT part of the hash, only the canonical rule
    // map is. That's by design: a finding that flips between two
    // categories (a TLS-bypass that one tool labels as `secret` and
    // another as `code`) MUST collapse to one identity. The remaining
    // three are kind-disjoint by their input tuple shape.
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });
});
