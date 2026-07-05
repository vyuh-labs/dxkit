/**
 * Framework rule templates must be layout-agnostic: their `paths:` frontmatter
 * has to match the framework's files wherever they live in the repo, not one
 * hardcoded subdirectory. The `nextjs.md` template previously scoped to
 * `frontend/**` only, so on a single-app-at-root repo the rule matched no files
 * and never activated (dead on arrival). This guards against that regression.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const RULES_DIR = join(__dirname, '..', 'src-templates', '.claude', 'rules');

function pathsBlock(file: string): string {
  const content = readFileSync(join(RULES_DIR, file), 'utf8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  return fm ? fm[1] : '';
}

describe('framework rule templates are layout-agnostic', () => {
  it('nextjs.md does not lock its paths to a single subdirectory', () => {
    const paths = pathsBlock('nextjs.md');
    // No hardcoded `frontend/` prefix — that made the rule dead on arrival when
    // the Next.js app lived at the repo root (or src/, apps/web, …).
    expect(paths).not.toMatch(/frontend\//);
    // Matches Next.js files at any depth (the `**/` prefix spans root + nested).
    expect(paths).toMatch(/\*\*\/app\//);
  });

  it('nextjs.md build guidance is not hardcoded to npm in frontend/', () => {
    const content = readFileSync(join(RULES_DIR, 'nextjs.md'), 'utf8');
    expect(content).not.toMatch(/`npm run build` in `frontend\/`/);
  });
});
