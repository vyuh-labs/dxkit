/**
 * The agent-driver registry (Rule 6/15 discipline applied to the remediate
 * lane): the ONE place drivers are enumerated. Every consumer — the runner,
 * `remediate plan`, the policy schema's driver documentation, the managed
 * workflow's secret wiring, the unknown-driver refusal — derives from this
 * list, so adding a driver is one entry here and nothing else.
 */
import type { AgentDriver } from './driver';
import { makeClaudeCodeDriver } from './claude-code-driver';

export const AGENT_DRIVERS: readonly AgentDriver[] = [makeClaudeCodeDriver()];

export function driverById(id: string): AgentDriver | undefined {
  return AGENT_DRIVERS.find((d) => d.id === id);
}

export function knownDriverIds(): readonly string[] {
  return AGENT_DRIVERS.map((d) => d.id);
}
