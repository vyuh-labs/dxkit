/**
 * Graceful engine-failure degradation (3.9).
 *
 * The refresh (`vyuh-dxkit ingest`) must bite BOTH ways:
 * - an INFRASTRUCTURE failure (quota / rate limit / auth / network)
 *   with a prior committed snapshot keeps the snapshot and exits 0 —
 *   the dpl-studio lesson ("used your limit of private tests" redding
 *   the refresh CI while the gate was fine);
 * - a GENUINE failure, or an infra failure with NO snapshot to fall
 *   back to, still exits 1 so it gets fixed.
 *
 * Plus doctor's other half of the policy: `snapshotAgeDays` feeds the
 * staleness check that makes a chronically fail-open refresh visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isEngineInfraFailure,
  resolveEngineFailure,
  failureMessage,
  snapshotAgeDays,
  EXTERNAL_SNAPSHOT_STALE_DAYS,
} from '../../src/ingest/engine-failure';
import { writeSnapshot, readSnapshot } from '../../src/ingest/snapshot';
import { runIngest } from '../../src/ingest-cli';
import { fetchSnykCodeFindings } from '../../src/ingest/snyk-api';

vi.mock('../../src/ingest/snyk-api', () => ({
  fetchSnykCodeFindings: vi.fn(),
}));

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-engine-failure-'));
}

function seedSnapshot(cwd: string, generatedAt = '2026-07-01T00:00:00.000Z'): void {
  writeSnapshot(cwd, {
    schemaVersion: 1,
    engine: 'snyk-code',
    generatedAt,
    findings: [],
  });
}

// ─── isEngineInfraFailure ───────────────────────────────────────────────────

describe('isEngineInfraFailure', () => {
  it.each([
    // The real dpl-studio quota message, as the Snyk CLI wrapper surfaces it.
    'Snyk CLI produced no SARIF (exit 2): You have used your limit of private tests',
    'quota exceeded for this billing period',
    'Rate limit exceeded, retry after 60s',
    '429 Too Many Requests',
    '401 Unauthorized',
    'Snyk API error: 502 Bad Gateway',
    '503 Service Unavailable',
    'request to https://api.snyk.io failed, reason: connect ETIMEDOUT 1.2.3.4:443',
    'getaddrinfo ENOTFOUND api.snyk.io',
    'socket connection timed out',
    'network error while fetching results',
    'invalid token provided',
    // undici's blanket connection-failure message (real errno on err.cause).
    'fetch failed',
  ])('classifies infra: %s', (msg) => {
    expect(isEngineInfraFailure(msg)).toBe(true);
  });

  it.each([
    'Unexpected token < in JSON at position 0',
    'Snyk CLI produced no SARIF (exit 2)',
    'CodeQL database creation failed: 14 compilation errors',
    'unexpected response schema: missing data[].attributes',
    'ENOENT: no such file or directory',
  ])('classifies genuine (not infra): %s', (msg) => {
    expect(isEngineInfraFailure(msg)).toBe(false);
  });
});

// ─── resolveEngineFailure ───────────────────────────────────────────────────

describe('resolveEngineFailure', () => {
  it('degrades on an infra failure when a prior snapshot exists', () => {
    const cwd = tmpRepo();
    try {
      seedSnapshot(cwd);
      const d = resolveEngineFailure(cwd, 'snyk-code', 'You have used your limit of private tests');
      expect(d).toEqual({
        action: 'degrade',
        reason: 'You have used your limit of private tests',
        snapshotGeneratedAt: '2026-07-01T00:00:00.000Z',
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails (infra flagged) on an infra failure with NO prior snapshot', () => {
    const cwd = tmpRepo();
    try {
      const d = resolveEngineFailure(cwd, 'snyk-code', '429 Too Many Requests');
      expect(d).toEqual({ action: 'fail', reason: '429 Too Many Requests', infra: true });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails on a genuine error even when a snapshot exists', () => {
    const cwd = tmpRepo();
    try {
      seedSnapshot(cwd);
      const d = resolveEngineFailure(cwd, 'snyk-code', 'unexpected response schema');
      expect(d).toEqual({ action: 'fail', reason: 'unexpected response schema', infra: false });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('degrades per ENGINE — another engine’s snapshot is not a fallback', () => {
    const cwd = tmpRepo();
    try {
      seedSnapshot(cwd); // snyk-code only
      const d = resolveEngineFailure(cwd, 'codeql', 'connect ETIMEDOUT 1.2.3.4:443');
      expect(d.action).toBe('fail');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ─── failureMessage (cause unwrap — the undici `fetch failed` shape) ────────

describe('failureMessage', () => {
  it('unwraps the cause chain so the errno reaches the classifier + disclosure', () => {
    // Node fetch throws TypeError('fetch failed') with the real network
    // errno on err.cause — observed live against a dead endpoint.
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const err = new TypeError('fetch failed', { cause });
    expect(failureMessage(err)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:9');
    expect(isEngineInfraFailure(failureMessage(err))).toBe(true);
  });

  it('handles a plain error and a non-Error throw', () => {
    expect(failureMessage(new Error('boom'))).toBe('boom');
    expect(failureMessage('string throw')).toBe('string throw');
  });
});

// ─── readSnapshot (fail-open single-engine reader) ──────────────────────────

describe('readSnapshot', () => {
  it('round-trips a written snapshot', () => {
    const cwd = tmpRepo();
    try {
      seedSnapshot(cwd, '2026-06-15T12:00:00.000Z');
      const snap = readSnapshot(cwd, 'snyk-code');
      expect(snap?.generatedAt).toBe('2026-06-15T12:00:00.000Z');
      expect(snap?.engine).toBe('snyk-code');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null on a missing snapshot / dir', () => {
    const cwd = tmpRepo();
    try {
      expect(readSnapshot(cwd, 'snyk-code')).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null on malformed JSON and on a snapshot missing generatedAt', () => {
    const cwd = tmpRepo();
    try {
      const dir = path.join(cwd, '.dxkit', 'external');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'snyk-code.json'), 'not json');
      expect(readSnapshot(cwd, 'snyk-code')).toBeNull();
      fs.writeFileSync(path.join(dir, 'snyk-code.json'), JSON.stringify({ findings: [] }));
      expect(readSnapshot(cwd, 'snyk-code')).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ─── snapshotAgeDays (doctor’s staleness half of the policy) ────────────────

describe('snapshotAgeDays', () => {
  const now = new Date('2026-07-16T00:00:00.000Z');

  it('computes whole days', () => {
    expect(snapshotAgeDays('2026-07-15T00:00:00.000Z', now)).toBe(1);
    expect(snapshotAgeDays('2026-07-15T12:00:00.000Z', now)).toBe(0);
    expect(snapshotAgeDays('2026-06-01T00:00:00.000Z', now)).toBe(45);
  });

  it('returns null on an unparseable timestamp', () => {
    expect(snapshotAgeDays('not-a-date', now)).toBeNull();
  });

  it('threshold spans multiple missed weekly refreshes', () => {
    // Cadence-derived sanity pin, not a magic-number tautology: the
    // managed refresh is weekly, and the threshold must mean "broken,
    // not skipped once".
    expect(EXTERNAL_SNAPSHOT_STALE_DAYS).toBeGreaterThanOrEqual(21);
  });
});

// ─── runIngest exit-code behavior (the bite test) ───────────────────────────

describe('runIngest engine-failure exit codes', () => {
  const fetchMock = vi.mocked(fetchSnykCodeFindings);
  let cwd: string;
  const savedExitCode = process.exitCode;
  const savedEnv = {
    SNYK_TOKEN: process.env.SNYK_TOKEN,
    SNYK_ORG_ID: process.env.SNYK_ORG_ID,
    SNYK_PROJECT_ID: process.env.SNYK_PROJECT_ID,
  };

  beforeEach(() => {
    cwd = tmpRepo();
    process.exitCode = undefined;
    // A `your-…` value is one of benign.ts's placeholder conventions, so
    // dxkit's own secret gate reads it as a fixture, not a leak.
    process.env.SNYK_TOKEN = 'your-snyk-token';
    process.env.SNYK_ORG_ID = 'test-org';
    process.env.SNYK_PROJECT_ID = 'test-project';
    fetchMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function ingest(): Promise<void> {
    return runIngest(cwd, {
      fromSnyk: true,
      noEnvFile: true,
      generatedAt: '2026-07-16T00:00:00.000Z',
    });
  }

  it('exits 0 and keeps the snapshot on an infra failure with a prior snapshot', async () => {
    seedSnapshot(cwd);
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT 1.2.3.4:443'));
    await ingest();
    expect(process.exitCode ?? 0).toBe(0);
    // The prior snapshot is untouched — the gate keeps reading it.
    expect(readSnapshot(cwd, 'snyk-code')?.generatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('exits 1 on an infra failure with no prior snapshot', async () => {
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT 1.2.3.4:443'));
    await ingest();
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on a genuine failure even with a prior snapshot', async () => {
    seedSnapshot(cwd);
    fetchMock.mockRejectedValue(new Error('unexpected response schema: missing data'));
    await ingest();
    expect(process.exitCode).toBe(1);
    // …and never clobbers the snapshot on the way down.
    expect(readSnapshot(cwd, 'snyk-code')?.generatedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});
