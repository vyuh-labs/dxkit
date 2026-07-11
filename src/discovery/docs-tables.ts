/**
 * Registry-generated docs command table (CLAUDE.md Rule 16 — generated docs
 * are a discovery surface of the capability registry, same as the help index
 * and the capability catalog).
 *
 * The "What you can run" table in `docs/README.md` is rendered from
 * `COMMANDS`, between marker comments, so a new command cannot ship without
 * its docs row — the drift class this closes: the hand-maintained table had
 * silently lost `tests`, `hooks`, `checks`, and `demo` across waves.
 *
 * Writers: `npm run docs:commands` (scripts/generate-command-docs.js)
 * rewrites the marked block. `test/docs-command-tables.test.ts` pins the
 * committed block against this renderer, so an out-of-date table fails CI
 * with a regenerate hint instead of shipping stale.
 */
import { GROUP_ORDER, userCommands } from './commands';
import type { CapabilityDescriptor } from './command-types';

/** Marker pair delimiting the generated block in docs/README.md. */
export const DOCS_TABLE_BEGIN =
  '<!-- dxkit:command-table:begin — generated from src/discovery/command-defs.ts by `npm run docs:commands`; do not edit by hand -->';
export const DOCS_TABLE_END = '<!-- dxkit:command-table:end -->';

/**
 * Render the docs command table as markdown lines (no surrounding markers).
 * `hasDocPage` is injected (fs probe in production, fixture in tests): a
 * command with a page under `docs/commands/<id>.md` gets a linked name.
 * Rows are ordered by the help-index group order, registry order within a
 * group — one ordering everywhere.
 */
export function renderDocsCommandTable(
  hasDocPage: (id: string) => boolean,
  commands: readonly CapabilityDescriptor[] = userCommands(),
): string[] {
  // A literal `|` inside a cell (e.g. `report snapshot|history`) would split
  // the markdown column — escape it.
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines: string[] = ['| Command | What it does | Typical runtime |', '| --- | --- | --- |'];
  for (const group of GROUP_ORDER) {
    for (const c of commands.filter((x) => x.group === group)) {
      const name = hasDocPage(c.id) ? `[\`${c.id}\`](commands/${c.id}.md)` : `\`${c.id}\``;
      lines.push(`| ${name} | ${cell(c.summary)} | ${cell(c.typicalRuntime ?? '')} |`);
    }
  }
  return lines;
}

/**
 * Replace the marked block inside a docs file's content with freshly
 * rendered table lines. Throws loudly when the markers are missing or
 * malformed — a silently-skipped rewrite is the drift this exists to stop.
 */
export function replaceDocsCommandTable(content: string, tableLines: string[]): string {
  const begin = content.indexOf(DOCS_TABLE_BEGIN);
  const end = content.indexOf(DOCS_TABLE_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs command-table markers not found or out of order (expected "${DOCS_TABLE_BEGIN}" before "${DOCS_TABLE_END}")`,
    );
  }
  const before = content.slice(0, begin);
  const after = content.slice(end + DOCS_TABLE_END.length);
  return `${before}${DOCS_TABLE_BEGIN}\n\n${tableLines.join('\n')}\n\n${DOCS_TABLE_END}${after}`;
}
