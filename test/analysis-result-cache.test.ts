/**
 * Tests for the AnalysisResult cache.
 *
 * The cache module is the cross-process persistence layer for the
 * canonical analysis envelope. Hit/miss + invalidation behavior is
 * exercised here using the test seams the module exposes:
 *
 *   - `resolveProvenance` override — inject SHA / dirty-flag / mtime
 *     without spawning git or touching real files. Keeps tests fast
 *     and isolated from the host's git state.
 *
 *   - `cacheDir` override — point the on-disk layer at a tmpdir so
 *     parallel runs don't trample each other.
 *
 *   - `now` override — produce deterministic `builtAt` timestamps.
 *
 *   - `clearInMemoryCache()` — drop dedup state between tests.
 *
 * Each test sets up its own builder spy so we can assert on the exact
 * number of times the build function ran — the cleanest signal of
 * "was this a hit or a miss?".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readOrBuildAnalysisResult,
  clearInMemoryCache,
  type ResolvedProvenance,
} from '../src/analyzers/cache';
import {
  ANALYSIS_RESULT_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalysisResultBody,
} from '../src/analysis-result';
import { defaultMetrics } from '../src/analyzers/health';

let tmp: string;
let cacheDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-cache-'));
  cacheDir = path.join(tmp, '.dxkit', 'cache');
  clearInMemoryCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeProvenance(overrides: Partial<ResolvedProvenance> = {}): ResolvedProvenance {
  return {
    commitSha: 'abc1234',
    branch: 'main',
    cwd: tmp,
    dxkitVersion: '9.9.9-test',
    ignoreFileMtime: null,
    workingTreeDirty: false,
    ...overrides,
  };
}

function stubBody(): AnalysisResultBody {
  return {
    stack: {
      languages: {
        typescript: true,
        python: false,
        go: false,
        rust: false,
        csharp: false,
        kotlin: false,
        java: false,
        ruby: false,
      },
      infrastructure: { docker: false, postgres: false, redis: false },
      tools: { gcloud: false, pulumi: false, infisical: false, ghCli: false },
      projectName: 'fixture',
      projectDescription: '',
      versions: {},
      requiredTools: [],
    },
    capabilities: {},
    metrics: defaultMetrics(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('readOrBuildAnalysisResult', () => {
  it('builds on first call and stamps provenance fields', async () => {
    const provenance = makeProvenance();
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => provenance,
        cacheDir,
        now: () => new Date('2026-05-15T12:00:00Z'),
      },
    });

    expect(calls).toBe(1);
    expect(result.commitSha).toBe('abc1234');
    expect(result.branch).toBe('main');
    expect(result.dxkitVersion).toBe('9.9.9-test');
    expect(result.schemaVersion).toBe(ANALYSIS_RESULT_SCHEMA_VERSION);
    expect(result.builtAt).toBe('2026-05-15T12:00:00.000Z');
    expect(result.workingTreeDirty).toBe(false);
  });

  it('persists to disk on clean-tree build', async () => {
    const provenance = makeProvenance();
    await readOrBuildAnalysisResult({
      cwd: tmp,
      build: async () => stubBody(),
      opts: { resolveProvenance: () => provenance, cacheDir },
    });
    const expectedFile = path.join(cacheDir, 'analysis-result-abc1234.json');
    expect(fs.existsSync(expectedFile)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(expectedFile, 'utf-8')) as AnalysisResult;
    expect(parsed.commitSha).toBe('abc1234');
    expect(parsed.schemaVersion).toBe(ANALYSIS_RESULT_SCHEMA_VERSION);
  });

  it('reads from disk on a second call with identical provenance', async () => {
    const provenance = makeProvenance();
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });
    // Drop in-memory state to force the second call to consult disk.
    clearInMemoryCache();
    const second = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });

    expect(calls).toBe(1);
    expect(second.commitSha).toBe('abc1234');
  });

  it('deduplicates concurrent in-process calls with the same provenance', async () => {
    const provenance = makeProvenance();
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      // Force a microtask boundary so both callers race into the cache.
      await Promise.resolve();
      return stubBody();
    };

    const [a, b] = await Promise.all([
      readOrBuildAnalysisResult({
        cwd: tmp,
        build,
        opts: { resolveProvenance: () => provenance, cacheDir },
      }),
      readOrBuildAnalysisResult({
        cwd: tmp,
        build,
        opts: { resolveProvenance: () => provenance, cacheDir },
      }),
    ]);

    expect(calls).toBe(1);
    expect(a.commitSha).toBe(b.commitSha);
  });

  it('rebuilds when the commit SHA differs from the cached file', async () => {
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => makeProvenance({ commitSha: 'aaaaaaa' }), cacheDir },
    });
    clearInMemoryCache();
    const second = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => makeProvenance({ commitSha: 'bbbbbbb' }), cacheDir },
    });

    expect(calls).toBe(2);
    expect(second.commitSha).toBe('bbbbbbb');
    // Both files end up on disk — they're keyed by SHA, so different
    // commits coexist rather than overwriting.
    expect(fs.existsSync(path.join(cacheDir, 'analysis-result-aaaaaaa.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'analysis-result-bbbbbbb.json'))).toBe(true);
  });

  it('rebuilds when the .dxkit-ignore mtime differs', async () => {
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => makeProvenance({ ignoreFileMtime: 1_000_000 }),
        cacheDir,
      },
    });
    clearInMemoryCache();
    const second = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => makeProvenance({ ignoreFileMtime: 2_000_000 }),
        cacheDir,
      },
    });

    expect(calls).toBe(2);
    expect(second.ignoreFileMtime).toBe(2_000_000);
  });

  it('rebuilds when the dxkit version differs', async () => {
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => makeProvenance({ dxkitVersion: '2.4.7' }),
        cacheDir,
      },
    });
    clearInMemoryCache();
    const second = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => makeProvenance({ dxkitVersion: '2.4.8' }),
        cacheDir,
      },
    });

    expect(calls).toBe(2);
    expect(second.dxkitVersion).toBe('2.4.8');
  });

  it('rebuilds when the on-disk schema version is incompatible', async () => {
    const provenance = makeProvenance();
    // Hand-write a cache file with a bogus schema version.
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `analysis-result-${provenance.commitSha}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...stubBody(),
        commitSha: provenance.commitSha,
        branch: provenance.branch,
        cwd: provenance.cwd,
        builtAt: new Date().toISOString(),
        dxkitVersion: provenance.dxkitVersion,
        schemaVersion: 999,
        ignoreFileMtime: provenance.ignoreFileMtime,
        workingTreeDirty: false,
      }),
    );

    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };
    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });

    expect(calls).toBe(1);
    expect(result.schemaVersion).toBe(ANALYSIS_RESULT_SCHEMA_VERSION);
  });

  it('rebuilds and replaces a corrupt cache file', async () => {
    const provenance = makeProvenance();
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `analysis-result-${provenance.commitSha}.json`);
    fs.writeFileSync(file, '{ this is not valid json');

    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };
    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });

    expect(calls).toBe(1);
    expect(result.commitSha).toBe(provenance.commitSha);
    // File now contains the rebuilt result.
    const reparsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisResult;
    expect(reparsed.schemaVersion).toBe(ANALYSIS_RESULT_SCHEMA_VERSION);
  });

  it('rebuilds on every call when rescan: true', async () => {
    const provenance = makeProvenance();
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };

    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });
    clearInMemoryCache();
    await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir, rescan: true },
    });

    expect(calls).toBe(2);
  });

  it('does not persist to disk when the working tree is dirty', async () => {
    const provenance = makeProvenance({ workingTreeDirty: true });
    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build: async () => stubBody(),
      opts: { resolveProvenance: () => provenance, cacheDir },
    });

    expect(result.workingTreeDirty).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'analysis-result-abc1234.json'))).toBe(false);
  });

  it('ignores a stale on-disk cache when the current tree is dirty', async () => {
    // Seed the disk cache with a clean-tree entry first.
    const cleanProvenance = makeProvenance();
    await readOrBuildAnalysisResult({
      cwd: tmp,
      build: async () => stubBody(),
      opts: { resolveProvenance: () => cleanProvenance, cacheDir },
    });
    clearInMemoryCache();

    // Now invoke with dirty=true. Even though a cache file exists for
    // this SHA, the dirty flag means "the working tree no longer
    // represents that commit," so we rebuild rather than serve stale.
    let calls = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      calls++;
      return stubBody();
    };
    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: {
        resolveProvenance: () => makeProvenance({ workingTreeDirty: true }),
        cacheDir,
      },
    });

    expect(calls).toBe(1);
    expect(result.workingTreeDirty).toBe(true);
  });

  it('does not poison the in-memory cache when build throws', async () => {
    const provenance = makeProvenance();
    let attempts = 0;
    const build = async (): Promise<AnalysisResultBody> => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
      return stubBody();
    };

    await expect(
      readOrBuildAnalysisResult({
        cwd: tmp,
        build,
        opts: { resolveProvenance: () => provenance, cacheDir },
      }),
    ).rejects.toThrow(/first attempt fails/);

    // Second call should re-attempt rather than re-throwing the cached error.
    const result = await readOrBuildAnalysisResult({
      cwd: tmp,
      build,
      opts: { resolveProvenance: () => provenance, cacheDir },
    });
    expect(attempts).toBe(2);
    expect(result.commitSha).toBe(provenance.commitSha);
  });
});
