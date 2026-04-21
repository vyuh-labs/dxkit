import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReachable } from '../src/analyzers/tests/import-graph';
import { defaultDispatcher } from '../src/analyzers/dispatcher';

describe('buildReachable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-reach-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'test'));
    // The dispatcher caches per (cwd, capability); each tmpdir is unique
    // so no collision, but clearing is cheap insurance.
    defaultDispatcher.clearCache();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    defaultDispatcher.clearCache();
  });

  it('includes direct imports at hop 1', async () => {
    fs.writeFileSync(path.join(tmp, 'src/foo.ts'), '');
    fs.writeFileSync(path.join(tmp, 'test/a.test.ts'), "import { x } from '../src/foo';");
    const r = await buildReachable(['test/a.test.ts'], tmp, { maxHops: 1 });
    expect(r.has('src/foo.ts')).toBe(true);
  });

  it('follows transitive imports up to maxHops', async () => {
    fs.writeFileSync(path.join(tmp, 'src/c.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src/b.ts'), "export * from './c';");
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), "export * from './b';");
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import '../src/a';");

    // maxHops = 0 means "walk direct imports of the seeds only" (no transitive).
    const h0 = await buildReachable(['test/t.test.ts'], tmp, { maxHops: 0 });
    expect([...h0]).toEqual(['src/a.ts']);
    defaultDispatcher.clearCache();

    const h1 = await buildReachable(['test/t.test.ts'], tmp, { maxHops: 1 });
    expect(new Set(h1)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
    defaultDispatcher.clearCache();

    const h2 = await buildReachable(['test/t.test.ts'], tmp, { maxHops: 2 });
    expect(new Set(h2)).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']));
  });

  it('does not revisit already-reached files', async () => {
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), "export * from './b';");
    fs.writeFileSync(path.join(tmp, 'src/b.ts'), "export * from './a';"); // cycle
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import '../src/a';");
    const r = await buildReachable(['test/t.test.ts'], tmp, { maxHops: 10 });
    expect(new Set(r)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
  });

  it('returns empty set for seeds with no internal imports', async () => {
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import fs from 'fs';");
    const r = await buildReachable(['test/t.test.ts'], tmp);
    expect(r.size).toBe(0);
  });
});
