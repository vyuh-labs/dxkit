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
import { contextQuery, fileLineContextQuery, fileSummaryQuery } from './queries';
import { formatFileContext, formatFileLineContext, formatHookContext } from './context-hook-format';
import { tryLoadGraph } from './load';
import type { Graph } from './types';

/** Stingier than the manual CLI's 2000 — the hook fires on every search/read. */
const HOOK_BUDGET = 1500;

/**
 * What the agent's tool call resolved to. A file target may carry the
 * `line` the agent is reading (Read's `offset`): with a line we inject the
 * location's structural neighborhood (enclosing symbol + its edges + the
 * file's role) — useful even for files with no named symbols, like
 * top-level config; without one we inject the file's symbol map.
 */
type HookTarget =
  | { kind: 'file'; file: string; line?: number }
  | { kind: 'pattern'; pattern: string };

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
      if (!summary.found) return;
      // With a line, frame the location's structural neighborhood (enclosing
      // symbol + its edges + the file's role); without one, the file's symbol
      // map. Either formatter returns '' when there's genuinely nothing useful
      // to add — that empty string is the single "don't fire" gate (replacing
      // the old `symbols.length === 0` check, which blanked out symbol-less but
      // well-connected files like top-level config).
      additionalContext =
        target.line !== undefined
          ? formatFileLineContext(
              fileLineContextQuery(graph, target.file, target.line),
              summary,
              graph,
              target.file,
              target.line,
            )
          : formatFileContext(summary, graph);
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
    if (!graph.nodesByFile.has(rel)) return undefined;
    // Read carries `offset` = the 1-based line the agent starts reading at.
    // Use it to deliver location-local structure (the enclosing symbol's
    // neighborhood) rather than only a file-level symbol map — which is
    // what lets the hook help on findings inside symbol-less regions
    // (top-level config, an entrypoint's middleware setup). Edit/Write
    // carry no line, so they fall back to the file map.
    const off = payload.toolInput.offset;
    const line =
      tool === 'Read' && typeof off === 'number' && off > 0 ? Math.floor(off) : undefined;
    return line !== undefined ? { kind: 'file', file: rel, line } : { kind: 'file', file: rel };
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
