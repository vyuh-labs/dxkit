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
import {
  userCommands,
  gatherRecommendations,
  GROUP_ORDER,
  GROUP_LABELS,
  type CommandGroup,
} from './commands';

export interface CapabilitiesOptions {
  json?: boolean;
}

export function runCapabilities(cwd: string, opts: CapabilitiesOptions = {}): void {
  const recommendations = gatherRecommendations(cwd);
  const recommendedIds = new Set(recommendations.map((r) => r.id));

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
