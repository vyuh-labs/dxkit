/**
 * `vyuh-dxkit policy show [path] [--policy <file>] [--json]` — the
 * EFFECTIVE-policy view (4.4.1 WP1b, strategy §7.2).
 *
 * `policy get`/`set` read and write the RAW file; nothing showed what a
 * surface actually judges under after resolution — which base a file
 * merges over, which block rules ended up armed and by whom, which
 * checks are required, and what the no-policy fallbacks are. An
 * embedder hit the gap live: a minimal `dod.json` silently armed
 * test-gap blocking because nothing rendered the merge result.
 *
 * This is a VIEW, not a fourth resolution path: it calls the ONE
 * `resolvePolicy` (and `policyBaseFor`) the gate and guardrail use, and
 * annotates provenance by diffing the resolved document against its
 * declared base. Per-surface overlays that deliberately differ (the
 * loop preset, the gate's security-only no-policy fallback) are NAMED
 * as notes rather than folded in — one mental model, honestly stated.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import {
  DEFAULT_POLICY_FILENAME,
  policyBaseFor,
  policyContentHash,
  resolvePolicy,
  type BrownfieldPolicy,
} from './baseline/policy';
import type { BrownfieldBlockRules } from './baseline/policy';
import { floorRequired } from './gate/required-observation';
import { resolveLoopPreset } from './loop/policy';

export interface PolicyShowOptions {
  readonly policyPath?: string;
  readonly json?: boolean;
}

export interface BlockRuleRow {
  readonly rule: string;
  readonly armed: boolean;
  /** 'file' when this file changed the rule away from its declared base. */
  readonly origin: 'file' | 'base';
}

export interface PolicyShowView {
  readonly source:
    | { readonly kind: 'explicit-file' | 'tree-file'; readonly path: string }
    | { readonly kind: 'compiled-default' };
  /** The base the file merges over; `declared: false` = implicit `default`. */
  readonly base: { readonly name: string; readonly declared: boolean };
  readonly identity: {
    readonly hash: string;
    readonly id?: string;
    readonly version?: string;
  };
  readonly blockStatuses: ReadonlyArray<string>;
  readonly warnStatuses: ReadonlyArray<string>;
  readonly blockRules: ReadonlyArray<BlockRuleRow>;
  readonly requiredObservations: {
    readonly floor: { readonly required: boolean; readonly source: 'default' | 'file' };
    readonly checks: ReadonlyArray<{
      readonly name: string;
      readonly required: boolean;
      readonly blocking: boolean;
    }>;
  };
  /** Per-surface overlays and footgun warnings, honestly named. */
  readonly notes: ReadonlyArray<string>;
  readonly policy: BrownfieldPolicy;
}

export function resolvePolicyShow(cwd: string, opts: PolicyShowOptions = {}): PolicyShowView {
  const conventional = path.join(cwd, DEFAULT_POLICY_FILENAME);
  const source: PolicyShowView['source'] = opts.policyPath
    ? { kind: 'explicit-file', path: path.resolve(opts.policyPath) }
    : fs.existsSync(conventional)
      ? { kind: 'tree-file', path: conventional }
      : { kind: 'compiled-default' };

  // The ONE resolver — same call the guardrail and baseline surfaces make.
  const policy = resolvePolicy(opts.policyPath, cwd);
  const rawExtends = source.kind === 'compiled-default' ? undefined : policy.extends;
  const base = policyBaseFor(rawExtends, source.kind === 'compiled-default' ? cwd : source.path);

  const blockRules: BlockRuleRow[] = (
    Object.keys(policy.blockRules) as Array<keyof BrownfieldBlockRules>
  ).map((rule) => ({
    rule,
    armed: policy.blockRules[rule] === true,
    origin: policy.blockRules[rule] === base.blockRules[rule] ? 'base' : 'file',
  }));

  const checks = (policy.checks ?? [])
    .filter((c) => typeof c.name === 'string' && c.name.trim().length > 0)
    .map((c) => ({
      name: c.name.trim(),
      required: c.required === true,
      blocking: c.blocking !== false,
    }));

  const notes: string[] = [];
  if (source.kind === 'compiled-default') {
    notes.push(
      'no policy file: repo surfaces (guardrail check, baseline) judge under the compiled ' +
        'default shown here; `gate <dir>` falls back to the SECURITY-ONLY preset instead. ' +
        'Scaffold a file with `vyuh-dxkit init --gate-only` or `policy sync --apply`.',
    );
  } else if (rawExtends === undefined) {
    notes.push(
      'this file declares no "extends", so it refines the fully armed compiled default — ' +
        'debt rules (test-gap, quality) are armed unless the file disarms them. Declare ' +
        '`"extends": "security-only"` (or "full-debt" / "default") to pin the intended posture.',
    );
  }
  const loop = resolveLoopPreset(cwd);
  notes.push(
    `loop Stop-gate posture: preset "${loop}" is applied over this document by the loop ` +
      'surface (see policy-guide#loop-preset).',
  );

  return {
    source,
    base: { name: rawExtends ?? 'default', declared: rawExtends !== undefined },
    identity: {
      hash: policyContentHash(policy),
      ...(policy.id !== undefined ? { id: policy.id } : {}),
      ...(policy.version !== undefined ? { version: policy.version } : {}),
    },
    blockStatuses: policy.block,
    warnStatuses: policy.warn,
    blockRules,
    requiredObservations: {
      floor: {
        required: floorRequired(policy),
        source: policy.floor?.required !== undefined ? 'file' : 'default',
      },
      checks,
    },
    notes,
    policy,
  };
}

export function renderPolicyShow(view: PolicyShowView): string {
  const lines: string[] = [];
  const src =
    view.source.kind === 'compiled-default'
      ? 'compiled default (no policy file)'
      : `${view.source.path}${view.source.kind === 'explicit-file' ? ' (--policy)' : ''}`;
  lines.push(logger.bold('Effective policy'));
  lines.push(`  source: ${src}`);
  lines.push(
    `  base:   ${view.base.name}${view.base.declared ? ' (declared via "extends")' : ' (implicit)'}`,
  );
  const named = view.identity.id
    ? `${view.identity.id}${view.identity.version ? `@${view.identity.version}` : ''} · `
    : '';
  lines.push(`  identity: ${named}hash ${view.identity.hash}`);
  lines.push('');
  lines.push(logger.bold('Posture'));
  lines.push(
    `  block statuses: ${view.blockStatuses.length ? view.blockStatuses.join(', ') : '(none)'}`,
  );
  lines.push(
    `  warn statuses:  ${view.warnStatuses.length ? view.warnStatuses.join(', ') : '(none)'}`,
  );
  lines.push('  block rules:');
  for (const row of view.blockRules) {
    lines.push(
      `    ${row.armed ? 'ARMED ' : 'off   '} ${row.rule}${row.origin === 'file' ? '  (set by this file)' : ''}`,
    );
  }
  lines.push('');
  lines.push(logger.bold('Required observations'));
  const floor = view.requiredObservations.floor;
  lines.push(
    `  floor: ${floor.required ? 'REQUIRED' : 'not required'} (${floor.source}) — a gate run ` +
      `that cannot execute the floor ${floor.required ? 'is CANNOT GATE' : 'passes with the skip disclosed'}`,
  );
  if (view.requiredObservations.checks.length === 0) {
    lines.push('  custom checks: (none declared)');
  } else {
    for (const c of view.requiredObservations.checks) {
      lines.push(
        `  check "${c.name}": ${c.required ? 'REQUIRED' : 'optional'}, ` +
          `${c.blocking ? 'blocking' : 'warn-only'}`,
      );
    }
  }
  lines.push('');
  for (const note of view.notes) lines.push(`  · ${note}`);
  return lines.join('\n');
}

export function runPolicyShow(cwd: string, opts: PolicyShowOptions = {}): void {
  try {
    const view = resolvePolicyShow(cwd, opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderPolicyShow(view) + '\n');
  } catch (err) {
    logger.fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
