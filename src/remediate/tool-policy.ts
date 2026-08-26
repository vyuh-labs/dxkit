/**
 * The order-run tool policy: what an order-driven agent run may NOT do,
 * rendered as permission-rule patterns for the driver's declared narrowing
 * mechanism, with the disclosure every envelope carries.
 *
 * Installs are the frame's job (recipes run them pre-checked, with the
 * lockfile re-synced), so the agent's own package-manager install commands
 * are denied. The command list derives from `src/package-manager.ts` (the
 * one home of package-manager vocabulary, Rule 2/5 discipline) — never a
 * hardcoded list here.
 */
import { installCommandPrefixes } from '../package-manager';
import type { AgentDriver } from './driver';
import type { ToolPolicyDisclosure } from './outcome';

/** The deny patterns for an order run: every package-manager install
 *  command, in the agent CLI's `Tool(prefix:*)` permission-rule shape. */
export function orderRunDisallowedTools(): readonly string[] {
  return installCommandPrefixes().map((prefix) => `Bash(${prefix}:*)`);
}

/**
 * Resolve the policy for one driver: applied through the driver's declared
 * mechanism, or a DISCLOSED `none` when the driver cannot narrow tools (the
 * envelope sweep is then the only enforcement — stated, never silent).
 */
export function resolveOrderToolPolicy(driver: AgentDriver): {
  readonly disclosure: ToolPolicyDisclosure;
  /** What to pass as `AgentRunOptions.tools` (undefined when unsupported). */
  readonly tools?: { readonly disallowed: readonly string[] };
} {
  const disallowed = orderRunDisallowedTools();
  if (driver.toolPolicy?.mechanism === 'disallowed-tools') {
    return {
      disclosure: {
        mechanism: 'disallowed-tools',
        disallowed,
        cliRequirement: driver.toolPolicy.cliRequirement,
      },
      tools: { disallowed },
    };
  }
  return {
    disclosure: {
      mechanism: 'none',
      reason:
        `driver ${driver.id} declares no tool-narrowing mechanism — the install ban is ` +
        'prompt-advisory only, and the envelope sweep is the enforcement',
    },
  };
}
