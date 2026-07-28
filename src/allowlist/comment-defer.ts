/**
 * The PR-comment defer lane: `/dxkit defer …` typed by a reviewer on a
 * blocked PR, executed by the `dxkit-comment-defer` managed workflow, applied
 * through the ONE defer core (`executeDefer` — the same semantics, refusals,
 * and kind restriction as the local `allowlist defer`).
 *
 * SECURITY (load-bearing). A comment body is UNTRUSTED TEXT, even from a
 * write-permission author:
 *   - it reaches this process via ENVIRONMENT VARIABLES (`DXKIT_COMMENT_*`),
 *     never argv and never a shell interpolation — the workflow template
 *     passes `github.event.comment.body` through `env:`, the documented safe
 *     transport for actions payload text;
 *   - the grammar is a strict ALLOWLIST: `/dxkit defer` + 16-hex fingerprints
 *     + three known flags. Any other token — an option we don't know, a
 *     path, a shell metacharacter — REFUSES the whole command with the token
 *     named; nothing is ever partially executed or interpreted;
 *   - authorization (write permission) is checked by the WORKFLOW before the
 *     CLI runs; `addedBy` is the commenter's login, passed by the workflow
 *     from the event payload, so the decision is attributable.
 *
 * The subcommand always emits one JSON payload (`comment-defer.v1`) carrying
 * a ready-to-post `replyMarkdown` — a refusal is a handled outcome (exit 0,
 * the reply explains), not a process failure, so the workflow's reply step
 * runs on every path.
 */

import { executeDefer, type DeferResult } from './defer-core';
import { loadAllowlist } from './file';

/** One parsed `/dxkit defer` command. */
export interface ParsedCommentCommand {
  readonly fingerprints: readonly string[];
  readonly fromLastCheck: boolean;
  readonly expires?: string;
  readonly reason?: string;
}

export type ParseOutcome =
  | { readonly ok: true; readonly command: ParsedCommentCommand }
  | { readonly ok: false; readonly refusal: string }
  /** No `/dxkit` line in the comment at all — not addressed to us. */
  | { readonly ok: false; readonly refusal: null };

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const EXPIRES_RE = /^(\+\d+d|\d{4}-\d{2}-\d{2})$/;
const MAX_REASON_LENGTH = 200;

/**
 * Parse a comment body against the strict grammar. Only the FIRST line that
 * starts with `/dxkit ` is read (people write prose around commands); the
 * command must be entirely well-formed or the whole thing refuses.
 */
export function parseCommentCommand(body: string): ParseOutcome {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('/dxkit'));
  if (line === undefined) return { ok: false, refusal: null };

  // Pull a quoted --reason out first so its content never enters the token
  // stream (it may contain spaces; it is data, not grammar).
  let reason: string | undefined;
  const rest = line.replace(/--reason="([^"]*)"|--reason=([^\s"]+)/, (_m, quoted, bare) => {
    reason = (quoted ?? bare ?? '').trim();
    return '';
  });
  if (reason !== undefined) {
    if (reason.length === 0) return { ok: false, refusal: '`--reason` must not be empty.' };
    if (reason.length > MAX_REASON_LENGTH) {
      return { ok: false, refusal: `\`--reason\` is too long (max ${MAX_REASON_LENGTH} chars).` };
    }
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens[0] !== '/dxkit') {
    return { ok: false, refusal: `Unrecognized command \`${tokens[0]}\` — expected \`/dxkit\`.` };
  }
  if (tokens[1] !== 'defer') {
    return {
      ok: false,
      refusal:
        `Unknown dxkit comment command \`${tokens[1] ?? ''}\`. Supported: ` +
        '`/dxkit defer <fingerprint>… [--expires=+7d] [--reason="…"]` and ' +
        '`/dxkit defer --new-advisories`.',
    };
  }

  const fingerprints: string[] = [];
  let fromLastCheck = false;
  let expires: string | undefined;
  for (const token of tokens.slice(2)) {
    if (FINGERPRINT_RE.test(token)) {
      fingerprints.push(token);
      continue;
    }
    if (token === '--new-advisories') {
      fromLastCheck = true;
      continue;
    }
    const exp = token.match(/^--expires=(.*)$/);
    if (exp) {
      if (!EXPIRES_RE.test(exp[1])) {
        return {
          ok: false,
          refusal: `\`--expires\` must be \`+Nd\` or \`YYYY-MM-DD\`; got \`${exp[1]}\`.`,
        };
      }
      expires = exp[1];
      continue;
    }
    // The refusal names the token but never interprets it.
    return {
      ok: false,
      refusal:
        `Unrecognized token \`${token}\`. The grammar is strict by design: ` +
        '16-hex fingerprints, `--new-advisories`, `--expires=+Nd|YYYY-MM-DD`, ' +
        '`--reason="…"` — nothing else runs.',
    };
  }
  if (fingerprints.length === 0 && !fromLastCheck) {
    return {
      ok: false,
      refusal:
        'Nothing to defer — pass one or more fingerprints (from the guardrail report) ' +
        'or `--new-advisories` to defer every blocking dep-vuln of the check that just ran.',
    };
  }
  return {
    ok: true,
    command: {
      fingerprints,
      fromLastCheck,
      ...(expires !== undefined ? { expires } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

export interface CommentDeferPayload {
  readonly schema: 'comment-defer.v1';
  /** 'deferred' — entries written; 'noop' — nothing new to write;
   *  'refused' — parse or defer refusal (explained in the reply);
   *  'ignored' — the comment carried no /dxkit line at all. */
  readonly action: 'deferred' | 'noop' | 'refused' | 'ignored';
  readonly added: readonly string[];
  readonly alreadyPresent: readonly string[];
  readonly leftBlocking: readonly string[];
  readonly expiresAt?: string;
  readonly replyMarkdown: string;
}

const REPLY_MARKER = '<!-- dxkit-comment-defer -->';

function reply(lines: string[]): string {
  return [REPLY_MARKER, ...lines].join('\n');
}

/**
 * Execute a `/dxkit defer` comment. Reads the comment body + author from
 * `DXKIT_COMMENT_BODY` / `DXKIT_COMMENT_AUTHOR` (the env transport — see the
 * module doc), runs the one defer core against `cwd` (the PR head checkout,
 * where the workflow has just warmed the verdict cache with a guardrail
 * run), and returns the structured payload the workflow posts + commits.
 */
export function runCommentDeferCore(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): CommentDeferPayload {
  const body = env.DXKIT_COMMENT_BODY ?? '';
  const author = (env.DXKIT_COMMENT_AUTHOR ?? '').trim();
  const prNumber = (env.DXKIT_COMMENT_PR ?? '').trim();

  const base = {
    schema: 'comment-defer.v1' as const,
    added: [] as readonly string[],
    alreadyPresent: [] as readonly string[],
    leftBlocking: [] as readonly string[],
  };

  const parsed = parseCommentCommand(body);
  if (!parsed.ok) {
    if (parsed.refusal === null) {
      return { ...base, action: 'ignored', replyMarkdown: '' };
    }
    return {
      ...base,
      action: 'refused',
      replyMarkdown: reply([`**dxkit:** command refused.`, '', parsed.refusal]),
    };
  }
  if (!author) {
    return {
      ...base,
      action: 'refused',
      replyMarkdown: reply([
        '**dxkit:** command refused — no commenter identity was provided to the runner.',
      ]),
    };
  }

  const cmd = parsed.command;
  const result: DeferResult = executeDefer(
    cwd,
    {
      fingerprints: cmd.fingerprints,
      fromLastCheck: cmd.fromLastCheck,
      reason:
        cmd.reason ??
        `deferred via PR comment by @${author}${prNumber ? ` (PR #${prNumber})` : ''}`,
      ...(cmd.expires !== undefined ? { expires: cmd.expires } : {}),
      addedBy: author,
      // The existing file's mode wins; 'full' for a fresh file — the same
      // no-override resolution the local CLI applies.
      mode: loadAllowlist(cwd)?.mode ?? 'full',
    },
    now,
  );

  if (!result.ok) {
    return {
      ...base,
      action: 'refused',
      replyMarkdown: reply(['**dxkit:** defer refused.', '', result.message]),
    };
  }

  const lines: string[] = [];
  if (result.added.length > 0) {
    lines.push(
      `**dxkit:** deferred ${result.added.length} dep-vuln finding${result.added.length === 1 ? '' : 's'} ` +
        `(category=deferred, expires **${result.expiresAt}**), requested by @${author}.`,
      '',
    );
    for (const fp of result.added) {
      const meta = result.targets.get(fp);
      lines.push(`- \`${fp}\`${meta?.locator ? ` — ${meta.locator}` : ''}`);
    }
    lines.push(
      '',
      'The allowlist commit below re-runs the guardrail check. The expiry is the ' +
        'forcing function: these re-block when it lapses, so plan the dependency fix now.',
    );
  } else {
    lines.push(
      result.alreadyPresent.length > 0
        ? `**dxkit:** all ${result.alreadyPresent.length} fingerprint(s) already have allowlist entries — nothing written.`
        : '**dxkit:** nothing to defer.',
    );
  }
  if (result.leftBlocking.length > 0) {
    lines.push(
      '',
      `Left blocking (not dep-vulns — defer refuses to touch them): ${result.leftBlocking.join('; ')}.`,
    );
  }

  return {
    ...base,
    action: result.added.length > 0 ? 'deferred' : 'noop',
    added: result.added,
    alreadyPresent: result.alreadyPresent,
    leftBlocking: result.leftBlocking,
    expiresAt: result.expiresAt,
    replyMarkdown: reply(lines),
  };
}

/** CLI wrapper: print the payload as JSON. Exit 0 on every HANDLED outcome
 *  (including refusals — the reply explains); non-zero is reserved for
 *  infrastructure failures the workflow should surface as a job error. */
export function runCommentDefer(cwd: string): void {
  const payload = runCommentDeferCore(cwd);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}
