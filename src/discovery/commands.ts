/**
 * The command capability registry — dxkit's single source of truth for
 * "what user-facing capabilities exist and how a user (and an agent)
 * discovers them."
 *
 * Every top-level CLI command declares ONE descriptor (in `./command-defs`).
 * That one registry drives every discovery surface:
 *   - the grouped `vyuh-dxkit` help index (`renderCommandIndex`);
 *   - `doctor` advisor mode (a command's `whenToRecommend` probe, `./advisor`);
 *   - the agent-facing skill mapping (`skill`);
 *   - generated docs.
 *
 * This module is the FACADE: it re-exports the registry data + types and adds
 * the registry helpers (lookup, help index, doctor/config gathers). It is split
 * across four files to keep each a cohesive unit and to break the
 * registry↔probe value-import cycle, while every existing importer of
 * `./commands` is unchanged:
 *   - `./command-types` — the shared interfaces;
 *   - `./advisor`       — the pure doctor probes + config planners;
 *   - `./command-defs`  — `COMMANDS` (the descriptor data) + `CommandId`;
 *   - `./commands`      — this facade.
 *
 * Enforcement (CLAUDE.md Rule 16 — the block-if-unregistered gate, mirror
 * of Rule 15's managed-write gate):
 *   - `scripts/check-architecture.sh` diffs the top-level `case '<id>':`
 *     set in `src/cli.ts` against the ids + aliases declared in the registry —
 *     a new command that skips registration fails the pre-commit gate;
 *   - `test/discovery-playbook.test.ts` asserts field completeness for
 *     user-facing commands, that every referenced `skill` file exists, and
 *     (synthetic-command injection) that the parity checker actually bites.
 *
 * Because the registry is the ground truth, a capability cannot be added
 * without declaring how it is discovered — discoverability is part of a
 * feature's definition of done, not a docs afterthought.
 */
import { COMMANDS } from './command-defs';
import type {
  CapabilityDescriptor,
  CommandGroup,
  CommandRecommendation,
  ConfigContext,
  ConfigPlanItem,
} from './command-types';

// Re-export the registry data + every shared type so `./commands` remains the
// one import surface every consumer (cli, doctor, configure, tests) already uses.
export { COMMANDS } from './command-defs';
export type { CommandId } from './command-defs';
export type {
  CommandGroup,
  Audience,
  RecommendContext,
  Recommendation,
  ConfigContext,
  ConfigPlanItem,
  CapabilityDescriptor,
  CommandRecommendation,
} from './command-types';

/**
 * A widened view of the registry as `CapabilityDescriptor[]`. `COMMANDS` is
 * `as const`, so its element union narrows away optional fields (`aliases`)
 * on entries that omit them; helpers read the widened view so optional
 * access type-checks, while `CommandId` still derives from the const tuple.
 */
const ALL: readonly CapabilityDescriptor[] = COMMANDS;

/** Every id + alias that the dispatcher must accept (the "known command" set). */
export function allCommandTokens(): string[] {
  const tokens: string[] = [];
  for (const c of ALL) {
    tokens.push(c.id);
    for (const a of c.aliases ?? []) tokens.push(a);
  }
  return tokens;
}

/** Look up a descriptor by id or alias. */
export function getCommand(idOrAlias: string): CapabilityDescriptor | undefined {
  return ALL.find((c) => c.id === idOrAlias || (c.aliases ?? []).includes(idOrAlias));
}

/** User-facing commands only (the help index + docs surface). */
export function userCommands(): readonly CapabilityDescriptor[] {
  return ALL.filter((c) => c.audience === 'user');
}

/** Human labels for each group, in help-index display order. */
export const GROUP_LABELS: Record<Exclude<CommandGroup, 'internal'>, string> = {
  assess: 'Assess',
  gate: 'Gate',
  integrate: 'Integrate',
  explore: 'Explore',
  setup: 'Setup',
  export: 'Export',
};

/** Display order for the grouped help index. */
export const GROUP_ORDER: Array<Exclude<CommandGroup, 'internal'>> = [
  'assess',
  'gate',
  'integrate',
  'explore',
  'setup',
  'export',
];

/**
 * A grouped, one-line-per-command index of the user-facing commands.
 * Drives the unknown-command hint today; the top-level `--help` index next.
 */
export function renderCommandIndex(): string[] {
  const lines: string[] = [];
  for (const group of GROUP_ORDER) {
    const cmds = userCommands().filter((c) => c.group === group);
    if (cmds.length === 0) continue;
    lines.push(`  ${GROUP_LABELS[group]}`);
    for (const c of cmds) {
      const name = c.aliases?.length ? `${c.id} (${c.aliases.join(', ')})` : c.id;
      lines.push(`    ${name.padEnd(28)} ${c.summary}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Best-effort "did you mean" for an unknown command token: user-facing ids
 * (and aliases) that share a prefix with, contain, or are contained by the
 * input. Deliberately simple — a typo hint, not fuzzy search.
 */
export function suggestCommand(input: string): string[] {
  const q = input.toLowerCase();
  if (q.length === 0) return [];
  const hits = new Set<string>();
  for (const c of userCommands()) {
    for (const token of [c.id, ...(c.aliases ?? [])]) {
      const t = token.toLowerCase();
      if (t.startsWith(q) || q.startsWith(t) || t.includes(q) || q.includes(t)) {
        hits.add(c.id);
        break;
      }
    }
  }
  return [...hits];
}

/**
 * Run every user-facing command's `whenToRecommend` probe against `cwd` and
 * collect the recommendations that fired. Fail-open per probe: a throwing
 * probe is skipped, never breaks `doctor`. This is the data behind doctor
 * advisor mode — contextual capability discovery grounded in the repo. The
 * probes themselves live in `./advisor`, bound onto each descriptor.
 */
export function gatherRecommendations(cwd: string): CommandRecommendation[] {
  const out: CommandRecommendation[] = [];
  for (const c of userCommands()) {
    if (!c.whenToRecommend) continue;
    try {
      const rec = c.whenToRecommend({ cwd });
      if (rec) out.push({ id: c.id, recommendation: rec });
    } catch {
      // A probe never breaks doctor.
    }
  }
  return out;
}

/**
 * Run every capability's `planConfig` against `cwd` and collect the
 * deterministic items that fired — the data behind `vyuh-dxkit configure`.
 * Registry-driven: iterates `userCommands()`, so a new capability that declares
 * `planConfig` (in `./advisor`) is covered with no edit here. Fail-open per
 * planner (a throwing planner is skipped, never aborts the pass). The driving
 * `skill` is stamped from the descriptor so the agent knows which skill owns
 * each item.
 */
export function gatherConfigPlan(
  cwd: string,
  opts: Omit<ConfigContext, 'cwd'> = {},
  registry: readonly CapabilityDescriptor[] = userCommands(),
): ConfigPlanItem[] {
  const out: ConfigPlanItem[] = [];
  for (const c of registry) {
    if (!c.planConfig) continue;
    try {
      const item = c.planConfig({ cwd, ...opts });
      if (item) out.push({ ...item, skill: item.skill ?? c.skill });
    } catch {
      // A planner never aborts the configure pass.
    }
  }
  return out;
}
