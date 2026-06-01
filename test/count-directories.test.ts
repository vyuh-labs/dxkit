import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countDirectories, clearWalkCache } from '../src/analyzers/tools/walk-source-files';

/**
 * countDirectories must mirror `find . -type d` with the centralized
 * directory excludes: the root counts, non-excluded subdirs count and
 * recurse, and an excluded directory (node_modules, .git, …) counts its
 * ENTRY once but is not descended into — find's path-exclude emits the
 * directory itself and filters only its contents.
 */
describe('countDirectories', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-countdirs-'));
    clearWalkCache();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearWalkCache();
  });

  it('counts only the root for an empty directory', () => {
    expect(countDirectories(root)).toBe(1);
  });

  it('counts non-excluded subdirectories and recurses', () => {
    fs.mkdirSync(path.join(root, 'src', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'));
    // root + src + src/inner + lib = 4
    expect(countDirectories(root)).toBe(4);
  });

  it('counts an excluded dir entry once but does not descend into it', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg', 'deep'), { recursive: true });
    // root + src + node_modules(entry only) = 3 — the pkg/deep tree under
    // node_modules is NOT counted (matches `find -not -path "*/node_modules/*"`).
    expect(countDirectories(root)).toBe(3);
  });
});
