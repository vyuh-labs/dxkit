import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub findTool → gitleaks unavailable, so the fallback always runs. Other
// callers of tool-registry (e.g. the runner scan) continue working because
// only the one symbol is replaced and only inside this test file's module
// graph.
vi.mock('../src/analyzers/tools/tool-registry', async () => {
  const actual = await vi.importActual<typeof import('../src/analyzers/tools/tool-registry')>(
    '../src/analyzers/tools/tool-registry',
  );
  return {
    ...actual,
    findTool: (def: { name: string }, cwd?: string) => {
      if (def.name === 'gitleaks') {
        return {
          name: 'gitleaks',
          available: false,
          path: null,
          version: null,
          source: 'missing' as const,
          requirement: def,
        };
      }
      return actual.findTool(def, cwd);
    },
  };
});

// Imported AFTER the mock so the module sees the stubbed findTool.
import { gatherGrepSecretsResult } from '../src/analyzers/tools/grep-secrets';

describe('gatherGrepSecretsResult (gitleaks-absent fallback)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-grep-secrets-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('flags an AWS access key hardcoded in a TS file', () => {
    fs.writeFileSync(
      path.join(tmp, 'bad.ts'),
      "const key = 'AKIAIOSFODNN7EXAMPLE';\nexport default key;\n",
    );
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('grep-secrets');
    expect(result!.findings.length).toBeGreaterThanOrEqual(1);
    const aws = result!.findings.find((f) => f.rule === 'aws-access-key');
    expect(aws).toBeDefined();
    expect(aws!.file).toBe('bad.ts');
    expect(aws!.severity).toBe('high');
  });

  it('flags a hardcoded password with critical severity', () => {
    fs.writeFileSync(path.join(tmp, 'cfg.py'), "password = 'super-secret-123'\n");
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    const pw = result!.findings.find((f) => f.rule === 'hardcoded-password');
    expect(pw).toBeDefined();
    expect(pw!.severity).toBe('critical');
  });

  it('flags a PEM block as private-key-in-source with critical severity', () => {
    fs.writeFileSync(
      path.join(tmp, 'leaked.ts'),
      "const pem = '-----BEGIN RSA PRIVATE KEY-----';\n",
    );
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    const pk = result!.findings.find((f) => f.rule === 'private-key-in-source');
    expect(pk).toBeDefined();
    expect(pk!.severity).toBe('critical');
  });

  it('returns a success envelope with zero findings on a clean tree', () => {
    fs.writeFileSync(path.join(tmp, 'ok.ts'), "export const greeting = 'hello';\n");
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(0);
  });

  it('honors .dxkit-suppressions.json for gitleaks rule ids', () => {
    fs.writeFileSync(
      path.join(tmp, 'bad.ts'),
      "const key = 'AKIAIOSFODNN7EXAMPLE';\nexport default key;\n",
    );
    fs.writeFileSync(
      path.join(tmp, '.dxkit-suppressions.json'),
      JSON.stringify({
        gitleaks: [{ rule: 'aws-access-key', paths: ['bad.ts'], reason: 'test fixture' }],
      }),
    );
    const result = gatherGrepSecretsResult(tmp);
    expect(result).not.toBeNull();
    expect(result!.findings.find((f) => f.rule === 'aws-access-key')).toBeUndefined();
    expect(result!.suppressedCount).toBeGreaterThanOrEqual(1);
  });
});
