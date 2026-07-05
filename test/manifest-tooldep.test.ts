/**
 * recordToolDep — the manifest keeps tool deps as {package, ecosystem} only.
 * An older dxkit persisted a `"install": "npm install --save-dev …"` string,
 * misleading canonical JSON on a non-npm repo (all executed/rendered installs
 * are already PM-aware). A `tools install` now strips that legacy field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordToolDep } from '../src/tools-cli';

describe('recordToolDep — no npm-flavored install string in the manifest (#66)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-tooldep-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('strips a legacy install field from an existing entry on write', () => {
    const p = join(dir, '.vyuh-dxkit.json');
    writeFileSync(
      p,
      JSON.stringify(
        {
          version: '1',
          toolDeps: [
            {
              package: '@vitest/coverage-v8',
              ecosystem: 'node',
              install: 'npm install --save-dev @vitest/coverage-v8',
            },
          ],
        },
        null,
        2,
      ),
    );
    recordToolDep(dir, '@vitest/coverage-v8');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    expect(m.toolDeps).toEqual([{ package: '@vitest/coverage-v8', ecosystem: 'node' }]);
    expect(readFileSync(p, 'utf8')).not.toContain('--save-dev');
  });

  it('records a new dep as {package, ecosystem} only', () => {
    const p = join(dir, '.vyuh-dxkit.json');
    writeFileSync(p, JSON.stringify({ version: '1' }, null, 2));
    recordToolDep(dir, 'some-pkg');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    expect(m.toolDeps).toEqual([{ package: 'some-pkg', ecosystem: 'node' }]);
  });
});
