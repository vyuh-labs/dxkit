/**
 * The AVAILABILITY side of the execution-environment model: what THIS machine
 * is (host OS) and has (toolchains). The requirement side is repo-intrinsic
 * and lives in `requirement.ts`; `unmetRequirement` compares the two.
 *
 * This module is the ONE place host detection lives (arch-check enforced —
 * new `process.platform` reads outside the pre-existing allowlist fail CI).
 * Point checks scattered per consumer are exactly how the implicit
 * "the driver's machine can run everything" assumption survived unexamined.
 */

import {
  toolchainHealthProblem,
  toolchainPresent,
  type ProbeExec,
  type ToolchainId,
  type ToolchainProblem,
} from './toolchains';
import type { ExecutionEnvironment, ExecutionHost } from './requirement';

/** Map a Node platform id to an execution host. Non-win/mac POSIX platforms
 *  (the BSDs, AIX) are treated as linux — the POSIX approximation is right
 *  for every placement decision dxkit makes (toolchain availability, CI
 *  runner selection), and GitHub-hosted runners offer exactly these three. */
export function hostOf(platform: NodeJS.Platform = process.platform): ExecutionHost {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * The local environment, with toolchain presence AND health probes memoized
 * for the lifetime of the returned object. Callers hold one instance per run
 * (a runner probes the same toolchain for several packs); nothing is cached
 * module-globally, so a toolchain installed between runs is seen by the next
 * run — the walk-cache staleness class stays closed.
 *
 * `probeExec` is injected for tests; health probes are cheap (`--list-sdks`
 * class) and run at most once per toolchain per environment instance.
 */
export function currentEnvironment(probeExec?: ProbeExec): ExecutionEnvironment {
  const probed = new Map<ToolchainId, boolean>();
  const health = new Map<ToolchainId, ToolchainProblem | null>();
  return {
    host: hostOf(),
    hasToolchain(id: ToolchainId): boolean {
      const hit = probed.get(id);
      if (hit !== undefined) return hit;
      const present = toolchainPresent(id);
      probed.set(id, present);
      return present;
    },
    toolchainProblem(id: ToolchainId): ToolchainProblem | null {
      const hit = health.get(id);
      if (hit !== undefined) return hit;
      const problem = toolchainHealthProblem(id, probeExec);
      health.set(id, problem);
      return problem;
    },
  };
}
