/**
 * `vyuh-dxkit policy sync [--apply]` (decision C) — how an EXISTING policy
 * file adopts knobs that shipped after it was scaffolded.
 *
 * The contract mirrors update's provenance doctrine: the policy file is the
 * USER'S file. Sync never rewrites, reorders, or un-comments anything — it
 * appends ONLY the missing commented-out stanzas at the end, rendered by the
 * exact same `renderStanzaBlock` init uses, so a synced file and a fresh
 * scaffold teach identically. Dry-run by default; `--apply` writes.
 *
 * A stanza counts as PRESENT when its key is active in the parsed policy OR
 * appears as a commented stanza (`// "key":`) — a user who deleted a stanza
 * on purpose silences it permanently with an ignore marker:
 *
 *   // dxkit-policy-sync: ignore <key>
 *
 * `update` consumes `computePolicySync` for its read-only drift report ("3
 * knobs added since this policy was scaffolded"), so the report and the sync
 * can never disagree about what is missing.
 */
import * as fs from 'fs';
import { createScanner, SyntaxKind } from 'jsonc-parser';
import { policyPathFor, readPolicyRoot, parsePolicyText } from './baseline/policy-text';
import { writeNewPolicyFile } from './baseline/policy-write';
import {
  applicableStanzas,
  renderPolicyScaffold,
  renderStanzaBlock,
} from './baseline/policy-template';
import type { PolicyStanzaMeta, ScaffoldCtx } from './baseline/policy-metadata';
import { detectActiveLanguages } from './languages';
import * as logger from './logger';

export type PolicySyncStatus = 'ok' | 'absent' | 'malformed';

export interface PolicySyncPlan {
  readonly status: PolicySyncStatus;
  /** Why the file is untouchable, when status is 'malformed'. */
  readonly error?: string;
  /** Stanzas sync would append (missing, applicable, not ignored). */
  readonly missing: readonly PolicyStanzaMeta[];
  /** Stanza keys silenced by an ignore marker. */
  readonly ignored: readonly string[];
  /** Version stamped by the scaffold header, when one exists. */
  readonly scaffoldedBy?: string;
}

const IGNORE_MARKER = /\/\/\s*dxkit-policy-sync:\s*ignore\s+([A-Za-z0-9_.-]+)/g;

/** Is the stanza key present as a COMMENTED stanza (`// "key":`)? */
function hasCommentedStanza(text: string, key: string): boolean {
  return new RegExp(`^\\s*//\\s*"${key}"\\s*:`, 'm').test(text);
}

/** Compute what `policy sync` would do — pure over the file's content. */
export function computePolicySync(cwd: string, ctx: ScaffoldCtx): PolicySyncPlan {
  const read = readPolicyRoot(policyPathFor(cwd));
  if (read.status === 'malformed') {
    return { status: 'malformed', error: read.error, missing: [], ignored: [] };
  }
  if (read.status === 'absent') {
    return { status: 'absent', missing: applicableStanzas({}, ctx), ignored: [] };
  }

  const ignored = [...read.text.matchAll(IGNORE_MARKER)].map((m) => m[1]);
  const ignoredSet = new Set(ignored);
  const missing = applicableStanzas(read.value, ctx).filter(
    (s) => !hasCommentedStanza(read.text, s.key) && !ignoredSet.has(s.key),
  );
  const version = /scaffolded by dxkit ([^\s]+)/.exec(read.text)?.[1];
  return { status: 'ok', missing, ignored, scaffoldedBy: version };
}

/**
 * Append the plan's missing stanzas before the file's closing brace. Refuses
 * (returns false) when the root close cannot be located — never a rewrite.
 * On an absent file, writes a fresh full scaffold instead (create-only).
 */
export function applyPolicySync(
  cwd: string,
  plan: PolicySyncPlan,
  ctx: ScaffoldCtx,
  version: string,
): { written: boolean; created: boolean } {
  if (plan.status === 'malformed') return { written: false, created: false };
  if (plan.status === 'absent') {
    const created = writeNewPolicyFile(cwd, renderPolicyScaffold({ active: {}, ctx, version }));
    return { written: created, created };
  }
  if (plan.missing.length === 0) return { written: false, created: false };

  const abs = policyPathFor(cwd);
  const text = fs.readFileSync(abs, 'utf8');
  // The root close is the last CODE `}` — found by token walk, never by
  // lastIndexOf: a trailing comment containing `}` (observed shape:
  // `// reviewed by ops { done }`) would otherwise be mistaken for the
  // close and the guard below would reject a file sync handles fine.
  const closeAt = lastCodeCloseBrace(text);
  if (closeAt < 0) return { written: false, created: false };

  // The uncomment-to-activate promise must hold on a SYNCED file too (E3):
  // a hand-written strict-JSON policy has NO trailing comma after its last
  // member, so a stanza uncommented later would sit comma-less behind it —
  // the real-repo class the 4.3.0 mirror validation caught. Insert the comma
  // at the last code token before the close (comment- and string-safe via
  // the jsonc scanner), unless the object is empty or already terminated.
  const body = ensureTrailingComma(text.slice(0, closeAt));

  const blocks = plan.missing.map((s) => renderStanzaBlock(s, ctx).join('\n')).join('\n\n');
  const head = body.replace(/\s*$/, '\n\n');
  const next = `${head}${blocks}\n${text.slice(closeAt)}`;

  // The append must never break the file — parse before writing, and an
  // unexpected failure is a clean refusal (written: false), never a crash.
  try {
    parsePolicyText(next);
  } catch {
    return { written: false, created: false };
  }
  fs.writeFileSync(abs, next.endsWith('\n') ? next : next + '\n', 'utf8');
  return { written: true, created: false };
}

/** Offset of the last CODE close-brace token (the root close), or -1. */
function lastCodeCloseBrace(text: string): number {
  const scanner = createScanner(text, false);
  let at = -1;
  for (let t = scanner.scan(); t !== SyntaxKind.EOF; t = scanner.scan()) {
    if (t === SyntaxKind.CloseBraceToken) at = scanner.getTokenOffset();
  }
  return at;
}

/** Append a comma after the last CODE token of `body` (everything before the
 *  root close) unless it is `{` (empty object) or already `,`. Token-walked
 *  with the jsonc scanner, so trailing comments and `//` inside strings can
 *  never be mistaken for code. */
function ensureTrailingComma(body: string): string {
  const scanner = createScanner(body, false);
  let lastEnd = -1;
  let lastKind: SyntaxKind = SyntaxKind.Unknown;
  for (let t = scanner.scan(); t !== SyntaxKind.EOF; t = scanner.scan()) {
    if (
      t === SyntaxKind.Trivia ||
      t === SyntaxKind.LineBreakTrivia ||
      t === SyntaxKind.LineCommentTrivia ||
      t === SyntaxKind.BlockCommentTrivia
    ) {
      continue;
    }
    lastKind = t;
    lastEnd = scanner.getTokenOffset() + scanner.getTokenLength();
  }
  if (lastEnd < 0) return body;
  if (lastKind === SyntaxKind.OpenBraceToken || lastKind === SyntaxKind.CommaToken) return body;
  return body.slice(0, lastEnd) + ',' + body.slice(lastEnd);
}

/** The ONE ScaffoldCtx builder — init's scaffold step and `policy sync` must
 *  see the same repo facts or their stanza sets drift. */
export function scaffoldCtxFor(cwd: string): ScaffoldCtx {
  const packs = detectActiveLanguages(cwd);
  return { packIds: packs.map((p) => p.id), lintCapable: packs.some((p) => p.lintGate) };
}

export interface PolicySyncOptions {
  readonly apply?: boolean;
  readonly json?: boolean;
}

/** CLI entry — dry-run by default, `--apply` writes. */
export function runPolicySync(
  cwd: string,
  ctx: ScaffoldCtx,
  version: string,
  opts: PolicySyncOptions = {},
): void {
  const plan = computePolicySync(cwd, ctx);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'policy-sync.v1',
          status: plan.status,
          error: plan.error ?? null,
          missing: plan.missing.map((s) => s.key),
          ignored: plan.ignored,
          scaffoldedBy: plan.scaffoldedBy ?? null,
          applied: false,
        },
        null,
        2,
      ) + '\n',
    );
    if (plan.status === 'malformed') process.exitCode = 1;
    if (!opts.apply) return;
  }

  if (plan.status === 'malformed') {
    logger.fail(`policy file is not valid JSON/JSONC: ${plan.error} — nothing written`);
    process.exitCode = 1;
    return;
  }

  if (plan.status === 'absent') {
    if (!opts.apply) {
      logger.info('No .dxkit/policy.json yet — `policy sync --apply` writes the full scaffold.');
      return;
    }
    const { created } = applyPolicySync(cwd, plan, ctx, version);
    if (created) logger.success('.dxkit/policy.json — full commented scaffold written');
    return;
  }

  if (plan.missing.length === 0) {
    logger.info(
      plan.ignored.length > 0
        ? `Policy already covers every knob (${plan.ignored.length} ignored by marker).`
        : 'Policy already covers every knob — nothing to sync.',
    );
    return;
  }

  logger.info(
    `${plan.missing.length} knob stanza(s) missing from your policy` +
      (plan.scaffoldedBy ? ` (scaffolded by dxkit ${plan.scaffoldedBy})` : '') +
      ':',
  );
  for (const s of plan.missing) logger.info(`  + ${s.key} — ${s.title}`);
  if (!opts.apply) {
    logger.dim('Dry run. `vyuh-dxkit policy sync --apply` appends them as commented stanzas');
    logger.dim('at the end of the file (your content and comments are untouched).');
    logger.dim('Silence one permanently with: // dxkit-policy-sync: ignore <key>');
    return;
  }

  const { written } = applyPolicySync(cwd, plan, ctx, version);
  if (written) {
    logger.success(`Appended ${plan.missing.length} commented stanza(s) — uncomment to activate.`);
  } else {
    logger.fail('Could not locate the closing brace — nothing written.');
    process.exitCode = 1;
  }
}
