/**
 * Registry-emitted tables for `docs/configuration/policy-guide.md` (E5).
 *
 * Where the guide documents a REGISTRY fact — the remediate task→tier
 * table, the per-driver tier→model mapping, the knob index — the table is
 * EMITTED from the registry itself into a marked region, never hand-written
 * (hand-written copies of registry facts are the README-matrix drift
 * class). Facts less stable than a dxkit release (which concrete model an
 * alias resolves to today) do not appear here at all: they belong to
 * `vyuh-dxkit remediate plan` and the PR ledger.
 *
 * `scripts/generate-policy-guide.js` writes the regions;
 * `test/policy-guide.test.ts` pins the committed guide against a fresh
 * render, so a registry change that forgets the regen step fails CI with a
 * pointer to the command.
 */
import { REMEDIATE_TASKS } from '../remediate/tasks';
import { AGENT_DRIVERS } from '../remediate/registry';
import { MODEL_TIERS } from '../remediate/driver';
import { POLICY_PARAMS } from '../baseline/policy-metadata';
import { replaceMarkedRegion } from './docs-tables';

const REGION = (name: string) => ({
  begin: `<!-- BEGIN GENERATED: ${name} (edit the registry, then: npm run build && npm run docs:policy-guide) -->`,
  end: `<!-- END GENERATED: ${name} -->`,
});

export const GUIDE_REGIONS = ['remediate-task-tiers', 'remediate-drivers', 'knob-index'] as const;

/** task → auto tier → why (from the task registry). */
export function renderRemediateTaskTierTable(): string {
  const lines = ['| Task | Auto tier | Why this tier |', '|---|---|---|'];
  for (const t of REMEDIATE_TASKS) {
    lines.push(`| \`${t.id}\` | \`${t.tier}\` | ${t.tierWhy} |`);
  }
  return lines.join('\n');
}

/** driver → per-tier native mapping + enforceable caps + credentials. */
export function renderRemediateDriverTable(): string {
  const lines = [
    '| Driver | light | standard | deep | Enforces | Credentials |',
    '|---|---|---|---|---|---|',
  ];
  for (const d of AGENT_DRIVERS) {
    const tiers = MODEL_TIERS.map((t) => `\`${d.resolveModel(t)}\``);
    const enforces = [
      ...(d.budgetSupport.turns ? ['turns'] : []),
      ...(d.budgetSupport.cost ? ['spend'] : []),
      'wall-clock',
    ].join(', ');
    const creds = d.credentialEnv.map((c) => `\`${c}\``).join(', ') || 'none';
    lines.push(`| \`${d.id}\` | ${tiers.join(' | ')} | ${enforces} | ${creds} |`);
  }
  return lines.join('\n');
}

/** Every documented parameter → its guide section (from the metadata table).
 *  The REVERSE half of the anchor gate: a renamed knob regenerates this
 *  index, and the parity test flags a stale committed guide. */
export function renderKnobIndexTable(): string {
  const lines = ['| Policy path | Guide section |', '|---|---|'];
  for (const p of [...POLICY_PARAMS].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(`| \`${p.path}\` | [#${p.anchor}](#${p.anchor}) |`);
  }
  return lines.join('\n');
}

/** Replace one named region through the ONE marked-region replacer (shared
 *  with the docs command table — Rule 2). */
function replaceRegion(text: string, name: string, body: string): string {
  const { begin, end } = REGION(name);
  return replaceMarkedRegion(text, begin, end, body);
}

/** Rewrite every generated region of the guide from the registries. */
export function replacePolicyGuideTables(text: string): string {
  let next = text;
  next = replaceRegion(next, 'remediate-task-tiers', renderRemediateTaskTierTable());
  next = replaceRegion(next, 'remediate-drivers', renderRemediateDriverTable());
  next = replaceRegion(next, 'knob-index', renderKnobIndexTable());
  return next;
}
