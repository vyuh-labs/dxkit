import { describe, it, expect } from 'vitest';
import { buildGoTopLevelDepIndex, parseGoModDirectDeps } from '../src/languages/go';

// Fixture format mirrors `go mod graph` output (line-oriented
// "src dst" where each token is `module@version` except the root
// module which has no `@version`). Used in lieu of live `go` on
// dev machine; 10h.5 release-time validation runs the pipeline.

describe('buildGoTopLevelDepIndex', () => {
  it('returns empty map on empty input', () => {
    expect(buildGoTopLevelDepIndex('').size).toBe(0);
    expect(buildGoTopLevelDepIndex('   \n   ').size).toBe(0);
  });

  it('attributes a direct dep to itself', () => {
    const raw = ['example.com/me github.com/pkg/errors@v0.9.1'].join('\n');
    const idx = buildGoTopLevelDepIndex(raw);
    expect(idx.get('github.com/pkg/errors')).toEqual(['github.com/pkg/errors']);
  });

  it('attributes transitives to their top-level ancestor', () => {
    const raw = [
      'example.com/me github.com/gin-gonic/gin@v1.9.0',
      'github.com/gin-gonic/gin@v1.9.0 github.com/go-playground/validator@v10.0.0',
      'github.com/go-playground/validator@v10.0.0 golang.org/x/crypto@v0.1.0',
    ].join('\n');
    const idx = buildGoTopLevelDepIndex(raw);
    expect(idx.get('github.com/gin-gonic/gin')).toEqual(['github.com/gin-gonic/gin']);
    expect(idx.get('github.com/go-playground/validator')).toEqual(['github.com/gin-gonic/gin']);
    expect(idx.get('golang.org/x/crypto')).toEqual(['github.com/gin-gonic/gin']);
  });

  it('unions attributions across multiple top-level deps', () => {
    // crypto reachable via both gin and mux (two direct deps).
    const raw = [
      'example.com/me github.com/gin-gonic/gin@v1.9.0',
      'example.com/me github.com/gorilla/mux@v1.8.0',
      'github.com/gin-gonic/gin@v1.9.0 golang.org/x/crypto@v0.1.0',
      'github.com/gorilla/mux@v1.8.0 golang.org/x/crypto@v0.2.0',
    ].join('\n');
    const idx = buildGoTopLevelDepIndex(raw);
    expect(idx.get('golang.org/x/crypto')).toEqual([
      'github.com/gin-gonic/gin',
      'github.com/gorilla/mux',
    ]);
  });

  it('collapses versions — same package name across versions attributes to both paths', () => {
    // Two different versions of crypto reached through different paths
    // yield a single `golang.org/x/crypto` key (coarse name-level
    // attribution). Matches TS/Rust pack behavior.
    const raw = [
      'example.com/me a@v1.0',
      'example.com/me b@v1.0',
      'a@v1.0 golang.org/x/crypto@v0.1.0',
      'b@v1.0 golang.org/x/crypto@v0.5.0',
    ].join('\n');
    const idx = buildGoTopLevelDepIndex(raw);
    expect(idx.get('golang.org/x/crypto')).toEqual(['a', 'b']);
  });

  it('returns empty map when no root line is present', () => {
    // Every source token carries @version → no detectable root.
    const raw = 'a@v1 b@v1\nb@v1 c@v1';
    expect(buildGoTopLevelDepIndex(raw).size).toBe(0);
  });

  it('handles cycles safely', () => {
    const raw = [
      'example.com/me a@v1',
      'a@v1 b@v1',
      'b@v1 a@v1', // cycle back
    ].join('\n');
    const idx = buildGoTopLevelDepIndex(raw);
    expect(idx.get('a')).toEqual(['a']);
    expect(idx.get('b')).toEqual(['a']);
  });

  it('filters root children by the supplied direct-deps set', () => {
    // Graph says root has two children; direct-deps list names only one.
    // Indirect child (`b`) should not appear as a top-level; its
    // descendants should not get `b` as an attribution parent.
    const raw = [
      'example.com/me a@v1',
      'example.com/me b@v1', // indirect — auto-added by go mod tidy
      'a@v1 c@v1',
      'b@v1 d@v1',
    ].join('\n');
    const idx = buildGoTopLevelDepIndex(raw, ['a']);
    expect(idx.get('a')).toEqual(['a']);
    expect(idx.get('c')).toEqual(['a']);
    // b + d aren't attributed because b was filtered out of seeds.
    expect(idx.has('b')).toBe(false);
    expect(idx.has('d')).toBe(false);
  });

  it('empty directDeps array behaves like no filter (backward-compat)', () => {
    const raw = 'example.com/me a@v1\nexample.com/me b@v1';
    const idx = buildGoTopLevelDepIndex(raw, []);
    expect(idx.get('a')).toEqual(['a']);
    expect(idx.get('b')).toEqual(['b']);
  });
});

describe('parseGoModDirectDeps', () => {
  it('returns empty array on empty input', () => {
    expect(parseGoModDirectDeps('')).toEqual([]);
  });

  it('parses single-line require', () => {
    const raw = ['module example.com/me', '', 'go 1.21', '', 'require foo.com/bar v1.2.3'].join(
      '\n',
    );
    expect(parseGoModDirectDeps(raw)).toEqual(['foo.com/bar']);
  });

  it('parses require block with indirect filtering', () => {
    const raw = [
      'module example.com/me',
      '',
      'require (',
      '\tfoo.com/bar v1.0',
      '\tbaz.com/qux v2.0 // indirect',
      '\tdirect.io/dep v3.0',
      '\tindirect.io/dep v3.0 //indirect', // no-space variant',
      ')',
    ].join('\n');
    expect(parseGoModDirectDeps(raw)).toEqual(['foo.com/bar', 'direct.io/dep']);
  });

  it('handles mixed single-line + block declarations', () => {
    const raw = [
      'module example.com/me',
      '',
      'require solo.com/dep v1.0',
      '',
      'require (',
      '\tfirst.com/dep v1.0',
      '\tsecond.com/dep v2.0 // indirect',
      ')',
    ].join('\n');
    expect(parseGoModDirectDeps(raw)).toEqual(['solo.com/dep', 'first.com/dep']);
  });

  it('ignores stray lines (module, go, replace, exclude)', () => {
    const raw = [
      'module example.com/me',
      'go 1.21',
      'replace old.com/x => new.com/x v1.0',
      'exclude bad.com/y v1.0',
      'require foo.com/bar v1.0',
    ].join('\n');
    expect(parseGoModDirectDeps(raw)).toEqual(['foo.com/bar']);
  });
});
