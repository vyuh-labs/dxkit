import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { buildGraphifyEnvelope, buildGraphifyScript } from '../src/analyzers/tools/graphify';

// Minimal valid GraphifyResult shape — only maxFunctionsFilePath is
// path-bearing; the other fields are numeric counts the envelope
// passes through unchanged.
function syntheticResult(maxFunctionsFilePath: string) {
  return {
    functionCount: 100,
    classCount: 10,
    maxFunctionsInFile: 50,
    maxFunctionsFilePath,
    godNodeCount: 2,
    communityCount: 5,
    avgCohesion: 0.75,
    orphanModuleCount: 3,
    deadImportCount: 1,
    commentedCodeRatio: 0.1,
    sourceFilesInGraph: 200,
  };
}

describe('buildGraphifyEnvelope', () => {
  it('normalizes an absolute maxFunctionsFilePath into a project-relative path', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const abs = path.join(cwd, 'src', 'components', 'big.tsx');
    const env = buildGraphifyEnvelope(syntheticResult(abs), cwd);
    expect(env.maxFunctionsFilePath).toBe('src/components/big.tsx');
    expect(env.maxFunctionsFilePath.startsWith('/')).toBe(false);
  });

  it('passes through an already-relative maxFunctionsFilePath unchanged in shape', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const env = buildGraphifyEnvelope(syntheticResult('src/util.ts'), cwd);
    expect(env.maxFunctionsFilePath).toBe('src/util.ts');
  });

  it('emits an empty string when the Python helper reports no max-functions file', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const env = buildGraphifyEnvelope(syntheticResult(''), cwd);
    expect(env.maxFunctionsFilePath).toBe('');
  });

  it('strips a username-shaped absolute prefix that would otherwise leak into customer reports', () => {
    // Regression pin for the customer-visible bug: rendered markdown
    // showed `Densest file: /home/<auditor>/projects/.../foo.ts`.
    // The envelope is the single chokepoint that prevents the leak.
    const cwd = '/home/auditor/projects/repos/frontend';
    const abs = '/home/auditor/projects/repos/frontend/public/3DFileViewer/assets/index.js';
    const env = buildGraphifyEnvelope(syntheticResult(abs), cwd);
    expect(env.maxFunctionsFilePath).toBe('public/3DFileViewer/assets/index.js');
    expect(env.maxFunctionsFilePath.includes('/home/')).toBe(false);
  });

  it('preserves non-path fields verbatim', () => {
    const env = buildGraphifyEnvelope(syntheticResult('src/x.ts'), '/tmp/repo');
    expect(env.functionCount).toBe(100);
    expect(env.classCount).toBe(10);
    expect(env.maxFunctionsInFile).toBe(50);
    expect(env.godNodeCount).toBe(2);
    expect(env.communityCount).toBe(5);
    expect(env.avgCohesion).toBe(0.75);
    expect(env.orphanModuleCount).toBe(3);
    expect(env.deadImportCount).toBe(1);
    expect(env.commentedCodeRatio).toBe(0.1);
    expect(env.tool).toBe('graphify');
    expect(env.schemaVersion).toBe(1);
  });
});

/**
 * Structural contract of the generated Python script. These guard the
 * Python 3.14 multiprocessing and graphifyy cache-redirect
 * fixes at the source level, so a regression is caught in CI even where
 * graphify isn't installed and the script can't actually be run.
 */
describe('buildGraphifyScript — Python 3.14 / cache-redirect contract', () => {
  const script = buildGraphifyScript('/tmp/repo');

  it("guards execution behind `if __name__ == '__main__'` ", () => {
    // ProcessPoolExecutor workers re-import the module under spawn/forkserver
    // (Python 3.14's Linux default). Without the guard, top-level extraction
    // re-runs per worker → BrokenProcessPool / crash.
    expect(script).toContain("if __name__ == '__main__':");
    // The extraction call must sit inside the guard (indented), not at module
    // top level.
    expect(script).toMatch(/\n {4}result = extract\(/);
  });

  it('redirects the cache via the public cache_root param, not a monkeypatch', () => {
    expect(script).toContain('extract(files, cache_root=_cache_dir)');
    // The fragile internal-signature monkeypatch must be gone — it broke when
    // graphifyy 0.8 changed cache_dir(root) → cache_dir(root, kind).
    expect(script).not.toContain('_gc.cache_dir');
    expect(script).not.toContain('import graphify.cache');
  });

  it('does not force a multiprocessing start method (the if-__main__ guard makes it unnecessary)', () => {
    // The old `set_start_method('fork')` hack only papered over the missing
    // guard on Linux and silently failed on spawn-default platforms.
    expect(script).not.toContain('set_start_method');
  });

  it('takes the cache dir from argv[2] so the TS caller owns its lifecycle', () => {
    // graphify flushes a stat-index via atexit (after the script body), so the
    // temp cache is reclaimed by the TS layer's scriptDir cleanup, not a
    // Python-side rmtree that the atexit write would undo.
    expect(script).toContain('_cache_dir = Path(sys.argv[2])');
    expect(script).not.toContain('tempfile.mkdtemp');
  });
});
