/**
 * Verifies grep-secrets as the COMPLEMENT to gitleaks: when gitleaks is
 * present, the generic keyword-assignment patterns (which gitleaks
 * misses) still run, while the branded patterns (which gitleaks covers)
 * yield to avoid double-counting. This is the fix for "a hardcoded
 * password sails through the guardrail" — gitleaks doesn't flag generic
 * passwords, so this provider must.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub findTool → gitleaks AVAILABLE, so we exercise the complement path
// (generic patterns on, branded patterns off).
vi.mock('../src/analyzers/tools/tool-registry', async () => {
  const actual = await vi.importActual<typeof import('../src/analyzers/tools/tool-registry')>(
    '../src/analyzers/tools/tool-registry',
  );
  type ToolDefinition = Parameters<typeof actual.findTool>[0];
  return {
    ...actual,
    findTool: (def: ToolDefinition, cwd?: string) => {
      if (def.name === 'gitleaks') {
        return {
          name: 'gitleaks',
          available: true,
          path: '/usr/bin/gitleaks',
          version: '8.24.0',
          source: 'path' as const,
          requirement: def,
        };
      }
      return actual.findTool(def, cwd);
    },
  };
});

import { gatherGrepSecretsResult } from '../src/analyzers/tools/grep-secrets';

describe('gatherGrepSecretsResult (gitleaks-present complement)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-grep-complement-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('still flags a hardcoded password even though gitleaks is installed', () => {
    fs.writeFileSync(path.join(tmp, 'cfg.py'), 'password = "SuperSecret123"\n');
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    const pw = result!.findings.find((f) => f.rule === 'hardcoded-password');
    expect(pw).toBeDefined();
    expect(pw!.severity).toBe('critical');
  });

  it('matches keyword case-insensitively (DB_PASSWORD)', () => {
    fs.writeFileSync(path.join(tmp, 'cfg.py'), 'DB_PASSWORD = "hunter2"\n');
    const result = gatherGrepSecretsResult(tmp);
    expect(result!.findings.some((f) => f.rule === 'hardcoded-password')).toBe(true);
  });

  it('does NOT flag a config read or a comparison (precision)', () => {
    fs.writeFileSync(
      path.join(tmp, 'cfg.py'),
      'pw = config.get("password")\nif password == user_input:\n    pass\n',
    );
    const result = gatherGrepSecretsResult(tmp);
    expect(result!.findings).toHaveLength(0);
  });

  it('yields branded token shapes to gitleaks (no double-count)', () => {
    // An AWS key — gitleaks covers this, so grep-secrets must NOT also
    // report it when gitleaks is present.
    fs.writeFileSync(path.join(tmp, 'bad.ts'), "const k = 'AKIA1234567890ABCDEF';\n");
    const result = gatherGrepSecretsResult(tmp);
    expect(result!.findings.find((f) => f.rule === 'aws-access-key')).toBeUndefined();
  });

  it('flags a hardcoded api key / secret token assignment', () => {
    fs.writeFileSync(
      path.join(tmp, 'cfg.py'),
      'api_key = "abcdef123456"\nauth_token = "tok_live_xyz"\n',
    );
    const result = gatherGrepSecretsResult(tmp);
    const rules = result!.findings.map((f) => f.rule);
    expect(rules).toContain('hardcoded-api-key');
    expect(rules).toContain('hardcoded-secret');
  });
});
