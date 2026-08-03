/**
 * The transport-neutral repo tool registry (tier-2 repo intelligence,
 * issue #254). ONE registry of read-only point-query tools, consumed by
 * every transport: the learn assistant's relay tool loop today, the
 * `vyuh-dxkit mcp` server next (Rule 2 — one concept, one code path).
 *
 * Trust rules, all load-bearing (settled in #254):
 *   - READ-ONLY: no tool mutates anything, executes a policy command, or
 *     touches the one write path. The registry has no write tier.
 *   - No model output in any verdict: tools REPORT what dxkit computed;
 *     the gate never consumes anything that came through here.
 *   - Every tool result is relayed to the user's provider — the caller
 *     surfaces a per-call ledger so nothing is sent silently.
 *   - Contributor NAMES are detail-tier data: with the detail toggle off,
 *     history/ownership tools return counts and dates only.
 *   - Absent capability → the exact enable command, never an error and
 *     never pretending (the doctor-recommend pattern).
 *
 * Every tool body goes through the canonical seams: graph via
 * `tryLoadGraph` + `queries.ts` (Rule 12), ownership via `ownersFor`
 * (the one active-owner model), baselines via `readBaselineFile`.
 * Git history is the one direct spawn (execFileSync, args array, no
 * shell) with a leading-dash + traversal guard on every path argument.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { tryLoadGraph } from '../explore/load';
import {
  affectedTestsQuery,
  calleesOf,
  callersOf,
  fileSummaryQuery,
  nodesInFile,
  symbolLookup,
} from '../explore/queries';
import type { Graph } from '../explore/types';
import { ownersFor } from '../analyzers/developer/ownership';
import { readBaselineFile } from '../baseline/baseline-file';

/** JSON-Schema subset both provider wires (and MCP) accept verbatim. */
export interface AgentToolSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

export interface AgentToolContext {
  cwd: string;
  /** Detail toggle: contributor names ride only when true. */
  detail: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: AgentToolSchema;
  /** Executes the read and returns TEXT for the model. The repo + privacy
   *  context is captured when the registry is built. Never throws:
   *  absence and errors come back as explanatory pointer text. */
  run(args: Record<string, unknown>): string;
}

/** One executed call, for the per-call disclosure ledger. */
export interface ToolLedgerEntry {
  tool: string;
  /** Compact rendering of the arguments (already validated). */
  args: string;
  /** Size of the text returned to the provider. */
  resultChars: number;
}

const GRAPH_ABSENT =
  "The code graph is not set up in this repo, so this question cannot be answered from structure. Tell the user to run 'vyuh-dxkit describe' (one-off) or set the graph.refresh policy field (kept fresh in CI), then ask again.";

const LIMIT = 20;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Repo-relative path guard: rejects absolute paths, traversal, and a
 *  leading dash (argument injection). Returns null on any violation. */
function safeRelPath(cwd: string, p: string): string | null {
  if (!p || p.startsWith('-') || p.startsWith('/') || p.includes('..') || p.includes('\0')) {
    return null;
  }
  const abs = path.resolve(cwd, p);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) return null;
  return p;
}

function withGraph(cwd: string, fn: (g: Graph) => string): string {
  const graph = tryLoadGraph(cwd);
  if (!graph) return GRAPH_ABSENT;
  return fn(graph);
}

function resolveSymbol(graph: Graph, name: string): { text?: string; ids?: string[] } {
  const lookup = symbolLookup(graph, name);
  if (lookup.nodes.length === 0) {
    return {
      text:
        lookup.suggestions.length > 0
          ? `No symbol named '${name}' in the graph. Closest matches: ${lookup.suggestions.join(', ')}.`
          : `No symbol named '${name}' in the graph, and no close matches.`,
    };
  }
  return { ids: lookup.nodes.map((n) => n.id) };
}

function nodeLine(g: Graph, id: string): string {
  const n = g.nodeById.get(id);
  return n ? `${n.label} (${n.sourceFile}${n.line ? `:${n.line}` : ''})` : id;
}

/** Injectable for tests. Args array, no shell; bounded; read-only. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

/**
 * Build the registry for one repo + privacy context. Repo mode only —
 * the zero-context page gets no tools.
 */
export function agentTools(
  ctx: AgentToolContext,
  gitRunner: GitRunner = defaultGitRunner,
): AgentTool[] {
  const callers: AgentTool = {
    name: 'function_callers',
    description:
      'Who calls this function/method? Returns the callers with their source files, from the committed code graph.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Function or method name' } },
      required: ['symbol'],
    },
    run: (args) =>
      withGraph(ctx.cwd, (g) => {
        const symbol = str(args, 'symbol');
        const r = resolveSymbol(g, symbol);
        if (r.text) return r.text;
        const out: string[] = [];
        for (const id of r.ids ?? []) {
          const cs = callersOf(g, id);
          out.push(
            `${nodeLine(g, id)}: ${cs.length} caller(s)${
              cs.length
                ? ' — ' +
                  cs
                    .slice(0, LIMIT)
                    .map((n) => `${n.label} (${n.sourceFile})`)
                    .join(', ')
                : ''
            }${cs.length > LIMIT ? ` … ${cs.length - LIMIT} more` : ''}`,
          );
        }
        return out.join('\n');
      }),
  };

  const callees: AgentTool = {
    name: 'function_callees',
    description:
      'What does this function/method call? Returns the callees with their source files, from the committed code graph.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Function or method name' } },
      required: ['symbol'],
    },
    run: (args) =>
      withGraph(ctx.cwd, (g) => {
        const symbol = str(args, 'symbol');
        const r = resolveSymbol(g, symbol);
        if (r.text) return r.text;
        const out: string[] = [];
        for (const id of r.ids ?? []) {
          const cs = calleesOf(g, id);
          out.push(
            `${nodeLine(g, id)}: calls ${cs.length} symbol(s)${
              cs.length
                ? ' — ' +
                  cs
                    .slice(0, LIMIT)
                    .map((n) => `${n.label} (${n.sourceFile})`)
                    .join(', ')
                : ''
            }${cs.length > LIMIT ? ` … ${cs.length - LIMIT} more` : ''}`,
          );
        }
        return out.join('\n');
      }),
  };

  const blast: AgentTool = {
    name: 'file_blast_radius',
    description:
      'What does changing this file reach? Returns the file symbol summary plus the test files that transitively exercise it, from the committed code graph.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Repo-relative source file path' },
      },
      required: ['file'],
    },
    run: (args) =>
      withGraph(ctx.cwd, (g) => {
        const file = safeRelPath(ctx.cwd, str(args, 'file'));
        if (!file) return 'Invalid file path (must be repo-relative, no traversal).';
        if (nodesInFile(g, file).length === 0) {
          return `No symbols from '${file}' are in the graph (not a source file, brand new, or a graph gap). Its impact is not graph-derivable.`;
        }
        const summary = fileSummaryQuery(g, file);
        const tests = affectedTestsQuery(g, [file]);
        const lines = [
          `${file}: ${summary.symbols.length} symbol(s)`,
          ...summary.symbols
            .slice(0, LIMIT)
            .map((s) => `  ${s.label}: ${s.callsIn} caller(s) in, ${s.callsOut} callee(s) out`),
          `tests transitively reaching this file: ${tests.testFiles.length}${tests.testFiles.length ? ' — ' + tests.testFiles.slice(0, LIMIT).join(', ') : ''}`,
        ];
        if (tests.untraceable.length > 0) {
          lines.push(`untraceable (graph cannot account for): ${tests.untraceable.join(', ')}`);
        }
        return lines.join('\n');
      }),
  };

  const whoEdited: AgentTool = {
    name: 'file_history',
    description:
      'Recent change history of a file (optionally a line range). Counts and dates by default; author names appear only when the user has the detail toggle on.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Repo-relative file path' },
        startLine: { type: 'number', description: 'Optional start line' },
        endLine: { type: 'number', description: 'Optional end line' },
      },
      required: ['file'],
    },
    run: (args) => {
      const file = safeRelPath(ctx.cwd, str(args, 'file'));
      if (!file) return 'Invalid file path (must be repo-relative, no traversal).';
      if (!fs.existsSync(path.join(ctx.cwd, file))) return `No such file: ${file}`;
      const start =
        typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : null;
      const end =
        typeof args.endLine === 'number' ? Math.max(start ?? 1, Math.floor(args.endLine)) : start;
      const gitArgs =
        start !== null
          ? [
              'log',
              '--no-merges',
              '--format=%aN%x1f%aI%x1f%s',
              '-n',
              '10',
              `-L${start},${end}:${file}`,
              '--no-patch',
            ]
          : ['log', '--no-merges', '--format=%aN%x1f%aI%x1f%s', '-n', '10', '--follow', '--', file];
      const out = gitRunner(gitArgs, ctx.cwd);
      if (!out) return `No git history readable for ${file}.`;
      const rows = out
        .split('\n')
        .filter((l) => l.includes('\x1f'))
        .map((l) => {
          const [name, date, subject] = l.split('\x1f');
          return { name: name ?? '', date: (date ?? '').slice(0, 10), subject: subject ?? '' };
        });
      if (rows.length === 0) return `No git history readable for ${file}.`;
      const authors = new Set(rows.map((r) => r.name));
      const range = start !== null ? `${file}:${start}-${end}` : file;
      if (!ctx.detail) {
        return `${range}: ${rows.length} recent commit(s) by ${authors.size} author(s); latest ${rows[0].date}, oldest shown ${rows[rows.length - 1].date}. Author names are behind the detail toggle — the user can turn it on to include them.`;
      }
      return [
        `${range}: ${rows.length} recent commit(s) by ${authors.size} author(s)`,
        ...rows.map((r) => `  ${r.date} ${r.name}: ${r.subject}`),
      ].join('\n');
    },
  };

  const owners: AgentTool = {
    name: 'file_owners',
    description:
      'Who owns this file (active, recency-weighted git ownership + bus factor)? Counts by default; owner names appear only when the user has the detail toggle on.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Repo-relative file path' } },
      required: ['file'],
    },
    run: (args) => {
      const file = safeRelPath(ctx.cwd, str(args, 'file'));
      if (!file) return 'Invalid file path (must be repo-relative, no traversal).';
      const ownership = ownersFor(ctx.cwd, [file]);
      if (ownership.ranked.length === 0) return `No git ownership signal for ${file}.`;
      const active = ownership.ranked.filter((o) => o.active);
      const head = `${file}: ${ownership.ranked.length} owner(s) (${active.length} active), bus factor ${ownership.busFactor}${ownership.allInactive ? ' — everyone who knows this file has gone quiet repo-wide' : ''}`;
      if (!ctx.detail) {
        return `${head}. Owner names are behind the detail toggle — the user can turn it on to include them.`;
      }
      return [
        head,
        ...ownership.ranked
          .slice(0, 5)
          .map(
            (o) =>
              `  ${o.name}${o.githubHandle ? ` (@${o.githubHandle})` : ''}: ${o.commits} commit(s), last touched ${o.lastTouched.slice(0, 10)}${o.active ? '' : ', inactive'}`,
          ),
      ].join('\n');
    },
  };

  const debt: AgentTool = {
    name: 'debt_findings',
    description:
      'List grandfathered findings from the committed baseline, optionally filtered by kind (secret, code, dep-vuln, …) or file substring. Top 20 with location and severity.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Optional finding kind filter' },
        file: { type: 'string', description: 'Optional file-path substring filter' },
      },
    },
    run: (args) => {
      const dir = path.join(ctx.cwd, '.dxkit', 'baselines');
      const kind = str(args, 'kind');
      const fileFilter = str(args, 'file');
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        return "No committed baseline in this repo (ref-based repos gate against a git ref instead). 'vyuh-dxkit baseline create' writes one; 'vyuh-dxkit debt' needs it too.";
      }
      const rows: string[] = [];
      let total = 0;
      for (const f of names) {
        try {
          const file = readBaselineFile(path.join(dir, f));
          for (const e of file.findings) {
            if (kind && e.kind !== kind) continue;
            const loc =
              'file' in e && typeof e.file === 'string'
                ? `${e.file}${'line' in e && e.line ? `:${e.line}` : ''}`
                : 'package' in e && typeof e.package === 'string'
                  ? e.package
                  : '';
            if (fileFilter && !loc.includes(fileFilter)) continue;
            total++;
            if (rows.length < LIMIT) {
              const sev = 'severity' in e && e.severity ? ` [${e.severity}]` : '';
              rows.push(`  ${e.kind}${sev} ${loc}`);
            }
          }
        } catch {
          // Unreadable baseline file: skip; the profile already disclosed it.
        }
      }
      if (total === 0) {
        return kind || fileFilter
          ? `No grandfathered findings match (kind='${kind || 'any'}', file~'${fileFilter || 'any'}').`
          : 'The committed baseline has no findings.';
      }
      return [
        `${total} grandfathered finding(s)${kind ? ` of kind ${kind}` : ''}${fileFilter ? ` matching ~'${fileFilter}'` : ''}${total > LIMIT ? ` (showing ${LIMIT})` : ''}:`,
        ...rows,
        `Full prioritized inventory: 'vyuh-dxkit debt'.`,
      ].join('\n');
    },
  };

  return [callers, callees, blast, whoEdited, owners, debt];
}
