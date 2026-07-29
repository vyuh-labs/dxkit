/** The INTERNAL-audience partition of the command registry (Rule 16):
 *  machine-invoked plumbing — hook bodies, floor commands. Registered so
 *  nothing is invisible ("internal" is a DECLARED status, not an
 *  omission), but exempt from the user-facing discovery fields. Split
 *  from `command-defs.ts` by audience; spread into `COMMANDS` there, so
 *  the one registry (and the literal `CommandId` union) is unchanged. */
import type { CapabilityDescriptor } from './command-types';

export const INTERNAL_COMMANDS = [
  {
    id: 'context-hook',
    audience: 'internal',
    group: 'internal',
    summary: 'Claude Code PreToolUse hook body (graph context injection)',
  },
  {
    id: 'hook',
    audience: 'internal',
    group: 'internal',
    summary: 'Claude Code lifecycle-hook bodies for the loop pack (stop-gate)',
  },
  {
    id: 'floor',
    audience: 'internal',
    group: 'internal',
    summary: 'Correctness-floor plumbing (snapshot / check) for the loop + hooks',
  },
] as const satisfies readonly CapabilityDescriptor[];
