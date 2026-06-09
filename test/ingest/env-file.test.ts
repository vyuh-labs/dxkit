import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSnykEnv, parseSnykEnv } from '../../src/ingest/env-file';

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-envfile-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('parseSnykEnv', () => {
  it('keeps only SNYK_* keys and drops everything else', () => {
    const out = parseSnykEnv(
      [
        'GITHUB_TOKEN=ghp_secret',
        'INFISICAL_TOKEN=inf_secret',
        'SNYK_TOKEN=snyk_abc',
        'SNYK_ORG_ID=org-1',
        '# a comment',
        '',
        'export SNYK_PROJECT_ID=proj-9',
      ].join('\n'),
    );
    expect(out).toEqual({
      SNYK_TOKEN: 'snyk_abc',
      SNYK_ORG_ID: 'org-1',
      SNYK_PROJECT_ID: 'proj-9',
    });
    expect(out).not.toHaveProperty('GITHUB_TOKEN');
    expect(out).not.toHaveProperty('INFISICAL_TOKEN');
  });

  it('strips matching single and double quotes', () => {
    const out = parseSnykEnv(['SNYK_TOKEN="quoted"', "SNYK_ORG_ID='single'"].join('\n'));
    expect(out.SNYK_TOKEN).toBe('quoted');
    expect(out.SNYK_ORG_ID).toBe('single');
  });
});

describe('loadSnykEnv', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ['SNYK_TOKEN', 'SNYK_ORG_ID', 'SNYK_PROJECT_ID'];

  beforeEach(() => {
    tmp = makeTmpdir();
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    rmrf(tmp);
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lifts SNYK_* keys from .env into process.env', () => {
    fs.writeFileSync(
      path.join(tmp, '.env'),
      'GITHUB_TOKEN=nope\nSNYK_TOKEN=abc\nSNYK_ORG_ID=org-1\n',
    );
    const result = loadSnykEnv(tmp);
    expect(result?.loadedKeys.sort()).toEqual(['SNYK_ORG_ID', 'SNYK_TOKEN']);
    expect(process.env.SNYK_TOKEN).toBe('abc');
    expect(process.env.SNYK_ORG_ID).toBe('org-1');
    // Non-SNYK key was never lifted.
    expect(process.env.GITHUB_TOKEN).not.toBe('nope');
  });

  it('does NOT overwrite an already-set environment value', () => {
    process.env.SNYK_TOKEN = 'from-real-env';
    fs.writeFileSync(path.join(tmp, '.env'), 'SNYK_TOKEN=from-dotenv\n');
    const result = loadSnykEnv(tmp);
    expect(process.env.SNYK_TOKEN).toBe('from-real-env');
    expect(result?.loadedKeys).not.toContain('SNYK_TOKEN');
  });

  it('returns null when --no-env-file is set, even if .env exists', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'SNYK_TOKEN=abc\n');
    expect(loadSnykEnv(tmp, { noEnvFile: true })).toBeNull();
    expect(process.env.SNYK_TOKEN).toBeUndefined();
  });

  it('returns null silently when no .env exists', () => {
    expect(loadSnykEnv(tmp)).toBeNull();
  });

  it('warns when an explicit --env-file path is missing', () => {
    const result = loadSnykEnv(tmp, { envFile: 'nope.env' });
    expect(result?.loadedKeys).toEqual([]);
    expect(result?.warnings.join(' ')).toMatch(/not found/);
  });

  it('honors an explicit --env-file path', () => {
    fs.writeFileSync(path.join(tmp, 'creds.env'), 'SNYK_TOKEN=xyz\n');
    const result = loadSnykEnv(tmp, { envFile: 'creds.env' });
    expect(result?.loadedKeys).toEqual(['SNYK_TOKEN']);
    expect(process.env.SNYK_TOKEN).toBe('xyz');
  });
});
