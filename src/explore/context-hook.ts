/**
 * `vyuh-dxkit context-hook` — the Claude Code PreToolUse hook that
 * delivers the token-reduction win passively. Wired into a scaffolded
 * repo's `.claude/settings.json` with a `Grep|Glob` matcher: when an
 * agent is about to search the codebase, this hook injects a slim
 * structural map as `additionalContext` so the agent needs fewer
 * follow-up whole-file reads.
 *
 * THE CONTRACT IS FAIL-OPEN + ADDITIVE. This hook can only ever ADD
 * context; it never blocks the tool, never replaces grep output, and
 * stays a silent no-op (exit 0, no stdout) on ANY problem — missing
 * graph.json, parse error, no keyword match, unreadable stdin. So
 * Claude Code behaves exactly as it does today whenever the graph is
 * absent or unhelpful; the hook is pure upside.
 *
 * Claude Code passes the tool call as JSON on stdin
 * (`{ tool_name, tool_input: { pattern, ... }, ... }`) and reads a
 * JSON object on stdout with `hookSpecificOutput.additionalContext`.
 */

import { contextQuery, type ContextResult } from './queries';
import { tryLoadGraph } from './load';
import type { Graph } from './types';

/** Stingier than the manual CLI's 2000 — the hook fires on every grep. */
const HOOK_BUDGET = 1500;

/**
 * Entry point for `case 'context-hook'`. Reads stdin, runs the query,
 * writes the hook output. Wrapped so nothing it does can fail the
 * tool call: every failure path resolves to a silent no-op.
 */
export async function runContextHook(cwd: string): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;

    const pattern = extractPattern(raw);
    if (!pattern) return;

    const graph = tryLoadGraph(cwd);
    if (!graph) return;

    const result = contextQuery(graph, pattern, { budget: HOOK_BUDGET, substring: true });
    if (!result.matched || result.selection.length === 0) return;

    const additionalContext = formatHookContext(result, graph);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext,
        },
      }),
    );
  } catch {
    // Fail-open: errors produce no output; the tool proceeds normally.
  }
}

/**
 * Extract the search keyword from the PreToolUse payload. Both Grep
 * and Glob carry it on `tool_input.pattern`. Returns undefined for
 * anything we can't confidently read (→ no-op upstream).
 */
export function extractPattern(rawStdin: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdin);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const toolInput = (parsed as { tool_input?: unknown }).tool_input;
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const pattern = (toolInput as { pattern?: unknown }).pattern;
  if (typeof pattern !== 'string') return undefined;
  const trimmed = pattern.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Compact `additionalContext` body. Terser than the CLI's markdown
 * (the hook pays this cost on every grep): an anchor line, blast
 * radius, and the top symbols grouped by their leading community.
 * Leads with a one-line provenance + best-effort caveat so the agent
 * calibrates trust.
 */
export function formatHookContext(result: ContextResult, graph: Graph): string {
  const lines: string[] = [];
  lines.push(
    `dxkit graph context for \`${result.query}\` (from .dxkit/reports/graph.json, generated ${graph.meta.generatedAt.slice(0, 10)} — structural hint, grep results remain authoritative):`,
  );

  if (result.anchor) {
    const a = result.anchor;
    const where = a.line ? `${a.sourceFile}:${a.line}` : a.sourceFile;
    lines.push(`- Start here: \`${a.symbol}\` (${where}), called from ${a.calledFrom} place(s).`);
  }
  if (result.blastRadius.callers > 0) {
    lines.push(
      `- Blast radius: ${result.blastRadius.callers} caller(s) across ${result.blastRadius.callerFiles} file(s).`,
    );
  }

  // Top symbols overall (seeds first, then by in-degree), capped tight.
  const top = [...result.selection]
    .sort((a, b) => a.hop - b.hop || b.callsIn - a.callsIn)
    .slice(0, 10);
  if (top.length > 0) {
    lines.push('- Relevant symbols:');
    for (const s of top) {
      const where = s.line ? `${s.sourceFile}:${s.line}` : s.sourceFile;
      lines.push(`    ${s.symbol} (${where})`);
    }
  }
  if (result.truncated) {
    lines.push(`- (+${result.omittedCount} more symbols in the wider neighborhood)`);
  }

  return lines.join('\n');
}

/** Read all of stdin as a string. Resolves '' if stdin is a TTY/empty. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}
