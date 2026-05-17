import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { buildGraphifyEnvelope } from '../src/analyzers/tools/graphify';

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
    const cwd = '/home/sidc42/projects/external-repos/web-client';
    const abs =
      '/home/sidc42/projects/external-repos/web-client/public/3DFileViewer/assets/index.js';
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
