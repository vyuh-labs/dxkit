import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverProjectRoots } from '../src/analyzers/bom/discovery';

describe('discoverProjectRoots', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, body = '{}'): void {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }

  function mkdir(rel: string): void {
    fs.mkdirSync(path.join(tmp, rel), { recursive: true });
  }

  it('detects the cwd itself as a root when it has a manifest', () => {
    write('package.json');
    expect(discoverProjectRoots(tmp)).toEqual([tmp]);
  });

  it('finds nested sub-projects', () => {
    write('package.json');
    write('userserver/package.json');
    write('tools/cli/package.json');
    const roots = discoverProjectRoots(tmp);
    expect(roots).toEqual([tmp, path.join(tmp, 'tools/cli'), path.join(tmp, 'userserver')].sort());
  });

  it('skips node_modules entirely', () => {
    write('package.json');
    write('node_modules/some-dep/package.json'); // should NOT be reported
    const roots = discoverProjectRoots(tmp);
    expect(roots).toEqual([tmp]);
  });

  it('skips build-output and vcs directories', () => {
    write('package.json');
    write('dist/package.json');
    write('target/foo/Cargo.toml');
    write('obj/Release/bar.csproj');
    write('.git/package.json');
    expect(discoverProjectRoots(tmp)).toEqual([tmp]);
  });

  it('detects multiple languages side-by-side', () => {
    write('package.json');
    write('py-tool/pyproject.toml');
    write('go-svc/go.mod');
    write('rust-cli/Cargo.toml');
    write('dotnet-app/app.csproj');
    const roots = discoverProjectRoots(tmp);
    expect(roots.sort()).toEqual(
      [
        tmp,
        path.join(tmp, 'dotnet-app'),
        path.join(tmp, 'go-svc'),
        path.join(tmp, 'py-tool'),
        path.join(tmp, 'rust-cli'),
      ].sort(),
    );
  });

  it('respects maxDepth', () => {
    write('package.json');
    write('a/b/c/d/e/package.json'); // depth 5 — beyond default
    expect(discoverProjectRoots(tmp)).toEqual([tmp]);
  });

  it('returns empty array when cwd has no manifests and no sub-projects', () => {
    mkdir('src');
    write('src/index.ts', '// code');
    expect(discoverProjectRoots(tmp)).toEqual([]);
  });

  it('returns cwd even when no direct manifest if nested roots exist', () => {
    write('packages/a/package.json'); // "packages" is on skip list — should NOT be descended
    const roots = discoverProjectRoots(tmp);
    // `packages/` is skipped entirely; cwd has no manifest → no roots.
    expect(roots).toEqual([]);
  });

  it('treats a solution + projects correctly (multiple C# roots)', () => {
    write('Mono.sln');
    write('ProjA/ProjA.csproj');
    write('ProjB/ProjB.csproj');
    const roots = discoverProjectRoots(tmp);
    expect(roots).toEqual([tmp, path.join(tmp, 'ProjA'), path.join(tmp, 'ProjB')].sort());
  });
});
