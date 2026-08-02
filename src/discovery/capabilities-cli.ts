/**
 * `vyuh-dxkit capabilities [--json]` — the capability catalog.
 *
 * The agent-facing half of the discovery registry (CLAUDE.md Rule 16). A
 * developer working WITH a coding agent asks "what can dxkit do here, and
 * what should we set up?"; the agent runs `capabilities --json`, reads the
 * live registry (never a stale hand-listed menu), and proposes the
 * repo-grounded recommendations the advisor probes surfaced. Every capability
 * carries the skill that drives it, so the agent knows which conversational
 * surface configures each one.
 *
 * Because the catalog is generated from the same registry that Rule 16 gates,
 * a new capability appears here — to humans AND agents — the moment it is
 * registered. It cannot drift.
 */
import * as logger from '../logger';
import { buildLearnBundle } from '../learn/bundle';
import {
  userCommands,
  gatherRecommendations,
  GROUP_ORDER,
  GROUP_LABELS,
  type CommandGroup,
} from './commands';

export interface CapabilitiesOptions {
  json?: boolean;
  /** Pasteable markdown for org documentation systems (issue #246). */
  markdown?: boolean;
}

/**
 * `capabilities --markdown`: the capability/limits content as markdown an org
 * can paste into a wiki. Rendered from the SAME learn bundle the learn page
 * and assistant read (one content path, Rule 2.30) — the capability list is
 * registry-generated and the limits statement is the curated
 * capabilities-and-limits doc, verbatim.
 */
export function renderCapabilitiesMarkdown(): string {
  const bundle = buildLearnBundle();
  const lines: string[] = [];
  lines.push(`# dxkit capabilities (v${bundle.version})`);
  lines.push('');
  lines.push('## Start here');
  lines.push('');
  for (const c of bundle.capabilities.filter((x) => x.tier === 'core')) {
    lines.push(`- **\`${c.id}\`** — ${c.docsBlurb ?? c.summary}`);
  }
  const groups = [
    ...new Set(bundle.capabilities.filter((c) => c.tier === 'more').map((c) => c.groupLabel)),
  ];
  for (const g of groups) {
    lines.push('');
    lines.push(`## ${g}`);
    lines.push('');
    for (const c of bundle.capabilities.filter((x) => x.tier === 'more' && x.groupLabel === g)) {
      lines.push(`- **\`${c.id}\`** — ${c.docsBlurb ?? c.summary}`);
    }
  }
  const limits = bundle.docs.find((d) => d.slug === 'capabilities-and-limits');
  if (limits) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(limits.markdown.trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

export function runCapabilities(cwd: string, opts: CapabilitiesOptions = {}): void {
  const recommendations = gatherRecommendations(cwd);
  const recommendedIds = new Set(recommendations.map((r) => r.id));

  if (opts.markdown) {
    process.stdout.write(renderCapabilitiesMarkdown());
    return;
  }

  if (opts.json) {
    // Agent-queryable menu. Logger is already in stderr mode (cli.ts sets it
    // under --json), so stdout stays pure JSON.
    const payload = {
      schema: 'capabilities.v1',
      commands: userCommands().map((c) => ({
        id: c.id,
        group: c.group,
        summary: c.summary,
        docsBlurb: c.docsBlurb,
        skill: c.skill,
        recommended: recommendedIds.has(c.id),
      })),
      recommendations,
    };
    console.log(JSON.stringify(payload, null, 2)); // slop-ok
    return;
  }

  logger.header('dxkit capabilities');
  for (const group of GROUP_ORDER) {
    const cmds = userCommands().filter((c) => c.group === (group as CommandGroup));
    if (cmds.length === 0) continue;
    console.log(''); // slop-ok
    logger.info(GROUP_LABELS[group]);
    for (const c of cmds) {
      const skill = c.skill ? `  ·  skill: ${c.skill}` : '';
      const flag = recommendedIds.has(c.id) ? '  ← recommended for this repo' : '';
      logger.dim(`  ${c.id.padEnd(26)} ${c.summary}${skill}${flag}`);
    }
  }

  if (recommendations.length > 0) {
    console.log(''); // slop-ok
    logger.info('Recommended for this repo:');
    for (const { recommendation } of recommendations) {
      logger.dim(`• ${recommendation.reason}`);
      logger.dim(`  → ${recommendation.command}`);
    }
  }

  console.log(''); // slop-ok
  logger.dim(
    'Tip: `vyuh-dxkit capabilities --json` is the agent-queryable menu — ask your coding agent to read it and set up what fits.',
  );
}
