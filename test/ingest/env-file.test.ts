import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadSnykEnv, loadSonarEnv, parseSnykEnv } from '../../src/ingest/env-file';

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
    expect([...(result?.loadedKeys ?? [])].sort()).toEqual(['SNYK_ORG_ID', 'SNYK_TOKEN']);
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

// ─── loadSonarEnv / loadPrefixedEnv (3.9: one loader, two prefixes) ─────────

describe('loadSonarEnv', () => {
  let tmp: string;
  const KEYS = ['SONAR_TOKEN', 'SONAR_HOST_URL', 'SONAR_PROJECT_KEY', 'SNYK_TOKEN'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = makeTmpdir();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmrf(tmp);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lifts ONLY SONAR_* keys — a SNYK_ key in the same file is untouched', () => {
    fs.writeFileSync(
      path.join(tmp, '.env'),
      'SONAR_TOKEN=st\nSONAR_HOST_URL=https://sonar.example.com\nSNYK_TOKEN=nope\nGITHUB_TOKEN=never\n',
    );
    const res = loadSonarEnv(tmp);
    expect([...(res?.loadedKeys ?? [])].sort()).toEqual(['SONAR_HOST_URL', 'SONAR_TOKEN']);
    expect(process.env.SONAR_TOKEN).toBe('st');
    expect(process.env.SNYK_TOKEN).toBeUndefined();
    expect(process.env.GITHUB_TOKEN === 'never').toBe(false);
  });

  it('names SONAR_TOKEN (not SNYK_TOKEN) in the committed-secrets advisory', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'SONAR_TOKEN=st\n');
    // Make the .env tracked so the advisory fires.
    execSync('git init -q && git add .env', { cwd: tmp });
    const res = loadSonarEnv(tmp);
    expect(res?.warnings.join(' ')).toContain('SONAR_TOKEN');
    expect(res?.warnings.join(' ')).not.toContain('SNYK_TOKEN');
  });

  it('regression: loadSnykEnv behavior + advisory text are unchanged by the refactor', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'SNYK_TOKEN=abc\nSONAR_TOKEN=st\n');
    execSync('git init -q && git add .env', { cwd: tmp });
    const res = loadSnykEnv(tmp);
    expect(res?.loadedKeys).toEqual(['SNYK_TOKEN']);
    expect(process.env.SONAR_TOKEN).toBeUndefined();
    expect(res?.warnings.join(' ')).toContain('Move SNYK_TOKEN out of version control');
  });
});
