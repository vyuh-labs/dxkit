/**
 * Where a repo's BUILD can run (CLAUDE.md Rule 20) — the one answer the
 * generated devcontainer, the generated agent file and `tools install` read.
 *
 * The gates already know that some stacks cannot build on Linux: a capability
 * whose declared hosts exclude the primary runner is placed on a host job
 * (`resolvePlacement`), and a local runner discloses `skipped-environment`
 * (`unmetRequirement`). The devcontainer and AGENTS.md used to ignore that
 * fact and either shipped a mismatched Linux toolchain or said nothing. This
 * module projects the same requirement onto a different question: can a
 * machine of host H be PROVISIONED to run this build at all? A toolchain with
 * an install entry for H counts as available (it can be installed there); a
 * toolchain with none (Xcode off macOS, MSBuild for .NET Framework off
 * Windows, the Unity Editor anywhere) does not, and the wrong host stays the
 * wrong host. The comparison itself is the ONE predicate, `unmetRequirement`.
 *
 * Pure: the requirement is repo-intrinsic and the host is an argument — no
 * PATH probe, no `process.platform`.
 */

import {
  unmetRequirement,
  type ExecutionHost,
  type ExecutionRequirement,
  type UnmetRequirement,
} from './requirement';
import { TOOLCHAIN_DEFS, toolchainInstallableOn, type ToolchainDef } from './toolchains';
import type { CapabilityRequirement } from './placement';

/** The host dxkit's generated devcontainer runs (an Ubuntu image). */
export const DEVCONTAINER_HOST: ExecutionHost = 'linux';

/**
 * Why a build with this requirement cannot run on any machine of `host`, even
 * after installing what can be installed there — or null when it can. Every
 * toolchain installable on `host` is treated as present, so only the wrong
 * host or a toolchain that `host` cannot get remains.
 */
export function buildCannotRunOn(
  req: ExecutionRequirement,
  host: ExecutionHost,
): UnmetRequirement | null {
  return unmetRequirement(req, {
    host,
    hasToolchain: (id) => toolchainInstallableOn(id, host),
  });
}

const HOST_LABELS: Readonly<Record<ExecutionHost, string>> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
};

/**
 * The kind of machine a requirement needs, in one plain phrase: "Windows with
 * .NET SDK", "macOS with Xcode", "a machine with Unity Editor". Derived from
 * the requirement's hosts and the registry's toolchain display names, so the
 * wording cannot drift from what the gates check.
 */
export function describeBuildMachine(req: ExecutionRequirement): string {
  const hosts = req.hosts.filter((h): h is ExecutionHost => h !== 'any');
  const where = hosts.length === 0 ? 'a machine' : hosts.map((h) => HOST_LABELS[h]).join(' or ');
  const names = req.toolchains.map((id) => (TOOLCHAIN_DEFS[id] as ToolchainDef).displayName);
  if (names.length === 0) return where;
  const joined =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${where} with ${joined}`;
}

/** One pack whose build the given host cannot run. */
export interface BuildElsewhere {
  readonly pack: string;
  /** The pack's build requirement (its correctness floor's declaration). */
  readonly requirement: ExecutionRequirement;
  readonly unmet: UnmetRequirement;
  /** `describeBuildMachine(requirement)`. */
  readonly machine: string;
}

/**
 * The packs whose build cannot run on `host`. "The build" is the correctness
 * floor (the build plus the affected tests), the capability every pack
 * declares; the build-shaped lint gate and CodeQL share its requirement in
 * the packs that have them. Input is `collectExecutionRequirements`, the same
 * collection placement consumes. Deterministic input order, one entry per
 * pack.
 */
export function buildsElsewhere(
  capabilities: readonly CapabilityRequirement[],
  host: ExecutionHost = DEVCONTAINER_HOST,
): BuildElsewhere[] {
  const out: BuildElsewhere[] = [];
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (cap.capability !== 'correctness' || seen.has(cap.pack)) continue;
    const unmet = buildCannotRunOn(cap.requirement, host);
    if (unmet === null) continue;
    seen.add(cap.pack);
    out.push({
      pack: cap.pack,
      requirement: cap.requirement,
      unmet,
      machine: describeBuildMachine(cap.requirement),
    });
  }
  return out;
}
