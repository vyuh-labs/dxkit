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
  const closeAt = text.lastIndexOf('}');
  if (closeAt < 0) return { written: false, created: false };

  const blocks = plan.missing.map((s) => renderStanzaBlock(s, ctx).join('\n')).join('\n\n');
  const head = text.slice(0, closeAt).replace(/\s*$/, '\n\n');
  const next = `${head}${blocks}\n${text.slice(closeAt)}`;

  // The append must never break the file — parse before writing, refuse after.
  parsePolicyText(next);
  fs.writeFileSync(abs, next.endsWith('\n') ? next : next + '\n', 'utf8');
  return { written: true, created: false };
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
