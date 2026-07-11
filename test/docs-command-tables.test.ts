/**
 * The docs command table is a GENERATED discovery surface (CLAUDE.md
 * Rule 16): docs/README.md's "What you can run" table must equal what the
 * capability registry renders. This is the net for the drift class where a
 * new command ships without its docs row (the hand-maintained table had
 * silently lost `tests`, `hooks`, `checks`, and `demo` across waves) — an
 * out-of-date table fails here with a regenerate hint instead of shipping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userCommands } from '../src/discovery/commands';
import {
  DOCS_TABLE_BEGIN,
  DOCS_TABLE_END,
  renderDocsCommandTable,
  replaceDocsCommandTable,
} from '../src/discovery/docs-tables';

const ROOT = join(__dirname, '..');
const README = join(ROOT, 'docs', 'README.md');
const hasDocPage = (id: string) => existsSync(join(ROOT, 'docs', 'commands', `${id}.md`));

/**
 * Prettier pads table cells and dash rows; the renderer emits unpadded
 * markdown. Collapse both to a canonical form so the comparison is about
 * CONTENT, not column alignment.
 */
function normalize(block: string): string[] {
  return block
    .split('\n')
    .map((l) =>
      l
        .replace(/-{3,}/g, '---')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter((l) => l.length > 0);
}

describe('docs command table (registry-generated)', () => {
  it('docs/README.md table matches the capability registry — if this fails, run: npm run build && npm run docs:commands', () => {
    const content = readFileSync(README, 'utf8');
    const begin = content.indexOf(DOCS_TABLE_BEGIN);
    const end = content.indexOf(DOCS_TABLE_END);
    expect(begin, 'begin marker present').toBeGreaterThanOrEqual(0);
    expect(end, 'end marker after begin').toBeGreaterThan(begin);

    const committed = content.slice(begin + DOCS_TABLE_BEGIN.length, end);
    const rendered = renderDocsCommandTable(hasDocPage).join('\n');
    expect(normalize(committed)).toEqual(normalize(rendered));
  });

  it('every user-facing command has a row; internal commands have none', () => {
    const rendered = renderDocsCommandTable(hasDocPage).join('\n');
    for (const c of userCommands()) {
      expect(rendered, `row for ${c.id}`).toContain(`\`${c.id}\``);
    }
    for (const internal of ['context-hook', 'floor']) {
      expect(rendered).not.toContain(`\`${internal}\``);
    }
  });

  it('replaceDocsCommandTable throws loudly when markers are missing', () => {
    expect(() => replaceDocsCommandTable('no markers here', ['| a |'])).toThrow(/markers/);
  });

  it('a synthetic command injected into the registry lands in the rendered table (the generator stays registry-driven)', () => {
    const synthetic = {
      id: 'synthetic-docs-probe',
      audience: 'user',
      group: 'assess',
      summary: 'Synthetic docs-table probe',
      docsBlurb: 'Never shipped — proves rendering iterates its registry argument.',
      typicalRuntime: '< 1 sec',
    } as const;
    const rendered = renderDocsCommandTable(() => false, [...userCommands(), synthetic]).join('\n');
    expect(rendered).toContain('`synthetic-docs-probe`');
    expect(rendered).toContain('Synthetic docs-table probe');
  });
});
