/**
 * Top-level dispatcher for the `vyuh-dxkit explore` subcommand family.
 * The CLI (`src/cli.ts`) routes `case 'explore'` here; this module
 * dispatches the inner subcommand to the appropriate handler.
 *
 * Six subcommands per the Sprint 0 design (`tmp/2.7-explore-cli-design.md`):
 *   - entry-points  — what does this repo do?
 *   - hot-files     — what's central? (top files by call in-degree)
 *   - file <path>   — drill into one file's neighborhood
 *   - feature <kw>  — where is X implemented?
 *   - communities   — natural-module summary
 *   - api-surface   — exported symbols with no internal callers
 *
 * Architecture:
 *   - This file owns argument parsing + subcommand routing only.
 *   - All graph data comes from `loadGraph(cwd)` (canonical loader,
 *     CLAUDE.md Rule 12).
 *   - All graph traversal flows through `./explore/queries.ts`
 *     (canonical query module, also Rule 12).
 *   - Output formatting (JSON envelope + markdown tables) flows
 *     through `./explore/format.ts`.
 *
 * Sprint 1 landed the loader + types + query primitives. Sprint 2
 * adds the high-level queries + subcommand handlers below as each
 * lands.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  GraphCorruptError,
  GraphNotFoundError,
  GraphSchemaVersionError,
  loadGraph,
} from './explore/load';
import { runApiSurface } from './explore/cli/api-surface';
import { runCommunities } from './explore/cli/communities';
import { runContext } from './explore/cli/context';
import { runEntryPoints } from './explore/cli/entry-points';
import { runFeature } from './explore/cli/feature';
import { runFile } from './explore/cli/file';
import { runHotFiles } from './explore/cli/hot-files';
import type { Graph } from './explore/types';

export interface ExploreCliValues {
  json?: boolean;
  limit?: string;
  refresh?: boolean;
  substring?: boolean;
  filter?: string;
  /** `context` only — token ceiling on the rendered subgraph. */
  budget?: string;
  /** `context` only — optional hard ceiling on BFS hop depth. */
  depth?: string;
}

/**
 * Entry point called from `src/cli.ts:case 'explore'`. Receives the
 * already-parsed `values` from the top-level `parseArgs` plus the
 * positional arguments after `'explore'` (subcommand name + any
 * subcommand-specific args).
 */
export async function runExplore(
  cwd: string,
  positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): Promise<void> {
  const subcommand = positionals[0];
  if (!subcommand) {
    printExploreHelp();
    return;
  }

  // Honor --refresh by regenerating graph.json before query. The
  // simplest implementation: shell out to `vyuh-dxkit health` (which
  // produces graph.json as a side effect via gatherLayer2Parallel).
  if (values.refresh) {
    await refreshGraph(cwd);
  }

  const graph = loadGraphOrExit(cwd);

  switch (subcommand) {
    case 'hot-files':
      runHotFiles(graph, positionals.slice(1), values);
      return;

    case 'communities':
      runCommunities(graph, positionals.slice(1), values);
      return;

    case 'file':
      runFile(graph, positionals.slice(1), values, cwd);
      return;

    case 'entry-points':
      runEntryPoints(graph, positionals.slice(1), values, cwd);
      return;

    case 'api-surface':
      runApiSurface(graph, positionals.slice(1), values);
      return;

    case 'feature':
      runFeature(graph, positionals.slice(1), values);
      return;

    case 'context':
      runContext(graph, positionals.slice(1), values, cwd);
      return;

    case 'help':
    case '--help':
    case '-h':
      printExploreHelp();
      return;

    default:
      process.stderr.write(`Unknown explore subcommand: ${subcommand}\n\n`);
      printExploreHelp();
      process.exit(1);
  }
}

/**
 * Load the graph and exit with a typed error message on failure.
 * Centralized so every subcommand gets the same diagnostic prose +
 * exit codes per the Sprint 0 spec (2 = not found, 3 = schema
 * mismatch, 4 = corrupt).
 */
function loadGraphOrExit(cwd: string): Graph {
  try {
    return loadGraph(cwd);
  } catch (err) {
    if (err instanceof GraphNotFoundError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof GraphSchemaVersionError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(3);
    }
    if (err instanceof GraphCorruptError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(4);
    }
    throw err;
  }
}

/**
 * Shell out to `vyuh-dxkit health` to regenerate graph.json. Uses
 * the locally-installed dxkit (resolved via the same `bin` script
 * the user invoked). Output streams through to the terminal so the
 * user sees the health run's progress.
 */
async function refreshGraph(cwd: string): Promise<void> {
  // Resolve the current dxkit entry point. The caller's CLI script
  // lives at one of two places depending on install flavor; both
  // resolve via the same node entry.
  const dxkitBin = resolveDxkitBin();
  return new Promise<void>((resolve, reject) => {
    const child = spawn('node', [dxkitBin, 'health', cwd], {
      stdio: 'inherit',
      cwd,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vyuh-dxkit health exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function resolveDxkitBin(): string {
  // dist/explore-cli.js → dist/index.js
  const distEntry = path.resolve(__dirname, 'index.js');
  if (existsSync(distEntry)) return distEntry;
  // Fallback for local dev where __dirname might be elsewhere.
  return 'node_modules/@vyuhlabs/dxkit/dist/index.js';
}

function printExploreHelp(): void {
  process.stderr.write(`
vyuh-dxkit explore <subcommand> [args] [flags]

Subcommands:
  hot-files                Files most depended on (top by call in-degree)
  entry-points             Route handlers / controllers / forms
  file <path>              Symbols + callers/callees for one file
  feature <keyword>        Where is feature X implemented?
  communities              Natural-module clusters
  api-surface              Exported symbols with no internal callers
  context <query>          Slim structural slice for a query (token-reduction;
                           also available as the top-level 'vyuh-dxkit context')
  context <file:line>      Focused source chunk around a location + its callers
                           /callees (read ~the enclosing symbol, not the file)

Flags (all subcommands):
  --json                   Emit structured JSON envelope
  --limit N                Cap result count (per-subcommand defaults)
  --refresh                Force-regenerate graph.json before query

context-only flags:
  --budget N               Token ceiling on the slice / source chunk (default 2000)
  --depth N                Hard ceiling on call-graph hops (query form; default: budget-bounded)
  --substring              Broaden keyword matching to substrings (query form)

Reads from .dxkit/reports/graph.json. Run \`vyuh-dxkit health\` first
to generate the artifact.
`);
}
