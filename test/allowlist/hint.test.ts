import { describe, expect, it } from 'vitest';
import type { BaselineEntry, FindingId } from '../../src/baseline/types';
import { formatBlockHint, remediationFor } from '../../src/allowlist/hint';
import { CATEGORIES_BY_KIND } from '../../src/allowlist/categories';

const FP: FindingId = 'a3f9c0e8b7d2e1f4';

// Per-kind builders that produce well-formed BaselineEntry values.
// Centralized so a new kind landing in the canonical union forces
// one test-helper addition, not scattered struct literals.
const ENTRIES: Record<BaselineEntry['kind'], BaselineEntry> = {
  secret: {
    id: FP,
    kind: 'secret',
    tool: 'gitleaks',
    rule: 'private-key',
    file: 'src/a.ts',
    line: 42,
  },
  'secret-hmac': { id: FP, kind: 'secret-hmac', tool: 'gitleaks', rule: 'private-key', hmac: 'h0' },
  code: { id: FP, kind: 'code', tool: 'semgrep', rule: 'eval-use', file: 'src/a.ts', line: 5 },
  config: { id: FP, kind: 'config', tool: 'semgrep', rule: 'tls-off', file: 'config.ts', line: 12 },
  'dep-vuln': {
    id: FP,
    kind: 'dep-vuln',
    package: 'lodash',
    installedVersion: '4.0.0',
    advisoryId: 'GHSA-xxx',
  },
  duplication: {
    id: FP,
    kind: 'duplication',
    fileA: 'a.ts',
    fileB: 'b.ts',
    lines: 10,
    startLineA: 1,
    startLineB: 1,
  },
  'coverage-gap': { id: FP, kind: 'coverage-gap', file: 'src/a.ts', symbol: 'fn' },
  'test-gap': { id: FP, kind: 'test-gap', file: 'src/a.ts', risk: 'HIGH' },
  hygiene: { id: FP, kind: 'hygiene', file: 'src/a.ts', line: 1, marker: 'TODO' },
  license: { id: FP, kind: 'license', package: 'lodash', version: '4.0.0', licenseType: 'MIT' },
  'test-file-degradation': {
    id: FP,
    kind: 'test-file-degradation',
    file: 'src/a.test.ts',
    status: 'empty',
  },
  'god-file': { id: FP, kind: 'god-file', file: 'src/big.ts' },
  'stale-file': { id: FP, kind: 'stale-file', file: 'src/old.swp', suffix: 'swp' },
  'large-file': { id: FP, kind: 'large-file', file: 'src/big.ts' },
};

const ALL_KINDS = Object.keys(ENTRIES) as BaselineEntry['kind'][];

describe('remediationFor', () => {
  it('returns non-empty prose for every IdentityKind', () => {
    for (const kind of ALL_KINDS) {
      const text = remediationFor(kind);
      expect(text, `kind=${kind}`).toBeTruthy();
      expect(text.length, `kind=${kind}`).toBeGreaterThan(40);
    }
  });

  it('secret and secret-hmac share the rotate-credential prose', () => {
    expect(remediationFor('secret')).toContain('Rotate');
    expect(remediationFor('secret-hmac')).toContain('Rotate');
  });

  it('dep-vuln points at the vulnerabilities CLI', () => {
    expect(remediationFor('dep-vuln')).toContain('npx vyuh-dxkit vulnerabilities');
  });

  it('license prose redirects to inventory artifact', () => {
    expect(remediationFor('license')).toContain('.dxkit/inventory/licenses.json');
  });
});

describe('formatBlockHint — structural invariants', () => {
  it('every IdentityKind produces a well-formed hint', () => {
    for (const kind of ALL_KINDS) {
      const hint = formatBlockHint(ENTRIES[kind]);
      expect(hint.remediation, `${kind}: remediation`).toBeTruthy();
      expect(hint.cliCommand, `${kind}: cliCommand`).toBeTruthy();
      expect(hint.cliCommand, `${kind}: cliCommand`).toContain('npx vyuh-dxkit allowlist add');
      expect(hint.applicableCategories, `${kind}: applicableCategories`).toEqual(
        CATEGORIES_BY_KIND[kind],
      );
    }
  });

  it('license has empty applicableCategories', () => {
    const hint = formatBlockHint(ENTRIES.license);
    expect(hint.applicableCategories).toEqual([]);
    expect(hint.inlineExample).toBeUndefined();
    expect(hint.fileLevelOnly).toBe(true);
  });
});

describe('formatBlockHint — inline example', () => {
  it('renders inline example for typescript secret', () => {
    // src/a.ts → .ts → typescript pack → '//' marker
    const hint = formatBlockHint(ENTRIES.secret);
    expect(hint.inlineExample).toMatch(/^\/\/ dxkit-allow:false-positive/);
  });

  it('uses python comment syntax for python source', () => {
    const entry: BaselineEntry = {
      id: FP,
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'r',
      file: 'src/auth.py',
      line: 42,
    };
    const hint = formatBlockHint(entry);
    expect(hint.inlineExample).toMatch(/^# dxkit-allow:false-positive/);
  });

  it('omits inline example when file extension is unknown', () => {
    const entry: BaselineEntry = {
      id: FP,
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'r',
      file: 'src/cfg.xyz',
      line: 1,
    };
    const hint = formatBlockHint(entry);
    expect(hint.inlineExample).toBeUndefined();
  });

  it('omits inline example for file-only kinds (large-file)', () => {
    const hint = formatBlockHint(ENTRIES['large-file']);
    expect(hint.inlineExample).toBeUndefined();
  });

  it('omits inline example for hygiene (only file-only categories apply)', () => {
    // hygiene IS in INLINE_COMPATIBLE_KINDS but its categories are
    // accepted-risk + deferred only — both file-only. So inline
    // is not offered.
    const hint = formatBlockHint(ENTRIES.hygiene);
    expect(hint.inlineExample).toBeUndefined();
    expect(hint.fileLevelOnly).toBe(true);
  });

  it('omits inline example for dep-vuln (no file:line on BaselineEntry)', () => {
    // dep-vuln IS in INLINE_COMPATIBLE_KINDS in theory, but the
    // baseline entry shape has no file/line — identity is package +
    // version + id. So the hint formatter can't suggest a specific
    // attachment point at block time. Falls through to fingerprint
    // CLI form.
    const hint = formatBlockHint(ENTRIES['dep-vuln']);
    expect(hint.inlineExample).toBeUndefined();
  });
});

describe('formatBlockHint — fileLevelOnly classification', () => {
  it('false when kind has at least one inline-compatible category', () => {
    expect(formatBlockHint(ENTRIES.secret).fileLevelOnly).toBe(false);
    expect(formatBlockHint(ENTRIES['dep-vuln']).fileLevelOnly).toBe(false);
  });

  it('true when kind is not in INLINE_COMPATIBLE_KINDS', () => {
    expect(formatBlockHint(ENTRIES['large-file']).fileLevelOnly).toBe(true);
    expect(formatBlockHint(ENTRIES['coverage-gap']).fileLevelOnly).toBe(true);
    expect(formatBlockHint(ENTRIES.duplication).fileLevelOnly).toBe(true);
  });

  it('true when kind has no inline-compatible categories applicable (hygiene)', () => {
    expect(formatBlockHint(ENTRIES.hygiene).fileLevelOnly).toBe(true);
  });
});

describe('formatBlockHint — CLI command shape', () => {
  it('uses file:line positional for inline-compatible kind + locator', () => {
    const hint = formatBlockHint(ENTRIES.secret);
    expect(hint.cliCommand).toContain('src/a.ts:42');
    expect(hint.cliCommand).toContain('--category=false-positive');
    expect(hint.cliCommand).not.toContain('--fingerprint');
  });

  it('uses file positional + --kind for file-only kind with file', () => {
    const hint = formatBlockHint(ENTRIES['large-file']);
    expect(hint.cliCommand).toContain('src/big.ts');
    expect(hint.cliCommand).toContain('--kind=large-file');
  });

  it('falls back to --fingerprint when no file (duplication)', () => {
    const hint = formatBlockHint(ENTRIES.duplication);
    expect(hint.cliCommand).toContain(`--fingerprint=${FP}`);
    expect(hint.cliCommand).toContain('--kind=duplication');
  });

  it('falls back to --fingerprint for dep-vuln', () => {
    const hint = formatBlockHint(ENTRIES['dep-vuln']);
    expect(hint.cliCommand).toContain(`--fingerprint=${FP}`);
    expect(hint.cliCommand).toContain('--kind=dep-vuln');
  });

  it('every cliCommand includes a reason placeholder', () => {
    for (const kind of ALL_KINDS) {
      const hint = formatBlockHint(ENTRIES[kind]);
      expect(hint.cliCommand, `${kind}`).toContain('--reason=');
    }
  });

  it('license cliCommand uses --category=<category> placeholder', () => {
    const hint = formatBlockHint(ENTRIES.license);
    expect(hint.cliCommand).toContain('--category=<category>');
  });
});

describe('formatBlockHint — fileLevelHint', () => {
  it('present when kind has accepted-risk or deferred applicable', () => {
    const hint = formatBlockHint(ENTRIES.secret);
    expect(hint.fileLevelHint).toBeTruthy();
    expect(hint.fileLevelHint).toContain('.dxkit/allowlist.json');
  });

  it('absent when no expiring category applies (license has empty list)', () => {
    const hint = formatBlockHint(ENTRIES.license);
    expect(hint.fileLevelHint).toBeUndefined();
  });
});

describe('formatBlockHint — end-to-end common case', () => {
  it('typescript secret finding produces all three surfaces', () => {
    const entry: BaselineEntry = {
      id: FP,
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'detect-private-key',
      file: 'src/auth/oauth.ts',
      line: 42,
    };
    const hint = formatBlockHint(entry, 'high');

    expect(hint.remediation).toContain('Rotate this credential');
    expect(hint.inlineExample).toBe('// dxkit-allow:false-positive reason="<your reason here>"');
    expect(hint.cliCommand).toBe(
      'npx vyuh-dxkit allowlist add src/auth/oauth.ts:42 ' +
        '--category=false-positive --reason="<rationale here>"',
    );
    expect(hint.fileLevelOnly).toBe(false);
    expect(hint.fileLevelHint).toBeTruthy();
  });
});
