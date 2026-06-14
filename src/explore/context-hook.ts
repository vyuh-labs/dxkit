/**
 * `vyuh-dxkit context-hook` — the Claude Code PreToolUse hook that
 * delivers the token-reduction win passively. Wired into a scaffolded
 * repo's `.claude/settings.json` so that when an agent reads or searches
 * the codebase, this hook injects a slim structural map as
 * `additionalContext`, so the agent needs fewer follow-up whole-file
 * reads.
 *
 * Delivery surfaces:
 *   - **Read** — keyed on the FILE the agent is opening. Injects that
 *     file's structural summary (symbols + who calls it + what it calls).
 *     This is the highest-leverage surface: agents read files constantly,
 *     so the hook fires reliably and is useful regardless of search term.
 *   - **Bash** — parses `grep`/`rg`-style commands. When a concrete
 *     source file is named, delivers that file's summary; otherwise falls
 *     back to a symbol-name match on the search pattern. This is what lets
 *     the hook engage at all in a real fix workflow: agents search via the
 *     `Bash` tool (`grep -n …`), not the native `Grep` tool, so a
 *     Grep-only hook almost never fired.
 *   - **Grep / Glob** — the original surface, keyed on `tool_input.pattern`
 *     matched against graph symbol names.
 *
 * Pre-2.10 the hook fired ONLY on `Grep`/`Glob` and ONLY when the search
 * pattern substring-matched a symbol name — which almost never happened
 * in a real fix workflow (agents grep symptoms like `sendFile` via
 * `Bash`, not enclosing symbol names via `Grep`). The file-keyed Read
 * surface is the bridge from proven-deterministic graph value to
 * realized-agentic delivery.
 *
 * THE CONTRACT IS FAIL-OPEN + ADDITIVE. This hook can only ever ADD
 * context; it never blocks the tool, never replaces tool output, and
 * stays a silent no-op (exit 0, no stdout) on ANY problem — missing
 * graph.json, parse error, no match, unreadable stdin. So Claude Code
 * behaves exactly as it does today whenever the graph is absent or
 * unhelpful; the hook is pure upside.
 *
 * Claude Code passes the tool call as JSON on stdin
 * (`{ tool_name, tool_input, session_id, cwd, ... }`) and reads a JSON
 * object on stdout with `hookSpecificOutput.additionalContext`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { contextQuery, fileSummaryQuery, type ContextResult, type FileSummary } from './queries';
import { tryLoadGraph } from './load';
import type { Graph } from './types';

/** Stingier than the manual CLI's 2000 — the hook fires on every search/read. */
const HOOK_BUDGET = 1500;

/** What the agent's tool call resolved to: a specific file, or a search term. */
type HookTarget = { kind: 'file'; file: string } | { kind: 'pattern'; pattern: string };

/**
 * Entry point for `case 'context-hook'`. Reads stdin, resolves the
 * target, runs the query, writes the hook output. Wrapped so nothing it
 * does can fail the tool call: every failure path resolves to a silent
 * no-op.
 */
export async function runContextHook(cwd: string): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;

    const payload = parsePayload(raw);
    if (!payload) return;

    const graph = tryLoadGraph(cwd);
    if (!graph) return;

    const target = resolveHookTarget(payload, graph, cwd);
    if (!target) return;

    // Per-session, per-file dedup: a file's structural map is injected at
    // most once per session, so an agent re-reading the same file doesn't
    // pay the context cost repeatedly. Best-effort — a dedup-state failure
    // falls through to injecting (the additive contract wins over the
    // optimization).
    if (target.kind === 'file' && payload.sessionId) {
      if (alreadyInjected(payload.sessionId, target.file)) return;
    }

    let additionalContext: string | undefined;
    if (target.kind === 'file') {
      const summary = fileSummaryQuery(graph, target.file);
      if (!summary.found || summary.symbols.length === 0) return;
      additionalContext = formatFileContext(summary, graph);
    } else {
      const result = contextQuery(graph, target.pattern, { budget: HOOK_BUDGET, substring: true });
      if (!result.matched || result.selection.length === 0) return;
      additionalContext = formatHookContext(result, graph);
    }

    if (!additionalContext) return;

    if (target.kind === 'file' && payload.sessionId) {
      markInjected(payload.sessionId, target.file);
    }

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

/** The fields of the PreToolUse payload the hook consumes. */
interface HookPayload {
  toolName?: string;
  toolInput: Record<string, unknown>;
  sessionId?: string;
}

/** Parse the raw stdin JSON into the subset of fields the hook needs. */
export function parsePayload(rawStdin: string): HookPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdin);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const toolInput =
    obj.tool_input && typeof obj.tool_input === 'object'
      ? (obj.tool_input as Record<string, unknown>)
      : {};
  return {
    toolName: typeof obj.tool_name === 'string' ? obj.tool_name : undefined,
    toolInput,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
  };
}

/**
 * Decide what to inject context about, given the tool the agent invoked.
 * Returns undefined (→ no-op) for tools/inputs we can't confidently map.
 */
export function resolveHookTarget(
  payload: HookPayload,
  graph: Graph,
  cwd: string,
): HookTarget | undefined {
  const tool = payload.toolName;

  // Read / Edit / Write — keyed on the file being touched.
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const fp = payload.toolInput.file_path ?? payload.toolInput.notebook_path;
    if (typeof fp !== 'string' || !fp.trim()) return undefined;
    const rel = toRepoRelative(fp.trim(), cwd);
    return graph.nodesByFile.has(rel) ? { kind: 'file', file: rel } : undefined;
  }

  // Bash — parse a grep/rg-style search command.
  if (tool === 'Bash') {
    const cmd = payload.toolInput.command;
    if (typeof cmd !== 'string' || !cmd.trim()) return undefined;
    return parseBashForTarget(cmd, graph, cwd);
  }

  // Grep / Glob (and anything else carrying a `pattern`) — symbol match.
  const pattern = extractPattern(JSON.stringify({ tool_input: payload.toolInput }));
  return pattern ? { kind: 'pattern', pattern } : undefined;
}

/**
 * Extract a grep/rg target from a Bash command. Prefers a concrete
 * source file named in the command (→ that file's structural summary);
 * otherwise falls back to the search pattern (→ symbol-name match). Only
 * fires for recognised search tools so an arbitrary Bash command is a
 * clean no-op.
 */
export function parseBashForTarget(
  command: string,
  graph: Graph,
  cwd: string,
): HookTarget | undefined {
  if (!/\b(grep|egrep|fgrep|rg|ag|ack)\b/.test(command)) return undefined;

  // First clause only — ignore everything past a pipe/`&&`/`;` so a
  // downstream command's args don't masquerade as search paths.
  const head = command.split(/\||&&|;/)[0];
  const tokens = head.split(/\s+/).filter(Boolean).map(stripQuotes);

  const binaries = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

  // 1. A concrete file argument that exists in the graph wins — that's
  //    the file the agent is looking at, structural map is most useful.
  for (const tok of tokens) {
    if (tok.startsWith('-') || binaries.has(tok)) continue;
    const rel = toRepoRelative(tok, cwd);
    if (graph.nodesByFile.has(rel)) return { kind: 'file', file: rel };
  }

  // 2. Else the first plausible search term → symbol match. Skip flags,
  //    the binary, redirections, and path-ish/dir tokens.
  for (const tok of tokens) {
    if (tok.startsWith('-') || binaries.has(tok)) continue;
    if (/[/<>|*]/.test(tok) || tok.includes('..')) continue;
    if (tok.length < 2) continue;
    return { kind: 'pattern', pattern: tok };
  }
  return undefined;
}

/** Strip a single layer of surrounding single/double quotes. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/** Convert an absolute or repo-relative path to the graph's key format
 *  (project-relative, forward slashes). */
function toRepoRelative(p: string, cwd: string): string {
  const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
  return rel.replace(/\\/g, '/');
}

/**
 * Compact `additionalContext` body for a FILE target: the file's
 * symbols, who depends on it (caller files), and what it reaches into
 * (callee files). Terser than the CLI's markdown — the hook pays this on
 * every read. Leads with provenance + a best-effort caveat so the agent
 * calibrates trust.
 */
export function formatFileContext(summary: FileSummary, graph: Graph): string {
  const lines: string[] = [];
  lines.push(
    `dxkit graph context for \`${summary.sourceFile}\` (from .dxkit/reports/graph.json, generated ${graph.meta.generatedAt.slice(0, 10)} — structural map, the file's actual contents remain authoritative):`,
  );

  const topSymbols = summary.symbols.slice(0, 12);
  if (topSymbols.length > 0) {
    lines.push(`- Symbols (${summary.symbols.length}):`);
    for (const s of topSymbols) {
      const where = s.line ? `:${s.line}` : '';
      const flags = [s.exported ? 'exported' : '', s.callsIn > 0 ? `${s.callsIn} caller(s)` : '']
        .filter(Boolean)
        .join(', ');
      lines.push(`    ${s.label} (${s.kind}${where})${flags ? ` — ${flags}` : ''}`);
    }
    if (summary.symbols.length > topSymbols.length) {
      lines.push(`    (+${summary.symbols.length - topSymbols.length} more)`);
    }
  }

  if (summary.callerFiles.length > 0) {
    const top = summary.callerFiles.slice(0, 6);
    lines.push(`- Depended on by ${summary.callerFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
    if (summary.callerFiles.length > top.length) {
      lines.push(`    (+${summary.callerFiles.length - top.length} more)`);
    }
  }

  if (summary.calleeFiles.length > 0) {
    const top = summary.calleeFiles.slice(0, 6);
    lines.push(`- Calls into ${summary.calleeFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
    if (summary.calleeFiles.length > top.length) {
      lines.push(`    (+${summary.calleeFiles.length - top.length} more)`);
    }
  }

  if (summary.communityLabel) {
    lines.push(`- Module group: ${summary.communityLabel}`);
  }

  return lines.join('\n');
}

// ─── Per-session, per-file dedup state ───────────────────────────────────────

/** Where the per-session injected-file ledger lives. One file per
 *  session under the OS temp dir; small JSON array of repo-relative
 *  paths. Best-effort + self-evicting (temp dir is reclaimed by the OS). */
function dedupStatePath(sessionId: string): string {
  // Sanitize the session id to a safe filename component.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return path.join(os.tmpdir(), `dxkit-context-hook-${safe}.json`);
}

/** Has this file's context already been injected this session? Fail-open
 *  to `false` (inject) on any read/parse problem. */
function alreadyInjected(sessionId: string, file: string): boolean {
  try {
    const raw = fs.readFileSync(dedupStatePath(sessionId), 'utf-8');
    const seen = JSON.parse(raw);
    return Array.isArray(seen) && seen.includes(file);
  } catch {
    return false;
  }
}

/** Record that this file's context was injected this session. Best-effort
 *  — a write failure simply means the file may be re-injected later. */
function markInjected(sessionId: string, file: string): void {
  try {
    const p = dedupStatePath(sessionId);
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (Array.isArray(parsed)) seen = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // no prior state → start fresh
    }
    if (!seen.includes(file)) {
      seen.push(file);
      fs.writeFileSync(p, JSON.stringify(seen));
    }
  } catch {
    // Fail-open: dedup is an optimization, not a correctness requirement.
  }
}

/**
 * Extract the search keyword from a Grep/Glob-style payload. Both carry
 * it on `tool_input.pattern`. Returns undefined for anything we can't
 * confidently read (→ no-op upstream).
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
 * Compact `additionalContext` body for a PATTERN target. Terser than the
 * CLI's markdown (the hook pays this cost on every grep): an anchor line,
 * blast radius, and the top symbols grouped by their leading community.
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
